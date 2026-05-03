/**
 * Alters a JPEG image buffer so its MD5 hash changes without visible quality
 * loss. Mirrors Jarvee's "Alteration Level" feature to prevent Instagram from
 * detecting duplicate images on repost.
 *
 * Implementation uses pure Node.js (no image library required):
 *  - Injects a JPEG COM (Comment) segment right after the SOI marker with
 *    random bytes — completely invisible, but changes the hash and file size.
 *  - Medium/High additionally XOR a few bytes in the mid-scan data section.
 */
import { randomBytes } from "crypto";

export type AlterationLevel = "small" | "medium" | "high";

/** Number of COM comment bytes per level. */
const COMMENT_SIZE: Record<AlterationLevel, number> = {
  small:  8,
  medium: 32,
  high:   64,
};

/** Number of mid-stream bytes to XOR per level (0 = none). */
const FLIP_COUNT: Record<AlterationLevel, number> = {
  small:  0,
  medium: 3,
  high:   8,
};

/**
 * Returns an altered copy of the JPEG buffer.
 * If the input is not a valid JPEG (does not start with FF D8) it is returned
 * unchanged so the caller can still attempt the upload.
 */
export function alterJpegBuffer(input: Buffer, level: AlterationLevel): Buffer {
  // Validate JPEG SOI marker
  if (input.length < 4 || input[0] !== 0xFF || input[1] !== 0xD8) return input;

  // Build JPEG COM segment: FF FE [len_hi] [len_lo] [random_bytes]
  // Length field includes the 2 bytes for the length field itself.
  const commentBytes = randomBytes(COMMENT_SIZE[level]);
  const segmentLen   = 2 + COMMENT_SIZE[level];
  const comSegment   = Buffer.allocUnsafe(2 + 2 + COMMENT_SIZE[level]);
  comSegment[0] = 0xFF;
  comSegment[1] = 0xFE;
  comSegment[2] = (segmentLen >> 8) & 0xFF;
  comSegment[3] =  segmentLen       & 0xFF;
  commentBytes.copy(comSegment, 4);

  // Insert COM segment immediately after SOI (byte offset 2)
  const result = Buffer.concat([input.subarray(0, 2), comSegment, input.subarray(2)]);

  // For medium/high: XOR a handful of bytes in the middle of the scan data
  // to further increase hash distance. Avoid 0xFF to prevent spurious markers.
  const flipCount = FLIP_COUNT[level];
  if (flipCount > 0) {
    const start = Math.floor(result.length * 0.4);
    const range = Math.floor(result.length * 0.4); // 40%–80% of file
    for (let i = 0; i < flipCount; i++) {
      const offset = start + Math.floor(Math.random() * range);
      if (offset >= result.length - 2) continue; // safety
      const flipped = (result[offset] ^ (0x01 + (i % 7))) & 0xFF;
      result[offset] = flipped === 0xFF ? 0xFE : flipped;
    }
  }

  return result;
}
