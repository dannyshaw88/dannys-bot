import { storage } from "../storage";
import { InstagramWebClient } from "./instagramWebClient";
import { HikerApiClient } from "./hikerApiClient";
import type { Profile, Tool, Source } from "../shared/schema";

// ── Helpers ───────────────────────────────────────────────────────────────────
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
}

class AutomationEngine {
  private states          = new Map<number, ProfileState>(); // follow runners
  private unfollowStates  = new Map<number, ProfileState>(); // unfollow runners
  private dmStates             = new Map<number, ProfileState>(); // dm runners
  private contactStates        = new Map<number, ProfileState>(); // contact tool runners
  private humanSessionStates   = new Map<number, ProfileState>(); // independent human session runners
  private syncTimers           = new Map<number, number>();       // profileId → nextSyncAt (ms)

  // ── Lifecycle ────────────────────────────────────────────────────────────
  start() {
    console.log("[engine] Automation engine started");
    this.reconcile();
    setInterval(() => this.reconcile(), 10_000);
  }

  private async reconcile() {
    try {
      const profiles = await storage.getProfiles();
      const activeFollow        = new Set<number>();
      const activeUnfollow      = new Set<number>();
      const activeDM            = new Set<number>();
      const activeContact       = new Set<number>();
      const activeHumanSession  = new Set<number>();

      for (const profile of profiles) {
        const tools = await storage.getToolsByProfile(profile.id);

        const followTool = tools.find(t => t.type === "follow" && t.enabled);
        if (followTool && profile.accountStatus === "valid") {
          activeFollow.add(profile.id);
          if (!this.states.has(profile.id)) this.launch(profile, followTool);
        }

        const unfollowTool = tools.find(t => t.type === "unfollow" && t.enabled);
        if (unfollowTool && profile.accountStatus === "valid") {
          activeUnfollow.add(profile.id);
          if (!this.unfollowStates.has(profile.id)) this.launchUnfollow(profile, unfollowTool);
        }

        const dmTool = tools.find(t => t.type === "dm" && t.enabled);
        if (dmTool && profile.accountStatus === "valid") {
          activeDM.add(profile.id);
          if (!this.dmStates.has(profile.id)) this.launchDM(profile, dmTool);
        }

        const contactTool = tools.find(t => t.type === "contact" && t.enabled);
        if (contactTool && profile.accountStatus === "valid") {
          activeContact.add(profile.id);
          if (!this.contactStates.has(profile.id)) this.launchContact(profile, contactTool);
        }

        // Human session runner has its own tool record — completely independent of all other tools
        const humanSessionTool = tools.find(t => t.type === "human_sessions" && t.enabled);
        if (humanSessionTool && profile.accountStatus === "valid") {
          activeHumanSession.add(profile.id);
          if (!this.humanSessionStates.has(profile.id)) this.launchHumanSession(profile, humanSessionTool);
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
  private launch(profile: Profile, _tool: Tool) {
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

      while (!state.stop.stopped) {
        const freshProfile = await storage.getProfile(profile.id);
        if (!freshProfile) break;

        // ── Account status gate ──────────────────────────────────────────────
        if (freshProfile.accountStatus === "banned") {
          console.log(`[engine] @${freshProfile.username}: account banned — stopping runner`);
          break;
        }
        if (freshProfile.accountStatus === "captcha") {
          console.log(`[engine] @${freshProfile.username}: captcha/checkpoint pending — pausing sessions. Complete the challenge in the embedded browser.`);
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
            console.log(`[engine] @${freshProfile.username}: outside active window (${freshProfile.activeTimerStart}–${freshProfile.activeTimerEnd}) — sleeping ${waitMin}min`);
            await sleep(waitMin * 60_000);
            continue;
          }
        }
        // ─────────────────────────────────────────────────────────────────────

        const tools = await storage.getToolsByProfile(freshProfile.id);
        const followTool = tools.find(t => t.type === "follow");
        if (!followTool?.enabled || state.stop.stopped) break;

        let sessionResult: { followed: number } = { followed: 0 };
        try {
          sessionResult = await this.runSession(freshProfile, followTool, state);
        } catch (err: any) {
          console.error(`[engine] @${freshProfile.username}: unexpected session error: ${err?.message}`);
        }

        if (state.stop.stopped) break;

        const s = followTool.settings as any;

        const waitMs = randInt(
          (s.delayMin ?? 1) * 60_000,
          (s.delayMax ?? 5) * 60_000,
        );
        console.log(`[engine] @${freshProfile.username}: next follow session in ${Math.round(waitMs / 60000)}min`);
        await sleepInterruptible(waitMs, state.stop);
      }

      this.states.delete(profile.id);
      console.log(`[engine] Runner exited for @${profile.username}`);
    };

    loop().catch(err => {
      this.states.delete(profile.id);
      console.error(`[engine] Fatal error for @${profile.username}:`, err?.message);
    });
  }

  // ── Human session runner ──────────────────────────────────────────────────
  private launchHumanSession(profile: Profile, _tool: Tool) {
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
    };
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
          try {
            await this.runHumanSessionTools(freshProfile, hsTool, state);
          } catch (err: any) {
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
  private launchUnfollow(profile: Profile, _tool: Tool) {
    const state: ProfileState = {
      stop: { stopped: false },
      client: null,
      dailyCount: 0, dailyDate: todayStr(),
      hourlyCount: 0, hourlyHour: hourStr(),
      actionDailyCount: {}, actionDailyDate: todayStr(),
      actionHourlyCount: {}, actionHourlyHour: hourStr(),
      actionSuspensions: {},
    };
    this.unfollowStates.set(profile.id, state);
    console.log(`[engine] Launching unfollow runner for @${profile.username}`);

    const loop = async () => {
      while (!state.stop.stopped) {
        const freshProfile = await storage.getProfile(profile.id);
        if (!freshProfile) break;
        if (freshProfile.accountStatus === "banned") break;
        if (freshProfile.accountStatus === "captcha") { await sleep(5 * 60_000); continue; }

        const tools = await storage.getToolsByProfile(freshProfile.id);
        const unfollowTool = tools.find(t => t.type === "unfollow");
        if (!unfollowTool?.enabled || state.stop.stopped) break;

        try {
          await this.runUnfollowSession(freshProfile, unfollowTool, state);
        } catch (err: any) {
          console.error(`[engine] @${freshProfile.username}: unfollow session error: ${err?.message}`);
        }

        if (state.stop.stopped) break;
        const s = unfollowTool.settings as any;
        const waitMs = randInt((s.delayMin ?? 5) * 60_000, (s.delayMax ?? 15) * 60_000);
        console.log(`[engine] @${freshProfile.username}: next unfollow session in ${Math.round(waitMs / 60000)}min`);
        await sleepInterruptible(waitMs, state.stop);
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
  private launchDM(profile: Profile, _tool: Tool) {
    const state: ProfileState = {
      stop: { stopped: false },
      client: null,
      dailyCount: 0, dailyDate: todayStr(),
      hourlyCount: 0, hourlyHour: hourStr(),
      actionDailyCount: {}, actionDailyDate: todayStr(),
      actionHourlyCount: {}, actionHourlyHour: hourStr(),
      actionSuspensions: {},
    };
    this.dmStates.set(profile.id, state);
    console.log(`[engine] Launching DM runner for @${profile.username}`);

    const loop = async () => {
      while (!state.stop.stopped) {
        const freshProfile = await storage.getProfile(profile.id);
        if (!freshProfile) break;
        if (freshProfile.accountStatus === "banned") break;
        if (freshProfile.accountStatus === "captcha") { await sleep(5 * 60_000); continue; }

        const tools = await storage.getToolsByProfile(freshProfile.id);
        const dmTool = tools.find(t => t.type === "dm");
        if (!dmTool?.enabled || state.stop.stopped) break;

        try {
          await this.runDMSession(freshProfile, dmTool, state);
        } catch (err: any) {
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
  private launchContact(profile: Profile, _tool: Tool) {
    const state: ProfileState = {
      stop: { stopped: false },
      client: null,
      dailyCount: 0, dailyDate: todayStr(),
      hourlyCount: 0, hourlyHour: hourStr(),
      actionDailyCount: {}, actionDailyDate: todayStr(),
      actionHourlyCount: {}, actionHourlyHour: hourStr(),
      actionSuspensions: {},
      nextHumanSessionAt: 0,
    };
    this.contactStates.set(profile.id, state);
    console.log(`[engine] Launching contact runner for @${profile.username}`);

    // Each timer is tracked separately so they run on their own independent cadence
    let nextFollowerCheckAt = 0;  // run immediately on first tick
    let nextUsersSessionAt  = 0;

    const loop = async () => {
      while (!state.stop.stopped) {
        const freshProfile = await storage.getProfile(profile.id);
        if (!freshProfile) break;
        if (freshProfile.accountStatus === "banned") break;
        if (freshProfile.accountStatus === "captcha") { await sleep(5 * 60_000); continue; }

        const tools = await storage.getToolsByProfile(freshProfile.id);
        const contactTool = tools.find(t => t.type === "contact");
        if (!contactTool?.enabled || state.stop.stopped) break;

        const s = contactTool.settings as any;
        const now = Date.now();

        // ── New Followers → enqueue to pending ─────────────────────────────
        if (now >= nextFollowerCheckAt) {
          try {
            await this.runContactNewFollowersSession(freshProfile, contactTool, state);
          } catch (err: any) {
            console.error(`[engine] @${freshProfile.username}: new-follower contact session error: ${err?.message}`);
          }
          const waitMs = randInt(
            (s.contactCheckIntervalMin ?? 30) * 60_000,
            (s.contactCheckIntervalMax ?? 60) * 60_000
          );
          nextFollowerCheckAt = Date.now() + waitMs;
          console.log(`[engine] @${freshProfile.username}: next follower check in ${Math.round(waitMs / 60000)}min`);
        }

        if (state.stop.stopped) break;

        // ── Contact Users → send from pending queue ─────────────────────────
        if (now >= nextUsersSessionAt) {
          try {
            await this.runContactUsersSession(freshProfile, contactTool, state);
          } catch (err: any) {
            console.error(`[engine] @${freshProfile.username}: contact-users send session error: ${err?.message}`);
          }
          const waitMs = randInt(
            (s.contactUsersWaitMin ?? 30) * 60_000,
            (s.contactUsersWaitMax ?? 60) * 60_000
          );
          nextUsersSessionAt = Date.now() + waitMs;
          console.log(`[engine] @${freshProfile.username}: next users send in ${Math.round(waitMs / 60000)}min`);
        }

        if (state.stop.stopped) break;

        // ── Unsend check ────────────────────────────────────────────────────
        try {
          await this.runContactUnsends(freshProfile, state);
        } catch (err: any) {
          console.error(`[engine] @${freshProfile.username}: unsend check error: ${err?.message}`);
        }

        await sleepInterruptible(30_000, state.stop); // poll every 30s to check if timers are due
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
  private async runContactNewFollowersSession(profile: Profile, tool: Tool, state: ProfileState): Promise<void> {
    const s = tool.settings as any;

    const messageTemplate: string = (s.contactMessage ?? "").trim();
    if (!messageTemplate) {
      console.log(`[engine] @${profile.username}: no contact message configured — skipping follower check`);
      return;
    }

    const usersToCheck = randInt(s.contactUsersPerCheckMin ?? 1, s.contactUsersPerCheckMax ?? 20);

    const client = await this.ensureClient(profile, state);
    if (!client) return;

    const ownUserId = await client.getOwnUserId();
    if (!ownUserId) {
      console.warn(`[engine] @${profile.username}: could not resolve own user ID for contact session`);
      return;
    }

    const globalSettings = await storage.getGlobalSettings();
    const useHiker = s.contactApiSource === "hiker"
      && globalSettings.hikerApiEnabled === "true"
      && !!globalSettings.hikerApiToken;

    let followers: { pk: string; username: string; fullName: string }[] = [];
    if (useHiker) {
      const hikerClient = new HikerApiClient(globalSettings.hikerApiToken!);
      followers = await hikerClient.getFollowers(ownUserId, usersToCheck);
    } else {
      followers = await client.getFollowers(ownUserId, usersToCheck);
    }

    if (!followers.length) {
      console.log(`[engine] @${profile.username}: no followers returned for contact session`);
      return;
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
      // Skip if already queued or previously sent
      if (await storage.isContactAlreadyQueued(profile.id, user.username)) continue;
      if (await storage.isContactDmAlreadySent(profile.id, user.username)) continue;
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
        }
      } catch (e: any) {
        console.warn(`[engine] contact DM @${msg.instagramUsername} error: ${e?.message}`);
        await storage.updateContactPendingMessage(msg.id, { status: "failed" });
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
  private async runAutoReplyCheck(profile: Profile, client: InstagramWebClient): Promise<void> {
    const tools = await storage.getToolsByProfile(profile.id);
    const contactTool = tools.find(t => t.type === "contact");
    if (!contactTool?.enabled) return;

    const s = contactTool.settings as any;
    if (!s.autoReplyEnabled) return;

    const rules: { word: string; reply: string }[] = Array.isArray(s.autoReplies) ? s.autoReplies : [];
    if (!rules.length) return;

    const threads = await client.getDMThreadsWithContent(20);
    if (!threads.length) return;

    let queued = 0;
    for (const thread of threads) {
      if (!thread.username || !thread.userId) continue;

      // Only look at messages NOT sent by the account (fromMe === false)
      const incomingMessages = thread.items.filter(i => !i.fromMe);
      if (!incomingMessages.length) continue;

      // Already queued an auto-reply to this user? Skip.
      if (await storage.isAutoReplyAlreadyQueued(profile.id, thread.username)) continue;

      // Check each trigger word against all incoming message texts
      let matched = false;
      for (const rule of rules) {
        if (!rule.word.trim() || !rule.reply.trim()) continue;
        const triggerLower = rule.word.trim().toLowerCase();
        const hit = incomingMessages.some(msg => msg.text.toLowerCase().includes(triggerLower));
        if (hit) {
          const text = this.applySpintax(rule.reply);
          await storage.createContactPendingMessage({
            profileId: profile.id,
            instagramUsername: thread.username,
            instagramUserId: thread.userId,
            messageType: "auto_reply",
            messageText: text,
            status: "pending",
            queuedAt: new Date().toISOString(),
          });
          console.log(`[engine] @${profile.username}: auto-reply queued for @${thread.username} (trigger: "${rule.word}")`);
          queued++;
          matched = true;
          break; // one reply per thread per scan
        }
      }
      if (matched) continue; // move to next thread
    }

    if (queued > 0) {
      console.log(`[engine] @${profile.username}: queued ${queued} auto-replies to pending`);
    }
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

  // ── Ensure logged-in client ───────────────────────────────────────────────
  private async ensureClient(profile: Profile, state: ProfileState): Promise<InstagramWebClient | null> {
    const proxyUrl = await this.buildProxyUrl(profile);

    // Create client once per profile lifecycle
    if (!state.client) {
      state.client = new InstagramWebClient(proxyUrl, profile.id);
      state.client.setLogger((op, durationMs, message) => {
        storage.createInstagramApiCall({
          profileId: profile.id,
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
        requestsMin:   Number(limits.requestsMin   ?? 5),
        requestsMax:   Number(limits.requestsMax   ?? 10),
        everySecondsMin: Number(limits.everySecondsMin ?? 3),
        everySecondsMax: Number(limits.everySecondsMax ?? 8),
      });
    }

    // Always sync the EB browser UA so webPost uses the same UA that created
    // the cookies — a UA mismatch causes Instagram to 302-redirect to login.
    if (profile.userAgentEmbedded) {
      state.client.setWebUserAgent(profile.userAgentEmbedded);
    }

    const client = state.client;

    // Always sync EB browser cookies first — this makes the engine share the
    // same Instagram session as the embedded browser (which can follow freely).
    const browserOk = client.loadBrowserCookies();
    if (browserOk) {
      console.log(`[engine] @${profile.username}: using EB browser session (cookies synced)`);
      const current = await storage.getProfile(profile.id);
      // Reset logged_out status when a valid EB session is available again
      if (current?.accountStatus === "logged_out") {
        await storage.updateProfile(profile.id, { accountStatus: "valid" });
      }
      return client;
    }

    // No EB browser session — fall back to web login
    if (client.isLoggedIn()) return client;

    const ok = await client.login(
      profile.username,
      profile.password,
      profile.twoFASecretKey ?? undefined,
    );

    if (ok) {
      const current = await storage.getProfile(profile.id);
      if (current?.accountStatus === "logged_out") {
        await storage.updateProfile(profile.id, { accountStatus: "valid" });
      }
      console.log(`[engine] @${profile.username}: web login OK`);
      return client;
    }

    // Web login failed — could be a transient network/proxy issue.
    // Do NOT mark the account as logged_out; that flag should only be set by
    // an explicit "Verify Credentials" action which gets a definitive bad-
    // password response from Instagram.  The engine just skips this session
    // and will retry next interval.
    console.warn(`[engine] @${profile.username}: web login failed (transient?) — skipping session, status unchanged`);
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
    const candidates = all.filter(u => new Date(u.followedAt).getTime() < cutoff);
    console.log(`[engine] @${profile.username}: unfollow candidates: ${candidates.length} (older than ${minAgeDays}d)`);

    let unfollowed = 0;
    for (const fu of candidates) {
      if (unfollowed >= processCount || state.stop.stopped) break;
      if (maxPerDay > 0 && this.daily(state) >= maxPerDay) break;

      try {
        // Use stored pk; fall back to search-bar lookup (no profile info endpoint)
        let userId = fu.instagramUserId ?? "";
        if (!userId) {
          const found = await client.searchUserByUsername(fu.instagramUsername);
          if (!found) {
            console.log(`[engine] @${profile.username}: unfollow @${fu.instagramUsername} — could not resolve user ID, skipping`);
            continue;
          }
          userId = found.pk;
        }
        const result = await client.unfollowUser(userId, fu.instagramUsername);
        if (result === "blocked") {
          this.logAction(profile.id, tool.id, "unfollow_blocked", fu.instagramUsername, "", "", "skipped", "Instagram action-blocked unfollow");
          break;
        }
        if (result) {
          this.bump(state);
          unfollowed++;
          console.log(`[engine] @${profile.username}: ✓ unfollowed @${fu.instagramUsername} [${unfollowed}/${processCount}]`);
          this.logAction(profile.id, tool.id, "unfollow", fu.instagramUsername, "", "", "ok", `Unfollowed [${unfollowed}/${processCount}]`);
          await storage.incrementStat(profile.id, "unfollow");
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
  private async runHumanSessionTools(profile: Profile, tool: Tool, state: ProfileState): Promise<void> {
    const s = tool.settings as any;
    const client = await this.ensureClient(profile, state);
    if (!client) return;

    // ── Human Session (notifications → own profile → refresh → settings) ──────
    if (s.humanSessionEnabled !== false) {
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
    }

    // ── Watch Timeline Reels ─────────────────────────────────────────────────
    if (s.checkTimelineReelsEnabled !== false) {
      const reelCount = randInt(s.checkTimelineReelsMin ?? 3, s.checkTimelineReelsMax ?? 8);
      try {
        const watched = await client.viewTimelineReels(reelCount);
        console.log(`[engine] @${profile.username}: 🎬 watched ${watched} timeline reels`);
        this.logAction(profile.id, tool.id, "check_timeline_reels", "", "", "", "ok", `Watched ${watched} timeline reels`);
      } catch (e: any) {
        console.warn(`[engine] @${profile.username}: timeline reels error: ${e?.message}`);
      }
    }

    // ── Watch Timeline Stories ───────────────────────────────────────────────
    if (s.checkTimelineStoriesEnabled !== false) {
      const storyCount = randInt(s.checkTimelineStoriesMin ?? 3, s.checkTimelineStoriesMax ?? 8);
      try {
        const watched = await client.viewTimelineStories(storyCount);
        console.log(`[engine] @${profile.username}: 📖 watched ${watched} timeline stories`);
        this.logAction(profile.id, tool.id, "check_timeline_stories", "", "", "", "ok", `Watched ${watched} timeline stories`);
      } catch (e: any) {
        console.warn(`[engine] @${profile.username}: timeline stories error: ${e?.message}`);
      }
    }

    // ── Check Direct Messages ────────────────────────────────────────────────
    if (s.checkDmEnabled !== false) {
      const dmCount = randInt(s.checkDmMin ?? 5, s.checkDmMax ?? 15);
      try {
        const { count: actualDmCount } = await client.getDirectMessages(dmCount);
        console.log(`[engine] @${profile.username}: 💬 checked ${actualDmCount} DM thread(s)`);
        this.logAction(profile.id, tool.id, "check_dm", "", "", "", "ok", `Checked ${actualDmCount} direct message${actualDmCount === 1 ? "" : "s"}`);
      } catch (e: any) {
        console.warn(`[engine] @${profile.username}: check DMs error: ${e?.message}`);
      }
      // Auto-reply scan — runs after every DM check if the contact tool has auto-reply rules
      try {
        await this.runAutoReplyCheck(profile, client);
      } catch (e: any) {
        console.warn(`[engine] @${profile.username}: auto-reply scan error: ${e?.message}`);
      }
    }

    // ── Like Posts from Timeline ─────────────────────────────────────────────
    if (s.likeTimelinePostsEnabled !== false) {
      const likeCount = randInt(s.likeTimelinePostsMin ?? 2, s.likeTimelinePostsMax ?? 5);
      try {
        const { liked, watched } = await client.likeTimelinePosts(likeCount);
        const detail = watched > 0
          ? `Liked ${liked} post(s) from timeline (watched ${watched} reel(s) before liking)`
          : `Liked ${liked} post(s) from timeline`;
        console.log(`[engine] @${profile.username}: ❤️ ${detail}`);
        this.logAction(profile.id, tool.id, "like_timeline_post", "", "", "", "ok", detail);
      } catch (e: any) {
        console.warn(`[engine] @${profile.username}: like timeline posts error: ${e?.message}`);
      }
    }
  }

  // ── Follow session ────────────────────────────────────────────────────────
  private async runSession(profile: Profile, tool: Tool, state: ProfileState): Promise<{ followed: number }> {
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
    if (hikerClient) console.log(`[engine] @${profile.username}: using HikerAPI for scrape calls`);

    // Daily limit (0 = no limit)
    if (maxPerDay > 0 && this.daily(state) >= maxPerDay) {
      console.log(`[engine] @${profile.username}: daily limit (${maxPerDay}) hit — sleeping until midnight`);
      const now = new Date();
      const midnight = new Date(now); midnight.setDate(midnight.getDate() + 1); midnight.setHours(0, 0, 0, 0);
      await sleep(midnight.getTime() - now.getTime());
      return { followed: 0 };
    }

    // Hourly limit (0 = no limit)
    if (maxPerHour > 0 && this.hourly(state) >= maxPerHour) {
      console.log(`[engine] @${profile.username}: hourly limit (${maxPerHour}) hit — sleeping 1h`);
      await sleep(3_600_000);
      return { followed: 0 };
    }

    const client = await this.ensureClient(profile, state);
    if (!client) return { followed: 0 };

    // Pick source
    const sources = await storage.getSourcesByTool(tool.id);
    if (!sources.length) {
      console.log(`[engine] @${profile.username}: no sources configured`);
      await sleep(300_000);
      return { followed: 0 };
    }
    const source = this.pickSource(sources);
    console.log(`[engine] @${profile.username}: session [${processCount} follows] from ${source.type}:${source.value}`);

    let followed = 0;
    let candidates: { pk: string; username: string; fullName: string }[] = [];

    const logHiker = (op: string, message: string, durationMs: number) => {
      storage.createInstagramApiCall({
        profileId: profile.id,
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
          const result = await hikerClient.getHashtagUsers(source.value, processCount * 3, globalCursor);
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
          candidates = await hikerClient.getFollowers(targetPk, processCount * 3);
          logHiker("FollowersScrape", `Scraped followers of @${targetName} via HikerAPI (${candidates.length} users)`, Date.now() - t0);
        } else {
          candidates = await client.getFollowers(targetPk, processCount * 3);
        }
      }
    } catch (err: any) {
      console.error(`[engine] @${profile.username}: scrape error: ${err?.message}`);
      if (/login_required|Not authenticated|session/i.test(err?.message ?? "")) state.client = null;
      return { followed: 0 };
    }

    console.log(`[engine] @${profile.username}: scraped ${candidates.length} candidates`);

    for (const user of candidates) {
      if (followed >= processCount) break;
      if (state.stop.stopped) break;
      if (maxPerDay > 0 && this.daily(state) >= maxPerDay) { console.log(`[engine] @${profile.username}: daily cap hit mid-session`); break; }
      if (maxPerHour > 0 && this.hourly(state) >= maxPerHour) { console.log(`[engine] @${profile.username}: hourly cap hit mid-session`); await sleep(3_600_000); break; }

      // Dedup check (per-profile)
      if (await this.alreadyFollowed(profile.id, user.username)) {
        this.logAction(profile.id, tool.id, "dedup_skip", user.username, source.value, source.type, "skipped", "Already followed previously");
        continue;
      }

      // Global filter: skip if globally followed by any profile
      if (globalSkipFollowed && await storage.isGloballyFollowed(user.username)) {
        console.log(`[engine] @${profile.username}: skip @${user.username} — globally followed by another profile`);
        this.logAction(profile.id, tool.id, "dedup_skip", user.username, source.value, source.type, "skipped", "Globally followed by another profile");
        continue;
      }

      // Global filter: skip if in the global skipped-users list
      if (globalSkipSkipped && await storage.isGloballySkipped(user.username)) {
        console.log(`[engine] @${profile.username}: skip @${user.username} — in global skip list`);
        this.logAction(profile.id, tool.id, "filter_skip", user.username, source.value, source.type, "skipped", "In global skip list");
        continue;
      }

      // Tool filter: skip Indian users — use fullName already in scrape payload, no extra API call
      if (toolSkipIndian) {
        const fullName = user.fullName ?? "";
        if (this.hasIndianScript(fullName)) {
          console.log(`[engine] @${profile.username}: skip @${user.username} — Indian script in name`);
          this.logAction(profile.id, tool.id, "filter_skip", user.username, source.value, source.type, "skipped", "Indian script in name");
          await storage.addSkippedUser(user.username, "Indian script in name");
          continue;
        }
      }

      // Check if the follow action itself is currently suspended
      if (this.isActionSuspended(state, "follow")) {
        const rem = this.suspensionRemaining(state, "follow");
        console.log(`[engine] @${profile.username}: follow suspended (${rem} remaining) — skipping session`);
        this.logAction(profile.id, tool.id, "follow_blocked", user.username, source.value, source.type, "skipped", `Follow suspended — ${rem} remaining`);
        break;
      }

      // Pre-follow action variations (like, stories, reels, highlights)
      await this.preFollowActions(profile, tool, client, user, source, s, state, hikerClient);

      // Follow
      let result: { ok: boolean; status?: string; reason?: string };
      try {
        result = await client.followUser(user.pk, user.username);
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
        // Only apply suspension for explicit Instagram account-level blocks
        const isLegitBlock = reason.includes("Please wait") || reason.includes("feedback_required");
        if (isLegitBlock) {
          this.recordActionBlock(state, profile.id, tool.id, "follow", "Follow", user.username, source.value, source.type);
          break; // Abort session immediately when legitimately blocked
        }
        continue;
      }

      if (!result.ok) {
        console.log(`[engine] @${profile.username}: skip @${user.username} (already following / private)`);
        this.logAction(profile.id, tool.id, "follow_skipped", user.username, source.value, source.type, "skipped", "Already following or private account");
        continue;
      }

      // Record successful follow (store pk so unfollow never needs to look it up)
      await storage.createFollowedUser({
        profileId: profile.id,
        instagramUsername: user.username,
        instagramUserId: user.pk,
        sourceValue: source.value,
        sourceType: source.type,
        followedAt: new Date().toISOString(),
      });
      this.logAction(profile.id, tool.id, "follow", user.username, source.value, source.type, "ok", `Followed [${followed + 1}/${processCount}] day:${state.dailyCount + 1}`);
      await storage.incrementStat(profile.id, "follow");
      this.bump(state);
      followed++;

      console.log(`[engine] @${profile.username}: ✓ @${user.username} [${followed}/${processCount}] day:${state.dailyCount}`);

      // Inter-follow delay
      await sleep(randInt(followMin, followMax));
    }

    console.log(`[engine] @${profile.username}: session done — followed ${followed}/${processCount}`);
    return { followed };
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

  // ── Status API ────────────────────────────────────────────────────────────
  getStatus(): { profileId: number; loggedIn: boolean; dailyCount: number; hourlyCount: number }[] {
    return Array.from(this.states.entries()).map(([profileId, state]) => ({
      profileId,
      loggedIn: !!state.client?.isLoggedIn(),
      dailyCount: this.daily(state),
      hourlyCount: this.hourly(state),
    }));
  }
}

export const automationEngine = new AutomationEngine();
