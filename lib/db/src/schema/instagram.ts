import { pgTable, text, serial, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const proxies = pgTable("proxies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull(),
  username: text("username"),
  password: text("password"),
});

export const ACCOUNT_STATUSES = [
  'valid',
  'banned',
  'captcha',
  'email_confirmation',
  'phone_verification',
  '2fa_verification',
  'stopped',
  'logged_out',
  'action_blocked',
] as const;

export type AccountStatus = typeof ACCOUNT_STATUSES[number];

export const profiles = pgTable("profiles", {
  id: serial("id").primaryKey(),
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
  userAgentApi: text("user_agent_api"),
  userAgentEmbedded: text("user_agent_embedded"),
  apiLimits: jsonb("api_limits").default({
    requestsMin: 5,
    requestsMax: 10,
    everySecondsMin: 30,
    everySecondsMax: 60
  }),
  browserDirectConnection: boolean("browser_direct_connection").default(true),
  credentialsDirty: boolean("credentials_dirty").default(true),
  // Account details
  tags: text("tags"),
  dateOfBirth: text("date_of_birth"),
  notes: text("notes"),
  // Security
  phoneNumber: text("phone_number"),
  twoFASecretKey: text("two_fa_secret_key"),
  backupCodes: text("backup_codes"),
  // Email validation
  emailValidationUsername: text("email_validation_username"),
  emailValidationPassword: text("email_validation_password"),
  emailValidationPop3Server: text("email_validation_pop3_server"),
  emailValidationPort: text("email_validation_port"),
  // Active timer — "HH:MM" strings, null means timer disabled
  activeTimerEnabled: boolean("active_timer_enabled").default(false),
  activeTimerStart: text("active_timer_start"),
  activeTimerEnd: text("active_timer_end"),
});

export const tools = pgTable("tools", {
  id: serial("id").primaryKey(),
  profileId: integer("profile_id").notNull(),
  type: text("type").notNull(), // 'follow', 'like', 'dm', 'unfollow'
  enabled: boolean("enabled").notNull().default(false),
  settings: jsonb("settings").default({}),
});

export const sources = pgTable("sources", {
  id: serial("id").primaryKey(),
  toolId: integer("tool_id").notNull(),
  type: text("type").notNull(), // 'hashtag', 'target_followers'
  value: text("value").notNull(),
  rank: integer("rank"),        // Jarvee-style weight out of 1000
  nrPosts: integer("nr_posts"), // Post count from Jarvee export
});

// Relations
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

export const logs = pgTable("logs", {
  id: serial("id").primaryKey(),
  profileId: integer("profile_id").notNull(),
  toolType: text("type").notNull(), // 'follow', 'dm', etc
  message: text("message").notNull(),
  timestamp: text("timestamp").notNull(), // Use ISO string or timestamp
});

// Tracks actual Instagram API HTTP calls (matches Jarvee's API Calls export format)
export const instagramApiCalls = pgTable("instagram_api_calls", {
  id: serial("id").primaryKey(),
  profileId: integer("profile_id").notNull(),
  operationName: text("operation_name").notNull(),  // e.g. "GetTimeline", "Follow"
  date: text("date").notNull(),                      // ISO timestamp
  message: text("message").default(""),
  source: text("source").default(""),               // "Post" / "Get"
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

export const followedUsers = pgTable("followed_users", {
  id: serial("id").primaryKey(),
  profileId: integer("profile_id").notNull(),
  instagramUsername: text("instagram_username").notNull(),
  sourceValue: text("source_value").notNull().default(""),   // e.g. "#travel" or "@someaccount"
  sourceType: text("source_type").notNull().default(""),     // "hashtag" | "target_followers" | etc
  followedAt: text("followed_at").notNull(),                  // ISO timestamp
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

export const sessionActions = pgTable("session_actions", {
  id: serial("id").primaryKey(),
  profileId: integer("profile_id").notNull(),
  toolId: integer("tool_id").notNull(),
  action: text("action").notNull(),        // 'like','view_stories','view_reels','view_highlights','follow','follow_skipped','follow_blocked','dedup_skip'
  targetUsername: text("target_username").notNull(),
  sourceValue: text("source_value").notNull().default(""),
  sourceType: text("source_type").notNull().default(""),
  result: text("result").notNull().default("ok"), // 'ok','skipped','error'
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

export const stats = pgTable("stats", {
  id: serial("id").primaryKey(),
  profileId: integer("profile_id").notNull(),
  toolType: text("type").notNull(), // 'follow', 'dm', 'unfollow'
  count: integer("count").notNull().default(0),
  date: text("date").notNull(), // 'YYYY-MM-DD' for daily, 'lifetime' for lifetime
});

export const statsRelations = relations(stats, ({ one }) => ({
  profile: one(profiles, {
    fields: [stats.profileId],
    references: [profiles.id],
  }),
}));
// Global key-value settings (e.g. skipFollowedUsers, skipAlreadySkippedUsers)
export const globalSettings = pgTable("global_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
});

// Users skipped globally (shared across all profiles)
export const skippedUsers = pgTable("skipped_users", {
  id: serial("id").primaryKey(),
  instagramUsername: text("instagram_username").notNull(),
  reason: text("reason").notNull().default(""),
  skippedAt: text("skipped_at").notNull(),
});

export const insertSkippedUserSchema = createInsertSchema(skippedUsers).omit({ id: true });
export type SkippedUser = typeof skippedUsers.$inferSelect;
export type InsertSkippedUser = z.infer<typeof insertSkippedUserSchema>;

export const repostedPosts = pgTable("reposted_posts", {
  id: serial("id").primaryKey(),
  profileId: integer("profile_id").notNull(),
  toolId: integer("tool_id").notNull(),
  sourceUsername: text("source_username").notNull(),
  mediaId: text("media_id").notNull(),
  shortcode: text("shortcode").notNull().default(""),
  caption: text("caption").notNull().default(""),
  thumbnailUrl: text("thumbnail_url").notNull().default(""),
  repostedAt: text("reposted_at").notNull(),
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

// Tracks which users have already been DM'd as new followers for a profile,
// so they are never messaged twice.
export const contactDmSent = pgTable("contact_dm_sent", {
  id: serial("id").primaryKey(),
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

// Queue of outgoing contact DMs (pending → sent/failed).
// Populated by the Contact New Followers runner; consumed by the Contact Users runner.
export const contactPendingMessages = pgTable("contact_pending_messages", {
  id: serial("id").primaryKey(),
  profileId: integer("profile_id").notNull(),
  instagramUsername: text("instagram_username").notNull(),
  instagramUserId: text("instagram_user_id").notNull().default(""),
  messageType: text("message_type").notNull(), // 'new_follower' | 'auto_reply'
  messageText: text("message_text").notNull(),
  status: text("status").notNull().default("pending"), // 'pending' | 'sent' | 'failed'
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

export const insertProxySchema = createInsertSchema(proxies).omit({ id: true }).extend({
  name: z.string().optional(),
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

// Types
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
