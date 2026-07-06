// ── Desktop Chrome UA pool ────────────────────────────────────────────────────
// NOTE: Desktop UAs are NO LONGER assigned to disableApi=true accounts.
// All accounts now use mobile Android Chrome UAs (see UA_POOL below).
// Desktop UAs caused hardware-mismatch fingerprint signals on the ARM Mac server
// (Architecture: arm / Apple Silicon GPU leaked even with Intel Mac UA).
// This pool is retained for any legacy callers and future use.
// api field is "" — the mobile API client is never invoked for desktop-UA sessions.
//
// IMPORTANT — why this is generated, not hand-listed:
// Since Chrome's UA-string freeze (Chrome 100+), the desktop User-Agent header itself
// carries almost no entropy by design: every real Windows Chrome user on a given major
// version reports the byte-identical string ("Chrome/136.0.0.0", never a real build/patch
// number), and the same is true for macOS/Linux. A hand-maintained list can therefore only
// ever have as many *realistic* entries as (major Chrome versions) x (OS platform strings) —
// hard-coding more than that would mean emitting UA strings that no real Chrome build ever
// sent, which is itself a stronger fingerprinting signal than reusing a real one.
// This generator covers every stable Chrome major version release for the last ~3 years
// (currently ~50) across Windows / macOS / Linux (3 platform strings) = ~150 realistic
// combinations — the practical ceiling for genuine desktop Chrome UAs.
//
// True per-account uniqueness at thousand/million-account scale comes from the deeper
// fingerprint surface (canvas noise, audio LCG seed, WebGL vendor/renderer, font seed,
// media device IDs — see browserFingerprint.ts), which each carry 32-128 bits of real
// randomness per account, independent of which UA string an account happens to share
// with thousands of other real Chrome users.
const DESKTOP_CHROME_MIN_VERSION = 100;
const DESKTOP_CHROME_MAX_VERSION = 137;

const DESKTOP_PLATFORMS: Array<{ ua: string }> = [
  { ua: "Windows NT 10.0; Win64; x64" },       // Windows 10 & 11 report identically
  { ua: "Macintosh; Intel Mac OS X 10_15_7" }, // Intel + Apple Silicon report identically
  { ua: "X11; Linux x86_64" },
];

function buildDesktopUserAgents(): Array<{ api: string; embedded: string }> {
  const pool: Array<{ api: string; embedded: string }> = [];
  for (let v = DESKTOP_CHROME_MAX_VERSION; v >= DESKTOP_CHROME_MIN_VERSION; v--) {
    for (const platform of DESKTOP_PLATFORMS) {
      pool.push({
        api: "",
        embedded: `Mozilla/5.0 (${platform.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
      });
    }
  }
  return pool;
}

export const desktopUserAgents: Array<{ api: string; embedded: string }> = buildDesktopUserAgents();

export const userAgents = [
  // ── Google Pixel ──────────────────────────────────────────────────────────────
  {
    api: "35/15; 480dpi; 1344x2992; Google; Pixel 9 Pro; caiman; gs302; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "35/15; 420dpi; 1080x2400; Google; Pixel 8; shiba; gs202; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "35/15; 420dpi; 1080x2400; Google; Pixel 7; panther; gs201; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "35/15; 420dpi; 1080x2424; Google; Pixel 9; tokay; gs302; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2400; Google; Pixel 8a; akita; gs202; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "35/15; 480dpi; 1344x2992; Google; Pixel 9 Pro XL; komodo; gs302; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro XL) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "35/15; 420dpi; 1080x2424; Google; Pixel 9 Pro Fold; comet; gs302; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro Fold) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2400; Google; Pixel 7a; lynx; gs201; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "35/15; 480dpi; 1344x2992; Google; Pixel 8 Pro; husky; gs202; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 15; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "35/15; 480dpi; 1440x3120; Google; Pixel 7 Pro; cheetah; gs201; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 15; Pixel 7 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2400; Google; Pixel 6a; bluejay; gs101; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; Pixel 6a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2400; Google; Pixel 6; oriole; gs101; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "32/12; 429dpi; 1080x2340; Google; Pixel 5a; barbet; Snapdragon765G; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 12; Pixel 5a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },

  // ── Samsung Galaxy S / Note / Z (flagship) ────────────────────────────────────
  {
    api: "34/14; 420dpi; 1080x2340; Samsung; SM-S928B; e3q; exynos2400; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2340; Samsung; SM-S911B; diamond; exynos2200; en_GB",
    embedded: "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 393dpi; 1080x2340; Samsung; SM-S918B; b0q; Snapdragon8Gen2; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2340; Samsung; SM-S901B; r0q; exynos2200; en_DE",
    embedded: "Mozilla/5.0 (Linux; Android 14; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2340; Samsung; SM-G998B; p3q; exynos2100; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 393dpi; 1080x2340; Samsung; SM-S916B; r1q; Snapdragon8Gen2; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; SM-S916B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2340; Samsung; SM-S921B; r12s; Snapdragon8Gen3; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2340; Samsung; SM-F946B; q5q; Snapdragon8Gen2; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; SM-F946B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 500dpi; 1440x3088; Samsung; SM-S918U; p3s; Snapdragon8Gen2; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; SM-S918U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 500dpi; 1440x3088; Samsung; SM-S908U; q9s; Snapdragon8Gen1; en_AU",
    embedded: "Mozilla/5.0 (Linux; Android 13; SM-S908U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 515dpi; 1440x3200; Samsung; SM-G998U; x1s; Snapdragon888; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; SM-G998U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "32/12; 494dpi; 1440x3088; Samsung; SM-N986B; c2q; Snapdragon865; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 12; SM-N986B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 425dpi; 1080x2640; Samsung; SM-F731B; b5q; Snapdragon8Gen2; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; SM-F731B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 460dpi; 1080x2340; Samsung; SM-S721B; m44x; Snapdragon8Gen1; de_DE",
    embedded: "Mozilla/5.0 (Linux; Android 14; SM-S721B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 440dpi; 1080x2340; Samsung; SM-S711B; r11s; Snapdragon8Gen1; fr_FR",
    embedded: "Mozilla/5.0 (Linux; Android 13; SM-S711B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "32/12; 407dpi; 1080x2400; Samsung; SM-G780G; r8q; Snapdragon865; en_AU",
    embedded: "Mozilla/5.0 (Linux; Android 12; SM-G780G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },

  // ── Samsung Galaxy A (mid-range / budget) ─────────────────────────────────────
  {
    api: "34/14; 393dpi; 1080x2316; Samsung; SM-A546B; a54x; exynos1380; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 393dpi; 1080x2316; Samsung; SM-A735F; a73xq; Snapdragon778G; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; SM-A735F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2340; Samsung; SM-A556B; a55x; exynos1480; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; SM-A556B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2340; Samsung; SM-A256B; a25x; exynos1280; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; SM-A256B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 393dpi; 1080x2316; Samsung; SM-A336B; a33x; exynos1280; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; SM-A336B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 410dpi; 1080x2400; Samsung; SM-A536B; a53x; exynos1280; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 420dpi; 1080x2340; Samsung; SM-A526B; a52xq; Snapdragon778G; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; SM-A526B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 390dpi; 1080x2340; Samsung; SM-A346B; a34x; Dimensity1080; pt_BR",
    embedded: "Mozilla/5.0 (Linux; Android 13; SM-A346B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 282dpi; 1080x2340; Samsung; SM-A156B; a15x; Dimensity6100Plus; es_MX",
    embedded: "Mozilla/5.0 (Linux; Android 14; SM-A156B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 282dpi; 1080x2340; Samsung; SM-A245F; m23x; Helio G99; id_ID",
    embedded: "Mozilla/5.0 (Linux; Android 13; SM-A245F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 393dpi; 1080x2340; Samsung; SM-A336M; a33x; Exynos1280; es_MX",
    embedded: "Mozilla/5.0 (Linux; Android 13; SM-A336M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 393dpi; 1080x2400; Samsung; SM-A525F; a52q; Snapdragon750G; en_GB",
    embedded: "Mozilla/5.0 (Linux; Android 13; SM-A525F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "32/12; 282dpi; 1080x2408; Samsung; SM-A135F; a13x; Exynos850; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 12; SM-A135F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 269dpi; 720x1600; Samsung; SM-A055F; a05; Snapdragon680; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 13; SM-A055F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "32/12; 270dpi; 720x1600; Samsung; SM-A047F; a04s; Exynos850; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 12; SM-A047F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
  },

  // ── OnePlus ───────────────────────────────────────────────────────────────────
  {
    api: "34/14; 440dpi; 1080x2400; OnePlus; CPH2551; op535; Snapdragon8Gen3; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; CPH2551) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 440dpi; 1080x2400; OnePlus; CPH2449; ovaltine; Snapdragon8Gen2; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; CPH2449) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 510dpi; 1440x3168; OnePlus; CPH2583; PJD110; Snapdragon8Gen3; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; CPH2583) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36"
  },

  // ── Xiaomi / Redmi / POCO ─────────────────────────────────────────────────────
  {
    api: "34/14; 400dpi; 1080x2400; Xiaomi; 23127PN0CC; houji; Snapdragon8Gen3; en_CN",
    embedded: "Mozilla/5.0 (Linux; Android 14; 23127PN0CC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 400dpi; 1080x2400; Xiaomi; 2201117TY; viva; Dimensity9000; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 13; 2201117TY) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2408; Xiaomi; 23049PCD8G; marble; Snapdragon7Gen1; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; 23049PCD8G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2400; Xiaomi; 22081212UG; zeus; Dimensity9000Plus; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; 22081212UG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 440dpi; 1080x2400; Xiaomi; 2209129SC; pissarro; Dimensity8100; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 13; 2209129SC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 400dpi; 1080x2400; Xiaomi; 23116PN5BC; aurora; Snapdragon8Gen3; en_CN",
    embedded: "Mozilla/5.0 (Linux; Android 14; 23116PN5BC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 440dpi; 1080x2400; Xiaomi; 22021211RG; ingres; Dimensity9000; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; 22021211RG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2340; Xiaomi; 23013RK75C; marble; Snapdragon7sGen2; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 14; 23013RK75C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 400dpi; 1080x2340; Xiaomi; 2112123AG; mondrian; Snapdragon8Plus; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; 2112123AG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 400dpi; 1080x2400; Xiaomi; 2304FPN6DG; duchamp; Dimensity9200Plus; en_CN",
    embedded: "Mozilla/5.0 (Linux; Android 14; 2304FPN6DG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 440dpi; 1080x2400; Xiaomi; 22111317I; zeus; Dimensity9000Plus; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 13; 22111317I) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 400dpi; 1080x2400; Xiaomi; 23013PC75G; garnet; Dimensity6080; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 14; 23013PC75G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 420dpi; 1080x2400; Xiaomi; 2303CRA44A; diting; Snapdragon8Plus; en_CN",
    embedded: "Mozilla/5.0 (Linux; Android 13; 2303CRA44A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 446dpi; 1220x2712; Xiaomi; 23124RN87I; sapphire_pro; Dimensity7200Ultra; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 13; 23124RN87I) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 446dpi; 1080x2400; Xiaomi; 2406EPN60G; rothko; Dimensity9300Plus; de_DE",
    embedded: "Mozilla/5.0 (Linux; Android 14; 2406EPN60G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "32/12; 446dpi; 1080x2400; Xiaomi; 2201116SG; dagu; Snapdragon8PlusGen1; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 12; 2201116SG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "32/12; 419dpi; 1080x2400; Xiaomi; 22111317PG; vili; Snapdragon8Plus; en_CN",
    embedded: "Mozilla/5.0 (Linux; Android 12; 22111317PG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 446dpi; 1080x2400; Xiaomi; 2309CN75BC; corot; Dimensity8200Ultra; de_DE",
    embedded: "Mozilla/5.0 (Linux; Android 13; 2309CN75BC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "32/12; 269dpi; 720x1600; Xiaomi; 23028RNCAG; earth; Helio G85; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 12; 23028RNCAG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 269dpi; 720x1600; Xiaomi; 23100RN82L; green; Helio G85; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 13; 23100RN82L) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36"
  },

  // ── Motorola ──────────────────────────────────────────────────────────────────
  {
    api: "34/14; 420dpi; 1080x2340; Motorola; motorola edge 40 pro; rtwo; Snapdragon8Gen2; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; motorola edge 40 pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 400dpi; 1080x2400; Motorola; motorola g84 5g; bangkk; Snapdragon695; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 13; motorola g84 5g) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 430dpi; 1080x2400; Motorola; motorola edge 50 ultra; hiphi; Snapdragon8sGen3; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; motorola edge 50 ultra) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 400dpi; 1080x2340; Motorola; motorola g73 5g; tundra; Dimensity930; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; motorola g73 5g) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2400; Motorola; motorola razr 50 ultra; njord; Snapdragon8sGen3; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; motorola razr 50 ultra) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 400dpi; 1080x2340; Motorola; motorola edge 30 neo; austin; Snapdragon695; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; motorola edge 30 neo) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 430dpi; 1080x2400; Motorola; motorola edge 40 neo; manaus; Dimensity7030; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; motorola edge 40 neo) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 400dpi; 1080x2400; Motorola; motorola g54 5g; cancunf; Snapdragon480Plus; pt_BR",
    embedded: "Mozilla/5.0 (Linux; Android 13; motorola g54 5g) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 400dpi; 1080x2400; Motorola; motorola edge 40; dubai; Dimensity8020; en_CA",
    embedded: "Mozilla/5.0 (Linux; Android 13; motorola edge 40) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 269dpi; 720x1600; Motorola; moto e14; canopus; Helio G85; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; moto e14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },

  // ── Sony ──────────────────────────────────────────────────────────────────────
  {
    api: "34/14; 420dpi; 1080x2400; Sony; XQ-EC54; pdx234; Snapdragon8Gen2; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; XQ-EC54) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 420dpi; 1080x2520; Sony; XQ-CQ54; nagara; Snapdragon8Gen1; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; XQ-CQ54) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2520; Sony; XQ-DC72; pdx244; Snapdragon8Gen3; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; XQ-DC72) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2400; Sony; XQ-BT52; pdx236; Snapdragon8Gen2; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; XQ-BT52) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 420dpi; 1080x2520; Sony; XQ-AT52; pdx215; Snapdragon888; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; XQ-AT52) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 420dpi; 1080x2520; Sony; XQ-BE52; pdx223; Snapdragon8Gen1; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; XQ-BE52) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36"
  },

  // ── OPPO ──────────────────────────────────────────────────────────────────────
  {
    api: "34/14; 440dpi; 1080x2340; OPPO; CPH2609; OP5961L1; Snapdragon8sGen3; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; CPH2609) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 440dpi; 1080x2400; OPPO; CPH2495; OP557BL1; Dimensity9000; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; CPH2495) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 440dpi; 1080x2340; OPPO; CPH2577; OP5F19L1; Snapdragon8Gen2; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; CPH2577) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 440dpi; 1080x2340; OPPO; CPH2525; OP5F25L1; Dimensity9200; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; CPH2525) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 440dpi; 1080x2400; OPPO; CPH2653; OP5F33L1; Dimensity9300; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; CPH2653) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 420dpi; 1080x2400; OPPO; CPH2413; OP557FL1; Dimensity8100; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 13; CPH2413) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 440dpi; 1080x2340; OPPO; CPH2629; OP5F41L1; Dimensity9300; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; CPH2629) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 440dpi; 1080x2400; OPPO; CPH2671; OP5F47L1; Snapdragon8sGen3; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; CPH2671) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 453dpi; 1080x2412; OPPO; CPH2595; OP5F35L1; Dimensity8200; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; CPH2595) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 400dpi; 1080x2400; OPPO; CPH2357; OP4F1BL1; Snapdragon695; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 13; CPH2357) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36"
  },

  // ── vivo ──────────────────────────────────────────────────────────────────────
  {
    api: "34/14; 440dpi; 1080x2400; vivo; V2309A; PD2309F; Dimensity9200; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; V2309A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 420dpi; 1080x2400; vivo; V2145; PD2145F_EX; Snapdragon888; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; V2145) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2400; vivo; V2307A; PD2307F; Dimensity9200Plus; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 14; V2307A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 440dpi; 1080x2400; vivo; V2250A; PD2250F; Snapdragon8Gen1; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; V2250A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 440dpi; 1080x2400; vivo; V2404A; PD2404F; Dimensity9300Plus; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 14; V2404A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 420dpi; 1080x2400; vivo; V2157A; PD2157F; Dimensity8100; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; V2157A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 420dpi; 1080x2400; vivo; V2212A; PD2212F; Snapdragon8Plus; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; V2212A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 440dpi; 1080x2400; vivo; V2406A; PD2406F; Snapdragon8Gen3; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 14; V2406A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2400; vivo; V2334A; PD2334F; Snapdragon7Gen3; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 14; V2334A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 450dpi; 1260x2800; vivo; V2402A; PD2401F; Dimensity9300Plus; en_CN",
    embedded: "Mozilla/5.0 (Linux; Android 14; V2402A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36"
  },

  // ── realme ────────────────────────────────────────────────────────────────────
  {
    api: "34/14; 400dpi; 1080x2400; realme; RMX3840; RM6985; Dimensity9300; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 14; RMX3840) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 400dpi; 1080x2400; realme; RMX3686; RM6877; Dimensity8100; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 13; RMX3686) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 420dpi; 1080x2400; realme; RMX3760; RM6985; Dimensity9000; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 13; RMX3760) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 400dpi; 1080x2400; realme; RMX3888; RM6985; Snapdragon8sGen3; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 14; RMX3888) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 400dpi; 1080x2400; realme; RMX3993; RM3393; Snapdragon7Gen3; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 14; RMX3993) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 400dpi; 1080x2400; realme; RMX3630; RM6877; Dimensity8100Max; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 13; RMX3630) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 400dpi; 1080x2400; realme; RMX3741; RM6877; Dimensity9000; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 14; RMX3741) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 400dpi; 1080x2400; realme; RMX3710; RM3313; Snapdragon778G; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 13; RMX3710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 420dpi; 1080x2400; realme; RMX3890; RM2351; Snapdragon7sGen3; en_IN",
    embedded: "Mozilla/5.0 (Linux; Android 14; RMX3890) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36"
  },

  // ── Asus ──────────────────────────────────────────────────────────────────────
  {
    api: "34/14; 420dpi; 1080x2340; Asus; ASUS_AI2302; ASUS_AI2302; Snapdragon8Gen2; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; ASUS_AI2302) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 420dpi; 1080x2340; Asus; ASUS_AI2205; ASUS_AI2205; Snapdragon8PlusGen1; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 13; ASUS_AI2205) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "34/14; 460dpi; 1080x2400; Asus; ASUS_AI2401; ASUS_AI2401; Snapdragon8Gen3; en_US",
    embedded: "Mozilla/5.0 (Linux; Android 14; ASUS_AI2401) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36"
  },

  // ── Nothing ───────────────────────────────────────────────────────────────────
  {
    api: "34/14; 480dpi; 1080x2340; Nothing; A142; Spacewar; Snapdragon8Plus; en_GB",
    embedded: "Mozilla/5.0 (Linux; Android 14; A142) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 420dpi; 1080x2400; Nothing; A063; Asteroids; Snapdragon778G; en_GB",
    embedded: "Mozilla/5.0 (Linux; Android 13; A063) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
  },
  {
    api: "33/13; 450dpi; 1080x2412; Nothing; A065; Pacman; Snapdragon8PlusGen1; en_GB",
    embedded: "Mozilla/5.0 (Linux; Android 13; A065) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36"
  },
];
