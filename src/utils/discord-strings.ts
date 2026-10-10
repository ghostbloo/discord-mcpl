/** Discord snowflakes are 17-20 digits. Anything all-digits in that range is
 *  treated as an id and passed through untouched (backwards compatible). */
export function isSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value);
}

/**
 * Parse a Discord message link or raw ID into a message id.
 * Accepts:
 *   https://discord.com/channels/<guild>/<channel>/<messageId>
 *   <channel>-<messageId>  (the "Copy ID" with shift on some clients)
 *   a bare 17–20 digit snowflake
 */
export function parseMessageRef(input: string): string | null {
  const s = input.trim();
  const link = s.match(/channels\/\d+\/\d+\/(\d+)/);
  if (link) return link[1];
  const dashed = s.match(/^\d+-(\d+)$/);
  if (dashed) return dashed[1];
  if (/^\d{17,20}$/.test(s)) return s;
  return null;
}

/**
 * Split text into Discord-safe chunks (<=1900 chars), preferring newline then
 * space boundaries; hard-splits over-long runs. Discord rejects content over
 * the per-message limit (DiscordAPIError 50035).
 */
export function splitForDiscord(text: string, limit = 1900): string[] {
  if (!text) return [];
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}
