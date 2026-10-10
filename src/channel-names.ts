/**
 * Name-based channel addressing.
 *
 * WHY
 * Send tools require the raw channel snowflake verbatim. Models *regenerate*
 * these token-by-token rather than copying them, and snowflakes are worst-case
 * objects for that: pure digit sequences, no semantic redundancy, no checksum.
 * Three observed failure modes (see the feature request in the memory repo,
 * `shared/projects/channel_addressing_patch.md`):
 *
 *   1. Mangled id      — blends two in-context ids. Bounces loudly. Annoying.
 *   2. Stale default   — id-less send falls back to "most recent channel",
 *                        which is state, and state goes stale. SILENT.
 *   3. Wrong-valid-id  — plucks a real-but-wrong id from context. SILENT.
 *
 * The silent ones are the dangerous ones.
 *
 * DESIGN: accept back the string we already print.
 * `toDescriptor` (channels.ts) already labels channels `#name (GuildName)`, and
 * the server already announces channels to agents in that form. So this adds no
 * new naming scheme — anything visible in a channel listing becomes pasteable
 * into a send. Display form == address form.
 *
 * Guild qualification matters more than it looks. Bare `#general` collides
 * across guilds, and a bot in several servers hits that constantly rather than
 * rarely — so "hard-error on ambiguity" alone would send agents straight back to
 * snowflakes exactly as the channel count grows. The qualified form resolves
 * NORMALLY but not always: Discord permits duplicate text-channel names within
 * one guild, so two candidates can share a label. That case falls through to the
 * ambiguity error, which then quotes ids because labels no longer separate them.
 *
 * NO FUZZY MATCHING. Exact name, case-insensitive, leading `#` optional. A
 * "did you mean" would reintroduce silent wrong-room delivery in friendlier
 * packaging, which is failure mode 3 with better manners.
 *
 * IDS ARE A CO-EQUAL ADDRESS FORM, NOT A FAILURE STATE. The problem this
 * solves is MONOCULTURE — ids being the only thing to paste — not ids being
 * bad. An id is stable across renames, unambiguous by construction, and the
 * only way to reach the threads and categories this resolver excludes. So the
 * ambiguity error quotes ids alongside labels whenever labels alone cannot
 * separate the candidates, which is exactly the voice/text case.
 *
 * This module is deliberately free of discord.js so it can be unit-tested
 * without a gateway connection; the adapter supplies live candidates.
 */

import { isSnowflake } from "./utils/discord-strings.js";

/** A channel the bot can currently see, already filtered by the allowlist. */
export interface ChannelCandidate {
  id: string;
  name: string;
  guildId: string;
  guildName: string;
  /** Needed for tie-breaking: a stock Discord server ships a VOICE channel
   *  named "General" beside text #general, and matching is case-insensitive,
   *  so a name collision across types is the DEFAULT state, not an edge case. */
  type: 'text' | 'announcement' | 'voice' | 'forum' | 'unknown';
}

/**
 * THE canonical `#name (GuildName)` formatter. Display form == address form is
 * the load-bearing claim of this whole module: the string a listing prints must
 * be the string a send accepts. That invariant cannot survive being reimplemented
 * per call site — a divergence anywhere silently makes labels unpasteable, and no
 * test would catch it because each side would agree with itself. So every
 * producer of this string (toDescriptor, the adapter's listing and event paths)
 * routes through here.
 *
 * Takes the two fields rather than a ChannelCandidate so callers holding a
 * discord.js channel, a DiscordChannelInfo, or nothing but two strings can all
 * use it.
 */
export function formatChannelLabel(name: string, guildName: string): string {
  return `#${name} (${guildName})`;
}

/** `#name (GuildName)` for a resolver candidate. */
export function channelLabel(c: ChannelCandidate): string {
  return formatChannelLabel(c.name, c.guildName);
}

export type ChannelRef =
  | { kind: 'id'; id: string }
  | { kind: 'name'; name: string; guild?: string };

/**
 * Parse an incoming channelId argument.
 *
 * Accepted:
 *   `123456789012345678`            -> id (passthrough)
 *   `discord:<guildId>:<channelId>` -> id (the existing MCPL composite)
 *   `#general` / `general`          -> name, unqualified
 *   `#general (Separatrix)`         -> name, guild-qualified
 *
 * Returns null for input that is neither a usable id nor a plausible name.
 */
export function parseChannelRef(raw: string): ChannelRef | null {
  const value = raw.trim();
  if (!value) return null;

  if (isSnowflake(value)) return { kind: 'id', id: value };

  // Existing MCPL composite: discord:<guildId>:<channelId>. Matched with the
  // SAME predicate as parseMcplChannelId (channels.ts) and deliberately no
  // stricter -- an extra isSnowflake check here would reject composites the
  // rest of the codebase accepts, e.g. wherever ids are not Discord-shaped.
  const parts = value.split(':');
  if (parts.length === 3 && parts[0] === 'discord') {
    return { kind: 'id', id: parts[2] };
  }

  // `#name (Guild)` — guild in trailing parens. Guild names can contain almost
  // anything, so match the LAST parenthesised group and take the rest as name.
  const qualified = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(value);
  if (qualified && qualified[2].trim()) {
    const name = stripHash(qualified[1]);
    if (name) return { kind: 'name', name, guild: qualified[2].trim() };
  }

  const name = stripHash(value);
  return name ? { kind: 'name', name } : null;
}

/**
 * True when the string can ONLY have been a name attempt: `#`-prefixed, or the
 * `name (Guild)` qualified form. Distinguishes "the caller meant a name" from
 * "this is an opaque id from some non-Discord adapter" — a bare token like
 * `c1` is genuinely ambiguous between the two, and adapters predating name
 * addressing may legitimately use such ids.
 *
 * Used to decide how hard to fail when no resolver is available: refuse
 * explicit name syntax (we know what was meant and cannot honour it), pass an
 * opaque token through unchanged (exactly the pre-feature behaviour, so no
 * regression). Strictly better information where we are sure; unchanged where
 * we are not.
 */
export function looksLikeExplicitName(raw: string): boolean {
  const value = raw.trim();
  if (!value || isSnowflake(value)) return false;
  const parts = value.split(':');
  if (parts.length === 3 && parts[0] === 'discord') return false;
  return value.startsWith('#') || /\([^()]*\)\s*$/.test(value);
}

function stripHash(value: string): string {
  return value.trim().replace(/^#/, '').trim();
}

export type ResolveResult =
  /** `matched` is absent when the input was already an id (nothing was looked
   *  up), present when a name resolved. Optional-on-the-success-arm rather
   *  than a union with a `matched?: undefined` member, which said the same
   *  thing less legibly. */
  | { ok: true; id: string; matched?: ChannelCandidate }
  | { ok: false; reason: 'not-found' | 'ambiguous'; message: string };

/**
 * Resolve a parsed name against live candidates.
 *
 * The caller MUST have already applied the channel allowlist — disallowed
 * channels must not reach here, both so a name cannot address a channel the
 * allowlist excludes, and so a forbidden `#general` cannot manufacture a
 * spurious collision with a permitted one.
 */
export function resolveChannelName(
  ref: { name: string; guild?: string },
  candidates: ChannelCandidate[],
): ResolveResult {
  const wantName = ref.name.toLowerCase();
  const wantGuild = ref.guild?.toLowerCase();

  let matches = candidates.filter((c) => c.name.toLowerCase() === wantName);
  if (wantGuild) {
    matches = matches.filter((c) => c.guildName.toLowerCase() === wantGuild);
  }

  // TIE-BREAK BY TYPE before declaring ambiguity. "General" the voice channel
  // sitting beside #general the text channel is the stock Discord layout, so
  // without this the most ordinary server on earth is unaddressable by name.
  // Only applied when it fully disambiguates; two text channels still collide.
  //
  // Announcement channels count as text here: they are ordinary message
  // channels that happen to support crossposting, so `#announcements` beside a
  // voice channel of the same name should tie-break exactly as text would.
  if (matches.length > 1) {
    const sendable = matches.filter((c) => TEXTLIKE.has(c.type));
    if (sendable.length === 1) matches = sendable;
  }

  if (matches.length === 1) return { ok: true, id: matches[0].id, matched: matches[0] };

  if (matches.length === 0) {
    const near = candidates.filter((c) => c.name.toLowerCase() === wantName);
    if (wantGuild && near.length) {
      // The name exists, but not in the guild asked for. Say so precisely —
      // this is a different mistake from "no such channel" and deserves a
      // different message.
      return {
        ok: false,
        reason: 'not-found',
        message:
          `No channel #${ref.name} in a guild named "${ref.guild}". ` +
          `That name exists elsewhere: ${near.map(channelLabel).join(', ')}`,
      };
    }
    return {
      ok: false,
      reason: 'not-found',
      message:
        `No visible channel named #${ref.name}` +
        (ref.guild ? ` in "${ref.guild}"` : '') +
        `. Use list_channels to see what is addressable.`,
    };
  }

  // Ambiguous. Quote qualified LABELS, because those are themselves valid
  // addresses and hand the caller something pasteable. But when two matches
  // share a label — same name, same guild, different type or category — the
  // label cannot separate them and a label-only message is a DEAD END: every
  // suggestion is identical and re-sending any of them returns this same
  // error, forcing the fall back to a regenerated snowflake that this whole
  // feature exists to prevent. In that case the id is the only distinguishing
  // fact, so include it. Ids are a co-equal address form, not a shameful one.
  const labels = matches.map(channelLabel);
  const labelsDistinguish = new Set(labels).size === matches.length;
  const options = matches
    .map((c) => (labelsDistinguish
      ? `"${channelLabel(c)}"`
      : `"${channelLabel(c)}" [${c.type}] (id ${c.id})`))
    .join(', ');
  return {
    ok: false,
    reason: 'ambiguous',
    message: `#${ref.name} is ambiguous — ${matches.length} channels match. Re-send with one of: ${options}`,
  };
}

/** How a send was addressed, for the send log. Only the paths this module can
 *  actually observe: a tool call either carried an id or carried a name.
 *
 *  Deliberately NOT including 'default-aim'. Failure mode 2 (an id-less send
 *  falling through to most-recent-channel) is real and is the reason the
 *  original feature request asked for three-way telemetry — but this change
 *  does not touch that path, so a variant here would be permanently unassigned
 *  and would imply coverage that does not exist. Wiring it belongs with
 *  whatever addresses the default-aim path itself. */
export type AddressingPath = 'explicit-id' | 'name-resolved';


// ── Candidate building ───────────────────────────────────────────────────────
// Extracted from DiscordAdapter so the security-relevant step — applying the
// allowlist BEFORE matching — is testable without a gateway connection. Review
// note that prompted this: coverage was inverted relative to risk, all of it on
// the pure matcher and none on the filter that decides what is addressable.

/** Structural shape of a discord.js channel, narrowed to what we need. */
export interface ChannelLike {
  id: string;
  name: string;
  type: number | undefined;
  parentId: string | null;
}

/** Structural shape of a discord.js guild, narrowed to what we need. */
export interface GuildLike {
  id: string;
  name: string;
  channels: Iterable<ChannelLike | null | undefined>;
}

/** Ordinary message channels. Separate from SENDABLE because these are also
 *  what the ambiguity tie-break prefers over a same-named voice channel. */
const TEXTLIKE: ReadonlySet<string> = new Set(['text', 'announcement']);

/** Channel kinds that can actually receive a message. Everything else stays
 *  addressable by id: categories and forum roots are not sendable, and thread
 *  names are not unique even within one channel.
 *
 *  This is an ALLOWLIST OF NAMED KINDS, deliberately not "everything except the
 *  few we exclude". It used to admit `'unknown'`, which was wrong in one
 *  direction (stage/media are not sendable); excluding `'unknown'` wholesale was
 *  then wrong in the other, because GuildAnnouncement (5) also landed in that
 *  bucket and `#announcements` is about as common a channel name as exists. An
 *  overloaded catch-all cannot be right either way — so kinds are named, and a
 *  new Discord channel type defaults to id-only addressing until someone
 *  deliberately classifies it. Failing closed here costs a bounce; failing open
 *  costs a send to something that cannot receive it. */
const SENDABLE: ReadonlySet<string> = new Set([...TEXTLIKE, 'voice']);

/** Whether a channel kind can be addressed by NAME. Exported so the mapping
 *  from Discord's type numbers to addressability is testable end to end —
 *  the announcement regression lived in that mapping, not in the matcher, and
 *  a test over a locally-reimplemented mapType would not have caught it. */
export function isNameAddressableKind(kind: string): boolean {
  return SENDABLE.has(kind);
}

export function buildCandidates(
  guilds: Iterable<GuildLike>,
  opts: {
    /** Guild allowlist. Empty/undefined = all guilds. */
    guildIds?: string[];
    mapType: (type: number | undefined) => string;
    /** MUST be the same predicate the listing surfaces use. Applied before
     *  matching so a name can never reach an excluded channel, and an excluded
     *  channel cannot manufacture a spurious collision with a permitted one. */
    allowed: (guildId: string, channelId: string, parentId: string | null) => boolean;
  },
): ChannelCandidate[] {
  const out: ChannelCandidate[] = [];
  for (const guild of guilds) {
    if (opts.guildIds?.length && !opts.guildIds.includes(guild.id)) continue;
    for (const c of guild.channels) {
      if (!c) continue;
      const kind = opts.mapType(c.type);
      if (!SENDABLE.has(kind)) continue;
      if (!opts.allowed(guild.id, c.id, c.parentId)) continue;
      out.push({
        id: c.id,
        name: c.name,
        guildId: guild.id,
        guildName: guild.name,
        type: kind as ChannelCandidate['type'],
      });
    }
  }
  return out;
}
