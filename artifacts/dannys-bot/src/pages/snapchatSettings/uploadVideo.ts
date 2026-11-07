export type UploadVideoSettings = {
  enabled: boolean;
  min: number;
  max: number;
  activatePctMin: number;
  activatePctMax: number;
  directoryPath: string;
  selectAtRandom: boolean;
  addLink: boolean;
  linkUrl: string;
};

export const uploadVideoSettingsDefault: UploadVideoSettings = {
  enabled: false,
  min: 1,
  max: 1,
  activatePctMin: 100,
  activatePctMax: 100,
  directoryPath: "",
  selectAtRandom: false,
  addLink: false,
  linkUrl: "",
};
