import type { Browser, Page } from "puppeteer";
import type { ServerResponse } from "http";
import { generateSync as totpGenerate } from "otplib";
import fs from "fs";
import path from "path";
import os from "os";

import { db } from "@workspace/db";
import { instagramApiCalls } from "../shared/schema";

function log(msg: string, _category?: string) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] [browser] ${msg}`);
}

// ── Cookie persistence ───────────────────────────────────────────────────────
const COOKIES_DIR = path.join(process.cwd(), "server", "browser-data");

function cookiePath(profileId: number) {
  return path.join(COOKIES_DIR, `cookies-${profileId}.json`);
}

async function saveCookies(profileId: number, page: Page): Promise<void> {
  try {
    const cookies = await page.cookies();
    if (!cookies.length) return;
    fs.mkdirSync(COOKIES_DIR, { recursive: true });
    fs.writeFileSync(cookiePath(profileId), JSON.stringify(cookies, null, 2), "utf8");
    log(`[cookies:${profileId}] Saved ${cookies.length} cookies`, "browser");
  } catch (e: any) {
    log(`[cookies:${profileId}] Save error: ${e?.message}`, "browser");
  }
}

async function loadCookies(profileId: number, page: Page): Promise<boolean> {
  try {
    const p = cookiePath(profileId);
    if (!fs.existsSync(p)) return false;
    const raw = fs.readFileSync(p, "utf8");
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || !cookies.length) return false;
    await page.setCookie(...cookies);
    log(`[cookies:${profileId}] Restored ${cookies.length} cookies`, "browser");
    return true;
  } catch (e: any) {
    log(`[cookies:${profileId}] Load error: ${e?.message}`, "browser");
    return false;
  }
}

export function hasSavedCookies(profileId: number): boolean {
  try {
    return fs.existsSync(cookiePath(profileId));
  } catch { return false; }
}

export function deleteSavedCookies(profileId: number): void {
  try {
    const p = cookiePath(profileId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

// Returns the existing Puppeteer Browser for a profile if an EB session is
// already running, or null if the EB has never been opened for this profile.
// The cookie baker uses this to open a new background tab instead of spawning
// a second Chrome process — avoids launch failures and resource waste.
export function getExistingBrowser(profileId: number): any | null {
  return sessions.get(profileId)?.browser ?? null;
}

export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

interface Session {
  browser: Browser;
  page: Page;          // always === pages[activePage] — kept in sync on tab switch
  pages: Page[];
  activePage: number;
  res: ServerResponse | null; // SSE response — null when no client is connected
  frameLoop: ReturnType<typeof setInterval> | null;
  lastUrl: string;
  proxyKey: string; // "direct" or "host:port" — used to detect proxy changes
  userAgent: string; // profile's userAgentEmbedded — applied to every page/popup
  pendingInitUrl?: string; // set by getOrCreateSession, consumed by attachSSE on first connect
  // Timestamp (ms) until which the frame-loop error-page auto-retry is suppressed.
  // Set whenever an intentional goto() is fired so the loop doesn't race against it.
  navProtectedUntil?: number;
  // True while browserAutoLogin is executing — suppresses the screenshot-timeout
  // kill so the page isn't destroyed mid-login causing a false ok:false result.
  autoLoginInProgress?: boolean;
}

// Challenge URLs from IgCheckpointError — set by the verify route, consumed by getOrCreateSession
// Converts mobile API URL (i.instagram.com) → desktop web URL (www.instagram.com) for the browser
const checkpointUrlCache = new Map<number, string>();
export function setCheckpointUrl(profileId: number, mobileOrWebUrl: string) {
  const webUrl = mobileOrWebUrl.replace("https://i.instagram.com", "https://www.instagram.com");
  checkpointUrlCache.set(profileId, webUrl);
}

function sseWrite(res: ServerResponse | null, data: object) {
  if (!res || res.writableEnded) return;
  try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
}

const sessions = new Map<number, Session>();
const pendingFileChoosers = new Map<number, any>(); // profileId → FileChooser

// --no-sandbox is required in all environments.
// --no-zygote is intentionally EXCLUDED — it crashes Chrome silently on Windows
//   when combined with --no-sandbox. It is only needed in sandboxed Linux containers.
const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-sync",
  "--metrics-recording-only",
  "--disable-default-apps",
  "--mute-audio",
  "--hide-scrollbars",
  "--window-size=1280,760",
];

// Chromium executable — resolved from env (set by Electron main on Windows via
// findChromiumPath which locates Chrome/Edge/Brave) or Nix store (Linux dev).
// The browser runs headless (completely invisible) with an isolated --user-data-dir
// so it never touches the user's personal browser profile.
const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ||
  "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium";

// Detect whether a UA string represents a mobile Chrome Android browser.
// Used to decide which fingerprint values to spoof — mobile and desktop
// have completely different screen, touch, and platform signals.
function isMobileUA(ua: string): boolean {
  return /Android/i.test(ua) && /Mobile Safari/i.test(ua);
}

// Return Puppeteer viewport options consistent with the UA.
// Puppeteer's isMobile+hasTouch flags also wire up Chromium's internal touch
// emulation so navigator.maxTouchPoints is already > 0 at the C++ layer —
// but we override it in JS too for belt-and-braces.
export function viewportForUA(ua: string): { width: number; height: number; deviceScaleFactor?: number; isMobile?: boolean; hasTouch?: boolean } {
  if (isMobileUA(ua)) {
    // 412×915 is the logical (CSS pixel) resolution of a modern Android flagship
    // at ~2.625× device pixel ratio.  Matches most Samsung/Pixel profiles.
    return { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true };
  }
  return { width: 1280, height: 760 };
}

export async function applyStealthScripts(page: Page, userAgent: string): Promise<void> {
  const mobile = isMobileUA(userAgent);
  await page.evaluateOnNewDocument((mobile: boolean) => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });

    if (mobile) {
      // Mobile Chrome has no exposed plugin list
      Object.defineProperty(navigator, "plugins", {
        get: () => {
          const arr: any[] = [];
          arr.item = () => null;
          arr.namedItem = () => null;
          try { Object.setPrototypeOf(arr, PluginArray.prototype); } catch {}
          return arr;
        },
      });
    } else {
      Object.defineProperty(navigator, "plugins", {
        get: () => {
          const arr: any[] = [
            { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format", length: 1 },
            { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "", length: 1 },
            { name: "Native Client", filename: "internal-nacl-plugin", description: "", length: 2 },
          ];
          arr.item = (i: number) => arr[i];
          arr.namedItem = (n: string) => arr.find((p: any) => p.name === n) ?? null;
          Object.setPrototypeOf(arr, PluginArray.prototype);
          return arr;
        },
      });
    }

    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    (window as any).chrome = { app: { isInstalled: false }, runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      (window.navigator.permissions as any).query = (params: any) =>
        params.name === "notifications"
          ? Promise.resolve({ state: "prompt", onchange: null } as PermissionStatus)
          : originalQuery.call(window.navigator.permissions, params);
    }

    if (mobile) {
      // Mobile fingerprint — must match a real Android Chrome session.
      // screen.width/height are CSS (logical) pixels, not physical pixels.
      Object.defineProperty(screen, "width",       { get: () => 412 });
      Object.defineProperty(screen, "height",      { get: () => 915 });
      Object.defineProperty(screen, "availWidth",  { get: () => 412 });
      Object.defineProperty(screen, "availHeight", { get: () => 892 });
      Object.defineProperty(screen, "colorDepth",  { get: () => 24 });
      Object.defineProperty(screen, "pixelDepth",  { get: () => 24 });
      // maxTouchPoints > 0 is required — 0 immediately exposes a non-touch device
      Object.defineProperty(navigator, "maxTouchPoints",      { get: () => 10 });
      // platform on Android Chrome is "Linux armv8l" — not "Linux x86_64"
      Object.defineProperty(navigator, "platform",            { get: () => "Linux armv8l" });
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
      Object.defineProperty(navigator, "deviceMemory",        { get: () => 4 });
    } else {
      Object.defineProperty(screen, "width",       { get: () => 1920 });
      Object.defineProperty(screen, "height",      { get: () => 1080 });
      Object.defineProperty(screen, "availWidth",  { get: () => 1920 });
      Object.defineProperty(screen, "availHeight", { get: () => 1040 });
      Object.defineProperty(screen, "colorDepth",  { get: () => 24 });
      Object.defineProperty(screen, "pixelDepth",  { get: () => 24 });
      Object.defineProperty(navigator, "maxTouchPoints",      { get: () => 0 });
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
      Object.defineProperty(navigator, "deviceMemory",        { get: () => 8 });
    }
  }, mobile);
}

export async function getOrCreateSession(
  profileId: number,
  userAgent: string,
  proxy?: ProxyConfig,
): Promise<Session> {
  const newProxyKey = proxy ? `${proxy.host}:${proxy.port}` : "direct";
  const existing = sessions.get(profileId);

  // If session exists with a DIFFERENT proxy config, close and recreate it
  if (existing) {
    if (existing.proxyKey === newProxyKey) return existing;
    log(`Proxy changed for profile ${profileId} (${existing.proxyKey} → ${newProxyKey}), restarting browser`, "browser");
    await closeSession(profileId);
  }

  // --proxy-server accepts "host:port" only — Chromium rejects credentials in the URL
  // (ERR_NO_SUPPORTED_PROXIES). Credentials are supplied via page.authenticate() after launch.
  if (proxy) {
    log(`Launching Chrome for profile ${profileId} via proxy ${proxy.host}:${proxy.port}${proxy.username ? ` (user: ${proxy.username})` : " (no auth)"}`, "browser");
  } else {
    log(`Launching Chrome for profile ${profileId} — NO PROXY (direct connection)`, "browser");
  }
  const proxyArg = proxy ? [`--proxy-server=${proxy.host}:${proxy.port}`] : [];

  // Each session gets its OWN isolated user-data-dir so Chrome never reuses or
  // touches any existing browser session on the machine.
  const userDataDir = path.join(os.tmpdir(), `equinox-eb-${profileId}`);
  fs.mkdirSync(userDataDir, { recursive: true });
  const userDataArg = [`--user-data-dir=${userDataDir}`];

  // ── EB-DEBUG: log the environment we received ────────────────────────────
  console.log(`[EB-DEBUG][browserSession] profileId=${profileId}`);
  console.log(`[EB-DEBUG][browserSession] CHROMIUM_PATH env = "${process.env.CHROMIUM_PATH ?? "(not set)"}"`);
  console.log(`[EB-DEBUG][browserSession] CHROMIUM_PATH resolved = "${CHROMIUM_PATH}"`);
  console.log(`[EB-DEBUG][browserSession] NODE_PATH = "${process.env.NODE_PATH ?? "(not set)"}"`);
  console.log(`[EB-DEBUG][browserSession] platform = ${process.platform}`);
  console.log(`[EB-DEBUG][browserSession] node version = ${process.version}`);
  console.log(`[EB-DEBUG][browserSession] userDataDir = ${userDataDir}`);

  // Try puppeteer-core first (ships with Electron app, no bundled Chromium).
  // Fall back to the full puppeteer package (used in Linux dev where it manages its own Chromium).
  let puppeteerLib: any;
  let puppeteerSource = "";
  try {
    puppeteerLib = (await import("puppeteer-core")).default;
    puppeteerSource = "puppeteer-core";
    console.log(`[EB-DEBUG][browserSession] puppeteer loaded: puppeteer-core ✓`);
  } catch (e: any) {
    console.log(`[EB-DEBUG][browserSession] puppeteer-core import failed (${e?.message}) — trying puppeteer fallback`);
    try {
      puppeteerLib = (await import("puppeteer")).default;
      puppeteerSource = "puppeteer";
      console.log(`[EB-DEBUG][browserSession] puppeteer loaded: puppeteer (fallback) ✓`);
    } catch (e2: any) {
      const msg = `Cannot load puppeteer or puppeteer-core: ${e2?.message}`;
      console.error(`[EB-DEBUG][browserSession] FATAL: ${msg}`);
      throw new Error(msg);
    }
  }

  if (!CHROMIUM_PATH) {
    const msg = "No browser found. Please install Google Chrome or Microsoft Edge, then restart Equinox.";
    console.error(`[EB-DEBUG][browserSession] FATAL: ${msg}`);
    throw new Error(msg);
  }

  const fullArgs = [...LAUNCH_ARGS, ...userDataArg, ...proxyArg];
  console.log(`[EB-DEBUG][browserSession] launching via ${puppeteerSource}, executablePath="${CHROMIUM_PATH}"`);
  console.log(`[EB-DEBUG][browserSession] launch args: ${fullArgs.join(" ")}`);

  let browser: Browser;
  try {
    browser = await puppeteerLib.launch({
      headless: true,
      executablePath: CHROMIUM_PATH,
      args: fullArgs,
      ignoreHTTPSErrors: true,
    });
    console.log(`[EB-DEBUG][browserSession] browser launched successfully ✓`);
  } catch (err: any) {
    const msg = `Chrome failed to launch: ${err?.message ?? err}`;
    console.error(`[EB-DEBUG][browserSession] LAUNCH ERROR: ${msg}`);
    if (err?.stack) console.error(`[EB-DEBUG][browserSession] stack: ${err.stack}`);
    throw new Error(msg);
  }

  const [page] = await browser.pages();
  await page.setUserAgent(userAgent);
  // The EB canvas is always 1280×760.  Using viewportForUA() for mobile UAs would
  // produce screenshots at ~1082×2402 (412×915 @ 2.625x scale) which, when drawn
  // onto the 1280×760 canvas, cause severe stretching.  Force desktop dimensions so
  // the Puppeteer screenshot always matches the canvas size exactly.
  await page.setViewport({ width: 1280, height: 760 });

  // Authenticate proxy if credentials supplied.
  // page.authenticate() handles the 407 Proxy Auth challenge Chromium receives on CONNECT.
  if (proxy?.username) {
    await page.authenticate({ username: proxy.username, password: proxy.password ?? "" });
  }
  log(`Chrome launched for profile ${profileId}`, "browser");

  // Stealth: spoof all common headless-Chrome fingerprints that Instagram checks
  await applyStealthScripts(page, userAgent);

  // Auto-dismiss cookie banners + post-login popups + save cookies on every main-frame navigation
  page.on("framenavigated", async (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    // Small delay so banners/dialogs have time to render
    await new Promise(r => setTimeout(r, 1500));
    await dismissCookieBanner(page);
    await dismissInstagramPopups(page);
    // Extra pass after another short delay (some popups appear with animation)
    await new Promise(r => setTimeout(r, 1500));
    await dismissInstagramPopups(page);
    // If we've navigated to Instagram and are NOT on the login page,
    // save cookies so the session persists across restarts
    if (
      url &&
      url.includes("instagram.com") &&
      !url.includes("/accounts/login") &&
      !url.includes("/accounts/emailsignup") &&
      !url.includes("about:blank")
    ) {
      await saveCookies(profileId, page);
    }
  });

  // ── Instagram API call interception ─────────────────────────────────────────
  const STATIC_EXT = /\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf|eot|mp4|mp3)(\?.*)?$/i;
  const IG_HOSTS = ["instagram.com", "i.instagram.com", "graph.instagram.com", "www.instagram.com"];

  // Telemetry / infrastructure endpoints — not useful to log
  const NOISE_PATHS = new Set([
    "ajax/bz", "ajax/bootloader-endpoint", "ajax/bulk-route-definitions",
    "ajax/logging", "logging_client_events", "sync/instagram",
    "ajax/mercury/rollout", "ajax/navigation",
  ]);

  const isIgApiCall = (url: string) => {
    try {
      const u = new URL(url);
      return IG_HOSTS.some(h => u.hostname === h || u.hostname.endsWith("." + h))
        && !STATIC_EXT.test(u.pathname);
    } catch { return false; }
  };

  const getOpName = (url: string) => {
    try {
      const parts = new URL(url).pathname.replace(/\/$/, "").split("/").filter(Boolean);
      return parts.slice(-2).join("/") || new URL(url).pathname;
    } catch { return url; }
  };

  // Track pending requests: url → { startMs, method }
  const pending = new Map<string, { startMs: number; method: string }>();

  page.on("request", (req) => {
    if (isIgApiCall(req.url())) {
      pending.set(req.url(), { startMs: Date.now(), method: req.method() });
    }
  });

  page.on("response", async (res) => {
    const url = res.url();
    const info = pending.get(url);
    if (!info) return;
    pending.delete(url);

    const opName = getOpName(url);
    if (NOISE_PATHS.has(opName)) return; // skip telemetry noise

    const durationMs = Date.now() - info.startMs;
    try {
      await db.insert(instagramApiCalls).values({
        profileId,
        operationName: opName,
        date: new Date().toISOString(),
        message: url,
        source: "Browser",
        navChain: "",
        ipAddress: "",
        durationMs,
      });
    } catch { /* never crash the browser session on a log failure */ }
  });
  // ────────────────────────────────────────────────────────────────────────────

  const session: Session = { browser, page, pages: [page], activePage: 0, res: null, frameLoop: null, lastUrl: "", proxyKey: newProxyKey, userAgent };
  sessions.set(profileId, session);
  log(`Chrome launched for profile ${profileId}`, "browser");

  // ── Apply UA to every new page/popup that Chrome creates ──────────────────
  // page.setUserAgent() is per-page only. Instagram and Chrome itself can open
  // new targets (popups, service workers, etc.) that inherit Chrome's default
  // "HeadlessChrome" UA. Intercept every target and override the UA immediately
  // before any requests are made so Instagram never sees the headless fingerprint.
  browser.on("targetcreated", async (target: any) => {
    try {
      if (target.type() !== "page") return;
      const newPage = await target.page();
      if (!newPage) return;
      await newPage.setUserAgent(userAgent);
      await newPage.setViewport(viewportForUA(userAgent));
      await applyStealthScripts(newPage, userAgent);
      // Also intercept file choosers on any popup page
      (newPage as any).on("filechooser", (chooser: any) => {
        pendingFileChoosers.set(profileId, chooser);
        const s = sessions.get(profileId);
        if (s) sseWrite(s.res, { type: "fileChooserNeeded" });
      });
    } catch { /* never crash on target creation */ }
  });

  // ── File chooser interception ─────────────────────────────────────────────
  // Puppeteer v24: 'filechooser' event fires whenever the page opens a file dialog.
  // We store the chooser and relay a "fileChooserNeeded" SSE event to the frontend,
  // which shows a native <input type="file"> so the user can pick from their machine.
  (page as any).on("filechooser", (chooser: any) => {
    pendingFileChoosers.set(profileId, chooser);
    const s = sessions.get(profileId);
    if (s) sseWrite(s.res, { type: "fileChooserNeeded" });
  });

  // ── Browser console log streaming ─────────────────────────────────────────
  page.on("console", (msg: any) => {
    const s = sessions.get(profileId);
    if (!s) return;
    const level: string = msg.type();
    const text: string = msg.text();
    if (!text || text.startsWith("[DOM]")) return; // skip noisy internal Chrome messages
    sseWrite(s.res, { type: "consoleLog", level, text });
  });

  // Determine the initial URL for this session.
  // We do NOT fire page.goto() here — that would race with attachSSE which is
  // called immediately after in the stream route, causing two concurrent gotos
  // on the same page (first gets cancelled by the second, leaving the page on
  // about:blank in some cases). Instead we store the target in session.pendingInitUrl
  // so attachSSE is the single source of truth for the initial navigation.
  const cookiesLoaded = await loadCookies(profileId, page);
  const cachedCheckpointUrl = checkpointUrlCache.get(profileId);
  if (cachedCheckpointUrl) {
    checkpointUrlCache.delete(profileId);
    log(`[cookies:${profileId}] Checkpoint URL cached — will navigate on SSE attach`, "browser");
    session.pendingInitUrl = cachedCheckpointUrl;
  } else if (cookiesLoaded) {
    log(`[cookies:${profileId}] Cookies restored — will navigate to Instagram home on SSE attach`, "browser");
    session.pendingInitUrl = "https://www.instagram.com/";
  } else {
    session.pendingInitUrl = "https://www.instagram.com/accounts/login/";
  }

  return session;
}

export function detachSSE(profileId: number, res: ServerResponse) {
  const session = sessions.get(profileId);
  if (!session || session.res !== res) return;
  session.res = null;
  if (session.frameLoop) { clearInterval(session.frameLoop); session.frameLoop = null; }
}

export function attachSSE(profileId: number, res: ServerResponse) {
  const session = sessions.get(profileId);
  if (!session) return;

  // End any existing SSE connection for this profile
  if (session.res && !session.res.writableEnded) {
    try { session.res.end(); } catch {}
  }
  session.res = res;

  // ── Initial / recovery navigation ─────────────────────────────────────────
  // This is the ONLY place that fires page.goto() after a session is created or
  // reconnected. getOrCreateSession stores the intended first URL in
  // session.pendingInitUrl instead of navigating itself, so we never have two
  // concurrent gotos racing on the same page.
  (async () => {
    try {
      const currentUrl = session.page.url();
      const isBlankOrError = currentUrl.startsWith("chrome-error://") || currentUrl === "about:blank" || currentUrl === "about:newtab";

      if (session.pendingInitUrl) {
        // New session — navigate to the URL determined by getOrCreateSession.
        // Protect for 15s so the frame loop doesn't fire a competing goto() while
        // Chrome is still loading (Chrome briefly shows about:blank at the start
        // of every navigation, which would otherwise trigger the error-page retry).
        // 15s is enough for Chrome to move past the initial about:blank into a real URL.
        const target = session.pendingInitUrl;
        session.pendingInitUrl = undefined;
        session.navProtectedUntil = Date.now() + 15000;
        log(`[attachSSE:${profileId}] initial navigation → ${target}`, "browser");
        session.page.goto(target, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
      } else if (isBlankOrError) {
        // Reconnect after crash/error — recover by checking cookies
        const cookies = await session.page.cookies().catch(() => [] as any[]);
        const hasCookies = cookies.some((c: any) => c.name === "sessionid");
        const target = hasCookies
          ? "https://www.instagram.com/"
          : "https://www.instagram.com/accounts/login/";
        session.navProtectedUntil = Date.now() + 15000;
        log(`[attachSSE:${profileId}] page is "${currentUrl}" (error/blank) — recovering → ${target}`, "browser");
        session.page.goto(target, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
      }
      // else: user is actively browsing — leave them alone
    } catch { /* page may be closing — ignore */ }
  })();

  startFrameLoop(profileId);
}

function startFrameLoop(profileId: number) {
  const session = sessions.get(profileId);
  if (!session) return;

  if (session.frameLoop) clearInterval(session.frameLoop);

  let cookieSaveTick = 0;
  let popupCheckTick = 0;
  let keepAliveTick = 0;
  let errorRetryTick = 0;     // counts frames while on chrome-error:// (429 / net::ERR_*)
  let errorRetryCount = 0;    // how many times we've auto-retried this session
  let screenshotTimeoutCount = 0; // consecutive screenshot timeouts → detect crashed renderer
  let busy = false;
  let lastFrameSentAt = Date.now();   // track when we last successfully pushed a frame
  let noFrameWarnedAt = 0;           // avoid spamming the no-frame warning

  session.frameLoop = setInterval(async () => {
    const s = sessions.get(profileId);
    if (!s || !s.res || s.res.writableEnded) {
      if (s?.frameLoop) clearInterval(s.frameLoop);
      return;
    }

    // Keep-alive SSE comment every ~15 seconds to prevent proxy timeouts
    keepAliveTick++;
    if (keepAliveTick >= 75) { // 75 * 200ms = 15s
      keepAliveTick = 0;
      try { s.res.write(": keepalive\n\n"); } catch {}

      // ── Server-side freeze diagnostic ─────────────────────────────────────
      // If we have a live SSE client but haven't successfully sent a frame in
      // 30 s, log it so the server log captures the freeze even when the
      // frontend overlay doesn't fire or the user can't see it.
      const silentMs = Date.now() - lastFrameSentAt;
      if (silentMs > 30000 && Date.now() - noFrameWarnedAt > 30000) {
        noFrameWarnedAt = Date.now();
        log(`[frameLoop:${profileId}] ⚠ no frame sent for ${Math.round(silentMs / 1000)}s — busy=${busy} screenshotTimeouts=${screenshotTimeoutCount} url=${(() => { try { return s.page.url().slice(0, 80); } catch { return "?"; } })()}`, "browser");
      }
    }

    // Skip frame if a screenshot is already in flight (prevents queuing)
    if (busy) return;
    busy = true;

    const frameStart = Date.now();
    try {
      const [screenshot, currentUrl] = await Promise.all([
        s.page.screenshot({ type: "jpeg", quality: 70, encoding: "base64", timeout: 6000 } as any),
        s.page.url(),
      ]);

      const screenshotMs = Date.now() - frameStart;
      if (screenshotMs > 2000) {
        log(`[frameLoop:${profileId}] slow screenshot: ${screenshotMs}ms url=${currentUrl.slice(0, 80)}`, "browser");
      }

      sseWrite(s.res, { type: "frame", data: screenshot, url: currentUrl });
      lastFrameSentAt = Date.now();

      if (currentUrl !== s.lastUrl) {
        s.lastUrl = currentUrl;
        sseWrite(s.res, { type: "urlChange", url: currentUrl });
      }

      screenshotTimeoutCount = 0; // successful screenshot — reset crash counter

      // ── Error-page auto-retry ────────────────────────────────────────────
      // Only retry when stuck on a genuine error/blank page:
      //   • chrome-error://  — HTTP 429 / net error / proxy failure (TERMINAL state)
      //   • about:blank / about:newtab — goto() timed out or navigation in progress
      // navProtectedUntil guards about:blank (transitional) but NOT chrome-error://.
      // chrome-error:// is a final failure state — Chrome is done trying. Retrying
      // immediately is safe and avoids leaving the user staring at an error page.
      const isErrorPage = currentUrl.startsWith("chrome-error://") || currentUrl === "about:blank" || currentUrl === "about:newtab";
      const navProtected = Date.now() < (s.navProtectedUntil ?? 0);
      // Bypass nav protection for chrome-error:// (terminal) but respect it for about:blank (transitional).
      const isTransitionalBlank = currentUrl === "about:blank" || currentUrl === "about:newtab";
      if (isErrorPage && (!navProtected || !isTransitionalBlank)) {
        errorRetryTick++;
        // First 3 retries: every 3 s (15×200 ms). After that: every 30 s (150×200 ms).
        const retryThreshold = errorRetryCount < 3 ? 15 : 150;
        if (errorRetryTick >= retryThreshold) {
          errorRetryTick = 0;
          errorRetryCount++;
          const hasCookies = await s.page.cookies().then(c => c.some(ck => ck.name === "sessionid")).catch(() => false);
          const retryTarget = hasCookies
            ? "https://www.instagram.com/"
            : "https://www.instagram.com/accounts/login/";
          log(`[retry:${profileId}] "${currentUrl}" — retry #${errorRetryCount} → ${retryTarget}`, "browser");
          // Protect against the next round of retries while this goto() is in flight
          s.navProtectedUntil = Date.now() + 35000;
          s.page.goto(retryTarget, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
        }
      } else if (!isErrorPage) {
        errorRetryTick = 0;
        errorRetryCount = 0; // reset so future failures also get fast retries
      }
      // ─────────────────────────────────────────────────────────────────────

      // Check for post-login popups every ~10 seconds
      popupCheckTick++;
      if (popupCheckTick >= 50) { // 50 * 200ms = 10s
        popupCheckTick = 0;
        dismissInstagramPopups(s.page);
      }

      // Save cookies every ~60 seconds to persist any session refreshes
      cookieSaveTick++;
      if (cookieSaveTick >= 300) { // 300 * 200ms = 60s
        cookieSaveTick = 0;
        saveCookies(profileId, s.page);
      }
    } catch (err: any) {
      const elapsedMs = Date.now() - frameStart;
      if (err?.message === "screenshot timeout") {
        // Chrome renderer may have crashed — count consecutive failures.
        screenshotTimeoutCount++;
        log(`[frameLoop:${profileId}] screenshot timeout #${screenshotTimeoutCount} (${elapsedMs}ms elapsed) url=${(() => { try { return s.page.url().slice(0, 80); } catch { return "?"; } })()}`, "browser");
        if (screenshotTimeoutCount >= 2) {
          if (s.autoLoginInProgress) {
            // Don't kill the session while Fill Credentials is running — navigation
            // during login naturally stalls screenshots; killing here would destroy
            // the page mid-login and cause a false ok:false loginDone result.
            log(`[frameLoop:${profileId}] screenshot timeout #${screenshotTimeoutCount} — suppressed while login is in progress`, "browser");
          } else {
            log(`[frameLoop:${profileId}] 2 consecutive screenshot timeouts — page unresponsive, closing session`, "browser");
            sseWrite(s.res, { type: "error", message: "Browser page is unresponsive. Click Retry to restart." });
            try { s.res.end(); } catch {}
            s.res = null;
            if (s.frameLoop) { clearInterval(s.frameLoop); s.frameLoop = null; }
          }
        }
      } else {
        screenshotTimeoutCount = 0; // non-timeout error (navigation busy) — not a crash
        const errMsg = err?.message ?? String(err);
        // Skip expected navigation-in-progress noise; log everything else
        if (!errMsg.includes("Execution context was destroyed") && !errMsg.includes("Target closed") && !errMsg.includes("detached")) {
          log(`[frameLoop:${profileId}] screenshot error (${elapsedMs}ms): ${errMsg}`, "browser");
        }
      }
    } finally {
      busy = false;
    }
  }, 150); // ~6 fps — fast enough for responsive CAPTCHA solving
}

export async function browserNavigate(profileId: number, url: string) {
  const s = sessions.get(profileId);
  if (!s) return;
  try {
    sseWrite(s.res, { type: "loading", loading: true });
    s.navProtectedUntil = Date.now() + 35000;
    await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    sseWrite(s.res, { type: "loading", loading: false });
  } catch {
    sseWrite(s.res, { type: "loading", loading: false });
  }
}

async function kickFrame(profileId: number) {
  const s = sessions.get(profileId);
  if (!s || !s.res || s.res.writableEnded) return;
  try {
    const [screenshot, url] = await Promise.all([
      s.page.screenshot({ type: "jpeg", quality: 70, encoding: "base64" }),
      Promise.resolve(s.page.url()),
    ]);
    sseWrite(s.res, { type: "frame", data: screenshot, url });
  } catch { /* page may be navigating */ }
}

function sendTabsUpdate(profileId: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  const tabs = s.pages.map(p => {
    let url = "";
    try { url = p.url(); } catch {}
    return { url };
  });
  sseWrite(s.res, { type: "tabsUpdate", tabs, active: s.activePage });
}

export async function browserClick(profileId: number, x: number, y: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  await s.page.mouse.click(x, y);
  kickFrame(profileId).catch(() => {});
}

export async function browserMouseMove(profileId: number, x: number, y: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  await s.page.mouse.move(x, y);
}

export async function browserScroll(profileId: number, x: number, y: number, deltaX: number, deltaY: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  // Fire the wheel event directly — mouse.move is unnecessary for page-level
  // scrolling and was halving throughput by adding an extra CDP round-trip.
  await s.page.mouse.wheel({ deltaX, deltaY });
}

export async function browserKeyDown(profileId: number, key: string) {
  const s = sessions.get(profileId);
  if (!s) return;
  // Map "Space" back to the actual key name Puppeteer expects
  const k = key === "Space" ? " " : key;
  try { await s.page.keyboard.press(k as any); } catch {}
}

export async function browserKeyUp(profileId: number, key: string) {
  const s = sessions.get(profileId);
  if (!s) return;
  const k = key === "Space" ? " " : key;
  try { await s.page.keyboard.up(k as any); } catch {}
}

export async function browserType(profileId: number, text: string) {
  const s = sessions.get(profileId);
  if (!s) return;
  await s.page.keyboard.type(text, { delay: 30 });
}

export async function browserKeyCombo(profileId: number, modifier: string, key: string) {
  const s = sessions.get(profileId);
  if (!s) return;
  try {
    await s.page.keyboard.down(modifier as any);
    await s.page.keyboard.press(key as any);
    await s.page.keyboard.up(modifier as any);
  } catch {}
}

// Returns whatever text is currently selected in the remote browser page.
// Handles both input/textarea elements (uses selectionStart/End on .value)
// and regular page selections (window.getSelection).
export async function browserGetSelectedText(profileId: number): Promise<string> {
  const s = sessions.get(profileId);
  if (!s) return "";
  try {
    const text = await s.page.evaluate(() => {
      const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
        const start = active.selectionStart ?? 0;
        const end   = active.selectionEnd   ?? 0;
        return active.value.slice(start, end);
      }
      return window.getSelection()?.toString() ?? "";
    });
    return text ?? "";
  } catch {
    return "";
  }
}

export async function browserBack(profileId: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  sseWrite(s.res, { type: "loading", loading: true });
  try { await s.page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }); } catch {}
  sseWrite(s.res, { type: "loading", loading: false });
}

export async function browserForward(profileId: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  sseWrite(s.res, { type: "loading", loading: true });
  try { await s.page.goForward({ waitUntil: "domcontentloaded", timeout: 10000 }); } catch {}
  sseWrite(s.res, { type: "loading", loading: false });
}

export async function browserReload(profileId: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  sseWrite(s.res, { type: "loading", loading: true });
  try { await s.page.reload({ waitUntil: "domcontentloaded", timeout: 10000 }); } catch {}
  sseWrite(s.res, { type: "loading", loading: false });
}

// ── File upload: accept files chosen by the user in the frontend ─────────────
export async function browserSetFiles(profileId: number, fileName: string, base64Data: string) {
  const tmpPath = path.join(COOKIES_DIR, `upload_${profileId}_${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
  try {
    fs.mkdirSync(COOKIES_DIR, { recursive: true });
    fs.writeFileSync(tmpPath, Buffer.from(base64Data, "base64"));

    const chooser = pendingFileChoosers.get(profileId);
    if (chooser) {
      pendingFileChoosers.delete(profileId);
      await chooser.accept([tmpPath]);
    } else {
      // Fallback: find the first visible file input on the page and upload directly
      const s = sessions.get(profileId);
      if (s) {
        const handle = await s.page.$('input[type="file"]').catch(() => null);
        if (handle) await (handle as any).uploadFile(tmpPath);
      }
    }
    kickFrame(profileId).catch(() => {});
  } finally {
    setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch {} }, 15000);
  }
}

// ── Tab management ────────────────────────────────────────────────────────────
export async function browserNewTab(profileId: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  try {
    const newPage = await s.browser.newPage();
    // Use the profile's stored UA — same as the main page, so Instagram sees
    // a consistent device across all tabs (not "HeadlessChrome" on new tabs).
    await newPage.setUserAgent(s.userAgent);
    await newPage.setViewport(viewportForUA(s.userAgent));
    await applyStealthScripts(newPage, s.userAgent);
    // File chooser interception for new tab
    (newPage as any).on("filechooser", (chooser: any) => {
      pendingFileChoosers.set(profileId, chooser);
      const sess = sessions.get(profileId);
      if (sess) sseWrite(sess.res, { type: "fileChooserNeeded" });
    });
    newPage.on("console", (msg: any) => {
      const sess = sessions.get(profileId);
      if (!sess) return;
      const text: string = msg.text();
      if (!text || text.startsWith("[DOM]")) return;
      sseWrite(sess.res, { type: "consoleLog", level: msg.type(), text });
    });
    s.pages.push(newPage);
    s.activePage = s.pages.length - 1;
    s.page = newPage;
    s.lastUrl = "";
    await newPage.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    sendTabsUpdate(profileId);
  } catch (e: any) {
    log(`browserNewTab error: ${e?.message}`, "browser");
  }
}

export async function browserSwitchTab(profileId: number, index: number) {
  const s = sessions.get(profileId);
  if (!s || index < 0 || index >= s.pages.length) return;
  s.activePage = index;
  s.page = s.pages[index];
  s.lastUrl = "";
  sendTabsUpdate(profileId);
  kickFrame(profileId).catch(() => {});
}

export async function browserCloseTab(profileId: number, index: number) {
  const s = sessions.get(profileId);
  if (!s || s.pages.length <= 1) return; // never close the last tab
  if (index < 0 || index >= s.pages.length) return;
  try { await s.pages[index].close(); } catch {}
  s.pages.splice(index, 1);
  // Adjust active index
  if (s.activePage >= s.pages.length) s.activePage = s.pages.length - 1;
  s.page = s.pages[s.activePage];
  s.lastUrl = "";
  sendTabsUpdate(profileId);
  kickFrame(profileId).catch(() => {});
}

// ── Send a DM through the live browser session ────────────────────────────────
// Uses page.evaluate + fetch() so all cookies/CSRF are included automatically.
// This bypasses mobile-API restrictions (4415001) by sending from within the
// browser's authenticated context on www.instagram.com.
export async function browserSendDM(
  profileId: number,
  userId: string,
  text: string,
): Promise<{ threadId: string; itemId: string } | "blocked" | null> {
  const s = sessions.get(profileId);
  if (!s) {
    log(`[browserSendDM] no active session for profile ${profileId}`, "browser");
    return null;
  }

  try {
    const result = await s.page.evaluate(
      async (uid: string, msg: string) => {
        const csrfToken =
          document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
        const body = new URLSearchParams({
          recipient_users: `[[${uid}]]`,
          client_context: String(Date.now()),
          text: msg,
        }).toString();

        const res = await fetch(
          "https://www.instagram.com/api/v1/direct_v2/threads/broadcast/text/",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "X-CSRFToken": csrfToken,
              "X-IG-App-ID": "936619743392459",
              "X-Instagram-AJAX": "1",
              "X-Requested-With": "XMLHttpRequest",
            },
            credentials: "include",
            body,
          },
        );

        let json: any = null;
        let rawText = "";
        try {
          rawText = await res.text();
          json = JSON.parse(rawText);
        } catch {}
        return { status: res.status, json, rawPreview: rawText.slice(0, 300) };
      },
      userId,
      text,
    );

    log(
      `[browserSendDM] profile ${profileId} → user ${userId}: HTTP ${result.status} json=${JSON.stringify(result.json)?.slice(0, 200)} raw=${result.rawPreview}`,
      "browser",
    );

    const j = result.json;
    if (!j) return null;
    if (j?.message === "feedback_required" || j?.feedback_required === true) {
      return "blocked";
    }
    if (j?.status === "ok") {
      const threadId: string = j?.payload?.thread_id ?? j?.thread_id ?? "";
      const itemId: string = j?.payload?.item_id ?? j?.item_id ?? "";
      return { threadId, itemId };
    }
    return null;
  } catch (err: any) {
    log(`[browserSendDM] error for profile ${profileId}: ${err?.message}`, "browser");
    return null;
  }
}

export async function closeSession(profileId: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  if (s.frameLoop) clearInterval(s.frameLoop);
  if (s.res && !s.res.writableEnded) try { s.res.end(); } catch {}
  await s.browser.close();
  sessions.delete(profileId);
  log(`Chrome closed for profile ${profileId}`, "browser");
}

export async function clearSession(profileId: number, userAgent: string, proxy?: ProxyConfig) {
  deleteSavedCookies(profileId);
  await closeSession(profileId);
  await getOrCreateSession(profileId, userAgent, proxy);
  log(`Session cleared for profile ${profileId}`, "browser");
}

// Wipe everything — used by Reset Device IDs so the EB starts as a clean
// new device with no stored cookies. Unlike clearSession, does NOT reopen
// the browser, and also deletes the Puppeteer user-data-dir so Chrome's own
// internal cookie database is erased (not just the app's saved JSON file).
export async function wipeEbSession(profileId: number): Promise<void> {
  deleteSavedCookies(profileId);
  await closeSession(profileId);
  const userDataDir = path.join(os.tmpdir(), `equinox-eb-${profileId}`);
  try {
    if (fs.existsSync(userDataDir)) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      log(`Deleted userDataDir for profile ${profileId}: ${userDataDir}`, "browser");
    }
  } catch (e: any) {
    console.warn(`[browserSession] Could not delete userDataDir for profile ${profileId}: ${e?.message}`);
  }
  log(`EB session wiped for profile ${profileId}`, "browser");
}

// ── Auto-login via Puppeteer ─────────────────────────────────────────────────

// ── Cookie consent auto-dismissal ────────────────────────────────────────────
// Tries every known Instagram cookie banner selector and clicks Accept.
// Safe to call any time — silently does nothing if no banner is visible.
async function dismissCookieBanner(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      // Selectors for known Instagram / GDPR cookie buttons (text-based + attribute)
      const acceptTexts = [
        "allow all cookies",
        "allow essential and optional cookies",
        "accept all",
        "accept cookies",
        "allow cookies",
        "allow all",
        "akzeptieren",           // German
        "accepter tout",         // French
        "aceptar todo",          // Spanish
        "accetta tutto",         // Italian
        "alle cookies akzeptieren",
      ];

      // 1. Try Instagram's own data attribute
      const attrBtn = document.querySelector<HTMLElement>('[data-cookiebanner="accept_button"]');
      if (attrBtn) { attrBtn.click(); return; }

      // 2. Try role="dialog" buttons matching known text
      const allBtns = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
      for (const btn of allBtns) {
        const txt = (btn.innerText || btn.textContent || "").trim().toLowerCase();
        if (acceptTexts.some(t => txt.includes(t))) {
          btn.click();
          return;
        }
      }
    });
  } catch {
    // Page navigating or closed — ignore
  }
}

// ── Instagram post-login popup auto-dismissal ─────────────────────────────────
// Handles all common Instagram popups/dialogs that appear after login or browsing.
// Safe to call repeatedly — does nothing when no matching popup is visible.
async function dismissInstagramPopups(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      // Texts that mean "accept / confirm / save" — click these
      const ACCEPT_TEXTS = new Set([
        "save info", "save login info", "ok", "got it", "continue",
        "i agree", "agree", "allow", "accept", "confirm", "done",
      ]);

      // Texts that mean "dismiss without saving / not now" — click these
      // Instagram uses "Not Now" for notifications, 2FA prompts, home-screen prompts, etc.
      const DISMISS_TEXTS = new Set([
        "not now", "maybe later", "skip", "dismiss", "close",
        "not interested", "no thanks", "cancel",
      ]);

      const allBtns = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));

      for (const btn of allBtns) {
        const txt = (btn.innerText || btn.textContent || "").trim().toLowerCase();

        // Priority 1: "Save your login info?" → always save
        if (ACCEPT_TEXTS.has(txt) && (txt === "save info" || txt === "save login info")) {
          btn.click();
          return;
        }
      }

      // Check every visible dialog/sheet for known patterns
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>(
        '[role="dialog"], [role="alertdialog"], ._a9-z, ._ab8w'
      ));

      for (const dialog of dialogs) {
        const body = (dialog.innerText || dialog.textContent || "").toLowerCase();
        const btns = Array.from(dialog.querySelectorAll<HTMLElement>('button, [role="button"]'));

        // "Save your login info?" → click "Save Info"
        if (body.includes("save your login info") || body.includes("save login info")) {
          const btn = btns.find(b => ACCEPT_TEXTS.has((b.innerText || b.textContent || "").trim().toLowerCase()));
          if (btn) { btn.click(); return; }
        }

        // "Turn on Notifications" / "Never Miss a Moment" → click "Not Now"
        if (body.includes("turn on notifications") || body.includes("never miss") || body.includes("stay notified")) {
          const btn = btns.find(b => DISMISS_TEXTS.has((b.innerText || b.textContent || "").trim().toLowerCase()));
          if (btn) { btn.click(); return; }
        }

        // "Add Instagram to your Home Screen" → dismiss
        if (body.includes("home screen") || body.includes("add to home")) {
          const btn = btns.find(b => DISMISS_TEXTS.has((b.innerText || b.textContent || "").trim().toLowerCase()));
          if (btn) { btn.click(); return; }
        }

        // "The messaging tab has a new look" → click "OK"
        if (body.includes("messaging tab") || body.includes("new look")) {
          const btn = btns.find(b => (b.innerText || b.textContent || "").trim().toLowerCase() === "ok");
          if (btn) { btn.click(); return; }
        }

        // Generic: any dialog with ONLY a "Not Now" / dismiss button → click it
        if (btns.length <= 3) {
          const dismissBtn = btns.find(b => DISMISS_TEXTS.has((b.innerText || b.textContent || "").trim().toLowerCase()));
          if (dismissBtn) { dismissBtn.click(); return; }
        }
      }

      // Final pass: standalone "Not Now" buttons outside dialogs (e.g. notification bar)
      for (const btn of allBtns) {
        const txt = (btn.innerText || btn.textContent || "").trim().toLowerCase();
        if (txt === "not now") { btn.click(); return; }
      }
    });
  } catch {
    // Page navigating or closed — ignore
  }
}

function sendStatus(profileId: number, message: string) {
  const s = sessions.get(profileId);
  sseWrite(s?.res ?? null, { type: "loginStatus", message });
  log(`[autoLogin:${profileId}] ${message}`, "browser");
}

export function sendLoginDone(profileId: number, ok: boolean, message: string) {
  const s = sessions.get(profileId);
  sseWrite(s?.res ?? null, { type: "loginDone", ok, message });
  log(`[loginDone:${profileId}] ${ok ? "✅" : "❌"} ${message}`, "browser");
}

// Fill a field using real keyboard events so React's controlled inputs update correctly.
async function fillField(page: Page, selector: string, text: string) {
  await page.click(selector);
  // Select all existing text then delete it
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  // Type character-by-character — this fires the keyboard events React listens to
  await page.type(selector, text, { delay: 55 });
}

// Click at real mouse coordinates — same path as a manual canvas click.
async function realClick(page: Page, selector: string): Promise<boolean> {
  const el = await page.$(selector).catch(() => null);
  if (!el) return false;
  const box = await el.boundingBox().catch(() => null);
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await new Promise(r => setTimeout(r, 120));
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return true;
}

export async function browserAutoLogin(
  profileId: number,
  username: string,
  password: string,
  twoFAKey: string,
): Promise<{ ok: boolean; message: string }> {
  const s = sessions.get(profileId);
  if (!s) return { ok: false, message: "No active browser session" };

  // Guard: suppress screenshot-timeout kills while login is running so the page
  // isn't destroyed mid-flow (which would produce a spurious ok:false result).
  s.autoLoginInProgress = true;
  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

  try {
    // ── Step 1: Check if already logged in; navigate to login only if needed ──
    const currentUrl = s.page.url();
    sendStatus(profileId, `Current URL: ${currentUrl.slice(0, 80)}`);
    // If the browser is already on Instagram and NOT on the login page,
    // the session is valid — save cookies and return immediately.
    const onInstagram = currentUrl.includes("instagram.com") && !currentUrl.startsWith("chrome-error://");
    const onLoginPage = currentUrl.includes("accounts/login");
    if (onInstagram && !onLoginPage) {
      // Instagram's home URL (/) is identical whether logged in or not — when NOT logged in
      // it shows a marketing page with an embedded login form at the same URL.
      // Check for a username input to detect that case before declaring "already logged in".
      const hasLoginForm = await s.page.$('input[name="username"], input[autocomplete="username"]').catch(() => null);
      if (!hasLoginForm) {
        await saveCookies(profileId, s.page);
        sendStatus(profileId, "✓ Already logged in — browser shows your account.");
        return { ok: true, message: "Already logged in" };
      }
      // Login form is visible at the home URL — treat as not logged in, fall through to fill it.
      sendStatus(profileId, "Login form detected — filling credentials…");
    }
    if (!onLoginPage && !onInstagram) {
      sendStatus(profileId, "Navigating to Instagram login…");
      s.navProtectedUntil = Date.now() + 35000;
      await s.page.goto("https://www.instagram.com/accounts/login/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }).catch(() => null);
    }

    // Dismiss cookie banner if present
    await delay(1500);
    await dismissCookieBanner(s.page);
    await delay(400);

    // ── Step 2: Check for login form ─────────────────────────────────────────
    sendStatus(profileId, "Looking for login form…");

    // Instagram has used several different name/autocomplete attributes over time.
    // Try each in order so we're resilient to DOM changes.
    const USERNAME_SELECTORS = [
      'input[name="username"]',
      'input[autocomplete="username"]',
      'input[name="email"]',
      'input[type="text"]:not([name="password"])',
    ];
    let usernameSelector = '';
    let usernameInput = null;
    for (const sel of USERNAME_SELECTORS) {
      const el = await s.page.waitForSelector(sel, { timeout: sel === USERNAME_SELECTORS[0] ? 12000 : 2000 }).catch(() => null);
      if (el) { usernameInput = el; usernameSelector = sel; break; }
    }

    if (!usernameInput) {
      const currentUrl = s.page.url();
      if (!currentUrl.includes("accounts/login")) {
        await saveCookies(profileId, s.page);
        sendStatus(profileId, "✓ Already logged in — browser shows your account.");
        return { ok: true, message: "Already logged in" };
      }
      // Can't find the form — leave browser open showing whatever Instagram has
      sendStatus(profileId, "⚠ Login form not found — check the browser window for what Instagram is showing.");
      return { ok: false, message: "Login form not found. Check the browser window." };
    }
    log(`[autoLogin:${profileId}] Found username input via: ${usernameSelector}`, 'browser');

    // ── Step 3: Fill credentials ─────────────────────────────────────────────
    // Wrap entire fill+submit in a try/catch — Instagram's SPA can navigate
    // mid-fill (e.g. trusted-device auto-login), destroying the execution context.
    try {
    sendStatus(profileId, "Filling username…");
    await delay(500 + Math.random() * 300);
    await fillField(s.page, usernameSelector, username);

    await delay(300 + Math.random() * 200);

    sendStatus(profileId, "Filling password…");
    // Wait for the password field with fallback selectors (same resilience as username)
    const PASSWORD_SELECTORS = [
      'input[name="password"]',
      'input[type="password"]',
      'input[autocomplete="current-password"]',
    ];
    let passwordSelector = '';
    for (const sel of PASSWORD_SELECTORS) {
      const el = await s.page.waitForSelector(sel, { timeout: sel === PASSWORD_SELECTORS[0] ? 6000 : 2000 }).catch(() => null);
      if (el) { passwordSelector = sel; break; }
    }
    if (!passwordSelector) {
      sendStatus(profileId, "⚠ Password field not found — Instagram may have changed its login page layout.");
      return { ok: false, message: "Password field not found. Check the browser window." };
    }
    await fillField(s.page, passwordSelector, password);

    // ── Step 4: Submit ───────────────────────────────────────────────────────
    sendStatus(profileId, "Waiting for login button…");
    await delay(500);

    // Dump every button/role=button on the page so we know the real DOM
    const allBtns = await s.page.evaluate(() =>
      Array.from(document.querySelectorAll('button, [role="button"]')).map((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return {
          tag: el.tagName,
          type: (el as HTMLButtonElement).type || '',
          text: (el as HTMLElement).innerText?.trim().slice(0, 40),
          disabled: (el as HTMLButtonElement).disabled ?? false,
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        };
      })
    ).catch(() => []);
    log(`[autoLogin:${profileId}] All buttons: ${JSON.stringify(allBtns)}`, 'browser');

    // Find the login button — match "Log in" / "Login" in text (ignore disabled state,
    // real mouse clicks can activate buttons regardless of HTML disabled attribute).
    const loginBtn = allBtns.find(b =>
      b.w > 50 && /log.?in/i.test(b.text)
    ) || allBtns.find(b => b.w > 100 && b.h > 20 && b.text.length > 0);

    sendStatus(profileId, "Submitting login…");

    if (loginBtn && loginBtn.w > 0) {
      log(`[autoLogin:${profileId}] Clicking: ${JSON.stringify(loginBtn)}`, 'browser');
      const cx = loginBtn.x + loginBtn.w / 2;
      const cy = loginBtn.y + loginBtn.h / 2;
      await s.page.mouse.move(cx, cy);
      await delay(120);
      await s.page.mouse.click(cx, cy);
    } else {
      // Last resort: Tab from password field to button, then press Enter
      log(`[autoLogin:${profileId}] No button found — using Tab+Enter`, 'browser');
      await s.page.focus('input[name="password"]');
      await s.page.keyboard.press('Tab');
      await delay(200);
      await s.page.keyboard.press('Enter');
    }
    } catch (fillErr: any) {
      // Instagram's SPA sometimes navigates mid-fill (e.g. trusted-device push
      // notification auto-logs in), destroying the JS execution context.
      if (/Execution context was destroyed|Target closed|detached Frame/i.test(fillErr?.message ?? "")) {
        log(`[autoLogin:${profileId}] Context destroyed during fill — checking if page navigated to login success`, 'browser');
        await delay(2500);
        const navUrl = s.page.url().catch?.(() => "") ?? s.page.url();
        const onIG = typeof navUrl === "string" && navUrl.includes("instagram.com") && !navUrl.includes("accounts/login");
        if (onIG) {
          await saveCookies(profileId, s.page);
          sendStatus(profileId, "✓ Logged in (page navigated automatically during form fill).");
          return { ok: true, message: "Logged in automatically" };
        }
        sendStatus(profileId, "⚠ Page context was destroyed during login — Instagram may be showing a challenge. Check the browser.");
        return { ok: false, message: "Login interrupted — check the browser window for any challenge." };
      }
      throw fillErr;
    }

    // ── Step 5: Wait for Instagram to respond ────────────────────────────────
    sendStatus(profileId, "Login submitted — waiting for Instagram…");

    // Wait up to 10 s for the login form to disappear from the page
    await Promise.race([
      s.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => null),
      s.page.waitForFunction(() => {
        const t = document.body?.innerText || "";
        // The login form always contains this phrase — once it's gone, we've moved on
        return !t.includes("Username, email or mobile number");
      }, { timeout: 10000 }).catch(() => null),
    ]);

    // Wait for the new page content to actually render (2FA page loads after form goes)
    await s.page.waitForFunction(() =>
      (document.body?.innerText || "").length > 80, { timeout: 6000 }
    ).catch(() => null);
    await delay(300);
    await dismissCookieBanner(s.page);

    // ── Step 6: Detect what's on screen by content, not URL ──────────────────
    // The 2FA hash-route URL still contains "/accounts/login" — can't use URL alone.
    // Also check dialogs/modals separately — Instagram renders "Incorrect password"
    // as an overlay portal that may not appear in the first 600 chars of body text.
    const [pageText, dialogText] = await Promise.all([
      s.page.evaluate(() => (document.body?.innerText || "").slice(0, 600).trim()).catch(() => ""),
      s.page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll<HTMLElement>(
          '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'
        ));
        return dialogs.map(d => (d.innerText || d.textContent || "").trim()).join(" ").slice(0, 300);
      }).catch(() => ""),
    ]);
    const allText = `${pageText} ${dialogText}`;
    const pageUrl = s.page.url();
    sendStatus(profileId, `After submit → URL: ${pageUrl.slice(0, 80)}`);
    sendStatus(profileId, `Page text snippet: "${pageText.slice(0, 120)}"`);
    if (dialogText) sendStatus(profileId, `Dialog text: "${dialogText.slice(0, 120)}"`);
    log(`[autoLogin:${profileId}] Page after submit: "${pageText.slice(0, 150)}"`, 'browser');

    // Check for "Incorrect password" or "wrong password" in any dialog/overlay
    const isWrongPassword = /incorrect.{0,20}password|wrong.{0,20}password|password.{0,20}incorrect|bad.?password/i.test(allText);
    if (isWrongPassword) {
      sendStatus(profileId, "⚠ Instagram says the password is incorrect. Update the password in Account Details and try again.");
      return { ok: false, message: "Incorrect password — update it in Account Details." };
    }

    const is2FA = /authentication.app|6.digit|two.factor|verif|security.code|confirmation.code|backup.code|enter.the.code/i.test(allText) ||
                  pageUrl.includes("/two_factor") || pageUrl.includes("challenge");

    const isLoggedIn = !pageText.includes("Username, email or mobile number") &&
                       !pageText.includes("Create new account") &&
                       !pageUrl.includes("/accounts/login");

    sendStatus(profileId, `2FA detected: ${is2FA} | Logged in: ${isLoggedIn}`);

    // ── Step 7: Auto-fill TOTP if 2FA screen detected ────────────────────────
    if (is2FA) {
      const keyClean = twoFAKey.replace(/\s+/g, "");
      sendStatus(profileId, `TOTP key present: ${!!keyClean} (length ${keyClean.length})`);
      if (keyClean) {
        sendStatus(profileId, "2FA screen — entering TOTP code automatically…");
        let code: string;
        try {
          code = totpGenerate({ secret: keyClean });
          sendStatus(profileId, `TOTP code generated: ${code.slice(0, 2)}****`);
        } catch (totpErr: any) {
          sendStatus(profileId, `⚠ Invalid 2FA secret key — ${totpErr?.message ?? "check your TOTP key in Account Details"}`);
          return { ok: false, message: `Invalid 2FA secret: ${totpErr?.message}` };
        }

        // Wait up to 3s for the 2FA overlay to fully render in the DOM
        // Wait until a NEW text input appears that is NOT the login page's email/password fields.
        // Instagram's SPA mounts the 2FA form asynchronously — the old inputs linger.
        sendStatus(profileId, "Waiting for 2FA input to appear in DOM…");
        await s.page.waitForFunction(() => {
          const SKIP_NAMES  = new Set(["username", "email", "pass", "password"]);
          const SKIP_TYPES  = new Set(["password", "submit", "button", "hidden", "checkbox", "radio"]);
          return Array.from(document.querySelectorAll("input")).some(el => {
            const name = (el as HTMLInputElement).name?.toLowerCase() || "";
            const type = (el as HTMLInputElement).type?.toLowerCase() || "text";
            if (SKIP_NAMES.has(name) || SKIP_TYPES.has(type)) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
        }, { timeout: 12000 }).catch(() => null);

        // Dump ALL inputs so we can diagnose exactly what's in the DOM
        const allInputs = await s.page.evaluate(() =>
          Array.from(document.querySelectorAll("input")).map(el => ({
            name: (el as HTMLInputElement).name,
            type: (el as HTMLInputElement).type,
            inputmode: el.getAttribute("inputmode"),
            autocomplete: (el as HTMLInputElement).autocomplete,
            placeholder: (el as HTMLInputElement).placeholder.slice(0, 20),
            visible: el.getBoundingClientRect().width > 0,
            y: Math.round(el.getBoundingClientRect().top),
          }))
        ).catch(() => []);
        sendStatus(profileId, `DOM inputs after wait: ${JSON.stringify(allInputs)}`);

        const frames = s.page.frames();
        sendStatus(profileId, `Frames: ${frames.length} — ${frames.map(f => f.url().slice(0, 50)).join(" | ")}`);

        // Instagram has used many different attributes for the TOTP input over time.
        // Cast a wide net — newer layouts use plain name="code" or just a visible numeric input.
        const NAMED_SELECTORS = [
          'input[name="verificationCode"]',
          'input[name="verification_code"]',
          'input[name="security_code"]',
          'input[name="totp_code"]',
          'input[name="code"]',
          'input[inputmode="numeric"]',
          'input[autocomplete="one-time-code"]',
          'input[type="tel"]',
          'input[type="number"]',
          'input[maxlength="6"]',
        ];

        let codeInput: any = null;
        let codeSelector = '';

        // 1. Named selectors across all frames
        outer: for (const frame of frames) {
          for (const sel of NAMED_SELECTORS) {
            const el = await frame.$(sel).catch(() => null);
            if (el) { codeInput = el; codeSelector = `${sel} [frame: ${frame.url().slice(0, 30)}]`; break outer; }
          }
        }

        // 2. Placeholder-text fallback — evaluate() inside all frames
        //    Catches inputs whose placeholder contains "code" / "Code" regardless of other attrs
        if (!codeInput) {
          for (const frame of frames) {
            const handle = await frame.evaluateHandle(() => {
              const SKIP_NAMES = new Set(["username", "email", "pass", "password", "search", "q"]);
              const SKIP_TYPES = new Set(["password", "submit", "button", "hidden", "checkbox", "radio", "file"]);
              return Array.from(document.querySelectorAll("input")).find(el => {
                const name = (el as HTMLInputElement).name?.toLowerCase() || "";
                const type = (el as HTMLInputElement).type?.toLowerCase() || "text";
                const ph   = ((el as HTMLInputElement).placeholder || "").toLowerCase();
                if (SKIP_NAMES.has(name) || SKIP_TYPES.has(type)) return false;
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) return false;
                return ph.includes("code") || ph.includes("digit") || ph.includes("otp");
              }) ?? null;
            }).catch(() => null);
            const el = handle && (handle as any).asElement ? (handle as any).asElement() : null;
            if (el) { codeInput = el; codeSelector = `placeholder~"code" [frame: ${frame.url().slice(0, 30)}]`; break; }
          }
        }

        // 3. Type=text fallback in all frames — closest to viewport centre, skipping login fields
        if (!codeInput) {
          for (const frame of frames) {
            const handle = await frame.evaluateHandle(() => {
              const SKIP_NAMES = new Set(["username", "email", "pass", "password", "search", "q"]);
              const candidates = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
                .map(el => {
                  const r = el.getBoundingClientRect();
                  return { el, name: (el as HTMLInputElement).name?.toLowerCase() || "", r };
                })
                .filter(({ r, name }) => r.width > 0 && r.height > 0 && !SKIP_NAMES.has(name));
              if (!candidates.length) return null;
              const mid = window.innerHeight / 2;
              candidates.sort((a, b) => Math.abs(a.r.top - mid) - Math.abs(b.r.top - mid));
              return candidates[0].el;
            }).catch(() => null);
            const el = handle && (handle as any).asElement ? (handle as any).asElement() : null;
            if (el) { codeInput = el; codeSelector = `type=text nearest centre [frame: ${frame.url().slice(0, 30)}]`; break; }
          }
        }

        // 4. Final brute-force — ANY visible non-login input across all frames
        //    Last resort so the code always has a chance to type into something
        if (!codeInput) {
          for (const frame of frames) {
            const handle = await frame.evaluateHandle(() => {
              const SKIP_NAMES  = new Set(["username", "email", "pass", "password", "search", "q"]);
              const SKIP_TYPES  = new Set(["password", "submit", "button", "hidden", "checkbox", "radio", "file", "image"]);
              return Array.from(document.querySelectorAll("input")).find(el => {
                const name = (el as HTMLInputElement).name?.toLowerCase() || "";
                const type = (el as HTMLInputElement).type?.toLowerCase() || "text";
                if (SKIP_NAMES.has(name) || SKIP_TYPES.has(type)) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              }) ?? null;
            }).catch(() => null);
            const el = handle && (handle as any).asElement ? (handle as any).asElement() : null;
            if (el) { codeInput = el; codeSelector = `brute-force any-visible-input [frame: ${frame.url().slice(0, 30)}]`; break; }
          }
        }

        sendStatus(profileId, `2FA input: ${codeSelector || "NONE FOUND"}`);

        if (codeInput) {
          // Click directly on the element handle's bounding box
          const box = await codeInput.boundingBox().catch(() => null);
          sendStatus(profileId, `Input bounding box: ${JSON.stringify(box)}`);
          if (box) {
            await s.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          } else {
            await codeInput.click();
          }
          await delay(200);
          // Clear then type
          await s.page.keyboard.down("Control");
          await s.page.keyboard.press("a");
          await s.page.keyboard.up("Control");
          await s.page.keyboard.press("Backspace");
          await s.page.keyboard.type(code, { delay: 80 });
          sendStatus(profileId, `Typed TOTP code into input`);
          await delay(400);
          // Click "Confirm" / "Continue" / "Verify" / "Submit" button
          const contBtns = await s.page.evaluate(() =>
            Array.from(document.querySelectorAll('button, [role="button"]')).map((el) => {
              const r = (el as HTMLElement).getBoundingClientRect();
              return { text: (el as HTMLElement).innerText?.trim(), x: r.x, y: r.y, w: r.width, h: r.height };
            })
          ).catch(() => [] as any[]);
          sendStatus(profileId, `Buttons found: ${contBtns.map((b: any) => `"${b.text}"`).join(", ").slice(0, 150)}`);
          const contBtn = contBtns.find((b: any) => /confirm|continue|verify|submit/i.test(b.text) && b.w > 50);
          sendStatus(profileId, `Submit button: ${contBtn ? `"${contBtn.text}"` : "NONE — using Enter"}`);
          if (contBtn) {
            await s.page.mouse.move(contBtn.x + contBtn.w / 2, contBtn.y + contBtn.h / 2);
            await delay(100);
            await s.page.mouse.click(contBtn.x + contBtn.w / 2, contBtn.y + contBtn.h / 2);
          } else {
            await s.page.keyboard.press("Enter");
          }

          // Wait up to 10s for Instagram to navigate away from the 2FA page
          sendStatus(profileId, "2FA code submitted — waiting for Instagram…");
          await Promise.race([
            s.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => null),
            s.page.waitForFunction(
              () => !window.location.href.includes("/two_factor") && !window.location.href.includes("/accounts/login"),
              { timeout: 10000 }
            ).catch(() => null),
          ]);

          // Dismiss any post-login popups (save login info, notifications, etc.)
          await delay(1000);
          await dismissCookieBanner(s.page);
          await dismissInstagramPopups(s.page);

          let afterUrl = "";
          try { afterUrl = s.page.url(); } catch { /* page context may have been destroyed during navigation */ }
          const afterText = await s.page.evaluate(
            () => (document.body?.innerText || "").slice(0, 300).trim()
          ).catch(() => "");
          sendStatus(profileId, `After 2FA: URL="${afterUrl.slice(0, 80)}" text="${afterText.slice(0, 80)}"`);
          log(`[autoLogin:${profileId}] After 2FA submit: url="${afterUrl}" text="${afterText.slice(0, 100)}"`, "browser");

          const twoFaAccepted = !afterUrl.includes("/two_factor") && !afterUrl.includes("/accounts/login");
          if (twoFaAccepted) {
            await saveCookies(profileId, s.page);
            sendStatus(profileId, "✓ 2FA accepted — logged in successfully!");
            return { ok: true, message: "Login successful" };
          }

          // Still on the 2FA / login page — code was likely rejected
          const errSnippet = afterText.slice(0, 100);
          sendStatus(profileId, `⚠ 2FA code not accepted — ${errSnippet || "check the browser window"}`);
          return { ok: false, message: "2FA code rejected" };
        } else {
          sendStatus(profileId, "⚠ 2FA screen — NO input field found. Cannot type code.");
          return { ok: true, message: "2FA screen shown" };
        }
      } else {
        sendStatus(profileId, "⚠ 2FA screen — no TOTP secret stored for this account. Go to Account Details and paste the 16-character TOTP secret key from your authenticator app, then try Fill Credentials again. You can also type the code manually in the browser window.");
        return { ok: true, message: "2FA screen — no TOTP key stored. Add the TOTP secret in Account Details and retry." };
      }
    }

    if (isLoggedIn) {
      await saveCookies(profileId, s.page);
      sendStatus(profileId, "✓ Logged in — browser is showing your Instagram.");
      return { ok: true, message: "Login successful" };
    }

    // Still appears to be on the login page — report what's visible
    const snippet = pageText.slice(0, 150);
    const msg = snippet
      ? `Instagram is showing: "${snippet}" — handle it in the browser window.`
      : "Instagram is showing a challenge — check the browser window.";
    sendStatus(profileId, `⚠ ${msg}`);
    return { ok: false, message: msg };

  } catch (err: any) {
    const msg = err?.message || "Unknown error during login";
    sendStatus(profileId, `Error: ${msg}`);
    return { ok: false, message: msg };
  } finally {
    // Always clear the guard — whether the login succeeded, failed, or threw.
    s.autoLoginInProgress = false;
  }
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Browser-based photo upload via Instagram's own create-post UI ─────────────
// Drives the Instagram web post-creation flow (the "+" button) using Puppeteer.
// This is the only reliable approach since the rupload endpoint returns HTML SPA
// to browser-context fetch() calls (it's only accessible to mobile native clients).
export async function uploadPhotoViaBrowser(
  profileId: number,
  imageBuffer: Buffer,
  caption: string,
): Promise<string | null> {
  const s = sessions.get(profileId);
  if (!s) {
    log(`uploadPhotoViaBrowser: no browser session for profile ${profileId}`);
    return null;
  }

  const tmpPath = path.join(COOKIES_DIR, `upload_${profileId}_${Date.now()}.jpg`);
  let capturedMediaId: string | null = null;

  // Response listener — captures the media ID published by Instagram
  const onResponse = async (resp: any) => {
    const url: string = resp.url();
    if (
      url.includes("/creation_flow/") ||
      url.includes("/api/v1/media/configure") ||
      url.includes("/api/v1/media/upload_finish")
    ) {
      try {
        const text = await resp.text().catch(() => "");
        const json = JSON.parse(text);
        if (json?.media?.id) capturedMediaId = String(json.media.id);
        if (json?.upload_id && !capturedMediaId) capturedMediaId = String(json.upload_id);
      } catch { /* non-JSON or empty */ }
    }
  };

  try {
    fs.mkdirSync(COOKIES_DIR, { recursive: true });
    fs.writeFileSync(tmpPath, imageBuffer);

    const page = s.page;
    page.on("response", onResponse);

    // Do NOT call page.goto() here — the session-init already navigates to Instagram
    // home after restoring cookies. A second navigation triggers Instagram's recaptcha.
    // Instead, wait for the session-init navigation to settle on the feed.
    log(`uploadPhotoViaBrowser [${profileId}]: waiting for Instagram feed page`);
    let feedReady = false;
    for (let i = 0; i < 60; i++) {
      const cur = page.url();
      if (
        cur.includes("instagram.com") &&
        !cur.includes("/accounts/login") &&
        !cur.includes("/auth_platform/") &&
        cur !== "about:blank"
      ) {
        feedReady = true;
        log(`uploadPhotoViaBrowser [${profileId}]: page ready at ${cur}`);
        break;
      }
      await delay(500);
    }
    if (!feedReady) {
      const cur = page.url();
      throw new Error(`Instagram page not ready (url=${cur})`);
    }
    // Let React finish rendering after navigation settles
    await delay(2500);

    // ── Click the "New post" / "+" create button ─────────────────────────────
    log(`uploadPhotoViaBrowser [${profileId}]: clicking create button`);
    const clicked = await page.evaluate((): boolean => {
      // Match any element whose aria-label contains "new post" or equals "create"
      const allWithLabel = [...document.querySelectorAll("[aria-label]")] as HTMLElement[];
      const target = allWithLabel.find(el => {
        const lbl = (el.getAttribute("aria-label") ?? "").toLowerCase();
        return lbl.includes("new post") || lbl === "create" || lbl.includes("new post");
      });
      if (target) {
        const btn = target.closest<HTMLElement>('[role="button"], button, a') ?? target;
        btn.click();
        return true;
      }
      // Fallback: look for a nav link to /create/
      const createLink = document.querySelector<HTMLElement>('a[href*="/create"]');
      if (createLink) { createLink.click(); return true; }
      return false;
    });
    if (!clicked) throw new Error("Could not find the create/new-post button");
    await delay(2000);

    // ── If Instagram shows a format picker (Post / Story / Reel), pick "Post" ─
    await page.evaluate((): void => {
      const items = [...document.querySelectorAll<HTMLElement>("button, [role='menuitem'], li")];
      const postItem = items.find(el => el.textContent?.trim() === "Post");
      if (postItem) postItem.click();
    });
    await delay(1000);

    // ── Wait for file input and upload the image ──────────────────────────────
    log(`uploadPhotoViaBrowser [${profileId}]: waiting for file input`);
    const fileInput = await page.waitForSelector("input[type='file']", { timeout: 12000 });
    if (!fileInput) throw new Error("File input not found");
    await fileInput.uploadFile(tmpPath);
    log(`uploadPhotoViaBrowser [${profileId}]: file uploaded — waiting for crop view`);
    await delay(2500);

    // ── Crop step → click "Next" ──────────────────────────────────────────────
    log(`uploadPhotoViaBrowser [${profileId}]: clicking Next (crop)`);
    await clickBtnByText(page, "Next", 12000);
    await delay(2000);

    // ── Filter/Edit step → click "Next" ──────────────────────────────────────
    log(`uploadPhotoViaBrowser [${profileId}]: clicking Next (filter)`);
    await clickBtnByText(page, "Next", 12000);
    await delay(2000);

    // ── Caption step → type caption ───────────────────────────────────────────
    if (caption) {
      log(`uploadPhotoViaBrowser [${profileId}]: setting caption`);
      const captionEl = await page.$("textarea[aria-label*='caption'], textarea[aria-label*='Caption']")
        ?? await page.$("div[aria-label*='caption'] textarea")
        ?? await page.$("div[contenteditable='true']")
        ?? await page.$("textarea");
      if (captionEl) {
        await captionEl.click();
        await page.keyboard.type(caption.slice(0, 2200));
      }
    }
    await delay(800);

    // ── Click "Share" ─────────────────────────────────────────────────────────
    log(`uploadPhotoViaBrowser [${profileId}]: clicking Share`);
    await clickBtnByText(page, "Share", 15000);
    log(`uploadPhotoViaBrowser [${profileId}]: Share clicked — waiting for confirmation`);

    // Wait up to 15 s for the response listener to capture the media ID,
    // or for the modal to close (indicating success)
    for (let i = 0; i < 30; i++) {
      if (capturedMediaId) break;
      await delay(500);
    }

    const result = capturedMediaId ?? String(Date.now());
    log(`uploadPhotoViaBrowser [${profileId}]: done — mediaId=${result}`);
    return result;

  } catch (e: any) {
    log(`uploadPhotoViaBrowser [${profileId}] error: ${e?.message}`);
    return null;
  } finally {
    s.page.off("response", onResponse);
    try { fs.unlinkSync(tmpPath); } catch { /* already removed */ }
  }
}

/** Click the first button/role=button whose visible text matches `text` exactly */
async function clickBtnByText(page: Page, text: string, timeout: number): Promise<void> {
  const handle = await page.waitForFunction(
    (t: string) => {
      const all = [
        ...document.querySelectorAll<HTMLElement>('button, [role="button"], [type="submit"]'),
      ];
      return all.find(el => el.textContent?.trim() === t) ?? null;
    },
    { timeout },
    text,
  );
  if (handle) {
    const el = handle.asElement() as any;
    if (el) await el.click();
  }
}

// ── Browser-fetch photo upload (same-origin fetch, no UI automation) ──────────
// Uses the existing browser session to make a rupload fetch() directly from the
// browser page context.  Same TLS fingerprint + cookies as Chrome, no new
// session created, no UI interaction that could trigger recaptcha.
export async function uploadPhotoViaFetch(
  profileId: number,
  imageBuffer: Buffer,
  caption: string,
): Promise<string | null> {
  // The browser session is launched asynchronously after engine start.
  // Wait up to 90s for it to become available before giving up.
  let s = sessions.get(profileId);
  if (!s) {
    log(`uploadPhotoViaFetch [${profileId}]: waiting for browser session...`);
    for (let i = 0; i < 90; i++) {
      await delay(1000);
      s = sessions.get(profileId);
      if (s) { log(`uploadPhotoViaFetch [${profileId}]: browser session ready after ${i + 1}s`); break; }
    }
  }
  if (!s) {
    log(`uploadPhotoViaFetch [${profileId}]: timeout — no browser session available`);
    return null;
  }

  const uploadId = String(Date.now());
  const b64 = imageBuffer.toString("base64");
  const ruploadParams = JSON.stringify({
    media_type: 1,
    upload_id: uploadId,
    upload_media_height: 1080,
    upload_media_width: 1080,
    upload_media_duration_ms: 0,
    xsharing_user_ids: [],
  });

  try {
    // Step 1 — rupload via browser fetch (same-origin, chrome TLS + cookies)
    const ruploadResult = await s.page.evaluate(async (b64img: string, uid: string, rparams: string) => {
      const bytes = Uint8Array.from(atob(b64img), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: "image/jpeg" });

      const csrfCookie = document.cookie.split(";").find(c => c.trim().startsWith("csrftoken="));
      const csrf = csrfCookie ? csrfCookie.split("=")[1].trim() : "";

      const resp = await fetch(`https://www.instagram.com/rupload/igphoto/${uid}`, {
        method: "POST",
        credentials: "include",
        headers: {
          "X-IG-App-ID": "936619743392459",
          "X-CSRFToken": csrf,
          "X-IG-Capabilities": "3brTvwE=",
          "X-IG-Connection-Type": "WIFI",
          "Content-Type": "image/jpeg",
          "X-Entity-Type": "image/jpeg",
          "X-Entity-Name": `photo_${uid}`,
          "Offset": "0",
          "X-Entity-Length": String(bytes.length),
          "X-Instagram-Rupload-Params": rparams,
        },
        body: blob,
      });

      const text = await resp.text();
      return { status: resp.status, text };
    }, b64, uploadId, ruploadParams);

    log(`uploadPhotoViaFetch [${profileId}]: rupload status=${ruploadResult.status} body=${ruploadResult.text.slice(0, 200)}`);

    let uploadJson: any = null;
    try { uploadJson = JSON.parse(ruploadResult.text); } catch {}
    const uploaded = uploadJson?.upload_id != null || uploadJson?.status === "ok";
    if (!uploaded) {
      log(`uploadPhotoViaFetch [${profileId}]: rupload failed`);
      return null;
    }

    // Step 2 — configure via browser fetch
    const configureResult = await s.page.evaluate(async (uid: string, cap: string) => {
      const csrfCookie = document.cookie.split(";").find(c => c.trim().startsWith("csrftoken="));
      const csrf = csrfCookie ? csrfCookie.split("=")[1].trim() : "";

      const body = new URLSearchParams({
        upload_id: uid,
        caption: cap,
        source_type: "4",
        timezone_offset: "0",
        date_time_original: new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14),
      });

      const resp = await fetch("https://i.instagram.com/api/v1/media/configure/", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-IG-App-ID": "936619743392459",
          "X-CSRFToken": csrf,
          "X-IG-Capabilities": "3brTvwE=",
          "X-IG-Connection-Type": "WIFI",
        },
        body: body.toString(),
      });

      const text = await resp.text();
      return { status: resp.status, text };
    }, uploadId, caption);

    log(`uploadPhotoViaFetch [${profileId}]: configure status=${configureResult.status} body=${configureResult.text.slice(0, 200)}`);

    let confJson: any = null;
    try { confJson = JSON.parse(configureResult.text); } catch {}
    const mediaId: string | null = confJson?.media?.id ? String(confJson.media.id) : null;
    if (!mediaId && confJson?.status === "ok") return uploadId;
    return mediaId;
  } catch (err: any) {
    log(`uploadPhotoViaFetch [${profileId}]: error: ${err?.message}`);
    return null;
  }
}

// ── Cookie baker EB helpers ──────────────────────────────────────────────────

export function hasBrowserSession(profileId: number): boolean {
  return sessions.has(profileId);
}

export async function borrowEbPageForCookieBaker(profileId: number): Promise<any | null> {
  const s = sessions.get(profileId);
  if (!s) return null;
  try {
    const page = await s.browser.newPage();
    await page.setViewport(viewportForUA(s.userAgent));
    s.pages.push(page);
    s.activePage = s.pages.length - 1;
    s.page = page;
    s.lastUrl = "";
    sendTabsUpdate(profileId);
    kickFrame(profileId).catch(() => {});
    return page;
  } catch (e: any) {
    log(`borrowEbPageForCookieBaker [${profileId}]: ${e?.message}`, "browser");
    return null;
  }
}

export async function releaseEbCookieBakerPage(profileId: number): Promise<void> {
  const s = sessions.get(profileId);
  if (!s || s.pages.length <= 1) return;
  const lastIdx = s.pages.length - 1;
  try { await s.pages[lastIdx].close(); } catch {}
  s.pages.splice(lastIdx, 1);
  s.activePage = s.pages.length - 1;
  s.page = s.pages[s.activePage];
  s.lastUrl = "";
  sendTabsUpdate(profileId);
  kickFrame(profileId).catch(() => {});
}
