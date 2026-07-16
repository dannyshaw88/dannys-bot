/**
 * fixAiSlop.ts — Strip AI-detectable signals from images before posting.
 *
 * ── What actually works (learned from unmadewithai.com) ──────────────────────
 * Instagram's "Made with AI" label is driven primarily by C2PA metadata —
 * a cryptographic manifest embedded in the file's binary structure:
 *
 *   • JPEG  — APP11 segment (marker 0xFFEB) whose payload starts with "JP"
 *             (JUMBF container, per ISO 19566-5).
 *   • PNG   — "caBX" ancillary chunk (JUMBF container embedded in PNG).
 *   • WebP  — "C2PA" or "JUMB" RIFF chunk inside the RIFF container.
 *
 * The reliable fix is binary-level chunk/segment removal — walk the file
 * structure, excise only the C2PA chunks, leave all pixel data untouched.
 * No downscaling, no noise injection, no recompression artefacts.
 * This is what unmadewithai.com does, and it passes Instagram detection.
 *
 * After binary stripping we do ONE light Sharp pass (withMetadata:false) to
 * remove any residual EXIF / XMP / ICC metadata and produce the final JPEG.
 * Quality is kept high (85–92) so the image looks clean on-screen; Instagram
 * recompresses everything on ingest anyway.
 *
 * Previous approach (heavy downscale → upscale → dual JPEG) was retired
 * because: (a) it did not reliably pass detection, and (b) it introduced
 * visible quality loss that made images look worse than the binary-strip path.
 */

import { randomBytes } from "crypto";
import { readFile, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Binary C2PA / JUMBF strippers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strips JUMBF/C2PA containers from a JPEG buffer.
 *
 * JPEG structure: FF D8 [segments…] FF DA [entropy-coded data] FF D9
 * Each segment: [FF][marker][2-byte big-endian length incl. the 2 len bytes][data]
 *
 * APP11 (FF EB) whose payload begins with 0x4A 0x50 ("JP") is the JUMBF
 * container used by C2PA. We skip those segments and copy everything else.
 */
function stripJpegC2pa(buf: Buffer): Buffer {
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;

  const out: number[] = [0xff, 0xd8];
  let removed = 0;
  let off = 2;

  while (off < buf.length - 1) {
    if (buf[off] !== 0xff) {
      // Shouldn't happen in a valid JPEG; copy the rest and stop
      for (let i = off; i < buf.length; i++) out.push(buf[i]);
      break;
    }

    const marker = buf.readUInt16BE(off);

    // SOI / EOI / RST markers — no length field
    if (
      marker === 0xffd8 || // SOI (already handled)
      marker === 0xffd9 || // EOI
      (marker >= 0xffd0 && marker <= 0xffd7) // RST0–RST7
    ) {
      out.push(0xff, marker & 0xff);
      off += 2;
      if (marker === 0xffd9) break;
      continue;
    }

    // SOS — rest of the buffer is entropy-coded; copy verbatim
    if (marker === 0xffda) {
      for (let i = off; i < buf.length; i++) out.push(buf[i]);
      break;
    }

    // All other segments have a 2-byte length
    if (off + 3 >= buf.length) break;
    const segLen = buf.readUInt16BE(off + 2); // includes the 2 length bytes
    const segEnd = off + 2 + segLen; // exclusive

    // APP11 (FF EB) — check for JUMBF/C2PA "JP" prefix
    if (marker === 0xffeb && segLen >= 4) {
      const p0 = buf[off + 4]; // first data byte (after FF EB LL LL)
      const p1 = buf[off + 5];
      if (p0 === 0x4a && p1 === 0x50) {
        // "JP" — this is a JUMBF/C2PA segment; skip it
        removed++;
        off = Math.min(segEnd, buf.length);
        continue;
      }
    }

    // Copy segment as-is
    for (let i = off; i < Math.min(segEnd, buf.length); i++) out.push(buf[i]);
    off = Math.min(segEnd, buf.length);
  }

  if (removed > 0) {
    console.log(`[fixAiSlop] JPEG: removed ${removed} JUMBF/C2PA APP11 segment(s)`);
  }
  return Buffer.from(out);
}

/**
 * Strips JUMBF/C2PA containers from a PNG buffer.
 *
 * PNG structure: 8-byte signature + [chunks…]
 * Each chunk: [4-byte big-endian data length][4-byte type][data][4-byte CRC]
 *
 * "caBX" is the chunk type used for JUMBF containers (C2PA).
 */
function stripPngC2pa(buf: Buffer): Buffer {
  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buf.length < 8) return buf;
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIG[i]) return buf;
  }

  const out: number[] = [...PNG_SIG];
  let removed = 0;
  let off = 8;

  while (off + 12 <= buf.length) {
    const dataLen = buf.readUInt32BE(off);
    const chunkType = buf.slice(off + 4, off + 8).toString("ascii");
    const totalSize = 4 + 4 + dataLen + 4; // len + type + data + CRC

    if (chunkType === "caBX") {
      // JUMBF/C2PA chunk — skip
      removed++;
      off += totalSize;
      continue;
    }

    // Copy chunk as-is
    const end = Math.min(off + totalSize, buf.length);
    for (let i = off; i < end; i++) out.push(buf[i]);

    if (chunkType === "IEND") break;
    off += totalSize;
  }

  if (removed > 0) {
    console.log(`[fixAiSlop] PNG: removed ${removed} caBX JUMBF/C2PA chunk(s)`);
  }
  return Buffer.from(out);
}

/**
 * Strips C2PA containers from a WebP (RIFF) buffer.
 *
 * RIFF structure: "RIFF"[4-byte LE file size]"WEBP"[chunks…]
 * Each chunk: [4-byte type][4-byte LE data size][data (padded to even)]
 *
 * Chunks to remove: "C2PA", "JUMB" (JUMBF container in WebP).
 */
function stripWebpC2pa(buf: Buffer): Buffer {
  if (buf.length < 12) return buf;
  const riff = buf.slice(0, 4).toString("ascii");
  const webp = buf.slice(8, 12).toString("ascii");
  if (riff !== "RIFF" || webp !== "WEBP") return buf;

  const C2PA_CHUNKS = new Set(["C2PA", "JUMB"]);
  const bodyChunks: Buffer[] = [];
  let removed = 0;
  let off = 12;

  while (off + 8 <= buf.length) {
    const type = buf.slice(off, off + 4).toString("ascii");
    const dataSize = buf.readUInt32LE(off + 4);
    const paddedSize = dataSize + (dataSize & 1); // RIFF chunks are word-aligned
    const chunkEnd = off + 8 + paddedSize;

    if (C2PA_CHUNKS.has(type)) {
      removed++;
      off = Math.min(chunkEnd, buf.length);
      continue;
    }

    bodyChunks.push(buf.slice(off, Math.min(chunkEnd, buf.length)));
    off = Math.min(chunkEnd, buf.length);
  }

  if (removed === 0) return buf;

  console.log(`[fixAiSlop] WebP: removed ${removed} C2PA/JUMB chunk(s)`);

  // Rebuild RIFF container
  const body = Buffer.concat(bodyChunks);
  const out = Buffer.alloc(12 + body.length);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(4 + body.length, 4); // file size field
  out.write("WEBP", 8, "ascii");
  body.copy(out, 12);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Format detection
// ─────────────────────────────────────────────────────────────────────────────

type ImageFormat = "jpeg" | "png" | "webp" | "unknown";

function detectFormat(buf: Buffer): ImageFormat {
  if (buf.length < 4) return "unknown";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  if (
    buf[0] === 137 &&
    buf[1] === 80 &&
    buf[2] === 78 &&
    buf[3] === 71
  )
    return "png";
  if (
    buf.slice(0, 4).toString("ascii") === "RIFF" &&
    buf.slice(8, 12).toString("ascii") === "WEBP"
  )
    return "webp";
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strips AI-detectable signals from an image file and returns the path of a
 * processed temp file. If the input cannot be processed, the original path is
 * returned unchanged and no temp file is created.
 *
 * The caller MUST call cleanupAiSlopTemp() after using the result.
 */
export async function fixAiSlop(inputPath: string): Promise<string> {
  const tmp = join(
    tmpdir(),
    `equinox_fixaislop_${randomBytes(8).toString("hex")}.jpg`,
  );

  try {
    const raw = await readFile(inputPath);
    const fmt = detectFormat(raw);

    // ── Step 1: Binary C2PA / JUMBF strip ──────────────────────────────────
    // Walk the file structure and excise only the C2PA metadata containers.
    // Pixels are completely untouched at this stage.
    let stripped: Buffer;
    if (fmt === "jpeg") {
      stripped = stripJpegC2pa(raw);
    } else if (fmt === "png") {
      stripped = stripPngC2pa(raw);
    } else if (fmt === "webp") {
      stripped = stripWebpC2pa(raw);
    } else {
      // Unknown format — pass through
      stripped = raw;
    }

    // ── Step 2: Sharp pass — strip residual EXIF / XMP / ICC + JPEG encode ─
    // withMetadata(false) removes APP1/EXIF, XMP, ICC profiles.
    // A single JPEG encode at quality 85–92 is enough to clean up any
    // remaining metadata while keeping visible quality high.
    let sharp: any;
    try {
      sharp = (await import("sharp")).default;
    } catch {
      // Sharp unavailable — write binary-stripped file and return
      await writeFile(tmp, stripped);
      return tmp;
    }

    const quality = 85 + Math.floor(Math.random() * 8); // 85–92
    await sharp(stripped)
      .withMetadata(false)
      .jpeg({ quality, chromaSubsampling: "4:2:0", force: true })
      .toFile(tmp);

    console.log(`[fixAiSlop] done — format=${fmt} jpegQuality=${quality}`);
    return tmp;
  } catch (err) {
    console.error("[fixAiSlop] failed:", err);
    await unlink(tmp).catch(() => {});
    return inputPath;
  }
}

/**
 * Deletes the temp file produced by fixAiSlop, but only if it differs from
 * the original input path. Safe to call even when fixAiSlop fell back to
 * returning the original path.
 */
export async function cleanupAiSlopTemp(
  tmpPath: string,
  originalPath: string,
): Promise<void> {
  if (tmpPath !== originalPath) {
    await unlink(tmpPath).catch(() => {});
  }
}
