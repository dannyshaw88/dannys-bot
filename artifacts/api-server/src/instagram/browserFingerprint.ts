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
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 750",  keys: ["gs302", "Snapdragon8Gen3", "caiman", "PJD110", "rothko"] },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 735",  keys: ["Snapdragon8Gen2", "Snapdragon8sGen3", "b0q", "diamond", "e3q", "SM-S928", "SM-S918", "p3s", "r12s"] },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 730",  keys: ["Snapdragon8Gen1", "Snapdragon8PlusGen1", "q9s", "r11s", "b5q", "m44x", "Pacman", "dagu"] },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 720",  keys: ["op535", "rtwo", "CPH2551", "CPH2449"] },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 660",  keys: ["Snapdragon888", "x1s", "SM-G998U", "XQ-AT52", "pdx215", "V2145"] },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 650",  keys: ["Snapdragon865", "c2q", "r8q", "SM-N986B", "SM-G780G"] },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 710",  keys: ["Snapdragon7Gen1", "marble"] },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 695",  keys: ["Snapdragon695", "bangkk", "austin"] },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 642L", keys: ["Snapdragon778G", "Snapdragon7sGen2", "a73xq", "a52xq", "Asteroids"] },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 619",  keys: ["Snapdragon750G", "Snapdragon480Plus", "a52q", "cancunf", "barbet", "Snapdragon765G"] },
  { vendor: "Qualcomm Technologies, Inc.", renderer: "Adreno (TM) 610",  keys: ["Snapdragon680", "a05", "SM-A055F"] },
  { vendor: "ARM",                         renderer: "Mali-G920 MC10",   keys: ["exynos2400", "SM-S721B"] },
  { vendor: "ARM",                         renderer: "Mali-G720 MC12",   keys: ["Dimensity9300", "Dimensity9300Plus", "V2402A", "V2404A", "RMX3840", "CPH2653", "CPH2629"] },
  { vendor: "ARM",                         renderer: "Mali-G715 MC11",   keys: ["Dimensity9200", "Dimensity9200Plus", "V2309A", "V2307A", "CPH2525", "duchamp"] },
  { vendor: "ARM",                         renderer: "Mali-G710 MC10",   keys: ["exynos2200", "SM-S911"] },
  { vendor: "ARM",                         renderer: "Mali-G615 MC6",    keys: ["Dimensity8200", "Dimensity8200Ultra", "CPH2595", "corot", "OP5F35"] },
  { vendor: "ARM",                         renderer: "Mali-G610 MC6",    keys: ["Dimensity9000", "Dimensity9000Plus"] },
  { vendor: "ARM",                         renderer: "Mali-G610 MC4",    keys: ["Dimensity7200", "sapphire_pro", "23124RN87I", "Spacewar"] },
  { vendor: "ARM",                         renderer: "Mali-G78 MC22",    keys: ["exynos2100", "SM-G998B"] },
  { vendor: "ARM",                         renderer: "Mali-G76 MC12",    keys: ["exynos1380", "SM-A54", "exynos1480", "exynos1280", "SM-A336", "SM-A526", "SM-A536"] },
  { vendor: "ARM",                         renderer: "Mali-G68 MC4",     keys: ["Dimensity1080", "a34x", "Dimensity6100", "SM-A346B", "SM-A156B"] },
  { vendor: "ARM",                         renderer: "Mali-G57 MC2",     keys: ["Helio G99", "m23x", "SM-A245F"] },
  { vendor: "ARM",                         renderer: "Mali-G52 MC2",     keys: ["Helio G85", "Exynos850", "earth", "green", "canopus", "a04s", "a13x", "SM-A047F", "SM-A135F"] },
  { vendor: "Google",                      renderer: "Tensor G4",        keys: ["caiman", "komodo", "comet"] },
  { vendor: "Google",                      renderer: "Tensor G3",        keys: ["shiba", "husky", "gs202"] },
  { vendor: "Google",                      renderer: "Tensor G2",        keys: ["panther", "cheetah", "lynx", "gs201"] },
  { vendor: "Google",                      renderer: "Tensor G1",        keys: ["oriole", "bluejay", "gs101"] },
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

// Desktop GPU pool — used when desktopMode is true (Disable API / browser-only accounts).
// Values match real Chrome ANGLE renderer strings reported on Windows/macOS.
const DESKTOP_GPU_POOL = [
  // NVIDIA (most common on Windows gaming/enthusiast machines)
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 2080 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Super Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  // AMD Radeon
  { vendor: "Google Inc. (AMD)",    renderer: "ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (AMD)",    renderer: "ANGLE (AMD, AMD Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (AMD)",    renderer: "ANGLE (AMD, AMD Radeon RX 7700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (AMD)",    renderer: "ANGLE (AMD, AMD Radeon RX 6900 XT Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (AMD)",    renderer: "ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (AMD)",    renderer: "ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  // Intel (common on laptops / integrated)
  { vendor: "Google Inc. (Intel)",  renderer: "ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (Intel)",  renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (Intel)",  renderer: "ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (Intel)",  renderer: "ANGLE (Intel, Intel(R) UHD Graphics 730 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (Intel)",  renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  // macOS Metal (Apple Silicon) — Chrome on macOS reports ANGLE Metal renderer
  { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)" },
  { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)" },
  { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)" },
  { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)" },
  { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)" },
  { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)" },
  { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)" },
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

export function generateEbFingerprint(userAgentApi?: string | null, desktopMode?: boolean): EbFingerprint {
  // Desktop accounts (Disable API / browser-only) use real desktop GPU strings
  // so the WebGL fingerprint matches the claimed Windows/macOS identity.
  const gpu = desktopMode
    ? DESKTOP_GPU_POOL[randomBytes(1)[0] % DESKTOP_GPU_POOL.length]
    : pickGpu(userAgentApi);
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
