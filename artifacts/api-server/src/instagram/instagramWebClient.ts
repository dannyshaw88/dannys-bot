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
import { randomUUID } from "crypto";
import { generateSync as totpGenerate } from "otplib";
import { IgApiClient, IgLoginTwoFactorRequiredError, IgLoginBadPasswordError } from "instagram-private-api";

// ── Low-level HTTPS helper ────────────────────────────────────────────────────
function httpsRequest(
  options: https.RequestOptions,
  body?: string | Buffer,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers as any, body: data });
      });
    });
    req.on("error", reject);
    req.setTimeout(60000, () => { req.destroy(new Error("timeout")); });
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
}): Promise<{ status: number; cookies: string[]; json: any; rawBody: string }> {
  const { host = "www.instagram.com", path, method, headers, body, cookieJar = [], proxyUrl } = opts;

  const reqHeaders: Record<string, string> = {
    ...headers,
    ...(cookieJar.length ? { Cookie: cookieJar.join("; ") } : {}),
    ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
  };

  let agent: any;
  if (proxyUrl) {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    agent = new HttpsProxyAgent(proxyUrl);
  }

  const res = await httpsRequest(
    { host, port: 443, path, method, headers: reqHeaders, ...(agent ? { agent } : {}) },
    body,
  );

  const raw = res.headers["set-cookie"];
  const newCookies: string[] = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(c => c.split(";")[0]);

  let json: any = null;
  try { json = JSON.parse(res.body); } catch {}

  return { status: res.status, cookies: newCookies, json, rawBody: res.body };
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

// ── Constants ─────────────────────────────────────────────────────────────────
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const APP_ID  = "936619743392459";

type ApiCallLogger = (op: string, durationMs: number, message?: string) => void;

// Keep this version current — Instagram rejects sessions from versions older
// than ~18 months with a checkpoint_required → unsupported_version response.
// Version 361 ≈ early 2025; update periodically as Instagram raises the floor.
const MOBILE_VERSION      = "361.0.0.32.109";
const MOBILE_VERSION_CODE = "617571539";
// Date this version was last confirmed working. If it's been more than 12
// months, Instagram may have started rejecting it — update MOBILE_VERSION.
const MOBILE_VERSION_DATE = "2025-05-03";
(() => {
  const ageMs = Date.now() - new Date(MOBILE_VERSION_DATE).getTime();
  const ageDays = Math.floor(ageMs / 86_400_000);
  if (ageDays > 365) {
    console.warn(
      `[webClient] ⚠️  MOBILE_VERSION (${MOBILE_VERSION}) was last updated ${ageDays} days ago.` +
      ` Instagram may be rejecting it — update MOBILE_VERSION + MOBILE_VERSION_CODE in instagramWebClient.ts.`
    );
  }
})();
const MOBILE_UA  = `Instagram ${MOBILE_VERSION} Android (33/13; 440dpi; 1080x2340; OPPO; CPH2609; OP5961L1; Snapdragon8sGen3; en_US; ${MOBILE_VERSION_CODE})`;
const MOBILE_AID = "567067343352427";

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
    this.throttleSecondsMin  = Math.max(0, limits.everySecondsMin);
    this.throttleSecondsMax  = Math.max(0, limits.everySecondsMax);
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
    // If igApiCookies don't include a csrftoken, pull it from the web cookie jar
    // (EB browser session). Instagram uses the same csrftoken across *.instagram.com
    // domains, so the web token is valid for i.instagram.com DM requests too.
    if (!cookies.some(c => c.startsWith("csrftoken="))) {
      const webCsrf = this.cookieJar.find(c => c.startsWith("csrftoken="));
      if (webCsrf) cookies.push(webCsrf);
    }

    this.mobileCookieJar = cookies;
    const csrfEntry = cookies.find(c => c.startsWith("csrftoken="));
    if (csrfEntry) this.mobileCsrf = csrfEntry.split("=").slice(1).join("=");
    this.mobileSessionReady = true;
    console.log(`[webClient] mobile session restored from igApiCookies (${cookies.length} cookies, sessionid=true, csrf=${!!csrfEntry})`);
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

  private async timed<T>(opName: string, fn: () => Promise<T>, message?: string | ((result: T) => string)): Promise<T> {
    const t0 = Date.now();
    const result = await fn();
    const ms = Date.now() - t0;
    const msg = typeof message === "function" ? message(result) : message;
    this.logCallFn?.(opName, ms, msg);
    return result;
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
    const ig = new IgApiClient();
    const deviceSeed = this.userAgentApi ?? username;

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

    // Patch app version constants from the profile's user-agent string so that
    // X-IG-App-Version and the User-Agent header both report the same version.
    {
      const m = (this.userAgentApi ?? "").match(/^Instagram ([\d.]+) Android \(([^)]+)\)/);
      if (m) {
        const parts = m[2].split(";");
        const versionCode = parts[parts.length - 1].trim();
        if (/^\d+$/.test(versionCode)) {
          ig.state.constants.APP_VERSION      = m[1];
          ig.state.constants.APP_VERSION_CODE = versionCode;
          console.log(`[webClient] @${username}: patched APP_VERSION=${m[1]} APP_VERSION_CODE=${versionCode}`);
        }
      }
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

  private async webPost(path: string, body = ""): Promise<any> {
    await this.apiThrottle();
    const sessionCookie = this.cookieJar.find(c => c.startsWith("sessionid="));
    console.log(`[webClient] webPost ${path} csrf=${this.csrfToken.slice(0, 8)}... session=${sessionCookie ? "present" : "MISSING"}`);

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
  async followUser(userId: string, username?: string): Promise<{ ok: boolean; status?: string; reason?: string; checkpointUrl?: string }> {
    return this.timed("Follow", async () => {
      const r1 = await this.webPost(`/api/v1/friendships/create/${userId}/`);

      // 302 redirect = no body, CSRF token stale or session expired.
      // Only intercept here for true redirects (no JSON body); 400 errors may
      // still carry meaningful JSON (e.g. checkpoint_required) — let those fall
      // through to the per-field checks below.
      if (r1.status === 302 || r1.json === null) return { ok: false, status: "follow_blocked", reason: `HTTP ${r1.status} redirect — CSRF/session issue` };
      const j = r1.json;

      // Always log the full raw response
      console.log(`[webClient] follow ${userId} HTTP ${r1.status}:`, JSON.stringify(j) ?? r1.rawBody.slice(0, 400));

      // ── Checkpoint required — Instagram wants a security challenge completed ──
      if (j?.message === "checkpoint_required" || j?.checkpoint_url) {
        const url = j?.checkpoint_url ?? "";
        console.warn(`[webClient] follow ${userId} checkpoint_required — challenge URL: ${url}`);
        return { ok: false, status: "checkpoint_required", reason: "Instagram requires a security checkpoint", checkpointUrl: url };
      }

      // ── Spam detection — Instagram flagged this follow as spam ──
      if (j?.spam === true) {
        console.warn(`[webClient] follow ${userId} spam — Instagram blocked this follow as spam`);
        return { ok: false, status: "follow_blocked", reason: "spam — Instagram flagged this follow attempt" };
      }

      // ── Login / feedback required ──
      if (j?.require_login || j?.feedback_required || j?.message === "login_required") {
        const reason = j?.message ?? j?.feedback_message ?? "unknown";
        console.warn(`[webClient] follow ${userId} blocked:`, reason);
        return { ok: false, status: "follow_blocked", reason };
      }

      // ── Please wait (soft rate limit) ──
      if (j?.message && typeof j.message === "string" && j.message.toLowerCase().includes("please wait")) {
        console.warn(`[webClient] follow ${userId} rate limited:`, j.message);
        return { ok: false, status: "follow_blocked", reason: j.message };
      }

      // ── Success ──
      if (j?.friendship_status) {
        return { ok: true, status: j.friendship_status.following ? "following" : "requested" };
      }

      // ── Catch-all for any other fail status ──
      if (j?.status === "fail") {
        const reason = j?.message || "Instagram declined (status: fail)";
        console.warn(`[webClient] follow ${userId} failed:`, reason);
        return { ok: false, status: "follow_blocked", reason };
      }

      // ── Unexpected response ──
      console.warn(`[webClient] follow ${userId} unexpected response:`, JSON.stringify(j));
      return { ok: false, status: "follow_blocked", reason: "unexpected response" };
    }, username ? `Follow @${username}` : `Follow user ${userId}`);
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
      const j = await this.mobilePost(`/api/v1/media/${mediaId}/like/`);
      const ok = j?.status === "ok";
      if (!ok) console.log(`[webClient] likeMedia ${mediaId} response:`, JSON.stringify(j));
      if (!ok) {
        // Explicit action block from Instagram
        if (j?.message === "feedback_required" || j?.feedback_required === true) {
          const title = j?.feedback_title ?? "Action blocked";
          const expires = j?.expiration_time
            ? new Date(Number(j.expiration_time) * 1000).toISOString().split("T")[0]
            : "unknown";
          console.warn(`[webClient] likeMedia BLOCKED: ${title} (expires ~${expires})`);
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
    return this.timed("RefreshOwnProfile", async () => {
      const userIdCookie = this.cookieJar.find(c => c.startsWith("ds_user_id="));
      const userId = userIdCookie ? userIdCookie.split("=")[1] : null;
      if (!userId) return false;
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
  async viewTimelineFeed(count: number = 5): Promise<number> {
    // As of 2024 the timeline endpoint requires POST (GET returns 405).
    const j = await this.mobilePost(`/api/v1/feed/timeline/`, new URLSearchParams({ reason: "cold_start_fetch", is_pull_to_refresh: "0" }).toString());
    const rawItems: any[] = j?.feed_items ?? j?.items ?? [];
    if (!rawItems.length) return 0;

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
      await this.timed("ViewTimelineFeed", async () => {
        await this.mobilePost(`/api/v1/media/seen/`, new URLSearchParams({
          reels: `${mediaId}_${takenAt}_${takenAt + 3}`,
          live_vods_skipped: "",
          nuxes_skipped: "",
        }).toString());
        return ++viewed;
      }, (n) => `Viewed ${n} timeline post${n === 1 ? "" : "s"}`);
    }

    return viewed;
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
      const j = await this.mobileGet(`/api/v1/feed/reels_tray/`);
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
  // Fetches the DM inbox to simulate a user checking their messages.
  // Returns true if the inbox was fetched successfully.
  async getDirectMessages(count: number = 5): Promise<boolean> {
    return this.timed("GetDirectMessages", async () => {
      const j = await this.mobileGet(
        `/api/v1/direct_v2/inbox/?persistentBadging=true&visual_message_return_type=unseen&thread_message_limit=1&cursor=&limit=${count}`
      );
      const threads: any[] = j?.inbox?.threads ?? j?.threads ?? [];
      return { ok: !!(j?.inbox ?? j?.threads), count: threads.length };
    }, (r) => `Checked ${r.count} direct message${r.count === 1 ? "" : "s"}`);
  }

  // ── Fetch pending / message-request inbox (GetDirectMessagesInternal) ────
  // Simulates a user opening the message requests folder — non-followers'
  // DMs land here. Jarvee calls this as a second DM pass after the main inbox.
  async getDirectMessagesInternal(): Promise<{ count: number }> {
    return this.timed("GetDirectMessagesInternal", async () => {
      const j = await this.mobileGet(
        `/api/v1/direct_v2/inbox/?persistentBadging=true&visual_message_return_type=unseen&thread_message_limit=1&cursor=&limit=20`
      );
      const threads: any[] = j?.inbox?.threads ?? j?.threads ?? [];
      return { count: threads.length };
    }, (r) => `Checked DM inbox — ${r.count} thread${r.count === 1 ? "" : "s"}`);
  }

  // Like getDirectMessages but returns thread content for auto-reply scanning.
  // Returns up to `count` threads, each with recent messages from the other user.
  async getDMThreadsWithContent(count: number = 10): Promise<{
    threadId: string;
    username: string;
    userId: string;
    items: { itemId: string; text: string; fromMe: boolean }[];
  }[]> {
    return this.timed("GetDMThreadsContent", async () => {
      const j = await this.mobileGet(
        `/api/v1/direct_v2/inbox/?persistentBadging=true&visual_message_return_type=unseen&thread_message_limit=10&cursor=&limit=${count}`
      );
      const threads: any[] = j?.inbox?.threads ?? j?.threads ?? [];
      return threads.map((thread: any) => {
        const otherUser = (thread.users ?? [])[0];
        const myUserId = String(thread.viewer_id ?? thread.viewerId ?? "");
        const items: { itemId: string; text: string; fromMe: boolean }[] = (thread.items ?? [])
          .filter((item: any) => item?.item_type === "text" && item?.text)
          .map((item: any) => ({
            itemId: String(item.item_id ?? ""),
            text: String(item.text ?? ""),
            fromMe: String(item.user_id) === myUserId,
          }));
        return {
          threadId: String(thread.thread_id ?? ""),
          username: String(otherUser?.username ?? ""),
          userId: String(otherUser?.pk ?? ""),
          items,
        };
      }).filter(t => t.threadId && t.username);
    }, `Check DMs with content (limit=${count})`);
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

  async likeTimelinePosts(count: number = 3): Promise<{ liked: number; watched: number; likedPosts: Array<{ shortcode: string; ownerUsername: string; mediaId: string }> }> {
    return this.timed("LikeTimelinePosts", async () => {
      // As of 2024 the timeline endpoint requires POST (GET returns 405).
      const j = await this.mobilePost(`/api/v1/feed/timeline/`, new URLSearchParams({ reason: "cold_start_fetch", is_pull_to_refresh: "0" }).toString());
      const rawItems: any[] = j?.feed_items ?? j?.items ?? [];
      if (!rawItems.length) return { liked: 0, watched: 0, likedPosts: [] };

      // Unwrap feed items — timeline wraps media under media_or_ad
      const items = rawItems
        .map((raw: any) => raw?.media_or_ad ?? raw?.media ?? raw)
        .filter((m: any) => m?.id || m?.pk);

      const toProcess = items.slice(0, count);
      let liked = 0;
      let watched = 0;
      const likedPosts: Array<{ shortcode: string; ownerUsername: string; mediaId: string }> = [];

      for (const media of toProcess) {
        const mediaId = String(media?.id ?? media?.pk ?? "");
        if (!mediaId) continue;

        const isReel = media?.media_type === 2 || media?.product_type === "clips";

        // Watch the reel before liking — simulates the natural viewing flow
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

        // Like the post
        const result = await this.likeMedia(mediaId);
        if (result === "blocked") break;
        if (result) {
          liked++;
          const shortcode    = String(media?.code ?? "");
          const ownerUsername = String(media?.user?.username ?? "");
          likedPosts.push({ shortcode, ownerUsername, mediaId });
        }
      }

      return { liked, watched, likedPosts };
    }, (r) => r.watched > 0
        ? `Liked ${r.liked} timeline post${r.liked === 1 ? "" : "s"} (watched ${r.watched} reel${r.watched === 1 ? "" : "s"})`
        : `Liked ${r.liked} timeline post${r.liked === 1 ? "" : "s"}`);
  }

  // ── Unfollow a user ───────────────────────────────────────────────────────
  // Returns true on success, "blocked" on Instagram action-block, false otherwise.
  async unfollowUser(userId: string, username?: string): Promise<true | "blocked" | false> {
    return this.timed("UnfollowUser", async () => {
      const body = new URLSearchParams({ user_id: userId }).toString();
      const j = await this.webPost(`/api/v1/friendships/destroy/${userId}/`, body);
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

    const ig = new IgApiClient();

    // Restore device fingerprint
    if (this.igDeviceState) {
      try {
        const saved = JSON.parse(this.igDeviceState) as { deviceId?: string; uuid?: string; phoneId?: string; adid?: string; deviceString?: string };
        ig.state.generateDevice(saved.deviceString ?? "instagram");
        if (saved.deviceId)     ig.state.deviceId     = saved.deviceId;
        if (saved.uuid)         ig.state.uuid         = saved.uuid;
        if (saved.phoneId)      ig.state.phoneId      = saved.phoneId;
        if (saved.adid)         ig.state.adid         = saved.adid;
        if (saved.deviceString) ig.state.deviceString = saved.deviceString;
      } catch {
        ig.state.generateDevice("instagram");
      }
    } else {
      ig.state.generateDevice("instagram");
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

  // mobile-style POST (i.instagram.com)
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
      agent = new HttpsProxyAgent(this.proxyUrl);
    }

    const res = await httpsRequest(
      { host: "i.instagram.com", port: 443, path, method: "POST", headers, ...(agent ? { agent } : {}) },
      body,
    );
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
}
