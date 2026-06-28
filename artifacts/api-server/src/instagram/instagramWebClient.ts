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
// ║  MAKE-A-POST / REPOST DEBUGGING LOG (add new failures here):                ║
// ║    [25 Jun 2026] ProcessingFailedError on rupload — raw downloaded buffer   ║
// ║      passed to rupload without re-encoding. Instagram rejects progressive   ║
// ║      JPEGs / non-sRGB / corrupt EXIF. Fix: always re-encode via sharp       ║
// ║      before upload, even when no crop is needed. Do NOT call               ║
// ║      .toColorspace("srgb") — it embeds an ICC profile that triggers the     ║
// ║      same error. Use sharp().flatten().jpeg() without toColorspace.         ║
// ║    [26 Jun 2026] login_required (403) on rupload — both PATH A and PATH B  ║
// ║      fail. Cause: account igApiCookies/sessionid have expired server-side.  ║
// ║      Fix: engine now detects this via lastUploadLoginRequired flag and       ║
// ║      logs a re-verify warning. The account needs re-verification before     ║
// ║      the next repost attempt. Do NOT retry without re-verifying first.      ║
// ║    [26 Jun 2026] 4415001 "Prompt has contribution" on DM broadcastText —    ║
// ║      Root cause: news.inbox() warm-up fails at NETWORK level (status 0 —   ║
// ║      proxy drops the connection). Code was catching the error as "non-      ║
// ║      fatal" and caching the broken warm-up state anyway, so broadcastText   ║
// ║      fired on an un-warmed client and got 4415001 from Instagram.           ║
// ║      Fix 1: if news.inbox() fails with status 0, try currentUser() as a    ║
// ║      fallback warm-up. If BOTH fail at network level, return null and do    ║
// ║      NOT cache — next sendDM retries the full warm-up sequence.             ║
// ║      Fix 2: 4415001 now invalidates _warmedIgClientCache and returns false  ║
// ║      (retryable) so the engine retries with a fresh warm-up next session.  ║
// ║                                                                              ║
// ║  METHOD NAMING — which cookies each helper uses:                             ║
// ║    mobileSessionGet / mobileSessionPost  → mobileCookieJar (igApiCookies)  ║
// ║    ebGet / ebPost                        → cookieJar (EB web cookies)       ║
// ║    webGet / webPost                      → cookieJar (EB web cookies)       ║
// ║  Rule: ONLY mobileSession* methods are permitted in human-session actions.  ║
// ║  Any call to ebGet/ebPost/webGet/webPost in a session action is a BUG.     ║
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
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { randomUUID, createCipheriv, createHmac, publicEncrypt, randomBytes, constants as cryptoConstants } from "crypto";
import { generateSync as totpGenerate } from "otplib";
import { userAgents as UA_POOL } from "../shared/userAgents";
import { IgApiClient, IgCheckpointError, IgLoginTwoFactorRequiredError, IgLoginBadPasswordError } from "instagram-private-api";
import { tlsRequest, tlsMultipartPost, patchIgClientTls, warmupTls } from "./tlsTransport.js";


// Warm up the CycleTLS Go subprocess at module load so the first real request
// doesn't pay the ~300 ms startup cost.
warmupTls();

// ── Proxy IP timezone lookup ──────────────────────────────────────────────────
// Queries ip-api.com (free, no key required) for the UTC offset (in seconds)
// of the proxy's IP so X-IG-Timezone-Offset matches the IP's region.
// Instagram cross-checks this against the connecting IP — a mismatch (e.g.
// "UTC+0" header from a US IP) is a bot signal.  Times out in 5 s and falls
// back to -18000 (UTC-5, US Eastern) on any error so signup is never blocked.
async function lookupTimezoneOffset(proxyHost: string): Promise<number> {
  return new Promise((resolve) => {
    const fallback = -18000;
    const timer = setTimeout(() => resolve(fallback), 5000);
    const req = http.get(
      `http://ip-api.com/json/${encodeURIComponent(proxyHost)}?fields=offset`,
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(timer);
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString()) as { offset?: number };
            resolve(typeof j.offset === "number" ? j.offset : fallback);
          } catch {
            resolve(fallback);
          }
        });
      },
    );
    req.on("error", () => { clearTimeout(timer); resolve(fallback); });
  });
}

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
  /** Pass through to tlsRequest — bypasses CycleTLS when true (see tlsRequest docs). */
  forceNodeTls?: boolean;
}): Promise<{ status: number; cookies: string[]; json: any; rawBody: string; responseHeaders: Record<string, string | string[] | undefined> }> {
  // Delegate entirely to tlsTransport.ts which routes all Instagram API calls
  // through the CycleTLS OkHttp4 TLS stack (or falls back to Node.js HTTPS if
  // the CycleTLS binary is unavailable). IP-leak prevention and slow-request
  // logging are both enforced inside tlsRequest().
  return tlsRequest(opts);
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
  // Spread existing defaults so the library's cookie jar is preserved.
  ig.request.defaults = { ...ig.request.defaults, timeout: 30000 };
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

type ApiCallLogger = (op: string, durationMs: number, message?: string, isError?: boolean) => void;

// Keep this version current — Instagram rejects signup requests from versions
// older than a few months with error_type:"needs_upgrade".
// Play Store confirmed 431.0.0.37.82 on 2026-05-24.
// Version codes confirmed from instagrapi / APKMirror data (updated 2026-05-24):
//   222.0.0.13.114 → 350696709
//   384.0.0.36.112 → 663869969
//   427.0.0.47.73  → 746996204
//   428.0.0.47.67  → 961145276
//   431.0.0.37.82  → 383708339  ← current (APKMirror arm base variant)
export const MOBILE_VERSION      = "431.0.0.37.82";
export const MOBILE_VERSION_CODE = "383708339";
// Date this version was last confirmed / updated. Warn after 90 days so there
// is time to update before Instagram starts rejecting the version.
const MOBILE_VERSION_DATE = "2026-05-24";
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
const MOBILE_UA  = `Instagram ${MOBILE_VERSION} Android (34/14; 440dpi; 1080x2340; OPPO; CPH2609; OP5961L1; Snapdragon8sGen3; en_US; ${MOBILE_VERSION_CODE})`;
const MOBILE_AID = "567067343352427";
// HMAC-SHA256 signing key used by Instagram's mobile API.
// Instagram stopped validating the HMAC value itself around 2022, but the
// signed_body FORMAT (ig_sig_key_version=4&signed_body=HMAC.JSON) is still
// required — plain URL-encoded form data returns HTTP 400.
const IG_SIGNATURE_KEY = "9193488027538fd3450b83b7d05286d4ca9599a0f7eeed90d8c85925698a05dc";

/** Wrap a params object in Instagram's signed_body format.
 *
 * IMPORTANT: raw string concatenation only — do NOT use URLSearchParams or
 * any URL-encoding here. The library (instagram-private-api) sends the JSON
 * payload as-is (no %-encoding). Instagram's configure parser splits on the
 * first '.' to extract HMAC + raw JSON; if the JSON is URL-encoded the parser
 * sees garbage (e.g. "%7B%22key%22%3A...") and returns "something went wrong".
 */
function signBody(params: Record<string, unknown>): string {
  const json = JSON.stringify(params);
  const hmac = createHmac("sha256", IG_SIGNATURE_KEY).update(json).digest("hex");
  return `ig_sig_key_version=4&signed_body=${hmac}.${json}`;
}

/**
 * Generate a randomised Instagram mobile User-Agent by picking a random device
 * from the shared UA pool (the same pool used by the Accounts page).
 * Call once per account-creation attempt — never share the same string across accounts.
 */
export function randomMobileUA(): string {
  // v428 targets Android 14 — only pick entries with Android 14+ (34/14 or 35/15) so the
  // UA is internally consistent. Instagram rejects v428 + Android 13 with needs_upgrade.
  const eligible = UA_POOL.filter(e => {
    const av = parseInt(e.api.split("/")[0], 10);
    return av >= 34;
  });
  const pool = eligible.length > 0 ? eligible : UA_POOL;
  const entry = pool[Math.floor(Math.random() * pool.length)];
  return `Instagram ${MOBILE_VERSION} Android (${entry.api}; ${MOBILE_VERSION_CODE})`;
}

const FORCE_EMU_FRIENDLY: Record<string, string> = {
  GetReelsTray:       "Checked reels tray",
  NotificationsBadge: "Checked notifications",
  GetDirectInbox:     "Checked direct inbox",
  GetCurrentUser:     "Fetched own account info",
  ViewTimelineFeed:   "Loaded timeline feed",
  LauncherSync:       "Synced mobile config",
  AnalyticsLog:       "Sent analytics log",
  BatchFetchWeb:      "Batch fetched web queries",
  AttributionLaunch:  "Sent attribution launch",
};

// ── Public client class ───────────────────────────────────────────────────────
export class InstagramWebClient {
  private cookieJar: string[] = [];
  private csrfToken  = "";
  private proxyUrl?: string;
  private logCallFn?: ApiCallLogger;
  private profileId?: number;
  private _apiCallSource = "Account";
  private _inTimedCall = false;
  // User-agent to use for web (www.instagram.com) POST requests.
  // Should match the EB browser's UA so that cookies and UA are consistent.
  private webUserAgent = WEB_UA;

  // Separate mobile session (i.instagram.com) used exclusively for DM sending.
  // The web session cannot send DMs — i.instagram.com DM write endpoints require
  // a mobile login (i.instagram.com /api/v1/accounts/login/) session.
  private mobileCookieJar: string[] = [];
  private mobileCsrf = "";
  private mobileSessionReady = false;
  // Persistent device identifiers for the mobile session.
  // Generated ONCE per client instance and reused on every mobileBootstrapFromWebCookies
  // call. Regenerating them each cycle (every ~10 min) makes the account look like it
  // is logging in from a brand-new device on every automation run — a strong trust-score
  // signal that causes Instagram to flag and lock the account.
  private _mobileIgDid: string = "";
  private _mobileMid: string = "";
  // Last configure-step error message, set by _configureViaIgClient when configure
  // returns a non-ok response. Exposed via lastUploadError getter so callers can
  // surface the real Instagram error in the activity log instead of a generic
  // "Upload failed" message.
  private _lastConfigureError = "";
  get lastUploadError(): string { return this._lastConfigureError; }
  // Set to true when rupload returns login_required (403) — signals the engine
  // that the account's session has expired and needs re-verification, not just
  // a generic network retry.
  private _lastUploadLoginRequired = false;
  get lastUploadLoginRequired(): boolean { return this._lastUploadLoginRequired; }
  // Set by _mobileLogin when the failure is definitively bad credentials so
  // ensureClient can propagate the status to the DB without guessing.
  lastMobileLoginFailureReason: "bad_password" | null = null;
  // Exposed so callers can set an account username for log messages.
  username?: string;

  // Last feedback_required response body received from any mobileSessionPost call.
  // Stored so tryDismissABD() can extract the challenge_url without needing it passed in.
  private _lastFeedbackResponse: any = null;
  // Re-entry guard: prevents the ABD dismiss POST itself from triggering another dismiss loop.
  private _abdDismissInProgress = false;

  // Set by _login (web login) before each failure return — gives loginDetailed() the error reason.
  private _webLoginLastError: { reason: 'bad_password' | 'email_confirmation' | 'two_factor_failed' | 'network_error'; message: string } | null = null;

  // Device state from the profile — used by IgApiClient to maintain consistent
  // device fingerprint across mobile login attempts (same uuid/deviceId/phoneId).
  private igDeviceState?: string;
  private userAgentApi?: string;
  // Stored API cookies from the last successful Verify Credentials flow.
  // These are genuine i.instagram.com mobile session cookies and are tried
  // first in mobileLogin() to avoid triggering Instagram's new-device email
  // verification challenge.
  private igApiCookies?: string;

  // Cached result of _buildWarmedIgClient() — keyed by the sessionid portion of
  // igApiCookies so it is invalidated when the session changes (re-verify).
  // Avoids re-running the full Phase 0 + Phase 2 bootstrap (tokens/keyed →
  // launcher/sync → tokens/keyed → user.info → qe/sync) on every task cycle.
  private _warmedIgClientCache: { ig: IgApiClient; ownUserId: string } | null = null;
  private _warmedIgClientCookieKey = "";

  // API throttle — enforces the per-profile "x calls every y seconds" limit.
  // Computed as a per-call delay = everySeconds / requestsCount, so all calls
  // are evenly spaced rather than firing in an instant burst.
  private throttleRequestsMin = 5;
  private throttleRequestsMax = 10;
  private throttleSecondsMin  = 3;
  private throttleSecondsMax  = 8;

  constructor(proxyUrl?: string, profileId?: number) {
    // ── IP-LEAK PREVENTION ──────────────────────────────────────────────────
    // An InstagramWebClient without a proxy would route ALL mobile-API calls
    // through the server/home IP, exposing it to Instagram and causing account
    // locks.  Callers must always resolve and pass a proxyUrl first.
    if (!proxyUrl) {
      throw new Error(
        `[IP-LEAK BLOCKED] InstagramWebClient(profileId=${profileId}) constructed without a proxy. ` +
        "Resolve the account's proxy before creating an API client."
      );
    }
    this.proxyUrl = proxyUrl;
    this.profileId = profileId;
  }

  // ── Per-account mobile UA resolver ──────────────────────────────────────
  // Centralises the "full Instagram mobile UA" build logic so every method
  // that sends a User-Agent header uses the same account-specific value.
  // Priority: full UA string → device-string-only → MOBILE_UA constant.
  private get _fullMobileUA(): string {
    if (this.userAgentApi?.startsWith("Instagram ")) return this.userAgentApi;
    let deviceStr: string | undefined;
    if (this.igDeviceState) {
      try { deviceStr = JSON.parse(this.igDeviceState).deviceString; } catch { /* ignore */ }
    }
    deviceStr = deviceStr ?? this.userAgentApi;
    return deviceStr
      ? `Instagram ${MOBILE_VERSION} Android (${deviceStr}; ${MOBILE_VERSION_CODE})`
      : MOBILE_UA;
  }

  setApiLimits(limits: { requestsMin: number; requestsMax: number; everySecondsMin: number; everySecondsMax: number }) {
    this.throttleRequestsMin = Math.max(1, limits.requestsMin);
    this.throttleRequestsMax = Math.max(1, limits.requestsMax);
    // Unit-aware conversion: values <1000 are legacy bare-seconds (schema default was 30/60);
    // values ≥1000 are milliseconds (current UI format).  Convert all to seconds for throttle logic.
    const toMs = (v: number) => (v < 1000 ? v * 1000 : v);
    this.throttleSecondsMin  = Math.max(0, toMs(limits.everySecondsMin) / 1000);
    this.throttleSecondsMax  = Math.max(0, toMs(limits.everySecondsMax) / 1000);
  }

  private async apiThrottle(): Promise<void> {
    // Compute the delay RANGE from the configured rate limits, then pick a random
    // point inside that range.  Previously the code randomised `calls` and `secs`
    // independently, which allowed combining calls=MAX with secs=MIN — a delay
    // shorter than either configured endpoint (e.g. "1–10 req / 60–120 s" could
    // produce 60/10 = 6 s instead of the expected minimum of 60/1 = 60 s).
    //
    // Correct extremes:
    //   slowest = everySecondsMax / requestsMin  (most seconds for fewest calls)
    //   fastest = everySecondsMin / requestsMax  (fewest seconds for most calls)
    // Both are valid configs; we pick a random point between them each call.
    const slowest = this.throttleSecondsMax  / Math.max(1, this.throttleRequestsMin);
    const fastest = this.throttleSecondsMin  / Math.max(1, this.throttleRequestsMax);
    const delaySec = fastest + Math.random() * Math.max(0, slowest - fastest);
    const delayMs  = Math.floor(delaySec * 1000);
    if (delayMs > 10) {
      await new Promise<void>(r => setTimeout(r, delayMs));
    }
  }

  // ── Automation IgApiClient factory ───────────────────────────────────────────
  // ALL automation code that uses the instagram-private-api library MUST create
  // its IgApiClient through this factory rather than calling newIgClient() directly.
  //
  // The factory hooks apiThrottle() into ig.request.send — the library's single
  // HTTP dispatch point — so EVERY ig.* call (friendship.create, media.like,
  // broadcastText, publish.photo, etc.) is rate-limited by API Controls without
  // any per-feature remembering.  This makes it architecturally impossible for a
  // new automation feature to bypass the throttle as long as it uses this factory.
  //
  // Do NOT use this for non-automation clients (verify, mobile login bootstrap,
  // TOS consent, ABD dismiss) — those have their own timing logic.
  private _newAutomationIgClient(): IgApiClient {
    const ig = newIgClient();
    const _igReq = ig.request as any;
    const _origSend = _igReq.send.bind(_igReq);
    const _throttle = this.apiThrottle.bind(this);
    _igReq.send = async function(opts: any, onlyCheckHttpStatus?: boolean) {
      await _throttle();
      return _origSend(opts, onlyCheckHttpStatus);
    };
    return ig;
  }

  setDeviceInfo(igDeviceState?: string | null, userAgentApi?: string | null, igApiCookies?: string | null) {
    this.igDeviceState = igDeviceState ?? undefined;
    this.userAgentApi  = userAgentApi  ?? undefined;
    const newCookies   = igApiCookies  ?? undefined;

    // Track the sessionid portion of igApiCookies so we know when Instagram
    // rotates it.  When rotation is detected we preserve the existing cached
    // ig client (it already has the fresh in-memory cookies from prior
    // Set-Cookie responses — persistSessionCookies just flushed them to DB).
    // Busting the cache on every rotation was causing FetchConfig to re-fire
    // on every automation cycle after the first DM check, inflating the
    // FetchConfig count from the expected 1× per verify to 3–4× per session.
    //
    // The cache is only explicitly cleared by resetWarmedClient(), which the
    // verify route calls after a successful full re-verify so the new session
    // gets a proper cold-start bootstrap.
    const newCookieKey = newCookies?.split(";").find(s => s.trim().toLowerCase().startsWith("sessionid="))?.trim() ?? "";
    if (newCookieKey !== this._warmedIgClientCookieKey) {
      if (this._warmedIgClientCache) {
        console.log(`[webClient:${this.profileId}] setDeviceInfo: sessionid rotated by Instagram — preserving warmed client (FetchConfig not re-run)`);
      }
      // Update the key so we detect future rotations, but do NOT null the cache.
      this._warmedIgClientCookieKey = newCookieKey;
    }

    this.igApiCookies = newCookies;
    // Eagerly seed stable device IDs from stored state so every code path
    // (mobileBootstrap, restoreFromAuth, postLogin extraction) reuses the same
    // values rather than generating fresh random IDs on each session start.
    if (!this._mobileIgDid) { const v = this._savedIgDidFromDeviceState(); if (v) this._mobileIgDid = v; }
    if (!this._mobileMid)   { const v = this._savedMidFromApiCookies();   if (v) this._mobileMid   = v; }
    // Eagerly restore mobile session so isMobileLoggedIn() returns true immediately.
    // Fast path 1: igApiCookies has a sessionid (Jarvee-imported or prior login).
    // Fast path 2: igDeviceState has a Bearer authorization token saved from verify
    //              (used when proxy strips all Set-Cookie so sessionid is unavailable).
    this._restoreMobileFromApiCookies() || this._restoreMobileFromAuthorization();
  }

  // Explicitly bust the warmed IgApiClient cache.  Called by the automation
  // engine after a successful full re-verify so the new session gets a proper
  // cold-start bootstrap (FetchConfig, etc.) on its first DM/inbox call.
  // NOT called on normal cookie rotation — see setDeviceInfo comments above.
  resetWarmedClient(): void {
    if (this._warmedIgClientCache) {
      console.log(`[webClient:${this.profileId}] resetWarmedClient: cache cleared (re-verify completed)`);
    }
    this._warmedIgClientCache    = null;
    this._warmedIgClientCookieKey = "";
  }

  // Returns the saved ig_did from igDeviceState (most authoritative source — written by
  // Verify Credentials and preserved until the user explicitly resets device IDs).
  private _savedIgDidFromDeviceState(): string | undefined {
    if (!this.igDeviceState) return undefined;
    try { return (JSON.parse(this.igDeviceState) as any).igDid ?? undefined; } catch { return undefined; }
  }

  // Returns the saved mid from igApiCookies (written by Verify Credentials alongside sessionid).
  private _savedMidFromApiCookies(): string | undefined {
    if (!this.igApiCookies) return undefined;
    const pair = this.igApiCookies.split(";").find(s => s.trim().startsWith("mid="));
    return pair ? pair.split("=").slice(1).join("=") : undefined;
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
    // Device-identity cookies — use stored values first, never generate fresh random IDs.
    if (!cookies.some(c => c.startsWith("ig_did="))) {
      if (!this._mobileIgDid) this._mobileIgDid = this._savedIgDidFromDeviceState() ?? randomUUID();
      cookies.push(`ig_did=${this._mobileIgDid}`);
    }
    if (!cookies.some(c => c.startsWith("mid="))) {
      if (!this._mobileMid) this._mobileMid = Buffer.from(randomUUID()).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
      cookies.push(`mid=${this._mobileMid}`);
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

  // Fast path: proxy strips all Set-Cookie so sessionid is never available, but the
  // ig-set-authorization Bearer token (a normal response header) does survive and is
  // stored in igDeviceState after a successful Verify Credentials run.
  // When that token is present, skip the fresh re-login (which would trigger bad_password
  // from Instagram detecting a rapid device re-login) and use the token directly.
  private _restoreMobileFromAuthorization(): boolean {
    if (!this.igDeviceState) return false;
    try {
      const saved = JSON.parse(this.igDeviceState);
      if (!saved.authorization) return false;
      // Device-identity continuity — use stored IDs, never generate fresh random values.
      if (!this._mobileIgDid) this._mobileIgDid = saved.igDid ?? randomUUID();
      if (!this._mobileMid)   this._mobileMid   = this._savedMidFromApiCookies() ?? Buffer.from(randomUUID()).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
      // Use saved csrftoken from igApiCookies if available, otherwise synthetic
      let csrf: string | undefined;
      if (this.igApiCookies) {
        const csrfPair = this.igApiCookies.split(";").find((s: string) => s.trim().startsWith("csrftoken="));
        if (csrfPair) csrf = csrfPair.split("=").slice(1).join("=");
      }
      if (!csrf) csrf = randomBytes(16).toString("hex");
      this.mobileCookieJar = [`ig_did=${this._mobileIgDid}`, `mid=${this._mobileMid}`, `csrftoken=${csrf}`];
      this.mobileCsrf = csrf;
      this.mobileSessionReady = true;
      console.log(`[webClient] mobile session restored from authorization token (Bearer IGT:2:... in igDeviceState)`);
      return true;
    } catch {
      return false;
    }
  }

  setLogger(fn: ApiCallLogger) {
    this.logCallFn = fn;
  }

  get apiCallSource(): string {
    return this._apiCallSource;
  }

  setApiCallSource(source: string) {
    this._apiCallSource = source;
  }

  // Returns the current mobile cookie jar serialised in igApiCookies format
  // ("key=value;key=value") so the engine can persist it back to the DB after
  // a successful mobileLogin. Returns null if no mobile session is active.
  getSerializedIgApiCookies(): string | null {
    if (!this.mobileSessionReady) return null;
    if (!this.mobileCookieJar.some(c => c.startsWith("sessionid="))) return null;
    return this.mobileCookieJar.join(";");
  }

  // Sync sessionid and csrftoken from the web jar (Chrome JSON file) into the
  // mobile jar WITHOUT touching device tokens (ig_did, mid) or triggering the
  // cold-start bootstrap sequence. Called every automation cycle when an EB
  // cookie file exists AND a verified mobile session is already active — this
  // ensures the mobile API always runs with the most current sessionid Chrome
  // has, not a potentially stale copy that was last written when the EB panel
  // was manually opened.
  syncWebCookiesToMobileJar(): void {
    const sessionCookie = this.cookieJar.find(c => c.startsWith("sessionid="));
    const csrfCookie    = this.cookieJar.find(c => c.startsWith("csrftoken="));
    if (!sessionCookie) return;
    this.mobileCookieJar = [
      ...this.mobileCookieJar.filter(c => !c.startsWith("sessionid=") && !c.startsWith("csrftoken=")),
      sessionCookie,
      ...(csrfCookie ? [csrfCookie] : []),
    ];
    if (csrfCookie) this.mobileCsrf = csrfCookie.split("=").slice(1).join("=");
    const snip = sessionCookie.split("=")[1]?.slice(0, 8) ?? "?";
    console.log(`[webClient:${this.profileId}] syncWebCookiesToMobileJar: refreshed sessionid=...${snip}, csrf=${!!csrfCookie}`);
  }

  // Build a fresh igApiCookies string from the current web jar + stored device
  // tokens so the DB can be kept in sync even when the EB panel is not open.
  // Device tokens (mid, ig_did) always come from the Verify-Credentials-seeded
  // values — never from the JSON file — to preserve fingerprint continuity.
  // Returns null if no sessionid is present in the web jar.
  buildFreshApiCookiesString(): string | null {
    const get = (name: string) => {
      const e = this.cookieJar.find(c => c.startsWith(name + "="));
      return e ? e.slice(name.length + 1) : "";
    };
    const sessionid = get("sessionid");
    const csrftoken = get("csrftoken");
    const dsUserId  = get("ds_user_id");
    const mid       = this._mobileMid   || get("mid");
    const igDid     = this._mobileIgDid || get("ig_did");
    if (!sessionid || !mid) return null;
    return [
      `sessionid=${sessionid}`,
      csrftoken ? `csrftoken=${csrftoken}` : "",
      dsUserId  ? `ds_user_id=${dsUserId}` : "",
      `mid=${mid}`,
      igDid     ? `ig_did=${igDid}`        : "",
    ].filter(Boolean).join(";");
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
    const filePath = process.env.DATABASE_PATH
      ? path.join(path.dirname(process.env.DATABASE_PATH), "browser-data", `cookies-${this.profileId}.json`)
      : path.join(process.cwd(), "server", "browser-data", `cookies-${this.profileId}.json`);
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
      const names = igCookies.map(c => c.name).join(", ");
      console.log(`[webClient:${this.profileId}] loadBrowserCookies: synced ${igCookies.length} cookies (${names}), sessionid=${hasSession}, csrf=${!!csrf}`);
      return hasSession;
    } catch (err: any) {
      console.warn(`[webClient:${this.profileId}] loadBrowserCookies failed:`, err?.message);
      return false;
    }
  }

  private async timed<T>(opName: string, fn: () => Promise<T>, message?: string | ((result: T) => string), shouldLog?: (result: T) => boolean): Promise<T> {
    const t0 = Date.now();
    const prevInTimed = this._inTimedCall;
    this._inTimedCall = true;
    let result!: T;
    let didThrow = false;
    let thrownErr: unknown;
    try {
      result = await fn();
    } catch (err) {
      didThrow = true;
      thrownErr = err;
    } finally {
      this._inTimedCall = prevInTimed;
    }
    const ms = Date.now() - t0;
    if (didThrow) {
      // Log the call even on failure so it appears in the API call log, then re-throw.
      const errText = thrownErr instanceof Error ? thrownErr.message : String(thrownErr ?? "");
      this.logCallFn?.(opName, ms, errText || undefined, true);
      throw thrownErr;
    }
    if (!shouldLog || shouldLog(result)) {
      const msg = typeof message === "function" ? message(result) : message;
      this.logCallFn?.(opName, ms, msg);
    }
    return result;
  }

  private _opNameFromPath(path: string, _method: string): string {
    const base = path.split("?")[0].replace(/\/+$/, "");
    const stripped = base.replace(/^\/api\/v\d+\//, "");
    const parts = stripped.split("/").filter(p => p && !/^\d+$/.test(p));
    const pascal = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase())).join("");
    return pascal || base;
  }

  private _logTransport(path: string, method: string, durationMs: number, isError: boolean): void {
    if (this._inTimedCall || !this.logCallFn) return;
    const PATH_FRIENDLY: Record<string, string> = {
      "/api/v1/feed/timeline/":                    "Loading timeline feed",
      "/api/v1/media/seen/":                        "Marking media as seen",
      "/api/v1/friendships/create/":               "Follow user",
      "/api/v1/friendships/destroy/":              "Unfollow user",
      "/api/v1/clips/user/":                        "Fetching clips",
      "/api/v1/accounts/account_security_info/":   "Fetching account security info",
      "/api/v1/challenge/":                         "Challenge response",
      "/api/v1/qe/sync/":                           "Config sync",
      "/api/v1/launcher/sync/":                     "Launcher sync",
      "/api/v1/users/self/banner_dismiss/":         "Dismiss banner",
      "/api/v1/direct_v2/threads/":                "DM thread action",
      "/api/v1/tags/":                              "Hashtag sections",
    };
    const basePath = path.split("?")[0];
    const msg = PATH_FRIENDLY[basePath] ?? basePath;
    this.logCallFn(this._opNameFromPath(path, method), durationMs, msg, isError);
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

  /**
   * Web-based credential verification. Bootstraps CSRF from the Instagram login page before
   * posting credentials — avoids the _csrftoken="missing" problem that plagues the mobile library.
   * Returns cookies in igApiCookies format on success, or a structured error on failure.
   */
  async loginDetailed(
    username: string,
    password: string,
    twoFaSecret?: string,
  ): Promise<
    | { ok: true; cookies: string }
    | { ok: false; reason: 'bad_password' | 'email_confirmation' | 'two_factor_failed' | 'network_error'; message: string }
  > {
    this._webLoginLastError = null;
    let ok = false;
    try {
      ok = await this._login(username, password, twoFaSecret);
    } catch (e: any) {
      return { ok: false, reason: 'network_error', message: e?.message ?? 'Network error during login' };
    }
    if (ok) {
      const cookies = this.cookieJar.join('; ');
      if (!cookies.includes('sessionid=')) {
        return { ok: false, reason: 'network_error', message: 'Login succeeded but no session cookie received' };
      }
      return { ok: true, cookies };
    }
    const err = this._webLoginLastError ?? { reason: 'network_error' as const, message: 'Unknown login failure' };
    return { ok: false, reason: err.reason, message: err.message };
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
    if (!csrf) { this._webLoginLastError = { reason: 'network_error', message: 'No CSRF token on Instagram login page' }; console.error("[webClient] login: no csrf on login page"); return false; }

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
      if (!secret) { this._webLoginLastError = { reason: 'two_factor_failed', message: '2FA required but no TOTP secret is set' }; console.error(`[webClient] @${username}: 2FA required but no secret`); return false; }

      let code: string;
      try { code = totpGenerate({ secret }); } catch { this._webLoginLastError = { reason: 'two_factor_failed', message: 'Invalid 2FA secret key' }; console.error(`[webClient] @${username}: invalid 2FA secret`); return false; }

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
      this._webLoginLastError = { reason: 'two_factor_failed', message: `2FA code rejected: ${tfRes.rawBody.slice(0, 100)}` };
      console.error(`[webClient] @${username}: 2FA rejected: ${tfRes.rawBody.slice(0, 200)}`);
      return false;
    }

    {
      const errButtons: any[] = j?.buttons ?? [];
      const errMsg: string = j?.message ?? j?.error_type ?? 'Login failed';
      this._webLoginLastError = errButtons.some((b: any) => b?.action === 'send_one_click_login_email')
        ? { reason: 'email_confirmation', message: errMsg }
        : { reason: 'bad_password', message: errMsg };
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

  /**
   * Direct ABD dismiss — calls POST /api/v1/users/self/banner_dismiss/ with the
   * stored identity (uuid, uid, csrftoken from igApiCookies / igDeviceState).
   * Returns the raw Instagram response object so the caller can decide what to do.
   * No probing, no challenge flow, no EB dependency.
   */
  async bannerDismiss(): Promise<{ raw: any; ok: boolean }> {
    const cookieParts = (this.igApiCookies ?? "").split(";").map((s: string) => s.trim());
    const userId   = cookieParts.find((c: string) => c.startsWith("ds_user_id="))?.split("=")[1] ?? "";
    const cookieCsrf = cookieParts.find((c: string) => c.startsWith("csrftoken="))?.split("=")[1] ?? "";
    const csrf     = this.mobileCsrf || cookieCsrf;
    let uuid = "", deviceId = "";
    if (this.igDeviceState) {
      try {
        const ds = JSON.parse(this.igDeviceState);
        uuid     = ds.uuid     ?? "";
        deviceId = ds.deviceId ?? ds.device_id ?? "";
      } catch { /* ignore */ }
    }
    const body = new URLSearchParams({
      _uuid:       uuid || deviceId,
      _uid:        userId,
      _csrftoken:  csrf,
      device_id:   deviceId || uuid,
    }).toString();
    console.log(`[webClient] @${this.username} bannerDismiss → POST /api/v1/users/self/banner_dismiss/ uid=${userId} uuid=${uuid.slice(0,8)}...`);
    let raw: any = null;
    try {
      raw = await this.mobileSessionPost("/api/v1/users/self/banner_dismiss/", body);
    } catch (e: any) {
      console.warn(`[webClient] @${this.username} bannerDismiss error: ${e?.message}`);
      raw = { _error: e?.message, statusCode: e?.response?.statusCode };
    }
    console.log(`[webClient] @${this.username} bannerDismiss ← ${JSON.stringify(raw)?.slice(0, 300)}`);
    const ok = raw?.status === "ok";
    return { raw, ok };
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
    if (!sessionCookie) {
      console.warn(`[webClient:${this.profileId}] mobileBootstrapFromWebCookies: FAILED — no sessionid in cookieJar (jar has ${this.cookieJar.length} entries: ${this.cookieJar.map(c => c.split("=")[0]).join(", ")})`);
      return false;
    }

    // Reuse stable device IDs — NEVER generate new ones per call.
    // Generating a fresh ig_did/mid on every ensureClient() cycle (~every 10 min)
    // presents Instagram with a brand-new device fingerprint each run, which is
    // a strong account-locking signal. Prefer stored IDs from igDeviceState /
    // igApiCookies (set by Verify Credentials), fall back to generating once
    // per client instance and keeping them for the session lifetime.
    const isFirstBoot = !this._mobileIgDid;
    if (!this._mobileIgDid) {
      this._mobileIgDid = this._savedIgDidFromDeviceState() ?? randomUUID();
    }
    if (!this._mobileMid) {
      this._mobileMid = this._savedMidFromApiCookies() ?? Buffer.from(randomUUID()).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
    }

    // Seed mobile jar: keep sessionid + csrf from web session; add stable device ids
    const seeds: string[] = [
      `ig_did=${this._mobileIgDid}`,
      `mid=${this._mobileMid}`,
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
    const sessionSnip = sessionCookie.split("=")[1]?.slice(0, 8) ?? "?";
    console.log(`[webClient:${this.profileId}] mobileBootstrapFromWebCookies: ${isFirstBoot ? "FIRST BOOT" : "REFRESH"} — jar=${this.mobileCookieJar.length} cookies, sessionid=...${sessionSnip}, csrf=${!!csrfCookie}, ig_did=${this._mobileIgDid.slice(0, 8)}... (${isFirstBoot ? "new device IDs generated" : "existing device IDs reused"})`);
    return true;
  }

  async mobileLogin(username: string, password: string, twoFaSecret?: string): Promise<boolean> {
    return this.timed("MobileLogin", () => this._mobileLogin(username, password, twoFaSecret), `@${username} mobile login`);
  }

  private async _mobileLogin(username: string, password: string, twoFaSecret?: string): Promise<boolean> {
    // Fast path 1: stored igApiCookies with sessionid from a prior Verify Credentials run.
    if (this._restoreMobileFromApiCookies()) {
      return true;
    }

    // Fast path 2: stored Bearer authorization token in igDeviceState (set when proxy
    // strips all Set-Cookie so sessionid is never reachable — the token IS the session).
    // Skipping fresh login avoids Instagram returning bad_password on rapid device re-login.
    if (this._restoreMobileFromAuthorization()) {
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
    patchIgClientTls(ig, this.proxyUrl);

    // Fetch RSA encryption keys — required before login or Instagram rejects
    try {
      await ig.request.send({
        method: "GET",
        url: "/api/v1/si/fetch_headers/",
        qs: { challenge_type: "signup", guid: ig.state.uuid },
      });
    } catch { /* non-fatal — try next strategy */ }

    if (!ig.state.passwordEncryptionPubKey) {
      try {
        await ig.request.send({
          url: "/api/v1/qe/sync/",
          method: "POST",
          form: ig.request.sign({
            id: ig.state.uuid,
            server_config_retrieval: "1",
            _csrftoken: ig.state.cookieCsrfToken,
            _uuid: ig.state.uuid,
          }),
        });
      } catch { /* non-fatal */ }
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
        const titleLow  = errorTitle.toLowerCase();
        const typeLow   = errorType.toLowerCase();

        // Determine whether this is genuinely wrong credentials or something else.
        // Instagram raises IgLoginBadPasswordError for several non-password reasons:
        // account locked, suspicious device, security challenge, new-device block, etc.
        // We must NOT mark bad_password in those cases — the password IS correct; the
        // account just needs verification via the embedded browser.
        const isAccountIssue =
          needsEmail ||                                      // email one-click login offered
          buttons.length > 0 ||                             // any recovery button = not plain wrong-pw
          typeLow.includes("account_locked") ||
          typeLow.includes("challenge") ||
          typeLow.includes("feedback") ||
          titleLow.includes("lock") ||
          titleLow.includes("suspend") ||
          titleLow.includes("disabled") ||
          titleLow.includes("unusual") ||
          titleLow.includes("security") ||
          titleLow.includes("verify") ||
          titleLow.includes("confirm");

        if (isAccountIssue) {
          console.error(`[webClient] @${username}: mobile login blocked — account issue, NOT a bad password. error_type="${errorType}" error_title="${errorTitle}" buttons=${buttons.length}`);
          // Do NOT set lastMobileLoginFailureReason — treat as transient so the account
          // is not permanently marked bad_password. The user should open the EB and
          // resolve the challenge there.
        } else {
          console.error(`[webClient] @${username}: mobile login — confirmed bad password. error_type="${errorType}" error_title="${errorTitle}"`);
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
      const raw = await ig.state.serializeCookieJar();
      // serializeCookieJar() returns a plain object, not a JSON string — do NOT JSON.parse it
      const jar = typeof raw === "string" ? JSON.parse(raw) : raw;
      const WANTED = new Set(["sessionid", "csrftoken", "ds_user_id", "rur", "mid", "ig_did"]);
      const extracted: string[] = (jar.cookies ?? [])
        .filter((c: any) => WANTED.has(c.key))
        .map((c: any) => `${c.key}=${c.value}`);

      // Ensure ig_did and mid are present — use stored IDs, never generate fresh random values.
      if (!extracted.some(c => c.startsWith("ig_did="))) {
        if (!this._mobileIgDid) this._mobileIgDid = this._savedIgDidFromDeviceState() ?? ig.state.deviceId ?? randomUUID();
        extracted.push(`ig_did=${this._mobileIgDid}`);
      }
      if (!extracted.some(c => c.startsWith("mid="))) {
        if (!this._mobileMid) this._mobileMid = Buffer.from(randomUUID()).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
        extracted.push(`mid=${this._mobileMid}`);
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
    const _t0 = Date.now();
    await this.apiThrottle();
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
    this._logTransport(path, "GET", Date.now() - _t0, res.status >= 400);
    return res.json;
  }

  // EB web cookies + mobile app headers → i.instagram.com.
  // NEVER use for session actions — use mobileSessionGet instead.
  private async ebGet(path: string): Promise<any> {
    const _t0 = Date.now();
    await this.apiThrottle();
    const res = await igReq({
      host: "i.instagram.com",
      path,
      method: "GET",
      headers: {
        Host: "i.instagram.com",
        "User-Agent": this._fullMobileUA,
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
    if (!res.json) console.log(`[webClient] ebGet ${path} status=${res.status} body(200):`, res.rawBody.slice(0, 200));
    this._logTransport(path, "GET", Date.now() - _t0, res.status >= 400);
    return res.json;
  }

  // Authenticated GET using the igApiCookies mobile session (mobileCookieJar).
  // Use this for any read that needs the real account session — inbox, timeline, etc.
  // Zero dependency on the EB; works whether or not the browser is open or logged in.
  private get _deviceAuthorization(): string | undefined {
    if (!this.igDeviceState) return undefined;
    try { return (JSON.parse(this.igDeviceState) as any).authorization ?? undefined; } catch { return undefined; }
  }

  private async mobileSessionGet(path: string): Promise<any> {
    const authorization = this._deviceAuthorization;
    const hasMobileSession = this.mobileCookieJar.some(c => c.startsWith("sessionid=")) || !!authorization;
    if (!hasMobileSession) {
      console.warn(`[webClient] mobileSessionGet ${path}: no igApiCookies session`);
      return null;
    }
    // apiThrottle MUST come before _bootstrapMobileCsrf — the bootstrap makes
    // real HTTP requests to Instagram (fetch_headers / current_user) and would
    // bypass the per-account rate limit if called first.
    const _t0 = Date.now();
    await this.apiThrottle();
    if (this.mobileCsrf === "missing" || !this.mobileCsrf) {
      await this._bootstrapMobileCsrf();
    }
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
        ...(authorization ? { Authorization: authorization } : {}),
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
      // Extract the message Instagram sent (may be empty for plain session-expired 400s).
      // Fall back to "login_required" so getAccountLevelStatus() classifies it as
      // "logged_out" and applyAccountLevelError() marks the account for re-verification.
      const bodyMsg: string = (res.json as any)?.message ?? "";
      const errMsg = bodyMsg || "login_required";
      console.warn(`[webClient] mobileSessionGet ${path} → HTTP ${res.status} (${errMsg}): ${res.rawBody.slice(0, 200)}`);
      this._logTransport(path, "GET", Date.now() - _t0, true);
      throw new Error(errMsg);
    }
    if (!res.json) console.log(`[webClient] mobileSessionGet ${path} status=${res.status} body(200):`, res.rawBody.slice(0, 200));
    this._logTransport(path, "GET", Date.now() - _t0, false);
    return res.json;
  }

  // Anonymous mobile GET — NO account cookies sent, account identity never exposed.
  // Used for source-account scraping (repost) so the account is not linked to the lookup.
  private async mobileGetAnonymous(path: string): Promise<any> {
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
        "X-IG-Capabilities": "3brTvwE=",
        "X-IG-Connection-Type": "WIFI",
      },
      cookieJar: [],  // deliberately empty — no session cookies
      proxyUrl: this.proxyUrl,
    });
    return res.json;
  }

  private async webPost(path: string, body = "", _isRetry = false): Promise<any> {
    const _t0 = Date.now();
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
    this._logTransport(path, "POST", Date.now() - _t0, res.status >= 400);
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

    // _newAutomationIgClient() hooks apiThrottle() into ig.request.send so every
    // ig.* call on this client is throttled by API Controls automatically.
    const ig = this._newAutomationIgClient();

    const deviceSeed = (this.userAgentApi ?? this.username ?? "instagram") + "|" + (this.username ?? "instagram");
    if (this.igDeviceState) {
      try {
        const saved = JSON.parse(this.igDeviceState) as { deviceId?: string; uuid?: string; phoneId?: string; adid?: string; deviceString?: string; authorization?: string; igWWWClaim?: string };
        ig.state.generateDevice(deviceSeed);
        if (saved.deviceId)     ig.state.deviceId     = saved.deviceId;
        if (saved.uuid)         ig.state.uuid         = saved.uuid;
        if (saved.phoneId)      ig.state.phoneId      = saved.phoneId;
        if (saved.adid)         ig.state.adid         = saved.adid;
        if (saved.deviceString) ig.state.deviceString = saved.deviceString;
        // Restore Bearer token — this is the real session credential when the proxy
        // strips Set-Cookie (so sessionid never lands in the jar).
        if (saved.authorization) ig.state.authorization = saved.authorization;
        if (saved.igWWWClaim)    ig.state.igWWWClaim    = saved.igWWWClaim;
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
    patchIgClientTls(ig, this.proxyUrl);

    try {
      console.log(`[webClient] follow ${userId}: via IgApiClient friendship.create (uuid=${ig.state.uuid.slice(0,8)}… v${MOBILE_VERSION} csrf=${ig.state.cookieCsrfToken?.slice(0,8) ?? "none"})`);
      const result = await this.timed("FollowUser", () => ig.friendship.create(userId) as Promise<any>, undefined, () => false);
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
      if (/challenge_required/i.test(msg)) {
        return { ok: false, status: "checkpoint_required", reason: "Session has an unresolved Instagram security challenge — verify account in the embedded browser" };
      }
      if (/404|Not Found/i.test(msg)) {
        return { ok: false, status: "follow_blocked", reason: `Instagram returned 404 on friendship.create — ${msg}` };
      }
      if (/spam/i.test(msg))                           return { ok: false, status: "follow_blocked", reason: "spam — Instagram flagged this follow attempt" };
      if (/feedback_required|ActionBlocked/i.test(msg)) return { ok: false, status: "follow_blocked", reason: msg };
      if (/login_required|Not authorized|401/i.test(msg)) return { ok: false, status: "follow_blocked", reason: "session expired — re-verify account" };
      return { ok: false, status: "follow_blocked", reason: msg || "IgApiClient follow failed" };
    }
  }

  // ── Programmatic consent acceptance ──────────────────────────────────────
  // When Instagram's mobile API returns consent_required, it means the account
  // must accept the updated Terms of Service / Privacy Policy before any API
  // call will succeed. This is a server-side block — completely independent of
  // what is visible in the EB. instagram-private-api's ConsentRepository exposes
  // POST /api/v1/consent/existing_user_flow/ which accepts TOS + age consent
  // programmatically so no EB click is required.
  private async _tryAcceptConsent(): Promise<boolean> {
    if (!this.igApiCookies) return false;
    try {
      const ig = newIgClient();
      const deviceSeed = (this.userAgentApi ?? this.username ?? "instagram") + "|" + (this.username ?? "instagram");
      if (this.igDeviceState) {
        try {
          const saved = JSON.parse(this.igDeviceState) as { deviceId?: string; uuid?: string; phoneId?: string; adid?: string; deviceString?: string; authorization?: string; igWWWClaim?: string };
          ig.state.generateDevice(deviceSeed);
          if (saved.deviceId)      ig.state.deviceId      = saved.deviceId;
          if (saved.uuid)          ig.state.uuid          = saved.uuid;
          if (saved.phoneId)       ig.state.phoneId       = saved.phoneId;
          if (saved.adid)          ig.state.adid          = saved.adid;
          if (saved.deviceString)  ig.state.deviceString  = saved.deviceString;
          if (saved.authorization) ig.state.authorization = saved.authorization;
          if (saved.igWWWClaim)    ig.state.igWWWClaim    = saved.igWWWClaim;
        } catch { ig.state.generateDevice(deviceSeed); }
      } else {
        ig.state.generateDevice(deviceSeed);
      }
      await this._deserializeIgCookies(ig, this.igApiCookies);
      ig.state.constants.APP_VERSION      = MOBILE_VERSION;
      ig.state.constants.APP_VERSION_CODE = MOBILE_VERSION_CODE;
      patchDeviceStringVersionCode(ig, MOBILE_VERSION_CODE);
      if (this.proxyUrl) ig.state.proxyUrl = this.proxyUrl;
      patchIgClientTls(ig, this.proxyUrl);

      // Accept TOS + age consent — sets tos_data_policy_consent_state=2 and
      // age_consent_state=2 on the account server-side, clearing consent_required.
      await ig.consent.existingUserFlowTosAndTwoAgeButton();
      console.log(`[webClient] @${this.username}: ✅ consent accepted via mobile API (TOS+age)`);
      return true;
    } catch (e: any) {
      const raw: string = e?.message ?? String(e);
      const msg = raw.replace(/^[A-Z]+ \/[^\s]+ - [^;]+;\s*/, "").trim() || raw;
      console.warn(`[webClient] @${this.username}: consent auto-accept failed: ${msg}`);
      return false;
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

    // ── Cache hit — return the already-warmed client ──────────────────────────
    // The full Phase 0 + Phase 2 bootstrap (tokens/keyed → launcher/sync →
    // tokens/keyed → user.info → qe/sync) only needs to run once per session.
    // The cache is keyed on the sessionid cookie and is invalidated by
    // setDeviceInfo() whenever igApiCookies changes (e.g. after re-verify).
    if (this._warmedIgClientCache) {
      console.log(`[webClient:${this.profileId}] _buildWarmedIgClient: returning cached warmed client (bootstrap skipped)`);
      return this._warmedIgClientCache;
    }

    // ── Device setup ──────────────────────────────────────────────────────────
    // _newAutomationIgClient() hooks apiThrottle() into ig.request.send so every
    // ig.* call (warm-up inbox, broadcastText, etc.) is throttled automatically.
    const ig = this._newAutomationIgClient();
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
    patchIgClientTls(ig, this.proxyUrl);

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
    // news.inbox() tells Instagram "this device is active" and lifts the 4415001
    // gate on broadcastText.  If it fails at the NETWORK level (status 0 — proxy
    // drop, connection reset) we try ig.account.currentUser() as a lighter
    // fallback.  If an Instagram-level error is returned (4xx body) we still
    // treat the warm-up as succeeded — we're connected, inbox just errored.
    // Only when BOTH calls fail at the network level do we return null (broken
    // proxy) so the warm-up is NOT cached and the next sendDM attempt retries it.
    let warmupOk = false;
    try {
      await this.timed("NotificationsBadge", async () => { await ig.news.inbox(); return true; }, "Cold-start warm-up");
      console.log("[webClient] _buildWarmedIgClient: Phase 2 — news/inbox (notifications badge) OK");
      warmupOk = true;
    } catch (e: any) {
      // status 0 = network-level failure (proxy down / connection reset).
      // Any non-zero status means Instagram responded — warm-up is good enough.
      const isNetworkErr = !e?.response || ((e?.response?.statusCode ?? 0) === 0);
      if (isNetworkErr) {
        console.warn(`[webClient] _buildWarmedIgClient: news/inbox network-error (status 0) — trying currentUser() fallback: ${e?.message}`);
        try {
          await ig.account.currentUser();
          console.log("[webClient] _buildWarmedIgClient: Phase 2 — fallback currentUser() OK");
          warmupOk = true;
        } catch (e2: any) {
          console.warn(`[webClient] _buildWarmedIgClient: currentUser() fallback also failed: ${e2?.message}`);
        }
      } else {
        // Instagram returned an error body (4xx) — we're connected, treat as warm.
        console.warn(`[webClient] _buildWarmedIgClient: news/inbox Instagram-level error (non-fatal, treating as warm): ${e?.message}`);
        warmupOk = true;
      }
    }

    if (!warmupOk) {
      // Both warm-up attempts failed at the network level (proxy issue).
      // Do NOT cache a broken state — next sendDM call will retry the full warm-up.
      console.warn(`[webClient:${this.profileId}] _buildWarmedIgClient: warm-up failed (network) — NOT caching, returning null`);
      return null;
    }

    // qe/sync (FetchConfig) is intentionally NOT called here.
    // FetchConfig belongs exclusively to the verify bootstrap (Phase 2b in
    // verifyInstagramCredentials). Calling it again inside _buildWarmedIgClient
    // would produce a redundant back-to-back double qe/sync — not normal behaviour.

    // Store in cache so subsequent calls within the same session skip the bootstrap.
    // Invalidated by setDeviceInfo() when igApiCookies changes (re-verify).
    this._warmedIgClientCache = { ig, ownUserId };
    console.log(`[webClient:${this.profileId}] _buildWarmedIgClient: bootstrap complete — result cached for this session`);
    return this._warmedIgClientCache;
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

    // _newAutomationIgClient() hooks apiThrottle() into ig.request.send so every
    // ig.* call on this client is throttled by API Controls automatically.
    const ig = this._newAutomationIgClient();
    const deviceSeed = (this.userAgentApi ?? this.username ?? "instagram") + "|" + (this.username ?? "instagram");
    if (this.igDeviceState) {
      try {
        const saved = JSON.parse(this.igDeviceState) as { deviceId?: string; uuid?: string; phoneId?: string; adid?: string; deviceString?: string; authorization?: string; igWWWClaim?: string };
        ig.state.generateDevice(deviceSeed);
        if (saved.deviceId)     ig.state.deviceId     = saved.deviceId;
        if (saved.uuid)         ig.state.uuid         = saved.uuid;
        if (saved.phoneId)      ig.state.phoneId      = saved.phoneId;
        if (saved.adid)         ig.state.adid         = saved.adid;
        if (saved.deviceString) ig.state.deviceString = saved.deviceString;
        if (saved.authorization) ig.state.authorization = saved.authorization;
        if (saved.igWWWClaim)    ig.state.igWWWClaim    = saved.igWWWClaim;
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
    patchIgClientTls(ig, this.proxyUrl);

    try {
      console.log(`[webClient] like ${mediaId}: IgApiClient media.like (uuid=${ig.state.uuid.slice(0,8)}… csrf=${ig.state.cookieCsrfToken?.slice(0,8) ?? "none"})`);
      // No timed("LikePost") wrapper here — _inTimedCall is already true from the outer
      // timed("LikeMedia"), so the transport hook is suppressed. Using timed() here would
      // log the raw IgApiClient HTTP error string on failure, which is noisy and confusing.
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
      return { ok: false, reason: "like failed" };
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
    }, (r) => typeof r === "string" && r.startsWith("http") ? "Like successful" : r === "blocked" ? "Like blocked by Instagram" : "Like failed");
  }

  // ── Get a user's recent feed media IDs ────────────────────────────────────
  async getUserRecentMediaId(userId: string): Promise<string | null> {
    const j = await this.mobileSessionGet(`/api/v1/feed/user/${userId}/?count=3`);
    const items = j?.items;
    if (!Array.isArray(items) || items.length === 0) return null;
    return String(items[0].id ?? items[0].pk ?? "");
  }

  // ── View stories for a user (fetch + mark seen) ───────────────────────────
  // Returns the stories URL on success, false on failure.
  async viewStories(userId: string, username?: string): Promise<string | false> {
    return this.timed("ViewStories", async () => {
      const j = await this.mobileSessionGet(`/api/v1/feed/reels_media/?reel_ids=${userId}`);
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
      await this.mobileSessionPost(`/api/v1/media/seen/?reel=1&nuxes=0`, body);
      return username
        ? `https://www.instagram.com/stories/${username}/`
        : `https://www.instagram.com/`;
    }, username ? `View stories of @${username}` : `View stories of ${userId}`);
  }

  // ── View highlights for a user ────────────────────────────────────────────
  // Returns the specific highlight URL on success, false on failure.
  async viewHighlights(userId: string, username?: string): Promise<string | false> {
    return this.timed("ViewHighlights", async () => {
      const j = await this.mobileSessionGet(`/api/v1/highlights/${userId}/highlights_tray/`);
      const trays: any[] = j?.tray ?? [];
      if (!trays.length) return false;
      // Mark first highlight as seen — fetch ALL its items (no slice limit)
      const first = trays[0];
      const reelId = String(first.id ?? "");
      if (!reelId) return false;
      const details = await this.mobileSessionGet(`/api/v1/feed/reels_media/?reel_ids=${reelId}`);
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
      await this.mobileSessionPost(`/api/v1/media/seen/?reel=1&nuxes=0`, body);
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
      const j = await this.mobileSessionPost(`/api/v1/clips/user/`, body);
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
      await this.mobileSessionPost(`/api/v1/media/seen/`, seenBody);
      return `https://www.instagram.com/reel/${firstShortcode}/`;
    }, username ? `View reels of @${username}` : `View reels of ${userId}`);
  }

  // ── Visit notifications inbox ─────────────────────────────────────────────
  // Simulates a user tapping the heart/notification icon.
  async visitNotifications(): Promise<boolean> {
    return this.timed("VisitNotifications", async () => {
      const j = await this.mobileSessionGet(`/api/v1/news/inbox/?mark_as_seen=true&warning_sweep_enabled=true`);
      return !!(j?.new_stories || j?.old_stories || j?.counts);
    }, "Visit notifications");
  }

  // ── Visit own profile ─────────────────────────────────────────────────────
  // Simulates a user tapping their own profile tab.
  async visitOwnProfile(): Promise<boolean> {
    return this.timed("VisitOwnProfile", async () => {
      const j = await this.mobileSessionGet(`/api/v1/accounts/current_user/?edit=true`);
      return !!(j?.user);
    }, "Visit own profile");
  }

  // ── Fetch own profile stats (followers / following / posts) ───────────────
  // Uses the same current_user endpoint but extracts the counts.
  async getOwnProfileStats(): Promise<{ followersCount: number; followingCount: number; postsCount: number } | null> {
    const ACCT_LEVEL_RE = /checkpoint_required|challenge_required|login_required|not authorized|session expired|logged.?out|not logged in|suspended|disabled|account_disabled|compromised|phone.*verif|verify.*phone|email.*confirm|confirm.*email|email.*verif|verify.*email/i;
    try {
      const j = await this.mobileSessionGet(`/api/v1/accounts/current_user/?edit=true`);
      const u = j?.user;
      if (!u) {
        // Surface account-level failures buried in the response body so the caller
        // can update accountStatus — don't silently swallow them.
        const msg = (j?.message ?? "") as string;
        if (j?.status === "fail" && msg && ACCT_LEVEL_RE.test(msg)) throw new Error(msg);
        return null;
      }
      return {
        followersCount: Number(u.follower_count ?? u.followed_by_count ?? 0),
        followingCount: Number(u.following_count ?? 0),
        postsCount:     Number(u.media_count ?? 0),
      };
    } catch (e: any) {
      const msg = (e?.message ?? "") as string;
      // Re-throw account-level errors so runProfileSync can update accountStatus.
      // Swallow transient network/timeout errors — those don't affect account standing.
      if (ACCT_LEVEL_RE.test(msg)) throw e;
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
      const j = await this.mobileSessionGet(`/api/v1/feed/user/${userId}/?count=12`);
      return !!(j?.items || j?.profile_grid_items);
    }, "Refresh own profile");
  }

  // ── Click Settings and Activity ───────────────────────────────────────────
  // Simulates visiting the Settings page — fetches account security info.
  // This endpoint requires POST as of 2024 (GET returns 405).
  async runForceEmulation(randomise: boolean): Promise<void> {
    // Endpoints that accept GET (read-only fetches).
    // NOTE: /api/v1/qe/sync/ (FetchConfig) is intentionally excluded — it
    // returns "400 Invalid experiment" because the library's LOGIN_EXPERIMENTS
    // list is outdated vs our declared app version. Removed to avoid noise.
    const entries: Array<{ path: string; method: "GET" | "POST"; opName: string; body?: string }> = [
      // ?surface=2 — matches the real app's reels tray fetch (line 2260 uses same param)
      { method: "GET",  path: "/api/v1/feed/reels_tray/?surface=2",                                                                    opName: "GetReelsTray"       },
      // reels_media removed — requires a list of reel IDs in the query string;
      // a bare GET with no IDs returns "Invalid reel id list" every time.
      { method: "GET",  path: "/api/v1/news/inbox/?mark_as_seen=true&warning_sweep_enabled=true",                                      opName: "NotificationsBadge" },
      // Full params match the real GetDirectMessages call at line 2415
      { method: "GET",  path: "/api/v1/direct_v2/inbox/?visual_message_return_type=unseen&thread_message_limit=10&persistentBadging=true&limit=20", opName: "GetDirectInbox"     },
      { method: "GET",  path: "/api/v1/accounts/current_user/?edit=true",                                                              opName: "GetCurrentUser"     },
      // Body matches viewTimelineFeed() at line 2033 — required by Instagram for cold-start fetches
      { method: "POST", path: "/api/v1/feed/timeline/",   body: "reason=cold_start_fetch&is_pull_to_refresh=0",                        opName: "ViewTimelineFeed"   },
      // server_config_retrieval=1 is the minimum body the real app sends on launcher/sync
      { method: "POST", path: "/api/v1/launcher/sync/",   body: "server_config_retrieval=1",                                          opName: "LauncherSync"       },
      { method: "POST", path: "/api/v1/analytics/log/",                                                                                opName: "AnalyticsLog"       },
      // Batch query-parameter prefetch — fires unconditionally on every real app open
      // Minimal surface set (5717 = home feed, 5718 = stories) matches the startup call pattern
      { method: "POST", path: "/api/v1/qp/batch_fetch_web/",  body: `surfaces_to_queries=${encodeURIComponent(JSON.stringify({ "5717": {}, "5718": {} }))}`, opName: "BatchFetchWeb" },
      // App-launch attribution ping — fires unconditionally on every real app open
      { method: "POST", path: "/api/v1/attribution/launch/",                                                                            opName: "AttributionLaunch"  },
    ];
    const ordered = randomise
      ? [...entries].sort(() => Math.random() - 0.5)
      : entries;
    for (const { path, method, opName, body } of ordered) {
      // Each endpoint gets its own timed() entry so every call appears
      // individually in the API calls log instead of as one bundled summary.
      // Errors are caught per-endpoint so a single 400 never propagates out
      // and incorrectly marks the account as logged_out.
      await this.timed(opName, async () => {
        try {
          if (method === "POST") {
            await this.mobileSessionPost(path, body ?? "");
          } else {
            await this.mobileSessionGet(path);
          }
          console.log(`[webClient] forceEmulation: ${method} ${path} OK`);
          return true;
        } catch (e: any) {
          const errMsg = (e?.message ?? "error").slice(0, 80);
          console.warn(`[webClient] forceEmulation: ${method} ${path} failed: ${errMsg}`);
          return false;
        }
      }, (ok) => ok ? FORCE_EMU_FRIENDLY[opName] ?? "OK" : `Failed`);
    }
  }

  async visitSettingsAndActivity(): Promise<boolean> {
    return this.timed("VisitSettingsAndActivity", async () => {
      const j = await this.mobileSessionPost(`/api/v1/accounts/account_security_info/`);
      return !!(j?.status !== "fail");
    }, "Visit settings and activity");
  }

  // ── Scroll the home timeline feed ────────────────────────────────────────
  // Fetches the main home feed and marks up to `count` posts as seen,
  // simulating a user scrolling through their Instagram home feed.
  // Paginates using next_max_id so the full count (e.g. 50–100) is reachable —
  // Instagram returns only ~12–18 posts per call so multiple pages are needed.
  async viewTimelineFeed(count: number = 5, reelWatchPercentMin: number = 0, reelWatchPercentMax: number = 0, reelWatchCountMin: number = 0, reelWatchCountMax: number = 0, _consentRetry = false): Promise<{ viewed: number; sessionExpired?: boolean; reason?: string; items?: Array<{ mediaId: string; userId: string; username: string; shortcode: string; isReel: boolean }>; reelWatches?: Array<{ mediaId: string; shortcode: string; username: string; pct: number; durationSec: number }> }> {
    // ── Page 1: cold_start_fetch ─────────────────────────────────────────────
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
      const failMsg = j?.message ?? "unknown";
      console.warn(`[webClient] viewTimelineFeed: timeline fetch failed — status="${j?.status}" message="${failMsg}"`);
      if (/challenge_required|checkpoint_required|checkpoint required|login_required|not authorized|session expired|logged.?out|suspended|disabled/i.test(failMsg)) {
        throw new Error(failMsg);
      }
      // consent_required: Instagram is blocking all API calls until the account
      // accepts the updated T&C / Privacy Policy. Accept it programmatically via
      // the mobile API and retry this call once — no EB interaction needed.
      if (failMsg === "consent_required" && !_consentRetry) {
        console.log(`[webClient] viewTimelineFeed: consent_required — attempting programmatic consent acceptance`);
        const accepted = await this._tryAcceptConsent();
        if (accepted) {
          console.log(`[webClient] viewTimelineFeed: retrying after consent acceptance`);
          return this.viewTimelineFeed(count, reelWatchPercentMin, reelWatchPercentMax, reelWatchCountMin, reelWatchCountMax, true);
        }
      }
      return { viewed: 0 };
    }

    // ── Per-page processing ───────────────────────────────────────────────────
    // Real Instagram marks posts as seen immediately as the user scrolls through
    // each page — BEFORE requesting the next page.  Fetching the next page is
    // triggered by the seen POST from the current page items.  We replicate this
    // interleaved pattern: fetch → mark seen → fetch → mark seen → …
    //
    // How many reels to actually click and fire ClipsViewed for this operation.
    const safeMin = Math.min(reelWatchCountMin, reelWatchCountMax);
    const safeMax = Math.max(reelWatchCountMin, reelWatchCountMax);
    const reelWatchLimit = reelWatchCountMax > 0
      ? Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin
      : 0;
    let reelWatchedSoFar = 0;
    let viewed = 0;
    const viewedItems: Array<{ mediaId: string; userId: string; username: string; shortcode: string; isReel: boolean }> = [];
    const reelWatches: Array<{ mediaId: string; shortcode: string; username: string; pct: number; durationSec: number }> = [];
    const allClipImpressions: Array<{ clip_id: string; view_state: string }> = [];

    // Marks one page's worth of posts as seen (batches of 4, matching real app behaviour)
    // and accumulates viewedItems / reelWatches.  Returns number of items consumed.
    const processAndMarkPage = async (rawPage: any[]): Promise<number> => {
      const remaining = count - viewed;
      const pageMedia = rawPage
        .map((raw: any) => raw?.media_or_ad ?? raw?.media ?? raw)
        .filter((m: any) => m?.id || m?.pk)
        .slice(0, remaining);

      if (!pageMedia.length) return 0;

      const seenEntries: string[] = [];
      for (const media of pageMedia) {
        const mediaId = String(media?.id ?? media?.pk ?? "");
        if (!mediaId) continue;
        const takenAt = media.taken_at ?? Math.floor(Date.now() / 1000);
        const isReel = media?.media_type === 2 || media?.product_type === "clips";
        let watchDuration = 3;
        let watchPct = 0;
        if (isReel && reelWatchPercentMax > 0) {
          const reelDuration = Number(media.video_duration ?? 30);
          const pct = reelWatchPercentMin + Math.random() * Math.max(0, reelWatchPercentMax - reelWatchPercentMin);
          watchPct = Math.round(pct);
          watchDuration = Math.max(1, Math.round(reelDuration * pct / 100));
        }
        seenEntries.push(`${mediaId}_${takenAt}_${takenAt + watchDuration}`);
        viewed++;

        if (isReel && reelWatchPercentMax > 0 && reelWatchedSoFar < reelWatchLimit) {
          const username = String(media?.user?.username ?? "");
          allClipImpressions.push({ clip_id: mediaId, view_state: "initial_impression" });
          reelWatchedSoFar++;
          reelWatches.push({ mediaId, shortcode: this.mediaIdToShortcode(mediaId), username, pct: watchPct, durationSec: watchDuration });
        }
        const userId   = String(media?.user?.pk ?? media?.user_id ?? "");
        const username = String(media?.user?.username ?? "");
        if (userId) viewedItems.push({ mediaId, userId, username, shortcode: this.mediaIdToShortcode(mediaId), isReel });
      }

      // Instagram's real mobile app sends at most 4 posts per media/seen/ call.
      // Fire the seen POST for this page's items immediately (before next page fetch).
      for (let i = 0; i < seenEntries.length; i += 4) {
        const batch = seenEntries.slice(i, i + 4);
        await this.timed("ViewTimelineFeedSeen", async () => {
          await this.mobileSessionPost(`/api/v1/media/seen/`, new URLSearchParams({
            reels: batch.join(","),
            live_vods_skipped: "",
            nuxes_skipped: "",
          }).toString());
          return batch.length;
        }, (n) => `Marked ${n} post${n === 1 ? "" : "s"} as seen`);
      }

      return pageMedia.length;
    };

    // Process page 1 (already fetched above)
    const page1Raw: any[] = j?.feed_items ?? j?.items ?? [];
    console.log(`[webClient] viewTimelineFeed: page 1 — ${page1Raw.length} raw items`);
    if (!page1Raw.length) return { viewed: 0 };
    await processAndMarkPage(page1Raw);

    // Paginate: fetch next pages only after marking current page seen
    let nextMaxId: string | null = j?.next_max_id ?? null;
    const MAX_PAGES = 8;
    let page = 1;
    while (viewed < count && nextMaxId && page < MAX_PAGES) {
      console.log(`[webClient] viewTimelineFeed: page ${page + 1} — have ${viewed}/${count} seen, cursor=${String(nextMaxId).slice(0, 24)}…`);
      const pageJ = await this.mobileSessionPost(
        `/api/v1/feed/timeline/`,
        new URLSearchParams({ reason: "pagination", max_id: nextMaxId, is_pull_to_refresh: "0" }).toString(),
      );
      if (!pageJ) break;
      const pageRaw: any[] = pageJ?.feed_items ?? pageJ?.items ?? [];
      if (!pageRaw.length) break;
      await processAndMarkPage(pageRaw);
      nextMaxId = pageJ?.next_max_id ?? null;
      page++;
    }

    console.log(`[webClient] viewTimelineFeed: ${page} page(s) — ${viewed} posts seen`);

    // ClipsViewed is a bulk impression signal — one call for all watched reels is fine.
    if (allClipImpressions.length) {
      await this.timed("ClipsViewed", async () => {
        await this.mobileSessionPost(
          `/api/v1/clips/clips_viewed/`,
          new URLSearchParams({
            clips_viewed_impressions: JSON.stringify(allClipImpressions),
            is_clips_creation_page: "false",
          }).toString(),
        ).catch(() => {});
        return allClipImpressions.length;
      }, (n) => `Watched ${n} reel${n === 1 ? "" : "s"}`).catch(() => {});
    }

    return { viewed, items: viewedItems, reelWatches };
  }

  // ── Open / view a single feed post (simulates tapping into it) ───────────
  // Previously called media/{id}/info/ — that endpoint is identical to what
  // scrapers use and adds no value for emulation. The media/seen POST
  // (fired in bulk by the caller) is sufficient to register the view.
  async viewFeedPost(mediaId: string): Promise<boolean> {
    return this.timed("ViewFeedPost", async () => true, "Viewed feed post");
  }

  // ── Open and play a reel from the feed (simulates tapping + watching) ────
  // Previously called media/{id}/info/ before clips_viewed — removed because
  // media.info is a scraping endpoint. clips_viewed is the meaningful signal.
  async viewFeedReel(mediaId: string): Promise<boolean> {
    return this.timed("ViewFeedReel", async () => {
      // Fire clips_viewed — a failure here should not fail the whole action
      await this.timed("ClipsViewed", async () => {
        await this.mobileSessionPost(
          `/api/v1/clips/clips_viewed/`,
          new URLSearchParams({
            clips_viewed_impressions: JSON.stringify([{ clip_id: mediaId, view_state: "initial_impression" }]),
            is_clips_creation_page: "false",
          }).toString(),
        ).catch(() => {});
        return true;
      }, undefined, () => false).catch(() => {});
      return true;
    }, "Opened and played reel from feed");
  }

  // ── Visit a user's profile page ──────────────────────────────────────────
  // Previously called users/{id}/info/ — removed because that endpoint is
  // identical to what scrapers use. The logged action is still recorded.
  // Callers that follow this with viewUserFeed still generate the feed fetch.
  async visitUserProfile(_userId: string, _fromModule: string = "profile"): Promise<boolean> {
    return this.timed("VisitUserProfile", async () => true, "Visited user profile");
  }

  // ── Scroll through a user's post feed (profile grid) ────────────────────
  // Fetches up to `count` posts from the user's feed and marks them as seen,
  // simulating a user scrolling through someone's profile grid.
  // Each API call is logged individually: one ViewUserFeed for the fetch,
  // then one ViewFeedPost per post marked as seen.
  async viewUserFeed(userId: string, count: number): Promise<Array<{ mediaId: string; shortcode: string; username: string }>> {
    const clampedCount = Math.max(1, count);
    let rawItems: any[] = [];
    await this.timed("ViewUserFeed", async () => {
      const j = await this.mobileSessionGet(`/api/v1/feed/user/${userId}/?count=${clampedCount}`);
      rawItems = (j?.items as any[] ?? []).slice(0, clampedCount);
      return rawItems.length;
    }, (n) => `Viewed user feed: ${n} posts`);

    const result: Array<{ mediaId: string; shortcode: string; username: string }> = [];
    const seenEntries: string[] = [];

    for (const media of rawItems) {
      const mediaId = String(media?.id ?? media?.pk ?? "");
      if (!mediaId) continue;
      const takenAt = media.taken_at ?? Math.floor(Date.now() / 1000);
      seenEntries.push(`${mediaId}_${takenAt}_${takenAt + 3}`);
      result.push({
        mediaId,
        shortcode: this.mediaIdToShortcode(mediaId),
        username: String(media?.user?.username ?? ""),
      });
    }

    // 1 media/seen call for all posts — 1 throttle total instead of N.
    if (seenEntries.length) {
      await this.timed("ViewFeedPost", async () => {
        await this.mobileSessionPost(`/api/v1/media/seen/`, new URLSearchParams({
          reels: seenEntries.join(","),
          live_vods_skipped: "",
          nuxes_skipped: "",
        }).toString()).catch(() => {});
        return seenEntries.length;
      }, (n) => `Marked ${n} post${n === 1 ? "" : "s"} as seen`);
    }

    return result;
  }

  // ── Watch reels from the home feed Reels tab ─────────────────────────────
  // Fetches the reels explore/home feed and marks up to `count` reels as seen,
  // simulating a user scrolling through the Reels tab.
  async viewTimelineReels(count: number = 5): Promise<number> {
    // Returns: >=0 reels watched, -1 no mobile session, -5 session rejected by API.
    return this.timed("ViewTimelineReels", async () => {
      const sessionPresent =
        this.mobileCookieJar.some(c => c.startsWith("sessionid=")) ||
        !!this._deviceAuthorization;
      if (!sessionPresent) {
        console.warn(`[webClient] viewTimelineReels: no mobile session — run Verify Credentials to establish igApiCookies`);
        return -1;
      }

      // ── Strategy 1: GET /api/v1/clips/home/ ─────────────────────────────────
      // Feed endpoints are naturally GET requests. The prior POST approach returned
      // null JSON (HTML error page) for many accounts. Switching to GET fixes this.
      const sessionId = randomUUID();
      let j = await this.mobileSessionGet(
        `/api/v1/clips/home/?session_id=${sessionId}&tab_type=clips&next_max_id=`
      );
      let source = "clips/home";

      // ── Strategy 2: fallback to feed/timeline filtered for reels ────────────
      // If clips/home is unavailable for this account (returns null), fall back to
      // the home timeline feed and pick out the reel items (media_type === 2).
      // This endpoint works for all accounts and already returns reels in the feed.
      if (!j) {
        console.warn(`[webClient] viewTimelineReels: clips/home returned null — falling back to feed/timeline`);
        const body = new URLSearchParams({ reason: "cold_start_fetch", is_pull_to_refresh: "0" }).toString();
        const tj = await this.mobileSessionPost(`/api/v1/feed/timeline/`, body);
        if (!tj) {
          console.warn(`[webClient] viewTimelineReels: feed/timeline also returned null — session expired/rejected`);
          return -5;
        }
        // Build a synthetic clips/home-like response using only the reel items
        const allItems: any[] = tj?.feed_items ?? tj?.items ?? [];
        const reelItems = allItems
          .map((raw: any) => raw?.media_or_ad ?? raw?.media ?? raw)
          .filter((m: any) => m?.media_type === 2 || m?.product_type === "clips");
        j = { items: reelItems, status: "ok" };
        source = "feed/timeline (reels only)";
      }

      // clips/home returns items under "items"; feed_items is an older alias.
      const items: any[] = j?.items ?? j?.feed_items ?? [];
      console.log(`[webClient] viewTimelineReels [${source}]: status="${j?.status}" items.length=${items.length}`);
      if (items.length > 0) {
        const firstRaw = items[0];
        console.log(`[webClient] viewTimelineReels: first item keys=[${Object.keys(firstRaw?.media ?? firstRaw ?? {}).join(", ")}]`);
      }
      if (!items.length) {
        console.warn(`[webClient] viewTimelineReels: 0 items — response (500 chars): ${JSON.stringify(j).slice(0, 500)}`);
        return 0;
      }

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
        await this.mobileSessionPost(`/api/v1/media/seen/`, seenBody);
      }

      return toView.length;
    }, (n) => n > 0 ? `Viewed ${n} timeline reel${n === 1 ? "" : "s"}` : "",
       (n) => n > 0);
  }

  // ── Watch stories from the timeline tray ─────────────────────────────────
  // Fetches the stories tray at the top of the home feed and marks up to
  // `count` story reels as seen, simulating a user swiping through stories.
  async viewTimelineStories(count: number = 5): Promise<{ count: number; items: { mediaId: string; userId: string }[] }> {
    return this.timed("ViewTimelineStories", async () => {
      // surface=2 is required — without it Instagram returns an empty tray even
      // when followed accounts have active stories (Jarvee always includes this param).

      // Check up-front so we can return distinct sentinel values:
      //   count: -1 = no mobile session at all (mobileCookieJar has no sessionid)
      //   count: -5 = session existed but the mobile API rejected it (HTTP 4xx / expired)
      const sessionPresent =
        this.mobileCookieJar.some(c => c.startsWith("sessionid=")) ||
        !!this._deviceAuthorization;
      if (!sessionPresent) {
        return { count: -1, items: [] };
      }

      const j = await this.mobileSessionGet(`/api/v1/feed/reels_tray/?surface=2`);
      if (j === null) {
        // mobileSessionGet returned null — the session was present but Instagram
        // rejected it (HTTP 4xx / expired / checkpoint).  Return -5 so the caller
        // can show a more accurate "session expired" message instead of "no session".
        return { count: -5, items: [] };
      }
      const tray: any[] = Array.isArray(j?.tray) ? j.tray : [];
      if (!tray.length) {
        const topKeys = Object.keys(j ?? {}).join(", ") || "(none)";
        const statusField = j?.status ?? "(no status field)";
        console.log(`[webClient] viewTimelineStories: empty tray. status="${statusField}" top-level keys=[${topKeys}]`);
        return { count: -2, items: [] };
      }

      const toView = tray.slice(0, count);
      const seenBody = new URLSearchParams({ live_vods_skipped: "", nuxes_skipped: "" });
      let seenCount = 0;
      const allItems: { mediaId: string; userId: string }[] = [];

      // Instagram's reels_tray does not inline full story items in the modern API —
      // but it does include a media_ids array per entry.  Use that directly so we
      // never need to make a second reels_media API call (which uses mobileSessionPost
      // and would be throttled 10-60s after the tray fetch, and currently returns 500).
      //
      // Priority order:
      //   1. inline reel.items[]  (older API — has full taken_at)
      //   2. reel.media_ids[]     (modern API — use expiring_at-86400 as approx taken_at)
      let reelsMap: Record<string, any[]> = {};

      // Log first tray entry structure for diagnostics
      console.log(`[webClient] viewTimelineStories: tray has ${tray.length} entries. First entry keys: [${Object.keys(toView[0] ?? {}).join(", ")}] user.pk=${toView[0]?.user?.pk} media_ids=${JSON.stringify(toView[0]?.media_ids)?.slice(0,80)} items=${JSON.stringify(toView[0]?.items)?.slice(0,60)}`);

      const path3UserIds: string[] = [];

      for (const reel of toView) {
        const userId = String(reel.user?.pk ?? reel.id ?? "");
        if (!userId) continue;

        // Path 1: full items array inlined (older API)
        const inlineItems: any[] = Array.isArray(reel.items) ? reel.items : [];
        if (inlineItems.length) {
          reelsMap[userId] = inlineItems;
          continue;
        }

        // Path 2: media_ids present (modern API) — build synthetic item objects
        // taken_at ≈ expiring_at − 86400 (stories expire 24h after posting).
        // If expiring_at is missing, fall back to now − 1h.
        const mediaIds: string[] = Array.isArray(reel.media_ids)
          ? reel.media_ids.map(String)
          : [];
        if (mediaIds.length) {
          const expiringAt = Number(reel.expiring_at ?? 0);
          const approxTakenAt = expiringAt > 0
            ? expiringAt - 86400
            : Math.floor(Date.now() / 1000) - 3600;
          reelsMap[userId] = mediaIds.map((id) => ({ id, taken_at: approxTakenAt }));
          console.log(`[webClient] viewTimelineStories: user ${userId} — using ${mediaIds.length} media_ids from tray (approxTakenAt=${approxTakenAt})`);
          continue;
        }

        // Path 3: tray entry has no items/media_ids — fetch user story directly.
        // The tray tells us this user HAS stories even when it doesn't inline them.
        // Entry keys logged above help diagnose the tray structure variant.
        console.log(`[webClient] viewTimelineStories: user ${userId} — no items/media_ids in tray entry (keys: ${Object.keys(reel).join(", ")}), queuing direct story fetch`);
        path3UserIds.push(userId);
      }

      // Path 3 fetch — /api/v1/feed/user/{pk}/story/ returns full item arrays
      for (const userId of path3UserIds) {
        try {
          const storyJ = await this.mobileSessionGet(`/api/v1/feed/user/${userId}/story/`);
          const storyItems: any[] = Array.isArray(storyJ?.reel?.items)
            ? storyJ.reel.items
            : Array.isArray(storyJ?.items)
            ? storyJ.items
            : [];
          if (storyItems.length) {
            reelsMap[userId] = storyItems;
            console.log(`[webClient] viewTimelineStories: user ${userId} — path 3 fetched ${storyItems.length} items`);
          } else {
            console.log(`[webClient] viewTimelineStories: user ${userId} — path 3 story fetch returned no items (keys: ${Object.keys(storyJ ?? {}).join(", ")})`);
          }
        } catch (err: any) {
          console.warn(`[webClient] viewTimelineStories: path 3 story fetch for user ${userId} failed: ${err?.message}`);
        }
      }

      for (const [userId, items] of Object.entries(reelsMap)) {
        const seenEntries = items.map((item: any) => {
          const mediaId = String(item.id ?? item.pk ?? "");
          const takenAt = item.taken_at ?? Math.floor(Date.now() / 1000);
          if (mediaId) allItems.push({ mediaId, userId });
          return `${mediaId}_${takenAt}_${takenAt + 2}`;
        });
        seenBody.set(`reels[${userId}]`, seenEntries.join(","));
        seenCount++;
      }

      if (seenCount === 0) {
        console.log(`[webClient] viewTimelineStories: still 0 after reels_media fetch`);
        return { count: -3, items: [] };
      }

      await this.mobileSessionPost(`/api/v1/media/seen/?reel=1&nuxes=0`, seenBody.toString());
      return { count: seenCount, items: allItems };
    }, (r) => {
      const n = r.count;
      if (n < 0) {
        if (n === -1) return "No mobile session";
        if (n === -2) return "No stories in tray";
        if (n === -3) return "Story tray fetched — nothing to mark seen";
        if (n === -5) return "Session expired";
        return `Story view error (code ${n})`;
      }
      return `Viewed ${n} timeline stor${n === 1 ? "y" : "ies"}`;
    });
  }

  // ── Share a story slide to a random DM thread ─────────────────────────────
  // Fetches the DM inbox to find an existing thread, picks one at random,
  // and sends the story as a story_share broadcast — exactly what the share
  // button on a story does.  The inbox fetch here is a prerequisite for
  // finding a thread ID — it is NOT a "check DMs" action.
  async shareStoryViaDm(mediaId: string, ownerId: string): Promise<boolean> {
    return this.timed("ShareStoryViaDM", async () => {
      const j = await this.mobileSessionGet(
        `/api/v1/direct_v2/inbox/?persistentBadging=true&visual_message_return_type=unseen&thread_message_limit=1&limit=20`
      );
      const threads: any[] = j?.inbox?.threads ?? j?.threads ?? [];
      if (!threads.length) {
        console.log(`[webClient] shareStoryViaDm: no DM threads found — skipping share`);
        return false;
      }
      const thread = threads[Math.floor(Math.random() * threads.length)];
      const threadId: string = thread?.thread_id ?? thread?.id ?? "";
      if (!threadId) return false;

      const clientCtx = randomUUID();
      const body = new URLSearchParams({
        story_media_id: mediaId,
        reel_id: ownerId,
        thread_ids: JSON.stringify([threadId]),
        action: "send_item",
        client_context: clientCtx,
        offline_threading_id: clientCtx,
        is_shh_mode: "0",
      }).toString();

      const resp = await this._mobileDmPost(`/api/v1/direct_v2/threads/broadcast/story_share/`, body);
      const ok = resp?.status === "ok";
      if (!ok) console.log(`[webClient] shareStoryViaDm response:`, JSON.stringify(resp)?.slice(0, 300));
      return ok;
    }, (r) => r ? "Shared story via DM" : "Story share skipped (no threads)");
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
  // Calls GetDirectMessages directly — no NotificationsBadge warm-up.
  // Returns the full mapped inbox thread list so auto-reply can reuse it
  // without a second inbox fetch.
  async getDirectMessagesInternal(count: number = 5): Promise<{
    count: number;
    ok: boolean;
    threads: { threadId: string; username: string; userId: string; firstName: string; items: { itemId: string; text: string; fromMe: boolean }[] }[];
  }> {
    // Check a mobile session is available before making any calls.
    const hasMobileSession = this.mobileCookieJar.some(c => c.startsWith("sessionid=")) || !!this._deviceAuthorization;
    if (!hasMobileSession && !this.igApiCookies) {
      console.warn("[webClient] getDirectMessagesInternal: no mobile session — skipping DM check");
      return { count: 0, ok: false, threads: [] };
    }

    // Extract own user ID from igApiCookies (ds_user_id=…) for fromMe detection.
    const dsMatch = (this.igApiCookies ?? "").match(/(?:^|;)\s*ds_user_id=([^;]+)/);
    const myUserId = dsMatch ? dsMatch[1].trim() : "";

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
    // Use mobileSessionGet instead of ig.feed.directInbox().items().
    // The IgApiClient library's directInbox request is rejected with 400 by
    // Instagram (its header set diverges from what Instagram now expects).
    // mobileSessionGet uses the exact same headers as every other working
    // mobile API call in this client and is the correct transport here.
    let inboxThreads: any[] = [];
    try {
      const inboxResult = await this.timed("GetDirectMessages", async () => {
        const j = await this.mobileSessionGet(
          `/api/v1/direct_v2/inbox/?visual_message_return_type=unseen&thread_message_limit=10&persistentBadging=true&limit=20`
        );
        if (!j) throw new Error("DM inbox returned null (HTTP 4xx)");
        const items: any[] = j?.inbox?.threads ?? j?.threads ?? [];
        return { items, ok: true as const };
      }, (r) => `Inbox overview: ${r.items.length} thread${r.items.length === 1 ? "" : "s"}`,
      (r) => r.ok);
      inboxThreads = inboxResult.items;
      console.log(`[webClient] getDirectMessagesInternal: inbox OK — ${inboxThreads.length} thread(s), will open ${Math.min(count, inboxThreads.length)}`);
    } catch (e: any) {
      const code = e?.response?.body?.content?.error_code ?? e?.response?.body?.error_code;
      const msg  = String(e?.message ?? "");
      console.warn(`[webClient] getDirectMessagesInternal: inbox error code=${code} — ${msg}`);
      // Re-throw account-level errors (checkpoint, email confirmation, session
      // expired, etc.) so the engine's checkSessionErr can classify them and
      // write the correct accountStatus to the DB.  Transient errors (network
      // timeouts, rate-limits) stay swallowed and just produce ok:false.
      if (/checkpoint|challenge_required|login_required|not authorized|session expired|logged.?out|email.*confirm|confirm.*email|email.*verif|verify.*email|phone.*verif|verify.*phone|suspended|disabled/i.test(msg)) {
        throw e;
      }
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
          // Use mobileSessionGet — same reason as inbox fetch above
          // (ig.feed.directThread also gets 400 from the library transport).
          const j = await this.mobileSessionGet(
            `/api/v1/direct_v2/threads/${threadId}/?visual_message_return_type=unseen&limit=10`
          );
          if (!j) throw new Error(`thread ${threadId} returned null (HTTP 4xx)`);
          const msgs: any[] = j?.thread?.items ?? [];
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
        // Use mobileSessionGet — ig.feed.directInbox().items() gets 400 from
        // Instagram (library transport header mismatch). mobileSessionGet uses
        // the correct header set that all other working calls use.
        const j = await this.mobileSessionGet(
          `/api/v1/direct_v2/inbox/?visual_message_return_type=unseen&thread_message_limit=10&persistentBadging=true&limit=${count}`
        );
        if (!j) throw new Error("DM inbox returned null (HTTP 4xx)");
        const mainThreads: any[] = j?.inbox?.threads ?? j?.threads ?? [];
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
      const j = await this.mobileSessionPost(`/api/v1/media/${mediaId}/save/`, body);
      return j?.status === "ok";
    }, `Save media ${mediaId}`);
  }

  async sharePostToFeed(mediaId: string): Promise<boolean> {
    return this.timed("SharePostToFeed", async () => {
      const body = new URLSearchParams({ media_id: mediaId }).toString();
      const j = await this.mobileSessionPost(`/api/v1/media/${mediaId}/re_share_to_feed/`, body);
      return j?.status === "ok";
    }, `Share post to feed ${mediaId}`);
  }

  async postComment(mediaId: string, text: string): Promise<boolean> {
    return this.timed("PostComment", async () => {
      const body = new URLSearchParams({ comment_text: text }).toString();
      const j = await this.mobileSessionPost(`/api/v1/media/${mediaId}/comment/`, body);
      return j?.status === "ok";
    }, `Comment on media ${mediaId}`);
  }

  async likeDirectMessage(threadId: string, itemId: string): Promise<boolean> {
    return this.timed("LikeDM", async () => {
      const body = new URLSearchParams({}).toString();
      const j = await this.mobileSessionPost(`/api/v1/direct_v2/threads/${threadId}/items/${itemId}/like/`, body);
      return j?.status === "ok";
    }, `Like DM thread=${threadId} item=${itemId}`);
  }

  async likeTimelinePosts(count: number = 3, delayMinSec: number = 3, delayMaxSec: number = 8, reelWatchPercentMin: number = 0, reelWatchPercentMax: number = 0): Promise<{ liked: number; watched: number; likedPosts: Array<{ shortcode: string; ownerUsername: string; mediaId: string }>; sessionExpired?: boolean; sessionExpiredReason?: string }> {
    // No timed() wrapper here — individual likeMedia() calls each produce their
    // own LikeMedia log entry. A LikeTimelinePosts summary on top would cause
    // two entries at the same timestamp and make rate-limit audits confusing.
    //
    // No timed() wrapper for the timeline fetch — mobileSessionPost fires
    // _logTransport directly, producing a "FeedTimeline" API call log entry.
    // All three calls (FeedTimeline, ViewTimelineFeedSeen, LikeMedia) are real
    // throttled Instagram endpoints and must all appear in the log.
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
      const failMsg = j?.message ?? "unknown";
      console.warn(`[webClient] likeTimelinePosts: timeline fetch failed — status="${j?.status}" message="${failMsg}"`);
      if (/challenge_required|checkpoint_required|checkpoint required|login_required|not authorized|session expired|logged.?out|suspended|disabled/i.test(failMsg)) {
        throw new Error(failMsg);
      }
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

    // Batch all reel seen marks into 1 call upfront — 1 throttle instead of N.
    // Instagram's home feed is now predominantly Reels, so we must mark them seen
    // before liking (same as a real user scrolling past). The dedicated Watch Reels
    // tool uses /api/v1/clips/home/ (a separate endpoint) — no overlap.
    const reelSeenEntries: string[] = [];
    for (const media of toProcess) {
      const isReel = media?.media_type === 2 || media?.product_type === "clips";
      if (!isReel) continue;
      const mediaId = String(media?.id ?? media?.pk ?? "");
      if (!mediaId) continue;
      const takenAt = media.taken_at ?? Math.floor(Date.now() / 1000);
      let watchDuration = 4;
      if (reelWatchPercentMax > 0) {
        const reelDuration = Number(media.video_duration ?? 30);
        const pct = reelWatchPercentMin + Math.random() * Math.max(0, reelWatchPercentMax - reelWatchPercentMin);
        watchDuration = Math.max(1, Math.round(reelDuration * pct / 100));
      }
      reelSeenEntries.push(`${mediaId}_${takenAt}_${takenAt + watchDuration}`);
    }
    if (reelSeenEntries.length) {
      await this.timed("ViewTimelineFeedSeen", async () => {
        try {
          await this.mobileSessionPost(`/api/v1/media/seen/`, new URLSearchParams({
            reels: reelSeenEntries.join(","),
            live_vods_skipped: "",
            nuxes_skipped: "",
          }).toString());
          watched = reelSeenEntries.length;
        } catch (_) { /* best-effort */ }
        return reelSeenEntries.length;
      }, (n) => `Marked ${n} reel${n === 1 ? "" : "s"} as seen`).catch(() => {});
    }

    for (let i = 0; i < toProcess.length; i++) {
      const media = toProcess[i];
      const mediaId = String(media?.id ?? media?.pk ?? "");
      if (!mediaId) continue;

      if (i > 0 && delayMaxSec > 0) {
        const delaySec = delayMinSec + Math.random() * Math.max(0, delayMaxSec - delayMinSec);
        console.log(`[webClient] likeTimelinePosts: waiting ${delaySec.toFixed(1)}s before next like`);
        await new Promise(r => setTimeout(r, Math.round(delaySec * 1000)));
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
            "User-Agent": this._fullMobileUA,
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
          "User-Agent": this._fullMobileUA,
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

  // Send a DM through the warmed IgApiClient (Jarvee cold-start sequence).
  // Using _buildWarmedIgClient() ensures the news.inbox() warm-up has already
  // run before broadcastText is called — this is what lifts the 4415001
  // "Prompt has contribution" gate. A cold fresh IgApiClient (no inbox call)
  // hits 4415001 consistently; the warmed one does not.
  private async _sendDmViaIgClient(userId: string, text: string): Promise<{ threadId: string; itemId: string } | "blocked" | "session_expired" | false> {
    if (!this.igApiCookies) return false;

    // Throttle is enforced at the transport level via _newAutomationIgClient() inside
    // _buildWarmedIgClient() — every ig.request.send call (broadcastText, inbox warm-up)
    // fires apiThrottle() automatically. No manual pre-call needed here.

    // Reuse the cached warmed client — the warm-up (news.inbox) runs once per
    // session and the result is cached in _warmedIgClientCache.  Creating a
    // fresh cold client here (as before) consistently triggered 4415001.
    const warmed = await this._buildWarmedIgClient();
    if (!warmed) {
      console.warn(`[webClient] sendDM ${userId}: _buildWarmedIgClient returned null — falling back to cold client`);
      return false;
    }
    const { ig } = warmed;

    try {
      console.log(`[webClient] sendDM ${userId}: broadcastText via warmed client (uuid=${ig.state.uuid.slice(0,8)}… v${MOBILE_VERSION})`);
      const thread = ig.entity.directThread([userId]);
      const resp = await thread.broadcastText(text) as any;
      const threadId: string = resp?.payload?.thread_id ?? resp?.thread_id ?? "";
      const itemId: string   = resp?.payload?.item_id  ?? resp?.item_id  ?? "";
      console.log(`[webClient] sendDM ${userId}: SUCCESS threadId=${threadId} itemId=${itemId}`);
      return { threadId, itemId };
    } catch (err: any) {
      const msg: string = err?.message ?? String(err);
      const body = err?.response?.body ?? err?.text ?? err?.response?.text;
      console.warn(`[webClient] sendDM ${userId}: error —`, msg);
      if (body) console.warn(`[webClient] sendDM ${userId}: raw body —`, JSON.stringify(body)?.slice(0, 600));
      if (/feedback_required|ActionBlocked/i.test(msg)) return "blocked";
      if (/login_required|Not authorized/i.test(msg))   return "session_expired";
      // 4415001 "Prompt has contribution" — fires when the news.inbox() warm-up
      // did not complete (network/proxy error during warm-up).  Invalidate the
      // warm-up cache so the next sendDM attempt re-runs the full warm-up sequence.
      const bodyCode = (body as any)?.content?.error_code ?? (body as any)?.error_code;
      if (bodyCode === 4415001) {
        console.warn(`[webClient] sendDM ${userId}: 4415001 Prompt has contribution — warm-up may have failed; invalidating cache so next attempt retries warm-up`);
        this._warmedIgClientCache = null;
        return false;
      }
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
        // IgApiClient path failed (warm-up failed or broadcast error).
        // Do NOT fall through to _mobileDmPost — it has no warm-up and will
        // always get 4415001 for the same reason the IgApiClient path failed.
        // Return false so the engine retries next session after warm-up.
        console.warn(`[webClient] sendDM ${userId}: IgApiClient path failed — NOT falling through to _mobileDmPost (warm-up required, will retry next session)`);
        return false;
      }

      // Fallback: hand-rolled mobile POST (only for accounts without igApiCookies)
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
      // 4415001 "Prompt has contribution" — fires when the IgApiClient warm-up
      // did not complete (proxy/network error on news.inbox()).  Invalidate the
      // warm-up cache so the next session retries the full warm-up before DMing.
      if (errorCode === 4415001) {
        console.warn(`[webClient] sendDM ${userId}: 4415001 on mobileDmPost — invalidating warm-up cache for retry next session`);
        this._warmedIgClientCache = null;
        return false;
      }
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
        "User-Agent": this._fullMobileUA,
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
      const j = await this.mobileSessionPost(`/api/v1/direct_v2/threads/${threadId}/items/${itemId}/delete/`, body);
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

  // EB web cookies + mobile app headers → i.instagram.com.
  // NEVER use for session actions — use mobileSessionPost instead.
  private async ebPost(path: string, body = ""): Promise<any> {
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
        "User-Agent": this._fullMobileUA,
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
    if (!res.json) console.log(`[webClient] ebPost ${path} status=${res.status} body(300):`, res.rawBody.slice(0, 300));
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
    //
    // CRITICAL: send ONLY anonymous device cookies (ig_did, mid) — never the
    // sessionid.  fetch_headers is a pre-login signup endpoint; sending a valid
    // sessionid to it tells Instagram "I'm a brand-new installation but I already
    // have an active session", which is a device-spoofing signal and causes account
    // locks.  The response cookies are merged back into the full mobileCookieJar so
    // the sessionid is preserved for subsequent authenticated calls.
    try {
      const guid = randomUUID();
      // Build an anonymous cookie jar: only ig_did + mid, no sessionid
      const igDidCookie = this.mobileCookieJar.find(c => c.startsWith("ig_did="))
        ?? `ig_did=${randomUUID()}`;
      const midCookie   = this.mobileCookieJar.find(c => c.startsWith("mid="))
        ?? `mid=${Buffer.from(randomUUID()).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
      const anonJar = [igDidCookie, midCookie];
      const res = await this.timed("FetchHeaders", () => igReq({
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
        cookieJar: anonJar,
        proxyUrl: this.proxyUrl,
      }), "CSRF bootstrap");
      // Merge response cookies (csrftoken, mid updates, etc.) back into the FULL
      // mobileCookieJar — this preserves the sessionid while adding the new token.
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
      const res = await this.timed("GetCurrentUser", () => igReq({
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
      }), "CSRF bootstrap fallback");
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
    const authorization = this._deviceAuthorization;
    const hasMobileSession = this.mobileCookieJar.some(c => c.startsWith("sessionid=")) || !!authorization;
    if (!hasMobileSession) {
      console.warn(`[webClient] mobileSessionPost ${path}: no igApiCookies session — cannot proceed (igApiCookies required for write actions)`);
      return null;
    }
    // apiThrottle MUST come before _bootstrapMobileCsrf — the bootstrap makes
    // real HTTP requests to Instagram (fetch_headers / current_user) and would
    // bypass the per-account rate limit if called first.
    // If this is the first call after a session restore, mobileCsrf will be the
    // "missing" placeholder. Bootstrap a real token by hitting i.instagram.com
    // directly with the mobile session — no EB cookies involved at any point.
    const _t0 = Date.now();
    await this.apiThrottle();
    if (this.mobileCsrf === "missing" || !this.mobileCsrf) {
      await this._bootstrapMobileCsrf();
    }
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
        ...(authorization ? { Authorization: authorization } : {}),
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
      // If Instagram explicitly rejected the request (4xx/5xx or non-JSON response
      // despite a 200), the session cookies are expired or invalid. Mark the session
      // as needing refresh so the next isMobileLoggedIn() call returns false and the
      // engine surfaces a clear "re-run Verify Credentials" message instead of the
      // cryptic "POST returned null despite session check passing".
      if ((res.status >= 400 || !res.json) && !this._abdDismissInProgress) {
        this.mobileSessionReady = false;
      }
    } else {
      const feedLen = res.json?.feed_items?.length ?? res.json?.items?.length ?? null;
      if (feedLen !== null) {
        console.log(`[webClient] mobileSessionPost ${path} status=${res.status} feed_items=${feedLen} (status="${res.json?.status}")`);
      }
    }
    // Capture feedback_required responses so tryDismissABD() can access the
    // challenge_url without needing it threaded all the way up to the caller.
    if (res.json?.message === "feedback_required" && !this._abdDismissInProgress) {
      this._lastFeedbackResponse = res.json;
    }
    this._logTransport(path, "POST", Date.now() - _t0, res.status >= 400 || !res.json);
    return res.json;
  }

  // ── Jarvee-style "Auto Verify Automatic Behaviour Detected" dismiss ────────
  // When Instagram's server-side bot detector fires a SOFT feedback_required
  // warning (the kind that has an "OK / Dismiss" option), Jarvee would POST
  // choice=0 to the challenge endpoint to acknowledge it and let automation
  // continue without triggering a 24-hour suspension.
  //
  // This is NOT for full security challenges (checkpoint_required, phone/email
  // verify). Those still require the embedded browser. Only soft ABD warnings
  // that include a challenge_url + a dismiss path are handled here.
  //
  // Returns true if the dismiss succeeded (automation can continue),
  // false if not applicable or if Instagram rejected the dismiss.
  async tryDismissABD(): Promise<boolean> {
    const j = this._lastFeedbackResponse;
    if (!j || j?.message !== "feedback_required") return false;
    if (this._abdDismissInProgress) return false;

    const fbTitle: string  = (j?.feedback_title   ?? "").toLowerCase();
    const fbMsg: string    = (j?.feedback_message  ?? "").toLowerCase();
    const ignoreLabel: string = j?.feedback_ignore_label ?? "";

    // Only auto-dismiss "Automated Behavior Detected" family warnings.
    // Hard blocks (spam, phone/email verify required) do NOT qualify.
    const isAutomatedBehavior =
      /automated.?behav|automatic.?behav|unusual.?activ|restrict.*activ|restrict.*communit/i
        .test(fbTitle + " " + fbMsg);

    // Proceed when it's the ABD variant OR there's an explicit "OK/Dismiss" label
    // (Instagram signals a soft/acknowledge-only block by providing feedback_ignore_label).
    if (!isAutomatedBehavior && !ignoreLabel) {
      console.log(`[webClient] @${this.username} ABD: feedback_required is not ABD/dismissible (title="${j?.feedback_title}") — leaving for suspension handler`);
      return false;
    }

    const challengeUrl: string = j?.challenge_url ?? j?.feedback_url ?? "";
    if (!challengeUrl) {
      console.warn(`[webClient] @${this.username} ABD: no challenge_url/feedback_url in response — cannot dismiss`);
      return false;
    }

    console.log(`[webClient] @${this.username} ABD dismiss — title="${j?.feedback_title}" ignore_label="${ignoreLabel}" challenge_url="${challengeUrl}"`);

    // Extract device IDs for the dismiss payload.
    // Instagram's challenge endpoint validates these match the device that triggered the warning.
    let deviceId = "";
    let guid = "";
    if (this.igDeviceState) {
      try {
        const ds = JSON.parse(this.igDeviceState);
        deviceId = ds.deviceId ?? "";
        guid     = ds.uuid     ?? "";
      } catch { /* ignore */ }
    }

    const body = new URLSearchParams({
      challenge_url: challengeUrl,
      choice:        "0",       // "0" = OK / dismiss / "it was me"
      ...(deviceId ? { device_id: deviceId } : {}),
      ...(guid     ? { guid }                : {}),
    }).toString();

    this._abdDismissInProgress = true;
    try {
      const result = await this.mobileSessionPost(`/api/v1/challenge/`, body);
      const ok = result?.status === "ok" || !!result?.logged_in_user || result?.action === "close";
      console.log(`[webClient] @${this.username} ABD dismiss ${ok ? "SUCCESS ✓" : "FAILED ✗"} — ${JSON.stringify(result)?.slice(0, 200)}`);
      if (ok) this._lastFeedbackResponse = null; // clear so stale dismiss isn't reused
      return ok;
    } catch (e: any) {
      console.warn(`[webClient] @${this.username} ABD dismiss exception: ${e?.message}`);
      return false;
    } finally {
      this._abdDismissInProgress = false;
    }
  }

  /**
   * Dismiss path for the 403 login_required ABD variant.
   *
   * When Instagram signals ABD via 403 login_required on social endpoints
   * (rather than feedback_required), there is no challenge_url — tryDismissABD()
   * won't work. This path tries the interstitial-complete endpoint that the
   * native Instagram app calls when the user taps "Dismiss" on the
   * "We suspect automated behavior on your account" screen, then re-probes
   * feed/timeline to confirm whether the block was lifted.
   *
   * Returns true if the block was lifted (timeline returned 200 after the call).
   */
  async tryDismissABD_loginRequired(): Promise<boolean> {
    if (this._abdDismissInProgress) return false;
    this._abdDismissInProgress = true;
    try {
      // Extract identity from stored cookies/device state.
      const cookieParts = (this.igApiCookies ?? "").split(";").map((s: string) => s.trim());
      const userId = cookieParts.find((c: string) => c.startsWith("ds_user_id="))?.split("=")[1] ?? "";
      const cookieCsrf = cookieParts.find((c: string) => c.startsWith("csrftoken="))?.split("=")[1] ?? "";
      const csrf = this.mobileCsrf || cookieCsrf;
      let uuid = "";
      let deviceId = "";
      if (this.igDeviceState) {
        try {
          const ds = JSON.parse(this.igDeviceState);
          uuid = ds?.uuid ?? "";
          deviceId = ds?.deviceId ?? ds?.device_id ?? "";
        } catch { /* ignore */ }
      }

      // ── /api/v1/users/self/banner_dismiss/ ─────────────────────────────
      // This is the real endpoint the native Instagram Android app POSTs to
      // when the user taps "OK / Dismiss" on the "Automated Behaviour Detected"
      // interstitial banner. Confirmed via Android traffic capture — the
      // /qe/dismiss_automatic_behaviour/ path returns 404 HTML (doesn't exist).
      // Body: standard identity params (_uuid, _uid, _csrftoken)
      try {
        const body = new URLSearchParams({
          _uuid: uuid,
          _uid: userId,
          _csrftoken: csrf,
          device_id: deviceId || uuid,
        }).toString();
        const r = await this.mobileSessionPost("/api/v1/users/self/banner_dismiss/", body);
        console.log(`[webClient] @${this.username} ABD dismiss: users/self/banner_dismiss → ${JSON.stringify(r)?.slice(0, 300)}`);
        if (r?.status === "ok") {
          const lifted = await this._probeABD403Lifted();
          if (lifted) return true;
          // Status ok but block not yet lifted — wait briefly and probe again
          await new Promise(res => setTimeout(res, 3000));
          return await this._probeABD403Lifted();
        }
      } catch (e: any) {
        console.warn(`[webClient] @${this.username} ABD dismiss: users/self/banner_dismiss exception: ${e?.message}`);
      }

      // ── Final probe ───────────────────────────────────────────────────
      return await this._probeABD403Lifted();
    } finally {
      this._abdDismissInProgress = false;
    }
  }

  /**
   * Path C ABD dismiss — for hard logout_reason:8 blocks where the session is
   * fully revoked and no feedback_required challenge URL is available via probes.
   *
   * Performs a fresh IgApiClient mobile login (bypassing the igApiCookies fast-path)
   * using the stored device fingerprint. When the account has an ABD checkpoint,
   * Instagram returns IgCheckpointError during login — we extract the challenge URL
   * and dismiss it with choice=0 (the same path SuSocial uses). If login succeeds
   * outright the ABD was already cleared and we save the new session.
   */
  async dismissABD_freshLogin(username: string, password: string): Promise<boolean> {
    if (!password) return false;
    this._abdDismissInProgress = false;

    const ig = newIgClient();
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

    {
      const m = (this.userAgentApi ?? "").match(/^Instagram ([\d.]+) Android \(([^)]+)\)/);
      let version = MOBILE_VERSION, versionCode = MOBILE_VERSION_CODE;
      if (m) {
        const parts = m[2].split(";");
        const vc = parts[parts.length - 1].trim();
        if (/^\d+$/.test(vc)) { version = m[1]; versionCode = vc; }
      }
      ig.state.constants.APP_VERSION      = version;
      ig.state.constants.APP_VERSION_CODE = versionCode;
      patchDeviceStringVersionCode(ig, versionCode);
    }

    if (this.proxyUrl) ig.state.proxyUrl = this.proxyUrl;
    patchIgClientTls(ig, this.proxyUrl);

    try {
      await ig.request.send({ method: "GET", url: "/api/v1/si/fetch_headers/", qs: { challenge_type: "signup", guid: ig.state.uuid } });
    } catch { /* non-fatal */ }
    if (!ig.state.passwordEncryptionPubKey) {
      try {
        await ig.request.send({
          url: "/api/v1/qe/sync/",
          method: "POST",
          form: ig.request.sign({
            id: ig.state.uuid,
            server_config_retrieval: "1",
            _csrftoken: ig.state.cookieCsrfToken,
            _uuid: ig.state.uuid,
          }),
        });
      } catch { /* non-fatal */ }
    }
    if (!ig.state.passwordEncryptionPubKey) {
      console.warn(`[webClient] @${username} ABD freshLogin: could not fetch encryption keys`);
      return false;
    }

    console.log(`[webClient] @${username} ABD freshLogin: attempting fresh mobile login to surface checkpoint`);
    try {
      await ig.account.login(username, password);
      // Login succeeded — ABD cleared. Extract and save the new session.
      console.log(`[webClient] @${username} ABD freshLogin: login OK — ABD appears cleared, saving session`);
      try {
        const raw = await ig.state.serializeCookieJar();
        const jar = typeof raw === "string" ? JSON.parse(raw) : raw;
        const WANTED = new Set(["sessionid", "csrftoken", "ds_user_id", "rur", "mid", "ig_did"]);
        const extracted: string[] = (jar.cookies ?? [])
          .filter((c: any) => WANTED.has(c.key))
          .map((c: any) => `${c.key}=${c.value}`);
        if (extracted.some(c => c.startsWith("sessionid="))) {
          this.mobileCookieJar = extracted;
          const csrfEntry = extracted.find(c => c.startsWith("csrftoken="));
          if (csrfEntry) this.mobileCsrf = csrfEntry.split("=").slice(1).join("=");
          this.mobileSessionReady = true;
        }
      } catch { /* ignore cookie extraction error */ }
      return true;
    } catch (err: any) {
      if (err instanceof IgCheckpointError) {
        // Instagram requires the user to acknowledge the ABD checkpoint.
        // IgCheckpointError.message is the full challenge URL:
        //   "https://i.instagram.com/challenge/12345678/abcXYZ/"
        const fullUrl: string = err.message ?? "";
        const challengeUrl =
          fullUrl.replace("https://i.instagram.com", "") ||
          (err.response?.body?.challenge?.api_path as string | undefined) ||
          (err.response?.body?.checkpoint_url as string | undefined) ||
          "";
        if (!challengeUrl) {
          console.warn(`[webClient] @${username} ABD freshLogin: IgCheckpointError but no challenge URL — body: ${JSON.stringify(err.response?.body ?? {}).slice(0, 300)}`);
          return false;
        }
        console.log(`[webClient] @${username} ABD freshLogin: checkpoint challenge_url="${challengeUrl}" — POSTing choice=0`);
        let deviceId = "", guid = "";
        if (this.igDeviceState) {
          try { const ds = JSON.parse(this.igDeviceState); deviceId = ds.deviceId ?? ""; guid = ds.uuid ?? ""; } catch { /* ignore */ }
        }
        const body = new URLSearchParams({
          challenge_url: challengeUrl,
          choice: "0",
          ...(deviceId ? { device_id: deviceId } : {}),
          ...(guid     ? { guid }                : {}),
        }).toString();
        try {
          const r = await this.mobileSessionPost("/api/v1/challenge/", body);
          console.log(`[webClient] @${username} ABD freshLogin: challenge dismiss → ${JSON.stringify(r)?.slice(0, 300)}`);
          if (r?.status === "ok" || r?.logged_in_user || r?.action === "close") {
            await new Promise(res => setTimeout(res, 2000));
            return await this._probeABD403Lifted();
          }
        } catch (ce: any) {
          console.warn(`[webClient] @${username} ABD freshLogin: challenge dismiss error: ${ce?.message}`);
        }
        return false;
      }
      console.warn(`[webClient] @${username} ABD freshLogin: login error (${err?.constructor?.name}): ${String(err?.message ?? "").slice(0, 200)}`);
      return false;
    }
  }

  /** Re-probe feed/timeline to confirm whether the 403 block was lifted. */
  private async _probeABD403Lifted(): Promise<boolean> {
    try {
      const r = await this.mobileSessionPost(
        "/api/v1/feed/timeline/",
        new URLSearchParams({ reason: "cold_start_fetch" }).toString(),
      );
      const ok = Array.isArray(r?.feed_items) || r?.status === "ok";
      console.log(`[webClient] @${this.username} ABD 403-dismiss re-probe: timeline ${ok ? "UNBLOCKED ✓" : "still blocked ✗"} → ${JSON.stringify(r)?.slice(0, 200)}`);
      return ok;
    } catch (e: any) {
      const sc: number | undefined = (e as any)?.response?.statusCode;
      console.warn(`[webClient] @${this.username} ABD 403-dismiss re-probe: timeline still blocked (${sc ?? "?"}): ${e?.message}`);
      return false;
    }
  }

  /**
   * Manual "Fix ABD" path — probes the mobile API if no feedback_required
   * response is already in memory, then calls tryDismissABD().
   *
   * Handles both ABD variants:
   *   • feedback_required (challenge_url) → tryDismissABD()
   *   • 403 login_required (no challenge_url) → tryDismissABD_loginRequired()
   *
   * Any authenticated mobile POST to an account in ABD state returns
   * {message:"feedback_required"} which mobileSessionPost captures
   * automatically in _lastFeedbackResponse, so the probe populates the
   * field without any special handling.
   */
  async probeAndDismissABD(): Promise<boolean> {
    if (!this._lastFeedbackResponse || this._lastFeedbackResponse.message !== "feedback_required") {
      // Extract identity params needed for a valid qe/sync body.
      // "No ID given" (400) is returned when the body is empty — the session
      // itself IS accepted in ABD state (the probe doesn't 403), so sending
      // the correct params will produce a feedback_required response that
      // contains the challenge_url we need to dismiss with choice=0.
      const cookieParts = (this.igApiCookies ?? "").split(";").map(s => s.trim());
      const userId = cookieParts.find(c => c.startsWith("ds_user_id="))?.split("=")[1] ?? "";
      const cookieCsrf = cookieParts.find(c => c.startsWith("csrftoken="))?.split("=")[1] ?? "";
      const csrf = this.mobileCsrf || cookieCsrf;
      let uuid = "";
      if (this.igDeviceState) {
        try { uuid = JSON.parse(this.igDeviceState)?.uuid ?? ""; } catch { /* ignore */ }
      }

      // Probe 1: qe/sync with proper body — works in ABD state because qe/sync
      // goes through a different auth gate than social endpoints.  ABD accounts
      // get feedback_required (with challenge_url) rather than login_required.
      try {
        const syncBody = new URLSearchParams({
          id: userId,
          _uuid: uuid || userId,
          _uid: userId,
          _csrftoken: csrf,
          experiments: "",
          server_config_retrieval: "1",
        }).toString();
        console.log(`[webClient] @${this.username} ABD probe: qe/sync (id=${userId.slice(0, 6)}...)`);
        await this.mobileSessionPost("/api/v1/qe/sync/", syncBody);
      } catch { /* ignore — we just want _lastFeedbackResponse populated */ }

      // Probe 2: launcher/sync — another low-risk probe that also triggers
      // feedback_required for ABD accounts and is accepted in ABD state.
      if (!this._lastFeedbackResponse || this._lastFeedbackResponse.message !== "feedback_required") {
        try {
          const launchBody = new URLSearchParams({
            id: userId,
            _uuid: uuid || userId,
            _uid: userId,
            _csrftoken: csrf,
            configs: "ig_android_felix_release_players,ig_android_ad_async_ads_universe",
          }).toString();
          console.log(`[webClient] @${this.username} ABD probe: launcher/sync`);
          await this.mobileSessionPost("/api/v1/launcher/sync/", launchBody);
        } catch { /* ignore */ }
      }
    }

    // Path A: feedback_required with challenge_url → dismiss via /api/v1/challenge/ choice=0
    if (this._lastFeedbackResponse?.message === "feedback_required") {
      console.log(`[webClient] @${this.username} ABD: got feedback_required — trying tryDismissABD (challenge choice=0)`);
      const ok = await this.tryDismissABD();
      if (ok) return true;
    }

    // Path B: 403 login_required pattern (qe/sync probes didn't yield challenge_url)
    // tryDismissABD_loginRequired tries the banner_dismiss endpoint as a last resort.
    console.log(`[webClient] @${this.username} ABD: no feedback_required response from probes — trying 403-pattern dismiss`);
    return this.tryDismissABD_loginRequired();
  }

  // ── Multipart/form-data POST to i.instagram.com ──────────────────────────
  // Used for photo upload via /api/v1/media/upload/ — a regular /api/v1/
  // path that accepts our web-session cookies (same auth as like/follow/
  // comment which are confirmed working).  Avoids the rupload binary protocol
  // which requires a genuine mobile Bearer-token session and rejects web
  // sessionids with HTML 404.
  private async mobilePostMultipart(path: string, parts: Array<{ name: string; value: string | Buffer; filename?: string; contentType?: string }>): Promise<any> {
    const authorization = this._deviceAuthorization;
    const hasMobileSession = this.mobileCookieJar.some(c => c.startsWith("sessionid=")) || !!authorization;
    if (!hasMobileSession) {
      console.warn(`[webClient] mobilePostMultipart ${path}: no mobile session — run Verify Credentials first`);
      return null;
    }
    // apiThrottle MUST come before _bootstrapMobileCsrf — the bootstrap makes
    // real HTTP requests to Instagram and would bypass the rate limit if called first.
    await this.apiThrottle();
    if (!this.mobileCsrf) {
      await this._bootstrapMobileCsrf();
    }
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

    const csrf = this.mobileCsrf || this.csrfToken;
    const headers: Record<string, string> = {
      "User-Agent": this._fullMobileUA,
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length),
      "X-IG-App-ID": MOBILE_AID,
      "X-CSRFToken": csrf,
      "X-IG-Capabilities": "3brTvwE=",
      "X-IG-Connection-Type": "WIFI",
      Cookie: this.mobileCookieJar.join("; "),
      ...(authorization ? { Authorization: authorization } : {}),
    };

    console.log(`[webClient] mobilePostMultipart ${path} bodySize=${body.length}B csrf=${csrf.slice(0,8)}... sessionid=${this.mobileCookieJar.find(c => c.startsWith("sessionid=")) ? "present" : "MISSING"}`);
    const { json } = await tlsMultipartPost("i.instagram.com", path, headers, body, this.proxyUrl);
    if (!json) {
      console.warn(`[webClient] mobilePostMultipart ${path} returned null — upload may have failed (no JSON in response)`);
    } else {
      console.log(`[webClient] mobilePostMultipart ${path} → status="${json.status ?? "?"}" upload_id="${json.upload_id ?? "none"}"`);
    }
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


  // ── Rupload binary — common helper for photo and video uploads ────────────
  // Uses Instagram's rupload protocol (Content-Type: application/octet-stream)
  // to /rupload_igphoto/{name} or /rupload_igvideo/{name}.
  // This is the only supported upload protocol for the mobile private API.
  // The old /api/v1/media/upload/ multipart endpoint does not exist and
  // returns a non-JSON HTML error page.
  private async _mobileRupload(
    mediaType: "photo" | "video",
    buffer: Buffer,
    uploadId: string,
    sharedAgent?: any,
  ): Promise<string | null> {
    const TAG = `[UPLOAD:rupload @${this.username ?? this.profileId}]`;
    const authorization = this._deviceAuthorization;
    const hasMobileSession = this.mobileCookieJar.some(c => c.startsWith("sessionid=")) || !!authorization;

    // ── PRE-FLIGHT ────────────────────────────────────────────────────────────
    console.log(`${TAG} ── RUPLOAD PRE-FLIGHT ────────────────────────────────`);
    console.log(`${TAG}   mediaType=${mediaType} uploadId=${uploadId} bufSize=${buffer.length}B (${(buffer.length/1024).toFixed(1)}KB)`);
    console.log(`${TAG}   hasMobileSession=${hasMobileSession} (sessionid=${this.mobileCookieJar.some(c => c.startsWith("sessionid=")) ? "✓" : "✗"} authorization=${authorization ? "✓" : "✗"})`);
    console.log(`${TAG}   mobileCookieJar cookies: [${this.mobileCookieJar.map(c => c.split("=")[0]).join(", ")}]`);
    const hasRur = this.mobileCookieJar.some(c => c.startsWith("rur="));
    const hasCsrfJar = this.mobileCookieJar.some(c => c.startsWith("csrftoken="));
    console.log(`${TAG}   rur=${hasRur ? "✓ present" : "✗ MISSING (will get from response)"} csrftoken=${hasCsrfJar ? "✓" : "✗"} mobileCsrf=${this.mobileCsrf ? `"${this.mobileCsrf.slice(0,8)}…"` : "null"}`);
    console.log(`${TAG}   proxyUrl=${this.proxyUrl ?? "NONE (direct)"}`);

    if (!hasMobileSession) {
      console.error(`${TAG} ABORT — no mobile session. Run Verify Credentials first (needs sessionid in mobileCookieJar or Authorization header).`);
      return null;
    }

    // apiThrottle MUST come before _bootstrapMobileCsrf — the bootstrap makes
    // real HTTP requests to Instagram and would bypass the rate limit if called first.
    await this.apiThrottle();
    if (!this.mobileCsrf) {
      console.log(`${TAG} mobileCsrf missing — calling _bootstrapMobileCsrf()`);
      await this._bootstrapMobileCsrf();
      console.log(`${TAG} after bootstrap: mobileCsrf=${this.mobileCsrf ? `"${this.mobileCsrf.slice(0,8)}…"` : "STILL NULL"}`);
    }

    const suffix = `${uploadId}_0_${Math.floor(Math.random() * 9000000000) + 1000000000}`;
    const isPhoto = mediaType === "photo";
    const entityType = isPhoto ? "image/jpeg" : "video/mp4";
    const ruploadPath = isPhoto ? `/rupload_igphoto/${suffix}` : `/rupload_igvideo/${suffix}`;
    const waterfallHeader = isPhoto ? "X_FB_PHOTO_WATERFALL_ID" : "X_FB_VIDEO_WATERFALL_ID";
    // ATTEMPT 4 (2026-06-26): Removed image_compression from rupload params.
    // Reason: when image_compression: {lib_name:"moz"} is present, Instagram's
    // rupload transcoder attempts to apply MozJPEG decompression to the payload.
    // If the uploaded JPEG was not produced by MozJPEG (even after re-encoding via
    // sharp), the transcoder silently stores the upload on a different internal path
    // and configure cannot locate it → "upload id is missing" (500).
    // Real Instagram Android clients omit this param when using the standard JPEG
    // encoder — we mirror that behaviour here.
    // Log first 4 bytes of the buffer to verify JPEG magic (0xFF 0xD8 0xFF).
    const magic4 = buffer.slice(0, 4).toString("hex").toUpperCase();
    console.log(`${TAG}   Buffer first 4 bytes (hex): ${magic4} — JPEG=${magic4.startsWith("FFD8FF") ? "✓" : "✗ NOT JPEG — possible format issue"}`);
    const ruploadParamsObj = {
      retry_context: JSON.stringify({ num_step_auto_retry: 0, num_reupload: 0, num_step_manual_retry: 0 }),
      media_type: isPhoto ? "1" : "2",
      upload_id: uploadId,
      xsharing_user_ids: JSON.stringify([]),
      // image_compression intentionally omitted — see ATTEMPT 4 note above.
    };
    const ruploadParams = JSON.stringify(ruploadParamsObj);

    const csrf = this.mobileCsrf || this.csrfToken;
    const waterfallId = randomUUID();
    const headers: Record<string, string> = {
      "User-Agent": this._fullMobileUA,
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      [waterfallHeader]: waterfallId,
      "X-Entity-Type": entityType,
      "Offset": "0",
      "X-Instagram-Rupload-Params": ruploadParams,
      "X-Entity-Name": suffix,
      "X-Entity-Length": String(buffer.length),
      "Content-Type": "application/octet-stream",
      "Content-Length": String(buffer.length),
      "X-IG-App-ID": MOBILE_AID,
      "X-CSRFToken": csrf,
      "X-IG-Capabilities": "3brTvwE=",
      "X-IG-Connection-Type": "WIFI",
      Cookie: this.mobileCookieJar.join("; "),
      ...(authorization ? { Authorization: authorization } : {}),
    };

    const proxyHost = this.proxyUrl ? (() => { try { return new URL(this.proxyUrl).host; } catch { return this.proxyUrl; } })() : "none";
    console.log(`${TAG} ── RUPLOAD REQUEST ───────────────────────────────────`);
    console.log(`${TAG}   POST i.instagram.com${ruploadPath}`);
    console.log(`${TAG}   X-Entity-Name: ${suffix}`);
    console.log(`${TAG}   X-Entity-Length: ${buffer.length}`);
    console.log(`${TAG}   X-Entity-Type: ${entityType}`);
    console.log(`${TAG}   ${waterfallHeader}: ${waterfallId}`);
    console.log(`${TAG}   X-IG-App-ID: ${MOBILE_AID}`);
    console.log(`${TAG}   X-CSRFToken: ${csrf?.slice(0,8)}… (length=${csrf?.length ?? 0})`);
    console.log(`${TAG}   X-Instagram-Rupload-Params: ${ruploadParams}`);
    console.log(`${TAG}   Authorization: ${authorization ? authorization.slice(0,20)+"…" : "NONE"}`);
    console.log(`${TAG}   Cookie count: ${this.mobileCookieJar.length} proxy=${proxyHost}`);

    let json: any;
    let ruploadCookies: string[] = [];
    try {
      // Node.js HTTPS (forceNodeHttps=true) is REQUIRED for binary uploads.
      // CycleTLS serialises the body through JSON, re-encoding Latin-1 bytes > 127
      // as multi-byte UTF-8 sequences — this corrupts the JPEG/MP4 buffer and causes
      // Instagram to return ProcessingFailedError (retriable:false) at the rupload step.
      // Node.js req.write(Buffer) sends raw bytes without any re-encoding.
      // Shard routing (the old reason to match TLS stacks) is handled by the rur cookie
      // injected from the browser session into mobileCookieJar before this call —
      // both rupload and configure send that cookie and land on the same backend shard.
      // NOTE: we post via the mobile private API only. The embedded browser is NEVER
      // used as an upload path — the EB exists solely for session establishment and
      // challenge recovery, not for automated posting actions.
      ({ json, cookies: ruploadCookies } = await tlsMultipartPost("i.instagram.com", ruploadPath, headers, buffer, this.proxyUrl, true, sharedAgent));
    } catch (netErr: any) {
      console.error(`${TAG} ✗ NETWORK ERROR during rupload: ${netErr?.message ?? netErr}`);
      if (netErr?.message?.includes("ECONNREFUSED")) console.error(`${TAG}   ► Proxy refused connection or Instagram unreachable`);
      if (netErr?.message?.includes("ETIMEDOUT"))    console.error(`${TAG}   ► Connection timed out — proxy too slow or blocked`);
      if (netErr?.message?.includes("ENOTFOUND"))    console.error(`${TAG}   ► DNS resolution failed for i.instagram.com`);
      if (netErr?.message?.includes("SSL") || netErr?.message?.includes("TLS")) {
        console.error(`${TAG}   ► TLS error — proxy cert rejected or fingerprint issue`);
      }
      console.error(`${TAG}   Stack: ${(netErr?.stack ?? "").split("\n").slice(0,4).join(" | ")}`);
      return null;
    }

    console.log(`${TAG} ── RUPLOAD RESPONSE ──────────────────────────────────`);
    console.log(`${TAG}   Set-Cookie from response: [${ruploadCookies.map(c => c.split("=")[0]).join(", ")}]`);
    if (!json) {
      console.error(`${TAG} ✗ Response body is null/empty (non-JSON). Instagram may have returned HTML error page.`);
      console.error(`${TAG}   ► Possible causes: session expired (401), rate limited (429), or endpoint URL changed`);
      return null;
    }
    console.log(`${TAG}   Response JSON: ${JSON.stringify(json).slice(0, 600)}`);

    if (json.status !== "ok") {
      console.error(`${TAG} ✗ Rupload status="${json.status ?? "null"}" — upload_id="${json.upload_id ?? "none"}"`);
      const msg = json?.message ?? json?.error_type ?? "unknown";
      console.error(`${TAG}   message/error_type: "${msg}"`);
      if (json.status === "fail" && json.message?.includes("login")) {
        console.error(`${TAG}   ► DIAGNOSIS: Not authenticated. sessionid cookie is invalid or expired.`);
      } else if (json.status === "fail") {
        console.error(`${TAG}   ► DIAGNOSIS: Rupload rejected by Instagram. Full response: ${JSON.stringify(json).slice(0, 400)}`);
      }
      return null;
    }

    // Capture rur (shard-routing cookie) — CRITICAL for configure to land on same shard.
    // ALWAYS overwrite: the rupload response may return a DIFFERENT rur than what was
    // in the jar (Instagram re-assigns the shard based on the actual upload destination).
    // Keeping the old stale rur causes configure to hit the wrong shard → "upload id is missing".
    const rurFromRupload = ruploadCookies.find(c => c.startsWith("rur="));
    if (rurFromRupload) {
      const oldRur = this.mobileCookieJar.find(c => c.startsWith("rur=")) ?? "(none)";
      this.mobileCookieJar = this.mobileCookieJar.filter(c => !c.startsWith("rur="));
      this.mobileCookieJar = [...this.mobileCookieJar, rurFromRupload];
      console.log(`${TAG} ✓ rur updated from rupload response (old=${oldRur.slice(0,20)} new=${rurFromRupload.slice(0,40)}…)`);
    } else {
      console.warn(`${TAG}   ⚠ No rur in rupload Set-Cookie — shared agent is the shard-routing safety net`);
      console.warn(`${TAG}     Response Set-Cookie headers: [${ruploadCookies.join(" | ")}]`);
    }

    const confirmedId = String(json.upload_id ?? uploadId);
    console.log(`${TAG} ✓ Rupload OK — confirmed upload_id="${confirmedId}"`);
    return confirmedId;
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

      const j = await this.mobileSessionGet(`/api/v1/feed/user/${user.pk}/?count=12`);
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

  // ── Configure (publish) a media upload — SAME Node.js HTTPS stack as rupload ──
  // ROOT CAUSE of "upload id is missing" (confirmed from production logs v1.1.56):
  //   rupload uses tlsMultipartPost(forceNodeHttps=true) → Node.js HTTPS / OpenSSL TLS.
  //   configure was using mobileSessionPost → igReq → CycleTLS (OkHttp4 JA3).
  //   Instagram links the upload to the exact TLS session that performed it.
  //   A configure arriving via a DIFFERENT TLS fingerprint cannot find the upload
  //   and returns the misleading "upload id is missing" HTTP 500.
  //   This is NOT about the upload_id value — the upload truly succeeded. The
  //   configure just can't match it because the fingerprint differs.
  //
  // Parses manufacturer/model/android version from the full mobile UA string.
  // UA format: "Instagram X.X Android (33/13; 500dpi; 1440x3088; Samsung; SM-G975U; ...)"
  private _parseUADeviceInfo(): { manufacturer: string; model: string; androidVersion: number; androidRelease: string } {
    const fallback = { manufacturer: "samsung", model: "SM-A515F", androidVersion: 33, androidRelease: "13" };
    try {
      const inner = /\(([^)]+)\)/.exec(this._fullMobileUA)?.[1];
      if (!inner) return fallback;
      const parts = inner.split(";").map(s => s.trim());
      const avParts = (parts[0] ?? "").split("/");
      const androidVersion = parseInt(avParts[0] ?? "33", 10) || 33;
      const androidRelease = avParts[1]?.trim() || "13";
      const manufacturer  = parts[3]?.trim() || "samsung";
      const model         = parts[4]?.trim() || "SM-A515F";
      return { manufacturer, model, androidVersion, androidRelease };
    } catch {
      return fallback;
    }
  }

  private async _configureViaIgClient(
    uploadId: string,
    caption: string,
    isVideo: boolean,
    imgBuffer?: Buffer,
    sharedAgent?: any,
  ): Promise<string | null> {
    const TAG = `[UPLOAD:configure @${this.username ?? this.profileId}]`;
    console.log(`${TAG} ── CONFIGURE PRE-FLIGHT ──────────────────────────────`);
    console.log(`${TAG}   uploadId=${uploadId} isVideo=${isVideo} captionLen=${caption?.length ?? 0}`);

    if (!this.igApiCookies) {
      console.error(`${TAG} ABORT — igApiCookies is null. Cannot build signed body without csrftoken/ds_user_id.`);
      return null;
    }

    // Extract identity fields
    const pairs = this.igApiCookies.split(";").map(s => s.trim()).filter(Boolean);
    const ownUserId = pairs.find(p => p.startsWith("ds_user_id="))?.split("=")[1] ?? "";
    if (!ownUserId) console.error(`${TAG} ✗ ds_user_id is empty — _uid field will be blank, Instagram will reject`);

    let uuid = "";
    let deviceId = "";
    if (this.igDeviceState) {
      try {
        const saved = JSON.parse(this.igDeviceState) as { uuid?: string; deviceId?: string };
        uuid = saved.uuid ?? "";
        deviceId = saved.deviceId ?? "";
        console.log(`${TAG}   uuid from igDeviceState: ${uuid ? uuid.slice(0,8)+"…" : "MISSING"}`);
        console.log(`${TAG}   deviceId from igDeviceState: ${deviceId || "MISSING"}`);
      } catch (e: any) {
        console.error(`${TAG}   igDeviceState parse error: ${e?.message}`);
      }
    }
    if (!uuid) {
      uuid = this._mobileIgDid ?? randomUUID();
      console.warn(`${TAG}   ⚠ uuid not in igDeviceState — using _mobileIgDid/random: ${uuid.slice(0,8)}…`);
    }
    if (!deviceId) {
      deviceId = `android-${(this._mobileMid ?? randomUUID()).replace(/-/g, "").slice(0, 16)}`;
      console.warn(`${TAG}   ⚠ deviceId not in igDeviceState — using derived: ${deviceId}`);
    }

    if (this.mobileCsrf === "missing" || !this.mobileCsrf) {
      console.log(`${TAG}   mobileCsrf missing — bootstrapping...`);
      await this._bootstrapMobileCsrf();
      console.log(`${TAG}   after bootstrap: mobileCsrf=${this.mobileCsrf ? `"${this.mobileCsrf.slice(0,8)}…"` : "STILL NULL"}`);
    }
    const csrf = this.mobileCsrf || this.csrfToken || "";
    if (!csrf) console.error(`${TAG} ✗ csrf is empty string — X-CSRFToken will be blank, configure WILL fail`);

    // Image dimensions
    let imgWidth  = 1080;
    let imgHeight = 1350;
    if (imgBuffer && !isVideo) {
      try {
        const sharpMod = await import("sharp").then(m => m.default).catch(() => null);
        if (sharpMod) {
          const meta = await sharpMod(imgBuffer).metadata();
          if (meta.width)  imgWidth  = meta.width;
          if (meta.height) imgHeight = meta.height;
          console.log(`${TAG}   Image dimensions from sharp: ${imgWidth}x${imgHeight} format=${meta.format} channels=${meta.channels}`);
          const ratio = imgWidth / imgHeight;
          if (ratio < 0.8 || ratio > 1.91) {
            console.error(`${TAG}   ✗ Aspect ratio ${ratio.toFixed(3)} is OUT OF RANGE [0.8–1.91] — configure will likely be rejected`);
          } else {
            console.log(`${TAG}   Aspect ratio ${ratio.toFixed(3)} ✓ (valid range 0.8–1.91)`);
          }
        } else {
          console.warn(`${TAG}   sharp not available — using default dims ${imgWidth}x${imgHeight}`);
        }
      } catch (e: any) {
        console.warn(`${TAG}   sharp metadata error (using defaults): ${e?.message}`);
      }
    }

    const devInfo = this._parseUADeviceInfo();
    console.log(`${TAG}   device: ${devInfo.manufacturer} ${devInfo.model} Android ${devInfo.androidVersion}/${devInfo.androidRelease}`);

    // X-IG-WWW-Claim: Instagram does not return x-ig-www-claim in GET response
    // headers when accessed through this session type (confirmed across multiple
    // endpoints). Sending the header with value "0" for write operations triggers
    // a 500 from Instagram's media publish endpoint. mobileSessionPost (which
    // handles all other working mobile API calls: follow, DM, timeline) does NOT
    // send X-IG-WWW-Claim at all — we mirror that behaviour here.
    console.log(`${TAG}   mobileCookieJar rur=${this.mobileCookieJar.some(c => c.startsWith("rur=")) ? "✓ (from rupload response)" : "✗ absent — mobile API routes by session"}`);
    console.log(`${TAG}   proxyUrl=${this.proxyUrl ?? "NONE (direct)"}`);

    const url = isVideo ? "/api/v1/media/configure/?video=1" : "/api/v1/media/configure/";
    const MOBILE_APP_ID = "567067343352427";

    const now = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const nowFormatted = `${now.slice(0,4)}:${now.slice(4,6)}:${now.slice(6,8)} ${now.slice(8,10)}:${now.slice(10,12)}:${now.slice(12,14)}`;

    let bodyObj: Record<string, any>;
    if (!isVideo) {
      bodyObj = {
        _uuid:                        uuid,
        _uid:                         ownUserId,
        _csrftoken:                   csrf,
        upload_id:                    uploadId,
        source_type:                  "4",
        caption:                      caption ?? "",
        media_folder:                 "Camera",
        timezone_offset:              "0",
        date_time_original:           nowFormatted,
        date_time_digitalized:        nowFormatted,
        scene_capture_type:           "standard",
        camera_model:                 devInfo.model,
        camera_make:                  devInfo.manufacturer,
        software:                     "1",
        device_id:                    deviceId,
        creation_logger_session_id:   randomUUID(),
        width:                        imgWidth,
        height:                       imgHeight,
        edits:                        {
          crop_original_size: [imgWidth, imgHeight],
          crop_center:        [0.0, -0.0],
          crop_zoom:          1.0,
        },
      };
    } else {
      bodyObj = {
        _uuid:                        uuid,
        _uid:                         ownUserId,
        _csrftoken:                   csrf,
        upload_id:                    uploadId,
        source_type:                  "4",
        caption:                      caption ?? "",
        timezone_offset:              "0",
        date_time_original:           nowFormatted,
        media_type:                   "2",
        clips_share_preview_to_feed:  "1",
        device_id:                    deviceId,
        creation_logger_session_id:   randomUUID(),
      };
    }

    const bodyStr = signBody(bodyObj);
    console.log(`${TAG} ── CONFIGURE REQUEST ─────────────────────────────────`);
    console.log(`${TAG}   POST i.instagram.com${url}`);
    console.log(`${TAG}   Signed body fields: [${Object.keys(bodyObj).join(", ")}]`);
    console.log(`${TAG}   Body preview (first 400 chars): ${bodyStr.slice(0, 400)}`);
    console.log(`${TAG}   upload_id in body: "${uploadId}"`);
    console.log(`${TAG}   _uid: "${ownUserId || "EMPTY"}" _csrftoken: "${csrf.slice(0,8)}…" _uuid: "${uuid.slice(0,8)}…"`);
    // forceNodeTls=true MUST match rupload's TLS stack (tlsMultipartPost also
    // uses forceNodeTls=true / Node.js HTTPS). Instagram routes rupload and
    // configure to the same backend shard based on the TLS fingerprint + session.
    // Using CycleTLS for configure while rupload uses Node.js causes
    // "upload id is missing" (500) because configure lands on a different shard
    // that has no record of the rupload. Confirmed on @anais.23164 v1.1.110.
    const authorization = this._deviceAuthorization;
    console.log(`${TAG}   Cookie count: ${this.mobileCookieJar.length} auth=${authorization ? "✓ Bearer" : "✗ none"} TLS=NodeHTTPS(mustMatchRupload) sharedAgent=${sharedAgent ? "✓" : "✗"}`);

    let res: any;
    try {
      res = await igReq({
        host: "i.instagram.com",
        path: url,
        method: "POST",
        headers: {
          Host: "i.instagram.com",
          "User-Agent": this._fullMobileUA,
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
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: bodyStr,
        cookieJar: this.mobileCookieJar,
        proxyUrl: this.proxyUrl,
        // Node.js HTTPS (forceNodeTls=true) — must match rupload's TLS stack (also Node.js HTTPS).
        // agentOverride shares the same HttpsProxyAgent (proxy tunnel) with rupload so
        // Instagram routes configure to the exact same backend shard as the rupload.
        forceNodeTls: true,
        agentOverride: sharedAgent,
      });
    } catch (netErr: any) {
      console.error(`${TAG} ✗ NETWORK ERROR during configure: ${netErr?.message ?? netErr}`);
      console.error(`${TAG}   Stack: ${(netErr?.stack ?? "").split("\n").slice(0,4).join(" | ")}`);
      this._lastConfigureError = `Network error: ${netErr?.message}`;
      return null;
    }

    // Merge any new cookies
    if (res.cookies?.length) {
      this.mobileCookieJar = mergeCookies(this.mobileCookieJar, res.cookies);
      const newCsrf = extractCsrf(res.cookies);
      if (newCsrf) this.mobileCsrf = newCsrf;
    }

    console.log(`${TAG} ── CONFIGURE RESPONSE ────────────────────────────────`);
    console.log(`${TAG}   HTTP status: ${res.status}`);
    console.log(`${TAG}   Response Set-Cookie: [${(res.cookies ?? []).map((c: string) => c.split("=")[0]).join(", ")}]`);

    const json = res.json;
    if (!json) {
      const raw = res.rawBody?.slice(0, 800) ?? "(no body)";
      this._lastConfigureError = `HTTP ${res.status}: non-JSON response`;
      console.error(`${TAG} ✗ Non-JSON response (HTTP ${res.status}). Raw body: ${raw}`);
      if (res.status === 403) console.error(`${TAG}   ► DIAGNOSIS: 403 Forbidden — CSRF mismatch or session expired`);
      if (res.status === 401) console.error(`${TAG}   ► DIAGNOSIS: 401 Unauthorized — sessionid invalid`);
      if (res.status === 429) console.error(`${TAG}   ► DIAGNOSIS: 429 Rate Limited`);
      if (res.status === 500) console.error(`${TAG}   ► DIAGNOSIS: 500 Server Error — often "upload id is missing" (shard mismatch) or bad signed body`);
      if (raw.includes("<html"))  console.error(`${TAG}   ► Got HTML page instead of JSON — Instagram redirected to login or error page`);
      return null;
    }

    console.log(`${TAG}   Response JSON: ${JSON.stringify(json).slice(0, 800)}`);

    if (json?.media?.id) {
      const mediaId = String(json.media.id);
      console.log(`${TAG} ✓ SUCCESS — media_id=${mediaId}`);
      return mediaId;
    }
    if (json?.status === "ok") {
      console.log(`${TAG} ✓ status=ok (no media.id) — returning uploadId=${uploadId}`);
      return uploadId;
    }

    // Failed — extract all diagnostic info
    const errMsg   = json?.message ?? "";
    const errType  = json?.error_type ?? "";
    const errTitle = json?.feedback_title ?? "";
    const errUrl   = json?.feedback_url ?? "";
    this._lastConfigureError = errMsg || errType || `HTTP ${res.status}`;

    console.error(`${TAG} ✗ Configure FAILED (HTTP ${res.status})`);
    console.error(`${TAG}   status: "${json?.status}" message: "${errMsg}" error_type: "${errType}"`);
    if (errTitle) console.error(`${TAG}   feedback_title: "${errTitle}"`);
    if (errUrl)   console.error(`${TAG}   feedback_url: "${errUrl}"`);
    console.error(`${TAG}   Full response: ${JSON.stringify(json).slice(0, 800)}`);

    // ── Known configure error patterns ──────────────────────────────────────
    if (errMsg.includes("upload id") || errMsg.includes("upload_id")) {
      console.error(`${TAG}   ► DIAGNOSIS: "upload id is missing" — rupload succeeded but configure cannot find it.`);
      console.error(`${TAG}     Cause 1: TLS stack mismatch (rupload used Node.js HTTPS, configure used CycleTLS)`);
      console.error(`${TAG}     Cause 2: rur cookie was missing → configure landed on different Instagram shard`);
      console.error(`${TAG}     Cause 3: uploadId expired (configure called too long after rupload)`);
      console.error(`${TAG}     Cause 4: image_compression rupload header triggered server-side MozJPEG path that stores upload on different internal key`);
      console.error(`${TAG}     rur in mobileCookieJar: ${this.mobileCookieJar.some(c => c.startsWith("rur=")) ? "✓ present" : "✗ MISSING"}`);
      console.error(`${TAG}     → ATTEMPT 4 fix: image_compression removed from rupload. If still failing, check image magic bytes in rupload log.`);
    } else if (errMsg.includes("not_authorized") || res.status === 403) {
      console.error(`${TAG}   ► DIAGNOSIS: not_authorized. Possible CSRF token mismatch.`);
      console.error(`${TAG}     csrf used: "${csrf.slice(0,12)}…" expected to match csrftoken in cookie jar`);
      const jarCsrf = this.mobileCookieJar.find(c => c.startsWith("csrftoken="))?.split("=")?.[1];
      console.error(`${TAG}     csrftoken in mobileCookieJar: "${jarCsrf?.slice(0,12) ?? "MISSING"}…"`);
      if (jarCsrf && jarCsrf !== csrf) console.error(`${TAG}     ✗ MISMATCH — mobileCsrf field="${csrf.slice(0,12)}…" vs jar="${jarCsrf.slice(0,12)}…"`);
    } else if (errMsg.includes("login_required") || res.status === 401) {
      console.error(`${TAG}   ► DIAGNOSIS: login_required. sessionid is invalid or expired. Re-verify account.`);
    } else if (errType === "sentry_block" || errMsg.includes("feedback_required")) {
      console.error(`${TAG}   ► DIAGNOSIS: Account is flagged/restricted. feedback_title="${errTitle}" feedback_url="${errUrl}"`);
    } else if (errMsg.includes("media_not_found") || errType === "media_not_found") {
      console.error(`${TAG}   ► DIAGNOSIS: media_not_found — rupload ID unknown to this shard. Missing rur cookie.`);
    } else if (errMsg.includes("sorry") || errMsg.includes("something went wrong")) {
      console.error(`${TAG}   ► DIAGNOSIS: Generic IG error. Possible unsigned body, wrong signed body format, or image rejection.`);
    } else if (res.status === 400) {
      console.error(`${TAG}   ► DIAGNOSIS: HTTP 400 — required field missing or malformed in signed body.`);
      console.error(`${TAG}     Check: _uid="${ownUserId}" _uuid="${uuid.slice(0,8)}" upload_id="${uploadId}" csrf="${csrf.slice(0,8)}"`);
    }

    return null;
  }

  // ── Publish a photo via IgApiClient (Jarvee model) ───────────────────────
  // Uses ig.publish.photo() which handles BOTH upload and configure through
  // the library's native HTTP client with properly signed bodies (HMAC-SHA256).
  // This is the correct Jarvee/SucoAI approach: both steps use the same client,
  // same TLS stack, same session — so Instagram can match the upload at configure time.
  //
  // The previous hand-rolled split (tlsMultipartPost rupload + igReq configure)
  // failed with "something went wrong during media publish" because the unsigned
  // URLSearchParams body is rejected for write actions — the same root cause
  // that was already fixed for follow/like by switching to IgApiClient.
  private async _publishViaIgClient(imageBuffer: Buffer, caption: string): Promise<string | null> {
    const TAG = `[UPLOAD:igClient @${this.username ?? this.profileId}]`;

    // ── PRE-FLIGHT: dump full session state ──────────────────────────────────
    if (!this.igApiCookies) {
      console.error(`${TAG} ABORT — igApiCookies is null/empty. Account must be verified first.`);
      return null;
    }

    const igCookiePairs = this.igApiCookies.split(";").map(s => s.trim()).filter(Boolean);
    const cookieKeys = igCookiePairs.map(p => p.split("=")[0]);
    const hasSessionid  = cookieKeys.includes("sessionid");
    const hasCsrftoken  = cookieKeys.includes("csrftoken");
    const hasDsUserId   = cookieKeys.includes("ds_user_id");
    const hasMid        = cookieKeys.includes("mid");
    const hasIgDid      = cookieKeys.includes("ig_did");
    console.log(`${TAG} ── SESSION STATE ──────────────────────────────────────`);
    console.log(`${TAG}   igApiCookies keys present: [${cookieKeys.join(", ")}]`);
    console.log(`${TAG}   sessionid=${hasSessionid ? "✓" : "✗MISSING"} csrftoken=${hasCsrftoken ? "✓" : "✗MISSING"} ds_user_id=${hasDsUserId ? "✓" : "✗MISSING"} mid=${hasMid ? "✓" : "✗MISSING"} ig_did=${hasIgDid ? "✓" : "✗MISSING"}`);
    if (!hasSessionid) console.error(`${TAG} ✗ NO sessionid in igApiCookies — upload will fail with 403/401`);
    if (!hasCsrftoken) console.error(`${TAG} ✗ NO csrftoken in igApiCookies — configure will fail`);
    if (!hasDsUserId)  console.error(`${TAG} ✗ NO ds_user_id in igApiCookies — _uid field will be empty`);

    console.log(`${TAG}   mobileCookieJar (${this.mobileCookieJar.length} cookies): [${this.mobileCookieJar.map(c => c.split("=")[0]).join(", ")}]`);
    console.log(`${TAG}   igDeviceState present: ${!!this.igDeviceState}`);
    if (this.igDeviceState) {
      try {
        const ds = JSON.parse(this.igDeviceState) as Record<string, string>;
        console.log(`${TAG}   igDeviceState keys: [${Object.keys(ds).join(", ")}]`);
        if (ds.uuid)      console.log(`${TAG}   uuid=${ds.uuid.slice(0,8)}…`);
        if (ds.deviceId)  console.log(`${TAG}   deviceId=${ds.deviceId}`);
        if (ds.phoneId)   console.log(`${TAG}   phoneId=${ds.phoneId?.slice(0,8)}…`);
        if (ds.igDid)     console.log(`${TAG}   igDid=${ds.igDid?.slice(0,8)}…`);
        if (ds.authorization) console.log(`${TAG}   authorization=${ds.authorization.slice(0,20)}…`);
        if (!ds.uuid)     console.warn(`${TAG}   ⚠ no uuid in igDeviceState — will use random`);
      } catch (e: any) {
        console.error(`${TAG}   igDeviceState parse failed: ${e?.message}`);
      }
    } else {
      console.warn(`${TAG}   ⚠ no igDeviceState — device IDs will be freshly generated (fingerprint mismatch risk)`);
    }
    console.log(`${TAG}   proxyUrl=${this.proxyUrl ?? "NONE (direct)"}`);
    console.log(`${TAG}   imageBuffer size=${imageBuffer.length}B (${(imageBuffer.length/1024).toFixed(1)}KB)`);
    console.log(`${TAG}   caption length=${caption?.length ?? 0}`);
    console.log(`${TAG} ────────────────────────────────────────────────────────`);

    // ── BUILD IgApiClient ────────────────────────────────────────────────────
    // _newAutomationIgClient() hooks apiThrottle() into ig.request.send so
    // ig.publish.photo() is rate-limited by API Controls automatically.
    const ig = this._newAutomationIgClient();
    const deviceSeed = (this.userAgentApi ?? this.username ?? "instagram") + "|" + (this.username ?? "instagram");

    if (this.igDeviceState) {
      try {
        const saved = JSON.parse(this.igDeviceState) as { deviceId?: string; uuid?: string; phoneId?: string; adid?: string; deviceString?: string; authorization?: string; igWWWClaim?: string };
        ig.state.generateDevice(deviceSeed);
        if (saved.deviceId)      ig.state.deviceId      = saved.deviceId;
        if (saved.uuid)          ig.state.uuid          = saved.uuid;
        if (saved.phoneId)       ig.state.phoneId       = saved.phoneId;
        if (saved.adid)          ig.state.adid          = saved.adid;
        if (saved.deviceString)  ig.state.deviceString  = saved.deviceString;
        if (saved.authorization) ig.state.authorization = saved.authorization;
        if (saved.igWWWClaim)    ig.state.igWWWClaim    = saved.igWWWClaim;
        console.log(`${TAG} IgApiClient device restored — uuid=${ig.state.uuid?.slice(0,8)}… deviceId=${ig.state.deviceId} phoneId=${ig.state.phoneId?.slice(0,8)}…`);
      } catch (e: any) {
        ig.state.generateDevice(deviceSeed);
        console.error(`${TAG} igDeviceState parse error — using freshly generated device: ${e?.message}`);
      }
    } else {
      ig.state.generateDevice(deviceSeed);
      console.warn(`${TAG} No igDeviceState — generated fresh device IDs (may cause "unrecognized device")`);
    }

    // ── LOAD COOKIES INTO IgApiClient ────────────────────────────────────────
    const now = new Date().toISOString();
    const cookieEntries = igCookiePairs.flatMap(pair => {
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
    console.log(`${TAG} Loading ${cookieEntries.length} cookie entries into IgApiClient cookie jar`);
    await ig.state.deserializeCookieJar(JSON.stringify({
      version: "tough-cookie@4.1.3",
      storeType: "MemoryCookieStore",
      rejectPublicSuffixes: true,
      cookies: cookieEntries,
    }));

    // Verify cookies landed correctly
    const csrfAfterLoad = ig.state.cookieCsrfToken;
    const userIdAfterLoad = ig.state.cookieUserId;
    console.log(`${TAG} IgApiClient cookie jar loaded — cookieCsrfToken=${csrfAfterLoad?.slice(0,8) ?? "MISSING"} cookieUserId=${userIdAfterLoad ?? "MISSING"}`);
    if (!csrfAfterLoad)  console.error(`${TAG} ✗ cookieCsrfToken is null after deserialize — HMAC signing will fail`);
    if (!userIdAfterLoad) console.error(`${TAG} ✗ cookieUserId is null after deserialize — requests will be rejected`);

    ig.state.constants.APP_VERSION      = MOBILE_VERSION;
    ig.state.constants.APP_VERSION_CODE = MOBILE_VERSION_CODE;
    patchDeviceStringVersionCode(ig, MOBILE_VERSION_CODE);
    console.log(`${TAG} App version: ${MOBILE_VERSION} (code ${MOBILE_VERSION_CODE})`);
    console.log(`${TAG} deviceString: ${ig.state.deviceString}`);

    if (this.proxyUrl) {
      ig.state.proxyUrl = this.proxyUrl;
      console.log(`${TAG} Proxy set on IgApiClient: ${this.proxyUrl}`);
    }
    patchIgClientTls(ig, this.proxyUrl);

    // ── CALL ig.publish.photo ────────────────────────────────────────────────
    console.log(`${TAG} ── CALLING ig.publish.photo ───────────────────────────`);
    console.log(`${TAG}   uuid=${ig.state.uuid?.slice(0,8)}… csrf=${ig.state.cookieCsrfToken?.slice(0,8) ?? "NONE"} uid=${userIdAfterLoad ?? "NONE"} buf=${imageBuffer.length}B`);
    try {
      const result = await this.timed("PublishPhoto", () => ig.publish.photo({
        file: imageBuffer,
        caption: caption ?? "",
      }) as Promise<any>, "Repost: publish photo");

      console.log(`${TAG} ig.publish.photo RAW RESULT:`, JSON.stringify(result).slice(0, 800));
      const mediaId = result?.media?.id ?? result?.media?.pk ?? result?.pk ?? result?.id ?? null;
      if (mediaId) {
        console.log(`${TAG} ✓ SUCCESS — media_id=${mediaId}`);
        return String(mediaId);
      }
      // Succeeded but no media ID
      const status = result?.status;
      console.error(`${TAG} ✗ No media_id in result (status="${status}") — full result: ${JSON.stringify(result).slice(0, 600)}`);
      this._lastConfigureError = "no media ID in IgApiClient publish result";
      return null;

    } catch (err: any) {
      const rawMsg: string  = err?.message ?? String(err);
      const name: string    = err?.name ?? "Error";
      const stack: string   = err?.stack ?? "";
      const statusCode: number | undefined = err?.response?.statusCode ?? err?.statusCode;
      const errBody: any    = err?.response?.body ?? err?.body;
      const errText: string = typeof errBody === "string" ? errBody : (errBody ? JSON.stringify(errBody) : "");

      console.error(`${TAG} ✗ ig.publish.photo THREW ${name}: ${rawMsg}`);
      if (statusCode !== undefined) console.error(`${TAG}   HTTP status: ${statusCode}`);
      if (errText)    console.error(`${TAG}   Response body: ${errText.slice(0, 1000)}`);
      if (stack)      console.error(`${TAG}   Stack: ${stack.split("\n").slice(0, 6).join(" | ")}`);

      // ── Known error patterns ─────────────────────────────────────────────
      if (rawMsg.includes("login_required") || statusCode === 401) {
        console.error(`${TAG}   ► DIAGNOSIS: Session is expired or cookie is invalid. Re-verify the account.`);
      } else if (rawMsg.includes("challenge_required") || errText.includes("challenge_required")) {
        console.error(`${TAG}   ► DIAGNOSIS: Instagram is demanding a checkpoint/challenge. The account needs human intervention in the embedded browser.`);
      } else if (rawMsg.includes("feedback_required") || errText.includes("feedback_required")) {
        const action = (typeof errBody === "object" ? errBody?.feedback_title : "") || "unknown";
        console.error(`${TAG}   ► DIAGNOSIS: feedback_required — action="${action}". Account is soft-banned or under restriction.`);
      } else if (rawMsg.includes("not_authorized") || statusCode === 403) {
        console.error(`${TAG}   ► DIAGNOSIS: 403 not_authorized. CSRF or session mismatch. Check csrftoken is fresh.`);
      } else if (rawMsg.includes("upload_error") || rawMsg.includes("upload id") || rawMsg.includes("upload_id")) {
        console.error(`${TAG}   ► DIAGNOSIS: Upload ID rejected at configure step. TLS stack mismatch between rupload and configure, or rupload silently failed.`);
      } else if (rawMsg.includes("media_not_found")) {
        console.error(`${TAG}   ► DIAGNOSIS: media_not_found — the upload ID could not be found by configure. The rupload succeeded but configure landed on a different shard (missing rur cookie?) or the upload expired.`);
      } else if (rawMsg.includes("sorry") || rawMsg.includes("something went wrong")) {
        console.error(`${TAG}   ► DIAGNOSIS: Generic Instagram error. Possible causes: aspect ratio out of range, unsigned request body, or rate-limited.`);
      } else if (statusCode === 400) {
        console.error(`${TAG}   ► DIAGNOSIS: HTTP 400 Bad Request. Required fields missing in configure body, or image format/dimensions rejected.`);
      } else if (statusCode === 429) {
        console.error(`${TAG}   ► DIAGNOSIS: HTTP 429 Rate Limited. Too many upload attempts in short time.`);
      } else if (rawMsg.includes("ECONNREFUSED") || rawMsg.includes("ETIMEDOUT") || rawMsg.includes("ENOTFOUND")) {
        console.error(`${TAG}   ► DIAGNOSIS: Network error — ${rawMsg}. Proxy down, DNS issue, or Instagram unreachable.`);
      } else if (rawMsg.includes("SSL") || rawMsg.includes("TLS") || rawMsg.includes("certificate")) {
        console.error(`${TAG}   ► DIAGNOSIS: TLS error — ${rawMsg}. Proxy cert issue or TLS fingerprint mismatch.`);
      } else {
        console.error(`${TAG}   ► DIAGNOSIS: Unrecognised error — check full message and body above.`);
      }

      const cleanMsg = rawMsg.replace(/^[A-Z]+ \/[^\s]+ - [^;]+;\s*/, "").trim() || rawMsg;
      this._lastConfigureError = cleanMsg;
      return null;
    }
  }

  // ── Upload a photo and create the Instagram post ──────────────────────────
  /** Uploads a photo and returns the new media ID string on success, or null on failure. */
  async uploadPhoto(imageBuffer: Buffer, caption: string): Promise<string | null> {
    this._lastConfigureError = "";
    this._lastUploadLoginRequired = false;
    const TAG = `[UPLOAD:photo @${this.username ?? this.profileId}]`;
    return this.timed("UploadPhoto", async () => {
      console.log(`${TAG} ══════════════════════════════════════════════════════`);
      console.log(`${TAG} START uploadPhoto — buf=${imageBuffer.length}B captionLen=${caption?.length ?? 0}`);
      console.log(`${TAG}   igApiCookies present: ${!!this.igApiCookies}`);
      console.log(`${TAG}   mobileCookieJar: [${this.mobileCookieJar.map(c => c.split("=")[0]).join(", ")}]`);
      console.log(`${TAG}   _mobileIgDid: ${this._mobileIgDid?.slice(0,8) ?? "null"} _mobileMid: ${this._mobileMid?.slice(0,8) ?? "null"}`);
      console.log(`${TAG}   proxyUrl: ${this.proxyUrl ?? "NONE"}`);

      // ── Aspect ratio enforcement ────────────────────────────────────────────
      try {
        const sharpMod = await import("sharp").then(m => m.default).catch(() => null);
        if (sharpMod) {
          const meta = await sharpMod(imageBuffer).metadata();
          const w = meta.width ?? 1080;
          const h = meta.height ?? 1080;
          const ratio = w / h;
          const MIN_RATIO = 0.8;
          const MAX_RATIO = 1.91;
          console.log(`${TAG}   Input image: ${w}x${h} ratio=${ratio.toFixed(3)} format=${meta.format} size=${imageBuffer.length}B`);
          // NOTE: Do NOT call .toColorspace("srgb") — it embeds a 3-4KB sRGB ICC profile
          // into the JPEG output (an APP2 marker). Instagram's rupload transcoder rejects
          // JPEGs with embedded ICC profiles with ProcessingFailedError (retriable:false).
          // sharp's default jpeg() output converts to sRGB internally WITHOUT embedding
          // the ICC profile — this is the correct behaviour for Instagram uploads.
          // Quality 80 matches the image_compression rupload header claim (lib_name:"moz",quality:"80").
          const encodeJpeg = (pipeline: import("sharp").Sharp) =>
            pipeline.flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: 80, progressive: false, chromaSubsampling: "4:2:0" }).toBuffer();

          if (ratio < MIN_RATIO) {
            const newH = Math.floor(w / MIN_RATIO);
            const top  = Math.floor((h - newH) / 2);
            console.log(`${TAG}   Cropping portrait: ${w}x${h} → ${w}x${newH} (top=${top})`);
            imageBuffer = await encodeJpeg(sharpMod(imageBuffer).extract({ left: 0, top, width: w, height: newH }));
            console.log(`${TAG}   After crop: ${imageBuffer.length}B`);
          } else if (ratio > MAX_RATIO) {
            const newW  = Math.floor(h * MAX_RATIO);
            const left  = Math.floor((w - newW) / 2);
            console.log(`${TAG}   Cropping landscape: ${w}x${h} → ${newW}x${h} (left=${left})`);
            imageBuffer = await encodeJpeg(sharpMod(imageBuffer).extract({ left, top: 0, width: newW, height: h }));
            console.log(`${TAG}   After crop: ${imageBuffer.length}B`);
          } else {
            console.log(`${TAG}   Aspect ratio ${ratio.toFixed(3)} ✓ — no crop needed. Re-encoding to baseline JPEG (no ICC profile)…`);
            imageBuffer = await encodeJpeg(sharpMod(imageBuffer));
            console.log(`${TAG}   After re-encode: ${imageBuffer.length}B`);
          }
        } else {
          console.warn(`${TAG}   ⚠ sharp not available — skipping aspect ratio check`);
        }
      } catch (e: any) {
        console.warn(`${TAG}   Aspect ratio check error (non-fatal): ${e?.message}`);
      }

      // ── Primary path: IgApiClient native publish ────────────────────────────
      if (this.igApiCookies) {
        console.log(`${TAG} ── PATH A: ig.publish.photo via IgApiClient ──────────`);
        const result = await this._publishViaIgClient(imageBuffer, caption);
        if (result) {
          console.log(`${TAG} ✓ PATH A succeeded — media_id=${result}`);
          return result;
        }
        console.error(`${TAG} ✗ PATH A failed — error="${this._lastConfigureError}"`);
        console.log(`${TAG} Falling back to PATH B (hand-rolled rupload+configure)`);
      } else {
        console.warn(`${TAG} Skipping PATH A — no igApiCookies. Going straight to PATH B.`);
      }

      // ── Fallback: hand-rolled rupload + configure ──────────────────────────
      // Clear stale PATH A error so any PATH B failure message reflects only PATH B.
      this._lastConfigureError = "";
      console.log(`${TAG} ── PATH B: hand-rolled rupload + configure ───────────`);
      // Shard-routing strategy (three-layer defence):
      //  PRIMARY — rur cookie pre-seed: call a cheap authenticated GET before the
      //    rupload so Instagram sets the rur cookie in our mobileCookieJar.  Once
      //    rur is present, both rupload AND configure include it in their Cookie
      //    header and Instagram's LB routes both to the same backend shard.  This
      //    is the Jarvee approach and is the most reliable shard-affinity mechanism.
      //    Without this pre-seed, rur is absent and shard routing depends entirely
      //    on layer 2 (shared agent), which breaks when a slow upload exhausts the
      //    proxy TCP tunnel keep-alive.
      //  SECONDARY — Shared HttpsProxyAgent: rupload and configure reuse the same
      //    proxy tunnel so Instagram's load balancer routes both requests to the
      //    same backend shard.  Helps but not sufficient alone when rur is missing
      //    (Instagram can close the backend connection after a slow upload).
      //  TERTIARY — rur overwrite: _mobileRupload ALWAYS overwrites the rur entry
      //    in mobileCookieJar if the rupload response Set-Cookie contains one.
      if (!this.mobileCookieJar.some(c => c.startsWith("rur="))) {
        // LAYER 0: Read rur directly from the browser cookie file first — it's always
        // present there (loaded by loadBrowserCookies into this.cookieJar) but is never
        // copied into mobileCookieJar.  This is instant and doesn't need a network call.
        try {
          const cookieFilePath = process.env.DATABASE_PATH
            ? path.join(path.dirname(process.env.DATABASE_PATH), "browser-data", `cookies-${this.profileId}.json`)
            : path.join(process.cwd(), "server", "browser-data", `cookies-${this.profileId}.json`);
          if (this.profileId && fs.existsSync(cookieFilePath)) {
            const raw = fs.readFileSync(cookieFilePath, "utf8");
            const puppeteerCookies: Array<{ name: string; value: string; domain?: string }> = JSON.parse(raw);
            const rurCookie = puppeteerCookies.find(c => c.name === "rur" && (c.domain ?? "").includes("instagram.com"));
            if (rurCookie) {
              this.mobileCookieJar = this.mobileCookieJar.filter(c => !c.startsWith("rur="));
              this.mobileCookieJar.push(`rur=${rurCookie.value}`);
              console.log(`${TAG}   rur seeded from browser cookie file — ${rurCookie.value.slice(0, 20)}…`);
            }
          }
        } catch (fileErr: any) {
          console.warn(`${TAG}   rur browser-file read failed (non-fatal): ${fileErr?.message}`);
        }
      }
      if (!this.mobileCookieJar.some(c => c.startsWith("rur="))) {
        // LAYER 1: If browser file didn't have rur, try a cheap API call to get Instagram
        // to set it (the Jarvee approach).  Slow on cold proxy but guarantees a fresh value.
        console.log(`${TAG}   rur not in mobileCookieJar after file read — pre-seeding via current_user GET`);
        try {
          await this.mobileSessionGet("/api/v1/accounts/current_user/?edit=true");
          const rurNow = this.mobileCookieJar.some(c => c.startsWith("rur="));
          console.log(`${TAG}   rur pre-seed complete: rur=${rurNow ? "✓ seeded" : "✗ still missing (session may be cold)"}`);
        } catch (seedErr: any) {
          console.warn(`${TAG}   rur pre-seed failed (non-fatal): ${seedErr?.message ?? seedErr}`);
        }
      } else {
        console.log(`${TAG}   rur already in mobileCookieJar — skipping API pre-seed`);
      }
      // ── Attempt helper — one full rupload + configure cycle ─────────────────
      // Returns the media_id string on success, null on failure.
      // Each attempt creates its own shared agent so a dead connection from a
      // previous slow upload never carries over.
      const runAttempt = async (attemptNum: number): Promise<string | null> => {
        let attemptAgent: any = undefined;
        if (this.proxyUrl) {
          const { HttpsProxyAgent } = await import("https-proxy-agent");
          attemptAgent = new HttpsProxyAgent(this.proxyUrl, { keepAlive: true, maxSockets: 1 });
          console.log(`${TAG}   [attempt ${attemptNum}] Created fresh HttpsProxyAgent`);
        }
        const uploadId = String(Date.now());
        console.log(`${TAG}   [attempt ${attemptNum}] Generated uploadId=${uploadId}`);
        try {
          const confirmedId = await this._mobileRupload("photo", imageBuffer, uploadId, attemptAgent);
          if (!confirmedId) {
            console.error(`${TAG} [attempt ${attemptNum}] ✗ rupload returned null`);
            this._lastConfigureError = "rupload rejected — session expired or auth failure (see rupload log above)";
            // Flag session expiry so the engine can handle it correctly instead
            // of treating it as a generic network failure to retry next session.
            const isLoginRequired = this._lastConfigureError.includes("session expired");
            if (isLoginRequired) this._lastUploadLoginRequired = true;
            return null;
          }
          console.log(`${TAG}   [attempt ${attemptNum}] Rupload OK confirmedId=${confirmedId}. Firing configure.`);
          const mid = await this._configureViaIgClient(confirmedId, caption, false, imageBuffer, attemptAgent);
          if (mid) {
            console.log(`${TAG} [attempt ${attemptNum}] ✓ configure OK media_id=${mid}`);
          } else {
            console.error(`${TAG} [attempt ${attemptNum}] ✗ configure failed — error="${this._lastConfigureError}"`);
          }
          return mid;
        } finally {
          (attemptAgent as any)?.destroy?.();
          console.log(`${TAG}   [attempt ${attemptNum}] Destroyed HttpsProxyAgent`);
        }
      };

      // ── Attempt 1 ────────────────────────────────────────────────────────────
      let mediaId = await runAttempt(1);

      // ── Retry on "upload id is missing" ──────────────────────────────────────
      // When a slow upload exhausts the proxy TCP keep-alive, Instagram closes
      // the backend connection and configure lands on a different shard ("upload
      // id is missing").  By the time we retry, rur is seeded (from the pre-seed
      // GET above or from the first rupload Set-Cookie), so the retry's rupload
      // and configure both carry rur and land on the same shard every time.
      // We intentionally do NOT retry other error types (auth failures, rate
      // limits, format errors) — only the shard-mismatch class of failure.
      if (
        !mediaId &&
        (this._lastConfigureError?.includes("upload id") ||
         this._lastConfigureError?.includes("upload_id") ||
         this._lastConfigureError?.includes("missing"))
      ) {
        console.warn(`${TAG} ── PATH B RETRY (shard mismatch detected — rur now seeded) ──`);
        mediaId = await runAttempt(2);
        if (mediaId) {
          console.log(`${TAG} ✓ PATH B succeeded on retry — media_id=${mediaId}`);
        } else {
          console.error(`${TAG} ✗ PATH B retry also failed — error="${this._lastConfigureError}"`);
        }
      } else if (!mediaId) {
        console.error(`${TAG} ✗ PATH B configure failed — error="${this._lastConfigureError}"`);
      }

      return mediaId;
    }, `Upload photo (${imageBuffer.length}B) caption="${caption.slice(0, 30)}"`, (result) => result !== null);
  }

  /**
   * Uploads a video (any format, pre-converted to MP4 by makeUniqueVideo)
   * to the user's feed via the Instagram private API.
   * Uses the rupload binary protocol to /rupload_igvideo/{name}.
   */
  async uploadVideo(videoBuffer: Buffer, caption: string): Promise<string | null> {
    const TAG = `[UPLOAD:video @${this.username ?? this.profileId}]`;
    return this.timed("UploadVideo", async () => {
      console.log(`${TAG} ══════════════════════════════════════════════════════`);
      console.log(`${TAG} START uploadVideo — buf=${videoBuffer.length}B (${(videoBuffer.length/1024/1024).toFixed(2)}MB) captionLen=${caption?.length ?? 0}`);
      console.log(`${TAG}   igApiCookies present: ${!!this.igApiCookies}`);
      console.log(`${TAG}   mobileCookieJar: [${this.mobileCookieJar.map(c => c.split("=")[0]).join(", ")}]`);
      console.log(`${TAG}   proxyUrl: ${this.proxyUrl ?? "NONE"}`);

      // Inspect first 4 bytes of video buffer to verify it's actually MP4
      const magic = videoBuffer.slice(0, 12).toString("hex");
      const isMp4 = magic.includes("66747970") || magic.includes("6d6f6f76"); // ftyp or moov
      console.log(`${TAG}   Video magic bytes: ${magic} — looks like MP4: ${isMp4}`);
      if (!isMp4) {
        console.warn(`${TAG}   ⚠ Buffer may not be valid MP4 — rupload may fail. Expected 'ftyp' or 'moov' signature.`);
      }

      const uploadId = String(Date.now());
      console.log(`${TAG}   Generated uploadId=${uploadId}`);

      // Shared agent ensures rupload and configure hit the same backend shard.
      const { HttpsProxyAgent } = await import("https-proxy-agent");
      const sharedAgent = new HttpsProxyAgent(this.proxyUrl!, { keepAlive: true, maxSockets: 1 });
      console.log(`${TAG}   Created shared HttpsProxyAgent for video rupload+configure tunnel`);

      let mediaId: string | null = null;
      try {
        // Step 1 — rupload binary protocol
        const confirmedUploadId = await this._mobileRupload("video", videoBuffer, uploadId, sharedAgent);
        if (!confirmedUploadId) {
          console.error(`${TAG} ✗ Video rupload failed — cannot proceed to configure`);
          return null;
        }
        console.log(`${TAG}   Video rupload OK — confirmedUploadId=${confirmedUploadId}. Firing configure immediately (no delay).`);

        // Step 2 — configure fires immediately after rupload (no apiThrottle)
        mediaId = await this._configureViaIgClient(confirmedUploadId, caption, true, undefined, sharedAgent);
        if (mediaId) {
          console.log(`${TAG} ✓ uploadVideo succeeded — media_id=${mediaId}`);
        } else {
          console.error(`${TAG} ✗ uploadVideo configure failed — error="${this._lastConfigureError}"`);
        }
      } finally {
        (sharedAgent as any).destroy?.();
        console.log(`${TAG}   Destroyed shared HttpsProxyAgent`);
      }
      return mediaId;
    }, `Upload video (${videoBuffer.length}B) caption="${caption.slice(0, 30)}"`, (result) => result !== null);
  }

  /** Disables comments on a post via the Instagram private API. */
  async disableComments(mediaId: string): Promise<void> {
    return this.timed("DisableComments", async () => {
      const body = new URLSearchParams({ media_id: mediaId }).toString();
      await this.mobileSessionPost(`/api/v1/media/${mediaId}/disable_comments/`, body);
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

        const j = await this.mobileSessionPost(`/api/v1/tags/${encodeURIComponent(tag)}/sections/`, body);

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
        const j = await this.mobileSessionGet(`/api/v1/friendships/${userId}/followers/?${qs}`);
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
      const j = await this.mobileSessionGet(`/api/v1/accounts/current_user/?edit=true`);
      return j?.user?.pk ? String(j.user.pk) : null;
    }, "Get own user ID");
  }

  // ── Search for a user by username (safer than web_profile_info lookup) ────
  // Uses the search bar endpoint — looks like a human typing in the search box.
  async searchUserByUsername(username: string): Promise<{ pk: string; username: string } | null> {
    return this.timed("SearchUser", async () => {
      const j = await this.mobileSessionGet(`/api/v1/users/search/?timezone_offset=0&count=5&q=${encodeURIComponent(username)}`);
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
      await this.mobileSessionPost(`/api/v1/discover/ayml/`);
    }, "Get suggested users");
  }

  // ── Visit the Explore page and return up to `scrollCount` post items ───────
  // Used by the Human Session engine when the timeline returns 0 posts.
  // Calls the mobile API topical explore endpoint (equivalent to tapping the
  // Search/Explore tab in the app), simulating natural discovery browsing.
  async visitExplorePage(scrollCount: number): Promise<Array<{ mediaId: string; shortcode: string; username: string; userId: string }>> {
    return this.timed("VisitExplorePage", async () => {
      const items: Array<{ mediaId: string; shortcode: string; username: string; userId: string }> = [];
      try {
        // Primary endpoint: topical explore (Search & Explore tab)
        const j = await this.mobileSessionGet(`/api/v1/discover/topical_explore/?is_prefetch=false&omit_cover_media=false&use_sectional_payload=true&timezone_offset=0&session_id=${Date.now()}&include_fixed_destinations=false`);
        const sections: any[] = j?.sectional_items ?? j?.items ?? [];
        for (const section of sections) {
          const medias: any[] = section?.layout_content?.medias ?? section?.layout_content?.fill_items ?? [];
          for (const m of medias) {
            const media = m?.media ?? m;
            const mediaId = String(media?.pk ?? media?.id ?? "");
            const shortcode = String(media?.code ?? media?.shortcode ?? mediaId);
            const owner = media?.user ?? media?.owner ?? {};
            const username = String(owner?.username ?? "");
            const userId = String(owner?.pk ?? owner?.id ?? "");
            if (mediaId) items.push({ mediaId, shortcode, username, userId });
          }
        }
      } catch (e: any) {
        console.warn(`[webClient] visitExplorePage topical_explore failed: ${e?.message}`);
      }
      // Fallback: ayml discover if topical_explore returned nothing
      if (items.length === 0) {
        try {
          const j2 = await this.mobileSessionGet(`/api/v1/discover/ayml/?max_id=&module=explore_popular&is_nonpersonalized=false`);
          const users: any[] = j2?.suggested_users ?? j2?.users ?? [];
          for (const item of users) {
            const media = item?.media_infos?.[0] ?? item?.media ?? null;
            if (!media) continue;
            const mediaId = String(media?.pk ?? media?.id ?? "");
            const shortcode = String(media?.code ?? media?.shortcode ?? mediaId);
            const owner = media?.user ?? item?.user ?? {};
            const username = String(owner?.username ?? "");
            const userId = String(owner?.pk ?? owner?.id ?? "");
            if (mediaId) items.push({ mediaId, shortcode, username, userId });
          }
        } catch {}
      }
      return items.slice(0, scrollCount);
    }, `Visit explore page (scroll ${scrollCount})`);
  }

  // ── Follow X users from the Suggested Users page ──────────────────────────
  // Used by the Human Session engine when the timeline returns 0 posts.
  // Fetches the discover/ayml endpoint, picks the first `count` suggestions,
  // and follows them using the mobile API — seeding the feed for future runs.
  async followSuggestedUsers(count: number): Promise<{ followed: number; usernames: string[] }> {
    return this.timed("FollowSuggestedUsers", async () => {
      const j = await this.mobileSessionPost(`/api/v1/discover/ayml/`);
      const suggestions: any[] = j?.suggested_users ?? j?.users ?? [];
      const toFollow = suggestions.slice(0, count);
      const followed: string[] = [];
      for (const item of toFollow) {
        const user = item.user ?? item;
        const userId = String(user.pk ?? user.id ?? "");
        const username = String(user.username ?? userId);
        if (!userId) continue;
        try {
          const res = await this.followUser(userId, username, "suggested_users");
          if (res.ok) followed.push(username);
          await new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 3000)));
        } catch {}
      }
      return { followed: followed.length, usernames: followed };
    }, `Follow ${count} suggested user(s)`);
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
  ebCookies?: { mid: string; ig_did: string; csrftoken: string; cookieStrings: string[] } | null;
  onStep?: (msg: string) => void;
}): Promise<SignupResult> {
  const { username, password, email, firstName = "", day, month, year, proxyUrl, bio, userAgent, apiLimits, ebCookies, onStep } = params;

  // ── IP-LEAK PREVENTION ────────────────────────────────────────────────────
  // Account creation sends real Instagram API calls.  Without a proxy the
  // request exits via the server/home IP — Instagram will flag the account
  // immediately.  Block before any network I/O occurs.
  if (!proxyUrl) {
    return {
      status: "error",
      steps: ["[IP-LEAK BLOCKED] No proxy configured — account creation refused to protect your IP. Assign a proxy in the Create Account settings."],
      message: "No proxy configured. Assign a proxy to this account before creating it.",
    };
  }

  // Delay helper: respects the API limits by sleeping (everySecondsMin/reqMax … everySecondsMax/reqMin) seconds
  const stepDelay = () => {
    // Always apply a delay between API steps to avoid triggering Instagram's
    // signup rate-limiter.  When apiLimits are provided, honour them; otherwise
    // fall back to a safe 5–15 s range.
    const minMs = apiLimits
      ? Math.max(500, (apiLimits.everySecondsMin / apiLimits.requestsMax) * 1000)
      : 5000;
    const maxMs = apiLimits
      ? Math.max(minMs, (apiLimits.everySecondsMax / apiLimits.requestsMin) * 1000)
      : 15000;
    const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return new Promise<void>(r => setTimeout(r, ms));
  };
  const rawUA = userAgent || randomMobileUA();
  // Accept either a full "Instagram X.X.X Android (...)" string or a raw device descriptor
  const effectiveUA = rawUA.startsWith("Instagram ")
    ? rawUA
    : `Instagram ${MOBILE_VERSION} Android (${rawUA}; ${MOBILE_VERSION_CODE})`;
  const steps: string[] = [];
  const step = (msg: string) => { steps.push(msg); console.log(`[accountCreator] ${msg}`); try { onStep?.(msg); } catch {} };

  // ── Device identifiers — prefer EB-harvested, fall back to generated for new accounts ──
  // The route handler runs harvestSignupCookiesFromEB() first; if the proxy blocked
  // Instagram's CDN from setting cookies, the handler generates fresh random IDs and
  // passes them here.  For a brand-new account there is no prior device history, so
  // randomly generated IDs are safe — the fingerprint continuity rule applies to
  // existing logged-in accounts, not accounts that do not yet exist.
  const ig_did = ebCookies?.ig_did || randomUUID();
  const mid    = ebCookies?.mid    || randomBytes(18).toString("base64").replace(/[+/=]/g, "").slice(0, 24);
  const phone_id     = randomUUID();
  const waterfall_id = randomUUID();
  const android_id   = `android-${ig_did.replace(/-/g, "").slice(0, 16)}`;
  const guid         = ig_did;
  // X-Pigeon headers: Instagram's app emits these on every request.
  // Session ID is stable per app launch; rawclienttime is the unix epoch with µs precision.
  // Without them the request pattern doesn't match a real Android app and Instagram's
  // bot-detection layer is more likely to fire signup_block on new IPs.
  const pigeonSessionId = randomUUID();
  const pigeonRawclienttime = () => `${(Date.now() / 1000).toFixed(7)}`;

  // Seed the cookie jar from the full EB cookie set
  let cookieJar: string[] = ebCookies.cookieStrings.length
    ? ebCookies.cookieStrings
    : [`ig_did=${ig_did}`, `mid=${mid}`];

  step(`EB cookies seeded: mid=${mid.slice(0, 8)}... ig_did=${ig_did.slice(0, 8)}... jar=[${cookieJar.map(c => c.split("=")[0]).join(", ")}]`);

  // ── Timezone offset — must match the proxy IP's geographic region ────────────
  // Instagram cross-checks X-IG-Timezone-Offset against the connecting IP.
  // A mismatch (e.g. UTC+0 offset from a US proxy) is a bot-detection signal.
  // We query ip-api.com with the proxy hostname to get the actual UTC offset
  // for that IP's country, falling back to -18000 (UTC-5) on lookup failure.
  let tzOffset = -18000;
  if (proxyUrl) {
    try {
      const proxyHost = new URL(proxyUrl).hostname;
      tzOffset = await lookupTimezoneOffset(proxyHost);
      step(`Timezone: ${proxyHost} → offset ${tzOffset >= 0 ? "+" : ""}${tzOffset}s (${tzOffset >= 0 ? "+" : ""}${(tzOffset / 3600).toFixed(1)}h UTC)`);
    } catch { /* non-fatal — keep default */ }
  } else {
    step("Timezone: no proxy — using default UTC-5 offset");
  }

  // Headers restored to match the EXACT state of the one successful HTTP 200
  // (commit 57e5f68 / 44b34a0 — before gzip fix, before X-FB-Client-IP was added).
  // Do NOT add X-FB-Client-IP or X-FB-Server-Cluster — those were added AFTER
  // the 200 as speculative improvements and are absent from the working config.
  // BLOKS_VERSION_ID: updated 2026-05-24 — confirmed current via instagrapi master (auth.py bloks_versioning_id).
  // Old v222 value (388ece79...) caused error_type:"needs_upgrade" on accounts/create/.
  // Old v427 value (16b7bd25...) also caused "needs_upgrade" after Instagram bumped minimum version.
  // Old v428 value (7189b949...) caused "needs_upgrade" after Instagram bumped to v431.
  // Update this alongside MOBILE_VERSION when Instagram bumps its minimum accepted version.
  const BLOKS_VERSION_ID = "ce555e5500576acd8e84a66018f54a05720f2dce29f0bb5a1f97f0c10d6fac48";
  const baseHeaders: Record<string, string> = {
    "Host": "i.instagram.com",
    "User-Agent": effectiveUA,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "X-IG-App-ID": MOBILE_AID,
    "X-IG-App-Version": MOBILE_VERSION,
    "X-IG-Capabilities": "3brTvwE=",
    "X-IG-Connection-Type": "WIFI",
    // Simulate a real measured WiFi speed.  The "-1kbps"/0 defaults are the
    // "not measured" placeholder — no real Android phone ever sends these and
    // Instagram flags them as a bot signal.  We pick a plausible WiFi range
    // (8–40 Mbps) and compute a realistic byte count + elapsed time.
    "X-IG-Connection-Speed": (() => { const k = 8000 + Math.floor(Math.random() * 32000); return `${k}kbps`; })(),
    "X-IG-Bandwidth-Speed-KBPS": (() => { const k = 8000 + Math.floor(Math.random() * 32000); return `${k}.000`; })(),
    "X-IG-Bandwidth-TotalBytes-B": String(512 * 1024 + Math.floor(Math.random() * 9 * 1024 * 1024)),
    "X-IG-Bandwidth-TotalTime-MS": String(300 + Math.floor(Math.random() * 2000)),
    "X-IG-Device-ID": ig_did,
    "X-IG-Android-ID": android_id,
    // X-MID intentionally omitted here — it is populated below after launcher/sync
    // issues a mobile-specific mid.  A real Android app never sends a web-browser mid
    // as X-MID; it uses the mid returned by the mobile launcher/sync endpoint.
    "X-Bloks-Version-Id": BLOKS_VERSION_ID,
    "X-Bloks-Is-Layout-RTL": "false",
    "X-FB-HTTP-Engine": "Liger",
    "X-IG-WWW-Claim": "0",
    "X-Pigeon-Session-Id": pigeonSessionId,
    "X-Pigeon-Rawclienttime": pigeonRawclienttime(),
    // Locale headers present on every real Android Instagram request
    "X-IG-App-Locale": "en_US",
    "X-IG-Device-Locale": "en_US",
    "X-IG-Mapped-Locale": "en_US",
    // UTC offset in seconds matching the proxy IP's geographic region.
    // Instagram cross-checks this against the connecting IP — mismatch = bot flag.
    "X-IG-Timezone-Offset": String(tzOffset),
  };

  // Mobile mid: starts as the EB-harvested web mid (fallback).  launcher/sync below
  // will issue a proper mobile mid from Instagram's mobile API.  Once received, this
  // variable is promoted and baseHeaders["X-MID"] is set — so every call after
  // launcher/sync uses the mobile-issued mid, not the web-browser mid.
  // (Real Android apps get their mid from the mobile launcher/sync response; they
  //  never send a Chrome/web mid as X-MID to i.instagram.com.)
  let mobileMid = mid;

  // CSRF strategy: use the real csrftoken the EB harvested from instagram.com if one
  // was returned, otherwise fall back to "missing".
  //
  // The EB visits instagram.com and gets a genuine browser-set csrftoken cookie.
  // Using that real token mirrors the login flow (where EB cookies flow straight into
  // the API client) and avoids the "inconsistent CSRF state" rejection that Instagram
  // triggers when a real token is mixed with "missing".
  //
  // instagram-private-api uses "missing" only because it never has a real browser
  // session to draw from; we do, so we use the real one when available.
  const ebCsrf = (ebCookies.csrftoken ?? "").trim();
  let csrfToken = (ebCsrf && ebCsrf !== "missing") ? ebCsrf : "missing";
  // cookieJar already contains the EB csrftoken from ebCookies.cookieStrings.
  // Only inject "missing" if the EB returned nothing.
  if (!ebCsrf || ebCsrf === "missing") {
    cookieJar = mergeCookies(cookieJar, [`csrftoken=missing`]);
  }
  step(`CSRF ${csrfToken !== "missing" ? `seeded from EB harvest (${csrfToken.slice(0, 8)}...)` : 'set to "missing" (EB returned no real token)'}`);

  await stepDelay();

  // Log proxy being used (or lack of one) so we can verify it in diagnostics
  step(`Using proxy: ${proxyUrl ? proxyUrl.replace(/:[^@]*@/, ":***@") : "none (direct connection)"}`);


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
        // is_main_native_login: real Android app always sends this on first launcher/sync
        is_main_native_login: "1",
        _csrftoken: csrfToken,
        _uuid: guid,
      }),
      cookieJar,
      proxyUrl,
    });
    cookieJar = mergeCookies(cookieJar, launcherRes.cookies);
    step(`launcher/sync HTTP ${launcherRes.status} — cookies: [${launcherRes.cookies.map(c => c.split("=")[0]).join(", ") || "none"}]`);
    console.log(`[accountCreator] launcher/sync HTTP=${launcherRes.status}:`, JSON.stringify(launcherRes.json ?? {}).slice(0, 200));

    // ── Promote the mobile-issued mid ─────────────────────────────────────────
    // Instagram's mobile API issues its own mid in the launcher/sync response cookies.
    // This mid is distinct from the web-browser mid the EB harvested — using the
    // mobile-issued mid for X-MID makes all subsequent calls look like a real Android
    // app rather than a web browser replaying its session to the mobile API.
    const launcherMid = launcherRes.cookies
      .find(c => c.startsWith("mid="))
      ?.split("=").slice(1).join("=") ?? "";
    if (launcherMid) {
      mobileMid = launcherMid;
      // Merge the new mid into the cookie jar so the Cookie header stays consistent
      cookieJar = mergeCookies(cookieJar, [`mid=${mobileMid}`]);
      step(`Mobile mid issued by launcher/sync: ${mobileMid.slice(0, 8)}... (replaced web-origin mid ✓)`);
    } else {
      step(`launcher/sync did not return a new mid — keeping EB mid as fallback`);
    }
    // Stamp X-MID on baseHeaders so every subsequent request uses the mobile mid
    baseHeaders["X-MID"] = mobileMid;
  } catch (e: any) {
    // Even on error, stamp the fallback mid so calls aren't sent without X-MID at all
    baseHeaders["X-MID"] = mobileMid;
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
    // phone_id and client_id: the real Instagram app always includes these.
    // phone_id ties the signup to the specific device's phone identifier.
    // client_id is the ig_did UUID — Instagram uses it to correlate the signup
    // with the launcher/sync + qe/sync warm-up calls made earlier in the flow.
    phone_id,
    client_id: guid,
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
    // Treat plain-text 400 (no JSON body) the same as a generic JSON 400 — both
    // mean Instagram's edge/WAF rejected the request before parsing our payload.
    const isGeneric400 = res.status === 400 && (!j || (j?.status === "fail" && !j?.error_type));
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
  // Also trigger library fallback when j is null (plain-text 400 — no JSON from Instagram)
  const allMobileFailed = (j?.status === "fail" && !j?.error_type) || j?.error_type === "needs_upgrade" || (res.status === 400 && !j);
  if (allMobileFailed) {
    step("Custom HTTP stack blocked — trying instagram-private-api library path...");
    try {
      const igLib = newIgClient();
      // Generate a base device fingerprint keyed to username+email so it's
      // reproducible but unique per account (same pattern used for DM sending).
      igLib.state.generateDevice(`${username}|${email}|${Date.now()}`);
      // Override the freshly-generated device IDs with the EB-harvested values so
      // the library path presents the same ig_did/mid/uuid that the EB and all
      // prior custom-HTTP calls used.  Without this the library generates brand-new
      // random IDs mid-signup — Instagram sees a completely different device appear
      // after several API calls on the original device fingerprint, which is an
      // immediate bot signal.
      igLib.state.uuid    = ig_did;
      igLib.state.phoneId = phone_id;
      igLib.state.deviceId = android_id;
      // CRITICAL: patch APP_VERSION here — same as every other IgApiClient usage in
      // this file (login, verify, DM, etc.).  Without this the library uses its bundled
      // default (~v222.x.x) which Instagram immediately rejects with needs_upgrade.
      igLib.state.constants.APP_VERSION      = MOBILE_VERSION;
      igLib.state.constants.APP_VERSION_CODE = MOBILE_VERSION_CODE;
      patchDeviceStringVersionCode(igLib, MOBILE_VERSION_CODE);
      if (proxyUrl) igLib.state.proxyUrl = proxyUrl;
      // Do NOT call patchIgClientTls here — for account creation we want the library
      // to use its native Node.js HTTPS stack (not CycleTLS OkHttp4 JA3).  There is
      // no existing device fingerprint to preserve for a new account, and using
      // Node.js TLS avoids the OkHttp4 JA3 fingerprint that triggers Instagram's
      // bot detection on the account creation endpoint.

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
        await igLib.request.send({
          url: "/api/v1/qe/sync/",
          method: "POST",
          form: igLib.request.sign({
            id: igLib.state.uuid,
            server_config_retrieval: "1",
            _csrftoken: igLib.state.cookieCsrfToken,
            _uuid: igLib.state.uuid,
          }),
        });
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
  const stillFailed = (j?.status === "fail" && !j?.error_type) || j?.error_type === "needs_upgrade" || (res.status === 400 && !j);
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
          // Use the same mobile Chrome UA that all prior API calls used.
          // A hardcoded Windows desktop UA here is immediately inconsistent with
          // the Android UA sent to i.instagram.com on every step that preceded it.
          "User-Agent": (() => {
            const poolEntry = UA_POOL.find(e => e.api === effectiveUA || effectiveUA.includes(e.api));
            return poolEntry?.embedded ?? UA_POOL[Math.floor(Math.random() * UA_POOL.length)].embedded;
          })(),
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
        forceNodeTls: true,
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
      const detail = j.message ?? j.challenge?.api_path ?? "unknown";
      step(`Challenge required: ${j.challenge?.api_path ?? "unknown"}`);
      return { status: "error", steps, message: `Instagram requires a challenge: ${detail}`, rawResponse: j };
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
      return { status: "error", steps, message: fieldMsg ?? "Another account is using the same email.", rawResponse: j };
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
      return { status: "error", steps, message: detail, rawResponse: j };
    }

    // ── needs_upgrade (stale app version) ────────────────────────────────────
    if (j.error_type === "needs_upgrade") {
      step(`needs_upgrade — Instagram rejected the app version`);
      return {
        status: "error",
        steps,
        message: j.message ?? "needs_upgrade",
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
