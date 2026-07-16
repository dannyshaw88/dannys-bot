/**
 * fixAiSlop.ts — Strip AI-detectable signals from images before posting.
 *
 * Online "AI watermark remover" tools reliably strip all known watermark
 * types (C2PA metadata, SynthID, DCT-domain steganography) at the cost of
 * some image quality. The quality loss is an inevitable side effect of the
 * technique that actually works — spatial decimation (significant downscale
 * followed by upscale). This module replicates that approach.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * VECTOR 1 — Metadata (C2PA / EXIF / XMP / IPTC)
 * ──────────────────────────────────────────────────────────────────────────
 * ChatGPT/DALL-E images embed C2PA cryptographic manifests in JPEG APP11
 * (JUMBF container) plus EXIF/XMP software tags proving AI origin.
 *
 * Fix: decode to a raw PNG buffer first (destroys all JPEG APP segments
 * including APP11/C2PA/JUMBF). withMetadata(false) on all subsequent
 * operations prevents re-injection.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * VECTOR 2 — Invisible / steganographic watermarks (SynthID, DCT)
 * ──────────────────────────────────────────────────────────────────────────
 * SynthID (used by ChatGPT/DALL-E and Gemini) is a spread-spectrum signal
 * embedded across all pixel values. It is designed to survive JPEG
 * compression, colour adjustments, and moderate cropping.
 *
 * What actually defeats it: spatial decimation. Downscaling to 50–70% of
 * the original resolution with bilinear/lanczos interpolation replaces every
 * pixel with a weighted average of its neighbours. The spread-spectrum
 * detector integrates signal across the image against a fixed spatial key —
 * after decimation the signal's spatial layout no longer matches that key.
 * Upscaling back to the original size via bicubic/lanczos compounds the
 * disruption (the upsampled values are further blends). This is exactly what
 * commercial "remove AI watermark" tools do, and it is why they produce
 * slightly softer images.
 *
 * Additional layers:
 *  a. Per-pixel crypto-random noise ±4–8/channel injected into raw pixel
 *     buffer before downscale — adds incoherent values the correlator must
 *     average against, breaking SNR independently of the spatial step.
 *  b. Downscale to 50–65% of original (random per image, lanczos3).
 *  c. Upscale back to original dimensions (lanczos3). Every pixel is now
 *     a multi-neighbour interpolated blend — spatial key is destroyed.
 *  d. Sub-pixel Gaussian blur σ 0.3–0.7 attenuates any residual HF components.
 *  e. HSL micro-jitter (hue ±2°, sat ±3%, brightness ±0.2%).
 *  f. First JPEG encode quality 82–90 — destroys DCT steganography.
 *  g. Second JPEG encode quality 65–75 — second independent quantisation
 *     pass; lower quality than the first to maximise DCT disruption.
 *     Instagram recompresses uploads regardless, so further loss is negligible.
 *  h. Small symmetric 1–3 px random edge crops — breaks identical-frame
 *     fingerprinting across repeated posts of the same source image.
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
      await unlink(tmp).catch(() => {});
      return inputPath;
    }

    // ── Step 3: per-pixel random noise injection into raw pixel buffer ─────
    const rawBuf: Buffer = await sharp(pngBuf)
      .withMetadata(false)
      .raw()
      .toBuffer();

    const noiseAmp = 4 + Math.floor(Math.random() * 5); // 4–8 per channel
    const noiseBytes = randomBytes(rawBuf.length);
    for (let i = 0; i < rawBuf.length; i++) {
      if (channels === 4 && (i & 3) === 3) continue; // skip alpha
      const offset = Math.round((noiseBytes[i] / 255) * 2 * noiseAmp) - noiseAmp;
      rawBuf[i] = Math.max(0, Math.min(255, rawBuf[i] + offset));
    }

    const noisedPng: Buffer = await sharp(rawBuf, {
      raw: { width: origW, height: origH, channels },
    })
      .withMetadata(false)
      .png({ compressionLevel: 1, force: true })
      .toBuffer();

    // ── Step 4: spatial decimation — the primary watermark destroyer ───────
    // Downscale to 50–65 % (randomised), then upscale back to original.
    // This replaces every pixel with a multi-neighbour interpolated blend,
    // destroying the spatial layout that spread-spectrum detectors rely on.
    // This is the technique "AI watermark remover" tools use; the slight
    // softness in output is its unavoidable side-effect.
    const scalePct = 0.50 + Math.random() * 0.15; // 0.50 – 0.65
    const downW = Math.max(8, Math.round(origW * scalePct));
    const downH = Math.max(8, Math.round(origH * scalePct));

    const decimatedBuf: Buffer = await sharp(noisedPng)
      .withMetadata(false)
      .resize(downW, downH, { kernel: "lanczos3", fastShrinkOnLoad: false })
      .resize(origW, origH, { kernel: "lanczos3" })
      .png({ compressionLevel: 1, force: true })
      .toBuffer();

    // ── Randomised processing parameters ─────────────────────────────────

    // Sub-pixel blur σ 0.3–0.7
    const blurSigma = parseFloat((0.3 + Math.random() * 0.4).toFixed(2));

    // Hue rotation: ±2 degrees
    const hueDeg = Math.floor(Math.random() * 5) - 2;

    // Saturation multiplier: 0.97–1.03
    const satMod = parseFloat((0.97 + Math.random() * 0.06).toFixed(3));

    // Brightness multiplier: 0.998–1.002
    const brightnessMod = parseFloat((0.998 + Math.random() * 0.004).toFixed(4));

    // Small symmetric edge crops: 1–3 px per side
    const cropL = 1 + Math.floor(Math.random() * 3);
    const cropT = 1 + Math.floor(Math.random() * 3);
    const cropR = 1 + Math.floor(Math.random() * 3);
    const cropB = 1 + Math.floor(Math.random() * 3);
    const cropW = origW - cropL - cropR;
    const cropH = origH - cropT - cropB;

    // First JPEG quality: 82–90
    const quality1 = 82 + Math.floor(Math.random() * 9);

    // Second JPEG quality: 65–75
    const quality2 = 65 + Math.floor(Math.random() * 11);

    // ── Step 5: first JPEG encode — crop + blur + colour jitter ──────────
    const pass1Buf: Buffer = cropW > 100 && cropH > 100
      ? await sharp(decimatedBuf)
          .withMetadata(false)
          .extract({ left: cropL, top: cropT, width: cropW, height: cropH })
          .blur(blurSigma)
          .modulate({ brightness: brightnessMod, hue: hueDeg, saturation: satMod })
          .jpeg({ quality: quality1, chromaSubsampling: "4:2:0", force: true })
          .toBuffer()
      : await sharp(decimatedBuf)
          .withMetadata(false)
          .blur(blurSigma)
          .modulate({ brightness: brightnessMod, hue: hueDeg, saturation: satMod })
          .jpeg({ quality: quality1, chromaSubsampling: "4:2:0", force: true })
          .toBuffer();

    // ── Step 6: second JPEG encode — different quantisation table ─────────
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
