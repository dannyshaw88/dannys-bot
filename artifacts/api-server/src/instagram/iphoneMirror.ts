import { exec, spawn, ChildProcess } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";

const execAsync = promisify(exec);

// ── Bundled binary resolution ──────────────────────────────────────────────────
// In packaged Electron the binaries live under resources/bin/win32/ next to app/.
// In dev (Replit / macOS) the env var is not set, so we fall back to empty and
// the functions that need the binaries will no-op gracefully.

function getBinDir(): string {
  if (process.env.IDEVICE_BIN_DIR) return process.env.IDEVICE_BIN_DIR;
  // Fallback: look for resources/bin/win32 relative to the electron package
  const candidates = [
    path.join(process.cwd(), "..", "electron", "resources", "bin", "win32"),
    path.join(process.cwd(), "resources", "bin", "win32"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "idevice_id.exe"))) return c;
  }
  return "";
}

function binPath(exe: string): string {
  const dir = getBinDir();
  if (!dir) return exe; // fall back to PATH (dev environment)
  return path.join(dir, exe);
}

// ── Device detection ──────────────────────────────────────────────────────────

export interface IosDevice {
  udid: string;
  name: string;
  ios: string;
  connected: "usb" | "wifi";
}

export async function listConnectedDevices(): Promise<IosDevice[]> {
  // 1. Use bundled idevice_id.exe
  try {
    const exe = binPath("idevice_id.exe");
    const { stdout } = await execAsync(`"${exe}" -l`, { timeout: 5000 });
    const udids = stdout.trim().split("\n").filter(Boolean);
    if (udids.length === 0) return [];
    const devices: IosDevice[] = [];
    for (const udid of udids) {
      let name = "iPhone";
      let ios = "Unknown";
      try {
        const infoExe = binPath("ideviceinfo.exe");
        const { stdout: nm } = await execAsync(`"${infoExe}" -u "${udid.trim()}" -k DeviceName`, { timeout: 3000 });
        name = nm.trim() || "iPhone";
        const { stdout: ver } = await execAsync(`"${infoExe}" -u "${udid.trim()}" -k ProductVersion`, { timeout: 3000 });
        ios = ver.trim() || "Unknown";
      } catch {}
      devices.push({ udid: udid.trim(), name, ios, connected: "usb" });
    }
    return devices;
  } catch {}

  // 2. Try idevice_id from PATH (dev environments with libimobiledevice)
  try {
    const { stdout } = await execAsync("idevice_id -l", { timeout: 4000 });
    const udids = stdout.trim().split("\n").filter(Boolean);
    const devices: IosDevice[] = [];
    for (const udid of udids) {
      let name = "iPhone";
      let ios = "Unknown";
      try {
        const { stdout: nm } = await execAsync(`ideviceinfo -u "${udid.trim()}" -k DeviceName`, { timeout: 3000 });
        name = nm.trim() || "iPhone";
        const { stdout: ver } = await execAsync(`ideviceinfo -u "${udid.trim()}" -k ProductVersion`, { timeout: 3000 });
        ios = ver.trim() || "Unknown";
      } catch {}
      devices.push({ udid: udid.trim(), name, ios, connected: "usb" });
    }
    return devices;
  } catch {}

  return [];
}

// ── iproxy auto-manager ───────────────────────────────────────────────────────
// Equinox starts iproxy internally — no CMD prompt ever needed.

let iproxyProc: ChildProcess | null = null;
let iproxyUdid: string | null = null;
let iproxyPort = 8100;

export function getIproxyStatus(): { running: boolean; udid: string | null; port: number } {
  return { running: iproxyProc !== null, udid: iproxyUdid, port: iproxyPort };
}

export async function startIproxy(udid: string, localPort = 8100, devicePort = 8100): Promise<{ ok: boolean; error?: string }> {
  // Stop existing iproxy if for a different device
  if (iproxyProc && iproxyUdid !== udid) {
    stopIproxy();
  }
  if (iproxyProc) return { ok: true }; // already running for this device

  iproxyPort = localPort;
  iproxyUdid = udid;

  const exe = binPath("iproxy.exe");

  return new Promise((resolve) => {
    try {
      const args = [`${localPort}`, `${devicePort}`, "--udid", udid];
      iproxyProc = spawn(exe, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      iproxyProc.on("error", (err) => {
        iproxyProc = null;
        resolve({ ok: false, error: `iproxy failed to start: ${err.message}` });
      });

      iproxyProc.on("exit", (code) => {
        iproxyProc = null;
      });

      // Give iproxy 800ms to either start or fail
      setTimeout(() => {
        if (iproxyProc) {
          resolve({ ok: true });
        } else {
          resolve({ ok: false, error: "iproxy exited immediately" });
        }
      }, 800);
    } catch (err: any) {
      iproxyProc = null;
      resolve({ ok: false, error: String(err.message ?? err) });
    }
  });
}

export function stopIproxy(): void {
  if (iproxyProc) {
    try { iproxyProc.kill(); } catch {}
    iproxyProc = null;
    iproxyUdid = null;
  }
}

// ── WDA download + install ────────────────────────────────────────────────────
// Downloads a pre-built WDA IPA from GitHub and installs it on the device
// using bundled ideviceinstaller.exe. Zero CMD prompts required.

const WDA_IPA_URL = "https://github.com/nicowillis/webdriveragent-ipa/releases/download/v1.0.0/WebDriverAgent.ipa";
const WDA_BUNDLE_ID = "com.facebook.WebDriverAgentRunner.xctrunner";

export type WdaInstallStatus = {
  step: "downloading" | "installing" | "done" | "error";
  progress?: number; // 0-100 for download
  message: string;
};

const installListeners: Map<string, (s: WdaInstallStatus) => void> = new Map();

export function onWdaInstallStatus(id: string, cb: (s: WdaInstallStatus) => void): void {
  installListeners.set(id, cb);
}
export function offWdaInstallStatus(id: string): void {
  installListeners.delete(id);
}

function emitStatus(id: string, s: WdaInstallStatus): void {
  installListeners.get(id)?.(s);
}

function downloadFile(url: string, dest: string, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { "User-Agent": "Equinox/1.0" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlink(dest, () => {});
        downloadFile(res.headers.location!, dest, onProgress).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const total = parseInt(res.headers["content-length"] ?? "0", 10);
      let received = 0;
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (total > 0 && onProgress) onProgress(Math.round((received / total) * 100));
      });
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    });
    req.on("error", reject);
  });
}

export async function installWdaOnDevice(
  udid: string,
  sessionId: string,
): Promise<{ ok: boolean; error?: string }> {
  const tmpIpa = path.join(os.tmpdir(), `wda_${Date.now()}.ipa`);

  try {
    // Step 1: Download IPA
    emitStatus(sessionId, { step: "downloading", progress: 0, message: "Downloading control agent (one-time)…" });
    await downloadFile(WDA_IPA_URL, tmpIpa, (pct) => {
      emitStatus(sessionId, { step: "downloading", progress: pct, message: `Downloading control agent… ${pct}%` });
    });
    emitStatus(sessionId, { step: "downloading", progress: 100, message: "Download complete. Installing on iPhone…" });

    // Step 2: Install via bundled ideviceinstaller.exe
    const installer = binPath("ideviceinstaller.exe");
    emitStatus(sessionId, { step: "installing", message: "Installing on iPhone — this takes ~30 seconds…" });

    await execAsync(`"${installer}" -u "${udid}" -i "${tmpIpa}"`, { timeout: 120_000 });

    emitStatus(sessionId, { step: "done", message: "✅ Control agent installed! Starting connection…" });
    return { ok: true };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    emitStatus(sessionId, { step: "error", message: `⚠ ${msg}` });
    return { ok: false, error: msg };
  } finally {
    try { fs.unlinkSync(tmpIpa); } catch {}
  }
}

// ── Screenshot capture (for the mirror display) ───────────────────────────────

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

  // 1. Use bundled idevicescreenshot.exe
  try {
    const exe = binPath("idevicescreenshot.exe");
    const uFlag = udid ? `-u "${udid}"` : "";
    await execAsync(`"${exe}" ${uFlag} "${tmpFile}"`, { timeout: 8000 });
    const b64 = readAndClean();
    if (b64) return b64;
  } catch {}

  // 2. Fall back to PATH version (dev)
  try {
    const uFlag = udid ? `-u "${udid}"` : "";
    await execAsync(`idevicescreenshot ${uFlag} "${tmpFile}"`, { timeout: 8000 });
    const b64 = readAndClean();
    if (b64) return b64;
  } catch {}

  return null;
}

// ── WDA (WebDriverAgent) integration ─────────────────────────────────────────

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
  if (_cachedSessionId) {
    try {
      await wdaFetch("GET", `/session/${_cachedSessionId}`);
      return _cachedSessionId;
    } catch {
      _cachedSessionId = null;
    }
  }
  const resp = await wdaFetch("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        "platformName": "iOS",
        "appium:automationName": "XCUITest",
      },
    },
  });
  const sid: string | undefined = resp?.sessionId ?? resp?.value?.sessionId;
  if (!sid) throw new Error("WDA session creation failed");
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

const INSTAGRAM_BUNDLE = "com.burbn.instagram";

export interface IphoneSignupParams {
  email: string;
  password: string;
  username: string;
  dob: string;
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

    log("Looking for Sign Up button…");
    await wdaTap(195, 740);
    await sleep(1500);

    log("Entering email address…");
    await wdaTap(195, 320);
    await sleep(500);
    await wdaTypeText(params.email);
    await sleep(400);

    await wdaTap(195, 420);
    await sleep(2000);

    log("Entering name…");
    await wdaTap(195, 280);
    await sleep(400);
    await wdaTypeText(params.username.replace(/_/g, " "));
    await sleep(400);

    log("Entering password…");
    await wdaTap(195, 360);
    await sleep(400);
    await wdaTypeText(params.password);
    await sleep(400);

    await wdaTap(195, 440);
    await sleep(2000);

    log("Entering date of birth…");
    await wdaTap(195, 400);
    await sleep(1000);
    await wdaTap(195, 600);
    await sleep(2000);

    log("Entering username…");
    await wdaTap(195, 320);
    await sleep(500);
    await wdaTypeText(params.username);
    await sleep(500);

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
