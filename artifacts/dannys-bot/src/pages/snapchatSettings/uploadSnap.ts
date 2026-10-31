export type UploadSnapSettings = {
  enabled: boolean;
  min: number;
  max: number;
  activatePctMin: number;
  activatePctMax: number;
  directoryPath: string;
  selectAtRandom: boolean;
};

export const uploadSnapSettingsDefault: UploadSnapSettings = {
  enabled: false,
  min: 1,
  max: 1,
  activatePctMin: 100,
  activatePctMax: 100,
  directoryPath: "",
  selectAtRandom: false,
};
