import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import {
  ADD_FRIENDS_BANNER_RECHECK_MS,
  BANNER_RECHECK_MS,
  center,
  dump,
  nodeLabel,
  shortResourceId,
  tapNode,
} from "../runtime";

export function isAddFriendsPage(xml: string): boolean {
  return /add_friends_root/i.test(xml) &&
    /add_friends_title/i.test(xml) &&
    /find friends/i.test(xml);
}

export function hasSnapchatChatComposer(nodes: UiNode[]): boolean {
  return nodes.some(node =>
    /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId),
  );
}

export function findAddFriendsEntry(nodes: UiNode[]): UiNode | undefined {
  const byResource = nodes.find(node =>
    node.clickable && shortResourceId(node) === "neon_add_friend_button_container",
  );
  if (byResource) return byResource;

  const label = nodes.find(node => /^add\s+friends?$/i.test(nodeLabel(node)));
  if (!label) return undefined;
  if (label.clickable) return label;

  const point = center(label);
  const labelArea = (label.bounds[2] - label.bounds[0]) * (label.bounds[3] - label.bounds[1]);
  return nodes
    .filter(node => {
      if (!node.clickable) return false;
      const [left, top, right, bottom] = node.bounds;
      const area = (right - left) * (bottom - top);
      return point.x >= left && point.x <= right &&
        point.y >= top && point.y <= bottom &&
        area >= labelArea;
    })
    .sort((a, b) =>
      (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) -
      (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]),
    )[0] ?? label;
}

export function findAddFriendsBanner(
  nodes: UiNode[],
  target: UiNode,
  screenWidth: number,
  screenHeight: number,
): UiNode | undefined {
  const point = center(target);
  const targetWidth = target.bounds[2] - target.bounds[0];
  const targetHeight = target.bounds[3] - target.bounds[1];
  const targetArea = targetWidth * targetHeight;
  const screenArea = screenWidth * screenHeight;
  const incomingActivity = /\b(?:is|are)\s+typing\b|\btyping(?:\s*\.{1,3}|\s*…)?\b|\b(?:sent|sending|received|delivered)\s+(?:(?:you|me)\s+)?(?:(?:a|an)\s+)?(?:snap|chat|photo|video|message)\b|\bnew\s+(?:snap|chat|message)\b/i;
  const isLargeTopOverlay = (node: UiNode) => {
    const [left, top, right, bottom] = node.bounds;
    const width = right - left;
    const height = bottom - top;
    const area = width * height;
    return top <= screenHeight * 0.25 &&
      bottom <= screenHeight * 0.45 &&
      width >= screenWidth * 0.4 &&
      height >= Math.max(targetHeight * 1.4, 36) &&
      area >= targetArea * 2.5 &&
      area < screenArea * 0.5;
  };
  const coversPoint = (node: UiNode, x: number, y: number) =>
    x >= node.bounds[0] && x <= node.bounds[2] &&
    y >= node.bounds[1] && y <= node.bounds[3];
  const eventLabels = nodes.filter(node =>
    incomingActivity.test(`${node.text} ${node.desc}`) &&
    node.bounds[1] <= screenHeight * 0.35 &&
    node.bounds[3] <= screenHeight * 0.45,
  );

  return nodes.find(node => {
    if (node === target) return false;
    if (!coversPoint(node, point.x, point.y) || !isLargeTopOverlay(node)) return false;

    const identity = `${node.packageName} ${node.className} ${node.resourceId}`;
    const explicitBanner = /camera_sticky_toast|banner|snackbar|toast|heads.?up|notification/i.test(identity);
    const systemNotification = /com\.android\.systemui/i.test(node.packageName);
    const containsIncomingActivity = eventLabels.some(label => {
      const eventPoint = center(label);
      return coversPoint(node, eventPoint.x, eventPoint.y);
    });
    return explicitBanner || systemNotification || containsIncomingActivity;
  });
}

export async function openAddFriends(context: SnapchatContext): Promise<boolean> {
  let cameraWaitLogged = false;
  let controlChecks = 0;
  let bannerChecks = 0;
  let entryAttempts = 0;
  let chatKeyboardDismissAttempted = false;
  let chatExitAttempted = false;
  const { w: screenWidth, h: screenHeight } = await android.getScreenSizeAsync(context.serial);
  while (!context.isAborted()) {
    const state = await dump(context.serial);
    if (isAddFriendsPage(state.xml)) return true;

    if (hasSnapchatChatComposer(state.nodes)) {
      const keyboardShown = await android.isKeyboardShown(context.serial).catch(() => false);
      if (keyboardShown) {
        if (chatKeyboardDismissAttempted) {
          context.onLog("Snapchat stopped: the chat keyboard stayed open after one Back press; refusing to navigate from an unverified surface.");
          return false;
        }
        chatKeyboardDismissAttempted = true;
        context.onLog("Snapchat: dismissing the open chat keyboard before returning to Camera.");
        await android.keyevent(context.serial, 4);
        await context.sleep(300, "exact");
        continue;
      }

      if (chatExitAttempted) {
        context.onLog("Snapchat stopped: the active chat remained open after one Back press; refusing to continue on the wrong screen.");
        return false;
      }
      chatExitAttempted = true;
      context.onLog("Snapchat: leaving the verified open chat before returning to Camera.");
      await android.keyevent(context.serial, 4);
      await context.sleep(400, "exact");
      const afterBack = await dump(context.serial);
      if (hasSnapchatChatComposer(afterBack.nodes)) {
        context.onLog("Snapchat stopped: Android Back did not close the active chat.");
        return false;
      }
      chatKeyboardDismissAttempted = false;
      continue;
    }

    if (!/camera_page/i.test(state.xml)) {
      const cameraTab = state.nodes.find(node =>
        node.clickable && shortResourceId(node) === "ngs_camera_icon_container",
      );
      if (cameraTab) {
        cameraWaitLogged = false;
        if (!await tapNode(context, cameraTab, "return to Camera before retrying Add Friends")) return false;
      } else if (!cameraWaitLogged) {
        context.onLog("Add Friends: waiting for Snapchat's Camera tab to become available; will retry.");
        cameraWaitLogged = true;
      }
      await context.sleep(BANNER_RECHECK_MS, "exact");
      continue;
    }
    cameraWaitLogged = false;

    const entry = findAddFriendsEntry(state.nodes);
    if (!entry) {
      controlChecks++;
      if (controlChecks >= 10) {
        context.onLog("Add Friends: the live control was not exposed after 10 checks; skipping only this tool.");
        return false;
      }
      context.onLog(`Add Friends: live control not exposed (check ${controlChecks}/10); checking again in 5 seconds.`);
      await context.sleep(ADD_FRIENDS_BANNER_RECHECK_MS, "exact");
      continue;
    }
    controlChecks = 0;

    const bannerCheck = bannerChecks + 1;
    if (findAddFriendsBanner(state.nodes, entry, screenWidth, screenHeight)) {
      bannerChecks = bannerCheck;
      if (bannerChecks >= 10) {
        context.onLog("Add Friends: a banner still covers the control after 10 checks; skipping only this tool.");
        return false;
      }
      context.onLog(`Add Friends: banner covers the control (check ${bannerChecks}/10); checking again in 5 seconds.`);
      await context.sleep(ADD_FRIENDS_BANNER_RECHECK_MS, "exact");
      continue;
    }
    context.onLog(`Add Friends: banner check ${bannerCheck}/10 is clear; tapping the live control now.`);
    bannerChecks = 0;

    if (entryAttempts >= 3) {
      context.onLog("Add Friends: three live-control taps did not open the friend list; skipping only this tool.");
      return false;
    }
    entryAttempts++;
    if (!await tapNode(context, entry, "open Add Friends from its live accessibility bounds", 500)) return false;
  }
  return false;
}
