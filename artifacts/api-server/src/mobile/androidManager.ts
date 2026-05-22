import { spawn, spawnSync, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { logger } from "../lib/logger";

export type ToolStatus = {
  found: boolean;
  path: string | null;
  version: string | null;
};

export type AndroidToolset = {
  adb: ToolStatus;
  emulator: ToolStatus;
  avdmanager: ToolStatus;
  scrcpy: ToolStatus;
  sdkRoot: string | null;
};

export type AvdInfo = {
  name: string;
  running: boolean;
  serial: string | null;
};

export type DeviceInfo = {
  serial: string;
  state: string;
  product?: string;
  model?: string;
  avdName?: string;
};

const runningEmulators = new Map<string, ChildProcess>();
const runningScrcpy = new Map<string, ChildProcess>();

function which(cmd: string): string | null {
  const isWin = process.platform === "win32";
  const exts = isWin ? (process.env.PATHEXT?.split(";") ?? [".EXE", ".CMD", ".BAT"]) : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const d of dirs) {
    for (const ext of exts) {
      const full = path.join(d, cmd + ext);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch { /* ignore */ }
    }
  }
  return null;
}

/** Scan common user locations for scrcpy.exe on Windows — so PATH config is not required. */
function findScrcpyInCommonLocations(): string | null {
  if (process.platform !== "win32") return null;
  const home = os.homedir();
  const searchRoots = [
    path.join(home, "Desktop"),
    path.join(home, "Downloads"),
    path.join(home, "AppData", "Local", "Programs"),
    "C:\\scrcpy",
    "C:\\Program Files\\scrcpy",
    "C:\\tools",
  ];
  for (const root of searchRoots) {
    try {
      // Check root itself first
      const direct = path.join(root, "scrcpy.exe");
      if (fs.existsSync(direct)) return direct;
      // Then scan one level of subdirectories (e.g. scrcpy-win64-v3.1/)
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(root, entry.name, "scrcpy.exe");
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch { /* ignore */ }
      }
    } catch { /* root doesn't exist, skip */ }
  }
  return null;
}

function candidateSdkRoots(): string[] {
  const out: string[] = [];
  const env = process.env;
  const push = (p?: string | null) => { if (p && !out.includes(p)) out.push(p); };
  push(env.ANDROID_HOME);
  push(env.ANDROID_SDK_ROOT);
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA;
    const userProf = env.USERPROFILE;
    if (local) push(path.join(local, "Android", "Sdk"));
    if (userProf) push(path.join(userProf, "AppData", "Local", "Android", "Sdk"));
    push("C:\\Android\\Sdk");
    push("C:\\Program Files\\Android\\android-sdk");
    push("C:\\Program Files (x86)\\Android\\android-sdk");
  } else if (process.platform === "darwin") {
    const home = os.homedir();
    push(path.join(home, "Library", "Android", "sdk"));
  } else {
    const home = os.homedir();
    push(path.join(home, "Android", "Sdk"));
    push("/opt/android-sdk");
  }
  return out;
}

function findInSdk(toolName: string, sdkRoot: string): string | null {
  const isWin = process.platform === "win32";
  const exe = isWin ? `${toolName}.exe` : toolName;
  const bat = isWin ? `${toolName}.bat` : null;
  const candidates = [
    path.join(sdkRoot, "platform-tools", exe),
    path.join(sdkRoot, "emulator", exe),
    path.join(sdkRoot, "cmdline-tools", "latest", "bin", exe),
    path.join(sdkRoot, "cmdline-tools", "latest", "bin", bat ?? ""),
    path.join(sdkRoot, "tools", "bin", exe),
    path.join(sdkRoot, "tools", "bin", bat ?? ""),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* ignore */ }
  }
  return null;
}

function getVersion(toolPath: string, args: string[] = ["--version"]): string | null {
  try {
    const r = spawnSync(toolPath, args, { encoding: "utf8", timeout: 5000 });
    const out = (r.stdout || r.stderr || "").trim().split("\n")[0];
    return out || null;
  } catch { return null; }
}

// ── Emulator-bundled ADB search paths ──────────────────────────────────────────
// BlueStacks, LDPlayer, Nox etc. all ship their own adb.exe — we look there
// first so users never need to install Android Studio.

function emulatorAdbCandidates(): string[] {
  if (process.platform !== "win32") return [];
  const local = process.env.LOCALAPPDATA ?? "";
  const pf    = process.env.PROGRAMFILES ?? "C:\\Program Files";
  const pf86  = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
  return [
    // BlueStacks 5 / 10
    path.join(pf, "BlueStacks_nxt", "HD-Adb.exe"),
    path.join(pf86, "BlueStacks_nxt", "HD-Adb.exe"),
    path.join(pf, "BlueStacks", "HD-Adb.exe"),
    path.join(pf86, "BlueStacks", "HD-Adb.exe"),
    // LDPlayer 9
    "C:\\LDPlayer\\LDPlayer9\\adb.exe",
    path.join(local, "Programs", "LDPlayer9", "adb.exe"),
    // LDPlayer 4
    "C:\\LDPlayer\\LDPlayer4.0\\adb.exe",
    path.join(local, "Programs", "LDPlayer4.0", "adb.exe"),
    // Nox
    path.join(pf, "Nox", "bin", "nox_adb.exe"),
    path.join(pf86, "Nox", "bin", "nox_adb.exe"),
    "C:\\Program Files\\Nox\\bin\\nox_adb.exe",
    // MuMu Player 12
    path.join(pf, "MuMu Player", "shell", "adb.exe"),
    path.join(pf, "MuMuPlayer-12.0", "shell", "adb.exe"),
    // MEmu
    path.join(pf, "Microvirt", "MEmu", "adb.exe"),
    path.join(pf86, "Microvirt", "MEmu", "adb.exe"),
    // Genymotion
    path.join(pf, "Genymobile", "Genymotion", "tools", "adb.exe"),
  ];
}

function findAdbPath(): string | null {
  // 1. PATH / env
  let p = which("adb");
  if (p) return p;
  // 2. Android SDK
  const sdkCandidates = candidateSdkRoots();
  const sdkRoot = sdkCandidates.find(r => { try { return fs.statSync(r).isDirectory(); } catch { return false; } }) ?? null;
  if (sdkRoot) { p = findInSdk("adb", sdkRoot); if (p) return p; }
  // 3. Emulator bundled adb
  for (const c of emulatorAdbCandidates()) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* ignore */ }
  }
  return null;
}

export function detectToolset(): AndroidToolset {
  const sdkCandidates = candidateSdkRoots();
  const sdkRoot = sdkCandidates.find(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }) ?? null;

  function locate(name: string): ToolStatus {
    let p: string | null = null;
    if (name === "adb") {
      p = findAdbPath();
    } else {
      p = which(name);
      if (!p && sdkRoot) p = findInSdk(name, sdkRoot);
      if (!p && name === "scrcpy") p = findScrcpyInCommonLocations();
    }
    if (p) return { found: true, path: p, version: getVersion(p) };
    return { found: false, path: null, version: null };
  }

  return {
    adb: locate("adb"),
    emulator: locate("emulator"),
    avdmanager: locate("avdmanager"),
    scrcpy: locate("scrcpy"),
    sdkRoot,
  };
}

// ── Emulator auto-discovery ────────────────────────────────────────────────────
// Known default ADB ports for popular emulators.
export const KNOWN_EMULATOR_PORTS: Array<{ label: string; address: string }> = [
  { label: "BlueStacks (instance 1)", address: "127.0.0.1:5555" },
  { label: "BlueStacks (instance 2)", address: "127.0.0.1:5565" },
  { label: "BlueStacks (instance 3)", address: "127.0.0.1:5575" },
  { label: "BlueStacks (instance 4)", address: "127.0.0.1:5585" },
  { label: "LDPlayer",                address: "127.0.0.1:5554" },
  { label: "LDPlayer (alt)",          address: "127.0.0.1:5556" },
  { label: "Nox Player",              address: "127.0.0.1:62001" },
  { label: "MuMu Player",             address: "127.0.0.1:7555" },
  { label: "MEmu",                    address: "127.0.0.1:21503" },
  { label: "Genymotion",              address: "127.0.0.1:5555" },
];

/** Connect to an ADB address (e.g. "127.0.0.1:5555"). Returns ok + message. */
export async function connectDevice(address: string): Promise<{ ok: boolean; message: string }> {
  const adbPath = findAdbPath();
  if (!adbPath) return { ok: false, message: "adb not found. Install BlueStacks, LDPlayer, or Nox — they include adb automatically." };
  const r = spawnSync(adbPath, ["connect", address], { encoding: "utf8", timeout: 8000 });
  const out = (r.stdout || r.stderr || "").trim();
  const ok = /connected|already connected/i.test(out);
  return { ok, message: out || "No response from adb" };
}

/** Disconnect an ADB address. */
export async function disconnectDevice(address: string): Promise<void> {
  const adbPath = findAdbPath();
  if (!adbPath) return;
  spawnSync(adbPath, ["disconnect", address], { encoding: "utf8", timeout: 5000 });
}

/** Try all known emulator ports and return which ones responded. */
export async function autoDiscoverEmulators(): Promise<Array<{ address: string; label: string; connected: boolean; message: string }>> {
  const results = await Promise.all(
    KNOWN_EMULATOR_PORTS.map(async ({ label, address }) => {
      const r = await connectDevice(address);
      return { address, label, connected: r.ok, message: r.message };
    }),
  );
  return results;
}

function requireTool(t: ToolStatus, name: string): string {
  if (!t.found || !t.path) throw new Error(`${name} is not installed or not found on this system`);
  return t.path;
}

export async function listAvds(): Promise<string[]> {
  const tools = detectToolset();
  if (!tools.emulator.found || !tools.emulator.path) return [];
  const r = spawnSync(tools.emulator.path, ["-list-avds"], { encoding: "utf8", timeout: 8000 });
  return (r.stdout || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

export async function listDevices(): Promise<DeviceInfo[]> {
  const tools = detectToolset();
  if (!tools.adb.found || !tools.adb.path) return [];
  const r = spawnSync(tools.adb.path, ["devices", "-l"], { encoding: "utf8", timeout: 8000 });
  const lines = (r.stdout || "").split(/\r?\n/).slice(1);
  const out: DeviceInfo[] = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    const parts = s.split(/\s+/);
    if (parts.length < 2) continue;
    const dev: DeviceInfo = { serial: parts[0], state: parts[1] };
    for (const p of parts.slice(2)) {
      const m = p.match(/^(\w+):(.+)$/);
      if (m) (dev as any)[m[1]] = m[2];
    }
    if (dev.serial.startsWith("emulator-")) {
      try {
        const ar = spawnSync(tools.adb.path, ["-s", dev.serial, "emu", "avd", "name"], { encoding: "utf8", timeout: 4000 });
        const first = (ar.stdout || "").split(/\r?\n/)[0]?.trim();
        if (first) dev.avdName = first;
      } catch { /* ignore */ }
    }
    out.push(dev);
  }
  return out;
}

export async function getAvdInfo(): Promise<AvdInfo[]> {
  const [avds, devices] = await Promise.all([listAvds(), listDevices()]);
  return avds.map(name => {
    const dev = devices.find(d => d.avdName === name);
    return { name, running: !!dev, serial: dev?.serial ?? null };
  });
}

// ── Device-ID / IMEI spoofing helpers ─────────────────────────────────────────
// On emulators (AVDs) the android_id setting is writable without root.
// Instagram uses android_id + advertising ID to fingerprint devices; setting a
// unique android_id per instance gives each emulator a distinct identity.

export async function getAndroidId(serial: string): Promise<string | null> {
  const tools = detectToolset();
  if (!tools.adb.found || !tools.adb.path) return null;
  const r = spawnSync(tools.adb.path, ["-s", serial, "shell", "settings", "get", "secure", "android_id"], {
    encoding: "utf8", timeout: 5000,
  });
  const val = (r.stdout || "").trim();
  return val && val !== "null" ? val : null;
}

export async function setAndroidId(serial: string, id: string): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  // Try direct settings put first (works on most emulators without root)
  const r = spawnSync(adb, ["-s", serial, "shell", "settings", "put", "secure", "android_id", id], {
    encoding: "utf8", timeout: 5000,
  });
  if ((r.status ?? 0) !== 0) {
    throw new Error(`Could not set android_id: ${r.stderr || r.stdout || "adb error"}`);
  }
}

export function randomAndroidId(): string {
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 16; i++) out += chars[Math.floor(Math.random() * 16)];
  return out;
}

export async function createAvd(name: string, packageName = "system-images;android-30;google_apis;x86_64"): Promise<void> {
  const tools = detectToolset();
  const avd = requireTool(tools.avdmanager, "avdmanager");
  const r = spawnSync(avd, ["create", "avd", "-n", name, "-k", packageName, "-d", "pixel_5", "--force"], {
    encoding: "utf8",
    input: "no\n",
    timeout: 60000,
  });
  if (r.status !== 0) {
    throw new Error(`avdmanager failed: ${r.stderr || r.stdout || "unknown error"}`);
  }
}

export function startEmulator(
  avdName: string,
  opts: { noWindow?: boolean; port?: number; proxy?: { host: string; port: number; user?: string; pass?: string } } = {},
): { pid: number; serial: string } {
  const tools = detectToolset();
  const emu = requireTool(tools.emulator, "emulator");
  const args = ["-avd", avdName, "-no-snapshot-load", "-no-boot-anim"];
  if (opts.noWindow) args.push("-no-window");
  const port = opts.port ?? null;
  if (port) args.push("-port", String(port));
  // Proxy: pass credentials in the URL so the emulator's HTTP stack uses them
  if (opts.proxy) {
    const { host, port: pport, user, pass } = opts.proxy;
    const auth = (user && pass) ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : "";
    args.push("-http-proxy", `http://${auth}${host}:${pport}`);
  }
  const child = spawn(emu, args, { detached: false, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", d => logger.debug({ avdName, out: d.toString() }, "emulator stdout"));
  child.stderr?.on("data", d => logger.debug({ avdName, err: d.toString() }, "emulator stderr"));
  child.on("exit", (code) => { runningEmulators.delete(avdName); logger.info({ avdName, code }, "emulator exited"); });
  runningEmulators.set(avdName, child);
  const serial = port ? `emulator-${port}` : "pending";
  return { pid: child.pid ?? 0, serial };
}

/**
 * Returns the default gateway IP of the Android device — i.e. the IP address
 * that the Windows host exposes to the Android VM. This is what we set the
 * relay to listen on so BlueStacks can reach it.
 * Parses `ip route show default` output: "default via 10.0.2.2 dev eth0 ..."
 */
export function getDeviceGateway(serial: string): string | null {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const r = spawnSync(
    adb,
    ["-s", serial, "shell", "ip", "route", "show", "default"],
    { encoding: "utf8", timeout: 5000 },
  );
  const match = (r.stdout ?? "").match(/default via ([\d.]+)/);
  return match ? match[1] : null;
}

export async function setDeviceProxy(
  serial: string,
  proxy: { host: string; port: number; user?: string; pass?: string } | null,
): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  if (proxy) {
    const val = `${proxy.host}:${proxy.port}`;
    spawnSync(adb, ["-s", serial, "shell", "settings", "put", "global", "http_proxy", val], { encoding: "utf8", timeout: 5000 });
    spawnSync(adb, ["-s", serial, "shell", "settings", "put", "global", "https_proxy", val], { encoding: "utf8", timeout: 5000 });
    if (proxy.user && proxy.pass) {
      spawnSync(adb, ["-s", serial, "shell", "settings", "put", "global", "http_proxy_user", proxy.user], { encoding: "utf8", timeout: 5000 });
      spawnSync(adb, ["-s", serial, "shell", "settings", "put", "global", "http_proxy_pass", proxy.pass], { encoding: "utf8", timeout: 5000 });
    }
  } else {
    spawnSync(adb, ["-s", serial, "shell", "settings", "delete", "global", "http_proxy"], { encoding: "utf8", timeout: 5000 });
    spawnSync(adb, ["-s", serial, "shell", "settings", "delete", "global", "https_proxy"], { encoding: "utf8", timeout: 5000 });
  }
}

export async function stopEmulator(serial: string): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  spawnSync(adb, ["-s", serial, "emu", "kill"], { encoding: "utf8", timeout: 5000 });
  for (const [name, child] of runningEmulators) {
    if (child.pid && serial.includes(String(child.pid))) {
      try { child.kill(); } catch { /* ignore */ }
      runningEmulators.delete(name);
    }
  }
}

export async function waitForBoot(serial: string, timeoutMs = 120000): Promise<boolean> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = spawnSync(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], { encoding: "utf8", timeout: 3000 });
    if ((r.stdout || "").trim() === "1") return true;
    await new Promise(res => setTimeout(res, 2000));
  }
  return false;
}

export async function installApk(serial: string, apkPath: string): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  if (!fs.existsSync(apkPath)) throw new Error(`APK not found at ${apkPath}`);
  const r = spawnSync(adb, ["-s", serial, "install", "-r", "-g", apkPath], { encoding: "utf8", timeout: 180000 });
  if (r.status !== 0 || !/Success/i.test(r.stdout || "")) {
    throw new Error(`adb install failed: ${r.stderr || r.stdout || "unknown error"}`);
  }
}

export async function uninstallPackage(serial: string, pkg: string): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  spawnSync(adb, ["-s", serial, "uninstall", pkg], { encoding: "utf8", timeout: 30000 });
}

export async function isPackageInstalled(serial: string, pkg: string): Promise<boolean> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const r = spawnSync(adb, ["-s", serial, "shell", "pm", "list", "packages", pkg], { encoding: "utf8", timeout: 5000 });
  return (r.stdout || "").split(/\r?\n/).some(l => l.trim() === `package:${pkg}`);
}

export async function launchInstagram(serial: string): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  // Use am start instead of monkey — monkey can trigger ADB server restarts
  // which kill scrcpy connections. am start is a clean single-activity launch.
  spawnSync(adb, ["-s", serial, "shell", "am", "start", "-n",
    "com.instagram.android/com.instagram.mainactivity.LauncherActivity",
    "--activity-clear-top",
  ], { encoding: "utf8", timeout: 10000 });
}

export async function stopInstagram(serial: string): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  spawnSync(adb, ["-s", serial, "shell", "am", "force-stop", "com.instagram.android"], { encoding: "utf8", timeout: 5000 });
}

export async function clearInstagramData(serial: string): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  spawnSync(adb, ["-s", serial, "shell", "pm", "clear", "com.instagram.android"], { encoding: "utf8", timeout: 10000 });
}

function escapeForAdbInput(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/ /g, "%s")
    .replace(/&/g, "\\&")
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>");
}

export async function inputText(serial: string, text: string): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const escaped = escapeForAdbInput(text);
  spawnSync(adb, ["-s", serial, "shell", "input", "text", escaped], { encoding: "utf8", timeout: 5000 });
}

export async function tap(serial: string, x: number, y: number): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  spawnSync(adb, ["-s", serial, "shell", "input", "tap", String(x), String(y)], { encoding: "utf8", timeout: 5000 });
}

export async function keyevent(serial: string, code: string | number): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  spawnSync(adb, ["-s", serial, "shell", "input", "keyevent", String(code)], { encoding: "utf8", timeout: 5000 });
}

export function startScrcpy(serial: string, opts: { windowTitle?: string; maxSize?: number } = {}): { pid: number } {
  const tools = detectToolset();
  const scrcpy = requireTool(tools.scrcpy, "scrcpy");
  if (runningScrcpy.has(serial)) {
    return { pid: runningScrcpy.get(serial)!.pid ?? 0 };
  }
  const args = ["-s", serial, "--always-on-top"];
  if (opts.windowTitle) args.push("--window-title", opts.windowTitle);
  if (opts.maxSize) args.push("--max-size", String(opts.maxSize));
  const child = spawn(scrcpy, args, { detached: false, stdio: ["ignore", "pipe", "pipe"] });
  child.on("exit", () => runningScrcpy.delete(serial));
  runningScrcpy.set(serial, child);
  return { pid: child.pid ?? 0 };
}

export function stopScrcpy(serial: string): void {
  const child = runningScrcpy.get(serial);
  if (child) { try { child.kill(); } catch { /* ignore */ } runningScrcpy.delete(serial); }
}

export async function getInstagramSignupHint(serial: string): Promise<{ currentActivity: string | null }> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const r = spawnSync(adb, ["-s", serial, "shell", "dumpsys", "activity", "activities"], { encoding: "utf8", timeout: 5000 });
  const m = (r.stdout || "").match(/mResumedActivity:.*?\{[^}]*\s([^/]+\/[^\s}]+)/);
  return { currentActivity: m ? m[1] : null };
}

export type SignupRecipeStep =
  | { type: "wait"; ms: number; label?: string }
  | { type: "tap"; x: number; y: number; label?: string }
  | { type: "text"; value: string; label?: string }
  | { type: "key"; code: string | number; label?: string }
  | { type: "launchInstagram"; label?: string }
  | { type: "clearInstagramData"; label?: string };

export async function runSignupRecipe(serial: string, steps: SignupRecipeStep[], onProgress?: (i: number, total: number, step: SignupRecipeStep) => void): Promise<void> {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    onProgress?.(i, steps.length, s);
    switch (s.type) {
      case "wait": await new Promise(r => setTimeout(r, s.ms)); break;
      case "tap": await tap(serial, s.x, s.y); break;
      case "text": await inputText(serial, s.value); break;
      case "key": await keyevent(serial, s.code); break;
      case "launchInstagram": await launchInstagram(serial); break;
      case "clearInstagramData": await clearInstagramData(serial); break;
    }
  }
}

// ── Device property inspection ─────────────────────────────────────────────────

export type DeviceProps = {
  manufacturer: string;
  model: string;
  brand: string;
  androidVersion: string;
  sdkInt: string;
  density: string;
  width: string;
  height: string;
  board: string;
  deviceString: string;
  userAgent: string;
};

export async function getDeviceProps(serial: string): Promise<DeviceProps> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");

  function prop(key: string): string {
    const r = spawnSync(adb, ["-s", serial, "shell", "getprop", key], { encoding: "utf8", timeout: 4000 });
    return (r.stdout || "").trim().replace(/^\[|\]$/g, "") || "";
  }

  const manufacturer = prop("ro.product.manufacturer") || "Samsung";
  const model        = prop("ro.product.model") || "SM-G991B";
  const brand        = prop("ro.product.brand") || manufacturer;
  const androidVersion = prop("ro.build.version.release") || "11";
  const sdkInt       = prop("ro.build.version.sdk") || "30";
  const density      = prop("ro.sf.lcd_density") || prop("ro.screen.density") || "420";
  const board        = prop("ro.product.board") || prop("ro.board.platform") || "universal2100";

  const sizeR = spawnSync(adb, ["-s", serial, "shell", "wm", "size"], { encoding: "utf8", timeout: 4000 });
  const sizeMatch = (sizeR.stdout || "").match(/(\d+)x(\d+)/);
  const width  = sizeMatch ? sizeMatch[1] : "1080";
  const height = sizeMatch ? sizeMatch[2] : "2400";

  const deviceString = `${sdkInt}/${androidVersion}; ${density}dpi; ${width}x${height}; ${manufacturer}; ${model}; ${model}; ${board}; en_US; 746996204`;
  const userAgent    = `Instagram 427.0.0.47.73 Android (${deviceString})`;

  return { manufacturer, model, brand, androidVersion, sdkInt, density, width, height, board, deviceString, userAgent };
}

/** Reads the http_proxy global setting currently configured on the device. */
export async function getDeviceProxySetting(serial: string): Promise<string | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const r = spawnSync(adb, ["-s", serial, "shell", "settings", "get", "global", "http_proxy"], { encoding: "utf8", timeout: 4000 });
  const val = (r.stdout || "").trim();
  return val && val !== "null" ? val : null;
}

// ── Drony VPN proxy automation ─────────────────────────────────────────────────
// Drony (org.sandrob.drony) is a free Android VPN proxy app that routes ALL
// traffic — including HTTPS — through the configured proxy at the OS network
// level. No root required. Equinox automates its configuration via ADB
// UIAutomator (ui dump → parse element bounds → tap + type).

const DRONY_PKG = "org.sandrob.drony";
const DRONY_ACTIVITY = "org.sandrob.drony/.activity.MainActivity";

function _sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Dump current UI to XML and return its content. */
async function _uiDump(adb: string, serial: string): Promise<string> {
  const tmpDev = "/sdcard/equinox_ui_dump.xml";
  const tmpHost = path.join(os.tmpdir(), `equinox-ui-${serial.replace(/[^a-z0-9]/gi, "-")}.xml`);
  spawnSync(adb, ["-s", serial, "shell", "uiautomator", "dump", tmpDev], { encoding: "utf8", timeout: 10000 });
  spawnSync(adb, ["-s", serial, "pull", tmpDev, tmpHost], { encoding: "utf8", timeout: 6000 });
  try {
    const xml = fs.readFileSync(tmpHost, "utf8");
    try { fs.unlinkSync(tmpHost); } catch { /**/ }
    return xml;
  } catch { return ""; }
}

/** Parse "[x1,y1][x2,y2]" bounds → centre point. */
function _parseCenter(bounds: string): { x: number; y: number } | null {
  const m = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  return { x: Math.floor((+m[1] + +m[3]) / 2), y: Math.floor((+m[2] + +m[4]) / 2) };
}

/**
 * Find an element by any of the given strings in text/content-desc/hint attrs.
 * Returns the centre {x,y} of the first match, or null.
 */
function _findElem(xml: string, ...candidates: string[]): { x: number; y: number } | null {
  for (const t of candidates) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const attr of ["text", "content-desc", "hint"]) {
      // attr value exactly, or starts with the candidate (handles hint="Proxy host" matching "host")
      const re = new RegExp(`${attr}="${esc}"[^>]*bounds="([^"]+)"`, "i");
      const m = xml.match(re);
      if (m) { const c = _parseCenter(m[1]); if (c) return c; }
      // partial match (value contains candidate)
      const re2 = new RegExp(`${attr}="[^"]*${esc}[^"]*"[^>]*bounds="([^"]+)"`, "i");
      const m2 = xml.match(re2);
      if (m2) { const c2 = _parseCenter(m2[1]); if (c2) return c2; }
    }
  }
  return null;
}

function _adbTap(adb: string, serial: string, x: number, y: number): void {
  spawnSync(adb, ["-s", serial, "shell", "input", "tap", String(x), String(y)], { encoding: "utf8", timeout: 3000 });
}

function _adbType(adb: string, serial: string, text: string): void {
  const escaped = text
    .replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"')
    .replace(/ /g, "%s").replace(/&/g, "\\&").replace(/\$/g, "\\$")
    .replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  spawnSync(adb, ["-s", serial, "shell", "input", "text", escaped], { encoding: "utf8", timeout: 5000 });
}

function _clearField(adb: string, serial: string): void {
  // Select all then delete — works across Android versions
  spawnSync(adb, ["-s", serial, "shell", "input", "keyevent", "KEYCODE_MOVE_END"], { encoding: "utf8", timeout: 2000 });
  spawnSync(adb, ["-s", serial, "shell", "input", "keyevent", "--longpress", "KEYCODE_DEL"], { encoding: "utf8", timeout: 3000 });
  // Belt-and-suspenders: ctrl+A then delete
  spawnSync(adb, ["-s", serial, "shell", "input", "keycombination", "KEYCODE_CTRL_LEFT", "KEYCODE_A"], { encoding: "utf8", timeout: 2000 });
  spawnSync(adb, ["-s", serial, "shell", "input", "keyevent", "KEYCODE_DEL"], { encoding: "utf8", timeout: 2000 });
}

async function _tapField(adb: string, serial: string, pos: { x: number; y: number }, value: string): Promise<void> {
  _adbTap(adb, serial, pos.x, pos.y);
  await _sleep(350);
  _clearField(adb, serial);
  await _sleep(200);
  _adbType(adb, serial, value);
  await _sleep(200);
}

export async function isDronyInstalled(serial: string): Promise<boolean> {
  const tools = detectToolset();
  if (!tools.adb.found || !tools.adb.path) return false;
  const r = spawnSync(tools.adb.path, ["-s", serial, "shell", "pm", "list", "packages", DRONY_PKG], { encoding: "utf8", timeout: 5000 });
  return (r.stdout || "").includes(DRONY_PKG);
}

export async function isDronyVpnActive(serial: string): Promise<boolean> {
  const tools = detectToolset();
  if (!tools.adb.found || !tools.adb.path) return false;
  // tun0 existing means an Android VPN is up (Drony uses tun)
  const r = spawnSync(tools.adb.path, ["-s", serial, "shell", "ip", "link", "show", "tun0"], { encoding: "utf8", timeout: 5000 });
  const out = (r.stdout || "") + (r.stderr || "");
  return (r.status ?? 1) === 0 && !out.includes("does not exist") && !out.includes("not found");
}

/**
 * Fully automates Drony configuration via UIAutomator:
 * 1. Opens Drony
 * 2. Navigates to proxy entry form (adds or edits)
 * 3. Fills in host / port / credentials
 * 4. Saves and activates the VPN
 *
 * Returns { ok, steps } — steps is a human-readable log of what was done.
 */
export async function configureDrony(
  serial: string,
  config: { host: string; port: number; user?: string; pass?: string },
): Promise<{ ok: boolean; steps: string[]; error?: string }> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const steps: string[] = [];

  try {
    // 1. Launch Drony (app may display as "Droni" in some locales — package name is what matters)
    spawnSync(adb, ["-s", serial, "shell", "am", "start", "-n", DRONY_ACTIVITY], { encoding: "utf8", timeout: 6000 });
    await _sleep(3000); // Give BlueStacks time to fully switch to the app

    let xml = await _uiDump(adb, serial);
    // Retry once if the dump came back empty/tiny (screen was still loading)
    if (!xml || xml.length < 200) {
      await _sleep(2500);
      xml = await _uiDump(adb, serial);
    }
    // Check that Drony is in the foreground — display name varies ("Drony"/"Droni") but package always contains "drony"
    const dronyOpen = xml.includes(DRONY_PKG) || xml.toLowerCase().includes("drony") || xml.toLowerCase().includes("droni");
    if (!dronyOpen) {
      return { ok: false, steps, error: "Drony is not in the foreground. Make sure BlueStacks is running and Drony is installed. Try opening Drony manually first, then retry." };
    }
    steps.push("Drony opened");

    // 2. If there's a "+" FAB or "Add" button, tap it to create a new proxy entry
    const addPos = _findElem(xml, "+", "Add", "NEW PROXY", "New proxy", "Add proxy");
    if (addPos) {
      _adbTap(adb, serial, addPos.x, addPos.y);
      await _sleep(1200);
      xml = await _uiDump(adb, serial);
      steps.push("Opened new proxy form");
    } else {
      // Try editing the first existing entry (long-press or single tap)
      const entryPos = _findElem(xml, "Edit", "EDIT", "Proxy", "HTTP");
      if (entryPos) {
        _adbTap(adb, serial, entryPos.x, entryPos.y);
        await _sleep(1000);
        xml = await _uiDump(adb, serial);
        steps.push("Opened existing proxy to edit");
      }
    }

    // 3. Fill Host
    const hostPos = _findElem(xml, "Hostname or IP address", "Proxy host", "Host", "Server host", "hostname", "server");
    if (hostPos) {
      await _tapField(adb, serial, hostPos, config.host);
      steps.push(`Host → ${config.host}`);
    } else {
      steps.push("⚠ Host field not found — UI may differ");
    }

    // Re-dump after host entry (keyboard may have shifted layout)
    xml = await _uiDump(adb, serial);

    // 4. Fill Port
    const portPos = _findElem(xml, "Port", "Server port", "Proxy port", "port");
    if (portPos) {
      await _tapField(adb, serial, portPos, String(config.port));
      steps.push(`Port → ${config.port}`);
    } else {
      steps.push("⚠ Port field not found");
    }

    // Re-dump
    xml = await _uiDump(adb, serial);

    // 5. Auth (optional)
    if (config.user) {
      const userPos = _findElem(xml, "Username", "Login", "User name", "user");
      if (userPos) {
        await _tapField(adb, serial, userPos, config.user);
        steps.push(`Username → ${config.user}`);
      }
      xml = await _uiDump(adb, serial);
      const passPos = _findElem(xml, "Password", "password");
      if (passPos) {
        await _tapField(adb, serial, passPos, config.pass ?? "");
        steps.push("Password set");
      }
      xml = await _uiDump(adb, serial);
    }

    // 6. Save / OK
    const savePos = _findElem(xml, "OK", "Save", "SAVE", "Done", "DONE", "Apply", "APPLY", "✓");
    if (savePos) {
      _adbTap(adb, serial, savePos.x, savePos.y);
      await _sleep(1200);
      steps.push("Configuration saved");
    } else {
      // Try Android back to dismiss the form
      spawnSync(adb, ["-s", serial, "shell", "input", "keyevent", "KEYCODE_BACK"], { encoding: "utf8", timeout: 3000 });
      await _sleep(800);
      steps.push("Form closed (back key)");
    }

    // 7. Activate VPN toggle on the main screen
    xml = await _uiDump(adb, serial);
    // Drony shows a power-button style toggle or a text like "Tap to start" / "OFF" / "Stopped"
    const togglePos = _findElem(xml, "OFF", "Stopped", "Tap to start", "START", "Start", "Enable");
    if (togglePos) {
      _adbTap(adb, serial, togglePos.x, togglePos.y);
      await _sleep(1800);
      steps.push("VPN toggle activated");
    } else {
      // Some Drony versions use the large power button as an ImageView with no text.
      // Tap the approximate screen centre-top area where it usually appears.
      steps.push("⚠ Power toggle not found by text — tap the power button in Drony manually if VPN is not active");
    }

    // 8. Accept Android VPN permission dialog if it appeared
    await _sleep(800);
    xml = await _uiDump(adb, serial);
    const vpnOkPos = _findElem(xml, "OK", "Allow", "ACCEPT", "Yes");
    if (vpnOkPos && (xml.includes("VPN") || xml.includes("network") || xml.includes("connection"))) {
      _adbTap(adb, serial, vpnOkPos.x, vpnOkPos.y);
      await _sleep(1000);
      steps.push("VPN permission accepted");
    }

    return { ok: true, steps };
  } catch (e: any) {
    return { ok: false, steps, error: e?.message ?? "Automation failed" };
  }
}

/** Deactivate Drony: open it and tap the ON/active toggle. */
export async function deactivateDrony(serial: string): Promise<{ ok: boolean; steps: string[] }> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const steps: string[] = [];
  try {
    spawnSync(adb, ["-s", serial, "shell", "am", "start", "-n", DRONY_ACTIVITY], { encoding: "utf8", timeout: 6000 });
    await _sleep(1800);
    steps.push("Drony opened");
    const xml = await _uiDump(adb, serial);
    const offPos = _findElem(xml, "ON", "Running", "STOP", "Stop", "Disable", "Connected");
    if (offPos) {
      _adbTap(adb, serial, offPos.x, offPos.y);
      await _sleep(1000);
      steps.push("VPN deactivated");
    } else {
      steps.push("VPN toggle not found — may already be off");
    }
    return { ok: true, steps };
  } catch (e: any) {
    return { ok: false, steps, error: e?.message } as any;
  }
}
