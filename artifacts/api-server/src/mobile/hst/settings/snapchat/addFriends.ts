import { z } from "zod/v4";

export const addFriendsSettingsDefault = {
  enabled: false,
  min: 1,
  max: 2,
  activatePctMin: 100,
  activatePctMax: 100,
};

export const addFriendsSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  min: z.number().int().min(0).default(1),
  max: z.number().int().min(0).default(2),
  activatePctMin: z.number().int().min(0).max(100).default(100),
  activatePctMax: z.number().int().min(0).max(100).default(100),
}).default(addFriendsSettingsDefault);
