import { spawn, spawnSync, execFile, ChildProcess } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import os from "os";
import zlib from "zlib";
import { logger } from "../lib/logger";

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
 * Instagram occasionally shows Meta's EU/UK "ads choice" consent screen on
 * launch ("Make a choice about your ads" → Get started → pick "Use for free
 * with ads" → Continue → Agree). It's a full-screen modal that blocks
 * everything behind it, so if it appears mid-automation-cycle every
 * subsequent scripted tap lands on it instead of the feed and the whole
 * cycle silently does nothing. This walks through it end-to-end if present,
 * and is a no-op (single UI dump, no taps) if the dialog isn't showing.
 */
export async function dismissAdsChoiceDialog(serial: string): Promise<{ dismissed: boolean; steps: string[] }> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const steps: string[] = [];
  let xml = await _uiDump(adb, serial);

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
    _adbTap(adb, serial, pos.x, pos.y);
    steps.push("ads-choice: selected Use for free with ads");
    await _sleep(400); // reduced from 500ms
    xml = await _uiDump(adb, serial);
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
export async function dismissInstagramInterstitials(serial: string): Promise<string | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;

  // Ordered by specificity — more specific labels first so we don't
  // accidentally tap a generic button on a legitimate screen.
  // NOTE: "Cancel" and "OK" are intentionally excluded — they are too
  // generic and will dismiss legitimate compose/picker screens (e.g. the
  // Instagram story/post composer has a Cancel button that, if tapped here,
  // sends the user back to the home feed before any UI scan can run).
  const DISMISS_LABELS = [
    "Not now",
    "Not Now",
    "Skip",
    "Maybe Later",
    "Maybe later",
    "No thanks",
    "No Thanks",
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
    if (pos) {
      _adbTap(adb, serial, pos.x, pos.y);
      await _sleep(600);
      return label;
    }
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
function runInputShell(serial: string, args: string[], label: string): void {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const r = spawnSync(adb, ["-s", serial, "shell", "input", ...args], { encoding: "utf8", timeout: 5000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (r.status !== 0 || r.error || /error|exception|permission denied/i.test(out)) {
    throw new Error(
      `adb shell input ${label} failed (exit=${r.status ?? "spawn-error"})${out ? `: ${out}` : r.error ? `: ${r.error.message}` : ""}`
    );
  }
}

export async function inputText(serial: string, text: string): Promise<void> {
  const escaped = escapeForAdbInput(text);
  runInputShell(serial, ["text", escaped], "text");
}

export async function tap(serial: string, x: number, y: number): Promise<void> {
  runInputShell(serial, ["tap", String(x), String(y)], "tap");
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
 * consistent regardless of adb/USB latency.
 */
export async function doubleTap(serial: string, x: number, y: number): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const cmd = `input tap ${x} ${y}; sleep 0.08; input tap ${x} ${y}`;
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
): Promise<void> {
  runInputShell(
    serial,
    ["swipe", String(x1), String(y1), String(x2), String(y2), String(Math.max(1, Math.round(durationMs)))],
    "swipe",
  );
}

export async function keyevent(serial: string, code: string | number): Promise<void> {
  runInputShell(serial, ["keyevent", String(code)], "keyevent");
}

// ── Automation-cycle lifecycle steps ────────────────────────────────────────
// Real button/gesture actions used to bookend each automation cycle — the
// phone should look like a person picked it up, used Instagram, put it down,
// and (per user instruction) cycled airplane mode before locking it again,
// not like a script silently force-stopping a process in the background.

function getScreenSize(serial: string): { w: number; h: number } {
  let w = 1080, h = 2400;
  try {
    const tools = detectToolset();
    const adb = requireTool(tools.adb, "adb");
    const wm = spawnSync(adb, ["-s", serial, "shell", "wm", "size"], { encoding: "utf8", timeout: 3000 });
    const m = (wm.stdout ?? "").match(/(\d+)x(\d+)/);
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
export async function closeInstagramViaRecents(serial: string, onLog?: (msg: string) => void): Promise<void> {
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
      // Drag fully off the left edge — a short flick isn't enough to
      // register as a dismiss-drag on this launcher; use a slower,
      // longer-distance move (matches "tap, hold, swipe left").
      const dragToX = Math.max(Math.round(w * 0.02), card.x - Math.round(w * 0.5));
      await swipe(serial, card.x, card.y, dragToX, card.y, 400);
      method = `attempt ${attempt}: dragged left-most card at (${card.x},${card.y}) left to (${dragToX},${card.y})`;
    } else {
      // Couldn't find any label at all (e.g. dump failed, or — as observed
      // on this device — the launcher just never exposes card captions) —
      // fall back to a centred left-drag, which is correct for the common
      // single-app case.
      const cardX = Math.round(w * 0.5);
      const cardY = Math.round(h * 0.45);
      await swipe(serial, cardX, cardY, Math.round(w * 0.05), cardY, 400);
      method = `attempt ${attempt}: no label found in recents tree — fell back to centred drag-left (${cardX},${cardY})`;
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
function _findCentermostLikeNode(xml: string): { x: number; y: number } | null {
  // Exact, whole-word "Like" only — content-desc="Unlike" (already-liked
  // posts) must never match, or a jitter tap could accidentally unlike.
  const re = /content-desc="Like"[^>]*bounds="(\[\d+,\d+\]\[\d+,\d+\])"/g;
  const { h } = _getScreenSize(xml);
  const centerY = h / 2;
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const c = _parseCenter(m[1]);
    if (!c) continue;
    const dist = Math.abs(c.y - centerY);
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  return best;
}

export interface FeedActionIcons {
  like: { x: number; y: number };
  comment: { x: number; y: number } | null;
  shareFeed: { x: number; y: number } | null; // repost / share-to-feed (double-arrow icon)
  shareDm: { x: number; y: number } | null;   // send / share-via-DM (paper-plane icon)
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
export async function findFeedActionIcons(serial: string): Promise<FeedActionIcons | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial);
  if (!xml) return null;

  // Use the Like node closest to the screen's vertical centre, not just the
  // first one in document order — RecyclerView recycling can keep an
  // adjacent post's (or a Reel/reply-bar card's) Like node alive in the
  // hierarchy at the same time. Anchoring the row-scan on the wrong post's
  // Like button pulls THAT post's unrelated wide elements (e.g. a Reel's
  // message/reply text field) into rowNodes — see _findCentermostLikeNode.
  const like = _findCentermostLikeNode(xml);
  if (!like) return null;

  // Use the adb-queried screen width, NOT _getScreenSize(xml). The XML-parsed
  // fallback returns w=1600 (landscape desktop) when the root bounds attribute
  // is absent. That sets saveCutoffX = 1280 — well above the bookmark icon's
  // real X position (~950 px on a 1080 px phone), so the bookmark is NOT
  // excluded from rowNodes. It then appears as a 4th entry, rowNodes.length
  // equals 4 instead of 3, the if-branch is skipped, and the ambiguous else
  // branch leaves shareFeed/shareDm null even when both icons are plainly
  // visible. getScreenSize(serial) uses `adb shell wm size` and defaults to
  // 1080 px on error; 0.80 × 1080 = 864, which correctly sits LEFT of the
  // bookmark at ~950 px → bookmark excluded → rowNodes.length = 3 → icons found.
  const { w } = getScreenSize(serial);
  const rowTolerance = 20;
  const saveCutoffX = Math.round(w * 0.80);
  // Instagram's Comment/Repost/Send icons are small square glyphs (roughly
  // the same width as the Like heart). A message/reply compose field (the
  // quick-reaction bar Instagram shows under a Reel/repost card in-feed)
  // is `clickable="true"` too and can land on the same row by coincidence,
  // but it's much wider than a single icon — cap accepted width generously
  // above the Like button's own width so real icons always pass while a
  // full-width text field never does.
  const maxIconWidth = Math.max(120, Math.round(w * 0.12));

  type RowNode = { x: number; y: number; cd: string };
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
    if (c.x <= like.x + 4) continue; // Like itself, or anything left of it
    const cdM = attrs.match(/content-desc="([^"]*)"/);
    const cd = cdM ? cdM[1] : "";
    if (/favorit|save/i.test(cd)) continue; // bookmark, labeled
    if (c.x > saveCutoffX) continue; // bookmark, unlabeled — far-right heuristic
    const clsM = attrs.match(/class="([^"]*)"/);
    const cls = clsM ? clsM[1] : "";
    const txtM = attrs.match(/\btext="([^"]*)"/);
    const txt = txtM ? txtM[1] : "";
    if (cls === "android.widget.ImageView" && !cd && !/\d/.test(txt)) {
      // Potential audio disc OR unlabeled Repost/Send — save separately, don't
      // add to rowNodes (keeps the disc-tapping regression fix intact for devices
      // where the disc is present and Repost/Send ARE labeled).
      unlabeledImgViews.push({ x: c.x, y: c.y, cd });
      continue;
    }
    rowNodes.push({ x: c.x, y: c.y, cd });
  }
  rowNodes.sort((a, b) => a.x - b.x);
  unlabeledImgViews.sort((a, b) => a.x - b.x);

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
  const commentNode  = rowNodes.find(n => /\bcomment\b/i.test(n.cd)) ?? null;
  const repostNode   = rowNodes.find(n => /\brepost\b/i.test(n.cd)) ?? null;
  const sendNode     = rowNodes.find(n => /\b(send|direct|message)\b/i.test(n.cd)) ?? null;

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

  // Positional fallback for roles that content-desc did not resolve.
  // Consume nodes left-to-right, skipping those already claimed above.
  // (shareFeed is deliberately excluded — see note above.)
  const claimed = new Set<RowNode>([commentNode, repostNode, sendNode].filter(Boolean) as RowNode[]);
  const pool = () => rowNodes.filter(n => !claimed.has(n));

  if (!comment) {
    const c = pool()[0];
    if (c) { comment = pos(c); claimed.add(c); }
  }
  if (!shareDm) {
    const c = pool()[0];
    if (c) { shareDm = pos(c); claimed.add(c); }
  }

  // --- Unlabeled-ImageView positional fallback (last resort) ---
  //
  // Only fires when shareFeed or shareDm is STILL null after all content-desc
  // and pool fallbacks above, AND unlabeledImgViews has candidates.
  //
  // Safety filter: the audio disc sits immediately to the right of Comment in x
  // (disc.x ≈ comment.x + ~40 px), while Repost and Send sit at comment.x + gap
  // and comment.x + 2×gap (where gap = comment.x − like.x, typically 90–130 px).
  // Requiring a node to be at least 60 % of one icon-gap to the right of Comment
  // reliably excludes the disc while accepting Repost and Send.
  //
  // If both shareFeed and shareDm are still null, assign left→right:
  //   first  unlabeled candidate → shareFeed (Repost position)
  //   second unlabeled candidate → shareDm   (Send position)
  // If only shareDm is null (shareFeed was resolved), use the rightmost
  // remaining candidate (Send is always to the right of Repost).
  if ((!shareFeed || !shareDm) && unlabeledImgViews.length > 0) {
    const iconGap = like && comment ? comment.x - like.x : 0;
    const minX = comment ? comment.x + Math.max(iconGap * 0.6, 30) : like.x + 4;
    const candidates = unlabeledImgViews.filter(n => n.x > minX); // excludes disc
    if (candidates.length > 0) {
      if (!shareFeed && !shareDm) {
        // Assign left-to-right: first = Repost, second = Send
        shareFeed = pos(candidates[0]);
        if (candidates[1]) shareDm = pos(candidates[1]);
      } else if (!shareDm) {
        // shareFeed already resolved — Send is the rightmost remaining candidate
        const rightmost = candidates[candidates.length - 1];
        if (rightmost.x !== shareFeed?.x) shareDm = pos(rightmost);
      } else if (!shareFeed) {
        // shareDm already resolved — Repost is the leftmost candidate not = shareDm
        const c = candidates.find(n => n.x !== shareDm?.x);
        if (c) shareFeed = pos(c);
      }
    }
  }

  return { like, comment, shareFeed, shareDm };
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
 * timeout, corrupt PNG) so callers can fall back to fixed-coordinate taps
 * — this must never throw and break an automation cycle.
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
 * - Label must be ≤ 50 characters (display names, not article titles)
 */
export async function findShareSheetRecipients(serial: string): Promise<{ x: number; y: number }[]> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return [];

  const { w, h } = getScreenSize(serial);
  const minY = Math.round(h * 0.30);
  const maxY = Math.round(h * 0.90);
  const maxWidth = Math.round(w * 0.80);
  const UI_CHROME = /^(send|search|write a message|direct|share|to|message|cancel|ok|close|suggested)$/i;

  const results: { x: number; y: number }[] = [];
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let m: RegExpExecArray | null;

  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    if (!/clickable="true"/.test(attrs)) continue;
    const bm = attrs.match(/bounds="(\[(\d+),(\d+)\]\[(\d+),(\d+)\])"/);
    if (!bm) continue;
    const x1 = Number(bm[2]), y1 = Number(bm[3]), x2 = Number(bm[4]), y2 = Number(bm[5]);
    const cx = Math.round((x1 + x2) / 2);
    const cy = Math.round((y1 + y2) / 2);
    if (cy < minY || cy > maxY) continue;
    if ((x2 - x1) > maxWidth) continue;
    const textM = attrs.match(/\btext="([^"]*)"/);
    const cdM = attrs.match(/content-desc="([^"]*)"/);
    const label = (textM?.[1] || cdM?.[1] || "").trim();
    if (!label || label.length > 50) continue;
    if (UI_CHROME.test(label)) continue;
    results.push({ x: cx, y: cy });
  }
  return results;
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
export async function isFeedbackOrSurveyCard(serial: string): Promise<boolean> {
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
  ];
  return MARKERS.some(m => xml.includes(m));
}

/**
 * Find Instagram's top-left "+" compose icon on the home feed (opens the
 * create-post sheet). No existing selector in this codebase targets it —
 * unlike Home/Follow/etc. this is a NEW, unverified finder written blind
 * (no ADB device attached in this sandbox); it will likely need real-device
 * correction. Two strategies, tried in order:
 *  1. content-desc / resource-id guesses ("New post" is the current
 *     Instagram accessibility label for this icon on most builds).
 *  2. Positional fallback: the leftmost clickable node inside the top
 *     header band (y < 8% of screen height, x < 20% of screen width) —
 *     mirrors the band-based heuristics used by findFeedActionIcons/
 *     findHomeTab elsewhere in this file rather than a single hardcoded
 *     coordinate, so it has a chance of surviving small layout shifts.
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
  const byResId = _findByResId(xml, ":id/action_bar_add_button", ":id/create_mode_tab", ":id/camera_icon_button");
  if (byResId) return byResId;

  // Positional fallback: Instagram's compose "+" lives in the TOP-RIGHT of
  // the home-feed header bar, alongside the notifications and DM icons.
  // Header icon order (left → right): [compose +] [notifications ❤] [DM ✈]
  // We want the LEFTMOST node in the right cluster — that is compose "+".
  // (The rightmost is DM; picking rightmost is the wrong approach here.)
  //
  // Search band: top 15% of screen height, right 50% of screen width.
  // y < 8% was too tight and missed the header on some Xiaomi layouts.
  // clickable="true" is intentionally not required — on some Android/MIUI
  // builds the individual icon ImageView nodes are not marked clickable even
  // though they respond to tap; only the parent FrameLayout is. We pick
  // by centre-coordinate and let the tap land on the correct icon.
  const { w, h } = getScreenSize(serial);
  const maxY = Math.round(h * 0.15);
  const minX = Math.round(w * 0.50);
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let best: { x: number; y: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    const bm = attrs.match(/bounds="(\[(\d+),(\d+)\]\[(\d+),(\d+)\])"/);
    if (!bm) continue;
    const c = _parseCenter(bm[1]);
    if (!c) continue;
    if (c.y > maxY || c.x < minX) continue;
    // Pick the LEFTMOST node in the right cluster — that's compose "+".
    // DM (rightmost) and notifications (middle) are further right.
    if (!best || c.x < best.x) best = c;
  }
  return best;
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
 * first, falling back to a positional heuristic (small square clickable
 * icon in the lower-left area of the preview, above the Recents grid).
 */
export async function findExpandPhotoButton(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial).catch(() => "");
  if (!xml) return null;

  const byLabel = _findElem(xml, "Expand", "Zoom out", "Photo size", "Original size", "Toggle photo size");
  if (byLabel) return byLabel;
  const byResId = _findByResId(xml, ":id/expand_photo_button", ":id/original_media_full_size_toggle_button", ":id/media_size_toggle");
  if (byResId) return byResId;

  // Positional fallback: the icon is a small square (roughly 60-140px on a
  // 1080-wide device), sitting in the bottom-left of the preview image —
  // which itself occupies roughly the top 35-55% of the screen, above the
  // Recents label/grid. Scan for a small square clickable node with no
  // text/content-desc label inside that band.
  const { w, h } = getScreenSize(serial);
  const minY = Math.round(h * 0.30);
  const maxY = Math.round(h * 0.58);
  const maxX = Math.round(w * 0.22);
  const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
  let best: { x: number; y: number } | null = null;
  let bestArea = Infinity;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    if (!/clickable="true"/.test(attrs)) continue;
    const textM = attrs.match(/\btext="([^"]*)"/);
    const cdM = attrs.match(/content-desc="([^"]*)"/);
    if ((textM?.[1] || "").trim() || (cdM?.[1] || "").trim()) continue; // icon-only, no label
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
 * Positional fallback for the blue "Next" control on Instagram's very first
 * New Post screen (the photo-select/Recents grid).
 *
 * Root cause (confirmed via the in-app "Scan Screen Layout" tool, real
 * device, 2026-07-13): on this specific screen the top app bar (X / "New
 * post" title / Next) is rendered as an opaque view with NO decomposed
 * accessibility children at all — the layout scan came back with zero
 * elements in the entire top 33% of the screen. findButtonByLabel() /
 * _findElem() search the accessibility tree for a text/content-desc match,
 * so on this screen they have nothing to find; "Next" simply isn't exposed
 * as a labelled node. (Later screens — filter, edit, caption — do expose
 * "Next"/"Share" normally; only this first screen's bar is opaque.)
 *
 * Since there is no reliable accessibility signal here, fall back to a
 * fixed fraction of the screen: "Next" sits in the top app bar, right-aligned,
 * a little below the very top edge. Caller MUST verify the tap actually
 * advanced the screen (accessibility tree changes) since this is a blind
 * coordinate tap with no positive confirmation of its own.
 */
export function postNextButtonPositionalFallback(serial: string): { x: number; y: number } {
  const { w, h } = getScreenSize(serial);
  return { x: Math.round(w * 0.92), y: Math.round(h * 0.035) };
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
  // Prefer an exact/prefix content-desc match anchored to word start so we
  // don't accidentally match some unrelated "Home..." text elsewhere on
  // screen (e.g. a post caption). resource-id fallback covers builds where
  // content-desc isn't set.
  const re = /content-desc="Home[^"]*"[^>]*bounds="([^"]+)"/;
  const m = xml.match(re);
  if (m) return _parseCenter(m[1]);
  return _findByResId(xml, ":id/feed_tab", ":id/home_tab");
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
    if (xml && xml.includes("</hierarchy>")) return xml;
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

/** Find an element by partial resource-id match (e.g. "fab", "hostname"). */
function _findByResId(xml: string, ...ids: string[]): { x: number; y: number } | null {
  for (const id of ids) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`resource-id="[^"]*${esc}[^"]*"[^>]*bounds="([^"]+)"`, "i");
    const m = xml.match(re);
    if (m) { const c = _parseCenter(m[1]); if (c) return c; }
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
  const m = xml.match(/bounds="\[0,0\]\[(\d+),(\d+)\]"/);
  return m ? { w: +m[1], h: +m[2] } : { w: 1600, h: 900 };
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
  const byId = _findByResId(xml,
    ":id/profile", ":id/tab_profile", ":id/nav_profile",
    ":id/bottom_tab_profile", ":id/avatar_tab");
  if (byId) return byId;
  return _findElem(xml, "Profile");
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
 */
export async function findInstagramSearchTab(serial: string): Promise<{ x: number; y: number } | null> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const xml = await _uiDump(adb, serial);
  if (!xml) return null;
  const byId = _findByResId(xml, ":id/search", ":id/tab_search", ":id/nav_search", ":id/bottom_tab_search");
  if (byId) return byId;
  return _findElem(xml, "Search", "Explore");
}

/**
 * Find the Instagram search input bar (after tapping the Search tab).
 * Returns the tap coordinates or null if not found.
 *
 * Fixed: the old 30%-height limit and the unconstrained `_findElem` fallback
 * could match elements deep in the Explore grid (causing a tap below the bar
 * that looked like a swipe/pull-to-refresh).  Now strictly constrained to the
 * top 15 % of the screen with retries so the Explore page has time to settle.
 */
export async function findInstagramSearchBar(
  serial: string,
  onLog?: (msg: string) => void,
): Promise<{ x: number; y: number }> {
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
  const { w: screenW, h: screenH } = getScreenSize(serial);

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await _sleep(800);
    const xml = await _uiDump(adb, serial);
    if (!xml) continue;

    // 30 % gives up to 720 px on a 2400 px screen — comfortably above the
    // search bar while still safely below any Explore-grid content.
    const topLimit = Math.round(screenH * 0.30);

    // 1. Known resource IDs — most reliable; trust them regardless of y-pos
    const byId = _findByResId(xml,
      ":id/action_bar_search_edit_text", ":id/search_bar_input",
      ":id/search_bar", ":id/search_input", ":id/search_field",
      ":id/search_bar_container");
    if (byId) return byId;

    // 2. Any EditText in the top 30%
    const etRe = /class="android\.widget\.EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/gi;
    let m: RegExpExecArray | null;
    while ((m = etRe.exec(xml)) !== null) {
      const centerY = (Number(m[2]) + Number(m[4])) / 2;
      if (centerY > topLimit) continue;
      return { x: Math.round((Number(m[1]) + Number(m[3])) / 2), y: Math.round(centerY) };
    }

    // 3. Clickable "Search" element in the top 30%
    //    (Explore-page pre-tap state — the bar is a View/FrameLayout, not yet an
    //    EditText, until the user taps it the first time)
    for (const re2 of [
      /<node[^>]*\b(?:text|content-desc)="(?:Search|Search Instagram)"[^>]*\bclickable="true"[^>]*\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^/]*\/>/gi,
      /<node[^>]*\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*\bclickable="true"[^>]*\b(?:text|content-desc)="(?:Search|Search Instagram)"[^/]*\/>/gi,
    ]) {
      while ((m = re2.exec(xml)) !== null) {
        const centerY = (Number(m[2]) + Number(m[4])) / 2;
        if (centerY > topLimit) continue;
        return { x: Math.round((Number(m[1]) + Number(m[3])) / 2), y: Math.round(centerY) };
      }
    }
    // attempt loop continues — wait and re-dump
  }

  // Positional fallback — Instagram's Explore search bar does not appear in the
  // UIAutomator accessibility tree on some device/app combinations (the Scan
  // Screen Layout tool confirms 0 elements in the TOP zone even when the bar is
  // visually present).  The bar is always at the very top of the Explore page,
  // centred horizontally, sitting at ~3.8 % of screen height (~85 px on a
  // 2226 px device).  Since the caller has already navigated to the Search tab
  // and waited for the page to settle, tapping this position is safe.
  const fallbackY = Math.round(screenH * 0.038);
  const fallbackX = Math.round(screenW / 2);
  onLog?.(`Follow: search bar not in a11y tree — using positional fallback (${fallbackX}, ${fallbackY})`);
  return { x: fallbackX, y: fallbackY };
}

/**
 * Type text on the on-screen keyboard character by character.
 *
 * FIX for the "danny → fsnny" coordinate-offset bug: instead of calculating
 * key positions from hardcoded or formula-derived x/y values (which drift
 * with DPI, key width, and per-row indentation), this function dumps the
 * accessibility tree once per keyboard layer, finds each key's bounds from
 * the actual XML, and taps the exact centre of the found element.
 *
 * For the '@' symbol (which lives on the symbol/numeric keyboard layer) it
 * switches layers via the '?123' key, taps '@', then switches back to ABC.
 *
 * Precondition: the target text field must already be focused (keyboard
 * must be visible on screen) before this function is called.
 */
export async function typeViaOnscreenKeyboard(
  serial: string,
  text: string,
  onLog?: (msg: string) => void,
): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");

  let keyMap = new Map<string, { x: number; y: number }>();
  let keyMapMode: "letters" | "symbols" = "letters";

  /** Rebuild the key-position map from the current UIAutomator dump. */
  const refreshKeyMap = async (mode: "letters" | "symbols") => {
    keyMapMode = mode;
    keyMap.clear();
    const xml = await _uiDump(adb, serial);
    if (!xml) return;
    const { h } = _getScreenSize(xml);
    // Keyboard occupies the bottom ~45 % of the screen.
    const keyboardTopY = Math.round(h * 0.55);
    // Parse every clickable node with 1-3 char label in the keyboard zone.
    // The regex covers both attribute orderings produced by different Android versions.
    const patterns = [
      /<node[^>]*\btext="([^"]{1,3})"[^>]*\bclickable="true"[^>]*\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^/]*\/>/gi,
      /<node[^>]*\bcontent-desc="([^"]{1,3})"[^>]*\bclickable="true"[^>]*\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^/]*\/>/gi,
      /<node[^>]*\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*\bclickable="true"[^>]*\btext="([^"]{1,3})"[^/]*\/>/gi,
      /<node[^>]*\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*\bclickable="true"[^>]*\bcontent-desc="([^"]{1,3})"[^/]*\/>/gi,
    ];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml)) !== null) {
        // Groups differ by pattern: either (label, x1,y1,x2,y2) or (x1,y1,x2,y2,label)
        let label: string, x1: string, y1: string, x2: string, y2: string;
        if (m.length === 6) {
          if (patterns.indexOf(re) < 2) {
            [, label, x1, y1, x2, y2] = m;
          } else {
            [, x1, y1, x2, y2, label] = m;
          }
        } else continue;
        const centerY = (Number(y1) + Number(y2)) / 2;
        if (centerY < keyboardTopY) continue;
        const key = label.trim();
        if (!key || key.length > 3) continue;
        const cx = Math.round((Number(x1) + Number(x2)) / 2);
        const cy = Math.round(centerY);
        if (!keyMap.has(key)) keyMap.set(key, { x: cx, y: cy });
      }
    }
    onLog?.(`[keyboard] ${mode}: ${keyMap.size} keys mapped`);
  };

  const switchToSymbols = async () => {
    if (keyMapMode === "symbols") return;
    const sym = keyMap.get("?123") ?? keyMap.get("123") ?? keyMap.get("!#1") ?? keyMap.get("&=<");
    if (sym) {
      _adbTap(adb, serial, sym.x, sym.y);
    } else {
      // Try a fresh dump for the symbol-switch key
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

  // Verify the keyboard actually opened — a real soft-keyboard has ≥ 20
  // mappable keys.  Fewer means the field wasn't focused yet (the bar tap
  // landed below the field, the Explore page settled late, etc.).
  // Retry up to 2 times with a 1.2 s pause to let the keyboard animate up.
  for (let kbRetry = 0; kbRetry < 2 && keyMap.size < 15; kbRetry++) {
    onLog?.(`[keyboard] only ${keyMap.size} keys — waiting for keyboard… (retry ${kbRetry + 1})`);
    await _sleep(1200);
    await refreshKeyMap("letters");
  }
  if (keyMap.size < 5) {
    // The accessibility dump never surfaced the on-screen keyboard's keys —
    // on some devices/IME builds uiautomator's window walk misses the IME
    // window (or a slow dump gets truncated) even though the keyboard is
    // genuinely visible and focused. Previously this returned here having
    // typed NOTHING, which silently dropped the whole username. Since the
    // field is confirmed focused (that's a precondition of this function),
    // fall back to injecting the text directly via the device's input
    // method instead of aborting — better a real IME-driven type than no
    // type at all. Per-character tap mode remains the default path
    // whenever key positions ARE discoverable, since that's the more
    // human-like gesture this tool is built around.
    onLog?.(`[keyboard] keyboard keys not found in accessibility tree after retries — falling back to IME text injection for the whole string`);
    _adbType(adb, serial, text);
    return;
  }

  for (const ch of text) {
    if (ch === "@") {
      await switchToSymbols();
      const atKey = keyMap.get("@");
      if (atKey) {
        _adbTap(adb, serial, atKey.x, atKey.y);
        onLog?.(`[keyboard] tapped @ at (${atKey.x},${atKey.y})`);
      } else {
        _adbType(adb, serial, "@");
        onLog?.(`[keyboard] @ not found — used adb input text fallback`);
      }
      await _sleep(200 + Math.round(Math.random() * 100));
      await switchToLetters();
      continue;
    }

    if (ch >= "0" && ch <= "9") {
      await switchToSymbols();
      const numKey = keyMap.get(ch);
      if (numKey) {
        _adbTap(adb, serial, numKey.x, numKey.y);
        onLog?.(`[keyboard] tapped '${ch}' at (${numKey.x},${numKey.y})`);
      } else {
        _adbType(adb, serial, ch);
        onLog?.(`[keyboard] '${ch}' not found — used adb input text fallback`);
      }
      await _sleep(200 + Math.round(Math.random() * 100));
      continue;
    }

    // Letters — ensure letter layer
    if (keyMapMode !== "letters") await switchToLetters();
    const lower = ch.toLowerCase();
    let key = keyMap.get(lower) ?? keyMap.get(ch);
    if (!key) {
      // Refresh once — keyboard may have re-rendered
      await refreshKeyMap("letters");
      key = keyMap.get(lower) ?? keyMap.get(ch);
    }
    if (key) {
      _adbTap(adb, serial, key.x, key.y);
      onLog?.(`[keyboard] tapped '${ch}' at (${key.x},${key.y})`);
    } else {
      _adbType(adb, serial, ch);
      onLog?.(`[keyboard] '${ch}' not found — used adb input text fallback`);
    }
    await _sleep(150 + Math.round(Math.random() * 100));
  }
}

/**
 * After typing a username in Instagram's search bar, wait for results and
 * tap the first result matching that username. Returns true if tapped.
 */
export async function findAndTapUserInSearch(
  serial: string,
  username: string,
): Promise<boolean> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  await _sleep(1500);
  const xml = await _uiDump(adb, serial);
  if (!xml) return false;
  const clean = username.replace(/^@/, "");
  const pos = _findElem(xml, clean, `@${clean}`);
  if (!pos) return false;
  _adbTap(adb, serial, pos.x, pos.y);
  return true;
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
    _findByResId(xml, ":id/follow_button", ":id/follow_btn", ":id/button_follow");
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
