import WebSocket from "ws";
import path from "path";
import fs from "fs";
import os from "os";

// ── puppeteer-extra + stealth plugin ─────────────────────────────────────────
// Resolves the executable path the same way the regular EB does.
function resolveChromiumPath(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return "chromium";
}

const BROWSER_W = 1280;
const BROWSER_H = 760;

function log(msg: string) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] [antidetect] ${msg}`);
}

// ── Session state ─────────────────────────────────────────────────────────────
interface ADBSession {
  browser: import("puppeteer").Browser;
  page: import("puppeteer").Page;
  cdp: import("puppeteer").CDPSession;
  ws: WebSocket | null;
  proxyLabel: string;
  startedAt: number;
  userDataDir: string;
}

let _session: ADBSession | null = null;

// ── Launch ────────────────────────────────────────────────────────────────────
export async function launchAntidetect(opts: {
  proxyHost: string;
  proxyPort: number;
  proxyUsername?: string | null;
  proxyPassword?: string | null;
  startUrl?: string;
}): Promise<void> {
  if (_session) await closeAntidetect();

  const puppeteerExtra = (await import("puppeteer-extra")).default;
  const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
  puppeteerExtra.use(StealthPlugin());

  const executablePath = resolveChromiumPath();
  const userDataDir = path.join(
    os.tmpdir(),
    `adb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(userDataDir, { recursive: true });

  log(`Launching antidetect browser via proxy ${opts.proxyHost}:${opts.proxyPort}`);

  const browser = await puppeteerExtra.launch({
    executablePath,
    headless: true,
    userDataDir,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--mute-audio",
      "--hide-scrollbars",
      `--window-size=${BROWSER_W},${BROWSER_H}`,
      "--disable-gpu",
      `--proxy-server=${opts.proxyHost}:${opts.proxyPort}`,
      // ── WebRTC IP-leak prevention ──────────────────────────────────────────
      // Without these flags Chrome's WebRTC stack sends UDP STUN requests
      // directly (bypassing the HTTP proxy) and exposes the real host IP —
      // including the full IPv6 address — in ICE candidates.
      // "--force-webrtc-ip-handling-policy=VALUE" is the correct single-flag
      // form; splitting it into a bare "--force-webrtc-ip-handling-policy"
      // (boolean) + a separate "--webrtc-ip-handling-policy=VALUE" does NOT
      // work and leaves WebRTC unrestricted.
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--enforce-webrtc-ip-permission-check",
      // Prevent DNS prefetch from resolving hostnames outside the proxy tunnel.
      "--dns-prefetch-disable",
      "--disable-blink-features=AutomationControlled",
    ],
    defaultViewport: { width: BROWSER_W, height: BROWSER_H },
  }) as unknown as import("puppeteer").Browser;

  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());

  if (opts.proxyUsername && opts.proxyPassword) {
    await page.authenticate({ username: opts.proxyUsername, password: opts.proxyPassword });
  }

  const cdp = await page.createCDPSession();

  // Track URL changes
  page.on("framenavigated", async (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = page.url();
    log(`navigated → ${url.slice(0, 80)}`);
    _broadcastJson({ type: "tabsUpdated", tabs: [{ url }], activeTab: 0 });
  });

  _session = {
    browser,
    page,
    cdp,
    ws: null,
    proxyLabel: `${opts.proxyHost}:${opts.proxyPort}`,
    startedAt: Date.now(),
    userDataDir,
  };

  // Single persistent screencast listener — registered once at launch, never duplicated
  cdp.on("Page.screencastFrame", async (evt: { data: string; sessionId: number }) => {
    const currentWs = _session?.ws;
    if (!currentWs || currentWs.readyState !== WebSocket.OPEN) {
      // Still need to ack so CDP doesn't stall
      try { await cdp.send("Page.screencastFrameAck", { sessionId: evt.sessionId }); } catch {}
      return;
    }
    try {
      currentWs.send(Buffer.from(evt.data, "base64"), { binary: true });
      await cdp.send("Page.screencastFrameAck", { sessionId: evt.sessionId });
    } catch {}
  });

  // Navigate to start URL
  const url = opts.startUrl || "https://pixelscan.net";
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch {
    // non-fatal — page may still be partially loaded
  }

  log("Session ready");
}

// ── Close ─────────────────────────────────────────────────────────────────────
export async function closeAntidetect(): Promise<void> {
  if (!_session) return;
  const s = _session;
  _session = null;
  log("Closing session");
  if (s.ws && s.ws.readyState === WebSocket.OPEN) {
    try { s.ws.close(); } catch {}
  }
  try { await s.cdp.send("Page.stopScreencast"); } catch {}
  try { await s.browser.close(); } catch {}
  try { fs.rmSync(s.userDataDir, { recursive: true, force: true }); } catch {}
}

// ── Status ────────────────────────────────────────────────────────────────────
export function getAntidetectStatus(): {
  running: boolean;
  proxyLabel?: string;
  startedAt?: number;
  url?: string;
} {
  if (!_session) return { running: false };
  const url = _session.page.url();
  return {
    running: true,
    proxyLabel: _session.proxyLabel,
    startedAt: _session.startedAt,
    url,
  };
}

// ── Input handler ─────────────────────────────────────────────────────────────
export async function antidetectInput(msg: {
  type: string;
  [k: string]: unknown;
}): Promise<void> {
  if (!_session) throw new Error("No antidetect session");
  const { page } = _session;
  // Keys that need press() (auto-fires keydown + keyup in the correct order)
  const PRESS_KEYS = new Set([
    "Enter", "Backspace", "Delete", "Tab", "Escape",
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
    "Home", "End", "PageUp", "PageDown",
    "F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12",
  ]);

  switch (msg.type) {
    case "navigate":
      await page.goto(String(msg.url), { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      break;

    case "click": {
      const cx = Number(msg.x);
      const cy = Number(msg.y);
      await page.mouse.click(cx, cy, { button: "left" });
      // Also explicitly focus the element at this position — React forms on Instagram
      // need a real focus() call, not just a mouse event, to accept keyboard input.
      await page.evaluate((x: number, y: number) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        if (el && typeof el.focus === "function") el.focus();
      }, cx, cy).catch(() => {});
      break;
    }

    case "mousemove":
      await page.mouse.move(Number(msg.x), Number(msg.y));
      break;

    case "scroll":
      await page.mouse.wheel({ deltaX: Number(msg.deltaX) || 0, deltaY: Number(msg.deltaY) || 0 });
      break;

    case "type": {
      // Use CDP Input.insertText — identical to clipboard paste on Android.
      // keyboard.type() with delay:0 is an instant-delivery bot tell that
      // Instagram's input-timing classifier catches immediately.
      // insertText delivers the full string as a single native text insertion
      // event, matching how mobile autocomplete / paste works on a real phone.
      const txt = String(msg.text);
      const { cdp } = _session;
      try {
        await cdp.send("Input.insertText", { text: txt });
      } catch {
        // cdp insertText not available (older Chromium) — fall back to keyboard
        await page.keyboard.type(txt, { delay: 30 + Math.random() * 40 });
      }
      break;
    }

    case "keydown": {
      const key = String(msg.key) as any;
      if (PRESS_KEYS.has(key)) {
        // press() handles the full keydown+keyup cycle and waits for it
        await page.keyboard.press(key);
      } else {
        // Modifier keys (Shift, Control, Alt, Meta) — held until keyup
        await page.keyboard.down(key);
      }
      break;
    }

    case "keyup": {
      const key = String(msg.key) as any;
      if (!PRESS_KEYS.has(key)) {
        await page.keyboard.up(key);
      }
      // PRESS_KEYS already fired keyup inside press(), so skip
      break;
    }

    case "back":
      await page.goBack({ timeout: 10000 }).catch(() => {});
      break;
    case "forward":
      await page.goForward({ timeout: 10000 }).catch(() => {});
      break;
    case "reload":
      await page.reload({ timeout: 15000 }).catch(() => {});
      break;
  }
}

// ── WebSocket attach / detach ─────────────────────────────────────────────────
export async function attachAntidetectWS(ws: WebSocket): Promise<void> {
  if (!_session) {
    try { ws.send(JSON.stringify({ type: "error", message: "No antidetect session running. Launch a browser first." })); } catch {}
    try { ws.close(); } catch {}
    return;
  }

  // Swap in new WS — the persistent listener reads _session.ws each frame so this is instant
  _session.ws = ws;

  const { cdp, page } = _session;

  // Start (or restart) the screencast for this WS connection
  try { await cdp.send("Page.stopScreencast"); } catch {}
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 65,
    maxWidth: BROWSER_W,
    maxHeight: BROWSER_H,
    everyNthFrame: 1,
  });

  // Receive input events from the client over this same WS (ordered, no HTTP race)
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      log(`input received: type=${msg.type}`);
      antidetectInput(msg).catch((err) => {
        log(`input error: ${err?.message ?? err}`);
      });
    } catch (e) {
      log(`input parse error: ${e}`);
    }
  });

  ws.send(JSON.stringify({ type: "screencast_started" }));

  const url = page.url();
  ws.send(JSON.stringify({ type: "tabsUpdated", tabs: [{ url }], activeTab: 0 }));

  log("WS client attached, screencasting");
}

export async function detachAntidetectWS(ws: WebSocket): Promise<void> {
  if (!_session || _session.ws !== ws) return;
  _session.ws = null;
  // Don't stop the screencast here — just clear the WS pointer.
  // The persistent listener will ack frames without sending them.
  // This avoids a stop/start cycle on every reconnect.
  log("WS client detached");
}

// ── Internal helpers ──────────────────────────────────────────────────────────
function _broadcastJson(obj: object): void {
  if (!_session?.ws || _session.ws.readyState !== WebSocket.OPEN) return;
  try { _session.ws.send(JSON.stringify(obj)); } catch {}
}
