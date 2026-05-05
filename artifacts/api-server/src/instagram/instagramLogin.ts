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
const MOBILE_VERSION      = "361.0.0.32.109";
const MOBILE_VERSION_CODE = "617571539";

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

async function logApiCall(
  profileId: number,
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
export function attachRequestLogger(ig: IgApiClient, profileId: number, source: string, proxyIp: string) {
  const req = ig.request as any;
  if (req.__logged) return; // prevent double-patching
  req.__logged = true;

  const originalSend = req.send.bind(req);
  req.send = async function(userOptions: any, onlyCheckHttpStatus?: boolean) {
    const t0 = Date.now();
    const rawUrl: string = userOptions?.url || userOptions?.uri || "";
    const opName = extractOperationName(rawUrl);

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
      // Extract nav_chain from the original request body even on error
      const bodyStr: string = userOptions?.form
        ? new URLSearchParams(userOptions.form).toString()
        : (typeof userOptions?.body === "string" ? userOptions.body : "");
      const navChain = extractFromBody(bodyStr, "nav_chain");
      logApiCall(profileId, opName, statusStr, source, navChain, proxyIp, durationMs).catch(() => {});
      throw err;
    }

    const durationMs = Date.now() - t0;
    // nav_chain lives in the outgoing request body (URL-encoded form)
    const sentBody: string | Buffer | undefined = response?.request?.body;
    const navChain = extractFromBody(sentBody, "nav_chain");
    logApiCall(profileId, opName, statusStr, source, navChain, proxyIp, durationMs).catch(() => {});
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
    console.error(`[instagramLogin] Generated NEW device for @${profile.username} (deviceId=${ig.state.deviceId} uuid=${ig.state.uuid?.slice(0,8)}…)`);
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

  cookiePath: if (profile.igApiCookies) {
    // ── Cookie session handshake ───────────────────────────────────────────
    // Mirrors the Jarvee cold-start sequence for a restored session:
    //   1. launcher/sync  (SendMobileConfig)  — establishes app config, no auth needed
    //   2. users/{id}/info                    — lightweight read that validates the live
    //                                           sessionid WITHOUT triggering the false
    //                                           checkpoint that currentUser()?edit=true causes
    //
    // We intentionally avoid currentUser()?edit=true — Instagram treats that as a
    // profile-write attempt on a freshly restored session and raises checkpoint_required.
    const { ig, captureDeviceState } = buildIgClient(profile, proxyUrl);
    attachRequestLogger(ig, profile.id, "Verify", proxyIp);

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

        // ── Phase 2a: GetAccountFamily (accounts/get_account_family) ─────
        // First authenticated call in Jarvee's session-restore sequence.
        // Validates the sessionid is alive. Any checkpoint_required here is
        // treated as a genuine account-level checkpoint — the user must resolve
        // it via the embedded browser. (Verify always runs on the same machine/
        // proxy as automation, so IP-mismatch false-positives don't apply.)
        let accountFamilyOk = false;
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
          accountFamilyOk = true;
          console.error(`[instagramLogin] @${profile.username} — get_account_family (GetAccountFamily) OK`);
        } catch (famErr: any) {
          const msg: string = famErr?.message ?? "";
          const responseBody = famErr?.response?.body ?? {};
          const igMsg: string = (typeof responseBody === "object" && responseBody !== null
            ? (responseBody?.message ?? "")
            : "") as string;
          const statusCode: number | undefined = famErr?.response?.statusCode;
          console.error(`[instagramLogin] @${profile.username} — get_account_family failed: HTTP ${statusCode ?? "n/a"} igMsg="${igMsg}" raw="${msg}"`);

          if (famErr instanceof IgCheckpointError || /checkpoint/i.test(msg) || /checkpoint/i.test(igMsg)) {
            return {
              ok: false,
              message: `@${profile.username} — account requires a security checkpoint. Open the embedded browser to resolve it.`,
              accountStatus: "captcha",
              checkpointUrl: extractCheckpointUrl(famErr),
              igDeviceState: captureDeviceState(),
            };
          } else if (/login_required|not.*auth/i.test(msg) || /login_required|not.*auth/i.test(igMsg) || statusCode === 401) {
            return {
              ok: false,
              message: `@${profile.username} — session expired or revoked. Open the embedded browser to log in again.`,
              accountStatus: "logged_out",
              igDeviceState: captureDeviceState(),
            };
          } else if (/invalid_credentials/i.test(igMsg) || /invalid_credentials/i.test(msg)) {
            return {
              ok: false,
              message: `@${profile.username} — Instagram rejected the credentials as invalid.`,
              accountStatus: "invalid_credentials",
              igDeviceState: captureDeviceState(),
            };
          } else if (/bad_password/i.test(igMsg) || /bad_password/i.test(msg)) {
            return {
              ok: false,
              message: `@${profile.username} — incorrect password.`,
              accountStatus: "bad_password",
              igDeviceState: captureDeviceState(),
            };
          } else if (statusCode && statusCode >= 400 && statusCode < 600) {
            // Instagram responded with a real HTTP error — session cookie is dead or
            // the endpoint is unavailable. Return logged_out immediately.
            // CRITICAL: do NOT fall through to password login here. Making a fresh
            // password attempt immediately after a failed cookie probe looks like an
            // account takeover attempt to Instagram and will trigger an account block.
            console.error(`[instagramLogin] @${profile.username} — get_account_family HTTP ${statusCode}; session appears expired/dead, returning logged_out`);
            return {
              ok: false,
              message: `@${profile.username} — session cookie appears to be expired (HTTP ${statusCode} from Instagram). Please update the password and re-verify, or restore the session via the embedded browser.`,
              accountStatus: "logged_out",
              igDeviceState: captureDeviceState(),
            };
          } else {
            // No HTTP status — genuine network/proxy error (ECONNREFUSED, timeout, DNS fail).
            // Password login would fail too, so surface the error immediately.
            console.error(`[instagramLogin] @${profile.username} — get_account_family network/proxy error, treating as inconclusive`);
            return {
              ok: false,
              message: `@${profile.username} — could not reach Instagram (proxy or network error). Try again.`,
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
          message: `@${profile.username} — session active. Cold-start handshake complete (launcher/sync → qe/sync → get_account_family → timeline → reels_tray → inbox → qe/sync → banyan → discover).`,
          accountStatus: "valid",
          igDeviceState: captureDeviceState(),
        };
      }
    }
  }

  // ── Normal path: fresh password login (only when no cookies are stored) ──
  const { ig, captureDeviceState } = buildIgClient(profile, proxyUrl);
  attachRequestLogger(ig, profile.id, "Verify", proxyIp);

  // Step 1: Fetch encryption keys (must happen before login)
  await ensureEncryptionKeys(ig);

  if (!ig.state.passwordEncryptionPubKey) {
    return {
      ok: false,
      message: `@${profile.username} — could not reach Instagram servers. Check your proxy or network connection.`,
      accountStatus: "logged_out",
    };
  }

  // Step 2: Pre-login flow (fetch_headers, qe/sync, launcher/sync, prefill — like Jarvee)
  try {
    await ig.simulate.preLoginFlow();
    console.error(`[instagramLogin] preLoginFlow OK for @${profile.username}`);
  } catch (e: any) {
    console.error(`[instagramLogin] preLoginFlow partial failure (continuing): ${e?.message}`);
  }

  // Step 3: Login
  try {
    await ig.account.login(profile.username, profile.password);
    try {
      await ig.simulate.postLoginFlow();
    } catch (plErr: any) {
      if (plErr instanceof IgCheckpointError || /checkpoint/i.test(plErr?.message ?? "")) {
        return { ok: false, message: `@${profile.username} — logged in but Instagram requires a checkpoint before API access. Open the embedded browser to resolve it.`, accountStatus: "captcha", checkpointUrl: extractCheckpointUrl(plErr), igDeviceState: captureDeviceState() };
      }
    }
    return { ok: true, message: `@${profile.username} logged in successfully.`, accountStatus: "valid", igDeviceState: captureDeviceState() };

  } catch (err: any) {
    const errName: string = err?.constructor?.name ?? "";
    const errBody = JSON.stringify(err?.response?.body ?? {}).slice(0, 2000);
    console.error(`[instagramLogin] login error for @${profile.username}: ${errName} — ${err?.message} — body: ${errBody}`);
    const ds = captureDeviceState();

    if (err instanceof IgLoginTwoFactorRequiredError) {
      const twoFactorInfo = err.response.body.two_factor_info;
      const secret = profile.twoFASecretKey?.replace(/\s+/g, "") ?? "";
      if (!secret) {
        return { ok: false, message: `@${profile.username} — 2FA required but no TOTP secret is set. Add it in Account Details.`, accountStatus: "2fa_verification", igDeviceState: ds };
      }
      let code: string;
      try {
        // otplib v13: generateSync expects { secret } object, not a plain string
        code = totpGenerate({ secret });
      } catch (totpErr: any) {
        console.error(`[instagramLogin] TOTP generation failed for @${profile.username}: ${totpErr?.message}`);
        return { ok: false, message: `@${profile.username} — could not generate 2FA code: ${totpErr?.message ?? "invalid secret"}. Check the TOTP secret in Account Details.`, accountStatus: "2fa_verification", igDeviceState: ds };
      }
      try {
        await ig.account.twoFactorLogin({
          username: profile.username,
          verificationCode: code,
          twoFactorIdentifier: twoFactorInfo.two_factor_identifier,
          verificationMethod: "0",
          trustThisDevice: "1",
        });
        try {
          await ig.simulate.postLoginFlow();
        } catch (plErr: any) {
          if (plErr instanceof IgCheckpointError || /checkpoint/i.test(plErr?.message ?? "")) {
            return { ok: false, message: `@${profile.username} — passed 2FA but Instagram requires a checkpoint before API access. Open the embedded browser to resolve it.`, accountStatus: "captcha", checkpointUrl: extractCheckpointUrl(plErr), igDeviceState: captureDeviceState() };
          }
        }
        return { ok: true, message: `@${profile.username} passed 2FA and logged in successfully.`, accountStatus: "valid", igDeviceState: captureDeviceState() };
      } catch (e2: any) {
        return { ok: false, message: `@${profile.username} — 2FA code rejected: ${e2?.message ?? "unknown"}`, accountStatus: "2fa_verification", igDeviceState: ds };
      }
    }

    if (err instanceof IgCheckpointError) {
      return { ok: false, message: `@${profile.username} — security checkpoint triggered. Open the browser and verify your account.`, accountStatus: "captcha", checkpointUrl: extractCheckpointUrl(err), igDeviceState: ds };
    }

    if (err instanceof IgLoginBadPasswordError) {
      const body = err?.response?.body ?? {};
      const rawBody = JSON.stringify(body).slice(0, 1500);
      console.error(`[instagramLogin] IgLoginBadPasswordError raw body for @${profile.username}: ${rawBody}`);
      const buttons: any[] = body?.buttons ?? [];
      const errorTitle: string = body?.error_title ?? "";
      const errorType: string = body?.error_type ?? "";
      const invalidCreds: boolean = body?.invalid_credentials === true;
      // Instagram returns "bad_password" + invalid_credentials:true when the password
      // is actually wrong (or device version mismatch fakes it).  The email button it
      // includes is a generic recovery offer — NOT a genuine email-confirmation challenge.
      // Only treat as email_confirmation when Instagram does NOT say bad_password explicitly.
      if (!invalidCreds && errorType !== "bad_password" && buttons.some((b: any) => b?.action === "send_one_click_login_email")) {
        return {
          ok: false,
          message: `@${profile.username} — Instagram requires email verification. Check the account email and click the confirmation link. Raw: ${rawBody}`,
          accountStatus: "email_confirmation",
          igDeviceState: ds,
        };
      }
      return { ok: false, message: `@${profile.username} — incorrect password (error_type="${errorType}", invalid_credentials=${invalidCreds}). Raw: ${rawBody}`, accountStatus: "bad_password", igDeviceState: ds };
    }

    if (err instanceof IgLoginInvalidUserError) {
      return { ok: false, message: `@${profile.username} — account does not exist on Instagram.`, accountStatus: "banned", igDeviceState: ds };
    }

    const msg: string = err?.message ?? "unknown error";
    if (/banned|disabled|suspended/i.test(msg)) {
      return { ok: false, message: `@${profile.username} — account banned or disabled.`, accountStatus: "banned", igDeviceState: ds };
    }
    if (/checkpoint/i.test(msg)) {
      return { ok: false, message: `@${profile.username} — checkpoint required.`, accountStatus: "captcha", igDeviceState: ds };
    }

    return { ok: false, message: `@${profile.username} — login failed: ${msg}`, accountStatus: "logged_out", igDeviceState: ds };
  }
}
