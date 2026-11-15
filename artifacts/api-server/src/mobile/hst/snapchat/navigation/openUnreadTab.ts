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

export type UnreadTabWaitResult =
  | { status: "ready"; state: UiState }
  | { status: "missing"; state: UiState }
  | { status: "retry-tool"; state: UiState }
  | { status: "stopped"; state: UiState }
  | { status: "aborted"; state: UiState };

export type UnreadTabFirstMissHandler = (
  state: UiState,
) => Promise<{
  action: "continue" | "retry-tool" | "stop";
  state: UiState;
}>;

export async function waitForUnreadTab(
  context: SnapchatContext,
  onFirstMiss?: UnreadTabFirstMissHandler,
): Promise<UnreadTabWaitResult> {
  const { h: screenHeight } = await android.getScreenSizeAsync(context.serial);
  const startedAt = Date.now();
  let waitLogged = false;
  let firstMissHandled = false;
  let tapFailureRecoveryAttempted = false;
  let state = await dump(context.serial);
  while (!context.isAborted()) {
    const unreadTab = findUnreadTab(state.nodes, screenHeight);
    if (unreadTab) {
      context.onLog("Reply to Unread Chats: Unread tab appeared; tapping it now.");
      if (!await tapNode(context, unreadTab, "open the Unread chat filter")) {
        if (onFirstMiss && !tapFailureRecoveryAttempted) {
          tapFailureRecoveryAttempted = true;
          const recovery = await onFirstMiss(state);
          if (recovery.action === "retry-tool") {
            return { status: "retry-tool", state: recovery.state };
          }
          if (recovery.action === "stop") {
            return { status: "stopped", state: recovery.state };
          }
          state = recovery.state;
          continue;
        }
        return { status: "stopped", state };
      }
      return { status: "ready", state: await dump(context.serial) };
    }
    if (!firstMissHandled && onFirstMiss) {
      firstMissHandled = true;
      const recovery = await onFirstMiss(state);
      if (recovery.action === "retry-tool") {
        return { status: "retry-tool", state: recovery.state };
      }
      if (recovery.action === "stop") {
        return { status: "stopped", state: recovery.state };
      }
      state = recovery.state;
      continue;
    }
    const remainingMs = 30_000 - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      context.onLog("Reply to Unread Chats stopped: Unread tab did not appear within 30 seconds.");
      return { status: "missing", state };
    }
    if (!waitLogged) {
      context.onLog("Reply to Unread Chats: waiting up to 30 seconds for Unread; checking every 5 seconds.");
      waitLogged = true;
    }
    await context.sleep(Math.min(5_000, remainingMs), "exact");
    state = await dump(context.serial);
  }
  return { status: "aborted", state };
}
