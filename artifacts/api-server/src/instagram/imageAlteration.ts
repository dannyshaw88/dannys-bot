/**
 * Jarvee-compatible image alteration for repost uniqueness.
 *
 * Applies the same six filters Jarvee uses (Contrast, Brightness, Noise,
 * Sharpen Effect, Pixelate Effect, Random US Metadata) plus a JPEG COM-segment
 * injection so every reposted image has a unique MD5 and EXIF fingerprint.
 *
 * Requires the `sharp` package (libvips-based, no extra system deps on Linux).
 */
import { randomBytes } from "crypto";
import sharp from "sharp";

export type AlterationLevel = "small" | "medium" | "high";

// ── Per-level filter intensity ranges (mirrors Jarvee defaults) ───────────────
// "high" uses the exact ranges shown in Jarvee's IMAGE SETTINGS dialog.
// "small" and "medium" use progressively narrower windows from the low end.
interface LevelRange { min: number; max: number }
interface AlterationConfig {
  contrast:   LevelRange;   // → sharp .linear()
  brightness: LevelRange;   // → sharp .modulate()
  noise:      LevelRange;   // → raw pixel XOR / offset
  sharpen:    LevelRange;   // → sharp .sharpen() sigma
  pixelate:   LevelRange;   // → sharp .blur() sigma
}

const CONFIGS: Record<AlterationLevel, AlterationConfig> = {
  small: {
    contrast:   { min: 5,   max: 50  },
    brightness: { min: 5,   max: 50  },
    noise:      { min: 5,   max: 8   },
    sharpen:    { min: 1.0, max: 1.3 },
    pixelate:   { min: 0.3, max: 0.7 },
  },
  medium: {
    contrast:   { min: 5,   max: 150 },
    brightness: { min: 5,   max: 150 },
    noise:      { min: 5,   max: 12  },
    sharpen:    { min: 1.0, max: 1.7 },
    pixelate:   { min: 0.3, max: 1.2 },
  },
  high: {
    contrast:   { min: 5,   max: 250 },
    brightness: { min: 5,   max: 250 },
    noise:      { min: 5,   max: 15  },
    sharpen:    { min: 1.0, max: 2.0 },
    pixelate:   { min: 0.9, max: 2.1 },
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function randInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Inject a JPEG COM (Comment) segment right after SOI to salt the hash. */
function injectComSegment(buf: Buffer, commentLen: number): Buffer {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return buf;
  const comment = randomBytes(commentLen);
  const segLen   = 2 + commentLen;         // length field includes itself
  const com = Buffer.allocUnsafe(4 + commentLen);
  com[0] = 0xFF; com[1] = 0xFE;
  com[2] = (segLen >> 8) & 0xFF;
  com[3] =  segLen       & 0xFF;
  comment.copy(com, 4);
  return Buffer.concat([buf.subarray(0, 2), com, buf.subarray(2)]);
}

/** Random US device metadata for EXIF injection. */
function buildRandomMetadata(): sharp.WriteableMetadata {
  const iphones = [
    "iPhone 13", "iPhone 13 Pro", "iPhone 14", "iPhone 14 Pro",
    "iPhone 15", "iPhone 15 Pro", "iPhone 15 Pro Max",
  ];
  const ios = ["16.6.1", "17.0", "17.1.2", "17.2", "17.3", "17.4"];
  const model = iphones[Math.floor(Math.random() * iphones.length)];
  const iosVer = ios[Math.floor(Math.random() * ios.length)];

  // Random continental US GPS (lat 25–49 N, lon 66–125 W)
  const lat = 25  + Math.random() * 24;
  const lon = 66  + Math.random() * 59;

  // DMS conversion for EXIF rational arrays (numerator/denominator pairs)
  function toDMS(deg: number): [number, number, number, number, number, number] {
    const d = Math.floor(deg);
    const mFrac = (deg - d) * 60;
    const m = Math.floor(mFrac);
    const sFrac = (mFrac - m) * 60;
    const s = Math.floor(sFrac * 100); // numerator × 100, denominator = 100
    return [d, 1, m, 1, s, 100];
  }

  return {
    exif: {
      IFD0: {
        Make: "Apple",
        Model: model,
        Software: `${model} ${iosVer}`,
      },
      GPS: {
        GPSLatitudeRef:  "N",
        GPSLatitude:     toDMS(lat).join(" "),
        GPSLongitudeRef: "W",
        GPSLongitude:    toDMS(lon).join(" "),
      },
    } as any,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Alters a JPEG image buffer using the same six filters as Jarvee's repost
 * uniqueness system. Returns a new Buffer; the original is never modified.
 *
 * Now async (requires sharp).
 */
export async function alterJpegBuffer(input: Buffer, level: AlterationLevel): Promise<Buffer> {
  const cfg = CONFIGS[level];

  try {
    // ── 1. Noise: raw-pixel Gaussian-style perturbation ────────────────────
    const { data: rawPixels, info } = await sharp(input)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const noiseMag = randInRange(cfg.noise.min, cfg.noise.max);
    const channels = info.channels as number;
    for (let i = 0; i < rawPixels.length; i++) {
      // Skip alpha channel
      if (channels === 4 && i % 4 === 3) continue;
      // Box-Muller for Gaussian noise (one sample per pixel component)
      const u = Math.max(1e-10, Math.random());
      const v = Math.max(1e-10, Math.random());
      const gauss = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      rawPixels[i] = Math.max(0, Math.min(255, rawPixels[i] + gauss * noiseMag)) | 0;
    }

    // ── 2. Contrast: linear transform around grey midpoint ─────────────────
    const contrastVal = randInRange(cfg.contrast.min, cfg.contrast.max);
    const linearA = 1 + contrastVal / 1000;        // slight amplification
    const linearB = -(contrastVal / 1000) * 128;   // offset to keep midpoint

    // ── 3. Brightness: multiplicative modulate ─────────────────────────────
    const brightnessVal = randInRange(cfg.brightness.min, cfg.brightness.max);
    const brightnessMultiplier = 1 + brightnessVal / 5000; // ±0.001–0.05

    // ── 4. Sharpen ─────────────────────────────────────────────────────────
    const sharpenSigma = randInRange(cfg.sharpen.min - 1.0, cfg.sharpen.max - 1.0);
    // sharpenSigma = 0 → no sharpen; 1.0 → moderate sharpening

    // ── 5. Pixelate (blur) ─────────────────────────────────────────────────
    const blurSigma = Math.max(0.3, randInRange(cfg.pixelate.min, cfg.pixelate.max));

    // ── Chain sharp operations ─────────────────────────────────────────────
    let pipeline = sharp(rawPixels, {
      raw: { width: info.width, height: info.height, channels: channels as 1 | 2 | 3 | 4 },
    })
      .linear(linearA, linearB)
      .modulate({ brightness: brightnessMultiplier });

    if (sharpenSigma > 0.05) {
      pipeline = pipeline.sharpen({ sigma: Math.min(sharpenSigma, 10) });
    }

    pipeline = pipeline.blur(blurSigma);

    // ── 6. Random US metadata ──────────────────────────────────────────────
    try {
      pipeline = pipeline.withMetadata(buildRandomMetadata());
    } catch {
      // Metadata write can fail on some images — silently skip
    }

    const processed = await pipeline.jpeg({ quality: 92, mozjpeg: false }).toBuffer();

    // ── 7. COM segment injection for extra hash salt ───────────────────────
    const comLen = level === "small" ? 8 : level === "medium" ? 32 : 64;
    return injectComSegment(processed, comLen);

  } catch (err) {
    // Fallback: if sharp fails for any reason, return COM-injected original
    console.warn("[imageAlteration] sharp pipeline failed, using COM-only fallback:", (err as Error).message);
    return injectComSegment(input, 32);
  }
}
