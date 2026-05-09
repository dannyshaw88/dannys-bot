import { IgApiClient, IgCheckpointError, IgLoginTwoFactorRequiredError, IgLoginBadPasswordError, IgLoginInvalidUserError } from "instagram-private-api";
import { generateSync as totpGenerate } from "otplib";
import { db } from "@workspace/db";
import { instagramApiCalls } from "../shared/schema";
import type { Profile } from "../shared/schema";
import { storage } from "../storage";

export type VerifyResult =
  | { ok: true; message: string; accountStatus: "valid"; igDeviceState?: string }
  | { ok: false; message: string; accountStatus: "banned" | "captcha" | "2fa_verification" | "phone_verification" | "email_confirmation" | "logged_out" | "bad_password" | "invalid_credentials"; igDeviceState?: string; checkpointUrl?: string };

// Must stay in sync with MOBILE_VERSION in instagramWebClient.ts
const MOBILE_VERSION      = "378.1.0.45.111";
const MOBILE_VERSION_CODE = "651869969";

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

  // Strategy 2: qe/syncLoginExperiments
  try {
    await ig.qe.syncLoginExperiments();
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

function buildIgClient(profile: Profile, proxyUrl: string | null): { ig: IgApiClient; captureDeviceState: () => string } {
  const ig = new IgApiClient();
  // request-promise has no default timeout — hang indefinitely on dead proxies
  // without this, leading to FD exhaustion and server unresponsiveness after ~1h.
  ig.request.defaults = { timeout: 30000 };
  // ALWAYS include username in the seed so that accounts sharing the same userAgentApi
  // (same device model) still generate distinct uuid/deviceId/phoneId fingerprints.
  // Without the username, two accounts with the same UA string would get identical
  // device IDs and Instagram would detect the same device logging into multiple accounts.
  const deviceSeed = (profile.userAgentApi ?? profile.username) + "|" + profile.username;

  if (profile.igDeviceState) {
    try {
      const saved = JSON.parse(profile.igDeviceState);
      ig.state.generateDevice(deviceSeed);
      if (saved.deviceId) ig.state.deviceId = saved.deviceId;
      if (saved.uuid) ig.state.uuid = saved.uuid;
      if (saved.phoneId) ig.state.phoneId = saved.phoneId;
      if (saved.adid) ig.state.adid = saved.adid;
      if (saved.deviceString) ig.state.deviceString = saved.deviceString;
      console.error(`[instagramLogin] Restored device state for @${profile.username} (deviceId=${ig.state.deviceId} uuid=${ig.state.uuid?.slice(0,8)}…)`);
    } catch {
      ig.state.generateDevice(deviceSeed);
      if (profile.userAgentApi) ig.state.deviceString = profile.userAgentApi;
    }
  } else {
    ig.state.generateDevice(deviceSeed);
    if (profile.userAgentApi) ig.state.deviceString = profile.userAgentApi;
    console.error(`[instagramLogin] No saved ig_device_state for @${profile.username} — generated deterministic IDs from seed${profile.userAgentApi ? " + applied device string from profile UA" : ""} (deviceId=${ig.state.deviceId} uuid=${ig.state.uuid?.slice(0,8)}…)`);
  }

  // Always patch app version constants so X-IG-App-Version matches the User-Agent.
  // profile.userAgentApi may be stored as either a full UA ("Instagram X.X Android ...")
  // or just the device params string ("33/13; 400dpi; ...").  When the full UA is
  // present, parse the version from it; otherwise fall back to MOBILE_VERSION so the
  // library's stale built-in default (222.x) is never sent.
  {
    const parsed = parseIgUaVersion(profile.userAgentApi ?? "");
    const version     = parsed?.version     ?? MOBILE_VERSION;
    const versionCode = parsed?.versionCode ?? MOBILE_VERSION_CODE;
    ig.state.constants.APP_VERSION      = version;
    ig.state.constants.APP_VERSION_CODE = versionCode;

    // CRITICAL: Ensure deviceString ends with the correct version code.
    // Two cases:
    //   1. Old code present (e.g. 558538758) but APP_VERSION_CODE is newer (651869969):
    //      UA body code ≠ X-IG-App-Version header → Instagram flags as fingerprint anomaly.
    //   2. No code at end (Jarvee export format — last segment is locale e.g. "en_US"):
    //      Jarvee's export omits the version code from the api user agent column but
    //      appends it internally; without it our UA is non-standard.
    // Fix: replace stale code OR append missing code to match versionCode.
    if (ig.state.deviceString) {
      const segs = ig.state.deviceString.split(";");
      const last = segs[segs.length - 1].trim();
      if (/^\d+$/.test(last)) {
        if (last !== versionCode) {
          segs[segs.length - 1] = ` ${versionCode}`;
          ig.state.deviceString = segs.join(";");
          console.error(`[instagramLogin] Patched deviceString version code: ${last} → ${versionCode} for @${profile.username}`);
        }
      } else {
        ig.state.deviceString = ig.state.deviceString.trimEnd() + `; ${versionCode}`;
        console.error(`[instagramLogin] Appended version code ${versionCode} to deviceString for @${profile.username} (was: "${last}")`);
      }
    }

    console.error(`[instagramLogin] APP_VERSION=${version} APP_VERSION_CODE=${versionCode} for @${profile.username} (${parsed ? "from UA" : "fallback"})`);
  }

  if (proxyUrl) ig.state.proxyUrl = proxyUrl;

  const captureDeviceState = () => JSON.stringify({
    v: 2,
    deviceId: ig.state.deviceId,
    uuid: ig.state.uuid,
    phoneId: ig.state.phoneId,
    adid: ig.state.adid,
    deviceString: ig.state.deviceString,
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
  const proxyUrl = resolved.url;
  const proxyIp = resolved.host;
  console.error(`[instagramLogin] @${profile.username} proxy=${resolved.host}`);

  // ── Verification priority ─────────────────────────────────────────────────
  // 1. Fresh password login — used when a password is stored.
  //    Definitive credential check: proves the username+password combination
  //    is currently accepted by Instagram's API.
  //
  // 2. Cookie session restore — used only when no password is stored.
  //    For accounts managed purely by session cookie.

  if (profile.password && !profile.igApiCookies) {
    // ── Path 1: Fresh password login — ONLY for accounts with no stored session ──
    // CRITICAL: Do NOT run a password login when igApiCookies exist. Instagram
    // treats a fresh mobile API login as a NEW device login attempt. When the
    // account already has an active mobile session (igApiCookies), this new
    // attempt looks like an account takeover and triggers an immediate lock —
    // regardless of preLoginFlow, proxy, or any other factor.
    // Accounts with igApiCookies go directly to Path 2 (session validation).
    console.error(`[instagramLogin] @${profile.username} — attempting fresh password login (no stored session)`);
    const { ig: igPw, captureDeviceState: capturePw } = buildIgClient(profile, proxyUrl);
    attachRequestLogger(igPw, profile.id, profile.username, "Verify", proxyIp, profile.apiLimits as any);

    await ensureEncryptionKeys(igPw);

    if (!igPw.state.passwordEncryptionPubKey) {
      console.error(`[instagramLogin] @${profile.username} — could not fetch encryption keys (proxy/network issue)`);
      return {
        ok: false,
        message: `@${profile.username} — could not reach Instagram servers. Check your proxy or network connection.`,
        accountStatus: "logged_out",
      };
    }

    // ── Safe partial preLoginFlow ──────────────────────────────────────────
    // Full simulate.preLoginFlow() executes 7 requests (shuffled).  Two of them
    // are dangerous for our use case:
    //   • contactPointPrefill('prefill') — asks Instagram "what accounts are on
    //     this device?".  On a fresh/restored device this triggers the
    //     "Forgotten password" device-trust security response.
    //   • getPrefillCandidates()         — asks for account login suggestions.
    //     Same trigger.
    // The remaining 5 are harmless device-registration calls that Instagram
    // needs to see before it will accept a login from an unknown device.
    // Without ANY of them, Instagram fakes an "Incorrect password" response
    // even when the credentials are correct.
    // We call only the safe 5 here, skipping the two dangerous ones.
    const ig_ = igPw as any;
    for (const [name, fn] of [
      ["readMsisdnHeader",        () => igPw.account.readMsisdnHeader()],
      ["msisdnHeaderBootstrap",   () => ig_.account.msisdnHeaderBootstrap?.("ig_select_app")],
      ["zrTokenResult",           () => ig_.zr?.tokenResult?.()],
      ["launcherPreLoginSync",    () => ig_.launcher?.preLoginSync?.()],
      ["logAttribution",          () => ig_.attribution?.logAttribution?.()],
    ] as [string, () => Promise<any>][]) {
      try {
        await fn();
        console.error(`[instagramLogin] @${profile.username} safe-preLogin: ${name} OK`);
      } catch (e: any) {
        console.error(`[instagramLogin] @${profile.username} safe-preLogin: ${name} failed (non-fatal): ${e?.message}`);
      }
    }

    // ── Pre-login account metadata (for debugging) ─────────────────────────
    const pwLen = profile.password?.length ?? 0;
    const pwHint = pwLen > 0 ? `${profile.password![0]}${"*".repeat(Math.min(pwLen - 2, 6))}${pwLen > 1 ? profile.password![pwLen - 1] : ""}` : "(empty)";
    console.error(
      `[instagramLogin] @${profile.username} pre-login metadata:` +
      ` password_len=${pwLen} password_hint="${pwHint}"` +
      ` has_igApiCookies=${!!profile.igApiCookies}` +
      ` has_igDeviceState=${!!profile.igDeviceState}` +
      ` has_userAgentApi=${!!profile.userAgentApi}`
    );

    // ── Device state snapshot before login (for debugging) ────────────────
    console.error(`[instagramLogin] LOGIN DEVICE SNAPSHOT @${profile.username}` +
      ` proxy=${proxyIp}` +
      ` ua="${igPw.state.deviceString}"` +
      ` deviceId="${igPw.state.deviceId}"` +
      ` uuid="${igPw.state.uuid}"` +
      ` phoneId="${igPw.state.phoneId}"` +
      ` adid="${igPw.state.adid}"` +
      ` csrfToken="${igPw.state.cookieCsrfToken ?? "(none)"}"` +
      ` encKeyId=${igPw.state.passwordEncryptionKeyId ?? "(none)"}`
    );

    try {
      await igPw.account.login(profile.username, profile.password);
      try {
        await igPw.simulate.postLoginFlow();
      } catch (plErr: any) {
        if (plErr instanceof IgCheckpointError || /checkpoint/i.test(plErr?.message ?? "")) {
          return { ok: false, message: `@${profile.username} — logged in but Instagram requires a checkpoint before API access. Open the embedded browser to resolve it.`, accountStatus: "captcha", checkpointUrl: extractCheckpointUrl(plErr), igDeviceState: capturePw() };
        }
      }
      console.error(`[instagramLogin] @${profile.username} — password login OK ✓`);
      return { ok: true, message: `@${profile.username} logged in successfully.`, accountStatus: "valid", igDeviceState: capturePw() };

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
          return { ok: true, message: `@${profile.username} passed 2FA and logged in successfully.`, accountStatus: "valid", igDeviceState: capturePw() };
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
      // No sessionid in stored cookies — session is unusable. Return logged_out so the
      // user is prompted to re-enter credentials. Never fall through to password login:
      // making a fresh password attempt immediately after a failed cookie probe looks
      // like an account takeover to Instagram and will trigger an account block.
      console.error(`[instagramLogin] @${profile.username} — igApiCookies has no sessionid, returning logged_out`);
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
        try {
          await ig.launcher.preLoginSync();
          console.error(`[instagramLogin] @${profile.username} — launcher/sync (SendMobileConfig) OK`);
        } catch (e: any) {
          console.error(`[instagramLogin] @${profile.username} — launcher/sync failed (non-fatal): ${e?.message}`);
        }

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

          if (err instanceof IgCheckpointError || /checkpoint/i.test(msg) || /checkpoint/i.test(igMsg)) {
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
          console.error(`[instagramLogin] @${profile.username} — feed/timeline failed (non-fatal): ${msg}`);
          // Intentionally not returning captcha here — get_account_family is the
          // authoritative checkpoint check.  Timeline soft-checkpoints are ignored.
        }

        // ── Phase 2c: GetReelsTray (feed/reels_tray) ─────────────────────
        try {
          const reelsFeed = (ig.feed as any).reelsTray();
          await reelsFeed.request();
          console.error(`[instagramLogin] @${profile.username} — feed/reels_tray (GetReelsTray) OK`);
        } catch (e: any) {
          console.error(`[instagramLogin] @${profile.username} — reels_tray failed (non-fatal): ${e?.message}`);
        }

        // ── Phase 2d: ExecuteNotificationsBadge (news/inbox) ─────────────
        try {
          await ig.news.inbox();
          console.error(`[instagramLogin] @${profile.username} — news/inbox (ExecuteNotificationsBadge) OK`);
        } catch (e: any) {
          console.error(`[instagramLogin] @${profile.username} — news/inbox failed (non-fatal): ${e?.message}`);
        }

        // ── Phase 2e: FetchConfig (qe/sync) ──────────────────────────────
        // Jarvee calls FetchConfig after notifications (step 10 in cold-start).
        try {
          await ig.qe.syncLoginExperiments();
          console.error(`[instagramLogin] @${profile.username} — qe/sync (FetchConfig) OK`);
        } catch (e: any) {
          console.error(`[instagramLogin] @${profile.username} — qe/sync (FetchConfig) failed (non-fatal): ${e?.message}`);
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
          console.error(`[instagramLogin] @${profile.username} — banyan/banyan failed (non-fatal): ${e?.message}`);
        }

        // ── Phase 2g: ExecuteDiscoverExplore (discover/topical_explore) ───
        // Jarvee calls this last in the cold-start sequence (step 12).
        try {
          await (ig.discover as any).topicalExplore();
          console.error(`[instagramLogin] @${profile.username} — discover/topical_explore (ExecuteDiscoverExplore) OK`);
        } catch (e: any) {
          console.error(`[instagramLogin] @${profile.username} — discover/topical_explore failed (non-fatal): ${e?.message}`);
        }

        console.error(`[instagramLogin] @${profile.username} — cold-start handshake complete ✓`);
        return {
          ok: true,
          message: `ACCOUNT VERIFIED VIA API ✓`,
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
