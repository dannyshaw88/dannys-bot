import { z } from "zod/v4";

export const uploadSnapSettingsDefault = {
  enabled: false,
  min: 1,
  max: 1,
  activatePctMin: 100,
  activatePctMax: 100,
  directoryPath: "",
  selectAtRandom: false,
};

export const uploadSnapSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  min: z.number().int().min(1).default(1),
  max: z.number().int().min(1).default(1),
  activatePctMin: z.number().int().min(0).max(100).default(100),
  activatePctMax: z.number().int().min(0).max(100).default(100),
  directoryPath: z.string().max(4096).default(""),
  selectAtRandom: z.boolean().default(false),
}).default(uploadSnapSettingsDefault);
