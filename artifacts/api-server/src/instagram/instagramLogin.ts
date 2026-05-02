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
  ipAddress?: string,
) {
  try {
    await db.insert(instagramApiCalls).values({
      profileId,
      operationName,
      date: new Date().toISOString(),
      message,
      source,
      navChain: "",
      ipAddress: ipAddress ?? "",
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
    return u.pathname
      .replace(/^\/api\/v\d+\//, "")
      .replace(/\/$/, "") || u.pathname;
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
          response?.request?.options?.url ??
          "";
        const opName = extractOperationName(url);
        const phases = response?.timings?.phases ?? {};
        const durationMs: number =
          phases.total ?? phases.firstByte ?? (Date.now());
        const status: number = response?.statusCode ?? 0;
        const method: string = (response?.request?.options?.method ?? "POST").toUpperCase();
        const message = `HTTP ${status} @${ig.state.username ?? profileId}`;
        await logApiCall(profileId, opName, message, method, Math.round(durationMs));
      } catch { /* ignore */ }
    },
  });
}

export async function verifyInstagramCredentials(profile: Profile): Promise<VerifyResult> {
  const proxyUrl = buildProxyUrl(profile);

  console.error(`[instagramLogin] @${profile.username} proxy=${proxyUrl ?? "direct"}`);

  const ig = new IgApiClient();
  ig.state.generateDevice(profile.username);
  if (profile.userAgentApi) ig.state.deviceString = profile.userAgentApi;
  if (proxyUrl) ig.state.proxyUrl = proxyUrl;

  attachRequestLogger(ig, profile.id);

  // Pre-login flow: fetch_headers, qe/sync, launcher/sync, prefill_candidates
  try {
    await ig.simulate.preLoginFlow();
  } catch (e: any) {
    console.error(`[instagramLogin] preLoginFlow error (non-fatal): ${e?.message}`);
  }

  // Login
  try {
    await ig.account.login(profile.username, profile.password);
    ig.simulate.postLoginFlow().catch(() => {});
    return { ok: true, message: `@${profile.username} logged in successfully.`, accountStatus: "valid" };

  } catch (err: any) {

    if (err instanceof IgLoginTwoFactorRequiredError) {
      const twoFactorInfo = err.response.body.two_factor_info;
      const secret = profile.twoFASecretKey?.replace(/\s+/g, "") ?? "";
      if (!secret) {
        return {
          ok: false,
          message: `@${profile.username} — 2FA required but no secret key is set. Add your TOTP secret in Account Details.`,
          accountStatus: "2fa_verification",
        };
      }
      let code: string;
      try {
        code = totpGenerate({ secret });
      } catch {
        return {
          ok: false,
          message: `@${profile.username} — invalid 2FA secret key. Please re-enter it in Account Details.`,
          accountStatus: "2fa_verification",
        };
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
        return {
          ok: false,
          message: `@${profile.username} — 2FA code rejected: ${e2?.message ?? "unknown"}`,
          accountStatus: "2fa_verification",
        };
      }
    }

    if (err instanceof IgCheckpointError) {
      return {
        ok: false,
        message: `@${profile.username} — security checkpoint triggered. Open the browser and verify your account.`,
        accountStatus: "captcha",
      };
    }

    if (err instanceof IgLoginBadPasswordError) {
      return {
        ok: false,
        message: `@${profile.username} — incorrect password.`,
        accountStatus: "logged_out",
      };
    }

    if (err instanceof IgLoginInvalidUserError) {
      return {
        ok: false,
        message: `@${profile.username} — account does not exist on Instagram.`,
        accountStatus: "banned",
      };
    }

    const msg: string = err?.message ?? "unknown error";
    if (/banned|disabled|suspended/i.test(msg)) {
      return { ok: false, message: `@${profile.username} — account banned or disabled.`, accountStatus: "banned" };
    }
    if (/checkpoint/i.test(msg)) {
      return { ok: false, message: `@${profile.username} — checkpoint required.`, accountStatus: "captcha" };
    }

    return {
      ok: false,
      message: `@${profile.username} — login failed: ${msg}`,
      accountStatus: "logged_out",
    };
  }
}
