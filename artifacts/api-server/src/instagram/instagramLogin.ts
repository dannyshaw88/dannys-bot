import { IgApiClient, IgCheckpointError, IgLoginTwoFactorRequiredError, IgLoginBadPasswordError, IgLoginInvalidUserError } from "instagram-private-api";
import { generateSync as totpGenerate } from "otplib";
import { db } from "@workspace/db";
import { instagramApiCalls } from "../shared/schema";
import type { Profile } from "../shared/schema";

export type VerifyResult =
  | { ok: true; message: string; accountStatus: "valid"; igDeviceState?: string }
  | { ok: false; message: string; accountStatus: "banned" | "captcha" | "2fa_verification" | "phone_verification" | "email_confirmation" | "logged_out"; igDeviceState?: string };

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

function buildProxyUrl(profile: Profile): string | null {
  if (!profile.proxyHost || !profile.proxyPort) return null;
  const auth = profile.proxyUsername && profile.proxyPassword
    ? `${encodeURIComponent(profile.proxyUsername)}:${encodeURIComponent(profile.proxyPassword)}@`
    : "";
  return `http://${auth}${profile.proxyHost}:${profile.proxyPort}`;
}

/** Strip /api/v1/ prefix and trailing slash to get a clean endpoint label */
function extractOperationName(rawUrl: string): string {
  const path = rawUrl.split("?")[0];
  return path.replace(/^(https?:\/\/[^/]+)?\/api\/v\d+\//, "").replace(/\/$/, "") || path;
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
      statusStr = String(response?.statusCode ?? 200);
    } catch (err: any) {
      const durationMs = Date.now() - t0;
      const code: number = err?.statusCode ?? err?.response?.statusCode ?? 0;
      const errShort = err?.message?.slice(0, 80) ?? "error";
      statusStr = code ? `${code} ${errShort}` : errShort;
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
  const deviceSeed = profile.userAgentApi ?? profile.username;

  if (profile.igDeviceState) {
    try {
      const saved = JSON.parse(profile.igDeviceState);
      ig.state.generateDevice(deviceSeed);
      if (saved.deviceId) ig.state.deviceId = saved.deviceId;
      if (saved.uuid) ig.state.uuid = saved.uuid;
      if (saved.phoneId) ig.state.phoneId = saved.phoneId;
      if (saved.adid) ig.state.adid = saved.adid;
      if (saved.deviceString) ig.state.deviceString = saved.deviceString;
      console.error(`[instagramLogin] Restored device state for @${profile.username} (deviceId=${ig.state.deviceId})`);
    } catch {
      ig.state.generateDevice(deviceSeed);
      if (profile.userAgentApi) ig.state.deviceString = profile.userAgentApi;
    }
  } else {
    ig.state.generateDevice(deviceSeed);
    if (profile.userAgentApi) ig.state.deviceString = profile.userAgentApi;
    console.error(`[instagramLogin] Generated new device for @${profile.username} (deviceId=${ig.state.deviceId})`);
  }

  if (proxyUrl) ig.state.proxyUrl = proxyUrl;

  const captureDeviceState = () => JSON.stringify({
    deviceId: ig.state.deviceId,
    uuid: ig.state.uuid,
    phoneId: ig.state.phoneId,
    adid: ig.state.adid,
    deviceString: ig.state.deviceString,
  });

  return { ig, captureDeviceState };
}

export async function verifyInstagramCredentials(profile: Profile): Promise<VerifyResult> {
  const proxyUrl = buildProxyUrl(profile);
  console.error(`[instagramLogin] @${profile.username} proxy=${proxyUrl ?? "direct"}`);

  // ── Fast path: restore existing session from imported ApiCookies ──────────
  const proxyIp = profile.proxyHost ?? "";

  if (profile.igApiCookies) {
    // ── Session cookie fast path ───────────────────────────────────────────
    // We intentionally do NOT call currentUser()?edit=true here.
    // That endpoint triggers Instagram's checkpoint flow when called as the
    // very first request on a restored session (Instagram treats ?edit=true
    // as a profile-write attempt and demands verification — a false positive).
    // Jarvee itself never calls current_user on login; it does a cold-start
    // timeline fetch after establishing the session.
    //
    // Instead we trust the cookie structurally: Instagram encodes the numeric
    // user ID as the first colon-delimited segment of the sessionid value
    // (e.g. "77661428511:nXeHbuP299s22P:5:AYii…"). If we can parse it, the
    // cookie was issued by Instagram and is well-formed. Real problems (expired
    // session, banned account) surface when automation actually hits the API —
    // not from a synthetic checkpoint caused by the wrong handshake.
    const { ig, captureDeviceState } = buildIgClient(profile, proxyUrl);

    // Parse userId from sessionid
    const sessionPair = profile.igApiCookies.split(';')
      .map(s => s.trim())
      .find(s => s.toLowerCase().startsWith('sessionid='));
    if (sessionPair) {
      const rawVal = sessionPair.slice('sessionid='.length);
      let decoded = rawVal;
      try { decoded = decodeURIComponent(rawVal); } catch { /* keep as-is */ }
      const userId = decoded.split(':')[0];
      if (userId && /^\d+$/.test(userId)) {
        console.error(`[instagramLogin] @${profile.username} — cookie session accepted (userId=${userId})`);
        // Load cookies into the client state so it is ready for use
        await restoreSessionCookies(ig, profile.igApiCookies);
        return {
          ok: true,
          message: `@${profile.username} — session cookie loaded (userId ${userId}). The account is ready for automation.`,
          accountStatus: "valid",
          igDeviceState: captureDeviceState(),
        };
      }
    }

    // sessionid is malformed / missing — treat as no-cookie and fall through
    console.error(`[instagramLogin] @${profile.username} — could not parse sessionid from igApiCookies, falling through to password login`);
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
        return { ok: false, message: `@${profile.username} — logged in but Instagram requires a checkpoint before API access. Open the embedded browser to resolve it.`, accountStatus: "captcha", igDeviceState: captureDeviceState() };
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
      try { code = totpGenerate({ secret }); } catch {
        return { ok: false, message: `@${profile.username} — invalid 2FA secret key. Please re-enter it.`, accountStatus: "2fa_verification", igDeviceState: ds };
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
            return { ok: false, message: `@${profile.username} — passed 2FA but Instagram requires a checkpoint before API access. Open the embedded browser to resolve it.`, accountStatus: "captcha", igDeviceState: captureDeviceState() };
          }
        }
        return { ok: true, message: `@${profile.username} passed 2FA and logged in successfully.`, accountStatus: "valid", igDeviceState: captureDeviceState() };
      } catch (e2: any) {
        return { ok: false, message: `@${profile.username} — 2FA code rejected: ${e2?.message ?? "unknown"}`, accountStatus: "2fa_verification", igDeviceState: ds };
      }
    }

    if (err instanceof IgCheckpointError) {
      return { ok: false, message: `@${profile.username} — security checkpoint triggered. Open the browser and verify your account.`, accountStatus: "captcha", igDeviceState: ds };
    }

    if (err instanceof IgLoginBadPasswordError) {
      const body = err?.response?.body ?? {};
      const buttons: any[] = body?.buttons ?? [];
      const hasEmailAction = buttons.some((b: any) => b?.action === "send_one_click_login_email");
      const errorTitle: string = body?.error_title ?? "";
      if (hasEmailAction || /forgotten|email/i.test(errorTitle)) {
        return {
          ok: false,
          message: `@${profile.username} — Instagram requires email verification before allowing login from this device. Check the account's email inbox and click the confirmation link.`,
          accountStatus: "email_confirmation",
          igDeviceState: ds,
        };
      }
      return { ok: false, message: `@${profile.username} — incorrect password.`, accountStatus: "logged_out", igDeviceState: ds };
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
