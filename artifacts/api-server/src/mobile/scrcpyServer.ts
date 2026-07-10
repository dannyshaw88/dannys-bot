/**
 * Real scrcpy-server integration — replaces the old `adb exec-out screenrecord`
 * approach entirely for the phone mirror.
 *
 * Why: screenrecord's virtual display freezes on many OEM builds (MIUI in
 * particular) whenever the keyguard re-engages or the real display sleeps,
 * because screenrecord mirrors a *virtual* display, not the real framebuffer.
 * The old code worked around this with a restart-on-stall loop, which is what
 * made the mirror look like it "reverted to screenshots" — it was technically
 * video, just constantly restarting.
 *
 * scrcpy (https://github.com/Genymobile/scrcpy) is the reference tool nearly
 * every phone-farm dashboard is built on. It pushes a small server (a plain
 * Android app run via `app_process`, no root/install needed) onto the device.
 * The server uses Android's native `MediaProjection`/`SurfaceControl` capture
 * APIs against the REAL display — the same path the OS itself uses for
 * screen recording — so it doesn't have the virtual-display freeze problem.
 * It streams a continuous raw H.264 Annex-B elementary stream (same format
 * our existing WebCodecs demuxer already parses) and exposes a separate
 * control socket for real touch/key injection in exact device pixels.
 *
 * We vendor the official prebuilt server jar (`vendor/scrcpy-server-v3.1`,
 * from https://github.com/Genymobile/scrcpy/releases/tag/v3.1) rather than
 * requiring scrcpy to be installed on the host — the server is a device-side
 * artifact, completely independent of any client. We implement our own
 * minimal client for its wire protocol (documented at
 * https://github.com/Genymobile/scrcpy/blob/master/doc/develop.md) instead of
 * shelling out to the scrcpy binary, so the video bytes can be piped straight
 * into the existing browser mirror over our own WebSocket.
 *
 * Protocol summary (stable since scrcpy v2.x, confirmed against the v3.1
 * server's option table for this exact vendored build):
 *   1. adb push the server jar to /data/local/tmp/
 *   2. adb forward tcp:<local> localabstract:scrcpy_<scid>
 *   3. adb shell CLASSPATH=<jar> app_process / com.genymobile.scrcpy.Server
 *      3.1 <key=value ...>
 *   4. Connect to the forwarded port TWICE, in order: the video socket, then
 *      (since control=true, audio=false) the control socket.
 *   5. Video socket: [64-byte device name][4-byte codec id][4-byte width]
 *      [4-byte height] once, then a continuous raw H.264 Annex-B stream.
 *   6. Control socket: write-only binary messages (touch/key injection).
 */
import { spawn, spawnSync, ChildProcess } from "child_process";
import * as net from "net";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { fileURLToPath } from "url";
import { detectToolset, requireTool } from "./androidManager";
import { logger } from "../lib/logger";

const SCRCPY_VERSION = "3.1";
const DEVICE_JAR_PATH = "/data/local/tmp/scrcpy-server.jar";

// Works both in dev (tsx running src/) and in the built dist/ bundle — see
// build.mjs's copyVendorAssets step, which mirrors vendor/ next to dist/.
function vendorJarPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../vendor/scrcpy-server-v3.1"), // dev: src/mobile/ -> artifacts/api-server/vendor/
    path.resolve(here, "../vendor/scrcpy-server-v3.1"),     // dist: dist/ -> dist/vendor/ (bundle is flat)
    path.resolve(here, "vendor/scrcpy-server-v3.1"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`Vendored scrcpy-server-v3.1 not found (looked in: ${candidates.join(", ")})`);
}

// Android MotionEvent action constants (stable across all API levels).
const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_MOVE = 2;

// scrcpy ControlMessage type ids (stable since scrcpy 2.x; confirmed against
// this exact vendored server build's option/class layout).
const CTRL_TYPE_INJECT_KEYCODE = 0;
const CTRL_TYPE_INJECT_TOUCH_EVENT = 2;

const KEY_ACTION_DOWN = 0;
const KEY_ACTION_UP = 1;

// scrcpy reserves this pointer id for a single simulated ("virtual") finger.
const POINTER_ID_VIRTUAL_FINGER = -1n;

function toFixedPoint16(pressure: number): number {
  const u = Math.round(pressure * 0x10000);
  return u >= 0x10000 ? 0xffff : u;
}

export type ScrcpySession = {
  serial: string;
  width: number;
  height: number;
  deviceName: string;
  onVideoData(cb: (chunk: Buffer) => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: (reason: string) => void): void;
  /** x/y are in the coordinate space of `frameW`x`frameH` (the last known video frame size — usually width/height above, but pass explicitly to be safe against future resize support). */
  tap(x: number, y: number, frameW: number, frameH: number): void;
  swipe(x1: number, y1: number, x2: number, y2: number, frameW: number, frameH: number, durationMs?: number): void;
  keycode(code: number): void;
  stop(reason?: string): void;
};

function adbPath(): string {
  return requireTool(detectToolset().adb, "adb");
}

function runAdbSync(serial: string, args: string[], timeoutMs = 8000) {
  return spawnSync(adbPath(), ["-s", serial, ...args], { encoding: "utf8", timeout: timeoutMs });
}

/** Reads exactly `n` bytes from a socket by buffering `data` events, then hands control to the raw-stream callback. Needed because the initial device-name + codec-meta header must be consumed before treating the rest as opaque video bytes. */
function readExactly(sock: net.Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let have = 0;
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      have += chunk.length;
      if (have >= n) {
        sock.off("data", onData);
        sock.off("error", onError);
        sock.off("close", onClose);
        const combined = Buffer.concat(chunks);
        resolve(combined.subarray(0, n));
        const leftover = combined.subarray(n);
        if (leftover.length > 0) sock.unshift(leftover);
      }
    };
    const onError = (err: Error) => { sock.off("data", onData); reject(err); };
    const onClose = () => { sock.off("data", onData); reject(new Error("socket closed before header was fully read")); };
    sock.on("data", onData);
    sock.once("error", onError);
    sock.once("close", onClose);
  });
}

function connectRetry(port: number, attempts = 20, delayMs = 150): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const tryOnce = () => {
      tries++;
      const sock = net.connect({ host: "127.0.0.1", port });
      const onError = () => {
        sock.destroy();
        if (tries >= attempts) reject(new Error(`Could not connect to scrcpy tunnel on port ${port} after ${attempts} attempts`));
        else setTimeout(tryOnce, delayMs);
      };
      sock.once("error", onError);
      sock.once("connect", () => { sock.off("error", onError); resolve(sock); });
    };
    tryOnce();
  });
}

/**
 * Pushes the vendored server + starts a scrcpy session against `serial`.
 * Resolves once the video socket's header (device name + codec + resolution)
 * has been read, so callers immediately know real device pixel dimensions.
 */
export async function startScrcpySession(serial: string, opts: { maxSize?: number; bitRate?: number } = {}): Promise<ScrcpySession> {
  if (startingSerials.has(serial)) {
    throw new Error(`A scrcpy session is already being started for ${serial}`);
  }
  startingSerials.add(serial);
  try {
    // The very first launch of app_process right after a fresh `adb forward`
    // occasionally loses the header race on some devices (the server hasn't
    // finished binding its display capture before we connect) — a single
    // clean retry clears that without ever surfacing it to the user as a
    // screenshot fallback. A second consecutive failure is treated as real.
    try {
      return await startScrcpySessionInner(serial, opts);
    } catch (firstErr) {
      logger.warn({ serial, err: firstErr }, "[scrcpy] first session attempt failed, retrying once");
      cleanupStaleSession(serial);
      await new Promise((r) => setTimeout(r, 300));
      return await startScrcpySessionInner(serial, opts);
    }
  } finally {
    startingSerials.delete(serial);
  }
}

async function startScrcpySessionInner(serial: string, opts: { maxSize?: number; bitRate?: number }): Promise<ScrcpySession> {
  const adb = adbPath();

  // 1. Push the server jar. It's tiny (~90KB) — pushing on every session start
  // is simpler and safer than trying to cache/verify a remote checksum.
  const push = spawnSync(adb, ["-s", serial, "push", vendorJarPath(), DEVICE_JAR_PATH], { encoding: "utf8", timeout: 15000 });
  if (push.status !== 0) {
    throw new Error(`Failed to push scrcpy-server to device: ${(push.stderr || push.stdout || "unknown error").trim()}`);
  }

  const scid = crypto.randomBytes(4).toString("hex"); // 8 hex chars, matches scrcpy's scid format
  const sockName = `scrcpy_${scid}`;

  // 2. adb forward tcp:0 -> pick an ephemeral local port ourselves; adb
  // resolves "tcp:0" to a free port and prints it back on stdout.
  const fwd = spawnSync(adb, ["-s", serial, "forward", "tcp:0", `localabstract:${sockName}`], { encoding: "utf8", timeout: 8000 });
  const port = parseInt((fwd.stdout || "").trim(), 10);
  if (fwd.status !== 0 || !Number.isFinite(port) || port <= 0) {
    throw new Error(`adb forward failed: ${(fwd.stderr || fwd.stdout || "no port returned").trim()}`);
  }

  const removeForward = () => {
    try { spawnSync(adb, ["-s", serial, "forward", "--remove", `tcp:${port}`], { timeout: 5000 }); } catch { /* ignore */ }
  };

  // 3. Launch the server on-device. Options are the documented key=value
  // pairs this exact vendored build accepts (verified against its option
  // table). tunnel_forward=true tells the server we (the host) initiate the
  // connections, matching the `adb forward` we just set up.
  const serverArgs = [
    "shell",
    `CLASSPATH=${DEVICE_JAR_PATH}`,
    "app_process",
    "/",
    "com.genymobile.scrcpy.Server",
    SCRCPY_VERSION,
    "log_level=info",
    "video=true",
    "audio=false",
    "control=true",
    "cleanup=true",
    "power_on=true",
    "stay_awake=true",
    "video_codec=h264",
    `video_bit_rate=${opts.bitRate ?? 8_000_000}`,
    `max_size=${opts.maxSize ?? 0}`,
    "tunnel_forward=true",
    `scid=${scid}`,
    "send_device_meta=true",
    "send_codec_meta=true",
    "send_frame_meta=false",
    "send_dummy_byte=false",
    "raw_stream=false",
  ];
  // scrcpy-server's runtime error logging (Ln.e -> android.util.Log) goes to
  // logcat, NOT this process's own stdout/stderr — only its very early
  // bootstrap prints (version checks, etc.) use System.out/err directly. A
  // video-thread failure (e.g. the encoder rejecting the requested
  // size/bitrate) is exactly the kind of runtime error that only shows up in
  // logcat. Clear the buffer right before launch so a post-failure dump is
  // scoped to this session only.
  try { spawnSync(adb, ["-s", serial, "logcat", "-c"], { timeout: 5000 }); } catch { /* ignore */ }
  const serverProc: ChildProcess = spawn(adb, ["-s", serial, ...serverArgs], { stdio: ["ignore", "pipe", "pipe"] });
  let serverOut = "";
  let serverExitCode: number | null | undefined;
  let serverExited = false;
  serverProc.stdout?.on("data", (d: Buffer) => { serverOut += d.toString(); });
  serverProc.stderr?.on("data", (d: Buffer) => { serverOut += d.toString(); });
  serverProc.on("exit", (code) => {
    serverExited = true;
    serverExitCode = code;
    logger.info({ serial, code, output: serverOut.trim().slice(-4000) }, "[scrcpy] server process exited");
  });

  // The on-device server prints exactly why something went wrong (a version
  // mismatch, a permission/API failure grabbing the display, a MediaCodec
  // encoder configuration error, etc.) to stdout/stderr via its own
  // log_level=info logging. Critically, the *process itself does not
  // necessarily exit* when this happens: scrcpy's Server runs video/control
  // (/audio) on separate threads, so a fatal error in the video thread (e.g.
  // the hardware H264 encoder rejecting the requested size/bitrate — a real
  // OEM/SoC compatibility gap, not a crash) can close just the video socket
  // while the control thread — and therefore the whole app_process — keeps
  // running untouched. That's exactly why taps/keys kept working while video
  // failed: two independent threads, only one of them died. Gating our
  // diagnostic message behind "did the process exit" therefore silently
  // swallowed the real reason on any device hitting this pattern. Surface
  // whatever the server has printed so far unconditionally instead.
  const failureReason = (): string | null => {
    const tail = serverOut.trim().slice(-1500);
    if (serverExited) {
      return `scrcpy server exited (code=${serverExitCode})${tail ? `: ${tail}` : " with no output"}`;
    }
    if (tail) {
      return `scrcpy server is still running but reported an error: ${tail}`;
    }
    return null;
  };
  // Back-compat alias for the two call sites below.
  const failIfServerDied = failureReason;

  // Runtime errors inside the server (video encoder config failures, display
  // capture permission issues, etc.) are logged via android.util.Log, which
  // only shows up in logcat — not in this process's own stdout/stderr. Used
  // as a fallback when failureReason() comes back empty.
  const logcatFailureReason = (): string | null => {
    try {
      const dump = spawnSync(adb, ["-s", serial, "logcat", "-d", "-t", "300"], { encoding: "utf8", timeout: 5000 });
      const lines = (dump.stdout || "").split("\n").filter((l) =>
        /scrcpy|Server|MediaCodec|Codec2|OMXClient|SurfaceControl/i.test(l) &&
        /\bE\/|\bW\/|Exception|error/i.test(l),
      );
      if (lines.length === 0) return null;
      return `device logcat around the failure:\n${lines.slice(-40).join("\n")}`;
    } catch {
      return null;
    }
  };

  // A socket 'close' event can fire a beat before the spawned process's own
  // 'exit' event is delivered (they're two independent async notifications
  // for essentially the same crash), so checking failIfServerDied()
  // synchronously right after a socket error/close can race and miss real
  // exit output that lands milliseconds later. Give the exit event a short
  // grace window before giving up on getting a real reason.
  const waitBriefly = (ms: number): Promise<void> =>
    serverExited ? Promise.resolve() : new Promise((resolve) => {
      const onExit = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(() => { serverProc.off("exit", onExit); resolve(); }, ms);
      serverProc.once("exit", onExit);
    });

  let videoSock: net.Socket;
  let controlSock: net.Socket;
  try {
    // 4. Connect twice, in order: video first, then control (audio is
    // disabled so it never opens a socket). Race each connect attempt
    // against the server process dying so a crash surfaces immediately.
    videoSock = await Promise.race([
      connectRetry(port),
      new Promise<net.Socket>((_, reject) => serverProc.once("exit", () => reject(new Error(failIfServerDied() ?? "scrcpy server exited before video connection")))),
    ]);
    controlSock = await Promise.race([
      connectRetry(port),
      new Promise<net.Socket>((_, reject) => serverProc.once("exit", () => reject(new Error(failIfServerDied() ?? "scrcpy server exited before control connection")))),
    ]);
  } catch (err) {
    await waitBriefly(400);
    try { serverProc.kill(); } catch { /* ignore */ }
    removeForward();
    const diedReason = failIfServerDied() ?? logcatFailureReason();
    throw diedReason ? new Error(diedReason) : (err instanceof Error ? err : new Error(String(err)));
  }

  // 5. Parse the one-time video header: 64-byte device name, then 4-byte
  // codec id + 4-byte width + 4-byte height (big-endian), all before the
  // continuous Annex-B stream begins.
  let deviceName = "";
  let width = 0;
  let height = 0;
  try {
    const nameBuf = await readExactly(videoSock, 64);
    deviceName = nameBuf.toString("utf8").replace(/\0+$/, "");
    const codecMeta = await readExactly(videoSock, 12);
    width = codecMeta.readUInt32BE(4);
    height = codecMeta.readUInt32BE(8);
  } catch (err) {
    // Give any in-flight stdout/stderr `data` events (the video thread's own
    // error log line, emitted right before it closes the socket) a brief
    // moment to land before we build the failure message.
    await new Promise((r) => setTimeout(r, 150));
    await waitBriefly(400);
    try { serverProc.kill(); } catch { /* ignore */ }
    videoSock.destroy();
    controlSock.destroy();
    removeForward();
    const diedReason = failureReason() ?? logcatFailureReason();
    throw new Error(diedReason ?? `Failed to read scrcpy video header: ${err instanceof Error ? err.message : String(err)}`);
  }

  logger.info({ serial, deviceName, width, height, port }, "[scrcpy] session established");

  let stopped = false;
  const errorCbs: ((err: Error) => void)[] = [];
  const closeCbs: ((reason: string) => void)[] = [];

  const stop = (reason = "manual stop") => {
    if (stopped) return;
    stopped = true;
    try { serverProc.kill(); } catch { /* ignore */ }
    try { videoSock.destroy(); } catch { /* ignore */ }
    try { controlSock.destroy(); } catch { /* ignore */ }
    removeForward();
    for (const cb of closeCbs) cb(reason);
  };

  videoSock.on("error", (err) => { for (const cb of errorCbs) cb(err); stop(`video socket error: ${err.message}`); });
  videoSock.on("close", () => stop("video socket closed"));
  controlSock.on("error", (err) => { for (const cb of errorCbs) cb(err); });

  const writeControl = (buf: Buffer) => {
    if (stopped || controlSock.destroyed) return;
    controlSock.write(buf);
  };

  const sendTouch = (action: number, x: number, y: number, frameW: number, frameH: number, pressure: number) => {
    // 1 (type) + 1 (action) + 8 (pointerId) + 4+4 (x,y) + 2+2 (screen w/h) + 2 (pressure) + 4 (actionButton) + 4 (buttons)
    const buf = Buffer.alloc(32);
    let o = 0;
    buf.writeUInt8(CTRL_TYPE_INJECT_TOUCH_EVENT, o); o += 1;
    buf.writeUInt8(action, o); o += 1;
    buf.writeBigInt64BE(POINTER_ID_VIRTUAL_FINGER, o); o += 8;
    buf.writeInt32BE(Math.round(x), o); o += 4;
    buf.writeInt32BE(Math.round(y), o); o += 4;
    buf.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(frameW))), o); o += 2;
    buf.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(frameH))), o); o += 2;
    buf.writeUInt16BE(toFixedPoint16(pressure), o); o += 2;
    buf.writeInt32BE(0, o); o += 4; // actionButton
    buf.writeInt32BE(0, o); o += 4; // buttons
    writeControl(buf);
  };

  return {
    serial,
    width,
    height,
    deviceName,
    onVideoData(cb) { videoSock.on("data", cb); },
    onError(cb) { errorCbs.push(cb); },
    onClose(cb) { closeCbs.push(cb); },
    tap(x, y, frameW, frameH) {
      // A real tap is DOWN then UP a beat later — matches how touchscreens
      // actually report events and avoids some apps ignoring a 0-duration press.
      sendTouch(ACTION_DOWN, x, y, frameW, frameH, 1.0);
      setTimeout(() => sendTouch(ACTION_UP, x, y, frameW, frameH, 0.0), 40);
    },
    swipe(x1, y1, x2, y2, frameW, frameH, durationMs = 300) {
      const steps = Math.max(2, Math.round(durationMs / 16));
      sendTouch(ACTION_DOWN, x1, y1, frameW, frameH, 1.0);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        setTimeout(() => {
          const x = x1 + (x2 - x1) * t;
          const y = y1 + (y2 - y1) * t;
          sendTouch(i === steps ? ACTION_UP : ACTION_MOVE, x, y, frameW, frameH, i === steps ? 0.0 : 1.0);
        }, (durationMs * i) / steps);
      }
    },
    keycode(code) {
      // TYPE_INJECT_KEYCODE payload (verified against the vendored server's
      // own ControlMessageReader.parseInjectKeycode, which is the ground
      // truth for what bytes it expects — NOT the constant 4-byte-per-field
      // layout you'd guess from the desktop client's writer alone):
      // action(1 byte, unsigned) + keycode(4) + repeat(4) + metaState(4) = 13
      // bytes after the 1-byte message type, 14 total.
      const down = Buffer.alloc(14);
      down.writeUInt8(CTRL_TYPE_INJECT_KEYCODE, 0);
      down.writeUInt8(KEY_ACTION_DOWN, 1);
      down.writeInt32BE(code, 2);
      down.writeInt32BE(0, 6);  // repeat
      down.writeInt32BE(0, 10); // metaState
      const up = Buffer.from(down);
      up.writeUInt8(KEY_ACTION_UP, 1);
      writeControl(down);
      setTimeout(() => writeControl(up), 30);
    },
    stop,
  };
}

/**
 * Best-effort cleanup for a serial's leftover scrcpy server process and
 * `adb forward` tunnels from a previous crashed/interrupted session. Safe to
 * call even if nothing is running. `forward --remove-all` is scoped to this
 * device only (adb's `-s <serial>` targets the remove to that device's
 * forwards), so it can't disturb another connected phone's tunnels. The
 * mobile-farm proxy relay (`proxyRelay.ts`) uses `adb reverse`, a completely
 * separate tunnel table, so this doesn't touch it either.
 */
export function cleanupStaleSession(serial: string): void {
  try { runAdbSync(serial, ["shell", "pkill", "-f", "com.genymobile.scrcpy.Server"], 3000); } catch { /* ignore */ }
  try { runAdbSync(serial, ["forward", "--remove-all"], 3000); } catch { /* ignore */ }
}

// Guards against two overlapping session-start requests for the same serial
// (e.g. a client reconnecting before the previous WS's close handler has run)
// racing each other's adb forward/push/spawn calls.
const startingSerials = new Set<string>();

export function isStartingSession(serial: string): boolean {
  return startingSerials.has(serial);
}
