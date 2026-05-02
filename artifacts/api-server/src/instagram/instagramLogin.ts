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

export async function verifyInstagramCredentials(profile: Profile): Promise<VerifyResult> {
  const proxyUrl = buildProxyUrl(profile);
  console.error(`[instagramLogin] @${profile.username} proxy=${proxyUrl ?? "direct"}`);

  const ig = new IgApiClient();
  ig.state.generateDevice(profile.username);
  if (profile.userAgentApi) ig.state.deviceString = profile.userAgentApi;
  if (proxyUrl) ig.state.proxyUrl = proxyUrl;

  attachRequestLogger(ig, profile.id);

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
    ig.simulate.postLoginFlow().catch(() => {});
    return { ok: true, message: `@${profile.username} logged in successfully.`, accountStatus: "valid" };

  } catch (err: any) {
    const errName: string = err?.constructor?.name ?? "";
    const errBody = JSON.stringify(err?.response?.body ?? {}).slice(0, 300);
    console.error(`[instagramLogin] login error for @${profile.username}: ${errName} — ${err?.message} — body: ${errBody}`);

    if (err instanceof IgLoginTwoFactorRequiredError) {
      const twoFactorInfo = err.response.body.two_factor_info;
      const secret = profile.twoFASecretKey?.replace(/\s+/g, "") ?? "";
      if (!secret) {
        return { ok: false, message: `@${profile.username} — 2FA required but no TOTP secret is set. Add it in Account Details.`, accountStatus: "2fa_verification" };
      }
      let code: string;
      try { code = totpGenerate({ secret }); } catch {
        return { ok: false, message: `@${profile.username} — invalid 2FA secret key. Please re-enter it.`, accountStatus: "2fa_verification" };
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

    if (err instanceof IgCheckpointError) {
      return { ok: false, message: `@${profile.username} — security checkpoint triggered. Open the browser and verify your account.`, accountStatus: "captcha" };
    }

    if (err instanceof IgLoginBadPasswordError) {
      // Instagram sometimes returns this error class for email/nonce challenges rather than a real bad password.
      // Detect by checking the actual response body.
      const body = err?.response?.body ?? {};
      const buttons: any[] = body?.buttons ?? [];
      const hasEmailAction = buttons.some((b: any) => b?.action === "send_one_click_login_email");
      const errorTitle: string = body?.error_title ?? "";
      if (hasEmailAction || /forgotten|email/i.test(errorTitle)) {
        return {
          ok: false,
          message: `@${profile.username} — Instagram requires email verification before allowing login from this device. Check the account's email inbox.`,
          accountStatus: "email_confirmation",
        };
      }
      return { ok: false, message: `@${profile.username} — incorrect password.`, accountStatus: "logged_out" };
    }

    if (err instanceof IgLoginInvalidUserError) {
      return { ok: false, message: `@${profile.username} — account does not exist on Instagram.`, accountStatus: "banned" };
    }

    const msg: string = err?.message ?? "unknown error";
    if (/banned|disabled|suspended/i.test(msg)) {
      return { ok: false, message: `@${profile.username} — account banned or disabled.`, accountStatus: "banned" };
    }
    if (/checkpoint/i.test(msg)) {
      return { ok: false, message: `@${profile.username} — checkpoint required.`, accountStatus: "captcha" };
    }

    return { ok: false, message: `@${profile.username} — login failed: ${msg}`, accountStatus: "logged_out" };
  }
}
