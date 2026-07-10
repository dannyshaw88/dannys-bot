/**
 * USB Phone Detection — isolated, standalone route.
 * Does NOT import anything from the rest of the API server.
 * Single endpoint: GET /api/mobile/usb-phones
 *   Returns the list of real Android phones connected via USB cable.
 *   Emulators (serial starts with "emulator-") are filtered out.
 */

import { Router } from "express";
import { spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import https from "https";
import { pipeline } from "stream/promises";

// Official Google-hosted platform-tools zip. No account/API key needed — this
// is the same URL "Download SDK Platform-Tools" links to on Android's own
// developer site.
const PLATFORM_TOOLS_URL: Record<string, string> = {
  win32: "https://dl.google.com/android/repository/platform-tools-latest-windows.zip",
  darwin: "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip",
  linux: "https://dl.google.com/android/repository/platform-tools-latest-linux.zip",
};

// ── Manual ADB path override ───────────────────────────────────────────────────
// Lets a user paste the folder containing adb.exe directly in the UI instead of
// editing the Windows PATH environment variable. Persisted so it survives restarts.

function overrideFilePath(): string {
  return path.join(process.cwd(), "adb-path-override.json");
}

function loadOverridePath(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(overrideFilePath(), "utf8"));
    return typeof raw?.folder === "string" && raw.folder.trim() ? raw.folder.trim() : null;
  } catch { return null; }
}

function saveOverridePath(folder: string | null): void {
  fs.writeFileSync(overrideFilePath(), JSON.stringify({ folder }, null, 2));
}

function resolveAdbInFolder(folder: string): string | null {
  const isWin = process.platform === "win32";
  const candidate = path.join(folder, isWin ? "adb.exe" : "adb");
  try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
  return null;
}

// ── ADB discovery ─────────────────────────────────────────────────────────────

function findAdb(): string | null {
  const isWin = process.platform === "win32";

  // 1. User-provided override always wins — most reliable, no PATH needed.
  const override = loadOverridePath();
  if (override) {
    const found = resolveAdbInFolder(override);
    if (found) return found;
  }

  // On Windows we only accept the real binary (.exe) so spawnSync works without
  // shell semantics.  .cmd/.bat wrappers require `cmd.exe /c` to execute and
  // would silently fail when spawned directly.
  const exts = isWin ? [".exe"] : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter);

  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, `adb${ext}`);
      try { if (fs.statSync(full).isFile()) return full; } catch { /* next */ }
    }
  }

  // Fallback: common installation locations
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const lad  = process.env.LOCALAPPDATA ?? "";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "";

  const candidates = isWin
    ? [
        path.join(lad,  "Android", "Sdk", "platform-tools", "adb.exe"),
        path.join(pf86, "Android", "android-sdk", "platform-tools", "adb.exe"),
        "C:\\Android\\platform-tools\\adb.exe",
      ]
    : [
        path.join(home, "Library", "Android", "sdk", "platform-tools", "adb"),
        path.join(home, "Android", "Sdk", "platform-tools", "adb"),
        "/usr/local/bin/adb",
        "/usr/bin/adb",
      ];

  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }

  return null;
}

function runAdb(adbPath: string, args: string[]): string | null {
  const r = spawnSync(adbPath, args, { timeout: 8_000, encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return r.stdout?.trim() ?? null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UsbPhone {
  serial:         string;
  /** "device" = fully authorised and ready, "unauthorized" = needs dialog on phone, "offline" = cable issue */
  state:          "device" | "unauthorized" | "offline" | string;
  model?:         string;
  manufacturer?:  string;
  androidVersion?: string;
  product?:       string;
}

// ── Core logic ────────────────────────────────────────────────────────────────

function listUsbPhones(adbPath: string, diag?: { rawOutput: string }): UsbPhone[] {
  const out = runAdb(adbPath, ["devices", "-l"]);
  if (diag) diag.rawOutput = out ?? "(adb devices -l produced no output or failed to run)";
  if (!out) return [];

  const phones: UsbPhone[] = [];

  // Parse "adb devices -l" output — format per line:
  //   <serial>   <state>   product:<x> model:<y> device:<z> transport_id:<n>
  const lines = out.split("\n").slice(1); // skip "List of devices attached"

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Skip ADB daemon startup noise ("* daemon not running…", "* daemon started…")
    if (line.startsWith("*")) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;

    const serial = parts[0];
    const state  = parts[1];

    // ── USB-only filter ──────────────────────────────────────────────────────
    // `adb devices -l` includes a `usb:<path>` token for most real USB devices,
    // but some Windows USB driver stacks (generic "ADB Interface" driver,
    // certain OEM drivers) omit it even for a genuine cable connection — the
    // token is a nice-to-have signal, not guaranteed. Rejecting on its absence
    // caused real phones to be silently dropped. Instead, only reject entries
    // that look like emulators or network/TCP devices (accept everything else,
    // including a bare "usb:" token check as a bonus label, not a requirement).
    const looksLikeEmulator = serial.startsWith("emulator-");
    const looksLikeNetwork  = /^[\w.-]+:\d+$/.test(serial); // host:port pattern (adb connect over Wi-Fi/TCP)
    if (looksLikeEmulator || looksLikeNetwork) continue;

    // Parse key:value pairs from -l suffix
    const kv: Record<string, string> = {};
    for (let i = 2; i < parts.length; i++) {
      const idx = parts[i].indexOf(":");
      if (idx > 0) kv[parts[i].slice(0, idx)] = parts[i].slice(idx + 1);
    }

    const phone: UsbPhone = {
      serial,
      state,
      model:   kv["model"]?.replace(/_/g, " ") ?? undefined,
      product: kv["product"] ?? undefined,
    };

    // For fully connected devices, read extra props (each takes ~200 ms)
    if (state === "device") {
      const mfr = runAdb(adbPath, ["-s", serial, "shell", "getprop", "ro.product.manufacturer"]);
      if (mfr) phone.manufacturer = mfr;

      const ver = runAdb(adbPath, ["-s", serial, "shell", "getprop", "ro.build.version.release"]);
      if (ver) phone.androidVersion = ver;

      // If model wasn't in the -l output, try getprop
      if (!phone.model) {
        const mdl = runAdb(adbPath, ["-s", serial, "shell", "getprop", "ro.product.model"]);
        if (mdl) phone.model = mdl;
      }
    }

    phones.push(phone);
  }

  return phones;
}

// ── Route ─────────────────────────────────────────────────────────────────────

const router = Router();

/**
 * GET /api/mobile/usb-phones
 * Returns:
 *   { adbFound: boolean, adbPath: string|null, phones: UsbPhone[], checkedAt: string }
 */
router.get("/mobile/usb-phones", (_req, res) => {
  const adbPath = findAdb();
  const diag = { rawOutput: "" };
  const phones = adbPath ? listUsbPhones(adbPath, diag) : [];

  res.json({
    adbFound:  adbPath !== null,
    adbPath:   adbPath,
    phones,
    rawOutput: adbPath ? diag.rawOutput : null,
    checkedAt: new Date().toISOString(),
  });
});

/**
 * POST /api/mobile/adb-path
 * Body: { folder: string }  — folder containing adb.exe (or adb on mac/linux)
 * Saves the override and validates it immediately so the UI can show a clear
 * error rather than silently failing on the next poll.
 */
router.post("/mobile/adb-path", (req, res) => {
  const folder = String(req.body?.folder ?? "").trim();
  if (!folder) {
    res.status(400).json({ ok: false, error: "Please paste a folder path." });
    return;
  }

  let stat;
  try { stat = fs.statSync(folder); } catch {
    res.status(400).json({ ok: false, error: "That folder doesn't exist. Double-check the path." });
    return;
  }
  if (!stat.isDirectory()) {
    res.status(400).json({ ok: false, error: "That's not a folder — paste the folder that contains adb.exe, not the file itself." });
    return;
  }

  const found = resolveAdbInFolder(folder);
  if (!found) {
    const isWin = process.platform === "win32";
    res.status(400).json({
      ok: false,
      error: `No ${isWin ? "adb.exe" : "adb"} found in that folder. Make sure you're pointing at the exact folder that has the file in it.`,
    });
    return;
  }

  saveOverridePath(folder);
  res.json({ ok: true, adbPath: found });
});

/**
 * POST /api/mobile/adb-auto-install
 * Downloads Google's official platform-tools zip for the current OS,
 * extracts it locally, and saves it as the ADB override — so the user never
 * has to manually download/unzip/paste a folder path. Idempotent: if it was
 * already installed by this route before, re-uses the existing extraction
 * instead of re-downloading.
 */
router.post("/mobile/adb-auto-install", async (_req, res) => {
  const platform = process.platform;
  const url = PLATFORM_TOOLS_URL[platform];
  if (!url) {
    res.status(400).json({ ok: false, error: `No auto-install available for this OS (${platform}). Please download platform-tools manually.` });
    return;
  }

  const installDir = path.join(process.cwd(), "vendor", "platform-tools");
  const alreadyInstalled = resolveAdbInFolder(installDir);
  if (alreadyInstalled) {
    saveOverridePath(installDir);
    res.json({ ok: true, adbPath: alreadyInstalled, reused: true });
    return;
  }

  const zipPath = path.join(process.cwd(), "vendor", "platform-tools.zip");
  try {
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });

    await downloadFile(url, zipPath);

    // The zip's own top-level folder is "platform-tools/" — extract it
    // directly into vendor/ so files land at vendor/platform-tools/adb.exe.
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(path.join(process.cwd(), "vendor"), true);
    fs.rmSync(zipPath, { force: true });

    const found = resolveAdbInFolder(installDir);
    if (!found) {
      res.status(500).json({ ok: false, error: "Downloaded platform-tools but couldn't find adb inside it — the archive layout may have changed." });
      return;
    }

    saveOverridePath(installDir);
    res.json({ ok: true, adbPath: found, reused: false });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message ?? "Failed to download/install ADB automatically. Check your internet connection, or use the manual folder option below." });
  }
});

function downloadFile(url: string, destPath: string, redirectsLeft = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        if (redirectsLeft <= 0) { reject(new Error("Too many redirects")); return; }
        response.resume();
        downloadFile(response.headers.location, destPath, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(destPath);
      pipeline(response, file).then(resolve, reject);
    }).on("error", reject);
  });
}

export default router;
