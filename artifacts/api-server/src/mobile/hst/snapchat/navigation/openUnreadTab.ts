import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode, UiState } from "../context";
import { dump, tapNode } from "../runtime";

export function findUnreadTab(nodes: UiNode[], screenHeight: number): UiNode | undefined {
  return nodes.find(node => {
    if (node.bounds[1] > screenHeight * 0.4) return false;
    const labelMatches = [node.text, node.desc].some(value =>
      /^unread(?:\s+messages?)?(?:\s*\(\d+\))?$/i.test(value.trim()),
    );
    const resourceMatches = /(?:^|[_-])unread(?:[_-].*)?(?:tab|filter)|(?:tab|filter).*unread/i
      .test(node.resourceId);
    return labelMatches || (node.clickable && resourceMatches);
  });
}

export async function waitForUnreadTab(context: SnapchatContext): Promise<UiState | null> {
  const { h: screenHeight } = await android.getScreenSizeAsync(context.serial);
  const startedAt = Date.now();
  let waitLogged = false;
  while (!context.isAborted()) {
    const state = await dump(context.serial);
    const unreadTab = findUnreadTab(state.nodes, screenHeight);
    if (unreadTab) {
      context.onLog("Reply to Unread Chats: Unread tab appeared; tapping it now.");
      if (!await tapNode(context, unreadTab, "open the Unread chat filter")) return null;
      return await dump(context.serial);
    }
    const remainingMs = 30_000 - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      context.onLog("Reply to Unread Chats stopped: Unread tab did not appear within 30 seconds.");
      return null;
    }
    if (!waitLogged) {
      context.onLog("Reply to Unread Chats: waiting up to 30 seconds for Unread; checking every 5 seconds.");
      waitLogged = true;
    }
    await context.sleep(Math.min(5_000, remainingMs), "exact");
  }
  return null;
}
