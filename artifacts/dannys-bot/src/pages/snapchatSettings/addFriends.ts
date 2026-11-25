export type AddFriendsSettings = {
  enabled: boolean;
  min: number;
  max: number;
  delayMinSeconds: number;
  delayMaxSeconds: number;
  skipAdded: boolean;
  maxFollowsEnabled: boolean;
  maxFollowsMin: number;
  maxFollowsMax: number;
  dismissNonEnglish: boolean;
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
  maxFollowsEnabled: false,
  maxFollowsMin: 50,
  maxFollowsMax: 100,
  dismissNonEnglish: false,
  avoidUsersContainingEnabled: false,
  avoidUsersContainingWords: "",
  avoidUsersContainingFileName: "",
  activatePctMin: 100,
  activatePctMax: 100,
};
