import type { Express } from "express";
import {
  listConnectedDevices,
  takeScreenshot,
  wdaIsConnected,
  wdaTap,
  wdaDoubleTap,
  wdaLongPress,
  wdaSwipe,
  wdaTypeText,
  wdaPressButton,
  wdaLaunchApp,
  wdaActivateApp,
  runIphoneSignup,
  startIproxy,
  stopIproxy,
  getIproxyStatus,
  installWdaOnDevice,
  onWdaInstallStatus,
  offWdaInstallStatus,
  type IphoneSignupParams,
} from "../instagram/iphoneMirror";

// Per-request signup status for polling
const signupStatus: Map<string, { msg: string; done: boolean }> = new Map();

// Per-request WDA install status for polling
const wdaInstallStatus: Map<string, { step: string; progress?: number; message: string; done: boolean }> = new Map();

export function registerMirrorRoutes(app: Express): void {

  // ── Device detection ──────────────────────────────────────────────────────

  app.get("/api/mirror/devices", async (_req, res) => {
    try {
      const devices = await listConnectedDevices();
      res.json({ ok: true, devices });
    } catch (err) {
      res.json({ ok: false, devices: [], error: String(err) });
    }
  });

  // ── iproxy management (auto-started by Equinox — no CMD needed) ───────────

  app.post("/api/mirror/iproxy/start", async (req, res) => {
    try {
      const { udid, localPort, devicePort } = req.body ?? {};
      if (!udid) return res.status(400).json({ ok: false, error: "udid required" });
      const result = await startIproxy(udid, localPort ?? 8100, devicePort ?? 8100);
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post("/api/mirror/iproxy/stop", (_req, res) => {
    stopIproxy();
    res.json({ ok: true });
  });

  app.get("/api/mirror/iproxy/status", (_req, res) => {
    res.json({ ok: true, ...getIproxyStatus() });
  });

  // ── WDA install (downloads + installs — no Sideloadly, no CMD) ───────────

  app.post("/api/mirror/wda/install", async (req, res) => {
    try {
      const { udid } = req.body ?? {};
      if (!udid) return res.status(400).json({ ok: false, error: "udid required" });

      const sessionId = `wdainstall_${Date.now()}`;
      wdaInstallStatus.set(sessionId, { step: "downloading", progress: 0, message: "Starting…", done: false });

      res.json({ ok: true, sessionId });

      onWdaInstallStatus(sessionId, (s) => {
        wdaInstallStatus.set(sessionId, {
          step: s.step,
          progress: s.progress,
          message: s.message,
          done: s.step === "done" || s.step === "error",
        });
      });

      installWdaOnDevice(udid, sessionId).then(() => {
        offWdaInstallStatus(sessionId);
      }).catch((err) => {
        wdaInstallStatus.set(sessionId, { step: "error", message: `⚠ ${String(err)}`, done: true });
        offWdaInstallStatus(sessionId);
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.get("/api/mirror/wda/install-status", (req, res) => {
    const sid = String(req.query.sessionId ?? "");
    const entry = wdaInstallStatus.get(sid);
    if (!entry) return res.status(404).json({ ok: false, error: "Unknown session" });
    res.json({ ok: true, ...entry });
  });

  // ── Screenshot ────────────────────────────────────────────────────────────

  app.post("/api/mirror/screenshot", async (req, res) => {
    try {
      const { udid } = req.body ?? {};
      const jpeg = await takeScreenshot(udid);
      if (!jpeg) {
        return res.status(503).json({
          ok: false,
          error: "Screenshot failed — make sure your iPhone is unlocked",
        });
      }
      res.json({ ok: true, jpeg });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ── WDA status ────────────────────────────────────────────────────────────

  app.get("/api/mirror/wda-status", async (_req, res) => {
    try {
      const connected = await wdaIsConnected();
      const iproxy = getIproxyStatus();
      res.json({ ok: true, connected, iproxy });
    } catch {
      res.json({ ok: true, connected: false, iproxy: getIproxyStatus() });
    }
  });

  // ── Touch controls ────────────────────────────────────────────────────────

  app.post("/api/mirror/tap", async (req, res) => {
    try {
      const { x, y } = req.body ?? {};
      if (typeof x !== "number" || typeof y !== "number") {
        return res.status(400).json({ ok: false, error: "x and y required" });
      }
      await wdaTap(x, y);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post("/api/mirror/double-tap", async (req, res) => {
    try {
      const { x, y } = req.body ?? {};
      await wdaDoubleTap(x, y);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post("/api/mirror/long-press", async (req, res) => {
    try {
      const { x, y, duration } = req.body ?? {};
      await wdaLongPress(x, y, duration);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post("/api/mirror/swipe", async (req, res) => {
    try {
      const { fromX, fromY, toX, toY, duration } = req.body ?? {};
      await wdaSwipe(fromX, fromY, toX, toY, duration);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post("/api/mirror/type", async (req, res) => {
    try {
      const { text } = req.body ?? {};
      if (typeof text !== "string" || !text) {
        return res.status(400).json({ ok: false, error: "text required" });
      }
      await wdaTypeText(text);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post("/api/mirror/press-button", async (req, res) => {
    try {
      const { name } = req.body ?? {};
      const allowed = ["home", "volumeUp", "volumeDown", "power"] as const;
      if (!allowed.includes(name)) {
        return res.status(400).json({ ok: false, error: "name must be home|volumeUp|volumeDown|power" });
      }
      await wdaPressButton(name);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ── App management ────────────────────────────────────────────────────────

  app.post("/api/mirror/open-app", async (req, res) => {
    try {
      const { bundleId } = req.body ?? {};
      if (!bundleId) return res.status(400).json({ ok: false, error: "bundleId required" });
      await wdaLaunchApp(bundleId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post("/api/mirror/activate-app", async (req, res) => {
    try {
      const { bundleId } = req.body ?? {};
      if (!bundleId) return res.status(400).json({ ok: false, error: "bundleId required" });
      await wdaActivateApp(bundleId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ── iPhone Instagram signup automation ────────────────────────────────────

  app.post("/api/mirror/signup", async (req, res) => {
    try {
      const { email, password, username, dob, sessionId } = req.body ?? {};
      if (!email || !password || !username || !dob) {
        return res.status(400).json({ ok: false, error: "email, password, username, dob required" });
      }
      const sid = (sessionId as string) ?? `signup_${Date.now()}`;
      signupStatus.set(sid, { msg: "Starting…", done: false });
      res.json({ ok: true, sessionId: sid });

      const params: IphoneSignupParams = {
        email, password, username, dob,
        onStatus: (msg: string) => signupStatus.set(sid, { msg, done: false }),
      };
      runIphoneSignup(params).then(result => {
        signupStatus.set(sid, {
          msg: result.ok ? "✅ Signup complete!" : `⚠ ${result.error}`,
          done: true,
        });
      }).catch(err => {
        signupStatus.set(sid, { msg: `⚠ ${String(err)}`, done: true });
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.get("/api/mirror/signup-status", (req, res) => {
    const sid = String(req.query.sessionId ?? "");
    const entry = signupStatus.get(sid);
    if (!entry) return res.status(404).json({ ok: false, error: "Unknown session" });
    res.json({ ok: true, msg: entry.msg, done: entry.done });
  });

  app.post("/api/mirror/signup-code", async (req, res) => {
    try {
      const { sessionId, code } = req.body ?? {};
      if (!code) return res.status(400).json({ ok: false, error: "code required" });
      const status = signupStatus.get(sessionId) ?? { msg: "Submitting code…", done: false };
      signupStatus.set(sessionId, { ...status, msg: `Submitting code ${code}…` });
      await wdaTap(195, 400);
      await wdaTypeText(code);
      await wdaTap(195, 480);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
}
