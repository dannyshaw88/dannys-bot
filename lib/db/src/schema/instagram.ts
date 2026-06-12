import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const proxies = sqliteTable("proxies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull(),
  username: text("username"),
  password: text("password"),
  proxyType: text("proxy_type").default("http"),
});

export const ACCOUNT_STATUSES = [
  'verifying',
  'valid',
  'banned',
  'captcha',
  'locked',
  'bad_password',
  'email_confirmation',
  'phone_verification',
  'phone_validation',
  '2fa_verification',
  'stopped',
  'logged_out',
  'action_blocked',
  'action_required',
  'post_deleted',
  'account_disabled',
  'api_block',
  'captcha_disabled',
  'compromised',
  'email_verification',
  'invalid_credentials',
  'no_internet',
  'password_reset',
  'temporary_locked',
  'scrape_warning',
  'suspended',
  'confirm_human',
  'selfie_verification',
  'own_phone_verification',
  'email_connection',
  'upload',
  'review',
] as const;

export type AccountStatus = typeof ACCOUNT_STATUSES[number];

export const profiles = sqliteTable("profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull(),
  password: text("password").notNull(),
  email: text("email"),
  proxyId: integer("proxy_id"),
  proxyHost: text("proxy_host"),
  proxyPort: integer("proxy_port"),
  proxyUsername: text("proxy_username"),
  proxyPassword: text("proxy_password"),
  status: text("status").notNull().default('idle'),
  accountStatus: text("account_status").notNull().default('pending'),
  statusMessage: text("status_message"),
  userAgentApi: text("user_agent_api"),
  userAgentEmbedded: text("user_agent_embedded"),
  apiLimits: text("api_limits", { mode: "json" }).default({
    requestsMin: 5,
    requestsMax: 10,
    everySecondsMin: 30000,
    everySecondsMax: 60000
  }),
  browserDirectConnection: integer("browser_direct_connection", { mode: "boolean" }).default(true),
  credentialsDirty: integer("credentials_dirty", { mode: "boolean" }).default(true),
  accountLabel: text("account_label"),
  tags: text("tags"),
  dateOfBirth: text("date_of_birth"),
  notes: text("notes"),
  phoneNumber: text("phone_number"),
  twoFASecretKey: text("two_fa_secret_key"),
  backupCodes: text("backup_codes"),
  emailValidationUsername: text("email_validation_username"),
  emailValidationPassword: text("email_validation_password"),
  emailValidationPop3Server: text("email_validation_pop3_server"),
  emailValidationPort: text("email_validation_port"),
  activeTimerEnabled: integer("active_timer_enabled", { mode: "boolean" }).default(false),
  activeTimerStart: text("active_timer_start"),
  activeTimerEnd: text("active_timer_end"),
  syncEnabled: integer("sync_enabled", { mode: "boolean" }).default(false),
  syncIntervalMin: integer("sync_interval_min"),
  syncIntervalMax: integer("sync_interval_max"),
  syncUseHiker: integer("sync_use_hiker", { mode: "boolean" }).default(false),
  followersCount: integer("followers_count"),
  followingCount: integer("following_count"),
  postsCount: integer("posts_count"),
  lastSyncedAt: text("last_synced_at"),
  igDeviceState: text("ig_device_state"),
  igApiCookies: text("ig_api_cookies"),
  creatorMode: integer("creator_mode", { mode: "boolean" }).default(false),
  locked: integer("locked", { mode: "boolean" }).default(false),
  cookieBakerSettings: text("cookie_baker_settings", { mode: "json" }).default(null),
  ebFingerprint: text("eb_fingerprint"),
  isTemplate: integer("is_template", { mode: "boolean" }).default(false),
  templateId: text("template_id"),
});

export const tools = sqliteTable("tools", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull(),
  type: text("type").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  settings: text("settings", { mode: "json" }).default({}),
});

export const sources = sqliteTable("sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  toolId: integer("tool_id").notNull(),
  type: text("type").notNull(),
  value: text("value").notNull(),
  rank: integer("rank"),
  nrPosts: integer("nr_posts"),
  targetUserId: text("target_user_id").notNull().default(""),
  hashtagCursor: text("hashtag_cursor").notNull().default(""),
});

export const profilesRelations = relations(profiles, ({ one, many }) => ({
  proxy: one(proxies, {
    fields: [profiles.proxyId],
    references: [proxies.id],
  }),
  tools: many(tools),
  logs: many(logs),
}));

export const toolsRelations = relations(tools, ({ one, many }) => ({
  profile: one(profiles, {
    fields: [tools.profileId],
    references: [profiles.id],
  }),
  sources: many(sources),
}));

export const sourcesRelations = relations(sources, ({ one }) => ({
  tool: one(tools, {
    fields: [sources.toolId],
    references: [tools.id],
  }),
}));

export const logs = sqliteTable("logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull(),
  toolType: text("type").notNull(),
  message: text("message").notNull(),
  timestamp: text("timestamp").notNull(),
});

export const instagramApiCalls = sqliteTable("instagram_api_calls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull(),
  username: text("username").default(""),
  operationName: text("operation_name").notNull(),
  date: text("date").notNull(),
  message: text("message").default(""),
  source: text("source").default(""),
  navChain: text("nav_chain").default(""),
  ipAddress: text("ip_address").default(""),
  durationMs: integer("duration_ms").default(0),
});

export const logsRelations = relations(logs, ({ one }) => ({
  profile: one(profiles, {
    fields: [logs.profileId],
    references: [profiles.id],
  }),
}));

export const followedUsers = sqliteTable("followed_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull(),
  instagramUsername: text("instagram_username").notNull(),
  instagramUserId: text("instagram_user_id").notNull().default(""),
  sourceValue: text("source_value").notNull().default(""),
  sourceType: text("source_type").notNull().default(""),
  followedAt: text("followed_at").notNull(),
});

export const followedUsersRelations = relations(followedUsers, ({ one }) => ({
  profile: one(profiles, {
    fields: [followedUsers.profileId],
    references: [profiles.id],
  }),
}));

export const insertFollowedUserSchema = createInsertSchema(followedUsers).omit({ id: true });
export type FollowedUser = typeof followedUsers.$inferSelect;
export type InsertFollowedUser = z.infer<typeof insertFollowedUserSchema>;

export const sessionActions = sqliteTable("session_actions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull(),
  toolId: integer("tool_id").notNull(),
  action: text("action").notNull(),
  targetUsername: text("target_username").notNull(),
  sourceValue: text("source_value").notNull().default(""),
  sourceType: text("source_type").notNull().default(""),
  result: text("result").notNull().default("ok"),
  detail: text("detail").default(""),
  timestamp: text("timestamp").notNull(),
});

export const sessionActionsRelations = relations(sessionActions, ({ one }) => ({
  profile: one(profiles, {
    fields: [sessionActions.profileId],
    references: [profiles.id],
  }),
}));

export const insertSessionActionSchema = createInsertSchema(sessionActions).omit({ id: true });
export type SessionAction = typeof sessionActions.$inferSelect;
export type InsertSessionAction = z.infer<typeof insertSessionActionSchema>;

export const stats = sqliteTable("stats", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull(),
  toolType: text("type").notNull(),
  count: integer("count").notNull().default(0),
  date: text("date").notNull(),
});

export const statsRelations = relations(stats, ({ one }) => ({
  profile: one(profiles, {
    fields: [stats.profileId],
    references: [profiles.id],
  }),
}));

export const globalSettings = sqliteTable("global_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
});

export const hashtagCursors = sqliteTable("hashtag_cursors", {
  hashtag: text("hashtag").primaryKey(),
  cursor: text("cursor").notNull().default(""),
});

export const scrapedUsersGlobal = sqliteTable("scraped_users_global", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  instagramUserId: text("instagram_user_id").notNull().unique(),
  instagramUsername: text("instagram_username").notNull(),
  scrapedAt: text("scraped_at").notNull(),
});

export const skippedUsers = sqliteTable("skipped_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  instagramUsername: text("instagram_username").notNull(),
  reason: text("reason").notNull().default(""),
  skippedAt: text("skipped_at").notNull(),
});

export const insertSkippedUserSchema = createInsertSchema(skippedUsers).omit({ id: true });
export type SkippedUser = typeof skippedUsers.$inferSelect;
export type InsertSkippedUser = z.infer<typeof insertSkippedUserSchema>;

export const repostedPosts = sqliteTable("reposted_posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull(),
  toolId: integer("tool_id").notNull(),
  sourceUsername: text("source_username").notNull(),
  mediaId: text("media_id").notNull(),
  shortcode: text("shortcode").notNull().default(""),
  caption: text("caption").notNull().default(""),
  thumbnailUrl: text("thumbnail_url").notNull().default(""),
  repostedAt: text("reposted_at").notNull(),
  postedShortcode: text("posted_shortcode").notNull().default(""),
});

export const repostedPostsRelations = relations(repostedPosts, ({ one }) => ({
  profile: one(profiles, {
    fields: [repostedPosts.profileId],
    references: [profiles.id],
  }),
}));

export const insertRepostedPostSchema = createInsertSchema(repostedPosts).omit({ id: true });
export type RepostedPost = typeof repostedPosts.$inferSelect;
export type InsertRepostedPost = z.infer<typeof insertRepostedPostSchema>;

export const contactDmSent = sqliteTable("contact_dm_sent", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull(),
  instagramUsername: text("instagram_username").notNull(),
  instagramUserId: text("instagram_user_id").notNull().default(""),
  sentAt: text("sent_at").notNull(),
  messagePreview: text("message_preview").notNull().default(""),
});

export const contactDmSentRelations = relations(contactDmSent, ({ one }) => ({
  profile: one(profiles, {
    fields: [contactDmSent.profileId],
    references: [profiles.id],
  }),
}));

export const insertContactDmSentSchema = createInsertSchema(contactDmSent).omit({ id: true });
export type ContactDmSent = typeof contactDmSent.$inferSelect;
export type InsertContactDmSent = z.infer<typeof insertContactDmSentSchema>;

export const contactPendingMessages = sqliteTable("contact_pending_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull(),
  instagramUsername: text("instagram_username").notNull(),
  instagramUserId: text("instagram_user_id").notNull().default(""),
  messageType: text("message_type").notNull(),
  messageText: text("message_text").notNull(),
  status: text("status").notNull().default("pending"),
  queuedAt: text("queued_at").notNull(),
  sentAt: text("sent_at"),
  dmThreadId: text("dm_thread_id"),
  dmItemId: text("dm_item_id"),
  unsendAt: text("unsend_at"),
});

export const contactPendingMessagesRelations = relations(contactPendingMessages, ({ one }) => ({
  profile: one(profiles, {
    fields: [contactPendingMessages.profileId],
    references: [profiles.id],
  }),
}));

export const insertContactPendingMessageSchema = createInsertSchema(contactPendingMessages).omit({ id: true });
export type ContactPendingMessage = typeof contactPendingMessages.$inferSelect;
export type InsertContactPendingMessage = z.infer<typeof insertContactPendingMessageSchema>;

export const apiCreatedAccounts = sqliteTable("api_created_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull(),
  password: text("password").notNull(),
  email: text("email").notNull(),
  proxyHost: text("proxy_host"),
  proxyPort: integer("proxy_port"),
  proxyUsername: text("proxy_username"),
  proxyPassword: text("proxy_password"),
  bio: text("bio"),
  imapServer: text("imap_server"),
  imapPort: integer("imap_port"),
  imapPass: text("imap_pass"),
  status: text("status").notNull().default("pending"),
  instagramUserId: text("instagram_user_id"),
  sessionCookies: text("session_cookies"),
  errorMessage: text("error_message"),
  steps: text("steps"),
  addedToAccounts: integer("added_to_accounts", { mode: "boolean" }).default(false),
  profileId: integer("profile_id"),
  userAgentApi: text("user_agent_api"),
  apiLimits: text("api_limits"),
  dateOfBirth: text("date_of_birth"),
  createdAt: text("created_at").notNull(),
});

export const insertApiCreatedAccountSchema = createInsertSchema(apiCreatedAccounts).omit({ id: true });
export type ApiCreatedAccount = typeof apiCreatedAccounts.$inferSelect;
export type InsertApiCreatedAccount = z.infer<typeof insertApiCreatedAccountSchema>;

export const bannedAccountsAnalytics = sqliteTable("banned_accounts_analytics", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull(),
  proxyHost: text("proxy_host").default(""),
  bannedAt: text("banned_at").notNull(),
  endpointCount: integer("endpoint_count").default(0),
  endpointSnapshot: text("endpoint_snapshot").default("[]"),
});

export const insertBannedAccountAnalyticsSchema = createInsertSchema(bannedAccountsAnalytics).omit({ id: true });
export type BannedAccountAnalytics = typeof bannedAccountsAnalytics.$inferSelect;
export type InsertBannedAccountAnalytics = z.infer<typeof insertBannedAccountAnalyticsSchema>;

export const insertProxySchema = createInsertSchema(proxies).omit({ id: true }).extend({
  name: z.string().optional(),
  proxyType: z.enum(["http", "socks5"]).optional().default("http"),
});
export const insertProfileSchema = createInsertSchema(profiles).omit({ id: true, status: true }).extend({
  proxyHost: z.string().optional().nullable(),
  proxyPort: z.number().optional().nullable(),
  proxyUsername: z.string().optional().nullable(),
  proxyPassword: z.string().optional().nullable(),
  browserDirectConnection: z.boolean().optional().default(true),
});
export const insertToolSchema = createInsertSchema(tools).omit({ id: true });
export const insertSourceSchema = createInsertSchema(sources).omit({ id: true });
export const insertLogSchema = createInsertSchema(logs).omit({ id: true });

export type Proxy = typeof proxies.$inferSelect;
export type InsertProxy = z.infer<typeof insertProxySchema>;

export type Profile = typeof profiles.$inferSelect;
export type InsertProfile = z.infer<typeof insertProfileSchema>;

export type Tool = typeof tools.$inferSelect;
export type InsertTool = z.infer<typeof insertToolSchema>;

export type Source = typeof sources.$inferSelect;
export type InsertSource = z.infer<typeof insertSourceSchema>;

export type Log = typeof logs.$inferSelect;
export type InsertLog = z.infer<typeof insertLogSchema>;
