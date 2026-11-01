import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { center, shortResourceId } from "../runtime";

export async function scrollAcceptFriendsListOneSlot(
  context: SnapchatContext,
  nodes: UiNode[],
  acceptedRow: UiNode,
  screenHeight: number,
  friendName: string,
): Promise<boolean> {
  const addedMeTitle = nodes.find(node =>
    shortResourceId(node) === "section-title" &&
    [node.text, node.desc].some(value => /^added me$/i.test(value.trim())),
  );
  if (!addedMeTitle || !Number.isFinite(screenHeight) || screenHeight <= 0) {
    context.onLog(`Accept Friends: could not calculate a safe short scroll after accepting ${friendName}.`);
    return false;
  }

  const listTop = addedMeTitle.bounds[3];
  const safeBottom = Math.floor(screenHeight * 0.82);
  const addedMeStart = nodes.indexOf(addedMeTitle) + 1;
  const findFriendsStart = nodes.findIndex((node, index) =>
    index >= addedMeStart &&
    shortResourceId(node) === "section-title" &&
    [node.text, node.desc].some(value => /^find friends$/i.test(value.trim())),
  );
  const addedMeNodes = nodes.slice(addedMeStart, findFriendsStart < 0 ? nodes.length : findFriendsStart);
  const liveRow = addedMeNodes.find(node =>
    shortResourceId(node) === "scu_search_friend_cell" &&
    node.bounds[2] > node.bounds[0] &&
    node.bounds[3] > node.bounds[1] &&
    node.bounds[3] > listTop &&
    node.bounds[1] < safeBottom,
  );
  const gestureRow = liveRow ?? acceptedRow;
  const rowHeight = gestureRow.bounds[3] - gestureRow.bounds[1];
  if (rowHeight <= 0) {
    context.onLog(`Accept Friends: could not calculate a safe short scroll after accepting ${friendName}.`);
    return false;
  }

  const scrollDistance = Math.max(1, Math.round(rowHeight * 0.3));
  const x = center(gestureRow).x;
  const startY = Math.min(
    safeBottom - 6,
    Math.max(listTop + rowHeight + 8, gestureRow.bounds[3] - 8),
  );
  const endY = startY - scrollDistance;
  if (endY < listTop + 6) {
    context.onLog(`Accept Friends: not enough visible Added Me list space for a safe short scroll after ${friendName}.`);
    return false;
  }

  context.onLog(
    `Accept Friends: scrolling the Added Me list up 30% of one row height after accepting ${friendName} ` +
    `(from ${x},${startY} to ${x},${endY}); staying above Android's bottom navigation.`,
  );
  await android.swipe(context.serial, x, startY, x, endY, 240, false);
  await context.sleep(250, "exact");
  return true;
}
