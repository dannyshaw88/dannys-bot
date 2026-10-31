import { z } from "zod/v4";

export const replyUnreadChatsSettingsDefault = {
  enabled: false,
  min: 1,
  max: 1,
  activatePctMin: 100,
  activatePctMax: 100,
  replyGoal: "",
};

export const replyUnreadChatsSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  min: z.number().int().min(0).default(1),
  max: z.number().int().min(0).default(1),
  activatePctMin: z.number().int().min(0).max(100).default(100),
  activatePctMax: z.number().int().min(0).max(100).default(100),
  replyGoal: z.string().max(5000).default(""),
}).default(replyUnreadChatsSettingsDefault);
