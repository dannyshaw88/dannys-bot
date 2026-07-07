import type { Express } from "express";
import type { Server } from "http";
import { WebSocketServer } from "ws";
import crypto from "node:crypto";
import { crc32 as zlibCrc32 } from "node:zlib";
import fs from "fs";
import path from "path";
import {
  listAdapters,
  getAdapterIp,
  startAdapterProxy,
  stopAdapterProxy,
  getAdapterProxyPort,
  isAdapterRotating,
  scheduleRotation,
  clearRotation,
  stopAllAdapterProxies,
  rotateAdapter,
} from "../instagram/adapterProxy";
import { LEAKS_PAGE_HTML } from "../instagram/leaksPage";
import { storage, statusEvents } from "../storage";
import { generateEbFingerprint } from "../instagram/browserFingerprint";
import { db } from "@workspace/db";
import { proxies, tools, profiles } from "@workspace/db";
import { eq } from "drizzle-orm";
import { api } from "../shared/routes";
import { z } from "zod/v4";
import { verifyInstagramCredentials } from "../instagram/instagramLogin";
import { triggerBanPipeline } from "../instagram/banPipeline";
import { computeAnalyticsContext } from "../instagram/analyticsContext";
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
  navigateEbToLogin,
  browserAutoLogin,
  sendLoginDone,
  setCheckpointUrl,
  getSessionPageCookies,
  harvestSignupCookiesFromEB,
  scheduleAutoLogin,
  getSessionChallengeUrl,
  deleteSavedCookies,
  runSilentLeakTest,
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

  storePendingAutomateSession,
  consumePendingAutomateSession,
  type ProxyConfig,
} from "../instagram/browserSession";
import { automationEngine } from "../instagram/automationEngine";
import { proxySlotManager } from "../instagram/proxySlotManager";
import { MOBILE_VERSION_CODE } from "../instagram/instagramWebClient";
import { userAgents as UA_POOL, desktopUserAgents as DESKTOP_UA_POOL } from "../shared/userAgents";

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

// Deterministic desktop UA picker — same hash algorithm as pickUAForAccount so
// each username always maps to the same desktop entry.  Used when disableApi=true
// (browser-only mode) where the EB is the sole consumer of the session — one
// device, one identity, desktop Chrome UA → full Instagram desktop layout.
function pickDesktopUAForAccount(username: string): { api: string; embedded: string } {
  if (!username || DESKTOP_UA_POOL.length === 0) return DESKTOP_UA_POOL[0];
  let hash = 5381;
  for (let i = 0; i < username.length; i++) {
    hash = ((hash << 5) + hash) ^ username.charCodeAt(i);
    hash = hash >>> 0;
  }
  return DESKTOP_UA_POOL[hash % DESKTOP_UA_POOL.length];
}

// Last-resort desktop Chrome UA — used ONLY for the Clear EB Session cleanup path when
// no per-account UA is stored (so the session can still be wiped even if UA is unset).
// NEVER use this for a new login, verify, or WS attach — those must block instead.
const DESKTOP_BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Per-account verify lock — prevents concurrent logins for the same account.
// Multiple simultaneous IgApiClient instances logging in with the same device
// fingerprint look like a device leak to Instagram and cause blocks.
// Stored as Map<profileId, startTimestamp> so stale locks (> 10 min) auto-clear
// instead of permanently blocking re-verify after a crash in the background worker.
const verifyInFlight = new Map<number, number>();
const VERIFY_LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes

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

// On startup: any account still in "verifying" was mid-bootstrap when the
// server was killed.  Two cases:
//   • igApiCookies present  → EB login already completed; just redo the 3
//     mobile API calls (Path 2 — no browser needed).  Resumes seamlessly.
//   • igApiCookies absent   → EB login never finished; reset to "pending" so
//     the user knows to press Verify again.
async function resumeStuckVerifyingAccounts(): Promise<void> {
  // Wait for the server to fully settle before firing API calls.
  await new Promise(resolve => setTimeout(resolve, 3000));

  let allProfiles: Awaited<ReturnType<typeof storage.getProfiles>>;
  try { allProfiles = await storage.getProfiles(); }
  catch (err) {
    console.warn("[startup:resume] Could not load profiles:", err);
    return;
  }

  const stuck = allProfiles.filter(p => p.accountStatus === "verifying");
  if (stuck.length === 0) return;

  const withCookies    = stuck.filter(p => p.igApiCookies && p.igApiCookies.includes("sessionid="));
  const withoutCookies = stuck.filter(p => !p.igApiCookies || !p.igApiCookies.includes("sessionid="));

  // No cookies → EB login never completed; reset so user can try again.
  for (const p of withoutCookies) {
    await storage.updateProfile(p.id, { accountStatus: "pending" } as any).catch(() => {});
    console.warn(`[startup:resume] @${p.username} — no igApiCookies → reset to pending`);
  }

  if (withCookies.length === 0) return;
  console.log(`[startup:resume] ${withCookies.length} account(s) resuming mobile API bootstrap`);

  for (let i = 0; i < withCookies.length; i++) {
    const profile = withCookies[i];
    // Stagger between accounts (6–10 s) to avoid bursting the mobile API.
    if (i > 0) await new Promise(resolve => setTimeout(resolve, 6000 + Math.floor(Math.random() * 4000)));

    await acquireSilentVerifySlot();
    try {
      console.log(`[startup:resume] @${profile.username} — running verifyInstagramCredentials (Path 2)`);
      let apiResult: Awaited<ReturnType<typeof verifyInstagramCredentials>>;
      try {
        apiResult = await verifyInstagramCredentials(profile as any);
      } catch (verifyErr: any) {
        console.error(`[startup:resume] threw for @${profile.username}:`, verifyErr?.message);
        await storage.updateProfile(profile.id, { accountStatus: "pending" } as any).catch(() => {});
        continue;
      }

      const finalStatus = apiResult.accountStatus ?? (apiResult.ok ? "valid" : "pending");
      await storage.updateProfile(profile.id, {
        accountStatus: finalStatus,
        ...(finalStatus === "valid" ? { credentialsDirty: false } : {}),
        ...(apiResult.igDeviceState ? { igDeviceState: apiResult.igDeviceState } : {}),
        ...("igApiCookies" in apiResult && apiResult.igApiCookies ? { igApiCookies: apiResult.igApiCookies } : {}),
      } as any).catch(() => {});

      await storage.createSessionAction({
        profileId: profile.id,
        toolId: 0,
        action: apiResult.ok ? "verified" : "verification_failed",
        targetUsername: profile.username,
        sourceValue: "",
        sourceType: "startup_resume",
        result: finalStatus,
        detail: apiResult.message ?? (apiResult.ok ? "Auto-resumed after restart" : "Auto-resume failed"),
        timestamp: new Date().toISOString(),
      }).catch(() => {});

      console.log(`[startup:resume] @${profile.username} → ${finalStatus}`);
    } finally {
      releaseSilentVerifySlot();
    }
  }
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
    if (linked) {
      // Adapter proxies: the DB port is stale after every restart — always use the live
      // in-process tunnel port.  Auto-start the tunnel if the adapter is plugged in but
      // the tunnel isn't running yet (e.g. dongle was re-plugged after app start).
      if (linked.proxyType === "adapter") {
        const runningPort = getAdapterProxyPort(linked.id);
        if (runningPort) {
          return { host: "127.0.0.1", port: runningPort, type: "http" as const };
        }
        const adapterName = linked.adapterName ?? "";
        const ip = getAdapterIp(adapterName);
        if (ip) {
          try {
            const port = await startAdapterProxy(linked.id, adapterName);
            await storage.updateProxy(linked.id, { host: "127.0.0.1", port });
            console.log(`[adapter] resolveProxyConfig auto-started tunnel for proxy ${linked.id} "${adapterName}" → 127.0.0.1:${port}`);
            return { host: "127.0.0.1", port, type: "http" as const };
          } catch (err) {
            console.warn(`[adapter] resolveProxyConfig failed to auto-start tunnel for proxy ${linked.id}:`, err);
          }
        }
        console.warn(`[adapter] resolveProxyConfig: adapter "${linked.adapterName}" not plugged in or tunnel failed — returning undefined`);
        return undefined;
      }
      if (linked.host && linked.port) {
        return {
          host: linked.host,
          port: linked.port,
          type: (linked.proxyType === "socks5" ? "socks5" : "http") as "http" | "socks5",
          username: linked.username ?? undefined,
          password: linked.password ?? undefined,
        };
      }
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

// If the newly-created profile is assigned to a proxy that is already under an
// active ban countdown, inherit the remaining countdown so it doesn't start
// running actions while its siblings are still paused.
async function applyProxyTaintIfActive(profileId: number, proxyId: number): Promise<void> {
  try {
    const siblings = await storage.getProfilesByProxyId(proxyId);
    const now = Date.now();
    let maxResumingUntil: string | null = null;
    let maxResumingPrevStatus: string | null = null;
    for (const s of siblings) {
      if (s.id === profileId) continue;
      if (s.resumingUntil) {
        const t = new Date(s.resumingUntil).getTime();
        if (t > now) {
          if (!maxResumingUntil || t > new Date(maxResumingUntil).getTime()) {
            maxResumingUntil = s.resumingUntil;
            maxResumingPrevStatus = s.resumingPrevStatus ?? "pending";
          }
        }
      }
    }
    if (maxResumingUntil) {
      await storage.updateProfile(profileId, {
        accountStatus: "stopped",
        resumingUntil: maxResumingUntil,
        resumingPrevStatus: maxResumingPrevStatus ?? "pending",
      } as any);
      console.log(`[proxy-taint] Inherited proxy ban countdown → profile ${profileId}: stopped until ${maxResumingUntil}`);
    }
  } catch (err) {
    console.warn(`[proxy-taint] Failed to apply proxy taint to profile ${profileId}:`, err);
  }
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
    detail: `Equinox started: ${new Date(SERVER_START).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}`,
    timestamp: SERVER_START,
  }).catch(() => {});

  // On startup: resume any accounts that were mid-verify when the server was killed.
  // Accounts whose EB login completed (igApiCookies saved) just need the 3 mobile API
  // calls re-run — no browser required.  Those with no cookies get reset to "pending".
  void resumeStuckVerifyingAccounts();

  automationEngine.start();

  // On startup, load proxy slot settings AND restore any saved cooldown state
  // from the DB so cooldown windows survive server restarts.
  try {
    const gs = await storage.getGlobalSettings();
    const maxConcurrent   = parseInt(gs["proxySlotMaxConcurrent"]   ?? "2",  10) || 2;
    const cooldownMinMins = parseFloat(gs["proxySlotCooldownMinMins"] ?? "30") || 30;
    const cooldownMaxMins = parseFloat(gs["proxySlotCooldownMaxMins"] ?? "35") || 35;
    const slotEnabled     = gs["proxySlotEnabled"] !== "false";
    proxySlotManager.updateSettings({
      enabled: slotEnabled,
      maxConcurrent,
      cooldownMinMs: Math.round(cooldownMinMins * 60 * 1000),
      cooldownMaxMs: Math.round(cooldownMaxMins * 60 * 1000),
    });
    if (gs["proxySlotCooldownState"]) {
      proxySlotManager.restore(gs["proxySlotCooldownState"]);
      console.log("[startup] proxy slot cooldown state restored from DB");
    }
  } catch { /* non-fatal — defaults remain */ }

  // Persist slot state to DB on every change so cooldowns survive restarts.
  proxySlotManager.setSaveFn(() => {
    const json = proxySlotManager.serialize();
    storage.setGlobalSetting("proxySlotCooldownState", json).catch(() => {});
  });

  // ── IPC diagnostic log endpoint ───────────────────────────────────────────
  // The Electron main process and the renderer both POST here so their log
  // lines go through the server's already-open file descriptor and appear in
  // equinox-debug.log (fs.appendFileSync from another process is silently
  // swallowed on Windows when the server holds the fd open).
  app.post("/api/ipc-log", (req, res) => {
    const msg = String(req.body?.message ?? "").trim();
    if (msg) console.log(msg);
    res.json({ ok: true });
  });

  // Proxies
  app.get(api.proxies.list.path, async (_req, res) => {
    const data = await storage.getProxies();
    // Attach live tunnel port so the UI can show the correct running state on refresh
    const enriched = data.map(p => ({
      ...p,
      tunnelPort: getAdapterProxyPort(p.id) ?? null,
      rotating: p.proxyType === "adapter" && p.adapterName ? isAdapterRotating(p.adapterName) : false,
    }));
    res.json(enriched);
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
      // insertProxySchema has proxyType.default("http") — Zod injects that default
      // even on a PATCH when the field is absent from the body, silently overwriting
      // the stored value. Strip any field that was not explicitly supplied by the caller.
      const bodyKeys = new Set(Object.keys(req.body));
      for (const key of Object.keys(input) as (keyof typeof input)[]) {
        if (!bodyKeys.has(key)) delete input[key];
      }
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
      if (profile.isTemplate) { skipped++; continue; }
      if (profile.proxyId) { skipped++; continue; }
      if (!profile.proxyHost || !profile.proxyPort) { skipped++; continue; }

      const key = `${profile.proxyHost}:${profile.proxyPort}`;
      let proxyId = proxyByHostPort.get(key);

      if (!proxyId) {
        // Proxy not yet in the Proxy Manager — create it from the inline profile data.
        // importLinked = 1 marks this as auto-created for this account so it is
        // cleaned up automatically if its last linked account is deleted.
        const newProxy = await storage.createProxy({
          name: key,
          host: profile.proxyHost,
          port: profile.proxyPort,
          username: profile.proxyUsername ?? null,
          password: profile.proxyPassword ?? null,
          importLinked: 1,
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

    // For adapter proxies, ping = measure real round-trip through the tunnel via HTTP CONNECT
    if (proxy.proxyType === "adapter") {
      const adapterName = proxy.adapterName ?? "";
      // Rotation is in progress — adapter is intentionally offline, report dead immediately
      if (isAdapterRotating(adapterName)) {
        return res.json({ alive: false, latencyMs: 0, error: "Rotating — reconnecting dongle…" });
      }
      const ip = getAdapterIp(adapterName);
      if (!ip) return res.json({ alive: false, latencyMs: 0, error: "Adapter not found or unplugged" });
      const tunnelPort = getAdapterProxyPort(proxy.id);
      if (!tunnelPort) return res.json({ alive: false, latencyMs: 0, error: "Tunnel not running — select the adapter to start it" });
      const start = Date.now();
      try {
        const net = await import("net");
        await new Promise<void>((resolve, reject) => {
          const sock = (net.default ?? net).createConnection({ host: "127.0.0.1", port: tunnelPort, timeout: 5000 });
          let buf = "";
          sock.once("connect", () => {
            sock.write("CONNECT 1.1.1.1:80 HTTP/1.1\r\nHost: 1.1.1.1:80\r\n\r\n");
          });
          sock.on("data", (chunk: Buffer) => {
            buf += chunk.toString();
            if (buf.includes("\r\n\r\n")) {
              sock.destroy();
              buf.startsWith("HTTP/1.1 200") ? resolve() : reject(new Error("CONNECT refused: " + buf.split("\r\n")[0]));
            }
          });
          sock.once("error", reject);
          sock.once("timeout", () => { sock.destroy(); reject(new Error("Tunnel timeout")); });
        });
        return res.json({ alive: true, latencyMs: Date.now() - start, adapterIp: ip });
      } catch (err: any) {
        return res.json({ alive: false, latencyMs: Date.now() - start, error: err.message ?? "Tunnel unreachable" });
      }
    }

    const start = Date.now();
    try {
      // Raw TCP reachability test — definitively confirms whether the proxy
      // host:port is reachable. If the TCP connection fails the proxy is dead.
      const net = await import("net");
      await new Promise<void>((resolve, reject) => {
        const sock = (net.default ?? net).createConnection({
          host: proxy.host,
          port: Number(proxy.port),
          timeout: 5000,
        });
        sock.once("connect", () => { sock.destroy(); resolve(); });
        sock.once("error", reject);
        sock.once("timeout", () => { sock.destroy(); reject(new Error("TCP timeout")); });
      });
      res.json({ alive: true, latencyMs: Date.now() - start });
    } catch (err: any) {
      res.json({ alive: false, latencyMs: Date.now() - start, error: err.message ?? "unreachable" });
    }
  });

  // ── Adapter proxy routes ─────────────────────────────────────────────────

  // List available network adapters on this machine
  app.get("/api/adapters", (_req, res) => {
    const adapters = listAdapters();
    console.log("[adapters] Raw os.networkInterfaces():", JSON.stringify(require("os").networkInterfaces(), null, 2));
    console.log("[adapters] Returning", adapters.length, "adapter(s):", adapters.map(a => `${a.name}=${a.ip || "no-ip"}`).join(", "));
    res.json(adapters);
  });

  // Start / restart the local tunnel for an adapter proxy
  app.post("/api/proxies/:id/adapter/start", async (req, res) => {
    const proxyId = Number(req.params.id);
    const proxy = (await storage.getProxies()).find(p => p.id === proxyId);
    if (!proxy || proxy.proxyType !== "adapter") {
      return res.status(404).json({ error: "Adapter proxy not found" });
    }
    const adapterName = proxy.adapterName ?? "";
    const ip = getAdapterIp(adapterName);
    if (!ip) return res.status(400).json({ error: `Adapter "${adapterName}" not found or unplugged` });

    try {
      const port = await startAdapterProxy(proxyId, adapterName);
      // Persist the tunnel port back into host/port so resolveProxyConfig picks it up
      await storage.updateProxy(proxyId, { host: "127.0.0.1", port });

      // Schedule rotation if configured
      if (proxy.rotateEveryMin && proxy.rotateEveryMax) {
        const scheduleNext = (id: number, name: string) => {
          const nextMs = (proxy.rotateEveryMin! + Math.random() * (proxy.rotateEveryMax! - proxy.rotateEveryMin!)) * 60 * 1000;
          scheduleRotation(id, name, nextMs, (triggeredId, triggeredName) => {
            console.log(`[adapter] Auto-rotate triggered for proxy ${triggeredId} adapter "${triggeredName}"`);
            rotateAdapter(triggeredName, newIp => {
              console.log(`[adapter] Auto-rotate complete for proxy ${triggeredId} — new IP: ${newIp ?? "unknown"}`);
              // Schedule the next rotation after this one finishes
              scheduleNext(triggeredId, triggeredName);
            });
          });
        };
        scheduleNext(proxyId, adapterName);
      }

      res.json({ ok: true, port, adapterIp: ip });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Failed to start adapter tunnel" });
    }
  });

  // Stop the local tunnel for an adapter proxy
  app.post("/api/proxies/:id/adapter/stop", async (req, res) => {
    const proxyId = Number(req.params.id);
    clearRotation(proxyId);
    await stopAdapterProxy(proxyId);
    res.json({ ok: true });
  });

  // Manually trigger an IP rotation (disconnect + reconnect adapter via netsh)
  app.post("/api/proxies/:id/adapter/rotate", async (req, res) => {
    const proxyId = Number(req.params.id);
    const proxy = (await storage.getProxies()).find(p => p.id === proxyId);
    if (!proxy || proxy.proxyType !== "adapter") {
      return res.status(404).json({ error: "Adapter proxy not found" });
    }
    const adapterName = proxy.adapterName ?? "";
    const ip = getAdapterIp(adapterName);
    if (!ip) return res.status(400).json({ error: "Adapter not found or unplugged" });
    // Kick off the netsh disable/wait/enable cycle in the background — response returns immediately
    res.json({ ok: true, adapterIp: ip, rotating: true });
    rotateAdapter(adapterName, newIp => {
      console.log(`[adapter] Manual rotate complete for proxy ${proxyId} — new IP: ${newIp ?? "unknown"}`);
    });
  });

  // Startup: boot all existing adapter proxies
  (async () => {
    try {
      const allProxies = await storage.getProxies();
      for (const proxy of allProxies) {
        if (proxy.proxyType !== "adapter" || !proxy.adapterName) continue;
        const ip = getAdapterIp(proxy.adapterName);
        if (!ip) { console.log(`[adapter] Proxy ${proxy.id}: adapter "${proxy.adapterName}" not present — skipping`); continue; }
        const port = await startAdapterProxy(proxy.id, proxy.adapterName);
        await storage.updateProxy(proxy.id, { host: "127.0.0.1", port });
        console.log(`[adapter] Proxy ${proxy.id} "${proxy.adapterName}" → 127.0.0.1:${port}`);
      }
    } catch (err) {
      console.warn("[adapter] Startup boot error:", err);
    }
  })();

  // Profiles
  app.get(api.profiles.list.path, async (req, res) => {
    try {
      const all = await storage.getProfiles();
      console.log(`[DEBUG profiles/list] storage.getProfiles() returned ${all.length} rows`);
      if (all.length > 0) {
        const sample = all[0] as any;
        console.log(`[DEBUG profiles/list] sample[0] keys: ${Object.keys(sample).join(", ")}`);
        console.log(`[DEBUG profiles/list] sample[0] isTemplate=${JSON.stringify(sample.isTemplate)} creatorMode=${JSON.stringify(sample.creatorMode)} accountStatus=${JSON.stringify(sample.accountStatus)}`);
      }
      const cm = req.query.creatorMode;
      let filtered: typeof all;
      // Always exclude isTemplate accounts — they are TrustScore skeleton profiles
      // managed exclusively via /api/trust-score-templates and must never appear
      // in the Account Manager or any tool that reads the general profiles list.
      const nonTemplate = all.filter((p: any) => !p.isTemplate);
      if (cm === "1") filtered = nonTemplate.filter((p: any) => p.creatorMode);
      else if (cm === "0") filtered = nonTemplate.filter((p: any) => !p.creatorMode);
      else filtered = nonTemplate;
      console.log(`[DEBUG profiles/list] after creatorMode(${cm}) filter: ${filtered.length} rows`);
      // Attach live EB fingerprint stats (battery %, connection Mbps) for any
      // profile that currently has an open browser session.  Null when the EB
      // is not running.  The frontend polls every 5 s so the values update live.
      const enriched = filtered.map((p: any) => ({
        ...p,
        ebLiveStats: p.userAgentEmbedded ? getEbLiveStats(p.id, p.userAgentEmbedded) : null,
      }));
      console.log(`[DEBUG profiles/list] sending ${enriched.length} enriched profiles`);
      res.json(enriched);
    } catch (err: any) {
      console.error(`[DEBUG profiles/list] ERROR: ${err?.message ?? err}`, err?.stack ?? "");
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  // Must be before /:id routes so Express doesn't treat "last-api-calls" as an ID.
  app.get("/api/profiles/:profileId/api-call-count", async (req, res) => {
    const count = await storage.getInstagramApiCallCount(Number(req.params.profileId));
    res.json({ count });
  });

  app.get("/api/profiles/:profileId/api-endpoint-counts", async (req, res) => {
    const todayPrefix = new Date().toISOString().slice(0, 10);
    const counts = await storage.getApiEndpointCounts(Number(req.params.profileId), todayPrefix);
    res.json(counts);
  });

  app.get("/api/profiles/:profileId/pre-status-change-hits", async (req, res) => {
    const profileId = Number(req.params.profileId);
    const [perAccount, global] = await Promise.all([
      storage.getPreStatusChangeHits(profileId),
      storage.getGlobalPreStatusChangeHits(),
    ]);
    res.json({ perAccount, global });
  });

  app.get("/api/profiles/lifetime-calls", async (_req, res) => {
    const data = await storage.getLifetimeStatsByProfile();
    res.json(data);
  });

  app.get("/api/profiles/api-call-count-all", async (_req, res) => {
    const data = await storage.getInstagramApiCallCountAll();
    res.json(data);
  });

  app.get("/api/profiles/last-api-calls", async (_req, res) => {
    const data = await storage.getLastValidApiCallByProfile();
    res.json(data);
  });

  // Returns the set of unique Verify-source operation names seen per profile.
  // Used by ProfilesPage to show clean vs extended verify health indicator.
  // Clean = ≤10 unique ops (core sequence only), Extended = >10.
  app.get("/api/profiles/verify-health", async (_req, res) => {
    const data = await storage.getVerifyOpsByProfile();
    res.json(data);
  });

  // Returns {[profileId]: boolean} for the humanSessionEnabled setting across all profiles.
  // Must be before /:id routes so Express doesn't treat "human-session-enabled" as an ID.
  app.get("/api/profiles/human-session-enabled", async (_req, res) => {
    const rows = await db.select().from(tools).where(eq(tools.type, "human_sessions"));
    const result: Record<number, boolean> = {};
    for (const row of rows) {
      result[row.profileId] = row.enabled === true;
    }
    res.json(result);
  });

  // Returns the least-used UA from the pool — unused first, then least-used.
  // Must be before /:id routes so Express doesn't treat "suggest-ua" as a profile ID.
  app.get("/api/profiles/suggest-ua", async (_req, res) => {
    const existing = await db.select({ ua: profiles.userAgentApi }).from(profiles);
    const usedSet = new Set(existing.map(r => r.ua).filter(Boolean));
    const { userAgents } = await import("../shared/userAgents");
    const unused = userAgents.filter(u => !usedSet.has(u.api));
    const pool = unused.length > 0 ? unused : userAgents;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    res.json({ api: pick.api, embedded: pick.embedded });
  });

  app.patch("/api/profiles/:id/human-session-enabled", async (req, res) => {
    const profileId = Number(req.params.id);
    const { enabled } = req.body as { enabled: boolean };
    const rows = await db.select().from(tools).where(eq(tools.profileId, profileId));
    const tool = rows.find(t => t.type === "human_sessions");
    if (!tool) { res.status(404).json({ error: "human_sessions tool not found" }); return; }
    const newSettings = { ...(tool.settings as Record<string, unknown> ?? {}), humanSessionEnabled: enabled };
    // Update BOTH tool.enabled (the reconcile gate) and settings.humanSessionEnabled
    // (the per-action gate inside the HS loop). Without setting tool.enabled the
    // automation engine's reconcile never starts/stops the runner.
    const updated = await storage.updateTool(tool.id, { enabled, settings: newSettings });
    if (enabled) automationEngine.triggerHumanSession(profileId);
    res.json({ ok: true, settings: updated.settings });
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

      // If username already exists, append a re-add timestamp to notes and return the
      // existing profile updated. This supports the "Add to Equinox" re-import flow.
      // Skip this check for blank usernames — multiple blank accounts must each get their own row.
      const existing = input.username ? await storage.getProfileByUsername(input.username) : null;
      if (existing) {
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const stamp = `Re-added: ${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`;
        const updatedNotes = existing.notes ? `${existing.notes}\n${stamp}` : stamp;
        // When re-adding from Ghost Browser, also carry over the fresh password and
        // session cookies so the EB opens already logged in.
        const reAddUpdate: Record<string, unknown> = { notes: updatedNotes };
        if (input.password) reAddUpdate.password = input.password;
        if (input.name)     reAddUpdate.name     = input.name;
        if (input.igApiCookies && typeof input.igApiCookies === "string" && input.igApiCookies.includes("sessionid=")) {
          reAddUpdate.igApiCookies = input.igApiCookies;
        }
        const updated = await storage.updateProfile(existing.id, reAddUpdate as any);
        // Seed browser cookie file so EB opens logged in
        if (reAddUpdate.igApiCookies) seedBrowserCookieFile(existing.id, reAddUpdate.igApiCookies as string);
        return res.status(200).json(updated);
      }

      // Auto-assign paired UAs when the user leaves them blank on manual add.
      // All accounts — including disableApi=true (browser-only) — get a mobile
      // Android Chrome UA.  The EB fingerprint stack (GPU pool, client hints,
      // viewport, canvas/audio noise) was built for mobile and is most coherent
      // there.  Desktop UAs on an ARM Mac server leak real hardware signals
      // (Architecture: arm, Apple Silicon GPU) that contradict an Intel Mac UA.
      if (!input.userAgentEmbedded || !input.userAgentApi) {
        const autoUA = pickUAForAccount(input.username || "");
        if (!input.userAgentEmbedded) input.userAgentEmbedded = autoUA.embedded;
        if (!input.userAgentApi)      input.userAgentApi      = autoUA.api;
      }
      const created = await storage.createProfile(input);
      // Seed browser cookie file if cookies were provided — same as bulk/EQX import
      if (created.igApiCookies) seedBrowserCookieFile(created.id, created.igApiCookies);
      // Inherit proxy ban countdown if the assigned proxy already has an active taint
      if (created.proxyId) await applyProxyTaintIfActive(created.id, created.proxyId);
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
      } else if ("proxyId" in body && current && body.proxyId !== current.proxyId && current.accountStatus === "valid") {
        // Proxy changed without "Keep accounts valid" — reset to pending so the account gets re-verified
        body.accountStatus = "pending";
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
      // ── Protect device fingerprint from accidental overwrite via PATCH ────────
      // userAgentApi, userAgentEmbedded, and ebFingerprint together form the
      // account's permanent device identity (the Android UA that Instagram binds
      // to its device token).  These must ONLY change when the user explicitly
      // presses "Reset Device IDs" — which goes through the dedicated
      // /api/profiles/:id/reset-device-ids route.  Any PATCH carrying these
      // fields (including empty values rendered by form fields that were not
      // filled in) is silently stripped here so a form save, copy-settings
      // operation, or any other generic update can never silently change the UA
      // and trigger Instagram's "Try a trusted device" security challenge.
      if ("userAgentApi" in body) {
        console.warn(`[ua-guard] BLOCKED attempt to overwrite userAgentApi via PATCH route for profile ${id} — use /reset-device-ids`);
        delete body.userAgentApi;
      }
      if ("userAgentEmbedded" in body) {
        console.warn(`[ua-guard] BLOCKED attempt to overwrite userAgentEmbedded via PATCH route for profile ${id} — use /reset-device-ids`);
        delete body.userAgentEmbedded;
      }
      if ("ebFingerprint" in body) {
        console.warn(`[ua-guard] BLOCKED attempt to overwrite ebFingerprint via PATCH route for profile ${id} — use /reset-device-ids`);
        delete body.ebFingerprint;
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
    // When the caller doesn't supply a specific UA, always pick a mobile Android
    // Chrome UA — even for disableApi=true accounts.  The EB fingerprint stack is
    // built for mobile and desktop UAs cause hardware-mismatch signals on the ARM
    // Mac server (Architecture: arm leaks through Sec-CH-UA when UA claims Intel).
    let ua: { api: string; embedded: string };
    if (userAgentApi && userAgentEmbedded) {
      ua = { api: userAgentApi, embedded: userAgentEmbedded };
    } else {
      ua = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
    }
    const isDesktopUA = !ua.embedded.includes("Mobile");
    await storage.updateProfile(id, {
      userAgentApi: ua.api,
      userAgentEmbedded: ua.embedded,
      igDeviceState: null,
      igApiCookies: null,
      accountStatus: "pending",
      credentialsDirty: true,
      ebFingerprint: JSON.stringify(generateEbFingerprint(ua.api, isDesktopUA, ua.embedded)),
    });
    // Clear any in-flight verify lock so the next Verify doesn't get a 429
    // "already in progress" if the previous verify was still running when reset was clicked.
    verifyInFlight.delete(id);
    res.json({ ok: true });
  });

  // Migration: reset all disableApi accounts that still carry a desktop Chrome UA
  // (no "Mobile" in the UA string) back to a mobile Android Chrome UA + fresh fingerprint.
  // Credentials (cookies, device state) are NOT cleared so active sessions survive.
  // This is a one-time repair for accounts assigned desktop UAs before the policy change.
  app.post("/api/admin/migrate-desktop-to-mobile-uas", async (req, res) => {
    const all = await storage.getProfiles();
    const targets = all.filter(p =>
      (p.apiLimits as any)?.disableApi === true &&
      p.userAgentEmbedded &&
      !p.userAgentEmbedded.includes("Mobile"),
    );
    const results: { id: number; username: string; ok: boolean; error?: string }[] = [];
    for (const p of targets) {
      try {
        const ua = pickUAForAccount(p.username || "");
        const fp = JSON.stringify(generateEbFingerprint(ua.api, false, ua.embedded));
        await storage.updateProfile(p.id, {
          userAgentApi:      ua.api,
          userAgentEmbedded: ua.embedded,
          ebFingerprint:     fp,
        });
        results.push({ id: p.id, username: p.username || String(p.id), ok: true });
      } catch (err: any) {
        results.push({ id: p.id, username: p.username || String(p.id), ok: false, error: String(err?.message) });
      }
    }
    res.json({ migrated: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
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
      "followViaBrowser", "postViaBrowser",
      "syncEnabled", "syncIntervalMin", "syncIntervalMax", "syncUseHiker",
    ]);
    const safePatch: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      if (ALLOWED.has(key)) safePatch[key] = patch[key];
    }
    if (Object.keys(safePatch).length === 0) {
      return res.status(400).json({ message: "No valid fields in patch" });
    }
    try {
      await Promise.all((ids as number[]).map(id => storage.updateProfile(id, safePatch)));
      res.json({ ok: true, updated: ids.length });
    } catch (err) {
      console.error("[bulk-update] updateProfile threw:", err);
      res.status(500).json({ message: "Failed to save settings to one or more accounts", detail: String(err) });
    }
  });

  // ── Clear all action-block suspensions for a set of profiles ─────────────
  // Resets the in-memory actionSuspensions map AND clears toolBlockedUntil
  // from the DB settings of every tool belonging to the given profiles so the
  // engine starts following/liking/etc. again immediately.
  app.post("/api/profiles/clear-suspensions", async (req, res) => {
    const { profileIds } = req.body ?? {};
    if (!Array.isArray(profileIds) || profileIds.length === 0) {
      return res.status(400).json({ message: "profileIds (array) is required" });
    }
    const ids = (profileIds as unknown[]).map(Number).filter(n => !Number.isNaN(n));
    const TOOL_TYPES = ["follow", "unfollow", "dm", "contact", "like"] as const;
    let clearedProfiles = 0;
    let clearedTools = 0;
    for (const profileId of ids) {
      // 1. Clear in-memory action suspensions for every tool type.
      for (const toolType of TOOL_TYPES) {
        automationEngine.clearSuspensions(profileId, toolType);
      }
      // 2. Clear the DB-persisted toolBlockedUntil from ALL tools for this profile,
      //    regardless of whether the field is currently set.  This guarantees the
      //    runner reads a clean tool on its next iteration even if the in-memory
      //    state was already empty.
      try {
        const profileTools = await storage.getToolsByProfile(profileId);
        for (const tool of profileTools) {
          const s = (tool.settings ?? {}) as Record<string, unknown>;
          // Always write — even if the keys are absent — so we're certain the DB row
          // is clean.  Avoids any key-name or type mismatch silently leaving a stale timer.
          const cleared = { ...s };
          delete cleared.toolBlockedUntil;
          delete cleared.blockCount;
          await storage.updateTool(tool.id, { settings: cleared });
          clearedTools++;
        }
        clearedProfiles++;
      } catch (err) {
        req.log.error(`[clear-suspensions] profileId=${profileId} threw: ${err}`);
      }
      // 3. Wake the follow runner from its inter-session sleep so the cleared state
      //    takes effect immediately instead of waiting for the next scheduled session.
      automationEngine.forceFollowNow(profileId);
    }
    req.log.info(`[clear-suspensions] cleared suspensions for ${clearedProfiles}/${ids.length} profiles, ${clearedTools} tool(s) updated`);
    res.json({ ok: true, clearedProfiles, clearedTools });
  });

  app.patch("/api/profiles/:id", handleProfileUpdate);
  app.put("/api/profiles/:id", handleProfileUpdate);

  app.delete(api.profiles.delete.path, async (req, res) => {
    const profileId = Number(req.params.id);
    const profile = await storage.getProfile(profileId).catch(() => null);
    await storage.deleteProfile(profileId);
    // NOTE: intentionally do NOT call proxySlotManager.clearProfile() here.
    // If this account had used a proxy IP it should keep its cooldown slot
    // occupied so no other account can claim that same IP slot until the
    // cooldown naturally expires — the IP was used and the software must know that.
    // skipCookieSave: true — the account is gone, no point saving cookies.
    // Also avoids the saveCookies CDP call (can hang 30 s on a challenged page)
    // which was starving the profile-list refetch and causing the UI to freeze.
    closeSession(profileId, { skipCookieSave: true }).catch(() => {});
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

  // ── Shared helper: resolve proxy host for analytics snapshots ───────────────
  async function resolveProxyHost(profile: { proxyHost?: string | null; proxyId?: number | null }): Promise<string> {
    if (profile.proxyHost) return profile.proxyHost;
    if (profile.proxyId) {
      const allProxies = await storage.getProxies().catch(() => []);
      const linked = allProxies.find((p: { id: number; host: string }) => p.id === profile.proxyId);
      if (linked) return linked.host;
    }
    return "";
  }

  // ── Flag as Banned: snapshot API calls → save to analytics → set status to banned (no deletion) ──
  app.post("/api/profiles/:id/flag-banned", async (req, res) => {
    const profileId = Number(req.params.id);
    const profile = await storage.getProfile(profileId).catch(() => null);
    if (!profile) { res.status(404).json({ error: "Profile not found" }); return; }
    try {
      await triggerBanPipeline(profileId, "manual");
      const allCalls = await storage.getInstagramApiCallsByProfile(profileId, 2000);
      const endpointCount = allCalls.filter((c: { source?: string | null }) => c.source !== "HikerAPI").length;
      req.log.info(`[flag-banned] @${profile.username} (id=${profileId}) — pipeline complete, ${endpointCount} calls snapshotted`);
      res.status(200).json({ ok: true, username: profile.username, endpointCount });
    } catch (err) {
      req.log.error({ err }, "[flag-banned] error");
      res.status(500).json({ error: "Failed to flag account as banned" });
    }
  });

  // ── Ban Analytics: return all ban event records ─────────────────────────────
  app.get("/api/analytics/ban-patterns", async (req, res) => {
    try {
      const records = await storage.getBanAnalytics();
      res.json(records);
    } catch (err) {
      req.log.error({ err }, "[ban-analytics] error");
      res.status(500).json({ error: "Failed to fetch ban analytics" });
    }
  });

  // ── Verify-Only Fingerprint Analysis ─────────────────────────────────────────
  // Returns banned accounts whose every non-HikerAPI endpoint came exclusively
  // from the verify/eb/system bootstrap sequence (no tool activity), joined with
  // each account's leakSnapshot from the live profiles table.
  app.get("/api/analytics/verify-fingerprint", async (req, res) => {
    try {
      const records = await storage.getBanAnalytics();
      const allProfiles = await storage.getProfiles();
      const profileByUsername = new Map<string, any>();
      for (const p of allProfiles) profileByUsername.set(p.username, p);

      const verifyOnly = records.filter((r: any) => {
        let eps: Array<{ source?: string | null }> = [];
        try { eps = JSON.parse(r.endpointSnapshot); } catch { return false; }
        eps = eps.filter((e: any) => (e.source ?? "").toLowerCase() !== "hiker_api");
        if (eps.length === 0) return false;
        return eps.every((ep: any) => {
          const s = (ep.source ?? "").toLowerCase();
          return s === "verify" || s === "eb" || s === "system" || s === "";
        });
      });

      const results = verifyOnly.map((r: any) => {
        const profile = profileByUsername.get(r.username);
        let leakData: any = null;
        const raw = (profile as any)?.leakSnapshot ?? null;
        if (raw) { try { leakData = JSON.parse(raw); } catch { leakData = raw; } }
        return {
          id: r.id,
          username: r.username,
          bannedAt: r.bannedAt ?? r.flaggedAt ?? null,
          proxyHost: r.proxyHost ?? null,
          leakData,
        };
      });

      res.json(results);
    } catch (err) {
      req.log.error({ err }, "[verify-fingerprint] error");
      res.status(500).json({ error: "Failed to fetch verify-only fingerprint data" });
    }
  });

  // ── Flag as Automated Behaviour: snapshot → analytics → update status (no delete) ──
  app.post("/api/profiles/:id/flag-automated", async (req, res) => {
    const profileId = Number(req.params.id);
    const profile = await storage.getProfile(profileId).catch(() => null);
    if (!profile) { res.status(404).json({ error: "Profile not found" }); return; }
    try {
      const allCalls_a = await storage.getInstagramApiCallsByProfile(profileId, 2000);
      const calls = allCalls_a.filter((c: { source?: string | null }) => c.source !== "HikerAPI");
      const snapshot = JSON.stringify(calls.map(c => ({ operationName: c.operationName, date: c.date, source: c.source ?? null })));
      const proxyHost = await resolveProxyHost(profile);
      let proxyAccountCount_a = 0;
      if (profile.proxyId) {
        const sp_a = await storage.getProfilesByProxyId(profile.proxyId).catch(() => []);
        proxyAccountCount_a = sp_a.filter((p: { id: number; accountStatus?: string | null }) => p.id !== profileId && p.accountStatus !== "banned").length;
      }
      const ctx_a = computeAnalyticsContext(calls, profile.notes, proxyAccountCount_a);
      const now_a = new Date();
      const pad_a = (n: number) => String(n).padStart(2, "0");
      const stamp_a = `Flagged as Automated Behaviour: ${now_a.getUTCFullYear()}-${pad_a(now_a.getUTCMonth()+1)}-${pad_a(now_a.getUTCDate())} ${pad_a(now_a.getUTCHours())}:${pad_a(now_a.getUTCMinutes())}:${pad_a(now_a.getUTCSeconds())} UTC`;
      const freshNotes_a = (await storage.getProfile(profileId).catch(() => null))?.notes ?? "";
      await storage.insertAutomatedBehaviourAnalytics({
        username: profile.username,
        proxyHost,
        flaggedAt: now_a.toISOString(),
        endpointCount: calls.length,
        endpointSnapshot: snapshot,
        ...ctx_a,
      });
      await storage.updateProfile(profileId, { accountStatus: "automated_behaviour_detected", notes: freshNotes_a ? `${freshNotes_a}\n${stamp_a}` : stamp_a });
      req.log.info(`[flag-automated] @${profile.username} (id=${profileId}) — ${calls.length} account API calls snapshotted (HikerAPI excluded)`);
      res.status(200).json({ ok: true, username: profile.username, endpointCount: calls.length });
    } catch (err) {
      req.log.error({ err }, "[flag-automated] error");
      res.status(500).json({ error: "Failed to flag account as automated behaviour" });
    }
  });

  // ── Flag as Captcha Error: snapshot → analytics → update status (no delete) ──
  app.post("/api/profiles/:id/flag-captcha", async (req, res) => {
    const profileId = Number(req.params.id);
    const profile = await storage.getProfile(profileId).catch(() => null);
    if (!profile) { res.status(404).json({ error: "Profile not found" }); return; }
    try {
      const allCalls_c = await storage.getInstagramApiCallsByProfile(profileId, 2000);
      const calls = allCalls_c.filter((c: { source?: string | null }) => c.source !== "HikerAPI");
      const snapshot = JSON.stringify(calls.map(c => ({ operationName: c.operationName, date: c.date, source: c.source ?? null })));
      const proxyHost = await resolveProxyHost(profile);
      let proxyAccountCount_c = 0;
      if (profile.proxyId) {
        const sp_c = await storage.getProfilesByProxyId(profile.proxyId).catch(() => []);
        proxyAccountCount_c = sp_c.filter((p: { id: number; accountStatus?: string | null }) => p.id !== profileId && p.accountStatus !== "banned").length;
      }
      const ctx_c = computeAnalyticsContext(calls, profile.notes, proxyAccountCount_c);
      const now_c = new Date();
      const pad_c = (n: number) => String(n).padStart(2, "0");
      const stamp_c = `Flagged as Captcha Error: ${now_c.getUTCFullYear()}-${pad_c(now_c.getUTCMonth()+1)}-${pad_c(now_c.getUTCDate())} ${pad_c(now_c.getUTCHours())}:${pad_c(now_c.getUTCMinutes())}:${pad_c(now_c.getUTCSeconds())} UTC`;
      const freshNotes_c = (await storage.getProfile(profileId).catch(() => null))?.notes ?? "";
      await storage.insertCaptchaAnalytics({
        username: profile.username,
        proxyHost,
        flaggedAt: now_c.toISOString(),
        endpointCount: calls.length,
        endpointSnapshot: snapshot,
        ...ctx_c,
      });
      await storage.updateProfile(profileId, { accountStatus: "captcha", notes: freshNotes_c ? `${freshNotes_c}\n${stamp_c}` : stamp_c });
      req.log.info(`[flag-captcha] @${profile.username} (id=${profileId}) — ${calls.length} account API calls snapshotted (HikerAPI excluded)`);
      res.status(200).json({ ok: true, username: profile.username, endpointCount: calls.length });
    } catch (err) {
      req.log.error({ err }, "[flag-captcha] error");
      res.status(500).json({ error: "Failed to flag account as captcha error" });
    }
  });

  // ── Automated Behaviour Analytics: return all records ───────────────────────
  app.get("/api/analytics/automated-patterns", async (req, res) => {
    try {
      const records = await storage.getAutomatedBehaviourAnalytics();
      res.json(records);
    } catch (err) {
      req.log.error({ err }, "[automated-analytics] error");
      res.status(500).json({ error: "Failed to fetch automated behaviour analytics" });
    }
  });

  // ── Captcha Analytics: return all records ───────────────────────────────────
  app.get("/api/analytics/captcha-patterns", async (req, res) => {
    try {
      const records = await storage.getCaptchaAnalytics();
      res.json(records);
    } catch (err) {
      req.log.error({ err }, "[captcha-analytics] error");
      res.status(500).json({ error: "Failed to fetch captcha analytics" });
    }
  });

  // ── Flag as Locked Account: snapshot → analytics → update status (no delete) ──
  app.post("/api/profiles/:id/flag-locked", async (req, res) => {
    const profileId = Number(req.params.id);
    const profile = await storage.getProfile(profileId).catch(() => null);
    if (!profile) { res.status(404).json({ error: "Profile not found" }); return; }
    try {
      const allCalls_l = await storage.getInstagramApiCallsByProfile(profileId, 2000);
      const calls = allCalls_l.filter((c: { source?: string | null }) => c.source !== "HikerAPI");
      const snapshot = JSON.stringify(calls.map(c => ({ operationName: c.operationName, date: c.date, source: c.source ?? null })));
      const proxyHost = await resolveProxyHost(profile);
      let proxyAccountCount_l = 0;
      if (profile.proxyId) {
        const sp_l = await storage.getProfilesByProxyId(profile.proxyId).catch(() => []);
        proxyAccountCount_l = sp_l.filter((p: { id: number; accountStatus?: string | null }) => p.id !== profileId && p.accountStatus !== "banned").length;
      }
      const ctx_l = computeAnalyticsContext(calls, profile.notes, proxyAccountCount_l);
      const now_l = new Date();
      const pad_l = (n: number) => String(n).padStart(2, "0");
      const stamp_l = `Flagged as Locked Account: ${now_l.getUTCFullYear()}-${pad_l(now_l.getUTCMonth()+1)}-${pad_l(now_l.getUTCDate())} ${pad_l(now_l.getUTCHours())}:${pad_l(now_l.getUTCMinutes())}:${pad_l(now_l.getUTCSeconds())} UTC`;
      const freshNotes_l = (await storage.getProfile(profileId).catch(() => null))?.notes ?? "";
      await storage.insertLockedAnalytics({
        username: profile.username,
        proxyHost,
        flaggedAt: now_l.toISOString(),
        endpointCount: calls.length,
        endpointSnapshot: snapshot,
        ...ctx_l,
      });
      await storage.updateProfile(profileId, { accountStatus: "locked", notes: freshNotes_l ? `${freshNotes_l}\n${stamp_l}` : stamp_l });
      req.log.info(`[flag-locked] @${profile.username} (id=${profileId}) — ${calls.length} account API calls snapshotted (HikerAPI excluded)`);
      res.status(200).json({ ok: true, username: profile.username, endpointCount: calls.length });
    } catch (err) {
      req.log.error({ err }, "[flag-locked] error");
      res.status(500).json({ error: "Failed to flag account as locked" });
    }
  });

  // ── Locked Account Analytics: return all records ─────────────────────────────
  app.get("/api/analytics/locked-patterns", async (req, res) => {
    try {
      const records = await storage.getLockedAnalytics();
      res.json(records);
    } catch (err) {
      req.log.error({ err }, "[locked-analytics] error");
      res.status(500).json({ error: "Failed to fetch locked account analytics" });
    }
  });

  // ── Refresh endpoint snapshots from live instagram_api_calls ─────────────────
  // Called at export time so automated/captcha/locked entries reflect ALL calls
  // made after the flag event, not just the frozen snapshot taken at flag time.
  // Non-fatal per profile — missing/deleted profiles are simply omitted.
  app.post("/api/analytics/refresh-endpoint-snapshots", async (req, res) => {
    try {
      const { profileIds } = req.body as { profileIds: number[] };
      if (!Array.isArray(profileIds) || profileIds.length === 0) {
        res.json({ ok: true, results: {} });
        return;
      }
      const results: Record<string, { username: string; endpointSnapshot: string; endpointCount: number }> = {};
      await Promise.all(profileIds.map(async (profileId) => {
        try {
          const profile = await storage.getProfile(profileId).catch(() => null);
          if (!profile) return;
          const allCalls = await storage.getInstagramApiCallsByProfile(profileId, 2000);
          const calls = allCalls.filter((c: { source?: string | null }) => c.source !== "HikerAPI");
          const snapshot = JSON.stringify(calls.map((c: { operationName: string; date: string; source?: string | null }) => ({
            operationName: c.operationName,
            date: c.date,
            source: c.source ?? null,
          })));
          results[String(profileId)] = {
            username: profile.username,
            endpointSnapshot: snapshot,
            endpointCount: calls.length,
          };
        } catch { /* non-fatal — skip this profile */ }
      }));
      req.log.info({ profileCount: Object.keys(results).length }, "[refresh-endpoint-snapshots] done");
      res.json({ ok: true, results });
    } catch (err) {
      req.log.error({ err }, "[refresh-endpoint-snapshots] error");
      res.status(500).json({ error: "Failed to refresh endpoint snapshots" });
    }
  });

  // ── Endpoint Risk Analysis: which endpoints correlate most with bans ────────
  // For each account's endpointSnapshot, the last WINDOW calls = "pre-ban window".
  // Pre-ban presence % = how many accounts had this endpoint in their pre-ban window.
  // Proximity score = pre-ban appearances / total appearances (0–1, higher = disproportionately near ban).
  // Composite risk = (proximity × 0.5 + presence × 0.5) × log(1+totalCalls) — prevents rare no-op endpoints scoring artificially high.
  app.get("/api/analytics/endpoint-risk", async (req, res) => {
    try {
      const [bans, automated, captcha, locked] = await Promise.all([
        storage.getBanAnalytics(),
        storage.getAutomatedBehaviourAnalytics(),
        storage.getCaptchaAnalytics(),
        storage.getLockedAnalytics(),
      ]);
      const allRecords: { endpointSnapshot: string }[] = [...bans, ...automated, ...captcha, ...locked];
      const totalAccounts = allRecords.length;

      if (totalAccounts === 0) {
        res.json({ endpoints: [], totalAccounts: 0, windowSize: 20 });
        return;
      }

      const WINDOW = 20;
      const preBanCount: Record<string, number>          = {};
      const totalCount: Record<string, number>           = {};
      const preBanAccountSet: Record<string, Set<number>> = {};
      const sourceTally: Record<string, Record<string, number>> = {};
      const posSum: Record<string, number>               = {};
      const posCnt: Record<string, number>               = {};

      for (let ai = 0; ai < allRecords.length; ai++) {
        const snap = allRecords[ai].endpointSnapshot;
        if (!snap) continue;
        let calls: Array<{ operationName: string; source?: string | null }>;
        try { calls = JSON.parse(snap); } catch { continue; }
        if (!Array.isArray(calls) || calls.length === 0) continue;
        calls = calls.filter(c => c.source !== "HikerAPI");

        for (const c of calls) {
          const op = c.operationName; if (!op) continue;
          totalCount[op] = (totalCount[op] ?? 0) + 1;
          if (!sourceTally[op]) sourceTally[op] = {};
          const src = c.source ?? "unknown";
          sourceTally[op][src] = (sourceTally[op][src] ?? 0) + 1;
        }

        const window = calls.slice(0, WINDOW);
        for (let pos = 0; pos < window.length; pos++) {
          const op = window[pos].operationName; if (!op) continue;
          preBanCount[op] = (preBanCount[op] ?? 0) + 1;
          if (!preBanAccountSet[op]) preBanAccountSet[op] = new Set();
          preBanAccountSet[op].add(ai);
          posSum[op] = (posSum[op] ?? 0) + pos;
          posCnt[op] = (posCnt[op] ?? 0) + 1;
        }
      }

      const endpoints = Object.keys(totalCount).map(op => {
        const total    = totalCount[op];
        const preBan   = preBanCount[op] ?? 0;
        const acctHits = preBanAccountSet[op]?.size ?? 0;
        const avgPos   = posCnt[op] > 0 ? posSum[op] / posCnt[op] : null;
        const proximity         = total > 0 ? preBan / total : 0;
        const preBanPresencePct = (acctHits / totalAccounts) * 100;
        const srcs = sourceTally[op] ?? {};
        const dominantSource = Object.entries(srcs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
        const compositeRisk  = (proximity * 0.5 + (acctHits / totalAccounts) * 0.5) * Math.log(1 + total);
        return {
          operationName: op,
          totalCount: total,
          preBanCount: preBan,
          preBanAccountCount: acctHits,
          preBanPresencePct: Math.round(preBanPresencePct * 10) / 10,
          proximityScore: Math.round(proximity * 1000) / 1000,
          avgPositionFromEnd: avgPos !== null ? Math.round(avgPos * 10) / 10 : null,
          compositeRisk: Math.round(compositeRisk * 1000) / 1000,
          dominantSource,
        };
      }).sort((a, b) => b.compositeRisk - a.compositeRisk);

      res.json({ endpoints, totalAccounts, windowSize: WINDOW });
    } catch (err) {
      req.log.error({ err }, "[endpoint-risk] error");
      res.status(500).json({ error: "Failed to compute endpoint risk" });
    }
  });

  // ── Survivor call patterns: live call history for valid surviving accounts ──
  // Returns each valid account's recent API call snapshot in the same format
  // as ban entries so the frontend can compute the same metrics and compare.
  app.get("/api/analytics/survivor-call-patterns", async (req, res) => {
    try {
      const allProfiles = await storage.getProfiles();
      const validProfiles = allProfiles.filter(p => (p.accountStatus ?? "").toLowerCase() === "valid");

      // Parse first "Added:" date from notes (same logic as frontend parseFirstAddedDate)
      function parseFirstAdded(notes: string | null | undefined): Date | null {
        if (!notes) return null;
        const m = notes.match(/Added[^:]*:\s*(\d{4}-\d{2}-\d{2})/);
        if (!m) return null;
        const d = new Date(m[1]);
        return isNaN(d.getTime()) ? null : d;
      }

      // Filter to accounts with an "Added:" date — same criterion as Survivors tab
      const survivors = validProfiles
        .filter(p => parseFirstAdded(p.notes) !== null)
        .slice(0, 30); // cap at 30

      const now = new Date();
      const results = await Promise.all(survivors.map(async p => {
        const firstDate = parseFirstAdded(p.notes);
        const accountAgeDays = firstDate ? Math.floor((now.getTime() - firstDate.getTime()) / 86400000) : null;
        const allCalls = await storage.getInstagramApiCallsByProfile(p.id, 2000).catch(() => []);
        const calls = allCalls.filter((c: { source?: string | null }) => c.source !== "HikerAPI");
        const snapshot = JSON.stringify(calls.map((c: { operationName: string; date: string; source?: string | null }) => ({
          operationName: c.operationName,
          date: c.date,
          source: c.source ?? null,
        })));
        return {
          profileId: p.id,
          username: p.username,
          accountAgeDays,
          endpointCount: calls.length,
          endpointSnapshot: snapshot,
          capturedAt: now.toISOString(),
          userAgentApi: (p as any).userAgentApi ?? null,
          userAgentEmbedded: (p as any).userAgentEmbedded ?? null,
          igDeviceState: (p as any).igDeviceState ?? null,
          ebFingerprint: (p as any).ebFingerprint ?? null,
          leakSnapshot: (p as any).leakSnapshot ?? null,
        };
      }));

      res.json(results);
    } catch (err) {
      req.log.error({ err }, "[survivor-patterns] error");
      res.status(500).json({ error: "Failed to fetch survivor call patterns" });
    }
  });

  // ── Analytics entry deletion ──────────────────────────────────────────────
  app.delete("/api/analytics/ban-patterns/:id", async (req, res) => {
    try {
      await storage.deleteBanAnalytics(Number(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "[ban-analytics] delete error");
      res.status(500).json({ error: "Failed to delete ban entry" });
    }
  });

  app.delete("/api/analytics/automated-patterns/:id", async (req, res) => {
    try {
      await storage.deleteAutomatedBehaviourAnalytics(Number(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "[automated-analytics] delete error");
      res.status(500).json({ error: "Failed to delete automated entry" });
    }
  });

  app.delete("/api/analytics/captcha-patterns/:id", async (req, res) => {
    try {
      await storage.deleteCaptchaAnalytics(Number(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "[captcha-analytics] delete error");
      res.status(500).json({ error: "Failed to delete captcha entry" });
    }
  });

  app.delete("/api/analytics/locked-patterns/:id", async (req, res) => {
    try {
      await storage.deleteLockedAnalytics(Number(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "[locked-analytics] delete error");
      res.status(500).json({ error: "Failed to delete locked entry" });
    }
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

    // Navigate the open EB window to the login page (clears Electron session
    // cookies too) so the user sees the login screen immediately.
    await navigateEbToLogin(profileId).catch(() => {});
    console.log(`[profiles] @${profile.username}: session fully cleared — igApiCookies null, Chrome userdata wiped, EB navigated to login`);
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
      username:      profile.username,
      password:      profile.password,
      twoFAKey:      profile.twoFASecretKey ?? "",
      proxy:         resolvedEbProxy
        ? { host: resolvedEbProxy.host, port: resolvedEbProxy.port, user: resolvedEbProxy.username, pass: resolvedEbProxy.password, type: resolvedEbProxy.type }
        : undefined,
      userAgent:     profile.userAgentEmbedded ?? "",
      apiUA:         profile.userAgentApi      ?? undefined,
      ebFingerprint: profile.ebFingerprint     ?? undefined,
    };
    // Log the EB login attempt as an API call so Evasion Stats can account for the
    // Instagram requests the embedded browser makes during the login flow.
    storage.createInstagramApiCall({
      profileId,
      username: profile.username ?? "",
      operationName: "eb/auto-login",
      date: new Date().toISOString(),
      source: "EB",
      message: "EB auto-login initiated",
    }).catch(() => {});

    try {
      const r = await fetch(`http://127.0.0.1:${ipcPort}/eb/auto-login`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({ ok: false, message: "IPC parse error" }));
      // Log the result so we can see successful vs failed EB logins in the API call log.
      storage.createInstagramApiCall({
        profileId,
        username: profile.username ?? "",
        operationName: "eb/auto-login-result",
        date: new Date().toISOString(),
        source: "EB",
        message: data?.ok ? "EB auto-login completed" : `EB auto-login failed: ${data?.message ?? "unknown"}`,
      }).catch(() => {});
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
      userAgent:     profile.userAgentEmbedded ?? null,
      apiUA:         profile.userAgentApi      ?? null,
      ebFingerprint: profile.ebFingerprint     ?? null,
      useHomeIp:     !!(profile as any).useHomeIp,
    });
  });

  // ── Manual EB Slot Acquire / Release ─────────────────────────────────────
  // Called by Electron main before opening a manual EB window.
  // Same slot limit as verify and automation.
  // Force-releases (no cooldown) on window close — manual browsing
  // should not block automation from starting immediately after.

  app.post("/api/profiles/:id/eb-slot-acquire", async (req, res) => {
    const profileId = Number(req.params.id);
    const profile   = await storage.getProfile(profileId);
    if (!profile) return res.status(404).json({ ok: false, reason: "Profile not found" });

    const proxyId = (profile as any).proxyId as number | null | undefined;
    if (!proxyId) return res.json({ ok: true, proxyId: null });

    const check = proxySlotManager.canAcquire(proxyId, profileId);
    if (!check.ok) return res.status(429).json({ ok: false, reason: check.reason });

    // clearCooldown=false: preserve any automation-originated cooldown so that
    // closing the EB window later (forceRelease) restores the cooldown rather
    // than silently erasing it.
    proxySlotManager.acquire(proxyId, profileId, false);
    return res.json({ ok: true, proxyId });
  });

  app.post("/api/profiles/:id/eb-slot-release", async (req, res) => {
    const profileId = Number(req.params.id);
    const profile   = await storage.getProfile(profileId);
    if (!profile) return res.status(404).json({ ok: false });

    const proxyId = (profile as any).proxyId as number | null | undefined;
    if (proxyId) proxySlotManager.forceRelease(proxyId, profileId);
    return res.json({ ok: true });
  });

  // ── Proxy Slot Settings & Status ─────────────────────────────────────────
  app.get("/api/proxy-slots/settings", async (_req, res) => {
    const s = proxySlotManager.getSettings();
    res.json({
      enabled:           s.enabled ?? true,
      maxConcurrent:     s.maxConcurrent,
      cooldownMinMins:   s.cooldownMinMs  / 60000,
      cooldownMaxMins:   s.cooldownMaxMs  / 60000,
    });
  });

  app.put("/api/proxy-slots/settings", async (req, res) => {
    const { enabled, maxConcurrent, cooldownMinMins, cooldownMaxMins } = req.body as any;
    const en  = enabled !== undefined ? Boolean(enabled) : (proxySlotManager.getSettings().enabled ?? true);
    const mc  = Math.max(1, parseInt(maxConcurrent  ?? "2",  10) || 2);
    const min = Math.max(0, parseFloat(cooldownMinMins ?? "30") || 30);
    const max = Math.max(min, parseFloat(cooldownMaxMins ?? "35") || 35);
    proxySlotManager.updateSettings({
      enabled: en,
      maxConcurrent: mc,
      cooldownMinMs: Math.round(min * 60000),
      cooldownMaxMs: Math.round(max * 60000),
    });
    await storage.setGlobalSetting("proxySlotEnabled",         String(en));
    await storage.setGlobalSetting("proxySlotMaxConcurrent",   String(mc));
    await storage.setGlobalSetting("proxySlotCooldownMinMins", String(min));
    await storage.setGlobalSetting("proxySlotCooldownMaxMins", String(max));
    res.json({ ok: true, enabled: en, maxConcurrent: mc, cooldownMinMins: min, cooldownMaxMins: max });
  });

  app.get("/api/proxy-slots/status", (_req, res) => {
    const statuses  = proxySlotManager.getStatus();
    const s         = proxySlotManager.getSettings();
    const slots: Record<number, { active: number; onCooldown: number; max: number; available: number; activeProfileIds: number[] }> = {};
    for (const st of statuses) {
      slots[st.proxyId] = { active: st.active, onCooldown: st.onCooldown, max: st.max, available: st.available, activeProfileIds: st.activeProfileIds };
    }
    res.json({ slots, settings: { enabled: s.enabled ?? true, maxConcurrent: s.maxConcurrent, cooldownMinMs: s.cooldownMinMs, cooldownMaxMs: s.cooldownMaxMs } });
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
    // Stale locks (> 10 min) are auto-cleared so a crash in the background worker
    // never permanently blocks re-verify.
    const _existingVerifyStart = verifyInFlight.get(profileId);
    if (_existingVerifyStart && (Date.now() - _existingVerifyStart) < VERIFY_LOCK_TTL_MS) {
      return res.status(429).json({ ok: false, message: "Verification already in progress for this account. Please wait." });
    }
    // Clear any stale lock before setting the fresh one
    verifyInFlight.delete(profileId);
    verifyInFlight.set(profileId, Date.now());

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

    // Block verify if no proxy is configured — never connect via bare server IP.
    // Exception: accounts with useHomeIp=true intentionally bypass the proxy and
    // use the machine's broadband connection directly.
    // NOTE: this check must happen BEFORE setting accountStatus="verifying" so a
    // 400 response never leaves the button stuck on "Verifying".
    if (!effectiveProfile.proxyHost || !effectiveProfile.proxyPort) {
      if (!(effectiveProfile as any).useHomeIp) {
        return fail(400, "No proxy assigned. Assign a proxy to this account before verifying.");
      }
    }

    // Mark as "verifying" in the DB — only reached once proxy is confirmed present.
    // This way the dashboard shows the in-progress state if the user navigates away.
    await storage.updateProfile(profile.id, { accountStatus: "verifying" });


    // ── Jarvee-style EB-first verify ──────────────────────────────────────────
    // Step 1: Launch the embedded browser (headless) for this profile.
    // Step 2: Auto-login via Instagram web (handles 2FA, challenges, etc.)
    // Step 3: Extract sessionid/csrftoken/ds_user_id from the browser.
    // Step 4: Hand those cookies to the API client — account marked valid.
    // This is exactly how Jarvee authenticates: EB logs in first, then the API
    // uses the browser-generated session cookies for all follow/like/DM actions.

    // When useHomeIp is true the account deliberately skips the proxy and uses
    // the machine's home broadband — proxyConfig stays undefined.
    const proxyConfig: ProxyConfig | undefined = (effectiveProfile as any).useHomeIp
      ? undefined
      : effectiveProfile.proxyHost ? {
          host: effectiveProfile.proxyHost,
          port: effectiveProfile.proxyPort!,
          username: effectiveProfile.proxyUsername ?? undefined,
          password: effectiveProfile.proxyPassword ?? undefined,
          type: ((effectiveProfile as any).proxyType === "socks5" ? "socks5" : "http") as "http" | "socks5",
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

    // Return immediately — the browser login + mobile API confirm runs in the background.
    // The accounts list is polled every 5 s so the UI picks up the real result automatically.
    res.json({ ok: true, message: "Verification started" });

    setImmediate(async () => { try {
    // Steps 1-2: Launch EB + auto-login via the visible embedded browser.
    // The visible EB handles the cookie consent banner, credential entry, 2FA,
    // and any challenges — exactly as the user would see it.
    let result: { ok: boolean; message: string; accountStatus: string; igApiCookies?: string; checkpointUrl?: string };
    let loginResult: { ok: boolean; message: string };
    let _silentCookies: Array<{ name: string; value: string }> | null = null;

    // Proxy slot enforcement — check before opening EB / running mobile API.
    // Verify opens a Chromium window and makes mobile API calls, so it counts
    // as a full slot occupant. If the proxy is at capacity, block the request.
    if (effectiveProfile.proxyId) {
      const slotCheck = proxySlotManager.canAcquire(effectiveProfile.proxyId, profileId);
      if (!slotCheck.ok) {
        verifyInFlight.delete(profileId);
        return res.status(429).json({ ok: false, message: `Proxy slot unavailable: ${slotCheck.reason}` });
      }
      proxySlotManager.acquire(effectiveProfile.proxyId, profileId);
    }

    if (process.env.EB_IPC_PORT) {
      // Electron mode — auto-open the visible EB, run login, harvest cookies, auto-close.
      const _verifyIpcPort = Number(process.env.EB_IPC_PORT);

      // Acquire the slot BEFORE opening the EB window.
      // Previously the slot was acquired after /eb/open, which meant clicking Verify
      // on 6 accounts simultaneously opened 6 Chromium instances at once — exactly
      // the crash pattern documented in replit.md (main process killed by parallel
      // BrowserWindow spawns).  Gating here ensures at most 1 Chromium verify
      // window is ever open at a time; accounts 2–N queue here and wait.
      console.log(`[verify:${profileId}] @${profile.username} — waiting for verify slot`);
      await acquireSilentVerifySlot();
      console.log(`[verify:${profileId}] @${profile.username} — verify slot acquired`);

      // Step 1: open the visible EB browser so the user can watch the login flow.
      try {
        console.log(`[verify:${profileId}] @${profile.username} — opening EB window via /eb/open`);
        await fetch(`http://127.0.0.1:${_verifyIpcPort}/eb/open`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profileId,
            username: profile.username,
            // NOTE: password is intentionally NOT passed here.
            // Passing password registers openEbWindow's did-navigate auto-fill handler,
            // which conflicts with doAutoLogin — both fire simultaneously and try to fill
            // the same login form, causing both to silently fail (garbled input, missed
            // fields).  doAutoLogin (called from /eb/silent-verify) is the sole owner of
            // form interaction during the verify flow.
            proxy:      proxyConfig ? { host: proxyConfig.host, port: proxyConfig.port, user: proxyConfig.username, pass: proxyConfig.password } : undefined,
            useHomeIp:  !!(effectiveProfile as any).useHomeIp,
            userAgent:  ebUA,
            apiUA:      effectiveProfile.userAgentApi ?? undefined,
            // Opens a small (430×700) corner window so the user can watch without
            // blocking their screen.  The window is fully visible — NOT minimised —
            // so Chromium does not throttle it (minimised windows throttle timers
            // causing the form-fill to type the password into the username field).
            verifyMode: true,
          }),
        });
        console.log(`[verify:${profileId}] @${profile.username} — /eb/open responded OK, waiting 3 s for window init`);
        // Allow the BrowserWindow and its session to fully initialise before verify runs.
        await new Promise(r => setTimeout(r, 3000));
      } catch (openErr: any) {
        console.warn(`[verify:${profileId}] @${profile.username} — /eb/open failed (non-fatal): ${openErr?.message}`);
      }
      try {
        console.log(`[verify:${profileId}] @${profile.username} — calling electronSilentVerify`);
        const silentRes = await electronSilentVerify({
          profileId,
          username:  profile.username,
          password:  profile.password!,
          twoFAKey:  profile.twoFASecretKey || "",
          proxy:     proxyConfig ? { host: proxyConfig.host, port: proxyConfig.port, user: proxyConfig.username, pass: proxyConfig.password } : undefined,
          userAgent: ebUA,
        });
        console.log(`[verify:${profileId}] @${profile.username} — electronSilentVerify done: ok=${silentRes.ok} msg="${silentRes.message}" cookies=${silentRes.cookies.length} (${silentRes.cookies.map(c => c.name).join(",")})`);
        loginResult    = { ok: silentRes.ok, message: silentRes.message };
        _silentCookies = silentRes.cookies;
      } catch (ebErr: any) {
        loginResult = { ok: false, message: ebErr?.message ?? "Browser verify failed" };
      } finally {
        releaseSilentVerifySlot();
        // Step: auto-close the EB now that cookies are harvested — the mobile API
        // confirmation step does not need the browser open.
        fetch(`http://127.0.0.1:${_verifyIpcPort}/eb/close`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ profileId }),
        }).catch(() => {});
      }
    } else {
      // Puppeteer / dev mode — use the visible EB window.
      try {
        await getOrCreateSession(profileId, ebUA, proxyConfig, effectiveProfile.userAgentApi);
      } catch (ebErr: any) {
        await storage.updateProfile(profile.id, { accountStatus: "pending" });
        verifyInFlight.delete(profileId);
        return;
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

    // Step 3: Extract cookies and build result.
    // Proceed to the mobile API call whenever sessionid is present in the harvested
    // cookies — even when loginResult.ok=false.  Instagram often redirects through
    // accounts/suspended or challenge pages AFTER a successful login; the sessionid
    // cookie is already set at that point.  The mobile API is the authoritative judge
    // of whether the account is actually banned — the browser URL alone is not enough.
    const _silentSessionPresent = !!(_silentCookies?.some(c => c.name === "sessionid"));
    console.log(`[verify:${profileId}] @${profile.username} — step 3: loginResult.ok=${loginResult.ok} silentSessionPresent=${_silentSessionPresent} msg="${loginResult.message}"`);
    if (loginResult.ok || _silentSessionPresent) {
      const rawCookies = _silentCookies ?? await getSessionPageCookies(profileId);
      console.log(`[verify:${profileId}] @${profile.username} — rawCookies (${rawCookies.length}): [${rawCookies.map(c => c.name).join(",")}]`);
      const sessionid = rawCookies.find(c => c.name === "sessionid")?.value;
      const csrftoken = rawCookies.find(c => c.name === "csrftoken")?.value;
      const dsUserId  = rawCookies.find(c => c.name === "ds_user_id")?.value;
      const mid       = rawCookies.find(c => c.name === "mid")?.value;

      if (!sessionid) {
        console.warn(`[verify:${profileId}] @${profile.username} — no sessionid in cookies — aborting`);
        result = {
          ok: false,
          accountStatus: "pending",
          message: `@${profile.username} — browser login appeared to succeed but no sessionid cookie was found. Try again.`,
        };
      } else {
        console.log(`[verify:${profileId}] @${profile.username} — sessionid found, building igApiCookies and calling verifyInstagramCredentials`);
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

        // Disable API mode: skip mobile API entirely — EB login + cookie harvest is
        // sufficient to mark the account valid.  No cold-start sequence is run.
        if ((effectiveProfile.apiLimits as any)?.disableApi === true) {
          console.log(`[verify:${profileId}] @${profile.username} — Disable API mode: skipping mobile API, marking valid from EB cookies`);
          const disableApiMsg = `@${profile.username} — EB login confirmed (Disable API mode — browser-only)`;
          sendLoginDone(profileId, true, disableApiMsg);
          await storage.updateProfile(profile.id, { accountStatus: "valid", statusMessage: disableApiMsg, credentialsDirty: false });
          verifyInFlight.delete(profileId);
          return;
        }

        // Fire-and-forget: run the full leak test (WebRTC, Bot, Canvas, etc.) in a
        // hidden background context while verifyInstagramCredentials runs in parallel.
        // The partition already has the correct proxy set from the verify flow above,
        // so all network tests go through the proxy automatically.
        // Results are persisted via saveLeakSnapshot when complete.
        void (async () => {
          try {
            const _proxyStr = proxyConfig ? `${proxyConfig.host}:${proxyConfig.port}` : null;
            const _proxyType = proxyConfig?.type ?? "http";
            const results = await runSilentLeakTest(profileId, {
              proxy:     _proxyStr,
              proxyType: _proxyType,
              ebUA:      effectiveProfile.userAgentEmbedded ?? null,
              apiUA:     effectiveProfile.userAgentApi      ?? null,
            });
            if (!results || Object.keys(results).length === 0) return;
            const snapshot = JSON.stringify({
              capturedAt: new Date().toISOString(),
              source:     "browser-silent",
              proxy:      _proxyStr,
              proxyType:  _proxyType,
              ebUA:       effectiveProfile.userAgentEmbedded ?? null,
              apiUA:      effectiveProfile.userAgentApi      ?? null,
              results,
            });
            await storage.saveLeakSnapshot(profileId, snapshot);
            console.log(`[verify:${profileId}] silent leak test saved — ${Object.keys(results).length} results`);
          } catch (leakErr: any) {
            console.warn(`[verify:${profileId}] silent leak test failed (non-fatal): ${leakErr?.message}`);
          }
        })();

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
          return;
        }
        result = {
          ...apiResult,
          // Always carry the fresh EB cookies forward regardless of API result —
          // they're needed for the next attempt if the API call transiently failed.
          igApiCookies: freshCookies,
        };

        // Status reconciliation: when the mobile API says automated_behaviour_detected
        // but the EB URL was accounts/suspended (the "Confirm you're human" page), the
        // two signals agree that there is a challenge — but the EB URL tells us the
        // specific challenge TYPE the user needs to resolve.  accounts/suspended is a
        // basic human-verification prompt (click Continue), NOT an ABD flag caused by
        // this tool's activity.  Showing "AUTO BEHAV" in the UI misleads the user into
        // thinking their account was flagged for bot behaviour when in fact they just
        // need to click Continue in the browser.
        // Rule: if the EB message contains accounts/suspended and the mobile API says
        // automated_behaviour_detected, override the status to confirm_human.
        if (
          result.accountStatus === "automated_behaviour_detected" &&
          /accounts\/suspended/i.test(loginResult.message ?? "")
        ) {
          console.log(`[verify:${profileId}] @${profile.username} — ABD overridden to confirm_human (EB URL was accounts/suspended)`);
          result = { ...result, accountStatus: "confirm_human" };
        }
      }
    } else {
      // Classify the failure
      const msg = loginResult.message ?? "";
      let accountStatus = "locked";
      if (/2fa|two.factor|two_factor/i.test(msg))                              accountStatus = "2fa_verification";
      else if (/challenge|checkpoint/i.test(msg))                               accountStatus = "captcha";
      else if (/permanently disabled|Account permanently disabled/i.test(msg))  accountStatus = "account_disabled";
      else if (/suspended/i.test(msg))                                          accountStatus = "suspended";
      else if (/human.*verif|confirm.*human|human verification/i.test(msg))     accountStatus = "confirm_human";
      else if (/aborted|timed?\s*out|ipc error|operation.*aborted/i.test(msg))  accountStatus = "pending";
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

    if (finalStatus === "banned" || finalStatus === "suspended") {
      // Full ban pipeline: snapshot API calls + analytics + proxy taint
      await triggerBanPipeline(profile.id, "verify").catch((e: any) =>
        console.error(`[verify] triggerBanPipeline failed for @${profile.username}: ${e?.message}`)
      );
      // Still persist any device state / cookies from the result — but only if
      // there is something to write.  updateProfile({}) throws "No values to set"
      // which was crashing the verify flow and resetting the status to "pending".
      const _banExtra: Record<string, unknown> = {};
      if (result.igDeviceState)                                    _banExtra.igDeviceState = result.igDeviceState;
      if ("igApiCookies" in result && result.igApiCookies)         _banExtra.igApiCookies  = result.igApiCookies;
      if (Object.keys(_banExtra).length > 0) {
        await storage.updateProfile(profile.id, _banExtra as any);
      }
    } else {
      await storage.updateProfile(profile.id, {
        accountStatus: finalStatus,
        ...(finalStatus === "valid" ? { credentialsDirty: false } : {}),
        ...(result.igDeviceState ? { igDeviceState: result.igDeviceState } : {}),
        // Save session cookies captured from the fresh login so follow/DM tools
        // can restore the session on Path 2 without re-logging in.
        ...("igApiCookies" in result && result.igApiCookies ? { igApiCookies: result.igApiCookies } : {}),
      });
      // Reset the automation engine's warmed IgApiClient cache so the next DM/inbox
      // call gets a fresh cold-start bootstrap with the new session cookies.
      // This prevents the double-FetchConfig: verify runs FetchConfig in Phase 2b,
      // then the old stale cache would have caused _buildWarmedIgClient to run it again.
      automationEngine.invalidateWarmedClientCache(profile.id);
    }

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

    // If Instagram returned a checkpoint URL, cache it so the EB navigates there directly
    // on next open (bypassing the 429 rate-limit on the home page)
    if (!result.ok && result.accountStatus === "captcha" && result.checkpointUrl) {
      setCheckpointUrl(profile.id, result.checkpointUrl);
    }

    } catch (_topVerifyErr: any) {
      console.error(`[verify:${profileId}] unhandled crash in background verify — clearing lock:`, _topVerifyErr?.message ?? _topVerifyErr);
      await storage.updateProfile(profileId, { accountStatus: "pending" }).catch(() => {});
    } finally {
      verifyInFlight.delete(profileId);
      // Release the proxy slot and start the cooldown timer — verify/EB activity
      // counts as IP usage, so the slot must cool down before another account
      // can use this proxy slot.
      if (effectiveProfile.proxyId) {
        proxySlotManager.release(effectiveProfile.proxyId, profileId);
      }
    }
    }); // end setImmediate
  }); // end app.post

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
            // Auto-assign a paired mobile Android Chrome UA when the import source
            // doesn't supply one.  Deterministic so the same username always gets the
            // same device profile — stable across re-imports.  All accounts (including
            // disableApi=true) get mobile UAs; desktop UAs cause hardware-mismatch
            // fingerprint signals on the ARM Mac server.
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
            // Preserve the original "first added" stamp and append a re-import timestamp.
            // Never overwrite — only append so the full history is preserved.
            {
              const now = new Date();
              const pad = (n: number) => String(n).padStart(2, "0");
              const stamp = `Re-imported: ${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`;
              const base = existing.notes && String(existing.notes).trim() ? String(existing.notes).trim() : null;
              updates.notes = base ? `${base}\n${stamp}` : stamp;
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
      } else if (input.enabled === false && updated.type === "human_sessions") {
        // Manual toggle-OFF: kick an immediate reconcile so the HS runner's stop flag is
        // set right away.  Without this the runner can remain alive for up to 10 s
        // (the scheduled reconcile interval), and if the user quickly toggles back ON
        // during that window triggerHumanSession finds a live-but-stopping runner and
        // just resets its timer instead of launching a fresh immediate one.
        automationEngine.triggerReconcile();
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

  app.delete('/api/tools/:toolId/sources', async (req, res) => {
    const toolId = Number(req.params.toolId);
    await storage.deleteSourcesByTool(toolId);
    res.status(204).end();
  });

  app.delete('/api/tools/:toolId/sources/type/:type', async (req, res) => {
    const toolId = Number(req.params.toolId);
    const type = req.params.type;
    await storage.deleteSourcesByToolAndType(toolId, type);
    res.status(204).end();
  });

  app.delete(api.sources.delete.path, async (req, res) => {
    await storage.deleteSource(Number(req.params.id));
    res.status(204).end();
  });

  app.patch('/api/sources/:id', async (req, res) => {
    const id = Number(req.params.id);
    const { rank, enabled } = req.body as { rank?: number | null; enabled?: boolean };
    await storage.updateSource(id, { rank, enabled });
    res.json({ ok: true });
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
    req.log.info({ query: req.query }, "[export-api-calls] route hit");
    try {
      req.log.info("[export-api-calls] fetching profiles and proxies");
      const [allProfiles, allProxies] = await Promise.all([
        storage.getProfiles(),
        storage.getProxies(),
      ]);
      req.log.info({ profileCount: allProfiles.length, proxyCount: allProxies.length }, "[export-api-calls] profiles/proxies loaded");
      const profileMap = new Map(allProfiles.map(p => [p.id, p]));
      const proxyMap = new Map(allProxies.map(p => [p.id, p]));
      req.log.info("[export-api-calls] calling storage.getInstagramApiCalls(100000)");
      const allApiCalls = await storage.getInstagramApiCalls(100000);
      req.log.info({ totalApiCalls: allApiCalls.length }, "[export-api-calls] api calls loaded");

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
        "GetTokenResult",          // zr/token/result — anonymous zero-rating probe, non-fatal
        "GetKeyedTokens",          // accounts/tokens/keyed — separate authenticated endpoint, non-fatal
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
        "FetchConfig",             // qe/sync — 400 "Invalid experiment" is non-fatal
        "QeSync",                  // alternate name for qe/sync
        "QeSyncExperiments",       // qe/sync_experiments — same non-fatal 400
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
      req.log.info({ filteredCount: apiCalls.length, requestedIds }, "[export-api-calls] filtered api calls ready");

      const headers = [
        "UniqueNameAccount", "Date", "Name", "Operation Name", "API Call",
        "Message", "Source", "IpAddress", "Duration(miliseconds)", "Transport"
      ];

      // "Operation Name" is the tool that made the call.  "API Call" is the raw endpoint.
      // Source-to-tool-name mapping:
      const resolveOperationName = (source: string, operationName: string): string => {
        if (source === "Verify")    return "Verify Account";
        if (source === "HikerAPI")  return "HikerAPI";
        if (source === "Browser")   return "Browser Session";
        if (source === "ProfileSync") return "Profile Sync";
        if (source === "Human Session Emulation") return "Human Session Tool";
        if (source === "Follow Tool")   return "Follow Tool";
        if (source === "Unfollow Tool") return "Unfollow Tool";
        if (source === "Contact Tool")  return "Contact Tool";
        if (source === "Ghost Browser") {
          if (operationName === "follow" || operationName === "follow_skipped") return "Follow Tool";
          if (operationName === "contact_dm") return "Contact Tool";
          return "Human Session Tool";
        }
        // Legacy / untagged calls — fall back to the operation name itself
        return operationName;
      };

      // Source column: show "HikerAPI" for HikerAPI-fetched data, "Equinox" for
      // everything else (engine, verify, browser, sync, emulation, tools, etc.)
      const resolveSource = (source: string): string =>
        source === "HikerAPI" ? "HikerAPI" : "Equinox";

      const esc = (v: unknown) => {
        const s = v == null ? "" : String(v);
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };

      req.log.info("[export-api-calls] fetching global settings for timezone");
      const settings = await storage.getGlobalSettings();
      const useLocal = settings.useLocalTime === "true";
      // ?tz= is JS getTimezoneOffset() — minutes WEST of UTC (negative for UTC+)
      const browserTzMins = useLocal ? parseInt((req.query as any).tz ?? "0", 10) : 0;
      const offsetMins = -browserTzMins; // convert to minutes EAST (positive = UTC+)
      req.log.info({ useLocal, browserTzMins, offsetMins }, "[export-api-calls] timezone resolved, building CSV rows");

      const csvRows = apiCalls.map((call: any) => {
        const profile = profileMap.get(call.profileId);
        const username = profile?.username ?? String(call.profileId);

        const rawDate = call.date ? new Date(call.date).getTime() : Date.now();
        const localMs = (isNaN(rawDate) ? Date.now() : rawDate) + offsetMins * 60 * 1000;
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

        const isError = !!(call.isError);
        // Fold error status into the message so there is one authoritative column.
        // NOISY_FAILED_OPS already had their messages replaced with "OK" — they are
        // non-fatal 4xx probes, so no ERROR prefix is added even though isError=true.
        // Real failures get "ERROR: " prepended so the cell is unambiguous.
        const rawMsg = call.message ?? "";
        const msgCell = (isError && rawMsg !== "OK") ? `ERROR: ${rawMsg}` : rawMsg;

        return [
          `Instagram_${call.profileId}`,
          date,
          username,
          resolveOperationName(call.source ?? "", call.operationName ?? ""),
          call.operationName ?? "",
          msgCell,
          resolveSource(call.source ?? ""),
          ipPort,
          String(call.durationMs ?? ""),
          call.source === "HikerAPI" ? "HikerAPI" :
          call.transport === "ja3" ? "JA3 (OkHttp4)" :
          call.transport ? call.transport : "—",
        ].map(esc).join(",");
      });

      const content = [headers.map(esc).join(","), ...csvRows].join("\r\n");
      const file = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, "utf8")]);

      const filename = `api_calls_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`;
      req.log.info({ filename, rowCount: csvRows.length, fileSizeBytes: file.length }, "[export-api-calls] CSV built — sending response");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.send(file);
      req.log.info("[export-api-calls] response sent OK");
    } catch (err) {
      req.log.error({ err }, "[export-api-calls] route threw — this is why Export API Calls failed");
      console.error("[export-api-calls] route threw:", err);
      res.status(500).json({ message: "Export failed", detail: String(err) });
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
    const proxyForEb = await resolveProxyConfig(profile);
    if (!proxyForEb && !(profile as any).useHomeIp) return res.status(403).json({ error: "No proxy assigned — assign a proxy to this account before using the embedded browser." });
    // ── UA BLOCK — per USER-AGENT RULE ─────────────────────────────────────────
    if (!profile.userAgentEmbedded) {
      return res.status(403).json({ error: "No EB User-Agent configured for this account. Assign a unique User-Agent before opening the embedded browser." });
    }
    const ua = profile.userAgentEmbedded as string;
    try {
      await getOrCreateSession(profileId, ua, proxyForEb, profile.userAgentApi);
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
          if (/2fa|two.factor|two_factor/i.test(msg))                              accountStatus = "2fa_verification";
          else if (/challenge|checkpoint/i.test(msg))                               accountStatus = "captcha";
          else if (/permanently disabled|Account permanently disabled/i.test(msg))  accountStatus = "account_disabled";
          else if (/suspended/i.test(msg))                                          accountStatus = "suspended";
          else if (/human.*verif|confirm.*human|human verification/i.test(msg))     accountStatus = "confirm_human";
          else if (/aborted|timed?\s*out|ipc error|operation.*aborted/i.test(msg))  accountStatus = "pending";
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
    const _wipeId = Number(req.params.profileId);
    await wipeEbSession(_wipeId);
    // Clear any in-flight verify lock — wipe invalidates the session so a
    // stuck verify from before the wipe must not block the next one.
    verifyInFlight.delete(_wipeId);
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
      profileId: number;
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
      profileId,
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

  // Save last leak-check results snapshot for an account
  app.post("/api/profiles/:id/leak-snapshot", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid profileId" });
      const body = req.body as { snapshot?: string };
      if (!body?.snapshot) return res.status(400).json({ error: "Missing snapshot" });
      await storage.saveLeakSnapshot(id, body.snapshot);
      res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "[leak-snapshot] error");
      res.status(500).json({ error: "Failed to save leak snapshot" });
    }
  });

  // ── Server-side proxy leak check — called at export time, no browser needed ──
  // Runs IP/DNS checks through each account's proxy using Node.js https.request
  // + HttpsProxyAgent / SocksProxyAgent. Saves the result to leakSnapshot in the
  // DB and returns a fresh map so the export can include the latest data.
  app.post("/api/analytics/refresh-leak-snapshots", async (req, res) => {
    try {
      const { profileIds } = req.body as { profileIds?: number[] };
      if (!Array.isArray(profileIds) || profileIds.length === 0) {
        return res.status(400).json({ error: "profileIds required" });
      }

      const https = await import("node:https");

      // Makes one HTTPS request through a proxy agent, returns the body text or null on failure.
      async function proxyGet(url: string, agent: any, timeoutMs = 9000): Promise<string | null> {
        const parsed = new URL(url);
        return new Promise(resolve => {
          try {
            const req2 = https.request(
              {
                host: parsed.hostname,
                port: 443,
                path: parsed.pathname + parsed.search,
                method: "GET",
                agent,
                rejectUnauthorized: false,
                headers: { "User-Agent": "curl/7.68.0", Accept: "*/*" },
              },
              (r) => {
                const chunks: Buffer[] = [];
                r.on("data", (c: Buffer) => chunks.push(c));
                r.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
                r.on("error", () => resolve(null));
              },
            );
            req2.on("error", () => resolve(null));
            req2.setTimeout(timeoutMs, () => { req2.destroy(); resolve(null); });
            req2.end();
          } catch { resolve(null); }
        });
      }

      type IpResult = { source: string; ip: string | null; ok: boolean };

      async function checkProfile(profileId: number): Promise<{ username: string; snapshot: string } | null> {
        const profile = await storage.getProfile(profileId).catch(() => null);
        if (!profile) return null;

        const capturedAt = new Date().toISOString();

        // Resolve proxy details — profile columns first, then linked proxy table
        let proxyHost: string | null = (profile as any).proxyHost || null;
        let proxyPort: number | null = (profile as any).proxyPort || null;
        let proxyType: string = (profile as any).proxyType || "http";
        let proxyUser: string | null = (profile as any).proxyUsername || null;
        let proxyPass: string | null = (profile as any).proxyPassword || null;

        if (!proxyHost && profile.proxyId) {
          try {
            const [linked] = await db.select().from(proxies).where(eq(proxies.id, profile.proxyId));
            if (linked) {
              proxyHost = linked.host;
              proxyPort = linked.port;
              proxyType = (linked as any).proxyType || "http";
              proxyUser = (linked as any).username || null;
              proxyPass = (linked as any).password || null;
            }
          } catch {}
        }

        if (!proxyHost || !proxyPort) {
          const _ebUA  = (profile as any).userAgentEmbedded ?? null;
          const _apiUA = (profile as any).userAgentApi ?? null;
          let _igDs: Record<string, unknown> | null = null;
          try { const r = (profile as any).igDeviceState; if (r) _igDs = typeof r === "string" ? JSON.parse(r) : r; } catch {}
          const snapshot = JSON.stringify({
            capturedAt, source: "server-side", proxyConfigured: false,
            ebUA: _ebUA, apiUA: _apiUA, igDeviceState: _igDs,
            ebFingerprint: (profile as any).ebFingerprint ?? null,
            results: {
              Proxy:   { status: "warn", label: "No proxy configured" },
              IP:      { status: "na",   label: "No proxy — cannot test" },
              DNS:     { status: "na",   label: "No proxy — cannot test" },
              IPMatch: { status: "na",   label: "No proxy — cannot test" },
              UAMatch: _ebUA ? { status: "info", label: `EB UA configured` } : { status: "warn", label: "No EB UA set" },
              WebRTC:  { status: "na",   label: "Requires browser session" },
              Bot:     { status: "na",   label: "Requires browser session" },
              Canvas:  { status: "na",   label: "Requires browser session" },
              Audio:   { status: "na",   label: "Requires browser session" },
              Timezone:{ status: "na",   label: "Requires browser session" },
              Hardware:{ status: "na",   label: "Requires browser session" },
            },
          });
          await storage.saveLeakSnapshot(profileId, snapshot).catch(() => {});
          return { username: profile.username, snapshot };
        }

        const auth = proxyUser && proxyPass
          ? `${encodeURIComponent(proxyUser)}:${encodeURIComponent(proxyPass)}@`
          : "";
        const proxyUrl = `${proxyType === "socks5" ? "socks5" : "http"}://${auth}${proxyHost}:${proxyPort}`;

        let agent: any;
        try {
          if (proxyType === "socks5") {
            const { SocksProxyAgent } = await import("socks-proxy-agent");
            agent = new SocksProxyAgent(proxyUrl);
          } else {
            const { HttpsProxyAgent } = await import("https-proxy-agent");
            agent = new HttpsProxyAgent(proxyUrl, { keepAlive: false });
          }
        } catch {
          const _ebUA2  = (profile as any).userAgentEmbedded ?? null;
          const _apiUA2 = (profile as any).userAgentApi ?? null;
          let _igDs2: Record<string, unknown> | null = null;
          try { const r = (profile as any).igDeviceState; if (r) _igDs2 = typeof r === "string" ? JSON.parse(r) : r; } catch {}
          const snapshot = JSON.stringify({
            capturedAt, source: "server-side", proxyConfigured: true,
            proxy: `${proxyHost}:${proxyPort}`, proxyType,
            ebUA: _ebUA2, apiUA: _apiUA2, igDeviceState: _igDs2,
            ebFingerprint: (profile as any).ebFingerprint ?? null,
            results: {
              Proxy:   { status: "fail", label: "Agent init failed" },
              IP:      { status: "fail", label: "Proxy agent init failed" },
              DNS:     { status: "fail", label: "Proxy agent init failed" },
              IPMatch: { status: "na",   label: "Cannot test — proxy failed" },
              UAMatch: _ebUA2 ? { status: "info", label: `EB UA configured` } : { status: "warn", label: "No EB UA set" },
              WebRTC:  { status: "na",   label: "Requires browser session" },
              Bot:     { status: "na",   label: "Requires browser session" },
              Canvas:  { status: "na",   label: "Requires browser session" },
              Audio:   { status: "na",   label: "Requires browser session" },
              Timezone:{ status: "na",   label: "Requires browser session" },
              Hardware:{ status: "na",   label: "Requires browser session" },
            },
          });
          await storage.saveLeakSnapshot(profileId, snapshot).catch(() => {});
          return { username: profile.username, snapshot };
        }

        // Run 3 IP endpoints in parallel through the proxy
        const [ipifyRaw, cfRaw, myipRaw] = await Promise.all([
          proxyGet("https://api.ipify.org?format=text", agent),
          proxyGet("https://1.1.1.1/cdn-cgi/trace", agent),
          proxyGet("https://api4.my-ip.io/v2/ip.json", agent),
        ]);

        const ipSources: IpResult[] = [
          { source: "ipify",      ip: ipifyRaw?.trim() || null,                                                ok: !!ipifyRaw },
          { source: "cloudflare", ip: cfRaw?.match(/ip=([^\n]+)/)?.[1]?.trim() || null,                       ok: !!cfRaw },
          { source: "myip",       ip: (() => { try { return JSON.parse(myipRaw ?? "")?.ip ?? null; } catch { return myipRaw?.trim() || null; } })(), ok: !!myipRaw },
        ];

        const validIps = ipSources.filter(r => r.ok && r.ip).map(r => r.ip!);
        const uniqueIps = [...new Set(validIps)];
        const exitIp = validIps[0] ?? null;
        const ipStatus = validIps.length === 0 ? "fail" : uniqueIps.length > 1 ? "warn" : "pass";
        const dnsStatus = validIps.length === 0 ? "fail" : uniqueIps.length > 1 ? "warn" : "pass";

        // ── Device data from DB ──────────────────────────────────────────────
        const ebUA  = (profile as any).userAgentEmbedded ?? null;
        const apiUA = (profile as any).userAgentApi ?? null;
        let igDeviceStateParsed: Record<string, unknown> | null = null;
        try {
          const raw = (profile as any).igDeviceState;
          if (raw) igDeviceStateParsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch {}
        const ebFingerprintData = (profile as any).ebFingerprint ?? null;

        // ── IP Match: exit IP vs configured proxy host ───────────────────────
        const ipMatchStatus = !exitIp ? "na"
          : exitIp === proxyHost ? "pass"
          : "warn"; // warn not fail — rotating proxies have different exit IPs
        const ipMatchLabel = !exitIp ? "No IP detected"
          : exitIp === proxyHost ? `Match (${exitIp})`
          : `Exit ${exitIp} ≠ Host ${proxyHost} (may be rotating proxy)`;

        // ── UA analysis: parse Android API UA string for device info ─────────
        // Format: "Android_ver/API_level; DPIdpi; WxH; Brand; Model; Codename; CPU; Locale"
        let uaDeviceRows: Record<string, string> = {};
        if (apiUA) {
          const parts = apiUA.split(";").map((s: string) => s.trim());
          if (parts.length >= 8) {
            uaDeviceRows = {
              "Android / API Level": parts[0] ?? "",
              "DPI":                 parts[1] ?? "",
              "Resolution":          parts[2] ?? "",
              "Brand":               parts[3] ?? "",
              "Model":               parts[4] ?? "",
              "Codename":            parts[5] ?? "",
              "Chipset":             parts[6] ?? "",
              "Locale":              parts[7] ?? "",
            };
          }
        }

        const snapshot = JSON.stringify({
          capturedAt,
          source: "server-side",
          proxyConfigured: true,
          proxy: `${proxyHost}:${proxyPort}`,
          proxyType,
          ebUA,
          apiUA,
          igDeviceState: igDeviceStateParsed,
          ebFingerprint: ebFingerprintData,
          uaDevice: Object.keys(uaDeviceRows).length ? uaDeviceRows : null,
          results: {
            IP:       { status: ipStatus,    label: exitIp ?? "No response" },
            IPMatch:  { status: ipMatchStatus, label: ipMatchLabel },
            DNS:      { status: dnsStatus,   label: uniqueIps.length <= 1 && validIps.length > 0 ? `${validIps.length}/3 consistent` : uniqueIps.length > 1 ? `${uniqueIps.length} different IPs detected` : "No response" },
            Proxy:    { status: validIps.length > 0 ? "pass" : "fail", label: validIps.length > 0 ? `Connected (${proxyHost})` : "Connection failed" },
            UAMatch:  ebUA ? { status: "info", label: `EB UA configured (${ebUA.slice(0, 60)}${ebUA.length > 60 ? "…" : ""})` } : { status: "warn", label: "No EB UA set" },
            WebRTC:   { status: "na", label: "Requires browser session" },
            Bot:      { status: "na", label: "Requires browser session" },
            Canvas:   { status: "na", label: "Requires browser session" },
            Audio:    { status: "na", label: "Requires browser session" },
            Timezone: { status: "na", label: "Requires browser session" },
            Hardware: { status: "na", label: "Requires browser session" },
          },
          ipSources,
        });

        await storage.saveLeakSnapshot(profileId, snapshot).catch(() => {});
        return { username: profile.username, snapshot };
      }

      // Process up to 5 concurrently
      const CONCURRENCY = 5;
      const out: Record<number, { username: string; snapshot: string }> = {};
      for (let i = 0; i < profileIds.length; i += CONCURRENCY) {
        const chunk = profileIds.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(chunk.map(id => checkProfile(id)));
        settled.forEach((r, idx) => {
          if (r.status === "fulfilled" && r.value) out[chunk[idx]] = r.value;
        });
      }

      res.json({ ok: true, count: Object.keys(out).length, results: out });
    } catch (err) {
      req.log.error({ err }, "[refresh-leak-snapshots] error");
      res.status(500).json({ error: "Failed to refresh leak snapshots" });
    }
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
      // No other upgrade handlers — destroy unrecognised upgrade sockets
      socket.destroy();
      return;
    }
    const profileId = Number(match[1]);

    const profile = await storage.getProfile(profileId).catch(() => null);
    if (!profile) { socket.destroy(); return; }

    const proxyForEbWs = await resolveProxyConfig(profile);
    if (!proxyForEbWs && !(profile as any).useHomeIp) {
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
        const proxy = proxyForEbWs;
        // ── UA BLOCK — per USER-AGENT RULE ────────────────────────────────────
        if (!profile.userAgentEmbedded) {
          ws.send(JSON.stringify({ type: "error", message: "No EB User-Agent configured for this account. Assign a unique User-Agent before opening the embedded browser." }));
          ws.close();
          return;
        }
        const ua = profile.userAgentEmbedded as string;
        // Send an immediate acknowledgment so the client shows a launching state
        // rather than a blank spinner while Chrome starts (proxy check + launch
        // can take several seconds on a first open).
        ws.send(JSON.stringify({ type: "launching" }));
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
  // In Electron mode: opens a real Electron BrowserWindow (profileId = -slot) via IPC so that
  // the ghost-signup handler can find it in ebMap.get(-slot).
  // In non-Electron mode: falls back to the Puppeteer headless pipeline.
  app.post("/api/signup/browser/open", async (req, res) => {
    const ipcPort = Number(process.env.EB_IPC_PORT ?? 0);
    const { slot: _slot, proxyHost, proxyPort, proxyUsername, proxyPassword, proxyType, userAgent, initialUrl, fingerprint } = req.body as any;
    const slot = Number(_slot ?? 1) || 1;

    if (ipcPort) {
      // Electron mode — create an Electron BrowserWindow for this ghost slot.
      // profileId=-slot registers it in ebMap so /eb/ghost-signup finds it immediately.
      try {
        const proxy = proxyHost ? {
          host: proxyHost,
          port: Number(proxyPort) || 80,
          type: proxyType ?? "http",
          ...(proxyUsername ? { user: proxyUsername, pass: proxyPassword ?? "" } : {}),
        } : undefined;
        const r = await fetch(`http://127.0.0.1:${ipcPort}/eb/open`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profileId: -slot,
            username: `ghost-${slot}`,
            proxy,
            userAgent,
            ebFingerprint: fingerprint ?? null,
            initialUrl: initialUrl ?? "about:blank",
          }),
        });
        const j = await r.json() as any;
        return res.json(j);
      } catch (err: any) {
        return res.status(500).json({ ok: false, error: err?.message });
      }
    }

    // Non-Electron fallback: Puppeteer headless
    try {
      const result = await openSignupBrowser({ proxyHost, proxyPort, proxyUsername, proxyPassword, userAgent, initialUrl });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message });
    }
  });

  // Status check — lets the frontend detect a running browser after a page reload
  app.get("/api/signup/browser/status", async (req, res) => {
    const ipcPort = Number(process.env.EB_IPC_PORT ?? 0);
    const slot = _getReqSlot(req);
    if (ipcPort) {
      try {
        const r = await fetch(`http://127.0.0.1:${ipcPort}/eb/state?profileId=${-slot}`);
        const j = await r.json() as any;
        return res.json({ running: j.open === true, native: true });
      } catch {
        return res.json({ running: false, native: true });
      }
    }
    res.json({ running: isSignupBrowserOpen(), native: false });
  });

  // Close the standalone signup / Ghost browser
  app.post("/api/signup/browser/close", async (req, res) => {
    const ipcPort = Number(process.env.EB_IPC_PORT ?? 0);
    const slot = _getReqSlot(req);
    if (ipcPort) {
      try {
        await fetch(`http://127.0.0.1:${ipcPort}/eb/close`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profileId: -slot }),
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

  // Reset signup / Ghost browser — wipe session so next open is a fresh device identity.
  // In Electron mode the ghost BrowserWindow is always destroyed and recreated fresh on the
  // next /eb/open call (profileId=-1 special path in openEbWindow), so nothing extra is needed.
  app.post("/api/signup/browser/reset", async (req, res) => {
    const ipcPort = Number(process.env.EB_IPC_PORT ?? 0);
    if (ipcPort) {
      // Close the ghost window if still open so the next open starts truly fresh
      const slot = _getReqSlot(req);
      try {
        await fetch(`http://127.0.0.1:${ipcPort}/eb/close`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profileId: -slot }),
        });
      } catch { /* best effort */ }
      return res.json({ ok: true });
    }
    try {
      await resetSignupBrowser();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message });
    }
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

  // ── Ghost Browser automated signup — per-slot in-memory state ────────────────
  // Keyed by slot number (default 1). Allows up to 5 concurrent ghost browser tabs.
  interface _GhostSlotState {
    code: string | null;
    latestStep: string;
    done: boolean;
    log: string[];
    harvestedCookies: string | null;
  }
  const _ghostState = new Map<number, _GhostSlotState>();

  function _getGhostSlot(slot: number): _GhostSlotState {
    if (!_ghostState.has(slot)) {
      _ghostState.set(slot, { code: null, latestStep: "", done: false, log: [], harvestedCookies: null });
    }
    return _ghostState.get(slot)!;
  }

  function _getReqSlot(req: any): number {
    return Number(req.body?.slot ?? req.query?.slot ?? 1) || 1;
  }

  // Frontend triggers the automated signup flow in the Ghost Browser
  app.post("/api/signup/browser/ghost-signup", async (req, res) => {
    const ipcPort = Number(process.env.EB_IPC_PORT ?? 0);
    if (!ipcPort) return res.json({ ok: false, error: "Not running in Electron mode" });
    const slot = _getReqSlot(req);
    const st = _getGhostSlot(slot);
    st.code = null;
    st.latestStep = "Starting…";
    st.done = false;
    st.log = ["Starting…"];
    st.harvestedCookies = null;
    try {
      const r = await fetch(`http://127.0.0.1:${ipcPort}/eb/ghost-signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...req.body, slot }),
      });
      const j = await r.json() as any;
      return res.json(j);
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message ?? "IPC error" });
    }
  });

  // EB posts progress steps here; frontend polls ghost-signup-status
  app.post("/api/signup/browser/ghost-signup-step", (req, res) => {
    const { msg, done, cookies, slot: _slot } = (req.body ?? {}) as { msg?: string; done?: boolean; cookies?: string; slot?: number };
    const slot = Number(_slot ?? 1) || 1;
    const st = _getGhostSlot(slot);
    if (msg) {
      st.latestStep = msg;
      st.log.push(msg);
      if (st.log.length > 200) st.log = st.log.slice(-200);
      console.log(`[ghost-signup-step slot=${slot}] ${msg}`);
      sendSignupWsMsg({ type: "signupStep", msg });
    }
    if (done) {
      st.done = true;
      // Store harvested cookies if EB provided them
      if (cookies && typeof cookies === "string" && cookies.includes("sessionid=")) {
        st.harvestedCookies = cookies;
        console.log(`[ghost-signup-step slot=${slot}] harvested ${cookies.split(";").length} cookie(s)`);
      }
    }
    return res.json({ ok: true });
  });

  // Frontend polls this to show live status in the Ghost Browser panel
  app.get("/api/signup/browser/ghost-signup-status", (req, res) => {
    const slot = _getReqSlot(req);
    const st = _getGhostSlot(slot);
    return res.json({ ok: true, msg: st.latestStep, done: st.done, log: st.log, running: !!st.latestStep && !st.done });
  });

  // Frontend fetches harvested cookies after "Add to Equinox" (set by relayDone in EB)
  app.get("/api/signup/browser/ghost-cookies", (req, res) => {
    const slot = _getReqSlot(req);
    const st = _getGhostSlot(slot);
    return res.json({ ok: true, cookies: st.harvestedCookies ?? null });
  });

  // Frontend sets the verification code (from IMAP fetch or manual entry)
  app.post("/api/signup/browser/ghost-code", (req, res) => {
    const { code, slot: _slot } = (req.body ?? {}) as { code?: string; slot?: number };
    if (!code) return res.status(400).json({ ok: false, error: "code is required" });
    const slot = Number(_slot ?? 1) || 1;
    _getGhostSlot(slot).code = String(code).trim();
    return res.json({ ok: true });
  });

  // Stop a running ghost signup for a slot
  app.post("/api/signup/browser/ghost-stop", (req, res) => {
    const { slot: _slot } = (req.body ?? {}) as { slot?: number };
    const slot = Number(_slot ?? 1) || 1;
    const st = _getGhostSlot(slot);
    st.done = true;
    st.log.push("🛑 Stopped by user.");
    st.latestStep = "🛑 Stopped by user.";
    sendSignupWsMsg({ type: "signupStep", msg: "🛑 Stopped by user." });
    // Best-effort: tell the EB process to abort
    const ipcPort = Number(process.env.EB_IPC_PORT ?? 0);
    if (ipcPort) {
      fetch(`http://127.0.0.1:${ipcPort}/eb/ghost-stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot }),
      }).catch(() => {});
    }
    return res.json({ ok: true });
  });

  // EB polls this to get the code once the frontend has provided it (consumed on read)
  app.get("/api/signup/browser/ghost-code-peek", (req, res) => {
    const slot = _getReqSlot(req);
    const st = _getGhostSlot(slot);
    const code = st.code;
    if (code) st.code = null;
    return res.json({ ok: true, code: code ?? null });
  });

  // ── IMAP email code fetch ─────────────────────────────────────────────────
  // Connects to the email inbox via IMAP and extracts the 6-digit Instagram
  // verification code from the most recent Instagram email.
  app.post("/api/imap/fetch-code", async (req, res) => {
    const { host, port, secure = true, email, password } = (req.body ?? {}) as {
      host: string; port?: number; secure?: boolean; email: string; password: string;
    };
    if (!host || !email || !password) {
      return res.status(400).json({ ok: false, error: "host, email, and password are required" });
    }
    try {
      const { ImapFlow } = await import("imapflow") as any;
      const client = new ImapFlow({
        host,
        port: Number(port) || (secure ? 993 : 143),
        secure: !!secure,
        auth: { user: email, pass: password },
        logger: false,
        tls: { rejectUnauthorized: false },
      });
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      let code: string | null = null;
      try {
        // Search last 30 minutes (not 20) to give more headroom
        const since = new Date(Date.now() - 30 * 60 * 1000);
        // { uid: true } in the search options returns UIDs instead of sequence numbers
        const uids = await client.search({ since }, { uid: true });
        if (uids && uids.length > 0) {
          // Fetch the last 15 messages, newest first
          const slice = (uids as number[]).slice(-15).reverse();
          // Third arg { uid: true } tells ImapFlow the range contains UIDs, not seq numbers
          for await (const msg of client.fetch(slice, { source: true }, { uid: true })) {
            const src: string = msg.source.toString("utf8");
            // Match standalone 6-digit code; also handle "123 456" spaced format
            const m = src.match(/(?<![.\d])(\d{6})(?![.\d])/)
              ?? src.match(/\b(\d{3})\s+(\d{3})\b/);
            if (m) {
              code = m[2] ? `${m[1]}${m[2]}` : m[1];
              if (/^\d{6}$/.test(code)) break;
              code = null;
            }
          }
        }
      } finally {
        lock.release();
      }
      await client.logout();
      if (code) return res.json({ ok: true, code });
      return res.json({ ok: false, error: "No 6-digit verification code found in the last 30 minutes of email" });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message ?? "IMAP connection failed" });
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

  app.delete("/api/profiles/:id/reposted-posts", async (req, res) => {
    const profileId = Number(req.params.id);
    await storage.deleteAllRepostedPostsByProfile(profileId);
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
    const verifyDelayMode = globalSettings.verifyDelayMode ?? "general";
    const delayMin = parseInt(globalSettings.verifyAllDelayMin ?? "5", 10);
    const delayMax = parseInt(globalSettings.verifyAllDelayMax ?? "15", 10);
    const sameProxyMin = parseInt(globalSettings.sameProxyDelayMin ?? "0", 10);
    const sameProxyMax = parseInt(globalSettings.sameProxyDelayMax ?? "0", 10);
    // groupDelayMin/Max are used between accounts on the same proxy (sameProxy mode)
    // or between every account sequentially (general mode)
    const groupDelayMin = verifyDelayMode === "sameProxy" ? sameProxyMin : delayMin;
    const groupDelayMax = verifyDelayMode === "sameProxy" ? sameProxyMax : delayMax;

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
      // Skip accounts already being verified by a concurrent single-verify call.
      // Stale locks (> 10 min) auto-clear so crashes don't permanently block re-verify.
      const _vaExisting = verifyInFlight.get(profile.id);
      if (_vaExisting && (Date.now() - _vaExisting) < VERIFY_LOCK_TTL_MS) return;
      verifyInFlight.delete(profile.id);
      verifyInFlight.set(profile.id, Date.now());

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
            // Disable API mode: skip mobile API — mark valid from EB cookies alone.
            if ((effectiveP.apiLimits as any)?.disableApi === true) {
              console.log(`[verify-all] @${profile.username} — Disable API mode: skipping mobile API, marking valid from EB cookies`);
              result = { ok: true, accountStatus: "valid", message: `@${profile.username} — EB login confirmed (Disable API mode — browser-only)`, igApiCookies: freshCookies };
            } else {
              const profileWithCookies = { ...effectiveP, igApiCookies: freshCookies } as typeof effectiveP;
              const apiResult = await verifyInstagramCredentials(profileWithCookies);
              result = { ...apiResult, igApiCookies: freshCookies };
            }
          }
        } else {
          const msg = bulkLoginResult.message ?? "";
          let accountStatus = "locked";
          if (/2fa|two.factor|two_factor/i.test(msg))                              accountStatus = "2fa_verification";
          else if (/challenge|checkpoint/i.test(msg))                               accountStatus = "captcha";
          else if (/permanently disabled|Account permanently disabled/i.test(msg))  accountStatus = "account_disabled";
          else if (/suspended/i.test(msg))                                          accountStatus = "suspended";
          else if (/aborted|timed?\s*out|ipc error|operation.*aborted/i.test(msg))  accountStatus = "pending";
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

    if (verifyDelayMode === "sameProxy") {
      // sameProxy mode: group by proxy, run all proxy groups in parallel.
      // Accounts on different proxies start simultaneously; accounts sharing a
      // proxy are staggered by groupDelayMin–groupDelayMax seconds.
      const proxyGroups = new Map<string, typeof eligible>();
      for (const p of eligible) {
        const proxyKey = p.proxyHost ? `${p.proxyHost}:${p.proxyPort}` : `noproxy_${p.id}`;
        if (!proxyGroups.has(proxyKey)) proxyGroups.set(proxyKey, []);
        proxyGroups.get(proxyKey)!.push(p);
      }
      (async () => {
        const groupPromises = Array.from(proxyGroups.values()).map(async (group) => {
          for (let idx = 0; idx < group.length; idx++) {
            await verifyOne(group[idx]);
            if (idx < group.length - 1) {
              const delaySec = groupDelayMin + Math.random() * Math.max(0, groupDelayMax - groupDelayMin);
              await new Promise(r => setTimeout(r, Math.round(delaySec * 1000)));
            }
          }
        });
        await Promise.all(groupPromises);
      })().catch(() => {});
    } else {
      // general mode: run all accounts sequentially with a flat delay between each.
      (async () => {
        for (let idx = 0; idx < eligible.length; idx++) {
          await verifyOne(eligible[idx]);
          if (idx < eligible.length - 1) {
            const delaySec = groupDelayMin + Math.random() * Math.max(0, groupDelayMax - groupDelayMin);
            await new Promise(r => setTimeout(r, Math.round(delaySec * 1000)));
          }
        }
      })().catch(() => {});
    }
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
      openaiApiKey: settings.openaiApiKey ?? "",
      geminiApiKey: settings.geminiApiKey ?? "",
      verifyDelayMode: settings.verifyDelayMode ?? "general",
      verifyAllDelayMin: parseInt(settings.verifyAllDelayMin ?? "5", 10),
      verifyAllDelayMax: parseInt(settings.verifyAllDelayMax ?? "15", 10),
      sameProxyDelayMin: parseInt(settings.sameProxyDelayMin ?? "0", 10),
      sameProxyDelayMax: parseInt(settings.sameProxyDelayMax ?? "0", 10),
      logMaxRows: parseInt(settings.logMaxRows ?? "100000", 10),
      backupEnabled: settings.backupEnabled === "true",
      backupIntervalDays: parseInt(settings.backupIntervalDays ?? "7", 10),
      themeColor: settings.themeColor ?? "blue",
      themeMode: settings.themeMode ?? "dark",
      preFilledPhoneNumber: settings.preFilledPhoneNumber ?? "",
      protectAccountsEnabled: settings.protectAccountsEnabled === "true",
      protectAccountsMinMins: parseInt(settings.protectAccountsMinMins ?? "60", 10),
      protectAccountsMaxMins: parseInt(settings.protectAccountsMaxMins ?? "120", 10),
      hikerFollowHashtag: settings.hikerFollowHashtag !== "false",
      hikerFollowGetFollowers: settings.hikerFollowGetFollowers !== "false",
      hikerFollowByUsername: settings.hikerFollowByUsername !== "false",
      hikerUnfollowByUsername: settings.hikerUnfollowByUsername !== "false",
      hikerContactGetFollowers: settings.hikerContactGetFollowers !== "false",
      hikerContactByUsername: settings.hikerContactByUsername !== "false",
      hikerDmByUsername: settings.hikerDmByUsername !== "false",
      hikerDmGetFollowers: settings.hikerDmGetFollowers !== "false",
      hikerRepostGetFeed: settings.hikerRepostGetFeed !== "false",
      hikerSyncProfile: settings.hikerSyncProfile !== "false",
      hikerGlobalByUsername: settings.hikerGlobalByUsername !== "false",
    });
  });


  app.put("/api/settings", async (req, res) => {
    const { skipFollowedUsers, skipAlreadySkippedUsers, hikerApiEnabled, hikerApiToken, skipScrapedUsers, scrapedUserIgnoreDays, scrapeAllIfSkipped, useLocalTime, twoCaptchaApiKey, openaiApiKey, geminiApiKey, verifyDelayMode, verifyAllDelayMin, verifyAllDelayMax, sameProxyDelayMin, sameProxyDelayMax, logMaxRows, backupEnabled, backupIntervalDays, themeColor, themeMode, preFilledPhoneNumber, protectAccountsEnabled, protectAccountsMinMins, protectAccountsMaxMins, hikerFollowHashtag, hikerFollowGetFollowers, hikerFollowByUsername, hikerUnfollowByUsername, hikerContactGetFollowers, hikerContactByUsername, hikerDmByUsername, hikerDmGetFollowers, hikerRepostGetFeed, hikerSyncProfile, hikerGlobalByUsername } = req.body;
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
    if (typeof openaiApiKey === "string") {
      await storage.setGlobalSetting("openaiApiKey", openaiApiKey);
    }
    if (typeof geminiApiKey === "string") {
      await storage.setGlobalSetting("geminiApiKey", geminiApiKey);
    }
    if (typeof verifyDelayMode === "string" && (verifyDelayMode === "general" || verifyDelayMode === "sameProxy")) {
      await storage.setGlobalSetting("verifyDelayMode", verifyDelayMode);
    }
    if (typeof verifyAllDelayMin === "number" && verifyAllDelayMin >= 0) {
      await storage.setGlobalSetting("verifyAllDelayMin", String(Math.round(verifyAllDelayMin)));
    }
    if (typeof verifyAllDelayMax === "number" && verifyAllDelayMax >= 0) {
      await storage.setGlobalSetting("verifyAllDelayMax", String(Math.round(verifyAllDelayMax)));
    }
    if (typeof sameProxyDelayMin === "number" && sameProxyDelayMin >= 0) {
      await storage.setGlobalSetting("sameProxyDelayMin", String(Math.round(sameProxyDelayMin)));
    }
    if (typeof sameProxyDelayMax === "number" && sameProxyDelayMax >= 0) {
      await storage.setGlobalSetting("sameProxyDelayMax", String(Math.round(sameProxyDelayMax)));
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
    if (typeof protectAccountsEnabled === "boolean") {
      await storage.setGlobalSetting("protectAccountsEnabled", String(protectAccountsEnabled));
    }
    if (typeof protectAccountsMinMins === "number" && protectAccountsMinMins >= 1) {
      await storage.setGlobalSetting("protectAccountsMinMins", String(Math.round(protectAccountsMinMins)));
    }
    if (typeof protectAccountsMaxMins === "number" && protectAccountsMaxMins >= 1) {
      await storage.setGlobalSetting("protectAccountsMaxMins", String(Math.round(protectAccountsMaxMins)));
    }
    const hikerBoolKeys: Array<[string, unknown]> = [
      ["hikerFollowHashtag", hikerFollowHashtag],
      ["hikerFollowGetFollowers", hikerFollowGetFollowers],
      ["hikerFollowByUsername", hikerFollowByUsername],
      ["hikerUnfollowByUsername", hikerUnfollowByUsername],
      ["hikerContactGetFollowers", hikerContactGetFollowers],
      ["hikerContactByUsername", hikerContactByUsername],
      ["hikerDmByUsername", hikerDmByUsername],
      ["hikerDmGetFollowers", hikerDmGetFollowers],
      ["hikerRepostGetFeed", hikerRepostGetFeed],
      ["hikerSyncProfile", hikerSyncProfile],
      ["hikerGlobalByUsername", hikerGlobalByUsername],
    ];
    for (const [key, val] of hikerBoolKeys) {
      if (typeof val === "boolean") await storage.setGlobalSetting(key, String(val));
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
      openaiApiKey: settings.openaiApiKey ?? "",
      geminiApiKey: settings.geminiApiKey ?? "",
      verifyDelayMode: settings.verifyDelayMode ?? "general",
      verifyAllDelayMin: parseInt(settings.verifyAllDelayMin ?? "5", 10),
      verifyAllDelayMax: parseInt(settings.verifyAllDelayMax ?? "15", 10),
      sameProxyDelayMin: parseInt(settings.sameProxyDelayMin ?? "0", 10),
      sameProxyDelayMax: parseInt(settings.sameProxyDelayMax ?? "0", 10),
      logMaxRows: parseInt(settings.logMaxRows ?? "100000", 10),
      backupEnabled: settings.backupEnabled === "true",
      backupIntervalDays: parseInt(settings.backupIntervalDays ?? "7", 10),
      themeColor: settings.themeColor ?? "blue",
      themeMode: settings.themeMode ?? "dark",
      preFilledPhoneNumber: settings.preFilledPhoneNumber ?? "",
      protectAccountsEnabled: settings.protectAccountsEnabled === "true",
      protectAccountsMinMins: parseInt(settings.protectAccountsMinMins ?? "60", 10),
      protectAccountsMaxMins: parseInt(settings.protectAccountsMaxMins ?? "120", 10),
      hikerFollowHashtag: settings.hikerFollowHashtag !== "false",
      hikerFollowGetFollowers: settings.hikerFollowGetFollowers !== "false",
      hikerFollowByUsername: settings.hikerFollowByUsername !== "false",
      hikerUnfollowByUsername: settings.hikerUnfollowByUsername !== "false",
      hikerContactGetFollowers: settings.hikerContactGetFollowers !== "false",
      hikerContactByUsername: settings.hikerContactByUsername !== "false",
      hikerDmByUsername: settings.hikerDmByUsername !== "false",
      hikerDmGetFollowers: settings.hikerDmGetFollowers !== "false",
      hikerRepostGetFeed: settings.hikerRepostGetFeed !== "false",
      hikerSyncProfile: settings.hikerSyncProfile !== "false",
      hikerGlobalByUsername: settings.hikerGlobalByUsername !== "false",
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

  app.post("/api/equinox-bot/chat", async (req, res) => {
    const settings = await storage.getGlobalSettings();
    const geminiKey = ((settings as any).geminiApiKey ?? "").trim() || (process.env.GEMINI_API_KEY ?? "").trim();
    const openaiKey = ((settings as any).openaiApiKey ?? "").trim() || (process.env.OPENAI_API_KEY ?? "").trim();
    const useGemini = !!geminiKey;
    if (!geminiKey && !openaiKey) {
      return res.json({ reply: "No AI API key is configured. Add a Gemini API key (free) or OpenAI API key in Settings → Security, then try again." });
    }
    const { messages } = req.body as { messages?: Array<{ role: string; content: string }> };
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages required" });
    }
    const systemPrompt = `You are the Equinox AI assistant — a built-in helper for the Equinox Instagram automation platform (a Windows desktop app). Answer ONLY questions about how to use Equinox. Never reveal source code, API keys, credentials, or internal implementation details. Keep answers concise and practical.

ACCOUNTS PAGE:
- Add/import accounts manually, via CSV, or via .eqx files. Each account has a status: Valid (active), Pending, Verifying, Error, Stopped, Blocked.
- Sort/filter by username, status, proxy, trust score, or last API call time.
- Verify an account: click the verify button — it uses the embedded browser to establish a real Instagram session. Never run tools on unverified accounts.
- Click an account row to open its detail page (tools, stats, session info).
- Select accounts with checkboxes, then use the Actions menu for bulk operations.
- Actions menu: Import Profiles (CSV), Export Profiles (CSV), Import EQX, Export EQX (encrypted backup), Verify All, Stop/Start All, Delete Selected.

TOOLS (configured per account in the account detail page):
1. AUTO FOLLOW — follows users from source lists (hashtags, location tags, followers/following of another account). Set daily min/max, delays between actions, skip-already-followed, skip-private-accounts filters.
2. AUTO UNFOLLOW — unfollows users who haven't followed back after a set number of days. Uses the follow list accumulated by Auto Follow. Set daily limits and delays.
3. DM TOOL — sends direct messages to users in a source list. Supports spintax {hi|hello|hey} for variation. Configure daily limits and delays.
4. CONTACT MESSAGING — messages users from a curated contact list (separate from DM tool sources).
5. AUTO REPLY — automatically replies to incoming DMs using spintax templates.
6. HUMAN SESSION EMULATION — simulates organic account behaviour: likes posts, views stories, browses explore. Keeps accounts looking active between automation runs.
7. PROFILE SYNC — periodically syncs the account's bio, follower count, and profile picture from Instagram.

GHOST BROWSER (Create an Account page):
- Creates fresh Instagram accounts using an isolated embedded browser with a unique device fingerprint.
- Assign a proxy to the Ghost Browser session before starting.
- Warm-up flow: (1) visits a list of websites, (2) watches YouTube videos, (3) signs up to Instagram.
- Tick "Skip Warmup" to go straight to the Instagram signup form without any warm-up.
- IMAP: fill in your email IMAP credentials — the bot will automatically fetch and submit the verification code from your inbox without any manual step.
- After a successful signup click "Add to Equinox" to add the account to your accounts list.
- Nuke Environment: resets the browser session completely (new fingerprint, new cookies).
- Tabs: each tab is an independent Ghost Browser session (Signup 1, Signup 2, …).

PROXY MANAGER:
- Add HTTP or SOCKS5 proxies (host, port, optional username/password).
- Test: pings the proxy and measures response time.
- Leak test: opens the embedded browser and checks that all traffic (IP, DNS, WebRTC) routes through the proxy with no leaks.
- Auto-assign: distributes proxies across accounts that don't have one.
- Link a proxy to an account by editing the account's proxy field.

STATISTICS / METRICS PAGE:
- Select an account from the dropdown to view its stats.
- Today's totals and all-time lifetime totals: follows, unfollows, DMs, likes, comments, story views, reposts, human session activity.
- Raw API Endpoint Count table: every Instagram API endpoint hit by this account, with today's count, total count, and Pre-Change columns.
- Pre-Change (Account): how many times this endpoint was the last action before this account's status changed (useful for diagnosing what triggered a block or challenge).
- Pre-Change (Global): same metric across ALL accounts (pattern detection across the fleet).
- Click any column header to sort ascending or descending.

SETTINGS PAGE:
- General: theme colour, dark/light mode, auto-start on Windows login, OpenAI API Key (used by Equinox Bot).
- Scraping: HikerAPI token for hashtag and location scraping.
- Automation: global follow/unfollow delays, skip filters, verify-all timing, log row limits.
- Security: 2FA handling, login options.
- Data: create/restore backups, manage the database.
- My Account: license info, tier, account limit.
- README & FAQ: getting-started guide and common questions.
- Talk to Equinox Bot: re-opens this assistant if it was closed.

EQX FILES (.eqx):
- Encrypted account backup format unique to Equinox. Contains credentials, proxy settings, tool configurations, followed-users list, stats, trust score, and device state.
- Export: Accounts page → select accounts → Actions → Export EQX. Choose a folder; each account saves as username.eqx.
- Import: Actions → Import EQX File. Supports importing multiple .eqx files at once.

TRUST SCORES:
- A customisable badge system to label accounts (e.g. "Clean", "Flagged", "Warm", "New").
- Configure labels, colours, and icons in Settings → Trust Scores.
- Assign a trust score to an account via its detail page or the accounts list badge.

DASHBOARD:
- Real-time activity log showing follows, unfollows, DMs, verifications, imports, exports, tool runs, and server events.
- "What's New" changelog panel on the right.

TIPS:
- Always verify an account before running tools — unverified accounts are skipped.
- Use a unique proxy per account; shared proxies increase ban risk.
- Keep daily action limits conservative for new accounts (20–50 follows/day).
- Monitor the Pre-Change columns in Metrics to identify what triggered account issues.
- Use spintax in DMs and Auto Reply to avoid repetitive message patterns.
- The Ghost Browser uses a completely isolated Chrome profile per account — cookies and fingerprints are never shared.
- Nuke an account's Ghost Browser session only if you want a completely fresh start; it regenerates the device fingerprint.

If asked about something outside Equinox, say: "I can only help with Equinox-related questions. What would you like to know about the software?"`;

    try {
      if (useGemini) {
        const geminiMessages = messages.slice(-20).map(m => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));
        const geminiBody = JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: geminiMessages,
          generationConfig: { maxOutputTokens: 600, temperature: 0.65 },
        });
        // Cascade through models — each has its own free-tier quota bucket
        const GEMINI_MODELS = ["gemini-1.5-flash", "gemini-1.5-flash-8b", "gemini-2.0-flash"];
        let lastError = "";
        for (const model of GEMINI_MODELS) {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(geminiKey)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: geminiBody,
          });
          if (r.ok) {
            const j = await r.json() as any;
            const text = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "Sorry, no response received.";
            return res.json({ reply: text });
          }
          const j = await r.json() as any;
          const msg: string = j?.error?.message ?? `HTTP ${r.status}`;
          const isQuota = r.status === 429 || msg.toLowerCase().includes("quota") || msg.toLowerCase().includes("rate");
          if (!isQuota) {
            return res.json({ reply: `AI service error. ${msg}` });
          }
          lastError = msg;
        }
        return res.json({ reply: `All Gemini models are currently rate-limited. Please wait a minute and try again, or check your API key at aistudio.google.com. Details: ${lastError}` });
      } else {
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: systemPrompt }, ...messages.slice(-20)],
            max_tokens: 600,
            temperature: 0.65,
          }),
        });
        if (!r.ok) {
          const j = await r.json() as any;
          return res.json({ reply: `AI service error. ${j?.error?.message ?? `HTTP ${r.status}`}` });
        }
        const j = await r.json() as any;
        return res.json({ reply: j.choices?.[0]?.message?.content ?? "Sorry, no response received." });
      }
    } catch (e: any) {
      return res.json({ reply: "Connection error — please try again." });
    }
  });

  app.get("/api/settings/test-openai", async (_req, res) => {
    const settings = await storage.getGlobalSettings();
    const key = (settings.openaiApiKey ?? "").trim() || (process.env.OPENAI_API_KEY ?? "").trim();
    if (!key) return res.json({ ok: false, error: "No API key configured" });
    try {
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { "Authorization": `Bearer ${key}` },
      });
      if (r.ok) return res.json({ ok: true });
      const j = await r.json() as any;
      return res.json({ ok: false, error: j?.error?.message ?? `HTTP ${r.status}` });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? "Request failed" });
    }
  });

  app.get("/api/settings/test-gemini", async (_req, res) => {
    const settings = await storage.getGlobalSettings();
    const key = ((settings as any).geminiApiKey ?? "").trim() || (process.env.GEMINI_API_KEY ?? "").trim();
    if (!key) return res.json({ ok: false, error: "No Gemini API key configured" });
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
      if (r.ok) return res.json({ ok: true });
      const j = await r.json() as any;
      return res.json({ ok: false, error: j?.error?.message ?? `HTTP ${r.status}` });
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
  async function buildEqxPayload(id: number, trustScoreId?: string): Promise<{ encrypted: Buffer; safeUsername: string } | null> {
    console.log(`[export-eqx] buildEqxPayload called — id=${id} trustScoreId=${trustScoreId ?? "none"}`);
    const profile = await storage.getProfile(id);
    if (!profile) {
      console.log(`[export-eqx] profile id=${id} not found in DB`);
      return null;
    }
    console.log(`[export-eqx] profile found: @${profile.username} — fetching tools/followedUsers/stats/apiCalls/preStatusHits`);
    const [allTools, followedUsers, statsData, apiCallsData, preStatusChangeHitsData] = await Promise.all([
      storage.getToolsByProfile(id),
      storage.getFollowedUsersByProfile(id, 100000),
      storage.getStatsByProfile(id),
      storage.getInstagramApiCallsByProfile(id, 2000),
      storage.getPreStatusChangeHitsByProfile(id),
    ]);
    console.log(`[export-eqx] data loaded — tools=${allTools.length} followedUsers=${followedUsers.length} stats=${statsData.length} apiCalls=${apiCallsData.length} preStatusHits=${preStatusChangeHitsData.length}`);
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
    console.log(`[export-eqx] toolsWithSources resolved — count=${toolsWithSources.length}`);
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

    // trustScoreId is passed in from the route handler (frontend-only localStorage value)

    const payload = {
      version: 2,
      software: "EQUINOX_BOT",
      exportedAt: new Date().toISOString(),
      ...(trustScoreId ? { trustScoreId } : {}),
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
      preStatusChangeHits: preStatusChangeHitsData.map(h => ({
        operationName: h.operationName,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        occurredAt: h.occurredAt,
      })),
    };
    console.log(`[export-eqx] building JSON payload — approx keys: ${Object.keys(payload).join(", ")}`);
    let jsonStr: string;
    try {
      jsonStr = JSON.stringify(payload);
    } catch (jsonErr: any) {
      console.log(`[export-eqx] JSON.stringify FAILED for id=${id}: ${jsonErr?.message ?? jsonErr}`);
      throw jsonErr;
    }
    console.log(`[export-eqx] JSON payload size=${jsonStr.length} bytes — encrypting`);
    const encrypted = eqxEncrypt(Buffer.from(jsonStr, "utf8"));
    console.log(`[export-eqx] encrypted size=${encrypted.length} bytes — buildEqxPayload done for @${profile.username}`);
    const safeUsername = (profile.username || "account").replace(/[^a-zA-Z0-9_-]/g, "_");
    return { encrypted, safeUsername };
  }

  // ── Bulk EQX export → single ZIP download (one save dialog) ─────────────
  app.get("/api/profiles/export-eqx-bulk", async (req, res) => {
    req.log.info({ query: req.query }, "[export-eqx-bulk] route hit");
    try {
      const raw = String(req.query.ids ?? "");
      const ids = raw.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      if (ids.length === 0) return res.status(400).json({ error: "No valid ids provided" });
      req.log.info({ ids }, "[export-eqx-bulk] building payloads for ids");

      const results = await Promise.all(ids.map(id => buildEqxPayload(id, undefined).catch((err) => {
        req.log.error({ err, id }, "[export-eqx-bulk] buildEqxPayload threw for id");
        return null;
      })));
      const files: Array<{ name: string; data: Buffer }> = [];
      for (const r of results) {
        if (r) files.push({ name: `${r.safeUsername}.eqx`, data: r.encrypted });
      }
      if (files.length === 0) return res.status(404).json({ error: "No profiles found for given ids" });
      req.log.info({ fileCount: files.length }, "[export-eqx-bulk] all payloads built — zipping");

      const zip = buildStoredZip(files);
      req.log.info({ zipSize: zip.length }, "[export-eqx-bulk] zip built — sending response");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="equinox-accounts.zip"`);
      res.send(zip);
    } catch (e: any) {
      req.log.error({ err: e }, "[export-eqx-bulk] route threw — this is why Export EQX (bulk) failed");
      return res.status(500).json({ error: e?.message });
    }
  });

  app.get("/api/profiles/:id/export-eqx", async (req, res) => {
    req.log.info({ id: req.params.id, query: req.query }, "[export-eqx] route hit");
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        req.log.error({ rawId: req.params.id }, "[export-eqx] invalid profile id — NaN");
        return res.status(400).json({ error: "Invalid profile id" });
      }
      const trustScoreId = req.query.trustScoreId ? String(req.query.trustScoreId) : undefined;
      req.log.info({ id, trustScoreId }, "[export-eqx] calling buildEqxPayload");
      const result = await buildEqxPayload(id, trustScoreId);
      if (!result) {
        req.log.error({ id }, "[export-eqx] buildEqxPayload returned null — profile not found");
        return res.status(404).json({ error: "Profile not found" });
      }

      const { encrypted, safeUsername } = result;
      req.log.info({ id, safeUsername, encryptedSize: encrypted.length }, "[export-eqx] payload ready — sending response");
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${safeUsername}.eqx"`);
      res.send(encrypted);
      req.log.info({ id, safeUsername }, "[export-eqx] response sent OK");
      const profile = await storage.getProfile(id);
      const pos   = req.query.pos   ? parseInt(String(req.query.pos),   10) : null;
      const total = req.query.total ? parseInt(String(req.query.total), 10) : null;
      const posLabel = pos && total ? ` ${pos}/${total}` : "";
      storage.createSessionAction({
        profileId: id,
        toolId: 0,
        action: "account_exported",
        targetUsername: "",
        sourceValue: "",
        sourceType: "system",
        result: "ok",
        detail: `@${profile?.username} exported as .eqx${posLabel}`,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    } catch (e: any) {
      req.log.error({ err: e }, "[export-eqx] route threw — this is why Export EQX File failed");
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
      // Auto-resolve proxyId from embedded proxy credentials (mirrors Jarvee import logic)
      {
        const eqxHost = ((cleanProfile.proxyHost as string) || "").trim();
        const eqxPort = cleanProfile.proxyPort ? Number(cleanProfile.proxyPort) : 0;
        let resolvedProxyId: number | null = null;
        if (eqxHost && eqxPort) {
          const existingProxies = await storage.getProxies();
          const match = existingProxies.find(px => px.host === eqxHost && px.port === eqxPort);
          if (match) {
            resolvedProxyId = match.id;
          } else {
            const newProxy = await storage.createProxy({
              name: `${eqxHost}:${eqxPort}`,
              host: eqxHost,
              port: eqxPort,
              username: (cleanProfile.proxyUsername as string | null) ?? null,
              password: (cleanProfile.proxyPassword as string | null) ?? null,
            });
            resolvedProxyId = newProxy.id;
          }
        }
        cleanProfile.proxyId = resolvedProxyId;
      }

      // Save the intended status BEFORE createProfile, because Drizzle's SQLite
      // dialect can silently fall back to the column's SQL DEFAULT ('pending') when
      // the value arrives via an object spread rather than an explicit named key.
      // The updateProfile call below is the authoritative write that bypasses that.
      const intendedStatus: string = cleanProfile.accountStatus ?? "pending";

      // Auto-assign UAs if the EQX file was exported before UAs were tracked
      // (older exports) or if the account never had one assigned.
      // All accounts (including disableApi=true) get mobile Android Chrome UAs.
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
      // Stamp the import date in the Notes field so the Longest Survivors tab
      // can track the true "in-use since" date, and so the user can see when
      // each account was last re-imported.  Format must match parseAllAddedDates:
      // /(?:Added|Re-added|Re-imported):\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+UTC)/gi
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const importStamp = `Re-imported: ${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`;
      const existingNotes = (cleanProfile.notes as string | null | undefined) ?? "";
      const updatedNotes  = existingNotes ? `${existingNotes}\n${importStamp}` : importStamp;

      await storage.updateProfile(created.id, {
        accountStatus: intendedStatus,
        credentialsDirty: false,
        notes: updatedNotes,
      });
      (created as any).accountStatus = intendedStatus;
      (created as any).credentialsDirty = false;
      (created as any).notes = updatedNotes;

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

      // Import API calls log
      try {
        if (Array.isArray(payload.apiCalls) && payload.apiCalls.length > 0) {
          await storage.bulkInsertInstagramApiCalls(payload.apiCalls.map((c: any) => ({
            profileId: created.id,
            operationName: c.operationName || "",
            date: c.date || new Date().toISOString(),
            message: c.message ?? "",
            source: c.source ?? "",
            navChain: c.navChain ?? "",
            ipAddress: c.ipAddress ?? "",
            durationMs: c.durationMs ?? 0,
          })));
        }
      } catch (e) {
        req.log.warn({ err: e }, "import-eqx: failed to import api calls log (non-fatal)");
      }

      // Import pre-status-change hits
      try {
        if (Array.isArray(payload.preStatusChangeHits) && payload.preStatusChangeHits.length > 0) {
          await storage.bulkInsertPreStatusChangeHits(payload.preStatusChangeHits.map((h: any) => ({
            profileId: created.id,
            username: created.username ?? "",
            operationName: h.operationName || "",
            fromStatus: h.fromStatus || "",
            toStatus: h.toStatus || "",
            occurredAt: h.occurredAt || new Date().toISOString(),
          })));
        }
      } catch (e) {
        req.log.warn({ err: e }, "import-eqx: failed to import pre-status-change hits (non-fatal)");
      }

      storage.createSessionAction({
        profileId: created.id,
        toolId: 0,
        action: "account_imported",
        targetUsername: "",
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
        ...(payload.trustScoreId ? { trustScoreId: payload.trustScoreId } : {}),
      });
    } catch (e: any) {
      req.log.error({ err: e }, "import-eqx failed");
      return res.status(500).json({ error: e?.message });
    }
  });

  // ── Jarvee binary file PARSE (preview-only, no DB writes) ───────────────
  // Accepts the raw binary as base64.  Returns ParsedProfile-compatible JSON
  // so the frontend can show a preview before the user confirms import.

  app.post("/api/profiles/parse-jarvee", async (req, res) => {
    try {
      const { fileBase64 } = req.body as { fileBase64?: string };
      if (!fileBase64) return res.status(400).json({ error: "fileBase64 is required" });

      let buf: Buffer;
      try { buf = Buffer.from(fileBase64, "base64"); }
      catch { return res.status(400).json({ error: "Invalid base64 data" }); }

      const { parseJarveeBinary, diagnoseJarveeBinary } = await import("../instagram/jarveeParser.js");

      // Always log diagnostic rows — check the API server console to see candidates.
      try {
        const diagRows = diagnoseJarveeBinary(buf);
        console.log("\n=== JARVEE DIAGNOSE ===");
        for (const r of diagRows) console.log(`  offset=${r.offset.toString().padStart(6)}  ${r.value}`);
        console.log("=== END DIAGNOSE ===\n");
      } catch { /* non-fatal */ }

      let jarveeAccounts: Awaited<ReturnType<typeof parseJarveeBinary>>;
      try {
        jarveeAccounts = parseJarveeBinary(buf);
      } catch (e: any) {
        return res.status(400).json({ error: e?.message ?? "Failed to parse Jarvee file" });
      }

      if (jarveeAccounts.length === 0) {
        return res.status(400).json({ error: "No accounts found in this Jarvee file" });
      }

      const profiles = jarveeAccounts.map(ja => ({
        accountLabel:              ja.accountLabel          ?? "",
        username:                  ja.username,
        password:                  ja.password,
        email:                     ja.email                 ?? "",
        proxyHost:                 ja.proxyHost             ?? "",
        proxyPort:                 ja.proxyPort != null ? String(ja.proxyPort) : "",
        proxyUsername:             ja.proxyUsername         ?? "",
        proxyPassword:             ja.proxyPassword         ?? "",
        userAgentEmbedded:         ja.userAgentWeb          ?? "",
        userAgentApi:              "",
        tags:                      "",
        dateOfBirth:               "",
        notes:                     "",
        phoneNumber:               "",
        twoFASecretKey:            ja.twoFASecret           ?? "",
        backupCodes:               "",
        emailValidationUsername:   ja.email                 ?? "",
        emailValidationPassword:   ja.emailPassword         ?? "",
        emailValidationPop3Server: "",
        emailValidationPort:       "",
        accStatus:                 "",
        deviceId:                  "",
        deviceUuid:                "",
        phoneId:                   "",
        adid:                      "",
        apiCookies:                "",
      }));

      return res.json({ profiles });
    } catch (e: any) {
      req.log.error({ err: e }, "parse-jarvee failed");
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Jarvee binary file DIAGNOSE (debug — returns raw string records) ──────
  app.post("/api/profiles/diagnose-jarvee", async (req, res) => {
    try {
      const { fileBase64 } = req.body as { fileBase64?: string };
      if (!fileBase64) return res.status(400).json({ error: "fileBase64 is required" });
      let buf: Buffer;
      try { buf = Buffer.from(fileBase64, "base64"); }
      catch { return res.status(400).json({ error: "Invalid base64 data" }); }
      const { diagnoseJarveeBinary } = await import("../instagram/jarveeParser.js");
      const rows = diagnoseJarveeBinary(buf);
      return res.json({ rows });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? "Diagnose failed" });
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
          // Jarvee imports don't carry an apiLimits field, so they always get
          // a mobile UA here.  All accounts (including disableApi=true after import)
          // stay on mobile UAs — Reset Device IDs will assign a fresh mobile UA.
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
            notes:                   null, // createProfile will auto-stamp the first-added date
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

  // ── Startup migration: fix mobile-UA accounts with stale desktop GPU fingerprints ──
  // Root cause: when accounts had desktop UAs (v1.1.291–v1.1.365), their ebFingerprint
  // was generated with ANGLE/Direct3D11/Metal GPU strings.  When v1.1.366 reverted the
  // UA back to mobile, the stored fingerprint was NOT regenerated — so every EB open
  // and every Mode-B silent-window action sent Instagram: Android mobile UA + NVIDIA RTX
  // Direct3D11 WebGL renderer.  That hardware combination is physically impossible and
  // is an instant ban signal.  This migration corrects all affected accounts at startup
  // so the fix takes effect immediately — without waiting for each account's EB to be
  // opened manually (which would trigger the per-session fix in browserSession.ts).
  (async () => {
    try {
      const allProfiles = await storage.getProfiles();
      let fixed = 0;
      for (const p of allProfiles) {
        const ebUA = p.userAgentEmbedded ?? "";
        const isMobileUA = ebUA.includes("Mobile");
        if (!isMobileUA) continue; // desktop UA accounts are handled separately
        if (!p.ebFingerprint) continue; // no fingerprint stored — will be generated on first open
        try {
          const fp = JSON.parse(p.ebFingerprint as string);
          const r: string = fp.webglRenderer ?? "";
          const hasDesktopGpu =
            r.includes("Direct3D11") ||
            r.includes("ANGLE (Apple") ||
            r.includes("ANGLE (NVIDIA") ||
            r.includes("ANGLE (AMD") ||
            r.includes("ANGLE (Intel");
          if (!hasDesktopGpu) continue; // already a mobile GPU — no action needed
          const newFp = JSON.stringify(generateEbFingerprint(p.userAgentApi ?? undefined, false, ebUA));
          await storage.updateProfile(p.id, { ebFingerprint: newFp });
          console.log(`[startup:fp-fix] @${p.username ?? p.id}: replaced desktop GPU renderer "${r.slice(0, 60)}" with mobile GPU`);
          fixed++;
        } catch { /* skip malformed fingerprint — will be regenerated on first EB open */ }
      }
      if (fixed > 0) {
        console.log(`[startup:fp-fix] Fixed desktop GPU fingerprint on ${fixed} mobile-UA account(s)`);
      }
    } catch (e) {
      console.warn("[startup:fp-fix] GPU fingerprint migration failed (non-fatal):", e);
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

  // ── License routes ───────────────────────────────────────────────────────
  const hashLicensePwd = (u: string, p: string) =>
    crypto.createHash("sha256").update(`${u.toLowerCase()}:${p}`).digest("hex");

  app.post("/api/license/login", async (req, res) => {
    try {
      const { username, password } = req.body ?? {};
      if (!username || !password) return res.status(400).json({ ok: false, error: "Missing credentials" });
      const row = storage.getLicenseByUsername(username);
      if (!row) return res.json({ ok: false });
      if (hashLicensePwd(username, password) !== row.password_hash) return res.json({ ok: false });
      const sessionData = { username: row.username, tier: row.tier, accountLimit: row.account_limit, isAdmin: row.is_admin === 1, expiresAt: row.expires_at ?? null };
      await storage.setGlobalSetting("license_session", JSON.stringify(sessionData));
      res.json({ ok: true, ...sessionData });
    } catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
  });

  app.get("/api/license/me", async (_req, res) => {
    try { res.json(await storage.getLicenseSession()); }
    catch { res.json({ ok: false }); }
  });

  app.post("/api/license/logout", async (_req, res) => {
    try { await storage.setGlobalSetting("license_session", ""); res.json({ ok: true }); }
    catch { res.status(500).json({ ok: false }); }
  });

  app.get("/api/license/tiers", (_req, res) => {
    res.json([
      { id: "starter",    label: "Starter",    price: "£25/mo",  accountLimit: 15   },
      { id: "pro",        label: "Pro",         price: "£50/mo",  accountLimit: 100  },
      { id: "business",   label: "Business",    price: "£100/mo", accountLimit: 250  },
      { id: "enterprise", label: "Enterprise",  price: "£250/mo", accountLimit: 1000 },
    ]);
  });

  // ── Admin-only license management ─────────────────────────────────────────
  const requireAdmin = async (res: any): Promise<boolean> => {
    const session = await storage.getLicenseSession();
    if (!session.ok || !session.isAdmin) {
      res.status(403).json({ ok: false, error: "Admin access required" });
      return false;
    }
    return true;
  };

  app.get("/api/license/users", async (_req, res) => {
    try {
      if (!await requireAdmin(res)) return;
      res.json(storage.getAllLicenses());
    } catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
  });

  app.post("/api/license/users", async (req, res) => {
    try {
      if (!await requireAdmin(res)) return;
      const { username, password, tier, accountLimit, expiresAt } = req.body ?? {};
      if (!username || !password || !tier) return res.status(400).json({ ok: false, error: "Missing fields" });
      const passwordHash = hashLicensePwd(username.trim(), password);
      storage.createLicense(username.trim(), passwordHash, tier, accountLimit ?? 15, expiresAt ?? null);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
  });

  app.put("/api/license/users/:id", async (req, res) => {
    try {
      if (!await requireAdmin(res)) return;
      const id = Number(req.params.id);
      const { tier, accountLimit, active, expiresAt, password, username } = req.body ?? {};
      const updates: Parameters<typeof storage.updateLicense>[1] = {};
      if (tier !== undefined) updates.tier = tier;
      if (accountLimit !== undefined) updates.accountLimit = Number(accountLimit);
      if (active !== undefined) updates.active = active ? 1 : 0;
      if (expiresAt !== undefined) updates.expiresAt = expiresAt || null;
      if (password && username) updates.passwordHash = hashLicensePwd(username, password);
      storage.updateLicense(id, updates);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
  });

  app.delete("/api/license/users/:id", async (req, res) => {
    try {
      if (!await requireAdmin(res)) return;
      storage.deleteLicense(Number(req.params.id));
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
  });

}
