import * as https from "https";
import { IgApiClient, IgCheckpointError, IgLoginTwoFactorRequiredError, IgLoginBadPasswordError, IgLoginInvalidUserError } from "instagram-private-api";
import { generateSync as totpGenerate } from "otplib";
import { db } from "@workspace/db";
import { instagramApiCalls } from "../shared/schema";
import type { Profile } from "../shared/schema";

export type VerifyResult =
  | { ok: true; message: string; accountStatus: "valid" }
  | { ok: false; message: string; accountStatus: "banned" | "captcha" | "2fa_verification" | "phone_verification" | "email_confirmation" | "logged_out" };

async function logApiCall(
  profileId: number,
  operationName: string,
  message: string,
  source: string,
  durationMs: number,
) {
  try {
    await db.insert(instagramApiCalls).values({
      profileId,
      operationName,
      date: new Date().toISOString(),
      message,
      source,
      navChain: "",
      ipAddress: "",
      durationMs,
    });
  } catch { /* never crash on logging failure */ }
}

function buildProxyUrl(profile: Profile): string | undefined {
  if (!profile.proxyHost || !profile.proxyPort) return undefined;
  const auth = profile.proxyUsername && profile.proxyPassword
    ? `${encodeURIComponent(profile.proxyUsername)}:${encodeURIComponent(profile.proxyPassword)}@`
    : "";
  return `http://${auth}${profile.proxyHost}:${profile.proxyPort}`;
}

function extractOperationName(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\/api\/v\d+\//, "").replace(/\/$/, "") || u.pathname;
  } catch {
    return url.split("?")[0].replace(/^\/api\/v\d+\//, "").replace(/\/$/, "");
  }
}

function attachRequestLogger(ig: IgApiClient, profileId: number) {
  ig.request.end$.subscribe({
    next: async (response: any) => {
      try {
        const url: string =
          response?.request?.requestUrl ??
          response?.url ??
          response?.request?.options?.url ?? "";
        const opName = extractOperationName(url);
        const phases = response?.timings?.phases ?? {};
        const durationMs: number = phases.total ?? phases.firstByte ?? 0;
        const status: number = response?.statusCode ?? 0;
        const method: string = (response?.request?.options?.method ?? "POST").toUpperCase();
        await logApiCall(profileId, opName, `HTTP ${status} @${ig.state.username ?? profileId}`, method, Math.round(durationMs));
      } catch { /* ignore */ }
    },
  });
}

// ── Low-level HTTPS helper ────────────────────────────────────────────────────
function httpsRequest(
  options: https.RequestOptions,
  body?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers as any, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(new Error("timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

async function igWebRequest(opts: {
  path: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  cookieJar?: string[];
  proxyUrl?: string;
}): Promise<{ status: number; cookies: string[]; json: any; rawBody: string }> {
  const { path, method, headers, body, cookieJar = [], proxyUrl } = opts;
  const reqHeaders: Record<string, string> = {
    ...headers,
    ...(cookieJar.length ? { "Cookie": cookieJar.join("; ") } : {}),
    ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
  };
  let agent: any;
  if (proxyUrl) {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    agent = new HttpsProxyAgent(proxyUrl);
  }
  const res = await httpsRequest(
    { host: "www.instagram.com", port: 443, path, method, headers: reqHeaders, ...(agent ? { agent } : {}) },
    body,
  );
  const setCookieRaw = res.headers["set-cookie"];
  const setCookies: string[] = Array.isArray(setCookieRaw) ? setCookieRaw : (setCookieRaw ? [setCookieRaw] : []);
  const newCookies = setCookies.map(c => c.split(";")[0]);
  let json: any = null;
  try { json = JSON.parse(res.body); } catch { /* not JSON */ }
  return { status: res.status, cookies: newCookies, json, rawBody: res.body };
}

function mergeCookies(base: string[], overrides: string[]): string[] {
  const map = new Map<string, string>();
  for (const c of [...base, ...overrides]) {
    const [k] = c.split("=");
    map.set(k, c);
  }
  return Array.from(map.values());
}

const IG_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const IG_APP_ID = "936619743392459";

type WebSession = { cookieJar: string[]; csrfToken: string };

async function webGetLoginPage(proxyUrl?: string): Promise<WebSession | null> {
  const res = await igWebRequest({
    path: "/accounts/login/",
    method: "GET",
    headers: {
      "Host": "www.instagram.com",
      "User-Agent": IG_UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    proxyUrl,
  });
  let csrfToken = "";
  for (const c of res.cookies) {
    if (c.startsWith("csrftoken=")) { csrfToken = c.split("=")[1]; break; }
  }
  if (!csrfToken) {
    const m = res.rawBody.match(/"csrf_token":"([^"]+)"/);
    if (m) csrfToken = m[1];
  }
  console.error(`[webLogin] page status=${res.status} csrf=${csrfToken ? "ok" : "MISSING"}`);
  return csrfToken ? { cookieJar: res.cookies, csrfToken } : null;
}

async function webPostLogin(
  username: string, password: string, session: WebSession, proxyUrl?: string,
): Promise<{ outcome: "ok" } | { outcome: "2fa"; identifier: string; session: WebSession } | { outcome: "checkpoint" } | { outcome: "bad_password" } | { outcome: "error"; detail: string }> {
  const timestamp = Math.floor(Date.now() / 1000);
  const formBody = new URLSearchParams({
    username,
    enc_password: `#PWD_INSTAGRAM:0:${timestamp}:${password}`,
    queryParams: "{}",
    optIntoOneTap: "false",
  }).toString();
  const res = await igWebRequest({
    path: "/accounts/login/ajax/",
    method: "POST",
    headers: {
      "Host": "www.instagram.com", "User-Agent": IG_UA, "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRFToken": session.csrfToken, "X-IG-App-ID": IG_APP_ID,
      "X-Requested-With": "XMLHttpRequest",
      "Referer": "https://www.instagram.com/accounts/login/",
      "Origin": "https://www.instagram.com",
    },
    body: formBody,
    cookieJar: session.cookieJar,
    proxyUrl,
  });
  console.error(`[webLogin] ajax status=${res.status} body=${res.rawBody.slice(0, 200)}`);
  const j = res.json;
  if (j?.authenticated === true) return { outcome: "ok" };
  if (j?.two_factor_required) {
    const identifier = j?.two_factor_info?.two_factor_identifier ?? "";
    const merged = mergeCookies(session.cookieJar, res.cookies);
    let csrf = session.csrfToken;
    for (const c of res.cookies) { if (c.startsWith("csrftoken=")) { csrf = c.split("=")[1]; break; } }
    return { outcome: "2fa", identifier, session: { cookieJar: merged, csrfToken: csrf } };
  }
  if (j?.checkpoint_url || j?.lock) return { outcome: "checkpoint" };
  if (j?.user === false || j?.authenticated === false) return { outcome: "bad_password" };
  return { outcome: "error", detail: res.rawBody.slice(0, 200) };
}

async function webPostTwoFactor(
  username: string, totpCode: string, identifier: string, session: WebSession, proxyUrl?: string,
): Promise<boolean> {
  const formBody = new URLSearchParams({
    username, verificationCode: totpCode, identifier,
    queryParams: "{}", verificationMethod: "3",
  }).toString();
  const res = await igWebRequest({
    path: "/accounts/login/ajax/two_factor/",
    method: "POST",
    headers: {
      "Host": "www.instagram.com", "User-Agent": IG_UA, "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRFToken": session.csrfToken, "X-IG-App-ID": IG_APP_ID,
      "X-Requested-With": "XMLHttpRequest",
      "Referer": "https://www.instagram.com/accounts/login/",
      "Origin": "https://www.instagram.com",
    },
    body: formBody,
    cookieJar: session.cookieJar,
    proxyUrl,
  });
  return res.json?.authenticated === true;
}

// ── Main verify: mobile API for logging, web login for reliable auth ──────────
export async function verifyInstagramCredentials(profile: Profile): Promise<VerifyResult> {
  const proxyUrl = buildProxyUrl(profile);
  console.error(`[instagramLogin] @${profile.username} proxy=${proxyUrl ?? "direct"}`);

  const loginStart = Date.now();

  // ── Phase 1: Mobile pre-login flow (generates fetch_headers, qe/sync, etc.) ─
  const ig = new IgApiClient();
  ig.state.generateDevice(profile.username);
  if (profile.userAgentApi) ig.state.deviceString = profile.userAgentApi;
  if (proxyUrl) ig.state.proxyUrl = proxyUrl;
  attachRequestLogger(ig, profile.id);

  try {
    await ig.simulate.preLoginFlow();
    console.error(`[instagramLogin] preLoginFlow completed for @${profile.username}`);
  } catch (e: any) {
    console.error(`[instagramLogin] preLoginFlow error (continuing): ${e?.message}`);
  }

  // ── Phase 2: Try mobile API login first ────────────────────────────────────
  try {
    await ig.account.login(profile.username, profile.password);
    ig.simulate.postLoginFlow().catch(() => {});
    return { ok: true, message: `@${profile.username} logged in successfully.`, accountStatus: "valid" };

  } catch (mobileErr: any) {
    console.error(`[instagramLogin] Mobile login failed for @${profile.username}: ${mobileErr?.constructor?.name} — ${mobileErr?.message}`);

    // Handle definitive mobile errors that don't need a web fallback
    if (mobileErr instanceof IgLoginTwoFactorRequiredError) {
      return await handle2FA(profile, mobileErr, ig, proxyUrl, loginStart);
    }
    if (mobileErr instanceof IgCheckpointError) {
      return { ok: false, message: `@${profile.username} — security checkpoint triggered. Open the browser to verify.`, accountStatus: "captcha" };
    }
    if (mobileErr instanceof IgLoginInvalidUserError) {
      return { ok: false, message: `@${profile.username} — account does not exist.`, accountStatus: "banned" };
    }

    // Bad password from mobile API may be a false positive (outdated lib) — try web login
    console.error(`[instagramLogin] Falling back to web login for @${profile.username}`);
  }

  // ── Phase 3: Web login fallback ────────────────────────────────────────────
  const session = await webGetLoginPage(proxyUrl);
  if (!session) {
    await logApiCall(profile.id, "accounts/login/web", `Could not reach Instagram — check proxy`, "GET", Date.now() - loginStart);
    return { ok: false, message: `@${profile.username} — could not reach Instagram. Check your proxy or network.`, accountStatus: "logged_out" };
  }

  const webResult = await webPostLogin(profile.username, profile.password, session, proxyUrl);

  if (webResult.outcome === "ok") {
    await logApiCall(profile.id, "accounts/login/web", `Login OK: @${profile.username}`, "POST", Date.now() - loginStart);
    return { ok: true, message: `@${profile.username} logged in successfully.`, accountStatus: "valid" };
  }

  if (webResult.outcome === "2fa") {
    const secret = profile.twoFASecretKey?.replace(/\s+/g, "") ?? "";
    if (!secret) return { ok: false, message: `@${profile.username} — 2FA required but no secret key is set.`, accountStatus: "2fa_verification" };
    let code: string;
    try { code = totpGenerate({ secret }); } catch {
      return { ok: false, message: `@${profile.username} — invalid 2FA secret key.`, accountStatus: "2fa_verification" };
    }
    const ok = await webPostTwoFactor(profile.username, code, webResult.identifier, webResult.session, proxyUrl);
    if (ok) {
      await logApiCall(profile.id, "accounts/login/web/2fa", `2FA OK: @${profile.username}`, "POST", Date.now() - loginStart);
      return { ok: true, message: `@${profile.username} passed 2FA and logged in successfully.`, accountStatus: "valid" };
    }
    return { ok: false, message: `@${profile.username} — 2FA code rejected.`, accountStatus: "2fa_verification" };
  }

  if (webResult.outcome === "checkpoint") {
    return { ok: false, message: `@${profile.username} — security checkpoint triggered. Open the browser to verify.`, accountStatus: "captcha" };
  }

  if (webResult.outcome === "bad_password") {
    await logApiCall(profile.id, "accounts/login/web", `Bad password: @${profile.username}`, "POST", Date.now() - loginStart);
    return { ok: false, message: `@${profile.username} — incorrect password.`, accountStatus: "logged_out" };
  }

  await logApiCall(profile.id, "accounts/login/web", `Login error: ${(webResult as any).detail}`, "POST", Date.now() - loginStart);
  return { ok: false, message: `@${profile.username} — login failed. Check credentials and proxy.`, accountStatus: "logged_out" };
}

async function handle2FA(
  profile: Profile,
  err: IgLoginTwoFactorRequiredError,
  ig: IgApiClient,
  proxyUrl: string | undefined,
  loginStart: number,
): Promise<VerifyResult> {
  const twoFactorInfo = err.response.body.two_factor_info;
  const secret = profile.twoFASecretKey?.replace(/\s+/g, "") ?? "";
  if (!secret) return { ok: false, message: `@${profile.username} — 2FA required but no secret key is set. Add your TOTP secret in Account Details.`, accountStatus: "2fa_verification" };
  let code: string;
  try { code = totpGenerate({ secret }); } catch {
    return { ok: false, message: `@${profile.username} — invalid 2FA secret key.`, accountStatus: "2fa_verification" };
  }
  try {
    await ig.account.twoFactorLogin({
      username: profile.username,
      verificationCode: code,
      twoFactorIdentifier: twoFactorInfo.two_factor_identifier,
      verificationMethod: "0",
      trustThisDevice: "1",
    });
    ig.simulate.postLoginFlow().catch(() => {});
    return { ok: true, message: `@${profile.username} passed 2FA and logged in successfully.`, accountStatus: "valid" };
  } catch (e2: any) {
    return { ok: false, message: `@${profile.username} — 2FA code rejected: ${e2?.message ?? "unknown"}`, accountStatus: "2fa_verification" };
  }
}
