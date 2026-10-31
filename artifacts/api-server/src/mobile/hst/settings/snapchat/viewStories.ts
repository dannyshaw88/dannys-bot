import { z } from "zod/v4";

export const viewStoriesSettingsDefault = {
  enabled: false,
  min: 1,
  max: 3,
  activatePctMin: 100,
  activatePctMax: 100,
  likePercentMin: 0,
  likePercentMax: 0,
  watchSecondsMin: 5,
  watchSecondsMax: 10,
};

export const viewStoriesSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  min: z.number().int().min(0).default(1),
  max: z.number().int().min(0).default(3),
  activatePctMin: z.number().int().min(0).max(100).default(100),
  activatePctMax: z.number().int().min(0).max(100).default(100),
  likePercentMin: z.number().int().min(0).max(100).default(0),
  likePercentMax: z.number().int().min(0).max(100).default(0),
  watchSecondsMin: z.number().int().min(1).max(60).default(5),
  watchSecondsMax: z.number().int().min(1).max(60).default(10),
}).default(viewStoriesSettingsDefault);
