import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import {
  ADD_FRIENDS_BANNER_RECHECK_MS,
  center,
  dump,
  nodeLabel,
  shortResourceId,
  tapNode,
} from "../runtime";

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

async function openAddFriendsForAction(
  context: SnapchatContext,
  actionLabel: "Add" | "Accept",
  toolName: "Add Friends" | "Accept Friends",
): Promise<boolean> {
  let state = await dump(context.serial);
  if (hasSnapchatChatComposer(state.nodes)) {
    if (await android.isKeyboardShown(context.serial).catch(() => false)) {
      await android.keyevent(context.serial, 4);
      await context.sleep(300, "exact");
      state = await dump(context.serial);
    }
    if (hasSnapchatChatComposer(state.nodes)) {
      await android.keyevent(context.serial, 4);
      await context.sleep(400, "exact");
      state = await dump(context.serial);
    }
    if (hasSnapchatChatComposer(state.nodes)) return false;
  }

  const friendActionIsVisible = (nodes: UiNode[]) => nodes.some(node =>
    shortResourceId(node) === "scu_search_action_button" &&
    [node.text, node.desc].some(value => value.trim().toLowerCase() === actionLabel.toLowerCase()),
  );
  const friendRowIsVisible = (nodes: UiNode[]) =>
    nodes.some(node => shortResourceId(node) === "scu_search_friend_cell");
  if (friendActionIsVisible(state.nodes) || friendRowIsVisible(state.nodes)) return true;

  let entry = findAddFriendsEntry(state.nodes);
  if (!entry) return false;
  const { w: screenWidth, h: screenHeight } = await android.getScreenSizeAsync(context.serial);
  for (let check = 1; check <= 10; check++) {
    if (!findAddFriendsBanner(state.nodes, entry, screenWidth, screenHeight)) {
      context.onLog(`${toolName}: tapping the live entry control; proceeding without checking a page marker.`);
      if (!await tapNode(context, entry, "open Add Friends from its live accessibility bounds", 0)) return false;
      await context.sleep(3_000, "exact");
      return true;
    }
    if (check === 10) return false;
    await context.sleep(ADD_FRIENDS_BANNER_RECHECK_MS, "exact");
    state = await dump(context.serial);
    if (friendActionIsVisible(state.nodes) || friendRowIsVisible(state.nodes)) return true;
    entry = findAddFriendsEntry(state.nodes);
    if (!entry) return false;
  }
  return false;
}

/**
 * Navigate from Snapchat Camera when needed, then let each tool use its live
 * row-level Add or Accept controls without page/resource-marker confirmation.
 */
export function openAddFriendsForSuggestions(context: SnapchatContext): Promise<boolean> {
  return openAddFriendsForAction(context, "Add", "Add Friends");
}

export function openAddFriendsForAccepts(context: SnapchatContext): Promise<boolean> {
  return openAddFriendsForAction(context, "Accept", "Accept Friends");
}
