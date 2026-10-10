/**
 * DiscordMcplServer — main MCPL server orchestrator.
 *
 * Handles the JSON-RPC main loop: initialize handshake, method dispatch,
 * and forwarding Discord events to the connected host.
 *
 * Follows the pattern from zero-k/game-manager/src/mcpl_server.rs.
 */

import {
  McplConnection,
  textContent,
  method,
} from '@animalabs/mcpl-core';
import { formatAgentDateTime, resolveAgentTimeZone, resolveTimestampStyle } from './utils/timezone.js';

import type {
  JsonRpcRequest,
  JsonRpcNotification,
  McplCapabilities,
  McplInitializeParams,
  McplInitializeResult,
  InitializeCapabilities,
  FeatureSetsUpdateParams,
  PushEventParams,
  ChannelsRegisterParams,
  ChannelsOpenParams,
  ChannelsOpenResult,
  ChannelsCloseParams,
  ChannelsCloseResult,
  ChannelsPublishParams,
  ChannelsPublishResult,
  ChannelsIncomingParams,
  ChannelsListResult,
  StateRollbackParams,
  StateRollbackResult,
  ChannelDescriptor,
  ContentBlock,
  ChannelsOutgoingChunkParams,
  ChannelsOutgoingCompleteParams,
} from '@animalabs/mcpl-core';

import type { DiscordAdapter, DiscordMessageData, DiscordAttachment, OutgoingFile, ReactionSummary } from './discord-adapter.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { toolDefinitions } from './tools.js';
import { featureSets, isEnabled, featureSetForTool } from './feature-sets.js';
import { ChannelManager, mcplChannelId, parseMcplChannelId, toDescriptor, toDmDescriptor } from './channels.js';
import {
  channelLabel,
  looksLikeExplicitName,
  type AddressingPath,
} from './channel-names.js';
import { isSnowflake } from "./utils/discord-strings.js";
import { saveFiltersFile, loadFiltersFile, DiscordFiltersState, type DiscordFilters } from './filters.js';
import { StateTracker } from './state.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbg } from './debug-log.js';
import { parseMessageRef } from './utils/discord-strings.js';
import { DEFAULT_ATTACHMENT_INLINE_MAX_BYTES, IMAGE_FETCH_CEILING, MAX_TEXT_BYTES, normalizeImageForInference } from './utils/attachments.js';

type ChannelOpenRequest = ChannelsOpenParams & {
  channelId?: string;
  history?: { limit: number; beforeMessageId?: string; sinceLastSeen?: boolean };
};

type ChannelOpenResponse = ChannelsOpenResult & {
  history?: ChannelsIncomingParams['messages'];
  historyTruncated?: boolean;
};

interface ChannelAcknowledgeRequest {
  channelId: string;
  messageId: string;
  intent: string;
  value?: string;
}

/** A Discord message must carry text and/or attachments — reject empty sends. */
function requireContentOrFiles(content: string, files: OutgoingFile[] | undefined): void {
  if ((!content || !content.trim()) && (!files || files.length === 0)) {
    throw new Error('Provide "content", "files", or both — a message cannot be empty.');
  }
}

/** chx-compat ignore prefix. ChapterX-style Discord bots send `m continue`
 *  as a no-op trigger to wake their model and immediately delete the message
 *  afterward, but messageCreate fires before the delete propagates, so the
 *  message would otherwise leak into Lena's chronicle as ambient noise.
 *  Match by prefix (`startsWith`) so trailing whitespace or auto-appended
 *  text doesn't slip through. Case-sensitive: a literal `m continue` only. */
const CHX_NOOP_PREFIX = 'm continue';
const AGENT_TIME_ZONE = resolveAgentTimeZone();
const AGENT_TIMESTAMP_STYLE = resolveTimestampStyle();

export class DiscordMcplServer {
  private conn: McplConnection | null = null;
  // Note: the location-header transition tracker and the sticky-reply
  // channel are the same thing — both want to know "where did
  // communication last happen, in either direction." Tracked in
  // `lastChannelId` below.

  /** Actual runtime subscriptions. Desired state is host-owned and durable in
   *  Chronicle. `DISCORD_SUBSCRIPTIONS_FILE` is read only as a one-time legacy
   *  bootstrap hint; channels/open and channels/close reconcile this set. */
  private subscribedChannels = new Set<string>();
  private subscriptionsLoaded = false;

  /** Channels opted into live reaction visibility (per-channel, default off).
   *  Reactions from these channels surface in context but NEVER wake the agent
   *  (tagged `chat:reaction`, which matches no wake policy). Persisted to
   *  DISCORD_REACTION_CHANNELS_FILE, or a `.reactions.json` sibling of the
   *  subscriptions file. */
  private reactionChannels = new Set<string>();
  private reactionChannelsLoaded = false;

  /** Resolved when the host's first featureSets/update (either form) has
   *  been processed — the signal that §5.3 policy is settled and pushes
   *  will land inside the granted window. Gates the reconnect sweep. */
  private policyAnswered: Promise<void>;
  private resolvePolicyAnswered!: () => void;

  /** The Discord filters plane's desired/effective/status state, shared by
   *  the whitelists and reaction suppression (issue #21) — which reactions
   *  may be shown to the model at all, across every surface. The entry
   *  point drives this instance through the startup/poller lifecycle;
   *  filtersUpdate() re-applies after its own saves. Public: index.ts
   *  feeds it. The deprecated DISCORD_SUPPRESS_REACTION_EMOJIS emergency
   *  env is the process-static compat source while a filters file lacks
   *  the key (snapshotted at construction; env changes need a restart). */
  readonly filtersState = new DiscordFiltersState();

  /** Channels the agent has explicitly MUTED: no ambient, no mention/reply wake,
   *  and no auto-subscribe-on-mention. Dropped at the top of
   *  handleDiscordMessage. Persisted to a sibling of DISCORD_SUBSCRIPTIONS_FILE
   *  (…​.muted.json), or DISCORD_MUTED_CHANNELS_FILE if set. */
  private mutedChannels = new Set<string>();
  private mutedLoaded = false;

  /** Per-channel watermark of the highest Discord message id forwarded to
   *  the host. Used by the auto-subscribe-on-mention flow to fetch only
   *  the backscroll Lena hasn't already seen, and by the reconnect catch-up
   *  sweep to find what arrived while the bot was offline.
   *
   *  Persisted to `DISCORD_WATERMARK_FILE` when set (alongside the set of DM
   *  channel IDs, so DMs can be swept too). When unset, it's in-memory only —
   *  resets on restart, and the catch-up sweep is effectively disabled
   *  (there's no "since when" anchor to scan from). */
  private forwardedWatermark = new Map<string, string>();
  /** DM channel IDs we've forwarded from. Tracked (and persisted with the
   *  watermark) because discord.js can't enumerate past DM channels, so the
   *  reconnect sweep needs a remembered list of which DMs to re-scan. */
  private dmChannelIds = new Set<string>();
  /** Per-channel tally of ambient messages MISSED since the channel was last
   *  unsubscribed — answers the agent's "how much have I missed in #x since I
   *  dropped it?" via the `channel_missed` tool. Only channels with an entry
   *  here (created on unsubscribe, cleared on resubscribe) are tracked.
   *
   *  `anchorId` = the watermark at unsubscribe (the "since when" line).
   *  `talliedThrough` = message id up to which the counts are accurate (the
   *  cursor); advances on each online ambient drop and on reconnect backfill,
   *  so the tally stays exact across downtime with no double-counting.
   *  Persisted with the watermark file. */
  private missedTally = new Map<
    string,
    { anchorId: string; talliedThrough: string; messages: number; characters: number }
  >();
  private watermarkLoaded = false;
  /** Set once the reconnect catch-up sweep has run for the current process,
   *  so it doesn't re-run if a host reconnects mid-session. */
  private sweepDone = false;

  /** Max messages to scan per channel during the reconnect catch-up sweep.
   *  Tunable via DISCORD_CATCHUP_LIMIT; clamped to [1, 10000], default 3000.
   *  discord.js paginates the REST 100/call limit transparently. A long
   *  offline gap in an active channel needs thousands scanned to surface all
   *  missed mentions — 300 was far too low (a busy 2-week gap can be >1900). */
  private get catchupLimit(): number {
    const raw = process.env.DISCORD_CATCHUP_LIMIT;
    if (!raw) return 3000;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 && n <= 10000 ? n : 3000;
  }

  /** How many backscroll messages to fetch on first interaction / via the
   *  history tools. Tunable via DISCORD_BACKSCROLL_LIMIT; clamped to
   *  [1, 10000], default 80 (Discord's REST limit per fetch is 100, but
   *  discord.js paginates above that — see messages.fetch). Raise it to let
   *  the agent browse deep back to old mentions. */
  private get backscrollLimit(): number {
    const raw = process.env.DISCORD_BACKSCROLL_LIMIT;
    if (!raw) return 80;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 && n <= 10000 ? n : 80;
  }

  /** Inline cap for text attachments on live delivery, in bytes. A text
   *  attachment over this size is not inlined into context — the agent gets
   *  a name+size+URL note instead of a surprise multi-KB paste (issue #30).
   *  The bound is enforced on ACTUAL bytes, not just Discord's declared
   *  attachment.size (metadata can be absent or wrong — see
   *  buildAttachmentBlocks). Tunable via DISCORD_ATTACHMENT_INLINE_MAX_BYTES:
   *  0 explicitly disables text auto-inlining; any value clamps to the
   *  MAX_TEXT_BYTES (256KiB) absolute ceiling; malformed or negative values
   *  are rejected loudly and fall back to the default. Images are governed
   *  by their own path (native image blocks), not this cap. Read per call so
   *  env edits + restart apply. Default 5KiB. */
  private inlineCapWarnedFor?: string;
  private get attachmentInlineMaxBytes(): number {
    const raw = process.env.DISCORD_ATTACHMENT_INLINE_MAX_BYTES;
    if (!raw) return DEFAULT_ATTACHMENT_INLINE_MAX_BYTES;
    // Number(), not parseInt(): "5kb" should be a loud misconfiguration,
    // not a silent 5-byte cap.
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      if (this.inlineCapWarnedFor !== raw) {
        this.inlineCapWarnedFor = raw;
        console.error(
          `[discord-mcpl] DISCORD_ATTACHMENT_INLINE_MAX_BYTES=${JSON.stringify(raw)} is not a non-negative integer — using default ${DEFAULT_ATTACHMENT_INLINE_MAX_BYTES}`,
        );
      }
      return DEFAULT_ATTACHMENT_INLINE_MAX_BYTES;
    }
    return Math.min(n, MAX_TEXT_BYTES);
  }

  /** Per-channel backscroll limits: DISCORD_BACKSCROLL_CHANNELS=
   *  "<channelId>:<n>,<channelId>:<n>". For a listed channel the value
   *  overrides DISCORD_BACKSCROLL_LIMIT for first-interaction backscroll AND
   *  hard-caps agent-requested history (fetch_history / fetch_around) in that
   *  channel. Use for channels whose history the agent should only ever see a
   *  sliver of (e.g. sensitive or classifier-tripping backlogs). Unlisted
   *  channels behave as before. Parsed per call so env edits + restart apply;
   *  malformed entries are ignored. */
  private get backscrollChannelLimits(): Map<string, number> {
    const out = new Map<string, number>();
    const raw = process.env.DISCORD_BACKSCROLL_CHANNELS;
    if (!raw) return out;
    for (const part of raw.split(',')) {
      const [id, nStr] = part.trim().split(':');
      const n = parseInt(nStr ?? '', 10);
      if (id && Number.isFinite(n) && n >= 0 && n <= 10000) out.set(id, n);
    }
    return out;
  }

  /** Effective first-interaction backscroll for a channel: per-channel
   *  override when configured, else the global backscrollLimit. */
  private backscrollLimitFor(channelId: string): number {
    return this.backscrollChannelLimits.get(channelId) ?? this.backscrollLimit;
  }

  /** Cap an agent-requested history limit by the channel's configured
   *  per-channel backscroll limit. Channels without a per-channel entry are
   *  NOT capped (agent may browse freely, as before). */
  private capHistoryLimit(channelId: string, requested: number): number {
    const cap = this.backscrollChannelLimits.get(channelId);
    return cap === undefined ? requested : Math.min(requested, cap);
  }

  // ── Sticky-channel auto-reply ──
  //
  // When the agent emits a text-only response (no send_* tool call), there's
  // nowhere for that text to go — it sits in chronicle as private narration
  // and the Discord user sees silence. To fix that, we hook MCPL's
  // `context/afterInference`: if the turn had no outgoing send, we treat the
  // assistant's text as a reply to whoever the agent last interacted with
  // and post it to that channel automatically. Direction-agnostic stickiness:
  // updated on every inbound message AND every outbound tool send.
  /** Most recently active Discord channel (in either direction). */
  private lastChannelId: string | null = null;
  /** The inbound messageId we should `replyTo` on the next auto-send.
   *  Set on inbound, cleared after first auto-send so subsequent text
   *  posts as top-level rather than chaining replies to the same message. */
  private lastInboundMessageId: string | null = null;
  /** True if the agent invoked any send_* tool during the current turn.
   *  Reset to false at the end of each `context/afterInference` call. */
  private sentInCurrentTurn = false;

  /** Whether the sticky-reply feature is enabled. Defaults on; set
   *  DISCORD_STICKY_REPLY=0 to disable (e.g. while debugging behavior). */
  private get stickyReplyEnabled(): boolean {
    const raw = process.env.DISCORD_STICKY_REPLY;
    if (raw === undefined) return true;
    return raw !== '0' && raw.toLowerCase() !== 'false';
  }
  private mcplEnabled = false;
  private enabledFeatureSets = new Set<string>();
  private channelManager = new ChannelManager();
  private stateTracker = new StateTracker();
  /** Buffers for channels/outgoing/chunk streams, keyed by inferenceId */

  constructor(
    private discord: DiscordAdapter,
    /** Voice output (Spec 14.3 consumer). Null = voice not configured; the
     *  handshake then declares no channels.streaming and the host streams
     *  nothing here. */
    private voice: import('./voice.js').VoiceOutput | null = null,
  ) {
    this.policyAnswered = new Promise((resolve) => {
      this.resolvePolicyAnswered = resolve;
    });
    // Physics accounting → the model. An utterance that was cut off (human
    // barge-in, bot collision yield) or truncated (TTS died mid-stream) left
    // the model believing it said things the room never heard. Push the
    // voiced/unvoiced split so its beliefs match the channel's reality.
    // Fully-voiced utterances are silence — no news is good news.
    this.voice?.onReport((r) => this.handleVoiceReport(r));
  }

  get isHostConnected() {
    return !!this.conn;
  }

  private handleVoiceReport(r: import('./voice.js').UtteranceReport): void {
    if (!this.conn || !this.mcplEnabled) return;
    if (r.status === 'spoken' && r.unvoicedText.length === 0) return;
    const interrupted = r.status === 'interrupted';
    const expired = r.status === 'expired';
    const secs = (r.playedMs / 1000).toFixed(1);
    const who = r.interruptedBy
      ? `@${r.interruptedBy.username ?? r.interruptedBy.userId}${r.interruptedBy.bot ? ' (bot)' : ''}`
      : null;
    // The model has its full text; what it needs is the BOUNDARY. Short
    // voiced tail for orientation, capped unvoiced head for the loss.
    const tail = r.voicedText.length > 120 ? `…${r.voicedText.slice(-120)}` : r.voicedText;
    const head = r.unvoicedText.length > 400 ? `${r.unvoicedText.slice(0, 400)}…` : r.unvoicedText;
    const approx = r.estimated ? ' (boundary approximate)' : '';
    const line = expired
      ? `[voice] Your spoken message waited ${(r.queuedMs / 1000).toFixed(0)}s for the channel to clear and was dropped UNSPOKEN — nothing was heard (and nothing was billed).\n` +
        `Not said: "${head}"\n(The text was still delivered in the text channel as usual. Say it again — possibly shorter — only if it still needs saying.)`
      : interrupted
        ? `[voice] Your spoken message was interrupted by ${who} after ${secs}s${approx}.\n` +
          `Heard up to: "${tail}"\nNOT heard: "${head}"`
        : `[voice] Your spoken message was cut short by a synthesis error after ${secs}s${approx}.\n` +
          `Heard up to: "${tail}"\nNOT heard: "${head}"\n(The text was still delivered in the text channel as usual.)`;
    this.conn.sendRequest(method.PUSH_EVENT, {
      featureSet: 'discord.messaging',
      eventId: `discord_voice_${r.status}_${r.inferenceId}`,
      timestamp: new Date().toISOString(),
      origin: {
        source: 'discord',
        mcplChannelId: r.channelId,
        inferenceId: r.inferenceId,
        playedMs: r.playedMs,
        queuedMs: r.queuedMs,
        billedChars: r.billedChars,
        estimated: r.estimated,
        ...(r.interruptedBy ? {
          interruptedById: r.interruptedBy.userId,
          interruptedByName: r.interruptedBy.username,
          interruptedByBot: r.interruptedBy.bot,
        } : {}),
      } as Record<string, unknown>,
      // RFC-001 tags: hosts route/gate on these. The wake rule is
      // ball-in-your-court: 'voice:interrupted' and 'voice:expired' both
      // leave the model with a decision only it can make (someone grabbed
      // the floor mid-sentence / your words were never said — re-decide),
      // so hosts should gate them WAKING, like a reply. 'voice:truncated'
      // is context: the text landed in the text channel, nothing to decide.
      // Third-party speech while recently-engaged (the engagement-window
      // rule) is the floor/gate layer's job, not this transport's.
      tags: [expired ? 'voice:expired' : interrupted ? 'voice:interrupted' : 'voice:truncated'],
      payload: { content: [textContent(line)] },
    } satisfies PushEventParams).catch(() => {});
  }

  /**
   * Register slash commands with Discord and wire the interaction handler.
   * Call once after the Discord client is ready (before or after serve()).
   *
   * `/undo [turns]` — admin-gated (DISCORD_ADMIN_USERS): asks the host to
   * revert the agent's last N turns via the `host/command` MCPL method, then
   * posts what the agent now sees as its latest context message.
   *
   * `/nudge` — admin-gated: asks the host to run inference on the agent's
   * current context with no new events (ephemeral reply — see
   * handleNudgeCommand).
   */
  async setupSlashCommands(): Promise<void> {
    this.discord.onSlashCommand((interaction) => {
      void this.handleSlashCommand(interaction);
    });
    await this.discord.registerGuildCommands([
      {
        name: 'undo',
        description: "Undo the agent's last turn(s) — admin only",
        options: [
          {
            type: 4, // INTEGER
            name: 'messages',
            description: 'Number of context messages to remove (any participant; default 1)',
            required: false,
            min_value: 1,
            max_value: 50,
          },
        ],
      },
      {
        name: 'hide',
        description: 'Remove a message (or range) from the agent context by link — admin only',
        options: [
          {
            type: 3, // STRING
            name: 'message',
            description: 'Message link (or ID) to remove',
            required: true,
          },
          {
            type: 3, // STRING
            name: 'to',
            description: 'End of range: a second message link/ID (inclusive)',
            required: false,
          },
        ],
      },
      {
        name: 'nudge',
        description: 'Run the agent on its current context — no new events — admin only',
      },
      {
        name: 'unstick',
        description: 'Rewind blocked turns and re-run until the model stops refusing — admin only',
        options: [
          {
            type: 4, // INTEGER
            name: 'max',
            description: 'Max rewind/retry attempts (default 3)',
            required: false,
            min_value: 1,
            max_value: 10,
          },
        ],
      },
    ]);
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (
      interaction.commandName !== 'undo' &&
      interaction.commandName !== 'hide' &&
      interaction.commandName !== 'unstick' &&
      interaction.commandName !== 'nudge'
    ) {
      await interaction.reply({ content: `Unknown command: ${interaction.commandName}`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (!this.discord.adminUsers.has(interaction.user.id)) {
      dbg('slash:unauthorized', { command: interaction.commandName, userId: interaction.user.id });
      await interaction.reply({ content: `Not authorized to use /${interaction.commandName}.`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === 'hide') {
      await this.handleHideCommand(interaction);
      return;
    }

    if (interaction.commandName === 'unstick') {
      await this.handleUnstickCommand(interaction);
      return;
    }

    if (interaction.commandName === 'nudge') {
      await this.handleNudgeCommand(interaction);
      return;
    }

    const messages = interaction.options.getInteger('messages') ?? 1;
    const conn = this.conn;
    if (!conn) {
      await interaction.reply({ content: 'Host is not connected — cannot undo.', flags: MessageFlags.Ephemeral });
      return;
    }

    dbg('slash:undo', { messages, userId: interaction.user.id, channelId: interaction.channelId });
    // Public reply: the channel should see that history was rewound.
    await interaction.deferReply();

    try {
      const result = (await conn.sendRequest(
        'host/command',
        {
          command: 'undo',
          messages,
          requesterId: interaction.user.id,
          requesterName: interaction.user.username,
        },
        30000,
      )) as {
        ok?: boolean;
        error?: string;
        messagesRemoved?: number;
        lastVisible?: { participant?: string; role?: string; preview?: string } | null;
      };

      if (!result?.ok) {
        await interaction.editReply(`⚠️ Undo failed: ${result?.error ?? 'unknown error'}`);
        return;
      }

      const lines: string[] = [];
      const removed = result.messagesRemoved ?? 0;
      lines.push(
        `🗑️ Removed the last **${removed}** context message${removed === 1 ? '' : 's'} (branched; old branch preserved).`,
      );
      const lv = result.lastVisible;
      if (lv?.preview) {
        const who = lv.participant ?? lv.role ?? '?';
        lines.push(`Last message now visible to the agent — **${who}**:`);
        lines.push(`> ${lv.preview.replace(/\n/g, '\n> ')}`);
      } else if (lv) {
        const who = lv.participant ?? lv.role ?? '?';
        lines.push(`Last message now visible to the agent — **${who}**: *(empty message)*`);
      } else {
        lines.push('(Could not render the post-undo context preview.)');
      }
      await interaction.editReply(lines.join('\n'));
    } catch (err) {
      dbg('slash:undo-failed', { error: (err as Error).message });
      await interaction.editReply(`⚠️ Undo failed: ${(err as Error).message}`);
    }
  }

  private async handleHideCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const fromRaw = interaction.options.getString('message', true);
    const toRaw = interaction.options.getString('to');
    const fromMessageId = parseMessageRef(fromRaw);
    if (!fromMessageId) {
      await interaction.reply({
        content: `Could not parse a message link/ID from \`${fromRaw}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    let toMessageId: string | undefined;
    if (toRaw) {
      const parsed = parseMessageRef(toRaw);
      if (!parsed) {
        await interaction.reply({ content: `Could not parse \`${toRaw}\`.`, flags: MessageFlags.Ephemeral });
        return;
      }
      toMessageId = parsed;
    }

    const conn = this.conn;
    if (!conn) {
      await interaction.reply({ content: 'Host is not connected — cannot hide.', flags: MessageFlags.Ephemeral });
      return;
    }

    dbg('slash:hide', { fromMessageId, toMessageId, userId: interaction.user.id });
    await interaction.deferReply();

    try {
      const result = (await conn.sendRequest(
        'host/command',
        {
          command: 'hide',
          fromMessageId,
          toMessageId,
          requesterId: interaction.user.id,
          requesterName: interaction.user.username,
        },
        30000,
      )) as {
        ok?: boolean;
        error?: string;
        hidden?: number;
        hiddenRefs?: Array<{ channelId: string; messageId: string }>;
        lastVisible?: { participant?: string; role?: string; preview?: string } | null;
      };

      if (!result?.ok) {
        await interaction.editReply(`⚠️ Hide failed: ${result?.error ?? 'unknown error'}`);
        return;
      }

      // Mark each hidden Discord message with 💤 so the channel shows what's
      // no longer in the agent's context. Best-effort, in parallel.
      let reacted = 0;
      const refs = result.hiddenRefs ?? [];
      await Promise.all(
        refs.map(async (ref) => {
          // channelId may be raw or the "discord:guild:channel" composite.
          const parsed = parseMcplChannelId(ref.channelId);
          const channelId = parsed ? parsed.channelId : ref.channelId;
          try {
            await this.discord.addReaction(channelId, ref.messageId, '💤');
            reacted++;
          } catch (err) {
            dbg('slash:hide-react-failed', { messageId: ref.messageId, error: (err as Error).message });
          }
        }),
      );

      const n = result.hidden ?? 0;
      const lines = [
        `🙈 Removed **${n}** message${n === 1 ? '' : 's'} from the agent's context (redacted in place)` +
          (reacted > 0 ? `, marked ${reacted} with 💤` : '') +
          '.',
      ];
      const lv = result.lastVisible;
      if (lv?.preview) {
        const who = lv.participant ?? lv.role ?? '?';
        lines.push(`Last message now visible to the agent — **${who}**:`);
        lines.push(`> ${lv.preview.replace(/\n/g, '\n> ')}`);
      } else if (lv) {
        const who = lv.participant ?? lv.role ?? '?';
        lines.push(`Last message now visible to the agent — **${who}**: *(empty message)*`);
      }
      await interaction.editReply(lines.join('\n'));
    } catch (err) {
      dbg('slash:hide-failed', { error: (err as Error).message });
      await interaction.editReply(`⚠️ Hide failed: ${(err as Error).message}`);
    }
  }

  /**
   * `/unstick [max]` — admin-gated. Asks the host to force the refusal-rewind
   * loop: redact the turn that fed the refusal and re-run the model, up to
   * `max` times, until it stops refusing. Commits to real inference runs, so
   * the host only ACKs here (started) and posts the outcome — what was shed and
   * whether it cleared — to this channel when the chain resolves.
   */
  private async handleUnstickCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const max = interaction.options.getInteger('max') ?? undefined;
    const conn = this.conn;
    if (!conn) {
      await interaction.reply({ content: 'Host is not connected — cannot unstick.', flags: MessageFlags.Ephemeral });
      return;
    }

    dbg('slash:unstick', { max, userId: interaction.user.id, channelId: interaction.channelId });
    await interaction.deferReply();

    try {
      const result = (await conn.sendRequest(
        'host/command',
        {
          command: 'unstick',
          maxRewinds: max,
          channelId: interaction.channelId,
          requesterId: interaction.user.id,
          requesterName: interaction.user.username,
        },
        30000,
      )) as { ok?: boolean; error?: string; started?: boolean; cap?: number };

      if (!result?.ok) {
        await interaction.editReply(`⚠️ Unstick failed: ${result?.error ?? 'unknown error'}`);
        return;
      }
      await interaction.editReply(
        `🔧 Unsticking the agent — rewinding blocked turn(s) and re-running ` +
          `(up to **${result.cap ?? max ?? 3}**). I'll post the result here.`,
      );
    } catch (err) {
      dbg('slash:unstick-failed', { error: (err as Error).message });
      await interaction.editReply(`⚠️ Unstick failed: ${(err as Error).message}`);
    }
  }

  /**
   * `/nudge` — ask the host to run an inference turn on the agent's CURRENT
   * context with no new events. The reply is EPHEMERAL by design: a visible
   * channel message would itself be a new event, defeating the command's
   * whole point (and the wake would then be "about" the confirmation).
   */
  private async handleNudgeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const conn = this.conn;
    if (!conn) {
      await interaction.reply({ content: 'Host is not connected — cannot nudge.', flags: MessageFlags.Ephemeral });
      return;
    }

    dbg('slash:nudge', { userId: interaction.user.id, channelId: interaction.channelId });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const result = (await conn.sendRequest(
        'host/command',
        {
          command: 'nudge',
          requesterId: interaction.user.id,
          requesterName: interaction.user.username,
        },
        30000,
      )) as { ok?: boolean; error?: string; agentStatus?: string };

      if (!result?.ok) {
        await interaction.editReply(`⚠️ Nudge failed: ${result?.error ?? 'unknown error'}`);
        return;
      }
      const when = result.agentStatus === 'idle'
        ? 'running now'
        : `queued behind the current turn (agent is ${result.agentStatus ?? 'busy'})`;
      await interaction.editReply(
        `👉 Nudged — the agent takes a turn on its current context, no new events (${when}).`,
      );
    } catch (err) {
      dbg('slash:nudge-failed', { error: (err as Error).message });
      await interaction.editReply(`⚠️ Nudge failed: ${(err as Error).message}`);
    }
  }

  /**
   * Serve a single connection. Blocks until the connection closes.
   * The Discord adapter should already be connected before calling this.
   */
  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;

    // Reaction suppression is opt-in; say plainly when it isn't on rather
    // than letting an unset config read as safety. "Configured but empty"
    // gets the same plain-speaking: the mechanism being wired is not the
    // same thing as a reaction being suppressed. A legacy-env source works
    // but is deprecated — one line, counts and digests only, never glyphs.
    const rs = this.filtersState.suppressionStatus();
    if (rs.status === 'not-configured') {
      console.error(
        '[discord-mcpl] reaction-suppression: not configured (no suppressedReactionEmojis in the filters file, ' +
          'no DISCORD_SUPPRESS_REACTION_EMOJIS) — reaction suppression NOT active',
      );
    } else if (rs.status === 'configured-empty') {
      console.error(
        '[discord-mcpl] reaction-suppression: suppressedReactionEmojis is present but EMPTY — mechanism wired, NO reactions suppressed',
      );
    } else if (rs.source === 'legacy-env') {
      console.error(
        `[discord-mcpl] reaction-suppression: running on DEPRECATED DISCORD_SUPPRESS_REACTION_EMOJIS (${rs.effectiveCount} entries, ` +
          'process-static — changing it needs a restart) — move the entries into the filters file suppressedReactionEmojis key ' +
          'and unset the env (alias retires per issue #16)',
      );
    } else if (rs.source === 'baseline-default') {
      console.error(
        `[discord-mcpl] reaction-suppression: host-injected protective baseline in force (${rs.effectiveCount} entries, ` +
          'no operator configuration present) — an explicit suppressedReactionEmojis key in the filters file overrides it',
      );
    } else if (rs.status === 'unavailable') {
      console.error(
        '[discord-mcpl] reaction-suppression: filters file is configured but unreadable and no usable set was ever loaded — ' +
          'ALL model-visible reactions are withheld until the file is repaired',
      );
    }

    // Set up Discord event forwarding
    this.setupDiscordForwarding();

    // Handshake
    await this.handleInitialize();

    // ORDERING (Mythos 0.5-canary find, two rounds): NOTHING may run between
    // initialize and the main loop. A 0.5 host sends its §5.3 initial policy
    // as a featureSets/update REQUEST right after initialize with a 15s
    // timeout; until the loop reads, that request sits unanswered. Round 1:
    // the reconnect sweep blocked the loop → timeout → deny-until-policy.
    // Round 2: registerDiscordChannels still ran pre-loop, and its own
    // server→host Request is itself REJECTED by the host until policy is
    // established (-32002 after ~15s) — a clean cross-request deadlock; the
    // policy answer landed ~600ms after the host gave up. So channel
    // registration AND the sweep both run concurrently with the loop, gated
    // on the policy being answered (20s grace covers pre-0.5 hosts that
    // never send the Request form), registration strictly before the sweep
    // so pushes land on registered channels inside the granted window.
    void (async () => {
      await Promise.race([
        this.policyAnswered,
        // unref: a pending grace timer must never hold the process open
        // (it made the test runner appear to hang for 20s per server).
        new Promise((r) => {
          const t = setTimeout(r, 20_000);
          (t as { unref?: () => void }).unref?.();
        }),
      ]);
      if (this.mcplEnabled) {
        try {
          await this.registerDiscordChannels();
        } catch (err) {
          console.error('[discord-mcpl] Channel registration failed:', (err as Error).message);
        }
      }
      // Deliver anything that arrived while the bot was offline (mentions +
      // DMs everywhere, full missed backscroll for subscribed channels).
      // Best-effort and one-shot; failures must not block serving.
      try {
        await this.runReconnectSweep();
      } catch (err) {
        console.error('[discord-mcpl] Reconnect catch-up sweep failed:', (err as Error).message);
      }
    })();

    // Main loop
    try {
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        if (msg.type === 'request') {
          await this.handleRequest(msg.request);
        } else {
          this.handleNotification(msg.notification);
        }
      }
    } catch (err) {
      if ((err as Error).name === 'ConnectionClosedError') {
        console.log('[discord-mcpl] Client disconnected');
      } else {
        console.error('[discord-mcpl] Connection error:', err);
      }
    }

    this.conn = null;
  }

  // ── Initialize Handshake ──

  private async handleInitialize(): Promise<void> {
    const conn = this.conn!;

    // Wait for initialize request
    const msg = await conn.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') {
      console.error('[discord-mcpl] Expected initialize request, got:', msg);
      conn.close();
      return;
    }

    const params = msg.request.params as McplInitializeParams | undefined;

    // Detect MCPL support
    const clientMcpl = params?.capabilities?.experimental?.mcpl;
    this.mcplEnabled = clientMcpl !== undefined;
    dbg('handleInitialize', {
      mcplEnabled: this.mcplEnabled,
      clientName: params?.clientInfo?.name,
      clientMcpl: clientMcpl ? 'present' : 'absent',
    });

    // Build server capabilities
    const serverCaps: McplCapabilities = {
      version: '0.4',
      pushEvents: true,
      // Object form (MCPL spec McplChannelCapabilities) when voice is enabled:
      // `streaming: true` opts this server into the host's routed outgoing
      // deltas (channels/outgoing/chunk, Spec 14.3) — the input to voice
      // synthesis. Without voice we keep the legacy boolean: the host then
      // streams nothing here, which is exactly right. (mcpl-core's type lags
      // the spec's object form, hence the cast.)
      channels: (this.voice ? { register: true, publish: true, streaming: true } : true) as unknown as boolean,
      rollback: true,
      // Legacy array form on the wire, unchanged (see NamedFeatureSetDeclaration
      // in feature-sets.ts — digest-stable, host-normalized).
      featureSets: featureSets as unknown as McplCapabilities['featureSets'],
      // NOTE: we intentionally no longer declare `contextHooks.afterInference`.
      // Output routing ("where does a plain-text reply go") is a HOST concern,
      // not a per-surface one — only the host sees the merged cross-surface
      // event stream and can pick the true conversational locus. The host
      // (agent-framework) now publishes text-only turns to the locus via
      // channels/publish; this server is a pure publish executor. The old
      // sticky auto-post that lived here would double-post against the host
      // router and races the moment a second surface (e.g. Telegram) exists.
      // See forking-knowledge-miner/docs/LOCUS-ROUTING-DESIGN.md.
    };

    const capabilities: InitializeCapabilities = {
      tools: {},
      ...(this.mcplEnabled && {
        experimental: { mcpl: serverCaps },
      }),
    };

    const result: McplInitializeResult = {
      protocolVersion: '2024-11-05',
      capabilities,
      serverInfo: { name: 'discord-mcpl', version: '0.1.0' },
    };

    conn.sendResponse(msg.request.id, result);

    // Wait for initialized notification
    const initedMsg = await conn.nextMessage();
    if (initedMsg.type === 'notification' && initedMsg.notification.method === 'notifications/initialized') {
      console.log('[discord-mcpl] Client initialized' + (this.mcplEnabled ? ' (MCPL mode)' : ' (MCP mode)'));
    }

    // In MCPL mode, default all feature sets to enabled
    if (this.mcplEnabled) {
      for (const fs of featureSets) {
        this.enabledFeatureSets.add(fs.name);
      }
    }
  }

  // ── Request Dispatch ──

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    const conn = this.conn!;
    const params = (req.params ?? {}) as Record<string, unknown>;

    try {
      switch (req.method) {
        case 'tools/list': {
          conn.sendResponse(req.id, { tools: toolDefinitions });
          break;
        }

        case 'tools/call': {
          const result = await this.handleToolCall(
            params.name as string,
            (params.arguments ?? {}) as Record<string, unknown>,
          );
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_LIST: {
          const result: ChannelsListResult = {
            channels: this.channelManager.getAll(),
          };
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_OPEN: {
          const openP = params as unknown as ChannelOpenRequest;
          const result = await this.handleChannelOpen(openP);
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_CLOSE: {
          const closeP = params as unknown as ChannelsCloseParams;
          const result = this.handleChannelClose(closeP);
          conn.sendResponse(req.id, result);
          break;
        }

        case 'channels/acknowledge': {
          const ack = params as unknown as ChannelAcknowledgeRequest;
          const result = await this.handleChannelAcknowledge(ack);
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_PUBLISH: {
          const pubP = params as unknown as ChannelsPublishParams;
          const result = await this.handlePublish(pubP);
          conn.sendResponse(req.id, result);
          break;
        }

        case method.STATE_ROLLBACK: {
          const rollbackP = params as unknown as StateRollbackParams;
          const result = await this.handleRollback(rollbackP);
          conn.sendResponse(req.id, result);
          break;
        }

        case method.FEATURE_SETS_UPDATE: {
          // §5.3/§6.7 Request form — the host's policy update, awaiting a
          // degradation receipt. Pre-0.5 this method was notification-only
          // here; a 0.5 host's initial policy Request then timed out and the
          // whole MCPL surface stayed deny-until-policy (Mythos canary).
          // Everything this server declares runs on plain tool/channel
          // machinery, so there is nothing to degrade: accept plainly.
          this.applyFeatureSetsUpdate(params as unknown as FeatureSetsUpdateParams);
          conn.sendResponse(req.id, { accepted: true });
          break;
        }

        case 'context/afterInference': {
          // RETIRED no-op (see handleAfterInference). The capability is not
          // advertised; this case survives only so a stray call from an older
          // host is answered instead of erroring. It does NOT post anything —
          // an earlier comment here described the retired sticky-reply as if
          // live, and misled a reviewer into believing the capability was
          // still advertised. Issue #14.
          // Literal wire string: mcpl-core 0.5 removed method.CONTEXT_AFTER_
          // INFERENCE from the method map (the 0.2.1 constant equaled this
          // string); a back-compat shim for old hosts is exactly where the
          // removed name must not be load-bearing.
          await this.handleAfterInference(params);
          conn.sendResponse(req.id, { featureSet: 'discord.messaging' });
          break;
        }

        default:
          conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      // Capture the full error before reporting it. The previous version
      // dropped stack + tool/input context, which made transient failures
      // (Discord 5xx, rate-limit, missing permissions, etc.) untraceable
      // from the host side — we'd see "internal system error" without any
      // hint of which call failed.
      const e = err as Error;
      const isToolsCall = req.method === 'tools/call';
      const toolName = isToolsCall
        ? ((req.params as Record<string, unknown>)?.name as string | undefined)
        : undefined;
      const toolArgs = isToolsCall
        ? ((req.params as Record<string, unknown>)?.arguments as Record<string, unknown> | undefined)
        : undefined;
      // Mirror to stderr so it shows up in any host-side stderr capture.
      console.error(
        `[discord-mcpl] handleRequest error: method=${req.method}`,
        toolName ? `tool=${toolName}` : '',
        e.stack ?? e.message,
      );
      dbg('handleRequest:error', {
        method: req.method,
        tool: toolName,
        // Truncate any long arg values so we don't dump full message bodies
        args: toolArgs
          ? Object.fromEntries(
              Object.entries(toolArgs).map(([k, v]) => [
                k,
                typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v,
              ]),
            )
          : undefined,
        error: e.message,
        errorName: e.name,
        // Stack is the most useful bit for diagnosing transient bugs.
        stack: e.stack?.split('\n').slice(0, 8).join('\n'),
      });
      conn.sendError(req.id, -32603, e.message);
    }
  }

  /** Shared body of featureSets/update, both forms (§6.7). Also resolves
   *  the policy gate that releases the reconnect sweep (see serve()). */
  private applyFeatureSetsUpdate(p: FeatureSetsUpdateParams): void {
    if (p.enabled) {
      for (const name of p.enabled) this.enabledFeatureSets.add(name);
    }
    if (p.disabled) {
      for (const name of p.disabled) this.enabledFeatureSets.delete(name);
    }
    this.resolvePolicyAnswered();
  }

  // ── Notification Dispatch ──

  private handleNotification(notif: JsonRpcNotification): void {
    switch (notif.method) {
      case method.FEATURE_SETS_UPDATE: {
        // §6.7 Notification form: descriptive metadata only. Grant-bearing
        // updates (including the §5.3 initial policy) arrive as a Request —
        // see the handleRequest case.
        this.applyFeatureSetsUpdate(notif.params as FeatureSetsUpdateParams);
        break;
      }

      // Spec 14.3: outgoing streaming is ADVISORY — the authoritative delivery
      // is channels/publish. The previous handler here posted complete's text
      // to Discord; that was a never-exercised alternative delivery path
      // (no host emitted these until agent-framework wired Spec 14.3,
      // 2026-07-26) and would double-post against the host's publish the
      // moment streaming turned on. Now: chunks feed voice synthesis, and
      // complete finalizes the utterance. Nothing here ever sends text.
      case method.CHANNELS_OUTGOING_CHUNK: {
        const p = notif.params as ChannelsOutgoingChunkParams;
        this.voice?.handleChunk(p.inferenceId, p.channelId, p.delta);
        break;
      }

      case method.CHANNELS_OUTGOING_COMPLETE: {
        // SPEC §14.5: delivery is NEVER a side effect of a lifecycle event —
        // delivery happens only via `channels/publish` (handlePublish, which
        // also records the send in the state tracker so it is recognized as
        // self-authored). This terminator only finalizes the chunk stream:
        // release the buffer, nothing else. The previous body called
        // discord.sendMessage() here, which would double-post against
        // handlePublish the moment a host grants `channels.streaming` — the
        // same bug class as the retired afterInference sticky-reply (see the
        // NOTE at the capability declaration), reintroduced on a different
        // signal. It was dormant only because the 0.4 boolean `channels`
        // capability made `channels.streaming` undeclarable. Issue #14.
        const p = notif.params as ChannelsOutgoingCompleteParams;
        dbg('outgoing/complete:finalized', { inferenceId: p.inferenceId, channelId: p.channelId });
        this.voice?.handleComplete(p.inferenceId);
        break;
      }

      // The host emits this as `channels/typing` (McplMethod.ChannelsTyping).
      // We also accept the legacy `notifications/typing` spelling for safety.
      case 'channels/typing':
      case 'notifications/typing': {
        const p = notif.params as { channelId?: string; op?: 'start' | 'stop' };
        // Discord has no explicit "stop typing" — the indicator auto-expires a
        // few seconds after the last trigger. So we act only on 'start' (and a
        // missing op counts as start); 'stop' is a no-op.
        if (p.channelId && p.op !== 'stop') {
          const parsed = parseMcplChannelId(p.channelId);
          if (parsed) {
            this.discord.sendTyping(parsed.channelId).catch(() => {});
          }
        }
        break;
      }

      default:
        // Ignore unknown notifications
        break;
    }
  }

  // ── Tool Call Handling ──

  private async handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: ContentBlock[]; isError?: boolean; state?: unknown }> {
    // Check feature set permission
    const fs = featureSetForTool(name);
    if (fs && this.mcplEnabled && !isEnabled(fs, this.enabledFeatureSets)) {
      return {
        content: [textContent(`Feature set '${fs}' is not enabled`)],
        isError: true,
      };
    }

    // Name-based channel addressing. Resolved HERE, once, rather than in each
    // of the dozen-odd tools that take a channelId — one chokepoint means no
    // tool can be added later that silently misses it.
    //
    // Snowflakes and the `discord:<guild>:<channel>` composite pass through
    // untouched, so this is backwards compatible. A name resolves against the
    // live channel cache; ambiguity is a hard error listing qualified labels
    // rather than a silent pick. See channel-names.ts.
    if (typeof args.channelId === 'string' && args.channelId.trim()) {
      const given = args.channelId;
      const path: AddressingPath = isSnowflake(given.trim()) ? 'explicit-id' : 'name-resolved';
      // An adapter predating this feature has no resolver. Do NOT pass the
      // unresolved name downstream hoping Discord rejects it: "probably bounces"
      // is not the guarantee this feature is for. The whole point is that a send
      // either reaches the channel the agent named or fails audibly, never
      // anything in between -- so refuse here, explicitly, where we can still say
      // why. (Review: Sol, 2026-08-04.)
      const noResolver = typeof this.discord.resolveChannelRef !== 'function';
      if (path === 'name-resolved' && noResolver && looksLikeExplicitName(given)) {
        dbg('channel:resolver-unavailable', { tool: name, given });
        return {
          content: [textContent(
            `Cannot address a channel by name here: this adapter has no channel ` +
            `resolver, so "${given}" cannot be turned into a channel id. Pass the ` +
            `numeric channel id instead.`,
          )],
          isError: true,
        };
      }
      if (path === 'name-resolved' && !noResolver) {
        const resolved = this.discord.resolveChannelRef(given);
        if (!resolved.ok) {
          // Telemetry: log the failure with what was ASKED FOR, so drift is
          // reconstructable from receipts rather than from memory afterwards.
          dbg('channel:resolve-failed', { tool: name, given, reason: resolved.reason });
          return { content: [textContent(resolved.message)], isError: true };
        }
        dbg('channel:resolved', {
          tool: name,
          given,
          channelId: resolved.id,
          label: resolved.matched ? channelLabel(resolved.matched) : undefined,
        });
        args = { ...args, channelId: resolved.id };
      } else {
        dbg('channel:addressing', { tool: name, path, channelId: given });
      }
    }

    try {
      const result = await this.executeToolCall(name, args);

      // Track checkpoints for rollback-enabled tools
      if (fs === 'discord.messaging') {
        const cpId = this.stateTracker.createCheckpoint();
        return {
          content: [textContent(typeof result === 'string' ? result : JSON.stringify(result))],
          state: { checkpoint: cpId },
        };
      }

      return {
        content: [textContent(typeof result === 'string' ? result : JSON.stringify(result))],
      };
    } catch (err) {
      return {
        content: [textContent((err as Error).message)],
        isError: true,
      };
    }
  }

  private async executeToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (name) {
      // For all send_* tools below: update sticky-reply state so the
      // afterInference hook knows the agent explicitly chose a channel
      // this turn (don't double-post via auto-reply) and so the next
      // text-only turn auto-routes here.

      case 'send_message': {
        const channelId = args.channelId as string;
        const content = (args.content as string | undefined) ?? '';
        const files = args.files as OutgoingFile[] | undefined;
        requireContentOrFiles(content, files);
        const result = await this.discord.sendMessage(channelId, content, { files });
        this.stateTracker.recordSent(result.messageId, channelId, content);
        const shifted = this.markOutboundSend(channelId);
        return this.augmentSendResult(result.messageId, channelId, shifted);
      }

      case 'reply_message': {
        const channelId = args.channelId as string;
        const content = (args.content as string | undefined) ?? '';
        const files = args.files as OutgoingFile[] | undefined;
        requireContentOrFiles(content, files);
        const result = await this.discord.sendMessage(
          channelId,
          content,
          { replyTo: args.messageId as string, files },
        );
        this.stateTracker.recordSent(result.messageId, channelId, content);
        const shifted = this.markOutboundSend(channelId);
        return this.augmentSendResult(result.messageId, channelId, shifted);
      }

      case 'send_dm': {
        const content = (args.content as string | undefined) ?? '';
        const files = args.files as OutgoingFile[] | undefined;
        requireContentOrFiles(content, files);
        const result = await this.discord.sendDM(
          args.userId as string,
          content,
          { files },
        );
        const shifted = this.markOutboundSend(result.channelId);
        return this.augmentSendResult(result.messageId, result.channelId, shifted);
      }

      case 'add_reaction':
        await this.discord.addReaction(
          args.channelId as string,
          args.messageId as string,
          args.emoji as string,
        );
        return 'Reaction added';

      case 'remove_reaction':
        await this.discord.removeReaction(
          args.channelId as string,
          args.messageId as string,
          args.emoji as string,
        );
        return 'Reaction removed';

      case 'edit_message':
        await this.discord.editMessage(
          args.channelId as string,
          args.messageId as string,
          args.content as string,
        );
        return 'Message edited';

      case 'delete_message':
        await this.discord.deleteMessage(
          args.channelId as string,
          args.messageId as string,
        );
        return 'Message deleted';

      case 'list_guilds':
        return await this.discord.listGuilds();

      case 'list_channels':
        return await this.discord.listChannels(args.guildId as string);

      case 'list_channel_members':
        return await this.discord.listChannelMembers(args.channelId as string);

      case 'list_emojis':
        return await this.discord.listEmojis(args.guildId as string | undefined);

      case 'set_reaction_visibility': {
        this.ensureReactionChannelsLoaded();
        const channelId = args.channelId as string;
        const visible = args.visible as boolean;
        const had = this.reactionChannels.has(channelId);
        if (visible) this.reactionChannels.add(channelId);
        else this.reactionChannels.delete(channelId);
        if (visible !== had) this.saveReactionChannels();
        return visible
          ? `Reaction visibility ON for channel ${channelId}. Reactions there now appear in your context as they happen (they never wake you).`
          : `Reaction visibility OFF for channel ${channelId}.`;
      }

      case 'refresh_channels':
        return this.refreshChannels();

      case 'fetch_history':
        return this.projectHistoryReactions(await this.discord.fetchHistory(
          args.channelId as string,
          {
            // Per-channel backscroll cap (DISCORD_BACKSCROLL_CHANNELS) also
            // bounds agent-requested history in that channel.
            limit: this.capHistoryLimit(args.channelId as string, (args.limit as number) ?? 50),
            ...(args.before ? { before: args.before as string } : {}),
            ...(args.after ? { after: args.after as string } : {}),
          },
        ));

      case 'fetch_around':
        return this.projectHistoryReactions(await this.discord.fetchAround(
          args.channelId as string,
          args.messageId as string,
          this.capHistoryLimit(args.channelId as string, (args.limit as number) ?? 50),
        ));

      case 'create_text_channel':
        return await this.discord.createTextChannel(
          args.guildId as string,
          args.name as string,
          args.categoryId as string | undefined,
        );

      case 'delete_channel':
        await this.discord.deleteChannel(args.channelId as string);
        return 'Channel deleted';

      case 'subscribe_channel': {
        throw new Error(
          'subscribe_channel is retired. Use the host channel_open tool with the MCPL channel id.',
        );
      }

      case 'unsubscribe_channel': {
        throw new Error(
          'unsubscribe_channel is retired. Use the host channel_close tool with the MCPL channel id.',
        );
      }

      case 'mute_channel': {
        const channelId = args.channelId as string;
        if (typeof channelId !== 'string' || channelId.length === 0) {
          throw new Error('channelId is required');
        }
        this.ensureMutedLoaded();
        const wasNew = !this.mutedChannels.has(channelId);
        this.mutedChannels.add(channelId);
        if (wasNew) this.saveMuted();
        // Muting implies leaving: drop any ambient subscription so the channel
        // stops delivering; it also won't auto-subscribe back in while muted.
        this.ensureSubscriptionsLoaded();
        this.subscribedChannels.delete(channelId);
        return wasNew
          ? `Muted channel ${channelId}: no ambient, no wake on mention/reply, and it will not auto-subscribe you back in. Reverse with unmute_channel("${channelId}").`
          : `Channel ${channelId} was already muted.`;
      }

      case 'unmute_channel': {
        const channelId = args.channelId as string;
        if (typeof channelId !== 'string' || channelId.length === 0) {
          throw new Error('channelId is required');
        }
        this.ensureMutedLoaded();
        const removed = this.mutedChannels.delete(channelId);
        if (removed) this.saveMuted();
        return removed
          ? `Unmuted channel ${channelId}. Direct addresses will reach you again; use channel_open with its MCPL id for ordinary traffic.`
          : `Channel ${channelId} was not muted.`;
      }

      case 'list_subscriptions': {
        this.ensureSubscriptionsLoaded();
        this.ensureWatermarkLoaded();
        const missed = [...this.missedTally.entries()]
          .filter(([, t]) => t.messages > 0)
          .map(([channelId, t]) => ({
            // Raw ID first (load-bearing for fetch_* and the tally key),
            // then resolved labels + composite MCPL id from local caches —
            // no REST per row (issue #28).
            ...this.resolveChannelMeta(channelId),
            missedMessages: t.messages,
            missedCharacters: t.characters,
          }))
          .sort((a, b) => b.missedCharacters - a.missedCharacters);
        return {
          channels: [...this.subscribedChannels].sort(),
          count: this.subscribedChannels.size,
          unsubscribedWithBacklog: missed,
          note:
            this.subscribedChannels.size === 0
              ? 'No ambient subscriptions. Mentions and DMs are always delivered.'
              : 'Ambient messages from these channels are delivered. Mentions and DMs always come through regardless.',
        };
      }

      case 'channel_missed': {
        this.ensureSubscriptionsLoaded();
        this.ensureWatermarkLoaded();
        const channelId = args.channelId as string;
        if (typeof channelId !== 'string' || channelId.length === 0) {
          throw new Error('channelId is required');
        }
        if (this.subscribedChannels.has(channelId)) {
          return {
            ...this.resolveChannelMeta(channelId),
            subscribed: true,
            missedMessages: 0,
            missedCharacters: 0,
            note: 'Currently subscribed — ambient messages are being delivered, nothing is being missed.',
          };
        }
        const tally = this.missedTally.get(channelId);
        if (!tally) {
          return {
            ...this.resolveChannelMeta(channelId),
            subscribed: false,
            tracked: false,
            note: 'Not tracking this channel. A missed-ambient tally starts only after you unsubscribe from a channel you were subscribed to.',
          };
        }
        return {
          ...this.resolveChannelMeta(channelId),
          subscribed: false,
          tracked: true,
          missedMessages: tally.messages,
          missedCharacters: tally.characters,
          sinceMessageId: tally.anchorId || null,
          note:
            'Ambient messages (non-mention, non-DM) you have missed in this channel since you unsubscribed. ' +
            'Mentions and DMs were still delivered and are not counted. Counts cover the bot\'s online time plus ' +
            'an on-reconnect backfill of downtime gaps. Reopen with channel_open to start receiving these again.',
        };
      }

      case 'filters_get': {
        const f = this.discord.getFilters();
        const path = process.env.DISCORD_FILTERS_FILE;
        return {
          hotAdjustable: !!path,
          filtersFile: path ?? null,
          guildIds: f.guildIds ?? null,
          guildChannels: f.guildChannels ?? null,
          dmUsers: f.dmUsers ?? null,
          plane: this.filtersState.planeStatus(),
          reactionSuppression: {
            ...this.filtersState.suppressionStatus(),
            writable: false,
            whyNotWritable:
              'Suppression entries are operator-maintained in the filters file until a host-level ' +
              'semantic-key facility lands; a referential update surface (suppress-by-key, no literal ' +
              'markers) arrives with it. The entries are never echoed here by design.',
            note:
              'Some reactions on your account are placed by the host, not by you — "me": true on a ' +
              'reaction is not evidence you authored it. A "stale" status means the last-known-good ' +
              'set is still enforced but only for this process lifetime; it does not survive a restart.',
          },
          note:
            'null = unrestricted. These filters gate which Discord events reach you; ' +
            'they are not Discord-side permissions — the bot must also be a member of a guild to see it.' +
            (path
              ? ''
              : ' Hot updates are disabled: set DISCORD_FILTERS_FILE in the environment (one restart) to enable filters_update.'),
        };
      }

      case 'filters_update':
        return await this.filtersUpdate(args);

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /** Hot-apply a whitelist change: mutate the filters file (source of truth),
   *  swap the adapter's in-memory filters, and register any newly-visible
   *  channels with the host. See tools.ts for the argument semantics. */
  private async filtersUpdate(args: Record<string, unknown>): Promise<unknown> {
    const path = process.env.DISCORD_FILTERS_FILE;
    if (!path) {
      throw new Error(
        'Hot filter updates are disabled: DISCORD_FILTERS_FILE is not set. ' +
          'Set it in the environment and restart once to enable.',
      );
    }
    // The desired state on disk must be readable before any write. A
    // missing or malformed operator file is never reconstructed from
    // process memory — that would overwrite whatever the operator had
    // (including suppression entries the in-memory state may not carry),
    // bypassing the same protection the startup path gives it. Refusing
    // loudly is the plane working: repair is hot (the poller picks it up
    // within seconds), so nothing here needs a restart.
    if (!existsSync(path)) {
      throw new Error(
        `The filters file is MISSING on disk (${path}). Refusing to recreate it from process memory — ` +
          'an operator should restore the file (or restart to re-seed it); hot reload then applies it within seconds.',
      );
    }
    const current = loadFiltersFile(path);
    if (!current) {
      throw new Error(
        'The filters file exists but cannot be parsed. Refusing to overwrite it — ' +
          'an operator should repair the JSON (it hot-reloads, no restart needed), then retry this update.',
      );
    }
    // Rebuild from the fresh desired state, so an operator edit made
    // within the poller's 3s window survives this rewrite — including the
    // operator-owned suppression key, which rides through untouched (the
    // tool schema has no parameter that can carry it).
    const next: DiscordFilters = {
      guildIds: current.guildIds ? [...current.guildIds] : undefined,
      guildChannels: current.guildChannels
        ? Object.fromEntries(Object.entries(current.guildChannels).map(([g, c]) => [g, [...c]]))
        : undefined,
      dmUsers: current.dmUsers ? [...current.dmUsers] : undefined,
      suppressedReactionEmojis: current.suppressedReactionEmojis,
    };
    const notes: string[] = [];

    const addGuilds = (args.addGuilds as string[] | undefined) ?? [];
    const removeGuilds = (args.removeGuilds as string[] | undefined) ?? [];
    if ((addGuilds.length || removeGuilds.length) && !next.guildIds?.length) {
      // Currently unrestricted: materialize the implicit allow-list (every
      // guild the bot is in) so an add doesn't silently become "ONLY this
      // guild" and a remove has something to remove from.
      next.guildIds = (await this.discord.listGuilds()).map((g) => g.id);
      notes.push(
        'Guild filter was unrestricted; materialized it as the list of all current guilds before applying your change.',
      );
    }
    for (const entry of addGuilds) {
      const [gid, chans] = entry.split(':', 2);
      if (!gid) continue;
      if (!next.guildIds!.includes(gid)) next.guildIds!.push(gid);
      if (chans) {
        const wanted = chans.split('+').map((s) => s.trim()).filter(Boolean);
        const existing = next.guildChannels?.[gid];
        if (existing) {
          (next.guildChannels ??= {})[gid] = [...new Set([...existing, ...wanted])];
        } else if (!current.guildIds?.includes(gid)) {
          // New guild with an explicit channel list -> restrict to it.
          (next.guildChannels ??= {})[gid] = wanted;
        } else {
          notes.push(
            `Guild ${gid} already allows all channels; the channel list on "${entry}" is a no-op.`,
          );
        }
      } else if (next.guildChannels?.[gid]) {
        // Bare guild id = whole guild -> drop the channel restriction.
        delete next.guildChannels[gid];
        notes.push(`Guild ${gid}: channel restriction removed — all channels now allowed.`);
      }
    }
    for (const gid of removeGuilds) {
      next.guildIds = next.guildIds!.filter((g) => g !== gid);
      if (next.guildChannels) delete next.guildChannels[gid];
    }

    if (args.setDmUsers !== undefined) {
      const list = (args.setDmUsers as string[]).map(String).filter(Boolean);
      next.dmUsers = list.length ? list : undefined;
      if (!list.length) notes.push('DM whitelist cleared — DMs from ANYONE are now delivered.');
    }

    saveFiltersFile(path, next);
    const diff = this.discord.updateFilters(next);
    // Re-apply the plane from what was just written — the file is
    // known-good again (we just wrote it atomically), and this keeps the
    // effective state and digest in sync with disk without waiting a poll.
    this.filtersState.applyParsed(next);
    const refreshed = diff.addedGuilds.length ? this.refreshChannels() : null;
    console.error(
      `[discord-mcpl] filters updated via tool (guilds +${diff.addedGuilds.length}/-${diff.removedGuilds.length})`,
    );

    const applied = this.discord.getFilters();
    if (diff.removedGuilds.length) {
      notes.push(
        'Removed guilds stop delivering events immediately, but their channels stay listed on the host until restart.',
      );
    }
    return {
      applied: {
        guildIds: applied.guildIds ?? null,
        guildChannels: applied.guildChannels ?? null,
        dmUsers: applied.dmUsers ?? null,
      },
      guildsNowDelivering: diff.addedGuilds,
      guildsStoppedDelivering: diff.removedGuilds,
      newChannelsRegistered: refreshed?.added ?? [],
      notes,
    };
  }

  /** Re-register channels after an externally-driven filter change (the
   *  filters-file hot-reload poller in index.ts). */
  applyFilterChange(): void {
    this.refreshChannels();
  }

  // ── Sticky-reply state mutators ──

  /** Build the tool-result object for a successful send_*. Just the messageId
   *  now — the old "sticky channel is now X / your text-only replies route
   *  here" note was tied to the retired per-surface sticky and would be
   *  misleading under host-owned routing (the host routes plain-text turns to
   *  the conversational locus, i.e. the most recent *incoming* channel, not
   *  the last channel this bot sent to). `_shifted` is kept in the signature
   *  for call-site compatibility but no longer used. */
  private async augmentSendResult(
    messageId: string,
    _channelId: string,
    _shifted: boolean,
  ): Promise<{ messageId: string }> {
    return { messageId };
  }


  /** Called from every successful send_* tool dispatch. Updates the sticky
   *  channel to the just-sent destination, clears the replyTo target
   *  (we're now ahead of any inbound), and flags that the agent already
   *  spoke via tool this turn so the afterInference hook doesn't
   *  double-post the same text.
   *
   *  Returns true iff the sticky channel actually shifted to somewhere new
   *  — i.e., the agent sent to a different channel than the last
   *  communication context. Caller uses this to decide whether to announce
   *  the shift in the tool result (so Lena knows her text-only replies
   *  will now route to the new place). Returns false on first-ever send
   *  (no prior context to shift from) and on resends to the same channel. */
  private markOutboundSend(channelId: string): boolean {
    const prev = this.lastChannelId;
    const shifted = prev !== null && prev !== channelId;
    this.lastChannelId = channelId;
    this.lastInboundMessageId = null;
    this.sentInCurrentTurn = true;
    return shifted;
  }

  /** RETIRED: sticky auto-reply.
   *
   *  Output routing is now host-owned (the framework publishes text-only turns
   *  to the conversational locus via channels/publish — see
   *  LOCUS-ROUTING-DESIGN.md). This server no longer declares the
   *  `contextHooks.afterInference` capability, so the host won't call this. The
   *  stub is retained only so a stray afterInference request (e.g. from an
   *  older host that still calls it) is a harmless no-op rather than a
   *  double-post against the host router. */
  private async handleAfterInference(_params: unknown): Promise<void> {
    this.sentInCurrentTurn = false;
    dbg('afterInference:noop', { reason: 'sticky-retired-host-owns-routing' });
  }

  // ── Subscription persistence ──

  /** Path to the retired subscription file. Read as a bootstrap hint for a
   *  host whose Chronicle has not yet recorded desired state. */
  private subscriptionsFile(): string | undefined {
    const p = process.env.DISCORD_SUBSCRIPTIONS_FILE;
    return p && p.length > 0 ? p : undefined;
  }

  /** Lazy-load subscriptions from disk on first access. Idempotent. */
  private ensureSubscriptionsLoaded(): void {
    if (this.subscriptionsLoaded) return;
    this.subscriptionsLoaded = true;
    const path = this.subscriptionsFile();
    if (!path || !existsSync(path)) return;
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === 'string' && id.length > 0) this.subscribedChannels.add(id);
        }
      }
      dbg('subscriptions:loaded', { count: this.subscribedChannels.size, path });
    } catch (err) {
      // Corrupt or unreadable file: start with empty set; don't fail boot.
      console.error('[discord-mcpl] Failed to load subscriptions:', (err as Error).message);
      dbg('subscriptions:load-failed', { error: (err as Error).message, path });
    }
  }

  private isChannelSubscribed(channelId: string): boolean {
    this.ensureSubscriptionsLoaded();
    return this.subscribedChannels.has(channelId);
  }

  /** Reaction-visibility file: explicit env override, else a `.reactions.json`
   *  sibling of the subscriptions file. */
  private reactionChannelsFile(): string | undefined {
    const p = process.env.DISCORD_REACTION_CHANNELS_FILE;
    if (p && p.length > 0) return p;
    const sub = this.subscriptionsFile();
    return sub ? sub.replace(/(\.json)?$/i, '.reactions.json') : undefined;
  }

  /** Lazy-load reaction-visibility channels from disk on first access. Idempotent. */
  private ensureReactionChannelsLoaded(): void {
    if (this.reactionChannelsLoaded) return;
    this.reactionChannelsLoaded = true;
    const path = this.reactionChannelsFile();
    if (!path || !existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === 'string' && id.length > 0) this.reactionChannels.add(id);
        }
      }
      dbg('reaction-channels:loaded', { count: this.reactionChannels.size, path });
    } catch (err) {
      console.error('[discord-mcpl] Failed to load reaction channels:', (err as Error).message);
      dbg('reaction-channels:load-failed', { error: (err as Error).message, path });
    }
  }

  private saveReactionChannels(): void {
    const path = this.reactionChannelsFile();
    if (!path) return; // in-memory mode
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify([...this.reactionChannels].sort(), null, 2) + '\n');
    } catch (err) {
      console.error('[discord-mcpl] Failed to save reaction channels:', (err as Error).message);
      dbg('reaction-channels:save-failed', { error: (err as Error).message, path });
    }
  }

  /**
   * The SINGLE ingestion decision: does a Discord event in this channel enter
   * the agent's context? Every event type — message create, edit, delete —
   * must route through here so the filtering rule lives in exactly one place
   * and can't drift. (It drifted before: edits/deletes bypassed the
   * subscription check that creates go through, leaking cross-channel edit/
   * delete markers into agents scoped to the whole guild.)
   *
   * Forward iff the channel is subscribed (ambient), OR the event addresses the
   * bot (mention/reply), OR it's a DM. Non-subscribed ambient — including its
   * edits and deletes — is dropped.
   */
  private shouldEnterContext(
    channelId: string,
    opts: { isMention?: boolean; isDM?: boolean } = {},
  ): boolean {
    return Boolean(opts.isMention) || Boolean(opts.isDM) || this.isChannelSubscribed(channelId);
  }

  // Mute persistence: DISCORD_MUTED_CHANNELS_FILE, else a sibling of the
  // subscriptions file (…​.muted.json). In-memory when neither is available.
  private mutedFile(): string | undefined {
    const explicit = process.env.DISCORD_MUTED_CHANNELS_FILE;
    if (explicit && explicit.length > 0) return explicit;
    const sub = this.subscriptionsFile();
    if (!sub) return undefined;
    return sub.replace(/\.json$/i, '') + '.muted.json';
  }

  private ensureMutedLoaded(): void {
    if (this.mutedLoaded) return;
    this.mutedLoaded = true;
    const path = this.mutedFile();
    if (!path || !existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      if (Array.isArray(parsed)) {
        for (const id of parsed) if (typeof id === 'string' && id.length > 0) this.mutedChannels.add(id);
      }
      dbg('muted:loaded', { count: this.mutedChannels.size, path });
    } catch (err) {
      console.error('[discord-mcpl] Failed to load muted channels:', (err as Error).message);
    }
  }

  private saveMuted(): void {
    const path = this.mutedFile();
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify([...this.mutedChannels].sort(), null, 2) + '\n');
    } catch (err) {
      console.error('[discord-mcpl] Failed to save muted channels:', (err as Error).message);
    }
  }

  private isChannelMuted(channelId: string): boolean {
    this.ensureMutedLoaded();
    return this.mutedChannels.has(channelId);
  }

  // ── Watermark persistence (for offline catch-up) ──

  /** Path to the JSON file backing per-channel watermarks + DM channel IDs.
   *  When unset, watermarks are in-memory only and the catch-up sweep is a
   *  no-op (no persisted anchor survives a restart). */
  private watermarkFile(): string | undefined {
    const p = process.env.DISCORD_WATERMARK_FILE;
    return p && p.length > 0 ? p : undefined;
  }

  /** Lazy-load watermarks + DM channel IDs from disk. Idempotent. */
  private ensureWatermarkLoaded(): void {
    if (this.watermarkLoaded) return;
    this.watermarkLoaded = true;
    const path = this.watermarkFile();
    if (!path || !existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      const marks = parsed?.watermarks;
      if (marks && typeof marks === 'object') {
        for (const [chan, id] of Object.entries(marks)) {
          if (typeof chan === 'string' && typeof id === 'string' && id.length > 0) {
            this.forwardedWatermark.set(chan, id);
          }
        }
      }
      if (Array.isArray(parsed?.dmChannels)) {
        for (const id of parsed.dmChannels) {
          if (typeof id === 'string' && id.length > 0) this.dmChannelIds.add(id);
        }
      }
      const missed = parsed?.missed;
      if (missed && typeof missed === 'object') {
        for (const [chan, v] of Object.entries(missed as Record<string, unknown>)) {
          const e = v as Partial<{
            anchorId: string;
            talliedThrough: string;
            messages: number;
            characters: number;
          }>;
          if (typeof chan === 'string' && chan.length > 0) {
            this.missedTally.set(chan, {
              anchorId: typeof e.anchorId === 'string' ? e.anchorId : '',
              talliedThrough:
                typeof e.talliedThrough === 'string' ? e.talliedThrough : e.anchorId ?? '',
              messages: Number.isFinite(e.messages) ? (e.messages as number) : 0,
              characters: Number.isFinite(e.characters) ? (e.characters as number) : 0,
            });
          }
        }
      }
      dbg('watermark:loaded', {
        channels: this.forwardedWatermark.size,
        dms: this.dmChannelIds.size,
        missed: this.missedTally.size,
        path,
      });
    } catch (err) {
      console.error('[discord-mcpl] Failed to load watermarks:', (err as Error).message);
      dbg('watermark:load-failed', { error: (err as Error).message, path });
    }
  }

  /** Persist the watermark map + DM channel set. Best-effort; called after
   *  each forward so the anchor is current if the process dies. */
  private saveWatermark(): void {
    const path = this.watermarkFile();
    if (!path) return; // in-memory mode
    try {
      mkdirSync(dirname(path), { recursive: true });
      const out = {
        watermarks: Object.fromEntries(
          [...this.forwardedWatermark.entries()].sort((a, b) => a[0].localeCompare(b[0])),
        ),
        dmChannels: [...this.dmChannelIds].sort(),
        missed: Object.fromEntries(
          [...this.missedTally.entries()].sort((a, b) => a[0].localeCompare(b[0])),
        ),
      };
      writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
    } catch (err) {
      console.error('[discord-mcpl] Failed to save watermarks:', (err as Error).message);
      dbg('watermark:save-failed', { error: (err as Error).message, path });
    }
  }

  // ── Reconnect catch-up sweep ──

  /** Channel display metadata for tool results, resolved WITHOUT a REST
   *  round-trip: gateway cache first, then the registered MCPL descriptor.
   *  Raw IDs stay load-bearing (fetch_around/fetch_history take them);
   *  labels are best-effort with an explicit `metadataResolved` flag so a
   *  failed lookup is distinguishable from an unnamed field (issue #28). */
  private resolveChannelMeta(channelId: string): {
    channelId: string;
    mcplChannelId: string | null;
    channelName: string | null;
    guildId: string | null;
    guildName: string | null;
    metadataResolved: boolean;
  } {
    if (this.dmChannelIds.has(channelId)) {
      const desc = this.channelManager.get(mcplChannelId('dm', channelId));
      const recipient =
        (desc?.metadata as { recipientName?: string } | undefined)?.recipientName ?? null;
      return {
        channelId,
        mcplChannelId: mcplChannelId('dm', channelId),
        channelName: recipient,
        guildId: null,
        guildName: null,
        metadataResolved: recipient !== null,
      };
    }
    const cached = this.discord.getCachedChannelMeta(channelId);
    if (cached?.guildId) {
      return {
        channelId,
        mcplChannelId: mcplChannelId(cached.guildId, channelId),
        channelName: cached.name,
        guildId: cached.guildId,
        guildName: cached.guildName,
        metadataResolved: cached.name !== null,
      };
    }
    // Descriptor fallback: registration keeps address + label even when the
    // gateway cache doesn't hold the channel (evicted, or a filtered late
    // join). Label format is toDescriptor's `#name (Guild)`.
    for (const desc of this.channelManager.getAll()) {
      const addr = desc.address as { guildId?: string; channelId?: string } | undefined;
      if (addr?.channelId === channelId && addr.guildId && addr.guildId !== 'dm') {
        const m = /^#(.+) \((.+)\)$/.exec(desc.label ?? '');
        return {
          channelId,
          mcplChannelId: desc.id,
          channelName: m ? m[1] : (desc.label ?? null),
          guildId: addr.guildId,
          guildName: m ? m[2] : null,
          metadataResolved: true,
        };
      }
    }
    dbg('channel-meta:unresolved', { channelId });
    return {
      channelId,
      mcplChannelId: null,
      channelName: null,
      guildId: null,
      guildName: null,
      metadataResolved: false,
    };
  }

  /** Project suppressed reactions out of history messages before they
   *  become model-visible (fetch_history / fetch_around tool results,
   *  channel-open backscroll metadata). When suppression is due to a broken
   *  filters plane the message carries `reactionsUnavailable: true` — an
   *  empty list that actually means "couldn't project" must not read as
   *  "none" (Sol's #31 ruling, truthfulness on partial state).
   *
   *  Line-formatted transcripts (the reconnect `<missed>` sweep, the
   *  first-interaction backscroll) get the same projection through
   *  renderReactionState below — one filter, every surface. */
  private projectHistoryReactions<T extends { reactions?: ReactionSummary[] }>(
    msgs: T[],
  ): Array<T & { reactionsUnavailable?: true }> {
    return msgs.map((m) => {
      const proj = this.filtersState.project(m.reactions);
      return {
        ...m,
        reactions: proj.reactions,
        ...(proj.unavailable ? { reactionsUnavailable: true as const } : {}),
      };
    });
  }

  /** Render current NET reaction state as a line suffix for text transcripts
   *  — the reconnect `<missed>` sweep and the first-interaction backscroll
   *  (issue #31). One shared renderer so every historical path shows the same
   *  message the same way: the current aggregate after the suppression
   *  projection, independent of the live set_reaction_visibility toggle
   *  (that opt-in governs ambient add/remove events; historical rendering is
   *  a current-state snapshot, never a replay of the event sequence).
   *
   *  Truthfulness on partial state: no suffix means "no visible reactions".
   *  State we don't actually have — the resolver gave us nothing, or a
   *  failed-closed policy forbids showing what we do have — renders as an
   *  explicit unavailable marker instead, with no hint of which case it was. */
  private renderReactionState(reactions: ReactionSummary[] | undefined): string {
    const proj = this.filtersState.project(reactions);
    if (reactions === undefined || proj.unavailable) return ' [reactions: unavailable]';
    if (proj.reactions.length === 0) return '';
    const parts = proj.reactions.map(
      (r) => `${r.emoji} x${r.count}${r.me ? ' (incl. me)' : ''}`,
    );
    return ` [reactions: ${parts.join(', ')}]`;
  }

  /** On (re)connect, deliver what arrived while the bot was offline:
   *  mentions + DMs from any known channel, plus the full missed backscroll
   *  for subscribed channels (which already receive ambient delivery). Each
   *  channel is scanned from its persisted watermark, bounded by catchupLimit.
   *
   *  No-op unless a watermark file is configured (without a persisted anchor
   *  there's no "since when" to scan from) and messaging is enabled. Runs at
   *  most once per process. */
  private async runReconnectSweep(): Promise<void> {
    if (this.sweepDone) return;
    this.sweepDone = true;
    const conn = this.conn;
    if (!conn || !this.mcplEnabled) return;
    if (!isEnabled('discord.messaging', this.enabledFeatureSets)) return;
    if (!this.watermarkFile()) {
      dbg('sweep:skip', { reason: 'no-watermark-file' });
      return;
    }
    this.ensureSubscriptionsLoaded();
    this.ensureWatermarkLoaded();
    const botId = this.discord.botUserId;

    // Scan anything we have an anchor for, plus subscribed channels and known
    // DMs. A channel with no persisted watermark is skipped — there's no
    // "since" point and we don't want to pull unbounded history; the inline
    // first-interaction backscroll covers it when it's next touched.
    const candidates = new Set<string>([
      ...this.forwardedWatermark.keys(),
      ...this.subscribedChannels,
      ...this.dmChannelIds,
    ]);

    let delivered = 0;
    for (const channelId of candidates) {
      const watermark = this.forwardedWatermark.get(channelId);
      if (!watermark) continue;
      const isDM = this.dmChannelIds.has(channelId);
      const isSubscribed = this.subscribedChannels.has(channelId);

      let msgs: Awaited<ReturnType<typeof this.discord.fetchHistory>>;
      try {
        msgs = await this.discord.fetchHistory(channelId, {
          limit: this.catchupLimit,
          after: watermark,
        });
      } catch (err) {
        dbg('sweep:fetch-failed', { channelId, error: (err as Error).message });
        continue;
      }
      msgs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      // Drop the bot's own past messages and chx no-op triggers, mirroring the
      // inline backscroll filter.
      msgs = msgs.filter((m) => m.authorId !== botId && !m.content.startsWith(CHX_NOOP_PREFIX));
      if (msgs.length === 0) continue;

      const newestId = msgs[msgs.length - 1].id;
      // Delivery rule: DMs and subscribed channels get the full missed
      // backscroll; every other known channel gets each mention plus its
      // immediate vicinity (the ±VICINITY messages around each ping), so the
      // agent sees the surrounding exchange, not a bare ping line. A
      // count-window is robust to channel pace (a time window collapses to
      // nothing in a quiet channel). Vicinity comes from the already-fetched
      // `msgs` — no extra REST calls.
      const VICINITY = 7;
      const keepAll = isDM || isSubscribed;
      const mentionCount = msgs.filter((m) => m.mentionsBot).length;
      let kept: typeof msgs;
      if (keepAll) {
        kept = msgs;
      } else {
        const keepIdx = new Set<number>();
        for (let i = 0; i < msgs.length; i++) {
          if (!msgs[i].mentionsBot) continue;
          for (let j = Math.max(0, i - VICINITY); j <= Math.min(msgs.length - 1, i + VICINITY); j++) {
            keepIdx.add(j);
          }
        }
        kept = [...keepIdx].sort((a, b) => a - b).map((i) => msgs[i]);
      }
      if (kept.length === 0) {
        // Nothing to deliver, but advance the anchor so we don't re-scan these
        // messages on the next reconnect.
        this.forwardedWatermark.set(channelId, newestId);
        continue;
      }
      const hadMention = isDM || mentionCount > 0;

      // Cache-first, REST only as fallback; a failed lookup leaves a trace
      // instead of silently shipping a name-less block (issue #28).
      let meta = this.discord.getCachedChannelMeta(channelId);
      if (!meta) {
        meta = await this.discord.getChannelMeta(channelId).catch((err) => {
          dbg('sweep:channel-meta-failed', { channelId, error: (err as Error).message });
          return null;
        });
      }
      const attrs: string[] = [];
      if (meta?.name) attrs.push(`channel="#${meta.name}"`);
      // channelId is load-bearing: it's what fetch_around/fetch_history need to
      // let the agent jump to any of these messages and read the full context.
      attrs.push(`channelId="${channelId}"`);
      if (meta?.guildName) attrs.push(`guild=${JSON.stringify(meta.guildName)}`);
      else if (isDM) attrs.push('dm="true"');
      // count = number of actual mentions; lines = total delivered (mentions +
      // their ±2min vicinity) so the agent knows how much is context vs ping.
      attrs.push(`count="${keepAll ? kept.length : mentionCount}"`);
      if (!keepAll) attrs.push(`lines="${kept.length}"`);
      attrs.push(`reason="${isDM ? 'dm' : hadMention ? 'mention' : 'backscroll'}"`);
      const lines = kept.map((m) => {
        const ts = formatAgentDateTime(m.timestamp, AGENT_TIME_ZONE, AGENT_TIMESTAMP_STYLE);
        const att =
          m.attachments && m.attachments.length > 0
            ? ` [attachments: ${m.attachments.map((a) => a.name).join(', ')}]`
            : '';
        // Flag the actual ping lines so they stand out from vicinity context.
        const mark = m.mentionsBot ? ' (mention)' : '';
        // Lead each line with the message id so the agent can
        // fetch_around(channelId, id) to read the surrounding conversation.
        // (ts is empty under AGENT_TIMESTAMP_STYLE=none — the id stays.)
        return `[${ts ? `${ts} ` : ''}id=${m.id}] ${m.authorName}${mark}: ${m.cleanContent}${att}${this.renderReactionState(m.reactions)}`;
      });
      const block = [
        `<missed ${attrs.join(' ')}>`,
        ...lines,
        '</missed>',
      ].join('\n');

      try {
        await conn.sendRequest(method.PUSH_EVENT, {
          featureSet: 'discord.messaging',
          eventId: `discord_missed_${channelId}_${newestId}`,
          timestamp: new Date().toISOString(),
          origin: {
            source: 'discord',
            channelId,
            guildId: meta?.guildId ?? null,
            guildName: meta?.guildName ?? undefined,
            channelName: meta?.name ?? undefined,
            isMention: hadMention,
            isDM,
          } as Record<string, unknown>,
          payload: { content: [textContent(block)] },
        } satisfies PushEventParams);
        // Advance past everything we scanned (not just what we delivered) so a
        // mention-only channel doesn't re-surface its non-mention tail later.
        this.forwardedWatermark.set(channelId, newestId);
        delivered++;
      } catch (err) {
        dbg('sweep:send-failed', { channelId, error: (err as Error).message });
      }
    }

    // Fill the downtime gap in any missed-ambient tallies (unsubscribed
    // channels the agent is tracking) so `channel_missed` stays exact across
    // outages, not just while online.
    await this.backfillMissedTallies();

    this.saveWatermark();
    dbg('sweep:done', { channelsDelivered: delivered, scanned: candidates.size });
    if (delivered > 0) {
      console.error(
        `[discord-mcpl] Reconnect catch-up: delivered missed messages from ${delivered} channel(s)`,
      );
    }
  }

  /** For each tracked unsubscribed channel, count the ambient that arrived
   *  while we were offline (between `talliedThrough` and now) into its missed
   *  tally, so the count survives downtime. Uses a dedicated fetch from the
   *  tally cursor (independent of the sweep's watermark) to avoid any
   *  double-counting. Bounded by catchupLimit; if a gap exceeds it the count
   *  is a floor (flagged in `channel_missed`). */
  private async backfillMissedTallies(): Promise<void> {
    if (this.missedTally.size === 0) return;
    const botId = this.discord.botUserId;
    for (const [channelId, tally] of this.missedTally) {
      // No cursor (channel unsubscribed before it ever forwarded a message):
      // nothing to anchor a fetch on — online drops alone carry the count.
      if (!tally.talliedThrough) continue;
      let msgs: Awaited<ReturnType<typeof this.discord.fetchHistory>>;
      try {
        msgs = await this.discord.fetchHistory(channelId, {
          limit: this.catchupLimit,
          after: tally.talliedThrough,
        });
      } catch (err) {
        dbg('missed-backfill:fetch-failed', { channelId, error: (err as Error).message });
        continue;
      }
      // Only ambient counts as "missed": mentions/DMs are (re)delivered by the
      // sweep, so they were seen. Drop our own messages and chx no-ops too.
      const ambient = msgs.filter(
        (m) => !m.mentionsBot && m.authorId !== botId && !m.content.startsWith(CHX_NOOP_PREFIX),
      );
      if (ambient.length > 0) {
        tally.messages += ambient.length;
        tally.characters += ambient.reduce((n, m) => n + m.cleanContent.length, 0);
      }
      // Advance the cursor past everything we fetched (mentions included) so we
      // don't re-scan it next reconnect.
      if (msgs.length > 0) {
        const newest = msgs.reduce((a, b) =>
          a.id.localeCompare(b.id, 'en-US-u-kn-true') >= 0 ? a : b,
        );
        tally.talliedThrough = newest.id;
      }
      dbg('missed-backfill:channel', {
        channelId,
        added: ambient.length,
        messages: tally.messages,
        characters: tally.characters,
      });
    }
  }

  // ── Channel Operations ──

  private async registerDiscordChannels(): Promise<void> {
    const conn = this.conn;
    dbg('registerDiscordChannels:enter', { hasConn: !!conn, mcplEnabled: this.mcplEnabled });
    if (!conn || !this.mcplEnabled) {
      dbg('registerDiscordChannels:skip', { reason: !conn ? 'no-conn' : 'mcpl-disabled' });
      return;
    }

    this.ensureSubscriptionsLoaded();
    const textChannels = this.discord.getTextChannels();
    const descriptors = textChannels.map(({ guildId, guildName, channel }) =>
      toDescriptor(
        guildId,
        guildName,
        channel,
        this.subscribedChannels.has(channel.id),
        this.backscrollLimitFor(channel.id),
      ),
    );
    dbg('registerDiscordChannels:enumerated', {
      count: descriptors.length,
      ids: descriptors.map(d => d.id),
    });

    if (descriptors.length === 0) {
      dbg('registerDiscordChannels:skip', { reason: 'no-channels' });
      return;
    }

    this.channelManager.registerAll(descriptors);

    const regParams: ChannelsRegisterParams = { channels: descriptors };
    try {
      await conn.sendRequest(method.CHANNELS_REGISTER, regParams);
      dbg('registerDiscordChannels:sent', { count: descriptors.length });
    } catch (err) {
      console.error('[discord-mcpl] Failed to register channels:', (err as Error).message);
      dbg('registerDiscordChannels:send-failed', { error: (err as Error).message });
    }
  }

  /** Register the given descriptors and emit a single `channels/changed`
   *  notification for the ones that weren't already known. Idempotent:
   *  re-registering a known channel refreshes its descriptor (e.g. a renamed
   *  label) but does NOT re-announce it, so repeat calls (channelUpdate
   *  firing on every edit, or a manual refresh) don't spam the host. Returns
   *  the descriptors that were newly added. */
  private registerAndNotifyNew(descriptors: ChannelDescriptor[]): ChannelDescriptor[] {
    const added: ChannelDescriptor[] = [];
    for (const d of descriptors) {
      if (!this.channelManager.get(d.id)) added.push(d);
      this.channelManager.register(d);
    }
    if (added.length > 0 && this.conn && this.mcplEnabled) {
      this.conn.sendNotification(method.CHANNELS_CHANGED, { added });
    }
    return added;
  }

  /** Re-enumerate every channel currently visible to the bot and register any
   *  that the host doesn't yet know about. This is the agent-facing catch-all
   *  for "I was added to a channel/server but don't see it" — it doesn't rely
   *  on any specific gateway event having fired, so it covers cases the
   *  event handlers miss (missed events, eventual-consistency gaps, etc.). */
  private refreshChannels(): {
    visible: number;
    added: Array<{ id: string; label: string }>;
    note: string;
  } {
    const textChannels = this.discord.getTextChannels();
    const descriptors = textChannels.map(({ guildId, guildName, channel }) =>
      toDescriptor(
        guildId,
        guildName,
        channel,
        this.isChannelSubscribed(channel.id),
        this.backscrollLimitFor(channel.id),
      ),
    );
    const added = this.registerAndNotifyNew(descriptors);
    dbg('refreshChannels', { visible: descriptors.length, added: added.length });
    return {
      visible: descriptors.length,
      added: added.map((d) => ({ id: d.id, label: d.label })),
      note:
        added.length > 0
          ? `Registered ${added.length} newly-visible channel(s).`
          : 'No new channels — the host already knows about every visible channel.',
    };
  }

  private async handleChannelOpen(params: ChannelOpenRequest): Promise<ChannelOpenResponse> {
    let desc = params.channelId ? this.channelManager.get(params.channelId) : undefined;

    // Compatibility with hosts that predate exact channelId routing.
    const addr = params.address as { guildId?: string; channelId?: string } | undefined;
    if (!desc && params.type === 'discord' && addr?.guildId && addr?.channelId) {
      desc = this.channelManager.get(mcplChannelId(addr.guildId, addr.channelId));
    }

    if (!desc) {
      for (const candidate of this.channelManager.getAll()) {
        if (candidate.type === params.type) {
          desc = candidate;
          break;
        }
      }
    }
    if (!desc) throw new Error('No matching channel found');

    const parsed = parseMcplChannelId(desc.id);
    if (!parsed) throw new Error(`Invalid Discord channel ID: ${desc.id}`);
    const result: ChannelOpenResponse = { channel: desc };
    const requested = params.history?.limit ?? 0;
    if (requested > 0) {
      const limit = this.capHistoryLimit(parsed.channelId, Math.min(500, Math.max(0, requested)));
      const messages = await this.discord.fetchHistory(parsed.channelId, {
        limit,
        ...(params.history?.beforeMessageId ? { before: params.history.beforeMessageId } : {}),
        ...(params.history?.sinceLastSeen
          ? { after: this.forwardedWatermark.get(parsed.channelId) }
          : {}),
      });
      messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      result.history = this.projectHistoryReactions(messages).map((message) => ({
        channelId: desc!.id,
        messageId: message.id,
        author: { id: message.authorId, name: message.authorName },
        timestamp: message.timestamp.toISOString(),
        content: [textContent(`${message.authorName}: ${message.cleanContent}`)],
        metadata: {
          isBot: message.isBot,
          attachments: message.attachments,
          reactions: message.reactions ?? [],
          backscroll: true,
          ...(message.reactionsUnavailable ? { reactionsUnavailable: true } : {}),
        },
      }));
      result.historyTruncated = requested > limit;
    }

    // Commit actual lifecycle only after any requested history fetch succeeds,
    // so a failed open cannot leave Discord subscribed while the host records
    // the operation as failed.
    this.channelManager.open(desc.id);
    this.subscribeRawChannel(parsed.channelId);
    return result;
  }

  private handleChannelClose(params: ChannelsCloseParams): ChannelsCloseResult {
    const desc = this.channelManager.get(params.channelId);
    const parsed = parseMcplChannelId(params.channelId);
    const wasOpen = this.channelManager.close(params.channelId);
    if (parsed) this.unsubscribeRawChannel(parsed.channelId);
    return { closed: wasOpen || desc !== undefined };
  }

  private async handleChannelAcknowledge(params: ChannelAcknowledgeRequest): Promise<{
    acknowledged: boolean;
    representation?: string;
    reason?: string;
  }> {
    const parsed = parseMcplChannelId(params.channelId);
    if (!parsed) {
      return { acknowledged: false, reason: `Invalid Discord channel ID: ${params.channelId}` };
    }
    const representation = params.value?.trim() || '👀';
    try {
      await this.discord.addReaction(parsed.channelId, params.messageId, representation);
      return { acknowledged: true, representation };
    } catch (error) {
      return { acknowledged: false, reason: (error as Error).message };
    }
  }

  private subscribeRawChannel(channelId: string): void {
    this.ensureSubscriptionsLoaded();
    if (!this.subscribedChannels.has(channelId)) {
      this.subscribedChannels.add(channelId);
    }
    this.ensureReactionChannelsLoaded();
    if (!this.reactionChannels.has(channelId)) {
      this.reactionChannels.add(channelId);
    }
    this.ensureWatermarkLoaded();
    if (this.missedTally.delete(channelId)) this.saveWatermark();
    this.ensureMutedLoaded();
    if (this.mutedChannels.delete(channelId)) this.saveMuted();
  }

  private unsubscribeRawChannel(channelId: string): void {
    this.ensureSubscriptionsLoaded();
    const removed = this.subscribedChannels.delete(channelId);
    this.ensureReactionChannelsLoaded();
    this.reactionChannels.delete(channelId);
    if (removed) {
      this.ensureWatermarkLoaded();
      const anchor = this.forwardedWatermark.get(channelId) ?? '';
      this.missedTally.set(channelId, {
        anchorId: anchor,
        talliedThrough: anchor,
        messages: 0,
        characters: 0,
      });
      this.saveWatermark();
    }
  }

  private async handlePublish(params: ChannelsPublishParams): Promise<ChannelsPublishResult> {
    const parsed = parseMcplChannelId(params.channelId);
    if (!parsed) {
      throw new Error(`Invalid channel ID: ${params.channelId}`);
    }

    // Extract text from content blocks
    const text = params.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    if (!text) {
      dbg('handlePublish:skip', { channelId: params.channelId, reason: 'empty-text' });
      return { delivered: false, messageId: undefined };
    }

    dbg('handlePublish', { channelId: params.channelId, textLen: text.length, preview: text.slice(0, 80) });
    const result = await this.discord.sendMessage(parsed.channelId, text);
    this.stateTracker.recordSent(result.messageId, parsed.channelId, text);
    dbg('handlePublish:sent', { channelId: params.channelId, messageId: result.messageId });

    return { delivered: true, messageId: result.messageId };
  }

  // ── Rollback ──

  private async handleRollback(params: StateRollbackParams): Promise<StateRollbackResult> {
    if (params.featureSet !== 'discord.messaging') {
      return {
        checkpoint: params.checkpoint,
        success: false,
        reason: `Feature set '${params.featureSet}' does not support rollback`,
      };
    }

    const toDelete = this.stateTracker.rollback(params.checkpoint);
    if (toDelete === null) {
      return {
        checkpoint: params.checkpoint,
        success: false,
        reason: 'Checkpoint not found',
      };
    }

    // Best-effort delete sent messages
    let deleted = 0;
    for (const msg of toDelete) {
      try {
        await this.discord.deleteMessage(msg.channelId, msg.discordMessageId);
        deleted++;
      } catch {
        // Best-effort — message may have been deleted by someone else
      }
    }

    return {
      checkpoint: params.checkpoint,
      success: true,
      reason: deleted < toDelete.length
        ? `Rolled back (${deleted}/${toDelete.length} messages deleted)`
        : undefined,
    };
  }

  // ── Discord Event Forwarding ──

  private setupDiscordForwarding(): void {
    this.discord.onMessage((msg) => {
      this.handleDiscordMessage(msg).catch((err) => {
        console.error('[discord-mcpl] Error forwarding Discord message:', err);
      });
    });

    this.discord.onMessageEdit((channelId, messageId, newContent, isDM) => {
      if (!this.conn || !this.mcplEnabled) return;
      if (!isEnabled('discord.messaging', this.enabledFeatureSets)) return;
      // Same ingestion gate as a create: an edit in a channel we don't ingest
      // from must not leak in. (Mentions inside an edit are an accepted edge —
      // the subscription/DM threshold is what closes the cross-channel leak.)
      if (!this.shouldEnterContext(channelId, { isDM })) {
        dbg('handleMessageEdit:drop', { channelId, messageId, reason: 'not-subscribed' });
        return;
      }
      this.conn.sendRequest(method.PUSH_EVENT, {
        featureSet: 'discord.messaging',
        eventId: `discord_edit_${messageId}`,
        timestamp: new Date().toISOString(),
        origin: { source: 'discord', channelId },
        payload: { content: [textContent(`[message edited] ${newContent}`)] },
      } satisfies PushEventParams).catch(() => {});
    });

    this.discord.onMessageDelete((channelId, messageId, isDM) => {
      if (!this.conn || !this.mcplEnabled) return;
      if (!isEnabled('discord.messaging', this.enabledFeatureSets)) return;
      if (!this.shouldEnterContext(channelId, { isDM })) {
        dbg('handleMessageDelete:drop', { channelId, messageId, reason: 'not-subscribed' });
        return;
      }
      this.conn.sendRequest(method.PUSH_EVENT, {
        featureSet: 'discord.messaging',
        eventId: `discord_delete_${messageId}`,
        timestamp: new Date().toISOString(),
        origin: { source: 'discord', channelId },
        payload: { content: [textContent(`[message deleted] ${messageId}`)] },
      } satisfies PushEventParams).catch(() => {});
    });

    this.discord.onReaction((ev) => {
      if (!this.conn || !this.mcplEnabled) return;
      if (!isEnabled('discord.messaging', this.enabledFeatureSets)) return;
      // Reaction visibility is a per-channel opt-in (default off). Reactions
      // NEVER wake the agent — the reaction tags match no wake policy — they
      // just land in context so the agent sees them when next active.
      // SPEC §16.2 defines `chat:reaction` and `chat:reaction-remove` as
      // distinct tags: collapsing both onto `chat:reaction` made any consumer
      // rule for "reactions to my messages" fire on un-reactions too, with the
      // distinction surviving only in origin.action, which gate policy cannot
      // match on. Issue #14.
      this.ensureReactionChannelsLoaded();
      if (!this.reactionChannels.has(ev.channelId)) return;
      // Reaction-suppression projection (issue #21): decided before ANY
      // model-visible text or the event id exists, so a suppressed reaction
      // leaves no glyph, name, or token anywhere — the eventId below embeds
      // the emoji, which is exactly why this guard sits above it. The dbg
      // line deliberately carries no emoji either. A broken filters plane
      // with no usable prior set suppresses every reaction event until the
      // file is repaired. (Subsumes the DISCORD_SUPPRESS_REACTION_EMOJIS
      // emergency guard — that env var now feeds this same projection as a
      // compat source.)
      if (
        this.filtersState.suppressAll() ||
        this.filtersState.isSuppressed({ emojiId: ev.emojiId ?? null, emoji: ev.emoji })
      ) {
        dbg('reaction:suppressed', {
          channelId: ev.channelId,
          messageId: ev.messageId,
          action: ev.action,
        });
        return;
      }
      const verb = ev.action === 'add' ? 'reacted' : 'removed a reaction';
      const target = ev.onOwnMessage ? 'your message' : `message ${ev.messageId}`;
      // Carry a snippet of the reacted-to message when it has text — a bare
      // message id is meaningless to the agent (it can't look messages up).
      const quoted = ev.messageSnippet ? ` — "${ev.messageSnippet}"` : '';
      const line = `[reaction] @${ev.userName} ${verb} ${ev.emoji} on ${target}${quoted}`;
      this.conn.sendRequest(method.PUSH_EVENT, {
        featureSet: 'discord.messaging',
        eventId: `discord_reaction_${ev.action}_${ev.messageId}_${ev.emojiId ?? ev.emoji}_${ev.userId}_${ev.timestamp.getTime()}`,
        timestamp: ev.timestamp.toISOString(),
        origin: {
          source: 'discord',
          channelId: ev.channelId,
          messageId: ev.messageId,
          guildId: ev.guildId,
          reactorId: ev.userId,
          reactorName: ev.userName,
          emoji: ev.emoji,
          emojiToken: ev.token,
          onOwnMessage: ev.onOwnMessage,
          action: ev.action,
        } as Record<string, unknown>,
        tags: [ev.action === 'add' ? 'chat:reaction' : 'chat:reaction-remove'],
        payload: { content: [textContent(line)] },
      } satisfies PushEventParams).catch(() => {});
    });

    this.discord.onChannelCreate((guildId, channel) => {
      if (!this.conn || !this.mcplEnabled) return;
      const guildName = this.discord.getGuildName(guildId);
      this.registerAndNotifyNew([
        toDescriptor(
          guildId,
          guildName,
          channel,
          this.isChannelSubscribed(channel.id),
          this.backscrollLimitFor(channel.id),
        ),
      ]);
    });

    // Bot joined a new guild after startup: register all of its existing
    // text channels so they show up in the host's channel list (channelCreate
    // only covers channels created *after* the join).
    this.discord.onGuildCreate((guildId, guildName, channels) => {
      if (!this.conn || !this.mcplEnabled) return;
      const descriptors = channels.map((c) =>
        toDescriptor(
          guildId,
          guildName,
          c,
          this.isChannelSubscribed(c.id),
          this.backscrollLimitFor(c.id),
        ));
      const added = this.registerAndNotifyNew(descriptors);
      dbg('onGuildCreate', { guildId, guildName, total: channels.length, added: added.length });
    });

    // Bot was granted access to a pre-existing channel (permission overwrite).
    this.discord.onChannelAvailable((guildId, channel) => {
      if (!this.conn || !this.mcplEnabled) return;
      const guildName = this.discord.getGuildName(guildId);
      const added = this.registerAndNotifyNew([
        toDescriptor(
          guildId,
          guildName,
          channel,
          this.isChannelSubscribed(channel.id),
          this.backscrollLimitFor(channel.id),
        ),
      ]);
      dbg('onChannelAvailable', { guildId, channelId: channel.id, added: added.length });
    });

    this.discord.onChannelDelete((guildId, channelId) => {
      if (!this.conn || !this.mcplEnabled) return;
      const id = mcplChannelId(guildId, channelId);
      this.channelManager.unregister(id);
      this.conn.sendNotification(method.CHANNELS_CHANGED, {
        removed: [id],
      });
    });
  }

  /** Fetch + convert a message's attachments into MCPL content blocks so the
   *  agent actually sees them. Images are downloaded and inlined as base64
   *  image blocks (robust against Discord's expiring CDN URLs) — the text
   *  inline cap below deliberately does NOT apply to them; an image block is
   *  the model-native representation, not a text paste. Text files inline
   *  only up to attachmentInlineMaxBytes (issue #30), enforced on actual
   *  bytes: a declared-over-cap file skips the fetch entirely, and a
   *  misdeclared one is streamed to at most cap+1 bytes before degrading to
   *  a name+size+URL note. Anything else degrades to a short note with
   *  name + URL. Best-effort: a failed fetch becomes a note rather than
   *  dropping the message. */
  private async buildAttachmentBlocks(attachments: DiscordAttachment[]): Promise<ContentBlock[]> {
    const TEXT_EXT =
      /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ya?ml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|sh|bash|zsh|toml|ini|cfg|conf|sql|diff|patch|env)$/i;
    const fmt = (n: number) =>
      n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`;
    const fetchWithTimeout = async (url: string, ms = 15000): Promise<Response> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      try {
        return await fetch(url, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
    };
    /** Fetch a text body retaining at most maxBytes+1 bytes — Discord's
     *  declared size is advisory, so the inline decision has to come from
     *  what actually arrives, without buffering an arbitrarily large lie.
     *  A chunk larger than the remaining allowance is sliced to it before
     *  retention and the read cancelled immediately, so the bound is
     *  literal even for a single giant chunk. A bodyless response fails
     *  closed (treated as overflow) rather than full-buffering unknown
     *  data. overflow=true means the body exceeded maxBytes; its text is
     *  then unused (over-cap bytes must never become a text block).
     *  bytesRead reports actual bytes consumed off the wire, for budget
     *  accounting. */
    const fetchTextCapped = async (
      url: string,
      maxBytes: number,
      ms = 15000,
    ): Promise<{ text: string; overflow: boolean; bytesRead: number }> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!res.body) {
          return { text: '', overflow: true, bytesRead: 0 };
        }
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let retained = 0; // bytes held in chunks — never exceeds maxBytes + 1
        let bytesRead = 0; // bytes actually received, for budget accounting
        let overflow = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesRead += value.length;
          const room = maxBytes + 1 - retained;
          const take = value.length > room ? value.subarray(0, room) : value;
          chunks.push(take);
          retained += take.length;
          if (retained > maxBytes) {
            overflow = true;
            break;
          }
        }
        if (overflow) {
          void reader.cancel().catch(() => {});
          return { text: '', overflow: true, bytesRead };
        }
        return { text: Buffer.concat(chunks).toString('utf8'), overflow: false, bytesRead };
      } finally {
        clearTimeout(timer);
      }
    };

    // Aggregate budget across the whole batch: the per-item ceilings bound
    // each attachment, but a multi-snapshot forward can carry many of them —
    // without a total cap one message could balloon the context payload.
    // Skipped items degrade to a name+URL note, same as other non-inlined.
    const AGGREGATE_FETCH_BUDGET = 40 * 1024 * 1024;
    let fetchBudgetLeft = AGGREGATE_FETCH_BUDGET;

    // Provenance marker: name the carrying forward. Numbered only when the
    // batch spans several snapshots — the common single-forward case stays
    // as a plain "(forwarded)".
    const multiSnapshot = attachments.some((a) => (a.forwardedSnapshotIndex ?? 0) > 1);
    const fwd = (att: DiscordAttachment) =>
      att.forwardedSnapshotIndex === undefined
        ? ''
        : multiSnapshot ? ` (forwarded #${att.forwardedSnapshotIndex})` : ' (forwarded)';

    const inlineCap = this.attachmentInlineMaxBytes;
    const blocks: ContentBlock[] = [];
    for (const att of attachments) {
      const ct = (att.contentType || '').toLowerCase();
      const isImage = ct.startsWith('image/');
      const isText =
        ct.startsWith('text/') ||
        TEXT_EXT.test(att.name) ||
        (att.contentType === null && att.size > 0 && att.size <= MAX_TEXT_BYTES);
      try {
        if (!isImage && isText && att.size > inlineCap) {
          // Declared size is already over the cap — no fetch at all. (A
          // misdeclared small size still gets caught below on actual bytes.)
          blocks.push(textContent(
            `[attachment: ${att.name}${fwd(att)} (${fmt(att.size)}) over the ${fmt(inlineCap)} inline cap — not inlined: ${att.url}]`,
          ));
          dbg('attachment:over-inline-cap', { name: att.name, declaredSize: att.size, cap: inlineCap });
        } else if ((isImage || isText) && att.size > fetchBudgetLeft) {
          blocks.push(textContent(
            `[attachment: ${att.name}${fwd(att)} (${fmt(att.size)}) not inlined — message attachment budget exhausted: ${att.url}]`,
          ));
          dbg('attachment:budget-exhausted', { name: att.name, size: att.size, budgetLeft: fetchBudgetLeft });
        } else if (isImage) {
          if (att.size > IMAGE_FETCH_CEILING) {
            blocks.push(textContent(`[image attachment "${att.name}"${fwd(att)} (${fmt(att.size)}) too large to fetch — ${att.url}]`));
          } else {
            fetchBudgetLeft -= att.size;
            const res = await fetchWithTimeout(att.url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const raw = Buffer.from(await res.arrayBuffer());
            // Downsample to model-max on ingest (resize to ~1568px long edge,
            // re-encode under the inline cap). This also rescues images that
            // would previously be dropped for being over the old 4MB cap.
            const norm = await normalizeImageForInference(raw, att.contentType);
            if (norm) {
              blocks.push({ type: 'image', data: norm.data, mimeType: norm.mimeType } as ContentBlock);
              blocks.push(textContent(`[image attachment: ${att.name}${fwd(att)}]`));
            } else {
              blocks.push(textContent(`[image attachment "${att.name}"${fwd(att)} (${fmt(att.size)}) could not be inlined — ${att.url}]`));
            }
          }
        } else if (isText) {
          // Budget is charged from bytes actually consumed, not Discord's
          // advisory size — the capped read bounds the overdraft past the
          // pre-check above to at most cap+1.
          const { text, overflow, bytesRead } = await fetchTextCapped(att.url, inlineCap);
          fetchBudgetLeft -= bytesRead;
          if (overflow) {
            // Declared size said it fit; the wire said otherwise. The cap is
            // a bound on actual bytes, so this degrades to a note too.
            blocks.push(textContent(
              `[attachment: ${att.name}${fwd(att)} (over the ${fmt(inlineCap)} inline cap; declared ${fmt(att.size)}) — not inlined: ${att.url}]`,
            ));
            dbg('attachment:over-inline-cap', {
              name: att.name,
              declaredSize: att.size,
              cap: inlineCap,
              misdeclared: true,
            });
          } else {
            blocks.push(textContent(`[attachment: ${att.name}${fwd(att)} (${fmt(att.size)})]\n${text}`));
          }
        } else {
          blocks.push(textContent(`[attachment: ${att.name}${fwd(att)} (${ct || 'unknown type'}, ${fmt(att.size)}) — not inlined: ${att.url}]`));
        }
        dbg('attachment', {
          name: att.name,
          contentType: att.contentType,
          size: att.size,
          kind: isImage ? 'image' : isText ? 'text' : 'other',
        });
      } catch (err) {
        blocks.push(textContent(`[attachment: ${att.name} — could not fetch (${(err as Error).message}); ${att.url}]`));
        dbg('attachment:failed', { name: att.name, error: (err as Error).message });
      }
    }
    return blocks;
  }

  private async handleDiscordMessage(msg: DiscordMessageData): Promise<void> {
    const conn = this.conn;
    dbg('handleDiscordMessage:enter', {
      msgId: msg.id,
      guildId: msg.guildId,
      channelId: msg.channelId,
      channelName: msg.channelName,
      authorId: msg.authorId,
      isBot: msg.isBot,
      mentions: msg.mentions,
      contentPreview: msg.content.slice(0, 80),
      hasConn: !!conn,
      mcplEnabled: this.mcplEnabled,
      enabledSets: [...this.enabledFeatureSets],
      botUserId: this.discord.botUserId,
    });
    // Drop chx-style `m continue` no-op triggers before any other processing.
    // These leak through messageCreate before they're deleted; if we forwarded
    // them they'd pollute chronicle and (worse) advance the watermark, which
    // could suppress legitimate auto-subscribe + backscroll for the channel.
    if (msg.content.startsWith(CHX_NOOP_PREFIX)) {
      dbg('handleDiscordMessage:drop', { reason: 'chx-noop', msgId: msg.id });
      return;
    }
    if (!conn) { dbg('handleDiscordMessage:drop', { reason: 'no-conn' }); return; }

    if (!this.mcplEnabled) { dbg('handleDiscordMessage:drop', { reason: 'mcpl-disabled' }); return; } // No push events in MCP-only mode

    if (!isEnabled('discord.messaging', this.enabledFeatureSets)) {
      dbg('handleDiscordMessage:drop', { reason: 'discord.messaging-disabled', enabled: [...this.enabledFeatureSets] });
      return;
    }

    // Muted channel: drop everything — ambient AND mentions/replies — before the
    // mention/auto-subscribe logic below, so a muted channel can neither wake the
    // agent nor auto-subscribe it back in.
    if (this.isChannelMuted(msg.channelId)) {
      dbg('handleDiscordMessage:drop', { reason: 'muted', channelId: msg.channelId });
      return;
    }

    // Direct address (mention or DM) always reaches Lena. For ambient
    // (non-direct) messages, only forward when the channel is in her
    // subscription set — otherwise she'd get unbounded context noise
    // from every channel the bot can see. The wake decision is then
    // left to the host's gate policy via the `isMention`/`isDM` flags
    // we attach below; ambient deliveries enter chronicle with
    // `behavior: skip` (context yes, wake no).
    const botId = this.discord.botUserId;
    const isDM = msg.guildId === null;
    // Granular address signals. We expose these separately in the event
    // metadata so the host's wake gate can compose intentional policies —
    // notably: let a *bot* activate this bot only by an explicit @mention,
    // never by a mere reply. That breaks auto-reply loops between two bots
    // (a reply is structural; an @mention is deliberate) while humans keep
    // waking the bot via reply or mention as before.
    const isExplicitMention =
      (botId !== null && msg.mentions.includes(botId)) || msg.mentionsBotRole === true;
    // Discord's "ping replied user" toggle controls only whether the bot
    // appears in msg.mentions; the reply itself is addressed to the bot
    // either way.
    const isReplyToBot = botId !== null && msg.replyToUserId === botId;
    const isBot = msg.isBot;
    // `isMention` (explicit OR reply) is retained for subscription-bypass /
    // backward compatibility only — the wake decision uses the granular
    // flags above via the gate.
    const isMention = isExplicitMention || isReplyToBot;
    if (!this.shouldEnterContext(msg.channelId, { isMention, isDM })) {
      // If we're tracking this channel's missed-ambient (i.e. it was
      // unsubscribed), tally what we're dropping so the agent can ask later.
      // Skip the bot's own messages and chx no-op triggers (never "missed").
      this.ensureWatermarkLoaded();
      const tally = this.missedTally.get(msg.channelId);
      if (
        tally &&
        msg.authorId !== botId &&
        !msg.content.startsWith(CHX_NOOP_PREFIX)
      ) {
        tally.messages += 1;
        tally.characters += msg.cleanContent.length;
        tally.talliedThrough = msg.id;
        this.saveWatermark();
      }
      dbg('handleDiscordMessage:drop', {
        reason: 'ambient-not-subscribed',
        channelId: msg.channelId,
        channelName: msg.channelName,
        tracked: !!tally,
      });
      return;
    }

    // First-interaction handling is retained only for DMs. Guild mentions in
    // closed channels are deliberately one-shot push events: the host presents
    // an invitation and the agent chooses whether to open, including how much
    // history to request. Receiving a mention must not subscribe implicitly.
    this.ensureSubscriptionsLoaded();
    this.ensureWatermarkLoaded();
    const isFirstInteraction = !this.forwardedWatermark.has(msg.channelId);
    let prefixBlock = '';
    if (isFirstInteraction && isDM) {
      const watermark = this.forwardedWatermark.get(msg.channelId);
      let backscrollMsgs: Awaited<ReturnType<typeof this.discord.fetchHistory>> = [];
      try {
        backscrollMsgs = await this.discord.fetchHistory(msg.channelId, {
          limit: this.backscrollLimitFor(msg.channelId),
          before: msg.id, // never include the triggering message itself
          ...(watermark ? { after: watermark } : {}),
        });
        // discord.js returns newest-first; backscroll reads more naturally
        // oldest-first when Lena scans it as a transcript.
        backscrollMsgs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        // Filter out:
        //  - the bot's own past messages — already in Lena's chronicle as
        //    assistant turns, no need to re-echo as user
        //  - chx-noop `m continue` triggers — same reason we drop them inbound
        backscrollMsgs = backscrollMsgs.filter(
          (m) => m.authorId !== botId && !m.content.startsWith(CHX_NOOP_PREFIX),
        );
      } catch (err) {
        dbg('backscroll:fetch-failed', {
          channelId: msg.channelId,
          error: (err as Error).message,
        });
      }

      const blocks: string[] = [];
      // DMs have no subscription semantics. Give the agent an explicit reply
      // affordance on the first message from a person.
      blocks.push(
        `<system>Direct message from @${msg.authorName} (user id ${msg.authorId}). ` +
          `To reply, use send_dm("${msg.authorName}") — or send_dm("${msg.authorId}") if the ` +
          `name is ambiguous. DMs always reach you; there is nothing to subscribe to.</system>`,
      );
      if (backscrollMsgs.length > 0) {
        const attrs: string[] = [];
        if (msg.channelName) attrs.push(`channel="#${msg.channelName}"`);
        if (msg.guildName) attrs.push(`guild=${JSON.stringify(msg.guildName)}`);
        else if (isDM) attrs.push('dm="true"');
        attrs.push(`count="${backscrollMsgs.length}"`);
        const open = `<backscroll ${attrs.join(' ')}>`;
        const lines = backscrollMsgs.map((m) => {
          const ts = formatAgentDateTime(m.timestamp, AGENT_TIME_ZONE, AGENT_TIMESTAMP_STYLE);
          const att = m.attachments && m.attachments.length > 0
            ? ` [attachments: ${m.attachments.map((a) => a.name).join(', ')}]`
            : '';
          return `${ts ? `[${ts}] ` : ''}${m.authorName}: ${m.cleanContent}${att}${this.renderReactionState(m.reactions)}`;
        });
        blocks.push([open, ...lines, '</backscroll>'].join('\n'));
      }
      if (blocks.length > 0) {
        prefixBlock = blocks.join('\n') + '\n';
        dbg('backscroll:emitted', {
          channelId: msg.channelId,
          backscrollCount: backscrollMsgs.length,
          autoSubscribed: false,
        });
      }
    }

    const guildId = msg.guildId ?? 'dm';
    const channelMcplId = mcplChannelId(guildId, msg.channelId);
    const channelIsOpen = this.channelManager.isOpen(channelMcplId);
    dbg('handleDiscordMessage:forwarding', {
      channelMcplId,
      channelIsOpen,
      path: channelIsOpen ? 'channels/incoming' : 'push/event',
    });

    // discord.js's `cleanContent` resolves <@id> / <@&role> / <#channel>
    // mentions to @username / @role / #channel — always use that in the
    // rendered body so Lena never sees raw <@123456789> blobs.
    //
    // For the location header (which channel/guild we're in), only prepend
    // it when the message's channel differs from the last communication
    // channel (compare BEFORE updating the tracker). Outbound sends also
    // advance lastChannelId via markOutboundSend, so an inbound after Lena
    // sent elsewhere correctly gets a fresh header back to her original
    // conversation.
    const contextChanged = this.lastChannelId !== msg.channelId;
    let location = '';
    if (contextChanged) {
      const locationParts: string[] = [];
      if (msg.channelName) locationParts.push(`#${msg.channelName}`);
      if (msg.threadName) locationParts.push(`thread "${msg.threadName}"`);
      if (msg.guildName) locationParts.push(`in ${msg.guildName}`);
      else if (msg.guildId === null) locationParts.push('DM');
      if (locationParts.length > 0) location = `[${locationParts.join(' ')}] `;
    }
    // A reply edge is part of the message's meaning, not hidden routing metadata.
    // Render a bounded structural marker into model-visible content so a nearby
    // "go ahead" cannot be mistaken for authorization addressed to the agent.
    // Keep the parent id even when Discord could not supply the author.
    const replyMarker = msg.replyToId
      ? `[replying to ${msg.replyToUserName ? `@${msg.replyToUserName}` : 'unknown author'}]\n`
      : '';
    const renderedContent = `${prefixBlock}${replyMarker}${location}${msg.authorName}: ${msg.cleanContent}`;
    // Advance the watermark so future backscroll on this channel doesn't
    // re-include this message. Set regardless of which forwarding path we
    // take below (channels/incoming vs push/event) — what matters is that
    // we forwarded it. Persist it (and the DM channel, if this is one) so the
    // reconnect catch-up sweep has a current anchor after a restart.
    this.forwardedWatermark.set(msg.channelId, msg.id);
    if (isDM) {
      this.dmChannelIds.add(msg.channelId);
      // Register the DM as a real channel descriptor so channel_open /
      // isOpen resolve it. The message author IS the recipient (bot's own
      // outbound doesn't come through here), so their name labels it.
      this.registerAndNotifyNew([
        toDmDescriptor(
          msg.channelId,
          msg.authorName,
          false,
          this.backscrollLimitFor(msg.channelId),
          msg.authorId,
        ),
      ]);
    }
    this.saveWatermark();
    // Update sticky-reply state: this inbound is now the "last
    // communication" for auto-reply routing, and the message we'd
    // replyTo on the next auto-send.
    this.lastChannelId = msg.channelId;
    this.lastInboundMessageId = msg.id;

    // Fetch + inline any attachments (images, text files) so the agent sees
    // them. Built once and appended to whichever forwarding path we take.
    const attachmentBlocks =
      msg.attachments.length > 0 ? await this.buildAttachmentBlocks(msg.attachments) : [];

    // MCPL RFC-001 event tags — emit reserved chat:* core (umbrellas included,
    // so no host-side implication expansion is needed) derived from the address
    // flags computed above. The host's wake gate routes on these.
    const eventTags: string[] = (() => {
      const t = new Set<string>();
      if (isExplicitMention) t.add('chat:mention');
      if (isReplyToBot) t.add('chat:reply');
      if (isDM) { t.add('chat:dm'); t.add('chat:private'); }
      t.add(isMention || isDM ? 'chat:addressed' : 'chat:ambient');
      t.add(isBot ? 'chat:from-bot' : 'chat:from-human');
      if (msg.threadId) t.add('chat:thread');
      for (const a of msg.attachments) {
        const ct = (a.contentType || '').toLowerCase();
        if (ct.startsWith('image/')) t.add('chat:has-image');
        else if (ct.startsWith('audio/')) t.add('chat:has-audio');
        else t.add('chat:has-file');
      }
      return [...t];
    })();

    // If this channel is open, use channels/incoming
    if (channelIsOpen) {
      const incomingParams: ChannelsIncomingParams = {
        messages: [{
          channelId: channelMcplId,
          messageId: msg.id,
          threadId: msg.threadId,
          author: { id: msg.authorId, name: msg.authorName },
          timestamp: msg.timestamp.toISOString(),
          content: [textContent(renderedContent), ...attachmentBlocks],
          metadata: {
            mentions: msg.mentions,
            replyTo: msg.replyToId,
            replyToAuthorId: msg.replyToUserId ?? undefined,
            replyToAuthorName: msg.replyToUserName ?? undefined,
            channelName: msg.channelName,
            guildName: msg.guildName,
            threadName: msg.threadName,
            rawContent: msg.content,
            isMention,
            isExplicitMention,
            isReplyToBot,
            isBot,
            isDM,
          },
          tags: eventTags,
        }],
      };

      try {
        await conn.sendRequest(method.CHANNELS_INCOMING, incomingParams);
        dbg('handleDiscordMessage:sent', { method: 'channels/incoming', channelMcplId });
      } catch (err) {
        console.error('[discord-mcpl] channels/incoming failed:', (err as Error).message);
        dbg('handleDiscordMessage:send-failed', { method: 'channels/incoming', error: (err as Error).message });
      }
    } else {
      // Otherwise, use push/event.
      //
      // Closed channel: attach the missed-ambient tally (when tracked) so the
      // host's closed-channel invitation can show what staying out has cost —
      // "reply without joining" is only an informed choice when the invisible
      // traffic is visible as a number (2026-08-05: Sol answered four
      // #architecture mentions over four days while the follow-ups to her own
      // replies fell into the tally, with nothing surfacing that fact).
      // Counts exclude this (addressed) message and all prior mentions/DMs —
      // those were delivered.
      const missed = this.missedTally.get(msg.channelId);
      const pushParams: PushEventParams = {
        featureSet: 'discord.messaging',
        eventId: `discord_msg_${msg.id}`,
        timestamp: msg.timestamp.toISOString(),
        origin: {
          source: 'discord',
          messageId: msg.id,
          guildId: msg.guildId,
          guildName: msg.guildName,
          channelId: msg.channelId,
          // The MCPL composite channel id (`discord:{guild|dm}:{channel}`) — the
          // form the host registers and routes replies to. Raw `channelId` above
          // is Discord-internal; DMs especially only ever arrive via push/event
          // (channel closed), so without this the host can't route a reply back
          // to the DM (item-3 redux, DM sub-case).
          mcplChannelId: channelMcplId,
          channelName: msg.channelName,
          threadId: msg.threadId,
          threadName: msg.threadName,
          authorId: msg.authorId,
          authorName: msg.authorName,
          replyTo: msg.replyToId,
          replyToAuthorId: msg.replyToUserId ?? undefined,
          replyToAuthorName: msg.replyToUserName ?? undefined,
          isMention,
          isExplicitMention,
          isReplyToBot,
          isBot,
          isDM,
          ...(missed
            ? { missedMessages: missed.messages, missedCharacters: missed.characters }
            : {}),
        } as Record<string, unknown>,
        tags: eventTags, // MCPL RFC-001 — the host routes/gates on these
        payload: {
          content: [textContent(renderedContent), ...attachmentBlocks],
        },
      };

      try {
        await conn.sendRequest(method.PUSH_EVENT, pushParams);
        dbg('handleDiscordMessage:sent', { method: 'push/event', channelMcplId });
      } catch (err) {
        console.error('[discord-mcpl] push/event failed:', (err as Error).message);
        dbg('handleDiscordMessage:send-failed', { method: 'push/event', error: (err as Error).message });
      }
    }
  }
}
