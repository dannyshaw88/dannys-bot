import { db } from "@workspace/db";
import { userAgents } from "./shared/userAgents";
import {
  proxies, profiles, tools, sources, stats, instagramApiCalls, followedUsers, sessionActions,
  globalSettings, skippedUsers, repostedPosts, contactDmSent, contactPendingMessages,
  hashtagCursors, scrapedUsersGlobal, apiCreatedAccounts,
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
} from "./shared/schema";
import { eq, desc, and, sql, like, gt } from "drizzle-orm";

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
  incrementStat(profileId: number, toolType: string): Promise<void>;

  // Sources
  getSourcesByTool(toolId: number): Promise<Source[]>;
  createSource(source: InsertSource): Promise<Source>;
  createSourcesBulk(rows: InsertSource[]): Promise<Source[]>;
  deleteSource(id: number): Promise<void>;
  updateSourceTargetUserId(id: number, targetUserId: string): Promise<void>;
  updateSourceHashtagCursor(id: number, cursor: string): Promise<void>;

  // Instagram API Calls
  getInstagramApiCalls(limit?: number): Promise<any[]>;
  getInstagramApiCallsByProfile(profileId: number, limit?: number): Promise<any[]>;
  createInstagramApiCall(call: { profileId: number; username?: string; operationName: string; date: string; message?: string; source?: string; navChain?: string; ipAddress?: string; durationMs?: number }): Promise<any>;
  resetStuckVerifyingAccounts(): Promise<number>;

  // Followed Users
  getFollowedUsersByProfile(profileId: number, limit?: number): Promise<FollowedUser[]>;
  createFollowedUser(entry: InsertFollowedUser): Promise<FollowedUser>;
  deleteFollowedUser(id: number): Promise<void>;
  countFollowsToday(profileId: number, todayPrefix: string): Promise<number>;
  countFollowsThisHour(profileId: number, hourPrefix: string): Promise<number>;
  bulkImportFollowedUsers(profileId: number, entries: { username: string; userId: string; followedAt: string }[]): Promise<{ imported: number; skipped: number }>;

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
    const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];
    const [created] = await db.insert(profiles).values({
      ...profile,
      // Only fall back to random UA if the caller did not supply one
      userAgentApi: profile.userAgentApi || randomUA.api,
      userAgentEmbedded: profile.userAgentEmbedded || randomUA.embedded,
      tags: profile.tags || "",
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
    }
    const [updated] = await db.update(profiles).set(updates).where(eq(profiles.id, id)).returning();
    return updated;
  }

  async deleteProfile(id: number): Promise<void> {
    await db.delete(tools).where(eq(tools.profileId, id));
    await db.delete(profiles).where(eq(profiles.id, id));
  }

  async updateProfileStatus(id: number, status: string): Promise<Profile> {
    const [updated] = await db.update(profiles).set({ status }).where(eq(profiles.id, id)).returning();
    return updated;
  }

  async getToolsByProfile(profileId: number): Promise<Tool[]> {
    const existing = await db.select().from(tools).where(eq(tools.profileId, profileId));
    const allTypes = ['follow', 'unfollow', 'like', 'dm', 'contact'];
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

  async getInstagramApiCalls(limit: number = 100000): Promise<any[]> {
    return await db.select().from(instagramApiCalls).orderBy(desc(instagramApiCalls.id)).limit(limit);
  }

  async getInstagramApiCallsByProfile(profileId: number, limit: number = 2000): Promise<any[]> {
    return await db.select().from(instagramApiCalls)
      .where(eq(instagramApiCalls.profileId, profileId))
      .orderBy(desc(instagramApiCalls.id))
      .limit(limit);
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

  private _apiCallInsertCount = 0;

  async createInstagramApiCall(call: { profileId: number; username?: string; operationName: string; date: string; message?: string; source?: string; navChain?: string; ipAddress?: string; durationMs?: number }): Promise<any> {
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
    entries: { username: string; userId: string; followedAt: string }[]
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
          sourceValue: "jarvee_import",
          sourceType: "jarvee_import",
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
}

export const storage = new DatabaseStorage();
