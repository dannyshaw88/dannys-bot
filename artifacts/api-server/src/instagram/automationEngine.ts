// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║                  ARCHITECTURE — READ THIS BEFORE TOUCHING ANYTHING          ║
// ╠══════════════════════════════════════════════════════════════════════════════╣
// ║                                                                              ║
// ║  DEFAULT MODE IS A MOBILE API BOT.                                          ║
// ║                                                                              ║
// ║  By default, all Instagram actions go through the mobile private API       ║
// ║  (i.instagram.com), emulating a real Android Instagram app.                 ║
// ║                                                                              ║
// ║  EXCEPTION — "Disable API" per-account mode:                                ║
// ║  When a profile has Disable API enabled, actions for that profile run      ║
// ║  through the embedded browser (EB) instead — this is intentional and       ║
// ║  supported (see runBrowserOnlyHumanSession / runBrowserFollowSession /      ║
// ║  runBrowserUnfollowSession below). The EB is driven via the ebManager.ts    ║
// ║  IPC bridge (navigate/evaluate), optionally with silentMode so no window   ║
// ║  is shown on screen. This is the ONLY case where EB automation is allowed. ║
// ║                                                                              ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
import { storage } from "../storage";
import { triggerBanPipeline } from "./banPipeline";
import { InstagramWebClient } from "./instagramWebClient";
import { HikerApiClient, HikerCacheMissError } from "./hikerApiClient";
import { alterJpegBuffer, type AlterationLevel } from "./imageAlteration";
import { makeUniqueImage, makeUniqueVideo, isImageFile, isVideoFile, ALL_MEDIA_EXTS } from "./makeUnique";
import type { ProxyConfig } from "./browserSession";
import { applyStealthScripts, getExistingBrowser, viewportForUA, apiSessionEpochs, classifyEbChallengeUrl, getSessionUserAgentApi } from "./browserSession";
import { getAdapterProxyPort, getAdapterIp, startAdapterProxy } from "./adapterProxy";
import type { Profile, Tool, Source } from "../shared/schema";
import { profileUsernameCache } from "../lib/profileUsernameCache";
import { proxySlotManager } from "./proxySlotManager";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";
import * as nodeOs from "node:os";
import { randomBytes } from "node:crypto";

/**
 * Minimal Puppeteer-`page`-compatible shim backed by ebManager.ts's IPC bridge
 * (/eb/navigate, /eb/evaluate). Used so the browser-only Human Session code
 * below can drive the REAL Electron EB window (silent or visible) instead of
 * the disconnected standalone-Puppeteer session map in browserSession.ts.
 * Only supports the subset of the page API actually used here: goto/url/
 * evaluate/keyboard.press. All DOM querying+clicking must happen INSIDE the
 * evaluate() callback (no element handles cross the IPC boundary).
 */
class EbIpcPage {
  private _url = "";
  constructor(private profileId: number, private ebIpcPort: string) {}

  url(): string {
    return this._url;
  }

  async goto(url: string): Promise<void> {
    const r = await fetch(`http://127.0.0.1:${this.ebIpcPort}/eb/navigate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ profileId: this.profileId, url }),
      signal:  AbortSignal.timeout(30_000),
    });
    // Non-OK means the window was destroyed or never opened between ensureSilentEbOpen
    // and the first navigation. Throw immediately so the session fails fast instead of
    // sleeping 4.5 s and then timing out in waitFor with DOM: undefined.
    if (!r.ok) throw new Error(`/eb/navigate HTTP ${r.status} — window not open or destroyed`);
    this._url = url;
    // /eb/navigate is fire-and-forget on the Electron side (loadURL, not awaited
    // to completion) — give the page a moment to reach a usable DOM state.
    // 4500ms is the minimum reliable wait: Instagram's SPA takes ~3-4s to mount
    // virtualised list nodes after navigation; 2500ms caused frequent timeouts.
    await sleep(4500);
  }

  async evaluate<T = any>(fn: (...args: any[]) => T, ...args: any[]): Promise<T> {
    const argsLiteral = args.map(a => JSON.stringify(a)).join(", ");
    const script = `(${fn.toString()})(${argsLiteral})`;
    const r = await fetch(`http://127.0.0.1:${this.ebIpcPort}/eb/evaluate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ profileId: this.profileId, script }),
      signal:  AbortSignal.timeout(30_000),
    });
    // Non-OK (e.g. 404 "no window") must throw so waitFor's .catch(()=>false)
    // fires correctly. Without this check, 404 silently returns undefined and
    // waitFor spins for 20 s returning undefined (falsy) before timing out.
    if (!r.ok) throw new Error(`/eb/evaluate HTTP ${r.status} — window not open or IPC error`);
    const j = await r.json().catch(() => ({})) as { result?: any };
    if (j?.result && typeof j.result === "object" && j.result.__error) {
      throw new Error(j.result.__error);
    }
    return j?.result as T;
  }

  keyboard = {
    press: async (key: "Escape" | "ArrowRight" | "ArrowLeft"): Promise<void> => {
      const keyMap: Record<string, number> = { Escape: 27, ArrowRight: 39, ArrowLeft: 37 };
      await this.evaluate((k: string, code: number) => {
        const ev = new KeyboardEvent("keydown", { key: k, code: k, keyCode: code, which: code, bubbles: true });
        document.dispatchEvent(ev);
      }, key, keyMap[key] ?? 0).catch(() => {});
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolves a Jarvee-compatible caption template:
 *  - Replaces tokens like [ORIGINALPOSTCAPTION], @USERNAME, etc.
 *  - Processes multi-level spin syntax {option A|option B|option C}
 */
// Converts a numeric Instagram media ID to its base64url shortcode.
// Same algorithm used in InstagramWebClient — duplicated here to avoid
// coupling the engine to the client class.
function mediaIdToShortcode(id: string): string {
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const numericPart = id.split("_")[0];
  let n = BigInt(numericPart);
  let result = "";
  while (n > 0n) {
    result = ALPHA[Number(n % 64n)] + result;
    n = n / 64n;
  }
  return result || "0";
}

function resolveCaption(
  template: string,
  candidate: { caption: string; shortcode: string },
  sourceUsername: string,
  profileUsername: string,
): string {
  const caption = candidate.caption ?? "";
  const hashtags = (caption.match(/#\w+/g) ?? []).join(" ");
  const captionNoHashtags = caption.replace(/#\w+/g, "").replace(/\s{2,}/g, " ").trim();

  let result = template
    .replace(/\[ORIGINALPOSTCAPTION NO HASHTAGS\]/gi, captionNoHashtags)
    .replace(/\[ORIGINALPOSTCAPTION\]/gi, caption)
    .replace(/\[ORIGINALPOSTHASHTAGS\]/gi, hashtags)
    .replace(/\[POSTURL\]/gi, `https://www.instagram.com/p/${candidate.shortcode}/`)
    .replace(/@CURRENTUSERNAME/gi, profileUsername)
    .replace(/@USERNAME/gi, sourceUsername);

  // Spin syntax — resolve innermost {a|b|c} groups first (supports nesting)
  let iterations = 0;
  while (result.includes("{") && iterations++ < 100) {
    const prev = result;
    result = result.replace(/\{([^{}]+)\}/g, (_, group: string) => {
      const opts = group.split("|");
      return opts[Math.floor(Math.random() * opts.length)];
    });
    if (prev === result) break;
  }

  return result.trim().slice(0, 2200);
}

/**
 * Extracts the most informative error message from an Instagram API error.
 * instagram-private-api errors carry the raw IG response in e.response.body.
 * e.message is often just the HTTP error class (e.g. "IgResponseError").
 * This helper builds "base — IG message" so logs show exactly what Instagram returned.
 */
function igErrMsg(e: any): string {
  const base = e?.message ?? "unknown error";
  const body = e?.response?.body;
  if (!body) return base;
  const igMsg = body.message || body.feedback_message || body.error_title || body.spam_error;
  if (!igMsg || igMsg === base) return base;
  return `${base}: "${igMsg}"`;
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
/** Sleeps for up to `ms` milliseconds but wakes every 10 s to check stop. */
async function sleepInterruptible(ms: number, stop: { stopped: boolean }): Promise<void> {
  const chunk = 10_000;
  const end = Date.now() + ms;
  while (!stop.stopped && Date.now() < end) {
    await sleep(Math.min(chunk, end - Date.now()));
  }
}
function todayStr()    { return new Date().toISOString().split("T")[0]; }
function hourStr()     { return new Date().toISOString().slice(0, 13); }

// ── Engine file logger — writes to /tmp/engine.log so it's always greppable ──
import * as fs from "fs";
const ENGINE_LOG_FILE = "/tmp/engine.log";
function engineLog(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  process.stderr.write(line);
  try { fs.appendFileSync(ENGINE_LOG_FILE, line); } catch (_) {}
}

/** Returns true when the current local time is within [start, end] (HH:MM). Handles overnight windows. */
function parseTimerSlots(start: string): { start: string; end: string }[] | null {
  try {
    const parsed = JSON.parse(start);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {}
  return null;
}

function isWithinActiveWindow(start: string, end: string): boolean {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const checkWindow = (s: number, e: number) => s <= e ? cur >= s && cur <= e : cur >= s || cur <= e;

  const slots = parseTimerSlots(start);
  if (slots) return slots.some(slot => {
    const [sh, sm] = slot.start.split(":").map(Number);
    const [eh, em] = slot.end.split(":").map(Number);
    return checkWindow(sh * 60 + sm, eh * 60 + em);
  });

  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return checkWindow(sh * 60 + sm, eh * 60 + em);
}

/** Minutes until the nearest upcoming active window opens. */
function minutesUntilWindowOpen(start: string): number {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const minsUntil = (s: number) => s > cur ? s - cur : 1440 - cur + s;

  const slots = parseTimerSlots(start);
  if (slots) {
    const waits = slots.map(slot => {
      const [sh, sm] = slot.start.split(":").map(Number);
      return minsUntil(sh * 60 + sm);
    });
    return Math.min(...waits);
  }

  const [sh, sm] = start.split(":").map(Number);
  return minsUntil(sh * 60 + sm);
}

// ── Cookie baker state ────────────────────────────────────────────────────────
interface CookieBakerState {
  stop: { stopped: boolean };
  nextRunAt: number;
}

// ── Action suspension record ──────────────────────────────────────────────────
interface ActionSuspension {
  until: number;       // epoch ms — action is suspended until this time
  blockCount: number;  // 1 = first block (24h), 2+ = escalated (50h)
  lastBlockAt: number; // epoch ms of the most recent block
}

// ── Per-profile state ─────────────────────────────────────────────────────────
interface ProfileState {
  stop: { stopped: boolean };
  client: InstagramWebClient | null;
  currentProxyUrl?: string;
  // Follow counters
  dailyCount: number;
  dailyDate: string;
  hourlyCount: number;
  hourlyHour: string;
  // Per-action block suspensions (keyed by action name: follow/like/viewStories/etc.)
  actionSuspensions: Record<string, ActionSuspension>;
  // Human session tools run on their own separate timer
  nextHumanSessionAt: number;
  // Tracks previous value so a toggle-on resets the timer immediately
  lastHumanToolsEnabled: boolean;
  // Scheduled next-run timestamps for status display (0 = currently executing)
  nextFollowAt: number;
  nextContactAt: number;
  nextUnfollowAt: number;
}

interface CookieBakerVisit {
  url: string;
  visitedAt: number;
  scrollTimeSec: number;
  linksVisited: string[];
}

interface CookieBakerSessionActivity {
  sessionAt: number;
  sites: CookieBakerVisit[];
  error?: string;
}

class AutomationEngine {
  private states          = new Map<number, ProfileState>(); // follow runners
  private unfollowStates  = new Map<number, ProfileState>(); // unfollow runners
  private dmStates             = new Map<number, ProfileState>(); // dm runners
  private contactStates        = new Map<number, ProfileState>(); // contact tool runners
  private humanSessionStates   = new Map<number, ProfileState>(); // independent human session runners
  // Wake signals for HS runners — set to interrupt the idle 10s sleep immediately.
  // Keyed by profileId.  Runner resets wake=false after waking; triggerHumanSession sets wake=true.
  private hsWakeSignals        = new Map<number, { wake: boolean }>();

  /** Follow a user by opening a hidden embedded browser, navigating to their profile,
   *  and clicking the Follow button.  Used when the account has "Do Actions Via Browser
   *  → Follows" enabled.  Calls the EB IPC server (Electron main process) which manages
   *  the BrowserWindow lifecycle.  Resolves with the same shape as client.followUser(). */
  private async followUserViaBrowser(
    profileId: number,
    targetUsername: string,
    proxy?: { host?: string | null; port?: number | null; username?: string | null; password?: string | null; type?: string | null } | null,
    igApiCookies?: string | null,
    fp?: { userAgent?: string | null; apiUA?: string | null; ebFingerprint?: unknown } | null,
  ): Promise<{ ok: boolean; status?: string; reason?: string }> {
    const ebIpcPort = process.env.EB_IPC_PORT;
    if (!ebIpcPort) {
      return { ok: false, status: "follow_blocked", reason: "Browser-follow not available outside Electron" };
    }
    try {
      console.log(`[engine] followViaBrowser: sending IPC for profile ${profileId} → @${targetUsername}`);
      const proxyPayload = (proxy?.host && proxy?.port) ? {
        host: proxy.host,
        port: proxy.port,
        user: proxy.username ?? undefined,
        pass: proxy.password ?? undefined,
        type: proxy.type ?? "http",
      } : null;
      // userAgent/apiUA/ebFingerprint are forwarded so a Mode-B temp window
      // (created when the EB isn't already open) can present the SAME
      // fingerprint Instagram already associated with this account's session —
      // without them the window falls back to Electron's raw default identity.
      const r = await fetch(`http://127.0.0.1:${ebIpcPort}/eb/silent-follow`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          profileId, targetUsername, proxy: proxyPayload, igApiCookies: igApiCookies ?? null,
          userAgent: fp?.userAgent ?? undefined, apiUA: fp?.apiUA ?? undefined, ebFingerprint: fp?.ebFingerprint ?? undefined,
        }),
        signal:  AbortSignal.timeout(90_000),
      });
      if (!r.ok) return { ok: false, status: "follow_blocked", reason: `EB IPC HTTP ${r.status}` };
      return await r.json() as { ok: boolean; status?: string; reason?: string };
    } catch (err: any) {
      return { ok: false, status: "follow_blocked", reason: `Browser-follow error: ${err?.message}` };
    }
  }

  private async searchUserViaBrowser(
    profileId: number,
    username: string,
    proxy?: { host?: string | null; port?: number | null; username?: string | null; password?: string | null; type?: string | null } | null,
    igApiCookies?: string | null,
    fp?: { userAgent?: string | null; apiUA?: string | null; ebFingerprint?: unknown } | null,
  ): Promise<boolean> {
    const ebIpcPort = process.env.EB_IPC_PORT;
    if (!ebIpcPort) return false;
    try {
      const proxyPayload = (proxy?.host && proxy?.port) ? {
        host: proxy.host,
        port: proxy.port,
        user: proxy.username ?? undefined,
        pass: proxy.password ?? undefined,
        type: proxy.type ?? "http",
      } : null;
      const r = await fetch(`http://127.0.0.1:${ebIpcPort}/eb/silent-search`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          profileId, username, proxy: proxyPayload, igApiCookies: igApiCookies ?? null,
          userAgent: fp?.userAgent ?? undefined, apiUA: fp?.apiUA ?? undefined, ebFingerprint: fp?.ebFingerprint ?? undefined,
        }),
        signal:  AbortSignal.timeout(60_000),
      });
      if (!r.ok) return false;
      const j = await r.json() as { ok: boolean };
      return j.ok;
    } catch {
      return false;
    }
  }

  private async postPhotoViaBrowser(
    profileId: number,
    imageBuffer: Buffer,
    caption: string,
  ): Promise<{ ok: boolean; mediaId?: string; message?: string }> {
    const ebIpcPort = process.env.EB_IPC_PORT;
    if (!ebIpcPort) {
      return { ok: false, message: "Browser-post not available outside Electron" };
    }
    try {
      const r = await fetch(`http://127.0.0.1:${ebIpcPort}/eb/silent-post`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          profileId,
          imageBase64: imageBuffer.toString("base64"),
          caption,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!r.ok) return { ok: false, message: `EB IPC HTTP ${r.status}` };
      return await r.json() as { ok: boolean; mediaId?: string; message?: string };
    } catch (err: any) {
      return { ok: false, message: `Browser-post error: ${err?.message}` };
    }
  }

  /**
   * Ensures a silent (never-shown) EB window is open for this profile, backed
   * by the account's normal EB session partition/cookies. Safe to call
   * repeatedly — /eb/open is idempotent (focuses/no-ops if already open).
   * Returns false if EB_IPC_PORT is not set (dev/Replit — no Electron process).
   */
  /**
   * Ensures a browser window is open for this profile's automation session.
   * Returns { ok, weOpenedIt }:
   *   ok          — whether a usable window is available
   *   weOpenedIt  — true if WE opened a NEW silentMode window for this session.
   *                 The caller must call closeSilentEb() in a finally block so
   *                 the ephemeral window is destroyed when the session ends.
   *                 false means we reused the user's already-open window — do
   *                 NOT destroy it (the user still wants it).
   *
   * With 1,000+ profiles only a handful of sessions run concurrently, so the
   * total number of live silentMode windows at any moment is small.  They are
   * created on session start and destroyed on session end, never left open.
   */
  private async ensureSilentEbOpen(profile: Profile): Promise<{ ok: boolean; weOpenedIt: boolean }> {
    const ebIpcPort = process.env.EB_IPC_PORT;
    if (!ebIpcPort) return { ok: false, weOpenedIt: false };
    try {
      const stateRes = await fetch(`http://127.0.0.1:${ebIpcPort}/eb/state?profileId=${profile.id}`).catch(() => null);
      const state = stateRes && stateRes.ok
        ? await stateRes.json().catch(() => null) as { open?: boolean } | null
        : null;
      // Window already open (user has it open, or a previous session left it).
      // Reuse it — do NOT destroy it when we finish.
      if (state?.open) return { ok: true, weOpenedIt: false };

      const p = profile as any;
      const proxy = (p.proxyHost && p.proxyPort) ? {
        host: p.proxyHost, port: p.proxyPort, user: p.proxyUsername ?? undefined,
        pass: p.proxyPassword ?? undefined, type: p.proxyType ?? "http",
      } : undefined;
      // useHomeIp must be passed for accounts with no proxy that deliberately
      // run on the machine's home IP (browserDirectConnection=true).
      // Without it, openEbWindow throws [IP-LEAK BLOCKED] silently (the /eb/open
      // endpoint is fire-and-forget), the window is never created, and every
      // subsequent /eb/evaluate returns 404 → DOM: undefined for 20 s.
      const useHomeIp = !proxy && p.browserDirectConnection === true;
      const r = await fetch(`http://127.0.0.1:${ebIpcPort}/eb/open`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          profileId:     profile.id,
          username:      profile.username,
          password:      p.password ?? "",
          twoFAKey:      p.twoFASecretKey ?? "",
          proxy,
          useHomeIp,
          userAgent:     p.userAgent ?? undefined,
          apiUA:         p.userAgentApi ?? "",
          ebFingerprint: p.ebFingerprint ?? undefined,
          silentMode:    true,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) return { ok: false, weOpenedIt: false };
      // Poll /eb/state until the window is confirmed open (up to 15 s).
      // A blind sleep(3000) was unreliable: openEbWindow is fire-and-forget and
      // Chromium may take longer than 3 s to init the partition + load cookies.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await sleep(500);
        const sr = await fetch(`http://127.0.0.1:${ebIpcPort}/eb/state?profileId=${profile.id}`).catch(() => null);
        const ss = sr?.ok ? await sr.json().catch(() => null) as { open?: boolean } | null : null;
        if (ss?.open) return { ok: true, weOpenedIt: true };
      }
      // Window never appeared within 15 s — treat as failure.
      console.warn(`[engine] @${profile.username}: ensureSilentEbOpen timed out waiting for window`);
      return { ok: false, weOpenedIt: false };
    } catch (err: any) {
      console.warn(`[engine] @${profile.username}: ensureSilentEbOpen error: ${err?.message}`);
      return { ok: false, weOpenedIt: false };
    }
  }

  /** Destroys the silentMode window opened by ensureSilentEbOpen for this profile. */
  private async closeSilentEb(profileId: number): Promise<void> {
    const ebIpcPort = process.env.EB_IPC_PORT;
    if (!ebIpcPort) return;
    await fetch(`http://127.0.0.1:${ebIpcPort}/eb/close`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ profileId }),
      signal:  AbortSignal.timeout(10_000),
    }).catch(() => {});
  }

  private cookieBakerStates    = new Map<number, CookieBakerState>(); // cookie baker runners
  private cookieBakerForceRun  = new Set<number>();               // trigger immediate run
  private cookieBakerActivity  = new Map<number, CookieBakerSessionActivity[]>(); // last sessions per profile
  private cookieBakerRunning   = 0; // count of headless Chrome instances currently active
  private syncTimers           = new Map<number, number>();       // profileId → nextSyncAt (ms)
  private ownUserIdCache       = new Map<number, string>();       // profileId → Instagram pk (HikerAPI, resolved once)
  private contactForceRun      = new Set<number>();               // profileIds to run contact send immediately
  private followForceRun       = new Set<number>();               // profileIds to skip the inter-session wait immediately
  private initialized          = false;                          // false until first reconcile completes
  // Tracks runners that exited due to an unhandled crash (not a clean stop).
  // On reconcile, these profiles get a fresh X-Y random delay before re-launch
  // (same as cold startup) rather than firing immediately.
  private runnerCrashedIds     = new Set<number>();
  // Tracks which profiles have acquired a proxy slot so we can release them
  // when the runner finishes.  Maps profileId → proxyId.
  private acquiredSlots        = new Map<number, number>();

  // ── Single-instance lock ─────────────────────────────────────────────────
  // The Replit platform can auto-create an "artifact" workflow that runs this
  // exact same package (pnpm --filter @workspace/api-server run dev) alongside
  // the pre-existing hand-configured workflow — two live OS processes, each
  // with their own AutomationEngine instance, polling and mutating the SAME
  // Instagram accounts concurrently. Instagram treats concurrent sessions on
  // one account as suspicious and can lock/ban it. This lock ensures only ONE
  // process on this machine ever runs the reconcile/session loops at a time.
  //
  // Lock file lives in the OS temp dir (not cwd- or DB-relative) because the
  // two duplicate processes can have different process.cwd() (and therefore
  // different resolved database.db paths) while still running on the same
  // container/filesystem — os.tmpdir() is the one location guaranteed shared.
  private static readonly LOCK_PATH = nodePath.join(nodeOs.tmpdir(), "dannys-bot-automation-engine.lock");
  private static readonly LOCK_STALE_MS = 30_000;  // 3x renewal cadence below
  private static readonly LOCK_RENEW_MS = 10_000;
  private _lockToken: string | null = null;
  private _lockOwned = false;
  private _lockRenewTimer: ReturnType<typeof setInterval> | null = null;
  private _reconcileInterval: ReturnType<typeof setInterval> | null = null;
  private _restoreInterval: ReturnType<typeof setInterval> | null = null;

  private async _tryAcquireOrTakeover(): Promise<boolean> {
    const token = `${process.pid}:${Date.now()}:${randomBytes(6).toString("hex")}`;
    const tmpPath = `${AutomationEngine.LOCK_PATH}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    try {
      await fsPromises.writeFile(tmpPath, token, "utf8");
      try {
        // fs.link() is atomic: it only succeeds if LOCK_PATH does not already
        // exist. If two processes race here, the OS guarantees exactly one
        // link() call wins — the other gets EEXIST, even if both just decided
        // the previous lock looked "stale" and both raced to take it over.
        await fsPromises.link(tmpPath, AutomationEngine.LOCK_PATH);
        this._lockToken = token;
        return true;
      } catch (linkErr: any) {
        if (linkErr?.code !== "EEXIST") throw linkErr;
        // Lock is held — check staleness (owner crashed without cleanup).
        try {
          const st = await fsPromises.stat(AutomationEngine.LOCK_PATH);
          const age = Date.now() - st.mtimeMs;
          if (age > AutomationEngine.LOCK_STALE_MS) {
            await fsPromises.unlink(AutomationEngine.LOCK_PATH).catch(() => {});
            // Retry the atomic link immediately against the now-cleared path.
            await fsPromises.link(tmpPath, AutomationEngine.LOCK_PATH);
            this._lockToken = token;
            return true;
          }
        } catch { /* stat/unlink/relink race lost to another process — not fatal */ }
        return false;
      } finally {
        await fsPromises.unlink(tmpPath).catch(() => {});
      }
    } catch {
      return false;
    }
  }

  /** Re-confirms we still own the lock (another process may have taken it over
   *  after judging our lock stale) and refreshes its mtime so nobody else does. */
  private async _renewLock(): Promise<void> {
    if (!this._lockOwned || !this._lockToken) return;
    try {
      const current = await fsPromises.readFile(AutomationEngine.LOCK_PATH, "utf8").catch(() => null);
      if (current !== this._lockToken) {
        console.error("[engine] SINGLE-INSTANCE LOCK LOST — another process took over automation. Stopping loops in this process to avoid a duplicate engine hitting live Instagram accounts.");
        this._stopLoops();
        this._lockOwned = false;
        this._lockToken = null;
        if (this._lockRenewTimer) { clearInterval(this._lockRenewTimer); this._lockRenewTimer = null; }
        this._beginAcquireLoop();
        return;
      }
      // Still ours — touch mtime so we don't get judged stale by anyone else.
      await fsPromises.writeFile(AutomationEngine.LOCK_PATH, this._lockToken, "utf8");
    } catch (e) {
      console.warn("[engine] lock renewal error (non-fatal):", e);
    }
  }

  private _startLoops(): void {
    console.log(`[engine] Automation engine started (single-instance lock acquired, pid=${process.pid})`);
    this.reconcile();
    this._reconcileInterval = setInterval(() => this.reconcile(), 10_000);
    this._restoreInterval = setInterval(() => this.restoreResumingAccounts(), 30_000);
  }

  private _stopLoops(): void {
    if (this._reconcileInterval) { clearInterval(this._reconcileInterval); this._reconcileInterval = null; }
    if (this._restoreInterval)   { clearInterval(this._restoreInterval);   this._restoreInterval   = null; }
  }

  private _beginAcquireLoop(): void {
    (async () => {
      // First attempt fires immediately; on failure, retry on the same
      // cadence as lock renewal so a loser notices a freed/stale lock quickly.
      // While unlocked, this process serves HTTP only — it never launches any
      // profile runner, so it can never touch a live Instagram session.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const acquired = await this._tryAcquireOrTakeover();
        if (acquired) {
          this._lockOwned = true;
          this._startLoops();
          this._lockRenewTimer = setInterval(() => this._renewLock(), AutomationEngine.LOCK_RENEW_MS);
          return;
        }
        console.log(`[engine] another process holds the automation single-instance lock — this process will serve HTTP only and retry every ${AutomationEngine.LOCK_RENEW_MS / 1000}s`);
        await new Promise(r => setTimeout(r, AutomationEngine.LOCK_RENEW_MS));
      }
    })();
  }

  /** Best-effort synchronous release so a clean restart (SIGTERM/SIGINT) frees
   *  the lock immediately instead of making the next owner wait out the full
   *  staleness window (LOCK_STALE_MS) before it can take over. Safe to call
   *  even if we never held the lock. */
  private _releaseLockSync(): void {
    if (this._lockRenewTimer) { clearInterval(this._lockRenewTimer); this._lockRenewTimer = null; }
    if (!this._lockOwned || !this._lockToken) return;
    try {
      const current = fs.readFileSync(AutomationEngine.LOCK_PATH, "utf8");
      if (current === this._lockToken) fs.unlinkSync(AutomationEngine.LOCK_PATH);
    } catch { /* already gone / never existed — fine */ }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────
  start() {
    this._beginAcquireLoop();
    const release = () => this._releaseLockSync();
    process.once("exit", release);
    process.once("SIGTERM", release);
    process.once("SIGINT", release);
  }

  triggerReconcile() { this.reconcile().catch(() => {}); }

  private async restoreResumingAccounts(): Promise<void> {
    try {
      const resuming = await storage.getResumingProfiles();
      const now = new Date().toISOString();
      for (const p of resuming) {
        if (!p.resumingUntil || p.resumingUntil > now) continue;
        const prevStatus = (p.resumingPrevStatus ?? "valid") as any;
        await storage.updateProfile(p.id, { accountStatus: prevStatus, resumingUntil: null, resumingPrevStatus: null });
        console.log(`[engine] @${p.username}: proxy-taint cooldown expired — toggle restored to ON (status: "${prevStatus}")`);
      }
    } catch (e) {
      console.warn("[engine] restoreResumingAccounts error:", e);
    }
  }

  private async reconcile() {
    // Single-instance guard: if this process does not hold the automation
    // lock it must never launch a runner or mutate live-session state, even
    // if an HTTP route handler calls a trigger* method on it directly (e.g.
    // the platform's artifact-managed preview routing hitting this process's
    // /api path while the OTHER process owns the lock). See start()/_lockOwned.
    if (!this._lockOwned) {
      console.warn("[engine] reconcile() skipped — this process does not hold the automation single-instance lock");
      return;
    }
    try {
      // On app startup (first reconcile, this.initialized = false): apply the configured X-Y
      // minute initial delay so multiple profiles don't all fire at once.
      // On manual toggle-on (any subsequent reconcile, this.initialized = true): run immediately
      // — the user just enabled the tool and expects it to start now.
      // Copy Settings "Randomise timing" staggerOffsetMins is handled inside each launcher
      // independently of this flag, so it still staggers even on a manual toggle.
      const runImmediately = this.initialized;

      const profiles = (await storage.getProfiles()).filter((p: any) => !p.creatorMode && !p.isTemplate);

      // Keep the username cache current so the HTTP logger can resolve IDs → names.
      profileUsernameCache.setMany(profiles);

      const activeFollow        = new Set<number>();
      const activeUnfollow      = new Set<number>();
      const activeDM            = new Set<number>();
      const activeContact       = new Set<number>();
      const activeHumanSession  = new Set<number>();

      // Release proxy slots for profiles whose runners have all finished
      const currentlyRunning = new Set<number>([
        ...this.states.keys(),
        ...this.unfollowStates.keys(),
        ...this.dmStates.keys(),
        ...this.contactStates.keys(),
        ...this.humanSessionStates.keys(),
      ]);
      for (const [profileId, proxyId] of this.acquiredSlots) {
        if (!currentlyRunning.has(profileId)) {
          proxySlotManager.release(proxyId, profileId);
          this.acquiredSlots.delete(profileId);
        }
      }

      for (const profile of profiles) {
        const tools = await storage.getToolsByProfile(profile.id);

        // Never run automation without a proxy — skip entirely if none is assigned
        const hasProxy = profile.proxyId
          ? true
          : !!(profile.proxyHost && profile.proxyPort);
        if (!hasProxy) continue;

        // Per-profile runImmediately flag:
        //   • App startup (initialized=false)     → always wait X-Y (runImmediately=false)
        //   • Manual tool toggle (initialized=true, no crash) → run now (runImmediately=true)
        //   • Crash recovery (initialized=true, crashed) → wait X-Y again (runImmediately=false)
        // This ensures a crashed runner never fires instantly after recovery —
        // it gets the same random startup delay as a cold boot, protecting the
        // account from being hammered if a runner is in a crash/restart loop.
        const wasCrashed = this.runnerCrashedIds.has(profile.id);
        if (wasCrashed) this.runnerCrashedIds.delete(profile.id);
        const profileRunImmediately = runImmediately && !wasCrashed;

        // Human Session tool — check first so we can gate standalone runners below.
        // HS is the single orchestrating tool. ANY profile that has an HS tool configured
        // (enabled OR disabled) must NEVER also run standalone follow/unfollow/dm/contact
        // runners — those run inside the HS loop only. The standalone gate uses existence,
        // not the enabled flag, so turning HS OFF doesn't accidentally re-activate them.
        const humanSessionTool = tools.find(t => t.type === "human_sessions" && t.enabled);
        const hasHumanSessionTool = tools.some(t => t.type === "human_sessions");

        // Proxy slot enforcement — only gate NEW runner launches (not ones already in flight).
        // HS profiles manage their own per-session slot acquire/release inside launchHumanSession.
        // Only standalone (non-HS) runners acquire here at launch time.
        const alreadyRunning = currentlyRunning.has(profile.id);
        if (!alreadyRunning && profile.proxyId && !this.acquiredSlots.has(profile.id) && profile.accountStatus === "valid" && !hasHumanSessionTool) {
          const hasRunnableStandaloneTools = (
            tools.find(t => t.type === "follow" && t.enabled) ||
            tools.find(t => t.type === "unfollow" && t.enabled) ||
            tools.find(t => t.type === "dm" && t.enabled) ||
            (tools.find(t => t.type === "contact")?.enabled === true)
          );
          if (hasRunnableStandaloneTools) {
            const slotCheck = proxySlotManager.canAcquire(profile.proxyId, profile.id);
            if (!slotCheck.ok) {
              console.log(`[engine] @${profile.username}: proxy slot unavailable — ${slotCheck.reason}`);
              continue;
            }
            proxySlotManager.acquire(profile.proxyId, profile.id);
            this.acquiredSlots.set(profile.id, profile.proxyId);
          }
        }

        if (humanSessionTool && profile.accountStatus === "valid") {
          activeHumanSession.add(profile.id);
          if (!this.humanSessionStates.has(profile.id)) {
            this.launchHumanSession(profile, humanSessionTool, profileRunImmediately);
          }
        }

        // Standalone runners are PERMANENTLY blocked for any profile that has an HS tool
        // configured, regardless of whether HS is currently enabled or disabled.
        // This ensures that toggling the HS master toggle OFF does not re-activate
        // the standalone runners — the HS tool is the only execution path for this profile.
        if (!hasHumanSessionTool) {
          const followTool = tools.find(t => t.type === "follow" && t.enabled);
          if (followTool && profile.accountStatus === "valid") {
            activeFollow.add(profile.id);
            if (!this.states.has(profile.id)) this.launch(profile, followTool, profileRunImmediately);
          }

          const unfollowTool = tools.find(t => t.type === "unfollow" && t.enabled);
          if (unfollowTool && profile.accountStatus === "valid") {
            activeUnfollow.add(profile.id);
            if (!this.unfollowStates.has(profile.id)) this.launchUnfollow(profile, unfollowTool, profileRunImmediately);
          }

          const dmTool = tools.find(t => t.type === "dm" && t.enabled);
          if (dmTool && profile.accountStatus === "valid") {
            activeDM.add(profile.id);
            if (!this.dmStates.has(profile.id)) this.launchDM(profile, dmTool, profileRunImmediately);
          }

          // Contact tool: the top-level t.enabled flag is the MASTER SWITCH.
          // Sub-toggles (contactUsersEnabled, contactNewFollowersEnabled, etc.)
          // are only relevant when the master switch is ON. A disabled master
          // switch means the whole tool is off — no sub-feature may override it.
          const contactTool = tools.find(t => t.type === "contact");
          const contactEffective = contactTool?.enabled === true;
          if (contactEffective && profile.accountStatus === "valid") {
            activeContact.add(profile.id);
            if (!this.contactStates.has(profile.id)) this.launchContact(profile, contactTool!, profileRunImmediately);
          }
        }
      }

      for (const [id, state] of this.states) {
        if (!activeFollow.has(id)) {
          state.stop.stopped = true;
          // Do NOT delete from states here — the runner coroutine deletes itself
          // when its loop exits.  Deleting prematurely would make the next
          // reconcile (10 s later) see no runner and re-launch one while the
          // original coroutine is still mid-session.
          console.log(`[engine] Stopping follow runner for profile ${id}`);
        }
      }
      for (const [id, state] of this.unfollowStates) {
        if (!activeUnfollow.has(id)) {
          state.stop.stopped = true;
          console.log(`[engine] Stopping unfollow runner for profile ${id}`);
        }
      }
      for (const [id, state] of this.dmStates) {
        if (!activeDM.has(id)) {
          state.stop.stopped = true;
          console.log(`[engine] Stopping DM runner for profile ${id}`);
        }
      }
      for (const [id, state] of this.contactStates) {
        if (!activeContact.has(id)) {
          state.stop.stopped = true;
          console.log(`[engine] Stopping contact runner for profile ${id}`);
        }
      }
      for (const [id, state] of this.humanSessionStates) {
        if (!activeHumanSession.has(id)) {
          state.stop.stopped = true;
          // Same as above: do NOT delete from humanSessionStates here.  The
          // runner coroutine deletes itself at exit.  Premature deletion caused
          // reconcile to re-launch a new HS runner while the first runner's
          // runHumanSessionTools coroutine was still mid-session — producing
          // double follows/actions within a single session cycle.
          console.log(`[engine] Stopping human session runner for profile ${id}`);
        }
      }

      // ── Cookie baker (background web browsing, works for all profiles) ──────
      const allProfilesForBaker = await storage.getProfiles();
      const activeCookieBaker = new Set<number>();
      for (const bp of allProfilesForBaker) {
        const cbs = (bp.cookieBakerSettings as any) ?? {};
        const bpHasProxy = bp.proxyId ? true : !!(bp.proxyHost && bp.proxyPort);
        if (cbs.enabled && bpHasProxy) {
          activeCookieBaker.add(bp.id);
          if (!this.cookieBakerStates.has(bp.id)) this.launchCookieBaker(bp);
        }
      }
      for (const [id, state] of this.cookieBakerStates) {
        if (!activeCookieBaker.has(id)) {
          state.stop.stopped = true;
          this.cookieBakerStates.delete(id);
          console.log(`[cookie-baker] Stopped baker for profile ${id}`);
        }
      }

      // ── Profile sync timers (independent of any tool runner) ──────────────
      for (const profile of profiles) {
        if (!profile.syncEnabled || !profile.syncIntervalMin) continue;
        const syncHasProxy = profile.proxyId ? true : !!(profile.proxyHost && profile.proxyPort);
        if (!syncHasProxy) continue;
        const nextAt = this.syncTimers.get(profile.id);
        // Seed from lastSyncedAt on first encounter
        if (nextAt === undefined) {
          if (profile.lastSyncedAt) {
            const lastMs = new Date(profile.lastSyncedAt).getTime();
            const intervalMs = randInt(
              (profile.syncIntervalMin) * 60_000,
              (profile.syncIntervalMax ?? profile.syncIntervalMin) * 60_000,
            );
            this.syncTimers.set(profile.id, lastMs + intervalMs);
          } else {
            this.syncTimers.set(profile.id, 0); // sync immediately on first run
          }
          continue;
        }
        if (Date.now() < nextAt) continue;
        // Time to sync — use syncProfile (re-reads from DB) instead of runProfileSync
        // so we always honour the latest syncUseHiker value, not the reconcile snapshot.
        this.syncProfile(profile.id).catch((e: any) =>
          console.warn(`[engine] @${profile.username}: profile sync error: ${e?.message}`)
        );
        const intervalMs = randInt(
          (profile.syncIntervalMin) * 60_000,
          (profile.syncIntervalMax ?? profile.syncIntervalMin) * 60_000,
        );
        this.syncTimers.set(profile.id, Date.now() + intervalMs);
        console.log(`[engine] @${profile.username}: next profile sync in ${Math.round(intervalMs / 60000)}min`);
      }
      // Clean up sync timers for removed profiles
      const profileIds = new Set(profiles.map(p => p.id));
      for (const id of this.syncTimers.keys()) {
        if (!profileIds.has(id)) this.syncTimers.delete(id);
      }

      // Mark startup complete — subsequent reconciles treat new runners as user-toggled-on
      this.initialized = true;
    } catch (err: any) {
      console.error("[engine] Reconcile error:", err?.message);
    }
  }

  // ── Profile Sync: fetch stats from Instagram or HikerAPI and persist ───────
  // Public so the /api/profiles/:id/sync route can trigger it directly.
  async syncProfile(profileId: number): Promise<{ followersCount: number; followingCount: number; postsCount: number } | null> {
    const profile = await storage.getProfile(profileId);
    if (!profile) return null;
    return this.runProfileSync(profile);
  }

  private async runProfileSync(profile: Profile): Promise<{ followersCount: number; followingCount: number; postsCount: number } | null> {
    const globalSettings = await storage.getGlobalSettings();
    const useHiker = !!(
      profile.syncUseHiker &&
      globalSettings.hikerApiEnabled === "true" &&
      globalSettings.hikerApiToken &&
      globalSettings.hikerSyncProfile !== "false"
    );

    let stats: { followersCount: number; followingCount: number; postsCount: number } | null = null;

    const syncSource = useHiker ? "HikerAPI" : "account";
    const syncT0 = Date.now();

    if (useHiker) {
      const { HikerApiClient } = await import("./hikerApiClient");
      const hikerClient = new HikerApiClient(globalSettings.hikerApiToken!);
      stats = await hikerClient.getProfileStats(profile.username);
      storage.createInstagramApiCall({
        profileId: profile.id,
        username: profile.username,
        operationName: "ProfileSync",
        date: new Date().toISOString(),
        source: "HikerAPI",
        message: stats ? "Profile Synced" : "no data returned",
        durationMs: Date.now() - syncT0,
      }).catch(() => {});
    } else {
      const proxyUrl = await this.buildProxyUrl(profile);
      if (!proxyUrl) {
        console.warn(`[engine] @${profile.username}: skipping profile sync — no proxy assigned`);
        return null;
      }
      const client = new InstagramWebClient(proxyUrl, profile.id);
      if (profile.userAgentEmbedded) client.setWebUserAgent(profile.userAgentEmbedded);
      if (profile.apiLimits) client.setApiLimits(profile.apiLimits as any);
      // setDeviceInfo MUST be called before loadBrowserCookies so that stored
      // igApiCookies seed the mobile session (mobileSessionReady=true).
      // Without it mobileSessionGet returns null immediately and sync always fails.
      client.setDeviceInfo(profile.igDeviceState, getSessionUserAgentApi(profile.id) ?? profile.userAgentApi, profile.igApiCookies);
      client.onDeviceStateUpdate = (state) => { storage.updateProfile(profile.id, { igDeviceState: state }).catch(() => {}); };
      client.loadBrowserCookies();
      try {
        stats = await client.getOwnProfileStats();
        storage.createInstagramApiCall({
          profileId: profile.id,
          username: profile.username,
          operationName: "ProfileSync",
          date: new Date().toISOString(),
          source: "account",
          message: stats ? "Profile Synced" : "no data returned",
          durationMs: Date.now() - syncT0,
        }).catch(() => {});
      } catch (syncErr: any) {
        // getOwnProfileStats re-throws account-level errors (banned, suspended,
        // logged_out, challenge, etc.) so we can update accountStatus immediately
        // rather than leaving the account showing as "valid" indefinitely.
        storage.createInstagramApiCall({
          profileId: profile.id,
          username: profile.username,
          operationName: "ProfileSync",
          date: new Date().toISOString(),
          source: "account",
          message: `error: ${syncErr?.message ?? "unknown"}`,
          durationMs: Date.now() - syncT0,
        }).catch(() => {});
        const applied = await this.applyAccountLevelError(profile.id, syncErr?.message ?? "");
        if (applied) {
          console.warn(`[engine] @${profile.username}: profile sync detected account issue — status set to "${applied}"`);
        } else {
          console.warn(`[engine] @${profile.username}: profile sync threw unexpected error: ${syncErr?.message}`);
        }
        return null;
      }
    }

    if (!stats) {
      console.warn(`[engine] @${profile.username}: profile sync returned no data`);
      return null;
    }

    await storage.updateProfile(profile.id, {
      ...stats,
      lastSyncedAt: new Date().toISOString(),
    });
    console.log(`[engine] @${profile.username}: synced — followers=${stats.followersCount} following=${stats.followingCount} posts=${stats.postsCount}`);
    return stats;
  }

  // ── Runner launch ─────────────────────────────────────────────────────────
  private launch(profile: Profile, _tool: Tool, runImmediately = false) {
    // Guard against double-launch (e.g. rapid toggle OFF→ON)
    if (this.states.has(profile.id)) return;
    apiSessionEpochs.set(profile.id, Date.now());
    const state: ProfileState = {
      stop: { stopped: false },
      client: null,
      dailyCount: 0, dailyDate: todayStr(),
      hourlyCount: 0, hourlyHour: hourStr(),
      actionSuspensions: {},
      nextHumanSessionAt: 0,
      lastHumanToolsEnabled: true,
      nextFollowAt: 0,
      nextContactAt: 0,
      nextUnfollowAt: 0,
    };
    this.states.set(profile.id, state);
    console.log(`[engine] Launching runner for @${profile.username}`);

    const loop = async () => {
      // Seed daily/hourly counters from DB — survives server restarts
      try {
        const [dc, hc] = await Promise.all([
          storage.countFollowsToday(profile.id, todayStr()),
          storage.countFollowsThisHour(profile.id, hourStr()),
        ]);
        if (state.dailyDate === todayStr())  state.dailyCount  = dc;
        if (state.hourlyHour === hourStr())  state.hourlyCount = hc;
        console.log(`[engine] @${profile.username}: restored dailyCount=${dc} hourlyCount=${hc} from DB`);
      } catch { /* non-fatal */ }

      // On startup: apply X-Y random delay. On manual toggle-on (runImmediately=true): start
      // right away unless a Copy-Settings stagger offset is set, in which case only that
      // offset applies (no additional random X-Y wait).
      {
        const si = (_tool.settings ?? {}) as any;
        const staggerMs = (si.staggerOffsetMins ?? 0) * 60_000;
        if (!runImmediately || staggerMs > 0) {
          const baseWait = runImmediately ? 0 : randInt((si.delayMin ?? 1) * 60_000, (si.delayMax ?? 5) * 60_000);
          const waitMs = baseWait + staggerMs;
          engineLog("INFO", `@${profile.username}: ${runImmediately ? "stagger" : "startup"} — first follow session in ${Math.round(waitMs / 60000)}min${staggerMs > 0 ? ` (+${Math.round(staggerMs / 60000)}min stagger)` : ""} (Run Now will skip this wait)`);
          state.nextFollowAt = Date.now() + waitMs;
          if (si.staggerOffsetMins) {
            storage.updateTool(_tool.id, { settings: { ...si, staggerOffsetMins: 0 } }).catch(() => {});
          }
          const startupEnd = Date.now() + waitMs;
          while (!state.stop.stopped && Date.now() < startupEnd && !this.followForceRun.has(profile.id)) {
            await sleep(1000);
          }
          this.followForceRun.delete(profile.id);
          state.nextFollowAt = 0;
          if (state.stop.stopped) return;
        }
      }

      while (!state.stop.stopped) {
        const freshProfile = await storage.getProfile(profile.id);
        if (!freshProfile) {
          engineLog("WARN", `@${profile.username}: profile ${profile.id} not found in DB — exiting runner`);
          break;
        }

        // Live API limit sync: apply any changes the user saved while the runner
        // was sleeping, so new settings take effect at the next loop tick.
        if (state.client && freshProfile.apiLimits && typeof freshProfile.apiLimits === "object") {
          state.client.updateApiLimits(freshProfile.apiLimits as any);
        }

        // ── Account status gate ──────────────────────────────────────────────
        if (freshProfile.accountStatus === "banned" || freshProfile.accountStatus === "suspended" || freshProfile.accountStatus === "compromised" || freshProfile.accountStatus === "account_disabled") {
          engineLog("WARN", `@${freshProfile.username}: account ${freshProfile.accountStatus} — stopping runner`);
          break;
        }
        if (freshProfile.accountStatus === "bad_password") {
          engineLog("WARN", `@${freshProfile.username}: bad_password — cannot authenticate, pausing 10min (update the password to resume)`);
          await sleep(10 * 60_000);
          continue;
        }
        if (freshProfile.accountStatus === "logged_out") {
          engineLog("WARN", `@${freshProfile.username}: logged_out — session invalid, pausing 5min (re-verify the account to resume)`);
          await sleep(5 * 60_000);
          continue;
        }
        if (freshProfile.accountStatus === "captcha") {
          engineLog("WARN", `@${freshProfile.username}: captcha/checkpoint pending — pausing 5min`);
          await sleep(5 * 60_000);
          continue;
        }
        // EB-first enforcement: never run automation on an account that has not
        // completed at least one successful EB verification.  "pending" means the
        // account was added but Verify Credentials was never run, so no EB session
        // cookie was ever captured — touching the Instagram API from a cold start
        // without a prior browser session is a trust signal Instagram uses to flag
        // accounts.  Pause and retry every 5 min so the runner picks it up as soon
        // as the user runs Verify Credentials on it.
        if (freshProfile.accountStatus === "pending") {
          engineLog("WARN", `@${freshProfile.username}: account not yet verified via browser — pausing 5min (run Verify Credentials to start automation)`);
          await sleep(5 * 60_000);
          continue;
        }
        // Catch-all: any other non-valid status (phone_verification, email_confirmation,
        // stopped, verifying, action_blocked, etc.) — pause and re-check, do not run sessions.
        if (freshProfile.accountStatus !== "valid") {
          engineLog("WARN", `@${freshProfile.username}: account status is "${freshProfile.accountStatus}" — pausing 5min before re-check`);
          await sleep(5 * 60_000);
          continue;
        }
        // ── Active timer gate ─────────────────────────────────────────────────
        if (
          freshProfile.activeTimerEnabled &&
          freshProfile.activeTimerStart &&
          freshProfile.activeTimerEnd
        ) {
          if (!isWithinActiveWindow(freshProfile.activeTimerStart, freshProfile.activeTimerEnd)) {
            const waitMin = minutesUntilWindowOpen(freshProfile.activeTimerStart);
            engineLog("INFO", `@${freshProfile.username}: outside active window (${freshProfile.activeTimerStart}–${freshProfile.activeTimerEnd}) — sleeping ${waitMin}min`);
            await sleep(waitMin * 60_000);
            continue;
          }
        }
        // ─────────────────────────────────────────────────────────────────────

        const tools = await storage.getToolsByProfile(freshProfile.id);
        const followTool = tools.find(t => t.type === "follow");
        engineLog("INFO", `@${freshProfile.username}: follow gate — tool=${followTool?.id ?? "NOT FOUND"} enabled=${followTool?.enabled ?? "n/a"} stopped=${state.stop.stopped}`);
        if (!followTool?.enabled || state.stop.stopped) {
          engineLog("WARN", `@${freshProfile.username}: follow loop exiting — tool disabled or runner stopped`);
          break;
        }

        let sessionResult: { followed: number; scraped: number; dedupSkipped: number; filterSkipped: number; blocked: number; skipped: number } = { followed: 0, scraped: 0, dedupSkipped: 0, filterSkipped: 0, blocked: 0, skipped: 0 };
        try {
          sessionResult = await this.runSession(freshProfile, followTool, state);
        } catch (err: any) {
          const acctStatus = await this.applyAccountLevelError(freshProfile.id, err?.message ?? "", state, followTool.id);
          console.error(`[engine] @${freshProfile.username}: unexpected session error: ${err?.message}`);
          if (acctStatus) break;
        }
        // Persist refreshed mobile session cookies to DB so the stored sessionid
        // never ages out between cycles (Jarvee-parity session keep-alive).
        await this.persistSessionCookies(state, freshProfile.id, freshProfile.username);

        if (state.stop.stopped) break;

        // ── Auto follow → unfollow switch (Enable Automatic Unfollows) ──────
        {
          const sa = followTool.settings as any;
          if (sa.autoFollowUnfollowEnabled && (freshProfile.followingCount ?? 0) > 0) {
            const stopAt = randInt(
              sa.autoStopFollowAtFollowingsMin ?? 7400,
              sa.autoStopFollowAtFollowingsMax ?? 7400,
            );
            if ((freshProfile.followingCount ?? 0) >= stopAt) {
              console.log(`[engine] @${freshProfile.username}: followings ${freshProfile.followingCount} >= ${stopAt} — auto: disabling follow tool`);
              await storage.updateTool(followTool.id, { enabled: false });
              if (sa.autoStartUnfollowStaggerEnabled) {
                const delayMs = randInt(
                  (sa.autoStartUnfollowAfterMin ?? 60) * 60_000,
                  (sa.autoStartUnfollowAfterMax ?? 135) * 60_000,
                );
                console.log(`[engine] @${freshProfile.username}: auto: enabling unfollow tool in ${Math.round(delayMs / 60000)}min`);
                await sleep(delayMs);
              }
              // Always enable the opposite tool — do NOT gate on state.stop.stopped.
              // reconcile() fires during the stagger sleep, sees follow disabled, sets
              // state.stop.stopped = true, which would otherwise prevent this code from
              // running. We've already committed to the switch so always proceed.
              const tools2 = await storage.getToolsByProfile(freshProfile.id);
              const unfollowTool2 = tools2.find(t => t.type === "unfollow");
              if (unfollowTool2) {
                await storage.updateTool(unfollowTool2.id, { enabled: true });
                this.triggerUnfollow(freshProfile.id);
              }
              console.log(`[engine] @${freshProfile.username}: auto: unfollow tool enabled`);
              break;
            }
          }
        }

        const s = followTool.settings as any;

        const waitMs = randInt(
          (s.delayMin ?? 1) * 60_000,
          (s.delayMax ?? 5) * 60_000,
        );
        state.nextFollowAt = Date.now() + waitMs;
        engineLog("INFO", `@${freshProfile.username}: next follow session in ${Math.round(waitMs / 60000)}min (Run Now will skip this wait)`);
        // Sleep until timer expires, tool stops, or a force-run is requested (Run Now button)
        const endAt = Date.now() + waitMs;
        while (!state.stop.stopped && Date.now() < endAt && !this.followForceRun.has(freshProfile.id)) {
          await sleep(1000);
        }
        this.followForceRun.delete(freshProfile.id);
        state.nextFollowAt = 0; // executing
      }

      this.states.delete(profile.id);
      console.log(`[engine] Runner exited for @${profile.username}`);
    };

    loop().catch(err => {
      this.runnerCrashedIds.add(profile.id);
      this.states.delete(profile.id);
      engineLog("ERROR", `@${profile.username}: FATAL follow runner crash: ${err?.message ?? err}\n${err?.stack ?? ""}`);
    });
  }

  // ── Human session runner ──────────────────────────────────────────────────
  private launchHumanSession(profile: Profile, _tool: Tool, runImmediately = false) {
    apiSessionEpochs.set(profile.id, Date.now());
    const state: ProfileState = {
      stop: { stopped: false },
      client: null,
      dailyCount: 0, dailyDate: todayStr(),
      hourlyCount: 0, hourlyHour: hourStr(),
      actionSuspensions: {},
      nextHumanSessionAt: 0,   // run immediately on first tick
      lastHumanToolsEnabled: true,
      nextFollowAt: 0,
      nextContactAt: 0,
      nextUnfollowAt: 0,
    };
    // On startup: schedule first run using configured X-Y timers.
    // On user toggle-on (runImmediately = true, no stagger): nextHumanSessionAt = 0 → fires right away.
    // On copy-settings cold restart (runImmediately = true, staggerOffsetMins > 0): apply stagger delay.
    // Matches the follow/unfollow pattern: `if (!runImmediately || staggerMs > 0)`.
    const si = (_tool.settings ?? {}) as any;
    const staggerMs = (si.staggerOffsetMins ?? 0) * 60_000;
    if (si.staggerOffsetMins) {
      storage.updateTool(_tool.id, { settings: { ...si, staggerOffsetMins: 0 } }).catch(() => {});
    }
    if (!runImmediately || staggerMs > 0) {
      if (staggerMs) {
        state.nextHumanSessionAt = Date.now() + staggerMs;
        console.log(`[engine] @${profile.username}: ${runImmediately ? "stagger" : "startup"} — human session staggered ${si.staggerOffsetMins}min`);
      } else {
        const waitMs = randInt((si.delayMin ?? 30) * 60_000, (si.delayMax ?? 60) * 60_000);
        state.nextHumanSessionAt = Date.now() + waitMs;
        console.log(`[engine] @${profile.username}: startup — first human session in ${Math.round(waitMs / 60000)}min`);
      }
    } else if (si.randomiseTiming && runImmediately) {
      // Randomise timing enabled: spread accounts across the delay window even on manual toggle-on
      const waitMs = randInt(0, (si.delayMax ?? 60) * 60_000);
      state.nextHumanSessionAt = Date.now() + waitMs;
      console.log(`[engine] @${profile.username}: randomise timing — first human session in ${Math.round(waitMs / 60000)}min`);
    }
    this.humanSessionStates.set(profile.id, state);
    const wakeSignal = { wake: false };
    this.hsWakeSignals.set(profile.id, wakeSignal);
    console.log(`[engine] Launching human session runner for @${profile.username}`);

    const loop = async () => {
      while (!state.stop.stopped) {
        const freshProfile = await storage.getProfile(profile.id);
        if (!freshProfile) break;
        if (state.client && freshProfile.apiLimits && typeof freshProfile.apiLimits === "object") {
          state.client.updateApiLimits(freshProfile.apiLimits as any);
        }
        if (freshProfile.accountStatus === "banned" || freshProfile.accountStatus === "suspended" || freshProfile.accountStatus === "compromised" || freshProfile.accountStatus === "account_disabled") break;
        if (freshProfile.accountStatus === "bad_password") {
          engineLog("WARN", `@${freshProfile.username}: bad_password — cannot authenticate, pausing 10min (update the password to resume)`);
          await sleepInterruptible(10 * 60_000, state.stop);
          continue;
        }
        if (freshProfile.accountStatus === "logged_out") {
          engineLog("WARN", `@${freshProfile.username}: logged_out — session invalid, pausing 5min (re-verify the account to resume)`);
          await sleepInterruptible(5 * 60_000, state.stop);
          continue;
        }
        if (freshProfile.accountStatus !== "valid") {
          engineLog("WARN", `@${freshProfile.username}: HS waiting — account status is "${freshProfile.accountStatus}" (not yet valid), pausing 5min`);
          await sleepInterruptible(5 * 60_000, state.stop);
          continue;
        }
        if (freshProfile.accountStatus === "captcha") {
          engineLog("WARN", `@${freshProfile.username}: HS waiting — captcha challenge, pausing 5min`);
          await sleepInterruptible(5 * 60_000, state.stop);
          continue;
        }

        const freshTools = await storage.getToolsByProfile(freshProfile.id);
        const hsTool = freshTools.find(t => t.type === "human_sessions");
        // Exit if tool was disabled or deleted — reconcile will not re-launch
        if (!hsTool?.enabled) break;

        const s = hsTool.settings as any;

        if (Date.now() >= state.nextHumanSessionAt) {
          // Acquire proxy slot immediately before the session starts.
          // HS manages its own per-session slot lifecycle so the slot is only
          // held while the account is actually active — not during the long
          // inter-session sleep (125-250 min, etc.).
          if (freshProfile.proxyId) {
            const slotCheck = proxySlotManager.canAcquire(freshProfile.proxyId, freshProfile.id);
            if (!slotCheck.ok) {
              console.log(`[engine] @${freshProfile.username}: proxy slot unavailable for HS session — ${slotCheck.reason} — will retry next cycle`);
              await sleepInterruptible(10_000, state.stop);
              continue;
            }
            proxySlotManager.acquire(freshProfile.proxyId, freshProfile.id);
          }
          this.logAction(freshProfile.id, hsTool.id, "human_session_start", "", "", "", "ok", "Human Session Emulation started");
          let acctStatusBroke = false;
          try {
            await this.runHumanSessionTools(freshProfile, hsTool, state);
            await storage.incrementStat(freshProfile.id, "human_session");
            this.logAction(freshProfile.id, hsTool.id, "tool_complete", "", "", "", "ok", "Human Session complete");
          } catch (err: any) {
            const acctStatus = await this.applyAccountLevelError(freshProfile.id, err?.message ?? "", state, hsTool.id);
            this.logAction(freshProfile.id, hsTool.id, "tool_complete", "", "", "", "error", `Human Session error: ${err?.message ?? "unknown"}`);
            console.error(`[engine] @${freshProfile.username}: human session error: ${err?.message}`);
            if (acctStatus) acctStatusBroke = true;
          } finally {
            // Release the slot and start the cooldown timer — the account is now
            // silent. A new session (or another account) can only use this proxy
            // slot after the cooldown window expires.
            if (freshProfile.proxyId) {
              proxySlotManager.release(freshProfile.proxyId, freshProfile.id);
            }
          }
          if (acctStatusBroke) break;
          const waitMs = randInt(
            (s.delayMin ?? 30) * 60_000,
            (s.delayMax ?? 60) * 60_000,
          );
          state.nextHumanSessionAt = Date.now() + waitMs;
          console.log(`[engine] @${freshProfile.username}: next human session in ${Math.round(waitMs / 60000)}min`);
        }

        // Idle tick: sleep 1 s at a time so triggerHumanSession's wake signal
        // interrupts within ≤1 s instead of waiting up to 10 s.
        const tickEnd = Date.now() + 10_000;
        while (!state.stop.stopped && !wakeSignal.wake && Date.now() < tickEnd) {
          await sleep(1_000);
        }
        wakeSignal.wake = false;
      }
      this.humanSessionStates.delete(profile.id);
      this.hsWakeSignals.delete(profile.id);
      console.log(`[engine] Human session runner exited for @${profile.username}`);
    };

    loop().catch(err => {
      this.runnerCrashedIds.add(profile.id);
      this.humanSessionStates.delete(profile.id);
      this.hsWakeSignals.delete(profile.id);
      console.error(`[engine] Fatal human session error for @${profile.username}:`, err?.message);
    });
  }

  // ── Unfollow runner launch ─────────────────────────────────────────────────
  private launchUnfollow(profile: Profile, _tool: Tool, runImmediately = false) {
    apiSessionEpochs.set(profile.id, Date.now());
    const state: ProfileState = {
      stop: { stopped: false },
      client: null,
      dailyCount: 0, dailyDate: todayStr(),
      hourlyCount: 0, hourlyHour: hourStr(),
      actionSuspensions: {},
      nextHumanSessionAt: 0,
      lastHumanToolsEnabled: false,
      nextFollowAt: 0,
      nextContactAt: 0,
      nextUnfollowAt: 0,
    };
    this.unfollowStates.set(profile.id, state);
    console.log(`[engine] Launching unfollow runner for @${profile.username}`);

    const loop = async () => {
      {
        const si = (_tool.settings ?? {}) as any;
        const staggerMs = (si.staggerOffsetMins ?? 0) * 60_000;
        if (!runImmediately || staggerMs > 0) {
          const baseWait = runImmediately ? 0 : randInt((si.delayMin ?? 5) * 60_000, (si.delayMax ?? 15) * 60_000);
          const waitMs = baseWait + staggerMs;
          console.log(`[engine] @${profile.username}: ${runImmediately ? "stagger" : "startup"} — first unfollow session in ${Math.round(waitMs / 60000)}min${staggerMs > 0 ? ` (+${Math.round(staggerMs / 60000)}min stagger)` : ""}`);
          state.nextUnfollowAt = Date.now() + waitMs;
          if (si.staggerOffsetMins) {
            storage.updateTool(_tool.id, { settings: { ...si, staggerOffsetMins: 0 } }).catch(() => {});
          }
          await sleepInterruptible(waitMs, state.stop);
          state.nextUnfollowAt = 0;
          if (state.stop.stopped) return;
        }
      }

      while (!state.stop.stopped) {
        const freshProfile = await storage.getProfile(profile.id);
        if (!freshProfile) break;
        if (state.client && freshProfile.apiLimits && typeof freshProfile.apiLimits === "object") {
          state.client.updateApiLimits(freshProfile.apiLimits as any);
        }
        if (freshProfile.accountStatus === "banned" || freshProfile.accountStatus === "suspended" || freshProfile.accountStatus === "compromised" || freshProfile.accountStatus === "account_disabled") break;
        if (freshProfile.accountStatus === "bad_password") { engineLog("WARN", `@${freshProfile.username}: bad_password — pausing 10min`); await sleep(10 * 60_000); continue; }
        if (freshProfile.accountStatus === "logged_out")   { engineLog("WARN", `@${freshProfile.username}: logged_out — pausing 5min`);  await sleep(5  * 60_000); continue; }
        if (freshProfile.accountStatus !== "valid") { await sleep(5 * 60_000); continue; }
        if (freshProfile.accountStatus === "captcha") { await sleep(5 * 60_000); continue; }

        const tools = await storage.getToolsByProfile(freshProfile.id);
        const unfollowTool = tools.find(t => t.type === "unfollow");
        if (!unfollowTool?.enabled || state.stop.stopped) break;

        try {
          await this.runUnfollowSession(freshProfile, unfollowTool, state);
        } catch (err: any) {
          const acctStatus = await this.applyAccountLevelError(freshProfile.id, err?.message ?? "", state, unfollowTool.id);
          console.error(`[engine] @${freshProfile.username}: unfollow session error: ${err?.message}`);
          if (acctStatus) break;
        }
        await this.persistSessionCookies(state, freshProfile.id, freshProfile.username);

        if (state.stop.stopped) break;

        // ── Auto unfollow → follow switch (Enable Automatic Follows) ────────
        {
          const sa = unfollowTool.settings as any;
          if (sa.autoFollowEnabled && (freshProfile.followingCount ?? 0) > 0) {
            const dropTo = randInt(
              sa.autoStartFollowAtFollowingsMin ?? 5000,
              sa.autoStartFollowAtFollowingsMax ?? 5000,
            );
            if ((freshProfile.followingCount ?? 0) <= dropTo) {
              console.log(`[engine] @${freshProfile.username}: followings ${freshProfile.followingCount} <= ${dropTo} — auto: disabling unfollow tool`);
              await storage.updateTool(unfollowTool.id, { enabled: false });
              if (sa.autoStartFollowStaggerEnabled) {
                const delayMs = randInt(
                  (sa.autoStartFollowAfterMin ?? 60) * 60_000,
                  (sa.autoStartFollowAfterMax ?? 120) * 60_000,
                );
                console.log(`[engine] @${freshProfile.username}: auto: enabling follow tool in ${Math.round(delayMs / 60000)}min`);
                await sleep(delayMs);
              }
              // Always enable the opposite tool — do NOT gate on state.stop.stopped.
              // reconcile() fires during the stagger sleep, sees unfollow disabled, sets
              // state.stop.stopped = true, which would otherwise prevent this code from
              // running. We've already committed to the switch so always proceed.
              const tools2 = await storage.getToolsByProfile(freshProfile.id);
              const followTool2 = tools2.find(t => t.type === "follow");
              if (followTool2) {
                await storage.updateTool(followTool2.id, { enabled: true });
                this.triggerFollow(freshProfile.id);
              }
              console.log(`[engine] @${freshProfile.username}: auto: follow tool enabled`);
              break;
            }
          }
        }

        const s = unfollowTool.settings as any;
        const waitMs = randInt((s.delayMin ?? 5) * 60_000, (s.delayMax ?? 15) * 60_000);
        console.log(`[engine] @${freshProfile.username}: next unfollow session in ${Math.round(waitMs / 60000)}min`);
        state.nextUnfollowAt = Date.now() + waitMs;
        await sleepInterruptible(waitMs, state.stop);
        state.nextUnfollowAt = 0;
      }
      this.unfollowStates.delete(profile.id);
      console.log(`[engine] Unfollow runner exited for @${profile.username}`);
    };

    loop().catch(err => {
      this.runnerCrashedIds.add(profile.id);
      this.unfollowStates.delete(profile.id);
      console.error(`[engine] Fatal unfollow error for @${profile.username}:`, err?.message);
    });
  }

  // ── DM runner launch ─────────────────────────────────────────────────────
  private launchDM(profile: Profile, _tool: Tool, runImmediately = false) {
    apiSessionEpochs.set(profile.id, Date.now());
    const state: ProfileState = {
      stop: { stopped: false },
      client: null,
      dailyCount: 0, dailyDate: todayStr(),
      hourlyCount: 0, hourlyHour: hourStr(),
      actionSuspensions: {},
      nextHumanSessionAt: 0,
      lastHumanToolsEnabled: false,
      nextFollowAt: 0,
      nextContactAt: 0,
      nextUnfollowAt: 0,
    };
    this.dmStates.set(profile.id, state);
    console.log(`[engine] Launching DM runner for @${profile.username}`);

    const loop = async () => {
      {
        const si = (_tool.settings ?? {}) as any;
        const staggerMs = (si.staggerOffsetMins ?? 0) * 60_000;
        if (!runImmediately || staggerMs > 0) {
          const baseWait = runImmediately ? 0 : randInt((si.delayMin ?? 10) * 60_000, (si.delayMax ?? 30) * 60_000);
          const waitMs = baseWait + staggerMs;
          console.log(`[engine] @${profile.username}: ${runImmediately ? "stagger" : "startup"} — first DM session in ${Math.round(waitMs / 60000)}min${staggerMs > 0 ? ` (+${Math.round(staggerMs / 60000)}min stagger)` : ""}`);
          if (si.staggerOffsetMins) {
            storage.updateTool(_tool.id, { settings: { ...si, staggerOffsetMins: 0 } }).catch(() => {});
          }
          await sleepInterruptible(waitMs, state.stop);
          if (state.stop.stopped) return;
        }
      }

      while (!state.stop.stopped) {
        const freshProfile = await storage.getProfile(profile.id);
        if (!freshProfile) break;
        if (state.client && freshProfile.apiLimits && typeof freshProfile.apiLimits === "object") {
          state.client.updateApiLimits(freshProfile.apiLimits as any);
        }
        if (freshProfile.accountStatus === "banned" || freshProfile.accountStatus === "suspended" || freshProfile.accountStatus === "compromised" || freshProfile.accountStatus === "account_disabled") break;
        if (freshProfile.accountStatus === "bad_password") { engineLog("WARN", `@${freshProfile.username}: bad_password — pausing 10min`); await sleep(10 * 60_000); continue; }
        if (freshProfile.accountStatus === "logged_out")   { engineLog("WARN", `@${freshProfile.username}: logged_out — pausing 5min`);  await sleep(5  * 60_000); continue; }
        if (freshProfile.accountStatus !== "valid") { await sleep(5 * 60_000); continue; }
        if (freshProfile.accountStatus === "captcha") { await sleep(5 * 60_000); continue; }

        const tools = await storage.getToolsByProfile(freshProfile.id);
        const dmTool = tools.find(t => t.type === "dm");
        if (!dmTool?.enabled || state.stop.stopped) break;

        try {
          await this.runDMSession(freshProfile, dmTool, state);
        } catch (err: any) {
          const acctStatus = await this.applyAccountLevelError(freshProfile.id, err?.message ?? "", state, dmTool.id);
          console.error(`[engine] @${freshProfile.username}: DM session error: ${err?.message}`);
          if (acctStatus) break;
        }
        await this.persistSessionCookies(state, freshProfile.id, freshProfile.username);

        if (state.stop.stopped) break;
        const s = dmTool.settings as any;
        const waitMs = randInt((s.delayMin ?? 10) * 60_000, (s.delayMax ?? 30) * 60_000);
        console.log(`[engine] @${freshProfile.username}: next DM session in ${Math.round(waitMs / 60000)}min`);
        await sleepInterruptible(waitMs, state.stop);
      }
      this.dmStates.delete(profile.id);
      console.log(`[engine] DM runner exited for @${profile.username}`);
    };

    loop().catch(err => {
      this.runnerCrashedIds.add(profile.id);
      this.dmStates.delete(profile.id);
      console.error(`[engine] Fatal DM error for @${profile.username}:`, err?.message);
    });
  }

  // ── Contact (new-follower + users send) runner ────────────────────────────
  private launchContact(profile: Profile, _tool: Tool, runImmediately = false) {
    apiSessionEpochs.set(profile.id, Date.now());
    const state: ProfileState = {
      stop: { stopped: false },
      client: null,
      dailyCount: 0, dailyDate: todayStr(),
      hourlyCount: 0, hourlyHour: hourStr(),
      actionSuspensions: {},
      nextHumanSessionAt: 0,
      lastHumanToolsEnabled: false,
      nextFollowAt: 0,
      nextContactAt: 0,
      nextUnfollowAt: 0,
    };
    this.contactStates.set(profile.id, state);
    console.log(`[engine] Launching contact runner for @${profile.username}`);

    // Each timer is tracked separately so they run on their own independent cadence.
    // On startup: schedule using configured X-Y timers. On user toggle-on: start immediately.
    const _cs = (_tool.settings ?? {}) as any;
    // Stagger always applies when set (even on manual toggle); random X-Y only on startup.
    const _staggerMs = (_cs.staggerOffsetMins ?? 0) * 60_000;
    if (_cs.staggerOffsetMins) {
      storage.updateTool(_tool.id, { settings: { ..._cs, staggerOffsetMins: 0 } }).catch(() => {});
    }
    const _baseFollowerWait = runImmediately ? 0 : randInt(
      (_cs.contactUsersDelayMin ?? _cs.delayMin ?? 30) * 60_000,
      (_cs.contactUsersDelayMax ?? _cs.delayMax ?? 60) * 60_000,
    );
    const _baseUsersWait = runImmediately ? 0 : randInt(
      (_cs.contactUsersDelayMin ?? _cs.delayMin ?? 30) * 60_000,
      (_cs.contactUsersDelayMax ?? _cs.delayMax ?? 60) * 60_000,
    );
    const _followerWaitMs = _baseFollowerWait + _staggerMs;
    const _usersWaitMs    = _baseUsersWait    + _staggerMs;
    if (_followerWaitMs > 0 || _usersWaitMs > 0) {
      console.log(`[engine] @${profile.username}: ${runImmediately ? "stagger" : "startup"} — first contact run in ${Math.round(_followerWaitMs / 60000)}min${_staggerMs > 0 ? ` (+${Math.round(_staggerMs / 60000)}min stagger)` : ""}`);
    }
    let nextFollowerCheckAt = Date.now() + _followerWaitMs;
    let nextUsersSessionAt  = Date.now() + _usersWaitMs;

    // Toggle-detection: reset timer immediately when sub-features are re-enabled
    let lastContactNewFollowersEnabled: boolean | undefined = undefined;
    let lastContactUsersEnabled: boolean | undefined = undefined;

    const loop = async () => {
      while (!state.stop.stopped) {
        const freshProfile = await storage.getProfile(profile.id);
        if (!freshProfile) break;
        if (state.client && freshProfile.apiLimits && typeof freshProfile.apiLimits === "object") {
          state.client.updateApiLimits(freshProfile.apiLimits as any);
        }
        if (freshProfile.accountStatus === "banned" || freshProfile.accountStatus === "suspended" || freshProfile.accountStatus === "compromised" || freshProfile.accountStatus === "account_disabled") break;
        if (freshProfile.accountStatus === "bad_password") { engineLog("WARN", `@${freshProfile.username}: bad_password — pausing 10min`); await sleep(10 * 60_000); continue; }
        if (freshProfile.accountStatus === "logged_out")   { engineLog("WARN", `@${freshProfile.username}: logged_out — pausing 5min`);  await sleep(5  * 60_000); continue; }
        if (freshProfile.accountStatus !== "valid") { await sleep(5 * 60_000); continue; }
        if (freshProfile.accountStatus === "captcha") { await sleep(5 * 60_000); continue; }

        const tools = await storage.getToolsByProfile(freshProfile.id);
        const contactTool = tools.find(t => t.type === "contact");
        // Master switch: if contactTool.enabled is false the whole tool is off.
        const stillEnabled = contactTool?.enabled === true;
        if (!stillEnabled || state.stop.stopped) break;

        const s = contactTool.settings as any;
        const now = Date.now();

        // Detect toggle-on transitions and reset timers so next run is immediate
        const newFollowersEnabled = s.contactNewFollowersEnabled === true;
        const usersEnabled = s.contactUsersEnabled === true;
        if (lastContactNewFollowersEnabled === false && newFollowersEnabled) {
          nextFollowerCheckAt = 0;
          console.log(`[engine] @${freshProfile.username}: contactNewFollowers toggled ON — running immediately`);
        }
        if (lastContactUsersEnabled === false && usersEnabled) {
          nextUsersSessionAt = 0;
          console.log(`[engine] @${freshProfile.username}: contactUsers toggled ON — running immediately`);
        }
        lastContactNewFollowersEnabled = newFollowersEnabled;
        lastContactUsersEnabled = usersEnabled;

        // ── New Followers → enqueue to pending ─────────────────────────────
        if (now >= nextFollowerCheckAt) {
          if (newFollowersEnabled) {
            try {
              const { fetched, source: apiSource } = await this.runContactNewFollowersSession(freshProfile, contactTool, state);
              this.logAction(freshProfile.id, contactTool.id, "tool_complete", "", "", "", "ok", `Extracted ${fetched} new follower${fetched === 1 ? "" : "s"} via ${apiSource}`);
            } catch (err: any) {
              this.logAction(freshProfile.id, contactTool.id, "tool_complete", "", "", "", "error", `Check new followers error: ${err?.message ?? "unknown"}`);
              console.error(`[engine] @${freshProfile.username}: new-follower contact session error: ${err?.message}`);
            }
            await this.persistSessionCookies(state, freshProfile.id, freshProfile.username);
          }
          const waitMs = randInt(
            (s.contactCheckIntervalMin ?? 30) * 60_000,
            (s.contactCheckIntervalMax ?? 60) * 60_000
          );
          nextFollowerCheckAt = Date.now() + waitMs;
          state.nextContactAt = Math.min(nextFollowerCheckAt, nextUsersSessionAt || nextFollowerCheckAt);
          console.log(`[engine] @${freshProfile.username}: next follower check in ${Math.round(waitMs / 60000)}min`);
        }

        if (state.stop.stopped) break;

        // ── Contact Users → send from pending queue ─────────────────────────
        if (now >= nextUsersSessionAt) {
          if (usersEnabled) {
            try {
              const sentCount = await this.runContactUsersSession(freshProfile, contactTool, state);
              if (sentCount > 0) {
                this.logAction(freshProfile.id, contactTool.id, "tool_complete", "", "", "", "ok", `Contact Tool: sent ${sentCount} DM${sentCount !== 1 ? "s" : ""}`);
              }
              // If sentCount === 0 (no pending messages), nothing is logged — nothing was done
            } catch (err: any) {
              this.logAction(freshProfile.id, contactTool.id, "tool_complete", "", "", "", "error", `Contact Tool DM send error: ${err?.message ?? "unknown"}`);
              console.error(`[engine] @${freshProfile.username}: contact-users send session error: ${err?.message}`);
            }
            await this.persistSessionCookies(state, freshProfile.id, freshProfile.username);
          }
          const waitMs = randInt(
            (s.contactUsersWaitMin ?? 30) * 60_000,
            (s.contactUsersWaitMax ?? 60) * 60_000
          );
          nextUsersSessionAt = Date.now() + waitMs;
          state.nextContactAt = Math.min(nextFollowerCheckAt || nextUsersSessionAt, nextUsersSessionAt);
          console.log(`[engine] @${freshProfile.username}: next users send in ${Math.round(waitMs / 60000)}min`);
        }

        if (state.stop.stopped) break;

        // ── Unsend check ────────────────────────────────────────────────────
        try {
          await this.runContactUnsends(freshProfile, state);
        } catch (err: any) {
          console.error(`[engine] @${freshProfile.username}: unsend check error: ${err?.message}`);
        }

        await sleepInterruptible(5_000, state.stop); // poll every 5s to check if timers are due or force-run set
        // Check if a "Send Now" was requested externally
        if (this.contactForceRun.has(profile.id)) {
          this.contactForceRun.delete(profile.id);
          nextUsersSessionAt = 0;
          console.log(`[engine] @${freshProfile.username}: contact send forced immediately`);
        }
      }
      this.contactStates.delete(profile.id);
      console.log(`[engine] Contact runner exited for @${profile.username}`);
    };

    loop().catch(err => {
      this.runnerCrashedIds.add(profile.id);
      this.contactStates.delete(profile.id);
      console.error(`[engine] Fatal contact error for @${profile.username}:`, err?.message);
    });
  }

  // ── Contact New Followers: scrape followers → enqueue to pending ───────────
  // Returns { fetched, source } so the caller can build a clean log message.
  private async runContactNewFollowersSession(profile: Profile, tool: Tool, state: ProfileState, countOverride?: number): Promise<{ fetched: number; source: string }> {
    const s = tool.settings as any;

    const messageTemplate: string = (s.contactMessage ?? "").trim();
    if (!messageTemplate) {
      throw new Error("No message configured — type a message in the Contact New Followers settings before extracting.");
    }

    const usersToCheck = countOverride ?? randInt(s.contactUsersPerCheckMin ?? 1, s.contactUsersPerCheckMax ?? 20);

    const globalSettings = await storage.getGlobalSettings();
    const useHiker = s.contactApiSource === "hiker"
      && globalSettings.hikerApiEnabled === "true"
      && !!globalSettings.hikerApiToken;
    const source = useHiker ? "HikerAPI" : "account";
    const useHikerContactByUsername   = useHiker && globalSettings.hikerContactByUsername !== "false";
    const useHikerContactGetFollowers = useHiker && globalSettings.hikerContactGetFollowers !== "false";

    const hikerClient = useHiker ? new HikerApiClient(globalSettings.hikerApiToken!) : null;

    // When HikerAPI is enabled, resolve own user ID through HikerAPI (no account API call).
    // Otherwise fall back to account client.
    let ownUserId: string | null = null;
    if (useHikerContactByUsername && hikerClient) {
      // Use cached pk if available — avoids a redundant v1/user/by/username call every run.
      // Only resolve once; Jarvee does the same (1 call per check cycle, not 2).
      const cached = this.ownUserIdCache.get(profile.id);
      if (cached) {
        ownUserId = cached;
      } else {
        const t0 = Date.now();
        const hikerUser = await hikerClient.getUserByUsername(profile.username);
        ownUserId = hikerUser?.pk ?? null;
        storage.createInstagramApiCall({
          profileId: profile.id,
          username: profile.username,
          operationName: "v1/user/by/username",
          date: new Date().toISOString(),
          message: ownUserId ? `Resolved pk=${ownUserId} for @${profile.username}` : `Could not resolve @${profile.username}`,
          source: "HikerAPI",
          navChain: "",
          ipAddress: "",
          durationMs: Date.now() - t0,
        }).catch(() => {});
        if (!ownUserId) {
          throw new Error(`HikerAPI could not resolve user ID for @${profile.username}`);
        }
        this.ownUserIdCache.set(profile.id, ownUserId);
        console.log(`[engine] @${profile.username}: resolved own userId ${ownUserId} via HikerAPI (cached)`);
      }
    } else {
      const client = await this.ensureClient(profile, state);
      if (!client) return { fetched: 0, source };
      ownUserId = await client.getOwnUserId();
      if (!ownUserId) {
        console.warn(`[engine] @${profile.username}: could not resolve own user ID for contact session`);
        return { fetched: 0, source };
      }
    }

    // Ensure client is initialised (needed for non-HikerAPI DM send path later).
    const client = await this.ensureClient(profile, state);
    if (!client) return { fetched: 0, source };
    client.setApiCallSource("Contact Tool");

    let followers: { pk: string; username: string; fullName: string }[] = [];
    if (useHikerContactGetFollowers && hikerClient) {
      const t1 = Date.now();
      try {
        followers = await hikerClient.getFollowers(ownUserId!, usersToCheck);
        storage.createInstagramApiCall({
          profileId: profile.id,
          username: profile.username,
          operationName: "getNewFollowersHikerAPI",
          date: new Date().toISOString(),
          message: `Fetched ${followers.length} followers for pk=${ownUserId} (requested ${usersToCheck})`,
          source: "HikerAPI",
          navChain: "",
          ipAddress: "",
          durationMs: Date.now() - t1,
        }).catch(() => {});
      } catch (err: any) {
        if (err instanceof HikerCacheMissError) {
          console.log(`[engine] @${profile.username}: HikerAPI followers cache miss — skipping contact session (${err.message})`);
          return { fetched: 0, source };
        }
        throw err;
      }
    } else {
      const t2 = Date.now();
      followers = await client.getFollowers(ownUserId!, usersToCheck);
      storage.createInstagramApiCall({
        profileId: profile.id,
        username: profile.username,
        operationName: "getNewFollowers",
        date: new Date().toISOString(),
        message: `Fetched ${followers.length} followers for pk=${ownUserId} (requested ${usersToCheck})`,
        source: "account",
        navChain: "",
        ipAddress: "",
        durationMs: Date.now() - t2,
      }).catch(() => {});
    }

    if (!followers.length) {
      console.log(`[engine] @${profile.username}: no followers returned for contact session`);
      return { fetched: 0, source };
    }

    let candidates = followers;
    if (s.contactOnlyAppFollowed) {
      const followedUsers = await storage.getFollowedUsersByProfile(profile.id);
      const followedSet = new Set(followedUsers.map(u => u.instagramUsername.toLowerCase()));
      candidates = followers.filter(u => followedSet.has(u.username.toLowerCase()));
    }

    let queued = 0;
    for (const user of candidates) {
      if (state.stop.stopped) break;
      // Skip if already pending (avoid duplicates in the queue)
      if (await storage.isContactAlreadyQueued(profile.id, user.username)) continue;
      // Skip if a DM was already sent to this user (new_follower or any type)
      if (await storage.isContactDmAlreadySent(profile.id, user.username)) continue;
      // Skip if this user already triggered an auto-reply (pending or sent) —
      // we're already in conversation with them, no need to initiate contact.
      if (await storage.isAutoReplyAlreadyQueued(profile.id, user.username)) continue;
      // Replace [FIRSTNAME] before spintax so it works inside spin groups too.
      // fullName comes free from the followers response — no extra API call needed.
      const firstName = String(user.fullName ?? "").trim().split(/\s+/)[0] || user.username;
      const withTokens = messageTemplate.replace(/\[FIRSTNAME\]/gi, firstName);
      const text = this.applySpintax(withTokens);
      await storage.createContactPendingMessage({
        profileId: profile.id,
        instagramUsername: user.username,
        instagramUserId: user.pk,
        messageType: "new_follower",
        messageText: text,
        status: "pending",
        queuedAt: new Date().toISOString(),
      });
      queued++;
    }

    if (queued > 0) {
      console.log(`[engine] @${profile.username}: queued ${queued} new-follower DMs to pending`);
    }
    return { fetched: followers.length, source };
  }

  // ── Contact Users: send from pending queue ─────────────────────────────────
  private async runContactUsersSession(profile: Profile, tool: Tool, state: ProfileState): Promise<number> {
    const s = tool.settings as any;

    // Stop-on-block gate
    if (s.stopOnBlockEnabled && s.toolBlockedUntil && Date.now() < s.toolBlockedUntil) {
      const remMs = s.toolBlockedUntil - Date.now();
      const remH = Math.floor(remMs / 3_600_000);
      const remM = Math.floor((remMs % 3_600_000) / 60_000);
      const remStr = remH > 0 ? `${remH}h ${remM}m` : `${remM}m`;
      this.logAction(profile.id, tool.id, "action_suspended", "", "", "", "skipped", `Tool paused: blocked by Instagram. ${remStr} remaining`);
      return 0;
    }

    // Equinox User: queue a DM to a randomly picked account from the software each session
    if (s.contactEquinoxUserEnabled && (s.contactEquinoxMessage ?? "").trim()) {
      try {
        const allProfiles = await storage.getProfiles();
        let candidates = (allProfiles as any[]).filter(p => p.id !== profile.id && !p.isTemplate);

        // Build the set of usernames already messaged via the Equinox source.
        // When contactEquinoxNoRepeat is enabled, this covers both still-pending
        // messages AND previously-sent messages (all statuses, equinox_user type only).
        const noRepeat = s.contactEquinoxNoRepeat !== false; // default true
        if (noRepeat && candidates.length > 0) {
          const allEquinox = await storage.getContactPendingMessages(profile.id);
          const alreadyMessaged = new Set(
            (allEquinox as any[])
              .filter((m: any) => m.messageType === "equinox_user")
              .map((m: any) => m.instagramUsername)
          );
          candidates = candidates.filter(p => !alreadyMessaged.has(p.username));
          if (candidates.length === 0) {
            console.log(`[engine] @${profile.username}: Equinox — all ${allProfiles.length - 1} accounts already messaged (no-repeat enabled), skipping queue`);
          }
        }

        if (candidates.length > 0) {
          const target = candidates[Math.floor(Math.random() * candidates.length)];
          const targetUsername: string = target.username ?? "";
          // Extract ds_user_id from igApiCookies: "sessionid=X;csrftoken=Y;ds_user_id=Z;..."
          const igApiCookies: string = (target as any).igApiCookies ?? "";
          const dsMatch = igApiCookies.match(/ds_user_id=([^;]+)/);
          const targetUserId = dsMatch?.[1] ?? "";
          const text = this.applySpintax(s.contactEquinoxMessage.trim());
          if (targetUsername && text) {
            // When no-repeat is off, still avoid double-queueing into pending
            if (!noRepeat) {
              const existingPending = await storage.getContactPendingMessages(profile.id, "pending");
              const alreadyQueued = existingPending.some((m: any) => m.instagramUsername === targetUsername);
              if (alreadyQueued) {
                console.log(`[engine] @${profile.username}: Equinox DM to @${targetUsername} already pending — skipping`);
                return;
              }
            }
            await storage.createContactPendingMessage({
              profileId: profile.id,
              instagramUsername: targetUsername,
              instagramUserId: targetUserId,
              messageType: "equinox_user",
              messageText: text,
              queuedAt: new Date().toISOString(),
              status: "pending",
            });
            console.log(`[engine] @${profile.username}: queued Equinox DM → @${targetUsername}`);
          }
        }
      } catch (e: any) {
        console.warn(`[engine] @${profile.username}: equinox user queue error: ${e?.message}`);
      }
    }

    const pending = await storage.getContactPendingMessages(profile.id, "pending");
    if (!pending.length) {
      console.log(`[engine] @${profile.username}: no pending contact messages to send`);
      return 0;
    }

    const sendCount = randInt(s.contactUsersSendCountMin ?? 1, s.contactUsersSendCountMax ?? 5);
    const delayMin  = (s.contactUsersDelayBetweenMin ?? 5) * 1000;
    const delayMax  = (s.contactUsersDelayBetweenMax ?? 15) * 1000;
    const pickRandom = !!s.contactUsersPickRandom;
    const unsendEnabled = !!s.contactUsersUnsendEnabled;
    const unsendMin = (s.contactUsersUnsendMin ?? 30) * 60_000;
    const unsendMax = (s.contactUsersUnsendMax ?? 60) * 60_000;

    let queue = pickRandom
      ? [...pending].sort(() => Math.random() - 0.5)
      : pending;
    queue = queue.slice(0, sendCount);

    const client = await this.ensureClient(profile, state);
    if (!client) return;
    client.setApiCallSource("Contact Tool");

    let sent = 0;
    for (const msg of queue) {
      if (state.stop.stopped) break;
      try {
        const result = await client.sendDirectMessage(msg.instagramUserId, msg.messageText, msg.instagramUsername);
        if (result === "blocked") {
          // Jarvee ABD dismiss — try before suspending the DM tool
          await storage.updateProfile(profile.id, { accountStatus: "automated_behaviour_detected" });
          const abdOk = await client.tryDismissABD();
          if (abdOk) {
            await storage.updateProfile(profile.id, { accountStatus: "valid" });
            await storage.incrementStat(profile.id, "abd");
            console.log(`[engine] @${profile.username}: Contact DM ABD auto-dismissed ✓ — skipping this message, continuing`);
            this.logAction(profile.id, tool.id, "abd_dismissed", msg.instagramUsername, "", "", "ok", "Automated Behavior warning auto-dismissed");
            await storage.updateContactPendingMessage(msg.id, { status: "failed" });
            await sleep(5000);
            continue; // skip this recipient but don't suspend the tool
          }
          await storage.updateProfile(profile.id, { accountStatus: "valid" });
          this.logAction(profile.id, tool.id, "contact_dm_blocked", msg.instagramUsername, "", "", "skipped", "Instagram action-blocked contact DM");
          await storage.updateContactPendingMessage(msg.id, { status: "failed" });
          // Contact DM "blocked" is ABD (Automated Behaviour Detected) — not a real Action Block.
          // Do not trigger Stop Tool if Blocked for ABD errors.
          break;
        }
        if (result) {
          sent++;
          const sentAt = new Date().toISOString();
          const unsendAt = unsendEnabled
            ? new Date(Date.now() + randInt(unsendMin, unsendMax)).toISOString()
            : undefined;
          await storage.updateContactPendingMessage(msg.id, {
            status: "sent",
            sentAt,
            dmThreadId: result.threadId || undefined,
            dmItemId: result.itemId || undefined,
            unsendAt: unsendAt ?? undefined,
          });
          await storage.createContactDmSent({
            profileId: profile.id,
            instagramUsername: msg.instagramUsername,
            instagramUserId: msg.instagramUserId,
            sentAt,
            messagePreview: msg.messageText.slice(0, 100),
          });
          this.logAction(profile.id, tool.id, "contact_dm", msg.instagramUsername, "", "", "ok",
            `Contact DM sent (${msg.messageType}) to @${msg.instagramUsername}`);
          await storage.incrementStat(profile.id, "dm");
          console.log(`[engine] @${profile.username}: 📩 contact DM sent to @${msg.instagramUsername} [${sent}/${queue.length}]`);
          if (sent < queue.length) await sleep(randInt(delayMin, delayMax));
        } else {
          // Non-block send failure (session error, network, transient Instagram error)
          // — leave as "pending" so it's automatically retried on the next send cycle.
          // Only "blocked" results are permanently failed.
          console.warn(`[engine] @${profile.username}: contact DM to @${msg.instagramUsername} failed (non-block, will retry)`);
          this.logAction(profile.id, tool.id, "contact_dm", msg.instagramUsername, "", "", "error", "DM send failed (will retry)");
          break; // stop this batch but keep message pending
        }
      } catch (e: any) {
        const errMsg = igErrMsg(e);
        const acctStatus = await this.applyAccountLevelError(profile.id, e?.message ?? "", state, tool.id);
        if (acctStatus) {
          console.warn(`[engine] @${profile.username}: contact DM threw account-level error (${acctStatus}) — ${errMsg}`);
          this.logAction(profile.id, tool.id, "contact_dm_blocked", msg.instagramUsername, "", "", "error", `[${acctStatus}] ${errMsg}`);
          break;
        }
        console.warn(`[engine] contact DM @${msg.instagramUsername} error: ${errMsg}`);
        this.logAction(profile.id, tool.id, "contact_dm", msg.instagramUsername, "", "", "error", errMsg);
      }
    }
    return sent;
  }

  // ── Contact Unsends: call unsendDirectMessage on due messages ──────────────
  private async runContactUnsends(profile: Profile, state: ProfileState): Promise<void> {
    const due = await storage.getContactMessagesForUnsend(profile.id);
    if (!due.length) return;

    const client = await this.ensureClient(profile, state);
    if (!client) return;
    client.setApiCallSource("Contact Tool");

    for (const msg of due) {
      if (state.stop.stopped) break;
      if (!msg.dmThreadId || !msg.dmItemId) {
        await storage.updateContactPendingMessage(msg.id, { unsendAt: undefined });
        continue;
      }
      try {
        const ok = await client.unsendDirectMessage(msg.dmThreadId, msg.dmItemId);
        if (ok) {
          await storage.updateContactPendingMessage(msg.id, { status: "unsent" as any, unsendAt: undefined });
          console.log(`[engine] @${profile.username}: ↩ unsent DM to @${msg.instagramUsername}`);
        } else {
          await storage.updateContactPendingMessage(msg.id, { unsendAt: undefined });
        }
      } catch (e: any) {
        await this.applyAccountLevelError(profile.id, e?.message ?? "", state);
        console.warn(`[engine] unsend @${msg.instagramUsername} error: ${e?.message}`);
        await storage.updateContactPendingMessage(msg.id, { unsendAt: undefined });
      }
    }
  }

  // ── Auto Reply: scan DM threads for trigger words and enqueue replies ────────
  // Runs automatically after every checkDm action using inbox threads already
  // fetched by getDirectMessagesInternal — no second warm-up, no second fetch.
  // Scans the FULL inbox list so triggers deeper than dmOpenCount are not missed.
  // client is optional — only needed for the "like the triggering DM" feature.
  // Returns the number of auto-replies queued so the caller can include it in the log.
  private async runAutoReplyCheck(
    profile: Profile,
    threads: { threadId: string; username: string; userId: string; firstName: string; items: { itemId: string; text: string; fromMe: boolean }[] }[],
    client?: InstagramWebClient,
  ): Promise<number> {
    const tools = await storage.getToolsByProfile(profile.id);
    const contactTool = tools.find(t => t.type === "contact");
    if (!contactTool) {
      console.log(`[autoReply] @${profile.username}: no contact tool found — skipping`);
      return 0;
    }

    const s = contactTool.settings as any;
    if (!s.autoReplyEnabled) {
      console.log(`[autoReply] @${profile.username}: autoReplyEnabled=false — skipping`);
      return 0;
    }

    const rules: { word: string; reply: string }[] = Array.isArray(s.autoReplies) ? s.autoReplies : [];
    if (!rules.length) {
      console.log(`[autoReply] @${profile.username}: no trigger rules configured — skipping`);
      return 0;
    }
    console.log(`[autoReply] @${profile.username}: scanning DMs — ${rules.length} trigger rule${rules.length === 1 ? "" : "s"}: [${rules.map(r => `"${r.word}"`).join(", ")}]`);

    // Build app-followed set if filter is enabled
    let appFollowedSet: Set<string> | null = null;
    if (s.autoReplyOnlyAppFollowed) {
      const followedUsers = await storage.getFollowedUsersByProfile(profile.id);
      appFollowedSet = new Set(followedUsers.map(u => u.instagramUsername.toLowerCase()));
      console.log(`[autoReply] @${profile.username}: only-app-followed filter active — ${appFollowedSet.size} user(s) eligible`);
    }

    if (!threads.length) {
      console.log(`[autoReply] @${profile.username}: no DM threads to scan`);
      return 0;
    }
    console.log(`[autoReply] @${profile.username}: ${threads.length} thread(s) to scan (full inbox from checkDm fetch)`);

    let queued = 0;
    for (const thread of threads) {
      if (!thread.username || !thread.userId) continue;

      // Only app-followed users filter
      if (appFollowedSet && !appFollowedSet.has(thread.username.toLowerCase())) {
        console.log(`[autoReply] @${profile.username}: skipping @${thread.username} — not in app-followed list`);
        continue;
      }

      // Only look at messages NOT sent by this account (fromMe === false)
      const incomingMessages = thread.items.filter(i => !i.fromMe);
      if (!incomingMessages.length) {
        console.log(`[autoReply] @${profile.username}: @${thread.username} — no incoming messages in thread`);
        continue;
      }

      // Already have a pending auto-reply queued for this user? Skip.
      if (await storage.isAutoReplyAlreadyQueued(profile.id, thread.username)) {
        console.log(`[autoReply] @${profile.username}: @${thread.username} — already has a pending auto-reply, skipping`);
        continue;
      }

      // Check each trigger word against all incoming message texts
      console.log(`[autoReply] @${profile.username}: checking @${thread.username} — ${incomingMessages.length} incoming message(s)`);
      let matched = false;
      for (const rule of rules) {
        if (!rule.word.trim() || !rule.reply.trim()) continue;
        const triggerLower = rule.word.trim().toLowerCase();
        const triggeringMsg = incomingMessages.find(msg => msg.text.toLowerCase().includes(triggerLower));
        if (triggeringMsg) {
          // Replace [FIRSTNAME] before spintax so it works inside spin groups too.
          // firstName comes free from the inbox response — no extra API call needed.
          const withTokens = rule.reply.replace(/\[FIRSTNAME\]/gi, thread.firstName || thread.username);
          const text = this.applySpintax(withTokens);
          await storage.createContactPendingMessage({
            profileId: profile.id,
            instagramUsername: thread.username,
            instagramUserId: thread.userId,
            messageType: "auto_reply",
            messageText: text,
            status: "pending",
            queuedAt: new Date().toISOString(),
          });
          console.log(`[autoReply] @${profile.username}: QUEUED reply to @${thread.username} (firstName="${thread.firstName}") — trigger="${rule.word}" matched in: "${triggeringMsg.text.slice(0, 60)}"`);
          queued++;
          matched = true;

          // Like the triggering DM if enabled (requires client to be available)
          if (s.autoReplyLikeDm && client && thread.threadId && triggeringMsg.itemId) {
            try {
              await client.likeDirectMessage(thread.threadId, triggeringMsg.itemId);
              console.log(`[autoReply] @${profile.username}: liked DM from @${thread.username}`);
            } catch (e: any) {
              console.warn(`[autoReply] @${profile.username}: like DM error: ${e?.message}`);
            }
          }

          break; // one reply per thread per scan
        } else {
          console.log(`[autoReply] @${profile.username}: @${thread.username} — trigger "${rule.word}" not found in ${incomingMessages.length} message(s)`);
        }
      }
      if (matched) continue;
    }

    if (queued > 0) {
      console.log(`[autoReply] @${profile.username}: scan complete — queued ${queued} auto-repl${queued === 1 ? "y" : "ies"} to pending messages`);
    } else {
      console.log(`[autoReply] @${profile.username}: scan complete — no triggers matched`);
    }
    return queued;
  }

  // ── Proxy URL resolver ────────────────────────────────────────────────────
  private async buildProxyUrl(profile: Profile): Promise<string | undefined> {
    if (profile.proxyId) {
      const proxies = await storage.getProxies();
      const p = proxies.find(px => px.id === profile.proxyId);
      if (p) {
        // Adapter proxies: the DB host/port is stale after every restart.
        // Always use the live in-process tunnel port; auto-start if needed.
        if (p.proxyType === "adapter") {
          const runningPort = getAdapterProxyPort(p.id);
          if (runningPort) return `http://127.0.0.1:${runningPort}`;
          const adapterName = p.adapterName ?? "";
          const ip = getAdapterIp(adapterName);
          if (ip) {
            try {
              const port = await startAdapterProxy(p.id, adapterName);
              await storage.updateProxy(p.id, { host: "127.0.0.1", port });
              console.log(`[adapter] buildProxyUrl auto-started tunnel for proxy ${p.id} "${adapterName}" → 127.0.0.1:${port}`);
              return `http://127.0.0.1:${port}`;
            } catch (err) {
              console.warn(`[adapter] buildProxyUrl failed to auto-start tunnel for proxy ${p.id}:`, err);
            }
          }
          console.warn(`[adapter] buildProxyUrl: adapter "${p.adapterName}" not plugged in or tunnel failed — returning undefined`);
          return undefined;
        }
        const auth = p.username && p.password
          ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@`
          : "";
        return `http://${auth}${p.host}:${p.port}`;
      }
    }
    if (profile.proxyHost && profile.proxyPort) {
      const auth = profile.proxyUsername && profile.proxyPassword
        ? `${encodeURIComponent(profile.proxyUsername)}:${encodeURIComponent(profile.proxyPassword)}@`
        : "";
      return `http://${auth}${profile.proxyHost}:${profile.proxyPort}`;
    }
    return undefined;
  }

  private async buildProxyConfig(profile: Profile): Promise<ProxyConfig | undefined> {
    if (profile.proxyId) {
      const proxies = await storage.getProxies();
      const p = proxies.find(px => px.id === profile.proxyId);
      if (p) {
        // Adapter proxies: use the live tunnel port, same as buildProxyUrl.
        if (p.proxyType === "adapter") {
          const runningPort = getAdapterProxyPort(p.id);
          if (runningPort) return { host: "127.0.0.1", port: runningPort };
          const adapterName = p.adapterName ?? "";
          const ip = getAdapterIp(adapterName);
          if (ip) {
            try {
              const port = await startAdapterProxy(p.id, adapterName);
              await storage.updateProxy(p.id, { host: "127.0.0.1", port });
              return { host: "127.0.0.1", port };
            } catch {}
          }
          return undefined;
        }
        return { host: p.host, port: p.port, username: p.username ?? undefined, password: p.password ?? undefined };
      }
    }
    if (profile.proxyHost && profile.proxyPort) {
      return {
        host: profile.proxyHost,
        port: Number(profile.proxyPort),
        username: profile.proxyUsername ?? undefined,
        password: profile.proxyPassword ?? undefined,
      };
    }
    return undefined;
  }

  private defaultUA(profile: Profile): string {
    return profile.userAgentEmbedded ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
  }

  // ── Ensure logged-in client ───────────────────────────────────────────────
  private async ensureClient(profile: Profile, state: ProfileState): Promise<InstagramWebClient | null> {
    // Disable API mode: block every mobile API call for this account.
    if ((profile.apiLimits as any)?.disableApi === true) {
      console.log(
        `[api-shield:${profile.id}] @${profile.username} ── BROWSER-ONLY MODE\n` +
        `  mobile-api  : ✗ BLOCKED (disableApi=true — ensureClient returns null)\n` +
        `  eb          : EB session will be attempted for this account; proxy is\n` +
        `                enforced there — look for [eb-shield:${profile.id}] in the log.\n` +
        `                If no [eb-shield] line appears, the EB session did not open.`
      );
      return null;
    }

    const proxyUrl = await this.buildProxyUrl(profile);
    if (!proxyUrl) {
      console.error(`[engine] @${profile.username}: no proxy assigned — refusing to connect without proxy`);
      return null;
    }

    // Recreate client if proxy has changed since the client was created
    if (state.client && state.currentProxyUrl !== proxyUrl) {
      console.log(`[engine] @${profile.username}: proxy changed (${state.currentProxyUrl} → ${proxyUrl}), recreating client`);
      state.client = null;
    }

    // Create client once per profile lifecycle (or after proxy change above)
    if (!state.client) {
      state.client = new InstagramWebClient(proxyUrl, profile.id);
      state.currentProxyUrl = proxyUrl;
      // Log every API call — no filtering.
      state.client.setLogger((op, durationMs, message, isError, isTransportCall) => {
        // Always use the CURRENT time as the log timestamp so every entry
        // shows when the API call actually completed (i.e. when Instagram
        // was last contacted), not when the enclosing function was entered.
        // The previous formula (Date.now() - durationMs) produced pre-throttle
        // timestamps for timed() entries, making paired operations appear to
        // fire simultaneously in the API call log even when the full
        // inter-action delay had been respected.
        //
        // isTransportCall=true  → real HTTP hit (FriendshipsCreate, MediaLike, etc.) → transport "ja3"
        // isTransportCall=false → high-level operation wrapper (FollowedUser, LikeMedia, etc.) → transport "Equinox"
        storage.createInstagramApiCall({
          profileId: profile.id,
          username: profile.username,
          operationName: op,
          date: new Date().toISOString(),
          message: message ?? "",
          source: state.client!.apiCallSource,
          durationMs,
          isError: isError ?? false,
          transport: isTransportCall ? "ja3" : "Aura Farming",
        }).catch(() => {});
      });
    }

    // Always sync apiLimits from the profile (user may have changed them).
    // Use updateApiLimits (not setApiLimits) so fatigue/momentum session state is
    // preserved when limits are refreshed mid-lifecycle on an already-running client.
    const limits = profile.apiLimits as any;
    if (limits && typeof limits === "object") {
      const rMin = Number(limits.requestsMin   ?? 1);
      const rMax = Number(limits.requestsMax   ?? 1);
      const sMin = Number(limits.everySecondsMin ?? 1000);
      const sMax = Number(limits.everySecondsMax ?? 30000);
      state.client.updateApiLimits({ ...limits, requestsMin: rMin, requestsMax: rMax, everySecondsMin: sMin, everySecondsMax: sMax });
      // Log so slow-call issues are immediately diagnosable from the server log
      const toSec = (v: number) => (v < 1000 ? v : Math.round(v / 100) / 10);
      const delayMin = Math.round((toSec(sMin) / Math.max(1, rMax)) * 10) / 10;
      const delayMax = Math.round((toSec(sMax) / Math.max(1, rMin)) * 10) / 10;
      console.log(`[engine] @${profile.username}: API Control — ${rMin}–${rMax} req / ${toSec(sMin)}–${toSec(sMax)}s window → delay ${delayMin}–${delayMax}s per call`);
    }

    // Always sync the EB browser UA so webPost uses the same UA that created
    // the cookies — a UA mismatch causes Instagram to 302-redirect to login.
    if (profile.userAgentEmbedded) {
      state.client.setWebUserAgent(profile.userAgentEmbedded);
    }

    // Sync device state and stored API cookies. setDeviceInfo now eagerly calls
    // _restoreMobileFromApiCookies, so if the account was previously verified
    // isMobileLoggedIn() will return true immediately below — no web login needed.
    state.client.setDeviceInfo(profile.igDeviceState, getSessionUserAgentApi(profile.id) ?? profile.userAgentApi, profile.igApiCookies);
    state.client.onDeviceStateUpdate = (s) => { storage.updateProfile(profile.id, { igDeviceState: s }).catch(() => {}); };

    const client = state.client;

    // API-FIRST: if a verified mobile session exists (igApiCookies from Verify
    // Credentials), use it directly.  All automation tools run via the mobile API —
    // they do NOT require the EB to be showing any particular page.  The EB is only
    // used for general browsing, challenge-fixing, and cookie harvesting.
    // loadBrowserCookies() is still called for freshness, but its return value does
    // NOT gate whether we proceed — only the mobile session matters here.
    if (client.isMobileLoggedIn()) {
      console.log(`[engine] @${profile.username}: resuming mobile API session from stored cookies`);
      // Sync EB cookies non-destructively so the web cookieJar stays fresh, but
      // never let EB state (cookie banner, ads prompt, etc.) block tool execution.
      client.loadBrowserCookies();
      return client;
    }

    // No verified mobile session yet.  Try to seed one from the EB cookie file.
    // This path is taken for accounts that have an EB session but have not yet
    // been through Verify Credentials (no igApiCookies in DB).
    const browserOk = client.loadBrowserCookies();
    if (browserOk) {
      console.log(`[engine] @${profile.username}: no verified session — attempting EB cookie bootstrap`);
      const mobileBootOk = client.mobileBootstrapFromWebCookies();
      if (mobileBootOk) {
        console.log(`[engine] @${profile.username}: mobile session seeded from EB cookies (Watch Stories/Reels may be skipped until Verify Credentials is run)`);
      } else {
        console.warn(`[engine] @${profile.username}: EB cookie file has no sessionid — mobile-API tools skipped this session. Re-verify the account via the Verify button.`);
      }
      return client;
    }

    // No verified mobile session AND no EB cookie file with a sessionid.
    // Do NOT attempt a cold mobile login — the account must be verified via the
    // embedded browser first (Verify Credentials button).
    console.warn(`[engine] @${profile.username}: no mobile session and no EB session — skipping run (verify the account in the browser first)`);
    return null;
  }

  // ── Session cookie persistence ────────────────────────────────────────────
  // Called after every follow / unfollow / DM / contact cycle.
  //
  // Why this is needed (the Jarvee parity problem):
  //   mobileSessionPost() already merges Instagram's Set-Cookie response headers
  //   into mobileCookieJar on every API call, so the IN-MEMORY jar is always
  //   fresh.  BUT ensureClient() calls setDeviceInfo(profile.igApiCookies) at the
  //   start of every cycle, which reloads the DB copy and clobbers the fresh
  //   in-memory state.  The DB copy is only written by Verify Credentials — never
  //   by normal automation.  So after the first verify, the stored sessionid ages
  //   until Instagram invalidates it server-side, even though every live session
  //   actually refreshed it.  Jarvee serialised and saved cookies after every
  //   cycle; this method does the same.
  private async persistSessionCookies(state: ProfileState, profileId: number, username: string): Promise<void> {
    const client = state.client;
    if (!client) return;
    const fresh = client.getSerializedIgApiCookies();
    if (!fresh) return;
    try {
      await storage.updateProfile(profileId, { igApiCookies: fresh });
      const snip = fresh.split(";").find(s => s.trim().startsWith("sessionid="))?.split("=")[1]?.slice(0, 8) ?? "?";
      console.log(`[engine] @${username}: session cookies refreshed in DB (sessionid=...${snip})`);
    } catch (e: any) {
      console.warn(`[engine] @${username}: failed to persist session cookies: ${e?.message}`);
    }
  }

  // ── Session action logger ─────────────────────────────────────────────────
  private logAction(profileId: number, toolId: number, action: string, targetUsername: string, sourceValue: string, sourceType: string, result: string, detail: string = "") {
    storage.createSessionAction({
      profileId, toolId, action, targetUsername,
      sourceValue, sourceType, result, detail,
      timestamp: new Date().toISOString(),
    }).catch(() => {});
  }

  // Waits for at least one element matching `selector` to appear on the page.
  // SPA content loads asynchronously; without this, browser actions that fire
  // immediately after navigation frequently find nothing and silently no-op.
  private async waitForSelector(page: any, selector: string, timeoutMs = 8000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found: boolean = await page.evaluate((sel: string) => !!document.querySelector(sel), selector).catch(() => false);
      if (found) return true;
      await sleep(400);
    }
    return false;
  }

  // ── Ghost Browser (EB) API-call-log mirror ──────────────────────────────────
  // When Disable API is active, actions are performed via the embedded browser
  // (Ghost Browser) instead of the mobile API, so no real InstagramWebClient
  // call fires and nothing would otherwise land in the API Calls log / CSV
  // export. This mirrors every browser-driven action into the same
  // instagram_api_calls table used by real API calls, stamped with
  // transport="Ghost Browser" so it shows up in the Transport column of the
  // Accounts Manager → Actions / Export API Calls views exactly like a real
  // API call row, just with a different transport label.
  private logGhostBrowserCall(profileId: number, username: string, operationName: string, message: string, isError = false) {
    storage.createInstagramApiCall({
      profileId,
      username,
      operationName,
      date: new Date().toISOString(),
      message: message ?? "",
      source: "Ghost Browser",
      durationMs: 0,
      isError,
      transport: "Ghost Browser",
    }).catch(() => {});
  }

  // ── Action block / suspension helpers ────────────────────────────────────

  // Returns true if the given action is currently suspended due to a block.
  private isActionSuspended(state: ProfileState, key: string): boolean {
    const s = state.actionSuspensions[key];
    return !!s && Date.now() < s.until;
  }

  // Returns human-readable time remaining for a suspension (e.g. "23h 41m").
  private suspensionRemaining(state: ProfileState, key: string): string {
    const s = state.actionSuspensions[key];
    if (!s) return "";
    const ms = Math.max(0, s.until - Date.now());
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return `${h}h ${m}m`;
  }

  // Called when a legitimate Instagram block is received for a given action.
  // First block  → 24-hour suspension.
  // Second block → 50-hour suspension (escalated, logged prominently).
  // Subsequent   → 50-hour suspension reset from now each time.
  // Only "legitimate" blocks (Instagram explicitly blocked the action) should
  // trigger this; session/CSRF failures (302) should NOT.
  private recordActionBlock(
    state: ProfileState,
    profileId: number,
    toolId: number,
    actionKey: string,   // e.g. "follow" | "like" | "viewStories"
    displayName: string, // human-readable label for logging
    targetUsername: string,
    sourceValue: string,
    sourceType: string,
  ): void {
    const now = Date.now();
    const existing = state.actionSuspensions[actionKey];

    let newCount: number;
    let suspendMs: number;
    let isEscalated: boolean;

    if (!existing || existing.blockCount === 0) {
      // First block ever (or no prior record)
      newCount = 1;
      suspendMs = 24 * 3_600_000; // 24 hours
      isEscalated = false;
    } else {
      // Second (or further) block
      newCount = existing.blockCount + 1;
      suspendMs = 50 * 3_600_000; // 50 hours
      isEscalated = true;
    }

    const until = now + suspendMs;
    state.actionSuspensions[actionKey] = { until, blockCount: newCount, lastBlockAt: now };

    const untilStr = new Date(until).toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const hours = suspendMs / 3_600_000;
    const suspensionAction = `${actionKey}_suspension`; // e.g. "follow_suspension" → dashboard shows "Follow ⊘"

    if (isEscalated) {
      const msg = `⚠️ ESCALATED BLOCK — ${displayName} suspended for ${hours}h (block #${newCount}). Suspended until ${untilStr}`;
      console.warn(`[engine] @profile${profileId}: ${msg}`);
      this.logAction(profileId, toolId, suspensionAction, targetUsername, sourceValue, sourceType, "suspended", msg);
    } else {
      const msg = `${displayName} blocked — suspension applied. Suspended until ${untilStr}`;
      console.warn(`[engine] @profile${profileId}: ${msg}`);
      this.logAction(profileId, toolId, suspensionAction, targetUsername, sourceValue, sourceType, "suspended", msg);
    }
  }

  // ── Spintax resolver: {A|B|C} → picks one branch randomly ────────────────
  private applySpintax(text: string): string {
    return text.replace(/\{([^}]+)\}/g, (_, group) => {
      const parts = group.split("|");
      return parts[Math.floor(Math.random() * parts.length)];
    });
  }

  // ── Unfollow session ──────────────────────────────────────────────────────
  private async runUnfollowSession(profile: Profile, tool: Tool, state: ProfileState): Promise<{ unfollowed: number }> {
    const s = tool.settings as any;

    // Stop-on-block gate
    if (s.stopOnBlockEnabled && s.toolBlockedUntil && Date.now() < s.toolBlockedUntil) {
      const remMs = s.toolBlockedUntil - Date.now();
      const remH = Math.floor(remMs / 3_600_000);
      const remM = Math.floor((remMs % 3_600_000) / 60_000);
      const remStr = remH > 0 ? `${remH}h ${remM}m` : `${remM}m`;
      this.logAction(profile.id, tool.id, "action_suspended", "", "", "", "skipped", `Tool paused: blocked by Instagram. ${remStr} remaining`);
      return { unfollowed: 0 };
    }

    const minAgeDays   = s.minFollowAgeDays  ?? 3;
    const processCount = randInt(s.processMin ?? 5, s.processMax ?? 15);
    const delayMin     = (s.delayAfterUnfollowMin ?? 5)  * 1000;
    const delayMax     = (s.delayAfterUnfollowMax ?? 15) * 1000;
    const maxPerDay    = s.maxPerDayMin ?? 0;

    // Daily cap (0 = no limit)
    if (maxPerDay > 0 && this.daily(state) >= maxPerDay) {
      console.log(`[engine] @${profile.username}: unfollow daily limit (${maxPerDay}) hit — sleeping until midnight`);
      const now = new Date();
      const midnight = new Date(now); midnight.setDate(midnight.getDate() + 1); midnight.setHours(0, 0, 0, 0);
      await sleep(midnight.getTime() - now.getTime());
      return { unfollowed: 0 };
    }

    const client = await this.ensureClient(profile, state);
    if (!client) return { unfollowed: 0 };
    client.setApiCallSource("Unfollow Tool");

    // Fetch followed users older than minAgeDays
    const all = await storage.getFollowedUsersByProfile(profile.id, 100_000);
    const cutoff = Date.now() - minAgeDays * 86_400_000;
    let candidates = all.filter(u => new Date(u.followedAt).getTime() < cutoff);

    // Custom target list — if enabled, only unfollow users in the list
    const targetListEnabled = !!s.unfollowTargetListEnabled;
    const targetListRaw: string = s.unfollowTargetList ?? "";

    // Parse stored pk map — populated when user imports via HikerAPI
    let pksMap: Record<string, string> = {};
    try { pksMap = JSON.parse(s.unfollowTargetListPks ?? "{}"); } catch {}

    if (targetListEnabled && targetListRaw.trim()) {
      const targetUsernames = targetListRaw.split(/[\n,]+/)
        .map((u: string) => u.trim().replace(/^@/, "").toLowerCase())
        .filter(Boolean);
      const targetSet = new Set(targetUsernames);

      // Match from DB (users originally followed by the tool) — carry over their stored userId
      const fromDb = all.filter(u => targetSet.has(u.instagramUsername.toLowerCase()));
      const fromDbNames = new Set(fromDb.map(u => u.instagramUsername.toLowerCase()));

      // Also include list entries NOT in the DB — manually added or imported via HikerAPI
      const synthetic: typeof candidates = targetUsernames
        .filter(username => !fromDbNames.has(username))
        .map(username => ({
          id: -1,
          profileId: profile.id,
          instagramUsername: username,
          instagramUserId: pksMap[username] ?? "",   // use pk from import map if available
          followedAt: new Date(0).toISOString(),
          unfollowedAt: null,
        } as any));

      // Merge: prefer db entry (has userId); for db entries missing userId also check pksMap
      const merged = [
        ...fromDb.map(u => ({
          ...u,
          instagramUserId: u.instagramUserId || pksMap[u.instagramUsername.toLowerCase()] || "",
        })),
        ...synthetic,
      ];

      candidates = merged;
      console.log(`[engine] @${profile.username}: unfollow target list — ${fromDb.length} from DB + ${synthetic.length} manual = ${candidates.length} total`);
    } else {
      console.log(`[engine] @${profile.username}: unfollow candidates: ${candidates.length} (older than ${minAgeDays}d)`);
    }

    // Resolve HikerAPI client once (used only when pk is missing — never use Instagram session for lookup)
    const globalSettings = await storage.getGlobalSettings();
    let hikerClientForLookup: import("./hikerApiClient").HikerApiClient | null = null;
    if (globalSettings.hikerApiEnabled === "true" && globalSettings.hikerApiToken && globalSettings.hikerUnfollowByUsername !== "false") {
      const { HikerApiClient } = await import("./hikerApiClient");
      hikerClientForLookup = new HikerApiClient(globalSettings.hikerApiToken);
    }

    let attempted = 0; // counts every actual unfollow API call (respects processCount limit)
    let unfollowed = 0; // counts only confirmed successes (for stats)
    for (const fu of candidates) {
      if (attempted >= processCount || state.stop.stopped) break;
      if (maxPerDay > 0 && this.daily(state) >= maxPerDay) break;

      try {
        // Use stored pk directly — NEVER call Instagram searchUserByUsername
        let userId = fu.instagramUserId ?? "";
        if (!userId) {
          if (hikerClientForLookup) {
            const found = await hikerClientForLookup.getUserByUsername(fu.instagramUsername);
            if (found?.pk) userId = found.pk;
          }
          if (!userId) {
            console.log(`[engine] @${profile.username}: unfollow @${fu.instagramUsername} — no pk available, skipping`);
            continue; // genuine skip — don't count toward limit
          }
        }
        // Count the attempt now — whether it succeeds or fails silently, it still
        // counts toward the session limit so we never process more users than configured.
        attempted++;
        const result = await client.unfollowUser(userId, fu.instagramUsername);
        if (result === "blocked") {
          // Unfollow "blocked" is always a feedback_required / ABD-type warning from Instagram —
          // it is NOT a real "Action Blocked" prompt. Do not trigger Stop Tool if Blocked here.
          this.logAction(profile.id, tool.id, "unfollow_blocked", fu.instagramUsername, "", "", "skipped", "Instagram automated-behaviour warning: breaking unfollow session");
          break;
        }
        if (result) {
          this.bump(state);
          unfollowed++;
          console.log(`[engine] @${profile.username}: ✓ unfollowed @${fu.instagramUsername} [${attempted}/${processCount}]`);
          this.logAction(profile.id, tool.id, "unfollow", fu.instagramUsername, "", "", "ok", `Unfollowed [${attempted}/${processCount}]`);
          await storage.incrementStat(profile.id, "unfollow");

          // Remove from target list so it won't be attempted again next session
          if (targetListEnabled) {
            const lower = fu.instagramUsername.toLowerCase();
            const updatedList = (s.unfollowTargetList ?? "")
              .split(/[\n,]+/)
              .map((u: string) => u.trim().replace(/^@/, ""))
              .filter((u: string) => u && u.toLowerCase() !== lower)
              .join("\n");
            delete pksMap[lower];
            s.unfollowTargetList = updatedList;
            s.unfollowTargetListPks = JSON.stringify(pksMap);
            await storage.updateTool(tool.id, { settings: { ...s } });
          }

        }
        // Always sleep between attempts — whether the call succeeded or failed silently —
        // to avoid hammering Instagram with rapid-fire requests.
        if (attempted < processCount && !state.stop.stopped) {
          await sleep(randInt(delayMin, delayMax));
        }
      } catch (e: any) {
        const msg = igErrMsg(e);
        const acctStatus = await this.applyAccountLevelError(profile.id, e?.message ?? "", state, tool.id);
        if (acctStatus) {
          console.warn(`[engine] @${profile.username}: unfollow threw account-level error (${acctStatus}) — ${msg}`);
          this.logAction(profile.id, tool.id, "unfollow_blocked", fu.instagramUsername, "", "", "error", `[${acctStatus}] ${msg}`);
          break;
        }
        console.warn(`[engine] unfollow @${fu.instagramUsername} error: ${msg}`);
        this.logAction(profile.id, tool.id, "unfollow", fu.instagramUsername, "", "", "error", msg);
      }
    }

    return { unfollowed };
  }

  // ── DM session ────────────────────────────────────────────────────────────
  private async runDMSession(profile: Profile, tool: Tool, state: ProfileState): Promise<{ sent: number }> {
    const s = tool.settings as any;
    const processCount = randInt(s.processMin ?? 3, s.processMax ?? 8);
    const delayMin     = (s.delayAfterDMMin ?? 10) * 1000;
    const delayMax     = (s.delayAfterDMMax ?? 30) * 1000;
    const maxPerDay    = s.maxPerDayMin ?? 0;
    const templates: string[] = (s.dmMessages ?? "").split("\n").map((t: string) => t.trim()).filter(Boolean);
    if (!templates.length) {
      console.log(`[engine] @${profile.username}: no DM templates configured — skipping session`);
      return { sent: 0 };
    }

    if (maxPerDay > 0 && this.daily(state) >= maxPerDay) {
      const now = new Date();
      const midnight = new Date(now); midnight.setDate(midnight.getDate() + 1); midnight.setHours(0, 0, 0, 0);
      await sleep(midnight.getTime() - now.getTime());
      return { sent: 0 };
    }

    const client = await this.ensureClient(profile, state);
    if (!client) return { sent: 0 };

    const sources = await storage.getSourcesByTool(tool.id);
    if (!sources.length) {
      console.log(`[engine] @${profile.username}: no DM sources configured`);
      return { sent: 0 };
    }
    const source = this.pickSource(sources);

    const globalSettings = await storage.getGlobalSettings();
    const hikerEnabled = globalSettings.hikerApiEnabled === "true";
    const hikerToken   = globalSettings.hikerApiToken ?? "";
    const hikerClient: HikerApiClient | null = (hikerEnabled && hikerToken) ? new HikerApiClient(hikerToken) : null;
    const useHikerDmByUsername       = !!(hikerClient && globalSettings.hikerDmByUsername !== "false");
    const useHikerDmGetFollowers     = !!(hikerClient && globalSettings.hikerDmGetFollowers !== "false");
    const useHikerHumanSessionFeed   = !!(hikerClient && globalSettings.hikerHumanSessionFeed !== "false");

    const logHikerDM = (op: string, message: string, durationMs: number) => {
      storage.createInstagramApiCall({
        profileId: profile.id,
        username: profile.username,
        operationName: op,
        date: new Date().toISOString(),
        message,
        source: "HikerAPI",
        durationMs,
      }).catch(() => {});
    };

    // Use cached targetUserId; resolve once (prefer HikerAPI) and cache
    let candidates: { pk: string; username: string; fullName: string }[] = [];
    let targetUserId = source.targetUserId ?? "";
    if (!targetUserId) {
      let resolved: { pk: string; username: string } | null = null;
      if (useHikerDmByUsername) {
        const t0 = Date.now();
        resolved = await hikerClient!.getUserByUsername(source.value.replace(/^@/, ""));
        logHikerDM("GetUserByUsername", `Resolved @${source.value.replace(/^@/, "")} via HikerAPI (cached)`, Date.now() - t0);
      } else {
        resolved = await client.searchUserByUsername(source.value.replace(/^@/, ""));
      }
      if (resolved) {
        targetUserId = resolved.pk;
        await storage.updateSourceTargetUserId(source.id, targetUserId);
      }
    }
    if (targetUserId) {
      if (useHikerDmGetFollowers) {
        const t0 = Date.now();
        try {
          candidates = await hikerClient!.getFollowers(targetUserId, processCount * 3);
          logHikerDM("FollowersScrape", `Scraped followers of @${source.value} via HikerAPI (${candidates.length} users)`, Date.now() - t0);
        } catch (err: any) {
          if (err instanceof HikerCacheMissError) {
            console.log(`[engine] @${profile.username}: HikerAPI followers cache miss for DM tool — skipping source @${source.value}`);
          } else { throw err; }
        }
      } else {
        candidates = await client.getFollowers(targetUserId, processCount * 3);
      }
    }

    let sent = 0;
    for (const user of candidates) {
      if (sent >= processCount || state.stop.stopped) break;
      if (maxPerDay > 0 && this.daily(state) >= maxPerDay) break;

      try {
        const raw = templates[Math.floor(Math.random() * templates.length)];
        // Replace [FIRSTNAME] before spintax so it works inside spin groups too.
        // fullName comes free from the followers/hashtag scrape — no extra API call.
        const firstName = String(user.fullName ?? "").trim().split(/\s+/)[0] || user.username;
        const withTokens = raw.replace(/\[FIRSTNAME\]/gi, firstName);
        const text = this.applySpintax(withTokens);
        const result = await client.sendDirectMessage(user.pk, text, user.username);
        if (result === "blocked") {
          // Jarvee ABD dismiss — try before logging a hard block
          await storage.updateProfile(profile.id, { accountStatus: "automated_behaviour_detected" });
          const abdOk = await client.tryDismissABD();
          if (abdOk) {
            await storage.updateProfile(profile.id, { accountStatus: "valid" });
            await storage.incrementStat(profile.id, "abd");
            console.log(`[engine] @${profile.username}: DM ABD auto-dismissed ✓ — continuing session`);
            this.logAction(profile.id, tool.id, "abd_dismissed", user.username, source.value, source.type, "ok", "Automated Behavior warning auto-dismissed");
            await sleep(5000);
            continue;
          }
          await storage.updateProfile(profile.id, { accountStatus: "valid" });
          this.logAction(profile.id, tool.id, "dm_blocked", user.username, source.value, source.type, "skipped", "Instagram action-blocked DM");
          break;
        }
        if (result) {
          this.bump(state);
          sent++;
          console.log(`[engine] @${profile.username}: ✉ DM sent to @${user.username} [${sent}/${processCount}]`);
          this.logAction(profile.id, tool.id, "dm", user.username, source.value, source.type, "ok", `DM sent [${sent}/${processCount}]: "${text.slice(0, 50)}"`);
          await storage.incrementStat(profile.id, "dm");
          await sleep(randInt(delayMin, delayMax));
        }
      } catch (e: any) {
        const msg = igErrMsg(e);
        const acctStatus = await this.applyAccountLevelError(profile.id, e?.message ?? "", state, tool.id);
        if (acctStatus) {
          console.warn(`[engine] @${profile.username}: DM threw account-level error (${acctStatus}) — ${msg}`);
          this.logAction(profile.id, tool.id, "dm_blocked", user.username, source.value, source.type, "error", `[${acctStatus}] ${msg}`);
          break;
        }
        console.warn(`[engine] DM @${user.username} error: ${msg}`);
        this.logAction(profile.id, tool.id, "dm", user.username, source.value, source.type, "error", msg);
      }
    }

    return { sent };
  }

  // ── Daily / hourly counters ───────────────────────────────────────────────
  private daily(state: ProfileState): number {
    if (state.dailyDate !== todayStr()) { state.dailyCount = 0; state.dailyDate = todayStr(); }
    return state.dailyCount;
  }
  private hourly(state: ProfileState): number {
    if (state.hourlyHour !== hourStr()) { state.hourlyCount = 0; state.hourlyHour = hourStr(); }
    return state.hourlyCount;
  }
  private bump(state: ProfileState) {
    this.daily(state); this.hourly(state);
    state.dailyCount++; state.hourlyCount++;
  }

  // ── Indian script detector ────────────────────────────────────────────────
  // Covers Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu,
  // Kannada, Malayalam — all major South Asian Indic scripts.
  private hasIndianScript(text: string): boolean {
    return /[\u0900-\u0D7F]/.test(text);
  }

  // ── Human session tools (separate timer from follow) ─────────────────────
  // Returns true when an action should be SKIPPED this session.
  // notUsedMin/Max (0–100) are the % chance the action is not used.
  // Default 0/0 = always run. E.g. min=30,max=50 → 30–50% skip chance.
  private getAccountLevelStatus(errMsg: string): "captcha" | "logged_out" | "banned" | "suspended" | "compromised" | "phone_verification" | "email_confirmation" | null {
    const m = errMsg ?? "";
    if (/checkpoint_required|challenge_required|checkpoint required/i.test(m))               return "captcha";
    if (/login_required|not authorized|session expired|logged out|not logged in/i.test(m))   return "logged_out";
    if (/account.*disabled|disabled.*account|account_disabled|your account has been disabled/i.test(m)) return "banned";
    if (/account.*suspended|suspended.*account|we.ve suspended/i.test(m))                    return "suspended";
    if (/compromised/i.test(m))                                                              return "compromised";
    if (/phone.*verif|verify.*phone|phone_required|confirm.*phone|enter.*phone/i.test(m))    return "phone_verification";
    if (/email.*confirm|confirm.*email|email.*verif|verify.*email/i.test(m))                 return "email_confirmation";
    return null;
  }

  private async applyAccountLevelError(profileId: number, rawError: string, state?: ProfileState, toolId?: number): Promise<string | null> {
    const status = this.getAccountLevelStatus(rawError);
    if (!status) return null;
    // Debug-log every account-level error so the exact triggering message is visible
    console.error(`[engine] applyAccountLevelError profileId=${profileId} status=${status} raw=${rawError.slice(0, 400)}`);
    if (status === "banned" || status === "suspended") {
      await triggerBanPipeline(profileId, "auto-detect").catch((e: any) =>
        console.error(`[engine] triggerBanPipeline failed for profile ${profileId}: ${e?.message}`)
      );
      await storage.incrementStat(profileId, "banned").catch(() => {});
    } else {
      await storage.updateProfile(profileId, { accountStatus: status, statusMessage: rawError.slice(0, 500) });
    }
    if (status === "captcha") {
      await storage.incrementStat(profileId, "captcha").catch(() => {});
    }
    if (state && status === "logged_out") state.client = null;
    if (status === "logged_out" && toolId !== undefined) {
      this.logAction(profileId, toolId, "logged_out", "", "", "", "error", rawError.slice(0, 300));
    }
    return status;
  }

  private shouldSkipDueToChance(s: any, minKey: string, maxKey: string): boolean {
    const min = Number(s[minKey] ?? 0);
    const max = Number(s[maxKey] ?? 0);
    if (min <= 0 && max <= 0) return false;
    const skipChance = randInt(min, max);
    return Math.random() * 100 < skipChance;
  }

  // Browser-only human session used when Disable API is on.
  // Navigates the EB to Instagram pages to simulate human presence without any mobile API call.
  private async runBrowserOnlyHumanSession(profile: Profile, tool: Tool, state: ProfileState): Promise<void> {
    const ebIpcPort = process.env.EB_IPC_PORT;
    let page: any;
    // Track whether WE opened the window so we can destroy it when done.
    // If the user already had it open we must NOT destroy it — they still want it.
    let _weOpenedEb = false;
    if (ebIpcPort) {
      // Electron desktop app — drive the REAL EB via the ebManager.ts IPC bridge.
      // Opens an off-screen silentMode window if one isn't already open for this
      // account.  The window is destroyed via closeSilentEb() in the finally block
      // below — with 1,000+ profiles we only keep a handful of windows alive at
      // any given moment (one per concurrently running session), not one per profile.
      const { ok, weOpenedIt } = await this.ensureSilentEbOpen(profile);
      if (!ok) {
        console.log(`[engine] @${profile.username}: [EB-only] could not open silent EB — skipping browser human session`);
        this.logAction(profile.id, tool.id, "session_skipped", "", "", "", "warn", "Disable API: silent EB open failed, no browser human session run");
        return;
      }
      _weOpenedEb = weOpenedIt;
      page = new EbIpcPage(profile.id, ebIpcPort);
    } else {
      // Dev / Replit (no Electron process) — fall back to the standalone
      // Puppeteer session, if one happens to be open.
      const browser = getExistingBrowser(profile.id);
      if (!browser) {
        console.log(`[engine] @${profile.username}: [EB-only] EB not open — skipping browser human session`);
        this.logAction(profile.id, tool.id, "session_skipped", "", "", "", "warn", "Disable API: EB not open, no browser human session run");
        return;
      }
      const pages: any[] = await browser.pages();
      page = pages[0];
      if (!page) {
        console.log(`[engine] @${profile.username}: [EB-only] no EB page found`);
        return;
      }
    }
    const s = tool.settings as any;
    const limits = (profile.apiLimits ?? {}) as any;

    // Timing derived from apiLimits — same formula as the API throttle:
    //   delay per action = window / requests
    // Values <1000 are treated as seconds; >=1000 as ms (matches UI toMs convention).
    const toMs = (v: number) => (v < 1000 ? v * 1000 : v);
    const winMin = toMs(Number(limits.everySecondsMin ?? 8));
    const winMax = toMs(Number(limits.everySecondsMax ?? 20));
    const rMin   = Math.max(1, Number(limits.requestsMin ?? 1));
    const rMax   = Math.max(rMin, Number(limits.requestsMax ?? 1));
    const actionDelay = () => randInt(
      Math.max(1000, Math.round(winMin / rMax)),
      Math.max(2000, Math.round(winMax / rMin)),
    );

    try {
      const nav = async (url: string, label: string) => {
        console.log(`[engine] @${profile.username}: 🌐 [EB-only] → ${label}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      };

      // Waits for at least one element matching `selector` to appear.
      // SPA content loads async; without this, actions that fire immediately
      // after navigation frequently find nothing and silently no-op.
      const waitFor = async (selector: string, timeoutMs = 8000): Promise<boolean> => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const found: boolean = await page.evaluate((sel: string) => !!document.querySelector(sel), selector).catch(() => false);
          if (found) return true;
          await sleep(400);
        }
        return false;
      };

      // ── Execution-order queue — mirrors the non-EB (API) path's queue pattern ─────
      // Each action is pushed with a random order score derived from its OrderMin/Max
      // settings. After all enqueues, sort descending (higher order = runs first) and
      // execute sequentially. saveTimelinePosts / shareTimelinePosts / explorePage are
      // NOT queued — they depend on feedCount / feedHadPosts set by viewTimelineFeed
      // and must always run after the queue finishes.
      type EbQueueEntry = { key: string; run: () => Promise<void>; order: number };
      const ebQueue: EbQueueEntry[] = [];
      const ebEnqueue = (key: string, orderMinKey: string, orderMaxKey: string, fn: () => Promise<void>) => {
        const order = randInt(Number(s[orderMinKey] ?? 0), Number(s[orderMaxKey] ?? 0));
        ebQueue.push({ key, run: fn, order });
      };

      // ── Human Jitter — home + own profile audit (respects skip chance) ──────
      // Uses the same humanSessionNotUsedMin/Max skip chance as the full jitter
      // enqueue block below. If the skip roll fires, neither the audit nav nor
      // any of the subsequent jitter actions (notifs, settings, activity, saved) run.
      // DEBUG: log the actual stored skip-chance values so we can confirm the
      // settings are reaching the engine correctly.
      console.log(`[engine] @${profile.username}: [EB-only] Human Jitter skip settings — humanSessionNotUsedMin=${JSON.stringify(s.humanSessionNotUsedMin)}, humanSessionNotUsedMax=${JSON.stringify(s.humanSessionNotUsedMax)}`);
      const _jitterSkipped = this.shouldSkipDueToChance(s, "humanSessionNotUsedMin", "humanSessionNotUsedMax");
      console.log(`[engine] @${profile.username}: [EB-only] Human Jitter _jitterSkipped=${_jitterSkipped}`);
      ebEnqueue("humanJitter", "humanSessionOrderMin", "humanSessionOrderMax", async () => {
      if (s.humanSessionEnabled === true && (s as any).emulationGroupEnabled !== false && !_jitterSkipped) {
        try {
          await nav("https://www.instagram.com/", "home (jitter)");
          await sleep(actionDelay());
          await nav(`https://www.instagram.com/${profile.username}/`, "own profile (jitter)");
          await sleep(actionDelay());
          this.logAction(profile.id, tool.id, "eb_browse", "", "", "", "ok", "EB: Human Jitter");
          this.logGhostBrowserCall(profile.id, profile.username, "human_session_audit", "EB: Human Jitter");
        } catch (e: any) {
          console.warn(`[engine] @${profile.username}: [EB-only] humanSession jitter error: ${e?.message}`);
          this.logGhostBrowserCall(profile.id, profile.username, "human_session_audit", e?.message ?? "error", true);
        }
      } else if (_jitterSkipped) {
        console.log(`[engine] @${profile.username}: [EB-only] Human Jitter skipped (chance roll)`);
      }
      });

      // Tracks whether the home feed actually served posts this session.
      // Defaults to true so the Explore page is NOT visited when viewTimelineFeed
      // is disabled (i.e. we never checked the feed, so we can't say it was empty).
      let feedHadPosts = true;
      // _ebSuggestionsPageDetected: set true inside viewTimelineFeed when the
      // home feed shows "Suggested for you" cards instead of real posts.
      // Guards the post-scroll re-check so it can't wrongly restore feedHadPosts=true
      // from suggestion card <article> elements (which have no <time> child).
      let _ebSuggestionsPageDetected = false;
      // Hoisted so the saveTimelinePosts block below (a sibling, not nested,
      // block) can compute an expectation-based save count from the number of
      // posts actually scrolled this session, instead of guessing.
      let feedCount = 0;

      // ── viewTimelineFeed — navigate to home, scroll through posts ─────────
      ebEnqueue("viewTimelineFeed", "viewTimelineFeedOrderMin", "viewTimelineFeedOrderMax", async () => {
      if (s.viewTimelineFeedEnabled === true && (s as any).emulationGroupEnabled !== false) {
        try {
          feedCount = randInt(Number(s.viewTimelineFeedMin ?? 3), Number(s.viewTimelineFeedMax ?? 8));
          if (page.url() !== "https://www.instagram.com/" && !page.url().startsWith("https://www.instagram.com/?")) {
            await nav("https://www.instagram.com/", "home feed");
            await sleep(actionDelay());
          }
          // Force visibilityState=visible so Instagram's SPA loads feed content
          // even when the EB window is hidden/not shown to the user. Without this,
          // Chrome reports visibilityState="hidden" → Instagram suppresses lazy-loading
          // → waitFor('article') times out → feedHadPosts=false → Explore page fires
          // even though the feed has posts.
          await page.evaluate(() => {
            try { Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true }); } catch {}
            try { Object.defineProperty(document, 'hidden', { get: () => false, configurable: true }); } catch {}
            document.dispatchEvent(new Event('visibilitychange'));
          }).catch(() => {});
          // Wait for SPA content and detect whether the feed has any posts.
          // Try a broad set of selectors — Instagram uses <article> for feed posts
          // but occasionally changes class/structure. 20s gives React more time to
          // hydrate; most sessions see content in <5s.
          // 'div[data-media-id]' is a common Instagram post card wrapper.
          // 'main [class] img[src]' catches any image in the main content area.
          const _feedSelector = 'article, div[data-media-id]';
          feedHadPosts = await waitFor(_feedSelector, 20000);
          if (!feedHadPosts) {
            // Debug: dump a quick DOM snapshot so we know what's on the page
            const _feedDebug = await page.evaluate(() => {
              const t = document.title;
              const url = location.href;
              const articles = document.querySelectorAll('article').length;
              const mainImgs = document.querySelectorAll('main img, [role="main"] img').length;
              const allImgs = document.querySelectorAll('img').length;
              return `title="${t}" url="${url.slice(0,100)}" articles=${articles} main-imgs=${mainImgs} all-imgs=${allImgs}`;
            }).catch(() => "evaluate failed");
            console.log(`[engine] @${profile.username}: [EB-only] 📰 feed waitFor timed out — DOM: ${_feedDebug}`);

            // The feed can legitimately fail to load because Instagram redirected
            // to a challenge/checkpoint page (captcha, phone verification, account
            // disabled, etc). Detect this via the same classifier used elsewhere
            // in the EB (classifyEbChallengeUrl) so the account status pill always
            // reflects reality, and abort the rest of this session immediately
            // instead of burning 20+ seconds on further futile waits.
            const _challengeUrl = await page.evaluate(() => location.href).catch(() => "");
            const _challengeStatus = classifyEbChallengeUrl(_challengeUrl);
            if (_challengeStatus) {
              console.warn(`[engine] @${profile.username}: [EB-only] 🚧 challenge page detected during feed load (${_challengeStatus}) — url: ${_challengeUrl.slice(0, 120)}`);
              await storage.updateProfile(profile.id, {
                accountStatus: _challengeStatus as any,
                statusMessage: "Challenge/security check detected while loading home feed — complete in embedded browser",
              }).catch(() => {});
              const challengeErr: any = new Error(`Challenge page detected (${_challengeStatus})`);
              challengeErr.__ebChallenge = true;
              challengeErr.__ebChallengeStatus = _challengeStatus;
              throw challengeErr;
            }
          }

          // ── Suggestions-page detection ────────────────────────────────────────
          // When the account follows no one, Instagram shows "Suggested for you"
          // cards inside <article> elements — but those articles never contain a
          // <time> element (real feed posts always do). waitFor('article') returns
          // true even on the suggestions page, so we do a second check here and
          // treat the page as empty (feedHadPosts=false) when we detect it.
          if (feedHadPosts) {
            const _isSuggestionsPage: boolean = await page.evaluate(() => {
              // Structural check (primary): real feed posts always have a <time>
              // element (post timestamp); suggestion cards never do. A MIXED feed
              // (real posts + a "Suggested for you" section) will have at least
              // one article WITH <time>, so this check won't false-positive there —
              // it only fires when ALL articles lack a timestamp.
              const articles = Array.from(document.querySelectorAll('article'));
              if (articles.length === 0) return false;
              if (!articles.every(a => !a.querySelector('time'))) return false;
              // Corroborate with a heading check (exact leaf-text match) so we
              // don't misclassify unusual non-feed pages that happen to lack timestamps.
              const els = Array.from(document.querySelectorAll('span, div, h1, h2, h3'));
              return els.some(el => el.children.length === 0 && (el.textContent ?? '').trim().toLowerCase() === 'suggested for you');
            }).catch(() => false);
            if (_isSuggestionsPage) {
              console.log(`[engine] @${profile.username}: [EB-only] 📰 "Suggested for you" page detected — treating feed as empty (0 real posts)`);
              feedHadPosts = false;
              _ebSuggestionsPageDetected = true;
            }
          }

          // ── Expand Caption% + Like% — resolved ONCE here, then applied INLINE
          // during the single forward scroll pass below. Previously each
          // sub-setting ran as its OWN separate loop that reset scrollTo(0, 0)
          // and re-walked the whole feed from the top — this looked like the
          // homepage "refreshing" mid-session, which is not how a real user
          // scrolls. A real user likes/expands captions on posts as they pass
          // by, never jumping back to the top. Posts are marked with
          // data-eb-caption-done / data-eb-liked attributes so the same post
          // is never double-processed as we scroll forward.
          const ecPctRaw0 = Math.min(100, Math.max(0, Number((s as any).expandCaptionPercentMin ?? 0)));
          const ecPctRaw1 = Math.min(100, Math.max(0, Number((s as any).expandCaptionPercentMax ?? 0)));
          const ecPctMin = Math.min(ecPctRaw0, ecPctRaw1);
          const ecPctMax = Math.max(ecPctRaw0, ecPctRaw1);
          const ecPct = ecPctMax > 0 ? ecPctMin + Math.random() * (ecPctMax - ecPctMin) : 0;

          const likePctRaw0 = Math.min(100, Math.max(0, Number(s.likeTimelinePostsPercentMin ?? 0)));
          const likePctRaw1 = Math.min(100, Math.max(0, Number(s.likeTimelinePostsPercentMax ?? 0)));
          const likePctMin = Math.min(likePctRaw0, likePctRaw1);
          const likePctMax = Math.max(likePctRaw0, likePctRaw1);
          const likePct = likePctMax > 0 ? likePctMin + Math.random() * (likePctMax - likePctMin) : 0;
          // Allow genuine zero — small feed + low pct should produce 0 likes.
          const likeCount = likePctMax > 0 ? Math.round(feedCount * likePct / 100) : 0;
          const likeDelayMinMs = Math.max(0, Number(s.likeTimelinePostsDelayMin ?? 3)) * 1000;
          const likeDelayMaxMs = Math.max(likeDelayMinMs, Number(s.likeTimelinePostsDelayMax ?? 8) * 1000);

          let expanded = 0;
          let liked = 0;

          for (let i = 0; i < feedCount && !state.stop.stopped; i++) {
            await page.evaluate(() => window.scrollBy(0, 350 + Math.random() * 250)).catch(() => {});
            await sleep(actionDelay());

            // Inline caption expand — acts on the post currently in/near view,
            // never resets scroll. Marks the post so it's not expanded twice.
            if (ecPctMax > 0 && Math.random() * 100 < ecPct) {
              const clicked: boolean = await page.evaluate(() => {
                const articles = Array.from(document.querySelectorAll('article:not([data-eb-caption-done])'));
                const target = (articles.find(a => {
                  const rect = a.getBoundingClientRect();
                  return rect.bottom > 0 && rect.top < window.innerHeight;
                }) ?? articles[0]) as HTMLElement | undefined;
                if (!target) return false;
                target.setAttribute('data-eb-caption-done', '1');
                // The "more" expand button contains the word "more" — Instagram
                // uses plain ASCII ellipsis "..." or Unicode "…" depending on
                // locale/version, so check for "more" anywhere in the trimmed text.
                const moreBtn = Array.from(target.querySelectorAll(
                  'div[role="button"], span[role="button"], button'
                )).find(el => {
                  const text = (el.textContent ?? '').trim().toLowerCase();
                  return text.endsWith('more') && text.length < 20;
                }) as HTMLElement | null;
                if (!moreBtn) return false;
                moreBtn.click();
                return true;
              }).catch(() => false);
              if (clicked) { expanded++; await sleep(randInt(600, 1200)); }
            }

            // Inline like — likes the post currently being scrolled past, on the
            // fly, in the SAME forward pass. No scrollTo(0,0), no second walk
            // through the feed. Marks the post so it's not liked twice.
            if (likeCount > 0 && liked < likeCount) {
              const likedOne: boolean = await page.evaluate(() => {
                const articles = Array.from(document.querySelectorAll('article'));
                // Find the next un-liked article — NO viewport check here. When the
                // EB window is hidden, getBoundingClientRect() returns zeros so a
                // viewport check would always fail and nothing would get liked.
                // scrollIntoView() works correctly regardless of window visibility,
                // and since already-liked posts are marked, this always resolves
                // to the next post further down the feed — it never jumps back up.
                const target = articles.find(a => !a.hasAttribute('data-eb-liked') && !!a.querySelector('svg[aria-label="Like"]')) as HTMLElement | undefined;
                if (!target) return false;
                target.setAttribute('data-eb-liked', '1');
                target.scrollIntoView({ behavior: 'instant', block: 'center' });
                const heartSvg = target.querySelector('svg[aria-label="Like"]') as SVGElement | null;
                if (!heartSvg) return false;
                // Find the button ancestor — Instagram uses both <button> and
                // [role="button"] wrappers depending on the page variant.
                const btn = heartSvg.closest<HTMLElement>('[role="button"], button');
                if (!btn) return false;
                // Dispatch a full pointer sequence so React's synthetic event
                // system picks it up — plain .click() can be swallowed on
                // elements that listen to pointerdown/up rather than click.
                btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
                btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
                btn.click();
                return true;
              }).catch(() => false);
              if (likedOne) {
                liked++;
                await storage.incrementStat(profile.id, "like").catch(() => {});
                await sleep(likeDelayMinMs + Math.random() * Math.max(0, likeDelayMaxMs - likeDelayMinMs));
              }
            }
          }

          // Defensive re-check: some accounts' feeds load posts slowly (slow
          // network, heavy media) and the initial waitFor(8000) can time out
          // just before content arrives, wrongly marking the feed "empty" and
          // sending the account to the Explore page even though posts exist.
          // Re-check for `article` elements now that we've finished scrolling
          // (which itself gives the SPA more time to render) before trusting
          // a false result.
          // Re-check: skip when suggestions were detected — the page has <article>
          // elements (suggestion cards) that would falsely restore feedHadPosts=true.
          // Tightened selector to `article time` — only real feed posts have a timestamp.
          if (!feedHadPosts && !_ebSuggestionsPageDetected) {
            const recheck: boolean = await page.evaluate(() => !!(document.querySelector('article time') || document.querySelector('div[data-media-id]'))).catch(() => false);
            if (recheck) {
              console.log(`[engine] @${profile.username}: [EB-only] 📰 feed re-check found posts after all — not empty`);
              feedHadPosts = true;
            }
          }
          this.logAction(profile.id, tool.id, "view_timeline_feed", "", "", "", "ok", `EB scrolled feed (${feedCount} scrolls)`);
          this.logGhostBrowserCall(profile.id, profile.username, "view_timeline_feed", `EB scrolled feed (${feedCount} scrolls)`);
          console.log(`[engine] @${profile.username}: [EB-only] 📰 scrolled feed ${feedCount}× — feed had posts: ${feedHadPosts}`);

          if (expanded > 0) {
            this.logAction(profile.id, tool.id, "expand_caption", "", "", "", "ok", `EB expanded caption on ${expanded} post(s) inline while scrolling`);
            this.logGhostBrowserCall(profile.id, profile.username, "expand_caption", `EB expanded caption on ${expanded} post(s) inline while scrolling`);
            console.log(`[engine] @${profile.username}: [EB-only] 📖 expanded ${expanded} caption(s) inline`);
          }

          if (liked > 0) {
            this.logAction(profile.id, tool.id, "like_timeline_post", "", "", "", "ok", `EB liked ${liked} post(s) inline while scrolling`);
            this.logGhostBrowserCall(profile.id, profile.username, "like_timeline_post", `EB liked ${liked} post(s) inline while scrolling`);
            console.log(`[engine] @${profile.username}: [EB-only] ❤️ liked ${liked} posts inline while scrolling`);
          }
        } catch (e: any) {
          if (e?.__ebChallenge) {
            console.warn(`[engine] @${profile.username}: [EB-only] viewTimelineFeed aborted — challenge page detected (${e.__ebChallengeStatus})`);
            this.logGhostBrowserCall(profile.id, profile.username, "view_timeline_feed", e?.message ?? "challenge detected", true);
            throw e;
          }
          console.warn(`[engine] @${profile.username}: [EB-only] viewTimelineFeed error: ${e?.message}`);
          this.logGhostBrowserCall(profile.id, profile.username, "view_timeline_feed", e?.message ?? "error", true);
        }
      }
      });

      // ── View Reels — independent tool, navigate to /reels/ and watch N reels ──
      // Uses reelWatchCountMin/Max, reelWatchPercentMin/Max. reelWatchChanceMin/Max
      // is this tool's own "Chance %" (probability the tool fires at all this
      // session) — decoupled from View Timeline Feed's enabled state.
      // There is no mobile-API reel call available in browser-only mode, so we
      // navigate to instagram.com/reels/, wait for the video to load, dwell for
      // reelViewPct% of an estimated reel duration, then press ArrowDown to advance.
      ebEnqueue("viewReels", "viewReelsOrderMin", "viewReelsOrderMax", async () => {
      if (s.viewReelsEnabled === true && (s as any).emulationGroupEnabled !== false) {
        // Normalize reel chance bounds to [0,100], swap if inverted.
        const reelChanceRaw0 = Math.min(100, Math.max(0, Number(s.reelWatchChanceMin ?? 100)));
        const reelChanceRaw1 = Math.min(100, Math.max(0, Number(s.reelWatchChanceMax ?? 100)));
        const reelChanceMin2 = Math.min(reelChanceRaw0, reelChanceRaw1);
        const reelChanceMax2 = Math.max(reelChanceRaw0, reelChanceRaw1);
        if (reelChanceMax2 > 0) {
          const reelChance = reelChanceMin2 + Math.random() * (reelChanceMax2 - reelChanceMin2);
          const reelChanceRoll = Math.random() * 100;
          const reelsEnabled = reelChanceRoll < reelChance;
          if (reelsEnabled) {
            // Normalize count and view-% bounds, swap if inverted.
            const rcMin = Math.max(0, Number(s.reelWatchCountMin ?? 1));
            const rcMax = Math.max(rcMin, Number(s.reelWatchCountMax ?? 3));
            const reelCount = randInt(rcMin, rcMax);
            const rvMin = Math.min(100, Math.max(0, Number(s.reelWatchPercentMin ?? 50)));
            const rvMax = Math.min(100, Math.max(0, Number(s.reelWatchPercentMax ?? 100)));
            const reelViewPctMin = Math.min(rvMin, rvMax);
            const reelViewPctMax = Math.max(rvMin, rvMax);
            // Reel Like% — same "% of items to like" model as the timeline feed's
            // inline Like%. Resolved ONCE per session (mirrors the feed logic) into
            // a fixed target count, then the reel loop below tries to like reels
            // (up to that count) as it watches through them — no per-step random
            // gate, since likeCount already encodes the probability.
            const rlMin = Math.min(100, Math.max(0, Number(s.reelLikePercentMin ?? 0)));
            const rlMax = Math.min(100, Math.max(0, Number(s.reelLikePercentMax ?? 0)));
            const reelLikePctMin = Math.min(rlMin, rlMax);
            const reelLikePctMax = Math.max(rlMin, rlMax);
            const reelLikePct = reelLikePctMax > 0 ? reelLikePctMin + Math.random() * (reelLikePctMax - reelLikePctMin) : 0;
            const reelLikeCount = reelLikePctMax > 0 ? Math.round(reelCount * reelLikePct / 100) : 0;
            console.log(`[engine] @${profile.username}: 🎲 [EB] View Reels chance ${reelChanceRoll.toFixed(1)}% < ${reelChance.toFixed(1)}% — reels ON (${reelCount} reels, like target ${reelLikeCount})`);
            try {
              await nav("https://www.instagram.com/reels/", "reels feed");
              await sleep(actionDelay());
              // Give reels page more time — React hydrates slowly and video
              // elements are injected after the SPA shell renders.
              const videoFound = await waitFor("video", 15000);
              if (!videoFound) {
                // Debug: dump page state so we know what's there
                const _reelDebug = await page.evaluate(() => {
                  return `url="${location.href.slice(0,120)}" title="${document.title}" videos=${document.querySelectorAll('video').length} imgs=${document.querySelectorAll('img').length} bodyLen=${document.body?.innerHTML?.length ?? 0}`;
                }).catch(() => "evaluate failed");
                console.log(`[engine] @${profile.username}: [EB-only] 🎬 reels debug — ${_reelDebug}`);
              }
              let watched = 0;
              let totalWatchMs = 0;
              let totalViewPct = 0;
              let reelLiked = 0;
              if (videoFound) {
                // Force visibilityState=visible so Instagram's SPA keeps the
                // reel hydrated when the EB window is off-screen (same fix
                // applied to viewTimelineFeed, likeTimelinePosts, and stories).
                await page.evaluate(() => {
                  try { Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true }); } catch {}
                  try { Object.defineProperty(document, 'hidden', { get: () => false, configurable: true }); } catch {}
                  document.dispatchEvent(new Event('visibilitychange'));
                }).catch(() => {});
                for (let i = 0; i < reelCount && !state.stop.stopped; i++) {
                  // Dwell for reelViewPct% of an estimated 8–20s reel duration.
                  const reelViewPct = reelViewPctMin + Math.random() * Math.max(0, reelViewPctMax - reelViewPctMin);
                  const reelDurMs = randInt(8000, 20000);
                  const watchMs = Math.max(2000, Math.round((reelViewPct / 100) * reelDurMs));
                  await sleep(watchMs);
                  // Reel Like — try once per reel while it's on screen, up to the
                  // pre-computed reelLikeCount target (no per-step random gate; see
                  // the double-random-gate bug this pattern avoids on the feed above).
                  if (reelLikeCount > 0 && reelLiked < reelLikeCount) {
                    const likedReel: boolean = await page.evaluate(() => {
                      const heartSvg = document.querySelector('svg[aria-label="Like"]') as SVGElement | null;
                      if (!heartSvg) return false;
                      const btn = heartSvg.closest<HTMLElement>('[role="button"], button');
                      if (!btn) return false;
                      btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
                      btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
                      btn.click();
                      return true;
                    }).catch(() => false);
                    if (likedReel) {
                      reelLiked++;
                      await storage.incrementStat(profile.id, "like").catch(() => {});
                      await sleep(actionDelay());
                    }
                  }
                  // Focus the body so the ArrowDown key event reaches Instagram's
                  // reel player (keyboard events on an unfocused element are dropped).
                  await page.evaluate(() => { try { document.body.focus(); } catch {} }).catch(() => {});
                  await page.keyboard.press("ArrowDown").catch(() => {});
                  await sleep(randInt(600, 1400));
                  watched++;
                  totalWatchMs += watchMs;
                  totalViewPct += reelViewPct;
                }
              } else {
                console.log(`[engine] @${profile.username}: [EB-only] no video found on /reels/, skipping`);
              }
              const avgPct = watched > 0 ? Math.round(totalViewPct / watched) : 0;
              const totalSec = Math.round(totalWatchMs / 1000);
              const reelDetail = `EB watched ${watched} reel(s) · avg ${avgPct}% view · ${totalSec}s total`;
              this.logAction(profile.id, tool.id, "view_reel_from_feed", "", "", "reel", watched > 0 ? "ok" : "skipped", reelDetail);
              this.logGhostBrowserCall(profile.id, profile.username, "view_reel_from_feed", reelDetail);
              console.log(`[engine] @${profile.username}: [EB-only] 🎬 watched ${watched} reels`);
              if (reelLiked > 0) {
                this.logAction(profile.id, tool.id, "like_timeline_post", "", "", "reel", "ok", `EB liked ${reelLiked} reel(s) while watching`);
                this.logGhostBrowserCall(profile.id, profile.username, "like_timeline_post", `EB liked ${reelLiked} reel(s) while watching`);
                console.log(`[engine] @${profile.username}: [EB-only] ❤️ liked ${reelLiked} reels`);
              }
            } catch (e: any) {
              console.warn(`[engine] @${profile.username}: [EB-only] reels feed error: ${e?.message}`);
              this.logGhostBrowserCall(profile.id, profile.username, "view_reel_from_feed", e?.message ?? "error", true);
            }
            // Always navigate back to the home feed after the reels block so the
            // EB does not stay parked on /reels/ for subsequent actions. Without
            // this, if checkTimelineStories is disabled, the EB remains on /reels/
            // for the rest of the session and the user sees a jarring jump when
            // the next session starts.
            if (!state.stop.stopped) {
              await nav("https://www.instagram.com/", "home (after reels)").catch(() => {});
              await sleep(actionDelay());
            }
          } else {
            console.log(`[engine] @${profile.username}: 🎲 [EB] View Reels chance ${reelChanceRoll.toFixed(1)}% ≥ ${reelChance.toFixed(1)}% — skipping`);
          }
        }
      }
      });

      // ── checkTimelineStories — click story circles then navigate through ──
      ebEnqueue("checkTimelineStories", "checkTimelineStoriesOrderMin", "checkTimelineStoriesOrderMax", async () => {
      if (s.checkTimelineStoriesEnabled === true && (s as any).emulationGroupEnabled !== false) {
        try {
          const storyCount = randInt(Number(s.checkTimelineStoriesMin ?? 2), Number(s.checkTimelineStoriesMax ?? 6));
          // Story circles live in the tray at the top of the home feed, always
          // rendered as <li> items inside a tray with a canvas ring — this is
          // far more stable than indexing every role="button" on the page
          // (which also matches nav icons, and was why story clicks silently
          // missed their target before).
          // Story tray selectors — Instagram changed from canvas to img for
          // story ring avatars in 2024/2025. Try multiple selectors in order
          // of most-to-least specific. Any match means the tray is rendered.
          const storySelector = [
            'ul li div[role="button"] canvas',            // old: canvas-rendered avatars
            'section div[role="button"] canvas',          // old: alternate section wrapper
            'ul li button canvas',                        // variant
            'ul li div[role="button"] img',               // new: <img> avatars
            'ul li button img[alt]',                      // new: button with img
            'div[role="listbox"] button',                 // 2025 listbox pattern
            '[aria-label$="\'s story"]',                  // aria-label ends with "'s story"
            '[aria-label*=" story"]',                     // aria-label containing " story"
          ].join(', ');
          let storiesViewed = 0;
          // ── Per-story loop ────────────────────────────────────────────────────
          // Each iteration: navigate to home feed, click the FIRST tray item
          // (index 0 — which is always the next unwatched user after the previous
          // one disappears from the front of the tray), dwell, close, repeat.
          //
          // Why NOT use a fixed index i=0,1,2…:
          //   ArrowRight can bleed beyond the current user's slides and auto-advance
          //   into the next user's story. When Escape closes the viewer, the tray
          //   still shows that next user at their partial-watch position. The next
          //   loop iteration then clicks that same user's tray item a second time,
          //   which is exactly the "same user twice" bug.
          //
          // Navigating back to the home feed after each story and always clicking
          // index 0 avoids this entirely — the tray advances its own "first unseen"
          // pointer after each fully-dismissed story.
          let hasTray = false;
          let escapeSent = false;
          for (let i = 0; i < storyCount && !state.stop.stopped; i++) {
            try {
              if (i === 0) {
                // ── First user: navigate to home feed, open the story tray ────────
                await nav("https://www.instagram.com/", `home (stories ${i + 1}/${storyCount})`);
                await sleep(actionDelay());
                // Force visibilityState=visible so Instagram's SPA hydrates the
                // story tray even when the EB window is hidden/not shown to the
                // user. Same fix already applied to viewTimelineFeed and
                // likeTimelinePosts — was missing here, which is why the tray
                // selector never matched and every run logged "0 story tray item(s)".
                await page.evaluate(() => {
                  try { Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true }); } catch {}
                  try { Object.defineProperty(document, 'hidden', { get: () => false, configurable: true }); } catch {}
                  document.dispatchEvent(new Event('visibilitychange'));
                }).catch(() => {});
                const trayPresent = await waitFor(storySelector, 6000);
                if (!trayPresent) {
                  // Debug: dump page DOM state so we can see what selector IS present
                  const _storyDebug = await page.evaluate(() => {
                    const url = location.href.slice(0, 100);
                    const ulLi = document.querySelectorAll('ul li').length;
                    const canvases = document.querySelectorAll('canvas').length;
                    const imgs = document.querySelectorAll('ul li img').length;
                    const btnRole = document.querySelectorAll('[role="button"]').length;
                    const ariaStory = document.querySelectorAll('[aria-label*="story"]').length;
                    return `url="${url}" ul-li=${ulLi} canvas=${canvases} ul-li-img=${imgs} role-btn=${btnRole} aria-story=${ariaStory}`;
                  }).catch(() => "eval failed");
                  console.log(`[engine] @${profile.username}: [EB-only] no story tray on iteration ${i} — ${_storyDebug}`);
                  break;
                }
                hasTray = true;
                // Click index 0 — the first item in the tray — to open the story viewer.
                const clicked: boolean = await page.evaluate((sel: string) => {
                  const matches = Array.from(document.querySelectorAll(sel));
                  const el = matches[0] as HTMLElement | undefined;
                  if (!el) return false;
                  // The matched element may be a button itself (new selectors) OR
                  // a canvas/img inside a button wrapper (old selectors).
                  const btn = (el.closest('button, [role="button"], a, div[tabindex]') ?? el) as HTMLElement;
                  btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                  btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
                  btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
                  btn.click();
                  return true;
                }, storySelector).catch(() => false);
                if (!clicked) break;
                await sleep(randInt(1200, 2500));
              } else {
                // ── Subsequent users: stay inside the story viewer ────────────────
                // Press ArrowRight until the live location.href username segment
                // changes. We use page.evaluate(() => location.href) rather than
                // page.url() because in the EB IPC shim page.url() is only updated
                // by explicit goto() calls — click/ArrowRight transitions do not
                // flush it, so it would always look stale and advanced would never
                // become true.
                // Guard: if the viewer closed unexpectedly, bail out cleanly.
                const viewerOpen = await page.evaluate(() =>
                  !!(document.querySelector('section[role="dialog"], div[role="dialog"], div[aria-label="Story"]'))
                ).catch(() => false);
                if (!viewerOpen) {
                  console.log(`[engine] @${profile.username}: [EB-only] story viewer closed unexpectedly before user ${i + 1}`);
                  escapeSent = true; // viewer already gone, no Escape needed
                  break;
                }
                const prevHref = await page.evaluate(() => location.href).catch(() => '');
                const prevUser = (prevHref.match(/\/stories\/([^/]+)\//) ?? [])[1] ?? '';
                let advanced = false;
                for (let attempt = 0; attempt < 10 && !advanced && !state.stop.stopped; attempt++) {
                  await page.keyboard.press("ArrowRight");
                  await sleep(450);
                  const newHref = await page.evaluate(() => location.href).catch(() => '');
                  const newUser = (newHref.match(/\/stories\/([^/]+)\//) ?? [])[1] ?? '';
                  // Accept advancement if: username changed, OR URL left the /stories/
                  // path entirely (viewer closed after last user in tray).
                  if (newUser && newUser !== prevUser) { advanced = true; break; }
                  if (!newHref.includes('/stories/')) {
                    console.log(`[engine] @${profile.username}: [EB-only] story viewer exited (tray exhausted at user ${i})`);
                    escapeSent = true;
                    break;
                  }
                }
                if (escapeSent) break;
                if (!advanced) {
                  // Still on the same user after 10 ArrowRight presses — no more
                  // users in the tray. Exit the viewer cleanly.
                  console.log(`[engine] @${profile.username}: [EB-only] story viewer ended at user ${i}/${storyCount} (no next user)`);
                  await page.keyboard.press("Escape").catch(() => {});
                  await sleep(randInt(800, 1600));
                  escapeSent = true;
                  break;
                }
                await sleep(randInt(800, 1500));
              }

              // ── Watch N slides for the current user ───────────────────────────
              // Uses checkTimelineStoriesSlideMin/Max from settings (defaults 2-5).
              // Right-half click advances one slide at a time within the current
              // user's story — it does NOT auto-advance to the next user the way
              // ArrowRight can when on the last slide.
              const slides = randInt(
                Math.max(1, Number(s.checkTimelineStoriesSlideMin ?? 2)),
                Math.max(1, Number(s.checkTimelineStoriesSlideMax ?? 5)),
              );
              // Watch % — how much of each slide to watch before advancing.
              // 0 = use the default dwell time. >0 = stories average ~15s each;
              // watch% controls how long we dwell before clicking to the next slide.
              const watchPctMin = Math.min(100, Math.max(0, Number(s.checkTimelineStoriesWatchPctMin ?? 0)));
              const watchPctMax = Math.max(watchPctMin, Math.min(100, Number(s.checkTimelineStoriesWatchPctMax ?? 0)));
              const watchPct = watchPctMin + Math.random() * (watchPctMax - watchPctMin);
              const slideDwellMs = watchPct > 0
                ? Math.max(1500, Math.round((watchPct / 100) * 15000))
                : randInt(1500, 3500);
              for (let s2 = 0; s2 < slides && !state.stop.stopped; s2++) {
                await page.evaluate(() => {
                  const overlay = document.querySelector<HTMLElement>(
                    'section[role="dialog"], div[role="dialog"], div[aria-label="Story"]'
                  ) ?? document.body;
                  const rect = overlay.getBoundingClientRect();
                  const x = rect.left + rect.width * 0.7;
                  const y = rect.top + rect.height * 0.5;
                  overlay.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }));
                  overlay.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, clientX: x, clientY: y }));
                }).catch(() => {});
                await sleep(slideDwellMs);
              }
              storiesViewed++;
            } catch {}
          }
          // Exit the story viewer after the last user (or if the loop completed
          // normally). Skip if the in-loop early-break already sent Escape
          // (tracked by escapeSent) to prevent a double-Escape that could
          // misfire on whatever page is active after the viewer closed.
          if (storiesViewed > 0 && !escapeSent) {
            await page.keyboard.press("Escape").catch(() => {});
            await sleep(randInt(800, 1600));
          }
          this.logAction(profile.id, tool.id, "check_timeline_stories", "", "", "", storiesViewed > 0 ? "ok" : "skipped", `EB viewed ${storiesViewed} story tray item(s)`);
          this.logGhostBrowserCall(profile.id, profile.username, "check_timeline_stories", `EB viewed ${storiesViewed} story tray item(s)`, storiesViewed === 0 && hasTray);
          console.log(`[engine] @${profile.username}: [EB-only] 📖 viewed ${storiesViewed} stories`);
        } catch (e: any) {
          console.warn(`[engine] @${profile.username}: [EB-only] checkTimelineStories error: ${e?.message}`);
          this.logGhostBrowserCall(profile.id, profile.username, "check_timeline_stories", e?.message ?? "error", true);
        }
      }
      });

      // ── checkDm — open inbox, click threads ───────────────────────────────
      ebEnqueue("checkDm", "checkDmOrderMin", "checkDmOrderMax", async () => {
      if (s.checkDmEnabled === true && (s as any).emulationGroupEnabled !== false) {
        try {
          const dmCount = randInt(Number(s.checkDmMin ?? 1), Number(s.checkDmMax ?? 5));
          await nav("https://www.instagram.com/direct/inbox/", "DM inbox");
          await sleep(actionDelay());
          // Anchor on <a href="/direct/t/..."> links — these only exist inside real
          // conversation listitems. Using the generic div[role="listitem"] was too
          // broad: it also matched story bubbles, "Your note", and other sidebar
          // elements, causing false-positive clicks (and a misleading "0/3" log)
          // when the EB was hidden and the page rendered those non-thread elements.
          const hasThreads = await waitFor('a[href*="/direct/t/"]', 8000);
          if (!hasThreads) {
            // Inbox is genuinely empty — nothing to open.
            this.logAction(profile.id, tool.id, "check_dm", "", "", "", "skipped", "EB: DM inbox empty");
            this.logGhostBrowserCall(profile.id, profile.username, "check_dm", "EB: DM inbox empty");
          } else {
            let opened = 0;
            for (let i = 0; i < dmCount && !state.stop.stopped; i++) {
              try {
                const clicked: boolean = await page.evaluate((idx: number) => {
                  // Only target real DM conversation threads (have /direct/t/ link).
                  // scrollIntoView + pointer events work in both visible and hidden EB.
                  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/direct/t/"]'));
                  const thread = (links[idx]?.closest('div[role="listitem"]') ?? links[idx]) as HTMLElement | undefined;
                  if (!thread) return false;
                  thread.scrollIntoView({ block: 'center', behavior: 'instant' });
                  thread.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
                  thread.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, cancelable: true }));
                  thread.click();
                  return true;
                }, i).catch(() => false);
                if (!clicked) break;
                await sleep(actionDelay());
                opened++;
                // Return to the inbox list before opening the next thread.
                await nav("https://www.instagram.com/direct/inbox/", "DM inbox");
                await sleep(actionDelay());
                // After re-loading the inbox, re-check threads still exist.
                const stillHas = await waitFor('a[href*="/direct/t/"]', 5000);
                if (!stillHas) break;
              } catch {}
            }
            this.logAction(profile.id, tool.id, "check_dm", "", "", "", opened > 0 ? "ok" : "skipped", `EB opened ${opened}/${dmCount} DM thread(s)`);
            this.logGhostBrowserCall(profile.id, profile.username, "check_dm", `EB opened ${opened}/${dmCount} DM thread(s)`);
            console.log(`[engine] @${profile.username}: [EB-only] 💬 opened ${opened} DM threads`);
          }
        } catch (e: any) {
          console.warn(`[engine] @${profile.username}: [EB-only] checkDm error: ${e?.message}`);
          this.logGhostBrowserCall(profile.id, profile.username, "check_dm", e?.message ?? "error", true);
        }
      }
      });

      // ── likeTimelinePosts — scroll feed, click Like (heart) buttons ───────
      ebEnqueue("likeTimelinePosts", "likeTimelinePostsOrderMin", "likeTimelinePostsOrderMax", async () => {
      if (s.likeTimelinePostsEnabled === true && (s as any).emulationGroupEnabled !== false) {
        const likeCount = randInt(Number(s.likeTimelinePostsMin ?? 0), Number(s.likeTimelinePostsMax ?? 0));
        if (likeCount > 0) {
          try {
            if (!page.url().startsWith("https://www.instagram.com/")) {
              await nav("https://www.instagram.com/", "home (likes)");
              await sleep(actionDelay());
            }
            // Force visibilityState=visible so Instagram loads feed content
            // even when the EB window is not shown to the user.
            await page.evaluate(() => {
              try { Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true }); } catch {}
              try { Object.defineProperty(document, 'hidden', { get: () => false, configurable: true }); } catch {}
              document.dispatchEvent(new Event('visibilitychange'));
            }).catch(() => {});
            await waitFor('svg[aria-label="Like"]', 12000);
            let liked = 0;
            for (let attempt = 0; liked < likeCount && attempt < likeCount * 6 && !state.stop.stopped; attempt++) {
              await page.evaluate(() => window.scrollBy(0, 350)).catch(() => {});
              await sleep(700);
              // scrollIntoView + full pointer event sequence — works when the EB
              // window is hidden. Plain .click() on a hidden window is silently
              // swallowed; getBoundingClientRect returns zeros so viewport checks
              // always fail. scrollIntoView is DOM-only and works regardless.
              const clickedOne: boolean = await page.evaluate(() => {
                const articles = Array.from(document.querySelectorAll('article'));
                const target = articles.find(a => !!a.querySelector('svg[aria-label="Like"]'));
                if (!target) return false;
                target.scrollIntoView({ behavior: 'instant', block: 'center' });
                const heartSvg = target.querySelector('svg[aria-label="Like"]') as SVGElement | null;
                if (!heartSvg) return false;
                const btn = heartSvg.closest<HTMLElement>('[role="button"], button');
                if (!btn) return false;
                btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
                btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
                btn.click();
                return true;
              }).catch(() => false);
              if (clickedOne) { liked++; await sleep(actionDelay()); }
            }
            for (let i = 0; i < liked; i++) await storage.incrementStat(profile.id, "like").catch(() => {});
            if (liked > 0) {
              this.logAction(profile.id, tool.id, "like_timeline_post", "", "", "", "ok", `EB liked ${liked} post(s) via browser`);
              this.logGhostBrowserCall(profile.id, profile.username, "like_timeline_post", `EB liked ${liked} post(s) via browser`);
            }
            console.log(`[engine] @${profile.username}: [EB-only] ❤️ liked ${liked} posts`);
          } catch (e: any) {
            console.warn(`[engine] @${profile.username}: [EB-only] likeTimelinePosts error: ${e?.message}`);
            this.logGhostBrowserCall(profile.id, profile.username, "like_timeline_post", e?.message ?? "error", true);
          }
        }
      }
      });

      // ── follow / unfollow / contact / repost — queued for order-controlled execution ──
      ebEnqueue("follow", "followOrderMin", "followOrderMax", async () => {
        const _followTool = (await storage.getToolsByProfile(profile.id)).find(t => t.type === "follow");
        if (_followTool?.enabled === true) {
          await this.runBrowserFollowSession(profile, _followTool, page, actionDelay, state).catch((e: any) => {
            console.warn(`[engine] @${profile.username}: [EB-only] follow session error: ${e?.message}`);
          });
        }
      });
      ebEnqueue("unfollow", "unfollowOrderMin", "unfollowOrderMax", async () => {
        const _unfollowTool = (await storage.getToolsByProfile(profile.id)).find(t => t.type === "unfollow");
        if (_unfollowTool?.enabled === true) {
          await this.runBrowserUnfollowSession(profile, _unfollowTool, page, actionDelay, state).catch((e: any) => {
            console.warn(`[engine] @${profile.username}: [EB-only] unfollow session error: ${e?.message}`);
          });
        }
      });
      ebEnqueue("contact", "contactOrderMin", "contactOrderMax", async () => {
        const _contactTool = (await storage.getToolsByProfile(profile.id)).find(t => t.type === "contact");
        if (_contactTool?.enabled === true) {
          await this.runBrowserContactSession(profile, _contactTool, page, actionDelay, state).catch((e: any) => {
            console.warn(`[engine] @${profile.username}: [EB-only] contact session error: ${e?.message}`);
          });
        }
      });
      ebEnqueue("repost", "repostOrderMin", "repostOrderMax", async () => {
        const repostSourceUsernameEb = String(s.repostSourceUsername ?? "").trim();
        const repostLocalFolderPathEb = String(s.repostLocalFolderPath ?? "").trim();
        const repostLocalFolderEnabledEb = !!(s.repostLocalFolderEnabled && repostLocalFolderPathEb);
        const repostUsernameSourceActiveEb = !s.repostDisableUsernameSource && !!repostSourceUsernameEb;
        const repostEnabledEb = !!(s.repostEnabled && (repostUsernameSourceActiveEb || repostLocalFolderEnabledEb));

        if (!repostEnabledEb || (s as any).emulationGroupEnabled === false) {
          console.log(`[engine] @${profile.username}: [EB-only] HS queue — repost skipped (${!repostEnabledEb ? 'disabled' : 'emulation group disabled'})`);
        } else if (this.shouldSkipDueToChance(s, "repostNotUsedMin", "repostNotUsedMax")) {
          console.log(`[engine] @${profile.username}: [EB-only] HS queue — repost skipped (chance roll)`);
        } else if (!ebIpcPort) {
          console.log(`[engine] @${profile.username}: [EB-only] repost skipped — browser-post requires the desktop app (not available in dev/Replit)`);
        } else {
          try {
            if (repostLocalFolderEnabledEb) {
              const entries = await fsPromises.readdir(repostLocalFolderPathEb);
              const mediaFiles = entries.filter(f => isImageFile(nodePath.extname(f).toLowerCase()));
              if (mediaFiles.length === 0) {
                console.warn(`[engine] @${profile.username}: [EB-only] 🔁 local folder repost — no image files found in "${repostLocalFolderPathEb}"`);
                this.logAction(profile.id, tool.id, "repost", repostLocalFolderPathEb, "", "", "skip", "No image files found in local folder (video is not supported in Disable API mode)");
              } else {
                const targetCount = randInt(
                  Math.max(1, Number(s.repostMin ?? 1)),
                  Math.max(1, Number(s.repostMax ?? 1)),
                );
                const level = ((s.repostAlterationLevel ?? "small") as AlterationLevel);
                const captionTemplate = String(s.repostCaptionText ?? "").trim();
                const deleteAfterUpload = s.repostLocalFolderDeleteAfterUpload !== false;
                const noRepeat = !!(s as any).repostLocalFolderNoRepeat;
                const makeUnique = !!(s as any).repostMakeUnique;
                const pickRandom = !!(s as any).repostLocalFolderRandom;

                let filteredFiles = mediaFiles;
                if (noRepeat) {
                  const existingReposted = await storage.getRepostedPostsByProfile(profile.id, 10000);
                  const postedLocalSet = new Set(
                    existingReposted.filter(r => r.mediaId.startsWith("local:")).map(r => r.mediaId.slice(6)),
                  );
                  filteredFiles = mediaFiles.filter(f => !postedLocalSet.has(f));
                  if (filteredFiles.length === 0) {
                    console.log(`[engine] @${profile.username}: [EB-only] 🔁 local folder — all media already reposted (noRepeat=true)`);
                    this.logAction(profile.id, tool.id, "repost", repostLocalFolderPathEb, "", "", "skip", "All local folder media already reposted (Do not repost same image is ON)");
                    filteredFiles = [];
                  }
                }

                const ordered = pickRandom
                  ? [...filteredFiles].sort(() => Math.random() - 0.5)
                  : [...filteredFiles].sort((a, b) => a.localeCompare(b));
                const picked = ordered.slice(0, targetCount);

                for (const fileName of picked) {
                  if (state.stop.stopped) break;
                  const filePath = nodePath.join(repostLocalFolderPathEb, fileName);
                  let caption = captionTemplate ? captionTemplate.replace(/\{own_username\}/g, profile.username) : "";
                  try {
                    const rawBuffer = await fsPromises.readFile(filePath);
                    let alteredBuffer = await alterJpegBuffer(rawBuffer, level, s.repostImageSettings);
                    if (makeUnique) {
                      try {
                        alteredBuffer = await makeUniqueImage(alteredBuffer);
                      } catch (uqErr: any) {
                        console.warn(`[engine] @${profile.username}: [EB-only] makeUniqueImage failed for ${fileName}: ${uqErr?.message}`);
                      }
                    }
                    console.log(`[engine] @${profile.username}: [EB-only] 🔁 repost upload starting — file="${fileName}" level=${level} captionLen=${caption.length}`);
                    const bpResult = await this.postPhotoViaBrowser(profile.id, alteredBuffer, caption);
                    if (bpResult.ok) {
                      console.log(`[engine] @${profile.username}: [EB-only] 🔁 uploaded image from local folder: ${fileName}`);
                      this.logAction(profile.id, tool.id, "repost", repostLocalFolderPathEb, fileName, "", "ok", "Make a Post Successful");
                      this.logGhostBrowserCall(profile.id, profile.username, "make_a_post", `EB: uploaded ${fileName}`);
                      await storage.incrementStat(profile.id, "repost");
                      storage.createInstagramApiCall({
                        profileId: profile.id, username: profile.username,
                        operationName: "PostMedia", date: new Date().toISOString(),
                        source: "browser", transport: "browser", isError: false,
                      }).catch(() => {});
                      if (noRepeat) {
                        await storage.createRepostedPost({
                          profileId: profile.id, toolId: tool.id,
                          sourceUsername: repostLocalFolderPathEb,
                          mediaId: `local:${fileName}`, shortcode: "", caption: "",
                          thumbnailUrl: "", repostedAt: new Date().toISOString(), postedShortcode: "",
                        }).catch(() => {});
                      }
                      if (deleteAfterUpload) {
                        try { await fsPromises.unlink(filePath); } catch (e: any) {
                          console.warn(`[engine] @${profile.username}: [EB-only] could not delete ${filePath}: ${e?.message}`);
                        }
                      }
                    } else {
                      console.warn(`[engine] @${profile.username}: [EB-only] 🔁 local folder upload failed: ${fileName} — ${bpResult.message}`);
                      this.logAction(profile.id, tool.id, "repost", repostLocalFolderPathEb, fileName, "", "fail", "Make a Post Failed");
                      break;
                    }
                  } catch (e: any) {
                    console.warn(`[engine] @${profile.username}: [EB-only] repost error for ${fileName}: ${e?.message}`);
                    this.logAction(profile.id, tool.id, "repost", repostLocalFolderPathEb, fileName, "", "fail", e?.message ?? "unknown error");
                    break;
                  }
                }
              }
            } else if (repostUsernameSourceActiveEb) {
              console.log(`[engine] @${profile.username}: [EB-only] 🔁 repost skipped — @username source requires API access (not available in Disable API mode). Use "Source: Local PC Folder" instead.`);
              this.logAction(profile.id, tool.id, "repost", repostSourceUsernameEb, "", "", "skip", "Username source repost is not supported in Disable API mode — use Local PC Folder instead");
            }
          } catch (e: any) {
            console.warn(`[engine] @${profile.username}: [EB-only] repost session error: ${e?.message}`);
            this.logAction(profile.id, tool.id, "repost", "", "", "", "fail", e?.message ?? "unknown error");
          }
        }
      });

      // ── explorePage — visit Explore page as an independent queued action ─────
      // Previously ran inline only when feedHadPosts=false (tied to the feed block).
      // Now a standalone queued tool with its own Order % and Skip Chance % so it
      // runs like every other emulation feature — independent of whether the feed
      // had posts or not.
      ebEnqueue("explorePage", "explorePageOrderMin", "explorePageOrderMax", async () => {
        if (s.followSuggestedUsersIfEmptyEnabled !== true || (s as any).emulationGroupEnabled === false) return;
        // Skip-chance roll (same pattern as all other ebQueue entries)
        const epSkipMin = Math.min(100, Math.max(0, Number(s.explorePageSkipMin ?? 0)));
        const epSkipMax = Math.min(100, Math.max(0, Number(s.explorePageSkipMax ?? 0)));
        const epSkipLo = Math.min(epSkipMin, epSkipMax);
        const epSkipHi = Math.max(epSkipMin, epSkipMax);
        if (epSkipHi > 0) {
          const skipChance = epSkipLo + Math.random() * (epSkipHi - epSkipLo);
          if (Math.random() * 100 < skipChance) {
            console.log(`[engine] @${profile.username}: [EB-only] 🧭 explorePage skipped (skip chance roll)`);
            return;
          }
        }
        try {
          const scrollMin = Math.max(1, Number(s.exploreScrollMin ?? 5));
          const scrollMax = Math.max(scrollMin, Number(s.exploreScrollMax ?? 15));
          const clickMin  = Math.max(0, Number(s.exploreClickMin ?? 1));
          const clickMax  = Math.max(clickMin, Number(s.exploreClickMax ?? 3));
          const likePctMin = Math.min(100, Math.max(0, Number(s.exploreLikePctMin ?? 0)));
          const likePctMax = Math.min(100, Math.max(likePctMin, Number(s.exploreLikePctMax ?? 30)));
          const visitProfPctMin = Math.min(100, Math.max(0, Number(s.exploreVisitProfilePctMin ?? 0)));
          const visitProfPctMax = Math.min(100, Math.max(visitProfPctMin, Number(s.exploreVisitProfilePctMax ?? 20)));
          const profScrollMin = Math.max(1, Number(s.exploreProfileScrollMin ?? 3));
          const profScrollMax = Math.max(profScrollMin, Number(s.exploreProfileScrollMax ?? 8));
          const profClickMin  = Math.max(0, Number(s.exploreProfileClickMin ?? 1));
          const profClickMax  = Math.max(profClickMin, Number(s.exploreProfileClickMax ?? 3));

          await nav("https://www.instagram.com/explore/", "explore page");
          await sleep(actionDelay());

          // Scroll through explore grid
          const scrolls = randInt(scrollMin, scrollMax);
          for (let i = 0; i < scrolls && !state.stop.stopped; i++) {
            await page.evaluate(() => window.scrollBy(0, 400 + Math.random() * 300)).catch(() => {});
            await sleep(actionDelay());
          }

          // Click into posts
          const clickCount = randInt(clickMin, clickMax);
          let clicked = 0;
          for (let attempt = 0; clicked < clickCount && attempt < clickCount * 4 && !state.stop.stopped; attempt++) {
            const opened: boolean = await page.evaluate(() => {
              const links = Array.from(document.querySelectorAll('a[href^="/p/"], a[href^="/reel/"]'));
              const a = links[Math.floor(Math.random() * Math.min(links.length, 12))] as HTMLElement | undefined;
              if (!a) return false;
              a.click();
              return true;
            }).catch(() => false);
            if (opened) {
              await sleep(randInt(1500, 3500));
              // Like roll
              const likePct = likePctMin + Math.random() * (likePctMax - likePctMin);
              if (likePct > 0 && Math.random() * 100 < likePct) {
                await page.evaluate(() => {
                  const btn = document.querySelector('svg[aria-label="Like"]')?.closest('button') as HTMLElement | null;
                  btn?.click();
                }).catch(() => {});
                await sleep(randInt(400, 900));
              }
              // Visit author profile roll
              const visitPct = visitProfPctMin + Math.random() * (visitProfPctMax - visitProfPctMin);
              if (visitPct > 0 && Math.random() * 100 < visitPct) {
                const navigatedToProfile: boolean = await page.evaluate(() => {
                  const profileLink = document.querySelector('header a[href^="/"]') as HTMLElement | null;
                  if (!profileLink) return false;
                  profileLink.click();
                  return true;
                }).catch(() => false);
                if (navigatedToProfile) {
                  await sleep(randInt(1200, 2500));
                  const profScrolls = randInt(profScrollMin, profScrollMax);
                  for (let ps = 0; ps < profScrolls && !state.stop.stopped; ps++) {
                    await page.evaluate(() => window.scrollBy(0, 350 + Math.random() * 250)).catch(() => {});
                    await sleep(randInt(600, 1400));
                  }
                  const profClicks = randInt(profClickMin, profClickMax);
                  for (let pc = 0; pc < profClicks && !state.stop.stopped; pc++) {
                    await page.evaluate(() => {
                      const posts = Array.from(document.querySelectorAll('a[href^="/p/"]'));
                      const p = posts[Math.floor(Math.random() * Math.min(posts.length, 9))] as HTMLElement | undefined;
                      p?.click();
                    }).catch(() => {});
                    await sleep(randInt(1000, 2500));
                    await page.keyboard.press("Escape").catch(() => {});
                    await sleep(randInt(400, 800));
                  }
                  // Return to explore
                  await nav("https://www.instagram.com/explore/", "explore page (after profile)");
                  await sleep(actionDelay());
                }
              }
              await page.keyboard.press("Escape").catch(() => {});
              await sleep(randInt(400, 900));
              clicked++;
            }
          }

          this.logAction(profile.id, tool.id, "explore_page", "", "", "", "ok",
            `EB browsed Explore (${scrolls} scrolls, ${clicked} posts opened)`);
          this.logGhostBrowserCall(profile.id, profile.username, "explore_page",
            `EB browsed Explore (${scrolls} scrolls, ${clicked} posts opened)`);
          console.log(`[engine] @${profile.username}: [EB-only] 🧭 browsed Explore page (${scrolls} scrolls, ${clicked} posts opened)`);
        } catch (e: any) {
          console.warn(`[engine] @${profile.username}: [EB-only] explorePage error: ${e?.message}`);
          this.logGhostBrowserCall(profile.id, profile.username, "explore_page", e?.message ?? "error", true);
        }
      });

      // ── Execute the ordered queue ─────────────────────────────────────────────
      // Higher order = runs first (same convention as the non-EB Human Session queue).
      ebQueue.sort((a, b) => b.order - a.order);
      console.log(`[engine] @${profile.username}: [EB-only] session order: ${ebQueue.map(e => e.key).join(' → ')}`);
      for (const entry of ebQueue) {
        if (state.stop.stopped) break;
        await entry.run();
      }

      // ── saveTimelinePosts — scroll feed, click the bookmark/Save icon ─────
      // Mirrors the mobile-API path: saveMediaEnabled + saveMediaPercent chance
      // per liked/viewed post (NOT a fixed min/max count).
      if (!!s.saveMediaEnabled && !state.stop.stopped) {
        const savePct = Number(s.saveMediaPercent ?? 0);
        // Expectation-based count derived from the number of posts actually
        // scrolled this session (feedCount), mirroring the Like% sub-setting's
        // rounding — NOT a single all-or-nothing roll that then saves a fixed
        // 1-3 posts regardless of the configured percentage. The previous
        // all-or-nothing roll meant a 1% setting could still save up to 3 posts
        // whenever the roll happened to succeed.
        const saveCount = savePct > 0 ? Math.round(feedCount * savePct / 100) : 0;
        if (saveCount > 0) {
          try {
            if (!page.url().startsWith("https://www.instagram.com/")) {
              await nav("https://www.instagram.com/", "home (save)");
              await sleep(actionDelay());
            }
            await waitFor('svg[aria-label="Save"]', 8000);
            let saved = 0;
            for (let attempt = 0; saved < saveCount && attempt < saveCount * 6 && !state.stop.stopped; attempt++) {
              await page.evaluate(() => window.scrollBy(0, 350)).catch(() => {});
              await sleep(700);
              const clickedOne: boolean = await page.evaluate(() => {
                const icons = Array.from(document.querySelectorAll('svg[aria-label="Save"]'));
                const h = icons[0] as SVGElement | undefined;
                if (!h) return false;
                (h.closest("button") as HTMLElement | null)?.click();
                return true;
              }).catch(() => false);
              if (clickedOne) { saved++; await sleep(actionDelay()); }
            }
            this.logAction(profile.id, tool.id, "save_timeline_post", "", "", "", saved > 0 ? "ok" : "skipped", `EB saved ${saved} post(s) via browser`);
            this.logGhostBrowserCall(profile.id, profile.username, "save_timeline_post", `EB saved ${saved} post(s) via browser`);
            console.log(`[engine] @${profile.username}: [EB-only] 🔖 saved ${saved} posts`);
          } catch (e: any) {
            console.warn(`[engine] @${profile.username}: [EB-only] saveTimelinePosts error: ${e?.message}`);
            this.logGhostBrowserCall(profile.id, profile.username, "save_timeline_post", e?.message ?? "error", true);
          }
        }
      }

      // ── shareTimelinePosts — click Share, then Escape (no recipient picked) ─
      // Mirrors the mobile-API path: sharePostPercentMin/Max chance per post,
      // not a fixed min/max count.
      if (!state.stop.stopped) {
        const sharePctMin = Number(s.sharePostPercentMin ?? 0);
        const sharePctMax = Number(s.sharePostPercentMax ?? 0);
        const sharePct = sharePctMin + Math.random() * Math.max(0, sharePctMax - sharePctMin);
        const shareCount = sharePct > 0 && Math.random() * 100 < sharePct ? randInt(1, 2) : 0;
        if (shareCount > 0) {
          try {
            if (!page.url().startsWith("https://www.instagram.com/")) {
              await nav("https://www.instagram.com/", "home (share)");
              await sleep(actionDelay());
            }
            await waitFor('svg[aria-label="Share Post"]', 8000);
            let shared = 0;
            for (let attempt = 0; shared < shareCount && attempt < shareCount * 6 && !state.stop.stopped; attempt++) {
              await page.evaluate(() => window.scrollBy(0, 350)).catch(() => {});
              await sleep(700);
              const opened: boolean = await page.evaluate(() => {
                const icons = Array.from(document.querySelectorAll('svg[aria-label="Share Post"]'));
                const h = icons[0] as SVGElement | undefined;
                if (!h) return false;
                (h.closest("button") as HTMLElement | null)?.click();
                return true;
              }).catch(() => false);
              if (opened) {
                await sleep(randInt(800, 1600));
                await page.keyboard.press("Escape").catch(() => {});
                shared++;
                await sleep(actionDelay());
              }
            }
            this.logAction(profile.id, tool.id, "share_timeline_post", "", "", "", shared > 0 ? "ok" : "skipped", `EB opened share dialog for ${shared} post(s) via browser`);
            this.logGhostBrowserCall(profile.id, profile.username, "share_timeline_post", `EB opened share dialog for ${shared} post(s) via browser`);
            console.log(`[engine] @${profile.username}: [EB-only] 📤 shared ${shared} posts`);
          } catch (e: any) {
            console.warn(`[engine] @${profile.username}: [EB-only] shareTimelinePosts error: ${e?.message}`);
            this.logGhostBrowserCall(profile.id, profile.username, "share_timeline_post", e?.message ?? "error", true);
          }
        }
      }

      // follow / unfollow / contact: moved to ebQueue above (executed in order-sorted sequence)

      // repost: moved to ebQueue above (executed in order-sorted sequence)

      console.log(`[engine] @${profile.username}: ✅ [EB-only] browser human session complete`);
    } catch (e: any) {
      console.warn(`[engine] @${profile.username}: [EB-only] browser human session error: ${e?.message}`);
    } finally {
      // Destroy the silentMode window if WE opened it for this session.
      // This keeps memory bounded with 1,000+ profiles — only a handful of
      // windows exist at any moment (one per concurrently running session).
      // If the user had a window open already (weOpenedIt=false), we leave it
      // alone — it is their persistent window and they may still be using it.
      if (_weOpenedEb && ebIpcPort) {
        await this.closeSilentEb(profile.id);
        console.log(`[engine] @${profile.username}: [EB-only] silentMode EB closed (ephemeral — session done)`);
      }
    }
  }

  // ── Browser-only follow session (Disable API mode) ─────────────────────────
  private async runBrowserFollowSession(
    profile: Profile,
    followTool: Tool,
    page: any,
    actionDelay: () => number,
    state: ProfileState,
  ): Promise<void> {
    const fs = followTool.settings as any;
    const globalSettings = await storage.getGlobalSettings();
    const hikerEnabled = globalSettings.hikerApiEnabled === "true";
    const hikerToken   = globalSettings.hikerApiToken ?? "";
    if (!hikerEnabled || !hikerToken) {
      console.log(`[engine] @${profile.username}: [EB-only] follow — HikerAPI disabled/no token, cannot get candidates`);
      this.logAction(profile.id, followTool.id, "follow", "", "", "", "skip", "Browser-only follow: HikerAPI required for candidate scraping");
      return;
    }
    const { HikerApiClient } = await import("./hikerApiClient");
    const hikerClient = new HikerApiClient(hikerToken);

    const sources = await storage.getSourcesByTool(followTool.id);
    const enabledSources = sources.filter((s: any) => s.enabled !== false);
    if (!enabledSources.length) {
      console.log(`[engine] @${profile.username}: [EB-only] follow — no enabled sources`);
      return;
    }
    const source = this.pickSource(sources);
    const processCount = randInt(Number(fs.processMin ?? 3), Number(fs.processMax ?? 8));
    const maxPerDay    = randInt(Number(fs.maxPerDayMin ?? 0), Number(fs.maxPerDayMax ?? 0));
    const maxPerHour   = randInt(Number(fs.maxPerHourMin ?? 0), Number(fs.maxPerHourMax ?? 0));

    // ── Inject Browsing settings (Disable API mode) ─────────────────────────
    // Disable API mode previously ignored these entirely — runBrowserFollowSession
    // only navigated to the candidate's profile and clicked Follow. Everything
    // below re-implements the same "browse the target's profile" behaviour that
    // the API-based session has (browseTargetProfile in runSession), but driven
    // purely through the EB page (page.goto / page.evaluate) since no mobile API
    // calls are allowed for this account.
    const injectBrowsingEnabled       = !!(fs.injectProfileBrowsingEnabled);
    const injectBrowsingBeforeFollow  = !!(fs.injectProfileBrowsingBeforeFollow);
    const injectBrowsingBeforePctMin  = Math.max(0, Math.min(100, fs.injectProfileBrowsingBeforeFollowPctMin ?? 0));
    const injectBrowsingBeforePctMax  = Math.max(injectBrowsingBeforePctMin, Math.min(100, fs.injectProfileBrowsingBeforeFollowPctMax ?? 0));
    const injectBrowsingPostMin       = Math.max(0, Math.min(100, fs.injectProfileBrowsingMin ?? 0));
    const injectBrowsingPostMax       = Math.max(injectBrowsingPostMin, Math.min(100, fs.injectProfileBrowsingMax ?? 0));
    const injectBrowsingFeedChanceMin = Math.max(0, Math.min(100, fs.injectProfileBrowsingFeedChanceMin ?? 100));
    const injectBrowsingFeedChanceMax = Math.max(injectBrowsingFeedChanceMin, Math.min(100, fs.injectProfileBrowsingFeedChanceMax ?? 100));
    const injectBrowsingFeedMin       = Math.max(1, fs.injectProfileBrowsingFeedMin ?? 3);
    const injectBrowsingFeedMax       = Math.max(injectBrowsingFeedMin, fs.injectProfileBrowsingFeedMax ?? 6);
    const injectBrowsingLikePctMin    = Math.max(0, Math.min(100, fs.injectProfileBrowsingLikePctMin ?? 0));
    const injectBrowsingLikePctMax    = Math.max(injectBrowsingLikePctMin, Math.min(100, fs.injectProfileBrowsingLikePctMax ?? 0));
    const injectBrowsingStoriesPctMin = Math.max(0, Math.min(100, fs.injectProfileBrowsingWatchStoriesPctMin ?? 0));
    const injectBrowsingStoriesPctMax = Math.max(injectBrowsingStoriesPctMin, Math.min(100, fs.injectProfileBrowsingWatchStoriesPctMax ?? 0));
    const injectBrowsingHighlightsPctMin = Math.max(0, Math.min(100, fs.injectProfileBrowsingViewHighlightsPctMin ?? 0));
    const injectBrowsingHighlightsPctMax = Math.max(injectBrowsingHighlightsPctMin, Math.min(100, fs.injectProfileBrowsingViewHighlightsPctMax ?? 0));
    const injectBrowsingReelsPctMin   = Math.max(0, Math.min(100, fs.injectProfileBrowsingViewReelsPctMin ?? 0));
    const injectBrowsingReelsPctMax   = Math.max(injectBrowsingReelsPctMin, Math.min(100, fs.injectProfileBrowsingViewReelsPctMax ?? 0));
    const injectBrowsingAbandon       = !!(fs.injectProfileBrowsingAbandonFollow);
    const injectBrowsingAbandonPctMin = Math.max(0, Math.min(100, fs.injectProfileBrowsingAbandonFollowPctMin ?? 10));
    const injectBrowsingAbandonPctMax = Math.max(injectBrowsingAbandonPctMin, Math.min(100, fs.injectProfileBrowsingAbandonFollowPctMax ?? 20));

    if (injectBrowsingEnabled) {
      console.log(`[engine] @${profile.username}: [EB-only] inject browsing ENABLED — beforeFollow=${injectBrowsingBeforeFollow} (${injectBrowsingBeforePctMin}-${injectBrowsingBeforePctMax}%), postFollow=${injectBrowsingPostMin}-${injectBrowsingPostMax}%`);
    } else {
      console.log(`[engine] @${profile.username}: [EB-only] inject browsing DISABLED (outer Inject Browsing checkbox is unchecked)`);
    }

    // Browses a target's profile page using ONLY the EB page — no mobile API calls,
    // so this is safe to run under Disable API mode. Assumes `page` is already on
    // (or about to be navigated to) the candidate's profile URL.
    const browseTargetProfileViaBrowser = async (label: string, candidate: { pk: string; username: string }) => {
      this.logAction(profile.id, followTool.id, "browse_profile", candidate.username, "", "profile", "ok", `[${label}] Profile browsing started`);
      this.logGhostBrowserCall(profile.id, profile.username, "browse_profile", `[${label}] Profile browsing started for @${candidate.username}`);
      console.log(`[engine] @${profile.username}: [EB-only] [${label}] browsing profile of @${candidate.username}`);

      // Make sure we're actually on the candidate's profile before doing anything.
      try {
        if (!page.url().includes(`/${candidate.username}/`)) {
          await page.goto(`https://www.instagram.com/${candidate.username}/`, { waitUntil: "domcontentloaded", timeout: 25_000 });
          await sleep(randInt(1200, 2200));
        }
        await this.waitForSelector(page, "header", 6000);
      } catch (err: any) {
        console.warn(`[engine] @${profile.username}: [EB-only] [${label}] failed to load profile: ${err?.message}`);
        this.logAction(profile.id, followTool.id, "browse_profile", candidate.username, "", "profile", "error", `Failed to load profile: ${err?.message ?? err}`);
        return;
      }

      // 1. Scroll feed — gated by chance %.
      const feedChance = randInt(injectBrowsingFeedChanceMin, injectBrowsingFeedChanceMax);
      let sawFeed = false;
      if (Math.random() * 100 < feedChance) {
        try {
          const feedCount = randInt(injectBrowsingFeedMin, injectBrowsingFeedMax);
          sawFeed = await this.waitForSelector(page, "article a, main a[href*='/p/'], main a[href*='/reel/']", 6000);
          for (let i = 0; i < feedCount && !state.stop.stopped; i++) {
            await page.evaluate(() => window.scrollBy(0, 350 + Math.random() * 250)).catch(() => {});
            await sleep(randInt(800, 1600));
          }
          this.logAction(profile.id, followTool.id, "view_user_feed", candidate.username, "", "profile", "ok", `Scrolled ${feedCount} posts`);
          this.logGhostBrowserCall(profile.id, profile.username, "view_user_feed", `EB scrolled ${feedCount} post(s) on @${candidate.username}'s profile`);
          console.log(`[engine] @${profile.username}: [EB-only] [${label}] scrolled ${feedCount} posts on @${candidate.username}'s profile (had posts: ${sawFeed})`);
        } catch (err: any) {
          console.warn(`[engine] @${profile.username}: [EB-only] [${label}] scroll feed failed: ${err?.message}`);
          this.logAction(profile.id, followTool.id, "browse_profile", candidate.username, "", "profile", "error", `viewFeed failed: ${err?.message ?? err}`);
        }
      }

      // 2. Like a post from the grid — gated by chance %.
      if (sawFeed && injectBrowsingLikePctMax > 0) {
        const likePct = randInt(injectBrowsingLikePctMin, injectBrowsingLikePctMax);
        if (Math.random() * 100 < likePct) {
          try {
            const opened = await page.evaluate(() => {
              const link = document.querySelector('main a[href*="/p/"], main a[href*="/reel/"]') as HTMLElement | null;
              if (!link) return false;
              link.click();
              return true;
            }).catch(() => false);
            if (opened) {
              await sleep(randInt(1200, 2200));
              const liked = await page.evaluate(() => {
                const heart = document.querySelector('svg[aria-label="Like"]');
                const btn = heart?.closest<HTMLElement>('[role="button"], button');
                if (!btn) return false;
                btn.click();
                return true;
              }).catch(() => false);
              await page.keyboard.press("Escape").catch(() => {});
              if (liked) {
                await storage.incrementStat(profile.id, "like").catch(() => {});
                this.logAction(profile.id, followTool.id, "like", candidate.username, "", "post", "ok", `Liked post from profile browse`);
                this.logGhostBrowserCall(profile.id, profile.username, "like", `EB liked a post from @${candidate.username}'s profile`);
                console.log(`[engine] @${profile.username}: [EB-only] [${label}] liked a post from @${candidate.username}`);
              }
            }
          } catch (err: any) {
            console.warn(`[engine] @${profile.username}: [EB-only] [${label}] like post failed: ${err?.message}`);
          }
        }
      }

      // 3. Watch stories — click the profile picture's story ring if present.
      if (injectBrowsingStoriesPctMax > 0) {
        const storiesPct = randInt(injectBrowsingStoriesPctMin, injectBrowsingStoriesPctMax);
        if (Math.random() * 100 < storiesPct) {
          try {
            const clicked = await page.evaluate(() => {
              const canvas = document.querySelector('header canvas');
              const btn = canvas?.closest<HTMLElement>('div[role="button"], button, a');
              const target = btn ?? (document.querySelector('header img[alt*="profile picture"]')?.closest<HTMLElement>('div[role="button"], a') ?? null);
              if (!target) return false;
              (target as HTMLElement).click();
              return true;
            }).catch(() => false);
            if (clicked) {
              await sleep(randInt(2000, 4000));
              const inStoryViewer = await this.waitForSelector(page, 'section[role="dialog"], div[role="dialog"]', 3000);
              if (inStoryViewer) {
                this.logAction(profile.id, followTool.id, "view_stories", candidate.username, "", "story", "ok", `Watched stories from profile browse`);
                this.logGhostBrowserCall(profile.id, profile.username, "view_stories", `EB watched stories of @${candidate.username}`);
                await storage.incrementStat(profile.id, "story").catch(() => {});
                console.log(`[engine] @${profile.username}: [EB-only] [${label}] watched stories of @${candidate.username}`);
              }
              await page.keyboard.press("Escape").catch(() => {});
              await sleep(randInt(500, 1000));
            } else {
              console.log(`[engine] @${profile.username}: [EB-only] [${label}] no story ring on @${candidate.username}'s profile — skipping`);
            }
          } catch (err: any) {
            console.warn(`[engine] @${profile.username}: [EB-only] [${label}] watch stories failed: ${err?.message}`);
            this.logAction(profile.id, followTool.id, "browse_profile", candidate.username, "", "story", "error", `watchStories failed: ${err?.message ?? err}`);
          }
        }
      }

      // 4. View highlights — click a highlight bubble (anchor to /stories/highlights/).
      if (injectBrowsingHighlightsPctMax > 0) {
        const highlightsPct = randInt(injectBrowsingHighlightsPctMin, injectBrowsingHighlightsPctMax);
        if (Math.random() * 100 < highlightsPct) {
          try {
            const clicked = await page.evaluate(() => {
              const link = document.querySelector('a[href*="/stories/highlights/"]') as HTMLElement | null;
              if (!link) return false;
              link.click();
              return true;
            }).catch(() => false);
            if (clicked) {
              await sleep(randInt(2000, 4000));
              const inViewer = await this.waitForSelector(page, 'section[role="dialog"], div[role="dialog"]', 3000);
              if (inViewer) {
                this.logAction(profile.id, followTool.id, "view_highlights", candidate.username, "", "highlight", "ok", `Viewed highlights from profile browse`);
                this.logGhostBrowserCall(profile.id, profile.username, "view_highlights", `EB viewed highlights of @${candidate.username}`);
                console.log(`[engine] @${profile.username}: [EB-only] [${label}] viewed highlights of @${candidate.username}`);
              }
              await page.keyboard.press("Escape").catch(() => {});
              await sleep(randInt(500, 1000));
            } else {
              console.log(`[engine] @${profile.username}: [EB-only] [${label}] no highlights on @${candidate.username}'s profile — skipping`);
            }
          } catch (err: any) {
            console.warn(`[engine] @${profile.username}: [EB-only] [${label}] view highlights failed: ${err?.message}`);
            this.logAction(profile.id, followTool.id, "browse_profile", candidate.username, "", "highlight", "error", `viewHighlights failed: ${err?.message ?? err}`);
          }
        }
      }

      // 5. View reels — click the profile's Reels tab (SPA route change inside
      // Instagram's own app, NOT a fresh page.goto) so the browser never does a
      // hard reload of the profile. Returns to the Posts tab the same way,
      // via an in-app link click instead of re-navigating with page.goto.
      if (injectBrowsingReelsPctMax > 0) {
        const reelsPct = randInt(injectBrowsingReelsPctMin, injectBrowsingReelsPctMax);
        if (Math.random() * 100 < reelsPct) {
          try {
            const wentToReelsTab = await page.evaluate((username: string) => {
              // Use the exact profile-specific href so we never accidentally
              // click the global Reels nav link in the left sidebar (/reels/).
              const link = document.querySelector(`a[href="/${username}/reels/"]`) as HTMLElement | null;
              if (!link) return false;
              link.click();
              return true;
            }, candidate.username).catch(() => false);
            if (wentToReelsTab) {
              await sleep(randInt(1500, 2500));
              const opened = await page.evaluate(() => {
                const link = document.querySelector('main a[href*="/reel/"]') as HTMLElement | null;
                if (!link) return false;
                link.click();
                return true;
              }).catch(() => false);
              if (opened) {
                await sleep(randInt(3000, 6000));
                await page.keyboard.press("Escape").catch(() => {});
                this.logAction(profile.id, followTool.id, "view_reels", candidate.username, "", "reel", "ok", `Viewed reels from profile browse`);
                this.logGhostBrowserCall(profile.id, profile.username, "view_reels", `EB viewed reels of @${candidate.username}`);
                console.log(`[engine] @${profile.username}: [EB-only] [${label}] viewed reels of @${candidate.username}`);
              } else {
                console.log(`[engine] @${profile.username}: [EB-only] [${label}] no reels found on @${candidate.username}'s profile — skipping`);
              }
              // Return to the Posts tab via an in-app link click (SPA route change) —
              // never a page.goto, so no hard reload of the profile happens.
              await sleep(randInt(400, 800));
              await page.evaluate((username: string) => {
                const link = (document.querySelector(`a[href="/${username}/"]`)
                  ?? document.querySelector('header a[href^="/"][href$="/"]')) as HTMLElement | null;
                if (link) link.click();
              }, candidate.username).catch(() => {});
              await sleep(randInt(800, 1500));
            } else {
              console.log(`[engine] @${profile.username}: [EB-only] [${label}] no Reels tab found on @${candidate.username}'s profile — skipping`);
            }
          } catch (err: any) {
            console.warn(`[engine] @${profile.username}: [EB-only] [${label}] view reels failed: ${err?.message}`);
            this.logAction(profile.id, followTool.id, "browse_profile", candidate.username, "", "reel", "error", `viewReels failed: ${err?.message ?? err}`);
          }
        }
      }

      console.log(`[engine] @${profile.username}: [EB-only] [${label}] finished browsing @${candidate.username}`);
    };

    if (maxPerDay > 0 && this.daily(state) >= maxPerDay) {
      console.log(`[engine] @${profile.username}: [EB-only] follow — daily limit hit`);
      return;
    }
    if (maxPerHour > 0 && this.hourly(state) >= maxPerHour) {
      console.log(`[engine] @${profile.username}: [EB-only] follow — hourly limit hit`);
      return;
    }

    // ── Overspill-first candidate selection ────────────────────────────────
    // Before hitting HikerAPI, drain any leftover candidates saved from the
    // previous session's overspill. This avoids burning HikerAPI quota when
    // there are already plenty of pre-vetted targets waiting.
    type Candidate = { pk: string; username: string; _overspillId?: number };
    let candidates: Candidate[] = [];
    let fromOverspill = false;

    const alreadyFollowed = await storage.getFollowedUsersByProfile(profile.id, 100_000);
    const followedSet = new Set(alreadyFollowed.map((u: any) => u.instagramUsername.toLowerCase()));

    const overspillRows = await storage.getOverspillUsersByProfile(profile.id).catch(() => [] as any[]);
    // Filter overspill against already-followed to keep it clean
    const validOverspill = overspillRows.filter((o: any) => !followedSet.has(o.instagramUsername.toLowerCase()));

    if (validOverspill.length > 0) {
      candidates = validOverspill.map((o: any) => ({
        pk: o.instagramUserId,
        username: o.instagramUsername,
        _overspillId: o.id,
      }));
      fromOverspill = true;
      console.log(`[engine] @${profile.username}: [EB-only] follow — draining ${candidates.length} overspill candidate(s) (skipping HikerAPI scrape)`);
    } else {
      // Overspill empty — scrape HikerAPI as normal.
      try {
        if (source.type === "hashtag") {
          const cursor = await storage.getHashtagCursor(source.value);
          const result = await hikerClient.getHashtagUsers(source.value, processCount * 3, cursor);
          candidates = result.users;
          if (result.nextCursor) await storage.setHashtagCursor(source.value, result.nextCursor).catch(() => {});
        } else if (source.type === "account") {
          const result = await hikerClient.getFollowers(source.value, processCount * 3);
          candidates = result.users;
        } else {
          console.log(`[engine] @${profile.username}: [EB-only] follow — unsupported source type: ${source.type}`);
          return;
        }
      } catch (e: any) {
        console.warn(`[engine] @${profile.username}: [EB-only] follow scrape error: ${e?.message}`);
        return;
      }

      // Dedup against already-followed users. NOTE: candidates are intentionally
      // NOT sliced to processCount here — the full scraped pool is kept as a
      // queue so that when a candidate is skipped (already following on IG,
      // private/requested, or a genuine render issue) the loop below simply
      // moves on to the next candidate instead of ending the session short.
      // This is what makes a skip get "replaced" by an actual follow whenever
      // there are more candidates left in the pool.
      candidates = candidates.filter((c: any) => !followedSet.has(c.username.toLowerCase()));
      console.log(`[engine] @${profile.username}: [EB-only] follow — ${candidates.length} candidates from ${source.type}:${source.value} (target ${processCount})`);
    }

    let followed = 0;
    let loopedCount = 0;
    const consumedOverspillIds: number[] = [];

    for (const candidate of candidates) {
      if (followed >= processCount) break;
      if (state.stop.stopped || (maxPerDay > 0 && this.daily(state) >= maxPerDay)) break;
      if (maxPerHour > 0 && this.hourly(state) >= maxPerHour) break;
      loopedCount++;
      // Track which overspill rows we've attempted so they can be pruned afterward.
      if ((candidate as any)._overspillId) consumedOverspillIds.push((candidate as any)._overspillId);
      try {
        await page.goto(`https://www.instagram.com/${candidate.username}/`, { waitUntil: "domcontentloaded", timeout: 25_000 });
        await sleep(randInt(1500, 3000));
        // Force visibilityState=visible so Instagram's SPA fully hydrates the
        // profile header even when the EB window is hidden/not shown to the
        // user. Without this, Chrome reports visibilityState="hidden" →
        // Instagram suppresses hydration of header buttons → the Follow
        // button never renders → "No Follow button found" even on accounts
        // that are not already followed/private. Same fix already applied to
        // viewTimelineFeed and likeTimelinePosts — was missing here.
        await page.evaluate(() => {
          try { Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true }); } catch {}
          try { Object.defineProperty(document, 'hidden', { get: () => false, configurable: true }); } catch {}
          document.dispatchEvent(new Event('visibilitychange'));
        }).catch(() => {});

        // Wait for the profile header buttons to hydrate before looking for
        // "Follow" — clicking immediately after navigation often finds
        // nothing because the SPA hasn't rendered the header yet.
        await this.waitForSelector(page, "header button", 6000);

        // Browse before follow — gated on the outer enable + beforeFollow toggle + its own %.
        let abandonedAfterBrowse = false;
        if (injectBrowsingEnabled && injectBrowsingBeforeFollow) {
          const beforePct = randInt(injectBrowsingBeforePctMin, injectBrowsingBeforePctMax);
          if (Math.random() * 100 < beforePct) {
            await browseTargetProfileViaBrowser("pre-follow browse", candidate);
            if (injectBrowsingAbandon) {
              const abandonPct = randInt(injectBrowsingAbandonPctMin, injectBrowsingAbandonPctMax);
              if (Math.random() * 100 < abandonPct) {
                console.log(`[engine] @${profile.username}: [EB-only] abandoned follow @${candidate.username} after profile browse (abandon chance fired)`);
                this.logAction(profile.id, followTool.id, "follow_skipped", candidate.username, source.value, source.type, "skipped", "Abandoned follow after profile browse (abandon chance)");
                abandonedAfterBrowse = true;
              }
            }
            // No re-navigation needed here — every browsing sub-step (feed scroll,
            // like, stories, highlights, reels) now stays on the profile page via
            // in-app SPA clicks and dialog Escapes, never a full page.goto. Just
            // make sure the header has re-hydrated before we look for Follow.
            if (!abandonedAfterBrowse) {
              await this.waitForSelector(page, "header button", 6000);
            }
          }
        }

        // Returns a specific reason instead of a plain boolean, so a skip can
        // be logged with the ACTUAL cause (already following on IG, a pending
        // request on a private account, or a genuine render issue) instead of
        // one ambiguous catch-all message.
        type FollowResult = { clicked: boolean; reason: "clicked" | "already_following" | "already_requested" | "private_no_button" | "not_found" };
        const result: FollowResult = abandonedAfterBrowse ? { clicked: false, reason: "not_found" } : await page.evaluate(() => {
          // Try <button> elements first — match "Follow" or "Follow Back" exactly,
          // then fall back to aria-label. Instagram changed from exact text to
          // aria-label on some page variants in 2025.
          const btns = Array.from(document.querySelectorAll("button, [role='button']"));
          // Debug: collect all visible button texts for logging
          (window as any).__ebFollowDebug = btns.slice(0, 30).map((b: any) => {
            const t = b.textContent?.trim().slice(0, 30);
            const al = b.getAttribute?.('aria-label')?.slice(0, 30) ?? '';
            return `"${t}"${al ? `[al:${al}]` : ''}`;
          }).join(' | ');
          const btn = btns.find((b: any) => {
            const text = b.textContent?.trim();
            const al = b.getAttribute?.('aria-label') ?? '';
            return text === "Follow" || text === "Follow Back"
              || al === "Follow" || al === "Follow Back";
          }) as HTMLElement | undefined;
          if (btn) {
            // scrollIntoView + full pointer event sequence — same fix as
            // likeTimelinePosts. Plain .click() on a hidden window is
            // silently swallowed; getBoundingClientRect returns zeros so
            // Chrome's hit-testing before dispatching the click can no-op.
            btn.scrollIntoView({ behavior: 'instant', block: 'center' });
            btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
            btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
            btn.click();
            return { clicked: true, reason: "clicked" };
          }
          // No "Follow"/"Follow Back" button — figure out WHY instead of
          // guessing. Instagram renders one of these instead when a relation
          // already exists: "Following" (public account you already follow —
          // usually means the app's followedUsers DB fell out of sync with
          // Instagram), or "Requested" (private account, a follow request is
          // already pending from a previous run).
          const relationBtn = btns.find((b: any) => {
            const text = b.textContent?.trim();
            const al = b.getAttribute?.('aria-label') ?? '';
            return text === "Following" || text === "Requested"
              || al === "Following" || al === "Requested";
          }) as HTMLElement | undefined;
          if (relationBtn) {
            const text = (relationBtn.textContent?.trim() || relationBtn.getAttribute('aria-label') || "");
            return { clicked: false, reason: text === "Requested" ? "already_requested" : "already_following" };
          }
          // Neither a Follow nor a relation button rendered at all — this is
          // the genuinely ambiguous case (SPA header failed to hydrate, page
          // still loading, etc). Note whether the account is private purely
          // as extra diagnostic context in the log message.
          const bodyText = document.body?.innerText || "";
          const isPrivate = /this account is private/i.test(bodyText) || !!document.querySelector('svg[aria-label="Private"]');
          return { clicked: false, reason: "not_found", isPrivate } as any;
        }).catch(() => ({ clicked: false, reason: "not_found" as const }));

        if (!result.clicked && !abandonedAfterBrowse) {
          // Dump button texts so we can see exactly what's on the profile page
          const _followDebug = await page.evaluate(() => (window as any).__ebFollowDebug ?? "n/a").catch(() => "eval failed");
          console.log(`[engine] @${profile.username}: [EB-only] follow debug @${candidate.username} — buttons: ${_followDebug}`);
        }

        if (result.clicked) {
          followed++;
          this.bump(state);
          await storage.createFollowedUser({
            profileId: profile.id,
            instagramUsername: candidate.username,
            instagramUserId: String((candidate as any).pk ?? ""),
            sourceValue: source.value,
            sourceType: source.type,
            followedAt: new Date().toISOString(),
          }).catch(() => {});
          await storage.incrementStat(profile.id, "follow").catch(() => {});
          this.logAction(profile.id, followTool.id, "follow", candidate.username, source.value, source.type, "ok", `EB followed @${candidate.username} [${followed}/${processCount}]`);
          this.logGhostBrowserCall(profile.id, profile.username, "follow", `EB followed @${candidate.username} [${followed}/${processCount}]`);
          console.log(`[engine] @${profile.username}: [EB-only] ➕ followed @${candidate.username}`);

          // Post-follow profile browsing — browse the target's profile after successfully following them.
          if (injectBrowsingEnabled) {
            const postPct = randInt(injectBrowsingPostMin, injectBrowsingPostMax);
            if (Math.random() * 100 < postPct) {
              await browseTargetProfileViaBrowser("post-follow browse", candidate);
            }
          }
        } else if (!abandonedAfterBrowse) {
          if (result.reason === "already_following") {
            // Instagram confirms this account is already followed even though
            // it wasn't in our followedUsers table — self-heal the DB record
            // now so this specific user is never re-scraped/re-attempted again.
            await storage.createFollowedUser({
              profileId: profile.id,
              instagramUsername: candidate.username,
              instagramUserId: String((candidate as any).pk ?? ""),
              sourceValue: source.value,
              sourceType: source.type,
              followedAt: new Date().toISOString(),
            }).catch(() => {});
            console.log(`[engine] @${profile.username}: [EB-only] follow — @${candidate.username} is ALREADY FOLLOWED on Instagram (DB record was missing, now reconciled) — moving to next candidate`);
            this.logAction(profile.id, followTool.id, "follow", candidate.username, source.value, source.type, "skipped", `Already following @${candidate.username} (confirmed on Instagram) — skipped, trying next candidate instead`);
            this.logGhostBrowserCall(profile.id, profile.username, "follow", `Already following @${candidate.username} — skipped`);
          } else if (result.reason === "already_requested") {
            console.log(`[engine] @${profile.username}: [EB-only] follow — @${candidate.username} already has a pending follow request (private account) — moving to next candidate`);
            this.logAction(profile.id, followTool.id, "follow", candidate.username, source.value, source.type, "skipped", `Follow request already pending for @${candidate.username} (private account) — skipped, trying next candidate instead`);
            this.logGhostBrowserCall(profile.id, profile.username, "follow", `Follow request already pending for @${candidate.username} — skipped`);
          } else {
            const privacyNote = (result as any).isPrivate ? " — account is private" : "";
            console.log(`[engine] @${profile.username}: [EB-only] follow — no Follow/Following/Requested button rendered on @${candidate.username} (likely a page render/timing issue${privacyNote}) — moving to next candidate`);
            this.logAction(profile.id, followTool.id, "follow", candidate.username, source.value, source.type, "skipped", `Follow button did not render for @${candidate.username} — page render/timing issue${privacyNote}, skipped and trying next candidate instead`);
            this.logGhostBrowserCall(profile.id, profile.username, "follow", `Follow button did not render for @${candidate.username}${privacyNote}`);
          }
        }

        await sleep(actionDelay());
      } catch (e: any) {
        console.warn(`[engine] @${profile.username}: [EB-only] follow @${candidate.username} error: ${e?.message}`);
        this.logGhostBrowserCall(profile.id, profile.username, "follow", e?.message ?? "error", true);
      }
    }

    // ── Post-loop overspill management ────────────────────────────────────────
    // 1. Delete all overspill rows we attempted in this session (whether the
    //    follow succeeded, was skipped, or errored — all are "consumed").
    if (consumedOverspillIds.length > 0) {
      await storage.deleteOverspillUsers(consumedOverspillIds).catch(() => {});
      console.log(`[engine] @${profile.username}: [EB-only] follow — pruned ${consumedOverspillIds.length} consumed overspill row(s)`);
    }

    // 2. Save candidates we never reached (processCount hit before exhausting
    //    the candidate pool) to overspill so they're tried next session.
    //    Only applies to freshly-scraped candidates — overspill rows that were
    //    never reached simply stay in the DB unchanged.
    if (!fromOverspill && loopedCount < candidates.length) {
      const unused = candidates.slice(loopedCount);
      await storage.addOverspillUsers(
        unused.map(c => ({
          profileId: profile.id,
          instagramUsername: c.username,
          instagramUserId: String((c as any).pk ?? ""),
          sourceValue: source.value,
          sourceType: source.type,
          scrapedAt: new Date().toISOString(),
        }))
      ).catch(() => {});
      console.log(`[engine] @${profile.username}: [EB-only] follow — saved ${unused.length} unused scraped candidate(s) to overspill`);
    }

    console.log(`[engine] @${profile.username}: [EB-only] follow session done — ${followed}/${candidates.length} followed`);
  }

  // ── Browser-only unfollow session (Disable API mode) ───────────────────────
  private async runBrowserUnfollowSession(
    profile: Profile,
    unfollowTool: Tool,
    page: any,
    actionDelay: () => number,
    state: ProfileState,
  ): Promise<void> {
    const us = unfollowTool.settings as any;
    const processCount = randInt(Number(us.processMin ?? 3), Number(us.processMax ?? 8));
    const maxPerDay    = randInt(Number(us.maxPerDayMin ?? 0), Number(us.maxPerDayMax ?? 0));
    const minAgeDays   = Number(us.minFollowAgeDays ?? 3);

    if (maxPerDay > 0 && this.daily(state) >= maxPerDay) {
      console.log(`[engine] @${profile.username}: [EB-only] unfollow — daily limit hit`);
      return;
    }

    const all = await storage.getFollowedUsersByProfile(profile.id, 100_000);
    const cutoff = Date.now() - minAgeDays * 86_400_000;
    const candidates = all
      .filter((u: any) => !u.unfollowedAt && new Date(u.followedAt).getTime() < cutoff)
      .slice(0, processCount);

    if (!candidates.length) {
      console.log(`[engine] @${profile.username}: [EB-only] unfollow — no candidates older than ${minAgeDays}d`);
      return;
    }
    console.log(`[engine] @${profile.username}: [EB-only] unfollow — ${candidates.length} candidates`);

    let unfollowed = 0;
    for (const fu of candidates) {
      if (state.stop.stopped || (maxPerDay > 0 && this.daily(state) >= maxPerDay)) break;
      try {
        await page.goto(`https://www.instagram.com/${fu.instagramUsername}/`, { waitUntil: "domcontentloaded", timeout: 25_000 });
        await sleep(randInt(1500, 3000));

        const clicked = await page.evaluate(async () => {
          const btns = Array.from(document.querySelectorAll("button"));
          const followingBtn = btns.find((b: any) => b.textContent?.trim() === "Following");
          if (!followingBtn) return false;
          (followingBtn as HTMLElement).click();
          await new Promise(r => setTimeout(r, 1200));
          const allBtns = Array.from(document.querySelectorAll("button"));
          const unfollowBtn = allBtns.find((b: any) => b.textContent?.trim() === "Unfollow");
          if (!unfollowBtn) return false;
          (unfollowBtn as HTMLElement).click();
          return true;
        }).catch(() => false);

        if (clicked) {
          unfollowed++;
          this.bump(state);
          await storage.incrementStat(profile.id, "unfollow").catch(() => {});
          this.logAction(profile.id, unfollowTool.id, "unfollow", fu.instagramUsername, "", "", "ok", `EB unfollowed @${fu.instagramUsername} [${unfollowed}/${processCount}]`);
          console.log(`[engine] @${profile.username}: [EB-only] ➖ unfollowed @${fu.instagramUsername}`);
        } else {
          console.log(`[engine] @${profile.username}: [EB-only] unfollow — no Following button on @${fu.instagramUsername}`);
        }

        await sleep(actionDelay());
      } catch (e: any) {
        console.warn(`[engine] @${profile.username}: [EB-only] unfollow @${fu.instagramUsername} error: ${e?.message}`);
      }
    }
    console.log(`[engine] @${profile.username}: [EB-only] unfollow session done — ${unfollowed}/${candidates.length} unfollowed`);
  }

  // ── Browser-only contact/DM session (Disable API mode) ──────────────────────
  // Mirrors runContactUsersSession but drives the embedded browser instead of
  // the mobile API — navigates to the recipient's DM thread, types the queued
  // message text, and sends via the on-screen Send button/Enter key.
  private async runBrowserContactSession(
    profile: Profile,
    contactTool: Tool,
    page: any,
    actionDelay: () => number,
    state: ProfileState,
  ): Promise<void> {
    const cs = contactTool.settings as any;
    const pending = await storage.getContactPendingMessages(profile.id, "pending");
    if (!pending.length) {
      console.log(`[engine] @${profile.username}: [EB-only] contact — no pending messages to send`);
      return;
    }

    const sendCount = randInt(Number(cs.contactUsersSendCountMin ?? 1), Number(cs.contactUsersSendCountMax ?? 5));
    const delayMin  = Number(cs.contactUsersDelayBetweenMin ?? 5) * 1000;
    const delayMax  = Number(cs.contactUsersDelayBetweenMax ?? 15) * 1000;
    const pickRandom = !!cs.contactUsersPickRandom;

    let queue = pickRandom ? [...pending].sort(() => Math.random() - 0.5) : pending;
    queue = queue.slice(0, sendCount);

    let sent = 0;
    for (const msg of queue) {
      if (state.stop.stopped) break;
      try {
        await page.goto(`https://www.instagram.com/direct/t/${msg.instagramUserId || msg.instagramUsername}/`, { waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => {});
        await sleep(randInt(1500, 3000));
        // Fall back to opening a new thread by username if navigating straight
        // to a thread ID failed (e.g. no existing thread with this user yet).
        const hasComposer = await this.waitForSelector(page, 'div[role="textbox"], textarea[placeholder="Message..."]', 6000);
        if (!hasComposer) {
          await page.goto("https://www.instagram.com/direct/new/", { waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => {});
          await sleep(randInt(1200, 2200));
          const typedRecipient: boolean = await page.evaluate((username: string) => {
            const input = document.querySelector('input[name="queryBox"], input[placeholder="Search..."]') as HTMLInputElement | null;
            if (!input) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
            setter?.call(input, username);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
          }, msg.instagramUsername).catch(() => false);
          if (!typedRecipient) throw new Error("could not find recipient search box");
          await sleep(1800);
          const pickedRecipient: boolean = await page.evaluate((username: string) => {
            const rows = Array.from(document.querySelectorAll('div[role="button"]'));
            const row = rows.find((r: any) => r.textContent?.toLowerCase().includes(username.toLowerCase()));
            if (!row) return false;
            (row as HTMLElement).click();
            return true;
          }, msg.instagramUsername).catch(() => false);
          if (!pickedRecipient) throw new Error(`recipient @${msg.instagramUsername} not found in search results`);
          await sleep(800);
          await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll("button"));
            const next = btns.find((b: any) => b.textContent?.trim() === "Next" || b.textContent?.trim() === "Chat");
            (next as HTMLElement | undefined)?.click();
          }).catch(() => {});
          await sleep(1200);
        }

        await this.waitForSelector(page, 'div[role="textbox"], textarea[placeholder="Message..."]', 8000);
        const typed: boolean = await page.evaluate((text: string) => {
          const box = document.querySelector('div[role="textbox"]') as HTMLElement | null;
          if (box) {
            box.focus();
            document.execCommand("insertText", false, text);
            return true;
          }
          const textarea = document.querySelector('textarea[placeholder="Message..."]') as HTMLTextAreaElement | null;
          if (textarea) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
            setter?.call(textarea, text);
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
          }
          return false;
        }, msg.messageText).catch(() => false);

        if (!typed) throw new Error("could not find message composer box");
        await sleep(randInt(600, 1200));
        await page.keyboard.press("Enter").catch(() => {});
        await sleep(randInt(1000, 2000));

        sent++;
        const sentAt = new Date().toISOString();
        await storage.updateContactPendingMessage(msg.id, { status: "sent", sentAt });
        await storage.createContactDmSent({
          profileId: profile.id,
          instagramUsername: msg.instagramUsername,
          instagramUserId: msg.instagramUserId,
          sentAt,
          messagePreview: msg.messageText.slice(0, 100),
        }).catch(() => {});
        await storage.incrementStat(profile.id, "dm").catch(() => {});
        this.logAction(profile.id, contactTool.id, "contact_dm", msg.instagramUsername, "", "", "ok", `EB contact DM sent to @${msg.instagramUsername} [${sent}/${queue.length}]`);
        this.logGhostBrowserCall(profile.id, profile.username, "contact_dm", `EB contact DM sent to @${msg.instagramUsername} [${sent}/${queue.length}]`);
        console.log(`[engine] @${profile.username}: [EB-only] 📩 contact DM sent to @${msg.instagramUsername}`);
        if (sent < queue.length) await sleep(randInt(delayMin, delayMax));
      } catch (e: any) {
        console.warn(`[engine] @${profile.username}: [EB-only] contact DM to @${msg.instagramUsername} error: ${e?.message}`);
        this.logAction(profile.id, contactTool.id, "contact_dm", msg.instagramUsername, "", "", "error", `EB DM send failed: ${e?.message ?? "unknown"} (will retry)`);
        this.logGhostBrowserCall(profile.id, profile.username, "contact_dm", e?.message ?? "error", true);
      }
    }
    console.log(`[engine] @${profile.username}: [EB-only] contact session done — ${sent}/${queue.length} sent`);
  }

  private async runHumanSessionTools(profile: Profile, tool: Tool, state: ProfileState): Promise<void> {
    const s = tool.settings as any;
    const disableApi = (profile.apiLimits as any)?.disableApi === true;
    const client = await this.ensureClient(profile, state);
    if (!client) {
      if (disableApi) {
        await this.runBrowserOnlyHumanSession(profile, tool, state);
      } else {
        this.logAction(profile.id, tool.id, "session_skipped", "", "", "", "warn",
          "Human Session skipped — no Instagram session found. Run Verify Credentials to establish one.");
      }
      return;
    }

    // Shared account-level error detector for every action in this session.
    // If Instagram returns login_required / checkpoint / banned / etc., we
    // immediately update the DB status, null the client, log it, and signal
    // the queue to stop. Returns true = halt session, false = transient error.
    let sessionError: string | null = null;
    const checkSessionErr = async (e: any, actionLabel: string): Promise<boolean> => {
      const msg = e?.message ?? "";
      const acctStatus = await this.applyAccountLevelError(profile.id, msg, state, tool.id);
      if (acctStatus) {
        console.warn(`[engine] @${profile.username}: ${actionLabel} — account-level error (${acctStatus}): ${msg}`);
        this.logAction(profile.id, tool.id, "session_error", "", "", "", "error", `[${acctStatus}] ${msg}`);
        sessionError = acctStatus;
        return true;
      }
      return false;
    };

    // ── Force Emulation — always runs FIRST if enabled ───────────────────────
    if (!!s.forceEmulationEnabled) {
      const feChanceMin = Math.min(100, Math.max(0, Number((s as any).forceEmulationChanceMin ?? 100)));
      const feChanceMax = Math.min(100, Math.max(feChanceMin, Number((s as any).forceEmulationChanceMax ?? 100)));
      const feChance = feChanceMin + Math.random() * (feChanceMax - feChanceMin);
      if (Math.random() * 100 < feChance) {
        client.setApiCallSource("Human Session Emulation");
        try {
          await client.runForceEmulation(s.forceEmulationRandomise === true);
          console.log(`[engine] @${profile.username}: 📱 force emulation calls complete`);
          this.logAction(profile.id, tool.id, "force_emulation", "", "", "", "ok", "Force emulation API calls fired");
        } catch (e: any) {
          if (await checkSessionErr(e, "force_emulation")) return;
          console.warn(`[engine] @${profile.username}: force emulation error: ${e?.message}`);
        }
      } else {
        console.log(`[engine] @${profile.username}: 📱 force emulation skipped (chance roll: ${feChance.toFixed(1)}%)`);
      }
    }

    // Build the ordered action queue.
    // Each entry: { order: number (random from OrderMin/Max), run: async fn }
    // Actions are sorted descending by order before executing, so higher numbers
    // run first. Ties preserve insertion order (stable sort).
    // Actions that are disabled or skipped by the NotUsed chance are excluded.
    type QueueEntry = { order: number; label: string; run: () => Promise<void> };
    const queue: QueueEntry[] = [];

    // helper — add action to queue if enabled and not skipped by chance
    const enqueue = (
      label: string,
      enabled: boolean,
      notUsedMinKey: string, notUsedMaxKey: string,
      orderMinKey: string,   orderMaxKey: string,
      fn: () => Promise<void>,
    ) => {
      if (!enabled) {
        console.log(`[engine] @${profile.username}: HS queue — ${label} skipped (disabled)`);
        return;
      }
      if (this.shouldSkipDueToChance(s, notUsedMinKey, notUsedMaxKey)) {
        console.log(`[engine] @${profile.username}: HS queue — ${label} skipped (chance roll)`);
        return;
      }
      const order = randInt(Number(s[orderMinKey] ?? 0), Number(s[orderMaxKey] ?? 0));
      queue.push({ order, label, run: fn });
    };

    // ── Human Session ────────────────────────────────────────────────────────
    enqueue("humanSession",
      s.humanSessionEnabled === true && (s as any).emulationGroupEnabled !== false,
      "humanSessionNotUsedMin", "humanSessionNotUsedMax",
      "humanSessionOrderMin",   "humanSessionOrderMax",
      async () => {
        // Per-action run chance range (0=never, 100=always). Picks a random threshold between min/max each session.
        const willRun = (minKey: string, maxKey: string) => {
          const lo = Number((s as any)[minKey] ?? 100);
          const hi = Number((s as any)[maxKey] ?? 100);
          const threshold = randInt(Math.min(lo, hi), Math.max(lo, hi));
          return Math.random() * 100 < threshold;
        };

        // Opens the ≡ More hamburger menu and clicks a named item.
        // Uses the EB page directly — page is in scope via closure.
        const clickHamburgerItem = async (itemText: string): Promise<boolean> => {
          await nav("https://www.instagram.com/", "home (jitter-menu)");
          await sleep(randInt(1500, 2500));
          const moreClicked = await page.evaluate(() => {
            const btn =
              document.querySelector<HTMLElement>('svg[aria-label="More"]')
                ?.closest<HTMLElement>('[role="link"],a,[role="button"],div[tabindex]')
              ?? Array.from(document.querySelectorAll<HTMLElement>('span,div'))
                   .find(el => el.textContent?.trim() === 'More')
                   ?.closest<HTMLElement>('[role="link"],a,[role="button"],div[tabindex]');
            if (!btn) return false;
            btn.scrollIntoView({ block: 'center', behavior: 'instant' });
            btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
            btn.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, cancelable: true }));
            btn.click();
            return true;
          }).catch(() => false);
          if (!moreClicked) return false;
          await sleep(randInt(700, 1200));
          const itemClicked = await page.evaluate((text: string) => {
            // Find the menu item by exact text content.
            // Do NOT use offsetParent/getBoundingClientRect checks — these return
            // null/zero in a hidden Electron BrowserWindow even when the element is
            // fully rendered, which would cause every menu click to silently no-op.
            // Priority order: prefer [role="menuitem"] containers (the wrapping
            // div/li), then fall back to any visible span matching the text.
            const byRole = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
              .find(el => el.textContent?.trim() === text);
            const bySpan = Array.from(document.querySelectorAll<HTMLElement>('span,li'))
              .find(el => el.textContent?.trim() === text);
            const target = byRole ?? bySpan;
            if (!target) return false;
            target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
            target.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, cancelable: true }));
            target.click();
            return true;
          }, itemText).catch(() => false);
          await sleep(randInt(1000, 2000));
          return itemClicked;
        };

        // ── Notifications — click the heart/bell icon in the left sidebar ─────
        if (willRun("notificationsRunChanceMin", "notificationsRunChanceMax")) {
          try {
            await nav("https://www.instagram.com/", "home (notifications)");
            await sleep(randInt(1200, 2000));
            const clicked = await page.evaluate(() => {
              const btn =
                document.querySelector<HTMLElement>('svg[aria-label="Notifications"]')
                  ?.closest<HTMLElement>('[role="link"],a,[role="button"]')
                ?? document.querySelector<HTMLElement>('a[href*="/accounts/activity"]')
                ?? Array.from(document.querySelectorAll<HTMLElement>('[role="link"],a'))
                     .find(el => el.textContent?.trim() === 'Notifications');
              if (!btn) return false;
              btn.scrollIntoView({ block: 'center', behavior: 'instant' });
              btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
              btn.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, cancelable: true }));
              btn.click();
              return true;
            }).catch(() => false);
            await sleep(actionDelay());
            console.log(`[engine] @${profile.username}: 🔔 EB tapped notifications icon (${clicked ? 'ok' : 'btn not found'})`);
            this.logAction(profile.id, tool.id, "visit_notifications", "", "", "", "ok", "EB: tapped notifications icon");
            this.logGhostBrowserCall(profile.id, profile.username, "visit_notifications", "EB: tapped notifications icon");
          } catch (e: any) {
            console.warn(`[engine] @${profile.username}: notifications EB error: ${e?.message}`);
          }
        }

        // ── Own Profile — navigate to own profile page ─────────────────────────
        if (willRun("ownProfileRunChanceMin", "ownProfileRunChanceMax")) {
          try {
            await nav(`https://www.instagram.com/${profile.username}/`, "own profile (jitter)");
            await sleep(actionDelay());
            console.log(`[engine] @${profile.username}: 👤 EB visited own profile`);
            this.logAction(profile.id, tool.id, "visit_own_profile", "", "", "", "ok", "EB: visited own profile page");
            this.logGhostBrowserCall(profile.id, profile.username, "visit_own_profile", "EB: visited own profile page");
          } catch (e: any) {
            console.warn(`[engine] @${profile.username}: own profile EB error: ${e?.message}`);
          }
        }

        // ── Settings — hamburger → Settings ───────────────────────────────────
        if (willRun("settingsActivityRunChanceMin", "settingsActivityRunChanceMax")) {
          try {
            const ok = await clickHamburgerItem("Settings");
            console.log(`[engine] @${profile.username}: ⚙️ EB opened Settings via menu (${ok ? 'ok' : 'btn not found'})`);
            this.logAction(profile.id, tool.id, "visit_settings", "", "", "", ok ? "ok" : "skipped", "EB: opened Settings via hamburger menu");
            this.logGhostBrowserCall(profile.id, profile.username, "visit_settings", "EB: opened Settings via hamburger menu");
          } catch (e: any) {
            console.warn(`[engine] @${profile.username}: settings EB error: ${e?.message}`);
          }
        }

        // ── View Activity — hamburger → Your activity ──────────────────────────
        if (willRun("viewActivityRunChanceMin", "viewActivityRunChanceMax")) {
          try {
            const ok = await clickHamburgerItem("Your activity");
            console.log(`[engine] @${profile.username}: 📊 EB opened Your Activity via menu (${ok ? 'ok' : 'btn not found'})`);
            this.logAction(profile.id, tool.id, "view_activity", "", "", "", ok ? "ok" : "skipped", "EB: opened Your Activity via hamburger menu");
            this.logGhostBrowserCall(profile.id, profile.username, "view_activity", "EB: opened Your Activity via hamburger menu");
          } catch (e: any) {
            console.warn(`[engine] @${profile.username}: activity EB error: ${e?.message}`);
          }
        }

        // ── View Saved — hamburger → Saved ─────────────────────────────────────
        if (willRun("viewSavedRunChanceMin", "viewSavedRunChanceMax")) {
          try {
            const ok = await clickHamburgerItem("Saved");
            console.log(`[engine] @${profile.username}: 🔖 EB opened Saved via menu (${ok ? 'ok' : 'btn not found'})`);
            this.logAction(profile.id, tool.id, "view_saved", "", "", "", ok ? "ok" : "skipped", "EB: opened Saved via hamburger menu");
            this.logGhostBrowserCall(profile.id, profile.username, "view_saved", "EB: opened Saved via hamburger menu");
          } catch (e: any) {
            console.warn(`[engine] @${profile.username}: saved EB error: ${e?.message}`);
          }
        }
      },
    );

    // ── View Timeline Feed ───────────────────────────────────────────────────
    enqueue("viewTimelineFeed",
      s.viewTimelineFeedEnabled === true && (s as any).emulationGroupEnabled !== false,
      "viewTimelineFeedNotUsedMin", "viewTimelineFeedNotUsedMax",
      "viewTimelineFeedOrderMin",   "viewTimelineFeedOrderMax",
      async () => {
        client.setApiCallSource("Human Session Emulation");
        const feedCount = randInt(s.viewTimelineFeedMin ?? 3, s.viewTimelineFeedMax ?? 8);
        // Reel-watching is now its own independent "View Reels" tool (see the
        // separate enqueue("viewReels", ...) block below) with its own
        // enabled/order/chance settings — it is no longer nested inside this
        // View Timeline Feed call. Pass 0/0 so viewTimelineFeed never watches
        // reels itself, avoiding double-counting.
        let viewed = 0;
        let vtfResult: Awaited<ReturnType<typeof client.viewTimelineFeed>> | null = null;
        try {
          vtfResult = await client.viewTimelineFeed(
            feedCount, 0, 0, 0, 0,
            false,
            (type, count) => {
              if (type === "feed_load") {
                this.logAction(profile.id, tool.id, "feed_timeline_load", "", "", "", "ok", `Loading ${count} post${count === 1 ? "" : "s"} from timeline`);
              } else if (type === "feed_seen") {
                this.logAction(profile.id, tool.id, "feed_timeline_seen", "", "", "", "ok", `Marked ${count} post${count === 1 ? "" : "s"} as seen`);
              }
            },
          );
          if (vtfResult.sessionExpired) {
            const expReason = vtfResult.reason ?? "session expired (login_required) — viewTimelineFeed";
            console.warn(`[engine] @${profile.username}: viewTimelineFeed — session expired, marking logged_out`);
            await storage.updateProfile(profile.id, { accountStatus: "logged_out", statusMessage: expReason });
            this.logAction(profile.id, tool.id, "logged_out", "", "", "", "error", expReason);
            state.client = null;
            // Do NOT set sessionError here — the DM check uses the mobile API (igApiCookies)
            // independently of the web session and may still succeed even when the web session
            // has expired. Only checkSessionErr (mobile-API-level errors) should break the queue.
            return;
          }
          viewed = vtfResult.viewed;
          console.log(`[engine] @${profile.username}: 📰 viewed ${viewed} timeline post(s)`);
          this.logAction(profile.id, tool.id, "view_timeline_feed", "", "", "", "ok", `Viewed ${viewed} timeline post${viewed === 1 ? "" : "s"}`);

          // Log each reel actually watched (ClipsViewed fired) to the session log
          if (vtfResult.reelWatches?.length) {
            for (const reel of vtfResult.reelWatches) {
              console.log(`[engine] @${profile.username}: 🎬 watched reel @${reel.username || "unknown"} at ${reel.pct}% (${reel.durationSec}s)`);
              this.logAction(profile.id, tool.id, "view_reel_from_feed", reel.username, reel.shortcode, "post", "ok", `Watched reel at ${reel.pct}% · ${reel.durationSec}s`);
            }
          }

        } catch (e: any) {
          if (await checkSessionErr(e, "view_timeline_feed")) return;
          console.warn(`[engine] @${profile.username}: timeline feed error: ${e?.message}`);
        }

        // ── Like a % of viewed posts ─────────────────────────────────────────
        const likePctMin = Number(s.likeTimelinePostsPercentMin ?? 0);
        const likePctMax = Number(s.likeTimelinePostsPercentMax ?? 0);
        if (viewed > 0 && likePctMax > 0) {
          const pct = randInt(likePctMin, likePctMax);
          const exactCount = viewed * pct / 100;
          // Stochastic rounding: e.g. 5% of 5 posts = 0.25 → like 1 post 25% of the time, 0 posts 75% of the time
          const likeCount = Math.floor(exactCount) + (Math.random() < (exactCount % 1) ? 1 : 0);
          if (likeCount <= 0) {
            console.log(`[engine] @${profile.username}: ⏭ like% rolled 0 this session (${pct}% of ${viewed} viewed posts = ${exactCount.toFixed(2)}) — skipping likes`);
          } else {
          console.log(`[engine] @${profile.username}: ▶ INLINE LIKE% FIRED from viewTimelineFeed (${pct}% of ${viewed} viewed = ${likeCount} post(s)). This is the source of any likes logged below.`);
          const likeDelayMin = Number(s.likeTimelinePostsDelayMin ?? 3);
          const likeDelayMax = Number(s.likeTimelinePostsDelayMax ?? 8);
          try {
            const { liked, watched, likedPosts, sessionExpired, sessionExpiredReason } = await client.likeTimelinePosts(likeCount, likeDelayMin, likeDelayMax, reelWatchPctMin, effectiveReelPctMax);
            if (sessionExpired) {
              const expReason = sessionExpiredReason ?? "session expired (login_required) — likeTimelinePosts";
              console.warn(`[engine] @${profile.username}: likeTimelinePosts (from viewTimeline) — session expired, marking logged_out`);
              await storage.updateProfile(profile.id, { accountStatus: "logged_out", statusMessage: expReason });
              this.logAction(profile.id, tool.id, "logged_out", "", "", "", "error", expReason);
              state.client = null;
              // Do NOT set sessionError — allow DM check (mobile API) to continue.
              return;
            }
            const summary = watched > 0
              ? `Liked ${liked} post(s) from timeline (watched ${watched} reel(s) before liking)`
              : `Liked ${liked} post(s) from timeline`;
            for (let _i = 0; _i < liked; _i++) await storage.incrementStat(profile.id, "like");
            console.log(`[engine] @${profile.username}: ❤️ ${summary}`);
            if (likedPosts.length > 0) {
              for (const post of likedPosts) {
                this.logAction(profile.id, tool.id, "like_timeline_post", post.ownerUsername, post.shortcode, "post", "ok", "Liked timeline post");
              }
            } else {
              this.logAction(profile.id, tool.id, "like_timeline_post", "", "", "", "ok", summary);
            }
            // Save media from liked posts at the configured percentage
            const saveEnabled = !!s.saveMediaEnabled;
            const savePct = Number(s.saveMediaPercent ?? 0);
            if (saveEnabled && savePct > 0 && likedPosts.length > 0) {
              for (const post of likedPosts) {
                if (!post.mediaId) continue;
                if (Math.random() * 100 < savePct) {
                  try {
                    await client.saveMedia(post.mediaId);
                    console.log(`[engine] @${profile.username}: 🔖 saved post ${post.shortcode} by @${post.ownerUsername}`);
                    this.logAction(profile.id, tool.id, "save_media", post.ownerUsername, post.shortcode, "post", "ok", "Saved liked timeline post");
                  } catch (se: any) {
                    console.warn(`[engine] @${profile.username}: save media error: ${se?.message}`);
                  }
                }
              }
            }
          } catch (e: any) {
            if (await checkSessionErr(e, "like_timeline_posts")) return;
            console.warn(`[engine] @${profile.username}: like timeline posts error: ${e?.message}`);
          }
          } // end likeCount > 0
        }

        // ── Share a % of viewed feed posts to the user's feed ────────────────
        // Simulates pressing the two-arrow share/repost button on posts while
        // scrolling the timeline — shares them to followers in the home feed.
        const sharePctMin = Number(s.sharePostPercentMin ?? 0);
        const sharePctMax = Number(s.sharePostPercentMax ?? 0);
        if (sharePctMax > 0 && vtfResult?.items && vtfResult.items.length > 0) {
          for (const item of vtfResult.items) {
            if (!item.mediaId) continue;
            const shareRoll = Math.random() * 100;
            const shareThreshold = randInt(sharePctMin, sharePctMax);
            if (shareRoll >= shareThreshold) continue;
            try {
              const shared = await client.sharePostToFeed(item.mediaId);
              if (shared) {
                console.log(`[engine] @${profile.username}: 🔁 shared post ${item.shortcode} by @${item.username} to feed`);
                this.logAction(profile.id, tool.id, "share_post", item.username, item.shortcode, "post", "ok", "Shared timeline post to feed");
              }
            } catch (se: any) {
              if (await checkSessionErr(se, "share_post")) return;
              console.warn(`[engine] @${profile.username}: share post error: ${se?.message}`);
            }
          }
        }

        // ── Visit a % of viewed feed posts' author profiles ──────────────────
        // Simulates a user tapping straight into an author's profile from the
        // feed (no intermediate "open the post" step — Instagram's UI lets you
        // tap a username/avatar directly from the timeline without opening the
        // post first). Each visited profile can then cascade into: scroll their
        // feed → open individual posts from that feed.
        const vpPctMin0 = Number(s.viewPostProfilePercentMin ?? 0);
        const vpPctMax0 = Number(s.viewPostProfilePercentMax ?? 0);
        if (viewed > 0 && vpPctMax0 > 0 && vtfResult?.items && vtfResult.items.length > 0) {
          const vpPct        = randInt(vpPctMin0, vpPctMax0);
          const exactVisit   = vtfResult.items.length * vpPct / 100;
          const visitCount   = Math.floor(exactVisit) + (Math.random() < (exactVisit % 1) ? 1 : 0);
          if (visitCount > 0) {
            const toVisit = [...vtfResult.items].filter(it => it.userId).sort(() => 0.5 - Math.random()).slice(0, visitCount);
            for (const item of toVisit) {
              // ── Visit the post author's profile ────────────────────────────
              {
                try {
                  // "feed_timeline" — navigating to a profile by tapping a username in the home feed
                  await client.visitUserProfile(item.userId, "feed_timeline");
                  console.log(`[engine] @${profile.username}: 👤 visited profile of @${item.username}`);
                  this.logAction(profile.id, tool.id, "visit_profile", item.username, "", "profile", "ok", `Visited @${item.username}'s profile`);
                } catch (e: any) {
                  if (await checkSessionErr(e, "visit_profile")) return;
                  console.warn(`[engine] @${profile.username}: visit profile error: ${e?.message}`);
                  continue;
                }

                // ── Scroll through the profile's post feed ──────────────────
                const vfPctMin = Number(s.viewProfileFeedPercentMin ?? 0);
                const vfPctMax = Number(s.viewProfileFeedPercentMax ?? 0);
                if (vfPctMax > 0) {
                  const vfPct = randInt(vfPctMin, vfPctMax);
                  if (Math.random() * 100 < vfPct) {
                    const profileFeedCount = randInt(
                      s.viewProfileFeedCountMin ?? 3,
                      s.viewProfileFeedCountMax ?? 8,
                    );
                    let profilePosts: Array<{ mediaId: string; shortcode: string; username: string }> = [];
                    try {
                      profilePosts = useHikerHumanSessionFeed
                        ? await hikerClient!.getUserFeedByUserId(item.userId, profileFeedCount)
                        : await client.viewUserFeed(item.userId, profileFeedCount);
                      console.log(`[engine] @${profile.username}: 📋 scrolled ${profilePosts.length} post(s) on @${item.username}'s profile${useHikerHumanSessionFeed ? " [HikerAPI]" : ""}`);
                      this.logAction(profile.id, tool.id, "view_profile_feed", item.username, "", "profile", "ok", `Scrolled ${profilePosts.length} post(s) on @${item.username}'s profile`);
                    } catch (e: any) {
                      if (await checkSessionErr(e, "view_profile_feed")) return;
                      console.warn(`[engine] @${profile.username}: view profile feed error: ${e?.message}`);
                    }

                    // ── Open individual posts from the profile feed ───────────
                    const vpPostPctMin = Number(s.viewProfilePostsPercentMin ?? 0);
                    const vpPostPctMax = Number(s.viewProfilePostsPercentMax ?? 0);
                    if (vpPostPctMax > 0 && profilePosts.length > 0) {
                      const postViewMax  = randInt(s.viewProfilePostsCountMin ?? 1, s.viewProfilePostsCountMax ?? 3);
                      const postViewPct  = randInt(vpPostPctMin, vpPostPctMax);
                      let postsOpened = 0;
                      for (const profilePost of profilePosts) {
                        if (postsOpened >= postViewMax) break;
                        if (Math.random() * 100 >= postViewPct) continue;
                        try {
                          await client.viewFeedPost(profilePost.mediaId);
                          console.log(`[engine] @${profile.username}: 🖼 opened post ${profilePost.shortcode} from @${item.username}'s profile`);
                          this.logAction(profile.id, tool.id, "view_profile_post", item.username, profilePost.shortcode, "post", "ok", `Opened post from @${item.username}'s profile`);
                          postsOpened++;
                        } catch (e: any) {
                          if (await checkSessionErr(e, "view_profile_post")) return;
                          console.warn(`[engine] @${profile.username}: view profile post error: ${e?.message}`);
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
    );

    // ── View Reels ───────────────────────────────────────────────────────────
    // Independent tool with its own enabled/order/chance settings — decoupled
    // from View Timeline Feed. Fetches its own timeline page(s) and watches
    // only the reels found, ignoring regular feed posts.
    enqueue("viewReels",
      s.viewReelsEnabled === true && (s as any).emulationGroupEnabled !== false,
      "viewReelsNotUsedMin", "viewReelsNotUsedMax",
      "viewReelsOrderMin",   "viewReelsOrderMax",
      async () => {
        client.setApiCallSource("Human Session Emulation");
        // "Chance%" (reelWatchChanceMin/Max) is shared with the EB-only path —
        // it's a separate roll from the "Skip Chance %" (viewReelsNotUsedMin/Max)
        // that `enqueue` already applied above. Normalize bounds, swap if inverted.
        const reelChanceRaw0 = Math.min(100, Math.max(0, Number(s.reelWatchChanceMin ?? 100)));
        const reelChanceRaw1 = Math.min(100, Math.max(0, Number(s.reelWatchChanceMax ?? 100)));
        const reelChanceMin = Math.min(reelChanceRaw0, reelChanceRaw1);
        const reelChanceMax = Math.max(reelChanceRaw0, reelChanceRaw1);
        const reelChance = reelChanceMin + Math.random() * (reelChanceMax - reelChanceMin);
        if (Math.random() * 100 >= reelChance) {
          console.log(`[engine] @${profile.username}: 🎬 View Reels — Chance% roll missed, skipping`);
          return;
        }
        const reelCount = randInt(Number(s.reelWatchCountMin ?? 1), Number(s.reelWatchCountMax ?? 3));
        if (reelCount <= 0) {
          console.log(`[engine] @${profile.username}: 🎬 View Reels — reel count rolled 0, skipping`);
          return;
        }
        const reelViewPctMin = Number(s.reelWatchPercentMin ?? 50);
        const reelViewPctMax = Number(s.reelWatchPercentMax ?? 100);
        try {
          const result = await client.viewReelsFromFeed(reelCount, reelViewPctMin, reelViewPctMax);
          if (result.sessionExpired) {
            const expReason = result.reason ?? "session expired (login_required) — viewReels";
            console.warn(`[engine] @${profile.username}: viewReels — session expired, marking logged_out`);
            await storage.updateProfile(profile.id, { accountStatus: "logged_out", statusMessage: expReason });
            this.logAction(profile.id, tool.id, "logged_out", "", "", "", "error", expReason);
            state.client = null;
            return;
          }
          console.log(`[engine] @${profile.username}: 🎬 watched ${result.watched} reel(s)`);
          if (result.watched > 0) {
            this.logAction(profile.id, tool.id, "view_reels", "", "", "", "ok", `Watched ${result.watched} reel(s)`);
          } else {
            this.logAction(profile.id, tool.id, "view_reels", "", "", "", "skipped", "No reels found in timeline this pass");
          }
          for (const reel of result.reelWatches) {
            this.logAction(profile.id, tool.id, "view_reel_from_feed", reel.username, reel.shortcode, "post", "ok", `Watched reel at ${reel.pct}% · ${reel.durationSec}s`);
          }
        } catch (e: any) {
          if (await checkSessionErr(e, "view_reels")) return;
          console.warn(`[engine] @${profile.username}: view reels error: ${e?.message}`);
        }
      },
    );

    // ── Watch Timeline Stories ───────────────────────────────────────────────
    enqueue("checkTimelineStories",
      s.checkTimelineStoriesEnabled === true && (s as any).emulationGroupEnabled !== false,
      "checkTimelineStoriesNotUsedMin", "checkTimelineStoriesNotUsedMax",
      "checkTimelineStoriesOrderMin",   "checkTimelineStoriesOrderMax",
      async () => {
        client.setApiCallSource("Human Session Emulation");
        const storyCount = randInt(s.checkTimelineStoriesMin ?? 3, s.checkTimelineStoriesMax ?? 8);
        try {
          const storyResult = await client.viewTimelineStories(storyCount);
          const watched = storyResult.count;
          const storyItems = storyResult.items;
          if (watched === -1) {
            console.warn(`[engine] @${profile.username}: ⚠️ View Stories skipped — no igApiCookies session (account not yet verified — run Verify Credentials first)`);
            this.logAction(profile.id, tool.id, "check_timeline_stories", "", "", "", "warn", "Skipped: no igApiCookies session (run Verify Credentials to establish one)");
          } else if (watched === -5) {
            console.warn(`[engine] @${profile.username}: ⚠️ View Stories — Instagram rejected reels_tray (challenge/session error) — marking account`);
            const acctStatus = await this.applyAccountLevelError(profile.id, "challenge_required", state, tool.id);
            this.logAction(profile.id, tool.id, "check_timeline_stories", "", "", "", "error", `Instagram rejected reels_tray: challenge_required${acctStatus ? `: account marked ${acctStatus}` : ""}`);
          } else if (watched === -2) {
            console.warn(`[engine] @${profile.username}: ⚠️ View Stories: tray was empty (0 stories in feed) — see server log for response keys`);
            this.logAction(profile.id, tool.id, "check_timeline_stories", "", "", "", "warn", "0 stories in feed the tray is empty");
          } else if (watched === -3) {
            console.warn(`[engine] @${profile.username}: ⚠️ View Stories: tray had entries but none contained story items — see server log for entry keys`);
            this.logAction(profile.id, tool.id, "check_timeline_stories", "", "", "", "warn", "View Stories: tray returned but no story items found in entries (check server log for details)");
          } else {
            console.log(`[engine] @${profile.username}: 📖 watched ${watched} timeline stories`);
            this.logAction(profile.id, tool.id, "check_timeline_stories", "", "", "", "ok", `Watched ${watched} timeline stories`);
            for (let _i = 0; _i < watched; _i++) await storage.incrementStat(profile.id, "story");

            // ── Story slide likes ─────────────────────────────────────────
            const storyLikePctMin = Number(s.storyLikePctMin ?? 0);
            const storyLikePctMax = Number(s.storyLikePctMax ?? 0);
            if (storyLikePctMax > 0 && storyItems.length > 0) {
              const pct = randInt(storyLikePctMin, storyLikePctMax);
              const exactCount = storyItems.length * pct / 100;
              const likeCount = Math.floor(exactCount) + (Math.random() < (exactCount % 1) ? 1 : 0);
              if (likeCount > 0) {
                const shuffled = [...storyItems].sort(() => Math.random() - 0.5);
                for (const item of shuffled.slice(0, likeCount)) {
                  try {
                    const result = await client.likeMedia(item.mediaId);
                    if (result && result !== "blocked") {
                      console.log(`[engine] @${profile.username}: ❤️ liked story slide ${item.mediaId}`);
                      this.logAction(profile.id, tool.id, "like_story_slide", "", item.mediaId, "story", "ok", "Liked story slide");
                    } else if (result === "blocked") {
                      console.warn(`[engine] @${profile.username}: ⚠️ story like blocked`);
                    }
                  } catch (e: any) {
                    console.warn(`[engine] @${profile.username}: story like error: ${e?.message}`);
                  }
                }
              } else {
                console.log(`[engine] @${profile.username}: ⏭ story like% rolled 0 (${pct}% of ${storyItems.length} slides)`);
              }
            }

            // ── Story slide shares via DM ─────────────────────────────────
            const storySharePctMin = Number(s.storySharePctMin ?? 0);
            const storySharePctMax = Number(s.storySharePctMax ?? 0);
            if (storySharePctMax > 0 && storyItems.length > 0) {
              const pct = randInt(storySharePctMin, storySharePctMax);
              const exactCount = storyItems.length * pct / 100;
              const shareCount = Math.floor(exactCount) + (Math.random() < (exactCount % 1) ? 1 : 0);
              if (shareCount > 0) {
                const shuffled = [...storyItems].sort(() => Math.random() - 0.5);
                for (const item of shuffled.slice(0, shareCount)) {
                  try {
                    const ok = await client.shareStoryViaDm(item.mediaId, item.userId);
                    if (ok) {
                      console.log(`[engine] @${profile.username}: 📤 shared story slide ${item.mediaId} via DM`);
                      this.logAction(profile.id, tool.id, "share_story_via_dm", "", item.mediaId, "story", "ok", "Shared story slide via DM");
                    }
                  } catch (e: any) {
                    console.warn(`[engine] @${profile.username}: story share error: ${e?.message}`);
                  }
                }
              } else {
                console.log(`[engine] @${profile.username}: ⏭ story share% rolled 0 (${pct}% of ${storyItems.length} slides)`);
              }
            }
          }
        } catch (e: any) {
          if (await checkSessionErr(e, "check_timeline_stories")) return;
          console.warn(`[engine] @${profile.username}: timeline stories error: ${e?.message}`);
        }
      },
    );

    // ── Check Direct Messages ────────────────────────────────────────────────
    enqueue("checkDm",
      s.checkDmEnabled === true && (s as any).emulationGroupEnabled !== false,
      "checkDmNotUsedMin", "checkDmNotUsedMax",
      "checkDmOrderMin",   "checkDmOrderMax",
      async () => {
        client.setApiCallSource("Human Session Emulation");
        let inboxThreads: { threadId: string; username: string; userId: string; firstName: string; items: { itemId: string; text: string; fromMe: boolean }[] }[] = [];
        let dmOpenCount = randInt(Number(s.checkDmMin ?? 1), Number(s.checkDmMax ?? 5));
        let dmCount = 0;
        let dmOk = false;
        let dmGated = false;
        try {
          const result = await client.getDirectMessagesInternal(dmOpenCount);
          inboxThreads = result.threads;
          dmCount = result.count;
          dmOk = result.ok;
          dmGated = result.gated ?? false;
          console.log(`[engine] @${profile.username}: 💬 checked DMs — opened ${dmCount}/${dmOpenCount} thread${dmOpenCount === 1 ? "" : "s"}${dmOk ? "" : dmGated ? " (inbox gated)" : " (read failed)"}`);
        } catch (e: any) {
          if (await checkSessionErr(e, "check_dm")) return;
          console.warn(`[engine] @${profile.username}: check DMs error: ${e?.message}`);
        }
        // Auto-reply scan reuses the already-fetched inbox threads (no second warm-up).
        // Strictly capped to the same dmOpenCount threads that were checked — no extras.
        let autoReplied = 0;
        try {
          autoReplied = await this.runAutoReplyCheck(profile, inboxThreads.slice(0, dmOpenCount), client);
        } catch (e: any) {
          if (await checkSessionErr(e, "auto_reply")) return;
          console.warn(`[engine] @${profile.username}: auto-reply scan error: ${e?.message}`);
        }
        // Log combined result — appends auto-reply count only when triggers were found.
        // dmGated = 4415001 "Prompt has contribution" — Instagram mobile-API gate,
        // not a tool failure. Log as skipped so the dashboard doesn't show red.
        // dmOk false without gated = real failure (no session, network error, etc).
        const dmStatus = dmOk ? "ok" : dmGated ? "skipped" : "error";
        const dmLabel = dmOk
          ? `Checked ${dmCount} direct message${dmCount === 1 ? "" : "s"}`
          : dmGated
            ? "DM inbox temporarily gated by Instagram"
            : "DM check failed";
        const detail = autoReplied > 0
          ? `${dmLabel}, ${autoReplied} scheduled for auto-reply`
          : dmLabel;
        this.logAction(profile.id, tool.id, "check_dm", "", "", "", dmStatus, detail);
      },
    );

    // ── Like Posts from Timeline ─────────────────────────────────────────────
    enqueue("likeTimelinePosts",
      s.likeTimelinePostsEnabled === true && (s as any).emulationGroupEnabled !== false,
      "likeTimelinePostsNotUsedMin", "likeTimelinePostsNotUsedMax",
      "likeTimelinePostsOrderMin",   "likeTimelinePostsOrderMax",
      async () => {
        client.setApiCallSource("Human Session Emulation");
        console.log(`[engine] @${profile.username}: ▶ ENQUEUE FIRED: likeTimelinePosts STANDALONE (likeTimelinePostsEnabled=true). This is the source of any likes logged below.`);
        const likeCount = randInt(s.likeTimelinePostsMin ?? 0, s.likeTimelinePostsMax ?? 0);
        if (likeCount <= 0) {
          console.log(`[engine] @${profile.username}: likeTimelinePosts STANDALONE skipped — likeCount resolved to 0 (likeTimelinePostsMin=${s.likeTimelinePostsMin}, likeTimelinePostsMax=${s.likeTimelinePostsMax})`);
          return;
        }
        const likeDelayMin = Number(s.likeTimelinePostsDelayMin ?? 3);
        const likeDelayMax = Number(s.likeTimelinePostsDelayMax ?? 8);
        try {
          const { liked, watched, likedPosts, sessionExpired, sessionExpiredReason } = await client.likeTimelinePosts(likeCount, likeDelayMin, likeDelayMax);
          if (sessionExpired) {
            const expReason = sessionExpiredReason ?? "session expired (login_required) — likeTimelinePosts";
            console.warn(`[engine] @${profile.username}: likeTimelinePosts — session expired (login_required), marking logged_out`);
            await storage.updateProfile(profile.id, { accountStatus: "logged_out", statusMessage: expReason });
            this.logAction(profile.id, tool.id, "logged_out", "", "", "", "error", expReason);
            state.client = null;
            // Do NOT set sessionError — allow DM check (mobile API) to continue.
            return;
          }
          const summary = watched > 0
            ? `Liked ${liked} post(s) from timeline (watched ${watched} reel(s) before liking)`
            : `Liked ${liked} post(s) from timeline`;
          for (let _i = 0; _i < liked; _i++) await storage.incrementStat(profile.id, "like");
          console.log(`[engine] @${profile.username}: ❤️ ${summary}`);
          if (likedPosts.length > 0) {
            for (const post of likedPosts) {
              this.logAction(profile.id, tool.id, "like_timeline_post", post.ownerUsername, post.shortcode, "post", "ok", "Liked timeline post");
            }
          } else {
            this.logAction(profile.id, tool.id, "like_timeline_post", "", "", "", "ok", summary);
          }
          // Save media from liked posts at the configured percentage
          const saveEnabled = !!s.saveMediaEnabled;
          const savePct = Number(s.saveMediaPercent ?? 0);
          if (saveEnabled && savePct > 0 && likedPosts.length > 0) {
            for (const post of likedPosts) {
              if (!post.mediaId) continue;
              if (Math.random() * 100 < savePct) {
                try {
                  await client.saveMedia(post.mediaId);
                  console.log(`[engine] @${profile.username}: 🔖 saved post ${post.shortcode} by @${post.ownerUsername}`);
                  this.logAction(profile.id, tool.id, "save_media", post.ownerUsername, post.shortcode, "post", "ok", "Saved liked timeline post");
                } catch (se: any) {
                  console.warn(`[engine] @${profile.username}: save media error: ${se?.message}`);
                }
              }
            }
          }
        } catch (e: any) {
          if (await checkSessionErr(e, "like_timeline_posts")) return;
          console.warn(`[engine] @${profile.username}: like timeline posts error: ${e?.message}`);
        }
      },
    );

    // ── Repost ───────────────────────────────────────────────────────────────
    const repostSourceUsername = String(s.repostSourceUsername ?? "").trim();
    const repostLocalFolderPath = String(s.repostLocalFolderPath ?? "").trim();
    const repostLocalFolderEnabled = !!(s.repostLocalFolderEnabled && repostLocalFolderPath);
    const repostUsernameSourceActive = !s.repostDisableUsernameSource && !!repostSourceUsername;

    // Resolve the HikerAPI client once (used only when repostUseHikerApi is ON).
    const gs_repost = await storage.getGlobalSettings();
    const repostHikerClient: HikerApiClient | null =
      (gs_repost.hikerApiEnabled === "true" && gs_repost.hikerApiToken)
        ? new HikerApiClient(gs_repost.hikerApiToken)
        : null;

    enqueue("repost",
      !!(s.repostEnabled && (repostUsernameSourceActive || repostLocalFolderEnabled)) && (s as any).emulationGroupEnabled !== false,
      "repostNotUsedMin", "repostNotUsedMax",
      "repostOrderMin",   "repostOrderMax",
      async () => {
        client.setApiCallSource("Human Session Emulation");
        // ── Local folder source ───────────────────────────────────────────────
        if (repostLocalFolderEnabled) {
          try {
            const entries = await fsPromises.readdir(repostLocalFolderPath);
            const mediaFiles = entries.filter(f => ALL_MEDIA_EXTS.has(nodePath.extname(f).toLowerCase()));
            if (mediaFiles.length === 0) {
              console.warn(`[engine] @${profile.username}: 🔁 local folder repost — no media files found in "${repostLocalFolderPath}"`);
              this.logAction(profile.id, tool.id, "repost", repostLocalFolderPath, "", "", "skip", "No media files found in local folder");
              return;
            }

            const targetCount = randInt(
              Math.max(1, Number(s.repostMin ?? 1)),
              Math.max(1, Number(s.repostMax ?? 1)),
            );
            const level = ((s.repostAlterationLevel ?? "small") as AlterationLevel);
            const captionTemplate = String(s.repostCaptionText ?? "").trim();
            const deleteAfterUpload = s.repostLocalFolderDeleteAfterUpload !== false;
            const noRepeat = !!(s as any).repostLocalFolderNoRepeat;
            const useChatGptCaption = !!(s as any).repostUseChatGpt;
            const makeUnique = !!(s as any).repostMakeUnique;
            const pickRandom = !!(s as any).repostLocalFolderRandom;

            // Filter already-reposted files when noRepeat is ON
            let filteredFiles = mediaFiles;
            if (noRepeat) {
              const existingReposted = await storage.getRepostedPostsByProfile(profile.id, 10000);
              const postedLocalSet = new Set(
                existingReposted
                  .filter(r => r.mediaId.startsWith("local:"))
                  .map(r => r.mediaId.slice(6))
              );
              filteredFiles = mediaFiles.filter(f => !postedLocalSet.has(f));
              if (filteredFiles.length === 0) {
                console.log(`[engine] @${profile.username}: 🔁 local folder — all media already reposted (noRepeat=true)`);
                this.logAction(profile.id, tool.id, "repost", repostLocalFolderPath, "", "", "skip", "All local folder media already reposted (Do not repost same image is ON)");
                return;
              }
            }

            // Sort or shuffle, then pick targetCount files
            const ordered = pickRandom
              ? [...filteredFiles].sort(() => Math.random() - 0.5)
              : [...filteredFiles].sort((a, b) => a.localeCompare(b));
            const picked = ordered.slice(0, targetCount);
            let uploadedCount = 0;

            for (const fileName of picked) {
              const filePath = nodePath.join(repostLocalFolderPath, fileName);
              const ext = nodePath.extname(fileName).toLowerCase();
              const isVideo = isVideoFile(ext);
              const isImage = isImageFile(ext);

              // Build caption
              let caption = captionTemplate
                ? captionTemplate.replace(/\{own_username\}/g, profile.username)
                : "";
              if (useChatGptCaption && captionTemplate) {
                try {
                  const gs_openai = await storage.getGlobalSettings();
                  const openaiKey = ((gs_openai as any).openaiApiKey ?? "").trim();
                  if (openaiKey) {
                    const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
                      method: "POST",
                      headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: "gpt-4o-mini",
                        messages: [{ role: "user", content: captionTemplate }],
                        max_tokens: 500,
                      }),
                    });
                    const gptJson = await gptRes.json() as any;
                    const generated = (gptJson.choices?.[0]?.message?.content ?? "").trim();
                    if (generated) caption = generated;
                  }
                } catch (gptErr: any) {
                  console.warn(`[engine] @${profile.username}: ChatGPT caption failed: ${gptErr?.message}`);
                }
              }

              let postedMediaId: string | null = null;
              let browserPostErr: string | undefined;
              const uniqueTag = makeUnique ? " +unique" : "";
              console.log(`[engine] @${profile.username}: 🔁 repost upload starting — file="${fileName}" isImage=${isImage} isVideo=${isVideo} makeUnique=${makeUnique} level=${level} captionLen=${caption.length}`);

              if (isVideo) {
                // ── Video upload path ────────────────────────────────────────
                let videoPath = filePath;
                let cleanup: (() => Promise<void>) | undefined;
                if (makeUnique) {
                  try {
                    const result = await makeUniqueVideo(filePath);
                    videoPath = result.outputPath;
                    cleanup = result.cleanup;
                    console.log(`[engine] @${profile.username}: 🎬 video uniquified: ${fileName}`);
                  } catch (uqErr: any) {
                    console.warn(`[engine] @${profile.username}: makeUniqueVideo failed for ${fileName}: ${uqErr?.message}`);
                  }
                }
                try {
                  const videoBuffer = await fsPromises.readFile(videoPath);
                  postedMediaId = await client.uploadVideo(videoBuffer, caption);
                } finally {
                  if (cleanup) await cleanup();
                }
              } else if (isImage) {
                // ── Image upload path ────────────────────────────────────────
                const rawBuffer = await fsPromises.readFile(filePath);
                // Apply standard alteration first
                let alteredBuffer = await alterJpegBuffer(rawBuffer, level, s.repostImageSettings);
                // Then apply make-unique aggressive pipeline on top
                if (makeUnique) {
                  try {
                    alteredBuffer = await makeUniqueImage(alteredBuffer);
                  } catch (uqErr: any) {
                    console.warn(`[engine] @${profile.username}: makeUniqueImage failed for ${fileName}: ${uqErr?.message}`);
                  }
                }
                if ((profile as any).postViaBrowser) {
                  // Browser-post path: send to EB via /eb/n
                  const bpResult = await this.postPhotoViaBrowser(profile.id, alteredBuffer, caption);
                  postedMediaId = bpResult.ok ? (bpResult.mediaId ?? `browser:${Date.now()}`) : null;
                  if (!bpResult.ok) {
                    browserPostErr = bpResult.message;
                    console.warn(`[engine] @${profile.username}: browser post failed for ${fileName}: ${bpResult.message}`);
                  } else {
                    // Write synthetic api-calls entry so the stats pie chart picks it up
                    storage.createInstagramApiCall({
                      profileId: profile.id, username: profile.username,
                      operationName: "PostMedia", date: new Date().toISOString(),
                      source: "browser", transport: "browser", isError: false,
                    }).catch(() => {});
                  }
                } else {
                  postedMediaId = await client.uploadPhoto(alteredBuffer, caption);
                }
              }

              if (postedMediaId) {
                if (s.repostDisableComments) {
                  try { await client.disableComments(postedMediaId); } catch { /* non-fatal */ }
                }
                const mediaType = isVideo ? "video" : "image";
                console.log(`[engine] @${profile.username}: 🔁 uploaded ${mediaType} from local folder: ${fileName}${uniqueTag} [${uploadedCount + 1}/${targetCount}]`);
                this.logAction(profile.id, tool.id, "repost", repostLocalFolderPath, fileName, "", "ok", "Make a Post Successful");
                await storage.incrementStat(profile.id, "repost");
                if (noRepeat) {
                  try {
                    await storage.createRepostedPost({
                      profileId:       profile.id,
                      toolId:          tool.id,
                      sourceUsername:  repostLocalFolderPath,
                      mediaId:         `local:${fileName}`,
                      shortcode:       "",
                      caption:         "",
                      thumbnailUrl:    "",
                      repostedAt:      new Date().toISOString(),
                      postedShortcode: "",
                    });
                  } catch { /* non-fatal */ }
                }
                uploadedCount++;
                if (deleteAfterUpload) {
                  try { await fsPromises.unlink(filePath); } catch (e: any) {
                    console.warn(`[engine] @${profile.username}: could not delete ${filePath}: ${e?.message}`);
                  }
                }
              } else {
                const uploadErr = browserPostErr || client.lastUploadError || "Upload failed";
                console.warn(`[engine] @${profile.username}: 🔁 local folder upload failed: ${fileName} — ${uploadErr}`);
                this.logAction(profile.id, tool.id, "repost", repostLocalFolderPath, fileName, "", "fail", "Make a Post Failed");
                // Make 1 attempt only — do not keep cycling through more
                // images from the folder after a failure in the same run.
                break;
              }
            }
          } catch (e: any) {
            if (await checkSessionErr(e, "repost_local_folder")) return;
            console.warn(`[engine] @${profile.username}: local folder repost error: ${e?.message}`);
            this.logAction(profile.id, tool.id, "repost", repostLocalFolderPath, "", "", "fail", e?.message ?? "unknown error");
          }
          return;
        }

        // ── @username source ──────────────────────────────────────────────────
        // Skip if the source has been disabled by the user in settings.
        if (!repostUsernameSourceActive) return;
        const sourceUsername = repostSourceUsername;
        try {
          const useHiker = !!s.repostUseHikerApi && gs_repost.hikerRepostGetFeed !== "false";

          // Toggle ON → HikerAPI only, hard fail if not configured (no fallback to account).
          // Toggle OFF → account's own session does the scrape.
          let feedItems: Awaited<ReturnType<HikerApiClient["getUserFeedItems"]>>;
          if (useHiker) {
            if (!repostHikerClient) {
              console.warn(`[engine] @${profile.username}: 🔁 repost skipped — HikerAPI toggled ON but not configured`);
              this.logAction(profile.id, tool.id, "repost", sourceUsername, "", "", "error", "HikerAPI toggled ON but not configured in Global Settings");
              return;
            }
            const t0Repost = Date.now();
            feedItems = await repostHikerClient.getUserFeedItems(sourceUsername);
            storage.createInstagramApiCall({
              profileId: profile.id,
              username: profile.username,
              operationName: "RepostFeedScrape",
              date: new Date().toISOString(),
              message: `Scraped feed of @${sourceUsername} via HikerAPI (${feedItems.length} items)`,
              source: "HikerAPI",
              durationMs: Date.now() - t0Repost,
            }).catch(() => {});
          } else {
            feedItems = await client.getUserFeedItems(sourceUsername);
          }

          const disableAt = Number(s.repostDisableAtPostCount ?? 0);
          if (disableAt > 0) {
            const stats = await client.getOwnProfileStats();
            if (stats && stats.postsCount >= disableAt) {
              // Disable only the repost sub-feature — never the entire human_sessions tool
              await storage.updateTool(tool.id, { settings: { ...s, repostEnabled: false } });
              console.log(`[engine] @${profile.username}: 🔁 repost sub-feature disabled (posts=${stats.postsCount} >= target=${disableAt})`);
              this.logAction(profile.id, tool.id, "repost", sourceUsername, "", "", "ok", `Repost disabled: ${stats.postsCount} posts reached target ${disableAt}`);
              return;
            }
          }

          // How many posts to repost this session
          const targetCount = randInt(
            Math.max(1, Number(s.repostMin ?? 1)),
            Math.max(1, Number(s.repostMax ?? 1)),
          );

          console.log(`[engine] @${profile.username}: 🔁 repost feed fetched via ${useHiker ? "HikerAPI" : "account session"} (${feedItems.length} items, target=${targetCount})`);

          const level = ((s.repostAlterationLevel ?? "small") as AlterationLevel);
          const captionTemplate = String(s.repostCaptionText ?? "").trim();

          let repostedCount = 0;
          let uploadAttempted = 0;  // items where we actually tried to upload (not already reposted)
          for (const item of feedItems) {
            if (repostedCount >= targetCount) break;
            const already = await storage.isAlreadyReposted(profile.id, item.mediaId);
            if (already) continue;

            uploadAttempted++;
            const imageBuffer = await client.downloadImage(item.imageUrl);
            const makeUnique = !!(s as any).repostMakeUnique;
            let alteredBuffer = await alterJpegBuffer(imageBuffer, level, s.repostImageSettings);
            if (makeUnique) {
              try {
                alteredBuffer = await makeUniqueImage(alteredBuffer);
              } catch (uqErr: any) {
                console.warn(`[engine] @${profile.username}: makeUniqueImage failed (non-fatal): ${uqErr?.message}`);
              }
            }
            const finalCaption  = captionTemplate
              ? resolveCaption(captionTemplate, item, sourceUsername, profile.username)
              : item.caption.slice(0, 2200);

            // Upload via private API
            const postedMediaId = await client.uploadPhoto(alteredBuffer, finalCaption);
            if (postedMediaId) {
              if (s.repostDisableComments) {
                try { await client.disableComments(postedMediaId); } catch { /* non-fatal */ }
              }
              const postedShortcode = mediaIdToShortcode(postedMediaId);
              await storage.createRepostedPost({
                profileId:      profile.id,
                toolId:         tool.id,
                sourceUsername,
                mediaId:        item.mediaId,
                shortcode:      item.shortcode,
                caption:        item.caption.slice(0, 2200),
                thumbnailUrl:   item.imageUrl,
                repostedAt:     new Date().toISOString(),
                postedShortcode,
              });
              console.log(`[engine] @${profile.username}: 🔁 reposted ${item.mediaId} from @${sourceUsername} → own post ${postedShortcode} (alteration=${level}) [${repostedCount + 1}/${targetCount}]`);
              this.logAction(profile.id, tool.id, "repost", sourceUsername, item.mediaId, item.shortcode, "ok", `Reposted from @${sourceUsername} [${repostedCount + 1}/${targetCount}]`);
              await storage.incrementStat(profile.id, "repost");
              repostedCount++;
            } else {
              const uploadErr = client.lastUploadError || "Upload failed";
              console.warn(`[engine] @${profile.username}: 🔁 upload failed for ${item.mediaId}: ${uploadErr}`);
              this.logAction(profile.id, tool.id, "repost", sourceUsername, item.mediaId, "", "fail", uploadErr);
              // If rupload returned login_required the session is expired — flag it
              // now so the summary log below can recommend re-verification.
              break;
            }
          }

          if (repostedCount === 0) {
            if (feedItems.length === 0) {
              // Feed returned nothing — likely a temporary API failure or empty source account.
              // Never auto-disable on an empty feed response.
              console.warn(`[engine] @${profile.username}: 🔁 repost skipped — feed returned 0 items for @${sourceUsername} (possible API issue)`);
              this.logAction(profile.id, tool.id, "repost", sourceUsername, "", "", "skip", `Feed returned no items for @${sourceUsername}`);
            } else if (uploadAttempted > 0) {
              // We found new posts but the upload itself failed.
              if (client.lastUploadLoginRequired) {
                // Session expired — rupload returned 403 login_required.
                // Mark account as logged_out so the engine triggers re-verify.
                console.warn(`[engine] @${profile.username}: 🔁 repost — upload rejected (session expired / login_required), marking logged_out`);
                this.logAction(profile.id, tool.id, "repost", sourceUsername, "", "", "fail", `Upload failed: session expired (account marked for re-verify)`);
                await this.applyAccountLevelError(profile.id, "login_required", state, tool.id);
              } else {
                // Generic upload failure — session/network issue, not exhausted.
                // Do NOT auto-disable; the next session will retry.
                console.warn(`[engine] @${profile.username}: 🔁 repost skipped — ${uploadAttempted} upload(s) failed for @${sourceUsername} (session issue, will retry)`);
                this.logAction(profile.id, tool.id, "repost", sourceUsername, "", "", "fail", `Upload failed for @${sourceUsername} will retry next session`);
              }
            } else if (s.repostDisableWhenExhausted) {
              // uploadAttempted === 0: every item in the feed was already in our reposted DB — truly exhausted.
              // Disable only the repost sub-feature — never the entire human_sessions tool.
              await storage.updateTool(tool.id, { settings: { ...s, repostEnabled: false } });
              console.log(`[engine] @${profile.username}: 🔁 repost sub-feature disabled (source @${sourceUsername} exhausted — all ${feedItems.length} posts already reposted)`);
              this.logAction(profile.id, tool.id, "repost", sourceUsername, "", "", "ok", "Repost disabled: all source posts already reposted");
            } else {
              console.log(`[engine] @${profile.username}: 🔁 repost skipped — no new posts from @${sourceUsername}`);
              this.logAction(profile.id, tool.id, "repost", sourceUsername, "", "", "skip", `No new unique posts from @${sourceUsername}`);
            }
          }
        } catch (e: any) {
          if (await checkSessionErr(e, "repost")) return;
          console.warn(`[engine] @${profile.username}: repost error: ${e?.message}`);
          this.logAction(profile.id, tool.id, "repost", sourceUsername, "", "", "fail", e?.message ?? "unknown error");
        }
      },
    );

    // ── Follow Tool (run as full session within the HS) ───────────────────────
    {
      const hsTools = await storage.getToolsByProfile(profile.id);
      const followTool = hsTools.find(t => t.type === "follow");
      enqueue("followTool",
        followTool?.enabled === true,
        "followSkipMin", "followSkipMax",
        "followOrderMin", "followOrderMax",
        async () => {
          // Re-read enabled state at execution time — the user may have toggled
          // the Follow Tool checkbox after the queue was built but before this
          // slot executed. Without this second gate the follow runs regardless.
          const execTools = await storage.getToolsByProfile(profile.id);
          const execFollowTool = execTools.find(t => t.type === "follow");
          if (!execFollowTool?.enabled) {
            console.log(`[engine] @${profile.username}: HS follow — skipped (disabled at execution time)`);
            return;
          }
          try {
            await this.runSession(profile, execFollowTool, state);
          } catch (e: any) {
            if (await checkSessionErr(e, "followTool")) return;
            console.warn(`[engine] @${profile.username}: follow tool error in HS: ${e?.message}`);
          }
        },
      );

      // ── Unfollow Tool (run as full session within the HS) ─────────────────
      const unfollowTool = hsTools.find(t => t.type === "unfollow");
      enqueue("unfollowTool",
        unfollowTool?.enabled === true,
        "unfollowSkipMin", "unfollowSkipMax",
        "unfollowOrderMin", "unfollowOrderMax",
        async () => {
          // Re-read enabled state at execution time.
          const execTools = await storage.getToolsByProfile(profile.id);
          const execUnfollowTool = execTools.find(t => t.type === "unfollow");
          if (!execUnfollowTool?.enabled) {
            console.log(`[engine] @${profile.username}: HS unfollow — skipped (disabled at execution time)`);
            return;
          }
          try {
            await this.runUnfollowSession(profile, execUnfollowTool, state);
          } catch (e: any) {
            if (await checkSessionErr(e, "unfollowTool")) return;
            console.warn(`[engine] @${profile.username}: unfollow tool error in HS: ${e?.message}`);
          }
        },
      );

      // ── Contact Tool (run as full session within the HS) ──────────────────
      // Master switch: contactTool.enabled is the sole gate. Sub-toggles
      // (contactUsersEnabled, contactNewFollowersEnabled, autoReplyEnabled)
      // only matter when the master is ON — they cannot activate the tool alone.
      const contactTool = hsTools.find(t => t.type === "contact");
      const contactAnyEnabled = contactTool?.enabled === true;
      enqueue("contactTool",
        contactAnyEnabled,
        "contactSkipMin", "contactSkipMax",
        "contactOrderMin", "contactOrderMax",
        async () => {
          // Re-read enabled state at execution time.
          const execTools = await storage.getToolsByProfile(profile.id);
          const execContactTool = execTools.find(t => t.type === "contact");
          if (!execContactTool) return;
          // Master switch re-check at execution time.
          if (!execContactTool.enabled) {
            console.log(`[engine] @${profile.username}: HS contact — skipped (disabled at execution time)`);
            return;
          }
          const execCS = (execContactTool.settings ?? {}) as any;
          try {
            if (execCS.contactNewFollowersEnabled) {
              await this.runContactNewFollowersSession(profile, execContactTool, state);
            }
            if (execCS.contactUsersEnabled) {
              await this.runContactUsersSession(profile, execContactTool, state);
            }
          } catch (e: any) {
            if (await checkSessionErr(e, "contactTool")) return;
            console.warn(`[engine] @${profile.username}: contact tool error in HS: ${e?.message}`);
          }
        },
      );
    }

    // ── Web Browsing — visits external websites to build genuine browser history ─
    enqueue("webBrowsing",
      s.webBrowsingEnabled === true,
      "webBrowsingSkipMin", "webBrowsingSkipMax",
      "webBrowsingOrderMin", "webBrowsingOrderMax",
      async () => {
        const cbSettings = {
          sites: s.webBrowsingSites ?? "",
          sitesMin: Number(s.webBrowsingSitesMin ?? 3),
          sitesMax: Number(s.webBrowsingSitesMax ?? 5),
          visitRandom: s.webBrowsingVisitRandom !== false,
          internalLinksMin: Number(s.webBrowsingInternalLinksMin ?? 2),
          internalLinksMax: Number(s.webBrowsingInternalLinksMax ?? 5),
          scrollDelayMin: Number(s.webBrowsingTimeOnSiteMin ?? 1),
          scrollDelayMax: Number(s.webBrowsingTimeOnSiteMax ?? 3),
          internalScrollDelayMin: Number(s.webBrowsingTimeOnLinksMin ?? 1),
          internalScrollDelayMax: Number(s.webBrowsingTimeOnLinksMax ?? 2),
        };
        try {
          await this.runCookieBakerSession(profile, cbSettings, { stop: { stopped: false } });
          this.logAction(profile.id, tool.id, "web_browsing", "", "", "", "ok", "Web browsing session completed");
          this.logGhostBrowserCall(profile.id, profile.username, "web_browsing", "Web browsing session completed");
          console.log(`[engine] @${profile.username}: 🌐 web browsing session complete`);
        } catch (e: any) {
          console.warn(`[engine] @${profile.username}: web browsing error: ${e?.message}`);
          this.logAction(profile.id, tool.id, "web_browsing", "", "", "", "fail", e?.message ?? "web browsing error");
        }
      },
    );

    // ── explorePage — independent queued action (no longer tied to empty feed) ─
    // Previously fired inline inside viewTimelineFeed only when viewed===0.
    // Now a first-class queued feature with its own Order % and Skip Chance %,
    // running regardless of whether the timeline had posts.
    enqueue("explorePage",
      s.followSuggestedUsersIfEmptyEnabled === true && (s as any).emulationGroupEnabled !== false,
      "explorePageSkipMin", "explorePageSkipMax",
      "explorePageOrderMin", "explorePageOrderMax",
      async () => {
        const c = await this.ensureClient(profile, state);
        if (!c) return;
        try {
          const scrollMin = Math.max(1, Number((s as any).exploreScrollMin ?? 5));
          const scrollMax = Math.max(scrollMin, Number((s as any).exploreScrollMax ?? 15));
          const exploreScrollCount = randInt(scrollMin, scrollMax);
          const exploreItems = await c.visitExplorePage(exploreScrollCount);
          console.log(`[engine] @${profile.username}: 🔭 explore page — fetched ${exploreItems.length} item(s)`);
          this.logAction(profile.id, tool.id, "visit_explore_page", "", "", "", "ok", `Visited explore page, fetched ${exploreItems.length} posts`);

          const exploreClickMin = Math.max(0, Number((s as any).exploreClickMin ?? 1));
          const exploreClickMax = Math.max(exploreClickMin, Number((s as any).exploreClickMax ?? 3));
          const exploreClickCount = randInt(exploreClickMin, exploreClickMax);
          const toClick = [...exploreItems].sort(() => 0.5 - Math.random()).slice(0, exploreClickCount);

          for (const item of toClick) {
            try {
              await c.viewFeedPost(item.mediaId);
              console.log(`[engine] @${profile.username}: 🔍 opened explore post ${item.shortcode} by @${item.username}`);
              this.logAction(profile.id, tool.id, "view_post", item.username, item.shortcode, "post", "ok", "Opened post from explore page");
            } catch (e: any) {
              if (await checkSessionErr(e, "explore_view_post")) return;
              console.warn(`[engine] @${profile.username}: explore view post error: ${e?.message}`);
              continue;
            }

            // Like this explore post?
            const exploreLikePctMin = Number((s as any).exploreLikePctMin ?? 0);
            const exploreLikePctMax = Number((s as any).exploreLikePctMax ?? 30);
            if (exploreLikePctMax > 0 && item.mediaId) {
              const likePct = randInt(exploreLikePctMin, exploreLikePctMax);
              if (Math.random() * 100 < likePct) {
                try {
                  await c.likeMedia(item.mediaId, item.username);
                  await storage.incrementStat(profile.id, "like");
                  console.log(`[engine] @${profile.username}: ❤️ liked explore post ${item.shortcode} by @${item.username}`);
                  this.logAction(profile.id, tool.id, "like_post", item.username, item.shortcode, "post", "ok", "Liked explore post");
                } catch (e: any) {
                  console.warn(`[engine] @${profile.username}: explore like post error: ${e?.message}`);
                }
              }
            }

            // Visit the post author's profile?
            const exploreVisitPctMin = Number((s as any).exploreVisitProfilePctMin ?? 0);
            const exploreVisitPctMax = Number((s as any).exploreVisitProfilePctMax ?? 20);
            if (exploreVisitPctMax > 0 && item.userId) {
              const visitPct = randInt(exploreVisitPctMin, exploreVisitPctMax);
              if (Math.random() * 100 < visitPct) {
                try {
                  await c.visitUserProfile(item.userId, "explore_popular");
                  console.log(`[engine] @${profile.username}: 👤 visited profile of @${item.username} from explore`);
                  this.logAction(profile.id, tool.id, "visit_profile", item.username, "", "profile", "ok", `Visited @${item.username}'s profile from explore`);
                } catch (e: any) {
                  if (await checkSessionErr(e, "explore_visit_profile")) return;
                  console.warn(`[engine] @${profile.username}: explore visit profile error: ${e?.message}`);
                  continue;
                }

                // Scroll their profile feed
                const expProfileScrollMin = Number((s as any).exploreProfileScrollMin ?? 3);
                const expProfileScrollMax = Number((s as any).exploreProfileScrollMax ?? 8);
                const profileScrollCount = randInt(expProfileScrollMin, expProfileScrollMax);
                let profilePosts: Array<{ mediaId: string; shortcode: string; username: string }> = [];
                try {
                  profilePosts = useHikerHumanSessionFeed
                    ? await hikerClient!.getUserFeedByUserId(item.userId, profileScrollCount)
                    : await c.viewUserFeed(item.userId, profileScrollCount);
                  console.log(`[engine] @${profile.username}: 📋 scrolled ${profilePosts.length} post(s) on @${item.username}'s profile (from explore)${useHikerHumanSessionFeed ? " [HikerAPI]" : ""}`);
                  this.logAction(profile.id, tool.id, "view_profile_feed", item.username, "", "profile", "ok", `Scrolled ${profilePosts.length} post(s) on @${item.username}'s profile`);
                } catch (e: any) {
                  if (await checkSessionErr(e, "explore_profile_feed")) return;
                  console.warn(`[engine] @${profile.username}: explore profile feed error: ${e?.message}`);
                }

                // Click posts on their profile
                const expProfileClickMin = Number((s as any).exploreProfileClickMin ?? 1);
                const expProfileClickMax = Number((s as any).exploreProfileClickMax ?? 3);
                const profileClickMax = randInt(expProfileClickMin, expProfileClickMax);
                let profilePostsOpened = 0;
                for (const profilePost of profilePosts) {
                  if (profilePostsOpened >= profileClickMax) break;
                  try {
                    await c.viewFeedPost(profilePost.mediaId);
                    console.log(`[engine] @${profile.username}: 🖼 opened post ${profilePost.shortcode} from @${item.username}'s profile (explore)`);
                    this.logAction(profile.id, tool.id, "view_profile_post", item.username, profilePost.shortcode, "post", "ok", `Opened post from @${item.username}'s profile (explore)`);
                    profilePostsOpened++;
                  } catch (e: any) {
                    if (await checkSessionErr(e, "explore_profile_post")) return;
                    console.warn(`[engine] @${profile.username}: explore profile post error: ${e?.message}`);
                  }
                }
              }
            }
          }
        } catch (se: any) {
          console.warn(`[engine] @${profile.username}: visit explore page error: ${se?.message}`);
        }
      },
    );

    // Sort descending by order value (higher order = runs first — ties keep insertion order)
    queue.sort((a, b) => b.order - a.order);

    const orderSummary = queue.map(e => e.label).join(" → ");
    console.log(`[engine] @${profile.username}: session order: ${orderSummary || "(nothing to run)"}`);

    // Execute in sorted order — stop immediately on any account-level error
    for (const entry of queue) {
      if (sessionError) break;
      await entry.run();
    }
  }

  // ── Follow session ────────────────────────────────────────────────────────
  private async runSession(profile: Profile, tool: Tool, state: ProfileState): Promise<{ followed: number; scraped: number; dedupSkipped: number; filterSkipped: number; blocked: number; skipped: number }> {
    const s = tool.settings as any;

    // Stop-on-block gate: skip session while the tool is in a user-configured cooldown
    if (s.stopOnBlockEnabled && s.toolBlockedUntil && Date.now() < s.toolBlockedUntil) {
      const remMs = s.toolBlockedUntil - Date.now();
      const remH = Math.floor(remMs / 3_600_000);
      const remM = Math.floor((remMs % 3_600_000) / 60_000);
      const remStr = remH > 0 ? `${remH}h ${remM}m` : `${remM}m`;
      this.logAction(profile.id, tool.id, "action_suspended", "", "", "", "skipped", `Tool paused: blocked by Instagram. ${remStr} remaining`);
      return { followed: 0, scraped: 0, dedupSkipped: 0, filterSkipped: 0, blocked: 0, skipped: 0 };
    }

    const maxPerDay      = randInt(s.maxPerDayMin       ?? 150, s.maxPerDayMax       ?? 200);
    const maxPerHour     = randInt(s.maxPerHourMin      ?? 5,   s.maxPerHourMax      ?? 15);
    const processCount   = randInt(s.processMin         ?? 5,   s.processMax         ?? 15);
    const followMin      = (s.delayAfterFollowMin       ?? 5)   * 1000;
    const followMax      = (s.delayAfterFollowMax       ?? 15)  * 1000;
    const maxExtraRounds = randInt(s.abortScrapeAfterMin ?? 10,  s.abortScrapeAfterMax ?? 20);

    // Fetch global filter settings once per session
    const globalSettings = await storage.getGlobalSettings();
    const globalSkipFollowed = globalSettings.skipFollowedUsers === "true";
    const globalSkipSkipped  = globalSettings.skipAlreadySkippedUsers === "true";
    const toolSkipIndian     = !!(s.skipIndianUsers);

    // Build HikerAPI client if enabled
    const hikerEnabled = globalSettings.hikerApiEnabled === "true";
    const hikerToken   = globalSettings.hikerApiToken ?? "";
    const hikerClient: HikerApiClient | null = (hikerEnabled && hikerToken) ? new HikerApiClient(hikerToken) : null;
    const useHikerFollowHashtag      = !!(hikerClient && globalSettings.hikerFollowHashtag !== "false");
    const useHikerFollowGetFollowers = !!(hikerClient && globalSettings.hikerFollowGetFollowers !== "false");
    const useHikerFollowByUsername   = !!(hikerClient && globalSettings.hikerFollowByUsername !== "false");
    const useHikerHumanSessionFeed   = !!(hikerClient && globalSettings.hikerHumanSessionFeed !== "false");
    if (hikerClient) engineLog("INFO", `@${profile.username}: using HikerAPI for scrape calls`);
    else engineLog("WARN", `@${profile.username}: HikerAPI disabled/no token — no scraping fallback, session will abort`);

    const zero = { followed: 0, scraped: 0, dedupSkipped: 0, filterSkipped: 0, blocked: 0, skipped: 0 };
    const scrapeAllIfSkipped = globalSettings.scrapeAllIfSkipped === "true";

    // Daily limit (0 = no limit)
    if (maxPerDay > 0 && this.daily(state) >= maxPerDay) {
      console.log(`[engine] @${profile.username}: daily limit (${maxPerDay}) hit — sleeping until midnight`);
      const now = new Date();
      const midnight = new Date(now); midnight.setDate(midnight.getDate() + 1); midnight.setHours(0, 0, 0, 0);
      await sleep(midnight.getTime() - now.getTime());
      return zero;
    }

    // Hourly limit (0 = no limit)
    if (maxPerHour > 0 && this.hourly(state) >= maxPerHour) {
      console.log(`[engine] @${profile.username}: hourly limit (${maxPerHour}) hit — sleeping 1h`);
      await sleep(3_600_000);
      return zero;
    }

    const client = await this.ensureClient(profile, state);
    if (!client) {
      this.logAction(profile.id, tool.id, "follow", "", "", "", "skip", "No active session: verify the account in embedded browser first (Verify Credentials)");
      return zero;
    }
    client.setApiCallSource("Follow Tool");

    // Pick source
    const sources = await storage.getSourcesByTool(tool.id);
    const enabledSources = sources.filter(s => s.enabled !== false);
    if (!enabledSources.length) {
      const msg = sources.length
        ? "All follow sources are disabled — enable at least one source in Follow Tool target sources"
        : "No follow sources configured  add hashtag or account sources in Follow Tool settings";
      engineLog("WARN", `@${profile.username}: follow tool: ${msg}`);
      this.logAction(profile.id, tool.id, "follow", "", "", "", "skip", msg);
      await sleep(300_000);
      return zero;
    }
    const source = this.pickSource(sources);
    engineLog("INFO", `@${profile.username}: session [${processCount} follows] from ${source.type}:${source.value}`);

    let candidates: { pk: string; username: string; fullName: string }[] = [];

    const logHiker = (op: string, message: string, durationMs: number) => {
      storage.createInstagramApiCall({
        profileId: profile.id,
        username: profile.username,
        operationName: op,
        date: new Date().toISOString(),
        message,
        source: "HikerAPI",
        durationMs,
      }).catch(() => {});
    };

    try {
      if (source.type === "hashtag") {
        if (useHikerFollowHashtag) {
          const t0 = Date.now();
          const globalCursor = await storage.getHashtagCursor(source.value);
          const result = await hikerClient!.getHashtagUsers(source.value, Math.max(processCount * 3, 20), globalCursor);
          candidates = result.users;
          if (result.nextCursor) {
            await storage.setHashtagCursor(source.value, result.nextCursor).catch(() => {});
          } else if (globalCursor) {
            // End of hashtag feed — reset so next cycle starts from the top
            await storage.setHashtagCursor(source.value, "").catch(() => {});
          }
          // Always deduplicate hashtag candidates against the scraped-users list.
          // This prevents multiple accounts from processing the same page of users even when
          // the cursor fails to advance (e.g. HikerAPI returns no next_max_id on the first page).
          if (candidates.length > 0) {
            const ignoreDays = parseInt(globalSettings.scrapedUserIgnoreDays ?? "30", 10);
            const alreadyScraped = await storage.getScrapedUserIds(candidates.map(c => c.pk), ignoreDays);
            const beforeDedup = candidates.length;
            const fresh = candidates.filter(c => !alreadyScraped.has(c.pk));
            await storage.addScrapedUsers(fresh).catch(() => {});
            candidates = fresh;
            if (beforeDedup !== candidates.length) {
              engineLog("INFO", `@${profile.username}: hashtag dedup — ${beforeDedup - candidates.length} already-scraped users removed from #${source.value} candidates`);
            }
          }
          logHiker("HashtagScrape", `Scraped #${source.value} via HikerAPI (${candidates.length} users)`, Date.now() - t0);
        } else {
          candidates = await client.getHashtagUsers(source.value, processCount * 3);
        }
      } else if (source.type === "target_followers") {
        const targetName = source.value.replace(/^@/, "");
        // Use cached pk; resolve once and cache so we never call this again
        let targetPk = source.targetUserId ?? "";
        if (!targetPk) {
          let resolved: { pk: string; username: string } | null = null;
          if (useHikerFollowByUsername) {
            const t0 = Date.now();
            resolved = await hikerClient!.getUserByUsername(targetName);
            logHiker("GetUserByUsername", `Resolved @${targetName} via HikerAPI (cached for future runs)`, Date.now() - t0);
          } else {
            resolved = await client.searchUserByUsername(targetName);
          }
          if (!resolved) { console.error(`[engine] @${profile.username}: target @${targetName} not found`); return { followed: 0, scraped: 0, dedupSkipped: 0, filterSkipped: 0, blocked: 0, skipped: 0 }; }
          targetPk = resolved.pk;
          await storage.updateSourceTargetUserId(source.id, targetPk);
        }
        if (useHikerFollowGetFollowers) {
          const t0 = Date.now();
          let hikerCacheMiss = false;
          try { candidates = await hikerClient!.getFollowers(targetPk, Math.max(processCount * 3, 20)); }
          catch (err: any) {
            if (err instanceof HikerCacheMissError) {
              console.log(`[engine] @${profile.username}: HikerAPI followers cache miss for follow tool — skipping source @${targetName}`);
              hikerCacheMiss = true;
            } else { throw err; }
          }
          if (hikerCacheMiss) { return zero; }
          if (globalSettings.skipScrapedUsers === "true" && candidates.length > 0) {
            const ignoreDays = parseInt(globalSettings.scrapedUserIgnoreDays ?? "365", 10);
            const alreadyScraped = await storage.getScrapedUserIds(candidates.map(c => c.pk), ignoreDays);
            const fresh = candidates.filter(c => !alreadyScraped.has(c.pk));
            await storage.addScrapedUsers(fresh).catch(() => {});
            candidates = fresh;
          }
          logHiker("FollowersScrape", `Scraped followers of @${targetName} via HikerAPI (${candidates.length} users)`, Date.now() - t0);
        } else {
          candidates = await client.getFollowers(targetPk, processCount + 5);
        }
      }
    } catch (err: any) {
      engineLog("ERROR", `@${profile.username}: scrape error: ${err?.message}`);
      const scrapeAcctStatus = await this.applyAccountLevelError(profile.id, err?.message ?? "", state);
      if (scrapeAcctStatus) {
        // status + statusMessage already stored by applyAccountLevelError
      } else if (/login_required|Not authenticated|session/i.test(err?.message ?? "")) {
        state.client = null;
      }
      return zero;
    }

    engineLog("INFO", `@${profile.username}: scraped ${candidates.length} candidates (target: ${processCount})`);

    const injectSuggestedEnabled = !!(s.injectSuggestedEnabled);
    const injectSuggestedMin     = Math.max(0, Math.min(100, s.injectSuggestedMin ?? 1));
    const injectSuggestedMax     = Math.max(0, Math.min(100, s.injectSuggestedMax ?? 1));

    const injectSearchEnabled = !!(s.injectSearchEnabled);
    const injectSearchMin     = Math.max(0, Math.min(100, s.injectSearchMin ?? 1));
    const injectSearchMax     = Math.max(0, Math.min(100, s.injectSearchMax ?? 1));

    const injectProfileBrowsingEnabled            = !!(s.injectProfileBrowsingEnabled);
    const injectProfileBrowsingMin                = Math.max(0, Math.min(100, s.injectProfileBrowsingMin ?? 1));
    const injectProfileBrowsingMax                = Math.max(0, Math.min(100, s.injectProfileBrowsingMax ?? 1));
    const injectProfileBrowsingFeedChanceMin      = Math.max(0, Math.min(100, s.injectProfileBrowsingFeedChanceMin ?? 100));
    const injectProfileBrowsingFeedChanceMax      = Math.max(0, Math.min(100, s.injectProfileBrowsingFeedChanceMax ?? 100));
    const injectProfileBrowsingFeedMin            = Math.max(1, s.injectProfileBrowsingFeedMin ?? 3);
    const injectProfileBrowsingFeedMax            = Math.max(1, s.injectProfileBrowsingFeedMax ?? 6);
    // injectProfileBrowsingPostPctMin/Max removed — post clicking is now controlled
    // by injectProfileBrowsingClickPostMin/Max (count-based, not per-post chance).
    // Abandon-follow after browsing
    const injectProfileBrowsingAbandonFollow      = !!(s.injectProfileBrowsingAbandonFollow);
    const injectProfileBrowsingAbandonPctMin      = Math.max(0, Math.min(100, s.injectProfileBrowsingAbandonFollowPctMin ?? 10));
    const injectProfileBrowsingAbandonPctMax      = Math.max(0, Math.min(100, s.injectProfileBrowsingAbandonFollowPctMax ?? 20));
    // Browse-before-follow settings (pre-follow browse, controlled by user)
    const injectProfileBrowsingBeforeFollow       = !!(s.injectProfileBrowsingBeforeFollow);
    const injectProfileBrowsingBeforeFollowPctMin = Math.max(0, Math.min(100, s.injectProfileBrowsingBeforeFollowPctMin ?? 0));
    const injectProfileBrowsingBeforeFollowPctMax = Math.max(0, Math.min(100, s.injectProfileBrowsingBeforeFollowPctMax ?? 0));
    // New inject browsing action settings
    const injectProfileBrowsingLikePctMin         = Math.max(0, s.injectProfileBrowsingLikePctMin ?? 0);
    const injectProfileBrowsingLikePctMax         = Math.max(0, s.injectProfileBrowsingLikePctMax ?? 0);
    const injectProfileBrowsingLikeScrollMin      = Math.max(0, s.injectProfileBrowsingLikeScrollMin ?? 0);
    const injectProfileBrowsingLikeScrollMax      = Math.max(0, s.injectProfileBrowsingLikeScrollMax ?? 0);
    // Click Feed Posts — how many scrolled posts to click and individually view (likes fire inside each clicked post).
    const injectProfileBrowsingClickPostMin       = Math.max(0, s.injectProfileBrowsingClickPostMin ?? 0);
    const injectProfileBrowsingClickPostMax       = Math.max(injectProfileBrowsingClickPostMin, s.injectProfileBrowsingClickPostMax ?? 0);
    const injectProfileBrowsingSaveMediaPctMin    = Math.max(0, s.injectProfileBrowsingSaveMediaPctMin ?? 0);
    const injectProfileBrowsingSaveMediaPctMax    = Math.max(0, s.injectProfileBrowsingSaveMediaPctMax ?? 0);
    const injectProfileBrowsingSaveMediaScrollMin = Math.max(0, s.injectProfileBrowsingSaveMediaScrollMin ?? 0);
    const injectProfileBrowsingSaveMediaScrollMax = Math.max(0, s.injectProfileBrowsingSaveMediaScrollMax ?? 0);
    const injectProfileBrowsingWatchStoriesPctMin = Math.max(0, s.injectProfileBrowsingWatchStoriesPctMin ?? 0);
    const injectProfileBrowsingWatchStoriesPctMax = Math.max(0, s.injectProfileBrowsingWatchStoriesPctMax ?? 0);
    const injectProfileBrowsingWatchStoriesScrollMin = Math.max(0, s.injectProfileBrowsingWatchStoriesScrollMin ?? 0);
    const injectProfileBrowsingWatchStoriesScrollMax = Math.max(0, s.injectProfileBrowsingWatchStoriesScrollMax ?? 0);
    const injectProfileBrowsingViewHighlightsPctMin = Math.max(0, s.injectProfileBrowsingViewHighlightsPctMin ?? 0);
    const injectProfileBrowsingViewHighlightsPctMax = Math.max(0, s.injectProfileBrowsingViewHighlightsPctMax ?? 0);
    const injectProfileBrowsingViewHighlightsScrollMin = Math.max(0, s.injectProfileBrowsingViewHighlightsScrollMin ?? 0);
    const injectProfileBrowsingViewHighlightsScrollMax = Math.max(0, s.injectProfileBrowsingViewHighlightsScrollMax ?? 0);
    const injectProfileBrowsingCommentEnabled        = !!(s.injectProfileBrowsingCommentEnabled);
    const injectProfileBrowsingCommentPctMin         = Math.max(0, s.injectProfileBrowsingCommentPctMin ?? 0);
    const injectProfileBrowsingCommentPctMax         = Math.max(0, s.injectProfileBrowsingCommentPctMax ?? 0);
    const injectProfileBrowsingCommentText           = (s.injectProfileBrowsingCommentText as string | undefined) ?? "";
    const injectProfileBrowsingViewReelsPctMin       = Math.max(0, s.injectProfileBrowsingViewReelsPctMin ?? 0);
    const injectProfileBrowsingViewReelsPctMax       = Math.max(0, s.injectProfileBrowsingViewReelsPctMax ?? 0);
    const injectProfileBrowsingViewReelsScrollMin    = Math.max(0, s.injectProfileBrowsingViewReelsScrollMin ?? 0);
    const injectProfileBrowsingViewReelsScrollMax    = Math.max(0, s.injectProfileBrowsingViewReelsScrollMax ?? 0);
    const injectProfileBrowsingShareToDmPctMin       = Math.max(0, s.injectProfileBrowsingShareToDmPctMin ?? 0);
    const injectProfileBrowsingShareToDmPctMax       = Math.max(0, s.injectProfileBrowsingShareToDmPctMax ?? 0);
    const injectProfileBrowsingShareToFeedPctMin     = Math.max(0, s.injectProfileBrowsingShareToFeedPctMin ?? 0);
    const injectProfileBrowsingShareToFeedPctMax     = Math.max(0, s.injectProfileBrowsingShareToFeedPctMax ?? 0);

    // Helper: pick `n` random indices from [lo, hi] without repeats (partial Fisher-Yates).
    // Returns a Set — elements are `followed` counter values at which the injection fires.
    const sampleSlots = (n: number, lo: number, hi: number): Set<number> => {
      const out = new Set<number>();
      if (n <= 0 || hi < lo) return out;
      const pool = hi - lo + 1;
      const count = Math.min(n, pool);
      const arr = Array.from({ length: pool }, (_, i) => lo + i);
      for (let i = 0; i < count; i++) {
        const j = i + Math.floor(Math.random() * (pool - i));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      for (let i = 0; i < count; i++) out.add(arr[i]);
      return out;
    };

    // Pre-calculate injection slots for this session.
    // Each injection fires for (pct % of processCount) follows — determined once at session
    // start so the count is predictable and visible in the log rather than a per-follow dice roll.
    const suggestedPct      = randInt(injectSuggestedMin, injectSuggestedMax);
    // Use Math.max(1, ...) so at least 1 mid-session slot fires when the feature is
    // enabled. Math.round alone produces 0 when processCount is small (2–3 follows) and
    // the percentage is low (10–25%) — e.g. Math.round(2 * 17 / 100) = Math.round(0.34) = 0.
    const injectSuggestedSlots = injectSuggestedEnabled
      ? sampleSlots(Math.max(1, Math.round(processCount * suggestedPct / 100)), 0, Math.max(0, processCount - 1))
      : new Set<number>();

    const searchMidPct      = randInt(injectSearchMin, injectSearchMax);
    const injectSearchMidSlots = injectSearchEnabled
      ? sampleSlots(Math.max(1, Math.round(processCount * searchMidPct / 100)), 0, Math.max(0, processCount - 1))
      : new Set<number>();
    // The pre-session search injection below (line ~3820) already searches candidates[0]'s
    // username before the loop starts — for any source type other than "target_followers".
    // If slot 0 also lands in injectSearchMidSlots, candidates[0] would get searched AGAIN
    // seconds later, right before their own follow — a duplicate SearchUser call for the
    // same username. Strip slot 0 here so the mid-session injection never re-searches the
    // user the pre-session injection already covered.
    if (injectSearchEnabled && source.type !== "target_followers" && candidates.length > 0) {
      injectSearchMidSlots.delete(0);
    }

    // Pre-follow browse: uses the Browse Before Follow % setting from the dialog.
    // Post-follow browse (injectProfileBrowsingMin/Max) handled separately per-follow below.
    const beforeFollowBrowsePct = randInt(injectProfileBrowsingBeforeFollowPctMin, injectProfileBrowsingBeforeFollowPctMax);
    const injectBrowseSlots = (injectProfileBrowsingEnabled && injectProfileBrowsingBeforeFollow)
      ? sampleSlots(Math.max(1, Math.round(processCount * beforeFollowBrowsePct / 100)), 0, Math.max(0, processCount - 1))
      : new Set<number>();

    if (injectSuggestedEnabled)
      engineLog("INFO", `@${profile.username}: getSuggestedUsers scheduled for ${injectSuggestedSlots.size}/${processCount} follow slots (${suggestedPct}%)`);
    if (injectSearchEnabled)
      engineLog("INFO", `@${profile.username}: searchByUsername mid-session scheduled for ${injectSearchMidSlots.size}/${processCount} follow slots (${searchMidPct}%)`);
    if (injectProfileBrowsingEnabled && injectProfileBrowsingBeforeFollow)
      engineLog("INFO", `@${profile.username}: inject profile browsing (pre-follow) scheduled for ${injectBrowseSlots.size}/${processCount} follow slots (${beforeFollowBrowsePct}%)`);
    else if (injectProfileBrowsingEnabled && !injectProfileBrowsingBeforeFollow)
      engineLog("INFO", `@${profile.username}: inject profile browsing enabled (post-follow only, ${injectProfileBrowsingMin}–${injectProfileBrowsingMax}% per follow) — Browse Before Follow is OFF`);
    else if (!injectProfileBrowsingEnabled)
      engineLog("INFO", `@${profile.username}: inject profile browsing DISABLED (outer Inject Browsing checkbox is unchecked)`);

    // Inject /api/v1/users/search/ before the very first follow of every session —
    // but ONLY when the searchByUsername inject is enabled by the user.
    // Simulates the user searching in the search bar before following — adds natural API signal.
    // Tries browser-based search first (EB IPC) so the search appears in the embedded browser;
    // falls back to the mobile API search endpoint if running outside Electron.
    if (injectSearchEnabled && candidates.length > 0) {
      const searchQuery = source.type === "target_followers"
        ? source.value.replace(/^@/, "")
        : (candidates[0]?.username ?? source.value);
      if (searchQuery) {
        try {
          const profileProxy = { host: (profile as any).proxyHost, port: (profile as any).proxyPort, username: (profile as any).proxyUsername, password: (profile as any).proxyPassword, type: (profile as any).proxyType };
          const browserOk = await this.searchUserViaBrowser(profile.id, searchQuery, profileProxy, (profile as any).igApiCookies ?? null, {
            userAgent: profile.userAgentEmbedded ?? null, apiUA: profile.userAgentApi ?? null, ebFingerprint: (profile as any).ebFingerprint ?? null,
          });
          if (!browserOk) await client.searchUserByUsername(searchQuery);
          engineLog("INFO", `@${profile.username}: injected user search for "${searchQuery}" before first follow${browserOk ? " [browser]" : " [mobile API]"}`);
        } catch { /* non-critical */ }
      }
    }

    let followed = 0, dedupSkipped = 0, filterSkipped = 0, blocked = 0, skipped = 0;
    let hitHardLimit = false; // true when a real cap/block/stop occurred (not just ran out of candidates)

    // Helper: browse the target user's profile — visit, scroll feed, open/like/save posts,
    // optionally watch stories and highlights, and optionally post a comment.
    // Used for both the between-follows injection and the before-follow browse.
    const browseTargetProfile = async (label: string, targetUser: { pk: string; username: string }) => {
      // Visible marker so the user always sees the browse start in the activity log,
      // even when individual sub-actions fail silently.
      engineLog("INFO", `@${profile.username}: [${label}] starting profile browse of @${targetUser.username} (pk=${targetUser.pk})`);
      this.logAction(profile.id, tool.id, "browse_profile", targetUser.username, "", "profile", "ok", `Profile browsing started`);

      // 1. Visit profile — always first, not in queue
      try {
        await client.visitUserProfile(targetUser.pk, "profile");
        engineLog("INFO", `@${profile.username}: [${label}] visited profile of @${targetUser.username}`);
        this.logAction(profile.id, tool.id, "visit_profile", targetUser.username, "", "profile", "ok", `Visited profile`);
      } catch (err: any) {
        engineLog("WARN", `@${profile.username}: [${label}] visitUserProfile failed: ${err?.message ?? err}`);
        this.logAction(profile.id, tool.id, "browse_profile", targetUser.username, "", "profile", "error", `visitProfile failed: ${err?.message ?? err}`);
      }

      // 2. Scroll feed — gated by chance %; feeds profilePosts for engagement actions
      const feedChance = randInt(injectProfileBrowsingFeedChanceMin, injectProfileBrowsingFeedChanceMax);
      const feedCount = randInt(injectProfileBrowsingFeedMin, injectProfileBrowsingFeedMax);
      let profilePosts: Array<{ mediaId: string; shortcode: string; username: string }> = [];
      if (Math.random() * 100 < feedChance) {
        try {
          profilePosts = useHikerHumanSessionFeed
            ? await hikerClient!.getUserFeedByUserId(targetUser.pk, feedCount)
            : await client.viewUserFeed(targetUser.pk, feedCount);
          engineLog("INFO", `@${profile.username}: [${label}] scrolled ${profilePosts.length} post(s) on @${targetUser.username}'s profile${useHikerHumanSessionFeed ? " [HikerAPI]" : ""}`);
          this.logAction(profile.id, tool.id, "view_user_feed", targetUser.username, "", "profile", "ok", `Scrolled ${profilePosts.length} posts`);
        } catch (err: any) {
          engineLog("WARN", `@${profile.username}: [${label}] viewUserFeed failed: ${err?.message ?? err}`);
          this.logAction(profile.id, tool.id, "browse_profile", targetUser.username, "", "profile", "error", `viewFeed failed: ${err?.message ?? err}`);
        }
      }

      // 3. Build ordered engagement queue — each action draws a random order value from
      //    its OrderMin/OrderMax range. Higher order = runs first (same convention as Human Session tool).
      type BrowseQueueEntry = { order: number; actionLabel: string; run: () => Promise<void> };
      const queue: BrowseQueueEntry[] = [];

      const enqueue = (
        actionLabel: string,
        orderMin: number, orderMax: number,
        fn: () => Promise<void>,
      ) => {
        queue.push({ order: randInt(orderMin, orderMax), actionLabel, run: fn });
      };

      // Click Feed Posts — pick N random posts from the scrolled list, open each one,
      // and optionally like it while viewing. Likes are wired to the post-click view
      // (not a separate queue action) so they fire only when a post is actually opened.
      if (injectProfileBrowsingClickPostMax > 0 && profilePosts.length > 0) {
        enqueue("click feed posts",
          Number(s.injectProfileBrowsingFeedOrderMin ?? 0), Number(s.injectProfileBrowsingFeedOrderMax ?? 0),
          async () => {
            const clickCount = Math.min(
              randInt(injectProfileBrowsingClickPostMin, injectProfileBrowsingClickPostMax),
              profilePosts.length,
            );
            if (clickCount <= 0) return;
            // Pick a random sample of posts without replacement.
            const shuffled = [...profilePosts].sort(() => Math.random() - 0.5);
            const toClick = shuffled.slice(0, clickCount);
            engineLog("INFO", `@${profile.username}: [${label}] clicking ${clickCount} post(s) from @${targetUser.username}'s profile`);
            for (const post of toClick) {
              try {
                await client.viewFeedPost(post.mediaId);
                engineLog("INFO", `@${profile.username}: [${label}] opened post ${post.shortcode} from @${targetUser.username}'s profile`);
                this.logAction(profile.id, tool.id, "view_profile_post", targetUser.username, post.shortcode, "post", "ok", `Clicked post from profile`);
                // Apply like inside the clicked post view if configured.
                if (injectProfileBrowsingLikePctMax > 0) {
                  const likePct = randInt(injectProfileBrowsingLikePctMin, injectProfileBrowsingLikePctMax);
                  if (Math.random() * 100 < likePct) {
                    try {
                      const likeResult = await client.likeMedia(post.mediaId, targetUser.username);
                      if (likeResult && likeResult !== "blocked") {
                        engineLog("INFO", `@${profile.username}: [${label}] liked post ${post.shortcode} from @${targetUser.username}`);
                        this.logAction(profile.id, tool.id, "like", targetUser.username, post.shortcode, "post", "ok", `Liked post from profile browse`);
                        await storage.incrementStat(profile.id, "like");
                      }
                    } catch { /* non-critical */ }
                  }
                }
              } catch { /* non-critical */ }
            }
          },
        );
      }

      // Save media
      if (injectProfileBrowsingSaveMediaPctMax > 0 && profilePosts.length > 0) {
        enqueue("save media",
          Number(s.injectProfileBrowsingSaveMediaPctOrderMin ?? 0), Number(s.injectProfileBrowsingSaveMediaPctOrderMax ?? 0),
          async () => {
            const savePct = randInt(injectProfileBrowsingSaveMediaPctMin, injectProfileBrowsingSaveMediaPctMax);
            const saveScrollCap = injectProfileBrowsingSaveMediaScrollMax > 0 ? randInt(injectProfileBrowsingSaveMediaScrollMin, injectProfileBrowsingSaveMediaScrollMax) : profilePosts.length;
            const savePosts = profilePosts.slice(0, saveScrollCap);
            for (const post of savePosts) {
              if (Math.random() * 100 < savePct) {
                try {
                  const saved = await client.saveMedia(post.mediaId);
                  if (saved) {
                    engineLog("INFO", `@${profile.username}: [${label}] saved post ${post.shortcode} from @${targetUser.username}`);
                    this.logAction(profile.id, tool.id, "save_media", targetUser.username, post.shortcode, "post", "ok", `Saved post from profile browse`);
                  }
                } catch { /* non-critical */ }
              }
            }
          },
        );
      }

      // Watch stories
      if (injectProfileBrowsingWatchStoriesPctMax > 0) {
        enqueue("watch stories",
          Number(s.injectProfileBrowsingWatchStoriesPctOrderMin ?? 0), Number(s.injectProfileBrowsingWatchStoriesPctOrderMax ?? 0),
          async () => {
            const storiesPct = randInt(injectProfileBrowsingWatchStoriesPctMin, injectProfileBrowsingWatchStoriesPctMax);
            if (Math.random() * 100 < storiesPct) {
              try {
                const storiesUrl = await client.viewStories(targetUser.pk, targetUser.username);
                if (storiesUrl) {
                  engineLog("INFO", `@${profile.username}: [${label}] watched stories of @${targetUser.username}`);
                  this.logAction(profile.id, tool.id, "view_stories", targetUser.username, "", "story", "ok", `Watched stories from profile browse`);
                  await storage.incrementStat(profile.id, "story");
                }
              } catch (err: any) {
                const msg: string = err?.message ?? "";
                if (/session_expired|login_required/i.test(msg)) {
                  console.warn(`[engine] @${profile.username}: [${label}] viewStories — ${msg} — marking logged_out`);
                  await this.applyAccountLevelError(profile.id, msg, state, tool.id);
                } else {
                  engineLog("WARN", `@${profile.username}: [${label}] viewStories failed: ${msg}`);
                  this.logAction(profile.id, tool.id, "browse_profile", targetUser.username, "", "story", "error", `watchStories failed: ${msg}`);
                }
              }
            }
          },
        );
      }

      // View highlights
      if (injectProfileBrowsingViewHighlightsPctMax > 0) {
        enqueue("view highlights",
          Number(s.injectProfileBrowsingViewHighlightsPctOrderMin ?? 0), Number(s.injectProfileBrowsingViewHighlightsPctOrderMax ?? 0),
          async () => {
            const highlightsPct = randInt(injectProfileBrowsingViewHighlightsPctMin, injectProfileBrowsingViewHighlightsPctMax);
            if (Math.random() * 100 < highlightsPct) {
              try {
                const hlUrl = await client.viewHighlights(targetUser.pk, targetUser.username);
                if (hlUrl) {
                  engineLog("INFO", `@${profile.username}: [${label}] viewed highlights of @${targetUser.username}`);
                  this.logAction(profile.id, tool.id, "view_highlights", targetUser.username, "", "highlight", "ok", `Viewed highlights from profile browse`);
                }
              } catch (err: any) {
                const msg: string = err?.message ?? "";
                if (/session_expired|login_required/i.test(msg)) {
                  console.warn(`[engine] @${profile.username}: [${label}] viewHighlights — ${msg} — marking logged_out`);
                  await this.applyAccountLevelError(profile.id, msg, state, tool.id);
                } else {
                  engineLog("WARN", `@${profile.username}: [${label}] viewHighlights failed: ${msg}`);
                  this.logAction(profile.id, tool.id, "browse_profile", targetUser.username, "", "highlight", "error", `viewHighlights failed: ${msg}`);
                }
              }
            }
          },
        );
      }

      // View reels
      if (injectProfileBrowsingViewReelsPctMax > 0) {
        enqueue("view reels",
          Number(s.injectProfileBrowsingViewReelsPctOrderMin ?? 0), Number(s.injectProfileBrowsingViewReelsPctOrderMax ?? 0),
          async () => {
            const reelsPct = randInt(injectProfileBrowsingViewReelsPctMin, injectProfileBrowsingViewReelsPctMax);
            if (Math.random() * 100 < reelsPct) {
              try {
                const ok = await client.viewReels(targetUser.pk, targetUser.username, true);
                if (ok) {
                  engineLog("INFO", `@${profile.username}: [${label}] viewed reels of @${targetUser.username}`);
                  this.logAction(profile.id, tool.id, "view_reels", targetUser.username, "", "reel", "ok", `Viewed reels from profile browse`);
                }
              } catch (err: any) {
                const msg: string = err?.message ?? "";
                if (/session_expired|login_required/i.test(msg)) {
                  console.warn(`[engine] @${profile.username}: [${label}] viewReels — ${msg} — marking logged_out`);
                  await this.applyAccountLevelError(profile.id, msg, state, tool.id);
                } else {
                  engineLog("WARN", `@${profile.username}: [${label}] viewReels failed: ${msg}`);
                  this.logAction(profile.id, tool.id, "browse_profile", targetUser.username, "", "reel", "error", `viewReels failed: ${msg}`);
                }
              }
            }
          },
        );
      }

      // Comment on a post (spintax supported, requires checkbox enabled)
      if (injectProfileBrowsingCommentEnabled && injectProfileBrowsingCommentPctMax > 0 && profilePosts.length > 0 && injectProfileBrowsingCommentText.trim()) {
        enqueue("comment",
          Number(s.injectProfileBrowsingCommentPctOrderMin ?? 0), Number(s.injectProfileBrowsingCommentPctOrderMax ?? 0),
          async () => {
            const commentPct = randInt(injectProfileBrowsingCommentPctMin, injectProfileBrowsingCommentPctMax);
            if (Math.random() * 100 < commentPct) {
              const post = profilePosts[Math.floor(Math.random() * profilePosts.length)];
              const commentText = this.spin(injectProfileBrowsingCommentText).trim();
              if (commentText) {
                try {
                  const commented = await client.postComment(post.mediaId, commentText);
                  if (commented) {
                    engineLog("INFO", `@${profile.username}: [${label}] commented on post ${post.shortcode} of @${targetUser.username}: "${commentText}"`);
                    this.logAction(profile.id, tool.id, "comment", targetUser.username, post.shortcode, "post", "ok", `Commented: ${commentText}`);
                    await storage.incrementStat(profile.id, "comment");
                  }
                } catch { /* non-critical */ }
              }
            }
          },
        );
      }

      // Share to Feed — clicks the double-arrow "share to own feed" button on a profile post
      if (injectProfileBrowsingShareToFeedPctMax > 0 && profilePosts.length > 0) {
        enqueue("share to feed",
          Number(s.injectProfileBrowsingShareToFeedPctOrderMin ?? 0), Number(s.injectProfileBrowsingShareToFeedPctOrderMax ?? 0),
          async () => {
            const sharePct = randInt(injectProfileBrowsingShareToFeedPctMin, injectProfileBrowsingShareToFeedPctMax);
            if (Math.random() * 100 < sharePct) {
              const post = profilePosts[Math.floor(Math.random() * profilePosts.length)];
              if (!post.mediaId) return;
              try {
                const shared = await client.sharePostToFeed(post.mediaId);
                if (shared) {
                  engineLog("INFO", `@${profile.username}: [${label}] shared post ${post.shortcode} of @${targetUser.username} to own feed`);
                  this.logAction(profile.id, tool.id, "share_post", targetUser.username, post.shortcode, "post", "ok", "Shared profile post to own feed from profile browse");
                }
              } catch { /* non-critical */ }
            }
          },
        );
      }

      // Share to DM — opens the DM picker
      if (injectProfileBrowsingShareToDmPctMax > 0) {
        enqueue("share to DM",
          Number(s.injectProfileBrowsingShareToDmPctOrderMin ?? 0), Number(s.injectProfileBrowsingShareToDmPctOrderMax ?? 0),
          async () => {
            const sharePct = randInt(injectProfileBrowsingShareToDmPctMin, injectProfileBrowsingShareToDmPctMax);
            if (Math.random() * 100 < sharePct) {
              try {
                await client.getDirectMessages(3);
                engineLog("INFO", `@${profile.username}: [${label}] opened DM share picker for @${targetUser.username}`);
                this.logAction(profile.id, tool.id, "share_to_dm", targetUser.username, "", "dm", "ok", `Opened DM share picker from profile browse`);
              } catch { /* non-critical */ }
            }
          },
        );
      }

      // Sort descending by order (higher = runs first), then execute sequentially
      queue.sort((a, b) => b.order - a.order);
      if (queue.length > 0) {
        engineLog("INFO", `@${profile.username}: [${label}] engagement queue for @${targetUser.username}: ${queue.map(e => e.actionLabel).join(" → ")}`);
        for (const entry of queue) {
          await entry.run();
        }
        engineLog("INFO", `@${profile.username}: [${label}] engagement queue complete for @${targetUser.username}`);
      } else {
        engineLog("INFO", `@${profile.username}: [${label}] no engagement actions configured (all counts/chances are 0) for @${targetUser.username}`);
      }
    };

    for (const user of candidates) {
      if (followed >= processCount) break;
      if (state.stop.stopped) { hitHardLimit = true; break; }
      if (maxPerDay > 0 && this.daily(state) >= maxPerDay) { console.log(`[engine] @${profile.username}: daily cap hit mid-session`); hitHardLimit = true; break; }
      if (maxPerHour > 0 && this.hourly(state) >= maxPerHour) { console.log(`[engine] @${profile.username}: hourly cap hit mid-session`); hitHardLimit = true; await sleep(3_600_000); break; }

      // Re-read accountStatus from DB before each user — catches mid-session
      // status changes (from previous-action errors or external updates) so the
      // engine never attempts an API call on a non-valid account.
      {
        const liveStatus = (await storage.getProfile(profile.id))?.accountStatus;
        if (liveStatus && liveStatus !== "valid") {
          engineLog("WARN", `@${profile.username}: accountStatus changed to "${liveStatus}" mid-session — aborting follow session`);
          hitHardLimit = true;
          break;
        }
      }

      // Dedup check (per-profile)
      if (await this.alreadyFollowed(profile.id, user.username)) {
        this.logAction(profile.id, tool.id, "dedup_skip", user.username, source.value, source.type, "skipped", "Already followed previously");
        dedupSkipped++;
        continue;
      }

      // Global filter: skip if globally followed by any profile
      if (globalSkipFollowed && await storage.isGloballyFollowed(user.username)) {
        const followerLabel = await storage.getGlobalFollowerLabel(user.username);
        const detail = followerLabel ? `Skipped, followed by @${followerLabel}` : "Skipped, followed by another profile";
        console.log(`[engine] @${profile.username}: skip @${user.username} — ${detail}`);
        this.logAction(profile.id, tool.id, "dedup_skip", user.username, source.value, source.type, "skipped", detail);
        dedupSkipped++;
        continue;
      }

      // Global filter: skip if in the global skipped-users list
      if (globalSkipSkipped && await storage.isGloballySkipped(user.username)) {
        console.log(`[engine] @${profile.username}: skip @${user.username} — in global skip list`);
        this.logAction(profile.id, tool.id, "filter_skip", user.username, source.value, source.type, "skipped", "In global skip list");
        filterSkipped++;
        continue;
      }

      // Tool filter: skip Indian users — use fullName already in scrape payload, no extra API call
      if (toolSkipIndian) {
        const fullName = user.fullName ?? "";
        if (this.hasIndianScript(fullName)) {
          console.log(`[engine] @${profile.username}: skip @${user.username} — Indian script in name`);
          this.logAction(profile.id, tool.id, "filter_skip", user.username, source.value, source.type, "skipped", "Indian script in name");
          await storage.addSkippedUser(user.username, "Indian script in name");
          filterSkipped++;
          continue;
        }
      }

      // Inject GetSuggestedUsers and/or searchUserByUsername before some follows.
      // RULE: searchUserByUsername must NEVER fire immediately before getSuggestedUsers —
      // that is not a real app flow (you cannot reach suggested users from the search bar).
      // So we roll for getSuggestedUsers first; if it fires we skip the search injection for
      // this follow slot entirely.
      {
        let suggestedFired = false;

        if (injectSuggestedEnabled && injectSuggestedSlots.has(followed)) {
          console.log(`[getSuggestedUsers] @${profile.username} — injecting at follow #${followed + 1}`);
          try {
            await client.getSuggestedUsers();
            console.log(`[getSuggestedUsers] @${profile.username} — OK`);
            engineLog("INFO", `@${profile.username}: injected getSuggestedUsers before follow #${followed + 1}`);
            suggestedFired = true;
          } catch (e: any) {
            console.log(`[getSuggestedUsers] @${profile.username} — FAILED: ${e?.message ?? e}`);
            engineLog("WARN", `@${profile.username}: getSuggestedUsers failed (non-critical): ${e?.name ?? "Error"}: ${e?.message ?? e}`);
          }
        }

        // Only inject search if getSuggestedUsers did NOT fire this slot
        if (!suggestedFired && injectSearchEnabled && injectSearchMidSlots.has(followed)) {
          try {
            const profileProxy = { host: (profile as any).proxyHost, port: (profile as any).proxyPort, username: (profile as any).proxyUsername, password: (profile as any).proxyPassword, type: (profile as any).proxyType };
            const browserOk = await this.searchUserViaBrowser(profile.id, user.username, profileProxy, (profile as any).igApiCookies ?? null, {
              userAgent: profile.userAgentEmbedded ?? null, apiUA: profile.userAgentApi ?? null, ebFingerprint: (profile as any).ebFingerprint ?? null,
            });
            if (!browserOk) await client.searchUserByUsername(user.username);
            engineLog("INFO", `@${profile.username}: injected searchUserByUsername("${user.username}") before follow #${followed + 1}${browserOk ? " [browser]" : " [mobile API]"}`);
          } catch { /* non-critical */ }
        }
      }

      // Browse before follow — fires on pre-calculated slots (browsePct % of processCount).
      if (injectProfileBrowsingEnabled && injectBrowseSlots.has(followed)) {
        // Re-check global skip immediately before browsing — the inject suggested/search
        // calls above can take several seconds, during which another profile may have
        // followed this user and recorded them as globally followed. Checking here ensures
        // we never browse (or follow) a user who was picked up by another profile in that window.
        if (globalSkipFollowed && await storage.isGloballyFollowed(user.username)) {
          const followerLabel = await storage.getGlobalFollowerLabel(user.username);
          const detail = followerLabel ? `Skipped, followed by @${followerLabel}` : "Skipped, followed by another profile";
          console.log(`[engine] @${profile.username}: skip browse @${user.username} — ${detail} (caught before browse)`);
          this.logAction(profile.id, tool.id, "dedup_skip", user.username, source.value, source.type, "skipped", detail);
          dedupSkipped++;
          continue;
        }
        await browseTargetProfile("pre-follow browse", user);
        // Abandon follow after browsing — still uses its own per-instance probability
        if (injectProfileBrowsingAbandonFollow) {
          const abandonThreshold = randInt(injectProfileBrowsingAbandonPctMin, injectProfileBrowsingAbandonPctMax);
          if (Math.random() * 100 < abandonThreshold) {
            engineLog("INFO", `@${profile.username}: abandoned follow @${user.username} after profile browse (abandon chance fired)`);
            skipped++;
            continue;
          }
        }
      }

      // Check if the follow action itself is currently suspended.
      // Moved here (right before followUser) instead of before the browse-injection block above,
      // so pre-follow browse/search/suggested injections still run even while follow is suspended —
      // a suspended follow tool should not also silently disable its human-behaviour injections.
      if (this.isActionSuspended(state, "follow")) {
        const rem = this.suspensionRemaining(state, "follow");
        console.log(`[engine] @${profile.username}: follow suspended (${rem} remaining) — skipping session`);
        this.logAction(profile.id, tool.id, "follow_blocked", user.username, source.value, source.type, "skipped", `Follow suspended ${rem} remaining`);
        blocked++;
        hitHardLimit = true; break;
      }

      // Follow
      let result: { ok: boolean; status?: string; reason?: string };
      try {
        const sourceLabel = source.value ? (source.type === "hashtag" ? `#${source.value}` : source.value) : undefined;
        if ((profile as any).followViaBrowser) {
          result = await this.followUserViaBrowser(profile.id, user.username, {
            host: (profile as any).proxyHost, port: (profile as any).proxyPort,
            username: (profile as any).proxyUsername, password: (profile as any).proxyPassword,
            type: (profile as any).proxyType,
          }, (profile as any).igApiCookies ?? null, {
            userAgent: profile.userAgentEmbedded ?? null, apiUA: profile.userAgentApi ?? null, ebFingerprint: (profile as any).ebFingerprint ?? null,
          });
        } else {
          result = await client.followUser(user.pk, user.username, sourceLabel);
        }
      } catch (err: any) {
        const msg = err?.message ?? "";
        const acctStatus = await this.applyAccountLevelError(profile.id, msg, state, tool.id);
        if (acctStatus) {
          console.warn(`[engine] @${profile.username}: follow threw account-level error (${acctStatus}) — ${msg}`);
          this.logAction(profile.id, tool.id, "follow_blocked", user.username, source.value, source.type, "error", `[${acctStatus}] ${msg}`);
          break;
        }
        console.error(`[engine] @${profile.username}: follow @${user.username} threw: ${msg}`);
        this.logAction(profile.id, tool.id, "follow", user.username, source.value, source.type, "error", msg);
        continue;
      }

      if (result.status === "checkpoint_required") {
        const cpUrl = (result as any).checkpointUrl ?? "";
        console.warn(`[engine] @${profile.username}: checkpoint_required — setting status to captcha. Complete the challenge in the embedded browser.${cpUrl ? ` URL: ${cpUrl}` : ""}`);
        this.logAction(profile.id, tool.id, "follow_blocked", user.username, source.value, source.type, "skipped", `Captcha / security challenge required  complete in embedded browser`);
        // Mark account as captcha so the UI shows it and the runner pauses sessions
        await storage.updateProfile(profile.id, { accountStatus: "captcha", statusMessage: "Checkpoint / security challenge required — complete in embedded browser" });
        hitHardLimit = true; break;
      }

      // Browser-follow reports "checkpoint_detected" when the hidden window landed on an
      // Instagram checkpoint / suspicious-activity page rather than the target's profile.
      // Previously this had no distinct status and fell through as a generic "follow_blocked"
      // "Follow button not found" skip — the session then kept queuing MORE follow attempts
      // against an account Instagram had already flagged mid-session. Continuing automated
      // actions on a flagged account through an active challenge is what escalates a soft
      // checkpoint into a full suspension. Treat it the same as checkpoint_required: stop
      // the session immediately and require manual review via the embedded browser.
      if (result.status === "checkpoint_detected") {
        console.warn(`[engine] @${profile.username}: checkpoint_detected via browser-follow on @${user.username} — halting session, setting status to captcha`);
        this.logAction(profile.id, tool.id, "follow_blocked", user.username, source.value, source.type, "skipped", "Instagram checkpoint/suspicious-activity page detected (complete review in embedded browser)");
        await storage.updateProfile(profile.id, { accountStatus: "captcha", statusMessage: "Checkpoint / suspicious-activity page detected during browser follow (complete review in embedded browser)" });
        hitHardLimit = true; break;
      }

      if (result.status === "user_not_found") {
        const reason = result.reason ?? `user ${user.username} not found (404)`;
        console.warn(`[engine] @${profile.username}: follow skipped @${user.username} — deleted/non-existent user (404)`);
        this.logAction(profile.id, tool.id, "follow_skipped", user.username, source.value, source.type, "skipped", `Stale user ID: account deleted or not found: ${reason}`);
        skipped++;
        if (followed + skipped + blocked >= processCount) break;
        continue;
      }

      if (result.status === "follow_blocked") {
        const reason = result.reason ?? "Instagram declined";
        console.warn(`[engine] @${profile.username}: follow blocked @${user.username} — ${reason}`);
        blocked++;

        // Session expired — mark logged_out and abort immediately.
        // "session expired — re-verify account" is the string returned by followUser when
        // the mobile API responds with login_required / 401, so we also match that phrase.
        if (reason.includes("login_required") || reason.includes("session expired") || reason.includes("logged out") || reason.includes("logout")) {
          console.warn(`[engine] @${profile.username}: session expired — marking logged_out, aborting session`);
          await storage.updateProfile(profile.id, { accountStatus: "logged_out", statusMessage: reason.slice(0, 500) });
          this.logAction(profile.id, tool.id, "logged_out", "", "", "", "error", reason.slice(0, 300));
          state.client = null;
          hitHardLimit = true; break;
        }

        // Explicit Instagram account-level block (feedback_required / "Please wait" / 404 on friendship.create).
        // "api_error:" prefix = technical/transient rejection (bad signature, server hiccup, etc.) — NOT a real block,
        // do NOT suspend. Only suspend on confirmed block signals or 404 on friendship.create endpoint.
        // For legit blocks, recordActionBlock logs the suspension entry — we do NOT also log a separate follow_blocked entry.
        const isApiError = reason.startsWith("api_error:");
        const isLegitBlock = !isApiError && (reason.includes("Please wait") || reason.includes("feedback_required") || reason.includes("friendship.create"));
        if (isLegitBlock) {
          const isFeedbackRequired = reason.includes("feedback_required");
          // Jarvee "Auto Verify Automatic Behaviour Detected": if the block is a soft
          // feedback_required ABD warning, try to dismiss it via the challenge endpoint
          // before applying the 24-hour suspension. If dismiss succeeds the session continues.
          if (isFeedbackRequired && state.client) {
            await storage.updateProfile(profile.id, { accountStatus: "automated_behaviour_detected" });
            const abdOk = await state.client.tryDismissABD();
            if (abdOk) {
              await storage.updateProfile(profile.id, { accountStatus: "valid" });
              await storage.incrementStat(profile.id, "abd");
              console.log(`[engine] @${profile.username}: ABD auto-dismissed ✓ — continuing session`);
              this.logAction(profile.id, tool.id, "abd_dismissed", user.username, source.value, source.type, "ok", "Automated Behavior warning auto-dismissed (session continues)");
              await sleep(5000); // brief cooldown after dismiss
              continue; // don't suspend, keep going with the next candidate
            }
            await storage.updateProfile(profile.id, { accountStatus: "valid" });
          }
          // recordActionBlock logs "follow_suspension" with the suspension detail (replaces the old follow_blocked + action_suspended pair).
          this.recordActionBlock(state, profile.id, tool.id, "follow", "Follow", user.username, source.value, source.type);
          // Only update toolBlockedUntil for real Action Blocked errors, NOT for ABD (feedback_required) soft warnings.
          if (!isFeedbackRequired && s.stopOnBlockEnabled && (s.stopOnBlockMinutes ?? 0) > 0) {
            const _blockedUntilMs = Date.now() + (s.stopOnBlockMinutes * 60_000);
            await storage.updateTool(tool.id, { settings: { ...s, toolBlockedUntil: _blockedUntilMs } });
          }
          hitHardLimit = true; break; // Abort session immediately when legitimately blocked
        }

        // Catch-all: unclassified block error (e.g. "200 undefined", transient errors) — log it.
        // Do NOT trigger Stop Tool if Blocked — these are not real "Action Blocked" prompts.
        this.logAction(profile.id, tool.id, "follow_blocked", user.username, source.value, source.type, "skipped", reason);
        if (followed + blocked >= processCount) break;

        // Always delay between attempts — even on block — to avoid hammering Instagram
        await sleep(randInt(followMin, followMax));
        continue;
      }

      // Browser follow reports "already following" as ok:true + status:"already_following" —
      // treat it the same as a skip so it doesn't count as a new follow in stats. Self-heal
      // the DB record too since it means our followedUsers table missed this relationship.
      if (result.status === "already_following") {
        console.log(`[engine] @${profile.username}: skip @${user.username} (already following via browser)`);
        this.logAction(profile.id, tool.id, "follow_skipped", user.username, source.value, source.type, "skipped", `Already following @${user.username} (confirmed via browser) — skipped, trying next candidate instead`);
        storage.createFollowedUser({
          profileId: profile.id,
          instagramUsername: user.username,
          instagramUserId: String(user.pk ?? ""),
          sourceValue: source.value,
          sourceType: source.type,
          followedAt: new Date().toISOString(),
        }).catch(() => {});
        skipped++;
        continue;
      }

      if (!result.ok) {
        // Mobile API returned ok:false with no matched status/reason above (rare) — this is a
        // genuine unclassified failure, not a confirmed "already following"/"private" state, so
        // don't mislabel it. The raw reason (if any) is included for diagnosis.
        const rawReason = (result as any).reason ? `: ${(result as any).reason}` : " (no reason returned by Instagram)";
        console.log(`[engine] @${profile.username}: skip @${user.username} — follow attempt failed${rawReason}`);
        this.logAction(profile.id, tool.id, "follow_skipped", user.username, source.value, source.type, "skipped", `Follow attempt failed for @${user.username}${rawReason} — skipped, trying next candidate instead`);
        skipped++;
        continue;
      }

      // Record successful follow (store pk so unfollow never needs to look it up)
      try {
        await storage.createFollowedUser({
          profileId: profile.id,
          instagramUsername: user.username,
          instagramUserId: String(user.pk ?? ""),
          sourceValue: source.value,
          sourceType: source.type,
          followedAt: new Date().toISOString(),
        });
      } catch (dbErr: any) {
        console.error(`[engine] @${profile.username}: failed to persist followed user @${user.username}: ${dbErr?.message}`);
      }
      this.logAction(profile.id, tool.id, "follow", user.username, source.value, source.type, "ok", `Followed [${followed + 1}/${processCount}] users`);
      // Browser-follows bypass the private API client so they never land in instagram_api_calls.
      // Write a synthetic entry so the stats pie chart counts them correctly.
      if ((profile as any).followViaBrowser) {
        storage.createInstagramApiCall({
          profileId: profile.id,
          username: profile.username,
          operationName: "FollowedUser",
          date: new Date().toISOString(),
          source: "browser",
          transport: "browser",
          isError: false,
        }).catch(() => {});
      }
      try {
        await storage.incrementStat(profile.id, "follow");
      } catch (statErr: any) {
        console.error(`[engine] @${profile.username}: ⚠ incrementStat("follow") failed — stat NOT recorded for @${user.username}: ${statErr?.message}`);
      }
      this.bump(state);
      followed++;

      console.log(`[engine] @${profile.username}: ✓ @${user.username} [${followed}/${processCount}] day:${state.dailyCount}`);

      // Post-follow profile browsing — browse the target's profile after successfully following them.
      // Skipped when Browse Before Follow already ran for this slot (followed - 1 is the pre-increment
      // index) — no need to browse the same profile twice in one session.
      if (injectProfileBrowsingEnabled && !injectBrowseSlots.has(followed - 1)) {
        const threshold = randInt(injectProfileBrowsingMin, injectProfileBrowsingMax);
        if (Math.random() * 100 < threshold) {
          engineLog("INFO", `@${profile.username}: post-follow profile browsing for @${user.username}`);
          await browseTargetProfile("post-follow browse", user);
        }
      }

      // Inter-follow delay after every successful follow
      await sleep(randInt(followMin, followMax));
    }

    // Re-scrape additional pages to fill the quota when users were skipped by other profiles.
    // Rotates through ALL sources of the same type instead of hammering the same source
    // repeatedly. Each round picks the next available (non-exhausted) source.
    // seenFollowerPksBySource tracks PKs per target-follower source so we can request
    // progressively deeper slices without re-processing users we already saw.
    const sameTypeSources = sources.filter(s => s.type === source.type);
    const initialSourceIdx = sameTypeSources.findIndex(s => s.id === source.id);
    const exhaustedSourceIds = new Set<string>();
    const seenFollowerPksBySource = new Map<string, Set<string>>();
    seenFollowerPksBySource.set(source.id, new Set(candidates.map(c => c.pk)));
    const sourceRoundCount = new Map<string, number>();
    if (!hitHardLimit && followed < processCount && !state.stop.stopped) {
      let extraRound = 0;
      while (followed < processCount && !hitHardLimit && !state.stop.stopped && extraRound < maxExtraRounds) {
        extraRound++;
        const availableSources = sameTypeSources.filter(s => !exhaustedSourceIds.has(s.id));
        if (!availableSources.length) break;
        // Rotate: start from the source AFTER the initial one so the first re-scrape
        // round always tries a fresh source (wraps back when only one source exists).
        const rescrapeSource = availableSources[(initialSourceIdx + extraRound) % availableSources.length];
        const needMore = processCount - followed;
        let moreCandidates: { pk: string; username: string; fullName: string }[] = [];
        // rawApiCount: users returned by the API BEFORE dedup.  Declared here so the
        // exhaustion check below can see it.  Non-hashtag branches leave it -1, which
        // triggers the legacy "exhaust on empty" behaviour for those source types.
        let rawApiCount = -1;
        try {
          if (rescrapeSource.type === "hashtag" && hikerClient) {
            const t0 = Date.now();
            const globalCursor = await storage.getHashtagCursor(rescrapeSource.value);
            const result = await hikerClient.getHashtagUsers(rescrapeSource.value, needMore + 5, globalCursor);
            moreCandidates = result.users;
            rawApiCount = result.users.length;
            if (result.nextCursor) {
              await storage.setHashtagCursor(rescrapeSource.value, result.nextCursor).catch(() => {});
            } else if (globalCursor) {
              await storage.setHashtagCursor(rescrapeSource.value, "").catch(() => {});
            }
            if (moreCandidates.length > 0) {
              const ignoreDays = parseInt(globalSettings.scrapedUserIgnoreDays ?? "30", 10);
              const alreadyScraped = await storage.getScrapedUserIds(moreCandidates.map(c => c.pk), ignoreDays);
              const beforeDedup = moreCandidates.length;
              const fresh = moreCandidates.filter(c => !alreadyScraped.has(c.pk));
              await storage.addScrapedUsers(fresh).catch(() => {});
              moreCandidates = fresh;
              if (beforeDedup !== moreCandidates.length) {
                engineLog("INFO", `@${profile.username}: hashtag dedup (rescrape round ${extraRound}) — ${beforeDedup - moreCandidates.length} already-scraped removed from #${rescrapeSource.value} (${moreCandidates.length} fresh remaining)`);
              }
            }
            logHiker("HashtagScrape", `Re-scrape round ${extraRound} #${rescrapeSource.value} via HikerAPI (${moreCandidates.length} users, ${rawApiCount} raw)`, Date.now() - t0);
          } else if (rescrapeSource.type === "target_followers" && hikerClient && rescrapeSource.targetUserId) {
            if (!seenFollowerPksBySource.has(rescrapeSource.id)) {
              seenFollowerPksBySource.set(rescrapeSource.id, new Set());
            }
            const seenPks = seenFollowerPksBySource.get(rescrapeSource.id)!;
            const roundsOnSource = (sourceRoundCount.get(rescrapeSource.id) ?? 0) + 1;
            sourceRoundCount.set(rescrapeSource.id, roundsOnSource);
            const t0 = Date.now();
            const requestMore = (roundsOnSource + 1) * (processCount + 5) + needMore;
            const allFollowers = await hikerClient.getFollowers(rescrapeSource.targetUserId, Math.min(requestMore, 200));
            moreCandidates = allFollowers.filter(u => !seenPks.has(u.pk));
            moreCandidates.forEach(u => seenPks.add(u.pk));
            if (globalSettings.skipScrapedUsers === "true" && moreCandidates.length > 0) {
              const ignoreDays = parseInt(globalSettings.scrapedUserIgnoreDays ?? "365", 10);
              const alreadyScraped = await storage.getScrapedUserIds(moreCandidates.map(c => c.pk), ignoreDays);
              const fresh = moreCandidates.filter(c => !alreadyScraped.has(c.pk));
              await storage.addScrapedUsers(fresh).catch(() => {});
              moreCandidates = fresh;
            }
            logHiker("FollowersScrape", `Re-scrape round ${extraRound} followers of @${rescrapeSource.value} via HikerAPI (${allFollowers.length} total, ${moreCandidates.length} new)`, Date.now() - t0);
          }
        } catch { break; }
        if (!moreCandidates.length) {
          // Only mark a hashtag source exhausted when the API itself returned 0 users
          // (rawApiCount === 0 → truly empty page at this cursor).
          // If the API DID return users but all were filtered by dedup (rawApiCount > 0),
          // the cursor was already advanced to the next page — don't exhaust it.
          // For non-hashtag source types rawApiCount stays -1, so they use the old
          // "exhaust on empty moreCandidates" behaviour unchanged.
          // rawApiCount > 0  → API returned users but ALL were filtered by dedup
          //                    → cursor already advanced, next round fetches next page
          //                    → do NOT exhaust the source
          // rawApiCount === 0 → API returned nothing → hashtag feed is truly empty at
          //                    this cursor → exhaust the source
          // rawApiCount === -1 → non-hashtag source (legacy path) → exhaust as before
          if (rawApiCount <= 0) {
            exhaustedSourceIds.add(rescrapeSource.id);
          }
          continue;
        }
        engineLog("INFO", `@${profile.username}: re-scrape round ${extraRound} #${rescrapeSource.value} — ${moreCandidates.length} new candidates (need ${needMore} more)`);
        for (const user of moreCandidates) {
          if (followed >= processCount || state.stop.stopped || hitHardLimit) break;
          if (maxPerDay > 0 && this.daily(state) >= maxPerDay) { hitHardLimit = true; break; }
          if (maxPerHour > 0 && this.hourly(state) >= maxPerHour) { hitHardLimit = true; break; }
          if (await this.alreadyFollowed(profile.id, user.username)) { dedupSkipped++; continue; }
          if (globalSkipFollowed && await storage.isGloballyFollowed(user.username)) { dedupSkipped++; continue; }
          if (globalSkipSkipped && await storage.isGloballySkipped(user.username)) { filterSkipped++; continue; }
          if (toolSkipIndian && this.hasIndianScript(user.fullName ?? "")) {
            await storage.addSkippedUser(user.username, "Indian script in name");
            filterSkipped++; continue;
          }
          if (this.isActionSuspended(state, "follow")) { hitHardLimit = true; break; }
          let result: { ok: boolean; status?: string; reason?: string };
          try {
            const sourceLabel = rescrapeSource.value ? (rescrapeSource.type === "hashtag" ? `#${rescrapeSource.value}` : rescrapeSource.value) : undefined;
            if ((profile as any).followViaBrowser) {
              result = await this.followUserViaBrowser(profile.id, user.username, {
                host: (profile as any).proxyHost, port: (profile as any).proxyPort,
                username: (profile as any).proxyUsername, password: (profile as any).proxyPassword,
                type: (profile as any).proxyType,
              }, (profile as any).igApiCookies ?? null, {
                userAgent: profile.userAgentEmbedded ?? null, apiUA: profile.userAgentApi ?? null, ebFingerprint: (profile as any).ebFingerprint ?? null,
              });
            } else {
              result = await client.followUser(user.pk, user.username, sourceLabel);
            }
          } catch (err: any) {
            const msg = err?.message ?? "";
            const acctStatus = await this.applyAccountLevelError(profile.id, msg, state, tool.id);
            if (acctStatus) hitHardLimit = true;
            this.logAction(profile.id, tool.id, "follow", user.username, rescrapeSource.value, rescrapeSource.type, "error", msg);
            if (hitHardLimit) break; continue;
          }
          if (result.status === "checkpoint_required") {
            await storage.updateProfile(profile.id, { accountStatus: "captcha", statusMessage: "Checkpoint / security challenge required — complete in embedded browser" });
            hitHardLimit = true; break;
          }
          // See the primary-round handler above for the full rationale: a browser-follow
          // that lands on an IG checkpoint/suspicious-activity page must halt the session
          // immediately rather than being treated as a generic "button not found" skip,
          // or the re-scrape loop keeps hammering an already-flagged account.
          if (result.status === "checkpoint_detected") {
            console.warn(`[engine] @${profile.username}: checkpoint_detected via browser-follow (rescrape) on @${user.username} — halting session, setting status to captcha`);
            this.logAction(profile.id, tool.id, "follow_blocked", user.username, rescrapeSource.value, rescrapeSource.type, "skipped", "Instagram checkpoint/suspicious-activity page detected (complete review in embedded browser)");
            await storage.updateProfile(profile.id, { accountStatus: "captcha", statusMessage: "Checkpoint / suspicious-activity page detected during browser follow (complete review in embedded browser)" });
            hitHardLimit = true; break;
          }
          if (result.status === "follow_blocked") {
            blocked++;
            const reason = result.reason ?? "Instagram declined";
            if (reason.includes("login_required") || reason.includes("session expired") || reason.includes("logged out") || reason.includes("logout")) {
              await storage.updateProfile(profile.id, { accountStatus: "logged_out", statusMessage: reason.slice(0, 500) });
              this.logAction(profile.id, tool.id, "logged_out", "", "", "", "error", reason.slice(0, 300));
              state.client = null; hitHardLimit = true; break;
            }
            const isRescrapeABD = reason.includes("feedback_required");
            // "api_error:" = technical/transient rejection — NOT a real block, do not suspend.
            // 404 on /friendships/create/ is a hard follow block — treat same as "Please wait" / action blocked.
            // For legit blocks, recordActionBlock logs "follow_suspension" — no separate follow_blocked entry.
            if (!reason.startsWith("api_error:") && (reason.includes("Please wait") || isRescrapeABD || reason.includes("friendship.create"))) {
              // Jarvee ABD dismiss — try to acknowledge soft "Automated Behavior" warnings
              if (isRescrapeABD && state.client) {
                await storage.updateProfile(profile.id, { accountStatus: "automated_behaviour_detected" });
                const abdOk = await state.client.tryDismissABD();
                if (abdOk) {
                  await storage.updateProfile(profile.id, { accountStatus: "valid" });
                  await storage.incrementStat(profile.id, "abd");
                  console.log(`[engine] @${profile.username}: ABD auto-dismissed ✓ — continuing session`);
                  this.logAction(profile.id, tool.id, "abd_dismissed", user.username, rescrapeSource.value, rescrapeSource.type, "ok", "Automated Behavior warning auto-dismissed (session continues)");
                  await sleep(5000);
                  continue;
                }
                await storage.updateProfile(profile.id, { accountStatus: "valid" });
              }
              // recordActionBlock logs "follow_suspension" (replaces old follow_blocked + action_suspended pair).
              this.recordActionBlock(state, profile.id, tool.id, "follow", "Follow", user.username, rescrapeSource.value, rescrapeSource.type);
              // Only update toolBlockedUntil for real Action Blocked errors, not ABD (feedback_required) soft warnings.
              if (!isRescrapeABD && s.stopOnBlockEnabled && (s.stopOnBlockMinutes ?? 0) > 0) {
                const _blockedUntilMs = Date.now() + (s.stopOnBlockMinutes * 60_000);
                await storage.updateTool(tool.id, { settings: { ...s, toolBlockedUntil: _blockedUntilMs } });
              }
              hitHardLimit = true; break;
            }
            // Catch-all: unclassified block — log it, do NOT trigger Stop Tool if Blocked.
            this.logAction(profile.id, tool.id, "follow_blocked", user.username, rescrapeSource.value, rescrapeSource.type, "skipped", reason);
            if (followed + blocked >= processCount) break;
            await sleep(randInt(followMin, followMax)); continue;
          }
          // Browser follow reports "already following" as ok:true + status:"already_following" —
          // treat it the same as a skip so it doesn't count as a new follow in stats. Self-heal
          // the DB record too since it means our followedUsers table missed this relationship.
          if (result.status === "already_following") {
            console.log(`[engine] @${profile.username}: skip @${user.username} (already following via browser) — trying next candidate`);
            this.logAction(profile.id, tool.id, "follow_skipped", user.username, rescrapeSource.value, rescrapeSource.type, "skipped", `Already following @${user.username} (confirmed via browser) — skipped, trying next candidate instead`);
            storage.createFollowedUser({
              profileId: profile.id,
              instagramUsername: user.username,
              instagramUserId: String(user.pk ?? ""),
              sourceValue: rescrapeSource.value,
              sourceType: rescrapeSource.type,
              followedAt: new Date().toISOString(),
            }).catch(() => {});
            skipped++;
            continue;
          }
          if (!result.ok) {
            const rawReason = (result as any).reason ? `: ${(result as any).reason}` : " (no reason returned by Instagram)";
            console.log(`[engine] @${profile.username}: skip @${user.username} — follow attempt failed${rawReason} — trying next candidate`);
            this.logAction(profile.id, tool.id, "follow_skipped", user.username, rescrapeSource.value, rescrapeSource.type, "skipped", `Follow attempt failed for @${user.username}${rawReason} — skipped, trying next candidate instead`);
            skipped++;
            continue;
          }
          try {
            await storage.createFollowedUser({ profileId: profile.id, instagramUsername: user.username, instagramUserId: String(user.pk ?? ""), sourceValue: rescrapeSource.value, sourceType: rescrapeSource.type, followedAt: new Date().toISOString() });
          } catch {}
          this.logAction(profile.id, tool.id, "follow", user.username, rescrapeSource.value, rescrapeSource.type, "ok", `Followed [${followed + 1}/${processCount}] users`);
          try {
            await storage.incrementStat(profile.id, "follow");
          } catch (statErr: any) {
            console.error(`[engine] @${profile.username}: ⚠ incrementStat("follow") failed — stat NOT recorded for @${user.username} (rescrape): ${statErr?.message}`);
          }
          this.bump(state);
          followed++;
          console.log(`[engine] @${profile.username}: ✓ @${user.username} [${followed}/${processCount}] day:${state.dailyCount}`);
          await sleep(randInt(followMin, followMax));
        }
        // Guard: if we've run out of process slots via blocks alone (0 successful follows),
        // the session/account is dead — stop re-scraping immediately instead of running all
        // 20 rounds and hammering the sources for nothing.
        if (!hitHardLimit && followed === 0 && blocked >= processCount) {
          engineLog("WARN", `@${profile.username}: re-scrape aborted after round ${extraRound} — ${blocked} block(s), 0 follows (session dead or action-blocked)`);
          hitHardLimit = true;
        }
      }
    }

    console.log(`[engine] @${profile.username}: session done — followed ${followed}/${processCount}`);
    return { followed, scraped: candidates.length, dedupSkipped, filterSkipped, blocked, skipped };
  }

  // ── Weighted source picker ────────────────────────────────────────────────
  private pickSource(sources: Source[]): Source {
    const active = sources.filter(s => s.enabled !== false);
    const pool = active.length > 0 ? active : sources;
    const total = pool.reduce((s, x) => s + (x.rank ?? 100), 0);
    if (total === 0) return pool[pool.length - 1];
    let r = Math.random() * total;
    for (const src of pool) {
      r -= src.rank ?? 100;
      if (r <= 0) return src;
    }
    return pool[pool.length - 1];
  }

  // ── Dedup check ───────────────────────────────────────────────────────────
  private async alreadyFollowed(profileId: number, username: string): Promise<boolean> {
    const list = await storage.getFollowedUsersByProfile(profileId, 100_000);
    return list.some(u => u.instagramUsername.toLowerCase() === username.toLowerCase());
  }

  // ── Public trigger: run repost immediately (bypass skip-chance & timer) ──
  async runRepostNow(profileId: number): Promise<{ ok: boolean; message: string }> {
    const profile = await storage.getProfile(profileId);
    if (!profile) return { ok: false, message: "Profile not found" };

    const tools = await storage.getToolsByProfile(profileId);
    const hsTool = tools.find(t => t.type === "human_sessions");
    if (!hsTool) return { ok: false, message: "Human sessions tool not found for this profile" };

    const s = hsTool.settings as any;
    const sourceUsername = String(s.repostSourceUsername ?? "").trim();
    if (!s.repostEnabled) return { ok: false, message: "Repost is not enabled in settings" };
    if (!sourceUsername) return { ok: false, message: "No source account configured" };

    // Reuse existing state (keeps client alive) or create a temp one
    let state = this.humanSessionStates.get(profileId);
    const tempState = !state;
    if (!state) {
      state = {
        stop: { stopped: false },
        client: null,
        dailyCount: 0, dailyDate: "",
        hourlyCount: 0, hourlyHour: "",
        actionSuspensions: {},
        nextHumanSessionAt: 0,
        lastHumanToolsEnabled: false,
        nextFollowAt: 0, nextContactAt: 0, nextUnfollowAt: 0,
      };
    }

    const client = await this.ensureClient(profile, state);
    if (!client) return { ok: false, message: "Could not establish Instagram session (check cookies)" };

    try {
      // Toggle ON → HikerAPI only, hard fail if not configured (no fallback to account).
      // Toggle OFF → account's own session does the scrape.
      const gs_now = await storage.getGlobalSettings();
      const useHiker = !!s.repostUseHikerApi && gs_now.hikerRepostGetFeed !== "false";
      let feedItems: Awaited<ReturnType<HikerApiClient["getUserFeedItems"]>>;
      if (useHiker) {
        const hikerClient = (gs_now.hikerApiEnabled === "true" && gs_now.hikerApiToken)
          ? new HikerApiClient(gs_now.hikerApiToken)
          : null;
        if (!hikerClient) {
          return { ok: false, message: "HikerAPI toggled ON but not configured in Global Settings — cannot scrape source feed." };
        }
        const t0Manual = Date.now();
        feedItems = await hikerClient.getUserFeedItems(sourceUsername);
        storage.createInstagramApiCall({
          profileId,
          username: profile.username,
          operationName: "RepostFeedScrape",
          date: new Date().toISOString(),
          message: `[Manual] Scraped feed of @${sourceUsername} via HikerAPI (${feedItems.length} items)`,
          source: "HikerAPI",
          durationMs: Date.now() - t0Manual,
        }).catch(() => {});
      } else {
        feedItems = await client.getUserFeedItems(sourceUsername);
      }

      console.log(`[engine] @${profile.username}: 🔁 [MANUAL] feed fetched via ${useHiker ? "HikerAPI" : "account session"} (${feedItems.length} items) from @${sourceUsername}`);

      let candidate: { mediaId: string; shortcode: string; imageUrl: string; caption: string } | null = null;
      for (const item of feedItems) {
        const already = await storage.isAlreadyReposted(profileId, item.mediaId);
        if (!already) { candidate = item; break; }
      }

      if (!candidate) return { ok: false, message: `No new posts to repost from @${sourceUsername} (all already reposted)` };

      const level         = ((s.repostAlterationLevel ?? "small") as AlterationLevel);
      const imageBuffer   = await client.downloadImage(candidate.imageUrl);
      const alteredBuffer = await alterJpegBuffer(imageBuffer, level, s.repostImageSettings);

      const captionTemplate = String(s.repostCaptionText ?? "").trim();
      const finalCaption = captionTemplate
        ? resolveCaption(captionTemplate, candidate, sourceUsername, profile.username)
        : candidate.caption.slice(0, 2200);

      // Upload — browser or private API
      let postedMediaId: string | null;
      if ((profile as any).postViaBrowser) {
        const ebResult = await this.postPhotoViaBrowser(profile.id, alteredBuffer, finalCaption);
        if (!ebResult.ok) return { ok: false, message: ebResult.message || "Browser post failed — check the embedded browser session is active" };
        postedMediaId = ebResult.mediaId ?? String(Date.now());
      } else {
        postedMediaId = await client.uploadPhoto(alteredBuffer, finalCaption);
        if (!postedMediaId) return { ok: false, message: client.lastUploadError || "Upload failed — Instagram rejected the photo" };
      }

      if (s.repostDisableComments) {
        try { await client.disableComments(postedMediaId); } catch { /* non-fatal */ }
      }

      const postedShortcode = mediaIdToShortcode(postedMediaId);
      await storage.createRepostedPost({
        profileId,
        toolId: hsTool.id,
        sourceUsername,
        mediaId:      candidate.mediaId,
        shortcode:    candidate.shortcode,
        caption:      candidate.caption.slice(0, 2200),
        thumbnailUrl: candidate.imageUrl,
        repostedAt:   new Date().toISOString(),
        postedShortcode,
      });

      console.log(`[engine] @${profile.username}: 🔁 [MANUAL] reposted ${candidate.mediaId} from @${sourceUsername} → ${postedShortcode}`);
      this.logAction(profileId, hsTool.id, "repost", sourceUsername, candidate.mediaId, candidate.shortcode, "ok", `[Manual] Reposted from @${sourceUsername}`);
      // Browser-posts bypass the private API client so they never land in instagram_api_calls.
      // Write a synthetic entry so the stats pie chart counts them correctly.
      if ((profile as any).postViaBrowser) {
        storage.createInstagramApiCall({
          profileId,
          username: profile.username,
          operationName: "PostMedia",
          date: new Date().toISOString(),
          source: "browser",
          transport: "browser",
          isError: false,
        }).catch(() => {});
      }
      await storage.incrementStat(profileId, "repost");

      return { ok: true, message: `Reposted → instagram.com/p/${postedShortcode}` };
    } catch (e: any) {
      console.warn(`[engine] @${profile.username}: manual repost error: ${e?.message}`);
      return { ok: false, message: e?.message ?? "Unknown error" };
    } finally {
      // Clean up temp state client if we created one
      if (tempState && state.client) {
        // don't destroy — just let GC handle it
      }
    }
  }

  // ── Public trigger: immediate human session ───────────────────────────────
  // Called when a human_sessions tool is explicitly enabled from the UI.
  // If a runner is already alive, reset its timer to 0 so it fires on the
  // next 10-second tick instead of waiting out the 30-60 min interval.
  // If no runner exists yet, kick off an immediate reconcile to launch one.
  triggerHumanSession(profileId: number) {
    const state = this.humanSessionStates.get(profileId);
    if (state) {
      // Runner is alive — reset its session timer and wake it from the idle sleep
      // immediately (≤1 s) rather than waiting up to 10 s for the next tick.
      state.nextHumanSessionAt = 0;
      const wakeSignal = this.hsWakeSignals.get(profileId);
      if (wakeSignal) wakeSignal.wake = true;
    } else {
      // No live runner — launch one via reconcile.  runImmediately=true applies
      // because this.initialized is true, so nextHumanSessionAt stays 0 and the
      // session fires on the runner's very first tick.
      this.reconcile().catch(() => {});
    }
  }

  // Called when an unfollow tool is explicitly enabled from the UI.
  // Immediately kicks off a reconcile so the runner starts without waiting
  // up to 10 seconds for the scheduled interval.
  triggerUnfollow(profileId: number) {
    if (!this.unfollowStates.has(profileId)) {
      this.reconcile().catch(() => {});
    }
  }

  // Called when a follow tool is explicitly enabled from the UI.
  triggerFollow(profileId: number) {
    if (this.states.has(profileId)) {
      // Runner is sleeping between sessions — wake it up immediately (within 1s)
      this.followForceRun.add(profileId);
    } else {
      // Runner is not active — reconcile will launch it with runImmediately=true
      this.reconcile().catch(() => {});
    }
  }

  // Called when a tool is manually toggled on from the UI.
  // Clears any active block suspensions so the runner tries again immediately
  // instead of sitting out the remainder of a 24- or 50-hour wait.
  clearSuspensions(profileId: number, toolType: string): void {
    if (toolType === "follow") {
      const state = this.states.get(profileId);
      if (state) { state.actionSuspensions = {}; }
    } else if (toolType === "unfollow") {
      const state = this.unfollowStates.get(profileId);
      if (state) { state.actionSuspensions = {}; }
    } else if (toolType === "dm") {
      const state = this.dmStates.get(profileId);
      if (state) { state.actionSuspensions = {}; }
    } else if (toolType === "contact") {
      const state = this.contactStates.get(profileId);
      if (state) { state.actionSuspensions = {}; }
    }
  }

  // Called by copy-settings when enabling a tool with a stagger offset.
  // Stops the existing runner (if any) so the next reconcile re-launches it
  // from scratch, respecting the startup wait + staggerOffsetMins from DB.
  restartColdWithWait(profileId: number, toolType: string) {
    if (toolType === "follow") {
      const state = this.states.get(profileId);
      if (state) { state.stop.stopped = true; this.states.delete(profileId); }
    } else if (toolType === "unfollow") {
      const state = this.unfollowStates.get(profileId);
      if (state) { state.stop.stopped = true; this.unfollowStates.delete(profileId); }
    } else if (toolType === "human_sessions") {
      const state = this.humanSessionStates.get(profileId);
      if (state) { state.stop.stopped = true; this.humanSessionStates.delete(profileId); }
    } else if (toolType === "contact") {
      const state = this.contactStates.get(profileId);
      if (state) { state.stop.stopped = true; this.contactStates.delete(profileId); }
    }
    this.reconcile().catch(() => {});
  }

  // Force an immediate follow session, bypassing the inter-session wait timer.
  // If the runner is already sleeping between sessions, it wakes within 1 second.
  // If the runner is not active, starts it immediately via reconcile.
  forceFollowNow(profileId: number) {
    if (this.states.has(profileId)) {
      this.followForceRun.add(profileId);
    } else {
      this.followForceRun.add(profileId);
      this.reconcile().catch(() => {});
    }
  }

  // Force an immediate contact-users send session, bypassing the wait timer.
  // If the runner is already active, it wakes on the next 5s poll.
  // If not active, triggers a reconcile to start it.
  triggerContactSend(profileId: number) {
    if (this.contactStates.has(profileId)) {
      this.contactForceRun.add(profileId);
    } else {
      this.contactForceRun.add(profileId);
      this.reconcile().catch(() => {});
    }
  }

  // ── Manual "Fix ABD" — called from POST /api/profiles/:id/fix-abd ──────────
  // Calls POST /api/v1/users/self/banner_dismiss/ directly using the stored
  // igApiCookies identity. No probing, no challenge flow, no EB dependency.
  // If Instagram returns status=ok the account is marked valid.
  async dismissABDForProfile(profileId: number): Promise<{ ok: boolean; message: string }> {
    const profile = await storage.getProfile(profileId);
    if (!profile) return { ok: false, message: "Profile not found" };

    const proxyUrl = await this.buildProxyUrl(profile);
    if (!proxyUrl) return { ok: false, message: "No proxy assigned — assign a proxy to this account before fixing ABD." };
    const client = new InstagramWebClient(proxyUrl, profileId);
    client.setDeviceInfo(profile.igDeviceState, getSessionUserAgentApi(profileId) ?? profile.userAgentApi, profile.igApiCookies);
    client.onDeviceStateUpdate = (s) => { storage.updateProfile(profileId, { igDeviceState: s }).catch(() => {}); };
    client.username = profile.username;

    // ── Path A: banner_dismiss with stored session ────────────────────────────
    // Works when the mobile sessionid is still valid (e.g. soft ABD warning only).
    const hasSession = !!(profile.igApiCookies ?? "").split(";").find(s => s.trim().startsWith("sessionid="));
    if (hasSession) {
      console.log(`[engine] @${profile.username}: Fix ABD — trying banner_dismiss (stored session)`);
      const { raw, ok } = await client.bannerDismiss();
      if (ok) {
        await storage.updateProfile(profileId, { accountStatus: "valid" });
        await storage.incrementStat(profileId, "abd");
        this.logAction(profileId, 0, "abd_dismissed", "", "", "", "ok", "ABD dismissed via banner_dismiss");
        console.log(`[engine] @${profile.username}: Fix ABD SUCCESS via banner_dismiss ✓`);
        return { ok: true, message: "ABD warning dismissed — account restored to valid" };
      }
      const detail = raw?._error ?? raw?.message ?? (raw === null ? "session expired" : JSON.stringify(raw)?.slice(0, 80));
      console.warn(`[engine] @${profile.username}: banner_dismiss failed (${detail}) — falling through to fresh login`);
    } else {
      console.log(`[engine] @${profile.username}: Fix ABD — no stored session, going straight to fresh login`);
    }

    // ── Path B: fresh mobile login (no EB) ───────────────────────────────────
    // Performs a cold instagram-private-api login using the stored password and
    // preserved device fingerprint (uuid, deviceId, ig_did, etc.).
    // If Instagram returns IgCheckpointError the ABD checkpoint is auto-dismissed
    // with choice=0. This path works even when the stored sessionid is fully revoked.
    if (!profile.password) {
      const msg = "Session expired and no stored password — add the account password and try Verify Credentials to restore the session";
      console.warn(`[engine] @${profile.username}: Fix ABD — no password stored, cannot attempt fresh login`);
      this.logAction(profileId, 0, "abd_dismissed", "", "", "", "error", msg);
      return { ok: false, message: msg };
    }

    console.log(`[engine] @${profile.username}: Fix ABD — attempting fresh mobile login (no EB)`);
    this.logAction(profileId, 0, "abd_dismissed", "", "", "", "info", "Attempting fresh mobile login to dismiss ABD checkpoint");

    const freshOk = await client.dismissABD_freshLogin(profile.username, profile.password);
    if (freshOk) {
      await storage.updateProfile(profileId, { accountStatus: "valid" });
      await storage.incrementStat(profileId, "abd");
      this.logAction(profileId, 0, "abd_dismissed", "", "", "", "ok", "ABD dismissed via fresh mobile login");
      console.log(`[engine] @${profile.username}: Fix ABD SUCCESS via fresh login ✓`);
      return { ok: true, message: "ABD warning dismissed — account restored to valid" };
    }

    const msg = "Fresh login could not dismiss the ABD checkpoint — Instagram may require manual verification";
    console.warn(`[engine] @${profile.username}: Fix ABD FAILED — dismissABD_freshLogin returned false`);
    this.logAction(profileId, 0, "abd_dismissed", "", "", "", "error", msg);
    return { ok: false, message: msg };
  }

  // Force an immediate new-follower extraction for the given profile,
  // regardless of whether the contact runner is active or scheduled.
  // Returns how many new messages were queued to the pending list.
  async triggerExtractNow(profileId: number, countOverride?: number): Promise<{ queued: number; error?: string }> {
    const profile = await storage.getProfile(profileId);
    if (!profile) return { queued: 0, error: "Profile not found" };

    const tools = await storage.getToolsByProfile(profileId);
    const contactTool = tools.find(t => t.type === "contact");
    if (!contactTool) return { queued: 0, error: "Contact tool not found" };

    // Reuse live contact state (authenticated client) if the runner is active;
    // otherwise create a temporary state so ensureClient can build a fresh one.
    let state = this.contactStates.get(profileId);
    if (!state) {
      state = {
        stop: { stopped: false },
        client: null,
        dailyCount: 0,   dailyDate:   todayStr(),
        hourlyCount: 0,  hourlyHour:  hourStr(),
        actionSuspensions: {},
        nextHumanSessionAt: 0,
        lastHumanToolsEnabled: false,
        nextFollowAt: 0,
        nextContactAt: 0,
        nextUnfollowAt: 0,
      };
    }

    const before = (await storage.getContactPendingMessages(profileId, "pending")).length;
    try {
      const { fetched, source } = await this.runContactNewFollowersSession(profile, contactTool, state, countOverride);
      const after = (await storage.getContactPendingMessages(profileId, "pending")).length;
      const queued = Math.max(0, after - before);
      this.logAction(profile.id, contactTool.id, "tool_complete", "", "", "", "ok",
        `Extracted ${fetched} new follower${fetched === 1 ? "" : "s"} via ${source}${queued > 0 ? `, ${queued} added to queue` : ""}`);
      return { queued };
    } catch (e: any) {
      console.error(`[engine] triggerExtractNow @${profile.username}: ${e?.message}`);
      this.logAction(profile.id, contactTool.id, "tool_complete", "", "", "", "error",
        `Extract now error: ${e?.message ?? "unknown"}`);
      return { queued: 0, error: e?.message ?? "Unknown error" };
    }
  }

  // ── Cookie baker: trigger immediate run ──────────────────────────────────
  triggerCookieBakerNow(profileId: number) {
    this.cookieBakerForceRun.add(profileId);
    this.triggerReconcile();
  }

  // ── Cookie baker: launch background loop ─────────────────────────────────
  private launchCookieBaker(profile: Profile) {
    // Stagger first run: spread accounts over the first 15 minutes so they
    // don't all spawn Chrome simultaneously right after startup.
    const staggerMs = Math.floor(Math.random() * 15 * 60_000);
    const state: CookieBakerState = { stop: { stopped: false }, nextRunAt: Date.now() + staggerMs };
    this.cookieBakerStates.set(profile.id, state);
    console.log(`[cookie-baker] Scheduling baker for @${profile.username} (first run in ${Math.round(staggerMs / 60000)}min)`);

    const loop = async () => {
      while (!state.stop.stopped) {
        if (this.cookieBakerForceRun.has(profile.id)) {
          this.cookieBakerForceRun.delete(profile.id);
          state.nextRunAt = 0;
        }

        if (Date.now() >= state.nextRunAt) {
          const freshProfile = await storage.getProfile(profile.id);
          if (!freshProfile) break;
          const cbs = (freshProfile.cookieBakerSettings as any) ?? {};
          if (!cbs.enabled) break;

          try {
            await this.runCookieBakerSession(freshProfile, cbs, state);
          } catch (err: any) {
            console.error(`[cookie-baker] @${freshProfile.username}: session error: ${err?.message}`);
          }

          const waitMs = randInt(
            (cbs.execIntervalMin ?? 60) * 60_000,
            (cbs.execIntervalMax ?? 120) * 60_000,
          );
          state.nextRunAt = Date.now() + waitMs;
          console.log(`[cookie-baker] @${freshProfile.username}: next session in ${Math.round(waitMs / 60000)}min`);
        }

        await sleepInterruptible(5_000, state.stop);
      }
      this.cookieBakerStates.delete(profile.id);
      console.log(`[cookie-baker] Baker runner exited for @${profile.username}`);
    };

    loop().catch((err) => {
      this.cookieBakerStates.delete(profile.id);
      console.error(`[cookie-baker] Fatal error for @${profile.username}:`, err?.message);
    });
  }

  // ── Cookie baker: run one browsing session ────────────────────────────────
  private async runCookieBakerSession(
    profile: Profile,
    settings: any,
    state: { stop: { stopped: boolean } },
  ): Promise<void> {
    const sites: string[] = (settings.sites ?? "")
      .split("\n")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);

    if (!sites.length) {
      console.log(`[cookie-baker] @${profile.username}: no sites configured, skipping`);
      return;
    }

    const count = randInt(settings.sitesMin ?? 3, settings.sitesMax ?? 5);
    const sitesToVisit = settings.visitRandom
      ? [...sites].sort(() => Math.random() - 0.5).slice(0, count)
      : sites.slice(0, count);

    // Resolve proxy config
    let proxyArg: string[] = [];
    let proxyAuth: { username: string; password: string } | undefined;
    if (profile.proxyId) {
      try {
        const proxies = await storage.getProxies();
        const linked = proxies.find((p) => p.id === profile.proxyId);
        if (linked?.host && linked?.port) {
          const isSocks5 = linked.proxyType === "socks5";
          if (isSocks5) {
            const auth = linked.username
              ? `${encodeURIComponent(linked.username)}:${encodeURIComponent(linked.password ?? "")}@`
              : "";
            proxyArg = [`--proxy-server=socks5://${auth}${linked.host}:${linked.port}`];
          } else {
            proxyArg = [`--proxy-server=http://${linked.host}:${linked.port}`];
            if (linked.username) proxyAuth = { username: linked.username, password: linked.password ?? "" };
          }
        }
      } catch {}
    } else if (profile.proxyHost && profile.proxyPort) {
      proxyArg = [`--proxy-server=http://${profile.proxyHost}:${profile.proxyPort}`];
      if (profile.proxyUsername) proxyAuth = { username: profile.proxyUsername, password: profile.proxyPassword ?? "" };
    }

    // ── UA-FINGERPRINT PREVENTION ───────────────────────────────────────────
    // The cookie baker must use the account's assigned EB UA — falling back to
    // a generic Windows Chrome UA would expose a mismatched fingerprint to every
    // site visited.  If no UA is configured the baker must not run.
    if (!profile.userAgentEmbedded) {
      console.log(`[cookie-baker] @${profile.username}: no EB user-agent configured — skipping cookie bake (assign a user agent to this account first)`);
      return { visited: [], skipped: true, reason: "no_ua" };
    }
    const ua = profile.userAgentEmbedded;

    let bakePage: any | null = null;
    let headlessBrowser: any | null = null;
    let usingEbBrowser = false;

    // ── Strategy 1: reuse an already-open EB browser (new background tab) ──
    // When the user has opened the EB panel, an EB browser process is already
    // running for this profile.  Opening a new tab on it is instant and avoids
    // the risk of a second Chrome process failing to launch on Windows.
    const existingBrowser = getExistingBrowser(profile.id);
    if (existingBrowser) {
      try {
        const tab = await existingBrowser.newPage();
        if (proxyAuth) await tab.authenticate(proxyAuth);
        await tab.setUserAgent(ua);
        await tab.setViewport(viewportForUA(ua));
        await applyStealthScripts(tab, ua, undefined, profile.userAgentApi);
        bakePage = tab;
        usingEbBrowser = true;
        console.log(`[cookie-baker] @${profile.username}: visiting ${sitesToVisit.length} site(s) [EB tab]`);
      } catch {
        // EB browser closed between check and use — fall through to headless
        usingEbBrowser = false;
        bakePage = null;
      }
    }

    // ── Strategy 2: launch a dedicated headless browser ──────────────────────
    if (!bakePage) {
      // Concurrency gate: cap simultaneous headless Chrome instances at 3.
      // Without this, all N accounts fire at startup and spawn N Chrome processes.
      const MAX_CONCURRENT = 3;
      while (this.cookieBakerRunning >= MAX_CONCURRENT) {
        if (state.stop.stopped) return;
        await new Promise(r => setTimeout(r, 10_000));
      }
      if (state.stop.stopped) return;
      this.cookieBakerRunning++;

      let puppeteerLib: any;
      try {
        puppeteerLib = (await import("puppeteer-core")).default;
      } catch {
        puppeteerLib = (await import("puppeteer")).default;
      }

      const CHROMIUM_PATH =
        process.env.CHROMIUM_PATH ||
        "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium";

      console.log(`[cookie-baker] @${profile.username}: visiting ${sitesToVisit.length} site(s) [headless]`);

      try {
        headlessBrowser = await puppeteerLib.launch({
          headless: true,
          executablePath: CHROMIUM_PATH,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--no-first-run",
            "--no-zygote",
            "--disable-extensions",
            "--disable-sync",
            "--disable-default-apps",
            "--mute-audio",
            "--hide-scrollbars",
            "--window-size=1280,760",
            ...proxyArg,
          ],
          ignoreHTTPSErrors: true,
        });

        const headlessPage = await headlessBrowser.newPage();
        if (proxyAuth) await headlessPage.authenticate(proxyAuth);
        await headlessPage.setUserAgent(ua);
        await headlessPage.setViewport(viewportForUA(ua));
        await applyStealthScripts(headlessPage, ua, undefined, profile.userAgentApi);
        bakePage = headlessPage;
      } catch (launchErr: any) {
        const errMsg = `Browser failed to launch: ${launchErr?.message ?? "unknown error"}`;
        console.error(`[cookie-baker] @${profile.username}: ${errMsg}`);
        if (headlessBrowser) await headlessBrowser.close().catch(() => {});
        this.cookieBakerRunning = Math.max(0, this.cookieBakerRunning - 1);
        await this._saveCookieBakerActivity(profile.id, { sessionAt: Date.now(), sites: [], error: errMsg });
        return;
      }
    }

    const sessionVisits: CookieBakerVisit[] = [];

    try {
      const page = bakePage;

      for (const site of sitesToVisit) {
        if (state.stop.stopped) break;
        const url = site.startsWith("http") ? site : `https://${site}`;
        try {
          console.log(`[cookie-baker] @${profile.username}: → ${url}`);
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await dismissCookieBanner(page);

          const scrollMs = randInt(
            (settings.scrollDelayMin ?? 5) * 1_000,
            (settings.scrollDelayMax ?? 15) * 1_000,
          );
          await cookieBakerScroll(page, scrollMs, state);
          if (state.stop.stopped) break;

          const visitRecord: CookieBakerVisit = {
            url,
            visitedAt: Date.now(),
            scrollTimeSec: Math.round(scrollMs / 1000),
            linksVisited: [],
          };

          // Collect + visit internal links
          const linksCount = randInt(settings.internalLinksMin ?? 1, settings.internalLinksMax ?? 3);
          if (linksCount > 0) {
            let hostname = "";
            try { hostname = new URL(url).hostname; } catch {}
            const internalLinks: string[] = hostname
              ? await page.evaluate((h: string) =>
                  Array.from(document.querySelectorAll("a[href]"))
                    .map((a) => (a as HTMLAnchorElement).href)
                    .filter((href) => {
                      try { return new URL(href).hostname === h && href !== window.location.href; }
                      catch { return false; }
                    })
                    .slice(0, 20),
                  hostname,
                )
              : [];

            const chosen = internalLinks.sort(() => Math.random() - 0.5).slice(0, linksCount);
            for (const link of chosen) {
              if (state.stop.stopped) break;
              try {
                console.log(`[cookie-baker] @${profile.username}:   ↳ ${link}`);
                await page.goto(link, { waitUntil: "domcontentloaded", timeout: 20_000 });
                await dismissCookieBanner(page);
                const innerMs = randInt(
                  (settings.internalScrollDelayMin ?? 3) * 1_000,
                  (settings.internalScrollDelayMax ?? 10) * 1_000,
                );
                await cookieBakerScroll(page, innerMs, state);
                visitRecord.linksVisited.push(link);
              } catch {}
            }
          }

          sessionVisits.push(visitRecord);
        } catch (err: any) {
          console.error(`[cookie-baker] @${profile.username}: failed to visit ${url}: ${err?.message}`);
        }
      }

      if (sessionVisits.length > 0) {
        await this._saveCookieBakerActivity(profile.id, { sessionAt: Date.now(), sites: sessionVisits });
      }
    } finally {
      if (usingEbBrowser && bakePage) {
        // Close just the tab we opened — never close the shared EB browser
        await bakePage.close().catch(() => {});
      } else if (headlessBrowser) {
        await headlessBrowser.close().catch(() => {});
        this.cookieBakerRunning = Math.max(0, this.cookieBakerRunning - 1);
      }
    }
    console.log(`[cookie-baker] @${profile.username}: session complete`);
  }

  // ── Cookie baker: persist one session record to DB + in-memory cache ─────
  private async _saveCookieBakerActivity(profileId: number, session: CookieBakerSessionActivity): Promise<void> {
    try {
      const key = `cb_activity_${profileId}`;
      const allSettings = await storage.getGlobalSettings();
      const prev: CookieBakerSessionActivity[] = allSettings[key] ? JSON.parse(allSettings[key]) : [];
      const updated = [session, ...prev].slice(0, 30); // keep last 30 sessions
      await storage.setGlobalSetting(key, JSON.stringify(updated));
      this.cookieBakerActivity.set(profileId, updated);
    } catch (e: any) {
      console.error(`[cookie-baker] failed to persist activity for profile ${profileId}: ${e?.message}`);
      // Still update in-memory so the current session is visible
      const prev = this.cookieBakerActivity.get(profileId) ?? [];
      this.cookieBakerActivity.set(profileId, [session, ...prev].slice(0, 30));
    }
  }

  // ── Status API ────────────────────────────────────────────────────────────
  async getCookieBakerActivity(profileId: number): Promise<CookieBakerSessionActivity[]> {
    // Return in-memory cache if populated (avoids a DB round-trip mid-session)
    if (this.cookieBakerActivity.has(profileId)) {
      return this.cookieBakerActivity.get(profileId)!;
    }
    // On first access after a restart, load from DB
    try {
      const key = `cb_activity_${profileId}`;
      const allSettings = await storage.getGlobalSettings();
      if (allSettings[key]) {
        const data: CookieBakerSessionActivity[] = JSON.parse(allSettings[key]);
        this.cookieBakerActivity.set(profileId, data);
        return data;
      }
    } catch {}
    return [];
  }

  // Called by the verify route after a successful re-verify so the next DM/inbox
  // call gets a fresh cold-start bootstrap (FetchConfig etc.) with the new session.
  // Does NOT bust on normal cookie rotation — that's handled inside setDeviceInfo.
  invalidateWarmedClientCache(profileId: number): void {
    const maps = [this.states, this.unfollowStates, this.dmStates, this.contactStates, this.humanSessionStates];
    for (const map of maps) {
      const state = map.get(profileId);
      if (state?.client) {
        state.client.resetWarmedClient();
        console.log(`[engine] invalidateWarmedClientCache: cleared for profileId=${profileId}`);
        return;
      }
    }
  }

  getStatus(): { profileId: number; loggedIn: boolean; dailyCount: number; hourlyCount: number; dailyUnfollowCount: number; dailyDmCount: number; nextHumanSessionAt: number; nextFollowAt: number; nextContactAt: number; nextUnfollowAt: number }[] {
    // Collect every profileId that has at least one active runner
    const allIds = new Set<number>([
      ...this.states.keys(),
      ...this.humanSessionStates.keys(),
      ...this.contactStates.keys(),
      ...this.dmStates.keys(),
      ...this.unfollowStates.keys(),
    ]);
    return Array.from(allIds).map(profileId => {
      const followState   = this.states.get(profileId);
      const humanState    = this.humanSessionStates.get(profileId);
      const contactState  = this.contactStates.get(profileId);
      const dmState       = this.dmStates.get(profileId);
      const unfollowState = this.unfollowStates.get(profileId);
      const anyState      = followState ?? humanState ?? contactState ?? unfollowState;
      return {
        profileId,
        loggedIn:             !!anyState?.client?.isLoggedIn(),
        dailyCount:           followState   ? this.daily(followState)   : 0,
        hourlyCount:          followState   ? this.hourly(followState)  : 0,
        dailyUnfollowCount:   unfollowState ? this.daily(unfollowState) : 0,
        dailyDmCount:         (dmState      ? this.daily(dmState)       : 0) + (contactState ? this.daily(contactState) : 0),
        nextHumanSessionAt:   humanState?.nextHumanSessionAt ?? 0,
        nextFollowAt:         followState?.nextFollowAt ?? 0,
        nextContactAt:        contactState?.nextContactAt ?? 0,
        nextUnfollowAt:       unfollowState?.nextUnfollowAt ?? 0,
      };
    });
  }
}

// ── Cookie baker scroll helper ────────────────────────────────────────────────
/**
 * Attempts to dismiss any cookie consent / privacy banner on the current page.
 * Tries a broad set of CSS selectors first, then falls back to text-matching
 * visible buttons. Swallows all errors — never blocks the caller.
 */
async function dismissCookieBanner(page: any): Promise<void> {
  try {
    await page.evaluate(async () => {
      const ACCEPT_RE = /^(accept|accept all|accept cookies|accept & close|accept and close|allow all|allow cookies|allow all cookies|i agree|i accept|agree|agree all|ok|okay|got it|continue|proceed|confirm|dismiss|close|yes|yes, i accept|yes, i agree|consent|i consent|save & exit|save and exit|save settings|confirm my choices|that's ok|that's fine|no problem|understood)/i;
      const SELECTORS = [
        // Generic accept / agree buttons
        "[id*='accept']:not([type='text']):not([type='email']):not([type='search'])",
        "[class*='accept-btn']", "[class*='acceptBtn']", "[class*='accept_btn']",
        "[id*='consent']:not([type='text'])", "[class*='consent-btn']", "[class*='consentBtn']",
        "[id*='agree']:not([type='text'])", "[class*='agree-btn']",
        "[id*='allow']:not([type='text'])", "[class*='allow-btn']",
        // GDPR / cookie specific
        "#onetrust-accept-btn-handler",
        "#onetrust-pc-btn-handler",
        ".onetrust-accept-btn-handler",
        "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
        "#CybotCookiebotDialogBodyButtonAccept",
        ".cc-accept", ".cc-btn.cc-allow", ".cc-dismiss",
        "#cookieAccept", "#cookie-accept", "#cookie_accept",
        "#acceptCookies", "#accept-cookies", "#accept_cookies",
        "#acceptAllCookies", "#accept-all-cookies", "#accept_all_cookies",
        ".acceptCookies", ".accept-cookies",
        "#gdpr-accept", "#gdpr_accept", ".gdpr-accept",
        "[data-testid*='accept']", "[data-testid*='cookie']", "[data-testid*='consent']",
        "[aria-label*='Accept']", "[aria-label*='accept']", "[aria-label*='Agree']",
        "[aria-label*='Allow']", "[aria-label*='Consent']",
        // Common frameworks
        ".qc-cmp2-summary-buttons button:last-child",
        ".fc-button.fc-cta-consent",
        ".fc-cta-consent",
        "[class*='cookie-banner'] button",
        "[class*='cookie-notice'] button",
        "[class*='cookie-popup'] button",
        "[class*='cookie-wall'] button",
        "[class*='cookiebanner'] button",
        "[class*='cookienotice'] button",
        "[class*='cookiepopup'] button",
        "[class*='gdpr-banner'] button",
        "[class*='consent-banner'] button",
        "[class*='privacy-banner'] button",
        "[id*='cookie-banner'] button",
        "[id*='cookie-notice'] button",
        "[id*='cookie-popup'] button",
        "[id*='cookie-wall'] button",
        "[id*='gdpr'] button",
        "[id*='consent-banner'] button",
      ];

      const isVisible = (el: Element) => {
        const s = window.getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      // 1. Try explicit selectors
      for (const sel of SELECTORS) {
        try {
          const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
          for (const el of els) {
            if (isVisible(el)) { el.click(); return; }
          }
        } catch {}
      }

      // 2. Fall back: find any visible button/link whose text matches the accept pattern
      const candidates = Array.from(document.querySelectorAll<HTMLElement>("button, a[role='button'], input[type='button'], input[type='submit'], [role='button']"));
      for (const el of candidates) {
        const text = (el.textContent ?? "").trim();
        if (ACCEPT_RE.test(text) && isVisible(el)) { el.click(); return; }
      }
    });
  } catch {}
  // Give the banner animation a moment to clear
  await new Promise(r => setTimeout(r, 600));
}

async function cookieBakerScroll(
  page: any,
  durationMs: number,
  state: { stop: { stopped: boolean } },
): Promise<void> {
  const end = Date.now() + durationMs;
  while (Date.now() < end && !state.stop.stopped) {
    const amount = 100 + Math.floor(Math.random() * 300);
    await page.evaluate((n: number) => window.scrollBy(0, n), amount).catch(() => {});
    await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 600)));
  }
}

export const automationEngine = new AutomationEngine();
