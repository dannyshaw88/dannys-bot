import { z } from "zod/v4";
import { acceptFriendsSettingsDefault, acceptFriendsSettingsSchema } from "./acceptFriends";
import { addFriendsSettingsDefault, addFriendsSettingsSchema } from "./addFriends";
import { massSnapSettingsDefault, massSnapSettingsSchema } from "./massSnap";
import { replyUnreadChatsSettingsDefault, replyUnreadChatsSettingsSchema } from "./replyUnreadChats";
import { shuffleToolOrderDefault, shuffleToolOrderSchema } from "./shuffleToolOrder";
import { uploadSnapSettingsDefault, uploadSnapSettingsSchema } from "./uploadSnap";
import { uploadVideoSettingsDefault, uploadVideoSettingsSchema } from "./uploadVideo";
import { viewSnapsSettingsDefault, viewSnapsSettingsSchema } from "./viewSnaps";
import { viewStoriesSettingsDefault, viewStoriesSettingsSchema } from "./viewStories";

export const snapchatToolsSettingsDefault = {
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

export const snapchatToolsSettingsSchema = z.object({
  shuffleToolOrder: shuffleToolOrderSchema,
  uploadSnap: uploadSnapSettingsSchema,
  uploadVideo: uploadVideoSettingsSchema,
  addFriends: addFriendsSettingsSchema,
  massSnap: massSnapSettingsSchema,
  acceptFriends: acceptFriendsSettingsSchema,
  replyUnreadChats: replyUnreadChatsSettingsSchema,
  viewStories: viewStoriesSettingsSchema,
  viewSnaps: viewSnapsSettingsSchema,
}).default(snapchatToolsSettingsDefault);

export type SnapchatToolSettings = z.infer<typeof snapchatToolsSettingsSchema>;

export {
  acceptFriendsSettingsSchema,
  addFriendsSettingsSchema,
  massSnapSettingsSchema,
  replyUnreadChatsSettingsSchema,
  shuffleToolOrderSchema,
  uploadSnapSettingsSchema,
  uploadVideoSettingsSchema,
  viewSnapsSettingsSchema,
  viewStoriesSettingsSchema,
};
