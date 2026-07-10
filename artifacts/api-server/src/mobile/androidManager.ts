import { spawn, spawnSync, execFile, ChildProcess } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import os from "os";
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
 * Closes Instagram the way a person would: open the recent-apps switcher,
 * then swipe its card off the left edge of the screen to dismiss it —
 * deliberately a real gesture rather than `am force-stop`, per user
 * instruction, so the automation cycle behaves like someone actually using
 * the phone rather than a script killing a process in the background.
 */
export async function closeInstagramViaRecents(serial: string): Promise<void> {
  const tools = detectToolset();
  const adb = requireTool(tools.adb, "adb");
  const { w, h } = getScreenSize(serial);
  await openRecentApps(serial);
  await new Promise(r => setTimeout(r, 1200)); // wait for MIUI/OEM overview animation to settle
  // Quick horizontal swipe left — no hold, no long press. The MIUI recents
  // card just needs a simple click-drag a short distance to the left; a hold
  // triggers the long-press context menu instead of dismissing the card.
  const cardX = Math.round(w * 0.5);
  const cardY = Math.round(h * 0.45);
  await swipe(serial, cardX, cardY, Math.round(w * 0.1), cardY, 220);
  await new Promise(r => setTimeout(r, 500));

  // Card-dismiss gestures aren't consistent across OEM launchers/Android
  // versions (some dismiss on a horizontal swipe, some need vertical) — a
  // "closed completely" requirement can't rely on the gesture alone landing
  // right every time. Verify Instagram is no longer a running process and,
  // if the swipe missed, fall back to a clean force-stop so the app is
  // guaranteed closed before the cycle moves on.
  const check = spawnSync(adb, ["-s", serial, "shell", "pidof", "com.instagram.android"], { encoding: "utf8", timeout: 3000 });
  const stillRunning = (check.stdout ?? "").trim().length > 0;
  if (stillRunning) {
    console.log(`[androidManager] Instagram still running after recents-swipe on ${serial} — falling back to force-stop`);
    await stopInstagram(serial);
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
