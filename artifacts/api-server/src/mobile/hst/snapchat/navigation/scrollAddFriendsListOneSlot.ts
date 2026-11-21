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
  extraScrollPixels = 10,
): Promise<boolean> {
  const findFriendsTitle = nodes.find(node =>
    shortResourceId(node) === "section-title" &&
    [node.text, node.desc].some(value => /^find friends$/i.test(value.trim())),
  );
  const rowHeight = addedRow.bounds[3] - addedRow.bounds[1];
  if (!findFriendsTitle || rowHeight <= 0 || !Number.isFinite(screenHeight) || screenHeight <= 0) {
    context.onLog(`Add Friends: could not calculate a safe short scroll after ${actionLabel} ${friendName}.`);
    return false;
  }
  const extraDistance = 8 + Math.max(0, Math.round(extraScrollPixels));
  const scrollDistance = Math.max(1, Math.round(rowHeight * 0.6) + extraDistance);

  const listTop = findFriendsTitle.bounds[3];
  const safeBottom = Math.floor(screenHeight * 0.82);
  const x = center(addedRow).x;
  const startY = Math.min(
    safeBottom - 6,
    Math.max(listTop + rowHeight + 8, addedRow.bounds[3] - 8),
  );
  const endY = startY - scrollDistance;
  if (endY < listTop + 6) {
    context.onLog(`Add Friends: not enough visible list space for a safe short scroll after ${actionLabel} ${friendName}.`);
    return false;
  }

  context.onLog(
    `Add Friends: scrolling the Find Friends list up 60% of one row height plus ${extraDistance} pixels after ${actionLabel} ${friendName} ` +
    `(from ${x},${startY} to ${x},${endY}); staying above Android's bottom navigation.`,
  );
  await android.swipe(context.serial, x, startY, x, endY, 240, false);
  await context.sleep(250, "exact");
  return true;
}
