import type { SnapchatContext } from "./context";
import { closeAddFriendsPanel } from "./navigation/closeAddFriendsPanel";
import { ensureSnapchatAccount } from "./navigation/ensureSnapchatAccount";
import { dismissSnapchatNotificationPermission } from "./navigation/dismissNotificationPermission";
import { returnToCameraBeforeNextTool } from "./navigation/returnToCamera";
import { runAcceptFriends } from "./tools/acceptFriends";
import { runAddFriends } from "./tools/addFriends";
import { runReplyUnreadChats } from "./tools/replyUnreadChats";
import { runUploadSnap, type UploadSnapResult } from "./tools/uploadSnap";
import { runUploadVideo, type UploadVideoResult } from "./tools/uploadVideo";
import { runViewSnaps } from "./tools/viewSnaps";
import { runViewSpotlights } from "./tools/viewSpotlights";
import { formatCooldownTime } from "./navigation/handleFriendRequestCooldown";

type SnapchatToolEntry = {
  name: string;
  settings: {
    enabled: boolean;
    activatePctMin: number;
    activatePctMax: number;
    directoryPath?: string;
  };
  run: () => Promise<void | UploadSnapResult | UploadVideoResult | boolean | "friend-request-cooldown" | "friend-request-cooldown-blocked">;
};

async function restoreCameraBeforeNextTool(
  context: SnapchatContext,
  toolName: string,
): Promise<boolean> {
  try {
    if (await returnToCameraBeforeNextTool(context)) return true;
  } catch (error) {
    context.onLog(
      `Snapchat: could not restore Camera after ${toolName} (${error instanceof Error ? error.message : String(error)}).`,
    );
    return false;
  }
  context.onLog(`Snapchat: remaining tools skipped because Camera could not be restored after ${toolName}.`);
  return false;
}

export async function runSnapchatTools(context: SnapchatContext): Promise<void> {
  if (!await dismissSnapchatNotificationPermission(context)) {
    if (!context.isAborted()) {
      context.onLog("Snapchat tool dispatcher skipped because its notification permission dialog was not dismissed.");
    }
    return;
  }

  if (!await ensureSnapchatAccount(context)) {
    context.onLog("Snapchat tool dispatcher skipped because the configured slot account was not confirmed.");
    return;
  }

  const toolList: SnapchatToolEntry[] = [
    { name: "Upload a Snap", settings: context.tools.uploadSnap, run: () => runUploadSnap(context) },
    { name: "Upload a Video", settings: context.tools.uploadVideo, run: () => runUploadVideo(context) },
    { name: "Add Friends", settings: context.tools.addFriends, run: () => runAddFriends(context) },
    { name: "Accept Friends", settings: context.tools.acceptFriends, run: () => runAcceptFriends(context) },
    { name: "Reply to Unread Chats", settings: context.tools.replyUnreadChats, run: () => runReplyUnreadChats(context) },
    { name: "View Spotlights", settings: context.tools.viewStories, run: () => runViewSpotlights(context) },
    { name: "View Snaps", settings: context.tools.viewSnaps, run: () => runViewSnaps(context) },
  ];

  let friendRequestCooldownTriggered = false;
  const getFriendRequestCooldownUntil = async () =>
    await context.getFriendRequestCooldownUntil?.().catch(() => null) ?? null;
  const initialFriendCooldownUntil = await getFriendRequestCooldownUntil();
  if (initialFriendCooldownUntil) {
    context.onLog(
      `Snapchat: Add Friends and Accept Friends are paused by the 3-hour cooldown until ${formatCooldownTime(initialFriendCooldownUntil)}.`,
    );
  }

  const orderedTools = toolList.filter(tool => {
    if (!tool.settings.enabled) return false;
    if (
      initialFriendCooldownUntil &&
      (tool.name === "Add Friends" || tool.name === "Accept Friends")
    ) return false;
    if (
      (tool.name === "Upload a Snap" || tool.name === "Upload a Video") &&
      !tool.settings.directoryPath?.trim()
    ) return false;
    const min = Math.max(0, Math.min(100, Math.round(tool.settings.activatePctMin)));
    const max = Math.max(0, Math.min(100, Math.round(tool.settings.activatePctMax)));
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    const chance = Math.round(low + Math.random() * (high - low));
    const activated = Math.random() * 100 < chance;
    context.onLog(`[Snapchat activation] ${tool.name}: ${activated ? "activated" : "skipped"} (${chance}%)`);
    return activated;
  });

  if (context.tools.shuffleToolOrder) {
    for (let index = orderedTools.length - 1; index > 0; index--) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [orderedTools[index], orderedTools[swapIndex]] = [orderedTools[swapIndex], orderedTools[index]];
    }
    context.onLog(`Snapchat tool order shuffled: ${orderedTools.length ? orderedTools.map(tool => tool.name).join(" → ") : "(no tools activated)"}`);
  }

  for (let index = 0; index < orderedTools.length; index++) {
    const tool = orderedTools[index];
    if (context.isAborted()) return;
    if (tool.name === "Add Friends" || tool.name === "Accept Friends") {
      if (friendRequestCooldownTriggered) {
        context.onLog(`Snapchat: ${tool.name} skipped because the 3-hour friend-request cooldown was triggered this cycle.`);
        continue;
      }
      const activeUntil = await getFriendRequestCooldownUntil();
      if (activeUntil) {
        context.onLog(
          `Snapchat: ${tool.name} skipped; the friend-request cooldown remains active until ${formatCooldownTime(activeUntil)}.`,
        );
        continue;
      }
    }
    let result: void | UploadSnapResult | UploadVideoResult | boolean | "friend-request-cooldown" | "friend-request-cooldown-blocked" = undefined;
    let failureReason: string | null = null;
    try {
      result = await tool.run();
    } catch (error) {
      failureReason = error instanceof Error ? error.message : String(error);
    }
    if (result === "friend-request-cooldown") {
      friendRequestCooldownTriggered = true;
    }
    if (result === "friend-request-cooldown-blocked") {
      context.onLog("Snapchat tools stopped because the friend-request limit dialog could not be safely cleared.");
      return;
    }
    if (result === "failed") {
      failureReason ??= "the tool reported a failure; see its preceding log entry for details";
    }
    if (failureReason) {
      context.onLog(`Snapchat: ${tool.name} failed (${failureReason}).`);
      if (context.isAborted()) return;
      if (index < orderedTools.length - 1 && !await restoreCameraBeforeNextTool(context, tool.name)) return;
      continue;
    }
    if (
      (tool.name === "Add Friends" || tool.name === "Accept Friends") &&
      result === true &&
      !context.isAborted()
    ) {
      let panelClosed = false;
      try {
        panelClosed = await closeAddFriendsPanel(context);
      } catch (error) {
        context.onLog(`Snapchat: could not close the completed friend list (${error instanceof Error ? error.message : String(error)}).`);
      }
      if (!panelClosed) {
        context.onLog(`Snapchat: trying to restore Camera after ${tool.name} finished.`);
        if (index < orderedTools.length - 1 && !await restoreCameraBeforeNextTool(context, tool.name)) return;
        continue;
      }
    }
    if (
      tool.name === "Reply to Unread Chats" &&
      index < orderedTools.length - 1 &&
      !context.isAborted()
    ) {
      if (!await returnToCameraBeforeNextTool(context)) return;
    }
    if (
      index < orderedTools.length - 1 &&
      (tool.name === "View Spotlights" || tool.name === "View Snaps")
    ) {
      if (context.isAborted()) return;
      if (!await returnToCameraBeforeNextTool(context)) return;
    }
  }
}
