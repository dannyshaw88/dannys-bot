export type MassSnapSettings = {
  enabled: boolean;
  min: number;
  max: number;
  activatePctMin: number;
  activatePctMax: number;
  contactScrollPixels: number;
};

export const massSnapSettingsDefault: MassSnapSettings = {
  enabled: false,
  min: 1,
  max: 1,
  activatePctMin: 0,
  activatePctMax: 0,
  contactScrollPixels: 130,
};
