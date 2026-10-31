import type { SnapchatContext } from "./context";
import { closeAddFriendsPanel } from "./navigation/closeAddFriendsPanel";
import { returnToCameraBeforeNextTool } from "./navigation/returnToCamera";
import { runAcceptFriends } from "./tools/acceptFriends";
import { runAddFriends } from "./tools/addFriends";
import { runReplyUnreadChats } from "./tools/replyUnreadChats";
import { runUploadSnap, type UploadSnapResult } from "./tools/uploadSnap";
import { runViewSnaps } from "./tools/viewSnaps";
import { runViewSpotlights } from "./tools/viewSpotlights";

type SnapchatToolEntry = {
  name: string;
  settings: {
    enabled: boolean;
    activatePctMin: number;
    activatePctMax: number;
    directoryPath?: string;
  };
  run: () => Promise<void | UploadSnapResult>;
};

export async function runSnapchatTools(context: SnapchatContext): Promise<boolean> {
  const toolList: SnapchatToolEntry[] = [
    { name: "Upload a Snap", settings: context.tools.uploadSnap, run: () => runUploadSnap(context) },
    { name: "Add Friends", settings: context.tools.addFriends, run: () => runAddFriends(context) },
    { name: "Accept Friends", settings: context.tools.acceptFriends, run: () => runAcceptFriends(context) },
    { name: "Reply to Unread Chats", settings: context.tools.replyUnreadChats, run: () => runReplyUnreadChats(context) },
    { name: "View Spotlights", settings: context.tools.viewStories, run: () => runViewSpotlights(context) },
    { name: "View Snaps", settings: context.tools.viewSnaps, run: () => runViewSnaps(context) },
  ];

  const orderedTools = toolList.filter(tool => {
    if (!tool.settings.enabled) return false;
    if (tool.name === "Upload a Snap" && !tool.settings.directoryPath?.trim()) return false;
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
    if (context.isAborted()) return false;
    let toolError: unknown;
    let toolFailed = false;
    let result: void | UploadSnapResult;
    try {
      result = await tool.run();
      if (tool.name === "Upload a Snap" && result !== "not-started" && result !== undefined) {
        return result === "selected";
      }
    } catch (error) {
      toolError = error;
      toolFailed = true;
    }
    if ((tool.name === "Add Friends" || tool.name === "Accept Friends") && !context.isAborted()) {
      if (!await closeAddFriendsPanel(context)) return false;
    }
    if (
      tool.name === "Reply to Unread Chats" &&
      !toolFailed &&
      index < orderedTools.length - 1 &&
      !context.isAborted()
    ) {
      if (!await returnToCameraBeforeNextTool(context)) return false;
    }
    if (toolFailed) throw toolError;
    if (
      index < orderedTools.length - 1 &&
      (tool.name === "View Spotlights" || tool.name === "View Snaps")
    ) {
      if (context.isAborted()) return false;
      if (!await returnToCameraBeforeNextTool(context)) return false;
    }
  }
  return false;
}
