import type { Browser, Page } from "puppeteer";
import type { ServerResponse } from "http";
import https from "https";
import WebSocket from "ws";
import { generateTotp } from "./totp";
import fs from "fs";
import path from "path";
import os from "os";
import net from "net";
import tls from "tls";

import { db } from "@workspace/db";
import { instagramApiCalls } from "../shared/schema";
import { storage } from "../storage";
import { userAgents as UA_POOL } from "../shared/userAgents";

// ── Electron native EB mode ───────────────────────────────────────────────────
// When running inside Electron, `EB_IPC_PORT` is set to the port of the native
// ebManager IPC server.  All embedded-browser operations are forwarded to that
// server (which drives a real BrowserWindow) instead of using Puppeteer/CDP.
const IS_ELECTRON_EB = !!process.env.EB_IPC_PORT;
const EB_IPC_BASE    = `http://127.0.0.1:${process.env.EB_IPC_PORT ?? "0"}`;

async function ebIpc(method: string, urlPath: string, body?: unknown): Promise<any> {
  const res = await fetch(`${EB_IPC_BASE}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`EB IPC ${method} ${urlPath} → ${res.status}: ${txt}`);
  }
  return res.json();
}

interface ElectronSessionState {
  ws:        WebSocket | null;
  proxyKey:  string;
  challengeUrl?: string;
  lastLoginSuccessAt?: number;
}
const electronSessions = new Map<number, ElectronSessionState>();

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
  // Device-approval / login-notification challenge — Instagram asks the user to
  // approve the new login from another trusted device.  This surfaces on the web
  // at /accounts/login/two_factor (method=notification) and causes ERR_TOO_MANY_
  // REDIRECTS in headless Chrome because Instagram keeps re-issuing the challenge
  // redirect before we can land.  Classifying it lets followChallengeRedirects
  // resolve the final URL server-side and navigate Chrome there in one hop.
  if (/accounts\/login\/two_factor|two_factor.*login|login.*two_factor/i.test(url)) return "login_approval";
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

    // ── Guard: never overwrite the JSON file with a session-less snapshot ─────
    // When a session expires, Chrome's jar still holds device tokens (mid, ig_did)
    // but loses sessionid.  Without this guard the 60-second heartbeat would
    // overwrite the JSON file with ONLY device tokens, so the next EB open would
    // load a file with no sessionid, navigate to instagram.com, and immediately
    // hit the login form — making it appear as though cookies were "lost".
    // If the current Chrome jar has no sessionid, check whether the existing JSON
    // file still has one.  If it does, preserve the richer file rather than
    // stamping it with degraded data.
    const currentSessionId = cookies.find(c => c.name === "sessionid")?.value ?? "";
    if (!currentSessionId) {
      try {
        const p = cookiePath(profileId);
        if (fs.existsSync(p)) {
          const existing = JSON.parse(fs.readFileSync(p, "utf8"));
          if (Array.isArray(existing) && existing.some((c: any) => c.name === "sessionid" && c.value)) {
            log(`[cookies:${profileId}] Skipping JSON overwrite — Chrome has no sessionid but file still has one (session likely expired; file preserved)`, "browser");
            return;
          }
        }
      } catch { /* non-fatal — fall through and write normally */ }
    }

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

// ── Live EB fingerprint stats ─────────────────────────────────────────────────
// Replicates the exact djb2 + LCG PRNG call sequence from applyStealthScripts
// so the server can compute the current battery level and connection speed for
// real-time display in the UI without polling the Puppeteer page.
//
// Call order must match evaluateOnNewDocument exactly:
//   call 1  → rp(_PROF)          (device profile picker)
//   call 2  → r()                (battery start level)
//   call 3  → r()                (charging state)
//   call 4  → rI(...)            (charge time OR discharge time — one call either way)
//   call 5  → rp(connTypes)      (connection type)
//   call 6  → r()                (downlink Mbps)
function _ebDjb2(ua: string): number {
  let s = 5381;
  for (let i = 0; i < ua.length; i++) {
    s = (((s << 5) + s) ^ ua.charCodeAt(i)) >>> 0;
  }
  return s || 1;
}

function _computeEbSeedValues(ua: string): { batteryStart: number; charging: boolean; downlink: number } {
  let s = _ebDjb2(ua);
  const r  = () => { s = ((Math.imul(1664525, s) + 1013904223) >>> 0); return s / 0x100000000; };
  const rI = (lo: number, hi: number) => { r(); return lo + hi; }; // advances seed; return value unused
  const rp = <T>(arr: readonly T[]) => arr[Math.floor(r() * arr.length)];

  const PROF = [
    [360, 808,  3.0,   8,  8], [411, 914,  2.625,  8,  9], [411, 914,  2.625,  8,  9],
    [360, 780,  3.0,   8, 10], [360, 780,  3.0,    8,  8], [393, 851,  2.75,   8,  8],
    [412, 915,  2.625, 8,  8], [412, 900,  2.70,   8,  8], [393, 873,  2.75,   8,  8],
    [393, 873,  2.75,  8,  8], [393, 868,  2.75,   8,  8], [360, 780,  3.0,    8,  8],
  ] as const;
  rp(PROF);                                                              // call 1 — discard

  const batteryStart = Math.round((0.60 + r() * 0.39) * 100) / 100;   // call 2
  const charging     = r() > 0.35;                                      // call 3
  if (charging) rI(0, 3600); else rI(1800, 28800);                     // call 4 — discard

  rp(["wifi", "wifi", "wifi", "cellular"] as const);                    // call 5 — discard
  const downlink = Math.round(2 + r() * 98);                            // call 6

  return { batteryStart, charging, downlink };
}

// ── Proxy geo-timezone resolution ─────────────────────────────────────────────
// Before launching the EB we resolve the proxy exit-IP timezone via ip-api.com
// (HTTP, plain-text JSON — no key needed) through the proxy itself.  The result
// [IANA name, stdOffset, dstOffset] replaces the PRNG-selected timezone in
// applyStealthScripts so Instagram's signal always matches the proxy's country.
//
// stdOffset / dstOffset are minutes WEST of UTC — the convention used by
// Date.prototype.getTimezoneOffset() and the existing _TZ_POOL entries.
// (New York STD = 300, Berlin STD = -60, etc.)

const _TZ_MAP: Record<string, readonly [string, number, number]> = {
  "America/New_York":       ["America/New_York",       300, 240],
  "America/Chicago":        ["America/Chicago",         360, 300],
  "America/Denver":         ["America/Denver",          420, 360],
  "America/Phoenix":        ["America/Phoenix",         420, 420],
  "America/Los_Angeles":    ["America/Los_Angeles",     480, 420],
  "America/Anchorage":      ["America/Anchorage",       540, 480],
  "America/Toronto":        ["America/Toronto",         300, 240],
  "America/Vancouver":      ["America/Vancouver",       480, 420],
  "America/Sao_Paulo":      ["America/Sao_Paulo",       180, 120],
  "America/Mexico_City":    ["America/Mexico_City",     360, 300],
  "America/Buenos_Aires":   ["America/Buenos_Aires",    180, 180],
  "America/Bogota":         ["America/Bogota",          300, 300],
  "Europe/London":          ["Europe/London",             0, -60],
  "Europe/Dublin":          ["Europe/Dublin",             0, -60],
  "Europe/Lisbon":          ["Europe/Lisbon",             0, -60],
  "Europe/Paris":           ["Europe/Paris",            -60, -120],
  "Europe/Berlin":          ["Europe/Berlin",           -60, -120],
  "Europe/Amsterdam":       ["Europe/Amsterdam",        -60, -120],
  "Europe/Brussels":        ["Europe/Brussels",         -60, -120],
  "Europe/Madrid":          ["Europe/Madrid",           -60, -120],
  "Europe/Rome":            ["Europe/Rome",             -60, -120],
  "Europe/Warsaw":          ["Europe/Warsaw",           -60, -120],
  "Europe/Stockholm":       ["Europe/Stockholm",        -60, -120],
  "Europe/Vienna":          ["Europe/Vienna",           -60, -120],
  "Europe/Zurich":          ["Europe/Zurich",           -60, -120],
  "Europe/Prague":          ["Europe/Prague",           -60, -120],
  "Europe/Budapest":        ["Europe/Budapest",         -60, -120],
  "Europe/Athens":          ["Europe/Athens",          -120, -180],
  "Europe/Bucharest":       ["Europe/Bucharest",       -120, -180],
  "Europe/Helsinki":        ["Europe/Helsinki",        -120, -180],
  "Europe/Istanbul":        ["Europe/Istanbul",        -180, -180],
  "Europe/Moscow":          ["Europe/Moscow",          -180, -180],
  "Asia/Dubai":             ["Asia/Dubai",             -240, -240],
  "Asia/Karachi":           ["Asia/Karachi",           -300, -300],
  "Asia/Kolkata":           ["Asia/Kolkata",           -330, -330],
  "Asia/Dhaka":             ["Asia/Dhaka",             -360, -360],
  "Asia/Bangkok":           ["Asia/Bangkok",           -420, -420],
  "Asia/Singapore":         ["Asia/Singapore",         -480, -480],
  "Asia/Hong_Kong":         ["Asia/Hong_Kong",         -480, -480],
  "Asia/Shanghai":          ["Asia/Shanghai",          -480, -480],
  "Asia/Seoul":             ["Asia/Seoul",             -540, -540],
  "Asia/Tokyo":             ["Asia/Tokyo",             -540, -540],
  "Australia/Sydney":       ["Australia/Sydney",       -600, -660],
  "Australia/Melbourne":    ["Australia/Melbourne",    -600, -660],
  "Pacific/Auckland":       ["Pacific/Auckland",       -720, -780],
};

function tzFromIana(iana: string): readonly [string, number, number] {
  return _TZ_MAP[iana] ?? ["America/New_York", 300, 240];
}

/**
 * Resolves the IANA timezone of the proxy exit IP by sending a plain HTTP GET
 * to http://ip-api.com/json?fields=timezone through the proxy.
 *
 * Uses a raw TCP connection via the `net` module — no extra dependencies.
 * Plain HTTP proxies forward the full request without CONNECT.
 * Returns null on any error or timeout (caller falls back to PRNG timezone).
 */
function resolveProxyTimezone(
  proxyHost: string,
  proxyPort: number,
  proxyUser?: string | null,
  proxyPass?: string | null,
  timeoutMs = 7000,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null) => { if (!settled) { settled = true; resolve(v); } };

    const sock = net.createConnection({ host: proxyHost, port: proxyPort });
    const timer = setTimeout(() => { sock.destroy(); done(null); }, timeoutMs);

    sock.on("error", () => { clearTimeout(timer); done(null); });
    sock.on("connect", () => {
      let req = "GET http://ip-api.com/json?fields=timezone HTTP/1.1\r\n" +
                "Host: ip-api.com\r\n" +
                "Connection: close\r\n";
      if (proxyUser) {
        const creds = Buffer.from(`${proxyUser}:${proxyPass ?? ""}`).toString("base64");
        req += `Proxy-Authorization: Basic ${creds}\r\n`;
      }
      req += "\r\n";
      sock.write(req);

      let raw = "";
      sock.on("data", (chunk) => { raw += chunk.toString("utf8"); });
      sock.on("end", () => {
        clearTimeout(timer);
        try {
          const body = raw.slice(raw.indexOf("\r\n\r\n") + 4).trim();
          const parsed = JSON.parse(body) as { timezone?: string };
          done(parsed.timezone ?? null);
        } catch { done(null); }
      });
    });
  });
}

/**
 * Returns the estimated live EB fingerprint state for a profile.
 * Always returns a value (never null) so the UI can show live-updating
 * battery and connection speed for every account, not just open sessions.
 *
 * Battery:
 *   - When an EB session is running: drifts from batteryStart at 0.1%/min
 *     (midpoint of the 0.08–0.12 range the stealth script uses in Chrome).
 *   - When no session is open: held at the seeded batteryStart value
 *     (we can't know elapsed time without a real session epoch).
 *
 * Downlink:
 *   Oscillates ±25% around the seeded base on a 30-second sin cycle using
 *   Date.now() as the clock.  Each profile has a unique phase offset so
 *   accounts don't all pulse in sync.  The UI polls every 5 s so users see
 *   a visible Mbps change on every refresh — matching the behaviour of the
 *   real stealth script that re-randomises the value every 25–35 s.
 */
export function getEbLiveStats(
  profileId: number,
  userAgent: string,
): { battery: number; charging: boolean; downlink: number } {
  const { batteryStart, charging, downlink: baseDownlink } = _computeEbSeedValues(userAgent);

  // Battery drift — use API session epoch (automation engine running) first,
  // then EB session epoch, then static seed (no session of any kind active).
  const apiEpoch = apiSessionEpochs.get(profileId);
  const ebSession = sessions.get(profileId);
  const epochMs = apiEpoch ?? ebSession?.startedAt;
  let battery: number;
  if (epochMs !== undefined) {
    const elapsedMin = (Date.now() - epochMs) / 60_000;
    const drift = elapsedMin * 0.001; // 0.1 %/min as a fraction (matches stealth script)
    battery = charging
      ? Math.min(1.0, batteryStart + drift)
      : Math.max(0.05, batteryStart - drift);
    battery = Math.round(battery * 100) / 100;
  } else {
    battery = batteryStart;
  }

  // Downlink oscillation — visible on every 5-second UI poll
  // Phase offset per profile so accounts fluctuate independently
  const phase = (Date.now() / 30_000) * Math.PI * 2 + profileId * 1.3;
  const downlink = Math.max(1, Math.round(baseDownlink * (1 + 0.25 * Math.sin(phase))));

  return { battery, charging, downlink };
}

// ── Minimal Chrome args for the throwaway harvest session ─────────────────────
// LAUNCH_ARGS is optimised for long-running EBs: it includes
// --disable-background-networking and --js-flags=--max-old-space-size=128 to
// cut RAM usage.  For the short-lived harvest session those flags are harmful:
//   • --disable-background-networking stops Chrome's background service worker
//     and CDN pre-fetch requests — Instagram piggybacks device-ID cookie setting
//     on these requests, so blocking them prevents mid/ig_did from being written.
//   • 128 MB JS heap is too small for Instagram's web bundle; V8 GCs aggressively
//     and sometimes aborts the fingerprinting scripts before cookies are written.
// The harvest runs for ~10–20 s then the browser is destroyed, so memory
// optimisation is irrelevant here.
const HARVEST_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--disable-extensions",
  "--disable-sync",
  "--mute-audio",
  "--hide-scrollbars",
  "--window-size=1280,760",
  "--disable-gpu",
  "--disk-cache-size=8388608",
  "--media-cache-size=1",
  "--disable-features=AudioServiceOutOfProcess,Translate",
  "--disable-component-update",
  "--disable-breakpad",
  "--disable-client-side-phishing-detection",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--enforce-webrtc-ip-permission-check",
  "--disable-blink-features=AutomationControlled",
];

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
  /** Sites to visit BEFORE Instagram (cookie baker pre-bake) */
  preBakeSites?: string[];
  preBakeSitesMin?: number;
  preBakeSitesMax?: number;
  preBakeScrollMin?: number;
  preBakeScrollMax?: number;
  preBakePctWebsite?: number;
  preBakePctYt?: number;
  preBakePctGoogle?: number;
  preBakeYoutube?: boolean;
  preBakeGoogle?: boolean;
  onStep?: (msg: string) => void;
}): Promise<{ mid: string; ig_did: string; csrftoken: string; cookieStrings: string[]; ebUserAgent: string } | null> {
  const logPfx = "[harvestSignupCookies]";
  log(`${logPfx} Starting EB cookie harvest for signup...`);
  opts?.onStep?.("EB harvest: starting temporary Chrome for cookie collection...");

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
      opts?.onStep?.(`EB harvest failed: Puppeteer not available (${e?.message})`);
      try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch {}
      return null;
    }
  }

  if (!CHROMIUM_PATH) {
    log(`${logPfx} No CHROMIUM_PATH — cannot harvest cookies`);
    opts?.onStep?.("EB harvest failed: Chrome executable not found (CHROMIUM_PATH not set) — cannot harvest cookies");
    try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch {}
    return null;
  }

  // ── IP-LEAK PREVENTION ────────────────────────────────────────────────────
  // The harvest browser visits Instagram to seed device cookies.  Without a
  // proxy, Chrome connects via the server/home IP — Instagram fingerprints it
  // and may flag the account before it is even created.  Block early.
  if (!opts?.proxyHost) {
    log(`${logPfx} No proxy configured — refusing to harvest EB cookies without a proxy (home IP would be exposed)`);
    opts?.onStep?.("EB harvest blocked: no proxy configured — a proxy is required to prevent IP exposure during signup");
    try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch {}
    return null;
  }

  const proxyArg = [`--proxy-server=${opts.proxyHost}:${opts.proxyPort ?? 80}`];

  let browser: any;
  try {
    browser = await puppeteerLib.launch({
      headless: true,
      executablePath: CHROMIUM_PATH,
      // Use HARVEST_ARGS (not LAUNCH_ARGS): the harvest session is throwaway so
      // memory optimisation is irrelevant.  LAUNCH_ARGS includes
      // --disable-background-networking which stops the CDN background requests
      // that Instagram uses to write mid/ig_did, and caps the JS heap at 128 MB
      // which can abort Instagram's fingerprinting scripts under GC pressure.
      args: [...HARVEST_ARGS, `--user-data-dir=${tmpDataDir}`, ...proxyArg],
      ignoreHTTPSErrors: true,
    });
    log(`${logPfx} Temporary Chrome launched`);
    opts?.onStep?.(`EB harvest: Chrome launched ✓ (proxy: ${opts?.proxyHost}:${opts?.proxyPort ?? 80})`);
  } catch (e: any) {
    log(`${logPfx} Browser launch failed: ${e?.message}`);
    opts?.onStep?.(`EB harvest failed: Chrome could not launch — ${e?.message}`);
    try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch {}
    return null;
  }

  // ── UA-FINGERPRINT PREVENTION ─────────────────────────────────────────────
  // The harvest EB MUST use a mobile Chrome UA that matches the API signup UA.
  // Instagram tags mid/ig_did cookies with the device type that first requested
  // them.  If those cookies are set by a desktop browser the mobile API signup
  // call that follows will present desktop-tagged device cookies on an Android
  // UA — an immediate fingerprint mismatch that flags every account.
  //
  // Resolution order:
  //   1. opts.userAgent is already a mobile Chrome UA ("Mozilla/5.0...Android") → use it
  //   2. opts.userAgent is an Instagram API UA format ("35/15; 480dpi; ...") → find
  //      the matching embedded Chrome UA in the UA pool
  //   3. No UA / no pool match → pick a random embedded Chrome mobile UA from the pool
  //
  // We also derive the matching API-format UA for applyStealthScripts so screen
  // dimensions are computed from the real device specs, ensuring the JS fingerprint
  // matches the API UA exactly.
  let effectiveUA: string;
  let harvestApiUA: string | undefined;
  {
    const provided = opts?.userAgent ?? "";
    if (isMobileUA(provided)) {
      // Already a valid mobile Chrome UA ("Mozilla/5.0 (Linux; Android …)")
      effectiveUA = provided;
      const match = UA_POOL.find(e => e.embedded === provided);
      harvestApiUA = match?.api;
    } else if (provided) {
      // Likely an API-format UA ("35/15; 480dpi; Pixel 9 Pro; …")
      // Find the pool entry whose .api field matches and use its .embedded Chrome UA.
      const match = UA_POOL.find(e => e.api === provided || provided.includes(e.api));
      if (match) {
        effectiveUA = match.embedded;
        harvestApiUA = match.api;
        log(`${logPfx} Resolved API UA → mobile Chrome UA for harvest: ${effectiveUA.slice(0, 80)}`);
      } else {
        const entry = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
        effectiveUA = entry.embedded;
        harvestApiUA = entry.api;
        log(`${logPfx} No pool match for provided UA — using random mobile Chrome UA for harvest`);
      }
    } else {
      const entry = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
      effectiveUA = entry.embedded;
      harvestApiUA = entry.api;
      log(`${logPfx} No UA configured — using random mobile Chrome UA for harvest`);
    }
  }
  opts?.onStep?.(`EB harvest: using mobile Chrome UA: ${effectiveUA.slice(0, 80)}${effectiveUA.length > 80 ? "..." : ""}`);

  try {
    const [page] = await browser.pages();
    // NOTE: do NOT touch _signupPage / _signupWs here.  This is a throwaway
    // harvest browser.  The user's visible signup browser (openSignupBrowser)
    // owns those globals.  Overwriting them mid-harvest was corrupting the
    // BrowserPanel stream and causing the "constantly refreshing" loop.
    await page.setUserAgent(effectiveUA);
    // Use a viewport that matches the mobile UA — mobile viewport (isMobile:true,
    // hasTouch:true) ensures Instagram's JS sees a real phone and sets cookies
    // tagged to mobile.  This must match the API UA's device type.
    const vp = viewportForUA(effectiveUA);
    await page.setViewport(vp);
    log(`${logPfx} Harvest viewport: ${vp.width}×${vp.height} isMobile=${!!vp.isMobile}`);

    if (opts?.proxyUsername) {
      await page.authenticate({ username: opts.proxyUsername, password: opts.proxyPassword ?? "" });
    }

    // Pass harvestApiUA so applyStealthScripts derives exact screen dims from the
    // API UA device specs rather than using a fallback PRNG profile.
    await applyStealthScripts(page, effectiveUA, undefined, harvestApiUA ?? undefined);

    // ── Pre-bake: visit websites / YouTube / Google before Instagram ──────────
    // Builds organic browsing history so Chrome's cookie jar looks natural
    // when Instagram's fingerprinting scripts run.  Runs only when the caller
    // passes preBakeSites / preBakeYoutube / preBakeGoogle.
    {
      const pbSites   = opts?.preBakeSites ?? [];
      const hasYt     = !!opts?.preBakeYoutube;
      const hasGoogle = !!opts?.preBakeGoogle;
      if (pbSites.length > 0 || hasYt || hasGoogle) {
        const pctWebsite = opts?.preBakePctWebsite ?? 33;
        const pctYt      = opts?.preBakePctYt      ?? 33;
        const pctGoogle  = opts?.preBakePctGoogle  ?? 33;

        // Build source list with weights (only include enabled sources)
        const sources: Array<{ type: string; weight: number }> = [];
        if (pbSites.length > 0) sources.push({ type: "website", weight: pctWebsite });
        if (hasYt)               sources.push({ type: "youtube", weight: pctYt     });
        if (hasGoogle)           sources.push({ type: "google",  weight: pctGoogle  });

        // Pick first source by weighted random
        const total = sources.reduce((s, x) => s + x.weight, 0);
        let rng = Math.random() * total;
        let firstType = sources[0]?.type ?? "website";
        for (const src of sources) { rng -= src.weight; if (rng <= 0) { firstType = src.type; break; } }

        // Rotate so chosen first-source is first
        const ordered = [
          ...sources.filter(s => s.type === firstType),
          ...sources.filter(s => s.type !== firstType),
        ];

        const minS     = opts?.preBakeSitesMin  ?? 1;
        const maxS     = opts?.preBakeSitesMax  ?? 3;
        const scrollLo = (opts?.preBakeScrollMin ?? 5) * 1000;
        const scrollHi = (opts?.preBakeScrollMax ?? 15) * 1000;
        const numSites = Math.floor(Math.random() * (maxS - minS + 1)) + minS;
        const shuffled = [...pbSites].sort(() => Math.random() - 0.5).slice(0, numSites);

        // Organic scroll helper — scrolls the page for a given duration
        const organicScroll = async (ms: number) => {
          const end = Date.now() + ms;
          while (Date.now() < end) {
            try {
              await page.evaluate(() => { window.scrollBy(0, 120 + Math.random() * 180); });
            } catch {}
            await new Promise(r => setTimeout(r, 600 + Math.random() * 800));
          }
        };

        const scrollMs = () => scrollLo + Math.random() * (scrollHi - scrollLo);

        for (const src of ordered) {
          if (src.type === "website") {
            for (const rawUrl of shuffled) {
              const url = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;
              try {
                opts?.onStep?.(`Pre-bake: visiting ${url}...`);
                log(`${logPfx} Pre-bake → ${url}`);
                await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
                await dismissCookieBanner(page);
                await organicScroll(scrollMs());
              } catch (e: any) {
                log(`${logPfx} Pre-bake skip (${url}): ${e?.message}`);
                opts?.onStep?.(`Pre-bake: skipped ${url} (load failed)`);
              }
            }
          } else if (src.type === "youtube") {
            try {
              opts?.onStep?.("Pre-bake: visiting YouTube...");
              log(`${logPfx} Pre-bake → YouTube`);
              await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded", timeout: 25000 });
              await dismissCookieBanner(page);
              // Scroll the homepage feed organically
              await organicScroll(3000 + Math.random() * 3000);
              // Click a random video from the homepage grid
              try {
                await page.waitForSelector("ytd-rich-item-renderer a#thumbnail, ytd-video-renderer a#thumbnail", { timeout: 5000 });
                const thumbs = await page.$$("ytd-rich-item-renderer a#thumbnail, ytd-video-renderer a#thumbnail");
                if (thumbs.length > 0) {
                  await thumbs[Math.floor(Math.random() * Math.min(6, thumbs.length))].click();
                  await new Promise(r => setTimeout(r, 1500));
                  await dismissCookieBanner(page);
                  await organicScroll(4000 + Math.random() * 4000);
                }
              } catch {}
            } catch (e: any) {
              log(`${logPfx} Pre-bake warning (YouTube): ${e?.message}`);
              opts?.onStep?.("Pre-bake: YouTube load issue — continuing");
            }
          } else if (src.type === "google") {
            try {
              opts?.onStep?.("Pre-bake: visiting Google...");
              log(`${logPfx} Pre-bake → Google`);
              await page.goto("https://www.google.com/", { waitUntil: "domcontentloaded", timeout: 25000 });
              await dismissCookieBanner(page);
              await new Promise(r => setTimeout(r, 1500));
              // Perform an organic search for a random common topic
              const SEARCH_TERMS = [
                "weather today", "news headlines", "sports scores",
                "movies 2025", "best recipes", "travel destinations",
                "technology news", "fitness tips", "photography ideas",
              ];
              const term = SEARCH_TERMS[Math.floor(Math.random() * SEARCH_TERMS.length)];
              try {
                opts?.onStep?.(`Pre-bake: Google search "${term}"...`);
                log(`${logPfx} Pre-bake → Google search: "${term}"`);
                await page.type("textarea[name='q'], input[name='q']", term, { delay: 80 + Math.random() * 60 });
                await page.keyboard.press("Enter");
                await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
                await dismissCookieBanner(page);
                await organicScroll(3000 + Math.random() * 3000);
              } catch (e: any) {
                log(`${logPfx} Pre-bake Google search warning: ${e?.message}`);
              }
            } catch (e: any) {
              log(`${logPfx} Pre-bake warning (Google): ${e?.message}`);
              opts?.onStep?.("Pre-bake: Google load issue — continuing");
            }
          }
        }
        opts?.onStep?.("Pre-bake complete — now harvesting Instagram cookies...");
        log(`${logPfx} Pre-bake complete`);
      }
    }

    // Helper: scrape all three target cookies from Chrome's cookie jar.
    // Checks all three instagram.com origins so root-domain cookies (.instagram.com)
    // are captured regardless of which subdomain set them.
    const IG_ORIGINS = [
      "https://www.instagram.com",
      "https://i.instagram.com",
      "https://instagram.com",
    ];
    const readIgCookies = async () => {
      const all = await page.cookies(...IG_ORIGINS) as Array<{ name: string; value: string }>;
      return {
        mid:       all.find(c => c.name === "mid")?.value       ?? "",
        ig_did:    all.find(c => c.name === "ig_did")?.value    ?? "",
        csrftoken: all.find(c => c.name === "csrftoken")?.value ?? "",
        all,
      };
    };

    // ── Step 1: Visit homepage to seed mid / ig_did fingerprint cookies ───────
    // Use waitUntil:"load" (not "networkidle2") — Instagram keeps background
    // long-poll connections open, so networkidle2 almost always hits the 30 s
    // timeout before settling.  After the DOM is loaded we wait an explicit 6 s
    // to let Instagram's fingerprinting JS execute and write mid/ig_did.
    // Instagram's fingerprinting JS runs on the homepage and writes mid/ig_did.
    // We visit the homepage first, then ALWAYS navigate to the signup form so
    // the user can see the signup page in the EB stream and Instagram sees a
    // natural navigation path (homepage → signup, not signup cold).
    log(`${logPfx} Step 1: Navigating to instagram.com homepage to seed device cookies...`);
    opts?.onStep?.("EB: visiting Instagram homepage to seed device cookies (mid, ig_did)...");
    try {
      await page.goto("https://www.instagram.com/", {
        waitUntil: "load",
        timeout: 30000,
      });
    } catch (e: any) {
      log(`${logPfx} Homepage navigation warning (continuing): ${e?.message}`);
    }
    // Give Instagram's fingerprinting scripts time to run and write cookies.
    await new Promise(r => setTimeout(r, 4000));
    await dismissCookieBanner(page);
    await new Promise(r => setTimeout(r, 2000));

    let { mid, ig_did, csrftoken } = await readIgCookies();
    log(`${logPfx} After homepage+6s: mid=${mid ? "✓" : "✗"} ig_did=${ig_did ? "✓" : "✗"} csrftoken=${csrftoken ? "✓" : "✗"}`);
    opts?.onStep?.(`EB harvest step 1 (instagram.com): mid=${mid ? "✓" : "✗ not yet"} ig_did=${ig_did ? "✓" : "✗ not yet"} csrftoken=${csrftoken ? "✓" : "✗ not yet"}`);

    // ── Step 2: Navigate to the signup page (always) ─────────────────────────
    // This gives the user a visible signup form in the EB stream and often
    // provides the csrftoken cookie that the homepage does not always set.
    log(`${logPfx} Step 2: Navigating to instagram.com/accounts/emailsignup/ ...`);
    opts?.onStep?.("EB: navigating to Instagram signup page...");
    try {
      await page.goto("https://www.instagram.com/accounts/emailsignup/", {
        waitUntil: "load",
        timeout: 30000,
      });
    } catch (e: any) {
      log(`${logPfx} Signup page navigation warning (still checking cookies): ${e?.message}`);
    }
    await new Promise(r => setTimeout(r, 4000));
    await dismissCookieBanner(page);
    await new Promise(r => setTimeout(r, 2000));
    {
      const after = await readIgCookies();
      if (after.mid)       mid       = after.mid;
      if (after.ig_did)    ig_did    = after.ig_did;
      if (after.csrftoken) csrftoken = after.csrftoken;
    }
    log(`${logPfx} After signup page+6s: mid=${mid ? "✓" : "✗"} ig_did=${ig_did ? "✓" : "✗"} csrftoken=${csrftoken ? "✓" : "✗"}`);
    opts?.onStep?.(`EB harvest step 2 (emailsignup): mid=${mid ? "✓" : "✗ MISSING"} ig_did=${ig_did ? "✓" : "✗ MISSING"} csrftoken=${csrftoken ? "✓" : "✗ missing"}`);

    // ── Step 3: Poll until all three cookies appear (up to 15 s more) ─────────
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && (!mid || !ig_did)) {
      await new Promise(r => setTimeout(r, 1000));
      const poll = await readIgCookies();
      if (poll.mid)       mid       = poll.mid;
      if (poll.ig_did)    ig_did    = poll.ig_did;
      if (poll.csrftoken) csrftoken = poll.csrftoken;
    }
    if (!csrftoken) {
      // One final poll — csrftoken can arrive later than the device IDs.
      const poll = await readIgCookies();
      if (poll.csrftoken) csrftoken = poll.csrftoken;
    }

    // ── Warm-up: organic Instagram browsing to age the mid/ig_did session ─────
    // A brand-new mid with zero activity is Instagram's clearest bot signal —
    // real devices have months of browsing history on that mid before ever
    // creating an account.  We browse the homepage and explore page for ~60–90 s
    // to give this device organic activity before the API signup calls start.
    // All navigation is wrapped in try/catch so failures are non-fatal.
    {
      const warmUpScroll = async (ms: number) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          try { await page.evaluate(() => { window.scrollBy(0, 80 + Math.random() * 200); }); } catch {}
          await new Promise(r => setTimeout(r, 700 + Math.random() * 1100));
        }
      };
      opts?.onStep?.("EB warm-up: browsing Instagram to build session history before signup...");
      // Scroll homepage feed 25–40 s
      try { await warmUpScroll(25000 + Math.random() * 15000); } catch {}
      // Navigate to explore and scroll 20–35 s
      try {
        await page.goto("https://www.instagram.com/explore/", { waitUntil: "domcontentloaded", timeout: 15000 });
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
        await warmUpScroll(20000 + Math.random() * 15000);
      } catch {}
      // Re-read cookies — warm-up browsing may have refreshed or added tokens
      const postWarm = await readIgCookies();
      if (postWarm.mid)       mid       = postWarm.mid;
      if (postWarm.ig_did)    ig_did    = postWarm.ig_did;
      if (postWarm.csrftoken) csrftoken = postWarm.csrftoken;
      opts?.onStep?.("EB warm-up: Instagram session browsing complete ✓");
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
    opts?.onStep?.(`EB harvest result: mid=${mid ? mid.slice(0, 8) + "..." : "MISSING"} ig_did=${ig_did ? ig_did.slice(0, 8) + "..." : "MISSING"} csrftoken=${csrftoken ? "✓" : "missing"} — ${cookieStrings.length} cookies total`);

    if (!mid && !ig_did) {
      log(`${logPfx} No IG device cookies harvested — harvest failed`);
      opts?.onStep?.("EB harvest FAILED: Instagram did not set mid/ig_did cookies — proxy may be blocked at CDN level, or Chrome fingerprinting scripts were blocked");
      return null;
    }

    return { mid, ig_did, csrftoken, cookieStrings, ebUserAgent: effectiveUA };
  } finally {
    // Only close the LOCAL harvest browser.  Do NOT touch _signupPage or
    // _signupCdp — those globals belong to the user-visible openSignupBrowser
    // instance.  Clearing them here was silently killing the BrowserPanel
    // stream whenever a harvest ran concurrently with the manual signup EB.
    try { await browser.close(); } catch {}
    try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch {}
    log(`${logPfx} Temporary Chrome closed and data dir cleaned up`);
    opts?.onStep?.("EB harvest: temporary Chrome closed and cleaned up ✓");
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
  // Set to true while a setImmediate frame-decode is pending; the next frame
  // from Chrome is dropped (not decoded or sent) until the current one clears.
  // Prevents pile-up on the Node.js event loop when Chrome delivers frames
  // faster than the client WS + base64 decode can absorb them.
  framePending: boolean;
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
  // Account's API user-agent string (device string format: "SDK/OS; DPIdpi; WxH; mfr; model; ...")
  // Stored so every new popup/tab opened in this session gets the same device fingerprint.
  userAgentApi?: string | null;
  // Proxy geo-resolved IANA timezone [name, stdOffsetMin, dstOffsetMin] — set at
  // session start and reused for every new page/tab opened in the same session.
  resolvedTZ?: readonly [string, number, number];
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
  // ms timestamp when this browser session was first opened.
  // Used to estimate the current battery level for live display in the UI.
  startedAt: number;
}

// Tracks when each profile's automation (mobile-API) session started.
// Set by the automation engine when any runner (follow, unfollow, DM, contact,
// human-session) launches.  Used by getEbLiveStats to drift the battery level
// even when the EB browser is not open — API work drains the phone too.
export const apiSessionEpochs = new Map<number, number>();

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

// ── Event-loop lag monitor ────────────────────────────────────────────────────
// Measures the difference between when a setInterval callback was _scheduled_
// to fire and when it _actually_ fired.  Any gap > 100 ms means the Node.js
// event loop was blocked for that duration — useful for diagnosing freezes
// caused by synchronous work (DB writes, CPU-heavy CDP event processing, etc.).
// Fires every 5 s; only logs when lag is significant to avoid log noise.
{
  const LAG_WARN_MS  = 100;   // log at WARN level above this
  const LAG_ALERT_MS = 500;   // log extra context (open sessions, screencasts) above this
  const INTERVAL_MS  = 5_000;
  let _lastTick = Date.now();
  setInterval(() => {
    const now  = Date.now();
    const lag  = now - _lastTick - INTERVAL_MS;
    _lastTick  = now;
    if (lag >= LAG_WARN_MS) {
      const openIds   = [...sessions.keys()];
      const castCount = openIds.filter(id => sessions.get(id)?.screencastCdp).length;
      const pollCount = openIds.filter(id => (sessions.get(id) as any)?._approvalPolling).length;
      const msg = `[eventloop-lag] ${lag} ms delay detected — open=${openIds.length} screencasts=${castCount} challengePolling=${pollCount}`;
      if (lag >= LAG_ALERT_MS) {
        log(`⚠ ${msg}`, "browser");
      } else {
        log(msg, "browser");
      }
    }
  }, INTERVAL_MS).unref();
}

// Prevents concurrent Chrome launches for the same profile.
// A profile ID is in this Set while its getOrCreateSession call is actively
// launching Chrome.  Other concurrent callers poll until it's done.
const _launchingProfiles = new Set<number>();

// ── Signup Browser Live Stream ────────────────────────────────────────────────
// The signup route registers the temporary Chrome page here so the frontend
// can watch the embedded browser in real time via a dedicated WebSocket.
let _signupPage:    any | null = null;
let _signupCdp:     any | null = null;
let _signupWs:      WebSocket | null = null;
let _signupBrowser: any | null = null;
let _signupDataDir: string | null = null; // per-attempt unique dir, wiped on every close
const pendingFileChoosers = new Map<number, any>(); // profileId → FileChooser

// ── Signup automation WS helpers ─────────────────────────────────────────────
/** Send a JSON message to the signup browser WebSocket (if connected). */
export function sendSignupWsMsg(msg: object): void {
  if (_signupWs && _signupWs.readyState === 1 /* OPEN */) {
    try { _signupWs.send(JSON.stringify(msg)); } catch {}
  }
}

/** Session ID storage for the pause/continue flow (email verification mid-signup). */
let _pendingAutomateEBSession: string | null = null;
export function storePendingAutomateSession(id: string): void { _pendingAutomateEBSession = id; }
export function consumePendingAutomateSession(): string | null {
  const id = _pendingAutomateEBSession;
  _pendingAutomateEBSession = null;
  return id;
}

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


// Mark a session as "recently active". Called by every input handler.
// The frame loop reads lastActivityAt to decide the screenshot cadence:
//   active  (<3 s since input) → every tick    (~6.7 fps)
//   idle    (3–30 s)           → every 8th tick (~0.8 fps)
//   dormant (>30 s)            → every 20th tick (~0.33 fps)
// Background EBs therefore consume almost no screenshot slots, leaving the
// active one to run at full speed regardless of how many EBs are open.
function touchActivity(profileId: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  const wasIdle = s.lastActivityAt < Date.now() - 3000;
  s.lastActivityAt = Date.now();
}

// --no-sandbox is required in all environments.
// --no-zygote is intentionally EXCLUDED — it crashes Chrome silently on Windows
//   when combined with --no-sandbox. It is only needed in sandboxed Linux containers.
const LAUNCH_ARGS_BASE = [
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
  //
  // NOTE: This flag is filtered OUT on Windows — see below. On Windows (Electron)
  // the GPU is available and hardware-accelerated compositing keeps CPU low.
  // On Linux (Replit, CI) there is no display/GPU so software rendering is required.
  "--disable-gpu",

  // ── Memory & process-count optimisations (allows 25+ concurrent EBs) ──────────
  //
  // By default each Chrome instance spawns 4–6 OS processes (browser, renderer,
  // GPU, network service, audio service, etc.) and uses ~300–500 MB RAM.  With
  // 25 accounts open simultaneously that is 7–12 GB — far beyond server limits.
  //
  // The flags below cut each instance down to ~2 processes and ~80–150 MB,
  // matching Jarvee's resource profile for large multi-account setups.

  // Cap the V8 JS heap to 256 MB per renderer (default can grow to 1.5 GB).
  // Instagram's JS bundle + runtime data needs ~150-200 MB; 128 MB caused
  // V8 to run a major GC (mark-compact) at ~2 minutes after page load when
  // the heap pressure peaked, appearing as a CPU spike. 256 MB gives enough
  // headroom to avoid that GC burst without exceeding practical RAM limits.
  "--js-flags=--max-old-space-size=256",

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

  // Prevent Chrome from auto-playing video before a user gesture.
  // Instagram's feed auto-plays Reel videos as soon as they load. With
  // --disable-gpu, video decode runs on the CPU and spikes it heavily.
  // This flag stops the decode pipeline from starting at all — no gesture,
  // no decode, no spike.  Videos still display thumbnails.
  "--autoplay-policy=user-gesture-required",

  // Tell Blink not to set navigator.webdriver = true in the first place.
  // Without this flag Chrome's engine sets the property at a low level that
  // our JS Object.defineProperty override cannot fully hide — fingerprint
  // scripts using Object.getOwnPropertyDescriptor(navigator,'webdriver') can
  // still detect the override pattern.  This flag eliminates the root cause.
  "--disable-blink-features=AutomationControlled",
];

// --disable-gpu stays on ALL platforms, including Windows.
//
// v1.0.417 tried removing it on Windows to offload compositing to the GPU, but
// the GPU process does not help: Chrome's Page.screencastFrame JPEG encoder runs
// CPU-side regardless of GPU compositing, AND GPU compositing causes Chrome to
// generate compositor frames at the GPU refresh rate (~60fps) even for a
// completely static Instagram page — so the JPEG encoder fires far more often.
// With software rendering (--disable-gpu) Chrome only generates a compositor
// frame when page content actually changes, which for a dormant EB is nearly
// never.  Combined with the ACK-delay idle throttle (v1.0.416), software
// rendering keeps idle EB CPU usage at near-zero.
const LAUNCH_ARGS = LAUNCH_ARGS_BASE;

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

export async function applyStealthScripts(
  page: Page,
  userAgent: string,
  overrideTZ?: readonly [string, number, number] | null,
  apiUA?: string | null,
): Promise<void> {
  const mobile = isMobileUA(userAgent);
  const meta = buildUAMetadata(userAgent) as any;

  await page.evaluateOnNewDocument((mobile: boolean, meta: any, _overrideTZ: readonly [string, number, number] | null, _apiUA: string | null) => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });

    // ── Per-account device profile ───────────────────────────────────────────
    // Every value that could cluster across accounts (screen size, DPR, memory,
    // cores, battery level, connection speed) is derived from a seeded PRNG so:
    //  • Same account → same UA → same seed → identical values every session
    //  • Different accounts → different seeds → distinct values, no clustering
    //
    // Seed = djb2(navigator.userAgent)
    const _ua = navigator.userAgent;
    let _s = 5381;
    for (let i = 0; i < _ua.length; i++) { _s = (((_s << 5) + _s) ^ _ua.charCodeAt(i)) >>> 0; }
    _s = _s || 1;
    const _r  = () => { _s = Math.imul(1664525, _s) + 1013904223 >>> 0; return _s / 0x100000000; };
    const _rI = (lo: number, hi: number) => lo + Math.round(_r() * (hi - lo));
    const _rp = <T>(arr: readonly T[]) => arr[Math.floor(_r() * arr.length)];

    // Fallback pool of real Android device screen profiles: [cssW, cssH, dpr, memGB, cores]
    // Used only when no API UA is available (harvest EB, automation baker, etc.).
    // When _apiUA is present the specs are overridden with values computed directly
    // from the API UA's DPI and physical resolution — ensuring a 1-to-1 match
    // between the Chrome UA model name and the injected screen fingerprint.
    const _PROF = [
      [360, 808,  3.0,   8,  8], // Tensor G4  — Pixel 9 Pro     (1080×2424 @ 480dpi, 16GB→devMem8, 8c)
      [411, 914,  2.625, 8,  9], // Tensor G3  — Pixel 8a        (1080×2400 @ 420dpi,  8GB,          9c)
      [411, 914,  2.625, 8,  9], // Tensor G3  — Pixel 8         (1080×2400 @ 420dpi,  8GB,          9c)
      [360, 780,  3.0,   8, 10], // Exynos 2400 — Samsung S24    (1080×2340 @ 480dpi,  8GB,         10c)
      [360, 780,  3.0,   8,  8], // Exynos 2200 — Samsung S22    (1080×2340 @ 480dpi,  8GB,          8c)
      [393, 851,  2.75,  8,  8], // SD 8 Gen 3 — OnePlus 12      (1440×3168 → CSS393×851, 12GB→8,   8c)
      [412, 915,  2.625, 8,  8], // SD 8 Gen 1 — OnePlus 10 Pro  (1080×2400 @ 420dpi,  8GB,          8c)
      [412, 900,  2.70,  8,  8], // SD 8s Gen 3 — Motorola Edge  (1080×2400 @ 432dpi, 12GB→8,       8c)
      [393, 873,  2.75,  8,  8], // SD 8 Gen 3 — Xiaomi 14       (1080×2400 @ 440dpi, 12GB→8,       8c)
      [393, 873,  2.75,  8,  8], // SD 8 Gen 2 — Sony Xperia 1V  (1080×2400 @ 440dpi, 12GB→8,       8c)
      [393, 868,  2.75,  8,  8], // Dimensity 9200 — OPPO Find X6 (1080×2400 @ 440dpi,12GB→8,       8c)
      [360, 780,  3.0,   8,  8], // Exynos 1380 — Samsung A54    (1080×2340 @ 480dpi,  8GB,          8c)
    ] as const;
    // Always advance the PRNG past the profile pick so battery/connection call
    // counts stay identical whether or not the API UA override is applied.
    const _prf = _rp(_PROF) as unknown as [number, number, number, number, number];
    let _SW = _prf[0], _SH = _prf[1], _DPR = _prf[2], _MEM = _prf[3], _CORES = _prf[4];
    // Override: derive exact CSS dims, DPR and core count from the API UA.
    // API UA format: "SDK/OS; DPIdpi; PHYSWxPHYSH; Manufacturer; Model; Codename; Chipset; Locale"
    //   DPR  = dpi / 160 (Chrome's logical pixel ratio definition)
    //   cssW = round(physW / DPR),  cssH = round(physH / DPR)
    //   cores: Tensor/gs20x → 9, Exynos 2400 → 10, everything else → 8
    //   mem:   navigator.deviceMemory is capped at 8 for any device with ≥8 GB RAM
    if (_apiUA) {
      const _uaM = _apiUA.match(/;\s*(\d+)dpi;\s*(\d+)x(\d+)/);
      if (_uaM) {
        const _dpi = +_uaM[1], _pW = +_uaM[2], _pH = +_uaM[3];
        _DPR    = Math.round(_dpi / 160 * 10000) / 10000;
        _SW     = Math.round(_pW / _DPR);
        _SH     = Math.round(_pH / _DPR);
        _MEM    = 8;
        // Only Tensor G3 (Pixel 8 / 8 Pro / 8a) has 9 cores — match on model name,
        // not chipset string, because gs202 appears on both 8-core Pixel 7 and
        // 9-core Pixel 8 Pro; and "Tensor G4" / "Tensor G3" are format-dependent.
        _CORES  = /;\s*Pixel 8[^9]/i.test(_apiUA) ? 9
                : /exynos2400/i.test(_apiUA) ? 10
                : 8;
      }
    }

    // Battery — level and charging state vary per account
    const _BLVL = Math.round((0.60 + _r() * 0.39) * 100) / 100; // 0.60 – 0.99
    const _BCHG = _r() > 0.35;                                   // ~65% plugged in
    const _BCTM = _BCHG ? _rI(0, 3600) : 0;                      // seconds until full
    const _BDTM = _BCHG ? Infinity : _rI(1800, 28800);            // seconds until empty

    // Connection — downlink, RTT and connection type vary per account
    const _CTYPE = _rp(["wifi", "wifi", "wifi", "cellular"] as const); // 75% Wi-Fi
    const _CDL   = Math.round(2 + _r() * 98); // 2 – 100 Mbps
    const _CRTT  = _rI(10, 150);              // 10 – 150 ms

    // Timezone — resolved from proxy geo (preferred) or fallback PRNG pool.
    // _overrideTZ = [IANA name, stdOffset, dstOffset] supplied from Node when
    // the proxy exit-IP geolocation succeeded before the session launched.
    // The PRNG still advances so downstream call counts stay in sync.
    const _TZ_POOL = [
      ["America/New_York",    300, 240] as const,  // EST/EDT  — weighted ×2
      ["America/New_York",    300, 240] as const,
      ["America/Los_Angeles", 480, 420] as const,  // PST/PDT  — weighted ×2
      ["America/Los_Angeles", 480, 420] as const,
      ["America/Chicago",     360, 300] as const,  // CST/CDT
      ["America/Denver",      420, 360] as const,  // MST/MDT
      ["America/Phoenix",     420, 420] as const,  // MST (no DST)
      ["Europe/London",         0, -60] as const,  // GMT/BST
      ["Europe/Berlin",        -60,-120] as const, // CET/CEST
    ];
    const _TZ_PRNG = _rp(_TZ_POOL); // advance PRNG regardless — keeps call sequence stable
    const [_TZNAME, _TZSTD, _TZDST] = (_overrideTZ as any) ?? _TZ_PRNG;

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
      // All values are seeded per account via _PROF — no two accounts share a profile.
      Object.defineProperty(screen, "width",       { get: () => _SW });
      Object.defineProperty(screen, "height",      { get: () => _SH });
      Object.defineProperty(screen, "availWidth",  { get: () => _SW });
      Object.defineProperty(screen, "availHeight", { get: () => _SH - 30 }); // subtract nav bar
      Object.defineProperty(screen, "colorDepth",  { get: () => 24 });
      Object.defineProperty(screen, "pixelDepth",  { get: () => 24 });
      // maxTouchPoints > 0 is required — 0 immediately exposes a non-touch device
      Object.defineProperty(navigator, "maxTouchPoints",      { get: () => 10 });
      // platform on Android Chrome is "Linux armv8l" — not "Linux x86_64"
      Object.defineProperty(navigator, "platform",            { get: () => "Linux armv8l" });
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => _CORES });
      Object.defineProperty(navigator, "deviceMemory",        { get: () => _MEM });
      // Device pixel ratio — seeded from UA, matches the chosen device profile
      Object.defineProperty(window, "devicePixelRatio",       { get: () => _DPR });

      // ── Screen / window orientation ───────────────────────────────────────
      // Mobile browsers always expose window.orientation (0 = portrait) and a
      // screen.orientation object.  Headless Chrome has neither — their absence
      // is an immediate mobile-emulation-vs-real-device tell.
      try { Object.defineProperty(window, "orientation", { get: () => 0, configurable: true }); } catch { /* frozen */ }
      try {
        const orientObj = {
          type: "portrait-primary" as OrientationType,
          angle: 0,
          onchange: null as any,
          lock: () => Promise.reject(new DOMException("Not supported", "NotSupportedError")),
          unlock: () => {},
          addEventListener:    () => {},
          removeEventListener: () => {},
          dispatchEvent:       () => true,
        };
        Object.defineProperty(screen, "orientation", { get: () => orientObj, configurable: true });
      } catch { /* frozen */ }

      // ── Network Information API (navigator.connection) ────────────────────
      // Every real Android Chrome exposes this object.  Headless Chrome does not.
      // Its absence is a reliable indicator that the device is not a real phone.
      // We stub a plausible 4G/Wi-Fi profile; the values are not checked for
      // precise accuracy — only the object's existence and rough shape matter.
      if (!(navigator as any).connection) {
        // Base values are per-account seeded; fluctuation uses Math.random() so
        // each session has unique variation — matching real network behaviour.
        const conn = {
          effectiveType: "4g",
          downlink:      _CDL,
          rtt:           _CRTT,
          saveData:      false,
          type:          _CTYPE as any,
          onchange:      null as any,
          addEventListener:    () => {},
          removeEventListener: () => {},
          dispatchEvent:       () => true,
        };
        // Fluctuate ±25% of the base value every 25–35 seconds — mirrors the
        // variance you see on a real phone as network load changes.
        const _connFluctInterval = 25_000 + Math.random() * 10_000;
        setInterval(() => {
          conn.downlink = Math.max(1, Math.round(_CDL * (0.75 + Math.random() * 0.5)));
          conn.rtt      = Math.max(5, Math.round(_CRTT * (0.75 + Math.random() * 0.5)));
        }, _connFluctInterval);
        try {
          Object.defineProperty(navigator, "connection", { get: () => conn, configurable: true });
        } catch { /* frozen */ }
      }

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
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => _rp([4, 6, 8, 8, 8, 12, 16] as const) });
      Object.defineProperty(navigator, "deviceMemory",        { get: () => _rp([8, 8, 16, 32] as const) });
    }

    // ── Battery API — live draining / charging ───────────────────────────────
    // Real phones have navigator.getBattery().  A headless server has no battery
    // so Chrome throws or returns undefined — a reliable bot tell.
    //
    // A static level is also suspicious: a phone that reads 78% for the entire
    // 30-minute EB session has never drained or charged.  We simulate realistic
    // drift: ~0.08–0.12% change per minute (matching light-usage drain rates).
    // The object is mutable so the live level is always fresh on read.
    // Base level/charging are per-account seeded; the drift is real-time random.
    try {
      const _batt = {
        charging:             _BCHG,
        chargingTime:         _BCTM,
        dischargingTime:      _BDTM,
        level:                _BLVL,
        onchargingchange:     null as any,
        onchargingtimechange: null as any,
        ondischargingtimechange: null as any,
        onlevelchange:        null as any,
        addEventListener:     () => {},
        removeEventListener:  () => {},
        dispatchEvent:        () => true,
      };

      // Drift rate: 0.08–0.12% per minute — charge adds, drain subtracts.
      // Uses Math.random() (not seeded) so each session has unique drift.
      const _driftPct = 0.0008 + Math.random() * 0.0004;
      setInterval(() => {
        if (_batt.charging) {
          _batt.level = Math.min(1.0, Math.round((_batt.level + _driftPct) * 10000) / 10000);
          if (_batt.level >= 1.0) _batt.chargingTime = 0;
        } else {
          _batt.level = Math.max(0.05, Math.round((_batt.level - _driftPct) * 10000) / 10000);
        }
      }, 60_000); // tick every minute

      (navigator as any).getBattery = () => Promise.resolve(_batt);
    } catch { /* non-fatal */ }

    // ── AudioContext fingerprint protection ───────────────────────────────────
    // Audio fingerprinting works by routing an OscillatorNode through an
    // AnalyserNode and reading back the frequency-domain float buffer.  The
    // floating-point output of the audio DSP pipeline differs by hardware and
    // OS audio stack — a server running Chrome produces a different signature
    // from a real Android phone.
    //
    // We apply the same seeded-noise approach used for canvas: add a tiny
    // deterministic offset (≤ 0.0001 per sample) that is unique and consistent
    // per account (seeded by UA) but invisible to real audio analysis.
    (() => {
      const ua = navigator.userAgent;
      let sa = 0x811c9dc5;
      for (let i = 0; i < ua.length; i++) { sa ^= ua.charCodeAt(i); sa = Math.imul(sa, 0x01000193) >>> 0; }
      sa = sa || 1;
      const arnd = () => { sa = Math.imul(1664525, sa) + 1013904223 >>> 0; return (sa / 0x100000000) * 0.0001 - 0.00005; };

      try {
        const origGetFloat = AnalyserNode.prototype.getFloatFrequencyData;
        AnalyserNode.prototype.getFloatFrequencyData = function (array: Float32Array) {
          origGetFloat.call(this, array);
          for (let i = 0; i < array.length; i++) array[i] += arnd();
        };
      } catch { /* non-fatal */ }

      try {
        const origGetByte = AnalyserNode.prototype.getByteFrequencyData;
        AnalyserNode.prototype.getByteFrequencyData = function (array: Uint8Array) {
          origGetByte.call(this, array);
          for (let i = 0; i < array.length; i++) {
            const v = array[i] + (arnd() > 0 ? 1 : 0);
            array[i] = Math.max(0, Math.min(255, v));
          }
        };
      } catch { /* non-fatal */ }

      try {
        const origGetTime = AnalyserNode.prototype.getFloatTimeDomainData;
        AnalyserNode.prototype.getFloatTimeDomainData = function (array: Float32Array) {
          origGetTime.call(this, array);
          for (let i = 0; i < array.length; i++) {
            array[i] = Math.max(-1, Math.min(1, array[i] + arnd()));
          }
        };
      } catch { /* non-fatal */ }
    })();

    // ── mediaDevices.enumerateDevices ────────────────────────────────────────
    // Headless Chrome returns an empty device list (0 entries).
    // A real Android phone returns at least 3 entries (mic, speaker, camera)
    // even when no media permission has been granted — the entries just have
    // empty labels and deviceIds.  0 devices is a strong headless bot signal.
    try {
      if (navigator.mediaDevices?.enumerateDevices) {
        const origEnum = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
        navigator.mediaDevices.enumerateDevices = async () => {
          const real = await origEnum();
          if (real.length === 0) {
            return [
              { deviceId: "", groupId: "", kind: "audioinput"  as MediaDeviceKind, label: "", toJSON: () => ({}) },
              { deviceId: "", groupId: "", kind: "audiooutput" as MediaDeviceKind, label: "", toJSON: () => ({}) },
              { deviceId: "", groupId: "", kind: "videoinput"  as MediaDeviceKind, label: "", toJSON: () => ({}) },
            ] as MediaDeviceInfo[];
          }
          return real;
        };
      }
    } catch { /* non-fatal */ }

    // ── Timezone spoof ────────────────────────────────────────────────────────
    // Server Chrome always reports UTC (getTimezoneOffset = 0). A real phone
    // in the US reports 240–480 minutes west of UTC depending on location and
    // whether DST is active.  Absence of a real timezone offset is detectable.
    //
    // DST detection (US / EU approximation):
    //   US: 2nd Sunday of March → 1st Sunday of November
    //   EU: last Sunday of March → last Sunday of October (≈ same window)
    // Computed at page-load time so the offset is correct for today's date.
    try {
      const _isDST = (() => {
        const n = Date.now();
        const yr = new Date(n).getUTCFullYear();
        // 2nd Sunday of March
        const m = new Date(Date.UTC(yr, 2, 1));
        m.setUTCDate(1 + (7 - m.getUTCDay()) % 7 + 7);
        // 1st Sunday of November
        const v = new Date(Date.UTC(yr, 10, 1));
        v.setUTCDate(1 + (7 - v.getUTCDay()) % 7);
        return n >= m.getTime() && n < v.getTime();
      })();
      const _TZO = _isDST ? _TZDST : _TZSTD;
      Date.prototype.getTimezoneOffset = function () { return _TZO; };
      // Also fix Intl.DateTimeFormat so resolvedOptions().timeZone reflects the
      // spoofed zone rather than the server's UTC.
      const _OrigDTF = Intl.DateTimeFormat;
      (Intl as any).DateTimeFormat = function (locale?: string, opts?: Intl.DateTimeFormatOptions) {
        const o = opts?.timeZone ? opts : { ...opts, timeZone: _TZNAME };
        return new _OrigDTF(locale, o);
      };
      (Intl as any).DateTimeFormat.prototype        = _OrigDTF.prototype;
      (Intl as any).DateTimeFormat.supportedLocalesOf = _OrigDTF.supportedLocalesOf.bind(_OrigDTF);
    } catch { /* non-fatal */ }

    // ── Speech synthesis voices ───────────────────────────────────────────────
    // Headless Chrome returns an empty voice list from speechSynthesis.getVoices().
    // Real Android Chrome returns Google voices.  An empty list is a headless tell.
    try {
      if (window.speechSynthesis) {
        const _fakeVoices = [
          { voiceURI: "Google US English",           name: "Google US English",           lang: "en-US", localService: false, default: true  },
          { voiceURI: "Google UK English Female",    name: "Google UK English Female",    lang: "en-GB", localService: false, default: false },
          { voiceURI: "Google UK English Male",      name: "Google UK English Male",      lang: "en-GB", localService: false, default: false },
          { voiceURI: "Google हिन्दी",               name: "Google हिन्दी",               lang: "hi-IN", localService: false, default: false },
          { voiceURI: "Google Español",              name: "Google Español",              lang: "es-ES", localService: false, default: false },
        ];
        const _origGetVoices = window.speechSynthesis.getVoices.bind(window.speechSynthesis);
        window.speechSynthesis.getVoices = () => {
          const real = _origGetVoices();
          return real.length ? real : (_fakeVoices as any[]);
        };
      }
    } catch { /* non-fatal */ }

    // ── Canvas fingerprint protection ────────────────────────────────────────
    // Server-side Chromium renders canvas via SwiftShader (software renderer).
    // Without interception, every account produces the same tell-tale pixel
    // output that Instagram's fingerprinting script instantly recognises as a
    // headless browser — triggering update_risky_contactpoint on fresh accounts
    // that have no cookie history to override the fingerprint check.
    //
    // We add a tiny deterministic noise to canvas reads that is:
    //  • Seeded by navigator.userAgent (already spoofed, unique per account)
    //    → same account always produces the same fingerprint (device continuity)
    //  • Distinct per account → no two accounts share a fingerprint cluster
    //  • ±1 per channel → invisible to the eye, undetectable by content checks
    //
    // toDataURL / toBlob are intercepted via an offscreen canvas so the original
    // canvas DOM element is never mutated — page rendering is untouched.
    (() => {
      // djb2 hash of UA → deterministic per-account seed
      const ua = navigator.userAgent;
      let seed = 5381;
      for (let i = 0; i < ua.length; i++) {
        seed = (((seed << 5) + seed) ^ ua.charCodeAt(i)) >>> 0;
      }
      seed = seed || 1;

      // LCG PRNG seeded from the UA hash — fast and deterministic
      const lcg = () => { seed = Math.imul(1664525, seed) + 1013904223 >>> 0; return seed / 0x100000000; };
      const noise = () => Math.round(lcg() * 2) - 1; // −1, 0, or +1
      const clamp = (v: number) => Math.max(0, Math.min(255, v));

      // ── getImageData intercept (primary fingerprinting vector) ────────────
      const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function (
        this: CanvasRenderingContext2D, ...args: Parameters<typeof origGetImageData>
      ) {
        const d = origGetImageData.apply(this, args);
        const px = d.data;
        for (let i = 0; i < px.length; i += 4) {
          px[i]     = clamp(px[i]     + noise());
          px[i + 1] = clamp(px[i + 1] + noise());
          px[i + 2] = clamp(px[i + 2] + noise());
          // alpha (px[i+3]) left untouched — changes there are detectable
        }
        return d;
      };

      // ── toDataURL intercept — offscreen copy, original canvas untouched ───
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (
        this: HTMLCanvasElement, ...args: Parameters<typeof origToDataURL>
      ) {
        try {
          if (this.width > 0 && this.height > 0) {
            const oc = document.createElement("canvas");
            oc.width  = this.width;
            oc.height = this.height;
            const octx = oc.getContext("2d");
            if (octx) {
              octx.drawImage(this, 0, 0);
              const px1 = origGetImageData.call(octx, 0, 0, 1, 1);
              px1.data[0] = clamp(px1.data[0] + noise());
              px1.data[1] = clamp(px1.data[1] + noise());
              px1.data[2] = clamp(px1.data[2] + noise());
              octx.putImageData(px1, 0, 0);
              return origToDataURL.apply(oc, args);
            }
          }
        } catch { /* fall through to original */ }
        return origToDataURL.apply(this, args);
      };

      // ── toBlob intercept — same offscreen copy approach ───────────────────
      const origToBlob = HTMLCanvasElement.prototype.toBlob;
      if (origToBlob) {
        HTMLCanvasElement.prototype.toBlob = function (
          this: HTMLCanvasElement,
          callback: BlobCallback,
          ...args: [string?, number?]
        ) {
          try {
            if (this.width > 0 && this.height > 0) {
              const oc = document.createElement("canvas");
              oc.width  = this.width;
              oc.height = this.height;
              const octx = oc.getContext("2d");
              if (octx) {
                octx.drawImage(this, 0, 0);
                const px1 = origGetImageData.call(octx, 0, 0, 1, 1);
                px1.data[0] = clamp(px1.data[0] + noise());
                octx.putImageData(px1, 0, 0);
                return origToBlob.call(oc, callback, ...args);
              }
            }
          } catch { /* fall through to original */ }
          return origToBlob.call(this, callback, ...args);
        };
      }
    })();

    // ── WebGL fingerprint protection ─────────────────────────────────────────
    // Server Chromium reports SwiftShader ANGLE as the renderer — a clear
    // headless-browser tell. Override getParameter and getExtension so
    // Instagram's WebGL fingerprinting script sees a plausible Android GPU
    // that is consistent per account (same UA → same GPU string).
    (() => {
      // GPU pool — plausible Android GPUs from common device families.
      // Indexed deterministically by UA hash so each account always gets
      // the same entry across sessions.
      const GPUS: [string, string][] = [
        ["Mali-G710 MP7",                     "ARM"],         // Tensor G2 (Pixel 7/8a)
        ["Mali-G715 MC10",                    "ARM"],         // Tensor G3 (Pixel 8/9)
        ["Mali-G78 MP14",                     "ARM"],         // Exynos 2200 (S22)
        ["Mali-G715 MP5",                     "ARM"],         // Exynos 2400 (S24)
        ["Adreno (TM) 730",                   "Qualcomm"],    // SD 8 Gen 1
        ["Adreno (TM) 740",                   "Qualcomm"],    // SD 8 Gen 2
        ["Adreno (TM) 750",                   "Qualcomm"],    // SD 8 Gen 3
        ["Adreno (TM) 650",                   "Qualcomm"],    // SD 865
        ["Mali-G610 MC6",                     "ARM"],         // Dimensity 9000
        ["Mali-G715 MC11",                    "ARM"],         // Dimensity 9200
        ["Mali-G720-Immortalis MC12",         "ARM"],         // Dimensity 9300
        ["PowerVR GM9446",                    "Imagination Technologies"], // Tensor G1
      ];

      const ua = navigator.userAgent;
      let h = 2166136261;
      for (let i = 0; i < ua.length; i++) { h ^= ua.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      const [renderer, vendor] = GPUS[h % GPUS.length];

      const UNMASKED_VENDOR_WEBGL   = 0x9245;
      const UNMASKED_RENDERER_WEBGL = 0x9246;
      const GL_VENDOR   = 0x1F00;
      const GL_RENDERER = 0x1F01;

      const patchCtx = (proto: WebGLRenderingContext) => {
        const origGetParam = proto.getParameter;
        proto.getParameter = function (param: number) {
          if (param === GL_VENDOR   || param === UNMASKED_VENDOR_WEBGL)   return vendor;
          if (param === GL_RENDERER || param === UNMASKED_RENDERER_WEBGL) return renderer;
          return origGetParam.call(this, param);
        };
        const origGetExt = proto.getExtension;
        proto.getExtension = function (name: string) {
          if (name === "WEBGL_debug_renderer_info") {
            return { UNMASKED_VENDOR_WEBGL, UNMASKED_RENDERER_WEBGL };
          }
          return origGetExt.call(this, name);
        };
      };

      try { patchCtx(WebGLRenderingContext.prototype  as unknown as WebGLRenderingContext); } catch { /* not available */ }
      try { patchCtx(WebGL2RenderingContext.prototype as unknown as WebGLRenderingContext); } catch { /* not available */ }
    })();

  }, mobile, meta, overrideTZ ?? null, apiUA ?? null);
}

export async function getOrCreateSession(
  profileId: number,
  userAgent: string,
  proxy?: ProxyConfig,
  userAgentApi?: string | null,
): Promise<Session> {
  // ── Electron native EB mode ────────────────────────────────────────────────
  if (IS_ELECTRON_EB) {
    const newProxyKey = proxy ? `${proxy.host}:${proxy.port}` : "direct";
    // Always update the map and always call /eb/open.
    // openEbWindow already handles "already open" by focusing the existing window,
    // so it is safe to call every time. The old fast-path (return early if same
    // proxyKey) caused a bug where the EB window would not reopen after being
    // closed/cleared because the stale electronSessions entry was never evicted.
    electronSessions.set(profileId, { ws: null, proxyKey: newProxyKey });
    const profile = await storage.getProfile(profileId).catch(() => null);
    await ebIpc("POST", "/eb/open", {
      profileId,
      username:  profile?.username  ?? String(profileId),
      password:  profile?.password  ?? "",
      twoFAKey:  profile?.twoFASecretKey ?? "",
      proxy:     proxy ? { host: proxy.host, port: proxy.port, user: proxy.username, pass: proxy.password } : undefined,
      userAgent: userAgent || undefined,
    }).catch(err => log(`[getOrCreate:${profileId}] EB open failed: ${err?.message}`, "browser"));
    return {} as unknown as Session;
  }
  // ── Puppeteer mode (dev / non-Electron) ───────────────────────────────────
  const newProxyKey = proxy ? `${proxy.host}:${proxy.port}` : "direct";
  const existing = sessions.get(profileId);

  // Fast-path: session already exists with the same proxy — return immediately.
  if (existing?.proxyKey === newProxyKey) return existing;

  // ── Concurrent-launch guard ───────────────────────────────────────────────
  // Multiple WS reconnects (e.g. Replit proxy bouncing) call this function
  // simultaneously before any session is stored.  Without a guard they each
  // see "no session" and each launch their own Chrome, creating leaked processes
  // and a race where the last writer wins the sessions Map.
  // Fix: first caller sets a flag; subsequent callers poll every 500 ms for up
  // to 20 s until the shared session appears, then return it directly.
  if (_launchingProfiles.has(profileId)) {
    log(`[getOrCreate:${profileId}] launch already in progress — waiting`, "browser");
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 500));
      const ready = sessions.get(profileId);
      if (ready?.proxyKey === newProxyKey) return ready;
      if (!_launchingProfiles.has(profileId)) break; // launch finished
    }
    const ready2 = sessions.get(profileId);
    if (ready2?.proxyKey === newProxyKey) return ready2;
    // Launch finished (possibly failed) or proxy changed — fall through.
  }

  // If session exists with a DIFFERENT proxy config, close and recreate it
  if (existing) {
    log(`Proxy changed for profile ${profileId} (${existing.proxyKey} → ${newProxyKey}), restarting browser`, "browser");
    await closeSession(profileId);
  }

  _launchingProfiles.add(profileId);

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
      _launchingProfiles.delete(profileId);
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
    _launchingProfiles.delete(profileId);
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
    _launchingProfiles.delete(profileId);
    throw new Error(msg);
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

  // Resolve proxy exit-IP timezone before injecting stealth scripts.
  // This ensures the browser's Date API timezone matches the proxy's country
  // rather than a randomly selected US/EU timezone from the fallback pool.
  let resolvedTZ: readonly [string, number, number] | undefined;
  if (proxy?.host && proxy?.port) {
    try {
      const iana = await resolveProxyTimezone(proxy.host, proxy.port, proxy.username, proxy.password);
      if (iana) {
        resolvedTZ = tzFromIana(iana);
        log(`Geo-timezone for profile ${profileId}: ${iana} → [${resolvedTZ.join(", ")}]`, "browser");
      }
    } catch { /* non-fatal — fall back to PRNG pool */ }
  }

  // Stealth: spoof all common headless-Chrome fingerprints that Instagram checks
  await applyStealthScripts(page, userAgent, resolvedTZ, userAgentApi);

  // ── Request filtering via CDP Fetch (replaces setRequestInterception) ─────────
  // page.setRequestInterception(true) pauses EVERY network request in Node.js and
  // requires a full CDP round-trip back to Chrome before each request can proceed.
  // With 20+ EBs open and 50–100 requests per page load, that is thousands of queued
  // CDP messages per navigation — request #500 waits for #1–499 to be acknowledged.
  // Result: pages that should load in 1–2 s take 30+ seconds under any real load.
  //
  // Fetch.enable with explicit resource-type patterns is the zero-overhead alternative:
  // only the ~5–10% of requests matching our block patterns (Media, Font, Image when
  // idle) are paused in Node.js; all other requests (XHR, Fetch, Document, Script,
  // Stylesheet, …) flow directly through Chrome with no Node.js involvement at all.
  // URL-pattern blocks (analytics/tracking) are handled by Network.setBlockedURLs —
  // also zero overhead, handled natively inside Chrome.
  const fetchCdp = await page.createCDPSession();

  // Intercept ONLY the challenge redirect URL — needed so startApprovalPolling can
  // capture the freshest token on each hop.  No image/font/media blocking here;
  // those restrictions caused pages to hang and white-screen.
  await fetchCdp.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*update_risky_contactpoint*", requestStage: "Request" },
    ]
  });

  fetchCdp.on("Fetch.requestPaused", (p: any) => {
    const { requestId, request, redirectedRequestId } = p;

    // Challenge redirect interceptor — abort REDIRECT hops (redirectedRequestId set)
    // to prevent Chrome hitting ERR_TOO_MANY_REDIRECTS, and capture the freshest
    // token URL so startApprovalPolling can re-navigate on each iteration.
    if (redirectedRequestId) {
      const sc = sessions.get(profileId);
      if (sc && (sc as any)._challengeRedirectInterceptor) {
        (sc as any)._challengeRedirectInterceptor(request.url);
      }
      fetchCdp.send("Fetch.failRequest", { requestId, errorReason: "Aborted" }).catch(() => {});
    } else {
      // First navigation to the challenge URL — let Chrome follow it normally.
      fetchCdp.send("Fetch.continueRequest", { requestId }).catch(() => {});
    }
  });

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
        if (s) {
          const isUrc = fullLoc.includes("update_risky_contactpoint");
          // For URC, always update to the latest redirect token so the polling
          // loop advances 20 hops per iteration instead of replaying TOKEN1.
          // For other challenge types, only capture once (the URL is stable).
          if (isUrc || !s.challengeUrl) {
            const firstDetection = !s.challengeUrl;
            s.challengeUrl = fullLoc;
            if (firstDetection) {
              log(`[challenge:${profileId}] Security challenge detected (${challengeStatus}) → ${fullLoc.slice(0, 120)}`, "browser");
              sendStatus(profileId, `⚠ Instagram security check required — navigating to challenge page…`);
              storage.getProfile(profileId).then(p => {
                if (p?.accountStatus !== "stopped") {
                  storage.updateProfile(profileId, { accountStatus: challengeStatus }).catch(() => {});
                }
              }).catch(() => {});
            }
          }
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
    if (err === "net::ERR_TOO_MANY_REDIRECTS") {
      if (!sc || !url.includes("instagram.com")) return;

      // ── update_risky_contactpoint (device-approval polling challenge) ─────────
      // Instagram's device-approval flow works by issuing a redirect loop at
      // update_risky_contactpoint with a fresh challenge_context token on every
      // hop.  The loop only breaks (returns 200) after the user approves from
      // their phone.  Server-side HTTP hop-following never works because:
      //   • each hop gets a new token in ~10 ms — far faster than a human can
      //     approve, so 80 server hops exhaust in ~2 s and always time out.
      // Fix: Chrome-polling loop.  Every 4 s we navigate Chrome directly to the
      // latest challenge URL (resetting its 20-hop counter), let the requestfailed
      // handler capture the newest token, then repeat.  When the phone approves,
      // Instagram returns 200 and Chrome lands on instagram.com.
      if (url.includes("update_risky_contactpoint")) {
        // sc.challengeUrl is already the latest Location token, updated by the
        // response handler on every 302 hop.  Do NOT overwrite it here — request.url()
        // is the original navigation URL (TOKEN1), not where Chrome stopped.
        if (!(sc as any)._approvalPolling) {
          (sc as any)._approvalPolling = true;
          sc.navProtectedUntil = Date.now() + 310_000; // 5 min + buffer

          Promise.resolve().then(async () => {
            // Escape chrome-error so Chrome can navigate again.
            await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5_000 }).catch(() => {});
            await startScreencast(profileId).catch(() => {});
            if (!(sc as any)._approvalStatusWritten) {
              (sc as any)._approvalStatusWritten = true;
              storage.getProfile(profileId).then(p => {
                if (p?.accountStatus !== "stopped") {
                  storage.updateProfile(profileId, { accountStatus: "captcha" }).catch(() => {});
                }
              }).catch(() => {});
            }

            // ── Step 1: in-Chrome hop-by-hop redirect follow ────────────────────
            // Chrome hard-limits 20 consecutive redirects per navigation.  We
            // intercept each 302 response via the _challengeRedirectInterceptor
            // hook, abort it, and re-navigate Chrome fresh — resetting the counter
            // to 0 on every hop.  Chrome follows the chain using its own HTTP stack
            // (identical TLS/HTTP2 fingerprint to a real browser), so Instagram
            // cannot distinguish it from a human clicking through.  When Instagram
            // finally returns 200, Chrome loads the actual challenge page in the EB.
            const startChallengeUrl = sessions.get(profileId)?.challengeUrl ?? url;
            sendStatus(profileId, `⚠ Instagram security check detected — loading challenge page…`);

            const inChromeResolved = await followChallengeRedirectsInChrome(
              profileId, page, startChallengeUrl, 30,
            );
            if (inChromeResolved) {
              const s2 = sessions.get(profileId);
              if (s2) {
                (s2 as any)._approvalPolling = false;
                s2.navProtectedUntil = Date.now() + 300_000;
              }
              log(`[challenge:${profileId}] URC challenge page loaded via in-Chrome hop-follow`, "browser");
              sendStatus(profileId, `⚠ Instagram verification required — complete the check shown in the browser.`);
              await startScreencast(profileId).catch(() => {});
              return;
            }
            log(`[challenge:${profileId}] in-Chrome hop-follow did not resolve (chain infinite) — falling back to phone-approval polling`, "browser");

            // ── Step 2 (fallback): phone-approval polling ────────────────────────
            // Only reached if the chain is genuinely infinite (account is aggressively
            // flagged and Instagram won't serve the page to any automated client).
            // The user must dismiss the alert on their phone; polling detects it.
            await startApprovalPolling(profileId, page);
          }).catch(() => { startApprovalPolling(profileId, page); });
        }
        return;
      }

      // ── Other challenge types — use server-side redirect-follow ───────────────
      // For captcha / checkpoint / email / phone challenges the final page IS
      // reachable after following a finite redirect chain.  Set the challengeUrl
      // from the failing request if the response listener didn't catch it first.
      if (!sc.challengeUrl) {
        const fallbackStatus = classifyEbChallengeUrl(url) ?? "login_approval";
        sc.challengeUrl = url;
        log(`[challenge:${profileId}] challengeUrl not captured from redirects — using requestfailed URL: ${url.slice(0, 120)}`, "browser");
        storage.getProfile(profileId).then(p => {
          if (p?.accountStatus !== "stopped") {
            storage.updateProfile(profileId, { accountStatus: fallbackStatus }).catch(() => {});
          }
        }).catch(() => {});
      }
      if (sc.challengeManualFollowAttempted) {
        sc.navProtectedUntil = Date.now() + 3600_000;
        log(`[challenge:${profileId}] manual redirect-follow already attempted, leaving parked on chrome-error.`, "browser");
        sendStatus(profileId, `⚠ Instagram verification page could not load. Open this link in your own browser: ${sc.challengeUrl}`);
        return;
      }
      sc.challengeManualFollowAttempted = true;
      sc.navProtectedUntil = Date.now() + 120_000;
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
        if (s2) s2.navProtectedUntil = Date.now() + 3600_000;
      });
    }
  });

  // ── CPU-spike diagnostics ────────────────────────────────────────────────
  // Count every network request by resourceType + path prefix in 30-second
  // buckets for the first 5 minutes of the session.  The bucket summary is
  // logged at the end of each window so the CPU-spike investigation can see
  // what Chrome is loading (and when) without relying on DevTools.
  const _diagStartMs = Date.now();
  const _diagWindow: Record<string, number> = {};

  // Monitoring-only — no req.continue/abort calls needed (Fetch.enable handles blocking).
  page.on("request", (req) => {
    if (isIgApiCall(req.url())) {
      pending.set(req.url(), { startMs: Date.now(), method: req.method() });
    }

    // ── Diag counter (first 5 minutes) ───────────────────────────────────────
    if (Date.now() - _diagStartMs < 5 * 60 * 1000) {
      const rType = req.resourceType();
      _diagWindow[rType] = (_diagWindow[rType] ?? 0) + 1;
      if (rType === "xhr" || rType === "fetch") {
        try {
          const u = new URL(req.url());
          const pathKey = u.pathname.split("/").slice(0, 4).join("/") || "/";
          _diagWindow[`xhr:${pathKey}`] = (_diagWindow[`xhr:${pathKey}`] ?? 0) + 1;
        } catch {}
      }
    }
  });

  // Monitoring-only — response events are informational (no CDP blocking).
  // The DB write is deferred via setImmediate so the synchronous better-sqlite3
  // write never blocks the Puppeteer event handler stack.  This keeps the CDP
  // message pump free to process the next incoming event immediately.
  page.on("response", (res) => {
    const url = res.url();
    const info = pending.get(url);
    if (!info) return;
    pending.delete(url);

    const opName = getOpName(url);
    if (NOISE_PATHS.has(opName)) return; // skip telemetry noise

    const durationMs = Date.now() - info.startMs;
    setImmediate(() => {
      try {
        void db.insert(instagramApiCalls).values({
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
  });
  // ────────────────────────────────────────────────────────────────────────────

  const session: Session = { browser, page, pages: [page], activePage: 0, ws: null, frameLoop: null, framePending: false, screencastCdp: null, housekeepLoop: null, lastScreencastFrameAt: Date.now(), lastUrl: "", proxyKey: newProxyKey, userAgent, userAgentApi: userAgentApi ?? null, sessionToken: Symbol(), lastActivityAt: Date.now(), startedAt: Date.now(), resolvedTZ };
  sessions.set(profileId, session);
  log(`Chrome launched for profile ${profileId}`, "browser");

  // ── CPU-spike diagnostic loop ─────────────────────────────────────────────
  // Runs every 30 s for the first 5 minutes.  Each tick:
  //   1. Logs the request-type counters accumulated since last tick (network).
  //   2. Calls CDP Performance.getMetrics() and logs the DELTA so the
  //      investigation can see which Chrome metric jumps at the ~2-min mark.
  // All lines are tagged [cpudiag:N] so they are easy to grep in the log file.
  {
    let _diagTick = 0;
    let _diagPrevMetrics: Record<string, number> = {};
    let _diagCdp: any = null;

    page.createCDPSession().then((cdp: any) => {
      _diagCdp = cdp;
      return cdp.send("Performance.enable", { timeDomain: "timeTicks" });
    }).catch(() => {});

    const _diagInterval = setInterval(async () => {
      _diagTick++;
      const ageS = _diagTick * 30;

      // ── Network request summary ──────────────────────────────────────────
      const snap = { ..._diagWindow };
      Object.keys(_diagWindow).forEach(k => delete _diagWindow[k]);
      const netLines = Object.entries(snap)
        .sort(([, a], [, b]) => b - a)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      log(`[cpudiag:${profileId}] t=${ageS}s NET ${netLines || "(none)"}`, "browser");

      // ── CDP Performance.getMetrics() ────────────────────────────────────
      if (_diagCdp) {
        try {
          const { metrics } = await _diagCdp.send("Performance.getMetrics");
          const cur: Record<string, number> = {};
          for (const m of metrics) cur[m.name] = m.value;

          // Log deltas for the metrics most likely to reveal a CPU spike.
          const keys = [
            "TaskDuration",       // total time on main thread tasks (seconds)
            "ScriptDuration",     // JS execution time (seconds)
            "LayoutDuration",     // layout time (seconds)
            "RecalcStyleDuration",// style recalc time (seconds)
            "JSHeapUsedSize",     // V8 live heap (bytes)
            "JSHeapTotalSize",    // V8 total heap (bytes)
            "Nodes",              // DOM node count
            "LayoutCount",        // layout operations count
            "RecalcStyleCount",   // style recalc count
          ];
          const parts: string[] = [];
          for (const k of keys) {
            if (cur[k] === undefined) continue;
            const prev = _diagPrevMetrics[k] ?? cur[k];
            const delta = cur[k] - prev;
            // Format: key=current(+delta)
            const fmt = k.includes("Size")
              ? `${Math.round(cur[k] / 1024)}KB`
              : k.includes("Duration")
                ? `${(cur[k] * 1000).toFixed(0)}ms(+${(delta * 1000).toFixed(0)}ms)`
                : `${cur[k]}(+${delta})`;
            parts.push(`${k}=${fmt}`);
          }
          _diagPrevMetrics = cur;
          log(`[cpudiag:${profileId}] t=${ageS}s CDP ${parts.join(" ")}`, "browser");
        } catch { /* CDP session may have closed */ }
      }

      // Stop after 5 minutes — diagnostics only needed for the spike window.
      if (ageS >= 300) {
        clearInterval(_diagInterval);
        if (_diagCdp) { _diagCdp.detach().catch(() => {}); _diagCdp = null; }
        log(`[cpudiag:${profileId}] diagnostic logging complete (5 min window)`, "browser");
      }
    }, 30_000);

    // Clean up if the session closes before 5 minutes.
    browser.on("disconnected", () => {
      clearInterval(_diagInterval);
      if (_diagCdp) { _diagCdp.detach().catch(() => {}); _diagCdp = null; }
    });
  }

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
      await applyStealthScripts(newPage, userAgent, sessions.get(profileId)?.resolvedTZ, sessions.get(profileId)?.userAgentApi);
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
  let cookiesLoaded = await loadCookies(profileId, page);

  // ── DB fallback: re-seed the JSON file from igApiCookies when the file is absent ──
  // The JSON seed file can be deleted by browserAutoLogin (proxy/network error causes
  // Chrome to land on a non-Instagram page → deleteSavedCookies fires), by the Clear
  // or Clear Cookies buttons, or by a crash during a previous session.  When that
  // happens loadCookies() returns false and the EB opens on the login page — even
  // though the DB may hold a perfectly valid, unexpired session.
  //
  // Fix: if no JSON file was loaded, check DB igApiCookies.  If it contains a
  // sessionid, reconstruct the Puppeteer-format cookie file from it and retry.
  // This makes the DB the authoritative recovery source, matching how Jarvee
  // handles cookie persistence across restarts.
  if (!cookiesLoaded) {
    try {
      const dbProfile = await storage.getProfile(profileId);
      const dbCookies: string = (dbProfile as any)?.igApiCookies ?? "";
      const hasSession = dbCookies.split(";").some(s => s.trim().startsWith("sessionid=") && s.includes("=") && s.split("=")[1]?.trim());
      if (hasSession) {
        log(`[cookies:${profileId}] JSON seed missing — re-seeding from DB igApiCookies`, "browser");
        const COOKIE_META: Record<string, { httpOnly: boolean; sameSite: string }> = {
          sessionid:  { httpOnly: true,  sameSite: "Lax" },
          csrftoken:  { httpOnly: false, sameSite: "Lax" },
          ds_user_id: { httpOnly: true,  sameSite: "Lax" },
          mid:        { httpOnly: false, sameSite: "Lax" },
          ig_did:     { httpOnly: false, sameSite: "Lax" },
          ig_nrcb:    { httpOnly: false, sameSite: "Lax" },
        };
        const parsed: Record<string, string> = {};
        for (const part of dbCookies.split(";")) {
          const eqIdx = part.indexOf("=");
          if (eqIdx < 1) continue;
          const name  = part.slice(0, eqIdx).trim();
          const value = part.slice(eqIdx + 1).trim();
          if (name) parsed[name] = value;
        }
        const puppeteerCookies = Object.entries(parsed).map(([name, value]) => {
          const meta = COOKIE_META[name] ?? { httpOnly: false, sameSite: "Lax" };
          return { name, value, domain: ".instagram.com", path: "/", expires: -1,
                   httpOnly: meta.httpOnly, secure: true, sameSite: meta.sameSite, session: false };
        });
        fs.mkdirSync(COOKIES_DIR, { recursive: true });
        fs.writeFileSync(cookiePath(profileId), JSON.stringify(puppeteerCookies, null, 2), "utf8");
        cookiesLoaded = await loadCookies(profileId, page);
        log(`[cookies:${profileId}] DB re-seed ${cookiesLoaded ? "succeeded ✓" : "failed — will open login page"}`, "browser");
      }
    } catch (e: any) {
      log(`[cookies:${profileId}] DB re-seed attempt failed (non-fatal): ${e?.message}`, "browser");
    }
  }

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

  _launchingProfiles.delete(profileId);
  return session;
}

/** True if the profile already has an open WS connection serving its EB session. */
export function hasActiveWS(profileId: number): boolean {
  if (IS_ELECTRON_EB) {
    const s = electronSessions.get(profileId);
    return !!(s?.ws && s.ws.readyState === WebSocket.OPEN);
  }
  const s = sessions.get(profileId);
  return !!(s?.ws && s.ws.readyState === WebSocket.OPEN);
}

export function detachWS(profileId: number, ws: WebSocket) {
  if (IS_ELECTRON_EB) {
    const s = electronSessions.get(profileId);
    if (s && s.ws === ws) s.ws = null;
    return;
  }
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
  if (IS_ELECTRON_EB) {
    let s = electronSessions.get(profileId);
    if (!s) {
      s = { ws: null, proxyKey: "direct" };
      electronSessions.set(profileId, s);
    }
    if (s.ws && s.ws.readyState === WebSocket.OPEN) {
      try { s.ws.send(JSON.stringify({ type: "replaced" })); s.ws.close(); } catch {}
    }
    s.ws = ws;
    log(`[attachWS:${profileId}] Electron native EB: WS attached`, "browser");
    wsWrite(ws, { type: "loginStatus", message: "✓ Instagram browser is open as a native window." });
    return;
  }
  const session = sessions.get(profileId);
  if (!session) return;

  // Cancel any pending Chrome-kill timer from a previous detachWS — the client
  // reconnected within the grace window, so Chrome stays alive.
  if ((session as any)._detachTimer) {
    clearTimeout((session as any)._detachTimer);
    (session as any)._detachTimer = null;
  }

  // Close any existing WebSocket connection for this profile.
  // Before closing, send a "replaced" message so the old client's onclose
  // handler knows not to schedule a reconnect — the session is being taken
  // over by a newer connection, not dropped by a server fault.
  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    try {
      session.ws.send(JSON.stringify({ type: "replaced" }));
      session.ws.close();
    } catch {}
  }
  session.ws = ws;

  // Start the screencast BEFORE firing any navigation so Chrome receives the
  // Page.startScreencast CDP command while it is idle.  If we start it after
  // page.goto(), Chrome queues the screencast command behind the full redirect
  // chain (up to 20 hops, ~8 s) and the frontend shows "Starting browser…" for
  // that entire time.  Starting first means the ACK comes back in <200 ms and
  // the frontend shows live frames immediately.
  startScreencast(profileId).catch(() => {});

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
  startHousekeepLoop(profileId);

  // The Replit proxy closes WebSocket connections that carry no application data
  // for ~4 s.  Static Chrome pages (challenge screens, idle IG pages) can go
  // completely silent for much longer than that, causing a constant 2–4 s
  // reconnect loop visible in the Replit preview (but not in the Windows
  // installer, which connects directly).
  // Send a WebSocket PING frame every 2 s.  This is the protocol-level keepalive
  // that Replit's proxy (and virtually every WS proxy) recognises.  A TEXT data
  // frame (the previous approach) is NOT counted as activity by some proxies that
  // only look at ping/pong for idle-timeout purposes.
  if ((session as any)._keepaliveInterval) clearInterval((session as any)._keepaliveInterval);
  (session as any)._keepaliveInterval = setInterval(() => {
    const s = sessions.get(profileId);
    if (!s?.ws || s.ws.readyState !== WebSocket.OPEN) {
      clearInterval((session as any)._keepaliveInterval);
      (session as any)._keepaliveInterval = null;
      return;
    }
    try { s.ws.ping(); } catch {}
  }, 2000);
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
  if (IS_ELECTRON_EB) {
    // In Electron mode the native window opens to the login page when no cookies
    // exist; we ask the ebManager to perform the login via its executeJavaScript
    // auto-login flow.  No need to check page URL — ebManager navigates itself.
    setTimeout(() => {
      if (!electronSessions.has(profileId)) return;
      log(`[autoLogin:${profileId}] Electron native EB: scheduling auto-login`, "browser");
      browserAutoLogin(profileId, username, password, twoFAKey)
        .then(result => sendLoginDone(profileId, result.ok, result.message))
        .catch(err  => sendLoginDone(profileId, false, String(err)));
    }, 3500);
    return;
  }
  setTimeout(() => {
    const s = sessions.get(profileId);
    if (!s || s.autoLoginInProgress) return;
    let url = "";
    try { url = s.page.url(); } catch { return; }
    if (!url.includes("instagram.com")) return;
    log(`[autoLogin:${profileId}] auto-trigger: Instagram page detected after initial navigation (${url.slice(0, 60)})`, "browser");
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
type ProxyCfg = { host: string; port: number; user?: string; pass?: string };

// Proxy-aware HTTPS one-hop via HTTP CONNECT tunnel.
// Chrome already goes through the account proxy, so server-side hops must too —
// Instagram serves different (correct) responses when the IP matches the session.
function _httpGetOneHopViaProxy(
  url: string,
  headers: Record<string, string>,
  proxy: ProxyCfg,
): Promise<{ status: number; location?: string; setCookies: string[] }> {
  return new Promise((resolve, reject) => {
    let urlObj: URL;
    try { urlObj = new URL(url); } catch (e) { return reject(e); }

    const sock = net.connect(proxy.port, proxy.host);
    let connectBuf = "";
    let tunnelReady = false;

    sock.setTimeout(15_000, () => { sock.destroy(new Error("proxy CONNECT timeout")); });
    sock.on("error", reject);

    sock.on("connect", () => {
      const auth = proxy.user && proxy.pass
        ? `\r\nProxy-Authorization: Basic ${Buffer.from(`${proxy.user}:${proxy.pass}`).toString("base64")}`
        : "";
      sock.write(`CONNECT ${urlObj.hostname}:443 HTTP/1.1\r\nHost: ${urlObj.hostname}:443${auth}\r\n\r\n`);
    });

    sock.on("data", (chunk) => {
      if (tunnelReady) return;
      connectBuf += chunk.toString("ascii");
      const eoh = connectBuf.indexOf("\r\n\r\n");
      if (eoh < 0) return;
      const connectStatus = parseInt((connectBuf.split("\r\n")[0] ?? "").split(" ")[1] ?? "0");
      if (connectStatus !== 200) {
        sock.destroy();
        return reject(new Error(`proxy CONNECT rejected: ${connectStatus}`));
      }
      tunnelReady = true;
      sock.removeAllListeners("data");
      sock.removeAllListeners("error");

      const tlsSock = tls.connect({ socket: sock, servername: urlObj.hostname, rejectUnauthorized: false });
      tlsSock.on("error", reject);
      tlsSock.on("secureConnect", () => {
        const reqPath = urlObj.pathname + (urlObj.search || "");
        tlsSock.write([
          `GET ${reqPath} HTTP/1.1`,
          `Host: ${urlObj.hostname}`,
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
          "Accept-Encoding: identity",
          "Connection: close",
          "", "",
        ].join("\r\n"));

        let resBuf = "";
        let headersDone = false;
        const result = { status: 0, location: undefined as string | undefined, setCookies: [] as string[] };

        tlsSock.on("data", (c) => {
          if (headersDone) return;
          resBuf += c.toString("latin1");
          const eoh2 = resBuf.indexOf("\r\n\r\n");
          if (eoh2 < 0) return;
          headersDone = true;
          const hLines = resBuf.slice(0, eoh2).split("\r\n");
          result.status = parseInt((hLines[0] ?? "").split(" ")[1] ?? "0");
          for (let i = 1; i < hLines.length; i++) {
            const col = (hLines[i] ?? "").indexOf(":");
            if (col < 0) continue;
            const k = hLines[i]!.slice(0, col).toLowerCase().trim();
            const v = hLines[i]!.slice(col + 1).trim();
            if (k === "location") result.location = v;
            else if (k === "set-cookie") result.setCookies.push(v);
          }
          tlsSock.destroy();
          resolve(result);
        });
        tlsSock.on("end", () => { if (!headersDone) reject(new Error("TLS ended before headers")); });
        tlsSock.on("close", () => { if (headersDone) resolve(result); });
      });
    });
  });
}

function _httpGetOneHop(
  url: string,
  headers: Record<string, string>,
  proxy?: ProxyCfg,
): Promise<{ status: number; location?: string; setCookies: string[] }> {
  if (proxy) return _httpGetOneHopViaProxy(url, headers, proxy);
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


// ── In-Chrome hop-by-hop redirect follower ───────────────────────────────────
// Chrome enforces a hard limit of 20 consecutive redirects per navigation.
// Instagram's update_risky_contactpoint challenge can return chains longer than
// 20 hops before serving the 200 challenge page.  This function follows each
// hop AS A SEPARATE CHROME NAVIGATION, resetting the counter on every step:
//
//   page.goto(tokenX) → Chrome follows one hop → our _challengeRedirectInterceptor
//   intercepts the redirect request, aborts it, we page.goto(tokenX+1) → repeat.
//
// Because we use Chrome's own HTTP stack for each hop (same TLS fingerprint,
// same HTTP/2 SETTINGS frames, same sec-fetch-* headers as a real browser),
// Instagram cannot distinguish us from a human clicking through the chain.
// When Instagram finally returns 200, Chrome loads the actual challenge page.
async function followChallengeRedirectsInChrome(
  profileId: number,
  page: Page,
  startUrl: string,
  maxHops = 120,
): Promise<boolean> {
  const sc = sessions.get(profileId);
  if (!sc) return false;

  let hopCount = 0;
  let resolved = false;
  let nextHopUrl: string | null = null;

  // Wire into the existing _challengeRedirectInterceptor hook so the
  // page.on("request") handler (which is already armed for interception)
  // notifies us of each redirect URL and aborts the follow automatically.
  (sc as any)._challengeRedirectInterceptor = (capturedUrl: string) => {
    nextHopUrl = capturedUrl;
  };

  try {
    let currentUrl = startUrl;
    const deadline = Date.now() + maxHops * 4_000;

    while (hopCount <= maxHops && Date.now() < deadline) {
      nextHopUrl = null;

      // Navigate Chrome.  If Instagram 302s, the interceptor aborts the redirect
      // and sets nextHopUrl; goto() then rejects with ERR_ABORTED.
      // If Instagram 200s, goto() resolves and page.url() is the challenge page.
      await page
        .goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 15_000 })
        .catch(() => {});

      // Brief pause — the interceptor callback fires async; let it settle.
      await new Promise<void>(r => setTimeout(r, 150));

      const finalUrl = page.url();

      if (
        !finalUrl.startsWith("chrome-error://") &&
        !finalUrl.startsWith("about:") &&
        finalUrl.includes("instagram.com")
      ) {
        log(
          `[challenge:${profileId}] in-Chrome hop ${hopCount}: loaded ${finalUrl.slice(0, 100)}`,
          "browser",
        );
        resolved = true;
        break;
      }

      if (!nextHopUrl) {
        log(
          `[challenge:${profileId}] in-Chrome hop ${hopCount}: no redirect captured — chain ended unexpectedly`,
          "browser",
        );
        break;
      }

      hopCount++;
      log(`[challenge:${profileId}] in-Chrome hop ${hopCount}: → ${nextHopUrl.slice(0, 100)}`, "browser");
      sc.challengeUrl = nextHopUrl;
      currentUrl = nextHopUrl;
    }

    if (hopCount > maxHops) {
      log(
        `[challenge:${profileId}] in-Chrome hop-follow: maxHops (${maxHops}) reached — chain is infinite`,
        "browser",
      );
    }
  } finally {
    delete (sc as any)._challengeRedirectInterceptor;
  }

  return resolved;
}


// ── Device-approval challenge handler ────────────────────────────────────────
// Poll for Instagram device-approval by navigating to the challenge URL every
// 5 seconds.  Between checks the EB shows a stable waiting page — giving the
// CDPSession screencast enough time to deliver frames so "Browser appears
// frozen" never fires.
//
// Why NOT the old 350 ms hop-by-hop approach:
//   The previous implementation called page.setContent() + page.goto() every
//   350 ms.  Chrome was perpetually mid-navigation, so the CDPSession never
//   delivered a complete frame — causing the EB to show "Browser appears
//   frozen" instead of any useful content.  Instagram's update_risky_
//   contactpoint URL always returns 302 until the user approves on their
//   phone, so the fast loop made no progress and only created visual chaos.
async function startApprovalPolling(profileId: number, page: Page): Promise<void> {
  const MAX_TIME_MS = 300_000;  // 5 minutes total
  const startMs = Date.now();
  let resolved = false;
  let checkCount = 0;

  log(`[challenge:${profileId}] URC: waiting for phone action (Dismiss or Approve) — polling for resolution`, "browser");
  sendStatus(profileId, `⚠ Open Instagram on your phone — if you see "We suspect automated behavior", tap Dismiss. If you see a login alert, tap Approve. This browser will update automatically once done.`);

  // Only start screencast if a viewer is actively watching — streaming JPEG frames
  // from about:blank to nobody burns Chrome renderer CPU on every open challenge
  // account simultaneously and contributes to event-loop saturation.
  {
    const sc0 = sessions.get(profileId);
    if (sc0?.ws?.readyState === WebSocket.OPEN) {
      await startScreencast(profileId).catch(() => {});
    }
  }

  // ── Stagger start to prevent N challenge accounts all polling at the same time ──
  // If multiple accounts hit URC challenge together (e.g. on app startup) they all
  // arrive here within seconds of each other.  Without a stagger every 30-second
  // poll fires simultaneously, creating a burst of 20+ CDP events per account
  // all at once.  A per-account random offset (0–20 s) spreads them out.
  const staggerMs = (profileId % 20) * 1_000 + Math.floor(Math.random() * 5_000);
  if (staggerMs > 0) {
    await new Promise<void>(r => setTimeout(r, staggerMs));
  }

  try {
    while (Date.now() - startMs < MAX_TIME_MS) {
      const sc = sessions.get(profileId);
      if (!sc || !(sc as any)._approvalPolling) {
        log(`[challenge:${profileId}] approval polling cancelled`, "browser");
        break;
      }

      checkCount++;
      const checkUrl = sessions.get(profileId)?.challengeUrl ?? "";
      if (!checkUrl?.includes("instagram.com")) break;

      log(`[challenge:${profileId}] approval check #${checkCount} — navigating Chrome to latest token`, "browser");

      // Navigate to the latest challenge URL.
      // Each call lets Chrome follow up to 20 more hops through its proxy:
      //   • Chain still unresolved → ERR_TOO_MANY_REDIRECTS → requestfailed
      //     handler updates sc.challengeUrl to the freshest token → retry
      //   • Chain resolved (ABD page) → Chrome lands on the challenge page
      //   • Device approved → Chrome lands on instagram.com feed
      // page.goto() itself blocks for the full navigation (4–6 s per batch),
      // so no explicit sleep is needed — the loop rate is self-throttled.
      await page
        .goto(checkUrl, { waitUntil: "domcontentloaded", timeout: 20_000 })
        .catch(() => {});

      const finalUrl = page.url();
      // Only chrome-error:// and about: mean Chrome truly couldn't load anything.
      // Any instagram.com URL (including update_risky_contactpoint with a 200)
      // means the page rendered — show it immediately.
      const onChromeError =
        finalUrl.startsWith("chrome-error://") ||
        finalUrl.startsWith("about:");

      if (!onChromeError && finalUrl.includes("instagram.com")) {
        const isChallengePage =
          finalUrl.includes("update_risky_contactpoint") ||
          finalUrl.includes("/challenge/");
        log(
          `[challenge:${profileId}] Chrome loaded: ${finalUrl.slice(0, 120)} — ${isChallengePage ? "challenge page rendered" : "device-approval confirmed"}`,
          "browser",
        );
        sendStatus(
          profileId,
          isChallengePage
            ? `⚠ Instagram verification required. Complete the check shown in the browser window.`
            : `✓ Device approved — browser loading Instagram.`,
        );
        resolved = true;
        const sc2 = sessions.get(profileId);
        if (sc2) {
          (sc2 as any)._approvalPolling = false;
          sc2.navProtectedUntil = Date.now() + 30_000;
        }
        await startScreencast(profileId).catch(() => {});
        break;
      }

      // ── Still on chrome-error — wait before retrying ─────────────────────
      // update_risky_contactpoint 302s to a new challenge_context token on
      // every hop. Chrome follows up to 20 hops then throws ERR_TOO_MANY_REDIRECTS
      // in < 1 second. Without a sleep here the loop hammers at ~3 req/s per
      // account, causing continuous CPU and network load.
      // The user needs to act on their phone — polling every 30 s is plenty.
      // Only restart screencast if a viewer is now watching (avoids streaming
      // about:blank JPEG frames to nobody and wasting Chrome renderer CPU).
      const scMid = sessions.get(profileId);
      if (scMid?.ws?.readyState === WebSocket.OPEN) {
        await startScreencast(profileId).catch(() => {});
      }
      log(`[challenge:${profileId}] still on chrome-error — waiting 30 s before next check`, "browser");
      await new Promise<void>(r => setTimeout(r, 30_000));
    }
  } finally {
    const scFinal = sessions.get(profileId);
    if (scFinal) delete (scFinal as any)._challengeRedirectInterceptor;
  }

  if (!resolved) {
    const sc2 = sessions.get(profileId);
    if (sc2) {
      (sc2 as any)._approvalPolling = false;
      sc2.navProtectedUntil = Date.now() + 3_600_000;
    }
    log(`[challenge:${profileId}] device-approval timed out after ${checkCount} checks`, "browser");
    sendStatus(profileId, `⚠ Verification timed out — no approval in 5 minutes. Press Clear EB Session and try again.`);
  }
}

async function followChallengeRedirects(
  profileId: number,
  page: Page,
  startUrl: string,
  proxy?: ProxyCfg,
  maxHops = 80,
): Promise<boolean> {
  const MAX_HOPS = maxHops;

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

    // Use the account's actual EB user-agent (never a hardcoded generic string).
    const sessionUA = sessions.get(profileId)?.userAgent ?? "";
    const makeHeaders = (): Record<string, string> => ({
      Cookie: [...cookieMap.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
      "User-Agent": sessionUA,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "X-IG-App-ID": "936619743392459",
    });

    let currentUrl = startUrl;

    for (let hop = 1; hop <= MAX_HOPS; hop++) {
      const result = await _httpGetOneHop(currentUrl, makeHeaders(), proxy);

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
        // Found the final page.
        // CRITICAL: sync all cookies accumulated across server-side hops back into
        // Chrome.  Instagram issues new Set-Cookie headers on every redirect hop
        // (fresh challenge_context tokens, updated session state, etc.).  Without
        // syncing, Chrome navigates with stale cookies → Instagram sees a different
        // session → issues a brand-new 20-hop chain → ERR_TOO_MANY_REDIRECTS again.
        // Syncing first gives Chrome the exact same cookie state the server had
        // when it received the 200, so Chrome also gets a 200 (or far fewer hops).
        const cookiesToSet = [...cookieMap.entries()]
          .filter(([, v]) => v !== "")
          .map(([name, value]) => ({
            name,
            value,
            domain: ".instagram.com",
            path: "/",
          }));
        if (cookiesToSet.length > 0) {
          await page.setCookie(...(cookiesToSet as any[])).catch(() => {});
          log(
            `[challenge:${profileId}] synced ${cookiesToSet.length} accumulated cookies back to Chrome`,
            "browser",
          );
        }
        log(
          `[challenge:${profileId}] chain resolved in ${hop} hops — navigating Chrome to: ${currentUrl.slice(0, 100)}`,
          "browser",
        );
        await page
          .goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 20_000 })
          .catch(() => {});
        // If Chrome still landed on chrome-error (synced cookies weren't enough),
        // treat as unresolved so the caller can fall back to polling.
        if (page.url().startsWith("chrome-error://")) {
          log(`[challenge:${profileId}] Chrome still on chrome-error after synced goto — treating as unresolved`, "browser");
          return false;
        }
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

function startScreencast(profileId: number, _retry = 0): Promise<void> {
  // Chain onto the global queue so concurrent calls from multiple EBs opening at
  // the same time run ONE AT A TIME.  Without this, simultaneous createCDPSession()
  // calls from N EBs flood the Puppeteer WebSocket protocol queue and Chrome stalls.
  _screencastStartQueue = _screencastStartQueue
    .catch(() => {})                          // never let a prior failure block the queue
    .then(() => _doStartScreencast(profileId, _retry));
  return _screencastStartQueue;
}

async function _doStartScreencast(profileId: number, _retry = 0): Promise<void> {
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

  // Adaptive JPEG quality only — resolution always stays at 1280×760.
  // Dropping maxWidth/maxHeight caused Chrome to send 720×430 frames that were
  // then stretched back to 1280×760 on the canvas, making the EB look blurry.
  // Quality reduction is enough to save bandwidth; resolution must stay full.
  const quality  = nSessions <= 1 ? 65 : nSessions <= 2 ? 55 : 45;
  const maxWidth = 1280;
  const maxHeight = 760;
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
  cdp.on("Page.screencastFrame", (params: any) => {
    // ── Back-pressure rate control ─────────────────────────────────────────
    // Chrome will not send the next frame until it receives the ACK for this one.
    // Delaying the ACK caps Chrome's compositor frame rate at the source.
    //
    // ACK delay is computed from the number of sessions that currently have
    // BOTH a live WS connection AND an active screencast (not just any session)
    // so background sessions without a viewer don't artificially inflate the delay.
    // Jitter (0–80 ms random) desynchronises sessions so their frames don't arrive
    // simultaneously and create a burst that saturates the Node.js event loop.
    //
    // Idle throttle: when no user input has occurred for >3 s the browser is just
    // sitting there — Chrome still encodes and sends frames at the full rate, which
    // pegs CPU on Windows (software compositor encodes 1280×760 JPEGs continuously).
    // Ramping the ACK delay up as the session goes idle cuts CPU dramatically:
    //
    //   active  (< 3 s since last input)  → base 100 ms → ~10 fps
    //   idle    (3–30 s since last input) → base 500 ms → ~2 fps
    //   dormant (> 30 s since last input) → base 2000 ms → ~0.5 fps
    //
    // The idle ramp resets the moment the user touches the browser again
    // (markActive() updates lastActivityAt on every mouse/keyboard event), so
    // responsiveness is instant — the next frame ACK goes out at the active rate.
    const nActive = [...sessions.values()].filter(
      sv => sv.screencastCdp !== null && sv.ws?.readyState === WebSocket.OPEN,
    ).length;
    const sessionNow = sessions.get(profileId);
    const idleMs = sessionNow ? Date.now() - sessionNow.lastActivityAt : 0;
    const idleBase = idleMs < 3_000 ? 0 : idleMs < 30_000 ? 1500 : 5000;
    const jitter = Math.floor(Math.random() * 80);
    const ackDelayMs = Math.max(100, nActive * 100) + idleBase + jitter;
    const capturedCdp = cdp;
    const capturedSessionId = params.sessionId;
    setTimeout(() => {
      capturedCdp.send("Page.screencastFrameAck", { sessionId: capturedSessionId }).catch(() => {});
    }, ackDelayMs);

    const s = sessions.get(profileId);
    // Always update the timestamp even when no WS client — the crash detector
    // uses this to know Chrome is alive.
    const now = Date.now();
    if (s) s.lastScreencastFrameAt = now;

    if (!s?.ws || s.ws.readyState !== WebSocket.OPEN) return;

    // ── Drop frame if one is already pending decode ────────────────────────
    // setImmediate defers the decode+send below to the next event loop iteration.
    // If another frame arrives before that tick fires (e.g. under burst load),
    // skip it entirely. This prevents a pile-up of base64 decodes on the event
    // loop that would block Express from processing API requests.
    if (s.framePending) return;
    s.framePending = true;

    // ── Defer decode + send to next event loop tick ────────────────────────
    // Buffer.from(base64) and ws.send() are synchronous and can block the event
    // loop for ~1–3 ms per frame. Deferring via setImmediate lets Express (and
    // any other pending IO callbacks) run between frames from different sessions,
    // preventing the "whole app freezes" symptom when 3+ EBs are streaming.
    setImmediate(() => {
      const sNow = sessions.get(profileId);
      if (!sNow) { s.framePending = false; return; }
      sNow.framePending = false;

      if (!sNow.ws || sNow.ws.readyState !== WebSocket.OPEN) return;

      // Decode base64 JPEG once on the server and send as a raw binary WebSocket
      // frame. The client uses binaryType="blob" + createImageBitmap() for
      // off-thread JPEG decode + requestAnimationFrame for compositing.
      const jpegBuf = Buffer.from(params.data, "base64");

      if (!firstFrameLogged) {
        firstFrameLogged = true;
        log(`[screencast:${profileId}] first frame received (${jpegBuf.length} bytes)`, "browser");
      }

      sNow.ws.send(jpegBuf);

      // URL changes are still sent as a small JSON text frame (rare, cheap).
      let currentUrl = sNow.lastUrl;
      try { currentUrl = sNow.page.url(); } catch {}
      if (currentUrl && currentUrl !== "about:blank" && currentUrl !== sNow.lastUrl) {
        sNow.lastUrl = currentUrl;
        wsWrite(sNow.ws, { type: "urlChange", url: currentUrl });
      }
    });
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
          maxWidth,
          maxHeight,
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
  // The WS may not be open yet on the very first attach (race between Chrome
  // launch and the WS upgrade completing).  Retry once after 1.5 s to cover
  // the gap — the second attempt clears the overlay for the normal startup path.
  const trySendScreencastStarted = () => {
    const s2 = sessions.get(profileId);
    if (s2?.ws && s2.ws.readyState === WebSocket.OPEN) {
      log(`[screencast:${profileId}] sending screencast_started to client`, "browser");
      wsWrite(s2.ws, { type: "screencast_started" });
      return true;
    }
    return false;
  };
  if (!trySendScreencastStarted()) {
    log(`[screencast:${profileId}] WS not open — will retry screencast_started in 1.5 s`, "browser");
    setTimeout(trySendScreencastStarted, 1500);
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

  let cookieSaveTick    = 0; // increments every 5s; save at 12 (=60s)
  let popupCheckTick    = 0; // increments every 5s; dismiss at 2 (=10s)
  let bannerCheckTick   = 0; // increments every 5s; dismiss cookie banner at 2 (=10s)
  let keepAliveTick     = 0; // increments every 5s; ping at 3 (=15s)
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

    // ── Cookie banner dismissal ────────────────────────────────────────────
    // Fires every 10 s while the EB is open. Instagram renders the consent
    // dialog asynchronously — the framenavigated handler may fire before it
    // appears. The real Puppeteer click inside dismissCookieBanner() is safe
    // to call even when no banner is visible (noop if nothing matches).
    bannerCheckTick++;
    if (bannerCheckTick >= 2) {
      bannerCheckTick = 0;
      dismissCookieBanner(s.page).catch(() => {});
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
    // TWO recovery paths:
    //
    //   PATH A — Active-freeze: user has clicked/typed within the last 30 s but
    //   no frame arrived in 20 s.  A click always triggers a compositor frame,
    //   so 20 s of silence after activity = screencast CDPSession stalled.
    //   Restart the screencast immediately, no ping needed.
    //
    //   PATH B — Idle crash: user was active 30–120 s ago and no frame for 30 s.
    //   Ping Chrome to confirm it is alive.  If alive → stalled screencast →
    //   restart screencast.  If dead → close session.
    if (s.screencastCdp && !(s as any)._crashPingInProgress) {
      const idleMs   = Date.now() - s.lastActivityAt;
      const silentMs = Date.now() - s.lastScreencastFrameAt;

      // PATH A: active-freeze — user is clicking but screencast stalled
      if (idleMs < 30000 && silentMs > 20000
          && !s.autoLoginInProgress && Date.now() > (s.navProtectedUntil ?? 0)
          && !s.challengeUrl && !(s as any)._screencastRestartInProgress) {
        (s as any)._screencastRestartInProgress = true;
        log(`[housekeep:${profileId}] active-freeze: last input ${idleMs}ms ago, no frame for ${silentMs}ms — restarting screencast`, "browser");
        stopScreencast(profileId).catch(() => {}).finally(() => {
          (s as any)._screencastRestartInProgress = false;
          const sAfter = sessions.get(profileId);
          if (sAfter?.ws?.readyState === WebSocket.OPEN) {
            startScreencast(profileId).catch(() => {});
          }
        });
      }

      // PATH B: idle crash check
      if (idleMs > 30000 && idleMs < 120000 && silentMs > 30000
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

  // Also dispatch a programmatic click via elementFromPoint.
  // Instagram's SPA and cookie consent banners often attach synthetic event listeners
  // that don't respond to raw mouse events alone. We also pierce shadow roots because
  // Instagram's cookie banner lives inside one on some surfaces.
  const dbg = await s.page.evaluate((cx, cy) => {
    // Helper: dispatch a full pointer+mouse+click sequence on a target element.
    // Some Instagram overlays only listen to pointerdown/up, not the raw mouse event.
    function fireClick(target: HTMLElement) {
      const opts = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy };
      target.dispatchEvent(new PointerEvent("pointerover", opts));
      target.dispatchEvent(new PointerEvent("pointerenter", { ...opts, bubbles: false }));
      target.dispatchEvent(new MouseEvent("mouseover", opts));
      target.dispatchEvent(new PointerEvent("pointerdown", opts));
      target.dispatchEvent(new MouseEvent("mousedown", opts));
      target.dispatchEvent(new PointerEvent("pointerup", opts));
      target.dispatchEvent(new MouseEvent("mouseup", opts));
      target.click();
      target.dispatchEvent(new MouseEvent("click", opts));
    }

    // Pierce shadow roots: elementFromPoint stops at shadow boundary.
    // We walk any open shadow roots to find the deepest real target.
    function deepElementFromPoint(root: Document | ShadowRoot, px: number, py: number): HTMLElement | null {
      const el = root.elementFromPoint(px, py) as HTMLElement | null;
      if (!el) return null;
      if (el.shadowRoot) {
        const deeper = deepElementFromPoint(el.shadowRoot, px, py);
        if (deeper) return deeper;
      }
      return el;
    }

    const el = deepElementFromPoint(document, cx, cy);
    if (!el) {
      return { found: false, tag: null, id: null, cls: null, clickedTag: null, shadowPierced: false };
    }

    const shadowPierced = el.getRootNode() !== document;
    const foundTag = el.tagName?.toLowerCase() ?? "?";
    const foundId = el.id ?? "";
    const foundCls = Array.from(el.classList).slice(0, 4).join(" ");

    // Walk up to 10 levels to find the nearest semantically clickable ancestor.
    let target: HTMLElement | null = el;
    for (let i = 0; i < 10 && target; i++) {
      const tag = target.tagName?.toLowerCase();
      const role = target.getAttribute("role")?.toLowerCase();
      const type = (target as HTMLInputElement).type?.toLowerCase();
      if (
        tag === "a" || tag === "button" || tag === "input" ||
        role === "button" || role === "link" || role === "checkbox" || role === "switch" ||
        type === "submit" || type === "button" || type === "checkbox"
      ) {
        fireClick(target);
        return { found: true, tag: foundTag, id: foundId, cls: foundCls, clickedTag: tag, shadowPierced };
      }
      target = target.parentElement ?? (target.getRootNode() as ShadowRoot).host as HTMLElement ?? null;
    }

    // Fallback: fire on whatever was directly under the cursor.
    fireClick(el);
    return { found: true, tag: foundTag, id: foundId, cls: foundCls, clickedTag: foundTag, shadowPierced };
  }, x, y).catch((err: Error) => {
    log(`[click:${profileId}] evaluate error: ${err?.message}`, "browser");
    return null;
  });

  if (dbg) {
    if (!dbg.found) {
      log(`[click:${profileId}] (${x},${y}) → no element found at point`, "browser");
    } else {
      log(
        `[click:${profileId}] (${x},${y}) → found <${dbg.tag}> id="${dbg.id}" cls="${dbg.cls}"` +
        ` | clicked <${dbg.clickedTag}>` +
        (dbg.shadowPierced ? " [shadow-pierced]" : ""),
        "browser"
      );
    }
  }

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
    await applyStealthScripts(newPage, s.userAgent, s.resolvedTZ, s.userAgentApi);
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
  if (IS_ELECTRON_EB) {
    const s = electronSessions.get(profileId);
    if (s) {
      if (s.ws && s.ws.readyState === WebSocket.OPEN) try { s.ws.close(); } catch {}
      electronSessions.delete(profileId);
    }
    // Always send /eb/close regardless of whether a server-side session entry exists.
    // The EB window may have been opened via electronAPI.openBrowserWindow() from the
    // frontend (e.g. user clicked the Browser button) which registers the window in
    // Electron's ebMap but never creates an electronSessions entry on the server side.
    // Without this unconditional IPC the window stays open after profile deletion.
    // The IPC handler is a no-op if no window is open, so this is always safe.
    await ebIpc("POST", "/eb/close", { profileId })
      .catch(err => log(`[closeSession:${profileId}] EB close failed: ${err?.message}`, "browser"));
    log(`EB window closed for profile ${profileId}`, "browser");
    return;
  }
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
  if (IS_ELECTRON_EB) {
    electronSessions.delete(profileId);
    await ebIpc("POST", "/eb/wipe", { profileId })
      .catch(err => log(`[wipeEbSession:${profileId}] EB wipe failed: ${err?.message}`, "browser"));
    log(`EB session wiped for profile ${profileId}`, "browser");
    return;
  }
  deleteSavedCookies(profileId);
  await closeSession(profileId, { skipCookieSave: true });
  // Same Windows file-handle race as clearEbSessionCookies — wait for Chrome to
  // fully release its locks before attempting the delete, with retries.
  const userDataDir = path.join(COOKIES_DIR, `userdata-${profileId}`);
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  for (let attempt = 1; attempt <= 3; attempt++) {
    await sleep(500);
    if (!fs.existsSync(userDataDir)) break;
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      log(`Deleted userDataDir for profile ${profileId} (attempt ${attempt}): ${userDataDir}`, "browser");
      break;
    } catch (e: any) {
      console.warn(`[browserSession] wipeEbSession rmSync attempt ${attempt}/3 failed for profile ${profileId}: ${e?.message}`);
    }
  }
  log(`EB session wiped for profile ${profileId}`, "browser");
}

/**
 * Clears ALL Instagram session state for a profile from the embedded browser.
 *
 * Used by the "Clear Cookies" button.  Behaviour is a complete wipe — nothing
 * is written back afterward:
 *   1. Closes the live EB session (skipCookieSave so no heartbeat write races in).
 *   2. Deletes Chrome's entire userdata directory — cookies, localStorage,
 *      IndexedDB, and Instagram's "saved login" bubble are all gone.
 *   3. Deletes the JSON cookie seed file.
 *
 * After this call, igApiCookies is null in the DB (set by the caller before
 * invoking this function) and accountStatus is "pending".  The next EB open
 * will show the Instagram login page with a completely blank slate.
 *
 * The optional igApiCookies parameter is kept for API compatibility but is no
 * longer used — device tokens are NOT written back.
 */
export async function clearEbSessionCookies(profileId: number, igApiCookies?: string): Promise<void> {
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  // 1. While Chrome is still running, use CDP to wipe cookies + storage in-process.
  //    This is the most reliable wipe path on Windows: even if the userDataDir file
  //    deletion fails (Chrome holds SQLite locks), Chrome will flush empty storage to
  //    disk before it exits because the in-memory state is already cleared.
  //    Without this, rmSync silently partially-deletes the directory, Chrome relaunches
  //    reading its own Cookies database, and the account appears still logged in.
  const liveSession = sessions.get(profileId);
  if (liveSession?.page) {
    try {
      const cdp = await (liveSession.page as any).createCDPSession();
      // Clear every cookie Chrome holds (all origins).
      await cdp.send("Network.clearBrowserCookies").catch(() => null);
      // Clear cookies + localStorage + IndexedDB + cache + service workers for IG.
      for (const origin of ["https://www.instagram.com", "https://i.instagram.com"]) {
        await cdp.send("Storage.clearDataForOrigin", {
          origin,
          storageTypes: "cookies,local_storage,indexedDB,service_workers,cache_storage",
        }).catch(() => null);
      }
      await cdp.detach().catch(() => null);
      log(`[clear:${profileId}] CDP wipe complete — cookies + localStorage + IndexedDB cleared in Chrome before close`, "browser");
    } catch (e: any) {
      console.warn(`[browserSession] CDP wipe failed for ${profileId} (non-fatal — will still delete files): ${e?.message}`);
    }
  }

  // 2. Close the running EB session without saving cookies back to disk.
  await closeSession(profileId, { skipCookieSave: true });

  // 3. Delete the ENTIRE Chrome userdata directory so ALL stored Instagram
  //    state is wiped — cookies, localStorage, IndexedDB, and the "saved login"
  //    account bubble that Instagram stores in localStorage.
  //
  //    On Windows, Chrome holds file handles open for 1–3 s after browser.close()
  //    resolves (Cookies SQLite WAL, localStorage LevelDB journal, etc.).
  //    We retry for up to 6 s (6 × 1 000 ms) to give the OS time to release locks.
  //    The CDP wipe above is the primary defence; the file deletion is belt-and-
  //    suspenders — even a partial delete removes the SQLite Cookies file.
  const userDataDir = path.join(COOKIES_DIR, `userdata-${profileId}`);
  let deleted = false;
  for (let attempt = 1; attempt <= 6; attempt++) {
    await sleep(1000);
    if (!fs.existsSync(userDataDir)) { deleted = true; break; }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      deleted = true;
      log(`Wiped Chrome userDataDir for profile ${profileId} (attempt ${attempt})`, "browser");
      break;
    } catch (e: any) {
      console.warn(`[browserSession] rmSync attempt ${attempt}/6 failed for profile ${profileId}: ${e?.message}`);
    }
  }
  if (!deleted && fs.existsSync(userDataDir)) {
    console.warn(`[browserSession] Could not fully delete userDataDir for profile ${profileId} after 6 s — CDP wipe already cleared cookies in-process`);
  }

  // 4. Delete the JSON cookie seed file (it contained the old session cookies).
  deleteSavedCookies(profileId);

  // 4. Write back ONLY the device tokens (mid, ig_did, ig_nrcb) to a fresh
  //    JSON seed file so Chrome picks them up on next open and the device
  //    fingerprint is preserved.  Without this Chrome would be assigned a
  //    brand-new mid/ig_did on first visit, which Instagram treats as a new
  //    device and can trigger security prompts.
  if (igApiCookies) {
    const DEVICE_NAMES = new Set(["mid", "ig_did", "ig_nrcb"]);
    const deviceCookies = igApiCookies
      .split(";")
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => DEVICE_NAMES.has(s.split("=")[0]?.trim().toLowerCase()))
      .map(pair => {
        const eqIdx = pair.indexOf("=");
        const name  = pair.slice(0, eqIdx).trim();
        const value = pair.slice(eqIdx + 1);
        return {
          name, value,
          domain: ".instagram.com",
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "Lax" as const,
          session: false,
          expires: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
        };
      });

    if (deviceCookies.length > 0) {
      try {
        fs.mkdirSync(COOKIES_DIR, { recursive: true });
        fs.writeFileSync(
          cookiePath(profileId),
          JSON.stringify(deviceCookies, null, 2),
          "utf8",
        );
        log(
          `Wrote ${deviceCookies.length} device token(s) back to cookie seed file for profile ${profileId}`,
          "browser",
        );
      } catch (e: any) {
        console.warn(
          `[browserSession] Could not write device cookie seed file for profile ${profileId}: ${e?.message}`,
        );
      }
    }
  }

  log(`EB session fully cleared for profile ${profileId} — all Chrome state wiped, device tokens preserved in seed file`, "browser");
}

// ── Auto-login via Puppeteer ─────────────────────────────────────────────────

// ── Cookie consent auto-dismissal ────────────────────────────────────────────
// Tries every known Instagram cookie banner selector and clicks Accept.
// Safe to call any time — silently does nothing if no banner is visible.
async function dismissCookieBanner(page: Page): Promise<void> {
  // Instagram's cookie consent buttons are React-controlled — a plain JS .click()
  // inside page.evaluate() fires a synthetic click that React's event delegation
  // may not pick up.  Instead, get the button's bounding rect from the DOM and
  // send a real Puppeteer mouse click (CDP Input.dispatchMouseEvent) which the
  // browser treats identically to a real user interaction.
  // Exact whitelist only — never txt.includes(t) which would match cookie
  // category toggles ("Functional cookies", "Analytics cookies", etc.)
  const ACCEPT_TEXTS = [
    "allow all cookies",
    "accept all cookies",
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
    "tillåt alla",           // Swedish
    "alle accepteren",       // Dutch
  ];
  try {
    const btnRect = await page.evaluate((texts: string[]) => {
      function isCookieAcceptBtn(btn: HTMLElement): boolean {
        const r = btn.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const txt = (btn.innerText || btn.textContent || "").trim().toLowerCase();
        return texts.indexOf(txt) !== -1;
      }
      // 1. Try Instagram's own data attribute first
      const attrBtn = document.querySelector<HTMLElement>('[data-cookiebanner="accept_button"]');
      if (attrBtn) {
        const r = attrBtn.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      // 2. Try known container selectors
      const container = document.querySelector<HTMLElement>(
        '[data-cookiebanner], [class*="CookieBanner"], [class*="cookie-banner"], [id*="cookie"]'
      );
      if (container) {
        const btn = Array.from(container.querySelectorAll<HTMLElement>('button, [role="button"]'))
          .find(isCookieAcceptBtn);
        if (btn) {
          const r = btn.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      // 3. Walk all buttons looking for known accept text
      const allBtns = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
      for (const btn of allBtns) {
        if (isCookieAcceptBtn(btn)) {
          const r = btn.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    }, ACCEPT_TEXTS).catch(() => null);

    if (btnRect) {
      await page.mouse.click(btnRect.x, btnRect.y);
    }
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
  const ws = IS_ELECTRON_EB
    ? (electronSessions.get(profileId)?.ws ?? null)
    : (sessions.get(profileId)?.ws ?? null);
  wsWrite(ws, { type: "loginStatus", message });
  log(`[autoLogin:${profileId}] ${message}`, "browser");
}

export function sendLoginDone(profileId: number, ok: boolean, message: string) {
  const ws = IS_ELECTRON_EB
    ? (electronSessions.get(profileId)?.ws ?? null)
    : (sessions.get(profileId)?.ws ?? null);
  wsWrite(ws, { type: "loginDone", ok, message });
  log(`[loginDone:${profileId}] ${ok ? "✅" : "❌"} ${message}`, "browser");
}

// Extract raw cookies from the active browser session page.
// Used by the verify route to hand browser-authenticated cookies to the API client.
export async function getSessionPageCookies(profileId: number): Promise<Array<{ name: string; value: string }>> {
  if (IS_ELECTRON_EB) {
    try {
      const res = await ebIpc("GET", `/eb/cookies?profileId=${profileId}`);
      return Array.isArray(res.cookies) ? res.cookies : [];
    } catch (err: any) {
      log(`[getSessionPageCookies:${profileId}] EB IPC error: ${err?.message}`, "browser");
      return [];
    }
  }
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

// Silent EB verify — runs the full login cycle in a hidden Electron BrowserWindow.
// Called by the /verify route in Electron mode so Verify never shows a visible EB window.
export async function electronSilentVerify(opts: {
  profileId: number;
  username: string;
  password: string;
  twoFAKey: string;
  proxy?: { host: string; port: number; user?: string; pass?: string };
  userAgent?: string;
}): Promise<{ ok: boolean; message: string; cookies: Array<{ name: string; value: string }> }> {
  if (!IS_ELECTRON_EB) {
    return { ok: false, message: "electronSilentVerify called outside Electron mode", cookies: [] };
  }
  try {
    const res = await ebIpc("POST", "/eb/silent-verify", opts);
    return {
      ok:      res.ok      ?? false,
      message: res.message ?? "",
      cookies: Array.isArray(res.cookies) ? res.cookies : [],
    };
  } catch (err: any) {
    log(`[electronSilentVerify:${opts.profileId}] IPC error: ${err?.message}`, "browser");
    return { ok: false, message: err?.message ?? "Silent verify IPC failed", cookies: [] };
  }
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
  if (IS_ELECTRON_EB) {
    sendStatus(profileId, "⟳ Starting auto-login in native browser window…");
    try {
      const result = await ebIpc("POST", "/eb/auto-login", {
        profileId, username, password, twoFAKey,
      });
      if (result.ok) sendStatus(profileId, "✅ Login successful");
      else           sendStatus(profileId, `❌ ${result.message}`);
      return result;
    } catch (err: any) {
      const msg = `Auto-login IPC error: ${err?.message}`;
      sendStatus(profileId, `❌ ${msg}`);
      return { ok: false, message: msg };
    }
  }
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

// ── Signup Browser Live Stream — exported API ─────────────────────────────────

async function _startSignupScreencast(): Promise<void> {
  if (!_signupPage || !_signupWs || _signupWs.readyState !== WebSocket.OPEN) return;
  if (_signupCdp) {
    try { await _signupCdp.send("Page.stopScreencast"); } catch {}
    _signupCdp = null;
  }
  let cdp: any;
  try {
    cdp = await (_signupPage as any).createCDPSession();
  } catch (e: any) {
    log(`[signup-screencast] createCDPSession failed: ${e?.message}`);
    return;
  }
  _signupCdp = cdp;
  cdp.on("Page.screencastFrame", (params: any) => {
    setTimeout(() => {
      cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    }, 120);
    const ws = _signupWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setImmediate(() => {
      try { ws.send(Buffer.from(params.data, "base64")); } catch {}
    });
  });
  try {
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 65, maxWidth: 1280, maxHeight: 760, everyNthFrame: 1 });
    try { _signupWs?.send(JSON.stringify({ type: "screencast_started" })); } catch {}
  } catch (e: any) {
    log(`[signup-screencast] startScreencast failed: ${e?.message}`);
  }
}

export async function signupBrowserInput(msg: { type: string; [key: string]: any }): Promise<void> {
  const page = _signupPage;
  if (!page) return;
  try {
    switch (msg.type) {
      case "navigate":
        if (_signupWs) wsWrite(_signupWs, { type: "loading", loading: true });
        await page.goto(msg.url as string, { waitUntil: "domcontentloaded", timeout: 20000 });
        if (_signupWs) wsWrite(_signupWs, { type: "loading", loading: false });
        break;
      case "click": {
        // Fire raw mouse click first, then dispatch a full synthetic event sequence
        // with shadow DOM piercing — same logic as browserClick() for regular accounts.
        // This ensures cookie banners and React-driven overlays respond in the ghost browser too.
        const cx = msg.x as number, cy = msg.y as number;
        await page.mouse.click(cx, cy);
        await page.evaluate((px, py) => {
          function fireClick(target: HTMLElement) {
            const opts = { bubbles: true, cancelable: true, composed: true, clientX: px, clientY: py };
            target.dispatchEvent(new PointerEvent("pointerover", opts));
            target.dispatchEvent(new PointerEvent("pointerenter", { ...opts, bubbles: false }));
            target.dispatchEvent(new MouseEvent("mouseover", opts));
            target.dispatchEvent(new PointerEvent("pointerdown", opts));
            target.dispatchEvent(new MouseEvent("mousedown", opts));
            target.dispatchEvent(new PointerEvent("pointerup", opts));
            target.dispatchEvent(new MouseEvent("mouseup", opts));
            target.click();
            target.dispatchEvent(new MouseEvent("click", opts));
          }
          function deepEl(root: Document | ShadowRoot, x: number, y: number): HTMLElement | null {
            const el = root.elementFromPoint(x, y) as HTMLElement | null;
            if (!el) return null;
            if (el.shadowRoot) { const d = deepEl(el.shadowRoot, x, y); if (d) return d; }
            return el;
          }
          const el = deepEl(document, px, py);
          if (!el) return;
          let t: HTMLElement | null = el;
          for (let i = 0; i < 10 && t; i++) {
            const tag = t.tagName?.toLowerCase();
            const role = t.getAttribute("role")?.toLowerCase();
            if (tag === "a" || tag === "button" || tag === "input" || role === "button" || role === "link") {
              fireClick(t); return;
            }
            t = t.parentElement ?? (t.getRootNode() as ShadowRoot).host as HTMLElement ?? null;
          }
          fireClick(el);
        }, cx, cy).catch(() => {});
        break;
      }
      case "mousemove":   await page.mouse.move(msg.x as number, msg.y as number); break;
      case "scroll":
        await page.mouse.move(msg.x as number, msg.y as number);
        await page.mouse.wheel({ deltaX: (msg.deltaX as number) ?? 0, deltaY: (msg.deltaY as number) ?? 0 });
        break;
      case "keydown":     await page.keyboard.down(msg.key as string); break;
      case "keyup":       await page.keyboard.up(msg.key as string); break;
      case "type": {
        const text = (msg.text as string) ?? "";
        await page.keyboard.type(text, { delay: 30 });
        // Fire a React-compatible synthetic input event on the currently focused element.
        // Instagram's React-controlled inputs (including OTP fields) need this to register
        // the value change in React state — keyboard.type() alone sometimes only updates
        // the DOM value without triggering React's onChange handler.
        await page.evaluate(() => {
          const el = document.activeElement as HTMLInputElement | null;
          if (!el || !["INPUT", "TEXTAREA"].includes(el.tagName)) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (setter) {
            setter.call(el, el.value);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }).catch(() => {});
        break;
      }
      case "fill": {
        // Select-all → delete → type: fills whatever field is focused in the EB
        const d = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
        await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
        await d(40); await page.keyboard.press("Backspace"); await d(40);
        await page.keyboard.type((msg.text as string) ?? "", { delay: 35 });
        // Fire React-compatible event after fill so controlled inputs register the value.
        await page.evaluate(() => {
          const el = document.activeElement as HTMLInputElement | null;
          if (!el || !["INPUT", "TEXTAREA"].includes(el.tagName)) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (setter) {
            setter.call(el, el.value);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }).catch(() => {});
        break;
      }
      case "keycombo":
        await page.keyboard.down(msg.modifier as string);
        await page.keyboard.press(msg.key as string);
        await page.keyboard.up(msg.modifier as string);
        break;
      case "back":        await page.goBack(); break;
      case "forward":     await page.goForward(); break;
      case "reload":      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }); break;
    }
  } catch { /* ignore individual input errors */ }
}

export async function attachSignupWS(ws: WebSocket): Promise<void> {
  if (_signupWs && _signupWs !== ws && _signupWs.readyState === WebSocket.OPEN) {
    try { _signupWs.close(); } catch {}
  }
  _signupWs = ws;
  if (_signupPage) {
    await _startSignupScreencast();
  } else {
    try { ws.send(JSON.stringify({ type: "waiting", message: "Waiting for browser to start\u2026" })); } catch {}
  }
}

export function detachSignupWS(ws: WebSocket): void {
  if (_signupWs !== ws) return;
  _signupWs = null;
  if (_signupCdp) {
    try { _signupCdp.send("Page.stopScreencast").catch(() => {}); } catch {}
    _signupCdp = null;
  }
}

// ── Standalone signup browser — open/close/reset ──────────────────────────────
// Launched when the user clicks "Open Browser" on the Create Account page.
// Unlike harvestSignupCookiesFromEB this browser stays open so the user can
// manually sign up. The page is streamed via the existing _signupPage / _signupWs
// pipeline — the BrowserPanel canvas shows the live Chrome tab.

export function isSignupBrowserOpen(): boolean {
  return !!_signupBrowser && !!_signupPage;
}

export async function openSignupBrowser(opts?: {
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  userAgent?: string;
}): Promise<{ ok: boolean; error?: string }> {
  // Always close any existing browser and wipe its data dir before launching a
  // fresh one.  This guarantees every attempt starts as a brand-new device with
  // no cookies, cache, or history carried over from the previous attempt.
  await closeSignupBrowser();

  let puppeteerLib: any;
  try {
    puppeteerLib = (await import("puppeteer-core")).default;
  } catch {
    try { puppeteerLib = (await import("puppeteer")).default; }
    catch (e: any) { return { ok: false, error: `Cannot load puppeteer: ${e?.message}` }; }
  }

  if (!CHROMIUM_PATH) return { ok: false, error: "No Chromium executable found" };

  // Per-attempt unique data dir — same pattern as createInstagramAccountViaEBForm.
  // A unique dir means Chrome never inherits cookies/cache from a previous attempt.
  const dataDir = path.join(COOKIES_DIR, `signup-browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  _signupDataDir = dataDir;
  fs.mkdirSync(dataDir, { recursive: true });

  // Use the full LAUNCH_ARGS set (same as the regular per-account EB) so the signup browser
  // gets all memory/performance flags: --renderer-process-limit=1, --js-flags heap cap,
  // --aggressive-cache-discard, etc.  Without these the heap can grow to 1.5 GB and
  // Chrome spawns extra processes — both cause the freezing the user sees.
  // We intentionally do NOT use HARVEST_ARGS here: those are for throwaway harvest sessions
  // where memory optimisation is irrelevant.
  const args: string[] = [...LAUNCH_ARGS, `--user-data-dir=${dataDir}`];
  if (opts?.proxyHost) args.push(`--proxy-server=${opts.proxyHost}:${opts.proxyPort ?? 80}`);

  let browser: any;
  try {
    browser = await puppeteerLib.launch({
      headless: true,
      executablePath: CHROMIUM_PATH,
      args,
      ignoreHTTPSErrors: true,
    });
  } catch (e: any) {
    return { ok: false, error: `Browser launch failed: ${e?.message}` };
  }

  _signupBrowser = browser;
  try {
    const [page] = await browser.pages();
    if (opts?.userAgent) await page.setUserAgent(opts.userAgent);
    // Use a mobile-matched viewport when a mobile UA is provided so Instagram's
    // JS sees correct screen dimensions and touch capabilities — a 1280×760 desktop
    // viewport against a mobile UA is an immediate detection signal.
    const vp = opts?.userAgent ? viewportForUA(opts.userAgent) : { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true as const, hasTouch: true };
    await page.setViewport(vp);
    if (opts?.proxyUsername) {
      await page.authenticate({ username: opts.proxyUsername, password: opts.proxyPassword ?? "" });
    }
    // Apply full JS-layer stealth BEFORE the first navigation so all
    // evaluateOnNewDocument hooks are registered: WebGL spoofing, canvas noise,
    // WebRTC lockdown, battery, screen dims, platform, etc.
    await applyStealthScripts(page, opts?.userAgent ?? "", undefined, undefined).catch(() => {});
    _signupPage = page;

    // Forward URL changes to the BrowserPanel address bar so the user can see
    // which page Instagram has navigated to (login, signup, challenge, etc.).
    // Also restart the screencast after every main-frame navigation: when Instagram
    // does a full-page navigation (signup form → email verification, etc.) the old
    // CDP session is tied to the previous renderer and stops delivering frames.
    // Creating a fresh CDP session after navigation keeps the stream alive.
    page.on("framenavigated", (frame: any) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (url && url !== "about:blank" && _signupWs && _signupWs.readyState === WebSocket.OPEN) {
        try { _signupWs.send(JSON.stringify({ type: "urlChange", url })); } catch {}
      }
      // Wait 500 ms for the new renderer to settle, then restart the screencast.
      // The delay prevents createCDPSession() from racing against an in-progress
      // renderer swap and keeps frame delivery continuous across navigations.
      setTimeout(() => { _startSignupScreencast().catch(() => {}); }, 500);
    });

    // Notify the frontend when Chrome disconnects unexpectedly (OOM crash, force
    // kill, etc.) so the BrowserPanel can update its status rather than showing
    // a frozen canvas forever.
    browser.on("disconnected", () => {
      _signupPage = null;
      _signupCdp  = null;
      _signupBrowser = null;
      if (_signupWs && _signupWs.readyState === WebSocket.OPEN) {
        try { _signupWs.send(JSON.stringify({ type: "waiting", message: "Browser disconnected unexpectedly. Click Open Ghost Browser to restart." })); } catch {}
      }
    });

    // Navigate first — wait until the DOM is ready so Chrome is in a stable state.
    // Starting the screencast BEFORE page.goto() was causing createCDPSession() to
    // fail silently on the second and subsequent attempts (Chrome is in a transitional
    // state during launch), which meant no frames ever arrived and the EB appeared
    // to constantly refresh or showed a frozen/blank canvas.
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 30000 });

    // Cookie banner is intentionally NOT auto-dismissed here.
    // Auto-clicking "Accept" triggered an Instagram redirect; a second scheduled
    // attempt fired mid-redirect and clicked a random element, causing the
    // "constantly refreshing" loop. The user can dismiss the banner manually.

    // Start screencast AFTER goto() — page is now in a stable state and
    // createCDPSession() will not conflict with an in-progress navigation.
    if (_signupWs && _signupWs.readyState === WebSocket.OPEN) {
      _startSignupScreencast().catch(() => {});
    }

    return { ok: true };
  } catch (e: any) {
    await closeSignupBrowser();
    return { ok: false, error: e?.message };
  }
}

export async function closeSignupBrowser(): Promise<void> {
  _signupPage = null;
  if (_signupCdp) {
    try { _signupCdp.send("Page.stopScreencast").catch(() => {}); } catch {}
    _signupCdp = null;
  }
  const wasOpen = !!_signupBrowser;
  if (_signupBrowser) {
    try { await _signupBrowser.close(); } catch {}
    _signupBrowser = null;
  }
  // Only notify the BrowserPanel when the browser was actually running.
  // Spurious "Browser closed." messages (from no-op calls when _signupBrowser
  // is already null) were confusing the WS state on the second attempt.
  if (wasOpen && _signupWs && _signupWs.readyState === WebSocket.OPEN) {
    try { _signupWs.send(JSON.stringify({ type: "waiting", message: "Browser closed." })); } catch {}
  }
  // Wipe the per-attempt data dir so no cookies/cache survive into the next attempt.
  // Chrome can still be flushing to disk after close(), so retry a few times.
  if (_signupDataDir) {
    const dirToDelete = _signupDataDir;
    _signupDataDir = null;
    await new Promise(r => setTimeout(r, 600));
    for (let attempt = 0; attempt < 3; attempt++) {
      try { fs.rmSync(dirToDelete, { recursive: true, force: true }); break; }
      catch { if (attempt < 2) await new Promise(r => setTimeout(r, 400)); }
    }
  }
}

export async function resetSignupBrowser(): Promise<void> {
  // closeSignupBrowser now handles both the browser teardown and the data dir wipe.
  await closeSignupBrowser();
}

// ── Electron EB — push arbitrary WS message to the BrowserPanel ──────────────
// Called by the /api/profiles/:id/eb-nav route so ebManager can push urlChange
// messages when the native BrowserWindow navigates.
export function sendEbWsMessage(profileId: number, msg: object): void {
  if (!IS_ELECTRON_EB) return;
  const s = electronSessions.get(profileId);
  if (!s?.ws) return;
  wsWrite(s.ws, msg);
}

// ── 2FA code fill + auto-submit ───────────────────────────────────────────────
// Finds the OTP code input on the current page, fills it with the supplied code,
// then finds and clicks the Continue / Submit button.  Safe to call at any time —
// does nothing if no OTP input is visible.
// ── EB-form account creation ──────────────────────────────────────────────────
// Fills and submits the Instagram web signup form in a real Chrome browser
// instead of calling the mobile API. Avoids signup_block rejections that the
// mobile API receives on datacenter/residential proxy traffic.

interface _EBSignupSession {
  browser: any;
  page: any;
  tmpDataDir: string;
  steps: string[];
}
const _pendingEBSignups = new Map<string, _EBSignupSession>();

async function _fillSignupInput(page: any, selectors: string[], value: string): Promise<boolean> {
  const d = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const box = await el.boundingBox();
      if (!box || box.width === 0 || box.height === 0) continue;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await d(150);
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      await d(80);
      await page.keyboard.press("Backspace");
      await d(100);
      await page.keyboard.type(value, { delay: 55 + Math.random() * 45 });
      await d(200);
      return true;
    } catch { continue; }
  }
  return false;
}

/** Returns true if sessionId is a pending EB signup (vs API-based signup). */
export function isEBSignupSession(sessionId: string): boolean {
  return _pendingEBSignups.has(sessionId);
}

export async function createInstagramAccountViaEBForm(params: {
  username: string;
  password: string;
  email: string;
  firstName: string;
  month: number;
  day: number;
  year: number;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  userAgent?: string;
  onStep?: (s: string) => void;
}): Promise<{
  status: "success" | "email_verification" | "phone_verification" | "error";
  message?: string;
  steps: string[];
  sessionCookies?: string[];
  sessionId?: string;
}> {
  const { username, password, email, firstName, month, day, year,
    proxyHost, proxyPort, proxyUsername, proxyPassword, userAgent, onStep } = params;
  const steps: string[] = [];
  const step = (msg: string) => { steps.push(msg); onStep?.(msg); console.log(`[ebSignup] ${msg}`); };
  const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  if (!proxyHost) {
    const msg = "[IP-LEAK BLOCKED] No proxy configured — a proxy is required for EB-form account creation";
    step(msg);
    return { status: "error", message: msg, steps };
  }

  let puppeteerLib: any;
  try {
    puppeteerLib = (await import("puppeteer-core")).default;
  } catch {
    try { puppeteerLib = (await import("puppeteer")).default; }
    catch (e: any) { return { status: "error", message: `Cannot load Puppeteer: ${e?.message}`, steps }; }
  }
  if (!CHROMIUM_PATH) return { status: "error", message: "No Chromium executable found", steps };

  const tmpDataDir = path.join(COOKIES_DIR, `signup-eb-form-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tmpDataDir, { recursive: true });

  const browserArgs = [...HARVEST_ARGS, `--user-data-dir=${tmpDataDir}`, `--proxy-server=${proxyHost}:${proxyPort ?? 80}`];

  let browser: any;
  try {
    browser = await puppeteerLib.launch({ headless: "new" as any, executablePath: CHROMIUM_PATH, args: browserArgs, ignoreHTTPSErrors: true });
    step("EB: Chrome launched ✓");
  } catch (e: any) {
    try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch {}
    return { status: "error", message: `Browser launch failed: ${e?.message}`, steps };
  }

  const cleanup = async () => {
    try { await browser.close(); } catch {}
    try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch {}
  };

  try {
    const [page] = await browser.pages();
    const effectiveUA = userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    await page.setUserAgent(effectiveUA);
    await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
    if (proxyUsername) await page.authenticate({ username: proxyUsername, password: proxyPassword ?? "" });

    // Apply stealth patches BEFORE any navigation so Instagram never sees the
    // headless fingerprint (navigator.webdriver, canvas, WebGL, battery, etc.)
    await applyStealthScripts(page, effectiveUA).catch((e: any) =>
      step(`EB: stealth warn: ${e?.message?.slice(0, 60)}`),
    );
    step("EB: stealth scripts applied ✓");

    // ── Navigate directly to the email signup URL (skipping homepage) ─────────
    // Using ?next= forces Instagram to show the email form instead of the phone gate.
    // We visit the homepage first only briefly to seed mid/ig_did device cookies,
    // then immediately go to the email signup URL.
    step("EB: visiting instagram.com homepage (seeding device cookies)...");
    try { await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60000 }); }
    catch (e: any) { step(`EB: homepage nav warning: ${e?.message?.slice(0, 80)}`); }
    await delay(1500);
    await dismissCookieBanner(page);

    const EMAIL_FORM_SELECTORS = 'input[aria-label="Email"], input[name="emailOrPhone"], input[type="email"], input[placeholder*="email" i], input[autocomplete="email"], input[name="email"], input[name="emailAddress"]';
    const PHONE_GATE_LABELS = ["sign up with email address", "sign up with email", "use email address", "use email", "use your email address"];

    const _waitForEmailForm = async (maxMs: number): Promise<boolean> => {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        const found = await page.evaluate((sel: string) => !!document.querySelector(sel), EMAIL_FORM_SELECTORS).catch(() => false);
        if (found) return true;
        await delay(400);
      }
      return false;
    };

    // ── Navigate directly to the email signup URL ────────────────────────────
    // Instagram redirects / to the phone gate — skip it entirely.
    // Navigate straight to /accounts/signup/email/ (the new SPA route) or
    // the legacy /accounts/emailsignup/ as a fallback. Both serve the email form.
    const EMAIL_URLS = [
      "https://www.instagram.com/accounts/signup/email/",
      "https://www.instagram.com/accounts/emailsignup/",
    ];
    let emailFormReady = false;
    for (const url of EMAIL_URLS) {
      step(`EB: navigating to ${url}...`);
      try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }); }
      catch (e: any) { step(`EB: nav warning: ${e?.message?.slice(0, 80)}`); }
      await dismissCookieBanner(page);
      await delay(800);
      emailFormReady = await page.waitForSelector(EMAIL_FORM_SELECTORS, { timeout: 6000 })
        .then(() => true).catch(() => false);
      if (emailFormReady) { step(`EB: email form ready at ${url} ✓`); break; }
      // Log what we see if not found
      const diagUrl = await page.evaluate(() => `${window.location.href} | inputs: ${Array.from(document.querySelectorAll("input")).map(i => i.getAttribute("aria-label") || i.type).join(",")}`).catch(() => "");
      step(`EB: email form not found at ${url} — ${diagUrl}`);
    }

    // Final diagnostic before attempting to fill
    const finalDiag = await page.evaluate(() => ({
      url: window.location.href,
      inputs: Array.from(document.querySelectorAll("input")).map(el => ({
        name: el.name, type: el.type, placeholder: el.placeholder,
        autocomplete: el.autocomplete, id: el.id, ariaLabel: el.getAttribute("aria-label"),
      })),
      bodySnippet: document.body.innerText.replace(/\s+/g, " ").slice(0, 400),
    })).catch(() => null);
    if (finalDiag) {
      step(`EB final diag: url=${finalDiag.url}`);
      step(`EB final diag: inputs=${JSON.stringify(finalDiag.inputs)}`);
      step(`EB final diag: page="${finalDiag.bodySnippet}"`);
    }
    try { await page.screenshot({ path: `/tmp/eb-diag-final.png`, fullPage: true }); } catch {}

    await delay(300);

    step("EB: filling signup form...");

    const emailFilled = await _fillSignupInput(page, [
      'input[aria-label="Email"]', 'input[name="emailOrPhone"]', 'input[type="email"]',
      'input[placeholder*="email" i]', 'input[autocomplete="email"]',
      'input[name="email"]', 'input[name="emailAddress"]',
    ], email);
    if (!emailFilled) {
      step("EB: could not find email input — Instagram may have changed their form layout");
      await cleanup();
      return { status: "error", message: "Could not find email field on Instagram's signup page — the form layout may have changed", steps };
    }
    // Tab out of the field to fire blur/change events — Instagram's React form
    // only enables the Next button after the email field loses focus and validates.
    await page.keyboard.press("Tab");
    await delay(600);
    step("EB: email filled ✓");
    await delay(200);

    await _fillSignupInput(page, ['input[name="fullName"]', 'input[placeholder*="full name" i]', 'input[placeholder*="name" i]'], firstName);
    step("EB: full name filled ✓");
    await delay(400);

    await _fillSignupInput(page, ['input[name="username"]', 'input[placeholder*="username" i]'], username);
    step("EB: username filled ✓");
    await delay(400);

    await _fillSignupInput(page, ['input[name="password"]', 'input[type="password"]', 'input[placeholder*="password" i]'], password);
    step("EB: password filled ✓");
    await delay(800);

    // Use real mouse click (page.mouse.click) — not btn.click() inside evaluate().
    // React's controlled forms require real OS-level pointer events; synthetic DOM
    // clicks dispatched from page.evaluate() are ignored by React for button submission.
    await delay(500); // let Instagram's async email-validation debounce settle
    const nextBtnCoords = await page.evaluate(() => {
      const LABELS = ["next", "sign up", "register", "create account", "continue"];
      for (const btn of Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))) {
        const txt = (btn.innerText || btn.textContent || "").trim().toLowerCase();
        if (LABELS.some(l => txt === l || txt.startsWith(l))) {
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      const sub = document.querySelector<HTMLElement>('button[type="submit"]');
      if (sub) { const r = sub.getBoundingClientRect(); if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
      return null;
    });
    const signUpClicked = !!nextBtnCoords;
    if (nextBtnCoords) {
      await page.mouse.move(nextBtnCoords.x, nextBtnCoords.y);
      await delay(100);
      await page.mouse.click(nextBtnCoords.x, nextBtnCoords.y);
    }
    if (!signUpClicked) {
      step("EB: could not find Sign Up button");
      await cleanup();
      return { status: "error", message: "Could not find Sign Up button on Instagram's signup form", steps };
    }
    step("EB: clicked Sign Up ✓ — waiting for next page...");
    // Poll for birthday form, verification step, or any sign of progress (up to 15 s)
    for (let _i = 0; _i < 30; _i++) {
      await delay(500);
      const nextReady = await page.evaluate(() => {
        const t = document.body.innerText.toLowerCase();
        return t.includes("birthday") || t.includes("date of birth") || t.includes("your age") ||
               t.includes("confirmation code") || t.includes("verify your email") ||
               t.includes("welcome") || t.includes("check your email") ||
               t.includes("we sent a code");
      }).catch(() => false);
      if (nextReady) break;
    }

    const onBirthday = await page.evaluate(() => {
      const t = document.body.innerText.toLowerCase();
      return t.includes("birthday") || t.includes("date of birth") || t.includes("your age");
    }).catch(() => false);

    if (onBirthday) {
      step("EB: filling birthday form...");
      const MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      await page.evaluate((m: number, mName: string, d: number, y: number) => {
        for (const sel of Array.from(document.querySelectorAll<HTMLSelectElement>("select"))) {
          const lbl = (sel.title || sel.getAttribute("aria-label") || "").toLowerCase();
          if (lbl.includes("month")) {
            for (const opt of Array.from(sel.options)) {
              if (opt.value === String(m) || opt.text === mName || opt.text.startsWith(mName.slice(0, 3))) {
                sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); break;
              }
            }
          }
          if (lbl.includes("day")) {
            for (const opt of Array.from(sel.options)) {
              if (opt.value === String(d) || opt.text === String(d)) {
                sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); break;
              }
            }
          }
          if (lbl.includes("year")) {
            for (const opt of Array.from(sel.options)) {
              if (opt.value === String(y) || opt.text === String(y)) {
                sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); break;
              }
            }
          }
        }
        for (const inp of Array.from(document.querySelectorAll<HTMLInputElement>("input"))) {
          const lbl = (inp.getAttribute("aria-label") || inp.placeholder || "").toLowerCase();
          if (lbl.includes("month")) { inp.value = String(m); inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); }
          else if (lbl.includes("day")) { inp.value = String(d); inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); }
          else if (lbl.includes("year")) { inp.value = String(y); inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); }
        }
      }, month, MONTHS[month] ?? "", day, year);
      await delay(600);
      step("EB: birthday filled ✓");

      await page.evaluate(() => {
        for (const btn of Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))) {
          const txt = (btn.innerText || btn.textContent || "").trim().toLowerCase();
          if (["next", "continue", "done", "confirm"].some(l => txt.includes(l))) {
            const r = btn.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) { btn.click(); return; }
          }
        }
      });
      step("EB: clicked Next on birthday ✓ — waiting for result...");
      // Poll for URL change or verification/welcome content (up to 20 s)
      const _preUrl = page.url();
      for (let _i = 0; _i < 40; _i++) {
        await delay(500);
        if (page.url() !== _preUrl) break;
        const nextReady = await page.evaluate(() => {
          const t = document.body.innerText.toLowerCase();
          return t.includes("confirmation code") || t.includes("verify your email") ||
                 t.includes("we sent a code") || t.includes("check your email") ||
                 t.includes("welcome") || t.includes("phone number");
        }).catch(() => false);
        if (nextReady) break;
      }
    }

    const finalUrl = page.url();
    const finalText = await page.evaluate(() => document.body.innerText).catch(() => "");
    step(`EB: result URL: ${finalUrl}`);

    if (finalUrl.includes("instagram.com") && !finalUrl.includes("/accounts/") && !finalUrl.includes("emailsignup")) {
      const allCookies = await page.cookies("https://www.instagram.com", "https://i.instagram.com") as Array<{ name: string; value: string }>;
      const cookieStrings = allCookies.map((c: any) => `${c.name}=${c.value}`);
      step(`EB: signup successful ✓ — ${cookieStrings.length} cookies extracted`);
      await cleanup();
      return { status: "success", steps, sessionCookies: cookieStrings };
    }

    const lowerText = finalText.toLowerCase();
    const needsEmailVerify = lowerText.includes("confirmation code") || lowerText.includes("confirm your email") ||
      lowerText.includes("we sent") || lowerText.includes("enter the code") || lowerText.includes("verification code") ||
      finalUrl.includes("confirm") || finalUrl.includes("verification");
    const needsPhoneVerify = !needsEmailVerify && lowerText.includes("phone") && (lowerText.includes("verify") || lowerText.includes("sms") || lowerText.includes("confirm"));

    if (needsEmailVerify || needsPhoneVerify) {
      const kind = needsEmailVerify ? "email" : "phone";
      step(`EB: ${kind} verification required`);
      const { randomUUID } = await import("node:crypto");
      const sessionId = randomUUID();
      _pendingEBSignups.set(sessionId, { browser, page, tmpDataDir, steps: [...steps] });
      setTimeout(async () => {
        const s = _pendingEBSignups.get(sessionId);
        if (s) {
          _pendingEBSignups.delete(sessionId);
          try { await s.browser.close(); } catch {}
          try { fs.rmSync(s.tmpDataDir, { recursive: true, force: true }); } catch {}
        }
      }, 15 * 60 * 1000);
      const msg = needsEmailVerify ? `Check ${email} for a 6-digit code` : "Enter the SMS code sent to your phone";
      return { status: needsEmailVerify ? "email_verification" : "phone_verification", steps, sessionId, message: msg };
    }

    const errEl = await page.evaluate(() => {
      for (const sel of ['[role="alert"]', 'p[id*="error"]', 'span[id*="error"]', 'div[class*="error" i] p']) {
        const el = document.querySelector<HTMLElement>(sel);
        if (el?.innerText?.trim()) return el.innerText.trim();
      }
      return null;
    }).catch(() => null);

    const errMsg = errEl ?? finalText.slice(0, 400);
    step(`EB: signup did not complete — ${errMsg.slice(0, 200)}`);
    await cleanup();
    return { status: "error", message: errMsg.slice(0, 400), steps };
  } catch (e: any) {
    step(`EB: unhandled exception — ${e?.message}`);
    await cleanup();
    return { status: "error", message: e?.message ?? "Unknown EB error", steps };
  }
}

export async function submitSignupCodeViaEB(sessionId: string, code: string): Promise<{
  status: "success" | "error";
  message?: string;
  steps: string[];
  sessionCookies?: string[];
}> {
  const session = _pendingEBSignups.get(sessionId);
  if (!session) return { status: "error", steps: [], message: "EB session not found — it may have expired" };

  const { browser, page, tmpDataDir, steps: prevSteps } = session;
  const steps = [...prevSteps];
  const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  const step = (msg: string) => { steps.push(msg); console.log(`[ebSignup] ${msg}`); };

  step(`EB: entering verification code...`);
  try {
    let filled = false;
    for (const sel of [
      'input[name="email_confirmation_code"]', 'input[autocomplete="one-time-code"]',
      'input[inputmode="numeric"]', 'input[name="verificationCode"]', 'input[name="code"]',
    ]) {
      const el = await page.$(sel).catch(() => null);
      if (!el) continue;
      const box = await el.boundingBox().catch(() => null);
      if (!box || box.width === 0) continue;

      // Check whether Instagram is using individual single-digit input boxes
      // (common on newer signup flows) — if so, type each digit into its own box.
      const isMultiBox = await page.evaluate((selector: string) => {
        const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(selector));
        const visible = inputs.filter(i => { const r = i.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        return visible.length > 1;
      }, sel).catch(() => false);

      if (isMultiBox) {
        // Multi-box OTP: type one digit per box, relying on auto-advance.
        const inputs = await page.$$(sel);
        for (let i = 0; i < inputs.length && i < code.length; i++) {
          const b = await inputs[i].boundingBox().catch(() => null);
          if (!b) continue;
          await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
          await delay(80);
          await page.keyboard.type(code[i], { delay: 50 });
          // Fire React-compatible event on each digit box.
          await page.evaluate(() => {
            const el = document.activeElement as HTMLInputElement | null;
            if (!el) return;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
            if (setter) { setter.call(el, el.value); el.dispatchEvent(new Event("input", { bubbles: true })); }
          }).catch(() => {});
          await delay(80);
        }
        filled = true;
        break;
      }

      // Single input box: click → clear → type code.
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await delay(150);
      await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
      await delay(80);
      await page.keyboard.press("Backspace");
      await delay(100);
      await page.keyboard.type(code, { delay: 70 });
      // Fire React-compatible input event so Instagram's controlled input registers the value.
      await page.evaluate(() => {
        const el = document.activeElement as HTMLInputElement | null;
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (setter) {
          setter.call(el, el.value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }).catch(() => {});
      filled = true;
      break;
    }
    if (!filled) return { status: "error", steps, message: "Could not find the verification code input on the page" };

    await delay(500);
    await page.evaluate(() => {
      for (const btn of Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))) {
        const txt = (btn.innerText || btn.textContent || "").trim().toLowerCase();
        if (["confirm", "next", "continue", "verify", "submit"].some(l => txt.includes(l))) {
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { btn.click(); return; }
        }
      }
    });
    step("EB: clicked Confirm ✓");
    await delay(5000);

    const url = page.url();
    const allCookies = await page.cookies("https://www.instagram.com", "https://i.instagram.com") as Array<{ name: string; value: string }>;
    const cookieStrings = allCookies.map((c: any) => `${c.name}=${c.value}`);
    const hasSession = cookieStrings.some(c => c.startsWith("sessionid="));

    if (hasSession || (url.includes("instagram.com") && !url.includes("/accounts/"))) {
      step(`EB: verification successful ✓ — ${cookieStrings.length} cookies extracted`);
      _pendingEBSignups.delete(sessionId);
      try { await browser.close(); } catch {}
      try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch {}
      return { status: "success", steps, sessionCookies: cookieStrings };
    }

    const pageText = await page.evaluate(() => document.body.innerText).catch(() => "");
    step(`EB: code submission did not complete — ${pageText.slice(0, 200)}`);
    return { status: "error", steps, message: `Verification failed — ${pageText.slice(0, 200)}` };
  } catch (e: any) {
    step(`EB: exception during code submit: ${e?.message}`);
    return { status: "error", steps, message: e?.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export async function browserFill2fa(profileId: number, code: string): Promise<void> {
  const s = sessions.get(profileId);
  if (!s) return;
  const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  // Try each selector in priority order
  const OTP_SELECTORS = [
    'input[autocomplete="one-time-code"]',
    'input[name="verificationCode"]',
    'input[name="verification_code"]',
    'input[name="security_code"]',
    'input[name="totp_code"]',
    'input[name="code"]',
    'input[inputmode="numeric"]',
  ];

  let filled = false;
  for (const sel of OTP_SELECTORS) {
    const el = await s.page.$(sel).catch(() => null);
    if (!el) continue;
    const box = await el.boundingBox().catch(() => null);
    if (!box || box.width === 0 || box.height === 0) continue;
    // Click the field to focus it
    await s.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await delay(120);
    // Select all existing content and replace with the code
    await s.page.keyboard.down("Control");
    await s.page.keyboard.press("a");
    await s.page.keyboard.up("Control");
    await delay(60);
    await s.page.keyboard.press("Backspace");
    await delay(80);
    await s.page.keyboard.type(code, { delay: 70 });
    filled = true;
    break;
  }
  if (!filled) return;

  await delay(350);

  // Find and click the Continue / Submit button
  const submitRect = await s.page.evaluate(() => {
    const SUBMIT = ["confirm", "continue", "submit", "verify", "next", "done", "ok"];
    const btns = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
    for (const btn of btns) {
      const txt = (btn.innerText || btn.textContent || "").trim().toLowerCase();
      if (SUBMIT.some(t => txt.includes(t))) {
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    // Fallback: any visible submit-type input
    const submits = Array.from(document.querySelectorAll<HTMLElement>('button[type="submit"], input[type="submit"]'));
    for (const el of submits) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    return null;
  }).catch(() => null);

  if (submitRect) {
    await s.page.mouse.click(submitRect.x, submitRect.y);
  }
}
