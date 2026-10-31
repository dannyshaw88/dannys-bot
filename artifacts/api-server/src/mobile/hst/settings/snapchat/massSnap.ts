import { z } from "zod/v4";

export const massSnapSettingsDefault = {
  enabled: false,
  min: 1,
  max: 1,
  activatePctMin: 0,
  activatePctMax: 0,
  contactScrollPixels: 130,
};

export const massSnapSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  min: z.number().int().min(1).default(1),
  max: z.number().int().min(1).default(1),
  activatePctMin: z.number().int().min(0).max(100).default(0),
  activatePctMax: z.number().int().min(0).max(100).default(0),
  contactScrollPixels: z.number().int().min(40).max(1_000).default(130),
}).default(massSnapSettingsDefault);
