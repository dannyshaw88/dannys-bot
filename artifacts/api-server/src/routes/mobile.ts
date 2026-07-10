import type { Express, Request, Response } from "express";
import { spawnSync, spawn, execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod/v4";
import fs from "fs";
import path from "path";
import * as http from "http";
import * as os from "os";
import { WebSocketServer } from "ws";
import * as android from "../mobile/androidManager";
import * as proxyRelay from "../mobile/proxyRelay";
// NOTE: src/mobile/scrcpyServer.ts implements a real scrcpy-server protocol
// client that was meant to replace the screenrecord-based mirror below (to
// fix screenrecord's MIUI keyguard-freeze issue), but it has never
// successfully completed its handshake against real hardware in testing —
// see the comment above the video WebSocket route. Left unused but in place
// for whoever picks this up next; do not wire it back in without confirming
// a real device actually streams frames.
import { storage } from "../storage";
import { logger } from "../lib/logger";

const execFileP = promisify(execFile);

// In-memory cache for android IDs — avoids repeated slow ADB reads after a
// successful write. Keyed by device serial. Cleared only on server restart or
// explicit reset; the value on-device is the source of truth for first-read.
const androidIdCache = new Map<string, string>();

/** Makes a plain HTTP proxy request to api.ipify.org through the given upstream. */
function fetchExternalIpViaProxy(host: string, port: number, user?: string, pass?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const authHeader = user
      ? `Basic ${Buffer.from(`${user}:${pass ?? ""}`).toString("base64")}`
      : null;
    const req = http.request(
      {
        host,
        port,
        method: "GET",
        path: "http://api.ipify.org/",
        headers: {
          Host: "api.ipify.org",
          "User-Agent": "curl/8.0",
          ...(authHeader ? { "Proxy-Authorization": authHeader } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data.trim()));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(12000, () => req.destroy(new Error("IP check timed out after 12 s")));
    req.end();
  });
}

const p = (req: Request, key: string): string => String((req.params as any)[key] ?? "");

// ── Per-instance config (proxy assignment) ────────────────────────────────────
// Stored in userData (via EQUINOX_DATA_DIR env var) so it survives app updates.
// Falls back to process.cwd() in dev / non-Electron environments.
type AutomationSettings = {
  cycleIntervalMin?: number;
  cycleIntervalMax?: number;
  enabled: boolean;
  actionDelayMin: number;
  actionDelayMax: number;
  likePercentMin: number;
  likePercentMax: number;
  shareFeedPercentMin: number;
  shareFeedPercentMax: number;
  shareDmPercentMin: number;
  shareDmPercentMax: number;
  feedScrollMin: number;
  feedScrollMax: number;
  viewStoriesUsersMin: number;
  viewStoriesUsersMax: number;
  viewStoriesSlidesMin: number;
  viewStoriesSlidesMax: number;
  viewStoriesSlideWatchPctMin: number;
  viewStoriesSlideWatchPctMax: number;
};
type DeviceSlot = { username: string; password: string; totpSecret?: string };
type DeviceAccount = { slots: DeviceSlot[] };
type InstanceConfig = { proxyId?: number | null; proxyProtocol?: "http" | "socks5"; proxyPort?: number | null; sourceInterface?: string | null; automation?: AutomationSettings; account?: DeviceAccount };
type InstanceConfigMap = Record<string, InstanceConfig>;

function configFilePath(): string {
  const base = process.env.EQUINOX_DATA_DIR ?? process.cwd();
  return path.join(base, "mobile-instances.json");
}
function loadInstanceConfigs(): InstanceConfigMap {
  try {
    const raw = fs.readFileSync(configFilePath(), "utf8");
    return JSON.parse(raw) as InstanceConfigMap;
  } catch { return {}; }
}
function saveInstanceConfigs(cfg: InstanceConfigMap): void {
  fs.writeFileSync(configFilePath(), JSON.stringify(cfg, null, 2));
}

/**
 * Strip CRLF pairs injected by Windows ADB exec-out into binary streams.
 * On Windows, ADB exec-out can convert \n (0x0A) bytes to \r\n (0x0D 0x0A),
 * which corrupts PNG files whose zlib blocks happen to contain 0x0A bytes.
 * We detect this by checking the PNG magic header: a valid PNG always starts
 * with 0x89 0x50 (the first two bytes of \x89PNG).  If the buffer doesn't
 * start with those bytes we strip all 0x0D 0x0A → 0x0A pairs and recheck.
 */
function stripCrlf(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0D && i + 1 < buf.length && buf[i + 1] === 0x0A) {
      out[j++] = 0x0A;
      i++; // skip the extra \r
    } else {
      out[j++] = buf[i]!;
    }
  }
  return j === buf.length ? buf : out.subarray(0, j);
}

/** Returns true when buf starts with the PNG magic number (\x89PNG). */
function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
}

export function registerMobileRoutes(httpServer: http.Server, app: Express) {
  // ── Screen mirror WebSocket stream ─────────────────────────────────────────
  const screenWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "";
    logger.info({ url }, "[mobile-ws] upgrade request received");
    const m = url.match(/^\/api\/mobile\/screen\/([^/?#]+)/);
    if (!m) {
      logger.info({ url }, "[mobile-ws] URL did not match screen route — ignoring");
      return;
    }
    const serial = decodeURIComponent(m[1]);
    logger.info({ serial }, "[mobile-ws] upgrading connection for device");
    // Mark the socket so the instagram upgrade handler (registered later) knows
    // not to call socket.destroy() on it — it destroys every socket it doesn't
    // recognise, which kills this connection after we've already claimed it.
    (socket as any).__wsHandled = true;
    screenWss.handleUpgrade(request, socket as any, head, (ws) => {
      logger.info({ serial }, "[mobile-ws] WebSocket handshake complete");
      const tools = android.detectToolset();
      const adbPath = tools.adb.path;
      logger.info({ adbFound: !!adbPath, adbPath }, "[mobile-ws] ADB toolset check");
      if (!adbPath) {
        logger.warn({ serial }, "[mobile-ws] ADB not found — closing socket");
        ws.send(JSON.stringify({ error: "ADB not found on this machine" }));
        ws.close();
        return;
      }

      // Check that the device is actually connected before starting the loop
      const deviceCheck = spawnSync(adbPath, ["devices"], { encoding: "utf8", timeout: 5000 });
      const devicesOutput = deviceCheck.stdout ?? "";
      logger.info({ serial, devicesOutput }, "[mobile-ws] adb devices output at connection time");
      const deviceLine = devicesOutput.split("\n").find(l => l.startsWith(serial));
      if (!deviceLine) {
        logger.warn({ serial, devicesOutput }, "[mobile-ws] serial not found in adb devices — closing");
        ws.send(JSON.stringify({ error: `Device ${serial} not found in adb devices list` }));
        ws.close();
        return;
      }
      const deviceState = deviceLine.split("\t")[1]?.trim() ?? "unknown";
      logger.info({ serial, deviceState }, "[mobile-ws] device state from adb devices");
      if (deviceState !== "device") {
        logger.warn({ serial, deviceState }, "[mobile-ws] device not in ready state");
        ws.send(JSON.stringify({ error: `Device state is "${deviceState}" — expected "device". Check USB Debugging.` }));
        ws.close();
        return;
      }

      let running = true;
      let frameCount = 0;
      let screenOffStreak = 0; // consecutive 0-byte frames

      // Helper: fire-and-forget ADB shell command (non-blocking)
      const adbShell = (...args: string[]) =>
        spawn(adbPath, ["-s", serial, "shell", ...args], { stdio: "ignore" });

      // Disable screen timeout for this session so the phone stays awake.
      // We save the original value and restore it on disconnect.
      let originalScreenTimeout = "30000"; // fallback default
      try {
        const st = spawnSync(adbPath, ["-s", serial, "shell", "settings", "get", "system", "screen_off_timeout"], { encoding: "utf8", timeout: 3000 });
        const val = st.stdout?.trim();
        if (val && /^\d+$/.test(val)) originalScreenTimeout = val;
      } catch { /* ignore */ }
      adbShell("settings", "put", "system", "screen_off_timeout", "2147483647");
      logger.info({ serial, originalScreenTimeout }, "[mobile-ws] screen timeout disabled for session");

      ws.on("close", (code, reason) => {
        logger.info({ serial, code, reason: reason?.toString() }, "[mobile-ws] client disconnected");
        running = false;
        // Restore original screen timeout
        try { adbShell("settings", "put", "system", "screen_off_timeout", originalScreenTimeout); } catch { /* ignore */ }
        logger.info({ serial, originalScreenTimeout }, "[mobile-ws] screen timeout restored");
      });
      ws.on("error", (err) => {
        logger.error({ serial, err }, "[mobile-ws] WebSocket error");
        running = false;
      });

      logger.info({ serial, adbPath }, "[mobile-ws] starting screencap loop");
      (async () => {
        while (running) {
          try {
            await new Promise<void>((resolve) => {
              const child = spawn(adbPath, ["-s", serial, "exec-out", "screencap", "-p"]);
              const chunks: Buffer[] = [];
              let stderrOut = "";
              child.stdout.on("data", (d: Buffer) => chunks.push(d));
              child.stderr?.on("data", (d: Buffer) => { stderrOut += d.toString(); });
              child.on("error", (err) => {
                logger.error({ serial, err }, "[mobile-ws] spawn error for screencap");
                resolve();
              });
              child.on("close", (code) => {
                let frame = Buffer.concat(chunks);
                const rawLen = frame.length;
                const first4 = frame.length >= 4
                  ? [...frame.subarray(0, 4)].map(b => b.toString(16).padStart(2, "0")).join(" ")
                  : "too short";

                if (frame.length > 8 && !isPng(frame)) {
                  frame = stripCrlf(frame);
                }
                const validPng = isPng(frame);

                if (frameCount === 0 || frameCount % 20 === 0) {
                  // Log every 20th frame to avoid flooding — always log the first
                  logger.info({
                    serial, frameCount, code, rawLen, frameLen: frame.length,
                    first4bytes: first4, validPng, stderr: stderrOut.trim() || null,
                  }, "[mobile-ws] screencap frame");
                }
                frameCount++;

                if (validPng && ws.readyState === 1) {
                  if (screenOffStreak > 0) {
                    // Screen came back — clear streak and tell client
                    screenOffStreak = 0;
                    if (ws.readyState === 1) ws.send(JSON.stringify({ info: "Screen woke up" }));
                  }
                  ws.send(frame, (err) => { if (err) { logger.error({ serial, err }, "[mobile-ws] send error"); running = false; } });
                } else if (!validPng && ws.readyState === 1) {
                  if (rawLen === 0) {
                    screenOffStreak++;
                    // Only notify client once when it first goes dark, then every 10s
                    if (screenOffStreak === 1 || screenOffStreak % 20 === 0) {
                      const msg = "Screen is off or locked — waking…";
                      logger.warn({ serial, screenOffStreak }, `[mobile-ws] ${msg}`);
                      ws.send(JSON.stringify({ error: msg }));
                    }
                    // Do NOT send WAKEUP here — the screencap loop must never
                    // fight against the phone sleeping between automation cycles.
                  } else {
                    screenOffStreak = 0;
                    const msg = `screencap returned ${rawLen} bytes but not a valid PNG (first bytes: ${first4}) — ${stderrOut.trim() || "no stderr"}`;
                    logger.warn({ serial, rawLen, first4, stderrOut: stderrOut.trim() }, `[mobile-ws] ${msg}`);
                    ws.send(JSON.stringify({ error: msg }));
                  }
                }
                resolve();
              });
            });
          } catch (err) {
            logger.error({ serial, err }, "[mobile-ws] screencap loop error");
          }
          // Back off when the screen is off, but not so much that a click-to-wake
          // feels unresponsive — 400ms keeps the "did my tap wake it" feedback loop
          // fast while still not hammering adb every 150ms while asleep.
          // NOTE: this loop delay is only part of the latency budget — each
          // frame also costs the time for `adb exec-out screencap -p` to run
          // on the device itself (PNG capture + USB transfer), typically
          // 150-400ms depending on the phone. That per-frame cost is inherent
          // to the screencap approach and is NOT eliminated by lowering this
          // delay; a truly "instant" (~30fps) mirror requires switching to a
          // continuous H.264 stream (e.g. scrcpy) instead of discrete PNG
          // captures. See CHANGELOG for details.
          const delay = screenOffStreak > 0 ? 400 : 150;
          if (running) await new Promise<void>(r => setTimeout(r, delay));
        }
        logger.info({ serial, frameCount }, "[mobile-ws] screencap loop ended");
      })();
    });
  });

  // ── Live H.264 video mirror (real-time stream, not screenshot polling) ─────
  // Reverted to the `screenrecord`-based mirror (confirmed working at ~30fps
  // on real hardware). We tried replacing this with a real scrcpy-server
  // protocol client (see src/mobile/scrcpyServer.ts) to fix screenrecord's
  // MIUI keyguard-freeze issue, but across every test on this hardware the
  // scrcpy session never completed its handshake — the video socket header
  // never arrived ("socket closed before header was fully read") even with
  // a logcat-failure fallback added — so it silently produced *zero* frames,
  // which is strictly worse than screenrecord's occasional stall-and-restart.
  // Until scrcpy's handshake failure is root-caused against real device
  // logcat output, screenrecord is the working path — do not swap this out
  // again without confirming a real device actually streams frames first.
  //
  // Uses the on-device `screenrecord` binary (built into Android since API 19,
  // no scrcpy/root/extra install required) to continuously encode the screen
  // as raw H.264 and pipe it straight to the browser over this WebSocket. The
  // browser demuxes Annex-B access units and decodes them with WebCodecs —
  // this is what gives near-instant (~30fps) mirroring instead of the old
  // "adb exec-out screencap" polling loop, which paid a full PNG capture cost
  // (150-400ms) per frame.
  //
  // `screenrecord` has a hard --time-limit cap (180s on most Android builds)
  // per invocation, so we transparently respawn it when it exits and keep
  // streaming — the browser-side decoder just sees a short gap.
  const videoWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "";
    const m = url.match(/^\/api\/mobile\/video\/([^/?#]+)/);
    if (!m) return;
    const serial = decodeURIComponent(m[1]);
    (socket as any).__wsHandled = true;
    logger.info({ serial }, "[mobile-video] upgrading connection for device");
    videoWss.handleUpgrade(request, socket as any, head, (ws) => {
      const tools = android.detectToolset();
      const adbPath = tools.adb.path;
      if (!adbPath) {
        ws.send(JSON.stringify({ error: "ADB not found on this machine" }));
        ws.close();
        return;
      }

      const deviceCheck = spawnSync(adbPath, ["devices"], { encoding: "utf8", timeout: 5000 });
      const deviceLine = (deviceCheck.stdout ?? "").split("\n").find(l => l.startsWith(serial));
      if (!deviceLine || deviceLine.split("\t")[1]?.trim() !== "device") {
        ws.send(JSON.stringify({ error: `Device ${serial} not found or not ready` }));
        ws.close();
        return;
      }

      let running = true;
      let restartCount = 0;
      let currentChild: ReturnType<typeof spawn> | null = null;

      const adbShell = (...args: string[]) =>
        spawn(adbPath, ["-s", serial, "shell", ...args], { stdio: "ignore" });

      // Keep the screen awake for the duration of the mirror session — same
      // trick as the PNG endpoint, but doubly important here: if the display
      // actually powers off, screenrecord stops producing frames entirely.
      let originalScreenTimeout = "30000";
      try {
        const st = spawnSync(adbPath, ["-s", serial, "shell", "settings", "get", "system", "screen_off_timeout"], { encoding: "utf8", timeout: 3000 });
        const val = st.stdout?.trim();
        if (val && /^\d+$/.test(val)) originalScreenTimeout = val;
      } catch { /* ignore */ }
      adbShell("settings", "put", "system", "screen_off_timeout", "2147483647");
      // WAKEUP and dismiss-keyguard intentionally removed: auto-waking on
      // connect was the root cause of the phone constantly waking between
      // automation cycles. Wake is now exclusively user-triggered (canvas tap).

      // NOTE: we intentionally do NOT force `--size` to the device's exact
      // `wm size` here. screenrecord's encoder on many devices requires
      // width/height to be 16-pixel-aligned; most phone resolutions (e.g.
      // 1080x2400) are NOT multiples of 16, so pinning the raw wm-size value
      // made screenrecord fail to start at all (symptom: stream never
      // produces data — "waiting for screen data" forever). Instead we let
      // screenrecord pick its own (possibly downscaled) size, and correct
      // tap coordinates for the mismatch server-side in the /input/tap route
      // by scaling from the video's reported size to the device's real size.

      let cleanedUp = false;
      const cleanup = (reason: string) => {
        if (cleanedUp) return; // idempotent — close fires after error too
        cleanedUp = true;
        running = false;
        try { currentChild?.kill(); } catch { /* ignore */ }
        try { adbShell("settings", "put", "system", "screen_off_timeout", originalScreenTimeout); } catch { /* ignore */ }
        logger.info({ serial, reason }, "[mobile-video] session cleaned up");
      };
      ws.on("close", () => cleanup("close"));
      ws.on("error", (err) => { logger.error({ serial, err }, "[mobile-video] WebSocket error"); cleanup("error"); });

      const spawnStream = () => {
        if (!running || ws.readyState !== 1) return;
        // --output-format=h264: raw Annex-B elementary stream (no MP4 container)
        // straight to stdout via `exec-out` — this is what lets us pipe it
        // directly into a WebSocket frame-by-frame with zero temp files.
        const args = [
          "-s", serial, "exec-out", "screenrecord",
          "--output-format=h264",
          "--bit-rate", "8000000",
          "--time-limit", "180",
          "-",
        ];
        const child = spawn(adbPath, args);
        currentChild = child;
        let sawAnyData = false;
        let bytesTotal = 0;
        let stderrOut = "";

        // screenrecord on some OEM builds (MIUI especially) will hand back
        // SPS/PPS and then go completely silent — no more stdout, no exit,
        // no error — if the virtual display it's mirroring stops producing
        // new frames (keyguard re-engaging, always-on-display swallowing the
        // real screen, DRM/secure-surface blocking, etc). That looks exactly
        // like "connected but frozen forever" from the client's side. Watch
        // for a stall and force a fresh screenrecord + re-poke the device
        // rather than hanging indefinitely.
        let stallTimer: NodeJS.Timeout | null = null;
        const armStall = (ms: number) => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            logger.warn({ serial, bytesTotal }, "[mobile-video] stream stalled — no data for 6s, forcing restart");
            if (ws.readyState === 1) ws.send(JSON.stringify({ info: "Stream stalled — screen may be off. Tap the mirror to wake." }));
            // WAKEUP intentionally omitted: wake must only come from user input.
            try { child.kill(); } catch { /* ignore — close handler restarts */ }
          }, ms);
        };
        armStall(6_000);

        child.stdout.on("data", (chunk: Buffer) => {
          sawAnyData = true;
          bytesTotal += chunk.length;
          armStall(6_000);
          if (ws.readyState === 1) ws.send(chunk);
        });
        child.stderr?.on("data", (d: Buffer) => {
          const line = d.toString().trim();
          stderrOut += line;
          if (line && ws.readyState === 1) ws.send(JSON.stringify({ info: `[screenrecord] ${line}` }));
        });
        child.on("error", (err) => {
          if (stallTimer) clearTimeout(stallTimer);
          logger.error({ serial, err }, "[mobile-video] spawn error for screenrecord");
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ error: `Failed to start screenrecord: ${err.message}`, fatal: true }));
            ws.close();
          }
          cleanup("screenrecord spawn error");
        });
        child.on("close", (code) => {
          if (stallTimer) clearTimeout(stallTimer);
          currentChild = null;
          if (!running) return;
          if (!sawAnyData) {
            // screenrecord never produced a byte — likely unsupported on this
            // device/Android version. Tell the client so it can fall back to
            // the PNG polling stream instead of retrying forever.
            logger.warn({ serial, code, stderr: stderrOut.trim() }, "[mobile-video] screenrecord produced no data — unsupported?");
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ error: `screenrecord unavailable on this device (${stderrOut.trim() || `exit ${code}`})`, fatal: true }));
              ws.close();
            }
            running = false;
            return;
          }
          // Hit the --time-limit, was stalled, or was killed for some other
          // transient reason — restart immediately to keep the stream going.
          restartCount++;
          logger.info({ serial, restartCount, code, bytesTotal }, "[mobile-video] screenrecord cycle ended — restarting");
          spawnStream();
        });
      };

      logger.info({ serial, adbPath }, "[mobile-video] starting screenrecord stream");
      spawnStream();
    });
  });

  // ── Screen size ────────────────────────────────────────────────────────────
  app.get("/api/mobile/devices/:serial/screen-size", async (req: Request, res: Response) => {
    try {
      const tools = android.detectToolset();
      const adbPath = tools.adb.path;
      if (!adbPath) { res.status(503).json({ error: "ADB not found" }); return; }
      const { stdout } = await execFileP(adbPath, ["-s", p(req, "serial"), "shell", "wm", "size"], { timeout: 5000 } as any);
      const m = String(stdout).match(/(\d+)x(\d+)/);
      if (m) { res.json({ width: parseInt(m[1]), height: parseInt(m[2]) }); }
      else { res.status(500).json({ error: "Could not parse screen size" }); }
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });
  // ── Network interfaces (for source-adapter picker in UI) ───────────────────
  app.get("/api/network/interfaces", (_req: Request, res: Response) => {
    const raw = os.networkInterfaces();
    const result: { name: string; ip: string; family: string }[] = [];
    for (const [name, addrs] of Object.entries(raw)) {
      for (const addr of addrs ?? []) {
        if (!addr.internal) {
          result.push({ name, ip: addr.address, family: addr.family });
        }
      }
    }
    res.json(result);
  });

  app.get("/api/mobile/status", async (_req: Request, res: Response) => {
    try {
      const toolset = android.detectToolset();
      res.json({
        platform: process.platform,
        toolset,
        // ready = can start emulators (adb + emulator); canCreate = can make AVDs (avdmanager)
        ready: toolset.adb.found && toolset.emulator.found,
        canCreate: toolset.avdmanager.found,
      });
    } catch (e: any) {
      logger.error({ err: e }, "mobile status failed");
      res.status(500).json({ error: e?.message ?? "Status check failed" });
    }
  });

  app.get("/api/mobile/avds", async (_req: Request, res: Response) => {
    try {
      const avds = await android.getAvdInfo();
      const devices = await android.listDevices();
      res.json({ avds, devices });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Failed to list AVDs" });
    }
  });

  const createSchema = z.object({
    name: z.string().min(1).regex(/^[A-Za-z0-9_\-]+$/, "Only letters, numbers, underscore, dash"),
    systemImage: z.string().optional(),
  });
  app.post("/api/mobile/avds", async (req: Request, res: Response) => {
    try {
      const input = createSchema.parse(req.body);
      await android.createAvd(input.name, input.systemImage);
      res.json({ ok: true, name: input.name });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Failed to create AVD" });
    }
  });

  // ── Connect / disconnect emulator ─────────────────────────────────────────────
  const connectSchema = z.object({ address: z.string().min(1) });
  app.post("/api/mobile/connect", async (req: Request, res: Response) => {
    try {
      const { address } = connectSchema.parse(req.body);
      const result = await android.connectDevice(address);
      res.json(result);
    } catch (e: any) { res.status(400).json({ ok: false, message: e?.message }); }
  });

  app.post("/api/mobile/disconnect", async (req: Request, res: Response) => {
    try {
      const { address } = connectSchema.parse(req.body);
      await android.disconnectDevice(address);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ ok: false, message: e?.message }); }
  });

  app.post("/api/mobile/discover", async (_req: Request, res: Response) => {
    try {
      const results = await android.autoDiscoverEmulators();
      res.json({ results });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  // ── Per-device automation settings (isolated to the Mobile tab) ─────────────
  const automationSchema = z.object({
    enabled: z.boolean().default(false),
    cycleIntervalMin: z.number().min(1).max(9999).optional(),
    cycleIntervalMax: z.number().min(1).max(9999).optional(),
    actionDelayMin: z.number().min(0).max(9999),
    actionDelayMax: z.number().min(0).max(9999),
    likePercentMin: z.number().min(0).max(100),
    likePercentMax: z.number().min(0).max(100),
    shareFeedPercentMin: z.number().min(0).max(100).default(0),
    shareFeedPercentMax: z.number().min(0).max(100).default(0),
    shareDmPercentMin: z.number().min(0).max(100).default(0),
    shareDmPercentMax: z.number().min(0).max(100).default(0),
    feedScrollMin: z.number().min(1).max(50),
    feedScrollMax: z.number().min(1).max(50),
    viewStoriesUsersMin: z.number().min(0).max(50).default(0),
    viewStoriesUsersMax: z.number().min(0).max(50).default(0),
    viewStoriesSlidesMin: z.number().min(1).max(50).default(3),
    viewStoriesSlidesMax: z.number().min(1).max(50).default(6),
    viewStoriesSlideWatchPctMin: z.number().min(1).max(100).default(50),
    viewStoriesSlideWatchPctMax: z.number().min(1).max(100).default(90),
  });
  app.get("/api/mobile/devices/:serial/automation-settings", (req: Request, res: Response) => {
    const cfg = loadInstanceConfigs();
    const defaults: AutomationSettings = {
      enabled: false, cycleIntervalMin: 20, cycleIntervalMax: 30,
      actionDelayMin: 5, actionDelayMax: 10,
      likePercentMin: 3, likePercentMax: 5,
      shareFeedPercentMin: 0, shareFeedPercentMax: 0,
      shareDmPercentMin: 0, shareDmPercentMax: 0,
      feedScrollMin: 5, feedScrollMax: 10,
      viewStoriesUsersMin: 0, viewStoriesUsersMax: 0,
      viewStoriesSlidesMin: 3, viewStoriesSlidesMax: 6,
      viewStoriesSlideWatchPctMin: 50, viewStoriesSlideWatchPctMax: 90,
    };
    res.json({ ...defaults, ...cfg[p(req, "serial")]?.automation });
  });
  app.post("/api/mobile/devices/:serial/automation-settings", (req: Request, res: Response) => {
    try {
      const input = automationSchema.parse(req.body);
      const serial = p(req, "serial");
      const cfg = loadInstanceConfigs();
      cfg[serial] = { ...cfg[serial], automation: input };
      saveInstanceConfigs(cfg);
      res.json({ ok: true, automation: input });
    } catch (e: any) { res.status(400).json({ error: e?.message ?? "Failed to save automation settings" }); }
  });

  // ── Per-device linked Instagram account (Account Settings tab) ──────────────
  const SLOT_COUNT = 5;
  const deviceSlotSchema = z.object({
    username: z.string(),
    password: z.string(),
    totpSecret: z.string().optional(),
  });
  const deviceAccountSchema = z.object({
    // No upper-bound cap — users can add as many slots as they need via the UI
    slots: z.array(deviceSlotSchema).min(0),
  });
  const emptySlots = (): DeviceSlot[] => Array.from({ length: SLOT_COUNT }, () => ({ username: "", password: "" }));
  const migrateAccount = (raw: any): DeviceAccount => {
    if (raw && Array.isArray(raw.slots)) return raw as DeviceAccount;
    // Legacy single-account format → migrate into slot 0
    if (raw && typeof raw.username === "string") {
      const slots = emptySlots();
      slots[0] = { username: raw.username, password: raw.password ?? "", totpSecret: raw.totpSecret };
      return { slots };
    }
    return { slots: emptySlots() };
  };
  app.get("/api/mobile/devices/:serial/account", (req: Request, res: Response) => {
    const cfg = loadInstanceConfigs();
    const raw = cfg[p(req, "serial")]?.account ?? null;
    res.json(migrateAccount(raw));
  });
  app.post("/api/mobile/devices/:serial/account", (req: Request, res: Response) => {
    try {
      const input = deviceAccountSchema.parse(req.body);
      // Ensure at least SLOT_COUNT slots are always stored
      while (input.slots.length < SLOT_COUNT) input.slots.push({ username: "", password: "" });
      const serial = p(req, "serial");
      const cfg = loadInstanceConfigs();
      cfg[serial] = { ...cfg[serial], account: input };
      saveInstanceConfigs(cfg);
      res.json({ ok: true, account: input });
    } catch (e: any) { res.status(400).json({ error: e?.message ?? "Failed to save the account" }); }
  });

  // ── Check Feed — N downward scrolls over the Instagram feed currently on
  // screen. Opening Instagram/navigating to the feed is out of scope for now
  // (per user instruction) — this just drives the scroll gesture repeatedly
  // against whatever is currently visible on the device. A configurable
  // percentage of scrolls also get a double-tap (like) on the post left on
  // screen, and the pacing between actions honors the user's delay setting
  // (seconds) instead of a hardcoded pause.
  const checkFeedSchema = z.object({
    count: z.number().min(1).max(50),
    delayMinSec: z.number().min(0).max(120).default(5),
    delayMaxSec: z.number().min(0).max(120).default(10),
    likePercentMin: z.number().min(0).max(100).default(0),
    likePercentMax: z.number().min(0).max(100).default(0),
  });
  const checkFeedInProgress = new Set<string>();

  // Per-cycle abort tracking.  Each new cycle is assigned a random ID that is
  // passed by the frontend in both the cycle POST body and the abort POST body.
  // The abort endpoint only sets the flag when the supplied ID matches the ID
  // of the cycle that is currently running, so a stale abort POST that arrives
  // after the next cycle has already started cannot kill the new cycle.
  const automationCycleCurrentId  = new Map<string, string>(); // serial → running cycle ID
  const automationCycleAbortedId  = new Map<string, string>(); // serial → ID that was aborted

  const isCycleAborted = (serial: string) =>
    automationCycleAbortedId.get(serial) !== undefined &&
    automationCycleAbortedId.get(serial) === automationCycleCurrentId.get(serial);

  // Helper: sleep with abort-check. Throws "cycle-aborted" if the abort flag
  // for this specific cycle has been set.
  const sleepOrAbort = (serial: string, ms: number) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        if (isCycleAborted(serial)) reject(new Error("cycle-aborted"));
        else resolve();
      }, ms);
      // Also check immediately for zero-ms waits
      if (ms <= 0) { clearTimeout(t); isCycleAborted(serial) ? reject(new Error("cycle-aborted")) : resolve(); }
    });

  // Helper: get screen dimensions via adb wm size.
  function getScreenSize(serial: string): { w: number; h: number } {
    let w = 1080, h = 2400;
    try {
      const tools = android.detectToolset();
      const adbPath = tools.adb.path;
      if (adbPath) {
        const wm = spawnSync(adbPath, ["-s", serial, "shell", "wm", "size"], { encoding: "utf8", timeout: 3000 });
        const m = (wm.stdout ?? "").match(/(\d+)x(\d+)/);
        if (m) { w = parseInt(m[1]); h = parseInt(m[2]); }
      }
    } catch { /* fall back to defaults above */ }
    return { w, h };
  }

  // Shared by the standalone `/check-feed` route and the full
  // `/automation-cycle` route below — the scroll/like/share loop.
  async function runCheckFeedLoop(serial: string, params: {
    count: number; delayMinSec: number; delayMaxSec: number;
    likePercentMin: number; likePercentMax: number;
    shareFeedPercentMin?: number; shareFeedPercentMax?: number;
    shareDmPercentMin?: number; shareDmPercentMax?: number;
  }): Promise<{ count: number; likes: number; likeFailures: number; sharesFeed: number; sharesDm: number }> {
    const {
      count, delayMinSec, delayMaxSec, likePercentMin, likePercentMax,
      shareFeedPercentMin = 0, shareFeedPercentMax = 0,
      shareDmPercentMin = 0, shareDmPercentMax = 0,
    } = params;
    const delayLoSec = Math.min(delayMinSec, delayMaxSec);
    const delayHiSec = Math.max(delayMinSec, delayMaxSec);
    const likeLoPct = Math.min(likePercentMin, likePercentMax);
    const likeHiPct = Math.max(likePercentMin, likePercentMax);
    const likeChance = (likeLoPct + Math.random() * (likeHiPct - likeLoPct)) / 100;
    const shareFeedLo = Math.min(shareFeedPercentMin, shareFeedPercentMax);
    const shareFeedHi = Math.max(shareFeedPercentMin, shareFeedPercentMax);
    const shareFeedChance = (shareFeedLo + Math.random() * (shareFeedHi - shareFeedLo)) / 100;
    const shareDmLo = Math.min(shareDmPercentMin, shareDmPercentMax);
    const shareDmHi = Math.max(shareDmPercentMin, shareDmPercentMax);
    const shareDmChance = (shareDmLo + Math.random() * (shareDmHi - shareDmLo)) / 100;

    const { w, h } = getScreenSize(serial);
    const x  = Math.round(w / 2);
    const y1 = Math.round(h * 0.78);
    const y2 = Math.round(h * 0.22);
    const cy = Math.round(h / 2);
    // Instagram action bar (like/comment/share/bookmark row) position.
    // On a standard feed post the row sits at roughly 72% of screen height.
    const actionBarY = Math.round(h * 0.72);
    const shareIconX = Math.round(w * 0.33); // paper-airplane send/share button

    let likes = 0;
    let likeFailures = 0;
    let sharesFeed = 0;
    let sharesDm = 0;
    for (let i = 0; i < count; i++) {
      if (isCycleAborted(serial)) throw new Error("cycle-aborted");
      await android.swipe(serial, x, y1, x, y2, 550 + Math.round(Math.random() * 200));
      await sleepOrAbort(serial, 180);

      if (likeChance > 0 && Math.random() < likeChance) {
        const jx = x + Math.round((Math.random() - 0.5) * w * 0.04);
        const jy = cy + Math.round((Math.random() - 0.5) * h * 0.03);
        await sleepOrAbort(serial, 250 + Math.round(Math.random() * 250));
        try {
          await android.doubleTap(serial, jx, jy);
          likes++;
        } catch {
          likeFailures++;
        }
      }

      // Share to Feed (repost to own story/feed): tap the send/share icon,
      // then tap the "Repost" option in the share sheet.
      if (shareFeedChance > 0 && Math.random() < shareFeedChance) {
        if (isCycleAborted(serial)) throw new Error("cycle-aborted");
        try {
          await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300));
          await android.tap(serial, shareIconX, actionBarY);
          await sleepOrAbort(serial, 1200); // wait for sheet to open
          // "Repost" option appears in the share sheet at roughly 30% height
          await android.tap(serial, Math.round(w * 0.5), Math.round(h * 0.30));
          await sleepOrAbort(serial, 800);
          // Dismiss sheet (swipe down from center)
          await android.swipe(serial, Math.round(w / 2), Math.round(h * 0.6), Math.round(w / 2), Math.round(h * 0.9), 300);
          await sleepOrAbort(serial, 600);
          sharesFeed++;
        } catch (e: any) { if (e?.message === "cycle-aborted") throw e; /* else non-fatal */ }
      }

      // Share via DM: tap the send/share icon, then tap the first suggested
      // user in the DM picker list.
      if (shareDmChance > 0 && Math.random() < shareDmChance) {
        if (isCycleAborted(serial)) throw new Error("cycle-aborted");
        try {
          await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300));
          await android.tap(serial, shareIconX, actionBarY);
          await sleepOrAbort(serial, 1200); // wait for DM picker
          // First suggested recipient avatar row sits at roughly 55% height
          await android.tap(serial, Math.round(w * 0.17), Math.round(h * 0.55));
          await sleepOrAbort(serial, 500);
          // Tap "Send" button (right side of the composer row)
          await android.tap(serial, Math.round(w * 0.85), Math.round(h * 0.90));
          await sleepOrAbort(serial, 800);
          // Dismiss the sheet
          await android.swipe(serial, Math.round(w / 2), Math.round(h * 0.6), Math.round(w / 2), Math.round(h * 0.95), 300);
          await sleepOrAbort(serial, 600);
          sharesDm++;
        } catch (e: any) { if (e?.message === "cycle-aborted") throw e; /* else non-fatal */ }
      }

      if (i < count - 1) {
        const delaySec = delayLoSec + Math.random() * (delayHiSec - delayLoSec);
        await sleepOrAbort(serial, Math.round(delaySec * 1000));
      }
    }
    return { count, likes, likeFailures, sharesFeed, sharesDm };
  }

  // View stories from the stories bar at the top of the feed.
  // Opens the first story, watches N slides per user (each for a randomly
  // chosen % of the typical slide duration), then advances to the next user.
  async function runViewStoriesFromFeedLoop(serial: string, params: {
    usersMin: number; usersMax: number;
    slidesMin: number; slidesMax: number;
    slideWatchPctMin: number; slideWatchPctMax: number;
  }): Promise<{ usersWatched: number; slidesWatched: number }> {
    const { usersMin, usersMax, slidesMin, slidesMax, slideWatchPctMin, slideWatchPctMax } = params;
    const numUsers = Math.floor(
      Math.min(usersMin, usersMax) +
      Math.random() * (Math.max(usersMin, usersMax) - Math.min(usersMin, usersMax) + 1)
    );
    if (numUsers <= 0) return { usersWatched: 0, slidesWatched: 0 };

    const { w, h } = getScreenSize(serial);
    // Instagram stories bar sits just below the header, centred at roughly
    // 10% from the top.  The FIRST slot is always the user's own profile with
    // the "+" create-story button overlaid — tapping it opens the camera
    // instead of viewing.  Skip it and target slot 2 (first friend's story)
    // at ~22% from the left.
    const storyBarY   = Math.round(h * 0.10);
    const firstStoryX = Math.round(w * 0.22);

    let usersWatched = 0;
    let slidesWatched = 0;

    // Tap the first story to open it.
    await android.tap(serial, firstStoryX, storyBarY);
    await sleepOrAbort(serial, 1800); // let story viewer open

    for (let u = 0; u < numUsers; u++) {
      if (isCycleAborted(serial)) break;
      const numSlides = Math.floor(
        Math.min(slidesMin, slidesMax) +
        Math.random() * (Math.max(slidesMin, slidesMax) - Math.min(slidesMin, slidesMax) + 1)
      );
      for (let s = 0; s < numSlides; s++) {
        if (isCycleAborted(serial)) break;
        // Each slide gets its own randomly chosen watch percentage.
        const watchPct = Math.min(slideWatchPctMin, slideWatchPctMax) +
          Math.random() * Math.abs(slideWatchPctMax - slideWatchPctMin);
        // Typical Instagram story slide is 7 seconds for videos; use 6s as
        // a conservative baseline so even 100% watch doesn't overshoot.
        const watchMs = Math.max(400, Math.round((watchPct / 100) * 6000));
        await sleepOrAbort(serial, watchMs);
        slidesWatched++;
        // Tap the right ~70% of the screen to advance to the next slide.
        await android.tap(serial, Math.round(w * 0.75), Math.round(h * 0.50));
        await sleepOrAbort(serial, 500 + Math.round(Math.random() * 400));
      }
      usersWatched++;
      // Advance to the next user's stories by swiping left.
      if (u < numUsers - 1) {
        await android.swipe(serial,
          Math.round(w * 0.80), Math.round(h * 0.50),
          Math.round(w * 0.20), Math.round(h * 0.50),
          280
        );
        await sleepOrAbort(serial, 900 + Math.round(Math.random() * 400));
      }
    }

    // Exit the story viewer by swiping down.
    await android.swipe(serial, Math.round(w / 2), Math.round(h * 0.50), Math.round(w / 2), Math.round(h * 0.92), 300);
    await sleepOrAbort(serial, 800);

    return { usersWatched, slidesWatched };
  }

  app.post("/api/mobile/devices/:serial/check-feed", async (req: Request, res: Response) => {
    const serial = p(req, "serial");
    if (checkFeedInProgress.has(serial)) {
      res.status(409).json({ error: "A Check Feed run is already in progress on this device" });
      return;
    }
    checkFeedInProgress.add(serial);
    try {
      const params = checkFeedSchema.parse(req.body);
      const { count, likes, likeFailures } = await runCheckFeedLoop(serial, params);
      res.json({ ok: true, count, likes, likeFailures });
    } catch (e: any) { res.status(400).json({ error: e?.message ?? "Failed to check feed" }); }
    finally { checkFeedInProgress.delete(serial); }
  });

  // ── Automation Cycle — the full "toggle on" lifecycle, per user
  // instruction: power on the phone, open Instagram, run the configured
  // scroll/like/share/stories tools, close Instagram by swiping it away in
  // the recent-apps switcher, cycle airplane mode off/on to force a fresh
  // connection, then lock the phone again. Each toggle "tick" runs this
  // whole sequence once; the frontend calls it back-to-back on a randomized
  // gap while the master toggle stays on, so it recycles every time.
  const automationCycleSchema = checkFeedSchema.extend({
    airplaneWaitMinSec: z.number().min(1).max(120).default(15),
    airplaneWaitMaxSec: z.number().min(1).max(120).default(20),
    shareFeedPercentMin: z.number().min(0).max(100).default(0),
    shareFeedPercentMax: z.number().min(0).max(100).default(0),
    shareDmPercentMin: z.number().min(0).max(100).default(0),
    shareDmPercentMax: z.number().min(0).max(100).default(0),
    viewStoriesUsersMin: z.number().min(0).max(50).default(0),
    viewStoriesUsersMax: z.number().min(0).max(50).default(0),
    viewStoriesSlidesMin: z.number().min(1).max(50).default(3),
    viewStoriesSlidesMax: z.number().min(1).max(50).default(6),
    viewStoriesSlideWatchPctMin: z.number().min(1).max(100).default(50),
    viewStoriesSlideWatchPctMax: z.number().min(1).max(100).default(90),
  });
  const automationCycleInProgress = new Set<string>();

  // Abort endpoint — called by the frontend when the master toggle is switched
  // off mid-cycle.  The frontend passes the same cycleId it used to start the
  // cycle so we can ignore stale abort POSTs that arrive after the next cycle
  // has already started (the race that was killing fresh cycles on toggle-off).
  app.post("/api/mobile/devices/:serial/automation-cycle/abort", (req: Request, res: Response) => {
    const serial = p(req, "serial");
    const cycleId: string | undefined = req.body?.cycleId;
    // Only set the abort flag if the supplied ID matches the cycle that is
    // actually running right now.  If cycleId is absent (older clients) fall
    // back to the unconditional set for backwards compatibility.
    if (!cycleId || automationCycleCurrentId.get(serial) === cycleId) {
      automationCycleAbortedId.set(serial, automationCycleCurrentId.get(serial) ?? cycleId ?? "");
    }
    res.json({ ok: true });
  });

  app.post("/api/mobile/devices/:serial/automation-cycle", async (req: Request, res: Response) => {
    const serial = p(req, "serial");
    if (automationCycleInProgress.has(serial) || checkFeedInProgress.has(serial)) {
      res.status(409).json({ error: "An automation cycle is already in progress on this device" });
      return;
    }
    // Register this cycle's ID so the abort endpoint can target it precisely.
    // Using the ID from the request body (sent by the frontend) means a stale
    // abort POST that arrives after this cycle started will NOT match and is
    // safely ignored.
    const incomingCycleId: string = req.body?.cycleId ?? `fallback-${Date.now()}`;
    automationCycleCurrentId.set(serial, incomingCycleId);
    automationCycleAbortedId.delete(serial); // clear any abort from a previous cycle
    automationCycleInProgress.add(serial);
    checkFeedInProgress.add(serial); // also blocks a concurrent manual Check Feed call
    const steps: string[] = [];
    let storiesWatched = 0;
    try {
      const {
        count, delayMinSec, delayMaxSec, likePercentMin, likePercentMax,
        airplaneWaitMinSec, airplaneWaitMaxSec,
        shareFeedPercentMin, shareFeedPercentMax,
        shareDmPercentMin, shareDmPercentMax,
        viewStoriesUsersMin, viewStoriesUsersMax,
        viewStoriesSlidesMin, viewStoriesSlidesMax,
        viewStoriesSlideWatchPctMin, viewStoriesSlideWatchPctMax,
      } = automationCycleSchema.parse(req.body);

      // 1. Power on the phone.
      await android.wakeScreen(serial);
      steps.push("power-on");
      await sleepOrAbort(serial, 1200); // let the screen finish waking

      // 1b. Swipe up from the bottom to dismiss the lock screen.  On MIUI
      // (Xiaomi) and similar OEM skins, `am start` alone does NOT clear the
      // keyguard — the app launches behind the lock screen and all subsequent
      // taps land on the keyguard instead of Instagram.  A real swipe gesture
      // also resets the screen-off timeout so the display stays on while the
      // cycle runs (KEYCODE_WAKEUP alone does not count as touch input).
      await android.swipeUpFromBottom(serial);
      steps.push("unlock-swipe");
      await sleepOrAbort(serial, 800); // let the keyguard animation complete

      // 2. Open Instagram.
      await android.launchInstagram(serial);
      steps.push("launch-instagram");
      await sleepOrAbort(serial, 3500); // let the app finish loading before scrolling

      // 3. Scroll the feed (Step 2 in the UI).
      const { likes, likeFailures, sharesFeed, sharesDm } = await runCheckFeedLoop(serial, {
        count, delayMinSec, delayMaxSec, likePercentMin, likePercentMax,
        shareFeedPercentMin, shareFeedPercentMax,
        shareDmPercentMin, shareDmPercentMax,
      });
      steps.push(`feed(${count} scrolls, ${likes} likes, ${sharesFeed} feed-shares, ${sharesDm} dm-shares, ${likeFailures} like-failures)`);

      // 4. View stories (Step 3 in the UI) — runs AFTER the feed scroll.
      // Tap the Instagram Home tab in the bottom nav bar to scroll back to the
      // very top of the feed so the stories row is visible again.
      if (viewStoriesUsersMax > 0) {
        const { w: sw, h: sh } = getScreenSize(serial);
        // Instagram bottom-nav Home icon: leftmost of 5 items → x ≈ 10% of width.
        // Nav bar sits at the very bottom of the screen → y ≈ 97.5% of height.
        await android.tap(serial, Math.round(sw * 0.10), Math.round(sh * 0.975));
        await sleepOrAbort(serial, 1500); // wait for feed to scroll back to top
        const result = await runViewStoriesFromFeedLoop(serial, {
          usersMin: viewStoriesUsersMin, usersMax: viewStoriesUsersMax,
          slidesMin: viewStoriesSlidesMin, slidesMax: viewStoriesSlidesMax,
          slideWatchPctMin: viewStoriesSlideWatchPctMin, slideWatchPctMax: viewStoriesSlideWatchPctMax,
        });
        storiesWatched = result.usersWatched;
        steps.push(`stories(${result.usersWatched} users, ${result.slidesWatched} slides)`);
      }

      // 5. Close Instagram completely — recents switcher + swipe away, not a
      // force-stop, so the device behaves like a person put it down.
      await android.closeInstagramViaRecents(serial);
      steps.push("closed-instagram");

      // 6. Cycle airplane mode on, wait, then off — forces a fresh network
      // session on the next run.
      await android.setAirplaneMode(serial, true);
      steps.push("airplane-mode-on");
      const waitLoSec = Math.min(airplaneWaitMinSec, airplaneWaitMaxSec);
      const waitHiSec = Math.max(airplaneWaitMinSec, airplaneWaitMaxSec);
      const waitSec = waitLoSec + Math.random() * (waitHiSec - waitLoSec);
      await sleepOrAbort(serial, Math.round(waitSec * 1000));
      await android.setAirplaneMode(serial, false);
      steps.push("airplane-mode-off");

      // 7. Swipe up, then press power again to lock the phone — ready for
      // the next cycle to start from a clean, screen-off state.
      await sleepOrAbort(serial, 1500); // let the radios reconnect before touching the screen
      await android.swipeUpFromBottom(serial);
      steps.push("swipe-up");
      await android.sleepScreen(serial);
      steps.push("power-off");

      res.json({ ok: true, count, likes, likeFailures, sharesFeed, sharesDm, storiesWatched, steps });
    } catch (e: any) {
      const aborted = (e?.message === "cycle-aborted");
      res.status(aborted ? 200 : 400).json({
        ok: aborted,
        aborted,
        error: aborted ? undefined : (e?.message ?? "Automation cycle failed"),
        steps,
      });
    } finally {
      automationCycleInProgress.delete(serial);
      checkFeedInProgress.delete(serial);
      automationCycleCurrentId.delete(serial);
      automationCycleAbortedId.delete(serial);
    }
  });

  // ── Instance config (proxy assignment) ───────────────────────────────────────
  app.get("/api/mobile/config", async (_req: Request, res: Response) => {
    try {
      const [cfg, proxies] = await Promise.all([
        Promise.resolve(loadInstanceConfigs()),
        storage.getProxies(),
      ]);
      res.json({ instanceConfigs: cfg, proxies });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  const instanceConfigSchema = z.object({
    proxyId: z.number().nullable().optional(),
    proxyProtocol: z.enum(["http", "socks5"]).optional(),
  });
  app.post("/api/mobile/instances/:name/config", async (req: Request, res: Response) => {
    try {
      const name = p(req, "name");
      const input = instanceConfigSchema.parse(req.body);
      const cfg = loadInstanceConfigs();
      cfg[name] = { ...cfg[name], ...input };
      saveInstanceConfigs(cfg);
      res.json({ ok: true, config: cfg[name] });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // Apply proxy to a running device via a transparent local relay.
  //
  // How it works:
  //   1. Equinox starts a local TCP relay on a random port (0.0.0.0).
  //   2. The relay forwards all CONNECT (HTTPS) and plain HTTP to the real
  //      upstream proxy, injecting Proxy-Authorization automatically.
  //   3. Android's global proxy is pointed at GATEWAY_IP:RELAY_PORT — no
  //      credentials needed from Android's side, so auth stripping is never
  //      an issue.
  //
  // The gateway IP (e.g. 10.0.2.2) is how the Android VM reaches the Windows
  // host. We detect it from the device's default route so it works for both
  // AVD and BlueStacks without hardcoding anything.
  // Check the external IP seen through the device's assigned proxy (server-side test).
  app.get("/api/mobile/devices/:serial/check-ip", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const cfg = loadInstanceConfigs();
      const proxyId = cfg[serial]?.proxyId;
      if (!proxyId) return res.status(400).json({ ok: false, error: "No proxy assigned to this device" });

      const proxies = await storage.getProxies();
      const proxy = proxies.find(pr => pr.id === proxyId);
      if (!proxy) return res.status(404).json({ ok: false, error: "Proxy not found" });

      const ip = await fetchExternalIpViaProxy(
        proxy.host, proxy.port,
        proxy.username ?? undefined,
        proxy.password ?? undefined,
      );
      res.json({ ok: true, ip, proxy: `${proxy.host}:${proxy.port}` });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "IP check failed" });
    }
  });

  // Apply the saved proxy to a running Android device via a host-side relay.
  //
  // Why a relay instead of setting http_proxy directly?
  //   Android's `settings put global http_proxy` only accepts "host:port" — it
  //   cannot carry credentials.  Authenticated proxies silently fail (407) and
  //   apps fall back to a direct connection.  We start a local TCP relay that
  //   forwards traffic to the real upstream and injects Proxy-Authorization
  //   automatically.  Android is pointed at gateway_ip:relay_port (no creds).
  app.post("/api/mobile/devices/:serial/apply-proxy", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const cfg = loadInstanceConfigs();
      const proxyId = cfg[serial]?.proxyId ?? null;
      if (!proxyId) {
        proxyRelay.stopRelayForDevice(serial);
        await android.setDeviceProxy(serial, null);
        return res.json({ ok: true, message: "Proxy cleared on device" });
      }
      const proxies = await storage.getProxies();
      const proxy = proxies.find(pr => pr.id === proxyId);
      if (!proxy) return res.status(404).json({ ok: false, error: "Proxy not found" });

      // Start (or restart) the local relay on 127.0.0.1 (localhost only)
      const relayPort = await proxyRelay.startRelay(serial, {
        host: proxy.host,
        port: proxy.port,
        user: proxy.username ?? undefined,
        pass: proxy.password ?? undefined,
      });

      // Register adb reverse so Android's localhost:relayPort tunnels through
      // the ADB connection to the host relay — no Windows Firewall rules needed.
      android.adbReverse(serial, relayPort);

      // Point Android at its own loopback — the ADB tunnel does the rest
      await android.setDeviceProxy(serial, { host: "127.0.0.1", port: relayPort });

      res.json({ ok: true, message: `Relay (adb reverse :${relayPort}) → ${proxy.host}:${proxy.port} applied` });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "Apply proxy failed" });
    }
  });

  // Save proxy assignment for a device (no relay — user configures proxy directly in LD Player)
  const deviceProxySchema = z.object({ proxyId: z.number().nullable() });
  app.post("/api/mobile/devices/:serial/proxy", async (req: Request, res: Response) => {
    try {
      const input = deviceProxySchema.parse(req.body);
      const serial = p(req, "serial");
      const cfg = loadInstanceConfigs();
      cfg[serial] = { ...cfg[serial], proxyId: input.proxyId ?? null };
      saveInstanceConfigs(cfg);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  const startSchema = z.object({
    avdName: z.string().min(1),
    port: z.number().int().optional(),
  });
  app.post("/api/mobile/avds/start", async (req: Request, res: Response) => {
    try {
      const input = startSchema.parse(req.body);
      // Look up any saved proxy for this AVD
      const cfg = loadInstanceConfigs();
      const instanceCfg = cfg[input.avdName];
      let proxyOpts: { host: string; port: number; user?: string; pass?: string } | undefined;
      if (instanceCfg?.proxyId) {
        const proxies = await storage.getProxies();
        const proxy = proxies.find(pr => pr.id === instanceCfg.proxyId);
        if (proxy) proxyOpts = { host: proxy.host, port: proxy.port, user: proxy.username ?? undefined, pass: proxy.password ?? undefined };
      }
      const r = android.startEmulator(input.avdName, { port: input.port, proxy: proxyOpts });
      res.json({ ok: true, ...r });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Failed to start emulator" });
    }
  });

  app.post("/api/mobile/devices/:serial/stop", async (req: Request, res: Response) => {
    try {
      await android.stopEmulator(p(req, "serial"));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Failed to stop emulator" });
    }
  });

  app.get("/api/mobile/devices/:serial/wait-boot", async (req: Request, res: Response) => {
    try {
      const booted = await android.waitForBoot(p(req, "serial"), 180000);
      res.json({ booted });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Wait failed" });
    }
  });

  const installSchema = z.object({ apkPath: z.string().min(1) });
  app.post("/api/mobile/devices/:serial/install", async (req: Request, res: Response) => {
    try {
      const input = installSchema.parse(req.body);
      await android.installApk(p(req, "serial"), input.apkPath);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Install failed" });
    }
  });

  app.post("/api/mobile/devices/:serial/instagram/install-from-play", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const result = await android.installInstagramFromPlayStore(serial);
      res.json(result);
      if (result.ok) {
        android.pullAndCacheInstalledApk(serial).catch((e: any) =>
          logger.warn({ err: e }, "[mobile] background APK cache pull failed"),
        );
      }
    } catch (e: any) {
      res.status(500).json({ ok: false, steps: [], error: e?.message ?? "Failed" });
    }
  });

  app.get("/api/mobile/instagram-apk-cache", (_req: Request, res: Response) => {
    const cachePath = android.getCachedApkPath();
    if (fs.existsSync(cachePath)) {
      const size = fs.statSync(cachePath).size;
      res.json({ cached: true, size, path: cachePath });
    } else {
      res.json({ cached: false });
    }
  });

  app.post("/api/mobile/devices/:serial/instagram/install-cached", async (req: Request, res: Response) => {
    try {
      await android.installFromCachedApk(p(req, "serial"));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Cached install failed" });
    }
  });

  const signupSchema = z.object({ email: z.string().email() });
  app.post("/api/mobile/devices/:serial/instagram/signup", async (req: Request, res: Response) => {
    try {
      const { email } = signupSchema.parse(req.body);
      const result = await android.instagramSignup(p(req, "serial"), email);
      res.json(result);
    } catch (e: any) {
      res.status(400).json({ ok: false, steps: [], error: e?.message ?? "Failed" });
    }
  });

  app.get("/api/mobile/devices/:serial/instagram-installed", async (req: Request, res: Response) => {
    try {
      const installed = await android.isPackageInstalled(p(req, "serial"), "com.instagram.android");
      res.json({ installed });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Check failed" });
    }
  });

  app.post("/api/mobile/devices/:serial/instagram/launch", async (req: Request, res: Response) => {
    try { await android.launchInstagram(p(req, "serial")); res.json({ ok: true }); }
    catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  app.post("/api/mobile/devices/:serial/instagram/stop", async (req: Request, res: Response) => {
    try { await android.stopInstagram(p(req, "serial")); res.json({ ok: true }); }
    catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  app.post("/api/mobile/devices/:serial/instagram/clear", async (req: Request, res: Response) => {
    try { await android.clearInstagramData(p(req, "serial")); res.json({ ok: true }); }
    catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  app.post("/api/mobile/devices/:serial/scrcpy/start", async (req: Request, res: Response) => {
    try {
      const r = android.startScrcpy(p(req, "serial"), { windowTitle: `Equinox Mobile — ${p(req, "serial")}`, maxSize: 1080 });
      res.json({ ok: true, ...r });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Failed to start screen mirror" });
    }
  });

  app.post("/api/mobile/devices/:serial/scrcpy/stop", async (req: Request, res: Response) => {
    try { android.stopScrcpy(p(req, "serial")); res.json({ ok: true }); }
    catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  const inputTextSchema = z.object({ text: z.string() });
  app.post("/api/mobile/devices/:serial/input/text", async (req: Request, res: Response) => {
    try {
      const input = inputTextSchema.parse(req.body);
      await android.inputText(p(req, "serial"), input.text);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // videoW/videoH are optional: the client's decoded video frame size at the
  // moment it computed x/y. screenrecord may stream at a downscaled size
  // relative to the device's real screen (see comment in the video WS route
  // above), so if the client's video size doesn't match the device's actual
  // `wm size`, we rescale x/y into real device pixels before tapping —
  // otherwise every tap silently lands on the wrong spot.
  const tapSchema = z.object({
    x: z.number(),
    y: z.number(),
    videoW: z.number().optional(),
    videoH: z.number().optional(),
  });
  // Shared by /input/tap and /input/double-tap — the mirrored video frame is
  // often downscaled from the device's real resolution, so tap coordinates
  // captured against the video's pixel size need rescaling to the phone's
  // actual `wm size` before they're sent to adb.
  function rescaleForDevice(serial: string, x: number, y: number, videoW?: number, videoH?: number): { x: number; y: number } {
    if (!videoW || !videoH) return { x, y };
    try {
      const tools = android.detectToolset();
      const adbPath = tools.adb.path;
      if (!adbPath) return { x, y };
      const wm = spawnSync(adbPath, ["-s", serial, "shell", "wm", "size"], { encoding: "utf8", timeout: 3000 });
      const m = (wm.stdout ?? "").match(/(\d+)x(\d+)/);
      if (!m) return { x, y };
      const realW = parseInt(m[1]);
      const realH = parseInt(m[2]);
      if (realW === videoW && realH === videoH) return { x, y };
      const rx = Math.round((x / videoW) * realW);
      const ry = Math.round((y / videoH) * realH);
      logger.info({ serial, from: [x, y], to: [rx, ry], video: [videoW, videoH], real: [realW, realH] }, "[mobile-tap] rescaled tap for downscaled video");
      return { x: rx, y: ry };
    } catch { return { x, y }; }
  }

  app.post("/api/mobile/devices/:serial/input/tap", async (req: Request, res: Response) => {
    try {
      const input = tapSchema.parse(req.body);
      const serial = p(req, "serial");
      const { x, y } = rescaleForDevice(serial, input.x, input.y, input.videoW, input.videoH);
      await android.tap(serial, x, y);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // Manual double-tap (like) from the operator clicking the mirrored screen
  // twice — must go through the same single-adb-call `doubleTap` used by
  // the automated Check Feed loop. Sending this as two separate
  // `/input/tap` requests (the old behavior) reintroduces the exact
  // latency bug that broke double-tap-to-like: each request is its own
  // adb round-trip, and by the time the second tap lands Instagram's
  // double-tap gesture window has already closed.
  app.post("/api/mobile/devices/:serial/input/double-tap", async (req: Request, res: Response) => {
    try {
      const input = tapSchema.parse(req.body);
      const serial = p(req, "serial");
      const { x, y } = rescaleForDevice(serial, input.x, input.y, input.videoW, input.videoH);
      await android.doubleTap(serial, x, y);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  const swipeSchema = z.object({
    x1: z.number(),
    y1: z.number(),
    x2: z.number(),
    y2: z.number(),
    durationMs: z.number().optional(),
    videoW: z.number().optional(),
    videoH: z.number().optional(),
  });
  app.post("/api/mobile/devices/:serial/input/swipe", async (req: Request, res: Response) => {
    try {
      const input = swipeSchema.parse(req.body);
      const serial = p(req, "serial");
      let { x1, y1, x2, y2 } = input;
      if (input.videoW && input.videoH) {
        try {
          const tools = android.detectToolset();
          const adbPath = tools.adb.path;
          if (adbPath) {
            const wm = spawnSync(adbPath, ["-s", serial, "shell", "wm", "size"], { encoding: "utf8", timeout: 3000 });
            const m = (wm.stdout ?? "").match(/(\d+)x(\d+)/);
            if (m) {
              const realW = parseInt(m[1]);
              const realH = parseInt(m[2]);
              if (realW !== input.videoW || realH !== input.videoH) {
                x1 = Math.round((x1 / input.videoW) * realW);
                y1 = Math.round((y1 / input.videoH) * realH);
                x2 = Math.round((x2 / input.videoW) * realW);
                y2 = Math.round((y2 / input.videoH) * realH);
                logger.info({ serial, video: [input.videoW, input.videoH], real: [realW, realH] }, "[mobile-swipe] rescaled swipe for downscaled video");
              }
            }
          }
        } catch { /* fall back to unscaled coordinates */ }
      }
      await android.swipe(serial, x1, y1, x2, y2, input.durationMs);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  const keySchema = z.object({ code: z.union([z.string(), z.number()]) });
  app.post("/api/mobile/devices/:serial/input/key", async (req: Request, res: Response) => {
    try {
      const input = keySchema.parse(req.body);
      await android.keyevent(p(req, "serial"), input.code);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  const recipeSchema = z.object({
    steps: z.array(z.any()),
  });
  app.post("/api/mobile/devices/:serial/recipe", async (req: Request, res: Response) => {
    try {
      const input = recipeSchema.parse(req.body);
      await android.runSignupRecipe(p(req, "serial"), input.steps);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  app.get("/api/mobile/devices/:serial/android-id", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      // Return cached value immediately if we've already read/written it this session
      if (androidIdCache.has(serial)) {
        res.json({ androidId: androidIdCache.get(serial) });
        return;
      }
      const id = await android.getAndroidId(serial);
      if (id) androidIdCache.set(serial, id);
      res.json({ androidId: id });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  const androidIdSchema = z.object({ androidId: z.string().regex(/^[0-9a-f]{16}$/, "Must be 16 hex characters") });
  app.post("/api/mobile/devices/:serial/android-id", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const input = androidIdSchema.parse(req.body);
      await android.setAndroidId(serial, input.androidId);
      androidIdCache.set(serial, input.androidId);
      res.json({ ok: true, androidId: input.androidId });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  app.post("/api/mobile/android-id/random", (_req: Request, res: Response) => {
    res.json({ androidId: android.randomAndroidId() });
  });

  // ── Device property inspection ─────────────────────────────────────────────
  app.get("/api/mobile/devices/:serial/device-props", async (req: Request, res: Response) => {
    try {
      const props = await android.getDeviceProps(p(req, "serial"));
      res.json(props);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Could not read device properties" });
    }
  });

  // ── Device proxy status (what proxy Android itself is configured with) ─────
  app.get("/api/mobile/devices/:serial/proxy-status", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const deviceProxy = await android.getDeviceProxySetting(serial);
      const cfg = loadInstanceConfigs();
      const proxyId = cfg[serial]?.proxyId ?? null;
      let upstreamProxy: string | null = null;
      if (proxyId) {
        const proxies = await storage.getProxies();
        const px = proxies.find(pr => pr.id === proxyId);
        if (px) upstreamProxy = `${px.host}:${px.port}`;
      }
      res.json({ deviceProxy, upstreamProxy, relayActive: !!deviceProxy });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Could not read device proxy status" });
    }
  });

  // ── Reset device for next account creation ────────────────────────────────
  // Uninstalls Instagram, sets a new android_id, clears the device proxy setting,
  // and removes the proxy assignment from the instance config.
  app.post("/api/mobile/devices/:serial/reset", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");

      // 1. Clear Instagram data (keeps the app installed — no re-download needed)
      await android.clearInstagramData(serial);

      // 1b. Reset Google Advertising ID (GAID) — survives pm clear, used by Instagram at signup
      const gaidResult = android.resetAdvertisingId(serial);

      // 2. Fresh device ID
      const newId = android.randomAndroidId();
      await android.setAndroidId(serial, newId);

      // 3. Clear proxy from the device's global settings
      await android.setDeviceProxy(serial, null);

      // 4. Stop the relay, remove adb reverse tunnel, and clear instance config
      android.adbReverseRemove(serial);
      proxyRelay.stopRelayForDevice(serial);
      const cfg = loadInstanceConfigs();
      cfg[serial] = { ...cfg[serial], proxyId: null };
      saveInstanceConfigs(cfg);

      // 5. Disconnect the device from ADB so it disappears from the device list
      try {
        const tools = android.detectToolset();
        if (tools.adb.path) {
          spawnSync(tools.adb.path, ["disconnect", serial], { encoding: "utf8", timeout: 5000 });
        }
      } catch { /* non-fatal */ }

      logger.info({ serial, newAndroidId: newId, gaidReset: gaidResult.ok }, "device reset for next account creation");
      res.json({ ok: true, newAndroidId: newId, gaidReset: gaidResult.ok });
    } catch (e: any) {
      logger.error({ err: e }, "device reset failed");
      res.status(500).json({ error: e?.message ?? "Reset failed" });
    }
  });

  // Deep reset: clears Instagram + ALL Google identity (GSF ID + GAID) + Android ID
  // The user must re-sign into their Google account in BlueStacks after this.
  app.post("/api/mobile/devices/:serial/deep-reset", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");

      // 1. Clear Instagram + GMS + GSF (resets GSF ID, GAID, all Google device registration)
      const { steps } = await android.deepResetDevice(serial);

      // 2. Fresh Android ID
      const newId = android.randomAndroidId();
      await android.setAndroidId(serial, newId);
      androidIdCache.set(serial, newId);
      steps.push(`✓ Android ID reset → ${newId}`);

      // 3. Clear proxy
      await android.setDeviceProxy(serial, null);
      steps.push("✓ Proxy cleared");

      // 4. Stop relay, remove adb reverse tunnel, and clear instance config
      android.adbReverseRemove(serial);
      proxyRelay.stopRelayForDevice(serial);
      const cfg = loadInstanceConfigs();
      cfg[serial] = { ...cfg[serial], proxyId: null, proxyPort: null, proxyProtocol: null as any };
      saveInstanceConfigs(cfg);

      // 5. Disconnect ADB
      try {
        const tools = android.detectToolset();
        if (tools.adb.path) {
          spawnSync(tools.adb.path, ["disconnect", serial], { encoding: "utf8", timeout: 5000 });
        }
      } catch { /* non-fatal */ }

      logger.info({ serial, newAndroidId: newId, steps }, "device deep reset complete");
      res.json({ ok: true, newAndroidId: newId, steps });
    } catch (e: any) {
      logger.error({ err: e }, "device deep reset failed");
      res.status(500).json({ error: e?.message ?? "Deep reset failed" });
    }
  });

  const saveAccountSchema = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
    email: z.string().optional().nullable(),
    phoneNumber: z.string().optional().nullable(),
    dateOfBirth: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    serial: z.string().optional().nullable(),
    avdName: z.string().optional().nullable(),
    igDeviceState: z.string().optional().nullable(),
    userAgentApi: z.string().optional().nullable(),
  });
  app.post("/api/mobile/accounts", async (req: Request, res: Response) => {
    try {
      const input = saveAccountSchema.parse(req.body);
      const notesPrefix = input.avdName ? `Created via Mobile tab (AVD: ${input.avdName}${input.serial ? `, serial: ${input.serial}` : ""}).` : "Created via Mobile tab.";
      const profile = await storage.createProfile({
        username: input.username,
        password: input.password,
        email: input.email ?? null,
        phoneNumber: input.phoneNumber ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        notes: [notesPrefix, input.notes].filter(Boolean).join(" "),
        status: "idle",
        accountStatus: "pending",
        credentialsDirty: true,
        ...(input.igDeviceState ? { igDeviceState: input.igDeviceState } : {}),
        ...(input.userAgentApi ? { userAgentApi: input.userAgentApi } : {}),
      } as any);
      res.json({ ok: true, profile });
    } catch (e: any) {
      logger.error({ err: e }, "save mobile account failed");
      res.status(400).json({ error: e?.message ?? "Failed to save account" });
    }
  });

  // ── Drony VPN proxy automation ────────────────────────────────────────────
  // GET  /api/mobile/devices/:serial/drony        → { installed, active }
  // POST /api/mobile/devices/:serial/drony/install → install from apkPath
  // POST /api/mobile/devices/:serial/drony/configure → configure + activate
  // POST /api/mobile/devices/:serial/drony/deactivate → turn VPN off

  app.get("/api/mobile/devices/:serial/drony", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const [installed, active] = await Promise.all([
        android.isDronyInstalled(serial),
        android.isDronyVpnActive(serial),
      ]);
      res.json({ installed, active });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Could not check Drony status" });
    }
  });

  app.post("/api/mobile/devices/:serial/drony/install", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const { apkPath } = z.object({ apkPath: z.string().min(1) }).parse(req.body);
      await android.installApk(serial, apkPath);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Install failed" });
    }
  });

  app.post("/api/mobile/devices/:serial/drony/configure", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const { proxyId, proxyType } = z.object({
        proxyId: z.number(),
        proxyType: z.string().optional(),
      }).parse(req.body);
      const proxies = await storage.getProxies();
      const proxy = proxies.find(pr => pr.id === proxyId);
      if (!proxy) return res.status(404).json({ error: "Proxy not found" });
      const result = await android.configureDrony(serial, {
        host: proxy.host,
        port: proxy.port,
        user: proxy.username ?? undefined,
        pass: proxy.password ?? undefined,
        proxyType: proxyType ?? "SOCKS5",
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Configuration failed" });
    }
  });

  app.post("/api/mobile/devices/:serial/drony/deactivate", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const result = await android.deactivateDrony(serial);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Deactivate failed" });
    }
  });
}
