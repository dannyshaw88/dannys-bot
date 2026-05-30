import type { Express } from "express";
import type { Server } from "http";
import { WebSocketServer } from "ws";
import crypto from "node:crypto";
import { crc32 as zlibCrc32 } from "node:zlib";
import fs from "fs";
import path from "path";
import { LEAKS_PAGE_HTML } from "../instagram/leaksPage";
import { storage, statusEvents } from "../storage";
import { generateEbFingerprint } from "../instagram/browserFingerprint";
import { db } from "@workspace/db";
import { proxies } from "@workspace/db";
import { eq } from "drizzle-orm";
import { api } from "../shared/routes";
import { z } from "zod/v4";
import { verifyInstagramCredentials } from "../instagram/instagramLogin";
import { createInstagramAccountViaApi, submitSignupCode } from "../instagram/instagramWebClient";
import { fetchInstagramCodeFromImap } from "../instagram/imapHelper";
import { IgApiClient } from "instagram-private-api";
import {
  getOrCreateSession,
  attachWS,
  detachWS,
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
  clearEbSessionCookies,
  browserAutoLogin,
  sendLoginDone,
  setCheckpointUrl,
  getSessionPageCookies,
  harvestSignupCookiesFromEB,
  scheduleAutoLogin,
  getSessionChallengeUrl,
  deleteSavedCookies,
  attachSignupWS,
  detachSignupWS,
  signupBrowserInput,
  openSignupBrowser,
  closeSignupBrowser,
  resetSignupBrowser,
  isSignupBrowserOpen,
  getEbLiveStats,
  hasActiveWS,
  sendEbWsMessage,
  electronSilentVerify,
  browserFill2fa,
  createInstagramAccountViaEBForm,
  submitSignupCodeViaEB,
  isEBSignupSession,
  sendSignupWsMsg,
  runWarmupOnOpenBrowser,
  storePendingAutomateSession,
  consumePendingAutomateSession,
  type ProxyConfig,
} from "../instagram/browserSession";
import { automationEngine } from "../instagram/automationEngine";
import { MOBILE_VERSION_CODE } from "../instagram/instagramWebClient";
import { userAgents as UA_POOL } from "../shared/userAgents";

// ── Deterministic UA picker ─────────────────────────────────────────────────
// Picks a paired { api, embedded } UA from the pool based on the account's
// username so the same username always gets the same device profile (stable
// across re-imports, re-creates, etc.). Falls back to index 0 for empty names.
// NEVER call randomUUID or Math.random here — determinism is required by the
// DEVICE FINGERPRINT CONTINUITY RULE.
function pickUAForAccount(username: string): { api: string; embedded: string } {
  if (!username || UA_POOL.length === 0) return UA_POOL[0];
  let hash = 5381;
  for (let i = 0; i < username.length; i++) {
    hash = ((hash << 5) + hash) ^ username.charCodeAt(i);
    hash = hash >>> 0; // keep unsigned 32-bit
  }
  return UA_POOL[hash % UA_POOL.length];
}

// Last-resort desktop Chrome UA — used ONLY for the Clear EB Session cleanup path when
// no per-account UA is stored (so the session can still be wiped even if UA is unset).
// NEVER use this for a new login, verify, or WS attach — those must block instead.
const DESKTOP_BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Per-account verify lock — prevents concurrent logins for the same account.
// Multiple simultaneous IgApiClient instances logging in with the same device
// fingerprint look like a device leak to Instagram and cause blocks.
const verifyInFlight = new Set<number>();

// Global concurrency gate for electronSilentVerify — limits to 1 simultaneous
// hidden BrowserWindow at a time.  Electron's main process cannot handle
// multiple concurrent Chromium renderer processes during silent verify (GPU
// memory contention + debugger conflicts crash the app when 3+ accounts are
// verified at once).  Additional verify requests queue here and run in order.
let _silentVerifySlotFree = true;
const _silentVerifyWaiters: Array<() => void> = [];
function acquireSilentVerifySlot(): Promise<void> {
  if (_silentVerifySlotFree) { _silentVerifySlotFree = false; return Promise.resolve(); }
  return new Promise(resolve => _silentVerifyWaiters.push(resolve));
}
function releaseSilentVerifySlot(): void {
  const next = _silentVerifyWaiters.shift();
  if (next) { next(); } else { _silentVerifySlotFree = true; }
}

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
        type: (linked.proxyType === "socks5" ? "socks5" : "http") as "http" | "socks5",
        username: linked.username ?? undefined,
        password: linked.password ?? undefined,
      };
    }
  }

  if (profile.proxyHost && profile.proxyPort) {
    return {
      host: profile.proxyHost,
      port: profile.proxyPort,
      type: "http" as const,
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

  // Write a system-level activity log entry so the Dashboard shows when Equinox
  // was started or restarted.  profileId/toolId 0 are sentinels for system events
  // (no FK constraint in SQLite so 0 is safe to use).
  storage.createSessionAction({
    profileId: 0,
    toolId: 0,
    action: "server_started",
    targetUsername: "",
    sourceValue: "",
    sourceType: "",
    result: "ok",
    detail: `Equinox started — ${new Date(SERVER_START).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}`,
    timestamp: SERVER_START,
  }).catch(() => {});

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
    let filtered: typeof all;
    if (cm === "1") filtered = all.filter((p: any) => p.creatorMode);
    else if (cm === "0") filtered = all.filter((p: any) => !p.creatorMode);
    else filtered = all;
    // Attach live EB fingerprint stats (battery %, connection Mbps) for any
    // profile that currently has an open browser session.  Null when the EB
    // is not running.  The frontend polls every 5 s so the values update live.
    const enriched = filtered.map((p: any) => ({
      ...p,
      ebLiveStats: p.userAgentEmbedded ? getEbLiveStats(p.id, p.userAgentEmbedded) : null,
    }));
    res.json(enriched);
  });

  // Must be before /:id routes so Express doesn't treat "last-api-calls" as an ID.
  app.get("/api/profiles/last-api-calls", async (_req, res) => {
    const data = await storage.getLastValidApiCallByProfile();
    res.json(data);
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
      const input = inputSchema.parse(req.body) as any;
      // Auto-assign paired UAs when the user leaves them blank on manual add
      if (!input.userAgentEmbedded || !input.userAgentApi) {
        const autoUA = pickUAForAccount(input.username || "");
        if (!input.userAgentEmbedded) input.userAgentEmbedded = autoUA.embedded;
        if (!input.userAgentApi)      input.userAgentApi      = autoUA.api;
      }
      const created = await storage.createProfile(input);
      // Seed browser cookie file if cookies were provided — same as bulk/EQX import
      if (created.igApiCookies) seedBrowserCookieFile(created.id, created.igApiCookies);
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
      // Never allow a PATCH to overwrite a meaningful verify-result status with "pending".
      // This prevents the frontend from trampling "locked", "captcha", or
      // "automated_behaviour_detected" with stale form data immediately after verify.
      // Only the dedicated /verify route, /wipe, and /reset-device-ids may set "pending".
      const PROTECTED_STATUSES = new Set(["locked", "captcha", "automated_behaviour_detected", "valid", "stopped"]);
      if ("accountStatus" in body && body.accountStatus === "pending" && current && PROTECTED_STATUSES.has(current.accountStatus ?? "")) {
        console.warn(`[status-guard] BLOCKED attempt to set profile ${id} → "pending" via PATCH route (current: ${current.accountStatus})`);
        delete body.accountStatus;
      }
      // When the caller sets preserveAccountStatus=true (e.g. Proxy Manager with
      // "Keep accounts valid" checked), skip all status-changing logic and restore
      // the current status so it is never overwritten by this PATCH.
      const preserveAccountStatus = !!body.preserveAccountStatus;
      delete body.preserveAccountStatus;
      if (preserveAccountStatus) {
        delete body.accountStatus;
      } else if ("username" in body || "password" in body) {
        const usernameChanged = current && "username" in body && body.username !== current.username;
        const passwordChanged = current && "password" in body && body.password !== current.password;
        if (usernameChanged || passwordChanged) {
          body.credentialsDirty = true;
          body.accountStatus = "pending";
        }
      }
      // ── Protect session credentials from accidental erasure via PATCH ─────────
      // igApiCookies and igDeviceState hold the account's active Instagram session
      // and device identity.  A null/empty value arriving via a generic PATCH
      // (e.g. from a form field that renders empty when not set) must never
      // overwrite valid stored cookies.  The dedicated /inject-cookies and
      // /clear-session-cookies routes are the only legitimate paths for modifying
      // these fields.  If this PATCH explicitly carries a non-empty string cookie
      // value (e.g. the edit form's cookie textarea was filled in), allow it through.
      if ("igApiCookies" in body) {
        const val = body.igApiCookies;
        if (!val || typeof val !== "string" || !val.includes("sessionid=")) {
          console.warn(`[cookie-guard] BLOCKED attempt to set igApiCookies → ${JSON.stringify(val)} via PATCH route for profile ${id}`);
          delete body.igApiCookies;
        }
      }
      if ("igDeviceState" in body && !body.igDeviceState) {
        console.warn(`[cookie-guard] BLOCKED attempt to clear igDeviceState via PATCH route for profile ${id}`);
        delete body.igDeviceState;
      }
      const updated = await storage.updateProfile(id, body);
      // If cookies were changed via the edit form, refresh the browser cookie file
      if (body.igApiCookies && typeof body.igApiCookies === "string") {
        seedBrowserCookieFile(id, body.igApiCookies);
      }
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: "Failed to update profile" });
    }
  }

  // Assign a fresh random UA + clear stored device state so the next verify
  // generates brand-new mobile device IDs for this profile.
  // Called by BulkImportPage immediately after account creation.
  // Must be registered BEFORE /api/profiles/:id so it isn't treated as an ID.
  app.post("/api/profiles/:id/reset-device-ids", async (req, res) => {
    const id = Number(req.params.id);
    // Accept an optional specific UA from the body (device-picker flow).
    // Falls back to a random pool entry when no UA is supplied (existing Reset button flow).
    const { userAgentApi, userAgentEmbedded } = (req.body ?? {}) as { userAgentApi?: string; userAgentEmbedded?: string };
    const ua = (userAgentApi && userAgentEmbedded)
      ? { api: userAgentApi, embedded: userAgentEmbedded }
      : UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
    await storage.updateProfile(id, {
      userAgentApi: ua.api,
      userAgentEmbedded: ua.embedded,
      igDeviceState: null,
      igApiCookies: null,
      accountStatus: "pending",
      credentialsDirty: true,
      ebFingerprint: JSON.stringify(generateEbFingerprint(ua.api)),
    });
    res.json({ ok: true });
  });

  // Bulk-update: apply one patch to many profiles in a single request.
  // Must be registered BEFORE /api/profiles/:id so "bulk-update" isn't treated as an ID.
  app.post("/api/profiles/bulk-update", async (req, res) => {
    const { ids, patch } = req.body ?? {};
    if (!Array.isArray(ids) || !patch || typeof patch !== "object") {
      return res.status(400).json({ message: "ids (array) and patch (object) are required" });
    }
    // ── Field whitelist ───────────────────────────────────────────────────────
    // Only allow the fields that the account-level Copy Settings UI legitimately
    // sends.  Any other field — especially identity/fingerprint fields like
    // userAgentEmbedded, userAgentApi, igDeviceState, igApiCookies, proxyId — is
    // silently stripped so a crafted API call can never overwrite them in bulk.
    const ALLOWED: Set<string> = new Set([
      "tags",
      "apiLimits",
      "activeTimerEnabled", "activeTimerStart", "activeTimerEnd",
      "syncEnabled", "syncIntervalMin", "syncIntervalMax", "syncUseHiker",
    ]);
    const safePatch: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      if (ALLOWED.has(key)) safePatch[key] = patch[key];
    }
    if (Object.keys(safePatch).length === 0) {
      return res.status(400).json({ message: "No valid fields in patch" });
    }
    await Promise.all((ids as number[]).map(id => storage.updateProfile(id, safePatch)));
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

  // ── Shared helper: seed browser cookie JSON from igApiCookies string ────────
  // Called by both the bulk import and EQX import routes immediately after a
  // profile is created/updated with igApiCookies.  Without this file Chrome
  // starts with ZERO cookies on first launch — Instagram sees a brand-new device
  // (no mid, no ig_did) and immediately fires update_risky_contactpoint.
  const COOKIE_META: Record<string, { httpOnly: boolean; sameSite: string }> = {
    sessionid:  { httpOnly: true,  sameSite: "Lax" },
    csrftoken:  { httpOnly: false, sameSite: "Lax" },
    ds_user_id: { httpOnly: true,  sameSite: "Lax" },
    mid:        { httpOnly: false, sameSite: "Lax" },
    ig_did:     { httpOnly: false, sameSite: "Lax" },
    ig_nrcb:    { httpOnly: false, sameSite: "Lax" },
  };
  function seedBrowserCookieFile(profileId: number, igApiCookies: string): void {
    try {
      const cookiesDir = process.env.DATABASE_PATH
        ? path.join(path.dirname(process.env.DATABASE_PATH), "browser-data")
        : path.join(process.cwd(), "server", "browser-data");
      const cookieFilePath = path.join(cookiesDir, `cookies-${profileId}.json`);
      const parsed: Record<string, string> = {};
      for (const part of igApiCookies.split(";")) {
        const eqIdx = part.indexOf("=");
        if (eqIdx < 1) continue;
        const name  = part.slice(0, eqIdx).trim();
        const value = part.slice(eqIdx + 1).trim();
        if (name) parsed[name] = value;
      }
      if (!parsed["sessionid"]) return; // nothing useful to seed
      const puppeteerCookies = Object.entries(parsed).map(([name, value]) => {
        const meta = COOKIE_META[name] ?? { httpOnly: false, sameSite: "Lax" };
        return { name, value, domain: ".instagram.com", path: "/", expires: -1,
                 httpOnly: meta.httpOnly, secure: true, sameSite: meta.sameSite, session: false };
      });
      fs.mkdirSync(cookiesDir, { recursive: true });
      fs.writeFileSync(cookieFilePath, JSON.stringify(puppeteerCookies, null, 2), "utf8");
    } catch { /* non-fatal — import succeeds even if file write fails */ }
  }

  // ── Cookie Injection ─────────────────────────────────────────────────────
  // Writes cookies both to igApiCookies (DB) AND to the Puppeteer cookie file
  // so the embedded browser picks them up on its next session start.
  app.post("/api/profiles/:id/clear-session-cookies", async (req, res) => {
    const profileId = Number(req.params.id);
    const profile = await storage.getProfile(profileId);
    if (!profile) return res.status(404).json({ ok: false, message: "Profile not found" });

    // Full wipe — igApiCookies null, Chrome userdata gone, JSON seed file gone.
    // Nothing is written back.  The account returns to "pending" so the next
    // EB open shows the login page and the user can start a fresh session.
    await storage.updateProfile(profileId, {
      igApiCookies: null,
      accountStatus: "pending",
    } as any);

    // Close the live EB session and delete Chrome's entire userdata directory
    // (cookies, localStorage, IndexedDB, saved logins).  No device-token seed
    // file is written back — the slate is completely clean.
    await clearEbSessionCookies(profileId).catch(e =>
      console.warn(`[profiles] clearEbSessionCookies failed for ${profileId}: ${e?.message}`),
    );

    console.log(`[profiles] @${profile.username}: session fully cleared — igApiCookies null, Chrome userdata wiped, no seed file written`);
    res.json({ ok: true });
  });

  app.post("/api/profiles/:id/inject-cookies", async (req, res) => {
    const profileId = Number(req.params.id);
    const { cookies: rawCookies } = req.body ?? {};
    if (!rawCookies || typeof rawCookies !== "string") {
      return res.status(400).json({ ok: false, message: "cookies string is required" });
    }
    const profile = await storage.getProfile(profileId);
    if (!profile) return res.status(404).json({ ok: false, message: "Profile not found" });

    // Parse the semicolon-separated cookie string into name=value pairs.
    // Values may be URL-encoded (e.g. %3A → :) when copied from a browser devtools
    // cookie inspector — decode them so the real token value is stored.
    const parsed: Record<string, string> = {};
    for (const part of rawCookies.split(";")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx < 1) continue;
      const name = part.slice(0, eqIdx).trim();
      const rawValue = part.slice(eqIdx + 1).trim();
      let value = rawValue;
      try { value = decodeURIComponent(rawValue); } catch { value = rawValue; }
      if (name) parsed[name] = value;
    }

    if (!parsed["sessionid"]) {
      return res.status(400).json({ ok: false, message: "Cookie string must contain sessionid" });
    }

    // Build the canonical igApiCookies string (same format as saveCookies() in browserSession.ts)
    const cookieParts = [
      `sessionid=${parsed["sessionid"]}`,
      parsed["csrftoken"]  ? `csrftoken=${parsed["csrftoken"]}`     : "",
      parsed["ds_user_id"] ? `ds_user_id=${parsed["ds_user_id"]}`   : "",
      parsed["mid"]        ? `mid=${parsed["mid"]}`                 : "",
      parsed["ig_did"]     ? `ig_did=${parsed["ig_did"]}`           : "",
    ].filter(Boolean);
    const igApiCookies = cookieParts.join(";");

    // Write Puppeteer-format cookie JSON so the EB loads them on next session start
    const cookiesDir = process.env.DATABASE_PATH
      ? path.join(path.dirname(process.env.DATABASE_PATH), "browser-data")
      : path.join(process.cwd(), "server", "browser-data");
    const cookieFilePath = path.join(cookiesDir, `cookies-${profileId}.json`);

    // Known cookie attributes for instagram.com
    const COOKIE_META: Record<string, { httpOnly: boolean; sameSite: string }> = {
      sessionid:  { httpOnly: true,  sameSite: "Lax" },
      csrftoken:  { httpOnly: false, sameSite: "Lax" },
      ds_user_id: { httpOnly: true,  sameSite: "Lax" },
      mid:        { httpOnly: false, sameSite: "Lax" },
      ig_did:     { httpOnly: false, sameSite: "Lax" },
      ig_nrcb:    { httpOnly: false, sameSite: "Lax" },
    };

    const puppeteerCookies = Object.entries(parsed).map(([name, value]) => {
      const meta = COOKIE_META[name] ?? { httpOnly: false, sameSite: "Lax" };
      return {
        name,
        value,
        domain: ".instagram.com",
        path: "/",
        expires: -1,
        httpOnly: meta.httpOnly,
        secure: true,
        sameSite: meta.sameSite,
        session: false,
      };
    });

    try {
      fs.mkdirSync(cookiesDir, { recursive: true });
      fs.writeFileSync(cookieFilePath, JSON.stringify(puppeteerCookies, null, 2), "utf8");
    } catch (err: any) {
      console.error(`[inject-cookies:${profileId}] Failed to write cookie file:`, err?.message);
      return res.status(500).json({ ok: false, message: "Failed to write browser cookie file" });
    }

    // Update igApiCookies in DB, and optionally sync igDeviceState with igDid/mid
    const dbUpdate: Record<string, unknown> = { igApiCookies };
    if (parsed["ig_did"] || parsed["mid"]) {
      try {
        const existing = JSON.parse((profile.igDeviceState as string | null) ?? "{}");
        if (parsed["ig_did"]) existing.igDid = parsed["ig_did"];
        dbUpdate.igDeviceState = JSON.stringify(existing);
      } catch { /* non-fatal */ }
    }

    await storage.updateProfile(profileId, dbUpdate as any);
    console.log(`[inject-cookies:${profileId}] Wrote ${puppeteerCookies.length} cookies to file and DB (mid=${parsed["mid"]?.slice(0,10) ?? "n/a"}…)`);
    res.json({ ok: true, cookieCount: puppeteerCookies.length });
  });

  // ── Native EB cookie push — called by ebManager (Electron) after every
  // Instagram navigation to hand fresh browser cookies to the API server.
  // The same flow as a Puppeteer-EB cookie save: build igApiCookies string,
  // write cookie JSON file, update the DB, then mark account status valid if
  // a sessionid is present.  Does NOT trigger full re-verify (the Jarvee
  // two-stage handshake is still handled by the /verify route on demand).
  app.post("/api/profiles/:id/eb-cookies", async (req, res) => {
    const profileId = Number(req.params.id);
    const { cookies } = req.body ?? {};
    if (!Array.isArray(cookies)) return res.status(400).json({ ok: false, message: "cookies array required" });

    const profile = await storage.getProfile(profileId);
    if (!profile) return res.status(404).json({ ok: false, message: "Profile not found" });

    const map: Record<string, string> = {};
    for (const c of cookies) {
      if (c.name && c.value != null) map[c.name] = c.value;
    }

    if (!map["sessionid"]) return res.json({ ok: true, skipped: true });

    // Build canonical igApiCookies string
    const parts = [
      `sessionid=${map["sessionid"]}`,
      map["csrftoken"]  ? `csrftoken=${map["csrftoken"]}`    : "",
      map["ds_user_id"] ? `ds_user_id=${map["ds_user_id"]}`  : "",
      map["mid"]        ? `mid=${map["mid"]}`                : "",
      map["ig_did"]     ? `ig_did=${map["ig_did"]}`          : "",
    ].filter(Boolean);
    const igApiCookies = parts.join(";");

    // Write cookie JSON file (same format ebManager already wrote; this is a DB-side sync)
    const cookiesDir = process.env.DATABASE_PATH
      ? path.join(path.dirname(process.env.DATABASE_PATH), "browser-data")
      : path.join(process.cwd(), "server", "browser-data");
    const cookieFilePath2 = path.join(cookiesDir, `cookies-${profileId}.json`);
    const cookieObjs = cookies.map((c: any) => ({
      name:     c.name,
      value:    c.value,
      domain:   c.domain   ?? ".instagram.com",
      path:     c.path     ?? "/",
      expires:  c.expirationDate ?? -1,
      httpOnly: c.httpOnly ?? false,
      secure:   c.secure   ?? true,
      session:  !c.expirationDate,
      sameSite: "None",
    }));
    try {
      fs.mkdirSync(cookiesDir, { recursive: true });
      fs.writeFileSync(cookieFilePath2, JSON.stringify(cookieObjs, null, 2), "utf8");
    } catch {}

    // Sync device IDs from cookies into igDeviceState (DEVICE FINGERPRINT CONTINUITY RULE)
    const dbUpdate: Record<string, unknown> = { igApiCookies };
    if (map["ig_did"] || map["mid"]) {
      try {
        const existing = JSON.parse((profile.igDeviceState as string | null) ?? "{}");
        if (map["ig_did"]) existing.igDid = map["ig_did"];
        if (map["mid"])    existing.mid    = map["mid"];
        dbUpdate.igDeviceState = JSON.stringify(existing);
      } catch {}
    }
    await storage.updateProfile(profileId, dbUpdate as any);
    console.log(`[eb-cookies:${profileId}] Synced ${cookies.length} cookies to DB (sessionid present, mid=${map["mid"]?.slice(0,10) ?? "n/a"}…)`);
    res.json({ ok: true });
  });

  // ── EB Nav push (Electron native window → BrowserPanel address bar) ──────
  // Called by ebManager on did-navigate to push a urlChange WS message so
  // the address bar in the main app updates when the native window navigates.
  app.post("/api/profiles/:id/eb-nav", (req, res) => {
    const profileId = Number(req.params.id);
    const { url } = req.body ?? {};
    if (url) sendEbWsMessage(profileId, { type: "urlChange", url });
    res.json({ ok: true });
  });

  // ── EB load-failure reporting (Electron native window mode) ──────────────
  // Electron's did-fail-load fires when Chrome hits ERR_TOO_MANY_REDIRECTS,
  // ERR_TUNNEL_CONNECTION_FAILED, proxy errors, etc. This logs the error code
  // so it appears in server logs for debugging.
  app.post("/api/profiles/:id/eb-fail", (req, res) => {
    const profileId = Number(req.params.id);
    const { code, desc, url } = req.body ?? {};
    console.error(`[EB-FAIL] profile=${profileId} code=${code} desc=${desc} url=${url}`);
    res.json({ ok: true });
  });

  // ── EB diagnostic log relay (Electron main process → server log) ──────────
  // ebManager.ts runs in the Electron main process whose console.log does NOT
  // appear in the server debug log. This endpoint lets the main process relay
  // important diagnostic messages (cookie banner detection, etc.) so they show
  // up in the log file the user can see.
  app.post("/api/profiles/:id/eb-diag", (req, res) => {
    const profileId = Number(req.params.id);
    const { message } = req.body ?? {};
    if (message) console.log(`[ebManager:${profileId}] ${message}`);
    res.json({ ok: true });
  });

  // ── EB Input proxy (Electron native window mode) ─────────────────────────
  // Receives the same message objects BrowserPanel's send() emits.
  // Proxies them to the ebManager IPC HTTP server which controls the native
  // BrowserWindow (navigate, reload, back, forward, type, newTab).
  // Only active when EB_IPC_PORT is set (i.e. running inside Electron).
  app.post("/api/profiles/:id/eb-input", async (req, res) => {
    const profileId = Number(req.params.id);
    const ipcPort   = Number(process.env.EB_IPC_PORT ?? 0);
    if (!ipcPort) return res.json({ ok: true, skipped: true, reason: "not in Electron mode" });

    const body = { ...req.body, profileId };
    try {
      const r = await fetch(`http://127.0.0.1:${ipcPort}/eb/input`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      return res.json(data);
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message ?? "IPC error" });
    }
  });

  // ── EB Auto-login (Electron native window mode) ───────────────────────────
  // Called by BrowserPanel when the Login button is clicked in Electron mode.
  // Proxies to ebManager IPC /eb/auto-login which drives the native BrowserWindow.
  app.post("/api/profiles/:id/eb-auto-login", async (req, res) => {
    const profileId = Number(req.params.id);
    const ipcPort   = Number(process.env.EB_IPC_PORT ?? 0);
    if (!ipcPort) return res.json({ ok: false, message: "Not running in Electron mode" });

    const profile = await storage.getProfile(profileId);
    if (!profile) return res.status(404).json({ ok: false, message: "Profile not found" });

    // Resolve proxy via proxyId (Proxy Manager) OR inline proxyHost — whichever is set.
    // Previously only proxyHost was used, so accounts whose proxy was linked via the
    // Proxy Manager (proxyId) had no proxy applied to the EB session, causing the
    // real machine IP to appear in the leak test instead of the proxy exit IP.
    const resolvedEbProxy = await resolveProxyConfig(profile);
    const body = {
      profileId,
      username:  profile.username,
      password:  profile.password,
      twoFAKey:  profile.twoFASecretKey ?? "",
      proxy:     resolvedEbProxy
        ? { host: resolvedEbProxy.host, port: resolvedEbProxy.port, user: resolvedEbProxy.username, pass: resolvedEbProxy.password, type: resolvedEbProxy.type }
        : undefined,
      userAgent: profile.userAgentEmbedded ?? "",
    };
    try {
      const r = await fetch(`http://127.0.0.1:${ipcPort}/eb/auto-login`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({ ok: false, message: "IPC parse error" }));
      return res.json(data);
    } catch (err: any) {
      return res.status(500).json({ ok: false, message: err?.message ?? "IPC error" });
    }
  });

  // ── Wipe EB session (Electron native window mode) ─────────────────────────
  // Clears the native BrowserWindow's cookie partition and the stored igApiCookies
  // so the next login starts completely fresh.
  app.post("/api/profiles/:id/wipe-eb-session", async (req, res) => {
    const profileId = Number(req.params.id);
    const ipcPort   = Number(process.env.EB_IPC_PORT ?? 0);

    if (ipcPort) {
      try {
        await fetch(`http://127.0.0.1:${ipcPort}/eb/close`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ profileId }),
        });
      } catch { /* ignore */ }
    }
    try {
      await storage.updateProfile(profileId, { igApiCookies: null as any, igDeviceState: null as any });
    } catch { /* ignore */ }
    res.json({ ok: true });
  });

  // ── EB Proxy Config (Electron native window mode) ────────────────────────
  // Returns the fully-resolved proxy + userAgent for a profile so main.ts can
  // configure the native BrowserWindow session without doing its own DB lookups.
  // Uses the same resolveProxyConfig() path as eb-auto-login and the browser/start
  // route — single source of truth, no format mismatches.
  app.get("/api/profiles/:id/eb-proxy", async (req, res) => {
    const profileId = Number(req.params.id);
    const profile = await storage.getProfile(profileId);
    if (!profile) return res.status(404).json({ proxy: null, userAgent: null });
    const resolved = await resolveProxyConfig(profile);
    return res.json({
      proxy: resolved
        ? { host: resolved.host, port: resolved.port, user: resolved.username ?? undefined, pass: resolved.password ?? undefined, type: resolved.type ?? "http" }
        : null,
      userAgent: profile.userAgentEmbedded ?? null,
    });
  });

  // ── EB State (Electron native window mode) ────────────────────────────────
  // Returns whether the native BrowserWindow is currently open and its URL.
  // Used by BrowserPanel to poll for address bar updates.
  app.get("/api/profiles/:id/eb-state", async (req, res) => {
    const profileId = Number(req.params.id);
    const ipcPort   = Number(process.env.EB_IPC_PORT ?? 0);
    if (!ipcPort) return res.json({ open: false, url: "" });
    try {
      const r = await fetch(`http://127.0.0.1:${ipcPort}/eb/state?profileId=${profileId}`);
      const data = await r.json().catch(() => ({ open: false, url: "" }));
      return res.json(data);
    } catch {
      return res.json({ open: false, url: "" });
    }
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
    // NOTE: this check must happen BEFORE setting accountStatus="verifying" so a
    // 400 response never leaves the button stuck on "Verifying".
    if (!effectiveProfile.proxyHost || !effectiveProfile.proxyPort) {
      return fail(400, "No proxy assigned. Assign a proxy to this account before verifying.");
    }

    // Mark as "verifying" in the DB — only reached once proxy is confirmed present.
    // This way the dashboard shows the in-progress state if the user navigates away.
    await storage.updateProfile(profile.id, { accountStatus: "verifying" });


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
      type:     ((effectiveProfile as any).proxyType === "socks5" ? "socks5" : "http") as "http" | "socks5",
    } : undefined;

    // ── UA BLOCK — per USER-AGENT RULE (non-negotiable) ─────────────────────────
    // A null userAgentEmbedded means every null-UA account uses the same shared
    // DESKTOP_BROWSER_UA string. Instagram fingerprint-links them, flags the login
    // as a bot cluster, and fires update_risky_contactpoint in an infinite redirect.
    // Block here so the user is forced to assign a unique UA before verifying.
    if (!effectiveProfile.userAgentEmbedded) {
      verifyInFlight.delete(profileId);
      await storage.updateProfile(profile.id, { accountStatus: "pending" });
      return fail(400, "No EB User-Agent configured for this account. Assign a unique User-Agent before verifying — accounts without one share a fingerprint and get flagged by Instagram.");
    }
    const ebUA = effectiveProfile.userAgentEmbedded as string;

    // Steps 1-2: Launch EB + auto-login.
    // Electron mode: hidden silent window — Verify never pops up a visible browser.
    // Puppeteer mode: open the visible embedded browser session and auto-login.
    let result: { ok: boolean; message: string; accountStatus: string; igApiCookies?: string; checkpointUrl?: string };
    let loginResult: { ok: boolean; message: string };
    let _silentCookies: Array<{ name: string; value: string }> | null = null;

    if (process.env.EB_IPC_PORT) {
      // Electron silent path — no visible window ever opens during verify.
      // Acquire the global slot first: only 1 silent-verify BrowserWindow at a
      // time so the Electron main process is never overwhelmed by multiple
      // concurrent Chromium renderer processes (crashes with 3+ accounts).
      await acquireSilentVerifySlot();
      try {
        const silentRes = await electronSilentVerify({
          profileId,
          username:  profile.username,
          password:  profile.password!,
          twoFAKey:  profile.twoFASecretKey || "",
          proxy:     proxyConfig ? { host: proxyConfig.host, port: proxyConfig.port, user: proxyConfig.username, pass: proxyConfig.password, type: proxyConfig.type } : undefined,
          userAgent: ebUA,
        });
        loginResult    = { ok: silentRes.ok, message: silentRes.message };
        _silentCookies = silentRes.cookies;
      } catch (ebErr: any) {
        releaseSilentVerifySlot();
        verifyInFlight.delete(profileId);
        await storage.updateProfile(profile.id, { accountStatus: "pending" });
        return fail(500, `Browser verify failed: ${ebErr?.message ?? "Unknown error"}`);
      }
      releaseSilentVerifySlot();
    } else {
      // Puppeteer path — opens a visible EB session
      try {
        await getOrCreateSession(profileId, ebUA, proxyConfig, effectiveProfile.userAgentApi);
      } catch (ebErr: any) {
        verifyInFlight.delete(profileId);
        await storage.updateProfile(profile.id, { accountStatus: "pending" });
        return fail(500, `Browser failed to launch: ${ebErr?.message ?? "Unknown error"}`);
      }
      // If the user already logged in manually via the embedded browser, skip the
      // re-login entirely — browserAutoLogin clears session cookies first, which
      // causes a proxy-auth failure when the credentials are already valid.
      const existingCookies = await getSessionPageCookies(profileId);
      const alreadyLoggedIn = existingCookies.some(c => c.name === "sessionid");
      if (alreadyLoggedIn) {
        loginResult    = { ok: true, message: "Using existing EB session" };
        _silentCookies = existingCookies;
      } else {
        try {
          loginResult = await browserAutoLogin(
            profileId,
            profile.username,
            profile.password!,
            profile.twoFASecretKey || "",
          );
        } catch (loginErr: any) {
          loginResult = { ok: false, message: loginErr?.message ?? "Browser login error" };
        }
      }
    }

    // NOTE: verifyInFlight lock is intentionally NOT released here.
    // It covers the full verify flow — including getSessionPageCookies and the mobile
    // API cold-start — to prevent a second concurrent verify from starting a second
    // IgApiClient session with the same sessionid before the first one completes.
    // The lock is released at every exit point below (early returns + final response).

    // Step 3: Extract cookies and build result
    if (loginResult.ok) {
      const rawCookies = _silentCookies ?? await getSessionPageCookies(profileId);
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
        // Step 4: Build cookie string from EB session and persist it immediately.
        // Include ig_did so buildIgClient can restore the exact device identity
        // that Chrome presented to Instagram — prevents "Unrecognized device" SMS.
        const igDid = rawCookies.find(c => c.name === "ig_did")?.value;
        const cookieParts = [`sessionid=${sessionid}`];
        if (csrftoken) cookieParts.push(`csrftoken=${csrftoken}`);
        if (dsUserId)  cookieParts.push(`ds_user_id=${dsUserId}`);
        if (mid)       cookieParts.push(`mid=${mid}`);
        if (igDid)     cookieParts.push(`ig_did=${igDid}`);
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
        let apiResult: Awaited<ReturnType<typeof verifyInstagramCredentials>>;
        try {
          apiResult = await verifyInstagramCredentials(profileWithCookies);
        } catch (verifyErr: any) {
          // Unexpected throw from the mobile API layer — reset to pending so the
          // account doesn't stay stuck at "verifying" forever.
          console.error(`[verify] verifyInstagramCredentials threw for @${profile.username}:`, verifyErr);
          result = {
            ok: false,
            accountStatus: "pending",
            message: `@${profile.username} — mobile API check failed unexpectedly: ${verifyErr?.message ?? "unknown error"}. Try verifying again.`,
          };
          sendLoginDone(profileId, false, result.message ?? "");
          await storage.updateProfile(profile.id, { accountStatus: "pending" });
          verifyInFlight.delete(profileId);
          return res.status(200).json(result);
        }
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
      if (/2fa|two.factor|two_factor/i.test(msg))                       accountStatus = "2fa_verification";
      else if (/challenge|checkpoint/i.test(msg))                        accountStatus = "captcha";
      else if (/disabled/i.test(msg))                                    accountStatus = "account_disabled";
      else if (/suspended/i.test(msg))                                   accountStatus = "suspended";
      else if (/human.*verif|confirm.*human|human verification/i.test(msg)) accountStatus = "confirm_human";
      result = { ok: false, accountStatus, message: `@${profile.username} — ${msg}` };
    }

    // Signal the browser panel SSE (if the user has it open) that login is done
    sendLoginDone(profileId, result.ok, result.message);

    // If the mobile API returned "valid" but the EB detected a challenge DURING
    // this same verify flow, the challenge is the ground truth for what the user
    // will see in the browser — don't overwrite it with "valid".  The race is:
    // (1) EB navigates → challenge detected → DB set to "captcha"
    // (2) mobile API confirms session works → DB set to "valid"  ← silently wrong
    // Checking the in-memory session challengeUrl here lets (2) yield to (1).
    let finalStatus = result.accountStatus;
    if (result.accountStatus === "valid") {
      const ebChallengeUrl = getSessionChallengeUrl(profile.id);
      if (ebChallengeUrl) {
        finalStatus = "captcha";
        console.log(`[verify:${profile.id}] mobile API=valid but EB challenge active (${ebChallengeUrl.slice(0, 80)}…) — keeping status=captcha`);
      }
    }

    await storage.updateProfile(profile.id, {
      accountStatus: finalStatus,
      ...(finalStatus === "valid" ? { credentialsDirty: false } : {}),
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

    verifyInFlight.delete(profileId);
    res.json(result);
  });

  function resolveImportStatus(raw: string | undefined): string {
    const s = (raw ?? "").trim().toLowerCase().replace(/[\s-]/g, "_");
    // Map every known status value (including Jarvee labels) to an internal status.
    // Anything unrecognised stays "pending" so the account is safe to re-verify.
    const MAP: Record<string, string> = {
      valid:            "valid",
      active:           "valid",
      good:             "valid",
      ok:               "valid",
      pending:          "pending",
      unverified:       "pending",
      new:              "pending",
      verifying:        "pending",    // don't preserve in-flight states
      stopped:          "stopped",
      disabled:         "stopped",
      paused:           "stopped",
      captcha:          "captcha",
      challenge:        "captcha",
      checkpoint:       "captcha",
      locked:           "locked",
      account_locked:   "locked",
      "2fa":            "2fa_verification",
      "2fa_required":   "2fa_verification",
      "2fa_verification":"2fa_verification",
      "two_factor":     "2fa_verification",
      account_disabled: "account_disabled",
      banned:           "account_disabled",
      suspended:        "suspended",
      confirm_human:    "confirm_human",
    };
    return MAP[s] ?? "pending";
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
            // Auto-assign a paired UA when the import source (Jarvee CSV, manual entry, etc.)
            // doesn't supply one. Deterministic so the same username always gets the same
            // device profile — stable across re-imports.
            userAgentApi: p.userAgentApi || pickUAForAccount(p.username || "").api,
            userAgentEmbedded: p.userAgentEmbedded || pickUAForAccount(p.username || "").embedded,
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
            // Seed/refresh the browser cookie file if the import provided cookies
            if (igApiCookies) seedBrowserCookieFile(existing.id, igApiCookies);
            results.push({ success: true, username: profileData.username, action: "updated" });
          } else {
            const created = await storage.createProfile(profileData);
            // Seed the browser cookie file so Chrome starts with the correct device
            // identity (mid, ig_did, sessionid) on its very first launch. Without this
            // Chrome starts blank, Instagram sees a new device, and fires challenges.
            if (igApiCookies) seedBrowserCookieFile(created.id, igApiCookies);
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
      let updated = await storage.updateTool(Number(req.params.id), input);
      if (input.enabled === true) {
        if (cold) {
          // Copy-settings path: stop the existing runner and relaunch with startup wait + stagger
          req.log.info(`[copySettings] tool ${req.params.id} (${updated.type}) cold restart — stagger will apply`);
          automationEngine.restartColdWithWait(updated.profileId, updated.type);
        } else {
          // Manual toggle path: clear any block suspensions so the runner retries
          // immediately rather than waiting out the remainder of a 24/50-hour block.
          // Also clear the DB-persisted toolBlockedUntil — clearSuspensions only clears
          // the in-memory actionSuspensions map, so without this the block gate in
          // runSession reads the stale toolBlockedUntil from DB and keeps returning
          // "nothing to do" even after the user has toggled the tool back on.
          const s = (updated.settings ?? {}) as any;
          if (s.toolBlockedUntil) {
            const cleared = { ...s };
            delete cleared.toolBlockedUntil;
            updated = await storage.updateTool(updated.id, { settings: cleared });
            req.log.info(`[toggle-on] tool ${updated.id} (${updated.type}) — cleared toolBlockedUntil from DB`);
          }
          automationEngine.clearSuspensions(updated.profileId, updated.type);
          // Wake existing runner immediately (or launch fresh)
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
      if (Number(a.profileId) === 0) return { ...a, profileLabel: "Equinox" };
      const p = profileMap.get(Number(a.profileId));
      return { ...a, profileLabel: p?.accountLabel || p?.username || `#${a.profileId}` };
    });
    res.json(enriched);
  });

  app.get("/api/instagram-api-calls", async (req, res) => {
    const sinceParam = req.query.since;
    const limitParam = req.query.limit;
    const [settings, allProfiles] = await Promise.all([
      storage.getGlobalSettings(),
      storage.getProfiles(),
    ]);
    const profileMap = new Map(allProfiles.map(p => [p.id, p]));
    const logMaxRows = parseInt(settings.logMaxRows ?? "100000", 10);
    const effectiveLimit = limitParam !== undefined ? Math.min(parseInt(limitParam as string, 10) || logMaxRows, logMaxRows) : logMaxRows;
    let data: any[];
    if (sinceParam !== undefined) {
      const sinceId = parseInt(sinceParam as string, 10);
      data = isNaN(sinceId) ? [] : await storage.getInstagramApiCallsSince(sinceId, 5000);
    } else {
      data = await storage.getInstagramApiCalls(effectiveLimit);
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

  // ── GET /api/logs/server — tail of the on-disk server debug log ─────────────
  // Returns the last N lines of equinox-debug.log so the Settings page can show
  // a live tail and offer a download button without requiring DevTools or a shell.
  app.get("/api/logs/server", async (req, res) => {
    try {
      const logPath = (global as any).__SERVER_LOG_PATH as string | undefined;
      if (!logPath) {
        return res.json({ lines: [], path: null, error: "Log file path not initialised (server too old)" });
      }
      const fsSync = await import("fs");
      if (!fsSync.default.existsSync(logPath)) {
        return res.json({ lines: [], path: logPath, error: "Log file not found yet — it is created on first server startup" });
      }
      const content = fsSync.default.readFileSync(logPath, "utf8");
      const allLines = content.split("\n").filter(Boolean);
      const tailCount = Math.min(Number((req.query as any).lines ?? 500), 5000);
      const lines = allLines.slice(-tailCount);
      res.json({ lines, path: logPath, totalLines: allLines.length });
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
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

  app.get("/api/stats/abd-daily", async (_req, res) => {
    const data = await storage.getDailyAbdStats();
    res.json(data);
  });

  // Browser session endpoints
  app.post("/api/browser/:profileId/start", async (req, res) => {
    const profileId = Number(req.params.profileId);
    const profile = await storage.getProfile(profileId);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    const hasProxy = !!(profile.proxyId || (profile.proxyHost && profile.proxyPort));
    if (!hasProxy) return res.status(403).json({ error: "No proxy assigned — assign a proxy to this account before using the embedded browser." });
    // ── UA BLOCK — per USER-AGENT RULE ─────────────────────────────────────────
    if (!profile.userAgentEmbedded) {
      return res.status(403).json({ error: "No EB User-Agent configured for this account. Assign a unique User-Agent before opening the embedded browser." });
    }
    const ua = profile.userAgentEmbedded as string;
    try {
      await getOrCreateSession(profileId, ua, await resolveProxyConfig(profile), profile.userAgentApi);
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
      .then(async loginResult => {
        if (!loginResult.ok) {
          sendLoginDone(profileId, false, loginResult.message);
          // Classify the failure and persist status
          const msg = loginResult.message ?? "";
          let accountStatus = "locked";
          if (/2fa|two.factor|two_factor/i.test(msg))                       accountStatus = "2fa_verification";
          else if (/challenge|checkpoint/i.test(msg))                        accountStatus = "captcha";
          else if (/disabled/i.test(msg))                                    accountStatus = "account_disabled";
          else if (/suspended/i.test(msg))                                   accountStatus = "suspended";
          else if (/human.*verif|confirm.*human|human verification/i.test(msg)) accountStatus = "confirm_human";
          await storage.updateProfile(profileId, { accountStatus }).catch(() => {});
          return;
        }

        // EB login succeeded — extract and persist cookies so the session is
        // available for the Verify flow.  We deliberately do NOT call
        // verifyInstagramCredentials here and do NOT touch accountStatus.
        // The only path that may set accountStatus="valid" is the explicit
        // Verify flow (/api/profiles/:id/verify or /api/profiles/verify-all).
        const rawCookies = await getSessionPageCookies(profileId);
        const sessionid = rawCookies.find(c => c.name === "sessionid")?.value;
        const csrftoken = rawCookies.find(c => c.name === "csrftoken")?.value;
        const dsUserId  = rawCookies.find(c => c.name === "ds_user_id")?.value;
        const mid       = rawCookies.find(c => c.name === "mid")?.value;
        const igDid     = rawCookies.find(c => c.name === "ig_did")?.value;

        if (!sessionid) {
          sendLoginDone(profileId, false, `@${profile.username} — login appeared to succeed but no sessionid cookie was found. Try again.`);
          return;
        }

        const cookieParts = [`sessionid=${sessionid}`];
        if (csrftoken) cookieParts.push(`csrftoken=${csrftoken}`);
        if (dsUserId)  cookieParts.push(`ds_user_id=${dsUserId}`);
        if (mid)       cookieParts.push(`mid=${mid}`);
        if (igDid)     cookieParts.push(`ig_did=${igDid}`);
        const freshCookies = cookieParts.join("; ");

        await storage.updateProfile(profileId, { igApiCookies: freshCookies }).catch(() => {});

        sendLoginDone(profileId, true, `@${profile.username} — logged in via embedded browser. Click Verify Credentials to confirm the session.`);
      })
      .catch(err => sendLoginDone(profileId, false, String(err)));
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
    // Clear-session is a cleanup operation — allow it even when UA is unset so
    // a stuck session can always be wiped.  Log a warning so it is visible.
    if (profile && !profile.userAgentEmbedded) {
      console.warn(`[UA-WARN] profile ${profileId} has no userAgentEmbedded — clear-session proceeding with fallback UA (cleanup only, no Instagram connection made here)`);
    }
    const ua = profile ? ((profile.userAgentEmbedded as string | null) || DESKTOP_BROWSER_UA) : DESKTOP_BROWSER_UA;
    await clearSession(profileId, ua, proxy);
    res.json({ ok: true });
  });

  // ── EB diagnostic endpoint — hit this from the app to get a full debug report ──
  // Returns JSON: CHROMIUM_PATH, whether it exists, Node.js version, platform, etc.
  // Real-time account status stream — frontend subscribes here and immediately
  // invalidates its React Query cache when the engine (or any route) changes
  // an account's accountStatus in the DB, so the status pill updates without
  // waiting for the 5-second poll.
  app.get("/api/events/status", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const onChange = (data: { profileId: number; accountStatus: string }) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    statusEvents.on("change", onChange);

    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25_000);

    req.on("close", () => {
      statusEvents.off("change", onChange);
      clearInterval(heartbeat);
    });
  });

  app.get("/api/browser/leaks", async (req, res) => {
    const profileId = Number(req.query.profileId) || 0;
    let title = "EQUINOX LEAK TEST";

    type AccountData = {
      proxy: string | null;
      proxyHost: string | null;
      proxyPort: number | null;
      proxyType: string | null;
      proxyHasCredentials: boolean;
      ebUA: string | null;
      apiUA: string | null;
      sessionResolvedProxy: string | null;
      sessionProxyRules: string | null;
      sessionStoredProxy: { host: string; port: number; type: string; hasCredentials: boolean; user: string | null } | null;
    };
    const accountData: AccountData = {
      proxy: null, proxyHost: null, proxyPort: null,
      proxyType: null, proxyHasCredentials: false,
      ebUA: null, apiUA: null,
      sessionResolvedProxy: null, sessionProxyRules: null, sessionStoredProxy: null,
    };

    if (profileId) {
      try {
        const profile = await storage.getProfile(profileId);
        if (profile) {
          if (profile.username) title = `${profile.username.toUpperCase()} LEAK TEST`;
          accountData.ebUA  = profile.userAgentEmbedded || null;
          accountData.apiUA = profile.userAgentApi || null;

          // Resolve proxy: prefer the profile's own proxyHost, fall back to linked proxy table
          let proxyHost: string | null = profile.proxyHost || null;
          let proxyPort: number | null = profile.proxyPort || null;
          let proxyType: string | null = profile.proxyType || null;
          let proxyUsername: string | null = profile.proxyUsername || null;
          let proxyPassword: string | null = profile.proxyPassword || null;

          if ((!proxyHost) && profile.proxyId) {
            try {
              const [proxy] = await db.select().from(proxies).where(eq(proxies.id, profile.proxyId));
              if (proxy) {
                proxyHost     = proxy.host;
                proxyPort     = proxy.port;
                proxyType     = (proxy as any).proxyType || null;
                proxyUsername = (proxy as any).username  || null;
                proxyPassword = (proxy as any).password  || null;
              }
            } catch {}
          }

          if (proxyHost) {
            accountData.proxyHost           = proxyHost;
            accountData.proxyPort           = proxyPort;
            accountData.proxyType           = proxyType || "http";
            accountData.proxyHasCredentials = !!(proxyUsername && proxyPassword);
            accountData.proxy               = proxyPort ? `${proxyHost}:${proxyPort}` : proxyHost;
          }
        }
      } catch {}
    }

    // For the Ghost Browser (profileId=-1) there is no DB record, so the proxy
    // and UA are passed directly as query params by the ebManager leak-check
    // toolbar command (which reads them from the live ebMap entry / webContents).
    const qProxyHost = ((req.query.proxyHost as string | undefined) ?? "").trim() || null;
    const qProxyPort = req.query.proxyPort ? Number(req.query.proxyPort) : null;
    if (qProxyHost && qProxyPort && !accountData.proxyHost) {
      accountData.proxyHost = qProxyHost;
      accountData.proxyPort = qProxyPort;
      accountData.proxy = `${qProxyHost}:${qProxyPort}`;
    }
    // Pick up the live browser UA passed from ebManager (used by Ghost and any
    // profile whose DB row has no userAgentEmbedded yet).
    const qEbUA = ((req.query.ebUA as string | undefined) ?? "").trim() || null;
    if (qEbUA && !accountData.ebUA) {
      accountData.ebUA = qEbUA;
    }

    // Fetch session resolve-proxy from the Electron IPC server.
    // This tells us what Electron's routing engine ACTUALLY routes through —
    // confirming whether the proxy session config was applied correctly.
    const ipcPort = Number(process.env.EB_IPC_PORT ?? 0);
    if (ipcPort && (profileId || qProxyHost)) {
      try {
        const pid = profileId || -1;
        const r = await fetch(
          `http://127.0.0.1:${ipcPort}/eb/resolve-proxy?profileId=${pid}&url=https://api.ipify.org/`,
          { signal: AbortSignal.timeout(3000) },
        );
        if (r.ok) {
          const d = await r.json();
          accountData.sessionResolvedProxy = d.resolved   ?? null;
          accountData.sessionProxyRules    = d.proxyRules ?? null;
          accountData.sessionStoredProxy   = d.storedProxy ?? null;
        }
      } catch {}
    }

    const html = LEAKS_PAGE_HTML
      .replace("__LEAK_TEST_TITLE__", title)
      .replace("__ACCOUNT_DATA__", JSON.stringify(accountData));

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  });

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

  // WebSocket stream for real-time browser frames.
  // WebSocket connections use a separate socket pool in Chromium and do NOT count
  // against the 6-connection-per-origin HTTP/1.1 limit, so 10+ EBs can be open
  // simultaneously without blocking click/input POST requests.
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", async (request, socket, head) => {
    const url = new URL(request.url ?? "", `http://localhost`);

    // ── Signup browser live stream ─────────────────────────────────────────────
    if (url.pathname === "/api/signup/browser/stream") {
      wss.handleUpgrade(request, socket, head, async (ws) => {
        ws.on("close", () => { detachSignupWS(ws); });
        await attachSignupWS(ws);
      });
      return;
    }

    const match = url.pathname.match(/^\/api\/browser\/(\d+)\/stream$/);
    if (!match) {
      socket.destroy();
      return;
    }
    const profileId = Number(match[1]);

    const profile = await storage.getProfile(profileId).catch(() => null);
    if (!profile) { socket.destroy(); return; }

    const hasProxy = !!(profile.proxyId || (profile.proxyHost && profile.proxyPort));
    if (!hasProxy) {
      // Send a WS close with an error message then destroy the socket
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.send(JSON.stringify({ type: "error", message: "No proxy assigned — assign a proxy to this account before using the embedded browser." }));
        ws.close();
      });
      return;
    }

    wss.handleUpgrade(request, socket, head, async (ws) => {
      // Register the close handler IMMEDIATELY — before any async work.
      // If the socket closes while Chrome is still launching (which can take
      // 20-30 s), detachWS must still fire so the session is not left pointing
      // at a dead WebSocket.  Registering it after the await would miss any
      // close event that fires during the await.
      ws.on("close", () => {
        detachWS(profileId, ws);
      });

      try {
        const proxy = await resolveProxyConfig(profile);
        // ── UA BLOCK — per USER-AGENT RULE ────────────────────────────────────
        if (!profile.userAgentEmbedded) {
          ws.send(JSON.stringify({ type: "error", message: "No EB User-Agent configured for this account. Assign a unique User-Agent before opening the embedded browser." }));
          ws.close();
          return;
        }
        const ua = profile.userAgentEmbedded as string;
        await getOrCreateSession(profileId, ua, proxy, profile.userAgentApi);

        // ── Dedup guard: prevent reconnect-loop displacement ──────────────
        // A bug in old client code creates a feedback loop: ws1 is kicked by
        // ws2's attachWS → ws1.onclose → 3 s timer → ws3 kicks ws2 → repeat.
        // Fix: if the session already has an open WS (from a previous attach in
        // this same burst), reject the incoming WS without kicking the active
        // one.  The active WS is never displaced, so its onclose never fires
        // and the loop has nothing to feed on.  Legitimate reconnects (after a
        // real disconnect) are accepted because detachWS nulls session.ws when
        // the active connection closes.
        if (hasActiveWS(profileId)) {
          try {
            ws.send(JSON.stringify({ type: "already-connected" }));
            ws.close();
          } catch {}
          return;
        }

        attachWS(profileId, ws);
        // Auto-login: if the page settles on the login form, fill credentials
        // without any manual button press. scheduleAutoLogin waits 3.5 s for the
        // initial navigation to complete, then checks the URL and fires only if
        // Chrome is on the login page AND credentials exist.
        if (profile.username && profile.password) {
          scheduleAutoLogin(
            profileId,
            profile.username,
            profile.password,
            (profile.twoFASecretKey as string | null) || "",
          );
        }
      } catch (err: any) {
        ws.send(JSON.stringify({ type: "error", message: err?.message || "Failed to start browser" }));
        ws.close();
        return;
      }
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
        case "fill2fa":    await browserFill2fa(profileId, msg.code ?? ""); break;
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // Signup browser input — routes mouse/keyboard/nav commands to the signup Puppeteer page
  // (only used in non-Electron / Puppeteer-screencast mode)
  app.post("/api/signup/browser/input", async (req, res) => {
    try {
      await signupBrowserInput(req.body as any);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── Is-Electron probe — used by the frontend to decide which UI to show ──
  app.get("/api/is-electron", (_req, res) => {
    res.json({ electron: !!process.env.EB_IPC_PORT });
  });

  // Open the standalone signup / Ghost browser.
  // In Electron: opens profileId=-1 as a native detached BrowserWindow (same as
  //              every other account EB — no embedded screencast).
  // Otherwise:   falls back to the Puppeteer + CDP screencast pipeline.
  app.post("/api/signup/browser/open", async (req, res) => {
    const ipcPort = Number(process.env.EB_IPC_PORT ?? 0);
    if (ipcPort) {
      try {
        const { proxyHost, proxyPort, proxyUsername, proxyPassword, proxyType, userAgent, fingerprint } = req.body as any;
        const body = {
          profileId: -1,
          username: "Ghost",
          proxy: proxyHost && proxyPort
            ? { host: proxyHost, port: Number(proxyPort), user: proxyUsername ?? undefined, pass: proxyPassword ?? undefined, type: (proxyType ?? "http") as "http" | "socks5" }
            : undefined,
          userAgent: userAgent ?? undefined,
          ebFingerprint: fingerprint ?? undefined,
        };
        await fetch(`http://127.0.0.1:${ipcPort}/eb/open`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(body),
        });
        return res.json({ ok: true });
      } catch (err: any) {
        return res.status(500).json({ ok: false, error: err?.message });
      }
    }
    // Non-Electron: Puppeteer screencast
    try {
      const { proxyHost, proxyPort, proxyUsername, proxyPassword, userAgent } = req.body as any;
      const result = await openSignupBrowser({ proxyHost, proxyPort, proxyUsername, proxyPassword, userAgent });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message });
    }
  });

  // Status check — lets the frontend detect a running browser after a page reload
  app.get("/api/signup/browser/status", async (_req, res) => {
    const ipcPort = Number(process.env.EB_IPC_PORT ?? 0);
    if (ipcPort) {
      try {
        const r = await fetch(`http://127.0.0.1:${ipcPort}/eb/state?profileId=-1`);
        const data = await r.json().catch(() => ({ open: false })) as any;
        return res.json({ running: !!data.open, native: true });
      } catch {
        return res.json({ running: false, native: true });
      }
    }
    res.json({ running: isSignupBrowserOpen(), native: false });
  });

  // Close the standalone signup / Ghost browser
  app.post("/api/signup/browser/close", async (_req, res) => {
    const ipcPort = Number(process.env.EB_IPC_PORT ?? 0);
    if (ipcPort) {
      try {
        await fetch(`http://127.0.0.1:${ipcPort}/eb/close`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ profileId: -1 }),
        });
        return res.json({ ok: true });
      } catch (err: any) {
        return res.status(500).json({ ok: false, error: err?.message });
      }
    }
    try {
      await closeSignupBrowser();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message });
    }
  });

  // Reset signup / Ghost browser — wipe session so next open is a fresh device identity
  app.post("/api/signup/browser/reset", async (_req, res) => {
    const ipcPort = Number(process.env.EB_IPC_PORT ?? 0);
    if (ipcPort) {
      try {
        await fetch(`http://127.0.0.1:${ipcPort}/eb/wipe`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ profileId: -1 }),
        });
        return res.json({ ok: true });
      } catch (err: any) {
        return res.status(500).json({ ok: false, error: err?.message });
      }
    }
    try {
      await resetSignupBrowser();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message });
    }
  });

  // ── Ghost Browser warm-up step/done relay endpoints (called by Electron ebManager) ──
  // The Electron IPC ghost-warmup handler runs asynchronously and POSTs progress
  // here so the frontend WebSocket receives signupStep / warmupDone messages.
  app.post("/api/signup/browser/warmup-step", (req, res) => {
    const { msg } = req.body as { msg?: string };
    if (msg) sendSignupWsMsg({ type: "signupStep", msg });
    res.json({ ok: true });
  });

  app.post("/api/signup/browser/warmup-done", (_req, res) => {
    sendSignupWsMsg({ type: "warmupDone" });
    res.json({ ok: true });
  });

  // ── Ghost Browser warm-up: runs warmupSignupSession on the open _signupPage ──
  app.post("/api/signup/browser/warmup", async (req, res) => {
    const ipcPort = Number(process.env.EB_IPC_PORT ?? 0);
    if (ipcPort) {
      // Desktop (Electron) mode — forward the warmup config to the Electron main
      // process which runs it on the native Ghost BrowserWindow.
      // Progress arrives back via /api/signup/browser/warmup-step and warmup-done.
      try {
        await fetch(`http://127.0.0.1:${ipcPort}/eb/ghost-warmup`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(req.body),
        });
      } catch {
        sendSignupWsMsg({ type: "signupStep", msg: "Warm-up error: could not reach Electron process." });
        sendSignupWsMsg({ type: "warmupDone" });
      }
      res.json({ ok: true });
      return;
    }
    if (!isSignupBrowserOpen()) {
      return res.status(400).json({ ok: false, error: "Ghost Browser is not open" });
    }
    const {
      reelsMin, reelsMax, postsMin, postsMax, profilesMin, profilesMax,
      reelsIdleMin, reelsIdleMax, postsIdleMin, postsIdleMax, profilesIdleMin, profilesIdleMax,
      postClicksPerProfileMin, postClicksPerProfileMax, postBrowseTimeMin, postBrowseTimeMax,
    } = req.body as {
      reelsMin?: number; reelsMax?: number;
      postsMin?: number; postsMax?: number;
      profilesMin?: number; profilesMax?: number;
      reelsIdleMin?: number; reelsIdleMax?: number;
      postsIdleMin?: number; postsIdleMax?: number;
      profilesIdleMin?: number; profilesIdleMax?: number;
      postClicksPerProfileMin?: number; postClicksPerProfileMax?: number;
      postBrowseTimeMin?: number; postBrowseTimeMax?: number;
    };
    res.json({ ok: true });
    (async () => {
      try {
        await runWarmupOnOpenBrowser({
          reelsMin, reelsMax, postsMin, postsMax, profilesMin, profilesMax,
          reelsIdleMin, reelsIdleMax, postsIdleMin, postsIdleMax, profilesIdleMin, profilesIdleMax,
          postClicksPerProfileMin, postClicksPerProfileMax, postBrowseTimeMin, postBrowseTimeMax,
          onStep: (msg) => sendSignupWsMsg({ type: "signupStep", msg }),
        });
        sendSignupWsMsg({ type: "warmupDone" });
      } catch (e: any) {
        sendSignupWsMsg({ type: "signupStep", msg: `Warm-up error: ${e?.message ?? "unknown"}` });
        sendSignupWsMsg({ type: "warmupDone" });
      }
    })().catch(() => {});
  });

  // ── EB form automation: fire-and-forget; results arrive via WS signupStep/signupDone/signupPaused ──
  app.post("/api/signup/browser/automate", async (req, res) => {
    const { email, password, username, firstName, dob, userAgent,
            proxyHost, proxyPort, proxyUsername, proxyPassword } = req.body as {
      email: string; password: string; username: string; firstName?: string;
      dob?: { day: number; month: number; year: number };
      userAgent?: string;
      proxyHost?: string; proxyPort?: number;
      proxyUsername?: string; proxyPassword?: string;
    };
    if (!proxyHost || !proxyPort) {
      return res.status(400).json({ ok: false, error: "A proxy is required for EB account creation" });
    }
    // Acknowledge immediately — result arrives via WebSocket
    res.json({ ok: true });

    (async () => {
      try {
        const result = await createInstagramAccountViaEBForm({
          email, password, username,
          firstName: firstName ?? "",
          month: dob?.month ?? 6,
          day:   dob?.day   ?? 15,
          year:  dob?.year  ?? 1995,
          proxyHost, proxyPort, proxyUsername, proxyPassword,
          userAgent,
          onStep: (msg) => sendSignupWsMsg({ type: "signupStep", msg }),
        });

        if (result.status === "email_verification" || result.status === "phone_verification") {
          if (result.sessionId) storePendingAutomateSession(result.sessionId);
          sendSignupWsMsg({ type: "signupPaused", message: result.message });
        } else {
          sendSignupWsMsg({ type: "signupDone", status: result.status, message: result.message });
        }
      } catch (e: any) {
        sendSignupWsMsg({ type: "signupDone", status: "error", message: e?.message ?? "Automation error" });
      }
    })().catch(() => {});
  });

  // ── EB form automation continue: submit the email/phone verification code ──
  app.post("/api/signup/browser/automate-continue", async (req, res) => {
    const { code } = req.body as { code: string };
    if (!code) return res.status(400).json({ ok: false, error: "code is required" });

    const sessionId = consumePendingAutomateSession();
    if (!sessionId) return res.status(400).json({ ok: false, error: "No pending EB signup session — it may have expired" });

    res.json({ ok: true });

    (async () => {
      try {
        const result = await submitSignupCodeViaEB(sessionId, code);
        // Forward the last few step messages so they appear in the UI
        for (const msg of result.steps.slice(-5)) {
          sendSignupWsMsg({ type: "signupStep", msg });
        }
        sendSignupWsMsg({ type: "signupDone", status: result.status, message: result.message });
      } catch (e: any) {
        sendSignupWsMsg({ type: "signupDone", status: "error", message: e?.message ?? "Code submission error" });
      }
    })().catch(() => {});
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

    // Run verification in background so the response is immediate.
    // All eligible accounts are verified in parallel — no delays, no queuing.
    res.json({ ok: true, total: eligible.length, skippedNoProxy });

    const verifyOne = async (profile: typeof eligible[0]) => {
      // Skip accounts already being verified by a concurrent single-verify call
      if (verifyInFlight.has(profile.id)) return;
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
        // ── UA BLOCK — per USER-AGENT RULE ────────────────────────────────────
        if (!effectiveP.userAgentEmbedded) {
          bulkResults.push({ id: profile.id, username: profile.username, status: "error", message: "No EB User-Agent configured — skipped to avoid fingerprint leak." });
          return;
        }
        const bulkEbUA = effectiveP.userAgentEmbedded as string;

        // Steps 1-2: Launch EB + auto-login (silent in Electron, visible in Puppeteer)
        let bulkLoginResult: { ok: boolean; message: string };
        let _bulkSilentCookies: Array<{ name: string; value: string }> | null = null;

        if (process.env.EB_IPC_PORT) {
          // Acquire the global slot — queues if another silent verify is already
          // in progress (from the single-account verify button or another bulk run).
          await acquireSilentVerifySlot();
          try {
            const silentRes = await electronSilentVerify({
              profileId: profile.id,
              username:  profile.username,
              password:  profile.password!,
              twoFAKey:  profile.twoFASecretKey || "",
              proxy:     bulkProxyConfig ? { host: bulkProxyConfig.host, port: bulkProxyConfig.port, user: bulkProxyConfig.username, pass: bulkProxyConfig.password } : undefined,
              userAgent: bulkEbUA,
            });
            bulkLoginResult    = { ok: silentRes.ok, message: silentRes.message };
            _bulkSilentCookies = silentRes.cookies;
          } catch (ebErr: any) {
            bulkLoginResult = { ok: false, message: ebErr?.message ?? "Browser verify failed" };
          } finally {
            releaseSilentVerifySlot();
          }
        } else {
          await getOrCreateSession(profile.id, bulkEbUA, bulkProxyConfig, effectiveP.userAgentApi);
          // Skip re-login if the browser already has a valid session
          const existingBulkCookies = await getSessionPageCookies(profile.id);
          const bulkAlreadyLoggedIn = existingBulkCookies.some(c => c.name === "sessionid");
          if (bulkAlreadyLoggedIn) {
            bulkLoginResult    = { ok: true, message: "Using existing EB session" };
            _bulkSilentCookies = existingBulkCookies;
          } else {
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
          }
        }

        // Step 3: Extract cookies and build result
        let result: { ok: boolean; message: string; accountStatus: string; igApiCookies?: string; checkpointUrl?: string };
        if (bulkLoginResult.ok) {
          const rawCookies = _bulkSilentCookies ?? await getSessionPageCookies(profile.id);
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
    };

    // Run accounts sequentially with a random delay between each so Instagram
    // doesn't see a burst of logins from the same server IP at once.
    (async () => {
      for (let idx = 0; idx < eligible.length; idx++) {
        await verifyOne(eligible[idx]);
        if (idx < eligible.length - 1) {
          const delaySec = delayMin + Math.random() * Math.max(0, delayMax - delayMin);
          await new Promise(r => setTimeout(r, Math.round(delaySec * 1000)));
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

  // ── Manual Fix: dismiss Automated Behaviour Detected warning ─────────────
  app.post("/api/profiles/:id/fix-abd", async (req, res) => {
    const profileId = Number(req.params.id);
    try {
      const result = await automationEngine.dismissABDForProfile(profileId);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ ok: false, message: e?.message ?? "Fix ABD failed" });
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
      // Preserve the exported accountStatus — if an account was valid with cookies,
      // it should import as valid.  Only reset transient states that can't survive
      // being written to a file (e.g. "verifying" means a live in-progress check).
      if (cleanProfile.accountStatus === "verifying") {
        cleanProfile.accountStatus = "pending";
      }

      // When an account was exported from a Proxy Manager-linked profile, the
      // profile's own proxyHost is null and the proxy lives in resolvedProxy*
      // fields added by buildEqxPayload.  Map those back to the direct columns
      // so the proxy survives the import.  Also clear proxyId — it's a local DB
      // reference that means nothing on the importing machine.
      if (!cleanProfile.proxyHost && (cleanProfile as any).resolvedProxyHost) {
        cleanProfile.proxyHost     = (cleanProfile as any).resolvedProxyHost  ?? null;
        cleanProfile.proxyPort     = Number((cleanProfile as any).resolvedProxyPort) || null;
        cleanProfile.proxyUsername = (cleanProfile as any).resolvedProxyUsername ?? null;
        cleanProfile.proxyPassword = (cleanProfile as any).resolvedProxyPassword ?? null;
      }
      cleanProfile.proxyId = null;

      // Save the intended status BEFORE createProfile, because Drizzle's SQLite
      // dialect can silently fall back to the column's SQL DEFAULT ('pending') when
      // the value arrives via an object spread rather than an explicit named key.
      // The updateProfile call below is the authoritative write that bypasses that.
      const intendedStatus: string = cleanProfile.accountStatus ?? "pending";

      // Auto-assign UAs if the EQX file was exported before UAs were tracked
      // (older exports) or if the account never had one assigned.
      if (!cleanProfile.userAgentEmbedded || !cleanProfile.userAgentApi) {
        const autoUA = pickUAForAccount(cleanProfile.username || "");
        if (!cleanProfile.userAgentEmbedded) cleanProfile.userAgentEmbedded = autoUA.embedded;
        if (!cleanProfile.userAgentApi)      cleanProfile.userAgentApi      = autoUA.api;
      }

      const created = await storage.createProfile(cleanProfile);

      // Force the correct accountStatus and credentialsDirty with an unconditional
      // UPDATE.  We cannot rely on the RETURNING value from the INSERT — Drizzle's
      // SQLite dialect may apply column SQL defaults ("pending" / true) even when
      // explicit values were provided via object spread.
      // credentialsDirty is always reset to false on import: the imported credentials
      // are exactly as they were at export time, so they are not dirty and the account
      // must not show a spurious "Verify" button next to a valid status.
      await storage.updateProfile(created.id, {
        accountStatus: intendedStatus,
        credentialsDirty: false,
      });
      (created as any).accountStatus = intendedStatus;
      (created as any).credentialsDirty = false;

      // Seed the browser cookie file so Chrome starts with the correct device
      // identity (mid, ig_did, sessionid) on its very first launch.
      if (cleanProfile.igApiCookies && typeof cleanProfile.igApiCookies === "string") {
        seedBrowserCookieFile(created.id, cleanProfile.igApiCookies);
      }

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
        detail: `Account @${created.username} imported`,
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

  // ── Jarvee binary account file import ────────────────────────────────────
  // Accepts the raw binary as base64.  Decodes, XOR-reverses, parses the
  // .NET BinaryFormatter stream, and creates one profile per account found.

  app.post("/api/profiles/import-jarvee", async (req, res) => {
    try {
      const { fileBase64 } = req.body as { fileBase64?: string };
      if (!fileBase64) return res.status(400).json({ error: "fileBase64 is required" });

      let buf: Buffer;
      try { buf = Buffer.from(fileBase64, "base64"); }
      catch { return res.status(400).json({ error: "Invalid base64 data" }); }

      const { parseJarveeBinary } = await import("../instagram/jarveeParser.js");
      let jarveeAccounts: Awaited<ReturnType<typeof parseJarveeBinary>>;
      try {
        jarveeAccounts = parseJarveeBinary(buf);
      } catch (e: any) {
        return res.status(400).json({ error: e?.message ?? "Failed to parse Jarvee file" });
      }

      if (jarveeAccounts.length === 0) {
        return res.status(400).json({ error: "No accounts found in this Jarvee file" });
      }

      const results: { username: string; ok: boolean; error?: string }[] = [];

      for (const ja of jarveeAccounts) {
        try {
          const autoUA = pickUAForAccount(ja.username);
          const igDeviceState = ja.deviceString
            ? JSON.stringify({ deviceString: ja.deviceString })
            : null;

          let proxyStr: string | null = null;
          if (ja.proxyHost && ja.proxyPort) {
            const auth = ja.proxyUsername
              ? `${encodeURIComponent(ja.proxyUsername)}${ja.proxyPassword ? `:${encodeURIComponent(ja.proxyPassword)}` : ""}@`
              : "";
            proxyStr = `http://${auth}${ja.proxyHost}:${ja.proxyPort}`;
          }

          const profileData: any = {
            username:                ja.username,
            password:                ja.password,
            accountLabel:            ja.accountLabel ?? null,
            proxyHost:               ja.proxyHost    ?? null,
            proxyPort:               ja.proxyPort    ?? null,
            proxyUsername:           ja.proxyUsername ?? null,
            proxyPassword:           ja.proxyPassword ?? null,
            accountStatus:           "pending",
            // Jarvee's web UA is a Chrome mobile UA — use it for the embedded browser.
            // The mobile API UA is a separate Instagram-app UA that auto-assign handles.
            userAgentEmbedded:       ja.userAgentWeb ?? autoUA.embedded,
            userAgentApi:            autoUA.api,
            igDeviceState:           igDeviceState,
            twoFASecretKey:          ja.twoFASecret ?? null,
            emailValidationUsername: ja.email ?? null,
            emailValidationPassword: ja.emailPassword ?? null,
            notes:                   "Imported from Jarvee",
          };

          if (proxyStr) profileData.proxy = proxyStr;

          const created = await storage.createProfile(profileData);
          await storage.updateProfile(created.id, { accountStatus: "pending", credentialsDirty: false });

          // ── Restore follow tool sources ──────────────────────────────────
          if (ja.followSources.length > 0) {
            try {
              const tools = await storage.getToolsByProfile(created.id);
              const followTool = tools.find(t => t.type === "follow");
              if (followTool) {
                await storage.createSourcesBulk(
                  ja.followSources.map(src => ({
                    toolId:        followTool.id,
                    type:          "target_followers",
                    value:         src,
                    rank:          null,
                    nrPosts:       null,
                    targetUserId:  "",
                    hashtagCursor: "",
                  }))
                );
              }
            } catch (e) {
              req.log.warn({ err: e }, "import-jarvee: failed to restore follow sources (non-fatal)");
            }
          }

          // ── Restore followed users list (dedup) ──────────────────────────
          const now = new Date().toISOString();
          if (ja.followedUsernames.length > 0) {
            try {
              await storage.bulkImportFollowedUsers(
                created.id,
                ja.followedUsernames.map(u => ({
                  username:   u,
                  userId:     "",
                  followedAt: now,
                }))
              );
            } catch (e) {
              req.log.warn({ err: e }, "import-jarvee: failed to restore followed users (non-fatal)");
            }
          }

          // ── Restore DM recipients as already-contacted users ─────────────
          if (ja.dmRecipients.length > 0) {
            try {
              await storage.bulkImportFollowedUsers(
                created.id,
                ja.dmRecipients.map(u => ({
                  username:   u,
                  userId:     "",
                  followedAt: now,
                  sourceType: "dm",
                }))
              );
            } catch (e) {
              req.log.warn({ err: e }, "import-jarvee: failed to restore DM recipients (non-fatal)");
            }
          }

          results.push({
            username:         ja.username,
            ok:               true,
            sourcesImported:  ja.followSources.length,
            followedImported: ja.followedUsernames.length,
            dmRecipients:     ja.dmRecipients.length,
          } as any);
        } catch (e: any) {
          results.push({ username: ja.username, ok: false, error: e?.message ?? "Failed to create profile" });
        }
      }

      const ok  = results.filter(r => r.ok);
      const bad = results.filter(r => !r.ok);
      return res.json({
        imported: ok.length,
        failed:   bad.length,
        accounts: results,
      });
    } catch (e: any) {
      req.log.error({ err: e }, "import-jarvee failed");
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
      const { userAgentApi, userAgentEb, apiLimits } = req.body as { userAgentApi?: string; userAgentEb?: string; apiLimits?: object };

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

      // ── EB-FIRST: harvest real Chrome cookies — REQUIRED, no fallback ────────
      // The EB-FIRST rule is non-negotiable: every Instagram API call must originate
      // from a real browser session.  If the EB harvest fails, the signup is aborted.
      // There is no fallback to randomly generated device IDs.
      const harvestSteps: string[] = [];
      harvestSteps.push("EB: launching temporary Chrome to harvest Instagram cookies (mid, ig_did, csrftoken)...");
      req.log.info({ username }, "signup: starting EB cookie harvest");
      let ebCookies: Awaited<ReturnType<typeof harvestSignupCookiesFromEB>>;
      try {
        ebCookies = await harvestSignupCookiesFromEB({
          proxyHost:     proxyHost,
          proxyPort:     proxyPort ? Number(proxyPort) : undefined,
          proxyUsername: proxyUsername,
          proxyPassword: proxyPassword,
          userAgent:     userAgentEb || undefined,
        });
      } catch (e: any) {
        const msg = `EB cookie harvest failed: ${e?.message}`;
        req.log.error({ username, err: e?.message }, `signup: ${msg}`);
        harvestSteps.push(`EB: ${msg}`);
        harvestSteps.push("Signup aborted — cannot create account without browser-originated cookies.");
        await storage.updateApiCreatedAccount(dbRecord.id, {
          status: "error",
          instagramUserId: null,
          sessionCookies: null,
          errorMessage: msg,
          steps: JSON.stringify(harvestSteps),
        });
        return res.json({ status: "error", message: msg, steps: harvestSteps, dbId: dbRecord.id });
      }

      if (!ebCookies?.ig_did) {
        const msg = "EB cookie harvest returned no device cookies (mid/ig_did missing) — Chrome may be blocked by the proxy or Instagram's CDN did not set cookies. Signup aborted.";
        req.log.error({ username }, `signup: ${msg}`);
        harvestSteps.push(`EB: ${msg}`);
        await storage.updateApiCreatedAccount(dbRecord.id, {
          status: "error",
          instagramUserId: null,
          sessionCookies: null,
          errorMessage: msg,
          steps: JSON.stringify(harvestSteps),
        });
        return res.json({ status: "error", message: msg, steps: harvestSteps, dbId: dbRecord.id });
      }

      harvestSteps.push(
        `EB: harvested mid=${ebCookies.mid.slice(0, 8)}... ig_did=${ebCookies.ig_did.slice(0, 8)}...` +
        ` csrftoken=${ebCookies.csrftoken ? ebCookies.csrftoken.slice(0, 8) + "..." : "(none)"}` +
        ` (${ebCookies.cookieStrings.length} cookies total) ✓`
      );
      harvestSteps.push(`EB agent: ${ebCookies.ebUserAgent}`);
      req.log.info({ username, mid: ebCookies.mid.slice(0, 8), ig_did: ebCookies.ig_did.slice(0, 8) }, "signup: EB cookie harvest succeeded");

      let result = await createInstagramAccountViaApi({ username, password, email, firstName, day: Number(day), month: Number(month), year: Number(year), proxyUrl, bio: bio || undefined, userAgent: userAgentApi || undefined, apiLimits: parsedApiLimits, ebCookies });
      // Prepend the EB harvest log lines so they appear first in the step log
      result = { ...result, steps: [...harvestSteps, ...result.steps] };

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

  // ── Streaming signup (SSE over POST) ─────────────────────────────────────
  // Same as /api/signup/start but streams each step as an SSE event so the
  // frontend can render a live trace panel without waiting for completion.
  app.post("/api/signup/start-stream", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    try { (res as any).flushHeaders(); } catch {}

    const sendStep = (msg: string) => {
      try { res.write(`data: ${JSON.stringify({ type: "step", msg, ts: Date.now() })}\n\n`); } catch {}
    };
    const sendDone = (result: unknown) => {
      try {
        res.write(`data: ${JSON.stringify({ type: "done", result })}\n\n`);
        res.end();
      } catch {}
    };

    try {
      const {
        username, password, email, firstName, day, month, year,
        proxyHost, proxyPort, proxyUsername, proxyPassword, bio,
        imapHost, imapPort, imapUser, imapPass,
        userAgentApi, userAgentEb, apiLimits,
        preBakeSites: _preBakeSitesRaw,
        preBakeSitesMin, preBakeSitesMax,
        preBakeScrollMin, preBakeScrollMax,
        preBakePctWebsite, preBakePctYt, preBakePctGoogle,
        preBakeYoutube, preBakeGoogle,
      } = req.body as any;

      // Parse the newline-separated site list sent from the frontend textarea
      const preBakeSitesList: string[] = _preBakeSitesRaw
        ? String(_preBakeSitesRaw).split("\n").map((s: string) => s.trim()).filter(Boolean)
        : [];

      if (!username || !password || !email || !day || !month || !year) {
        return sendDone({ status: "error", message: "username, password, email, day, month and year are required", steps: [] });
      }

      let proxyUrl: string | undefined;
      if (proxyHost) {
        const auth = proxyUsername ? `${encodeURIComponent(proxyUsername)}:${encodeURIComponent(proxyPassword ?? "")}@` : "";
        proxyUrl = `http://${auth}${proxyHost}${proxyPort ? `:${proxyPort}` : ""}`;
      }
      const dobStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const parsedApiLimits = apiLimits as { requestsMin: number; requestsMax: number; everySecondsMin: number; everySecondsMax: number } | undefined;

      const dbRecord = await storage.saveApiCreatedAccount({
        username, password, email,
        proxyHost: proxyHost ?? null, proxyPort: proxyPort ? Number(proxyPort) : null,
        proxyUsername: proxyUsername ?? null, proxyPassword: proxyPassword ?? null,
        bio: bio ?? null, imapServer: imapHost ?? null,
        imapPort: imapPort ? Number(imapPort) : null, imapPass: imapPass ?? null,
        status: "pending", instagramUserId: null, sessionCookies: null,
        errorMessage: null, steps: null, addedToAccounts: false, profileId: null,
        userAgentApi: userAgentApi ?? null, apiLimits: apiLimits ? JSON.stringify(apiLimits) : null,
        dateOfBirth: dobStr, createdAt: new Date().toISOString(),
      });

      // ── Primary: EB-form signup (fills real browser form, bypasses API spam block) ──
      sendStep("EB-form: signing up via real browser (bypasses API spam detection)...");
      let result: Awaited<ReturnType<typeof createInstagramAccountViaEBForm>> = await createInstagramAccountViaEBForm({
        username, password, email, firstName,
        day: Number(day), month: Number(month), year: Number(year),
        proxyHost, proxyPort: proxyPort ? Number(proxyPort) : undefined,
        proxyUsername, proxyPassword, userAgent: userAgentEb || undefined,
        onStep: sendStep,
      });

      // ── Fallback: API signup (only for technical/infra failures, not spam blocks) ──
      const ebTechnical = result.status === "error" && (
        (result.message ?? "").includes("Could not find") ||
        (result.message ?? "").includes("Cannot load Puppeteer") ||
        (result.message ?? "").includes("Browser launch failed") ||
        (result.message ?? "").includes("No Chromium")
      );
      if (ebTechnical) {
        sendStep(`EB-form technical failure (${result.message?.slice(0, 100)}) — falling back to mobile API with cookie harvest...`);
        const haspreBake = preBakeSitesList.length > 0 || preBakeYoutube || preBakeGoogle;
        sendStep(haspreBake
          ? "EB: launching temporary Chrome to bake cookies then harvest Instagram cookies..."
          : "EB: launching temporary Chrome to harvest Instagram cookies (mid, ig_did, csrftoken)...",
        );
        let ebCookies: Awaited<ReturnType<typeof harvestSignupCookiesFromEB>>;
        try {
          ebCookies = await harvestSignupCookiesFromEB({
            proxyHost, proxyPort: proxyPort ? Number(proxyPort) : undefined,
            proxyUsername, proxyPassword, userAgent: userAgentEb || undefined,
            preBakeSites:      preBakeSitesList.length ? preBakeSitesList : undefined,
            preBakeSitesMin:   preBakeSitesMin   ? Number(preBakeSitesMin)   : 1,
            preBakeSitesMax:   preBakeSitesMax   ? Number(preBakeSitesMax)   : 3,
            preBakeScrollMin:  preBakeScrollMin  ? Number(preBakeScrollMin)  : 5,
            preBakeScrollMax:  preBakeScrollMax  ? Number(preBakeScrollMax)  : 15,
            preBakePctWebsite: preBakePctWebsite ? Number(preBakePctWebsite) : 34,
            preBakePctYt:      preBakePctYt      ? Number(preBakePctYt)      : 33,
            preBakePctGoogle:  preBakePctGoogle  ? Number(preBakePctGoogle)  : 33,
            preBakeYoutube:    !!preBakeYoutube,
            preBakeGoogle:     !!preBakeGoogle,
            onStep:            sendStep,
          });
        } catch (e: any) {
          const msg = `EB cookie harvest failed: ${e?.message}`;
          sendStep(`EB: ${msg}`);
          await storage.updateApiCreatedAccount(dbRecord.id, {
            status: "error", instagramUserId: null, sessionCookies: null,
            errorMessage: msg, steps: JSON.stringify([msg]),
          });
          return sendDone({ status: "error", message: msg, steps: [msg], dbId: dbRecord.id });
        }
        if (!ebCookies?.ig_did) {
          const msg = "EB cookie harvest returned no device cookies — Chrome may be blocked by the proxy. Signup aborted.";
          sendStep(`EB: ${msg}`);
          await storage.updateApiCreatedAccount(dbRecord.id, {
            status: "error", instagramUserId: null, sessionCookies: null,
            errorMessage: msg, steps: JSON.stringify([msg]),
          });
          return sendDone({ status: "error", message: msg, steps: [msg], dbId: dbRecord.id });
        }
        sendStep(`EB: harvested mid=${ebCookies.mid.slice(0, 8)}... ig_did=${ebCookies.ig_did.slice(0, 8)}... ✓`);
        const apiResult = await createInstagramAccountViaApi({
          username, password, email, firstName, day: Number(day), month: Number(month), year: Number(year),
          proxyUrl, bio: bio || undefined, userAgent: userAgentApi || undefined,
          apiLimits: parsedApiLimits, ebCookies,
          onStep: sendStep,
        });
        result = {
          ...apiResult,
          steps: [
            `EB: harvested mid=${ebCookies.mid.slice(0, 8)}... ✓`,
            `EB agent: ${ebCookies.ebUserAgent}`,
            ...apiResult.steps,
          ],
        } as typeof result;
      }

      // ── IMAP auto-verify ────────────────────────────────────────────────────
      if (result.status === "email_verification" && imapHost && imapUser && imapPass && result.sessionId) {
        sendStep(`IMAP: connecting to ${imapHost}:${imapPort ?? 993} as ${imapUser}...`);
        const code = await fetchInstagramCodeFromImap({
          host: imapHost, port: Number(imapPort) || 993, user: imapUser, pass: imapPass,
        });
        if (code) {
          sendStep(`IMAP: found code ${code} — submitting`);
          const verifyResult = isEBSignupSession(result.sessionId)
            ? await submitSignupCodeViaEB(result.sessionId, code)
            : await submitSignupCode(result.sessionId, code);
          result = { ...verifyResult, steps: [...result.steps, ...verifyResult.steps] } as typeof result;
        } else {
          sendStep("IMAP: no code found within timeout — manual entry required");
        }
      }

      await storage.updateApiCreatedAccount(dbRecord.id, {
        status: result.status, instagramUserId: result.userId ?? null,
        sessionCookies: result.sessionCookies ? JSON.stringify(result.sessionCookies) : null,
        errorMessage: result.status === "error" ? (result.message ?? null) : null,
        steps: JSON.stringify(result.steps),
      });

      req.log.info({
        signup_result: result.status,
        signup_message: result.message ?? null,
        signup_steps: result.steps,
        signup_raw: (result as any).rawResponse ?? null,
      }, `signup/start-stream result: ${result.status}`);

      sendDone({ ...result, dbId: dbRecord.id });
    } catch (e: any) {
      req.log.error({ err: e }, "signup/start-stream failed");
      sendDone({ status: "error", message: e?.message ?? "Internal error", steps: [] });
    }
  });

  app.post("/api/signup/verify", async (req, res) => {
    try {
      const { sessionId, code, dbId } = req.body as { sessionId: string; code: string; dbId?: number };
      if (!sessionId || !code) return res.status(400).json({ error: "sessionId and code are required" });
      const result = isEBSignupSession(sessionId)
        ? await submitSignupCodeViaEB(sessionId, code)
        : await submitSignupCode(sessionId, code);
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

  // ── SMS-man proxy routes ───────────────────────────────────────────────────
  // These proxy sms-man.com API calls through the server so the API key is
  // never exposed in client-side network requests.

  app.post("/api/sms-man/get-number", async (req, res) => {
    try {
      const { apiKey, countryId = "0", service = "ig" } = req.body as { apiKey: string; countryId?: string; service?: string };
      if (!apiKey) return res.status(400).json({ error: "apiKey required" });
      const url = `https://api.sms-man.com/stubs/handler_api.php?action=getNumber&api_key=${encodeURIComponent(apiKey)}&country=${encodeURIComponent(countryId)}&service=${encodeURIComponent(service)}`;
      const r = await fetch(url);
      const text = await r.text();
      if (text.startsWith("ACCESS_NUMBER:")) {
        const parts = text.trim().split(":");
        const id = parts[1];
        const phone = parts[2];
        return res.json({ ok: true, id, phone });
      }
      return res.json({ ok: false, error: text.trim() });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? "Internal error" });
    }
  });

  app.get("/api/sms-man/get-sms/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { apiKey } = req.query as { apiKey: string };
      if (!apiKey) return res.status(400).json({ error: "apiKey required" });
      const url = `https://api.sms-man.com/stubs/handler_api.php?action=getStatus&api_key=${encodeURIComponent(apiKey)}&id=${encodeURIComponent(id)}`;
      const r = await fetch(url);
      const text = await r.text();
      if (text.startsWith("STATUS_OK:")) {
        const code = text.slice("STATUS_OK:".length).trim();
        return res.json({ ok: true, code });
      }
      return res.json({ ok: false, status: text.trim() });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? "Internal error" });
    }
  });

  app.post("/api/sms-man/cancel/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { apiKey } = req.body as { apiKey: string };
      if (!apiKey) return res.status(400).json({ error: "apiKey required" });
      const url = `https://api.sms-man.com/stubs/handler_api.php?action=setStatus&api_key=${encodeURIComponent(apiKey)}&id=${encodeURIComponent(id)}&status=8`;
      const r = await fetch(url);
      const text = await r.text();
      return res.json({ ok: text.includes("ACCESS_CANCEL"), raw: text.trim() });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? "Internal error" });
    }
  });

  // ── 5sim proxy routes ─────────────────────────────────────────────────────
  // Proxy 5sim.net API calls through the server so the API key is never
  // exposed in client-side network requests.

  app.post("/api/5sim/get-number", async (req, res) => {
    try {
      const { apiKey, country = "any" } = req.body as { apiKey: string; country?: string };
      if (!apiKey) return res.status(400).json({ error: "apiKey required" });
      const countrySlug = country === "any" ? "any" : encodeURIComponent(country);
      const url = `https://5sim.net/v1/user/buy/activation/${countrySlug}/any/instagram`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } });
      if (!r.ok) return res.json({ ok: false, error: `5sim HTTP ${r.status}` });
      const data = await r.json() as { id?: number; phone?: string; status?: string };
      if (data.id && data.phone) {
        return res.json({ ok: true, id: String(data.id), phone: data.phone.replace(/^\+/, "") });
      }
      return res.json({ ok: false, error: JSON.stringify(data) });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? "Internal error" });
    }
  });

  app.get("/api/5sim/get-sms/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { apiKey } = req.query as { apiKey: string };
      if (!apiKey) return res.status(400).json({ error: "apiKey required" });
      const url = `https://5sim.net/v1/user/check/${encodeURIComponent(id)}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } });
      if (!r.ok) return res.json({ ok: false, status: `HTTP ${r.status}` });
      const data = await r.json() as { sms?: Array<{ code?: string }>; status?: string };
      const code = data.sms?.[0]?.code;
      if (code) return res.json({ ok: true, code });
      return res.json({ ok: false, status: data.status ?? "WAIT_CODE" });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? "Internal error" });
    }
  });

  app.post("/api/5sim/cancel/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { apiKey } = req.body as { apiKey: string };
      if (!apiKey) return res.status(400).json({ error: "apiKey required" });
      const url = `https://5sim.net/v1/user/cancel/${encodeURIComponent(id)}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } });
      return res.json({ ok: r.ok });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? "Internal error" });
    }
  });

  // ── One-time startup migration: seed missing browser cookie files ─────────
  // Accounts imported before v1.0.372 have igApiCookies in the DB but no
  // browser-data/cookies-{id}.json on disk.  Chrome starts blank for these
  // accounts and Instagram fires update_risky_contactpoint on first launch.
  // Run a silent pass at startup to backfill any missing files.
  (async () => {
    try {
      const allProfiles = await storage.getProfiles();
      let seeded = 0;
      const cookiesDir = process.env.DATABASE_PATH
        ? path.join(path.dirname(process.env.DATABASE_PATH), "browser-data")
        : path.join(process.cwd(), "server", "browser-data");
      for (const p of allProfiles) {
        if (!p.igApiCookies) continue;
        const filePath = path.join(cookiesDir, `cookies-${p.id}.json`);
        if (fs.existsSync(filePath)) continue; // already seeded — skip
        seedBrowserCookieFile(p.id, p.igApiCookies as string);
        seeded++;
      }
      if (seeded > 0) {
        console.log(`[startup] Seeded browser cookie files for ${seeded} account(s) that were missing them`);
      }
    } catch (e) {
      console.warn("[startup] Cookie file backfill failed (non-fatal):", e);
    }
  })();

  // ── Trust Score Templates ────────────────────────────────────────────────────
  const TRUST_SCORE_IDS = [
    "noob", "warmup", "snail", "slug", "slow", "sloth", "tortoise", "turtle",
    "reptile", "moderate", "high", "monster", "class", "super", "outstanding",
    "ridiculous", "impossible", "overpowered", "god_level",
  ] as const;

  app.get("/api/trust-score-templates", async (_req, res) => {
    try {
      const allProfiles = await storage.getProfiles();
      const templateMap = new Map<string, number>();
      for (const p of allProfiles) {
        if (p.isTemplate && p.templateId) {
          templateMap.set(p.templateId, p.id);
        }
      }

      for (const tsId of TRUST_SCORE_IDS) {
        if (!templateMap.has(tsId)) {
          const created = await storage.createProfile({
            username: `__tpl_${tsId}__`,
            password: "template",
            isTemplate: true as any,
            templateId: tsId,
            accountStatus: "pending",
          } as any);
          templateMap.set(tsId, created.id);
        }
      }

      const result = TRUST_SCORE_IDS.map(id => ({
        trustScoreId: id,
        profileId: templateMap.get(id) ?? null,
      }));

      res.json(result);
    } catch (err) {
      console.error("[trust-score-templates] error:", err);
      res.status(500).json({ error: String(err) });
    }
  });
}
