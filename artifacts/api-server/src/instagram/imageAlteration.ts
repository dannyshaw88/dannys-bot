/**
 * Jarvee-compatible image alteration for repost uniqueness.
 *
 * Applies six independently configurable filters (matching Jarvee's IMAGE
 * SETTINGS dialog) plus a JPEG COM-segment injection for hash salting.
 * When custom per-filter settings are provided by the caller they override
 * the built-in level presets.
 */
import { randomBytes } from "crypto";
import sharp from "sharp";

export type AlterationLevel = "small" | "medium" | "high";

/** Mirrors the per-filter settings object stored in tool.settings. */
export interface ImageFilterSettings {
  contrast:       { enabled: boolean; min: number; max: number };
  brightness:     { enabled: boolean; min: number; max: number };
  noise:          { enabled: boolean; min: number; max: number };
  sharpen:        { enabled: boolean; min: number; max: number };
  pixelate:       { enabled: boolean; min: number; max: number };
  randomMetadata: boolean;
}

// ── Built-in level presets (used when no customSettings are supplied) ─────────
interface LevelRange { min: number; max: number }
interface AlterationConfig {
  contrast:   LevelRange;
  brightness: LevelRange;
  noise:      LevelRange;
  sharpen:    LevelRange;
  pixelate:   LevelRange;
  randomMetadata: boolean;
}

const CONFIGS: Record<AlterationLevel, AlterationConfig> = {
  small: {
    contrast:       { min: 5,   max: 50  },
    brightness:     { min: 5,   max: 50  },
    noise:          { min: 5,   max: 8   },
    sharpen:        { min: 1.0, max: 1.3 },
    pixelate:       { min: 0.3, max: 0.7 },
    randomMetadata: true,
  },
  medium: {
    contrast:       { min: 5,   max: 150 },
    brightness:     { min: 5,   max: 150 },
    noise:          { min: 5,   max: 12  },
    sharpen:        { min: 1.0, max: 1.7 },
    pixelate:       { min: 0.3, max: 1.2 },
    randomMetadata: true,
  },
  high: {
    contrast:       { min: 5,   max: 250 },
    brightness:     { min: 5,   max: 250 },
    noise:          { min: 5,   max: 15  },
    sharpen:        { min: 1.0, max: 2.0 },
    pixelate:       { min: 0.9, max: 2.1 },
    randomMetadata: true,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function randInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function injectComSegment(buf: Buffer, commentLen: number): Buffer {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return buf;
  const comment  = randomBytes(commentLen);
  const segLen   = 2 + commentLen;
  const com      = Buffer.allocUnsafe(4 + commentLen);
  com[0] = 0xFF; com[1] = 0xFE;
  com[2] = (segLen >> 8) & 0xFF;
  com[3] =  segLen       & 0xFF;
  comment.copy(com, 4);
  return Buffer.concat([buf.subarray(0, 2), com, buf.subarray(2)]);
}

function buildRandomMetadata(): sharp.WriteableMetadata {
  const iphones = [
    "iPhone 13", "iPhone 13 Pro", "iPhone 14", "iPhone 14 Pro",
    "iPhone 15", "iPhone 15 Pro", "iPhone 15 Pro Max",
  ];
  const ios = ["16.6.1", "17.0", "17.1.2", "17.2", "17.3", "17.4"];
  const model  = iphones[Math.floor(Math.random() * iphones.length)];
  const iosVer = ios[Math.floor(Math.random() * ios.length)];
  const lat = 25 + Math.random() * 24;
  const lon = 66 + Math.random() * 59;
  function toDMS(deg: number): string {
    const d = Math.floor(deg);
    const mf = (deg - d) * 60;
    const m = Math.floor(mf);
    const s = Math.floor((mf - m) * 60 * 100);
    return `${d} 1 ${m} 1 ${s} 100`;
  }
  return {
    exif: {
      IFD0: { Make: "Apple", Model: model, Software: `${model} ${iosVer}` },
      GPS: {
        GPSLatitudeRef: "N", GPSLatitude: toDMS(lat),
        GPSLongitudeRef: "W", GPSLongitude: toDMS(lon),
      },
    } as any,
  };
}

// ── Build effective config from custom settings or level preset ────────────────
function buildConfig(level: AlterationLevel, custom?: ImageFilterSettings): AlterationConfig {
  if (!custom) return CONFIGS[level];
  return {
    contrast:   custom.contrast.enabled
                  ? { min: custom.contrast.min,   max: custom.contrast.max   }
                  : { min: 0, max: 0 },
    brightness: custom.brightness.enabled
                  ? { min: custom.brightness.min, max: custom.brightness.max }
                  : { min: 0, max: 0 },
    noise:      custom.noise.enabled
                  ? { min: custom.noise.min,      max: custom.noise.max      }
                  : { min: 0, max: 0 },
    sharpen:    custom.sharpen.enabled
                  ? { min: custom.sharpen.min,    max: custom.sharpen.max    }
                  : { min: 1.0, max: 1.0 },   // sigma 0 = no sharpen
    pixelate:   custom.pixelate.enabled
                  ? { min: custom.pixelate.min,   max: custom.pixelate.max   }
                  : { min: 0.3, max: 0.3 },   // near-zero blur
    randomMetadata: custom.randomMetadata,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Alters a JPEG image buffer to make it unique before reposting.
 *
 * @param input          Raw JPEG bytes
 * @param level          Intensity preset (used if no customSettings supplied)
 * @param customSettings Per-filter settings from the UI (overrides level presets)
 */
export async function alterJpegBuffer(
  input: Buffer,
  level: AlterationLevel,
  customSettings?: ImageFilterSettings,
): Promise<Buffer> {
  const cfg = buildConfig(level, customSettings);

  try {
    // ── 1. Noise: raw-pixel Gaussian perturbation ──────────────────────────
    const { data: rawPixels, info } = await sharp(input)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const noiseMax = cfg.noise.max - cfg.noise.min;
    if (noiseMax > 0) {
      const noiseMag = randInRange(cfg.noise.min, cfg.noise.max);
      const channels = info.channels as number;
      for (let i = 0; i < rawPixels.length; i++) {
        if (channels === 4 && i % 4 === 3) continue;
        const u = Math.max(1e-10, Math.random());
        const v = Math.max(1e-10, Math.random());
        const gauss = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        rawPixels[i] = Math.max(0, Math.min(255, rawPixels[i] + gauss * noiseMag)) | 0;
      }
    }

    // ── 2. Contrast ────────────────────────────────────────────────────────
    const contrastVal = randInRange(cfg.contrast.min, cfg.contrast.max);
    const linearA = 1 + contrastVal / 1000;
    const linearB = -(contrastVal / 1000) * 128;

    // ── 3. Brightness ──────────────────────────────────────────────────────
    const brightnessVal      = randInRange(cfg.brightness.min, cfg.brightness.max);
    const brightnessMultiplier = 1 + brightnessVal / 5000;

    // ── 4. Sharpen sigma ───────────────────────────────────────────────────
    const sharpenSigma = Math.max(0, randInRange(cfg.sharpen.min, cfg.sharpen.max) - 1.0);

    // ── 5. Pixelate (blur sigma) ───────────────────────────────────────────
    const blurSigma = Math.max(0.3, randInRange(cfg.pixelate.min, cfg.pixelate.max));

    // ── Chain sharp operations ─────────────────────────────────────────────
    let pipeline = sharp(rawPixels, {
      raw: { width: info.width, height: info.height, channels: info.channels as 1|2|3|4 },
    })
      .linear(linearA, linearB)
      .modulate({ brightness: brightnessMultiplier });

    if (sharpenSigma > 0.05) {
      pipeline = pipeline.sharpen({ sigma: Math.min(sharpenSigma, 10) });
    }

    pipeline = pipeline.blur(blurSigma);

    // ── 6. Random US metadata ──────────────────────────────────────────────
    if (cfg.randomMetadata) {
      try { pipeline = pipeline.withMetadata(buildRandomMetadata()); } catch { /* skip */ }
    }

    const processed = await pipeline.jpeg({ quality: 92, mozjpeg: false }).toBuffer();

    // ── 7. COM segment injection ───────────────────────────────────────────
    const comLen = level === "small" ? 8 : level === "medium" ? 32 : 64;
    return injectComSegment(processed, comLen);

  } catch (err) {
    console.warn("[imageAlteration] sharp pipeline failed, using COM-only fallback:", (err as Error).message);
    return injectComSegment(input, 32);
  }
}
