export type AddFriendsSettings = {
  enabled: boolean;
  min: number;
  max: number;
  delayMinSeconds: number;
  delayMaxSeconds: number;
  skipAdded: boolean;
  avoidUsersContainingEnabled: boolean;
  avoidUsersContainingWords: string;
  avoidUsersContainingFileName: string;
  activatePctMin: number;
  activatePctMax: number;
};

export const addFriendsSettingsDefault: AddFriendsSettings = {
  enabled: false,
  min: 1,
  max: 2,
  delayMinSeconds: 1,
  delayMaxSeconds: 3,
  skipAdded: false,
  avoidUsersContainingEnabled: false,
  avoidUsersContainingWords: "",
  avoidUsersContainingFileName: "",
  activatePctMin: 100,
  activatePctMax: 100,
};
