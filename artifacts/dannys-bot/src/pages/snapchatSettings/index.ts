import { acceptFriendsSettingsDefault, type AcceptFriendsSettings } from "./acceptFriends";
import { addFriendsSettingsDefault, type AddFriendsSettings } from "./addFriends";
import { massSnapSettingsDefault, type MassSnapSettings } from "./massSnap";
import { replyUnreadChatsSettingsDefault, type ReplyUnreadChatsSettings } from "./replyUnreadChats";
import { shuffleToolOrderDefault } from "./shuffleToolOrder";
import { uploadSnapSettingsDefault, type UploadSnapSettings } from "./uploadSnap";
import { uploadVideoSettingsDefault, type UploadVideoSettings } from "./uploadVideo";
import { viewSnapsSettingsDefault, type ViewSnapsSettings } from "./viewSnaps";
import { viewStoriesSettingsDefault, type ViewStoriesSettings } from "./viewStories";

export type SnapchatToolSettings = {
  shuffleToolOrder: boolean;
  uploadSnap: UploadSnapSettings;
  uploadVideo: UploadVideoSettings;
  addFriends: AddFriendsSettings;
  massSnap: MassSnapSettings;
  acceptFriends: AcceptFriendsSettings;
  replyUnreadChats: ReplyUnreadChatsSettings;
  viewStories: ViewStoriesSettings;
  viewSnaps: ViewSnapsSettings;
};

export const snapchatToolSettingsDefaults: SnapchatToolSettings = {
  shuffleToolOrder: shuffleToolOrderDefault,
  uploadSnap: uploadSnapSettingsDefault,
  uploadVideo: uploadVideoSettingsDefault,
  addFriends: addFriendsSettingsDefault,
  massSnap: massSnapSettingsDefault,
  acceptFriends: acceptFriendsSettingsDefault,
  replyUnreadChats: replyUnreadChatsSettingsDefault,
  viewStories: viewStoriesSettingsDefault,
  viewSnaps: viewSnapsSettingsDefault,
};

export type {
  AcceptFriendsSettings,
  AddFriendsSettings,
  MassSnapSettings,
  ReplyUnreadChatsSettings,
  UploadSnapSettings,
  UploadVideoSettings,
  ViewSnapsSettings,
  ViewStoriesSettings,
};
