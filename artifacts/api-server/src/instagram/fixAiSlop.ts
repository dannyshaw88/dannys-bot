/**
 * fixAiSlop.ts — Strip AI-detectable signals from images before posting.
 *
 * Instagram's "AI info" label is triggered by three distinct detection vectors.
 * This module addresses all three aggressively while keeping the output
 * indistinguishable from a natural photograph at normal viewing distances.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * VECTOR 1 — Metadata (EXIF / XMP / IPTC / C2PA manifests)
 * ──────────────────────────────────────────────────────────────────────────
 * AI generators embed software tags ("DALL-E 3", "Midjourney v6", "Stable
 * Diffusion XL"), C2PA cryptographic manifests (a standardised proof-of-AI-
 * origin written by Adobe Firefly, Google ImageFX, Bing Image Creator, Getty
 * Images AI, and others), and XMP sidecar fields naming the model used.
 *
 * C2PA is stored in JPEG APP11 (JUMBF container) — a segment that some tools
 * miss. To guarantee it is gone, the source is decoded to a PNG buffer first
 * (PNG has no JPEG APP segment structure at all), then re-encoded as JPEG from
 * raw pixels. The new JPEG file is built from scratch and can contain only what
 * sharp explicitly writes into it, which with withMetadata(false) is nothing.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * VECTOR 2 — Steganographic / DCT watermarks
 * ──────────────────────────────────────────────────────────────────────────
 * Invisible pixel-pattern watermarks are baked into the JPEG DCT coefficients
 * at generation time — e.g. Stable Diffusion's Invisible Watermark library
 * (a 48-bit signature hidden in Y-channel DCT), Midjourney's hidden per-image
 * signature. Re-encoding through a randomised JPEG quality level re-quantises
 * the DCT table, destroying any fixed-pattern embedding. A second re-encode at
 * a different quality scrambles the residual further.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * VECTOR 3 — Statistical / frequency-domain fingerprints
 * ──────────────────────────────────────────────────────────────────────────
 * Diffusion models and GANs leave characteristic spectral power distributions
 * in the mid-to-high spatial frequencies — artifacts of the up-sampling /
 * denoising process — that CNNs trained on AI-vs-real datasets detect reliably.
 *
 *  • Sub-pixel Gaussian blur (σ 0.4–1.0): attenuates the AI spectral
 *    fingerprint. Human blur-perception threshold is σ > ~1.5 for small prints;
 *    σ ≤ 1.0 is invisible in a social-media-compressed JPEG.
 *
 *  • Random 1–3 px edge crop (different per side): changes the image
 *    dimensions slightly, disrupting spatial grid-based CNN detectors that
 *    expect the generator's native output dimensions.
 *
 *  • Micro hue/saturation/brightness jitter: per-channel colour statistics
 *    shift is a low-cost way to move the image away from the generator's
 *    known colour signature without visible quality loss.
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

    // Sub-pixel blur σ 0.4–1.0 (invisible at σ ≤ 1.5, aggressive enough to
    // flatten AI spectral fingerprints)
    const blurSigma = parseFloat((0.4 + Math.random() * 0.6).toFixed(2));

    // Hue rotation: ±3 degrees — imperceptible, shifts per-channel histograms
    const hueDeg = Math.floor(Math.random() * 7) - 3; // -3 to +3

    // Saturation multiplier: 0.97–1.03 (±3 %)
    const satMod = parseFloat((0.97 + Math.random() * 0.06).toFixed(3));

    // Brightness multiplier: 0.998–1.002 (±0.2 %)
    const brightnessMod = parseFloat((0.998 + Math.random() * 0.004).toFixed(4));

    // First JPEG quality: 90–96
    const quality1 = 90 + Math.floor(Math.random() * 7);

    // Second JPEG quality: 87–93 (different from first to further scramble DCT)
    const quality2 = 87 + Math.floor(Math.random() * 7);

    // Random edge crops: 1–3 px per side (each side independently random)
    const cropL = 1 + Math.floor(Math.random() * 3);
    const cropR = 1 + Math.floor(Math.random() * 3);
    const cropT = 1 + Math.floor(Math.random() * 3);
    const cropB = 1 + Math.floor(Math.random() * 3);

    // ── Step 1: decode → PNG (obliterates ALL JPEG APP segments including
    //           APP11/JUMBF where C2PA manifests live) ─────────────────────
    const pngBuf: Buffer = await sharp(buf)
      .withMetadata(false)
      .png({ compressionLevel: 1, force: true }) // lossless; compressionLevel 1 = fast
      .toBuffer();

    // ── Step 2: get dimensions so we can crop safely ──────────────────────
    const meta = await sharp(pngBuf).metadata();
    const w = (meta.width ?? 0) - cropL - cropR;
    const h = (meta.height ?? 0) - cropT - cropB;
    if (w < 100 || h < 100) {
      // Image is too small to crop safely — skip crop, proceed without it
      const pass1Buf: Buffer = await sharp(pngBuf)
        .withMetadata(false)
        .blur(blurSigma)
        .modulate({ brightness: brightnessMod, hue: hueDeg, saturation: satMod })
        .jpeg({ quality: quality1, chromaSubsampling: "4:2:0", force: true })
        .toBuffer();
      await sharp(pass1Buf)
        .withMetadata(false)
        .jpeg({ quality: quality2, chromaSubsampling: "4:2:0", force: true })
        .toFile(tmp);
    } else {
      // ── Step 3: first JPEG encode — crop + blur + colour jitter ──────────
      const pass1Buf: Buffer = await sharp(pngBuf)
        .withMetadata(false)
        .extract({ left: cropL, top: cropT, width: w, height: h })
        .blur(blurSigma)
        .modulate({ brightness: brightnessMod, hue: hueDeg, saturation: satMod })
        .jpeg({ quality: quality1, chromaSubsampling: "4:2:0", force: true })
        .toBuffer();

      // ── Step 4: second JPEG encode — further scrambles DCT coefficients ──
      await sharp(pass1Buf)
        .withMetadata(false)
        .jpeg({ quality: quality2, chromaSubsampling: "4:2:0", force: true })
        .toFile(tmp);
    }

    return tmp;
  } catch {
    await unlink(tmp).catch(() => {});
    return inputPath; // processing failed — return original unchanged
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
