export type AcceptFriendsSettings = {
  enabled: boolean;
  min: number;
  max: number;
  delayMinSeconds: number;
  delayMaxSeconds: number;
  activatePctMin: number;
  activatePctMax: number;
};

export const acceptFriendsSettingsDefault: AcceptFriendsSettings = {
  enabled: false,
  min: 1,
  max: 3,
  delayMinSeconds: 1,
  delayMaxSeconds: 3,
  activatePctMin: 100,
  activatePctMax: 100,
};
