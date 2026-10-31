export type ViewSnapsSettings = {
  enabled: boolean;
  min: number;
  max: number;
  activatePctMin: number;
  activatePctMax: number;
  watchSecondsMin: number;
  watchSecondsMax: number;
};

export const viewSnapsSettingsDefault: ViewSnapsSettings = {
  enabled: false,
  min: 1,
  max: 3,
  activatePctMin: 100,
  activatePctMax: 100,
  watchSecondsMin: 5,
  watchSecondsMax: 10,
};
