/**
 * fixAiSlop.ts — Strip AI-detectable signals from images before posting.
 *
 * ── What we strip and why ─────────────────────────────────────────────────────
 *
 * Instagram's "Made with AI" label is driven by metadata signals embedded in
 * the file's binary structure.  We remove ALL of them:
 *
 *   C2PA / Content Credentials (ChatGPT, Google Imagen, Adobe Firefly)
 *   ─────────────────────────────────────────────────────────────────
 *   • JPEG  — APP11 (0xFFEB) segments whose payload starts with the ISO 19566-5
 *             Common Identifier bytes "JP" (0x4A 0x50).
 *   • PNG   — "caBX" ancillary chunks (JUMBF container).
 *   • WebP  — "C2PA" and "JUMB" RIFF chunks.
 *
 *   EXIF metadata (Grok / xAI, and most AI image generators)
 *   ─────────────────────────────────────────────────────────
 *   • JPEG  — APP1 (0xFFE1) segments starting with "Exif\0".
 *   • PNG   — "eXIf" ancillary chunks.
 *   • WebP  — "EXIF" RIFF chunk.
 *
 *   XMP / Content Credentials fallback (ChatGPT DALL-E, Google, Adobe)
 *   ──────────────────────────────────────────────────────────────────
 *   • JPEG  — APP1 (0xFFE1) starting with the Adobe XMP namespace URI.
 *             APP1 starting with "W5M0MpCehiHzreSzNTczkc9d" (extended XMP).
 *   • PNG   — "iTXt" chunks containing "XML:com.adobe.xmp".
 *             "tEXt" chunks with key "XML:com.adobe.xmp".
 *   • WebP  — "XMP " RIFF chunk.
 *
 *   IPTC / Photoshop IRB (some AI tools embed provenance here)
 *   ──────────────────────────────────────────────────────────
 *   • JPEG  — APP13 (0xFFED) segments.
 *
 * ── Strategy ────────────────────────────────────────────────────────────────
 *
 * ALL metadata stripping is done at binary level (no external dependencies).
 * This means it works on every platform — Windows/Electron included — even if
 * Sharp's native binary is unavailable.
 *
 * If Sharp IS available an additional pixel-perturbation pass (makeUniqueImage)
 * is applied to defeat SynthID pixel-level watermarks (Google Imagen, ChatGPT
 * DALL-E) which are embedded in the pixel data and survive metadata stripping.
 * The perturbation is imperceptible but shifts spatial frequencies and pixel
 * statistics enough to break the watermark signal.
 */

import { randomBytes } from "crypto";
import { readFile, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { makeUniqueImage } from "./makeUnique";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function bufStartsWith(buf: Buffer, off: number, prefix: string | number[]): boolean {
  if (typeof prefix === "string") {
    for (let i = 0; i < prefix.length; i++) {
      if (off + i >= buf.length) return false;
      if (buf[off + i] !== prefix.charCodeAt(i)) return false;
    }
    return true;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (off + i >= buf.length) return false;
    if (buf[off + i] !== prefix[i]) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// JPEG — strip C2PA, EXIF, XMP, IPTC in one binary pass
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strips all AI-related metadata from a JPEG buffer:
 *   APP11 "JP..."  → C2PA / JUMBF
 *   APP1  "Exif\0" → EXIF
 *   APP1  "http://ns.adobe.com/xap" → XMP standard
 *   APP1  "W5M0..."                 → Extended XMP
 *   APP13 (any)   → IPTC / Photoshop IRB
 */
function stripJpegAiMeta(buf: Buffer): { buf: Buffer; removed: number } {
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return { buf, removed: 0 };
  }

  const out: number[] = [0xff, 0xd8];
  let removed = 0;
  let off = 2;

  while (off < buf.length - 1) {
    if (buf[off] !== 0xff) {
      for (let i = off; i < buf.length; i++) out.push(buf[i]);
      break;
    }

    const marker = buf.readUInt16BE(off);

    // SOI / EOI / RST — no length field
    if (
      marker === 0xffd8 ||
      marker === 0xffd9 ||
      (marker >= 0xffd0 && marker <= 0xffd7)
    ) {
      out.push(0xff, marker & 0xff);
      off += 2;
      if (marker === 0xffd9) break;
      continue;
    }

    // SOS — rest of buffer is entropy-coded data; copy verbatim
    if (marker === 0xffda) {
      for (let i = off; i < buf.length; i++) out.push(buf[i]);
      break;
    }

    // All other segments have a 2-byte length field
    if (off + 3 >= buf.length) break;
    const segLen = buf.readUInt16BE(off + 2); // includes the 2 length bytes
    const segEnd = Math.min(off + 2 + segLen, buf.length);
    const dataOff = off + 4; // first data byte (after FF XX LL LL)

    // ── Decide whether to strip this segment ──────────────────────────────

    let strip = false;

    // APP11 (FF EB) — C2PA/JUMBF: payload starts with "JP" (ISO 19566-5 CI)
    if (marker === 0xffeb && segLen >= 4) {
      strip = bufStartsWith(buf, dataOff, [0x4a, 0x50]); // "JP"
    }

    // APP1 (FF E1) — EXIF, XMP, or Extended XMP
    else if (marker === 0xffe1 && segLen >= 6) {
      strip = (
        bufStartsWith(buf, dataOff, "Exif\0") ||                      // EXIF
        bufStartsWith(buf, dataOff, "http://ns.adobe.com/xap") ||     // XMP standard
        bufStartsWith(buf, dataOff, "W5M0MpCehiHzreSzNTczkc9d")      // Extended XMP
      );
    }

    // APP13 (FF ED) — IPTC / Photoshop IRB
    else if (marker === 0xffed) {
      strip = true;
    }

    if (strip) {
      removed++;
      off = segEnd;
      continue;
    }

    // Copy segment unchanged
    for (let i = off; i < segEnd; i++) out.push(buf[i]);
    off = segEnd;
  }

  return { buf: Buffer.from(out), removed };
}

// ─────────────────────────────────────────────────────────────────────────────
// PNG — strip C2PA, EXIF, XMP
// ─────────────────────────────────────────────────────────────────────────────

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

/** Strip all AI-related chunks from a PNG buffer. */
function stripPngAiMeta(buf: Buffer): { buf: Buffer; removed: number } {
  if (buf.length < 8) return { buf, removed: 0 };
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIG[i]) return { buf, removed: 0 };
  }

  const out: number[] = [...PNG_SIG];
  let removed = 0;
  let off = 8;

  while (off + 12 <= buf.length) {
    const dataLen   = buf.readUInt32BE(off);
    const chunkType = buf.slice(off + 4, off + 8).toString("ascii");
    const totalSize = 4 + 4 + dataLen + 4; // len + type + data + CRC

    let strip = false;

    // caBX — C2PA / JUMBF
    if (chunkType === "caBX") strip = true;

    // eXIf — EXIF data embedded in PNG
    else if (chunkType === "eXIf") strip = true;

    // iTXt — could be XMP ("XML:com.adobe.xmp")
    else if (chunkType === "iTXt" && dataLen > 18) {
      strip = bufStartsWith(buf, off + 8, "XML:com.adobe.xmp");
    }

    // tEXt — older XMP embedding
    else if (chunkType === "tEXt" && dataLen > 18) {
      strip = bufStartsWith(buf, off + 8, "XML:com.adobe.xmp");
    }

    if (strip) {
      removed++;
      off += totalSize;
      continue;
    }

    const end = Math.min(off + totalSize, buf.length);
    for (let i = off; i < end; i++) out.push(buf[i]);

    if (chunkType === "IEND") break;
    off += totalSize;
  }

  return { buf: Buffer.from(out), removed };
}

// ─────────────────────────────────────────────────────────────────────────────
// WebP — strip C2PA, EXIF, XMP
// ─────────────────────────────────────────────────────────────────────────────

const WEBP_AI_CHUNKS = new Set(["C2PA", "JUMB", "EXIF", "XMP "]);

/** Strip all AI-related RIFF chunks from a WebP buffer. */
function stripWebpAiMeta(buf: Buffer): { buf: Buffer; removed: number } {
  if (buf.length < 12) return { buf, removed: 0 };
  if (buf.slice(0, 4).toString("ascii") !== "RIFF") return { buf, removed: 0 };
  if (buf.slice(8, 12).toString("ascii") !== "WEBP") return { buf, removed: 0 };

  const bodyChunks: Buffer[] = [];
  let removed = 0;
  let off = 12;

  while (off + 8 <= buf.length) {
    const type       = buf.slice(off, off + 4).toString("ascii");
    const dataSize   = buf.readUInt32LE(off + 4);
    const paddedSize = dataSize + (dataSize & 1);
    const chunkEnd   = off + 8 + paddedSize;

    if (WEBP_AI_CHUNKS.has(type)) {
      removed++;
      off = Math.min(chunkEnd, buf.length);
      continue;
    }

    bodyChunks.push(buf.slice(off, Math.min(chunkEnd, buf.length)));
    off = Math.min(chunkEnd, buf.length);
  }

  if (removed === 0) return { buf, removed: 0 };

  const body = Buffer.concat(bodyChunks);
  const out  = Buffer.alloc(12 + body.length);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(4 + body.length, 4);
  out.write("WEBP", 8, "ascii");
  body.copy(out, 12);
  return { buf: out, removed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Format detection
// ─────────────────────────────────────────────────────────────────────────────

type ImageFormat = "jpeg" | "png" | "webp" | "unknown";

function detectFormat(buf: Buffer): ImageFormat {
  if (buf.length < 4) return "unknown";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  if (buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71) return "png";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "webp";
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strips all AI-detectable signals from an image file and returns the path of
 * a processed temp file. If processing fails, the error is propagated so FIA
 * never silently uploads the original image after a failed processing attempt.
 *
 * The caller MUST call cleanupAiSlopTemp() after using the returned path.
 *
 * Pipeline:
 *   Step 1 (always) — Binary strip: C2PA, EXIF, XMP, IPTC removed at byte
 *                     level.  Works on all platforms without any native deps.
 *   Step 2 (if Sharp available) — Pixel perturbation: 7-layer makeUniqueImage
 *                     pass to defeat SynthID pixel-level watermarks and CNN-
 *                     based perceptual hash detectors.
 */
export async function fixAiSlop(
  inputPath: string,
  onLog?: (message: string) => void,
): Promise<string> {
  const tmp = join(
    tmpdir(),
    `equinox_fixaislop_${randomBytes(8).toString("hex")}.jpg`,
  );

  try {
    const raw = await readFile(inputPath);
    const fmt = detectFormat(raw);

    // ── Step 1: Binary metadata strip (platform-independent) ──────────────
    let stripped: Buffer;
    let removedCount = 0;

    if (fmt === "jpeg") {
      const r = stripJpegAiMeta(raw);
      stripped     = r.buf;
      removedCount = r.removed;
    } else if (fmt === "png") {
      const r = stripPngAiMeta(raw);
      stripped     = r.buf;
      removedCount = r.removed;
    } else if (fmt === "webp") {
      const r = stripWebpAiMeta(raw);
      stripped     = r.buf;
      removedCount = r.removed;
    } else {
      // Unknown format — pass through as-is
      stripped = raw;
    }

    console.log(
      `[fixAiSlop] binary strip — format=${fmt}, removed ${removedCount} AI metadata block(s)`,
    );
    onLog?.(`Fix AI Slop: binary strip complete — format=${fmt}, removed ${removedCount} metadata block(s)`);

    // ── Step 2: Sharp pixel perturbation (optional, defeats SynthID) ──────
    // If Sharp is unavailable (e.g. Electron on Windows without native binary)
    // we still write the binary-stripped file, which covers C2PA, EXIF, and
    // XMP — the primary triggers for Instagram's "Made with AI" label.
    let sharp: any;
    try {
      sharp = (await import("sharp")).default;
    } catch {
      await writeFile(tmp, stripped);
      console.log(`[fixAiSlop] Sharp unavailable — binary strip only (no pixel perturbation)`);
      onLog?.("Fix AI Slop: WARNING — Sharp unavailable; only metadata stripping ran, no pixel perturbation");
      return tmp;
    }

    // 2a: Re-encode via Sharp to strip any remaining metadata (ICC profiles,
    //     residual EXIF that the binary pass may have missed in edge cases)
    //     and normalise to JPEG for the pixel-perturbation step.
    const quality = 85 + Math.floor(Math.random() * 8); // 85–92
    const reencoded: Buffer = await sharp(stripped)
      .withMetadata(false)
      .jpeg({ quality, chromaSubsampling: "4:2:0", force: true })
      .toBuffer();

    // 2b: 7-layer pixel-perturbation — defeats SynthID and CNN-based perceptual
    //     hash detectors.  Imperceptible to the human eye.
    const finalBuf = await makeUniqueImage(reencoded);
    await writeFile(tmp, finalBuf);

    console.log(
      `[fixAiSlop] done — format=${fmt}, quality=${quality}, binary-stripped ${removedCount} block(s), pixel-perturbed`,
    );
    onLog?.(`Fix AI Slop: full processing complete — JPEG quality ${quality}, pixel perturbation applied`);
    return tmp;
  } catch (err) {
    console.error("[fixAiSlop] failed:", err);
    await unlink(tmp).catch(() => {});
    throw new Error(`Fix AI Slop processing failed: ${(err as Error)?.message ?? String(err)}`);
  }
}

/**
 * Deletes the temp file produced by fixAiSlop, but only if it differs from
 * the original input path.  Safe to call even when fixAiSlop fell back to
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
