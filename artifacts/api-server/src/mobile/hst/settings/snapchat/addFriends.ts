import { z } from "zod/v4";

export const addFriendsSettingsDefault = {
  enabled: false,
  min: 1,
  max: 2,
  delayMinSeconds: 1,
  delayMaxSeconds: 3,
  skipAdded: false,
  maxFollowsEnabled: false,
  maxFollowsMin: 50,
  maxFollowsMax: 100,
  dismissNonEnglish: false,
  avoidUsersContainingEnabled: false,
  avoidUsersContainingWords: "",
  avoidUsersContainingFileName: "",
  activatePctMin: 100,
  activatePctMax: 100,
};

export const addFriendsSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  min: z.number().int().min(0).default(1),
  max: z.number().int().min(0).default(2),
  delayMinSeconds: z.number().int().min(1).default(1),
  delayMaxSeconds: z.number().int().min(1).default(3),
  skipAdded: z.boolean().default(false),
  maxFollowsEnabled: z.boolean().default(false),
  maxFollowsMin: z.number().int().min(0).default(50),
  maxFollowsMax: z.number().int().min(0).default(100),
  dismissNonEnglish: z.boolean().default(false),
  avoidUsersContainingEnabled: z.boolean().default(false),
  avoidUsersContainingWords: z.string().max(1_000_000).default(""),
  avoidUsersContainingFileName: z.string().max(255).default(""),
  activatePctMin: z.number().int().min(0).max(100).default(100),
  activatePctMax: z.number().int().min(0).max(100).default(100),
}).default(addFriendsSettingsDefault);
