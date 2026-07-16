/**
 * fixAiSlop.ts — Strip AI-detectable signals from images before posting.
 *
 * Instagram (and third-party tools it may use) can detect AI-generated images
 * via three distinct attack vectors. This module addresses all three:
 *
 * 1. Metadata (EXIF / XMP / IPTC / C2PA manifests):
 *    AI generators embed software tags ("DALL-E 3", "Midjourney v6", "Stable
 *    Diffusion XL"), C2PA cryptographic manifests (a standardised
 *    proof-of-AI-origin baked in by Adobe Firefly, Getty Images AI, Google
 *    ImageFX, and others), and XMP sidecar fields that name the model used.
 *    sharp strips all of these unconditionally with withMetadata(false).
 *
 * 2. Steganographic / DCT watermarks:
 *    Invisible pixel-pattern watermarks are baked into the JPEG DCT
 *    coefficients at generation time — for example Stable Diffusion's
 *    Invisible Watermark library (a 48-bit signature hidden in the Y-channel
 *    DCT) and Midjourney's hidden per-image signature. Re-encoding through a
 *    randomised JPEG quality level re-quantises the DCT table with a different
 *    step matrix, destroying any fixed-pattern steganographic embedding.
 *
 * 3. Statistical / frequency-domain fingerprints:
 *    Diffusion models and GANs leave characteristic spectral power
 *    distributions in the mid-to-high spatial frequencies — artifacts of the
 *    up-sampling / denoising process — that CNNs trained on AI-vs-real
 *    datasets can reliably detect. A sub-pixel Gaussian blur (σ 0.3–0.7)
 *    attenuates these without any visible quality loss (human perception
 *    threshold is σ > ~1.0); a small random tonal jitter further
 *    decorrelates the residual from any single generator's known signature.
 *
 * Usage:
 *   const processed = await fixAiSlop(localFilePath);
 *   // push `processed` to the device, then:
 *   await cleanupAiSlopTemp(processed, localFilePath);
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
    // Lazy-load sharp (native binary may not exist in dev / cross-builds)
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

    // Sub-pixel blur σ 0.3–0.7 — attenuates AI spectral fingerprint
    // invisibly. Human blur-perception threshold is σ > ~1.0.
    const blurSigma = parseFloat((0.3 + Math.random() * 0.4).toFixed(2));

    // Tonal micro-jitter ±0.15% brightness — imperceptible to the human eye,
    // disrupts per-channel mean statistics that some CNN features rely on.
    const brightnessMod = 1 + (Math.random() * 0.003 - 0.0015);

    // JPEG quality 88–96 — well above any perceptible quality floor; the
    // variation alone is enough to scramble DCT-domain steganography because
    // each quality value uses a different quantisation step table.
    const jpegQuality = 88 + Math.floor(Math.random() * 9);

    await sharp(buf)
      .withMetadata(false)              // 1. strip ALL metadata: EXIF/XMP/IPTC/C2PA
      .blur(blurSigma)                  // 2. sub-pixel blur → disrupts AI freq fingerprint
      .modulate({ brightness: brightnessMod }) // 3. micro tonal jitter
      .jpeg({                           // 4. re-encode → scrambles DCT steganography
        quality: jpegQuality,
        chromaSubsampling: "4:2:0",
        force: true,                    // convert PNG/WebP/HEIC to JPEG
      })
      .toFile(tmp);

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
