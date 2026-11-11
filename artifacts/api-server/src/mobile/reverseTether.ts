import { spawn, execFile, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import * as android from "./androidManager";

const execFileAsync = promisify(execFile);
const FIRST_RELAY_PORT = 32100;
const LAST_RELAY_PORT = 32199;
const DEVICE_POLL_INTERVAL_MS = 8_000;

export type ReverseTetherProxy = {
  protocol: "http" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
  label?: string;
};

type TunnelEntry = {
  serial: string;
  port: number;
  proxyFingerprint: string;
  proxyLabel: string | null;
  child: ChildProcess;
  state: "starting" | "running" | "error";
  error: string | null;
  startedAt: number;
};

const tunnels = new Map<string, TunnelEntry>();
const serialQueues = new Map<string, Promise<unknown>>();
type SavedNetworkState = { wifiOn: boolean; mobileDataOn: boolean };
const savedNetworkStateFile = path.join(
  process.env.EQUINOX_DATA_DIR ?? path.resolve(process.cwd(), "reverse-tether-state"),
  "usb-reverse-tether-network.json",
);
let savedNetworkStates: Record<string, SavedNetworkState> = {};
let watcher: ReturnType<typeof setInterval> | null = null;
let watcherBusy = false;

try {
  savedNetworkStates = JSON.parse(fs.readFileSync(savedNetworkStateFile, "utf8"));
} catch {}

function persistNetworkStates(): void {
  try {
    fs.mkdirSync(path.dirname(savedNetworkStateFile), { recursive: true });
    fs.writeFileSync(savedNetworkStateFile, JSON.stringify(savedNetworkStates, null, 2));
  } catch (error) {
    console.warn(`[reverse-tether] could not persist phone network state: ${String(error)}`);
  }
}

function executablePaths(): { exe: string; apk: string } {
  const base = process.env.AURA_GNIREHTET_DIR;
  if (!base) {
    throw new Error("The USB reverse-tether helper is missing. Install the updated Windows Aura Farming app.");
  }
  const executable = process.platform === "win32" ? "gnirehtet.exe" : "gnirehtet";
  const exe = path.join(base, executable);
  const apk = path.join(base, "gnirehtet.apk");
  if (!fs.existsSync(exe) || !fs.existsSync(apk)) {
    throw new Error("The USB reverse-tether helper is missing from this installation. Reinstall the updated Aura Farming app.");
  }
  return { exe, apk };
}

function proxyFingerprint(proxy: ReverseTetherProxy | null): string {
  if (!proxy) return "direct";
  return JSON.stringify([
    proxy.protocol,
    proxy.host,
    proxy.port,
    proxy.username ?? "",
    proxy.password ?? "",
  ]);
}

function availablePort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function reservePort(serial: string): Promise<number> {
  const occupied = new Set(
    [...tunnels.values()]
      .filter(entry => entry.serial !== serial)
      .map(entry => entry.port),
  );
  for (let port = FIRST_RELAY_PORT; port <= LAST_RELAY_PORT; port += 1) {
    if (!occupied.has(port) && await availablePort(port)) return port;
  }
  throw new Error("No free USB reverse-tether ports remain.");
}

async function waitForRelay(entry: TunnelEntry): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (entry.child.exitCode !== null) {
      throw new Error(`The USB relay exited before starting (code ${entry.child.exitCode}).`);
    }
    const listening = await new Promise<boolean>(resolve => {
      const socket = net.createConnection({ host: "127.0.0.1", port: entry.port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.setTimeout(250, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (listening) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("The USB relay did not start listening.");
}

async function runHelper(
  exe: string,
  apk: string,
  adb: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<string> {
  const env = {
    ...process.env,
    ADB: adb,
    GNIREHTET_APK: apk,
  };
  try {
    const { stdout, stderr } = await execFileAsync(exe, args, {
      env,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    } as any);
    return `${stdout ?? ""}${stderr ?? ""}`.trim();
  } catch (error: any) {
    const detail = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}`.trim();
    const message = detail || error?.message || "Reverse-tether command failed";
    throw new Error(message.slice(0, 1200));
  }
}

async function runAdb(adb: string, serial: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(adb, ["-s", serial, ...args], {
      encoding: "utf8",
      timeout: 8_000,
      windowsHide: true,
    } as any);
  } catch (error: any) {
    const detail = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}`.trim();
    throw new Error((detail || error?.message || "ADB command failed").slice(0, 1200));
  }
}

async function readAdbValue(adb: string, serial: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(adb, ["-s", serial, ...args], {
    encoding: "utf8",
    timeout: 8_000,
    windowsHide: true,
  } as any);
  return String(stdout ?? "").trim();
}

async function setRadio(adb: string, serial: string, name: "wifi" | "data", enabled: boolean): Promise<void> {
  await runAdb(adb, serial, ["shell", "svc", name, enabled ? "enable" : "disable"]);
}

async function isolatePhoneNetwork(adb: string, serial: string): Promise<void> {
  if (!savedNetworkStates[serial]) {
    const [wifi, mobileData] = await Promise.all([
      readAdbValue(adb, serial, ["shell", "settings", "get", "global", "wifi_on"]),
      readAdbValue(adb, serial, ["shell", "settings", "get", "global", "mobile_data"]),
    ]);
    if (!["0", "1"].includes(wifi) || !["0", "1"].includes(mobileData)) {
      throw new Error("Could not safely read the phone's current Wi-Fi and mobile-data states.");
    }
    savedNetworkStates[serial] = {
      wifiOn: wifi === "1",
      mobileDataOn: mobileData === "1",
    };
    persistNetworkStates();
  }
  // The Android VPN helper only tunnels IPv4. Disable the phone's own radios
  // while it is active so IPv6 or apps bypassing the VPN cannot leak onto the
  // phone's Wi-Fi/cellular connection. ADB remains connected over USB.
  await setRadio(adb, serial, "wifi", false);
  await setRadio(adb, serial, "data", false);
  const [wifi, mobileData] = await Promise.all([
    readAdbValue(adb, serial, ["shell", "settings", "get", "global", "wifi_on"]),
    readAdbValue(adb, serial, ["shell", "settings", "get", "global", "mobile_data"]),
  ]);
  if (wifi !== "0" || mobileData !== "0") {
    throw new Error("Could not disable the phone's own Wi-Fi/mobile-data routes; USB internet was not enabled to avoid traffic bypass.");
  }
}

async function restorePhoneNetwork(adb: string, serial: string): Promise<void> {
  const original = savedNetworkStates[serial];
  if (!original) return;
  await setRadio(adb, serial, "wifi", original.wifiOn);
  await setRadio(adb, serial, "data", original.mobileDataOn);
  delete savedNetworkStates[serial];
  persistNetworkStates();
}

async function vpnServiceActive(adb: string, serial: string): Promise<boolean> {
  const output = await readAdbValue(adb, serial, [
    "shell",
    "dumpsys",
    "activity",
    "services",
    "com.genymobile.gnirehtet",
  ]);
  return /GnirehtetService/.test(output);
}

async function activateAfterApproval(entry: TunnelEntry, adb: string): Promise<boolean> {
  if (!await vpnServiceActive(adb, entry.serial)) return false;
  await isolatePhoneNetwork(adb, entry.serial);
  entry.state = "running";
  entry.error = null;
  return true;
}

function restorePhoneNetworkSynchronously(): void {
  const tools = android.detectToolset();
  const adb = tools.adb.path;
  if (!adb) return;
  let paths: { exe: string; apk: string } | null = null;
  try { paths = executablePaths(); } catch {}
  for (const [serial, entry] of tunnels) {
    try { entry.child.kill(); } catch {}
    if (paths) {
      spawnSync(paths.exe, ["stop", serial], {
        encoding: "utf8",
        timeout: 1_000,
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env, ADB: adb, GNIREHTET_APK: paths.apk },
      });
    }
    spawnSync(adb, ["-s", serial, "reverse", "--remove", "localabstract:gnirehtet"], {
      encoding: "utf8",
      timeout: 1_000,
      windowsHide: true,
      stdio: "ignore",
    });
  }
  let changed = false;
  for (const [serial, state] of Object.entries(savedNetworkStates)) {
    try {
      const wifi = spawnSync(adb, ["-s", serial, "shell", "svc", "wifi", state.wifiOn ? "enable" : "disable"], {
        encoding: "utf8",
        timeout: 1_000,
        windowsHide: true,
      });
      const data = spawnSync(adb, ["-s", serial, "shell", "svc", "data", state.mobileDataOn ? "enable" : "disable"], {
        encoding: "utf8",
        timeout: 1_000,
        windowsHide: true,
      });
      if (wifi.error || wifi.status !== 0 || data.error || data.status !== 0) continue;
      delete savedNetworkStates[serial];
      tunnels.delete(serial);
      changed = true;
    } catch {}
  }
  if (changed) persistNetworkStates();
}

process.once("exit", restorePhoneNetworkSynchronously);

let shutdownStarted = false;
const shutdownReverseTether = () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const deadline = setTimeout(() => process.exit(1), 2_000);
  void stopAll().finally(() => {
    clearTimeout(deadline);
    process.exit(0);
  });
};
process.once("SIGTERM", shutdownReverseTether);
process.once("SIGINT", shutdownReverseTether);

function makeRelayEnvironment(
  adb: string,
  apk: string,
  proxy: ReverseTetherProxy | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ADB: adb, GNIREHTET_APK: apk };
  for (const name of [
    "AURA_PROXY_TYPE",
    "AURA_PROXY_HOST",
    "AURA_PROXY_PORT",
    "AURA_PROXY_USERNAME",
    "AURA_PROXY_PASSWORD",
  ]) {
    delete env[name];
  }
  if (proxy) {
    env.AURA_PROXY_TYPE = proxy.protocol;
    env.AURA_PROXY_HOST = proxy.host;
    env.AURA_PROXY_PORT = String(proxy.port);
    if (proxy.username) env.AURA_PROXY_USERNAME = proxy.username;
    if (proxy.password) env.AURA_PROXY_PASSWORD = proxy.password;
  }
  return env;
}

async function stopUnlocked(serial: string): Promise<void> {
  const entry = tunnels.get(serial);
  const tools = android.detectToolset();
  const paths = (() => {
    try { return executablePaths(); } catch { return null; }
  })();
  if (paths && tools.adb.path) {
    await runHelper(paths.exe, paths.apk, tools.adb.path, ["stop", serial], 12_000).catch(() => {});
  }
  if (tools.adb.path) {
    await runAdb(tools.adb.path, serial, ["reverse", "--remove", "localabstract:gnirehtet"]).catch(() => {});
  }
  if (entry) {
    tunnels.delete(serial);
    try { entry.child.kill(); } catch {}
  }
  if (tools.adb.path) {
    await restorePhoneNetwork(tools.adb.path, serial).catch(error => {
      console.warn(`[reverse-tether] ${serial}: could not restore the phone's original Wi-Fi/mobile-data state: ${String(error)}`);
    });
  }
}

async function startUnlocked(
  serial: string,
  proxy: ReverseTetherProxy | null,
): Promise<{ port: number; label: string | null; message: string }> {
  const fingerprint = proxyFingerprint(proxy);
  const existing = tunnels.get(serial);
  if (existing?.state === "running" && existing.proxyFingerprint === fingerprint && existing.child.exitCode === null) {
    return {
      port: existing.port,
      label: existing.proxyLabel,
      message: "USB internet route is already running",
    };
  }
  if (existing?.state === "starting" && existing.proxyFingerprint === fingerprint && existing.child.exitCode === null) {
    const adb = android.detectToolset().adb.path;
    if (adb && await activateAfterApproval(existing, adb)) {
      return {
        port: existing.port,
        label: existing.proxyLabel,
        message: proxy
          ? `USB route is active through ${proxy.label ?? `${proxy.host}:${proxy.port}`}.`
          : "USB route is active through this laptop's internet.",
      };
    }
    return {
      port: existing.port,
      label: existing.proxyLabel,
      message: "Waiting for the one-time Android VPN approval. Tap Allow on the phone to activate the laptop route.",
    };
  }
  await stopUnlocked(serial);

  const tools = android.detectToolset();
  if (!tools.adb.path) throw new Error("ADB is not available. Connect the phone by USB and authorize USB debugging.");
  // Recover settings left behind by a previous API restart before saving the
  // current user configuration for this tunnel session.
  await restorePhoneNetwork(tools.adb.path, serial).catch(() => {});
  const { exe, apk } = executablePaths();
  const port = await reservePort(serial);

  const child = spawn(exe, ["relay", "-p", String(port)], {
    env: makeRelayEnvironment(tools.adb.path, apk, proxy),
    stdio: "ignore",
    windowsHide: true,
  });
  const entry: TunnelEntry = {
    serial,
    port,
    proxyFingerprint: fingerprint,
    proxyLabel: proxy?.label ?? null,
    child,
    state: "starting",
    error: null,
    startedAt: Date.now(),
  };
  tunnels.set(serial, entry);
  child.once("error", error => {
    entry.state = "error";
    entry.error = error.message;
  });
  child.once("exit", (code, signal) => {
    if (tunnels.get(serial) !== entry) return;
    entry.state = "error";
    entry.error = `USB relay stopped unexpectedly (${code ?? signal ?? "unknown"}).`;
  });

  try {
    await waitForRelay(entry);
    const result = await runHelper(exe, apk, tools.adb.path, ["start", serial, "-p", String(port)]);
    if (/cannot start client|cannot set up|failed|error:/i.test(result)) {
      throw new Error(result);
    }
    let vpnActive = false;
    for (let attempt = 0; attempt < 4 && !vpnActive; attempt += 1) {
      if (await vpnServiceActive(tools.adb.path, serial).catch(() => false)) {
        vpnActive = await activateAfterApproval(entry, tools.adb.path);
      }
      if (!vpnActive) await new Promise(resolve => setTimeout(resolve, 350));
    }
    return {
      port,
      label: proxy?.label ?? null,
      message: vpnActive
        ? proxy
          ? `USB route is active through ${proxy.label ?? `${proxy.host}:${proxy.port}`}.`
          : "USB route is active through this laptop's internet."
        : "Waiting for the one-time Android VPN approval. Tap Allow on the phone to activate the laptop route.",
    };
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    entry.state = "error";
    await stopUnlocked(serial);
    throw error;
  }
}

async function withSerialLock<T>(serial: string, operation: () => Promise<T>): Promise<T> {
  const previous = serialQueues.get(serial) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  serialQueues.set(serial, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (serialQueues.get(serial) === current) serialQueues.delete(serial);
  }
}

export function startDevice(
  serial: string,
  proxy: ReverseTetherProxy | null,
): Promise<{ port: number; label: string | null; message: string }> {
  return withSerialLock(serial, () => startUnlocked(serial, proxy));
}

export function stopDevice(serial: string): Promise<void> {
  return withSerialLock(serial, () => stopUnlocked(serial));
}

export function getDeviceStatus(serial: string) {
  const entry = tunnels.get(serial);
  return {
    running: entry?.state === "running" && entry.child.exitCode === null,
    starting: entry?.state === "starting",
    error: entry?.error ?? null,
    port: entry?.port ?? null,
    proxy: entry?.proxyLabel ?? null,
    startedAt: entry?.startedAt ?? null,
  };
}

/**
 * Start the laptop-to-phone route for every USB-connected Android phone,
 * including phones with no Proxy Manager entry (those use the laptop's
 * default internet route). Network-addressed emulators are deliberately left
 * alone.
 */
export function startUsbDeviceWatcher(
  loadProxy: (serial: string) => Promise<ReverseTetherProxy | null>,
): void {
  if (watcher || process.platform !== "win32" || !process.env.AURA_GNIREHTET_DIR) return;
  const poll = async () => {
    if (watcherBusy || process.platform !== "win32") return;
    watcherBusy = true;
    try {
      const devices = await android.listDevices();
      const connectedUsb = new Set(
        devices
          .filter(device => device.state === "device" && Boolean((device as any).usb))
          .map(device => device.serial),
      );
      for (const serial of connectedUsb) {
        const current = tunnels.get(serial);
        if (current?.state === "running" && current.child.exitCode === null) {
          const adb = android.detectToolset().adb.path;
          if (!adb || await vpnServiceActive(adb, serial).catch(() => false)) continue;
          await stopDevice(serial).catch(() => {});
        } else if (current?.state === "starting" && current.child.exitCode === null) {
          const adb = android.detectToolset().adb.path;
          if (adb) {
            try {
              await withSerialLock(serial, async () => {
                const pending = tunnels.get(serial);
                if (pending?.state === "starting") await activateAfterApproval(pending, adb);
              });
            } catch (error) {
              console.warn(`[reverse-tether] ${serial}: could not activate VPN route: ${error instanceof Error ? error.message : String(error)}`);
              await stopDevice(serial).catch(() => {});
            }
          }
          continue;
        }
        try {
          const proxy = await loadProxy(serial);
          await android.setDeviceProxy(serial, null);
          await startDevice(serial, proxy);
        } catch (error) {
          console.warn(`[reverse-tether] ${serial}: ${error instanceof Error ? error.message : String(error)}`);
          await stopDevice(serial).catch(() => {});
        }
      }
      for (const serial of tunnels.keys()) {
        if (!connectedUsb.has(serial)) await stopDevice(serial).catch(() => {});
      }
    } catch (error) {
      console.warn(`[reverse-tether] USB device scan failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      watcherBusy = false;
    }
  };
  void poll();
  watcher = setInterval(() => { void poll(); }, DEVICE_POLL_INTERVAL_MS);
  watcher.unref?.();
}

export async function stopAll(): Promise<void> {
  if (watcher) clearInterval(watcher);
  watcher = null;
  await Promise.all([...tunnels.keys()].map(serial => stopDevice(serial).catch(() => {})));
}
