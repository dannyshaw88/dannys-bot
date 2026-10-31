export type AddFriendsSettings = {
  enabled: boolean;
  min: number;
  max: number;
  activatePctMin: number;
  activatePctMax: number;
};

export const addFriendsSettingsDefault: AddFriendsSettings = {
  enabled: false,
  min: 1,
  max: 2,
  activatePctMin: 100,
  activatePctMax: 100,
};
