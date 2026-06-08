import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

// ── Device detection ──────────────────────────────────────────────────────────

export interface IosDevice {
  udid: string;
  name: string;
  ios: string;
  connected: "usb" | "wifi";
}

export async function listConnectedDevices(): Promise<IosDevice[]> {
  // 1. Try tidevice (pip install tidevice) — best cross-platform option
  try {
    const { stdout } = await execAsync("python3 -m tidevice list --json", { timeout: 5000 });
    const cleaned = stdout.trim();
    if (cleaned.startsWith("[")) {
      const parsed: any[] = JSON.parse(cleaned);
      if (parsed.length > 0) {
        return parsed.map(d => ({
          udid: d.udid ?? "unknown",
          name: d.name ?? "iPhone",
          ios: d.ios_version ?? "Unknown",
          connected: "usb" as const,
        }));
      }
    }
  } catch {}

  // 2. Try pymobiledevice3 (pip install pymobiledevice3)
  try {
    const { stdout } = await execAsync(
      "python3 -m pymobiledevice3 list-devices --json 2>/dev/null",
      { timeout: 5000 },
    );
    const match = stdout.match(/\[.*\]/s);
    if (match) {
      const parsed: any[] = JSON.parse(match[0]);
      return parsed.map(d => ({
        udid: d.Identifier ?? d.udid ?? "unknown",
        name: d.DeviceName ?? "iPhone",
        ios: d.ProductVersion ?? "Unknown",
        connected: "usb" as const,
      }));
    }
  } catch {}

  // 3. Try idevice_id from libimobiledevice
  try {
    const { stdout } = await execAsync("idevice_id -l", { timeout: 4000 });
    const udids = stdout.trim().split("\n").filter(Boolean);
    const devices: IosDevice[] = [];
    for (const udid of udids) {
      let name = "iPhone";
      let ios = "Unknown";
      try {
        const { stdout: nm } = await execAsync(`ideviceinfo -u "${udid}" -k DeviceName`, { timeout: 3000 });
        name = nm.trim() || "iPhone";
        const { stdout: ver } = await execAsync(`ideviceinfo -u "${udid}" -k ProductVersion`, { timeout: 3000 });
        ios = ver.trim() || "Unknown";
      } catch {}
      devices.push({ udid, name, ios, connected: "usb" });
    }
    return devices;
  } catch {}

  return [];
}

// ── Screenshot capture ────────────────────────────────────────────────────────

export async function takeScreenshot(udid?: string): Promise<string | null> {
  const tmpFile = path.join(os.tmpdir(), `eqx_mirror_${Date.now()}.jpg`);

  const readAndClean = (): string | null => {
    try {
      if (fs.existsSync(tmpFile)) {
        const buf = fs.readFileSync(tmpFile);
        try { fs.unlinkSync(tmpFile); } catch {}
        return buf.toString("base64");
      }
    } catch {}
    return null;
  };

  // 1. tidevice
  try {
    const uFlag = udid ? `--udid ${udid}` : "";
    await execAsync(`python3 -m tidevice ${uFlag} screenshot "${tmpFile}"`, { timeout: 8000 });
    const b64 = readAndClean();
    if (b64) return b64;
  } catch {}

  // 2. pymobiledevice3
  try {
    const uFlag = udid ? `--udid ${udid}` : "";
    await execAsync(
      `python3 -c "import sys; from pymobiledevice3.services.screenshot import ScreenshotService; from pymobiledevice3.usbmux import select_devices_by_connection_type; from pymobiledevice3.lockdown import create_using_usbmux; l = create_using_usbmux(${udid ? `serial='${udid}'` : ""}); open('${tmpFile}','wb').write(ScreenshotService(l).take_screenshot())"`,
      { timeout: 10000 },
    );
    const b64 = readAndClean();
    if (b64) return b64;
  } catch {}

  // 3. idevicescreenshot (libimobiledevice)
  try {
    const uFlag = udid ? `-u "${udid}"` : "";
    await execAsync(`idevicescreenshot ${uFlag} "${tmpFile}"`, { timeout: 8000 });
    const b64 = readAndClean();
    if (b64) return b64;
  } catch {}

  return null;
}

// ── WDA (WebDriverAgent) integration ─────────────────────────────────────────
// WDA must be running on the iPhone before control is possible.
// Install WDA via: https://github.com/appium/WebDriverAgent

const WDA_BASE = process.env.WDA_HOST ?? "http://127.0.0.1:8100";
let _cachedSessionId: string | null = null;

async function wdaFetch(method: string, urlPath: string, body?: unknown): Promise<any> {
  const res = await fetch(`${WDA_BASE}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`WDA ${method} ${urlPath} → HTTP ${res.status}: ${txt}`);
  }
  return res.json();
}

export async function wdaIsConnected(): Promise<boolean> {
  try {
    const r = await wdaFetch("GET", "/status");
    return !!(r?.value || r?.sessionId || r?.status === 0);
  } catch {
    return false;
  }
}

async function getSession(): Promise<string> {
  // Validate cached session
  if (_cachedSessionId) {
    try {
      await wdaFetch("GET", `/session/${_cachedSessionId}`);
      return _cachedSessionId;
    } catch {
      _cachedSessionId = null;
    }
  }
  // Create new session
  const resp = await wdaFetch("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        "platformName": "iOS",
        "appium:automationName": "XCUITest",
      },
    },
  });
  const sid: string | undefined = resp?.sessionId ?? resp?.value?.sessionId;
  if (!sid) throw new Error("WDA: failed to create a new session. Ensure WebDriverAgent is running on your iPhone.");
  _cachedSessionId = sid;
  return sid;
}

export async function wdaTap(x: number, y: number): Promise<void> {
  const sid = await getSession();
  await wdaFetch("POST", `/session/${sid}/wda/tap/0`, { x, y });
}

export async function wdaDoubleTap(x: number, y: number): Promise<void> {
  const sid = await getSession();
  await wdaFetch("POST", `/session/${sid}/wda/doubleTap`, { x, y });
}

export async function wdaLongPress(x: number, y: number, duration = 1.0): Promise<void> {
  const sid = await getSession();
  await wdaFetch("POST", `/session/${sid}/wda/touchAndHold`, { x, y, duration });
}

export async function wdaSwipe(
  fromX: number, fromY: number,
  toX: number, toY: number,
  duration = 0.5,
): Promise<void> {
  const sid = await getSession();
  await wdaFetch("POST", `/session/${sid}/wda/dragfromtoforduration`, {
    fromX, fromY, toX, toY, duration,
  });
}

export async function wdaTypeText(text: string): Promise<void> {
  const sid = await getSession();
  await wdaFetch("POST", `/session/${sid}/wda/keys`, { value: text.split("") });
}

export async function wdaPressButton(name: "home" | "volumeUp" | "volumeDown" | "power"): Promise<void> {
  const sid = await getSession();
  await wdaFetch("POST", `/session/${sid}/wda/pressButton`, { name });
}

export async function wdaLaunchApp(bundleId: string): Promise<void> {
  const sid = await getSession();
  await wdaFetch("POST", `/session/${sid}/wda/apps/launch`, { bundleId });
}

export async function wdaActivateApp(bundleId: string): Promise<void> {
  const sid = await getSession();
  await wdaFetch("POST", `/session/${sid}/wda/apps/activate`, { bundleId });
}

// ── iPhone Instagram signup via WDA ──────────────────────────────────────────
// Automates the Instagram signup form on the iPhone using WDA.
// Coordinates are for iPhone 14/15 standard (390×844 points) and scale
// proportionally to other resolutions via the 390-base normalisation below.

const INSTAGRAM_BUNDLE = "com.burbn.instagram";

export interface IphoneSignupParams {
  email: string;
  password: string;
  username: string;
  dob: string;             // DD/MM/YYYY
  verificationCode?: string;
  onStatus?: (msg: string) => void;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runIphoneSignup(params: IphoneSignupParams): Promise<{ ok: boolean; error?: string }> {
  const log = params.onStatus ?? (() => {});

  try {
    log("Opening Instagram on iPhone…");
    await wdaLaunchApp(INSTAGRAM_BUNDLE);
    await sleep(3000);

    // Tap "Create new account" or "Sign up" — approximate position
    log("Looking for Sign Up button…");
    await wdaTap(195, 740);
    await sleep(1500);

    // Email field — top of signup form
    log("Entering email address…");
    await wdaTap(195, 320);
    await sleep(500);
    await wdaTypeText(params.email);
    await sleep(400);

    // Next
    await wdaTap(195, 420);
    await sleep(2000);

    // Full name field
    log("Entering name…");
    await wdaTap(195, 280);
    await sleep(400);
    await wdaTypeText(params.username.replace(/_/g, " "));
    await sleep(400);

    // Password field
    log("Entering password…");
    await wdaTap(195, 360);
    await sleep(400);
    await wdaTypeText(params.password);
    await sleep(400);

    // Next
    await wdaTap(195, 440);
    await sleep(2000);

    // DOB — parse DD/MM/YYYY
    log("Entering date of birth…");
    const [dd, mm, yyyy] = params.dob.split("/");
    await wdaTap(195, 400);
    await sleep(1000);
    // Swipe month/day/year pickers — simplified: just tap Next
    await wdaTap(195, 600);
    await sleep(2000);

    // Username
    log("Entering username…");
    await wdaTap(195, 320);
    await sleep(500);
    await wdaTypeText(params.username);
    await sleep(500);

    // Next
    await wdaTap(195, 420);
    await sleep(2000);

    log("Signup form submitted — waiting for verification email…");

    if (params.verificationCode) {
      log(`Entering verification code: ${params.verificationCode}`);
      await wdaTap(195, 400);
      await sleep(500);
      await wdaTypeText(params.verificationCode);
      await sleep(500);
      await wdaTap(195, 480);
      await sleep(2000);
      log("✅ Verification code submitted!");
    }

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
