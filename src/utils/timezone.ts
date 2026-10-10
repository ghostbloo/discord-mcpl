/** Format agent-visible wall-clock times without changing UTC protocol data. */

/** True iff `zone` names an IANA time zone this runtime can format in.
 *  Exported for hosts that want to pre-validate AGENT_TIMEZONE strictly. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** Resolve the zone used for agent-visible timestamps. NEVER throws: this is
 *  evaluated at module scope, so a typo'd AGENT_TIMEZONE would kill the stdio
 *  child during import — before the MCPL handshake — and a dead MCPL
 *  subprocess is never respawned by reconnect. Instead, warn loudly on stderr
 *  and fall back to the same default used when the variable is unset
 *  (system zone → UTC). */
export function resolveAgentTimeZone(configured = process.env.AGENT_TIMEZONE): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const zone = configured?.trim();
  if (!zone) return fallback;
  if (!isValidTimeZone(zone)) {
    console.error(`[timezone] Invalid AGENT_TIMEZONE ${JSON.stringify(zone)} — falling back to system time zone ${JSON.stringify(fallback)}`);
    return fallback;
  }
  return zone;
}

/** Rendering style for agent-visible timestamps on message lines.
 *    full    2026-01-15T04:34:56-08:00 [America/Los_Angeles]   (default)
 *    compact 2026-01-15 04:34
 *    time    04:34
 *    none    (empty — callers omit the timestamp entirely)
 *  The zone still governs conversion for every style; only the rendered
 *  verbosity changes. Full costs ~45 chars per line, which adds up across a
 *  long backscroll — compact/time exist for context-budget-conscious
 *  deployments. */
export type TimestampStyle = 'full' | 'compact' | 'time' | 'none';

const TIMESTAMP_STYLES: ReadonlySet<string> = new Set(['full', 'compact', 'time', 'none']);

/** Resolve the style for agent-visible timestamps (AGENT_TIMESTAMP_STYLE).
 *  Same never-throw contract as resolveAgentTimeZone, for the same reason:
 *  this is evaluated at module scope in a stdio child, and an exception here
 *  kills the subprocess before the MCPL handshake. Unknown values warn on
 *  stderr and fall back to 'full'. */
export function resolveTimestampStyle(configured = process.env.AGENT_TIMESTAMP_STYLE): TimestampStyle {
  const style = configured?.trim().toLowerCase();
  if (!style) return 'full';
  if (TIMESTAMP_STYLES.has(style)) return style as TimestampStyle;
  console.error(
    `[timezone] Invalid AGENT_TIMESTAMP_STYLE ${JSON.stringify(configured)} — ` +
    `falling back to "full" (valid: full, compact, time, none)`,
  );
  return 'full';
}

export function formatAgentDateTime(
  value: Date | number,
  timeZone = resolveAgentTimeZone(),
  style: TimestampStyle = 'full',
): string {
  if (style === 'none') return '';
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  if (style === 'time') return `${get('hour')}:${get('minute')}`;
  if (style === 'compact') return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  const rawOffset = get('timeZoneName');
  const offset = rawOffset === 'GMT' ? '+00:00' : rawOffset.replace('GMT', '');
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset} [${timeZone}]`;
}
