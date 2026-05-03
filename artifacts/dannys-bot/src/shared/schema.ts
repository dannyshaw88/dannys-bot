import { z } from "zod";

export const ACCOUNT_STATUSES = [
  'pending',
  'valid',
  'banned',
  'captcha',
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
  'selfie_verification',
  'own_phone_verification',
  'email_connection',
  'upload',
  'review',
] as const;

export type AccountStatus = typeof ACCOUNT_STATUSES[number];

export type Proxy = {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
};

export type InsertProxy = Omit<Proxy, 'id' | 'name'>;

export type Profile = {
  id: number;
  username: string;
  password: string;
  email: string | null;
  proxyId: number | null;
  proxyHost: string | null;
  proxyPort: number | null;
  proxyUsername: string | null;
  proxyPassword: string | null;
  status: string;
  accountStatus: string;
  userAgentApi: string | null;
  userAgentEmbedded: string | null;
  apiLimits: { requestsMin: number; requestsMax: number; everySecondsMin: number; everySecondsMax: number } | null;
  browserDirectConnection: boolean | null;
  credentialsDirty: boolean | null;
  accountLabel: string | null;
  tags: string | null;
  dateOfBirth: string | null;
  notes: string | null;
  phoneNumber: string | null;
  twoFASecretKey: string | null;
  backupCodes: string | null;
  emailValidationUsername: string | null;
  emailValidationPassword: string | null;
  emailValidationPop3Server: string | null;
  emailValidationPort: string | null;
  activeTimerEnabled: boolean | null;
  activeTimerStart: string | null;
  activeTimerEnd: string | null;
  syncEnabled: boolean | null;
  syncIntervalMin: number | null;
  syncIntervalMax: number | null;
  syncUseHiker: boolean | null;
  followersCount: number | null;
  followingCount: number | null;
  postsCount: number | null;
  lastSyncedAt: string | null;
};

export type InsertProfile = Omit<Profile, 'id' | 'status'>;

export type Tool = {
  id: number;
  profileId: number;
  type: string;
  enabled: boolean;
  settings: Record<string, unknown> | null;
};

export type InsertTool = Omit<Tool, 'id'>;

export type Source = {
  id: number;
  toolId: number;
  type: string;
  value: string;
  rank: number | null;
  nrPosts: number | null;
};

export type InsertSource = Omit<Source, 'id'>;

export type Log = {
  id: number;
  profileId: number;
  toolType: string;
  message: string;
  timestamp: string;
};

export type FollowedUser = {
  id: number;
  profileId: number;
  instagramUsername: string;
  sourceValue: string;
  sourceType: string;
  followedAt: string;
};

export type InsertFollowedUser = Omit<FollowedUser, 'id'>;

export type SessionAction = {
  id: number;
  profileId: number;
  toolId: number;
  action: string;
  targetUsername: string;
  sourceValue: string;
  sourceType: string;
  result: string;
  detail: string | null;
  timestamp: string;
};

export type RepostedPost = {
  id: number;
  profileId: number;
  toolId: number;
  sourceUsername: string;
  mediaId: string;
  shortcode: string;
  caption: string;
  thumbnailUrl: string;
  repostedAt: string;
};

export type ContactDmSent = {
  id: number;
  profileId: number;
  instagramUsername: string;
  instagramUserId: string;
  sentAt: string;
  messagePreview: string;
};

export type ContactPendingMessage = {
  id: number;
  profileId: number;
  instagramUsername: string;
  instagramUserId: string;
  messageType: string;
  messageText: string;
  status: string;
  queuedAt: string;
  sentAt: string | null;
  dmThreadId: string | null;
  dmItemId: string | null;
  unsendAt: string | null;
};

export type Stat = {
  id: number;
  profileId: number;
  toolType: string;
  count: number;
  date: string;
};

export const insertProxySchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional().nullable(),
  password: z.string().optional().nullable(),
});

export const insertProfileSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  email: z.string().optional().nullable(),
  proxyId: z.number().optional().nullable(),
  proxyHost: z.string().optional().nullable(),
  proxyPort: z.number().optional().nullable(),
  proxyUsername: z.string().optional().nullable(),
  proxyPassword: z.string().optional().nullable(),
  accountStatus: z.string().optional(),
  userAgentApi: z.string().optional().nullable(),
  userAgentEmbedded: z.string().optional().nullable(),
  apiLimits: z.any().optional(),
  browserDirectConnection: z.boolean().optional(),
  credentialsDirty: z.boolean().optional(),
  tags: z.string().optional().nullable(),
  dateOfBirth: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  phoneNumber: z.string().optional().nullable(),
  twoFASecretKey: z.string().optional().nullable(),
  backupCodes: z.string().optional().nullable(),
  emailValidationUsername: z.string().optional().nullable(),
  emailValidationPassword: z.string().optional().nullable(),
  emailValidationPop3Server: z.string().optional().nullable(),
  emailValidationPort: z.string().optional().nullable(),
});

export const insertToolSchema = z.object({
  profileId: z.number().int(),
  type: z.string(),
  enabled: z.boolean().default(false),
  settings: z.any().optional(),
});

export const insertSourceSchema = z.object({
  toolId: z.number().int(),
  type: z.string(),
  value: z.string(),
  rank: z.number().int().optional().nullable(),
  nrPosts: z.number().int().optional().nullable(),
});

export type SkippedUser = {
  id: number;
  instagramUsername: string;
  reason: string;
  skippedAt: string;
};

export type GlobalSettings = {
  skipFollowedUsers: boolean;
  skipAlreadySkippedUsers: boolean;
  hikerApiEnabled: boolean;
  hikerApiToken: string;
  skipScrapedUsers: boolean;
  scrapedUserIgnoreDays: number;
  useLocalTime: boolean;
  twoCaptchaApiKey: string;
  verifyAllDelayMin: number;
  verifyAllDelayMax: number;
};
