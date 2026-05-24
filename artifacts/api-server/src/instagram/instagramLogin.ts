import { IgApiClient, IgCheckpointError, IgLoginTwoFactorRequiredError, IgLoginBadPasswordError, IgLoginInvalidUserError } from "instagram-private-api";
import { randomBytes } from "crypto";
import { generateSync as totpGenerate } from "otplib";
import { db } from "@workspace/db";
import { instagramApiCalls } from "../shared/schema";
import type { Profile } from "../shared/schema";
import { storage } from "../storage";
import { MOBILE_VERSION, MOBILE_VERSION_CODE } from "./instagramWebClient";

export type VerifyResult =
  | { ok: true; message: string; accountStatus: "valid"; igDeviceState?: string; igApiCookies?: string }
  | { ok: false; message: string; accountStatus: "banned" | "captcha" | "2fa_verification" | "phone_verification" | "email_confirmation" | "logged_out" | "bad_password" | "invalid_credentials"; igDeviceState?: string; checkpointUrl?: string };

// Parse app version and version code from a FULL Instagram mobile user-agent string.
// UA format: "Instagram 361.0.0.32.109 Android (30/11; 480dpi; 1080x2400; samsung; SM-G998B; ...; en_US; 558538758)"
// Returns null when the stored value is just the device params string (no version prefix).
function parseIgUaVersion(ua: string): { version: string; versionCode: string } | null {
  const m = ua.match(/^Instagram ([\d.]+) Android \(([^)]+)\)/);
  if (!m) return null;
  const version = m[1];
  const parts = m[2].split(";");
  const versionCode = parts[parts.length - 1].trim();
  if (!versionCode || !/^\d+$/.test(versionCode)) return null;
  return { version, versionCode };
}

// Extract ONLY the hardware device params from a userAgentApi string.
//
// The library's appUserAgent getter is:
//   `Instagram ${appVersion} Android (${deviceString}; ${language}; ${appVersionCode})`
//
// So ig.state.deviceString must contain ONLY the hardware portion, e.g.:
//   "33/13; 420dpi; 1080x2224; samsung; SM-G960F; starlte; exynos9810"
//
// userAgentApi can come in two formats from Jarvee:
//   A) Full UA:      "Instagram 427.0.0.47.73 Android (33/13; 420dpi; ...; exynos9810; en_US; 746996204)"
//   B) Device params:"33/13; 420dpi; 1080x2224; samsung; SM-G960F; starlte; exynos9810; en_US"
//      (Jarvee omits the version code in its export but the locale is present)
//
// Both cases: strip outer UA wrapper, then strip trailing version code and locale so
// the library can append "; language; versionCode" in the correct format.
function extractDeviceString(userAgentApi: string): string {
  let params = userAgentApi.trim();

  // Case A: strip "Instagram VERSION Android (" prefix and trailing ")"
  const m = params.match(/^Instagram [\d.]+ Android \(([^)]+)\)/);
  if (m) params = m[1];

  const parts = params.split(";").map(s => s.trim()).filter(Boolean);

  // Strip trailing version code (pure digits, e.g. "746996204")
  if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) parts.pop();

  // Strip trailing locale (only letters + underscore, e.g. "en_US")
  if (parts.length > 1 && /^[a-zA-Z_]+$/.test(parts[parts.length - 1])) parts.pop();

  return parts.join("; ");
}

// Extract the Instagram challenge URL from an IgCheckpointError.
// IgCheckpointError.message getter returns "https://i.instagram.com/challenge/" + api_path.
function extractCheckpointUrl(err: any): string | undefined {
  if (!(err instanceof IgCheckpointError)) return undefined;
  try {
    const msg: string = err.message ?? "";
    if (msg.includes("instagram.com/challenge")) return msg;
    const challenge = err?.response?.body?.challenge;
    if (challenge?.url) {
      const u: string = challenge.url;
      return u.startsWith("http") ? u : `https://i.instagram.com${u}`;
    }
  } catch { /* ignore */ }
  return undefined;
}

/** Enforce the per-profile API rate limit between individual cold-start calls.
 *  Uses the exact same formula as InstagramWebClient.apiThrottle() so that
 *  every API call — including the login/verify handshake — obeys the user's settings. */
async function loginApiThrottle(
  apiLimits: { requestsMin: number; requestsMax: number; everySecondsMin: number; everySecondsMax: number } | null | undefined,
): Promise<void> {
  if (!apiLimits) return;
  const reqMin = Math.max(1, apiLimits.requestsMin);
  const reqMax = Math.max(reqMin, apiLimits.requestsMax);
  const secMin = Math.max(0, apiLimits.everySecondsMin / 1000);
  const secMax = Math.max(secMin, apiLimits.everySecondsMax / 1000);
  const calls   = reqMin  + Math.random() * (reqMax  - reqMin);
  const secs    = secMin  + Math.random() * (secMax  - secMin);
  const delayMs = Math.floor((secs / Math.max(1, calls)) * 1000);
  if (delayMs > 10) {
    await new Promise<void>(r => setTimeout(r, delayMs));
  }
}

async function logApiCall(
  profileId: number,
  username: string,
  operationName: string,
  status: string,
  source: string,
  navChain: string,
  ipAddress: string,
  durationMs: number,
) {
  try {
    await db.insert(instagramApiCalls).values({
      profileId,
      username,
      operationName,
      date: new Date().toISOString(),
      message: status,
      source,
      navChain,
      ipAddress,
      durationMs,
    });
  } catch { /* never crash on logging failure */ }
}

async function buildProxyUrl(profile: Profile): Promise<{ url: string; host: string } | null> {
  // proxyId (Proxy Manager entry) takes priority over inline proxyHost/proxyPort fields.
  if (profile.proxyId) {
    const proxies = await storage.getProxies();
    const p = proxies.find(px => px.id === profile.proxyId);
    if (p && p.host && p.port) {
      const auth = p.username && p.password
        ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@`
        : "";
      return { url: `http://${auth}${p.host}:${p.port}`, host: p.host };
    }
  }
  if (profile.proxyHost && profile.proxyPort) {
    const auth = profile.proxyUsername && profile.proxyPassword
      ? `${encodeURIComponent(profile.proxyUsername)}:${encodeURIComponent(profile.proxyPassword)}@`
      : "";
    return { url: `http://${auth}${profile.proxyHost}:${profile.proxyPort}`, host: profile.proxyHost };
  }
  return null;
}

/** Map a raw Instagram API URL to a Jarvee-style human-readable operation name */
function extractOperationName(rawUrl: string): string {
  const path = rawUrl.split("?")[0]
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/^\/api\/v\d+\//, "")
    .replace(/\/$/, "");

  // Exact path → friendly name (Jarvee-compatible where possible)
  const EXACT: Record<string, string> = {
    // Pre-login setup
    "si/fetch_headers":                        "FetchHeaders",
    "qe/sync":                                 "FetchConfig",
    "qe/sync_experiments":                     "FetchConfig",
    "launcher/sync":                           "SendMobileConfig",
    "zr/token/result":                         "GetTokenResult",
    "accounts/read_msisdn_header":             "ReadMsisdnHeader",
    "accounts/msisdn_header_bootstrap":        "SendMsisdnBootstrap",
    "accounts/contact_point_prefill":          "ContactPointPrefill",
    "accounts/get_prefill_candidates":         "GetPrefillCandidates",
    "accounts/tokens/keyed":                   "GetKeyedTokens",
    "accounts/loginattribution/log_attribution": "LogAttribution",
    // Login / session
    "accounts/login":                          "SendLoginRequest",
    "accounts/two_factor_login":               "SendLoginRequest2FA",
    "accounts/logout":                         "Logout",
    "accounts/save_credentials":               "SaveCredentials",
    "accounts/get_account_family":             "GetAccountFamily",
    // Own account
    "accounts/current_user":                   "GetOwnUser",
    "users/self":                              "GetOwnUser",
    // Feed & discovery
    "feed/timeline":                           "GetTimeLineFeed",
    "feed/reels_tray":                         "GetReelsTray",
    "feed/liked":                              "GetLikedFeed",
    "discover/explore":                        "ExecuteDiscoverExplore",
    "discover/top_live":                       "GetTopLive",
    // Stories
    "feed/reels_media":                        "GetStoriesMedia",
    "feed/user":                               "GetUserFeed",
    // Notifications
    "news/inbox":                              "ExecuteNotificationsBadge",
    "news/activities":                         "GetActivityFeed",
    // Direct messages
    "direct_v2/inbox":                         "GetInbox",
    "direct_v2/pending_inbox":                 "GetPendingInbox",
    "direct_v2/threads/broadcast/text":        "SendDM",
    "direct_v2/threads/broadcast/link":        "SendDMLink",
    "direct_v2/threads/broadcast/unlink_item": "UnsendDM",
    "direct_v2/threads/broadcast/like":        "SendDMLike",
    // Media
    "media/like":                              "LikeMedia",
    "media/unlike":                            "UnlikeMedia",
    "media/configure":                         "PostPhoto",
    "media/configure_sidecar":                 "PostCarousel",
    "media/upload_finish":                     "UploadMedia",
    // Tags / hashtags
    "tags/search":                             "SearchHashtag",
    // Search
    "fbsearch/topsearch":                      "SearchUser",
    "users/search":                            "SearchUser",
    // Collections / highlights
    "highlights/create_reel":                  "CreateHighlight",
  };

  if (EXACT[path]) return EXACT[path];

  // Prefix patterns (paths with dynamic ID segments)
  const PREFIX: [string, string][] = [
    ["friendships/create/",        "Follow"],
    ["friendships/destroy/",       "Unfollow"],
    ["friendships/show/",          "GetFriendshipStatus"],
    ["friendships/following/",     "GetFollowing"],
    ["friendships/followers/",     "GetFollowers"],
    ["users/",                     "GetUserProfile"],
    ["media/",                     "GetMediaInfo"],
    ["direct_v2/threads/",         "GetThread"],
    ["tags/",                      "GetHashtagFeed"],
    ["accounts/",                  "AccountAction"],
    ["launcher/",                  "SendMobileConfig"],
    ["qe/",                        "FetchConfig"],
  ];

  for (const [prefix, name] of PREFIX) {
    if (path.startsWith(prefix)) return name;
  }

  // Fallback: last meaningful path segment, CamelCased
  const segment = path.split("/").filter(Boolean).pop() ?? path;
  return segment.replace(/_([a-z])/g, (_, c) => c.toUpperCase()).replace(/^./, c => c.toUpperCase());
}

/** Pull a named key out of a URL-encoded form body string */
function extractFromBody(body: string | Buffer | undefined, key: string): string {
  if (!body) return "";
  try {
    const str = Buffer.isBuffer(body) ? body.toString() : String(body);
    const params = new URLSearchParams(str);
    return params.get(key) ?? "";
  } catch { return ""; }
}

/**
 * Monkey-patch ig.request.send so every Instagram API call is logged with real
 * data: endpoint, HTTP status, duration, nav_chain from the request body, and
 * the proxy IP. This works correctly where end$.subscribe does NOT — the library
 * calls end$.next() with zero arguments so subscribers always receive undefined.
 */
export function attachRequestLogger(
  ig: IgApiClient,
  profileId: number,
  username: string,
  source: string,
  proxyIp: string,
  apiLimits?: { requestsMin: number; requestsMax: number; everySecondsMin: number; everySecondsMax: number } | null,
) {
  const req = ig.request as any;
  if (req.__logged) return; // prevent double-patching
  req.__logged = true;

  const originalSend = req.send.bind(req);
  req.send = async function(userOptions: any, onlyCheckHttpStatus?: boolean) {
    // Enforce the per-profile API rate limit on EVERY single Instagram API call.
    await loginApiThrottle(apiLimits);
    const t0 = Date.now();
    const rawUrl: string = userOptions?.url || userOptions?.uri || "";
    const opName = extractOperationName(rawUrl);

    // ── Deep debug: log the outgoing request body for login endpoint ────────
    const isLoginEndpoint = rawUrl.includes("/accounts/login/");
    if (isLoginEndpoint) {
      const form: Record<string, string> = userOptions?.form ?? {};
      const debugForm: Record<string, string> = {};
      for (const [k, v] of Object.entries(form)) {
        // Mask the encrypted password — show format prefix only
        if (k === "enc_password") {
          const str = String(v);
          const prefix = str.startsWith("#PWD_INSTAGRAM:") ? str.slice(0, str.lastIndexOf(":") + 8) + "…[MASKED]" : "[MASKED]";
          debugForm[k] = prefix;
        } else {
          debugForm[k] = String(v);
        }
      }
      console.error(`[instagramLogin] LOGIN REQUEST @${username} proxy=${proxyIp} form=${JSON.stringify(debugForm)}`);
    }

    let response: any;
    let statusStr = "";
    try {
      response = await originalSend(userOptions, onlyCheckHttpStatus);
      // Success: show clean "200 OK" — never include the URL
      statusStr = "OK";
    } catch (err: any) {
      const durationMs = Date.now() - t0;
      const code: number = err?.statusCode ?? err?.response?.statusCode ?? 0;
      // Pull Instagram's own message from the response body — it's informative
      // and doesn't include the URL (unlike err.message which does).
      const body = err?.response?.body ?? {};
      const igMsg: string =
        body.message ||
        body.error_title ||
        (body.two_factor_required  ? "Two-factor authentication required"  : "") ||
        (body.checkpoint_required  ? "Checkpoint required"                 : "") ||
        "";
      const HTTP_PHRASES: Record<number, string> = {
        400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
        404: "Not Found",   429: "Rate Limited", 500: "Server Error",
      };
      const phrase = HTTP_PHRASES[code] ?? (code ? `HTTP ${code}` : "Error");
      statusStr = code
        ? (igMsg ? `${code} — ${igMsg.slice(0, 100)}` : `${code} ${phrase}`)
        : (phrase);

      // ── Deep debug: on login failure log full response headers + body ───
      if (isLoginEndpoint) {
        const resHeaders = err?.response?.headers ?? {};
        const relevantHeaders: Record<string, string> = {};
        for (const h of ["x-ig-response-type", "x-ig-set-password-encryption-key-id", "x-ig-set-password-encryption-pub-key", "www-authenticate", "x-ig-error-code", "content-type"]) {
          if (resHeaders[h]) relevantHeaders[h] = resHeaders[h];
        }
        console.error(`[instagramLogin] LOGIN FAILURE @${username} proxy=${proxyIp} status=${code} headers=${JSON.stringify(relevantHeaders)} body=${JSON.stringify(body)}`);
      }

      // Extract nav_chain from the original request body even on error
      const bodyStr: string = userOptions?.form
        ? new URLSearchParams(userOptions.form).toString()
        : (typeof userOptions?.body === "string" ? userOptions.body : "");
      const navChain = extractFromBody(bodyStr, "nav_chain");
      logApiCall(profileId, username, opName, statusStr, source, navChain, proxyIp, durationMs).catch(() => {});
      throw err;
    }

    const durationMs = Date.now() - t0;
    // nav_chain lives in the outgoing request body (URL-encoded form)
    const sentBody: string | Buffer | undefined = response?.request?.body;
    const navChain = extractFromBody(sentBody, "nav_chain");
    logApiCall(profileId, username, opName, statusStr, source, navChain, proxyIp, durationMs).catch(() => {});
    return response;
  };
}

// ── Fetch Instagram's RSA encryption keys before login ────────────────────────
// The library reads ig-set-password-encryption-key-id / ig-set-password-encryption-pub-key
// from ANY response header automatically. Without these, encryptPassword() crashes
// and Instagram returns a false "bad password" error.
async function ensureEncryptionKeys(ig: IgApiClient): Promise<void> {
  // Strategy 1: si/fetch_headers — lightweight, no auth required, always returns the keys
  try {
    await ig.request.send({
      method: "GET",
      url: "/api/v1/si/fetch_headers/",
      qs: { challenge_type: "signup", guid: ig.state.uuid },
    });
    if (ig.state.passwordEncryptionPubKey) {
      console.error(`[instagramLogin] Got encryption keys via si/fetch_headers (keyId=${ig.state.passwordEncryptionKeyId})`);
      return;
    }
  } catch (e: any) {
    console.error(`[instagramLogin] si/fetch_headers failed: ${e?.message}`);
  }

  // Strategy 2: qe/sync (minimal — no experiments field to avoid "400 Invalid experiment"
  // from the library's outdated LOGIN_EXPERIMENTS list vs our declared app version)
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
    if (ig.state.passwordEncryptionPubKey) {
      console.error(`[instagramLogin] Got encryption keys via qe/sync (keyId=${ig.state.passwordEncryptionKeyId})`);
      return;
    }
  } catch (e: any) {
    console.error(`[instagramLogin] qe/sync failed: ${e?.message}`);
  }

  // Strategy 3: read_msisdn_header
  try {
    await ig.account.readMsisdnHeader();
    if (ig.state.passwordEncryptionPubKey) {
      console.error(`[instagramLogin] Got encryption keys via readMsisdnHeader (keyId=${ig.state.passwordEncryptionKeyId})`);
      return;
    }
  } catch (e: any) {
    console.error(`[instagramLogin] readMsisdnHeader failed: ${e?.message}`);
  }

  console.error(`[instagramLogin] WARNING: could not fetch encryption keys — login will fail`);
}

/**
 * Load Jarvee-style cookie string (sessionid=X;ds_user_id=Y;mid=Z) into an IgApiClient's
 * cookie jar so we can reuse an existing session without a fresh password login.
 */
async function restoreSessionCookies(ig: IgApiClient, cookieString: string): Promise<void> {
  const pairs = cookieString.split(';').map(s => s.trim()).filter(Boolean);
  const now = new Date().toISOString();

  const cookies = pairs.flatMap(pair => {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) return [];
    const key = pair.slice(0, eqIdx).trim();
    // Jarvee URL-encodes cookie values (e.g. ":" → "%3A"). Decode so Instagram
    // receives the raw value it originally issued (e.g. "sessionid=123:abc:...")
    // instead of the percent-encoded form it does not recognise.
    let value = pair.slice(eqIdx + 1).trim();
    try { value = decodeURIComponent(value); } catch { /* keep as-is if malformed */ }
    // Set on both the host-only domain and the wildcard domain Instagram checks
    return [
      { key, value, domain: 'i.instagram.com', path: '/', secure: true, httpOnly: true, hostOnly: true, creation: now, lastAccessed: now },
      { key, value, domain: '.instagram.com',  path: '/', secure: true, httpOnly: true, hostOnly: false, creation: now, lastAccessed: now },
    ];
  });

  await ig.state.deserializeCookieJar(JSON.stringify({
    version: 'tough-cookie@4.1.3',
    storeType: 'MemoryCookieStore',
    rejectPublicSuffixes: true,
    cookies,
  }));
}

/**
 * After a successful password login, extract the session cookies from the
 * IgApiClient's cookie jar and return them as a Jarvee-style semicolon string
 * (e.g. "sessionid=X;ds_user_id=Y;csrftoken=Z;mid=W") so they can be stored
 * as igApiCookies and reused by the follow/unfollow/DM tools on Path 2.
 */
async function extractSessionCookies(ig: IgApiClient): Promise<string | null> {
  try {
    const raw = await ig.state.serializeCookieJar();
    // serializeCookieJar() returns a plain object, not a JSON string — do NOT JSON.parse it
    const jar = (typeof raw === "string" ? JSON.parse(raw) : raw) as { cookies?: { key: string; value: string; domain?: string }[] };
    const KEEP = new Set(["sessionid", "ds_user_id", "csrftoken", "mid", "ig_did", "rur"]);
    const seen = new Set<string>();
    const pairs: string[] = [];
    for (const c of jar.cookies ?? []) {
      if (KEEP.has(c.key) && !seen.has(c.key) && c.value) {
        seen.add(c.key);
        pairs.push(`${c.key}=${c.value}`);
      }
    }
    if (!seen.has("sessionid")) {
      const allKeys = (jar.cookies ?? []).map((c: any) => c.key ?? c.name ?? "(?)").join(",");
      // The proxy strips all Set-Cookie headers so sessionid never lands in the jar.
      // The ig-set-authorization Bearer token (saved in igDeviceState) is the real
      // session credential. Return whatever cookies we have — the auth token path works
      // without sessionid in igApiCookies.
      if (pairs.length === 0) {
        console.error(`[instagramLogin] extractSessionCookies: no cookies at all — jar has ${(jar.cookies ?? []).length} entries: [${allKeys}]`);
        return null;
      }
      console.error(`[instagramLogin] extractSessionCookies: no sessionid (proxy strips Set-Cookie) — saving ${pairs.length} available cookies: [${pairs.map(p => p.split("=")[0]).join(",")}]`);
    }
    return pairs.join(";");
  } catch (e: any) {
    console.error(`[instagramLogin] extractSessionCookies failed: ${e?.message}`);
    return null;
  }
}

function buildIgClient(profile: Profile, proxyUrl: string | null): { ig: IgApiClient; captureDeviceState: () => string } {
  // ── IP-LEAK PREVENTION ────────────────────────────────────────────────────
  // The IgApiClient routes all mobile-API traffic.  Without a proxy URL the
  // library sends requests direct — exposing the server/home IP to Instagram.
  if (!proxyUrl) {
    throw new Error(
      `[IP-LEAK BLOCKED] buildIgClient called without proxy for @${profile.username}. ` +
      "Assign a proxy before verifying or using this account."
    );
  }
  const ig = new IgApiClient();
  // request-promise has no default timeout — hang indefinitely on dead proxies
  // without this, leading to FD exhaustion and server unresponsiveness after ~1h.
  // CRITICAL: spread existing defaults so the library's cookie jar is preserved.
  // Assigning { timeout } directly replaces the whole object, wiping the jar —
  // no cookies are ever stored, csrftoken stays "missing", login fails.
  ig.request.defaults = { ...ig.request.defaults, timeout: 30000 };
  // ALWAYS include username in the seed so that accounts sharing the same userAgentApi
  // (same device model) still generate distinct uuid/deviceId/phoneId fingerprints.
  // Without the username, two accounts with the same UA string would get identical
  // device IDs and Instagram would detect the same device logging into multiple accounts.
  const deviceSeed = (profile.userAgentApi ?? profile.username) + "|" + profile.username;

  // ── Device IDs: restore saved or generate fresh ──────────────────────────
  // deviceId/uuid/phoneId/adid are ALWAYS restored from igDeviceState when present
  // so that Instagram sees the same device fingerprint on every verify attempt.
  //
  // deviceString is NEVER restored from igDeviceState — it is always re-derived
  // from userAgentApi via extractDeviceString(). This ensures old/corrupted saved
  // values (which may have contained the full UA or doubled locale/versionCode)
  // are automatically corrected without needing a manual reset.
  if (profile.igDeviceState) {
    try {
      const saved = JSON.parse(profile.igDeviceState);
      ig.state.generateDevice(deviceSeed);
      if (saved.deviceId) ig.state.deviceId = saved.deviceId;
      if (saved.uuid) ig.state.uuid = saved.uuid;
      if (saved.phoneId) ig.state.phoneId = saved.phoneId;
      if (saved.adid) ig.state.adid = saved.adid;
      // deviceString: always re-derive from userAgentApi (not from saved state)
      if (profile.userAgentApi) ig.state.deviceString = extractDeviceString(profile.userAgentApi);
      console.error(`[instagramLogin] Restored device IDs for @${profile.username} (deviceId=${ig.state.deviceId} uuid=${ig.state.uuid?.slice(0,8)}… deviceString="${ig.state.deviceString}")`);
    } catch {
      ig.state.generateDevice(deviceSeed);
      if (profile.userAgentApi) ig.state.deviceString = extractDeviceString(profile.userAgentApi);
    }
  } else {
    ig.state.generateDevice(deviceSeed);
    if (profile.userAgentApi) ig.state.deviceString = extractDeviceString(profile.userAgentApi);
    console.error(`[instagramLogin] No saved device state for @${profile.username} — generated fresh IDs (deviceId=${ig.state.deviceId} uuid=${ig.state.uuid?.slice(0,8)}… deviceString="${ig.state.deviceString}")`);
  }

  // ── App version constants ─────────────────────────────────────────────────
  // Parse version from userAgentApi when it's a full UA (format A).
  // Falls back to MOBILE_VERSION when userAgentApi is device-params-only (format B).
  // BLOKS_VERSION_ID and SIGNATURE_KEY must match the declared app version —
  // the library ships v222-era values which Instagram detects as a mismatch.
  ig.state.constants.BLOKS_VERSION_ID = "7189b949425f9bf80ea8bd880cf5a3080b292d9b1c4b38a18d112f7c4b71e7a8";
  ig.state.capabilitiesHeader = "3brTvwQ=";
  ig.state.constants.SIGNATURE_KEY = "fc4e50e6811bb3ff04fb58c49a70b8c9b23a9cde8d74e574c5987d9ebfbf1818";

  {
    const parsed = parseIgUaVersion(profile.userAgentApi ?? "");
    const version     = parsed?.version     ?? MOBILE_VERSION;
    const versionCode = parsed?.versionCode ?? MOBILE_VERSION_CODE;
    ig.state.constants.APP_VERSION      = version;
    ig.state.constants.APP_VERSION_CODE = versionCode;
    // Verify the final assembled UA so it appears in server logs for debugging.
    // appUserAgent = `Instagram ${version} Android (${deviceString}; ${language}; ${versionCode})`
    console.error(`[instagramLogin] UA for @${profile.username}: "${ig.state.appUserAgent}" (version=${version} versionCode=${versionCode})`);
  }

  if (proxyUrl) ig.state.proxyUrl = proxyUrl;

  // ── ig_did (Instagram Device ID) cookie ──────────────────────────────────
  // The real Instagram app receives ig_did via Set-Cookie from Instagram's
  // servers on first contact. Our proxy strips Set-Cookie, so ig_did is
  // never stored — every request looks like a brand-new device to Instagram,
  // which is what causes the device-trust / email-confirmation challenge.
  //
  // Fix: generate ig_did deterministically from the same seed so it is
  // identical across every verify attempt for this account. If a prior
  // igDeviceState already has a saved ig_did, use that (continuity for
  // accounts that have already been challenged and had their device verified
  // via email).
  let igDid: string;
  try {
    const saved = profile.igDeviceState ? JSON.parse(profile.igDeviceState) : null;
    if (saved?.igDid) {
      igDid = saved.igDid;
    } else {
      // Check igApiCookies for the Chrome-issued ig_did before falling back to
      // the UA-seeded phoneId.  On a first-time verify, igDeviceState is empty
      // but the verify route includes ig_did in the cookie string extracted from
      // Chrome.  Using the same ig_did that Chrome presented to Instagram keeps
      // the mobile API on the same device identity as the embedded browser.
      const igDidFromCookies = profile.igApiCookies
        ?.split(";")
        .map(s => s.trim())
        .find(s => s.startsWith("ig_did="))
        ?.slice("ig_did=".length)
        .trim();
      igDid = igDidFromCookies || ig.state.phoneId;
    }
    const innerJar = (ig.state as any).cookieJar?._jar;
    if (innerJar?.setCookieSync) {
      innerJar.setCookieSync(
        `ig_did=${igDid}; Domain=.instagram.com; Path=/; Secure`,
        "https://i.instagram.com/",
      );
      console.error(`[instagramLogin] Injected ig_did=${igDid} for @${profile.username}`);
    }
  } catch (e: any) {
    igDid = ig.state.phoneId;
    console.error(`[instagramLogin] ig_did injection failed for @${profile.username}: ${e?.message}`);
  }

  const captureDeviceState = () => JSON.stringify({
    v: 3,
    deviceId: ig.state.deviceId,
    uuid: ig.state.uuid,
    phoneId: ig.state.phoneId,
    adid: ig.state.adid,
    deviceString: ig.state.deviceString,
    igDid,
    // ig-set-authorization is a normal response header (not a cookie) so the proxy
    // cannot strip it. It contains Bearer IGT:2:... and is the real session credential
    // when the proxy strips all Set-Cookie (meaning sessionid is never in the jar).
    authorization: ig.state.authorization ?? undefined,
    igWWWClaim: ig.state.igWWWClaim ?? undefined,
  });

  return { ig, captureDeviceState };
}

export async function verifyInstagramCredentials(profile: Profile): Promise<VerifyResult> {
  const caller = new Error().stack?.split("\n").slice(2, 4).join(" | ") ?? "unknown";
  console.log(`[verify-audit] verifyInstagramCredentials called for @${profile.username} (status="${profile.accountStatus}") caller=${caller}`);
  const resolved = await buildProxyUrl(profile);
  if (!resolved) {
    return {
      ok: false,
      message: `@${profile.username} — no proxy assigned. Assign a proxy before verifying.`,
      accountStatus: "pending",
    };
  }
  const proxyUrl = resolved?.url ?? null;
  const proxyIp = resolved?.host ?? "direct";
  console.error(`[instagramLogin] @${profile.username} proxy=${resolved?.host}`);

  // ── Verification priority ─────────────────────────────────────────────────
  // 1. Fresh password login — used when a password is stored.
  //    Definitive credential check: proves the username+password combination
  //    is currently accepted by Instagram's API.
  //
  // 2. Cookie session restore — used only when no password is stored.
  //    For accounts managed purely by session cookie.

  // "Real session" = either a sessionid cookie (traditional) OR a Bearer token in
  // igDeviceState (proxy-stripped-cookie path). Synthetic cookies (ig_did/mid/csrftoken)
  // without a sessionid or Bearer token are NOT a real session — they're just device
  // fingerprint cookies saved by extractSessionCookies after the first login.
  // Path 1 must NOT be skipped just because those synthetic cookies are present.
  const hasSavedSessionid = !!profile.igApiCookies?.split(';').some((s: string) => s.trim().toLowerCase().startsWith('sessionid='));
  const hasSavedBearer = (() => {
    try { return !!(profile.igDeviceState && (JSON.parse(profile.igDeviceState) as any).authorization); } catch { return false; }
  })();

  if (profile.password && !hasSavedSessionid && !hasSavedBearer) {
    // ── Path 1: Fresh password login — ONLY for accounts with no real active session ──
    // CRITICAL: Do NOT run a password login when a real session already exists. Instagram
    // treats a fresh mobile API login as a NEW device login attempt. When the account
    // already has an active mobile session (sessionid cookie or Bearer token), this new
    // attempt looks like an account takeover and triggers an immediate lock.
    // Accounts with a real session go directly to Path 2 (session validation).
    console.error(`[instagramLogin] @${profile.username} — attempting fresh password login (no real active session: hasSavedSessionid=${hasSavedSessionid} hasSavedBearer=${hasSavedBearer})`);
    const { ig: igPw, captureDeviceState: capturePw } = buildIgClient(profile, proxyUrl);
    attachRequestLogger(igPw, profile.id, profile.username, "Verify", proxyIp, profile.apiLimits as any);

    // ── Jarvee-exact pre-login sequence (confirmed 2026-05) ──────────────
    // Source: Jarvee API call log — reading bottom=first by timestamp:
    //   1. SendMobileConfig (BeforeLogin) — WITH NavChain  ← launcher/sync
    //   2. SendLoginRequest (BeforeLogin) — WITH NavChain  ← the login call
    // That is the COMPLETE pre-login sequence. No prefill, no msisdn,
    // no fetch_headers. NavChain is active from the very first call.

    // Generate nav chain timestamp — used for ALL calls (pre + post login)
    const loginNavChainTs = (Date.now() / 1000).toFixed(3);
    const loginNavChain = `com.bloks.www.caa.login.login_homepage:com.bloks.www.caa.login.login_homepage:1:button:${loginNavChainTs}::`;

    // ── Step 1: Inject NavChain into ALL subsequent ig client requests ────
    const origSend = igPw.request.send.bind(igPw.request);
    (igPw.request as any).send = function(userOptions: any, ...rest: any[]) {
      const patched = {
        ...userOptions,
        headers: { "X-IG-Nav-Chain": loginNavChain, ...(userOptions?.headers ?? {}) },
      };
      return origSend(patched, ...rest);
    };
    console.error(`[instagramLogin] @${profile.username} — NavChain wrapper active: ${loginNavChain}`);

    // ── Step 2: SendMobileConfig (launcher/sync) WITH NavChain ────────────
    // This is Jarvee's only pre-login call. It also returns the password
    // encryption keys in response headers, so ensureEncryptionKeys is called
    // after this rather than before it.
    try {
      await (igPw as any).launcher?.preLoginSync?.();
      console.error(`[instagramLogin] @${profile.username} pre-login: SendMobileConfig (launcherPreLoginSync) OK`);
    } catch (e: any) {
      console.error(`[instagramLogin] @${profile.username} pre-login: SendMobileConfig failed (non-fatal): ${e?.message}`);
    }

    // ── Step 3: Ensure encryption keys are available ──────────────────────
    // launcherPreLoginSync returns ig-set-password-encryption-* headers.
    // If they weren't captured (proxy stripped them), fall back to qe/sync.
    if (!igPw.state.passwordEncryptionPubKey) {
      try {
        await igPw.request.send({
          url: "/api/v1/qe/sync/",
          method: "POST",
          form: igPw.request.sign({
            id: igPw.state.uuid,
            server_config_retrieval: "1",
            _csrftoken: igPw.state.cookieCsrfToken,
            _uuid: igPw.state.uuid,
          }),
        });
        console.error(`[instagramLogin] @${profile.username} — encryption keys via qe/sync fallback (keyId=${igPw.state.passwordEncryptionKeyId})`);
      } catch (e: any) {
        console.error(`[instagramLogin] @${profile.username} — qe/sync fallback failed: ${e?.message}`);
      }
    } else {
      console.error(`[instagramLogin] @${profile.username} — encryption keys from launcherPreLoginSync (keyId=${igPw.state.passwordEncryptionKeyId})`);
    }

    if (!igPw.state.passwordEncryptionPubKey) {
      console.error(`[instagramLogin] @${profile.username} — could not fetch encryption keys (proxy/network issue)`);
      return {
        ok: false,
        message: `@${profile.username} — could not reach Instagram servers. Check your proxy or network connection.`,
        accountStatus: "logged_out",
      };
    }

    // ── Step 4: Inject mid and csrftoken if not set by launcher/sync ─────
    const midCookie = igPw.state.extractCookie?.("mid");
    if (!midCookie?.value) {
      const syntheticMid = Buffer.from(igPw.state.uuid.replace(/-/g, ""), "hex").toString("base64").replace(/=/g, "");
      try {
        const innerJar = (igPw.state as any).cookieJar?._jar;
        if (innerJar?.setCookieSync) {
          innerJar.setCookieSync(`mid=${syntheticMid}; Domain=.instagram.com; Path=/; Secure`, "https://i.instagram.com/");
          console.error(`[instagramLogin] @${profile.username} — injected synthetic mid=${syntheticMid}`);
        }
      } catch (e: any) {
        console.error(`[instagramLogin] @${profile.username} — mid injection failed: ${e?.message}`);
      }
    } else {
      console.error(`[instagramLogin] @${profile.username} — mid from launcher/sync: ${midCookie.value}`);
    }

    if (igPw.state.cookieCsrfToken === "missing") {
      const syntheticCsrf = randomBytes(16).toString("hex");
      try {
        const innerJar = (igPw.state as any).cookieJar?._jar;
        if (innerJar?.setCookieSync) {
          innerJar.setCookieSync(`csrftoken=${syntheticCsrf}; Domain=.instagram.com; Path=/; Secure`, "https://i.instagram.com/");
          console.error(`[instagramLogin] @${profile.username} — injected synthetic csrftoken`);
        }
      } catch (e: any) {
        console.error(`[instagramLogin] @${profile.username} — csrftoken injection failed: ${e?.message}`);
      }
    }

    // ── Pre-login metadata snapshot ───────────────────────────────────────
    const pwLen = profile.password?.length ?? 0;
    const pwHint = pwLen > 0 ? `${profile.password![0]}${"*".repeat(Math.min(pwLen - 2, 6))}${pwLen > 1 ? profile.password![pwLen - 1] : ""}` : "(empty)";
    console.error(
      `[instagramLogin] @${profile.username} pre-login metadata:` +
      ` password_len=${pwLen} password_hint="${pwHint}"` +
      ` has_igApiCookies=${!!profile.igApiCookies}` +
      ` has_igDeviceState=${!!profile.igDeviceState}` +
      ` has_userAgentApi=${!!profile.userAgentApi}`
    );

    // ── Log encryption info (library handles the actual encryption) ──────
    // The library's encryptPassword uses RSA_PKCS1_PADDING (v1.5) which is
    // confirmed correct for Instagram's v4 password format. Do NOT override.
    // (Previous OAEP patch caused "incorrect password" — reverted.)
    console.error(`[instagramLogin] @${profile.username} encryptPassword: using library default (PKCS1 v1.5) keyId=${(igPw.state as any).passwordEncryptionKeyId}`);

    // ── Device state snapshot before login (for debugging) ────────────────
    console.error(`[instagramLogin] LOGIN DEVICE SNAPSHOT @${profile.username}` +
      ` proxy=${proxyIp}` +
      ` ua="${igPw.state.appUserAgent}"` +
      ` deviceId="${igPw.state.deviceId}"` +
      ` uuid="${igPw.state.uuid}"` +
      ` phoneId="${igPw.state.phoneId}"` +
      ` adid="${igPw.state.adid}"` +
      ` csrfToken="${igPw.state.cookieCsrfToken ?? "(none)"}"` +
      ` encKeyId=${igPw.state.passwordEncryptionKeyId ?? "(none)"}`
    );

    try {
      // ── Traditional login endpoint with NavChain context ──────────────────
      // Jarvee JARVEEAPICALLS log (confirmed 2026-05) shows SendLoginRequest
      // calls POST /api/v1/accounts/login/ — NOT a Bloks endpoint.
      // The login_source is set correctly by Instagram because X-IG-Nav-Chain
      // was already present on the launcherPreLoginSync call above (injected via
      // generateHeaders patch). By the time the login request arrives, Instagram
      // has seen the login_homepage nav chain in the same session and sets
      // login_source="com.bloks.www.caa.login.login_homepage" in its response.
      {
        const { encrypted, time } = (igPw.account as any).encryptPassword(profile.password);
        const phoneId = igPw.state.phoneId;
        const jazoestVal = (() => {
          const buf = Buffer.from(phoneId, "ascii");
          let s = 0; for (let i = 0; i < buf.byteLength; i++) s += buf[i];
          return `2${s}`;
        })();
        // v427+ does NOT wrap the login body in signed_body=HMAC.JSON.
        // Sending signed_body with a modern UA is a known automation fingerprint
        // that Instagram uses to flag and lock accounts. Send plain form fields.
        console.error(`[instagramLogin] @${profile.username} — SendLoginRequest /api/v1/accounts/login/ (unsigned) navChain=${loginNavChain}`);
        const loginResp: any = await igPw.request.send({
          method: "POST",
          url: "/api/v1/accounts/login/",
          headers: {
            "X-IG-Nav-Chain": loginNavChain,
            "X-Bloks-Is-Panorama-Enabled": "true",
          },
          form: {
            username: profile.username,
            enc_password: `#PWD_INSTAGRAM:4:${time}:${encrypted}`,
            guid: igPw.state.uuid,
            phone_id: phoneId,
            _csrftoken: igPw.state.cookieCsrfToken,
            device_id: igPw.state.deviceId,
            adid: igPw.state.adid,
            google_tokens: "[]",
            login_attempt_count: 0,
            country_codes: JSON.stringify([{ country_code: "1", source: "default" }]),
            jazoest: jazoestVal,
            login_source: "com.bloks.www.caa.login.login_homepage",
          },
        }).catch((e: any) => {
          if (e?.response?.body?.two_factor_required) throw new IgLoginTwoFactorRequiredError(e.response);
          switch (e?.response?.body?.error_type) {
            case "bad_password":  throw new IgLoginBadPasswordError(e.response);
            case "invalid_user":  throw new IgLoginInvalidUserError(e.response);
            default: throw e;
          }
        });
        // Log raw Set-Cookie from the login response to diagnose cookie jar issues
        const respSetCookies: string[] = loginResp?.headers?.['set-cookie'] ?? [];
        console.error(`[instagramLogin] @${profile.username} — login response Set-Cookie headers (${respSetCookies.length}): ${respSetCookies.map((c: string) => c.split(';')[0]).join(" | ").slice(0, 300)}`);
        // Manually inject any Set-Cookie values into the jar in case request-promise
        // didn't auto-store them (observed when running behind certain proxy configs)
        if (respSetCookies.length > 0) {
          const innerJar = (igPw.state as any).cookieJar?._jar;
          if (innerJar?.setCookieSync) {
            for (const cs of respSetCookies) {
              try { innerJar.setCookieSync(cs, "https://i.instagram.com/"); } catch {}
            }
            console.error(`[instagramLogin] @${profile.username} — manually injected ${respSetCookies.length} login response cookies into jar`);
          }
        }
      }
      try {
        await igPw.simulate.postLoginFlow();
      } catch (plErr: any) {
        if (plErr instanceof IgCheckpointError || /checkpoint/i.test(plErr?.message ?? "")) {
          return { ok: false, message: `@${profile.username} — logged in but Instagram requires a checkpoint before API access. Open the embedded browser to resolve it.`, accountStatus: "captcha", checkpointUrl: extractCheckpointUrl(plErr), igDeviceState: capturePw() };
        }
      }
      console.error(`[instagramLogin] @${profile.username} — password login OK ✓`);
      const sessionCookies = await extractSessionCookies(igPw);
      console.error(`[instagramLogin] @${profile.username} — captured cookies: ${sessionCookies ? sessionCookies.slice(0, 60) + "…" : "(none)"}`);
      return { ok: true, message: `@${profile.username} logged in successfully.`, accountStatus: "valid", igDeviceState: capturePw(), igApiCookies: sessionCookies ?? undefined };

    } catch (err: any) {
      const errName: string = err?.constructor?.name ?? "";
      const errBody = JSON.stringify(err?.response?.body ?? {}).slice(0, 2000);
      console.error(`[instagramLogin] login error for @${profile.username}: ${errName} — ${err?.message} — body: ${errBody}`);
      const ds = capturePw();

      if (err instanceof IgLoginTwoFactorRequiredError) {
        const twoFactorInfo = err.response.body.two_factor_info;
        const secret = profile.twoFASecretKey?.replace(/\s+/g, "") ?? "";
        if (!secret) {
          return { ok: false, message: `@${profile.username} — 2FA required but no TOTP secret is set. Add it in Account Details.`, accountStatus: "2fa_verification", igDeviceState: ds };
        }
        let code: string;
        try {
          code = totpGenerate({ secret });
        } catch (totpErr: any) {
          console.error(`[instagramLogin] TOTP generation failed for @${profile.username}: ${totpErr?.message}`);
          return { ok: false, message: `@${profile.username} — could not generate 2FA code: ${totpErr?.message ?? "invalid secret"}. Check the TOTP secret in Account Details.`, accountStatus: "2fa_verification", igDeviceState: ds };
        }
        try {
          await igPw.account.twoFactorLogin({
            username: profile.username,
            verificationCode: code,
            twoFactorIdentifier: twoFactorInfo.two_factor_identifier,
            verificationMethod: "0",
            trustThisDevice: "1",
          });
          try {
            await igPw.simulate.postLoginFlow();
          } catch (plErr: any) {
            if (plErr instanceof IgCheckpointError || /checkpoint/i.test(plErr?.message ?? "")) {
              return { ok: false, message: `@${profile.username} — passed 2FA but Instagram requires a checkpoint before API access. Open the embedded browser to resolve it.`, accountStatus: "captcha", checkpointUrl: extractCheckpointUrl(plErr), igDeviceState: capturePw() };
            }
          }
          const sessionCookies2fa = await extractSessionCookies(igPw);
          console.error(`[instagramLogin] @${profile.username} — 2FA cookies: ${sessionCookies2fa ? sessionCookies2fa.slice(0, 60) + "…" : "(none)"}`);
          return { ok: true, message: `@${profile.username} passed 2FA and logged in successfully.`, accountStatus: "valid", igDeviceState: capturePw(), igApiCookies: sessionCookies2fa ?? undefined };
        } catch (e2: any) {
          return { ok: false, message: `@${profile.username} — 2FA code rejected: ${e2?.message ?? "unknown"}`, accountStatus: "2fa_verification", igDeviceState: ds };
        }
      }

      if (err instanceof IgCheckpointError) {
        const cpBody = err?.response?.body ?? {};
        const cpStr = JSON.stringify(cpBody);
        console.error(`[instagramLogin] @${profile.username} — password-login IgCheckpointError body: ${cpStr.slice(0, 600)}`);
        const cpSignalsBadCreds =
          cpBody.invalid_credentials === true ||
          cpBody?.challenge?.lock === true ||
          /\b(bad_password|invalid_credentials)\b/i.test(cpStr);
        if (cpSignalsBadCreds) {
          console.error(`[instagramLogin] @${profile.username} — checkpoint body signals bad credentials → bad_password`);
          return { ok: false, message: `@${profile.username} — incorrect password (Instagram returned a challenge indicating invalid credentials).`, accountStatus: "bad_password", igDeviceState: ds };
        }
        return { ok: false, message: `@${profile.username} — security checkpoint triggered. Open the embedded browser to verify the account.`, accountStatus: "captcha", checkpointUrl: extractCheckpointUrl(err), igDeviceState: ds };
      }

      if (err instanceof IgLoginBadPasswordError) {
        const body = err?.response?.body ?? {};
        const rawBody = JSON.stringify(body);
        console.error(`[instagramLogin] IgLoginBadPasswordError FULL body for @${profile.username}: ${rawBody}`);
        const buttons: any[] = body?.buttons ?? [];
        const errorType: string = body?.error_type ?? "";
        const invalidCreds: boolean = body?.invalid_credentials === true;
        // Instagram sends two distinct "bad password" responses:
        //
        //   A) "Forgotten password" / device-trust flow
        //      message: "We can send you an email to help you get back into your account."
        //      buttons: [{action:"send_one_click_login_email"}, {action:"dismiss"}]
        //      Cause:   Instagram doesn't trust this device (usually missing/stale igDeviceState).
        //               The password is NOT necessarily wrong — treat as email_confirmation,
        //               NOT bad_password. Marking as bad_password causes the UI to tell the
        //               user their password is wrong when it isn't, and repeated re-verify
        //               attempts from an unknown device will lock the account.
        //      NOTE:    Instagram still sets invalid_credentials=true and error_type="bad_password"
        //               on this response — so we MUST check the button action, not those flags.
        //
        //   B) Genuine wrong password
        //      message: "The password you entered is incorrect. Please try again."
        //      buttons: [{action:"dismiss"}]
        if (buttons.some((b: any) => b?.action === "send_one_click_login_email")) {
          console.error(`[instagramLogin] @${profile.username} — "Forgotten password" response (device-trust / email flow), NOT a bad password → accountStatus=email_confirmation`);
          return { ok: false, message: `@${profile.username} — Instagram does not recognise this device and is asking for email verification. Check the account email inbox and click the confirmation link, then re-verify. (error_type="${errorType}", invalid_credentials=${invalidCreds})`, accountStatus: "email_confirmation", igDeviceState: ds };
        }
        console.error(`[instagramLogin] @${profile.username} — genuine wrong password (dismiss-only buttons) → accountStatus=bad_password`);
        return { ok: false, message: `@${profile.username} — incorrect password (error_type="${errorType}", invalid_credentials=${invalidCreds}).`, accountStatus: "bad_password", igDeviceState: ds };
      }

      if (err instanceof IgLoginInvalidUserError) {
        return { ok: false, message: `@${profile.username} — account does not exist on Instagram.`, accountStatus: "banned", igDeviceState: ds };
      }

      const msg: string = err?.message ?? "unknown error";
      if (/banned|disabled|suspended/i.test(msg)) {
        return { ok: false, message: `@${profile.username} — account banned or disabled.`, accountStatus: "banned", igDeviceState: ds };
      }
      if (/checkpoint/i.test(msg)) {
        return { ok: false, message: `@${profile.username} — checkpoint required. Open the embedded browser to verify the account.`, accountStatus: "captcha", igDeviceState: ds };
      }
      return { ok: false, message: `@${profile.username} — login failed: ${msg}`, accountStatus: "logged_out", igDeviceState: ds };
    }
  }

  // ── Path 2: Cookie session restore ───────────────────────────────────────
  // Primary verify path for any account that already has igApiCookies stored,
  // whether or not a password is also saved.  Cookie restore is non-destructive:
  // it re-uses the existing session and does NOT trigger Instagram's new-login
  // security systems.  Password login (Path 1) is deliberately skipped for these
  // accounts to avoid the "Forgotten password" lock-out that a second concurrent
  // login from a different IP/device triggers.
  if (profile.igApiCookies) {
    // Mirrors the Jarvee cold-start sequence for a restored session:
    //   1. launcher/sync  (SendMobileConfig)  — establishes app config, no auth needed
    //   2. users/{id}/info                    — lightweight read that validates the live
    //                                           sessionid WITHOUT triggering the false
    //                                           checkpoint that currentUser()?edit=true causes
    //
    // We intentionally avoid currentUser()?edit=true — Instagram treats that as a
    // profile-write attempt on a freshly restored session and raises checkpoint_required.
    const { ig, captureDeviceState } = buildIgClient(profile, proxyUrl);
    attachRequestLogger(ig, profile.id, profile.username, "Verify", proxyIp, profile.apiLimits as any);

    // Parse userId from the sessionid token (format: "userId:hash:seq:token")
    // and inject ds_user_id into the cookie jar so the library can read cookieUserId.
    const sessionPair = profile.igApiCookies.split(';')
      .map(s => s.trim())
      .find(s => s.toLowerCase().startsWith('sessionid='));
    if (!sessionPair) {
      // No sessionid in stored cookies — the proxy strips all Set-Cookie headers so
      // sessionid never lands in the jar. However, the ig-set-authorization Bearer token
      // (saved in igDeviceState.authorization) IS the real session credential and survives
      // the proxy. Try it before declaring the session dead.
      let savedAuthToken: string | undefined;
      try { savedAuthToken = (JSON.parse(profile.igDeviceState ?? "{}") as any).authorization ?? undefined; } catch {}

      if (savedAuthToken) {
        console.error(`[instagramLogin] @${profile.username} — no sessionid (proxy strips cookies), trying Bearer token validation`);
        ig.state.authorization = savedAuthToken;
        try {
          const me = await ig.account.currentUser();
          const userId = String((me as any).pk ?? "");
          console.error(`[instagramLogin] @${profile.username} — Bearer token valid ✓ userId=${userId}`);
          return {
            ok: true,
            message: `@${profile.username} — session valid (Bearer token).`,
            accountStatus: "valid",
            igDeviceState: captureDeviceState(),
            igApiCookies: profile.igApiCookies ?? undefined,
          };
        } catch (bearerErr: any) {
          // Bearer token expired or rejected — clear it so the next verify attempt
          // falls through to Path 1 (fresh password login) instead of looping here.
          console.error(`[instagramLogin] @${profile.username} — Bearer token rejected: ${bearerErr?.message} — clearing saved auth`);
          ig.state.authorization = undefined;
          ig.state.igWWWClaim = undefined;
          return {
            ok: false,
            message: `@${profile.username} — session expired. Please re-verify to log in again.`,
            accountStatus: "logged_out",
            igDeviceState: captureDeviceState(),
          };
        }
      }

      // No sessionid and no Bearer token — session is genuinely unusable.
      // Never fall through to password login from here (looks like account takeover).
      console.error(`[instagramLogin] @${profile.username} — igApiCookies has no sessionid and no Bearer token, returning logged_out`);
      return {
        ok: false,
        message: `@${profile.username} — saved session is missing a sessionid cookie. Please update the password and re-verify, or restore the session via the embedded browser.`,
        accountStatus: "logged_out",
        igDeviceState: captureDeviceState(),
      };
    } else {
      const rawVal = sessionPair.slice('sessionid='.length);
      let decodedSession = rawVal;
      try { decodedSession = decodeURIComponent(rawVal); } catch { /* keep as-is */ }
      const userId = decodedSession.split(':')[0];

      if (!userId || !/^\d+$/.test(userId)) {
        console.error(`[instagramLogin] @${profile.username} — could not parse userId from sessionid, returning logged_out`);
        return {
          ok: false,
          message: `@${profile.username} — could not read user ID from session cookie. Please update the password and re-verify, or restore the session via the embedded browser.`,
          accountStatus: "logged_out",
          igDeviceState: captureDeviceState(),
        };
      } else {
        const cookiesWithUserId = `${profile.igApiCookies};ds_user_id=${userId}`;

        // ── Full Jarvee cold-start sequence ────────────────────────────────
        //
        // Phase 0 — Pre-auth calls with CLEAN cookie jar (no session loaded yet)
        //   Jarvee fires GetTokenResult → SendMobileConfig → GetTokenResult
        //   BEFORE loading the session cookie.  Running them here means Instagram
        //   sees a fresh device probe, not a checkpointed session — so these calls
        //   return 200 even when the account is in checkpoint.
        //
        // Phase 1 — Load the session cookie
        //   Only after the pre-auth calls does Jarvee inject the sessionid.
        //
        // Phase 2 — Authenticated session validation
        //   GetAccountFamily → cold_start timeline → reels_tray → notifications
        //   → qe/sync → banyan → discover.  Checkpoint errors here are genuine.

        // ── Phase 0a: GetTokenResult (/api/v1/accounts/tokens/keyed/) ─────
        // First call in Jarvee's session-restore sequence — no cookies needed.
        try {
          await ig.request.send({
            url: "/api/v1/accounts/tokens/keyed/",
            method: "GET",
            qs: { expires: "0" },
          });
          console.error(`[instagramLogin] @${profile.username} — tokens/keyed (GetTokenResult) OK`);
        } catch (e: any) {
          console.error(`[instagramLogin] @${profile.username} — tokens/keyed failed (non-fatal): ${e?.message}`);
        }

        // ── Phase 0b: SendMobileConfig (launcher/sync) ────────────────────
        // Called with clean jar — Instagram sees anonymous device probe, not checkpoint.
        // Hard cap at 20 s: this is a large config download that can take 90+ seconds
        // on high-latency proxies, starving the session probe (users/{id}/info) of time.
        // It is non-fatal so we race it against a timeout and move on either way.
        await Promise.race([
          ig.launcher.preLoginSync()
            .then(() => console.error(`[instagramLogin] @${profile.username} — launcher/sync (SendMobileConfig) OK`))
            .catch((e: any) => console.error(`[instagramLogin] @${profile.username} — launcher/sync failed (non-fatal): ${e?.message}`)),
          new Promise<void>(r => setTimeout(() => {
            console.error(`[instagramLogin] @${profile.username} — launcher/sync capped at 20 s (slow proxy), moving on`);
            r();
          }, 20_000)),
        ]);

        // ── Phase 0c: GetTokenResult #2 ───────────────────────────────────
        // Jarvee calls GetTokenResult a second time right after launcher/sync.
        try {
          await ig.request.send({
            url: "/api/v1/accounts/tokens/keyed/",
            method: "GET",
            qs: { expires: "0" },
          });
          console.error(`[instagramLogin] @${profile.username} — tokens/keyed #2 (GetTokenResult) OK`);
        } catch (e: any) {
          console.error(`[instagramLogin] @${profile.username} — tokens/keyed #2 failed (non-fatal): ${e?.message}`);
        }

        // ── Phase 1: Load session cookie ──────────────────────────────────
        // Session is injected AFTER the unauthenticated Phase 0 calls —
        // this matches Jarvee exactly and avoids false checkpoints on pre-auth calls.
        await restoreSessionCookies(ig, cookiesWithUserId);
        console.error(`[instagramLogin] @${profile.username} — cookies restored (userId=${userId})`);

        // ── Phase 2a: Session validation ──────────────────────────────────
        // Strategy:
        //   1. Try GET /api/v1/users/{userId}/info/ — universally reliable.
        //      200 = session alive, 401 = expired, 403 = banned, checkpoint = captcha.
        //   2. Also fire POST /api/v1/accounts/get_account_family/ (Jarvee compat).
        //      This endpoint returns 404 for many account types so its result is
        //      advisory only — we never treat a 404 from it as "session dead".
        //
        // CRITICAL: never fall through to a password login from here. Making a fresh
        // password attempt immediately after a cookie probe looks like account
        // takeover to Instagram and will trigger an account block.

        // Helper: classify an Instagram API error into a VerifyResult or null (= "inconclusive / treat as valid")
        const classifyAuthError = (err: any, source: string): VerifyResult | null => {
          const msg: string = err?.message ?? "";
          const body = err?.response?.body ?? {};
          const igMsg: string = (typeof body === "object" && body !== null ? (body?.message ?? "") : "") as string;
          const statusCode: number | undefined = err?.response?.statusCode;

          if (err instanceof IgCheckpointError || /checkpoint/i.test(msg) || /checkpoint/i.test(igMsg) || /challenge_required/i.test(msg) || /challenge_required/i.test(igMsg)) {
            // Inspect explicit boolean fields only — never search the full body string
            // because checkpoint URLs can contain "bad_password" or "invalid_credentials"
            // as path segments, causing false bad_password classifications for live sessions.
            const challengeBody = err?.response?.body ?? {};
            console.error(`[instagramLogin] @${profile.username} — ${source}: checkpoint body: ${JSON.stringify(challengeBody).slice(0, 600)}`);
            // challenge.lock=true means Instagram has hard-locked the account (very unusual;
            // distinct from a soft checkpoint). invalid_credentials=true at the TOP level
            // (not inside a URL) explicitly flags wrong password from Instagram itself.
            const hardLocked = challengeBody?.challenge?.lock === true;
            const explicitBadCreds = challengeBody.invalid_credentials === true;
            if (hardLocked) {
              // lock=true = Instagram hard-suspended/banned the account (integrity ban, association ban, etc.)
              console.error(`[instagramLogin] @${profile.username} — ${source}: challenge.lock=true → account banned/suspended`);
              return { ok: false, message: `@${profile.username} — account is suspended or banned by Instagram.`, accountStatus: "banned", igDeviceState: captureDeviceState() };
            }
            if (explicitBadCreds) {
              console.error(`[instagramLogin] @${profile.username} — ${source}: invalid_credentials=true → bad_password`);
              return { ok: false, message: `@${profile.username} — account locked by Instagram (invalid credentials).`, accountStatus: "bad_password", igDeviceState: captureDeviceState() };
            }
            console.error(`[instagramLogin] @${profile.username} — ${source}: checkpoint → captcha`);
            return { ok: false, message: `@${profile.username} — account requires a security checkpoint. Open the embedded browser to resolve it.`, accountStatus: "captcha", checkpointUrl: extractCheckpointUrl(err), igDeviceState: captureDeviceState() };
          }
          if (statusCode === 401 || /login_required|not.*auth/i.test(msg) || /login_required|not.*auth/i.test(igMsg)) {
            console.error(`[instagramLogin] @${profile.username} — ${source}: session expired (401/login_required)`);
            return { ok: false, message: `@${profile.username} — session expired or revoked. Restore it via the embedded browser.`, accountStatus: "logged_out", igDeviceState: captureDeviceState() };
          }
          if (statusCode === 403 || /UserNotOnWhitelist|account.*disabled|account.*suspended/i.test(igMsg)) {
            console.error(`[instagramLogin] @${profile.username} — ${source}: account banned/disabled (403)`);
            return { ok: false, message: `@${profile.username} — account appears to be banned or disabled.`, accountStatus: "banned", igDeviceState: captureDeviceState() };
          }
          if (/invalid_credentials/i.test(igMsg) || /invalid_credentials/i.test(msg)) {
            return { ok: false, message: `@${profile.username} — Instagram rejected the credentials as invalid.`, accountStatus: "invalid_credentials", igDeviceState: captureDeviceState() };
          }
          if (/bad_password/i.test(igMsg) || /bad_password/i.test(msg)) {
            return { ok: false, message: `@${profile.username} — incorrect password.`, accountStatus: "bad_password", igDeviceState: captureDeviceState() };
          }
          // Instagram's human-readable "wrong password" message — returned in the body
          // when a dead/revoked session cookie is used and IG recognises it as a
          // credential failure rather than a plain 401.
          if (/login information.*incorrect|incorrect.*login information|password.*incorrect|incorrect.*password/i.test(igMsg)) {
            console.error(`[instagramLogin] @${profile.username} — ${source}: IG returned "login information incorrect" → bad_password`);
            return { ok: false, message: `@${profile.username} — Instagram says the login information is incorrect. The stored session is no longer valid.`, accountStatus: "bad_password", igDeviceState: captureDeviceState() };
          }
          // feedback_required = Instagram's Automated Behaviour Detected (ABD) signal.
          // The session IS alive — Instagram is blocking API calls with a soft warning.
          // Must be caught here so both users/info and get_account_family short-circuit
          // to automated_behaviour_detected instead of falling through to "inconclusive"
          // and then incorrectly returning logged_out.
          if (igMsg === "feedback_required" || msg.includes("feedback_required")) {
            console.error(`[instagramLogin] @${profile.username} — ${source}: feedback_required → automated_behaviour_detected`);
            return { ok: false, message: `@${profile.username} — Automated Behaviour Detected. Use Fix Auto-Behaviour to dismiss it.`, accountStatus: "automated_behaviour_detected", igDeviceState: captureDeviceState() };
          }
          // 404 or any other non-auth HTTP error = endpoint not available for this
          // account type, not a session failure — return null (treat as inconclusive)
          return null;
        };

        // ── Step 1: users/{userId}/info — primary session probe ───────────
        let sessionConfirmed = false;
        try {
          await ig.request.send({
            url: `/api/v1/users/${userId}/info/`,
            method: "GET",
          });
          sessionConfirmed = true;
          console.error(`[instagramLogin] @${profile.username} — users/info (session probe) OK ✓`);
        } catch (infoErr: any) {
          const statusCode: number | undefined = infoErr?.response?.statusCode;
          console.error(`[instagramLogin] @${profile.username} — users/info failed: HTTP ${statusCode ?? "n/a"} ${infoErr?.message ?? ""}`);
          const classified = classifyAuthError(infoErr, "users/info");
          if (classified) return classified;
          // Non-auth error (404, 429, network) — inconclusive, continue to get_account_family
          console.error(`[instagramLogin] @${profile.username} — users/info inconclusive, trying get_account_family`);
        }

        // ── Step 2: get_account_family — Jarvee compat, advisory only ────
        // Only run if users/info was inconclusive. 404 from this endpoint is
        // normal for many account types and must NOT be treated as session dead.
        if (!sessionConfirmed) {
          try {
            await ig.request.send({
              url: "/api/v1/accounts/get_account_family/",
              method: "POST",
              form: ig.request.sign({
                _csrftoken: ig.state.cookieCsrfToken,
                _uid: userId,
                _uuid: ig.state.uuid,
              }),
            });
            sessionConfirmed = true;
            console.error(`[instagramLogin] @${profile.username} — get_account_family OK ✓`);
          } catch (famErr: any) {
            const statusCode: number | undefined = famErr?.response?.statusCode;
            console.error(`[instagramLogin] @${profile.username} — get_account_family failed: HTTP ${statusCode ?? "n/a"} ${famErr?.message ?? ""}`);
            const classified = classifyAuthError(famErr, "get_account_family");
            if (classified) return classified;
            // Both users/info AND get_account_family returned inconclusive non-auth errors.
            // We cannot confirm the session is alive. Return logged_out so the user is
            // prompted to re-verify rather than silently marking a dead session as valid.
            // (A live session virtually never gets non-auth failures on both probes —
            //  that pattern indicates a dead/revoked session or a blocking proxy issue.)
            console.error(`[instagramLogin] @${profile.username} — both session probes inconclusive → returning logged_out (cannot confirm session is alive)`);
            return {
              ok: false,
              message: `@${profile.username} — could not confirm the session is alive (both validation probes returned non-auth errors). Please check the proxy or re-verify the account.`,
              accountStatus: "logged_out",
              igDeviceState: captureDeviceState(),
            };
          }
        }

        // Helper: classify a cold-start error that might be an ABD response.
        // instagram-private-api throws IgResponseError on non-2xx — check both
        // the error message and the raw response body.
        const isABDError = (e: any): boolean => {
          const msg: string = (e?.message ?? "").toLowerCase();
          const body: any   = e?.response?.body ?? {};
          const igMsg: string = (typeof body === "object" && body !== null ? (body?.message ?? "") : "").toLowerCase();
          return msg.includes("feedback_required") || igMsg === "feedback_required";
        };

        const abdResult = (): VerifyResult => ({
          ok: false,
          message: `@${profile.username} — Automated Behaviour Detected. Use Fix Auto-Behaviour to dismiss it.`,
          accountStatus: "automated_behaviour_detected",
          igDeviceState: captureDeviceState(),
        });

        // ── ABD probe — fires immediately after session confirmation ──────
        // POST /api/v1/qe/sync/ with NO body — this is the exact request pattern
        // that triggers feedback_required for ABD accounts.  A signed/formatted
        // syncLoginExperiments call does NOT trigger it (Instagram accepts it fine
        // even in ABD state); only the bare unsigned POST reliably surfaces ABD.
        // This mirrors what probeAndDismissABD() uses in InstagramWebClient.
        // Check both the return body (200 with feedback_required) and thrown error
        // body (400 with feedback_required).
        try {
          const abdProbeBody: any = await ig.request.send({
            url:    "/api/v1/qe/sync/",
            method: "POST",
          });
          if (abdProbeBody?.message === "feedback_required") {
            console.error(`[instagramLogin] @${profile.username} — qe/sync ABD probe: feedback_required in 200 body → automated_behaviour_detected`);
            return abdResult();
          }
          console.error(`[instagramLogin] @${profile.username} — qe/sync ABD probe OK (no ABD)`);
        } catch (abdProbeErr: any) {
          const body = abdProbeErr?.response?.body ?? {};
          const igMsg: string = (typeof body === "object" && body !== null ? (body?.message ?? "") : "") as string;
          const errMsg = String(abdProbeErr?.message ?? "").toLowerCase();
          if (igMsg === "feedback_required" || errMsg.includes("feedback_required")) {
            console.error(`[instagramLogin] @${profile.username} — qe/sync ABD probe: feedback_required (HTTP ${abdProbeErr?.response?.statusCode ?? "n/a"}) → automated_behaviour_detected`);
            return abdResult();
          }
          // challenge_required on qe/sync (after users/info already confirmed the session is alive)
          // is the ABD feedback prompt manifesting as a mobile-API challenge — NOT a traditional
          // login captcha. The account is alive but has an ABD warning that needs dismissal.
          if (igMsg === "challenge_required" || errMsg.includes("challenge_required")) {
            console.error(`[instagramLogin] @${profile.username} — qe/sync ABD probe: challenge_required (HTTP ${abdProbeErr?.response?.statusCode ?? "n/a"}) → automated_behaviour_detected (ABD prompt on mobile, session confirmed alive via users/info)`);
            return abdResult();
          }
          console.error(`[instagramLogin] @${profile.username} — qe/sync ABD probe: non-fatal error (HTTP ${abdProbeErr?.response?.statusCode ?? "n/a"}): ${abdProbeErr?.message ?? ""}`);
        }

        // Helper: detects 403 login_required on cold-start calls AFTER the session has
        // been confirmed alive via users/info.  When the session is valid but Instagram
        // blocks most API endpoints with 403 login_required, that is the ABD/restricted
        // state (Instagram shows an "automated behaviour detected" prompt in-app).
        // This is different from feedback_required — some account types return this
        // instead, particularly on the cold-start sequence.
        const isLoginRequiredBlock = (e: any): boolean => {
          const sc: number | undefined = e?.response?.statusCode;
          const body: any = e?.response?.body ?? {};
          const igMsg: string = (typeof body === "object" && body !== null ? (body?.message ?? "") : "").toLowerCase();
          const errMsg: string = (e?.message ?? "").toLowerCase();
          return sc === 403 && (igMsg === "login_required" || errMsg.includes("login_required"));
        };

        // Count how many cold-start calls are blocked with 403 login_required.
        // 2+ blocks after a confirmed session = automated_behaviour_detected.
        let coldStartBlockedCount = 0;

        // ── Phase 2b: GetTimeLine cold_start_fetch (feed/timeline) ────────
        // NOTE: checkpoint_required here is NOT treated as a hard gate.
        // If get_account_family returned 200, the session is valid.  Instagram
        // sometimes returns a soft checkpoint on timeline for sessions that
        // haven't been fully "warmed up" yet (seen in Jarvee too) — it resolves
        // on its own with continued API activity and does NOT require the EB.
        try {
          const timelineFeed = ig.feed.timeline();
          timelineFeed.reason = "cold_start_fetch";
          await timelineFeed.request();
          console.error(`[instagramLogin] @${profile.username} — feed/timeline cold_start_fetch OK`);
        } catch (tlErr: any) {
          const msg: string = tlErr?.message ?? "";
          if (isABDError(tlErr)) {
            console.error(`[instagramLogin] @${profile.username} — feed/timeline: feedback_required (ABD) → automated_behaviour_detected`);
            return abdResult();
          }
          if (isLoginRequiredBlock(tlErr)) {
            coldStartBlockedCount++;
            console.error(`[instagramLogin] @${profile.username} — feed/timeline: 403 login_required after confirmed session (ABD signal ${coldStartBlockedCount})`);
          } else {
            console.error(`[instagramLogin] @${profile.username} — feed/timeline failed (non-fatal): ${msg}`);
          }
          // Intentionally not returning captcha here — get_account_family is the
          // authoritative checkpoint check.  Timeline soft-checkpoints are ignored.
        }

        // ── Phase 2c: GetReelsTray (feed/reels_tray) ─────────────────────
        try {
          const reelsFeed = (ig.feed as any).reelsTray();
          await reelsFeed.request();
          console.error(`[instagramLogin] @${profile.username} — feed/reels_tray (GetReelsTray) OK`);
        } catch (e: any) {
          if (isABDError(e)) {
            console.error(`[instagramLogin] @${profile.username} — reels_tray: feedback_required (ABD) → automated_behaviour_detected`);
            return abdResult();
          }
          if (isLoginRequiredBlock(e)) {
            coldStartBlockedCount++;
            console.error(`[instagramLogin] @${profile.username} — reels_tray: 403 login_required after confirmed session (ABD signal ${coldStartBlockedCount})`);
          } else {
            console.error(`[instagramLogin] @${profile.username} — reels_tray failed (non-fatal): ${e?.message}`);
          }
        }

        // ── Phase 2d: ExecuteNotificationsBadge (news/inbox) ─────────────
        try {
          await ig.news.inbox();
          console.error(`[instagramLogin] @${profile.username} — news/inbox (ExecuteNotificationsBadge) OK`);
        } catch (e: any) {
          if (isABDError(e)) {
            console.error(`[instagramLogin] @${profile.username} — news/inbox: feedback_required (ABD) → automated_behaviour_detected`);
            return abdResult();
          }
          if (isLoginRequiredBlock(e)) {
            coldStartBlockedCount++;
            console.error(`[instagramLogin] @${profile.username} — news/inbox: 403 login_required after confirmed session (ABD signal ${coldStartBlockedCount})`);
          } else {
            console.error(`[instagramLogin] @${profile.username} — news/inbox failed (non-fatal): ${e?.message}`);
          }
        }

        // Early exit: 2 cold-start blocks already detected — no need to continue
        if (coldStartBlockedCount >= 2) {
          console.error(`[instagramLogin] @${profile.username} — ${coldStartBlockedCount} cold-start endpoints returned 403 login_required after session confirmed → automated_behaviour_detected`);
          return abdResult();
        }

        // ── Phase 2e: FetchConfig (qe/sync) ──────────────────────────────
        // Jarvee calls FetchConfig after notifications (step 10 in cold-start).
        // Minimal form — no experiments field to avoid "400 Invalid experiment"
        // from the library's outdated LOGIN_EXPERIMENTS list vs our app version.
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
          console.error(`[instagramLogin] @${profile.username} — qe/sync (FetchConfig) OK`);
        } catch (e: any) {
          if (isABDError(e)) {
            console.error(`[instagramLogin] @${profile.username} — qe/sync: feedback_required (ABD) → automated_behaviour_detected`);
            return abdResult();
          }
          if (isLoginRequiredBlock(e)) {
            coldStartBlockedCount++;
            console.error(`[instagramLogin] @${profile.username} — qe/sync (FetchConfig): 403 login_required after confirmed session (ABD signal ${coldStartBlockedCount})`);
          } else {
            console.error(`[instagramLogin] @${profile.username} — qe/sync (FetchConfig) failed (non-fatal): ${e?.message}`);
          }
        }

        // ── Phase 2f: GetBanyan (banyan/banyan) ───────────────────────────
        // Jarvee fires this immediately after FetchConfig (step 11).
        try {
          await ig.request.send({
            url: "/api/v1/banyan/banyan/",
            method: "POST",
            form: ig.request.sign({
              _csrftoken: ig.state.cookieCsrfToken,
              _uid: userId,
              _uuid: ig.state.uuid,
              surfaces_to_queries: JSON.stringify([
                { surface: "interstitial_link_loading" },
                { surface: "interstitial_link_prefetch" },
              ]),
            }),
          });
          console.error(`[instagramLogin] @${profile.username} — banyan/banyan (GetBanyan) OK`);
        } catch (e: any) {
          if (isABDError(e)) {
            console.error(`[instagramLogin] @${profile.username} — banyan: feedback_required (ABD) → automated_behaviour_detected`);
            return abdResult();
          }
          if (isLoginRequiredBlock(e)) {
            coldStartBlockedCount++;
            console.error(`[instagramLogin] @${profile.username} — banyan/banyan: 403 login_required after confirmed session (ABD signal ${coldStartBlockedCount})`);
          } else {
            console.error(`[instagramLogin] @${profile.username} — banyan/banyan failed (non-fatal): ${e?.message}`);
          }
        }

        // ── Phase 2g: ExecuteDiscoverExplore (discover/topical_explore) ───
        // Jarvee calls this last in the cold-start sequence (step 12).
        try {
          await (ig.discover as any).topicalExplore();
          console.error(`[instagramLogin] @${profile.username} — discover/topical_explore (ExecuteDiscoverExplore) OK`);
        } catch (e: any) {
          if (isABDError(e)) {
            console.error(`[instagramLogin] @${profile.username} — topical_explore: feedback_required (ABD) → automated_behaviour_detected`);
            return abdResult();
          }
          if (isLoginRequiredBlock(e)) {
            coldStartBlockedCount++;
            console.error(`[instagramLogin] @${profile.username} — discover/topical_explore: 403 login_required after confirmed session (ABD signal ${coldStartBlockedCount})`);
          } else {
            console.error(`[instagramLogin] @${profile.username} — discover/topical_explore failed (non-fatal): ${e?.message}`);
          }
        }

        // Final ABD check — any 2+ blocked endpoints after confirmed session = ABD
        if (coldStartBlockedCount >= 2) {
          console.error(`[instagramLogin] @${profile.username} — ${coldStartBlockedCount} cold-start endpoints returned 403 login_required after session confirmed → automated_behaviour_detected`);
          return abdResult();
        }

        console.error(`[instagramLogin] @${profile.username} — cold-start handshake complete ✓`);
        return {
          ok: true,
          message: `Verified via stored cookies ✓`,
          accountStatus: "valid",
          igDeviceState: captureDeviceState(),
        };
      }
    }
  }

  // Neither path produced a result — no password and no cookies stored.
  return {
    ok: false,
    message: `@${profile.username} — no credentials or session available. Add a password and re-verify.`,
    accountStatus: "logged_out",
  };
}
