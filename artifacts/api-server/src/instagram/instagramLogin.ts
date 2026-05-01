import * as https from "https";
import { IgApiClient, IgCheckpointError, IgLoginTwoFactorRequiredError } from "instagram-private-api";
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
  method: string,
  durationMs: number,
) {
  try {
    await db.insert(instagramApiCalls).values({
      profileId,
      operationName,
      date: new Date().toISOString(),
      message,
      source: method,
      navChain: "",
      ipAddress: "",
      durationMs,
    });
  } catch { /* never crash on logging failure */ }
}

// ── Low-level HTTPS helper ─────────────────────────────────────────────────────
function httpsRequest(
  options: https.RequestOptions,
  body?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: data,
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(new Error("timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

// ── Proxy-aware HTTPS request to instagram.com ────────────────────────────────
async function igRequest(opts: {
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

  let agent: any = undefined;
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

// ── Build proxy URL string from profile fields ─────────────────────────────────
function buildProxyUrl(profile: Profile): string | undefined {
  if (!profile.proxyHost || !profile.proxyPort) return undefined;
  const auth = profile.proxyUsername && profile.proxyPassword
    ? `${encodeURIComponent(profile.proxyUsername)}:${encodeURIComponent(profile.proxyPassword)}@`
    : "";
  return `http://${auth}${profile.proxyHost}:${profile.proxyPort}`;
}

const IG_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const IG_APP_ID = "936619743392459";

type WebSession = { cookieJar: string[]; csrfToken: string };

// ── Step 1: GET the login page to obtain the CSRF token ───────────────────────
async function getLoginPage(proxyUrl?: string): Promise<WebSession | null> {
  const res = await igRequest({
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

  console.error(`[webLogin] page status=${res.status} csrf=${csrfToken ? csrfToken.slice(0, 10) + "…" : "MISSING"}`);
  return csrfToken ? { cookieJar: res.cookies, csrfToken } : null;
}

// ── Step 2: POST login credentials ────────────────────────────────────────────
type LoginResult =
  | { outcome: "ok" }
  | { outcome: "bad_password" }
  | { outcome: "checkpoint" }
  | { outcome: "2fa"; twoFactorIdentifier: string; session: WebSession }
  | { outcome: "error"; detail: string };

async function postLogin(
  username: string,
  password: string,
  session: WebSession,
  proxyUrl?: string,
): Promise<LoginResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  const formBody = new URLSearchParams({
    username,
    enc_password: `#PWD_INSTAGRAM:0:${timestamp}:${password}`,
    queryParams: "{}",
    optIntoOneTap: "false",
  }).toString();

  const res = await igRequest({
    path: "/accounts/login/ajax/",
    method: "POST",
    headers: {
      "Host": "www.instagram.com",
      "User-Agent": IG_UA,
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRFToken": session.csrfToken,
      "X-IG-App-ID": IG_APP_ID,
      "X-Requested-With": "XMLHttpRequest",
      "Referer": "https://www.instagram.com/accounts/login/",
      "Origin": "https://www.instagram.com",
    },
    body: formBody,
    cookieJar: session.cookieJar,
    proxyUrl,
  });

  const j = res.json;
  console.error(`[webLogin] login ajax status=${res.status} body=${res.rawBody.slice(0, 300)}`);

  if (j?.authenticated === true) return { outcome: "ok" };
  if (j?.two_factor_required) {
    const identifier: string = j?.two_factor_info?.two_factor_identifier ?? "";
    // Merge any new session cookies returned with this response
    const mergedCookies = mergeCookies(session.cookieJar, res.cookies);
    let csrfToken = session.csrfToken;
    for (const c of res.cookies) {
      if (c.startsWith("csrftoken=")) { csrfToken = c.split("=")[1]; break; }
    }
    return { outcome: "2fa", twoFactorIdentifier: identifier, session: { cookieJar: mergedCookies, csrfToken } };
  }

  if (j?.checkpoint_url || j?.lock) return { outcome: "checkpoint" };
  if (j?.user === false || j?.authenticated === false) return { outcome: "bad_password" };

  return { outcome: "error", detail: res.rawBody.slice(0, 200) };
}

// ── Step 3 (optional): Submit TOTP 2FA code ───────────────────────────────────
async function postTwoFactor(
  username: string,
  totpCode: string,
  identifier: string,
  session: WebSession,
  proxyUrl?: string,
): Promise<{ ok: boolean; detail?: string }> {
  const formBody = new URLSearchParams({
    username,
    verificationCode: totpCode,
    identifier,
    queryParams: "{}",
    verificationMethod: "3", // 3 = TOTP/authenticator app on web
  }).toString();

  const res = await igRequest({
    path: "/accounts/login/ajax/two_factor/",
    method: "POST",
    headers: {
      "Host": "www.instagram.com",
      "User-Agent": IG_UA,
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRFToken": session.csrfToken,
      "X-IG-App-ID": IG_APP_ID,
      "X-Requested-With": "XMLHttpRequest",
      "Referer": "https://www.instagram.com/accounts/login/",
      "Origin": "https://www.instagram.com",
    },
    body: formBody,
    cookieJar: session.cookieJar,
    proxyUrl,
  });

  const j = res.json;
  console.error(`[webLogin] 2FA ajax status=${res.status} body=${res.rawBody.slice(0, 300)}`);
  if (j?.authenticated === true) return { ok: true };
  return { ok: false, detail: res.rawBody.slice(0, 200) };
}

// ── Merge cookie arrays (later values overwrite earlier by name) ───────────────
function mergeCookies(base: string[], overrides: string[]): string[] {
  const map = new Map<string, string>();
  for (const c of [...base, ...overrides]) {
    const [k] = c.split("=");
    map.set(k, c);
  }
  return Array.from(map.values());
}

// ── Main verify function ───────────────────────────────────────────────────────
export async function verifyInstagramCredentials(profile: Profile): Promise<VerifyResult> {
  const loginStart = Date.now();
  const proxyUrl = buildProxyUrl(profile);

  console.error(`[instagramLogin] @${profile.username} proxy=${proxyUrl ?? "direct"}`);

  // Step 1: get CSRF token
  const session = await getLoginPage(proxyUrl);
  if (!session) {
    return { ok: false, message: `Could not reach Instagram (failed to load login page). Check your proxy or network.`, accountStatus: "logged_out" };
  }

  // Step 2: post login
  const loginResult = await postLogin(profile.username, profile.password, session, proxyUrl);

  if (loginResult.outcome === "ok") {
    await logApiCall(profile.id, "accounts/login/web", `Login OK: @${profile.username}`, "POST", Date.now() - loginStart);
    return { ok: true, message: `@${profile.username} logged in successfully.`, accountStatus: "valid" };
  }

  if (loginResult.outcome === "bad_password") {
    await logApiCall(profile.id, "accounts/login/web", `Bad password: @${profile.username}`, "POST", Date.now() - loginStart);
    return { ok: false, message: `@${profile.username} — Instagram says the password is incorrect.`, accountStatus: "logged_out" };
  }

  if (loginResult.outcome === "checkpoint") {
    return { ok: false, message: `@${profile.username} — security checkpoint triggered. Open the browser and verify your account.`, accountStatus: "captcha" };
  }

  if (loginResult.outcome === "2fa") {
    const secret = profile.twoFASecretKey?.replace(/\s+/g, "") ?? "";
    if (!secret) {
      return { ok: false, message: `@${profile.username} — 2FA required but no secret key is set. Add your TOTP secret in the Account Details section.`, accountStatus: "2fa_verification" };
    }

    let totpCode: string;
    try {
      totpCode = totpGenerate({ secret });
    } catch {
      return { ok: false, message: `@${profile.username} — invalid 2FA secret key. Please re-enter it in Account Details.`, accountStatus: "2fa_verification" };
    }

    console.error(`[instagramLogin] Submitting 2FA TOTP for @${profile.username}, identifier=${loginResult.twoFactorIdentifier}`);
    const twoFaResult = await postTwoFactor(
      profile.username,
      totpCode,
      loginResult.twoFactorIdentifier,
      loginResult.session,
      proxyUrl,
    );

    if (twoFaResult.ok) {
      await logApiCall(profile.id, "accounts/login/web/2fa", `2FA OK: @${profile.username}`, "POST", Date.now() - loginStart);
      return { ok: true, message: `@${profile.username} passed 2FA and logged in successfully.`, accountStatus: "valid" };
    }

    // 2FA failed via web — try mobile API as last resort
    console.error(`[instagramLogin] Web 2FA rejected, trying mobile API for @${profile.username}`);
    return await verifyViaMobileApi(profile, proxyUrl, loginStart);
  }

  // Unexpected error — try mobile API as fallback
  console.error(`[instagramLogin] Web login errored, trying mobile API for @${profile.username}: ${(loginResult as any).detail}`);
  return await verifyViaMobileApi(profile, proxyUrl, loginStart);
}

// ── Mobile API fallback (last resort) ────────────────────────────────────────
async function verifyViaMobileApi(profile: Profile, proxyUrl: string | undefined, loginStart: number): Promise<VerifyResult> {
  const ig = new IgApiClient();
  ig.state.generateDevice(`${profile.username}_${profile.id}_${Date.now()}`);
  if (profile.userAgentApi) ig.state.deviceString = profile.userAgentApi;
  if (proxyUrl) ig.state.proxyUrl = proxyUrl;

  try {
    await ig.account.login(profile.username, profile.password);
    await logApiCall(profile.id, "accounts/login", `Login OK (mobile API): @${profile.username}`, "POST", Date.now() - loginStart);
    ig.simulate.postLoginFlow().catch(() => {});
    return { ok: true, message: `@${profile.username} logged in successfully.`, accountStatus: "valid" };
  } catch (err: any) {
    if (err instanceof IgLoginTwoFactorRequiredError) {
      const twoFactorInfo = err.response.body.two_factor_info;
      const secret = profile.twoFASecretKey?.replace(/\s+/g, "") ?? "";
      if (!secret) return { ok: false, message: `@${profile.username} — 2FA required. Add your TOTP secret in Account Details.`, accountStatus: "2fa_verification" };
      try {
        const code = totpGenerate({ secret });
        await ig.account.twoFactorLogin({
          username: profile.username,
          verificationCode: code,
          twoFactorIdentifier: twoFactorInfo.two_factor_identifier,
          verificationMethod: "0",
          trustThisDevice: "1",
        });
        ig.simulate.postLoginFlow().catch(() => {});
        return { ok: true, message: `@${profile.username} passed 2FA (mobile) and logged in.`, accountStatus: "valid" };
      } catch (e: any) {
        return { ok: false, message: `@${profile.username} — 2FA code rejected. Check your secret key.`, accountStatus: "2fa_verification" };
      }
    }
    if (err instanceof IgCheckpointError) {
      return { ok: false, message: `@${profile.username} — checkpoint. Open the browser to verify.`, accountStatus: "captcha" };
    }
    return { ok: false, message: `@${profile.username} — login failed: ${err?.message ?? "unknown error"}`, accountStatus: "logged_out" };
  }
}
