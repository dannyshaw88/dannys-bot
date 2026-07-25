/**
 * makeUnique.ts — Media uniquification for repost anti-detection.
 *
 * Designed for 100-account scale: each account processes the same source
 * file independently but the combination of all transformations produces a
 * statistically unique output every time, invisible to the human eye but
 * undetectable by Instagram's hash, pHash, and CNN-based duplicate filters.
 *
 * Images: 7-layer Sharp pipeline
 *   1. Sub-pixel crop   — randomly 1-6 px per edge (largest single pHash disruptor)
 *   2. Micro-rotation   — ±0.1–1.8° random sign
 *   3. Per-channel gain — R/G/B multiplied independently (defeats colour histogram)
 *   4. Hue shift        — ±2–9° (defeats HSV histogram + CNN colour layers)
 *   5. Brightness jitter— ±2–4 % (imperceptible tonal shift)
 *   6. Gaussian noise   — σ 1.5–6 per pixel (defeats perceptual CNN similarity)
 *   7. Re-encode JPEG   — random quality 84–97 % (scrambles DCT coefficients)
 *
 * Videos: FFmpeg pipeline (if available)
 *   - Strip all metadata (map_metadata -1)
 *   - eq brightness/contrast micro-jitter
 *   - Per-frame Gaussian noise (c0s 2-8)
 *   - Re-encode libx264 at random CRF 20-27
 *   Supports ALL common container formats: mp4, mov, avi, mkv, webm, m4v, 3gp,
 *   wmv, flv, ts, mts, mpeg, mpg, f4v, asf, vob, rm, rmvb, divx, ogv
 */

import { randomBytes } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, unlink, readFile } from "fs/promises";
import { spawn } from "child_process";

// ── Extension sets ────────────────────────────────────────────────────────────

export const IMAGE_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".avif", ".bmp", ".tiff", ".tif",
]);

export const VIDEO_EXTS = new Set([
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".3gp", ".wmv", ".flv",
  ".ts", ".mts", ".mpeg", ".mpg", ".f4v", ".asf", ".vob", ".rm", ".rmvb",
  ".divx", ".ogv", ".mxf",
]);

export const ALL_MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS]);

export function isImageFile(ext: string): boolean {
  return IMAGE_EXTS.has(ext.toLowerCase());
}
export function isVideoFile(ext: string): boolean {
  return VIDEO_EXTS.has(ext.toLowerCase());
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rnd(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function rndInt(min: number, max: number): number {
  return min + (randomBytes(1)[0] % (max - min + 1));
}

function coin(): boolean {
  return randomBytes(1)[0] > 127;
}

// ── Lazy sharp loader ─────────────────────────────────────────────────────────

let _sharp: ((input: Buffer | Uint8Array, options?: unknown) => unknown) | null | undefined = undefined;

async function getSharp() {
  if (_sharp !== undefined) return _sharp;
  try {
    const m = await import("sharp");
    _sharp = (m as { default: typeof _sharp }).default ?? null;
  } catch {
    _sharp = null;
  }
  return _sharp;
}

// ── Lazy ffmpeg resolver ──────────────────────────────────────────────────────

let _ffmpegPath: string | null | undefined = undefined;

async function getFfmpegPath(): Promise<string | null> {
  if (_ffmpegPath !== undefined) return _ffmpegPath;

  // 1) ffmpeg-static (bundled binary)
  try {
    const mod = await import("ffmpeg-static");
    const p: unknown = (mod as { default?: unknown }).default ?? mod;
    if (typeof p === "string" && p.length > 0) {
      _ffmpegPath = p;
      return _ffmpegPath;
    }
  } catch { /* not installed */ }

  // 2) System PATH
  try {
    const isWin = process.platform === "win32";
    const result = await new Promise<string>((resolve) => {
      const cp = spawn(isWin ? "where" : "which", ["ffmpeg"], { stdio: "pipe" });
      let out = "";
      cp.stdout.on("data", (d: Buffer) => (out += d.toString()));
      cp.on("close", () => resolve(out.split("\n")[0]?.trim() ?? ""));
    });
    if (result) {
      _ffmpegPath = result;
      return _ffmpegPath;
    }
  } catch { /* not on PATH */ }

  _ffmpegPath = null;
  return _ffmpegPath;
}

// ── JPEG COM-segment fallback ────────────────────────────────────────────────

function injectComSegment(buf: Buffer): Buffer {
  const rand = randomBytes(64);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    const segLen = 2 + rand.length;
    const com = Buffer.allocUnsafe(4 + rand.length);
    com[0] = 0xff; com[1] = 0xfe;
    com[2] = (segLen >> 8) & 0xff;
    com[3] = segLen & 0xff;
    rand.copy(com, 4);
    return Buffer.concat([buf.subarray(0, 2), com, buf.subarray(2)]);
  }
  // PNG: append private tEXt chunk before IEND
  if (buf.length >= 8 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const iendPos = buf.lastIndexOf(Buffer.from([0x49, 0x45, 0x4e, 0x44]));
    if (iendPos > 4) {
      const chunk = Buffer.allocUnsafe(12 + rand.length);
      chunk.writeUInt32BE(rand.length, 0);
      chunk.write("tEXt", 4, "ascii");
      rand.copy(chunk, 8);
      chunk.fill(0, 8 + rand.length); // dummy CRC
      return Buffer.concat([buf.subarray(0, iendPos - 4), chunk, buf.subarray(iendPos - 4)]);
    }
  }
  // Generic: XOR tail bytes
  const out = Buffer.from(buf);
  for (let i = Math.max(0, out.length - 64); i < out.length; i++) {
    out[i] ^= rand[i % rand.length];
  }
  return out;
}

// ── Image uniquification ─────────────────────────────────────────────────────

/**
 * Uniquifies an image buffer.
 * Tuned for 100-account scale: effectively infinite variation space,
 * all transformations remain invisible to the human eye.
 */
export async function makeUniqueImage(input: Buffer): Promise<Buffer> {
  const sharp = await getSharp();
  if (!sharp) {
    return injectComSegment(input);
  }

  try {
    const s = sharp as (i: unknown, o?: unknown) => {
      metadata: () => Promise<{ width?: number; height?: number; channels?: number }>;
      extract: (r: unknown) => ReturnType<typeof s>;
      rotate: (a: number, o: unknown) => ReturnType<typeof s>;
      resize: (w: number, h: number, o: unknown) => ReturnType<typeof s>;
      raw: () => ReturnType<typeof s>;
      toBuffer: (o: { resolveWithObject: true }) => Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }>;
      modulate: (o: unknown) => ReturnType<typeof s>;
      linear: (a: number, b: number) => ReturnType<typeof s>;
      jpeg: (o: unknown) => ReturnType<typeof s>;
      withMetadata: (o?: unknown) => ReturnType<typeof s>;
    };

    const meta = await (s(input) as ReturnType<typeof s>).metadata();
    const W = meta.width  ?? 1080;
    const H = meta.height ?? 1080;

    // Layer 1 — edge crop (8-22 px per edge, each independent).
    // SynthID is designed to survive ≤20% crop; we need at least a few percent
    // displacement plus geometric distortion to break its spatial alignment.
    // 8-22 px on a 1080px image ≈ 0.7–2% per edge — visually imperceptible
    // but combined with the rotation below it disrupts the watermark's grid.
    const cT = rndInt(8, 22);
    const cB = rndInt(8, 22);
    const cL = rndInt(8, 22);
    const cR = rndInt(8, 22);
    const cW = Math.max(W - cL - cR, Math.round(W * 0.94));
    const cH = Math.max(H - cT - cB, Math.round(H * 0.94));

    // Layer 2 — rotation (±0.3–2.5°) — geometric transform disrupts SynthID's
    // spatially-aligned frequency watermark more than pixel noise alone.
    const rotDeg = rnd(0.3, 2.5) * (coin() ? 1 : -1);

    // Layer 3 — per-channel gain (R/G/B independently)
    const rGain = rnd(0.975, 1.025);
    const gGain = rnd(0.978, 1.022);
    const bGain = rnd(0.973, 1.027);

    // Layer 4 — hue shift (±3–11°) — must be integer, Sharp rejects floats
    const hueShift = Math.round(rnd(3, 11)) * (coin() ? 1 : -1);

    // Layer 5 — brightness jitter (0.95–1.05)
    const brightnessF = rnd(0.95, 1.05);

    // Layer 6 — Gaussian noise sigma (3.0–8.0) — increased from 1.5–6.0 to
    // better break frequency-domain watermark patterns after JPEG quantisation.
    const noiseSigma = rnd(3.0, 8.0);

    // Layer 7 — JPEG quality (82–95) — wider range = more DCT coefficient
    // variation across images, reducing cross-image watermark correlation.
    const jpegQuality = 82 + (randomBytes(1)[0] % 14);

    // ── Pipeline ──────────────────────────────────────────────────────────
    // Step A: crop + rotate + resize back → raw pixels
    const { data: raw, info } = await (s(input) as ReturnType<typeof s>)
      .extract({ left: cL, top: cT, width: cW, height: cH })
      .rotate(rotDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .resize(W, H, { fit: "cover" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Step B: inject Gaussian noise + per-channel gain (pixel loop)
    const ch = info.channels;
    for (let i = 0; i < raw.length; i++) {
      if (ch === 4 && i % 4 === 3) continue; // skip alpha channel
      const c = i % ch;
      const gain = c === 0 ? rGain : c === 1 ? gGain : bGain;
      // Box-Muller Gaussian
      const u = Math.max(1e-10, Math.random());
      const v = Math.max(1e-10, Math.random());
      const gauss = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      raw[i] = Math.max(0, Math.min(255, raw[i] * gain + gauss * noiseSigma)) | 0;
    }

    // Step C: re-encode with hue shift + brightness, strip metadata
    const result = await (s(raw, {
      raw: { width: info.width, height: info.height, channels: ch as 1|2|3|4 },
    }) as ReturnType<typeof s>)
      .modulate({ brightness: brightnessF, hue: hueShift })
      .jpeg({ quality: jpegQuality, mozjpeg: false })
      .toBuffer({ resolveWithObject: false } as unknown as { resolveWithObject: true });

    return result as unknown as Buffer;
  } catch (err) {
    console.warn("[makeUnique] image pipeline error, using fallback:", (err as Error).message);
    return injectComSegment(input);
  }
}

// ── Video uniquification ─────────────────────────────────────────────────────

/**
 * Uniquifies a video file using FFmpeg.
 * Accepts any container format FFmpeg supports.
 * Returns the path to a temp MP4 (H.264/AAC, Instagram-compatible)
 * and a cleanup callback.
 *
 * If FFmpeg is unavailable, copies the file as-is (MD5 unchanged but
 * the upload at least proceeds).
 */
export async function makeUniqueVideo(
  inputPath: string,
): Promise<{ outputPath: string; cleanup: () => Promise<void> }> {
  const uid = `${Date.now()}_${randomBytes(4).toString("hex")}`;
  const outputPath = join(tmpdir(), `uq_${uid}.mp4`);

  const ff = await getFfmpegPath();

  if (!ff) {
    // No ffmpeg: copy raw bytes and at minimum change the temp file path
    const buf = await readFile(inputPath);
    await writeFile(outputPath, buf);
    return { outputPath, cleanup: async () => { try { await unlink(outputPath); } catch {} } };
  }

  // FFmpeg filter values — randomised per call
  const brightness = rnd(-0.025, 0.025).toFixed(4);
  const contrast   = rnd(0.988, 1.012).toFixed(4);
  const noiseSt    = rndInt(2, 8);                      // noise strength
  const crf        = rndInt(20, 27);                    // CRF 20-27 (barely noticeable quality variation)
  const vf         = `eq=brightness=${brightness}:contrast=${contrast},noise=c0s=${noiseSt}:c0f=u+a`;

  await new Promise<void>((resolve, reject) => {
    const args = [
      "-y",
      "-i", inputPath,
      "-vf", vf,
      "-c:v", "libx264",
      "-crf", String(crf),
      "-preset", "ultrafast",
      "-c:a", "aac",
      "-b:a", "128k",
      "-map_metadata", "-1",     // strip all metadata
      "-movflags", "+faststart", // web-optimised MP4 atom order
      outputPath,
    ];

    const cp = spawn(ff, args, { stdio: "pipe" });
    let stderr = "";
    cp.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    cp.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-600)}`));
      }
    });
    cp.on("error", reject);
  });

  return {
    outputPath,
    cleanup: async () => { try { await unlink(outputPath); } catch {} },
  };
}
