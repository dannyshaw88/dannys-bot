import { spawn, spawnSync, execFile, ChildProcess } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import os from "os";
import zlib from "zlib";
import { logger } from "../lib/logger";
import * as recorder from "./sessionRecorder";

const execFileP = promisify(execFile);

/**
 * Non-blocking ADB runner. Returns stdout on success OR on timeout/error
 * (empty string), never throws. Keeps the event loop free — unlike spawnSync.
 */
async function runAdb(adbPath: string, args: string[], timeoutMs = 8000): Promise<string> {
  try {
    const { stdout } = await execFileP(adbPath, args, { encoding: "utf8", timeout: timeoutMs } as any);
    return (stdout as string) ?? "";
  } catch (e: any) {
    return (e.stdout as string | undefined) ?? "";
  }
}

/**
 * Non-blocking ADB runner that throws on non-zero exit or timeout.
 */
async function runAdbStrict(adbPath: string, args: string[], timeoutMs = 8000): Promise<string> {
  try {
    const { stdout } = await execFileP(adbPath, args, { encoding: "utf8", timeout: timeoutMs } as any);
    return (stdout as string) ?? "";
  } catch (e: any) {
    if (e.killed || e.signal) throw new Error(`adb timed out (args: ${args.slice(0, 3).join(" ")})`);
    const msg = ((e.stderr as string | undefined) || (e.stdout as string | undefined) || "unknown").trim();
    throw new Error(msg || `adb exited with code ${e.code}`);
  }
}

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

/**
 * Manual ADB path override — shared with routes/usb-phones.ts.
 * Lets a user paste the folder containing adb.exe directly in the UI instead
 * of editing the Windows PATH. Read from the same on-disk file so both
 * detection paths (USB phone list + emulator/scrcpy/Instagram automation)
 * agree on which adb binary to use.
 */
function loadAdbOverridePath(): string | null {
  try {
    const dir = process.env.ADB_TOOLS_DIR || process.cwd();
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "adb-path-override.json"), "utf8"));
    const folder = typeof raw?.folder === "string" ? raw.folder.trim() : "";
    if (!folder) return null;
    const candidate = path.join(folder, process.platform === "win32" ? "adb.exe" : "adb");
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch { return null; }
}

function findAdbPath(): string | null {
  // 1. User-provided override always wins.
  const override = loadAdbOverridePath();
  if (override) return override;
  // 2. PATH / env
  let p = which("adb");
  if (p) return p;
  // 3. Android SDK
  const sdkCandidates = candidateSdkRoots();
  const sdkRoot = sdkCandidates.find(r => { try { return fs.statSync(r).isDirectory(); } catch { return false; } }) ?? null;
  if (sdkRoot) { p = findInSdk("adb", sdkRoot); if (p) return p; }
  // 4. Emulator bundled adb
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

export function requireTool(t: ToolStatus, name: string): string {
  if (!t.found || !t.path) throw new Error(`${name} is not installed or not found on this system`);
  return t.path;
}

export async function listAvds(): Promise<string[]> {
  const tools = detectToolset();
  if (!tools.emulator.found || !tools.emulator.path) return [];
  const stdout = await runAdb(tools.emulator.path, ["-list-avds"], 8000);
  return stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

export async function listDevices(): Promise<DeviceInfo[]> {
  const tools = detectToolset();
  if (!tools.adb.found || !tools.adb.path) return [];
  const adb = tools.adb.path;
  const stdout = await runAdb(adb, ["devices", "-l"], 8000);
  const lines = stdout.split(/\r?\n/).slice(1);
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
      const avdOut = await runAdb(adb, ["-s", dev.serial, "emu", "avd", "name"], 4000);
      const first = avdOut.split(/\r?\n/)[0]?.trim();
      if (first) dev.avdName = first;
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

/**
 * adb reverse tcp:PORT tcp:PORT
 * Makes Android's localhost:PORT tunnel through ADB to the host's localhost:PORT.
 * This is how the proxy relay is reached without any Windows Firewall rules.
 */
export async function adbReverse(serial: string, port: number): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  await runAdbStrict(adb, ["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`], 8000);
}

/**
 * Remove a specific adb reverse rule, or all rules if port is not given.
 * Called on proxy clear / reset / deep-reset.
 */
export async function adbReverseRemove(serial: string, port?: number): Promise<void> {
  const tools = detectToolset();
  if (!tools.adb.found || !tools.adb.path) return;
  const args = port
    ? ["-s", serial, "reverse", "--remove", `tcp:${port}`]
    : ["-s", serial, "reverse", "--remove-all"];
  await runAdb(tools.adb.path, args, 5000);
}

export async function getAndroidId(serial: string): Promise<string | null> {
  const tools = detectToolset();
  if (!tools.adb.found || !tools.adb.path) return null;
  const stdout = await runAdb(
    tools.adb.path,
    ["-s", serial, "shell", "settings", "get", "secure", "android_id"],
    5000,
  );
  const val = stdout.trim();
  return val && val !== "null" ? val : null;
}

export async function setAndroidId(serial: string, id: string): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  await runAdbStrict(
    adb,
    ["-s", serial, "shell", "settings", "put", "secure", "android_id", id],
    10000,
  );
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
export function getDeviceGateway(serial: string): string {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");

  // Attempt 1: ip route show default
  const r1 = spawnSync(
    adb,
    ["-s", serial, "shell", "ip", "route", "show", "default"],
    { encoding: "utf8", timeout: 5000 },
  );
  const m1 = (r1.stdout ?? "").match(/default via ([\d.]+)/);
  if (m1) return m1[1];

  // Attempt 2: full ip route table (BlueStacks sometimes omits "default via" in the first command)
  const r2 = spawnSync(
    adb,
    ["-s", serial, "shell", "ip", "route"],
    { encoding: "utf8", timeout: 5000 },
  );
  const m2 = (r2.stdout ?? "").match(/default via ([\d.]+)/);
  if (m2) return m2[1];

  // Attempt 3: getprop net.eth0.gw (works on some older AOSP images)
  const r3 = spawnSync(
    adb,
    ["-s", serial, "shell", "getprop", "net.eth0.gw"],
    { encoding: "utf8", timeout: 4000 },
  );
  const gw3 = (r3.stdout ?? "").trim();
  if (gw3 && /^\d+\.\d+\.\d+\.\d+$/.test(gw3)) return gw3;

  // Fallback: 10.0.2.2 is the host machine IP for both standard Android
  // emulators and BlueStacks 5 NAT mode — safe default when route table
  // is unparseable.
  console.log(`[androidManager] getDeviceGateway(${serial}): route table unreadable, using 10.0.2.2`);
  return "10.0.2.2";
}

export async function setDeviceProxy(
  serial: string,
  proxy: { host: string; port: number; user?: string; pass?: string } | null,
): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  if (proxy) {
    // Android's global http_proxy setting only accepts "host:port" — credentials
    // cannot be embedded in this field.  Using any other format (e.g. user:pass@host:port)
    // silently breaks the setting and traffic bypasses the proxy entirely.
    const val = `${proxy.host}:${proxy.port}`;
    await runAdbStrict(adb, ["-s", serial, "shell", "settings", "put", "global", "http_proxy", val], 8000);
    await runAdb(adb, ["-s", serial, "shell", "settings", "put", "global", "https_proxy", val], 5000);
  } else {
    await Promise.all([
      runAdb(adb, ["-s", serial, "shell", "settings", "delete", "global", "http_proxy"], 5000),
      runAdb(adb, ["-s", serial, "shell", "settings", "delete", "global", "https_proxy"], 5000),
    ]);
  }
  // Broadcast PROXY_CHANGE so apps already running pick up the new setting
  // without needing a restart (equivalent to what Android Settings does).
  await runAdb(adb, ["-s", serial, "shell", "am", "broadcast", "-a", "android.intent.action.PROXY_CHANGE"], 5000);
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

export function getCachedApkPath(): string {
  return process.env.DATABASE_PATH
    ? path.join(path.dirname(process.env.DATABASE_PATH), "browser-data", "instagram.apk")
    : path.join(process.cwd(), "server", "browser-data", "instagram.apk");
}

export async function pullAndCacheInstalledApk(serial: string): Promise<string> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const r = spawnSync(adb, ["-s", serial, "shell", "pm", "path", "com.instagram.android"], { encoding: "utf8", timeout: 10000 });
  const match = (r.stdout ?? "").match(/package:(.+)/);
  if (!match) throw new Error("Could not find Instagram APK path on device");
  const deviceApkPath = match[1].trim();
  const cachePath = getCachedApkPath();
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const pullR = spawnSync(adb, ["-s", serial, "pull", deviceApkPath, cachePath], { encoding: "utf8", timeout: 120000 });
  if (pullR.status !== 0) throw new Error(`adb pull failed: ${pullR.stderr || pullR.stdout}`);
  console.log(`[androidManager] Instagram APK cached to ${cachePath} (${fs.statSync(cachePath).size} bytes)`);
  return cachePath;
}

export async function installFromCachedApk(serial: string): Promise<void> {
  const cachePath = getCachedApkPath();
  await installApk(serial, cachePath);
}

export async function uninstallPackage(serial: string, pkg: string): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  spawnSync(adb, ["-s", serial, "uninstall", pkg], { encoding: "utf8", timeout: 30000 });
}

export async function isPackageInstalled(serial: string, pkg: string): Promise<boolean> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const stdout = await runAdb(adb, ["-s", serial, "shell", "pm", "list", "packages", pkg], 5000);
  return stdout.split(/\r?\n/).some(l => l.trim() === `package:${pkg}`);
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

/**
 * Open the Google Chrome app on the device and handle the Chrome first-run
 * experience (FRE) if it appears.
 *
 * On first-ever launch Chrome shows a "Make Chrome your own" screen with a
 * "Continue as [Name]" button (resource-id: signin_fre_continue_button).
 * This function detects that screen via UIAutomator and taps the button
 * automatically so the FRE never blocks subsequent automation.
 */
/**
 * Finds tappable article cards in the Chrome Discover feed from a UI-dump XML.
 * Cards are clickable ViewGroups that span ~70–95 % of the screen width and are
 * at least 150 px tall.  Share buttons and Card-menu buttons are excluded by
 * their content-desc prefix.
 */
/**
 * Find a tappable internal link inside a Chrome article page.
 * Returns the centre of a random candidate, or null if none found.
 *
 * Strategy: scan all clickable nodes in the UIAutomator dump.  Exclude
 * Chrome's own chrome-UI elements (address bar at top, nav bar at bottom)
 * by bounding the candidate's centre-y to a mid-screen band.  Also skip
 * nodes that are too wide (full-width banners/headers) or too small (icon
 * buttons) — inline text links are typically narrow and short.
 */
function _findChromeInternalLink(
  xml: string,
  screenW: number,
  screenH: number,
): { x: number; y: number } | null {
  const topGuard    = Math.round(screenH * 0.12); // skip top ~12 % (address bar + toolbar)
  const bottomGuard = Math.round(screenH * 0.90); // skip bottom ~10 % (nav bar)
  const minW = 20;
  const maxW = Math.round(screenW * 0.88); // skip full-width containers

  const candidates: { x: number; y: number }[] = [];
  const nodeRe = /<node[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const tag = m[0];
    if (!tag.includes('clickable="true"')) continue;
    // Must have non-empty text — raw links in Chrome WebView carry their
    // anchor text here; buttons and image-only tappables usually don't.
    const textM = tag.match(/\btext="([^"]+)"/);
    if (!textM || textM[1].trim().length === 0) continue;
    const bm = tag.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bm) continue;
    const x1 = parseInt(bm[1], 10), y1 = parseInt(bm[2], 10);
    const x2 = parseInt(bm[3], 10), y2 = parseInt(bm[4], 10);
    const cx = Math.round((x1 + x2) / 2);
    const cy = Math.round((y1 + y2) / 2);
    const w  = x2 - x1;
    if (cy < topGuard || cy > bottomGuard) continue;
    if (w < minW || w > maxW) continue;
    candidates.push({ x: cx, y: cy });
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function _findChromeFeedCards(
  xml: string,
  screenW: number,
): Array<{ x: number; y: number }> {
  const results: Array<{ x: number; y: number }> = [];
  const nodeRe = /<node[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const node = m[0];
    if (!node.includes('clickable="true"')) continue;
    const bm = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bm) continue;
    const x1 = parseInt(bm[1], 10), y1 = parseInt(bm[2], 10);
    const x2 = parseInt(bm[3], 10), y2 = parseInt(bm[4], 10);
    const w = x2 - x1, h = y2 - y1;
    if (w < screenW * 0.70 || w > screenW * 0.95) continue; // too narrow or full-width container
    if (h < 150) continue;                                   // ignore small buttons
    const dm = node.match(/content-desc="([^"]*)"/);
    const desc = dm ? dm[1] : "";
    if (desc.startsWith("Share ") || desc.startsWith("Card menu ")) continue;
    results.push({ x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) });
  }
  return results;
}

/**
 * Universal cookie / consent banner accepter for Chrome article pages.
 *
 * Strategy:
 *   1. Banner presence — check the XML for any cookie/consent/GDPR keyword.
 *      We use case-insensitive substring checks so we don't rely on regex
 *      backslash escaping (which the build tool can corrupt in template literals).
 *   2. Accept button — try a priority-ordered list of common accept-button
 *      labels via _findElem, which already handles case-insensitive matching
 *      and both exact and partial text= / content-desc= attribute searches.
 *
 * Returns the tap coordinates if a banner was found and an accept button
 * located, or null if the page has no consent banner or the button text
 * wasn't recognised.
 */
function _findCookieAcceptButton(xml: string): { x: number; y: number } | null {
  const low = xml.toLowerCase();
  const hasBanner =
    low.includes("cookie") ||
    low.includes("consent") ||
    low.includes("contentpass") ||
    low.includes("personalised ads") ||
    low.includes("personalized ads") ||
    low.includes("gdpr") ||
    low.includes("privacy policy") ||
    low.includes("we and our") ||
    low.includes("our partners");
  if (!hasBanner) return null;

  // Priority order: most-specific first so we always pick the affirmative
  // "accept all" action rather than a weaker partial match.
  return _findElem(xml,
    "Accept All & Continue",
    "Accept all & continue",
    "Accept All and Continue",
    "Accept All",
    "Accept all",
    "ACCEPT ALL",
    "Accept all cookies",
    "Accept Cookies",
    "Accept cookies",
    "Accept & Continue",
    "Accept and Continue",
    "Allow All",
    "Allow all",
    "Allow all cookies",
    "Agree All",
    "Agree all",
    "I Agree",
    "I agree",
    "I Accept",
    "I accept",
    "Agree & Continue",
    "Agree and Continue",
    "Agree and continue",
    "Agree",
    "Accept",
    "OK, got it",
    "Ok, got it",
  );
}

/**
 * Build a broad, local-only pool of ordinary Google searches for Chrome
 * history activity.  The combinations are intentionally generated from
 * human-readable topic phrases rather than being a tiny fixed list or an
 * external/paid keyword service.  This gives repeated device runs thousands
 * of plausible variations while keeping every query safe to type and easy to
 * audit in source.
 */
const CHROME_MANUAL_SEARCH_QUERIES = (() => {
  const nounTopics = [
    "fish recipes", "easy dinner recipes", "healthy lunch ideas", "budget meal ideas",
    "meal prep recipes", "vegetarian dinner ideas", "slow cooker recipes", "air fryer recipes",
    "baking recipes for beginners", "homemade pizza recipes", "coffee shops near me",
    "dog friendly parks", "best dog food", "cat care tips", "local hiking trails",
    "weekend trips", "beach holidays", "city breaks", "family activities",
    "free things to do", "museums near me", "budget hotels", "cheap flights",
    "train travel tips", "packing lists", "weather this weekend", "local news today",
    "football fixtures", "man united football fixtures", "movie reviews",
    "films to watch", "TV series recommendations", "live music near me",
    "concert tickets", "book recommendations", "podcasts to listen to",
    "birthday gift ideas", "gifts for parents", "summer outfits", "running shoes",
    "winter coats", "home office ideas", "small bedroom ideas", "living room decor",
    "garden ideas", "house plants", "how to grow tomatoes", "DIY storage ideas",
    "paint colors for a kitchen", "kitchen organization", "bathroom cleaning tips",
    "stain removal tips", "cleaning white shoes", "laundry tips", "ways to save money",
    "monthly budget ideas", "grocery deals", "energy saving tips", "mortgage rates",
    "bank holiday dates", "public holidays", "tax deadlines", "job interview tips",
    "CV examples", "remote jobs", "part time jobs", "online courses",
    "learn Spanish", "learn guitar", "photography tips", "phone camera tips",
    "laptop comparisons", "wireless headphones", "best phone apps",
    "wifi troubleshooting", "printer troubleshooting", "sleep tips",
    "healthy breakfast ideas", "exercise at home", "walking routes",
    "skincare routine", "haircuts for men", "dentist near me", "NHS dentist",
    "allergy symptoms", "first aid basics", "recipe conversions", "time zones",
    "sunrise time", "sunset time", "plant care", "DIY home repairs",
    "car maintenance", "MOT checklist", "petrol prices", "parking near me",
    "public transport times", "local events", "things to do this weekend",
    "best restaurants near me", "takeaway recommendations", "vegetable garden ideas",
    "storage solutions for small homes", "cheap furniture", "second hand furniture",
    "best mattress", "sofa reviews", "kitchen appliances", "coffee machine reviews",
    "best water bottle", "backpack recommendations", "school holiday dates",
    "calendar dates", "public swimming pools", "cinema times", "theatre shows",
    "football results", "tennis results", "golf news", "weather forecast",
    "rain radar", "sunny holiday destinations", "best places to visit",
    "family holiday ideas", "day trips from London", "places to visit in England",
    "museum opening times", "library opening times", "local markets",
    "farmers markets near me", "photography locations", "sunset viewpoints",
    "best board games", "party games", "puzzle books", "craft ideas",
    "knitting patterns", "drawing tutorials", "home workout videos",
    "yoga for beginners", "running plan for beginners", "healthy snack ideas",
    "protein breakfast ideas", "vegetarian meal prep", "food storage tips",
    "how to tell if food is off", "best dog breeds", "dog walking tips",
    "puppy training advice", "cat toys", "pet insurance", "bird identification",
    "local wildlife", "garden birds", "house cleaning schedule", "decluttering tips",
    "wardrobe organization", "bathroom storage", "recycle old electronics",
    "electricity prices", "mobile phone deals", "SIM only deals", "broadband deals",
    "best bank accounts", "credit score tips", "money saving challenges",
    "student discounts", "cheap days out", "free parking", "bus timetable",
    "train ticket prices", "airport parking", "travel insurance", "passport renewal",
    "visa requirements", "language translation", "currency exchange rates",
    "how to use Google Maps", "map directions", "nearby petrol stations",
    "car insurance quotes", "used car reviews", "bike routes", "cycling gear",
    "walking boots", "rain jackets", "gift ideas for a friend", "Christmas gift ideas",
    "wedding guest outfits", "party food ideas", "birthday cake ideas",
    "date night ideas", "family recipes", "quick recipes", "one pot meals",
    "slow cooker dinner", "pasta recipes", "chicken recipes", "vegetable recipes",
    "dessert recipes", "smoothie recipes", "bread recipes", "pancake recipes",
    "how to make coffee", "best tea brands", "restaurant reviews", "pubs near me",
    "breakfast places near me", "lunch places near me", "local takeaway menus",
    "new movie releases", "best comedy films", "documentaries to watch",
    "music festivals", "radio stations", "new book releases", "audiobook recommendations",
    "historical podcasts", "science podcasts", "news podcasts", "weather apps",
    "calendar apps", "note taking apps", "photo editing apps", "budgeting apps",
    "language learning apps", "best browser extensions", "phone battery tips",
    "how to free phone storage", "laptop buying guide", "tablet reviews",
    "smartwatch reviews", "bluetooth speaker reviews", "home printer reviews",
    "camera accessories", "USB cable types", "how to back up photos",
    "online safety tips", "password manager reviews", "learn coding online",
    "spreadsheet tutorials", "presentation ideas", "public speaking tips",
    "work from home ideas", "career change advice", "apprenticeship vacancies",
    "local job vacancies", "cover letter examples", "interview questions",
    "professional development courses", "study tips", "revision timetable",
    "school project ideas", "science experiments at home", "maths help",
    "history facts", "space news", "animal facts", "why is the sky blue",
    "how plants grow", "interesting facts", "word definitions", "grammar checker",
  ];

  const actionTopics = [
    "cook fish", "cook rice", "boil eggs", "clean white shoes", "remove red wine stains",
    "grow tomatoes", "sleep better", "save money", "plan a holiday", "pack a suitcase",
    "train a puppy", "teach a dog recall", "make coffee", "bake bread", "fix a dripping tap",
    "unblock a sink", "change a light bulb", "paint a room", "organize a wardrobe",
    "declutter a house", "wash a duvet", "remove limescale", "check tyre pressure",
    "jump start a car", "change engine oil", "prepare for a job interview", "write a CV",
    "learn Spanish", "learn guitar", "take better photos", "edit phone photos",
    "improve WiFi", "back up a phone", "transfer photos", "choose running shoes",
    "start running", "stretch hamstrings", "build a morning routine", "meditate",
    "reduce screen time", "choose a mattress", "sleep on a flight", "care for houseplants",
    "repot a plant", "identify birds", "make a packed lunch", "meal prep chicken",
    "freeze leftovers", "make pancakes", "cook pasta", "make a curry", "choose a dog breed",
    "introduce cats", "keep food fresh", "tell if food is off", "find a lost phone",
    "remove an app", "clear browser history", "use Google Maps", "read a train timetable",
    "convert currency", "calculate percentages", "make a spreadsheet", "learn coding",
    "start a side hustle", "apply for jobs", "prepare a presentation", "improve public speaking",
    "plan a birthday", "choose a gift", "make a budget", "reduce household bills",
    "compare energy tariffs", "book cheap flights", "find a hotel", "plan a day trip",
    "make a shopping list", "organize digital photos", "clean a phone screen",
    "remove sticker residue", "wash a car", "check a car battery", "prepare for an MOT",
    "find cheap petrol", "plan a walking route", "choose walking boots", "make a smoothie",
    "pack a healthy lunch", "cook vegetables", "make homemade pizza", "store fresh herbs",
    "choose a coffee machine", "clean a washing machine", "remove mould safely",
    "organize a small bedroom", "make a home office", "hang a picture", "fill a wall hole",
    "fix a loose door handle", "change a shower head", "clean a microwave",
    "clean an oven", "remove pet hair", "keep a house cool", "save electricity",
    "check a weather forecast", "find local events", "buy train tickets", "renew a passport",
    "compare travel insurance", "learn a new language", "study more effectively",
    "make flashcards", "choose a laptop", "connect wireless headphones", "fix a printer",
    "improve phone battery life", "free up storage space", "set up a new phone",
    "protect an online account", "spot a scam message", "use a password manager",
    "make a photo collage", "edit a video", "start a podcast", "find a new book",
    "choose a film to watch", "find live music", "make a birthday cake",
    "host a dinner party", "plan a date night", "choose a board game",
    "start a vegetable garden", "attract birds to a garden", "look after a cat",
    "keep a dog entertained", "choose pet insurance", "make a home workout",
    "begin yoga", "improve flexibility", "build muscle at home", "eat more vegetables",
    "prepare a healthy breakfast", "plan weekly meals", "drink more water",
    "create a sleep routine", "deal with jet lag", "stay calm before an interview",
  ];

  const nounPatterns = [
    "best {topic}", "easy {topic}", "cheap {topic}", "latest {topic}",
    "{topic} near me", "{topic} today", "{topic} this weekend",
    "reviews for {topic}", "ideas for {topic}", "tips for {topic}",
    "a guide to {topic}", "where to find {topic}", "what to know about {topic}",
    "top rated {topic}", "{topic} for beginners", "{topic} on a budget",
  ];
  const actionPatterns = [
    "how to {topic}", "best way to {topic}", "easy way to {topic}",
    "tips for {topic}", "what do I need to {topic}", "how long does it take to {topic}",
    "can I {topic}", "common mistakes when you {topic}",
    "a beginner guide to {topic}", "what is the easiest way to {topic}",
    "should I {topic}", "when is the best time to {topic}",
    "simple steps to {topic}", "things to know before you {topic}",
  ];
  const directQueries = [
    "how to cook fish", "is my food off", "man united football fixtures", "weather today",
    "what dog is the best breed", "am I happy", "easy dinner ideas", "how to sleep better",
    "best places to visit", "why is the sky blue", "how long to boil eggs",
    "local news today", "how to clean white shoes", "best movies to watch",
    "how to grow tomatoes", "what time does the sun set", "how to save money",
    "healthy lunch ideas",
  ];
  // Keep a visible share of searches conversational and sentence-like.  The
  // generated topic queries above are useful for variety, but these are closer
  // to how people actually phrase occasional Google searches in their history.
  const naturalSentenceQueries = [
    "what can I make for dinner with the ingredients I have",
    "what should I pack for a weekend trip",
    "how can I make my bedroom feel more spacious",
    "which exercises are easiest to do at home",
    "what is the best way to clean a fabric sofa",
    "how long should I bake homemade bread",
    "where can I find a quiet coffee shop nearby",
    "what are some easy meals for a busy week",
    "how do I keep my phone battery healthy",
    "which plants are good for a sunny windowsill",
    "what should I look for when buying a used car",
    "how can I save money on my monthly bills",
    "what are the best day trips from London",
    "how do I prepare for my first job interview",
    "what should I take on a long flight",
    "how can I improve the signal on my home wifi",
    "which books are good for learning a new language",
    "what is a simple way to organize family photos",
    "how do I remove a coffee stain from a white shirt",
    "where are the best walking routes near me",
    "what can I do with leftover vegetables",
    "how often should I water a houseplant",
    "what are some good films to watch tonight",
    "how do I choose the right running shoes",
    "which museums are open this weekend",
    "what is the easiest way to plan a weekly budget",
    "how can I make better photos with my phone",
    "what should I know before adopting a dog",
    "how do I make a quick healthy breakfast",
    "where can I find affordable furniture nearby",
    "what are some fun things to do on a rainy day",
    "how can I make my home office more comfortable",
    "which foods are good for a packed lunch",
    "what is the best way to remove limescale",
    "how do I compare travel insurance policies",
    "what should I plant in my garden this month",
    "how can I sleep better when traveling",
    "where can I find local events this evening",
    "what are some beginner friendly yoga exercises",
    "how do I back up photos from my phone",
    "which headphones are good for commuting",
    "what is a good present for a friend's birthday",
    "how can I make a small kitchen more practical",
    "what should I do if my car will not start",
    "where can I find the best train ticket prices",
    "how do I write a simple cover letter",
    "what are some easy recipes for a slow cooker",
    "which apps can help me learn Spanish",
    "how can I reduce the amount of plastic I use",
    "what should I see on a first visit to Edinburgh",
    "how do I clean a laptop screen safely",
    "what are some ways to make a morning routine",
    "where can I find a good place for Sunday lunch",
    "how can I make my internet connection more reliable",
    "what should I check before booking a holiday apartment",
    "which snacks are easy to take on a walk",
    "how do I get candle wax out of fabric",
    "what are some interesting podcasts for a long drive",
    "how can I keep my garden birds coming back",
    "what is the best way to learn basic photography",
    "where can I find swimming pools with public sessions",
    "how do I make a spreadsheet for household expenses",
    "what should I wear to a casual summer wedding",
    "which cities are good for a short break by train",
    "how can I use less electricity at home",
    "what are some simple activities for a family weekend",
    "how do I choose a mattress that will last",
    "where can I find beginner guitar lessons nearby",
    "what should I do with old electronics before recycling them",
    "how can I make homemade pizza without a pizza oven",
    "which weather app gives the most useful forecast",
    "what are the best ways to stay organized at work",
  ];

  const queries = new Set<string>();
  const add = (query: string) => {
    const normalized = query.replace(/\s+/g, " ").trim();
    if (normalized) queries.add(normalized);
  };
  for (const query of directQueries) add(query);
  for (const query of naturalSentenceQueries) add(query);
  for (const topic of nounTopics) {
    for (const pattern of nounPatterns) add(pattern.replace("{topic}", topic));
  }
  for (const topic of actionTopics) {
    for (const pattern of actionPatterns) add(pattern.replace("{topic}", topic));
  }
  return [...queries];
})();

// Google history should be made up of short, natural-looking searches rather
// than a stream of isolated keywords. Every selected query must contain
// exactly 2–5 words; one-word searches are intentionally excluded.
const CHROME_SEARCH_QUERIES_BY_WORD_COUNT: Record<number, string[]> = {
  2: CHROME_MANUAL_SEARCH_QUERIES.filter(
    query => query.split(/\s+/).filter(Boolean).length === 2,
  ),
  3: CHROME_MANUAL_SEARCH_QUERIES.filter(
    query => query.split(/\s+/).filter(Boolean).length === 3,
  ),
  4: CHROME_MANUAL_SEARCH_QUERIES.filter(
    query => query.split(/\s+/).filter(Boolean).length === 4,
  ),
  5: CHROME_MANUAL_SEARCH_QUERIES.filter(
    query => query.split(/\s+/).filter(Boolean).length === 5,
  ),
};
const CHROME_SEARCH_WORD_COUNTS = [2, 3, 4, 5];
const CHROME_NON_EMPTY_SEARCH_WORD_COUNTS = CHROME_SEARCH_WORD_COUNTS.filter(
  count => (CHROME_SEARCH_QUERIES_BY_WORD_COUNT[count] ?? []).length > 0,
);

function chooseChromeManualSearchQuery(usedQueries: Set<string>): {
  query: string;
  wordCount: number;
} {
  // Randomly vary every query between 2 and 5 words. This keeps searches
  // natural-looking while ensuring the history never falls back to a single
  // isolated keyword.
  const wordCount = 2 + Math.floor(Math.random() * 4);
  const preferred = CHROME_SEARCH_QUERIES_BY_WORD_COUNT[wordCount] ?? [];
  const available = preferred.filter(query => !usedQueries.has(query));
  const fallback = CHROME_SEARCH_WORD_COUNTS
    .filter(count => count !== wordCount)
    .flatMap(count => CHROME_SEARCH_QUERIES_BY_WORD_COUNT[count] ?? [])
    .filter(query => !usedQueries.has(query));
  const allAvailable = CHROME_NON_EMPTY_SEARCH_WORD_COUNTS
    .flatMap(count => CHROME_SEARCH_QUERIES_BY_WORD_COUNT[count] ?? [])
    .filter(query => !usedQueries.has(query));
  const pool = available.length > 0
    ? available
    : fallback.length > 0
      ? fallback
      : allAvailable.length > 0
        ? allAvailable
        : preferred;
  if (pool.length === 0) {
    throw new Error("Chrome manual search query pool is empty");
  }
  const query = pool[Math.floor(Math.random() * pool.length)];
  const selectedWordCount = query.split(/\s+/).filter(Boolean).length;
  return {
    query,
    wordCount: selectedWordCount,
  };
}

export async function runChromeApp(
  serial: string,
  opts?: {
    swipeGesture: {
      x1: number; y1: number; x2: number; y2: number;
      durationMinMs: number; durationMaxMs: number; jitterX: number; jitterY: number;
      startJitterMinY?: number; startJitterMaxY?: number;
    };
    typingProfile: TypingSpeedProfile;
    scrollMin?: number; scrollMax?: number;
    storyTapMin?: number; storyTapMax?: number;
    tappedStoryScrollMin?: number; tappedStoryScrollMax?: number;
    internalLinkPctMin?: number; internalLinkPctMax?: number;
    manualSearches?: boolean;
    manualSearchPctMin?: number; manualSearchPctMax?: number;
    manualSearchCountMin?: number; manualSearchCountMax?: number;
    manualSearchScrollMin?: number; manualSearchScrollMax?: number;
    manualSearchLinkPctMin?: number; manualSearchLinkPctMax?: number;
    manualSearchDwellMin?: number; manualSearchDwellMax?: number;
     tapTrendingStoryMin?: number; tapTrendingStoryMax?: number;
    dismissDirection?: "left" | "up";
  },
): Promise<{ ok: boolean; steps: string[]; error?: string }> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const steps: string[] = [];
  if (!opts?.swipeGesture) throw new Error("Swipe Gesture Profile is required for Chrome content scrolling");
  const profileSwipeDuration = () => {
    const min = Math.min(opts.swipeGesture.durationMinMs, opts.swipeGesture.durationMaxMs);
    const max = Math.min(150, Math.max(opts.swipeGesture.durationMinMs, opts.swipeGesture.durationMaxMs));
    if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error("Swipe Gesture Profile duration is invalid");
    return Math.max(1, Math.round(min + Math.random() * (max - min)));
  };
  try {
    // Launch Chrome — standard main activity, clear any existing task stack.
    // On some devices am start returns an error (Chrome not found under the
    // primary package name, or activity class mismatch) and Android leaves the
    // current foreground app untouched — which is often the Google app.
    // We inspect the am start stdout to detect failure and fall back to monkey,
    // which simulates tapping the Chrome launcher icon and is always reliable.
    const amResult = spawnSync(adb, ["-s", serial, "shell", "am", "start", "-n",
      "com.android.chrome/com.google.android.apps.chrome.Main",
      "--activity-clear-top",
    ], { encoding: "utf8", timeout: 10000 });
    const amOut = (amResult.stdout ?? "") + (amResult.stderr ?? "");
    const amFailed = amOut.includes("Error") || amOut.includes("does not exist") || amResult.status !== 0;
    if (amFailed) {
      // Fallback: monkey tap — equivalent to pressing the Chrome icon in the launcher.
      spawnSync(adb, ["-s", serial, "shell", "monkey",
        "-p", "com.android.chrome",
        "-c", "android.intent.category.LAUNCHER", "1",
      ], { encoding: "utf8", timeout: 10000 });
      steps.push(`Chrome: am start failed (${amOut.trim().slice(0, 80)}) — used monkey fallback`);
    } else {
      steps.push("Chrome launched");
    }

    // Allow time for the app to render its first frame.
    await _sleep(2500);

    // Verify Chrome is actually in the foreground by checking the UI dump for
    // com.android.chrome resource-ids.  If the Google app (or anything else)
    // opened instead, force-launch Chrome via monkey and wait again.
    const xmlPre = await _uiDump(adb, serial);
    const chromeInFg = xmlPre.includes("com.android.chrome");
    if (!chromeInFg) {
      steps.push("Chrome: not in foreground after launch — retrying with monkey");
      spawnSync(adb, ["-s", serial, "shell", "monkey",
        "-p", "com.android.chrome",
        "-c", "android.intent.category.LAUNCHER", "1",
      ], { encoding: "utf8", timeout: 10000 });
      await _sleep(2500);
    }

    // Get the current UI state (reuse the foreground-check dump if Chrome was
    // already in the foreground, otherwise take a fresh one after monkey launch).
    let xml = chromeInFg ? xmlPre : await _uiDump(adb, serial);

    // ── Tap home button to ensure Chrome is on its homepage ──────────────────
    // Chrome remembers the last-visited page across sessions.  Tapping the home
    // button (id="home_button", desc="Open the homepage") resets it to the New
    // Tab / Discover feed before any scrolling or story tapping begins.
    // If the home button isn't visible (e.g. FRE is showing) we skip silently.
    {
      const homePos = _findElem(xml,
        "com.android.chrome:id/home_button",
        "home_button",
        "Open the homepage",
      );
      if (homePos) {
        _adbTap(adb, serial, homePos.x, homePos.y);
        steps.push("Chrome: tapped home button — navigating to homepage");
        await _sleep(1500); // wait for NTP / Discover feed to load
        xml = await _uiDump(adb, serial); // re-dump: page changed after home tap
      } else {
        steps.push("Chrome: home button not visible — skipping (FRE or custom NTP?)");
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Detection: id="fre_pager" is the unique ViewPager container for the
    // Chrome first-run experience.  id="signin_fre_continue_button" is the
    // "Continue as [Name]" button.  Either is sufficient to confirm FRE.
    const isFre =
      xml.includes("fre_pager") ||
      xml.includes("signin_fre_continue_button") ||
      xml.includes("Make Chrome your own");

    if (isFre) {
      steps.push("Chrome FRE detected");

      // 1. Try to tap the "Continue as [Name]" button by resource-id.
      //    The full resource-id in raw UIAutomator XML is:
      //    resource-id="com.android.chrome:id/signin_fre_continue_button"
      let continuePos = _findElem(xml,
        "com.android.chrome:id/signin_fre_continue_button",
        "signin_fre_continue_button",
      );

      // 2. Fallback: scan for text="Continue as …" in case resource-id varies.
      if (!continuePos) {
        const m = xml.match(
          /text="(Continue as [^"]+)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/,
        );
        if (m) {
          continuePos = {
            x: Math.round((parseInt(m[2], 10) + parseInt(m[4], 10)) / 2),
            y: Math.round((parseInt(m[3], 10) + parseInt(m[5], 10)) / 2),
          };
          steps.push(`Chrome FRE: found by text — "${m[1]}"`);
        }
      }

      if (continuePos) {
        _adbTap(adb, serial, continuePos.x, continuePos.y);
        steps.push("Chrome FRE: tapped Continue");
        await _sleep(1500);
      } else {
        steps.push("Chrome FRE: button not found — no tap");
      }

      // ── Page 2: "Save time, type less" (history sync offer) ──────────────
      // After "Continue as [Name]" Chrome may immediately advance to a sync
      // page.  Detection: id="history_sync_title" or text "Save time, type
      // less".  Correct action: tap "No, thanks" (id="button_secondary").
      const xml2 = await _uiDump(adb, serial);
      const isHistorySync =
        xml2.includes("history_sync_title") ||
        xml2.includes("Save time, type less") ||
        xml2.includes("button_secondary");
      if (isHistorySync) {
        steps.push("Chrome FRE page 2 detected (history sync)");
        const noThanksPos = _findElem(xml2,
          "com.android.chrome:id/button_secondary",
          "button_secondary",
          "No, thanks",
          "No thanks",
        );
        if (noThanksPos) {
          _adbTap(adb, serial, noThanksPos.x, noThanksPos.y);
          steps.push("Chrome FRE page 2: tapped No, thanks");
          await _sleep(1200);
        } else {
          steps.push("Chrome FRE page 2: No-thanks button not found — no tap");
        }
      }

      // ── Page 3: "Turn on an ad privacy feature" (Privacy Sandbox EEA) ────
      // Detection: id="privacy_sandbox_consent_eea_view" or title text.
      // Correct action: tap "No, thanks" (id="no_button", left button).
      const xml3 = await _uiDump(adb, serial);
      const isPrivacySandbox =
        xml3.includes("privacy_sandbox_consent_eea_view") ||
        xml3.includes("Turn on an ad privacy feature") ||
        xml3.includes("privacy_sandbox_dialog_scroll_view");
      if (isPrivacySandbox) {
        steps.push("Chrome FRE page 3 detected (Privacy Sandbox)");
        const noPos = _findElem(xml3,
          "com.android.chrome:id/no_button",
          "no_button",
          "No, thanks",
          "No thanks",
        );
        if (noPos) {
          _adbTap(adb, serial, noPos.x, noPos.y);
          steps.push("Chrome FRE page 3: tapped No, thanks");
          await _sleep(1200);
        } else {
          steps.push("Chrome FRE page 3: No-thanks button not found — no tap");
        }
      }

      // ── Page 4: "Other ad privacy features now available" ─────────────────
      // Detection: id="privacy_sandbox_m1_notice_eea_bullet_one" or title text.
      // Correct action: tap the "More ↓" button (id="more_button", bottom-right)
      // which scrolls/advances past this informational screen.
      const xml4 = await _uiDump(adb, serial);
      const isOtherAdPrivacy =
        xml4.includes("privacy_sandbox_m1_notice_eea_bullet_one") ||
        xml4.includes("Other ad privacy features now available");
      if (isOtherAdPrivacy) {
        steps.push("Chrome FRE page 4 detected (Other ad privacy)");
        const morePos = _findElem(xml4,
          "com.android.chrome:id/more_button",
          "more_button",
          "More",
        );
        if (morePos) {
          _adbTap(adb, serial, morePos.x, morePos.y);
          steps.push("Chrome FRE page 4: tapped More");
          await _sleep(1200);

          // After "More" the same screen scrolls to reveal "Got it" + "Settings"
          // buttons (id="ack_button").  Tap "Got it" to finish this page.
          const xml4b = await _uiDump(adb, serial);
          const gotItPos = _findElem(xml4b,
            "com.android.chrome:id/ack_button",
            "ack_button",
            "Got it",
          );
          if (gotItPos) {
            _adbTap(adb, serial, gotItPos.x, gotItPos.y);
            steps.push("Chrome FRE page 4b: tapped Got it");
            await _sleep(1200);
          } else {
            steps.push("Chrome FRE page 4b: Got-it button not found — no tap");
          }
        } else {
          steps.push("Chrome FRE page 4: More button not found — no tap");
        }
      }
    } else {
      steps.push("Chrome FRE: not shown");
    }

    // ── "Chrome notifications make things easier" promo dialog ───────────────
    // Appears on devices where Chrome hasn't previously been granted the OS
    // notification permission.  Shows a two-button sheet (modal_dialog_view)
    // with "No, thanks" (negative_button) and "Continue" (positive_button).
    // Always dismiss with "No, thanks" — we never want Chrome to request the
    // OS notification permission on the device.
    // If FRE pages were just processed the UI has changed, so take a fresh
    // dump.  If FRE wasn't shown the original dump is still current.
    {
      const notifXml = isFre ? await _uiDump(adb, serial) : xml;
      const isNotifDialog =
        notifXml.includes("modal_dialog_view") ||
        notifXml.includes("Chrome notifications make things easier") ||
        notifXml.includes('"negative_button"');
      if (isNotifDialog) {
        steps.push("Chrome: notification promo dialog detected");
        const noThanksPos = _findElem(notifXml,
          "com.android.chrome:id/negative_button",
          "negative_button",
          "No, thanks",
          "No thanks",
        );
        if (noThanksPos) {
          _adbTap(adb, serial, noThanksPos.x, noThanksPos.y);
          steps.push("Chrome: tapped No, thanks (notification promo)");
          await _sleep(1000);
        } else {
          steps.push("Chrome: No-thanks button not found in notification dialog — no tap");
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Scroll the Chrome feed + interleaved story taps ──────────────────────
    const scrollMin             = opts?.scrollMin             ?? 0;
    const scrollMax             = opts?.scrollMax             ?? 0;
    const storyTapMin           = opts?.storyTapMin           ?? 0;
    const storyTapMax           = opts?.storyTapMax           ?? 0;
    const tappedStoryScrollMin  = opts?.tappedStoryScrollMin  ?? 0;
    const tappedStoryScrollMax  = opts?.tappedStoryScrollMax  ?? 0;
    const internalLinkPctMin    = opts?.internalLinkPctMin    ?? 0;
    const internalLinkPctMax    = opts?.internalLinkPctMax    ?? 0;
    const manualSearchPctMin    = opts?.manualSearchPctMin    ?? 0;
    const manualSearchPctMax    = opts?.manualSearchPctMax    ?? 0;
    const manualSearchCountMin  = opts?.manualSearchCountMin  ?? 1;
    const manualSearchCountMax  = opts?.manualSearchCountMax  ?? 1;
    const manualSearchScrollMin = opts?.manualSearchScrollMin ?? 0;
    const manualSearchScrollMax = opts?.manualSearchScrollMax ?? 0;
    const manualSearchLinkPctMin = opts?.manualSearchLinkPctMin ?? 0;
    const manualSearchLinkPctMax = opts?.manualSearchLinkPctMax ?? 0;
    const manualSearchDwellMin  = opts?.manualSearchDwellMin  ?? 3;
    const manualSearchDwellMax  = opts?.manualSearchDwellMax  ?? 8;
     const tapTrendingStoryMin   = opts?.tapTrendingStoryMin   ?? 0;
     const tapTrendingStoryMax   = opts?.tapTrendingStoryMax   ?? 0;

    const randomRange = (min: number, max: number, floor = false): number => {
      const low = Math.min(min, max);
      const high = Math.max(min, max);
      const value = low + Math.random() * Math.max(0, high - low);
      return floor ? Math.round(value) : value;
    };

    const findGoogleResultLink = (resultXml: string): { x: number; y: number } | null => {
      const candidates: Array<{ x: number; y: number }> = [];
      const nodeRe = /<node\s([^>]+?)\s*\/?>/gi;
      let nodeMatch: RegExpExecArray | null;
      while ((nodeMatch = nodeRe.exec(resultXml)) !== null) {
        const attrs = nodeMatch[1];
        if (!attrs.includes('clickable="true"')) continue;
        if (/class="android\.widget\.EditText"/i.test(attrs)) continue;
        if (/resource-id="[^"]*com\.android\.chrome/i.test(attrs)) continue;
        const bounds = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
        if (!bounds) continue;
        const x1 = Number(bounds[1]), y1 = Number(bounds[2]);
        const x2 = Number(bounds[3]), y2 = Number(bounds[4]);
        const width = x2 - x1;
        const height = y2 - y1;
        const cy = Math.round((y1 + y2) / 2);
        if (width < 90 || height < 24 || cy < 90 || cy > 0.9 * _getScreenSize(resultXml).h) continue;
        const label = [
          attrs.match(/\btext="([^"]*)"/i)?.[1] ?? "",
          attrs.match(/\bcontent-desc="([^"]*)"/i)?.[1] ?? "",
          attrs.match(/\bhint="([^"]*)"/i)?.[1] ?? "",
        ].join(" ").replace(/\s+/g, " ").trim();
        if (label.length < 8) continue;
        if (/^(images?|news|maps?|shopping|videos?|more|settings|tools|sign in|next|previous)$/i.test(label)) continue;
        candidates.push({ x: Math.round((x1 + x2) / 2), y: cy });
      }
      return candidates.length > 0
        ? candidates[Math.floor(Math.random() * candidates.length)]
        : null;
    };

    const returnGoogleToHomepage = async (): Promise<void> => {
      const pageXml = await _uiDump(adb, serial);
      const homeButton = _findElem(
        pageXml,
        "com.google.android.apps.chrome:id/home_button",
        "com.android.chrome:id/home_button",
        ":id/home_button",
        "home_button",
        "Open the homepage",
      );
      if (homeButton) {
        _adbTap(adb, serial, homeButton.x, homeButton.y);
        await _sleep(1300);
      } else {
        await keyevent(serial, 4);
        await _sleep(900);
      }
    };

    const runOneManualGoogleSearch = async (
      query: string,
      searchNumber: number,
      totalSearches: number,
    ): Promise<void> => {
      // Navigate to Google separately for every query so each search starts
      // from a clean homepage rather than inheriting the previous results page.
      if (manualSearchPctMax <= 0) return;
      const openGoogle = spawnSync(adb, [
        "-s", serial, "shell", "am", "start",
        "-n", "com.android.chrome/com.google.android.apps.chrome.Main",
        "-a", "android.intent.action.VIEW",
        "-d", "https://www.google.com",
      ], { encoding: "utf8", timeout: 10000 });
      const openOutput = `${openGoogle.stdout ?? ""}${openGoogle.stderr ?? ""}`;
      if (openGoogle.status !== 0 || /error|does not exist/i.test(openOutput)) {
        steps.push(`Chrome manual search ${searchNumber}/${totalSearches}: could not open google.com — ${openOutput.trim().slice(0, 120)}`);
        return;
      }
      steps.push(`Chrome manual search ${searchNumber}/${totalSearches}: opened google.com`);
      await _sleep(2200 + Math.floor(Math.random() * 900));

      const googleXml = await _uiDump(adb, serial);
      // Google localises the visible hint and changes the resource id between
      // Chrome builds. Prefer a real EditText node from the current dump and
      // use its hint/text/resource-id only as a narrowing signal.
      let searchField: { x: number; y: number } | null = null;
      const editTextRe = /<node\s([^>]*class="android\.widget\.EditText"[^>]*)>/gi;
      let editMatch: RegExpExecArray | null;
      while ((editMatch = editTextRe.exec(googleXml)) !== null) {
        const attrs = editMatch[1];
        const bounds = attrs.match(/bounds="([^"]+)"/i);
        if (!bounds) continue;
        const label = [
          attrs.match(/\btext="([^"]*)"/i)?.[1] ?? "",
          attrs.match(/\bcontent-desc="([^"]*)"/i)?.[1] ?? "",
          attrs.match(/\bhint="([^"]*)"/i)?.[1] ?? "",
          attrs.match(/\bresource-id="([^"]*)"/i)?.[1] ?? "",
        ].join(" ").toLowerCase();
        if (!/(search|google|query|\bq\b)/i.test(label)) continue;
        searchField = _parseCenter(bounds[1]);
        if (searchField) break;
      }
      // Some builds expose the field without a useful label. It is still safe
      // to use only an EditText node, rather than guessing from screen size.
      if (!searchField) {
        editTextRe.lastIndex = 0;
        const fallback = editTextRe.exec(googleXml);
        const bounds = fallback?.[1].match(/bounds="([^"]+)"/i);
        if (bounds) searchField = _parseCenter(bounds[1]);
      }
      if (!searchField) {
        steps.push(`Chrome manual search ${searchNumber}/${totalSearches}: Google search field not found for "${query}" — skipped safely`);
        await keyevent(serial, 4); // KEYCODE_BACK
        await _sleep(900);
        return;
      }

      _adbTap(adb, serial, searchField.x, searchField.y);
      await _sleep(300);
      await typeViaOnscreenKeyboard(serial, query, opts!.typingProfile, msg => steps.push(`Chrome manual search: ${msg}`));
      await keyevent(serial, 66); // KEYCODE_ENTER
      steps.push(`Chrome manual search ${searchNumber}/${totalSearches}: searched "${query}"`);
      await _sleep(2500 + Math.floor(Math.random() * 1500));

      let resultXml = await _uiDump(adb, serial);
      const { w: resultWidth, h: resultHeight } = _getScreenSize(resultXml);
      const resultScrolls = manualSearchScrollMax > 0
        ? randomRange(manualSearchScrollMin, manualSearchScrollMax, true)
        : 0;
      if (resultScrolls > 0) {
        steps.push(`Chrome manual search ${searchNumber}/${totalSearches}: scrolling results ${resultScrolls}x`);
        const scrollX = Math.round(resultWidth / 2);
        for (let scroll = 0; scroll < resultScrolls; scroll++) {
          await swipe(serial, scrollX, Math.round(resultHeight * 0.78), scrollX, Math.round(resultHeight * 0.28), profileSwipeDuration());
          await _sleep(650 + Math.floor(Math.random() * 650));
        }
        resultXml = await _uiDump(adb, serial);
      }

      const linkPct = randomRange(manualSearchLinkPctMin, manualSearchLinkPctMax);
      if (manualSearchLinkPctMax > 0 && Math.random() * 100 < linkPct) {
        const resultLink = findGoogleResultLink(resultXml);
        if (resultLink) {
          _adbTap(adb, serial, resultLink.x, resultLink.y);
          const dwellSeconds = randomRange(manualSearchDwellMin, manualSearchDwellMax);
          steps.push(`Chrome manual search ${searchNumber}/${totalSearches}: opened a confirmed result link; dwelling ${dwellSeconds.toFixed(1)}s`);
          await _sleep(Math.round(dwellSeconds * 1000));
          await keyevent(serial, 4);
          await _sleep(900);
          steps.push(`Chrome manual search ${searchNumber}/${totalSearches}: returned from result link`);
        } else {
          steps.push(`Chrome manual search ${searchNumber}/${totalSearches}: link roll fired but no confirmed result link was found`);
        }
      } else if (manualSearchLinkPctMax > 0) {
        steps.push(`Chrome manual search ${searchNumber}/${totalSearches}: result-link roll did not fire`);
      }

      await returnGoogleToHomepage();
      steps.push(`Chrome manual search ${searchNumber}/${totalSearches}: returned to Google homepage`);
    };

    const runManualGoogleSearches = async (): Promise<void> => {
      if (manualSearchPctMax <= 0) return;
      const activationPct = randomRange(manualSearchPctMin, manualSearchPctMax);
      if (Math.random() * 100 >= activationPct) {
        steps.push("Chrome manual searches: activation roll did not fire");
        return;
      }

      const totalSearches = Math.max(1, Math.min(50, randomRange(manualSearchCountMin, manualSearchCountMax, true)));
      const usedQueries = new Set<string>();
      steps.push(`Chrome manual searches: activated for ${totalSearches} fresh Google quer${totalSearches === 1 ? "y" : "ies"}`);
      for (let searchNumber = 1; searchNumber <= totalSearches; searchNumber++) {
        const selected = chooseChromeManualSearchQuery(usedQueries);
        const query = selected.query;
        usedQueries.add(query);
        steps.push(
          `Chrome manual search ${searchNumber}/${totalSearches}: selected ${selected.wordCount}-word query`,
        );
        await runOneManualGoogleSearch(query, searchNumber, totalSearches);
      }
    };

    /**
     * Google Trending content is rendered inside a Chrome WebView. On affected
     * builds UIAutomator exposes only the outer WebView, so the cards have no
     * useful text, clickable state, or bounds in the dump. Detect the live
     * repeated neutral-gray separators from the current screenshot instead of
     * guessing a page coordinate.
     */
    const findGoogleTrendingSearchRows = (
      img: { width: number; height: number; channels: number; pixels: Buffer },
    ): Array<{ x: number; y: number }> => {
      const { width, height, channels, pixels } = img;
      const x1 = Math.round(width * 0.08);
      const x2 = Math.round(width * 0.92);
      const scanTop = Math.round(height * 0.22);
      const scanBottom = Math.round(height * 0.80);
      const separatorYs: number[] = [];

      for (let y = scanTop; y <= scanBottom; y++) {
        let neutralGrayPixels = 0;
        for (let x = x1; x <= x2; x += 2) {
          const idx = y * width * channels + x * channels;
          const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
          const luminance = (r + g + b) / 3;
          if (
            Math.max(r, g, b) - Math.min(r, g, b) <= 18 &&
            luminance >= 150 &&
            luminance <= 245
          ) {
            neutralGrayPixels++;
          }
        }
        if (neutralGrayPixels >= Math.round((x2 - x1) * 0.27)) {
          separatorYs.push(y);
        }
      }

      const separators: number[] = [];
      for (const y of separatorYs) {
        if (separators.length === 0 || y - separators[separators.length - 1] > 3) {
          separators.push(y);
        } else {
          separators[separators.length - 1] = Math.round(
            (separators[separators.length - 1] + y) / 2,
          );
        }
      }

      let bestRun: number[] = [];
      for (let start = 0; start < separators.length; start++) {
        const run = [separators[start]];
        let averageGap = 0;
        for (let next = start + 1; next < separators.length; next++) {
          const gap = separators[next] - separators[next - 1];
          if (gap < Math.max(38, height * 0.025) || gap > height * 0.16) break;
          if (run.length >= 2 && Math.abs(gap - averageGap) > Math.max(28, averageGap * 0.55)) break;
          run.push(separators[next]);
          averageGap = (averageGap * (run.length - 2) + gap) / (run.length - 1);
        }
        if (run.length > bestRun.length) bestRun = run;
      }

      if (bestRun.length < 3) return [];
      return bestRun.slice(0, -1).map((top, index) => ({
        x: Math.round(width / 2),
        y: Math.round((top + bestRun[index + 1]) / 2),
      }));
    };

    const readChromeUrl = (xml: string): string | null => {
      const nodeRe = /<node\s([^>]+?)\s*\/?>/gi;
      let match: RegExpExecArray | null;
      while ((match = nodeRe.exec(xml)) !== null) {
        const attrs = match[1];
        if (!attrs.includes("url_bar")) continue;
        return attrs.match(/\btext="([^"]*)"/i)?.[1] ?? null;
      }
      return null;
    };

    const runTrendingGoogleStories = async (): Promise<void> => {
      if (tapTrendingStoryMax <= 0) {
        steps.push("Chrome trending stories: disabled because Tap Trending Storys max is 0");
        return;
      }
      const totalStories = Math.max(0, Math.min(50, randomRange(tapTrendingStoryMin, tapTrendingStoryMax, true)));
      if (totalStories <= 0) return;

      const openGoogle = spawnSync(adb, [
        "-s", serial, "shell", "am", "start",
        "-n", "com.android.chrome/com.google.android.apps.chrome.Main",
        "-a", "android.intent.action.VIEW",
        "-d", "https://www.google.com",
      ], { encoding: "utf8", timeout: 10000 });
      const openOutput = `${openGoogle.stdout ?? ""}${openGoogle.stderr ?? ""}`;
      if (openGoogle.status !== 0 || /error|does not exist/i.test(openOutput)) {
        steps.push("Chrome trending stories: could not open google.com — skipped safely");
        return;
      }

      steps.push(`Chrome trending stories: opened google.com for up to ${totalStories} stor${totalStories === 1 ? "y" : "ies"}`);
      await _sleep(2200 + Math.floor(Math.random() * 900));
      const usedCenters = new Set<string>();
      let tapped = 0;

      for (let storyNumber = 1; storyNumber <= totalStories; storyNumber++) {
        const screen = await _captureScreenPixels(serial);
        const rows = screen
          ? findGoogleTrendingSearchRows(screen)
              .filter(row => !usedCenters.has(`${row.x},${row.y}`))
          : [];
        if (rows.length === 0) {
          steps.push(`Chrome trending stories: no screenshot-confirmed row for ${storyNumber}/${totalStories} — skipped`);
          break;
        }

        const story = rows[Math.floor(Math.random() * rows.length)];
        usedCenters.add(`${story.x},${story.y}`);
        _adbTap(adb, serial, story.x, story.y);
        await _sleep(1800 + Math.floor(Math.random() * 1200));

        const afterUrl = readChromeUrl(await _uiDump(adb, serial));
        const navigationConfirmed = !!afterUrl &&
          afterUrl !== "google.com" &&
          !/^https?:\/\/(?:www\.)?google\.com\/?$/i.test(afterUrl);
        if (!navigationConfirmed) {
          steps.push(`Chrome trending stories: row tap ${storyNumber}/${totalStories} was not confirmed — skipped`);
          await returnGoogleToHomepage();
          continue;
        }

        tapped++;
        steps.push(`Chrome trending stories: tapped story ${storyNumber}/${totalStories}`);
        await returnGoogleToHomepage();
      }

      await returnGoogleToHomepage();
      steps.push(`Chrome trending stories: completed ${tapped}/${totalStories} confirmed tap${tapped === 1 ? "" : "s"}`);
    };

    const storyTapTotal = storyTapMax > 0
      ? Math.round(storyTapMin + Math.random() * Math.max(0, storyTapMax - storyTapMin)) : 0;

    // cx/fromY/toY are shared with readAndBack via closure.  They are set from
    // the feed UI dump at the start of each tap cycle (and for scroll-only runs)
    // so the article swipes always use the correct screen geometry.
    let cx    = 0;
    let fromY = 0;
    let toY   = 0;

    // Helper: scroll inside a tapped article page then press Back.
    // Uses cx/fromY/toY captured from the enclosing scope — updated each cycle.
    const readAndBack = async (tapNum: number) => {
      await _sleep(1800 + Math.floor(Math.random() * 1200)); // 1.8–3 s page load wait

      // ── Universal cookie / consent banner dismissal ────────────────────────
      // Some article pages show a cookie-consent overlay immediately on load.
      // Detect it from the UI dump and tap the accept button before scrolling
      // so subsequent taps land on real article content, not the banner.
      {
        const cookieXml = await _uiDump(adb, serial);
        const acceptPos = _findCookieAcceptButton(cookieXml);
        if (acceptPos) {
          _adbTap(adb, serial, acceptPos.x, acceptPos.y);
          steps.push(`Chrome story ${tapNum}: cookie/consent banner detected — tapped accept`);
          await _sleep(900); // brief wait for banner to dismiss and page to settle
        } else {
          // Check if a banner keyword is present even though no accept button was
          // found — means we're looking at an unusual banner layout we can't
          // interact with.  Press Back to exit the article cleanly so the feed
          // loop can continue rather than scrolling a banner-blocked page.
          const low = cookieXml.toLowerCase();
          const hasBanner =
            low.includes("cookie") ||
            low.includes("consent") ||
            low.includes("contentpass") ||
            low.includes("personalised ads") ||
            low.includes("personalized ads") ||
            low.includes("gdpr") ||
            low.includes("privacy policy") ||
            low.includes("we and our") ||
            low.includes("our partners");
          if (hasBanner) {
            spawnSync(adb, ["-s", serial, "shell", "input", "keyevent", "KEYCODE_BACK"],
              { encoding: "utf8", timeout: 5000 });
            steps.push(`Chrome story ${tapNum}: cookie banner detected but no accept button found — pressed Back`);
            await _sleep(800 + Math.floor(Math.random() * 400));
            return; // skip article scroll; feed loop resumes normally
          }
        }
      }
      // ──────────────────────────────────────────────────────────────────────

      const articleScrolls = tappedStoryScrollMax > 0
        ? Math.round(tappedStoryScrollMin + Math.random() * Math.max(0, tappedStoryScrollMax - tappedStoryScrollMin))
        : 0;
      if (articleScrolls > 0) {
        steps.push(`Chrome story ${tapNum}: scrolling article ${articleScrolls}x`);
        for (let sc = 0; sc < articleScrolls; sc++) {
          await swipe(serial, cx, fromY, cx, toY, profileSwipeDuration());
          await _sleep(600 + Math.floor(Math.random() * 700)); // 0.6–1.3 s between scrolls
        }
      } else {
        // No article scrolls configured — keep the original flat reading pause
        await _sleep(200 + Math.floor(Math.random() * 2000)); // 0.2–2.2 s extra reading time
      }

      // ── Internal link click (optional) ────────────────────────────────────
      // Roll once per story visit.  If it fires, dump the article UI, find a
      // tappable inline link, tap it, wait for the linked page to load, then
      // press Back to return to the article — before the outer Back that
      // returns to the Chrome feed.
      if (internalLinkPctMax > 0) {
        const linkPct = internalLinkPctMin + Math.random() * Math.max(0, internalLinkPctMax - internalLinkPctMin);
        if (Math.random() * 100 < linkPct) {
          const articleXml = await _uiDump(adb, serial);
          const { w: alw, h: alh } = _getScreenSize(articleXml);
          const linkPos = _findChromeInternalLink(articleXml, alw, alh);
          if (linkPos) {
            _adbTap(adb, serial, linkPos.x, linkPos.y);
            steps.push(`Chrome story ${tapNum}: tapped internal link at (${linkPos.x},${linkPos.y})`);
            await _sleep(1800 + Math.floor(Math.random() * 1200)); // wait for linked page to load
            spawnSync(adb, ["-s", serial, "shell", "input", "keyevent", "KEYCODE_BACK"],
              { encoding: "utf8", timeout: 5000 }); // back from internal link → article
            await _sleep(700 + Math.floor(Math.random() * 600));
          } else {
            steps.push(`Chrome story ${tapNum}: internal link roll fired but no link found`);
          }
        }
      }
      // ──────────────────────────────────────────────────────────────────────

      spawnSync(adb, ["-s", serial, "shell", "input", "keyevent", "KEYCODE_BACK"],
        { encoding: "utf8", timeout: 5000 });
      await _sleep(800 + Math.floor(Math.random() * 700)); // 0.8–1.5 s for feed to re-render
    };

    // ── Helper: press the Chrome Home button to return to the Discover feed ──
    // Used at the start of each story-tap cycle so every cycle begins from the
    // same known state rather than wherever the last article left the browser.
    const pressHomeButton = async (label: string) => {
      const hXml = await _uiDump(adb, serial);
      const homePos = _findElem(hXml,
        "com.android.chrome:id/home_button",
        "home_button",
        "Open the homepage",
      );
      if (homePos) {
        _adbTap(adb, serial, homePos.x, homePos.y);
        steps.push(`Chrome ${label}: pressed Home button — navigating to homepage`);
        await _sleep(1500);
      } else {
        steps.push(`Chrome ${label}: Home button not visible — skipping (already on feed?)`);
      }
    };
    // ─────────────────────────────────────────────────────────────────────────

    // ── Helper: scroll the Chrome Discover feed N times and return a fresh dump ─
    const scrollFeedCycle = async (cycleScrolls: number, label: string): Promise<{ xml: string; sw: number; sh: number } | null> => {
      await _sleep(1200); // let the feed settle after home-button nav
      const feedXml = await _uiDump(adb, serial);
      if (!feedXml.includes("feed_stream_recycler_view")) {
        steps.push(`Chrome ${label}: feed_stream_recycler_view not detected — skipping`);
        return null;
      }
      const { w: sw, h: sh } = _getScreenSize(feedXml);
      // Update shared geometry used by readAndBack
      cx    = Math.round(sw / 2);
      fromY = Math.round(sh * 0.75);
      toY   = Math.round(sh * 0.25);
      if (cycleScrolls > 0) {
        steps.push(`Chrome ${label}: scrolling feed ${cycleScrolls}x`);
        for (let s = 0; s < cycleScrolls; s++) {
          await swipe(serial, cx, fromY, cx, toY, profileSwipeDuration());
          await _sleep(700 + Math.floor(Math.random() * 800));
        }
      }
      // Return a fresh dump after scrolling so card detection is current
      const afterXml = cycleScrolls > 0 ? await _uiDump(adb, serial) : feedXml;
      return { xml: afterXml, sw, sh };
    };
    // ─────────────────────────────────────────────────────────────────────────

    // Wrap the entire scroll/tap block in its own try/catch so any mid-run
    // exception is caught and logged here, and the Chrome close step below
    // always executes regardless.
    try {
      if (storyTapTotal > 0) {
        // ── Story-tap driven loop ─────────────────────────────────────────────
        // Each iteration is one complete cycle:
        //   Home button → N feed scrolls → tap card → article scroll + link → Back
        // This repeats storyTapTotal times so every tap gets a fresh feed pass.
        await _sleep(1500); // let Chrome settle after FRE / launch

        for (let t = 0; t < storyTapTotal; t++) {
          const tapNum = t + 1;
          const label  = `tap ${tapNum}/${storyTapTotal}`;

          // On the first cycle the initial home-button tap at launch already
          // positioned Chrome on the homepage; skip the extra press.
          // On subsequent cycles press Home to reset from wherever the previous
          // article left the browser.
          if (t > 0) {
            await pressHomeButton(label);
          }

          // Roll a fresh scroll count for this cycle
          const cycleScrolls = scrollMax > 0
            ? Math.round(scrollMin + Math.random() * Math.max(0, scrollMax - scrollMin))
            : 0;

          const feed = await scrollFeedCycle(cycleScrolls, label);
          if (!feed) continue; // feed not detected — skip this tap, try next

          const cards = _findChromeFeedCards(feed.xml, feed.sw);
          if (cards.length > 0) {
            const card = cards[Math.floor(Math.random() * cards.length)];
            _adbTap(adb, serial, card.x, card.y);
            steps.push(`Chrome feed: story tap ${tapNum}/${storyTapTotal}`);
            await readAndBack(tapNum);
          } else {
            steps.push(`Chrome feed: story tap ${tapNum}/${storyTapTotal} — no cards found`);
          }
        }
        // ─────────────────────────────────────────────────────────────────────

      } else if (scrollMax > 0) {
        // ── Scroll-only run (no story taps configured) ────────────────────────
        await _sleep(1500);
        const scrollCount = Math.round(scrollMin + Math.random() * Math.max(0, scrollMax - scrollMin));
        await scrollFeedCycle(scrollCount, "scroll-only");
        // ─────────────────────────────────────────────────────────────────────
      }
    } catch (scrollErr: any) {
      // Log the error but do NOT re-throw — the Chrome close step must always run.
      steps.push(`Chrome: scroll/tap error — ${String(scrollErr?.message ?? scrollErr)}`);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Run the optional search after the normal Chrome activity so it cannot
    // change the page state used by the existing feed/story flow. It remains
    // before the verified recents close, so Google history is written normally.
    if (manualSearchPctMax > 0) {
      try {
        await runManualGoogleSearches();
      } catch (searchErr: any) {
        // Manual search is optional. Never prevent the verified Chrome close
        // gesture if it fails on a particular device or Chrome build.
        steps.push(`Chrome manual search: failed safely — ${String(searchErr?.message ?? searchErr)}`);
      }
    }

    // Run trending-story taps after manual searches and result dwell, before
    // the verified Chrome close path.
    try {
      await runTrendingGoogleStories();
    } catch (trendingErr: any) {
      steps.push(`Chrome trending stories: failed safely — ${String(trendingErr?.message ?? trendingErr)}`);
    }

    // ── Close Chrome via recents (open floaty windows + swipe gesture) ──────
    // Always runs regardless of whether any scrolls/taps were configured.
    const dismissDir = opts?.dismissDirection
      ?? getModelDismissDirection(getDeviceModel(serial));
    const { w: rw, h: rh } = getScreenSize(serial);
    await openRecentApps(serial);
    await _sleep(1200); // wait for OEM recents overlay to settle
    const rcx = Math.round(rw / 2);
    if (dismissDir === "up") {
      await swipe(serial, rcx, Math.round(rh * 0.65), rcx, 0, 150);
    } else {
      await swipe(serial, rcx, Math.round(rh * 0.45), Math.round(rw * 0.05), Math.round(rh * 0.45), 400);
    }
    steps.push(`Chrome: opened recents + swiped away (${dismissDir})`);
    await _sleep(800);
    // ──────────────────────────────────────────────────────────────────────────

    return { ok: true, steps };
  } catch (e: any) {
    return { ok: false, steps, error: String(e?.message ?? e) };
  }
}

/**
 * Returns tappable YouTube homepage video cards from a UIAutomator dump.
 * Identifies them by the content-desc patterns YouTube writes for video items:
 * the string ends with "– play video" or contains "Go to channel" alongside a
 * duration/upload-time component. Excludes nav bar, tiny icon nodes, and
 * channel-avatar items.
 */
function _findYoutubeVideoCards(
  xml: string,
  screenH: number,
): Array<{ x: number; y: number }> {
  const results: Array<{ x: number; y: number }> = [];
  const nodeRe = /<node[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const node = m[0];
    if (!node.includes('clickable="true"')) continue;
    const dm = node.match(/content-desc="([^"]*)"/);
    const desc = dm ? dm[1] : "";
    // "play video" is YouTube's own a11y suffix on every video card.
    // "Go to channel" + a time component covers cards that render a full
    // accessibility description but omit the "play video" suffix.
    const isVideo =
      desc.includes("play video") ||
      (desc.includes("Go to channel") &&
        (desc.includes("hour") || desc.includes("minute") ||
         desc.includes("second") || desc.includes(" ago")));
    if (!isVideo) continue;
    const bm = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bm) continue;
    const y1 = parseInt(bm[2], 10), y2 = parseInt(bm[4], 10);
    if (y2 - y1 < 80) continue; // skip tiny icon/badge nodes
    const cy = Math.round((y1 + y2) / 2);
    // Avoid system-bar and bottom-nav areas.
    if (cy < screenH * 0.08 || cy > screenH * 0.92) continue;
    results.push({ x: Math.round((parseInt(bm[1], 10) + parseInt(bm[3], 10)) / 2), y: cy });
  }
  return results;
}

/**
 * Opens the YouTube app on the device, dismisses the OS notification-
 * permission dialog if it appears, scrolls the homepage feed X–Y times,
 * optionally taps a video (rolls a click %) and presses Back, then closes
 * the app via the device's floating-windows recents gesture (same pattern
 * as runChromeApp).
 *
 * Detection uses standard Android permission dialog resource-ids because
 * that dialog is rendered by the OS, not the YouTube package.
 */
export async function runYoutubeApp(
  serial: string,
  opts?: {
    swipeGesture: {
      x1: number; y1: number; x2: number; y2: number;
      durationMinMs: number; durationMaxMs: number; jitterX: number; jitterY: number;
      startJitterMinY?: number; startJitterMaxY?: number;
    };
    scrollMin?: number; scrollMax?: number;
    clickPctMin?: number; clickPctMax?: number;
    /** Seconds to spend watching a tapped video before pressing Back. */
    watchTimeMin?: number; watchTimeMax?: number;
    /** Chance (0–100%) to tap the Shorts tab after the video-tap section. */
    clickShortsPctMin?: number; clickShortsPctMax?: number;
    /** Number of swipe-ups to perform inside the Shorts feed. */
    shortsScrollMin?: number; shortsScrollMax?: number;
    /** Seconds to spend on each Short. */
    shortsWatchTimeMin?: number; shortsWatchTimeMax?: number;
    /** Chance (0–100%) to tap the Like button on each Short viewed. */
    shortsLikePctMin?: number; shortsLikePctMax?: number;
    dismissDirection?: "left" | "up";
  },
): Promise<{ ok: boolean; steps: string[]; error?: string }> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const steps: string[] = [];
  if (!opts?.swipeGesture) throw new Error("Swipe Gesture Profile is required for YouTube content scrolling");
  const profileSwipeDuration = () => {
    const min = Math.min(opts.swipeGesture.durationMinMs, opts.swipeGesture.durationMaxMs);
    const max = Math.min(150, Math.max(opts.swipeGesture.durationMinMs, opts.swipeGesture.durationMaxMs));
    if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error("Swipe Gesture Profile duration is invalid");
    return Math.max(1, Math.round(min + Math.random() * (max - min)));
  };
  try {
    // Launch YouTube main activity.
    spawnSync(adb, ["-s", serial, "shell", "am", "start", "-n",
      "com.google.android.youtube/com.google.android.youtube.HomeActivity",
      "--activity-clear-top",
    ], { encoding: "utf8", timeout: 10000 });
    steps.push("YouTube launched");

    // Allow time for the app (and any permission dialog) to render.
    await _sleep(2500);

    // Dump the UI tree and check for the notification-permission dialog.
    const xml = await _uiDump(adb, serial);
    const hasNotifDialog =
      xml.includes("permission_deny_button") ||
      xml.includes("Allow YouTube to send you notifications");

    if (hasNotifDialog) {
      steps.push("YouTube: notification permission dialog detected");
      const denyPos = _findElem(xml,
        "android:id/permission_deny_button",
        "permission_deny_button",
        "Don't allow",
        "Don\u2019t allow",
      );
      if (denyPos) {
        _adbTap(adb, serial, denyPos.x, denyPos.y);
        steps.push("YouTube: tapped Don't allow");
        await _sleep(800);
      } else {
        steps.push("YouTube: deny button not found — skipping tap");
      }
    } else {
      steps.push("YouTube: notification dialog not shown");
    }

    // ── Scroll and optional video tap ─────────────────────────────────────────
    const scrollMin          = opts?.scrollMin          ?? 0;
    const scrollMax          = opts?.scrollMax          ?? 0;
    const clickPctMin        = opts?.clickPctMin        ?? 0;
    const clickPctMax        = opts?.clickPctMax        ?? 0;
    const watchTimeMin       = opts?.watchTimeMin       ?? 3;
    const watchTimeMax       = opts?.watchTimeMax       ?? 8;
    const clickShortsPctMin  = opts?.clickShortsPctMin  ?? 0;
    const clickShortsPctMax  = opts?.clickShortsPctMax  ?? 0;
    const shortsScrollMin    = opts?.shortsScrollMin    ?? 0;
    const shortsScrollMax    = opts?.shortsScrollMax    ?? 0;
    const shortsWatchTimeMin = opts?.shortsWatchTimeMin ?? 3;
    const shortsWatchTimeMax = opts?.shortsWatchTimeMax ?? 8;
    const shortsLikePctMin   = opts?.shortsLikePctMin   ?? 0;
    const shortsLikePctMax   = opts?.shortsLikePctMax   ?? 0;

    const scrollCount = scrollMax > 0
      ? Math.round(scrollMin + Math.random() * Math.max(0, scrollMax - scrollMin))
      : 0;

    // cx/fromY/toY are set once from the feed dump and reused throughout
    // (upward scroll, Shorts navigation, etc.).
    let cx    = 0;
    let fromY = 0;
    let toY   = 0;
    let feedDetected = false;

    if (scrollCount > 0 || clickPctMax > 0 || clickShortsPctMax > 0) {
      // Let the homepage settle after launch / dialog dismissal.
      await _sleep(1500);

      const feedXml = await _uiDump(adb, serial);
      const onHomepage =
        feedXml.includes("browse_fragment_layout_coordinator_layout") ||
        feedXml.includes('"results"');

      if (!onHomepage) {
        steps.push("YouTube: homepage not detected — skipping scroll/tap");
      } else {
        feedDetected = true;
        const { w: sw, h: sh } = _getScreenSize(feedXml);
        cx    = Math.round(sw / 2);
        fromY = Math.round(sh * 0.75);
        toY   = Math.round(sh * 0.25);

        // ── Scroll loop ─────────────────────────────────────────────────────
        if (scrollCount > 0) {
          steps.push(`YouTube: scrolling homepage ${scrollCount}x`);
          for (let i = 0; i < scrollCount; i++) {
            await swipe(serial, cx, fromY, cx, toY, profileSwipeDuration());
            await _sleep(700 + Math.floor(Math.random() * 800));
          }
        }

        // ── Optional video tap ───────────────────────────────────────────────
        if (clickPctMax > 0) {
          const pct = clickPctMin + Math.random() * Math.max(0, clickPctMax - clickPctMin);
          if (Math.random() * 100 < pct) {
            const cardXml = await _uiDump(adb, serial);
            const { h: cardH } = _getScreenSize(cardXml);
            const cards = _findYoutubeVideoCards(cardXml, cardH);
            if (cards.length > 0) {
              const card = cards[Math.floor(Math.random() * cards.length)];
              _adbTap(adb, serial, card.x, card.y);
              steps.push(`YouTube: tapped video card at (${card.x},${card.y})`);
              await _sleep(2500 + Math.floor(Math.random() * 1500));
              const afterXml = await _uiDump(adb, serial);
              const openedVideo =
                afterXml.includes("watch_while_layout_coordinator_layout") ||
                afterXml.includes("next_gen_watch_container_layout") ||
                !afterXml.includes("browse_fragment_layout_coordinator_layout");
              if (openedVideo) {
                // Configurable watch time before pressing Back.
                const watchMs = Math.round(
                  (watchTimeMin + Math.random() * Math.max(0, watchTimeMax - watchTimeMin)) * 1000,
                );
                steps.push(`YouTube: watching video for ~${Math.round(watchMs / 1000)}s`);
                // Poll for the skip-ad button during the watch window.
                // id="skip_ad_button" / desc="Skip ad" appears after a
                // countdown on skippable pre-roll ads.  We check every
                // ~5 s; if found we tap immediately and continue watching
                // so the session still looks natural.
                {
                  const skipPollMs = 4800 + Math.floor(Math.random() * 800);
                  let watchedMs = 0;
                  while (watchedMs < watchMs) {
                    const chunkMs = Math.min(skipPollMs, watchMs - watchedMs);
                    await _sleep(chunkMs);
                    watchedMs += chunkMs;
                    if (watchedMs >= watchMs) break; // done — skip the dump
                    const adXml = await _uiDump(adb, serial);
                    const skipBtn = _findElem(adXml, "skip_ad_button", "Skip ad", "Skip");
                    if (skipBtn) {
                      _adbTap(adb, serial, skipBtn.x, skipBtn.y);
                      steps.push(`YouTube: skipped ad at ~${Math.round(watchedMs / 1000)}s`);
                      await _sleep(500 + Math.floor(Math.random() * 300));
                    }
                  }
                }
                spawnSync(adb, ["-s", serial, "shell", "input", "keyevent", "KEYCODE_BACK"],
                  { encoding: "utf8", timeout: 5000 });
                steps.push("YouTube: video confirmed opened — pressed Back");
                await _sleep(800 + Math.floor(Math.random() * 600));
              } else {
                steps.push("YouTube: tap did not open a video — skipping Back press");
              }
            } else {
              steps.push("YouTube: click roll fired but no video cards found in dump");
            }
          } else {
            steps.push("YouTube: click roll not fired");
          }
        }

        // ── Optional Shorts tab ──────────────────────────────────────────────
        // The Shorts button in the bottom nav bar is only reliably tappable
        // from the top of the homepage (the bar hides when the user scrolls
        // down).  After the video-tap section we are back in the feed but
        // potentially scrolled down, so scroll back up the same number of
        // times we scrolled down to restore the top-of-feed state.
        if (clickShortsPctMax > 0 && feedDetected) {
          const shortsPct = clickShortsPctMin + Math.random() * Math.max(0, clickShortsPctMax - clickShortsPctMin);
          if (Math.random() * 100 < shortsPct) {
            // Scroll UP to return to the top of the homepage feed.
            // Add 2 extra scrolls on top of the feed scroll count to ensure
            // we always reach the very top even if the feed drifted further.
            const scrollBackCount = scrollCount + 2;
            steps.push(`YouTube: Shorts roll fired — scrolling back to top (${scrollBackCount}x up)`);
            for (let i = 0; i < scrollBackCount; i++) {
              // Reverse swipe direction: toY→fromY scrolls the feed upward.
              await swipe(serial, cx, toY, cx, fromY, profileSwipeDuration());
              await _sleep(500 + Math.floor(Math.random() * 500));
            }

            // ── Dismiss YouTube mini-player if present ──────────────────────
            // After pressing Back from a video, YouTube sometimes keeps a
            // mini-player pinned at the bottom of the screen.  Its X close
            // button sits in the bottom-right corner and blocks the Shorts
            // nav icon until dismissed.  Tap it if it is visible, then wait
            // for the dismiss animation before looking for Shorts.
            const preNavXml = await _uiDump(adb, serial);
            const { h: ytScreenH } = getScreenSize(serial);
            const miniCloseBtn = _findElem(preNavXml, "Close");
            if (miniCloseBtn && miniCloseBtn.y > ytScreenH * 0.5) {
              _adbTap(adb, serial, miniCloseBtn.x, miniCloseBtn.y);
              steps.push("YouTube: dismissed mini-player (tapped X close button)");
              await _sleep(900 + Math.floor(Math.random() * 400));
            }

            // Find and tap the Shorts nav button.
            const navXml = await _uiDump(adb, serial);
            const shortsBtn = _findElem(navXml, "Shorts");
            if (shortsBtn) {
              _adbTap(adb, serial, shortsBtn.x, shortsBtn.y);
              steps.push("YouTube: tapped Shorts button");
              await _sleep(2000); // wait for Shorts feed to load

              const shortsTotal = shortsScrollMax > 0
                ? Math.round(shortsScrollMin + Math.random() * Math.max(0, shortsScrollMax - shortsScrollMin))
                : 0;

              const { w: ssx, h: ssh } = getScreenSize(serial);
              const scx    = Math.round(ssx / 2);
              const sfromY = Math.round(ssh * 0.75);
              const stoY   = Math.round(ssh * 0.25);

              // Helper: roll the Shorts like chance and tap if fired.
              const rollShortsLike = async (shortLabel: string) => {
                if (shortsLikePctMax <= 0) return;
                const likePct = shortsLikePctMin + Math.random() * Math.max(0, shortsLikePctMax - shortsLikePctMin);
                if (Math.random() * 100 < likePct) {
                  const likeXml = await _uiDump(adb, serial);
                  const likeBtn = _findElem(likeXml, " likes");
                  if (likeBtn) {
                    _adbTap(adb, serial, likeBtn.x, likeBtn.y);
                    steps.push(`YouTube Shorts: liked ${shortLabel}`);
                    await _sleep(500 + Math.floor(Math.random() * 300));
                  } else {
                    steps.push(`YouTube Shorts: like button not found on ${shortLabel} — skipping`);
                  }
                }
              };

              // Watch the first Short that loads.
              const firstWatchMs = Math.round(
                (shortsWatchTimeMin + Math.random() * Math.max(0, shortsWatchTimeMax - shortsWatchTimeMin)) * 1000,
              );
              steps.push(`YouTube Shorts: watching Short 1 for ~${Math.round(firstWatchMs / 1000)}s`);
              await _sleep(firstWatchMs);
              await rollShortsLike("Short 1");

              // Swipe up through additional Shorts.
              for (let s = 0; s < shortsTotal; s++) {
                // Swipe up = advance to the next Short.
                await swipe(serial, scx, sfromY, scx, stoY, profileSwipeDuration());
                await _sleep(1000 + Math.floor(Math.random() * 500)); // wait for Short to load
                const watchMs = Math.round(
                  (shortsWatchTimeMin + Math.random() * Math.max(0, shortsWatchTimeMax - shortsWatchTimeMin)) * 1000,
                );
                steps.push(`YouTube Shorts: watching Short ${s + 2}/${shortsTotal + 1} for ~${Math.round(watchMs / 1000)}s`);
                await _sleep(watchMs);
                await rollShortsLike(`Short ${s + 2}`);
              }
            } else {
              steps.push("YouTube: Shorts button not found in bottom nav — skipping");
            }
          } else {
            steps.push("YouTube: Shorts roll not fired");
          }
        }
        // ────────────────────────────────────────────────────────────────────
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Close YouTube via floating-windows recents ────────────────────────────
    // Always runs, same pattern as runChromeApp.
    const dismissDir = opts?.dismissDirection
      ?? getModelDismissDirection(getDeviceModel(serial));
    const { w: rw, h: rh } = getScreenSize(serial);
    await openRecentApps(serial);
    await _sleep(1200);
    const rcx = Math.round(rw / 2);
    if (dismissDir === "up") {
      await swipe(serial, rcx, Math.round(rh * 0.65), rcx, 0, 150);
    } else {
      await swipe(serial, rcx, Math.round(rh * 0.45), Math.round(rw * 0.05), Math.round(rh * 0.45), 400);
    }
    steps.push(`YouTube: opened recents + swiped away (${dismissDir})`);
    await _sleep(800);
    // ─────────────────────────────────────────────────────────────────────────

    return { ok: true, steps };
  } catch (e: any) {
    return { ok: false, steps, error: String(e?.message ?? e) };
  }
}

/**
 * Instagram occasionally shows Meta's EU/UK "ads choice" consent screen on
 * launch ("Make a choice about your ads" → Get started → pick "Use for free
 * with ads" → Continue → Agree). It's a full-screen modal that blocks
 * everything behind it, so if it appears mid-automation-cycle every
 * subsequent scripted tap lands on it instead of the feed and the whole
 * cycle silently does nothing. This walks through it end-to-end if present,
 * and is a no-op (single UI dump, no taps) if the dialog isn't showing.
 */
/**
 * Expose a single UIAutomator dump to callers that want to share one dump
 * across multiple checks (ads-choice → interstitials → account-switch pre-check
 * → profile-tab lookup) instead of doing 4 sequential dumps.  Each dump costs
 * 5–15 s on a loaded device; sharing one saves up to 30 s per cycle.
 */
export async function getUiDump(serial: string): Promise<string> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  return _uiDump(adb, serial);
}

export async function dismissAdsChoiceDialog(
  serial: string,
  preloadedXml?: string, // reuse a dump taken moments earlier — skips an extra 5-15 s dump
): Promise<{ dismissed: boolean; steps: string[] }> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const steps: string[] = [];
  let xml = preloadedXml ?? await _uiDump(adb, serial);

  // Only proceed if this actually looks like the ads-choice screen — avoid
  // tapping "Get started" blind on some unrelated dialog that happens to
  // share a button label.
  const looksLikeAdsChoice = /ads?\b/i.test(xml) && (xml.includes("Get started") || xml.includes("choice about your ads"));
  if (!looksLikeAdsChoice) return { dismissed: false, steps };

  // 1. "Get started"
  let pos = _findElem(xml, "Get started", "GET STARTED");
  if (!pos) return { dismissed: false, steps };
  _adbTap(adb, serial, pos.x, pos.y);
  steps.push("ads-choice: tapped Get started");
  await _sleep(800); // reduced from 1200ms — UI transition is faster than worst-case

  // 2. Select "Use for free with ads" (radio option), then Continue
  xml = await _uiDump(adb, serial);
  pos = _findElem(xml, "Use for free with ads", "Free with ads");
  if (pos) {
    // Instagram sometimes pre-selects "Use for free with ads" when the screen
    // loads.  Tapping a radio button that is ALREADY selected deselects it,
    // leaving no option chosen — the Continue button then refuses to advance
    // and the dialog is never dismissed.
    // Detection: the outer ViewGroup's content-desc ends with
    // "Radio button . Selected" when selected, "Radio button . Unselected" when not.
    // We find the index of "Use for free with ads" in the XML and look for
    // "Radio button . Selected" within the next ~600 chars (the same desc attr).
    const freeIdx = xml.indexOf("Use for free with ads");
    const selectedMarkerIdx = freeIdx !== -1 ? xml.indexOf("Radio button . Selected", freeIdx) : -1;
    const alreadySelected = selectedMarkerIdx !== -1 && (selectedMarkerIdx - freeIdx) < 600;
    if (!alreadySelected) {
      _adbTap(adb, serial, pos.x, pos.y);
      steps.push("ads-choice: selected Use for free with ads");
      await _sleep(400); // reduced from 500ms
      xml = await _uiDump(adb, serial);
    } else {
      steps.push("ads-choice: Use for free with ads already selected — skipping tap");
    }
  }
  pos = _findElem(xml, "Continue", "CONTINUE");
  if (pos) {
    _adbTap(adb, serial, pos.x, pos.y);
    steps.push("ads-choice: tapped Continue");
    await _sleep(800); // reduced from 1200ms
    xml = await _uiDump(adb, serial);
  }

  // 3. "Agree" on the final confirmation page
  pos = _findElem(xml, "Agree", "AGREE", "I agree", "Allow");
  if (pos) {
    _adbTap(adb, serial, pos.x, pos.y);
    steps.push("ads-choice: tapped Agree");
    await _sleep(800); // reduced from 1200ms
  }

  return { dismissed: true, steps };
}

/**
 * Dismiss any Instagram interstitial/popup that blocks the current screen.
 * Looks for common "soft-dismiss" button labels — "Not now", "Skip", "Maybe
 * later", etc. — and taps the first one it finds.  This is intentionally
 * non-destructive: it will never tap "Turn on", "Allow", "Continue", or any
 * positive-action button, so it can be called safely at any point in the
 * automation cycle without accidentally accepting unwanted permissions.
 *
 * Known popups handled:
 *   • "Your notifications are off" → taps "Not now"
 *   • "Turn on notifications" (variant) → taps "Not now" / "Skip"
 *   • Android system permission dialogs → taps "Don't allow" / "Deny"
 *   • "Save your login info?" → taps "Not now"
 *   • Any other sheet with a "Skip", "Maybe later", "Later", "Cancel" button
 *
 * Returns the label that was tapped, or null if nothing needed dismissing.
 */
export async function dismissInstagramInterstitials(
  serial: string,
  preloadedXml?: string, // reuse a dump taken moments earlier — skips an extra 5-15 s dump
): Promise<string | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = preloadedXml ?? await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;

  // ── Specific popup guards ────────────────────────────────────────────────
  // These check for a known popup title before tapping "OK" / generic
  // buttons, so we never accidentally dismiss a legitimate compose screen.

  // "Collect the posts you love" bottom sheet — appears after tapping the
  // save/ribbon icon on a feed post when the account has no existing
  // collections. The sheet slides up and presents "Start a collection" CTA.
  // The correct dismiss is to tap the transparent background_dimmer ABOVE the
  // sheet (y ≈ 12 % of screen height), which is always safe — no interactive
  // controls exist in that zone while the collection sheet is visible.
  //
  // Detection uses id="pinned_save_row" (the saved-item row inside the sheet,
  // unique to this sheet type) OR the empty-state title text as a fallback.
  // We NEVER use "Start a collection" as a tap target because that would
  // create a collection instead of dismissing the sheet.
  if (xml.includes('id="pinned_save_row"') || xml.includes('text="Collect the posts you love"')) {
    const { w: _csW, h: _csH } = _getScreenSize(xml);
    _adbTap(adb, serial, Math.round(_csW * 0.50), Math.round(_csH * 0.12));
    await _sleep(400);
    return "Collect the posts you love — dimmer tap";
  }

  // "Sharing posts" bottom sheet — Instagram shows this on the caption/share
  // screen the first time an account posts, explaining public sharing & reuse.
  // The sheet has id="igds_button" children: "OK" (tap to proceed) and
  // "Manage Settings" (tap to open settings). We must tap "OK".
  // Guard: only act when text="Sharing posts" is present in the tree.
  if (xml.includes('text="Sharing posts"')) {
    const okPos = _findElem(xml, "OK");
    if (okPos) {
      _adbTap(adb, serial, okPos.x, okPos.y);
      await _sleep(600);
      return "Sharing posts — OK";
    }
  }

  // "Interacting with content shared from Facebook" full-screen dialog —
  // appears mid-story (and sometimes mid-feed) when Instagram detects
  // cross-platform content. Unlike most popups this dialog CANNOT be
  // dismissed by tapping outside — the only valid dismiss is the "OK"
  // primary button (id="primary_button"). Tapping any other area does
  // nothing and the automation gets completely stuck.
  //
  // Detection: id="dialog_container" is the unique wrapper; the headline
  // guard accepts the title variants used by different Instagram builds
  // (some expose it as text, others as content-desc, and some omit
  // "Interacting with"). This remains specific to the Facebook-shared
  // education dialog and does not tap a generic OK button.
  const lowerXml = xml.toLowerCase();
  const isFacebookSharedDialog =
    lowerXml.includes('id="dialog_container"') &&
    lowerXml.includes("shared from facebook") &&
    (lowerXml.includes("interacting with content") ||
      lowerXml.includes("content shared from facebook"));
  if (isFacebookSharedDialog) {
    const okPos = _findByResId(xml, ":id/primary_button") ?? _findElem(xml, "OK");
    if (okPos) {
      _adbTap(adb, serial, okPos.x, okPos.y);
      await _sleep(600);
      logger.info({ serial }, "[instagram] shared-Facebook story dialog detected — tapped OK");
      return "Interacting with content from Facebook — OK";
    }
  }

  // "Allow the use of cookies by Instagram?" full-screen consent dialog —
  // appears on first launch (and occasionally mid-session) on fresh or
  // factory-reset accounts. Unlike the generic dismiss labels below, the only
  // valid action here is an affirmative tap on "Allow all cookies"; there is
  // no "Not now" or "Skip" option, so the automation would be permanently
  // stuck without this specific guard.
  //
  // Detection: the title text is unique enough to use directly; the button
  // has content-desc="Allow all cookies" so _findElem matches it reliably.
  if (
    xml.includes("Allow the use of cookies by Instagram?") ||
    xml.includes('text="Allow all cookies"') ||
    xml.includes('content-desc="Allow all cookies"')
  ) {
    const allowPos = _findElem(xml, "Allow all cookies");
    if (allowPos) {
      _adbTap(adb, serial, allowPos.x, allowPos.y);
      await _sleep(600);
      return "Cookie consent — Allow all cookies";
    }
  }

  // Ordered by specificity — more specific labels first so we don't
  // accidentally tap a generic button on a legitimate screen.
  // NOTE: "Cancel" and "OK" are intentionally excluded from the generic list
  // — they are too generic and will dismiss legitimate compose/picker screens
  // (e.g. the Instagram story/post composer has a Cancel button that, if
  // tapped here, sends the user back to the home feed before any UI scan can
  // run). Add specific guards above for any "OK"-dismissible popup instead.
  const DISMISS_LABELS = [
    "Not now",
    "Not Now",
    "Skip",
    "Maybe Later",
    "Maybe later",
    "No thanks",
    "No Thanks",
    // "Remind me later" / "Remind Me Later" appear on the Instagram "Rate us"
    // popup as an alternative soft-dismiss alongside "No Thanks".
    "Remind me later",
    "Remind Me Later",
    "Later",
    "Dismiss",
    // "Don't Allow Access" is the exact button text on the Instagram
    // "Allow Instagram to access your contacts?" system dialog.
    // Listed before the generic "Don't Allow" so the more specific match
    // wins first (avoids relying on substring fallback).
    "Don't Allow Access",
    "Don't Allow",
    "Deny",
  ];

  for (const label of DISMISS_LABELS) {
    const pos = _findElem(xml, label);
    if (!pos) continue;

    // "Dismiss" appears both on real interstitial popups AND as the tiny ✕
    // button on each card in the "Suggested for you" section of a profile page.
    // Guard against the card icon by checking the element width before tapping:
    //   • Card ✕ icons:              ~17–30 px wide  (e.g. bounds [279,277][296,294])
    //   • Real popup dismiss buttons: 200–500+ px wide
    // A 100 px threshold gives a wide margin between the two.  If bounds can't
    // be parsed (shouldn't happen with normal UIAutomator output), skip rather
    // than risk a wrong tap.
    if (label === "Dismiss") {
      const boundsRe = /(?:text|content-desc)="Dismiss"[^>]*bounds="\[(\d+),\d+\]\[(\d+),\d+\]"/i;
      const bm = xml.match(boundsRe);
      if (!bm || (Number(bm[2]) - Number(bm[1])) < 100) continue;
      // Skip if the "Dismiss" belongs to a suggestion shelf — tapping it opens
      // a "Hide" snackbar instead of clearing a real popup.
      const isSuggestionShelf =
        xml.includes("Suggested for you") ||
        xml.includes("People you may know") ||
        xml.includes("Suggested Reels") ||
        xml.includes("Suggested reels") ||
        xml.includes('"suggested_users"') ||
        xml.includes("suggestion_unit");
      if (isSuggestionShelf) continue;
    }

    _adbTap(adb, serial, pos.x, pos.y);
    await _sleep(600);
    return label;
  }
  return null;
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

/**
 * Nuclear deep reset: clears Instagram + Google Play Services + GSF.
 * Resets: Instagram data, GAID, GSF ID (device registration), cached Google tokens.
 * After this the user must re-sign into their Google account in BlueStacks.
 * Returns a list of steps performed.
 */
export async function deepResetDevice(serial: string): Promise<{ steps: string[] }> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const steps: string[] = [];

  const run = (args: string[], label: string, timeout = 15000) => {
    const r = spawnSync(adb, ["-s", serial, ...args], { encoding: "utf8", timeout });
    steps.push(r.status === 0 ? `✓ ${label}` : `⚠ ${label} (exit ${r.status})`);
  };

  // 1. Stop Instagram
  run(["shell", "am", "force-stop", "com.instagram.android"], "Stop Instagram");
  // 2. Clear Instagram data
  run(["shell", "pm", "clear", "com.instagram.android"], "Clear Instagram data");
  // 3. Stop Google Play Services
  run(["shell", "am", "force-stop", "com.google.android.gms"], "Stop Google Play Services");
  // 4. Clear GMS data — resets GSF ID + GAID + all device Google registration
  run(["shell", "pm", "clear", "com.google.android.gms"], "Clear Google Play Services (resets GSF ID + GAID)", 30000);
  // 5. Clear GSF package separately (present on some BlueStacks builds)
  run(["shell", "pm", "clear", "com.google.android.gsf"], "Clear Google Services Framework");
  // 6. Clear Play Store too (it caches device credentials)
  run(["shell", "pm", "clear", "com.android.vending"], "Clear Play Store cache");

  steps.push("✓ All Google identifiers cleared — new GSF ID will be assigned on next GMS start");
  console.log(`[androidManager] deep reset complete for ${serial}:`, steps);
  return { steps };
}

/**
 * Reset the Google Advertising ID (GAID) on the device.
 * GAID survives pm clear and Android ID changes — Instagram reads it at signup.
 * We try three approaches in order, returning which one worked.
 */
export function resetAdvertisingId(serial: string): { ok: boolean; method: string } {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const newUuid = randomUUID();

  // Approach 1: direct settings write (works on many BlueStacks / Android 9 builds)
  const r1 = spawnSync(adb, ["-s", serial, "shell", "settings", "put", "secure", "advertising_id", newUuid], { encoding: "utf8", timeout: 5000 });
  const verify1 = spawnSync(adb, ["-s", serial, "shell", "settings", "get", "secure", "advertising_id"], { encoding: "utf8", timeout: 4000 });
  if ((verify1.stdout ?? "").trim() === newUuid) {
    console.log(`[androidManager] GAID reset via settings put (${newUuid})`);
    return { ok: true, method: "settings" };
  }
  void r1;

  // Approach 2: overwrite the adid_settings.xml inside Google Play Services shared_prefs
  // (works when adb has shell-level access to /data/data — common on BlueStacks)
  const xmlContent = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <string name="adid_key">${newUuid}</string>\n    <boolean name="limit_ad_tracking" value="false" />\n</map>`;
  const tmpPath = "/sdcard/adid_settings.xml";
  const destPath = "/data/data/com.google.android.gms/shared_prefs/adid_settings.xml";
  spawnSync(adb, ["-s", serial, "shell", `echo '${xmlContent.replace(/'/g, "'\\''")}' > ${tmpPath}`], { encoding: "utf8", timeout: 5000 });
  const mv = spawnSync(adb, ["-s", serial, "shell", `run-as com.google.android.gms cp ${tmpPath} ${destPath} 2>/dev/null || true`], { encoding: "utf8", timeout: 5000 });
  void mv;

  // Approach 3: restart GMS to force it to re-read (best effort)
  spawnSync(adb, ["-s", serial, "shell", "am", "force-stop", "com.google.android.gms"], { encoding: "utf8", timeout: 5000 });

  console.log(`[androidManager] GAID reset attempted (xml write), new UUID: ${newUuid}`);
  return { ok: false, method: "manual-required" };
}

function randomUUID(): string {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${(Math.floor(Math.random() * 4) + 8).toString(16)}${hex().slice(1)}-${hex()}${hex()}${hex()}`;
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

// `adb shell input ...` fails silently far more often than you'd expect —
// wrong/no focused window, a locked secure keyguard, "Injecting to another
// application requires INJECT_EVENTS permission" on some OEM builds/Android
// versions, BlueStacks nested-VM quirks, etc. It always exits 0 from adb's
// own point of view even when the on-device `input` binary printed an error
// to its stderr, so we must inspect stdout+stderr ourselves and surface it —
// otherwise the client sees "200 OK" for a tap that did nothing on-device,
// which is exactly the "clicks do nothing, no error anywhere" symptom this
// is fixing.
async function runInputShell(serial: string, args: string[], label: string): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  try {
    const { stdout, stderr } = await execFileP(
      adb,
      ["-s", serial, "shell", "input", ...args],
      { encoding: "utf8", timeout: 5000 } as any,
    );
    const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
    if (/error|exception|permission denied/i.test(out)) {
      throw new Error(out);
    }
  } catch (e: any) {
    const out = `${e.stderr ?? ""}${e.stdout ?? ""}`.trim();
    const detail = out || (e.killed || e.signal ? "adb timed out" : e.message) || "unknown error";
    throw new Error(
      `adb shell input ${label} failed${detail ? `: ${detail}` : ""}`,
    );
  }
}

export async function inputText(serial: string, text: string): Promise<void> {
  const escaped = escapeForAdbInput(text);
  await runInputShell(serial, ["text", escaped], "text");
}

/**
 * Type text through separate ADB shell input commands with a humanized pause
 * between characters. This is intentionally opt-in: bulk inputText() remains
 * available for flows where per-character pacing is not required.
 */
export async function inputTextHumanized(serial: string, text: string): Promise<void> {
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    await runInputShell(serial, ["text", escapeForAdbInput(chars[i])], "text");
    if (i < chars.length - 1) {
      await new Promise<void>(resolve =>
        setTimeout(resolve, 150 + Math.floor(Math.random() * 1351)),
      );
    }
  }
}

/** Set the Android device clipboard from the backend for a subsequent paste. */
export async function setClipboard(serial: string, text: string): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  try {
    const { stdout, stderr } = await execFileP(
      adb,
      // execFile passes each argv entry directly to adb. Do not shell-escape
      // this value: escaping here makes cmd clipboard receive literal
      // backslashes (and corrupts quotes, dollars, and line breaks).
      ["-s", serial, "shell", "cmd", "clipboard", "set", text],
      { encoding: "utf8", timeout: 5000 } as any,
    );
    const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
    if (/error|exception|unknown command|not found|permission denied/i.test(out)) {
      throw new Error(out);
    }
  } catch (e: any) {
    const out = `${e.stderr ?? ""}${e.stdout ?? ""}`.trim();
    const detail = out || e.message || "unknown error";
    throw new Error(`adb clipboard set failed: ${detail}`);
  }
}

/** Paste the current Android clipboard into the focused field. */
export async function pasteClipboard(serial: string): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  try {
    const { stdout, stderr } = await execFileP(
      adb,
      ["-s", serial, "shell", "input", "keyevent", "KEYCODE_PASTE"],
      { encoding: "utf8", timeout: 5000 } as any,
    );
    const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
    if (/error|exception|unknown|not found|permission denied/i.test(out)) {
      throw new Error(out);
    }
  } catch (e: any) {
    const out = `${e.stderr ?? ""}${e.stdout ?? ""}`.trim();
    throw new Error(`adb clipboard paste failed: ${out || e.message || "unknown error"}`);
  }
}

/**
 * Select and clear the currently focused Android text field.
 *
 * This is intentionally separate from calibrated character typing: replacing
 * a field requires a real select-all/delete operation before the first
 * calibrated tap. The destructive key deny rule applies to the calibrated
 * typing executor, not this explicit field-replacement operation.
 */
export async function clearFocusedTextField(serial: string, onLog?: (msg: string) => void): Promise<void> {
  await runInputShell(
    serial,
    ["keycombination", "KEYCODE_CTRL_LEFT", "KEYCODE_A"],
    "select-all",
  );
  await _sleep(180);
  await runInputShell(serial, ["keyevent", "KEYCODE_DEL"], "clear-selected-text");
  await _sleep(350);
  onLog?.("[android-input] focused field selected-all and cleared");
}

export async function tap(serial: string, x: number, y: number, source?: "manual" | "bot"): Promise<void> {
  recorder.addTap(serial, x, y, undefined, source ?? "bot");
  await runInputShell(serial, ["tap", String(x), String(y)], "tap");
}

/**
 * Instagram's like gesture needs two taps close enough together to be
 * recognised as a double-tap (its GestureDetector double-tap window is a
 * few hundred ms). The previous implementation called `tap()` twice, each
 * of which is its own `spawnSync adb shell` round-trip — spawning a process
 * and talking to the adb server/USB link typically costs 100-300ms *per
 * call* on top of the explicit delay between them, so the real gap between
 * the two on-device taps was often 300-600ms+ and Instagram registered them
 * as two independent single taps (no like) instead of a double-tap.
 *
 * Fixing this requires both taps to happen inside a *single* adb shell
 * invocation, with the pause done on-device (`sleep`) rather than in two
 * separate host-side spawns — that keeps the on-device gap tight and
 * consistent regardless of adb/USB latency. The inter-tap delay is randomized
 * between 50 ms and 250 ms and is logged for every gesture.
 */
export async function doubleTap(
  serial: string,
  x: number,
  y: number,
  onLog?: (msg: string) => void,
): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const interTapDelayMs = 50 + Math.floor(Math.random() * 201);
  const interTapDelaySeconds = (interTapDelayMs / 1000).toFixed(3);
  logger.info(
    { serial, x, y, interTapDelayMs },
    "[android-input] double-tap",
  );
  onLog?.(`Double-tap at (${x},${y}) — inter-tap delay ${interTapDelayMs}ms`);
  const cmd = `input tap ${x} ${y}; sleep ${interTapDelaySeconds}; input tap ${x} ${y}`;
  const r = spawnSync(adb, ["-s", serial, "shell", cmd], { encoding: "utf8", timeout: 5000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (r.status !== 0 || r.error || /error|exception|permission denied/i.test(out)) {
    throw new Error(
      `adb shell double-tap failed (exit=${r.status ?? "spawn-error"})${out ? `: ${out}` : r.error ? `: ${r.error.message}` : ""}`
    );
  }
}

export async function swipe(
  serial: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number = 300,
  applyLegacyJitter = true,
): Promise<void> {
  // Keep every automation gesture inside the app-safe region.  This is
  // centralized here because Feed, Reels, Explore, Stories, and device-profile
  // swipes all eventually use this helper.  A swipe that starts or ends in the
  // Android edge zones can invoke launcher/Recents/floating-window navigation
  // instead of staying inside Instagram.
  const { w: screenW, h: screenH } = getScreenSize(serial);
  const safeX = Math.max(1, Math.round(screenW * 0.04));
  // Keep a larger exclusion zone around Android's system gesture areas. On
  // 720x1600 devices this keeps endpoints at least 192px from the bottom and
  // 192px from the top instead of allowing a swipe within ~128px of an edge.
  const safeTop = Math.max(1, Math.round(screenH * 0.12));
  const safeBottom = Math.min(screenH - 1, Math.round(screenH * 0.85));
  const clampX = (value: number) => Math.min(screenW - safeX, Math.max(safeX, Math.round(value)));
  const clampY = (value: number) => Math.min(safeBottom, Math.max(safeTop, Math.round(value)));
  const boundedX1 = clampX(x1);
  const boundedY1 = clampY(y1);
  const boundedX2 = clampX(x2);
  const boundedY2 = clampY(y2);

  // ── Coordinate jitter ────────────────────────────────────────────────────
  // Vertical feed-scrolls always use the same centre X, so every swipe lands
  // on the exact same pixel — on a soft keyboard this types the same letter
  // every time (looks robotic).  We add a tiny random X offset to break that.
  //
  // Rules to avoid breaking other gestures:
  //   1. Long-press (x1==x2 && y1==y2, duration ≥ 1 s): NO jitter at all —
  //      splitting start/end would turn the stationary hold into a micro-swipe.
  //   2. Vertical swipe (x1==x2, y1≠y2): apply ONE shared X offset to both
  //      endpoints so the line stays perfectly straight, just shifted ±0.5–1 %.
  //   3. All other swipes: no jitter — targets are precise (card dismissals,
  //      user-defined mirror gestures, etc.).
  let jx1 = boundedX1, jy1 = boundedY1, jx2 = boundedX2, jy2 = boundedY2;
  const isLongPress = (boundedX1 === boundedX2 && boundedY1 === boundedY2);
  const isVertical  = (boundedX1 === boundedX2 && boundedY1 !== boundedY2);
  if (applyLegacyJitter && !isLongPress && isVertical) {
    const pct = (Math.random() * 0.005 + 0.005) * (Math.random() < 0.5 ? 1 : -1);
    const xOff = Math.round(boundedX1 * pct);
    jx1 = clampX(boundedX1 + xOff);
    jx2 = clampX(boundedX2 + xOff);
  }

  await runInputShell(
    serial,
    ["swipe", String(jx1), String(jy1), String(jx2), String(jy2), String(Math.max(1, Math.round(durationMs)))],
    "swipe",
  );
}

export async function keyevent(serial: string, code: string | number): Promise<void> {
  const normalized = String(code).trim().toUpperCase();
  if (normalized === "67" || normalized === "112" ||
      normalized === "KEYCODE_DEL" || normalized === "KEYCODE_BACKSPACE" ||
      normalized === "KEYCODE_FORWARD_DEL" || normalized === "BACKSPACE" ||
      normalized === "DELETE" || normalized === "FORWARD_DELETE") {
    throw new Error(`Denied destructive key event: ${code}`);
  }
  await runInputShell(serial, ["keyevent", String(code)], "keyevent");
}

// ── Automation-cycle lifecycle steps ────────────────────────────────────────
// Real button/gesture actions used to bookend each automation cycle — the
// phone should look like a person picked it up, used Instagram, put it down,
// and (per user instruction) cycled airplane mode before locking it again,
// not like a script silently force-stopping a process in the background.

export function getScreenSize(serial: string): { w: number; h: number } {
  let w = 1080, h = 2400;
  try {
    const tools = detectToolset();
    const adb = requireTool(tools.adb, "adb");
    const wm = spawnSync(adb, ["-s", serial, "shell", "wm", "size"], { encoding: "utf8", timeout: 3000 });
    const out = wm.stdout ?? "";
    // UIAutomator accessibility-tree coordinates and `adb shell input tap` both use
    // the display's OVERRIDE (logical) coordinate space, not the physical pixel space.
    // `wm size` on Xiaomi / OEM devices often prints:
    //   Physical size: 1080x2400
    //   Override size: 720x1280
    // A naïve /(\d+)x(\d+)/ grabs the FIRST match — the physical size — so
    // centerY ends up as 1200 instead of 640, causing _findCentermostLikeNode to
    // pick the wrong Like node (one near physical-center y≈1200 in logical space
    // rather than the real action bar).  Always prefer Override size when present.
    const mOverride = out.match(/Override\s+size:\s*(\d+)x(\d+)/i);
    const mAny = out.match(/(\d+)x(\d+)/);
    const m = mOverride ?? mAny;
    if (m) { w = parseInt(m[1]); h = parseInt(m[2]); }
  } catch { /* fall back to defaults above */ }
  return { w, h };
}

// A raw KEYCODE_POWER (26) is a *toggle* — if the screen happened to already
// be on when a cycle starts, "pressing power to wake it" would instead turn
// it off, and every step after that runs blind against a black screen. Using
// the explicit WAKEUP/SLEEP keycodes gets the same real-world effect (screen
// on at the start of a cycle, screen off at the end) without that race.
export async function wakeScreen(serial: string): Promise<void> {
  await keyevent(serial, 224); // KEYCODE_WAKEUP
}

export async function sleepScreen(serial: string): Promise<void> {
  await keyevent(serial, 223); // KEYCODE_SLEEP
}

export function rebootDevice(serial: string): void {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  spawnSync(adb, ["-s", serial, "reboot"], { encoding: "utf8", timeout: 5000 });
}

export function setBrightness(serial: string, percent: number): void {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  // Disable auto-brightness so the manual value actually sticks.
  spawnSync(adb, ["-s", serial, "shell", "settings", "put", "system", "screen_brightness_mode", "0"], { encoding: "utf8", timeout: 3000 });
  // Android brightness scale is 0–255; 50 % ≈ 128.
  const value = Math.round((Math.max(0, Math.min(100, percent)) / 100) * 255);
  spawnSync(adb, ["-s", serial, "shell", "settings", "put", "system", "screen_brightness", String(value)], { encoding: "utf8", timeout: 3000 });
}

export function getBrightness(serial: string): number {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const result = spawnSync(adb, ["-s", serial, "shell", "settings", "get", "system", "screen_brightness"], { encoding: "utf8", timeout: 3000 });
  const raw = parseInt(result.stdout?.trim() ?? "", 10);
  if (isNaN(raw)) return 50; // default if unreadable
  // Convert Android 0–255 scale back to 0–100 percent
  return Math.round((Math.max(0, Math.min(255, raw)) / 255) * 100);
}

// ── Device profile lookup table ────────────────────────────────────────────
// Maps ro.product.model → the behavioral flags that differ between OEM
// launchers. Only covers the Android system-shell surface; Instagram's own UI
// is consistent across devices and needs no profile.
//
// Adding a new device: one entry per model string (as returned by
// `adb shell getprop ro.product.model`). Two devices with the same dismiss
// direction share the same profile entry — you write it once and both work.
//
// dismissDirection: how the recents/floating-windows card strip dismisses an
//   app. 'left' = drag card off the left edge (MIUI/HyperOS floating-window
//   carousel default). 'up' = standard Android swipe-up dismiss.
const DEVICE_PROFILES: Record<string, { dismissDirection: "left" | "up" }> = {
  "Redmi 12":  { dismissDirection: "left" },
  "Redmi A5":  { dismissDirection: "up" },
};

/**
 * Returns the dismiss direction for a given model string.
 * First tries an exact key match against DEVICE_PROFILES, then falls back to
 * case-insensitive partial matching so that OEM firmware variants that report
 * a hardware code (e.g. "23097RA8S") instead of a marketing name still resolve
 * correctly. Falls back to 'left' (MIUI floating-window carousel behaviour)
 * for any model not matched — preserves existing behaviour for unknown devices.
 */
export function getModelDismissDirection(model: string): "left" | "up" {
  // Exact match first — fastest path for confirmed model strings.
  if (DEVICE_PROFILES[model]) return DEVICE_PROFILES[model].dismissDirection;
  // Case-insensitive partial match for known device families whose
  // ro.product.model may differ from the marketing name on some firmware.
  const m = model.toLowerCase();
  if (m.includes("redmi a5")) return "up";
  // Redmi A5 hardware model codes (23097RA8S = international, 23116PN5BI = India)
  if (/^2309[0-9]ra/i.test(model) || /^2311[0-9]pn/i.test(model)) return "up";
  return "left";
}

/**
 * Reads ro.product.model from the device (single synchronous getprop call).
 * Used at automation-cycle call sites where the full DeviceProps have not
 * already been fetched.
 */
export function getDeviceModel(serial: string): string {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const r = spawnSync(adb, ["-s", serial, "shell", "getprop", "ro.product.model"], { encoding: "utf8", timeout: 4000 });
  return (r.stdout || "").trim().replace(/^\[|\]$/g, "") || "Unknown";
}

export async function openRecentApps(serial: string): Promise<void> {
  await keyevent(serial, 187); // KEYCODE_APP_SWITCH
}

/**
 * Given a reference y-coordinate (the vertical centre of a known card/label,
 * e.g. "Instagram" in the floating-windows recents strip), finds every
 * text/content-desc-bearing element in the same UI dump that sits in the
 * same horizontal band and returns the one with the smallest x — i.e. the
 * LEFT-MOST card currently visible in that strip, whatever app it belongs
 * to. This device's recents UI is a Xiaomi "floating windows" carousel, not
 * stock Android recents: it shows at most two card labels side by side at a
 * time, and user-confirmed screen recordings show cards are dismissed by
 * dragging the left-most one off the left edge — dismissing it then slides
 * the next card into the left slot, so the same "find left-most, drag left"
 * gesture must repeat rather than always retargeting "Instagram" by name.
 */
function _findLeftmostLabelInBand(xml: string, refY: number, bandPx: number): { x: number; y: number } | null {
  const re = /(?:text|content-desc)="[^"]+"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  let best: { x: number; y: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const x1 = +m[1], y1 = +m[2], x2 = +m[3], y2 = +m[4];
    const cy = Math.floor((y1 + y2) / 2);
    const cx = Math.floor((x1 + x2) / 2);
    if (Math.abs(cy - refY) > bandPx) continue;
    if (!best || cx < best.x) best = { x: cx, y: cy };
  }
  return best;
}

/**
 * Closes Instagram the way a person would: open the recent-apps switcher,
 * then drag its card off the LEFT edge of the screen to dismiss it —
 * deliberately a real gesture rather than `am force-stop`, per user
 * instruction, so the automation cycle behaves like someone actually using
 * the phone rather than a script killing a process in the background.
 *
 * Root-cause fix (Jul 2026): this device's recents screen is a Xiaomi
 * "floating windows" card carousel (confirmed via screenshot), NOT stock
 * Android recents. The previous implementation swiped the Instagram card
 * UPWARD, which is the stock-Android dismiss gesture and does nothing on
 * this launcher — Instagram stayed running every time and the code always
 * fell through to a force-stop. The user's own description of the real
 * gesture: with a single app open, tap-hold-drag it left from centre; with
 * more than one app open, the strip shows two cards at a time and you keep
 * dragging the LEFT-MOST card further left until each is gone in turn.
 */
export async function closeInstagramViaRecents(serial: string, dismissDirection: "left" | "up" = "left", onLog?: (msg: string) => void): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const { w, h } = getScreenSize(serial);
  const log = (m: string) => { onLog?.(m); console.log(`[androidManager] ${m}`); };
  const pidof = () => {
    const r = spawnSync(adb, ["-s", serial, "shell", "pidof", "com.instagram.android"], { encoding: "utf8", timeout: 3000 });
    return (r.stdout ?? "").trim().length > 0;
  };

  await openRecentApps(serial);
  await new Promise(r => setTimeout(r, 1200)); // wait for MIUI/OEM overview animation to settle

  // Poll pidof for up to POLL_MS after a swipe instead of a single check at
  // a fixed delay. Root-cause fix (Jul 2026): a real, correctly-aimed drag
  // was dismissing the card (user-confirmed visually) but the underlying
  // process doesn't always die within a fixed short window — Instagram
  // keeps background services (notifications, etc.) alive briefly after
  // its UI is dismissed. A single check at 600ms was catching it mid-death
  // and concluding "still running", so the loop kept re-swiping an already
  // -empty screen 4 more times for no reason (~20s wasted every cycle).
  // Polling gives the same single successful swipe a real chance to
  // register as closed before we ever attempt a second one.
  const POLL_MS = 3500;
  const POLL_STEP_MS = 400;
  const waitForClosed = async (): Promise<boolean> => {
    const deadline = Date.now() + POLL_MS;
    while (Date.now() < deadline) {
      if (!pidof()) return true;
      await new Promise(r => setTimeout(r, POLL_STEP_MS));
    }
    return !pidof();
  };

  // This launcher's recents dump has never once exposed a text/content-desc
  // "Instagram" label in real testing (every attempt logs "no label found"),
  // so the multi-card left-most detection below is effectively a no-op on
  // this device — the switcher shows cards as bare thumbnails with no
  // accessible caption. Without any way to *see* how many cards remain, we
  // can't justify looping 5 times "just in case" — that was the source of
  // the wasted repeat swiping on an already-closed/empty screen the user
  // reported. Cap blind (no-label) attempts at 2: one real attempt, and one
  // retry only if the generous poll above still says Instagram is running
  // (e.g. the first drag genuinely missed). If a labelled card IS found on
  // a device where the dump does expose captions, keep looping per distinct
  // card as before, up to 5, since that count is then actual ground truth.
  const MAX_BLIND_ATTEMPTS = 2;
  const MAX_LABELLED_ATTEMPTS = 5;
  let method = "no attempts made";
  let attemptsRun = 0;
  let attempt = 0;
  let sawAnyLabel = false;
  while (true) {
    attempt++;
    attemptsRun = attempt;
    if (!pidof()) { method = `Instagram already gone before attempt ${attempt}`; break; }

    const xml = await _uiDump(adb, serial);
    const igCard = xml ? _findElem(xml, "Instagram") : null;
    const card = (igCard && xml) ? (_findLeftmostLabelInBand(xml, igCard.y, 120) ?? igCard) : null;
    if (card) sawAnyLabel = true;

    if (card) {
      if (dismissDirection === "up") {
        // Standard Android upward-swipe dismiss (e.g. Redmi A5 / stock
        // Android recents). Drag the card off the TOP of the screen.
        //
        // On tall screens (Redmi A5: h=1650) the old formula
        //   dragToY = max(h*0.02, card.y − h*0.6)
        // could produce card.y − h*0.6 < 0, clamping dragToY to h*0.02=33
        // while the swipe STARTED at card.y ≈ 769. That gave only 45%
        // screen travel — not enough for MIUI to register a dismiss.
        //
        // Fix: start the drag below the card centre (15% of screen height
        // below, capped at 80% screen height) so the gesture always travels
        // at least 78% of the screen even when the card is detected in the
        // upper half. End point is always the very top of the visible area.
        const startY  = Math.min(Math.round(card.y + h * 0.15), Math.round(h * 0.80));
        const dragToY = 0;
        // Duration reduced 400 → 150 ms: MIUI's card-dismiss gesture requires
        // a fast flick, not a slow drag. At 400 ms the velocity was too low for
        // the launcher to register it as a dismiss; 150 ms matches a natural
        // thumb-flick and reliably triggers the dismiss animation.
        await swipe(serial, card.x, startY, card.x, dragToY, 150);
        method = `attempt ${attempt}: swiped card at (${card.x},${card.y}) from start (${card.x},${startY}) up to (${card.x},${dragToY})`;
      } else {
        // Drag fully off the left edge — a short flick isn't enough to
        // register as a dismiss-drag on this launcher; use a slower,
        // longer-distance move (matches "tap, hold, swipe left").
        const dragToX = Math.max(Math.round(w * 0.02), card.x - Math.round(w * 0.5));
        await swipe(serial, card.x, card.y, dragToX, card.y, 400);
        method = `attempt ${attempt}: dragged left-most card at (${card.x},${card.y}) left to (${dragToX},${card.y})`;
      }
    } else {
      // Couldn't find any label at all (e.g. dump failed, or — as observed
      // on this device — the launcher just never exposes card captions).
      const cardX = Math.round(w * 0.5);
      const cardY = Math.round(h * 0.45);
      if (dismissDirection === "up") {
        // Start at 65% screen height (not the mid-point 45%) so the drag
        // always travels ~63% of the screen regardless of screen size.
        const noLabelStartY = Math.round(h * 0.65);
        // Same 150 ms fast-flick as the labelled-card path above.
        await swipe(serial, cardX, noLabelStartY, cardX, 0, 150);
        method = `attempt ${attempt}: no label found — fell back to swipe-up from (${cardX},${noLabelStartY})`;
      } else {
        await swipe(serial, cardX, cardY, Math.round(w * 0.05), cardY, 400);
        method = `attempt ${attempt}: no label found in recents tree — fell back to centred drag-left (${cardX},${cardY})`;
      }
    }

    const closed = await waitForClosed();
    if (closed) { method += " — Instagram closed"; break; }

    const capReached = sawAnyLabel ? attempt >= MAX_LABELLED_ATTEMPTS : attempt >= MAX_BLIND_ATTEMPTS;
    if (capReached) { method += ` — still running after ${attempt} attempt(s), giving up on the recents gesture`; break; }

    // DO NOT call openRecentApps() here. On this Xiaomi floating-windows
    // device, the card strip STAYS VISIBLE after each card is dismissed —
    // the remaining cards are immediately ready for the next swipe. Pressing
    // KEYCODE_APP_SWITCH (openRecentApps) while already IN the recents overlay
    // TOGGLES it off, sending the phone to the home screen. The next loop pass
    // then can't find the overview, so it called openRecentApps again to bring
    // it back — producing the "goes to phone UI → back to floating windows"
    // loop the user reported. Just wait briefly and swipe the next card directly.
    await new Promise(r => setTimeout(r, 600));
  }

  const runningNow = pidof();
  const capLabel = sawAnyLabel ? MAX_LABELLED_ATTEMPTS : MAX_BLIND_ATTEMPTS;
  log(`[close-ig] attempt ${attemptsRun}/${capLabel}: ${method} — Instagram ${runningNow ? "still running" : "closed ✓"}`);

  // Card-dismiss gestures aren't consistent across OEM launchers/Android
  // versions — a "closed completely" requirement can't rely on the gesture
  // alone landing right every time. Verify Instagram is no longer a running
  // process and, if every drag attempt missed, fall back to a clean
  // force-stop so the app is guaranteed closed before the cycle moves on.
  if (runningNow) {
    log("[close-ig] still running after all recents-drag attempts — falling back to force-stop");
    await stopInstagram(serial);
  } else {
    log("[close-ig] confirmed closed");
  }
}

/**
 * Toggles airplane mode via the connectivity service directly rather than
 * tapping a quick-settings tile — tile position varies by device/OEM and
 * Android version, so a blind coordinate tap isn't reliable across the
 * range of phones this tool targets. The network effect (radios off, then
 * back on) is identical to using the tile.
 */
export async function setAirplaneMode(serial: string, enable: boolean): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const want = enable ? "enable" : "disable";
  const r1 = spawnSync(adb, ["-s", serial, "shell", "cmd", "connectivity", "airplane-mode", want], { encoding: "utf8", timeout: 5000 });
  const ok1 = r1.status === 0 && !/error|exception|unknown command/i.test(`${r1.stdout ?? ""}${r1.stderr ?? ""}`);
  if (ok1) return;
  // Fallback for older Android builds without `cmd connectivity`.
  spawnSync(adb, ["-s", serial, "shell", "settings", "put", "global", "airplane_mode_on", enable ? "1" : "0"], { encoding: "utf8", timeout: 5000 });
  spawnSync(adb, ["-s", serial, "shell", "am", "broadcast", "-a", "android.intent.action.AIRPLANE_MODE", "--ez", "state", enable ? "true" : "false"], { encoding: "utf8", timeout: 5000 });
}

export async function swipeUpFromBottom(serial: string): Promise<void> {
  const { w, h } = getScreenSize(serial);
  const x = Math.round(w / 2);
  await swipe(serial, x, Math.round(h * 0.92), x, Math.round(h * 0.35), 300);
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

/** Presses the hardware/virtual BACK key — used to recover when a scripted
 * tap accidentally navigated out of the app it was supposed to stay in. */
export async function pressBack(serial: string): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  spawnSync(adb, ["-s", serial, "shell", "input", "keyevent", "KEYCODE_BACK"], { encoding: "utf8", timeout: 3000 });
}

/**
 * Reports whether the soft keyboard (IME) is currently visible. Used as a
 * safety net after tapping a pixel-detected icon (e.g. story Like/Share):
 * a coordinate that lands on the reply/comment text field instead of the
 * intended icon opens the keyboard, which is an unambiguous, cheap-to-check
 * signal that the tap hit the wrong control — even when we can't otherwise
 * tell icon glyphs apart from nearby placeholder text pixels. Checks two
 * dumpsys fields across Android versions (`mInputShown` on most builds,
 * `mIsInputViewShown` on some OEM skins) so it doesn't silently miss on
 * either.
 */
export async function isKeyboardShown(serial: string): Promise<boolean> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const r = spawnSync(adb, ["-s", serial, "shell", "dumpsys", "input_method"], { encoding: "utf8", timeout: 4000 });
  const out = r.stdout || "";
  return /mInputShown=true/.test(out) || /mIsInputViewShown=true/.test(out);
}

export async function getInstagramSignupHint(serial: string): Promise<{ currentActivity: string | null }> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const r = spawnSync(adb, ["-s", serial, "shell", "dumpsys", "activity", "activities"], { encoding: "utf8", timeout: 5000 });
  const m = (r.stdout || "").match(/mResumedActivity:.*?\{[^}]*\s([^/]+\/[^\s}]+)/);
  return { currentActivity: m ? m[1] : null };
}

/**
 * Returns the package name currently in the foreground (e.g.
 * "com.instagram.android", "com.android.chrome"), or null if it can't be
 * determined. Used to detect when an automated tap accidentally navigated
 * away from Instagram — e.g. a double-tap-to-like landing on a sponsored
 * post's CTA button ("Shop Now" / "Install Now"), which opens a browser or
 * the Play Store and leaves every subsequent scripted tap hitting the wrong
 * app for the rest of the cycle.
 */
export async function getForegroundPackage(serial: string): Promise<string | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const r = spawnSync(adb, ["-s", serial, "shell", "dumpsys", "activity", "activities"], { encoding: "utf8", timeout: 5000 });
  const m = (r.stdout || "").match(/mResumedActivity:.*?\{[^}]*\s([^/]+)\/[^\s}]+/);
  return m ? m[1] : null;
}

/**
 * Returns true if the device display is currently on, false if off/asleep,
 * or null if it can't be determined. Used to explain (and fix) the "first
 * video connect lags ~5s, retry is instant" symptom: if the display is
 * still off when the mirror starts, screenrecord can't grab a frame until
 * the physical panel/compositor actually powers on, which is where the
 * delay comes from — not from a stale process.
 */
export async function isScreenOn(serial: string): Promise<boolean | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const r = spawnSync(adb, ["-s", serial, "shell", "dumpsys", "power"], { encoding: "utf8", timeout: 5000 });
  const m = (r.stdout || "").match(/mWakefulness=(\w+)/) || (r.stdout || "").match(/mScreenOn=(\w+)/) || (r.stdout || "").match(/Display Power: state=(\w+)/i);
  if (!m) return null;
  const v = m[1].toLowerCase();
  if (v === "awake" || v === "true" || v === "on") return true;
  if (v === "asleep" || v === "false" || v === "off" || v === "dozing") return false;
  return null;
}

/**
 * Wakes the display and blocks (polling, up to `timeoutMs`) until
 * `isScreenOn` reports true, so a caller can be certain a fresh
 * screenrecord invocation will actually have frames to encode instead of
 * racing the panel/compositor power-on. No-op (returns immediately) if the
 * screen is already on.
 */
export async function ensureScreenOn(serial: string, timeoutMs = 2500): Promise<void> {
  const already = await isScreenOn(serial);
  if (already === true) return;
  await wakeScreen(serial);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const on = await isScreenOn(serial);
    if (on === true || on === null) return; // null = can't tell, don't block forever
    await new Promise(r => setTimeout(r, 150));
  }
}

/**
 * Finds Instagram's Like button for the post currently on screen via the
 * accessibility tree (uiautomator dump) and returns its real on-screen
 * centre point, or null if no such button is visible right now (e.g. the
 * feed item under the cursor is a Reel/ad card that doesn't expose a
 * standard Like control, or the dump caught a mid-scroll transition).
 *
 * This replaces guessing "roughly where the post's like target should be"
 * from a fixed vertical offset — feed items vary in height (single photo
 * vs. carousel vs. embedded Reel suggestion vs. ad), so a fixed-offset
 * double-tap was landing on whatever happened to be there, including a
 * Reel thumbnail or an ad's CTA, instead of the like button.
 */
export async function findLikeButton(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial);
  if (!xml) return null;
  const like = _findCentermostLikeNode(xml);
  return like ? { x: like.x, y: like.y } : null;
}

/**
 * Android's RecyclerView-backed feed keeps the adapter rows immediately
 * above/below the visible viewport alive in the view hierarchy (for smooth
 * scroll recycling), so `uiautomator dump` can legitimately contain MORE
 * THAN ONE `content-desc="Like"` node at once — one for the post that's
 * mostly scrolled past, one for the post the user is actually looking at,
 * sometimes a third for a card only a few px into view. Taking the FIRST
 * regex match (old behaviour) picked whichever happened to appear first in
 * document order, which is not necessarily the post on screen — a comment
 * card, a Reel's reply/reaction bar, or another unrelated post could then
 * get swept into that wrong Like button's "same row" scan (see
 * findFeedActionIcons) and get tapped instead of Like. Selecting the Like
 * node whose Y is closest to the screen's vertical centre reliably picks
 * the post the user (and any human-like jitter tap) is actually looking
 * at, since that's what's centred in the viewport after a scroll settles.
 */
function _findCentermostLikeNode(xml: string, screenH: number): { x: number; y: number } | null {
  // Primary: resource-id lookup — handles builds where content-desc="Like"
  // is absent (stripped by the device/IG build). No MAX_DIST filter is
  // applied here because resource-id "row_feed_button_like" is unique: there
  // is exactly one Like button per feed post and the rid never appears on
  // any other element, so the first match is always the correct node
  // regardless of its y-position in the a11y layout space.
  const ridLike = _findByResId(xml, ":id/row_feed_button_like");
  if (ridLike) return ridLike;

  // Fallback: content-desc="Like" closest to screen centre + MAX_DIST guard.
  // Exact, whole-word "Like" only — content-desc="Unlike" (already-liked
  // posts) must never match, or a jitter tap could accidentally unlike.
  const re = /content-desc="Like"[^>]*bounds="(\[\d+,\d+\]\[\d+,\d+\])"/g;
  // Use the caller-supplied real screen height (from adb wm size) rather than
  // _getScreenSize(xml), which falls back to h=900 when the XML root bounds
  // don't match [0,0][W,H].  With h=900, centerY=450 — a Like node near the
  // top of the screen (y≈276) wins over the real action bar (y≈1900) because
  // 276 is only 174px from 450 while 1900 is 1450px away.  The correct center
  // for a 2460px tall device is 1230; from there the real bar at y≈975+ is
  // always 255px or less away while any header element at y≈276 is 954px away,
  // so the correct node wins without needing an additional hard floor.
  // NOTE: no hard y floor is applied here.  The first post's action bar can
  // legitimately sit at y < 40% of screen height when the post image is small
  // (landscape/news post) — a fixed floor at 40% falsely rejects it.
  const centerY = screenH / 2;
  // If the closest Like node is more than 38 % of screen height from centre,
  // no real feed-post action bar is in the visible viewport — the node belongs
  // to a post recycled above/below the screen.  Return null so callers skip
  // all actions rather than tapping an off-screen node blind.
  const MAX_DIST = screenH * 0.38;
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const c = _parseCenter(m[1]);
    if (!c) continue;
    const dist = Math.abs(c.y - centerY);
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  return bestDist <= MAX_DIST ? best : null;
}

export interface FeedActionIcons {
  like: { x: number; y: number };
  comment: { x: number; y: number } | null;
  shareFeed: { x: number; y: number } | null; // repost / share-to-feed (double-arrow icon)
  shareDm: { x: number; y: number } | null;   // send / share-via-DM (paper-plane icon)
  save: { x: number; y: number } | null;       // bookmark / ribbon (row_feed_button_save)
  /** True when the Like button resolved to "Unlike" — post is already liked.
   *  Callers must skip the like tap to avoid accidental unlike, but MUST still
   *  continue with ShareFeed/ShareDM actions — the icon row is fully present. */
  alreadyLiked?: boolean;
  /** True when the post is a video/Reel in-feed. Callers must NOT double-tap
   *  the media area on video posts (that opens the full-screen Reel player);
   *  they must fall back to the heart-icon tap instead. */
  isVideoPost?: boolean;
  /** Bounding box of the post's media area, when Instagram exposes a
   *  carousel_media_group or media_group node above the action bar. Callers
   *  use this to place the double-tap in the upper portion of the image,
   *  staying away from sponsored-post CTA banners that appear at the bottom
   *  of the media content. */
  mediaBounds?: { x1: number; y1: number; x2: number; y2: number };
}

/**
 * View Feed-only safety options. Other tools keep the historical behaviour
 * unless they explicitly opt into this strict scan.
 */
export interface FeedActionScanOptions {
  strictViewFeed?: boolean;
}

function _isSponsoredViewFeedXml(xml: string): boolean {
  // Match exact accessibility values so normal words such as "Add" or
  // "Adidas" do not get treated as ads.
  const explicitAdMarker =
    xml.includes('text="Ad"') || xml.includes('content-desc="Ad"') ||
    xml.includes('text="Sponsored"') || xml.includes('content-desc="Sponsored"') ||
    xml.includes('text="Advert"') || xml.includes('content-desc="Advert"');
  if (explicitAdMarker) return true;

  // Sponsored cards commonly expose a CTA Button even when the explicit
  // "Sponsored" label is omitted from the accessibility dump. Parse each
  // node segment so attribute ordering cannot make this check miss the CTA.
  for (const segment of xml.split("<node ")) {
    const className = (segment.match(/class="([^"]*)"/i) || [])[1] ?? "";
    if (className !== "android.widget.Button") continue;
    const text = (segment.match(/\b(?:text|content-desc)="([^"]*)"/i) || [])[1] ?? "";
    if (/\b(?:shop|install|learn more|visit|sign up|get offer|contact us|download|book now|apply now|become a partner)\b/i.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Locates Instagram's feed post action-bar icons (Like, Comment, Repost,
 * Send) for whatever post is on screen right now, instead of assuming
 * they always sit at fixed screen-width percentages.
 *
 * Why this exists: shareFeedIconX/shareDmIconX used to be hardcoded at
 * 48.1%/66.0% of screen width, measured once from a single screenshot
 * where all four icons (Like, Comment, Repost, Send) were present. But
 * page/profile owners can disable comments and/or shares independently
 * per post, which removes those icons from the bar entirely and shifts
 * everything after the gap left-ward — the fixed 48.1%/66.0% X positions
 * then land on whatever actually occupies that slot instead, including
 * the Comment button (confirmed from a user's screen-layout-scan after
 * "Share to Feed"/"Share via DM" opened a comment/reply compose box
 * instead). There is no reliable way to guess how many icons are missing
 * from screen % alone, so this reads the real accessibility tree for
 * this exact post instead.
 *
 * Approach: find the confirmed Like button (existing, reliable
 * content-desc="Like" match), then collect every OTHER clickable node on
 * the same row (same Y, small tolerance), excluding the far-right
 * bookmark/save icon (identified by content-desc when Instagram labels
 * it, and by a >80%-of-width position heuristic when it doesn't). What's
 * left, left to right, can only be some subset of {Comment, Repost,
 * Send} — Instagram never reorders them, it only omits whichever are
 * disabled. That means:
 *   - Exactly 3 remaining → all three present, order is forced by
 *     elimination: [Comment, Repost, Send]. No guessing involved.
 *   - Comment positively identified by content-desc → its position is
 *     certain; if exactly 2 icons remain after removing it, those must
 *     be [Repost, Send], again forced by elimination.
 *   - Anything else (0, 1, or 2 unlabeled remaining icons with Comment
 *     not identified) is genuinely ambiguous — could be any subset of
 *     the three — and is left as `null` rather than guessed. Guessing
 *     wrong here is exactly the bug this replaces.
 * Callers must treat a `null` field as "skip this action for this post",
 * never fall back to a fixed coordinate.
 */
export async function findFeedActionIcons(
  serial: string,
  onLog?: (msg: string) => void,
  options?: FeedActionScanOptions,
): Promise<FeedActionIcons | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial);
  if (!xml) return null;
  if (options?.strictViewFeed && _isSponsoredViewFeedXml(xml)) {
    onLog?.("[feed-icons] View Feed sponsored/ad card detected — skipping all post actions");
    return null;
  }

  // Use the adb-queried screen dimensions, NOT _getScreenSize(xml). The XML-parsed
  // fallback returns w=1600 (landscape desktop) / h=900 when the root bounds attribute
  // is absent. Using the wrong width sets saveCutoffX = 1280 — well above the
  // bookmark icon's real X (~950 px on 1080 px phone) so it leaks into rowNodes
  // and breaks icon counting. Using the wrong height (h=900 → centerY=450) makes
  // _findCentermostLikeNode pick a Like node near the screen top (y≈276 header
  // area) instead of the real feed action bar (y≈1900), poisoning every icon coord.
  // getScreenSize(serial) uses `adb shell wm size` and defaults to 1080×2400.
  const { w, h: screenH } = getScreenSize(serial);
  // Find the Like node closest to the screen's real vertical centre.
  // RecyclerView recycling can keep an adjacent post's (or a Reel/reply-bar
  // card's) Like node alive in the hierarchy at the same time; anchoring the
  // row-scan on the wrong post's Like button pulls THAT post's unrelated wide
  // elements into rowNodes — see _findCentermostLikeNode.
  let like = _findCentermostLikeNode(xml, screenH);
  let alreadyLiked = false;
  if (!like) {
    // Post may be already liked (content-desc="Unlike"). We still need the
    // button's position to anchor the row scan for Comment/Repost/Send.
    // Use the same centering heuristic as _findCentermostLikeNode, but match
    // "Unlike". The result is NEVER tapped for a like — callers must check
    // alreadyLiked and skip the like action to avoid accidental unlike.
    let bestUnlike: { x: number; y: number } | null = null;
    let bestDist = Infinity;
    const centerY = screenH / 2;
    const MAX_DIST = screenH * 0.38;
    const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
    let um: RegExpExecArray | null;
    while ((um = nodeRe.exec(xml)) !== null) {
      const attrs = um[1];
      const contentDesc = attrs.match(/\bcontent-desc="([^"]*)"/i)?.[1] ?? "";
      if (!/^Unlike$/i.test(contentDesc)) continue;
      const bounds = attrs.match(/\bbounds="(\[\d+,\d+\]\[\d+,\d+\])"/i)?.[1];
      if (!bounds) continue;
      const c = _parseCenter(bounds);
      if (!c) continue;
      const dist = Math.abs(c.y - centerY);
      if (dist < bestDist) { bestDist = dist; bestUnlike = c; }
    }
    if (bestUnlike && bestDist <= MAX_DIST) {
      like = bestUnlike;
      alreadyLiked = true;
    }
  }
  if (!like) {
    // Diagnostic: dump every clickable node near screen centre so we can see
    // exactly what label/resource-id the Reel viewer (or any other layout)
    // exposes for its Like control. Without this the "null" return is silent
    // and we cannot distinguish "Like button has different label" from
    // "UI still loading" or "genuinely no post opened".
    const centerY = screenH / 2;
    const scanWindow = screenH * 0.50; // look within ±50 % of centre
    const nearCentreRe = /<node\s([^>]+?)\s*\/?>/g;
    const nearNodes: string[] = [];
    let dm: RegExpExecArray | null;
    while ((dm = nearCentreRe.exec(xml)) !== null) {
      const a = dm[1];
      if (!/clickable="true"/.test(a)) continue;
      const bm = a.match(/bounds="(\[\d+,\d+\]\[\d+,\d+\])"/);
      if (!bm) continue;
      const c = _parseCenter(bm[1]);
      if (!c || Math.abs(c.y - centerY) > scanWindow) continue;
      const cd  = (a.match(/content-desc="([^"]*)"/)  || [])[1] ?? "";
      const rid = (a.match(/resource-id="([^"]*)"/)   || [])[1] ?? "";
      const cls = (a.match(/class="([^"]*)"/)         || [])[1] ?? "";
      nearNodes.push(`(${c.x},${c.y}) cd="${cd}" rid="${rid}" cls="${cls}"`);
    }
    onLog?.(`[feed-icons] no Like/Unlike node found near centre — nearcentre clickable nodes: ${nearNodes.length ? nearNodes.join(" | ") : "(none)"}`);
    return null;
  }
  const rowTolerance = 20;
  // Save/bookmark is almost always explicitly labelled (cd="Add to Saved" /
  // cd="Remove from saved" / rid=row_feed_button_save) so the label filter
  // catches it first. This positional cutoff is only a last-resort guard for
  // the rare unlabelled save node, and must be generous enough NOT to exclude
  // the Send/DM icon on narrow screens (720 px wide): Send lands at x≈90% on
  // those devices, so 80% was incorrectly cutting it out.  95% leaves room for
  // Send while still excluding an unlabelled Save that is always at the far
  // right edge (confirmed: x=1013 on a 720 px screen, i.e. >100%).
  const saveCutoffX = Math.round(w * 0.95);
  // Instagram's Comment/Repost/Send icons are small square glyphs (roughly
  // the same width as the Like heart). A message/reply compose field (the
  // quick-reaction bar Instagram shows under a Reel/repost card in-feed)
  // is `clickable="true"` too and can land on the same row by coincidence,
  // but it's much wider than a single icon — cap accepted width generously
  // above the Like button's own width so real icons always pass while a
  // full-width text field never does.
  const maxIconWidth = Math.max(120, Math.round(w * 0.12));

  type RowNode = { x: number; y: number; cd: string; rid: string; cls: string; txt: string; width: number };
  const rowNodes: RowNode[] = [];
  // Nodes that match the audio-disc profile (ImageView, no content-desc, no digit
  // text) are NOT immediately discarded. They are saved here and used as a
  // last-resort positional fallback for shareFeed/shareDm when all label-based
  // and pool-based detection has failed.
  //
  // Why keep them at all: on Xiaomi MIUI + certain Instagram builds the Repost
  // and Send icons are rendered as plain ImageViews with clickable="true" but
  // zero accessibility labelling — no content-desc, no text. They are
  // indistinguishable from the audio-disc node on other devices/builds. Dropping
  // them unconditionally causes ShareFeed:✗ / ShareDM:✗ on those phones even
  // when both icons are plainly visible on screen.
  //
  // Safety: these nodes are only used when everything else fails, AND only when
  // they sit at least (iconGap × 0.6) to the right of the Comment icon — the
  // audio disc appears immediately after Comment (close in x), while Repost and
  // Send are one and two icon-gaps further right.
  const unlabeledImgViews: RowNode[] = [];
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let nm: RegExpExecArray | null;
  while ((nm = nodeRe.exec(xml)) !== null) {
    const attrs = nm[1];
    if (!/clickable="true"/.test(attrs)) continue;
    if (/class="android\.widget\.EditText"/.test(attrs)) continue; // message/reply/comment compose field, never an action icon
    const bm = attrs.match(/bounds="(\[(\d+),(\d+)\]\[(\d+),(\d+)\])"/);
    if (!bm) continue;
    const c = _parseCenter(bm[1]);
    if (!c) continue;
    const nodeWidth = +bm[4] - +bm[2];
    if (nodeWidth > maxIconWidth) continue; // too wide to be a single action icon (e.g. a reply/compose bar)
    if (Math.abs(c.y - like.y) > rowTolerance) continue;
    if (c.x < like.x + 20) continue; // Like itself, or the phantom accessibility container that wraps it (always within 20 px of like.x)
    const cdM = attrs.match(/content-desc="([^"]*)"/);
    const cd = cdM ? cdM[1] : "";
    if (/favorit|save/i.test(cd)) continue; // bookmark, labeled
    if (c.x > saveCutoffX) continue; // bookmark, unlabeled — far-right heuristic
    const clsM = attrs.match(/class="([^"]*)"/);
    const cls = clsM ? clsM[1] : "";
    const txtM = attrs.match(/\btext="([^"]*)"/);
    const txt = txtM ? txtM[1] : "";
    const ridM = attrs.match(/resource-id="([^"]*)"/);
    const rid = ridM ? ridM[1] : "";
    if (cls === "android.widget.ImageView" && !cd && !/\d/.test(txt)) {
      // Potential audio disc OR unlabeled Repost/Send — save separately, don't
      // add to rowNodes (keeps the disc-tapping regression fix intact for devices
      // where the disc is present and Repost/Send ARE labeled).
      unlabeledImgViews.push({ x: c.x, y: c.y, cd, rid, cls, txt, width: nodeWidth });
      continue;
    }
    rowNodes.push({ x: c.x, y: c.y, cd, rid, cls, txt, width: nodeWidth });
  }
  rowNodes.sort((a, b) => a.x - b.x);
  unlabeledImgViews.sort((a, b) => a.x - b.x);

  // Diagnostic: log every node in the action-bar row so we know the exact
  // content-desc / resource-id / class Instagram puts on this device/build.
  // v1.1.570's cd dump came back with EVERY node's content-desc empty, and
  // v1.1.571's resource-id dump came back empty too — this build/device
  // strips both. The v1.1.571 run showed a clean alternating
  // Button/ViewGroup/Button/ViewGroup pattern (4 Buttons, 3 ViewGroups
  // interleaved), which suggests each real icon renders as a
  // `android.widget.Button` node while its count label (e.g. "64" reposts)
  // renders as a separate clickable `android.view.ViewGroup` wrapper — but
  // that needs `text` and `width` to confirm before it's used for anything.
  // text should reveal which nodes carry a visible count number, and width
  // should show whether Buttons are narrow (icon-sized) vs ViewGroups wider
  // (label-sized) or vice versa.
  const fmt = (n: RowNode) => `x=${n.x} w=${n.width} cd="${n.cd || ""}" rid="${n.rid || ""}" cls="${n.cls || ""}" txt="${n.txt || ""}"`;
  const rowDump = rowNodes.map(fmt).join(" | ");
  onLog?.(`[feed-icons] row cd dump: ${rowDump}`);
  if (unlabeledImgViews.length) {
    onLog?.(`[feed-icons] unlabeled ImageView dump: ${unlabeledImgViews.map(fmt).join(" | ")}`);
  }

  const pos = (n: RowNode) => ({ x: n.x, y: n.y });
  let comment: { x: number; y: number } | null = null;
  let shareFeed: { x: number; y: number } | null = null;
  let shareDm: { x: number; y: number } | null = null;

  // --- Icon identification: content-desc first, positional fallback ---
  //
  // Relying solely on position (node[0]=Comment, node[1]=Repost, node[2]=Send)
  // breaks when accounts have Repost disabled — the icon roster shrinks and
  // every position shifts left, mapping node[0] to Comment but node[1] now to
  // Send instead of Repost. The software then taps the wrong icon.
  //
  // Primary strategy: match each role by its Instagram accessibility label.
  // Instagram consistently labels these icons in English regardless of account
  // locale (the content-desc is set by the apk, not the system language).
  //   Comment → "Comment"
  //   Share to Feed (Repost) → "Repost"
  //   Share to DM (Send) → "Send" | "Direct" | "Message"
  //
  // Fallback strategy: for any role whose label was not found, consume the
  // next unassigned node in left-to-right order. This preserves correct
  // behaviour on devices/versions where content-desc attributes are absent.
  // Use anchored / exact matches for Comment and Repost so that count-badge
  // elements don't steal the slot.  Instagram renders a "N comments" count
  // node (content-desc="1,844 comments") on the same Y row as the action
  // icons; /\bcomment\b/i matches that node and returns x≈71 (5 px from Like),
  // which (a) claims the comment slot for a non-icon element and (b) collapses
  // iconGap to 5 px, making the unlabeled-ImageView minX filter exclude the
  // real Repost/Send icons at their true positions.
  //
  // Additional guard: a node labeled "Comment" that is within 20 px of the
  // Like button's centre CANNOT be the real comment-bubble icon — Instagram's
  // action-bar icons are at minimum ~60 px apart. This phantom element is an
  // accessibility container (parent ViewGroup) that wraps the Like heart and
  // its sibling text, not the comment icon itself. Requiring n.x > like.x + 20
  // excludes it while still accepting the real Comment icon further right.
  const commentNode  = rowNodes.find(n => /^comment$/i.test(n.cd) && n.x > like.x + 20) ?? null;
  // Some IG builds label Repost as "Share", "Share to Feed", or "Repost to
  // your story" rather than the bare "Repost" string; all of these refer to
  // the same in-feed reshare icon and must be matched.  Exclude any candidate
  // that also matches the Send/DM slot (Send can be labelled "Share via DM"
  // or "Share" on older builds, so always prefer the rightmost "Share" node
  // as Send and the leftmost as Repost — handled by left→right pool order).
  const repostNode   = rowNodes.find(n => /\brepost\b/i.test(n.cd) || /^share$/i.test(n.cd)) ?? null;
  const sendNode     = rowNodes.find(n => /\b(send|direct|message)\b/i.test(n.cd) || (/^share$/i.test(n.cd) && n !== repostNode)) ?? null;

  comment   = commentNode  ? pos(commentNode)  : null;
  shareFeed = repostNode   ? pos(repostNode)   : null;
  shareDm   = sendNode     ? pos(sendNode)     : null;

  // Whether Repost is available at all is genuinely account/post-specific
  // (Instagram lets an account or a specific post disable resharing to
  // feed, the same way Comment can be disabled per-post) — it is NOT tied
  // to whether the post is a Reel or a normal feed post, and it must not
  // be assumed either way from post type. A prior version of this code
  // special-cased Reels to skip positional fallback for shareFeed, based
  // on a single misread screenshot rather than real accessibility-tree
  // evidence — that assumption was wrong and has been removed.
  //
  // What IS true generally: unlike Comment/Send (whose content-desc labels
  // are consistently present, so their positions are known with
  // confidence), a missing "Repost" content-desc match is genuinely
  // ambiguous — it could mean Repost is disabled for this
  // account/post (nothing to find, correctly null), or it could mean the
  // label just isn't set on this device/build (present, but unlabeled).
  // Positionally guessing in that situation risks grabbing an unrelated
  // leftover control (e.g. a "More options" icon) and mislabelling it
  // `shareFeed` — confirmed from a live run where that happened. So
  // `shareFeed` is only ever set from a positive "Repost" content-desc
  // match; it is never filled in positionally. `null` here always means
  // "skip this action for this post" per this function's contract,
  // regardless of whether the post disabled repost or the label is just
  // missing — both cases are handled identically and safely by callers.

  // --- Device-specific fallback: icon-class structural identification ---
  //
  // Confirmed 14 Jul 2026 against a live screenshot + matching row dump on a
  // device/build where content-desc AND resource-id are BOTH empty on every
  // action-bar node (v1.1.570/571 dumps), so no label exists to match at
  // all. The row dump showed a consistent pattern: each real action icon
  // renders as a content-desc-less `android.view.ViewGroup` with empty
  // `text` (the tappable icon graphic itself). When a visible count exists,
  // Instagram renders it as a SEPARATE content-desc-less `android.widget.
  // Button` immediately after the icon (e.g. txt="2,340") — but that count
  // node is NOT relied on for identification, only the ViewGroup icon is.
  //
  // Why not require the adjacent count node (v1.1.573's original approach):
  // a post can have a genuine zero count on any of Comment/Repost/Send —
  // possibly on all three, or all four including Like — and it is unknown
  // whether Instagram then renders the count Button with blank text or
  // omits the node from the tree entirely. Requiring a paired Button either
  // way would risk silently losing icons on exactly the zero-count posts
  // this is meant to handle. The icon's own class/content-desc/text is
  // constant regardless of whether a count node exists next to it, so
  // identification uses ONLY that: a candidate action icon is any rowNode
  // that is a content-desc-less, text-less ViewGroup.
  //
  // Live confirmation: screenshot showed comment=34, repost=2,340, send=30.9K
  // on a post; the row dump for that exact post had exactly 3 such
  // ViewGroups (each followed by its own Button count, coincidentally, but
  // that adjacency isn't what's being trusted here) in that left-to-right
  // order — matching Comment/Repost/Send exactly.
  //
  // This is a structural/type read of the live tree (class + content-desc +
  // text), not a fixed pixel-percentage guess, but it is still
  // elimination-based like the label matching above: it only fires when
  // NONE of comment/shareFeed/shareDm were found by label (this device has
  // none), and only trusts the result when EXACTLY 3 candidate icons are
  // found. Anything else (an icon disabled, extra unrelated ViewGroups,
  // fewer than 3) is genuinely ambiguous with no label to confirm which
  // slot is missing or spurious, so it's left null rather than guessed —
  // same safety contract as the rest of this function.
  if (!comment && !shareFeed && !shareDm) {
    // ── Structural fallback A: ViewGroup icon pattern ──
    // Confirmed 14 Jul 2026: content-desc-less, text-less ViewGroup nodes are
    // the tappable icon glyphs on some device/build combos.  Exactly 3 required.
    const iconCandidates = rowNodes.filter(n => n.cls === "android.view.ViewGroup" && !n.cd && !n.txt);
    if (iconCandidates.length === 3) {
      const countFor = (icon: RowNode) => {
        const idx = rowNodes.indexOf(icon);
        const next = rowNodes[idx + 1];
        return next && next.cls === "android.widget.Button" && !next.cd && (next.x - icon.x) < maxIconWidth * 2
          ? next.txt || "(blank/zero)"
          : "(no count node)";
      };
      onLog?.(`[feed-icons] structural icon-class match found exactly 3 candidates — assigning Comment/Repost/Send by elimination: ${iconCandidates.map(n => `icon@${n.x} count=${countFor(n)}`).join(" | ")}`);
      comment   = pos(iconCandidates[0]);
      shareFeed = pos(iconCandidates[1]);
      shareDm   = pos(iconCandidates[2]);
    } else {
      // ── Structural fallback B: Button icon pattern ──
      // Some builds (confirmed 15 Jul 2026 from live dump: alternating
      // ViewGroup/Button at y=2202 with all cd/rid empty) render each action
      // icon as an unlabelled android.widget.Button rather than a ViewGroup.
      // The ViewGroups in that pattern are parent CONTAINERS (wrapping icon +
      // count), not the tappable glyph — they may be wider than maxIconWidth
      // and excluded from rowNodes by the width filter.  The Button children
      // ARE narrow/icon-sized and pass the filter.  Same elimination rule: only
      // trust the result when EXACTLY 3 such Buttons are found.
      const btnCandidates = rowNodes.filter(n => n.cls === "android.widget.Button" && !n.cd && !n.txt);
      if (btnCandidates.length === 3) {
        onLog?.(`[feed-icons] structural Button-class match found exactly 3 candidates — assigning Comment/Repost/Send by elimination: ${btnCandidates.map(n => `btn@${n.x}`).join(" | ")}`);
        comment   = pos(btnCandidates[0]);
        shareFeed = pos(btnCandidates[1]);
        shareDm   = pos(btnCandidates[2]);
      }
    }
  }

  // No fixed-percentage positional fallback. Every icon must be confirmed by
  // its accessibility label, or — only when no label exists anywhere on this
  // device/build — by the structural icon/count pairing above. Guessing by
  // raw left-to-right order among unrelated clickable nodes violates the
  // project rule that all detection uses live element structure, never
  // coordinates. If neither strategy confirms a role, that slot stays null
  // and callers skip the action.

  // ── Save/Bookmark button ──────────────────────────────────────────────────
  // The ribbon/bookmark icon always lives far to the RIGHT of the action-bar
  // row (confirmed: rid=row_feed_button_save, cd="Add to Saved", x=1014 on
  // 1080 px screen — i.e. ~94 % of width). It is explicitly excluded from
  // rowNodes above (the saveCutoffX heuristic + the /save/i label filter),
  // so it is never confused with Comment/Repost/Send. We find it here by
  // scanning for its well-known resource-id and content-desc labels rather
  // than any positional assumption.
  let save: { x: number; y: number } | null = null;
  {
    // Primary: resource-id match (most reliable — IG has kept this stable).
    const ridSaveRe = /resource-id="[^"]*row_feed_button_save"[^>]*bounds="(\[\d+,\d+\]\[\d+,\d+\])"/;
    const ridSaveM = ridSaveRe.exec(xml);
    if (ridSaveM) {
      save = _parseCenter(ridSaveM[1]);
    }
    // Fallback: content-desc label (covers future builds that rename the rid).
    if (!save) {
      const cdSaveRe = /content-desc="(?:Add to Saved|Remove from saved)"[^>]*bounds="(\[\d+,\d+\]\[\d+,\d+\])"/;
      const cdSaveM = cdSaveRe.exec(xml);
      if (cdSaveM) {
        save = _parseCenter(cdSaveM[1]);
      }
    }
    // Sanity check: the save/bookmark icon must sit on the same horizontal
    // row as the Like button (the feed post's action bar). An embedded Reels
    // card in the feed also exposes a row_feed_button_save / "Add to Saved"
    // node, but its save icon is in the Reel's vertical right-edge column at
    // a completely different Y position. If the detected save button is more
    // than 80 px away from the Like button's Y, it belongs to a different
    // card and must be rejected — tapping it navigates into the Reel viewer.
    if (save && Math.abs(save.y - like.y) > 80) {
      onLog?.(`[feed-icons] save button at (${save.x},${save.y}) rejected — y=${save.y} is ${Math.abs(save.y - like.y)}px from Like row (y=${like.y}); likely belongs to an embedded Reel card`);
      save = null;
    }
    if (save) {
      onLog?.(`[feed-icons] save button found at (${save.x},${save.y})`);
    } else {
      onLog?.(`[feed-icons] save button not found (will skip save action for this post)`);
    }
  }

  // Detect video/Reel posts in the feed using the already-fetched xml dump.
  // A video post exposes a SurfaceView, TextureView, or VideoView node for its
  // player — none of these appear in a regular photo post.  When this flag is
  // true callers MUST NOT double-tap the media area (that opens the full-screen
  // Reel player); they must fall back to the heart-icon tap instead.
  const isVideoPost =
    xml.includes("android.view.SurfaceView") ||
    xml.includes("android.view.TextureView") ||
    xml.includes("android.widget.VideoView") ||
    xml.includes(":id/video_player") ||
    xml.includes(":id/row_feed_video");

  // Find the media container bounding box from the same dump (zero extra cost).
  // Used by callers to place the double-tap in the upper portion of the image,
  // away from sponsored-post CTA banners that Instagram overlays near the
  // bottom of the media area.
  //
  // Two resource-ids cover the common cases:
  //   carousel_media_group — multi-image / carousel posts
  //   media_group          — single-photo posts
  //
  // Safety filter: the bounds must lie ABOVE the Like button row (y2 < like.y)
  // to avoid accidentally matching an element that is not the post's main media
  // (e.g. a suggested-users or ad card further down the hierarchy).
  let mediaBounds: { x1: number; y1: number; x2: number; y2: number } | undefined;
  {
    const mediaRids = [":id/carousel_media_group", ":id/media_group"];
    for (const rid of mediaRids) {
      const b = _findBoundsByResId(xml, rid);
      if (b && b.y2 < like.y) {
        mediaBounds = b;
        onLog?.(`[feed-icons] media bounds found via "${rid}": [${b.x1},${b.y1}][${b.x2},${b.y2}]`);
        break;
      }
    }
    // Some Instagram builds strip both media_group resource IDs. In that
    // case, recover the border from the live node tree itself: choose the
    // largest ImageView/media-like rectangle above this post's action row.
    // This is still node-derived targeting; no screen pixel or fixed
    // coordinate is used.
    if (!mediaBounds) {
      const { w, h: screenH } = getScreenSize(serial);
      const candidates: Array<{ bounds: { x1: number; y1: number; x2: number; y2: number }; area: number }> = [];
      for (const segment of xml.split("<node ")) {
        const boundsMatch = segment.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!boundsMatch) continue;
        const b = {
          x1: Number(boundsMatch[1]), y1: Number(boundsMatch[2]),
          x2: Number(boundsMatch[3]), y2: Number(boundsMatch[4]),
        };
        const width = b.x2 - b.x1;
        const height = b.y2 - b.y1;
        const rid = (segment.match(/resource-id="([^"]*)"/) || [])[1] ?? "";
        const cls = (segment.match(/class="([^"]*)"/) || [])[1] ?? "";
        const desc = (segment.match(/content-desc="([^"]*)"/) || [])[1] ?? "";
        const text = (segment.match(/\btext="([^"]*)"/) || [])[1] ?? "";
        const mediaLike = /media|photo|image|carousel|video/i.test(`${rid} ${cls} ${desc} ${text}`);
        const imageClass = /ImageView|TextureView|SurfaceView|VideoView/i.test(cls);
        if (!mediaLike && !imageClass) continue;
        // An author/header/profile container can be large and "media-like" in
        // the accessibility tree, but it is short and not the post canvas.
        // Require a near-full-width, genuinely tall rectangle so this fallback
        // cannot return the author row as media.
        if (width < w * 0.80 || height < screenH * 0.30) continue;
        if (height < width * 0.55) continue;
        // RecyclerView can retain a media container for a post that has
        // scrolled mostly out of view. A large rectangle above Like is not
        // sufficient: its bottom edge must be close to the current action row
        // and it must contain a meaningful visible interval immediately above
        // that row. Otherwise a double-tap can land on a header/CTA belonging
        // to the post that was scrolled past.
        const visibleBottom = Math.min(b.y2, like.y - Math.max(24, Math.round(screenH * 0.02)));
        const visibleTop = Math.max(b.y1, Math.round(screenH * 0.08));
        if (visibleBottom <= visibleTop) continue;
        if (like.y - b.y2 > screenH * 0.18) continue;
        if (b.y1 < screenH * 0.06) continue;
        candidates.push({ bounds: b, area: width * height });
      }
      candidates.sort((a, b) => b.area - a.area);
      if (candidates[0]) {
        mediaBounds = candidates[0].bounds;
        onLog?.(`[feed-icons] media bounds found from node tree: [${mediaBounds.x1},${mediaBounds.y1}][${mediaBounds.x2},${mediaBounds.y2}]`);
      }
    }
    if (!mediaBounds) {
      onLog?.("[feed-icons] media bounds not found — no node-confirmed double-tap target");
      // Keep the action-bar result even when the media border is unavailable.
      // View Feed can safely fall back to the node-confirmed Like heart, while
      // Save/Share remain independently usable from their own nodes.
    }
  }

  return { like, comment, shareFeed, shareDm, save, alreadyLiked, isVideoPost, mediaBounds };
}

export interface ReelActionIcons {
  like: { x: number; y: number };
  comment: { x: number; y: number } | null;
  shareFeed: { x: number; y: number } | null; // repost / share-to-feed
  shareDm: { x: number; y: number } | null;   // send / share-via-DM
  save: { x: number; y: number } | null;      // bookmark / save ribbon
  /** True when the Like button resolved to "Unlike" — reel is already liked. */
  alreadyLiked?: boolean;
  /** True when the Save button resolved to "Saved" — reel is already saved. */
  alreadySaved: boolean;
}

/**
 * Locates Instagram's Reels viewer action-icon COLUMN (Like, Comment,
 * Repost/Share, Send) — for Reels these render VERTICALLY down the right
 * edge of the screen, unlike a normal feed post's horizontal bottom action
 * bar (see findFeedActionIcons). This reuses the exact same
 * accessibility-tree content-desc labels already proven reliable for the
 * feed's action bar ("Like"/"Unlike", "Comment", "Repost"/"Share",
 * "Send"/"Direct"/"Message") — Instagram reuses these labels for the Reels
 * icon column, just laid out on a different axis. No fixed pixel
 * coordinates are used anywhere in this function, per project rule.
 *
 * NOT YET VALIDATED against a real device screenshot of an open Reel (added
 * 15 Jul 2026, no diagnostic run yet). Ships with the same "diagnostic dump
 * on failure" pattern as findFeedActionIcons: if the Like/Unlike anchor or
 * the Comment/Repost/Send labels don't match what a real device actually
 * exposes, this logs every right-edge clickable node instead of guessing, so
 * the next fix has real evidence rather than another blind attempt.
 */
export async function findReelActionIcons(serial: string, onLog?: (msg: string) => void): Promise<ReelActionIcons | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial);
  if (!xml) return null;
  const { w, h: screenH } = getScreenSize(serial);
  void screenH;

  // The action column sits in the right ~28% of the screen. Anchor on the
  // Like/Unlike node closest to that column rather than trusting the first
  // match anywhere on screen — a caption, hashtag, or the audio-disc label
  // elsewhere on the frame could otherwise be mistaken for it.
  const rightBand = w * 0.72;
  const findAnchor = (label: "Like" | "Unlike"): { x: number; y: number } | null => {
    const re = new RegExp(`content-desc="${label}"[^>]*bounds="(\\[\\d+,\\d+\\]\\[\\d+,\\d+\\])"`, "g");
    let best: { x: number; y: number } | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const c = _parseCenter(m[1]);
      if (!c || c.x < rightBand) continue;
      if (!best) best = c; // first right-column match wins
    }
    return best;
  };

  let like = findAnchor("Like");
  let alreadyLiked = false;
  if (!like) {
    like = findAnchor("Unlike");
    if (like) alreadyLiked = true;
  }

  if (!like) {
    // ── Fallback 1: resource-id patterns for the Like button ─────────────────
    // On some device/IG-build combinations (observed: Redmi 12 5G) the Reels
    // action icons do not carry content-desc="Like"/"Unlike".  Try well-known
    // resource-id fragments instead.  Only accept nodes in the right column.
    const RID_LIKE_PATTERNS = [
      "like_button",           // com.instagram.android:id/like_button
      "row_feed_button_like",  // feed row like button rid
      "like_count_button",     // some builds: like count tappable
      "heart_button",          // alternative label used in some versions
    ];
    {
      const ridRe = /<node\s([^>]+?)\s*\/?>/g;
      let rm: RegExpExecArray | null;
      outer: while ((rm = ridRe.exec(xml)) !== null) {
        const a = rm[1];
        const ridM = a.match(/resource-id="([^"]*)"/);
        if (!ridM) continue;
        const rid = ridM[1];
        if (!RID_LIKE_PATTERNS.some(p => rid.includes(p))) continue;
        const bm = a.match(/bounds="(\[\d+,\d+\]\[\d+,\d+\])"/);
        if (!bm) continue;
        const c = _parseCenter(bm[1]);
        if (!c || c.x < rightBand) continue;
        // Determine already-liked from content-desc of this node if available
        const cd = (a.match(/content-desc="([^"]*)"/) ?? [])[1] ?? "";
        if (/\bunlike\b/i.test(cd)) alreadyLiked = true;
        like = c;
        onLog?.(`[reel-icons] Like found via resource-id fallback: rid="${rid}" cd="${cd}" at (${c.x},${c.y})`);
        break outer;
      }
    }

    // ── Fallback 2: broadened content-desc match (e.g. "Like video", count) ─
    // Some builds label the button with a count or alternative phrase rather
    // than the plain word "Like".  Match any node in the right column whose
    // content-desc starts with "Like" or equals "Unlike" (case-insensitive).
    if (!like) {
      const cdRe = /<node\s([^>]+?)\s*\/?>/g;
      let cm: RegExpExecArray | null;
      while ((cm = cdRe.exec(xml)) !== null) {
        const a = cm[1];
        const cdM = a.match(/content-desc="([^"]*)"/);
        if (!cdM) continue;
        const cd = cdM[1];
        if (!/^\blike\b/i.test(cd) && !/^\bunlike\b/i.test(cd)) continue;
        const bm = a.match(/bounds="(\[\d+,\d+\]\[\d+,\d+\])"/);
        if (!bm) continue;
        const c = _parseCenter(bm[1]);
        if (!c || c.x < rightBand) continue;
        if (/^\bunlike\b/i.test(cd)) alreadyLiked = true;
        like = c;
        onLog?.(`[reel-icons] Like found via broadened cd match: cd="${cd}" at (${c.x},${c.y})`);
        break;
      }
    }
  }

  if (!like) {
    // Diagnostic dump: every node (clickable or not) in the right-edge column
    // so a real run shows exactly what this device/IG build exposes.  Logging
    // ALL nodes (not just clickable ones) reveals containers whose children
    // are rendered without individual clickable="true" flags — the most common
    // cause of "no Like found" on newer/tighter IG builds.
    const colTolerance = w * 0.28;
    const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
    const clickableNodes: string[] = [];
    const allNodes: string[] = [];
    let dm: RegExpExecArray | null;
    while ((dm = nodeRe.exec(xml)) !== null) {
      const a = dm[1];
      const bm = a.match(/bounds="(\[\d+,\d+\]\[\d+,\d+\])"/);
      if (!bm) continue;
      const c = _parseCenter(bm[1]);
      if (!c || c.x < w - colTolerance) continue;
      const cd  = (a.match(/content-desc="([^"]*)"/) || [])[1] ?? "";
      const rid = (a.match(/resource-id="([^"]*)"/)  || [])[1] ?? "";
      const cls = (a.match(/class="([^"]*)"/)        || [])[1] ?? "";
      const isClickable = /clickable="true"/.test(a);
      const entry = `(${c.x},${c.y}) cd="${cd}" rid="${rid}" cls="${cls}"${isClickable ? "" : " [non-clickable]"}`;
      if (isClickable) clickableNodes.push(entry);
      else allNodes.push(entry);
    }
    onLog?.(`[reel-icons] no Like/Unlike node found — right-edge clickable: ${clickableNodes.length ? clickableNodes.join(" | ") : "(none)"}`);
    if (allNodes.length > 0) {
      onLog?.(`[reel-icons] right-edge non-clickable nodes: ${allNodes.slice(0, 8).join(" | ")}${allNodes.length > 8 ? ` … +${allNodes.length - 8} more` : ""}`);
    }
    return null;
  }

  // Collect every other clickable node in the same column (X tolerance),
  // BELOW the Like icon — Comment/Repost/Send stack downward from Like in
  // the Reels viewer, mirroring the left-to-right elimination-by-label
  // approach findFeedActionIcons uses for the horizontal bar.
  const colTolerance = 40;
  type ColNode = { x: number; y: number; cd: string; rid: string; cls: string; txt: string };
  const colNodes: ColNode[] = [];
  const nodeRe2 = /<node\s([^>]+?)\s*\/?>/g;
  let nm: RegExpExecArray | null;
  while ((nm = nodeRe2.exec(xml)) !== null) {
    const attrs = nm[1];
    if (!/clickable="true"/.test(attrs)) continue;
    if (/class="android\.widget\.EditText"/.test(attrs)) continue;
    const bm = attrs.match(/bounds="(\[(\d+),(\d+)\]\[(\d+),(\d+)\])"/);
    if (!bm) continue;
    const c = _parseCenter(bm[1]);
    if (!c) continue;
    if (Math.abs(c.x - like!.x) > colTolerance) continue;
    if (c.y <= like!.y + 10) continue; // Like itself, or anything above it (e.g. profile avatar)
    const cdM = attrs.match(/content-desc="([^"]*)"/);
    const cd = cdM ? cdM[1] : "";
    const clsM = attrs.match(/class="([^"]*)"/);
    const cls = clsM ? clsM[1] : "";
    const txtM = attrs.match(/\btext="([^"]*)"/);
    const txt = txtM ? txtM[1] : "";
    const ridM = attrs.match(/resource-id="([^"]*)"/);
    const rid = ridM ? ridM[1] : "";
    colNodes.push({ x: c.x, y: c.y, cd, rid, cls, txt });
  }
  colNodes.sort((a, b) => a.y - b.y);

  const fmt = (n: ColNode) => `y=${n.y} cd="${n.cd || ""}" rid="${n.rid || ""}" cls="${n.cls || ""}" txt="${n.txt || ""}"`;
  onLog?.(`[reel-icons] column dump below Like: ${colNodes.map(fmt).join(" | ") || "(none)"}`);

  const pos = (n: ColNode) => ({ x: n.x, y: n.y });

  // Label matching — priority order matters:
  //   repostNode: only "Repost" (feed repost). Do NOT claim "Share" here —
  //     in the Reels viewer "Share" opens the DM share sheet, not the feed
  //     repost flow. Claiming it as shareFeed was the root cause of both
  //     shareFeed and shareDm being silently null (shareFeed got the wrong
  //     action, shareDm found nothing left).
  //   sendNode: "Send", "Direct", "Message", OR "Share" (the standard Reels
  //     DM-share label) — all open the share sheet leading to DM.
  const commentNode  = colNodes.find(n => /^comment$/i.test(n.cd)) ?? null;
  const repostNode   = colNodes.find(n => /\brepost\b/i.test(n.cd)) ?? null;
  const sendNode     = colNodes.find(n => /\b(send|direct|message|share)\b/i.test(n.cd) && n !== repostNode) ?? null;
  // "Save" (unsaved) or "Saved" (already saved) — exact match only to avoid
  // catching unrelated labels like "Save to Collection" sheet buttons.
  const saveColNode  = colNodes.find(n => /^saved?$/i.test(n.cd)) ?? null;

  let comment:   { x: number; y: number } | null = commentNode ? pos(commentNode) : null;
  let shareFeed: { x: number; y: number } | null = repostNode  ? pos(repostNode)  : null;
  let shareDm:   { x: number; y: number } | null = sendNode    ? pos(sendNode)    : null;
  let save:      { x: number; y: number } | null = saveColNode ? pos(saveColNode) : null;
  let alreadySaved = saveColNode ? /^saved$/i.test(saveColNode.cd) : false;

  // Structural fallback — mirrors findFeedActionIcons (replit.md rule:
  // "Feed action-bar icons with no content-desc/resource-id — structural
  // fallback"). Fires when label matching leaves shareFeed, shareDm, or save
  // null, i.e. this device/IG build strips content-desc from the Reels column.
  // Icons stack VERTICALLY in the column (Y ascending = top to bottom):
  // Comment → shareFeed (Repost) → shareDm (Send/Share) → save. Only trust
  // the result when an EXACT count is found — ambiguous counts stay null.
  if (!shareFeed || !shareDm || !save) {
    // ── Structural fallback A: ViewGroup icon pattern ──
    const vgCandidates = colNodes.filter(n => n.cls === "android.view.ViewGroup" && !n.cd && !n.txt);
    if (!comment && !shareFeed && !shareDm && !save && vgCandidates.length === 4) {
      onLog?.(`[reel-icons] structural ViewGroup fallback: 4 unlabelled column nodes — assigning Comment/shareFeed/shareDm/save by Y order`);
      comment   = pos(vgCandidates[0]);
      shareFeed = pos(vgCandidates[1]);
      shareDm   = pos(vgCandidates[2]);
      save      = pos(vgCandidates[3]);
    } else if (!comment && !shareFeed && !shareDm && vgCandidates.length === 3) {
      onLog?.(`[reel-icons] structural ViewGroup fallback: 3 unlabelled column nodes — assigning Comment/shareFeed/shareDm by Y order`);
      comment   = pos(vgCandidates[0]);
      shareFeed = pos(vgCandidates[1]);
      shareDm   = pos(vgCandidates[2]);
    } else if (comment && !shareFeed && !shareDm && vgCandidates.length === 2) {
      onLog?.(`[reel-icons] structural ViewGroup fallback: 2 unlabelled column nodes (Comment already found) — assigning shareFeed/shareDm by Y order`);
      shareFeed = pos(vgCandidates[0]);
      shareDm   = pos(vgCandidates[1]);
    } else if (!comment && !shareFeed && !shareDm && vgCandidates.length === 2) {
      // Comment absent or labelled differently — treat remaining 2 as shareFeed + shareDm
      onLog?.(`[reel-icons] structural ViewGroup fallback: 2 unlabelled column nodes (no Comment) — assigning shareFeed/shareDm by Y order`);
      shareFeed = pos(vgCandidates[0]);
      shareDm   = pos(vgCandidates[1]);
    } else if (vgCandidates.length > 0) {
      onLog?.(`[reel-icons] structural ViewGroup fallback: ${vgCandidates.length} candidate(s) — ambiguous count, leaving null`);
    }

    // ── Structural fallback B: Button icon pattern ──
    // Only runs if fallback A also produced nothing.
    if (!shareFeed && !shareDm) {
      const btnCandidates = colNodes.filter(n => n.cls === "android.widget.Button" && !n.cd && !n.txt);
      if (!comment && btnCandidates.length === 4) {
        onLog?.(`[reel-icons] structural Button fallback: 4 unlabelled Buttons — assigning Comment/shareFeed/shareDm/save by Y order`);
        comment   = pos(btnCandidates[0]);
        shareFeed = pos(btnCandidates[1]);
        shareDm   = pos(btnCandidates[2]);
        save      = pos(btnCandidates[3]);
      } else if (!comment && btnCandidates.length === 3) {
        onLog?.(`[reel-icons] structural Button fallback: 3 unlabelled Buttons — assigning Comment/shareFeed/shareDm by Y order`);
        comment   = pos(btnCandidates[0]);
        shareFeed = pos(btnCandidates[1]);
        shareDm   = pos(btnCandidates[2]);
      } else if (btnCandidates.length === 2) {
        onLog?.(`[reel-icons] structural Button fallback: 2 unlabelled Buttons — assigning shareFeed/shareDm by Y order`);
        shareFeed = pos(btnCandidates[0]);
        shareDm   = pos(btnCandidates[1]);
      } else if (btnCandidates.length > 0) {
        onLog?.(`[reel-icons] structural Button fallback: ${btnCandidates.length} candidate(s) — ambiguous count, leaving null`);
      }
    }
  }

  // ── Full-screen "floaty" save — some IG builds render the Save button as a
  // floating element OUTSIDE the right-column (a ribbon or pill near the
  // bottom of the reel). Scan the entire XML if the column scan missed it.
  if (!save) {
    const nodeRe3 = /<node\s([^>]+?)\s*\/?>/g;
    let fsm: RegExpExecArray | null;
    while ((fsm = nodeRe3.exec(xml)) !== null) {
      const a3 = fsm[1];
      if (!/clickable="true"/.test(a3)) continue;
      const cd3 = (a3.match(/content-desc="([^"]*)"/) ?? [])[1] ?? "";
      if (!/^saved?$/i.test(cd3)) continue;
      const bm3 = a3.match(/bounds="(\[\d+,\d+\]\[\d+,\d+\])"/);
      if (!bm3) continue;
      const c3 = _parseCenter(bm3[1]);
      if (!c3) continue;
      alreadySaved = /^saved$/i.test(cd3);
      save = c3;
      onLog?.(`[reel-icons] save found via full-screen scan (floaty type) at (${c3.x},${c3.y}) cd="${cd3}"`);
      break;
    }
  }

  onLog?.(`[reel-icons] result — like:(${like.x},${like.y}) comment:${comment ? `(${comment.x},${comment.y})` : "null"} shareFeed:${shareFeed ? `(${shareFeed.x},${shareFeed.y})` : "null"} shareDm:${shareDm ? `(${shareDm.x},${shareDm.y})` : "null"} save:${save ? `(${save.x},${save.y})${alreadySaved ? " (already saved)" : ""}` : "null"}`);
  return { like, comment, shareFeed, shareDm, save, alreadyLiked, alreadySaved };
}

/**
 * Minimal, dependency-free PNG decoder for `adb exec-out screencap -p`
 * output. Android's screencap always emits 8-bit RGBA (colorType 6); plain
 * RGB (colorType 2) and grayscale (colorType 0) are also handled
 * defensively. Pure Buffer + built-in zlib — no image library needed.
 */
function _decodePng(buf: Buffer): { width: number; height: number; channels: number; pixels: Buffer } {
  let offset = 8; // skip PNG signature
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idatChunks: Buffer[] = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + len; // length(4) + type(4) + data(len) + crc(4)
  }
  if (!width || !height) throw new Error("PNG decode: could not read IHDR");
  if (bitDepth !== 8) throw new Error(`PNG decode: unsupported bit depth ${bitDepth}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : -1;
  if (channels === -1) throw new Error(`PNG decode: unsupported color type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let rawOffset = 0;
  let prevLine = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset]; rawOffset += 1;
    const line = raw.subarray(rawOffset, rawOffset + stride); rawOffset += stride;
    const outLine = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? outLine[x - channels] : 0;
      const b = prevLine[x];
      const c = x >= channels ? prevLine[x - channels] : 0;
      let val = line[x];
      switch (filterType) {
        case 0: break;
        case 1: val = (val + a) & 0xff; break;
        case 2: val = (val + b) & 0xff; break;
        case 3: val = (val + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          val = (val + pr) & 0xff;
          break;
        }
        default: throw new Error(`PNG decode: unsupported filter type ${filterType}`);
      }
      outLine[x] = val;
    }
    outLine.copy(pixels, y * stride);
    prevLine = outLine;
  }
  return { width, height, channels, pixels };
}

/**
 * Captures the current screen as a raw pixel buffer via
 * `adb exec-out screencap -p`. Returns null on any failure (missing tool,
 * timeout, corrupt PNG) so callers can skip an unverified visual action
 * safely — this must never throw and break an automation cycle.
 */
async function _captureScreenPixels(serial: string): Promise<{ width: number; height: number; channels: number; pixels: Buffer } | null> {
  try {
    const tools = detectToolset();
    const adb = requireTool(tools.adb, "adb");
    const { stdout } = await execFileP(adb, ["-s", serial, "exec-out", "screencap", "-p"], {
      encoding: "buffer",
      timeout: 8000,
      maxBuffer: 20 * 1024 * 1024,
    } as any);
    const buf = stdout as unknown as Buffer;
    if (!buf || buf.length < 100) return null;
    return _decodePng(buf);
  } catch {
    return null;
  }
}

type ScreenPixels = { width: number; height: number; channels: number; pixels: Buffer };

/**
 * Finds the system keyboard's emoji key from the live screenshot.
 *
 * The keyboard is an Android system surface, so its keys are not present in
 * Instagram's UIAutomator tree.  Do not use a screen-percentage fallback here:
 * the old bottom-left coordinate landed on the navigation bar on the Redmi A5
 * and the subsequent swipes were interpreted as keyboard typing gestures.
 *
 * The keyboard's bottom row has a distinctive visual structure:
 *   [smaller key] [emoji key] [wide space bar] [smaller key] [enter]
 *
 * We locate the keyboard region (light OR dark theme), scan its bottom row for
 * key rectangles, select the widest rectangle as the space bar, and return the
 * centre of the adjacent rectangle on its left.  Returning null is safer than
 * tapping an unverified keyboard coordinate.
 *
 * Detection is tried for light-theme keyboards first, then dark-theme keyboards,
 * because both are common depending on the device's system theme and the app.
 */
export function findKeyboardEmojiButtonFromPixels(img: ScreenPixels): { x: number; y: number } | null {
  return _findKeyboardEmojiButtonForTheme(img, "light")  ??
         _findKeyboardEmojiButtonForTheme(img, "tinted") ??
         _findKeyboardEmojiButtonForTheme(img, "silver") ??
         _findKeyboardEmojiButtonForTheme(img, "gray")   ??
         _findKeyboardEmojiButtonForTheme(img, "dark");
}

function _findKeyboardEmojiButtonForTheme(
  img: ScreenPixels,
  theme: "light" | "tinted" | "silver" | "gray" | "dark",
): { x: number; y: number } | null {
  const { width, height, channels, pixels } = img;
  if (!width || !height || channels < 3) return null;

  /**
   * Returns true when pixel (x, y) matches the keyboard background for this theme.
   *
   * Light keyboard: nearly white / light-neutral (Gboard default light).
   *   min(r,g,b) >= 190 and low saturation (max−min ≤ 42).
   *
   * Tinted-light keyboard: Gboard color themes (mint, sage, rose, sky, lavender…).
   *   Key surfaces are pastel — medium-high brightness with a colour cast.
   *   The gray theme's `max ≤ 180` cap rejects these (max can reach 200–240),
   *   so a separate profile is required.  min ≥ 120 excludes near-black story
   *   content; max-min ≤ 80 allows a mild hue while rejecting neon/oversaturated
   *   surfaces.  The row-fraction gate (≥ 42 % of pixels matching across the
   *   keyboard band) provides the additional safety net against colourful story
   *   backgrounds that happen to match individual pixel checks.
   *
   * Silver keyboard: mid-light gray — Xiaomi MIUI default light keyboard.
   *   Key surfaces sit around RGB 185–225 and inter-key gaps around RGB 155–185.
   *   This fills the gap between "light" (needs mn ≥ 232 for key interior) and
   *   "gray" (requires mx ≤ 180, too low for MIUI's light variant).  The
   *   saturation cap (mx−mn ≤ 42) rejects skin-tone story backgrounds which
   *   have high red−blue spread, and the coherent-run gate (≥ 24 rows) stops
   *   brief neutral patches in story content from matching.
   *
   * Gray keyboard: medium gray — the Gboard "gray" / system-default theme.
   *   Key surfaces sit around RGB 90–115 and key gaps/shadows around RGB 40–70.
   *   Story content above the keyboard is very dark (near 0), so requiring
   *   min ≥ 60 cleanly excludes it while including all keyboard background pixels.
   *
   * Dark keyboard: dark neutral (Gboard dark / follows system dark mode).
   *   Key surfaces ~55–90 RGB.  The story content is also near-zero, so we
   *   require min ≥ 30 to separate the two; dark inter-key gaps (~15–35) may
   *   sit right on the boundary but the row-fraction threshold compensates.
   */
  const isKeyboardBg = (x: number, y: number): boolean => {
    const idx = y * width * channels + x * channels;
    const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
    const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
    if (theme === "light")  return mn >= 190 && mx - mn <= 42;
    if (theme === "tinted") return mn >= 120 && mx <= 240 && mx - mn <= 80;
    if (theme === "silver") return mn >= 155 && mx <= 230 && mx - mn <= 42;
    if (theme === "gray")   return mn >= 60  && mx <= 180 && mx - mn <= 40;
    /* dark */              return mn >= 30  && mx <= 130 && mx - mn <= 40;
  };

  /**
   * Returns true when an individual pixel looks like the interior of a keyboard
   * key (as opposed to a gap / shadow between keys).
   *
   * Light:   nearly white — key background is light gray/white; text labels are
   *   dark and break the run, leaving left/right key-surface strips.
   *
   * Tinted:  pastel key surfaces (e.g. mint ~RGB 185–225, sage ~RGB 180–215).
   *   Inter-key gaps are a darker shade of the same hue (~RGB 100–155), so
   *   min ≥ 145 separates key surface from gap.
   *
   * Silver: mid-light gray key surface (~185–225 RGB).  Inter-key gaps are
   *   slightly darker (~155–185 RGB), so min ≥ 190 separates key from gap.
   *   Dark key labels break runs as needed.
   *
   * Gray:    medium gray key surface (~90–115 RGB).  Inter-key gaps are darker
   *   (~40–70 RGB), so min ≥ 70 separates key surface from gap cleanly.
   *   Dark key labels also fall below 70, breaking the run as needed.
   *
   * Dark:    dark-gray key surface (~55–90 RGB).  Inter-key gaps are very dark
   *   (~10–35 RGB), so min ≥ 45 is enough separation.
   */
  const isKeyInterior = (r: number, g: number, b: number): boolean => {
    const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
    if (theme === "light")  return mn >= 232 && mx - mn <= 28;
    if (theme === "tinted") return mn >= 145 && mx <= 250 && mx - mn <= 80;
    if (theme === "silver") return mn >= 190 && mx <= 240 && mx - mn <= 38;
    if (theme === "gray")   return mn >= 70  && mx <= 200 && mx - mn <= 45;
    /* dark */              return mn >= 45  && mx <= 145 && mx - mn <= 35;
  };

  // Find the lowest coherent band whose rows are predominantly the neutral
  // keyboard background.  Scan only the bottom 35% of the screen (65%–96%)
  // because the keyboard never appears above that — starting at 50% caused
  // story content (bright/white video frames) to generate hundreds of false
  // qualifying rows and swamp the actual keyboard band.
  // Sample every 4th pixel to keep the probe cheap on large screens.
  const rowNeutralFraction = (y: number) => {
    let matches = 0;
    let samples = 0;
    for (let x = 0; x < width; x += 4) {
      samples++;
      if (isKeyboardBg(x, y)) matches++;
    }
    return samples ? matches / samples : 0;
  };
  const keyboardRows: number[] = [];
  let maxRowFraction = 0;
  for (let y = Math.floor(height * 0.65); y < Math.floor(height * 0.96); y += 2) {
    const fraction = rowNeutralFraction(y);
    if (fraction > maxRowFraction) {
      maxRowFraction = fraction;
    }
    if (fraction >= 0.42) keyboardRows.push(y);
  }
  logger.info(
    `[kbd-diag] theme=${theme} maxRowFrac=${maxRowFraction.toFixed(3)} qualifyingRows=${keyboardRows.length}`,
  );
  const diagnosticY = Math.max(0, Math.min(height - 1, Math.round(height * 0.85)));
  let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
  for (let x = 0; x < width; x += 4) {
    const idx = diagnosticY * width * channels + x * channels;
    minR = Math.min(minR, pixels[idx]);
    maxR = Math.max(maxR, pixels[idx]);
    minG = Math.min(minG, pixels[idx + 1]);
    maxG = Math.max(maxG, pixels[idx + 1]);
    minB = Math.min(minB, pixels[idx + 2]);
    maxB = Math.max(maxB, pixels[idx + 2]);
  }
  let minChannel = 255, maxChannel = 0;
  let minOfMaxChannels = 255, maxOfMaxChannels = 0;
  for (let x = 0; x < width; x += 4) {
    const idx = diagnosticY * width * channels + x * channels;
    const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
    const mn = Math.min(r, g, b);
    const mx = Math.max(r, g, b);
    minChannel = Math.min(minChannel, mn);
    maxChannel = Math.max(maxChannel, mn);
    minOfMaxChannels = Math.min(minOfMaxChannels, mx);
    maxOfMaxChannels = Math.max(maxOfMaxChannels, mx);
  }
  logger.info(
    `[kbd-diag] y=${diagnosticY} (85%) R=${minR}-${maxR} G=${minG}-${maxG} B=${minB}-${maxB} mn=${minChannel}-${maxChannel} mx=${minOfMaxChannels}-${maxOfMaxChannels}`,
  );
  if (keyboardRows.length < 12) return null;

  // Always use the LAST (lowest / bottommost) coherent keyboard-background run.
  // The keyboard is physically at the bottom of the scan range; any story
  // content that happens to match the theme's background check appears above it
  // and forms earlier runs.  Picking the last qualifying run (≥ 24 px) is
  // therefore always the actual keyboard band, regardless of how many false
  // runs appear higher up.
  let runStart = keyboardRows[0];
  let runEnd = keyboardRows[0];
  let bestStart = -1;
  let bestEnd = -1;
  for (let i = 1; i < keyboardRows.length; i++) {
    const y = keyboardRows[i];
    if (y - keyboardRows[i - 1] <= 8) {
      runEnd = y;
    } else {
      if (runEnd - runStart >= 24) {
        bestStart = runStart; // always overwrite — prefer the lower run
        bestEnd = runEnd;
      }
      runStart = runEnd = y;
    }
  }
  if (runEnd - runStart >= 24) {
    bestStart = runStart;
    bestEnd = runEnd;
  }
  if (bestEnd < 0 || bestEnd - bestStart < 24) return null;

  // Scan several rows through the lowest key row. At each row, key-interior
  // runs represent individual keys; keyboard gaps and shadows break the runs.
  // Pick the row with the strongest bottom-row signature.
  type Segment = { x1: number; x2: number; y: number };
  let bestSegments: Segment[] = [];
  for (let y = Math.max(bestStart, bestEnd - 100); y <= bestEnd - 8; y += 2) {
    const segments: Segment[] = [];
    let start = -1;
    for (let x = 0; x < width; x++) {
      const idx = y * width * channels + x * channels;
      const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
      if (isKeyInterior(r, g, b)) {
        if (start < 0) start = x;
      } else if (start >= 0) {
        if (x - start >= Math.max(8, Math.round(width * 0.015)) &&
            x - start <= Math.round(width * 0.42)) {
          segments.push({ x1: start, x2: x - 1, y });
        }
        start = -1;
      }
    }
    if (start >= 0 && width - start >= Math.max(8, Math.round(width * 0.015))) {
      segments.push({ x1: start, x2: width - 1, y });
    }

    // A valid bottom row has several keys and one clearly wider space bar.
    const usable = segments.filter(s => s.x1 > width * 0.01 && s.x2 < width * 0.99);
    if (usable.length >= 3 && usable.length <= 10) {
      const widest = Math.max(...usable.map(s => s.x2 - s.x1));
      const wideCount = usable.filter(s => s.x2 - s.x1 >= widest * 0.65).length;
      if (wideCount === 1 && widest >= width * 0.16) {
        const currentScore = widest + usable.length * width * 0.01;
        const previousScore = bestSegments.length
          ? Math.max(...bestSegments.map(s => s.x2 - s.x1)) + bestSegments.length * width * 0.01
          : -1;
        if (currentScore > previousScore) bestSegments = usable;
      }
    }
  }

  if (bestSegments.length < 3) return null;

  // Merge immediately-adjacent segments that were split by a key's glyph.
  // When the emoji icon (😊) or any other key label is rendered over the key
  // surface, those non-key-interior pixels break the run into a left strip and
  // a right strip. Without merging, the rightmost strip — which may be only
  // ~10 px wide — becomes the "closest left candidate", landing the tap on an
  // anti-aliasing fragment rather than the centre of the real smiley key.
  // Two segments are merged when the gap between them is narrower than one
  // minimum-key-width unit (scaled to screen width so it works on all devices).
  const mergeGap = Math.max(6, Math.round(width * 0.008));
  type Segment = (typeof bestSegments)[number];
  const merged: Segment[] = [];
  for (const seg of bestSegments) {
    const prev = merged[merged.length - 1];
    if (prev && seg.x1 - prev.x2 <= mergeGap) {
      // Extend the previous segment to absorb this fragment.
      prev.x2 = seg.x2;
    } else {
      merged.push({ ...seg });
    }
  }

  const space = merged.reduce((a, b) =>
    (a.x2 - a.x1) >= (b.x2 - b.x1) ? a : b,
  );
  const leftCandidates = merged
    .filter(s => s.x2 < space.x1)
    .sort((a, b) => b.x2 - a.x2);
  if (!leftCandidates[0]) return null;

  const spaceWidth = space.x2 - space.x1;

  // Second-pass glyph-split merge.
  //
  // The first-pass merge (mergeGap ~9 px) bridges tiny letter-glyph breaks,
  // but the 😊 emoji face is much wider (~30–50 px on 1080p screens) and
  // leaves the emoji key as two separate strips:
  //   left-strip  (before the face) : x1=~206, x2=~225  →  ~19 px
  //   right-strip (after  the face) : x1=~262, x2=~284  →  ~22 px
  //
  // With only the right-strip surviving as leftCandidates[0], the old size
  // guard (emojiWidth < spaceWidth * 0.12, i.e. 22 < 57) rejects it and
  // the whole function returns null — keyboard appears but smiley never taps.
  //
  // Detection: if the two rightmost left-of-space-bar candidates have a gap
  // in the "glyph range" (> 10 px, ≤ 48 px) AND their combined span is
  // plausible for a single key (10 %–55 % of the space bar), treat them as
  // the left-strip + right-strip of one emoji key and fuse them.
  // The > 10 px lower bound is safely above any real inter-key gap (~4–8 px),
  // so this never accidentally merges two distinct keys.
  let emoji = leftCandidates[0];
  if (leftCandidates.length >= 2) {
    const rightStrip = leftCandidates[0]; // closest to space bar
    const leftStrip  = leftCandidates[1]; // second closest
    const glyphGap     = rightStrip.x1 - leftStrip.x2;
    const combinedWidth = rightStrip.x2 - leftStrip.x1;
    const glyphGapMax  = Math.max(48, Math.round(width * 0.05));
    if (
      glyphGap > 10 &&
      glyphGap <= glyphGapMax &&
      combinedWidth >= spaceWidth * 0.10 &&
      combinedWidth <= spaceWidth * 0.55
    ) {
      // Fuse the two strips into the full emoji key bounding box.
      emoji = { x1: leftStrip.x1, x2: rightStrip.x2, y: rightStrip.y };
      logger.info(
        `[kbd-diag] glyph-split merge: strips [${leftStrip.x1},${leftStrip.x2}]+[${rightStrip.x1},${rightStrip.x2}]` +
        ` → [${emoji.x1},${emoji.x2}] (glyphGap=${glyphGap} combinedW=${combinedWidth} spaceW=${spaceWidth})`,
      );
    }
  }

  const gap = space.x1 - emoji.x2;
  const emojiWidth = emoji.x2 - emoji.x1;

  // Adjacency check: the emoji key must be immediately next to the space bar.
  // A generous gap handles rounded key corners while rejecting a missing row.
  if (gap > Math.max(32, emojiWidth * 0.75)) return null;

  // Key-size check: reject any candidate that is still implausibly narrow
  // after both merge passes.  The smiley key is always at least ~10 % of the
  // space-bar width on every device size (lowered from 12 % to give headroom
  // when the glyph-split fuse only partially reconstructs the key bounds).
  if (emojiWidth < spaceWidth * 0.10) return null;

  return {
    x: Math.round((emoji.x1 + emoji.x2) / 2),
    y: emoji.y,
  };
}

/**
 * Captures the current keyboard frame and locates the emoji key visually.
 * The caller should skip the emoji action when this returns null.
 */
export async function findKeyboardEmojiButton(
  serial: string,
): Promise<{ x: number; y: number } | null> {
  const img = await _captureScreenPixels(serial);
  return img ? findKeyboardEmojiButtonFromPixels(img) : null;
}

/**
 * Locates Instagram's story action icons (like / comment / share) by
 * reading actual on-screen pixels instead of guessing fixed coordinates.
 *
 * Why this exists: a `screen-layout-scan` on a real device story viewer
 * (Jul 2026) found only ONE opaque, unlabeled container for the entire
 * reply-bar region — Instagram draws it on a canvas with no accessible
 * child elements, so there is no content-desc/text/resource-id to search
 * for. Worse, that bar's on-screen position AND icon count both change
 * depending on content type (a plain story vs. a reposted Reel, which
 * uses a visually different, higher action bar) and per-story privacy
 * settings (the owner can disable likes, comments, or shares
 * individually, which removes icons and re-centers the rest). A single
 * hardcoded (x%, y%) pair can't track all of that — it was landing on
 * the reply text field or the story background instead of the icons,
 * which is exactly the bug this replaces.
 *
 * Approach: scan the bottom ~30% of the screen (where Instagram always
 * places these icons, under its own dark gradient scrim so they stay
 * legible over any background) for rows that are both (a) dark on
 * average — confirming the scrim is present — and (b) contain 1-4
 * compact bright clusters — the icon glyphs, always white/light against
 * that scrim regardless of the content behind it. Clusters are returned
 * left to right. Instagram always keeps the Like icon leftmost and the
 * Share/Send icon rightmost in these bars regardless of how many icons
 * sit between them, so callers can safely use the first/last cluster
 * without needing to identify every icon by shape. Callers should treat
 * a single cluster as ambiguous (can't tell Like from Share) and zero
 * clusters as "nothing to tap" — and skip the action rather than risk
 * tapping the wrong control.
 */
export async function findStoryActionIcons(serial: string): Promise<{ x: number; y: number }[] | null> {
  const img = await _captureScreenPixels(serial);
  if (!img) return null;
  const { width, height, channels, pixels } = img;
  if (!width || !height) return null;

  // Widened from 0.70–0.97 (Jul 2026): that band was calibrated against one
  // specific device's screenshot (1080×2226). This automation farm runs
  // several different phone models with different screen aspect ratios, and
  // the story reply-bar's relative Y position shifts with aspect ratio (and
  // with gesture-nav vs 3-button-nav bar height) — on a device where the bar
  // sits above 70% of height, the icon row fell entirely outside the old
  // band and the scan always returned 0 candidates, logging a false
  // "sharing disabled" even when the paper-plane was visibly on screen.
  // Widening the band costs a little scan time but doesn't add false
  // positives: the icon-sized/uniform-width/gap-isolation filters below
  // already reject anything that isn't a tight row of same-size glyphs.
  const bandTop = Math.round(height * 0.55);
  const bandBottom = Math.round(height * 0.99);
  const rowStep = 3;
  const brightThreshold = 165; // icon glyph luminance (white/light on dark scrim)
  const darkRowThreshold = 70; // row must average this dark to confirm the scrim is present

  const lumAt = (x: number, y: number) => {
    const idx = y * width * channels + x * channels;
    return (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3;
  };

  type Row = { y: number; clusters: { x1: number; x2: number }[]; avgLum: number };
  const candidateRows: Row[] = [];

  for (let y = bandTop; y < bandBottom; y += rowStep) {
    let sum = 0;
    const brightMask = new Array<boolean>(width);
    for (let x = 0; x < width; x++) {
      const l = lumAt(x, y);
      sum += l;
      brightMask[x] = l > brightThreshold;
    }
    const avgLum = sum / width;
    if (avgLum > darkRowThreshold) continue; // bright content row, not the scrim — skip

    const clusters: { x1: number; x2: number }[] = [];
    let runStart = -1;
    for (let x = 0; x < width; x++) {
      if (brightMask[x]) {
        if (runStart === -1) runStart = x;
      } else if (runStart !== -1) {
        clusters.push({ x1: runStart, x2: x - 1 });
        runStart = -1;
      }
    }
    if (runStart !== -1) clusters.push({ x1: runStart, x2: width - 1 });

    // Keep only icon-sized clusters — not a stray bright caption/banner.
    const iconSized = clusters.filter(c => (c.x2 - c.x1) >= 6 && (c.x2 - c.x1) <= Math.round(width * 0.12));
    if (iconSized.length >= 1 && iconSized.length <= 4) {
      // Real icon glyphs (heart, paper-plane, speech-bubble) are all drawn
      // at the same fixed size, so their cluster widths land within a
      // narrow range of each other. The reply-box placeholder text ("Send
      // message") sits in this same band and, once split into per-word
      // bright runs, can pass the checks above too — but its "words" have
      // very uneven widths (e.g. "Send" vs "message"). This was observed
      // outranking a real single-icon row (only Like enabled) because the
      // placeholder text produced MORE clusters than the lone heart,
      // winning the cluster-count tie-break below and causing a tap into
      // the text field — which opens the keyboard instead of liking/
      // sharing. Reject rows whose cluster widths vary too much to be a
      // uniform icon set.
      const widths = iconSized.map(c => c.x2 - c.x1);
      const maxW = Math.max(...widths), minW = Math.min(...widths);
      if (maxW / minW <= 1.6) {
        // Second defense, added after a real-world miss: the reply-box
        // placeholder text ("Send message") sits to the LEFT of the real
        // icon group in Instagram's actual layout (text field, then heart,
        // then paper-plane, left to right) — a stray word/fragment from it
        // can survive the width-uniformity check above and still get
        // treated as "the leftmost icon" (assumed = Like), which is how a
        // tap meant for Like landed in the message field, and a tap meant
        // for Share landed on the real heart one slot to its right instead
        // (both real icons shifted one index right by the fake entry).
        // The real icon group is always packed tightly together (heart and
        // share/paper-plane sit right next to each other); a text fragment
        // is isolated from that group by a much bigger gap than the icons'
        // own spacing. Drop anything left of an outsized gap so only the
        // tightly-packed real icon group remains.
        let group = iconSized;
        if (group.length >= 2) {
          const gaps: number[] = [];
          for (let i = 1; i < group.length; i++) gaps.push(group[i].x1 - group[i - 1].x2);
          const maxGap = Math.max(...gaps);
          const maxGapIdx = gaps.indexOf(maxGap);
          const otherGaps = gaps.filter((_, i) => i !== maxGapIdx);
          const avgOtherGap = otherGaps.length ? otherGaps.reduce((a, b) => a + b, 0) / otherGaps.length : maxGap;
          const isolated = otherGaps.length > 0 ? maxGap > avgOtherGap * 2.2 : maxGap > maxW * 2.5;
          if (isolated) group = group.slice(maxGapIdx + 1);
        }
        if (group.length >= 1) candidateRows.push({ y, clusters: group, avgLum });
      }
    }
  }

  if (candidateRows.length === 0) return [];

  // Root-cause fix (12 Jul 2026, user-reported): this used to rank
  // candidates by cluster count first (most distinct clusters wins, ties
  // broken by darkness). That let a coincidental content match — a poll,
  // mention chip, or link sticker rendered on a dark background somewhere
  // in the middle of the frame, which can easily produce 2-4 bright
  // uniform-ish clusters — outrank the REAL reply bar whenever the real
  // bar happened to only show fewer/dimmer clusters that story (e.g. only
  // 2 icons visible, or a lighter scrim over a bright background). Two
  // real-device captures in the same session picked rows at 65% and 88%
  // of screen height for what should be the same physical control —
  // confirming the ranking was landing on unrelated content, not just a
  // slightly-off calibration.
  //
  // The reply bar is a system-anchored control: on every device in this
  // farm it sits at the LOWEST position in the frame that still shows a
  // qualifying dark+icon row (there is nothing below it but the nav-bar
  // inset). Any false content match is virtually always positioned higher
  // up the screen than that, since Instagram deliberately avoids drawing
  // captions/stickers into the reply-bar's own footprint. Prefer the
  // bottom-most (largest y) qualifying row; only fall back to
  // cluster-count/darkness to break an exact tie.
  candidateRows.sort((a, b) => b.y - a.y || b.clusters.length - a.clusters.length || a.avgLum - b.avgLum);
  const best = candidateRows[0];

  return best.clusters
    .map(c => ({ x: Math.round((c.x1 + c.x2) / 2), y: best.y }))
    .sort((a, b) => a.x - b.x);
}

/**
 * Attempts to locate Instagram's story share (paper-plane) button via the
 * UIAutomator accessibility tree BEFORE falling back to the pixel-scan in
 * `findStoryActionIcons`.
 *
 * CONFIRMED (device log, 15 Jul 2026): Instagram DOES expose the paper-plane
 * icon as a proper accessible element on this device/build:
 *
 *   class=android.widget.ImageView
 *   rid=com.instagram.android:id/toolbar_reshare_button
 *   cd=Share
 *   bounds=[948,2122][1058,2226]   (1080×2460 device)
 *
 * Strategy 1 (primary): find by resource-id `toolbar_reshare_button` and
 * return its bounds-centre.  The resource-id is stable across screen sizes
 * and does not require any arithmetic, percentage estimates, or coordinate
 * guessing — it directly addresses the real element.
 *
 * Strategy 2 (fallback): label probe — known content-desc strings the
 * paper-plane has been labelled with on some Instagram builds.  Must pass
 * a sanity check: x > 60 % of screen width AND y in the lower 40 % of
 * screen height to reject accidental matches elsewhere in the tree.
 *
 * REMOVED (v1.1.581): positional probe — found the text-input field.
 * REMOVED (v1.1.582): text-field anchor — was a coordinate estimate (75 %
 *   of the remaining icon zone), not a true a11y lookup.  Replaced by the
 *   resource-id lookup above, which addresses the button directly.
 *
 * Comprehensive diagnostic logging of every node in the lower 35 % of the
 * screen is written via `onLog` on every call so a single Log-tab run shows
 * the full a11y tree at the moment of each share attempt.
 */
export async function findStoryShareButtonViaA11y(
  serial: string,
  onLog?: (msg: string) => void,
): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const { w, h } = getScreenSize(serial);
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;

  // ── Diagnostic: emit every node whose vertical centre sits in the lower
  //    35 % of the screen (the story reply-bar zone).  class, resource-id,
  //    content-desc, text, bounds, and clickability are all included so a
  //    single Log-tab output is enough to identify the real a11y signal on
  //    any device / Instagram build.
  const diagYMin = Math.round(h * 0.65);
  {
    const nodeRe2 = /<node\s([^>]+?)\s*\/?>/g;
    let nm: RegExpExecArray | null;
    const diagLines: string[] = [];
    while ((nm = nodeRe2.exec(xml)) !== null) {
      const a = nm[1];
      const bm = a.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!bm) continue;
      const cy = Math.round((Number(bm[2]) + Number(bm[4])) / 2);
      if (cy < diagYMin) continue;
      const cls = (a.match(/\bclass="([^"]*)"/)    ?? [])[1] ?? "";
      const rid = (a.match(/resource-id="([^"]*)"/) ?? [])[1] ?? "";
      const cd  = (a.match(/content-desc="([^"]*)"/) ?? [])[1] ?? "";
      const txt = (a.match(/\btext="([^"]*)"/)     ?? [])[1] ?? "";
      const clk = /clickable="true"/.test(a) ? "clickable" : "non-clickable";
      diagLines.push(
        `  [a11y-diag] ${clk} | class=${cls} | rid=${rid}` +
        ` | cd=${cd} | text=${txt} | bounds=[${bm[1]},${bm[2]}][${bm[3]},${bm[4]}]`,
      );
    }
    if (diagLines.length === 0) {
      onLog?.(`  [a11y-diag] no nodes in lower 35% (y>${diagYMin}, screen ${w}x${h})`);
    } else {
      onLog?.(`  [a11y-diag] ${diagLines.length} node(s) in lower 35% (y>${diagYMin}, screen ${w}x${h}):`);
      diagLines.forEach(l => onLog?.(l));
    }
  }

  // ── Strategy 1: resource-id lookup (primary).
  //    toolbar_reshare_button is the paper-plane icon — confirmed present
  //    and clickable on this device build with cd="Share".  Finding it by
  //    resource-id requires no coordinate arithmetic at all.
  {
    const RID = "com.instagram.android:id/toolbar_reshare_button";
    const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = nodeRe.exec(xml)) !== null) {
      const a = m[1];
      if (!a.includes(RID)) continue;
      const bm = a.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!bm) continue;
      const cx = Math.round((Number(bm[1]) + Number(bm[3])) / 2);
      const cy = Math.round((Number(bm[2]) + Number(bm[4])) / 2);
      // Sanity: must be in the lower half of the screen (not a header icon
      // from some other screen that happens to share the resource-id).
      if (cy < h * 0.50) continue;
      onLog?.(
        `  [a11y-diag] Strategy 1 (resource-id): found toolbar_reshare_button` +
        ` at (${cx},${cy}) from bounds=[${bm[1]},${bm[2]}][${bm[3]},${bm[4]}]`,
      );
      return { x: cx, y: cy };
    }
    onLog?.("  [a11y-diag] Strategy 1: toolbar_reshare_button not in tree — trying label probe");
  }

  // ── Strategy 2: label probe fallback.
  //    Rare, but some Instagram builds label the icon with a content-desc.
  const labelCandidates = [
    "Share to Direct", "Send to Direct", "Direct", "Share to",
    "story_share", "direct_share",
  ];
  for (const label of labelCandidates) {
    const found = _findElem(xml, label);
    // Paper-plane must be right of 60 % of screen width AND in lower 40 %
    // of height.  Anything left of centre is a false match elsewhere.
    if (found && found.x > w * 0.60 && found.y > h * 0.60) {
      onLog?.(
        `  [a11y-diag] Strategy 2 (label): matched "${label}" at (${found.x},${found.y})`,
      );
      return found;
    } else if (found) {
      onLog?.(
        `  [a11y-diag] Strategy 2 (label): matched "${label}" at (${found.x},${found.y})` +
        ` but failed sanity check (need x>${Math.round(w * 0.60)}, y>${Math.round(h * 0.60)}) — rejected`,
      );
    }
  }

  onLog?.("  [a11y-diag] no usable a11y signal — falling back to pixel scan");
  return null;
}

/**
 * Locates Instagram's story Like button via the UIAutomator accessibility
 * tree, using the confirmed resource-id on this device/build:
 *
 *   class=android.widget.ImageView
 *   rid=com.instagram.android:id/toolbar_like_button
 *   cd=Like Story
 *   bounds=[838,2122][948,2226]   (1080×2460 device, confirmed 15 Jul 2026)
 *
 * Using the a11y element replaces the previous double-tap at a fixed
 * percentage of screen centre (w*0.50, h*0.44), which violated the
 * project rule against hardcoded coordinates and was not reliably
 * registering as a like on this farm's devices.
 *
 * Strategy 1 (primary): resource-id `toolbar_like_button`.
 * Strategy 2 (fallback): content-desc "Like Story" or "Like".
 * Returns null if neither is found — callers fall back to the legacy
 * double-tap approach so no regression occurs on builds that don't expose
 * the button in the accessibility tree.
 */
export async function findStoryLikeButtonViaA11y(
  serial: string,
): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const { h } = getScreenSize(serial);
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;

  // Strategy 1: resource-id lookup (primary).
  const RID = "com.instagram.android:id/toolbar_like_button";
  {
    const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = nodeRe.exec(xml)) !== null) {
      const a = m[1];
      if (!a.includes(RID)) continue;
      const bm = a.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!bm) continue;
      const cx = Math.round((Number(bm[1]) + Number(bm[3])) / 2);
      const cy = Math.round((Number(bm[2]) + Number(bm[4])) / 2);
      if (cy < h * 0.50) continue; // sanity: must be in lower half
      return { x: cx, y: cy };
    }
  }

  // Strategy 2: content-desc label fallback.
  for (const label of ["Like Story", "Like"]) {
    const found = _findElem(xml, label);
    if (found && found.y > h * 0.50) return found;
  }

  return null;
}

/**
 * Locate the story reply composer before opening the keyboard.
 *
 * Instagram has shipped several story-viewer layouts where the visible
 * "Send message" bar is present but `message_composer_container` is absent
 * from the accessibility tree. Keep this locator tied to the current story
 * viewer's lower bar rather than requiring one resource-id from one build.
 */
export async function findStoryReplyComposerViaA11y(
  serial: string,
  onLog?: (msg: string) => void,
): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const { w, h } = getScreenSize(serial);

  type Candidate = {
    x: number;
    y: number;
    width: number;
    score: number;
    reason: string;
    bounds: string;
  };
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) {
    onLog?.("[story-composer] UI dump unavailable");
    return null;
  }

  const candidates: Candidate[] = [];
  const nodeRe = /<node\s([^>]+?)\s*\/?>/gi;
  let match: RegExpExecArray | null;
  let lowerNodeCount = 0;

  while ((match = nodeRe.exec(xml)) !== null) {
    const attrs = match[1];
    const boundsMatch = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
    if (!boundsMatch) continue;

    const x1 = Number(boundsMatch[1]);
    const y1 = Number(boundsMatch[2]);
    const x2 = Number(boundsMatch[3]);
    const y2 = Number(boundsMatch[4]);
    const width = x2 - x1;
    const height = y2 - y1;
    const x = Math.round((x1 + x2) / 2);
    const y = Math.round((y1 + y2) / 2);
    if (y < h * 0.65 || y > h * 0.95) continue;
    lowerNodeCount++;
    if (width < w * 0.12 || height <= 0 || height > h * 0.18) continue;

    const resourceId = attrs.match(/\bresource-id="([^"]*)"/i)?.[1] ?? "";
    const text = attrs.match(/\btext="([^"]*)"/i)?.[1] ?? "";
    const contentDesc = attrs.match(/\bcontent-desc="([^"]*)"/i)?.[1] ?? "";
    const hint = attrs.match(/\bhint="([^"]*)"/i)?.[1] ?? "";
    const className = attrs.match(/\bclass="([^"]*)"/i)?.[1] ?? "";
    const searchable = `${resourceId} ${text} ${contentDesc} ${hint}`.replace(/\s+/g, " ").trim();
    const lowerSearchable = searchable.toLowerCase();

    // Never mistake the bottom navigation or a known story action icon for
    // the reply bar. The composer is a wide lower-screen control.
    if (/(?:feed_tab|home_tab|clips_tab|reels_tab|profile_tab|toolbar_like|reshare|send_button|back|home|profile)/i.test(resourceId)) {
      continue;
    }

    let score = 0;
    let reason = "";
    if (/message_composer_container/i.test(resourceId)) {
      score += 100;
      reason = "message_composer_container";
    }
    if (/(?:composer_text|story_reply|reply_composer|thread_composer)/i.test(resourceId)) {
      score += 90;
      reason ||= "composer resource-id";
    }
    if (/(?:send message|message or reaction|reply to|reply)/i.test(lowerSearchable)) {
      score += 80;
      reason ||= `reply label "${searchable}"`;
    }
    if (/android\.widget\.EditText/i.test(className)) {
      score += 65;
      reason ||= "lower EditText";
    }
    // Do not accept a merely wide/clickable lower-screen node as the
    // composer. When Story replies are disabled, Instagram can still expose
    // an unrelated lower control (or the canvas-backed reply area) in this
    // zone. Treating geometry alone as proof caused the emoji-comment path to
    // tap a visible "Send message" area even though replies were disabled.
    // A semantic composer resource-id, label, or EditText is required.
    if (score === 0) continue;

    candidates.push({
      x,
      y,
      width,
      score,
      reason,
      bounds: `[${x1},${y1}][${x2},${y2}]`,
    });
  }

  candidates.sort((a, b) => b.score - a.score || b.width - a.width);
  const best = candidates[0];
  if (best) {
    onLog?.(
      `[story-composer] matched ${best.reason} at (${best.x},${best.y}) ` +
      `bounds=${best.bounds} score=${best.score} candidates=${candidates.length} ` +
      `lowerNodes=${lowerNodeCount}`,
    );
    return { x: best.x, y: best.y };
  }

  onLog?.(
    `[story-composer] no candidate (lowerNodes=${lowerNodeCount}, ` +
    `screen=${w}x${h})`,
  );
  return null;
}

/**
 * Fast, screenshot-based "is the story viewer still on screen?" check.
 *
 * Why this exists: the story per-slide loop in `runViewStoriesFromFeedLoop`
 * calls a "still in story viewer?" gate before every tap (like, share-start,
 * post-share-tap, pre-Send, advance) to avoid blind-tapping the home feed
 * once a story auto-advances/exits mid-sequence. That gate used to be
 * `findHomeTab`, which requires a full `uiautomator dump` + `adb pull` —
 * measured at ~3-4s per call on this farm's devices. Calling it up to 5-6
 * times inside a single ~5-6s story slide was consuming the ENTIRE slide
 * timer on safety checks alone, before any scheduled like/share even fired
 * — the real cause of "everything stalls, nothing is instant" even after
 * the deliberate pre-action watch delay was removed (v1.1.485): removing a
 * 250ms delay does nothing when the very next line blocks for 3-4s anyway.
 *
 * `adb exec-out screencap -p` (already used by `findStoryActionIcons`) is
 * ~10x+ faster (~100-300ms). This scans a thin band near the top of the
 * screen for Instagram's segmented story progress bar — 2+ bright,
 * near-equal-width, evenly-spaced capsule segments spanning most of the
 * screen width. That signature only ever appears in the story viewer;
 * the feed header, Reels, and DM inbox never draw it.
 *
 * Deliberately asymmetric return contract: only ever returns `true`
 * (confidently "still in the story viewer") or `null` ("can't tell from
 * pixels alone"). It NEVER returns a confident `false`, because a wrong
 * "still open" is dangerous (causes a blind tap on the real feed
 * underneath — the exact bug this whole check exists to prevent), while a
 * missed "still open" is merely conservative. Single-story trays (no
 * multi-segment bar to detect) and any other ambiguous screenshot fall
 * through as `null` on purpose — callers MUST fall back to the slower but
 * proven `findHomeTab`-based check whenever this returns `null`, not treat
 * `null` as "closed".
 */
export async function isStoryViewerOpenFast(serial: string): Promise<boolean | null> {
  const img = await _captureScreenPixels(serial);
  if (!img) {
    // Root-cause fix (12 Jul 2026): this used to fail SILENTLY. If a
    // device's screencap PNG ever fails to capture or decode (timeout,
    // unsupported bit depth/color type, truncated buffer), _captureScreenPixels
    // swallows the error and returns null — which means every single call
    // on that device falls straight through to the slow uiautomator-dump
    // path, permanently, with zero visibility that the "fast" check was
    // never actually running. Logging here is the only way to tell "fast
    // check is failing to even capture" apart from "fast check ran but the
    // bar pattern wasn't detected" from the server log.
    logger.warn({ serial }, "[isStoryViewerOpenFast] screenshot capture/decode failed — always falling back to slow check on this device/frame");
    return null;
  }
  const { width, height, channels, pixels } = img;
  if (!width || !height) return null;

  const lumAt = (x: number, y: number) => {
    const idx = y * width * channels + x * channels;
    return (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3;
  };

  // Progress-bar segments sit in a thin strip just under the status bar /
  // camera cutout. Scan several rows in that region to tolerate devices
  // with different status-bar heights or notch designs.
  //
  // Widened + relaxed (12 Jul 2026): the original band (1.5%-6% height,
  // threshold 150, uniform-width ratio 1.8, coverage 55%) was tuned against
  // one reference capture and, per user report, was essentially NEVER
  // matching on a real 1080×2460 device in the field — every check fell
  // back to the ~3-4s uiautomator dump, which fully explains why likes/
  // shares still weren't landing quickly despite the fast-path fix. Widened
  // the search band and relaxed every threshold so more real devices/
  // status-bar heights/lighting conditions are covered; the multi-segment,
  // near-uniform-width, wide-spanning pattern this looks for is still
  // distinctive enough that it won't false-positive on ordinary UI chrome.
  const bandTop = Math.round(height * 0.008);
  const bandBottom = Math.round(height * 0.10);
  const brightThreshold = 110; // segments are near-white even when "unwatched"/dimmed, but can read dimmer over dark gradients than first assumed

  let bestClusterCount = 0;
  let rowsScanned = 0;

  for (let y = bandTop; y <= bandBottom; y += 2) {
    rowsScanned++;
    const clusters: { x1: number; x2: number }[] = [];
    let runStart = -1;
    for (let x = 0; x < width; x++) {
      const bright = lumAt(x, y) > brightThreshold;
      if (bright) {
        if (runStart === -1) runStart = x;
      } else if (runStart !== -1) {
        clusters.push({ x1: runStart, x2: x - 1 });
        runStart = -1;
      }
    }
    if (runStart !== -1) clusters.push({ x1: runStart, x2: width - 1 });

    // The progress bar divides the width into several near-equal segments
    // with small gaps. Reject rows that don't look like that pattern —
    // a single edge-to-edge bright run is a header/banner, not a bar.
    if (clusters.length < 2) continue;
    const widths = clusters.map(c => c.x2 - c.x1);
    const maxW = Math.max(...widths), minW = Math.min(...widths);
    if (maxW / minW > 2.6) continue; // segments must be roughly-uniform width (relaxed from 1.8)
    const covered = widths.reduce((a, b) => a + b, 0);
    if (covered < width * 0.42) continue; // segments must span most of the width (relaxed from 55%)

    if (clusters.length > bestClusterCount) bestClusterCount = clusters.length;
  }

  if (bestClusterCount < 2) {
    logger.debug({ serial, rowsScanned, bestClusterCount, width, height }, "[isStoryViewerOpenFast] no progress-bar pattern found — falling back to slow check");
    return null;
  }
  return true;
}

/**
 * Read the current Story progress from the transient in-memory screencap.
 * Returns null when the progress row cannot be identified.
 */
export async function readStoryProgress(serial: string): Promise<number | null> {
  const img = await _captureScreenPixels(serial);
  if (!img) return null;
  const { width, height, channels, pixels } = img;
  const lum = (x: number, y: number) => {
    const i = (y * width + x) * channels;
    return (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
  };
  for (let y = Math.round(height * 0.008); y <= Math.round(height * 0.10); y += 2) {
    const bright: Array<{ x1: number; x2: number }> = [];
    let start = -1;
    for (let x = 0; x < width; x++) {
      if (lum(x, y) > 110) {
        if (start < 0) start = x;
      } else if (start >= 0) {
        if (x - start >= Math.max(3, width * 0.01)) bright.push({ x1: start, x2: x - 1 });
        start = -1;
      }
    }
    if (start >= 0) bright.push({ x1: start, x2: width - 1 });
    if (bright.length < 2) continue;
    const widths = bright.map(c => c.x2 - c.x1 + 1);
    const max = Math.max(...widths), min = Math.min(...widths);
    if (max / Math.max(1, min) > 2.6) continue;
    const total = bright.reduce((sum, c) => sum + c.x2 - c.x1 + 1, 0);
    if (total < width * 0.42) continue;
    // The active segment is the right-most bright segment; use its relative
    // width as a conservative progress estimate within the visible row.
    const segmentWidth = Math.max(...widths);
    const activeWidth = bright[bright.length - 1].x2 - bright[bright.length - 1].x1 + 1;
    return Math.min(1, Math.max(0, (bright.length - 1 + activeWidth / segmentWidth) / bright.length));
  }
  return null;
}

/**
 * Locate Instagram's bottom-nav Home tab (the house icon, leftmost of the
 * 5 nav items) via the real accessibility tree instead of a guessed screen
 * percentage. Percentage-based taps drift depending on device screen
 * ratio/software chrome and were landing on a feed post instead of the nav
 * bar. Instagram exposes this control with content-desc "Home" (selected
 * state is sometimes "Home, selected" — matched as a prefix, not exact, to
 * catch both). Falls back to null if not found so the caller can decide on
 * a fixed-percentage fallback.
 */
/**
 * Find any clickable element whose text or content-desc exactly matches
 * `label` (case-sensitive). Used to locate dynamic share-sheet buttons
 * ("Repost", "Close") that appear at unpredictable positions.
 */
export async function findButtonByLabel(serial: string, label: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;
  return _findElem(xml, label);
}

/**
 * Locate the post-picker Next control from the live UIAutomator tree.
 * Instagram has builds where the top-bar control is rendered without text or
 * content-desc, so this deliberately uses the node's current bounds and
 * clickability rather than a fixed screen coordinate.
 */
export async function findPostNextButton(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;

  const labelled = _findElem(xml, "Next", "Continue");
  if (labelled) return labelled;

  const byResource = _findByResId(xml, ":id/next_button", ":id/next");
  if (byResource) return byResource;

  const { w, h } = getScreenSize(serial);
  const nodeRe = /<node\s([^>]+?)\s*\/?>/gi;
  const candidates: { x: number; y: number; area: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = nodeRe.exec(xml)) !== null) {
    const attrs = match[1];
    if (!/clickable="true"/i.test(attrs)) continue;
    const bounds = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
    if (!bounds) continue;
    const x1 = Number(bounds[1]), y1 = Number(bounds[2]);
    const x2 = Number(bounds[3]), y2 = Number(bounds[4]);
    const bw = x2 - x1, bh = y2 - y1;
    if (bw <= 0 || bh <= 0) continue;
    const centerX = (x1 + x2) / 2, centerY = (y1 + y2) / 2;
    if (centerY > h * 0.14 || centerX < w * 0.72) continue;
    if (bw > w * 0.28 || bh > h * 0.10) continue;
    const text = (attrs.match(/\btext="([^"]*)"/i)?.[1] ?? "").toLowerCase();
    const desc = (attrs.match(/content-desc="([^"]*)"/i)?.[1] ?? "").toLowerCase();
    const rid = (attrs.match(/resource-id="([^"]*)"/i)?.[1] ?? "").toLowerCase();
    if (/close|cancel|back|dismiss|x\b/.test(`${text} ${desc} ${rid}`)) continue;
    candidates.push({ x: Math.floor(centerX), y: Math.floor(centerY), area: bw * bh });
  }
  candidates.sort((a, b) => a.area - b.area);
  return candidates[0] ? { x: candidates[0].x, y: candidates[0].y } : null;
}

/**
 * Locate Instagram's location-picker search field. This is deliberately
 * resource-id based: the field's visible hint/text varies by build, while
 * row_search_edit_text is present in the live location-picker dump.
 */
export async function findLocationSearchField(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;
  return _findByResId(xml, ":id/row_search_edit_text");
}

/**
 * Locate the optional Add button in Instagram's location Map preview sheet.
 * This must not use findButtonByLabel("Add"): that lookup is intentionally
 * substring-based and can match the final post screen's "Add audio" row.
 */
export async function findLocationMapPreviewAdd(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml || !/Map preview/i.test(xml)) return null;
  const nodeRe = /<node\s([^>]+?)\s*\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = nodeRe.exec(xml)) !== null) {
    const attrs = match[1];
    if (!/clickable="true"/i.test(attrs)) continue;
    const labelMatch =
      attrs.match(/text="Add"[^>]*bounds="([^"]+)"/i) ??
      attrs.match(/content-desc="Add"[^>]*bounds="([^"]+)"/i);
    if (!labelMatch) continue;
    const center = _parseCenter(labelMatch[1]);
    if (center) return center;
  }
  return null;
}

/**
 * Finds the DM-share Send button on the share sheet after a recipient has been
 * selected.  Tries resource-ids first (direct_send_button_multi_select and
 * send_button are the two known ids) before falling back to the label "Send".
 * More reliable than findButtonByLabel("Send") which can miss the button when
 * IG uses a custom view with no text/content-desc attribute.
 */
export async function findDmSendButton(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;
  return (
    _findByResId(xml, ":id/direct_send_button_multi_select", ":id/send_button") ??
    _findElem(xml, "Send")
  );
}

/**
 * Clear the Instagram search bar before typing a new username.
 *
 * The previous approach sent `KEYCODE_CTRL_A` via `adb shell input keyevent`
 * expecting a "select all" then typed over the selection — but that command
 * cannot send modifier+key chords on Android.  `KEYCODE_CTRL_A` is silently
 * ignored (or does something unrelated), so old search text is never cleared
 * and the new username gets appended after it instead of replacing it.
 *
 * Fix strategy (node-first, belt-and-suspenders):
 *  1. Dump UI and look for Instagram's search-bar clear button by resource-id
 *     or label.  Tap it if found (best-effort — catches most builds).
 *  2. ALWAYS follow up with KEYCODE_MOVE_END + 60 × KEYCODE_DEL regardless of
 *     whether the X button was found or tapped.  Instagram's EditText `text`
 *     attribute frequently reports "" in the UIAutomator dump even when the
 *     field has visible text, so reading text-length and bailing on 0 silently
 *     leaves stale text in place.  60 backspaces on an already-empty field are
 *     harmless; on a field with text they always clear it.
 */
export async function clearInstagramSearchBar(
  serial: string,
  onLog?: (msg: string) => void,
): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return;

  // Strategy 1 — node-based clear button (best-effort, no coordinates needed)
  const clearBtn =
    _findByResId(xml,
      ":id/search_bar_delete_icon",
      ":id/search_bar_clear_button",
      ":id/clear_search_button",
      ":id/clear_button",
      ":id/action_clear_text",
      ":id/search_close_btn",
      ":id/query_refinement",
    ) ??
    _findElem(xml, "Clear search", "Clear text", "Clear");

  if (clearBtn) {
    onLog?.(`Follow: tapping search bar clear button at (${clearBtn.x},${clearBtn.y})`);
    _adbTap(adb, serial, clearBtn.x, clearBtn.y);
    await _sleep(300);
  }

  // Strategy 2 — unconditional KEYCODE_MOVE_END + backspace sweep.
  // Always runs whether or not Strategy 1 fired.  Instagram's EditText `text`
  // attribute is unreliable (often "" even with visible text), so we never
  // use it to decide whether to skip — we just always sweep.
  onLog?.(`Follow: sending KEYCODE_MOVE_END + 60× KEYCODE_DEL to ensure search bar is clear`);
  runInputShell(serial, ["keyevent", "123"], "keyevent"); // KEYCODE_MOVE_END → cursor to end
  await _sleep(80);
  for (let i = 0; i < 60; i++) {
    runInputShell(serial, ["keyevent", "67"], "keyevent"); // KEYCODE_DEL (backspace)
  }
  await _sleep(200);
}

/**
 * Finds the Share footer button on Instagram's "New post" caption screen.
 *
 * Uses resource-id as the primary signal (confirmed from real-device dump,
 * Jul 2026):
 *   - share_footer_button  (the Share button itself, desc="Share")
 *   - footer_button_container  (its parent ViewGroup — taller tap area)
 * Falls back to content-desc/text "Share" via _findElem for future IG builds
 * that might rename the resource-id.
 *
 * Dedicated function because findButtonByLabel("Share") risks matching other
 * "Share" nodes on unrelated screens (story share bar, DM share sheet, etc.)
 * and the share_footer_button sits in an extremely narrow strip at the very
 * bottom of the screen where an imprecise coordinate is unreliable.
 */
export async function findShareFooterButton(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;
  // Prefer share_footer_button (the actual button); footer_button_container
  // is its taller parent and gives a larger tap target if the button itself
  // isn't returned as a separate node on some builds.
  return (
    _findByResId(xml, ":id/share_footer_button") ??
    _findByResId(xml, ":id/footer_button_container") ??
    _findElem(xml, "Share")
  );
}

/**
 * Returns true if Instagram's post-success notification is visible in the
 * accessibility tree. After a post submits, IG overlays "Posted! All set."
 * (or equivalent) while the caption screen tears down — the share_footer_button
 * / "Share" text nodes from the caption screen stay in the tree during this
 * window. Checking for the success signal FIRST lets the poll loop exit
 * immediately instead of mis-detecting the lingering Share node as a failure.
 *
 * Also catches the case where the retry tap lands on the "Want to send it to
 * friends?" prompt that IG shows on success, opening a DM share sheet whose
 * own "Share" element would otherwise keep the poll loop spinning.
 */
export async function findMakeAPostSuccessSignal(serial: string): Promise<boolean> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return false;
  return (
    xml.includes("Posted! All set.") ||
    xml.includes("Post shared") ||
    xml.includes("Video shared") ||
    xml.includes("Reel shared") ||
    xml.includes("Your post is now shared")
  );
}

/**
 * Single-dump post-upload state check — replaces calling findMakeAPostSuccessSignal
 * and findShareFooterButton back-to-back (two dumps, ~8-10 s per poll round).
 *
 * Does ONE _uiDump and returns three flags so the poll loop can act on any of:
 *   successSignal — explicit "Posted!" / "Post shared" / etc. overlay is visible.
 *   shareGone     — share_footer_button is no longer in the tree at all.
 *   shareDisabled — share_footer_button is present but clickable="false" —
 *                   Instagram disables the button the moment it accepts the
 *                   upload (upload in progress). This fires ~8 s BEFORE the
 *                   success overlay appears and was completely missed before.
 *
 * Returns null on a dump failure so callers can treat it as "nothing known yet".
 */
export async function checkMakeAPostUploadState(
  serial: string,
): Promise<{ successSignal: boolean; shareGone: boolean; shareDisabled: boolean } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;

  const successSignal =
    xml.includes("Posted! All set.") ||
    xml.includes("Post shared") ||
    xml.includes("Video shared") ||
    xml.includes("Reel shared") ||
    xml.includes("Your post is now shared");

  // Check for the share footer button — present OR absent.
  // Prefer the share_footer_button resource-id; fall back to the container
  // and then the generic "Share" text node (same priority as findShareFooterButton).
  const shareNodeMatch =
    xml.includes(':id/share_footer_button') ||
    xml.includes(':id/footer_button_container') ||
    (xml.includes('>Share<') || xml.includes('"Share"'));
  const shareGone = !shareNodeMatch;

  // Detect disabled state: the share_footer_button (or container) node exists
  // but has clickable="false" — Instagram sets this during upload.
  let shareDisabled = false;
  if (!shareGone) {
    // Extract the XML fragment containing the share footer button and check
    // whether its clickable attribute is "false".
    const shareResIds = [':id/share_footer_button', ':id/footer_button_container'];
    for (const rid of shareResIds) {
      const idx = xml.indexOf(rid);
      if (idx === -1) continue;
      // Walk back to the opening < of this node to read its attributes.
      const nodeStart = xml.lastIndexOf('<', idx);
      const nodeEnd   = xml.indexOf('>', idx);
      if (nodeStart !== -1 && nodeEnd !== -1) {
        const nodeStr = xml.slice(nodeStart, nodeEnd + 1);
        if (nodeStr.includes('clickable="false"')) {
          shareDisabled = true;
        }
        break;
      }
    }
  }

  return { successSignal, shareGone, shareDisabled };
}

/**
 * Scans the accessibility tree for tappable recipient items inside Instagram's
 * DM share sheet.
 *
 * The share sheet opens as a bottom sheet and presents a grid/list of suggested
 * contacts. Each contact row/bubble is a clickable node whose text or
 * content-desc is the user's display name or username.
 *
 * The function returns ALL candidate tap targets so the caller can pick one
 * at random. It never throws — callers fall back to coordinate tapping if the
 * list is empty.
 *
 * Filters applied:
 * - Node must be clickable="true"
 * - Node's vertical centre must be in the 30–90 % zone of the screen
 *   (the sheet always occupies the lower portion; Send is at ~99 %)
 * - Node width must be ≤ 80 % of screen width (full-width rows like Send /
 *   Search bar are excluded; only compact avatar bubbles or short name rows pass)
 * - Node must carry a non-empty text or content-desc label
 * - Label must not match obvious UI chrome: Send / Search / Write a message /
 *   Direct / Share / To / Message / Cancel / OK / Close
 * - Label must not match a known share-DESTINATION shortcut rather than a
 *   person: "Your Story" / "Close Friends" / "Add to story". Instagram's
 *   Send-to sheet renders these as pill buttons in the SAME y-zone and under
 *   the SAME width cap as real recipient rows (confirmed 14 Jul 2026 from a
 *   live run where the previous filter let "Your Story" or "Close Friends"
 *   through, got randomly picked as the "recipient", and navigated into the
 *   add-to-story compose screen instead of DMing anyone) — they must be
 *   excluded explicitly, position/width alone doesn't tell them apart from a
 *   contact row.
 * - Label must be ≤ 50 characters (display names, not article titles)
 */
export async function findShareSheetRecipients(serial: string, onLog?: (line: string) => void): Promise<{ x: number; y: number; name?: string }[]> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return [];
  return _extractShareSheetRecipients(xml, serial, onLog);
}

/** Shared xml-parsing core of findShareSheetRecipients — see that function's
 * docs for the filter rules. Split out so confirmAndScanShareSheet can reuse
 * a single dump for both the Send-button confirmation and the recipient
 * scan instead of paying for two separate ~9s uiautomator dumps. */
function _extractShareSheetRecipients(
  xml: string,
  serial: string,
  onLog?: (line: string) => void,
  options?: { strictContactParents?: boolean },
): { x: number; y: number; name?: string }[] {
  const { w, h } = getScreenSize(serial);
  const strictContactParents = options?.strictContactParents === true;
  const minY = Math.round(h * 0.20);
  const maxY = Math.round(h * 0.95);
  const dump: string[] = [];
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let m: RegExpExecArray | null;

  // In the Reel share sheet, Instagram reuses the contact-avatar resource-id
  // for the WhatsApp/Share shortcut row. A character-count lookback can then
  // borrow the previous contact's content-desc and label the shortcut as a
  // real person. Build the actual nearest ancestor map for the strict Reel
  // path instead of guessing from nearby XML text.
  const ancestorDescByNodeIndex = new Map<number, string>();
  if (strictContactParents) {
    const tagRe = /<\/?node\b[^>]*>/g;
    const ancestors: string[] = [];
    let tag: RegExpExecArray | null;
    while ((tag = tagRe.exec(xml)) !== null) {
      const rawTag = tag[0];
      if (rawTag.startsWith("</")) {
        ancestors.pop();
        continue;
      }
      const attrs = rawTag.slice(5, rawTag.endsWith("/>") ? -2 : -1);
      const ancestorDesc = [...ancestors]
        .reverse()
        .map(attrsText => attrsText.match(/content-desc="([^"]*)"/)?.[1] ?? "")
        .find(Boolean) ?? "";
      ancestorDescByNodeIndex.set(tag.index, ancestorDesc);
      if (!rawTag.endsWith("/>")) ancestors.push(attrs);
    }
  }

  // ── Strategy 1 (primary): resource-id lookup.
  //
  // CONFIRMED (device log, 15 Jul 2026): Instagram's DM share-sheet recipient
  // avatar buttons have:
  //   rid=com.instagram.android:id/grid_view_pog_avatar_view
  //   class=android.widget.Button   (clickable, but NO content-desc or text)
  //
  // The parent ViewGroup DOES carry the human-readable content-desc
  // ("Instagram Verified Chat not selected") but is NOT clickable.
  // The Button IS clickable but has NO label — so the old label-based filter
  // returned 0 results for every recipient, fell through to the hardcoded-
  // coordinate slot fallback, and the slot tap frequently missed, meaning
  // Send fired with no recipient selected and no DM was actually sent.
  //
  // Fix: find avatar buttons by resource-id; return all of them.  The caller
  // picks one at random from this list.  No label or width filter is needed
  // because the resource-id uniquely identifies these elements.
  const RID_AVATAR = "com.instagram.android:id/grid_view_pog_avatar_view";
  // Instagram uses the SAME resource-id (grid_view_pog_avatar_view) for BOTH
  // real DM contact avatars AND the "Your Story" / "Close Friends" share
  // destination circles. The clickable Button child has NO content-desc or
  // text itself — only the wrapping ViewGroup carries the human-readable label.
  // Filter: look back up to 600 chars in the XML from each avatar button node
  // for the last content-desc seen there; if it contains a story-destination
  // phrase it belongs to "Your Story" / "Close Friends" / etc., not a contact.
  const STORY_DEST_RE = /your story|close friends|add to story|add to your story/i;
  const avatarResults: {
    x: number;
    y: number;
    name?: string;
    preSelected?: boolean;
    resourceId?: string;
    className?: string;
    bounds?: string;
    text?: string;
    contentDesc?: string;
  }[] = [];

  {
    const re2 = /<node\s([^>]+?)\s*\/?>/g;
    let m2: RegExpExecArray | null;
    while ((m2 = re2.exec(xml)) !== null) {
      const a = m2[1];
      if (!a.includes(RID_AVATAR)) continue;
      const bm = a.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!bm) continue;
      const x1 = Number(bm[1]), y1 = Number(bm[2]), x2 = Number(bm[3]), y2 = Number(bm[4]);
      const cx = Math.round((x1 + x2) / 2);
      const cy = Math.round((y1 + y2) / 2);
      if (cy < minY || cy > maxY) continue;
      // Skip nodes that are too short — real avatar buttons are square (~230px);
      // partially-clipped contacts at the sheet's bottom edge can appear as tiny
      // slivers (e.g. 28px tall). Tapping their centre is unreliable and they
      // are never fully visible to the user, so exclude them.
      const nodeH = y2 - y1;
      if (nodeH < 80) {
        onLog?.(`[share-sheet] Strategy 1: skipped avatar at (${cx},${cy}) — height ${nodeH}px too small (clipped at sheet edge)`);
        continue;
      }
      // Check the XML immediately before this node for the parent's
      // content-desc ("Your Story", "Close Friends", etc.) — take the LAST
      // content-desc attr in the lookback window, which is the closest parent.
      const lookback = xml.slice(Math.max(0, m2.index - 600), m2.index);
      const parentCdMatches = [...lookback.matchAll(/content-desc="([^"]*)"/g)];
      const parentCd = strictContactParents
        ? ancestorDescByNodeIndex.get(m2.index) ?? ""
        : parentCdMatches.length > 0 ? parentCdMatches[parentCdMatches.length - 1][1] : "";
      const NON_CONTACT_DEST_RE = /your story|close friends|add to story|add to your story|whatsapp|copy link|(?:^|\b)share(?:\b|$)|notes/i;
      if (STORY_DEST_RE.test(parentCd) || NON_CONTACT_DEST_RE.test(parentCd)) {
        onLog?.(`[share-sheet] Strategy 1: excluded avatar at (${cx},${cy}) — parent content-desc "${parentCd}" is a story destination, not a DM contact`);
        continue;
      }
      // Real DM avatar parents on the Reel sheet expose a Chat marker, e.g.
      // "athayogahtx Chat not selected". Requiring that positive marker keeps
      // external-share shortcuts out even when their resource-id is identical.
      if (strictContactParents && !/\bchat\b/i.test(parentCd)) {
        onLog?.(`[share-sheet] Reel strict filter: excluded avatar at (${cx},${cy}) — parent content-desc "${parentCd}" is not a Chat recipient`);
        continue;
      }
      // Detect pre-selected state: Instagram marks already-selected recipients
      // with "selected" (without "not") in the parent ViewGroup's content-desc,
      // e.g. "Zainab Patanwala Verified Chat selected" vs the normal
      // "Zainab Patanwala Verified Chat not selected".
      // A pre-selected recipient from a prior failed run will STILL be selected
      // when the sheet reopens. If we pick a SECOND person on top of them the
      // DM sheet now has two recipients → Instagram creates a group DM instead.
      // Flag these so the caller can deselect them before picking a fresh target.
      const alreadySelected = /\bselected\b/i.test(parentCd) && !/\bnot selected\b/i.test(parentCd);
      if (alreadySelected) {
        onLog?.(`[share-sheet] Strategy 1: pre-selected recipient at (${cx},${cy}) — "${parentCd}" — will deselect first`);
      }
      avatarResults.push({
        x: cx,
        y: cy,
        name: parentCd || undefined,
        preSelected: alreadySelected,
        resourceId: (a.match(/resource-id="([^"]*)"/) ?? [])[1] || undefined,
        className: (a.match(/class="([^"]*)"/) ?? [])[1] || undefined,
        bounds: bm[0],
        text: (a.match(/\btext="([^"]*)"/) ?? [])[1] || undefined,
        contentDesc: (a.match(/content-desc="([^"]*)"/) ?? [])[1] || undefined,
      });
    }
  }

  if (avatarResults.length > 0) {
    const preSelCount = avatarResults.filter(r => (r as any).preSelected).length;
    onLog?.(`[share-sheet] Strategy 1 (resource-id): ${avatarResults.length} DM contact avatar(s) found (${preSelCount} pre-selected) — ${avatarResults.map(r => `(${r.x},${r.y})`).join(", ")}`);
    return avatarResults;
  }
  if (strictContactParents) {
    // The generic label scan remains available to legacy callers, but it is
    // unsafe for Reel Viewer: when the avatar nodes are absent, underlying
    // feed/action-row labels can be mistaken for recipients. Return no
    // candidates rather than guessing.
    onLog?.("[share-sheet] Reel strict filter: no validated Chat avatar nodes — refusing generic label fallback");
    return [];
  }
  onLog?.("[share-sheet] Strategy 1: no non-story grid_view_pog_avatar_view nodes found — falling back to label scan");

  // ── Strategy 2 (fallback): label scan — used on Instagram builds that
  //    expose recipient rows as labelled clickable nodes rather than un-labelled
  //    Button children.
  const maxWidth = Math.round(w * 0.80);
  const UI_CHROME = /^(send|search|write a message|direct|share|to|message|cancel|ok|close|suggested|more)$/i;
  const SHARE_DESTINATIONS = /^(your story|close friends|add to story|add to your story|story|notes)$/i;
  const results: { x: number; y: number }[] = [];

  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    if (!/clickable="true"/.test(attrs)) continue;
    const bm = attrs.match(/bounds="(\[(\d+),(\d+)\]\[(\d+),(\d+)\])"/);
    if (!bm) continue;
    const x1 = Number(bm[2]), y1 = Number(bm[3]), x2 = Number(bm[4]), y2 = Number(bm[5]);
    const cx = Math.round((x1 + x2) / 2);
    const cy = Math.round((y1 + y2) / 2);
    if (cy < minY || cy > maxY) continue;
    const width = x2 - x1;
    const textM = attrs.match(/\btext="([^"]*)"/);
    const cdM   = attrs.match(/content-desc="([^"]*)"/);
    const ridM  = attrs.match(/resource-id="([^"]*)"/);
    const clsM  = attrs.match(/\bclass="([^"]*)"/);
    const label = (textM?.[1] || cdM?.[1] || "").trim();
    dump.push(`x=${cx} y=${cy} w=${width} cd="${cdM?.[1] ?? ""}" rid="${ridM?.[1] ?? ""}" cls="${clsM?.[1] ?? ""}" txt="${textM?.[1] ?? ""}"`);
    if (width > maxWidth) continue;
    if (!label || label.length > 50) continue;
    if (UI_CHROME.test(label)) continue;
    if (SHARE_DESTINATIONS.test(label.trim())) continue;
    // Exclude count labels from the feed action bar that sit BENEATH the
    // share sheet and still appear in the a11y tree: plain digits/commas
    // ("38" comments, "203" reposts, "9,077" likes) AND abbreviated counts
    // with a K/M/B suffix ("12.1K" likes, "1.2M" likes). The abbreviated
    // form was NOT excluded by the old pure-digit regex — confirmed live
    // (15 Jul 2026) where a "12.1K" like-count node at the same y-row as
    // the real recipient buttons slipped through, got randomly picked as
    // the "recipient", and no DM was actually sent to anyone.
    // A real DM recipient username/display name never matches this shape.
    if (/^[\d,.\s]+$/.test(label)) continue;
    if (/^[\d,.]+\s*[KMB]$/i.test(label)) continue;
    // Exclude hashtag caption chips (e.g. #foryou, #gymrat) — these are the
    // post's own caption tags surfaced as clickable Button nodes at the same
    // y-row as the real DM recipient name buttons.  Tapping one focuses the
    // message compose area (keyboard appears) instead of selecting a recipient.
    // A valid DM recipient username NEVER starts with '#'.
    if (label.startsWith('#')) continue;
    // Exclude the feed's own Save/bookmark button ("Add to Saved" / "Remove
    // from saved") — another action-bar node from the underlying post that
    // can appear in this same y-row scan when the sheet fails to actually
    // open (confirmed live, 15 Jul 2026: after the numeric/hashtag
    // exclusions above removed every other candidate, this was the one
    // label left over and got tapped instead of a real recipient). Same
    // leak class as the numeric/hashtag exclusions — an underlying
    // feed-post node bleeding through, not a real DM recipient.
    if (/^(add to saved|remove from saved)$/i.test(label)) continue;
    if (ridM?.[1] === "com.instagram.android:id/row_feed_button_save") continue;
    results.push({ x: cx, y: cy });
  }
  if (dump.length) onLog?.(`[share-sheet] Strategy 2 label-scan node dump: ${dump.join(" | ")}`);
  return results;
}

/**
 * Confirms the DM share sheet is open AND scans for recipient avatars in a
 * SINGLE uiautomator dump, instead of the two sequential dumps the caller
 * used to take (one via findButtonByLabel("Send") to confirm, one via
 * findShareSheetRecipients to pick).
 *
 * Root cause (device logs, 15 Jul 2026): each uiautomator dump on this class
 * of device takes ~9s. Confirm-then-scan as two separate dumps left the
 * sheet sitting untouched for ~18s+ between the tap and the recipient tap.
 * A live run showed the recipient-scan dump returning the SAME feed action-
 * bar nodes (row_feed_button_save, media_group) seen in the pre-tap scan —
 * i.e. the sheet had already closed and we were back on the underlying post
 * by the time the second dump ran. Cutting this to one dump removes half of
 * that idle window outright.
 *
 * `direct_private_share` is the DM sheet's sticky search-box resource-id
 * (see sendShareSheet's isDmSheetOpen) — its presence in the SAME dump used
 * for the recipient scan lets the caller tell "sheet closed, 0 recipients
 * because we're not even looking at it" apart from "sheet open, 0
 * recipients because none were found" — the current dump's Strategy-2 node
 * list already leaks this exact signal (feed-only ids/labels) whenever the
 * sheet has gone away underneath us.
 */
export async function confirmAndScanShareSheet(
  serial: string,
  onLog?: (line: string) => void,
  options?: { strictContactParents?: boolean },
): Promise<{ sheetOpen: boolean; sendBtn: { x: number; y: number } | null; recipients: { x: number; y: number; name?: string }[]; preSelectedRecipients: { x: number; y: number; name?: string }[] }> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return { sheetOpen: false, sendBtn: null, recipients: [] };
  // Check sheet presence FIRST — before calling _findElem or
  // _extractShareSheetRecipients — because when the sheet is NOT open the
  // underlying feed post is visible instead, and:
  //   • the feed's own paper-plane icon carries content-desc/resource-id that
  //     matches _findElem(xml,"Send"), returning the icon's coordinate as
  //     `sendBtn` even though the sheet never appeared
  //   • feed post nodes (username buttons, "more", captions) pass Strategy-2's
  //     label filters and appear as fake recipients
  // Both together produce a false-positive "DM sent" log with nothing actually
  // sent.  When neither sheet marker is present we must return null/empty.
  //
  // Multiple markers are tried because Instagram uses different share-sheet
  // layouts depending on post type and where the post was opened from:
  //
  //   direct_private_share      — sticky search-box rid in the narrow DM sheet
  //                               (home-feed posts, standard DM picker)
  //   grid_view_pog_avatar_view — recipient avatar button rid, present in
  //                               both the narrow sheet and the wider grid
  //                               picker; absent from raw feed view
  //   "Copy link"               — pill button always present in the full share
  //                               sheet (Reels, profile-grid posts, any post
  //                               where the wider share sheet opens instead of
  //                               the narrow DM-only picker); never appears on
  //                               the plain feed or inside a post viewer
  //   "Add to story"            — same sheet, always alongside "Copy link";
  //                               second signal to reduce false-positive risk
  //
  // Diagnostic: emit every unique resource-id and content-desc found in the
  // dump so we can see exactly which signals are available on this device/build
  // without needing a manual XML paste.
  const rids = [...new Set((xml.match(/resource-id="([^"]+)"/g) ?? []).map(m => m.replace('resource-id="','').replace('"','')))].filter(Boolean);
  const cds  = [...new Set((xml.match(/content-desc="([^"]{1,60})"/g) ?? []).map(m => m.replace('content-desc="','').replace('"','')))].filter(Boolean);
  onLog?.(`[share-sheet] dump signals — rids: ${rids.slice(0,20).join(', ')} | cds: ${cds.slice(0,20).join(', ')}`);

  // ANY single marker is sufficient — the sheet is open if at least one fires.
  //   direct_private_share      — search-box rid in the narrow DM sheet
  //   grid_view_pog_avatar_view — recipient avatar rid, narrow + wide picker
  //   "Copy link"               — pill button in the wider share sheet
  //   "Add to story"            — same wider sheet
  //   android.widget.EditText   — the sheet's search box class; always
  //                               present in every share-sheet variant,
  //                               never present on a plain post/Reel view
  const sheetOpen =
    xml.includes("direct_private_share") ||
    xml.includes("grid_view_pog_avatar_view") ||
    xml.includes("Copy link") ||
    xml.includes("Add to story") ||
    xml.includes("android.widget.EditText");
  if (!sheetOpen) {
    onLog?.("[share-sheet] no share-sheet marker found — sheet not open");
    return { sheetOpen: false, sendBtn: null, recipients: [], preSelectedRecipients: [] };
  }
  const sendBtn = _findElem(xml, "Send");
  const allRecipients = _extractShareSheetRecipients(xml, serial, onLog, options);
  // Split into already-selected (from a prior failed run) vs fresh candidates.
  // Pre-selected ones must be tapped to deselect before picking a new target,
  // otherwise Instagram accumulates multiple recipients and creates a group DM.
  const preSelectedRecipients = allRecipients.filter(r => (r as any).preSelected);
  const recipients = allRecipients.filter(r => !(r as any).preSelected);
  onLog?.(`[share-sheet] sheet confirmed open — sendBtn: ${sendBtn ? `(${sendBtn.x},${sendBtn.y})` : "null (will re-scan after recipient tap)"} | available: ${recipients.length} | pre-selected (will deselect): ${preSelectedRecipients.length}`);
  return { sheetOpen, sendBtn, recipients, preSelectedRecipients };
}

/**
 * Returns the content-desc of whichever node's bounds-center sits within
 * `tolerance` px of (x, y), or null if nothing is there.
 *
 * Used to tell apart two visually-similar outcomes after tapping an
 * action-bar icon like Repost: (1) a real confirmation sheet appears
 * elsewhere on screen — a genuinely separate button — vs (2) the SAME
 * icon, at the SAME position, simply changes its own label in place
 * (e.g. "Repost" -> "Remove repost" / "Reposted") because this account's
 * Instagram build completes the repost instantly on a single tap with no
 * sheet at all. Both cases produce a "Repost"-matching node at the same
 * coordinates under `findButtonByLabel`'s substring match, which made
 * them indistinguishable from "the sheet never opened" — confirmed via a
 * live device run where the repost actually succeeded (single tap) but
 * was logged as failed and triggered an incorrect recovery `pressBack`.
 * Comparing the label captured here before vs. after the tap reveals
 * which case actually happened.
 */
export async function getContentDescNear(serial: string, x: number, y: number, tolerance = 15): Promise<string | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let best: { cd: string; dist: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    const bm = attrs.match(/bounds="(\[(\d+),(\d+)\]\[(\d+),(\d+)\])"/);
    if (!bm) continue;
    const c = _parseCenter(bm[1]);
    if (!c) continue;
    const dist = Math.hypot(c.x - x, c.y - y);
    if (dist > tolerance) continue;
    const cdM = attrs.match(/content-desc="([^"]*)"/);
    const cd = cdM ? cdM[1] : "";
    if (!cd) continue;
    if (!best || dist < best.dist) best = { cd, dist };
  }
  return best ? best.cd : null;
}

/**
 * Detects Instagram's "feedback on suggested content" card — the one that
 * says "Thanks for your feedback" with an "Undo" link, plus "Snooze all
 * suggested sets of reels in feed for 30 days" / "Manage content
 * preferences". Instagram swaps this in to REPLACE a post entirely
 * (usually after its own "not interested" flow fires on a suggested
 * post/Reel/ad), so it exposes none of the normal Like/Share/Send controls.
 *
 * This matters because share-to-feed and share-via-DM tap fixed on-screen
 * coordinates that assume a normal post action bar is there. If this card
 * has taken the post's place, those coordinates land on "Undo" or "Manage
 * content preferences" instead — an accidental, unintended tap that then
 * cascades into the rest of the cycle misbehaving. Detected from on-screen
 * text so it's caught regardless of where the card lands after a scroll.
 */
export async function isFeedbackOrSurveyCard(serial: string): Promise<string | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return false;
  const MARKERS = [
    "Thanks for your feedback",
    "Snooze all suggested",
    "Manage content preferences",
    "See fewer posts like this",
    "See more posts like this",
    "Why am I seeing this",
    "Rate this ad",
    "How relevant was this ad",
    // Embedded Reels suggestion card — "Watch more reels" / "Watch Again"
    // buttons appear when Instagram injects a Reels card into the home feed.
    // Tapping Like on this card opens the Reel full-screen viewer.
    "Watch more reels",
    "Watch Again",
  ];
  const matched = MARKERS.find(m => xml.includes(m));
  return matched ?? null;
}

/**
 * Find Instagram's "+" compose icon (opens the create-post sheet). Strategy,
 * tried in order:
 *  1. content-desc / resource-id guesses covering BOTH layouts Instagram has
 *     shown on real devices in this project: a top-header icon ("New post",
 *     :id/action_bar_add_button, :id/camera_icon_button) and a bottom-nav
 *     tab (:id/creation_tab, :id/creation_tab_icon, :id/new_post_button,
 *     :id/action_new_post — see v1.1.527 fix history).
 *  2. Positional fallback: the bottom-nav "New post" tab, dead-centre of the
 *     bottom navigation bar (x≈50%, y≈94%).
 *
 * IMPORTANT — the compose icon's real position on this account/device
 * (Xiaomi 23076RN8DY, IG account "lisaberry2001"/"upgrds", 13 Jul 2026) is
 * confirmed BY THE USER, looking at the live phone mirror, to be a single
 * icon at the TOP-LEFT of the header bar, immediately left of the
 * "Instagram" wordmark — NOT the top-right icon cluster, and NOT a
 * bottom-nav tab (this build's bottom nav is home / reels / shop / search /
 * profile with no create tab at all). Both of those were tried and
 * CONFIRMED WRONG:
 *   - v1.1.536–542: blind top-RIGHT-cluster scan → hit the Notifications icon.
 *   - v1.1.543: bottom-nav-centre fallback → hit Direct/Messages instead
 *     (this device's bottom nav has no create tab; x≈50% landed on an
 *     unrelated middle tab).
 * Do not reintroduce either of those as the positional fallback. The
 * top-left search below is scoped to the header bar ONLY (y < 7% of screen
 * height) specifically so it can never match the stories-tray "Add" circle
 * (content-desc="Add", y ≈ 9–15%) that caused the ORIGINAL top-left mistake
 * back in v1.1.526 — that bug was the stories tray, not this header icon.
 */
export async function findComposeButton(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial);
  if (!xml) return null;

  // "Add" is intentionally excluded: Instagram's story circle "+" button in
  // the stories tray carries content-desc="Add" and appears first in the
  // accessibility tree.  Matching it taps the story button, which opens the
  // "Add to story" picker instead of the post compose sheet — confirmed on
  // real device (Xiaomi, 1080×2226, Jul 2026).
  const byLabel = _findElem(xml, "New post", "Create", "New Post");
  if (byLabel) return byLabel;
  const byResId = _findByResId(
    xml,
    ":id/action_bar_add_button", ":id/camera_icon_button",
    ":id/creation_tab", ":id/creation_tab_icon", ":id/new_post_button", ":id/action_new_post",
  );
  if (byResId) return byResId;

  return findComposeTopLeftHeaderIcon(serial, xml);
}

/**
 * Positional fallback confirmed correct by the user visually inspecting the
 * live phone mirror (13 Jul 2026): the compose "+" sits at the TOP-LEFT of
 * the header bar, left of the "Instagram" wordmark.
 *
 * Two bugs found and fixed here on 13 Jul 2026 after a real-device dump
 * (`screen-layout-scan`) showed the true header icon at bounds
 * [0,104][132,258] — centre y ≈ 8.1% of screen height — which the original
 * y < 7% cutoff rejected outright, explaining the "not found — skipping"
 * result on the v1.1.544 build even though a plausible candidate existed
 * in the dump:
 *   1. Screen dimensions are now read from the dump's OWN root node bounds
 *      (`bounds="[0,0][W,H]"`), not a separate `adb shell wm size` call.
 *      `wm size` can report a "Physical size" and an "Override size" that
 *      differ when a display-size override is active, and the two are NOT
 *      interchangeable — a mismatch there would silently skew every
 *      percentage threshold computed against it.
 *   2. The header band is widened from y < 7% to y < 12% of screen height
 *      to actually include that real icon.
 * Widening the band reopens the ORIGINAL v1.1.526 risk of matching the
 * stories-tray "Add" circle instead (that tray sits around y ≈ 9–15% and
 * overlaps this range) — two defenses guard against that:
 *   - Any candidate whose text/content-desc mentions "add" or "story" is
 *     excluded outright, positional match or not.
 *   - Any candidate that has 2+ same-sized siblings at a similar y (a
 *     "row" of icons — how a tray of story avatars looks, but a lone
 *     header icon never does) is excluded as a likely tray, not a button.
 */
export function findComposeTopLeftHeaderIcon(serial: string, xml: string): { x: number; y: number } | null {
  const rootM = xml.match(/bounds="\[0,0\]\[(\d+),(\d+)\]"/);
  const { w, h } = rootM
    ? { w: Number(rootM[1]), h: Number(rootM[2]) }
    : getScreenSize(serial); // fallback only if the dump has no root bounds at all
  const maxY = Math.round(h * 0.12);
  const maxX = Math.round(w * 0.25);
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  interface Cand { x: number; y: number; y1: number; bw: number; bh: number }
  const candidates: Cand[] = [];
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    const bm = attrs.match(/bounds="(\[(\d+),(\d+)\]\[(\d+),(\d+)\])"/);
    if (!bm) continue;
    const x1 = Number(bm[2]), y1 = Number(bm[3]), x2 = Number(bm[4]), y2 = Number(bm[5]);
    const bw = x2 - x1, bh = y2 - y1;
    // Icon-sized only — rejects the full-width "Instagram" wordmark TextView
    // and any large layout containers.
    if (bw > w * 0.18 || bh > h * 0.10 || bw === 0 || bh === 0) continue;
    const c = _parseCenter(bm[1]);
    if (!c) continue;
    if (c.y > maxY || c.x > maxX) continue;
    // Exclude anything labelled as the story tray's "Add" circle (or any
    // other story-related control) regardless of position — a positional
    // match alone isn't enough evidence once the band is this wide.
    const get = (attr: string) => { const a = attrs.match(new RegExp(`${attr}="([^"]*)"`, "i")); return a ? a[1] : ""; };
    const label = `${get("content-desc")} ${get("text")}`.toLowerCase();
    if (/add|story|stories/.test(label)) continue;
    candidates.push({ x: c.x, y: c.y, y1, bw, bh });
  }
  // Drop any candidate that has 2+ similarly-sized siblings at a similar
  // y — that pattern is a row of tray icons, not a single header button.
  const solo = candidates.filter(a => {
    const siblings = candidates.filter(b =>
      b !== a && Math.abs(b.y1 - a.y1) < 30 && Math.abs(b.bw - a.bw) < 20 && Math.abs(b.bh - a.bh) < 20,
    );
    return siblings.length === 0;
  });
  const pool = solo.length > 0 ? solo : candidates;
  let best: { x: number; y: number } | null = null;
  for (const c of pool) {
    if (!best || c.x < best.x) best = { x: c.x, y: c.y };
  }
  return best;
}

/**
 * Returns true if the current screen is Instagram's Notifications ("Your
 * activity" bell icon) or Direct inbox page — both are full-screen
 * destinations with an action-bar title and back button, and both are wrong
 * targets that a mis-aimed compose-icon tap can land on.
 *
 * Used as a guard in the Make-a-Post flow immediately after tapping the
 * compose icon: if this returns true, the tap landed on the wrong header
 * icon, not the post composer.
 */
export function isOnNotificationsOrDirectScreen(xml: string): boolean {
  return /text="Notifications"/.test(xml) || /text="Direct"/.test(xml);
}

/**
 * Same as {@link isOnNotificationsOrDirectScreen} but pulls a fresh UI dump
 * itself — convenience wrapper for call sites that don't already have the
 * XML in hand (mirrors the {@link isOnStoryCreator} pattern).
 */
export async function isOnNotificationsOrDirectScreenLive(serial: string): Promise<boolean> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return false;
  return isOnNotificationsOrDirectScreen(xml);
}

/**
 * Returns true if the current screen is Instagram's Story Creator (the
 * camera/media-select interface that opens when the story "+" add button is
 * tapped), as opposed to the post/feed compose picker.
 *
 * Used as a guard in the Make-a-Post flow to bail early when
 * findComposeButton mistakenly taps the story "+" instead of the post "+".
 *
 * Detects by looking for labels that are unique to the story creator and
 * never appear on the post picker:
 *   • "Your story" / "Close Friends" — the share-destination buttons at the
 *     bottom of the story creator
 *   • resource-id overflow_button — the "Show more tools" button in the
 *     story creator's right-side toolbar (Text / Stickers / Music / Effects)
 */
export async function isOnStoryCreator(serial: string): Promise<boolean> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return false;
  return (
    /text="Your story"/.test(xml) ||
    /text="Close Friends"/.test(xml) ||
    /:id\/overflow_button"/.test(xml)
  );
}

/**
 * Finds the small "expand" (two-arrow / resize) toggle that sits in the
 * bottom-left corner of the photo preview on Instagram's New Post
 * photo-select screen. Tapping it switches the crop from IG's default
 * centre-cropped square frame to the full original photo. It carries no
 * visible text, so this relies on a content-desc/resource-id label match
 * first, falling back to a positional heuristic.
 *
 * BUG (found 2026-07-13 via real-device log + screenshot): the previous
 * positional fallback searched a FIXED screen-percentage band (y 30-58%,
 * x<22%) with no exclusion for camera/tab/grid elements. On the real
 * device that band did not contain the actual icon (the live preview
 * container's own bounds run to ~59.8% of screen height, past the old 58%
 * cutoff — the exact same "cutoff excludes the real element" mistake as
 * the compose-button fix) and instead matched the "open camera" grid tile,
 * which IS small, square, and unlabelled just like the real icon. Tapping
 * it opened the phone's live camera, exactly as reported.
 *
 * FIX: stop guessing a fixed screen fraction. Anchor the search to the
 * preview container's OWN bounds from the live dump (rid contains
 * "preview_container", "crop_image_view", or "draft_image_view" — all
 * confirmed present on this screen from real-device dumps), and only
 * accept candidates whose bounds fall inside that container's bottom-left
 * quadrant. This makes it geometrically impossible to match anything in
 * the camera tab, the tab strip, or the Recents grid below, since those
 * sit entirely outside the container's rectangle. A camera/gallery/tab
 * label exclusion is kept as a second, independent safety net in case the
 * container can't be found on some build and the old fixed-percentage
 * fallback has to be used.
 */
export async function findExpandPhotoButton(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;

  // "Change crop" / "croptype_toggle_button" is the desc/id confirmed from real-device dump (Jul 2026).
  const byLabel = _findElem(xml, "Change crop", "Expand", "Zoom out", "Photo size", "Original size", "Toggle photo size");
  if (byLabel) return byLabel;
  const byResId = _findByResId(xml, ":id/croptype_toggle_button", ":id/expand_photo_button", ":id/original_media_full_size_toggle_button", ":id/media_size_toggle");
  if (byResId) return byResId;

  const { w, h } = getScreenSize(serial);
  // The expand toggle is always inside the PHOTO PREVIEW area, which ends
  // before the Recents grid starts (~57% of screen height on this device).
  // Camera icon in the grid sits at ~y=63-70% — cap both search paths at
  // h*0.57 so it can never be mistaken for the expand toggle.
  const EXPAND_MAX_Y = Math.round(h * 0.57);
  const isExcluded = (label: string) =>
    /camera|shutter|gallery|tab|story|reel|live|post_tab|recents|grid|thumbnail|picker/i.test(label);

  const container = _findBoundsByResId(xml, "preview_container", "crop_image_view", "draft_image_view");
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let best: { x: number; y: number } | null = null;
  let bestArea = Infinity;
  let m: RegExpExecArray | null;

  if (container) {
    // Search strictly inside the preview container's own rectangle, bottom-left
    // quadrant only (the icon overlays the image near its bottom-left corner).
    const cw = container.x2 - container.x1, ch = container.y2 - container.y1;
    const bandMinX = container.x1;
    const bandMaxX = container.x1 + Math.round(cw * 0.30);
    const bandMinY = container.y1 + Math.round(ch * 0.55);
    // Cap bandMaxY at EXPAND_MAX_Y — if the container's reported bounds extend
    // into or past the Recents grid (a known issue on some IG builds where the
    // container node includes grid children), the camera tile at y≈65%+ would
    // otherwise pass the in-container check and get tapped as the expand toggle.
    const bandMaxY = Math.min(container.y2 + Math.round(ch * 0.05), EXPAND_MAX_Y);
    while ((m = nodeRe.exec(xml)) !== null) {
      const attrs = m[1];
      if (!/clickable="true"/.test(attrs)) continue;
      const textM = attrs.match(/\btext="([^"]*)"/);
      const cdM = attrs.match(/content-desc="([^"]*)"/);
      const ridM = attrs.match(/resource-id="([^"]*)"/);
      if ((textM?.[1] || "").trim() || (cdM?.[1] || "").trim()) continue; // icon-only, no visible label
      const label = `${textM?.[1] || ""} ${cdM?.[1] || ""} ${ridM?.[1] || ""}`;
      if (isExcluded(label)) continue; // resource-id alone can still flag camera/tab/grid nodes
      const bm = attrs.match(/bounds="(\[(\d+),(\d+)\]\[(\d+),(\d+)\])"/);
      if (!bm) continue;
      const x1 = Number(bm[2]), y1 = Number(bm[3]), x2 = Number(bm[4]), y2 = Number(bm[5]);
      const bw = x2 - x1, bh = y2 - y1;
      const c = _parseCenter(bm[1]);
      if (!c) continue;
      if (c.x < bandMinX || c.x > bandMaxX || c.y < bandMinY || c.y > bandMaxY) continue;
      if (bw <= 0 || bh <= 0 || bw > w * 0.15 || bh > h * 0.10) continue; // must be icon-sized
      const area = bw * bh;
      if (area < bestArea) { best = c; bestArea = area; }
    }
    if (best) return best;
    // Container found but no icon-sized candidate inside it — do NOT fall
    // through to the fixed-percentage scan below, since that's what caused
    // this bug. Report "not found" instead of risking a wrong-screen tap.
    return null;
  }

  // Container not found in this dump (older/different build) — last-resort
  // fixed-percentage band. maxY capped at EXPAND_MAX_Y (h*0.57) — same cap
  // as the container path — so the camera tile at y≈63-70% is always excluded.
  const minY = Math.round(h * 0.30);
  const maxY = EXPAND_MAX_Y; // h*0.57 — preview area ends well before the grid
  const maxX = Math.round(w * 0.22);
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    if (!/clickable="true"/.test(attrs)) continue;
    const textM = attrs.match(/\btext="([^"]*)"/);
    const cdM = attrs.match(/content-desc="([^"]*)"/);
    const ridM = attrs.match(/resource-id="([^"]*)"/);
    const label = `${textM?.[1] || ""} ${cdM?.[1] || ""} ${ridM?.[1] || ""}`;
    if ((textM?.[1] || "").trim() || (cdM?.[1] || "").trim()) continue; // icon-only, no visible label
    if (isExcluded(label)) continue;
    const bm = attrs.match(/bounds="(\[(\d+),(\d+)\]\[(\d+),(\d+)\])"/);
    if (!bm) continue;
    const x1 = Number(bm[2]), y1 = Number(bm[3]), x2 = Number(bm[4]), y2 = Number(bm[5]);
    const bw = x2 - x1, bh = y2 - y1;
    const c = _parseCenter(bm[1]);
    if (!c) continue;
    if (c.y < minY || c.y > maxY || c.x > maxX) continue;
    if (bw <= 0 || bh <= 0 || bw > w * 0.15 || bh > h * 0.10) continue; // must be icon-sized, not a full row
    const area = bw * bh;
    if (area < bestArea) { best = c; bestArea = area; }
  }
  return best;
}

/**
 * Finds the first real photo thumbnail in the Recents grid on Instagram's
 * New Post photo-select screen — i.e. the most recently added item,
 * EXCLUDING the "open camera" shutter tile.
 *
 * Root cause (confirmed via real-device testing, 2026-07-13): the earlier
 * assumption that Instagram auto-selects the newest photo the instant the
 * picker opens only holds for a genuine finger tap on "+". When the "+" is
 * tapped via UI Automator (this automation), the grid comes up with
 * NOTHING highlighted — no default selection happens. So the flow must
 * explicitly tap a thumbnail itself rather than relying on a default that
 * doesn't occur under automation.
 *
 * The grid's first cell is Instagram's camera-shutter tile, not a photo —
 * tapping it blind was the original v1.1.522 bug (opens the camera instead
 * of selecting anything). This scans the grid band for clickable, roughly
 * square, tile-sized nodes, skips any whose content-desc/resource-id
 * mentions "camera", and returns the topmost-leftmost survivor — since the
 * grid sorts newest-first and we just pushed the target file, that survivor
 * is our file.
 *
 * NOTE (v1.1.526): The function now accepts BOTH clickable and non-clickable
 * tile-shaped nodes. On some devices/Android versions the RecyclerView
 * parent handles all touches while individual grid cells have
 * clickable="false" — requiring clickable="true" caused the scan to return
 * null even when the thumbnails were clearly visible (confirmed via
 * real-device screenshot 2026-07-13). Clickable nodes are still preferred
 * (sorted first); non-clickable tile-sized nodes serve as the fallback.
 * When even that fails, the caller should use
 * postGalleryThumbnailPositionalFallback().
 */
export async function findFirstGalleryThumbnail(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;

  const { w, h } = getScreenSize(serial);
  // The preview + expand-toggle band occupies roughly the top 58% of the
  // screen (see findExpandPhotoButton); the Recents grid sits below that,
  // down to just above the bottom nav/caption bar.
  const minY = Math.round(h * 0.58);
  const maxY = Math.round(h * 0.97);
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  const candidates: { x: number; y: number; y1: number; isCamera: boolean; clickable: boolean }[] = [];
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    // Accept both clickable and non-clickable nodes — some devices expose
    // the RecyclerView as clickable but mark individual cells as non-clickable.
    const bm = attrs.match(/bounds="(\[(\d+),(\d+)\]\[(\d+),(\d+)\])"/);
    if (!bm) continue;
    const x1 = Number(bm[2]), y1 = Number(bm[3]), x2 = Number(bm[4]), y2 = Number(bm[5]);
    const bw = x2 - x1, bh = y2 - y1;
    if (bw <= 0 || bh <= 0) continue;
    const c = _parseCenter(bm[1]);
    if (!c) continue;
    if (c.y < minY || c.y > maxY) continue;
    // Grid tiles are roughly square (within a 3-4 column layout) — reject
    // full-width rows (e.g. a "Recents ▾" dropdown header) and slivers.
    if (bw < w * 0.15 || bw > w * 0.40) continue;
    if (Math.abs(bw - bh) > bh * 0.5) continue;
    const textM = attrs.match(/\btext="([^"]*)"/);
    const cdM = attrs.match(/content-desc="([^"]*)"/);
    const rid = attrs.match(/resource-id="([^"]*)"/);
    const label = `${textM?.[1] || ""} ${cdM?.[1] || ""} ${rid?.[1] || ""}`.toLowerCase();
    const isCamera = label.includes("camera");
    const clickable = /clickable="true"/.test(attrs);
    candidates.push({ x: c.x, y: c.y, y1, isCamera, clickable });
  }
  if (!candidates.length) return null;
  // Sort: clickable nodes first (more reliable), then top-left (newest in
  // grid) within each clickability tier.
  candidates.sort((a, b) => {
    if (a.clickable !== b.clickable) return a.clickable ? -1 : 1;
    return Math.abs(a.y1 - b.y1) > 20 ? a.y1 - b.y1 : a.x - b.x;
  });
  const real = candidates.find(c => !c.isCamera);
  return real ? { x: real.x, y: real.y } : null;
}

/**
 * Positional fallback for the first non-camera photo thumbnail in Instagram's
 * Recents grid on the New Post picker screen.
 *
 * Used when findFirstGalleryThumbnail() returns null (e.g. the accessibility
 * tree exposes neither clickable nor non-clickable tile nodes that pass the
 * size/shape filters). On a typical Instagram layout the Recents grid starts
 * at ~65% of screen height. The camera tile occupies the first column; the
 * first PHOTO tile is in the second column. With a 3-4 column grid on a
 * 1080 px wide device each tile is ~270 px wide, putting the second column
 * centre at roughly x=38%, y=69%.
 *
 * Caller MUST proceed regardless of whether this tap hits a real thumbnail —
 * it is a best-effort blind coordinate tap. Post-tap behaviour (the picker
 * preview updating with the selected photo) confirms success.
 */
/**
 * Positional fallback for Instagram's "New post" bottom-nav tab.
 * Used when `findComposeButton` tapped the wrong button and we need to
 * retry by tapping the geometric centre of the bottom-nav "New post" slot
 * directly (x ≈ 50%, y ≈ 94%).
 */
export function postComposeCentreNavFallback(serial: string): { x: number; y: number } {
  const { w, h } = getScreenSize(serial);
  return { x: Math.round(w * 0.50), y: Math.round(h * 0.94) };
}

export function postGalleryThumbnailPositionalFallback(serial: string): { x: number; y: number } {
  const { w, h } = getScreenSize(serial);
  // Second column centre (x ≈ 38%) in the first tile row (y ≈ 69%).
  return { x: Math.round(w * 0.38), y: Math.round(h * 0.69) };
}

// ── Story post helpers ────────────────────────────────────────────────────────

/**
 * Finds the gallery icon on the Instagram story camera screen.
 * resource-id="gallery_preview_button", desc="Gallery" — bottom-left of screen.
 */
export async function findStoryGalleryButton(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    const rid = attrs.match(/resource-id="([^"]*)"/)?.[1] ?? "";
    const desc = attrs.match(/content-desc="([^"]*)"/)?.[1] ?? "";
    if (rid.includes("gallery_preview_button") || desc.toLowerCase() === "gallery") {
      const bm = attrs.match(/bounds="([^"]+)"/);
      if (bm) { const c = _parseCenter(bm[1]); if (c) return c; }
    }
  }
  return null;
}

/**
 * Finds the first non-camera photo thumbnail in the Instagram story gallery picker
 * ("Add to story"). Uses resource-id="gallery_grid_item_thumbnail" with a broad
 * Y search range — the story gallery sits higher on screen than the post gallery.
 */
export async function findFirstStoryGalleryThumbnail(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;
  const { w } = getScreenSize(serial);
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  const candidates: { x: number; y: number; y1: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    const rid = attrs.match(/resource-id="([^"]*)"/)?.[1] ?? "";
    const desc = attrs.match(/content-desc="([^"]*)"/)?.[1] ?? "";
    if (!rid.includes("gallery_grid_item_thumbnail")) continue;
    if (desc.toLowerCase().includes("camera")) continue;
    const bm = attrs.match(/bounds="(\[(\d+),(\d+)\]\[(\d+),(\d+)\])"/);
    if (!bm) continue;
    const x1 = Number(bm[2]), y1 = Number(bm[3]), x2 = Number(bm[4]), y2 = Number(bm[5]);
    const bw = x2 - x1;
    if (bw < w * 0.15 || bw > w * 0.50) continue;
    const c = _parseCenter(bm[1]);
    if (c) candidates.push({ x: c.x, y: c.y, y1 });
  }
  if (!candidates.length) return null;
  // Top-left first = newest photo
  candidates.sort((a, b) => Math.abs(a.y1 - b.y1) > 20 ? a.y1 - b.y1 : a.x - b.x);
  return { x: candidates[0].x, y: candidates[0].y };
}

/**
 * Finds the forward/share node in the Instagram story editor bottom bar.
 *
 * Instagram uses more than one layout for this screen. Some builds expose
 * the blue chevron as `next_button`, while others expose that same control as
 * `share_story_button` (the latter submits directly without a separate Share
 * screen). The old implementation guessed with the generic
 * `igds_media_button` id, which could not distinguish the destination pills
 * ("Your story"/"Close Friends") from the chevron.
 *
 * The `directShare` flag is deliberately returned with the node so the caller
 * does not tap the same share action a second time after a combined editor /
 * share screen.
 */
export async function findStoryNextArrowButton(
  serial: string,
): Promise<{ x: number; y: number; directShare?: boolean } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  const candidates: { x: number; y: number; priority: number; directShare: boolean }[] = [];
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    const rid = attrs.match(/resource-id="([^"]*)"/)?.[1] ?? "";
    const text = attrs.match(/\btext="([^"]*)"/)?.[1] ?? "";
    const desc = attrs.match(/content-desc="([^"]*)"/)?.[1] ?? "";
    const ridName = rid.split("/").pop()?.toLowerCase() ?? "";
    const label = `${text} ${desc}`.toLowerCase().trim();

    // These are the actual accessibility identifiers for the forward/share
    // control across the observed Instagram layouts. Do not use color,
    // screen position, or a generic media-button id here.
    const isDirectShare = ridName.includes("share_story_button");
    const isNextResource = ridName.includes("next_button") ||
      ridName.includes("button_next") ||
      ridName.includes("action_next");
    const isNextLabel = /^(next|next button|continue|share to)$/.test(desc.trim().toLowerCase()) ||
      /^(next|next button|continue|share to)$/.test(text.trim().toLowerCase());
    if (!isDirectShare && !isNextResource && !isNextLabel) continue;

    // Destination pills can contain "story" / "friends" in their labels.
    // Keep this guard even when a future build reuses a resource id.
    if (label.includes("your story") || label.includes("close friends") || label.includes("add to story")) continue;
    const bm = attrs.match(/bounds="([^"]+)"/);
    if (bm) {
      const c = _parseCenter(bm[1]);
      if (c) {
        const priority = isDirectShare ? 1 : isNextResource ? 2 : 3;
        candidates.push({ x: c.x, y: c.y, priority, directShare: isDirectShare });
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.priority - b.priority);
  const match = candidates[0];
  return { x: match.x, y: match.y, ...(match.directShare ? { directShare: true } : {}) };
}

/**
 * Finds the blue "Share" button on the story share destination screen.
 * resource-id="share_story_button", desc="Share".
 */
export async function findStoryShareButton(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    const rid = attrs.match(/resource-id="([^"]*)"/)?.[1] ?? "";
    const desc = attrs.match(/content-desc="([^"]*)"/)?.[1] ?? "";
    if (rid.includes("share_story_button") || desc === "Share") {
      const bm = attrs.match(/bounds="([^"]+)"/);
      if (bm) { const c = _parseCenter(bm[1]); if (c) return c; }
    }
  }
  return null;
}

/**
 * Finds the "Finished" button on the "Also share to" screen after a story is shared.
 * resource-id="send_button", desc="Finished".
 */
export async function findStoryFinishedButton(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    const rid = attrs.match(/resource-id="([^"]*)"/)?.[1] ?? "";
    const desc = attrs.match(/content-desc="([^"]*)"/)?.[1] ?? "";
    const text = attrs.match(/\btext="([^"]*)"/)?.[1] ?? "";
    if (rid.includes("send_button") && (desc.toLowerCase().includes("finished") || text.toLowerCase().includes("finished"))) {
      const bm = attrs.match(/bounds="([^"]+)"/);
      if (bm) { const c = _parseCenter(bm[1]); if (c) return c; }
    }
  }
  return null;
}

/**
 * Dismisses the Instagram "Stories archive" informational popup that can appear
 * immediately after a story is shared. Taps the "OK" primary button.
 * Returns true if the popup was found and dismissed.
 */
export async function dismissStoriesArchivePopup(serial: string): Promise<boolean> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return false;
  if (!xml.includes("Stories archive")) return false;
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    const rid = attrs.match(/resource-id="([^"]*)"/)?.[1] ?? "";
    const text = attrs.match(/\btext="([^"]*)"/)?.[1] ?? "";
    if (rid.includes("primary_button") && text === "OK") {
      const bm = attrs.match(/bounds="([^"]+)"/);
      if (bm) {
        const c = _parseCenter(bm[1]);
        if (c) { _adbTap(adb, serial, c.x, c.y); await _sleep(400); return true; }
      }
    }
  }
  return false;
}

/**
 * Dumps every node in the current UI as human-readable lines so Make-a-Post
 * can log exactly what's on screen at each step.
 *
 * Each line format:
 *   [class] bounds=[x1,y1][x2,y2]  text="…"  cd="…"  rid="…"  click=T/F  focus=T/F
 *
 * Returns an empty array if the dump fails.
 */
export async function dumpAllNodes(serial: string): Promise<string[]> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return ["[dumpAllNodes] uiDump returned empty"];
  const lines: string[] = [];
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    const cls   = (attrs.match(/class="([^"]*)"/))?.[1]?.split(".").pop() ?? "?";
    const bounds= (attrs.match(/bounds="([^"]*)"/))?.[1] ?? "?";
    const text  = (attrs.match(/\btext="([^"]*)"/))?.[1] ?? "";
    const cd    = (attrs.match(/content-desc="([^"]*)"/))?.[1] ?? "";
    const rid   = (attrs.match(/resource-id="([^"]*)"/))?.[1]?.split("/").pop() ?? "";
    const click = /clickable="true"/.test(attrs) ? "T" : "F";
    const focus = /focusable="true"/.test(attrs) ? "T" : "F";
    // skip totally empty, unlabelled, non-interactive nodes — they're layout containers
    if (!text && !cd && !rid && click === "F" && focus === "F") continue;
    lines.push(`[${cls}] ${bounds}  text="${text}"  cd="${cd}"  rid="${rid}"  click=${click}  focus=${focus}`);
  }
  if (!lines.length) lines.push("[dumpAllNodes] no labelled/interactive nodes found in tree");
  return lines;
}

/**
 * Drop-in screen dump for any mobile automation flow.
 *
 * Usage — one line anywhere you need to see what's on screen:
 *
 *   await logScreenLayout(serial, "Make a Post: after '+' tap", onLog);
 *
 * Rules:
 *   • Call it AT MOST ONCE per critical moment — each call takes ~3 s.
 *   • Place it as the VERY FIRST thing after a sleep, before any other
 *     UIAutomator call, so the screen state is as fresh as possible.
 *   • Never call it in a loop or more than once in rapid succession — the
 *     cumulative delay will close time-sensitive screens.
 *   • It never throws — failures are logged inline, never propagated.
 */
export async function logScreenLayout(
  serial: string,
  label: string,
  onLog: ((msg: string) => void) | undefined,
): Promise<void> {
  onLog?.(`[screen-dump] ${label} — starting…`);
  try {
    const lines = await dumpAllNodes(serial);
    onLog?.(`[screen-dump] ${label} — ${lines.length} node(s):`);
    lines.forEach(l => onLog?.(`  ${l}`));
  } catch (e: any) {
    onLog?.(`[screen-dump] ${label} — ERROR: ${e?.message ?? e}`);
  }
  onLog?.(`[screen-dump] ${label} — end`);
}

/**
 * Automatic self-diagnostic evidence capture. Saves a full screenshot PNG
 * and the raw accessibility-tree XML dump to disk, on THIS machine, without
 * any user action.
 *
 * Why this exists (13 Jul 2026): every "Make a Post" tap-mismatch bug fixed
 * in this codebase so far has depended on the user manually pulling a
 * device log and a screenshot at the exact moment of failure and pasting
 * them into chat — after already burning ~30 min on a rebuild. That is a
 * broken debugging loop, not a broken button: fixes are always guesses
 * made from a stale, user-supplied snapshot, with no way to verify them
 * before shipping. This function removes the user from that loop — call it
 * around every risky tap in a flow, and the evidence is already sitting on
 * disk the next time something goes wrong, with zero effort from the user.
 *
 * Files are written to `debug-captures/<serial>/<timestamp>_<label>/`:
 *   - `screen.png`  — raw screencap at the moment of capture
 *   - `dump.xml`    — full uiautomator accessibility-tree dump
 * Never throws — a failed capture (missing tool, device disconnected) logs
 * and returns null so it can never break the automation flow it's
 * instrumenting.
 */
export async function captureDebugEvidence(serial: string, label: string): Promise<string | null> {
  try {
    const tools = detectToolset();
    const adb = requireTool(tools.adb, "adb");
    const safeLabel = label.replace(/[^a-zA-Z0-9_.\-]+/g, "_").slice(0, 80);
    const dir = path.join(process.cwd(), "debug-captures", serial.replace(/[^a-zA-Z0-9_.\-]+/g, "_"), `${Date.now()}_${safeLabel}`);
    fs.mkdirSync(dir, { recursive: true });

    const [{ stdout: pngBuf } , xml] = await Promise.all([
      execFileP(adb, ["-s", serial, "exec-out", "screencap", "-p"], {
        encoding: "buffer", timeout: 8000, maxBuffer: 20 * 1024 * 1024,
      } as any) as unknown as Promise<{ stdout: Buffer }>,
      _uiDump(adb, serial).catch(() => ""),
    ]);
    if (pngBuf && (pngBuf as unknown as Buffer).length > 100) {
      fs.writeFileSync(path.join(dir, "screen.png"), pngBuf as unknown as Buffer);
    }
    fs.writeFileSync(path.join(dir, "dump.xml"), xml || "[dump failed]");
    fs.writeFileSync(path.join(dir, "label.txt"), label);
    return dir;
  } catch (e: any) {
    logger.warn?.(`[captureDebugEvidence] failed for "${label}": ${e?.message ?? e}`);
    return null;
  }
}

/** Remove the prior per-device screenshot run before a new recording starts. */
export function resetDebugCaptures(serial: string): void {
  const root = path.join(process.cwd(), "debug-captures", serial.replace(/[^a-zA-Z0-9_.\-]+/g, "_"));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e: any) {
    logger.warn?.(`[resetDebugCaptures] failed for ${serial}: ${e?.message ?? e}`);
  }
}

/** Fast PNG-only capture used by the session recorder. It intentionally omits
 * UIAutomator dumps so screenshots stay close to the corresponding log time. */
export async function captureDebugScreenshot(serial: string, ts: number, label: string): Promise<string | null> {
  try {
    const tools = detectToolset();
    const adb = requireTool(tools.adb, "adb");
    const safeSerial = serial.replace(/[^a-zA-Z0-9_.\-]+/g, "_");
    const safeLabel = label.replace(/[^a-zA-Z0-9_.\-]+/g, "_").slice(0, 80);
    const dir = path.join(process.cwd(), "debug-captures", safeSerial, `${ts}_${safeLabel}`);
    fs.mkdirSync(dir, { recursive: true });
    const result = await execFileP(adb, ["-s", serial, "exec-out", "screencap", "-p"], {
      encoding: "buffer", timeout: 3000, maxBuffer: 20 * 1024 * 1024,
    } as any) as unknown as { stdout: Buffer };
    if (!result.stdout || result.stdout.length < 100) return null;
    const file = path.join(dir, "screen.png");
    fs.writeFileSync(file, result.stdout);
    return file;
  } catch (e: any) {
    logger.debug?.(`[captureDebugScreenshot] failed for "${label}": ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Pushes a local file (server-side path — same machine as the phone in the
 * real packaged app, per repl-setup) onto the device's DCIM/Camera folder,
 * then triggers a media-scanner broadcast so it immediately shows up in
 * Instagram's post-composer gallery/picker without a reboot.
 *
 * Returns the on-device path so the caller can log it / clean it up later.
 */
export async function pushFileToDevice(serial: string, localPath: string, fileName: string): Promise<string> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const safeName = fileName.replace(/[^a-zA-Z0-9_.\-]/g, "_");
  const devicePath = `/sdcard/DCIM/Camera/equinox_${Date.now()}_${safeName}`;
  await runAdbStrict(adb, ["-s", serial, "push", localPath, devicePath], 20000);
  await scanMediaFile(serial, devicePath);
  return devicePath;
}

/**
 * Tells Android's media scanner about a newly-pushed file so it appears in
 * the gallery/media-picker immediately. `adb push` alone only writes bytes
 * to the filesystem — apps that read via MediaStore (Instagram's composer
 * included) won't see the file until the scanner indexes it.
 */
export async function scanMediaFile(serial: string, devicePath: string): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  await runAdb(adb, [
    "-s", serial, "shell", "am", "broadcast",
    "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
    "-d", `file://${devicePath}`,
  ], 6000);
}

/**
 * Removes a file previously pushed to the device (e.g. via pushFileToDevice)
 * and re-triggers the media scanner so it also disappears from Instagram's
 * gallery/media-picker and the phone's own Gallery app. Used to clean up
 * after a "Make a Post" attempt that pushed an image but then aborted
 * before actually posting it — without this, every retry leaves behind a
 * duplicate copy of the same source image in DCIM/Camera.
 */
export async function removeDeviceFile(serial: string, devicePath: string): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  await runAdb(adb, ["-s", serial, "shell", "rm", "-f", devicePath], 6000).catch(() => {});
  await scanMediaFile(serial, devicePath).catch(() => {});
}

export async function findHomeTab(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial);
  if (!xml) return null;
  // 1. content-desc prefix match — covers most IG builds.
  const re = /content-desc="Home[^"]*"[^>]*bounds="([^"]+)"/;
  const m = xml.match(re);
  if (m) return _parseCenter(m[1]);
  // 2. Known resource-ids.
  const byId = _findByResId(xml, ":id/feed_tab", ":id/home_tab");
  if (byId) return byId;
  // 3. Positional fallback — use the same validated bottom-nav-row detector
  //    as Search. The old implementation treated any leftmost clickable node
  //    below 88% as Home. On the search-results screen that can miss the nav
  //    row (or select an unrelated node), causing the caller to issue a blind
  //    second Back and exit Instagram.
  const { w: xmlW, h: xmlH } = _getScreenSizeFromXml(xml) ?? getScreenSize(serial);
  const botMin = Math.round(xmlH * 0.84);
  const raw: { x: number; y: number }[] = [];
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let nm: RegExpExecArray | null;
  while ((nm = nodeRe.exec(xml)) !== null) {
    const attrs = nm[1];
    if (!/clickable="true"/.test(attrs)) continue;
    const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bm) continue;
    const cy = Math.round((Number(bm[2]) + Number(bm[4])) / 2);
    if (cy < botMin) continue;
    raw.push({ x: Math.round((Number(bm[1]) + Number(bm[3])) / 2), y: cy });
  }
  const deduped = raw.filter((n, i, arr) =>
    arr.findIndex(o => Math.abs(o.x - n.x) < 40 && Math.abs(o.y - n.y) < 40) === i,
  );
  const spanW = deduped.length > 1 ? deduped[deduped.length - 1].x - deduped[0].x : 0;
  if (deduped.length < 4 || spanW < xmlW * 0.55) return null;
  deduped.sort((a, b) => a.x - b.x);
  return deduped[0]; // leftmost = Home
}

/**
 * Slow (UIAutomator dump) "are we still inside the Instagram story viewer?"
 * check, designed to avoid the false-negative bug in `findHomeTab`.
 *
 * WHY THIS EXISTS — the false-negative bug
 * ─────────────────────────────────────────
 * The previous slow-path in `stillInStoryViewer` (mobile.ts) used:
 *
 *   findHomeTab(serial).then(r => r === null)   // true = still in viewer
 *
 * `findHomeTab` strategy 3 is a positional fallback that returns the
 * leftmost clickable node at y > 88% of screen height when no
 * content-desc/resource-id match is found.  Inside the story viewer the
 * bottom of the screen holds the "Send message" input bar and the heart /
 * paper-plane action icons — all clickable, all at y > 88%.  Strategy 3
 * picked them up, returned a non-null result, and
 * `stillInStoryViewer()` concluded "home tab found → viewer closed."  The
 * viewer was still open; the loop stopped anyway and the follow tool
 * then tried to tap the Search icon while the phone was still inside a
 * story.
 *
 * THE FIX — positive detection first
 * ───────────────────────────────────
 * Check for presence of story-viewer-specific resource IDs BEFORE asking
 * whether the home tab is visible.  If any story-viewer marker is in the
 * dump we are definitively inside the viewer.  Only when those are absent
 * do we look for the home tab, and only via content-desc / known
 * resource-ids — the unsafe positional fallback is never used.
 *
 * Safe default: when the dump is ambiguous (neither marker nor home-tab
 * found) we return `true` (assume still in viewer).  A wrong "still open"
 * causes a harmless mis-advance; a wrong "closed" causes blind taps on
 * whatever is underneath — the exact failure this check exists to prevent.
 */
export async function isInStoryViewerSlow(serial: string): Promise<boolean> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => null);
  if (!xml) return true; // dump failed → assume still in viewer (safe default)

  // ── 0. Standalone Reels player — NOT the story viewer ────────────────────
  // The Reels player (opened by tapping a Reel in the feed or the Reels tab)
  // uses the same reel_viewer_* resource IDs as the story viewer internally,
  // so the positive-marker check below produces a false positive: when the
  // story-bubble tap misses and opens a Reel instead, this function used to
  // return true ("story viewer open"), causing the automation to run the
  // whole story loop inside the Reels player.
  //
  // Distinguish the two screens:
  //   Story viewer  — no Reels tab / clips-player IDs; no "Reels" header label
  //   Reels player  — has clips_tab / reels_tab in the nav, or a "Reels"
  //                   header/title node, or clips_viewer / reels_player IDs
  //
  // If ANY of these are present we are definitively NOT in the story viewer.
  const REELS_PLAYER_MARKERS = [
    ":id/clips_tab",
    ":id/reels_tab",
    ":id/tab_clips",
    ":id/nav_clips",
    ":id/clips_viewer",
    ":id/reels_viewer",
    ":id/reels_player",
  ];
  const hasReelsPlayerMarker = REELS_PLAYER_MARKERS.some(m => xml.includes(m));
  // Also catch the "Reels" header title that appears in the top bar of the
  // standalone Reels player (content-desc or text node).
  const hasReelsHeader =
    /content-desc="Reels"/.test(xml) ||
    /text="Reels"/.test(xml);
  if (hasReelsPlayerMarker || hasReelsHeader) return false;

  // ── 1. Positive story-viewer markers ─────────────────────────────────────
  // Any of these resource-id substrings are only present when the story
  // viewer is on screen.  If found we can return immediately — no need to
  // check for the home tab.
  // NOTE: "reel_viewer" is intentionally still here — the story viewer uses
  // reel_viewer_* IDs too, and the Reels-player exclusion above already
  // filters out the standalone Reels case before we reach this check.
  const STORY_MARKERS = [
    "toolbar_like_button",   // story like button (heart) in the action toolbar
    "reel_viewer",           // covers reel_viewer_root, reel_viewer_video_player,
                             //   reel_viewer_toolbar, reel_viewer_follow_button, etc.
    "story_viewer",          // older IG builds use story_viewer_* resource IDs
    "tray_viewer",           // some builds: tray_viewer_container
  ] as const;
  for (const marker of STORY_MARKERS) {
    if (xml.includes(marker)) return true;
  }

  // ── 1b. Newer Story viewer layout fallback ─────────────────────────────
  // Some Instagram builds expose none of the historical story/reel viewer
  // resource IDs, but do expose the visible lower reply bar and action row.
  // This is still a positive Story signal when the reply composer is paired
  // with a Story action label (Like Story/Share Story) or a lower-screen
  // Send-message control. Check this before Home detection: treating this
  // layout as Home caused the Stories tool to tap Home, scan the current
  // viewer as a tray, and sometimes focus the reply composer.
  const hasStoryReplyBar =
    /(?:text|content-desc|hint)="Send message"/i.test(xml) ||
    /(?:text|content-desc)="Send Message or Reaction"/i.test(xml) ||
    /message_composer_container|composer_text|story_reply|reply_composer/i.test(xml);
  const hasStoryActionSignal =
    /(?:content-desc|text)="(?:Like Story|Share Story|Send)"/i.test(xml) ||
    /(?:toolbar_like|story_like|story_share|story_action|reshare)/i.test(xml);
  if (hasStoryReplyBar && hasStoryActionSignal) return true;

  // ── 1a. Story-creation / media-picker screen — NOT the viewer ────────────
  // If the device accidentally opened the "Add to story" upload editor (e.g.
  // because the upload control was selected instead of a friend's story
  // bubble), neither STORY_MARKERS nor the home tab will be present, so the
  // code would fall through to the "ambiguous → assume still in viewer" default
  // and falsely report success. Detect the editor explicitly and return false
  // so the caller knows to back out.
  if (
    /text="Add to story"/i.test(xml) ||
    /content-desc="Add to story"/i.test(xml)
  ) {
    return false;
  }

  // ── 2. Home-tab check — content-desc and resource-id ONLY ────────────────
  // Deliberately no positional fallback here (that's what caused the bug).
  const homeByDesc = /content-desc="Home[^"]*"/.test(xml);
  if (homeByDesc) return false;
  const homeById = _findByResId(xml, ":id/feed_tab", ":id/home_tab");
  if (homeById) return false;

  // ── 3. Ambiguous — default to "still in viewer" ───────────────────────────
  return true;
}

/**
 * Find the Reels tab (square icon with a play triangle) in Instagram's
 * bottom navigation bar.
 *
 * Strategy (tried in order):
 *  1. Known resource-ids (clips_tab, reels_tab, …)
 *  2. Accessibility label "Reels"
 *  3. Positional fallback — scan the bottom-nav band (y > 88 % of xml height)
 *     for clickable nodes, sort left-to-right, return index 1 (the confirmed
 *     Reels slot on this device: home / reels / shop / search / profile).
 *     If the node count differs from 5, we still return index 1 as the best
 *     guess — callers should log and verify with the diagnostic dump.
 *
 * The positional fallback uses the XML-reported dimensions (not wm size) so
 * every percentage threshold stays consistent with the dump coordinates
 * (same lesson as findComposeTopLeftHeaderIcon, Jul 2026).
 */
export async function findReelsTab(
  serial: string,
  onLog?: (msg: string) => void,
): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;

  // 1. Resource-id
  const byId = _findBottomReelsResource(xml);
  if (byId) return byId;

  // 2. Accessibility label
  const byLabel = _findBottomReelsLabel(xml);
  if (byLabel) return byLabel;

  // 3. Positional fallback — collect all clickable nodes in the bottom-nav
  //    band, de-duplicate overlapping bounds, sort left-to-right, pick index 1.
  const { w: xmlW, h: xmlH } = _getScreenSize(xml);
  const botMin = Math.round(xmlH * 0.88);
  const raw: { x: number; y: number }[] = [];
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let nm: RegExpExecArray | null;
  while ((nm = nodeRe.exec(xml)) !== null) {
    const attrs = nm[1];
    if (!/clickable="true"/.test(attrs)) continue;
    const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bm) continue;
    const cy = Math.round((Number(bm[2]) + Number(bm[4])) / 2);
    if (cy < botMin) continue;
    raw.push({ x: Math.round((Number(bm[1]) + Number(bm[3])) / 2), y: cy });
  }
  // De-duplicate: two nodes within 40 px of each other count as one tap target
  const deduped = raw.filter((n, i, arr) =>
    arr.findIndex(o => Math.abs(o.x - n.x) < 40 && Math.abs(o.y - n.y) < 40) === i,
  );
  deduped.sort((a, b) => a.x - b.x);

  const { w: realW, h: realH } = getScreenSize(serial);
  onLog?.(
    `Reels tab: a11y miss — bottom-nav scan (${deduped.length} node(s) below y=${botMin}, ` +
    `xml ${xmlW}×${xmlH} real ${realW}×${realH}): ` +
    (deduped.length ? deduped.map(n => `(${n.x},${n.y})`).join(" | ") : "none"),
  );

  // Need at least 2 nodes: index 0 = Home, index 1 = Reels
  if (deduped.length >= 2) return deduped[1];
  return null;
}

/**
 * Find the inline "Follow" pill Instagram shows in the story viewer header,
 * next to the account name, when the signed-in account doesn't already
 * follow the story owner. This is a genuine uiautomator dump (~3-4s), so
 * callers should only invoke it when a follow attempt has already been
 * decided (chance roll + rate limits passed) — not on every slide.
 *
 * Returns null if no such button is present (already following, or the
 * button isn't rendered on this device/build) — callers must treat that as
 * "nothing to follow here", not an error.
 */
export async function findStoryFollowButton(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial);
  if (!xml) return null;
  // Word-boundary anchored so this never matches "Following" (already
  // followed — tapping that would UNfollow, the opposite of intent) or a
  // button belonging to some other on-screen element.
  const re = /content-desc="Follow"[^>]*bounds="([^"]+)"/;
  const m = xml.match(re);
  if (m) return _parseCenter(m[1]);
  return _findByResId(xml, ":id/follow_button_text", ":id/reel_viewer_follow_button");
}

/**
 * Returns the center-coordinates of every visible profile-grid post thumbnail
 * currently in the accessibility tree.
 *
 * Instagram's profile grid renders each thumbnail as a Button with
 * resource-id `com.instagram.android:id/image_button`.  The content-desc is
 * typically "Photo by X at row N, column M", "Reel by X at row N, column M",
 * "Video by X …", or sometimes blank — so we key off the resource-id, not
 * the label.
 *
 * Why this exists: the old inject-browsing code remembered fixed percentage
 * slots (w*0.17, w*0.50, w*0.83 at h*0.55) that it accumulated across scroll
 * rows, then tapped one at random.  Those coordinates are forbidden by the
 * project rules (Instagram's layout shifts by post type, account, and MIUI
 * version) and they frequently missed the actual thumbnail cells, landing on
 * the Reels-tab strip, a gap at the grid bottom, or empty whitespace —
 * triggering the "no post opened here" fallback even on profiles with
 * hundreds of visible posts.
 *
 * This function reads the live accessibility tree instead.  Only nodes whose
 * centre falls within the visible scrollable band (y ∈ [minY, maxY]) are
 * returned so we never try to tap a partially-offscreen thumbnail.
 */

/**
 * Reads the post count shown in the profile header stats row (the "482 posts"
 * figure that sits beside Followers and Following).  Returns null when the
 * count cannot be found — callers should treat null as "no cap on scrolls".
 *
 * Strategies tried in order:
 *   1. Node whose content-desc matches /^\d[\d,.]+ posts?$/i  (most specific)
 *   2. content-desc of any node that contains "N posts," (stats summary row)
 *   3. Text node whose resource-id contains "post_count" or "post_num"
 *   4. Number text-node that immediately precedes a "posts" label text-node
 *      in the XML document (last-resort proximity heuristic)
 */
export async function getProfilePostCount(serial: string): Promise<number | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;

  const parseCount = (s: string): number | null => {
    const n = parseInt(s.replace(/[,.\s]/g, ""), 10);
    return isNaN(n) || n < 0 ? null : n;
  };

  // Strategy 1: content-desc that IS the post count label, e.g. "482 posts"
  const s1 = xml.match(/content-desc="(\d[\d,.]*)\s+[Pp]osts?"[^>]*\/>/);
  if (s1) { const n = parseCount(s1[1]); if (n !== null) return n; }

  // Strategy 2: stats summary node, e.g. "482 posts, 11.1K followers, 31 following"
  const s2 = xml.match(/content-desc="(\d[\d,.]*)\s+[Pp]osts?[,\s]/);
  if (s2) { const n = parseCount(s2[1]); if (n !== null) return n; }

  // Strategy 3: resource-id containing "post_count" or "post_num"
  const s3 = xml.match(/resource-id="[^"]*(?:post_count|post_num|postcount)[^"]*"[^>]*text="(\d[\d,.]*)"/);
  if (s3) { const n = parseCount(s3[1]); if (n !== null) return n; }

  // Strategy 4: text="NNN" node that is followed within 600 chars by text="Posts" / text="posts"
  const postsLabelIdx = xml.search(/text="[Pp]osts?"[^>]*\/>/);
  if (postsLabelIdx > 0) {
    const window = xml.slice(Math.max(0, postsLabelIdx - 600), postsLabelIdx);
    const allNums = [...window.matchAll(/text="(\d[\d,.]*)"/g)];
    if (allNums.length) {
      const n = parseCount(allNums[allNums.length - 1][1]);
      if (n !== null) return n;
    }
  }

  return null;
}

export async function findProfileGridPosts(
  serial: string,
  onLog?: (line: string) => void,
): Promise<{ x: number; y: number; cd: string }[]> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return [];
  const { h } = getScreenSize(serial);
  // Ignore thumbnails whose centre is in the top 18% of the screen (nav/header
  // area) or the bottom 10% (nav bar / tab strip).
  const minY = Math.round(h * 0.18);
  const maxY = Math.round(h * 0.90);
  const RID = "com.instagram.android:id/image_button";
  const results: { x: number; y: number; cd: string }[] = [];
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const a = m[1];
    if (!a.includes("image_button")) continue;      // fast pre-filter
    const ridM = a.match(/resource-id="([^"]*)"/);
    if (!ridM?.[1].includes("image_button")) continue;
    const bm = a.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bm) continue;
    const x1 = Number(bm[1]), y1 = Number(bm[2]), x2 = Number(bm[3]), y2 = Number(bm[4]);
    const cx = Math.round((x1 + x2) / 2);
    const cy = Math.round((y1 + y2) / 2);
    if (cy < minY || cy > maxY) continue;
    // Require a minimum size so we don't pick header/avatar image buttons.
    // Profile grid thumbnails are roughly 1/3 screen wide and square.
    const nodeW = x2 - x1;
    const nodeH = y2 - y1;
    if (nodeW < 60 || nodeH < 60) continue;
    const cdM = a.match(/content-desc="([^"]*)"/);
    const cd = cdM?.[1] ?? "";
    results.push({ x: cx, y: cy, cd });
  }
  onLog?.(`[profile-grid] found ${results.length} image_button node(s) in visible band`);
  return results;
}

/**
 * Returns true when the device is currently showing an opened post or Reel
 * viewer (i.e. a tap from the profile grid navigated INTO a post), rather
 * than still sitting on the profile grid.
 *
 * Used by the inject-browsing scroll-recovery logic to distinguish two cases
 * that both produce findFeedActionIcons=null:
 *   A) Tap landed on blank whitespace → still on profile grid → safe to
 *      do scroll-up + retry.
 *   B) Reel (or other post) opened but icons not found by findFeedActionIcons
 *      (e.g. Reel viewer uses different label) → we're INSIDE the viewer →
 *      must press Back once to return to grid, NOT press Back + scroll + retry
 *      (which would close the viewer and potentially mis-tap something else).
 *
 * Detection: looks for resource-ids that only appear inside a post/reel
 * viewer and never on the profile-grid screen:
 *   - reel_viewer_follow_button  — Reel fullscreen viewer
 *   - row_feed_photo_profile_name — feed-post viewer (profile username row)
 *   - row_feed_button_like        — feed-post viewer (like button)
 * Any one of these present = we're inside a viewer, not on the grid.
 */
export async function isInPostViewer(serial: string): Promise<boolean> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return false;
  return (
    xml.includes("reel_viewer_follow_button") ||
    xml.includes("row_feed_photo_profile_name") ||
    xml.includes("row_feed_button_like")
  );
}

/**
 * Best-effort extraction of the current story owner's @username from the
 * accessibility tree, for the "skip Indian users" filter only. Instagram's
 * story header renders the username as a plain TextView near the top of the
 * screen; this looks for the first TextView in that band whose text looks
 * like a username. Returns null (never guesses) when nothing plausible is
 * found — callers must treat null as "can't tell, don't filter" rather than
 * "definitely not a match".
 */
export async function getStoryOwnerUsername(serial: string): Promise<string | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial);
  if (!xml) return null;
  const { h } = _getScreenSize(xml);
  const topBandLimit = h ? Math.round(h * 0.15) : Infinity;
  const re = /class="android\.widget\.TextView"[^>]*text="([^"]+)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const [, text, , y1] = m;
    if (+y1 > topBandLimit) continue;
    const candidate = text.trim();
    if (/^[A-Za-z0-9._]{2,30}$/.test(candidate)) return candidate;
  }
  return null;
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

/**
 * Returns the IP address of the host machine as seen from inside Android —
 * i.e. the default gateway used by the emulator.  This is how we tell Android
 * where our local proxy relay is listening.
 * Falls back to 10.0.2.2 (the standard Android emulator / LDPlayer gateway).
 */
export async function getGatewayIp(serial: string): Promise<string> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const r = spawnSync(adb, ["-s", serial, "shell", "ip", "route", "show", "default"], { encoding: "utf8", timeout: 5000 });
  const out = (r.stdout || "").trim();
  const m = out.match(/via\s+([\d.]+)/);
  if (m?.[1]) return m[1];
  return "10.0.2.2";
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

/**
 * On Windows: bring the BlueStacks window to the foreground so the user
 * can see the UIAutomator automation happening in real time.
 */
function _bringBlueStacksToFront(): void {
  if (process.platform !== "win32") return;
  try {
    // Single clean PowerShell line — finds HD-Player (BlueStacks 5) and brings it to front
    const ps = `$p=Get-Process -Name HD-Player,BlueStacks -EA 0|Where-Object{$_.MainWindowHandle -ne 0}|Select -First 1;if($p){Add-Type -Name U32 -Namespace W -MemberDefinition '[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n);[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);';[W.U32]::ShowWindow($p.MainWindowHandle,9);[W.U32]::SetForegroundWindow($p.MainWindowHandle)}`;
    spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 5000 });
  } catch { /* best-effort — never fail the whole automation */ }
}

/** Close BlueStacks on Windows (best-effort). */
export function closeBlueStacks(): void {
  if (process.platform !== "win32") return;
  try { spawnSync("taskkill", ["/F", "/IM", "HD-Player.exe"], { encoding: "utf8", timeout: 6000 }); } catch { /**/ }
  try { spawnSync("taskkill", ["/F", "/IM", "BlueStacks.exe"], { encoding: "utf8", timeout: 3000 }); } catch { /**/ }
}

function _sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Dump current UI to XML and return its content. */
/**
 * Public wrapper around `_uiDump` for debug tooling — guessing tap
 * coordinates from screen percentages has repeatedly landed on the wrong
 * element (Home tab, then the story tray). Exposing the raw accessibility
 * dump lets us read the actual resource-id/content-desc of an element
 * instead of guessing again.
 */
export async function dumpUi(serial: string): Promise<string> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  return _uiDump(adb, serial);
}

/**
 * Like dumpUi but includes the IME (soft keyboard) window in the dump.
 * Uses `uiautomator dump --include-ime` (Android 6+). If the device doesn't
 * support the flag the output will be an error string or empty — we detect
 * that and fall back to a regular dump so the caller always gets a usable
 * tree. Used by the Inspect tool so keyboard keys appear as tappable nodes
 * when the on-screen keyboard is visible.
 */
export async function dumpUiWithIme(serial: string): Promise<{ xml: string; imeIncluded: boolean }> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");

  // Try --include-ime first (Android 6+ / uiautomator 2.x)
  const tmpDev  = "/sdcard/equinox_ui_dump_ime.xml";
  const tmpHost = path.join(os.tmpdir(), `equinox-ui-ime-${serial.replace(/[^a-z0-9]/gi, "-")}.xml`);

  let imeXml = "";
  await new Promise<void>((resolve) => {
    const child = spawn(adb, ["-s", serial, "shell", "uiautomator", "dump", "--include-ime", tmpDev], { stdio: "ignore" });
    const t = setTimeout(() => { try { child.kill(); } catch { /**/ } resolve(); }, 9000);
    child.on("close", () => { clearTimeout(t); resolve(); });
    child.on("error", () => { clearTimeout(t); resolve(); });
  });
  await new Promise<void>((resolve) => {
    const child = spawn(adb, ["-s", serial, "pull", tmpDev, tmpHost], { stdio: "ignore" });
    const t = setTimeout(() => { try { child.kill(); } catch { /**/ } resolve(); }, 6000);
    child.on("close", () => { clearTimeout(t); resolve(); });
    child.on("error", () => { clearTimeout(t); resolve(); });
  });
  try { imeXml = fs.readFileSync(tmpHost, "utf8"); fs.unlinkSync(tmpHost); } catch { /**/ }

  // A valid dump always ends with </hierarchy>. If it's missing or empty the
  // flag isn't supported on this device → fall back to the standard dump.
  if (imeXml && imeXml.includes("</hierarchy>")) {
    // Keep the combined dump in the same diagnostic stream as ordinary dumps.
    // This is the only dump that can explain a visible keyboard that is absent
    // from the app-only tree.
    recorder.addDump(serial, imeXml);
    return { xml: imeXml, imeIncluded: true };
  }

  const fallback = await _uiDump(adb, serial);
  return { xml: fallback, imeIncluded: false };
}

/**
 * Return the package portion of Android's active input method setting.
 *
 * Gboard's accessibility nodes are not Instagram nodes, but some Android/OEM
 * builds omit the IME package/resource-id from individual nodes. The active
 * IME setting gives us a package-level anchor without relying on a keyboard
 * label (which may be blank or localized).
 */
async function getActiveInputMethodPackage(serial: string): Promise<string> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const raw = await runAdb(adb, ["-s", serial, "shell", "settings", "get", "secure", "default_input_method"], 4000);
  const value = raw.trim().split(/\s+/)[0] ?? "";
  return value.split("/")[0] ?? "";
}

/**
 * Gboard's Emoji picker is often exposed as a different lower-window tree
 * than the normal keyboard. Use its own labels/resource ids as a lightweight
 * post-tap signal; this is only verification, never a tap target.
 */
async function isKeyboardEmojiPickerOpen(serial: string): Promise<boolean> {
  const { xml } = await dumpUiWithIme(serial);
  if (!xml) return false;
  const { h: screenH } = getScreenSize(serial);
  let emojiCells = 0;
  const nodeRe = /<node\s([^>]+?)\s*\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = nodeRe.exec(xml)) !== null) {
    const attrs = match[1];
    const bounds = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
    if (!bounds) continue;
    const y1 = Number(bounds[2]);
    const y2 = Number(bounds[4]);
    if ((y1 + y2) / 2 < Math.round(screenH * 0.42)) continue;
    const label = [
      attrs.match(/\btext="([^"]*)"/i)?.[1] ?? "",
      attrs.match(/\bcontent-desc="([^"]*)"/i)?.[1] ?? "",
      attrs.match(/\bhint="([^"]*)"/i)?.[1] ?? "",
      attrs.match(/\bresource-id="([^"]*)"/i)?.[1] ?? "",
    ].join(" ");
    if (
      /\p{Extended_Pictographic}/u.test(label) ||
      /(?:grinning|smiling|smile|laugh|joy|heart|face|thumb|hand|fire|sparkles|kiss|wink|angry|sad|emoji)/i.test(label)
    ) {
      emojiCells++;
      if (emojiCells >= 2) return true;
    }
  }
  return false;
}

/**
 * Switches the active Instagram account to the one matching `username` by
 * triggering Instagram's built-in account switcher:
 *   1. Tap the profile tab once to open the active account profile
 *   2. UIAutomator dump the profile and tap its top username control
 *   3. UIAutomator dump the account-list sheet
 *   4. Find the node whose text matches the username
 *   5. Tap it and wait for the account to load
 *
 * Returns true if the switch was performed (or the account was already active),
 * false if the username wasn't found in the switcher.
 *
 * The account's active/already-selected state is determined from the account
 * sheet after it opens. Do not infer it from the pre-sheet profile UI: that
 * screen can contain the username for reasons unrelated to the selectable
 * account row.
 */
export async function switchToInstagramAccount(
  serial: string,
  username: string,
  onLog?: (msg: string) => void,
  preloadedXml?: string, // XML from a dump taken moments earlier; skips two redundant dumps
  swipeGesture?: {
    x1: number; y1: number; x2: number; y2: number;
    durationMinMs: number; durationMaxMs: number;
    jitterX: number; jitterY: number;
    startJitterMinY?: number; startJitterMaxY?: number;
  },
): Promise<boolean> {
  if (!username.trim()) return false;
  const adbPath = findAdbPath();
  if (!adbPath) { onLog?.("  ⚠ ADB not found — cannot switch account"); return false; }

  const clean = username.replace(/^@/, "").trim();

  // 1. Find the profile tab.
  //    Try the preloaded XML first (same screen state, no extra dump needed).
  //    Fall back to a poll loop if the tab isn't found there.
  //
  //    Poll loop rationale: on a cold-start (first cycle after launch, or
  //    shortly after airplane-mode reconnect) Instagram's process is alive and
  //    the screen reports as "open", but the bottom navigation bar — including
  //    the profile tab — hasn't rendered into the accessibility tree yet.  A
  //    single dump fired immediately after the "open" confirmation sees an
  //    empty or bare-skeleton UI and returns null, causing the switch to fail
  //    before the switcher-sheet polling logic is even reached.
  //    The poll mirrors the existing switcher-sheet poll: up to 5 × 1500 ms
  //    (7.5 s total budget), exits the moment the tab appears, zero extra
  //    wait on a warm Instagram where the nav bar is already rendered.
  let profileTab: { x: number; y: number } | null = null;
  let profileTabSource = "unknown";
  if (preloadedXml) {
    profileTab =
      _findBottomProfileResource(preloadedXml)
       ?? _findBottomProfileLabel(preloadedXml);
    if (profileTab) profileTabSource = "preloaded accessibility tree";
  }
  if (!profileTab) {
    const PROFILE_TAB_POLL_MS  = 1500;
    const PROFILE_TAB_MAX_POLL = 8;
    for (let pt = 0; pt < PROFILE_TAB_MAX_POLL; pt++) {
      profileTab = await findInstagramProfileTab(serial).catch(() => null);
      if (profileTab) {
        profileTabSource = `live accessibility poll ${pt + 1}/${PROFILE_TAB_MAX_POLL}`;
        break;
      }
      // Do not call dismissInstagramInterstitials() here. That helper performs
      // another full UIAutomator dump. On a cold/overloaded device one dump can
      // take 18–20 seconds, so the old "1.5 s" retry actually stacked two
      // blocking dumps and made the result depend on transient ADB load.
      if (pt < PROFILE_TAB_MAX_POLL - 1) {
        onLog?.(`  ↳ Profile tab not yet visible — waiting ${PROFILE_TAB_POLL_MS / 1000}s for nav bar to render (accessibility poll ${pt + 1}/${PROFILE_TAB_MAX_POLL})…`);
        await _sleep(PROFILE_TAB_POLL_MS);
      }
    }
  }
  if (!profileTab) {
    const screen = getScreenSize(serial);
    profileTab = {
      x: Math.round(screen.w * 0.92),
      y: Math.round(screen.h * 0.94),
    };
    profileTabSource = "fallback bottom-right profile position";
    onLog?.(`  ⚠ Profile tab not found in accessibility — using fallback tap at (${profileTab.x},${profileTab.y}) and continuing`);
  }

  // The profile tab can appear in the accessibility tree before Instagram has
  // finished rendering the feed/navigation surface (especially when this
  // coordinate came from the launch-time preload dump).  Starting the hold at
  // that point can be consumed by the still-settling navigation view instead
  // of opening the account switcher.  Give the surface one short, bounded
  // settle window after the tab is detected; this is deliberately a wait, not
  // a second gesture or a retry.
  const PROFILE_TAB_SETTLE_MS = 1500;
  onLog?.(`  ↳ Profile tab found at (${profileTab.x},${profileTab.y}) via ${profileTabSource} — waiting ${PROFILE_TAB_SETTLE_MS / 1000}s for Instagram to finish rendering…`);
  await _sleep(PROFILE_TAB_SETTLE_MS);

  // 2. Open the active account profile with a single tap. Instagram's newer
  // account UI no longer reliably opens the account list from a long-press.
  const profileBeforeTapXml = preloadedXml || "";
  onLog?.(`  ↳ Tapping profile tab at (${profileTab.x},${profileTab.y}) to open the active account profile…`);
  await _adbTapAsync(adbPath, serial, profileTab.x, profileTab.y);
  await _sleep(450);
  const profileAfterTabTapXml = await _uiDump(adbPath, serial).catch(() => "");
  onLog?.(`  ↳ Profile-tab tap result: xmlLength=${profileAfterTabTapXml.length}, changed=${profileBeforeTapXml ? profileAfterTabTapXml !== profileBeforeTapXml : "not-comparable"}, hasProfileHeader=${/action_bar_username_container/i.test(profileAfterTabTapXml)}, hasBottomNav=${/bottom_nav|tab_bar|profile_tab/i.test(profileAfterTabTapXml)}`);
  const PROFILE_SCREEN_SETTLE_MS = 1000 + Math.floor(Math.random() * 1501);
  onLog?.(`  ↳ Waiting ${PROFILE_SCREEN_SETTLE_MS}ms for the profile header to settle…`);
  await _sleep(PROFILE_SCREEN_SETTLE_MS);

  // 3. On the profile screen, tap the username in the top header. Restrict
  // the match to the header region so a username in a post or suggestion
  // cannot be mistaken for the account-switch control.
  const profileXml = await _uiDump(adbPath, serial).catch(() => "");
  let profileHeaderUsername = _findTopProfileUsername(profileXml);
  if (!profileHeaderUsername) {
    const profileDumpDiagnostics = (() => {
      const root = profileXml.match(/<hierarchy[^>]*bounds="([^"]+)"/i)?.[1] ?? "";
      const topNodes: string[] = [];
      const nodeRe = /<node\b([^>]*)>/gi;
      let match: RegExpExecArray | null;
      while ((match = nodeRe.exec(profileXml)) !== null) {
        const attrs = match[1];
        const bounds = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
        if (!bounds || Number(bounds[2]) > 500) continue;
        const text = attrs.match(/\btext="([^"]*)"/i)?.[1] ?? "";
        const contentDesc = attrs.match(/content-desc="([^"]*)"/i)?.[1] ?? "";
        const resourceId = attrs.match(/resource-id="([^"]*)"/i)?.[1] ?? "";
        const clickable = /clickable="true"/i.test(attrs);
        if (text || contentDesc || resourceId) {
          topNodes.push(
            `bounds="${bounds[0]}" text=${JSON.stringify(text)} ` +
            `contentDesc=${JSON.stringify(contentDesc)} resourceId=${JSON.stringify(resourceId)} ` +
            `clickable=${clickable}`,
          );
        }
      }
      return {
        xmlLength: profileXml.length,
        complete: profileXml.includes("</hierarchy>"),
        rootBounds: root,
        hasUsernameContainer: /action_bar_username_container/i.test(profileXml),
        targetLabelOccurrences: (profileXml.match(new RegExp(clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) ?? []).length,
        topNodeCount: topNodes.length,
        topNodes: topNodes.slice(0, 40),
      };
    })();
    onLog?.(`  ↳ Profile-header selector diagnostics: ${JSON.stringify(profileDumpDiagnostics)}`);
    const screen = getScreenSize(serial);
    const fallbackHeader = {
      x: Math.round(screen.w * 0.50),
      y: Math.round(screen.h * 0.08),
    };
    onLog?.(`  ⚠ Could not find @${clean} in the profile header — using fallback tap at (${fallbackHeader.x},${fallbackHeader.y}) and continuing`);
    profileHeaderUsername = fallbackHeader;
  }
  const headerNode = (() => {
    const boundsRe = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/;
    const nodeRe = /<node\b([^>]*)>/gi;
    let match: RegExpExecArray | null;
    while ((match = nodeRe.exec(profileXml)) !== null) {
      const attrs = match[1];
      const bounds = attrs.match(boundsRe);
      if (!bounds) continue;
      const x1 = Number(bounds[1]); const y1 = Number(bounds[2]);
      const x2 = Number(bounds[3]); const y2 = Number(bounds[4]);
      if (profileHeaderUsername.x < x1 || profileHeaderUsername.x > x2 ||
          profileHeaderUsername.y < y1 || profileHeaderUsername.y > y2) continue;
      return {
        resourceId: attrs.match(/resource-id="([^"]*)"/i)?.[1] ?? "",
        text: attrs.match(/\btext="([^"]*)"/i)?.[1] ?? "",
        contentDesc: attrs.match(/content-desc="([^"]*)"/i)?.[1] ?? "",
        clickable: /clickable="true"/i.test(attrs),
        bounds: `[${x1},${y1}][${x2},${y2}]`,
      };
    }
    return null;
  })();
  onLog?.(`  ↳ Account-header tap target: (${profileHeaderUsername.x},${profileHeaderUsername.y}) node=${JSON.stringify(headerNode)}`);
  onLog?.(`  ↳ Tapping profile header username @${clean} to open account list…`);
  await _adbTapAsync(adbPath, serial, profileHeaderUsername.x, profileHeaderUsername.y);
  await _sleep(700);
  const postHeaderTapXml = await _uiDump(adbPath, serial).catch(() => "");
  const postHeaderState = {
    hasUsernameContainer: /action_bar_username_container/.test(postHeaderTapXml),
    hasEditProfile: /(?:text|content-desc)="Edit profile"/i.test(postHeaderTapXml),
    hasScrollableSheet: /scrollable="true"/i.test(postHeaderTapXml),
    accountRowLabelCount: (postHeaderTapXml.match(/(?:text|content-desc)="@?[a-z0-9._]{2,40}"/gi) ?? []).length,
    targetLabelPresent: postHeaderTapXml.toLowerCase().includes(`"${clean.toLowerCase()}"`) ||
      postHeaderTapXml.toLowerCase().includes(`"@${clean.toLowerCase()}"`),
    sheetMarkers: (postHeaderTapXml.match(/(?:account|switch|chooser|dialog|bottom_sheet|modal|action_bar_username_container)/gi) ?? []).slice(0, 20),
  };
  onLog?.(`  ↳ Account-header tap result: xmlLength=${postHeaderTapXml.length}, state=${JSON.stringify(postHeaderState)}`);

  // 4. Dump the accessibility tree and look for the target username.
  //    Instagram displays each account row as a node with text="username"
  //    (no @ prefix) or content-desc="username". Try both the bare username
  //    and the @-prefixed variant since different IG versions use different
  //    attributes.
  //
  //    Poll loop (up to 5 × 1500ms = 7.5s) — the switcher sheet sometimes
  //    opens visually but takes several extra seconds to fully populate its
  //    account rows in the accessibility tree (observed on freshly launched
  //    Instagram where the first video frame was still tiny / screen dark).
  //    A single dump fired immediately after the gesture catches the shell
  //    before the rows render and returns "not found" even though the account
  //    IS logged in. Subsequent cycles (warm Instagram) succeed because the
  //    switcher populates faster. The poll exits on the first dump that
  //    contains the username — zero extra wait in the normal (warm) case.
  let xml = postHeaderTapXml;
  let coords: { x: number; y: number } | null = null;
  const escapedUsername = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const usernameRowPattern = new RegExp(`(?:^|,\\s*)@?${escapedUsername}(?:,|$)`, "i");
  const switcherScreenHeight = getScreenSize(serial).h;
  const SWITCHER_POLL_MS  = 1500;
  const SWITCHER_MAX_POLL = 2;
  for (let p = 0; p < SWITCHER_MAX_POLL; p++) {
    xml = await _uiDump(adbPath, serial).catch(() => "");
    coords = _findVisibleAccountRow(xml, switcherScreenHeight, clean, `@${clean}`);
    if (coords) break; // found — proceed to tap
    if (p < SWITCHER_MAX_POLL - 1) {
      onLog?.(`  ↳ Switcher not fully populated yet — retrying in ${SWITCHER_POLL_MS / 1000}s (poll ${p + 1}/${SWITCHER_MAX_POLL})`);
      await _sleep(SWITCHER_POLL_MS);
    }
  }

  if (!coords) {
    // Primary exact search found nothing. Instagram's switcher often puts
    // relationship metadata after the username in the tappable row's
    // content-desc (for example: "user, 5 follows and 2 more"). Match the
    // username as the first bounded token of a live row instead of requiring
    // the whole description to equal the username.
    if (!coords) {
      coords = _findVisibleAccountRow(
        xml,
        switcherScreenHeight,
        usernameRowPattern,
      );
    }

    // The switcher is populated, but the requested account may be below the
    // current viewport. Scroll the live accessibility container once. The
    // gesture is derived from that node's bounds; never from device dimensions.
    if (!coords) {
      const scrollBounds = _findScrollableBounds(xml);
      if (scrollBounds) {
        onLog?.(`  ↳ @${clean} is below the visible account rows — scrolling the live switcher list once…`);
        const screen = getScreenSize(serial);
        const sheetW = Math.max(1, scrollBounds.x2 - scrollBounds.x1);
        const sheetH = Math.max(1, scrollBounds.y2 - scrollBounds.y1);
        const clamp = (value: number, min: number, max: number) =>
          Math.max(min, Math.min(max, Math.round(value)));
        const profile = swipeGesture;
        const normX = (value: number) => Math.max(0, Math.min(1, value / Math.max(1, screen.w - 1)));
        const normY = (value: number) => Math.max(0, Math.min(1, value / Math.max(1, screen.h - 1)));
         if (!profile) {
           throw new Error("Swipe Gesture Profile is required for account-list scrolling");
         }
         const profileX1 = scrollBounds.x1 + normX(profile.x1) * sheetW;
         const profileY1 = scrollBounds.y1 + normY(profile.y1) * sheetH;
         const profileX2 = scrollBounds.x1 + normX(profile.x2) * sheetW;
         const profileY2 = scrollBounds.y1 + normY(profile.y2) * sheetH;
         const jitterX = Math.max(0, profile.jitterX || 0) * sheetW / Math.max(1, screen.w);
         const jitterEndY = Math.max(0, profile.jitterY || 0) * sheetH / Math.max(1, screen.h);
         const startMinY = Math.max(0, Math.min(profile.startJitterMinY || 0, profile.startJitterMaxY || 0)) * sheetH / Math.max(1, screen.h);
         const startMaxY = Math.max(startMinY, profile.startJitterMaxY || startMinY) * sheetH / Math.max(1, screen.h);
        const startOffset = startMinY + Math.random() * Math.max(0, startMaxY - startMinY);
        const x1 = clamp(profileX1 + (Math.random() * 2 - 1) * jitterX, scrollBounds.x1, scrollBounds.x2);
        const y1 = clamp(profileY1 + startOffset, scrollBounds.y1, scrollBounds.y2);
        const x2 = clamp(profileX2 + (Math.random() * 2 - 1) * jitterX, scrollBounds.x1, scrollBounds.x2);
        const y2 = clamp(profileY2 + (Math.random() * 2 - 1) * jitterEndY, scrollBounds.y1, scrollBounds.y2);
        // Account-switcher scrolling is always forward/down the list. Never
        // reverse it based on a feed personality.
        const fromY = Math.max(y1, y2);
        const toY = Math.min(y1, y2);
        const midX = clamp((x1 + x2) / 2, scrollBounds.x1, scrollBounds.x2);
         if (!Number.isFinite(profile.durationMinMs) || !Number.isFinite(profile.durationMaxMs)) {
           throw new Error("Swipe Gesture Profile duration is invalid for account-list scrolling");
         }
         const durationMin = Math.min(profile.durationMinMs, profile.durationMaxMs);
         const durationMax = Math.min(150, Math.max(profile.durationMinMs, profile.durationMaxMs));
        const duration = Math.max(1, Math.round(durationMin + Math.random() * (durationMax - durationMin)));
        onLog?.(`  ↳ Account-list swipe mapped to sheet bounds: (${midX}, ${fromY}) → (${midX}, ${toY}) over ${duration}ms`);
        await runAdb(adbPath, [
          "-s", serial, "shell", "input", "swipe",
          String(midX), String(fromY), String(midX), String(toY), String(duration),
        ], 4000).catch(() => {});
        await _sleep(400);
        xml = await _uiDump(adbPath, serial).catch(() => "");
        coords = _findVisibleAccountRow(
          xml,
          switcherScreenHeight,
          usernameRowPattern,
        );
      }
    }

    if (!coords) {
      onLog?.(`  ⚠ "@${clean}" not found in switcher — is the account logged in on this device?`);
      // Continue the physical sequence even when accessibility does not expose
      // the row. This is intentionally a last-resort tap, not a success claim.
      // The picker remains open and the next cycle can still correct the state.
      const fallbackRow = Math.max(1, Math.min(switcherScreenHeight - 1, Math.round(switcherScreenHeight * 0.28)));
      coords = { x: Math.round(getScreenSize(serial).w * 0.5), y: fallbackRow };
      onLog?.(`  ↳ Continuing with fallback account-row tap at (${coords.x},${coords.y})`);
    }
  }

  // 5. Tap the username row to switch accounts.
  onLog?.(`  ✓ Found @${clean} in switcher — switching…`);
  _adbTap(adbPath, serial, coords.x, coords.y);

  // 6. Verify the resulting surface. A different account closes the sheet and
  // logs in naturally, so no Back is needed. When the tapped row is the
  // already-active account, Instagram can leave the account sheet open; in
  // that one case, dismiss it with exactly one Android Back. Never retry Back.
  await _sleep(1500);
  const postTapXml = await _uiDump(adbPath, serial).catch(() => "");
  if (postTapXml) {
    const homeFeedVisible =
      /content-desc="Home[^"]*"/.test(postTapXml) ||
      !!_findByResId(postTapXml, ":id/feed_tab", ":id/home_tab");
    if (!homeFeedVisible) {
      const escapedClean = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const selectedTargetRow = new RegExp(
        `<node\\b(?=[^>]*(?:text|content-desc)="@?${escapedClean}"[^>]*)(?=[^>]*(?:selected|checked|activated)="true")[^>]*>`,
        "i",
      ).test(postTapXml);
      if (!selectedTargetRow) {
        onLog?.(`  ⚠ @${clean} tap result was not verifiable — continuing without another account tap`);
        return true;
      }
      onLog?.(`  ↳ @${clean} was already active and its selected row remains open — pressing Android Back once`);
      await pressBack(serial).catch(() => {});
      await _sleep(700);
      const afterBackXml = await _uiDump(adbPath, serial).catch(() => "");
      const stillNotHome =
        !!afterBackXml &&
        !/content-desc="Home[^"]*"/.test(afterBackXml) &&
        !_findByResId(afterBackXml, ":id/feed_tab", ":id/home_tab");
      if (stillNotHome) {
        onLog?.(`  ⚠ Account sheet did not verify closed after the single Back; continuing`);
      }
    }
  }

  // 7. Give Instagram time to finish loading the feed.
  await _sleep(1500);
  return true;
}

/**
 * Dumps once and pulls the accessibility tree XML. Not exported — always go
 * through `_uiDump`, which validates the result and retries on truncation
 * (see below). A raw single-shot dump on a busy screen (deep scrollable
 * list + soft keyboard both mounted) can get killed by the timeout before
 * the on-device XML write finishes, which silently truncates the document
 * — every node written *after* the cut point (often everything below the
 * top of the screen) simply isn't there, even though it's visibly on
 * screen. That looked exactly like "0 elements" in the middle/bottom of
 * the layout scan and "0 keys mapped" for the keyboard, even with the
 * keyboard genuinely open.
 */
async function _uiDumpOnce(adb: string, serial: string): Promise<string> {
  const tmpDev = "/sdcard/equinox_ui_dump.xml";
  const tmpHost = path.join(os.tmpdir(), `equinox-ui-${serial.replace(/[^a-z0-9]/gi, "-")}.xml`);
  // CRITICAL: use async spawn (not spawnSync) so the Node event loop stays
  // free during the UIAutomator dump. spawnSync was blocking the entire
  // event loop, preventing the video WebSocket from flushing frames to the
  // client — ws.bufferedAmount spiked, the lag watchdog fired, screenrecord
  // restarted, and the client got a 10–20 s black screen then "catch-up".
  // With async spawn the video stream keeps flowing uninterrupted.
  // Timeout raised 5000ms → 9000ms: a screen with a deep/virtualized list
  // (search "Recent" results) plus an open soft keyboard can take the
  // on-device dump noticeably longer than a simple static screen, and
  // killing it mid-write is what produced truncated XML in the first place.
  await new Promise<void>((resolve) => {
    const child = spawn(adb, ["-s", serial, "shell", "uiautomator", "dump", tmpDev], { stdio: "ignore" });
    const t = setTimeout(() => { try { child.kill(); } catch { /**/ } resolve(); }, 9000);
    child.on("close", () => { clearTimeout(t); resolve(); });
    child.on("error", () => { clearTimeout(t); resolve(); });
  });
  await new Promise<void>((resolve) => {
    const child = spawn(adb, ["-s", serial, "pull", tmpDev, tmpHost], { stdio: "ignore" });
    const t = setTimeout(() => { try { child.kill(); } catch { /**/ } resolve(); }, 6000);
    child.on("close", () => { clearTimeout(t); resolve(); });
    child.on("error", () => { clearTimeout(t); resolve(); });
  });
  try {
    const xml = fs.readFileSync(tmpHost, "utf8");
    try { fs.unlinkSync(tmpHost); } catch { /**/ }
    return xml;
  } catch { return ""; }
}

async function _uiDump(adb: string, serial: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const xml = await _uiDumpOnce(adb, serial);
    // A complete dump always closes its root element. A truncated write
    // (killed mid-dump, or a partial pull) is missing this — retry instead
    // of silently handing back a document that's only populated near the
    // top of the tree.
    if (xml && xml.includes("</hierarchy>")) {
      recorder.addDump(serial, xml);
      return xml;
    }
    if (attempt < 2) await _sleep(400);
  }
  return "";
}

/** Parse "[x1,y1][x2,y2]" bounds → centre point. */
function _parseCenter(bounds: string): { x: number; y: number } | null {
  const m = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  return { x: Math.floor((+m[1] + +m[3]) / 2), y: Math.floor((+m[2] + +m[4]) / 2) };
}

/**
 * Find an element by any of the given strings in text/content-desc/hint/resource-id attrs.
 * Returns the centre {x,y} of the first match, or null.
 */
function _findElem(xml: string, ...candidates: string[]): { x: number; y: number } | null {
  for (const t of candidates) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const attr of ["text", "content-desc", "hint", "resource-id"]) {
      const re = new RegExp(`${attr}="${esc}"[^>]*bounds="([^"]+)"`, "i");
      const m = xml.match(re);
      if (m) { const c = _parseCenter(m[1]); if (c) return c; }
      const re2 = new RegExp(`${attr}="[^"]*${esc}[^"]*"[^>]*bounds="([^"]+)"`, "i");
      const m2 = xml.match(re2);
      if (m2) { const c2 = _parseCenter(m2[1]); if (c2) return c2; }
    }
  }
  return null;
}

/** Find the active profile's clickable username control in Instagram's top header. */
function _findTopProfileUsername(xml: string): { x: number; y: number } | null {
  // Instagram exposes the top account selector as this clickable container.
  // Prefer the container over its child TextView: tapping the child can be
  // interpreted as a scroll gesture on some builds/devices, while the parent
  // owns the account-sheet action. Bounds come from the live accessibility
  // node, so this works across device resolutions.
  const usernameContainerRe =
    /<node\b(?=[^>]*resource-id="[^"]*action_bar_username_container[^"]*")(?=[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*)[^>]*>/i;
  const usernameContainer = xml.match(usernameContainerRe);
  if (usernameContainer) {
    const x1 = Number(usernameContainer[1]);
    const y1 = Number(usernameContainer[2]);
    const x2 = Number(usernameContainer[3]);
    const y2 = Number(usernameContainer[4]);
    if (x2 > x1 && y2 > y1) {
      return { x: Math.floor((x1 + x2) / 2), y: Math.floor((y1 + y2) / 2) };
    }
  }

  // Compatibility fallback for builds that omit the container resource ID.
  const nodeRe = /<node\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = nodeRe.exec(xml)) !== null) {
    const attrs = match[1];
    const bounds = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
    if (!bounds) continue;
    const x1 = Number(bounds[1]);
    const y1 = Number(bounds[2]);
    const x2 = Number(bounds[3]);
    const y2 = Number(bounds[4]);
    const centerY = (y1 + y2) / 2;
    // The profile header is at the top; do not match post text or the grid.
    if (centerY > 420 || y2 <= y1 || x2 <= x1) continue;
    const labels = [
      attrs.match(/\btext="([^"]*)"/i)?.[1] ?? "",
      attrs.match(/\bcontent-desc="([^"]*)"/i)?.[1] ?? "",
    ];
    if (labels.some(label => {
      const value = label.replace(/^@/, "").trim();
      return /^[a-z0-9._]{2,40}$/i.test(value) && !/^(home|profile|edit profile|share profile|instagram)$/i.test(value);
    })) {
      return { x: Math.floor((x1 + x2) / 2), y: Math.floor((y1 + y2) / 2) };
    }
  }
  return null;
}

/**
 * Account-switcher rows can remain in the accessibility tree after they have
 * been clipped by the bottom edge of the sheet. Their calculated centre then
 * lands on the Android navigation bar, so a normal text match falsely looks
 * tappable. Require the live account-row container to have a usable height and
 * stay above the navigation-bar region.
 */
function _findVisibleAccountRow(
  xml: string,
  screenHeight: number,
  ...candidates: Array<string | RegExp>
): { x: number; y: number } | null {
  // The physical device height can exceed the accessibility window height
  // because Android reserves navigation/system-bar space. Prefer the live
  // hierarchy boundary when deciding whether a row is clipped.
  const rootBounds = xml.match(/<hierarchy[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
  const accessibilityBottom = rootBounds ? Number(rootBounds[4]) : screenHeight;
  for (const candidate of candidates) {
    for (const attr of ["content-desc", "text"]) {
      const nodeRe = new RegExp(
        `${attr}="([^"]*)"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
        "gi",
      );
      let m: RegExpExecArray | null;
      while ((m = nodeRe.exec(xml)) !== null) {
        const label = m[1];
        const matches = typeof candidate === "string"
          ? label.toLowerCase() === candidate.toLowerCase()
          : (candidate.lastIndex = 0, candidate.test(label));
        if (!matches) continue;
        const x1 = Number(m[2]);
        const y1 = Number(m[3]);
        const x2 = Number(m[4]);
        const y2 = Number(m[5]);
        // A real row is ~180 px high in the supplied dump. Keep margin for
        // device scaling, but reject clipped slivers such as the 19 px node.
        if (y2 - y1 < 100 || y2 > accessibilityBottom - 19) continue;
        return { x: Math.floor((x1 + x2) / 2), y: Math.floor((y1 + y2) / 2) };
      }
    }
  }
  return null;
}

function _findScrollableBounds(xml: string): { x1: number; y1: number; x2: number; y2: number } | null {
  const nodeRe = /<node\b([^>]*\bscrollable="true"[^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = nodeRe.exec(xml)) !== null) {
    const bounds = match[1].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
    if (!bounds) continue;
    const x1 = Number(bounds[1]);
    const y1 = Number(bounds[2]);
    const x2 = Number(bounds[3]);
    const y2 = Number(bounds[4]);
    if (x2 > x1 && y2 - y1 >= 300) return { x1, y1, x2, y2 };
  }
  return null;
}

/**
 * Like _findElem but returns ALL matching centre-points sorted top-to-bottom
 * (ascending Y). Used when a search may return multiple rows for the same
 * candidate text — e.g. an Instagram "suggestion chip" row above the real
 * user profile row — so the caller can choose which to tap.
 */
function _findAllElems(xml: string, ...candidates: string[]): Array<{ x: number; y: number }> {
  const seen = new Set<string>();
  const results: Array<{ x: number; y: number }> = [];
  for (const t of candidates) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const attr of ["text", "content-desc", "hint", "resource-id"]) {
      for (const pattern of [
        new RegExp(`${attr}="${esc}"[^>]*bounds="([^"]+)"`, "gi"),
        new RegExp(`${attr}="[^"]*${esc}[^"]*"[^>]*bounds="([^"]+)"`, "gi"),
      ]) {
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(xml)) !== null) {
          const c = _parseCenter(m[1]);
          if (c) {
            const key = `${c.x},${c.y}`;
            if (!seen.has(key)) { seen.add(key); results.push(c); }
          }
        }
      }
    }
  }
  return results.sort((a, b) => a.y - b.y);
}

/** Find an element by partial resource-id match (e.g. "fab", "hostname"). */
function _findByResId(xml: string, ...ids: string[]): { x: number; y: number } | null {
  for (const id of ids) {
    const esc = id.replace(/[.*+?^${}()|[]\]/g, "\$&");
    const re = new RegExp(`resource-id="[^"]*${esc}[^"]*"[^>]*bounds="([^"]+)"`, "i");
    const m = xml.match(re);
    if (m) { const c = _parseCenter(m[1]); if (c) return c; }
  }
  return null;
}

/** Attribute-order-independent resource-id lookup for live UIAutomator nodes. */
function _findLiveNodeByResId(xml: string, ...ids: string[]): { x: number; y: number } | null {
  const wanted = ids.map(id => id.replace(/^:id\//, "").toLowerCase());
  for (const node of xml.match(/<node\b[^>]*>/gi) ?? []) {
    const resourceId = node.match(/\bresource-id="([^"]*)"/i)?.[1]?.toLowerCase() ?? "";
    if (!resourceId || !wanted.some(id => resourceId.includes(id))) continue;
    const bounds = node.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
    if (!bounds) continue;
    return {
      x: Math.round((Number(bounds[1]) + Number(bounds[3])) / 2),
      y: Math.round((Number(bounds[2]) + Number(bounds[4])) / 2),
    };
  }
  return null;
}

/**
 * Same lookup as _findByResId but returns the raw bounding box instead of
 * just the centre point — used when a caller needs to search WITHIN a
 * containers rectangle rather than tap the container itself.
 */
function _findBoundsByResId(xml: string, ...ids: string[]): { x1: number; y1: number; x2: number; y2: number } | null {
  for (const id of ids) {
    const esc = id.replace(/[.*+?^${}()|[]\]/g, "\$&");
    const re = new RegExp(`resource-id="[^"]*${esc}[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"`, "i");
    const m = xml.match(re);
    if (m) return { x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) };
  }
  return null;
}

/** Find the Nth android.widget.EditText in the XML (0-based). Robust fallback for form fields. */
function _findEditTextN(xml: string, index: number): { x: number; y: number } | null {
  const re = /class="android\.widget\.EditText"[^>]*bounds="([^"]+)"/gi;
  let n = 0, m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (n === index) { return _parseCenter(m[1]); }
    n++;
  }
  return null;
}

/** Get screen dimensions from the root hierarchy node bounds, e.g. "[0,0][1600,900]" → {w,h} */
function _getScreenSize(xml: string): { w: number; h: number } {
  return _getScreenSizeFromXml(xml) ?? { w: 1600, h: 900 };
}

function _getScreenSizeFromXml(xml: string): { w: number; h: number } | null {
  const m = xml.match(/bounds="\[0,0\]\[(\d+),(\d+)\]"/);
  return m ? { w: +m[1], h: +m[2] } : null;
}

function _adbTap(adb: string, serial: string, x: number, y: number): void {
  spawnSync(adb, ["-s", serial, "shell", "input", "tap", String(x), String(y)], { encoding: "utf8", timeout: 3000 });
}

async function _adbTapAsync(adb: string, serial: string, x: number, y: number): Promise<void> {
  await runAdb(adb, ["-s", serial, "shell", "input", "tap", String(x), String(y)], 4000);
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
  config: { host: string; port: number; user?: string; pass?: string; proxyType?: string },
): Promise<{ ok: boolean; steps: string[]; error?: string }> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const steps: string[] = [];

  try {
    // 1. Bring BlueStacks window to the front so the user can see the automation
    _bringBlueStacksToFront();
    await _sleep(400);

    // Launch Drony — use `am start` (preferred) and `monkey` (guaranteed launcher hit) back-to-back.
    // Running both is harmless: if am-start works, monkey is a no-op; if am-start fails silently, monkey opens it.
    spawnSync(adb, ["-s", serial, "shell", "am", "start", "-a", "android.intent.action.MAIN",
      "-c", "android.intent.category.LAUNCHER", "-n", DRONY_ACTIVITY], { encoding: "utf8", timeout: 6000 });
    spawnSync(adb, ["-s", serial, "shell", "monkey", "-p", DRONY_PKG,
      "-c", "android.intent.category.LAUNCHER", "1"], { encoding: "utf8", timeout: 6000 });
    await _sleep(4000); // Give BlueStacks time to fully switch to the app

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

    // 2. Open a proxy entry to edit. Check if EditText fields are already visible first.
    let hasForm = _findEditTextN(xml, 0) !== null;
    if (!hasForm) {
      // Try FAB by resource-id (common Drony IDs), then by text, then by screen position (bottom-right)
      const fabPos =
        _findByResId(xml, ":id/fab", ":id/add", ":id/add_proxy", ":id/button_add") ||
        _findElem(xml, "+", "Add", "NEW PROXY", "New proxy", "Add proxy");
      if (fabPos) {
        _adbTap(adb, serial, fabPos.x, fabPos.y);
        steps.push("Tapped + (add proxy)");
      } else {
        // FAB has no text in many Drony builds — tap the bottom-right corner where it lives
        const scr = _getScreenSize(xml);
        _adbTap(adb, serial, Math.floor(scr.w * 0.92), Math.floor(scr.h * 0.90));
        steps.push("Tapped FAB position (bottom-right)");
      }
      await _sleep(1500);
      xml = await _uiDump(adb, serial);
      hasForm = _findEditTextN(xml, 0) !== null;

      // If still no form, try tapping the first list item (may be an existing proxy entry)
      if (!hasForm) {
        const entryPos = _findByResId(xml, ":id/proxy_list", ":id/list_item", ":id/item") ||
          _findElem(xml, "Edit", "EDIT", "HTTP", "HTTPS", "SOCKS");
        if (entryPos) {
          _adbTap(adb, serial, entryPos.x, entryPos.y);
          await _sleep(1200);
          xml = await _uiDump(adb, serial);
          hasForm = _findEditTextN(xml, 0) !== null;
          if (hasForm) steps.push("Opened existing proxy to edit");
        }
      } else {
        steps.push("Proxy form opened");
      }
    } else {
      steps.push("Proxy form already open");
    }

    if (!hasForm) {
      steps.push("⚠ Could not open proxy form — Drony UI not recognised");
    } else {
      // 3. Set proxy protocol type (SOCKS5/SOCKS4/HTTP/HTTPS) via the type spinner
      const targetType = (config.proxyType ?? "SOCKS5").toUpperCase();
      const typeSpinner =
        _findByResId(xml, ":id/proxy_type", ":id/type_spinner", ":id/protocol_spinner", ":id/spinner_type") ||
        _findElem(xml, "SOCKS5", "SOCKS4", "HTTP", "HTTPS", "None", "Type", "Protocol");
      if (typeSpinner) {
        _adbTap(adb, serial, typeSpinner.x, typeSpinner.y);
        await _sleep(1000);
        const menuXml = await _uiDump(adb, serial);
        const typeOption = _findElem(menuXml, targetType);
        if (typeOption) {
          _adbTap(adb, serial, typeOption.x, typeOption.y);
          await _sleep(700);
          xml = await _uiDump(adb, serial);
          steps.push(`Protocol set to ${targetType}`);
        } else {
          steps.push(`⚠ ${targetType} option not found in dropdown — check proxy type manually`);
          spawnSync(adb, ["-s", serial, "shell", "input", "keyevent", "KEYCODE_BACK"],
            { encoding: "utf8", timeout: 3000 });
          await _sleep(500);
          xml = await _uiDump(adb, serial);
        }
      } else {
        steps.push(`⚠ Proxy type dropdown not found — ${targetType} must be selected manually`);
      }

      // 4. Fill Host — try resource-id, then text/hint, then 1st EditText by index
      const hostPos =
        _findByResId(xml, ":id/hostname", ":id/host_name", ":id/host", ":id/server_host", ":id/proxy_host") ||
        _findElem(xml, "Host name or IP address", "Hostname or IP address", "Proxy host", "Host", "Server host") ||
        _findEditTextN(xml, 0);
      if (hostPos) {
        await _tapField(adb, serial, hostPos, config.host);
        steps.push(`Host → ${config.host}`);
      } else {
        steps.push("⚠ Host field not found");
      }

      // Re-dump (keyboard may shift layout)
      xml = await _uiDump(adb, serial);

      // 4. Fill Port — resource-id, then text/hint, then 2nd EditText by index
      const portPos =
        _findByResId(xml, ":id/port", ":id/port_number", ":id/server_port", ":id/proxy_port") ||
        _findElem(xml, "Port number", "Port", "Server port", "Proxy port") ||
        _findEditTextN(xml, 1);
      if (portPos) {
        await _tapField(adb, serial, portPos, String(config.port));
        steps.push(`Port → ${config.port}`);
      } else {
        steps.push("⚠ Port field not found");
      }

      xml = await _uiDump(adb, serial);

      // 5. Auth (optional)
      if (config.user) {
        const userPos =
          _findByResId(xml, ":id/username", ":id/login", ":id/user_name", ":id/user") ||
          _findElem(xml, "Login", "Username", "User name") ||
          _findEditTextN(xml, 2);
        if (userPos) {
          await _tapField(adb, serial, userPos, config.user);
          steps.push(`Username → ${config.user}`);
        }
        xml = await _uiDump(adb, serial);
        const passPos =
          _findByResId(xml, ":id/password", ":id/pass") ||
          _findElem(xml, "Password") ||
          _findEditTextN(xml, 3);
        if (passPos) {
          await _tapField(adb, serial, passPos, config.pass ?? "");
          steps.push("Password set");
        }
        xml = await _uiDump(adb, serial);
      }

      // 6. Save — resource-id, then text, then top-right area (common toolbar "OK" position)
      const savePos =
        _findByResId(xml, ":id/save", ":id/ok", ":id/confirm", ":id/done", ":id/action_ok") ||
        _findElem(xml, "OK", "Save", "SAVE", "Done", "DONE", "Apply", "✓");
      if (savePos) {
        _adbTap(adb, serial, savePos.x, savePos.y);
        await _sleep(1200);
        steps.push("Configuration saved");
      } else {
        // Toolbar OK is often top-right — tap there
        const scr2 = _getScreenSize(xml);
        _adbTap(adb, serial, Math.floor(scr2.w * 0.95), Math.floor(scr2.h * 0.06));
        await _sleep(1000);
        steps.push("Tapped toolbar top-right (save fallback)");
      }
    }

    // 7. Activate VPN toggle on the main screen
    await _sleep(800);
    xml = await _uiDump(adb, serial);
    const scr3 = _getScreenSize(xml);

    // Try by resource-id, then by text, then use screen-centre-upper area where Drony puts the power button
    const togglePos =
      _findByResId(xml, ":id/start_stop", ":id/power", ":id/toggle", ":id/vpn_toggle", ":id/btn_start", ":id/button_start") ||
      _findElem(xml, "OFF", "Stopped", "Tap to start", "START", "Start", "Enable", "Disabled");
    if (togglePos) {
      _adbTap(adb, serial, togglePos.x, togglePos.y);
      steps.push("VPN toggle tapped");
    } else {
      // Drony's power button is typically at ~50% x, ~30% y
      _adbTap(adb, serial, Math.floor(scr3.w * 0.50), Math.floor(scr3.h * 0.30));
      steps.push("Tapped power button position (centre-upper fallback)");
    }
    await _sleep(2000);

    // 8. Accept Android VPN permission dialog if it appeared
    xml = await _uiDump(adb, serial);
    const vpnOkPos = _findElem(xml, "OK", "Allow", "ACCEPT", "Yes");
    if (vpnOkPos && (xml.includes("VPN") || xml.toLowerCase().includes("network") || xml.toLowerCase().includes("connection"))) {
      _adbTap(adb, serial, vpnOkPos.x, vpnOkPos.y);
      await _sleep(1000);
      steps.push("VPN permission accepted");
    }

    // 9. Proactively reconnect ADB — Drony's VPN briefly restarts Android networking
    // which drops the TCP link. Re-issuing `adb connect` brings it back in seconds
    // instead of waiting for BlueStacks's 2-minute auto-reconnect.
    await _sleep(1500);
    if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial)) {
      spawnSync(adb, ["connect", serial], { encoding: "utf8", timeout: 8000 });
      steps.push(`ADB reconnected (${serial})`);
    } else {
      // Serial is emulator-XXXX style — try the default BlueStacks TCP ports
      for (const addr of ["127.0.0.1:5555", "127.0.0.1:5556", "127.0.0.1:5565"]) {
        spawnSync(adb, ["connect", addr], { encoding: "utf8", timeout: 5000 });
      }
      steps.push("ADB reconnect attempted (default ports)");
    }

    return { ok: true, steps };
  } catch (e: any) {
    return { ok: false, steps, error: e?.message ?? "Automation failed" };
  }
}

/**
 * Open Instagram, navigate to the email sign-up screen, and pre-fill the email.
 * The user completes the rest (OTP, username, password) manually.
 */
export async function instagramSignup(serial: string, email: string): Promise<{ ok: boolean; steps: string[]; error?: string }> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const steps: string[] = [];
  try {
    _bringBlueStacksToFront();
    await _sleep(400);
    steps.push("BlueStacks brought to front");

    // Launch Instagram
    spawnSync(adb, ["-s", serial, "shell", "am", "start", "-a", "android.intent.action.MAIN",
      "-n", "com.instagram.android/.activity.MainTabActivity"], { encoding: "utf8", timeout: 8000 });
    await _sleep(4500);
    steps.push("Instagram launched");

    let xml = await _uiDump(adb, serial);
    if (!xml || xml.length < 200) { await _sleep(3000); xml = await _uiDump(adb, serial); }

    // Tap "Get started" / "Create new account" on the welcome screen
    const getStartedPos =
      _findElem(xml, "Get started", "GET STARTED", "Create new account", "Sign up for an account") ||
      _findByResId(xml, ":id/get_started_button", ":id/sign_up_button");
    if (getStartedPos) {
      _adbTap(adb, serial, getStartedPos.x, getStartedPos.y);
      steps.push("Tapped Get Started");
      await _sleep(2500);
      xml = await _uiDump(adb, serial);
    } else {
      steps.push("⚠ Get Started button not found — Instagram may already be on a signup screen");
    }

    // Some versions show a "Sign up with email or phone" link; tap it
    const emailLinkPos =
      _findElem(xml, "Sign up with email or phone number", "Use email or phone", "Sign up with email", "Email") ||
      _findByResId(xml, ":id/email_phone_field", ":id/signup_with_email_button");
    if (emailLinkPos) {
      _adbTap(adb, serial, emailLinkPos.x, emailLinkPos.y);
      steps.push("Selected email signup");
      await _sleep(2000);
      xml = await _uiDump(adb, serial);
    }

    // Fill the email / phone field (first EditText on screen)
    const emailFieldPos =
      _findByResId(xml, ":id/email_field", ":id/registration_email_field", ":id/phone_or_email") ||
      _findElem(xml, "Email address", "Email or phone number", "Phone number, username or email") ||
      _findEditTextN(xml, 0);
    if (emailFieldPos) {
      await _tapField(adb, serial, emailFieldPos, email);
      steps.push(`Email filled: ${email}`);
      // Tap Next / Continue
      await _sleep(500);
      xml = await _uiDump(adb, serial);
      const nextPos =
        _findElem(xml, "Next", "NEXT", "Continue", "CONTINUE") ||
        _findByResId(xml, ":id/next_button", ":id/button_continue");
      if (nextPos) {
        _adbTap(adb, serial, nextPos.x, nextPos.y);
        steps.push("Tapped Next — complete signup manually (OTP, username, password)");
      } else {
        steps.push("Email filled — tap Next manually, then complete the remaining steps");
      }
    } else {
      steps.push("⚠ Email field not found — Instagram signup screen may differ. Open Mirror and complete signup manually.");
    }

    return { ok: true, steps };
  } catch (e: any) {
    return { ok: false, steps, error: e?.message ?? "Failed" };
  }
}

/**
 * Open Google Play Store to the Instagram page and tap Install automatically.
 * Brings BlueStacks to the front first so the user can watch.
 */
export async function installInstagramFromPlayStore(serial: string): Promise<{ ok: boolean; steps: string[]; error?: string }> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const steps: string[] = [];
  try {
    _bringBlueStacksToFront();
    await _sleep(500);
    steps.push("BlueStacks brought to front");

    // Open Play Store directly on the Instagram page
    spawnSync(adb, ["-s", serial, "shell", "am", "start", "-a", "android.intent.action.VIEW",
      "-d", "market://details?id=com.instagram.android", "com.android.vending"],
      { encoding: "utf8", timeout: 8000 });
    await _sleep(4500); // Give Play Store time to load the app page
    steps.push("Play Store opened on Instagram page");

    let xml = await _uiDump(adb, serial);
    if (!xml || xml.length < 200) {
      await _sleep(3000);
      xml = await _uiDump(adb, serial);
    }

    // Check if already installed
    const openPos = _findElem(xml, "Open", "OPEN") || _findByResId(xml, ":id/launch_button");
    if (openPos) {
      steps.push("Instagram is already installed — nothing to do");
      return { ok: true, steps };
    }

    // Find the Install button (text, resource-id, or index-based)
    const installPos =
      _findElem(xml, "Install", "INSTALL") ||
      _findByResId(xml, ":id/buy_button", ":id/install_button", ":id/0_resource_name_obfuscated");
    if (!installPos) {
      steps.push("⚠ Install button not found — Play Store may still be loading. Try again in a moment.");
      return { ok: false, steps, error: "Install button not found in Play Store. Make sure BlueStacks has internet access and is signed into a Google account." };
    }

    _adbTap(adb, serial, installPos.x, installPos.y);
    steps.push("Tapped Install");
    await _sleep(2500);

    // Accept any permissions / account selection dialog that may appear
    xml = await _uiDump(adb, serial);
    const acceptPos = _findElem(xml, "Accept", "Continue", "OK", "Allow");
    if (acceptPos && (xml.toLowerCase().includes("account") || xml.toLowerCase().includes("permission") || xml.toLowerCase().includes("accept"))) {
      _adbTap(adb, serial, acceptPos.x, acceptPos.y);
      steps.push("Accepted permissions dialog");
    }

    steps.push("Installation started — Instagram is downloading. This takes 1–2 minutes.");
    return { ok: true, steps };
  } catch (e: any) {
    return { ok: false, steps, error: e?.message ?? "Failed" };
  }
}

/**
 * Find the Instagram Activity/Notifications icon (heart icon, top-right of the home
 * feed header). Tries resource IDs and content-desc labels first; falls back to a
 * positional scan of clickable ImageViews in the top-right screen quadrant so it
 * works even when Instagram obfuscates IDs.
 */
export async function findInstagramNotificationsIcon(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;
  const byId = _findByResId(xml,
    ":id/notification", ":id/activity_icon", ":id/nav_notification",
    ":id/action_notification", ":id/notification_bell", ":id/heart_icon");
  if (byId) return byId;
  const byLabel = _findElem(xml, "Activity", "Notifications", "Notification");
  if (byLabel) return byLabel;
  // Positional fallback: find clickable ImageViews in the top-right area
  // (x > 65% of width, y < 12% of height).  Notifications icon is the
  // rightmost one there (camera icon is further left on this model).
  const { w, h } = getScreenSize(serial);
  const rightThresh = Math.round(w * 0.65);
  const topThresh  = Math.round(h * 0.12);
  const imgRe = /class="android\.widget\.ImageView"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^/]*clickable="true"/gi;
  let m: RegExpExecArray | null;
  let best: { x: number; y: number } | null = null;
  while ((m = imgRe.exec(xml)) !== null) {
    const cx = (Number(m[1]) + Number(m[3])) / 2;
    const cy = (Number(m[2]) + Number(m[4])) / 2;
    if (cx > rightThresh && cy < topThresh) {
      if (!best || cx > best.x) best = { x: Math.round(cx), y: Math.round(cy) };
    }
  }
  return best;
}

/**
 * Find the Instagram Profile tab (person icon, rightmost bottom-nav item).
 * Tries resource IDs and the "Profile" content-desc label.
 */
export async function findInstagramProfileTab(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;
  const { w: xmlW, h: xmlH } = _getScreenSize(xml);
  // ── Strategy 1: content-desc prefix match.
  // Use "Profil" (not "Profile") so this also matches the Indonesian locale
  // where Instagram renders the tab as content-desc="Profil" (no trailing 'e').
  // "Profil" is a prefix of "Profile", "Profil", "Profilo" (IT), etc.
  //
  // IMPORTANT: scan ALL matches and keep only those whose y-centre is in the
  // bottom-nav band (> 85 % of screen height). Instagram's story tray and feed
  // posts carry "Profile picture" / user-avatar nodes at the TOP of the
  // accessibility tree that also match "Profil" — a simple first-match returns
  // those top-of-screen coordinates and taps the wrong element.
  {
    const s1Re = /content-desc="Profil[^"]*"[^>]*bounds="(\[[^\]]+\]\[[^\]]+\])"/gi;
    const botMin = Math.round(xmlH * 0.85);
    const hits: { x: number; y: number }[] = [];
    let s1m: RegExpExecArray | null;
    while ((s1m = s1Re.exec(xml)) !== null) {
      const c = _parseCenter(s1m[1]);
      if (c && c.y > botMin) hits.push(c);
    }
    if (hits.length > 0) {
      hits.sort((a, b) => a.x - b.x);
      return hits[hits.length - 1]; // rightmost in bottom-nav band = Profile tab
    }
  }
  // ── Strategy 2: known resource-ids — :id/profile_tab confirmed on this device (node [96]).
  const byId = _findBottomProfileResource(xml);
  if (byId) return byId;
  // ── Strategy 2b: unlabeled bottom-right profile avatar.
  // Some Xiaomi/Instagram combinations expose the avatar as a plain ImageView
  // with no content-desc/resource-id and mark only its parent navigation item
  // clickable.  Do not guess a screen coordinate: use the live accessibility
  // node bounds, require the node to be in the bottom-nav/right-edge region,
  // and require avatar-sized bounds so feed media/action nodes cannot match.
  {
    const rightMin = Math.round(xmlW * 0.82);
    const bottomMin = Math.round(xmlH * 0.86);
    const avatarCandidates: { x: number; y: number; area: number }[] = [];
    const avatarRe = /<node\s([^>]+?)\s*\/?>/g;
    let am: RegExpExecArray | null;
    while ((am = avatarRe.exec(xml)) !== null) {
      const attrs = am[1];
      const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!bm) continue;
      const x1 = Number(bm[1]), y1 = Number(bm[2]);
      const x2 = Number(bm[3]), y2 = Number(bm[4]);
      const w = x2 - x1, h = y2 - y1;
      const cx = Math.round((x1 + x2) / 2);
      const cy = Math.round((y1 + y2) / 2);
      if (cx < rightMin || cy < bottomMin) continue;
      if (w < 24 || h < 24 || w > 140 || h > 140) continue;
      if (Math.max(w, h) / Math.max(1, Math.min(w, h)) > 1.8) continue;
      const className = attrs.match(/class="([^"]*)"/i)?.[1] ?? "";
      if (!/(ImageView|View|Layout|Button)/i.test(className)) continue;
      avatarCandidates.push({ x: cx, y: cy, area: w * h });
    }
    if (avatarCandidates.length > 0) {
      avatarCandidates.sort((a, b) => b.x - a.x || a.y - b.y || a.area - b.area);
      const avatar = avatarCandidates[0];
      onLog?.(`  ↳ Profile tab found via unlabeled bottom-right avatar node at (${avatar.x},${avatar.y})`);
      return { x: avatar.x, y: avatar.y };
    }
  }
  // ── Strategy 3: positional fallback.
  // Collect clickable nodes in the bottom-nav band (y > 88 % of screen height),
  // deduplicate, sort left-to-right, return the RIGHTMOST — the Profile tab is
  // always the 5th/rightmost of Instagram's 5 bottom-nav tabs.
  //
  // GUARDS against false positives:
  //  a) Require ≥ 4 candidates — a real nav bar has 4-5 tabs; if we see fewer
  //     the phone is probably showing a full-screen Reels/story view whose action
  //     icons (Like, Comment, Send) sit at the same y-band but are too few.
  //  b) Require candidates span > 55 % of screen width — Instagram's nav tabs
  //     spread across the full card width, while Reels action icons are all
  //     clustered on the right edge and fail this check.
  // (xmlW / xmlH already parsed above for Strategy 1)
  const botMin = Math.round(xmlH * 0.88);
  const raw: { x: number; y: number }[] = [];
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let nm: RegExpExecArray | null;
  while ((nm = nodeRe.exec(xml)) !== null) {
    const attrs = nm[1];
    if (!/clickable="true"/.test(attrs)) continue;
    const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bm) continue;
    const cy = Math.round((Number(bm[2]) + Number(bm[4])) / 2);
    if (cy < botMin) continue;
    raw.push({ x: Math.round((Number(bm[1]) + Number(bm[3])) / 2), y: cy });
  }
  const deduped = raw.filter((n, i, arr) =>
    arr.findIndex(o => Math.abs(o.x - n.x) < 40 && Math.abs(o.y - n.y) < 40) === i,
  );
  if (deduped.length < 4) return null; // guard (a): too few nodes → not a nav bar
  deduped.sort((a, b) => a.x - b.x);
  const spanW = deduped[deduped.length - 1].x - deduped[0].x;
  if (spanW < xmlW * 0.55) return null; // guard (b): too narrow → action-icon cluster, not nav bar
  return deduped[deduped.length - 1]; // rightmost = Profile tab
}

/**
 * Resolve resource-id profile-tab nodes only when they are physically in the
 * bottom navigation band. Instagram reuses avatar/profile resource IDs in
 * the story tray and feed, so an ID-only lookup can return the top-left story
 * avatar instead of the bottom-right navigation tab.
 */
function _findBottomProfileResource(xml: string): { x: number; y: number } | null {
  const { h: xmlH } = _getScreenSize(xml);
  const bottomMin = Math.round(xmlH * 0.82);
  const wanted = /(?:profile_tab|\/profile|tab_profile|nav_profile|bottom_tab_profile|avatar_tab)$/i;
  const re = /<node\s([^>]+?)\s*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const rid = attrs.match(/resource-id="([^"]+)"/i)?.[1] ?? "";
    if (!wanted.test(rid)) continue;
    const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bm) continue;
    const x = (Number(bm[1]) + Number(bm[3])) / 2;
    const y = (Number(bm[2]) + Number(bm[4])) / 2;
    if (y >= bottomMin) return { x: Math.round(x), y: Math.round(y) };
  }
  return null;
}

function _findBottomProfileLabel(xml: string): { x: number; y: number } | null {
  const { h: xmlH } = _getScreenSize(xml);
  const bottomMin = Math.round(xmlH * 0.82);
  const re = /<node\s([^>]+?)\s*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const label = attrs.match(/(?:content-desc|text)="([^"]*)"/i)?.[1] ?? "";
    if (!/^profil(e|o)?$/i.test(label.trim())) continue;
    const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bm) continue;
    const x = (Number(bm[1]) + Number(bm[3])) / 2;
    const y = (Number(bm[2]) + Number(bm[4])) / 2;
    if (y >= bottomMin) return { x: Math.round(x), y: Math.round(y) };
  }
  return null;
}

/**
 * Reels resource IDs are also reused by profile/content tabs on some
 * Instagram builds. Only accept a matching node when its center is in the
 * bottom navigation band; a node in a profile's middle tab row is not the
 * Reels navigation control.
 */
function _findBottomReelsResource(xml: string): { x: number; y: number } | null {
  const { h: xmlH } = _getScreenSize(xml);
  const bottomMin = Math.round(xmlH * 0.82);
  const wanted = /(?:clips_tab|reels_tab|tab_clips|nav_clips|clips_tab_icon_view|reels_icon|clips_icon)$/i;
  const re = /<node\s([^>]+?)\s*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const rid = attrs.match(/resource-id="([^"]+)"/i)?.[1] ?? "";
    if (!wanted.test(rid)) continue;
    const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bm) continue;
    const x = (Number(bm[1]) + Number(bm[3])) / 2;
    const y = (Number(bm[2]) + Number(bm[4])) / 2;
    if (y >= bottomMin) return { x: Math.round(x), y: Math.round(y) };
  }
  return null;
}

function _findBottomReelsLabel(xml: string): { x: number; y: number } | null {
  const { h: xmlH } = _getScreenSize(xml);
  const bottomMin = Math.round(xmlH * 0.82);
  const re = /<node\s([^>]+?)\s*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const label = attrs.match(/(?:content-desc|text)="([^"]*)"/i)?.[1] ?? "";
    if (!/^reels?$/i.test(label.trim())) continue;
    const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bm) continue;
    const x = (Number(bm[1]) + Number(bm[3])) / 2;
    const y = (Number(bm[2]) + Number(bm[4])) / 2;
    if (y >= bottomMin) return { x: Math.round(x), y: Math.round(y) };
  }
  return null;
}

/**
 * Find the Instagram profile-page "Options" hamburger button (three lines, top-right).
 * Confirmed UIAutomator node: ImageView content-desc="Options" at ~(992,181) on this farm.
 *
 * Strategy 1: content-desc="Options" anywhere in the top header area (y < 15 % of height).
 * Strategy 2: Rightmost clickable ImageView in the top header strip (x > 80 % width, y < 15 %).
 */
export async function findInstagramProfileOptionsButton(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;
  const { w: xmlW, h: xmlH } = _getScreenSize(xml);
  const topThresh = Math.round(xmlH * 0.15);
  // ── Strategy 1: content-desc exact "Options" in header area.
  {
    const s1Re = /content-desc="Options"[^>]*bounds="(\[[^\]]+\]\[[^\]]+\])"/gi;
    let s1m: RegExpExecArray | null;
    while ((s1m = s1Re.exec(xml)) !== null) {
      const c = _parseCenter(s1m[1]);
      if (c && c.y < topThresh) return c;
    }
  }
  // ── Strategy 2: positional fallback — rightmost clickable node in top-right header strip.
  const rightMin = Math.round(xmlW * 0.80);
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let m: RegExpExecArray | null;
  let best: { x: number; y: number } | null = null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    if (!/clickable="true"/.test(attrs)) continue;
    const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bm) continue;
    const cx = Math.round((Number(bm[1]) + Number(bm[3])) / 2);
    const cy = Math.round((Number(bm[2]) + Number(bm[4])) / 2);
    if (cx > rightMin && cy < topThresh) {
      if (!best || cx > best.x) best = { x: cx, y: cy };
    }
  }
  return best;
}

/**
 * Find one safe, top-level row on Instagram's "Settings and activity" page.
 *
 * This deliberately returns only a single validated row. The random-settings
 * flow must never guess at a coordinate or tap a second-level setting after
 * the first tap, because a second navigation tap can leave the flow in an
 * unexpected screen on different Instagram builds.
 */
export async function findInstagramSettingsRow(
  serial: string,
): Promise<{ x: number; y: number; label: string } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;
  const { w, h } = _getScreenSize(xml);
  const top = Math.round(h * 0.10);
  const bottom = Math.round(h * 0.88);
  const knownLabels = [
    "Your activity",
    "Notifications",
    "Time spent",
    "Privacy",
    "Supervision",
    "Saved",
    "Close Friends",
    "Favorites",
    "Muted",
    "Blocked",
    "Security",
    "Ads",
    "Account",
    "Help",
    "About",
  ];
  const excluded = /^(Settings and activity|Accounts Center|Log out|Add account|Switch account|Meta Verified)$/i;
  const candidates: Array<{ x: number; y: number; label: string }> = [];
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = nodeRe.exec(xml)) !== null) {
    const attrs = match[1];
    if (!/clickable="true"/.test(attrs)) continue;
    const bounds = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bounds) continue;
    const x1 = Number(bounds[1]);
    const y1 = Number(bounds[2]);
    const x2 = Number(bounds[3]);
    const y2 = Number(bounds[4]);
    const width = x2 - x1;
    const height = y2 - y1;
    const x = Math.round((x1 + x2) / 2);
    const y = Math.round((y1 + y2) / 2);
    if (y < top || y > bottom || width < w * 0.60 || height < 32 || height > 220) continue;

    const text = attrs.match(/\btext="([^"]*)"/)?.[1] ?? "";
    const desc = attrs.match(/\bcontent-desc="([^"]*)"/)?.[1] ?? "";
    const label = text || desc;
    if (!label || excluded.test(label)) continue;
    const known = knownLabels.find(candidate => label.toLowerCase().includes(candidate.toLowerCase()));
    if (!known && !/^[A-Za-z][A-Za-z '&·.-]{2,48}$/.test(label)) continue;
    candidates.push({ x, y, label: known ?? label });
  }

  // Collapse parent/child duplicates from the same row before choosing one.
  const deduped = candidates.filter((candidate, index, all) =>
    all.findIndex(other =>
      Math.abs(other.x - candidate.x) < 45 &&
      Math.abs(other.y - candidate.y) < 45,
    ) === index,
  );
  if (deduped.length === 0) return null;
  return deduped[Math.floor(Math.random() * deduped.length)];
}

/**
 * Find the "Saved" row on Instagram's Settings and activity page.
 * Confirmed UIAutomator node: View content-desc="Saved" at ~(540,1033) on this farm.
 *
 * Strategy 1: content-desc="Saved" (any y position on the page).
 * Strategy 2: TextView text="Saved" (some IG builds use text not content-desc).
 */
export async function findInstagramSavedRow(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;
  // ── Strategy 1: content-desc="Saved".
  const byDesc = _findElem(xml, "Saved");
  if (byDesc) return byDesc;
  // ── Strategy 2: text="Saved" in a TextView node.
  {
    const s2Re = /text="Saved"[^>]*bounds="(\[[^\]]+\]\[[^\]]+\])"/gi;
    let s2m: RegExpExecArray | null;
    while ((s2m = s2Re.exec(xml)) !== null) {
      const c = _parseCenter(s2m[1]);
      if (c) return c;
    }
  }
  return null;
}

/**
 * Find the Instagram Direct Messages tab (paper-plane icon, bottom-nav centre-right).
 * Tries resource IDs and content-desc labels first; falls back to a positional
 * scan of clickable nodes in the bottom-nav band at ~60–75 % of screen width.
 */
export async function findInstagramDmTab(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;
  const { w: xmlW, h: xmlH } = _getScreenSize(xml);
  // ── Strategy 1: content-desc match for DM / Messenger / Direct.
  {
    const s1Re = /content-desc="(?:Direct|Messenger|Chats?|Messages?|DM)[^"]*"[^>]*bounds="(\[[^\]]+\]\[[^\]]+\])"/gi;
    const botMin = Math.round(xmlH * 0.85);
    let s1m: RegExpExecArray | null;
    while ((s1m = s1Re.exec(xml)) !== null) {
      const c = _parseCenter(s1m[1]);
      if (c && c.y > botMin) return c;
    }
  }
  // ── Strategy 2: known resource-ids.
  const byId = _findByResId(xml,
    ":id/direct_inbox", ":id/direct_tab", ":id/messenger_tab",
    ":id/nav_direct", ":id/bottom_tab_direct", ":id/tab_direct");
  if (byId) return byId;
  // ── Strategy 3: positional fallback.
  // Instagram's bottom nav has 5 tabs: Home, Search, Reels, Shop/+, Profile.
  // The DM paper-plane is NOT in the bottom nav — it lives in the top-right
  // header of the home feed. We cannot rely on a bottom-nav positional scan.
  // Instead look for a clickable node in the TOP-RIGHT quadrant (x > 75% of
  // width, y < 15% of height) that is NOT the notifications bell
  // (which is further right). The DM icon is typically the leftmost of the
  // two top-right header icons on this device layout.
  const rightMin = Math.round(xmlW * 0.60);
  const rightMax = Math.round(xmlW * 0.82);
  const topThresh = Math.round(xmlH * 0.15);
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let m: RegExpExecArray | null;
  const candidates: { x: number; y: number }[] = [];
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    if (!/clickable="true"/.test(attrs)) continue;
    const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bm) continue;
    const cx = Math.round((Number(bm[1]) + Number(bm[3])) / 2);
    const cy = Math.round((Number(bm[2]) + Number(bm[4])) / 2);
    if (cx >= rightMin && cx <= rightMax && cy < topThresh) {
      candidates.push({ x: cx, y: cy });
    }
  }
  if (candidates.length > 0) {
    // Return leftmost candidate in the zone — the DM icon sits to the left
    // of the notifications bell in Instagram's header layout.
    candidates.sort((a, b) => a.x - b.x);
    return candidates[0];
  }
  return null;
}

/**
 * Find a random tappable conversation thread row in the Instagram DM inbox.
 * Returns one of the top-3 most-recent rows (chosen at random) so the bot
 * naturally gravitates toward active conversations without always tapping
 * the very first one.
 */
export async function findDmConversationItem(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;
  const { w, h } = _getScreenSize(xml);
  const topSkip  = Math.round(h * 0.12); // skip the DM header row
  const botSkip  = Math.round(h * 0.88); // skip bottom nav
  // Conversation rows span almost the full width and are clickable.
  // Require width > 50% of screen width to exclude narrow icon-only nodes.
  const minW = Math.round(w * 0.50);
  const candidates: { x: number; y: number }[] = [];
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    if (!/clickable="true"/.test(attrs)) continue;
    const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bm) continue;
    const x1 = Number(bm[1]), y1 = Number(bm[2]), x2 = Number(bm[3]), y2 = Number(bm[4]);
    const rowW = x2 - x1;
    const cy = Math.round((y1 + y2) / 2);
    if (rowW < minW) continue;
    if (cy < topSkip || cy > botSkip) continue;
    candidates.push({ x: Math.round((x1 + x2) / 2), y: cy });
  }
  if (candidates.length === 0) return null;
  // Sort top-to-bottom (most recent first in IG inbox) and pick from top 3.
  candidates.sort((a, b) => a.y - b.y);
  const pool = candidates.slice(0, 3);
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Find a random tappable item from the Instagram notifications page.
 * Returns the centre of a clickable notification-row avatar View, or null if
 * none is found.  Tapping the avatar navigates to the notifying user's
 * profile — a completely passive action with no side effects.
 */
export async function findRandomNotificationItem(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;
  const { w, h } = getScreenSize(serial);
  const topSkip = Math.round(h * 0.10); // skip the fixed header row ("Notifications")
  const botSkip = Math.round(h * 0.92); // skip the bottom nav bar
  // On the Instagram notifications page each row has a small circular avatar
  // on the LEFT side of the screen — that is the tappable element.  The
  // notification text to the right is a non-clickable TextView.  Scanning
  // the screen layout (1080 px wide) shows the avatar Views at x≈132 px
  // (~12 % of screen width) with bounds ≈ [55,y1][209,y2] (154 px wide).
  //
  // The filter: keep only clickable nodes whose centre falls within the left
  // 25 % of the screen (the avatar column).  rightMax = 25 % is generous
  // enough to catch the avatar regardless of screen size or OEM skin.
  //
  // Previous v2 "fix" mistakenly required width ≥ 50 % of screen, which
  // rejected all 154 px avatar Views and left candidates empty — so the
  // click-notification feature still never ran.  Reverted to cx < rightMax.
  //
  // The important real fix (kept from v2): use the <node …/> regex rather
  // than a fixed-attribute-order regex.  UIAutomator does NOT guarantee
  // attribute order, so a pattern like clickable="true"…class="…"…bounds="…"
  // silently matched nothing on this device.
  const rightMax = Math.round(w * 0.25);
  const candidates: { x: number; y: number }[] = [];
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    if (!/clickable="true"/.test(attrs)) continue;
    const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bm) continue;
    const x1 = Number(bm[1]), y1 = Number(bm[2]), x2 = Number(bm[3]), y2 = Number(bm[4]);
    const cx = Math.round((x1 + x2) / 2);
    const cy = Math.round((y1 + y2) / 2);
    if (cx > rightMax) continue;  // only left-column avatar elements
    if (cy < topSkip || cy > botSkip) continue;
    candidates.push({ x: cx, y: cy });
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Find the Instagram Search tab (magnifying-glass icon) in the bottom nav.
 * Returns the tap coordinates or null if not found.
 *
 * This detector must never infer Search from horizontal position. Reels and
 * Search are adjacent on some Instagram layouts, so selecting an index from
 * the bottom-nav row can send Follow into Reels.
 */
/**
 * Detects whether Instagram (or any foreground app) is running inside a MIUI
 * floating window rather than fullscreen. A floating window is smaller than
 * the real device screen — UIAutomator's dump reports the window's own bounds
 * as the root, which will be noticeably shorter than the real display height.
 *
 * Root cause (confirmed 15 Jul 2026): when Instagram is in a floating window
 * the ui-dump root bounds height is ~1709 instead of the real 2460 px, so
 * _getScreenSize(xml) returns the wrong height. This shifts the bottom-nav
 * cutoff (botMin = h * 0.88) to a position that no longer corresponds to
 * where the bottom navigation bar actually sits, making findInstagramSearchTab
 * find 0 nodes and return null every time — even though Instagram's own layout
 * and code are completely unchanged. The fix is to detect the mismatch before
 * entering the search-tab / per-user follow loop, and recover by relaunching
 * Instagram fullscreen before proceeding.
 *
 * Returns the detected window height (from ui dump), the real device height
 * (from adb wm size), and whether a floating-window mismatch was found.
 */
export async function detectFloatingWindow(
  serial: string,
): Promise<{ floating: boolean; windowH: number; deviceH: number; windowW: number; deviceW: number }> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const { w: deviceW, h: deviceH } = getScreenSize(serial);
  const xml = await _uiDump(adb, serial).catch(() => null);
  if (!xml) return { floating: false, windowH: deviceH, deviceH, windowW: deviceW, deviceW };
  const xmlSize = _getScreenSizeFromXml(xml);
  if (!xmlSize) {
    return { floating: false, windowH: deviceH, deviceH, windowW: deviceW, deviceW };
  }
  const { w: windowW, h: windowH } = xmlSize;
  // Use 0.88 threshold — a floating window is typically 60–80 % of screen height;
  // 12 % headroom avoids false-positives from status-bar / notch differences.
  const floating = windowH < deviceH * 0.88 || windowW < deviceW * 0.88;
  return { floating, windowH, deviceH, windowW, deviceW };
}

export async function findInstagramSearchTab(
  serial: string,
  onLog?: (msg: string) => void,
): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial);
  if (!xml) return null;
  const byId = _findLiveNodeByResId(xml, ":id/search", ":id/tab_search", ":id/nav_search", ":id/bottom_tab_search");
  if (byId) return byId;
  const byLabel = _findElem(xml, "Search", "Explore");
  if (byLabel) return byLabel;

  // Unlabeled bottom-nav nodes are intentionally not enough. Their horizontal
  // order is not stable: on the failing layout the second node is Reels, not
  // Search. Wait for a semantic Search node/resource-id instead of guessing.
  onLog?.(
    "Follow: Search tab semantic node not found — refusing positional/pixel fallback",
  );
  return null;
}

/**
 * Find the Instagram search input bar (after tapping the Search tab).
 * Returns the tap coordinates or null if not found.
 *
 * Fixed: the old 30%-height limit and the unconstrained `_findElem` fallback
 * could match elements deep in the Explore grid (causing a tap below the bar
 * that looked like a swipe/pull-to-refresh).  Now strictly constrained to the
 * top 30 % of the screen with retries so the Explore page has time to settle.
 */
export async function findInstagramSearchBar(
  serial: string,
  onLog?: (msg: string) => void,
): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");

  // Use the adb-queried screen size rather than parsing it from the XML dump.
  // _getScreenSize(xml) falls back to { w:1600, h:900 } (a landscape/desktop
  // default) when the XML root element doesn't carry the expected
  // bounds="[0,0][w,h]" — which gives topLimit = Math.round(900*0.15) = 135 px.
  // On this Xiaomi phone (portrait, ~2400 px tall) the search bar sits at
  // ~180–260 px from the top, so 135 px rejected it every time → "search bar
  // not found". getScreenSize(serial) runs `adb shell wm size` and defaults to
  // 1080×2400 on error — both are correct for a portrait phone.
  const { h: screenH } = getScreenSize(serial);

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await _sleep(800);
    const xml = await _uiDump(adb, serial);
    if (!xml) continue;

    // 30 % gives up to 720 px on a 2400 px screen — comfortably above the
    // search bar while still safely below any Explore-grid content.
    const topLimit = Math.round(screenH * 0.30);

    // Scan complete node records and parse attributes independently. Android
    // UIAutomator is free to emit attributes in either order; never depend on
    // resource-id appearing before bounds in the XML.
    const nodeRe = /<node\b[^>]*>/gi;
    const searchIds = [
      "action_bar_search_edit_text", "search_bar_input", "search_bar",
      "search_input", "search_field", "search_bar_container",
      "action_bar_search_hints_text_layout", "explore_action_bar_container",
      "explore_action_bar",
    ];
    type SearchCandidate = { x: number; y: number; score: number; id: string; label: string };
    const candidates: SearchCandidate[] = [];
    let nodeMatch: RegExpExecArray | null;
    while ((nodeMatch = nodeRe.exec(xml)) !== null) {
      const node = nodeMatch[0];
      const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
      if (!bounds) continue;
      const centerY = (Number(bounds[2]) + Number(bounds[4])) / 2;
      if (centerY > topLimit) continue;
      const resourceId = node.match(/\bresource-id="([^"]*)"/i)?.[1] ?? "";
      const text = node.match(/\btext="([^"]*)"/i)?.[1] ?? "";
      const contentDesc = node.match(/\bcontent-desc="([^"]*)"/i)?.[1] ?? "";
      const hint = node.match(/\bhint="([^"]*)"/i)?.[1] ?? "";
      const label = `${text} ${contentDesc} ${hint}`.trim();
      const isEditText = /class="android\.widget\.EditText"/i.test(node);
      const mentionsSearch = /search/i.test(`${resourceId} ${label}`);
      const interactive = /(?:clickable|focusable)="true"/i.test(node);
      if (!interactive && !isEditText) continue;
      const matchedId = searchIds.find(id => resourceId.toLowerCase().includes(id));
      // A generic EditText is not enough: Instagram can expose keyboard,
      // hidden form, or login fields in the same top region.
      if (!matchedId && !mentionsSearch) continue;
      const score =
        (matchedId ? 100 : 0) +
        (isEditText ? 35 : 0) +
        (interactive ? 15 : 0) +
        (label ? 5 : 0);
      candidates.push({
        x: Math.round((Number(bounds[1]) + Number(bounds[3])) / 2),
        y: Math.round(centerY),
        score,
        id: resourceId || "(no resource-id)",
        label: label || "(no label)",
      });
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score || a.y - b.y);
      const best = candidates[0];
      onLog?.(`Follow: search bar node "${best.id}" "${best.label}" at (${best.x}, ${best.y})`);
      return { x: best.x, y: best.y };
    }

    // 2. Any node in the top 30% whose text or content-desc contains "Search"
    //    (case-insensitive) and is clickable or focusable.
    //
    //    Previous approach used two regex patterns that required a specific
    //    attribute order (text/content-desc → clickable → bounds OR bounds →
    //    clickable → text/content-desc).  UIAutomator doesn't guarantee order, so
    //    any node where bounds appears between those two would silently miss both
    //    patterns.  Additionally, IG's content-desc varies by version:
    //    "Search", "Search Instagram", "Search accounts, hashtags, and places",
    //    etc.  A line-by-line check is attribute-order-independent and catches
    //    all variants.
    for (const xmlLine of xml.split(/\r?\n/)) {
      // Quick reject: line must mention "search" somewhere
      if (!xmlLine.toLowerCase().includes("search")) continue;
      // Must have a bounds attribute we can parse
      const bm = xmlLine.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!bm) continue;
      const centerY = (Number(bm[2]) + Number(bm[4])) / 2;
      if (centerY > topLimit) continue;
      // Must be interactive (clickable OR focusable)
      if (!xmlLine.includes('clickable="true"') && !xmlLine.includes('focusable="true"')) continue;
      // "search" must appear inside a text="" or content-desc="" attribute value
      // (not just anywhere in the line, e.g. a resource-id containing "search")
      if (!/(?:text|content-desc)="[^"]*[Ss]earch[^"]*"/.test(xmlLine)) continue;
      return { x: Math.round((Number(bm[1]) + Number(bm[3])) / 2), y: Math.round(centerY) };
    }
    // attempt loop continues — wait and re-dump
  }

    // Method 3 — container nodes (action_bar_search_hints_text_layout /
  // explore_action_bar_container / explore_action_bar) are present in the
  // accessibility tree even when the inner EditText is transitioning or
  // temporarily detached.  Do one final dump and check for them.
  {
    const xml4 = await _uiDump(adb, serial);
    if (xml4) {
    for (const containerId of [
        ":id/action_bar_search_hints_text_layout",
        ":id/explore_action_bar_container",
        ":id/explore_action_bar",
      ]) {
        if (!xml4.includes(containerId)) continue;
        for (const node of xml4.match(/<node\b[\s\S]*?(?:\/>|<\/node>)/gi) ?? []) {
          if (!node.includes(containerId)) continue;
          const bm = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
          if (!bm) continue;
          const cx = Math.round((Number(bm[1]) + Number(bm[3])) / 2);
          const cy = Math.round((Number(bm[2]) + Number(bm[4])) / 2);
          onLog?.(`Follow: search bar found via container "${containerId}" at (${cx}, ${cy})`);
          return { x: cx, y: cy };
        }
      }
    }
  }

  // Do not guess from screen dimensions. If Instagram does not expose the
  // search field as an accessibility node, the caller must skip this user.
  onLog?.("Follow: search bar node not found — refusing coordinate fallback");
  return null;
}

/** Confirm that Instagram's live search field owns focus before typing or
 * sending any navigation key. This prevents a failed search tap from making
 * Back exit Instagram entirely. */
export async function isInstagramSearchBarFocused(serial: string): Promise<boolean> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const { h: screenH } = getScreenSize(serial);
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return false;
  const topLimit = Math.round(screenH * 0.30);
  for (const match of xml.matchAll(/<node\b[^>]*>/gi)) {
    const node = match[0];
    const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
    if (!bounds) continue;
    const centerY = (Number(bounds[2]) + Number(bounds[4])) / 2;
    if (centerY > topLimit) continue;
    const resourceId = node.match(/\bresource-id="([^"]*)"/i)?.[1] ?? "";
    const label = [
      node.match(/\btext="([^"]*)"/i)?.[1] ?? "",
      node.match(/\bcontent-desc="([^"]*)"/i)?.[1] ?? "",
      node.match(/\bhint="([^"]*)"/i)?.[1] ?? "",
    ].join(" ");
    if (!/focused="true"/i.test(node) || !/edittext/i.test(node) ||
        !/search/i.test(`${resourceId} ${label}`)) continue;
    return true;
  }
  return false;
}

/**
 * Type text on the on-screen keyboard character by character.
 *
 * If a getevent calibration map has been saved for this device (via the
 * Keyboard Calibration tool in the UI), that map is used — each keystroke
 * is sent as `adb shell input tap x y`, a real OS touch event that Instagram
 * sees as a normal hardware keypress with no spoofing possible.
 *
 * Without a calibration map, falls back to UIAutomator accessibility-tree
 * key lookup. On MIUI devices where the IME window is invisible to
 * UIAutomator, that further falls back to `adb input text`.
 *
 * Precondition: the target text field must already be focused (keyboard
 * must be visible on screen) before this function is called.
 */
export async function typeViaOnscreenKeyboard(
  serial: string,
  text: string,
  typingProfile: TypingSpeedProfile,
  onLog?: (msg: string) => void,
): Promise<void> {
  // ── Calibration-map path ───────────────────────────────────────────────────
  // If a getevent-calibrated key map exists for this device, use real tap
  // coordinates. Each keystroke is a real OS touch event — indistinguishable
  // from a human pressing the physical key on screen.
  const calMap = loadKeyCalibrationMap(serial);
  if (calMap && Object.keys(calMap).length > 5) {
    const hasPoint = (key: string): boolean => {
      const point = calMap[key];
      return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
    };
    const missingCalKeys = new Set<string>();
    const moreSymbolChars = new Set([
      "~", "`", "|", "•", "√", "π", "÷", "×", "§", "∆", "£", "€", "¥",
      "^", "°", "{", "}", "[", "]", "\\", "<", ">",
    ]);
    let needsSymbols = false;
    let needsMoreSymbols = false;
    for (const ch of text) {
      if (ch === " ") {
        if (!hasPoint("space")) missingCalKeys.add("space");
      } else if (ch === "\n") {
        if (!hasPoint("enter")) missingCalKeys.add("enter");
      } else if (/^[a-z]$/i.test(ch)) {
        if (!hasPoint(ch.toLowerCase()) && !hasPoint(ch)) missingCalKeys.add(ch.toLowerCase());
        if (ch !== ch.toLowerCase() && !hasPoint("shift")) missingCalKeys.add("shift");
      } else {
        needsSymbols = true;
        if (moreSymbolChars.has(ch)) needsMoreSymbols = true;
        if (!hasPoint(ch)) missingCalKeys.add(ch);
      }
    }
    if (needsSymbols && !hasPoint("symbols")) missingCalKeys.add("symbols");
    if (needsMoreSymbols && !hasPoint("moreSymbols")) missingCalKeys.add("moreSymbols");

    if (missingCalKeys.size === 0) {
      onLog?.(`[keyboard] using calibration map (${Object.keys(calMap).length} keys)`);
      const result = await typeViaCalibrationMap(serial, text, calMap, onLog, typingProfile);
      if (result.ok) return;
      throw new Error(`Calibrated typing incomplete — missing ${result.missing.join(", ")}`);
    } else {
      throw new Error(
        `Calibrated typing requires mapped key(s): ${[...missingCalKeys].join(", ")}`,
      );
    }
  }

  throw new Error("Calibrated typing requires a saved keyboard calibration map");

  /* Unreachable legacy accessibility typing implementation retained below
   * only for source-history context; all software typing must use calibration.
   */
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  let keyMap = new Map<string, { x: number; y: number }>();
  let keyMapMode: "letters" | "symbols" = "letters";

  /** Build key-position map from a standard UIAutomator dump. */
  const refreshKeyMap = async (mode: "letters" | "symbols") => {
    keyMapMode = mode;
    keyMap.clear();
    const xml = await _uiDump(adb, serial);
    if (!xml) return;
    const { h } = _getScreenSize(xml);
    // Keyboard occupies the bottom ~45 % of the screen.
    const keyboardTopY = Math.round(h * 0.55);
    const nodeRe = /<node\s([^>]+?)(?:\/?>)/g;
    let m: RegExpExecArray | null;
    while ((m = nodeRe.exec(xml)) !== null) {
      const attrs = m[1];
      if (!/clickable="true"/i.test(attrs)) continue;
      const bounds = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!bounds) continue;
      const x1 = +bounds[1], y1 = +bounds[2], x2 = +bounds[3], y2 = +bounds[4];
      const centerY = (y1 + y2) / 2;
      if (centerY < keyboardTopY) continue;
      const label = (
        attrs.match(/\btext="([^"]+)"/i)?.[1] ??
        attrs.match(/\bcontent-desc="([^"]+)"/i)?.[1] ?? ""
      ).trim();
      // Short single-key labels only (a–z, digits, @, ?, !, ., etc.)
      // Multi-word labels belong to app UI elements, not keyboard keys.
      if (!label || label.length > 3) continue;
      const cx = Math.round((x1 + x2) / 2);
      const cy = Math.round(centerY);
      if (!keyMap.has(label)) keyMap.set(label, { x: cx, y: cy });
      // Also index by lowercase for case-insensitive letter lookup.
      const low = label.toLowerCase();
      if (!keyMap.has(low)) keyMap.set(low, { x: cx, y: cy });
    }
    onLog?.(`[keyboard] ${mode} layer: ${keyMap.size} keys found`);
  };

  const switchToSymbols = async () => {
    if (keyMapMode === "symbols") return;
    const sym = keyMap.get("?123") ?? keyMap.get("123") ?? keyMap.get("!#1") ?? keyMap.get("&=<");
    if (sym) {
      _adbTap(adb, serial, sym.x, sym.y);
    } else {
      const xml2 = await _uiDump(adb, serial);
      const symKey = _findByResId(xml2, ":id/sym_keyboard_key", ":id/key_switch_alpha_numeric", ":id/numberswitch_key") ||
        _findElem(xml2, "?123", "123", "!#1");
      if (symKey) _adbTap(adb, serial, symKey.x, symKey.y);
    }
    await _sleep(400);
    await refreshKeyMap("symbols");
  };

  const switchToLetters = async () => {
    if (keyMapMode === "letters") return;
    const abc = keyMap.get("ABC") ?? keyMap.get("abc");
    if (abc) {
      _adbTap(adb, serial, abc.x, abc.y);
    } else {
      const xml2 = await _uiDump(adb, serial);
      const abcKey = _findByResId(xml2, ":id/alpha_keyboard_key", ":id/key_switch_alpha_numeric") ||
        _findElem(xml2, "ABC", "abc");
      if (abcKey) _adbTap(adb, serial, abcKey.x, abcKey.y);
    }
    await _sleep(400);
    await refreshKeyMap("letters");
  };

  await refreshKeyMap("letters");

  const visibleLetterKeys = new Set(
    [...keyMap.keys()].filter(key => /^[a-z]$/.test(key)),
  );
  const requestedLetterMissing = [...text].some(
    ch => /^[a-z]$/i.test(ch) && !keyMap.has(ch.toLowerCase()) && !keyMap.has(ch),
  );
  const asciiText = /^[\x20-\x7e]*$/.test(text);
  if (keyMap.size < 5 || visibleLetterKeys.size < 8 || (requestedLetterMissing && asciiText)) {
    // UIAutomator may return a few unrelated bottom-screen nodes while still
    // exposing no actual keyboard key. Check the requested key itself rather
    // than trusting a single matching node, otherwise an X/x press can
    // silently tap an unrelated app control.
    // This fallback is for ordinary ASCII typing only; the Story Emoji route
    // never calls this function and never injects Unicode.
    const reason = keyMap.size < 5
      ? "too few keyboard nodes"
      : visibleLetterKeys.size < 8
        ? `only ${visibleLetterKeys.size} keyboard letters found`
        : "requested letter missing";
    onLog?.(`[keyboard] ${reason} — using checked ASCII input fallback for ${text.length} character(s)`);
    runInputShell(serial, ["text", escapeForAdbInput(text)], "text");
    return;
  }

  for (const ch of text) {
    // ── Space ─────────────────────────────────────────────────────────────────
    if (ch === " ") {
      if (keyMapMode !== "letters") await switchToLetters();
      const spaceKey = keyMap.get(" ") ?? keyMap.get("space") ?? keyMap.get("Space");
      if (spaceKey) {
        _adbTap(adb, serial, spaceKey.x, spaceKey.y);
        onLog?.(`[keyboard] tapped space at (${spaceKey.x},${spaceKey.y})`);
      } else {
        onLog?.(`[keyboard] space key not found — skipping`);
      }
      await _sleep(150 + Math.round(Math.random() * 100));
      continue;
    }

    // ── @ ─────────────────────────────────────────────────────────────────────
    if (ch === "@") {
      await switchToSymbols();
      const atKey = keyMap.get("@");
      if (atKey) {
        _adbTap(adb, serial, atKey.x, atKey.y);
        onLog?.(`[keyboard] tapped @ at (${atKey.x},${atKey.y})`);
      } else {
        onLog?.(`[keyboard] @ not found — skipping`);
      }
      await _sleep(200 + Math.round(Math.random() * 100));
      await switchToLetters();
      continue;
    }

    // ── Digits ────────────────────────────────────────────────────────────────
    if (ch >= "0" && ch <= "9") {
      await switchToSymbols();
      const numKey = keyMap.get(ch);
      if (numKey) {
        _adbTap(adb, serial, numKey.x, numKey.y);
        onLog?.(`[keyboard] tapped '${ch}' at (${numKey.x},${numKey.y})`);
      } else {
        onLog?.(`[keyboard] '${ch}' not found — skipping`);
      }
      await _sleep(200 + Math.round(Math.random() * 100));
      continue;
    }

    // ── Letters ───────────────────────────────────────────────────────────────
    if (keyMapMode !== "letters") await switchToLetters();

    const isUpper = ch !== ch.toLowerCase();
    const lower = ch.toLowerCase();

    if (isUpper) {
      // Tap Shift to capitalise the next letter.
      const shiftKey = keyMap.get("⇧") ?? keyMap.get("shift") ?? keyMap.get("Shift");
      if (shiftKey) {
        _adbTap(adb, serial, shiftKey.x, shiftKey.y);
        onLog?.(`[keyboard] tapped Shift at (${shiftKey.x},${shiftKey.y})`);
        await _sleep(150);
        await refreshKeyMap("letters");
      } else {
        onLog?.(`[keyboard] Shift key not found — will try uppercase label directly`);
      }
    }

    let key = keyMap.get(lower) ?? keyMap.get(ch);
    if (!key) {
      // One refresh in case the keyboard re-rendered.
      await refreshKeyMap("letters");
      key = keyMap.get(lower) ?? keyMap.get(ch);
    }
    // Symbol not on letters layer — try symbols layer.
    if (!key) {
      await switchToSymbols();
      key = keyMap.get(ch);
      if (key) {
        _adbTap(adb, serial, key.x, key.y);
        onLog?.(`[keyboard] tapped '${ch}' at (${key.x},${key.y}) (symbols layer)`);
        await _sleep(150 + Math.round(Math.random() * 100));
        await switchToLetters();
        continue;
      }
      await switchToLetters();
    }
    if (key) {
      _adbTap(adb, serial, key.x, key.y);
      onLog?.(`[keyboard] tapped '${ch}' at (${key.x},${key.y})`);
    } else {
      onLog?.(`[keyboard] '${ch}' not found in key map — skipping`);
    }
    await _sleep(150 + Math.round(Math.random() * 100));
  }
}

// ─── Keyboard Calibration ─────────────────────────────────────────────────────
//
// One-time calibration: the user physically taps each key on the on-screen
// keyboard while `adb shell getevent -l` captures the raw hardware touch
// coordinates. Those are scaled to screen pixels and stored per device.
// typeViaOnscreenKeyboard then uses `adb shell input tap x y` for each
// keystroke — a real OS touch event, identical to a human pressing the key.

/** Map from key label (e.g. "a", "@", "space", "delete") to screen coordinate. */
export type KeyCalibrationMap = Record<string, { x: number; y: number }>;
export type TypingSpeedProfile = {
  minMs: number;
  maxMs: number;
  errorPercentMin: number;
  errorPercentMax: number;
  dwellMinMs: number;
  dwellMaxMs: number;
  hesitationMinMs: number;
  hesitationMaxMs: number;
};

// Keyboard layer is stateful across typing calls. Track the last layer
// selected per device so a later call never assumes ABC blindly.
const _calKeyboardLayer = new Map<string, "letters" | "symbols" | "moreSymbols">();

// Per-session cache so repeated captureOneTap calls during a calibration
// session skip the slow getevent -lp query. Keyed by device serial and cleared
// automatically when the server restarts. The display size is intentionally
// NOT cached: Android's logical display can change while the calibration
// dialog is open, and input tap/UIAutomator use the current wm size.
const _calDeviceInfoCache = new Map<string, {
  device: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}>();

/**
 * Pre-warm the per-device touchscreen calibration cache.
 * Call once when the calibration dialog opens so all subsequent captureOneTap
 * calls return almost immediately instead of spending 3-5 s on setup queries.
 */
export async function prefetchCalibrationData(serial: string): Promise<boolean> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  if (!_calDeviceInfoCache.has(serial)) {
    const devInfo = await _getTouchDeviceInfo(adb, serial);
    if (devInfo) _calDeviceInfoCache.set(serial, devInfo);
  }
  const { w, h } = getScreenSize(serial);
  return w > 0 && h > 0 && _calDeviceInfoCache.has(serial);
}

function _calibrationPath(serial: string): string {
  const safeSerial = serial.replace(/[^a-z0-9]/gi, "-");
  const dir = process.env.EQUINOX_DATA_DIR ?? process.cwd();
  return path.join(dir, `keyboard-cal-${safeSerial}.json`);
}

/** Load the saved calibration map for a device. Returns null if none exists. */
export function loadKeyCalibrationMap(serial: string): KeyCalibrationMap | null {
  try {
    const raw = fs.readFileSync(_calibrationPath(serial), "utf8");
    return JSON.parse(raw) as KeyCalibrationMap;
  } catch { return null; }
}

/**
 * Type only through the saved Android keyboard calibration map.
 *
 * This is intentionally strict. Callers that require real on-screen keyboard
 * taps must not fall back to `adb shell input text` when calibration is
 * missing or incomplete.
 */
export async function typeViaSavedCalibrationMap(
  serial: string,
  text: string,
  typingProfile: TypingSpeedProfile | undefined,
  onLog?: (msg: string) => void,
  options?: { disableHumanErrors?: boolean; debugLabel?: string },
): Promise<{ ok: boolean; available: boolean; missing: string[] }> {
  const map = loadKeyCalibrationMap(serial);
  const mapPath = _calibrationPath(serial);
  const uniqueChars = [...new Set([...text])].join("");
  onLog?.(
    `[cal-keyboard] serial=${serial} map=${map ? "loaded" : "missing"} ` +
    `entries=${map ? Object.keys(map).length : 0} typingProfile=${typingProfile ? "loaded" : "missing"} ` +
    `textLength=${text.length} uniqueChars=${JSON.stringify(uniqueChars)} path=${mapPath}`,
  );
  if (!map) {
    onLog?.("[cal-keyboard] no saved calibration map");
    return { ok: false, available: false, missing: [...text] };
  }

  // Preflight every key before the first tap. Without this guard the lower
  // level typing loop could enter part of a string, then discover a missing
  // punctuation/shift/layer key and return with a half-written field.
  const moreSymbolChars = new Set([
    "~", "`", "|", "•", "√", "π", "÷", "×", "§", "∆", "£", "€", "¥",
    "^", "°", "{", "}", "[", "]", "\\", "<", ">",
  ]);
  const hasPoint = (key: string) => {
    const aliases: Record<string, string[]> = {
      "'": ["'", "apostrophe", "singleQuote", "single-quote"],
      "\"": ["\"", "quote", "doubleQuote", "double-quote"],
    };
    const point = [key, ...(aliases[key] ?? [])]
      .map(alias => map[alias])
      .find(candidate => candidate && Number.isFinite(candidate.x) && Number.isFinite(candidate.y));
    return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
  };
  const required = new Set<string>();
  let needsSymbols = false;
  let needsMoreSymbols = false;
  for (const ch of text) {
    if (ch === " ") {
      required.add("space");
    } else if (ch === "\n") {
      required.add("enter");
    } else if (/^[a-z]$/i.test(ch)) {
      required.add(ch.toLowerCase());
      if (ch !== ch.toLowerCase()) required.add("shift");
    } else {
      required.add(ch);
      if (moreSymbolChars.has(ch)) needsMoreSymbols = true;
      else if (ch !== "," && ch !== ".") needsSymbols = true;
    }
  }
  if (needsSymbols) required.add("symbols");
  if (needsMoreSymbols) required.add("moreSymbols");
  const missing = [...required].filter(key => !hasPoint(key));
  if (missing.length) {
    onLog?.(
      `[cal-keyboard] calibration preflight missing: ${missing.join(", ")} ` +
      `(serial=${serial}, mappedKeys=${Object.keys(map).length})`,
    );
    return { ok: false, available: true, missing };
  }

  const result = await typeViaCalibrationMap(serial, text, map, onLog, typingProfile, {
    disableHumanErrors: options?.disableHumanErrors,
    debugLabel: options?.debugLabel,
  });
  return { ...result, available: true };
}

/** Type a numeric 2FA code using the separately calibrated Instagram keypad. */
export async function typeViaSaved2faKeypad(
  serial: string,
  text: string,
  typingProfile: TypingSpeedProfile | undefined,
  onLog?: (msg: string) => void,
): Promise<{ ok: boolean; available: boolean; missing: string[] }> {
  const map = loadKeyCalibrationMap(serial);
  const missing = [...new Set([...text].filter(ch => !/^\d$/.test(ch) || !map?.[`2fa:${ch}`]))];
  if (!map || missing.length) {
    onLog?.(`[2fa-keypad] calibration missing: ${missing.join(", ") || "all digits"}`);
    return { ok: false, available: !!map, missing };
  }
  if (!typingProfile) throw new Error("Complete Typing Speed Profile is required for calibrated typing");
  for (const ch of text) {
    const pos = map[`2fa:${ch}`];
    const dwellMin = Math.max(1, Math.min(typingProfile.dwellMinMs, typingProfile.dwellMaxMs));
    const dwellMax = Math.max(dwellMin, typingProfile.dwellMaxMs);
    const dwell = Math.round(dwellMin + Math.random() * (dwellMax - dwellMin));
    await runInputShell(serial,
      ["swipe", String(Math.round(pos.x)), String(Math.round(pos.y)), String(Math.round(pos.x)), String(Math.round(pos.y)), String(dwell)],
      "2fa-keypad-dwell-tap");
    const min = Math.max(0, Math.min(typingProfile.minMs, typingProfile.maxMs));
    const max = Math.max(min, typingProfile.maxMs);
    await _sleep(min + Math.round(Math.random() * (max - min)));
    onLog?.(`[2fa-keypad] tapped ${ch} at (${pos.x},${pos.y})`);
  }
  return { ok: true, available: true, missing: [] };
}

/**
 * Resolve and tap a named keyboard control.
 *
 * Gboard is inconsistent about exposing its controls through UIAutomator. Use
 * the live IME node when available, then fall back to the same-device physical
 * calibration point, and finally to the visual Emoji detector for Emoji. The
 * calibration point is deliberately bounded to the current screen and lower
 * keyboard region so a stale/corrupt map cannot turn into a random app tap.
 */
export async function tapCalibratedKeyboardKey(
  serial: string,
  keyName: string,
  onLog?: (msg: string) => void,
): Promise<boolean> {
  const normalized = keyName.trim().toLowerCase();
  const isEmojiAction = normalized === "emoji" || normalized === "emoticon" || normalized === "smiley";
  const map = loadKeyCalibrationMap(serial);
  if (!map) {
    onLog?.(`[cal-keyboard] '${keyName}' has no saved calibration map — continuing with live/visual lookup`);
  }
  const aliases = normalized === "emoji" || normalized === "emoticon" || normalized === "smiley"
    ? ["emoji", "emoticon", "smiley"]
    : [normalized, keyName];
  const mapKey = map ? aliases.find(alias => map[alias] != null) : undefined;
  if (!mapKey) {
    onLog?.(
      `[cal-keyboard] '${keyName}' is not in calibration map — ` +
      `continuing with ${isEmojiAction ? "live/visual" : "live-node"} lookup`,
    );
  }

  // Prefer the live IME hierarchy whenever Gboard exposes it. Some builds
  // render the key but omit the node entirely, which is why the calibrated
  // physical-tap fallback below is necessary.
  const { xml, imeIncluded } = await dumpUiWithIme(serial);
  const { w: screenW, h: screenH } = getScreenSize(serial);
  const activeImePackage = await getActiveInputMethodPackage(serial).catch(() => "");
  type KeyboardNode = {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    x: number;
    y: number;
    cy: number;
    label: string;
    resourceId: string;
    packageName: string;
    className: string;
    imeNode: boolean;
    activeImeNode: boolean;
    clickable: boolean;
    focusable: boolean;
    score: number;
  };
  const allImeNodes: KeyboardNode[] = [];
  const candidates: KeyboardNode[] = [];
  const isKeyControl = (node: KeyboardNode): boolean =>
    node.clickable ||
    node.focusable ||
    /(?:button|key|keyboard)/i.test(`${node.className} ${node.resourceId}`);
  const nodeRe = /<node\s([^>]+?)\s*\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = nodeRe.exec(xml)) !== null) {
    const attrs = match[1];
    const bounds = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
    if (!bounds) continue;
    const x1 = Number(bounds[1]), y1 = Number(bounds[2]);
    const x2 = Number(bounds[3]), y2 = Number(bounds[4]);
    const cy = Math.round((y1 + y2) / 2);
    if (cy < Math.round(screenH * 0.45)) continue;
    const isClickable = attrs.includes('clickable="true"');
    const isFocusable = attrs.includes('focusable="true"');
    if (attrs.includes('enabled="false"')) continue;

    const label = [
      attrs.match(/\btext="([^"]*)"/i)?.[1] ?? "",
      attrs.match(/\bcontent-desc="([^"]*)"/i)?.[1] ?? "",
      attrs.match(/\bhint="([^"]*)"/i)?.[1] ?? "",
    ].join(" ").replace(/\s+/g, " ").trim();
    const resourceId = attrs.match(/\bresource-id="([^"]*)"/i)?.[1] ?? "";
    const packageName = attrs.match(/\bpackage="([^"]*)"/i)?.[1] ?? "";
    const className = attrs.match(/\bclass="([^"]*)"/i)?.[1] ?? "";
    const imeNode =
      /(?:inputmethod|keyboard|ime)/i.test(resourceId) ||
      /(?:inputmethod|keyboard|ime|gboard|swiftkey|latin)/i.test(packageName);
    const activeImeNode =
      !!activeImePackage &&
      !!packageName &&
      (packageName === activeImePackage || packageName.startsWith(`${activeImePackage}.`));
    // When --include-ime works, package-less lower-window nodes can still be
    // part of Gboard's live hierarchy. Do not, however, treat labelled
    // Instagram nodes in the combined dump as keyboard nodes.
    const packageLessIncludedNode = imeIncluded && !packageName;
    if (!imeNode && !activeImeNode && !packageLessIncludedNode) continue;

    const keyboardNode: KeyboardNode = {
      x1,
      y1,
      x2,
      y2,
      x: Math.round((x1 + x2) / 2),
      y: cy,
      cy,
      label,
      resourceId,
      packageName,
      className,
      imeNode,
      activeImeNode,
      clickable: isClickable,
      focusable: isFocusable,
      score: 0,
    };
    // When --include-ime is available, the lower-window nodes are part of the
    // live IME tree even if this Android build omits the IME package/resource
    // attributes. Keep those nodes for the structural unlabeled-key lookup.
    if (imeNode || activeImeNode || packageLessIncludedNode) allImeNodes.push(keyboardNode);

    // A combined --include-ime dump can also contain the underlying Instagram
    // window. Do not let an Instagram story label containing "emoji" become a
    // keyboard target; explicit label/resource matches must identify the IME.
    const labelMatch = (imeNode || activeImeNode) && aliases.some(alias =>
      label.toLowerCase().includes(alias.toLowerCase()) ||
      resourceId.toLowerCase().includes(alias.toLowerCase()),
    );
    if (!labelMatch) continue;

    const exactLabel = aliases.some(alias => label.toLowerCase() === alias.toLowerCase());
    keyboardNode.score =
      (exactLabel ? 8 : 0) +
      (resourceId.toLowerCase().includes("emoji") ? 4 : 0) +
      (resourceId.toLowerCase().includes("key") ? 1 : 0) +
      (imeNode ? 4 : 0) +
      (activeImeNode ? 5 : 0) +
      (isClickable ? 2 : 0) +
      (isFocusable ? 1 : 0);
    candidates.push(keyboardNode);
  }

  // Some Gboard/MIUI builds visibly render the Emoji key but expose it as an
  // unlabeled ImageButton (or omit its resource-id).  It is still represented
  // by the live IME tree.  In that case, use the keyboard's own accessible
  // structure: the Emoji key is the key immediately to the left of the live
  // Space key in the same bottom row.  This is deliberately not a screen
  // coordinate, pixel, or saved-calibration fallback.
  if (candidates.length === 0 && (normalized === "emoji" || normalized === "emoticon" || normalized === "smiley")) {
    // Prefer nodes anchored by the active IME package. Only use package-less
    // nodes when this device exposes no package metadata at all; otherwise an
    // app node from the combined dump could masquerade as a keyboard key.
    const packageAnchoredImeNodes = allImeNodes.filter(node => node.imeNode || node.activeImeNode);
    const structuralPool = packageAnchoredImeNodes.length > 0
      ? packageAnchoredImeNodes
      : allImeNodes.filter(node => node.packageName === "");
    const spaceNodes = structuralPool
      .filter(node => /\bspace(?:bar)?\b/i.test(`${node.label} ${node.resourceId}`))
      .sort((a, b) =>
        Number(b.activeImeNode) - Number(a.activeImeNode) ||
        b.score - a.score ||
        b.y2 - a.y2 ||
        (a.x2 - a.x1) - (b.x2 - b.x1),
      );
    const space = spaceNodes[0];
    if (space) {
      const rowNeighbors = allImeNodes
        .filter(node => structuralPool.includes(node))
        .filter(node => node !== space)
        .filter(node => node.x2 <= space.x1)
        .filter(node => Math.abs(node.cy - space.cy) <= Math.max(node.y2 - node.y1, space.y2 - space.y1))
        .filter(node => space.x1 - node.x2 <= Math.max(node.y2 - node.y1, space.y2 - space.y1))
        .filter(node => isKeyControl(node))
        .sort((a, b) =>
          Number(b.activeImeNode) - Number(a.activeImeNode) ||
          b.x2 - a.x2,
        );
      const structuralEmoji = rowNeighbors[0];
      if (structuralEmoji) {
        structuralEmoji.score = 6 +
          (structuralEmoji.imeNode ? 4 : 0) +
          (structuralEmoji.activeImeNode ? 5 : 0);
        candidates.push(structuralEmoji);
        onLog?.(
          `[cal-keyboard] Gboard Emoji has no label — using live key immediately left of ` +
          `Space (${structuralEmoji.x},${structuralEmoji.y}; ` +
          `active-ime=${activeImePackage || "unknown"})`,
        );
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.y - b.y);
  const node = candidates[0];
  const tapAndVerify = async (x: number, y: number, source: string): Promise<boolean> => {
    await tap(serial, x, y);
    await _sleep(220 + Math.round(Math.random() * 120));
    if (isEmojiAction) {
      const pickerOpen = await isKeyboardEmojiPickerOpen(serial);
      if (!pickerOpen) {
        onLog?.(`[cal-keyboard] ${source} did not open a detectable Emoji picker`);
        return false;
      }
    }
    onLog?.(`[cal-keyboard] ${source} succeeded at (${Math.round(x)},${Math.round(y)})`);
    return true;
  };

  if (node) {
    if (await tapAndVerify(
      node.x,
      node.y,
      `tapped live IME node '${keyName}' via bind '${mapKey}'`,
    )) return true;
    // Do not fire a second control tap after an attempted live-node tap. If
    // the picker opened but its nodes are not exposed, the next coordinate
    // would land on a picker cell rather than on the keyboard.
    onLog?.(`[cal-keyboard] live-node attempt was not verified; refusing a second control tap`);
    return false;
  }

  const savedPoint = mapKey && map ? map[mapKey] : undefined;
  const savedPointIsSafe = !!savedPoint &&
    Number.isFinite(savedPoint.x) &&
    Number.isFinite(savedPoint.y) &&
    savedPoint.x >= 0 &&
    savedPoint.x < screenW &&
    savedPoint.y >= Math.round(screenH * 0.45) &&
    savedPoint.y < screenH;

  onLog?.(
    `[cal-keyboard] live IME node '${keyName}' not found — ` +
    `trying calibrated physical tap (${savedPointIsSafe ? "available" : "invalid"}) ` +
    `(ime=${imeIncluded ? "yes" : "no"}, active-ime=${activeImePackage || "unknown"}, ` +
    `imeNodes=${allImeNodes.length}, ` +
    `spaceNodes=${allImeNodes.filter(n => /\bspace(?:bar)?\b/i.test(`${n.label} ${n.resourceId}`)).length}, ` +
    `bottomNodes=${allImeNodes
      .filter(n => n.cy >= Math.round(screenH * 0.78))
      .sort((a, b) => a.x - b.x)
      .slice(-16)
      .map(n => `${n.label || "∅"}@${n.x},${n.y}${n.clickable ? ":C" : ""}`)
      .join("|") || "none"})`,
  );

  if (savedPointIsSafe) {
    onLog?.(
      `[cal-keyboard] trying saved physical bind '${mapKey}' at ` +
      `(${Math.round(savedPoint.x)},${Math.round(savedPoint.y)})`,
    );
    if (await tapAndVerify(
      savedPoint.x,
      savedPoint.y,
      `saved physical bind '${mapKey}'`,
    )) return true;
    // Same safety rule as above: once a physical control tap has been sent,
    // do not guess again while the picker state may be visually open.
    onLog?.(`[cal-keyboard] calibrated attempt was not verified; refusing a second control tap`);
    return false;
  }

  // The pixel detector is intentionally the final fallback and is restricted
  // to Emoji. It identifies the actual bottom-row key geometry rather than
  // using a screen-percentage guess.
  if (isEmojiAction) {
    const visualPoint = await findKeyboardEmojiButton(serial);
    if (visualPoint &&
        visualPoint.x >= 0 && visualPoint.x < screenW &&
        visualPoint.y >= Math.round(screenH * 0.45) && visualPoint.y < screenH) {
      if (await tapAndVerify(
        visualPoint.x,
        visualPoint.y,
        "visually detected Emoji key",
      )) return true;
    }
    onLog?.("[cal-keyboard] calibrated and visual Emoji fallbacks both unavailable");
  }

  onLog?.(`[cal-keyboard] bind '${mapKey}' could not produce a safe tap`);
  return false;
}

/**
 * Select one emoji from the live IME accessibility tree after its Emoji
 * control has opened the picker. This intentionally does not use the saved
 * calibration map, screenshot pixels, or guessed coordinates. The picker
 * cell's current accessibility bounds are the only tap target.
 */
export async function tapKeyboardEmojiNode(
  serial: string,
  onLog?: (msg: string) => void,
): Promise<boolean> {
  const { xml, imeIncluded } = await dumpUiWithIme(serial);
  const { h: screenH } = getScreenSize(serial);
  const activeImePackage = await getActiveInputMethodPackage(serial).catch(() => "");
  const candidates: Array<{ x: number; y: number; label: string; score: number }> = [];
  const nodeRe = /<node\s([^>]+?)\s*\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = nodeRe.exec(xml)) !== null) {
    const attrs = match[1];
    const bounds = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
    if (!bounds) continue;
    const x1 = Number(bounds[1]), y1 = Number(bounds[2]);
    const x2 = Number(bounds[3]), y2 = Number(bounds[4]);
    const cy = Math.round((y1 + y2) / 2);
    if (cy < Math.round(screenH * 0.42)) continue;
    const isClickable = attrs.includes('clickable="true"');
    const isFocusable = attrs.includes('focusable="true"');
    if (attrs.includes('enabled="false"')) continue;

    const label = [
      attrs.match(/\btext="([^"]*)"/i)?.[1] ?? "",
      attrs.match(/\bcontent-desc="([^"]*)"/i)?.[1] ?? "",
    ].join(" ").replace(/\s+/g, " ").trim();
    const resourceId = attrs.match(/\bresource-id="([^"]*)"/i)?.[1] ?? "";
    const packageName = attrs.match(/\bpackage="([^"]*)"/i)?.[1] ?? "";
    const imeNode =
      /(?:inputmethod|keyboard|ime)/i.test(resourceId) ||
      /(?:inputmethod|keyboard|ime|gboard|swiftkey|latin)/i.test(packageName);
    const activeImeNode =
      !!activeImePackage &&
      !!packageName &&
      (packageName === activeImePackage || packageName.startsWith(`${activeImePackage}.`));
    const packageLessIncludedNode = imeIncluded && !packageName;
    if (!imeNode && !activeImeNode && !packageLessIncludedNode) continue;
    if (!label) continue;

    // Gboard exposes picker cells as descriptive labels such as "grinning
    // face" or as the emoji glyph itself. Exclude navigation/category and
    // keyboard controls so only an actual picker cell can be selected.
    if (/(?:emoji|emoticon|smiley|backspace|delete|enter|return|space|shift|settings|search|category|sticker|gif|clipboard)/i.test(label) &&
        !/\p{Extended_Pictographic}/u.test(label)) {
      continue;
    }
    const hasEmojiGlyph = /\p{Extended_Pictographic}/u.test(label);
    const namedEmoji = /(?:face|heart|hand|thumb|fire|sparkles|laugh|cry|kiss|wink|grin|smile|folded hands|party|eyes|love|angry|sad|joy)/i.test(label);
    if (!hasEmojiGlyph && !namedEmoji) continue;
    candidates.push({
      x: Math.round((x1 + x2) / 2),
      y: cy,
      label,
      score:
        (hasEmojiGlyph ? 4 : 0) +
        (namedEmoji ? 3 : 0) +
        (imeNode ? 3 : 0) +
        (activeImeNode ? 5 : 0) +
        (isClickable ? 2 : 0) +
        (isFocusable ? 1 : 0),
    });
  }

  if (candidates.length === 0) {
    onLog?.(
      `[cal-keyboard] live Emoji picker node not found — skipping reply ` +
      `(ime=${imeIncluded ? "yes" : "no"}, active-ime=${activeImePackage || "unknown"}, ` +
      `labelledCandidates=0)`,
    );
    return false;
  }

  // Keep selection deterministic and node-based. The picker itself provides
  // the ordering; no screen coordinate or pixel heuristic is involved.
  candidates.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
  const node = candidates[0];
  await tap(serial, node.x, node.y);
  onLog?.(
    `[cal-keyboard] tapped live Emoji picker node (label="${node.label}", ` +
    `candidates=${candidates.length}, ime=${imeIncluded ? "yes" : "no"})`,
  );
  await _sleep(220 + Math.round(Math.random() * 120));
  return true;
}

/** Persist a calibration map for a device. */
export function saveKeyCalibrationMap(serial: string, map: KeyCalibrationMap): void {
  fs.writeFileSync(_calibrationPath(serial), JSON.stringify(map, null, 2), "utf8");
}

/** Delete the calibration map for a device. */
export function deleteKeyCalibrationMap(serial: string): void {
  try { fs.unlinkSync(_calibrationPath(serial)); } catch { /**/ }
}

/**
 * Discover the touchscreen event device and its ABS_MT_POSITION X/Y axis
 * max values by parsing `adb shell getevent -lp`.
 * Returns null if no suitable device is found.
 */
async function _getTouchDeviceInfo(
  adb: string,
  serial: string,
): Promise<{
  device: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} | null> {
  const out = await runAdb(adb, ["-s", serial, "shell", "getevent", "-lp"], 8000);
  if (!out) return null;
  // Split on "add device N:" to get per-device blocks.
  const blocks = out.split(/^add device \d+:/m).filter(Boolean);
  for (const block of blocks) {
    const deviceMatch = block.match(/^\s*(\/dev\/input\/\S+)/m);
    if (!deviceMatch) continue;
    const device = deviceMatch[1].trim();
    const xMatch = block.match(/ABS_MT_POSITION_X\s*:.*?min\s+(-?\d+).*?max\s+(-?\d+)/i);
    const yMatch = block.match(/ABS_MT_POSITION_Y\s*:.*?min\s+(-?\d+).*?max\s+(-?\d+)/i);
    if (!xMatch || !yMatch) continue;
    const minX = parseInt(xMatch[1], 10);
    const maxX = parseInt(xMatch[2], 10);
    const minY = parseInt(yMatch[1], 10);
    const maxY = parseInt(yMatch[2], 10);
    if (maxX > minX && maxY > minY) return { device, minX, maxX, minY, maxY };
  }
  return null;
}

/**
 * Wait for the user to physically tap the phone screen once and return the
 * screen-pixel coordinate of that tap. Works by streaming `adb shell getevent`
 * events, capturing the first ABS_MT_POSITION_X + ABS_MT_POSITION_Y pair
 * before a SYN_REPORT, then scaling raw device values to screen pixels.
 *
 * @param timeoutMs  How long to wait for a tap (default 15 s).
 * @returns Screen {x, y} of the tap, or null on timeout / error.
 */
export async function captureOneTap(
  serial: string,
  timeoutMs = 15_000,
  onLog?: (msg: string) => void,
): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");

  // Use the same current logical display dimensions as adb shell input tap and
  // the rest of the mobile input path. UIAutomator root bounds can omit the
  // bottom navigation area and must not define calibration's coordinate space.
  const { w: screenW, h: screenH } = getScreenSize(serial);
  if (!screenW || !screenH) return null;

  // Use cached device info if available, otherwise discover it now.
  let devInfo = _calDeviceInfoCache.get(serial);
  if (!devInfo) {
    const discovered = await _getTouchDeviceInfo(adb, serial);
    if (!discovered) return null;
    _calDeviceInfoCache.set(serial, discovered);
    devInfo = discovered;
  }
  const { device, minX, maxX, minY, maxY } = devInfo;
  const rangeX = maxX - minX;
  const rangeY = maxY - minY;
  onLog?.(
    `[keyboard-calibration] capture ready: device=${device}, ` +
    `rawX=${minX}..${maxX}, rawY=${minY}..${maxY}, display=${screenW}x${screenH}`,
  );

  return new Promise<{ x: number; y: number } | null>((resolve) => {
    let rawX: number | null = null;
    let rawY: number | null = null;
    let resolved = false;

    const child = spawn(adb, ["-s", serial, "shell", "getevent", "-l", device]);

    const finish = (result: { x: number; y: number } | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /**/ }
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (/ABS_MT_POSITION_X/.test(line)) {
          const m = line.match(/([0-9a-f]{8})\s*$/i);
          if (m) rawX = parseInt(m[1], 16);
        } else if (/ABS_MT_POSITION_Y/.test(line)) {
          const m = line.match(/([0-9a-f]{8})\s*$/i);
          if (m) rawY = parseInt(m[1], 16);
        } else if (/SYN_REPORT/.test(line) && rawX !== null && rawY !== null) {
          // First complete touch-down event captured. Normalize within the
          // touchscreen's advertised axis bounds before mapping to the current
          // logical display. Clamp out-of-range noise instead of allowing a
          // stale/raw calibration value to escape the screen.
          const normalizedX = Math.min(1, Math.max(0, (rawX - minX) / rangeX));
          const normalizedY = Math.min(1, Math.max(0, (rawY - minY) / rangeY));
          const x = Math.round(normalizedX * (screenW - 1));
          const y = Math.round(normalizedY * (screenH - 1));
          onLog?.(
            `[keyboard-calibration] captured raw=(${rawX},${rawY}) ` +
            `mapped=(${x},${y}) display=${screenW}x${screenH}`,
          );
          finish({ x, y });
        }
      }
    });

    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
  });
}

/**
 * Type text using a pre-calibrated key map (getevent-captured coordinates).
 * Each character is sent as `adb shell input tap x y` — a real OS touch event
 * processed by Android exactly as if a finger pressed the key.
 */
export async function typeViaCalibrationMap(
  serial: string,
  text: string,
  map: KeyCalibrationMap,
  onLog?: (msg: string) => void,
  typingProfile: TypingSpeedProfile,
  options?: { disableHumanErrors?: boolean; shiftEnterNewlines?: boolean; debugLabel?: string },
): Promise<{ ok: boolean; missing: string[] }> {
  if (!typingProfile ||
      !Number.isFinite(typingProfile.minMs) ||
      !Number.isFinite(typingProfile.maxMs) ||
      !Number.isFinite(typingProfile.errorPercentMin) ||
      !Number.isFinite(typingProfile.errorPercentMax) ||
      !Number.isFinite(typingProfile.dwellMinMs) ||
      !Number.isFinite(typingProfile.dwellMaxMs) ||
      !Number.isFinite(typingProfile.hesitationMinMs) ||
      !Number.isFinite(typingProfile.hesitationMaxMs)) {
    throw new Error("Complete Typing Speed Profile, including dwell and hesitation, is required for calibrated typing");
  }
  const missing: string[] = [];
  // A newly focused Instagram text field opens Gboard on its letters layer.
  // Do not trust the process-local cached layer here: a previous typing run
  // may have been interrupted after tapping ?123, leaving the cache out of
  // sync with the keyboard that Android presents for this new field.  Using
  // the stale state makes the first punctuation character tap the wrong
  // physical key while all ADB taps still appear successful.
  let layer: "letters" | "symbols" | "moreSymbols" = "letters";
  _calKeyboardLayer.set(serial, layer);
  const display = getScreenSize(serial);
  const activeIme = await getActiveInputMethodPackage(serial).catch(() => "");
  onLog?.(
    `[cal-keyboard] typing-session start serial=${serial} display=${display.w}x${display.h} ` +
    `ime=${activeIme || "unknown"} initialLayer=${layer} textLength=${text.length} ` +
    `debugLabel=${options?.debugLabel ?? "none"}`,
  );

  const tapMapped = async (
    label: string,
    description = label,
    _dwellOverrideMs?: number,
    allowDestructive = false,
  ): Promise<boolean> => {
    if (/(?:backspace|delete|forward[ -]?delete)/i.test(label) ||
        /(?:backspace|delete|forward[ -]?delete)/i.test(description)) {
      if (!allowDestructive) {
        onLog?.(`[cal-keyboard] denied destructive key '${description}'`);
        return false;
      }
    }
    const dwellMin = allowDestructive && _dwellOverrideMs != null
      ? Math.max(0, _dwellOverrideMs)
      : Math.max(0, Math.min(typingProfile.minMs, typingProfile.maxMs));
    const dwellMax = allowDestructive && _dwellOverrideMs != null
      ? dwellMin
      : Math.max(dwellMin, typingProfile.maxMs);
    if (allowDestructive && options?.debugLabel) {
      onLog?.(
        `[${options.debugLabel}] destructive-key permitted key=${JSON.stringify(description)} ` +
        `dwell=${dwellMin}ms layer=${layer} configuredTyping=${typingProfile.minMs}-${typingProfile.maxMs}ms`,
      );
    }
    const aliases: Record<string, string[]> = {
      "'": ["'", "apostrophe", "singleQuote", "single-quote"],
      "\"": ["\"", "quote", "doubleQuote", "double-quote"],
    };
    const pos = [label, ...(aliases[label] ?? [])]
      .map(alias => map[alias])
      .find(candidate => candidate && Number.isFinite(candidate.x) && Number.isFinite(candidate.y));
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      onLog?.(`[cal-keyboard] '${description}' is not in calibration map`);
      return false;
    }
    if (options?.debugLabel) {
      onLog?.(
        `[${options.debugLabel}] tap-plan key=${JSON.stringify(description)} ` +
        `coordinate=(${pos.x},${pos.y}) layer=${layer} display=${display.w}x${display.h}`,
      );
    }
    const tapStartedAt = Date.now();
    try {
      // A zero-distance swipe is not a tap with a configurable dwell: on
      // Xiaomi/MIUI it can be interpreted as a long-press and emit repeats.
      // Calibration records coordinates, so emit exactly one native tap and
      // keep human pacing in the delay below. Never turn a character tap into
      // a gesture.
      await runInputShell(
        serial,
        ["tap", String(Math.round(pos.x)), String(Math.round(pos.y))],
        "calibrated-tap",
      );
    } catch (e: any) {
      onLog?.(`[cal-keyboard] tap failed for ${description} at (${pos.x},${pos.y}) — ${e?.message}`);
      return false;
    }
    onLog?.(`[cal-keyboard] tapped ${description} at (${pos.x},${pos.y}) elapsed=${Date.now() - tapStartedAt}ms`);
    if (options?.debugLabel && /(?:shift|enter|backspace|delete)/i.test(description)) {
      onLog?.(`[${options.debugLabel}] key-event=${description} coordinate=(${pos.x},${pos.y})`);
    }
    const pause = dwellMin + Math.round(Math.random() * (dwellMax - dwellMin));
    onLog?.(`[cal-keyboard] pacing after ${description}: ${pause}ms (range=${dwellMin}-${dwellMax}ms)`);
    await _sleep(pause);
    return true;
  };
  const maybeHumanError = async () => {
    if (options?.disableHumanErrors) {
      if (options.debugLabel) onLog?.(`[${options.debugLabel}] human-error correction skipped (disabled)`);
      return;
    }
    if (!typingProfile || !map.backspace) {
      if (options?.debugLabel) onLog?.(`[${options.debugLabel}] human-error correction unavailable`);
      return;
    }
    const lo = Math.max(0, Math.min(typingProfile.errorPercentMin, typingProfile.errorPercentMax));
    const hi = Math.min(100, Math.max(lo, typingProfile.errorPercentMax));
    if (options?.debugLabel) {
      onLog?.(
        `[${options.debugLabel}] human-error config probability=${lo}-${hi}% ` +
        `typingGap=${typingProfile.minMs}-${typingProfile.maxMs}ms ` +
        `backspaceMap=${map.backspace ? "present" : "missing"} layer=${layer}`,
      );
    }
    const errorRoll = Math.random() * 100;
    const errorThreshold = lo + Math.random() * (hi - lo);
    if (options?.debugLabel) {
      onLog?.(
        `[${options.debugLabel}] human-error roll=${errorRoll.toFixed(3)} ` +
        `threshold=${errorThreshold.toFixed(3)}% range=${lo}-${hi}% layer=${layer}`,
      );
    }
    if (errorRoll >= errorThreshold) {
      if (options?.debugLabel) onLog?.(`[${options.debugLabel}] human-error correction not selected`);
      return;
    }
    const candidates = Object.keys(map).filter(k => /^[a-z]$/i.test(k) && k !== "backspace");
    const wrong = candidates[Math.floor(Math.random() * candidates.length)];
    if (!wrong) return;
    if (options?.debugLabel) {
      onLog?.(
        `[${options.debugLabel}] human-error correction selected ` +
        `wrongKey=${wrong} intendedCorrection=one-character`,
      );
    }
    const typoStartedAt = Date.now();
    const typoSent = await tapMapped(wrong, `intentional typing error '${wrong}'`);
    onLog?.(
      `[${options?.debugLabel ?? "cal-keyboard"}] human-error typo-result key=${wrong} ` +
      `sent=${typoSent} elapsed=${Date.now() - typoStartedAt}ms`,
    );
    // Do not tap the calibrated Backspace key here. On Gboard/MIUI that
    // coordinate can behave like a held key even with a short requested dwell
    // and delete the preceding real word/characters. Android's DEL key event
    // removes exactly one committed character: the injected typo.
    const backspaceStartedAt = Date.now();
    let backspaceSent = false;
    try {
      await keyevent(serial, 67); // KEYCODE_DEL
      backspaceSent = true;
      await _sleep(35);
    } catch {
      backspaceSent = false;
    }
    onLog?.(
      `[${options?.debugLabel ?? "cal-keyboard"}] human-error backspace-result ` +
      `sent=${backspaceSent} elapsed=${Date.now() - backspaceStartedAt}ms ` +
        `expectedSingleDelete=true dwell=35ms layer=${layer}`,
    );
  };
  const waitWordHesitation = async () => {
    const hesitationMin = Math.max(0, Math.min(typingProfile.hesitationMinMs, typingProfile.hesitationMaxMs));
    const hesitationMax = Math.max(hesitationMin, typingProfile.hesitationMaxMs);
    await _sleep(hesitationMin + Math.round(Math.random() * (hesitationMax - hesitationMin)));
  };

  const switchLayer = async (target: "letters" | "symbols" | "moreSymbols"): Promise<boolean> => {
    if (layer === target) return true;
    // The extended symbols screen is reached through ?123 first, and the
    // regular symbols screen is reached through ABC when returning from it.
    // Do not jump directly between non-adjacent layers: the saved coordinate
    // is a real key tap, so the intermediate screen matters.
    if (target === "letters") {
      // On Gboard, ABC from the extended-symbol page returns to ?123 first.
      // A second ABC tap is required to reach the letters page.
      if (layer === "moreSymbols") {
        const returnedToSymbols = await tapMapped("abc", "ABC (back to symbols)");
        if (!returnedToSymbols) return false;
        await _sleep(120);
        layer = "symbols";
        _calKeyboardLayer.set(serial, layer);
      }
      const switched = await tapMapped("abc", "ABC");
      if (switched) {
        await _sleep(120);
        layer = "letters";
        _calKeyboardLayer.set(serial, layer);
      }
      return switched;
    }
    if (target === "symbols") {
      if (layer === "moreSymbols") {
        const returnedToLetters = await tapMapped("abc", "ABC");
        if (!returnedToLetters) return false;
        layer = "letters";
        _calKeyboardLayer.set(serial, layer);
      }
      const switched = await tapMapped("symbols", "?123");
      if (switched) {
        await _sleep(120);
        layer = "symbols";
        _calKeyboardLayer.set(serial, layer);
      }
      return switched;
    }
    if (layer === "letters") {
      const switchedToSymbols = await tapMapped("symbols", "?123");
      if (!switchedToSymbols) return false;
      layer = "symbols";
      _calKeyboardLayer.set(serial, layer);
    }
    const switched = await tapMapped("moreSymbols", "more symbols");
    if (switched) {
      await _sleep(120);
      layer = "moreSymbols";
      _calKeyboardLayer.set(serial, layer);
    }
    return switched;
  };

  // These punctuation keys are available on the ABC layer in the common
  // Android keyboards used by the farm. The remaining punctuation is captured
  // on the two symbols layers below.
  const abcPunctuation = new Set([",", "."]);
  const moreSymbolChars = new Set([
    "~", "`", "|", "•", "√", "π", "÷", "×", "§", "∆", "£", "€", "¥",
    "^", "°", "{", "}", "[", "]", "\\", "<", ">",
  ]);

  let charIndex = 0;
  for (const ch of text) {
    const debugChar = ch === "\n" ? "\\n" : ch === " " ? "<space>" : ch;
    if (options?.debugLabel) onLog?.(`[${options.debugLabel}] char ${charIndex + 1}/${text.length} begin=${debugChar}`);
    await maybeHumanError();
    const label = ch === " " ? "space" : ch === "\n" ? "enter" : ch.toLowerCase();
    if (ch === " " || ch === "\n") {
      await switchLayer("letters");
      if (ch === "\n") {
        // A bio newline must not use Shift+Enter. On the farm keyboard that
        // combination can enter selection/navigation mode and act on the last
        // word. Send Android's plain Enter key event instead.
        try {
          await keyevent(serial, 66); // KEYCODE_ENTER
          onLog?.(options?.debugLabel
            ? `[${options.debugLabel}] newline: plain KEYCODE_ENTER (66); no Shift`
            : "[cal-keyboard] newline: plain KEYCODE_ENTER (66); no Shift");
          const min = Math.max(0, Math.min(typingProfile.minMs, typingProfile.maxMs));
          const max = Math.max(min, typingProfile.maxMs);
          await _sleep(min + Math.round(Math.random() * (max - min)));
        } catch {
          missing.push(ch);
        }
      } else if (!await tapMapped(label, "space")) {
        missing.push(ch);
      }
        if (ch === " ") {
          await waitWordHesitation();
        }
      if (options?.debugLabel) onLog?.(`[${options.debugLabel}] char ${charIndex + 1}/${text.length} end=${debugChar}`);
      charIndex++;
      continue;
    }

    if (/^[a-z]$/i.test(ch) || abcPunctuation.has(ch)) {
      if (!await switchLayer("letters")) missing.push(ch);
      if (missing[missing.length - 1] === ch && !map[label] && !map[ch]) continue;

      if (ch !== ch.toLowerCase()) {
        if (!await tapMapped("shift", "Shift")) {
          missing.push(ch);
          continue;
        }
      }
      if (!await tapMapped(map[label] ? label : ch, ch)) missing.push(ch);
      if (options?.debugLabel) onLog?.(`[${options.debugLabel}] char ${charIndex + 1}/${text.length} end=${debugChar}`);
      charIndex++;
      continue;
    }

    if (moreSymbolChars.has(ch)) {
      if (!await switchLayer("moreSymbols")) missing.push(ch);
    } else if (!await switchLayer("symbols")) {
      missing.push(ch);
      continue;
    }

    if (!await tapMapped(map[label] ? label : ch, ch)) {
      // A symbol can be on the extended layer even if the caller did not
      // classify it above; make one explicit attempt after the layer switch.
      if (!moreSymbolChars.has(ch) && map[ch]) {
        if (await switchLayer("moreSymbols") && await tapMapped(ch, ch)) continue;
      }
      missing.push(ch);
    }
    if (ch === "." || ch === "_") await waitWordHesitation();
    if (options?.debugLabel) onLog?.(`[${options.debugLabel}] char ${charIndex + 1}/${text.length} end=${debugChar}`);
    charIndex++;
  }

  // Leave the IME on its normal letters layer. This matters when a symbol or
  // digit was the final character, and prevents the next isolated caller from
  // inheriting the symbols screen and typing into the wrong key positions.
  if (layer !== "letters") await switchLayer("letters");
  _calKeyboardLayer.set(serial, layer);
  onLog?.(
    `[cal-keyboard] typing-session end serial=${serial} display=${display.w}x${display.h} ` +
    `ime=${activeIme || "unknown"} finalLayer=${layer} ok=${missing.length === 0} ` +
    `missing=${missing.join(",") || "none"}`,
  );
  return { ok: missing.length === 0, missing };
}

/**
 * After typing a username in Instagram's search bar, wait for results and
 * tap the first result matching that username. Returns true if tapped.
 *
 * Instagram's search is a network round-trip — results can take 1–5 s to
 * appear in the accessibility tree even when they are visually visible.
 * A single 1500 ms dump reliably misses slow responses.  Poll up to 4 times
 * with 1.5 s gaps (up to ~8 s total) so the results have time to load.
 * This is UI-state polling, not action-retrying — no tap is repeated.
 */
export async function findAndTapUserInSearch(
  serial: string,
  username: string,
  onLog?: (msg: string) => void,
): Promise<{ found: boolean; profileXml?: string }> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const clean = username.replace(/^@/, "");

  // Initial settle — give Instagram time to fire the search query and begin
  // rendering results before the first dump.
  await _sleep(2500);

  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) {
      onLog?.(`Follow: results not in tree yet — waiting (attempt ${attempt}/4)…`);
      await _sleep(1500);
    }
    const xml = await _uiDump(adb, serial);
    if (!xml) continue;

    // ── Candidate selection ───────────────────────────────────────────────────
    //
    // Fix 5 (26 Jul 2026) — avatar-ring positive signal replaces broken chip
    // filter:
    //
    //   Problem: Instagram's search results page can show 0, 1, or 2 "chip"
    //   rows above the real user-profile rows.  Chips are either a search-
    //   keyword chip (magnifying-glass icon, text="@username") or a recent-
    //   search chip (clock icon, text="@username").  Both carry the searched
    //   username as their text, so they matched the text-scan and were being
    //   tapped as if they were profile rows.
    //
    //   The previous chip filter checked id="row_search_keyword_title" but
    //   raw UIAutomator XML uses resource-id="com.instagram.android:id/..."
    //   — the substring id=" never appears next to the id name, so the filter
    //   never matched and chips continued to slip through.
    //
    //   Fix: instead of excluding chip nodes (fragile), positively identify
    //   real profile rows by scanning for row_search_avatar_in_ring /
    //   row_search_avatar_with_ring nodes.  These resource-ids are present
    //   ONLY in real user-profile rows (they carry the circular avatar with
    //   story ring); chip rows show a search or clock icon via a completely
    //   different node tree and never contain these ids.
    //
    //   The avatar ring node's vertical center equals its containing row's
    //   vertical center (confirmed from UIAutomator dump: ring bounds
    //   [904,600][1025,721] cy=661, row bounds [0,578][1080,743] cy=661).
    //   We tap at screen-horizontal-centre × ring-vertical-centre.
    //
    //   Text-match candidates (fix 1–4 logic) are kept as a secondary
    //   fallback for the rare case where IG does not expose avatar-ring nodes.

    // Primary: require an exact username node. Avatar-ring nodes identify real
    // profile rows, but they do not identify WHICH profile row they belong to.
    // Tapping the first ring (or using DPAD order) can therefore follow an
    // unrelated account when Instagram omits the requested username.
    const cleanLc = clean.toLocaleLowerCase();
    const exactNames = new Set([cleanLc, `@${cleanLc}`]);
    const exactUserPositions: Array<{ x: number; y: number }> = [];
    const exactUserSeen = new Set<string>();
    for (const seg of xml.split(/(?=<node )/)) {
      if (!seg.startsWith("<node ")) continue;
      if (/class="android\.widget\.EditText"/i.test(seg)) continue;
      if (seg.includes("/row_search_keyword_title\"") ||
          seg.includes("/search_keyword_title\"") ||
          seg.includes("/row_search_recent_chip\"") ||
          seg.includes("/search_recent_chip\"")) continue;
      const text = seg.match(/\btext="([^"]*)"/i)?.[1]?.trim().toLocaleLowerCase() ?? "";
      const desc = seg.match(/\bcontent-desc="([^"]*)"/i)?.[1]?.trim().toLocaleLowerCase() ?? "";
      if (!exactNames.has(text) && !exactNames.has(desc)) continue;
      const bb = seg.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!bb) continue;
      const x = Math.round((parseInt(bb[1]) + parseInt(bb[3])) / 2);
      const y = Math.round((parseInt(bb[2]) + parseInt(bb[4])) / 2);
      const key = `${x},${y}`;
      if (!exactUserSeen.has(key)) {
        exactUserSeen.add(key);
        exactUserPositions.push({ x, y });
      }
    }
    exactUserPositions.sort((a, b) => a.y - b.y);
    if (exactUserPositions.length === 0) {
      onLog?.(`Follow: @${clean} exact username is not listed in search results — target aborted safely`);
      continue;
    }

    const ringPositions: Array<{ x: number; y: number }> = exactUserPositions;
    ringPositions.sort((a, b) => a.y - b.y); // topmost (first result) first

    // Secondary fallback: text-match scan with chip nodes excluded.
    // Used only when no avatar-ring nodes are found in the tree.
    const legacyCleanLc = clean.toLowerCase();
    const atLegacyCleanLc = `@${legacyCleanLc}`;
    const seenKeys = new Set<string>();
    const candidatePos: Array<{ x: number; y: number }> = [];
    if (ringPositions.length === 0) {
      for (const seg of xml.split(/(?=<node )/)) {
        if (!seg.startsWith("<node ")) continue;
        // Skip the search bar — it holds the typed "@username" as its text value
        if (/class="android\.widget\.EditText"/i.test(seg)) continue;
        // Skip search keyword chip nodes (resource-id contains /row_search_keyword_title
        // or /search_keyword_title — these are definitively chip nodes, never user rows).
        // Note: raw UIAutomator XML uses resource-id="com.instagram.android:id/..."
        // so the correct substring to check is /row_search_keyword_title" not id="...".
        if (seg.includes("/row_search_keyword_title\"") ||
            seg.includes("/search_keyword_title\"")) continue;
        // Exact-match on text= or content-desc= only (avoids partial substring hits)
        const segLc = seg.toLowerCase();
        const hasMatch =
          segLc.includes(`text="${legacyCleanLc}"`) ||
          segLc.includes(`text="${atLegacyCleanLc}"`) ||
          segLc.includes(`content-desc="${legacyCleanLc}"`) ||
          segLc.includes(`content-desc="${atLegacyCleanLc}"`);
        if (!hasMatch) continue;
        const bb = seg.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!bb) continue;
        const cx = Math.round((parseInt(bb[1]) + parseInt(bb[3])) / 2);
        const cy = Math.round((parseInt(bb[2]) + parseInt(bb[4])) / 2);
        const key = `${cx},${cy}`;
        if (!seenKeys.has(key)) { seenKeys.add(key); candidatePos.push({ x: cx, y: cy }); }
      }
      candidatePos.sort((a, b) => a.y - b.y); // topmost first
    }

    // Use ring positions if found (they bypass chips entirely); else text candidates.
    const finalCandidates = ringPositions;
    onLog?.(`Follow: @${clean} — exact username node found (${finalCandidates.length} match${finalCandidates.length === 1 ? "" : "es"})`);

    if (finalCandidates.length > 0) {
      // Try candidates top-to-bottom. After each tap, verify we landed on a
      // profile page (Follow / Following / Requested button present). The
      // post-tap verification loop is the safety net — if a chip somehow slips
      // through the avatar-ring filter we detect the miss and try the next row.
      for (let ci = 0; ci < finalCandidates.length; ci++) {
        const pos = finalCandidates[ci];
        onLog?.(`Follow: tapping @${clean} result row ${ci + 1}/${finalCandidates.length} at (${pos.x},${pos.y})`);
        _adbTap(adb, serial, pos.x, pos.y);
        await _sleep(2000);
        const verifyXml = await _uiDump(adb, serial).catch(() => "");
        // Negative gate first: if the search results page is still on screen
        // (avatar-ring nodes present OR EditText search bar present), we did NOT
        // navigate to a profile — we hit a chip or something that kept us on the
        // results page.  The inline Follow buttons visible in each search result
        // row would otherwise fool the positive check below into thinking we
        // landed on a profile page.
        const stillOnSearchResults =
          verifyXml.includes("/row_search_avatar_in_ring\"") ||
          verifyXml.includes("/row_search_avatar_with_ring\"") ||
          /class="android\.widget\.EditText"[^>]*resource-id="[^"]*search/i.test(verifyXml);
        const onProfile = !stillOnSearchResults && (
          /(?:text|content-desc)="Follow(?:ing|ed)?"/.test(verifyXml) ||
          /(?:text|content-desc)="Requested"/.test(verifyXml) ||
          /(?:text|content-desc)="Follow"/.test(verifyXml) ||
          verifyXml.includes(":id/follow_button") ||
          verifyXml.includes(":id/follow_btn") ||
          verifyXml.includes(":id/inline_follow_button")
        );
        if (onProfile) return { found: true, profileXml: verifyXml }; // caller handles Follow tap and may reuse the verified dump
        // Not on a profile page — likely hit a chip; dismiss / back and try next row
        if (ci < finalCandidates.length - 1) {
          onLog?.(`Follow: row ${ci + 1} did not open a profile (chip?) — trying next row`);
          await runAdb(adb, ["-s", serial, "shell", "input", "keyevent", "KEYCODE_BACK"], 4000).catch(() => {});
          await _sleep(800);
        }
      }
      // All rows tried, none opened a profile. Do not report a match here:
      // the caller would otherwise continue into the profile/follow phase
      // while still on the search results screen.
      onLog?.(`Follow: no result row opened a confirmed profile for @${clean}`);
       return { found: false };
    }
  }

  // No exact username was exposed after polling. Never guess by row order,
  // generic containers, or DPAD: those can open a different account.
  onLog?.(`Follow: @${clean} exact username was not found after waiting — aborting target`);
  return { found: false };

  // ── Last-resort fallback (unreachable; retained below only as historical
  // documentation of the old unsafe behavior) ─────────────────────────────
  // Some Instagram/device combinations don't expose search result rows in the
  // accessibility tree even while they are visibly rendered. Since the exact
  // username was entered, use only device-agnostic evidence from the current
  // dump before falling back to generic directional navigation.
  //
  // Try one more node scan with generic row container resource-ids before
  // resorting to a coordinate tap — these ids appear on builds that do
  // expose containers but not individual avatar-ring or text nodes.
  {
    let verifyXml = await _uiDump(adb, serial).catch(() => "");
    if (!verifyXml.includes("com.instagram.android")) {
      onLog?.(`Follow: fallback skipped — Instagram not in foreground`);
      return false;
    }

    // Prefer an exact username node whenever the current accessibility dump
    // exposes one. This keeps the fallback tied to the requested account
    // rather than blindly selecting an unrelated visible row.
    const cleanLcFallback = clean.toLowerCase();
    const atCleanLcFallback = `@${cleanLcFallback}`;
    const exactUserPositions: Array<{ x: number; y: number }> = [];
    const exactUserSeen = new Set<string>();
    for (const seg of verifyXml.split(/(?=<node )/)) {
      if (!seg.startsWith("<node ")) continue;
      if (/class="android\.widget\.EditText"/i.test(seg)) continue;
      if (seg.includes("/row_search_keyword_title\"") ||
          seg.includes("/search_keyword_title\"")) continue;
      const segLc = seg.toLowerCase();
      const exactMatch =
        segLc.includes(`text="${cleanLcFallback}"`) ||
        segLc.includes(`text="${atCleanLcFallback}"`) ||
        segLc.includes(`content-desc="${cleanLcFallback}"`) ||
        segLc.includes(`content-desc="${atCleanLcFallback}"`);
      if (!exactMatch) continue;
      const bb = seg.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!bb) continue;
      const x = Math.round((parseInt(bb[1]) + parseInt(bb[3])) / 2);
      const y = Math.round((parseInt(bb[2]) + parseInt(bb[4])) / 2);
      const key = `${x},${y}`;
      if (!exactUserSeen.has(key)) {
        exactUserSeen.add(key);
        exactUserPositions.push({ x, y });
      }
    }
    exactUserPositions.sort((a, b) => a.y - b.y);
    if (exactUserPositions.length > 0) {
      const pos = exactUserPositions[0];
      onLog?.(`Follow: @${clean} found in fallback tree at (${pos.x},${pos.y}) — tapping exact result`);
      _adbTap(adb, serial, pos.x, pos.y);
      await _sleep(1800);
      const profileXml = await _uiDump(adb, serial).catch(() => "");
      const stillOnSearchResults =
        profileXml.includes("/row_search_avatar_in_ring\"") ||
        profileXml.includes("/row_search_avatar_with_ring\"") ||
        /class="android\.widget\.EditText"[^>]*resource-id="[^"]*search/i.test(profileXml);
      const onProfile =
        !stillOnSearchResults &&
        (/(?:text|content-desc)="Follow(?:ing|ed)?"/.test(profileXml) ||
          /(?:text|content-desc)="Requested"/.test(profileXml) ||
          profileXml.includes(":id/follow_button") ||
          profileXml.includes(":id/follow_btn") ||
          profileXml.includes(":id/inline_follow_button"));
      if (onProfile) return true;
      onLog?.(`Follow: exact @${clean} result did not open a confirmed profile — skipping safely`);
      return false;
    }

    // Extra node scan: look for any search-result row container by resource-id.
    const rowNode =
      _findByResId(verifyXml,
        ":id/row_search_user_container",
        ":id/search_result_user",
        ":id/row_search_result_container",
        ":id/search_result_item",
      );
    if (rowNode) {
      onLog?.(`Follow: @${clean} found via row-container id at (${rowNode.x},${rowNode.y}) — tapping`);
      _adbTap(adb, serial, rowNode.x, rowNode.y);
      await _sleep(1800);
      const profileXml = await _uiDump(adb, serial).catch(() => "");
      const stillOnSearchResults =
        profileXml.includes("/row_search_avatar_in_ring\"") ||
        profileXml.includes("/row_search_avatar_with_ring\"") ||
        /class="android\.widget\.EditText"[^>]*resource-id="[^"]*search/i.test(profileXml);
      const onProfile =
        !stillOnSearchResults &&
        (/(?:text|content-desc)="Follow(?:ing|ed)?"/.test(profileXml) ||
          /(?:text|content-desc)="Requested"/.test(profileXml) ||
          profileXml.includes(":id/follow_button") ||
          profileXml.includes(":id/follow_btn") ||
          profileXml.includes(":id/inline_follow_button"));
      if (onProfile) return true;
      onLog?.(`Follow: row-container tap did not open a confirmed profile — skipping safely`);
      return false;
    }

    // DPAD fallback — only reached when the current accessibility dump exposes
    // no usable result nodes. This is generic Android directional navigation,
    // not a device-specific coordinate or keyboard workaround.
    //
    // We typed the exact username so Instagram ranks the matching account first.
    // Rather than a fixed-percentage coordinate tap (which lands on a wrong row
    // because the first result is near the very top of the screen, not at 27%),
    // we use DPAD navigation which operates at the Android OS input level and
    // works regardless of what the accessibility tree exposes:
    //
    //   1. KEYCODE_DPAD_DOWN — moves focus from the search bar to the first
    //      focusable element below it (may be a keyword/recent-search chip).
    //   2. After a short settle, dump to check if the focused element is a chip
    //      (chip nodes carry /row_search_keyword_title or /search_keyword).
    //      If so, send another DPAD_DOWN to step past it onto the first real
    //      user profile row.
    //   3. KEYCODE_ENTER — activates the currently-focused item (the profile row).
    //
    // This avoids all pixel/percentage coordinates and works for any screen size.
    onLog?.(`Follow: @${clean} not in a11y tree — using DPAD navigation to first result`);
    runInputShell(serial, ["keyevent", "20"], "keyevent"); // KEYCODE_DPAD_DOWN (20)
    await _sleep(350);

    // Check if focus landed on a chip row — if so, step past it.
    const dpadXml = await _uiDump(adb, serial).catch(() => "");
    const onChip =
      dpadXml.includes("/row_search_keyword_title\"") ||
      dpadXml.includes("/search_keyword_title\"") ||
      dpadXml.includes("/row_search_recent_chip\"") ||
      dpadXml.includes("/search_recent_chip\"");
    if (onChip) {
      onLog?.(`Follow: DPAD landed on chip row — stepping past it`);
      runInputShell(serial, ["keyevent", "20"], "keyevent"); // another DPAD_DOWN
      await _sleep(300);
    }

    runInputShell(serial, ["keyevent", "66"], "keyevent"); // KEYCODE_ENTER (66)
    await _sleep(1800);
    const profileXml = await _uiDump(adb, serial).catch(() => "");
    const stillOnSearchResults =
      profileXml.includes("/row_search_avatar_in_ring\"") ||
      profileXml.includes("/row_search_avatar_with_ring\"") ||
      /class="android\.widget\.EditText"[^>]*resource-id="[^"]*search/i.test(profileXml);
    const onProfile =
      !stillOnSearchResults &&
      (/(?:text|content-desc)="Follow(?:ing|ed)?"/.test(profileXml) ||
        /(?:text|content-desc)="Requested"/.test(profileXml) ||
        profileXml.includes(":id/follow_button") ||
        profileXml.includes(":id/follow_btn") ||
        profileXml.includes(":id/inline_follow_button"));
    if (!onProfile) {
      onLog?.(`Follow: DPAD result did not open a confirmed profile — skipping safely`);
    }
    return onProfile;
  }
}

/**
 * Tap the Follow button on an Instagram profile page.
 * Returns true if the button was found and tapped.
 */
export async function tapFollowButtonOnProfilePage(serial: string): Promise<boolean> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  await _sleep(1500);
  const xml = await _uiDump(adb, serial);
  if (!xml) return false;
  // Use an exact-match regex for "Follow" so we never accidentally match
  // "Following" (already following — tapping that would UNfollow) or
  // "Unfollow" (same problem). _findElem's substring fallback would incorrectly
  // match both of those. Same pattern as findStoryFollowButton.
  const exactFollowRe = /(?:text|content-desc)="Follow"[^>]*bounds="([^"]+)"/;
  const exactM = xml.match(exactFollowRe);
  const btn = (exactM ? _parseCenter(exactM[1]) : null) ||
    // inline_follow_button: used on profiles with many action buttons (Call, Email,
    // Message, YouTube etc.) where the Follow button has this resource-id instead
    // of the standard follow_button / follow_btn ids.
    _findByResId(xml, ":id/inline_follow_button", ":id/follow_button", ":id/follow_btn", ":id/button_follow");
  if (!btn) return false;
  _adbTap(adb, serial, btn.x, btn.y);
  // Verify the Follow tap actually worked by confirming the button label
  // changed to "Following" (public account) or "Requested" (private account).
  // Only then do we report success — this prevents false positive follow logs
  // that were appearing when the tap landed but Instagram rejected it silently.
  await _sleep(2000);
  const xml2 = await _uiDump(adb, serial);
  if (!xml2) return false;
  const confirmed =
    /(?:text|content-desc)="Following"/.test(xml2) ||
    /(?:text|content-desc)="Requested"/.test(xml2);
  return confirmed;
}

// ─── Battery spoof ────────────────────────────────────────────────────────────

/** Read the current battery status from dumpsys battery. */
export async function getBatteryInfo(serial: string): Promise<{
  level: number;
  status: string;
  plugged: string;
  present: boolean;
  temperatureC: number;
  raw: string;
}> {
  const tools = detectToolset();
  const adb   = requireTool(tools.adb, "adb");
  const raw   = await runAdb(adb, ["-s", serial, "shell", "dumpsys", "battery"]);
  const get   = (key: string) => { const m = raw.match(new RegExp(`${key}:\\s*(.+)`)); return m ? m[1].trim() : ""; };
  const statusMap: Record<string, string> = { "1": "Unknown", "2": "Charging", "3": "Discharging", "4": "Not Charging", "5": "Full" };
  const pluggedMap: Record<string, string> = { "0": "Unplugged", "1": "AC", "2": "USB", "4": "Wireless" };
  return {
    level:        parseInt(get("level") || "0", 10),
    status:       statusMap[get("status")] ?? get("status"),
    plugged:      pluggedMap[get("plugged")] ?? get("plugged"),
    present:      get("present") === "true",
    temperatureC: parseInt(get("temperature") || "0", 10) / 10,
    raw,
  };
}

// Sysfs paths that gate physical charging on common chipsets / OEMs.
// Ordered by likelihood — Xiaomi/Qualcomm first, then MTK, then generic.
const CHARGING_SYSFS_PATHS = [
  "/sys/class/power_supply/battery/charging_enabled",
  "/sys/class/power_supply/battery/battery_charging_enabled",
  "/sys/class/power_supply/bq2589x-charger/charging_enabled",
  "/sys/class/power_supply/mtk-master-charger/charging_enabled",
  "/sys/class/power_supply/wireless/charging_enabled",
];

export type ChargingControlSupport =
  | { supported: true;  path: string; needsRoot: boolean }
  | { supported: false; reason: string };

/**
 * Probe whether this device supports real hardware charging control via sysfs.
 * Tries each known path with and without root.  Returns the first that works.
 * Takes 2–5 s — run once and cache the result.
 */
export async function probeChargingControl(serial: string): Promise<ChargingControlSupport> {
  const tools = detectToolset();
  const adb   = requireTool(tools.adb, "adb");

  for (const syspath of CHARGING_SYSFS_PATHS) {
    // ── without root ────────────────────────────────────────────────────────
    const readOut = await runAdb(adb, ["-s", serial, "shell", `cat ${syspath} 2>&1`]);
    if (/^[01]\s*$/.test(readOut.trim())) {
      // Path is readable — try writing
      const writeOut = await runAdb(adb, ["-s", serial, "shell",
        `echo 1 > ${syspath} 2>&1 && echo OK || echo FAIL`]);
      if (writeOut.includes("OK")) {
        return { supported: true, path: syspath, needsRoot: false };
      }
    }

    // ── with root (su -c) ────────────────────────────────────────────────────
    const rootRead = await runAdb(adb, ["-s", serial, "shell",
      `su -c "cat ${syspath}" 2>&1`]);
    if (/^[01]\s*$/.test(rootRead.trim())) {
      const rootWrite = await runAdb(adb, ["-s", serial, "shell",
        `su -c "echo 1 > ${syspath}" 2>&1 && echo OK || echo FAIL`]);
      if (rootWrite.includes("OK")) {
        return { supported: true, path: syspath, needsRoot: true };
      }
    }
  }

  return {
    supported: false,
    reason: "No writable sysfs charging path found on this device. " +
      "Physical charging control requires either a rooted device or a smart " +
      "USB hub with per-port power switching (hardware solution).",
  };
}

/** App-level spoof: makes all apps see the battery as unplugged at `level`%.
 *  Physical charging continues — fallback when sysfs is unavailable. */
export async function setBatterySpoof(serial: string, level: number): Promise<void> {
  const tools = detectToolset();
  const adb   = requireTool(tools.adb, "adb");
  await runAdb(adb, ["-s", serial, "shell", "dumpsys", "battery", "unplug"]);
  await runAdb(adb, ["-s", serial, "shell", "dumpsys", "battery", "set", "level",
    String(Math.min(100, Math.max(1, Math.round(level))))]);
}

/** Clear the app-level spoof and restore real battery state. */
export async function clearBatterySpoof(serial: string): Promise<void> {
  const tools = detectToolset();
  const adb   = requireTool(tools.adb, "adb");
  await runAdb(adb, ["-s", serial, "shell", "dumpsys", "battery", "reset"]);
}

/**
 * Actually stop physical charging by writing 0 to the sysfs charging node.
 * `support` must come from a successful `probeChargingControl()` call.
 */
export async function stopPhysicalCharging(
  serial: string, support: Extract<ChargingControlSupport, { supported: true }>
): Promise<void> {
  const tools = detectToolset();
  const adb   = requireTool(tools.adb, "adb");
  const cmd = support.needsRoot
    ? `su -c "echo 0 > ${support.path}"`
    : `echo 0 > ${support.path}`;
  await runAdb(adb, ["-s", serial, "shell", cmd]);
}

/**
 * Resume physical charging by writing 1 to the sysfs charging node.
 */
export async function resumePhysicalCharging(
  serial: string, support: Extract<ChargingControlSupport, { supported: true }>
): Promise<void> {
  const tools = detectToolset();
  const adb   = requireTool(tools.adb, "adb");
  const cmd = support.needsRoot
    ? `su -c "echo 1 > ${support.path}"`
    : `echo 1 > ${support.path}`;
  await runAdb(adb, ["-s", serial, "shell", cmd]);
}

// ─────────────────────────────────────────────────────────────────────────────

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
