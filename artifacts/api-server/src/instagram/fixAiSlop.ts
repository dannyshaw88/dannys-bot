/**
 * fixAiSlop.ts — Strip AI-detectable signals from images before posting.
 *
 * Instagram's "AI info" label is triggered by three distinct detection vectors.
 * This module targets all three, including markers specific to Google Gemini
 * Image Creator (the most common source of images in this workflow).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * VECTOR 1 — Metadata (C2PA / EXIF / XMP / IPTC)
 * ──────────────────────────────────────────────────────────────────────────
 * AI generators embed software tags ("DALL-E 3", "Midjourney v6", "Stable
 * Diffusion XL") and C2PA cryptographic manifests — a standardised
 * proof-of-AI-origin written by Adobe Firefly, Google ImageFX, Bing Image
 * Creator, Gemini, and others. C2PA is stored in JPEG APP11 (JUMBF
 * container), which some tools miss.
 *
 * Fix: decode the source to a PNG buffer first. PNG has no JPEG APP segment
 * structure, so the conversion unconditionally destroys every JPEG APP
 * segment — including APP11/JUMBF. The subsequent JPEG re-encode is built
 * from raw pixels; with withMetadata(false) it contains nothing.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * VECTOR 2 — Visible watermark (Gemini sparkle logo, bottom-right corner)
 * ──────────────────────────────────────────────────────────────────────────
 * Google Gemini Image Creator places a small diagonal sparkle/Gemini
 * logomark in the lower-right corner of every downloaded full-resolution
 * image. Instagram (and other platforms) can detect this visually.
 *
 * Fix: after decoding, crop a randomised 4–7 % strip from the right edge
 * and 4–7 % strip from the bottom edge. At 1024 × 1024 (Gemini's native
 * output), 5 % = ~51 px — enough to eliminate the logo badge entirely. The
 * crop percentage is randomised within the range so repeated posts do not
 * share an identical bounding box.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * VECTOR 3 — Steganographic / invisible watermarks (SynthID + DCT)
 * ──────────────────────────────────────────────────────────────────────────
 * Gemini uses Google DeepMind's SynthID — a spread-spectrum invisible
 * watermark embedded into the image's pixel values during generation.
 * SynthID is designed to survive JPEG compression, colour adjustments, and
 * moderate cropping (it has a published tolerance of ~50 % crop by area).
 * Other generators use DCT-domain watermarks (Stable Diffusion, Midjourney)
 * that are less robust.
 *
 * Fix (layered):
 *  a. Edge crop (Vector 2 crop above) removes part of the spatial payload.
 *  b. Sub-pixel Gaussian blur σ 0.5–1.2 attenuates high-frequency components
 *     the watermark signal relies on.
 *  c. Full HSL micro-jitter (hue ±3°, saturation ±4%, brightness ±0.3%)
 *     shifts per-channel statistics away from the known generator signature.
 *  d. First JPEG re-encode at quality 88–95 re-quantises DCT coefficients,
 *     destroying standard DCT steganography.
 *  e. Second JPEG re-encode at quality 72–82 — a lower quality than the
 *     first pass. SynthID researchers have noted the signal degrades
 *     significantly below JPEG quality 80; a double-quantisation pass at
 *     different step tables maximises disruption without visible artefacts
 *     at Instagram's final display resolution.
 */

import { randomBytes } from "crypto";
import { readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Processes an image to strip AI-detectable signals and returns the path of
 * a processed temp file. If the input path is returned unchanged, either
 * sharp was unavailable or processing failed — no temp file was created.
 *
 * The caller MUST call cleanupAiSlopTemp() after using the result.
 */
export async function fixAiSlop(inputPath: string): Promise<string> {
  let sharp: any;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    return inputPath; // sharp unavailable — pass through unmodified
  }

  const tmp = join(
    tmpdir(),
    `equinox_fixaislop_${randomBytes(8).toString("hex")}.jpg`,
  );

  try {
    const buf = await readFile(inputPath);

    // ── Randomised processing parameters ───────────────────────────────────

    // Sub-pixel blur σ 0.5–1.2 (invisible at σ ≤ ~1.5 in screen-res output)
    const blurSigma = parseFloat((0.5 + Math.random() * 0.7).toFixed(2));

    // Hue rotation: ±3 degrees
    const hueDeg = Math.floor(Math.random() * 7) - 3;

    // Saturation multiplier: 0.96–1.04 (±4 %)
    const satMod = parseFloat((0.96 + Math.random() * 0.08).toFixed(3));

    // Brightness multiplier: 0.997–1.003 (±0.3 %)
    const brightnessMod = parseFloat((0.997 + Math.random() * 0.006).toFixed(4));

    // First JPEG quality: 88–95 — destroys DCT steganography
    const quality1 = 88 + Math.floor(Math.random() * 8);

    // Second JPEG quality: 72–82 — degrades SynthID signal below its
    // published survival threshold while remaining visually acceptable
    // (Instagram recompresses on upload anyway)
    const quality2 = 72 + Math.floor(Math.random() * 11);

    // Random noise crops — small per-side values for all four edges
    const cropL = 1 + Math.floor(Math.random() * 3);
    const cropT = 1 + Math.floor(Math.random() * 3);

    // Bottom + right: larger crops to remove Gemini visible watermark logo.
    // 4–7 % of image dimension, computed after we know the image size.

    // ── Step 1: decode → PNG (strips ALL JPEG APP segments, incl. APP11/C2PA)
    const pngBuf: Buffer = await sharp(buf)
      .withMetadata(false)
      .png({ compressionLevel: 1, force: true })
      .toBuffer();

    // ── Step 2: get dimensions for safe cropping ──────────────────────────
    const meta = await sharp(pngBuf).metadata();
    const origW = meta.width ?? 0;
    const origH = meta.height ?? 0;

    // Bottom-right watermark crop: 4–7 % per side, randomised
    const cropR = Math.round(origW * (0.04 + Math.random() * 0.03));
    const cropB = Math.round(origH * (0.04 + Math.random() * 0.03));

    const w = origW - cropL - cropR;
    const h = origH - cropT - cropB;

    // ── Step 3: first JPEG encode — crop + blur + colour jitter ──────────
    const pass1Buf: Buffer = w > 100 && h > 100
      ? await sharp(pngBuf)
          .withMetadata(false)
          .extract({ left: cropL, top: cropT, width: w, height: h })
          .blur(blurSigma)
          .modulate({ brightness: brightnessMod, hue: hueDeg, saturation: satMod })
          .jpeg({ quality: quality1, chromaSubsampling: "4:2:0", force: true })
          .toBuffer()
      : await sharp(pngBuf)
          .withMetadata(false)
          .blur(blurSigma)
          .modulate({ brightness: brightnessMod, hue: hueDeg, saturation: satMod })
          .jpeg({ quality: quality1, chromaSubsampling: "4:2:0", force: true })
          .toBuffer();

    // ── Step 4: second JPEG encode — lower quality, different quant table ─
    await sharp(pass1Buf)
      .withMetadata(false)
      .jpeg({ quality: quality2, chromaSubsampling: "4:2:0", force: true })
      .toFile(tmp);

    return tmp;
  } catch {
    await unlink(tmp).catch(() => {});
    return inputPath;
  }
}

/**
 * Deletes the temp file produced by fixAiSlop, but only if it is different
 * from the original input path (i.e. processing actually produced a new file).
 * Safe to call even when fixAiSlop fell back to returning the original path.
 */
export async function cleanupAiSlopTemp(
  tmpPath: string,
  originalPath: string,
): Promise<void> {
  if (tmpPath !== originalPath) {
    await unlink(tmpPath).catch(() => {});
  }
}
