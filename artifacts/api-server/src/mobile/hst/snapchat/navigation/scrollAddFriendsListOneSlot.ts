import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { center, shortResourceId } from "../runtime";

export async function scrollAddFriendsListOneSlot(
  context: SnapchatContext,
  nodes: UiNode[],
  addedRow: UiNode,
  screenHeight: number,
  friendName: string,
  actionLabel = "adding",
): Promise<boolean> {
  const findFriendsTitle = nodes.find(node =>
    shortResourceId(node) === "section-title" &&
    [node.text, node.desc].some(value => /^find friends$/i.test(value.trim())),
  );
  const rowHeight = Math.round(addedRow.bounds[3] - addedRow.bounds[1]);
  if (!findFriendsTitle || rowHeight <= 0 || !Number.isFinite(screenHeight) || screenHeight <= 0) {
    context.onLog(`Add Friends: could not calculate a safe full-row scroll after ${actionLabel} ${friendName}.`);
    return false;
  }

  const listTop = findFriendsTitle.bounds[3];
  const safeBottom = Math.floor(screenHeight * 0.82);
  const safeTop = Math.ceil(screenHeight * 0.12);
  const targetCenterY = center(addedRow).y;
  const liveRows = nodes.filter(node =>
    shortResourceId(node) === "scu_search_friend_cell" &&
    node.bounds[2] > node.bounds[0] &&
    node.bounds[3] > node.bounds[1] &&
    node.bounds[3] > listTop &&
    node.bounds[1] < safeBottom,
  );
  const liveRow = liveRows
    .map(row => ({ row, distance: Math.abs(center(row).y - targetCenterY) }))
    .sort((a, b) => a.distance - b.distance)[0]?.row;
  if (!liveRow) {
    context.onLog(`Add Friends: no live Find Friends row is available to anchor a full-contact scroll after ${actionLabel} ${friendName}.`);
    return false;
  }
  const liveRowHeight = liveRow.bounds[3] - liveRow.bounds[1];
  const scrollDistance = rowHeight;
  const x = center(liveRow).x;
  const startY = Math.min(
    safeBottom - 6,
    Math.max(listTop + liveRowHeight + 8, liveRow.bounds[3] - 8),
  );
  const endY = startY - scrollDistance;
  if (endY < Math.max(listTop + 6, safeTop)) {
    context.onLog(`Add Friends: not enough visible list space to scroll one full ${rowHeight}px contact after ${actionLabel} ${friendName}.`);
    return false;
  }

  context.onLog(
    `Add Friends: scrolling past ${friendName} by one full ${scrollDistance}px contact row, ` +
    `using the live Find Friends node at (${x},${startY}) to (${x},${endY}).`,
  );
  await android.swipe(context.serial, x, startY, x, endY, 240, false);
  await context.sleep(250, "exact");
  return true;
}
