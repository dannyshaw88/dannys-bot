export type AcceptFriendsSettings = {
  enabled: boolean;
  min: number;
  max: number;
  activatePctMin: number;
  activatePctMax: number;
};

export const acceptFriendsSettingsDefault: AcceptFriendsSettings = {
  enabled: false,
  min: 1,
  max: 3,
  activatePctMin: 100,
  activatePctMax: 100,
};
