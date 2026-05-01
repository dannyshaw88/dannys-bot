import type { Express } from "express";
import type { Server } from "http";
import { storage } from "../storage";
import { api } from "../shared/routes";
import { z } from "zod/v4";
import { verifyInstagramCredentials } from "../instagram/instagramLogin";
import { WebSocketServer } from "ws";
import {
  getOrCreateSession,
  attachWebSocket,
  browserNavigate,
  browserClick,
  browserMouseMove,
  browserScroll,
  browserKeyDown,
  browserKeyUp,
  browserType,
  browserBack,
  browserForward,
  browserReload,
  clearSession,
  browserAutoLogin,
  sendLoginDone,
  type ProxyConfig,
} from "../instagram/browserSession";
import { automationEngine } from "../instagram/automationEngine";

async function resolveProxyConfig(profile: {
  browserDirectConnection?: boolean | null;
  proxyId?: number | null;
  proxyHost?: string | null;
  proxyPort?: number | null;
  proxyUsername?: string | null;
  proxyPassword?: string | null;
}): Promise<ProxyConfig | undefined> {
  if (profile.browserDirectConnection !== false) return undefined;

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

  if (!profile.proxyHost || !profile.proxyPort) return undefined;
  return {
    host: profile.proxyHost,
    port: profile.proxyPort,
    username: profile.proxyUsername ?? undefined,
    password: profile.proxyPassword ?? undefined,
  };
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

  app.delete(api.proxies.delete.path, async (req, res) => {
    await storage.deleteProxy(Number(req.params.id));
    res.status(204).end();
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

  app.patch("/api/profiles/:id", handleProfileUpdate);
  app.put("/api/profiles/:id", handleProfileUpdate);

  app.delete(api.profiles.delete.path, async (req, res) => {
    await storage.deleteProfile(Number(req.params.id));
    res.status(204).end();
  });

  app.post("/api/profiles/:id/verify", async (req, res) => {
    const profile = await storage.getProfile(Number(req.params.id));
    if (!profile) return res.status(404).json({ ok: false, message: "Profile not found" });
    if (!profile.username || !profile.password) {
      return res.status(400).json({ ok: false, message: "Username and password are required before verifying." });
    }

    const bypassProxy = req.query.bypassProxy === "true";
    let effectiveProfile = { ...profile };
    if (!bypassProxy && profile.proxyId) {
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
    } else if (bypassProxy) {
      effectiveProfile = {
        ...effectiveProfile,
        proxyId: null,
        proxyHost: "",
        proxyPort: null,
        proxyUsername: "",
        proxyPassword: "",
      };
    }

    const result = await verifyInstagramCredentials(effectiveProfile as typeof profile);
    await storage.updateProfile(profile.id, {
      accountStatus: result.accountStatus,
      ...(result.ok ? { credentialsDirty: false } : {}),
    });

    res.json(result);
  });

  app.post("/api/profiles/import", async (req, res) => {
    try {
      const { profiles: toImport } = req.body;
      if (!Array.isArray(toImport) || toImport.length === 0) {
        return res.status(400).json({ message: "No profiles provided" });
      }
      const results: { success: boolean; username: string; error?: string }[] = [];
      for (const p of toImport) {
        try {
          const created = await storage.createProfile({
            username: p.username || "",
            password: p.password || "",
            email: p.email || null,
            proxyHost: p.proxyHost || null,
            proxyPort: p.proxyPort ? Number(p.proxyPort) : null,
            proxyUsername: p.proxyUsername || null,
            proxyPassword: p.proxyPassword || null,
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
            accountStatus: "valid",
          });
          results.push({ success: true, username: created.username });
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
      const created = await Promise.all(
        rows.map(row => storage.createSource({ ...row, toolId }))
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

  app.get("/api/instagram-api-calls", async (_req, res) => {
    const data = await storage.getInstagramApiCalls(500);
    res.json(data);
  });

  app.get("/api/logs/export", async (_req, res) => {
    try {
      const allProfiles = await storage.getProfiles();
      const profileMap = new Map(allProfiles.map(p => [p.id, p]));
      const apiCalls = await storage.getInstagramApiCalls(100000);

      const headers = [
        "UniqueNameAccount", "Name", "Operation Name", "Date",
        "Message", "Source", "NavChain", "IpAddress", "Duration(miliseconds)"
      ];

      const esc = (v: string) => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

      const csvRows = apiCalls.map((call: any) => {
        const profile = profileMap.get(call.profileId);
        const username = profile?.username ?? String(call.profileId);
        const date = new Date(call.date).toLocaleString("en-US", {
          month: "numeric", day: "numeric", year: "numeric",
          hour: "numeric", minute: "numeric", second: "numeric", hour12: true,
        });
        return [
          `Instagram_${call.profileId}`,
          username,
          call.operationName,
          date,
          call.message ?? "",
          call.source ?? "",
          call.navChain ?? "",
          call.ipAddress ?? "",
          String(call.durationMs ?? ""),
        ].map(esc).join(",");
      });

      const content = [headers.map(esc).join(","), ...csvRows].join("\r\n");
      const file = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, "utf8")]);

      const filename = `api_calls_${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
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
    const ua = profile.userAgentEmbedded || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
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
      .then(result => sendLoginDone(profileId, result.ok, result.message))
      .catch(err  => sendLoginDone(profileId, false, String(err)));
  });

  app.delete("/api/browser/:profileId/session", async (req, res) => {
    const profileId = Number(req.params.profileId);
    const profile = await storage.getProfile(profileId);
    const ua = profile?.userAgentEmbedded || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
    const proxy = profile ? await resolveProxyConfig(profile) : undefined;
    await clearSession(profileId, ua, proxy);
    res.json({ ok: true });
  });

  // WebSocket for real-time browser streaming
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", async (req, socket, head) => {
    const match = req.url?.match(/^\/api\/browser\/(\d+)\/stream/);
    if (!match) return;

    const profileId = Number(match[1]);
    const profile = await storage.getProfile(profileId);
    if (!profile) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, async (ws) => {
      const ua = profile.userAgentEmbedded || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

      try {
        const proxy = await resolveProxyConfig(profile);
        await getOrCreateSession(profileId, ua, proxy);
        attachWebSocket(profileId, ws);
      } catch (err: any) {
        ws.send(JSON.stringify({ type: "error", message: err?.message || "Failed to start browser" }));
        ws.close();
        return;
      }

      ws.on("message", async (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          switch (msg.type) {
            case "navigate":   await browserNavigate(profileId, msg.url); break;
            case "click":      await browserClick(profileId, msg.x, msg.y); break;
            case "mousemove":  await browserMouseMove(profileId, msg.x, msg.y); break;
            case "scroll":     await browserScroll(profileId, msg.x, msg.y, msg.deltaX, msg.deltaY); break;
            case "keydown":    await browserKeyDown(profileId, msg.key); break;
            case "keyup":      await browserKeyUp(profileId, msg.key); break;
            case "type":       await browserType(profileId, msg.text); break;
            case "back":       await browserBack(profileId); break;
            case "forward":    await browserForward(profileId); break;
            case "reload":     await browserReload(profileId); break;
          }
        } catch {}
      });

      ws.on("close", () => {});
    });
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

  // ── Global Settings ───────────────────────────────────────────────────────
  app.get("/api/settings", async (_req, res) => {
    const settings = await storage.getGlobalSettings();
    res.json({
      skipFollowedUsers: settings.skipFollowedUsers === "true",
      skipAlreadySkippedUsers: settings.skipAlreadySkippedUsers === "true",
      hikerApiEnabled: settings.hikerApiEnabled === "true",
      hikerApiToken: settings.hikerApiToken ?? "",
    });
  });

  app.put("/api/settings", async (req, res) => {
    const { skipFollowedUsers, skipAlreadySkippedUsers, hikerApiEnabled, hikerApiToken } = req.body;
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
    const settings = await storage.getGlobalSettings();
    res.json({
      skipFollowedUsers: settings.skipFollowedUsers === "true",
      skipAlreadySkippedUsers: settings.skipAlreadySkippedUsers === "true",
      hikerApiEnabled: settings.hikerApiEnabled === "true",
      hikerApiToken: settings.hikerApiToken ?? "",
    });
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

  // Engine status
  app.get("/api/engine/status", (_req, res) => {
    res.json(automationEngine.getStatus());
  });
}
