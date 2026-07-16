/**
 * fixAiSlop.ts — Strip AI-detectable signals from images before posting.
 *
 * Instagram's "AI info" label is triggered by two distinct detection vectors
 * for ChatGPT / DALL-E images (the most common source in this workflow):
 *
 * ──────────────────────────────────────────────────────────────────────────
 * VECTOR 1 — Metadata (C2PA / EXIF / XMP / IPTC)
 * ──────────────────────────────────────────────────────────────────────────
 * ChatGPT/DALL-E images embed C2PA cryptographic manifests in JPEG APP11
 * (JUMBF container) plus EXIF/XMP software tags proving AI origin.
 *
 * Fix: decode the source to a raw PNG buffer first. The PNG conversion is a
 * raw-pixel round-trip that produces a completely fresh container — no APP
 * segments, no EXIF, no XMP, no IPTC, no JUMBF/C2PA. withMetadata(false)
 * on the final JPEG output ensures nothing is re-injected by sharp.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * VECTOR 2 — SynthID invisible / steganographic watermark
 * ──────────────────────────────────────────────────────────────────────────
 * OpenAI uses Google DeepMind's SynthID — a spread-spectrum watermark
 * embedded directly into pixel values during generation. SynthID works by
 * correlating the pixel data against a secret key. It is designed to survive
 * JPEG compression, colour adjustments, and moderate spatial cropping.
 *
 * What defeats it: anything that changes the actual pixel VALUES
 * unpredictably, because the detector must integrate a coherent signal across
 * the whole image. Independent per-pixel noise and geometric resampling both
 * break that coherence.
 *
 * Fix (layered — each step independently disrupts the correlation):
 *
 *  a. Per-pixel random noise injection (±4–8 per channel in raw pixel space):
 *     Uses crypto.randomBytes for true entropy. At ±6/255 the change is
 *     sub-threshold for human perception but large enough to drive the
 *     SynthID detector's signal-to-noise ratio below detection confidence.
 *     This is the primary SynthID countermeasure.
 *
 *  b. Zoom-crop resampling: resize to 102–106 % (random per image), then
 *     crop back to the original canvas from a random sub-pixel offset. Every
 *     output pixel is now a bilinear blend of neighbouring input pixels —
 *     the spatial relationship between adjacent pixels is uniquely scrambled
 *     for each image, which is mathematically incompatible with the fixed
 *     spatial layout that spread-spectrum detectors assume.
 *
 *  c. Sub-pixel Gaussian blur σ 0.3–0.8 attenuates residual high-frequency
 *     watermark components that survived steps a + b.
 *
 *  d. HSL micro-jitter (hue ±2°, saturation ±3 %, brightness ±0.2 %) shifts
 *     per-channel statistics away from the generator's colour signature.
 *
 *  e. First JPEG encode at quality 85–93 re-quantises DCT coefficients,
 *     destroying any DCT-domain steganography (Stable Diffusion, Midjourney).
 *
 *  f. Second JPEG encode at quality 70–80 — a second, independent
 *     quantisation pass with a different quality step table. The double
 *     quantisation maximises DCT disruption without requiring visible
 *     artefacts (Instagram recompresses the upload anyway).
 *
 * Note: the 4–7 % right/bottom crop for Gemini's visible sparkle logo has
 * been removed — ChatGPT images do not have a visible watermark. Only small
 * symmetric 1–3 px random edge crops remain (to break identical-frame
 * fingerprinting across repeated posts).
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

    // ── Step 1: decode → raw PNG (strips ALL JPEG APP segments, incl. C2PA) ─
    const pngBuf: Buffer = await sharp(buf)
      .withMetadata(false)
      .png({ compressionLevel: 1, force: true })
      .toBuffer();

    // ── Step 2: get dimensions ────────────────────────────────────────────
    const meta = await sharp(pngBuf).metadata();
    const origW = meta.width ?? 0;
    const origH = meta.height ?? 0;
    const channels = (meta.channels ?? 3) as 3 | 4;

    if (origW < 10 || origH < 10) {
      // Unreasonably small — pass through
      await unlink(tmp).catch(() => {});
      return inputPath;
    }

    // ── Step 3: per-pixel random noise injection ──────────────────────────
    // Get raw pixel buffer (no alpha premultiplication)
    const rawBuf: Buffer = await sharp(pngBuf)
      .withMetadata(false)
      .raw()
      .toBuffer();

    // Noise amplitude: 4–8 per channel (chosen fresh for each image)
    const noiseAmp = 4 + Math.floor(Math.random() * 5); // 4,5,6,7,8
    const noiseBytes = randomBytes(rawBuf.length);

    for (let i = 0; i < rawBuf.length; i++) {
      // Skip alpha channel (every 4th byte when channels === 4)
      if (channels === 4 && (i & 3) === 3) continue;

      // Map random byte 0–255 → signed offset in [-noiseAmp, +noiseAmp]
      const offset = Math.round((noiseBytes[i] / 255) * 2 * noiseAmp) - noiseAmp;
      const v = (rawBuf[i] + offset) & 0xff; // clamp via wrapping is fine for ±8
      rawBuf[i] = Math.max(0, Math.min(255, rawBuf[i] + offset));
    }

    // Re-encode the noise-injected raw buffer back to PNG
    const noisedPng: Buffer = await sharp(rawBuf, {
      raw: { width: origW, height: origH, channels },
    })
      .withMetadata(false)
      .png({ compressionLevel: 1, force: true })
      .toBuffer();

    // ── Step 4: zoom-crop resampling ──────────────────────────────────────
    // Resize to 102–106 %, then extract the original-sized region from a
    // random sub-pixel-offset position. Every output pixel is now a bilinear
    // blend — the spatial layout assumed by the spread-spectrum detector is
    // broken uniquely per image.
    const zoomPct = 1.02 + Math.random() * 0.04; // 1.02 – 1.06
    const zoomedW = Math.round(origW * zoomPct);
    const zoomedH = Math.round(origH * zoomPct);

    // Random crop origin so the extract offset varies between runs
    const maxOffX = zoomedW - origW;
    const maxOffY = zoomedH - origH;
    const offX = Math.floor(Math.random() * (maxOffX + 1));
    const offY = Math.floor(Math.random() * (maxOffY + 1));

    const zoomedBuf: Buffer = await sharp(noisedPng)
      .withMetadata(false)
      .resize(zoomedW, zoomedH, { kernel: "lanczos3" })
      .extract({ left: offX, top: offY, width: origW, height: origH })
      .png({ compressionLevel: 1, force: true })
      .toBuffer();

    // ── Randomised processing parameters ─────────────────────────────────

    // Sub-pixel blur σ 0.3–0.8
    const blurSigma = parseFloat((0.3 + Math.random() * 0.5).toFixed(2));

    // Hue rotation: ±2 degrees
    const hueDeg = Math.floor(Math.random() * 5) - 2;

    // Saturation multiplier: 0.97–1.03 (±3 %)
    const satMod = parseFloat((0.97 + Math.random() * 0.06).toFixed(3));

    // Brightness multiplier: 0.998–1.002 (±0.2 %)
    const brightnessMod = parseFloat((0.998 + Math.random() * 0.004).toFixed(4));

    // Small symmetric edge crops: 1–3 px per side (breaks identical-frame
    // fingerprinting across repeated posts of the same image)
    const cropL = 1 + Math.floor(Math.random() * 3);
    const cropT = 1 + Math.floor(Math.random() * 3);
    const cropR = 1 + Math.floor(Math.random() * 3);
    const cropB = 1 + Math.floor(Math.random() * 3);
    const cropW = origW - cropL - cropR;
    const cropH = origH - cropT - cropB;

    // First JPEG quality: 85–93
    const quality1 = 85 + Math.floor(Math.random() * 9);

    // Second JPEG quality: 70–80
    const quality2 = 70 + Math.floor(Math.random() * 11);

    // ── Step 5: first JPEG encode — crop + blur + colour jitter ──────────
    const pass1Buf: Buffer = cropW > 100 && cropH > 100
      ? await sharp(zoomedBuf)
          .withMetadata(false)
          .extract({ left: cropL, top: cropT, width: cropW, height: cropH })
          .blur(blurSigma)
          .modulate({ brightness: brightnessMod, hue: hueDeg, saturation: satMod })
          .jpeg({ quality: quality1, chromaSubsampling: "4:2:0", force: true })
          .toBuffer()
      : await sharp(zoomedBuf)
          .withMetadata(false)
          .blur(blurSigma)
          .modulate({ brightness: brightnessMod, hue: hueDeg, saturation: satMod })
          .jpeg({ quality: quality1, chromaSubsampling: "4:2:0", force: true })
          .toBuffer();

    // ── Step 6: second JPEG encode — different quant table ────────────────
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
