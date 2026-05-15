import type { Express } from "express";
import type { Server } from "http";
import crypto from "node:crypto";
import { crc32 as zlibCrc32 } from "node:zlib";
import { storage } from "../storage";
import { api } from "../shared/routes";
import { z } from "zod/v4";
import { verifyInstagramCredentials } from "../instagram/instagramLogin";
import { createInstagramAccountViaApi, submitSignupCode } from "../instagram/instagramWebClient";
import { fetchInstagramCodeFromImap } from "../instagram/imapHelper";
import { IgApiClient } from "instagram-private-api";
import {
  getOrCreateSession,
  attachSSE,
  detachSSE,
  browserNavigate,
  browserClick,
  browserMouseMove,
  browserScroll,
  browserKeyDown,
  browserKeyUp,
  browserType,
  browserKeyCombo,
  browserGetSelectedText,
  browserBack,
  browserForward,
  browserReload,
  browserSetFiles,
  browserNewTab,
  browserSwitchTab,
  browserCloseTab,
  clearSession,
  closeSession,
  wipeEbSession,
  browserAutoLogin,
  sendLoginDone,
  setCheckpointUrl,
  getSessionPageCookies,
  type ProxyConfig,
} from "../instagram/browserSession";
import { automationEngine } from "../instagram/automationEngine";
import { MOBILE_VERSION_CODE } from "../instagram/instagramWebClient";

// Fallback desktop Chrome UA — used only when a profile has no userAgentEmbedded stored.
// We always prefer the profile's own stored UA so Instagram sees a consistent fingerprint.
// Mobile UAs are NOT used here — they trigger the app-install interstitial instead of the full site.
const DESKTOP_BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Per-account verify lock — prevents concurrent logins for the same account.
// Multiple simultaneous IgApiClient instances logging in with the same device
// fingerprint look like a device leak to Instagram and cause blocks.
const verifyInFlight = new Set<number>();

// Persisted across restarts within the same calendar day so the dashboard
// always shows when the bot was FIRST started today, not the latest restart.
let SERVER_START = new Date().toISOString();

async function resolveProxyConfig(profile: {
  browserDirectConnection?: boolean | null;
  proxyId?: number | null;
  proxyHost?: string | null;
  proxyPort?: number | null;
  proxyUsername?: string | null;
  proxyPassword?: string | null;
}): Promise<ProxyConfig | undefined> {
  // Proxy assignment always wins — if an account has a proxy configured, use it.
  // browserDirectConnection is only respected when NO proxy is configured at all.
  if (profile.proxyId) {
    const proxies = await storage.getProxies();
    const linked = proxies.find(p => p.id === profile.proxyId);
    if (linked && linked.host && linked.port) {
      return {
        host: linked.host,
        port: linked.port,
        username: linked.username ?? undefined,
        password: linked.password ?? undefined,
      };
    }
  }

  if (profile.proxyHost && profile.proxyPort) {
    return {
      host: profile.proxyHost,
      port: profile.proxyPort,
      username: profile.proxyUsername ?? undefined,
      password: profile.proxyPassword ?? undefined,
    };
  }

  // No proxy configured on this account — direct connection.
  return undefined;
}

export async function registerInstagramRoutes(
  httpServer: Server,
  app: Express,
): Promise<void> {
  // Always record the exact moment this server process started.
  try {
    SERVER_START = new Date().toISOString();
    await storage.setGlobalSetting("server_start_time", SERVER_START);
  } catch {
    // If DB read fails, keep the in-memory start time
  }

  // Reset any accounts stuck in "verifying" from a previous crashed/restarted server.
  // A "verifying" status only makes sense while the server is actively running the
  // verify call — on startup there can be no such call in flight.
  storage.resetStuckVerifyingAccounts().catch(() => {});

  automationEngine.start();

  // Proxies
  app.get(api.proxies.list.path, async (_req, res) => {
    const data = await storage.getProxies();
    res.json(data);
  });

  app.post(api.proxies.create.path, async (req, res) => {
    try {
      const input = api.proxies.create.input.parse(req.body);
      const created = await storage.createProxy({
        ...input,
        name: `${input.host}:${input.port}`,
      });
      res.status(201).json(created);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: err.issues[0].message, field: (err.issues[0].path ?? []).join('.') });
      }
      throw err;
    }
  });

  app.patch(api.proxies.update.path, async (req, res) => {
    const id = Number(req.params.id);
    try {
      const input = api.proxies.update.input.parse(req.body);
      if (input.host || input.port) {
        input.name = `${input.host ?? ""}:${input.port ?? ""}`;
      }
      const updated = await storage.updateProxy(id, input);
      if (!updated) return res.status(404).json({ message: "Proxy not found" });
      res.json(updated);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: err.issues[0].message });
      }
      throw err;
    }
  });

  app.delete(api.proxies.delete.path, async (req, res) => {
    await storage.deleteProxy(Number(req.params.id));
    res.status(204).end();
  });

  app.post("/api/proxies/import", async (req, res) => {
    const input = z.object({
      proxies: z.array(z.object({
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535),
        username: z.string().nullable().optional(),
        password: z.string().nullable().optional(),
      })),
    }).parse(req.body);

    const existing = await storage.getProxies();
    const existingSet = new Set(existing.map(p => `${p.host}:${p.port}`));

    let imported = 0;
    let skipped = 0;

    for (const p of input.proxies) {
      const key = `${p.host}:${p.port}`;
      if (existingSet.has(key)) { skipped++; continue; }
      await storage.createProxy({
        name: key,
        host: p.host,
        port: p.port,
        username: p.username ?? null,
        password: p.password ?? null,
      });
      existingSet.add(key);
      imported++;
    }

    res.json({ imported, skipped });
  });

  app.post("/api/proxies/auto-link", async (req, res) => {
    const existingProxies = await storage.getProxies();
    const profiles = await storage.getProfiles();

    // Build lookup map — keyed by "host:port" → proxyId.
    // We update this as we create new entries so accounts sharing the same
    // proxy all get linked to the same Proxy Manager row.
    const proxyByHostPort = new Map(existingProxies.map(p => [`${p.host}:${p.port}`, p.id]));

    let linked = 0;
    let created = 0;
    let skipped = 0;

    for (const profile of profiles) {
      if (profile.proxyId) { skipped++; continue; }
      if (!profile.proxyHost || !profile.proxyPort) { skipped++; continue; }

      const key = `${profile.proxyHost}:${profile.proxyPort}`;
      let proxyId = proxyByHostPort.get(key);

      if (!proxyId) {
        // Proxy not yet in the Proxy Manager — create it from the inline profile data
        const newProxy = await storage.createProxy({
          name: key,
          host: profile.proxyHost,
          port: profile.proxyPort,
          username: profile.proxyUsername ?? null,
          password: profile.proxyPassword ?? null,
        });
        proxyByHostPort.set(key, newProxy.id);
        proxyId = newProxy.id;
        created++;
      }

      await storage.updateProfile(profile.id, { proxyId });
      linked++;
    }

    res.json({ linked, created, skipped });
  });

  app.post("/api/proxies/:id/ping", async (req, res) => {
    const proxy = (await storage.getProxies()).find(p => p.id === Number(req.params.id));
    if (!proxy) return res.status(404).json({ alive: false, error: "Proxy not found" });

    const http = await import("http");

    const auth = proxy.username && proxy.password
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}`
      : "";

    const start = Date.now();
    try {
      // Test via plain HTTP CONNECT to detect basic proxy reachability.
      // HTTPS (CONNECT tunnel) fails on many residential/datacenter proxies that
      // only forward HTTP traffic — using HTTP gives a reliable alive/dead signal.
      await new Promise<void>((resolve, reject) => {
        const options: import("http").RequestOptions = {
          host: proxy.host,
          port: proxy.port,
          path: "http://httpbin.org/ip",
          method: "GET",
          timeout: 10000,
          headers: {
            "Host": "httpbin.org",
            "User-Agent": "Mozilla/5.0",
            ...(auth ? { "Proxy-Authorization": "Basic " + Buffer.from(auth).toString("base64") } : {}),
          },
        };
        const req2 = http.request(options, (r) => { r.resume(); resolve(); });
        req2.on("error", reject);
        req2.on("timeout", () => { req2.destroy(); reject(new Error("timeout")); });
        req2.end();
      });
      res.json({ alive: true, latencyMs: Date.now() - start });
    } catch (err: any) {
      res.json({ alive: false, latencyMs: Date.now() - start, error: err.message ?? "unreachable" });
    }
  });

  // Profiles
  app.get(api.profiles.list.path, async (req, res) => {
    const all = await storage.getProfiles();
    const cm = req.query.creatorMode;
    if (cm === "1") return res.json(all.filter((p: any) => p.creatorMode));
    if (cm === "0") return res.json(all.filter((p: any) => !p.creatorMode));
    res.json(all);
  });

  app.post("/api/profiles/:id/move-to-accounts", async (req, res) => {
    const id = Number(req.params.id);
    const updated = await storage.updateProfile(id, { creatorMode: false });
    res.json(updated);
  });

  app.get(api.profiles.get.path, async (req, res) => {
    const profile = await storage.getProfile(Number(req.params.id));
    if (!profile) return res.status(404).json({ message: 'Not found' });
    res.json(profile);
  });

  app.post(api.profiles.create.path, async (req, res) => {
    try {
      const inputSchema = api.profiles.create.input.extend({
        proxyId: z.coerce.number().optional().nullable(),
      });
      const input = inputSchema.parse(req.body);
      const created = await storage.createProfile(input);
      res.status(201).json(created);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: err.issues[0].message, field: (err.issues[0].path ?? []).join('.') });
      }
      throw err;
    }
  });

  async function handleProfileUpdate(req: any, res: any) {
    try {
      const id = Number(req.params.id);
      const body = req.body;
      const current = await storage.getProfile(id);
      // The general PATCH route must NEVER set accountStatus to "valid" except
      // when restoring a previously-stopped account (toggle-on from Accounts page).
      // Only the explicit /verify route is authoritative for validating a session.
      if ("accountStatus" in body && body.accountStatus === "valid") {
        if (!current || current.accountStatus !== "stopped") {
          console.warn(`[status-guard] BLOCKED attempt to set profile ${id} → "valid" via PATCH route (current: ${current?.accountStatus})`);
          delete body.accountStatus;
        }
      }
      if ("username" in body || "password" in body) {
        const usernameChanged = current && "username" in body && body.username !== current.username;
        const passwordChanged = current && "password" in body && body.password !== current.password;
        if (usernameChanged || passwordChanged) {
          body.credentialsDirty = true;
          body.accountStatus = "pending";
        }
      }
      const updated = await storage.updateProfile(id, body);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: "Failed to update profile" });
    }
  }

  // Bulk-update: apply one patch to many profiles in a single request.
  // Must be registered BEFORE /api/profiles/:id so "bulk-update" isn't treated as an ID.
  app.post("/api/profiles/bulk-update", async (req, res) => {
    const { ids, patch } = req.body ?? {};
    if (!Array.isArray(ids) || !patch || typeof patch !== "object") {
      return res.status(400).json({ message: "ids (array) and patch (object) are required" });
    }
    await Promise.all((ids as number[]).map(id => storage.updateProfile(id, patch)));
    res.json({ ok: true, updated: ids.length });
  });

  app.patch("/api/profiles/:id", handleProfileUpdate);
  app.put("/api/profiles/:id", handleProfileUpdate);

  app.delete(api.profiles.delete.path, async (req, res) => {
    const profileId = Number(req.params.id);
    const profile = await storage.getProfile(profileId).catch(() => null);
    await storage.deleteProfile(profileId);
    closeSession(profileId).catch(() => {});
    if (profile) {
      storage.createSessionAction({
        profileId,
        toolId: 0,
        action: "account_deleted",
        targetUsername: profile.username ?? "",
        sourceValue: "",
        sourceType: "system",
        result: "ok",
        detail: `Account @${profile.username} deleted`,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    }
    res.status(204).end();
  });

  // ── Profile Sync — fetch latest follower/following/posts counts ───────────
  app.post("/api/profiles/:id/sync", async (req, res) => {
    const id = Number(req.params.id);
    const profile = await storage.getProfile(id);
    if (!profile) return res.status(404).json({ ok: false, message: "Profile not found" });
    try {
      const stats = await automationEngine.syncProfile(id);
      if (!stats) return res.status(502).json({ ok: false, message: "Could not retrieve profile stats" });
      const updated = await storage.getProfile(id);
      res.json({ ok: true, profile: updated });
    } catch (err: any) {
      res.status(500).json({ ok: false, message: err?.message ?? "Sync failed" });
    }
  });

  app.post("/api/profiles/:id/verify", async (req, res) => {
    const profileId = Number(req.params.id);

    // Reject concurrent verify calls for the same account — multiple simultaneous
    // IgApiClient instances logging in with the same device fingerprint look like
    // a device leak to Instagram and will trigger account blocks.
    if (verifyInFlight.has(profileId)) {
      return res.status(429).json({ ok: false, message: "Verification already in progress for this account. Please wait." });
    }
    verifyInFlight.add(profileId);

    // Helper: release lock + send error (avoids repeating delete on every early return)
    const fail = (status: number, message: string) => {
      verifyInFlight.delete(profileId);
      return res.status(status).json({ ok: false, message });
    };

    const profile = await storage.getProfile(profileId);
    if (!profile) return fail(404, "Profile not found");
    if (!profile.username || !profile.password) {
      return fail(400, "Username and password are required before verifying.");
    }

    // Mark as "verifying" in the DB immediately — this way the dashboard still
    // shows the correct in-progress state if the user navigates away before the
    // long-running verify call completes.
    await storage.updateProfile(profile.id, { accountStatus: "verifying" });

    let effectiveProfile = { ...profile };
    if (profile.proxyId) {
      const proxies = await storage.getProxies();
      const linked = proxies.find(p => p.id === profile.proxyId);
      if (linked) {
        effectiveProfile = {
          ...effectiveProfile,
          proxyHost: linked.host,
          proxyPort: linked.port,
          proxyUsername: linked.username ?? "",
          proxyPassword: linked.password ?? "",
        };
      }
    }

    // Block verify if no proxy is configured — never connect via bare server IP
    if (!effectiveProfile.proxyHost || !effectiveProfile.proxyPort) {
      return fail(400, "No proxy assigned. Assign a proxy to this account before verifying.");
    }


    // Log "Initiating" BEFORE the verify call so it gets a genuinely earlier
    // timestamp/ID than the result entry — dashboard is newest-first so
    // "Initiating" (older) must have a lower ID than "Verified" (newer).
    await storage.createInstagramApiCall({
      profileId: profile.id,
      username: profile.username,
      operationName: "VerifyAccount",
      date: new Date().toISOString(),
      message: `Initiating a verification via API`,
      source: "System",
      durationMs: 0,
    }).catch(() => {});

    // ── Jarvee-style EB-first verify ──────────────────────────────────────────
    // Step 1: Launch the embedded browser (headless) for this profile.
    // Step 2: Auto-login via Instagram web (handles 2FA, challenges, etc.)
    // Step 3: Extract sessionid/csrftoken/ds_user_id from the browser.
    // Step 4: Hand those cookies to the API client — account marked valid.
    // This is exactly how Jarvee authenticates: EB logs in first, then the API
    // uses the browser-generated session cookies for all follow/like/DM actions.

    const proxyConfig: ProxyConfig | undefined = effectiveProfile.proxyHost ? {
      host: effectiveProfile.proxyHost,
      port: effectiveProfile.proxyPort!,
      username: effectiveProfile.proxyUsername ?? undefined,
      password: effectiveProfile.proxyPassword ?? undefined,
    } : undefined;

    const ebUA = (effectiveProfile.userAgentEmbedded as string | null) || DESKTOP_BROWSER_UA;

    // Step 1: Get or create the browser session
    let result: { ok: boolean; message: string; accountStatus: string; igApiCookies?: string; checkpointUrl?: string };
    try {
      await getOrCreateSession(profileId, ebUA, proxyConfig);
    } catch (ebErr: any) {
      verifyInFlight.delete(profileId);
      await storage.updateProfile(profile.id, { accountStatus: "pending" });
      return fail(500, `Browser failed to launch: ${ebErr?.message ?? "Unknown error"}`);
    }

    // Step 2: Auto-login via browser (web login)
    let loginResult: { ok: boolean; message: string };
    try {
      loginResult = await browserAutoLogin(
        profileId,
        profile.username,
        profile.password!,
        profile.twoFASecretKey || "",
      );
    } catch (loginErr: any) {
      loginResult = { ok: false, message: loginErr?.message ?? "Browser login error" };
    } finally {
      verifyInFlight.delete(profileId);
    }

    // Step 3: Extract cookies and build result
    if (loginResult.ok) {
      const rawCookies = await getSessionPageCookies(profileId);
      const sessionid = rawCookies.find(c => c.name === "sessionid")?.value;
      const csrftoken = rawCookies.find(c => c.name === "csrftoken")?.value;
      const dsUserId  = rawCookies.find(c => c.name === "ds_user_id")?.value;
      const mid       = rawCookies.find(c => c.name === "mid")?.value;

      if (!sessionid) {
        result = {
          ok: false,
          accountStatus: "pending",
          message: `@${profile.username} — browser login appeared to succeed but no sessionid cookie was found. Try again.`,
        };
      } else {
        // Step 4: Build cookie string from EB session and persist it immediately
        const cookieParts = [`sessionid=${sessionid}`];
        if (csrftoken) cookieParts.push(`csrftoken=${csrftoken}`);
        if (dsUserId)  cookieParts.push(`ds_user_id=${dsUserId}`);
        if (mid)       cookieParts.push(`mid=${mid}`);
        const freshCookies = cookieParts.join("; ");

        // Persist the EB cookies before the API validation so they survive even if
        // the mobile API call temporarily fails (network hiccup, proxy lag, etc.)
        await storage.updateProfile(profile.id, { igApiCookies: freshCookies });

        // Step 5: Mobile API confirmation — the Jarvee step we were missing.
        // EB login proves the web session is alive.  This step confirms the same
        // cookies work at the mobile API layer before the account is marked valid.
        // verifyInstagramCredentials will take Path 2 (cookie restore) because
        // igApiCookies now has a sessionid — it runs the full cold-start sequence
        // (tokens/keyed → launcher/sync → users/{id}/info) and returns the
        // authoritative result.
        const profileWithCookies = { ...effectiveProfile, igApiCookies: freshCookies } as typeof effectiveProfile;
        const apiResult = await verifyInstagramCredentials(profileWithCookies);
        result = {
          ...apiResult,
          // Always carry the fresh EB cookies forward regardless of API result —
          // they're needed for the next attempt if the API call transiently failed.
          igApiCookies: freshCookies,
        };
      }
    } else {
      // Classify the failure
      const msg = loginResult.message ?? "";
      let accountStatus = "locked";
      if (/2fa|two.factor|two_factor/i.test(msg))   accountStatus = "2fa_verification";
      else if (/challenge|checkpoint/i.test(msg))    accountStatus = "captcha";
      else if (/disabled/i.test(msg))                accountStatus = "account_disabled";
      else if (/suspended/i.test(msg))               accountStatus = "suspended";
      result = { ok: false, accountStatus, message: `@${profile.username} — ${msg}` };
    }

    // Signal the browser panel SSE (if the user has it open) that login is done
    sendLoginDone(profileId, result.ok, result.message);

    await storage.updateProfile(profile.id, {
      accountStatus: result.accountStatus,
      ...(result.ok ? { credentialsDirty: false } : {}),
      ...(result.igDeviceState ? { igDeviceState: result.igDeviceState } : {}),
      // Save session cookies captured from the fresh login so follow/DM tools
      // can restore the session on Path 2 without re-logging in.
      ...("igApiCookies" in result && result.igApiCookies ? { igApiCookies: result.igApiCookies } : {}),
    });

    // Log verify result as a session action so the LiveActivityTicker can surface it
    await storage.createSessionAction({
      profileId: profile.id,
      toolId: 0,
      action: result.ok ? "verified" : "verification_failed",
      targetUsername: profile.username,
      sourceValue: "",
      sourceType: "verify",
      result: result.accountStatus ?? (result.ok ? "valid" : "failed"),
      detail: result.message ?? "",
      timestamp: new Date().toISOString(),
    });

    // Log failure in API call log too (success already surfaced via session action above)
    if (!result.ok) {
      storage.createInstagramApiCall({
        profileId: profile.id,
        username: profile.username,
        operationName: "VerifyAccount",
        date: new Date().toISOString(),
        message: `✗ Failed — ${result.accountStatus ?? "failed"}: ${result.message ?? ""}`,
        source: "System",
        durationMs: 0,
      }).catch(() => {});
    }

    // If Instagram returned a checkpoint URL, cache it so the EB navigates there directly
    // on next open (bypassing the 429 rate-limit on the home page)
    if (!result.ok && result.accountStatus === "captcha" && result.checkpointUrl) {
      setCheckpointUrl(profile.id, result.checkpointUrl);
    }

    res.json(result);
  });

  function resolveImportStatus(_raw: string | undefined): string {
    return "pending";
  }

  app.post("/api/profiles/import", async (req, res) => {
    try {
      const { profiles: toImport } = req.body;
      if (!Array.isArray(toImport) || toImport.length === 0) {
        return res.status(400).json({ message: "No profiles provided" });
      }
      const results: { success: boolean; username: string; action?: string; error?: string }[] = [];

      // ── Build a proxy lookup map (host:port → proxyId) so we can auto-link
      // accounts to their proxy without making a DB round-trip per account.
      // New proxies created during this import are immediately added to the map
      // so subsequent accounts sharing the same proxy reuse the same entry.
      const existingProxies = await storage.getProxies();
      const proxyMap = new Map<string, number>(
        existingProxies.map(px => [`${px.host}:${px.port}`, px.id])
      );

      for (const p of toImport) {
        try {
          // Build igDeviceState from device fingerprint fields in the export.
          // Priority: explicit Jarvee device columns > derived from API User Agent.
          // Deriving from the UA string uses the same Chance-seeded algorithm as
          // instagram-private-api's generateDevice(), so the same UA always yields
          // the same uuid/deviceId/phoneId/adid — giving Instagram a stable device to trust.
          let igDeviceState: string | null = null;
          const devId: string = p.deviceId || "";
          const devUuid: string = p.deviceUuid || "";
          const devPhoneId: string = p.phoneId || "";
          const devAdid: string = p.adid || "";
          const devString: string = p.userAgentApi || "";
          const hasExplicitDeviceIds = !!(devId || devUuid || devPhoneId || devAdid);

          if (hasExplicitDeviceIds) {
            // Jarvee exported explicit device IDs — use them exactly.
            // v: 2 marker is required so the DEVICE ISOLATION startup guard
            // does not wipe this state as "legacy / unversioned" on next boot.
            igDeviceState = JSON.stringify({
              v: 2,
              deviceId: devId || undefined,
              uuid: devUuid || undefined,
              phoneId: devPhoneId || undefined,
              adid: devAdid || undefined,
              deviceString: devString || undefined,
            });
          } else if (devString) {
            // No explicit IDs but we have an API User Agent — derive deterministic
            // device IDs from it so every login uses the same device fingerprint.
            const ig = new IgApiClient();
            ig.state.generateDevice(devString); // Chance(seed) → consistent IDs
            ig.state.deviceString = devString;  // keep the Jarvee UA, not a random pick

            // Jarvee's export format omits the version code from the "api user agent"
            // column (last segment is locale e.g. "en_US") but Jarvee appends it
            // internally when building the full UA.  Append the current version code
            // now so the saved igDeviceState already has a complete, standard UA
            // and won't need patching at verify/login time.
            {
              const segs = ig.state.deviceString.split(";");
              const last = segs[segs.length - 1].trim();
              if (!/^\d+$/.test(last)) {
                ig.state.deviceString = ig.state.deviceString.trimEnd() + `; ${MOBILE_VERSION_CODE}`;
              }
            }

            // v: 2 marker is required so the DEVICE ISOLATION startup guard
            // does not wipe this state as "legacy / unversioned" on next boot.
            igDeviceState = JSON.stringify({
              v: 2,
              deviceId: ig.state.deviceId,
              uuid: ig.state.uuid,
              phoneId: ig.state.phoneId,
              adid: ig.state.adid,
              deviceString: ig.state.deviceString,
            });
          }

          const igApiCookies: string | null = (p.apiCookies as string | undefined)?.trim() || null;

          // ── Auto-resolve proxyId from embedded proxy credentials ─────────────
          // If the imported row includes a proxy (host + port), ensure it exists
          // in the Proxy Manager and link the account to it via proxyId.
          // This means the EB, mobile API, and everything else all use the correct
          // proxy automatically — no manual linking required after import.
          let resolvedProxyId: number | null = null;
          const impHost: string = (p.proxyHost || "").trim();
          const impPort: number = p.proxyPort ? Number(p.proxyPort) : 0;
          if (impHost && impPort) {
            const mapKey = `${impHost}:${impPort}`;
            if (proxyMap.has(mapKey)) {
              resolvedProxyId = proxyMap.get(mapKey)!;
            } else {
              // Create a new Proxy Manager entry for this proxy
              const newProxy = await storage.createProxy({
                name: mapKey,
                host: impHost,
                port: impPort,
                username: (p.proxyUsername || null) as string | null,
                password: (p.proxyPassword || null) as string | null,
              });
              proxyMap.set(mapKey, newProxy.id);
              resolvedProxyId = newProxy.id;
            }
          }

          const profileData = {
            username: p.username || "",
            password: p.password || "",
            accountLabel: p.accountLabel || null,
            email: p.email || null,
            proxyId: resolvedProxyId,
            proxyHost: impHost || null,
            proxyPort: impPort || null,
            proxyUsername: (p.proxyUsername || null) as string | null,
            proxyPassword: (p.proxyPassword || null) as string | null,
            userAgentApi: p.userAgentApi || null,
            userAgentEmbedded: p.userAgentEmbedded || null,
            tags: p.tags || "",
            dateOfBirth: p.dateOfBirth || null,
            notes: p.notes || null,
            phoneNumber: p.phoneNumber || null,
            twoFASecretKey: p.twoFASecretKey || null,
            backupCodes: p.backupCodes || null,
            emailValidationUsername: p.emailValidationUsername || null,
            emailValidationPassword: p.emailValidationPassword || null,
            emailValidationPop3Server: p.emailValidationPop3Server || null,
            emailValidationPort: p.emailValidationPort || null,
            accountStatus: resolveImportStatus(p.accStatus),
            igDeviceState,
            igApiCookies,
          };

          // Upsert: if this username already exists, update it instead of creating a duplicate
          const existing = await storage.getProfileByUsername(profileData.username);
          if (existing) {
            const updates: Record<string, any> = { ...profileData };
            // Device state strategy for existing accounts:
            // - Explicit Jarvee device IDs → always update (user exported the real ones)
            // - Derived from UA → only replace if the account has no stored state yet
            //   (avoid triggering new-device challenges on accounts Instagram already trusts)
            if (!hasExplicitDeviceIds && existing.igDeviceState) {
              delete updates.igDeviceState; // keep the trusted stored state
            }
            // Preserve existing proxyId if the import doesn't specify a proxy
            if (!resolvedProxyId && existing.proxyId) {
              delete updates.proxyId;
            }
            await storage.updateProfile(existing.id, updates);
            results.push({ success: true, username: profileData.username, action: "updated" });
          } else {
            const created = await storage.createProfile(profileData);
            results.push({ success: true, username: created.username, action: "created" });
          }
        } catch (err: any) {
          results.push({ success: false, username: p.username || "?", error: err?.message || String(err) });
        }
      }
      res.json({ results });
    } catch (err) {
      res.status(500).json({ message: "Import failed" });
    }
  });

  app.post(api.profiles.start.path, async (req, res) => {
    await storage.updateProfileStatus(Number(req.params.id), 'running');
    res.json({ status: 'running' });
  });

  app.post(api.profiles.stop.path, async (req, res) => {
    await storage.updateProfileStatus(Number(req.params.id), 'idle');
    res.json({ status: 'idle' });
  });

  // Tools
  app.get(api.tools.listByProfile.path, async (req, res) => {
    const data = await storage.getToolsByProfile(Number(req.params.profileId));
    res.json(data);
  });

  app.put(api.tools.update.path, async (req, res) => {
    try {
      const input = api.tools.update.input.parse(req.body);
      // `cold` is a copy-settings flag — not part of the tool schema, parsed separately
      const cold = req.body.cold === true;
      const stagger = (input.settings as any)?.staggerOffsetMins;
      if (stagger != null && stagger > 0) {
        req.log.info(`[copySettings] tool ${req.params.id} — staggerOffsetMins=${stagger} saved to DB`);
      }
      const updated = await storage.updateTool(Number(req.params.id), input);
      if (input.enabled === true) {
        if (cold) {
          // Copy-settings path: stop the existing runner and relaunch with startup wait + stagger
          req.log.info(`[copySettings] tool ${req.params.id} (${updated.type}) cold restart — stagger will apply`);
          automationEngine.restartColdWithWait(updated.profileId, updated.type);
        } else {
          // Manual toggle path: wake existing runner immediately (or launch fresh)
          if (updated.type === "human_sessions") automationEngine.triggerHumanSession(updated.profileId);
          if (updated.type === "unfollow")       automationEngine.triggerUnfollow(updated.profileId);
          if (updated.type === "follow")         automationEngine.triggerFollow(updated.profileId);
          if (updated.type === "contact")        automationEngine.triggerReconcile();
        }
      }
      res.json(updated);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: err.issues[0].message, field: (err.issues[0].path ?? []).join('.') });
      }
      throw err;
    }
  });

  // Sources
  app.get(api.sources.listByTool.path, async (req, res) => {
    const data = await storage.getSourcesByTool(Number(req.params.toolId));
    res.json(data);
  });

  app.post(api.sources.create.path, async (req, res) => {
    try {
      const inputSchema = api.sources.create.input.extend({
        toolId: z.coerce.number().optional()
      });
      const input = inputSchema.parse(req.body);
      const created = await storage.createSource({ ...input, toolId: Number(req.params.toolId) });
      res.status(201).json(created);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: err.issues[0].message, field: (err.issues[0].path ?? []).join('.') });
      }
      throw err;
    }
  });

  app.post('/api/tools/:toolId/sources/import', async (req, res) => {
    try {
      const toolId = Number(req.params.toolId);
      const rows = z.array(z.object({
        type: z.string(),
        value: z.string(),
        rank: z.number().int().optional().nullable(),
        nrPosts: z.number().int().optional().nullable(),
      })).parse(req.body);
      const created = await storage.createSourcesBulk(
        rows.map(row => ({ ...row, toolId }))
      );
      res.status(201).json(created);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: err.issues[0].message });
      }
      throw err;
    }
  });

  app.delete(api.sources.delete.path, async (req, res) => {
    await storage.deleteSource(Number(req.params.id));
    res.status(204).end();
  });

  app.get("/api/profiles/:profileId/followed-users", async (req, res) => {
    const data = await storage.getFollowedUsersByProfile(Number(req.params.profileId));
    res.json(data);
  });

  app.post("/api/profiles/:profileId/followed-users", async (req, res) => {
    const profileId = Number(req.params.profileId);
    const { instagramUsername, sourceValue, sourceType } = req.body;
    if (!instagramUsername) return res.status(400).json({ message: "instagramUsername required" });
    const entry = await storage.createFollowedUser({
      profileId,
      instagramUsername,
      sourceValue: sourceValue ?? "",
      sourceType: sourceType ?? "",
      followedAt: new Date().toISOString(),
    });
    res.json(entry);
  });

  app.delete("/api/followed-users/:id", async (req, res) => {
    await storage.deleteFollowedUser(Number(req.params.id));
    res.json({ ok: true });
  });

  app.get("/api/profiles/:profileId/session-actions", async (req, res) => {
    const data = await storage.getSessionActionsByProfile(Number(req.params.profileId));
    res.json(data);
  });

  app.get("/api/server-info", (_req, res) => {
    res.json({ startedAt: SERVER_START });
  });

  app.get("/api/recent-activity", async (req, res) => {
    const actions = await storage.getRecentSessionActions(30);
    res.json(actions);
  });

  app.get("/api/all-session-actions", async (req, res) => {
    const limit = Math.min(parseInt((req.query.limit as string) ?? "200", 10), 1000);
    const profileIdParam = req.query.profileId;
    const allProfiles = await storage.getProfiles();
    const profileMap = new Map(allProfiles.map(p => [p.id, p]));
    let actions: any[];
    if (profileIdParam !== undefined) {
      const pid = parseInt(profileIdParam as string, 10);
      actions = isNaN(pid) ? [] : await storage.getSessionActionsByProfile(pid, limit);
    } else {
      actions = await storage.getRecentSessionActions(limit);
    }
    const enriched = actions.map(a => {
      const p = profileMap.get(Number(a.profileId));
      return { ...a, profileLabel: p?.accountLabel || p?.username || `#${a.profileId}` };
    });
    res.json(enriched);
  });

  app.get("/api/instagram-api-calls", async (req, res) => {
    const sinceParam = req.query.since;
    const [settings, allProfiles] = await Promise.all([
      storage.getGlobalSettings(),
      storage.getProfiles(),
    ]);
    const profileMap = new Map(allProfiles.map(p => [p.id, p]));
    const logMaxRows = parseInt(settings.logMaxRows ?? "100000", 10);
    let data: any[];
    if (sinceParam !== undefined) {
      const sinceId = parseInt(sinceParam as string, 10);
      data = isNaN(sinceId) ? [] : await storage.getInstagramApiCallsSince(sinceId, 5000);
    } else {
      data = await storage.getInstagramApiCalls(logMaxRows);
    }
    const enriched = data.map(call => {
      const storedUsername = call.username && call.username !== "" ? call.username : null;
      if (storedUsername) return call;
      const profile = profileMap.get(Number(call.profileId));
      const resolvedUsername = profile?.accountLabel || profile?.username || null;
      return { ...call, username: resolvedUsername };
    });
    res.json(enriched);
  });

  app.get("/api/logs/export", async (req, res) => {
    try {
      const [allProfiles, allProxies] = await Promise.all([
        storage.getProfiles(),
        storage.getProxies(),
      ]);
      const profileMap = new Map(allProfiles.map(p => [p.id, p]));
      const proxyMap = new Map(allProxies.map(p => [p.id, p]));
      const allApiCalls = await storage.getInstagramApiCalls(100000);

      // Filter to only the requested profile IDs when provided (comma-separated)
      const rawIds = (req.query as any).profileIds ?? "";
      const requestedIds = rawIds
        ? String(rawIds).split(",").map((s: string) => parseInt(s.trim(), 10)).filter((n: number) => !isNaN(n))
        : [];

      // Operations that structurally return 4xx/5xx but are completely non-fatal
      // (endpoint unavailable for account type, expected during login handshake, etc).
      // Their error messages are replaced with "OK" so the export isn't flooded with
      // alarming-looking errors that have zero operational significance.
      const NOISY_FAILED_OPS = new Set([
        "GetTokenResult",          // tokens/keyed — 404 on almost every account
        "GetKeyedTokens",          // alternate name for same endpoint
        "GetAccountFamily",        // get_account_family — 404 for many account types
        "SuggestedSearches",       // fbsearch/suggested_searches — 404 after IG change
        "LogAttribution",          // loginattribution/log_attribution — 400 not eligible
        "LogResurrectAttribution", // log_resurrect_attribution — 400 not eligible
        "FetchHeaders",            // si/fetch_headers — non-critical probe
        "ContactPointPrefill",     // contact_point_prefill — 400 non-fatal
        "GetPrefillCandidates",    // get_prefill_candidates — non-fatal
        "GetPresence",             // presence — 404 for many accounts
        "Banyan",                  // banyan/banyan — 400 expected during cold-start
        "GetBanyan",               // alternate logged name for banyan/banyan
        "ExecuteBanyan",           // another alternate name
        "SendMobileConfig",        // launcher/sync — may 400 on first attempt
      ]);

      const apiCalls = allApiCalls
        .filter((c: any) => {
          if (c.source === "Browser") return false;
          if (requestedIds.length > 0 && !requestedIds.includes(c.profileId)) return false;
          return true;
        })
        .map((c: any) => {
          // Replace known non-fatal error messages with "OK"
          if (NOISY_FAILED_OPS.has(c.operationName) && c.message !== "OK") {
            return { ...c, message: "OK" };
          }
          return c;
        });

      const headers = [
        "UniqueNameAccount", "Date", "Name", "Operation Name",
        "Message", "Source", "NavChain", "IpAddress", "Duration(miliseconds)"
      ];

      const esc = (v: string) => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

      const settings = await storage.getGlobalSettings();
      const useLocal = settings.useLocalTime === "true";
      // ?tz= is JS getTimezoneOffset() — minutes WEST of UTC (negative for UTC+)
      const browserTzMins = useLocal ? parseInt((req.query as any).tz ?? "0", 10) : 0;
      const offsetMins = -browserTzMins; // convert to minutes EAST (positive = UTC+)

      const csvRows = apiCalls.map((call: any) => {
        const profile = profileMap.get(call.profileId);
        const username = profile?.username ?? String(call.profileId);

        const utcMs = new Date(call.date).getTime();
        const localMs = utcMs + offsetMins * 60 * 1000;
        const localDate = new Date(localMs);
        // Date without timezone suffix — just the local time the user requested
        const date = localDate.toLocaleString("en-US", {
          month: "numeric", day: "numeric", year: "numeric",
          hour: "numeric", minute: "numeric", second: "numeric", hour12: true,
          timeZone: "UTC",
        });

        // Build IP:Port from the api call's recorded IP (or proxy host fallback) + proxy port.
        // Most rows have ipAddress="" because the automation engine doesn't resolve the
        // outbound IP at call time — fall back to the profile's proxy host so the column
        // is never blank for proxied accounts.
        let ip = call.ipAddress ?? "";
        let port = "";
        if (profile) {
          if (profile.proxyId) {
            const linked = proxyMap.get(profile.proxyId);
            if (!ip) ip = linked?.host ?? "";
            port = linked?.port ? String(linked.port) : "";
          } else {
            if (!ip) ip = (profile.proxyHost as string | null) ?? "";
            if (profile.proxyPort) port = String(profile.proxyPort);
          }
        }
        const ipPort = ip && port ? `${ip}:${port}` : ip;

        return [
          `Instagram_${call.profileId}`,
          date,
          username,
          call.operationName,
          call.message ?? "",
          call.source ?? "",
          call.navChain ?? "",
          ipPort,
          String(call.durationMs ?? ""),
        ].map(esc).join(",");
      });

      const content = [headers.map(esc).join(","), ...csvRows].join("\r\n");
      const file = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, "utf8")]);

      const filename = `api_calls_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.send(file);
    } catch (err) {
      res.status(500).json({ message: "Export failed" });
    }
  });

  app.get("/api/profiles/:id/stats", async (req, res) => {
    const data = await storage.getStatsByProfile(Number(req.params.id));
    res.json(data);
  });

  // Browser session endpoints
  app.post("/api/browser/:profileId/start", async (req, res) => {
    const profileId = Number(req.params.profileId);
    const profile = await storage.getProfile(profileId);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    // Block EB access when no proxy is assigned — accounts must have a proxy.
    const hasProxy = !!(profile.proxyId || (profile.proxyHost && profile.proxyPort));
    if (!hasProxy) return res.status(403).json({ error: "No proxy assigned — assign a proxy to this account before using the embedded browser." });
    const ua = (profile.userAgentEmbedded as string | null) || DESKTOP_BROWSER_UA;
    try {
      await getOrCreateSession(profileId, ua, await resolveProxyConfig(profile));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to start browser" });
    }
  });

  app.post("/api/browser/:profileId/login", async (req, res) => {
    const profileId = Number(req.params.profileId);
    const profile = await storage.getProfile(profileId);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    if (!profile.username || !profile.password) {
      return res.status(400).json({ error: "Profile has no credentials" });
    }

    res.json({ ok: true, message: "Login started" });

    browserAutoLogin(
      profileId,
      profile.username,
      profile.password,
      profile.twoFASecretKey || "",
    )
      .then(async result => {
        sendLoginDone(profileId, result.ok, result.message);
        // This standalone browser-login route is for MANUAL browser use.
        // Account status is set by the /verify route (EB-first flow) which
        // also extracts and hands cookies to the API after login succeeds.
      })
      .catch(err  => sendLoginDone(profileId, false, String(err)));
  });

  // Close Chrome without wiping cookies — called when user dismisses the browser window
  app.post("/api/browser/:profileId/close", async (req, res) => {
    await closeSession(Number(req.params.profileId));
    res.json({ ok: true });
  });

  // Wipe EB session entirely (no reopen) — called by Reset Device IDs so the
  // browser starts fresh with no stored cookies on next open.
  app.post("/api/browser/:profileId/wipe", async (req, res) => {
    await wipeEbSession(Number(req.params.profileId));
    res.json({ ok: true });
  });

  // Clear session: wipe cookies + close + reopen (the "Clear" button inside the browser panel)
  app.delete("/api/browser/:profileId/session", async (req, res) => {
    const profileId = Number(req.params.profileId);
    const profile = await storage.getProfile(profileId);
    const proxy = profile ? await resolveProxyConfig(profile) : undefined;
    const ua = profile ? ((profile.userAgentEmbedded as string | null) || DESKTOP_BROWSER_UA) : DESKTOP_BROWSER_UA;
    await clearSession(profileId, ua, proxy);
    res.json({ ok: true });
  });

  // ── EB diagnostic endpoint — hit this from the app to get a full debug report ──
  // Returns JSON: CHROMIUM_PATH, whether it exists, Node.js version, platform, etc.
  app.get("/api/browser/debug", async (_req, res) => {
    const fs = await import("fs");
    const chromiumPath = process.env.CHROMIUM_PATH || "";
    let chromiumExists = false;
    try { chromiumExists = chromiumPath ? fs.existsSync(chromiumPath) : false; } catch {}

    let puppeteerCoreAvailable = false;
    let puppeteerCoreError = "";
    try { await import("puppeteer-core"); puppeteerCoreAvailable = true; } catch (e: any) { puppeteerCoreError = e?.message ?? String(e); }

    let puppeteerAvailable = false;
    let puppeteerError = "";
    try { await import("puppeteer"); puppeteerAvailable = true; } catch (e: any) { puppeteerError = e?.message ?? String(e); }

    const info = {
      platform: process.platform,
      nodeVersion: process.version,
      CHROMIUM_PATH: chromiumPath || "(not set)",
      CHROMIUM_PATH_EXISTS: chromiumExists,
      NODE_PATH: process.env.NODE_PATH || "(not set)",
      puppeteerCore: puppeteerCoreAvailable ? "available ✓" : `MISSING — ${puppeteerCoreError}`,
      puppeteer: puppeteerAvailable ? "available ✓" : `missing — ${puppeteerError}`,
      tmpdir: (await import("os")).tmpdir(),
      cwd: process.cwd(),
    };
    console.log("[EB-DEBUG][/api/browser/debug]", JSON.stringify(info, null, 2));
    res.json(info);
  });

  // SSE stream for real-time browser frames (proxy-friendly, no upgrade required)
  app.get("/api/browser/:profileId/stream", async (req, res) => {
    const profileId = Number(req.params.profileId);
    const profile = await storage.getProfile(profileId);
    if (!profile) { res.status(404).end(); return; }
    // Block EB stream when no proxy is assigned.
    const hasProxy = !!(profile.proxyId || (profile.proxyHost && profile.proxyPort));
    if (!hasProxy) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.flushHeaders();
      res.write(`data: ${JSON.stringify({ type: "error", message: "No proxy assigned — assign a proxy to this account before using the embedded browser." })}\n\n`);
      res.end();
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx/proxy response buffering
    res.flushHeaders();

    // Send SSE keepalive comments every 20 s while the browser is starting up.
    // Prevents proxy/connection timeouts during Chrome launch.
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    }, 20_000);

    try {
      const proxy = await resolveProxyConfig(profile);
      const ua = (profile.userAgentEmbedded as string | null) || DESKTOP_BROWSER_UA;
      await getOrCreateSession(profileId, ua, proxy);
      clearInterval(keepalive);
      attachSSE(profileId, res);
    } catch (err: any) {
      clearInterval(keepalive);
      res.write(`data: ${JSON.stringify({ type: "error", message: err?.message || "Failed to start browser" })}\n\n`);
      res.end();
      return;
    }

    req.on("close", () => {
      detachSSE(profileId, res);
    });
  });

  // Get the currently-selected text in the remote browser page.
  // Used by the EB panel to write the selection to the Windows clipboard after
  // sending a Ctrl+C / Ctrl+X keycombo to the remote browser.
  app.get("/api/browser/:profileId/selection", async (req, res) => {
    const profileId = Number(req.params.profileId);
    try {
      const text = await browserGetSelectedText(profileId);
      res.json({ text });
    } catch (err: any) {
      res.json({ text: "" });
    }
  });

  // HTTP POST for browser input events (replaces WS send)
  app.post("/api/browser/:profileId/input", async (req, res) => {
    const profileId = Number(req.params.profileId);
    try {
      const msg = req.body as any;
      switch (msg.type) {
        case "navigate":   await browserNavigate(profileId, msg.url); break;
        case "click":      await browserClick(profileId, msg.x, msg.y); break;
        case "mousemove":  await browserMouseMove(profileId, msg.x, msg.y); break;
        case "scroll":     await browserScroll(profileId, msg.x, msg.y, msg.deltaX, msg.deltaY); break;
        case "keydown":    await browserKeyDown(profileId, msg.key); break;
        case "keyup":      await browserKeyUp(profileId, msg.key); break;
        case "type":       await browserType(profileId, msg.text); break;
        case "keycombo":   await browserKeyCombo(profileId, msg.modifier, msg.key); break;
        case "back":       await browserBack(profileId); break;
        case "forward":    await browserForward(profileId); break;
        case "reload":     await browserReload(profileId); break;
        case "newTab":     await browserNewTab(profileId); break;
        case "switchTab":  await browserSwitchTab(profileId, msg.index); break;
        case "closeTab":   await browserCloseTab(profileId, msg.index); break;
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // Accept a user-picked file and upload it to the pending Puppeteer file chooser
  app.post("/api/browser/:profileId/files", async (req, res) => {
    const profileId = Number(req.params.profileId);
    const { fileName, data } = req.body as { fileName: string; data: string };
    if (!fileName || !data) return res.status(400).json({ error: "fileName and data required" });
    try {
      await browserSetFiles(profileId, fileName, data);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── Run repost now (manual, bypasses skip-chance and session timer) ──────
  app.post("/api/profiles/:id/run-repost-now", async (req, res) => {
    const profileId = Number(req.params.id);
    const result = await automationEngine.runRepostNow(profileId);
    res.json(result);
  });

  // ── Reposted Posts ────────────────────────────────────────────────────────
  app.get("/api/profiles/:id/reposted-posts", async (req, res) => {
    const profileId = Number(req.params.id);
    const posts = await storage.getRepostedPostsByProfile(profileId);
    res.json(posts);
  });

  app.post("/api/profiles/:id/reposted-posts", async (req, res) => {
    const profileId = Number(req.params.id);
    const profile = await storage.getProfile(profileId);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    const { toolId, sourceUsername, mediaId, shortcode, caption, thumbnailUrl } = req.body as {
      toolId: number; sourceUsername: string; mediaId: string;
      shortcode?: string; caption?: string; thumbnailUrl?: string;
    };
    if (!toolId || !sourceUsername || !mediaId) {
      return res.status(400).json({ error: "toolId, sourceUsername and mediaId are required" });
    }
    const alreadyDone = await storage.isAlreadyReposted(profileId, mediaId);
    if (alreadyDone) return res.status(409).json({ error: "Already reposted" });
    const entry = await storage.createRepostedPost({
      profileId, toolId, sourceUsername, mediaId,
      shortcode: shortcode ?? "",
      caption: caption ?? "",
      thumbnailUrl: thumbnailUrl ?? "",
      repostedAt: new Date().toISOString(),
    });
    res.status(201).json(entry);
  });

  app.delete("/api/reposted-posts/:id", async (req, res) => {
    const id = Number(req.params.id);
    await storage.deleteRepostedPost(id);
    res.json({ ok: true });
  });

  // ── Contact DM Sent (new-follower DM tracker) ─────────────────────────────
  app.get("/api/profiles/:profileId/contact-dm-sent", async (req, res) => {
    const profileId = Number(req.params.profileId);
    const list = await storage.getContactDmSentByProfile(profileId);
    res.json(list);
  });

  app.delete("/api/contact-dm-sent/:id", async (req, res) => {
    const id = Number(req.params.id);
    await storage.deleteContactDmSent(id);
    res.json({ ok: true });
  });

  // ── Contact Pending Messages ──────────────────────────────────────────────
  app.get("/api/profiles/:profileId/contact-pending-messages", async (req, res) => {
    const profileId = Number(req.params.profileId);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const list = await storage.getContactPendingMessages(profileId, status);
    res.json(list);
  });

  app.delete("/api/contact-pending-messages/:id", async (req, res) => {
    const id = Number(req.params.id);
    await storage.deleteContactPendingMessage(id);
    res.json({ ok: true });
  });

  app.post("/api/profiles/:profileId/contact-pending-messages/clear", async (req, res) => {
    const profileId = Number(req.params.profileId);
    await storage.clearContactPendingMessages(profileId);
    res.json({ ok: true });
  });

  app.post("/api/contact-pending-messages/clear-all", async (req, res) => {
    await storage.clearContactPendingMessages(null);
    res.json({ ok: true });
  });

  // Get cookie baker activity log for a profile
  app.get("/api/profiles/:id/cookie-baker/activity", async (req, res) => {
    const id = Number(req.params.id);
    res.json(await automationEngine.getCookieBakerActivity(id));
  });

  // Trigger an immediate cookie baker session
  app.post("/api/profiles/:id/cookie-baker/run-now", async (req, res) => {
    const id = Number(req.params.id);
    automationEngine.triggerCookieBakerNow(id);
    res.json({ ok: true });
  });

  // Force an immediate follow session (bypasses the inter-session wait timer)
  app.post("/api/profiles/:profileId/tools/follow/run-now", async (req, res) => {
    const profileId = Number(req.params.profileId);
    automationEngine.forceFollowNow(profileId);
    res.json({ ok: true });
  });

  // Force an immediate contact-users send session (bypasses wait timer)
  app.post("/api/profiles/:profileId/tools/contact/send-now", async (req, res) => {
    const profileId = Number(req.params.profileId);
    automationEngine.triggerContactSend(profileId);
    res.json({ ok: true });
  });

  // Force an immediate follower extraction into the pending messages queue
  app.post("/api/profiles/:profileId/tools/contact/extract-now", async (req, res) => {
    const profileId = Number(req.params.profileId);
    const count = typeof req.body?.count === "number" && req.body.count > 0 ? req.body.count : undefined;
    const result = await automationEngine.triggerExtractNow(profileId, count);
    if (result.error) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, queued: result.queued });
  });

  // ── Bulk Verify All Accounts ──────────────────────────────────────────────
  app.post("/api/profiles/verify-all", async (req, res) => {
    const { profileIds } = req.body as { profileIds?: number[] };

    const allProfiles = await storage.getProfiles();
    const targets = profileIds && profileIds.length > 0
      ? allProfiles.filter(p => profileIds.includes(p.id))
      : allProfiles;

    if (!targets.length) return res.json({ ok: true, verified: 0, total: 0 });

    // Read delay from global settings (set on the Settings page)
    const globalSettings = await storage.getGlobalSettings();
    const delayMin = parseInt(globalSettings.verifyAllDelayMin ?? "5", 10);
    const delayMax = parseInt(globalSettings.verifyAllDelayMax ?? "15", 10);

    // Block any target without a proxy — never connect via bare server IP
    const allProxies = await storage.getProxies();
    const eligible = targets.filter(p => {
      if (p.proxyId) {
        const linked = allProxies.find(px => px.id === p.proxyId);
        return !!(linked?.host && linked?.port);
      }
      return !!(p.proxyHost && p.proxyPort);
    });
    const skippedNoProxy = targets.length - eligible.length;
    if (!eligible.length) {
      return res.json({ ok: false, error: "No accounts have a proxy assigned. Assign proxies before verifying." });
    }

    // Run verification in background so the response is immediate
    res.json({ ok: true, total: eligible.length, skippedNoProxy });

    (async () => {
      for (let i = 0; i < eligible.length; i++) {
        const profile = eligible[i];

        // Skip accounts already being verified by a concurrent single-verify call
        if (verifyInFlight.has(profile.id)) continue;
        verifyInFlight.add(profile.id);

        try {
          await storage.updateProfile(profile.id, { accountStatus: "verifying" });

          // ── EB-first verify (matches Jarvee: web login → grab cookies → hand to API) ──
          let effectiveP = { ...profile };
          if (profile.proxyId) {
            const linked = allProxies.find(px => px.id === profile.proxyId);
            if (linked) {
              effectiveP = {
                ...effectiveP,
                proxyHost: linked.host,
                proxyPort: linked.port,
                proxyUsername: linked.username ?? "",
                proxyPassword: linked.password ?? "",
              };
            }
          }
          const bulkProxyConfig: ProxyConfig | undefined = effectiveP.proxyHost ? {
            host: effectiveP.proxyHost,
            port: effectiveP.proxyPort!,
            username: effectiveP.proxyUsername ?? undefined,
            password: effectiveP.proxyPassword ?? undefined,
          } : undefined;
          const bulkEbUA = (effectiveP.userAgentEmbedded as string | null) || DESKTOP_BROWSER_UA;

          // Step 1: Launch EB
          await getOrCreateSession(profile.id, bulkEbUA, bulkProxyConfig);

          // Step 2: Web login
          let bulkLoginResult: { ok: boolean; message: string };
          try {
            bulkLoginResult = await browserAutoLogin(
              profile.id,
              profile.username,
              profile.password!,
              profile.twoFASecretKey || "",
            );
          } catch (loginErr: any) {
            bulkLoginResult = { ok: false, message: loginErr?.message ?? "Browser login error" };
          }

          // Step 3: Extract cookies and build result
          let result: { ok: boolean; message: string; accountStatus: string; igApiCookies?: string; checkpointUrl?: string };
          if (bulkLoginResult.ok) {
            const rawCookies = await getSessionPageCookies(profile.id);
            const sessionid = rawCookies.find(c => c.name === "sessionid")?.value;
            const csrftoken = rawCookies.find(c => c.name === "csrftoken")?.value;
            const dsUserId  = rawCookies.find(c => c.name === "ds_user_id")?.value;
            const mid       = rawCookies.find(c => c.name === "mid")?.value;
            if (!sessionid) {
              result = {
                ok: false,
                accountStatus: "pending",
                message: `@${profile.username} — browser login appeared to succeed but no sessionid cookie was found.`,
              };
            } else {
              const cookieParts = [`sessionid=${sessionid}`];
              if (csrftoken) cookieParts.push(`csrftoken=${csrftoken}`);
              if (dsUserId)  cookieParts.push(`ds_user_id=${dsUserId}`);
              if (mid)       cookieParts.push(`mid=${mid}`);
              const freshCookies = cookieParts.join("; ");
              await storage.updateProfile(profile.id, { igApiCookies: freshCookies });
              const profileWithCookies = { ...effectiveP, igApiCookies: freshCookies } as typeof effectiveP;
              const apiResult = await verifyInstagramCredentials(profileWithCookies);
              result = { ...apiResult, igApiCookies: freshCookies };
            }
          } else {
            const msg = bulkLoginResult.message ?? "";
            let accountStatus = "locked";
            if (/2fa|two.factor|two_factor/i.test(msg))   accountStatus = "2fa_verification";
            else if (/challenge|checkpoint/i.test(msg))    accountStatus = "captcha";
            else if (/disabled/i.test(msg))                accountStatus = "account_disabled";
            else if (/suspended/i.test(msg))               accountStatus = "suspended";
            result = { ok: false, accountStatus, message: `@${profile.username} — ${msg}` };
          }

          await storage.updateProfile(profile.id, {
            accountStatus: result.accountStatus,
            ...(result.ok ? { credentialsDirty: false } : {}),
            ...(result.igApiCookies ? { igApiCookies: result.igApiCookies } : {}),
          });
          if (!result.ok && result.accountStatus === "captcha" && result.checkpointUrl) {
            setCheckpointUrl(profile.id, result.checkpointUrl);
          }
          await storage.createSessionAction({
            profileId: profile.id,
            toolId: 0,
            action: result.ok ? "verified" : "verification_failed",
            targetUsername: profile.username,
            sourceValue: "",
            sourceType: "verify",
            result: result.accountStatus ?? (result.ok ? "valid" : "failed"),
            detail: result.message ?? "",
            timestamp: new Date().toISOString(),
          });
        } catch {
          // Unexpected error — reset to pending so the account isn't stuck in "verifying"
          await storage.updateProfile(profile.id, { accountStatus: "pending" });
        } finally {
          verifyInFlight.delete(profile.id);
        }
        if (i < targets.length - 1) {
          const ms = (Math.random() * (delayMax - delayMin) + delayMin) * 1000;
          await new Promise(r => setTimeout(r, ms));
        }
      }
    })().catch(() => {});
  });

  // ── Fix Captcha via 2captcha ──────────────────────────────────────────────
  app.post("/api/profiles/:id/fix-captcha", async (req, res) => {
    const profileId = Number(req.params.id);
    const profile = await storage.getProfile(profileId);
    if (!profile) return res.status(404).json({ ok: false, error: "Profile not found" });

    const globalSettings = await storage.getGlobalSettings();
    const twoCaptchaKey = globalSettings.twoCaptchaApiKey ?? "";
    if (!twoCaptchaKey) {
      return res.status(400).json({ ok: false, error: "No 2captcha API key configured in Settings" });
    }

    try {
      // Attempt browser-based login with the 2captcha key passed as the 2FA placeholder
      // so the embedded browser can use it for challenge solving
      const result = await browserAutoLogin(
        profileId,
        profile.username ?? "",
        profile.password ?? "",
        profile.twoFASecretKey ?? twoCaptchaKey,
      );
      if (result.ok) {
        // EB captcha resolution does NOT change account status — only the mobile
        // API login (Verify Credentials) determines if an account is valid.
        return res.json({ ok: true, message: result.message ?? "Captcha resolved successfully" });
      } else {
        return res.json({ ok: false, error: result.message ?? "Captcha resolution failed" });
      }
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? "Fix captcha failed" });
    }
  });

  // ── Fetch Followings via HikerAPI (for Unfollow target list) ─────────────
  app.post("/api/profiles/:id/fetch-followings", async (req, res) => {
    const profileId = Number(req.params.id);
    const profile = await storage.getProfile(profileId);
    if (!profile) return res.status(404).json({ ok: false, error: "Profile not found" });

    const { fetchMin = 50, fetchMax = 200 } = req.body as { fetchMin?: number; fetchMax?: number };
    const amount = Math.round(Math.random() * (fetchMax - fetchMin) + fetchMin);

    const globalSettings = await storage.getGlobalSettings();
    if (globalSettings.hikerApiEnabled !== "true" || !globalSettings.hikerApiToken) {
      return res.status(400).json({ ok: false, error: "HikerAPI not enabled or no token set in Settings" });
    }

    try {
      const { HikerApiClient } = await import("../instagram/hikerApiClient");
      const hikerClient = new HikerApiClient(globalSettings.hikerApiToken!);

      // Resolve this profile's own Instagram user ID via HikerAPI — no session cookies needed
      const username = (profile.username ?? "").replace(/^@/, "");
      if (!username) return res.status(400).json({ ok: false, error: "Profile has no username set." });

      const user = await hikerClient.getUserByUsername(username);
      if (!user?.pk) return res.status(400).json({ ok: false, error: `HikerAPI could not resolve @${username} — check your HikerAPI token.` });

      const followings = await hikerClient.getFollowings(user.pk, amount);
      const entries = followings.map(u => ({ username: u.username, pk: u.pk }));
      const usernames = entries.map(e => e.username);
      return res.json({ ok: true, entries, usernames, count: entries.length });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? "Fetch followings failed" });
    }
  });

  // ── Global Settings ───────────────────────────────────────────────────────
  app.get("/api/settings", async (_req, res) => {
    const settings = await storage.getGlobalSettings();
    res.json({
      skipFollowedUsers: settings.skipFollowedUsers === "true",
      skipAlreadySkippedUsers: settings.skipAlreadySkippedUsers === "true",
      hikerApiEnabled: settings.hikerApiEnabled === "true",
      hikerApiToken: settings.hikerApiToken ?? "",
      skipScrapedUsers: settings.skipScrapedUsers === "true",
      scrapedUserIgnoreDays: parseInt(settings.scrapedUserIgnoreDays ?? "365", 10),
      scrapeAllIfSkipped: settings.scrapeAllIfSkipped === "true",
      useLocalTime: settings.useLocalTime === "true",
      twoCaptchaApiKey: settings.twoCaptchaApiKey ?? "",
      verifyAllDelayMin: parseInt(settings.verifyAllDelayMin ?? "5", 10),
      verifyAllDelayMax: parseInt(settings.verifyAllDelayMax ?? "15", 10),
      logMaxRows: parseInt(settings.logMaxRows ?? "100000", 10),
      backupEnabled: settings.backupEnabled === "true",
      backupIntervalDays: parseInt(settings.backupIntervalDays ?? "7", 10),
      themeColor: settings.themeColor ?? "blue",
      themeMode: settings.themeMode ?? "dark",
      preFilledPhoneNumber: settings.preFilledPhoneNumber ?? "",
    });
  });

  app.put("/api/settings", async (req, res) => {
    const { skipFollowedUsers, skipAlreadySkippedUsers, hikerApiEnabled, hikerApiToken, skipScrapedUsers, scrapedUserIgnoreDays, scrapeAllIfSkipped, useLocalTime, twoCaptchaApiKey, verifyAllDelayMin, verifyAllDelayMax, logMaxRows, backupEnabled, backupIntervalDays, themeColor, themeMode, preFilledPhoneNumber } = req.body;
    if (typeof skipFollowedUsers === "boolean") {
      await storage.setGlobalSetting("skipFollowedUsers", String(skipFollowedUsers));
    }
    if (typeof skipAlreadySkippedUsers === "boolean") {
      await storage.setGlobalSetting("skipAlreadySkippedUsers", String(skipAlreadySkippedUsers));
    }
    if (typeof hikerApiEnabled === "boolean") {
      await storage.setGlobalSetting("hikerApiEnabled", String(hikerApiEnabled));
    }
    if (typeof hikerApiToken === "string") {
      await storage.setGlobalSetting("hikerApiToken", hikerApiToken);
    }
    if (typeof skipScrapedUsers === "boolean") {
      await storage.setGlobalSetting("skipScrapedUsers", String(skipScrapedUsers));
    }
    if (typeof scrapeAllIfSkipped === "boolean") {
      await storage.setGlobalSetting("scrapeAllIfSkipped", String(scrapeAllIfSkipped));
    }
    if (typeof scrapedUserIgnoreDays === "number" && scrapedUserIgnoreDays > 0) {
      await storage.setGlobalSetting("scrapedUserIgnoreDays", String(Math.round(scrapedUserIgnoreDays)));
    }
    if (typeof useLocalTime === "boolean") {
      await storage.setGlobalSetting("useLocalTime", String(useLocalTime));
    }
    if (typeof twoCaptchaApiKey === "string") {
      await storage.setGlobalSetting("twoCaptchaApiKey", twoCaptchaApiKey);
    }
    if (typeof verifyAllDelayMin === "number" && verifyAllDelayMin >= 0) {
      await storage.setGlobalSetting("verifyAllDelayMin", String(Math.round(verifyAllDelayMin)));
    }
    if (typeof verifyAllDelayMax === "number" && verifyAllDelayMax >= 0) {
      await storage.setGlobalSetting("verifyAllDelayMax", String(Math.round(verifyAllDelayMax)));
    }
    if (typeof logMaxRows === "number" && logMaxRows > 0) {
      await storage.setGlobalSetting("logMaxRows", String(Math.round(logMaxRows)));
    }
    if (typeof backupEnabled === "boolean") {
      await storage.setGlobalSetting("backupEnabled", String(backupEnabled));
    }
    if (typeof backupIntervalDays === "number" && backupIntervalDays > 0) {
      await storage.setGlobalSetting("backupIntervalDays", String(Math.round(backupIntervalDays)));
    }
    if (typeof themeColor === "string" && themeColor.length > 0) {
      await storage.setGlobalSetting("themeColor", themeColor);
    }
    if (typeof themeMode === "string" && (themeMode === "light" || themeMode === "dark")) {
      await storage.setGlobalSetting("themeMode", themeMode);
    }
    if (typeof preFilledPhoneNumber === "string") {
      await storage.setGlobalSetting("preFilledPhoneNumber", preFilledPhoneNumber);
    }
    const settings = await storage.getGlobalSettings();
    res.json({
      skipFollowedUsers: settings.skipFollowedUsers === "true",
      skipAlreadySkippedUsers: settings.skipAlreadySkippedUsers === "true",
      hikerApiEnabled: settings.hikerApiEnabled === "true",
      hikerApiToken: settings.hikerApiToken ?? "",
      skipScrapedUsers: settings.skipScrapedUsers === "true",
      scrapedUserIgnoreDays: parseInt(settings.scrapedUserIgnoreDays ?? "365", 10),
      scrapeAllIfSkipped: settings.scrapeAllIfSkipped === "true",
      useLocalTime: settings.useLocalTime === "true",
      twoCaptchaApiKey: settings.twoCaptchaApiKey ?? "",
      verifyAllDelayMin: parseInt(settings.verifyAllDelayMin ?? "5", 10),
      verifyAllDelayMax: parseInt(settings.verifyAllDelayMax ?? "15", 10),
      logMaxRows: parseInt(settings.logMaxRows ?? "100000", 10),
      backupEnabled: settings.backupEnabled === "true",
      backupIntervalDays: parseInt(settings.backupIntervalDays ?? "7", 10),
      themeColor: settings.themeColor ?? "blue",
      themeMode: settings.themeMode ?? "dark",
      preFilledPhoneNumber: settings.preFilledPhoneNumber ?? "",
    });
  });

  app.get("/api/settings/test-2captcha", async (_req, res) => {
    const settings = await storage.getGlobalSettings();
    const key = settings.twoCaptchaApiKey ?? "";
    if (!key) return res.json({ ok: false, error: "No API key configured" });
    try {
      const r = await fetch(`https://2captcha.com/res.php?action=getbalance&key=${encodeURIComponent(key)}`);
      const text = (await r.text()).trim();
      const balance = parseFloat(text);
      if (!isNaN(balance)) {
        return res.json({ ok: true, balance });
      }
      return res.json({ ok: false, error: text });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? "Request failed" });
    }
  });

  app.post("/api/settings/test-hiker", async (req, res) => {
    const { token } = req.body as { token?: string };
    if (!token) return res.status(400).json({ ok: false, error: "No token provided" });
    try {
      const { HikerApiClient } = await import("../instagram/hikerApiClient");
      const client = new HikerApiClient(token);
      const ok = await client.testConnection();
      return res.json({ ok });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message });
    }
  });

  // Image alteration preview
  app.post("/api/image-alteration-preview", async (req, res) => {
    try {
      const { imageBase64, settings, level } = req.body as {
        imageBase64: string;
        settings: any;
        level?: string;
      };
      if (!imageBase64) return res.status(400).json({ error: "No image provided" });
      const { alterJpegBuffer } = await import("../instagram/imageAlteration");
      const raw = imageBase64.replace(/^data:image\/\w+;base64,/, "");
      const buf = Buffer.from(raw, "base64");
      const result = await alterJpegBuffer(buf, (level as any) ?? "medium", settings);
      return res.json({ previewBase64: `data:image/jpeg;base64,${result.toString("base64")}` });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message });
    }
  });

  // Engine status
  app.get("/api/engine/status", (_req, res) => {
    res.json(automationEngine.getStatus());
  });

  // ── EQX Export/Import ─────────────────────────────────────────────────────
  const EQX_MAGIC = Buffer.from([0x45, 0x51, 0x58, 0x01]); // "EQX\x01"
  const EQX_KEY = crypto.createHash("sha256").update("EQUINOX_BOT_EQX_KEY_V1_PRIVATE_DO_NOT_SHARE").digest();

  function eqxEncrypt(payload: Buffer): Buffer {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", EQX_KEY, iv);
    return Buffer.concat([EQX_MAGIC, iv, cipher.update(payload), cipher.final()]);
  }

  function eqxDecrypt(data: Buffer): Buffer {
    if (data.length < 20) throw new Error("Invalid EQX file");
    const magic = data.subarray(0, 4);
    if (!magic.equals(EQX_MAGIC)) throw new Error("Not a valid EQX file — wrong magic header");
    const iv = data.subarray(4, 20);
    const ciphertext = data.subarray(20);
    const decipher = crypto.createDecipheriv("aes-256-cbc", EQX_KEY, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  // ── ZIP helper (stored, no compression) ─────────────────────────────────
  function buildStoredZip(files: Array<{ name: string; data: Buffer }>): Buffer {
    const localParts: Buffer[] = [];
    const centralDirs: Buffer[] = [];
    let offset = 0;
    for (const file of files) {
      const nameBuf = Buffer.from(file.name, "utf8");
      const crc = zlibCrc32(file.data) >>> 0;
      const size = file.data.length;
      const local = Buffer.alloc(30 + nameBuf.length);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(0, 10);
      local.writeUInt16LE(0, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(size, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      nameBuf.copy(local, 30);
      const cd = Buffer.alloc(46 + nameBuf.length);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0, 8);
      cd.writeUInt16LE(0, 10);
      cd.writeUInt16LE(0, 12);
      cd.writeUInt16LE(0, 14);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(size, 20);
      cd.writeUInt32LE(size, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt16LE(0, 30);
      cd.writeUInt16LE(0, 32);
      cd.writeUInt16LE(0, 34);
      cd.writeUInt16LE(0, 36);
      cd.writeUInt32LE(0, 38);
      cd.writeUInt32LE(offset, 42);
      nameBuf.copy(cd, 46);
      localParts.push(local, file.data);
      centralDirs.push(cd);
      offset += local.length + size;
    }
    const cdBuf = Buffer.concat(centralDirs);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...localParts, cdBuf, eocd]);
  }

  // ── Build a single profile's EQX payload ────────────────────────────────
  async function buildEqxPayload(id: number): Promise<{ encrypted: Buffer; safeUsername: string } | null> {
    const profile = await storage.getProfile(id);
    if (!profile) return null;
    const [allTools, followedUsers, statsData, apiCallsData] = await Promise.all([
      storage.getToolsByProfile(id),
      storage.getFollowedUsersByProfile(id, 100000),
      storage.getStatsByProfile(id),
      storage.getInstagramApiCallsByProfile(id, 2000),
    ]);
    const toolsWithSources = await Promise.all(
      allTools.map(async t => ({
        type: t.type,
        enabled: t.enabled,
        settings: t.settings,
        sources: (await storage.getSourcesByTool(t.id)).map(s => ({
          type: s.type,
          value: s.value,
          rank: s.rank,
          nrPosts: s.nrPosts,
          targetUserId: s.targetUserId,
        })),
      }))
    );
    const { id: _id, ...profileData } = profile;

    // Resolve proxy details when profile uses Proxy Manager (proxyId set)
    let resolvedProxy: { host: string; port: string; username: string | null; password: string | null } | null = null;
    if (profile.proxyId) {
      const proxies = await storage.getProxies();
      const linked = proxies.find(p => p.id === profile.proxyId);
      if (linked) {
        resolvedProxy = {
          host: linked.host,
          port: String(linked.port),
          username: linked.username ?? null,
          password: linked.password ?? null,
        };
      }
    }

    const payload = {
      version: 2,
      software: "EQUINOX_BOT",
      exportedAt: new Date().toISOString(),
      profile: {
        ...profileData,
        ...(resolvedProxy ? {
          resolvedProxyHost: resolvedProxy.host,
          resolvedProxyPort: resolvedProxy.port,
          resolvedProxyUsername: resolvedProxy.username,
          resolvedProxyPassword: resolvedProxy.password,
        } : {}),
      },
      tools: toolsWithSources,
      followedUsers: followedUsers.map(f => ({
        instagramUsername: f.instagramUsername,
        instagramUserId: f.instagramUserId,
        sourceValue: f.sourceValue,
        sourceType: f.sourceType,
        followedAt: f.followedAt,
      })),
      stats: statsData.map(s => ({
        toolType: s.toolType,
        count: s.count,
        date: s.date,
      })),
      apiCalls: apiCallsData.map(c => ({
        operationName: c.operationName,
        date: c.date,
        message: c.message,
        source: c.source,
        navChain: c.navChain,
        ipAddress: c.ipAddress,
        durationMs: c.durationMs,
      })),
    };
    const encrypted = eqxEncrypt(Buffer.from(JSON.stringify(payload), "utf8"));
    const safeUsername = (profile.username || "account").replace(/[^a-zA-Z0-9_-]/g, "_");
    return { encrypted, safeUsername };
  }

  // ── Bulk EQX export → single ZIP download (one save dialog) ─────────────
  app.get("/api/profiles/export-eqx-bulk", async (req, res) => {
    try {
      const raw = String(req.query.ids ?? "");
      const ids = raw.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      if (ids.length === 0) return res.status(400).json({ error: "No valid ids provided" });

      const results = await Promise.all(ids.map(id => buildEqxPayload(id).catch(() => null)));
      const files: Array<{ name: string; data: Buffer }> = [];
      for (const r of results) {
        if (r) files.push({ name: `${r.safeUsername}.eqx`, data: r.encrypted });
      }
      if (files.length === 0) return res.status(404).json({ error: "No profiles found for given ids" });

      const zip = buildStoredZip(files);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="equinox-accounts.zip"`);
      res.send(zip);
    } catch (e: any) {
      req.log.error({ err: e }, "export-eqx-bulk failed");
      return res.status(500).json({ error: e?.message });
    }
  });

  app.get("/api/profiles/:id/export-eqx", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const result = await buildEqxPayload(id);
      if (!result) return res.status(404).json({ error: "Profile not found" });

      const { encrypted, safeUsername } = result;
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${safeUsername}.eqx"`);
      res.send(encrypted);
      const profile = await storage.getProfile(id);
      storage.createSessionAction({
        profileId: id,
        toolId: 0,
        action: "account_exported",
        targetUsername: profile?.username ?? "",
        sourceValue: "",
        sourceType: "system",
        result: "ok",
        detail: `Account @${profile?.username} exported as ${safeUsername}.eqx`,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    } catch (e: any) {
      req.log.error({ err: e }, "export-eqx failed");
      return res.status(500).json({ error: e?.message });
    }
  });

  app.post("/api/profiles/import-eqx", async (req, res) => {
    try {
      const { eqxBase64 } = req.body as { eqxBase64?: string };
      if (!eqxBase64) return res.status(400).json({ error: "eqxBase64 is required" });

      let decrypted: Buffer;
      try {
        decrypted = eqxDecrypt(Buffer.from(eqxBase64, "base64"));
      } catch {
        return res.status(400).json({ error: "Invalid or corrupted EQX file" });
      }

      let payload: any;
      try {
        payload = JSON.parse(decrypted.toString("utf8"));
      } catch {
        return res.status(400).json({ error: "EQX file contains invalid data" });
      }

      if (payload?.software !== "EQUINOX_BOT") {
        return res.status(400).json({ error: "This file was not created by Equinox Bot" });
      }

      const { profile: profileData, tools: toolsData, followedUsers: fuData, stats: statsData } = payload;

      const { id: _id, ...cleanProfile } = profileData;
      cleanProfile.accountStatus = "pending";

      const created = await storage.createProfile(cleanProfile);

      // Update auto-created tools with saved settings/enabled state, and insert sources.
      // Each tool is restored independently — a failure on one tool never blocks the others.
      if (Array.isArray(toolsData)) {
        const existingTools = await storage.getToolsByProfile(created.id);
        for (const savedTool of toolsData) {
          const match = existingTools.find(t => t.type === savedTool.type);
          if (!match) continue;
          // Restore settings
          try {
            await storage.updateTool(match.id, { enabled: false, settings: savedTool.settings });
          } catch (e) {
            req.log.warn({ err: e }, `import-eqx: failed to update settings for ${savedTool.type ?? "unknown"} tool (non-fatal)`);
          }
          // Restore sources — filter out any rows missing required fields before bulk insert
          try {
            if (Array.isArray(savedTool.sources) && savedTool.sources.length > 0) {
              const validSources = savedTool.sources.filter(
                (s: any) => s != null && s.type != null && s.value != null
              );
              if (validSources.length > 0) {
                await storage.createSourcesBulk(
                  validSources.map((s: any) => ({
                    toolId: match.id,
                    type: String(s.type),
                    value: String(s.value),
                    rank: s.rank ?? null,
                    nrPosts: s.nrPosts ?? null,
                    targetUserId: s.targetUserId ?? "",
                    hashtagCursor: "",
                  }))
                );
              }
            }
          } catch (e) {
            req.log.warn({ err: e }, `import-eqx: failed to restore sources for ${savedTool.type ?? "unknown"} tool (non-fatal)`);
          }
        }
      }

      // Import followed users
      try {
        if (Array.isArray(fuData) && fuData.length > 0) {
          await storage.bulkImportFollowedUsers(created.id, fuData.map((f: any) => ({
            username: f.instagramUsername,
            userId: f.instagramUserId,
            followedAt: f.followedAt,
          })));
        }
      } catch (e) {
        req.log.warn({ err: e }, "import-eqx: failed to import followed users (non-fatal)");
      }

      // Import stats
      try {
        if (Array.isArray(statsData) && statsData.length > 0) {
          await storage.bulkInsertStats(statsData.map((s: any) => ({
            profileId: created.id,
            toolType: s.toolType,
            count: s.count,
            date: s.date,
          })));
        }
      } catch (e) {
        req.log.warn({ err: e }, "import-eqx: failed to import stats (non-fatal)");
      }

      storage.createSessionAction({
        profileId: created.id,
        toolId: 0,
        action: "account_imported",
        targetUsername: created.username ?? "",
        sourceValue: "",
        sourceType: "system",
        result: "ok",
        detail: `Account @${created.username} imported from .eqx file (${fuData?.length ?? 0} followed users restored)`,
        timestamp: new Date().toISOString(),
      }).catch(() => {});

      return res.status(201).json({
        ok: true,
        profileId: created.id,
        username: created.username,
        followedImported: fuData?.length ?? 0,
      });
    } catch (e: any) {
      req.log.error({ err: e }, "import-eqx failed");
      return res.status(500).json({ error: e?.message });
    }
  });

  // ── API Account Creator ───────────────────────────────────────────────────

  app.post("/api/signup/start", async (req, res) => {
    try {
      const {
        username, password, email, firstName, day, month, year,
        proxyHost, proxyPort, proxyUsername, proxyPassword, bio,
        imapHost, imapPort, imapUser, imapPass,
      } = req.body as {
        username: string; password: string; email: string; firstName: string;
        day: number; month: number; year: number;
        proxyHost?: string; proxyPort?: number; proxyUsername?: string; proxyPassword?: string;
        bio?: string;
        imapHost?: string; imapPort?: number; imapUser?: string; imapPass?: string;
      };
      if (!username || !password || !email || !day || !month || !year) {
        return res.status(400).json({ error: "username, password, email, day, month and year are required" });
      }
      let proxyUrl: string | undefined;
      if (proxyHost) {
        const auth = proxyUsername ? `${encodeURIComponent(proxyUsername)}:${encodeURIComponent(proxyPassword ?? "")}@` : "";
        proxyUrl = `http://${auth}${proxyHost}${proxyPort ? `:${proxyPort}` : ""}`;
      }
      const dobStr = `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      const { userAgentApi, apiLimits } = req.body as { userAgentApi?: string; apiLimits?: object };

      // Save attempt to DB
      const dbRecord = await storage.saveApiCreatedAccount({
        username, password, email,
        proxyHost: proxyHost ?? null,
        proxyPort: proxyPort ? Number(proxyPort) : null,
        proxyUsername: proxyUsername ?? null,
        proxyPassword: proxyPassword ?? null,
        bio: bio ?? null,
        imapServer: imapHost ?? null,
        imapPort: imapPort ? Number(imapPort) : null,
        imapPass: imapPass ?? null,
        status: "pending",
        instagramUserId: null,
        sessionCookies: null,
        errorMessage: null,
        steps: null,
        addedToAccounts: false,
        profileId: null,
        userAgentApi: userAgentApi ?? null,
        apiLimits: apiLimits ? JSON.stringify(apiLimits) : null,
        dateOfBirth: dobStr,
        createdAt: new Date().toISOString(),
      });

      const parsedApiLimits = apiLimits as { requestsMin: number; requestsMax: number; everySecondsMin: number; everySecondsMax: number } | undefined;
      let result = await createInstagramAccountViaApi({ username, password, email, firstName, day: Number(day), month: Number(month), year: Number(year), proxyUrl, bio: bio || undefined, userAgent: userAgentApi || undefined, apiLimits: parsedApiLimits });

      // Auto-fetch verification code via IMAP if credentials supplied
      if (result.status === "email_verification" && imapHost && imapUser && imapPass && result.sessionId) {
        req.log.info({ username }, "Email verification required — polling IMAP for code");
        result.steps.push(`IMAP: connecting to ${imapHost}:${imapPort ?? 993} as ${imapUser}...`);
        const code = await fetchInstagramCodeFromImap({
          host: imapHost,
          port: Number(imapPort) || 993,
          user: imapUser,
          pass: imapPass,
        });
        if (code) {
          result.steps.push(`IMAP: found code ${code} — submitting`);
          const verifyResult = await submitSignupCode(result.sessionId, code);
          result = { ...verifyResult, steps: [...result.steps, ...verifyResult.steps] } as typeof result;
        } else {
          result.steps.push("IMAP: no code found within timeout — manual entry required");
        }
      }

      // Update DB record with final result
      await storage.updateApiCreatedAccount(dbRecord.id, {
        status: result.status,
        instagramUserId: result.userId ?? null,
        sessionCookies: result.sessionCookies ? JSON.stringify(result.sessionCookies) : null,
        errorMessage: result.status === "error" ? (result.message ?? null) : null,
        steps: JSON.stringify(result.steps),
      });

      return res.json({ ...result, dbId: dbRecord.id });
    } catch (e: any) {
      req.log.error({ err: e }, "signup/start failed");
      return res.status(500).json({ error: e?.message });
    }
  });

  app.post("/api/signup/verify", async (req, res) => {
    try {
      const { sessionId, code, dbId } = req.body as { sessionId: string; code: string; dbId?: number };
      if (!sessionId || !code) return res.status(400).json({ error: "sessionId and code are required" });
      const result = await submitSignupCode(sessionId, code);
      if (dbId) {
        await storage.updateApiCreatedAccount(dbId, {
          status: result.status,
          instagramUserId: result.userId ?? null,
          sessionCookies: result.sessionCookies ? JSON.stringify(result.sessionCookies) : null,
          errorMessage: result.status === "error" ? (result.message ?? null) : null,
          steps: JSON.stringify(result.steps),
        });
      }
      return res.json(result);
    } catch (e: any) {
      req.log.error({ err: e }, "signup/verify failed");
      return res.status(500).json({ error: e?.message });
    }
  });

  app.get("/api/signup/created-accounts", async (req, res) => {
    try {
      const rows = await storage.listApiCreatedAccounts();
      return res.json(rows);
    } catch (e: any) {
      req.log.error({ err: e }, "created-accounts list failed");
      return res.status(500).json({ error: e?.message });
    }
  });

  app.delete("/api/signup/created-accounts/:id", async (req, res) => {
    try {
      await storage.deleteApiCreatedAccount(Number(req.params.id));
      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message });
    }
  });

  app.post("/api/signup/created-accounts/:id/add-to-accounts", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const rows = await storage.listApiCreatedAccounts();
      const row = rows.find(r => r.id === id);
      if (!row) return res.status(404).json({ error: "Record not found" });
      if (row.addedToAccounts) return res.status(409).json({ error: "Already added to accounts" });

      const apiLimits = row.apiLimits ? JSON.parse(row.apiLimits) : { requestsMin: 5, requestsMax: 10, everySecondsMin: 30, everySecondsMax: 60 };
      const created = await storage.createProfile({
        username: row.username,
        password: row.password,
        email: row.email ?? undefined,
        proxyHost: row.proxyHost ?? undefined,
        proxyPort: row.proxyPort ?? undefined,
        proxyUsername: row.proxyUsername ?? undefined,
        proxyPassword: row.proxyPassword ?? undefined,
        userAgentApi: row.userAgentApi ?? undefined,
        apiLimits,
        dateOfBirth: row.dateOfBirth ?? undefined,
        emailValidationUsername: row.email ?? undefined,
        emailValidationPassword: row.imapPass ?? undefined,
        emailValidationPop3Server: row.imapServer ?? undefined,
        emailValidationPort: row.imapPort ? String(row.imapPort) : undefined,
        accountStatus: "verifying",
        credentialsDirty: true,
      });

      await storage.updateApiCreatedAccount(id, { addedToAccounts: true, profileId: created.id });
      return res.json({ ok: true, profileId: created.id });
    } catch (e: any) {
      req.log.error({ err: e }, "add-to-accounts failed");
      return res.status(500).json({ error: e?.message });
    }
  });

  // Jarvee import: bulk import followed users for a single account
  app.post("/api/jarvee/import-followed-users", async (req, res) => {
    try {
      const { profileUsername, entries } = req.body as {
        profileUsername: string;
        entries: { username: string; userId: string; followedAt: string }[];
      };
      if (!profileUsername || !Array.isArray(entries)) {
        return res.status(400).json({ error: "profileUsername and entries[] are required" });
      }
      const profile = await storage.getProfileByUsername(profileUsername);
      if (!profile) {
        return res.status(404).json({ error: `No profile found matching username "${profileUsername}"` });
      }
      const result = await storage.bulkImportFollowedUsers(profile.id, entries);
      return res.json({ ok: true, profileId: profile.id, ...result });
    } catch (e: any) {
      req.log.error({ err: e }, "jarvee import-followed-users failed");
      return res.status(500).json({ error: e?.message });
    }
  });
}
