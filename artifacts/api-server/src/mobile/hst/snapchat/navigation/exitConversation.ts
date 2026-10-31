import * as android from "../../../androidManager";
import type { SnapchatContext, UiState } from "../context";
import { dump, exactClickable } from "../runtime";

export function hasNotAddedFriendNotice(state: UiState): boolean {
  const visibleText = state.nodes
    .map(node => `${node.text} ${node.desc}`)
    .join(" ")
    .replace(/\s+/g, " ");
  return /\bhas not added you as a friend\b/i.test(visibleText);
}

export async function exitSnapchatConversation(context: SnapchatContext): Promise<boolean> {
  const hasComposer = (state: UiState) => state.nodes.some(node =>
    /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId),
  );
  const isChatTab = (state: UiState) => Boolean(exactClickable(state.nodes, ["Chat"]));

  let state = await dump(context.serial);
  if (!hasComposer(state) && !hasNotAddedFriendNotice(state)) {
    context.onLog("Reply to Unread Chats: refusing Android Back because the current surface is not a confirmed conversation.");
    return false;
  }

  context.onLog("Reply to Unread Chats: exiting the confirmed conversation one Android Back press at a time.");
  for (let press = 1; press <= 2; press++) {
    if (context.isAborted()) return false;
    try {
      await android.keyevent(context.serial, 4);
    } catch {
      context.onLog(`Snapchat: Android Back failed while exiting the conversation (press ${press}).`);
      return false;
    }
    await context.sleep(250, "exact");
    state = await dump(context.serial);

    const composerVisible = hasComposer(state);
    const chatTabVisible = isChatTab(state);
    if (chatTabVisible && !composerVisible) {
      context.onLog(`Reply to Unread Chats: conversation exit verified after ${press} Back press(es); chatTab=true, composer=false.`);
      return true;
    }
    if (!composerVisible && !hasNotAddedFriendNotice(state)) {
      context.onLog(`Reply to Unread Chats: stopped after ${press} Back press(es); the conversation closed without confirming the Chat tab, so no further Back was sent.`);
      return false;
    }
  }

  context.onLog("Reply to Unread Chats: the conversation was still open after two verified Back presses.");
  return false;
}
