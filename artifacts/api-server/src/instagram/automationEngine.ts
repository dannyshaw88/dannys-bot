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
import { applyStealthScripts, getExistingBrowser, viewportForUA, apiSessionEpochs } from "./browserSession";
import type { Profile, Tool, Source } from "../shared/schema";
import { profileUsernameCache } from "../lib/profileUsernameCache";
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

  // ── Lifecycle ────────────────────────────────────────────────────────────
  start() {
    console.log("[engine] Automation engine started");
    this.reconcile();
    setInterval(() => this.reconcile(), 10_000);
  }

  triggerReconcile() { this.reconcile().catch(() => {}); }

  private async reconcile() {
    try {
      // On app startup (first reconcile, this.initialized = false): apply the configured X-Y
      // minute initial delay so multiple profiles don't all fire at once.
      // On manual toggle-on (any subsequent reconcile, this.initialized = true): run immediately
      // — the user just enabled the tool and expects it to start now.
      // Copy Settings "Randomise timing" staggerOffsetMins is handled inside each launcher
      // independently of this flag, so it still staggers even on a manual toggle.
      const runImmediately = this.initialized;

      const profiles = (await storage.getProfiles()).filter((p: any) => !p.creatorMode);

      // Keep the username cache current so the HTTP logger can resolve IDs → names.
      profileUsernameCache.setMany(profiles);

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
          if (!this.contactStates.has(profile.id)) this.launchContact(profile, contactTool!, profileRunImmediately);
        }

        // Human session runner has its own tool record — completely independent of all other tools
        const humanSessionTool = tools.find(t => t.type === "human_sessions" && t.enabled);
        if (humanSessionTool && profile.accountStatus === "valid") {
          activeHumanSession.add(profile.id);
          if (!this.humanSessionStates.has(profile.id)) this.launchHumanSession(profile, humanSessionTool, profileRunImmediately);
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
      client.setDeviceInfo(profile.igDeviceState, profile.userAgentApi, profile.igApiCookies);
      client.loadBrowserCookies();
      try {
        stats = await client.getOwnProfileStats();
      } catch (syncErr: any) {
        // getOwnProfileStats re-throws account-level errors (banned, suspended,
        // logged_out, challenge, etc.) so we can update accountStatus immediately
        // rather than leaving the account showing as "valid" indefinitely.
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
          this.logAction(freshProfile.id, followTool.id, "tool_complete", "", "", "", "ok", `Follow Tool session complete ${summary}`);
        } catch (err: any) {
          const acctStatus = await this.applyAccountLevelError(freshProfile.id, err?.message ?? "", state, followTool.id);
          this.logAction(freshProfile.id, followTool.id, "tool_complete", "", "", "", "error", `Follow Tool session error: ${err?.message ?? "unknown"}`);
          console.error(`[engine] @${freshProfile.username}: unexpected session error: ${err?.message}`);
          if (acctStatus) break;
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
          await sleepInterruptible(5 * 60_000, state.stop);
          continue;
        }
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
            await storage.incrementStat(freshProfile.id, "human_session");
            this.logAction(freshProfile.id, hsTool.id, "tool_complete", "", "", "", "ok", "Human Session complete");
          } catch (err: any) {
            const acctStatus = await this.applyAccountLevelError(freshProfile.id, err?.message ?? "", state, hsTool.id);
            this.logAction(freshProfile.id, hsTool.id, "tool_complete", "", "", "", "error", `Human Session error: ${err?.message ?? "unknown"}`);
            console.error(`[engine] @${freshProfile.username}: human session error: ${err?.message}`);
            if (acctStatus) break;
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
      this.runnerCrashedIds.add(profile.id);
      this.humanSessionStates.delete(profile.id);
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
        if (freshProfile.accountStatus === "banned" || freshProfile.accountStatus === "suspended" || freshProfile.accountStatus === "compromised" || freshProfile.accountStatus === "account_disabled") break;
        if (freshProfile.accountStatus === "bad_password") { engineLog("WARN", `@${freshProfile.username}: bad_password — pausing 10min`); await sleep(10 * 60_000); continue; }
        if (freshProfile.accountStatus === "logged_out")   { engineLog("WARN", `@${freshProfile.username}: logged_out — pausing 5min`);  await sleep(5  * 60_000); continue; }
        if (freshProfile.accountStatus !== "valid") { await sleep(5 * 60_000); continue; }
        if (freshProfile.accountStatus === "captcha") { await sleep(5 * 60_000); continue; }

        const tools = await storage.getToolsByProfile(freshProfile.id);
        const unfollowTool = tools.find(t => t.type === "unfollow");
        if (!unfollowTool?.enabled || state.stop.stopped) break;

        this.logAction(freshProfile.id, unfollowTool.id, "tool_start", "", "", "", "ok", "Unfollow Tool session started");
        try {
          await this.runUnfollowSession(freshProfile, unfollowTool, state);
          this.logAction(freshProfile.id, unfollowTool.id, "tool_complete", "", "", "", "ok", "Unfollow Tool session complete");
        } catch (err: any) {
          const acctStatus = await this.applyAccountLevelError(freshProfile.id, err?.message ?? "", state, unfollowTool.id);
          this.logAction(freshProfile.id, unfollowTool.id, "tool_complete", "", "", "", "error", `Unfollow Tool session error: ${err?.message ?? "unknown"}`);
          console.error(`[engine] @${freshProfile.username}: unfollow session error: ${err?.message}`);
          if (acctStatus) break;
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
        if (freshProfile.accountStatus === "banned" || freshProfile.accountStatus === "suspended" || freshProfile.accountStatus === "compromised" || freshProfile.accountStatus === "account_disabled") break;
        if (freshProfile.accountStatus === "bad_password") { engineLog("WARN", `@${freshProfile.username}: bad_password — pausing 10min`); await sleep(10 * 60_000); continue; }
        if (freshProfile.accountStatus === "logged_out")   { engineLog("WARN", `@${freshProfile.username}: logged_out — pausing 5min`);  await sleep(5  * 60_000); continue; }
        if (freshProfile.accountStatus !== "valid") { await sleep(5 * 60_000); continue; }
        if (freshProfile.accountStatus === "captcha") { await sleep(5 * 60_000); continue; }

        const tools = await storage.getToolsByProfile(freshProfile.id);
        const dmTool = tools.find(t => t.type === "dm");
        if (!dmTool?.enabled || state.stop.stopped) break;

        this.logAction(freshProfile.id, dmTool.id, "tool_start", "", "", "", "ok", "DM Tool session started");
        try {
          await this.runDMSession(freshProfile, dmTool, state);
          this.logAction(freshProfile.id, dmTool.id, "tool_complete", "", "", "", "ok", "DM Tool session complete");
        } catch (err: any) {
          const acctStatus = await this.applyAccountLevelError(freshProfile.id, err?.message ?? "", state, dmTool.id);
          this.logAction(freshProfile.id, dmTool.id, "tool_complete", "", "", "", "error", `DM Tool session error: ${err?.message ?? "unknown"}`);
          console.error(`[engine] @${freshProfile.username}: DM session error: ${err?.message}`);
          if (acctStatus) break;
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
        if (freshProfile.accountStatus === "banned" || freshProfile.accountStatus === "suspended" || freshProfile.accountStatus === "compromised" || freshProfile.accountStatus === "account_disabled") break;
        if (freshProfile.accountStatus === "bad_password") { engineLog("WARN", `@${freshProfile.username}: bad_password — pausing 10min`); await sleep(10 * 60_000); continue; }
        if (freshProfile.accountStatus === "logged_out")   { engineLog("WARN", `@${freshProfile.username}: logged_out — pausing 5min`);  await sleep(5  * 60_000); continue; }
        if (freshProfile.accountStatus !== "valid") { await sleep(5 * 60_000); continue; }
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
      }).catch(() => {});
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
      this.logAction(profile.id, tool.id, "action_suspended", "", "", "", "skipped", `Tool paused — blocked by Instagram. ${remStr} remaining`);
      return 0;
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
          if (s.stopOnBlockEnabled && (s.stopOnBlockMinutes ?? 0) > 0) {
            const _blockedUntilMs = Date.now() + (s.stopOnBlockMinutes * 60_000);
            const _untilStr = new Date(_blockedUntilMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
            await storage.updateTool(tool.id, { settings: { ...s, toolBlockedUntil: _blockedUntilMs } });
            this.logAction(profile.id, tool.id, "action_suspended", msg.instagramUsername, "", "", "suspended", `Tool stopped — blocked by Instagram. Suspended until ${_untilStr}`);
          }
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
        const errMsg = e?.message ?? "";
        const acctStatus = await this.applyAccountLevelError(profile.id, errMsg, state, tool.id);
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
      // EB-FIRST RULE: seed the mobile session from fresh EB web cookies only if
      // there is no existing verified mobile session (igApiCookies from a Verify
      // Credentials run).  Verified sessions have gone through the cold-start
      // device registration sequence and are accepted by i.instagram.com.
      // EB-bootstrapped cookies lack that registration so they are rejected by the
      // mobile API.  Preserving the verified session here prevents the EB bootstrap
      // from clobbering valid igApiCookies on every engine cycle.
      const alreadyVerified = client.isMobileLoggedIn();
      if (alreadyVerified) {
        console.log(`[engine] @${profile.username}: verified igApiCookies mobile session preserved (EB bootstrap skipped)`);
      } else {
        const mobileBootOk = client.mobileBootstrapFromWebCookies();
        if (mobileBootOk) {
          console.log(`[engine] @${profile.username}: mobile session seeded from EB cookies (account not yet verified — Watch Stories/Reels may be skipped until Verify Credentials is run)`);
        } else {
          // EB cookie file exists but has no sessionid — EB is not properly logged in.
          // Do NOT fall back to a cold mobile API login. Mobile-API tools (Watch Reels,
          // Watch Stories) will be skipped this session. The account needs to be
          // re-verified via the Verify button so the EB logs in and saves a sessionid.
          console.warn(`[engine] @${profile.username}: EB cookie file has no sessionid — mobile-API tools skipped this session. Re-verify the account via the Verify button.`);
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

    // EB-first enforcement: reaching here means the EB browser is NOT providing
    // a fresh session (browserOk = false) AND no stored API session is available
    // (isMobileLoggedIn = false).  Do NOT attempt a cold mobile login — calling
    // the Instagram API before any EB session has been established is a trust-
    // signal Instagram uses to flag accounts.  Instead, skip this run and let
    // the runner retry on the next cycle.  The account should be verified via
    // the embedded browser first (Verify Credentials button).
    console.warn(`[engine] @${profile.username}: no EB session and no stored mobile session — skipping run (verify the account in the browser first)`);
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
  ): Promise<boolean> {
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
              // Jarvee ABD dismiss — try before applying suspension
              await storage.updateProfile(profile.id, { accountStatus: "automated_behaviour_detected" });
              const abdOk = await client.tryDismissABD();
              if (abdOk) {
                await storage.updateProfile(profile.id, { accountStatus: "valid" });
                await storage.incrementStat(profile.id, "abd");
                console.log(`[engine] @${profile.username}: Like ABD auto-dismissed ✓ — continuing`);
                this.logAction(profile.id, tool.id, "abd_dismissed", uname, source.value, source.type, "ok", "Automated Behavior warning auto-dismissed");
                await sleep(5000);
                break; // stop liking this user's post but don't suspend
              }
              await storage.updateProfile(profile.id, { accountStatus: "valid" });
              this.recordActionBlock(state, profile.id, tool.id, "like", "Like", uname, source.value, source.type);
              break;
            } else if (liked) {
              this.bumpAction(state, "like");
              await storage.incrementStat(profile.id, "like");
              console.log(`[engine] @${profile.username}: ♥ liked post of @${uname} (${i + 1}/${likeCount})`);
              this.logAction(profile.id, tool.id, "like", uname, source.value, source.type, "ok", `Liked post (${i + 1}/${likeCount})`);
              await sleep(randInt((s.likeDelayMin ?? 2) * 1000, (s.likeDelayMax ?? 6) * 1000));
            }
          }
        } catch (e: any) {
          const acctStatus = await this.applyAccountLevelError(profile.id, e?.message ?? "", state, tool.id);
          if (acctStatus) {
            this.logAction(profile.id, tool.id, "like", uname, source.value, source.type, "error", `[${acctStatus}] ${e?.message}`);
            return true;
          }
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
            await storage.incrementStat(profile.id, "story");
            console.log(`[engine] @${profile.username}: 📖 viewed stories of @${uname} (${i + 1}/${storyCount})`);
            this.logAction(profile.id, tool.id, "view_stories", uname, source.value, source.type, "ok", `Stories viewed (${i + 1}/${storyCount})`);
            await sleep(randInt((s.viewStoriesDelayMin ?? 2) * 1000, (s.viewStoriesDelayMax ?? 6) * 1000));
          } else break;
        } catch (e: any) {
          const acctStatus = await this.applyAccountLevelError(profile.id, e?.message ?? "", state, tool.id);
          if (acctStatus) {
            this.logAction(profile.id, tool.id, "view_stories", uname, source.value, source.type, "error", `[${acctStatus}] ${e?.message}`);
            return true;
          }
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
          const acctStatus = await this.applyAccountLevelError(profile.id, e?.message ?? "", state, tool.id);
          if (acctStatus) {
            this.logAction(profile.id, tool.id, "view_reels", uname, source.value, source.type, "error", `[${acctStatus}] ${e?.message}`);
            return true;
          }
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
          const acctStatus = await this.applyAccountLevelError(profile.id, e?.message ?? "", state, tool.id);
          if (acctStatus) {
            this.logAction(profile.id, tool.id, "view_highlights", uname, source.value, source.type, "error", `[${acctStatus}] ${e?.message}`);
            return true;
          }
          console.warn(`[engine] highlights @${uname} error: ${e?.message}`);
          this.logAction(profile.id, tool.id, "view_highlights", uname, source.value, source.type, "error", e?.message ?? "");
          break;
        }
      }
    }
    return false;
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
      this.logAction(profile.id, tool.id, "action_suspended", "", "", "", "skipped", `Tool paused — blocked by Instagram. ${remStr} remaining`);
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
          if (s.stopOnBlockEnabled && (s.stopOnBlockMinutes ?? 0) > 0) {
            const _blockedUntilMs = Date.now() + (s.stopOnBlockMinutes * 60_000);
            const _untilStr = new Date(_blockedUntilMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
            await storage.updateTool(tool.id, { settings: { ...s, toolBlockedUntil: _blockedUntilMs } });
            this.logAction(profile.id, tool.id, "action_suspended", fu.instagramUsername, "", "", "suspended", `Tool stopped — blocked by Instagram. Suspended until ${_untilStr}`);
          }
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
        const msg = e?.message ?? "";
        const acctStatus = await this.applyAccountLevelError(profile.id, msg, state, tool.id);
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
        const msg = e?.message ?? "";
        const acctStatus = await this.applyAccountLevelError(profile.id, msg, state, tool.id);
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
    await storage.updateProfile(profileId, { accountStatus: status, statusMessage: rawError.slice(0, 500) });
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

  private async runHumanSessionTools(profile: Profile, tool: Tool, state: ProfileState): Promise<void> {
    const s = tool.settings as any;
    const client = await this.ensureClient(profile, state);
    if (!client) return;

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
          if (await checkSessionErr(e, "visit_notifications")) return;
          console.warn(`[engine] @${profile.username}: notifications error: ${e?.message}`);
        }
        try {
          await client.visitOwnProfile();
          console.log(`[engine] @${profile.username}: 👤 visited own profile`);
          this.logAction(profile.id, tool.id, "visit_own_profile", "", "", "", "ok", "Visited own profile page");
        } catch (e: any) {
          if (await checkSessionErr(e, "visit_own_profile")) return;
          console.warn(`[engine] @${profile.username}: own profile error: ${e?.message}`);
        }
        try {
          await client.refreshOwnProfile();
          console.log(`[engine] @${profile.username}: 🔄 refreshed own profile`);
          this.logAction(profile.id, tool.id, "refresh_own_profile", "", "", "", "ok", "Refreshed own profile feed");
        } catch (e: any) {
          if (await checkSessionErr(e, "refresh_own_profile")) return;
          console.warn(`[engine] @${profile.username}: refresh profile error: ${e?.message}`);
        }
        try {
          await client.visitSettingsAndActivity();
          console.log(`[engine] @${profile.username}: ⚙️ visited settings & activity`);
          this.logAction(profile.id, tool.id, "visit_settings_activity", "", "", "", "ok", "Visited settings and activity pages");
        } catch (e: any) {
          if (await checkSessionErr(e, "visit_settings_activity")) return;
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
        let viewed = 0;
        try {
          const vtfResult = await client.viewTimelineFeed(feedCount);
          if (vtfResult.sessionExpired) {
            const expReason = vtfResult.reason ?? "session expired (login_required) — viewTimelineFeed";
            console.warn(`[engine] @${profile.username}: viewTimelineFeed — session expired, marking logged_out`);
            await storage.updateProfile(profile.id, { accountStatus: "logged_out", statusMessage: expReason });
            this.logAction(profile.id, tool.id, "logged_out", "", "", "", "error", expReason);
            state.client = null;
            sessionError = "logged_out";
            return;
          }
          viewed = vtfResult.viewed;
          console.log(`[engine] @${profile.username}: 📰 viewed ${viewed} timeline post(s)`);
          this.logAction(profile.id, tool.id, "view_timeline_feed", "", "", "", "ok", `Viewed ${viewed} timeline post${viewed === 1 ? "" : "s"}`);
        } catch (e: any) {
          if (await checkSessionErr(e, "view_timeline_feed")) return;
          console.warn(`[engine] @${profile.username}: timeline feed error: ${e?.message}`);
        }

        // ── Like a % of viewed posts ─────────────────────────────────────────
        const likePctMin = Number(s.likeTimelinePostsPercentMin ?? 0);
        const likePctMax = Number(s.likeTimelinePostsPercentMax ?? 0);
        if (viewed > 0 && likePctMax > 0) {
          console.log(`[engine] @${profile.username}: ▶ INLINE LIKE% FIRED from viewTimelineFeed (likeTimelinePostsPercentMax=${likePctMax}). This is the source of any likes logged below.`);
          const pct = randInt(likePctMin, likePctMax);
          const likeCount = Math.max(1, Math.round(viewed * pct / 100));
          const likeDelayMin = Number(s.likeTimelinePostsDelayMin ?? 3);
          const likeDelayMax = Number(s.likeTimelinePostsDelayMax ?? 8);
          try {
            const { liked, watched, likedPosts, sessionExpired, sessionExpiredReason } = await client.likeTimelinePosts(likeCount, likeDelayMin, likeDelayMax);
            if (sessionExpired) {
              const expReason = sessionExpiredReason ?? "session expired (login_required) — likeTimelinePosts";
              console.warn(`[engine] @${profile.username}: likeTimelinePosts (from viewTimeline) — session expired, marking logged_out`);
              await storage.updateProfile(profile.id, { accountStatus: "logged_out", statusMessage: expReason });
              this.logAction(profile.id, tool.id, "logged_out", "", "", "", "error", expReason);
              state.client = null;
              sessionError = "logged_out";
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
          if (watched === -1) {
            console.warn(`[engine] @${profile.username}: ⚠️ View Stories skipped — no igApiCookies session (account not yet verified — run Verify Credentials first)`);
            this.logAction(profile.id, tool.id, "check_timeline_stories", "", "", "", "warn", "Skipped: no igApiCookies session — run Verify Credentials to establish one");
          } else if (watched === -5) {
            console.warn(`[engine] @${profile.username}: ⚠️ View Stories — Instagram rejected reels_tray (challenge/session error) — marking account`);
            const acctStatus = await this.applyAccountLevelError(profile.id, "challenge_required", state, tool.id);
            this.logAction(profile.id, tool.id, "check_timeline_stories", "", "", "", "error", `Instagram rejected reels_tray: challenge_required${acctStatus ? ` — account marked ${acctStatus}` : ""}`);
          } else if (watched === -2) {
            console.warn(`[engine] @${profile.username}: ⚠️ View Stories: tray was empty (0 stories in feed) — see server log for response keys`);
            this.logAction(profile.id, tool.id, "check_timeline_stories", "", "", "", "warn", "0 stories in feed — tray empty (Instagram returned no stories for this account's following list)");
          } else if (watched === -3) {
            console.warn(`[engine] @${profile.username}: ⚠️ View Stories: tray had entries but none contained story items — see server log for entry keys`);
            this.logAction(profile.id, tool.id, "check_timeline_stories", "", "", "", "warn", "View Stories: tray returned but no story items found in entries — check server log for details");
          } else {
            console.log(`[engine] @${profile.username}: 📖 watched ${watched} timeline stories`);
            this.logAction(profile.id, tool.id, "check_timeline_stories", "", "", "", "ok", `Watched ${watched} timeline stories`);
            for (let _i = 0; _i < watched; _i++) await storage.incrementStat(profile.id, "story");
          }
        } catch (e: any) {
          if (await checkSessionErr(e, "check_timeline_stories")) return;
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
        // When dmOk is false the API call itself failed (no cookies, network error,
        // or Instagram returned an error code) — use a clear failure label so the
        // activity ticker's red colour makes sense to the user.
        const dmLabel = dmOk
          ? `Checked ${dmCount} direct message${dmCount === 1 ? "" : "s"}`
          : "DM check failed";
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
        console.log(`[engine] @${profile.username}: ▶ ENQUEUE FIRED: likeTimelinePosts STANDALONE (likeTimelinePostsEnabled=true). This is the source of any likes logged below.`);
        const likeCount = randInt(s.likeTimelinePostsMin ?? 2, s.likeTimelinePostsMax ?? 5);
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
            sessionError = "logged_out";
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
            if (await checkSessionErr(e, "repost_local_folder")) return;
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
              this.logAction(profile.id, tool.id, "repost", sourceUsername, "", "", "fail", `Upload failed for @${sourceUsername} will retry next session`);
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

    // Sort ascending by order value (stable — ties keep insertion order)
    queue.sort((a, b) => a.order - b.order);

    const orderSummary = queue.map(e => `${e.label}(${e.order})`).join(" → ");
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
      this.logAction(profile.id, tool.id, "action_suspended", "", "", "", "skipped", `Tool paused — blocked by Instagram. ${remStr} remaining`);
      return { followed: 0, scraped: 0, dedupSkipped: 0, filterSkipped: 0, blocked: 0, skipped: 0 };
    }

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
    if (!client) return zero;

    // Pick source
    const sources = await storage.getSourcesByTool(tool.id);
    if (!sources.length) {
      engineLog("WARN", `@${profile.username}: follow tool has no sources — add hashtags or accounts in Follow Tool settings`);
      this.logAction(profile.id, tool.id, "follow", "", "", "", "skip", "No follow sources configured  add hashtag or account sources in Follow Tool settings");
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
          if (hikerClient) {
            const t0 = Date.now();
            resolved = await hikerClient.getUserByUsername(targetName);
            logHiker("GetUserByUsername", `Resolved @${targetName} via HikerAPI (cached for future runs)`, Date.now() - t0);
          } else {
            resolved = await client.searchUserByUsername(targetName);
          }
          if (!resolved) { console.error(`[engine] @${profile.username}: target @${targetName} not found`); return { followed: 0, scraped: 0, dedupSkipped: 0, filterSkipped: 0, blocked: 0, skipped: 0 }; }
          targetPk = resolved.pk;
          await storage.updateSourceTargetUserId(source.id, targetPk);
        }
        if (hikerClient) {
          const t0 = Date.now();
          candidates = await hikerClient.getFollowers(targetPk, processCount + 5);
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

    // Inject /api/v1/users/search/ before the very first follow of every session.
    // Simulates the user searching in the search bar before following — adds natural API signal.
    if (candidates.length > 0) {
      const searchQuery = source.type === "target_followers"
        ? source.value.replace(/^@/, "")
        : (candidates[0]?.username ?? source.value);
      if (searchQuery) {
        try {
          await client.searchUserByUsername(searchQuery);
          engineLog("INFO", `@${profile.username}: injected user search for "${searchQuery}" before first follow`);
        } catch { /* non-critical */ }
      }
    }

    const injectSuggestedEnabled = !!(s.injectSuggestedEnabled);
    const injectSuggestedMin     = Math.max(0, Math.min(100, s.injectSuggestedMin ?? 40));
    const injectSuggestedMax     = Math.max(0, Math.min(100, s.injectSuggestedMax ?? 60));

    const injectSearchEnabled = !!(s.injectSearchEnabled);
    const injectSearchMin     = Math.max(0, Math.min(100, s.injectSearchMin ?? 30));
    const injectSearchMax     = Math.max(0, Math.min(100, s.injectSearchMax ?? 50));

    let followed = 0, dedupSkipped = 0, filterSkipped = 0, blocked = 0, skipped = 0;
    let hitHardLimit = false; // true when a real cap/block/stop occurred (not just ran out of candidates)

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

      // Check if the follow action itself is currently suspended
      if (this.isActionSuspended(state, "follow")) {
        const rem = this.suspensionRemaining(state, "follow");
        console.log(`[engine] @${profile.username}: follow suspended (${rem} remaining) — skipping session`);
        this.logAction(profile.id, tool.id, "follow_blocked", user.username, source.value, source.type, "skipped", `Follow suspended ${rem} remaining`);
        blocked++;
        hitHardLimit = true; break;
      }

      // Pre-follow action variations (like, stories, reels, highlights)
      if (await this.preFollowActions(profile, tool, client, user, source, s, state, hikerClient)) { hitHardLimit = true; break; }

      // Inject GetSuggestedUsers and/or searchUserByUsername before some follows (follows 2+).
      // RULE: searchUserByUsername must NEVER fire immediately before getSuggestedUsers —
      // that is not a real app flow (you cannot reach suggested users from the search bar).
      // So we roll for getSuggestedUsers first; if it fires we skip the search injection for
      // this follow slot entirely.
      if (followed > 0) {
        let suggestedFired = false;

        if (injectSuggestedEnabled) {
          const threshold = randInt(injectSuggestedMin, injectSuggestedMax);
          if (Math.random() * 100 < threshold) {
            try {
              await client.getSuggestedUsers();
              engineLog("INFO", `@${profile.username}: injected getSuggestedUsers before follow #${followed + 1}`);
              suggestedFired = true;
            } catch { /* non-critical */ }
          }
        }

        // Only inject search if getSuggestedUsers did NOT fire this slot
        if (!suggestedFired && injectSearchEnabled) {
          const threshold = randInt(injectSearchMin, injectSearchMax);
          if (Math.random() * 100 < threshold) {
            try {
              await client.searchUserByUsername(user.username);
              engineLog("INFO", `@${profile.username}: injected searchUserByUsername("${user.username}") before follow #${followed + 1}`);
            } catch { /* non-critical */ }
          }
        }
      }

      // Follow
      let result: { ok: boolean; status?: string; reason?: string };
      try {
        const sourceLabel = source.value ? (source.type === "hashtag" ? `#${source.value}` : source.value) : undefined;
        result = await client.followUser(user.pk, user.username, sourceLabel);
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

      if (result.status === "user_not_found") {
        const reason = result.reason ?? `user ${user.username} not found (404)`;
        console.warn(`[engine] @${profile.username}: follow skipped @${user.username} — deleted/non-existent user (404)`);
        this.logAction(profile.id, tool.id, "follow_skipped", user.username, source.value, source.type, "skipped", `Stale user ID — account deleted or not found: ${reason}`);
        skipped++;
        if (followed + skipped + blocked >= processCount) break;
        continue;
      }

      if (result.status === "follow_blocked") {
        const reason = result.reason ?? "Instagram declined";
        console.warn(`[engine] @${profile.username}: follow blocked @${user.username} — ${reason}`);
        this.logAction(profile.id, tool.id, "follow_blocked", user.username, source.value, source.type, "skipped", reason);
        blocked++;

        // Session expired — mark logged_out and abort immediately
        if (reason.includes("login_required") || reason.includes("logged out") || reason.includes("logout")) {
          console.warn(`[engine] @${profile.username}: session expired (login_required) — marking logged_out, aborting session`);
          await storage.updateProfile(profile.id, { accountStatus: "logged_out", statusMessage: reason.slice(0, 500) });
          this.logAction(profile.id, tool.id, "logged_out", "", "", "", "error", reason.slice(0, 300));
          state.client = null;
          hitHardLimit = true; break;
        }

        // Only apply suspension for explicit Instagram account-level blocks
        const isLegitBlock = reason.includes("Please wait") || reason.includes("feedback_required") || reason.includes("something went wrong");
        if (isLegitBlock) {
          // Jarvee "Auto Verify Automatic Behaviour Detected": if the block is a soft
          // feedback_required ABD warning, try to dismiss it via the challenge endpoint
          // before applying the 24-hour suspension. If dismiss succeeds the session continues.
          if (reason.includes("feedback_required") && state.client) {
            await storage.updateProfile(profile.id, { accountStatus: "automated_behaviour_detected" });
            const abdOk = await state.client.tryDismissABD();
            if (abdOk) {
              await storage.updateProfile(profile.id, { accountStatus: "valid" });
              await storage.incrementStat(profile.id, "abd");
              console.log(`[engine] @${profile.username}: ABD auto-dismissed ✓ — continuing session`);
              this.logAction(profile.id, tool.id, "abd_dismissed", user.username, source.value, source.type, "ok", "Automated Behavior warning auto-dismissed — session continues");
              await sleep(5000); // brief cooldown after dismiss
              continue; // don't suspend, keep going with the next candidate
            }
            await storage.updateProfile(profile.id, { accountStatus: "valid" });
          }
          this.recordActionBlock(state, profile.id, tool.id, "follow", "Follow", user.username, source.value, source.type);
          if (s.stopOnBlockEnabled && (s.stopOnBlockMinutes ?? 0) > 0) {
            const _blockedUntilMs = Date.now() + (s.stopOnBlockMinutes * 60_000);
            const _untilStr = new Date(_blockedUntilMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
            await storage.updateTool(tool.id, { settings: { ...s, toolBlockedUntil: _blockedUntilMs } });
            this.logAction(profile.id, tool.id, "action_suspended", user.username, source.value, source.type, "suspended", `Tool stopped — blocked by Instagram. Suspended until ${_untilStr}`);
          }
          hitHardLimit = true; break; // Abort session immediately when legitimately blocked
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
      this.logAction(profile.id, tool.id, "follow", user.username, source.value, source.type, "ok", `Followed [${followed + 1}/${processCount}] users`);
      await storage.incrementStat(profile.id, "follow");
      this.bump(state);
      followed++;

      console.log(`[engine] @${profile.username}: ✓ @${user.username} [${followed}/${processCount}] day:${state.dailyCount}`);

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
    if (scrapeAllIfSkipped && !hitHardLimit && followed < processCount && !state.stop.stopped) {
      let extraRound = 0;
      while (followed < processCount && !hitHardLimit && !state.stop.stopped && extraRound < 20) {
        extraRound++;
        const availableSources = sameTypeSources.filter(s => !exhaustedSourceIds.has(s.id));
        if (!availableSources.length) break;
        // Rotate: start from the source AFTER the initial one so the first re-scrape
        // round always tries a fresh source (wraps back when only one source exists).
        const rescrapeSource = availableSources[(initialSourceIdx + extraRound) % availableSources.length];
        const needMore = processCount - followed;
        let moreCandidates: { pk: string; username: string; fullName: string }[] = [];
        try {
          if (rescrapeSource.type === "hashtag" && hikerClient) {
            const t0 = Date.now();
            const globalCursor = await storage.getHashtagCursor(rescrapeSource.value);
            const result = await hikerClient.getHashtagUsers(rescrapeSource.value, needMore + 5, globalCursor);
            moreCandidates = result.users;
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
                engineLog("INFO", `@${profile.username}: hashtag dedup (rescrape round ${extraRound}) — ${beforeDedup - moreCandidates.length} already-scraped removed from #${rescrapeSource.value}`);
              }
            }
            logHiker("HashtagScrape", `Re-scrape round ${extraRound} #${rescrapeSource.value} via HikerAPI (${moreCandidates.length} users)`, Date.now() - t0);
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
          exhaustedSourceIds.add(rescrapeSource.id);
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
          if (await this.preFollowActions(profile, tool, client, user, rescrapeSource, s, state, hikerClient)) { hitHardLimit = true; break; }
          let result: { ok: boolean; status?: string; reason?: string };
          try {
            const sourceLabel = rescrapeSource.value ? (rescrapeSource.type === "hashtag" ? `#${rescrapeSource.value}` : rescrapeSource.value) : undefined;
            result = await client.followUser(user.pk, user.username, sourceLabel);
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
          if (result.status === "follow_blocked") {
            blocked++;
            const reason = result.reason ?? "Instagram declined";
            if (reason.includes("login_required") || reason.includes("logged out") || reason.includes("logout")) {
              await storage.updateProfile(profile.id, { accountStatus: "logged_out", statusMessage: reason.slice(0, 500) });
              this.logAction(profile.id, tool.id, "logged_out", "", "", "", "error", reason.slice(0, 300));
              state.client = null; hitHardLimit = true; break;
            }
            if (reason.includes("Please wait") || reason.includes("feedback_required") || reason.includes("something went wrong")) {
              // Jarvee ABD dismiss — try to acknowledge soft "Automated Behavior" warnings
              if (reason.includes("feedback_required") && state.client) {
                await storage.updateProfile(profile.id, { accountStatus: "automated_behaviour_detected" });
                const abdOk = await state.client.tryDismissABD();
                if (abdOk) {
                  await storage.updateProfile(profile.id, { accountStatus: "valid" });
                  await storage.incrementStat(profile.id, "abd");
                  console.log(`[engine] @${profile.username}: ABD auto-dismissed ✓ — continuing session`);
                  this.logAction(profile.id, tool.id, "abd_dismissed", user.username, rescrapeSource.value, rescrapeSource.type, "ok", "Automated Behavior warning auto-dismissed — session continues");
                  await sleep(5000);
                  continue;
                }
                await storage.updateProfile(profile.id, { accountStatus: "valid" });
              }
              this.recordActionBlock(state, profile.id, tool.id, "follow", "Follow", user.username, rescrapeSource.value, rescrapeSource.type);
              hitHardLimit = true; break;
            }
            if (followed + blocked >= processCount) break;
            await sleep(randInt(followMin, followMax)); continue;
          }
          if (!result.ok) { skipped++; continue; }
          try {
            await storage.createFollowedUser({ profileId: profile.id, instagramUsername: user.username, instagramUserId: String(user.pk ?? ""), sourceValue: rescrapeSource.value, sourceType: rescrapeSource.type, followedAt: new Date().toISOString() });
          } catch {}
          this.logAction(profile.id, tool.id, "follow", user.username, rescrapeSource.value, rescrapeSource.type, "ok", `Followed [${followed + 1}/${processCount}] users`);
          await storage.incrementStat(profile.id, "follow");
          this.bump(state);
          followed++;
          console.log(`[engine] @${profile.username}: ✓ @${user.username} [${followed}/${processCount}] day:${state.dailyCount}`);
          await sleep(randInt(followMin, followMax));
        }
      }
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
    client.setDeviceInfo(profile.igDeviceState, profile.userAgentApi, profile.igApiCookies);
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
          proxyArg = [`--proxy-server=${linked.host}:${linked.port}`];
          if (linked.username) proxyAuth = { username: linked.username, password: linked.password ?? "" };
        }
      } catch {}
    } else if (profile.proxyHost && profile.proxyPort) {
      proxyArg = [`--proxy-server=${profile.proxyHost}:${profile.proxyPort}`];
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
