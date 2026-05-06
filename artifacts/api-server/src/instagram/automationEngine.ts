// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║                  ARCHITECTURE — READ THIS BEFORE TOUCHING ANYTHING          ║
// ╠══════════════════════════════════════════════════════════════════════════════╣
// ║                                                                              ║
// ║  THIS IS A MOBILE API BOT.                                                  ║
// ║                                                                              ║
// ║  ALL INSTAGRAM ACTIONS GO THROUGH THE MOBILE PRIVATE API (i.instagram.com). ║
// ║  This emulates a real Android Instagram app.  Every action — follow,        ║
// ║  unfollow, like, comment, DM, story view, profile read — uses the mobile    ║
// ║  API.  There are NO exceptions.                                              ║
// ║                                                                              ║
// ║  THE EMBEDDED BROWSER (EB) IS ONLY USED FOR:                                ║
// ║    • Manual browsing by the user (they are in control)                      ║
// ║    • Completing login challenges / CAPTCHAs so the API session recovers     ║
// ║    • NOTHING ELSE — the EB never performs automated actions                 ║
// ║                                                                              ║
// ║  NEVER:                                                                     ║
// ║    • Use Puppeteer / browser automation for any action                      ║
// ║    • Fall back to the EB browser when an API call fails                     ║
// ║    • Use www.instagram.com endpoints for automated actions                  ║
// ║                                                                              ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
import { storage } from "../storage";
import { InstagramWebClient } from "./instagramWebClient";
import { HikerApiClient } from "./hikerApiClient";
import { alterJpegBuffer, type AlterationLevel } from "./imageAlteration";
import type { ProxyConfig } from "./browserSession";
import type { Profile, Tool, Source } from "../shared/schema";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";

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
function isWithinActiveWindow(start: string, end: string): boolean {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s <= e ? cur >= s && cur <= e : cur >= s || cur <= e;
}

/** Minutes until the start of the active window. */
function minutesUntilWindowOpen(start: string): number {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(":").map(Number);
  const s = sh * 60 + sm;
  return s > cur ? s - cur : 1440 - cur + s;
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
  // Follow counters
  dailyCount: number;
  dailyDate: string;
  hourlyCount: number;
  hourlyHour: string;
  // Per-action variation counters (keyed by action name: like/viewStories/viewReels/viewHighlights/comment)
  actionDailyCount: Record<string, number>;
  actionDailyDate: string;
  actionHourlyCount: Record<string, number>;
  actionHourlyHour: string;
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

class AutomationEngine {
  private states          = new Map<number, ProfileState>(); // follow runners
  private unfollowStates  = new Map<number, ProfileState>(); // unfollow runners
  private dmStates             = new Map<number, ProfileState>(); // dm runners
  private contactStates        = new Map<number, ProfileState>(); // contact tool runners
  private humanSessionStates   = new Map<number, ProfileState>(); // independent human session runners
  private syncTimers           = new Map<number, number>();       // profileId → nextSyncAt (ms)
  private ownUserIdCache       = new Map<number, string>();       // profileId → Instagram pk (HikerAPI, resolved once)
  private contactForceRun      = new Set<number>();               // profileIds to run contact send immediately
  private followForceRun       = new Set<number>();               // profileIds to skip the inter-session wait immediately
  private initialized          = false;                          // false until first reconcile completes

  // ── Lifecycle ────────────────────────────────────────────────────────────
  start() {
    console.log("[engine] Automation engine started");
    this.reconcile();
    setInterval(() => this.reconcile(), 10_000);
  }

  triggerReconcile() { this.reconcile().catch(() => {}); }

  private async reconcile() {
    try {
      // Always apply the configured X-Y minute initial delay when a tool first starts —
      // whether triggered by server startup, a manual toggle, or a copy-settings operation.
      // This staggers multiple profiles from starting simultaneously and respects the user's
      // configured randomisation window.  Use "Run Now" to bypass the wait immediately.
      const runImmediately = false;

      const profiles = await storage.getProfiles();
      const activeFollow        = new Set<number>();
      const activeUnfollow      = new Set<number>();
      const activeDM            = new Set<number>();
      const activeContact       = new Set<number>();
      const activeHumanSession  = new Set<number>();

      for (const profile of profiles) {
        const tools = await storage.getToolsByProfile(profile.id);

        // Never run automation without a proxy — skip entirely if none is assigned
        const hasProxy = profile.proxyId
          ? true
          : !!(profile.proxyHost && profile.proxyPort);
        if (!hasProxy) continue;

        const followTool = tools.find(t => t.type === "follow" && t.enabled);
        if (followTool && profile.accountStatus === "valid") {
          activeFollow.add(profile.id);
          if (!this.states.has(profile.id)) this.launch(profile, followTool, runImmediately);
        }

        const unfollowTool = tools.find(t => t.type === "unfollow" && t.enabled);
        if (unfollowTool && profile.accountStatus === "valid") {
          activeUnfollow.add(profile.id);
          if (!this.unfollowStates.has(profile.id)) this.launchUnfollow(profile, unfollowTool, runImmediately);
        }

        const dmTool = tools.find(t => t.type === "dm" && t.enabled);
        if (dmTool && profile.accountStatus === "valid") {
          activeDM.add(profile.id);
          if (!this.dmStates.has(profile.id)) this.launchDM(profile, dmTool, runImmediately);
        }

        // Contact tool is "effectively enabled" if the top-level flag OR either
        // sub-feature toggle is on — the sub-toggles live in settings, not t.enabled.
        const contactTool = tools.find(t => t.type === "contact");
        const cs = contactTool?.settings as any;
        const contactEffective = contactTool && (
          contactTool.enabled ||
          cs?.contactUsersEnabled === true ||
          cs?.contactNewFollowersEnabled === true
        );
        if (contactEffective && profile.accountStatus === "valid") {
          activeContact.add(profile.id);
          if (!this.contactStates.has(profile.id)) this.launchContact(profile, contactTool!, runImmediately);
        }

        // Human session runner has its own tool record — completely independent of all other tools
        const humanSessionTool = tools.find(t => t.type === "human_sessions" && t.enabled);
        if (humanSessionTool && profile.accountStatus === "valid") {
          activeHumanSession.add(profile.id);
          if (!this.humanSessionStates.has(profile.id)) this.launchHumanSession(profile, humanSessionTool, runImmediately);
        }
      }

      for (const [id, state] of this.states) {
        if (!activeFollow.has(id)) {
          state.stop.stopped = true;
          this.states.delete(id);
          console.log(`[engine] Stopped follow runner for profile ${id}`);
        }
      }
      for (const [id, state] of this.unfollowStates) {
        if (!activeUnfollow.has(id)) {
          state.stop.stopped = true;
          this.unfollowStates.delete(id);
          console.log(`[engine] Stopped unfollow runner for profile ${id}`);
        }
      }
      for (const [id, state] of this.dmStates) {
        if (!activeDM.has(id)) {
          state.stop.stopped = true;
          this.dmStates.delete(id);
          console.log(`[engine] Stopped DM runner for profile ${id}`);
        }
      }
      for (const [id, state] of this.contactStates) {
        if (!activeContact.has(id)) {
          state.stop.stopped = true;
          this.contactStates.delete(id);
          console.log(`[engine] Stopped contact runner for profile ${id}`);
        }
      }
      for (const [id, state] of this.humanSessionStates) {
        if (!activeHumanSession.has(id)) {
          state.stop.stopped = true;
          this.humanSessionStates.delete(id);
          console.log(`[engine] Stopped human session runner for profile ${id}`);
        }
      }

      // ── Profile sync timers (independent of any tool runner) ──────────────
      for (const profile of profiles) {
        if (!profile.syncEnabled || !profile.syncIntervalMin) continue;
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
        // Time to sync
        this.runProfileSync(profile).catch((e: any) =>
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
      globalSettings.hikerApiToken
    );

    let stats: { followersCount: number; followingCount: number; postsCount: number } | null = null;

    if (useHiker) {
      const { HikerApiClient } = await import("./hikerApiClient");
      const hikerClient = new HikerApiClient(globalSettings.hikerApiToken!);
      stats = await hikerClient.getProfileStats(profile.username);
    } else {
      const proxyUrl = await this.buildProxyUrl(profile);
      const client = new InstagramWebClient(proxyUrl, profile.id);
      if (profile.userAgentEmbedded) client.setWebUserAgent(profile.userAgentEmbedded);
      if (profile.apiLimits) client.setApiLimits(profile.apiLimits as any);
      client.loadBrowserCookies();
      stats = await client.getOwnProfileStats();
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
    const state: ProfileState = {
      stop: { stopped: false },
      client: null,
      dailyCount: 0, dailyDate: todayStr(),
      hourlyCount: 0, hourlyHour: hourStr(),
      actionDailyCount: {}, actionDailyDate: todayStr(),
      actionHourlyCount: {}, actionHourlyHour: hourStr(),
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

      // On startup (tool was already enabled): schedule first run using configured X-Y timers.
      // On user toggle-on: runImmediately = true → skip this block and run right away.
      if (!runImmediately) {
        const si = (_tool.settings ?? {}) as any;
        const waitMs = randInt((si.delayMin ?? 1) * 60_000, (si.delayMax ?? 5) * 60_000);
        engineLog("INFO", `@${profile.username}: startup — first follow session in ${Math.round(waitMs / 60000)}min (Run Now will skip this wait)`);
        state.nextFollowAt = Date.now() + waitMs;
        // Use 1s-poll loop so "Run Now" can interrupt the startup wait immediately
        const startupEnd = Date.now() + waitMs;
        while (!state.stop.stopped && Date.now() < startupEnd && !this.followForceRun.has(profile.id)) {
          await sleep(1000);
        }
        this.followForceRun.delete(profile.id);
        state.nextFollowAt = 0;
        if (state.stop.stopped) return;
      }

      while (!state.stop.stopped) {
        const freshProfile = await storage.getProfile(profile.id);
        if (!freshProfile) {
          engineLog("WARN", `@${profile.username}: profile ${profile.id} not found in DB — exiting runner`);
          break;
        }

        // ── Account status gate ──────────────────────────────────────────────
        if (freshProfile.accountStatus === "banned") {
          engineLog("WARN", `@${freshProfile.username}: account banned — stopping runner`);
          break;
        }
        if (freshProfile.accountStatus === "captcha") {
          engineLog("WARN", `@${freshProfile.username}: captcha/checkpoint pending — pausing 5min`);
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

        this.logAction(freshProfile.id, followTool.id, "tool_start", "", "", "", "ok", "Follow Tool session started");
        let sessionResult: { followed: number; scraped: number; dedupSkipped: number; filterSkipped: number; blocked: number; skipped: number } = { followed: 0, scraped: 0, dedupSkipped: 0, filterSkipped: 0, blocked: 0, skipped: 0 };
        try {
          sessionResult = await this.runSession(freshProfile, followTool, state);
          const { followed, dedupSkipped, filterSkipped, blocked, skipped } = sessionResult;
          const parts: string[] = [];
          if (followed > 0)      parts.push(`${followed} followed`);
          if (dedupSkipped > 0)  parts.push(`${dedupSkipped} skipped`);
          if (filterSkipped > 0) parts.push(`${filterSkipped} filtered`);
          if (blocked > 0)       parts.push(`${blocked} blocked`);
          if (skipped > 0)       parts.push(`${skipped} skipped`);
          const summary = parts.length ? parts.join(", ") : "nothing to do";
          this.logAction(freshProfile.id, followTool.id, "tool_complete", "", "", "", "ok", `Follow Tool session complete — ${summary}`);
        } catch (err: any) {
          this.logAction(freshProfile.id, followTool.id, "tool_complete", "", "", "", "error", `Follow Tool session error: ${err?.message ?? "unknown"}`);
          console.error(`[engine] @${freshProfile.username}: unexpected session error: ${err?.message}`);
        }

        if (state.stop.stopped) break;

        // ── Auto follow/unfollow ─────────────────────────────────────────
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
              const delayMs = randInt(
                (sa.autoStartUnfollowAfterMin ?? 60) * 60_000,
                (sa.autoStartUnfollowAfterMax ?? 135) * 60_000,
              );
              console.log(`[engine] @${freshProfile.username}: auto: enabling unfollow tool in ${Math.round(delayMs / 60000)}min`);
              await sleepInterruptible(delayMs, state.stop);
              if (!state.stop.stopped) {
                const tools2 = await storage.getToolsByProfile(freshProfile.id);
                const unfollowTool2 = tools2.find(t => t.type === "unfollow");
                if (unfollowTool2) await storage.updateTool(unfollowTool2.id, { enabled: true });
                console.log(`[engine] @${freshProfile.username}: auto: unfollow tool enabled`);
              }
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
      this.states.delete(profile.id);
      engineLog("ERROR", `@${profile.username}: FATAL follow runner crash: ${err?.message ?? err}\n${err?.stack ?? ""}`);
    });
  }

  // ── Human session runner ──────────────────────────────────────────────────
  private launchHumanSession(profile: Profile, _tool: Tool, runImmediately = false) {
    const state: ProfileState = {
      stop: { stopped: false },
      client: null,
      dailyCount: 0, dailyDate: todayStr(),
      hourlyCount: 0, hourlyHour: hourStr(),
      actionDailyCount: {}, actionDailyDate: todayStr(),
      actionHourlyCount: {}, actionHourlyHour: hourStr(),
      actionSuspensions: {},
      nextHumanSessionAt: 0,   // run immediately on first tick
      lastHumanToolsEnabled: true,
      nextFollowAt: 0,
      nextContactAt: 0,
      nextUnfollowAt: 0,
    };
    // On startup: schedule first run using configured X-Y timers.
    // On user toggle-on (runImmediately = true): nextHumanSessionAt = 0 → fires right away.
    if (!runImmediately) {
      const si = (_tool.settings ?? {}) as any;
      const waitMs = randInt((si.delayMin ?? 30) * 60_000, (si.delayMax ?? 60) * 60_000);
      state.nextHumanSessionAt = Date.now() + waitMs;
      console.log(`[engine] @${profile.username}: startup — first human session in ${Math.round(waitMs / 60000)}min`);
    }
    this.humanSessionStates.set(profile.id, state);
    console.log(`[engine] Launching human session runner for @${profile.username}`);

    const loop = async () => {
      while (!state.stop.stopped) {
        const freshProfile = await storage.getProfile(profile.id);
        if (!freshProfile) break;
        if (freshProfile.accountStatus === "banned") break;
        if (freshProfile.accountStatus === "captcha") {
          await sleepInterruptible(5 * 60_000, state.stop);
          continue;
        }

        const freshTools = await storage.getToolsByProfile(freshProfile.id);
        const hsTool = freshTools.find(t => t.type === "human_sessions");
        // Exit if tool was disabled or deleted — reconcile will not re-launch
        if (!hsTool?.enabled) break;

        const s = hsTool.settings as any;

        if (Date.now() >= state.nextHumanSessionAt) {
          this.logAction(freshProfile.id, hsTool.id, "tool_start", "", "", "", "ok", "Human Session started");
          try {
            await this.runHumanSessionTools(freshProfile, hsTool, state);
            this.logAction(freshProfile.id, hsTool.id, "tool_complete", "", "", "", "ok", "Human Session complete");
          } catch (err: any) {
            this.logAction(freshProfile.id, hsTool.id, "tool_complete", "", "", "", "error", `Human Session error: ${err?.message ?? "unknown"}`);
            console.error(`[engine] @${freshProfile.username}: human session error: ${err?.message}`);
          }
          const waitMs = randInt(
            (s.delayMin ?? 30) * 60_000,
            (s.delayMax ?? 60) * 60_000,
          );
          state.nextHumanSessionAt = Date.now() + waitMs;
          console.log(`[engine] @${freshProfile.username}: next human session in ${Math.round(waitMs / 60000)}min`);
        }

        await sleepInterruptible(10_000, state.stop);
      }
      this.humanSessionStates.delete(profile.id);
      console.log(`[engine] Human session runner exited for @${profile.username}`);
    };

    loop().catch(err => {
      this.humanSessionStates.delete(profile.id);
      console.error(`[engine] Fatal human session error for @${profile.username}:`, err?.message);
    });
  }

  // ── Unfollow runner launch ─────────────────────────────────────────────────
  private launchUnfollow(profile: Profile, _tool: Tool, runImmediately = false) {
    const state: ProfileState = {
      stop: { stopped: false },
      client: null,
      dailyCount: 0, dailyDate: todayStr(),
      hourlyCount: 0, hourlyHour: hourStr(),
      actionDailyCount: {}, actionDailyDate: todayStr(),
      actionHourlyCount: {}, actionHourlyHour: hourStr(),
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
      // On startup: schedule first run using configured X-Y timers.
      // On user toggle-on: runImmediately = true → skip and run right away.
      if (!runImmediately) {
        const si = (_tool.settings ?? {}) as any;
        const waitMs = randInt((si.delayMin ?? 5) * 60_000, (si.delayMax ?? 15) * 60_000);
        console.log(`[engine] @${profile.username}: startup — first unfollow session in ${Math.round(waitMs / 60000)}min`);
        state.nextUnfollowAt = Date.now() + waitMs;
        await sleepInterruptible(waitMs, state.stop);
        state.nextUnfollowAt = 0;
        if (state.stop.stopped) return;
      }

      while (!state.stop.stopped) {
        const freshProfile = await storage.getProfile(profile.id);
        if (!freshProfile) break;
        if (freshProfile.accountStatus === "banned") break;
        if (freshProfile.accountStatus === "captcha") { await sleep(5 * 60_000); continue; }

        const tools = await storage.getToolsByProfile(freshProfile.id);
        const unfollowTool = tools.find(t => t.type === "unfollow");
        if (!unfollowTool?.enabled || state.stop.stopped) break;

        this.logAction(freshProfile.id, unfollowTool.id, "tool_start", "", "", "", "ok", "Unfollow Tool session started");
        try {
          await this.runUnfollowSession(freshProfile, unfollowTool, state);
          this.logAction(freshProfile.id, unfollowTool.id, "tool_complete", "", "", "", "ok", "Unfollow Tool session complete");
        } catch (err: any) {
          this.logAction(freshProfile.id, unfollowTool.id, "tool_complete", "", "", "", "error", `Unfollow Tool session error: ${err?.message ?? "unknown"}`);
          console.error(`[engine] @${freshProfile.username}: unfollow session error: ${err?.message}`);
        }

        if (state.stop.stopped) break;

        // ── Auto follow/unfollow (unfollow side) ─────────────────────────
        {
          const sa = unfollowTool.settings as any;
          if (sa.autoFollowUnfollowEnabled && (freshProfile.followingCount ?? 0) > 0) {
            const stopAt = randInt(
              sa.autoStopUnfollowAtFollowingsMin ?? 7000,
              sa.autoStopUnfollowAtFollowingsMax ?? 7000,
            );
            if ((freshProfile.followingCount ?? 0) <= stopAt) {
              console.log(`[engine] @${freshProfile.username}: followings ${freshProfile.followingCount} <= ${stopAt} — auto: disabling unfollow tool`);
              await storage.updateTool(unfollowTool.id, { enabled: false });
              const delayMs = randInt(
                (sa.autoStartFollowAfterMin ?? 60) * 60_000,
                (sa.autoStartFollowAfterMax ?? 135) * 60_000,
              );
              console.log(`[engine] @${freshProfile.username}: auto: enabling follow tool in ${Math.round(delayMs / 60000)}min`);
              await sleepInterruptible(delayMs, state.stop);
              if (!state.stop.stopped) {
                const tools2 = await storage.getToolsByProfile(freshProfile.id);
                const followTool2 = tools2.find(t => t.type === "follow");
                if (followTool2) await storage.updateTool(followTool2.id, { enabled: true });
                console.log(`[engine] @${freshProfile.username}: auto: follow tool enabled`);
              }
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
      this.unfollowStates.delete(profile.id);
      console.error(`[engine] Fatal unfollow error for @${profile.username}:`, err?.message);
    });
  }

  // ── DM runner launch ─────────────────────────────────────────────────────
  private launchDM(profile: Profile, _tool: Tool, runImmediately = false) {
    const state: ProfileState = {
      stop: { stopped: false },
      client: null,
      dailyCount: 0, dailyDate: todayStr(),
      hourlyCount: 0, hourlyHour: hourStr(),
      actionDailyCount: {}, actionDailyDate: todayStr(),
      actionHourlyCount: {}, actionHourlyHour: hourStr(),
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
      // On startup: schedule first run using configured X-Y timers.
      // On user toggle-on: runImmediately = true → skip and run right away.
      if (!runImmediately) {
        const si = (_tool.settings ?? {}) as any;
        const waitMs = randInt((si.delayMin ?? 10) * 60_000, (si.delayMax ?? 30) * 60_000);
        console.log(`[engine] @${profile.username}: startup — first DM session in ${Math.round(waitMs / 60000)}min`);
        await sleepInterruptible(waitMs, state.stop);
        if (state.stop.stopped) return;
      }

      while (!state.stop.stopped) {
        const freshProfile = await storage.getProfile(profile.id);
        if (!freshProfile) break;
        if (freshProfile.accountStatus === "banned") break;
        if (freshProfile.accountStatus === "captcha") { await sleep(5 * 60_000); continue; }

        const tools = await storage.getToolsByProfile(freshProfile.id);
        const dmTool = tools.find(t => t.type === "dm");
        if (!dmTool?.enabled || state.stop.stopped) break;

        this.logAction(freshProfile.id, dmTool.id, "tool_start", "", "", "", "ok", "DM Tool session started");
        try {
          await this.runDMSession(freshProfile, dmTool, state);
          this.logAction(freshProfile.id, dmTool.id, "tool_complete", "", "", "", "ok", "DM Tool session complete");
        } catch (err: any) {
          this.logAction(freshProfile.id, dmTool.id, "tool_complete", "", "", "", "error", `DM Tool session error: ${err?.message ?? "unknown"}`);
          console.error(`[engine] @${freshProfile.username}: DM session error: ${err?.message}`);
        }

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
      this.dmStates.delete(profile.id);
      console.error(`[engine] Fatal DM error for @${profile.username}:`, err?.message);
    });
  }

  // ── Contact (new-follower + users send) runner ────────────────────────────
  private launchContact(profile: Profile, _tool: Tool, runImmediately = false) {
    const state: ProfileState = {
      stop: { stopped: false },
      client: null,
      dailyCount: 0, dailyDate: todayStr(),
      hourlyCount: 0, hourlyHour: hourStr(),
      actionDailyCount: {}, actionDailyDate: todayStr(),
      actionHourlyCount: {}, actionHourlyHour: hourStr(),
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
    const _followerWaitMs = runImmediately ? 0 : randInt(
      (_cs.contactUsersDelayMin ?? _cs.delayMin ?? 30) * 60_000,
      (_cs.contactUsersDelayMax ?? _cs.delayMax ?? 60) * 60_000,
    );
    const _usersWaitMs = runImmediately ? 0 : randInt(
      (_cs.contactUsersDelayMin ?? _cs.delayMin ?? 30) * 60_000,
      (_cs.contactUsersDelayMax ?? _cs.delayMax ?? 60) * 60_000,
    );
    if (!runImmediately) {
      console.log(`[engine] @${profile.username}: startup — first contact run in ${Math.round(_followerWaitMs / 60000)}min`);
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
        if (freshProfile.accountStatus === "banned") break;
        if (freshProfile.accountStatus === "captcha") { await sleep(5 * 60_000); continue; }

        const tools = await storage.getToolsByProfile(freshProfile.id);
        const contactTool = tools.find(t => t.type === "contact");
        const cs2 = contactTool?.settings as any;
        const stillEnabled = contactTool && (
          contactTool.enabled ||
          cs2?.contactUsersEnabled === true ||
          cs2?.contactNewFollowersEnabled === true
        );
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
            this.logAction(freshProfile.id, contactTool.id, "tool_start", "", "", "", "ok", "Contact Tool: DM send session started");
            try {
              await this.runContactUsersSession(freshProfile, contactTool, state);
              this.logAction(freshProfile.id, contactTool.id, "tool_complete", "", "", "", "ok", "Contact Tool: DM send session complete");
            } catch (err: any) {
              this.logAction(freshProfile.id, contactTool.id, "tool_complete", "", "", "", "error", `Contact Tool DM send error: ${err?.message ?? "unknown"}`);
              console.error(`[engine] @${freshProfile.username}: contact-users send session error: ${err?.message}`);
            }
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

    const hikerClient = useHiker ? new HikerApiClient(globalSettings.hikerApiToken!) : null;

    // When HikerAPI is enabled, resolve own user ID through HikerAPI (no account API call).
    // Otherwise fall back to account client.
    let ownUserId: string | null = null;
    if (hikerClient) {
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
          message: ownUserId ? `Resolved pk=${ownUserId} for @${profile.username} (cached for future runs)` : `Could not resolve @${profile.username}`,
          source: "HikerAPI",
          navChain: "",
          ipAddress: "",
          durationMs: Date.now() - t0,
        });
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

    let followers: { pk: string; username: string; fullName: string }[] = [];
    if (hikerClient) {
      const t1 = Date.now();
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
      });
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
      });
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
      const text = this.applySpintax(messageTemplate);
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
  private async runContactUsersSession(profile: Profile, tool: Tool, state: ProfileState): Promise<void> {
    const s = tool.settings as any;

    const pending = await storage.getContactPendingMessages(profile.id, "pending");
    if (!pending.length) {
      console.log(`[engine] @${profile.username}: no pending contact messages to send`);
      return;
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

    let sent = 0;
    for (const msg of queue) {
      if (state.stop.stopped) break;
      try {
        const result = await client.sendDirectMessage(msg.instagramUserId, msg.messageText, msg.instagramUsername);
        if (result === "blocked") {
          this.logAction(profile.id, tool.id, "contact_dm_blocked", msg.instagramUsername, "", "", "skipped", "Instagram action-blocked contact DM");
          await storage.updateContactPendingMessage(msg.id, { status: "failed" });
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
            `Contact DM sent (${msg.messageType}): "${msg.messageText.slice(0, 50)}"`);
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
        console.warn(`[engine] contact DM @${msg.instagramUsername} error: ${e?.message}`);
        // Leave as pending for transient errors; only mark failed for known permanent issues
        this.logAction(profile.id, tool.id, "contact_dm", msg.instagramUsername, "", "", "error", e?.message ?? "");
      }
    }
  }

  // ── Contact Unsends: call unsendDirectMessage on due messages ──────────────
  private async runContactUnsends(profile: Profile, state: ProfileState): Promise<void> {
    const due = await storage.getContactMessagesForUnsend(profile.id);
    if (!due.length) return;

    const client = await this.ensureClient(profile, state);
    if (!client) return;

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
      if (p) return { host: p.host, port: p.port, username: p.username ?? undefined, password: p.password ?? undefined };
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
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  }

  // ── Ensure logged-in client ───────────────────────────────────────────────
  private async ensureClient(profile: Profile, state: ProfileState): Promise<InstagramWebClient | null> {
    const proxyUrl = await this.buildProxyUrl(profile);
    if (!proxyUrl) {
      console.error(`[engine] @${profile.username}: no proxy assigned — refusing to connect without proxy`);
      return null;
    }

    // Create client once per profile lifecycle
    if (!state.client) {
      state.client = new InstagramWebClient(proxyUrl, profile.id);
      // Log every API call — no filtering.
      state.client.setLogger((op, durationMs, message) => {
        storage.createInstagramApiCall({
          profileId: profile.id,
          username: profile.username,
          operationName: op,
          date: new Date().toISOString(),
          message: message ?? "",
          source: "Account",
          durationMs,
        }).catch(() => {});
      });
    }

    // Always sync apiLimits from the profile (user may have changed them)
    const limits = profile.apiLimits as any;
    if (limits && typeof limits === "object") {
      state.client.setApiLimits({
        requestsMin:   Number(limits.requestsMin   ?? 1),
        requestsMax:   Number(limits.requestsMax   ?? 1),
        everySecondsMin: Number(limits.everySecondsMin ?? 1000),
        everySecondsMax: Number(limits.everySecondsMax ?? 30000),
      });
    }

    // Always sync the EB browser UA so webPost uses the same UA that created
    // the cookies — a UA mismatch causes Instagram to 302-redirect to login.
    if (profile.userAgentEmbedded) {
      state.client.setWebUserAgent(profile.userAgentEmbedded);
    }

    // Sync device state and stored API cookies. setDeviceInfo now eagerly calls
    // _restoreMobileFromApiCookies, so if the account was previously verified
    // isMobileLoggedIn() will return true immediately below — no web login needed.
    state.client.setDeviceInfo(profile.igDeviceState, profile.userAgentApi, profile.igApiCookies);

    const client = state.client;

    // Always sync EB browser cookies first — this makes the engine share the
    // same Instagram session as the embedded browser (which can follow freely).
    const browserOk = client.loadBrowserCookies();
    if (browserOk) {
      console.log(`[engine] @${profile.username}: using EB browser session (cookies synced)`);
      const current = await storage.getProfile(profile.id);
      if (current?.accountStatus === "logged_out") {
        await storage.updateProfile(profile.id, { accountStatus: "valid" });
      }
      if (!client.isMobileLoggedIn()) {
        console.log(`[engine] @${profile.username}: establishing mobile session for DMs...`);
        const mobileOk = await client.mobileLogin(
          profile.username,
          profile.password,
          profile.twoFASecretKey ?? undefined,
        );
        if (!mobileOk) {
          console.error(`[engine] @${profile.username}: mobile login FAILED — stored password may be wrong. Update it in Account Settings.`);
        }
      }
      return client;
    }

    // Mobile session already live from stored igApiCookies (set by Verify Credentials).
    // setDeviceInfo eagerly calls _restoreMobileFromApiCookies so this will be true
    // for any account that has been verified — no web login needed.
    if (client.isMobileLoggedIn()) {
      console.log(`[engine] @${profile.username}: resuming mobile API session from stored cookies`);
      return client;
    }

    // Per architecture rules: this is a pure API bot — web login is never used
    // for automation. All Instagram actions go through the mobile API.
    // Attempt a fresh mobile login if no session is available.
    const mobileOk = await client.mobileLogin(
      profile.username,
      profile.password,
      profile.twoFASecretKey ?? undefined,
    );

    if (mobileOk) {
      const current = await storage.getProfile(profile.id);
      if (current?.accountStatus === "logged_out") {
        await storage.updateProfile(profile.id, { accountStatus: "valid" });
      }
      console.log(`[engine] @${profile.username}: mobile API login OK`);
      return client;
    }

    // Mobile login failed — transient network/proxy issue.
    // Do NOT mark the account as logged_out; that flag is only set by an explicit
    // Verify Credentials action with a definitive bad-password response.
    console.warn(`[engine] @${profile.username}: mobile login failed — skipping session, status unchanged`);
    return null;
  }

  // ── Session action logger ─────────────────────────────────────────────────
  private logAction(profileId: number, toolId: number, action: string, targetUsername: string, sourceValue: string, sourceType: string, result: string, detail: string = "") {
    storage.createSessionAction({
      profileId, toolId, action, targetUsername,
      sourceValue, sourceType, result, detail,
      timestamp: new Date().toISOString(),
    }).catch(() => {});
  }

  // ── Per-action daily/hourly counter helpers ───────────────────────────────
  private actionDaily(state: ProfileState, key: string): number {
    if (state.actionDailyDate !== todayStr()) {
      state.actionDailyCount = {};
      state.actionDailyDate = todayStr();
    }
    return state.actionDailyCount[key] ?? 0;
  }
  private actionHourly(state: ProfileState, key: string): number {
    if (state.actionHourlyHour !== hourStr()) {
      state.actionHourlyCount = {};
      state.actionHourlyHour = hourStr();
    }
    return state.actionHourlyCount[key] ?? 0;
  }
  private bumpAction(state: ProfileState, key: string): void {
    this.actionDaily(state, key);
    this.actionHourly(state, key);
    state.actionDailyCount[key]  = (state.actionDailyCount[key]  ?? 0) + 1;
    state.actionHourlyCount[key] = (state.actionHourlyCount[key] ?? 0) + 1;
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

    if (isEscalated) {
      const msg = `⚠️ ESCALATED BLOCK — ${displayName} suspended for ${hours}h (block #${newCount}). Suspended until ${untilStr}`;
      console.warn(`[engine] @profile${profileId}: ${msg}`);
      this.logAction(profileId, toolId, "action_suspended", targetUsername, sourceValue, sourceType, "suspended", msg);
    } else {
      const msg = `${displayName} blocked by Instagram — 24h suspension applied. Suspended until ${untilStr}`;
      console.warn(`[engine] @profile${profileId}: ${msg}`);
      this.logAction(profileId, toolId, "action_suspended", targetUsername, sourceValue, sourceType, "suspended", msg);
    }
  }

  // Returns true if the action should fire before the follow, respecting all limits.
  // chanceMin/Max  = overall % probability to trigger this action at all
  // beforeMin/Max  = of those triggers, % to run BEFORE the follow
  // maxDayMin/Max  = daily cap (max number of times per day, randomised each check)
  // maxHourMin/Max = hourly cap
  private shouldDoAction(
    state: ProfileState,
    key: string,
    s: any,
    chanceMinKey: string, chanceMaxKey: string,
    beforeMinKey: string, beforeMaxKey: string,
    maxDayMinKey: string, maxDayMaxKey: string,
    maxHourMinKey: string, maxHourMaxKey: string,
  ): boolean {
    // 1. Overall chance roll
    const chance = randInt(s[chanceMinKey] ?? 0, s[chanceMaxKey] ?? 0);
    if (chance <= 0 || Math.random() * 100 >= chance) return false;

    // 2. Daily cap (0 = no limit)
    const maxDay = randInt(s[maxDayMinKey] ?? 0, s[maxDayMaxKey] ?? 0);
    if (maxDay > 0 && this.actionDaily(state, key) >= maxDay) return false;

    // 3. Hourly cap (0 = no limit)
    const maxHour = randInt(s[maxHourMinKey] ?? 0, s[maxHourMaxKey] ?? 0);
    if (maxHour > 0 && this.actionHourly(state, key) >= maxHour) return false;

    // 4. "Do before follow" probability — gates whether we act NOW (before follow)
    const beforePct = randInt(s[beforeMinKey] ?? 0, s[beforeMaxKey] ?? 0);
    if (beforePct <= 0 || Math.random() * 100 >= beforePct) return false;

    return true;
  }

  // ── Pre-follow action variations (like, stories, reels, highlights) ────────
  private async preFollowActions(
    profile: Profile,
    tool: Tool,
    client: InstagramWebClient,
    user: { pk: string; username: string },
    source: { value: string; type: string },
    s: any,
    state: ProfileState,
    hikerClient: HikerApiClient | null = null,
  ): Promise<void> {
    const uname = user.username;
    const uid = user.pk;

    // Like before follow
    if (
      !this.isActionSuspended(state, "like") &&
      this.shouldDoAction(state, "like", s,
        "likeChanceMin", "likeChanceMax",
        "likeBeforeMin", "likeBeforeMax",
        "likeMaxPerDayMin", "likeMaxPerDayMax",
        "likeMaxPerHourMin", "likeMaxPerHourMax",
      )
    ) {
      const likeCount = randInt(s.likeProcessMin ?? 1, s.likeProcessMax ?? 1);
      for (let i = 0; i < likeCount; i++) {
        try {
          const mediaId = hikerClient
            ? await hikerClient.getUserRecentMediaId(uid)
            : await client.getUserRecentMediaId(uid);
          if (mediaId) {
            const liked = await client.likeMedia(mediaId, uname);
            if (liked === "blocked") {
              this.recordActionBlock(state, profile.id, tool.id, "like", "Like", uname, source.value, source.type);
              break;
            } else if (liked) {
              this.bumpAction(state, "like");
              console.log(`[engine] @${profile.username}: ♥ liked post of @${uname} (${i + 1}/${likeCount})`);
              this.logAction(profile.id, tool.id, "like", uname, source.value, source.type, "ok", `Liked post (${i + 1}/${likeCount})`);
              await sleep(randInt((s.likeDelayMin ?? 2) * 1000, (s.likeDelayMax ?? 6) * 1000));
            }
          }
        } catch (e: any) {
          console.warn(`[engine] like @${uname} error: ${e?.message}`);
          this.logAction(profile.id, tool.id, "like", uname, source.value, source.type, "error", e?.message ?? "");
          break;
        }
      }
    } else if (this.isActionSuspended(state, "like")) {
      console.log(`[engine] @${profile.username}: like suspended (${this.suspensionRemaining(state, "like")} remaining) — skipping`);
    }

    // View stories before follow
    if (
      !this.isActionSuspended(state, "viewStories") &&
      this.shouldDoAction(state, "viewStories", s,
        "viewStoriesChanceMin", "viewStoriesChanceMax",
        "viewStoriesBeforeMin", "viewStoriesBeforeMax",
        "viewStoriesMaxPerDayMin", "viewStoriesMaxPerDayMax",
        "viewStoriesMaxPerHourMin", "viewStoriesMaxPerHourMax",
      )
    ) {
      const storyCount = randInt(s.viewStoriesProcessMin ?? 1, s.viewStoriesProcessMax ?? 3);
      for (let i = 0; i < storyCount; i++) {
        try {
          const ok = await client.viewStories(uid, uname);
          if (ok) {
            this.bumpAction(state, "viewStories");
            console.log(`[engine] @${profile.username}: 📖 viewed stories of @${uname} (${i + 1}/${storyCount})`);
            this.logAction(profile.id, tool.id, "view_stories", uname, source.value, source.type, "ok", `Stories viewed (${i + 1}/${storyCount})`);
            await sleep(randInt((s.viewStoriesDelayMin ?? 2) * 1000, (s.viewStoriesDelayMax ?? 6) * 1000));
          } else break;
        } catch (e: any) {
          console.warn(`[engine] stories @${uname} error: ${e?.message}`);
          this.logAction(profile.id, tool.id, "view_stories", uname, source.value, source.type, "error", e?.message ?? "");
          break;
        }
      }
    }

    // View reels before follow
    if (
      !this.isActionSuspended(state, "viewReels") &&
      this.shouldDoAction(state, "viewReels", s,
        "viewReelsChanceMin", "viewReelsChanceMax",
        "viewReelsBeforeMin", "viewReelsBeforeMax",
        "viewReelsMaxPerDayMin", "viewReelsMaxPerDayMax",
        "viewReelsMaxPerHourMin", "viewReelsMaxPerHourMax",
      )
    ) {
      const reelCount = randInt(s.viewReelsProcessMin ?? 1, s.viewReelsProcessMax ?? 2);
      for (let i = 0; i < reelCount; i++) {
        try {
          const ok = await client.viewReels(uid, uname);
          if (ok) {
            this.bumpAction(state, "viewReels");
            console.log(`[engine] @${profile.username}: 🎬 viewed reels of @${uname} (${i + 1}/${reelCount})`);
            this.logAction(profile.id, tool.id, "view_reels", uname, source.value, source.type, "ok", `Reels viewed (${i + 1}/${reelCount})`);
            await sleep(randInt((s.viewReelsDelayMin ?? 2) * 1000, (s.viewReelsDelayMax ?? 6) * 1000));
          } else break;
        } catch (e: any) {
          console.warn(`[engine] reels @${uname} error: ${e?.message}`);
          this.logAction(profile.id, tool.id, "view_reels", uname, source.value, source.type, "error", e?.message ?? "");
          break;
        }
      }
    }

    // View highlights before follow
    if (
      !this.isActionSuspended(state, "viewHighlights") &&
      this.shouldDoAction(state, "viewHighlights", s,
        "viewHighlightsChanceMin", "viewHighlightsChanceMax",
        "viewHighlightsBeforeMin", "viewHighlightsBeforeMax",
        "viewHighlightsMaxPerDayMin", "viewHighlightsMaxPerDayMax",
        "viewHighlightsMaxPerHourMin", "viewHighlightsMaxPerHourMax",
      )
    ) {
      const highlightCount = randInt(s.viewHighlightsProcessMin ?? 1, s.viewHighlightsProcessMax ?? 2);
      for (let i = 0; i < highlightCount; i++) {
        try {
          const ok = await client.viewHighlights(uid, uname);
          if (ok) {
            this.bumpAction(state, "viewHighlights");
            console.log(`[engine] @${profile.username}: ⭐ viewed highlights of @${uname} (${i + 1}/${highlightCount})`);
            this.logAction(profile.id, tool.id, "view_highlights", uname, source.value, source.type, "ok", `Highlights viewed (${i + 1}/${highlightCount})`);
            await sleep(randInt((s.viewHighlightsDelayMin ?? 2) * 1000, (s.viewHighlightsDelayMax ?? 6) * 1000));
          } else break;
        } catch (e: any) {
          console.warn(`[engine] highlights @${uname} error: ${e?.message}`);
          this.logAction(profile.id, tool.id, "view_highlights", uname, source.value, source.type, "error", e?.message ?? "");
          break;
        }
      }
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
    if (globalSettings.hikerApiEnabled === "true" && globalSettings.hikerApiToken) {
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
          this.logAction(profile.id, tool.id, "unfollow_blocked", fu.instagramUsername, "", "", "skipped", "Instagram action-blocked unfollow");
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
        console.warn(`[engine] unfollow @${fu.instagramUsername} error: ${e?.message}`);
        this.logAction(profile.id, tool.id, "unfollow", fu.instagramUsername, "", "", "error", e?.message ?? "");
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
      if (hikerClient) {
        const t0 = Date.now();
        resolved = await hikerClient.getUserByUsername(source.value.replace(/^@/, ""));
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
      if (hikerClient) {
        const t0 = Date.now();
        candidates = await hikerClient.getFollowers(targetUserId, processCount * 3);
        logHikerDM("FollowersScrape", `Scraped followers of @${source.value} via HikerAPI (${candidates.length} users)`, Date.now() - t0);
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
        const text = this.applySpintax(raw);
        const result = await client.sendDirectMessage(user.pk, text, user.username);
        if (result === "blocked") {
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
        console.warn(`[engine] DM @${user.username} error: ${e?.message}`);
        this.logAction(profile.id, tool.id, "dm", user.username, source.value, source.type, "error", e?.message ?? "");
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
  private shouldSkipDueToChance(s: any, minKey: string, maxKey: string): boolean {
    const min = Number(s[minKey] ?? 0);
    const max = Number(s[maxKey] ?? 0);
    if (min <= 0 && max <= 0) return false;
    const skipChance = randInt(min, max);
    return Math.random() * 100 < skipChance;
  }

  private async runHumanSessionTools(profile: Profile, tool: Tool, state: ProfileState): Promise<void> {
    const s = tool.settings as any;
    const client = await this.ensureClient(profile, state);
    if (!client) return;

    // Build the ordered action queue.
    // Each entry: { order: number (random from OrderMin/Max), run: async fn }
    // Actions are sorted ascending by order before executing, so lower numbers
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
      if (!enabled) return;
      if (this.shouldSkipDueToChance(s, notUsedMinKey, notUsedMaxKey)) return;
      const order = randInt(Number(s[orderMinKey] ?? 0), Number(s[orderMaxKey] ?? 0));
      queue.push({ order, label, run: fn });
    };

    // ── Human Session ────────────────────────────────────────────────────────
    enqueue("humanSession",
      s.humanSessionEnabled === true,
      "humanSessionNotUsedMin", "humanSessionNotUsedMax",
      "humanSessionOrderMin",   "humanSessionOrderMax",
      async () => {
        try {
          await client.visitNotifications();
          console.log(`[engine] @${profile.username}: 🔔 visited notifications`);
          this.logAction(profile.id, tool.id, "visit_notifications", "", "", "", "ok", "Visited notifications inbox");
        } catch (e: any) {
          console.warn(`[engine] @${profile.username}: notifications error: ${e?.message}`);
        }
        try {
          await client.visitOwnProfile();
          console.log(`[engine] @${profile.username}: 👤 visited own profile`);
          this.logAction(profile.id, tool.id, "visit_own_profile", "", "", "", "ok", "Visited own profile page");
        } catch (e: any) {
          console.warn(`[engine] @${profile.username}: own profile error: ${e?.message}`);
        }
        try {
          await client.refreshOwnProfile();
          console.log(`[engine] @${profile.username}: 🔄 refreshed own profile`);
          this.logAction(profile.id, tool.id, "refresh_own_profile", "", "", "", "ok", "Refreshed own profile feed");
        } catch (e: any) {
          console.warn(`[engine] @${profile.username}: refresh profile error: ${e?.message}`);
        }
        try {
          await client.visitSettingsAndActivity();
          console.log(`[engine] @${profile.username}: ⚙️ visited settings & activity`);
          this.logAction(profile.id, tool.id, "visit_settings_activity", "", "", "", "ok", "Visited settings and activity pages");
        } catch (e: any) {
          console.warn(`[engine] @${profile.username}: settings/activity error: ${e?.message}`);
        }
      },
    );

    // ── View Timeline Feed ───────────────────────────────────────────────────
    enqueue("viewTimelineFeed",
      s.viewTimelineFeedEnabled === true,
      "viewTimelineFeedNotUsedMin", "viewTimelineFeedNotUsedMax",
      "viewTimelineFeedOrderMin",   "viewTimelineFeedOrderMax",
      async () => {
        const feedCount = randInt(s.viewTimelineFeedMin ?? 3, s.viewTimelineFeedMax ?? 8);
        try {
          const viewed = await client.viewTimelineFeed(feedCount);
          console.log(`[engine] @${profile.username}: 📰 viewed ${viewed} timeline post(s)`);
          this.logAction(profile.id, tool.id, "view_timeline_feed", "", "", "", "ok", `Viewed ${viewed} timeline post${viewed === 1 ? "" : "s"}`);
        } catch (e: any) {
          console.warn(`[engine] @${profile.username}: timeline feed error: ${e?.message}`);
        }
      },
    );

    // ── Watch Timeline Reels ─────────────────────────────────────────────────
    enqueue("checkTimelineReels",
      s.checkTimelineReelsEnabled === true,
      "checkTimelineReelsNotUsedMin", "checkTimelineReelsNotUsedMax",
      "checkTimelineReelsOrderMin",   "checkTimelineReelsOrderMax",
      async () => {
        const reelCount = randInt(s.checkTimelineReelsMin ?? 3, s.checkTimelineReelsMax ?? 8);
        try {
          const watched = await client.viewTimelineReels(reelCount);
          console.log(`[engine] @${profile.username}: 🎬 watched ${watched} timeline reels`);
          this.logAction(profile.id, tool.id, "check_timeline_reels", "", "", "", "ok", `Watched ${watched} timeline reels`);
        } catch (e: any) {
          console.warn(`[engine] @${profile.username}: timeline reels error: ${e?.message}`);
        }
      },
    );

    // ── Watch Timeline Stories ───────────────────────────────────────────────
    enqueue("checkTimelineStories",
      s.checkTimelineStoriesEnabled === true,
      "checkTimelineStoriesNotUsedMin", "checkTimelineStoriesNotUsedMax",
      "checkTimelineStoriesOrderMin",   "checkTimelineStoriesOrderMax",
      async () => {
        const storyCount = randInt(s.checkTimelineStoriesMin ?? 3, s.checkTimelineStoriesMax ?? 8);
        try {
          const watched = await client.viewTimelineStories(storyCount);
          console.log(`[engine] @${profile.username}: 📖 watched ${watched} timeline stories`);
          this.logAction(profile.id, tool.id, "check_timeline_stories", "", "", "", "ok", `Watched ${watched} timeline stories`);
        } catch (e: any) {
          console.warn(`[engine] @${profile.username}: timeline stories error: ${e?.message}`);
        }
      },
    );

    // ── Check Direct Messages ────────────────────────────────────────────────
    enqueue("checkDm",
      s.checkDmEnabled === true,
      "checkDmNotUsedMin", "checkDmNotUsedMax",
      "checkDmOrderMin",   "checkDmOrderMax",
      async () => {
        let inboxThreads: { threadId: string; username: string; userId: string; firstName: string; items: { itemId: string; text: string; fromMe: boolean }[] }[] = [];
        let dmOpenCount = randInt(Number(s.checkDmMin ?? 1), Number(s.checkDmMax ?? 5));
        let dmCount = 0;
        let dmOk = false;
        try {
          const result = await client.getDirectMessagesInternal(dmOpenCount);
          inboxThreads = result.threads;
          dmCount = result.count;
          dmOk = result.ok;
          console.log(`[engine] @${profile.username}: 💬 checked DMs — opened ${dmCount}/${dmOpenCount} thread${dmOpenCount === 1 ? "" : "s"}${dmOk ? "" : " (read failed)"}`);
        } catch (e: any) {
          console.warn(`[engine] @${profile.username}: check DMs error: ${e?.message}`);
        }
        // Auto-reply scan reuses the already-fetched inbox threads (no second warm-up).
        // Strictly capped to the same dmOpenCount threads that were checked — no extras.
        let autoReplied = 0;
        try {
          autoReplied = await this.runAutoReplyCheck(profile, inboxThreads.slice(0, dmOpenCount), client);
        } catch (e: any) {
          console.warn(`[engine] @${profile.username}: auto-reply scan error: ${e?.message}`);
        }
        // Log combined result — appends auto-reply count only when triggers were found.
        const dmLabel = `Checked ${dmCount} direct message${dmCount === 1 ? "" : "s"}`;
        const detail = autoReplied > 0
          ? `${dmLabel}, ${autoReplied} scheduled for auto-reply`
          : dmLabel;
        this.logAction(profile.id, tool.id, "check_dm", "", "", "", dmOk ? "ok" : "error", detail);
      },
    );

    // ── Like Posts from Timeline ─────────────────────────────────────────────
    enqueue("likeTimelinePosts",
      s.likeTimelinePostsEnabled === true,
      "likeTimelinePostsNotUsedMin", "likeTimelinePostsNotUsedMax",
      "likeTimelinePostsOrderMin",   "likeTimelinePostsOrderMax",
      async () => {
        const likeCount = randInt(s.likeTimelinePostsMin ?? 2, s.likeTimelinePostsMax ?? 5);
        const likeDelayMin = Number(s.likeTimelinePostsDelayMin ?? 3);
        const likeDelayMax = Number(s.likeTimelinePostsDelayMax ?? 8);
        try {
          const { liked, watched, likedPosts } = await client.likeTimelinePosts(likeCount, likeDelayMin, likeDelayMax);
          const summary = watched > 0
            ? `Liked ${liked} post(s) from timeline (watched ${watched} reel(s) before liking)`
            : `Liked ${liked} post(s) from timeline`;
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
      !!(s.repostEnabled && (repostUsernameSourceActive || repostLocalFolderEnabled)),
      "repostNotUsedMin", "repostNotUsedMax",
      "repostOrderMin",   "repostOrderMax",
      async () => {
        // ── Local folder source ───────────────────────────────────────────────
        if (repostLocalFolderEnabled) {
          try {
            const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
            const entries = await fsPromises.readdir(repostLocalFolderPath);
            const imageFiles = entries.filter(f => IMAGE_EXTS.has(nodePath.extname(f).toLowerCase()));
            if (imageFiles.length === 0) {
              console.warn(`[engine] @${profile.username}: 🔁 local folder repost — no image files found in "${repostLocalFolderPath}"`);
              this.logAction(profile.id, tool.id, "repost", repostLocalFolderPath, "", "", "skip", "No image files found in local folder");
              return;
            }

            const targetCount = randInt(
              Math.max(1, Number(s.repostMin ?? 1)),
              Math.max(1, Number(s.repostMax ?? 1)),
            );
            const level = ((s.repostAlterationLevel ?? "small") as AlterationLevel);
            const captionTemplate = String(s.repostCaptionText ?? "").trim();
            const deleteAfterUpload = s.repostLocalFolderDeleteAfterUpload !== false;

            // Shuffle and pick targetCount files
            const shuffled = [...imageFiles].sort(() => Math.random() - 0.5);
            const picked = shuffled.slice(0, targetCount);
            let uploadedCount = 0;

            for (const fileName of picked) {
              const filePath = nodePath.join(repostLocalFolderPath, fileName);
              const rawBuffer = await fsPromises.readFile(filePath);
              const alteredBuffer = await alterJpegBuffer(rawBuffer, level, s.repostImageSettings);
              const caption = captionTemplate
                ? captionTemplate.replace(/\{own_username\}/g, profile.username)
                : "";

              const postedMediaId = await client.uploadPhoto(alteredBuffer, caption);
              if (postedMediaId) {
                if (s.repostDisableComments) {
                  try { await client.disableComments(postedMediaId); } catch { /* non-fatal */ }
                }
                console.log(`[engine] @${profile.username}: 🔁 uploaded from local folder: ${fileName} [${uploadedCount + 1}/${targetCount}]`);
                this.logAction(profile.id, tool.id, "repost", repostLocalFolderPath, fileName, "", "ok", `Uploaded from local folder: ${fileName} (alteration: ${level}) [${uploadedCount + 1}/${targetCount}]`);
                uploadedCount++;
                if (deleteAfterUpload) {
                  try { await fsPromises.unlink(filePath); } catch (e: any) {
                    console.warn(`[engine] @${profile.username}: could not delete ${filePath}: ${e?.message}`);
                  }
                }
              } else {
                console.warn(`[engine] @${profile.username}: 🔁 local folder upload failed: ${fileName}`);
                this.logAction(profile.id, tool.id, "repost", repostLocalFolderPath, fileName, "", "fail", `Upload failed for: ${fileName}`);
              }
            }
          } catch (e: any) {
            console.warn(`[engine] @${profile.username}: local folder repost error: ${e?.message}`);
            this.logAction(profile.id, tool.id, "repost", repostLocalFolderPath, "", "", "fail", e?.message ?? "unknown error");
          }
          return;
        }

        // ── @username source ──────────────────────────────────────────────────
        const sourceUsername = repostSourceUsername;
        try {
          const useHiker = !!s.repostUseHikerApi;

          // Toggle ON → HikerAPI only, hard fail if not configured (no fallback to account).
          // Toggle OFF → account's own session does the scrape.
          let feedItems: Awaited<ReturnType<HikerApiClient["getUserFeedItems"]>>;
          if (useHiker) {
            if (!repostHikerClient) {
              console.warn(`[engine] @${profile.username}: 🔁 repost skipped — HikerAPI toggled ON but not configured`);
              this.logAction(profile.id, tool.id, "repost", sourceUsername, "", "", "error", "HikerAPI toggled ON but not configured in Global Settings");
              return;
            }
            feedItems = await repostHikerClient.getUserFeedItems(sourceUsername);
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
            const imageBuffer   = await client.downloadImage(item.imageUrl);
            const alteredBuffer = await alterJpegBuffer(imageBuffer, level, s.repostImageSettings);
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
              this.logAction(profile.id, tool.id, "repost", sourceUsername, item.mediaId, item.shortcode, "ok", `Reposted from @${sourceUsername} (alteration: ${level}) [${repostedCount + 1}/${targetCount}]`);
              repostedCount++;
            } else {
              console.warn(`[engine] @${profile.username}: 🔁 upload failed for ${item.mediaId}`);
              this.logAction(profile.id, tool.id, "repost", sourceUsername, item.mediaId, "", "fail", "Upload failed");
            }
          }

          if (repostedCount === 0) {
            if (feedItems.length === 0) {
              // Feed returned nothing — likely a temporary API failure or empty source account.
              // Never auto-disable on an empty feed response.
              console.warn(`[engine] @${profile.username}: 🔁 repost skipped — feed returned 0 items for @${sourceUsername} (possible API issue)`);
              this.logAction(profile.id, tool.id, "repost", sourceUsername, "", "", "skip", `Feed returned no items for @${sourceUsername}`);
            } else if (uploadAttempted > 0) {
              // We found new posts but the upload itself failed — session/network issue, not exhausted.
              // Do NOT auto-disable; the next session will retry.
              console.warn(`[engine] @${profile.username}: 🔁 repost skipped — ${uploadAttempted} upload(s) failed for @${sourceUsername} (session issue, will retry)`);
              this.logAction(profile.id, tool.id, "repost", sourceUsername, "", "", "fail", `Upload failed for @${sourceUsername} — will retry next session`);
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
          console.warn(`[engine] @${profile.username}: repost error: ${e?.message}`);
          this.logAction(profile.id, tool.id, "repost", sourceUsername, "", "", "fail", e?.message ?? "unknown error");
        }
      },
    );

    // Sort ascending by order value (stable — ties keep insertion order)
    queue.sort((a, b) => a.order - b.order);

    const orderSummary = queue.map(e => `${e.label}(${e.order})`).join(" → ");
    console.log(`[engine] @${profile.username}: session order: ${orderSummary || "(nothing to run)"}`);

    // Execute in sorted order
    for (const entry of queue) {
      await entry.run();
    }
  }

  // ── Follow session ────────────────────────────────────────────────────────
  private async runSession(profile: Profile, tool: Tool, state: ProfileState): Promise<{ followed: number; scraped: number; dedupSkipped: number; filterSkipped: number; blocked: number; skipped: number }> {
    const s = tool.settings as any;
    const maxPerDay    = randInt(s.maxPerDayMin  ?? 150, s.maxPerDayMax  ?? 200);
    const maxPerHour   = randInt(s.maxPerHourMin ?? 5,   s.maxPerHourMax ?? 15);
    const processCount = randInt(s.processMin    ?? 5,   s.processMax    ?? 15);
    const followMin    = (s.delayAfterFollowMin  ?? 5)   * 1000;
    const followMax    = (s.delayAfterFollowMax  ?? 15)  * 1000;

    // Fetch global filter settings once per session
    const globalSettings = await storage.getGlobalSettings();
    const globalSkipFollowed = globalSettings.skipFollowedUsers === "true";
    const globalSkipSkipped  = globalSettings.skipAlreadySkippedUsers === "true";
    const toolSkipIndian     = !!(s.skipIndianUsers);

    // Build HikerAPI client if enabled
    const hikerEnabled = globalSettings.hikerApiEnabled === "true";
    const hikerToken   = globalSettings.hikerApiToken ?? "";
    const hikerClient: HikerApiClient | null = (hikerEnabled && hikerToken) ? new HikerApiClient(hikerToken) : null;
    if (hikerClient) engineLog("INFO", `@${profile.username}: using HikerAPI for scrape calls`);
    else engineLog("WARN", `@${profile.username}: HikerAPI disabled/no token — no scraping fallback, session will abort`);

    const zero = { followed: 0, scraped: 0, dedupSkipped: 0, filterSkipped: 0, blocked: 0, skipped: 0 };

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
    if (!client) return zero;

    // Pick source
    const sources = await storage.getSourcesByTool(tool.id);
    if (!sources.length) {
      engineLog("WARN", `@${profile.username}: follow tool has no sources — add hashtags or accounts in Follow Tool settings`);
      this.logAction(profile.id, tool.id, "follow", "", "", "", "skip", "No follow sources configured — add hashtag or account sources in Follow Tool settings");
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
        if (hikerClient) {
          const t0 = Date.now();
          const globalCursor = await storage.getHashtagCursor(source.value);
          const result = await hikerClient.getHashtagUsers(source.value, processCount + 5, globalCursor);
          candidates = result.users;
          if (result.nextCursor) {
            await storage.setHashtagCursor(source.value, result.nextCursor).catch(() => {});
          } else if (globalCursor) {
            await storage.setHashtagCursor(source.value, "").catch(() => {});
          }
          if (globalSettings.skipScrapedUsers === "true" && candidates.length > 0) {
            const ignoreDays = parseInt(globalSettings.scrapedUserIgnoreDays ?? "365", 10);
            const alreadyScraped = await storage.getScrapedUserIds(candidates.map(c => c.pk), ignoreDays);
            const fresh = candidates.filter(c => !alreadyScraped.has(c.pk));
            await storage.addScrapedUsers(fresh).catch(() => {});
            candidates = fresh;
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
          if (hikerClient) {
            const t0 = Date.now();
            resolved = await hikerClient.getUserByUsername(targetName);
            logHiker("GetUserByUsername", `Resolved @${targetName} via HikerAPI (cached for future runs)`, Date.now() - t0);
          } else {
            resolved = await client.searchUserByUsername(targetName);
          }
          if (!resolved) { console.error(`[engine] @${profile.username}: target @${targetName} not found`); return { followed: 0 }; }
          targetPk = resolved.pk;
          await storage.updateSourceTargetUserId(source.id, targetPk);
        }
        if (hikerClient) {
          const t0 = Date.now();
          candidates = await hikerClient.getFollowers(targetPk, processCount + 5);
          logHiker("FollowersScrape", `Scraped followers of @${targetName} via HikerAPI (${candidates.length} users)`, Date.now() - t0);
        } else {
          candidates = await client.getFollowers(targetPk, processCount + 5);
        }
      }
    } catch (err: any) {
      engineLog("ERROR", `@${profile.username}: scrape error: ${err?.message}`);
      if (/login_required|Not authenticated|session/i.test(err?.message ?? "")) state.client = null;
      return zero;
    }

    engineLog("INFO", `@${profile.username}: scraped ${candidates.length} candidates (target: ${processCount})`);

    let followed = 0, dedupSkipped = 0, filterSkipped = 0, blocked = 0, skipped = 0;

    for (const user of candidates) {
      if (followed >= processCount) break;
      if (state.stop.stopped) break;
      if (maxPerDay > 0 && this.daily(state) >= maxPerDay) { console.log(`[engine] @${profile.username}: daily cap hit mid-session`); break; }
      if (maxPerHour > 0 && this.hourly(state) >= maxPerHour) { console.log(`[engine] @${profile.username}: hourly cap hit mid-session`); await sleep(3_600_000); break; }

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

      // Check if the follow action itself is currently suspended
      if (this.isActionSuspended(state, "follow")) {
        const rem = this.suspensionRemaining(state, "follow");
        console.log(`[engine] @${profile.username}: follow suspended (${rem} remaining) — skipping session`);
        this.logAction(profile.id, tool.id, "follow_blocked", user.username, source.value, source.type, "skipped", `Follow suspended — ${rem} remaining`);
        blocked++;
        break;
      }

      // Pre-follow action variations (like, stories, reels, highlights)
      await this.preFollowActions(profile, tool, client, user, source, s, state, hikerClient);

      // Follow
      let result: { ok: boolean; status?: string; reason?: string };
      try {
        const sourceLabel = source.value ? (source.type === "hashtag" ? `#${source.value}` : source.value) : undefined;
        result = await client.followUser(user.pk, user.username, sourceLabel);
      } catch (err: any) {
        console.error(`[engine] @${profile.username}: follow @${user.username} threw: ${err?.message}`);
        this.logAction(profile.id, tool.id, "follow", user.username, source.value, source.type, "error", err?.message ?? "");
        continue;
      }

      if (result.status === "checkpoint_required") {
        const cpUrl = (result as any).checkpointUrl ?? "";
        console.warn(`[engine] @${profile.username}: checkpoint_required — setting status to captcha. Complete the challenge in the embedded browser.${cpUrl ? ` URL: ${cpUrl}` : ""}`);
        this.logAction(profile.id, tool.id, "follow_blocked", user.username, source.value, source.type, "skipped", `Captcha / security challenge required — complete in embedded browser`);
        // Mark account as captcha so the UI shows it and the runner pauses sessions
        await storage.updateProfile(profile.id, { accountStatus: "captcha" });
        break;
      }

      if (result.status === "follow_blocked") {
        const reason = result.reason ?? "Instagram declined";
        console.warn(`[engine] @${profile.username}: follow skipped @${user.username} — ${reason}`);
        this.logAction(profile.id, tool.id, "follow_blocked", user.username, source.value, source.type, "skipped", reason);
        blocked++;

        // Session expired — mark logged_out and abort immediately
        if (reason.includes("login_required") || reason.includes("logged out") || reason.includes("logout")) {
          console.warn(`[engine] @${profile.username}: session expired (login_required) — marking logged_out, aborting session`);
          await storage.updateProfile(profile.id, { accountStatus: "logged_out" });
          state.client = null;
          break;
        }

        // Only apply suspension for explicit Instagram account-level blocks
        const isLegitBlock = reason.includes("Please wait") || reason.includes("feedback_required");
        if (isLegitBlock) {
          this.recordActionBlock(state, profile.id, tool.id, "follow", "Follow", user.username, source.value, source.type);
          break; // Abort session immediately when legitimately blocked
        }

        // Blocked attempts count against the session limit (users per session = real API calls)
        if (followed + blocked >= processCount) break;

        // Always delay between attempts — even on block — to avoid hammering Instagram
        await sleep(randInt(followMin, followMax));
        continue;
      }

      if (!result.ok) {
        console.log(`[engine] @${profile.username}: skip @${user.username} (already following / private)`);
        this.logAction(profile.id, tool.id, "follow_skipped", user.username, source.value, source.type, "skipped", "Already following or private account");
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
      this.logAction(profile.id, tool.id, "follow", user.username, source.value, source.type, "ok", `Followed [${followed + 1}/${processCount}]`);
      await storage.incrementStat(profile.id, "follow");
      this.bump(state);
      followed++;

      console.log(`[engine] @${profile.username}: ✓ @${user.username} [${followed}/${processCount}] day:${state.dailyCount}`);

      // Inter-follow delay after every successful follow
      await sleep(randInt(followMin, followMax));
    }

    console.log(`[engine] @${profile.username}: session done — followed ${followed}/${processCount}`);
    return { followed, scraped: candidates.length, dedupSkipped, filterSkipped, blocked, skipped };
  }

  // ── Weighted source picker ────────────────────────────────────────────────
  private pickSource(sources: Source[]): Source {
    const total = sources.reduce((s, x) => s + (x.rank ?? 100), 0);
    let r = Math.random() * total;
    for (const src of sources) {
      r -= src.rank ?? 100;
      if (r <= 0) return src;
    }
    return sources[sources.length - 1];
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
        actionDailyCount: {}, actionDailyDate: "",
        actionHourlyCount: {}, actionHourlyHour: "",
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
      const useHiker = !!s.repostUseHikerApi;
      let feedItems: Awaited<ReturnType<HikerApiClient["getUserFeedItems"]>>;
      if (useHiker) {
        const gs_now = await storage.getGlobalSettings();
        const hikerClient = (gs_now.hikerApiEnabled === "true" && gs_now.hikerApiToken)
          ? new HikerApiClient(gs_now.hikerApiToken)
          : null;
        if (!hikerClient) {
          return { ok: false, message: "HikerAPI toggled ON but not configured in Global Settings — cannot scrape source feed." };
        }
        feedItems = await hikerClient.getUserFeedItems(sourceUsername);
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

      // Upload via private API
      const postedMediaId = await client.uploadPhoto(alteredBuffer, finalCaption);
      if (!postedMediaId) return { ok: false, message: "Upload failed — Instagram rejected the photo" };

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
      this.logAction(profileId, hsTool.id, "repost", sourceUsername, candidate.mediaId, candidate.shortcode, "ok", `[Manual] Reposted from @${sourceUsername} (alteration: ${level})`);

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
      state.nextHumanSessionAt = 0;
    } else {
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
        actionDailyCount: {}, actionDailyDate:  todayStr(),
        actionHourlyCount: {}, actionHourlyHour: hourStr(),
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

  // ── Status API ────────────────────────────────────────────────────────────
  getStatus(): { profileId: number; loggedIn: boolean; dailyCount: number; hourlyCount: number; nextHumanSessionAt: number; nextFollowAt: number; nextContactAt: number; nextUnfollowAt: number }[] {
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
      const unfollowState = this.unfollowStates.get(profileId);
      const anyState      = followState ?? humanState ?? contactState ?? unfollowState;
      return {
        profileId,
        loggedIn:           !!anyState?.client?.isLoggedIn(),
        dailyCount:         followState ? this.daily(followState) : 0,
        hourlyCount:        followState ? this.hourly(followState) : 0,
        nextHumanSessionAt: humanState?.nextHumanSessionAt ?? 0,
        nextFollowAt:       followState?.nextFollowAt ?? 0,
        nextContactAt:      contactState?.nextContactAt ?? 0,
        nextUnfollowAt:     unfollowState?.nextUnfollowAt ?? 0,
      };
    });
  }
}

export const automationEngine = new AutomationEngine();
