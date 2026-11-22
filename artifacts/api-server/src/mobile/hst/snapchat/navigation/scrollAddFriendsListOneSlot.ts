import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { center, dump, shortResourceId } from "../runtime";

type ContactMark = { key: string; top: number };

const scrollGainByDevice = new Map<string, number>();

function findFriendsRows(nodes: UiNode[]): UiNode[] {
  const titleIndex = nodes.findIndex(node =>
    shortResourceId(node) === "section-title" &&
    [node.text, node.desc].some(value => /^find friends$/i.test(value.trim())),
  );
  if (titleIndex < 0) return [];
  const nextSectionIndex = nodes.findIndex((node, index) =>
    index > titleIndex &&
    shortResourceId(node) === "section-title",
  );
  const sectionNodes = nodes.slice(titleIndex + 1, nextSectionIndex < 0 ? nodes.length : nextSectionIndex);
  return sectionNodes
    .filter(node =>
      shortResourceId(node) === "scu_search_friend_cell" &&
      node.bounds[2] > node.bounds[0] &&
      node.bounds[3] > node.bounds[1],
    )
    .sort((a, b) => a.bounds[1] - b.bounds[1]);
}

function contactMarks(nodes: UiNode[], rows: UiNode[]): ContactMark[] {
  return rows.flatMap(row => {
    const label = nodes.find(node =>
      shortResourceId(node) === "result-title" &&
      node.bounds[0] >= row.bounds[0] &&
      node.bounds[1] >= row.bounds[1] &&
      node.bounds[2] <= row.bounds[2] &&
      node.bounds[3] <= row.bounds[3],
    );
    const key = (label?.text || label?.desc || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
    return key ? [{ key, top: row.bounds[1] }] : [];
  });
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function middleContactDividerDistance(rows: UiNode[]): number | null {
  if (rows.length < 3) return null;
  // UIAutomator does not expose the grey divider as a separate node. For each
  // interior contact, its cell top/bottom are the divider edges; ignore the
  // first and last rows because their edges may be clipped by the app viewport.
  const middleRows = rows.slice(1, -1);
  return median(middleRows
    .map(row => row.bounds[3] - row.bounds[1])
    .filter(distance => distance > 0));
}

function measuredContentShift(before: ContactMark[], after: ContactMark[], screenHeight: number): number | null {
  const deltas: number[] = [];
  for (const mark of before) {
    const matches = after.filter(candidate => candidate.key === mark.key);
    if (matches.length === 0) continue;
    const nearest = matches.reduce((best, candidate) =>
      Math.abs(candidate.top - mark.top) < Math.abs(best.top - mark.top) ? candidate : best,
    );
    const delta = mark.top - nearest.top;
    if (Math.abs(delta) <= screenHeight * 0.45) deltas.push(delta);
  }
  return median(deltas);
}

function blankRowLaneX(nodes: UiNode[], row: UiNode, screenWidth: number): number | null {
  const children = nodes.filter(node =>
    node !== row &&
    node.bounds[0] >= row.bounds[0] &&
    node.bounds[1] >= row.bounds[1] &&
    node.bounds[2] <= row.bounds[2] &&
    node.bounds[3] <= row.bounds[3],
  );
  if (children.length === 0 || screenWidth <= 0) return null;

  const firstContentX = Math.min(...children.map(node => node.bounds[0]));
  const lastContentX = Math.max(...children.map(node => node.bounds[2]));
  const inset = Math.round(screenWidth * 0.04);
  const lanes = [
    {
      min: Math.max(row.bounds[0] + 4, inset + 4),
      max: Math.min(firstContentX - 4, screenWidth - inset - 4),
    },
    {
      min: Math.max(lastContentX + 4, inset + 4),
      max: Math.min(row.bounds[2] - 4, screenWidth - inset - 4),
    },
  ];
  const safeLane = lanes.find(lane => lane.max - lane.min >= 8);
  if (!safeLane) return null;
  return Math.round((safeLane.min + safeLane.max) / 2);
}

export async function scrollAddFriendsListOneSlot(
  context: SnapchatContext,
  nodes: UiNode[],
  screenWidth: number,
  screenHeight: number,
  friendName: string,
  actionLabel = "adding",
): Promise<boolean> {
  const initialRows = findFriendsRows(nodes);
  const title = nodes.find(node =>
    shortResourceId(node) === "section-title" &&
    [node.text, node.desc].some(value => /^find friends$/i.test(value.trim())),
  );
  const safeTop = Math.ceil(screenHeight * 0.12);
  const safeBottom = Math.floor(screenHeight * 0.82);
  const listTop = title?.bounds[3] ?? 0;
  const middleRows = initialRows.filter(row =>
    row.bounds[1] > Math.max(listTop, safeTop) &&
    row.bounds[3] < safeBottom,
  );
  const targetPitch = middleContactDividerDistance(middleRows);
  if (!title || !targetPitch || targetPitch <= 0 || !Number.isFinite(screenHeight) || screenHeight <= 0) {
    context.onLog(`Add Friends: cannot measure the middle-row divider spacing after ${actionLabel} ${friendName}; no guessed swipe was sent.`);
    return false;
  }

  const tolerance = Math.max(4, Math.round(targetPitch * 0.025));
  const maxGesture = Math.max(12, Math.floor(targetPitch * 0.48));
  let currentNodes = nodes;
  let currentRows = initialRows;
  let totalContentShift = 0;
  let gain = scrollGainByDevice.get(context.serial);
  let noProgressSteps = 0;
  const initialMarks = contactMarks(currentNodes, currentRows);
  if (initialMarks.length < 2) {
    context.onLog(`Add Friends: cannot measure the list movement after ${actionLabel} ${friendName}; contact labels are not exposed.`);
    return false;
  }

  context.onLog(
    `Add Friends: middle contacts show ${targetPitch.toFixed(1)}px between row dividers ` +
    `(measured from ${initialRows.length} live rows); calibrating actual scroll movement on this device.`,
  );

  for (let step = 1; step <= 8; step++) {
    if (context.isAborted()) return false;
    const remaining = targetPitch - totalContentShift;
    if (Math.abs(remaining) <= tolerance) {
      if (gain && Number.isFinite(gain)) scrollGainByDevice.set(context.serial, gain);
      context.onLog(
        `Add Friends: passed ${friendName} by ${totalContentShift.toFixed(1)}px of ` +
        `${targetPitch.toFixed(1)}px row spacing (within ${tolerance}px); device scroll ratio ${gain?.toFixed(2) ?? "measured"}.`,
      );
      return true;
    }

    const contentDirection = Math.sign(remaining);
    const estimatedGesture = gain && gain > 0
      ? Math.abs(remaining) / gain
      : targetPitch * 0.2;
    const gestureDistance = Math.max(8, Math.min(maxGesture, Math.round(estimatedGesture)));
    const rowForAnchor = currentRows
      .filter(row => row.bounds[1] > Math.max(listTop, safeTop) && row.bounds[3] < safeBottom)
      .sort((a, b) => Math.abs(center(a).y - (listTop + safeBottom) / 2) - Math.abs(center(b).y - (listTop + safeBottom) / 2))[0];
    if (!rowForAnchor) {
      context.onLog(`Add Friends: no middle contact is safely inside the list bounds for the measured swipe.`);
      return false;
    }
    const swipeX = blankRowLaneX(currentNodes, rowForAnchor, screenWidth);
    if (swipeX === null) {
      context.onLog(`Add Friends: no blank horizontal lane is exposed beside the contact; refusing to swipe across a user.`);
      return false;
    }

    const anchorY = center(rowForAnchor).y;
    const fingerDelta = -contentDirection * gestureDistance;
    const startY = Math.round(anchorY - fingerDelta / 2);
    const endY = startY + fingerDelta;
    if (
      startY < Math.max(listTop + 6, safeTop) ||
      endY < Math.max(listTop + 6, safeTop) ||
      startY > safeBottom ||
      endY > safeBottom
    ) {
      context.onLog(`Add Friends: measured swipe would cross Snapchat's screen bounds; stopping without guessing.`);
      return false;
    }

    context.onLog(
      `Add Friends: swipe ${step} in blank row margin x=${swipeX}, y=${startY}→${endY}; ` +
      `target divider distance ${targetPitch.toFixed(1)}px.`,
    );
    await android.swipe(context.serial, swipeX, startY, swipeX, endY, 650, false);
    await context.sleep(220, "exact");
    const after = await dump(context.serial);
    const afterRows = findFriendsRows(after.nodes);
    const actualShift = measuredContentShift(
      contactMarks(currentNodes, currentRows),
      contactMarks(after.nodes, afterRows),
      screenHeight,
    );
    if (actualShift === null) {
      context.onLog(`Add Friends: could not measure the list's actual movement after swipe ${step}; stopping rather than guessing.`);
      return false;
    }

    if (Math.abs(actualShift) < 1) {
      noProgressSteps++;
      context.onLog(`Add Friends: swipe ${step} moved the list ${actualShift.toFixed(1)}px; no content movement was measured.`);
      if (noProgressSteps >= 2) return false;
      gain = undefined;
      scrollGainByDevice.delete(context.serial);
      currentNodes = after.nodes;
      currentRows = afterRows;
      continue;
    }
    noProgressSteps = 0;
    if (actualShift * contentDirection <= 0) {
      context.onLog(`Add Friends: swipe ${step} moved content in the wrong direction (${actualShift.toFixed(1)}px); stopping.`);
      return false;
    }
    const observedGain = actualShift / -fingerDelta;
    if (observedGain > 0 && Number.isFinite(observedGain)) {
      gain = observedGain;
      scrollGainByDevice.set(context.serial, gain);
    }
    totalContentShift += actualShift;
    currentNodes = after.nodes;
    currentRows = afterRows;
    context.onLog(
      `Add Friends: swipe ${step} finger path ${gestureDistance}px moved the contact list ` +
      `${actualShift.toFixed(1)}px in blank lane x=${swipeX}; cumulative ${totalContentShift.toFixed(1)}/${targetPitch.toFixed(1)}px, ` +
      `remaining ${(targetPitch - totalContentShift).toFixed(1)}px; measured device ratio ${gain?.toFixed(2) ?? "unavailable"}.`,
    );
  }

  const finalDifference = targetPitch - totalContentShift;
  if (Math.abs(finalDifference) <= tolerance) {
    if (gain && Number.isFinite(gain)) scrollGainByDevice.set(context.serial, gain);
    return true;
  }
  context.onLog(
    `Add Friends: could not stop at one divider interval after eight measured swipes ` +
    `(difference ${finalDifference.toFixed(1)}px); continuing only with currently visible candidates.`,
  );
  return false;
}
