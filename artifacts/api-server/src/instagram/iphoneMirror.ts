import { exec, spawn, ChildProcess } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import { logger } from "../lib/logger";

const execAsync = promisify(exec);
const mlog = logger.child({ component: "mirror" });

// ── Bundled binary resolution ──────────────────────────────────────────────────
// In packaged Electron the binaries live under resources/bin/win32/ next to app/.
// In dev (Replit / macOS) the env var is not set, so we fall back to empty and
// the functions that need the binaries will no-op gracefully.

function getBinDir(): string {
  if (process.env.IDEVICE_BIN_DIR) {
    mlog.info({ dir: process.env.IDEVICE_BIN_DIR }, "[mirror] getBinDir: using IDEVICE_BIN_DIR env");
    return process.env.IDEVICE_BIN_DIR;
  }
  const candidates = [
    path.join(process.cwd(), "..", "electron", "resources", "bin", "win32"),
    path.join(process.cwd(), "resources", "bin", "win32"),
  ];
  for (const c of candidates) {
    const probe = path.join(c, "idevice_id.exe");
    if (fs.existsSync(probe)) {
      mlog.info({ dir: c }, "[mirror] getBinDir: found idevice_id.exe");
      return c;
    }
    mlog.debug({ checked: probe }, "[mirror] getBinDir: not found at candidate");
  }
  mlog.warn("[mirror] getBinDir: idevice_id.exe not found in any candidate — binaries missing?");
  return "";
}

function binPath(exe: string): string {
  const dir = getBinDir();
  if (!dir) return exe;
  return path.join(dir, exe);
}

// ── Apple Mobile Device DLL path resolver ─────────────────────────────────────
// idevice_id.exe loads our bundled DLLs but also needs AppleMobileDeviceInterface.dll
// from iTunes. That DLL is NOT in the system PATH when iTunes is installed from the
// Microsoft Store (UWP sandboxed app). We query the service to find its directory
// and inject it into PATH so every child_process spawn can load the DLL.

let _amdPath: string | null | undefined = undefined; // undefined = not yet resolved
let _isStoreItunes = false; // true when iTunes is the sandboxed Microsoft Store version

async function getAppleMobileDevicePath(): Promise<string> {
  if (_amdPath !== undefined) {
    mlog.debug({ cached: _amdPath }, "[mirror] getAppleMobileDevicePath: returning cached value");
    return _amdPath ?? "";
  }

  if (process.platform !== "win32") { _amdPath = ""; return ""; }

  // Known static paths (iTunes from Apple's website)
  const staticPaths = [
    "C:\\Program Files\\Common Files\\Apple\\Mobile Device Support",
    "C:\\Program Files (x86)\\Common Files\\Apple\\Mobile Device Support",
  ];
  for (const p of staticPaths) {
    const dll = path.join(p, "AppleMobileDeviceInterface.dll");
    const exists = fs.existsSync(dll);
    mlog.debug({ path: p, dllExists: exists }, "[mirror] getAppleMobileDevicePath: checking static path");
    if (exists) {
      _amdPath = p;
      mlog.info({ amdPath: p, source: "static" }, "[mirror] getAppleMobileDevicePath: DLL found (static iTunes install)");
      return p;
    }
  }

  // Dynamic: query service binary path (works for Microsoft Store iTunes too)
  try {
    const { stdout } = await execAsync('sc qc "Apple Mobile Device Service"', { timeout: 4000 });
    mlog.debug({ scOutput: stdout.trim() }, "[mirror] getAppleMobileDevicePath: sc qc output");
    const m = stdout.match(/BINARY_PATH_NAME\s*:\s*"?([^"\r\n]+)/i);
    if (m) {
      const svcBin = m[1].trim().replace(/"/g, "").replace(/^"|"$/g, "");
      const svcDir = path.dirname(svcBin);
      mlog.info(`[mirror] getAppleMobileDevicePath: service binary at: "${svcBin}" — dir: "${svcDir}"`);

      // Detect Microsoft Store iTunes — its binaries live in a sandboxed WindowsApps directory
      // that child processes cannot read DLLs from. libimobiledevice tools will crash on load.
      if (svcDir.toLowerCase().includes("windowsapps")) {
        _isStoreItunes = true;
        mlog.warn(`[mirror] getAppleMobileDevicePath: MICROSOFT STORE ITUNES DETECTED — service is in WindowsApps sandbox: "${svcDir}". libimobiledevice DLLs are inaccessible from this location. idevice_id.exe will crash. User must uninstall Store iTunes and install from apple.com.`);
        _amdPath = "";
        return "";
      }

      const candidates = [
        svcDir,
        path.join(svcDir, ".."),
        path.join(svcDir, "..", ".."),
        path.join(svcDir, "..", "..", ".."),
      ];
      for (const c of candidates) {
        const resolved = path.resolve(c);
        const dll = path.join(resolved, "AppleMobileDeviceInterface.dll");
        const exists = fs.existsSync(dll);
        mlog.info(`[mirror] getAppleMobileDevicePath: checking "${resolved}" — DLL exists: ${exists}`);
        if (exists) {
          _amdPath = resolved;
          mlog.info(`[mirror] getAppleMobileDevicePath: DLL found at: "${resolved}" (service-query)`);
          return resolved;
        }
      }
      mlog.warn(`[mirror] getAppleMobileDevicePath: DLL not found in any candidate under "${svcDir}" — using svcDir as fallback`);
      _amdPath = svcDir;
      return svcDir;
    } else {
      mlog.warn("[mirror] getAppleMobileDevicePath: could not parse BINARY_PATH_NAME from sc qc output");
    }
  } catch (err: any) {
    mlog.warn({ err: String(err?.message ?? err) }, "[mirror] getAppleMobileDevicePath: sc qc failed");
  }

  mlog.warn("[mirror] getAppleMobileDevicePath: could not find Apple DLL path — idevice tools may fail to load DLLs");
  _amdPath = "";
  return "";
}

/** Build an env object that includes Apple's Mobile Device DLL directory in PATH */
async function buildEnvWithApplePath(): Promise<NodeJS.ProcessEnv> {
  const amdPath = await getAppleMobileDevicePath();
  const binDir  = getBinDir();
  const extra   = [binDir, amdPath].filter(Boolean).join(path.delimiter);
  const usbmuxd = process.env.USBMUXD_SOCKET_ADDRESS ?? "tcp:127.0.0.1:27015";
  const finalPath = extra ? `${extra}${path.delimiter}${process.env.PATH ?? ""}` : process.env.PATH;
  mlog.info(
    { binDir, amdPath, usbmuxdSocket: usbmuxd, injectedPathPrefix: extra || "(none)" },
    "[mirror] buildEnvWithApplePath: env ready",
  );
  return {
    ...process.env,
    PATH: finalPath,
    USBMUXD_SOCKET_ADDRESS: usbmuxd,
  };
}

// ── Device detection ──────────────────────────────────────────────────────────

export interface IosDevice {
  udid: string;
  name: string;
  ios: string;
  connected: "usb" | "wifi";
}

export interface IphoneDiagnostics {
  binaryFound: boolean;
  binaryPath: string;
  appleDriverRunning: boolean;
  rawOutput: string;
  rawError: string;
  suggestion: string;
  msStoreItunes?: boolean;
}

/** Run a full diagnostic: is the binary present? Is Apple's USB driver loaded? */
export async function diagnoseIphoneSupport(): Promise<IphoneDiagnostics & { amdPath: string }> {
  mlog.info("[mirror] diagnoseIphoneSupport: starting");
  const binDir = getBinDir();
  const exe = path.join(binDir, "idevice_id.exe");
  const binaryFound = binDir !== "" && fs.existsSync(exe);
  mlog.info({ binDir, exe, binaryFound }, "[mirror] diagnoseIphoneSupport: binary check");

  // Check if Apple Mobile Device Service is running (Windows only)
  let appleDriverRunning = false;
  if (process.platform === "win32") {
    try {
      const { stdout } = await execAsync('sc query "Apple Mobile Device Service"', { timeout: 4000 });
      appleDriverRunning = stdout.includes("RUNNING");
      mlog.info({ appleDriverRunning, scOutput: stdout.trim() }, "[mirror] diagnoseIphoneSupport: AMDS service check (sc query)");
    } catch (e1: any) {
      mlog.warn({ err: String(e1?.message ?? e1) }, "[mirror] diagnoseIphoneSupport: sc query failed, trying tasklist");
      try {
        const { stdout: tl } = await execAsync(
          "tasklist /FI \"IMAGENAME eq AppleMobileDeviceService.exe\" /NH",
          { timeout: 4000 },
        );
        appleDriverRunning = tl.includes("AppleMobileDeviceService.exe");
        mlog.info({ appleDriverRunning, tasklistOutput: tl.trim() }, "[mirror] diagnoseIphoneSupport: AMDS check via tasklist");
      } catch (e2: any) {
        mlog.warn({ err: String(e2?.message ?? e2) }, "[mirror] diagnoseIphoneSupport: tasklist also failed");
      }
    }
  }

  // Resolve Apple DLL path and build enriched env
  const amdPath = await getAppleMobileDevicePath();
  const env = await buildEnvWithApplePath();

  let rawOutput = "";
  let rawError = "";
  let debugOutput = "";
  if (binaryFound) {
    const cmd = `"${exe}" -l`;
    mlog.info({ cmd, usbmuxd: env.USBMUXD_SOCKET_ADDRESS }, "[mirror] diagnoseIphoneSupport: running idevice_id -l");
    try {
      const result = await execAsync(cmd, { timeout: 6000, env });
      rawOutput = result.stdout.trim();
      rawError = (result as any).stderr?.trim() ?? "";
      mlog.info(`[mirror] diagnoseIphoneSupport: idevice_id -l result — stdout="${rawOutput}" stderr="${rawError}"`);
    } catch (err: any) {
      rawError = String(err?.stderr ?? err?.message ?? err);
      mlog.warn(`[mirror] diagnoseIphoneSupport: idevice_id -l threw — code=${(err as any)?.code} stderr="${String(err?.stderr ?? "")}" message="${String(err?.message ?? err)}"`);
    }

    // If nothing came back, try with --debug to get verbose output for diagnosis
    if (rawOutput === "" && rawError === "") {
      const dbgCmd = `"${exe}" --debug -l`;
      mlog.info(`[mirror] diagnoseIphoneSupport: idevice_id -l returned empty — retrying with --debug`);
      try {
        const dbg = await execAsync(dbgCmd, { timeout: 8000, env });
        debugOutput = [dbg.stdout, (dbg as any).stderr].filter(Boolean).join("\n").trim();
        mlog.info(`[mirror] diagnoseIphoneSupport: idevice_id --debug output: "${debugOutput}"`);
      } catch (err: any) {
        debugOutput = String(err?.stderr ?? err?.stdout ?? err?.message ?? "").trim();
        mlog.warn(`[mirror] diagnoseIphoneSupport: idevice_id --debug threw — code=${(err as any)?.code} output="${debugOutput}"`);
      }
    }
  } else {
    mlog.warn("[mirror] diagnoseIphoneSupport: skipping idevice_id run — binary not found");
  }

  let suggestion = "";
  if (!binaryFound) {
    suggestion = "Equinox binaries are missing. Try reinstalling the app.";
  } else if (_isStoreItunes) {
    suggestion = "ms_store_itunes";
  } else if (!appleDriverRunning && process.platform === "win32") {
    suggestion = "itunes_required";
  } else if (rawOutput === "" && rawError === "") {
    suggestion = "no_connection";
  } else if (rawError) {
    suggestion = `error:${rawError}`;
  } else {
    suggestion = "ok";
  }

  mlog.info(`[mirror] diagnoseIphoneSupport: complete — suggestion="${suggestion}" binaryFound=${binaryFound} appleDriverRunning=${appleDriverRunning} amdPath="${amdPath}" msStoreItunes=${_isStoreItunes}`);
  return { binaryFound, binaryPath: exe, appleDriverRunning, amdPath, rawOutput, rawError, debugOutput, suggestion, msStoreItunes: _isStoreItunes };
}

export async function listConnectedDevices(): Promise<IosDevice[]> {
  mlog.info("[mirror] listConnectedDevices: starting");
  const env = await buildEnvWithApplePath();

  // 1. Use bundled idevice_id.exe with Apple DLL path injected
  try {
    const exe = binPath("idevice_id.exe");
    const cmd = `"${exe}" -l`;
    mlog.info({ cmd, usbmuxd: env.USBMUXD_SOCKET_ADDRESS }, "[mirror] listConnectedDevices: running bundled idevice_id.exe");
    const { stdout, stderr } = await execAsync(cmd, { timeout: 5000, env }) as any;
    mlog.info(`[mirror] listConnectedDevices: idevice_id.exe result — stdout="${stdout?.trim()}" stderr="${stderr?.trim()}"`);
    const udids = stdout.trim().split("\n").filter(Boolean);
    if (udids.length === 0) {
      mlog.warn("[mirror] listConnectedDevices: idevice_id.exe returned no UDIDs");
      // fall through to PATH-based fallback
    } else {
      mlog.info({ udids }, "[mirror] listConnectedDevices: found UDIDs");
      const devices: IosDevice[] = [];
      for (const udid of udids) {
        let name = "iPhone";
        let ios = "Unknown";
        try {
          const infoExe = binPath("ideviceinfo.exe");
          const { stdout: nm } = await execAsync(`"${infoExe}" -u "${udid.trim()}" -k DeviceName`, { timeout: 3000, env });
          name = nm.trim() || "iPhone";
          const { stdout: ver } = await execAsync(`"${infoExe}" -u "${udid.trim()}" -k ProductVersion`, { timeout: 3000, env });
          ios = ver.trim() || "Unknown";
        } catch (e: any) {
          mlog.warn({ udid, err: String(e?.message ?? e) }, "[mirror] listConnectedDevices: ideviceinfo failed for UDID");
        }
        devices.push({ udid: udid.trim(), name, ios, connected: "usb" });
      }
      mlog.info({ count: devices.length }, "[mirror] listConnectedDevices: returning devices");
      return devices;
    }
  } catch (err: any) {
    mlog.warn(`[mirror] listConnectedDevices: bundled idevice_id.exe threw — code=${(err as any)?.code} stderr="${String(err?.stderr ?? "")}" message="${String(err?.message ?? err)}"`);
  }

  // 2. Try idevice_id from PATH (dev environments with libimobiledevice)
  try {
    mlog.info("[mirror] listConnectedDevices: trying idevice_id from PATH");
    const { stdout } = await execAsync("idevice_id -l", { timeout: 4000, env });
    const udids = stdout.trim().split("\n").filter(Boolean);
    mlog.info({ udids }, "[mirror] listConnectedDevices: PATH idevice_id result");
    const devices: IosDevice[] = [];
    for (const udid of udids) {
      let name = "iPhone";
      let ios = "Unknown";
      try {
        const { stdout: nm } = await execAsync(`ideviceinfo -u "${udid.trim()}" -k DeviceName`, { timeout: 3000, env });
        name = nm.trim() || "iPhone";
        const { stdout: ver } = await execAsync(`ideviceinfo -u "${udid.trim()}" -k ProductVersion`, { timeout: 3000, env });
        ios = ver.trim() || "Unknown";
      } catch {}
      devices.push({ udid: udid.trim(), name, ios, connected: "usb" });
    }
    return devices;
  } catch (err: any) {
    mlog.warn({ err: String(err?.message ?? err) }, "[mirror] listConnectedDevices: PATH idevice_id also failed");
  }

  mlog.warn("[mirror] listConnectedDevices: all detection methods exhausted — returning empty");
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
