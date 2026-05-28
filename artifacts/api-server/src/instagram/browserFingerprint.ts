import { randomBytes } from "crypto";

export interface EbFingerprint {
  webglVendor:    string;
  webglRenderer:  string;
  canvasNoise:    number;
  audioNoise:     number;
  mediaVideoId:   string;
  mediaAudioId:   string;
  mediaSpeakerId: string;
  fontSeed:       number;
  speechProfile:  number;
}

const GPU_MAP: Array<{ vendor: string; renderer: string; keys: string[] }> = [
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 750",  keys: ["gs302", "Snapdragon8Gen3", "caiman"] },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 735",  keys: ["Snapdragon8Gen2", "b0q", "diamond", "e3q", "SM-S928", "SM-S918"] },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 720",  keys: ["op535", "rtwo", "CPH2551", "CPH2449"] },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 710",  keys: ["Snapdragon7Gen1", "marble"] },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 695",  keys: ["Snapdragon695", "bangkk"] },
  { vendor: "ARM",                         renderer: "Mali-G920 MC10",   keys: ["exynos2400"] },
  { vendor: "ARM",                         renderer: "Mali-G710 MC10",   keys: ["exynos2200", "SM-S911"] },
  { vendor: "ARM",                         renderer: "Mali-G76 MC12",    keys: ["exynos1380", "SM-A54"] },
  { vendor: "ARM",                         renderer: "Mali-G610 MC6",    keys: ["Dimensity9000"] },
  { vendor: "Google",                      renderer: "Tensor G4",        keys: ["caiman"] },
  { vendor: "Google",                      renderer: "Tensor G3",        keys: ["shiba", "gs202"] },
  { vendor: "Google",                      renderer: "Tensor G2",        keys: ["panther", "gs201"] },
];

const FALLBACK_GPU = [
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 750" },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 735" },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 720" },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 710" },
  { vendor: "ARM",                         renderer: "Mali-G920 MC10" },
  { vendor: "ARM",                         renderer: "Mali-G710 MC10" },
  { vendor: "Google",                      renderer: "Tensor G3" },
];

function pickGpu(ua: string | null | undefined): { vendor: string; renderer: string } {
  if (ua) {
    for (const entry of GPU_MAP) {
      if (entry.keys.some(k => ua.includes(k))) {
        return { vendor: entry.vendor, renderer: entry.renderer };
      }
    }
  }
  return FALLBACK_GPU[randomBytes(1)[0] % FALLBACK_GPU.length];
}

function rndHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function generateEbFingerprint(userAgentApi?: string | null): EbFingerprint {
  const gpu = pickGpu(userAgentApi);
  const canvasNoise = (randomBytes(1)[0] % 253) + 2; // 2-254 (avoid 0 = no-op XOR)
  // Tiny float: 0.0000001 – 0.0000009 — imperceptible to ears, changes the hash
  const audioNoise = (randomBytes(4).readUInt32BE(0) / 0xFFFFFFFF) * 0.0000008 + 0.0000001;
  return {
    webglVendor:    gpu.vendor,
    webglRenderer:  gpu.renderer,
    canvasNoise,
    audioNoise:     parseFloat(audioNoise.toFixed(10)),
    mediaVideoId:   rndHex(16),
    mediaAudioId:   rndHex(16),
    mediaSpeakerId: rndHex(16),
    fontSeed:       (randomBytes(1)[0] % 99) + 1,
    speechProfile:  randomBytes(1)[0] % 8,
  };
}
