import * as android from "../../../androidManager";
import type { SnapchatContext, UiState } from "../context";
import { exitSnapchatConversation } from "./exitConversation";
import { isSnapMediaViewer } from "./exitSnapViewer";
import { dump, exactClickable } from "../runtime";

export async function recoverFromUnreadSnapViewer(
  context: SnapchatContext,
  displayName: string,
  opened: UiState,
): Promise<{ detected: boolean; list?: UiState }> {
  if (!isSnapMediaViewer(opened.xml, opened.nodes)) return { detected: false };

  context.onLog(`Reply to Unread Chats: ${displayName}'s unread item opened a photo/video Snap; swiping down to close it.`);
  const { w, h } = await android.getScreenSizeAsync(context.serial);
  let state = opened;
  for (let attempt = 0; attempt < 2 && isSnapMediaViewer(state.xml, state.nodes); attempt++) {
    if (context.isAborted()) return { detected: true };
    await android.swipe(
      context.serial,
      Math.round(w * 0.5),
      Math.round(h * 0.35),
      Math.round(w * 0.5),
      Math.round(h * 0.85),
      300,
      false,
    );
    await context.sleep(500, "exact");
    state = await dump(context.serial);
    if (isSnapMediaViewer(state.xml, state.nodes) && attempt === 0) {
      context.onLog("Reply to Unread Chats: Snap viewer is still open; retrying the downward dismiss swipe.");
    }
  }
  if (isSnapMediaViewer(state.xml, state.nodes)) {
    context.onLog("Reply to Unread Chats stopped: Snapchat's photo/video viewer did not close after two downward swipes.");
    return { detected: true };
  }

  const returnedToConversation = state.nodes.some(node =>
    /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId),
  );
  if (returnedToConversation) {
    if (!await exitSnapchatConversation(context).catch(() => false)) {
      context.onLog(`Reply to Unread Chats stopped: could not exit ${displayName}'s conversation after closing the Snap.`);
      return { detected: true };
    }
    state = await dump(context.serial);
  }

  const returnedToChatList =
    Boolean(exactClickable(state.nodes, ["Chat"])) &&
    !state.nodes.some(node =>
      /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId),
    );
  if (!returnedToChatList) {
    context.onLog("Reply to Unread Chats stopped: the Snap closed, but Snapchat's chat list was not confirmed.");
    return { detected: true };
  }
  context.onLog(`Reply to Unread Chats: closed the received Snap, exited the conversation, and will continue on the Unread list.`);
  return { detected: true, list: await dump(context.serial) };
}
