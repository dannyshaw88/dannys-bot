export type ViewStoriesSettings = {
  enabled: boolean;
  min: number;
  max: number;
  activatePctMin: number;
  activatePctMax: number;
  likePercentMin: number;
  likePercentMax: number;
  watchSecondsMin: number;
  watchSecondsMax: number;
};

export const viewStoriesSettingsDefault: ViewStoriesSettings = {
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
