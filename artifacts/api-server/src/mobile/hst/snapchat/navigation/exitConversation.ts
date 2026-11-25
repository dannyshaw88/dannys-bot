import * as android from "../../../androidManager";
import type { SnapchatContext, UiState } from "../context";

export function hasNotAddedFriendNotice(state: UiState): boolean {
  const visibleText = state.nodes
    .map(node => `${node.text} ${node.desc}`)
    .join(" ")
    .replace(/\s+/g, " ");
  return /\bhas not added you as a friend\b/i.test(visibleText);
}

export async function exitSnapchatConversation(context: SnapchatContext): Promise<boolean> {
  context.onLog("Reply to Unread Chats: exiting with two Android Back presses, 500ms apart.");
  for (let press = 1; press <= 2; press++) {
    if (context.isAborted()) return false;
    try {
      await android.keyevent(context.serial, 4);
    } catch {
      context.onLog(`Snapchat: Android Back failed while exiting the conversation (press ${press}).`);
      return false;
    }
    if (press === 1) await context.sleep(500, "exact");
  }

  return true;
}
