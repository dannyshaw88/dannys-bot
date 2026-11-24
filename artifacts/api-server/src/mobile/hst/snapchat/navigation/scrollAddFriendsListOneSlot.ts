import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { center, dump, shortResourceId } from "../runtime";

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

function normalizeContactName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff\ufe0e\ufe0f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function contactNameInRow(nodes: UiNode[], row: UiNode): string {
  const name = nodes.find(node =>
    shortResourceId(node) === "result-title" &&
    node.bounds[0] >= row.bounds[0] &&
    node.bounds[1] >= row.bounds[1] &&
    node.bounds[2] <= row.bounds[2] &&
    node.bounds[3] <= row.bounds[3],
  );
  return name?.text.trim() || name?.desc.trim() || "";
}

function findHorizontalDividerYs(
  screen: { width: number; height: number; channels: number; pixels: Buffer },
  rows: UiNode[],
): number[] {
  if (rows.length === 0 || screen.channels < 3) return [];
  const x1 = Math.max(0, Math.round(screen.width * 0.04), Math.min(...rows.map(row => row.bounds[0])) + 6);
  const x2 = Math.min(screen.width - 1, Math.round(screen.width * 0.96), Math.max(...rows.map(row => row.bounds[2])) - 6);
  if (x2 <= x1) return [];

  const scanTop = Math.max(0, Math.floor(rows[0].bounds[1] - 12));
  const scanBottom = Math.min(screen.height - 1, Math.ceil(rows[rows.length - 1].bounds[3] + 12));
  const samplesPerRow = Math.ceil((x2 - x1) / 2);
  const minimumNeutralPixels = Math.ceil(samplesPerRow * 0.45);
  const rawYs: number[] = [];

  for (let y = scanTop; y <= scanBottom; y++) {
    let neutralGrayPixels = 0;
    for (let x = x1; x <= x2; x += 2) {
      const index = (y * screen.width + x) * screen.channels;
      const r = screen.pixels[index];
      const g = screen.pixels[index + 1];
      const b = screen.pixels[index + 2];
      const luminance = (r + g + b) / 3;
      if (
        Math.max(r, g, b) - Math.min(r, g, b) <= 16 &&
        luminance >= 120 &&
        luminance <= 248
      ) neutralGrayPixels++;
    }
    if (neutralGrayPixels >= minimumNeutralPixels) rawYs.push(y);
  }

  const runs: number[][] = [];
  for (const y of rawYs) {
    const run = runs[runs.length - 1];
    if (!run || y - run[run.length - 1] > 2) runs.push([y]);
    else run.push(y);
  }
  return runs
    .filter(run => run.length <= 5)
    .map(run => Math.round(run.reduce((sum, y) => sum + y, 0) / run.length));
}

function measureContactDivider(
  rows: UiNode[],
  screen: { width: number; height: number; channels: number; pixels: Buffer },
  row: UiNode,
): { distance: number; upperY: number; lowerY: number; row: UiNode } | null {
  const dividerYs = findHorizontalDividerYs(screen, rows);
  if (dividerYs.length < 2) return null;
  const centerY = (row.bounds[1] + row.bounds[3]) / 2;
  const upperY = dividerYs.filter(y => y <= centerY).at(-1);
  const lowerY = dividerYs.find(y => y > centerY);
  if (upperY === undefined || lowerY === undefined) return null;
  const distance = lowerY - upperY;
  const lineMargin = Math.max(12, Math.round((row.bounds[3] - row.bounds[1]) * 0.15));
  if (
    distance < 20 ||
    distance > screen.height * 0.2 ||
    upperY < row.bounds[1] - lineMargin ||
    lowerY > row.bounds[3] + lineMargin
  ) return null;
  return { distance, upperY, lowerY, row };
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

function closestNamedRow(
  nodes: UiNode[],
  rows: UiNode[],
  name: string,
  referenceY: number,
): UiNode | undefined {
  const normalizedName = normalizeContactName(name);
  return rows
    .filter(row => normalizeContactName(contactNameInRow(nodes, row)) === normalizedName)
    .sort((a, b) =>
      Math.abs(center(a).y - referenceY) - Math.abs(center(b).y - referenceY),
    )[0];
}

export async function scrollAddFriendsListOneSlot(
  context: SnapchatContext,
  nodes: UiNode[],
  screenWidth: number,
  screenHeight: number,
  friendName: string,
  actionLabel = "adding",
  previousCenterY?: number,
): Promise<boolean> {
  const initialRows = findFriendsRows(nodes);
  const title = nodes.find(node =>
    shortResourceId(node) === "section-title" &&
    [node.text, node.desc].some(value => /^find friends$/i.test(value.trim())),
  );
  const safeTop = Math.ceil(screenHeight * 0.12);
  const safeBottom = Math.floor(screenHeight * 0.82);
  const listTop = title?.bounds[3] ?? 0;
  const visibleRows = initialRows.filter(row =>
    row.bounds[1] > Math.max(listTop, safeTop) &&
    row.bounds[3] < safeBottom,
  );
  if (!title || visibleRows.length === 0 || !Number.isFinite(screenWidth) || screenWidth <= 0 ||
      !Number.isFinite(screenHeight) || screenHeight <= 0) {
    context.onLog(`Add Friends: cannot identify a fully visible contact card after ${actionLabel} ${friendName}; no guessed swipe was sent.`);
    return false;
  }
  const normalizedFriendName = normalizeContactName(friendName);
  const matchingRows = visibleRows.filter(row =>
    normalizeContactName(contactNameInRow(nodes, row)) === normalizedFriendName,
  );
  const targetRow = matchingRows.length > 0
    ? [...matchingRows].sort((a, b) =>
      Math.abs(center(a).y - (previousCenterY ?? center(a).y)) -
      Math.abs(center(b).y - (previousCenterY ?? center(b).y)),
    )[0]
    : previousCenterY === undefined
      ? undefined
      : [...visibleRows].sort((a, b) =>
        Math.abs(center(a).y - previousCenterY) - Math.abs(center(b).y - previousCenterY),
      )[0];
  if (!targetRow) {
    context.onLog(`Add Friends: ${friendName}'s row is no longer visible after ${actionLabel}; no unrelated card was used for a guessed swipe.`);
    return false;
  }
  const targetNameStillVisible = matchingRows.includes(targetRow);
  const targetRowIndex = initialRows.indexOf(targetRow);
  const expectedNextRow = initialRows[targetRowIndex + 1];
  const expectedNextName = expectedNextRow ? contactNameInRow(nodes, expectedNextRow) : "";
  const expectedNextTop = visibleRows[0].bounds[1];
  if (!targetNameStillVisible) {
    context.onLog(
      `Add Friends: ${friendName}'s card changed or disappeared after ${actionLabel}; ` +
      `measuring the live card now occupying its previous position.`,
    );
  }
  const screenshot = await android.captureScreenPixels(context.serial);
  if (!screenshot || screenshot.width !== screenWidth || screenshot.height !== screenHeight) {
    context.onLog(
      `Add Friends: live screenshot pixels are unavailable or do not match ${screenWidth}×${screenHeight}; ` +
      `cannot measure the grey dividers after ${actionLabel} ${friendName}.`,
    );
    return false;
  }
  const measurement = measureContactDivider(initialRows, screenshot, targetRow);
  if (!measurement || measurement.distance <= 0) {
    context.onLog(
      `Add Friends: could not detect the upper and lower grey divider pixels around ${friendName}'s current card ` +
      `after ${actionLabel} ${friendName}; no guessed swipe was sent.`,
    );
    return false;
  }

  const targetDistance = Math.round(measurement.distance);
  const rowForAnchor = measurement.row;
  const swipeX = blankRowLaneX(nodes, rowForAnchor, screenWidth);
  if (swipeX === null) {
    context.onLog(`Add Friends: no blank horizontal lane is exposed beside the contact; refusing to swipe across a user.`);
    return false;
  }
  const anchorY = center(rowForAnchor).y;
  const fingerDelta = -targetDistance;
  const startY = Math.round(anchorY - fingerDelta / 2);
  const endY = startY + fingerDelta;
  if (
    startY < Math.max(listTop + 6, safeTop) ||
    endY < Math.max(listTop + 6, safeTop) ||
    startY > safeBottom ||
    endY > safeBottom
  ) {
    context.onLog(`Add Friends: exact measured swipe would cross Snapchat's screen bounds; no swipe was sent.`);
    return false;
  }
  if (context.isAborted()) return false;
  const measuredName = targetNameStillVisible ? friendName : contactNameInRow(nodes, targetRow) || "the replacement contact";
  context.onLog(
    `Add Friends: after ${actionLabel} ${friendName}, one screenshot measured ${measuredName}'s card at ` +
    `${measurement.distance.toFixed(1)}px between grey dividers y=${measurement.upperY} and y=${measurement.lowerY}; ` +
    `using exactly ${targetDistance}px for one swipe.`,
  );
  await android.swipe(context.serial, swipeX, startY, swipeX, endY, 650, false);
  await context.sleep(750, "exact");
  if (context.isAborted()) return false;

  if (!expectedNextName) {
    context.onLog(
      `Add Friends: the next contact after ${friendName} has no readable name; ` +
      `the measured swipe was sent, but its top alignment could not be checked.`,
    );
    return true;
  }

  const afterSwipeState = await dump(context.serial);
  const afterSwipeNodes = afterSwipeState.nodes;
  const nextRowAfterSwipe = closestNamedRow(
    afterSwipeNodes,
    findFriendsRows(afterSwipeNodes),
    expectedNextName,
    expectedNextRow.bounds[1],
  );
  if (!nextRowAfterSwipe) {
    context.onLog(
      `Add Friends: the measured swipe was sent, but ${expectedNextName} was not in the settled list dump; ` +
      `no guessed correction was sent.`,
    );
    return true;
  }

  const alignmentError = nextRowAfterSwipe.bounds[1] - expectedNextTop;
  if (Math.abs(alignmentError) <= 8) {
    context.onLog(
      `Add Friends: ${expectedNextName} is at the top contact position ` +
      `(y=${nextRowAfterSwipe.bounds[1]}, expected y=${expectedNextTop}).`,
    );
    return true;
  }

  const maxSafeCorrection = Math.max(targetDistance * 3, Math.round(screenHeight * 0.25));
  if (Math.abs(alignmentError) > maxSafeCorrection) {
    context.onLog(
      `Add Friends: ${expectedNextName} landed at y=${nextRowAfterSwipe.bounds[1]} instead of y=${expectedNextTop}; ` +
      `the ${Math.abs(alignmentError)}px mismatch exceeds the ${maxSafeCorrection}px correction limit, so no correction was sent.`,
    );
    return true;
  }

  const correctionX = blankRowLaneX(afterSwipeNodes, nextRowAfterSwipe, screenWidth);
  const correctionAnchorY = center(nextRowAfterSwipe).y;
  const correctionStartY = Math.round(correctionAnchorY + alignmentError / 2);
  const correctionEndY = Math.round(correctionAnchorY - alignmentError / 2);
  if (
    correctionX === null ||
    correctionStartY < Math.max(listTop + 6, safeTop) ||
    correctionEndY < Math.max(listTop + 6, safeTop) ||
    correctionStartY > safeBottom ||
    correctionEndY > safeBottom
  ) {
    context.onLog(
      `Add Friends: ${expectedNextName} landed at y=${nextRowAfterSwipe.bounds[1]} instead of y=${expectedNextTop}; ` +
      `no safe correction lane was available.`,
    );
    return true;
  }

  context.onLog(
    `Add Friends: ${expectedNextName} landed at y=${nextRowAfterSwipe.bounds[1]} instead of y=${expectedNextTop}; ` +
    `correcting the ${Math.abs(alignmentError)}px residual once.`,
  );
  await android.swipe(
    context.serial,
    correctionX,
    correctionStartY,
    correctionX,
    correctionEndY,
    450,
    false,
  );
  await context.sleep(750, "exact");
  if (context.isAborted()) return false;
  const afterCorrectionState = await dump(context.serial);
  const afterCorrectionNodes = afterCorrectionState.nodes;
  const alignedNextRow = closestNamedRow(
    afterCorrectionNodes,
    findFriendsRows(afterCorrectionNodes),
    expectedNextName,
    expectedNextTop,
  );
  if (alignedNextRow) {
    const finalError = alignedNextRow.bounds[1] - expectedNextTop;
    context.onLog(
      Math.abs(finalError) <= 8
        ? `Add Friends: alignment verified after one correction; ${expectedNextName} is at y=${alignedNextRow.bounds[1]}.`
        : `Add Friends: after one correction, ${expectedNextName} is still at y=${alignedNextRow.bounds[1]} ` +
          `(target y=${expectedNextTop}; residual ${finalError}px).`,
    );
  } else {
    context.onLog(
      `Add Friends: ${expectedNextName} was not in the final list dump after the single correction.`,
    );
  }
  return true;
}
