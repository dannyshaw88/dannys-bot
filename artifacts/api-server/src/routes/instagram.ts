import type { Express } from "express";
import type { Server } from "http";
import { storage } from "../storage";
import { api } from "../shared/routes";
import { z } from "zod/v4";
import { verifyInstagramCredentials } from "../instagram/instagramLogin";
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
  browserBack,
  browserForward,
  browserReload,
  clearSession,
  closeSession,
  browserAutoLogin,
  sendLoginDone,
  setCheckpointUrl,
  type ProxyConfig,
} from "../instagram/browserSession";
import { automationEngine } from "../instagram/automationEngine";

// The embedded browser always uses a desktop Chrome UA regardless of what
// userAgentEmbedded/userAgentApi says — Instagram's mobile web UA triggers
// the app-install interstitial (dark skeleton) instead of the full site.
const DESKTOP_BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Per-account verify lock — prevents concurrent logins for the same account.
// Multiple simultaneous IgApiClient instances logging in with the same device
// fingerprint look like a device leak to Instagram and cause blocks.
const verifyInFlight = new Set<number>();

const SERVER_START = new Date().toISOString();

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

    const { HttpsProxyAgent } = await import("https-proxy-agent");
    const https = await import("https");

    const auth = proxy.username && proxy.password
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
      : "";
    const proxyUrl = `http://${auth}${proxy.host}:${proxy.port}`;
    const agent = new HttpsProxyAgent(proxyUrl);

    const start = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const req2 = https.get(
          "https://i.instagram.com/api/v1/si/fetch_headers/?challenge_type=signup&guid=",
          { agent, timeout: 10000 },
          (r) => { r.resume(); resolve(); }
        );
        req2.on("error", reject);
        req2.on("timeout", () => { req2.destroy(); reject(new Error("timeout")); });
      });
      res.json({ alive: true, latencyMs: Date.now() - start });
    } catch (err: any) {
      res.json({ alive: false, latencyMs: Date.now() - start, error: err.message ?? "unreachable" });
    }
  });

  // Profiles
  app.get(api.profiles.list.path, async (_req, res) => {
    const data = await storage.getProfiles();
    res.json(data);
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
      if ("username" in body || "password" in body) {
        const current = await storage.getProfile(id);
        const usernameChanged = current && "username" in body && body.username !== current.username;
        const passwordChanged = current && "password" in body && body.password !== current.password;
        if (usernameChanged || passwordChanged) {
          body.credentialsDirty = true;
          body.accountStatus = "logged_out";
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
    await storage.deleteProfile(Number(req.params.id));
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

    let result: Awaited<ReturnType<typeof verifyInstagramCredentials>>;
    try {
      result = await verifyInstagramCredentials(effectiveProfile as typeof profile);
    } catch (err) {
      await storage.updateProfile(profile.id, { accountStatus: "pending" });
      const msg = err instanceof Error ? err.message : "Unexpected verify error";
      return fail(500, msg);
    } finally {
      // Always release — whether verifyInstagramCredentials threw or returned normally.
      verifyInFlight.delete(profileId);
    }

    await storage.updateProfile(profile.id, {
      accountStatus: result.accountStatus,
      ...(result.ok ? { credentialsDirty: false } : {}),
      ...(result.igDeviceState ? { igDeviceState: result.igDeviceState } : {}),
    });

    // Log verify completion as a session action so the LiveActivityTicker can surface it
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

    // Also surface verify result in the Dashboard API Call Log
    storage.createInstagramApiCall({
      profileId: profile.id,
      username: profile.username,
      operationName: "VerifyAccount",
      date: new Date().toISOString(),
      message: result.ok
        ? `✓ Verified — status: ${result.accountStatus ?? "valid"}`
        : `✗ Failed — ${result.accountStatus ?? "failed"}: ${result.message ?? ""}`,
      source: "System",
      durationMs: 0,
    }).catch(() => {});

    // If Instagram returned a checkpoint URL, cache it so the EB navigates there directly
    // on next open (bypassing the 429 rate-limit on the home page)
    if (!result.ok && result.accountStatus === "captcha" && result.checkpointUrl) {
      setCheckpointUrl(profile.id, result.checkpointUrl);
    }

    res.json(result);
  });

  function resolveImportStatus(raw: string | undefined): string {
    const s = (raw ?? "").toLowerCase().trim().replace(/\s+/g, "_");
    const valid = ["pending","valid","banned","captcha","email_confirmation","phone_verification","2fa_verification","stopped","logged_out","bad_password","action_blocked"];
    if (valid.includes(s)) return s;
    const aliases: Record<string, string> = {
      "ok": "valid", "active": "valid", "verified": "valid",
      "email_confirm": "email_confirmation", "phone_verify": "phone_verification",
      "2fa_verify": "2fa_verification", "action_block": "action_blocked",
    };
    return aliases[s] ?? "pending";
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
            // Jarvee exported explicit device IDs — use them exactly
            igDeviceState = JSON.stringify({
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
            igDeviceState = JSON.stringify({
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
            tags: p.tags || null,
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
      const updated = await storage.updateTool(Number(req.params.id), input);
      if (updated.enabled) {
        if (updated.type === "human_sessions") automationEngine.triggerHumanSession(updated.profileId);
        if (updated.type === "unfollow")       automationEngine.triggerUnfollow(updated.profileId);
        if (updated.type === "follow")         automationEngine.triggerFollow(updated.profileId);
        if (updated.type === "contact")        automationEngine.triggerReconcile();
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
        "UniqueNameAccount", "Name", "Operation Name", "Date",
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

        // Build IP:Port from the api call's recorded IP + the profile's proxy port
        const ip = call.ipAddress ?? "";
        let port = "";
        if (profile) {
          if (profile.proxyId) {
            const linked = proxyMap.get(profile.proxyId);
            port = linked?.port ? String(linked.port) : "";
          } else if (profile.proxyPort) {
            port = String(profile.proxyPort);
          }
        }
        const ipPort = ip && port ? `${ip}:${port}` : ip;

        return [
          `Instagram_${call.profileId}`,
          username,
          call.operationName,
          date,
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
    const ua = DESKTOP_BROWSER_UA;
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
        // Only mark the account valid when login genuinely succeeded.
        // result.ok is also true for 2FA/challenge screens ("2FA code submitted",
        // "2FA screen shown", etc.) — those must NOT set the account to valid
        // because we don't yet know whether the 2FA step passed.
        const trulyLoggedIn =
          result.ok &&
          (result.message === "Login successful" || result.message === "Already logged in");
        if (trulyLoggedIn) {
          await storage.updateProfile(profileId, { accountStatus: "valid", credentialsDirty: false });
        }
      })
      .catch(err  => sendLoginDone(profileId, false, String(err)));
  });

  // Close Chrome without wiping cookies — called when user dismisses the browser window
  app.post("/api/browser/:profileId/close", async (req, res) => {
    await closeSession(Number(req.params.profileId));
    res.json({ ok: true });
  });

  // Clear session: wipe cookies + close + reopen (the "Clear" button inside the browser panel)
  app.delete("/api/browser/:profileId/session", async (req, res) => {
    const profileId = Number(req.params.profileId);
    const profile = await storage.getProfile(profileId);
    const proxy = profile ? await resolveProxyConfig(profile) : undefined;
    await clearSession(profileId, DESKTOP_BROWSER_UA, proxy);
    res.json({ ok: true });
  });

  // SSE stream for real-time browser frames (proxy-friendly, no upgrade required)
  app.get("/api/browser/:profileId/stream", async (req, res) => {
    const profileId = Number(req.params.profileId);
    const profile = await storage.getProfile(profileId);
    if (!profile) { res.status(404).end(); return; }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx/proxy response buffering
    res.flushHeaders();

    try {
      const proxy = await resolveProxyConfig(profile);
      await getOrCreateSession(profileId, DESKTOP_BROWSER_UA, proxy);
      attachSSE(profileId, res);
    } catch (err: any) {
      res.write(`data: ${JSON.stringify({ type: "error", message: err?.message || "Failed to start browser" })}\n\n`);
      res.end();
      return;
    }

    req.on("close", () => {
      detachSSE(profileId, res);
    });
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
      }
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
          const result = await verifyInstagramCredentials(profile);
          await storage.updateProfile(profile.id, {
            accountStatus: result.accountStatus,
            ...(result.ok ? { credentialsDirty: false } : {}),
            ...(result.igDeviceState ? { igDeviceState: result.igDeviceState } : {}),
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
        await storage.updateProfile(profileId, { accountStatus: "valid", credentialsDirty: false });
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
      useLocalTime: settings.useLocalTime === "true",
      twoCaptchaApiKey: settings.twoCaptchaApiKey ?? "",
      verifyAllDelayMin: parseInt(settings.verifyAllDelayMin ?? "5", 10),
      verifyAllDelayMax: parseInt(settings.verifyAllDelayMax ?? "15", 10),
      logMaxRows: parseInt(settings.logMaxRows ?? "100000", 10),
      backupEnabled: settings.backupEnabled === "true",
      backupIntervalDays: parseInt(settings.backupIntervalDays ?? "7", 10),
    });
  });

  app.put("/api/settings", async (req, res) => {
    const { skipFollowedUsers, skipAlreadySkippedUsers, hikerApiEnabled, hikerApiToken, skipScrapedUsers, scrapedUserIgnoreDays, useLocalTime, twoCaptchaApiKey, verifyAllDelayMin, verifyAllDelayMax, logMaxRows, backupEnabled, backupIntervalDays } = req.body;
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
    const settings = await storage.getGlobalSettings();
    res.json({
      skipFollowedUsers: settings.skipFollowedUsers === "true",
      skipAlreadySkippedUsers: settings.skipAlreadySkippedUsers === "true",
      hikerApiEnabled: settings.hikerApiEnabled === "true",
      hikerApiToken: settings.hikerApiToken ?? "",
      skipScrapedUsers: settings.skipScrapedUsers === "true",
      scrapedUserIgnoreDays: parseInt(settings.scrapedUserIgnoreDays ?? "365", 10),
      useLocalTime: settings.useLocalTime === "true",
      twoCaptchaApiKey: settings.twoCaptchaApiKey ?? "",
      verifyAllDelayMin: parseInt(settings.verifyAllDelayMin ?? "5", 10),
      verifyAllDelayMax: parseInt(settings.verifyAllDelayMax ?? "15", 10),
      logMaxRows: parseInt(settings.logMaxRows ?? "100000", 10),
      backupEnabled: settings.backupEnabled === "true",
      backupIntervalDays: parseInt(settings.backupIntervalDays ?? "7", 10),
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
