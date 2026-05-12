// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║                  ARCHITECTURE — READ THIS BEFORE TOUCHING ANYTHING          ║
// ╠══════════════════════════════════════════════════════════════════════════════╣
// ║                                                                              ║
// ║  THIS IS A MOBILE API BOT.                                                  ║
// ║                                                                              ║
// ║  ALL INSTAGRAM ACTIONS GO THROUGH THE MOBILE PRIVATE API (i.instagram.com). ║
// ║  This emulates a real Android Instagram app.  Every action — follow,        ║
// ║  unfollow, like, comment, DM, story view, profile read — uses the mobile    ║
// ║  API.  There are NO exceptions.                                              ║
// ║                                                                              ║
// ║  THE EMBEDDED BROWSER (EB) IS ONLY USED FOR:                                ║
// ║    • Manual browsing by the user (they are in control)                      ║
// ║    • Completing login challenges / CAPTCHAs so the API session recovers     ║
// ║    • NOTHING ELSE — the EB never performs automated actions                 ║
// ║                                                                              ║
// ║  NEVER:                                                                     ║
// ║    • Use Puppeteer / browser automation for any action                      ║
// ║    • Fall back to the EB browser when an API call fails                     ║
// ║    • Use www.instagram.com endpoints for automated actions                  ║
// ║                                                                              ║
// ║  CONFIRMED DEAD ENDS — do not retry, hours were wasted on these:            ║
// ║    • www.instagram.com DM broadcast  → returns 302 (blocked for API use)   ║
// ║    • i.instagram.com DM broadcast with web-origin cookies → 4415001        ║
// ║    • i.instagram.com create_group_thread with web cookies → login_required  ║
// ║    • fetch_headers as a bootstrap step → returns zero cookies, useless      ║
// ║    • instagram-private-api default v222 → checkpoint_required unsupported   ║
// ║      (fix: override ig.state.constants.APP_VERSION to MOBILE_VERSION)       ║
// ║                                                                              ║
// ║  MOBILE SESSION (mobileCookieJar / mobileCsrf):                             ║
// ║    • Created by _mobileLogin() — logs in via i.instagram.com mobile API    ║
// ║    • Seeded with locally-generated ig_did / mid / csrftoken=missing         ║
// ║    • App ID: 567067343352427  |  UA version: see MOBILE_VERSION constant    ║
// ║    • Must be established (via mobileLogin()) before any action is taken     ║
// ║                                                                              ║
// ║  DM SEND PATH (preferred when igApiCookies are available):                  ║
// ║    1. _restoreMobileFromApiCookies() seeds mobileCookieJar from stored      ║
// ║       igApiCookies + borrows csrftoken from the EB web jar                  ║
// ║    2. _sendDmViaIgClient() creates IgApiClient, restores cookies,           ║
// ║       patches APP_VERSION to MOBILE_VERSION, validates session via          ║
// ║       currentUser(), then calls directThread.broadcastText()                ║
// ║    3. Falls back to hand-rolled _mobileDmPost for accounts without          ║
// ║       igApiCookies (uses mobileCookieJar directly)                          ║
// ║                                                                              ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
import * as https from "https";
import * as fs from "fs";
import * as zlib from "zlib";
import { randomUUID, createCipheriv, createHmac, publicEncrypt, randomBytes, constants as cryptoConstants } from "crypto";
import { generateSync as totpGenerate } from "otplib";
import { userAgents as UA_POOL } from "../shared/userAgents";
import { IgApiClient, IgLoginTwoFactorRequiredError, IgLoginBadPasswordError } from "instagram-private-api";

// ── Low-level HTTPS helper ────────────────────────────────────────────────────
function httpsRequest(
  options: https.RequestOptions,
  body?: string | Buffer,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      res.on("end", () => {
        let raw = Buffer.concat(chunks);
        const enc = res.headers["content-encoding"];
        try {
          if (enc === "gzip")    raw = zlib.gunzipSync(raw);
          else if (enc === "deflate") raw = zlib.inflateSync(raw);
          else if (enc === "br") raw = zlib.brotliDecompressSync(raw);
        } catch { /* leave raw as-is if decompression fails */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers as any, body: raw.toString("utf8") });
      });
      // If the response stream itself errors (e.g. proxy drops mid-response)
      // reject so the caller can handle it rather than leaving a dangling promise.
      res.on("error", reject);
    });
    req.on("error", reject);
    // 25 s hard cap — dead proxies should fail fast, not pin a slot for 60 s.
    req.setTimeout(25000, () => { req.destroy(new Error("request_timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

async function igReq(opts: {
  host?: string;
  path: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  cookieJar?: string[];
  proxyUrl?: string;
}): Promise<{ status: number; cookies: string[]; json: any; rawBody: string; responseHeaders: Record<string, string | string[] | undefined> }> {
  const { host = "www.instagram.com", path, method, headers, body, cookieJar = [], proxyUrl } = opts;

  const reqHeaders: Record<string, string> = {
    ...headers,
    ...(cookieJar.length ? { Cookie: cookieJar.join("; ") } : {}),
    ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
  };

  let agent: any;
  if (proxyUrl) {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    // keepAlive: false — do not pool CONNECT-tunnel sockets across requests.
    // With the default (keepAlive: true) each igReq() call leaves a dangling
    // CONNECT tunnel open in the agent's socket pool.  After 30-60 min the proxy
    // provider's own session timer closes the tunnel on its side; the agent still
    // thinks it's open and hangs the next attempt until the 25 s request_timeout
    // fires.  Disabling keepAlive forces a fresh TCP connection every time and
    // eliminates the stale-socket accumulation bug.
    agent = new HttpsProxyAgent(proxyUrl, { keepAlive: false });
  }

  const t0 = Date.now();
  let res: Awaited<ReturnType<typeof httpsRequest>>;
  try {
    res = await httpsRequest(
      { host, port: 443, path, method, headers: reqHeaders, ...(agent ? { agent } : {}) },
      body,
    );
  } catch (err: any) {
    // Log proxy failures with enough detail to diagnose the degradation cause
    // (ECONNRESET = stale socket reused, ETIMEDOUT = proxy unreachable,
    //  ECONNREFUSED = proxy port closed, request_timeout = proxy hung).
    if (proxyUrl) {
      const proxyHost = (() => { try { return new URL(proxyUrl).hostname; } catch { return proxyUrl; } })();
      console.error(`[proxy:diag] ${method} ${host}${path} FAILED after ${Date.now() - t0}ms — proxy=${proxyHost} code=${err?.code ?? "?"} msg=${err?.message ?? err}`);
    }
    throw err;
  } finally {
    // Always destroy the agent so the CONNECT-tunnel socket is released
    // immediately rather than lingering in the pool until GC.
    if (agent) agent.destroy();
  }

  if (proxyUrl && Date.now() - t0 > 10000) {
    const proxyHost = (() => { try { return new URL(proxyUrl).hostname; } catch { return proxyUrl; } })();
    console.warn(`[proxy:diag] ${method} ${host}${path} SLOW ${Date.now() - t0}ms via proxy=${proxyHost} status=${res.status}`);
  }

  const raw = res.headers["set-cookie"];
  const newCookies: string[] = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(c => c.split(";")[0]);

  let json: any = null;
  try { json = JSON.parse(res.body); } catch {}

  return { status: res.status, cookies: newCookies, json, rawBody: res.body, responseHeaders: res.headers };
}

function mergeCookies(base: string[], overrides: string[]): string[] {
  const map = new Map<string, string>();
  for (const c of [...base, ...overrides]) map.set(c.split("=")[0], c);
  return Array.from(map.values());
}

function extractCsrf(cookies: string[]): string {
  for (const c of cookies) {
    if (c.startsWith("csrftoken=")) return c.split("=")[1];
  }
  return "";
}

// ── Instagram password encryption (enc_password) ─────────────────────────────
// Required for API v~200+ (2023+). Instagram provides a public RSA key via
// the qe/sync endpoint. We:
//   1. Generate a random AES-256 key + 12-byte IV
//   2. Encrypt the password with AES-256-GCM (AAD = unix timestamp string)
//   3. RSA-OAEP encrypt the AES key with Instagram's public key
//   4. Assemble: [0x01][keyId][iv 12B][rsaLen 2B LE][rsaEnc][gcmTag 16B][ciphertext]
//   5. Base64 → prefix #PWD_INSTAGRAM:4:<timestamp>:<base64>
function encryptPassword(plaintext: string, pubKeyBase64: string, keyId: number): string {
  const time = Math.floor(Date.now() / 1000);
  // Decode the base64-encoded PEM key Instagram sends in the qe/sync response header
  const pubKeyPem = Buffer.from(pubKeyBase64, "base64").toString("utf8");
  // AES-256-GCM: 32-byte key, 12-byte IV, timestamp string as AAD
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  cipher.setAAD(Buffer.from(String(time)));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = (cipher as any).getAuthTag() as Buffer; // 16 bytes
  // RSA PKCS#1 v1.5 — instagram-private-api uses RSA_PKCS1_PADDING, NOT OAEP.
  // Using OAEP causes TInvalidDecryptionException on Instagram's server (fbcrypto).
  const rsaEncrypted = publicEncrypt(
    { key: pubKeyPem, padding: cryptoConstants.RSA_PKCS1_PADDING },
    aesKey,
  );
  // Payload: [version=1][keyId][iv 12B][rsaLen 2B LE][rsaEncrypted][gcmTag 16B][ciphertext]
  const rsaLenBuf = Buffer.alloc(2);
  rsaLenBuf.writeUInt16LE(rsaEncrypted.length, 0);
  const payload = Buffer.concat([Buffer.from([1, keyId & 0xff]), iv, rsaLenBuf, rsaEncrypted, tag, enc]);
  return `#PWD_INSTAGRAM:4:${time}:${payload.toString("base64")}`;
}

// ── IgApiClient factory ───────────────────────────────────────────────────────
// instagram-private-api uses request-promise internally, which has NO default
// timeout.  When a proxy stops responding, every IgApiClient call hangs
// indefinitely, accumulating open file descriptors.  With 30+ accounts all
// hitting degraded proxies, the OS FD limit (~1024 on Linux) is exhausted in
// ~1 hour, after which the Express server stops accepting new connections and
// the dashboard/proxies go blank.  Setting a 30-second timeout on every client
// ensures hung calls fail fast instead of holding sockets open forever.
function newIgClient(): IgApiClient {
  const ig = new IgApiClient();
  ig.request.defaults = { timeout: 30000 };
  return ig;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const APP_ID  = "936619743392459";

/**
 * Patch the version code embedded at the end of an IgApiClient deviceString so it
 * always matches the APP_VERSION_CODE constant we are about to set.
 *
 * Instagram's UA format: "Instagram X.X Android (<android>; <dpi>; <res>; <brand>; <model>; <device>; <cpu>; <locale>; VERSION_CODE)"
 * The library assembles: "Instagram APP_VERSION Android (deviceString)"
 *
 * Two cases handled:
 *
 * 1. Old version code present (e.g. 558538758) but APP_VERSION_CODE is newer (651869969):
 *    The UA body version code does not match X-IG-App-Version — Instagram flags this
 *    as a fingerprint anomaly and rejects the login. Fix: replace the trailing code.
 *
 * 2. No version code at end (typical Jarvee export format — last segment is locale e.g. "en_US"):
 *    Jarvee's export file omits the version code from the "api user agent" column but
 *    Jarvee itself appends it internally when building the full UA. Without it, our
 *    bot sends a non-standard UA that differs from what Instagram saw in Jarvee.
 *    Fix: append the current version code so the UA matches a real Instagram app.
 */
function patchDeviceStringVersionCode(ig: IgApiClient, targetVersionCode: string): void {
  if (!ig.state.deviceString) return;
  const segs = ig.state.deviceString.split(";");
  const last = segs[segs.length - 1].trim();
  if (/^\d+$/.test(last)) {
    // Version code already present — update only if stale
    if (last !== targetVersionCode) {
      segs[segs.length - 1] = ` ${targetVersionCode}`;
      ig.state.deviceString = segs.join(";");
    }
  } else {
    // No version code at end (Jarvee export format) — append it
    ig.state.deviceString = ig.state.deviceString.trimEnd() + `; ${targetVersionCode}`;
  }
}

type ApiCallLogger = (op: string, durationMs: number, message?: string) => void;

// Keep this version current — Instagram rejects signup requests from versions
// older than a few months with error_type:"needs_upgrade".
// Play Store confirmed 427.0.0.47.73 on 2026-05-11.
// Version code estimated from the linear progression between known pairs:
//   222.0.0.13.114 → 350696709
//   384.0.0.36.112 → 663869969  (rate ≈ 1,933,168 / major version)
//   427.0.0.47.73  → 746996204  (estimated; update if Instagram rejects again)
const MOBILE_VERSION           = "427.0.0.47.73";
export const MOBILE_VERSION_CODE = "746996204";
// Date this version was last confirmed / updated. Warn after 90 days so there
// is time to update before Instagram starts rejecting the version.
const MOBILE_VERSION_DATE = "2026-05-11";
(() => {
  const ageMs = Date.now() - new Date(MOBILE_VERSION_DATE).getTime();
  const ageDays = Math.floor(ageMs / 86_400_000);
  if (ageDays > 90) {
    console.warn(
      `[webClient] ⚠️  MOBILE_VERSION (${MOBILE_VERSION}) was last updated ${ageDays} days ago.` +
      ` Instagram may be rejecting it — update MOBILE_VERSION + MOBILE_VERSION_CODE in instagramWebClient.ts.`
    );
  }
})();
const MOBILE_UA  = `Instagram ${MOBILE_VERSION} Android (33/13; 440dpi; 1080x2340; OPPO; CPH2609; OP5961L1; Snapdragon8sGen3; en_US; ${MOBILE_VERSION_CODE})`;
const MOBILE_AID = "567067343352427";
// HMAC-SHA256 signing key used by Instagram's mobile API.
// Instagram stopped validating the HMAC value itself around 2022, but the
// signed_body FORMAT (ig_sig_key_version=4&signed_body=HMAC.JSON) is still
// required — plain URL-encoded form data returns HTTP 400.
const IG_SIGNATURE_KEY = "9193488027538fd3450b83b7d05286d4ca9599a0f7eeed90d8c85925698a05dc";

/** Wrap a params object in Instagram's signed_body format */
function signBody(params: Record<string, unknown>): string {
  const json = JSON.stringify(params);
  const hmac = createHmac("sha256", IG_SIGNATURE_KEY).update(json).digest("hex");
  return new URLSearchParams({
    ig_sig_key_version: "4",
    signed_body: `${hmac}.${json}`,
  }).toString();
}

/**
 * Generate a randomised Instagram mobile User-Agent by picking a random device
 * from the shared UA pool (the same pool used by the Accounts page).
 * Call once per account-creation attempt — never share the same string across accounts.
 */
export function randomMobileUA(): string {
  const entry = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
  return `Instagram ${MOBILE_VERSION} Android (${entry.api}; ${MOBILE_VERSION_CODE})`;
}

// ── Public client class ───────────────────────────────────────────────────────
export class InstagramWebClient {
  private cookieJar: string[] = [];
  private csrfToken  = "";
  private proxyUrl?: string;
  private logCallFn?: ApiCallLogger;
  private profileId?: number;
  // User-agent to use for web (www.instagram.com) POST requests.
  // Should match the EB browser's UA so that cookies and UA are consistent.
  private webUserAgent = WEB_UA;

  // Separate mobile session (i.instagram.com) used exclusively for DM sending.
  // The web session cannot send DMs — i.instagram.com DM write endpoints require
  // a mobile login (i.instagram.com /api/v1/accounts/login/) session.
  private mobileCookieJar: string[] = [];
  private mobileCsrf = "";
  private mobileSessionReady = false;
  // Set by _mobileLogin when the failure is definitively bad credentials so
  // ensureClient can propagate the status to the DB without guessing.
  lastMobileLoginFailureReason: "bad_password" | null = null;

  // Device state from the profile — used by IgApiClient to maintain consistent
  // device fingerprint across mobile login attempts (same uuid/deviceId/phoneId).
  private igDeviceState?: string;
  private userAgentApi?: string;
  // Stored API cookies from the last successful Verify Credentials flow.
  // These are genuine i.instagram.com mobile session cookies and are tried
  // first in mobileLogin() to avoid triggering Instagram's new-device email
  // verification challenge.
  private igApiCookies?: string;

  // API throttle — enforces the per-profile "x calls every y seconds" limit.
  // Computed as a per-call delay = everySeconds / requestsCount, so all calls
  // are evenly spaced rather than firing in an instant burst.
  private throttleRequestsMin = 5;
  private throttleRequestsMax = 10;
  private throttleSecondsMin  = 3;
  private throttleSecondsMax  = 8;

  constructor(proxyUrl?: string, profileId?: number) {
    this.proxyUrl = proxyUrl;
    this.profileId = profileId;
  }

  setApiLimits(limits: { requestsMin: number; requestsMax: number; everySecondsMin: number; everySecondsMax: number }) {
    this.throttleRequestsMin = Math.max(1, limits.requestsMin);
    this.throttleRequestsMax = Math.max(1, limits.requestsMax);
    // everySecondsMin/Max are stored as milliseconds in the DB; convert to seconds for throttle logic
    this.throttleSecondsMin  = Math.max(0, limits.everySecondsMin / 1000);
    this.throttleSecondsMax  = Math.max(0, limits.everySecondsMax / 1000);
  }

  private async apiThrottle(): Promise<void> {
    // Pick random point in the configured rate range each call for natural variance
    const calls = this.throttleRequestsMin + Math.random() * (this.throttleRequestsMax - this.throttleRequestsMin);
    const secs  = this.throttleSecondsMin  + Math.random() * (this.throttleSecondsMax  - this.throttleSecondsMin);
    const delayMs = Math.floor((secs / Math.max(1, calls)) * 1000);
    if (delayMs > 10) {
      await new Promise<void>(r => setTimeout(r, delayMs));
    }
  }

  setDeviceInfo(igDeviceState?: string | null, userAgentApi?: string | null, igApiCookies?: string | null) {
    this.igDeviceState = igDeviceState ?? undefined;
    this.userAgentApi  = userAgentApi  ?? undefined;
    this.igApiCookies  = igApiCookies  ?? undefined;
    // Eagerly restore mobile session so isMobileLoggedIn() returns true immediately.
    // This lets ensureClient skip the web login when igApiCookies from a prior
    // Verify Credentials run are still valid.
    this._restoreMobileFromApiCookies();
  }

  // Parse igApiCookies (Jarvee-style "key=value;key=value" with URL-encoded values)
  // into mobileCookieJar and mark the mobile session ready.  Returns true if a
  // sessionid cookie was found and the session was seeded successfully.
  private _restoreMobileFromApiCookies(): boolean {
    if (!this.igApiCookies) return false;
    const pairs = this.igApiCookies.split(";").map(s => s.trim()).filter(Boolean);
    const cookies: string[] = [];
    for (const pair of pairs) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) continue;
      const key = pair.slice(0, eqIdx).trim();
      let value = pair.slice(eqIdx + 1).trim();
      try { value = decodeURIComponent(value); } catch { /* keep as-is */ }
      cookies.push(`${key}=${value}`);
    }
    if (!cookies.some(c => c.startsWith("sessionid="))) return false;
    // Ensure device-identity cookies are present
    if (!cookies.some(c => c.startsWith("ig_did="))) cookies.push(`ig_did=${randomUUID()}`);
    if (!cookies.some(c => c.startsWith("mid="))) {
      const mid = Buffer.from(randomUUID()).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
      cookies.push(`mid=${mid}`);
    }
    // igApiCookies never contains a csrftoken (Jarvee doesn't store it).
    // Seed with "missing" as a placeholder; _bootstrapMobileCsrf() will replace
    // it with a real token on the first mobileSessionPost call by doing a GET
    // to i.instagram.com using only the mobileCookieJar — no EB dependency.
    if (!cookies.some(c => c.startsWith("csrftoken="))) {
      cookies.push("csrftoken=missing");
    }

    this.mobileCookieJar = cookies;
    const csrfEntry = cookies.find(c => c.startsWith("csrftoken="));
    if (csrfEntry) this.mobileCsrf = csrfEntry.split("=").slice(1).join("=");
    this.mobileSessionReady = true;
    console.log(`[webClient] mobile session restored from igApiCookies (${cookies.length} cookies, sessionid=true, csrf=${this.mobileCsrf || "none"})`);
    return true;
  }

  setLogger(fn: ApiCallLogger) {
    this.logCallFn = fn;
  }

  // Set the user-agent for web POST requests so it matches the EB browser's UA.
  // This is critical — cookies are bound to the UA that created them.
  // Using a different UA than the EB browser causes Instagram to 302-redirect to login.
  setWebUserAgent(ua: string) {
    if (ua) this.webUserAgent = ua;
  }

  // ── Load cookies from the EB browser session ───────────────────────────────
  // Reads the Puppeteer cookie file and syncs those cookies into our jar so
  // the engine shares the same Instagram session as the embedded browser.
  // Returns true if a valid sessionid was found.
  loadBrowserCookies(): boolean {
    if (!this.profileId) return false;
    const filePath = `${process.cwd()}/server/browser-data/cookies-${this.profileId}.json`;
    try {
      if (!fs.existsSync(filePath)) return false;
      const raw = fs.readFileSync(filePath, "utf8");
      const puppeteerCookies: Array<{ name: string; value: string; domain?: string }> = JSON.parse(raw);
      if (!Array.isArray(puppeteerCookies)) return false;

      // Only take instagram.com cookies
      const igCookies = puppeteerCookies.filter(c => (c.domain ?? "").includes("instagram.com"));
      if (!igCookies.length) return false;

      // Convert to Set-Cookie strings for mergeCookies
      const asSetCookie = igCookies.map(c => `${c.name}=${c.value}`);

      // Merge, letting browser cookies win over stale engine cookies
      this.cookieJar = mergeCookies(this.cookieJar, asSetCookie);

      // Sync csrfToken from browser cookies
      const csrf = igCookies.find(c => c.name === "csrftoken");
      if (csrf) this.csrfToken = csrf.value;

      const hasSession = igCookies.some(c => c.name === "sessionid");
      console.log(`[webClient] loadBrowserCookies: synced ${igCookies.length} cookies, sessionid=${hasSession}, csrf=${!!csrf}`);
      return hasSession;
    } catch (err: any) {
      console.warn("[webClient] loadBrowserCookies failed:", err?.message);
      return false;
    }
  }

  private async timed<T>(opName: string, fn: () => Promise<T>, message?: string | ((result: T) => string), shouldLog?: (result: T) => boolean): Promise<T> {
    const t0 = Date.now();
    const result = await fn();
    const ms = Date.now() - t0;
    if (!shouldLog || shouldLog(result)) {
      const msg = typeof message === "function" ? message(result) : message;
      this.logCallFn?.(opName, ms, msg);
    }
    return result;
  }

  // Fetch a fresh CSRF token from the Instagram homepage using the existing session cookie.
  // Called automatically when a webPost returns 302 (stale CSRF), so the follow/unfollow
  // can be retried without requiring a full re-login — the sessionid is still valid.
  private async refreshCsrf(): Promise<boolean> {
    try {
      const res = await igReq({
        path: "/",
        method: "GET",
        headers: {
          Host: "www.instagram.com",
          "User-Agent": WEB_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        cookieJar: this.cookieJar,
        proxyUrl: this.proxyUrl,
      });
      if (res.status === 200) {
        this.cookieJar = mergeCookies(this.cookieJar, res.cookies);
        const newCsrf = extractCsrf(res.cookies);
        if (newCsrf) {
          this.csrfToken = newCsrf;
          console.log(`[webClient] refreshCsrf: new token acquired (${newCsrf.slice(0, 8)}...)`);
          return true;
        }
      }
      console.warn(`[webClient] refreshCsrf: GET / returned ${res.status}, no token found`);
      return false;
    } catch (err: any) {
      console.warn(`[webClient] refreshCsrf failed: ${err?.message}`);
      return false;
    }
  }

  // ── Login (web + 2FA TOTP) ─────────────────────────────────────────────────
  async login(username: string, password: string, twoFaSecret?: string): Promise<boolean> {
    return this.timed("Login", () => this._login(username, password, twoFaSecret), `@${username} login`);
  }

  private async _login(username: string, password: string, twoFaSecret?: string): Promise<boolean> {
    // Step 1 — get CSRF from login page
    const pageRes = await igReq({
      path: "/accounts/login/",
      method: "GET",
      headers: {
        Host: "www.instagram.com",
        "User-Agent": WEB_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      proxyUrl: this.proxyUrl,
    });

    let csrf = extractCsrf(pageRes.cookies);
    if (!csrf) {
      const m = pageRes.rawBody.match(/"csrf_token":"([^"]+)"/);
      if (m) csrf = m[1];
    }
    if (!csrf) { console.error("[webClient] login: no csrf on login page"); return false; }

    this.cookieJar = pageRes.cookies;
    this.csrfToken = csrf;

    // Step 2 — post credentials
    const ts = Math.floor(Date.now() / 1000);
    const body = new URLSearchParams({
      username,
      enc_password: `#PWD_INSTAGRAM:0:${ts}:${password}`,
      queryParams: "{}",
      optIntoOneTap: "false",
    }).toString();

    const loginRes = await igReq({
      path: "/accounts/login/ajax/",
      method: "POST",
      headers: {
        Host: "www.instagram.com",
        "User-Agent": WEB_UA,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRFToken": this.csrfToken,
        "X-IG-App-ID": APP_ID,
        "X-Requested-With": "XMLHttpRequest",
        Referer: "https://www.instagram.com/accounts/login/",
        Origin: "https://www.instagram.com",
      },
      body,
      cookieJar: this.cookieJar,
      proxyUrl: this.proxyUrl,
    });

    const j = loginRes.json;
    this.cookieJar = mergeCookies(this.cookieJar, loginRes.cookies);
    const newCsrf = extractCsrf(loginRes.cookies);
    if (newCsrf) this.csrfToken = newCsrf;

    if (j?.authenticated === true) {
      console.log(`[webClient] @${username}: logged in`);
      return true;
    }

    if (j?.two_factor_required) {
      const identifier: string = j?.two_factor_info?.two_factor_identifier ?? "";
      const secret = twoFaSecret?.replace(/\s+/g, "");
      if (!secret) { console.error(`[webClient] @${username}: 2FA required but no secret`); return false; }

      let code: string;
      try { code = totpGenerate({ secret }); } catch { console.error(`[webClient] @${username}: invalid 2FA secret`); return false; }

      const twoFaBody = new URLSearchParams({
        username,
        verificationCode: code,
        identifier,
        queryParams: "{}",
        verificationMethod: "3",
      }).toString();

      const tfRes = await igReq({
        path: "/accounts/login/ajax/two_factor/",
        method: "POST",
        headers: {
          Host: "www.instagram.com",
          "User-Agent": WEB_UA,
          Accept: "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded",
          "X-CSRFToken": this.csrfToken,
          "X-IG-App-ID": APP_ID,
          "X-Requested-With": "XMLHttpRequest",
          Referer: "https://www.instagram.com/accounts/login/",
          Origin: "https://www.instagram.com",
        },
        body: twoFaBody,
        cookieJar: this.cookieJar,
        proxyUrl: this.proxyUrl,
      });

      this.cookieJar = mergeCookies(this.cookieJar, tfRes.cookies);
      const tfCsrf = extractCsrf(tfRes.cookies);
      if (tfCsrf) this.csrfToken = tfCsrf;

      if (tfRes.json?.authenticated === true) {
        console.log(`[webClient] @${username}: 2FA OK`);
        return true;
      }
      console.error(`[webClient] @${username}: 2FA rejected: ${tfRes.rawBody.slice(0, 200)}`);
      return false;
    }

    console.error(`[webClient] @${username}: login failed: ${loginRes.rawBody.slice(0, 200)}`);
    return false;
  }

  isLoggedIn(): boolean {
    return this.cookieJar.some(c => c.startsWith("sessionid="));
  }

  isMobileLoggedIn(): boolean {
    return this.mobileSessionReady && this.mobileCookieJar.some(c => c.startsWith("sessionid="));
  }

  // ── Mobile API login (i.instagram.com) ─────────────────────────────────────
  // Establishes a separate mobile session used only for DM sending.
  // The web session (www.instagram.com) cannot send DMs — Instagram's DM write
  // endpoints on i.instagram.com require a session created via mobile login.

  // Fast path: when we already have a valid EB browser session, the same
  // sessionid + csrftoken cookies work on i.instagram.com without needing a
  // fresh password login.  Seeds mobileCookieJar from the existing web jar and
  // marks the mobile session ready immediately.
  mobileBootstrapFromWebCookies(): boolean {
    const sessionCookie = this.cookieJar.find(c => c.startsWith("sessionid="));
    const csrfCookie    = this.cookieJar.find(c => c.startsWith("csrftoken="));
    if (!sessionCookie) return false;

    const igDid = randomUUID();
    const mid   = Buffer.from(randomUUID()).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);

    // Seed mobile jar: keep sessionid + csrf from web session; add fresh device ids
    const seeds: string[] = [
      `ig_did=${igDid}`,
      `mid=${mid}`,
      sessionCookie,
    ];
    if (csrfCookie) seeds.push(csrfCookie);

    // Pull any other relevant web cookies (ds_user_id, rur) if present
    for (const c of this.cookieJar) {
      if (c.startsWith("ds_user_id=") || c.startsWith("rur=")) seeds.push(c);
    }

    this.mobileCookieJar = mergeCookies([], seeds);
    if (csrfCookie) this.mobileCsrf = csrfCookie.split("=").slice(1).join("=");
    this.mobileSessionReady = true;
    console.log(`[webClient] mobileBootstrapFromWebCookies: seeded mobile jar with ${this.mobileCookieJar.length} cookies (sessionid=true, csrf=${!!csrfCookie})`);
    return true;
  }

  async mobileLogin(username: string, password: string, twoFaSecret?: string): Promise<boolean> {
    return this.timed("MobileLogin", () => this._mobileLogin(username, password, twoFaSecret), `@${username} mobile login`);
  }

  private async _mobileLogin(username: string, password: string, twoFaSecret?: string): Promise<boolean> {
    // Fast path: if we have stored igApiCookies from a prior Verify Credentials,
    // use them directly — they are genuine mobile-API cookies and avoid triggering
    // Instagram's new-device email challenge on every restart.
    if (this._restoreMobileFromApiCookies()) {
      return true;
    }

    // Slow path: fresh login via IgApiClient (RSA-encrypted passwords).
    // instagram-private-api handles #PWD_INSTAGRAM:4: — Instagram deprecated
    // the plaintext :0: format and returns "Forgotten password" for it.
    const ig = newIgClient();
    // Include username in seed so accounts sharing the same userAgentApi get distinct device fingerprints.
    const deviceSeed = (this.userAgentApi ?? username) + "|" + username;

    if (this.igDeviceState) {
      try {
        const saved = JSON.parse(this.igDeviceState);
        ig.state.generateDevice(deviceSeed);
        if (saved.deviceId)     ig.state.deviceId     = saved.deviceId;
        if (saved.uuid)         ig.state.uuid         = saved.uuid;
        if (saved.phoneId)      ig.state.phoneId      = saved.phoneId;
        if (saved.adid)         ig.state.adid         = saved.adid;
        if (saved.deviceString) ig.state.deviceString = saved.deviceString;
      } catch {
        ig.state.generateDevice(deviceSeed);
        if (this.userAgentApi) ig.state.deviceString = this.userAgentApi;
      }
    } else {
      ig.state.generateDevice(deviceSeed);
      if (this.userAgentApi) ig.state.deviceString = this.userAgentApi;
    }

    // Always patch app version constants — use version from full UA string when present,
    // otherwise fall back to MOBILE_VERSION so the library's stale default never leaks.
    {
      const m = (this.userAgentApi ?? "").match(/^Instagram ([\d.]+) Android \(([^)]+)\)/);
      let version = MOBILE_VERSION, versionCode = MOBILE_VERSION_CODE, src = "fallback";
      if (m) {
        const parts = m[2].split(";");
        const vc = parts[parts.length - 1].trim();
        if (/^\d+$/.test(vc)) { version = m[1]; versionCode = vc; src = "from UA"; }
      }
      ig.state.constants.APP_VERSION      = version;
      ig.state.constants.APP_VERSION_CODE = versionCode;
      patchDeviceStringVersionCode(ig, versionCode);
      console.log(`[webClient] @${username}: APP_VERSION=${version} APP_VERSION_CODE=${versionCode} (${src})`);
    }

    if (this.proxyUrl) ig.state.proxyUrl = this.proxyUrl;

    // Fetch RSA encryption keys — required before login or Instagram rejects
    try {
      await ig.request.send({
        method: "GET",
        url: "/api/v1/si/fetch_headers/",
        qs: { challenge_type: "signup", guid: ig.state.uuid },
      });
    } catch { /* non-fatal — try next strategy */ }

    if (!ig.state.passwordEncryptionPubKey) {
      try { await ig.qe.syncLoginExperiments(); } catch { /* non-fatal */ }
    }

    if (!ig.state.passwordEncryptionPubKey) {
      console.error(`[webClient] @${username}: could not fetch encryption keys for mobile login`);
      return false;
    }

    console.log(`[webClient] @${username}: mobile login via IgApiClient (keyId=${ig.state.passwordEncryptionKeyId})`);

    try {
      await ig.account.login(username, password);
    } catch (err: any) {
      if (err instanceof IgLoginTwoFactorRequiredError) {
        const secret = twoFaSecret?.replace(/\s+/g, "");
        if (!secret) { console.error(`[webClient] @${username}: mobile 2FA required but no secret`); return false; }
        let code: string;
        try { code = totpGenerate({ secret }); } catch { console.error(`[webClient] @${username}: invalid 2FA secret`); return false; }
        const twoFactorInfo = err.response.body.two_factor_info;
        try {
          await ig.account.twoFactorLogin({
            username,
            verificationCode: code,
            twoFactorIdentifier: twoFactorInfo.two_factor_identifier,
            verificationMethod: "0",
            trustThisDevice: "1",
          });
        } catch (e2: any) {
          console.error(`[webClient] @${username}: mobile 2FA rejected: ${e2?.message}`);
          return false;
        }
      } else if (err instanceof IgLoginBadPasswordError) {
        const body = err?.response?.body ?? {};
        const rawBody = JSON.stringify(body).slice(0, 1500);
        console.error(`[webClient] @${username}: IgLoginBadPasswordError raw body: ${rawBody}`);
        const buttons: any[] = body?.buttons ?? [];
        const needsEmail = buttons.some((b: any) => b?.action === "send_one_click_login_email");
        const errorTitle: string = body?.error_title ?? "";
        const errorType: string = body?.error_type ?? body?.feedback_title ?? "";
        if (needsEmail) {
          console.error(`[webClient] @${username}: mobile login — Instagram says: "${errorTitle}" (email action present). error_type="${errorType}"`);
        } else {
          console.error(`[webClient] @${username}: mobile login — bad password / device rejected. error_type="${errorType}" error_title="${errorTitle}"`);
          // Signal to ensureClient that this is definitively wrong credentials, not a transient error.
          this.lastMobileLoginFailureReason = "bad_password";
        }
        return false;
      } else {
        console.error(`[webClient] @${username}: mobile login error (${err?.constructor?.name}): ${err?.message}`);
        return false;
      }
    }

    // Extract cookies from IgApiClient's tough-cookie jar into our flat string array
    try {
      const serialized = await ig.state.serializeCookieJar();
      const jar = JSON.parse(serialized);
      const WANTED = new Set(["sessionid", "csrftoken", "ds_user_id", "rur", "mid", "ig_did"]);
      const extracted: string[] = (jar.cookies ?? [])
        .filter((c: any) => WANTED.has(c.key))
        .map((c: any) => `${c.key}=${c.value}`);

      // Ensure ig_did and mid are present (may not be in jar — add from device state)
      if (!extracted.some(c => c.startsWith("ig_did="))) {
        const igDid = randomUUID();
        extracted.push(`ig_did=${igDid}`);
      }
      if (!extracted.some(c => c.startsWith("mid="))) {
        const mid = Buffer.from(randomUUID()).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
        extracted.push(`mid=${mid}`);
      }

      if (!extracted.some(c => c.startsWith("sessionid="))) {
        console.error(`[webClient] @${username}: IgApiClient login OK but no sessionid in cookie jar`);
        return false;
      }

      this.mobileCookieJar = extracted;
      const csrfEntry = extracted.find(c => c.startsWith("csrftoken="));
      if (csrfEntry) this.mobileCsrf = csrfEntry.split("=").slice(1).join("=");
      this.mobileSessionReady = true;
      console.log(`[webClient] @${username}: mobile login OK — ${extracted.length} cookies (${extracted.map(c => c.split("=")[0]).join(",")})`);
      return true;
    } catch (e: any) {
      console.error(`[webClient] @${username}: failed to extract mobile cookies: ${e?.message}`);
      return false;
    }
  }

  // ── Common authenticated request helper ────────────────────────────────────
  // web session GET (www.instagram.com)
  private async webGet(path: string): Promise<any> {
    const res = await igReq({
      path,
      method: "GET",
      headers: {
        Host: "www.instagram.com",
        "User-Agent": WEB_UA,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "X-IG-App-ID": APP_ID,
        "X-CSRFToken": this.csrfToken,
        "X-Requested-With": "XMLHttpRequest",
      },
      cookieJar: this.cookieJar,
      proxyUrl: this.proxyUrl,
    });
    if (!res.json) console.log(`[webClient] webGet ${path} status=${res.status} body(200):`, res.rawBody.slice(0, 200));
    return res.json;
  }

  // mobile-style GET (i.instagram.com) — same cookies, mobile app headers
  private async mobileGet(path: string): Promise<any> {
    await this.apiThrottle();
    const res = await igReq({
      host: "i.instagram.com",
      path,
      method: "GET",
      headers: {
        Host: "i.instagram.com",
        "User-Agent": "Instagram 317.0.0.24.109 Android (33/13; 440dpi; 1080x2340; OPPO; CPH2609; OP5961L1; Snapdragon8sGen3; en_US; 558044468)",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "X-IG-App-ID": APP_ID,
        "X-CSRFToken": this.csrfToken,
        "X-IG-Capabilities": "3brTvwE=",
        "X-IG-Connection-Type": "WIFI",
      },
      cookieJar: this.cookieJar,
      proxyUrl: this.proxyUrl,
    });
    if (!res.json) console.log(`[webClient] mobileGet ${path} status=${res.status} body(200):`, res.rawBody.slice(0, 200));
    return res.json;
  }

  // Authenticated GET using the igApiCookies mobile session (mobileCookieJar).
  // Use this for any read that needs the real account session — inbox, timeline, etc.
  // Zero dependency on the EB; works whether or not the browser is open or logged in.
  private async mobileSessionGet(path: string): Promise<any> {
    const hasMobileSession = this.mobileCookieJar.some(c => c.startsWith("sessionid="));
    if (!hasMobileSession) {
      console.warn(`[webClient] mobileSessionGet ${path}: no igApiCookies session`);
      return null;
    }
    if (this.mobileCsrf === "missing" || !this.mobileCsrf) {
      await this._bootstrapMobileCsrf();
    }
    await this.apiThrottle();
    const MOBILE_APP_ID = "567067343352427";
    const csrf = this.mobileCsrf || "missing";
    let fullMobileUA: string;
    if (this.userAgentApi && this.userAgentApi.startsWith("Instagram ")) {
      fullMobileUA = this.userAgentApi;
    } else {
      let deviceStr: string | undefined;
      if (this.igDeviceState) {
        try { deviceStr = JSON.parse(this.igDeviceState).deviceString; } catch { /* ignore */ }
      }
      deviceStr = deviceStr ?? this.userAgentApi;
      fullMobileUA = deviceStr
        ? `Instagram ${MOBILE_VERSION} Android (${deviceStr}; ${MOBILE_VERSION_CODE})`
        : MOBILE_UA;
    }
    const res = await igReq({
      host: "i.instagram.com",
      path,
      method: "GET",
      headers: {
        Host: "i.instagram.com",
        "User-Agent": fullMobileUA,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "X-IG-App-ID": MOBILE_APP_ID,
        "X-CSRFToken": csrf,
        "X-IG-Capabilities": "3brTvwE=",
        "X-IG-Connection-Type": "WIFI",
        "X-IG-Bandwidth-Speed-KBPS": "-1.000",
        "X-IG-Bandwidth-TotalBytes-B": "0",
        "X-IG-Bandwidth-TotalTime-MS": "0",
      },
      cookieJar: this.mobileCookieJar,
      proxyUrl: this.proxyUrl,
    });
    if (res.cookies.length) {
      this.mobileCookieJar = mergeCookies(this.mobileCookieJar, res.cookies);
      const newCsrf = extractCsrf(res.cookies);
      if (newCsrf) this.mobileCsrf = newCsrf;
    }
    if (res.status >= 400) {
      console.warn(`[webClient] mobileSessionGet ${path} → HTTP ${res.status} (session expired/invalid): ${res.rawBody.slice(0, 200)}`);
      return null;
    }
    if (!res.json) console.log(`[webClient] mobileSessionGet ${path} status=${res.status} body(200):`, res.rawBody.slice(0, 200));
    return res.json;
  }

  // Anonymous mobile GET — NO account cookies sent, account identity never exposed.
  // Used for source-account scraping (repost) so the account is not linked to the lookup.
  private async mobileGetAnonymous(path: string): Promise<any> {
    const res = await igReq({
      host: "i.instagram.com",
      path,
      method: "GET",
      headers: {
        Host: "i.instagram.com",
        "User-Agent": "Instagram 317.0.0.24.109 Android (33/13; 440dpi; 1080x2340; OPPO; CPH2609; OP5961L1; Snapdragon8sGen3; en_US; 558044468)",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "X-IG-App-ID": APP_ID,
        "X-IG-Capabilities": "3brTvwE=",
        "X-IG-Connection-Type": "WIFI",
      },
      cookieJar: [],  // deliberately empty — no session cookies
      proxyUrl: this.proxyUrl,
    });
    return res.json;
  }

  private async webPost(path: string, body = "", _isRetry = false): Promise<any> {
    await this.apiThrottle();
    const sessionCookie = this.cookieJar.find(c => c.startsWith("sessionid="));
    console.log(`[webClient] webPost ${path} csrf=${this.csrfToken.slice(0, 8)}... session=${sessionCookie ? "present" : "MISSING"}${_isRetry ? " [retry]" : ""}`);

    const res = await igReq({
      path,
      method: "POST",
      headers: {
        Host: "www.instagram.com",
        "User-Agent": WEB_UA,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-IG-App-ID": APP_ID,
        "X-CSRFToken": this.csrfToken,
        "X-Requested-With": "XMLHttpRequest",
        Referer: "https://www.instagram.com/",
        Origin: "https://www.instagram.com",
      },
      body,
      cookieJar: this.cookieJar,
      proxyUrl: this.proxyUrl,
    });

    // 302 redirect = stale CSRF token (the sessionid is still valid, just the token rotated).
    // Refresh the CSRF from the homepage and retry once — this avoids false "session issue"
    // skips that would happen on the first follow attempt after a long idle period.
    if (!_isRetry && res.status === 302) {
      console.log(`[webClient] webPost ${path}: 302 redirect — refreshing CSRF and retrying`);
      const refreshed = await this.refreshCsrf();
      if (refreshed) return this.webPost(path, body, true);
    }

    // Only merge cookies and update CSRF on successful (non-redirect) responses.
    // A 302 redirect response contains cookies for the LOGIN PAGE (fresh unauthenticated
    // CSRF token), which would corrupt this.csrfToken and break all subsequent POSTs.
    if (res.status < 300) {
      this.cookieJar = mergeCookies(this.cookieJar, res.cookies);
      const newCsrf = extractCsrf(res.cookies);
      if (newCsrf) this.csrfToken = newCsrf;
    }

    if (!res.json) console.log(`[webClient] webPost ${path} status=${res.status} body:`, res.rawBody.slice(0, 300));
    return { json: res.json, status: res.status, rawBody: res.rawBody };
  }

  // ── Follow a user by numeric ID ────────────────────────────────────────────
  // Follow a user via IgApiClient — uses the library's native signed-body request
  // stack (identical pattern to _sendDmViaIgClient) so Instagram sees a proper
  // signed_body parameter instead of the unsigned URL-encoded body that the
  // hand-rolled mobileSessionPost sends.  This is why the plain POST was getting
  // "We're sorry, but something went wrong" on some users even though the EB
  // (which uses signed native app requests) worked fine.
  private async _followViaIgClient(userId: string): Promise<{ ok: boolean; status?: string; reason?: string; checkpointUrl?: string }> {
    if (!this.igApiCookies) return { ok: false, status: "follow_blocked", reason: "no igApiCookies — cannot use IgApiClient" };

    const ig = newIgClient();

    const deviceSeed = (this.userAgentApi ?? this.username ?? "instagram") + "|" + (this.username ?? "instagram");
    if (this.igDeviceState) {
      try {
        const saved = JSON.parse(this.igDeviceState) as { deviceId?: string; uuid?: string; phoneId?: string; adid?: string; deviceString?: string };
        ig.state.generateDevice(deviceSeed);
        if (saved.deviceId)     ig.state.deviceId     = saved.deviceId;
        if (saved.uuid)         ig.state.uuid         = saved.uuid;
        if (saved.phoneId)      ig.state.phoneId      = saved.phoneId;
        if (saved.adid)         ig.state.adid         = saved.adid;
        if (saved.deviceString) ig.state.deviceString = saved.deviceString;
      } catch { ig.state.generateDevice(deviceSeed); }
    } else {
      ig.state.generateDevice(deviceSeed);
    }

    const pairs = this.igApiCookies.split(";").map(s => s.trim()).filter(Boolean);
    const now = new Date().toISOString();
    const cookieEntries = pairs.flatMap(pair => {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) return [];
      const key = pair.slice(0, eqIdx).trim();
      let value = pair.slice(eqIdx + 1).trim();
      try { value = decodeURIComponent(value); } catch { /* keep raw */ }
      return [
        { key, value, domain: "i.instagram.com",  path: "/", secure: true, httpOnly: true, hostOnly: true,  creation: now, lastAccessed: now },
        { key, value, domain: ".instagram.com",   path: "/", secure: true, httpOnly: true, hostOnly: false, creation: now, lastAccessed: now },
      ];
    });
    await ig.state.deserializeCookieJar(JSON.stringify({
      version: "tough-cookie@4.1.3",
      storeType: "MemoryCookieStore",
      rejectPublicSuffixes: true,
      cookies: cookieEntries,
    }));

    ig.state.constants.APP_VERSION      = MOBILE_VERSION;
    ig.state.constants.APP_VERSION_CODE = MOBILE_VERSION_CODE;
    patchDeviceStringVersionCode(ig, MOBILE_VERSION_CODE);
    if (this.proxyUrl) ig.state.proxyUrl = this.proxyUrl;

    // Pre-warm the cookie jar so Instagram sets a fresh csrftoken cookie
    // before we make the friendship.create POST. Without this, cookieCsrfToken
    // returns "missing" and Instagram rejects the write with "We're sorry..."
    let preWarmHadChallenge = false;
    try {
      await ig.user.info(userId);
      console.log(`[webClient] follow ${userId}: pre-warm GET /users/${userId}/info OK — csrftoken: ${ig.state.cookieCsrfToken?.slice(0,8) ?? "none"}`);
    } catch (preErr: any) {
      const preMsg: string = preErr?.message ?? "";
      if (/challenge_required/i.test(preMsg)) preWarmHadChallenge = true;
      // Non-fatal — if the info call fails, try the follow anyway
      console.warn(`[webClient] follow ${userId}: pre-warm GET /users/info failed (${preMsg}) — continuing`);
    }

    try {
      console.log(`[webClient] follow ${userId}: via IgApiClient friendship.create (uuid=${ig.state.uuid.slice(0,8)}… v${MOBILE_VERSION} csrf=${ig.state.cookieCsrfToken?.slice(0,8) ?? "none"})`);
      const result = await ig.friendship.create(userId) as any;
      console.log(`[webClient] follow ${userId}: IgApiClient raw result:`, JSON.stringify(result).slice(0, 300));

      if (result?.following || result?.outgoing_request) {
        return { ok: true, status: result.following ? "following" : "requested" };
      }
      // friendship.create returns the friendship_status object directly
      if (result && typeof result === "object" && "following" in result) {
        return { ok: true, status: result.following ? "following" : "requested" };
      }
      return { ok: false, status: "follow_blocked", reason: "unexpected IgApiClient response: " + JSON.stringify(result).slice(0, 200) };
    } catch (err: any) {
      const rawMsg: string = err?.message ?? String(err);
      // IgApiClient error messages include the full HTTP request line, e.g.
      // "POST /api/v1/friendships/create/123/ - 200 OK; We're sorry..."
      // Strip that prefix so only the Instagram response text is shown to the user.
      const msg: string = rawMsg.replace(/^[A-Z]+ \/[^\s]+ - [^;]+;\s*/, "").trim() || rawMsg;
      const body = err?.response?.body ?? err?.text ?? err?.response?.text;
      console.warn(`[webClient] follow ${userId}: IgApiClient error —`, rawMsg);
      if (body) console.warn(`[webClient] follow ${userId}: IgApiClient raw body —`, JSON.stringify(body)?.slice(0, 600));

      if (/checkpoint_required/i.test(msg)) {
        const url = body?.checkpoint_url ?? "";
        return { ok: false, status: "checkpoint_required", reason: "Instagram requires a security checkpoint", checkpointUrl: url };
      }
      // 404 after a challenge_required pre-warm = account session blocked by challenge, not a missing user
      if (/404|Not Found/i.test(msg)) {
        if (preWarmHadChallenge) {
          return { ok: false, status: "checkpoint_required", reason: "Session has an unresolved Instagram security challenge — verify account in the embedded browser" };
        }
        return { ok: false, status: "follow_blocked", reason: `Instagram returned 404 on friendship.create — ${msg}` };
      }
      if (/spam/i.test(msg))                           return { ok: false, status: "follow_blocked", reason: "spam — Instagram flagged this follow attempt" };
      if (/feedback_required|ActionBlocked/i.test(msg)) return { ok: false, status: "follow_blocked", reason: msg };
      if (/login_required|Not authorized|401/i.test(msg)) return { ok: false, status: "follow_blocked", reason: "session expired — re-verify account" };
      return { ok: false, status: "follow_blocked", reason: msg || "IgApiClient follow failed" };
    }
  }

  // ── Shared IgApiClient helpers ────────────────────────────────────────────

  // Deserialize a cookie string into an IgApiClient's tough-cookie jar.
  // Mirrors restoreSessionCookies() in instagramLogin.ts exactly.
  private async _deserializeIgCookies(ig: IgApiClient, cookieString: string): Promise<void> {
    const pairs = cookieString.split(";").map(s => s.trim()).filter(Boolean);
    const now = new Date().toISOString();
    const cookies = pairs.flatMap(pair => {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) return [];
      const key = pair.slice(0, eqIdx).trim();
      let value = pair.slice(eqIdx + 1).trim();
      try { value = decodeURIComponent(value); } catch { /* keep raw */ }
      return [
        { key, value, domain: "i.instagram.com", path: "/", secure: true, httpOnly: true, hostOnly: true,  creation: now, lastAccessed: now },
        { key, value, domain: ".instagram.com",  path: "/", secure: true, httpOnly: true, hostOnly: false, creation: now, lastAccessed: now },
      ];
    });
    await ig.state.deserializeCookieJar(JSON.stringify({
      version: "tough-cookie@4.1.3",
      storeType: "MemoryCookieStore",
      rejectPublicSuffixes: true,
      cookies,
    }));
  }

  // Build and warm up an IgApiClient for DM inbox access, following the exact
  // Jarvee cold-start sequence that prevents the 4415001 "Prompt has contribution"
  // gate on direct_v2/inbox/:
  //
  //   Phase 0 (NO cookies loaded):
  //     tokens/keyed → launcher.preLoginSync → tokens/keyed
  //   Phase 1:
  //     Load session cookies (+ ds_user_id so the library can read cookieUserId)
  //   Phase 2 (authenticated warm-up):
  //     user.info → news.inbox → qe.syncLoginExperiments
  //
  // Only after this sequence does Instagram stop blocking direct_v2/inbox/.
  private async _buildWarmedIgClient(): Promise<{ ig: IgApiClient; ownUserId: string } | null> {
    if (!this.igApiCookies) return null;

    // ── Device setup ──────────────────────────────────────────────────────────
    const ig = newIgClient();
    // Patch ig.request.send so the per-profile rate limit is enforced on every
    // single API call made through this IgApiClient instance — including the
    // cold-start warm-up calls, not just the final inbox/DM call.
    const _igReq = ig.request as any;
    const _igOriginalSend = _igReq.send.bind(_igReq);
    const _throttle = this.apiThrottle.bind(this);
    _igReq.send = async function(opts: any, onlyCheckHttpStatus?: boolean) {
      await _throttle();
      return _igOriginalSend(opts, onlyCheckHttpStatus);
    };
    const deviceSeed = (this.userAgentApi ?? this.username ?? "instagram") + "|" + (this.username ?? "instagram");
    if (this.igDeviceState) {
      try {
        const saved = JSON.parse(this.igDeviceState) as { deviceId?: string; uuid?: string; phoneId?: string; adid?: string; deviceString?: string };
        ig.state.generateDevice(deviceSeed);
        if (saved.deviceId)     ig.state.deviceId     = saved.deviceId;
        if (saved.uuid)         ig.state.uuid         = saved.uuid;
        if (saved.phoneId)      ig.state.phoneId      = saved.phoneId;
        if (saved.adid)         ig.state.adid         = saved.adid;
        if (saved.deviceString) ig.state.deviceString = saved.deviceString;
      } catch { ig.state.generateDevice(deviceSeed); }
    } else {
      ig.state.generateDevice(deviceSeed);
    }
    ig.state.constants.APP_VERSION      = MOBILE_VERSION;
    ig.state.constants.APP_VERSION_CODE = MOBILE_VERSION_CODE;
    patchDeviceStringVersionCode(ig, MOBILE_VERSION_CODE);
    if (this.proxyUrl) ig.state.proxyUrl = this.proxyUrl;

    // ── Phase 0: unauthenticated probe calls (no cookies) ────────────────────
    // Jarvee fires these BEFORE loading the session cookie. Instagram sees a
    // clean device probe and stops treating the subsequent authenticated calls
    // as a suspicious cold-start, which prevents the 4415001 prompt gate.
    try {
      await ig.request.send({ url: "/api/v1/accounts/tokens/keyed/", method: "GET", qs: { expires: "0" } });
      console.log("[webClient] _buildWarmedIgClient: Phase 0 — tokens/keyed OK");
    } catch (e: any) { console.warn(`[webClient] _buildWarmedIgClient: tokens/keyed #1 (non-fatal): ${e?.message}`); }

    try {
      await ig.launcher.preLoginSync();
      console.log("[webClient] _buildWarmedIgClient: Phase 0 — launcher/sync (preLoginSync) OK");
    } catch (e: any) { console.warn(`[webClient] _buildWarmedIgClient: launcher/sync (non-fatal): ${e?.message}`); }

    try {
      await ig.request.send({ url: "/api/v1/accounts/tokens/keyed/", method: "GET", qs: { expires: "0" } });
      console.log("[webClient] _buildWarmedIgClient: Phase 0 — tokens/keyed #2 OK");
    } catch (e: any) { console.warn(`[webClient] _buildWarmedIgClient: tokens/keyed #2 (non-fatal): ${e?.message}`); }

    // ── Phase 1: Load session cookies ────────────────────────────────────────
    // Extract ownUserId from sessionid (format: "userId:hash:seq:token") and
    // inject ds_user_id so the library can read cookieUserId.
    const pairs = this.igApiCookies.split(";").map(s => s.trim()).filter(Boolean);
    const sessionPair = pairs.find(p => p.toLowerCase().startsWith("sessionid="));
    let ownUserId = pairs.find(p => p.toLowerCase().startsWith("ds_user_id="))
      ?.split("=").slice(1).join("=").trim() ?? "";
    if (!ownUserId && sessionPair) {
      const rawVal = sessionPair.slice("sessionid=".length);
      let decoded = rawVal;
      try { decoded = decodeURIComponent(rawVal); } catch { /* keep raw */ }
      ownUserId = decoded.split(":")[0] ?? "";
    }
    const cookiesWithUserId = ownUserId
      ? `${this.igApiCookies};ds_user_id=${ownUserId}`
      : this.igApiCookies;
    await this._deserializeIgCookies(ig, cookiesWithUserId);
    console.log(`[webClient] _buildWarmedIgClient: Phase 1 — cookies loaded (userId=${ownUserId || "unknown"})`);

    // ── Phase 2: Authenticated warm-up ───────────────────────────────────────
    if (ownUserId) {
      try {
        await ig.user.info(ownUserId);
        console.log(`[webClient] _buildWarmedIgClient: Phase 2 — user.info OK (csrf=${ig.state.cookieCsrfToken?.slice(0, 8) ?? "none"})`);
      } catch (e: any) { console.warn(`[webClient] _buildWarmedIgClient: user.info (non-fatal): ${e?.message}`); }
    }
    try {
      await ig.news.inbox();
      console.log("[webClient] _buildWarmedIgClient: Phase 2 — news/inbox (notifications badge) OK");
    } catch (e: any) { console.warn(`[webClient] _buildWarmedIgClient: news/inbox (non-fatal): ${e?.message}`); }
    try {
      await ig.qe.syncLoginExperiments();
      console.log("[webClient] _buildWarmedIgClient: Phase 2 — qe/sync (FetchConfig) OK");
    } catch (e: any) { console.warn(`[webClient] _buildWarmedIgClient: qe/sync (non-fatal): ${e?.message}`); }

    return { ig, ownUserId };
  }

  // Read the DM inbox via a fully warmed IgApiClient (Jarvee cold-start sequence).
  // The 4415001 "Prompt has contribution" gate on direct_v2/inbox/ is lifted only
  // after Phase 0 (unauthenticated probe) + Phase 2 (warm-up) have run — which is
  // exactly what Jarvee does before calling GetDirectMessagesInternal.
  private async _getInboxViaIgClient(): Promise<{ count: number; ok: boolean }> {
    const client = await this._buildWarmedIgClient();
    if (!client) return { count: 0, ok: false };
    const { ig } = client;

    try {
      const threads = await ig.feed.directInbox().items();
      console.log(`[webClient] _getInboxViaIgClient: ${threads.length} thread(s)`);
      return { count: threads.length, ok: true };
    } catch (err: any) {
      const body = err?.response?.body;
      const code = body?.content?.error_code ?? body?.error_code;
      console.warn(`[webClient] _getInboxViaIgClient: inbox failed code=${code} — ${err?.message}`, body ? JSON.stringify(body).slice(0, 200) : "");
      return { count: 0, ok: false };
    }
  }

  // Like a media post using IgApiClient (properly signs the request body).
  // The hand-rolled mobileSessionPost sends an empty body which Instagram
  // rejects with "something went wrong" — IgApiClient includes all required
  // fields (_uid, _uuid, _csrftoken, device_id, radio_type, module_name).
  private async _likeViaIgClient(mediaId: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.igApiCookies) return { ok: false, reason: "no igApiCookies" };

    const ig = newIgClient();
    const deviceSeed = (this.userAgentApi ?? this.username ?? "instagram") + "|" + (this.username ?? "instagram");
    if (this.igDeviceState) {
      try {
        const saved = JSON.parse(this.igDeviceState) as { deviceId?: string; uuid?: string; phoneId?: string; adid?: string; deviceString?: string };
        ig.state.generateDevice(deviceSeed);
        if (saved.deviceId)     ig.state.deviceId     = saved.deviceId;
        if (saved.uuid)         ig.state.uuid         = saved.uuid;
        if (saved.phoneId)      ig.state.phoneId      = saved.phoneId;
        if (saved.adid)         ig.state.adid         = saved.adid;
        if (saved.deviceString) ig.state.deviceString = saved.deviceString;
      } catch { ig.state.generateDevice(deviceSeed); }
    } else {
      ig.state.generateDevice(deviceSeed);
    }

    const pairs = this.igApiCookies.split(";").map(s => s.trim()).filter(Boolean);
    const now = new Date().toISOString();
    const cookieEntries = pairs.flatMap(pair => {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) return [];
      const key = pair.slice(0, eqIdx).trim();
      let value = pair.slice(eqIdx + 1).trim();
      try { value = decodeURIComponent(value); } catch { /* keep raw */ }
      return [
        { key, value, domain: "i.instagram.com",  path: "/", secure: true, httpOnly: true, hostOnly: true,  creation: now, lastAccessed: now },
        { key, value, domain: ".instagram.com",   path: "/", secure: true, httpOnly: true, hostOnly: false, creation: now, lastAccessed: now },
      ];
    });
    await ig.state.deserializeCookieJar(JSON.stringify({
      version: "tough-cookie@4.1.3",
      storeType: "MemoryCookieStore",
      rejectPublicSuffixes: true,
      cookies: cookieEntries,
    }));

    ig.state.constants.APP_VERSION      = MOBILE_VERSION;
    ig.state.constants.APP_VERSION_CODE = MOBILE_VERSION_CODE;
    patchDeviceStringVersionCode(ig, MOBILE_VERSION_CODE);
    if (this.proxyUrl) ig.state.proxyUrl = this.proxyUrl;

    // Pre-warm: GET /media/info/ sets a fresh csrftoken cookie before the like POST.
    // Without this, cookieCsrfToken is "missing" and Instagram rejects the write.
    try {
      await ig.media.info(mediaId);
      console.log(`[webClient] like ${mediaId}: pre-warm media.info OK — csrf=${ig.state.cookieCsrfToken?.slice(0,8) ?? "none"}`);
    } catch (preErr: any) {
      console.warn(`[webClient] like ${mediaId}: pre-warm media.info failed (${preErr?.message}) — continuing`);
    }

    try {
      console.log(`[webClient] like ${mediaId}: IgApiClient media.like (uuid=${ig.state.uuid.slice(0,8)}… csrf=${ig.state.cookieCsrfToken?.slice(0,8) ?? "none"})`);
      await ig.media.like({ mediaId, moduleInfo: { module_name: "feed_timeline" }, d: 0 });
      return { ok: true };
    } catch (err: any) {
      const msg: string = err?.message ?? String(err);
      const body = err?.response?.body ?? err?.text ?? err?.response?.text;
      console.warn(`[webClient] like ${mediaId}: IgApiClient error —`, msg);
      if (body) console.warn(`[webClient] like ${mediaId}: IgApiClient raw body —`, JSON.stringify(body)?.slice(0, 400));
      if (/checkpoint_required/i.test(msg)) return { ok: false, reason: "checkpoint_required" };
      if (/feedback_required|ActionBlocked/i.test(msg)) return { ok: false, reason: "blocked" };
      if (/login_required|Not authorized|401/i.test(msg)) return { ok: false, reason: "session expired" };
      return { ok: false, reason: msg || "IgApiClient like failed" };
    }
  }

  async followUser(userId: string, username?: string, sourceLabel?: string): Promise<{ ok: boolean; status?: string; reason?: string; checkpointUrl?: string }> {
    return this.timed("FollowedUser", async () => {
      // Prefer IgApiClient path (properly signs the request body with HMAC-SHA256).
      // The hand-rolled mobileSessionPost sends an unsigned body which Instagram
      // rejects with "We're sorry, but something went wrong" on some users even
      // when the account can follow just fine via the real app or EB.
      if (this.igApiCookies) {
        return this._followViaIgClient(userId);
      }

      // Fallback: hand-rolled POST (no igApiCookies available).
      const body = new URLSearchParams({ user_id: userId }).toString();
      const j = await this.mobileSessionPost(`/api/v1/friendships/create/${userId}/`, body);

      if (!j) return { ok: false, status: "follow_blocked", reason: "no response from mobile API" };
      console.log(`[webClient] follow ${userId} (fallback mobileSessionPost):`, JSON.stringify(j).slice(0, 400));

      if (j?.message === "checkpoint_required" || j?.checkpoint_url) {
        const url = j?.checkpoint_url ?? "";
        return { ok: false, status: "checkpoint_required", reason: "Instagram requires a security checkpoint", checkpointUrl: url };
      }
      if (j?.spam === true) return { ok: false, status: "follow_blocked", reason: "spam — Instagram flagged this follow attempt" };
      if (j?.require_login || j?.feedback_required || j?.message === "login_required") {
        return { ok: false, status: "follow_blocked", reason: j?.message ?? j?.feedback_message ?? "unknown" };
      }
      if (j?.message && typeof j.message === "string" && j.message.toLowerCase().includes("please wait")) {
        return { ok: false, status: "follow_blocked", reason: j.message };
      }
      if (j?.friendship_status) {
        return { ok: true, status: j.friendship_status.following ? "following" : "requested" };
      }
      if (j?.status === "fail") {
        return { ok: false, status: "follow_blocked", reason: j?.message || "Instagram declined (status: fail)" };
      }
      console.warn(`[webClient] follow ${userId} unexpected response:`, JSON.stringify(j));
      return { ok: false, status: "follow_blocked", reason: "unexpected response" };
    }, username ? `Follow @${username}${sourceLabel ? ` via ${sourceLabel}` : ""}` : `Follow user ${userId}`,
    (r) => r.ok);
  }

  // ── Convert a numeric Instagram media ID to its shortcode ─────────────────
  private mediaIdToShortcode(id: string): string {
    const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    // Media IDs can be "123456789_987654321" — only the first segment is the media pk
    const numericPart = id.split("_")[0];
    let n = BigInt(numericPart);
    let result = "";
    while (n > 0n) {
      result = ALPHA[Number(n % 64n)] + result;
      n = n / 64n;
    }
    return result || "0";
  }

  // ── Like a media post by ID ────────────────────────────────────────────────
  // Returns the post URL on success, "blocked" when Instagram issues a
  // feedback_required/action-block, or false for any other failure.
  async likeMedia(mediaId: string, username?: string): Promise<string | "blocked" | false> {
    return this.timed("LikeMedia", async () => {
      // Prefer IgApiClient path (properly signs the request body with HMAC-SHA256,
      // includes _uid, _uuid, _csrftoken, device_id, radio_type, module_name).
      // A hand-rolled empty-body POST always returns "something went wrong" because
      // Instagram requires a signed, non-empty body for write actions.
      if (this.igApiCookies) {
        const r = await this._likeViaIgClient(mediaId);
        if (r.ok) {
          const shortcode = this.mediaIdToShortcode(mediaId);
          return `https://www.instagram.com/p/${shortcode}/`;
        }
        if (r.reason === "blocked") {
          console.warn(`[webClient] likeMedia BLOCKED by Instagram`);
          return "blocked";
        }
        console.warn(`[webClient] likeMedia ${mediaId} IgApiClient failed: ${r.reason}`);
        return false;
      }

      // Fallback: hand-rolled POST (no igApiCookies available — rare).
      const j = await this.mobileSessionPost(`/api/v1/media/${mediaId}/like/`);
      const ok = j?.status === "ok";
      if (!ok) console.log(`[webClient] likeMedia ${mediaId} fallback response:`, JSON.stringify(j));
      if (!ok) {
        if (j?.message === "feedback_required" || j?.feedback_required === true) {
          console.warn(`[webClient] likeMedia BLOCKED (fallback)`);
          return "blocked";
        }
        return false;
      }
      const shortcode = this.mediaIdToShortcode(mediaId);
      return `https://www.instagram.com/p/${shortcode}/`;
    }, username ? `Like post of @${username}` : `Like media ${mediaId}`);
  }

  // ── Get a user's recent feed media IDs ────────────────────────────────────
  async getUserRecentMediaId(userId: string): Promise<string | null> {
    const j = await this.mobileGet(`/api/v1/feed/user/${userId}/?count=3`);
    const items = j?.items;
    if (!Array.isArray(items) || items.length === 0) return null;
    return String(items[0].id ?? items[0].pk ?? "");
  }

  // ── View stories for a user (fetch + mark seen) ───────────────────────────
  // Returns the stories URL on success, false on failure.
  async viewStories(userId: string, username?: string): Promise<string | false> {
    return this.timed("ViewStories", async () => {
      const j = await this.mobileGet(`/api/v1/feed/reels_media/?reel_ids=${userId}`);
      const reel = j?.reels?.[userId] ?? j?.reels_media?.[0];
      const items: any[] = reel?.items ?? [];
      if (!items.length) return false;

      // Build seen payload: "userId:mediaId_userId" for each item
      const seenEntries = items.map((item: any) => {
        const mediaId = String(item.id ?? item.pk ?? "");
        const takenAt = item.taken_at ?? Math.floor(Date.now() / 1000);
        const seenAt = takenAt + 2;
        return `${mediaId}_${takenAt}_${seenAt}`;
      });

      const body = new URLSearchParams({
        [`reels[${userId}]`]: seenEntries.join(","),
        live_vods_skipped: "",
        nuxes_skipped: "",
      }).toString();
      await this.mobilePost(`/api/v1/media/seen/?reel=1&nuxes=0`, body);
      return username
        ? `https://www.instagram.com/stories/${username}/`
        : `https://www.instagram.com/`;
    }, username ? `View stories of @${username}` : `View stories of ${userId}`);
  }

  // ── View highlights for a user ────────────────────────────────────────────
  // Returns the specific highlight URL on success, false on failure.
  async viewHighlights(userId: string, username?: string): Promise<string | false> {
    return this.timed("ViewHighlights", async () => {
      const j = await this.mobileGet(`/api/v1/highlights/${userId}/highlights_tray/`);
      const trays: any[] = j?.tray ?? [];
      if (!trays.length) return false;
      // Mark first highlight as seen — fetch ALL its items (no slice limit)
      const first = trays[0];
      const reelId = String(first.id ?? "");
      if (!reelId) return false;
      const details = await this.mobileGet(`/api/v1/feed/reels_media/?reel_ids=${reelId}`);
      const items: any[] = details?.reels?.[reelId]?.items ?? details?.reels_media?.[0]?.items ?? [];
      if (!items.length) return false;
      const seenEntries = items.map((item: any) => {
        const mediaId = String(item.id ?? item.pk ?? "");
        const takenAt = item.taken_at ?? Math.floor(Date.now() / 1000);
        return `${mediaId}_${takenAt}_${takenAt + 2}`;
      });
      const body = new URLSearchParams({
        [`reels[${reelId}]`]: seenEntries.join(","),
        live_vods_skipped: "",
        nuxes_skipped: "",
      }).toString();
      await this.mobilePost(`/api/v1/media/seen/?reel=1&nuxes=0`, body);
      // reelId looks like "highlight:17873050488030591" — strip the prefix for the URL
      const highlightNumericId = reelId.replace(/^highlight:/, "");
      return `https://www.instagram.com/stories/highlights/${highlightNumericId}/`;
    }, username ? `View highlights of @${username}` : `View highlights of ${userId}`);
  }

  // ── View reels from the user's feed ─────────────────────────────────────
  // Returns the first reel URL on success, false on failure.
  // Marks ALL fetched reels as seen (up to count=6).
  async viewReels(userId: string, username?: string): Promise<string | false> {
    return this.timed("ViewReels", async () => {
      // clips/user requires POST
      const body = new URLSearchParams({ user_id: userId, max_id: "", count: "6", include_feed_video: "true" }).toString();
      const j = await this.mobilePost(`/api/v1/clips/user/`, body);
      const items: any[] = j?.items ?? [];
      if (!items.length) return false;

      // Build seen entries for all returned reels
      const seenEntries: string[] = [];
      let firstShortcode = "";
      for (const raw of items) {
        const media = raw?.media ?? raw;
        const mediaId = String(media?.id ?? media?.pk ?? "");
        if (!mediaId) continue;
        const takenAt = media.taken_at ?? Math.floor(Date.now() / 1000);
        seenEntries.push(`${mediaId}_${takenAt}_${takenAt + 3}`);
        if (!firstShortcode) firstShortcode = this.mediaIdToShortcode(mediaId);
      }
      if (!seenEntries.length) return false;

      const seenBody = new URLSearchParams({
        [`reels[${userId}]`]: seenEntries.join(","),
        live_vods_skipped: "",
        nuxes_skipped: "",
      }).toString();
      await this.mobilePost(`/api/v1/media/seen/`, seenBody);
      return `https://www.instagram.com/reel/${firstShortcode}/`;
    }, username ? `View reels of @${username}` : `View reels of ${userId}`);
  }

  // ── Visit notifications inbox ─────────────────────────────────────────────
  // Simulates a user tapping the heart/notification icon.
  async visitNotifications(): Promise<boolean> {
    return this.timed("VisitNotifications", async () => {
      const j = await this.mobileGet(`/api/v1/news/inbox/?mark_as_seen=true&warning_sweep_enabled=true`);
      return !!(j?.new_stories || j?.old_stories || j?.counts);
    }, "Visit notifications");
  }

  // ── Visit own profile ─────────────────────────────────────────────────────
  // Simulates a user tapping their own profile tab.
  async visitOwnProfile(): Promise<boolean> {
    return this.timed("VisitOwnProfile", async () => {
      const j = await this.mobileGet(`/api/v1/accounts/current_user/?edit=true`);
      return !!(j?.user);
    }, "Visit own profile");
  }

  // ── Fetch own profile stats (followers / following / posts) ───────────────
  // Uses the same current_user endpoint but extracts the counts.
  async getOwnProfileStats(): Promise<{ followersCount: number; followingCount: number; postsCount: number } | null> {
    try {
      const j = await this.mobileGet(`/api/v1/accounts/current_user/?edit=true`);
      const u = j?.user;
      if (!u) return null;
      return {
        followersCount: Number(u.follower_count ?? u.followed_by_count ?? 0),
        followingCount: Number(u.following_count ?? 0),
        postsCount:     Number(u.media_count ?? 0),
      };
    } catch {
      return null;
    }
  }

  // ── Refresh own profile feed ──────────────────────────────────────────────
  // Simulates a user pull-to-refreshing their profile page.
  // /api/v1/feed/self/ is a dead endpoint as of 2024 — replaced by
  // /api/v1/feed/user/{userId}/ which requires the numeric user ID extracted
  // from the ds_user_id cookie (always present after login).
  async refreshOwnProfile(): Promise<boolean> {
    // Check for the required cookie BEFORE entering timed() — if it's absent
    // no real Instagram call is made and we should not produce a log entry.
    const userIdCookie = this.cookieJar.find(c => c.startsWith("ds_user_id="));
    const userId = userIdCookie ? userIdCookie.split("=")[1] : null;
    if (!userId) return false;
    return this.timed("RefreshOwnProfile", async () => {
      const j = await this.mobileGet(`/api/v1/feed/user/${userId}/?count=12`);
      return !!(j?.items || j?.profile_grid_items);
    }, "Refresh own profile");
  }

  // ── Click Settings and Activity ───────────────────────────────────────────
  // Simulates visiting the Settings page — fetches account security info.
  // This endpoint requires POST as of 2024 (GET returns 405).
  async visitSettingsAndActivity(): Promise<boolean> {
    return this.timed("VisitSettingsAndActivity", async () => {
      const j = await this.mobilePost(`/api/v1/accounts/account_security_info/`);
      return !!(j?.status !== "fail");
    }, "Visit settings and activity");
  }

  // ── Scroll the home timeline feed ────────────────────────────────────────
  // Fetches the main home feed and marks up to `count` posts as seen,
  // simulating a user scrolling through their Instagram home feed.
  async viewTimelineFeed(count: number = 5): Promise<{ viewed: number; sessionExpired?: boolean; reason?: string }> {
    // Fetch timeline using the igApiCookies mobile session — the EB web cookies
    // do not have a valid i.instagram.com mobile session so the endpoint returns 0 items.
    const j = await this.mobileSessionPost(
      `/api/v1/feed/timeline/`,
      new URLSearchParams({ reason: "cold_start_fetch", is_pull_to_refresh: "0" }).toString(),
    );
    if (!j) {
      console.warn(`[webClient] viewTimelineFeed: mobileSessionPost returned null — no igApiCookies session`);
      return { viewed: 0 };
    }
    if (j?.message === "login_required" || j?.require_login || (j?.status === "fail" && /login|logged.?out|logout/i.test(j?.message ?? ""))) {
      const reason = [
        j?.message ? `message: ${j.message}` : null,
        j?.logout_reason ? `logout_reason: ${j.logout_reason}` : null,
        j?.error_title ? `error_title: ${j.error_title}` : null,
      ].filter(Boolean).join(" | ") || "login_required";
      console.warn(`[webClient] viewTimelineFeed: session expired — ${reason}`);
      this.mobileSessionReady = false;
      return { viewed: 0, sessionExpired: true, reason };
    }
    if (j?.status === "fail") {
      console.warn(`[webClient] viewTimelineFeed: timeline fetch failed — status="${j?.status}" message="${j?.message}"`);
      return { viewed: 0 };
    }
    const rawItems: any[] = j?.feed_items ?? j?.items ?? [];
    console.log(`[webClient] viewTimelineFeed: timeline returned ${rawItems.length} raw items`);
    if (!rawItems.length) return { viewed: 0 };

    const items = rawItems
      .map((raw: any) => raw?.media_or_ad ?? raw?.media ?? raw)
      .filter((m: any) => m?.id || m?.pk)
      .slice(0, count);

    let viewed = 0;
    for (const media of items) {
      const mediaId = String(media?.id ?? media?.pk ?? "");
      if (!mediaId) continue;
      const takenAt = media.taken_at ?? Math.floor(Date.now() / 1000);
      // One seen call per post — matches Jarvee's per-post call pattern and is
      // more authentic than batching (real app reports seen as user scrolls past).
      await this.timed("ViewTimelineFeedSeen", async () => {
        await this.mobilePost(`/api/v1/media/seen/`, new URLSearchParams({
          reels: `${mediaId}_${takenAt}_${takenAt + 3}`,
          live_vods_skipped: "",
          nuxes_skipped: "",
        }).toString());
        return ++viewed;
      }, (n) => `Marked ${n} post${n === 1 ? "" : "s"} as seen`);
    }

    return { viewed };
  }

  // ── Watch reels from the home feed Reels tab ─────────────────────────────
  // Fetches the reels explore/home feed and marks up to `count` reels as seen,
  // simulating a user scrolling through the Reels tab.
  async viewTimelineReels(count: number = 5): Promise<number> {
    return this.timed("ViewTimelineReels", async () => {
      const body = new URLSearchParams({ reason: "pull_to_refresh", max_id: "" }).toString();
      const j = await this.mobilePost(`/api/v1/clips/feed/`, body);
      const items: any[] = j?.items ?? [];
      if (!items.length) return 0;

      const toView = items.slice(0, count);
      const seenEntries: string[] = [];

      for (const raw of toView) {
        const media = raw?.media ?? raw;
        const mediaId = String(media?.id ?? media?.pk ?? "");
        if (!mediaId) continue;
        const takenAt = media.taken_at ?? Math.floor(Date.now() / 1000);
        seenEntries.push(`${mediaId}_${takenAt}_${takenAt + 3}`);
      }

      if (seenEntries.length) {
        const seenBody = new URLSearchParams({
          reels: seenEntries.join(","),
          live_vods_skipped: "",
          nuxes_skipped: "",
        }).toString();
        await this.mobilePost(`/api/v1/media/seen/`, seenBody);
      }

      return toView.length;
    }, (n) => `Viewed ${n} timeline reel${n === 1 ? "" : "s"}`);
  }

  // ── Watch stories from the timeline tray ─────────────────────────────────
  // Fetches the stories tray at the top of the home feed and marks up to
  // `count` story reels as seen, simulating a user swiping through stories.
  async viewTimelineStories(count: number = 5): Promise<number> {
    return this.timed("ViewTimelineStories", async () => {
      const j = await this.mobileSessionGet(`/api/v1/feed/reels_tray/`);
      if (j === null) {
        // mobileSessionGet returns null when mobileCookieJar has no sessionid.
        // This happens when the account has no igApiCookies (Verify Credentials not yet run)
        // AND the fresh mobile login failed (bad password, 2FA, proxy, etc.).
        // Return a negative sentinel so the caller can log a specific "no session" warning.
        return -1;
      }
      const tray: any[] = j?.tray ?? [];
      if (!tray.length) return 0;

      const toView = tray.slice(0, count);
      const seenBody = new URLSearchParams({ live_vods_skipped: "", nuxes_skipped: "" });

      for (const reel of toView) {
        const userId = String(reel.user?.pk ?? reel.id ?? "");
        const items: any[] = reel.items ?? [];
        if (!items.length || !userId) continue;

        const seenEntries = items.map((item: any) => {
          const mediaId = String(item.id ?? item.pk ?? "");
          const takenAt = item.taken_at ?? Math.floor(Date.now() / 1000);
          return `${mediaId}_${takenAt}_${takenAt + 2}`;
        });
        seenBody.set(`reels[${userId}]`, seenEntries.join(","));
      }

      await this.mobilePost(`/api/v1/media/seen/?reel=1&nuxes=0`, seenBody.toString());
      return toView.length;
    }, (n) => `Viewed ${n} timeline stor${n === 1 ? "y" : "ies"}`);
  }

  // ── Check direct messages inbox ──────────────────────────────────────────
  // Fetches the main DM inbox to simulate a user checking their messages.
  async getDirectMessages(count: number = 5): Promise<boolean> {
    return this.timed("GetDirectMessages", async () => {
      const j = await this.mobileSessionGet(
        `/api/v1/direct_v2/inbox/?persistentBadging=true&visual_message_return_type=unseen&thread_message_limit=1&cursor=&limit=${count}`
      );
      const threads: any[] = j?.inbox?.threads ?? j?.threads ?? [];
      return { ok: !!(j?.inbox ?? j?.threads), count: threads.length };
    }, (r) => `Checked ${r.count} direct message${r.count === 1 ? "" : "s"}`,
    (r) => r.ok);
  }

  // ── Check DM inbox + open individual threads ─────────────────────────────
  // Simulates a user opening the DM inbox, then tapping into `count` threads.
  // Produces N+1 API call log entries: 1 × GetDirectMessages (inbox overview)
  // + N × GetDirectMessageThread (one per thread opened).
  // Uses _buildWarmedIgClient (Jarvee cold-start) so Instagram does not gate
  // direct_v2/inbox/ with 4415001. The warmed client is reused for all calls
  // so we only pay the probe-sequence cost once per checkDm run.
  // Only logs calls that Instagram's server genuinely answered (ok=true).
  // Returns the full mapped inbox thread list so auto-reply can reuse it
  // without a second warm-up or second inbox fetch.
  async getDirectMessagesInternal(count: number = 5): Promise<{
    count: number;
    ok: boolean;
    threads: { threadId: string; username: string; userId: string; firstName: string; items: { itemId: string; text: string; fromMe: boolean }[] }[];
  }> {
    // ── Step 1: build warmed client (Phase 0-2 probe sequence) ──────────────
    const built = await this._buildWarmedIgClient();
    if (!built) {
      console.warn("[webClient] getDirectMessagesInternal: no igApiCookies — skipping DM check");
      return { count: 0, ok: false, threads: [] };
    }
    const { ig } = built;

    // Own user ID — used to distinguish our sent messages from incoming ones.
    const myUserId = String(ig.state.cookieUserId ?? "");

    // Helper: map a raw inbox thread to the format auto-reply expects.
    const mapThread = (thread: any) => {
      const otherUser = (thread.users ?? [])[0];
      if (!thread.thread_id || !otherUser?.username) return null;
      const items = (thread.items ?? [])
        .filter((item: any) => item?.item_type === "text" && item?.text)
        .map((item: any) => ({
          itemId: String(item.item_id ?? ""),
          text: String(item.text ?? ""),
          fromMe: myUserId ? String(item.user_id) === myUserId : false,
        }));
      // Extract first name from full_name (first word), fall back to username.
      // full_name comes free from the directInbox response — no extra API call.
      const rawFullName = String(otherUser.full_name ?? "").trim();
      const firstName = rawFullName.split(/\s+/)[0] || String(otherUser.username);
      return {
        threadId: String(thread.thread_id),
        username: String(otherUser.username),
        userId: String(otherUser.pk ?? ""),
        firstName,
        items,
      };
    };

    // ── Step 2: fetch inbox overview (1 API call — GetDirectMessages) ───────
    let inboxThreads: any[] = [];
    try {
      const inboxResult = await this.timed("GetDirectMessages", async () => {
        const items = await ig.feed.directInbox().items();
        return { items, ok: true as const };
      }, (r) => `Inbox overview: ${r.items.length} thread${r.items.length === 1 ? "" : "s"}`,
      (r) => r.ok);
      inboxThreads = inboxResult.items;
      console.log(`[webClient] getDirectMessagesInternal: inbox OK — ${inboxThreads.length} thread(s), will open ${Math.min(count, inboxThreads.length)}`);
    } catch (e: any) {
      const code = e?.response?.body?.content?.error_code ?? e?.response?.body?.error_code;
      console.warn(`[webClient] getDirectMessagesInternal: inbox error code=${code} — ${e?.message}`);
      return { count: 0, ok: false, threads: [] };
    }

    // Map ALL inbox threads now so auto-reply can scan the full list later
    // without needing a second warm-up or second inbox fetch.
    const mappedThreads = inboxThreads
      .map(mapThread)
      .filter((t): t is NonNullable<ReturnType<typeof mapThread>> => t !== null);

    if (inboxThreads.length === 0) return { count: 0, ok: true, threads: [] };

    // ── Step 3: open each of the first `count` threads ───────────────────
    // Each open is its own timed API call so the log reflects real actions.
    const toOpen = inboxThreads.slice(0, count);
    let opened = 0;
    for (const thread of toOpen) {
      const threadId = String(thread.thread_id ?? "");
      if (!threadId) continue;
      try {
        await this.timed("GetDirectMessageThread", async () => {
          const msgs = await ig.feed.directThread({ thread_id: threadId, oldest_cursor: "" }).items();
          return { ok: true as const, count: msgs.length };
        }, (r) => `Opened DM thread: ${r.count} message${r.count === 1 ? "" : "s"}`,
        (r) => r.ok);
        opened++;
      } catch (e: any) {
        console.warn(`[webClient] getDirectMessagesInternal: thread ${threadId} open error — ${e?.message}`);
      }
      // Human-paced delay between thread opens (1.5–4 s)
      if (opened < toOpen.length) {
        const delayMs = 1500 + Math.floor(Math.random() * 2500);
        await new Promise<void>(r => setTimeout(r, delayMs));
      }
    }

    console.log(`[webClient] getDirectMessagesInternal: opened ${opened}/${toOpen.length} thread(s)`);
    return { count: opened, ok: true, threads: mappedThreads };
  }

  // Like getDirectMessages but returns thread content for auto-reply scanning.
  // Uses _buildWarmedIgClient (Jarvee cold-start) so Instagram doesn't gate
  // direct_v2/inbox/ with 4415001 "Prompt has contribution".
  async getDMThreadsWithContent(count: number = 10): Promise<{
    threadId: string;
    username: string;
    userId: string;
    items: { itemId: string; text: string; fromMe: boolean }[];
  }[]> {
    // Track whether Instagram actually responded to the inbox request.
    // Only log to instagram_api_calls when the server genuinely returned data.
    let inboxOk = false;
    return this.timed("GetDMThreadsContent", async () => {
      const client = await this._buildWarmedIgClient();
      if (!client) {
        console.warn("[webClient] getDMThreadsWithContent: no igApiCookies — cannot fetch DMs");
        return [];
      }
      const { ig } = client;

      // Use ig.state.cookieUserId to identify which messages are from us.
      // thread.viewer_id is not always populated by the API, causing all messages
      // to appear as incoming (fromMe=false) and triggering false auto-replies.
      const myUserId = String(ig.state.cookieUserId ?? "");

      // Helper: map IgApiClient thread object → our format
      const mapThread = (thread: any): { threadId: string; username: string; userId: string; items: { itemId: string; text: string; fromMe: boolean }[] } | null => {
        const otherUser = (thread.users ?? [])[0];
        if (!thread.thread_id || !otherUser?.username) return null;
        const items: { itemId: string; text: string; fromMe: boolean }[] = (thread.items ?? [])
          .filter((item: any) => item?.item_type === "text" && item?.text)
          .map((item: any) => ({
            itemId: String(item.item_id ?? ""),
            text: String(item.text ?? ""),
            fromMe: myUserId ? String(item.user_id) === myUserId : false,
          }));
        return {
          threadId: String(thread.thread_id),
          username: String(otherUser.username),
          userId: String(otherUser.pk ?? ""),
          items,
        };
      };

      const results: ReturnType<typeof mapThread>[] = [];

      try {
        const mainThreads = await ig.feed.directInbox().items();
        inboxOk = true; // Instagram responded — record as a real API call
        console.log(`[webClient] getDMThreadsWithContent: ${mainThreads.length} thread(s), myUserId=${myUserId || "unknown"}`);
        for (const t of mainThreads.slice(0, count)) results.push(mapThread(t));
      } catch (e: any) {
        const code = e?.response?.body?.content?.error_code ?? e?.response?.body?.error_code;
        console.warn(`[webClient] getDMThreadsWithContent: inbox error code=${code} — ${e?.message}`);
      }

      return results.filter((t): t is NonNullable<typeof t> => t !== null && !!t.threadId && !!t.username);
    }, `Check DMs with content (limit=${count})`, () => inboxOk);
  }

  // ── Like posts from the home timeline feed ───────────────────────────────
  // Fetches the home feed and likes up to `count` posts.
  // If a post is a reel/video (media_type === 2), it is marked as watched
  // before being liked, so Instagram sees a realistic view → like sequence.
  // Returns the number of posts liked and reels watched.
  async saveMedia(mediaId: string): Promise<boolean> {
    return this.timed("SaveMedia", async () => {
      const body = new URLSearchParams({ added_via: "save_to_collection" }).toString();
      const j = await this.mobilePost(`/api/v1/media/${mediaId}/save/`, body);
      return j?.status === "ok";
    }, `Save media ${mediaId}`);
  }

  async likeDirectMessage(threadId: string, itemId: string): Promise<boolean> {
    return this.timed("LikeDM", async () => {
      const body = new URLSearchParams({}).toString();
      const j = await this.mobilePost(`/api/v1/direct_v2/threads/${threadId}/items/${itemId}/like/`, body);
      return j?.status === "ok";
    }, `Like DM thread=${threadId} item=${itemId}`);
  }

  async likeTimelinePosts(count: number = 3, delayMinSec: number = 3, delayMaxSec: number = 8): Promise<{ liked: number; watched: number; likedPosts: Array<{ shortcode: string; ownerUsername: string; mediaId: string }>; sessionExpired?: boolean; sessionExpiredReason?: string }> {
    // No timed() wrapper here — individual likeMedia() calls each produce their
    // own LikeMedia log entry. A LikeTimelinePosts summary on top would cause
    // two entries at the same timestamp and make rate-limit audits confusing.
    const j = await this.mobileSessionPost(`/api/v1/feed/timeline/`, new URLSearchParams({ reason: "cold_start_fetch", is_pull_to_refresh: "0" }).toString());
    if (!j) {
      console.warn(`[webClient] likeTimelinePosts: mobileSessionPost returned null — no mobile session`);
      return { liked: 0, watched: 0, likedPosts: [] };
    }
    if (j?.message === "login_required" || j?.require_login || (j?.status === "fail" && /login|logged.?out|logout/i.test(j?.message ?? ""))) {
      const sessionExpiredReason = [
        j?.message ? `message: ${j.message}` : null,
        j?.logout_reason ? `logout_reason: ${j.logout_reason}` : null,
        j?.error_title ? `error_title: ${j.error_title}` : null,
      ].filter(Boolean).join(" | ") || "login_required";
      console.warn(`[webClient] likeTimelinePosts: session expired — ${sessionExpiredReason}`);
      this.mobileSessionReady = false;
      return { liked: 0, watched: 0, likedPosts: [], sessionExpired: true, sessionExpiredReason };
    }
    if (j?.status === "fail") {
      console.warn(`[webClient] likeTimelinePosts: timeline fetch failed — status="${j?.status}" message="${j?.message}"`);
      return { liked: 0, watched: 0, likedPosts: [] };
    }
    const rawItems: any[] = j?.feed_items ?? j?.items ?? [];
    console.log(`[webClient] likeTimelinePosts: timeline returned ${rawItems.length} raw items`);
    if (!rawItems.length) return { liked: 0, watched: 0, likedPosts: [] };

    const items = rawItems
      .map((raw: any) => raw?.media_or_ad ?? raw?.media ?? raw)
      .filter((m: any) => m?.id || m?.pk);

    const toProcess = items.slice(0, count);
    let liked = 0;
    let watched = 0;
    const likedPosts: Array<{ shortcode: string; ownerUsername: string; mediaId: string }> = [];

    for (let i = 0; i < toProcess.length; i++) {
      const media = toProcess[i];
      const mediaId = String(media?.id ?? media?.pk ?? "");
      if (!mediaId) continue;

      if (i > 0 && delayMaxSec > 0) {
        const delaySec = delayMinSec + Math.random() * Math.max(0, delayMaxSec - delayMinSec);
        console.log(`[webClient] likeTimelinePosts: waiting ${delaySec.toFixed(1)}s before next like`);
        await new Promise(r => setTimeout(r, Math.round(delaySec * 1000)));
      }

      const isReel = media?.media_type === 2 || media?.product_type === "clips";

      if (isReel) {
        try {
          const takenAt = media.taken_at ?? Math.floor(Date.now() / 1000);
          const seenBody = new URLSearchParams({
            reels: `${mediaId}_${takenAt}_${takenAt + 4}`,
            live_vods_skipped: "",
            nuxes_skipped: "",
          }).toString();
          await this.mobilePost(`/api/v1/media/seen/`, seenBody);
          watched++;
        } catch (_) { /* best-effort */ }
      }

      const result = await this.likeMedia(mediaId);
      if (result === "blocked") break;
      if (result) {
        liked++;
        const shortcode     = String(media?.code ?? "");
        const ownerUsername = String(media?.user?.username ?? "");
        likedPosts.push({ shortcode, ownerUsername, mediaId });
      }
    }

    return { liked, watched, likedPosts };
  }

  // ── Unfollow a user ───────────────────────────────────────────────────────
  // Returns true on success, "blocked" on Instagram action-block, false otherwise.
  async unfollowUser(userId: string, username?: string): Promise<true | "blocked" | false> {
    return this.timed("UnfollowUser", async () => {
      // Use igApiCookies mobile session for unfollow — same reason as follow.
      const body = new URLSearchParams({ user_id: userId }).toString();
      const j = await this.mobileSessionPost(`/api/v1/friendships/destroy/${userId}/`, body);
      if (!j) return false;
      if (j?.friendship_status) return true;
      if (j?.status === "fail") {
        const reason = j?.message ?? "Instagram declined";
        if (reason.includes("feedback_required") || j?.feedback_required === true) return "blocked";
        console.warn(`[webClient] unfollowUser ${userId} fail:`, reason);
        return false;
      }
      return false;
    }, username ? `Unfollow @${username}` : `Unfollow user ${userId}`);
  }

  // ── Send a direct message to a user ───────────────────────────────────────
  // Returns true on success, "blocked" on action-block, false otherwise.
  // Look up an existing DM thread with a user via the mobile API (i.instagram.com).
  // get_by_participants is tried first; the inbox is scanned as a fallback.
  // Raw responses are logged so we can see exactly what Instagram returns.
  private async getThreadIdWithUser(userId: string): Promise<string | null> {
    // 1. Try get_by_participants (fastest — direct thread lookup)
    for (const qs of [
      `participant_user_ids%5B%5D=${userId}`,
      `participant_user_ids[]=${userId}`,
      `participant_user_ids=${userId}`,
    ]) {
      try {
        const res = await igReq({
          host: "i.instagram.com",
          path: `/api/v1/direct_v2/threads/get_by_participants/?${qs}&seq_id=0&limit=20`,
          method: "GET",
          headers: {
            Host: "i.instagram.com",
            "User-Agent": "Instagram 317.0.0.24.109 Android (33/13; 440dpi; 1080x2340; OPPO; CPH2609; OP5961L1; Snapdragon8sGen3; en_US; 558044468)",
            Accept: "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "X-IG-App-ID": APP_ID,
            "X-CSRFToken": this.csrfToken,
            "X-IG-Capabilities": "3brTvwE=",
            "X-IG-Connection-Type": "WIFI",
          },
          cookieJar: this.cookieJar,
          proxyUrl: this.proxyUrl,
        });
        console.log(`[webClient] get_by_participants(${qs.slice(0, 30)}) HTTP ${res.status}:`, res.rawBody.slice(0, 400));
        const j = res.json;
        const tid = j?.thread?.thread_id ?? j?.threads?.[0]?.thread_id ?? null;
        if (tid) {
          console.log(`[webClient] getThreadIdWithUser ${userId}: found via get_by_participants → ${tid}`);
          return String(tid);
        }
      } catch (e: any) {
        console.log(`[webClient] get_by_participants error:`, e?.message);
      }
    }

    // 2. Fetch inbox and scan for the thread — sent DM requests appear in sender's inbox
    try {
      await this.apiThrottle();
      const res = await igReq({
        host: "i.instagram.com",
        path: `/api/v1/direct_v2/inbox/?persistentBadging=true&visual_message_return_type=unseen&thread_message_limit=1&limit=100`,
        method: "GET",
        headers: {
          Host: "i.instagram.com",
          "User-Agent": "Instagram 317.0.0.24.109 Android (33/13; 440dpi; 1080x2340; OPPO; CPH2609; OP5961L1; Snapdragon8sGen3; en_US; 558044468)",
          Accept: "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "X-IG-App-ID": APP_ID,
          "X-CSRFToken": this.csrfToken,
          "X-IG-Capabilities": "3brTvwE=",
          "X-IG-Connection-Type": "WIFI",
        },
        cookieJar: this.cookieJar,
        proxyUrl: this.proxyUrl,
      });
      console.log(`[webClient] inbox HTTP ${res.status} raw(500):`, res.rawBody.slice(0, 500));
      const j = res.json;
      const threads: any[] = j?.inbox?.threads ?? j?.threads ?? [];
      console.log(`[webClient] inbox: ${threads.length} threads, top-level keys: ${Object.keys(j ?? {}).join(",")}`);
      const matched = threads.find((t: any) =>
        (t.users ?? []).some((u: any) => String(u.pk) === String(userId))
      );
      if (matched?.thread_id) {
        console.log(`[webClient] getThreadIdWithUser ${userId}: found in inbox → ${matched.thread_id}`);
        return String(matched.thread_id);
      }
    } catch (e: any) {
      console.log(`[webClient] inbox scan error:`, e?.message);
    }

    console.log(`[webClient] getThreadIdWithUser ${userId}: not found`);
    return null;
  }

  // Send a DM through IgApiClient's native request stack.  This avoids all
  // the header-assembly issues in our hand-rolled _mobileDmPost by letting the
  // library (which was built specifically for this) handle device headers,
  // CSRF, cookie jar management, and HTTPS-proxy routing transparently.
  private async _sendDmViaIgClient(userId: string, text: string): Promise<{ threadId: string; itemId: string } | "blocked" | "session_expired" | false> {
    if (!this.igApiCookies) return false;

    const ig = newIgClient();

    // Restore device fingerprint — use username-scoped seed for uniqueness
    const dmDeviceSeed = (this.userAgentApi ?? this.username ?? "instagram") + "|" + (this.username ?? "instagram");
    if (this.igDeviceState) {
      try {
        const saved = JSON.parse(this.igDeviceState) as { deviceId?: string; uuid?: string; phoneId?: string; adid?: string; deviceString?: string };
        ig.state.generateDevice(dmDeviceSeed);
        if (saved.deviceId)     ig.state.deviceId     = saved.deviceId;
        if (saved.uuid)         ig.state.uuid         = saved.uuid;
        if (saved.phoneId)      ig.state.phoneId      = saved.phoneId;
        if (saved.adid)         ig.state.adid         = saved.adid;
        if (saved.deviceString) ig.state.deviceString = saved.deviceString;
      } catch {
        ig.state.generateDevice(dmDeviceSeed);
      }
    } else {
      ig.state.generateDevice(dmDeviceSeed);
    }

    // Restore cookies from igApiCookies (Jarvee semicolon-separated format)
    const pairs = this.igApiCookies.split(";").map(s => s.trim()).filter(Boolean);
    const now = new Date().toISOString();
    const cookieEntries = pairs.flatMap(pair => {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) return [];
      const key = pair.slice(0, eqIdx).trim();
      let value = pair.slice(eqIdx + 1).trim();
      try { value = decodeURIComponent(value); } catch { /* keep raw */ }
      return [
        { key, value, domain: "i.instagram.com",  path: "/", secure: true, httpOnly: true, hostOnly: true,  creation: now, lastAccessed: now },
        { key, value, domain: ".instagram.com",   path: "/", secure: true, httpOnly: true, hostOnly: false, creation: now, lastAccessed: now },
      ];
    });
    await ig.state.deserializeCookieJar(JSON.stringify({
      version: "tough-cookie@4.1.3",
      storeType: "MemoryCookieStore",
      rejectPublicSuffixes: true,
      cookies: cookieEntries,
    }));

    // Patch IgApiClient app version constants to match our current MOBILE_UA.
    // The library ships with an old version (222.x) that Instagram rejects
    // with checkpoint_required → unsupported_version.
    ig.state.constants.APP_VERSION      = MOBILE_VERSION;
    ig.state.constants.APP_VERSION_CODE = MOBILE_VERSION_CODE;
    patchDeviceStringVersionCode(ig, MOBILE_VERSION_CODE);

    if (this.proxyUrl) ig.state.proxyUrl = this.proxyUrl;

    try {
      console.log(`[webClient] sendDM ${userId}: via IgApiClient broadcastText (uuid=${ig.state.uuid.slice(0,8)}… v${MOBILE_VERSION})`);

      // Validate session: call a lightweight read-only endpoint first.
      // If this returns login_required the igApiCookies are expired and the
      // engine must re-run Verify Credentials before retrying DMs.
      try {
        const meRes = await ig.account.currentUser() as any;
        const meId = meRes?.pk ?? meRes?.user?.pk;
        console.log(`[webClient] sendDM ${userId}: session validated — logged in as pk=${meId}`);
      } catch (sessErr: any) {
        const sessBody = sessErr?.response?.body ?? sessErr?.text;
        console.warn(`[webClient] sendDM ${userId}: session validation FAILED —`, sessErr?.message ?? String(sessErr));
        if (sessBody) console.warn(`[webClient] sendDM ${userId}: session-check body —`, JSON.stringify(sessBody)?.slice(0, 400));
        // Treat any auth error as expired — engine will force mobileLogin again
        if (/login_required|401|403|checkpoint|Bad Request/i.test(String(sessErr?.message ?? ""))) {
          return "session_expired";
        }
      }

      const thread = ig.entity.directThread([userId]);
      const resp = await thread.broadcastText(text) as any;
      const threadId: string = resp?.payload?.thread_id ?? resp?.thread_id ?? "";
      const itemId: string   = resp?.payload?.item_id  ?? resp?.item_id  ?? "";
      console.log(`[webClient] sendDM ${userId}: IgApiClient SUCCESS threadId=${threadId} itemId=${itemId}`);
      return { threadId, itemId };
    } catch (err: any) {
      const msg: string = err?.message ?? String(err);
      // Log the full response body from IgApiClient (IgResponseError.response.body or .text)
      const body = err?.response?.body ?? err?.text ?? err?.response?.text;
      console.warn(`[webClient] sendDM ${userId}: IgApiClient error —`, msg);
      if (body) console.warn(`[webClient] sendDM ${userId}: IgApiClient raw body —`, JSON.stringify(body)?.slice(0, 600));
      if (/feedback_required|ActionBlocked/i.test(msg)) return "blocked";
      if (/login_required|Not authorized/i.test(msg))   return "session_expired";
      return false;
    }
  }

  async sendDirectMessage(userId: string, text: string, username?: string): Promise<{ threadId: string; itemId: string } | "blocked" | false> {
    return this.timed("SendDM", async () => {
      if (!this.isMobileLoggedIn()) {
        console.warn(`[webClient] sendDM ${userId}: no mobile session — call mobileLogin() first`);
        return false;
      }

      // Preferred path: use IgApiClient's native DM stack when igApiCookies are
      // available — it sends all required device headers automatically and avoids
      // the 4415001 / header-mismatch issues of the hand-rolled _mobileDmPost.
      if (this.igApiCookies) {
        const igResult = await this._sendDmViaIgClient(userId, text);
        if (igResult === "session_expired") {
          this.mobileSessionReady = false;
          return false;
        }
        if (igResult !== false) return igResult;
        // fall through to _mobileDmPost if IgApiClient itself errors
        console.warn(`[webClient] sendDM ${userId}: IgApiClient attempt failed, falling back to _mobileDmPost`);
      }

      // Fallback: hand-rolled mobile POST (kept for accounts without igApiCookies)
      const clientCtx = randomUUID();
      const dmBody = new URLSearchParams({
        recipient_users: `[[${userId}]]`,
        client_context: clientCtx,
        offline_threading_id: clientCtx,
        action: "send_item",
        is_shh_mode: "0",
        text,
      }).toString();

      console.log(`[webClient] sendDM ${userId}: mobile broadcast (session cookies: ${this.mobileCookieJar.map(c => c.split("=")[0]).join(",")})`);
      const j = await this._mobileDmPost(`/api/v1/direct_v2/threads/broadcast/text/`, dmBody);
      console.log(`[webClient] sendDM ${userId} response:`, JSON.stringify(j)?.slice(0, 400));

      if (!j) return false;
      if (j?.message === "feedback_required" || j?.feedback_required === true) {
        console.warn(`[webClient] DM BLOCKED to ${userId}`);
        return "blocked";
      }
      if (j?.message === "login_required" || j?.require_login) {
        console.warn(`[webClient] sendDM ${userId}: mobile session expired`);
        this.mobileSessionReady = false;
        return false;
      }
      if (j?.status === "ok") {
        const threadId: string = j?.payload?.thread_id ?? j?.thread_id ?? "";
        const itemId: string  = j?.payload?.item_id  ?? j?.item_id  ?? "";
        console.log(`[webClient] sendDM ${userId}: SUCCESS threadId=${threadId} itemId=${itemId}`);
        return { threadId, itemId };
      }

      const errorCode = j?.content?.error_code ?? j?.error_code;
      console.warn(`[webClient] sendDM ${userId}: failed — error_code=${errorCode} status=${j?.status} message=${j?.message}`);
      return false;
    }, username ? `DM @${username}` : `DM user ${userId}`);
  }

  // POST to i.instagram.com using the mobile session (mobileCookieJar).
  // Used exclusively for DM operations which require a mobile-origin session.
  private async _mobileDmPost(path: string, body = ""): Promise<any> {
    await this.apiThrottle();

    // Extract device identity headers from igDeviceState so Instagram sees the
    // same device fingerprint that was registered during Verify Credentials.
    // IgApiClient always sends these; omitting them triggers 4415001 rejections.
    let deviceUuid = "";
    let deviceAndroidId = "";
    if (this.igDeviceState) {
      try {
        const ds = JSON.parse(this.igDeviceState) as { uuid?: string; deviceId?: string };
        deviceUuid     = ds.uuid     ?? "";
        deviceAndroidId = ds.deviceId ?? "";
      } catch { /* ignore */ }
    }
    const midEntry = this.mobileCookieJar.find(c => c.startsWith("mid="));
    const midValue = midEntry ? midEntry.slice(4) : "";

    const res = await igReq({
      host: "i.instagram.com",
      path,
      method: "POST",
      headers: {
        Host: "i.instagram.com",
        "User-Agent": MOBILE_UA,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-IG-App-ID": MOBILE_AID,
        "X-CSRFToken": this.mobileCsrf,
        "X-IG-Capabilities": "3brTvwE=",
        "X-IG-Connection-Type": "WIFI",
        "X-IG-App-Locale": "en_US",
        ...(deviceUuid      ? { "X-IG-Device-ID":   deviceUuid }      : {}),
        ...(deviceAndroidId ? { "X-IG-Android-ID":  deviceAndroidId } : {}),
        ...(midValue        ? { "X-MID":             midValue }        : {}),
      },
      body,
      cookieJar: this.mobileCookieJar,
      proxyUrl: this.proxyUrl,
    });
    this.mobileCookieJar = mergeCookies(this.mobileCookieJar, res.cookies);
    const newCsrf = extractCsrf(res.cookies);
    if (newCsrf) this.mobileCsrf = newCsrf;
    if (!res.json) console.log(`[webClient] _mobileDmPost ${path} HTTP ${res.status}:`, res.rawBody.slice(0, 300));
    return res.json;
  }

  async unsendDirectMessage(threadId: string, itemId: string): Promise<boolean> {
    return this.timed("UnsendDM", async () => {
      const body = new URLSearchParams({}).toString();
      const j = await this.mobilePost(`/api/v1/direct_v2/threads/${threadId}/items/${itemId}/delete/`, body);
      return j?.status === "ok";
    }, `Unsend thread=${threadId} item=${itemId}`);
  }

  // ── Get user ID + username by username ────────────────────────────────────
  async getUserByUsername(username: string): Promise<{ pk: string; username: string } | null> {
    return this.timed("GetUserByUsername", async () => {
      const j = await this.webGet(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
      const user = j?.data?.user;
      if (!user) return null;
      return { pk: String(user.id), username: user.username };
    }, `Lookup @${username}`);
  }

  // ── Get user biography + full name ───────────────────────────────────────
  async getUserProfile(username: string): Promise<{ biography: string | null; fullName: string | null } | null> {
    return this.timed("GetUserProfile", async () => {
      const j = await this.webGet(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
      const user = j?.data?.user;
      if (!user) return null;
      return {
        biography: user.biography ?? null,
        fullName: user.full_name ?? null,
      };
    }, `Profile @${username}`);
  }

  // mobile-style POST (i.instagram.com) — uses EB web cookie jar + web CSRF.
  // Fine for read/passive actions. NOT for friendships (follow/unfollow) — use
  // mobileSessionPost() for those so the proper igApiCookies session is used.
  private async mobilePost(path: string, body = ""): Promise<any> {
    await this.apiThrottle();
    // Must use the mobile App ID (567067343352427) — the web App ID (936619743392459)
    // routes to the web frontend on i.instagram.com instead of the mobile API backend.
    const MOBILE_APP_ID = "567067343352427";
    const res = await igReq({
      host: "i.instagram.com",
      path,
      method: "POST",
      headers: {
        Host: "i.instagram.com",
        "User-Agent": "Instagram 317.0.0.24.109 Android (33/13; 440dpi; 1080x2340; OPPO; CPH2609; OP5961L1; Snapdragon8sGen3; en_US; 558044468)",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-IG-App-ID": MOBILE_APP_ID,
        "X-CSRFToken": this.csrfToken,
        "X-IG-Capabilities": "3brTvwE=",
        "X-IG-Connection-Type": "WIFI",
      },
      body,
      cookieJar: this.cookieJar,
      proxyUrl: this.proxyUrl,
    });
    // Strip csrftoken from i.instagram.com responses — it must NOT overwrite
    // the www.instagram.com csrftoken used by webPost (X-CSRFToken header +
    // Cookie header must stay in sync; clobbering causes 302 on follow POST).
    const safeCookies = res.cookies.filter(c => !c.startsWith("csrftoken="));
    this.cookieJar = mergeCookies(this.cookieJar, safeCookies);
    if (!res.json) console.log(`[webClient] mobilePost ${path} status=${res.status} body(300):`, res.rawBody.slice(0, 300));
    return res.json;
  }

  // Bootstrap a real csrftoken for the mobile session — zero EB dependency.
  // Uses three strategies in order:
  //   1. /api/v1/si/fetch_headers/ — unauthenticated cold-start call the real
  //      Instagram app makes. Always returns csrftoken in Set-Cookie.
  //   2. /api/v1/accounts/current_user/ — authenticated; sometimes echoes it.
  //   3. Generated random token as last resort.
  private async _bootstrapMobileCsrf(): Promise<void> {
    const MOBILE_APP_ID = "567067343352427";
    let fullMobileUA: string;
    if (this.userAgentApi && this.userAgentApi.startsWith("Instagram ")) {
      fullMobileUA = this.userAgentApi;
    } else {
      let deviceStr: string | undefined;
      if (this.igDeviceState) {
        try { deviceStr = JSON.parse(this.igDeviceState).deviceString; } catch { /* ignore */ }
      }
      deviceStr = deviceStr ?? this.userAgentApi;
      fullMobileUA = deviceStr
        ? `Instagram ${MOBILE_VERSION} Android (${deviceStr}; ${MOBILE_VERSION_CODE})`
        : MOBILE_UA;
    }

    // ── Strategy 1: /api/v1/si/fetch_headers/ ────────────────────────────────
    // This is the real Instagram app cold-start call. It requires NO authentication
    // and reliably returns a fresh csrftoken in Set-Cookie — exactly what the app
    // does after every cold start to bootstrap CSRF before any write action.
    try {
      const guid = randomUUID();
      const res = await igReq({
        host: "i.instagram.com",
        path: `/api/v1/si/fetch_headers/?challenge_type=signup&guid=${guid}`,
        method: "GET",
        headers: {
          Host: "i.instagram.com",
          "User-Agent": fullMobileUA,
          Accept: "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "X-IG-App-ID": MOBILE_APP_ID,
          "X-IG-Capabilities": "3brTvwE=",
          "X-IG-Connection-Type": "WIFI",
          "X-IG-Bandwidth-Speed-KBPS": "-1.000",
          "X-IG-Bandwidth-TotalBytes-B": "0",
          "X-IG-Bandwidth-TotalTime-MS": "0",
        },
        cookieJar: this.mobileCookieJar,
        proxyUrl: this.proxyUrl,
      });
      // Merge all cookies back (mid, csrftoken, ig_did, etc.)
      if (res.cookies.length) {
        this.mobileCookieJar = mergeCookies(this.mobileCookieJar, res.cookies);
      }
      const csrfFromCookie = extractCsrf(res.cookies);
      const csrfFromBody   = typeof res.json?.token === "string" ? res.json.token : null;
      const newCsrf = csrfFromCookie || csrfFromBody;
      if (newCsrf) {
        this.mobileCsrf = newCsrf;
        if (!csrfFromCookie) {
          this.mobileCookieJar = mergeCookies(this.mobileCookieJar, [`csrftoken=${newCsrf}`]);
        }
        console.log(`[webClient] _bootstrapMobileCsrf: csrftoken from fetch_headers ${csrfFromCookie ? "cookie" : "body"} (${newCsrf.slice(0, 8)}...) status=${res.status}`);
        return;
      }
      console.warn(`[webClient] _bootstrapMobileCsrf: fetch_headers returned no csrftoken (status=${res.status}, cookies=${JSON.stringify(res.cookies.slice(0, 3))}, body=${res.rawBody.slice(0,100)})`);
    } catch (err: any) {
      console.warn(`[webClient] _bootstrapMobileCsrf fetch_headers failed: ${err?.message}`);
    }

    // ── Strategy 2: current_user ──────────────────────────────────────────────
    // Authenticated endpoint — sometimes echoes csrftoken when session is fresh.
    try {
      const res = await igReq({
        host: "i.instagram.com",
        path: "/api/v1/accounts/current_user/?edit=true",
        method: "GET",
        headers: {
          Host: "i.instagram.com",
          "User-Agent": fullMobileUA,
          Accept: "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "X-IG-App-ID": MOBILE_APP_ID,
          "X-IG-Capabilities": "3brTvwE=",
          "X-IG-Connection-Type": "WIFI",
          "X-IG-Bandwidth-Speed-KBPS": "-1.000",
          "X-IG-Bandwidth-TotalBytes-B": "0",
          "X-IG-Bandwidth-TotalTime-MS": "0",
        },
        cookieJar: this.mobileCookieJar,
        proxyUrl: this.proxyUrl,
      });
      if (res.cookies.length) {
        this.mobileCookieJar = mergeCookies(this.mobileCookieJar, res.cookies);
      }
      const newCsrf = extractCsrf(res.cookies);
      if (newCsrf) {
        this.mobileCsrf = newCsrf;
        console.log(`[webClient] _bootstrapMobileCsrf: csrftoken from current_user (${newCsrf.slice(0, 8)}...) status=${res.status}`);
        return;
      }
      const bodyToken = res.json?.csrf_token ?? res.json?.csrftoken;
      if (bodyToken) {
        this.mobileCsrf = String(bodyToken);
        this.mobileCookieJar = mergeCookies(this.mobileCookieJar, [`csrftoken=${this.mobileCsrf}`]);
        console.log(`[webClient] _bootstrapMobileCsrf: csrftoken from current_user body (${this.mobileCsrf.slice(0, 8)}...)`);
        return;
      }
    } catch (err: any) {
      console.warn(`[webClient] _bootstrapMobileCsrf current_user failed: ${err?.message}`);
    }

    // ── Strategy 3: derive from sessionid ────────────────────────────────────
    // Instagram's mobile csrftoken is not truly secret — it is derived from the
    // session. As a last-resort, generate a random token and inject it into the
    // cookie jar so mobileSessionPost can proceed. Instagram has been observed
    // accepting self-generated tokens on fresh mobile sessions.
    const fallback = randomUUID().replace(/-/g, "");
    this.mobileCsrf = fallback;
    this.mobileCookieJar = mergeCookies(this.mobileCookieJar, [`csrftoken=${fallback}`]);
    console.warn(`[webClient] _bootstrapMobileCsrf: all strategies failed — using generated token (${fallback.slice(0, 8)}...)`);
  }

  // Action POST using the igApiCookies mobile session (mobileCookieJar + mobileCsrf).
  // Used for write actions (follow, unfollow) where i.instagram.com strictly requires
  // a proper mobile-originated session — web cookies return login_required on those.
  // If no igApiCookies session is available, returns null immediately (no fallback).
  private async mobileSessionPost(path: string, body = ""): Promise<any> {
    const hasMobileSession = this.mobileCookieJar.some(c => c.startsWith("sessionid="));
    if (!hasMobileSession) {
      console.warn(`[webClient] mobileSessionPost ${path}: no igApiCookies session — cannot proceed (igApiCookies required for write actions)`);
      return null;
    }
    // If this is the first call after a session restore, mobileCsrf will be the
    // "missing" placeholder. Bootstrap a real token by hitting i.instagram.com
    // directly with the mobile session — no EB cookies involved at any point.
    if (this.mobileCsrf === "missing" || !this.mobileCsrf) {
      await this._bootstrapMobileCsrf();
    }
    await this.apiThrottle();
    const MOBILE_APP_ID = "567067343352427";
    const csrf = this.mobileCsrf || this.csrfToken || "missing";
    // Build full Instagram mobile UA — userAgentApi stores the device string portion only
    // (e.g. "34/14; 420dpi; 1220x2712; Xiaomi; ..."). Wrap it if it's not already a full UA.
    let fullMobileUA: string;
    if (this.userAgentApi && this.userAgentApi.startsWith("Instagram ")) {
      fullMobileUA = this.userAgentApi;
    } else {
      // Try to get deviceString from parsed ig_device_state first, fall back to userAgentApi
      let deviceStr: string | undefined;
      if (this.igDeviceState) {
        try { deviceStr = JSON.parse(this.igDeviceState).deviceString; } catch { /* ignore */ }
      }
      deviceStr = deviceStr ?? this.userAgentApi;
      fullMobileUA = deviceStr
        ? `Instagram ${MOBILE_VERSION} Android (${deviceStr}; ${MOBILE_VERSION_CODE})`
        : MOBILE_UA;
    }
    console.log(`[webClient] mobileSessionPost ${path} using igApiCookies session (csrf=${csrf.slice(0,8) + "..."}, ua=${fullMobileUA.slice(0, 60)})`);
    const res = await igReq({
      host: "i.instagram.com",
      path,
      method: "POST",
      headers: {
        Host: "i.instagram.com",
        "User-Agent": fullMobileUA,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-IG-App-ID": MOBILE_APP_ID,
        "X-CSRFToken": csrf,
        "X-IG-Capabilities": "3brTvwE=",
        "X-IG-Connection-Type": "WIFI",
        "X-IG-Bandwidth-Speed-KBPS": "-1.000",
        "X-IG-Bandwidth-TotalBytes-B": "0",
        "X-IG-Bandwidth-TotalTime-MS": "0",
      },
      body,
      cookieJar: this.mobileCookieJar,
      proxyUrl: this.proxyUrl,
    });
    // Merge response cookies back into mobileCookieJar to keep session fresh
    if (res.cookies.length) {
      this.mobileCookieJar = mergeCookies(this.mobileCookieJar, res.cookies);
      const newCsrf = extractCsrf(res.cookies);
      if (newCsrf) this.mobileCsrf = newCsrf;
    }
      // Always log non-200 responses; log body snippet for debugging
    if (res.status !== 200 || !res.json) {
      console.warn(`[webClient] mobileSessionPost ${path} status=${res.status} body(400):`, res.rawBody.slice(0, 400));
    } else {
      const feedLen = res.json?.feed_items?.length ?? res.json?.items?.length ?? null;
      if (feedLen !== null) {
        console.log(`[webClient] mobileSessionPost ${path} status=${res.status} feed_items=${feedLen} (status="${res.json?.status}")`);
      }
    }
    return res.json;
  }

  // ── Multipart/form-data POST to i.instagram.com ──────────────────────────
  // Used for photo upload via /api/v1/media/upload/ — a regular /api/v1/
  // path that accepts our web-session cookies (same auth as like/follow/
  // comment which are confirmed working).  Avoids the rupload binary protocol
  // which requires a genuine mobile Bearer-token session and rejects web
  // sessionids with HTML 404.
  private async mobilePostMultipart(path: string, parts: Array<{ name: string; value: string | Buffer; filename?: string; contentType?: string }>): Promise<any> {
    await this.apiThrottle();
    const boundary = `----InstaBoundary${Date.now()}`;
    const chunks: Buffer[] = [];
    for (const part of parts) {
      let header = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
      if (part.filename) header += `; filename="${part.filename}"`;
      header += "\r\n";
      if (part.contentType) header += `Content-Type: ${part.contentType}\r\n`;
      header += "\r\n";
      chunks.push(Buffer.from(header));
      chunks.push(typeof part.value === "string" ? Buffer.from(part.value) : part.value);
      chunks.push(Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(chunks);

    const headers: Record<string, string> = {
      "User-Agent": MOBILE_UA,
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length),
      "X-IG-App-ID": MOBILE_AID,
      "X-CSRFToken": this.csrfToken,
      "X-IG-Capabilities": "3brTvwE=",
      "X-IG-Connection-Type": "WIFI",
      Cookie: this.cookieJar.join("; "),
    };

    let agent: any;
    if (this.proxyUrl) {
      const { HttpsProxyAgent } = await import("https-proxy-agent");
      agent = new HttpsProxyAgent(this.proxyUrl, { keepAlive: false });
    }

    let res: Awaited<ReturnType<typeof httpsRequest>>;
    try {
      res = await httpsRequest(
        { host: "i.instagram.com", port: 443, path, method: "POST", headers, ...(agent ? { agent } : {}) },
        body,
      );
    } finally {
      if (agent) agent.destroy();
    }
    let json: any = null;
    try { json = JSON.parse(res.body); } catch {}
    if (!json) console.log(`[webClient] mobilePostMultipart ${path} status=${res.status} body:`, res.body.slice(0, 400));
    return json;
  }

  // ── Download an image from a CDN URL into a Buffer ────────────────────────
  async downloadImage(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const options: https.RequestOptions = {
        host: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
          Accept: "image/*,*/*",
        },
      };
      https.get(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end",  () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }).on("error", reject);
    });
  }


  // ── Get recent photo posts from a user's feed (with image URLs) ───────────
  // Used when repostUseHikerApi is OFF — the account's own session does the scrape.
  async getUserFeedItems(username: string): Promise<Array<{
    mediaId: string;
    shortcode: string;
    imageUrl: string;
    caption: string;
    takenAt: number;
  }>> {
    return this.timed("GetUserFeed", async () => {
      const user = await this.getUserByUsername(username);
      if (!user) return [];

      const j = await this.mobileGet(`/api/v1/feed/user/${user.pk}/?count=12`);
      const items: any[] = j?.items ?? [];

      return items.flatMap((item: any) => {
        const mediaType: number = item?.media_type ?? 1;
        if (mediaType !== 1 && mediaType !== 8) return [];

        const mediaId  = String(item.id ?? item.pk ?? "");
        const caption  = item.caption?.text ?? "";
        const takenAt  = item.taken_at ?? Math.floor(Date.now() / 1000);

        const firstMedia = mediaType === 8 ? (item.carousel_media?.[0] ?? item) : item;
        const candidates: any[] = firstMedia.image_versions2?.candidates ?? [];
        const imageUrl = candidates[0]?.url ?? "";

        if (!mediaId || !imageUrl) return [];
        return [{ mediaId, shortcode: this.mediaIdToShortcode(mediaId), imageUrl, caption, takenAt }];
      });
    }, `Get feed of @${username}`);
  }

  // ── Upload a photo and create the Instagram post ──────────────────────────
  /** Uploads a photo and returns the new media ID string on success, or null on failure. */
  async uploadPhoto(imageBuffer: Buffer, caption: string): Promise<string | null> {
    return this.timed("UploadPhoto", async () => {
      const uploadId = String(Date.now());

      // Step 1 — multipart/form-data upload via /api/v1/media/upload/
      // This is a standard /api/v1/ endpoint (same auth path as like/follow)
      // so it accepts our web session cookies without requiring a Bearer token.
      // The rupload binary protocol (/rupload/igphoto/...) requires a genuine
      // mobile session and rejects web sessionids.
      const uploadRes = await this.mobilePostMultipart("/api/v1/media/upload/", [
        { name: "upload_id", value: uploadId },
        { name: "media_type", value: "1" },
        { name: "image_compression", value: JSON.stringify({ lib_name: "moz", lib_version: "3.1.m", quality: "95" }) },
        { name: "photo", value: imageBuffer, filename: `photo_${uploadId}.jpg`, contentType: "image/jpeg" },
      ]);
      const uploaded = uploadRes?.upload_id != null || uploadRes?.status === "ok";
      if (!uploaded) {
        console.warn(`[webClient] media/upload failed: ${JSON.stringify(uploadRes)}`);
        return null;
      }

      // Step 2 — configure (creates the post)
      const body = new URLSearchParams({
        upload_id: uploadId,
        caption,
        source_type: "4",
        timezone_offset: "0",
        date_time_original: new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14),
      }).toString();

      const confRes = await this.mobilePost("/api/v1/media/configure/", body);
      const mediaId: string | null = confRes?.media?.id ? String(confRes.media.id) : null;
      if (!mediaId && confRes?.status === "ok") return uploadId;
      return mediaId;
    }, `Upload photo (${imageBuffer.length}B) caption="${caption.slice(0, 30)}"`);
  }

  /** Disables comments on a post via the Instagram private API. */
  async disableComments(mediaId: string): Promise<void> {
    return this.timed("DisableComments", async () => {
      const body = new URLSearchParams({ media_id: mediaId }).toString();
      await this.mobilePost(`/api/v1/media/${mediaId}/disable_comments/`, body);
    }, `Disable comments on ${mediaId}`);
  }

  // ── Scrape recent posts from a hashtag → returns users ────────────────────
  // The sections endpoint requires POST, not GET
  async getHashtagUsers(hashtag: string, maxUsers = 50): Promise<{ pk: string; username: string; fullName: string }[]> {
    return this.timed("HashtagScrape", async () => {
      const tag = hashtag.replace(/^#/, "");
      const users: { pk: string; username: string; fullName: string }[] = [];
      const seen = new Set<string>();
      let maxId = "";
      let page = 0;

      const maxPages = Math.min(Math.ceil(maxUsers / 12) + 2, 25);
      while (users.length < maxUsers && page < maxPages) {
        const body = new URLSearchParams({
          tab_type: "recent",
          page: String(page + 1),
          surface: "grid",
          ...(maxId ? { max_id: maxId } : {}),
        }).toString();

        const j = await this.mobilePost(`/api/v1/tags/${encodeURIComponent(tag)}/sections/`, body);

        if (!j?.sections?.length) break;

        for (const section of j.sections) {
          const medias = section.layout_content?.medias ?? section.layout_content?.fill_items ?? [];
          for (const item of medias) {
            const media = item.media ?? item;
            const u = media?.user;
            if (!u?.pk || !u?.username) continue;
            if (seen.has(String(u.pk))) continue;
            seen.add(String(u.pk));
            users.push({ pk: String(u.pk), username: u.username, fullName: String(u.full_name ?? "") });
          }
        }

        maxId = j.next_max_id ?? "";
        if (!maxId || !j.more_available) break;
        page++;
      }

      console.log(`[webClient] hashtag #${tag}: found ${users.length} users`);
      return users.slice(0, maxUsers);
    }, `Scrape #${hashtag.replace(/^#/, "")}`);
  }

  // ── Scrape followers of a target account ──────────────────────────────────
  async getFollowers(userId: string, maxFollowers = 50): Promise<{ pk: string; username: string; fullName: string }[]> {
    return this.timed("FollowersScrape", async () => {
      const users: { pk: string; username: string; fullName: string }[] = [];
      let maxId = "";

      const maxPages = Math.min(Math.ceil(maxFollowers / 50) + 2, 25);
      for (let page = 0; page < maxPages && users.length < maxFollowers; page++) {
        const qs = new URLSearchParams({ count: "50", ...(maxId ? { max_id: maxId } : {}) });
        const j = await this.mobileGet(`/api/v1/friendships/${userId}/followers/?${qs}`);
        if (!j?.users?.length) break;
        for (const u of j.users) {
          if (u.pk && u.username) users.push({ pk: String(u.pk), username: u.username, fullName: String(u.full_name ?? "") });
        }
        maxId = j.next_max_id ?? "";
        if (!maxId) break;
      }

      console.log(`[webClient] followers of ${userId}: found ${users.length}`);
      return users.slice(0, maxFollowers);
    }, `Followers of ${userId}`);
  }

  // ── Resolve own account pk (reuses current_user endpoint, no extra call) ──
  async getOwnUserId(): Promise<string | null> {
    return this.timed("GetOwnUser", async () => {
      const j = await this.mobileGet(`/api/v1/accounts/current_user/?edit=true`);
      return j?.user?.pk ? String(j.user.pk) : null;
    }, "Get own user ID");
  }

  // ── Search for a user by username (safer than web_profile_info lookup) ────
  // Uses the search bar endpoint — looks like a human typing in the search box.
  async searchUserByUsername(username: string): Promise<{ pk: string; username: string } | null> {
    return this.timed("SearchUser", async () => {
      const j = await this.mobileGet(`/api/v1/users/search/?timezone_offset=0&count=5&q=${encodeURIComponent(username)}`);
      const users: any[] = j?.users ?? [];
      const match = users.find((u: any) => String(u.username).toLowerCase() === username.toLowerCase());
      return match ? { pk: String(match.pk), username: String(match.username) } : null;
    }, `Search @${username}`);
  }

  // ── Get suggested users (discover/ayml) ──────────────────────────────────
  // Simulates a user visiting the "Suggested for you" / discover page.
  // Called between follows to add natural API variety.
  async getSuggestedUsers(): Promise<void> {
    return this.timed("GetSuggestedUsers", async () => {
      await this.mobileGet(`/api/v1/discover/ayml/`);
    }, "Get suggested users");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Standalone account creation via mobile API (no existing session required).
// Uses the same mobile API path as a real Android Instagram app.
// ─────────────────────────────────────────────────────────────────────────────

export type SignupResult = {
  status: "success" | "email_verification" | "phone_verification" | "error";
  steps: string[];
  message?: string;
  userId?: string;
  username?: string;
  sessionId?: string;
  sessionCookies?: string[];
  rawResponse?: unknown;
};

const _pendingSignupSessions = new Map<string, {
  cookieJar: string[];
  csrfToken: string;
  baseHeaders: Record<string, string>;
  guid: string;
  android_id: string;
  username: string;
  proxyUrl?: string;
}>();

export async function createInstagramAccountViaApi(params: {
  username: string;
  password: string;
  email: string;
  firstName?: string;
  day: number;
  month: number;
  year: number;
  proxyUrl?: string;
  bio?: string;
  userAgent?: string;
  apiLimits?: { requestsMin: number; requestsMax: number; everySecondsMin: number; everySecondsMax: number };
}): Promise<SignupResult> {
  const { username, password, email, firstName = "", day, month, year, proxyUrl, bio, userAgent, apiLimits } = params;

  // Delay helper: respects the API limits by sleeping (everySecondsMin/reqMax … everySecondsMax/reqMin) seconds
  const stepDelay = apiLimits
    ? () => {
        const minMs = Math.max(500, (apiLimits.everySecondsMin / apiLimits.requestsMax) * 1000);
        const maxMs = Math.max(minMs, (apiLimits.everySecondsMax / apiLimits.requestsMin) * 1000);
        const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
        return new Promise<void>(r => setTimeout(r, ms));
      }
    : () => Promise.resolve();
  const rawUA = userAgent || randomMobileUA();
  // Accept either a full "Instagram X.X.X Android (...)" string or a raw device descriptor
  const effectiveUA = rawUA.startsWith("Instagram ")
    ? rawUA
    : `Instagram ${MOBILE_VERSION} Android (${rawUA}; ${MOBILE_VERSION_CODE})`;
  const steps: string[] = [];
  const step = (msg: string) => { steps.push(msg); console.log(`[accountCreator] ${msg}`); };

  const ig_did     = randomUUID();
  const phone_id   = randomUUID();
  const waterfall_id = randomUUID();
  const android_id = `android-${ig_did.replace(/-/g, "").slice(0, 16)}`;
  const guid       = ig_did;
  const mid        = Buffer.from(randomUUID()).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
  let cookieJar: string[] = [`ig_did=${ig_did}`, `mid=${mid}`];

  // Headers restored to match the EXACT state of the one successful HTTP 200
  // (commit 57e5f68 / 44b34a0 — before gzip fix, before X-FB-Client-IP was added).
  // Do NOT add X-FB-Client-IP or X-FB-Server-Cluster — those were added AFTER
  // the 200 as speculative improvements and are absent from the working config.
  const BLOKS_VERSION_ID = "388ece79ebc0e70e87873505ed1b0ff335ae2868a978cc951b6721c41d46a30a";
  const baseHeaders: Record<string, string> = {
    "Host": "i.instagram.com",
    "User-Agent": effectiveUA,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "X-IG-App-ID": MOBILE_AID,
    "X-IG-App-Version": MOBILE_VERSION,
    "X-IG-Capabilities": "3brTv10=",
    "X-IG-Connection-Type": "WIFI",
    "X-IG-Bandwidth-Speed-KBPS": "-1.000",
    "X-IG-Bandwidth-TotalBytes-B": "0",
    "X-IG-Bandwidth-TotalTime-MS": "0",
    "X-IG-Device-ID": ig_did,
    "X-IG-Android-ID": android_id,
    "X-MID": mid,
    "X-Bloks-Version-Id": BLOKS_VERSION_ID,
    "X-Bloks-Is-Layout-RTL": "false",
    "X-FB-HTTP-Engine": "Liger",
    "X-IG-WWW-Claim": "0",
  };

  // CSRF strategy: use "missing" throughout the entire signup flow.
  //
  // The one successful HTTP 200 from accounts/create/ was obtained when
  // fetch_headers (the old Step 1) returned no cookie for our datacenter IP,
  // leaving csrfToken = "missing" for ALL calls: launcher/sync, qe/sync, username
  // check, and accounts/create/.  Bootstrapping a real token from www.instagram.com
  // and then switching back to "missing" only for accounts/create/ creates an
  // inconsistency that Instagram's backend appears to use as a rejection signal —
  // every attempt with that mixed state produced the generic "There was an error" 400.
  //
  // instagram-private-api itself uses "missing" for all pre-login calls, confirming
  // this is the correct/expected value for unauthenticated signup sessions.
  let csrfToken = "missing";
  cookieJar = mergeCookies(cookieJar, [`csrftoken=missing`]);
  step(`CSRF set to "missing" (unauthenticated signup — consistent across all calls)`);

  await stepDelay();

  // Log proxy being used (or lack of one) so we can verify it in diagnostics
  step(`Using proxy: ${proxyUrl ? proxyUrl.replace(/:[^@]*@/, ":***@") : "none (direct connection)"}`);

  // Proxy health tracker — counts how many of the two pre-signup sync calls
  // (launcher/sync + qe/sync) returned any cookies.  If both return zero cookies
  // it almost always means Instagram's edge/CDN is silently blocking the proxy IP
  // before the request reaches the real signup backend.  We use this flag to give
  // a more accurate error message if accounts/create/ then returns a misleading
  // business-logic error (e.g. "email_is_taken" when the email is actually free).
  let syncCookiesSeen = 0;

  // Step 1b: launcher/sync — warm up device fingerprint on Instagram's servers.
  // instagram-private-api always calls this as part of preLoginFlow() before any
  // account operation. Without it the device is "cold" on Instagram's backend and
  // accounts/create/ returns the generic "There was an error" 400.
  step("Warming device via launcher/sync...");
  try {
    const launcherRes = await igReq({
      host: "i.instagram.com",
      path: "/api/v1/launcher/sync/",
      method: "POST",
      headers: {
        ...baseHeaders,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-CSRFToken": csrfToken,
      },
      body: signBody({
        id: guid,
        server_config_retrieval: "1",
        _csrftoken: csrfToken,
        _uuid: guid,
      }),
      cookieJar,
      proxyUrl,
    });
    cookieJar = mergeCookies(cookieJar, launcherRes.cookies);
    if (launcherRes.cookies.length) syncCookiesSeen++;
    step(`launcher/sync HTTP ${launcherRes.status} — cookies: [${launcherRes.cookies.map(c => c.split("=")[0]).join(", ") || "none"}]`);
    console.log(`[accountCreator] launcher/sync HTTP=${launcherRes.status}:`, JSON.stringify(launcherRes.json ?? {}).slice(0, 200));
  } catch (e: any) {
    step(`launcher/sync error (non-fatal): ${e?.message}`);
  }

  await stepDelay();

  // Step 1c: qe/sync — fetch Instagram's password encryption public key
  // Instagram API v200+ requires enc_password (AES-256-GCM + RSA-OAEP) instead of plaintext.
  let encPassword: string | null = null;
  let rawPubKey: string | undefined;
  let rawKeyId: string | number | undefined;
  step("Fetching password encryption key via qe/sync...");
  try {
    // qe/sync must be signed (same as instagram-private-api's QeRepository.sync()) and
    // must include the login experiments string so Instagram returns a real csrftoken cookie.
    const LOGIN_EXPERIMENTS = "ig_android_fci_onboarding_friend_search,ig_android_device_detection_info_upload,ig_android_account_linking_upsell_universe,ig_android_direct_main_tab_universe_v2,ig_android_allow_account_switch_once_media_upload_finish_universe,ig_android_sign_in_help_only_one_account_family_universe,ig_android_sms_retriever_backtest_universe,ig_android_direct_add_direct_to_android_native_photo_share_sheet,ig_android_spatial_account_switch_universe,ig_growth_android_profile_pic_prefill_with_fb_pic_2,ig_account_identity_logged_out_signals_global_holdout_universe,ig_android_prefill_main_account_username_on_login_screen_universe,ig_android_login_identifier_fuzzy_match,ig_android_mas_remove_close_friends_entrypoint,ig_android_shared_email_reg_universe,ig_android_video_render_codec_low_memory_gc,ig_android_custom_transitions_universe,ig_android_push_fcm,multiple_account_recovery_universe,ig_android_show_login_info_reminder_universe,ig_android_email_fuzzy_matching_universe,ig_android_one_tap_aymh_redesign_universe,ig_android_direct_send_like_from_notification,ig_android_suma_landing_page,ig_android_prefetch_debug_dialog,ig_android_smartlock_hints_universe,ig_android_black_out,ig_activation_global_discretionary_sms_holdout,ig_android_video_ffmpegutil_pts_fix,ig_android_multi_tap_login_new,ig_save_smartlock_universe,ig_android_caption_typeahead_fix_on_o_universe,ig_android_enable_keyboardlistener_redesign,ig_android_sign_in_password_visibility_universe,ig_android_nux_add_email_device,ig_android_direct_remove_view_mode_stickiness_universe,ig_android_hide_contacts_list_in_nux,ig_android_new_users_one_tap_holdout_universe,ig_android_ingestion_video_support_hevc_decoding,ig_android_mas_notification_badging_universe,ig_android_secondary_account_in_main_reg_flow_universe,ig_android_secondary_account_creation_universe,ig_android_account_recovery_auto_login,ig_android_pwd_encrytpion,ig_android_bottom_sheet_keyboard_leaks,ig_android_sim_info_upload,ig_android_mobile_http_flow_device_universe,ig_android_hide_fb_button_when_not_installed_universe,ig_android_account_linking_on_concurrent_user_session_infra_universe,ig_android_targeted_one_tap_upsell_universe,ig_android_gmail_oauth_in_reg,ig_android_account_linking_flow_shorten_universe,ig_android_vc_interop_use_test_igid_universe,ig_android_notification_unpack_universe,ig_android_registration_confirmation_code_universe,ig_android_device_based_country_verification,ig_android_log_suggested_users_cache_on_error,ig_android_reg_modularization_universe,ig_android_device_verification_separate_endpoint,ig_android_universe_noticiation_channels,ig_android_account_linking_universe,ig_android_hsite_prefill_new_carrier,ig_android_one_login_toast_universe,ig_android_retry_create_account_universe,ig_android_family_apps_user_values_provider_universe,ig_android_reg_nux_headers_cleanup_universe,ig_android_mas_ui_polish_universe,ig_android_device_info_foreground_reporting,ig_android_shortcuts_2019,ig_android_device_verification_fb_signup,ig_android_onetaplogin_optimization,ig_android_passwordless_account_password_creation_universe,ig_android_black_out_toggle_universe,ig_video_debug_overlay,ig_android_ask_for_permissions_on_reg,ig_assisted_login_universe,ig_android_security_intent_switchoff,ig_android_device_info_job_based_reporting,ig_android_add_account_button_in_profile_mas_universe,ig_android_add_dialog_when_delinking_from_child_account_universe,ig_android_passwordless_auth,ig_radio_button_universe_2,ig_android_direct_main_tab_account_switch,ig_android_recovery_one_tap_holdout_universe,ig_android_modularized_dynamic_nux_universe,ig_android_fb_account_linking_sampling_freq_universe,ig_android_fix_sms_read_lollipop,ig_android_access_flow_prefil";
    const syncRes = await igReq({
      host: "i.instagram.com",
      path: "/api/v1/qe/sync/",
      method: "POST",
      headers: {
        ...baseHeaders,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-CSRFToken": csrfToken,
        "X-DEVICE-ID": guid,
      },
      body: signBody({ id: guid, _uid: "0", server_config_retrieval: "1", _csrftoken: csrfToken, _uuid: guid, experiments: LOGIN_EXPERIMENTS }),
      cookieJar,
      proxyUrl,
    });
    cookieJar = mergeCookies(cookieJar, syncRes.cookies);
    if (syncRes.cookies.length) syncCookiesSeen++;
    // CRITICAL: re-sync csrfToken from jar — qe/sync may have set a real csrftoken cookie.
    // If the jar now has a real token but we keep "missing" in the body, Instagram's CSRF
    // check will see a mismatch on accounts/create/ and return "There was an error".
    const syncedCsrf = cookieJar.find(c => c.startsWith("csrftoken="))?.split("=").slice(1).join("=") ?? "";
    console.log(`[accountCreator] qe/sync HTTP=${syncRes.status} cookies=[${syncRes.cookies.join("; ")}]`);
    if (syncedCsrf && syncedCsrf !== "missing") {
      csrfToken = syncedCsrf;
      step(`csrfToken updated after qe/sync → ${csrfToken.slice(0, 8)}...`);
    } else {
      step(`qe/sync HTTP ${syncRes.status} — csrfToken stays "missing" (cookies returned: ${syncRes.cookies.length ? syncRes.cookies.map(c => c.split("=")[0]).join(",") : "none"})`);
    }
    const h = syncRes.responseHeaders;
    rawKeyId  = Array.isArray(h["ig-set-password-encryption-key-id"])  ? h["ig-set-password-encryption-key-id"][0]  : h["ig-set-password-encryption-key-id"];
    rawPubKey = Array.isArray(h["ig-set-password-encryption-pub-key"]) ? h["ig-set-password-encryption-pub-key"][0] : h["ig-set-password-encryption-pub-key"];
    if (rawPubKey && rawKeyId) {
      const keyId = parseInt(String(rawKeyId), 10);
      const decodedKeyPreview = Buffer.from(String(rawPubKey), "base64").toString("utf8").slice(0, 40).replace(/\n/g, "\\n");
      encPassword = encryptPassword(password, String(rawPubKey), keyId);
      step(`Password encryption key obtained (keyId=${keyId}, keyStart="${decodedKeyPreview}...") — using enc_password (${encPassword.slice(0, 28)}...)`);
    } else {
      step(`qe/sync HTTP ${syncRes.status} — no key headers (keys=${Object.keys(h).filter(k=>k.startsWith("ig-")).join(",")||"none"}), will send plaintext password`);
    }
  } catch (e: any) {
    step(`qe/sync error: ${e?.message} — will send plaintext password`);
  }

  await stepDelay();

  // Step 2: check_username — verify the desired username is available
  step(`Checking availability of @${username}...`);
  try {
    const res = await igReq({
      host: "i.instagram.com",
      path: `/api/v1/accounts/check_username/`,
      method: "POST",
      headers: {
        ...baseHeaders,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-CSRFToken": csrfToken,
      },
      body: new URLSearchParams({ username, _uuid: guid, _csrftoken: csrfToken }).toString(),
      cookieJar,
      proxyUrl,
    });
    const j = res.json;
    // Only merge cookies if we got a valid JSON API response — HTML 404 pages from some
    // proxies/edge nodes can inject a real csrftoken cookie that would then mismatch our
    // _csrftoken body value and break the subsequent accounts/create/ call.
    const isJsonResponse = j !== null && typeof j === "object";
    if (isJsonResponse) {
      cookieJar = mergeCookies(cookieJar, res.cookies);
    }
    if (j?.available === false) {
      step(`@${username} is already taken`);
      return { status: "error", steps, message: `Username @${username} is already taken` };
    }
    if (j?.available === true) {
      step(`@${username} is available`);
    } else {
      const detail = isJsonResponse ? JSON.stringify(j) : "(HTML response — skipping cookie merge)";
      step(`Username check HTTP ${res.status} — ${detail}`);
      if (!isJsonResponse && syncCookiesSeen === 0) {
        step(`⚠️ Proxy warning: both sync calls + username check returned no real API responses — this proxy IP may be flagged by Instagram's CDN. Signup errors below may be false positives.`);
      }
    }
  } catch (e: any) {
    step(`Username check error: ${e?.message} (continuing)`);
  }

  await stepDelay();

  // Step 3: accounts/create/ — the actual signup call
  const birthday = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  step(`Submitting signup (${username} / ${email} / dob ${birthday})...`);
  // accounts/create/ requires Instagram's signed_body format:
  //   ig_sig_key_version=4&signed_body=HMAC_SHA256.JSON_PARAMS
  // Use only the fields that instagram-private-api sends (the reference implementation).
  // Extra fields (is_from_logged_out, seamless_login_enabled, tos_version, gdpr_s, etc.)
  // cause Instagram's server-side validator to reject the request with the generic
  // "There was an error with your request" 400 when not expected by the server version.
  // IMPORTANT: _csrftoken in the CREATE body must be "missing".
  // instagram-private-api always sends "missing" here because at signup time
  // there is no active mobile session — the mobile backend explicitly expects
  // this literal string for unauthenticated account creation.  Sending a real
  // csrfToken from www.instagram.com causes a cross-domain mismatch that
  // triggers the generic "There was an error" 400 on every attempt.
  // (The real token is still sent in the X-CSRFToken header for the other calls.)
  const createParams: Record<string, unknown> = {
    username,
    email,
    first_name: firstName,
    // Separate day/month/year fields — this is what the reference library sends
    // and matches the one attempt that returned HTTP 200.
    day: String(day),
    month: String(month),
    year: String(year),
    guid,
    device_id: android_id,
    _csrftoken: "missing",
    force_sign_up_code: "",
    qs_stamp: "",
    waterfall_id,
    sn_nonce: "",
    sn_result: "",
  };
  if (encPassword) {
    createParams.enc_password = encPassword;
    step(`Using enc_password for signup`);
  } else {
    createParams.password = password;
    step(`enc_password unavailable — using plaintext password`);
  }
  step(`Sending signed body with fields: [${Object.keys(createParams).join(", ")}] — csrfToken="${csrfToken}"`);

  // Instagram's signup backend is load-balanced across nodes with inconsistent
  // behaviour: the same signed request can get 200 on one node and a generic 400
  // ("There was an error with your request") on another.  Retrying up to 4 times
  // with a short back-off hits different nodes and typically succeeds within 1-3
  // attempts.  Only retry on the contentless generic 400 (no error_type); any
  // other status (200, email_confirmation_link, phone_verification, etc.) exits
  // immediately.
  // Strip csrftoken from the cookie jar before the create call.
  // qe/sync merges a real csrftoken cookie into the jar, but the create body
  // and X-CSRFToken header both say "missing".  Instagram's server sees the
  // Cookie header's csrftoken disagree with X-CSRFToken/body and returns the
  // generic 400.  For the one successful 200 we ever got, qe/sync had not yet
  // run so the jar had no csrftoken — full consistency across cookie/header/body.
  // Remove the cookie here so all three are consistently absent/"missing".
  const createCookieJar = cookieJar.filter(c => !c.startsWith("csrftoken="));
  step(`Create cookie jar (csrf stripped): [${createCookieJar.map(c => c.split("=")[0]).join(", ")}]`);

  let res!: Awaited<ReturnType<typeof igReq>>;
  let j: any = null;
  for (let attempt = 1; attempt <= 8; attempt++) {
    if (attempt > 1) {
      await new Promise(r => setTimeout(r, 1500 * attempt));
      // Refresh enc_password timestamp on each retry so Instagram doesn't reject
      // a repeated identical encrypted blob.
      if (encPassword && rawPubKey && rawKeyId) {
        encPassword = encryptPassword(password, rawPubKey, parseInt(String(rawKeyId), 10));
        createParams.enc_password = encPassword;
      }
      step(`accounts/create/ attempt ${attempt} — retrying...`);
    }
    const currentBody = signBody(createParams);
    // X-CSRFToken header MUST match the _csrftoken body field.
    // We hard-code "missing" in the body (instagram-private-api default for
    // unauthenticated signup) so the header must also be "missing". Sending
    // the real www.instagram.com csrfToken in the header while the body says
    // "missing" causes Instagram's mobile backend to reject with generic 400.
    res = await igReq({
      host: "i.instagram.com",
      path: "/api/v1/accounts/create/",
      method: "POST",
      headers: {
        ...baseHeaders,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-CSRFToken": "missing",
      },
      body: currentBody,
      cookieJar: createCookieJar,
      proxyUrl,
    });
    cookieJar = mergeCookies(cookieJar, res.cookies);
    j = res.json;
    const isGeneric400 = res.status === 400 && j?.status === "fail" && !j?.error_type;
    const igDiagHeaders = Object.entries(res.responseHeaders ?? {})
      .filter(([k]) => /^(x-ig-|x-fb-|www-auth|content-type)/i.test(k))
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v[0] : v}`)
      .join(", ");
    step(`accounts/create/ attempt ${attempt} HTTP ${res.status}${isGeneric400 && attempt < 8 ? " (generic — will retry)" : ""} — raw: ${JSON.stringify(j ?? res.rawBody?.slice(0, 300))}`);
    console.log(`[accountCreator] accounts/create/ attempt=${attempt} HTTP=${res.status} headers=[${igDiagHeaders}]:`, JSON.stringify(j ?? res.rawBody?.slice(0, 400)));
    if (!isGeneric400 || attempt === 8) break;
  }

  // ── Library fallback (ig.account.create via instagram-private-api) ────────────
  // Our custom httpsRequest stack is consistently rejected by accounts/create/ with
  // a generic 400 and no error_type.  Try the exact same endpoint through the
  // instagram-private-api library's own HTTP client — different connection handling,
  // different signing stack, different cookie management.  This is the reference
  // implementation for this API and uses a plaintext password (the library predates
  // enc_password for signup).  If this succeeds, or gets a *different* error than the
  // generic 400, it tells us the block is our HTTP stack, not Instagram policy.
  const allMobileFailed = (j?.status === "fail" && !j?.error_type) || j?.error_type === "needs_upgrade";
  if (allMobileFailed) {
    step("Custom HTTP stack blocked — trying instagram-private-api library path...");
    try {
      const igLib = newIgClient();
      // Generate a fresh device fingerprint keyed to username+email so it's
      // reproducible but unique per account (same pattern used for DM sending).
      igLib.state.generateDevice(`${username}|${email}|${Date.now()}`);
      if (proxyUrl) igLib.state.proxyUrl = proxyUrl;

      // Run the standard pre-login warm-up (launcher.preLoginSync → qe.syncLoginExperiments).
      // Non-fatal — continue even if it throws so we still attempt account.create().
      step("Library: running preLoginFlow (launcher → qe)...");
      try {
        await igLib.launcher.preLoginSync();
        step("Library: launcher/sync OK");
      } catch (e: any) {
        step(`Library: launcher/sync error (non-fatal): ${e?.message}`);
      }
      try {
        await igLib.qe.syncLoginExperiments();
        step("Library: qe/sync OK");
      } catch (e: any) {
        step(`Library: qe/sync error (non-fatal): ${e?.message}`);
      }

      const birthday = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      step(`Library: calling ig.account.create() for ${username} / ${email}...`);
      let libResult: any = null;
      try {
        libResult = await igLib.account.create({
          username,
          password,
          email,
          first_name: firstName,
          birthday,
        });
        step(`Library: ig.account.create() raw result: ${JSON.stringify(libResult).slice(0, 300)}`);
        // Treat a library success the same as a mobile API success
        if (libResult?.account_created || libResult?.created_user || (libResult?.status === "ok" && libResult?.user)) {
          const userId = String(libResult.created_user?.pk ?? libResult.user?.pk ?? "");
          step(`Library: account created! User ID: ${userId}`);
          // Extract session cookies from the library's cookie jar
          const libCookies: string[] = [];
          try {
            const jarObj = (igLib.state.cookieJar as any).toJSON?.() ?? {};
            for (const c of jarObj.cookies ?? []) libCookies.push(`${c.key}=${c.value}`);
          } catch {}
          cookieJar = mergeCookies(cookieJar, libCookies);
          j = libResult;
        } else {
          j = libResult;
        }
      } catch (libErr: any) {
        // instagram-private-api throws IgResponseError — extract the response body
        const raw = libErr?.response?.body;
        const parsed = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : (raw ?? null);
        step(`Library: ig.account.create() threw: ${libErr?.message} — body: ${JSON.stringify(parsed ?? raw ?? "").slice(0, 300)}`);
        // If we got a meaningful error body from Instagram, use it as j so the
        // error-handling block below can inspect error_type / message
        if (parsed && typeof parsed === "object") j = parsed;
      }
    } catch (libSetupErr: any) {
      step(`Library: setup error: ${libSetupErr?.message}`);
    }
  }

  // ── Web registration fallback ───────────────────────────────────────────────
  const stillFailed = (j?.status === "fail" && !j?.error_type) || j?.error_type === "needs_upgrade";
  if (stillFailed) {
    step("Library path also blocked — trying web registration endpoint...");
    try {
      // web_create_ajax/ is Instagram's classic web registration AJAX endpoint.
      // It uses plain URL-encoded params (no signed_body), browser-like headers,
      // and accepts plain password (predates enc_password).
      const webBody = new URLSearchParams({
        email,
        password,       // plain password — enc_password key may not transfer cross-domain
        username,
        first_name: firstName,
        month: String(month),
        day: String(day),
        year: String(year),
      }).toString();

      const webRes = await igReq({
        host: "www.instagram.com",
        path: "/accounts/web_create_ajax/",
        method: "POST",
        headers: {
          "Host": "www.instagram.com",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/x-www-form-urlencoded",
          "X-CSRFToken": csrfToken,
          "X-Instagram-AJAX": "1",
          "X-Requested-With": "XMLHttpRequest",
          "Referer": "https://www.instagram.com/accounts/emailsignup/",
          "Origin": "https://www.instagram.com",
        },
        body: webBody,
        cookieJar,
        proxyUrl,
      });
      cookieJar = mergeCookies(cookieJar, webRes.cookies);
      const wj = webRes.json;
      step(`web_create_ajax HTTP ${webRes.status} — raw: ${JSON.stringify(wj ?? webRes.rawBody?.slice(0, 300))}`);
      console.log(`[accountCreator] web_create_ajax HTTP=${webRes.status}:`, JSON.stringify(wj ?? webRes.rawBody?.slice(0, 400)));
      // Use the web result if it's not the same generic fail we already have
      if (wj && !(webRes.status === 400 && wj.status === "fail" && !wj.error_type)) {
        j = wj;
        res = { ...res, status: webRes.status, cookies: webRes.cookies, json: wj, rawBody: webRes.rawBody, responseHeaders: webRes.responseHeaders };
      }
    } catch (e: any) {
      step(`web_create_ajax error: ${e?.message}`);
    }
  }

  try {

    if (!j) {
      const bodyPreview = res.rawBody?.slice(0, 300) ?? "(empty)";
      step(`Instagram returned HTTP ${res.status} — body: ${bodyPreview}`);
      return { status: "error", steps, message: `Instagram returned HTTP ${res.status}: ${bodyPreview}` };
    }

    // ── Success ────────────────────────────────────────────────────────────
    if (j.account_created === true || j.created_user || (j.status === "ok" && j.user)) {
      const userId = String(j.created_user?.pk ?? j.user?.pk ?? "");
      step(`Account created! User ID: ${userId}`);
      // Attempt to set bio immediately if provided and we have a session cookie
      if (bio && cookieJar.some(c => c.startsWith("sessionid="))) {
        step(`Setting bio...`);
        try {
          const bioRes = await igReq({
            host: "i.instagram.com",
            path: "/api/v1/accounts/set_biography/",
            method: "POST",
            headers: {
              ...baseHeaders,
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              "X-CSRFToken": csrfToken,
            },
            body: new URLSearchParams({ raw_text: bio, _uuid: guid, _csrftoken: csrfToken }).toString(),
            cookieJar,
            proxyUrl,
          });
          cookieJar = mergeCookies(cookieJar, bioRes.cookies);
          step(bioRes.json?.status === "ok" ? `Bio set successfully` : `Bio set attempt: ${JSON.stringify(bioRes.json ?? {}).slice(0, 80)}`);
        } catch (e: any) {
          step(`Bio set failed (non-fatal): ${e?.message}`);
        }
      }
      return { status: "success", steps, userId, username, message: "Account created successfully", sessionCookies: cookieJar };
    }

    // ── Email verification ─────────────────────────────────────────────────
    if (j.error_type === "email_confirmation_link" || j.email_verification_pending || j.verification_contact === "email") {
      step(`Email verification required — code sent to ${email}`);
      const sessionId = randomUUID();
      _pendingSignupSessions.set(sessionId, { cookieJar, csrfToken, baseHeaders, guid, android_id, username, proxyUrl });
      setTimeout(() => _pendingSignupSessions.delete(sessionId), 15 * 60 * 1000);
      return { status: "email_verification", steps, message: j.message ?? `Check ${email} for a 6-digit code`, sessionId, rawResponse: j };
    }

    // ── Phone verification ─────────────────────────────────────────────────
    if (j.error_type === "sms_registration_number" || j.phone_verification_settings || j.verification_contact === "phone") {
      step(`Phone verification required`);
      const sessionId = randomUUID();
      _pendingSignupSessions.set(sessionId, { cookieJar, csrfToken, baseHeaders, guid, android_id, username, proxyUrl });
      setTimeout(() => _pendingSignupSessions.delete(sessionId), 15 * 60 * 1000);
      return { status: "phone_verification", steps, message: j.message ?? "Enter the SMS code sent to your phone", sessionId, rawResponse: j };
    }

    // ── Challenge ──────────────────────────────────────────────────────────
    if (j.challenge) {
      step(`Challenge required: ${j.challenge?.api_path ?? "unknown"}`);
      return { status: "error", steps, message: "Instagram requires a challenge — try a different proxy or IP", rawResponse: j };
    }

    // ── Business-logic field errors (email_is_taken, username_is_taken, etc.) ─
    // Instagram returns these as { account_created: false, errors: { field: ["msg"] }, error_type }
    // Extract the first human-readable message from j.errors if available.
    const fieldMsg = (() => {
      if (!j.errors || typeof j.errors !== "object") return null;
      const msgs: string[] = [];
      for (const val of Object.values(j.errors)) {
        if (Array.isArray(val)) msgs.push(...val.map(String));
        else if (typeof val === "string") msgs.push(val);
      }
      return msgs.length ? msgs.join(" ") : null;
    })();

    if (j.error_type === "email_is_taken") {
      step(`Email already registered: ${email}`);
      const proxyNote = syncCookiesSeen === 0
        ? " NOTE: Both pre-signup sync calls returned zero cookies — this is a strong sign the proxy IP is flagged by Instagram's CDN and this 'email taken' error is a false positive. Try a fresh residential/mobile proxy and retry with the same email."
        : "";
      return { status: "error", steps, message: (fieldMsg ?? "Another account is using the same email.") + proxyNote, rawResponse: j };
    }
    if (j.error_type === "username_is_taken") {
      step(`Username already taken: @${username}`);
      return { status: "error", steps, message: fieldMsg ?? `@${username} is already taken. Choose a different username.`, rawResponse: j };
    }
    if (j.error_type === "invalid_email") {
      step(`Invalid email address: ${email}`);
      return { status: "error", steps, message: fieldMsg ?? "That email address is not valid.", rawResponse: j };
    }
    if (j.error_type === "invalid_username") {
      step(`Invalid username: @${username}`);
      return { status: "error", steps, message: fieldMsg ?? "That username is not allowed. Try a different one.", rawResponse: j };
    }

    // ── Blocked ────────────────────────────────────────────────────────────
    if (j.error_type === "signup_block" || j.spam) {
      const detail = j.feedback_message ?? j.feedback_title ?? j.message ?? "Signup blocked";
      step(`Signup blocked by Instagram (signup_block): ${detail}`);
      return {
        status: "error",
        steps,
        message: `Signup blocked — ${detail}. Try a different proxy or email address, and wait a few minutes before retrying.`,
        rawResponse: j,
      };
    }

    const msg = fieldMsg ?? j.message ?? j.error_type ?? JSON.stringify(j).slice(0, 200);
    step(`Instagram returned: ${msg}`);
    return { status: "error", steps, message: msg, rawResponse: j };
  } catch (e: any) {
    step(`Request exception: ${e?.message}`);
    return { status: "error", steps, message: e?.message ?? "Unknown error" };
  }
}

export async function submitSignupCode(sessionId: string, code: string): Promise<SignupResult> {
  const session = _pendingSignupSessions.get(sessionId);
  if (!session) return { status: "error", steps: [], message: "Session expired — please start over" };

  const { cookieJar, csrfToken, baseHeaders, guid, android_id, username, proxyUrl } = session;
  const steps: string[] = [];
  const step = (msg: string) => { steps.push(msg); console.log(`[accountCreator] ${msg}`); };

  step(`Submitting verification code ${code}...`);
  try {
    const res = await igReq({
      host: "i.instagram.com",
      path: "/api/v1/accounts/confirm_email/",
      method: "POST",
      headers: {
        ...baseHeaders,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-CSRFToken": csrfToken,
      },
      body: new URLSearchParams({
        _uuid: guid,
        _csrftoken: csrfToken,
        code,
        device_id: android_id,
      }).toString(),
      cookieJar,
      proxyUrl,
    });
    const updatedJar = mergeCookies(cookieJar, res.cookies);
    const j = res.json;
    console.log(`[accountCreator] confirm_email HTTP=${res.status}:`, JSON.stringify(j ?? {}).slice(0, 300));
    step(`Response (HTTP ${res.status}): ${JSON.stringify(j ?? {}).slice(0, 150)}`);

    if (j?.status === "ok" || j?.account_created) {
      _pendingSignupSessions.delete(sessionId);
      return { status: "success", steps, username, message: "Verification successful", sessionCookies: updatedJar };
    }
    return { status: "error", steps, message: j?.message ?? "Verification failed", rawResponse: j };
  } catch (e: any) {
    step(`Verify error: ${e?.message}`);
    return { status: "error", steps, message: e?.message };
  }
}
