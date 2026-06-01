import { Router, type Request, type Response } from "express";
import sharp from "sharp";

export const aiRouter = Router();

// ── Device fingerprints for realistic EXIF ─────────────────────────────────
const PHONE_PROFILES = [
  { make: "Apple",   model: "iPhone 14 Pro",   software: "16.5.1",  focal: [3420, 1000], aperture: [8, 5],  exposure: [1, 120] },
  { make: "Apple",   model: "iPhone 15 Pro",   software: "17.2.1",  focal: [3420, 1000], aperture: [8, 5],  exposure: [1, 120] },
  { make: "Apple",   model: "iPhone 13",       software: "16.7.2",  focal: [2650, 1000], aperture: [7, 5],  exposure: [1, 100] },
  { make: "Apple",   model: "iPhone 12",       software: "15.8.1",  focal: [2650, 1000], aperture: [7, 5],  exposure: [1, 90]  },
  { make: "Samsung", model: "SM-S918B",        software: "13",      focal: [6200, 1000], aperture: [9, 5],  exposure: [1, 100] },
  { make: "Samsung", model: "SM-A546B",        software: "13",      focal: [2650, 1000], aperture: [7, 5],  exposure: [1, 80]  },
  { make: "Google",  model: "Pixel 7 Pro",     software: "14",      focal: [3850, 1000], aperture: [9, 5],  exposure: [1, 110] },
  { make: "Google",  model: "Pixel 8",         software: "14",      focal: [2650, 1000], aperture: [8, 5],  exposure: [1, 100] },
];

const ISO_VALUES = [50, 64, 80, 100, 125, 160, 200];

const SELFIE_PROMPTS = [
  "photorealistic selfie photograph of a young woman, face-on, front camera, natural indoor lighting, casual clothing, slight smile, high resolution, authentic photograph, no filters, skin texture visible, real person",
  "realistic selfie photo of a young man, direct camera angle, natural expression, indoor lighting, smartphone quality, authentic, unfiltered, portrait",
  "candid selfie photograph of a woman in her mid twenties, face looking at camera, soft natural light from window, casual home setting, real photograph, no AI artifacts",
  "authentic selfie photograph of a man aged 20-30, slight head tilt, casual smile, neutral indoor background softly blurred, real skin texture, camera quality photo",
  "genuine selfie photo, young adult woman, natural makeup, window light, direct frontal camera angle, realistic skin pores and texture, authentic photograph",
];

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function buildExifBytes(phone: typeof PHONE_PROFILES[0], shotAt: Date, iso: number): Buffer {
  const dateStr = shotAt.toISOString().replace("T", " ").substring(0, 19).replace(/-/g, ":");

  // Build minimal EXIF IFD0 + ExifIFD in raw bytes
  // We use a simplified EXIF builder — enough to fool metadata readers
  const makeB  = Buffer.from(phone.make  + "\0");
  const modelB = Buffer.from(phone.model + "\0");
  const swB    = Buffer.from(phone.software + "\0");
  const dtB    = Buffer.from(dateStr + "\0");

  // TIFF header + IFD — minimal valid EXIF
  const buf: number[] = [];

  // Byte order: little-endian II
  buf.push(0x49, 0x49, 0x2a, 0x00);
  // Offset to IFD0: 8
  buf.push(0x08, 0x00, 0x00, 0x00);

  // IFD0 — 5 entries
  const ifd0Count = 5;
  buf.push(ifd0Count & 0xff, (ifd0Count >> 8) & 0xff);

  // We'll calculate offsets from the start of EXIF data
  // For simplicity, just embed strings after the IFD

  return Buffer.from(buf);
}

// ─────────────────────────────────────────────────────────────────────────────

aiRouter.post("/generate-selfie", async (req: Request, res: Response) => {
  const apiKey = process.env.TOGETHER_API_KEY;
  if (!apiKey) {
    return res.status(400).json({
      error: "TOGETHER_API_KEY not set. Get a free API key at https://api.together.xyz/ then add it as an environment variable named TOGETHER_API_KEY.",
    });
  }

  try {
    const prompt = SELFIE_PROMPTS[randInt(0, SELFIE_PROMPTS.length - 1)];

    const togetherRes = await fetch("https://api.together.xyz/v1/images/generations", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "black-forest-labs/FLUX.1-schnell-Free",
        prompt,
        width: 1024,
        height: 1024,
        steps: 4,
        n: 1,
        response_format: "b64_json",
      }),
    });

    if (!togetherRes.ok) {
      const errText = await togetherRes.text();
      return res.status(500).json({ error: `Together AI error: ${errText}` });
    }

    const data = await togetherRes.json() as any;
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) {
      return res.status(500).json({ error: "No image data returned from Together AI" });
    }

    // Process with sharp: resize to 1080×1080 JPEG, strip AI metadata
    const inputBuffer = Buffer.from(b64, "base64");
    const jpegBuffer = await sharp(inputBuffer)
      .resize(1080, 1080, { fit: "cover", position: "attention" })
      .jpeg({ quality: 88 })
      .toBuffer();

    // Inject random phone EXIF using piexifjs
    const piexif = require("piexifjs");
    const phone  = PHONE_PROFILES[randInt(0, PHONE_PROFILES.length - 1)];
    const ago    = randInt(0, 10080); // 0–7 days ago in minutes
    const shotAt = new Date(Date.now() - ago * 60000);
    const dtStr  = shotAt.toISOString().replace("T", " ").substring(0, 19).replace(/-/g, ":");
    const iso    = ISO_VALUES[randInt(0, ISO_VALUES.length - 1)];

    const exifObj: any = {
      "0th": {
        [piexif.ImageIFD.Make]:                phone.make,
        [piexif.ImageIFD.Model]:               phone.model,
        [piexif.ImageIFD.Software]:            phone.software,
        [piexif.ImageIFD.DateTime]:            dtStr,
        [piexif.ImageIFD.Orientation]:         1,
        [piexif.ImageIFD.XResolution]:         [72, 1],
        [piexif.ImageIFD.YResolution]:         [72, 1],
        [piexif.ImageIFD.ResolutionUnit]:      2,
      },
      "Exif": {
        [piexif.ExifIFD.DateTimeOriginal]:     dtStr,
        [piexif.ExifIFD.DateTimeDigitized]:    dtStr,
        [piexif.ExifIFD.FocalLength]:          [phone.focal[0],    phone.focal[1]],
        [piexif.ExifIFD.ApertureValue]:        [phone.aperture[0], phone.aperture[1]],
        [piexif.ExifIFD.ExposureTime]:         [phone.exposure[0], phone.exposure[1]],
        [piexif.ExifIFD.ISOSpeedRatings]:      iso,
        [piexif.ExifIFD.Flash]:                0,
        [piexif.ExifIFD.PixelXDimension]:      1080,
        [piexif.ExifIFD.PixelYDimension]:      1080,
        [piexif.ExifIFD.ColorSpace]:           1,
        [piexif.ExifIFD.ExposureMode]:         0,
        [piexif.ExifIFD.WhiteBalance]:         0,
        [piexif.ExifIFD.SceneCaptureType]:     2,
      },
      "GPS": {},
      "1st": {},
      "thumbnail": null,
    };

    const jpegBase64 = jpegBuffer.toString("base64");
    const dataUrl    = `data:image/jpeg;base64,${jpegBase64}`;
    const exifStr    = piexif.dump(exifObj);
    const resultUrl  = piexif.insert(exifStr, dataUrl);
    const resultB64  = resultUrl.split(",")[1];

    const fileName   = `selfie_${Date.now()}_${phone.model.replace(/\s/g, "_")}.jpg`;

    return res.json({
      imageBase64: resultB64,
      fileName,
      metadata: {
        make:    phone.make,
        model:   phone.model,
        shotAt:  shotAt.toISOString(),
        iso,
      },
    });
  } catch (err: any) {
    console.error("[ai] generate-selfie error:", err);
    return res.status(500).json({ error: err?.message ?? "Unknown error" });
  }
});
