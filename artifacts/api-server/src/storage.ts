import { EventEmitter } from "events";
import { db, sqlite } from "@workspace/db";
import { userAgents } from "./shared/userAgents";

// Real-time event bus — fires whenever any profile's accountStatus changes in the DB.
// The SSE endpoint in instagram.ts subscribes to this and pushes updates to connected
// browser clients so the status pill reflects changes immediately.
export const statusEvents = new EventEmitter();
statusEvents.setMaxListeners(200);
import {
  proxies, profiles, tools, sources, stats, instagramApiCalls, followedUsers, sessionActions,
  globalSettings, skippedUsers, repostedPosts, contactDmSent, contactPendingMessages,
  hashtagCursors, scrapedUsersGlobal, apiCreatedAccounts, bannedAccountsAnalytics,
  automatedBehaviourAnalytics, captchaAnalytics, lockedAccountsAnalytics,
  type AutomatedBehaviourAnalytics, type CaptchaAnalytics, type LockedAccountAnalytics,
  type Proxy, type InsertProxy,
  type Profile, type InsertProfile,
  type Tool, type InsertTool,
  type Source, type InsertSource,
  type FollowedUser, type InsertFollowedUser,
  type SessionAction, type InsertSessionAction,
  type SkippedUser,
  type RepostedPost, type InsertRepostedPost,
  type ContactDmSent, type InsertContactDmSent,
  type ContactPendingMessage, type InsertContactPendingMessage,
  type ApiCreatedAccount, type InsertApiCreatedAccount,
  type BannedAccountAnalytics,
} from "./shared/schema";
import { eq, desc, and, sql, like, gt, ne, or, isNull, isNotNull, not } from "drizzle-orm";

export interface IStorage {
  // Proxies
  getProxies(): Promise<Proxy[]>;
  createProxy(proxy: InsertProxy): Promise<Proxy>;
  updateProxy(id: number, data: Partial<InsertProxy>): Promise<Proxy>;
  deleteProxy(id: number): Promise<void>;

  // Profiles
  getProfiles(): Promise<Profile[]>;
  getProfile(id: number): Promise<Profile | undefined>;
  getProfileByUsername(username: string): Promise<Profile | undefined>;
  createProfile(profile: InsertProfile): Promise<Profile>;
  updateProfile(id: number, profile: Partial<InsertProfile>): Promise<Profile>;
  deleteProfile(id: number): Promise<void>;
  updateProfileStatus(id: number, status: string): Promise<Profile>;

  // Tools
  getToolsByProfile(profileId: number): Promise<Tool[]>;
  updateTool(id: number, tool: Partial<InsertTool>): Promise<Tool>;
  initializeToolsForProfile(profileId: number): Promise<void>;

  // Stats
  getStatsByProfile(profileId: number): Promise<any[]>;
  getLifetimeStatsByProfile(): Promise<Record<number, number>>;
  incrementStat(profileId: number, toolType: string): Promise<void>;
  getDailyAbdStats(): Promise<Record<number, number>>;

  // Sources
  getSourcesByTool(toolId: number): Promise<Source[]>;
  createSource(source: InsertSource): Promise<Source>;
  createSourcesBulk(rows: InsertSource[]): Promise<Source[]>;
  deleteSource(id: number): Promise<void>;
  deleteSourcesByTool(toolId: number): Promise<void>;
  updateSource(id: number, data: { rank?: number | null; enabled?: boolean }): Promise<void>;
  updateSourceTargetUserId(id: number, targetUserId: string): Promise<void>;
  updateSourceHashtagCursor(id: number, cursor: string): Promise<void>;

  // Instagram API Calls
  getInstagramApiCalls(limit?: number): Promise<any[]>;
  getInstagramApiCallsByProfile(profileId: number, limit?: number): Promise<any[]>;
  getInstagramApiCallCount(profileId: number): Promise<number>;
  getInstagramApiCallCountAll(): Promise<Record<number, number>>;
  getApiEndpointCounts(profileId: number, todayPrefix: string): Promise<{ operationName: string; todayCount: number; totalCount: number }[]>;
  getLastValidApiCallByProfile(): Promise<Record<number, string>>;
  getVerifyOpsByProfile(): Promise<Record<number, string[]>>;
  createInstagramApiCall(call: { profileId: number; username?: string; operationName: string; date: string; message?: string; source?: string; navChain?: string; ipAddress?: string; durationMs?: number; isError?: boolean }): Promise<any>;
  resetStuckVerifyingAccounts(): Promise<number>;

  // Pre-Status-Change Hit Tracking
  getPreStatusChangeHits(profileId: number): Promise<{ operationName: string; perAccountCount: number }[]>;
  getGlobalPreStatusChangeHits(): Promise<{ operationName: string; globalCount: number }[]>;
  getPreStatusChangeHitsByProfile(profileId: number): Promise<{ operationName: string; fromStatus: string; toStatus: string; occurredAt: string }[]>;
  bulkInsertPreStatusChangeHits(hits: { profileId: number; username: string; operationName: string; fromStatus: string; toStatus: string; occurredAt: string }[]): Promise<void>;

  // Followed Users
  getFollowedUsersByProfile(profileId: number, limit?: number): Promise<FollowedUser[]>;
  createFollowedUser(entry: InsertFollowedUser): Promise<FollowedUser>;
  deleteFollowedUser(id: number): Promise<void>;
  countFollowsToday(profileId: number, todayPrefix: string): Promise<number>;
  countFollowsThisHour(profileId: number, hourPrefix: string): Promise<number>;
  bulkImportFollowedUsers(profileId: number, entries: { username: string; userId: string; followedAt: string; sourceType?: string }[]): Promise<{ imported: number; skipped: number }>;

  // Session Actions
  getSessionActionsByProfile(profileId: number, limit?: number): Promise<SessionAction[]>;
  getRecentSessionActions(limit?: number): Promise<SessionAction[]>;
  createSessionAction(entry: InsertSessionAction): Promise<SessionAction>;
  bulkInsertStats(rows: { profileId: number; toolType: string; count: number; date: string }[]): Promise<void>;

  // Global Settings
  getGlobalSettings(): Promise<Record<string, string>>;
  setGlobalSetting(key: string, value: string): Promise<void>;

  // Skipped Users (global)
  isGloballySkipped(username: string): Promise<boolean>;
  isGloballyFollowed(username: string): Promise<boolean>;
  getGlobalFollowerLabel(username: string): Promise<string | null>;
  addSkippedUser(username: string, reason: string): Promise<void>;
  getSkippedUsers(limit?: number): Promise<SkippedUser[]>;

  // Reposted Posts
  getRepostedPostsByProfile(profileId: number, limit?: number): Promise<RepostedPost[]>;
  createRepostedPost(entry: InsertRepostedPost): Promise<RepostedPost>;
  deleteRepostedPost(id: number): Promise<void>;
  isAlreadyReposted(profileId: number, mediaId: string): Promise<boolean>;

  // Contact DM Sent (new-followers DM tracker)
  getContactDmSentByProfile(profileId: number, limit?: number): Promise<ContactDmSent[]>;
  createContactDmSent(entry: InsertContactDmSent): Promise<ContactDmSent>;
  isContactDmAlreadySent(profileId: number, instagramUsername: string): Promise<boolean>;
  deleteContactDmSent(id: number): Promise<void>;

  // Contact Pending Messages (send queue)
  getContactPendingMessages(profileId: number, status?: string): Promise<ContactPendingMessage[]>;
  createContactPendingMessage(entry: InsertContactPendingMessage): Promise<ContactPendingMessage>;
  updateContactPendingMessage(id: number, updates: Partial<Pick<ContactPendingMessage, 'status' | 'sentAt' | 'dmThreadId' | 'dmItemId' | 'unsendAt'>>): Promise<void>;
  deleteContactPendingMessage(id: number): Promise<void>;
  clearContactPendingMessages(profileId: number | null): Promise<void>;
  isContactAlreadyQueued(profileId: number, instagramUsername: string): Promise<boolean>;
  hasAnyMessageRecord(profileId: number, instagramUsername: string): Promise<boolean>;
  isAutoReplyAlreadyQueued(profileId: number, instagramUsername: string): Promise<boolean>;
  getContactMessagesForUnsend(profileId: number): Promise<ContactPendingMessage[]>;

  // Global Hashtag Cursors (shared across all profiles)
  getHashtagCursor(hashtag: string): Promise<string>;
  setHashtagCursor(hashtag: string, cursor: string): Promise<void>;

  // Scraped Users (global deduplication across all profiles)
  getScrapedUserIds(userIds: string[], ignoreDays: number): Promise<Set<string>>;
  addScrapedUsers(users: { pk: string; username: string }[]): Promise<void>;

  // API Created Accounts
  saveApiCreatedAccount(data: InsertApiCreatedAccount): Promise<ApiCreatedAccount>;
  updateApiCreatedAccount(id: number, updates: Partial<InsertApiCreatedAccount>): Promise<void>;
  getApiCreatedAccounts(): Promise<ApiCreatedAccount[]>;
  listApiCreatedAccounts(): Promise<ApiCreatedAccount[]>;
  deleteApiCreatedAccount(id: number): Promise<void>;

  // Ban Analytics
  insertBanAnalytics(entry: { username: string; proxyHost: string; bannedAt: string; endpointCount: number; endpointSnapshot: string; verifyCountLast24h?: number; accountAgeDays?: number | null; proxyAccountCount?: number; followCountBeforeBan?: number; sessionToActionRatio?: string | null; spanHours?: string | null; lastOperationBeforeBan?: string | null; userAgentApi?: string | null; userAgentEmbedded?: string | null; igDeviceState?: string | null; ebFingerprint?: string | null; leakSnapshot?: string | null }): Promise<void>;
  getBanAnalytics(): Promise<BannedAccountAnalytics[]>;

  // Automated Behaviour Analytics
  insertAutomatedBehaviourAnalytics(entry: { username: string; proxyHost: string; flaggedAt: string; endpointCount: number; endpointSnapshot: string; verifyCountLast24h?: number; accountAgeDays?: number | null; proxyAccountCount?: number; followCountBeforeBan?: number; sessionToActionRatio?: string | null; spanHours?: string | null; lastOperationBeforeBan?: string | null; userAgentApi?: string | null; userAgentEmbedded?: string | null; igDeviceState?: string | null; ebFingerprint?: string | null; leakSnapshot?: string | null }): Promise<void>;
  getAutomatedBehaviourAnalytics(): Promise<AutomatedBehaviourAnalytics[]>;

  // Captcha Analytics
  insertCaptchaAnalytics(entry: { username: string; proxyHost: string; flaggedAt: string; endpointCount: number; endpointSnapshot: string; verifyCountLast24h?: number; accountAgeDays?: number | null; proxyAccountCount?: number; followCountBeforeBan?: number; sessionToActionRatio?: string | null; spanHours?: string | null; lastOperationBeforeBan?: string | null; userAgentApi?: string | null; userAgentEmbedded?: string | null; igDeviceState?: string | null; ebFingerprint?: string | null; leakSnapshot?: string | null }): Promise<void>;
  getCaptchaAnalytics(): Promise<CaptchaAnalytics[]>;

  // Locked Account Analytics
  insertLockedAnalytics(entry: { username: string; proxyHost: string; flaggedAt: string; endpointCount: number; endpointSnapshot: string; verifyCountLast24h?: number; accountAgeDays?: number | null; proxyAccountCount?: number; followCountBeforeBan?: number; sessionToActionRatio?: string | null; spanHours?: string | null; lastOperationBeforeBan?: string | null; userAgentApi?: string | null; userAgentEmbedded?: string | null; igDeviceState?: string | null; ebFingerprint?: string | null; leakSnapshot?: string | null }): Promise<void>;
  getLockedAnalytics(): Promise<LockedAccountAnalytics[]>;

  // Leak Snapshot
  saveLeakSnapshot(profileId: number, snapshot: string): Promise<void>;
  getLeakSnapshot(profileId: number): Promise<string | null>;
}

export class DatabaseStorage implements IStorage {
  async getProxies(): Promise<Proxy[]> {
    return await db.select().from(proxies);
  }

  async createProxy(proxy: InsertProxy): Promise<Proxy> {
    const [created] = await db.insert(proxies).values(proxy).returning();
    return created;
  }

  async updateProxy(id: number, data: Partial<InsertProxy>): Promise<Proxy> {
    const [updated] = await db.update(proxies).set(data).where(eq(proxies.id, id)).returning();
    return updated;
  }

  async deleteProxy(id: number): Promise<void> {
    await db.update(profiles).set({ proxyId: null }).where(eq(profiles.proxyId, id));
    await db.delete(proxies).where(eq(proxies.id, id));
  }

  async getProfiles(): Promise<Profile[]> {
    return await db.select().from(profiles);
  }

  async getProfile(id: number): Promise<Profile | undefined> {
    const [profile] = await db.select().from(profiles).where(eq(profiles.id, id));
    return profile;
  }

  async createProfile(profile: InsertProfile): Promise<Profile> {
    // Pick the least-used UA from the pool — unique first, then least-used.
    const existingUAs: string[] = (await db.select({ ua: profiles.userAgentApi }).from(profiles))
      .map(r => r.ua).filter(Boolean) as string[];
    const uaUsedCount = new Map<string, number>();
    for (const ua of existingUAs) uaUsedCount.set(ua, (uaUsedCount.get(ua) ?? 0) + 1);
    const unused = userAgents.filter(u => !uaUsedCount.has(u.api));
    const pool = unused.length > 0 ? unused : userAgents;
    const randomUA = pool[Math.floor(Math.random() * pool.length)];

    // Auto-stamp the Notes field with the date/time the account was first added to
    // Equinox. Only written when notes is blank — never overwrites an existing value
    // (e.g. a note that came from an EQX re-import already carries the original stamp).
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const firstAddedStamp = `Added: ${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`;
    const [created] = await db.insert(profiles).values({
      ...profile,
      // Always use the server-selected unique UA — overrides any client-side random pick.
      userAgentApi: randomUA.api,
      userAgentEmbedded: randomUA.embedded,
      tags: profile.tags || "No Group Assigned",
      // Preserve any existing notes (EQX import carries the original stamp); only
      // set the auto-stamp when notes is genuinely absent.
      notes: (profile.notes && String(profile.notes).trim()) ? profile.notes : firstAddedStamp,
      // Always record when the profile was first added; this drives the "Alive For"
      // column on the accounts page and never changes for the lifetime of the account.
      createdAt: now.toISOString(),
    }).returning();
    await this.initializeToolsForProfile(created.id);
    return created;
  }

  async getProfileByUsername(username: string): Promise<Profile | undefined> {
    const [profile] = await db.select().from(profiles).where(eq(profiles.username, username));
    return profile;
  }

  async updateProfile(id: number, updates: any): Promise<Profile> {
    if ("accountStatus" in updates) {
      const caller = new Error().stack?.split("\n").slice(2, 5).join(" | ") ?? "unknown";
      console.log(`[status-audit] profile=${id} accountStatus="${updates.accountStatus}" caller=${caller}`);
      // Record the last API endpoint called before this status change (non-fatal)
      try {
        const cur = sqlite.prepare("SELECT account_status, username FROM profiles WHERE id = ?").get(id) as { account_status: string; username: string } | undefined;
        const lastCall = sqlite.prepare("SELECT operation_name FROM instagram_api_calls WHERE profile_id = ? ORDER BY id DESC LIMIT 1").get(id) as { operation_name: string } | undefined;
        if (lastCall) {
          sqlite.prepare("INSERT INTO pre_status_change_hits (profile_id, username, operation_name, from_status, to_status, occurred_at) VALUES (?, ?, ?, ?, ?, ?)").run(
            id, cur?.username ?? "", lastCall.operation_name, cur?.account_status ?? "", updates.accountStatus, new Date().toISOString()
          );
        }
      } catch (_e) { /* non-fatal */ }
      // Auto-stamp validSince the first time an account reaches "valid" status
      if (updates.accountStatus === "valid" && !updates.validSince) {
        try {
          const row = sqlite.prepare("SELECT valid_since FROM profiles WHERE id = ?").get(id) as { valid_since: string | null } | undefined;
          if (!row?.valid_since) {
            updates = { ...updates, validSince: new Date().toISOString() };
          }
        } catch (_e) { /* non-fatal */ }
      }
    }
    const [updated] = await db.update(profiles).set(updates).where(eq(profiles.id, id)).returning();
    if ("accountStatus" in updates) {
      statusEvents.emit("change", { profileId: id, accountStatus: updates.accountStatus });
    }
    return updated;
  }

  async deleteProfile(id: number): Promise<void> {
    const [profile] = await db.select({ proxyId: profiles.proxyId }).from(profiles).where(eq(profiles.id, id));
    const linkedProxyId = profile?.proxyId ?? null;

    await db.delete(tools).where(eq(tools.profileId, id));
    await db.delete(profiles).where(eq(profiles.id, id));

    if (linkedProxyId) {
      const [linkedProxy] = await db.select({ importLinked: proxies.importLinked }).from(proxies).where(eq(proxies.id, linkedProxyId));
      if (linkedProxy?.importLinked === 1) {
        const others = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.proxyId, linkedProxyId));
        if (others.length === 0) {
          await db.delete(proxies).where(eq(proxies.id, linkedProxyId));
        }
      }
    }
  }

  async updateProfileStatus(id: number, status: string): Promise<Profile> {
    const [updated] = await db.update(profiles).set({ status }).where(eq(profiles.id, id)).returning();
    return updated;
  }

  async getToolsByProfile(profileId: number): Promise<Tool[]> {
    const existing = await db.select().from(tools).where(eq(tools.profileId, profileId));
    const allTypes = ['follow', 'unfollow', 'like', 'dm', 'contact', 'human_sessions'];
    const existingTypes = new Set(existing.map(t => t.type));
    const missing = allTypes.filter(t => !existingTypes.has(t));
    if (missing.length > 0) {
      for (const type of missing) {
        await db.insert(tools).values({ profileId, type, enabled: false, settings: {} });
      }
      return await db.select().from(tools).where(eq(tools.profileId, profileId));
    }
    return existing;
  }

  async updateTool(id: number, updates: Partial<InsertTool>): Promise<Tool> {
    const [updated] = await db.update(tools).set(updates).where(eq(tools.id, id)).returning();
    return updated;
  }

  async initializeToolsForProfile(profileId: number): Promise<void> {
    const toolTypes = ['follow', 'unfollow', 'like', 'dm', 'contact', 'human_sessions'];
    for (const type of toolTypes) {
      await db.insert(tools).values({ profileId, type, enabled: false, settings: {} });
    }
  }

  async getSourcesByTool(toolId: number): Promise<Source[]> {
    return await db.select().from(sources).where(eq(sources.toolId, toolId));
  }

  async createSource(source: InsertSource): Promise<Source> {
    const [created] = await db.insert(sources).values(source).returning();
    return created;
  }

  async createSourcesBulk(rows: InsertSource[]): Promise<Source[]> {
    if (!rows.length) return [];
    return await db.insert(sources).values(rows).returning();
  }

  async deleteSource(id: number): Promise<void> {
    await db.delete(sources).where(eq(sources.id, id));
  }

  async deleteSourcesByTool(toolId: number): Promise<void> {
    await db.delete(sources).where(eq(sources.toolId, toolId));
  }

  async deleteSourcesByToolAndType(toolId: number, type: string): Promise<void> {
    await db.delete(sources).where(and(eq(sources.toolId, toolId), eq(sources.type, type)));
  }

  async updateSource(id: number, data: { rank?: number | null; enabled?: boolean }): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (data.rank !== undefined) patch.rank = data.rank;
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    if (Object.keys(patch).length > 0) {
      await db.update(sources).set(patch as any).where(eq(sources.id, id));
    }
  }

  async updateSourceTargetUserId(id: number, targetUserId: string): Promise<void> {
    await db.update(sources).set({ targetUserId }).where(eq(sources.id, id));
  }

  async updateSourceHashtagCursor(id: number, cursor: string): Promise<void> {
    await db.update(sources).set({ hashtagCursor: cursor }).where(eq(sources.id, id));
  }

  async getHashtagCursor(hashtag: string): Promise<string> {
    const [row] = await db.select().from(hashtagCursors).where(eq(hashtagCursors.hashtag, hashtag));
    return row?.cursor ?? "";
  }

  async setHashtagCursor(hashtag: string, cursor: string): Promise<void> {
    await db.insert(hashtagCursors).values({ hashtag, cursor })
      .onConflictDoUpdate({ target: hashtagCursors.hashtag, set: { cursor } });
  }

  async getScrapedUserIds(userIds: string[], ignoreDays: number): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const cutoff = new Date(Date.now() - ignoreDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = await db.select({ id: scrapedUsersGlobal.instagramUserId })
      .from(scrapedUsersGlobal)
      .where(
        and(
          sql`${scrapedUsersGlobal.instagramUserId} IN (${sql.join(userIds.map(id => sql`${id}`), sql`, `)})`,
          sql`${scrapedUsersGlobal.scrapedAt} >= ${cutoff}`,
        )
      );
    return new Set(rows.map(r => r.id));
  }

  async addScrapedUsers(users: { pk: string; username: string }[]): Promise<void> {
    if (users.length === 0) return;
    const now = new Date().toISOString();
    for (const u of users) {
      await db.insert(scrapedUsersGlobal)
        .values({ instagramUserId: u.pk, instagramUsername: u.username, scrapedAt: now })
        .onConflictDoNothing();
    }
  }

  async getStatsByProfile(profileId: number): Promise<any[]> {
    return await db.select().from(stats).where(eq(stats.profileId, profileId));
  }

  async getLifetimeStatsByProfile(): Promise<Record<number, number>> {
    const rows = await db
      .select({ profileId: stats.profileId, total: sql<number>`SUM(${stats.count})` })
      .from(stats)
      .where(eq(stats.date, 'lifetime'))
      .groupBy(stats.profileId);
    const result: Record<number, number> = {};
    for (const row of rows) result[row.profileId] = Number(row.total ?? 0);
    return result;
  }

  async getInstagramApiCalls(limit: number = 100000): Promise<any[]> {
    return await db.select().from(instagramApiCalls).orderBy(desc(instagramApiCalls.id)).limit(limit);
  }

  async getInstagramApiCallsByProfile(profileId: number, limit: number = 2000): Promise<any[]> {
    return await db.select().from(instagramApiCalls)
      .where(eq(instagramApiCalls.profileId, profileId))
      .orderBy(desc(instagramApiCalls.id))
      .limit(limit);
  }

  async getInstagramApiCallCount(profileId: number): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(instagramApiCalls)
      .where(and(
        eq(instagramApiCalls.profileId, profileId),
        eq(instagramApiCalls.isError, false),
      ));
    return Number(row?.count ?? 0);
  }

  async getInstagramApiCallCountAll(): Promise<Record<number, number>> {
    const rows = await db
      .select({ profileId: instagramApiCalls.profileId, count: sql<number>`COUNT(*)` })
      .from(instagramApiCalls)
      .where(
        and(
          eq(instagramApiCalls.isError, false),
          ne(instagramApiCalls.source, "HikerAPI"),
        )
      )
      .groupBy(instagramApiCalls.profileId);
    const result: Record<number, number> = {};
    for (const row of rows) result[row.profileId] = Number(row.count ?? 0);
    return result;
  }

  async getLastValidApiCallByProfile(): Promise<Record<number, string>> {
    // Valid = not HikerAPI, not a failed/error call, not a pre-action log.
    // Returns the most recent date ISO string per profile.
    const rows = await db
      .select({
        profileId: instagramApiCalls.profileId,
        lastDate: sql<string>`MAX(${instagramApiCalls.date})`,
      })
      .from(instagramApiCalls)
      .where(
        and(
          ne(instagramApiCalls.source, "HikerAPI"),
          or(
            isNull(instagramApiCalls.message),
            not(like(instagramApiCalls.message, "error:%"))
          )
        )
      )
      .groupBy(instagramApiCalls.profileId);
    const result: Record<number, string> = {};
    for (const row of rows) {
      if (row.lastDate) result[row.profileId] = row.lastDate;
    }
    return result;
  }

  async getVerifyOpsByProfile(): Promise<Record<number, string[]>> {
    const rows = await db
      .select({
        profileId: instagramApiCalls.profileId,
        operationName: instagramApiCalls.operationName,
      })
      .from(instagramApiCalls)
      .where(eq(instagramApiCalls.source, "Verify"))
      .orderBy(desc(instagramApiCalls.id));

    const seen: Record<number, Set<string>> = {};
    for (const row of rows) {
      if (!seen[row.profileId]) seen[row.profileId] = new Set();
      seen[row.profileId].add(row.operationName);
    }
    const result: Record<number, string[]> = {};
    for (const [pid, ops] of Object.entries(seen)) {
      result[Number(pid)] = Array.from(ops);
    }
    return result;
  }

  async getProfilesByProxyId(proxyId: number): Promise<Profile[]> {
    return await db.select().from(profiles).where(eq(profiles.proxyId, proxyId));
  }

  async getProfilesByProxyHost(host: string): Promise<Profile[]> {
    return await db.select().from(profiles).where(eq(profiles.proxyHost, host));
  }

  async getResumingProfiles(): Promise<Profile[]> {
    return await db.select().from(profiles).where(
      and(eq(profiles.accountStatus, "stopped"), isNotNull(profiles.resumingUntil))
    );
  }

  async resetStuckVerifyingAccounts(): Promise<number> {
    const stuck = await db.select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.accountStatus, "verifying"));
    if (stuck.length === 0) return 0;
    for (const p of stuck) {
      await db.update(profiles).set({ accountStatus: "pending" }).where(eq(profiles.id, p.id));
    }
    console.warn(`[startup] Reset ${stuck.length} stuck-in-verifying account(s) → pending`);
    return stuck.length;
  }

  async getInstagramApiCallsSince(sinceId: number, limit: number = 5000): Promise<any[]> {
    return await db.select().from(instagramApiCalls)
      .where(gt(instagramApiCalls.id, sinceId))
      .orderBy(desc(instagramApiCalls.id))
      .limit(limit);
  }

  async getApiEndpointCounts(profileId: number, todayPrefix: string): Promise<{ operationName: string; todayCount: number; totalCount: number }[]> {
    const likePattern = todayPrefix + "%";
    const rows = await db
      .select({
        operationName: instagramApiCalls.operationName,
        totalCount: sql<number>`COUNT(*)`,
        todayCount: sql<number>`SUM(CASE WHEN ${instagramApiCalls.date} LIKE ${likePattern} THEN 1 ELSE 0 END)`,
      })
      .from(instagramApiCalls)
      .where(and(
        eq(instagramApiCalls.profileId, profileId),
        ne(instagramApiCalls.source, "HikerAPI"),
        eq(instagramApiCalls.isError, false),
      ))
      .groupBy(instagramApiCalls.operationName)
      .orderBy(desc(sql<number>`COUNT(*)`));
    return rows.map(r => ({
      operationName: r.operationName,
      totalCount: Number(r.totalCount ?? 0),
      todayCount: Number(r.todayCount ?? 0),
    }));
  }

  async getPreStatusChangeHits(profileId: number): Promise<{ operationName: string; perAccountCount: number }[]> {
    const rows = sqlite.prepare(`
      SELECT operation_name, COUNT(*) as cnt
      FROM pre_status_change_hits
      WHERE profile_id = ?
      GROUP BY operation_name
      ORDER BY cnt DESC
    `).all(profileId) as { operation_name: string; cnt: number }[];
    return rows.map(r => ({ operationName: r.operation_name, perAccountCount: r.cnt }));
  }

  async getGlobalPreStatusChangeHits(): Promise<{ operationName: string; globalCount: number }[]> {
    const rows = sqlite.prepare(`
      SELECT operation_name, COUNT(*) as cnt
      FROM pre_status_change_hits
      GROUP BY operation_name
      ORDER BY cnt DESC
    `).all() as { operation_name: string; cnt: number }[];
    return rows.map(r => ({ operationName: r.operation_name, globalCount: r.cnt }));
  }

  async getPreStatusChangeHitsByProfile(profileId: number): Promise<{ operationName: string; fromStatus: string; toStatus: string; occurredAt: string }[]> {
    const rows = sqlite.prepare(`
      SELECT operation_name, from_status, to_status, occurred_at
      FROM pre_status_change_hits
      WHERE profile_id = ?
      ORDER BY id ASC
    `).all(profileId) as { operation_name: string; from_status: string; to_status: string; occurred_at: string }[];
    return rows.map(r => ({ operationName: r.operation_name, fromStatus: r.from_status, toStatus: r.to_status, occurredAt: r.occurred_at }));
  }

  async bulkInsertPreStatusChangeHits(hits: { profileId: number; username: string; operationName: string; fromStatus: string; toStatus: string; occurredAt: string }[]): Promise<void> {
    if (!hits.length) return;
    const stmt = sqlite.prepare("INSERT INTO pre_status_change_hits (profile_id, username, operation_name, from_status, to_status, occurred_at) VALUES (?, ?, ?, ?, ?, ?)");
    const txn = sqlite.transaction(() => {
      for (const h of hits) stmt.run(h.profileId, h.username, h.operationName, h.fromStatus, h.toStatus, h.occurredAt);
    });
    txn();
  }

  private _apiCallInsertCount = 0;

  async createInstagramApiCall(call: { profileId: number; username?: string; operationName: string; date: string; message?: string; source?: string; navChain?: string; ipAddress?: string; durationMs?: number; isError?: boolean }): Promise<any> {
    // All callers are fire-and-forget (no await). Any unhandled rejection from this
    // function terminates the Node.js process on v15+. Wrap everything so it never rejects.
    try {
      const [created] = await db.insert(instagramApiCalls).values({
        profileId: call.profileId,
        username: call.username ?? "",
        operationName: call.operationName,
        date: call.date,
        message: call.message ?? "",
        source: call.source ?? "",
        navChain: call.navChain ?? "",
        ipAddress: call.ipAddress ?? "",
        durationMs: call.durationMs ?? 0,
        isError: call.isError ?? false,
      }).returning();

      // Prune to keep the 1,000 most recent rows PER profile — checked every 50 inserts.
      // Uses ROW_NUMBER() OVER (PARTITION BY) — requires SQLite 3.25+.
      // Non-critical: a failure here must never bubble up.
      if (++this._apiCallInsertCount % 50 === 0) {
        try {
          db.run(sql`
            DELETE FROM instagram_api_calls
            WHERE id NOT IN (
              SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (PARTITION BY "profileId" ORDER BY id DESC) AS rn
                FROM instagram_api_calls
              ) ranked WHERE rn <= 1000
            )
          `);
        } catch (pruneErr) {
          console.warn("[storage] instagram_api_calls prune failed (non-fatal):", pruneErr);
        }
      }

      return created;
    } catch (insertErr) {
      console.warn("[storage] createInstagramApiCall insert failed (non-fatal):", insertErr);
      return undefined;
    }
  }

  async incrementStat(profileId: number, toolType: string): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    
    // Update daily
    const [daily] = await db.select().from(stats).where(and(eq(stats.profileId, profileId), eq(stats.toolType, toolType), eq(stats.date, today)));
    if (daily) {
      await db.update(stats).set({ count: daily.count + 1 }).where(eq(stats.id, daily.id));
    } else {
      await db.insert(stats).values({ profileId, toolType, count: 1, date: today });
    }

    // Update lifetime
    const [lifetime] = await db.select().from(stats).where(and(eq(stats.profileId, profileId), eq(stats.toolType, toolType), eq(stats.date, 'lifetime')));
    if (lifetime) {
      await db.update(stats).set({ count: lifetime.count + 1 }).where(eq(stats.id, lifetime.id));
    } else {
      await db.insert(stats).values({ profileId, toolType, count: 1, date: 'lifetime' });
    }
  }

  async getDailyAbdStats(): Promise<Record<number, number>> {
    const today = new Date().toISOString().split('T')[0];
    const rows = await db.select().from(stats).where(and(eq(stats.toolType, 'abd'), eq(stats.date, today)));
    const result: Record<number, number> = {};
    for (const row of rows) result[row.profileId] = row.count;
    return result;
  }

  async getFollowedUsersByProfile(profileId: number, limit: number = 10000): Promise<FollowedUser[]> {
    return await db.select().from(followedUsers)
      .where(eq(followedUsers.profileId, profileId))
      .orderBy(desc(followedUsers.followedAt))
      .limit(limit);
  }

  async createFollowedUser(entry: InsertFollowedUser): Promise<FollowedUser> {
    const [created] = await db.insert(followedUsers).values(entry).returning();
    return created;
  }

  async deleteFollowedUser(id: number): Promise<void> {
    await db.delete(followedUsers).where(eq(followedUsers.id, id));
  }

  async bulkImportFollowedUsers(
    profileId: number,
    entries: { username: string; userId: string; followedAt: string; sourceType?: string }[]
  ): Promise<{ imported: number; skipped: number }> {
    if (!entries.length) return { imported: 0, skipped: 0 };
    // Load existing usernames for this profile to deduplicate
    const existing = await db
      .select({ u: followedUsers.instagramUsername })
      .from(followedUsers)
      .where(eq(followedUsers.profileId, profileId));
    const existingSet = new Set(existing.map(r => r.u.toLowerCase()));
    const toInsert = entries.filter(e => !existingSet.has(e.username.toLowerCase()));
    // Batch insert in chunks of 500 (SQLite parameter limit safety)
    const BATCH = 500;
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const batch = toInsert.slice(i, i + BATCH);
      await db.insert(followedUsers).values(
        batch.map(e => ({
          profileId,
          instagramUsername: e.username,
          instagramUserId: e.userId,
          sourceValue: e.sourceType ?? "jarvee_import",
          sourceType: e.sourceType ?? "jarvee_import",
          followedAt: e.followedAt,
        }))
      );
    }
    return { imported: toInsert.length, skipped: entries.length - toInsert.length };
  }

  async countFollowsToday(profileId: number, todayPrefix: string): Promise<number> {
    const rows = await db.select({ count: sql<number>`count(*)` })
      .from(followedUsers)
      .where(and(
        eq(followedUsers.profileId, profileId),
        like(followedUsers.followedAt, `${todayPrefix}%`),
      ));
    return Number(rows[0]?.count ?? 0);
  }

  async countFollowsThisHour(profileId: number, hourPrefix: string): Promise<number> {
    const rows = await db.select({ count: sql<number>`count(*)` })
      .from(followedUsers)
      .where(and(
        eq(followedUsers.profileId, profileId),
        like(followedUsers.followedAt, `${hourPrefix}%`),
      ));
    return rows[0]?.count ?? 0;
  }

  async getSessionActionsByProfile(profileId: number, limit: number = 500): Promise<SessionAction[]> {
    return await db.select().from(sessionActions)
      .where(eq(sessionActions.profileId, profileId))
      .orderBy(desc(sessionActions.id))
      .limit(limit);
  }

  async getRecentSessionActions(limit: number = 30): Promise<SessionAction[]> {
    return await db.select().from(sessionActions)
      .orderBy(desc(sessionActions.id))
      .limit(limit);
  }

  async createSessionAction(entry: InsertSessionAction): Promise<SessionAction> {
    const [created] = await db.insert(sessionActions).values(entry).returning();
    return created;
  }

  async bulkInsertStats(rows: { profileId: number; toolType: string; count: number; date: string }[]): Promise<void> {
    if (!rows.length) return;
    const BATCH = 200;
    for (let i = 0; i < rows.length; i += BATCH) {
      await db.insert(stats).values(rows.slice(i, i + BATCH));
    }
  }

  async getGlobalSettings(): Promise<Record<string, string>> {
    const rows = await db.select().from(globalSettings);
    const out: Record<string, string> = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
  }

  async setGlobalSetting(key: string, value: string): Promise<void> {
    await db.insert(globalSettings).values({ key, value })
      .onConflictDoUpdate({ target: globalSettings.key, set: { value } });
  }

  getLicenseByUsername(username: string): { id: number; username: string; password_hash: string; tier: string; account_limit: number; active: number; is_admin: number; expires_at: string | null } | undefined {
    return (db as any).$client.prepare(
      "SELECT * FROM licenses WHERE LOWER(username) = LOWER(?) AND active = 1"
    ).get(username) as any;
  }

  async getLicenseSession(): Promise<{ ok: true; username: string; tier: string; accountLimit: number; isAdmin: boolean; expiresAt: string | null } | { ok: false }> {
    const settings = await this.getGlobalSettings();
    const raw = settings["license_session"];
    if (!raw) return { ok: false };
    try {
      const s = JSON.parse(raw);
      if (!s?.username) return { ok: false };
      return { ok: true, username: s.username, tier: s.tier, accountLimit: s.accountLimit, isAdmin: !!s.isAdmin, expiresAt: s.expiresAt ?? null };
    } catch { return { ok: false }; }
  }

  getAllLicenses(): Array<{ id: number; username: string; tier: string; account_limit: number; active: number; is_admin: number; created_at: string; expires_at: string | null }> {
    return (db as any).$client.prepare(
      "SELECT id, username, tier, account_limit, active, is_admin, created_at, expires_at FROM licenses ORDER BY created_at DESC"
    ).all() as any[];
  }

  createLicense(username: string, passwordHash: string, tier: string, accountLimit: number, expiresAt: string | null): void {
    (db as any).$client.prepare(
      "INSERT INTO licenses (username, password_hash, tier, account_limit, active, is_admin, created_at, expires_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)"
    ).run(username, passwordHash, tier, accountLimit, new Date().toISOString(), expiresAt);
  }

  updateLicense(id: number, updates: { tier?: string; accountLimit?: number; active?: number; expiresAt?: string | null; passwordHash?: string }): void {
    const fields: string[] = [];
    const values: any[] = [];
    if (updates.tier !== undefined) { fields.push("tier = ?"); values.push(updates.tier); }
    if (updates.accountLimit !== undefined) { fields.push("account_limit = ?"); values.push(updates.accountLimit); }
    if (updates.active !== undefined) { fields.push("active = ?"); values.push(updates.active); }
    if (updates.expiresAt !== undefined) { fields.push("expires_at = ?"); values.push(updates.expiresAt); }
    if (updates.passwordHash !== undefined) { fields.push("password_hash = ?"); values.push(updates.passwordHash); }
    if (fields.length === 0) return;
    values.push(id);
    (db as any).$client.prepare(`UPDATE licenses SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  deleteLicense(id: number): void {
    (db as any).$client.prepare("DELETE FROM licenses WHERE is_admin = 0 AND id = ?").run(id);
  }

  async isGloballySkipped(username: string): Promise<boolean> {
    const rows = await db.select({ id: skippedUsers.id })
      .from(skippedUsers)
      .where(sql`LOWER(${skippedUsers.instagramUsername}) = LOWER(${username})`)
      .limit(1);
    return rows.length > 0;
  }

  async isGloballyFollowed(username: string): Promise<boolean> {
    const rows = await db.select({ id: followedUsers.id })
      .from(followedUsers)
      .where(sql`LOWER(${followedUsers.instagramUsername}) = LOWER(${username})`)
      .limit(1);
    return rows.length > 0;
  }

  async getGlobalFollowerLabel(username: string): Promise<string | null> {
    const rows = await db
      .select({ accountLabel: profiles.accountLabel, profileUsername: profiles.username })
      .from(followedUsers)
      .innerJoin(profiles, eq(followedUsers.profileId, profiles.id))
      .where(sql`LOWER(${followedUsers.instagramUsername}) = LOWER(${username})`)
      .orderBy(desc(followedUsers.id))
      .limit(1);
    if (!rows.length) return null;
    return rows[0].accountLabel || rows[0].profileUsername || null;
  }

  async addSkippedUser(username: string, reason: string): Promise<void> {
    await db.insert(skippedUsers)
      .values({ instagramUsername: username, reason, skippedAt: new Date().toISOString() })
      .onConflictDoNothing();
  }

  async getSkippedUsers(limit: number = 10000): Promise<SkippedUser[]> {
    return await db.select().from(skippedUsers).orderBy(desc(skippedUsers.id)).limit(limit);
  }

  async getRepostedPostsByProfile(profileId: number, limit: number = 500): Promise<RepostedPost[]> {
    return await db.select().from(repostedPosts)
      .where(eq(repostedPosts.profileId, profileId))
      .orderBy(desc(repostedPosts.id))
      .limit(limit);
  }

  async createRepostedPost(entry: InsertRepostedPost): Promise<RepostedPost> {
    const [created] = await db.insert(repostedPosts).values(entry).returning();
    return created;
  }

  async deleteRepostedPost(id: number): Promise<void> {
    await db.delete(repostedPosts).where(eq(repostedPosts.id, id));
  }

  async isAlreadyReposted(profileId: number, mediaId: string): Promise<boolean> {
    const rows = await db.select({ id: repostedPosts.id })
      .from(repostedPosts)
      .where(and(eq(repostedPosts.profileId, profileId), eq(repostedPosts.mediaId, mediaId)))
      .limit(1);
    return rows.length > 0;
  }

  async getContactDmSentByProfile(profileId: number, limit: number = 1000): Promise<ContactDmSent[]> {
    return await db.select().from(contactDmSent)
      .where(eq(contactDmSent.profileId, profileId))
      .orderBy(desc(contactDmSent.id))
      .limit(limit);
  }

  async createContactDmSent(entry: InsertContactDmSent): Promise<ContactDmSent> {
    const [created] = await db.insert(contactDmSent).values(entry).returning();
    return created;
  }

  async isContactDmAlreadySent(profileId: number, instagramUsername: string): Promise<boolean> {
    const rows = await db.select({ id: contactDmSent.id })
      .from(contactDmSent)
      .where(and(
        eq(contactDmSent.profileId, profileId),
        sql`LOWER(${contactDmSent.instagramUsername}) = LOWER(${instagramUsername})`
      ))
      .limit(1);
    return rows.length > 0;
  }

  async deleteContactDmSent(id: number): Promise<void> {
    await db.delete(contactDmSent).where(eq(contactDmSent.id, id));
  }

  async getContactPendingMessages(profileId: number, status?: string): Promise<ContactPendingMessage[]> {
    const conditions = status
      ? and(eq(contactPendingMessages.profileId, profileId), eq(contactPendingMessages.status, status))
      : eq(contactPendingMessages.profileId, profileId);
    return await db.select().from(contactPendingMessages)
      .where(conditions)
      .orderBy(desc(contactPendingMessages.id));
  }

  async createContactPendingMessage(entry: InsertContactPendingMessage): Promise<ContactPendingMessage> {
    const [created] = await db.insert(contactPendingMessages).values(entry).returning();
    return created;
  }

  async updateContactPendingMessage(id: number, updates: Partial<Pick<ContactPendingMessage, 'status' | 'sentAt' | 'dmThreadId' | 'dmItemId' | 'unsendAt'>>): Promise<void> {
    await db.update(contactPendingMessages).set(updates).where(eq(contactPendingMessages.id, id));
  }

  async deleteContactPendingMessage(id: number): Promise<void> {
    await db.delete(contactPendingMessages).where(eq(contactPendingMessages.id, id));
  }

  async clearContactPendingMessages(profileId: number | null): Promise<void> {
    const condition = profileId !== null
      ? and(eq(contactPendingMessages.profileId, profileId), eq(contactPendingMessages.status, "pending"))
      : eq(contactPendingMessages.status, "pending");
    await db.delete(contactPendingMessages).where(condition);
  }

  async isContactAlreadyQueued(profileId: number, instagramUsername: string): Promise<boolean> {
    const rows = await db.select({ id: contactPendingMessages.id })
      .from(contactPendingMessages)
      .where(and(
        eq(contactPendingMessages.profileId, profileId),
        eq(contactPendingMessages.status, "pending"),
        sql`LOWER(${contactPendingMessages.instagramUsername}) = LOWER(${instagramUsername})`
      ))
      .limit(1);
    return rows.length > 0;
  }

  async hasAnyMessageRecord(profileId: number, instagramUsername: string): Promise<boolean> {
    // Checks contactPendingMessages for any non-failed record (any messageType, pending or sent).
    // Used as a broader dedup guard: catches users who were queued+sent even if their
    // contactDmSent row was manually deleted from the UI.
    const rows = await db.select({ id: contactPendingMessages.id })
      .from(contactPendingMessages)
      .where(and(
        eq(contactPendingMessages.profileId, profileId),
        sql`LOWER(${contactPendingMessages.instagramUsername}) = LOWER(${instagramUsername})`,
        sql`${contactPendingMessages.status} != 'failed'`
      ))
      .limit(1);
    return rows.length > 0;
  }

  async isAutoReplyAlreadyQueued(profileId: number, instagramUsername: string): Promise<boolean> {
    // Block on ANY auto-reply record (pending OR sent) — prevents re-triggering once a
    // user has already received or is about to receive an auto-reply.
    const rows = await db.select({ id: contactPendingMessages.id })
      .from(contactPendingMessages)
      .where(and(
        eq(contactPendingMessages.profileId, profileId),
        eq(contactPendingMessages.messageType, "auto_reply"),
        sql`LOWER(${contactPendingMessages.instagramUsername}) = LOWER(${instagramUsername})`,
        sql`${contactPendingMessages.status} != 'failed'`
      ))
      .limit(1);
    return rows.length > 0;
  }

  async getContactMessagesForUnsend(profileId: number): Promise<ContactPendingMessage[]> {
    const now = new Date().toISOString();
    return await db.select().from(contactPendingMessages)
      .where(and(
        eq(contactPendingMessages.profileId, profileId),
        eq(contactPendingMessages.status, "sent"),
        sql`${contactPendingMessages.unsendAt} IS NOT NULL AND ${contactPendingMessages.unsendAt} <= ${now}`
      ));
  }

  async saveApiCreatedAccount(data: InsertApiCreatedAccount): Promise<ApiCreatedAccount> {
    const [created] = await db.insert(apiCreatedAccounts).values(data).returning();
    return created;
  }

  async updateApiCreatedAccount(id: number, updates: Partial<InsertApiCreatedAccount>): Promise<void> {
    await db.update(apiCreatedAccounts).set(updates).where(eq(apiCreatedAccounts.id, id));
  }

  async getApiCreatedAccounts(): Promise<ApiCreatedAccount[]> {
    return await db.select().from(apiCreatedAccounts).orderBy(desc(apiCreatedAccounts.id));
  }

  async listApiCreatedAccounts(): Promise<ApiCreatedAccount[]> {
    return await db.select().from(apiCreatedAccounts).orderBy(desc(apiCreatedAccounts.id));
  }

  async deleteApiCreatedAccount(id: number): Promise<void> {
    await db.delete(apiCreatedAccounts).where(eq(apiCreatedAccounts.id, id));
  }

  async insertBanAnalytics(entry: { username: string; proxyHost: string; bannedAt: string; endpointCount: number; endpointSnapshot: string; verifyCountLast24h?: number; accountAgeDays?: number | null; proxyAccountCount?: number; followCountBeforeBan?: number; sessionToActionRatio?: string | null; spanHours?: string | null; lastOperationBeforeBan?: string | null; userAgentApi?: string | null; userAgentEmbedded?: string | null; igDeviceState?: string | null; ebFingerprint?: string | null; leakSnapshot?: string | null }): Promise<void> {
    await db.insert(bannedAccountsAnalytics).values(entry);
  }

  async getBanAnalytics(): Promise<BannedAccountAnalytics[]> {
    return await db.select().from(bannedAccountsAnalytics).orderBy(desc(bannedAccountsAnalytics.id));
  }

  async deleteBanAnalytics(id: number): Promise<void> {
    await db.delete(bannedAccountsAnalytics).where(eq(bannedAccountsAnalytics.id, id));
  }

  async insertAutomatedBehaviourAnalytics(entry: { username: string; proxyHost: string; flaggedAt: string; endpointCount: number; endpointSnapshot: string; verifyCountLast24h?: number; accountAgeDays?: number | null; proxyAccountCount?: number; followCountBeforeBan?: number; sessionToActionRatio?: string | null; spanHours?: string | null; lastOperationBeforeBan?: string | null; userAgentApi?: string | null; userAgentEmbedded?: string | null; igDeviceState?: string | null; ebFingerprint?: string | null; leakSnapshot?: string | null }): Promise<void> {
    await db.insert(automatedBehaviourAnalytics).values(entry);
  }

  async getAutomatedBehaviourAnalytics(): Promise<AutomatedBehaviourAnalytics[]> {
    return await db.select().from(automatedBehaviourAnalytics).orderBy(desc(automatedBehaviourAnalytics.id));
  }

  async deleteAutomatedBehaviourAnalytics(id: number): Promise<void> {
    await db.delete(automatedBehaviourAnalytics).where(eq(automatedBehaviourAnalytics.id, id));
  }

  async insertCaptchaAnalytics(entry: { username: string; proxyHost: string; flaggedAt: string; endpointCount: number; endpointSnapshot: string; verifyCountLast24h?: number; accountAgeDays?: number | null; proxyAccountCount?: number; followCountBeforeBan?: number; sessionToActionRatio?: string | null; spanHours?: string | null; lastOperationBeforeBan?: string | null; userAgentApi?: string | null; userAgentEmbedded?: string | null; igDeviceState?: string | null; ebFingerprint?: string | null; leakSnapshot?: string | null }): Promise<void> {
    await db.insert(captchaAnalytics).values(entry);
  }

  async getCaptchaAnalytics(): Promise<CaptchaAnalytics[]> {
    return await db.select().from(captchaAnalytics).orderBy(desc(captchaAnalytics.id));
  }

  async deleteCaptchaAnalytics(id: number): Promise<void> {
    await db.delete(captchaAnalytics).where(eq(captchaAnalytics.id, id));
  }

  async insertLockedAnalytics(entry: { username: string; proxyHost: string; flaggedAt: string; endpointCount: number; endpointSnapshot: string; verifyCountLast24h?: number; accountAgeDays?: number | null; proxyAccountCount?: number; followCountBeforeBan?: number; sessionToActionRatio?: string | null; spanHours?: string | null; lastOperationBeforeBan?: string | null; userAgentApi?: string | null; userAgentEmbedded?: string | null; igDeviceState?: string | null; ebFingerprint?: string | null; leakSnapshot?: string | null }): Promise<void> {
    await db.insert(lockedAccountsAnalytics).values(entry);
  }

  async getLockedAnalytics(): Promise<LockedAccountAnalytics[]> {
    return await db.select().from(lockedAccountsAnalytics).orderBy(desc(lockedAccountsAnalytics.id));
  }

  async deleteLockedAnalytics(id: number): Promise<void> {
    await db.delete(lockedAccountsAnalytics).where(eq(lockedAccountsAnalytics.id, id));
  }

  async saveLeakSnapshot(profileId: number, snapshot: string): Promise<void> {
    await db.update(profiles).set({ leakSnapshot: snapshot }).where(eq(profiles.id, profileId));
  }

  async getLeakSnapshot(profileId: number): Promise<string | null> {
    const [row] = await db.select({ leakSnapshot: profiles.leakSnapshot }).from(profiles).where(eq(profiles.id, profileId));
    return row?.leakSnapshot ?? null;
  }
}

export const storage = new DatabaseStorage();
