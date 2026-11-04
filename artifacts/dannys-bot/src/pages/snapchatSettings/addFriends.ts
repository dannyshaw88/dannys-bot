export type AddFriendsSettings = {
  enabled: boolean;
  min: number;
  max: number;
  delayMinSeconds: number;
  delayMaxSeconds: number;
  activatePctMin: number;
  activatePctMax: number;
};

export const addFriendsSettingsDefault: AddFriendsSettings = {
  enabled: false,
  min: 1,
  max: 2,
  delayMinSeconds: 1,
  delayMaxSeconds: 3,
  activatePctMin: 100,
  activatePctMax: 100,
};
