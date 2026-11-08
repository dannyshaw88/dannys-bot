import { z } from "zod/v4";

export const uploadVideoSettingsDefault = {
  enabled: false,
  min: 1,
  max: 1,
  activatePctMin: 100,
  activatePctMax: 100,
  directoryPath: "",
  selectAtRandom: false,
  addLink: false,
  linkUrl: "",
  caption: "",
};

export const uploadVideoSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  min: z.number().int().min(1).default(1),
  max: z.number().int().min(1).default(1),
  activatePctMin: z.number().int().min(0).max(100).default(100),
  activatePctMax: z.number().int().min(0).max(100).default(100),
  directoryPath: z.string().max(4096).default(""),
  selectAtRandom: z.boolean().default(false),
  addLink: z.boolean().default(false),
  linkUrl: z.string().max(2048).default(""),
  caption: z.string().default(""),
}).default(uploadVideoSettingsDefault);
