import { Router, type Request, type Response } from "express";
import sharp from "sharp";

export const aiRouter = Router();

// ── Realistic phone profiles ────────────────────────────────────────────────
const PHONE_PROFILES = [
  { make: "Apple",   model: "iPhone 14 Pro",  software: "16.5.1",  focal: [3420, 1000], aperture: [8, 5],  exposure: [1, 120], focalMm: "3.0 mm" },
  { make: "Apple",   model: "iPhone 15 Pro",  software: "17.2.1",  focal: [3420, 1000], aperture: [8, 5],  exposure: [1, 120], focalMm: "3.0 mm" },
  { make: "Apple",   model: "iPhone 13",      software: "16.7.2",  focal: [2650, 1000], aperture: [7, 5],  exposure: [1, 100], focalMm: "2.65 mm" },
  { make: "Apple",   model: "iPhone 12",      software: "15.8.1",  focal: [2650, 1000], aperture: [7, 5],  exposure: [1, 90],  focalMm: "2.65 mm" },
  { make: "Apple",   model: "iPhone SE",      software: "16.7.4",  focal: [2870, 1000], aperture: [7, 5],  exposure: [1, 80],  focalMm: "2.87 mm" },
  { make: "Samsung", model: "SM-S918B",       software: "Android 13", focal: [6200, 1000], aperture: [9, 5],  exposure: [1, 100], focalMm: "6.2 mm" },
  { make: "Samsung", model: "SM-A546B",       software: "Android 13", focal: [2650, 1000], aperture: [7, 5],  exposure: [1, 80],  focalMm: "2.65 mm" },
  { make: "Samsung", model: "SM-G991B",       software: "Android 13", focal: [3430, 1000], aperture: [8, 5],  exposure: [1, 100], focalMm: "3.43 mm" },
  { make: "Google",  model: "Pixel 7 Pro",    software: "Android 14", focal: [3850, 1000], aperture: [9, 5],  exposure: [1, 110], focalMm: "3.85 mm" },
  { make: "Google",  model: "Pixel 8",        software: "Android 14", focal: [2650, 1000], aperture: [8, 5],  exposure: [1, 100], focalMm: "2.65 mm" },
  { make: "OnePlus", model: "CPH2449",        software: "Android 13", focal: [3850, 1000], aperture: [9, 5],  exposure: [1, 95],  focalMm: "3.85 mm" },
  { make: "Xiaomi",  model: "2304FPN6DC",     software: "MIUI 14",   focal: [2870, 1000], aperture: [8, 5],  exposure: [1, 90],  focalMm: "2.87 mm" },
];

// Output dimensions that vary per image — mirrors real phone photo sizes after crop
const OUTPUT_DIMS = [
  { w: 1080, h: 1080 }, // 1:1 square
  { w: 1080, h: 1350 }, // 4:5 portrait (most common Instagram selfie)
  { w: 1080, h: 1920 }, // 9:16 story-style portrait
  { w: 1080, h: 1440 }, // 3:4 portrait
  { w: 828,  h: 1472 }, // iPhone XR native front-cam ratio
  { w: 1170, h: 2080 }, // iPhone 12/13 portrait crop
  { w: 720,  h: 960  }, // older Android 3:4
  { w: 900,  h: 1200 }, // mid-range portrait
];

// Together AI generation dimensions (FLUX max ~1MP, multiples of 8)
const GEN_DIMS = [
  { w: 768,  h: 1024 }, // 3:4 portrait
  { w: 576,  h: 1024 }, // 9:16 portrait
  { w: 832,  h: 1152 }, // portrait
  { w: 704,  h: 1024 }, // portrait
];

// Realistic city GPS coords (no actual tracking)
const CITY_COORDS = [
  { lat: [51, 30, 26, "N"], lon: [0, 7, 40, "W"],  alt: 11  }, // London
  { lat: [40, 42, 46, "N"], lon: [74, 0, 22, "W"],  alt: 10  }, // New York
  { lat: [48, 51, 24, "N"], lon: [2, 21, 3, "E"],   alt: 35  }, // Paris
  { lat: [53, 33, 0,  "N"], lon: [10, 0, 0, "E"],   alt: 14  }, // Hamburg
  { lat: [52, 31, 0,  "N"], lon: [13, 24, 0, "E"],  alt: 34  }, // Berlin
  { lat: [41, 23, 0,  "N"], lon: [2, 11, 0, "E"],   alt: 12  }, // Barcelona
  { lat: [43, 17, 0,  "N"], lon: [5, 22, 0, "E"],   alt: 28  }, // Marseille
  { lat: [55, 45, 6,  "N"], lon: [37, 36, 56, "E"], alt: 151 }, // Moscow
  { lat: [37, 46, 30, "N"], lon: [122, 25, 10, "W"],alt: 16  }, // San Francisco
  { lat: [34, 3, 8,   "N"], lon: [118, 14, 37, "W"],alt: 71  }, // Los Angeles
  { lat: [51, 3, 0,   "N"], lon: [3, 43, 0, "E"],   alt: 8   }, // Ghent
  { lat: [50, 51, 0,  "N"], lon: [4, 21, 0, "E"],   alt: 56  }, // Brussels
  { lat: [45, 27, 0,  "N"], lon: [9, 12, 0, "E"],   alt: 122 }, // Milan
  { lat: [41, 54, 0,  "N"], lon: [12, 29, 0, "E"],  alt: 37  }, // Rome
];

const ISO_VALUES = [50, 64, 80, 100, 125, 160, 200];

const SELFIE_PROMPTS = [
  "photorealistic selfie photograph of a young woman, face-on, front camera, natural indoor lighting, casual clothing, slight smile, high resolution, authentic photograph, no filters, skin texture visible, real person",
  "realistic selfie photo of a young man, direct camera angle, natural expression, indoor lighting, smartphone quality, authentic, unfiltered, portrait",
  "candid selfie photograph of a woman in her mid twenties, face looking at camera, soft natural light from window, casual home setting, real photograph",
  "authentic selfie photograph of a man aged 20-30, slight head tilt, casual smile, neutral indoor background softly blurred, real skin texture",
  "genuine selfie photo, young adult woman, natural makeup, window light, direct frontal camera angle, realistic skin pores and texture",
  "natural selfie photo of a young adult man, casual outfit, slightly off-centre composition, warm indoor light, authentic real-person photograph",
  "candid front-camera selfie, woman in her twenties, background slightly blurred bedroom setting, natural expression, no flash, real photograph",
];

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function toGpsRational(deg: number, min: number, sec: number): [number, number][] {
  return [[deg, 1], [min, 1], [sec * 100, 100]];
}

function randomHex(bytes: number): string {
  return [...Array(bytes)].map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("").toUpperCase();
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
    // Pick random gen dimensions (FLUX) and output dimensions independently
    const genDim    = GEN_DIMS[randInt(0, GEN_DIMS.length - 1)];
    const outDim    = OUTPUT_DIMS[randInt(0, OUTPUT_DIMS.length - 1)];
    const prompt    = SELFIE_PROMPTS[randInt(0, SELFIE_PROMPTS.length - 1)];

    const togetherRes = await fetch("https://api.together.xyz/v1/images/generations", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "black-forest-labs/FLUX.1-schnell-Free",
        prompt,
        width:  genDim.w,
        height: genDim.h,
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
    const b64  = data.data?.[0]?.b64_json;
    if (!b64) return res.status(500).json({ error: "No image data returned from Together AI" });

    // Convert to JPEG at randomised output dimensions (strips all AI metadata)
    const inputBuffer = Buffer.from(b64, "base64");
    const quality     = randInt(84, 94);
    const jpegBuffer  = await sharp(inputBuffer)
      .resize(outDim.w, outDim.h, { fit: "cover", position: "attention" })
      .jpeg({ quality })
      .toBuffer();

    // ── Inject fully unique EXIF ──────────────────────────────────────────
    const piexif  = require("piexifjs");
    const phone   = PHONE_PROFILES[randInt(0, PHONE_PROFILES.length - 1)];
    const city    = CITY_COORDS[randInt(0, CITY_COORDS.length - 1)];
    const ago     = randInt(5, 20160); // 5 min–2 weeks ago
    const shotAt  = new Date(Date.now() - ago * 60000);
    const dtStr   = shotAt.toISOString().replace("T", " ").substring(0, 19).replace(/-/g, ":");
    const subsec  = String(randInt(0, 999)).padStart(3, "0");
    const iso     = ISO_VALUES[randInt(0, ISO_VALUES.length - 1)];
    const imgUid  = randomHex(16); // unique per image
    const serial  = randomHex(8);  // unique body serial

    // Slight focal length variation (+/- a few mm)
    const focalNom = phone.focal[0] + randInt(-50, 50);
    const focalDen = phone.focal[1];

    // GPS — slight random offset within city (~1 km radius)
    const latOff = randInt(-500, 500);  // offset in arc-seconds/100
    const lonOff = randInt(-500, 500);
    const [baseLat0, baseLat1, baseLat2] = city.lat;
    const [baseLon0, baseLon1, baseLon2] = city.lon;
    const latSec = Number(baseLat2) * 100 + latOff;
    const lonSec = Number(baseLon2) * 100 + lonOff;
    const altMetres = city.alt + randInt(-5, 5);

    const exifObj: any = {
      "0th": {
        [piexif.ImageIFD.Make]:             phone.make,
        [piexif.ImageIFD.Model]:            phone.model,
        [piexif.ImageIFD.Software]:         phone.software,
        [piexif.ImageIFD.DateTime]:         dtStr,
        [piexif.ImageIFD.Orientation]:      1,
        [piexif.ImageIFD.XResolution]:      [72, 1],
        [piexif.ImageIFD.YResolution]:      [72, 1],
        [piexif.ImageIFD.ResolutionUnit]:   2,
        [piexif.ImageIFD.YCbCrPositioning]: 1,
      },
      "Exif": {
        [piexif.ExifIFD.DateTimeOriginal]:   dtStr,
        [piexif.ExifIFD.DateTimeDigitized]:  dtStr,
        [piexif.ExifIFD.SubSecTimeOriginal]: subsec,
        [piexif.ExifIFD.SubSecTimeDigitized]:subsec,
        [piexif.ExifIFD.FocalLength]:        [focalNom, focalDen],
        [piexif.ExifIFD.ApertureValue]:      [phone.aperture[0], phone.aperture[1]],
        [piexif.ExifIFD.ExposureTime]:       [phone.exposure[0], phone.exposure[1]],
        [piexif.ExifIFD.FNumber]:            [phone.aperture[0], phone.aperture[1]],
        [piexif.ExifIFD.ISOSpeedRatings]:    iso,
        [piexif.ExifIFD.Flash]:              0,
        [piexif.ExifIFD.PixelXDimension]:    outDim.w,
        [piexif.ExifIFD.PixelYDimension]:    outDim.h,
        [piexif.ExifIFD.ColorSpace]:         1,
        [piexif.ExifIFD.ExposureMode]:       0,
        [piexif.ExifIFD.WhiteBalance]:       0,
        [piexif.ExifIFD.SceneCaptureType]:   2,  // portrait
        [piexif.ExifIFD.ExposureProgram]:    2,  // normal program
        [piexif.ExifIFD.MeteringMode]:       2,  // centre-weighted average
        [piexif.ExifIFD.LightSource]:        0,  // unknown (auto)
        [piexif.ExifIFD.FocalLengthIn35mmFilm]: Math.round(focalNom / focalDen * 6.5),
        [piexif.ExifIFD.ImageUniqueID]:      imgUid,
        [piexif.ExifIFD.BodySerialNumber]:   serial,
      },
      "GPS": {
        [piexif.GPSIFD.GPSLatitudeRef]:  city.lat[3],
        [piexif.GPSIFD.GPSLatitude]:     [[Number(baseLat0), 1], [Number(baseLat1), 1], [latSec, 100]],
        [piexif.GPSIFD.GPSLongitudeRef]: city.lon[3],
        [piexif.GPSIFD.GPSLongitude]:    [[Number(baseLon0), 1], [Number(baseLon1), 1], [lonSec, 100]],
        [piexif.GPSIFD.GPSAltitudeRef]:  0,
        [piexif.GPSIFD.GPSAltitude]:     [altMetres * 10, 10],
        [piexif.GPSIFD.GPSImgDirectionRef]: "M",
        [piexif.GPSIFD.GPSImgDirection]: [randInt(0, 359), 1],
      },
      "1st": {},
      "thumbnail": null,
    };

    const jpegBase64 = jpegBuffer.toString("base64");
    const dataUrl    = `data:image/jpeg;base64,${jpegBase64}`;
    const exifStr    = piexif.dump(exifObj);
    const resultUrl  = piexif.insert(exifStr, dataUrl);
    const resultB64  = resultUrl.split(",")[1];

    const safeModel  = phone.model.replace(/\s/g, "_");
    const fileName   = `selfie_${shotAt.getTime()}_${safeModel}_${imgUid.slice(0, 6)}.jpg`;

    return res.json({
      imageBase64: resultB64,
      fileName,
      dimensions: outDim,
      metadata: {
        make:   phone.make,
        model:  phone.model,
        shotAt: shotAt.toISOString(),
        iso,
        uid:    imgUid,
      },
    });
  } catch (err: any) {
    console.error("[ai] generate-selfie error:", err);
    return res.status(500).json({ error: err?.message ?? "Unknown error" });
  }
});
