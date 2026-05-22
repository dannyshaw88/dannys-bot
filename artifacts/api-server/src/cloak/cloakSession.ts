import WebSocket from "ws";
import { execSync } from "child_process";
import type { Browser, Page } from "puppeteer";

const FRAME_W = 1280;
const FRAME_H = 820;

let _browser: Browser | null = null;
let _page: Page | null = null;
let _cdp: any = null;
const _clients = new Set<WebSocket.WebSocket>();
let _currentUrl = "";
let _isOpen = false;
let _lastError = "";

function broadcast(msg: object): void {
  const text = JSON.stringify(msg);
  for (const ws of _clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(text);
  }
}

function broadcastError(message: string): void {
  _lastError = message;
  broadcast({ type: "error", message });
}

export interface CloakProxy {
  host: string;
  port: number;
  username?: string;
  password?: string;
  protocol?: string;
}

function getSystemChromium(): string | null {
  try {
    const p = execSync("which chromium", { encoding: "utf8", timeout: 3000 }).trim();
    return p || null;
  } catch {
    return null;
  }
}

export async function openCloakSession(opts: {
  url?: string;
  proxy?: CloakProxy;
}): Promise<void> {
  _lastError = "";
  if (_browser) await closeCloakSession();

  const args: string[] = ["--no-sandbox", "--disable-setuid-sandbox"];
  if (opts.proxy) {
    const scheme = opts.proxy.protocol === "socks5" ? "socks5://" : "";
    args.push(`--proxy-server=${scheme}${opts.proxy.host}:${opts.proxy.port}`);
  }

  // Try CloakBrowser's stealth binary first
  let launchError: Error | null = null;
  try {
    const { launch } = await import("cloakbrowser/puppeteer") as any;
    _browser = await launch({ headless: true, args }) as Browser;
    console.log("[cloak] CloakBrowser stealth binary launched");
  } catch (err: any) {
    launchError = err;
    console.warn("[cloak] CloakBrowser binary failed, trying system chromium:", err?.message?.split("\n")[0]);
  }

  // Fallback: use the NixOS / system Chromium (dev environments)
  if (!_browser) {
    const sysChrome = getSystemChromium();
    if (!sysChrome) {
      broadcastError(`CloakBrowser launch failed: ${launchError?.message ?? "unknown error"}`);
      return;
    }
    try {
      const puppeteer = await import("puppeteer") as any;
      _browser = await puppeteer.default.launch({
        headless: true,
        executablePath: sysChrome,
        args,
      }) as Browser;
      console.log("[cloak] Fallback system chromium launched:", sysChrome);
    } catch (err2: any) {
      broadcastError(`CloakBrowser launch failed: ${launchError?.message?.split("\n")[0] ?? err2?.message ?? "unknown error"}`);
      return;
    }
  }

  try {
    const pages = await _browser.pages();
    _page = pages[0] ?? await _browser.newPage();

    if (opts.proxy?.username && opts.proxy?.password) {
      await _page.authenticate({ username: opts.proxy.username, password: opts.proxy.password });
    }

    await _page.setViewport({ width: FRAME_W, height: FRAME_H, deviceScaleFactor: 1 });

    _cdp = await (_page as any).createCDPSession();

    await _cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 65,
      maxWidth: FRAME_W,
      maxHeight: FRAME_H,
      everyNthFrame: 1,
    });

    _cdp.on("Page.screencastFrame", async (data: any) => {
      try { await _cdp.send("Page.screencastFrameAck", { sessionId: data.sessionId }); } catch {}
      const msg = JSON.stringify({
        type: "frame",
        data: data.data,
        width: data.metadata?.deviceWidth ?? FRAME_W,
        height: data.metadata?.deviceHeight ?? FRAME_H,
      });
      for (const ws of _clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    });

    _page.on("framenavigated", (frame: any) => {
      if (frame === (_page as any).mainFrame()) {
        _currentUrl = frame.url();
        broadcast({ type: "url", url: _currentUrl });
      }
    });

    _isOpen = true;
    broadcast({ type: "status", open: true, url: _currentUrl });

    const startUrl = opts.url || "https://www.instagram.com/accounts/emailsignup/";
    await _page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  } catch (err: any) {
    broadcastError(`Session setup failed: ${err?.message ?? "unknown error"}`);
    await closeCloakSession().catch(() => {});
  }
}

export async function closeCloakSession(): Promise<void> {
  _isOpen = false;
  if (_cdp) {
    try { await _cdp.send("Page.stopScreencast"); } catch {}
    _cdp = null;
  }
  if (_browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
  }
  _page = null;
  _currentUrl = "";
  broadcast({ type: "status", open: false, url: "" });
}

export function isCloakOpen(): boolean { return _isOpen; }
export function getCloakUrl(): string { return _currentUrl; }
export function getCloakLastError(): string { return _lastError; }

export function attachCloakWS(ws: WebSocket.WebSocket): void {
  _clients.add(ws);
  if (_lastError) {
    ws.send(JSON.stringify({ type: "error", message: _lastError }));
  } else {
    ws.send(JSON.stringify({ type: "status", open: _isOpen, url: _currentUrl }));
  }
  ws.on("close", () => _clients.delete(ws));
  ws.on("message", (raw) => {
    handleCloakInput(raw.toString()).catch(() => {});
  });
}

async function handleCloakInput(raw: string): Promise<void> {
  if (!_page) return;
  const msg = JSON.parse(raw);
  switch (msg.type) {
    case "mousemove":
      await _page.mouse.move(msg.x, msg.y);
      break;
    case "mousedown":
      await _page.mouse.move(msg.x, msg.y);
      await _page.mouse.down({ button: msg.button ?? "left" });
      break;
    case "mouseup":
      await _page.mouse.up({ button: msg.button ?? "left" });
      break;
    case "scroll":
      await (_page.mouse as any).wheel({ deltaX: msg.deltaX ?? 0, deltaY: msg.deltaY ?? 0 });
      break;
    case "keydown":
      await _page.keyboard.down(msg.key);
      break;
    case "keyup":
      await _page.keyboard.up(msg.key);
      break;
    case "type":
      await _page.keyboard.type(msg.text);
      break;
    case "navigate":
      await _page.goto(msg.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      break;
    case "back":
      await _page.goBack().catch(() => {});
      break;
    case "forward":
      await _page.goForward().catch(() => {});
      break;
    case "reload":
      await _page.reload().catch(() => {});
      break;
  }
}
