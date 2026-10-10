/**
 * Discord.js adapter for the Discord MCPL server.
 * Wraps discord.js, provides a clean callback + method interface.
 *
 * Based on patterns from agent-framework/src/modules/discord/discord-js-client.ts
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  TextChannel,
  DMChannel,
  ChannelType,
  MessageType,
  AttachmentBuilder,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Role,
  type User,
  type ChatInputCommandInteraction,
  type ApplicationCommandDataResolvable,
} from 'discord.js';
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { dbg } from './debug-log.js';

import {
  buildCandidates,
  formatChannelLabel,
  parseChannelRef,
  resolveChannelName,
  type ResolveResult,
} from './channel-names.js';
import { splitForDiscord } from './utils/discord-strings.js';

/** Maximum attachments Discord accepts on a single message. */
const MAX_DISCORD_ATTACHMENTS = 10;

/** Cap on members returned by listChannelMembers — a large guild's #general
 *  is visible to thousands; the agent gets the first page plus the total. */
const MEMBER_LIST_CAP = 200;

/** A file the agent wants to upload, read from a local path on the host. */
export interface OutgoingFile {
  /** Absolute local filesystem path to the file to upload. */
  path: string;
  /** Optional display filename (defaults to the basename of `path`). */
  name?: string;
  /** Optional alt-text / description shown for accessibility. */
  description?: string;
}

/**
 * Turn `OutgoingFile[]` specs into discord.js `AttachmentBuilder`s, validating
 * each path up front so a bad path yields a clear error rather than an opaque
 * discord.js failure mid-send. discord.js reads the path lazily at send time.
 */
function buildAttachments(files?: OutgoingFile[]): AttachmentBuilder[] {
  if (!files || files.length === 0) return [];
  if (files.length > MAX_DISCORD_ATTACHMENTS) {
    throw new Error(
      `Too many files: ${files.length} (Discord allows up to ${MAX_DISCORD_ATTACHMENTS} per message)`,
    );
  }
  return files.map((f) => {
    if (!f || typeof f.path !== 'string' || !f.path.trim()) {
      throw new Error('Each file must have a non-empty string "path"');
    }
    if (!existsSync(f.path) || !statSync(f.path).isFile()) {
      throw new Error(`File not found (or not a regular file): ${f.path}`);
    }
    const name = f.name && f.name.trim() ? f.name : basename(f.path);
    const attachment = new AttachmentBuilder(f.path, { name });
    if (f.description) attachment.setDescription(f.description);
    return attachment;
  });
}

// ── Public Types ──

export interface DiscordAdapterConfig {
  token: string;
  guildIds?: string[];
  /** Per-guild channel whitelist. When a guild id has an entry here, only
   *  the listed channel ids (and threads under them) are visible/handled in
   *  that guild. Guilds without an entry are unrestricted. */
  guildChannels?: Record<string, string[]>;
  /** DM user whitelist. When set, incoming DMs are only handled from these
   *  user ids; DMs from anyone else are dropped. Unset = all DMs allowed. */
  dmUsers?: string[];
  adminUsers?: string[];
}

/** A file attached to a Discord message (image, text file, etc.). */
export interface DiscordAttachment {
  id: string;
  /** Filename, e.g. "message.txt" or "screenshot.png". */
  name: string;
  /** Discord CDN URL (signed; expires after a while). */
  url: string;
  /** MIME type Discord reports, e.g. "image/png", "text/plain; charset=utf-8".
   *  Null when Discord doesn't classify it. */
  contentType: string | null;
  /** Size in bytes. */
  size: number;
  /** Set when the attachment rode in on a forwarded snapshot rather than on
   *  the message itself: 1-based index of the carrying snapshot. Lets
   *  delivery markers name the source forward explicitly instead of relying
   *  on array-order inference when a message carries several forwards. */
  forwardedSnapshotIndex?: number;
}

export interface DiscordMessageData {
  id: string;
  /** Raw content, mentions encoded as `<@USER_ID>` etc. */
  content: string;
  /** Content with user / role / channel mentions resolved to human-readable
   *  forms (`@username`, `@role-name`, `#channel-name`). Falls back to raw
   *  content for channel types where discord.js doesn't populate cleanContent. */
  cleanContent: string;
  authorId: string;
  authorName: string;
  isBot: boolean;
  channelId: string;
  /** Channel name (e.g. "general"). `null` for DMs and unnamed channels. */
  channelName: string | null;
  guildId: string | null;
  /** Guild name (e.g. "My Server"). `null` for DMs. */
  guildName: string | null;
  threadId?: string;
  /** Thread name when the message is in a thread. */
  threadName?: string;
  replyToId?: string;
  /** User id of the author of the message this message is in reply to.
   *  Populated for reply messages regardless of whether the sender left
   *  the reply-ping toggle on — Discord includes `referenced_message`
   *  inline in the gateway payload, so this is intent-free and sync.
   *  Used by the gate to treat reply-to-bot as direct address even when
   *  the bot isn't explicitly @-mentioned. */
  replyToUserId?: string | null;
  /** Username of the replied-to author when Discord includes the referenced user. */
  replyToUserName?: string | null;
  mentions: string[];
  /** True when the message mentions the bot's own managed role (@BotName the
   *  ROLE — Discord renders it identically to a user ping and most humans
   *  can't tell which they picked from autocomplete). Found live 2026-07-29:
   *  a role-ping at a resident fell through as ambient and never woke her. */
  mentionsBotRole?: boolean;
  /** Files attached to the message (images, text files, etc.). Empty when none. */
  attachments: DiscordAttachment[];
  /** Emoji reactions on this message at serialization time. Usually empty for a
   *  freshly-created message; populated on fetch. */
  reactions?: ReactionSummary[];
  timestamp: Date;
}

export interface DiscordGuildInfo {
  id: string;
  name: string;
  memberCount: number;
}

export interface DiscordChannelInfo {
  id: string;
  name: string;
  type: 'text' | 'announcement' | 'voice' | 'category' | 'thread' | 'forum' | 'unknown';
  parentId?: string;
  /** Guild-qualified display label, `#name (GuildName)` — the same string
   *  `toDescriptor` produces and the same string the channelId argument
   *  accepts. Returned so listings hand back something PASTEABLE: the
   *  not-found error tells agents to "use list_channels to see what is
   *  addressable", which was only true once this field existed. Both forms are
   *  present on purpose — label to compose a send now, id to store. */
  label: string;
}

/** One member of a channel, as the agent should see them. */
export interface DiscordMemberInfo {
  id: string;
  /** The stable @handle (Discord username). */
  username: string;
  /** Name shown in this channel: server nickname > global display name. */
  displayName: string;
  isBot: boolean;
}

export interface DiscordChannelMembers {
  channelId: string;
  channelName: string | null;
  /** How membership was resolved: everyone who can view a guild channel
   *  (computed permissions over a fully warmed member cache), the JOINED
   *  members of a thread (Discord's own thread-membership notion — a public
   *  thread may be readable by non-joined users with parent access), or the
   *  two parties of a DM. */
  scope: 'guild-channel' | 'thread-joined' | 'dm';
  /** Full member count before the cap was applied. */
  total: number;
  /** Humans first, then bots; alphabetical by display name within each. */
  members: DiscordMemberInfo[];
  /** True when `members` was capped (see MEMBER_LIST_CAP). */
  truncated: boolean;
  /** Scope caveat the agent should see (set for threads). */
  note?: string;
}

export interface HistoryMessage {
  id: string;
  authorId: string;
  authorName: string;
  isBot: boolean;
  /** Raw content (mentions encoded as `<@id>`). */
  content: string;
  /** Content with mentions resolved (@username, #channel, @role). Falls back
   *  to raw content for channel types where discord.js doesn't populate it. */
  cleanContent: string;
  /** Files attached to the message. Empty when none. */
  attachments: DiscordAttachment[];
  /** True if this message @mentions the bot or is a reply to the bot. Used by
   *  the reconnect catch-up sweep to pick out missed mentions. Reply-to-bot is
   *  best-effort for historical fetches: `mentions.repliedUser` is only present
   *  when the reference resolves, so explicit @mentions are the reliable
   *  signal here. */
  mentionsBot: boolean;
  /** Emoji reactions currently on this message. Empty when none. Populated on
   *  fetch (history/around); reactions ride along with the message so they are
   *  visible passively, without ever waking the agent. */
  reactions?: ReactionSummary[];
  timestamp: Date;
}

/** One emoji reaction bucket on a message. */
export interface ReactionSummary {
  /** Human-readable form: the unicode char, or ':name:' for a custom emoji. */
  emoji: string;
  /** Custom-emoji snowflake id, or null for a unicode emoji. */
  emojiId: string | null;
  /** Token to reuse this emoji in message content ('<:name:id>' / '<a:name:id>'),
   *  or the unicode char itself. */
  token: string;
  /** Number of users who added this reaction. */
  count: number;
  /** True if the bot itself is one of the reactors. */
  me: boolean;
}

/** A custom (server) emoji the bot can see and use. */
export interface DiscordEmojiInfo {
  id: string;
  name: string;
  animated: boolean;
  /** Paste into message content to render it ('<:name:id>' / '<a:name:id>'). */
  token: string;
  /** Pass to add_reaction to react with it (':name:'). */
  reactionArg: string;
  guildId: string;
  guildName: string | null;
}

/** An incoming Discord reaction (add or remove) surfaced to the server. */
export interface ReactionEvent {
  action: 'add' | 'remove';
  channelId: string;
  messageId: string;
  guildId: string | null;
  /** Human-readable emoji: the unicode char, or ':name:' for a custom emoji. */
  emoji: string;
  emojiId: string | null;
  /** Token to reuse the emoji ('<:name:id>' / '<a:name:id>'), or the unicode char. */
  token: string;
  /** Who added/removed the reaction. */
  userId: string;
  userName: string;
  /** True if the reacted-to message was authored by the bot (a reaction to us). */
  onOwnMessage: boolean;
  /** Author id of the reacted-to message, if resolvable. */
  messageAuthorId: string | null;
  /** One-line snippet of the reacted-to message's text, or null when it has
   *  none (attachment/embed-only, or the message couldn't be resolved). */
  messageSnippet: string | null;
  timestamp: Date;
}

/** Render custom-emoji tokens ('<:name:id>' / '<a:name:id>') down to ':name:'
 *  so message text reads legibly for the model. Unicode emoji are untouched. */
function renderCustomEmojis(text: string): string {
  return text.replace(/<a?:(\w+):\d+>/g, (_full, name: string) => `:${name}:`);
}

/** Cap for the reacted-to-message snippet carried on reaction events. */
const REACTION_SNIPPET_MAX = 80;

/** One-line snippet of a message body for reaction events: custom-emoji
 *  tokens rendered down, whitespace collapsed, capped at REACTION_SNIPPET_MAX.
 *  Null when there is no text to show (attachment/embed-only messages) — the
 *  caller falls back to the id-only rendering in that case. */
export function buildReactionSnippet(text: string | null | undefined): string | null {
  if (!text) return null;
  const collapsed = renderCustomEmojis(text).replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.length > REACTION_SNIPPET_MAX
    ? `${collapsed.slice(0, REACTION_SNIPPET_MAX - 1)}…`
    : collapsed;
}

/** The slice of a discord.js MessageSnapshot that forward rendering reads.
 *  `attachments` is a discord.js Collection at runtime; `values()` is optional
 *  here so tests and older gateway shapes can pass a bare `{ size }`. */
interface ForwardSnapshot {
  content?: string | null;
  attachments?: { size: number; values?(): IterableIterator<unknown> } | null;
  embeds?: { length: number } | null;
}

/** Render a forwarded message's snapshots into visible text. Discord forwards
 *  carry their body in `messageSnapshots` (discord.js ≥14.16), not `content`,
 *  so without this a bare forward reaches the agent as an empty message.
 *  Attachment/embed-only snapshots get a bracketed note instead of silence.
 *  Snapshots have no `cleanContent`, so mention ids stay raw, but custom-emoji
 *  tokens are rendered down to ':name:' like everywhere else. */
export function buildForwardedContent(
  baseContent: string,
  snapshots: Iterable<ForwardSnapshot>,
): string {
  const parts: string[] = [];
  for (const snap of snapshots) {
    const text =
      typeof snap.content === 'string' && snap.content.trim().length > 0
        ? renderCustomEmojis(snap.content)
        : null;
    const attachmentCount = snap.attachments?.size ?? 0;
    const notes: string[] = [];
    if (attachmentCount > 0) {
      notes.push(`[${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}]`);
    }
    if (!text && (snap.embeds?.length ?? 0) > 0) notes.push('[embed]');
    const body = [text, ...notes].filter(Boolean).join(' ');
    parts.push(`[forwarded message] ${body || '[no text content]'}`);
  }
  if (parts.length === 0) return baseContent;
  const forwarded = parts.join('\n');
  return baseContent.trim().length > 0 ? `${baseContent}\n${forwarded}` : forwarded;
}

/** Resolve a message's visible body: `cleanContent` when populated (raw
 *  content otherwise — DMs and partial channels can leave it empty), with any
 *  forwarded snapshots rendered in, and Discord SYSTEM messages (member
 *  joins, boosts, pins…) synthesized from `message.type` the way the human
 *  client renders them — they carry no content, so forwarding them raw gave
 *  the agent literally empty messages ("Bob: "). Shared by the live
 *  convertMessage path and both history paths (fetchHistory / fetchAround),
 *  so neither forwards nor system messages can regress to empty on
 *  backscroll or the reconnect catch-up sweep — history replays missed
 *  messages through fetchHistory, not the live path. */
export function resolveVisibleContent(m: {
  content: string;
  cleanContent?: string | null;
  messageSnapshots?: { size: number; values(): Iterable<ForwardSnapshot> } | null;
  type?: MessageType;
}): string {
  let base =
    typeof m.cleanContent === 'string' && m.cleanContent.length > 0
      ? m.cleanContent
      : m.content;
  if (base.length === 0 && m.type !== undefined && m.type !== MessageType.Default) {
    base = systemMessageText(m.type);
  }
  return m.messageSnapshots && m.messageSnapshots.size > 0
    ? buildForwardedContent(base, m.messageSnapshots.values())
    : base;
}

/** Summarise the reactions on a discord.js message. Custom emoji become ':name:'
 *  (full token preserved on `token`); unicode emoji pass through. */
function extractReactions(m: Message): ReactionSummary[] {
  const cache = m.reactions?.cache;
  if (!cache || cache.size === 0) return [];
  return [...cache.values()].map((r) => {
    const e = r.emoji;
    const custom = Boolean(e.id);
    return {
      emoji: custom ? `:${e.name}:` : e.name ?? '?',
      emojiId: e.id ?? null,
      token: custom ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : e.name ?? '',
      count: r.count,
      me: r.me,
    };
  });
}

/** A possible mention target gathered from the guild/DM: a user or a role,
 *  with the case-insensitive names it can be addressed by. */
export interface MentionCandidate {
  id: string;
  aliases: string[];
  kind: 'user' | 'role';
}

/** Rewrite human-readable `@handle` tokens in `content` to Discord ping syntax
 *  — `<@id>` for users, `<@&id>` for roles — using the supplied candidates.
 *
 *  Pure (no Discord I/O) so it can be unit-tested. Rules:
 *    - `@everyone` / `@here` are left as-is (Discord handles them natively).
 *    - Users take priority on a name collision; a role is only used when no
 *      user matches that handle.
 *    - Only an unambiguous single match resolves; zero or multiple matches
 *      leave the original text untouched (fail to ping over mis-ping).
 *    - Single-token handles only ([A-Za-z0-9_.-]); multi-word names won't
 *      resolve, matching the original behaviour. */
export function applyMentionCandidates(
  content: string,
  candidates: MentionCandidate[],
): string {
  if (candidates.length === 0) return content;
  return content.replace(/@([A-Za-z0-9_.][A-Za-z0-9_.-]*)/g, (whole, handle) => {
    const lower = String(handle).toLowerCase();
    if (lower === 'everyone' || lower === 'here') return whole;
    const matches = (kind: 'user' | 'role') =>
      candidates.filter(
        (c) => c.kind === kind && c.aliases.some((a) => a.toLowerCase() === lower),
      );
    const users = matches('user');
    if (users.length === 1) return `<@${users[0].id}>`;
    if (users.length === 0) {
      const roles = matches('role');
      if (roles.length === 1) return `<@&${roles[0].id}>`;
    }
    return whole;
  });
}

// ── Adapter ──

export class DiscordAdapter {
  private client: Client;

  /** The underlying discord.js client, for subsystems needing gateway-adjacent
   *  state this facade doesn't wrap (voice adapters). */
  get rawClient(): Client {
    return this.client;
  }
  private token: string;
  private guildIds?: string[];
  private guildChannels?: Map<string, Set<string>>;
  private dmUsers?: Set<string>;
  adminUsers: Set<string> = new Set();
  private slashCommandHandler?: (interaction: ChatInputCommandInteraction) => void;
  private guildCommandDefs?: ApplicationCommandDataResolvable[];

  private messageHandler?: (msg: DiscordMessageData) => void;
  private editHandler?: (channelId: string, messageId: string, newContent: string, isDM: boolean) => void;
  private deleteHandler?: (channelId: string, messageId: string, isDM: boolean) => void;
  private reactionHandler?: (ev: ReactionEvent) => void;
  private readyHandler?: () => void;
  private channelCreateHandler?: (guildId: string, channel: DiscordChannelInfo) => void;
  private channelDeleteHandler?: (guildId: string, channelId: string) => void;
  private guildCreateHandler?: (
    guildId: string,
    guildName: string,
    channels: DiscordChannelInfo[],
  ) => void;
  private channelAvailableHandler?: (guildId: string, channel: DiscordChannelInfo) => void;

  constructor(config: DiscordAdapterConfig) {
    this.token = config.token;
    this.guildIds = config.guildIds;
    if (config.guildChannels) {
      this.guildChannels = new Map(
        Object.entries(config.guildChannels).map(([g, chans]) => [g, new Set(chans)]),
      );
    }
    if (config.dmUsers?.length) {
      this.dmUsers = new Set(config.dmUsers);
    }
    if (config.adminUsers?.length) {
      for (const adminUserId of config.adminUsers) {
        this.adminUsers.add(adminUserId);
      }
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
        // Privileged. Must also be enabled in the Discord Developer Portal
        // under Bot → Privileged Gateway Intents. Required for:
        //  - guild.members.fetch() to receive member chunks (otherwise
        //    the no-arg fetch promise hangs forever, since Discord never
        //    sends GUILD_MEMBERS_CHUNK to a client that didn't subscribe)
        //  - GUILD_MEMBER_ADD/UPDATE/REMOVE gateway events to keep the
        //    cache fresh as people join, change nicknames, or leave.
        // Without it, `@name` → `<@id>` resolution only works for members
        // who've recently messaged (cached opportunistically via
        // messageCreate); inactive members can't be pinged by name.
        GatewayIntentBits.GuildMembers,
        // Non-privileged. Populates guild.emojis for list_emojis and keeps the
        // custom-emoji cache fresh (emojiCreate/Update/Delete).
        GatewayIntentBits.GuildEmojisAndStickers,
        // Non-privileged. Required for voice output (src/voice.ts):
        // joinVoiceChannel's handshake needs the voice-state cache. Harmless
        // when voice is unconfigured.
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
    });

    this.setupEvents();
  }

  // ── Lifecycle ──

  async connect(): Promise<void> {
    // Resolve only once the gateway READY has populated guilds.cache, so
    // callers (e.g. registerDiscordChannels) don't enumerate an empty cache.
    await new Promise<void>((resolve, reject) => {
      if (this.client.isReady()) { resolve(); return; }
      this.client.once('ready', () => resolve());
      this.client.login(this.token).catch(reject);
    });
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
  }

  get isConnected(): boolean {
    return this.client.isReady();
  }

  get botUserId(): string | null {
    return this.client.user?.id ?? null;
  }

  // ── Callback Registration ──

  onMessage(handler: (msg: DiscordMessageData) => void): void {
    this.messageHandler = handler;
  }

  onMessageEdit(handler: (channelId: string, messageId: string, newContent: string, isDM: boolean) => void): void {
    this.editHandler = handler;
  }

  onMessageDelete(handler: (channelId: string, messageId: string, isDM: boolean) => void): void {
    this.deleteHandler = handler;
  }

  /** Register a handler for incoming Discord reactions (add/remove). The server
   *  decides per-channel whether to surface these; the adapter always emits. */
  onReaction(handler: (ev: ReactionEvent) => void): void {
    this.reactionHandler = handler;
  }

  onReady(handler: () => void): void {
    this.readyHandler = handler;
  }

  /** Handler for slash-command (chat input) interactions. */
  onSlashCommand(handler: (interaction: ChatInputCommandInteraction) => void): void {
    this.slashCommandHandler = handler;
  }

  /**
   * Register guild application (slash) commands on every visible guild
   * (respecting the guild filter). The defs are remembered so newly-joined
   * guilds (guildCreate) get them too. Guild commands update instantly,
   * unlike global commands.
   */
  async registerGuildCommands(commands: ApplicationCommandDataResolvable[]): Promise<void> {
    this.guildCommandDefs = commands;
    for (const guild of this.client.guilds.cache.values()) {
      if (this.guildIds?.length && !this.guildIds.includes(guild.id)) continue;
      try {
        await guild.commands.set(commands);
      } catch (err) {
        console.error(
          `[discord-mcpl] Failed to register commands in guild ${guild.id}:`,
          (err as Error).message,
        );
      }
    }
  }

  /** Snapshot of the active event filters (for filters_get and diffing).
   *  `undefined` fields mean unrestricted. */
  getFilters(): { guildIds?: string[]; guildChannels?: Record<string, string[]>; dmUsers?: string[] } {
    return {
      guildIds: this.guildIds ? [...this.guildIds] : undefined,
      guildChannels: this.guildChannels
        ? Object.fromEntries([...this.guildChannels].map(([g, s]) => [g, [...s]]))
        : undefined,
      dmUsers: this.dmUsers ? [...this.dmUsers] : undefined,
    };
  }

  /** Hot-swap the event filters (guild/channel whitelist + DM whitelist) at
   *  runtime — the fix for "whitelist changes need a full restart". All
   *  filter checks read the instance fields on every event, so the swap takes
   *  effect immediately. Returns the guild-level diff relative to the bot's
   *  actual guild membership so the caller can re-register channels and log.
   *
   *  Newly-allowed guilds the bot is already a member of also get their slash
   *  commands registered here (startup-time registration skipped them while
   *  they were filtered out). */
  updateFilters(filters: {
    guildIds?: string[];
    guildChannels?: Record<string, string[]>;
    dmUsers?: string[];
  }): { addedGuilds: string[]; removedGuilds: string[] } {
    const before = this.guildIds;
    this.guildIds = filters.guildIds?.length ? [...filters.guildIds] : undefined;
    this.guildChannels =
      filters.guildChannels && Object.keys(filters.guildChannels).length
        ? new Map(Object.entries(filters.guildChannels).map(([g, chans]) => [g, new Set(chans)]))
        : undefined;
    this.dmUsers = filters.dmUsers?.length ? new Set(filters.dmUsers) : undefined;

    const allowed = (ids: string[] | undefined, gid: string): boolean =>
      !ids?.length || ids.includes(gid);
    const addedGuilds: string[] = [];
    const removedGuilds: string[] = [];
    for (const guild of this.client.guilds.cache.values()) {
      const was = allowed(before, guild.id);
      const now = allowed(this.guildIds, guild.id);
      if (!was && now) addedGuilds.push(guild.id);
      else if (was && !now) removedGuilds.push(guild.id);
    }

    if (this.guildCommandDefs) {
      for (const gid of addedGuilds) {
        this.client.guilds.cache
          .get(gid)
          ?.commands.set(this.guildCommandDefs)
          .catch((err: Error) => {
            console.error(
              `[discord-mcpl] Failed to register commands in newly-allowed guild ${gid}:`,
              err.message,
            );
          });
      }
    }
    return { addedGuilds, removedGuilds };
  }

  onChannelCreate(handler: (guildId: string, channel: DiscordChannelInfo) => void): void {
    this.channelCreateHandler = handler;
  }

  onChannelDelete(handler: (guildId: string, channelId: string) => void): void {
    this.channelDeleteHandler = handler;
  }

  /** Fired when the bot joins a new guild after startup. The handler receives
   *  every text channel currently visible to the bot in that guild, so the
   *  server can register them with the host the same way it does at boot. */
  onGuildCreate(
    handler: (guildId: string, guildName: string, channels: DiscordChannelInfo[]) => void,
  ): void {
    this.guildCreateHandler = handler;
  }

  /** Fired when the bot gains visibility into a *pre-existing* channel — e.g.
   *  a permission overwrite grants View Channel on a private channel the bot
   *  was just added to. (channelCreate doesn't fire for channels that already
   *  existed; this fills that gap.) */
  onChannelAvailable(handler: (guildId: string, channel: DiscordChannelInfo) => void): void {
    this.channelAvailableHandler = handler;
  }

  // ── Operations ──

  async sendMessage(
    channelId: string,
    content: string,
    options?: { replyTo?: string; files?: OutgoingFile[] },
  ): Promise<{ messageId: string }> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      throw new Error(`Channel ${channelId} not found or not a text channel`);
    }
    const resolved = await this.resolveOutgoingMentions(channel, content);
    const attachments = buildAttachments(options?.files);
    const chunks = splitForDiscord(resolved);
    // Files-only message (no text): still send one message carrying the files.
    if (chunks.length === 0 && attachments.length > 0) chunks.push('');
    let lastId = '';
    for (let i = 0; i < chunks.length; i++) {
      // Attach files to the LAST chunk so they render after the full text.
      const isLast = i === chunks.length - 1;
      const sent = await (channel as TextChannel | DMChannel).send({
        content: chunks[i] || undefined,
        reply: i === 0 && options?.replyTo ? { messageReference: options.replyTo } : undefined,
        files: isLast && attachments.length > 0 ? attachments : undefined,
      });
      lastId = sent.id;
    }
    return { messageId: lastId };
  }

  /** Resolve a DM recipient that may be a numeric user ID **or** a
   *  username / handle. A snowflake (17–20 digits) passes through unchanged.
   *  Otherwise the bot's cached guild members across all shared servers — plus
   *  the recipients of any open DM channels (so a reply to someone who DMed the
   *  bot resolves even with no shared server) — are searched case-insensitively
   *  against nickname / global name / display name / username for a UNIQUE
   *  match. The member cache is warmed at startup and kept current by gateway
   *  events — the same source `resolveOutgoingMentions` uses for @handle pings.
   *  Throws a clear error on no match or ambiguity so the caller knows to pass a
   *  numeric ID. */
  private async resolveRecipientId(recipient: string): Promise<string> {
    const raw = recipient.trim().replace(/^@/, '');
    if (/^\d{17,20}$/.test(raw)) return raw; // already a Discord user ID
    const target = raw.toLowerCase();
    const selfId = this.client.user?.id;
    const matches = new Map<string, string>(); // id -> username (dedup across guilds)
    for (const guild of this.client.guilds.cache.values()) {
      for (const member of guild.members.cache.values() as IterableIterator<GuildMember>) {
        if (member.user.id === selfId || member.user.bot) continue;
        const aliases = [
          member.nickname,
          (member.user as User & { globalName?: string | null }).globalName,
          member.user.displayName,
          member.user.username,
        ];
        if (aliases.some((a) => typeof a === 'string' && a.toLowerCase() === target)) {
          matches.set(member.user.id, member.user.username);
        }
      }
    }
    // Also match the recipients of open DM channels. Someone who DMed the bot
    // can share no guild with it, so the guild-member scan above can't see them —
    // but we hold an open DM channel whose recipient we CAN resolve by name. This
    // makes a name-based reply to a DM sender work without a shared server.
    for (const channel of this.client.channels.cache.values()) {
      const recipient = (channel as { recipient?: User }).recipient;
      if (!recipient || recipient.id === selfId || recipient.bot) continue;
      const aliases = [
        (recipient as User & { globalName?: string | null }).globalName,
        recipient.displayName,
        recipient.username,
      ];
      if (aliases.some((a) => typeof a === 'string' && a.toLowerCase() === target)) {
        matches.set(recipient.id, recipient.username);
      }
    }
    if (matches.size === 1) return [...matches.keys()][0]!;
    if (matches.size === 0) {
      throw new Error(
        `No Discord member matches "${recipient}". Pass a numeric user ID, or the exact ` +
          `@username / display name of someone in a shared server.`,
      );
    }
    throw new Error(
      `"${recipient}" is ambiguous — ${matches.size} members match ` +
        `(${[...matches.values()].slice(0, 5).join(', ')}). Use the numeric user ID.`,
    );
  }

  async sendDM(
    userId: string,
    content: string,
    options?: { files?: OutgoingFile[] },
  ): Promise<{ messageId: string; channelId: string }> {
    const resolvedId = await this.resolveRecipientId(userId);
    const user = await this.client.users.fetch(resolvedId);
    // For DMs, the only resolvable user is the recipient. We resolve against
    // the DM channel we're about to send to. Return the DM channel ID too so
    // the caller can update sticky-reply state.
    const dm = await user.createDM();
    const resolved = await this.resolveOutgoingMentions(dm, content);
    const attachments = buildAttachments(options?.files);
    const chunks = splitForDiscord(resolved);
    if (chunks.length === 0 && attachments.length > 0) chunks.push('');
    let lastId = '';
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const sent = await user.send({
        content: chunks[i] || undefined,
        files: isLast && attachments.length > 0 ? attachments : undefined,
      });
      lastId = sent.id;
    }
    return { messageId: lastId, channelId: dm.id };
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    const resolved = await this.resolveOutgoingMentions(channel, content);
    await msg.edit(resolved);
  }

  /** Resolve human-readable @handle mentions in outgoing content to Discord's
   *  ping syntax — `<@USER_ID>` for users, `<@&ROLE_ID>` for roles. Lena learns
   *  the @handle form from incoming cleanContent and tends to imitate it, but
   *  Discord only treats the bracket syntax as an actual ping.
   *
   *  User resolution checks (case-insensitive) the channel's guild members
   *  against server nickname, global display name, and username. Role
   *  resolution checks guild role names.
   *
   *  Priority: when a name matches both a user and a role, the USER wins
   *  (people are pinged more often than roles, and a wrong role ping is
   *  noisier). Roles are only used when no user matches that handle.
   *
   *  Skips `@everyone` / `@here` (Discord handles those natively, and so is the
   *  default @everyone role) and the bot's own identity (don't self-ping when
   *  Lena writes about herself in third person). Leaves the original text
   *  untouched when there are zero matches or multiple ambiguous matches —
   *  better to fail to ping than to ping the wrong person/role.
   *
   *  Note: emitting `<@&id>` only produces an actual ping if the role is
   *  mentionable or the bot has the Mention Everyone permission; otherwise it
   *  renders as a styled role link without notifying. That's a Discord-side
   *  permission concern, not a parsing one. */
  private async resolveOutgoingMentions(
    channel: unknown,
    content: string,
  ): Promise<string> {
    const selfId = this.client.user?.id;
    const candidates: MentionCandidate[] = [];

    const ch = channel as { guild?: Guild; recipient?: User };
    if (ch.guild) {
      // The member cache was warmed eagerly at startup (see warmGuildMemberCache).
      // discord.js keeps it current via GUILD_MEMBER_ADD/UPDATE/REMOVE events,
      // so reading the cache here is fast and covers all members of the guild.
      // We deliberately don't call guild.members.fetch() on the hot path —
      // even with the intent, a fresh bulk fetch can be slow and the cache
      // is sufficient.
      for (const member of ch.guild.members.cache.values() as IterableIterator<GuildMember>) {
        if (member.user.id === selfId) continue;
        const aliases = [
          member.nickname,
          (member.user as User & { globalName?: string | null }).globalName,
          member.user.displayName,
          member.user.username,
        ].filter((s): s is string => typeof s === 'string' && s.length > 0);
        candidates.push({ id: member.user.id, aliases, kind: 'user' });
      }
      // Roles. The role cache is gateway-maintained (Guilds intent) like
      // members. Skip the default @everyone role (its id equals the guild id) —
      // Discord pings @everyone natively and that handle is short-circuited.
      for (const role of ch.guild.roles.cache.values() as IterableIterator<Role>) {
        if (role.id === ch.guild.id) continue;
        if (typeof role.name === 'string' && role.name.length > 0) {
          candidates.push({ id: role.id, aliases: [role.name], kind: 'role' });
        }
      }
    } else if (ch.recipient) {
      if (ch.recipient.id !== selfId) {
        const aliases = [
          (ch.recipient as User & { globalName?: string | null }).globalName,
          ch.recipient.displayName,
          ch.recipient.username,
        ].filter((s): s is string => typeof s === 'string' && s.length > 0);
        candidates.push({ id: ch.recipient.id, aliases, kind: 'user' });
      }
    }

    return applyMentionCandidates(content, candidates);
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    await msg.delete();
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    await msg.react(this.resolveReactionEmoji(emoji, msg.guild));
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    const selfId = this.client.user?.id;
    if (!selfId) throw new Error('Discord bot user is not ready');

    const resolved = this.resolveReactionEmoji(emoji, msg.guild);
    const customId = resolved.match(/(?:<a?:\w+:|^\w+:)(\d+)>?$/)?.[1];
    const bare = emoji.trim().replace(/^:+|:+$/g, '');
    const reaction = msg.reactions.cache.find((candidate) =>
      candidate.emoji.id === customId
      || candidate.emoji.name === emoji.trim()
      || candidate.emoji.name === bare
      || candidate.emoji.toString() === emoji.trim());
    if (!reaction) return; // Idempotent: the bot's marker is already absent.
    await reaction.users.remove(selfId);
  }

  /** Turn a caller-supplied emoji into something discord.js `.react()` accepts.
   *  Unicode chars and the full custom forms ('<:name:id>', 'name:id') pass
   *  through untouched; a bare ':name:' or 'name' is resolved to a cached custom
   *  emoji's 'name:id' identifier so custom reactions actually land (a bare name
   *  is not resolvable by discord.js). Falls back to the input unchanged
   *  (treated as unicode) when nothing matches. */
  private resolveReactionEmoji(emoji: string, guild: Guild | null): string {
    const trimmed = emoji.trim();
    if (/^<a?:\w+:\d+>$/.test(trimmed) || /^\w+:\d+$/.test(trimmed)) return trimmed;
    const bare = trimmed.replace(/^:+|:+$/g, '');
    if (/^\w{2,}$/.test(bare)) {
      const found =
        guild?.emojis.cache.find((e) => e.name === bare) ??
        this.client.emojis.cache.find((e) => e.name === bare);
      if (found) return found.identifier;
    }
    return trimmed;
  }

  /** Resolve a (possibly partial) reaction event and hand it to the registered
   *  reaction handler. Skips the bot's own reactions and channels it can't see.
   *  Best-effort: a reaction we can't resolve is dropped, not surfaced as noise. */
  private async handleReactionEvent(
    action: 'add' | 'remove',
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    if (!this.reactionHandler) return;
    try {
      if (user.id === this.client.user?.id) return; // ignore our own reactions
      const full = reaction.partial ? await reaction.fetch() : reaction;
      const msg = full.message;
      const guildId = msg.guildId ?? null;
      const parentId =
        msg.channel && 'parentId' in msg.channel
          ? ((msg.channel as { parentId?: string | null }).parentId ?? null)
          : null;
      if (!this.channelAllowed(guildId, msg.channelId, parentId)) return;
      const reactor = user.partial ? await user.fetch().catch(() => user) : user;
      const e = full.emoji;
      const custom = Boolean(e.id);
      const authorId = msg.author?.id ?? null;
      // The reacted-to message can itself be partial (uncached history);
      // fetch it so the event can carry a content snippet — an id alone is
      // meaningless to the agent. Best-effort: unresolvable → null snippet.
      const resolvedMsg = msg.partial ? await msg.fetch().catch(() => null) : msg;
      const snippetSource = resolvedMsg
        ? ((resolvedMsg as { cleanContent?: string | null }).cleanContent ?? resolvedMsg.content)
        : null;
      this.reactionHandler({
        action,
        channelId: msg.channelId,
        messageId: msg.id,
        guildId,
        emoji: custom ? `:${e.name}:` : e.name ?? '?',
        emojiId: e.id ?? null,
        token: custom ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : e.name ?? '',
        userId: reactor.id,
        userName: reactor.username ?? reactor.id,
        onOwnMessage: authorId != null && authorId === this.client.user?.id,
        messageAuthorId: authorId,
        messageSnippet: buildReactionSnippet(snippetSource),
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('[discord-mcpl] reaction event failed:', (err as Error).message);
    }
  }

  async fetchHistory(
    channelId: string,
    options?: { limit?: number; before?: string; after?: string },
  ): Promise<HistoryMessage[]> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }
    // Discord's REST endpoint caps a single fetch at 100 messages and
    // discord.js does not auto-paginate. To support backscroll requests
    // larger than 100 (we want up to 300), walk backwards page-by-page
    // using `before: <oldest seen so far>` until we have enough or the
    // channel runs out of history. `after` (the watermark) is checked
    // per-message rather than passed to Discord — combining `before`
    // and `after` in the same request narrows to a slice in time but
    // doesn't paginate it, which would let us miss messages.
    const requested = options?.limit ?? 50;
    const after = options?.after;
    const collected: HistoryMessage[] = [];
    let before = options?.before;

    while (collected.length < requested) {
      const pageLimit = Math.min(100, requested - collected.length);
      const fetchOpts: { limit: number; before?: string } = { limit: pageLimit };
      if (before) fetchOpts.before = before;
      const page = await (channel as TextChannel).messages.fetch(fetchOpts);
      if (page.size === 0) break;

      // Sort the page newest → oldest so we can break cleanly when we
      // cross the watermark, and so `before` for the next page is the
      // oldest snowflake in this page.
      const pageArr = [...page.values()].sort((a, b) =>
        b.id.localeCompare(a.id, 'en-US-u-kn-true'),
      );

      let hitWatermark = false;
      for (const m of pageArr) {
        if (after && this.snowflakeLte(m.id, after)) {
          hitWatermark = true;
          break;
        }
        const cleanContent = renderCustomEmojis(resolveVisibleContent(m));
        collected.push({
          id: m.id,
          authorId: m.author.id,
          authorName: m.author.username,
          isBot: m.author.bot,
          content: cleanContent,
          cleanContent,
          attachments: mapAllAttachments(m),
          reactions: extractReactions(m),
          mentionsBot: this.messageMentionsBot(m),
          timestamp: m.createdAt,
        });
        if (collected.length >= requested) break;
      }

      if (hitWatermark) break;
      // Page returned fewer than the asked-for window: out of history.
      if (page.size < pageLimit) break;
      // Next iteration walks further back from the oldest message we got.
      const oldest = pageArr[pageArr.length - 1];
      if (!oldest) break;
      before = oldest.id;
    }

    return collected;
  }

  /** Fetch a window of messages centred on `messageId` — the "scroll to a
   *  message" primitive. Uses Discord's `around` parameter, which returns the
   *  target message plus roughly half the window on either side of it. This is
   *  a SINGLE REST fetch (no pagination) and is therefore capped at 100 by the
   *  Discord API; values above 100 are clamped. The target message itself is
   *  included in the result. Messages are returned oldest → newest so the
   *  window reads naturally as a transcript. */
  async fetchAround(
    channelId: string,
    messageId: string,
    limit = 50,
  ): Promise<HistoryMessage[]> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }
    const pageLimit = Math.min(100, Math.max(1, limit));
    const page = await (channel as TextChannel).messages.fetch({
      around: messageId,
      limit: pageLimit,
    });
    const collected: HistoryMessage[] = [...page.values()].map((m) => {
      const cleanContent = renderCustomEmojis(resolveVisibleContent(m));
      return {
        id: m.id,
        authorId: m.author.id,
        authorName: m.author.username,
        isBot: m.author.bot,
        content: cleanContent,
        cleanContent,
        attachments: mapAllAttachments(m),
        reactions: extractReactions(m),
        mentionsBot: this.messageMentionsBot(m),
        timestamp: m.createdAt,
      };
    });
    // discord.js returns the `around` window unsorted; present oldest → newest.
    collected.sort((a, b) => a.id.localeCompare(b.id, 'en-US-u-kn-true'));
    return collected;
  }

  /** Resolve display metadata for a channel by ID — used by the reconnect
   *  catch-up sweep to label `<missed>` blocks. Returns nulls for an
   *  unresolvable channel rather than throwing. */
  async getChannelMeta(channelId: string): Promise<{
    name: string | null;
    guildId: string | null;
    guildName: string | null;
    isDM: boolean;
  }> {
    const channel = await this.client.channels.fetch(channelId);
    return this.extractChannelMeta(channel);
  }

  /** Cache-only variant of getChannelMeta: gateway-cache lookup, no REST,
   *  synchronous. Null when the channel isn't cached (as opposed to cached
   *  but metadata-sparse) — callers decide whether to fall back to REST. */
  getCachedChannelMeta(channelId: string): {
    name: string | null;
    guildId: string | null;
    guildName: string | null;
    isDM: boolean;
  } | null {
    const channel = this.client.channels.cache.get(channelId);
    if (!channel) return null;
    return this.extractChannelMeta(channel);
  }

  private extractChannelMeta(channel: unknown): {
    name: string | null;
    guildId: string | null;
    guildName: string | null;
    isDM: boolean;
  } {
    if (!channel) return { name: null, guildId: null, guildName: null, isDM: true };
    const c = channel as {
      name?: string;
      guildId?: string | null;
      guild?: { name?: string };
    };
    const guildId = c.guildId ?? null;
    return {
      name: typeof c.name === 'string' && c.name.length > 0 ? c.name : null,
      guildId,
      guildName: c.guild?.name ?? null,
      isDM: !guildId,
    };
  }

  /** Compare two Discord snowflake IDs numerically without BigInt parsing.
   *  Snowflakes are 64-bit so we use locale numeric collation. */
  private snowflakeLte(a: string, b: string): boolean {
    return a.localeCompare(b, 'en-US-u-kn-true') <= 0;
  }

  /** Whether a fetched message addresses the bot — explicit @mention or a
   *  reply targeting it. Mirrors the live-path logic in convertMessage
   *  (`mentions.users` + `mentions.repliedUser`). Returns false when the bot
   *  user isn't known yet. */
  private messageMentionsBot(m: Message): boolean {
    const botId = this.client.user?.id;
    if (!botId) return false;
    return (
      m.mentions.users.has(botId) ||
      m.mentions.repliedUser?.id === botId ||
      m.mentions.roles.some((r) => (r as { tags?: { botId?: string } }).tags?.botId === botId)
    );
  }

  async sendTyping(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel && 'sendTyping' in channel) {
      await (channel as TextChannel).sendTyping();
    }
  }

  getGuildName(guildId: string): string {
    return this.client.guilds.cache.get(guildId)?.name ?? guildId;
  }

  /** Resolve a DM channel's recipient for descriptor labels. Returns null if
   *  the id isn't a DM channel or the fetch fails (deleted account etc.). */
  async getDmChannelInfo(
    channelId: string,
  ): Promise<{ recipientId: string; recipientName: string } | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || channel.type !== ChannelType.DM) return null;
      const dm = channel as DMChannel;
      const recipient =
        dm.recipient ?? (dm.recipientId ? await this.client.users.fetch(dm.recipientId) : null);
      if (!recipient) return null;
      return { recipientId: recipient.id, recipientName: recipient.username };
    } catch {
      return null;
    }
  }

  /** Timeout for the bulk guild-member fetch. Instance-scoped so tests can
   *  shrink it; 30s in production. */
  private memberFetchTimeoutMs = 30_000;

  /** Bulk-fetch all members of a guild into the local cache. Idempotent
   *  (safe to call multiple times). Wrapped in a timeout so that
   *  misconfigured intents — portal-disabled but client-requested, for
   *  instance — fail fast with a clear error instead of hanging the
   *  whole client. Returns whether the warm-up succeeded; callers whose
   *  correctness depends on a FULL cache (permission-computed member lists)
   *  must check it — a partial cache silently narrows their answer. */
  private async warmGuildMemberCache(guild: Guild): Promise<boolean> {
    const TIMEOUT_MS = this.memberFetchTimeoutMs;
    const fetchP = guild.members.fetch();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutP = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `guild.members.fetch() timed out after ${TIMEOUT_MS}ms for "${guild.name}". ` +
                'GuildMembers intent must be enabled in BOTH the Discord Developer ' +
                "Portal (Bot → Privileged Gateway Intents) AND the discord.js client's " +
                'intents array. The client side is set; check the portal side.',
            ),
          ),
        TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([fetchP, timeoutP]);
      console.error(
        `[discord-mcpl] member cache warmed for "${guild.name}" (${guild.members.cache.size} members)`,
      );
      return true;
    } catch (err) {
      console.error(
        `[discord-mcpl] member cache warm-up failed for "${guild.name}": ${(err as Error).message}`,
      );
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Produce a human-readable label for a channel id, for use in
   *  sticky-shift notices to the agent. Tries cache then a single
   *  REST fetch; falls back to the raw id if either fails. */
  async describeChannel(
    channelId: string,
  ): Promise<{ label: string; channelName?: string; guildName?: string; isDM: boolean }> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) return { label: channelId, isDM: false };
      const ch = channel as { guild?: Guild; recipient?: User; name?: string };
      if (ch.guild) {
        const channelName = typeof ch.name === 'string' ? ch.name : undefined;
        const guildName = ch.guild.name;
        return {
          label: channelName
            ? `#${channelName} in ${guildName}`
            : `channel ${channelId} in ${guildName}`,
          channelName,
          guildName,
          isDM: false,
        };
      }
      if (ch.recipient) {
        const u = ch.recipient as User & { globalName?: string | null };
        const name = u.globalName ?? u.displayName ?? u.username ?? u.id;
        return { label: `DM with @${name}`, isDM: true };
      }
      return { label: channelId, isDM: false };
    } catch {
      return { label: channelId, isDM: false };
    }
  }

  async listGuilds(): Promise<DiscordGuildInfo[]> {
    return this.client.guilds.cache.map((g: Guild) => ({
      id: g.id,
      name: g.name,
      memberCount: g.memberCount,
    }));
  }

  async listChannels(guildId: string): Promise<DiscordChannelInfo[]> {
    const guild = await this.client.guilds.fetch(guildId);
    if (!guild?.channels) {
      throw new Error(`Guild ${guildId} not found`);
    }
    const channels = await guild.channels.fetch();
    const result: DiscordChannelInfo[] = [];
    channels.forEach((c: GuildBasedChannel | null) => {
      if (c) {
        if (!this.channelAllowed(guildId, c.id, c.parentId)) return;
        result.push({
          id: c.id,
          name: c.name,
          type: mapChannelType(c.type),
          parentId: c.parentId ?? undefined,
          label: formatChannelLabel(c.name, guild.name),
        });
      }
    });
    return result;
  }


  /**
   * Resolve a channel reference that may be a name instead of a snowflake.
   *
   * Accepts a raw id or the MCPL composite unchanged; otherwise resolves
   * `#name` / `#name (GuildName)` against the channels the bot can currently
   * see. See `channel-names.ts` for why, and for the no-fuzzy-matching rule.
   *
   * Inverse of `resolveChannelMeta` in server.ts (id -> label); this is
   * label -> id. The two are siblings and should stay consistent about which
   * channels are addressable.
   *
   * THREE THINGS THIS DELIBERATELY DOES:
   *
   * 1. Reads the LIVE cache every call, never a startup snapshot. discord.js
   *    keeps `guild.channels.cache` current from gateway events. A cached
   *    name->id map would go stale on rename, and if a freed name were later
   *    reused by a different channel it would deliver silently to the wrong
   *    room — reintroducing the exact failure this feature removes.
   * 2. Applies `channelAllowed` BEFORE matching, so a name can never address a
   *    channel the allowlist excludes, and an excluded `#general` cannot
   *    manufacture a spurious collision with a permitted one.
   * 3. Excludes categories and threads. Categories are not sendable. Thread
   *    names are not unique — not even within one channel — so including them
   *    would make the ambiguity error fire constantly and render the feature
   *    unusable. Threads remain addressable by id.
   */
  resolveChannelRef(ref: string): ResolveResult {
    const parsed = parseChannelRef(ref);
    if (!parsed) {
      return { ok: false, reason: 'not-found', message: `Unusable channel reference: "${ref}"` };
    }
    if (parsed.kind === 'id') return { ok: true, id: parsed.id };

    const candidates = buildCandidates(
      [...this.client.guilds.cache.values()].map((g) => ({
        id: g.id, name: g.name, channels: g.channels.cache.values(),
      })),
      {
        ...(this.guildIds?.length ? { guildIds: this.guildIds } : {}),
        mapType: mapChannelType,
        allowed: (gid, cid, pid) => this.channelAllowed(gid, cid, pid),
      },
    );
    return resolveChannelName(parsed, candidates);
  }

  /** Channel membership, by scope. Guild channels resolve to everyone whose
   *  computed permissions include VIEW_CHANNEL — which is only true over a
   *  FULL member cache, so the guarded warm-up must succeed or this throws
   *  rather than return a silently narrowed list. Threads resolve to their
   *  JOINED members (Discord's own thread-membership notion; a public thread
   *  may be readable by non-joined users with parent access — the result
   *  carries that caveat in `note`). DMs resolve to the two parties.
   *
   *  Configured channel filters bound what a residence may INSPECT, not just
   *  what gets delivered: a channel outside them throws, matching
   *  listChannels' enforcement. Threads count as their parent channel, same
   *  as event routing. */
  async listChannelMembers(channelId: string): Promise<DiscordChannelMembers> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    const toInfo = (m: GuildMember): DiscordMemberInfo => ({
      id: m.id,
      username: m.user.username,
      displayName: m.displayName,
      isBot: m.user.bot,
    });
    const finish = (
      channelName: string | null,
      scope: DiscordChannelMembers['scope'],
      members: DiscordMemberInfo[],
      note?: string,
    ): DiscordChannelMembers => {
      // Humans first, then bots; alphabetical within each — the agent usually
      // wants "who's here", not a wall of infrastructure accounts up top.
      members.sort(
        (a, b) =>
          Number(a.isBot) - Number(b.isBot) ||
          a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' }),
      );
      return {
        channelId,
        channelName,
        scope,
        total: members.length,
        members: members.slice(0, MEMBER_LIST_CAP),
        truncated: members.length > MEMBER_LIST_CAP,
        ...(note ? { note } : {}),
      };
    };
    const filterDenied = () =>
      new Error(
        `Channel ${channelId} is outside this residence's configured channel filters — ` +
        'filters bound inspection as well as delivery.',
      );

    if (channel.type === ChannelType.DM) {
      const dm = channel as DMChannel;
      const recipient = dm.recipient ?? (dm.recipientId ? await this.client.users.fetch(dm.recipientId) : null);
      const me = this.client.user;
      const members: DiscordMemberInfo[] = [];
      for (const u of [recipient, me]) {
        if (!u) continue;
        members.push({ id: u.id, username: u.username, displayName: u.displayName ?? u.username, isBot: u.bot });
      }
      return finish(null, 'dm', members);
    }

    if (channel.isThread()) {
      const guild = channel.guild;
      if (!this.channelAllowed(guild?.id ?? channel.guildId, channelId, channel.parentId)) {
        throw filterDenied();
      }
      const threadMembers = await channel.members.fetch();
      // Bulk resolution: one guarded cache warm, then cache reads — never a
      // serial per-member REST fetch. Warm failure only degrades DISPLAY here
      // (the membership list itself comes from the thread, not the guild
      // cache), so unknown members fall back to id-only rather than aborting.
      await this.warmGuildMemberCache(guild);
      const members = [...threadMembers.values()].map((tm) => {
        const gm = guild.members.cache.get(tm.id);
        return gm ? toInfo(gm) : { id: tm.id, username: tm.id, displayName: tm.id, isBot: false };
      });
      return finish(
        channel.name,
        'thread-joined',
        members,
        'Joined members only. Users with access to the parent channel may be able to read a public thread without joining it.',
      );
    }

    if ('members' in channel && 'guild' in channel) {
      const guildChannel = channel as GuildBasedChannel & { members: Map<string, GuildMember> };
      const parentId = (guildChannel as { parentId?: string | null }).parentId;
      if (!this.channelAllowed(guildChannel.guild.id, channelId, parentId)) {
        throw filterDenied();
      }
      // The members getter computes VIEW_CHANNEL against the member cache;
      // warm it first (timeout-guarded) so the answer covers everyone, not
      // just recent speakers. A failed warm-up must throw: a list computed
      // over a partial cache would be silently incomplete.
      const warmed = await this.warmGuildMemberCache(guildChannel.guild);
      if (!warmed) {
        throw new Error(
          'Guild member cache warm-up failed or timed out — a member list computed now ' +
          'would be silently incomplete. Check the GuildMembers privileged intent ' +
          '(Developer Portal → Bot → Privileged Gateway Intents).',
        );
      }
      const members = [...guildChannel.members.values()].map(toInfo);
      return finish(guildChannel.name, 'guild-channel', members);
    }

    throw new Error(`Channel ${channelId} has no queryable membership (type ${channel.type})`);
  }

  /** List the custom (server) emojis the bot can see — the shared palette for
   *  both message content and reactions. Omit `guildId` to span all guilds. */
  async listEmojis(guildId?: string): Promise<DiscordEmojiInfo[]> {
    const guilds: Guild[] = [];
    if (guildId) {
      const g = await this.client.guilds.fetch(guildId).catch(() => null);
      if (!g) throw new Error(`Guild ${guildId} not found`);
      guilds.push(g);
    } else {
      guilds.push(...this.client.guilds.cache.values());
    }
    const out: DiscordEmojiInfo[] = [];
    for (const g of guilds) {
      let emojis = g.emojis.cache;
      if (emojis.size === 0) {
        emojis = await g.emojis.fetch().catch(() => emojis);
      }
      emojis.forEach((e) => {
        if (!e.name) return;
        out.push({
          id: e.id,
          name: e.name,
          animated: e.animated ?? false,
          token: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`,
          reactionArg: `:${e.name}:`,
          guildId: g.id,
          guildName: g.name,
        });
      });
    }
    return out;
  }

  async createTextChannel(
    guildId: string,
    name: string,
    categoryId?: string,
  ): Promise<DiscordChannelInfo> {
    const guild = await this.client.guilds.fetch(guildId);
    if (!guild) throw new Error(`Guild ${guildId} not found`);
    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: categoryId,
    });
    return {
      id: channel.id,
      name: channel.name,
      type: 'text',
      parentId: channel.parentId ?? undefined,
      label: formatChannelLabel(channel.name, guild.name),
    };
  }

  async deleteChannel(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);
    if ('delete' in channel) {
      await (channel as TextChannel).delete();
    } else {
      throw new Error(`Channel ${channelId} cannot be deleted`);
    }
  }

  /** Get all text channels across filtered guilds. */
  getTextChannels(): Array<{ guildId: string; guildName: string; channel: DiscordChannelInfo }> {
    const result: Array<{ guildId: string; guildName: string; channel: DiscordChannelInfo }> = [];
    for (const guild of this.client.guilds.cache.values()) {
      if (this.guildIds && !this.guildIds.includes(guild.id)) continue;
      for (const channel of guild.channels.cache.values()) {
        if (channel.type === ChannelType.GuildText) {
          if (!this.channelAllowed(guild.id, channel.id, channel.parentId)) continue;
          result.push({
            guildId: guild.id,
            guildName: guild.name,
            channel: {
              id: channel.id,
              name: channel.name,
              type: 'text',
              parentId: channel.parentId ?? undefined,
              label: formatChannelLabel(channel.name, guild.name),
            },
          });
        }
      }
    }
    return result;
  }

  /** All text channels in a single guild, as DiscordChannelInfo. Reads the
   *  channel cache (populated by the gateway), mirroring getTextChannels but
   *  scoped to one guild — used when the bot joins a guild after startup. */
  private guildTextChannels(guild: Guild): DiscordChannelInfo[] {
    const result: DiscordChannelInfo[] = [];
    for (const channel of guild.channels.cache.values()) {
      if (!this.channelAllowed(guild.id, channel.id, channel.parentId)) continue;
      if (channel.type === ChannelType.GuildText) {
        result.push({
          id: channel.id,
          name: channel.name,
          type: 'text',
          parentId: channel.parentId ?? undefined,
          label: formatChannelLabel(channel.name, guild.name),
        });
      }
    }
    return result;
  }

  // ── Private ──

  private setupEvents(): void {
    this.client.on('messageCreate', (message: Message) => {
      const base = {
        msgId: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        authorId: message.author.id,
        authorIsBot: message.author.bot,
        messageType: message.type,
        attachmentCount: message.attachments.size,
        mentionCount: message.mentions.users.size,
      };
      dbg('gateway:message-create', base);

      const dropReason = this.messageFilterReason(message);
      if (dropReason) {
        dbg('gateway:message-create-drop', { ...base, reason: dropReason });
        return;
      }

      try {
        this.messageHandler?.(this.convertMessage(message));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        dbg('gateway:message-create-error', { ...base, error });
        console.error('[discord-mcpl] Failed to convert Discord message:', error);
      }
    });

    this.client.on('messageUpdate', (_old, newMsg) => {
      if (!newMsg.content) return;
      // Skip our own edits (e.g. deferred slash-command replies arrive as
      // edits) — mirrors the self-author check in shouldHandle.
      if (newMsg.author?.id === this.client.user?.id) return;
      const editParent =
        newMsg.channel && 'parentId' in newMsg.channel
          ? ((newMsg.channel as { parentId?: string | null }).parentId ?? null)
          : null;
      if (!this.channelAllowed(newMsg.guildId, newMsg.channelId, editParent)) return;
      if (!newMsg.guildId && this.dmUsers && newMsg.author && !this.dmUsers.has(newMsg.author.id)) {
        return;
      }
      this.editHandler?.(newMsg.channelId, newMsg.id, newMsg.content, !newMsg.guildId);
    });

    this.client.on('messageDelete', (message) => {
      const delParent =
        message.channel && 'parentId' in message.channel
          ? ((message.channel as { parentId?: string | null }).parentId ?? null)
          : null;
      if (!this.channelAllowed(message.guildId, message.channelId, delParent)) return;
      this.deleteHandler?.(message.channelId, message.id, !message.guildId);
    });

    this.client.on('messageReactionAdd', (reaction, user) => {
      void this.handleReactionEvent('add', reaction, user);
    });

    this.client.on('messageReactionRemove', (reaction, user) => {
      void this.handleReactionEvent('remove', reaction, user);
    });

    this.client.on('channelCreate', (channel) => {
      if ('guildId' in channel && channel.guildId) {
        const parentId = 'parentId' in channel ? (channel.parentId ?? null) : null;
        if (!this.channelAllowed(channel.guildId, channel.id, parentId)) return;
        // A label must be an ADDRESS. The previous fallback substituted the
        // guild *id* for its name, producing `#foo (1234…)` — which parses as a
        // guild-qualified ref, matches nothing (resolution compares against
        // guild NAMES), and so can never resolve. On this path especially: it
        // announces a brand-new channel, which is exactly when an agent is
        // likeliest to paste the label straight back. Prefer the cache, and if
        // the name is genuinely unavailable emit the bare `#name` form, which
        // is a real (if possibly ambiguous) address rather than a broken one.
        const guildName =
          channel.guild?.name ?? this.client.guilds.cache.get(channel.guildId)?.name;
        this.channelCreateHandler?.(channel.guildId, {
          id: channel.id,
          name: channel.name,
          label: guildName ? formatChannelLabel(channel.name, guildName) : `#${channel.name}`,
          type: mapChannelType(channel.type),
          parentId: 'parentId' in channel ? (channel.parentId ?? undefined) : undefined,
        });
      }
    });

    this.client.on('channelDelete', (channel) => {
      if ('guildId' in channel && channel.guildId) {
        this.channelDeleteHandler?.(channel.guildId, channel.id);
      }
    });

    this.client.on('ready', () => {
      this.readyHandler?.();
      // Eagerly warm the member cache for every guild we're in so
      // @name → <@id> resolution in outbound sends works for inactive
      // members too (not just those who've recently spoken). One bulk
      // fetch per guild; discord.js keeps it fresh thereafter via
      // GUILD_MEMBER_ADD/UPDATE/REMOVE events (which need the
      // GuildMembers intent we declared above).
      for (const guild of this.client.guilds.cache.values()) {
        void this.warmGuildMemberCache(guild);
      }
    });

    // Newly-joined guilds: warm their member cache too, and surface the
    // guild's existing text channels so the host can register them. Without
    // this, channels in a server the bot is added to *after* startup never
    // appear in the host's channel list (channelCreate only fires for
    // channels created later, not the ones that already existed on join).
    this.client.on('guildCreate', (guild) => {
      void this.warmGuildMemberCache(guild);
      if (this.guildIds?.length && !this.guildIds.includes(guild.id)) return;
      // Register slash commands in guilds joined after startup.
      if (this.guildCommandDefs) {
        guild.commands.set(this.guildCommandDefs).catch((err: Error) => {
          console.error(`[discord-mcpl] Failed to register commands in new guild ${guild.id}:`, err.message);
        });
      }
      this.guildCreateHandler?.(guild.id, guild.name, this.guildTextChannels(guild));
    });

    this.client.on('interactionCreate', (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (
        this.guildIds?.length &&
        interaction.guildId &&
        !this.guildIds.includes(interaction.guildId)
      ) {
        return;
      }
      this.slashCommandHandler?.(interaction);
    });

    // Permission overwrites changing on an existing channel: when they flip
    // the bot from "can't see" to "can see" (i.e. the bot was added to a
    // private channel), treat it like a newly-available channel. We compare
    // the bot's View Channel permission before vs after so ordinary edits
    // (topic, name, slowmode) don't spuriously re-register.
    this.client.on('channelUpdate', (oldChannel, newChannel) => {
      if (!('guild' in newChannel) || newChannel.type !== ChannelType.GuildText) return;
      const guild = newChannel.guild;
      if (this.guildIds?.length && !this.guildIds.includes(guild.id)) return;
      const me = guild.members.me;
      if (!me) return;
      if (!this.channelAllowed(guild.id, newChannel.id, newChannel.parentId)) return;
      const VIEW = PermissionsBitField.Flags.ViewChannel;
      const canViewNow = newChannel.permissionsFor(me)?.has(VIEW) ?? false;
      if (!canViewNow) return;
      const couldViewBefore =
        'permissionsFor' in oldChannel
          ? (oldChannel.permissionsFor(me)?.has(VIEW) ?? false)
          : false;
      if (couldViewBefore) return; // no visibility transition — ignore
      this.channelAvailableHandler?.(guild.id, {
        id: newChannel.id,
        name: newChannel.name,
        label: formatChannelLabel(newChannel.name, guild.name),
        type: 'text',
        parentId: newChannel.parentId ?? undefined,
      });
    });

    this.client.on('error', (err: Error) => {
      dbg('gateway:client-error', { error: err.message });
      console.error('[discord-mcpl] Client error:', err.message);
    });

    this.client.on('warn', (message: string) => {
      dbg('gateway:warn', { message });
    });

    this.client.on('shardReady', (shardId, unavailableGuilds) => {
      dbg('gateway:shard-ready', {
        shardId,
        unavailableGuilds: unavailableGuilds?.size ?? 0,
        status: this.client.ws.status,
        pingMs: this.client.ws.ping,
      });
    });

    this.client.on('shardDisconnect', (event, shardId) => {
      dbg('gateway:shard-disconnect', {
        shardId,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        status: this.client.ws.status,
        pingMs: this.client.ws.ping,
      });
    });

    this.client.on('shardReconnecting', (shardId) => {
      dbg('gateway:shard-reconnecting', {
        shardId,
        status: this.client.ws.status,
        pingMs: this.client.ws.ping,
      });
    });

    this.client.on('shardResume', (shardId, replayedEvents) => {
      dbg('gateway:shard-resume', {
        shardId,
        replayedEvents,
        status: this.client.ws.status,
        pingMs: this.client.ws.ping,
      });
    });

    this.client.on('shardError', (err, shardId) => {
      dbg('gateway:shard-error', {
        shardId,
        error: err.message,
        status: this.client.ws.status,
        pingMs: this.client.ws.ping,
      });
      console.error(`[discord-mcpl] Gateway shard ${shardId} error:`, err.message);
    });

    this.client.on('invalidated', () => {
      dbg('gateway:invalidated', {
        status: this.client.ws.status,
        pingMs: this.client.ws.ping,
      });
      console.error('[discord-mcpl] Gateway session invalidated');
    });
  }

  /** Per-guild channel whitelist check. A guild with no entry in
   *  `guildChannels` is unrestricted. Threads count as their parent channel
   *  (a thread under a whitelisted channel is allowed). */
  private channelAllowed(
    guildId: string | null | undefined,
    channelId: string,
    parentId?: string | null,
  ): boolean {
    if (!guildId || !this.guildChannels) return true;
    const allowed = this.guildChannels.get(guildId);
    if (!allowed) return true;
    return allowed.has(channelId) || (parentId != null && allowed.has(parentId));
  }

  private messageFilterReason(message: Message): string | null {
    if (message.author.id === this.client.user?.id) return 'self-authored';
    if (this.guildIds?.length && message.guildId && !this.guildIds.includes(message.guildId)) {
      return 'guild-not-allowed';
    }
    // DMs: when a DM user whitelist is configured, drop DMs from anyone else.
    if (!message.guildId && this.dmUsers && !this.dmUsers.has(message.author.id)) {
      return 'dm-user-not-allowed';
    }
    if (message.guildId) {
      const parentId =
        message.channel && 'parentId' in message.channel
          ? ((message.channel as { parentId?: string | null }).parentId ?? null)
          : null;
      if (!this.channelAllowed(message.guildId, message.channelId, parentId)) {
        return 'channel-not-allowed';
      }
    }
    return null;
  }

  private convertMessage(message: Message): DiscordMessageData {
    // discord.js exposes channel/guild names directly on the Message object
    // (`message.channel.name`, `message.guild?.name`); they're only undefined
    // for unusual channel kinds (e.g. uncached partials). Fall back to null
    // so downstream rendering can distinguish "unknown" from "DM".
    const channel = message.channel as { name?: string } | null;
    const channelName = channel && typeof channel.name === 'string' && channel.name.length > 0
      ? channel.name
      : null;
    const guildName = message.guild?.name ?? null;
    const threadName = (message.thread as { name?: string } | null)?.name;
    // `cleanContent` resolves <@id>, <@&roleId>, <#channelId> to
    // @username / @role / #channel (with raw-content fallback), forwarded
    // messages carry their body in messageSnapshots, not content, and Discord
    // SYSTEM messages synthesize their client affordance from message.type —
    // all handled in resolveVisibleContent, shared with the history paths.
    const content = resolveVisibleContent(message);
    // A forward's reference points at its ORIGIN message (reference.type =
    // Forward); only a real reply (type Default = 0) should read as reply-to,
    // else a forwarded bot message looks like a reply to the bot.
    const refType = (message.reference as { type?: number } | null)?.type ?? 0;
    return {
      id: message.id,
      content,
      cleanContent: content,
      authorId: message.author.id,
      authorName: message.author.username,
      isBot: message.author.bot,
      channelId: message.channelId,
      channelName,
      guildId: message.guildId ?? null,
      guildName,
      threadId: message.thread?.id,
      threadName,
      replyToId: refType === 0 ? (message.reference?.messageId ?? undefined) : undefined,
      // mentions.repliedUser is the User the reply targets — distinct
      // from mentions.users (which only includes them if the sender
      // explicitly enabled the reply-ping). We capture it so reply-to-bot
      // can be treated as direct address regardless of the ping toggle.
      replyToUserId: message.mentions.repliedUser?.id ?? null,
      replyToUserName: message.mentions.repliedUser?.username ?? null,
      mentions: message.mentions.users.map((u) => u.id),
      mentionsBotRole: message.mentions.roles.some(
        (r) => (r as { tags?: { botId?: string } }).tags?.botId === this.client.user?.id,
      ),
      attachments: mapAllAttachments(message),
      timestamp: message.createdAt,
    };
  }
}

/** Render a content-less Discord system message the way the human client
 *  does — from its type. The author of a system message is its subject
 *  (e.g. the joining member authors the UserJoin message), so downstream
 *  "Author: <text>" rendering reads naturally. Unknown/new types degrade to
 *  a generic marker with the numeric type rather than an empty string. */
function systemMessageText(type: MessageType): string {
  switch (type) {
    case MessageType.UserJoin:
      return '[joined the server]';
    case MessageType.GuildBoost:
      return '[boosted the server]';
    case MessageType.GuildBoostTier1:
    case MessageType.GuildBoostTier2:
    case MessageType.GuildBoostTier3:
      return '[boosted the server to a new tier]';
    case MessageType.ChannelPinnedMessage:
      return '[pinned a message to this channel]';
    case MessageType.ChannelFollowAdd:
      return '[followed a channel into this one]';
    case MessageType.RecipientAdd:
      return '[added someone to the group]';
    case MessageType.RecipientRemove:
      return '[removed someone from the group]';
    case MessageType.ChannelNameChange:
      return '[changed the channel name]';
    case MessageType.ThreadCreated:
      return '[started a thread]';
    case MessageType.AutoModerationAction:
      return '[automod action]';
    default:
      return `[system message: type ${type}]`;
  }
}

/** Map a discord.js message's attachments collection to DiscordAttachment[]. */
function mapAttachments(message: { attachments?: { values?(): IterableIterator<unknown> } }): DiscordAttachment[] {
  const coll = message.attachments;
  if (!coll || typeof coll.values !== 'function') return [];
  const out: DiscordAttachment[] = [];
  for (const a of coll.values() as IterableIterator<{
    id: string; name: string | null; url: string; contentType: string | null; size: number;
  }>) {
    out.push({
      id: a.id,
      name: a.name ?? a.id,
      url: a.url,
      contentType: a.contentType ?? null,
      size: typeof a.size === 'number' ? a.size : 0,
    });
  }
  return out;
}

/** A message's own attachments plus any carried by forwarded snapshots.
 *  Snapshot attachments keep their original CDN URLs (signed like any other),
 *  so merging them here sends a forward's media through the same delivery
 *  path as a native upload — images inlined as blocks, text files inlined,
 *  everything else a name+URL note — on the live path AND both history
 *  paths. The forwarded line's "[N attachments]" count note stays: it tells
 *  the agent which message the media rode in on. */
export function mapAllAttachments(m: {
  attachments?: { values?(): IterableIterator<unknown> };
  messageSnapshots?: { size: number; values(): Iterable<ForwardSnapshot> } | null;
}): DiscordAttachment[] {
  const out = mapAttachments(m);
  if (m.messageSnapshots && m.messageSnapshots.size > 0) {
    // Dedup by attachment id: a re-forwarded forward can surface the same
    // attachment in more than one snapshot (or in both the outer message and
    // a snapshot). First occurrence wins — outer-most is least surprising.
    const seen = new Set(out.map((a) => a.id));
    let snapshotIndex = 0;
    for (const snap of m.messageSnapshots.values()) {
      snapshotIndex++;
      for (const att of mapAttachments({ attachments: snap.attachments ?? undefined })) {
        if (seen.has(att.id)) continue;
        seen.add(att.id);
        out.push({ ...att, forwardedSnapshotIndex: snapshotIndex });
      }
    }
  }
  return out;
}

/**
 * Discord channel type number -> the kind we expose.
 *
 * Name resolution keys off this (see SENDABLE in channel-names.ts), so an
 * unclassified type is not cosmetic: it silently drops out of name addressing.
 * GuildAnnouncement (5) did exactly that — an ordinary sendable text channel
 * that fell to 'unknown' and so could not be reached as `#announcements`, while
 * `list_channels` happily printed a pasteable label for it.
 */
export function mapChannelType(type: number | undefined): DiscordChannelInfo['type'] {
  switch (type) {
    case 0: return 'text';
    case 2: return 'voice';
    case 4: return 'category';
    // 5 = GuildAnnouncement ("news"). A normal message channel that can also
    // crosspost — sendable, and commonly named #announcements / #updates.
    case 5: return 'announcement';
    case 10: // AnnouncementThread — a thread, whatever its parent is.
    case 11:
    case 12: return 'thread';
    case 15: return 'forum';
    // 13 (stage) and 16 (media) land here on purpose: not sendable, id-only.
    default: return 'unknown';
  }
}
