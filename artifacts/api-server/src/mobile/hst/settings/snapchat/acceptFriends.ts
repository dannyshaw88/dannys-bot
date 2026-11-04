import { z } from "zod/v4";

export const acceptFriendsSettingsDefault = {
  enabled: false,
  min: 1,
  max: 3,
  delayMinSeconds: 1,
  delayMaxSeconds: 3,
  activatePctMin: 100,
  activatePctMax: 100,
};

export const acceptFriendsSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  min: z.number().int().min(0).default(1),
  max: z.number().int().min(0).default(3),
  delayMinSeconds: z.number().int().min(1).default(1),
  delayMaxSeconds: z.number().int().min(1).default(3),
  activatePctMin: z.number().int().min(0).max(100).default(100),
  activatePctMax: z.number().int().min(0).max(100).default(100),
}).default(acceptFriendsSettingsDefault);
