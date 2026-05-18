import type { Browser, Page } from "puppeteer";
import type { ServerResponse } from "http";
import https from "https";
import WebSocket from "ws";
import { generateTotp } from "./totp";
import fs from "fs";
import path from "path";
import os from "os";
import net from "net";

import { db } from "@workspace/db";
import { instagramApiCalls } from "../shared/schema";
import { storage } from "../storage";

function log(msg: string, _category?: string) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] [browser] ${msg}`);
}

// ── EB challenge classifier ───────────────────────────────────────────────────
// Maps an Instagram URL (redirect target or current page) to an accountStatus
// value so the DB always reflects what the embedded browser is actually showing.
function classifyEbChallengeUrl(url: string): string | null {
  if (!url || !url.includes("instagram.com")) return null;
  if (/confirm_email|email.*verif|verif.*email|email_confirmation/i.test(url)) return "email_confirmation";
  if (/update_risky_contactpoint|\/challenge\//i.test(url))                     return "captcha";
  if (/accounts\/disabled/i.test(url))                                          return "account_disabled";
  if (/accounts\/suspended/i.test(url))                                         return "confirm_human";
  if (/phone.*verif|verif.*phone|phone_required|confirm.*phone/i.test(url))     return "phone_verification";
  return null;
}

// ── Proxy health check ────────────────────────────────────────────────────────
// Before launching Chrome we do a quick TCP connect to the proxy host:port.
// A dead or unreachable proxy causes Chrome to hang completely (its renderer
// thread blocks on the CONNECT tunnel) making even screenshots time out.
// Detecting this upfront avoids the 40-second crash loop entirely.
function testProxyReachable(host: string, port: number, timeoutMs = 6000): Promise<{ ok: boolean; errorCode?: string }> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ ok: false, errorCode: "TIMEOUT" });
    }, timeoutMs);
    sock.on("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve({ ok: true });
    });
    sock.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ ok: false, errorCode: err.code ?? err.message });
    });
  });
}

// ── Cookie persistence ───────────────────────────────────────────────────────
// When DATABASE_PATH is set (Electron production), store cookies next to the
// database in userData so they survive app updates and reinstalls.
// In dev (no DATABASE_PATH) fall back to the old process.cwd()-relative path.
const COOKIES_DIR = process.env.DATABASE_PATH
  ? path.join(path.dirname(process.env.DATABASE_PATH), "browser-data")
  : path.join(process.cwd(), "server", "browser-data");

function cookiePath(profileId: number) {
  return path.join(COOKIES_DIR, `cookies-${profileId}.json`);
}

async function saveCookies(profileId: number, page: Page): Promise<void> {
  try {
    // Always request cookies for instagram.com explicitly — page.cookies() without args
    // returns cookies for the CURRENT page URL only. When the page is on chrome-error://
    // (ERR_TOO_MANY_REDIRECTS after login) that returns nothing. CDP's Network.getCookies
    // accepts an explicit URL list and returns matching cookies regardless of current page.
    const cookies = await page.cookies(
      "https://www.instagram.com",
      "https://i.instagram.com",
      "https://instagram.com",
    );
    if (!cookies.length) return;
    fs.mkdirSync(COOKIES_DIR, { recursive: true });
    fs.writeFileSync(cookiePath(profileId), JSON.stringify(cookies, null, 2), "utf8");
    log(`[cookies:${profileId}] Saved ${cookies.length} cookies (explicit IG domain fetch)`, "browser");

    // ── Sync device fingerprint tokens back to the DB ─────────────────────────
    // Chrome is the source of truth for mid, ig_did, datr, csrftoken, and
    // sessionid.  Whenever Chrome updates any of these (e.g. Instagram rotates
    // mid after a challenge, or issues a fresh sessionid after login), the DB
    // copy must match — otherwise the mobile API presents a different device
    // fingerprint and Instagram fires "Unrecognised device" on the next request.
    const get = (name: string) => cookies.find(c => c.name === name)?.value ?? "";
    const sessionid  = get("sessionid");
    const csrftoken  = get("csrftoken");
    const dsUserId   = get("ds_user_id");
    const mid        = get("mid");
    const igDid      = get("ig_did");

    // Only write ig_api_cookies if we have the two essential device tokens.
    if (sessionid && mid) {
      const parts = [
        `sessionid=${sessionid}`,
        csrftoken  ? `csrftoken=${csrftoken}`    : "",
        dsUserId   ? `ds_user_id=${dsUserId}`    : "",
        `mid=${mid}`,
        igDid      ? `ig_did=${igDid}`           : "",
      ].filter(Boolean);
      const newApiCookies = parts.join(";");

      // Also keep ig_device_state.igDid in sync so the mobile API client never
      // falls back to a random ig_did.
      let deviceStateUpdate: Record<string, unknown> | null = null;
      if (igDid) {
        try {
          const profile = await storage.getProfile(profileId);
          if (profile) {
            const ds = JSON.parse((profile.igDeviceState as string | null) ?? "{}");
            if (ds.igDid !== igDid) {
              ds.igDid = igDid;
              deviceStateUpdate = ds;
            }
          }
        } catch { /* non-fatal */ }
      }

      const dbUpdate: Record<string, unknown> = { igApiCookies: newApiCookies };
      if (deviceStateUpdate) dbUpdate.igDeviceState = JSON.stringify(deviceStateUpdate);
      await storage.updateProfile(profileId, dbUpdate as any).catch(() => {});
      log(`[cookies:${profileId}] DB ig_api_cookies synced (mid=${mid.slice(0, 10)}… ig_did=${igDid ? igDid.slice(0, 8) + "…" : "none"})`, "browser");
    }
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

// ── EB signup cookie harvester ────────────────────────────────────────────────
// Spins up a temporary headless Chrome, navigates to instagram.com/accounts/emailsignup/,
// and collects the browser-originated cookies (mid, ig_did, csrftoken) that Instagram's
// CDN sets on first contact.  These are then passed to createInstagramAccountViaApi so
// the mobile API handshake uses real EB cookies instead of randomly generated device IDs.
//
// This mirrors the Jarvee two-stage handshake used for the login flow:
//   1. EB visits instagram.com → Instagram CDN sets mid, ig_did, csrftoken
//   2. Those cookies seed the mobile API signup call → Instagram sees a real device
//
// The session is throwaway (no persistent user-data-dir) — we only need fresh cookies,
// not a long-lived device identity.  The browser is closed as soon as cookies are collected.
export async function harvestSignupCookiesFromEB(opts?: {
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  userAgent?: string;
}): Promise<{ mid: string; ig_did: string; csrftoken: string; cookieStrings: string[]; ebUserAgent: string } | null> {
  const logPfx = "[harvestSignupCookies]";
  log(`${logPfx} Starting EB cookie harvest for signup...`);

  // Throwaway data dir — deleted after harvest.  Using COOKIES_DIR (not os.tmpdir)
  // keeps it on the same volume as the rest of browser-data and avoids tmpfs limits.
  const tmpDataDir = path.join(
    COOKIES_DIR,
    `signup-harvest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(tmpDataDir, { recursive: true });

  // We need puppeteer loaded before CHROMIUM_PATH is used
  let puppeteerLib: any;
  try {
    puppeteerLib = (await import("puppeteer-core")).default;
  } catch {
    try {
      puppeteerLib = (await import("puppeteer")).default;
    } catch (e: any) {
      log(`${logPfx} Cannot load puppeteer: ${e?.message}`);
      try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch {}
      return null;
    }
  }

  if (!CHROMIUM_PATH) {
    log(`${logPfx} No CHROMIUM_PATH — cannot harvest cookies`);
    try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch {}
    return null;
  }

  const proxyArg = opts?.proxyHost
    ? [`--proxy-server=${opts.proxyHost}:${opts.proxyPort ?? 80}`]
    : [];

  let browser: any;
  try {
    browser = await puppeteerLib.launch({
      headless: true,
      executablePath: CHROMIUM_PATH,
      args: [...LAUNCH_ARGS, `--user-data-dir=${tmpDataDir}`, ...proxyArg],
      ignoreHTTPSErrors: true,
    });
    log(`${logPfx} Temporary Chrome launched`);
  } catch (e: any) {
    log(`${logPfx} Browser launch failed: ${e?.message}`);
    try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch {}
    return null;
  }

  const FALLBACK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  const effectiveUA = opts?.userAgent ?? FALLBACK_UA;
  try {
    const [page] = await browser.pages();
    await page.setUserAgent(effectiveUA);
    await page.setViewport({ width: 1280, height: 760 });

    if (opts?.proxyUsername) {
      await page.authenticate({ username: opts.proxyUsername, password: opts.proxyPassword ?? "" });
    }

    await applyStealthScripts(page, effectiveUA);

    // ── Step 1: Visit the homepage first ─────────────────────────────────────
    // Instagram's CDN sets mid and ig_did on the *first* request to any IG page.
    // Navigating directly to the signup page sometimes skips the CDN cookie
    // injection because Instagram detects it as a deep-link and defers the
    // fingerprinting JS.  Hitting the homepage first guarantees the device tokens
    // are set before we proceed to the signup page.
    log(`${logPfx} Navigating to instagram.com (homepage) to seed device cookies...`);
    try {
      await page.goto("https://www.instagram.com/", {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
    } catch (e: any) {
      log(`${logPfx} Homepage navigation warning (continuing): ${e?.message}`);
    }

    // Quick check after homepage load
    const homepageCookies = await page.cookies(
      "https://www.instagram.com",
      "https://i.instagram.com",
      "https://instagram.com",
    ) as Array<{ name: string; value: string }>;
    let mid = homepageCookies.find(c => c.name === "mid")?.value ?? "";
    let ig_did = homepageCookies.find(c => c.name === "ig_did")?.value ?? "";
    let csrftoken = homepageCookies.find(c => c.name === "csrftoken")?.value ?? "";
    log(`${logPfx} After homepage: mid=${mid ? "✓" : "✗"} ig_did=${ig_did ? "✓" : "✗"} csrftoken=${csrftoken ? "✓" : "✗"}`);

    // ── Step 2: Navigate to signup page if device cookies still missing ───────
    if (!mid || !ig_did) {
      log(`${logPfx} Navigating to instagram.com/accounts/emailsignup/ to get remaining cookies...`);
      try {
        await page.goto("https://www.instagram.com/accounts/emailsignup/", {
          waitUntil: "networkidle2",
          timeout: 30000,
        });
      } catch (e: any) {
        log(`${logPfx} Signup page navigation warning (still checking cookies): ${e?.message}`);
      }
    }

    // ── Step 3: Poll until all three cookies appear (up to 20 s) ─────────────
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const cookies = await page.cookies(
        "https://www.instagram.com",
        "https://i.instagram.com",
        "https://instagram.com",
      );
      for (const c of cookies as Array<{ name: string; value: string }>) {
        if (c.name === "mid"       && c.value) mid       = c.value;
        if (c.name === "ig_did"    && c.value) ig_did    = c.value;
        if (c.name === "csrftoken" && c.value) csrftoken = c.value;
      }
      if (mid && ig_did && csrftoken) break;
      await new Promise(r => setTimeout(r, 500));
    }

    // Build a clean cookie string array from whatever Instagram set
    const allCookies = await page.cookies(
      "https://www.instagram.com",
      "https://i.instagram.com",
      "https://instagram.com",
    ) as Array<{ name: string; value: string }>;
    const cookieStrings = allCookies.map(c => `${c.name}=${c.value}`);

    log(
      `${logPfx} Harvest result: mid=${mid ? mid.slice(0, 8) + "..." : "(none)"}` +
      ` ig_did=${ig_did ? ig_did.slice(0, 8) + "..." : "(none)"}` +
      ` csrftoken=${csrftoken ? csrftoken.slice(0, 8) + "..." : "(none)"}` +
      ` total_cookies=${cookieStrings.length}`
    );

    if (!mid && !ig_did) {
      log(`${logPfx} No IG device cookies harvested — harvest failed`);
      return null;
    }

    return { mid, ig_did, csrftoken, cookieStrings, ebUserAgent: effectiveUA };
  } finally {
    try { await browser.close(); } catch {}
    try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch {}
    log(`${logPfx} Temporary Chrome closed and data dir cleaned up`);
  }
}

// Returns the existing Puppeteer Browser for a profile if an EB session is
// already running, or null if the EB has never been opened for this profile.
// The cookie baker uses this to open a new background tab instead of spawning
// a second Chrome process — avoids launch failures and resource waste.
export function getSessionChallengeUrl(profileId: number): string | null {
  return sessions.get(profileId)?.challengeUrl ?? null;
}

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
  ws: WebSocket | null; // WebSocket client — null when no client is connected
  frameLoop: ReturnType<typeof setInterval> | null; // kept for backward compat — always null now
  // Dedicated CDP session used exclusively for Page.startScreencast so that
  // screencast frames are pushed on a separate CDP message queue from the one
  // used for user input (clicks, typing, navigate). Chrome serialises commands
  // within a single session, so keeping frame delivery on its own session means
  // a slow or large JPEG frame can never delay a click command.
  screencastCdp: any | null;
  // Lightweight housekeeping interval — cookie save, popup dismiss, keep-alive
  // ping and error-page recovery. No screenshots taken here; all frame delivery
  // is handled by the screencast session above.
  housekeepLoop: ReturnType<typeof setInterval> | null;
  // Epoch ms of the last frame received from the screencast session.
  // The housekeep crash detector uses this to identify a frozen renderer.
  lastScreencastFrameAt: number;
  // Epoch ms when the most recent Page.startScreencast command succeeded.
  // Used by the watchdog to decide whether a frame has arrived since start.
  screencastStartedAt?: number;
  lastUrl: string;
  proxyKey: string; // "direct" or "host:port" — used to detect proxy changes
  userAgent: string; // profile's userAgentEmbedded — applied to every page/popup
  pendingInitUrl?: string; // set by getOrCreateSession, consumed by attachSSE on first connect
  // Timestamp (ms) until which the housekeep error-page auto-retry is suppressed.
  // Set whenever an intentional goto() is fired so the loop doesn't race against it.
  navProtectedUntil?: number;
  // True while browserAutoLogin is executing — suppresses the crash detector so
  // the page isn't destroyed mid-login causing a false ok:false result.
  autoLoginInProgress?: boolean;
  // ms timestamp of the most recent successful autoLogin.
  lastLoginSuccessAt?: number;
  // Unique token per session instance. autoLogin captures this at start and checks
  // it before returning ok:true — if the session was replaced (clearSession pressed
  // while login was in progress) the token will differ and the stale loginDone
  // event is suppressed, preventing a false-positive "✅ Login successful" on the
  // newly-launched Chrome session.
  sessionToken: symbol;
  // Set when a security-challenge redirect (update_risky_contactpoint, /challenge/,
  // /suspended) is detected by the response interceptor. autoLogin reads this before
  // attempting a fresh credential submission — if set it returns an error immediately
  // without clearing cookies or re-submitting credentials, preventing the hammering
  // loop that causes Instagram to deepen the security lock on every retry.
  challengeUrl?: string;
  // Set to true after one manual CDP redirect-follow attempt so we don't loop.
  challengeManualFollowAttempted?: boolean;
  // ms timestamp of the last user input (click, scroll, key, mousemove, navigate).
  lastActivityAt: number;
}

// Challenge URLs from IgCheckpointError — set by the verify route, consumed by getOrCreateSession
// Converts mobile API URL (i.instagram.com) → desktop web URL (www.instagram.com) for the browser
const checkpointUrlCache = new Map<number, string>();
export function setCheckpointUrl(profileId: number, mobileOrWebUrl: string) {
  const webUrl = mobileOrWebUrl.replace("https://i.instagram.com", "https://www.instagram.com");
  checkpointUrlCache.set(profileId, webUrl);
}

function wsWrite(ws: WebSocket | null, data: object) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(data)); } catch {}
}

const sessions = new Map<number, Session>();
const pendingFileChoosers = new Map<number, any>(); // profileId → FileChooser

// ── Graceful shutdown: save all open EB sessions before the process exits ────
// Without this, cookies are only saved on navigation events and every 60s in
// the frame loop. If the app is closed between ticks (or Instagram rotated the
// sessionid during the session), the JSON file on disk is stale and the account
// appears logged out on next open — even with a static proxy.
async function saveAllSessionsAndExit(signal: string) {
  const ids = [...sessions.keys()];
  if (ids.length) {
    log(`[shutdown] ${signal} received — saving cookies for ${ids.length} open EB session(s) before exit`, "browser");
    await Promise.allSettled(ids.map(async (id) => {
      const s = sessions.get(id);
      if (s?.page) {
        try { await saveCookies(id, s.page); } catch {}
      }
    }));
    log(`[shutdown] Cookie save complete — exiting`, "browser");
  }
  process.exit(0);
}
process.on("SIGTERM", () => saveAllSessionsAndExit("SIGTERM"));
process.on("SIGINT",  () => saveAllSessionsAndExit("SIGINT"));

// ── Global EB health log — fires every 30 s whenever any session is open ──────
// Logs: session count, per-session frame age, WS state, screencast state.
// This is the primary diagnostic for freeze issues — shows exactly which
// sessions are delivering frames and which are stuck.
setInterval(() => {
  if (!sessions.size) return;
  const now = Date.now();
  const lines = [...sessions.entries()].map(([id, s]) => {
    const frameAgeSec = s.lastScreencastFrameAt ? ((now - s.lastScreencastFrameAt) / 1000).toFixed(1) : "never";
    const wsState = s.ws ? ["CONNECTING","OPEN","CLOSING","CLOSED"][s.ws.readyState] ?? s.ws.readyState : "none";
    const hasScreencast = !!s.screencastCdp;
    const idleSec = ((now - s.lastActivityAt) / 1000).toFixed(0);
    return `  id=${id} ws=${wsState} screencast=${hasScreencast} frameAge=${frameAgeSec}s idle=${idleSec}s`;
  });
  log(`[EB-HEALTH] open=${sessions.size}\n${lines.join("\n")}`, "browser");
}, 30000);

// Global screenshot concurrency limiter. With many Chrome instances all taking
// screenshots simultaneously, the Node.js event loop and CPU saturate, causing
// all EBs to freeze. Cap concurrent screenshot operations — sessions that hit
// the limit skip that tick and retry on the next tick, spreading the load.
// The primary freeze prevention is the activity-based frame rate (see startFrameLoop):
// idle/dormant EBs only fire every 8th–20th tick, so in practice ≤2–3 sessions
// compete for slots at any given moment even when 25+ EBs are open.
// Raised from 4 → 6 to match the higher session count made possible by the
// memory-optimisation flags and background media blocking.
let globalScreenshotCount = 0;
const MAX_CONCURRENT_SCREENSHOTS = 6;

// ── EB launch concurrency limiter ──────────────────────────────────────────
// Launching Chrome is expensive: each instance peaks at ~80–150 MB and spikes
// the CPU for 2–4 s during V8 JIT warmup.  When 10+ EBs are opened at once
// they all race through puppeteer.launch() simultaneously, saturating the CPU
// and causing some instances to never complete their init → frozen EBs.
// Limit concurrent Chrome launches to avoid saturating the CPU during startup.
// 10 is safe for normal desktop use (manually verifying a handful of accounts
// simultaneously) while still preventing runaway parallelism if the user bulk-
// verifies dozens of accounts at once.
let ebLaunchCount = 0;
const MAX_CONCURRENT_EB_LAUNCHES = 10;

function waitForEbLaunchSlot(): Promise<void> {
  return new Promise(resolve => {
    const tryAcquire = () => {
      if (ebLaunchCount < MAX_CONCURRENT_EB_LAUNCHES) {
        ebLaunchCount++;
        resolve();
      } else {
        setTimeout(tryAcquire, 500);
      }
    };
    tryAcquire();
  });
}

// Mark a session as "recently active". Called by every input handler.
// The frame loop reads lastActivityAt to decide the screenshot cadence:
//   active  (<3 s since input) → every tick    (~6.7 fps)
//   idle    (3–30 s)           → every 8th tick (~0.8 fps)
//   dormant (>30 s)            → every 20th tick (~0.33 fps)
// Background EBs therefore consume almost no screenshot slots, leaving the
// active one to run at full speed regardless of how many EBs are open.
function touchActivity(profileId: number) {
  const s = sessions.get(profileId);
  if (s) s.lastActivityAt = Date.now();
}

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
  // Disable GPU hardware acceleration — forces software rendering instead.
  // Do NOT also add --disable-software-rasterizer: that kills the software
  // fallback too, leaving Chrome with no rendering path and causing freezes.
  "--disable-gpu",

  // ── Memory & process-count optimisations (allows 25+ concurrent EBs) ──────────
  //
  // By default each Chrome instance spawns 4–6 OS processes (browser, renderer,
  // GPU, network service, audio service, etc.) and uses ~300–500 MB RAM.  With
  // 25 accounts open simultaneously that is 7–12 GB — far beyond server limits.
  //
  // The flags below cut each instance down to ~2 processes and ~80–150 MB,
  // matching Jarvee's resource profile for large multi-account setups.

  // Cap the V8 JS heap to 128 MB per renderer (default can grow to 1.5 GB).
  // Instagram's web app runs fine within this limit for cookie/session use.
  "--js-flags=--max-old-space-size=128",

  // Limit Chrome to 1 renderer process per browser instance.
  // We only ever have a single tab, so this is always safe and eliminates
  // the spare renderer processes Chrome spawns speculatively.
  "--renderer-process-limit=1",

  // Kill on-disk caches — the EB is ephemeral and cookies are persisted
  // separately.  The defaults (~350 MB disk cache + ~150 MB media cache)
  // just burn disk and inflate the process working-set.
  "--disk-cache-size=8388608",   // 8 MB
  "--media-cache-size=1",        // effectively zero

  // Run the audio service in-process (one less spawned process).
  // NOTE: site-per-process and IsolateOrigins are intentionally NOT disabled —
  // removing those flags causes renderer crashes in Chrome 120+ on Windows.
  "--disable-features=AudioServiceOutOfProcess",

  // Aggressively free cached data under memory pressure instead of holding it.
  "--aggressive-cache-discard",

  // Disable spell-checking, translation, and other background services that
  // consume memory and occasionally spawn helper processes.
  "--disable-features=Translate,OptimizationHints,MediaRouter",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-breakpad",
  "--disable-client-side-phishing-detection",

  // ── WebRTC IP-leak prevention ───────────────────────────────────────────────
  // Without these flags Chrome's WebRTC stack sends UDP STUN requests directly
  // to Google's STUN servers (bypassing the HTTP proxy) and includes the real
  // host IP in ICE candidates.  Instagram's login JS can call
  //   new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]})
  // and harvest local/server IPs from onicecandidate events, exposing the Replit
  // server address instead of the proxy IP — a hard fingerprint mismatch.
  // "disable_non_proxied_udp" blocks all UDP unless it flows through a
  // configured proxy (which HTTP/SOCKS proxies don't forward UDP through, so in
  // practice WebRTC gets no ICE candidates and reveals nothing).
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--force-webrtc-ip-handling-policy",
];

// Chromium executable — resolved from env (set by Electron main on Windows via
// findChromiumPath which locates Chrome/Edge/Brave) or puppeteer's bundled Chrome (Linux dev).
// The browser runs headless (completely invisible) with an isolated --user-data-dir
// so it never touches the user's personal browser profile.
function resolvePuppeteerChromePath(): string {
  try {
    // puppeteer (full package) ships with its own downloaded Chrome — use it directly.
    // This avoids depending on a Nix store path that changes with every Chromium update.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pup = require("puppeteer");
    if (typeof pup.executablePath === "function") {
      const p = pup.executablePath();
      if (p) return p;
    }
  } catch {}
  return "";
}

const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ||
  resolvePuppeteerChromePath();

// Detect whether a UA string represents a mobile Chrome Android browser.
// Used to decide which fingerprint values to spoof — mobile and desktop
// have completely different screen, touch, and platform signals.
function isMobileUA(ua: string): boolean {
  return /Android/i.test(ua) && /Mobile Safari/i.test(ua);
}

// Build the User-Agent Client Hints metadata object for Puppeteer's setUserAgent().
// This overrides the Sec-CH-UA-* HTTP request headers that Chrome automatically
// sends based on the REAL OS — without this, Chrome sends Sec-CH-UA-Platform: "Linux"
// and Sec-CH-UA-Mobile: ?0 even when the UA string says Android/mobile, which is
// the primary signal Instagram uses to detect non-mobile browsers.
function buildUAMetadata(ua: string): object | undefined {
  if (!isMobileUA(ua)) return undefined;

  const chromeFull = ua.match(/Chrome\/([\d.]+)/)?.[1] ?? "120.0.0.0";
  const chromeMajor = chromeFull.split(".")[0];
  // Android section: "Android 13; XT2343-1" → version="13", model="XT2343-1"
  const androidMatch = ua.match(/Android\s+([\d.]+);\s*([^)]+)\)/);
  const androidVersion = androidMatch?.[1] ?? "13";
  // Strip "Build/XXXX" suffix some Samsung / OEM UAs include in the model field
  const model = (androidMatch?.[2]?.replace(/\s+Build\/\S+$/, "").trim()) ?? "";

  return {
    brands: [
      { brand: "Not/A)Brand",   version: "8"          },
      { brand: "Chromium",      version: chromeMajor  },
      { brand: "Google Chrome", version: chromeMajor  },
    ],
    fullVersionList: [
      { brand: "Not/A)Brand",   version: "8.0.0.0"   },
      { brand: "Chromium",      version: chromeFull   },
      { brand: "Google Chrome", version: chromeFull   },
    ],
    platform:        "Android",
    platformVersion: androidVersion.includes(".") ? `${androidVersion}.0` : `${androidVersion}.0.0`,
    architecture:    "",
    model,
    mobile:          true,
    bitness:         "",
    wow64:           false,
  };
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
  const meta = buildUAMetadata(userAgent) as any;

  await page.evaluateOnNewDocument((mobile: boolean, meta: any) => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });

    // ── WebRTC IP-leak prevention (JS layer) ────────────────────────────────
    // Belt-and-suspenders on top of the --webrtc-ip-handling-policy Chrome flag.
    // Overriding RTCPeerConnection in JS ensures no page script can enumerate
    // ICE candidates that would expose the real server IP address.
    // We replace it with a constructor that silently produces an unusable peer
    // connection — enough that the API exists (avoiding TypeError detection) but
    // that never fires onicecandidate with a local address.
    try {
      const _RTCPeerConnection = (window as any).RTCPeerConnection;
      if (_RTCPeerConnection) {
        (window as any).RTCPeerConnection = function (this: any, ...args: any[]) {
          const pc = new _RTCPeerConnection(...args);
          const origCreateOffer = pc.createOffer.bind(pc);
          pc.createOffer = (...offerArgs: any[]) => {
            // createOffer without an onicecandidate handler set to avoid leaks;
            // swallow ICE candidates before they reach userland.
            pc.onicecandidate = null;
            return origCreateOffer(...offerArgs);
          };
          return pc;
        } as any;
        (window as any).RTCPeerConnection.prototype = _RTCPeerConnection.prototype;
      }
    } catch { /* non-fatal */ }

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
      // devicePixelRatio for a 420 dpi phone = 420/160 = 2.625
      Object.defineProperty(window, "devicePixelRatio",       { get: () => 2.625 });

      // Spoof navigator.userAgentData (JS-accessible User-Agent Client Hints API).
      // CDP setUserAgent with metadata fixes HTTP headers; this fixes JS queries.
      if (meta && "userAgentData" in navigator) {
        try {
          const uaData = {
            brands:   meta.brands,
            mobile:   true,
            platform: "Android",
            getHighEntropyValues: (hints: string[]) => Promise.resolve({
              brands:          meta.brands,
              fullVersionList: meta.fullVersionList,
              mobile:          true,
              platform:        "Android",
              platformVersion: meta.platformVersion,
              architecture:    meta.architecture,
              bitness:         meta.bitness,
              model:           meta.model,
              uaFullVersion:   (meta.fullVersionList?.[2]?.version) ?? "",
              wow64:           false,
            }),
            toJSON: () => ({ brands: meta.brands, mobile: true, platform: "Android" }),
          };
          Object.defineProperty(navigator, "userAgentData", { get: () => uaData });
        } catch { /* non-fatal — some pages may freeze the property */ }
      }
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
  }, mobile, meta);
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
  // ── Pre-flight proxy check ──────────────────────────────────────────────────
  // A dead proxy causes Chrome's renderer to hang completely — the page shows
  // chrome-error:// and even Puppeteer screenshots time out. Test reachability
  // before launching so we fail fast instead of spending 40 s in a crash loop.
  if (proxy) {
    const proxyCheck = await testProxyReachable(proxy.host, proxy.port, 6000);
    if (!proxyCheck.ok) {
      const errMsg = `Proxy ${proxy.host}:${proxy.port} is unreachable (${proxyCheck.errorCode ?? "unknown"}) — not launching Chrome to avoid renderer freeze. Will retry on next open.`;
      log(`[proxy-check:${profileId}] ${errMsg}`, "browser");
      throw new Error(errMsg);
    }
    log(`[proxy-check:${profileId}] Proxy ${proxy.host}:${proxy.port} reachable ✓`, "browser");
  }

  const proxyArg = proxy ? [`--proxy-server=${proxy.host}:${proxy.port}`] : [];

  // Each session gets its OWN isolated user-data-dir so Chrome never reuses or
  // touches any existing browser session on the machine.
  const userDataDir = path.join(COOKIES_DIR, `userdata-${profileId}`);
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

  // ── Purge Chrome singleton lock files from a previous crashed session ────────
  // When Chrome is force-killed (timeout, Electron restart, OS kill) it does NOT
  // clean up SingletonLock / SingletonSocket / SingletonCookie in its userDataDir.
  // The next launch then fails with "The browser is already running for <path>".
  // We delete those three files unconditionally before every launch — if Chrome
  // is genuinely running they will be recreated immediately; if it crashed they
  // are stale orphans and must be removed.
  const CHROME_LOCK_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
  for (const lockFile of CHROME_LOCK_FILES) {
    const lockPath = path.join(userDataDir, lockFile);
    try {
      if (fs.existsSync(lockPath)) {
        fs.rmSync(lockPath, { force: true });
        console.log(`[EB-DEBUG][browserSession] Removed stale lock file: ${lockPath}`);
      }
    } catch (e: any) {
      console.warn(`[EB-DEBUG][browserSession] Could not remove lock file ${lockPath} (non-fatal): ${e?.message}`);
    }
  }

  const fullArgs = [...LAUNCH_ARGS, ...userDataArg, ...proxyArg];
  console.log(`[EB-DEBUG][browserSession] launching via ${puppeteerSource}, executablePath="${CHROMIUM_PATH}"`);
  console.log(`[EB-DEBUG][browserSession] launch args: ${fullArgs.join(" ")}`);

  // Throttle concurrent Chrome launches to avoid CPU saturation.
  await waitForEbLaunchSlot();
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
  } finally {
    ebLaunchCount--;
  }

  const [page] = await browser.pages();
  const uaMeta = buildUAMetadata(userAgent);
  await (uaMeta ? page.setUserAgent(userAgent, uaMeta as any) : page.setUserAgent(userAgent));
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

  // Enable request interception so we can block heavy media resources for
  // background sessions (no SSE viewer connected).  Instagram loads dozens of
  // high-res images on every page; blocking them when the user isn't watching
  // cuts per-session RAM by 60–80 % and is the single biggest win for running
  // 20+ concurrent EBs without crashing.
  await page.setRequestInterception(true);

  // Auto-dismiss cookie banners + post-login popups + save cookies on every main-frame navigation
  page.on("framenavigated", async (frame) => {
    if (frame !== page.mainFrame()) return;
    // Extend navProtectedUntil so the crash detector doesn't fire while Chrome is
    // mid-navigation — BUT skip this for chrome-error:// pages (ERR_TOO_MANY_REDIRECTS
    // etc.).  If we extend navProtectedUntil when an error page loads, the error-page
    // recovery check in the frame loop is blocked for 12 s and misses its one-shot
    // tick-15 window, leaving the browser permanently stuck on the error screen.
    const sNav = sessions.get(profileId);
    const navUrl = frame.url();
    log(`[nav:${profileId}] framenavigated → ${navUrl}`, "browser");
    if (sNav && !navUrl.startsWith("chrome-error://")) {
      sNav.navProtectedUntil = Math.max(sNav.navProtectedUntil ?? 0, Date.now() + 12000);
    } else if (sNav && navUrl.startsWith("chrome-error://")) {
      // Set a 30-second cooldown instead of clearing to 0.
      // Setting navProtectedUntil = 0 was designed to make error recovery fire
      // quickly after chrome-error, but it caused a tight refresh loop for banned
      // accounts: error recovery navigates to login → ban redirect → chrome-error →
      // navProtectedUntil = 0 → error recovery fires again in 5 s → repeat.
      // A 30-second cooldown still allows recovery but breaks the spin loop.
      sNav.navProtectedUntil = Date.now() + 30000;
    }
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

  // ── Redirect-chain debug + Instagram challenge detection ─────────────────
  // framenavigated only fires on committed navigations. This catches every 3xx
  // so we can see the full chain and detect security challenges before the loop.
  // Stored on the session object (not a local) so autoLogin can read it and bail
  // out immediately instead of clearing cookies and re-submitting credentials.
  page.on("response", (res) => {
    const status = res.status();
    if (status >= 300 && status < 400) {
      const loc = res.headers()["location"] ?? "(no location)";
      log(`[redirect:${profileId}] ${status} ${res.url().slice(0, 120)} → ${loc.slice(0, 120)}`, "browser");
      // Capture Instagram security-challenge URLs (update_risky_contactpoint,
      // checkpoint, challenge) so autoLogin can bail without re-submitting creds.
      const fullLoc = loc.startsWith("http") ? loc : `https://www.instagram.com${loc}`;
      const challengeStatus = classifyEbChallengeUrl(fullLoc);
      if (challengeStatus) {
        const s = sessions.get(profileId);
        if (s && !s.challengeUrl) {
          s.challengeUrl = fullLoc;
          log(`[challenge:${profileId}] Security challenge detected (${challengeStatus}) → ${fullLoc.slice(0, 120)}`, "browser");
          sendStatus(profileId, `⚠ Instagram security check required — navigating to challenge page…`);
          // Write the real status to DB immediately so the account card reflects
          // what the EB is actually showing — don't wait for the user to click Verify.
          // Never overwrite a manually-stopped account via the EB challenge detector.
          storage.getProfile(profileId).then(p => {
            if (p?.accountStatus !== "stopped") {
              storage.updateProfile(profileId, { accountStatus: challengeStatus }).catch(() => {});
            }
          }).catch(() => {});
        }
      }
    }
  });
  page.on("requestfailed", (req) => {
    const err = req.failure()?.errorText ?? "unknown";
    const url = req.url();
    if (url.includes("instagram.com") || url.startsWith("chrome-error")) {
      log(`[reqfail:${profileId}] ${err} — ${url.slice(0, 120)}`, "browser");
    }
    // When ERR_TOO_MANY_REDIRECTS fires for a challenge account, Chrome hit its
    // 20-redirect hard limit.  The challenge URL (update_risky_contactpoint) keeps
    // redirecting to itself with a fresh challenge_context token on every hop.
    // Fix: use CDP Fetch interception to follow each hop as an independent goto(),
    // resetting Chrome's internal counter on every hop so we can follow as many
    // hops as needed.  Only attempt this once per session; if it fails, park.
    const sc = sessions.get(profileId);
    if (err === "net::ERR_TOO_MANY_REDIRECTS" && sc?.challengeUrl) {
      if (sc.challengeManualFollowAttempted) {
        // Already tried — leave Chrome on chrome-error; the housekeep keepalive
        // will restart the screencast every 50 s so the frozen overlay never fires.
        sc.navProtectedUntil = Date.now() + 3600_000;
        log(`[challenge:${profileId}] manual redirect-follow already attempted, leaving parked on chrome-error.`, "browser");
        sendStatus(profileId, `⚠ Instagram verification page could not load. Open this link in your own browser: ${sc.challengeUrl}`);
        return;
      }
      sc.challengeManualFollowAttempted = true;
      sc.navProtectedUntil = Date.now() + 120_000; // block other handlers while we work
      log(`[challenge:${profileId}] ERR_TOO_MANY_REDIRECTS — starting manual CDP redirect-follow from: ${sc.challengeUrl.slice(0, 100)}`, "browser");
      sendStatus(profileId, `⚠ Instagram verification required. Attempting to load the challenge page…`);
      followChallengeRedirects(profileId, page, sc.challengeUrl).then(ok => {
        const s2 = sessions.get(profileId);
        if (!s2) return;
        if (ok) {
          s2.navProtectedUntil = Date.now() + 30_000;
          log(`[challenge:${profileId}] challenge page loaded successfully via manual redirect-follow`, "browser");
          sendStatus(profileId, `⚠ Instagram verification required. Complete the check shown in the browser window.`);
        } else {
          s2.navProtectedUntil = Date.now() + 3600_000;
          log(`[challenge:${profileId}] manual redirect-follow failed — leaving parked on chrome-error (keepalive will restart screencast)`, "browser");
          sendStatus(profileId, `⚠ Instagram requires verification for this account. Open this link in your browser to complete it: ${s2.challengeUrl} — After finishing the check, click Clear EB Session here to reset and log back in.`);
        }
      }).catch(() => {
        const s2 = sessions.get(profileId);
        if (s2) {
          s2.navProtectedUntil = Date.now() + 3600_000;
        }
      });
    }
  });

  page.on("request", (req) => {
    if (isIgApiCall(req.url())) {
      pending.set(req.url(), { startMs: Date.now(), method: req.method() });
    }

    // ── Background media blocking ─────────────────────────────────────────────
    // When no SSE viewer is connected, abort image / media / font requests.
    // Instagram loads 50–100 images per page visit; each one sits in Chrome's
    // memory even when the EB is just idling in the background.  Blocking them
    // drops per-session RAM from ~300 MB to ~80 MB, making 25+ concurrent EBs
    // viable.  When the user opens the session (res becomes non-null) Chrome
    // re-requests anything it needs for the current viewport automatically.
    const s = sessions.get(profileId);
    const hasViewer = !!(s?.ws && s.ws.readyState === WebSocket.OPEN);
    if (!hasViewer) {
      const rType = req.resourceType();
      if (rType === "image" || rType === "media" || rType === "font") {
        req.abort("blockedbyclient").catch(() => {});
        return;
      }
    }

    req.continue().catch(() => {});
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

  const session: Session = { browser, page, pages: [page], activePage: 0, ws: null, frameLoop: null, screencastCdp: null, housekeepLoop: null, lastScreencastFrameAt: Date.now(), lastUrl: "", proxyKey: newProxyKey, userAgent, sessionToken: Symbol(), lastActivityAt: Date.now() };
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
      const tMeta = buildUAMetadata(userAgent);
      await (tMeta ? newPage.setUserAgent(userAgent, tMeta as any) : newPage.setUserAgent(userAgent));
      await newPage.setViewport(viewportForUA(userAgent));
      await applyStealthScripts(newPage, userAgent);
      // Also intercept file choosers on any popup page
      (newPage as any).on("filechooser", (chooser: any) => {
        pendingFileChoosers.set(profileId, chooser);
        const s = sessions.get(profileId);
        if (s) wsWrite(s.ws, { type: "fileChooserNeeded" });
      });
    } catch { /* never crash on target creation */ }
  });

  // ── File chooser interception ─────────────────────────────────────────────
  // Puppeteer v24: 'filechooser' event fires whenever the page opens a file dialog.
  // We store the chooser and relay a "fileChooserNeeded" WS event to the frontend,
  // which shows a native <input type="file"> so the user can pick from their machine.
  (page as any).on("filechooser", (chooser: any) => {
    pendingFileChoosers.set(profileId, chooser);
    const s = sessions.get(profileId);
    if (s) wsWrite(s.ws, { type: "fileChooserNeeded" });
  });

  // ── Browser console log streaming ─────────────────────────────────────────
  page.on("console", (msg: any) => {
    const s = sessions.get(profileId);
    if (!s) return;
    const level: string = msg.type();
    const text: string = msg.text();
    if (!text || text.startsWith("[DOM]")) return; // skip noisy internal Chrome messages
    wsWrite(s.ws, { type: "consoleLog", level, text });
  });

  // ── Purge stale Chrome-profile cookies BEFORE loading our saved state ────────
  // Chrome's userDataDir persists between launches. It carries instagram.com
  // cookies from the previous session (expired sessionid, challenge tokens, etc.)
  // that conflict with our clean saved-cookie file and cause ERR_TOO_MANY_REDIRECTS
  // on the very first navigation. We use CDP to delete them now — before loadCookies
  // writes our known-good cookies — so Chrome starts from a clean slate.
  //
  // CRITICAL — preserve device-identity cookies (mid, ig_did, ig_nrcb, datr).
  // These are Instagram's persistent Machine ID / Device ID tokens. Deleting them
  // causes Instagram to assign new device IDs on the next request and fire
  // "Unrecognized device" security alerts. loadCookies() will restore them from
  // the saved JSON file immediately after, but we preserve them here as
  // defence-in-depth in case the JSON is absent or stale.
  // datr = Facebook/Instagram "device attribute token" — purging it causes the
  // update_risky_contactpoint challenge to redirect in an infinite loop because
  // Instagram cannot associate the challenge session with a known device.
  const DEVICE_COOKIE_NAMES_SET = new Set(["mid", "ig_did", "ig_nrcb", "datr"]);
  // ── Capture Chrome's own device tokens BEFORE loading the JSON file ─────────
  // Chrome writes device tokens to its userDataDir SQLite database in real-time
  // as Instagram issues Set-Cookie responses.  The JSON file is written by our
  // saveCookies() on a 60-second heartbeat — so in the window between ticks
  // (or after an ungraceful shutdown) the userDataDir copy is MORE CURRENT than
  // the JSON copy.  We save the userDataDir device tokens here and re-apply them
  // AFTER loadCookies() so they always override any potentially-stale JSON values.
  // Without this, loadCookies() would silently stamp a 60-second-old mid/datr
  // back in, and Instagram would see a device fingerprint mismatch on the next
  // login → "Unrecognised device" security text.
  let udirDeviceTokens: any[] = [];
  try {
    const staleCookies: any[] = await (page as any).cookies(
      "https://www.instagram.com",
      "https://i.instagram.com",
      "https://instagram.com",
    ).catch(() => []);
    if (staleCookies.length) {
      udirDeviceTokens = staleCookies.filter((c: any) => DEVICE_COOKIE_NAMES_SET.has(c.name));
      const sessionCookies = staleCookies.filter((c: any) => !DEVICE_COOKIE_NAMES_SET.has(c.name));
      if (sessionCookies.length) {
        await (page as any).deleteCookie(...sessionCookies).catch(() => null);
      }
      if (udirDeviceTokens.length) {
        await (page as any).setCookie(...udirDeviceTokens).catch(() => null);
      }
      const names = sessionCookies.map((c: any) => c.name).join(", ");
      log(`[cookies:${profileId}] Purged ${sessionCookies.length} stale session cookies before load (preserved device tokens: ${udirDeviceTokens.map((c: any) => c.name).join(", ") || "none"}): ${names}`, "browser");
    } else {
      log(`[cookies:${profileId}] No stale Chrome-profile cookies found — clean start`, "browser");
    }
  } catch (e: any) {
    log(`[cookies:${profileId}] Stale-cookie purge failed (non-fatal): ${e?.message}`, "browser");
  }

  // Determine the initial URL for this session.
  // We do NOT fire page.goto() here — that would race with attachSSE which is
  // called immediately after in the stream route, causing two concurrent gotos
  // on the same page (first gets cancelled by the second, leaving the page on
  // about:blank in some cases). Instead we store the target in session.pendingInitUrl
  // so attachSSE is the single source of truth for the initial navigation.
  const cookiesLoaded = await loadCookies(profileId, page);

  // ── Re-apply Chrome's userDataDir device tokens on top of the JSON load ─────
  // loadCookies() just called page.setCookie() for every cookie in the JSON file,
  // including device tokens.  If those JSON values were stale (the JSON was
  // written before Chrome last received a Set-Cookie for mid/datr), they would
  // overwrite Chrome's current values.  Stamping udirDeviceTokens back in now
  // ensures Chrome's OWN real-time values always take priority.
  if (udirDeviceTokens.length && cookiesLoaded) {
    try {
      await (page as any).setCookie(...udirDeviceTokens).catch(() => null);
      // Log any divergence so it's visible in the browser logs
      const jsonRaw = (() => { try { const p = cookiePath(profileId); return require("fs").existsSync(p) ? JSON.parse(require("fs").readFileSync(p, "utf8")) : []; } catch { return []; } })();
      for (const uc of udirDeviceTokens) {
        const jc = jsonRaw.find((c: any) => c.name === uc.name);
        if (jc && jc.value !== uc.value) {
          log(`[cookies:${profileId}] ⚠ Device token divergence — ${uc.name}: JSON had ${jc.value.slice(0, 10)}… userDataDir has ${uc.value.slice(0, 10)}… (using userDataDir)`, "browser");
        }
      }
    } catch { /* non-fatal */ }
  }
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

export function detachWS(profileId: number, ws: WebSocket) {
  const session = sessions.get(profileId);
  if (!session || session.ws !== ws) return;
  session.ws = null;
  if (session.frameLoop) { clearInterval(session.frameLoop); session.frameLoop = null; }
  if (session.housekeepLoop) { clearInterval(session.housekeepLoop); session.housekeepLoop = null; }
  if ((session as any)._challengeKeepalive) { clearInterval((session as any)._challengeKeepalive); (session as any)._challengeKeepalive = null; }
  stopScreencast(profileId).catch(() => {});
  // Grace period: give the client 10 s to reconnect before killing Chrome.
  // Normal drops (network blips, Replit proxy resets, HMR updates) reconnect
  // within 3 s and reuse the live Chrome session — no relaunch needed.
  // If nothing reconnects after 10 s the user has closed the panel, so we
  // kill Chrome then to prevent zombie processes.
  if ((session as any)._detachTimer) clearTimeout((session as any)._detachTimer);
  (session as any)._detachTimer = setTimeout(() => {
    const s = sessions.get(profileId);
    if (!s || s.ws) return; // new WS connected — leave Chrome alive
    closeSession(profileId).catch(() => {});
  }, 10000);
}

export function attachWS(profileId: number, ws: WebSocket) {
  const session = sessions.get(profileId);
  if (!session) return;

  // Cancel any pending Chrome-kill timer from a previous detachWS — the client
  // reconnected within the grace window, so Chrome stays alive.
  if ((session as any)._detachTimer) {
    clearTimeout((session as any)._detachTimer);
    (session as any)._detachTimer = null;
  }

  // Close any existing WebSocket connection for this profile
  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    try { session.ws.close(); } catch {}
  }
  session.ws = ws;

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
        // If this account has an active Instagram challenge, do NOT navigate anywhere.
        // Navigating to instagram.com/ triggers the challenge redirect loop again
        // (ERR_TOO_MANY_REDIRECTS → chrome-error → attachWS → navigate → loop).
        // Leave the browser parked on chrome-error; the status bar already shows
        // the challenge URL for the user to open in their own browser.
        if (session.challengeUrl) {
          log(`[attachSSE:${profileId}] page is chrome-error but account has challenge — leaving parked, not navigating`, "browser");
          // Re-send the challenge URL message to the newly connected client so the
          // user sees it even after a WS reconnect (the original message is not buffered).
          const challengeMsg = `⚠ Instagram requires verification for this account. Open this link in your browser to complete it: ${session.challengeUrl} — After finishing the check, click Clear EB Session here to reset and log back in.`;
          setTimeout(() => {
            const s = sessions.get(profileId);
            if (s?.ws && s.ws.readyState === WebSocket.OPEN) wsWrite(s.ws, { type: "loginStatus", message: challengeMsg });
          }, 600);
        } else {
          // Reconnect after crash/error — recover by checking cookies.
          // IMPORTANT: page.cookies() with no args returns cookies for the CURRENT
          // page domain only. On chrome-error:// that returns nothing, which would
          // incorrectly send a just-logged-in account back to the login page.
          // Use explicit domain fetch instead, and also honour lastLoginSuccessAt.
          const igCookies = await session.page.cookies("https://www.instagram.com").catch(() => [] as any[]);
          const hasCookies = igCookies.some((c: any) => c.name === "sessionid");
          const recentLogin = session.lastLoginSuccessAt ? (Date.now() - session.lastLoginSuccessAt) < 90000 : false;
          const target = (hasCookies || recentLogin)
            ? "https://www.instagram.com/"
            : "https://www.instagram.com/accounts/login/";
          session.navProtectedUntil = Date.now() + 15000;
          log(`[attachSSE:${profileId}] page is "${currentUrl}" (error/blank) — recovering → ${target}`, "browser");
          session.page.goto(target, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
        }
      }
      // else: user is actively browsing — leave them alone
    } catch { /* page may be closing — ignore */ }
  })();

  const nOpen = sessions.size;
  log(`[attachWS:${profileId}] WS attached — total open sessions=${nOpen}`, "browser");
  startScreencast(profileId).catch(() => {});
  startHousekeepLoop(profileId);

  // Challenge-parked accounts: the chrome-error page sends only ONE screencast frame
  // and then goes completely silent. The Replit proxy closes WebSocket connections
  // that carry no application data for ~4 s, causing a constant 4-second reconnect
  // loop. Fix: send a lightweight keepalive text message every 2.5 s so the proxy
  // never sees the WS as idle. The client silently ignores "keepalive" messages.
  if (session.challengeUrl) {
    if ((session as any)._challengeKeepalive) clearInterval((session as any)._challengeKeepalive);
    (session as any)._challengeKeepalive = setInterval(() => {
      const s = sessions.get(profileId);
      if (!s?.ws || s.ws.readyState !== WebSocket.OPEN) {
        clearInterval((session as any)._challengeKeepalive);
        (session as any)._challengeKeepalive = null;
        return;
      }
      wsWrite(s.ws, { type: "keepalive" });
    }, 2500);
  }
}

// ── Auto-login trigger ─────────────────────────────────────────────────────────
// Called by the WS route immediately after attachWS. Waits 3.5 s for the initial
// navigation to settle, then checks if Chrome is sitting on the login page. If so,
// fires browserAutoLogin automatically so the user never has to click the toolbar
// button — the form is filled and submitted without any manual action.
// Guards: session must still exist, no login already in progress, page must be on
// the login URL (not just any Instagram page).
export function scheduleAutoLogin(
  profileId: number,
  username: string,
  password: string,
  twoFAKey: string,
): void {
  setTimeout(() => {
    const s = sessions.get(profileId);
    if (!s || s.autoLoginInProgress) return;
    let url = "";
    try { url = s.page.url(); } catch { return; }
    if (!url.includes("accounts/login") && !url.includes("/login")) return;
    log(`[autoLogin:${profileId}] auto-trigger: login page detected after initial navigation`, "browser");
    browserAutoLogin(profileId, username, password, twoFAKey)
      .then(result => sendLoginDone(profileId, result.ok, result.message))
      .catch(err  => sendLoginDone(profileId, false, String(err)));
  }, 3500);
}

// ── CDP Screencast frame delivery ─────────────────────────────────────────────
// Chrome's Page.startScreencast API pushes JPEG frames from the compositor
// thread via a DEDICATED CDP session that is completely independent from the
// main page session used for user input (mouse.click, keyboard.type, evaluate).
//
// The old setInterval + page.screenshot() approach shared the main CDP session
// for both frames AND input. Because CDP is a serial message queue within a
// session, an in-flight screenshot (0–8 s when proxied) blocked every click and
// keystroke behind it. This was the root cause of browsers appearing "frozen"
// with 4+ EBs open: each had a screenshot in-flight, making every click wait
// up to 8 s for it to complete.
//
// With separate sessions Chrome processes them truly in parallel — a slow or
// large JPEG frame on the screencast session never delays an input command on
// the main session.
// Global serialization queue for Page.startScreencast calls.
// When multiple EBs open simultaneously, all their startScreencast calls would
// race to send CDP messages to Chrome at the same instant. Chrome uses a
// back-pressure protocol (sends frame → waits for ACK before next frame), so
// if Node's event loop is saturated processing 5+ simultaneous startScreencast
// round-trips, the ACKs for later frames arrive late → Chrome stalls → EB
// appears frozen until the user closes one and the loop drains.
// ── Manual challenge redirect follower ────────────────────────────────────────
// Chrome enforces a hard 20-redirect limit per navigation.  Instagram's
// update_risky_contactpoint challenge URL redirects to itself with a fresh
// challenge_context token on every hop — more than 20 times before resolving.
//
// Approach: follow the redirect chain entirely on the Node.js side (server-side
// HTTPS requests, no Chrome involvement) using the account's current IG cookies.
// Once we find the terminal URL (200 response), navigate Chrome directly to it
// with a single goto() — no redirect chain for Chrome to follow.
//
// Why server-side instead of CDP Fetch interception: after ERR_TOO_MANY_REDIRECTS,
// Chrome's internal state makes createCDPSession() hang indefinitely on the same
// page target, deadlocking the entire function.  Server-side HTTPS has no such
// issue.
function _httpGetOneHop(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; location?: string; setCookies: string[] }> {
  return new Promise((resolve, reject) => {
    let urlObj: URL;
    try { urlObj = new URL(url); } catch (e) { return reject(e); }

    const req = https.request(
      {
        method: "GET",
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname + urlObj.search,
        headers,
        rejectUnauthorized: false,
        // Instagram accumulates large Set-Cookie chains across many redirect
        // hops; 16 KB default overflows around hop 24.  128 KB gives plenty
        // of room for 80+ hops.
        maxHeaderSize: 131072,
      },
      (res) => {
        // Drain the body so the socket is released
        res.resume();
        const loc = Array.isArray(res.headers.location)
          ? res.headers.location[0]
          : res.headers.location;
        resolve({
          status: res.statusCode ?? 0,
          location: loc,
          setCookies: (res.headers["set-cookie"] as string[] | undefined) ?? [],
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(12_000, () => {
      req.destroy(new Error("_httpGetOneHop timed out"));
    });
    req.end();
  });
}


async function followChallengeRedirects(
  profileId: number,
  page: Page,
  startUrl: string,
): Promise<boolean> {
  const MAX_HOPS = 80;

  try {
    // Grab all current IG cookies from Chrome for this account
    const rawCookies = await page
      .cookies("https://www.instagram.com")
      .catch(() => [] as any[]);

    // Build cookie string and a mutable cookie map so Set-Cookie headers
    // from each hop are accumulated and forwarded to the next hop.
    const cookieMap = new Map<string, string>();
    for (const c of rawCookies as any[]) {
      cookieMap.set(c.name, c.value);
    }

    const makeHeaders = (): Record<string, string> => ({
      Cookie: [...cookieMap.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "X-IG-App-ID": "936619743392459",
    });

    let currentUrl = startUrl;

    for (let hop = 1; hop <= MAX_HOPS; hop++) {
      const result = await _httpGetOneHop(currentUrl, makeHeaders());

      // Accumulate any Set-Cookie headers for subsequent hops
      for (const sc of result.setCookies) {
        const eqIdx = sc.indexOf("=");
        if (eqIdx === -1) continue;
        const name = sc.slice(0, eqIdx).trim();
        const rest = sc.slice(eqIdx + 1);
        const val = rest.split(";")[0].trim();
        if (name) cookieMap.set(name, val);
      }

      log(
        `[challenge:${profileId}] server hop ${hop}: HTTP ${result.status} → ${(result.location ?? "").slice(0, 100)}`,
        "browser",
      );

      if (result.status >= 200 && result.status < 300) {
        // Found the final page.  Navigate Chrome to it directly — no redirect
        // chain for Chrome, so it won't hit the 20-hop limit.
        log(
          `[challenge:${profileId}] chain resolved in ${hop} hops — navigating Chrome to: ${currentUrl.slice(0, 100)}`,
          "browser",
        );
        await page
          .goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 20_000 })
          .catch(() => {});
        return true;
      }

      if (result.status >= 300 && result.status < 400 && result.location) {
        currentUrl = result.location.startsWith("http")
          ? result.location
          : `https://www.instagram.com${result.location}`;
        continue;
      }

      log(
        `[challenge:${profileId}] unexpected status ${result.status} on hop ${hop} — giving up`,
        "browser",
      );
      return false;
    }

    log(
      `[challenge:${profileId}] chain did not resolve in ${MAX_HOPS} hops — may be truly infinite`,
      "browser",
    );
    return false;
  } catch (err) {
    log(`[challenge:${profileId}] followChallengeRedirects error: ${err}`, "browser");
    return false;
  }
}

// Serializing startScreencast calls (one at a time, with the event loop free
// between them) prevents this starvation without any user-visible delay
// (each startScreencast takes ~10–50 ms in practice).
let _screencastStartQueue: Promise<void> = Promise.resolve();

async function startScreencast(profileId: number, _retry = 0): Promise<void> {
  const session = sessions.get(profileId);
  if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN) return;

  const nSessions = sessions.size;
  log(`[screencast:${profileId}] startScreencast called — sessions=${nSessions}`, "browser");

  // Stop any previously running screencast session first
  await stopScreencast(profileId);

  // Re-check WS after the async stopScreencast — it may have closed during the await.
  if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
    log(`[screencast:${profileId}] WS closed during stopScreencast — aborting`, "browser");
    return;
  }

  let cdp: any;
  const t0 = Date.now();
  try {
    // 20 s timeout: with 5+ Chrome instances the Puppeteer protocol queue can back
    // up, making createCDPSession hang for the full 30 s default. Failing fast
    // lets the retry path kick in sooner instead of stacking up hung calls.
    cdp = await Promise.race([
      (session.page as any).createCDPSession(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("createCDPSession timeout (20 s)")), 20000)),
    ]);
    log(`[screencast:${profileId}] createCDPSession OK (${Date.now() - t0}ms) — sessions=${nSessions}`, "browser");
  } catch (e: any) {
    log(`[screencast:${profileId}] createCDPSession FAILED after ${Date.now() - t0}ms (attempt ${_retry + 1}/4): ${e?.message}`, "browser");
    // Schedule a retry so the 5th+ EB doesn't get permanently stuck on "Loading…".
    // Without a retry there is no watchdog (screencastStartedAt was never set) and
    // waitingFirstFrame stays true until the 45 s fallback timeout fires.
    if (_retry < 3) {
      const retryDelay = [4000, 7000, 12000][_retry] ?? 12000;
      const sRetry = sessions.get(profileId);
      if (sRetry?.ws && sRetry.ws.readyState === WebSocket.OPEN) {
        log(`[screencast:${profileId}] scheduling retry #${_retry + 2} in ${retryDelay}ms`, "browser");
        setTimeout(() => startScreencast(profileId, _retry + 1).catch(() => {}), retryDelay);
      }
    }
    return;
  }
  session.screencastCdp = cdp;

  // Adaptive JPEG quality: reduce as session count grows to save bandwidth.
  const quality  = nSessions <= 2 ? 65 : nSessions <= 5 ? 55 : 45;
  // everyNthFrame MUST stay at 1.
  // Chrome uses software compositing (--disable-gpu). In software mode Chrome
  // only generates compositor frames when page content changes — a static page
  // may produce just 1 frame at startup. If nth>1, Chrome must accumulate N
  // frames before sending the first screencast frame; on an idle page it never
  // reaches N → no frame ever arrives → watchdog loops forever.
  // Steady-state load is controlled by the serialization queue below and the
  // back-pressure protocol (Chrome only sends the next frame after Node ACKs
  // the previous one — so there is at most 1 in-flight frame per session).
  const nthFrame = 1;

  // CRITICAL: Register the frame handler BEFORE sending Page.startScreencast.
  // Chrome's screencast uses a back-pressure protocol — it sends the first frame
  // immediately upon receiving startScreencast and will NOT send another until it
  // receives a Page.screencastFrameAck. If the handler is registered AFTER the
  // await, the very first frame arrives before the listener is active, the ACK is
  // never sent, and Chrome stalls permanently. This is the root cause of the
  // 4th+ EB "Loading…" hang — system load delays event-loop execution just long
  // enough for Chrome's first frame to slip through before cdp.on() runs.
  let firstFrameLogged = false;
  // Per-session timestamp of the last frame we actually forwarded to the WS.
  // Used by the throttle below — we always ACK every frame (Chrome needs that)
  // but only call wsWrite when the interval has elapsed.
  let lastForwardedMs = 0;
  cdp.on("Page.screencastFrame", (params: any) => {
    // ACK IMMEDIATELY (synchronously, no await) — Chrome back-pressures and
    // stops sending new frames until it receives the ack. Delaying the ack
    // would stall frame delivery.
    cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});

    const s = sessions.get(profileId);
    // Always update the timestamp even when no WS client — the crash detector
    // uses this to know Chrome is alive.
    const now = Date.now();
    if (s) s.lastScreencastFrameAt = now;

    if (!firstFrameLogged) {
      firstFrameLogged = true;
      log(`[screencast:${profileId}] first frame received (${params.data.length} chars)`, "browser");
    }

    if (!s?.ws || s.ws.readyState !== WebSocket.OPEN) return;

    // Frame-forwarding throttle — keeps the main-process event loop responsive.
    //
    // Problem: wsWrite() JSON-serialises a 50–150 KB base64 JPEG on every
    // frame.  With 4+ EBs each streaming at compositor speed the event loop
    // fills up with these large allocations, delaying HTTP handlers (clicks,
    // API calls) and making the entire UI appear frozen.
    //
    // Solution: scale the per-session forwarding interval with session count so
    // total WS writes stay ~20 fps regardless of how many EBs are open:
    //   1 EB  → 50 ms/frame  (20 fps)
    //   2 EBs → 100 ms/frame (10 fps each, 20 fps total)
    //   3 EBs → 150 ms/frame (6.7 fps each, 20 fps total)
    //   4 EBs → 200 ms/frame (5 fps each,  20 fps total)
    //   5 EBs → 250 ms/frame (4 fps each,  20 fps total)
    //
    // The ACK above is always sent, so Chrome never stalls — we just skip
    // the expensive JSON.stringify + WS send on skipped frames.
    const frameIntervalMs = Math.max(50, sessions.size * 50);
    if (now - lastForwardedMs < frameIntervalMs) return;
    lastForwardedMs = now;

    // page.url() is sync in Puppeteer — it reads from an internal frame cache,
    // no CDP round-trip.
    let currentUrl = s.lastUrl;
    try { currentUrl = s.page.url(); } catch {}

    wsWrite(s.ws, { type: "frame", data: params.data, url: currentUrl });

    if (currentUrl && currentUrl !== "about:blank" && currentUrl !== s.lastUrl) {
      s.lastUrl = currentUrl;
      wsWrite(s.ws, { type: "urlChange", url: currentUrl });
    }
  });

  // Serialize the Page.startScreencast CDP call through a global queue.
  // Without this, opening 5+ EBs simultaneously fires all startScreencast
  // calls at once. Chrome's back-pressure ACK protocol means Node must process
  // each ACK before Chrome sends the next frame — but if the event loop is
  // saturated servicing 5 simultaneous startScreencast round-trips, ACKs are
  // delayed, Chrome stalls on frame delivery, and the EB appears frozen.
  // Processing one startScreencast at a time (each takes ~10–50 ms) keeps the
  // event loop free between calls so ACKs are processed promptly.
  let startOk = true;
  const prevQueue = _screencastStartQueue;
  _screencastStartQueue = (async () => {
    // Wait for the previous queue entry but cap at 20 s.
    // Without a timeout a single hung cdp.send() in a previous entry would
    // permanently jam this promise chain, causing every subsequent EB to wait
    // forever and appear stuck on "Loading…".
    await Promise.race([prevQueue, new Promise(r => setTimeout(r, 20000))]);
    // Brief pause between consecutive starts: gives the Node.js event loop a
    // chance to drain any pending CDP callbacks (e.g. ACKs from a previously
    // started screencast) before we issue the next Page.startScreencast.
    // 150 ms is imperceptible to the user but enough for one full event-loop
    // cycle plus the first frame ACK round-trip.
    if (sessions.size > 1) await new Promise(r => setTimeout(r, 150));
    // Re-check session is still alive after waiting in queue
    const sNow = sessions.get(profileId);
    if (!sNow?.ws || sNow.ws.readyState !== WebSocket.OPEN) return;
    const t1 = Date.now();
    try {
      // 10 s timeout on Page.startScreencast: under heavy load Chrome can
      // fail to ACK this command indefinitely, jamming the global queue and
      // preventing all subsequent EBs from ever receiving frames.
      await Promise.race([
        cdp.send("Page.startScreencast", {
          format: "jpeg",
          quality,
          maxWidth: 1280,
          maxHeight: 760,
          everyNthFrame: nthFrame,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Page.startScreencast timeout (10 s)")), 10000)
        ),
      ]);
      log(`[screencast:${profileId}] Page.startScreencast ACKed in ${Date.now() - t1}ms (quality=${quality} nth=${nthFrame} sessions=${nSessions})`, "browser");
    } catch (e: any) {
      log(`[screencast:${profileId}] Page.startScreencast FAILED: ${e?.message}`, "browser");
      try { await Promise.race([cdp.detach(), new Promise(r => setTimeout(r, 3000))]); } catch {}
      sNow.screencastCdp = null;
      startOk = false;
    }
  })();
  await _screencastStartQueue;
  if (!startOk) return;

  // Record when this screencast started — the watchdog below uses this to detect
  // a stalled compositor (Chrome acknowledged startScreencast but never sent a frame).
  session.screencastStartedAt = Date.now();

  // Notify the client that the screencast pipeline is confirmed active.
  // This lets the frontend clear its "Loading…" overlay immediately rather than
  // waiting up to 45 s for the first real-content frame to arrive.
  const sAfter = sessions.get(profileId);
  if (sAfter?.ws && sAfter.ws.readyState === WebSocket.OPEN) {
    log(`[screencast:${profileId}] sending screencast_started to client`, "browser");
    wsWrite(sAfter.ws, { type: "screencast_started" });
  } else {
    log(`[screencast:${profileId}] WARNING: WS not open when sending screencast_started (ws=${!!sAfter?.ws} state=${sAfter?.ws?.readyState ?? "none"})`, "browser");
  }

  // ── Watchdog: auto-restart if Chrome never delivers a first frame ────────────
  // Under heavy CPU load (5+ simultaneous EBs), Chrome's software compositor can
  // stall and not produce any screencast frames even though Page.startScreencast
  // was acknowledged. The watchdog fires 8 s after start; if no frame has arrived
  // since the screencast started, it stops and restarts the screencast.
  const watchdogStartedAt = session.screencastStartedAt;
  setTimeout(() => {
    const s = sessions.get(profileId);
    // Only act if this is still the same screencast (not replaced by a later call)
    if (!s || s.screencastCdp !== cdp) return;
    if (s.lastScreencastFrameAt >= watchdogStartedAt) return; // frame arrived — all good
    log(`[screencast:${profileId}] watchdog: no frame in 8 s — restarting screencast`, "browser");
    stopScreencast(profileId).catch(() => {}).finally(() => {
      startScreencast(profileId).catch(() => {});
    });
  }, 8000);
}

async function stopScreencast(profileId: number): Promise<void> {
  const session = sessions.get(profileId);
  if (!session?.screencastCdp) return;
  const cdp = session.screencastCdp;
  session.screencastCdp = null;
  // Both CDP calls must have explicit timeouts — without them, a hung Chrome
  // process (dead proxy, crashed renderer) causes stopScreencast to hang forever,
  // which blocks startScreencast (called first) and then the global queue.
  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
    Promise.race([p, new Promise<undefined>(r => setTimeout(r, ms))]);
  try { await withTimeout(cdp.send("Page.stopScreencast"), 5000); } catch {}
  try { await withTimeout(cdp.detach(), 5000); } catch {}
}

// ── Lightweight housekeeping loop ─────────────────────────────────────────────
// Handles cookie save, popup dismissal, WS keep-alive ping, and error-page
// recovery — all on a slow 5-second tick. No screenshots taken here.
function startHousekeepLoop(profileId: number): void {
  const session = sessions.get(profileId);
  if (!session) return;

  if (session.housekeepLoop) { clearInterval(session.housekeepLoop); session.housekeepLoop = null; }

  let cookieSaveTick  = 0; // increments every 5s; save at 12 (=60s)
  let popupCheckTick  = 0; // increments every 5s; dismiss at 2 (=10s)
  let keepAliveTick   = 0; // increments every 5s; ping at 3 (=15s)
  let errorRecoveryTick = 0; // increments every 5s; check at 2 (=10s)

  session.housekeepLoop = setInterval(async () => {
    const s = sessions.get(profileId);
    if (!s || !s.ws || s.ws.readyState !== WebSocket.OPEN) {
      if (s?.housekeepLoop) { clearInterval(s.housekeepLoop); s.housekeepLoop = null; }
      return;
    }

    // ── WS keep-alive ──────────────────────────────────────────────────────
    keepAliveTick++;
    if (keepAliveTick >= 3) {
      keepAliveTick = 0;
      try { s.ws.ping(); } catch {}
    }

    // ── Popup dismissal ────────────────────────────────────────────────────
    popupCheckTick++;
    if (popupCheckTick >= 2) {
      popupCheckTick = 0;
      dismissInstagramPopups(s.page).catch(() => {});
    }

    // ── Cookie save ────────────────────────────────────────────────────────
    cookieSaveTick++;
    if (cookieSaveTick >= 12) {
      cookieSaveTick = 0;
      saveCookies(profileId, s.page).catch(() => {});
    }

    // ── Error-page recovery + challenge URL scan ───────────────────────────
    // Checks the current page URL on every other tick (every 10 s).
    // 1. If Chrome landed on chrome-error:// / about:blank, navigate back to login.
    // 2. If Chrome is on an Instagram challenge page that arrived via a 200 (not
    //    a 3xx redirect) — e.g. the user manually navigated to confirm_email —
    //    classify it and write the accountStatus to DB so the account card updates.
    errorRecoveryTick++;
    if (errorRecoveryTick >= 2) {
      errorRecoveryTick = 0;
      if (!s.autoLoginInProgress && Date.now() > (s.navProtectedUntil ?? 0)) {
        let url = "";
        try { url = s.page.url(); } catch {}
        const isErrorPage = url.startsWith("chrome-error://") || url === "about:blank" || url === "about:newtab";
        if (isErrorPage) {
          const msSinceLogin = s.lastLoginSuccessAt ? Date.now() - s.lastLoginSuccessAt : Infinity;
          if (msSinceLogin > 90000) {
            if (s.challengeUrl) {
              // The challenge URL loops indefinitely in Chrome — never navigate back
              // to Instagram.  BUT chrome-error:// sends no screencast frames after
              // the first one, which triggers the "Browser appears frozen" overlay.
              // Parking on about:blank keeps the screencast alive without triggering
              // the challenge redirect loop again.
              // Chrome stays on chrome-error; the keepalive block below restarts
              // the screencast every 50 s so the frozen overlay never fires.
              log(`[housekeep:${profileId}] challenge account on error/blank page — leaving parked`, "browser");
            } else {
              log(`[housekeep:${profileId}] error page detected (${url.slice(0, 60)}) — recovering to login (cookies preserved)`, "browser");
              s.navProtectedUntil = Date.now() + 20000;
              s.page.goto("https://www.instagram.com/accounts/login/", {
                waitUntil: "domcontentloaded", timeout: 25000,
              }).catch(() => null);
            }
          }
        } else if (url && !s.challengeUrl) {
          // Scan for challenge pages that were reached without a redirect
          // (e.g. confirm_email arriving as a 200, or the user pasting a URL).
          const detectedStatus = classifyEbChallengeUrl(url);
          if (detectedStatus) {
            s.challengeUrl = url;
            log(`[housekeep:${profileId}] challenge page detected via URL scan (${detectedStatus}): ${url.slice(0, 100)}`, "browser");
            sendStatus(profileId, `⚠ Instagram security check required on this account.`);
            storage.updateProfile(profileId, { accountStatus: detectedStatus }).catch(() => {});
          }
        }
      }
    }

    // ── Challenge-account screencast keepalive ─────────────────────────────
    // chrome-error:// sends one frame on startup then goes silent.  For accounts
    // parked there because of an Instagram challenge, we restart the screencast
    // every 50 s so Chrome delivers a fresh frame.  This resets the client's
    // stale-frame timer (60 s threshold) before it can fire the "Browser appears
    // frozen" overlay — no navigation needed, WS stays stable.
    if (s.challengeUrl && s.screencastCdp) {
      const silentMsKeepalive = Date.now() - s.lastScreencastFrameAt;
      if (silentMsKeepalive > 50000) {
        log(`[housekeep:${profileId}] challenge keepalive — restarting screencast (silent ${Math.round(silentMsKeepalive / 1000)}s)`, "browser");
        stopScreencast(profileId).catch(() => {}).finally(() => {
          startScreencast(profileId).catch(() => {});
        });
      }
    }

    // ── Crash detector ─────────────────────────────────────────────────────
    // Frame-silence heuristics are unreliable — Chrome stops pushing frames
    // the moment a page is fully static (nothing changed on screen), so any
    // threshold based on frame silence alone will fire whenever the user is
    // reading a static page.
    //
    // We use an active ping via the MAIN Puppeteer page session (page.evaluate).
    // IMPORTANT: do NOT ping via screencastCdp — under heavy load, queued
    // screencastFrameAck calls back up in that CDP session, making it appear
    // unresponsive even when Chrome itself is perfectly fine. Using the main
    // page session gives a true health check that is fully independent of the
    // screencast pipeline.
    //
    // If the ping confirms Chrome is alive but frames are still silent, that
    // means the screencast CDPSession has stalled — restart only the screencast,
    // not the whole browser. Only kill the session if Chrome itself is dead.
    //
    // We only run the ping when ALL of these hold:
    //   • The screencast CDP session is open (screencast was started)
    //   • The user was active 30–120 s ago (short enough to care, long enough
    //     that Chrome has had time to settle after the last click)
    //   • 60+ s have passed since the last screencast frame (clearly no activity)
    //   • Not mid-login and not mid-nav-protected window
    //   • No concurrent ping already in progress
    //   • Account is NOT in a parked challenge state (keepalive handles those)
    if (s.screencastCdp && !(s as any)._crashPingInProgress) {
      const idleMs   = Date.now() - s.lastActivityAt;
      const silentMs = Date.now() - s.lastScreencastFrameAt;
      if (idleMs > 30000 && idleMs < 120000 && silentMs > 60000
          && !s.autoLoginInProgress && Date.now() > (s.navProtectedUntil ?? 0)
          && !s.challengeUrl) {
        (s as any)._crashPingInProgress = true;
        // Ping via the main page session — completely independent of screencastCdp.
        // Use 15 s timeout: with 4+ Chrome instances the Node.js event loop is busy
        // processing ~100+ CDP frames/s, so page.evaluate() can wait >5 s for a
        // slot even when Chrome itself is perfectly healthy. 5 s caused frequent
        // false-positive "Retry" triggers on otherwise fine sessions.
        const pingStart = Date.now();
        const nAtPing = sessions.size;
        log(`[housekeep:${profileId}] crash-ping starting (idleMs=${idleMs} silentMs=${silentMs} sessions=${nAtPing})`, "browser");
        Promise.race([
          s.page.evaluate(() => 1).then(() => true),
          new Promise<boolean>(r => setTimeout(() => r(false), 15000)),
        ]).then(alive => {
          const pingMs = Date.now() - pingStart;
          (s as any)._crashPingInProgress = false;
          const sNow = sessions.get(profileId);
          if (!sNow || !sNow.ws || sNow.ws.readyState !== WebSocket.OPEN) return;
          if (!alive) {
            // Ping timed out. Before killing, check if this could be an event-loop
            // backlog false-positive (4+ sessions open). On first timeout, restart
            // the screencast CDPSession rather than killing Chrome outright — a
            // stalled CDPSession under load is far more common than a Chrome crash.
            const consecutiveTimeouts = ((sNow as any)._pingTimeouts ?? 0) + 1;
            (sNow as any)._pingTimeouts = consecutiveTimeouts;
            log(`[housekeep:${profileId}] crash-ping timed out in ${pingMs}ms (attempt ${consecutiveTimeouts}, sessions=${nAtPing})`, "browser");
            if (consecutiveTimeouts < 2) {
              // First timeout — restart screencast and give Chrome another chance.
              log(`[housekeep:${profileId}] first timeout — restarting screencast before giving up`, "browser");
              stopScreencast(profileId).catch(() => {}).finally(() => {
                startScreencast(profileId).catch(() => {});
              });
            } else {
              // Second consecutive timeout — Chrome is genuinely unresponsive.
              (sNow as any)._pingTimeouts = 0;
              const crashUrl = (() => { try { return sNow.page.url(); } catch { return "unknown"; } })();
              log(`[housekeep:${profileId}] second consecutive ping timeout on "${crashUrl.slice(0, 80)}" — closing session`, "browser");
              wsWrite(sNow.ws, { type: "error", message: "Browser page is unresponsive — likely a proxy issue. Click Retry to restart." });
              try { sNow.ws.close(); } catch {}
              sNow.ws = null;
              if (sNow.housekeepLoop) { clearInterval(sNow.housekeepLoop); sNow.housekeepLoop = null; }
              closeSession(profileId).catch(() => {});
            }
          } else {
            // Chrome is alive — reset consecutive timeout counter.
            (sNow as any)._pingTimeouts = 0;
            log(`[housekeep:${profileId}] crash-ping OK in ${pingMs}ms (sessions=${nAtPing})`, "browser");
            // Check whether the screencast CDPSession has stalled.
            const stillSilent = (Date.now() - sNow.lastScreencastFrameAt) > 20000;
            if (stillSilent && sNow.screencastCdp) {
              log(`[housekeep:${profileId}] Chrome alive but screencast silent — restarting screencast CDPSession`, "browser");
              stopScreencast(profileId).catch(() => {}).finally(() => {
                startScreencast(profileId).catch(() => {});
              });
            } else {
              // Chrome is alive and frames are flowing — reset the frame clock so
              // the next ping window starts fresh from now.
              sNow.lastScreencastFrameAt = Date.now();
            }
          }
        }).catch(() => { (s as any)._crashPingInProgress = false; });
      }
    }
  }, 5000);
}

export async function browserNavigate(profileId: number, url: string) {
  touchActivity(profileId);
  const s = sessions.get(profileId);
  if (!s) return;
  try {
    wsWrite(s.ws, { type: "loading", loading: true });
    s.navProtectedUntil = Date.now() + 35000;
    await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    wsWrite(s.ws, { type: "loading", loading: false });
  } catch {
    wsWrite(s.ws, { type: "loading", loading: false });
  }
}

// kickFrame is a no-op now that CDP screencast handles all frame delivery.
// Chrome's compositor automatically sends a new frame after any DOM change
// triggered by a click, so there's no need to request one explicitly.
// Kept as a stub so call-sites don't need to be updated.
function kickFrame(_profileId: number): Promise<void> {
  return Promise.resolve();
}

function sendTabsUpdate(profileId: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  const tabs = s.pages.map(p => {
    let url = "";
    try { url = p.url(); } catch {}
    return { url };
  });
  wsWrite(s.ws, { type: "tabsUpdate", tabs, active: s.activePage });
}

export async function browserClick(profileId: number, x: number, y: number) {
  touchActivity(profileId);
  const s = sessions.get(profileId);
  if (!s) return;
  // Fire raw mouse events first (gives visual hover/active feedback in the screenshot)
  await s.page.mouse.click(x, y);
  // Also dispatch a programmatic click via elementFromPoint — React SPAs and Instagram's
  // SPA often attach synthetic event listeners that don't respond to raw mouse events
  // alone (especially <a> tags handled by React Router and role="button" divs).
  await s.page.evaluate((cx, cy) => {
    const el = document.elementFromPoint(cx, cy) as HTMLElement | null;
    if (el) {
      // Walk up the DOM to find the nearest clickable ancestor if the target itself isn't interactive
      let target: HTMLElement | null = el;
      for (let i = 0; i < 5 && target; i++) {
        const tag = target.tagName?.toLowerCase();
        const role = target.getAttribute("role")?.toLowerCase();
        if (tag === "a" || tag === "button" || role === "button" || role === "link") {
          target.click();
          return;
        }
        target = target.parentElement;
      }
      el.click(); // fallback: click whatever was under the cursor
    }
  }, x, y).catch(() => null);
  kickFrame(profileId).catch(() => {});
}

export async function browserMouseMove(profileId: number, x: number, y: number) {
  touchActivity(profileId);
  const s = sessions.get(profileId);
  if (!s) return;
  await s.page.mouse.move(x, y);
}

export async function browserScroll(profileId: number, x: number, y: number, deltaX: number, deltaY: number) {
  touchActivity(profileId);
  const s = sessions.get(profileId);
  if (!s) return;
  // Fire the wheel event directly — mouse.move is unnecessary for page-level
  // scrolling and was halving throughput by adding an extra CDP round-trip.
  await s.page.mouse.wheel({ deltaX, deltaY });
}

export async function browserKeyDown(profileId: number, key: string) {
  touchActivity(profileId);
  const s = sessions.get(profileId);
  if (!s) return;
  // Map "Space" back to the actual key name Puppeteer expects
  const k = key === "Space" ? " " : key;
  try { await s.page.keyboard.press(k as any); } catch {}
}

export async function browserKeyUp(profileId: number, key: string) {
  touchActivity(profileId);
  const s = sessions.get(profileId);
  if (!s) return;
  const k = key === "Space" ? " " : key;
  try { await s.page.keyboard.up(k as any); } catch {}
}

export async function browserType(profileId: number, text: string) {
  touchActivity(profileId);
  const s = sessions.get(profileId);
  if (!s) return;
  await s.page.keyboard.type(text, { delay: 30 });
}

export async function browserKeyCombo(profileId: number, modifier: string, key: string) {
  touchActivity(profileId);
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
  wsWrite(s.ws, { type: "loading", loading: true });
  try { await s.page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }); } catch {}
  wsWrite(s.ws, { type: "loading", loading: false });
}

export async function browserForward(profileId: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  wsWrite(s.ws, { type: "loading", loading: true });
  try { await s.page.goForward({ waitUntil: "domcontentloaded", timeout: 10000 }); } catch {}
  wsWrite(s.ws, { type: "loading", loading: false });
}

export async function browserReload(profileId: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  wsWrite(s.ws, { type: "loading", loading: true });
  try { await s.page.reload({ waitUntil: "domcontentloaded", timeout: 10000 }); } catch {}
  wsWrite(s.ws, { type: "loading", loading: false });
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
    const tabMeta = buildUAMetadata(s.userAgent);
    await (tabMeta ? newPage.setUserAgent(s.userAgent, tabMeta as any) : newPage.setUserAgent(s.userAgent));
    // New tabs must use the same fixed 1280×760 canvas dimensions as the main page.
    // viewportForUA() returns mobile dimensions (e.g. 412×915 @ 2.625x scale) for
    // mobile UAs, which causes severe stretching when drawn onto the 1280×760 canvas.
    await newPage.setViewport({ width: 1280, height: 760 });
    await applyStealthScripts(newPage, s.userAgent);
    // File chooser interception for new tab
    (newPage as any).on("filechooser", (chooser: any) => {
      pendingFileChoosers.set(profileId, chooser);
      const sess = sessions.get(profileId);
      if (sess) wsWrite(sess.ws, { type: "fileChooserNeeded" });
    });
    newPage.on("console", (msg: any) => {
      const sess = sessions.get(profileId);
      if (!sess) return;
      const text: string = msg.text();
      if (!text || text.startsWith("[DOM]")) return;
      wsWrite(sess.ws, { type: "consoleLog", level: msg.type(), text });
    });
    s.pages.push(newPage);
    s.activePage = s.pages.length - 1;
    s.page = newPage;
    s.lastUrl = "";
    // Open blank — the user navigates via the address bar or the email shortcuts.
    // Previously this navigated to instagram.com which is wrong for extra tabs
    // (used to check email) and caused a stretched mobile-UA render on the desktop canvas.
    await newPage.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    sendTabsUpdate(profileId);
    // Screencast is tied to a specific page target — restart on the new tab.
    await stopScreencast(profileId).catch(() => {});
    startScreencast(profileId).catch(() => {});
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
  // Screencast is tied to a specific page target — restart it on the new page.
  await stopScreencast(profileId).catch(() => {});
  startScreencast(profileId).catch(() => {});
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

export async function closeSession(profileId: number, opts?: { skipCookieSave?: boolean }) {
  const s = sessions.get(profileId);
  if (!s) return;
  if (s.frameLoop) clearInterval(s.frameLoop);
  if (s.housekeepLoop) { clearInterval(s.housekeepLoop); s.housekeepLoop = null; }
  await stopScreencast(profileId).catch(() => {});
  if (s.ws && s.ws.readyState === WebSocket.OPEN) try { s.ws.close(); } catch {}
  // Save cookies before closing so the next open restores the latest session state.
  // Skipped by clearSession / wipeEbSession which deliberately discard cookies.
  if (!opts?.skipCookieSave) {
    try { await saveCookies(profileId, s.page); } catch {}
  }
  await s.browser.close();
  sessions.delete(profileId);
  log(`Chrome closed for profile ${profileId}`, "browser");
}

export async function clearSession(profileId: number, userAgent: string, proxy?: ProxyConfig) {
  // Delete the saved cookies file so the new Chrome session starts on the login
  // page with a clean jar. If cookies were valid the user wouldn't be pressing
  // Clear — preserving stale cookies creates an unbreakable ERR_TOO_MANY_REDIRECTS
  // loop because every new session loads them and immediately hits chrome-error://.
  // After a successful login, saveCookies() writes fresh cookies so the NEXT open
  // after a good login still gets the direct-to-feed navigation.
  deleteSavedCookies(profileId);
  await closeSession(profileId, { skipCookieSave: true });
  await getOrCreateSession(profileId, userAgent, proxy);
  log(`Session cleared for profile ${profileId}`, "browser");
}

// Wipe everything — used by Reset Device IDs so the EB starts as a clean
// new device with no stored cookies. Unlike clearSession, does NOT reopen
// the browser, and also deletes the Puppeteer user-data-dir so Chrome's own
// internal cookie database is erased (not just the app's saved JSON file).
export async function wipeEbSession(profileId: number): Promise<void> {
  deleteSavedCookies(profileId);
  await closeSession(profileId, { skipCookieSave: true });
  const userDataDir = path.join(COOKIES_DIR, `userdata-${profileId}`);
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
  wsWrite(s?.ws ?? null, { type: "loginStatus", message });
  log(`[autoLogin:${profileId}] ${message}`, "browser");
}

export function sendLoginDone(profileId: number, ok: boolean, message: string) {
  const s = sessions.get(profileId);
  wsWrite(s?.ws ?? null, { type: "loginDone", ok, message });
  log(`[loginDone:${profileId}] ${ok ? "✅" : "❌"} ${message}`, "browser");
}

// Extract raw cookies from the active browser session page.
// Used by the verify route to hand browser-authenticated cookies to the API client.
export async function getSessionPageCookies(profileId: number): Promise<Array<{ name: string; value: string }>> {
  const s = sessions.get(profileId);
  if (!s) return [];
  try {
    // Explicitly request instagram.com cookies by URL — page.cookies() without args
    // returns nothing when the page is on chrome-error:// (ERR_TOO_MANY_REDIRECTS
    // after post-login redirects). CDP returns cookies for any URL regardless of
    // what page is currently loaded.
    return await s.page.cookies(
      "https://www.instagram.com",
      "https://i.instagram.com",
      "https://instagram.com",
    );
  } catch { return []; }
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
  // If a challenge was detected in THIS session, bail immediately — do not
  // navigate anywhere or retry credentials. The update_risky_contactpoint URL
  // cannot be loaded in the embedded browser (20-redirect loop). Further attempts
  // only deepen the account lock. The user must resolve the challenge in their
  // own browser, then press Clear to start a fresh session.
  if (s.challengeUrl) {
    const chalMsg = `Instagram has placed a security lock on this account. Open this link in your own browser to complete the verification: ${s.challengeUrl}`;
    sendStatus(profileId, `🔒 ${chalMsg}`);
    return { ok: false, message: chalMsg };
  }

  // Capture the session's unique token. If the user presses Clear while this
  // login is running, clearSession replaces the entry in the sessions map with a
  // brand-new Session (new token). We check below before returning ok:true so a
  // stale autoLogin from the dead session never fires a phantom "✅ Login
  // successful" event on the newly-launched Chrome session.
  const mySessionToken = s.sessionToken;

  // Guard: suppress screenshot-timeout kills while login is running so the page
  // isn't destroyed mid-flow (which would produce a spurious ok:false result).
  s.autoLoginInProgress = true;
  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

  try {
    // ── Step 0: Pre-flight navigation for verify-without-EB-panel ──────────────
    // When the user presses Verify without the EB panel open, getOrCreateSession
    // starts Chrome on about:blank with cookies loaded from JSON but pendingInitUrl
    // not yet consumed (that URL is normally consumed by attachWS, which is only
    // called when the EB panel WebSocket connects).
    //
    // Without this step, browserAutoLogin sees about:blank, concludes Chrome is
    // not on Instagram, PURGES the freshly-loaded sessionid, then navigates to
    // the login page and submits credentials — an unnecessary fresh login that
    // triggers Instagram's update_risky_contactpoint challenge on many accounts.
    //
    // Fix: if Chrome is on a blank page AND we have saved cookies, navigate to
    // instagram.com first and give the session a chance to restore.  All existing
    // logic below then runs normally against the real post-navigation URL.
    {
      let preFlightUrl = "";
      try { preFlightUrl = s.page.url(); } catch {}
      const isBlankStart = preFlightUrl === "about:blank"
        || preFlightUrl === "about:newtab"
        || preFlightUrl === ""
        || preFlightUrl === "chrome://newtab/";
      if (isBlankStart && hasSavedCookies(profileId)) {
        sendStatus(profileId, "Opening Instagram with saved session…");
        log(`[autoLogin:${profileId}] Chrome on blank page — navigating instagram.com before checking session`, "browser");
        s.pendingInitUrl = undefined; // consume so attachWS doesn't re-navigate
        s.navProtectedUntil = Date.now() + 20000;
        await s.page.goto("https://www.instagram.com/", {
          waitUntil: "domcontentloaded",
          timeout: 25000,
        }).catch(() => null);
        await delay(2000); // let instagram.com settle + cookies take effect
      }
    }

    // ── Step 1: Check if already logged in; navigate to login only if needed ──
    let currentUrl = s.page.url();
    sendStatus(profileId, `Current URL: ${currentUrl.slice(0, 80)}`);

    // If the browser is already on Instagram and NOT on the login page,
    // the session is valid — save cookies and return immediately.
    // IMPORTANT: this check comes BEFORE the challengeUrl check so that a stale
    // challengeUrl from a previous challenge (that the user already resolved in the
    // EB) does not cause a false "account locked" when the account is in fact live.
    const onInstagram = currentUrl.includes("instagram.com") && !currentUrl.startsWith("chrome-error://");
    const onLoginPage = currentUrl.includes("accounts/login");
    if (onInstagram && !onLoginPage) {
      // Instagram's home URL (/) is identical whether logged in or not — when NOT logged in
      // it shows a marketing page with an embedded login form at the same URL.
      // Check for a username input to detect that case before declaring "already logged in".
      const hasLoginForm = await s.page.$('input[name="username"], input[autocomplete="username"]').catch(() => null);
      if (!hasLoginForm) {
        // Check for the Instagram splash page ("Log In / Sign Up") that appears at
        // instagram.com/ before the login form — this is NOT a logged-in state.
        // Instagram has changed the splash DOM several times:
        //   v1: <a href="/accounts/login/"> link → use $() querySelector
        //   v2: <button> or [role="button"] with "Log in" text → need evaluate()
        // Check both forms so the click-through works regardless of DOM version.
        const splashLoginLink = await s.page.$('a[href*="accounts/login"], a[href*="/login"]').catch(() => null);
        const splashBtnClicked = !splashLoginLink && await s.page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], a'));
          const btn = candidates.find(el => {
            const txt = (el.textContent || '').trim().toLowerCase();
            return txt === 'log in' || txt === 'login' || txt === 'log in or sign up';
          });
          if (btn) { btn.click(); return true; }
          return false;
        }).catch(() => false);

        if (splashLoginLink || splashBtnClicked) {
          sendStatus(profileId, "Instagram splash page detected — clicking Log In, waiting for login form…");
          if (splashLoginLink) await splashLoginLink.click().catch(() => null);
          await delay(2500);
          // Fall through to the login form detection below — credentials will be
          // filled automatically, no manual button click required.
        } else {
          // Clear any stale challenge flag — the account is visibly logged in so
          // whatever challenge existed has been resolved in the browser.
          s.challengeUrl = undefined;
          // Ground-truth: verify a real sessionid cookie exists before declaring success.
          // The page may be on a challenge/error URL that has no login form but also
          // has no session (e.g. instagram.com/challenge/).
          const earlyCheck = await s.page.cookies(
            "https://www.instagram.com",
            "https://i.instagram.com",
            "https://instagram.com",
          ).catch(() => [] as { name: string; value: string }[]);
          if (!earlyCheck.some(c => c.name === "sessionid" && c.value.length > 5)) {
            const msg = `Browser is on ${currentUrl.slice(0, 80)} but no sessionid cookie found — Instagram may be showing a challenge. Open the embedded browser and complete any verification shown, then try Verify again.`;
            sendStatus(profileId, `⚠ ${msg}`);
            return { ok: false, message: msg };
          }
          await saveCookies(profileId, s.page);
          sendStatus(profileId, "✓ Already logged in — browser shows your account.");
          return { ok: true, message: "Already logged in" };
        }
      }
      // Login form is visible at the home URL — treat as not logged in, fall through to fill it.
      sendStatus(profileId, "Login form detected — filling credentials…");
    }

    // ── STOP: Security challenge already detected for this session ────────────
    // The response interceptor sets session.challengeUrl the moment Instagram
    // issues a redirect to update_risky_contactpoint / /challenge/ / /suspended.
    // If that flag is set we must NOT clear cookies and re-submit credentials —
    // that is exactly the hammering loop that caused Instagram to lock the account
    // in the first place. Return a hard error so the verify route marks the account
    // as locked/captcha and stops retrying automatically.
    // (Only reached here if the account is NOT already logged in — see check above.)
    if (s.challengeUrl) {
      const chalMsg = `Instagram has placed a security lock on this account. You must log in from a regular browser at instagram.com and complete the verification check shown there. Once done, click Clear in the embedded browser to start a fresh session.`;
      sendStatus(profileId, `🔒 ${chalMsg}`);
      return { ok: false, message: chalMsg };
    }
    if (!onLoginPage && !onInstagram) {
      // Wipe session/auth cookies from Chrome's jar BEFORE navigating to the
      // login page. Stale or expired cookies (loaded from the saved-cookie file
      // on session start) cause ERR_TOO_MANY_REDIRECTS when Chrome tries to load
      // accounts/login/ — Instagram redirects to home, home bounces back to login,
      // and the loop never breaks.
      //
      // CRITICAL — preserve device-identity cookies (mid, ig_did, ig_nrcb, datr).
      // These are Instagram's persistent Machine ID / Device ID tokens. If we
      // delete them, Instagram generates brand-new ones during login and fires an
      // "Unrecognized device" security notification to the account owner. Only
      // clear the session/auth cookies; keep the device tokens intact.
      // datr = Facebook/Instagram "device attribute token" — purging it causes
      // update_risky_contactpoint to infinite-redirect (Instagram can't match the
      // challenge session to a known device without it).
      const DEVICE_COOKIE_NAMES = new Set(["mid", "ig_did", "ig_nrcb", "datr"]);
      try {
        const allIgCookies: any[] = await (s.page as any).cookies(
          "https://www.instagram.com",
          "https://i.instagram.com",
          "https://instagram.com",
        ).catch(() => []);
        const deviceCookies = allIgCookies.filter(c => DEVICE_COOKIE_NAMES.has(c.name));
        const sessionCookies = allIgCookies.filter(c => !DEVICE_COOKIE_NAMES.has(c.name));
        if (sessionCookies.length) {
          await (s.page as any).deleteCookie(...sessionCookies).catch(() => null);
          log(`[autoLogin:${profileId}] Cleared ${sessionCookies.length} session cookies before login (preserved device tokens: ${deviceCookies.map((c: any) => c.name).join(", ") || "none"})`, "browser");
        }
        // Restore device-identity cookies immediately so they survive the navigation
        if (deviceCookies.length) {
          await (s.page as any).setCookie(...deviceCookies).catch(() => null);
        }
      } catch {}
      deleteSavedCookies(profileId);
      sendStatus(profileId, "Navigating to Instagram login…");
      s.navProtectedUntil = Date.now() + 35000;
      await s.page.goto("https://www.instagram.com/accounts/login/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }).catch(() => null);

      // Immediately check if Chrome hit an error page — no point waiting 12 seconds
      // for a login form that will never appear on chrome-error://.
      // ERR_HTTP_RESPONSE_CODE_FAILURE means an HTTP 4xx/5xx was returned — this
      // can come from the proxy (407 auth), Instagram's CDN (403/429), or the
      // network path.  The browser window will show exactly what error occurred.
      const afterGotoUrl = s.page.url();
      if (afterGotoUrl.startsWith("chrome-error://") || afterGotoUrl.startsWith("chrome-error:")) {
        const errMsg = `Chrome hit an error page loading Instagram (ERR_HTTP_RESPONSE_CODE_FAILURE). Open the embedded browser for this account to see the exact error — it may be a proxy authentication issue, an Instagram block on this IP, or a network problem. Resolve it and try Verify again.`;
        sendStatus(profileId, `⚠ ${errMsg}`);
        return { ok: false, message: errMsg };
      }
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
      const postWaitUrl = s.page.url();
      // chrome-error:// means the proxy returned an HTTP error when the browser
      // tried to load Instagram.  No login form exists on an error page, but that
      // does NOT mean the account is logged in.  Return a clear proxy error message.
      if (postWaitUrl.startsWith("chrome-error://") || postWaitUrl.startsWith("chrome-error:")) {
        const errMsg = `Chrome hit an error page loading Instagram (ERR_HTTP_RESPONSE_CODE_FAILURE). Open the embedded browser for this account to see the exact error — it may be a proxy authentication issue, an Instagram block on this IP, or a network problem. Resolve it and try Verify again.`;
        sendStatus(profileId, `⚠ ${errMsg}`);
        return { ok: false, message: errMsg };
      }
      if (!postWaitUrl.includes("accounts/login")) {
        // Not on login page and not on chrome-error — might be logged in already
        // (e.g. trusted-device auto-login fired mid-wait).  Guard with sessionid check.
        const afterWaitCheck = await s.page.cookies(
          "https://www.instagram.com",
          "https://i.instagram.com",
          "https://instagram.com",
        ).catch(() => [] as { name: string; value: string }[]);
        if (afterWaitCheck.some(c => c.name === "sessionid" && c.value.length > 5)) {
          await saveCookies(profileId, s.page);
          sendStatus(profileId, "✓ Already logged in — browser shows your account.");
          return { ok: true, message: "Already logged in" };
        }
        // No sessionid — probably a challenge or unsupported page
        const msg = `Login form not found and browser is on ${postWaitUrl.slice(0, 80)} — Instagram may be showing a challenge. Open the embedded browser and complete any verification shown, then try Verify again.`;
        sendStatus(profileId, `⚠ ${msg}`);
        return { ok: false, message: msg };
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

    // Wait up to 20 s for the login form to be replaced by something else.
    // IMPORTANT: do NOT use Instagram's UI copy strings here — they change over
    // time and across locales.  Use a DOM check instead so this is resilient.
    // Also detect chrome-error:// (ERR_TOO_MANY_REDIRECTS): that IS a successful
    // login — Instagram's post-login redirect chain collides with proxy cookies
    // and Chrome shows the error page instead of the feed.  On slow proxies this
    // can take 10-15 s after the button click, so the timeout must be long enough.
    await Promise.race([
      s.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null),
      s.page.waitForFunction(() => {
        const url = window.location.href;
        // ERR_TOO_MANY_REDIRECTS = successful login via proxy (handled below)
        if (url.startsWith("chrome-error://")) return true;
        // Login form gone from DOM = Instagram processed the credentials
        if (!document.querySelector('input[name="username"]')) return true;
        return false;
      }, { timeout: 20000 }).catch(() => null),
    ]);

    // Wait for the new page content to actually render (2FA page loads after form goes)
    await s.page.waitForFunction(() =>
      (document.body?.innerText || "").length > 80, { timeout: 6000 }
    ).catch(() => null);

    // Give Instagram's SPA up to 8 s to either navigate away from the login page
    // (logged in) OR mount the 2FA overlay (which renders asynchronously on top of
    // the login form). Without this wait, is2FAByDom evaluates before the 2FA input
    // appears in the DOM and returns false — causing step 7 to be skipped entirely.
    await s.page.waitForFunction(() => {
      const url = window.location.href;
      // Navigated away from login entirely — done waiting
      if (!url.includes("/accounts/login") && !url.includes("challenge")) return true;
      // ERR_TOO_MANY_REDIRECTS — treat as success (handled in step 6)
      if (url.startsWith("chrome-error://")) return true;
      // Still on login page — wait for a visible non-login input (the 2FA code field)
      const SKIP_N = new Set(["username", "email", "pass", "password", "search", "q"]);
      const SKIP_T = new Set(["password", "submit", "button", "hidden", "checkbox", "radio", "file"]);
      return Array.from(document.querySelectorAll("input")).some((el: any) => {
        const name = (el.name || "").toLowerCase();
        const type = (el.type || "text").toLowerCase();
        if (SKIP_N.has(name) || SKIP_T.has(type)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    }, { timeout: 8000 }).catch(() => null);

    await delay(300);
    await dismissCookieBanner(s.page);

    // Dismiss post-login popups BEFORE evaluating page state — new accounts often
    // see "Save your login info", "Turn on notifications", or other overlays that
    // can obscure the real page state and trigger false 2FA / checkpoint detection.
    await dismissInstagramPopups(s.page);
    await delay(600);

    // ── New-account onboarding page bypass ───────────────────────────────────
    // Freshly bought accounts frequently land on full-page interstitials after
    // login: "Add your phone number" (/accounts/phone-add/), "Onetap save login"
    // (/accounts/onetap/), "Add birthday" (/accounts/birthday/), etc.
    // These pages have numeric/tel inputs that the 2FA detector flags as TOTP
    // code fields, causing verify to fail with "2FA screen — no TOTP key stored".
    // The sessionid cookie is already set at this point — navigate to the feed.
    const postLoginUrl = s.page.url();
    const isOnboardingPage =
      /\/accounts\/(phone-add|email-add|manage-account|onetap|birthday|nametag|avatar)/i.test(postLoginUrl);
    if (isOnboardingPage) {
      sendStatus(profileId, `Post-login setup page detected (${postLoginUrl.slice(0, 70)}) — navigating to home feed…`);
      await s.page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
      await delay(2000);
      await dismissInstagramPopups(s.page);
    }

    // ── Step 6: Detect what's on screen by content, not URL ──────────────────
    // The 2FA hash-route URL still contains "/accounts/login" — can't use URL alone.
    // Also check dialogs/modals separately — Instagram renders "Incorrect password"
    // as an overlay portal that may not appear in the first 600 chars of body text.
    // Use full body text (not sliced) so the 2FA overlay text isn't cut off behind
    // the background login form text.
    const [pageText, dialogText, fullBodyText] = await Promise.all([
      s.page.evaluate(() => (document.body?.innerText || "").slice(0, 600).trim()).catch(() => ""),
      s.page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll<HTMLElement>(
          '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'
        ));
        return dialogs.map(d => (d.innerText || d.textContent || "").trim()).join(" ").slice(0, 300);
      }).catch(() => ""),
      s.page.evaluate(() => (document.body?.innerText || "").trim()).catch(() => ""),
    ]);
    const allText = `${fullBodyText} ${dialogText}`;
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

    // ── Step 6a: Detect security checkpoint BEFORE 2FA check ─────────────────
    // Challenge/checkpoint pages contain "challenge" in the URL and should never
    // trigger TOTP auto-fill — they need a different resolution (browser, SMS, etc.)
    const isCheckpoint = pageUrl.includes("/challenge") ||
                         /verify.{0,30}(identity|phone|email)|unusual.{0,20}activity|suspicious.{0,20}activity|confirm.{0,20}(phone|email|identity)/i.test(allText);
    if (isCheckpoint) {
      sendStatus(profileId, `⚠ Instagram security checkpoint detected — URL: ${pageUrl.slice(0, 80)}`);
      return { ok: false, message: "Instagram is showing a security checkpoint — handle it in the browser." };
    }

    // DOM-based 2FA detection: only fire on inputs that are specifically OTP/code
    // inputs — not just any visible non-login field. Challenge pages and other screens
    // can have visible text inputs that are NOT TOTP code fields.
    const is2FAByDom = await s.page.evaluate(() => {
      const CODE_NAMES = new Set(["verificationcode", "verification_code", "security_code", "totp_code", "code"]);
      const hasCodeInput = Array.from(document.querySelectorAll("input")).some(el => {
        const name  = ((el as HTMLInputElement).name || "").toLowerCase();
        const type  = ((el as HTMLInputElement).type || "text").toLowerCase();
        const imode = (el.getAttribute("inputmode") || "").toLowerCase();
        const ac    = ((el as HTMLInputElement).autocomplete || "").toLowerCase();
        const ph    = ((el as HTMLInputElement).placeholder || "").toLowerCase();
        const ml    = parseInt(el.getAttribute("maxlength") || "0", 10);
        if (["password","submit","button","hidden","checkbox","radio","file","image"].includes(type)) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        // imode === "numeric" alone is NOT enough — phone-number inputs on Instagram's
        // "Add your phone number" onboarding page also use inputmode="numeric" with no
        // maxlength. Only treat it as a code input when combined with a short maxlength
        // (6-8) or an explicit OTP autocomplete attribute.
        const isNumericOtp = imode === "numeric" && (ml >= 6 && ml <= 8);
        return CODE_NAMES.has(name) ||
               ac === "one-time-code" ||
               isNumericOtp ||
               (ml >= 6 && ml <= 8) ||
               ph.includes("code") || ph.includes("digit") || ph.includes("otp");
      });
      const bodyText = document.body?.innerText || "";
      const hasTrustDevice = /trust.this.device|try.another.way|two-factor/i.test(bodyText);
      return hasCodeInput || hasTrustDevice;
    }).catch(() => false);

    const is2FA = is2FAByDom ||
                  /authentication.app|6.digit|two.factor|security.code|confirmation.code|backup.code|enter.the.code/i.test(allText) ||
                  pageUrl.includes("/two_factor");

    // chrome-error:// after submit — check for sessionid FIRST.
    // A banned or restricted account: Instagram accepts the credentials, sets the
    // sessionid cookie, then immediately redirects the browser to a restriction/ban
    // page that returns HTTP 4xx → ERR_HTTP_RESPONSE_CODE_FAILURE → chrome-error://.
    // The login DID succeed.  We must extract the cookie and return ok:true so the
    // verify flow can proceed to the mobile API and set the correct final status
    // (banned / checkpoint / valid).  The old "never ok on chrome-error" rule was
    // correct when there were no cookies, but wrong when there IS a sessionid.
    const isErrorPage = pageUrl.startsWith("chrome-error://");
    if (isErrorPage) {
      const postSubmitCookies = await s.page.cookies(
        "https://www.instagram.com",
        "https://i.instagram.com",
        "https://instagram.com",
      ).catch(() => [] as { name: string; value: string }[]);
      if (postSubmitCookies.some(c => c.name === "sessionid" && c.value.length > 5)) {
        await saveCookies(profileId, s.page);
        sendStatus(profileId, "✓ Logged in — Instagram accepted credentials (browser was redirected to a restriction page after login; this is normal for accounts with active bans or challenges).");
        return { ok: true, message: "Logged in" };
      }
      // No sessionid — chrome-error without a session means a genuine proxy/network
      // or rate-limit error.  Fall through so isLoggedIn remains false.
    }
    const isLoggedIn = !isErrorPage &&
                       !pageText.includes("Username, email or mobile number") &&
                       !pageText.includes("Create new account") &&
                       !pageUrl.includes("/accounts/login");

    sendStatus(profileId, `2FA detected: ${is2FA} (dom=${is2FAByDom}) | Logged in: ${isLoggedIn}`);

    // ── Step 7: Auto-fill TOTP if 2FA screen detected ────────────────────────
    if (is2FA) {
      const keyClean = twoFAKey.replace(/\s+/g, "");
      sendStatus(profileId, `TOTP key present: ${!!keyClean} (length ${keyClean.length})`);
      if (keyClean) {
        sendStatus(profileId, "2FA screen — entering TOTP code automatically…");
        let code: string;
        try {
          code = generateTotp(keyClean);
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
          // Scroll input into view first — it may be near the bottom of the viewport
          await codeInput.evaluate((el: Element) => el.scrollIntoView({ block: "center" })).catch(() => null);
          await delay(150);
          const box = await codeInput.boundingBox().catch(() => null);
          sendStatus(profileId, `Input bounding box: ${JSON.stringify(box)}`);
          // Use ElementHandle.click() — auto-scrolls into view and focuses the element
          await codeInput.click({ clickCount: 3 }).catch(() => null);
          await delay(200);
          // Use ElementHandle.type() — dispatches proper keyboard events that React hears
          await codeInput.evaluate((el: Element) => { (el as HTMLInputElement).value = ""; }).catch(() => null);
          await (codeInput as any).type(code, { delay: 80 });
          // Verify the value was actually received
          const typedVal = await codeInput.evaluate((el: Element) => (el as HTMLInputElement).value).catch(() => "?");
          sendStatus(profileId, `Typed TOTP code — input now contains: "${typedVal}"`);
          await delay(400);

          // Find and click the Continue/Confirm button using an ElementHandle so Puppeteer
          // automatically scrolls it into view — getBoundingClientRect + page.mouse.click fails
          // silently when the button is below the visible viewport fold.
          const btnHandle = await s.page.evaluateHandle(() => {
            const all = Array.from(document.querySelectorAll('button, [role="button"]'));
            return (all.find(b => /confirm|continue|verify|submit/i.test((b as HTMLElement).innerText?.trim() || "")) ?? null) as Element | null;
          }).catch(() => null);
          const btnEl = btnHandle && (btnHandle as any).asElement ? (btnHandle as any).asElement() : null;
          if (btnEl) {
            const btnText = await btnEl.evaluate((b: Element) => (b as HTMLElement).innerText?.trim()).catch(() => "?");
            sendStatus(profileId, `Submit button: "${btnText}" — clicking via ElementHandle`);
            await btnEl.evaluate((b: Element) => b.scrollIntoView({ block: "center" })).catch(() => null);
            await delay(100);
            await btnEl.click().catch(() => null);
          } else {
            sendStatus(profileId, `No submit button found — pressing Enter`);
            await s.page.keyboard.press("Enter");
          }

          // Wait up to 12s for Instagram to accept the 2FA code.
          // Instagram's SPA often does NOT change the URL after accepting 2FA —
          // it removes the overlay in-place while the URL stays /accounts/login/.
          // So we must detect success via DOM state, not URL alone.
          sendStatus(profileId, "2FA code submitted — waiting for Instagram…");
          await Promise.race([
            s.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => null),
            s.page.waitForFunction(() => {
              const url = window.location.href;
              // Hard navigation away from login = success
              if (!url.includes("/two_factor") && !url.includes("/accounts/login")) return true;
              // SPA case: 2FA overlay removed and login form gone = success
              const hasLoginForm = !!document.querySelector('input[name="username"], input[autocomplete="username"]');
              const has2FAInput  = Array.from(document.querySelectorAll("input")).some((el: any) => {
                const imode = el.getAttribute("inputmode");
                const ac    = el.autocomplete || "";
                const ml    = parseInt(el.getAttribute("maxlength") || "0", 10);
                const nm    = (el.name || "").toLowerCase();
                return imode === "numeric" || ac === "one-time-code" || (ml >= 6 && ml <= 8) ||
                       ["verificationcode","verification_code","security_code","totp_code","code"].includes(nm);
              });
              // Both forms gone → accepted (or rejected with a different overlay)
              return !hasLoginForm && !has2FAInput;
            }, { timeout: 12000 }).catch(() => null),
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

          // Check URL AND DOM — SPA keeps /accounts/login in URL even after success
          const urlAccepted = !afterUrl.includes("/two_factor") && !afterUrl.includes("/accounts/login");
          const domAccepted = await s.page.evaluate(() => {
            const hasLoginForm = !!document.querySelector('input[name="username"], input[autocomplete="username"]');
            const has2FAInput  = Array.from(document.querySelectorAll("input")).some((el: any) => {
              const imode = el.getAttribute("inputmode");
              const ac    = el.autocomplete || "";
              const ml    = parseInt(el.getAttribute("maxlength") || "0", 10);
              const nm    = (el.name || "").toLowerCase();
              return imode === "numeric" || ac === "one-time-code" || (ml >= 6 && ml <= 8) ||
                     ["verificationcode","verification_code","security_code","totp_code","code"].includes(nm);
            });
            return !hasLoginForm && !has2FAInput;
          }).catch(() => false);
          // Use sessionid cookie as ground-truth override — if it exists, we're logged in.
          // Must use explicit IG domain URLs; page.cookies() without args returns only
          // cookies for the current page domain (returns nothing on chrome-error://).
          const hasCookieSession = await s.page.cookies(
            "https://www.instagram.com",
            "https://i.instagram.com",
            "https://instagram.com",
          ).then(cs => cs.some(c => c.name === "sessionid" && c.value.length > 5))
            .catch(() => false);
          const twoFaAccepted = urlAccepted || domAccepted || hasCookieSession;
          sendStatus(profileId, `2FA result: url=${urlAccepted} dom=${domAccepted} cookie=${hasCookieSession}`);
          // Check for disabled/suspended BEFORE declaring success — a disabled account
          // can still pass 2FA and get a sessionid, but Instagram redirects to /accounts/disabled/
          if (afterUrl.includes("/accounts/disabled") || afterUrl.includes("/disabled/")) {
            sendStatus(profileId, `⚠ Account has been permanently disabled by Instagram (URL: ${afterUrl.slice(0, 80)})`);
            storage.updateProfile(profileId, { accountStatus: "account_disabled" }).catch(() => {});
            return { ok: false, message: "Account permanently disabled by Instagram" };
          }
          if (afterUrl.includes("/accounts/suspended") || afterUrl.includes("/suspended")) {
            sendStatus(profileId, `⚠ Instagram is asking this account to confirm it is human (URL: ${afterUrl.slice(0, 80)})`);
            storage.updateProfile(profileId, { accountStatus: "confirm_human" }).catch(() => {});
            return { ok: false, message: "Account requires human verification on Instagram" };
          }
          if (twoFaAccepted) {
            await saveCookies(profileId, s.page);
            s.lastLoginSuccessAt = Date.now();
            if (sessions.get(profileId)?.sessionToken !== mySessionToken) {
              log(`[autoLogin:${profileId}] session replaced during 2FA login — suppressing loginDone to avoid phantom success on new session`, "browser");
              return { ok: false, message: "session replaced" };
            }
            sendStatus(profileId, "✓ 2FA accepted — logged in successfully!");
            return { ok: true, message: "Login successful" };
          }

          // Still on the 2FA / login page — code was likely rejected
          const errSnippet = afterText.slice(0, 100);
          sendStatus(profileId, `⚠ 2FA code not accepted — ${errSnippet || "check the browser window"}`);
          return { ok: false, message: "2FA code rejected" };
        } else {
          sendStatus(profileId, "⚠ 2FA screen — NO input field found. Cannot type code.");
          return { ok: false, message: "2FA screen — input field not found. Open the browser and enter the code manually." };
        }
      } else {
        sendStatus(profileId, "⚠ 2FA screen — no TOTP secret stored for this account. Go to Account Details and paste the 16-character TOTP secret key from your authenticator app, then try Fill Credentials again. You can also type the code manually in the browser window.");
        return { ok: false, message: "2FA screen — no TOTP key stored. Add the TOTP secret in Account Details and retry." };
      }
    }

    // ── Chrome error page after credential submit ─────────────────────────────
    // ERR_TOO_MANY_REDIRECTS immediately after submitting credentials means
    // Instagram's post-login redirect chain hit a security challenge loop.
    // The session.challengeUrl check at the top of this function covers the case
    // where the challenge was already known before submit. This branch covers the
    // case where the first-ever login just triggered the challenge (challengeUrl
    // was set by the response interceptor during this very submit attempt).
    if (isErrorPage) {
      const knownChallenge = sessions.get(profileId)?.challengeUrl;
      if (knownChallenge) {
        const chalMsg = `Instagram has placed a security lock on this account. Log in at instagram.com in a regular browser and complete the verification check shown. Then click Clear here to start a fresh session.`;
        sendStatus(profileId, `🔒 ${chalMsg}`);
        return { ok: false, message: chalMsg };
      }
      const errMsg = `Chrome hit an error page after login (likely ERR_TOO_MANY_REDIRECTS). This usually means Instagram requires a security check. Visit instagram.com in a regular browser to resolve it, then click Clear here.`;
      sendStatus(profileId, `⚠ ${errMsg}`);
      return { ok: false, message: errMsg };
    }

    if (isLoggedIn) {
      const currentUrl = s.page.url();
      if (currentUrl.includes("/accounts/disabled") || currentUrl.includes("/disabled/")) {
        sendStatus(profileId, `⚠ Account has been permanently disabled by Instagram`);
        storage.updateProfile(profileId, { accountStatus: "account_disabled" }).catch(() => {});
        return { ok: false, message: "Account permanently disabled by Instagram" };
      }
      if (currentUrl.includes("/accounts/suspended") || currentUrl.includes("/suspended")) {
        sendStatus(profileId, `⚠ Instagram is asking this account to confirm it is human`);
        storage.updateProfile(profileId, { accountStatus: "confirm_human" }).catch(() => {});
        return { ok: false, message: "Account requires human verification on Instagram" };
      }
      // Ground-truth guard: confirm a real sessionid cookie exists before declaring
      // success.  isLoggedIn can go true when the page navigated away from
      // /accounts/login (e.g. proxy returned an HTTP error mid-redirect, leaving
      // the browser on chrome-error without ever setting a session cookie).
      // Using explicit IG domain URLs mirrors what getSessionPageCookies does so
      // the two checks are always in agreement.
      const sessionCheck = await s.page.cookies(
        "https://www.instagram.com",
        "https://i.instagram.com",
        "https://instagram.com",
      ).catch(() => [] as { name: string; value: string }[]);
      const hasSessionId = sessionCheck.some(c => c.name === "sessionid" && c.value.length > 5);
      if (!hasSessionId) {
        const msg = `Browser navigated away from the login page but no sessionid cookie was issued — Instagram may have shown a challenge or the proxy blocked the redirect. Open the embedded browser for this account, complete any challenge shown, then try Verify again.`;
        sendStatus(profileId, `⚠ ${msg}`);
        log(`[autoLogin:${profileId}] isLoggedIn=true but no sessionid cookie — proxy/challenge false-positive`, "browser");
        return { ok: false, message: msg };
      }
      await saveCookies(profileId, s.page);
      s.lastLoginSuccessAt = Date.now();
      if (sessions.get(profileId)?.sessionToken !== mySessionToken) {
        log(`[autoLogin:${profileId}] session replaced during login — suppressing loginDone to avoid phantom success on new session`, "browser");
        return { ok: false, message: "session replaced" };
      }
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
