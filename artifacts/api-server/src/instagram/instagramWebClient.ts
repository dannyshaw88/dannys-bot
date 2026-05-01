/**
 * Instagram Web API Client
 * Uses the web login flow (www.instagram.com) which works even when
 * the mobile private API is blocked by Instagram's app-version check.
 */
import * as https from "https";
import * as fs from "fs";
import { generateSync as totpGenerate } from "otplib";

// ── Low-level HTTPS helper ────────────────────────────────────────────────────
function httpsRequest(
  options: https.RequestOptions,
  body?: string,
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
    req.setTimeout(20000, () => { req.destroy(new Error("timeout")); });
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

  private async timed<T>(opName: string, fn: () => Promise<T>, message?: string): Promise<T> {
    const t0 = Date.now();
    const result = await fn();
    const ms = Date.now() - t0;
    this.logCallFn?.(opName, ms, message);
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
      const j = await this.mobileGet(`/api/v1/news/inbox/?mark_as_seen=false&warning_sweep_enabled=true`);
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

  // ── Refresh own profile feed ──────────────────────────────────────────────
  // Simulates a user pull-to-refreshing their profile page.
  async refreshOwnProfile(): Promise<boolean> {
    return this.timed("RefreshOwnProfile", async () => {
      const j = await this.mobileGet(`/api/v1/feed/self/?count=12`);
      return !!(j?.items || j?.status);
    }, "Refresh own profile");
  }

  // ── Click Settings and Activity ───────────────────────────────────────────
  // Simulates visiting the Settings page and the Activity (pro dashboard) page.
  async visitSettingsAndActivity(): Promise<boolean> {
    return this.timed("VisitSettingsAndActivity", async () => {
      // Settings: fetch account security info (settings deep-link)
      await this.mobileGet(`/api/v1/accounts/account_security_info/`);
      // Activity: mark inbox as seen (what happens when you open the activity tab)
      const j = await this.mobileGet(`/api/v1/news/inbox/?mark_as_seen=true`);
      return !!(j?.status !== "fail");
    }, "Visit settings and activity");
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
    }, `View timeline reels (up to ${count})`);
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
    }, `View timeline stories (up to ${count})`);
  }

  // ── Check direct messages inbox ──────────────────────────────────────────
  // Fetches the DM inbox to simulate a user checking their messages.
  // Returns true if the inbox was fetched successfully.
  async getDirectMessages(count: number = 5): Promise<boolean> {
    return this.timed("GetDirectMessages", async () => {
      const j = await this.mobileGet(
        `/api/v1/direct_v2/inbox/?persistentBadging=true&visual_message_return_type=unseen&thread_message_limit=1&cursor=&limit=${count}`
      );
      return !!(j?.inbox ?? j?.threads);
    }, `Check DMs (inbox, limit=${count})`);
  }

  // ── Like posts from the home timeline feed ───────────────────────────────
  // Fetches the home feed and likes up to `count` posts.
  // If a post is a reel/video (media_type === 2), it is marked as watched
  // before being liked, so Instagram sees a realistic view → like sequence.
  // Returns the number of posts liked and reels watched.
  async likeTimelinePosts(count: number = 3): Promise<{ liked: number; watched: number }> {
    return this.timed("LikeTimelinePosts", async () => {
      const j = await this.mobileGet(`/api/v1/feed/timeline/?reason=cold_start&is_pull_to_refresh=0`);
      const rawItems: any[] = j?.feed_items ?? j?.items ?? [];
      if (!rawItems.length) return { liked: 0, watched: 0 };

      // Unwrap feed items — timeline wraps media under media_or_ad
      const items = rawItems
        .map((raw: any) => raw?.media_or_ad ?? raw?.media ?? raw)
        .filter((m: any) => m?.id || m?.pk);

      const toProcess = items.slice(0, count);
      let liked = 0;
      let watched = 0;

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
        if (result) liked++;
      }

      return { liked, watched };
    }, `Like timeline posts (up to ${count})`);
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
  async sendDirectMessage(userId: string, text: string, username?: string): Promise<{ threadId: string; itemId: string } | "blocked" | false> {
    return this.timed("SendDM", async () => {
      const body = new URLSearchParams({
        recipient_users: `[[${userId}]]`,
        client_context: String(Date.now()),
        text,
      }).toString();
      const j = await this.mobilePost(`/api/v1/direct_v2/threads/broadcast/text/`, body);
      if (!j) return false;
      if (j?.message === "feedback_required" || j?.feedback_required === true) {
        console.warn(`[webClient] DM BLOCKED to ${userId}`);
        return "blocked";
      }
      if (j?.status === "ok") {
        const threadId: string = j?.payload?.thread_id ?? j?.thread_id ?? "";
        const itemId: string = j?.payload?.item_id ?? j?.item_id ?? "";
        return { threadId, itemId };
      }
      console.log(`[webClient] sendDM ${userId} response:`, JSON.stringify(j));
      return false;
    }, username ? `DM @${username}` : `DM user ${userId}`);
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
        "X-IG-App-ID": APP_ID,
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

  // ── Scrape recent posts from a hashtag → returns users ────────────────────
  // The sections endpoint requires POST, not GET
  async getHashtagUsers(hashtag: string, maxUsers = 50): Promise<{ pk: string; username: string }[]> {
    return this.timed("HashtagScrape", async () => {
      const tag = hashtag.replace(/^#/, "");
      const users: { pk: string; username: string }[] = [];
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
            users.push({ pk: String(u.pk), username: u.username });
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
  async getFollowers(userId: string, maxFollowers = 50): Promise<{ pk: string; username: string }[]> {
    return this.timed("FollowersScrape", async () => {
      const users: { pk: string; username: string }[] = [];
      let maxId = "";

      const maxPages = Math.min(Math.ceil(maxFollowers / 50) + 2, 25);
      for (let page = 0; page < maxPages && users.length < maxFollowers; page++) {
        const qs = new URLSearchParams({ count: "50", ...(maxId ? { max_id: maxId } : {}) });
        const j = await this.mobileGet(`/api/v1/friendships/${userId}/followers/?${qs}`);
        if (!j?.users?.length) break;
        for (const u of j.users) {
          if (u.pk && u.username) users.push({ pk: String(u.pk), username: u.username });
        }
        maxId = j.next_max_id ?? "";
        if (!maxId) break;
      }

      console.log(`[webClient] followers of ${userId}: found ${users.length}`);
      return users.slice(0, maxFollowers);
    }, `Followers of ${userId}`);
  }
}
