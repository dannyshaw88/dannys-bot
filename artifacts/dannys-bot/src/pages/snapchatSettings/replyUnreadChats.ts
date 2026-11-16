export type ReplyUnreadChatsSettings = {
  enabled: boolean;
  min: number;
  max: number;
  activatePctMin: number;
  activatePctMax: number;
  replyGoal: string;
  replyToEverything: boolean;
};

export const replyUnreadChatsSettingsDefault: ReplyUnreadChatsSettings = {
  enabled: false,
  min: 1,
  max: 1,
  activatePctMin: 100,
  activatePctMax: 100,
  replyGoal: "",
  replyToEverything: false,
};
