import { exec, spawn, ChildProcess } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import net from "net";
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
// (or AppleMobileDeviceLibrary.dll on some iTunes versions) from iTunes. That DLL is NOT
// in the system PATH when iTunes is installed from the Microsoft Store (UWP sandboxed app).
// We query the service and known static paths to find its directory and inject it into PATH.

let _amdPath: string | null | undefined = undefined; // undefined = not yet resolved
let _isStoreItunes = false; // true when iTunes is the sandboxed Microsoft Store version

// All known Apple DLL directories — always injected into PATH regardless of which DLL is found.
// Fresh iTunes installs spread DLLs across several directories; injecting all ensures any
// transitively-required DLL (CoreFoundation.dll, iTunesMobileDevice.dll, etc.) is loadable.
const APPLE_STATIC_DIRS = [
  "C:\\Program Files\\Common Files\\Apple\\Mobile Device Support",
  "C:\\Program Files\\Common Files\\Apple\\Apple Application Support",
  "C:\\Program Files\\iTunes",
  "C:\\Program Files (x86)\\Common Files\\Apple\\Mobile Device Support",
  "C:\\Program Files (x86)\\Common Files\\Apple\\Apple Application Support",
  "C:\\Program Files (x86)\\iTunes",
];

// DLL names used ONLY to confirm a directory is a real Apple install (for MS Store detection).
// Must include names present on both old and fresh iTunes installs.
const APPLE_DLL_NAMES = [
  "AppleMobileDeviceInterface.dll",  // iTunes < 12.x
  "AppleMobileDeviceLibrary.dll",    // some variants
  "iTunesMobileDevice.dll",          // standard fresh iTunes install
  "CoreFoundation.dll",              // Apple Application Support
  "libimobiledevice-1.0.dll",
  "AppleMobileDeviceService.exe",    // service exe — always present when AMDS is installed
];

function findAppleDllInDir(dir: string): boolean {
  return APPLE_DLL_NAMES.some(dll => fs.existsSync(path.join(dir, dll)));
}

async function getAppleMobileDevicePath(): Promise<string> {
  if (_amdPath !== undefined) {
    mlog.debug({ cached: _amdPath }, "[mirror] getAppleMobileDevicePath: returning cached value");
    return _amdPath ?? "";
  }

  if (process.platform !== "win32") { _amdPath = ""; return ""; }

  // Known static paths — covers standard Apple website iTunes installs
  const staticPaths = [
    "C:\\Program Files\\Common Files\\Apple\\Mobile Device Support",
    "C:\\Program Files (x86)\\Common Files\\Apple\\Mobile Device Support",
    "C:\\Program Files\\iTunes",
    "C:\\Program Files (x86)\\iTunes",
    "C:\\Program Files\\Common Files\\Apple\\Apple Application Support",
    "C:\\Program Files (x86)\\Common Files\\Apple\\Apple Application Support",
  ];
  for (const p of staticPaths) {
    const exists = findAppleDllInDir(p);
    mlog.debug({ path: p, dllExists: exists }, "[mirror] getAppleMobileDevicePath: checking static path");
    if (exists) {
      _amdPath = p;
      mlog.info({ amdPath: p, source: "static" }, "[mirror] getAppleMobileDevicePath: DLL found (static iTunes install)");
      return p;
    }
  }

  // Dynamic: query service binary path (works for Microsoft Store iTunes too)
  let svcDirFallback = "";
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
        // Also probe sibling iTunes app directory
        path.join(svcDir, "..", "..", "iTunes"),
        path.join(svcDir, "..", "..", "..", "iTunes"),
        "C:\\Program Files\\iTunes",
        "C:\\Program Files (x86)\\iTunes",
      ];
      for (const c of candidates) {
        const resolved = path.resolve(c);
        const exists = findAppleDllInDir(resolved);
        mlog.info(`[mirror] getAppleMobileDevicePath: checking "${resolved}" — DLL exists: ${exists}`);
        if (exists) {
          _amdPath = resolved;
          mlog.info(`[mirror] getAppleMobileDevicePath: DLL found at: "${resolved}" (service-query)`);
          return resolved;
        }
      }
      svcDirFallback = svcDir;
      mlog.warn(`[mirror] getAppleMobileDevicePath: DLL not found in any candidate under "${svcDir}" — using svcDir as fallback`);
    } else {
      mlog.warn("[mirror] getAppleMobileDevicePath: could not parse BINARY_PATH_NAME from sc qc output");
    }
  } catch (err: any) {
    mlog.warn({ err: String(err?.message ?? err) }, "[mirror] getAppleMobileDevicePath: sc qc failed");
  }

  // Registry fallback — Apple stores its install path in the registry
  try {
    const { stdout: regOut } = await execAsync(
      'reg query "HKLM\\SOFTWARE\\Apple Inc.\\Apple Mobile Device Support" /v "InstallDir" 2>nul || reg query "HKLM\\SOFTWARE\\WOW6432Node\\Apple Inc.\\Apple Mobile Device Support" /v "InstallDir" 2>nul',
      { timeout: 4000 },
    );
    const regMatch = regOut.match(/InstallDir\s+REG_SZ\s+(.+)/i);
    if (regMatch) {
      const regDir = regMatch[1].trim();
      mlog.info(`[mirror] getAppleMobileDevicePath: registry InstallDir="${regDir}"`);
      if (findAppleDllInDir(regDir)) {
        _amdPath = regDir;
        mlog.info(`[mirror] getAppleMobileDevicePath: DLL found via registry at "${regDir}"`);
        return regDir;
      }
    }
  } catch {}

  // If we have a service dir, use it as a last-resort fallback even without confirmed DLL
  if (svcDirFallback) {
    _amdPath = svcDirFallback;
    return svcDirFallback;
  }

  mlog.warn("[mirror] getAppleMobileDevicePath: could not find Apple DLL path — idevice tools may fail to load DLLs");
  _amdPath = "";
  return "";
}

// Windows exit code 0xC0000135 — STATUS_DLL_NOT_FOUND
// Root cause: imobiledevice.dll imports usbmuxd.dll, which Apple stopped shipping
// with modern iTunes (post-2021). No PATH injection can fix a DLL that simply doesn't exist.
const DLL_NOT_FOUND_EXIT_CODE = 3221225781;

// ── usbmuxd TCP direct protocol ───────────────────────────────────────────────
// Apple's AMDS service on Windows still listens on TCP 127.0.0.1:27015 using the
// standard usbmuxd plist protocol. We talk to it directly from Node.js — zero DLLs,
// zero binaries, works on any iTunes version that has AMDS installed and running.

const USBMUXD_HOST       = "127.0.0.1";
const USBMUXD_TCP_PORT   = 27015;
const USBMUXD_PROTO_PLIST = 1;
const USBMUXD_MSG_PLIST   = 8;

export interface UsbmuxdDevice {
  deviceId: number;
  udid: string;
  connectionType: "USB" | "Network";
}

function buildUsbmuxdMsg(plistXml: string, tag = 1): Buffer {
  const body = Buffer.from(plistXml, "utf8");
  const hdr  = Buffer.allocUnsafe(16);
  hdr.writeUInt32LE(16 + body.length, 0);
  hdr.writeUInt32LE(USBMUXD_PROTO_PLIST,  4);
  hdr.writeUInt32LE(USBMUXD_MSG_PLIST,    8);
  hdr.writeUInt32LE(tag,                 12);
  return Buffer.concat([hdr, body]);
}

const LIST_DEVICES_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>MessageType</key><string>ListDevices</string>
  <key>ClientVersionString</key><string>Equinox/1.0</string>
  <key>ProgName</key><string>Equinox</string>
</dict></plist>`;

function makeConnectPlist(deviceId: number, devicePort: number): string {
  // usbmuxd PortNumber must be the port in network byte order (htons)
  const netPort = ((devicePort & 0xff) << 8) | ((devicePort >> 8) & 0xff);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>MessageType</key><string>Connect</string>
  <key>DeviceID</key><integer>${deviceId}</integer>
  <key>PortNumber</key><integer>${netPort}</integer>
  <key>ProgName</key><string>Equinox</string>
</dict></plist>`;
}

function parseUsbmuxdKV(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<key>([^<]+)<\/key>\s*<(?:string|integer)>([^<]*)<\/(?:string|integer)>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out[m[1]] = m[2];
  return out;
}

function parseDeviceListResponse(xml: string): UsbmuxdDevice[] {
  const devices: UsbmuxdDevice[] = [];
  // Each device entry in the AMDS plist has a nested structure:
  //   <dict>                         ← outer device dict
  //     <key>DeviceID</key><integer>N</integer>
  //     <key>Properties</key>
  //     <dict>                       ← inner Properties dict
  //       <key>ConnectionType</key><string>USB</string>
  //       <key>DeviceID</key><integer>N</integer>
  //       <key>SerialNumber</key><string>UDID</string>
  //     </dict>
  //   </dict>
  //
  // A non-greedy /<dict>([\s\S]*?)<\/dict>/g always matches the innermost
  // Properties dict first (it stops at the first </dict>), so it never sees the
  // outer dict that has both DeviceID and the Properties key.  Fix: scan for
  // SerialNumber (one per device), then look backwards in context for DeviceID
  // and ConnectionType which always appear before it in the same Properties block.
  const serialRe = /<key>SerialNumber<\/key>\s*<string>([^<]+)<\/string>/g;
  let m: RegExpExecArray | null;
  while ((m = serialRe.exec(xml)) !== null) {
    const udid = m[1];
    // Scan the ~800 chars preceding (and including) the SerialNumber tag.
    // Both DeviceID and ConnectionType appear in the Properties dict just before it.
    const ctx   = xml.slice(Math.max(0, m.index - 800), m.index + m[0].length);
    const idAll = [...ctx.matchAll(/<key>DeviceID<\/key>\s*<integer>(\d+)<\/integer>/g)];
    const idM   = idAll[idAll.length - 1]; // take the last (innermost) DeviceID
    const connM = /<key>ConnectionType<\/key>\s*<string>([^<]+)<\/string>/.exec(ctx);
    devices.push({
      deviceId:       idM ? parseInt(idM[1], 10) : devices.length + 1,
      udid,
      connectionType: (connM?.[1] ?? "USB") as "USB" | "Network",
    });
  }
  // Log a snippet of the raw XML when no devices were found — helps diagnose
  // unexpected AMDS response formats without flooding the log on every call.
  if (devices.length === 0 && xml.length > 0) {
    mlog.debug({ xmlSnippet: xml.slice(0, 500) }, "[mirror] usbmuxd TCP: parseDeviceListResponse found 0 devices — raw XML snippet");
  }
  return devices;
}

/** List connected iOS devices by talking directly to Apple's AMDS TCP socket.
 *  No DLL dependencies — works even when usbmuxd.dll is absent (modern iTunes). */
export async function listDevicesViaUsbmuxdTcp(): Promise<UsbmuxdDevice[] | null> {
  if (process.platform !== "win32") return null;
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: USBMUXD_HOST, port: USBMUXD_TCP_PORT });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (val: UsbmuxdDevice[] | null) => {
      if (done) return; done = true;
      try { sock.destroy(); } catch {}
      resolve(val);
    };
    sock.setTimeout(3000, () => {
      mlog.warn("[mirror] usbmuxd TCP: timeout — AMDS not responding");
      finish(null);
    });
    sock.on("error", (e) => {
      mlog.warn({ err: String(e) }, "[mirror] usbmuxd TCP: connection error");
      finish(null);
    });
    sock.on("connect", () => {
      mlog.info("[mirror] usbmuxd TCP: connected to Apple AMDS 127.0.0.1:27015");
      sock.write(buildUsbmuxdMsg(LIST_DEVICES_PLIST, 1));
    });
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 16) return;
      const total = buf.readUInt32LE(0);
      if (buf.length < total) return;
      const xml = buf.slice(16, total).toString("utf8");
      mlog.info({ plistLen: xml.length }, "[mirror] usbmuxd TCP: ListDevices response received");
      const devs = parseDeviceListResponse(xml);
      mlog.info({ count: devs.length, udids: devs.map(d => d.udid) }, "[mirror] usbmuxd TCP: parsed devices");
      finish(devs);
    });
  });
}

// ── TCP iproxy tunnel ─────────────────────────────────────────────────────────
// Replaces iproxy.exe when it can't load (same usbmuxd.dll problem).
// Opens a local TCP server; each incoming connection sends a usbmuxd Connect
// message and then pipes the socket transparently to the device port.

let _tcpTunnelServer: net.Server | null = null;
let _tcpTunnelUdid:   string | null = null;

async function startIproxyViaTcp(
  udid: string,
  localPort: number,
  devicePort: number,
): Promise<{ ok: boolean; error?: string }> {
  if (_tcpTunnelServer && _tcpTunnelUdid === udid) return { ok: true };
  stopIproxyTcp();

  const devs = (await listDevicesViaUsbmuxdTcp()) ?? [];
  const dev  = devs.find(d => d.udid === udid);
  if (!dev) return { ok: false, error: `usbmuxd TCP: device ${udid} not found` };

  const connectPlist = makeConnectPlist(dev.deviceId, devicePort);

  return new Promise((resolve) => {
    const server = net.createServer((client) => {
      const usb = net.createConnection({ host: USBMUXD_HOST, port: USBMUXD_TCP_PORT });
      let hdrBuf   = Buffer.alloc(0);
      let bridged  = false;

      usb.once("connect", () => usb.write(buildUsbmuxdMsg(connectPlist, 1)));
      usb.on("error",  (e) => { mlog.warn({ err: String(e) }, "[mirror] tcp-tunnel: usb err"); client.destroy(); });
      client.on("error", () => usb.destroy());
      client.on("close",  () => usb.destroy());
      usb.on("close",     () => client.destroy());

      usb.on("data", (chunk) => {
        if (bridged) return; // already piping
        hdrBuf = Buffer.concat([hdrBuf, chunk]);
        if (hdrBuf.length < 16) return;
        const total = hdrBuf.readUInt32LE(0);
        if (hdrBuf.length < total) return;
        // Parse result plist
        const xml  = hdrBuf.slice(16, total).toString("utf8");
        const kv   = parseUsbmuxdKV(xml);
        const code = Number(kv["Number"] ?? kv["NumberCode"] ?? 1);
        if (code !== 0) {
          mlog.warn({ code, xml }, "[mirror] tcp-tunnel: Connect refused");
          client.destroy(); usb.destroy(); return;
        }
        bridged = true;
        mlog.info({ udid, localPort, devicePort }, "[mirror] tcp-tunnel: bridge established");
        // Flush any remaining bytes past the response header, then pipe
        const tail = hdrBuf.slice(total);
        if (tail.length > 0) client.write(tail);
        usb.removeAllListeners("data");
        usb.pipe(client);
        client.pipe(usb);
      });
    });

    server.listen(localPort, "127.0.0.1", () => {
      mlog.info({ localPort }, "[mirror] tcp-tunnel: server listening");
      _tcpTunnelServer = server;
      _tcpTunnelUdid   = udid;
      resolve({ ok: true });
    });
    server.on("error", (e) => {
      mlog.warn({ err: String(e) }, "[mirror] tcp-tunnel: server error");
      resolve({ ok: false, error: String(e) });
    });
  });
}

function stopIproxyTcp(): void {
  if (_tcpTunnelServer) {
    try { _tcpTunnelServer.close(); } catch {}
    _tcpTunnelServer = null;
    _tcpTunnelUdid   = null;
  }
}

/** Restart the Apple Mobile Device Service on Windows.
 *  This fixes cases where AMDS is running but not seeing any connected devices.
 *  Safe to call at any time — gracefully no-ops on non-Windows. */
export async function restartAmds(): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== "win32") {
    return { ok: false, message: "Not a Windows machine — AMDS restart not applicable." };
  }
  try {
    mlog.info("[mirror] restartAmds: stopping Apple Mobile Device Service");
    try {
      await execAsync('sc stop "Apple Mobile Device Service"', { timeout: 8000 });
    } catch {
      // ignore — it may already be stopped or the stop takes longer than the timeout
    }
    await new Promise(r => setTimeout(r, 2000)); // let the service fully stop
    mlog.info("[mirror] restartAmds: starting Apple Mobile Device Service");
    await execAsync('sc start "Apple Mobile Device Service"', { timeout: 10000 });
    await new Promise(r => setTimeout(r, 1500)); // let it fully start
    mlog.info("[mirror] restartAmds: done");
    return { ok: true, message: "Apple Mobile Device Service restarted." };
  } catch (err: any) {
    mlog.warn({ err: String(err?.message ?? err) }, "[mirror] restartAmds: failed");
    return { ok: false, message: String(err?.message ?? err) };
  }
}

/** Build an env object that includes ALL known Apple DLL directories in PATH.
 *  Fresh iTunes installs spread DLLs across Mobile Device Support, Apple Application Support,
 *  and the iTunes app dir. We inject all of them so any transitively-required DLL is loadable
 *  regardless of which exact directory Apple chose for a given version.
 */
async function buildEnvWithApplePath(): Promise<NodeJS.ProcessEnv> {
  const amdPath = await getAppleMobileDevicePath(); // still needed for MS-Store detection side-effect
  const binDir  = getBinDir();

  // Build the injection list: our bin dir first, then every known Apple directory.
  // Unknown/non-existent dirs are harmless in PATH and future-proof against iTunes layout changes.
  const extraDirs = [
    binDir,
    ...APPLE_STATIC_DIRS,
    ...(amdPath && !APPLE_STATIC_DIRS.includes(amdPath) ? [amdPath] : []),
  ].filter(Boolean);

  const usbmuxd   = process.env.USBMUXD_SOCKET_ADDRESS ?? "tcp:127.0.0.1:27015";
  const finalPath = `${extraDirs.join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ""}`;
  mlog.info(
    { binDir, amdPath, usbmuxdSocket: usbmuxd, injectedDirs: extraDirs },
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
  let dllCrash = false;
  if (binaryFound) {
    const cmd = `"${exe}" -l`;
    mlog.info({ cmd, usbmuxd: env.USBMUXD_SOCKET_ADDRESS }, "[mirror] diagnoseIphoneSupport: running idevice_id -l");
    try {
      const result = await execAsync(cmd, { timeout: 6000, env });
      rawOutput = result.stdout.trim();
      rawError = (result as any).stderr?.trim() ?? "";
      mlog.info(`[mirror] diagnoseIphoneSupport: idevice_id -l result — stdout="${rawOutput}" stderr="${rawError}"`);
    } catch (err: any) {
      const exitCode = (err as any)?.code;
      // 0xC0000135 = STATUS_DLL_NOT_FOUND — binary loads but immediately crashes because
      // a required Apple DLL (AppleMobileDeviceInterface.dll or similar) is not in PATH.
      if (exitCode === DLL_NOT_FOUND_EXIT_CODE) {
        dllCrash = true;
        mlog.warn(`[mirror] diagnoseIphoneSupport: idevice_id.exe crashed with 0xC0000135 (DLL_NOT_FOUND) — Apple DLL missing from PATH. amdPath="${amdPath}"`);
      }
      // Use || not ?? so that empty string stderr falls through to message
      rawError = String((err?.stderr || err?.message) ?? err);
      mlog.warn(`[mirror] diagnoseIphoneSupport: idevice_id -l threw — code=${exitCode} stderr="${String(err?.stderr ?? "")}" message="${String(err?.message ?? err)}"`);
    }

    // If nothing came back and no DLL crash, try with --debug to get verbose output for diagnosis
    if (rawOutput === "" && rawError === "" && !dllCrash) {
      const dbgCmd = `"${exe}" --debug -l`;
      mlog.info(`[mirror] diagnoseIphoneSupport: idevice_id -l returned empty — retrying with --debug`);
      try {
        const dbg = await execAsync(dbgCmd, { timeout: 8000, env });
        debugOutput = [dbg.stdout, (dbg as any).stderr].filter(Boolean).join("\n").trim();
        mlog.info(`[mirror] diagnoseIphoneSupport: idevice_id --debug output: "${debugOutput}"`);
      } catch (err: any) {
        const dbgCode = (err as any)?.code;
        if (dbgCode === DLL_NOT_FOUND_EXIT_CODE) dllCrash = true;
        debugOutput = String((err?.stderr || err?.stdout || err?.message) ?? "").trim();
        mlog.warn(`[mirror] diagnoseIphoneSupport: idevice_id --debug threw — code=${dbgCode} output="${debugOutput}"`);
      }
    }
  } else {
    mlog.warn("[mirror] diagnoseIphoneSupport: skipping idevice_id run — binary not found");
  }

  // When idevice_id.exe crashes (usbmuxd.dll missing), attempt TCP device detection
  // so we can still report whether a device is actually connected.
  let tcpServiceOk = false;
  let tcpDetectedCount = 0;
  if (dllCrash) {
    try {
      const tcpDevs = await listDevicesViaUsbmuxdTcp();
      // null = connection failed; [] = connected but no phone yet; [...] = phone found
      tcpServiceOk = tcpDevs !== null;
      tcpDetectedCount = tcpDevs?.length ?? 0;
      if (tcpDetectedCount > 0) {
        mlog.info({ count: tcpDetectedCount }, "[mirror] diagnoseIphoneSupport: TCP usbmuxd found devices despite DLL crash");
      } else if (tcpServiceOk) {
        mlog.info("[mirror] diagnoseIphoneSupport: TCP usbmuxd connected — no device plugged in yet");
      } else {
        mlog.info("[mirror] diagnoseIphoneSupport: TCP usbmuxd could not connect — AMDS not running");
      }
    } catch {}
  }

  let suggestion = "";
  if (!binaryFound) {
    suggestion = "Equinox binaries are missing. Try reinstalling the app.";
  } else if (_isStoreItunes) {
    suggestion = "ms_store_itunes";
  } else if (!appleDriverRunning && process.platform === "win32") {
    suggestion = "itunes_required";
  } else if (dllCrash) {
    // imobiledevice.dll imports usbmuxd.dll which Apple stopped shipping with modern iTunes.
    // We fall back to TCP usbmuxd — report whether that also works.
    suggestion = tcpServiceOk ? "usbmuxd_dll_missing_tcp_ok" : "usbmuxd_dll_missing";
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
    const exitCode = (err as any)?.code;
    if (exitCode === DLL_NOT_FOUND_EXIT_CODE) {
      mlog.warn(`[mirror] listConnectedDevices: idevice_id.exe crashed with 0xC0000135 (DLL_NOT_FOUND) — Apple DLL not in PATH. Run diagnose for full details.`);
    }
    mlog.warn(`[mirror] listConnectedDevices: bundled idevice_id.exe threw — code=${exitCode} stderr="${String(err?.stderr ?? "")}" message="${String(err?.message ?? err)}"`);
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

  // 3. Direct TCP usbmuxd — works when usbmuxd.dll is absent (modern iTunes no longer ships it).
  //    Apple's AMDS service still listens on 127.0.0.1:27015 using the standard usbmuxd protocol.
  mlog.info("[mirror] listConnectedDevices: trying direct TCP usbmuxd (no DLL required)");
  try {
    const tcpDevs = (await listDevicesViaUsbmuxdTcp()) ?? [];
    if (tcpDevs.length > 0) {
      mlog.info({ count: tcpDevs.length }, "[mirror] listConnectedDevices: devices found via TCP usbmuxd");
      return tcpDevs.map(d => ({ udid: d.udid, name: "iPhone", ios: "Unknown", connected: "usb" as const }));
    }
    mlog.info("[mirror] listConnectedDevices: TCP usbmuxd returned no devices");
  } catch (err: any) {
    mlog.warn({ err: String(err?.message ?? err) }, "[mirror] listConnectedDevices: TCP usbmuxd threw");
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
  return { running: iproxyProc !== null || _tcpTunnelServer !== null, udid: iproxyUdid ?? _tcpTunnelUdid, port: iproxyPort };
}

export async function startIproxy(udid: string, localPort = 8100, devicePort = 8100): Promise<{ ok: boolean; error?: string }> {
  // Stop existing iproxy if for a different device
  if ((iproxyProc && iproxyUdid !== udid) || (_tcpTunnelServer && _tcpTunnelUdid !== udid)) {
    stopIproxy();
  }
  if (iproxyProc || _tcpTunnelServer) return { ok: true }; // already running for this device

  iproxyPort = localPort;
  iproxyUdid = udid;

  const exe = binPath("iproxy.exe");

  // Try iproxy.exe first
  const exeResult = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    try {
      const args = [`${localPort}`, `${devicePort}`, "--udid", udid];
      iproxyProc = spawn(exe, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      iproxyProc.on("error", (err) => {
        iproxyProc = null;
        resolve({ ok: false, error: `iproxy.exe error: ${err.message}` });
      });

      iproxyProc.on("exit", (code) => {
        iproxyProc = null;
        // If it exited before our 800ms check fires, report failure
      });

      setTimeout(() => {
        if (iproxyProc) {
          resolve({ ok: true });
        } else {
          resolve({ ok: false, error: "iproxy.exe exited immediately" });
        }
      }, 800);
    } catch (err: any) {
      iproxyProc = null;
      resolve({ ok: false, error: String(err.message ?? err) });
    }
  });

  if (exeResult.ok) return exeResult;

  // iproxy.exe failed (most likely usbmuxd.dll missing) — fall back to TCP tunnel
  mlog.warn({ exeError: exeResult.error }, "[mirror] iproxy.exe failed — falling back to TCP usbmuxd tunnel");
  iproxyUdid = null;
  return startIproxyViaTcp(udid, localPort, devicePort);
}

export function stopIproxy(): void {
  if (iproxyProc) {
    try { iproxyProc.kill(); } catch {}
    iproxyProc = null;
    iproxyUdid = null;
  }
  stopIproxyTcp();
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
