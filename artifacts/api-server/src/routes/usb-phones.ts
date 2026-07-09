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

// ── ADB discovery ─────────────────────────────────────────────────────────────

function findAdb(): string | null {
  const isWin = process.platform === "win32";
  const exts  = isWin ? [".exe", ".cmd", ".bat"] : [""];
  const dirs  = (process.env.PATH ?? "").split(path.delimiter);

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

function listUsbPhones(adbPath: string): UsbPhone[] {
  const out = runAdb(adbPath, ["devices", "-l"]);
  if (!out) return [];

  const phones: UsbPhone[] = [];

  // Parse "adb devices -l" output — format per line:
  //   <serial>   <state>   product:<x> model:<y> device:<z> transport_id:<n>
  const lines = out.split("\n").slice(1); // skip "List of devices attached"

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;

    const serial = parts[0];
    const state  = parts[1];

    // Skip Android emulators — only real USB hardware
    if (serial.startsWith("emulator-")) continue;
    // Skip localhost TCP devices (these are typically emulators too)
    if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial) || /^localhost:\d+$/.test(serial)) continue;

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
  const phones  = adbPath ? listUsbPhones(adbPath) : [];

  res.json({
    adbFound:  adbPath !== null,
    adbPath:   adbPath,
    phones,
    checkedAt: new Date().toISOString(),
  });
});

export default router;
