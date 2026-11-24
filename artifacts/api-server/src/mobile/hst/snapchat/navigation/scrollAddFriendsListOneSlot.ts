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
  const samplesPerRow = Math.floor((x2 - x1) / 2) + 1;
  const minimumNeutralPixels = Math.max(12, Math.ceil(samplesPerRow * 0.28));
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
        Math.max(r, g, b) - Math.min(r, g, b) <= 22 &&
        luminance >= 40 &&
        luminance <= 255
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
  dividerYs = findHorizontalDividerYs(screen, rows),
): { distance: number; upperY: number; lowerY: number; row: UiNode } | null {
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

function blankRowLane(
  nodes: UiNode[],
  row: UiNode,
  screenWidth: number,
  minimumLaneWidth = 8,
): { x: number; leftWidth: number; rightWidth: number; fallback: boolean } {
  const children = nodes.filter(node => {
    const insideRow =
      node !== row &&
      node.bounds[0] >= row.bounds[0] &&
      node.bounds[1] >= row.bounds[1] &&
      node.bounds[2] <= row.bounds[2] &&
      node.bounds[3] <= row.bounds[3];
    if (!insideRow) return false;
    const spansWholeRow =
      node.bounds[0] <= row.bounds[0] + 4 &&
      node.bounds[2] >= row.bounds[2] - 4;
    const hasVisibleContent =
      Boolean(node.text.trim() || node.desc.trim()) ||
      /(?:TextView|EditText|ImageView|Button|SurfaceView|TextureView)/i.test(node.className) ||
      /(?:avatar|friend-cell-dismiss|result-title|add-button|camera-button)/i.test(node.resourceId);
    // UIAutomator may expose a full-row layout wrapper as clickable even though
    // it has no visible content. Use the visible child nodes to verify the
    // gutters; swiping the blank gutter is distinct from tapping that wrapper.
    if (spansWholeRow && !hasVisibleContent) return false;
    return true;
  });
  const edgePoint = (side: "left" | "right") => {
    const inset = Math.max(2, Math.round(screenWidth * 0.02));
    const point = side === "left" ? inset : screenWidth - inset;
    return Math.max(row.bounds[0] + 2, Math.min(row.bounds[2] - 2, point));
  };
  const isBlocked = (x: number) => children.some(node =>
    node.bounds[0] - 2 <= x && node.bounds[2] + 2 >= x,
  );
  if (screenWidth <= 0) {
    return { x: 0, leftWidth: 0, rightWidth: 0, fallback: true };
  }
  if (children.length === 0) {
    return {
      x: edgePoint("left"),
      leftWidth: 0,
      rightWidth: 0,
      fallback: true,
    };
  }

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
  const leftWidth = Math.max(0, lanes[0].max - lanes[0].min);
  const rightWidth = Math.max(0, lanes[1].max - lanes[1].min);
  const safeLane = lanes.find(lane => lane.max - lane.min >= minimumLaneWidth);
  if (!safeLane) {
    const widestLane = [...lanes]
      .filter(lane => lane.max > lane.min)
      .sort((left, right) => (right.max - right.min) - (left.max - left.min))[0];
    if (widestLane) {
      return {
        x: Math.round((widestLane.min + widestLane.max) / 2),
        leftWidth,
        rightWidth,
        fallback: true,
      };
    }
    const preferredSide = firstContentX - row.bounds[0] >= row.bounds[2] - lastContentX
      ? "left"
      : "right";
    const preferredPoint = edgePoint(preferredSide);
    const alternatePoint = edgePoint(preferredSide === "left" ? "right" : "left");
    return {
      x: !isBlocked(preferredPoint) ? preferredPoint : alternatePoint,
      leftWidth,
      rightWidth,
      fallback: true,
    };
  }
  return {
    x: Math.round((safeLane.min + safeLane.max) / 2),
    leftWidth,
    rightWidth,
    fallback: false,
  };
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
  const alignmentTolerance = Math.max(18, Math.round(screenHeight * 0.012));
  const minimumCorrectionTravel = Math.max(36, Math.round(screenHeight * 0.025));
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
  const hasMatchingScreenshot = screenshot &&
    screenshot.width === screenWidth &&
    screenshot.height === screenHeight;
  const dividerYs = hasMatchingScreenshot
    ? findHorizontalDividerYs(screenshot, initialRows)
    : [];
  const measurement = hasMatchingScreenshot
    ? measureContactDivider(initialRows, screenshot, targetRow, dividerYs)
    : null;
  const liveRowHeight = targetRow.bounds[3] - targetRow.bounds[1];
  const distanceBasis = measurement && measurement.distance > 0
    ? "grey-divider"
    : "live-row-bounds";
  const measuredDistance = distanceBasis === "grey-divider"
    ? measurement!.distance
    : liveRowHeight;
  if (!Number.isFinite(measuredDistance) || measuredDistance <= 0) {
    context.onLog(
      `Add Friends: ${friendName}'s live card bounds were not usable after ${actionLabel}; ` +
      `using the list's visible row height as the per-contact fallback.`,
    );
  }
  const targetDistance = Math.max(
    minimumCorrectionTravel,
    Math.round(Number.isFinite(measuredDistance) && measuredDistance > 0 ? measuredDistance : minimumCorrectionTravel),
  );
  if (distanceBasis !== "grey-divider") {
    context.onLog(
      `Add Friends: after ${actionLabel} ${friendName}, divider measurement was unavailable ` +
      `(candidates=${dividerYs.length}; card bounds=${targetRow.bounds.join(",")}; ` +
      `screenshot=${hasMatchingScreenshot ? "matched" : "unavailable"}); ` +
      `using this contact's live row height ${Math.max(0, liveRowHeight)}px, then scrolling ${targetDistance}px.`,
    );
  } else if (targetDistance !== Math.round(measuredDistance)) {
    context.onLog(
      `Add Friends: measured this contact's divider gap at ${Math.round(measuredDistance)}px; ` +
      `using ${targetDistance}px to keep the vertical drag above Android's contact-hold threshold.`,
    );
  }
  const rowForAnchor = measurement.row;
  const minimumLaneWidth = Math.max(24, Math.round(screenWidth * 0.025));
  const swipeLane = blankRowLane(
    nodes,
    rowForAnchor,
    screenWidth,
    minimumLaneWidth,
  );
  if (swipeLane.x === null) {
    context.onLog(
      `Add Friends: no blank horizontal lane is exposed beside the contact ` +
      `(row=${rowForAnchor.bounds.join(",")}, left=${swipeLane.leftWidth}px, ` +
      `right=${swipeLane.rightWidth}px, minimum=${minimumLaneWidth}px); refusing to swipe across a user.`,
    );
    return false;
  }
  const swipeX = swipeLane.x;
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
  await android.swipe(context.serial, swipeX, startY, swipeX, endY, 300, false);
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

  let currentNodes = afterSwipeNodes;
  let currentNextRow = nextRowAfterSwipe;
  let previousNextTop = expectedNextRow.bounds[1];
  let previousGestureDistance = targetDistance;
  const maxSafeCorrection = Math.max(targetDistance * 3, Math.round(screenHeight * 0.25));
  for (let attempt = 1; attempt <= 3; attempt++) {
    const alignmentError = currentNextRow.bounds[1] - expectedNextTop;
    if (Math.abs(alignmentError) <= alignmentTolerance) {
      context.onLog(
        `Add Friends: ${expectedNextName} reached the top contact position ` +
        `(y=${currentNextRow.bounds[1]}, expected y=${expectedNextTop}) after ${attempt - 1} correction(s).`,
      );
      return true;
    }

    const measuredContentMovement = previousNextTop - currentNextRow.bounds[1];
    const movementRatio = Math.abs(measuredContentMovement) > 8
      ? Math.abs(measuredContentMovement) / previousGestureDistance
      : 0.5;
    const requestedCorrectionDistance = Math.max(
      minimumCorrectionTravel,
      Math.round(Math.abs(alignmentError) / movementRatio),
    );
    const correctionDistance = Math.min(requestedCorrectionDistance, maxSafeCorrection);
    const correctionLane = blankRowLane(
      currentNodes,
      currentNextRow,
      screenWidth,
      minimumLaneWidth,
    );
    const correctionX = correctionLane.x;
    const correctionAnchorY = center(currentNextRow).y;
    const correctionFingerDelta = -Math.sign(alignmentError) * correctionDistance;
    const correctionStartY = Math.round(correctionAnchorY - correctionFingerDelta / 2);
    const correctionEndY = Math.round(correctionAnchorY + correctionFingerDelta / 2);
    if (
      correctionX === null ||
      correctionStartY < Math.max(listTop + 6, safeTop) ||
      correctionEndY < Math.max(listTop + 6, safeTop) ||
      correctionStartY > safeBottom ||
      correctionEndY > safeBottom
    ) {
      context.onLog(
        `Add Friends: ${expectedNextName} is still ${Math.abs(alignmentError)}px from the top position; ` +
        `no safe correction lane or swipe path was available ` +
        `(left=${correctionLane.leftWidth}px, right=${correctionLane.rightWidth}px, minimum=${minimumLaneWidth}px).`,
      );
      return true;
    }

    context.onLog(
      `Add Friends: the previous ${previousGestureDistance}px swipe moved content ${measuredContentMovement}px; ` +
      `sending correction ${attempt} of 3 for ${correctionDistance}px to move ${expectedNextName} to the top.`,
    );
    await android.swipe(
      context.serial,
      correctionX,
      correctionStartY,
      correctionX,
      correctionEndY,
      300,
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
    if (!alignedNextRow) {
      context.onLog(
        `Add Friends: ${expectedNextName} was not in the list after correction ${attempt}; ` +
        `no guessed swipe was sent.`,
      );
      return true;
    }
    previousNextTop = currentNextRow.bounds[1];
    previousGestureDistance = correctionDistance;
    currentNextRow = alignedNextRow;
    currentNodes = afterCorrectionNodes;
  }
  const finalError = currentNextRow.bounds[1] - expectedNextTop;
  context.onLog(
    Math.abs(finalError) <= 8
      ? `Add Friends: ${expectedNextName} reached the top contact position.`
      : `Add Friends: after three movement-scaled corrections, ${expectedNextName} is still at y=${currentNextRow.bounds[1]} ` +
        `(target y=${expectedNextTop}; residual ${finalError}px).`,
  );
  return true;
}

export async function alignFirstAddFriendsContactToTop(
  context: SnapchatContext,
  nodes: UiNode[],
  screenWidth: number,
  screenHeight: number,
  expectedTop: number,
  actionLabel: string,
): Promise<boolean> {
  const title = nodes.find(node =>
    shortResourceId(node) === "section-title" &&
    [node.text, node.desc].some(value => /^find friends$/i.test(value.trim())),
  );
  const safeTop = Math.ceil(screenHeight * 0.12);
  const safeBottom = Math.floor(screenHeight * 0.82);
  const listTop = title?.bounds[3] ?? 0;
  const alignmentTolerance = Math.max(18, Math.round(screenHeight * 0.012));
  const minimumSwipeTravel = Math.max(36, Math.round(screenHeight * 0.025));
  const getFirstVisibleNamedRow = (currentNodes: UiNode[]) =>
    findFriendsRows(currentNodes).find(row =>
      row.bounds[1] > Math.max(listTop, safeTop) &&
      row.bounds[3] < safeBottom &&
      !!contactNameInRow(currentNodes, row),
    );

  let currentNodes = nodes;
  let currentRow = getFirstVisibleNamedRow(currentNodes);
  if (!title || !currentRow || !Number.isFinite(expectedTop)) {
    context.onLog(
      `Add Friends: after ${actionLabel}, no live named contact row was available to align; no swipe was sent.`,
    );
    return false;
  }
  const nextName = contactNameInRow(currentNodes, currentRow);
  let previousTop = currentRow.bounds[1];
  let previousGestureDistance = Math.abs(previousTop - expectedTop);
  if (previousGestureDistance <= alignmentTolerance) {
    context.onLog(
      `Add Friends: after ${actionLabel}, ${nextName} is already at the previous contact's top position ` +
      `(y=${previousTop}, expected y=${expectedTop}); no swipe was sent.`,
    );
    return true;
  }

  const maxSafeDistance = Math.max(minimumSwipeTravel, Math.round(screenHeight * 0.25));
  const minimumBlankLaneWidth = Math.max(24, Math.round(screenWidth * 0.025));
  for (let swipeNumber = 0; swipeNumber <= 3; swipeNumber++) {
    const alignmentError = currentRow.bounds[1] - expectedTop;
    if (Math.abs(alignmentError) <= alignmentTolerance) {
      context.onLog(
        `Add Friends: after ${actionLabel}, ${nextName} reached the previous contact's top position ` +
        `(y=${currentRow.bounds[1]}, expected y=${expectedTop}) after ${swipeNumber} correction(s).`,
      );
      return true;
    }

    const swipeLane = blankRowLane(currentNodes, currentRow, screenWidth, minimumBlankLaneWidth);
    const swipeX = swipeLane.x;
    const measuredMovement = previousTop - currentRow.bounds[1];
    const movementRatio = Math.abs(measuredMovement) > 8
      ? Math.abs(measuredMovement) / previousGestureDistance
      : 0.5;
    const requestedDistance = swipeNumber === 0
      ? Math.max(Math.abs(alignmentError), minimumSwipeTravel)
      : Math.max(minimumSwipeTravel, Math.round(Math.abs(alignmentError) / movementRatio));
    const maxCorrectionDistance = Math.max(maxSafeDistance, previousGestureDistance * 3);
    const distance = Math.min(requestedDistance, swipeNumber === 0 ? maxSafeDistance : maxCorrectionDistance);
    const fingerDelta = -Math.sign(alignmentError) * distance;
    const anchorY = center(currentRow).y;
    const startY = Math.round(anchorY - fingerDelta / 2);
    const endY = Math.round(anchorY + fingerDelta / 2);
    if (
      swipeX === null ||
      startY < Math.max(listTop + 6, safeTop) ||
      endY < Math.max(listTop + 6, safeTop) ||
      startY > safeBottom ||
      endY > safeBottom
    ) {
      context.onLog(
        `Add Friends: after ${actionLabel}, ${nextName} is ${Math.abs(alignmentError)}px from the top position, ` +
        `but no sufficiently wide blank-lane swipe was available ` +
        `(left=${swipeLane.leftWidth}px, right=${swipeLane.rightWidth}px, minimum=${minimumBlankLaneWidth}px); ` +
        `no contact was touched.`,
      );
      return false;
    }
    if (context.isAborted()) return false;

    const gestureLabel = swipeNumber === 0
      ? "initial alignment swipe"
      : `movement-scaled correction ${swipeNumber} of 3`;
    context.onLog(
      `Add Friends: after ${actionLabel}, ${gestureLabel} for ${nextName}: ` +
      `${distance}px in blank lane x=${swipeX}, y=${startY}→${endY}; ` +
      `row top=${currentRow.bounds[1]}, target=${expectedTop}.`,
    );
    await android.swipe(context.serial, swipeX, startY, swipeX, endY, 300, false);
    previousTop = currentRow.bounds[1];
    previousGestureDistance = distance;
    await context.sleep(750, "exact");
    if (context.isAborted()) return false;
    const afterSwipeState = await dump(context.serial);
    currentNodes = afterSwipeState.nodes;
    const refreshedRow = closestNamedRow(
      currentNodes,
      findFriendsRows(currentNodes),
      nextName,
      expectedTop,
    );
    if (!refreshedRow) {
      context.onLog(
        `Add Friends: ${nextName} was not present after the dismissal alignment swipe; no further swipe was sent.`,
      );
      return false;
    }
    currentRow = refreshedRow;
  }

  const residual = currentRow.bounds[1] - expectedTop;
  context.onLog(
    `Add Friends: after ${actionLabel}, ${nextName} is at y=${currentRow.bounds[1]} ` +
    `(target y=${expectedTop}; residual ${residual}px) after three corrections.`,
  );
  return Math.abs(residual) <= alignmentTolerance;
}
