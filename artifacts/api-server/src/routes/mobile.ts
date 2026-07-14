import type { Express, Request, Response } from "express";
import { spawnSync, spawn, execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod/v4";
import fs from "fs";
import fsPromises from "fs/promises";
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
import { HikerApiClient } from "../instagram/hikerApiClient";

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
  feedEnabled?: boolean;
  storiesEnabled?: boolean;
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
  viewStoriesSlidesMin: number;
  viewStoriesSlidesMax: number;
  viewStoriesSlideWatchPctMin: number;
  viewStoriesSlideWatchPctMax: number;
  viewStoriesLikePercentMin: number;
  viewStoriesLikePercentMax: number;
  viewStoriesShareDmPercentMin: number;
  viewStoriesShareDmPercentMax: number;
  // Follow Users — HikerAPI-driven follow flow (persisted here too; this
  // schema previously only covered the feed/stories fields, so these were
  // silently stripped by automationSchema.parse() on every autosave and
  // never actually reached disk — see fix note 12 Jul 2026).
  followEnabled?: boolean;
  followUsersMin?: number;
  followUsersMax?: number;
  followSources?: { type: string; value: string }[];
  // Inject Browsing — per-user profile-browsing behaviour (same fix).
  injectBrowsingEnabled?: boolean;
  injectBrowsingActivatePctMin?: number;
  injectBrowsingActivatePctMax?: number;
  injectBrowsingBeforeFollowPctMin?: number;
  injectBrowsingBeforeFollowPctMax?: number;
  injectBrowsingFeedChanceMin?: number;
  injectBrowsingFeedChanceMax?: number;
  injectBrowsingFeedMin?: number;
  injectBrowsingFeedMax?: number;
  injectBrowsingClickPostPctMin?: number;
  injectBrowsingClickPostPctMax?: number;
  injectBrowsingLikePctMin?: number;
  injectBrowsingLikePctMax?: number;
  injectBrowsingShareFeedPctMin?: number;
  injectBrowsingShareFeedPctMax?: number;
  injectBrowsingShareDmPctMin?: number;
  injectBrowsingShareDmPctMax?: number;
  // Random Jitter — human-like interstitial actions (same persistence fix as
  // Follow/Inject Browsing above; was missing from this type even though the
  // zod schema and defaults object already used these keys).
  randomJitterEnabled?: boolean;
  checkNotificationsPctMin?: number;
  checkNotificationsPctMax?: number;
  checkNotificationsScrollsMin?: number;
  checkNotificationsScrollsMax?: number;
  checkNotificationsClickPctMin?: number;
  checkNotificationsClickPctMax?: number;
  visitProfilePctMin?: number;
  visitProfilePctMax?: number;
  // Activate Percentage — a top-level chance (rolled once per automation-cycle
  // execution, i.e. once per "toggle tick") that gates whether the tool runs
  // AT ALL on this execution, independent of its own internal settings. This
  // is distinct from injectBrowsingActivatePct* above, which rolls per-user
  // INSIDE an already-running Follow step. Default 100/100 (always runs)
  // preserves existing behaviour for accounts saved before this field existed.
  feedActivatePctMin?: number;
  feedActivatePctMax?: number;
  viewStoriesActivatePctMin?: number;
  viewStoriesActivatePctMax?: number;
  followActivatePctMin?: number;
  followActivatePctMax?: number;
  randomJitterActivatePctMin?: number;
  randomJitterActivatePctMax?: number;
  // Make a Post — settings ported over from the old browser-automation
  // "Make a Post" tool (HumanSessionPanel's repost* fields) at the user's
  // request (13 Jul 2026). Config/persistence only for now: there is no
  // mobile automation-cycle logic yet that reads these to actually drive a
  // gallery-picker → caption → share flow on the phone.
  makePostEnabled?: boolean;
  makePostActivatePctMin?: number;
  makePostActivatePctMax?: number;
  makePostPerSessionMin?: number;
  makePostPerSessionMax?: number;
  makePostSourceUsername?: string;
  makePostDisableUsernameSource?: boolean;
  makePostAlterationEnabled?: boolean;
  makePostAlterationLevel?: "small" | "medium" | "high";
  makePostImageSettingsEnabled?: boolean;
  makePostUseHikerApi?: boolean;
  makePostDisableAtPostCount?: number;
  makePostDisableWhenExhausted?: boolean;
  makePostLocalFolderEnabled?: boolean;
  makePostLocalFolderPath?: string;
  makePostLocalFolderNoRepeat?: boolean;
  makePostLocalFolderRandom?: boolean;
  makePostLocalFolderDeleteAfterUpload?: boolean;
  makePostUseChatGpt?: boolean;
  makePostMakeUnique?: boolean;
  makePostDisableComments?: boolean;
  makePostCaptionText?: string;
  makePostImageSettings?: {
    contrast: { enabled: boolean; min: number; max: number };
    brightness: { enabled: boolean; min: number; max: number };
    noise: { enabled: boolean; min: number; max: number };
    sharpen: { enabled: boolean; min: number; max: number };
    pixelate: { enabled: boolean; min: number; max: number };
  };
};
type DeviceSlot = { username: string; password: string; totpSecret?: string };
type DeviceAccount = { slots: DeviceSlot[] };
type InstanceConfig = { proxyId?: number | null; proxyProtocol?: "http" | "socks5"; proxyPort?: number | null; sourceInterface?: string | null; automation?: AutomationSettings; account?: DeviceAccount };
type InstanceConfigMap = Record<string, InstanceConfig>;

function configFilePath(): string {
  if (process.env.EQUINOX_DATA_DIR) {
    return path.join(process.env.EQUINOX_DATA_DIR, "mobile-instances.json");
  }
  // In dev/server mode (no Electron), resolve relative to the running script
  // rather than process.cwd() — cwd() can vary depending on how the server is
  // launched (pnpm filter from workspace root vs. running directly from the
  // package dir). process.argv[1] is always the entry script's absolute path
  // (e.g. .../artifacts/api-server/dist/index.mjs), so one level up from its
  // directory gives the stable artifacts/api-server/ package root.
  return path.join(path.dirname(path.resolve(process.argv[1])), "..", "mobile-instances.json");
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
  // Tracks whether a video session for a given serial has already run its
  // one-time stale-process cleanup this connection. Guards the `pkill` below
  // so a second concurrent/overlapping connection for the SAME device never
  // kills a stream that this process itself just started — it only clears
  // processes left behind by something outside this server's tracking
  // (a crashed tab, a previous server run, etc).
  const videoSessionActive = new Set<string>();
  // Maps serial → the currently-connected video WebSocket for that device.
  // Populated when a video WS client connects, cleared on disconnect.
  // Used by the automation cycle to push real-time progress messages into
  // the client's Log panel without a separate channel.
  const videoSessionWS = new Map<string, import('ws').WebSocket>();

  // Helper: push an info message to the connected video WebSocket for a
  // device (if one is connected).  Used by the automation cycle to stream
  // step-by-step progress into the Log panel.  No-ops silently when no WS
  // is connected, so callers don't need to guard the call.
  const sendVideoLog = (serial: string, msg: string): void => {
    const vws = videoSessionWS.get(serial);
    if (vws && vws.readyState === 1) {
      try { vws.send(JSON.stringify({ info: msg })); } catch { /* ignore */ }
    }
  };

  httpServer.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "";
    const m = url.match(/^\/api\/mobile\/video\/([^/?#]+)/);
    if (!m) return;
    const serial = decodeURIComponent(m[1]);
    (socket as any).__wsHandled = true;
    logger.info({ serial }, "[mobile-video] upgrading connection for device");
    videoWss.handleUpgrade(request, socket as any, head, async (ws) => {
      // Timing instrumentation for the "first connect lags ~5s, retry is
      // instant" report: log elapsed ms at every stage instead of guessing
      // where the time goes, so the next repro pinpoints the real cause
      // rather than another unverified theory.
      const t0 = Date.now();
      const elapsed = () => Date.now() - t0;

      const tools = android.detectToolset();
      const adbPath = tools.adb.path;
      if (!adbPath) {
        ws.send(JSON.stringify({ error: "ADB not found on this machine" }));
        ws.close();
        return;
      }

      const deviceCheck = spawnSync(adbPath, ["devices"], { encoding: "utf8", timeout: 5000 });
      logger.info({ serial, elapsedMs: elapsed() }, "[mobile-video] timing: adb devices check done");
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
        videoSessionActive.delete(serial);
        videoSessionWS.delete(serial);
        if (lagWatchdog) clearInterval(lagWatchdog);
        try { currentChild?.kill(); } catch { /* ignore */ }
        try { adbShell("settings", "put", "system", "screen_off_timeout", originalScreenTimeout); } catch { /* ignore */ }
        logger.info({ serial, reason }, "[mobile-video] session cleaned up");
      };
      ws.on("close", () => cleanup("close"));
      ws.on("error", (err) => { logger.error({ serial, err }, "[mobile-video] WebSocket error"); cleanup("error"); });

      // ── Client-triggered resync ───────────────────────────────────────────
      // The client sends { clientLag: true } when its WebCodecs decode queue
      // has been backed up for >800ms. The server-side ws.bufferedAmount check
      // only catches TCP send-buffer backlog (i.e. client can't receive fast
      // enough) — it misses the case where TCP delivers data quickly but the
      // client's GPU decoder falls behind. This bidirectional signal is the
      // only reliable way to catch that second scenario.
      ws.on("message", (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.clientLag && running) {
            logger.warn({ serial }, "[mobile-video] client reported decode lag — restarting screenrecord");
            if (ws.readyState === 1) ws.send(JSON.stringify({ info: "Mirror fell behind — resyncing…" }));
            lastLagRestart = Date.now();
            try { currentChild?.kill(); } catch { /* ignore — close handler restarts */ }
          }
        } catch { /* ignore non-JSON control frames */ }
      });

      // ── Lag watchdog ─────────────────────────────────────────────────────
      // "The delay/lag is awful" / "video is no longer 30fps" reports trace
      // back to the same mechanism: ws.send() here is fire-and-forget. If the
      // browser (or the Node event loop itself, e.g. an unrelated slow
      // synchronous block introduced by some other code change) can't drain
      // the socket as fast as screenrecord produces bytes, Node queues the
      // backlog in `ws.bufferedAmount` and keeps growing it forever — WS/TCP
      // backpressure never self-corrects here because we never checked for
      // it. The stream doesn't visibly break, it just falls further and
      // further behind real time, which looks exactly like "stopped being
      // 30fps" / "awful lag" to the user, and — critically — never recovers
      // on its own; only a full reconnect used to clear it. Poll the queued
      // byte count and force a fresh screenrecord (which restarts from a
      // clean IDR frame with an empty send queue) whenever it backs up past
      // ~2 seconds of video at the stream's own bit rate, so lag is bounded
      // and self-healing instead of compounding for the rest of the session.
      // Threshold lowered from 2 MB to 800 KB so the watchdog fires much
      // sooner — at 8 Mbps, 800 KB is only ~0.8 s of buffered video, which
      // keeps the observed lag tight. The watchdog also runs every 500 ms
      // instead of 1 s so it catches a growing backlog faster.
      const LAG_BYTES_THRESHOLD = 800_000; // ~0.8s of buffered video at 8Mbps
      let lastLagRestart = 0;
      const lagWatchdog = setInterval(() => {
        if (!running || ws.readyState !== 1) return;
        const buffered = ws.bufferedAmount;
        if (buffered > LAG_BYTES_THRESHOLD && Date.now() - lastLagRestart > 4000) {
          lastLagRestart = Date.now();
          logger.warn({ serial, buffered }, "[mobile-video] send buffer backed up — forcing screenrecord restart to clear lag");
          if (ws.readyState === 1) ws.send(JSON.stringify({ info: "Mirror fell behind — resyncing…" }));
          try { currentChild?.kill(); } catch { /* ignore — close handler restarts */ }
        }
      }, 500);

      // Scoped to the whole WS session (not per screenrecord restart) so a
      // stall that persists across several internal restarts still only
      // sends/logs its notice once, instead of every ~6s forever.
      let stallNotified = false;

      const spawnStream = () => {
        if (!running || ws.readyState !== 1) return;
        // --output-format=h264: raw Annex-B elementary stream (no MP4 container)
        // straight to stdout via `exec-out` — this is what lets us pipe it
        // directly into a WebSocket frame-by-frame with zero temp files.
        const args = [
          "-s", serial, "exec-out", "screenrecord",
          "--output-format=h264",
          // 4 Mbps instead of 8 Mbps: halves the data volume per second,
          // which halves how fast the client decode queue can fill up and
          // halves the lag that accumulates before the resync watchdog fires.
          // Mirror quality at 4 Mbps is still excellent for a local USB stream.
          "--bit-rate", "4000000",
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
        // Only surface the "stalled" notice once per stall episode — every
        // restart re-arms the timer, and if the screen genuinely stays off
        // the old code kept logging/sending the same message every 6s
        // forever (this is what filled the Log panel with endless "Tap the
        // mirror to wake" lines). Reset the flag only when real data flows
        // again, so the client still gets a single fresh notice per episode.
        // Stall threshold — three tiers:
        //
        //  1. No real frame yet (only SPS/PPS headers received, chunk ≤ ~500 B):
        //     Restart at 8 s.  This is the MIUI/Instagram DRM scenario: scrcpy
        //     sends the codec headers then freezes because the secure surface
        //     blocks capture.  We want to restart quickly so the mirror catches
        //     up rather than sitting blank until the user notices.
        //
        //  2. Real frames were flowing + automation cycle is active:
        //     Wait 30 s.  UIAutomator accessibility dumps take 1–2 s each and
        //     are chained during launch — 6 s would fire mid-dump and kill the
        //     stream while the phone is legitimately busy.
        //
        //  3. Real frames were flowing + no automation:
        //     6 s.  Normal idle mirror watchdog.
        //
        // A "real frame" is any chunk > 512 B (SPS/PPS on this device is
        // 117 B; a real IDR frame is typically 30–200 KB).
        let sawRealFrame = false;
        const stallThresholdMs = () => {
          // No real IDR frame yet — MIUI DRM is likely blocking capture.
          // Restart aggressively (4 s) so each restart has a short window to
          // catch a real frame before DRM re-engages.  This is faster than the
          // original 6 s constant timeout, giving more frequent catch attempts.
          if (!sawRealFrame) return 4_000;
          // Real frames were flowing + automation active — UIAutomator dumps
          // can cause legitimate 3–5 s gaps between frames.  Wait patiently.
          return automationCycleInProgress.has(serial) ? 30_000 : 6_000;
        };
        let stallTimer: NodeJS.Timeout | null = null;
        const armStall = (ms: number) => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            logger.warn({ serial, bytesTotal, sawRealFrame }, `[mobile-video] stream stalled — no data for ${ms / 1000}s, forcing restart`);
            if (!stallNotified) {
              stallNotified = true;
              // Only notify the client for DRM blocks — the generic "screen may
              // be off" message is suppressed as it clutters the log uselessly.
              const cycleActive = automationCycleInProgress.has(serial);
              if (!sawRealFrame && ws.readyState === 1) {
                ws.send(JSON.stringify({ info: "Stream paused — DRM surface blocked (Instagram). Restarting…" }));
              } else if (sawRealFrame && cycleActive && ws.readyState === 1) {
                ws.send(JSON.stringify({ info: "Stream paused — automation busy (UIAutomator / adb). Restarting stream…" }));
              }
              // "screen may be off" case: no client log — server restarts silently.
            }
            // WAKEUP intentionally omitted: wake must only come from user input.
            try { child.kill(); } catch { /* ignore — close handler restarts */ }
          }, ms);
        };
        armStall(stallThresholdMs());

        child.stdout.on("data", (chunk: Buffer) => {
          if (!sawAnyData) {
            logger.info({ serial, elapsedMs: elapsed(), restartCount }, "[mobile-video] timing: first stdout chunk from screenrecord");
          }
          sawAnyData = true;
          bytesTotal += chunk.length;
          if (!sawRealFrame && chunk.length > 512) {
            sawRealFrame = true;
            logger.info({ serial, chunkBytes: chunk.length, elapsedMs: elapsed() }, "[mobile-video] first real IDR frame received");
          }
          stallNotified = false;
          armStall(stallThresholdMs());
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

      // A prior mirror session (tab closed/refreshed without a clean
      // WebSocket close, or the previous `child.kill()` only killed the
      // local `adb exec-out` process but not the remote on-device
      // `screenrecord`) can leave a screenrecord instance holding the
      // hardware encoder. The new invocation then has to wait for Android
      // to notice the old process died before it can grab the encoder
      // itself — this is the "first connect is ~5s delayed, reconnect is
      // instant" symptom, since by the second attempt the stale process has
      // already been reaped. Explicitly clear any stale instance first so
      // every connection gets the encoder immediately. Guarded by
      // `videoSessionActive`: only run this when THIS process has no other
      // tracked session already streaming that serial, so an overlapping
      // second connection to the same device can never kill a sibling
      // session's own live screenrecord out from under it.
      if (!videoSessionActive.has(serial)) {
        spawnSync(adbPath, ["-s", serial, "shell", "pkill", "-f", "screenrecord"], { encoding: "utf8", timeout: 3000 });
      }
      videoSessionActive.add(serial);
      videoSessionWS.set(serial, ws);
      logger.info({ serial, elapsedMs: elapsed() }, "[mobile-video] timing: pkill stale screenrecord done");

      // NOTE: an earlier fix here assumed the display being off explained
      // the first-connect delay — the user confirmed the screen was ON, so
      // that theory was wrong. Keeping ensureScreenOn as a no-op-when-on
      // safety net (it returns immediately if the screen is already awake),
      // but logging its own elapsed cost separately so it's not blamed for
      // time it didn't spend.
      const screenOnBefore = await android.isScreenOn(serial).catch(() => null);
      await android.ensureScreenOn(serial).catch(() => { /* best effort */ });
      logger.info({ serial, elapsedMs: elapsed(), screenWasAlreadyOn: screenOnBefore === true }, "[mobile-video] timing: ensureScreenOn done");

      logger.info({ serial, elapsedMs: elapsed(), adbPath }, "[mobile-video] timing: about to spawn screenrecord");
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

  // ── Screen info (raw, in-app diagnostic — no terminal needed) ──────────────
  // Returns the RAW `wm size` output, not just a parsed WxH. This device farm
  // has a known-suspected bug where "Physical size" and "Override size" report
  // different values (a display-size override active on the device), which
  // desyncs any coordinate math that assumes a single screen size. The parsed
  // /screen-size endpoint above collapses that distinction; this one preserves
  // it so it can be diagnosed from a single in-app button click.
  //
  // This was originally added in v1.1.547, then removed in v1.1.548 on the
  // (incorrect, as it turned out) theory that the offset bug was "fixed at
  // the source" — v1.1.550/551 show the wm-size/video-frame mismatch is
  // still very much alive, and it's now also the leading suspect for the
  // mirror rendering at the wrong aspect ratio entirely (not just tap
  // offset), so the diagnostic is reinstated rather than re-guessed.
  app.get("/api/mobile/devices/:serial/screen-info", async (req: Request, res: Response) => {
    try {
      const tools = android.detectToolset();
      const adbPath = tools.adb.path;
      if (!adbPath) { res.status(503).json({ error: "ADB not found" }); return; }
      const serial = p(req, "serial");
      const [sizeR, densityR] = await Promise.all([
        execFileP(adbPath, ["-s", serial, "shell", "wm", "size"], { timeout: 5000 } as any),
        execFileP(adbPath, ["-s", serial, "shell", "wm", "density"], { timeout: 5000 } as any),
      ]);
      const sizeOut = String(sizeR.stdout || "").trim();
      const densityOut = String(densityR.stdout || "").trim();
      const physicalM = sizeOut.match(/Physical size:\s*(\d+)x(\d+)/);
      const overrideM = sizeOut.match(/Override size:\s*(\d+)x(\d+)/);
      const physical = physicalM ? { w: parseInt(physicalM[1]), h: parseInt(physicalM[2]) } : null;
      const override = overrideM ? { w: parseInt(overrideM[1]), h: parseInt(overrideM[2]) } : null;
      let mismatch: { physicalRatio: number; overrideRatio: number; percentDiff: number } | null = null;
      if (physical && override) {
        const physicalRatio = physical.w / physical.h;
        const overrideRatio = override.w / override.h;
        mismatch = { physicalRatio, overrideRatio, percentDiff: Math.abs(physicalRatio - overrideRatio) / physicalRatio * 100 };
      }
      res.json({ sizeRaw: sizeOut, densityRaw: densityOut, physical, override, mismatch });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  // ── Reset resolution override (one-click fix for the mismatch above) ───────
  // `wm size reset` clears any active display-size override, returning the
  // device to its native physical panel resolution/ratio. Safe to call even
  // when no override is set (no-op). Does NOT touch density — left alone
  // deliberately since a density override doesn't change the screen's
  // aspect ratio and resetting it could visually rescale UI the user may
  // have intentionally set up.
  app.post("/api/mobile/devices/:serial/screen-info/reset", async (req: Request, res: Response) => {
    try {
      const tools = android.detectToolset();
      const adbPath = tools.adb.path;
      if (!adbPath) { res.status(503).json({ error: "ADB not found" }); return; }
      const serial = p(req, "serial");
      await execFileP(adbPath, ["-s", serial, "shell", "wm", "size", "reset"], { timeout: 5000 } as any);
      const { stdout } = await execFileP(adbPath, ["-s", serial, "shell", "wm", "size"], { timeout: 5000 } as any);
      res.json({ ok: true, sizeRaw: String(stdout || "").trim() });
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
  // NOTE (12 Jul 2026 fix): this schema previously only covered the
  // feed/stories fields. Any keys NOT listed in a z.object() schema are
  // silently stripped by .parse() (zod's default, non-strict behaviour) —
  // so every autosave of Follow Users / Inject Browsing settings was
  // dropping those fields before they ever reached disk. The frontend
  // sends them right back on the next load from AUTOMATION_DEFAULTS,
  // which is exactly what looked like "settings reset on restart". Any
  // NEW persisted field must be added here too, or it will silently never
  // survive a save.
  const followSourceSchema = z.object({ type: z.string(), value: z.string() });
  const automationSchema = z.object({
    enabled: z.boolean().default(false),
    cycleIntervalMin: z.number().min(1).max(9999).optional(),
    cycleIntervalMax: z.number().min(1).max(9999).optional(),
    feedEnabled: z.boolean().default(true),
    storiesEnabled: z.boolean().default(true),
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
    viewStoriesSlidesMin: z.number().min(0).max(100).default(0),
    viewStoriesSlidesMax: z.number().min(0).max(100).default(0),
    viewStoriesSlideWatchPctMin: z.number().min(1).max(100).default(50),
    viewStoriesSlideWatchPctMax: z.number().min(1).max(100).default(90),
    viewStoriesLikePercentMin: z.number().min(0).max(100).default(0),
    viewStoriesLikePercentMax: z.number().min(0).max(100).default(0),
    viewStoriesShareDmPercentMin: z.number().min(0).max(100).default(0),
    viewStoriesShareDmPercentMax: z.number().min(0).max(100).default(0),
    followEnabled: z.boolean().default(false),
    followUsersMin: z.number().min(0).max(9999).default(1),
    followUsersMax: z.number().min(0).max(9999).default(3),
    followSources: z.array(followSourceSchema).default([]),
    injectBrowsingEnabled: z.boolean().default(false),
    injectBrowsingActivatePctMin: z.number().min(0).max(100).default(0),
    injectBrowsingActivatePctMax: z.number().min(0).max(100).default(0),
    injectBrowsingBeforeFollowPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingBeforeFollowPctMax: z.number().min(0).max(100).default(0),
    injectBrowsingFeedChanceMin: z.number().min(0).max(100).default(100),
    injectBrowsingFeedChanceMax: z.number().min(0).max(100).default(100),
    injectBrowsingFeedMin: z.number().min(0).max(50).default(3),
    injectBrowsingFeedMax: z.number().min(0).max(50).default(6),
    injectBrowsingClickPostPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingClickPostPctMax: z.number().min(0).max(100).default(0),
    injectBrowsingLikePctMin: z.number().min(0).max(100).default(0),
    injectBrowsingLikePctMax: z.number().min(0).max(100).default(0),
    injectBrowsingShareFeedPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingShareFeedPctMax: z.number().min(0).max(100).default(0),
    injectBrowsingShareDmPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingShareDmPctMax: z.number().min(0).max(100).default(0),
    // ── Random Jitter fields — were missing from this persistence schema,
    //    causing zod to silently strip them on every POST so they never reached
    //    disk and reset to defaults on every restart.
    randomJitterEnabled: z.boolean().default(false),
    checkNotificationsPctMin: z.number().min(0).max(100).default(0),
    checkNotificationsPctMax: z.number().min(0).max(100).default(0),
    checkNotificationsScrollsMin: z.number().min(0).default(2),
    checkNotificationsScrollsMax: z.number().min(0).default(5),
    checkNotificationsClickPctMin: z.number().min(0).max(100).default(0),
    checkNotificationsClickPctMax: z.number().min(0).max(100).default(0),
    visitProfilePctMin: z.number().min(0).max(100).default(0),
    visitProfilePctMax: z.number().min(0).max(100).default(0),
    // ── Activate Percentage — top-level per-execution chance gate for each
    // tool (rolled once per automation-cycle run, before the tool's own
    // internal settings are even considered). Defaults to 100/100 (always
    // runs) so upgrading doesn't silently start skipping an already-enabled
    // tool for existing users.
    feedActivatePctMin: z.number().min(0).max(100).default(100),
    feedActivatePctMax: z.number().min(0).max(100).default(100),
    viewStoriesActivatePctMin: z.number().min(0).max(100).default(100),
    viewStoriesActivatePctMax: z.number().min(0).max(100).default(100),
    followActivatePctMin: z.number().min(0).max(100).default(100),
    followActivatePctMax: z.number().min(0).max(100).default(100),
    randomJitterActivatePctMin: z.number().min(0).max(100).default(100),
    randomJitterActivatePctMax: z.number().min(0).max(100).default(100),
    // ── Make a Post — ported from the old browser-automation tool's
    // repost* settings (13 Jul 2026). Config/persistence only; no
    // automation-cycle logic reads these yet.
    makePostEnabled: z.boolean().default(false),
    makePostActivatePctMin: z.number().min(0).max(100).default(100),
    makePostActivatePctMax: z.number().min(0).max(100).default(100),
    makePostPerSessionMin: z.number().min(1).max(20).default(1),
    makePostPerSessionMax: z.number().min(1).max(20).default(1),
    makePostSourceUsername: z.string().default(""),
    makePostDisableUsernameSource: z.boolean().default(false),
    makePostAlterationEnabled: z.boolean().default(true),
    makePostAlterationLevel: z.enum(["small", "medium", "high"]).default("small"),
    makePostImageSettingsEnabled: z.boolean().default(true),
    makePostUseHikerApi: z.boolean().default(false),
    makePostDisableAtPostCount: z.number().min(0).default(0),
    makePostDisableWhenExhausted: z.boolean().default(true),
    makePostLocalFolderEnabled: z.boolean().default(false),
    makePostLocalFolderPath: z.string().default(""),
    makePostLocalFolderNoRepeat: z.boolean().default(false),
    makePostLocalFolderRandom: z.boolean().default(false),
    makePostLocalFolderDeleteAfterUpload: z.boolean().default(true),
    makePostUseChatGpt: z.boolean().default(false),
    makePostMakeUnique: z.boolean().default(false),
    makePostDisableComments: z.boolean().default(false),
    makePostCaptionText: z.string().default(""),
    makePostImageSettings: z.object({
      contrast: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      brightness: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      noise: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      sharpen: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      pixelate: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
    }).default({
      contrast: { enabled: true, min: 5, max: 250 },
      brightness: { enabled: true, min: 5, max: 250 },
      noise: { enabled: true, min: 5, max: 15 },
      sharpen: { enabled: true, min: 1.0, max: 2.0 },
      pixelate: { enabled: true, min: 0.9, max: 2.1 },
    }),
  });
  app.get("/api/mobile/devices/:serial/automation-settings", (req: Request, res: Response) => {
    const cfg = loadInstanceConfigs();
    const defaults: AutomationSettings = {
      enabled: false, cycleIntervalMin: 20, cycleIntervalMax: 30,
      feedEnabled: true, storiesEnabled: true,
      actionDelayMin: 5, actionDelayMax: 10,
      likePercentMin: 3, likePercentMax: 5,
      shareFeedPercentMin: 0, shareFeedPercentMax: 0,
      shareDmPercentMin: 0, shareDmPercentMax: 0,
      feedScrollMin: 5, feedScrollMax: 10,
      viewStoriesSlidesMin: 0, viewStoriesSlidesMax: 0,
      viewStoriesSlideWatchPctMin: 50, viewStoriesSlideWatchPctMax: 90,
      viewStoriesLikePercentMin: 0, viewStoriesLikePercentMax: 0,
      viewStoriesShareDmPercentMin: 0, viewStoriesShareDmPercentMax: 0,
      followEnabled: false, followUsersMin: 1, followUsersMax: 3, followSources: [],
      injectBrowsingEnabled: false,
      injectBrowsingActivatePctMin: 0, injectBrowsingActivatePctMax: 0,
      injectBrowsingBeforeFollowPctMin: 0, injectBrowsingBeforeFollowPctMax: 0,
      injectBrowsingFeedChanceMin: 100, injectBrowsingFeedChanceMax: 100,
      injectBrowsingFeedMin: 3, injectBrowsingFeedMax: 6,
      injectBrowsingClickPostPctMin: 0, injectBrowsingClickPostPctMax: 0,
      injectBrowsingLikePctMin: 0, injectBrowsingLikePctMax: 0,
      injectBrowsingShareFeedPctMin: 0, injectBrowsingShareFeedPctMax: 0,
      injectBrowsingShareDmPctMin: 0, injectBrowsingShareDmPctMax: 0,
      randomJitterEnabled: false,
      checkNotificationsPctMin: 0, checkNotificationsPctMax: 0,
      checkNotificationsScrollsMin: 2, checkNotificationsScrollsMax: 5,
      checkNotificationsClickPctMin: 0, checkNotificationsClickPctMax: 0,
      visitProfilePctMin: 0, visitProfilePctMax: 0,
      feedActivatePctMin: 100, feedActivatePctMax: 100,
      viewStoriesActivatePctMin: 100, viewStoriesActivatePctMax: 100,
      followActivatePctMin: 100, followActivatePctMax: 100,
      randomJitterActivatePctMin: 100, randomJitterActivatePctMax: 100,
      makePostEnabled: false,
      makePostActivatePctMin: 100, makePostActivatePctMax: 100,
      makePostPerSessionMin: 1, makePostPerSessionMax: 1,
      makePostSourceUsername: "", makePostDisableUsernameSource: false,
      makePostAlterationEnabled: true, makePostAlterationLevel: "small",
      makePostImageSettingsEnabled: true, makePostUseHikerApi: false,
      makePostDisableAtPostCount: 0, makePostDisableWhenExhausted: true,
      makePostLocalFolderEnabled: false, makePostLocalFolderPath: "",
      makePostLocalFolderNoRepeat: false, makePostLocalFolderRandom: false,
      makePostLocalFolderDeleteAfterUpload: true,
      makePostUseChatGpt: false, makePostMakeUnique: false, makePostDisableComments: false,
      makePostCaptionText: "",
      makePostImageSettings: {
        contrast: { enabled: true, min: 5, max: 250 },
        brightness: { enabled: true, min: 5, max: 250 },
        noise: { enabled: true, min: 5, max: 15 },
        sharpen: { enabled: true, min: 1.0, max: 2.0 },
        pixelate: { enabled: true, min: 0.9, max: 2.1 },
      },
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
      // Previously forced a minimum of SLOT_COUNT (5) slots, padding with
      // empty entries.  That caused deleted slots to silently reappear every
      // time the panel reloaded — the save wrote 2 slots, the pad restored
      // 5, and the UI loaded 5 again.  Now we store exactly what the UI
      // sent so the displayed count always matches what was saved.
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

  // Instagram's "Share" / "Send to" sheet — measured positions from a live
  // accessibility dump on the user's 1080×2226 device (captured 2026-07-11):
  //
  //   Sheet starts at y≈1651 (74.2%) — the LinearLayout container.
  //   Drag-handle pill  y≈1672 (75.1%)
  //   User avatar row   y≈1749 (78.6%) — the clickable recipient bubbles
  //   Username labels   y≈1836 (82.5%) — text beneath each bubble
  //   "more" button     x≈941 (87.1%), y≈1836 — "expand to see more users"
  //
  // Previous coordinates (0.625/0.740 y) were WRONG:
  //   0.625 × 2226 = 1391 px  → above the sheet entirely (taps the post behind)
  //   0.740 × 2226 = 1647 px  → right at the drag-handle (1672), causing the
  //                              sheet to EXPAND to full screen rather than
  //                              selecting a recipient — this was "clicking to
  //                              expand to see more users" bug the user reported.
  //
  // Measured x positions of the 4 visible bubbles:
  //   163 px (15.1%), 354 px (32.8%), 526 px (48.7%), 693 px (64.2%)
  //
  // All slots now use y=0.786 (1749 px on this device), well below the
  // drag-handle zone and well above the "more" button.
  const SHARE_SHEET_AVATAR_SLOTS: { xPct: number; yPct: number }[] = [
    { xPct: 0.151, yPct: 0.786 },  // bubble 1  — x≈163
    { xPct: 0.328, yPct: 0.786 },  // bubble 2  — x≈354
    { xPct: 0.487, yPct: 0.786 },  // bubble 3  — x≈526
    { xPct: 0.642, yPct: 0.786 },  // bubble 4  — x≈693
  ];

  /** Taps one randomly-chosen recipient avatar in an open Share sheet. */
  async function tapRandomShareSheetRecipient(serial: string, w: number, h: number): Promise<void> {
    // Primary: scan the accessibility tree for tappable recipient rows/bubbles.
    // The DM share sheet presents suggested contacts as clickable nodes with
    // display-name or username labels; their pixel positions vary by device/
    // screen size, so fixed coordinates are unreliable. The a11y scan finds
    // whatever contacts are actually rendered.
    const recipients = await android.findShareSheetRecipients(serial).catch(() => [] as { x: number; y: number }[]);
    if (recipients.length > 0) {
      const pick = recipients[Math.floor(Math.random() * recipients.length)];
      await android.tap(serial, pick.x, pick.y);
      return;
    }
    // Fallback: coordinate tap at an approximate avatar-bubble position.
    const slot = SHARE_SHEET_AVATAR_SLOTS[Math.floor(Math.random() * SHARE_SHEET_AVATAR_SLOTS.length)];
    await android.tap(serial, Math.round(w * slot.xPct), Math.round(h * slot.yPct));
  }

  /**
   * Taps the blue "Send" button in Instagram's DM share sheet.
   *
   * Primary: UIAutomator accessibility lookup for the "Send" button text —
   * reliable when the UI is settled and the label is present.
   *
   * Fallback: coordinate tap at the Send button's known position (~y=94.8%
   * of screen height, ~x=42.2% for the button center). The Send button is
   * always the large full-width blue row at the bottom of the share sheet
   * immediately above the Android nav bar, so this coordinate is stable
   * across Instagram versions even when the accessibility label varies.
   *
   * NOTE: _uiDump is now async (non-blocking) so calling this no longer
   * stalls the video WebSocket.
   */
  async function sendShareSheet(serial: string, w: number, h: number): Promise<boolean> {
    const sendBtn = await android.findButtonByLabel(serial, "Send").catch(() => null);
    if (sendBtn) {
      await android.tap(serial, sendBtn.x, sendBtn.y);
      // Verify the tap actually sent: a successful send closes the share sheet,
      // so the "Send" button disappears. If no recipient was selected the button
      // does nothing and the sheet stays open — we detect that here and return
      // false so the caller can close the sheet rather than logging a false success.
      await sleepOrAbort(serial, 900);
      const sheetStillOpen = await android.findButtonByLabel(serial, "Send").catch(() => null);
      return !sheetStillOpen;
    }
    // UIAutomator didn't find "Send" — this previously fell back to a
    // fixed-coordinate tap and unconditionally returned true regardless of
    // whether the sheet was even open, which produced false "shared via
    // DM" success logs while nothing was actually sent (confirmed on a
    // live run: the DM step never fired, but the fallback tap + `true`
    // return reported success anyway). The fixed coordinate is only a
    // sensible tap target if the share sheet is actually open — confirm
    // that first by checking for a recipient-list/sheet marker before
    // trusting the blind tap.
    const sheetOpen = await android.findButtonByLabel(serial, "Direct").catch(() => null)
      ?? await android.findButtonByLabel(serial, "Share").catch(() => null)
      ?? await android.findButtonByLabel(serial, "To").catch(() => null);
    if (!sheetOpen) return false;
    await android.tap(serial, Math.round(w * 0.422), Math.round(h * 0.948));
    // Same verification for the coordinate-fallback path.
    await sleepOrAbort(serial, 900);
    const sheetStillOpen2 = await android.findButtonByLabel(serial, "Send").catch(() => null)
      ?? await android.findButtonByLabel(serial, "Direct").catch(() => null);
    return !sheetStillOpen2;
  }

  // Shared by the standalone `/check-feed` route and the full
  // `/automation-cycle` route below — the scroll/like/share loop.
  async function runCheckFeedLoop(serial: string, params: {
    count: number; delayMinSec: number; delayMaxSec: number;
    likePercentMin: number; likePercentMax: number;
    shareFeedPercentMin?: number; shareFeedPercentMax?: number;
    shareDmPercentMin?: number; shareDmPercentMax?: number;
    onLog?: (msg: string) => void;
  }): Promise<{ count: number; likes: number; likeFailures: number; sharesFeed: number; sharesDm: number; strayNavRecoveries: number }> {
    const {
      count, delayMinSec, delayMaxSec, likePercentMin, likePercentMax,
      shareFeedPercentMin = 0, shareFeedPercentMax = 0,
      shareDmPercentMin = 0, shareDmPercentMax = 0,
      onLog,
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
    // y1 must start LOW enough to be below the action bar (Like/Comment/Share
    // icons) of every Instagram post format, including the tallest allowed
    // (4:5 portrait). On a 720×1280 device a 4:5 image is 720×900px; adding
    // the ~60px header puts the action bar at y≈960–1008. The old y1=78%
    // (y=998) landed RIGHT on that bar — Android registered the touch-down
    // on the Comment icon and the upward drag was treated as opening comments
    // rather than scrolling the feed. Moving to 88% (y=1126) clears the
    // action bar of any format by ≥100px while still leaving a 600px+ drag
    // distance to y2.
    const y1 = Math.round(h * 0.88);
    const y2 = Math.round(h * 0.22);
    const cy = Math.round(h / 2);
    // Instagram feed post action-bar icon positions are NOT fixed —
    // page/profile owners can disable comments and/or shares per post,
    // which removes icons from the bar and shifts everything after the
    // gap left-ward. A fixed 48.1%/66.0% X guess (measured from one
    // screenshot where all icons happened to be present) landed on the
    // Comment button once a post had fewer icons than that, opening the
    // comment/reply compose box instead of sharing — confirmed from a
    // user-supplied screen-layout scan (Jul 2026). Every tap below is now
    // resolved per-post from `android.findFeedActionIcons()`, which reads
    // the real accessibility tree for whatever's on screen right now and
    // returns `null` for any icon whose identity is ambiguous (see its
    // doc comment) instead of guessing — see the action-bar gating below.

    // Share-to-DM used to just tap the paper-plane icon and press Back —
    // it never actually picked a recipient or sent anything, it only
    // *opened and closed* the DM picker. See tapRandomShareSheetRecipient /
    // sendShareSheet below for the real send flow.

    let likes = 0;
    let likeFailures = 0;
    let sharesFeed = 0;
    let sharesDm = 0;
    let strayNavRecoveries = 0;
    // Sponsored posts ("Ads") render a full-width CTA button ("Shop Now",
    // "Install Now", "Learn More") overlaid near the bottom of the media —
    // right where our double-tap-to-like jitter can land after a scroll that
    // doesn't align to a post boundary. Tapping that button navigates out of
    // Instagram entirely (browser / Play Store), and every scripted tap for
    // the rest of the cycle then lands on the wrong app, which looks like
    // "the whole flow broke". We can't reliably detect an ad from pixels
    // alone via adb, so instead we verify we're still inside Instagram after
    // every gesture that could have hit a CTA, and recover with BACK if not.
    const INSTAGRAM_PKG = "com.instagram.android";
    const verifyStillInInstagram = async (): Promise<void> => {
      const fg = await android.getForegroundPackage(serial).catch(() => null);
      if (fg && fg !== INSTAGRAM_PKG) {
        strayNavRecoveries++;
        logger.warn({ serial, fg }, "[check-feed] tap navigated away from Instagram (likely hit an ad's CTA) — recovering with BACK");
        try { await android.pressBack(serial); } catch { /* best effort */ }
        await sleepOrAbort(serial, 700);
        // If BACK didn't get us home (e.g. it opened a separate app like the
        // Play Store rather than an in-app browser), force Instagram back to
        // the foreground rather than continuing to tap blind.
        const fg2 = await android.getForegroundPackage(serial).catch(() => null);
        if (fg2 && fg2 !== INSTAGRAM_PKG) {
          await android.launchInstagram(serial).catch(() => { /* best effort */ });
          await sleepOrAbort(serial, 1500);
        }
      }
    };
    for (let i = 0; i < count; i++) {
      if (isCycleAborted(serial)) throw new Error("cycle-aborted");
      onLog?.(`Scroll ${i + 1}/${count}`);
      logger.info({ serial, target: "feed-scroll", from: [x, y1], to: [x, y2] }, "[check-feed] swipe");
      await android.swipe(serial, x, y1, x, y2, 550 + Math.round(Math.random() * 200));
      await sleepOrAbort(serial, 180);
      await verifyStillInInstagram();

      // Belt-and-suspenders: detect if the comments sheet accidentally opened
      // despite the y1 coordinate fix. Comments sheet is identifiable by the
      // "Add a comment…" / "Add a comment" placeholder EditText in the
      // accessibility tree. If found, press Back to close it and wait for the
      // feed to reappear before continuing.
      {
        const xml = await android.dumpUi(serial).catch(() => "");
        if (/Add a comment|add a comment|Comments/i.test(xml) && /EditText|class="android\.widget\.EditText"/.test(xml)) {
          logger.warn({ serial }, "[check-feed] comments sheet opened by scroll — pressing Back to recover");
          onLog?.(`Scroll ${i + 1}/${count}: comments accidentally opened — recovering with Back`);
          await android.pressBack(serial);
          await sleepOrAbort(serial, 600);
        }
      }

      // Dismiss any interstitial popup that appeared mid-scroll (e.g.
      // "Your notifications are off → Not now", permission dialogs).
      // This is fast when there's nothing to dismiss (one ui-dump, no match).
      const midPopup = await android.dismissInstagramInterstitials(serial).catch(() => null);
      if (midPopup) {
        logger.info({ serial, dismissed: midPopup }, "[check-feed] dismissed mid-scroll popup");
        await sleepOrAbort(serial, 400);
      }

      // Roll all three action chances up front (independent draws, same
      // statistics as before) but DON'T act on any of them yet — first we
      // need to confirm there's actually a normal post action bar on screen
      // right now. Instagram's feed regularly serves things that aren't a
      // normal post (embedded Reels, ads, "Thanks for your feedback" /
      // snooze cards after its own suggested-content flow fires, survey
      // prompts) and none of those expose the same Like/Share/Send row a
      // real post does. Share-to-feed and share-via-DM used to tap fixed
      // coordinates regardless of what was actually on screen — that's what
      // was landing on "Undo", "Manage content preferences", the Comment
      // button, or a Reel's own controls instead of the intended icon.
      const wantLike = likeChance > 0 && Math.random() < likeChance;
      const wantShareFeed = shareFeedChance > 0 && Math.random() < shareFeedChance;
      const wantShareDm = shareDmChance > 0 && Math.random() < shareDmChance;

      if (wantLike || wantShareFeed || wantShareDm) {
        const feedbackCard = await android.isFeedbackOrSurveyCard(serial).catch(() => false);
        if (feedbackCard) {
          // This card replaced the post entirely — there is nothing safe to
          // tap for like/share/share-DM. Skip all three and just scroll on.
          logger.info({ serial }, "[check-feed] feedback/survey card detected in place of a post — skipping like/share/share-DM, scrolling past");
          if (wantLike) likeFailures++;
        } else {
          await sleepOrAbort(serial, 250 + Math.round(Math.random() * 250));
          // Look up the real action-bar icons for whatever's on screen right
          // now. The Like button's presence confirms this is a normal post
          // with a normal action bar; each icon's actual position (or
          // absence — a page/profile owner can disable comments and/or
          // shares per post) is resolved fresh per post instead of assuming
          // a fixed layout. See findFeedActionIcons()'s doc comment.
          const icons = await android.findFeedActionIcons(serial).catch(() => null);
          if (!icons) {
            // No Like button found — this isn't a normal in-feed post right
            // now (Reel suggestion, ad, still animating in from the scroll,
            // or some other card we don't specifically recognize). Skip
            // like AND share AND share-DM rather than firing share taps at
            // coordinates that assume an action bar exists.
            logger.info({ serial, target: "action-bar", matched: false }, "[check-feed] skipped like/share/share-DM — no Like button visible on screen");
            if (wantLike) likeFailures++;
          } else {
            const likeBtn = icons.like;
            logger.info({ serial, hasComment: !!icons.comment, hasShareFeed: !!icons.shareFeed, hasShareDm: !!icons.shareDm }, "[check-feed] action-bar icons detected for this post");

            if (wantLike) {
              // Tiny jitter (a few px) so repeated taps aren't pixel-identical,
              // but small enough to stay inside the button's own hit target.
              const jx = likeBtn.x + Math.round((Math.random() - 0.5) * 6);
              const jy = likeBtn.y + Math.round((Math.random() - 0.5) * 6);
              logger.info({ serial, target: "like-button", x: jx, y: jy, matched: true }, "[check-feed] tap like");
              try {
                await android.tap(serial, jx, jy);
                likes++;
              } catch {
                likeFailures++;
              }
              await sleepOrAbort(serial, 300);
              await verifyStillInInstagram();
            }

            // Share to Feed (repost): tap the circular-arrows icon, find
            // "Repost" in the sheet via accessibility tree, tap it, then
            // dismiss the "You reposted…" confirmation popup by tapping its
            // "Close" button. Using pressBack to cancel (not a swipe) avoids
            // any chance of the gesture crossing the bottom nav bar and
            // triggering the Reels tab. `icons.shareFeed` is this post's
            // real, freshly-measured icon position — null means this post's
            // icon layout couldn't be told apart with confidence (see
            // findFeedActionIcons), so the action is skipped rather than
            // risking a tap on the wrong control (e.g. Comment).
            if (wantShareFeed && !icons.shareFeed) {
              logger.info({ serial }, "[check-feed] skipped share-to-feed — icon not identifiable on this post (disabled or ambiguous layout)");
            }
            if (wantShareFeed && icons.shareFeed) {
              const shareFeedIconX = icons.shareFeed.x, rowY = icons.shareFeed.y;
              if (isCycleAborted(serial)) throw new Error("cycle-aborted");
              try {
                await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300));
                // Capture the icon's own label before tapping — see the
                // same-name guard in runProfileBrowsingForUser for why:
                // some accounts' Instagram build reposts instantly on a
                // single tap with NO confirmation sheet, relabelling the
                // SAME icon in place (e.g. "Repost" -> "Remove
                // repost"/"Reposted") instead of showing a separate sheet
                // button. Without this check, findButtonByLabel("Repost")
                // matches that same relabelled icon via substring and this
                // code taps it AGAIN — undoing the repost it just made.
                const beforeCd = await android.getContentDescNear(serial, shareFeedIconX, rowY).catch(() => null);
                await android.tap(serial, shareFeedIconX, rowY);
                logger.info({ serial, x: shareFeedIconX, y: rowY, beforeCd }, "[check-feed] tapped share-to-feed icon");
                await sleepOrAbort(serial, 1200); // wait for a possible share sheet

                const repostBtn = await android.findButtonByLabel(serial, "Repost").catch(() => null);
                const sameCoords = !!repostBtn &&
                  Math.abs(repostBtn.x - shareFeedIconX) < 15 && Math.abs(repostBtn.y - rowY) < 15;
                if (repostBtn && !sameCoords) {
                  await android.tap(serial, repostBtn.x, repostBtn.y);
                  logger.info({ serial }, "[check-feed] tapped Repost in sheet");
                  await sleepOrAbort(serial, 1000);
                  // "You reposted X's post" popup appears after the first
                  // repost — find its blue "Close" button via accessibility
                  // tree and tap it.
                  const closeBtn = await android.findButtonByLabel(serial, "Close").catch(() => null);
                  if (closeBtn) {
                    await android.tap(serial, closeBtn.x, closeBtn.y);
                    logger.info({ serial }, "[check-feed] dismissed repost confirmation popup (Close)");
                    await sleepOrAbort(serial, 500);
                  }
                  sharesFeed++;
                } else if (sameCoords) {
                  const afterCd = await android.getContentDescNear(serial, shareFeedIconX, rowY).catch(() => null);
                  if (afterCd && afterCd !== beforeCd) {
                    logger.info({ serial, beforeCd, afterCd }, "[check-feed] repost icon label changed in place — single-tap repost succeeded, no sheet on this account");
                    sharesFeed++;
                  } else {
                    logger.info({ serial, beforeCd, afterCd }, "[check-feed] repost icon unchanged after tap — genuinely did not complete — pressing Back");
                    await android.pressBack(serial);
                    await sleepOrAbort(serial, 500);
                  }
                } else {
                  logger.info({ serial }, "[check-feed] no Repost-labelled node found after tap — pressing Back");
                  await android.pressBack(serial);
                  await sleepOrAbort(serial, 500);
                }
                await verifyStillInInstagram();
              } catch (e: any) { if (e?.message === "cycle-aborted") throw e; /* else non-fatal */ }
            }

            // Share via DM: tap the paper-plane icon to open the DM picker,
            // then close it with Back (registers the share-intent tap in a
            // human-looking way without needing to know a recipient).
            // pressBack is intentional — a swipe-dismiss risks crossing the
            // bottom nav bar and accidentally triggering the Reels tab.
            // `icons.shareDm` is this post's real, freshly-measured icon
            // position — null means it couldn't be identified with
            // confidence (disabled by the poster, or ambiguous layout — see
            // findFeedActionIcons), so the action is skipped.
            if (wantShareDm && !icons.shareDm) {
              logger.info({ serial }, "[check-feed] skipped share-via-DM — icon not identifiable on this post (disabled or ambiguous layout)");
            }
            if (wantShareDm && icons.shareDm) {
              const shareDmIconX = icons.shareDm.x, rowY = icons.shareDm.y;
              if (isCycleAborted(serial)) throw new Error("cycle-aborted");
              try {
                await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300));
                await android.tap(serial, shareDmIconX, rowY);
                logger.info({ serial, x: shareDmIconX, y: rowY }, "[check-feed] tapped share-to-DM icon");
                await sleepOrAbort(serial, 1200); // wait for DM picker sheet
                // Pick a random recipient from the quick-share avatar grid,
                // then look for the Send button that appears once a
                // recipient is selected — previously this just opened the
                // sheet and pressed Back, never actually sending to anyone.
                await tapRandomShareSheetRecipient(serial, w, h);
                // 1500ms instead of 700ms — UIAutomator (now async) takes
                // ~4s on this device. 700ms was never enough time for the
                // blue Send button to finish rendering before we looked for it.
                await sleepOrAbort(serial, 1500);
                const sent = await sendShareSheet(serial, w, h);
                if (sent) {
                  logger.info({ serial }, "[check-feed] shared post via DM — Send tapped");
                  await sleepOrAbort(serial, 800);
                  sharesDm++;
                } else {
                  logger.info({ serial }, "[check-feed] Send button not found after picking recipient — pressing Back");
                  await android.pressBack(serial);
                  await sleepOrAbort(serial, 500);
                }
                await verifyStillInInstagram();
              } catch (e: any) { if (e?.message === "cycle-aborted") throw e; /* else non-fatal */ }
            }
          }
        }
      }

      if (i < count - 1) {
        const delaySec = delayLoSec + Math.random() * (delayHiSec - delayLoSec);
        await sleepOrAbort(serial, Math.round(delaySec * 1000));
      }
    }
    if (strayNavRecoveries > 0) {
      logger.warn({ serial, strayNavRecoveries }, "[check-feed] recovered from stray navigation (ad CTA) during this run");
    }
    return { count, likes, likeFailures, sharesFeed, sharesDm, strayNavRecoveries };
  }

  // View stories from the stories bar at the top of the feed.
  // Opens the first story, watches N slides per user (each for a randomly
  // chosen % of the typical slide duration), then advances to the next user.
  /**
   * Picks and opens one story bubble from the tray using a single "hold and
   * slide right" drag rather than a plain tap. Always tapping the same
   * fixed spot (the first real story) creates a detectable pattern, so
   * instead this presses down on the tray and drags right to a *randomly
   * chosen* bubble, releasing there to open it.
   *
   * Per user confirmation, the story tray after tapping the Home tab sits
   * top-central and is a thin band — only ~15px tall on their device — so
   * accuracy on Y matters more than on X. An earlier version of this
   * function first did a *separate* swipe to scroll the tray when the
   * target bubble (1-10) wasn't yet on screen, then a second swipe to do
   * the actual pick — that two-gesture chain is almost certainly what
   * landed on the Reels tab instead: two independent `input swipe` calls
   * starting very close to the top of the screen can each be misread as
   * unrelated gestures (e.g. a stray edge/notification gesture) rather than
   * one continuous scrub. Fixed by doing exactly ONE gesture, clamped to
   * whatever bubbles are actually visible on screen (no separate
   * pre-scroll), which is simpler and much less likely to be misread.
   *
   * Returns the 1-based position that was opened (for logging only).
   */
  async function pickAndOpenRandomStory(serial: string, w: number, h: number, onLog?: (msg: string) => void): Promise<{ slot: number; opened: boolean }> {
    // ── Coordinate calibration (from real 1080×2226 screenshot, Jul 2026) ──
    //
    // Story tray sits between the Instagram header and the feed. On the
    // device the user has (1080×2226), the tray Y centre is ~14 % of
    // screen height (~311 px). Previous values of 8.5 % landed in the
    // Instagram header bar above the tray, which is why nothing opened.
    //
    // X positions measured from the same screenshot:
    //   Slot 0 – "Your story" (+)  ≈ 20 % of width  (skip — opens camera)
    //   Slot 1 – first friend      ≈ 37 % of width
    //   Slot 2 – second friend     ≈ 55 % of width
    //   Slot 3 – third friend      ≈ 73 % of width
    //   … and so on; spacing ≈ 18.5 % per slot.
    //
    // Opening a story requires a TAP on the bubble, not a swipe. The
    // previous "hold-and-slide-right" swipe was scrolling the tray
    // (or navigating to Reels) instead of opening anything.
    const storyBarYCenter = Math.round(h * 0.14);
    const firstStoryX = Math.round(w * 0.37); // first *friend's* story (skip "Your story")
    const spacing      = Math.round(w * 0.185);

    // How many friend bubbles fit on screen from firstStoryX to the right edge.
    const maxVisible = Math.max(1, Math.min(4, Math.floor((w * 0.96 - firstStoryX) / spacing) + 1));

    // Instagram renders some tray bubbles as "Suggested for you" accounts
    // rather than a friend's actual story — these carry a small circular
    // "+"/follow badge overlaid on the BOTTOM-RIGHT of the avatar so the
    // same tile can either open a story (tap the avatar) or follow the
    // badge/dismiss a "suggested for you" chip instead of viewing a story —
    // user-confirmed from a live run (11 Jul 2026): the tap dismissed a
    // suggested-friend chip, not a story. Bias the tap toward the
    // upper-left quadrant of the bubble (away from the bottom-right corner
    // where the badge sits) so it lands on open-story territory instead.
    //
    // Root-cause fix (11 Jul 2026): a single random slot with no retry meant
    // that whenever the *one* slot picked happened to be a suggested/
    // discover tile (which — unlike real friends' stories — can appear at
    // ANY position in the tray, not just the end), the whole cycle gave up
    // with zero stories watched even though other slots on the same tray
    // very likely held a real story. Real friends' stories are also always
    // sorted before suggested content, so slot 1 (first friend, right after
    // "Your story") is the least likely to be a suggestion — try it first,
    // then fall back to random remaining slots if it fails, up to 3
    // distinct attempts total, before giving up on the whole cycle.
    const slotOrder: number[] = [1];
    const remaining = Array.from({ length: maxVisible }, (_, i) => i + 1).filter(s => s !== 1);
    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }
    slotOrder.push(...remaining);
    const maxAttempts = Math.min(3, slotOrder.length);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const target = slotOrder[attempt];
      const bubbleCenterX = Math.round(firstStoryX + (target - 1) * spacing);

      // Kept small (±6% of one bubble's width/height) so it stays well
      // inside the ring — the tray's usable Y band is narrow, and
      // overcorrecting risks landing above the tray in the header again (a
      // real past bug).
      const targetX = bubbleCenterX - Math.round(spacing * 0.12);
      const targetY = storyBarYCenter - Math.round(h * 0.012);

      onLog?.(`Story tray: tapping slot ${target}/${maxVisible} at (${targetX},${targetY}) — attempt ${attempt + 1}/${maxAttempts}, biased away from bottom-right follow badge`);

      // Single tap on the chosen bubble — that's all Instagram needs to open it.
      await android.tap(serial, targetX, targetY);
      await new Promise(r => setTimeout(r, 600)); // let the story viewer (or a follow toast) finish appearing

      // Verify a story actually opened instead of blindly assuming it did.
      // The main feed's bottom nav bar (Home/Search/Reels/Shop/Profile) is
      // always visible on the feed and never visible inside the story viewer
      // (which is full-screen) — its continued presence after the tap is a
      // reliable signal the tap missed (e.g. hit the follow badge, dismissed
      // a suggestion chip, or missed the bubble/tray band entirely) rather
      // than opening a story.
      // Root-cause fix (12 Jul 2026, user-reported "not instant" reports):
      // this used to call findHomeTab directly — a full uiautomator dump +
      // adb pull, ~3-4s on this farm's devices — on every single tray-tap
      // attempt, adding several real seconds to the very start of every
      // story cycle before the fast pixel-scan path (added for the rest of
      // the loop) ever got a chance to run. Try the fast screenshot-based
      // check first and only pay for the slow dump when it's inconclusive.
      const stillOnFeedFast = await android.isStoryViewerOpenFast(serial).catch(() => null);
      const stillOnFeed = stillOnFeedFast === true
        ? false
        : await android.findHomeTab(serial).then(r => r !== null).catch(() => false);
      if (!stillOnFeed) {
        onLog?.(`Story tray: slot ${target} opened successfully`);
        return { slot: target, opened: true };
      }
      onLog?.(`Story tray: tap on slot ${target} did NOT open a story — bottom nav still visible (likely hit a follow/suggestion badge or missed the bubble)`);
    }

    onLog?.(`Story tray: exhausted ${maxAttempts} slot attempts — no story opened this cycle`);
    return { slot: slotOrder[maxAttempts - 1], opened: false };
  }

  async function runViewStoriesFromFeedLoop(serial: string, params: {
    slidesMin: number; slidesMax: number;
    slideWatchPctMin: number; slideWatchPctMax: number;
    likePercentMin: number; likePercentMax: number;
    shareDmPercentMin: number; shareDmPercentMax: number;
    onLog?: (msg: string) => void;
  }): Promise<{ storiesWatched: number }> {
    const {
      slidesMin, slidesMax,
      slideWatchPctMin, slideWatchPctMax,
      likePercentMin, likePercentMax,
      shareDmPercentMin, shareDmPercentMax,
      onLog,
    } = params;

    const totalStories = Math.floor(
      Math.min(slidesMin, slidesMax) +
      Math.random() * (Math.max(slidesMin, slidesMax) - Math.min(slidesMin, slidesMax) + 1)
    );
    if (totalStories <= 0) return { storiesWatched: 0 };

    const { w, h } = getScreenSize(serial);
    // Logged once per run so a bad like/share tap or a false "sharing
    // disabled" can be cross-checked against the actual device resolution —
    // this farm runs multiple phone models with different aspect ratios,
    // and every tap coordinate and icon-scan band in this loop is a
    // percentage of w/h calibrated against one reference device.
    onLog?.(`Story loop: device resolution ${w}×${h}`);

    // Per-story action chances — sampled once for the whole session so
    // the overall distribution stays consistent.
    const likeChance  = (Math.min(likePercentMin, likePercentMax) +
      Math.random() * Math.abs(likePercentMax - likePercentMin)) / 100;
    const shareChance = (Math.min(shareDmPercentMin, shareDmPercentMax) +
      Math.random() * Math.abs(shareDmPercentMax - shareDmPercentMin)) / 100;

    // Returns true only while the story viewer is genuinely still on screen.
    // Root-cause fix (Jul 2026): every prior fix in this loop assumed that
    // once a story opened, it stayed open for the rest of the per-slide
    // loop and for the whole multi-step DM-share sequence (icon scan → tap
    // → wait → pick recipient → wait → tap Send). Stories auto-advance (and
    // the LAST story in a user's tray auto-EXITS back to the home feed) on
    // their own ~5-6s timer regardless of what our script is doing — a
    // short/fast story, or a DM-share sequence whose waits alone add up to
    // several seconds, can run out that timer mid-sequence. When that
    // happens every remaining scripted tap in this function was firing
    // blind at whatever is now actually on screen — the home feed — which
    // is exactly how a "share to DM" tap turned into an accidental like on
    // a home-feed Reel (feed and story share-sheet coordinates overlap).
    // This check must run before every single tap below, not just once at
    // story-open time.
    //
    // Root-cause fix (Jul 2026, follow-up): this used to call findHomeTab
    // directly on every check, which requires a full uiautomator dump +
    // adb pull (~3-4s per call). Called up to 5-6 times inside one ~5-6s
    // story slide, THAT was consuming the slide's entire timer on safety
    // checks alone — the real reason likes/shares still stalled and
    // weren't "instant" even after the earlier fix removed the deliberate
    // pre-action watch delay. isStoryViewerOpenFast() does the same check
    // via a screenshot pixel scan (~100-300ms) and only ever returns a
    // confident `true`; it returns `null` whenever it can't tell for sure
    // (e.g. a single-story tray with no multi-segment progress bar), and
    // only THEN do we pay for the slow-but-proven accessibility-tree check.
    const stillInStoryViewer = async () => {
      const fastStart = Date.now();
      const fast = await android.isStoryViewerOpenFast(serial).catch(() => null);
      if (fast === true) return true;
      // Instrumented (12 Jul 2026): the previous version of this fix
      // assumed the fast pixel-scan check would hit most of the time and
      // never verified it in the field. Log every fallback with real
      // timings so the next report shows hard numbers (how often the fast
      // check misses, how long the slow dump actually costs on this
      // device) instead of guessing from story-loop timestamps.
      const slowStart = Date.now();
      const result = await android.findHomeTab(serial).then(r => r === null).catch(() => true);
      onLog?.(`  (story-viewer check: fast scan ${slowStart - fastStart}ms inconclusive → slow dump ${Date.now() - slowStart}ms)`);
      return result;
    };

    // Open the story viewer: tap a random friend's story bubble.
    const { slot: picked, opened: storyOpened } = await pickAndOpenRandomStory(serial, w, h, onLog);
    logger.info({ serial, picked, totalStories, storyOpened }, "[view-stories] story open attempt");

    // If the tray tap didn't actually open a story (bottom nav was still
    // visible after the tap — meaning we hit a follow badge or missed the
    // bubble entirely) there is nothing to like or share.  Acting on whatever
    // is currently visible would mean double-tapping a home-feed post (which
    // likes it) or tapping dead air. Return zero watched rather than
    // accidentally interacting with the wrong screen.
    if (!storyOpened) {
      onLog?.("Story tray: no story opened — skipping story actions for this cycle");
      return { storiesWatched: 0 };
    }

    await sleepOrAbort(serial, 1800); // let viewer animate open

    let storiesWatched = 0;

    for (let s = 0; s < totalStories; s++) {
      if (isCycleAborted(serial)) break;

      // Like and/or share this story?
      const willLike  = likeChance  > 0 && Math.random() < likeChance;
      const willShare = shareChance > 0 && Math.random() < shareChance;

      // Watch this story for a random percentage of its ~6s duration — but
      // ONLY when no action is scheduled on this slide. Root-cause fix
      // (Jul 2026, user-reported): stories run on their own fixed real-world
      // timer no matter what the script does, and the multi-step DM-share
      // sequence alone (icon scan, tap, wait for sheet, pick recipient,
      // wait, tap Send) costs several real seconds. Any deliberate "watch"
      // delay before even STARTING a scheduled like/share eats directly
      // into that fixed timer and was the main reason share attempts ran
      // out of runway before finishing — not the icon detection or the
      // close-Instagram logic. When a like and/or a share is scheduled,
      // fire immediately (minimal delay, just enough for the opened-story
      // frame to actually be on screen) so the full remaining slide timer
      // is available for the action(s). Pure viewing (neither action
      // scheduled) keeps the old randomized watch time since there's
      // nothing time-critical to rush toward.
      let watchMs: number;
      if (willLike || willShare) {
        watchMs = 250;
      } else {
        const watchPct = Math.min(slideWatchPctMin, slideWatchPctMax) +
          Math.random() * Math.abs(slideWatchPctMax - slideWatchPctMin);
        watchMs = Math.max(1500, Math.round((watchPct / 100) * 6000));
      }
      await sleepOrAbort(serial, watchMs);

      // Bail out of the ENTIRE remaining loop — not just this slide — the
      // instant the story viewer is gone. Continuing to loop assumes the
      // next iteration will also be inside a story, which is exactly the
      // false assumption that let blind taps land on the home feed.
      if (!(await stillInStoryViewer())) {
        onLog?.(`Story ${s + 1}: story viewer no longer open (auto-advanced/exited) — stopping story actions`);
        logger.info({ serial, story: s + 1 }, "[view-stories] story viewer gone before action — stopping loop");
        break;
      }

      if (willLike) {
        // Double-tap the centre of the story content to Like.
        //
        // Previous approach: pixel-scan for the heart icon, tap it.
        // Problem: Instagram renders the story reply-bar on a canvas with
        // ZERO accessible elements, so the pixel scan had to find the
        // bright icon glyphs by luminance. The "Send message" placeholder
        // text is also bright white on the same dark scrim and consistently
        // fooled the scan — clusters from the text were returned as "icons",
        // the tap landed in the message field, and the keyboard opened.
        // Patching the gap filter only partially helped; the text produced
        // clusters that survived every heuristic.
        //
        // Fix: double-tap anywhere on the story content (not the action
        // bar). Instagram registers that as a like — same gesture as the
        // feed heart animation. Zero icon detection required; works
        // regardless of which icons the story owner has enabled or disabled.
        const cx = Math.round(w * 0.50);
        const cy = Math.round(h * 0.44);
        await android.doubleTap(serial, cx, cy);
        logger.info({ serial, story: s + 1 }, "[view-stories] liked story (double-tap on content)");
        onLog?.(`Story ${s + 1}: liked (double-tap at (${cx},${cy}))`);
        // When a share is also scheduled on this slide, don't linger here —
        // every extra ms is runway the DM-share sequence won't have. Only
        // pause for the full heart-animation beat when nothing else needs
        // to happen next.
        await sleepOrAbort(serial, willShare ? 150 : 600);
      }

      if (willShare && !(await stillInStoryViewer())) {
        onLog?.(`Story ${s + 1}: story viewer closed before share could start — skipping share`);
        logger.info({ serial, story: s + 1 }, "[view-stories] story viewer gone before share attempt");
      } else if (willShare) {
        // Scan for icons BEFORE tapping — skip share entirely if the
        // paper-plane isn't present (story owner has sharing disabled).
        //
        // Previous approach: blind tap at fixed right-edge coordinates, then
        // check if the keyboard opened. Problem: that tap always lands inside
        // the message field when sharing is disabled (the field expands to
        // fill the full bar width), briefly opening the keyboard and
        // disrupting the story before we back out.
        //
        // Fix: run findStoryActionIcons() first.  When sharing is disabled
        // only the heart icon is visible — the scan returns 0 or 1 cluster.
        // When sharing is enabled the heart AND paper-plane both appear — the
        // scan returns ≥2 clusters, and the rightmost cluster IS the
        // paper-plane.  We only tap if ≥2 icons were found, and we tap the
        // actual detected coordinates rather than a guessed percentage.
        // The keyboard check is kept as a final safety net.
        const iconScan = await android.findStoryActionIcons(serial).catch(() => null);
        const shareIconPos = (iconScan && iconScan.length >= 2) ? iconScan[iconScan.length - 1] : null;
        onLog?.(`Story ${s + 1}: share icon scan — ${iconScan == null ? "screenshot unavailable" : `${iconScan.length} icon(s) found`}${shareIconPos ? ` — paper-plane at (${shareIconPos.x},${shareIconPos.y})` : " — sharing disabled or not detectable"}`);

        let opened = false;
        if (!shareIconPos) {
          // 0 or 1 icon — sharing disabled or ambiguous, skip without touching the screen
          logger.info({ serial, story: s + 1, iconsFound: iconScan?.length ?? 0 }, "[view-stories] share skipped — paper-plane not found in icon scan");
          onLog?.(`Story ${s + 1}: share skipped — owner has sharing disabled (no paper-plane detected)`);
        } else {
          // Root-cause fix (12 Jul 2026, user-reported): a missed tap used
          // to be a dead end — one shot at the scanned coordinates, and if
          // the keyboard opened (meaning we hit the message field instead
          // of the paper-plane) we just gave up on the whole share. The
          // scan can't be made perfectly reliable across every device in
          // this farm, but the keyboard-open signal already tells us
          // definitively that we missed — so use it as live feedback and
          // retry further right (the paper-plane is always the rightmost
          // element of the bar) instead of stopping after one attempt.
          let attemptX = shareIconPos.x;
          let opened_ = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            await android.tap(serial, attemptX, shareIconPos.y);
            await sleepOrAbort(serial, 500);
            const keyboardShown = await android.isKeyboardShown(serial).catch(() => false);
            if (!keyboardShown) { opened_ = true; break; }
            await android.pressBack(serial);
            logger.warn({ serial, story: s + 1, attempt, attemptX }, "[view-stories] share tap opened keyboard — retrying further right");
            onLog?.(`Story ${s + 1}: share tap at (${attemptX},${shareIconPos.y}) opened keyboard — retrying further right`);
            attemptX = Math.min(Math.round(w * 0.97), attemptX + Math.round(w * 0.05));
            await sleepOrAbort(serial, 300);
          }
          // The sheet is a modal over the story, so its own presence isn't
          // directly checkable via findHomeTab — but if the story has
          // ALREADY exited to the feed underneath (auto-advanced past the
          // last slide while we were mid-tap), the bottom nav reappears
          // even though no keyboard is showing. That combination used to
          // read as "sheet opened successfully" and every tap after this
          // point (recipient, Send) landed on the feed instead.
          const backOnFeed = opened_ && await stillInStoryViewer().then(v => !v);
          if (!opened_) {
            // Every retry hit the message field — give up rather than risk
            // a 4th blind tap.
            logger.warn({ serial, story: s + 1 }, "[view-stories] share tap opened keyboard on every retry — giving up");
            onLog?.(`Story ${s + 1}: share skipped — every retry landed on the message field, could not locate the paper-plane`);
          } else if (backOnFeed) {
            logger.warn({ serial, story: s + 1 }, "[view-stories] story exited to feed instead of opening share sheet — no further taps");
            onLog?.(`Story ${s + 1}: share skipped — story ended before the share sheet opened (back on home feed)`);
          } else {
            opened = true;
            onLog?.(`Story ${s + 1}: share sheet opened — tapped paper-plane at (${attemptX},${shareIconPos.y})`);
          }
        }
        if (opened) {
          await sleepOrAbort(serial, 900); // wait for picker sheet (trimmed from 1200ms to leave more runway)
          // Confirm the sheet actually rendered BEFORE firing the recipient
          // tap. Root-cause fix (12 Jul 2026, user-reported): the only gate
          // that used to exist here was "no keyboard AND still in story
          // viewer" — but that's true both when the sheet genuinely opened
          // AND when the paper-plane tap landed on something that did
          // neither (e.g. a slightly mis-scanned icon position that missed
          // every real element). In that second case `opened` was still set
          // true, and the very next line blind-tapped recipient slot 1 at
          // x≈15% of screen width — which, on the plain story screen
          // underneath (no sheet actually covering it), is squarely inside
          // Instagram's "go to previous story" tap zone. That's the
          // "clicked backwards" bug: the bot wasn't confused about DM UI,
          // it just never verified the DM sheet was really there before
          // tapping into it blind.
          //
          // The Send button only ever exists inside this DM share sheet, so
          // finding it is a reliable positive signal the sheet is open —
          // unlike the absence checks used above, which can't tell "sheet
          // open" apart from "nothing happened at all".
          const sheetConfirmed = await android.findButtonByLabel(serial, "Send").catch(() => null) !== null;
          if (!sheetConfirmed) {
            logger.warn({ serial, story: s + 1 }, "[view-stories] share sheet not confirmed open (no Send button found) — skipping recipient tap to avoid a blind tap on the story underneath");
            onLog?.(`Story ${s + 1}: share aborted — could not confirm the share sheet actually opened (no Send button found) — skipped recipient tap rather than risk tapping the story underneath`);
          } else {
          // Pick a random recipient, then look for the real Send button —
          // previously this just opened the sheet and pressed Back, never
          // actually sending to anyone (same bug as the feed's share-to-DM).
          await tapRandomShareSheetRecipient(serial, w, h);
          await sleepOrAbort(serial, 900); // 1500→900ms: still enough for the Send button to render
          // Final checkpoint before the last tap: if the sheet/story is
          // already gone by now, tapping "Send"'s coordinates blind would
          // land on the feed (exactly the reported "liked a reel" bug) —
          // skip the tap entirely instead of firing it regardless.
          if (!(await stillInStoryViewer())) {
            logger.warn({ serial, story: s + 1 }, "[view-stories] story/sheet gone before Send — skipped final tap");
            onLog?.(`Story ${s + 1}: share aborted — story ended before Send could be tapped (no tap sent)`);
          } else {
          const sent = await sendShareSheet(serial, w, h);
          if (sent) {
            logger.info({ serial, story: s + 1 }, "[view-stories] shared story via DM — Send tapped");
            onLog?.(`Story ${s + 1}: shared via DM — Send tapped`);
            await sleepOrAbort(serial, 800);
          } else {
            await android.pressBack(serial);
            logger.info({ serial, story: s + 1 }, "[view-stories] Send button not found — closed DM picker");
            onLog?.(`Story ${s + 1}: Send button not found — closed DM picker`);
            await sleepOrAbort(serial, 600);
          }
          }
          }
        }
      }

      // Don't tap "advance to next slide" if we've already left the story
      // viewer — that tap would land on the feed and register as a like/
      // navigation there instead of harmlessly advancing a story slide.
      if (!(await stillInStoryViewer())) {
        onLog?.(`Story ${s + 1}: story viewer already closed — stopping story loop`);
        logger.info({ serial, story: s + 1 }, "[view-stories] story viewer gone at end of slide — stopping loop");
        storiesWatched++;
        break;
      }

      storiesWatched++;

      // Advance to the next story by tapping the right ~75% of the screen.
      await android.tap(serial, Math.round(w * 0.75), Math.round(h * 0.50));
      await sleepOrAbort(serial, 500 + Math.round(Math.random() * 400));
    }

    // Exit the story viewer by swiping down — only if we're actually still
    // in it; if the loop already broke out because the viewer was gone,
    // this would just be a harmless extra swipe on the feed, but skipping
    // it keeps the log accurate about what really happened on screen.
    if (await stillInStoryViewer()) {
      await android.swipe(
        serial,
        Math.round(w / 2), Math.round(h * 0.50),
        Math.round(w / 2), Math.round(h * 0.92),
        300,
      );
    }
    await sleepOrAbort(serial, 800);

    return { storiesWatched };
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
      const { count, likes, likeFailures, strayNavRecoveries } = await runCheckFeedLoop(serial, params);
      res.json({ ok: true, count, likes, likeFailures, strayNavRecoveries });
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
    // Master on/off switches for each slide of the cycle (12 Jul 2026).
    // When a step is unticked in the UI, its whole block never runs — this
    // is purely a gate, not a percentage/chance like the fields below.
    feedEnabled: z.boolean().default(true),
    storiesEnabled: z.boolean().default(true),
    shareFeedPercentMin: z.number().min(0).max(100).default(0),
    shareFeedPercentMax: z.number().min(0).max(100).default(0),
    shareDmPercentMin: z.number().min(0).max(100).default(0),
    shareDmPercentMax: z.number().min(0).max(100).default(0),
    viewStoriesSlidesMin: z.number().min(0).max(100).default(0),
    viewStoriesSlidesMax: z.number().min(0).max(100).default(0),
    viewStoriesSlideWatchPctMin: z.number().min(1).max(100).default(50),
    viewStoriesSlideWatchPctMax: z.number().min(1).max(100).default(90),
    viewStoriesLikePercentMin: z.number().min(0).max(100).default(0),
    viewStoriesLikePercentMax: z.number().min(0).max(100).default(0),
    viewStoriesShareDmPercentMin: z.number().min(0).max(100).default(0),
    viewStoriesShareDmPercentMax: z.number().min(0).max(100).default(0),
    // Follow Users — HikerAPI-driven follow flow. HikerAPI fetches candidates
    // from the configured target sources (hashtags / followers-of-account);
    // the software then navigates to Instagram Search and follows each user by
    // typing their @username character-by-character on the on-screen keyboard.
    followEnabled: z.boolean().default(false),
    followUsersMin: z.number().min(0).max(9999).default(1),
    followUsersMax: z.number().min(0).max(9999).default(3),
    followSources: z.array(z.object({ type: z.string(), value: z.string() })).default([]),
    // Inject Browsing — per-user profile-browsing behaviour woven into the
    // Follow Users flow itself (12 Jul 2026 rework). There is no per-item
    // enable toggle anymore: search-browsing (landing on the profile via
    // Search) is mandatory and always happens as part of following, "Get
    // Suggested Users" was removed, and the old separate "Inject Profile
    // Browsing" toggle was a duplicate of this whole section. The single
    // injectBrowsingEnabled switch below gates everything; the roll
    // percentages/counts are re-rolled independently for every user.
    injectBrowsingEnabled: z.boolean().default(false),
    // Rolled once per user: outer gate — whether inject browsing runs at all
    // for this user. min=30/max=60 → ~45% of users get the browsing sequence.
    injectBrowsingActivatePctMin: z.number().min(0).max(100).default(0),
    injectBrowsingActivatePctMax: z.number().min(0).max(100).default(0),
    // Rolled once per user (if activate passed): chance THIS user gets the
    // profile-browsing sequence before they're followed. min=5/max=10 → each
    // user independently has an ~7.5% (avg of the range) chance of it happening.
    injectBrowsingBeforeFollowPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingBeforeFollowPctMax: z.number().min(0).max(100).default(0),
    // Chance, once browsing is triggered for this user, that their grid of
    // posts gets scrolled at all.
    injectBrowsingFeedChanceMin: z.number().min(0).max(100).default(100),
    injectBrowsingFeedChanceMax: z.number().min(0).max(100).default(100),
    // How many rows to scroll down (Instagram's profile grid is 3 posts per
    // row) when the feed-chance roll above succeeds.
    injectBrowsingFeedMin: z.number().min(0).max(50).default(3),
    injectBrowsingFeedMax: z.number().min(0).max(50).default(6),
    // Chance to open (click) one of the scrolled-past posts.
    injectBrowsingClickPostPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingClickPostPctMax: z.number().min(0).max(100).default(0),
    // Once a post is opened: chance to like it / repost it / share it via DM.
    injectBrowsingLikePctMin: z.number().min(0).max(100).default(0),
    injectBrowsingLikePctMax: z.number().min(0).max(100).default(0),
    injectBrowsingShareFeedPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingShareFeedPctMax: z.number().min(0).max(100).default(0),
    injectBrowsingShareDmPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingShareDmPctMax: z.number().min(0).max(100).default(0),
    // ── Random Jitter — human-like interstitial actions fired on each cycle
    // at a random percentage chance.  Master gate: randomJitterEnabled.
    randomJitterEnabled: z.boolean().default(false),
    // Check Notifications: taps the heart icon, scrolls, optionally taps an item.
    checkNotificationsPctMin: z.number().min(0).max(100).default(0),
    checkNotificationsPctMax: z.number().min(0).max(100).default(0),
    checkNotificationsScrollsMin: z.number().min(0).default(2),
    checkNotificationsScrollsMax: z.number().min(0).default(5),
    checkNotificationsClickPctMin: z.number().min(0).max(100).default(0),
    checkNotificationsClickPctMax: z.number().min(0).max(100).default(0),
    // Visit My Profile: taps the profile icon in the bottom nav, then returns.
    visitProfilePctMin: z.number().min(0).max(100).default(0),
    visitProfilePctMax: z.number().min(0).max(100).default(0),
    // ── Activate Percentage — see AutomationSettings type for full comment.
    // Rolled once per tool per automation-cycle execution, gating whether
    // that tool runs at all THIS cycle, on top of its own enabled toggle.
    feedActivatePctMin: z.number().min(0).max(100).default(100),
    feedActivatePctMax: z.number().min(0).max(100).default(100),
    viewStoriesActivatePctMin: z.number().min(0).max(100).default(100),
    viewStoriesActivatePctMax: z.number().min(0).max(100).default(100),
    followActivatePctMin: z.number().min(0).max(100).default(100),
    followActivatePctMax: z.number().min(0).max(100).default(100),
    randomJitterActivatePctMin: z.number().min(0).max(100).default(100),
    randomJitterActivatePctMax: z.number().min(0).max(100).default(100),
    // ── Make a Post — wired into the automation cycle (13 Jul 2026). Only
    // the local-folder image source is implemented for the on-device flow
    // (per user preference over the HikerAPI-scrape-from-another-user path);
    // the other makePost* fields (source username, ChatGPT,
    // image alterations) remain persisted via automationSchema above but are
    // not yet read here.
    makePostEnabled: z.boolean().default(false),
    makePostActivatePctMin: z.number().min(0).max(100).default(100),
    makePostActivatePctMax: z.number().min(0).max(100).default(100),
    makePostPerSessionMin: z.number().min(1).max(20).default(1),
    makePostPerSessionMax: z.number().min(1).max(20).default(1),
    makePostLocalFolderEnabled: z.boolean().default(false),
    makePostLocalFolderPath: z.string().default(""),
    makePostLocalFolderNoRepeat: z.boolean().default(false),
    makePostLocalFolderRandom: z.boolean().default(false),
    makePostLocalFolderDeleteAfterUpload: z.boolean().default(true),
    makePostDisableComments: z.boolean().default(false),
    makePostCaptionText: z.string().default(""),
  });
  const automationCycleInProgress = new Set<string>();

  // Per-serial persistent log of users followed. Survives server restarts by
  // writing each entry to a JSON file on disk alongside the database.
  type MobileFollowedEntry = { username: string; source: string; followedAt: number };
  const mobileFollowedUsers = new Map<string, MobileFollowedEntry[]>();

  // Must NOT be derived from process.cwd() — in the packaged Windows app,
  // cwd is not a stable, guaranteed-writable location across launches (it
  // can land in a read-only Program Files path or vary by how the exe was
  // spawned). EQUINOX_DATA_DIR (set by electron/main.ts to Electron's
  // userData path) is the established stable location this codebase
  // already uses for exactly this reason — see configFilePath() above,
  // which anchors mobile-instances.json the same way. This file used cwd
  // instead, so every restart of the packaged app could resolve to a
  // different (often empty) folder, making previously followed users look
  // "wiped" even though the old JSON file was still sitting untouched in
  // the previous cwd.
  const FOLLOWED_DIR = process.env.EQUINOX_DATA_DIR
    ? path.join(process.env.EQUINOX_DATA_DIR, "mobile-followed")
    : path.join(path.dirname(path.resolve(process.argv[1] ?? ".")), "..", "mobile-followed");
  try { fs.mkdirSync(FOLLOWED_DIR, { recursive: true }); } catch { /* already exists */ }

  // One-time migration: earlier builds wrote here (process.cwd()-based),
  // so carry any existing per-device files forward into the new stable
  // location instead of silently orphaning them.
  try {
    const legacyDir = path.join(process.cwd(), "data", "mobile-followed");
    if (legacyDir !== FOLLOWED_DIR && fs.existsSync(legacyDir)) {
      for (const f of fs.readdirSync(legacyDir)) {
        const dest = path.join(FOLLOWED_DIR, f);
        if (!fs.existsSync(dest)) fs.copyFileSync(path.join(legacyDir, f), dest);
      }
    }
  } catch { /* best effort */ }

  const _followedFilePath = (serial: string) =>
    path.join(FOLLOWED_DIR, `${serial.replace(/[^a-zA-Z0-9_\-]/g, "_")}.json`);

  const getMobileFollowedList = (serial: string): MobileFollowedEntry[] => {
    if (!mobileFollowedUsers.has(serial)) {
      // Hydrate from disk on first access so data survives restarts.
      try {
        const raw = fs.readFileSync(_followedFilePath(serial), "utf8");
        mobileFollowedUsers.set(serial, JSON.parse(raw) as MobileFollowedEntry[]);
      } catch {
        mobileFollowedUsers.set(serial, []);
      }
    }
    return mobileFollowedUsers.get(serial)!;
  };

  const recordMobileFollow = (serial: string, username: string, source: string) => {
    const list = getMobileFollowedList(serial);
    list.unshift({ username, source, followedAt: Date.now() });
    // Persist to disk so data survives server restarts.
    try { fs.writeFileSync(_followedFilePath(serial), JSON.stringify(list), "utf8"); } catch { /* best effort */ }
  };

  // ── Make a Post — local-folder file picker ──────────────────────────────
  // Per-serial persistent record of which local-folder files have already
  // been posted, so "Do not repeat images" survives server restarts —
  // mirrors the mobileFollowedUsers/FOLLOWED_DIR pattern above exactly.
  const mobilePostedLocalFiles = new Map<string, string[]>();
  const POSTED_DIR = process.env.EQUINOX_DATA_DIR
    ? path.join(process.env.EQUINOX_DATA_DIR, "mobile-posted-local")
    : path.join(path.dirname(path.resolve(process.argv[1] ?? ".")), "..", "mobile-posted-local");
  try { fs.mkdirSync(POSTED_DIR, { recursive: true }); } catch { /* already exists */ }
  const _postedFilePath = (serial: string) =>
    path.join(POSTED_DIR, `${serial.replace(/[^a-zA-Z0-9_\-]/g, "_")}.json`);
  const getPostedLocalFiles = (serial: string): string[] => {
    if (!mobilePostedLocalFiles.has(serial)) {
      try {
        const raw = fs.readFileSync(_postedFilePath(serial), "utf8");
        mobilePostedLocalFiles.set(serial, JSON.parse(raw) as string[]);
      } catch {
        mobilePostedLocalFiles.set(serial, []);
      }
    }
    return mobilePostedLocalFiles.get(serial)!;
  };
  const recordPostedLocalFile = (serial: string, fileName: string) => {
    const list = getPostedLocalFiles(serial);
    list.unshift(fileName);
    try { fs.writeFileSync(_postedFilePath(serial), JSON.stringify(list.slice(0, 5000)), "utf8"); } catch { /* best effort */ }
  };

  const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

  /**
   * Picks the next image to post from `folderPath` per the user's Local
   * Folder settings (random vs. alphabetical order, no-repeat). Returns
   * null (with a log line) if the folder is empty/unreadable or every file
   * has already been posted — callers must treat that as "nothing to post",
   * not an error.
   */
  async function pickLocalFolderImage(serial: string, opts: {
    folderPath: string; random: boolean; noRepeat: boolean; onLog?: (msg: string) => void;
  }): Promise<string | null> {
    const { folderPath, random, noRepeat, onLog } = opts;
    let entries: string[];
    try {
      entries = await fsPromises.readdir(folderPath);
    } catch (e: any) {
      onLog?.(`Make a Post: could not read local folder "${folderPath}" — ${e?.message ?? "unknown error"}`);
      return null;
    }
    let images = entries.filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
    if (images.length === 0) {
      onLog?.(`Make a Post: no image files found in "${folderPath}"`);
      return null;
    }
    if (noRepeat) {
      const posted = new Set(getPostedLocalFiles(serial));
      const filtered = images.filter(f => !posted.has(f));
      if (filtered.length === 0) {
        onLog?.("Make a Post: all local-folder images already posted (Do not repeat is ON)");
        return null;
      }
      images = filtered;
    }
    const ordered = random ? [...images].sort(() => Math.random() - 0.5) : [...images].sort((a, b) => a.localeCompare(b));
    return ordered[0];
  }

  /**
   * Runs one "Make a Post" attempt: pushes a local-folder image to the
   * device, taps the "+" compose icon, walks the create-post flow (select
   * photo → Next → Next → caption → Share). Every UI-dependent step
   * verifies the expected control is actually present before tapping it
   * (findButtonByLabel/findComposeButton return null rather than a guessed
   * coordinate) and aborts the attempt with a log line instead of firing a
   * blind tap — this flow has never been exercised against a real device,
   * so failing loudly here is much safer than silently mis-tapping.
   */
  async function runMakePostStep(serial: string, opts: {
    localFolderPath: string; localFolderRandom: boolean; localFolderNoRepeat: boolean;
    deleteAfterUpload: boolean; captionText: string; disableComments: boolean;
    onLog?: (msg: string) => void;
  }): Promise<{ posted: boolean; fileName?: string }> {
    const { localFolderPath, localFolderRandom, localFolderNoRepeat, deleteAfterUpload, captionText, disableComments, onLog } = opts;

    const fileName = await pickLocalFolderImage(serial, {
      folderPath: localFolderPath, random: localFolderRandom, noRepeat: localFolderNoRepeat, onLog,
    });
    if (!fileName) return { posted: false };
    const localFilePath = path.join(localFolderPath, fileName);

    onLog?.(`Make a Post: pushing "${fileName}" to device…`);
    let devicePath: string;
    try {
      devicePath = await android.pushFileToDevice(serial, localFilePath, fileName);
    } catch (e: any) {
      onLog?.(`Make a Post: adb push failed — ${e?.message ?? "unknown error"}`);
      return { posted: false };
    }
    onLog?.(`Make a Post: ✓ pushed to ${devicePath}, media-scanner notified`);
    await sleepOrAbort(serial, 1200); // let the scanner index the file before we open the picker

    onLog?.("Make a Post: looking for the \"+\" compose icon…");
    const composeBtn = await android.findComposeButton(serial).catch(() => null);
    if (!composeBtn) {
      onLog?.("Make a Post: compose \"+\" icon not found — skipping (selector likely needs real-device tuning)");
      return { posted: false };
    }
    onLog?.("Make a Post: tapping the \"+\" compose icon…");
    await android.tap(serial, composeBtn.x, composeBtn.y);
    // 3.5 s — Instagram's compose picker takes >1.8 s to finish its opening
    // animation on this device; a shorter sleep means the layout dump (and
    // every subsequent UIAutomator call) runs against a blank transitioning
    // screen instead of the real picker UI.
    await sleepOrAbort(serial, 3500);

    // One-shot layout dump — fires immediately after the "+" tap sleep,
    // before any other UIAutomator call, to capture exactly what opened.
    // This is the only dump in this flow; additional dumps compound delays
    // and can cause time-sensitive screens (the picker) to change state.
    await android.logScreenLayout(serial, "Make a Post: after '+' tap", onLog);

    // ── Wrong-header-icon guard ───────────────────────────────────────────────
    // Confirmed real-device regressions (13 Jul 2026): two different blind
    // positional fallbacks in findComposeButton have each mismatched a
    // different wrong screen — a top-right header scan hit Notifications,
    // and a bottom-nav-centre guess hit Direct/Messages (this device's
    // bottom nav has no create tab at all). findComposeButton now uses the
    // user-confirmed top-left header icon position, but this check stays as
    // a safety net: if a label/resource-id match ever points at
    // Notifications or Direct again, recover by backing out and retrying
    // once via that same confirmed top-left position instead of silently
    // continuing on the wrong screen.
    if (await android.isOnNotificationsOrDirectScreenLive(serial).catch(() => false)) {
      onLog?.("Make a Post: \"+\" tap opened Notifications/Direct instead of the composer — wrong icon tapped. Backing out and retrying via the top-left header icon…");
      await android.pressBack(serial);
      await sleepOrAbort(serial, 800);
      const retryXml = await android.dumpUi(serial).catch(() => "");
      const retryBtn = retryXml ? android.findComposeTopLeftHeaderIcon(serial, retryXml) : null;
      if (retryBtn) {
        await android.tap(serial, retryBtn.x, retryBtn.y);
        await sleepOrAbort(serial, 3500);
        await android.logScreenLayout(serial, "Make a Post: after top-left-icon retry tap", onLog);
      } else {
        onLog?.("Make a Post: retry scan found no top-left header icon either — aborting this attempt.");
      }
      if (!retryBtn || await android.isOnNotificationsOrDirectScreenLive(serial).catch(() => false)) {
        onLog?.("Make a Post: retry also failed to reach the composer — aborting this attempt.");
        await android.pressBack(serial);
        await android.removeDeviceFile(serial, devicePath).catch(() => {});
        return { posted: false };
      }
    }

    // Auto-clear any interstitial ("Turn on notifications?", a stray "Not now"
    // confirmation, etc.) that can appear right after opening the composer —
    // left alone it silently sits on top of the picker and every later
    // findButtonByLabel() call comes back empty.
    // NOTE: "Cancel" is excluded from DISMISS_LABELS — it is too generic and
    // would dismiss the compose/picker screen itself back to the home feed.
    await android.dismissInstagramInterstitials(serial).catch(() => null);

    // The "+" compose icon opens a sheet with multiple post-type tabs
    // (POST / REEL / STORY). Tap the POST tab to switch into the feed-post
    // gallery/picker. When the sheet already opened on POST mode this tab
    // isn't present, so this is a no-op in that case.
    onLog?.("Make a Post: checking for POST mode tab…");
    const postTab = await android.findButtonByLabel(serial, "POST").catch(() => null)
      ?? await android.findButtonByLabel(serial, "Post").catch(() => null);
    if (postTab) {
      onLog?.("Make a Post: tapping POST tab…");
      await android.tap(serial, postTab.x, postTab.y);
      onLog?.("Make a Post: POST tab tapped — waiting 2 s for grid to load…");
      await sleepOrAbort(serial, 2000);
      onLog?.("Make a Post: 2 s wait done");
    } else {
      // POST tab not found — already on the photo picker, but give the grid
      // a moment to finish loading before we scan for thumbnails.
      onLog?.("Make a Post: no POST tab found — waiting 800 ms…");
      await sleepOrAbort(serial, 800);
      onLog?.("Make a Post: 800 ms wait done");
    }

    // ── Story-picker guard ────────────────────────────────────────────────────
    // The story "+" button in the stories tray carries content-desc="Add" and
    // appears before the compose "+" in the accessibility tree, so
    // findComposeButton can find it first and open the "Add to story" picker
    // instead of the post compose sheet.  Detect this early — before any
    // thumbnail tap or Next tap — and abort cleanly.
    //
    // Signals unique to the story picker / story editor:
    //   • "Your story" / "Close Friends" share buttons (story editor bottom bar)
    //   • overflow_button resource-id (story editor right toolbar)
    //   • "Add to story" window title text
    // If ANY of these are present we are on the wrong screen.
    const onStoryScreen = await android.isOnStoryCreator(serial).catch(() => false);
    if (onStoryScreen) {
      onLog?.("Make a Post: story picker/editor opened instead of post composer — the wrong \"+\" button was tapped. Pressing Back and aborting.");
      await android.pressBack(serial);
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }

    // The photo is visible in the grid but NOT yet selected (highlighted
    // with a white border) — it must be tapped to select it. Always tap.
    // Grid layout: cell 0 = camera shutter tile, cell 1+ = photo thumbnails
    // sorted newest-first. findFirstGalleryThumbnail() skips the camera tile
    // and accepts both clickable and non-clickable nodes (Xiaomi/Android 14
    // RecyclerView marks child cells non-clickable; v1.1.526 fix).
    onLog?.("Make a Post: looking for the newest photo thumbnail in the Recents grid…");
    const thumbnail = await android.findFirstGalleryThumbnail(serial).catch(() => null);
    if (thumbnail) {
      onLog?.(`Make a Post: tapping thumbnail at (${thumbnail.x}, ${thumbnail.y}) to select it…`);
      await android.tap(serial, thumbnail.x, thumbnail.y);
      await sleepOrAbort(serial, 1500);
    } else {
      // Accessibility scan returned nothing — use the positional fallback for
      // the second grid cell (first non-camera photo tile, x≈38%, y≈69%).
      const fallbackThumb = android.postGalleryThumbnailPositionalFallback(serial);
      onLog?.(`Make a Post: no thumbnail found via scan — positional fallback at (${fallbackThumb.x}, ${fallbackThumb.y})…`);
      await android.tap(serial, fallbackThumb.x, fallbackThumb.y);
      await sleepOrAbort(serial, 1500);
    }

    // Confirm the picker is actually open before tapping Next. Check for any
    // recognizable picker signal: the expand toggle (only visible when a photo
    // is selected in the preview), or a labelled Next button.
    onLog?.("Make a Post: looking for the \"Next\" button…");
    let nextBtn1 = await android.findButtonByLabel(serial, "Next").catch(() => null);
    let nextBtn1IsPositionalGuess = false;
    if (!nextBtn1) {
      // On this screen the top app bar (X / "New post" / Next) has zero
      // accessibility children — "Next" is rendered but not labelled.
      // Fall back to a fixed screen-fraction coordinate.
      onLog?.("Make a Post: \"Next\" not found in accessibility tree — using positional fallback");
      nextBtn1 = android.postNextButtonPositionalFallback(serial);
      nextBtn1IsPositionalGuess = true;
    }
    // Sanity-check: if we're relying entirely on positional guesses with no
    // confirming signal (no POST tab, no expand toggle, no labelled Next),
    // the compose sheet likely never opened — bail rather than tap blind.
    if (nextBtn1IsPositionalGuess && !postTab && !(await android.findExpandPhotoButton(serial).catch(() => null))) {
      onLog?.("Make a Post: compose sheet did not open (no picker signal found at all) — aborting");
      await android.pressBack(serial);
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }

    // The picker preview has a small "expand" (two-arrow / resize) toggle in
    // its bottom-left corner that switches the crop from a square/cropped
    // frame to the full original photo. Tap it before Next so the post uses
    // the full uncropped image rather than IG's default centre-crop.
    onLog?.("Make a Post: looking for the photo expand/fit toggle…");
    const expandToggle = await android.findExpandPhotoButton(serial).catch(() => null);
    if (expandToggle) {
      onLog?.(`Make a Post: tapping expand/fit toggle at (${expandToggle.x}, ${expandToggle.y})…`);
      await android.tap(serial, expandToggle.x, expandToggle.y);
      await sleepOrAbort(serial, 500);
    } else {
      onLog?.("Make a Post: expand/fit toggle not found — continuing without it");
    }

    onLog?.(`Make a Post: found "Next" at (${nextBtn1.x}, ${nextBtn1.y}) — tapping…`);
    await android.tap(serial, nextBtn1.x, nextBtn1.y);
    await sleepOrAbort(serial, 1500);

    // Confirm the tap actually advanced the screen. "Next" itself isn't a
    // reliable signal here — on this screen it's frequently unlabelled (see
    // above), so a labelled-Next re-check would come back null whether the
    // tap worked or not. Instead check for the expand toggle, which IS a
    // reliable, labelled-or-positional signal unique to the photo-select
    // screen: if it's still visible after the tap, we never left this
    // screen and the tap was swallowed or missed.
    const stillOnPicker = await android.findExpandPhotoButton(serial).catch(() => null);
    if (stillOnPicker) {
      onLog?.("Make a Post: tapped \"Next\" but the picker screen did not advance — aborting this attempt");
      await android.pressBack(serial);
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }

    // Filter/edit screen → Next. Instagram's image editor (audio overlay,
    // filter strip, ratio controls) shows a labelled "Next" in the app bar —
    // give it extra time to settle before looking, since the audio-suggestion
    // overlay animation can delay accessibility-tree population.
    const nextBtn2 = await android.findButtonByLabel(serial, "Next").catch(() => null);
    if (nextBtn2) {
      onLog?.(`Make a Post: tapping filter/edit "Next" at (${nextBtn2.x}, ${nextBtn2.y})…`);
      await android.tap(serial, nextBtn2.x, nextBtn2.y);
      await sleepOrAbort(serial, 2000);
    }

    // Edit/adjustments screen → Next (only present on some builds).
    const nextBtn3 = await android.findButtonByLabel(serial, "Next").catch(() => null);
    if (nextBtn3) {
      onLog?.(`Make a Post: tapping edit "Next" at (${nextBtn3.x}, ${nextBtn3.y})…`);
      await android.tap(serial, nextBtn3.x, nextBtn3.y);
      await sleepOrAbort(serial, 2000);
    }

    // Caption screen — verify we're actually there before typing/sharing.
    const shareBtn = await android.findButtonByLabel(serial, "Share").catch(() => null);
    if (!shareBtn) {
      onLog?.("Make a Post: caption/share screen not confirmed (no \"Share\" control found) — aborting this attempt");
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }
    const caption = captionText.trim();
    if (caption) {
      const captionField = await android.findButtonByLabel(serial, "Write a caption").catch(() => null);
      if (captionField) {
        await android.tap(serial, captionField.x, captionField.y);
        await sleepOrAbort(serial, 500);
        await android.inputText(serial, caption);
        await sleepOrAbort(serial, 400);
        await android.pressBack(serial); // dismiss keyboard, don't navigate away from this screen
        await sleepOrAbort(serial, 400);
      } else {
        onLog?.("Make a Post: caption field not found — posting without a caption");
      }
    }

    if (disableComments) {
      const advanced = await android.findButtonByLabel(serial, "Advanced settings").catch(() => null);
      if (advanced) {
        await android.tap(serial, advanced.x, advanced.y);
        await sleepOrAbort(serial, 1000);
        const turnOffComments = await android.findButtonByLabel(serial, "Turn off commenting").catch(() => null);
        if (turnOffComments) {
          await android.tap(serial, turnOffComments.x, turnOffComments.y);
          await sleepOrAbort(serial, 400);
        }
        await android.pressBack(serial);
        await sleepOrAbort(serial, 800);
      } else {
        onLog?.("Make a Post: \"Advanced settings\" not found — could not disable comments for this post");
      }
    }

    // Re-find Share (screen may have re-rendered after the caption/advanced steps).
    const finalShareBtn = await android.findButtonByLabel(serial, "Share").catch(() => null) ?? shareBtn;
    onLog?.("Make a Post: tapping Share…");
    await android.tap(serial, finalShareBtn.x, finalShareBtn.y);

    // Poll for the caption screen to disappear — the definitive sign the post
    // was submitted and Instagram is uploading. A blind fixed 3-second wait was
    // not enough: (a) uploads can take 10–15 s on a slow connection, and (b) a
    // tap that silently didn't register (e.g. a stale coordinate) is
    // indistinguishable without actively checking whether Share is still there.
    //
    // Strategy: check every 1.5 s for up to ~15 s total. If Share is still
    // visible after 6 s (4 polls) we assume the first tap was swallowed and
    // retry it once. If Share never disappears, abort and surface the failure.
    let shareConfirmed = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleepOrAbort(serial, 1500);
      const shareStillVisible = await android.findButtonByLabel(serial, "Share").catch(() => null);
      if (!shareStillVisible) {
        shareConfirmed = true;
        break;
      }
      if (attempt === 3) {
        // Still on caption screen after ~6 s — retry the Share tap once.
        onLog?.("Make a Post: Share still visible after 6 s — retrying tap…");
        const retryShareBtn = await android.findButtonByLabel(serial, "Share").catch(() => null) ?? finalShareBtn;
        await android.tap(serial, retryShareBtn.x, retryShareBtn.y);
      }
    }

    // Dismiss any post-share interstitial ("OK", notifications prompt, etc.)
    // that can appear right after sharing and sit on top of the feed if left
    // unhandled.
    await android.dismissInstagramInterstitials(serial).catch(() => null);

    if (!shareConfirmed) {
      onLog?.("Make a Post: Share button still present after ~15 s — post did not submit. Aborting.");
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }

    recordPostedLocalFile(serial, fileName);
    if (deleteAfterUpload) {
      try { await fsPromises.unlink(localFilePath); } catch { /* best effort */ }
    }
    onLog?.(`Make a Post: ✓ posted "${fileName}"`);
    return { posted: true, fileName };
  }

  // ── Random Jitter helpers ─────────────────────────────────────────────────

  /** Check Instagram notifications: tap heart icon → scroll → optionally tap item. */
  async function runCheckNotifications(serial: string, opts: {
    scrollsMin: number; scrollsMax: number;
    clickPctMin: number; clickPctMax: number;
    onLog?: (msg: string) => void;
  }): Promise<void> {
    const { scrollsMin, scrollsMax, clickPctMin, clickPctMax, onLog } = opts;
    // Find the notifications heart icon via accessibility tree scan.
    const icon = await android.findInstagramNotificationsIcon(serial).catch(() => null);
    if (!icon) {
      onLog?.("Random Jitter: notifications icon not found — skipping check notifications");
      logger.warn({ serial }, "[jitter-check-notif] notifications icon not found by scan");
      return;
    }
    await android.tap(serial, icon.x, icon.y);
    await sleepOrAbort(serial, 1800);
    onLog?.("Random Jitter: ✓ opened notifications");
    // Scroll down x–y times to browse through them.
    const scrollCount = rollRange(scrollsMin, scrollsMax);
    const { w, h } = getScreenSize(serial);
    for (let i = 0; i < scrollCount; i++) {
      await android.swipe(
        serial,
        Math.round(w * 0.5), Math.round(h * 0.65),
        Math.round(w * 0.5), Math.round(h * 0.30),
        380 + Math.round(Math.random() * 120),
      );
      await sleepOrAbort(serial, 500 + Math.round(Math.random() * 500));
    }
    // Optionally tap a random notification item (passive: opens a profile or post).
    const clickChance = rollRange(clickPctMin, clickPctMax) / 100;
    if (clickChance > 0 && Math.random() < clickChance) {
      const item = await android.findRandomNotificationItem(serial).catch(() => null);
      if (item) {
        await android.tap(serial, item.x, item.y);
        onLog?.("Random Jitter: ✓ tapped notification item");
        await sleepOrAbort(serial, 2000 + Math.round(Math.random() * 1500));
        await android.pressBack(serial);
        await sleepOrAbort(serial, 600);
      } else {
        onLog?.("Random Jitter: no clickable notification row found — skipping click");
      }
    } else {
      onLog?.("Random Jitter: click-notification roll missed — skipping click");
    }
    // Return to home feed.
    await android.pressBack(serial);
    await sleepOrAbort(serial, 800);
    onLog?.("Random Jitter: ✓ notifications check done");
  }

  /** Visit own profile: tap profile icon in bottom nav, dwell briefly, return to home. */
  async function runVisitOwnProfile(serial: string, onLog?: (msg: string) => void): Promise<void> {
    // Press Back once before scanning so we are guaranteed to be on the
    // Instagram home feed, not still on the notifications page or any other
    // intermediate screen that could cause findInstagramProfileTab to match
    // a wrong element (e.g. the "Add Story" + button in the top-left of the
    // feed, which can appear in the accessibility tree with similar attributes
    // to the profile tab when the nav-bar is not fully rendered yet).
    await android.pressBack(serial);
    await sleepOrAbort(serial, 800);

    // Locate profile tab via accessibility tree — more reliable than fixed %
    // coordinates which drift across screen resolutions and OEM skins.
    const profileTab = await android.findInstagramProfileTab(serial).catch(() => null);
    if (!profileTab) {
      onLog?.("Random Jitter: profile tab not found — skipping visit profile");
      logger.warn({ serial }, "[jitter-visit-profile] profile tab not found by scan");
      return;
    }
    await android.tap(serial, profileTab.x, profileTab.y);
    await sleepOrAbort(serial, 1800 + Math.round(Math.random() * 1000));

    // The profile / "Discover people" page sometimes triggers an
    // "Allow Instagram to access your contacts?" system dialog.
    // Dismiss it automatically so the cycle does not stall.
    const dismissed = await android.dismissInstagramInterstitials(serial).catch(() => null);
    if (dismissed) {
      onLog?.(`Random Jitter: dismissed contacts popup ("${dismissed}")`);
      await sleepOrAbort(serial, 600);
    }

    onLog?.("Random Jitter: ✓ visited own profile");
    // Return to home feed.
    const homeTab = await android.findHomeTab(serial).catch(() => null);
    if (homeTab) {
      await android.tap(serial, homeTab.x, homeTab.y);
    } else {
      await android.pressBack(serial);
    }
    await sleepOrAbort(serial, 600);
  }

  // ── HikerAPI-driven follow step ──────────────────────────────────────────
  interface InjectBrowsingParams {
    activatePctMin: number; activatePctMax: number;
    beforeFollowPctMin: number; beforeFollowPctMax: number;
    feedChanceMin: number; feedChanceMax: number;
    feedMin: number; feedMax: number;
    clickPostPctMin: number; clickPostPctMax: number;
    likePctMin: number; likePctMax: number;
    shareFeedPctMin: number; shareFeedPctMax: number;
    shareDmPctMin: number; shareDmPctMax: number;
  }

  /** Picks a value uniformly from [lo, hi], tolerating either order. */
  function rollRange(min: number, max: number): number {
    const lo = Math.min(min, max), hi = Math.max(min, max);
    return lo + Math.random() * (hi - lo);
  }

  /**
   * Activate Percentage gate — rolls once per tool per automation-cycle
   * execution ("execution" = one full run of the whole toggle-tick loop,
   * i.e. once every wait-interval). A min/max of 100/100 always passes
   * (back-compat default); e.g. 5/10 gives this execution roughly a 5-10%
   * (~7.5% avg) chance of the tool being active at all this time around.
   */
  function rollActivate(min: number, max: number): boolean {
    const chance = rollRange(min, max) / 100;
    return chance > 0 && Math.random() < chance;
  }

  /**
   * Runs the "Inject Browsing" sequence for ONE user's profile page, called
   * (when it rolls true) BEFORE the Follow button is tapped for that user.
   * Every roll below (whether the sequence runs at all, whether the feed
   * gets scrolled, whether a post gets opened, liked, reposted, or shared
   * via DM) is drawn fresh per user — a min/max pair is a range the actual
   * chance for THIS user is drawn from, not a fixed percentage, so e.g.
   * min=5/max=10 gives each user its own roll somewhere in that band
   * (~7.5% on average) rather than exactly 7.5% every time.
   *
   * Must be called while already sitting on the target user's profile page
   * (after findAndTapUserInSearch, before tapFollowButtonOnProfilePage).
   * Every step degrades to a no-op (never throws, never leaves the profile
   * page) if the expected icon/button can't be located — per spec, a
   * missing icon just means that step is skipped for this user.
   */
  async function runProfileBrowsingForUser(
    serial: string,
    browsing: InjectBrowsingParams,
    onLog?: (msg: string) => void,
  ): Promise<void> {
    // Outer gate: "Activate Percentage" — rolls once per user before anything else.
    // If it misses, inject browsing is skipped entirely for this user.
    const activateChance = rollRange(browsing.activatePctMin, browsing.activatePctMax) / 100;
    if (!(activateChance > 0 && Math.random() < activateChance)) return;

    const beforeFollowChance = rollRange(browsing.beforeFollowPctMin, browsing.beforeFollowPctMax) / 100;
    if (!(beforeFollowChance > 0 && Math.random() < beforeFollowChance)) return;

    onLog?.("Inject Browsing: rolled to browse this profile before following");
    const { w, h } = getScreenSize(serial);

    const feedChance = rollRange(browsing.feedChanceMin, browsing.feedChanceMax) / 100;
    if (!(feedChance > 0 && Math.random() < feedChance)) {
      onLog?.("Inject Browsing: feed-scroll roll missed — skipping grid scroll");
      return;
    }

    const rows = Math.max(0, Math.round(rollRange(browsing.feedMin, browsing.feedMax)));
    if (rows === 0) {
      onLog?.("Inject Browsing: feed posts rolled to 0 — skipping grid scroll");
      return;
    }
    onLog?.(`Inject Browsing: scrolling profile grid — ${rows} row(s)`);
    const seenPostSlots: { x: number; y: number }[] = [];
    const x = Math.round(w / 2);
    const y1 = Math.round(h * 0.78);
    const y2 = Math.round(h * 0.30);
    for (let i = 0; i < rows; i++) {
      if (isCycleAborted(serial)) throw new Error("cycle-aborted");
      // Instagram's profile grid is 3 columns; remember roughly where each
      // column sat on THIS scroll position so a later "click post" roll can
      // pick one of the rows actually scrolled past, not a guess.
      seenPostSlots.push(
        { x: Math.round(w * 0.17), y: Math.round(h * 0.55) },
        { x: Math.round(w * 0.50), y: Math.round(h * 0.55) },
        { x: Math.round(w * 0.83), y: Math.round(h * 0.55) },
      );
      await android.swipe(serial, x, y1, x, y2, 500 + Math.round(Math.random() * 200));
      await sleepOrAbort(serial, 350 + Math.round(Math.random() * 300));
    }

    const clickChance = rollRange(browsing.clickPostPctMin, browsing.clickPostPctMax) / 100;
    if (!(clickChance > 0 && Math.random() < clickChance)) {
      onLog?.("Inject Browsing: click-post roll missed — not opening a post");
      return;
    }

    const slot = seenPostSlots[Math.floor(Math.random() * seenPostSlots.length)];
    onLog?.("Inject Browsing: opening a scrolled post");
    await android.tap(serial, slot.x, slot.y);
    await sleepOrAbort(serial, 1200);

    // Confirm a post actually opened (has a Like button) rather than
    // assuming the tap landed on a real thumbnail — profile grids can have
    // gaps (Reels tab strip, "Tagged" empty state, end-of-grid whitespace).
    const icons = await android.findFeedActionIcons(serial).catch(() => null);
    if (!icons) {
      onLog?.("Inject Browsing: no post opened here (empty grid cell or unrecognised layout) — returning to profile");
      logger.info({ serial }, "[inject-browsing] findFeedActionIcons returned null — no Like button found in accessibility tree; post may already be liked (content-desc='Unlike'), or this is a Reel/ad with a non-standard action bar");
      // Press Back to leave whatever was opened (Reel viewer, ad, etc.) so the
      // caller (Follow step) is back on the profile page, not stranded mid-view.
      await android.pressBack(serial);
      await sleepOrAbort(serial, 500);
      return;
    }

    // Diagnostic: show exactly which icons were resolved so we can see
    // what the accessibility tree contained for this specific post.
    logger.info(
      { serial, like: !!icons.like, comment: !!icons.comment, shareFeed: !!icons.shareFeed, shareDm: !!icons.shareDm,
        shareFeedCoords: icons.shareFeed ?? null, shareDmCoords: icons.shareDm ?? null },
      "[inject-browsing] action-bar icons found for this profile post"
    );
    // Only report Like/Comment from the icon scan — ShareFeed and ShareDM are
    // resolved by findButtonByLabel("Repost"/"Send") which runs later and is
    // more reliable than the positional icon scan. Showing them here as ✗
    // was misleading users into thinking the repost/share hadn't worked even
    // when it had (the label-scan found the button even when the icon scan
    // failed to detect it by position).
    onLog?.(`Inject Browsing: icons — Like✓ Comment:${icons.comment?'✓':'✗'}`);

    const likeChance = rollRange(browsing.likePctMin, browsing.likePctMax) / 100;
    logger.info({ serial, likeChance: Math.round(likeChance * 100) }, "[inject-browsing] like chance rolled");
    if (likeChance > 0 && Math.random() < likeChance) {
      try {
        await android.tap(serial, icons.like.x, icons.like.y);
        onLog?.("Inject Browsing: liked the post");
        await sleepOrAbort(serial, 400);
      } catch { /* best effort */ }
    }

    const shareFeedChance = rollRange(browsing.shareFeedPctMin, browsing.shareFeedPctMax) / 100;
    logger.info(
      { serial, shareFeedChance: Math.round(shareFeedChance * 100),
        settingsMin: browsing.shareFeedPctMin, settingsMax: browsing.shareFeedPctMax },
      "[inject-browsing] share-feed chance rolled"
    );
    if (!(shareFeedChance > 0 && Math.random() < shareFeedChance)) {
      onLog?.("Inject Browsing: share-to-feed roll missed — skipping");
    } else {
      try {
        // findButtonByLabel("Repost") is the trusted source — it only
        // returns a node whose content-desc literally matches "Repost", so
        // it can never point at the wrong icon. `icons.shareFeed` (from
        // findFeedActionIcons) is NOT equally trustworthy: when this
        // post's Repost icon has no content-desc, findFeedActionIcons
        // falls back to positional guessing (leftmost unclaimed node),
        // which silently mis-assigns the Comment icon's coordinates to
        // `shareFeed` whenever an icon is missing/unlabeled on this
        // device/build. That regression (Comment tapped instead of
        // Share, previously fixed in v1.1.499/v1.1.500) came back when
        // this code briefly preferred `icons.shareFeed` over the label
        // scan — do NOT invert this priority again. `icons.shareFeed` is
        // only used as a last resort when the label scan finds nothing.
        const repostIcon = await android.findButtonByLabel(serial, "Repost").catch(() => null) ?? icons.shareFeed;
        if (!repostIcon) {
          onLog?.("Inject Browsing: Repost icon not found on this post — skipping share-to-feed");
          logger.warn({ serial }, "[inject-browsing] neither findFeedActionIcons row-scan nor findButtonByLabel('Repost') found the icon — likely absent on this post (sharing disabled by poster)");
        } else {
          // Capture the icon's own label BEFORE tapping. Some accounts'
          // Instagram build reposts instantly on a single tap with NO
          // confirmation sheet at all — the icon just relabels itself in
          // place (e.g. "Repost" -> "Remove repost"/"Reposted"). Comparing
          // before/after lets us tell that apart from "sheet genuinely
          // never opened", which both look identical (a "Repost"-matching
          // node at the same coordinates) to a same-coords-only check —
          // confirmed via a live run where a real, successful single-tap
          // repost was misread as failure and triggered a wrong pressBack.
          await android.tap(serial, repostIcon.x, repostIcon.y);
          logger.info({ serial, x: repostIcon.x, y: repostIcon.y }, "[inject-browsing] tapped Repost icon");
          // Wait briefly for a confirmation sheet to appear (some devices/builds
          // show a "Repost" confirm button inside a bottom sheet; others do the
          // repost instantly on a single tap with no sheet at all).
          await sleepOrAbort(serial, 1000);
          const repostBtn = await android.findButtonByLabel(serial, "Repost").catch(() => null);
          const sameCoords = !!repostBtn &&
            Math.abs(repostBtn.x - repostIcon.x) < 15 && Math.abs(repostBtn.y - repostIcon.y) < 15;
          if (repostBtn && !sameCoords) {
            // A separate "Repost" confirm button appeared at a different
            // position — a real sheet is open. Tap it to confirm.
            await android.tap(serial, repostBtn.x, repostBtn.y);
            onLog?.("Inject Browsing: reposted the post");
            await sleepOrAbort(serial, 800);
            const closeBtn = await android.findButtonByLabel(serial, "Close").catch(() => null);
            if (closeBtn) { await android.tap(serial, closeBtn.x, closeBtn.y); await sleepOrAbort(serial, 400); }
          } else {
            // No sheet appeared — either the repost completed on a single tap
            // (no confirmation sheet on this device/build), or the post does
            // not support resharing. In both cases: do NOT press Back.
            // Pressing Back navigates away from the post and breaks the
            // remaining actions (ShareDM etc.) that still need to run.
            // The tap already fired; assume it worked.
            onLog?.("Inject Browsing: reposted the post (single tap — no sheet)");
            logger.info({ serial, repostBtn, sameCoords }, "[inject-browsing] no sheet appeared after Repost tap — assuming single-tap repost completed");
          }
        }
      } catch (e: any) {
        if (e?.message === "cycle-aborted") throw e;
        onLog?.(`Inject Browsing: share-to-feed error — ${e?.message}`);
      }
    }

    const shareDmChance = rollRange(browsing.shareDmPctMin, browsing.shareDmPctMax) / 100;
    logger.info(
      { serial, shareDmChance: Math.round(shareDmChance * 100),
        settingsMin: browsing.shareDmPctMin, settingsMax: browsing.shareDmPctMax },
      "[inject-browsing] share-DM chance rolled"
    );
    if (!(shareDmChance > 0 && Math.random() < shareDmChance)) {
      onLog?.("Inject Browsing: share-via-DM roll missed — skipping");
    } else {
      try {
        // Same reasoning as share-to-feed above: the label scan is the
        // trusted source because it only matches a node whose content-desc
        // literally says "Send"/"Direct"/"Message". `icons.shareDm` can be
        // a positional guess inside findFeedActionIcons and has previously
        // mis-mapped onto the Comment icon when a role's label was
        // missing/unmatched on-device — never prefer it over the label
        // scan. It's used only as a last resort when the label scan finds
        // nothing at all.
        const sendIcon =
          (await android.findButtonByLabel(serial, "Send").catch(() => null)) ??
          (await android.findButtonByLabel(serial, "Direct").catch(() => null)) ??
          (await android.findButtonByLabel(serial, "Message").catch(() => null)) ??
          icons.shareDm;
        if (!sendIcon) {
          onLog?.("Inject Browsing: Send icon not found on this post — skipping share-via-DM");
          logger.warn({ serial }, "[inject-browsing] neither findFeedActionIcons row-scan nor findButtonByLabel('Send'/'Direct'/'Message') found the icon — likely absent or unlabeled on this build");
        } else {
          await android.tap(serial, sendIcon.x, sendIcon.y);
          logger.info({ serial, x: sendIcon.x, y: sendIcon.y }, "[inject-browsing] tapped Send icon");
          await sleepOrAbort(serial, 1200);
          await tapRandomShareSheetRecipient(serial, w, h);
          await sleepOrAbort(serial, 1500);
          const sent = await sendShareSheet(serial, w, h);
          if (sent) { onLog?.("Inject Browsing: shared the post via DM"); await sleepOrAbort(serial, 600); }
          else {
            onLog?.("Inject Browsing: share sheet did not confirm send — skipping share-via-DM");
            await android.pressBack(serial); await sleepOrAbort(serial, 400);
          }
        }
      } catch (e: any) {
        if (e?.message === "cycle-aborted") throw e;
        onLog?.(`Inject Browsing: share-via-DM error — ${e?.message}`);
      }
    }

    // Back out of the opened post to the profile grid before continuing.
    await android.pressBack(serial);
    await sleepOrAbort(serial, 500);
  }

  async function runFollowUsersStep(
    serial: string,
    params: {
      usersMin: number;
      usersMax: number;
      sources: { type: string; value: string }[];
      onLog?: (msg: string) => void;
      recordFollow?: (username: string, source: string) => void;
      browsing?: InjectBrowsingParams;
    },
  ): Promise<number> {
    const { usersMin, usersMax, sources, onLog, recordFollow, browsing } = params;

    if (!sources.length) {
      onLog?.("Follow: no target sources configured — skipping");
      return 0;
    }

    const globalSettings = await storage.getGlobalSettings();
    const hikerApiToken: string = globalSettings?.hikerApiToken ?? "";
    if (!hikerApiToken) {
      onLog?.("Follow: HikerAPI token not configured (Settings → Global → HikerAPI) — skipping");
      return 0;
    }

    const lo = Math.min(usersMin, usersMax);
    const hi = Math.max(usersMin, usersMax);
    const targetCount = lo === hi ? lo : Math.round(lo + Math.random() * (hi - lo));
    if (targetCount === 0) { onLog?.("Follow: target count is 0 — skipping"); return 0; }

    onLog?.(`Follow: targeting ${targetCount} users from ${sources.length} source(s)`);

    const hiker = new HikerApiClient(hikerApiToken);
    // Track source per username so the Followed Users tab shows the hashtag
    // or target account the user was discovered from, not "hikerapi".
    const candidateSource = new Map<string, string>();
    const candidates: string[] = [];

    for (const src of sources) {
      if (candidates.length >= targetCount * 3) break;
      const sourceLabel = src.type === "hashtag"
        ? `#${src.value.replace(/^#/, "")}`
        : `@${src.value.replace(/^@/, "")}`;
      try {
        if (src.type === "hashtag") {
          const res = await hiker.getHashtagUsers(src.value.replace(/^#/, ""), 50);
          for (const u of res.users) {
            if (!candidateSource.has(u.username)) candidateSource.set(u.username, sourceLabel);
            candidates.push(u.username);
          }
          onLog?.(`Follow: ${sourceLabel} → ${res.users.length} users`);
        } else if (src.type === "target_followers") {
          const userInfo = await hiker.getUserByUsername(src.value.replace(/^@/, "")).catch(() => null);
          if (!userInfo?.pk) { onLog?.(`Follow: could not resolve @${src.value} — skipping source`); continue; }
          const followers = await hiker.getFollowers(userInfo.pk, 50);
          for (const u of followers) {
            if (!candidateSource.has(u.username)) candidateSource.set(u.username, sourceLabel);
            candidates.push(u.username);
          }
          onLog?.(`Follow: ${sourceLabel} followers → ${followers.length} users`);
        }
      } catch (e: any) {
        onLog?.(`Follow: HikerAPI error for source "${src.value}": ${e?.message}`);
      }
    }

    if (!candidates.length) { onLog?.("Follow: no candidates collected — skipping"); return 0; }

    const targets = [...new Set(candidates)].sort(() => Math.random() - 0.5).slice(0, targetCount);
    onLog?.(`Follow: following ${targets.length} unique users`);

    let followed = 0;

    // Navigate to Search tab
    const searchTab = await android.findInstagramSearchTab(serial).catch(() => null);
    if (!searchTab) { onLog?.("Follow: Search tab not found — skipping"); return 0; }
    await android.tap(serial, searchTab.x, searchTab.y);
    // Give the Explore page more time to fully render — 1500 ms was sometimes
    // too short on slower devices / cold-launch (only Follow enabled, no prior
    // feed scroll), leaving the search bar absent from the accessibility tree.
    await sleepOrAbort(serial, 2500);

    for (let _fi = 0; _fi < targets.length; _fi++) {
      const username = targets[_fi];
      const isLastUser = _fi === targets.length - 1;
      try {
        onLog?.(`Follow: → @${username}`);

        // Tap the search bar — wait longer so the Explore page settles and the
        // field has time to focus before the keyboard opens.  A 600 ms wait was
        // too short: on slower devices the bar tap could land below the field
        // (causing a scroll/pull-to-refresh) or the keyboard didn't animate up
        // before typeViaOnscreenKeyboard started.
        const searchBar = await android.findInstagramSearchBar(serial, onLog).catch(() => null);
        if (!searchBar) { onLog?.("Follow: search bar lookup threw — giving up"); break; }
        await android.tap(serial, searchBar.x, searchBar.y);
        await sleepOrAbort(serial, 1500);

        // Clear any existing text
        await android.keyevent(serial, "KEYCODE_MOVE_END");
        await sleepOrAbort(serial, 150);
        await android.keyevent(serial, "KEYCODE_CTRL_A");
        await sleepOrAbort(serial, 150);
        await android.keyevent(serial, "KEYCODE_DEL");
        await sleepOrAbort(serial, 300);

        // Type @username character by character on the on-screen keyboard
        // (fixes the d→f / a→s coordinate-offset bug via UIAutomator key detection)
        await android.typeViaOnscreenKeyboard(serial, `@${username}`, onLog);
        await sleepOrAbort(serial, 1200);

        // Tap the matched user in results
        const found = await android.findAndTapUserInSearch(serial, username).catch(() => false);
        if (!found) {
          onLog?.(`Follow: @${username} not found in results — skipping`);
          await android.pressBack(serial);
          await sleepOrAbort(serial, 500);
          continue;
        }

        await sleepOrAbort(serial, 1500);

        // Inject Browsing — rolled fresh for this user; browses the
        // profile's grid (scroll/open/like/repost/share-DM) BEFORE the
        // Follow tap when it rolls true, so the follow doesn't always look
        // like an instant drive-by.
        if (browsing) {
          await runProfileBrowsingForUser(serial, browsing, onLog).catch((e: any) => {
            if (e?.message === "cycle-aborted") throw e;
            onLog?.(`Inject Browsing: error — ${e?.message}`);
          });
          // Browsing may have scrolled the profile grid, pushing the Follow
          // button (in the profile header) off-screen. Scroll back to the top
          // of the profile before attempting the Follow tap.
          const { w: bw, h: bh } = getScreenSize(serial);
          for (let _si = 0; _si < 4; _si++) {
            await android.swipe(serial, Math.round(bw / 2), Math.round(bh * 0.30), Math.round(bw / 2), Math.round(bh * 0.75), 280);
            await sleepOrAbort(serial, 180);
          }
          await sleepOrAbort(serial, 400);
        }

        // Tap Follow on the profile page. Only logs success when the button
        // is confirmed to have changed to "Following" or "Requested".
        const didFollow = await android.tapFollowButtonOnProfilePage(serial).catch(() => false);
        if (didFollow) {
          followed++;
          recordFollow?.(username, candidateSource.get(username) ?? "unknown");
          onLog?.(`Follow: ✓ followed @${username} (${followed}/${targets.length})`);
          await sleepOrAbort(serial, 1000 + Math.round(Math.random() * 1500));
        } else {
          onLog?.(`Follow: Follow button not found or state did not change on @${username} — already following?`);
        }

        // Go back to search only when there are more users to follow.
        // After the last user the pressBack would land on the search/explore
        // page unnecessarily — the cycle closes Instagram itself right after.
        if (!isLastUser) {
          await android.pressBack(serial);
          await sleepOrAbort(serial, 600);
        }
      } catch (e: any) {
        if (e?.message === "cycle-aborted") throw e;
        onLog?.(`Follow: error on @${username}: ${e?.message}`);
      }
    }

    return followed;
  }

  // ── Followed Users endpoint — returns in-memory follow log per device ─────
  app.get("/api/mobile/devices/:serial/followed-users", (req: Request, res: Response) => {
    const serial = req.params.serial as string;
    const list = getMobileFollowedList(serial);
    res.json({ ok: true, users: list });
  });

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
    let followedCount = 0;
    const cycleStart = Date.now();
    // tLog prefixes every log line with elapsed seconds so the user can see
    // exactly where each chunk of time is going in the Log tab.
    const tLog = (msg: string) => {
      const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
      sendVideoLog(serial, `[${elapsed}s] ${msg}`);
    };
    try {
      const {
        count, delayMinSec, delayMaxSec, likePercentMin, likePercentMax,
        airplaneWaitMinSec, airplaneWaitMaxSec,
        feedEnabled, storiesEnabled,
        shareFeedPercentMin, shareFeedPercentMax,
        shareDmPercentMin, shareDmPercentMax,
        viewStoriesSlidesMin, viewStoriesSlidesMax,
        viewStoriesSlideWatchPctMin, viewStoriesSlideWatchPctMax,
        viewStoriesLikePercentMin, viewStoriesLikePercentMax,
        viewStoriesShareDmPercentMin, viewStoriesShareDmPercentMax,
        followEnabled, followUsersMin, followUsersMax, followSources,
        injectBrowsingEnabled,
        injectBrowsingActivatePctMin, injectBrowsingActivatePctMax,
        injectBrowsingBeforeFollowPctMin, injectBrowsingBeforeFollowPctMax,
        injectBrowsingFeedChanceMin, injectBrowsingFeedChanceMax,
        injectBrowsingFeedMin, injectBrowsingFeedMax,
        injectBrowsingClickPostPctMin, injectBrowsingClickPostPctMax,
        injectBrowsingLikePctMin, injectBrowsingLikePctMax,
        injectBrowsingShareFeedPctMin, injectBrowsingShareFeedPctMax,
        injectBrowsingShareDmPctMin, injectBrowsingShareDmPctMax,
        randomJitterEnabled,
        checkNotificationsPctMin, checkNotificationsPctMax,
        checkNotificationsScrollsMin, checkNotificationsScrollsMax,
        checkNotificationsClickPctMin, checkNotificationsClickPctMax,
        visitProfilePctMin, visitProfilePctMax,
        feedActivatePctMin, feedActivatePctMax,
        viewStoriesActivatePctMin, viewStoriesActivatePctMax,
        followActivatePctMin, followActivatePctMax,
        randomJitterActivatePctMin, randomJitterActivatePctMax,
        makePostEnabled, makePostActivatePctMin, makePostActivatePctMax,
        makePostPerSessionMin, makePostPerSessionMax,
        makePostLocalFolderEnabled, makePostLocalFolderPath,
        makePostLocalFolderNoRepeat, makePostLocalFolderRandom, makePostLocalFolderDeleteAfterUpload,
        makePostDisableComments, makePostCaptionText,
      } = automationCycleSchema.parse(req.body);

      // 1. Power on the phone.
      tLog("▶ Waking screen…");
      await android.wakeScreen(serial);
      steps.push("power-on");
      await sleepOrAbort(serial, 1200); // let the screen finish waking

      // 1b. Swipe up from the bottom to dismiss the lock screen.  On MIUI
      // (Xiaomi) and similar OEM skins, `am start` alone does NOT clear the
      // keyguard — the app launches behind the lock screen and all subsequent
      // taps land on the keyguard instead of Instagram.  A real swipe gesture
      // also resets the screen-off timeout so the display stays on while the
      // cycle runs (KEYCODE_WAKEUP alone does not count as touch input).
      tLog("▶ Unlocking screen…");
      await android.swipeUpFromBottom(serial);
      steps.push("unlock-swipe");
      await sleepOrAbort(serial, 800); // let the keyguard animation complete
      tLog("  ✓ Screen unlocked");

      // 2. Open Instagram.
      tLog("▶ Opening Instagram…");
      await android.launchInstagram(serial);
      steps.push("launch-instagram");
      // Reduced from 2000 → 1200 ms. The dismissAdsChoiceDialog and
      // dismissInstagramInterstitials calls below each do a UIAutomator
      // accessibility dump which takes ~1-2 s on a loaded device, so the
      // total time before scrolling starts is covered by those dumps — we
      // don't need a long fixed wait on top of them.
      await sleepOrAbort(serial, 1200);

      // 2b. Meta occasionally shows a full-screen "ads choice" consent modal
      // on launch (Get started → Use for free with ads → Continue → Agree).
      // It blocks the whole screen, so every scripted tap after it would
      // silently land on the modal instead of the feed. Walk through it if
      // present; this is a no-op if the dialog isn't showing.
      // Each dismissal call runs a UIAutomator accessibility dump which can
      // take 5–15 s on the Instagram splash screen. Log before AND after every
      // call so the user can see exactly what is eating time in the Log tab —
      // previously the whole 20 s was a single silent gap between two lines.
      tLog("▶ UIAutomator: scanning for ads-choice dialog…");
      const adsChoice = await android.dismissAdsChoiceDialog(serial).catch(() => ({ dismissed: false, steps: [] as string[] }));
      if (adsChoice.dismissed) {
        steps.push(`ads-choice-dialog(${adsChoice.steps.length} steps)`);
        tLog(`▶ Dismissed ads-choice dialog (${adsChoice.steps.length} taps)`);
        await sleepOrAbort(serial, 1000);
      } else {
        tLog("▶ No ads-choice dialog — continuing");
      }

      // 2c. Dismiss any other interstitial (notifications, save-login, etc.)
      tLog("▶ UIAutomator: scanning for other launch popups…");
      const launchPopup = await android.dismissInstagramInterstitials(serial).catch(() => null);
      if (launchPopup) {
        steps.push(`launch-popup-dismissed(${launchPopup})`);
        tLog(`▶ Dismissed launch popup (${launchPopup})`);
        await sleepOrAbort(serial, 600);
      } else {
        tLog("▶ No launch popup — feed ready");
      }
      tLog("  ✓ Instagram open");

      // 3. Scroll the feed (Step 2 in the UI) — skipped entirely when the
      // "View Feed" checkbox is unticked, per-slide enable/disable (12 Jul 2026).
      let likes = 0, likeFailures = 0, sharesFeed = 0, sharesDm = 0, strayNavRecoveries = 0;
      if (feedEnabled && rollActivate(feedActivatePctMin, feedActivatePctMax)) {
        tLog(`▶ Starting feed scroll — ${count} posts`);
        ({ likes, likeFailures, sharesFeed, sharesDm, strayNavRecoveries } = await runCheckFeedLoop(serial, {
          count, delayMinSec, delayMaxSec, likePercentMin, likePercentMax,
          shareFeedPercentMin, shareFeedPercentMax,
          shareDmPercentMin, shareDmPercentMax,
          onLog: (msg) => sendVideoLog(serial, `  ${msg}`),
        }));
        steps.push(`feed(${count} scrolls, ${likes} likes, ${sharesFeed} feed-shares, ${sharesDm} dm-shares, ${likeFailures} like-failures${strayNavRecoveries ? `, ${strayNavRecoveries} ad-nav-recoveries` : ""})`);
        tLog(`▶ Feed done — ${likes} likes, ${sharesFeed} feed-shares, ${sharesDm} DM-shares`);
      } else if (!feedEnabled) {
        steps.push("feed(skipped — View Feed disabled)");
        tLog("▶ View Feed disabled — skipping feed scroll");
      } else {
        steps.push("feed(skipped — Activate Percentage roll missed this execution)");
        tLog("▶ View Feed Activate Percentage roll missed — skipping feed scroll this execution");
      }

      // 4. View stories (Step 3 in the UI) — runs AFTER the feed scroll,
      // skipped entirely when the "View Stories from Feed" checkbox is
      // unticked.
      if (storiesEnabled && viewStoriesSlidesMax > 0 && rollActivate(viewStoriesActivatePctMin, viewStoriesActivatePctMax)) {
        tLog("▶ Tapping Home tab for stories…");
        // Find the real Home tab via the accessibility tree instead of a
        // guessed screen percentage — the fixed 10%/97.5% coordinates were
        // landing on a feed post instead of the bottom-nav house icon on
        // some devices/screen ratios. Fall back to the old percentage guess
        // only if the element genuinely can't be found.
        const homeTab = await android.findHomeTab(serial).catch(() => null);
        if (homeTab) {
          await android.tap(serial, homeTab.x, homeTab.y);
        } else {
          const { w: sw, h: sh } = getScreenSize(serial);
          await android.tap(serial, Math.round(sw * 0.10), Math.round(sh * 0.975));
        }
        // The Home tap forces Instagram to refresh the feed back to the top,
        // but the stories tray doesn't repopulate instantly — it needs up to
        // ~10s to reload after the refresh. Tapping the story bar before then
        // lands on empty space (no story opens) and the whole stories step
        // silently no-ops. 1.5s was nowhere near enough; wait the full 10s.
        // Dismiss any popup that appeared after tapping Home (notifications
        // prompt often fires here since the feed just refreshed).
        const preStoriesPopup = await android.dismissInstagramInterstitials(serial).catch(() => null);
        if (preStoriesPopup) {
          steps.push(`pre-stories-popup-dismissed(${preStoriesPopup})`);
          await sleepOrAbort(serial, 600);
        }
        // Reduced from 10 000 → 5 000 ms. 10 s was added because 1.5 s was
        // "nowhere near enough" on a first test — but 10 s is the extreme
        // upper bound; on the user's device the story tray reliably reloads
        // in 3–5 s. Cutting it to 5 s eliminates the long dead pause the
        // user sees after scrolling ends and before any story opens.
        tLog("▶ Waiting for story tray to load…");
        await sleepOrAbort(serial, 5000);
        tLog(`▶ Starting stories (up to ${viewStoriesSlidesMax})`);
        const result = await runViewStoriesFromFeedLoop(serial, {
          slidesMin: viewStoriesSlidesMin, slidesMax: viewStoriesSlidesMax,
          slideWatchPctMin: viewStoriesSlideWatchPctMin, slideWatchPctMax: viewStoriesSlideWatchPctMax,
          likePercentMin: viewStoriesLikePercentMin, likePercentMax: viewStoriesLikePercentMax,
          shareDmPercentMin: viewStoriesShareDmPercentMin, shareDmPercentMax: viewStoriesShareDmPercentMax,
          onLog: (msg) => tLog(`  ${msg}`),
        });
        storiesWatched = result.storiesWatched;
        steps.push(`stories(${result.storiesWatched} watched)`);
        tLog(`▶ Stories done — ${result.storiesWatched} watched`);
      } else if (!storiesEnabled) {
        steps.push("stories(skipped — View Stories from Feed disabled)");
        tLog("▶ View Stories from Feed disabled — skipping stories");
      } else if (storiesEnabled && viewStoriesSlidesMax > 0) {
        steps.push("stories(skipped — Activate Percentage roll missed this execution)");
        tLog("▶ View Stories from Feed Activate Percentage roll missed — skipping stories this execution");
      }

      // 4b. Follow Users — HikerAPI-driven follow step. Runs after stories/feed
      // so the phone is already on Instagram; navigates to Search, types each
      // @username character by character on the on-screen keyboard, and taps Follow.
      if (followEnabled && rollActivate(followActivatePctMin, followActivatePctMax)) {
        tLog("▶ Follow Users — fetching targets via HikerAPI…");
        try {
          const followCount = await runFollowUsersStep(serial, {
            usersMin: followUsersMin,
            usersMax: followUsersMax,
            sources: followSources,
            onLog: (msg) => tLog(`  ${msg}`),
            recordFollow: (username, source) => recordMobileFollow(serial, username, source),
            browsing: injectBrowsingEnabled ? {
              activatePctMin: injectBrowsingActivatePctMin, activatePctMax: injectBrowsingActivatePctMax,
              beforeFollowPctMin: injectBrowsingBeforeFollowPctMin, beforeFollowPctMax: injectBrowsingBeforeFollowPctMax,
              feedChanceMin: injectBrowsingFeedChanceMin, feedChanceMax: injectBrowsingFeedChanceMax,
              feedMin: injectBrowsingFeedMin, feedMax: injectBrowsingFeedMax,
              clickPostPctMin: injectBrowsingClickPostPctMin, clickPostPctMax: injectBrowsingClickPostPctMax,
              likePctMin: injectBrowsingLikePctMin, likePctMax: injectBrowsingLikePctMax,
              shareFeedPctMin: injectBrowsingShareFeedPctMin, shareFeedPctMax: injectBrowsingShareFeedPctMax,
              shareDmPctMin: injectBrowsingShareDmPctMin, shareDmPctMax: injectBrowsingShareDmPctMax,
            } : undefined,
          });
          followedCount = followCount;
          steps.push(`follow(${followCount} followed)`);
          tLog(`▶ Follow done — ${followCount} users followed`);
        } catch (e: any) {
          if (e?.message === "cycle-aborted") throw e;
          tLog(`▶ Follow step error — ${e?.message}`);
          steps.push("follow(error)");
        }
      } else if (!followEnabled) {
        // no-op log line intentionally omitted — Follow Users disabled is
        // the common/default state and would spam the log every cycle.
      } else {
        steps.push("follow(skipped — Activate Percentage roll missed this execution)");
        tLog("▶ Follow Users Activate Percentage roll missed — skipping follow step this execution");
      }

      // 4b-ii. Make a Post — pushes a local-folder image to the device, taps
      // Instagram's "+" compose icon, and walks the create-post flow. Runs
      // after Follow, before Random Jitter. Only the local-folder image
      // source is wired up on-device (per user preference over the
      // HikerAPI-scrape-from-another-user alternative already used by
      // Follow Users above).
      if (makePostEnabled && rollActivate(makePostActivatePctMin, makePostActivatePctMax)) {
        if (!makePostLocalFolderEnabled || !makePostLocalFolderPath) {
          steps.push("make-a-post(skipped — Local Folder source not configured)");
          tLog("▶ Make a Post enabled but no Local Folder path configured — skipping");
        } else {
          const postCount = rollRange(makePostPerSessionMin, makePostPerSessionMax);
          tLog(`▶ Make a Post — attempting ${postCount} post(s) from local folder…`);
          let posted = 0;
          for (let i = 0; i < postCount; i++) {
            try {
              const result = await runMakePostStep(serial, {
                localFolderPath: makePostLocalFolderPath,
                localFolderRandom: makePostLocalFolderRandom,
                localFolderNoRepeat: makePostLocalFolderNoRepeat,
                deleteAfterUpload: makePostLocalFolderDeleteAfterUpload,
                captionText: makePostCaptionText,
                disableComments: makePostDisableComments,
                onLog: (msg) => tLog(`  ${msg}`),
              });
              if (result.posted) posted++;
              else break; // no image available / a UI step aborted — don't keep retrying blind
            } catch (e: any) {
              if (e?.message === "cycle-aborted") throw e;
              tLog(`▶ Make a Post attempt error — ${e?.message}`);
              break;
            }
          }
          steps.push(`make-a-post(${posted}/${postCount} posted)`);
          tLog(`▶ Make a Post done — ${posted}/${postCount} posted`);
        }
      } else if (makePostEnabled) {
        steps.push("make-a-post(skipped — Activate Percentage roll missed this execution)");
        tLog("▶ Make a Post Activate Percentage roll missed — skipping this execution");
      }

      // 4c. Random Jitter — human-like interstitial actions run after the main
      // tools but before closing Instagram.  Each one rolls its own chance
      // independently so they can all fire, none fire, or any subset fires.
      // The Activate Percentage below is an outer gate for the whole Random
      // Jitter tool this execution, on top of (not instead of) each
      // sub-action's own independent chance.
      if (randomJitterEnabled && rollActivate(randomJitterActivatePctMin, randomJitterActivatePctMax)) {
        // Check Notifications
        const notifChance = rollRange(checkNotificationsPctMin, checkNotificationsPctMax) / 100;
        if (notifChance > 0 && Math.random() < notifChance) {
          tLog("▶ Random Jitter: checking notifications…");
          await runCheckNotifications(serial, {
            scrollsMin: checkNotificationsScrollsMin,
            scrollsMax: checkNotificationsScrollsMax,
            clickPctMin: checkNotificationsClickPctMin,
            clickPctMax: checkNotificationsClickPctMax,
            onLog: (msg) => tLog(`  ${msg}`),
          });
          steps.push("jitter-check-notifications");
        }
        // Visit My Profile
        const profileChance = rollRange(visitProfilePctMin, visitProfilePctMax) / 100;
        if (profileChance > 0 && Math.random() < profileChance) {
          tLog("▶ Random Jitter: visiting own profile…");
          await runVisitOwnProfile(serial, (msg) => tLog(`  ${msg}`));
          steps.push("jitter-visit-profile");
        }
      } else if (randomJitterEnabled) {
        steps.push("jitter(skipped — Activate Percentage roll missed this execution)");
        tLog("▶ Random Jitter Activate Percentage roll missed — skipping jitter this execution");
      }

      // 5. Close Instagram completely — recents switcher + swipe away, not a
      // force-stop, so the device behaves like a person put it down.
      tLog("▶ Closing Instagram…");
      await android.closeInstagramViaRecents(serial, (msg) => tLog(`  ${msg}`));
      steps.push("closed-instagram");
      tLog("  ✓ Instagram closed");

      // After close, the recents overview is still on screen (we opened it
      // to do the swipe attempt). Press HOME to dismiss it and return to the
      // launcher before sleeping — otherwise the phone locks with recents
      // still showing and the next cycle wakes to an unexpected screen.
      await android.keyevent(serial, 3 /* KEYCODE_HOME */);
      await new Promise(r => setTimeout(r, 600)); // let launcher animate in

      // 6. Cycle airplane mode on, wait, then off — forces a fresh network
      // session on the next run.
      tLog("▶ Airplane mode ON — recycling network…");
      await android.setAirplaneMode(serial, true);
      tLog("  ✓ Airplane mode on — waiting…");
      steps.push("airplane-mode-on");
      const waitLoSec = Math.min(airplaneWaitMinSec, airplaneWaitMaxSec);
      const waitHiSec = Math.max(airplaneWaitMinSec, airplaneWaitMaxSec);
      const waitSec = waitLoSec + Math.random() * (waitHiSec - waitLoSec);
      await sleepOrAbort(serial, Math.round(waitSec * 1000));
      tLog("▶ Airplane mode OFF — restoring network…");
      await android.setAirplaneMode(serial, false);
      tLog("  ✓ Airplane mode off — network reconnecting");
      steps.push("airplane-mode-off");

      // 7. Swipe up, then press power again to lock the phone — ready for
      // the next cycle to start from a clean, screen-off state.
      await sleepOrAbort(serial, 1500); // let the radios reconnect before touching the screen
      await android.swipeUpFromBottom(serial);
      steps.push("swipe-up");
      tLog("▶ Locking phone — cycle complete ✓");
      await android.sleepScreen(serial);
      steps.push("power-off");

      res.json({ ok: true, count, likes, likeFailures, sharesFeed, sharesDm, storiesWatched, followedCount, strayNavRecoveries, steps });
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
  // Android's virtual-display capture (what `screenrecord` records against)
  // NEVER stretches the source display to fill a differently-shaped output
  // buffer — SurfaceFlinger's display projection preserves the source
  // aspect ratio and pads the rest of the buffer with black (letterboxed if
  // the buffer is relatively taller, pillarboxed if it's relatively wider).
  // That means when the video buffer's own aspect ratio doesn't match the
  // device's real `wm size` ratio, the real screen content only occupies a
  // centered sub-rectangle of the buffer — the remaining border is dead
  // encoder padding, not scaled-down real content.
  //
  // A naive `x/videoW*realW` scale (the previous implementation) treats the
  // WHOLE buffer, padding included, as if it linearly covered the whole real
  // screen. That is correct at the padded axis's center (padding is
  // symmetric, so the middle lines up) but increasingly wrong the further a
  // tap is from that center — exactly the "accurate in the middle, off near
  // the edges" pattern reported after [1.1.558] (videoW×videoH 720×1280 vs.
  // device 1080×2460 on the affected hardware: those ratios differ by ~22%,
  // so the padded axis alone accounts for a very real, very visible offset
  // that grows toward the padded edges). Compute the actual content
  // sub-rect within the buffer first, then scale relative to THAT.
  function videoContentRect(videoW: number, videoH: number, realW: number, realH: number): { x: number; y: number; w: number; h: number } {
    const videoRatio = videoW / videoH;
    const deviceRatio = realW / realH;
    if (Math.abs(videoRatio - deviceRatio) / deviceRatio < 0.005) {
      return { x: 0, y: 0, w: videoW, h: videoH };
    }
    if (videoRatio > deviceRatio) {
      // Buffer is relatively wider than the device screen — pillarboxed
      // (dead columns) left/right; real content spans the full buffer height.
      const w = videoH * deviceRatio;
      return { x: (videoW - w) / 2, y: 0, w, h: videoH };
    }
    // Buffer is relatively taller than the device screen — letterboxed
    // (dead rows) top/bottom; real content spans the full buffer width.
    const h = videoW / deviceRatio;
    return { x: 0, y: (videoH - h) / 2, w: videoW, h };
  }

  // Shared by /input/tap and /input/double-tap — the mirrored video frame is
  // often downscaled (and, per videoContentRect above, letterboxed/
  // pillarboxed) relative to the device's real resolution, so tap
  // coordinates captured against the video's pixel size need rescaling
  // through the real content sub-rect before they're sent to adb.
  function rescaleForDevice(serial: string, x: number, y: number, videoW?: number, videoH?: number): { x: number; y: number; rescaled: boolean; video: [number,number]; device: [number,number]; from: [number,number]; to: [number,number] } {
    const noOp = { x, y, rescaled: false, video: [videoW ?? 0, videoH ?? 0] as [number,number], device: [0,0] as [number,number], from: [x,y] as [number,number], to: [x,y] as [number,number] };
    if (!videoW || !videoH) return noOp;
    try {
      const tools = android.detectToolset();
      const adbPath = tools.adb.path;
      if (!adbPath) return noOp;
      const wm = spawnSync(adbPath, ["-s", serial, "shell", "wm", "size"], { encoding: "utf8", timeout: 3000 });
      const out = wm.stdout ?? "";
      // `wm size` can print BOTH a "Physical size" and an "Override size"
      // line when a display-size override is active (e.g. a prior
      // testing/scaling change). Touch input is interpreted against the
      // CURRENT logical size, which is the override when one is set — not
      // the physical panel resolution. Picking the first match (always
      // "Physical size") when an override was active meant every rescaled
      // tap was proportionally off from the true target, growing with
      // distance from the top-left corner — exactly the "tap the left edge
      // of a key = correct, tap its centre = lands one key over" pattern
      // reported on this device. Prefer Override size when present.
      const overrideM = out.match(/Override size:\s*(\d+)x(\d+)/);
      const physicalM = out.match(/Physical size:\s*(\d+)x(\d+)/);
      const m = overrideM ?? physicalM ?? out.match(/(\d+)x(\d+)/);
      if (!m) return noOp;
      const realW = parseInt(m[1]);
      const realH = parseInt(m[2]);
      const device: [number,number] = [realW, realH];
      if (realW === videoW && realH === videoH) return { ...noOp, device };
      // NOTE: a previous version of this function skipped rescaling whenever
      // the video and device aspect ratios differed by more than 2%, on the
      // theory that a mismatched AR meant `wm size` was reporting an
      // incompatible coordinate space (e.g. the physical panel resolution
      // instead of the logical input space) and that raw video coordinates
      // must already be correct. That was wrong and made every manual mirror
      // tap land far from the click (confirmed via Click Test: bullseye vs.
      // yellow dot at completely different spots, "double the size" symptom,
      // taps landing near the middle of the screen for edge taps).
      //
      // The real explanation (see the comment above the screenrecord spawn
      // in this file's video-WS route): `screenrecord` is *never* pinned to
      // the device's exact `wm size` because most panel resolutions aren't
      // 16-pixel-aligned, so screenrecord silently picks its own encoder-
      // supported size — which can legitimately have a different aspect
      // ratio than the panel (e.g. video 720×1280 vs. device 1080×2460 on
      // this hardware). That's expected, not a sign of an incompatible
      // coordinate space. `wm size` (Override if present, else Physical) is
      // still the space `adb shell input tap`/uiautomator use — the same
      // space every other tap in this codebase (built from uiautomator
      // bounds) already targets successfully. Independent per-axis scaling
      // from the video's pixel space into that space is correct regardless
      // of whether the two aspect ratios match, as long as the video frame
      // itself isn't letterboxed (screenrecord doesn't add letterbox bars).
      const rect = videoContentRect(videoW, videoH, realW, realH);
      const rx = Math.round(Math.min(realW - 1, Math.max(0, ((x - rect.x) / rect.w) * realW)));
      const ry = Math.round(Math.min(realH - 1, Math.max(0, ((y - rect.y) / rect.h) * realH)));
      logger.info({ serial, from: [x, y], to: [rx, ry], video: [videoW, videoH], real: [realW, realH], contentRect: rect }, "[mobile-tap] rescaled tap for downscaled/letterboxed video");
      return { x: rx, y: ry, rescaled: true, video: [videoW, videoH], device, from: [x, y], to: [rx, ry] };
    } catch { return noOp; }
  }

  app.post("/api/mobile/devices/:serial/input/tap", async (req: Request, res: Response) => {
    try {
      const input = tapSchema.parse(req.body);
      const serial = p(req, "serial");
      const result = rescaleForDevice(serial, input.x, input.y, input.videoW, input.videoH);
      await android.tap(serial, result.x, result.y);
      res.json({ ok: true, rescaled: result.rescaled, video: result.video, device: result.device, from: result.from, to: result.to });
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
      const result = rescaleForDevice(serial, input.x, input.y, input.videoW, input.videoH);
      await android.doubleTap(serial, result.x, result.y);
      res.json({ ok: true, rescaled: result.rescaled, video: result.video, device: result.device, from: result.from, to: result.to });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // Debug-only: dump the current accessibility tree (resource-ids,
  // content-desc, bounds) for whatever screen is showing. Used to find the
  // *real* selectors for elements (e.g. story tray bubbles) instead of
  // guessing tap coordinates from screen percentages, which has repeatedly
  // landed on the wrong element.
  app.get("/api/mobile/devices/:serial/ui-dump", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const xml = await android.dumpUi(serial);
      res.type("text/plain").send(xml || "(empty dump)");
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // General-purpose screen layout scanner.  Reads the full accessibility
  // tree for whatever is on screen right now, groups every element with a
  // real (non-zero) bounding box into three vertical zones, and returns
  // human-readable lines including pixel coordinates AND screen-percentage
  // equivalents.  Paste the log output to the developer when implementing
  // any new gesture/tap feature — avoids coordinate-guessing entirely.
  //
  // Crucially: includes elements with NO text/desc/id (Instagram's story
  // bubbles, for example, are completely anonymous in the accessibility
  // tree) — we still report their bounds so the developer can see where
  // they sit on screen.
  app.get("/api/mobile/devices/:serial/screen-layout-scan", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const xml = await android.dumpUi(serial);
      if (!xml || xml.length < 200) {
        res.json({ ok: false, lines: ["(empty dump — is the phone awake and unlocked?)"] });
        return;
      }

      const rootM = xml.match(/bounds="\[0,0\]\[(\d+),(\d+)\]"/);
      const W = rootM ? parseInt(rootM[1]) : 0;
      const H = rootM ? parseInt(rootM[2]) : 0;
      if (!W || !H) {
        res.json({ ok: false, lines: ["Could not read screen size from dump — try again."] });
        return;
      }

      const pct = (v: number, dim: number) => `${((v / dim) * 100).toFixed(1)}%`;

      interface Elem {
        x1: number; y1: number; x2: number; y2: number;
        cx: number; cy: number;
        cls: string; rid: string; cd: string; txt: string; clickable: boolean;
      }
      const elems: Elem[] = [];

      const nodeRe = /<node\s([^/\n>]+)\s*\/>/g;
      let m: RegExpExecArray | null;
      while ((m = nodeRe.exec(xml)) !== null) {
        const attrs = m[1];
        const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!bm) continue;
        const [x1, y1, x2, y2] = [bm[1], bm[2], bm[3], bm[4]].map(Number);
        // Skip zero-size nodes (invisible / layout containers only)
        if (x2 - x1 < 4 || y2 - y1 < 4) continue;
        const get = (attr: string) => { const a = attrs.match(new RegExp(`${attr}="([^"]*)"`)); return a ? a[1] : ""; };
        elems.push({
          x1, y1, x2, y2,
          cx: Math.floor((x1 + x2) / 2),
          cy: Math.floor((y1 + y2) / 2),
          cls:       get("class").replace(/^.*\./, ""),
          rid:       get("resource-id").replace(/^[^/]+\//, ""),
          cd:        get("content-desc"),
          txt:       get("text"),
          clickable: get("clickable") === "true",
        });
      }

      // Sort by vertical position then horizontal
      elems.sort((a, b) => a.cy - b.cy || a.cx - b.cx);

      const lines: string[] = [];
      lines.push(`══ SCREEN LAYOUT SCAN ══  ${W}×${H} px  |  ${elems.length} elements`);
      lines.push(`   Send this to your developer before implementing any tap/swipe.`);

      const zones = [
        { label: "TOP    (0 – 33%)",    min: 0,          max: Math.round(H * 0.33) },
        { label: "MIDDLE (33 – 67%)",   min: Math.round(H * 0.33), max: Math.round(H * 0.67) },
        { label: "BOTTOM (67 – 100%)",  min: Math.round(H * 0.67), max: H },
      ];

      for (const zone of zones) {
        const group = elems.filter(e => e.cy >= zone.min && e.cy < zone.max);
        lines.push("");
        lines.push(`── ${zone.label}  (${group.length} elements) ─────────────────────`);
        if (group.length === 0) { lines.push("   (none)"); continue; }
        for (const e of group) {
          const tag  = e.clickable ? "●" : "○"; // ● = tappable
          const label = [e.rid, e.cd, e.txt].filter(Boolean).join(" | ") || "(no label)";
          lines.push(`  ${tag} center=(${e.cx}, ${e.cy})  [${pct(e.cx,W)}, ${pct(e.cy,H)}]  ${e.cls}`);
          lines.push(`     bounds=[${e.x1},${e.y1}][${e.x2},${e.y2}]  ${label}`);
        }
      }

      lines.push("");
      lines.push(`● = clickable element  ○ = container/label`);
      res.json({ ok: true, lines, screenW: W, screenH: H });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // ── Element Inspector ─────────────────────────────────────────────────────
  // Like Chrome DevTools F12 — click a point on the phone mirror and get back
  // every accessibility node whose bounds contain that point, sorted from most
  // specific (smallest area, innermost element) to least (full-screen root).
  // The frontend uses this in "Inspect mode" so the user can hover/click any
  // element on-screen and immediately see its label, resource-id, and exact
  // pixel bounds without any guesswork.
  const inspectNodeSchema = z.object({ x: z.number(), y: z.number() });
  app.post("/api/mobile/devices/:serial/inspect-node", async (req: Request, res: Response) => {
    try {
      const { x, y } = inspectNodeSchema.parse(req.body);
      const serial = p(req, "serial");
      const xml = await android.dumpUi(serial);
      if (!xml || xml.length < 200) {
        res.json({ ok: false, nodes: [], error: "Empty dump — is the phone awake and unlocked?" });
        return;
      }
      const rootM = xml.match(/bounds="\[0,0\]\[(\d+),(\d+)\]"/);
      const W = rootM ? parseInt(rootM[1]) : 0;
      const H = rootM ? parseInt(rootM[2]) : 0;

      interface InspectNode {
        cls: string; resourceId: string; contentDesc: string; text: string;
        bounds: string; boundsRaw: [number,number,number,number];
        center: { x: number; y: number }; clickable: boolean; area: number;
      }
      const hits: InspectNode[] = [];
      // Match BOTH self-closing <node … /> AND opening <node …> tags (nodes with children).
      // UIAutomator XML uses opening tags for any container that has child nodes — e.g.
      // RecyclerView items, FrameLayouts, gallery tiles — so a self-closing-only regex
      // silently misses every container and returns "no elements" for clickable areas.
      const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
      let m: RegExpExecArray | null;
      while ((m = nodeRe.exec(xml)) !== null) {
        const attrs = m[1];
        const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!bm) continue;
        const [x1, y1, x2, y2] = [bm[1], bm[2], bm[3], bm[4]].map(Number);
        // Must contain the tapped point
        if (x < x1 || x > x2 || y < y1 || y > y2) continue;
        // Skip zero-size containers
        if (x2 - x1 < 2 || y2 - y1 < 2) continue;
        const get = (attr: string) => { const a = attrs.match(new RegExp(`${attr}="([^"]*)"`)); return a ? a[1] : ""; };
        hits.push({
          cls:         get("class").replace(/^.*\./, ""),
          resourceId:  get("resource-id").replace(/^[^/]+\//, ""),
          contentDesc: get("content-desc"),
          text:        get("text"),
          bounds:      `[${x1},${y1}][${x2},${y2}]`,
          boundsRaw:   [x1, y1, x2, y2],
          center:      { x: Math.round((x1+x2)/2), y: Math.round((y1+y2)/2) },
          clickable:   get("clickable") === "true",
          area:        (x2-x1) * (y2-y1),
        });
      }
      // Smallest area first = most specific (innermost) element at the top
      hits.sort((a, b) => a.area - b.area);
      res.json({ ok: true, nodes: hits, screenW: W, screenH: H, tappedAt: { x, y } });
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
                // Same content-sub-rect correction as /input/tap (see
                // videoContentRect above) — a naive full-buffer scale is
                // only accurate at the padded axis's center and drifts
                // toward the edges when the video buffer is letterboxed/
                // pillarboxed relative to the device's real aspect ratio.
                const rect = videoContentRect(input.videoW, input.videoH, realW, realH);
                const scale = (v: number, off: number, span: number, real: number) =>
                  Math.round(Math.min(real - 1, Math.max(0, ((v - off) / span) * real)));
                x1 = scale(x1, rect.x, rect.w, realW);
                y1 = scale(y1, rect.y, rect.h, realH);
                x2 = scale(x2, rect.x, rect.w, realW);
                y2 = scale(y2, rect.y, rect.h, realH);
                logger.info({ serial, video: [input.videoW, input.videoH], real: [realW, realH], contentRect: rect }, "[mobile-swipe] rescaled swipe for downscaled/letterboxed video");
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
