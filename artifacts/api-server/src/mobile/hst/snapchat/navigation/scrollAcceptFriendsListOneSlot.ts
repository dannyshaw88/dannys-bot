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
    context.onLog(`Accept Friends: could not calculate a safe full-row scroll after accepting ${friendName}.`);
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
  const liveRows = addedMeNodes.filter(node =>
    shortResourceId(node) === "scu_search_friend_cell" &&
    node.bounds[2] > node.bounds[0] &&
    node.bounds[3] > node.bounds[1] &&
    node.bounds[3] > listTop &&
    node.bounds[1] < safeBottom,
  );
  const rowHeight = Math.round(acceptedRow.bounds[3] - acceptedRow.bounds[1]);
  if (rowHeight <= 0) {
    context.onLog(`Accept Friends: could not calculate a safe full-row scroll after accepting ${friendName}.`);
    return false;
  }

  const targetCenterY = center(acceptedRow).y;
  const gestureRow = liveRows
    .map(row => ({ row, distance: Math.abs(center(row).y - targetCenterY) }))
    .sort((a, b) => a.distance - b.distance)[0]?.row;
  if (!gestureRow) {
    context.onLog(`Accept Friends: no live Added Me row remains after ${friendName}; no extra scroll is needed.`);
    return true;
  }

  const liveRowHeight = gestureRow.bounds[3] - gestureRow.bounds[1];
  const scrollDistance = rowHeight;
  const safeTop = Math.ceil(screenHeight * 0.12);
  const x = center(gestureRow).x;
  const startY = Math.min(
    safeBottom - 6,
    Math.max(listTop + liveRowHeight + 8, gestureRow.bounds[3] - 8),
  );
  const endY = startY - scrollDistance;
  if (endY < Math.max(listTop + 6, safeTop)) {
    context.onLog(`Accept Friends: not enough visible list space to scroll one full ${rowHeight}px contact after ${friendName}.`);
    return false;
  }

  context.onLog(
    `Accept Friends: scrolling past ${friendName} by one full ${scrollDistance}px contact row, ` +
    `using the live Added Me node at (${x},${startY}) to (${x},${endY}).`,
  );
  await android.swipe(context.serial, x, startY, x, endY, 240, false);
  await context.sleep(250, "exact");
  return true;
}
