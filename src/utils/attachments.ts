import sharp from 'sharp';

// ============================================================================
// Image normalization (downsample-on-ingest)
// ============================================================================

/** Longest edge (px) we keep for inlined images. Matches the ~1568px ceiling
 *  every major vision model downscales to server-side, so resizing to this is
 *  perceptually lossless — the model discards anything finer regardless. */
const IMAGE_LONG_EDGE_MAX = 1568;
/** JPEG quality when re-encoding opaque images. */
const IMAGE_JPEG_QUALITY = 85;
/** Cap on the *encoded* bytes we inline (raw, pre-base64). Anthropic accepts
 *  ~5MB/image of base64; staying under ~3.5MB raw keeps us comfortably inside. */
const IMAGE_OUTPUT_RAW_CAP = 3.5 * 1024 * 1024;
/** Refuse to even download sources larger than this (OOM guard). sharp's own
 *  pixel limit guards the decoded bitmap against decompression bombs. */
export const IMAGE_FETCH_CEILING = 25 * 1024 * 1024;

/** Absolute ceiling on inlined text-attachment bytes. The configurable
 *  inline cap (DISCORD_ATTACHMENT_INLINE_MAX_BYTES) clamps to this — however
 *  high the knob is set, a text attachment can never put more than 256KiB
 *  into context. */
export const MAX_TEXT_BYTES = 256 * 1024;
/** Default inline cap for text attachments (issue #30): 5KiB. */
export const DEFAULT_ATTACHMENT_INLINE_MAX_BYTES = 5120;

export interface NormalizedImage {
  data: string; // base64
  mimeType: string;
}

/** Downsample an image to model-max on ingest: resize so the longest edge is
 *  <= IMAGE_LONG_EDGE_MAX (never upscales), re-encoding to stay under the inline
 *  byte cap. Opaque images become JPEG; images with alpha stay PNG (flattened to
 *  JPEG only as a last resort to fit the cap). Already-small images pass through
 *  untouched. Animated GIFs are left as-is (frame resizing is out of scope) and
 *  inlined only when already under cap. Returns null when nothing inlinable can
 *  be produced, letting the caller degrade to a text note. */
export async function normalizeImageForInference(
  buf: Buffer,
  declaredCt: string | null,
): Promise<NormalizedImage | null> {
  try {
    const meta = await sharp(buf, { animated: true }).metadata();
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
    const isAnimated = (meta.pages ?? 1) > 1;
    // The pass-through fast paths below may ONLY emit formats the model API
    // accepts. sharp happily reads svg/tiff/avif/heif too — an SVG small
    // enough to skip re-encoding used to sail through as `image/svg` and
    // poison the agent's history with a permanently-400ing block (LabClaude,
    // 2026-07-11). Non-API formats now fall through to the re-encode
    // pipeline, which rasterizes them to PNG/JPEG.
    const API_SAFE_FORMATS = new Set(['jpeg', 'png', 'gif', 'webp']);
    const apiSafe = API_SAFE_FORMATS.has(meta.format ?? '');

    // Animated: don't resize frames here. Inline as-is if small enough.
    // (Animated non-gif/webp can't be inlined at all — degrade to the
    // caller's text note rather than emit an unacceptable media type.)
    if (isAnimated) {
      return apiSafe && buf.length <= IMAGE_OUTPUT_RAW_CAP
        ? { data: buf.toString('base64'), mimeType: `image/${meta.format}` }
        : null;
    }

    // Already within bounds and under cap → inline original bytes unchanged.
    if (apiSafe && longest > 0 && longest <= IMAGE_LONG_EDGE_MAX && buf.length <= IMAGE_OUTPUT_RAW_CAP) {
      return { data: buf.toString('base64'), mimeType: `image/${meta.format}` };
    }

    // Fresh pipeline per encode (sharp instances aren't safely reusable across
    // multiple toBuffer() calls). resize() with withoutEnlargement is a no-op
    // when the image is already within bounds but over the byte cap.
    const resizeOpts = { width: IMAGE_LONG_EDGE_MAX, height: IMAGE_LONG_EDGE_MAX, fit: 'inside' as const, withoutEnlargement: true };
    const base = () => sharp(buf).resize(resizeOpts);

    let out: Buffer;
    let mimeType: string;
    if (meta.hasAlpha) {
      out = await base().png({ compressionLevel: 9 }).toBuffer();
      mimeType = 'image/png';
    } else {
      out = await base().jpeg({ quality: IMAGE_JPEG_QUALITY }).toBuffer();
      mimeType = 'image/jpeg';
    }

    // Still over cap (large PNG / high-detail photo) → flatten + shrink harder.
    if (out.length > IMAGE_OUTPUT_RAW_CAP) {
      out = await sharp(buf)
        .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 70 })
        .toBuffer();
      mimeType = 'image/jpeg';
      if (out.length > IMAGE_OUTPUT_RAW_CAP) return null;
    }

    return { data: out.toString('base64'), mimeType };
  } catch {
    return null;
  }
}
