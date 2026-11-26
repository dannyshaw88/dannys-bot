import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode, UiState } from "../context";
import { center, dump, shortResourceId } from "../runtime";

export type AddFriendsScrollReplayIO = {
  dump: (serial: string) => Promise<UiState>;
  swipe: (
    serial: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs?: number,
    applyLegacyJitter?: boolean,
  ) => Promise<void>;
};

const realReplayIO: AddFriendsScrollReplayIO = {
  dump,
  swipe: android.swipe,
};

const observedForwardScrollRatioBySerial = new Map<string, number>();
const observedForwardSwipeMsPerPixelBySerial = new Map<string, number>();

function forwardScrollRatio(serial: string): number {
  return observedForwardScrollRatioBySerial.get(serial) ?? 1;
}

function calibratedForwardDistance(serial: string, desiredContentTravel: number): number {
  const knownRatio = observedForwardScrollRatioBySerial.get(serial);
  return Math.round(desiredContentTravel / (knownRatio ?? 1));
}

function calibratedForwardSwipeDuration(serial: string, fingerTravel: number): number {
  const knownDurationPerPixel = observedForwardSwipeMsPerPixelBySerial.get(serial);
  if (!knownDurationPerPixel) {
    return Math.max(300, Math.min(5000, Math.round(fingerTravel * 2.8)));
  }
  return Math.max(300, Math.min(5000, Math.round(fingerTravel * knownDurationPerPixel)));
}

function recordForwardScrollRatio(
  serial: string,
  rowTopBefore: number,
  rowTopAfter: number,
  fingerTravel: number,
): void {
  const contentTravel = rowTopBefore - rowTopAfter;
  if (contentTravel <= 8 || fingerTravel <= 0) return;
  observedForwardScrollRatioBySerial.set(
    serial,
    Math.max(0.2, Math.min(3, contentTravel / fingerTravel)),
  );
}

function recordForwardSwipePace(serial: string, fingerTravel: number, durationMs: number): void {
  if (fingerTravel <= 0 || durationMs <= 0) return;
  observedForwardSwipeMsPerPixelBySerial.set(
    serial,
    Math.max(0.1, Math.min(20, durationMs / fingerTravel)),
  );
}

export function findFriendsRows(nodes: UiNode[]): UiNode[] {
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

/** Move the first recommendation into the same screen position it will occupy below its heading. */
export async function revealAddFriendsSuggestions(
  context: SnapchatContext,
  nodes: UiNode[],
  screenWidth: number,
  screenHeight: number,
  replayIO: AddFriendsScrollReplayIO = realReplayIO,
): Promise<UiNode[]> {
  const heading = (source: UiNode[], label: RegExp) => source.find(node =>
    shortResourceId(node) === "section-title" &&
    [node.text, node.desc].some(value => label.test(value.trim())),
  );
  const incoming = heading(nodes, /^added me$/i);
  const suggestions = heading(nodes, /^find friends$/i);
  if (!incoming || !suggestions || incoming.bounds[1] >= suggestions.bounds[1]) return nodes;

  const firstSuggestion = findFriendsRows(nodes).find(row =>
    row.bounds[3] > suggestions.bounds[3] &&
    row.bounds[1] < screenHeight * 0.85,
  );
  const anchorName = firstSuggestion && contactNameInRow(nodes, firstSuggestion);
  if (!firstSuggestion || !anchorName ||
      !Number.isFinite(screenWidth) || screenWidth <= 0 ||
      !Number.isFinite(screenHeight) || screenHeight <= 0) {
    context.onLog("Add Friends: could not identify the first Find friends contact; no section scroll was sent.");
    return [];
  }

  // Keep the contact's offset under its heading and align that live row with
  // the Added Me heading's starting position. Sticky headings alone are not a
  // reliable signal that the list content has settled.
  const destination = incoming.bounds[1] + firstSuggestion.bounds[1] - suggestions.bounds[1];
  const tolerance = Math.max(24, Math.round(screenHeight * 0.012));
  const minimumTravel = Math.max(36, Math.round(screenHeight * 0.025));
  const minimumGestureY = Math.ceil(screenHeight * 0.12);
  const maximumGestureY = Math.floor(screenHeight * 0.82);
  const maximumTravel = maximumGestureY - minimumGestureY;
  if (maximumTravel < minimumTravel) {
    context.onLog(`Add Friends: no safe swipe lane can reach the first Find friends contact ${anchorName}; no contact action was sent.`);
    return [];
  }
  let current = nodes;
  for (let attempt = 0; attempt < 4 && !context.isAborted(); attempt++) {
    const row = findFriendsRows(current).find(candidate =>
      normalizeContactName(contactNameInRow(current, candidate)) === normalizeContactName(anchorName),
    );
    if (!row) {
      context.onLog(`Add Friends: first Find friends contact ${anchorName} disappeared during section positioning; no contact action was sent.`);
      return [];
    }
    const alignmentError = row.bounds[1] - destination;
    if (Math.abs(alignmentError) <= tolerance) {
      context.onLog(`Add Friends: first Find friends contact ${anchorName} reached its starting position (y=${row.bounds[1]}, target=${destination}).`);
      return current;
    }
    if (alignmentError < -tolerance) {
      context.onLog(`Add Friends: first Find friends contact ${anchorName} overshot its target by ${Math.abs(alignmentError)}px; refusing a backward swipe.`);
      return [];
    }

    const observedRatio = observedForwardScrollRatioBySerial.get(context.serial);
    const requestedDistance = observedRatio
      ? Math.round(alignmentError / observedRatio)
      : Math.max(minimumTravel, Math.round(alignmentError * 0.43));
    if (requestedDistance < minimumTravel) {
      context.onLog(`Add Friends: ${anchorName} needs only ${requestedDistance}px more travel, below the safe swipe threshold; no section scroll was sent.`);
      return [];
    }
    const distance = Math.min(requestedDistance, maximumTravel);
    const lane = blankRowLane(current, row, screenWidth, Math.max(8, Math.round(screenWidth * 0.01)));
    const gesture = fitVerticalGesture(
      center(row).y,
      -distance,
      minimumGestureY,
      maximumGestureY,
    );
    const durationMs = calibratedForwardSwipeDuration(context.serial, gesture.distance);
    const previousTop = row.bounds[1];
    context.onLog(
      `Add Friends: positioning first Find friends contact ${anchorName} ` +
      `(row y=${previousTop}, target=${destination}, swipe=${gesture.distance}px/${durationMs}ms` +
      `${observedRatio ? `, learned movement ratio=${observedRatio.toFixed(2)}` : ", initial calibration swipe"}).`,
    );
    await replayIO.swipe(context.serial, lane.x, gesture.startY, lane.x, gesture.endY, durationMs, false);
    await context.sleep(750, "exact");
    current = (await replayIO.dump(context.serial)).nodes;
    const movedAnchor = findFriendsRows(current).find(candidate =>
      normalizeContactName(contactNameInRow(current, candidate)) === normalizeContactName(anchorName),
    );
    if (!movedAnchor) {
      context.onLog(`Add Friends: first Find friends contact ${anchorName} was no longer exposed after the positioning swipe; no contact action was sent.`);
      return [];
    }
    const measuredContentMovement = previousTop - movedAnchor.bounds[1];
    recordForwardScrollRatio(context.serial, previousTop, movedAnchor.bounds[1], gesture.distance);
    if (measuredContentMovement > 8) {
      recordForwardSwipePace(context.serial, gesture.distance, durationMs);
    }
    context.onLog(
      `Add Friends: ${anchorName} moved ${Math.round(measuredContentMovement)}px ` +
      `for ${gesture.distance}px finger travel; next target residual=${Math.round(movedAnchor.bounds[1] - destination)}px` +
      `${observedForwardScrollRatioBySerial.has(context.serial)
        ? `, learned movement ratio=${observedForwardScrollRatioBySerial.get(context.serial)!.toFixed(2)}`
        : ", movement ratio not yet reliable"}.`,
    );
  }
  context.onLog(`Add Friends: first Find friends contact ${anchorName} did not reach its starting position after four measured swipes; no contact action was sent.`);
  return [];
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

function closestVisibleRow(
  rows: UiNode[],
  referenceY: number,
  listTop: number,
  safeTop: number,
  safeBottom: number,
): UiNode | undefined {
  return rows
    .filter(row =>
      row.bounds[1] > Math.max(listTop, safeTop) &&
      row.bounds[3] < safeBottom,
    )
    .sort((a, b) =>
      Math.abs(center(a).y - referenceY) - Math.abs(center(b).y - referenceY),
    )[0];
}

function fitVerticalGesture(
  anchorY: number,
  fingerDelta: number,
  minimumY: number,
  maximumY: number,
): { startY: number; endY: number; distance: number } {
  const lower = Math.max(1, Math.min(minimumY, maximumY - 1));
  const upper = Math.max(lower + 1, maximumY);
  const requestedDistance = Math.max(1, Math.round(Math.abs(fingerDelta)));
  const distance = Math.min(requestedDistance, upper - lower);
  const midpoint = Math.max(
    lower + distance / 2,
    Math.min(upper - distance / 2, anchorY),
  );
  const delta = Math.sign(fingerDelta || -1) * distance;
  return {
    startY: Math.round(midpoint - delta / 2),
    endY: Math.round(midpoint + delta / 2),
    distance,
  };
}

export async function scrollAddFriendsListOneSlot(
  context: SnapchatContext,
  nodes: UiNode[],
  screenWidth: number,
  screenHeight: number,
  friendName: string,
  actionLabel = "adding",
  replayIO: AddFriendsScrollReplayIO = realReplayIO,
  expectedNextContactName?: string,
  expectedTargetTop?: number,
): Promise<boolean> {
  let activeNodes = nodes;
  let initialRows = findFriendsRows(activeNodes);
  let title = activeNodes.find(node =>
    shortResourceId(node) === "section-title" &&
    [node.text, node.desc].some(value => /^find friends$/i.test(value.trim())),
  );
  const safeTop = Math.ceil(screenHeight * 0.12);
  const safeBottom = Math.floor(screenHeight * 0.82);
  let listTop = title?.bounds[3] ?? 0;
  const alignmentTolerance = Math.max(18, Math.round(screenHeight * 0.012));
  const minimumCorrectionTravel = Math.max(36, Math.round(screenHeight * 0.025));
  let visibleRows = initialRows.filter(row =>
    row.bounds[1] > Math.max(listTop, safeTop) &&
    row.bounds[3] < safeBottom,
  );
  if (!Number.isFinite(screenWidth) || screenWidth <= 0 ||
      !Number.isFinite(screenHeight) || screenHeight <= 0) {
    context.onLog(`Add Friends: invalid screen dimensions after ${actionLabel}; scroll could not be dispatched.`);
    return false;
  }
  for (let refresh = 0; refresh < 3 && (!title || visibleRows.length === 0); refresh++) {
    if (context.isAborted()) return false;
    await context.sleep(350, "exact");
    activeNodes = (await replayIO.dump(context.serial)).nodes;
    initialRows = findFriendsRows(activeNodes);
    title = activeNodes.find(node =>
      shortResourceId(node) === "section-title" &&
      [node.text, node.desc].some(value => /^find friends$/i.test(value.trim())),
    );
    listTop = title?.bounds[3] ?? 0;
    visibleRows = initialRows.filter(row =>
      row.bounds[1] > Math.max(listTop, safeTop) &&
      row.bounds[3] < safeBottom,
    );
  }
  if (!title || visibleRows.length === 0) {
    context.onLog(
      `Add Friends: list rows stayed unavailable after three refreshes following ${actionLabel} ${friendName}; ` +
      `refusing an unverified fallback scroll.`,
    );
    return false;
  }
  const normalizedFriendName = normalizeContactName(friendName);
  const matchingRows = visibleRows.filter(row =>
    normalizeContactName(contactNameInRow(activeNodes, row)) === normalizedFriendName,
  );
  const targetRow = matchingRows[0];
  const targetRowIndex = targetRow ? initialRows.indexOf(targetRow) : -1;
  const followingRow = targetRowIndex >= 0 ? initialRows[targetRowIndex + 1] : undefined;
  const expectedNextName = expectedNextContactName?.trim() ||
    (followingRow ? contactNameInRow(activeNodes, followingRow) : "");
  const expectedNextRow = expectedNextName
    ? initialRows.find(row =>
      normalizeContactName(contactNameInRow(activeNodes, row)) === normalizeContactName(expectedNextName),
    )
    : undefined;
  if (!expectedNextName || !expectedNextRow) {
    context.onLog(
      `Add Friends: could not verify the next contact after ${friendName} ${actionLabel}; ` +
      `refusing to guess from the row container height.`,
    );
    return false;
  }
  const expectedNextTop = Number.isFinite(expectedTargetTop)
    ? expectedTargetTop!
    : visibleRows[0].bounds[1];
  const preSwipeAlignmentError = expectedNextRow.bounds[1] - expectedNextTop;
  if (Math.abs(preSwipeAlignmentError) <= alignmentTolerance) {
    context.onLog(
      `Add Friends: after ${actionLabel} ${friendName}, ${expectedNextName} is already at the prior top position ` +
      `(y=${expectedNextRow.bounds[1]}, target=${expectedNextTop}); no scroll needed.`,
    );
    return true;
  }
  if (preSwipeAlignmentError < -alignmentTolerance) {
    context.onLog(
      `Add Friends: after ${actionLabel} ${friendName}, ${expectedNextName} is already ` +
      `${Math.abs(preSwipeAlignmentError)}px above the prior top position; refusing a backward swipe.`,
    );
    return false;
  }
  const targetDistance = Math.round(preSwipeAlignmentError);
  const swipeDistance = calibratedForwardDistance(context.serial, targetDistance);
  if (swipeDistance < minimumCorrectionTravel) {
    context.onLog(
      `Add Friends: after ${actionLabel} ${friendName}, ${expectedNextName} needs a ` +
      `${swipeDistance}px move, below the safe minimum; no swipe sent.`,
    );
    return false;
  }
  const minimumLaneWidth = Math.max(8, Math.round(screenWidth * 0.01));
  const swipeLane = blankRowLane(
    activeNodes,
    expectedNextRow,
    screenWidth,
    minimumLaneWidth,
  );
  if (swipeLane.fallback) {
    context.onLog(
      `Add Friends: using this row's widest available side gutter ` +
      `(x=${swipeLane.x}, left=${swipeLane.leftWidth}px, right=${swipeLane.rightWidth}px, ` +
      `minimum=${minimumLaneWidth}px).`,
    );
  }
  const swipeX = swipeLane.x;
  const anchorY = center(expectedNextRow).y;
  const gesture = fitVerticalGesture(
    anchorY,
    -swipeDistance,
    Math.max(listTop + 6, safeTop),
    safeBottom,
  );
  const { startY, endY } = gesture;
  const durationMs = calibratedForwardSwipeDuration(context.serial, gesture.distance);
  if (context.isAborted()) return false;
  context.onLog(
    `Add Friends: after ${actionLabel} ${friendName}, moving ${expectedNextName} ` +
      `${Math.round(preSwipeAlignmentError)}px to the prior contact's top ` +
    `(row top=${expectedNextRow.bounds[1]}, target=${expectedNextTop}); ` +
    `sending ${gesture.distance}px/${durationMs}ms in blank lane x=${swipeX}.`,
  );
  await replayIO.swipe(context.serial, swipeX, startY, swipeX, endY, durationMs, false);
  recordForwardSwipePace(context.serial, gesture.distance, durationMs);
  await context.sleep(750, "exact");
  if (context.isAborted()) return false;

  let afterSwipeNodes = (await replayIO.dump(context.serial)).nodes;
  let afterSwipeRows = findFriendsRows(afterSwipeNodes);
  let nextRowAfterSwipe = closestNamedRow(
    afterSwipeNodes,
    afterSwipeRows,
    expectedNextName,
    expectedNextTop,
  );
  if (!nextRowAfterSwipe) {
    context.onLog(
      `Add Friends: ${expectedNextName} was not exposed after the swipe; refusing to act on another row.`,
    );
    await context.sleep(500, "exact");
    afterSwipeNodes = (await replayIO.dump(context.serial)).nodes;
    afterSwipeRows = findFriendsRows(afterSwipeNodes);
    nextRowAfterSwipe = closestNamedRow(
      afterSwipeNodes,
      afterSwipeRows,
      expectedNextName,
      expectedNextTop,
    );
  }

  let currentNodes = afterSwipeNodes;
  let currentNextRow = nextRowAfterSwipe;
  if (!currentNextRow) return false;
  let currentNextName = expectedNextName;
  let previousNextTop = expectedNextRow.bounds[1];
  let previousGestureDistance = gesture.distance;
  const maxSafeCorrection = Math.max(targetDistance * 3, Math.round(screenHeight * 0.25));
  if (expectedNextName && contactNameInRow(currentNodes, currentNextRow) === expectedNextName) {
    recordForwardScrollRatio(
      context.serial,
      previousNextTop,
      currentNextRow.bounds[1],
      gesture.distance,
    );
  }
  const initialAlignmentError = currentNextRow.bounds[1] - expectedNextTop;
  if (initialAlignmentError < -alignmentTolerance) {
    context.onLog(
      `Add Friends: ${currentNextName} overshot the top by ${Math.abs(initialAlignmentError)}px; ` +
      `refusing a backward swipe.`,
    );
    return false;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const alignmentError = currentNextRow.bounds[1] - expectedNextTop;
    if (Math.abs(alignmentError) <= alignmentTolerance) {
      context.onLog(
        `Add Friends: ${currentNextName} reached the top contact position ` +
        `(y=${currentNextRow.bounds[1]}, expected y=${expectedNextTop}) after ${attempt - 1} correction(s).`,
      );
      return true;
    }
    if (alignmentError < -alignmentTolerance) {
      context.onLog(
        `Add Friends: ${currentNextName} overshot the top by ${Math.abs(alignmentError)}px; ` +
        `refusing a backward correction.`,
      );
      return false;
    }

    const measuredContentMovement = previousNextTop - currentNextRow.bounds[1];
    const movementRatio = measuredContentMovement > 8
      ? measuredContentMovement / previousGestureDistance
      : forwardScrollRatio(context.serial);
    const requestedCorrectionDistance = Math.round(alignmentError / movementRatio);
    if (requestedCorrectionDistance < minimumCorrectionTravel) {
      context.onLog(
        `Add Friends: ${currentNextName} is close to the top but needs a ` +
        `${requestedCorrectionDistance}px correction; refusing a short or backward swipe.`,
      );
      return false;
    }
    const correctionDistance = Math.min(requestedCorrectionDistance, maxSafeCorrection);
    const correctionLane = blankRowLane(
      currentNodes,
      currentNextRow,
      screenWidth,
      minimumLaneWidth,
    );
    const correctionX = correctionLane.x;
    if (correctionLane.fallback) {
      context.onLog(
        `Add Friends: using the widest available side gutter for alignment ` +
        `(x=${correctionX}, left=${correctionLane.leftWidth}px, right=${correctionLane.rightWidth}px).`,
      );
    }
    const correctionAnchorY = center(currentNextRow).y;
    const correctionFingerDelta = -correctionDistance;
    const correctionGesture = fitVerticalGesture(
      correctionAnchorY,
      correctionFingerDelta,
      Math.max(listTop + 6, safeTop),
      safeBottom,
    );
    const { startY: correctionStartY, endY: correctionEndY } = correctionGesture;
    const correctionDurationMs = calibratedForwardSwipeDuration(
      context.serial,
      correctionGesture.distance,
    );

    context.onLog(
      `Add Friends: the previous ${previousGestureDistance}px swipe moved content ${measuredContentMovement}px; ` +
      `sending correction ${attempt} of 3 for ${correctionGesture.distance}px/${correctionDurationMs}ms ` +
      `to move ${currentNextName} to the top.`,
    );
    await replayIO.swipe(
      context.serial,
      correctionX,
      correctionStartY,
      correctionX,
      correctionEndY,
      correctionDurationMs,
      false,
    );
    recordForwardSwipePace(context.serial, correctionGesture.distance, correctionDurationMs);
    await context.sleep(750, "exact");
    if (context.isAborted()) return false;
    const afterCorrectionState = await replayIO.dump(context.serial);
    const afterCorrectionNodes = afterCorrectionState.nodes;
    const correctedRows = findFriendsRows(afterCorrectionNodes);
    const alignedNextRow = closestNamedRow(
      afterCorrectionNodes,
      correctedRows,
      expectedNextName,
      expectedNextTop,
    );
    if (!alignedNextRow) {
      context.onLog(
        `Add Friends: ${expectedNextName} disappeared during correction; refusing to substitute another contact.`,
      );
      return false;
    }
    if (expectedNextName && contactNameInRow(afterCorrectionNodes, alignedNextRow) === expectedNextName) {
      recordForwardScrollRatio(
        context.serial,
        currentNextRow.bounds[1],
        alignedNextRow.bounds[1],
        correctionGesture.distance,
      );
    }
    previousNextTop = currentNextRow.bounds[1];
    previousGestureDistance = correctionGesture.distance;
    currentNextRow = alignedNextRow;
    currentNodes = afterCorrectionNodes;
    currentNextName = expectedNextName;
  }
  const finalError = currentNextRow.bounds[1] - expectedNextTop;
  context.onLog(
    Math.abs(finalError) <= 8
      ? `Add Friends: ${currentNextName} reached the top contact position.`
      : `Add Friends: ${currentNextName} is still at y=${currentNextRow.bounds[1]} ` +
        `(target y=${expectedNextTop}; residual ${finalError}px); no backward swipe was sent.`,
  );
  return Math.abs(finalError) <= alignmentTolerance;
}

export async function alignAddFriendsContactToTop(
  context: SnapchatContext,
  nodes: UiNode[],
  screenWidth: number,
  screenHeight: number,
  friendName: string,
  replayIO: AddFriendsScrollReplayIO = realReplayIO,
): Promise<boolean> {
  const safeTop = Math.ceil(screenHeight * 0.12);
  const safeBottom = Math.floor(screenHeight * 0.82);
  const minimumTravel = Math.max(36, Math.round(screenHeight * 0.025));
  const tolerance = Math.max(18, Math.round(screenHeight * 0.012));
  const maximumTravel = Math.max(minimumTravel, Math.round(screenHeight * 0.25));
  let currentNodes = nodes;
  const title = currentNodes.find(node =>
    shortResourceId(node) === "section-title" &&
    [node.text, node.desc].some(value => /^find friends$/i.test(value.trim())),
  );
  if (!title) {
    context.onLog(`Add Friends: Find friends heading was not exposed before acting on ${friendName}.`);
    return false;
  }
  const listTop = title.bounds[3];
  const findRows = (sourceNodes: UiNode[]) => {
    const rows = findFriendsRows(sourceNodes);
    const target = rows
      .filter(row =>
        normalizeContactName(contactNameInRow(sourceNodes, row)) === normalizeContactName(friendName) &&
        row.bounds[3] > Math.max(listTop, safeTop) &&
        row.bounds[1] < screenHeight * 0.85,
      )
      .sort((a, b) => a.bounds[1] - b.bounds[1])[0];
    const firstVisible = rows
      .filter(row =>
        row.bounds[1] > Math.max(listTop, safeTop) &&
        row.bounds[3] < safeBottom,
      )
      .sort((a, b) => a.bounds[1] - b.bounds[1])[0];
    return { target, firstVisible };
  };
  let { target, firstVisible } = findRows(currentNodes);
  if (!target || !firstVisible) {
    context.onLog(`Add Friends: could not locate ${friendName} and the first visible card before its action.`);
    return false;
  }
  const targetTop = firstVisible.bounds[1];
  let previousTargetTop = target.bounds[1];
  let previousGestureDistance = 0;
  const minimumLaneWidth = Math.max(8, Math.round(screenWidth * 0.01));

  for (let attempt = 0; attempt <= 3; attempt++) {
    const alignmentError = target.bounds[1] - targetTop;
    if (Math.abs(alignmentError) <= tolerance) {
      context.onLog(
        `Add Friends: ${friendName} is at the first contact position before its action ` +
        `(y=${target.bounds[1]}, target y=${targetTop}).`,
      );
      return true;
    }
    if (alignmentError < -tolerance) {
      context.onLog(
        `Add Friends: ${friendName} is already ${Math.abs(alignmentError)}px above the first contact position; ` +
        `refusing a backward swipe.`,
      );
      return false;
    }
    const observedMovement = previousTargetTop - target.bounds[1];
    const movementRatio = previousGestureDistance > 0 && observedMovement > 8
      ? observedMovement / previousGestureDistance
      : forwardScrollRatio(context.serial);
    const requestedTravel = Math.round(alignmentError / movementRatio);
    const isFirstUncalibratedSwipe =
      attempt === 0 && observedForwardScrollRatioBySerial.get(context.serial) === undefined;
    const gestureDistance = Math.min(
      isFirstUncalibratedSwipe ? Math.round(requestedTravel * 0.65) : requestedTravel,
      maximumTravel,
    );
    if (gestureDistance < minimumTravel) {
      context.onLog(
        `Add Friends: ${friendName} is close to the first position but needs a ${gestureDistance}px correction; ` +
        `refusing a short or backward swipe.`,
      );
      return false;
    }
    const lane = blankRowLane(currentNodes, target, screenWidth, minimumLaneWidth);
    const fingerDelta = -gestureDistance;
    const gesture = fitVerticalGesture(
      center(target).y,
      fingerDelta,
      Math.max(listTop + 6, safeTop),
      safeBottom,
    );
    const durationMs = calibratedForwardSwipeDuration(context.serial, gesture.distance);
    context.onLog(
      `Add Friends: positioning ${friendName} at the first contact position before its action ` +
      `(row y=${target.bounds[1]}, target y=${targetTop}, swipe ${gesture.distance}px/${durationMs}ms at x=${lane.x}, ` +
      `y=${gesture.startY}→${gesture.endY}).`,
    );
    if (context.isAborted()) return false;
    await replayIO.swipe(
      context.serial,
      lane.x,
      gesture.startY,
      lane.x,
      gesture.endY,
      durationMs,
      false,
    );
    recordForwardSwipePace(context.serial, gesture.distance, durationMs);
    previousTargetTop = target.bounds[1];
    previousGestureDistance = gesture.distance;
    await context.sleep(750, "exact");
    if (context.isAborted()) return false;
    currentNodes = (await replayIO.dump(context.serial)).nodes;
    ({ target, firstVisible } = findRows(currentNodes));
    if (!target || !firstVisible) {
      context.onLog(`Add Friends: ${friendName} was not exposed after its positioning swipe.`);
      return false;
    }
    recordForwardScrollRatio(
      context.serial,
      previousTargetTop,
      target.bounds[1],
      gesture.distance,
    );
  }

  context.onLog(
    `Add Friends: ${friendName} did not reach the first contact position after three positioning corrections; ` +
    `the action was not sent.`,
  );
  return false;
}

export async function alignFirstAddFriendsContactToTop(
  context: SnapchatContext,
  nodes: UiNode[],
  screenWidth: number,
  screenHeight: number,
  expectedTop: number,
  actionLabel: string,
  previousRowHeight?: number,
  replayIO: AddFriendsScrollReplayIO = realReplayIO,
): Promise<boolean> {
  const title = nodes.find(node =>
    shortResourceId(node) === "section-title" &&
    [node.text, node.desc].some(value => /^find friends$/i.test(value.trim())),
  );
  const safeTop = Math.ceil(screenHeight * 0.12);
  const safeBottom = Math.floor(screenHeight * 0.82);
  const listTop = title?.bounds[3] ?? 0;
  const minimumSwipeTravel = Math.max(36, Math.round(screenHeight * 0.025));
  const alignmentTolerance = Math.max(18, Math.round(screenHeight * 0.012));
  const getFirstVisibleNamedRow = (currentNodes: UiNode[]) =>
    closestVisibleRow(
      // A dismissed feedback card retains scu_search_friend_cell, but has
      // feedback-title instead of result-title. It must be scrolled past, not
      // mistaken for the next contact already sitting at the expected top.
      findFriendsRows(currentNodes).filter(row => Boolean(contactNameInRow(currentNodes, row))),
      expectedTop,
      listTop,
      safeTop,
      safeBottom,
    );

  let currentNodes = nodes;
  let currentRow = getFirstVisibleNamedRow(currentNodes);
  if (!title || !currentRow || !Number.isFinite(expectedTop)) {
    const fallbackHeight = Number.isFinite(previousRowHeight) && previousRowHeight! > 0
      ? Math.round(previousRowHeight!)
      : minimumSwipeTravel;
    const fallbackTop = Number.isFinite(expectedTop) ? expectedTop : safeTop;
    const fallbackX = Math.max(2, Math.min(screenWidth - 2, Math.round(screenWidth * 0.02)));
    const gesture = fitVerticalGesture(
      fallbackTop + fallbackHeight / 2,
      -Math.max(fallbackHeight, minimumSwipeTravel),
      safeTop,
      safeBottom,
    );
    context.onLog(
      `Add Friends: after ${actionLabel}, the live row was not exposed; ` +
      `sending a fallback scroll using the prior contact's ${fallbackHeight}px row height at x=${fallbackX}.`,
    );
    if (context.isAborted()) return false;
    await replayIO.swipe(context.serial, fallbackX, gesture.startY, fallbackX, gesture.endY, 300, false);
    await context.sleep(750, "exact");
    return true;
  }
  const nextName = contactNameInRow(currentNodes, currentRow) || "next visible contact";
  let previousTop = currentRow.bounds[1];
  let previousGestureDistance = Math.abs(previousTop - expectedTop);
  if (previousGestureDistance <= alignmentTolerance) {
    context.onLog(
      `Add Friends: after ${actionLabel}, ${nextName} is already at the previous contact's top position ` +
      `(y=${previousTop}, expected y=${expectedTop}); no extra swipe was needed.`,
    );
    return true;
  }

  const maxSafeDistance = Math.max(minimumSwipeTravel, Math.round(screenHeight * 0.25));
  const minimumBlankLaneWidth = Math.max(8, Math.round(screenWidth * 0.01));
  for (let swipeNumber = 0; swipeNumber <= 3; swipeNumber++) {
    const alignmentError = currentRow.bounds[1] - expectedTop;
    if (Math.abs(alignmentError) <= alignmentTolerance) {
      context.onLog(
        `Add Friends: after ${actionLabel}, ${nextName} reached the previous contact's top position ` +
        `(y=${currentRow.bounds[1]}, expected y=${expectedTop}) after ${swipeNumber} correction(s).`,
      );
      return true;
    }
    if (alignmentError < -alignmentTolerance) {
      context.onLog(
        `Add Friends: after ${actionLabel}, ${nextName} is already ${Math.abs(alignmentError)}px above ` +
        `the target; refusing a backward swipe.`,
      );
      return false;
    }

    const swipeLane = blankRowLane(currentNodes, currentRow, screenWidth, minimumBlankLaneWidth);
    const swipeX = swipeLane.x;
    if (swipeLane.fallback) {
      context.onLog(
        `Add Friends: after ${actionLabel}, using the widest available side gutter ` +
        `(x=${swipeX}, left=${swipeLane.leftWidth}px, right=${swipeLane.rightWidth}px).`,
      );
    }
    const measuredMovement = previousTop - currentRow.bounds[1];
    const movementRatio = previousGestureDistance > 0 && measuredMovement > 8
      ? measuredMovement / previousGestureDistance
      : forwardScrollRatio(context.serial);
    const requestedDistance = Math.round(alignmentError / movementRatio);
    if (requestedDistance < minimumSwipeTravel) {
      context.onLog(
        `Add Friends: after ${actionLabel}, ${nextName} is close to the target but needs a ` +
        `${requestedDistance}px correction; refusing a short or backward swipe.`,
      );
      return false;
    }
    const maxCorrectionDistance = Math.max(maxSafeDistance, previousGestureDistance * 3);
    const distance = Math.min(
      requestedDistance,
      swipeNumber === 0 ? maxSafeDistance : maxCorrectionDistance,
    );
    if (distance < minimumSwipeTravel) {
      context.onLog(
        `Add Friends: after ${actionLabel}, ${nextName} would need a ${distance}px first swipe; ` +
        `refusing a short or backward swipe.`,
      );
      return false;
    }
    const fingerDelta = -distance;
    const anchorY = center(currentRow).y;
    const gesture = fitVerticalGesture(
      anchorY,
      fingerDelta,
      Math.max(listTop + 6, safeTop),
      safeBottom,
    );
    const durationMs = calibratedForwardSwipeDuration(context.serial, gesture.distance);
    const { startY, endY } = gesture;
    if (context.isAborted()) return false;

    const gestureLabel = swipeNumber === 0
      ? "initial alignment swipe"
      : `movement-scaled correction ${swipeNumber} of 3`;
    context.onLog(
      `Add Friends: after ${actionLabel}, ${gestureLabel} for ${nextName}: ` +
      `${gesture.distance}px/${durationMs}ms in blank lane x=${swipeX}, y=${startY}→${endY}; ` +
      `row top=${currentRow.bounds[1]}, target=${expectedTop}.`,
    );
    await replayIO.swipe(context.serial, swipeX, startY, swipeX, endY, durationMs, false);
    recordForwardSwipePace(context.serial, gesture.distance, durationMs);
    previousTop = currentRow.bounds[1];
    previousGestureDistance = distance;
    await context.sleep(750, "exact");
    if (context.isAborted()) return false;
    const afterSwipeState = await replayIO.dump(context.serial);
    currentNodes = afterSwipeState.nodes;
    const previousRowTop = previousTop;
    const refreshedRows = findFriendsRows(currentNodes)
      .filter(row => Boolean(contactNameInRow(currentNodes, row)));
    const refreshedRow = closestNamedRow(
      currentNodes,
      refreshedRows,
      nextName,
      expectedTop,
    ) ?? closestVisibleRow(refreshedRows, expectedTop, listTop, safeTop, safeBottom);
    if (!refreshedRow) {
      context.onLog(
        `Add Friends: alignment swipe sent; waiting for the visible contact row to settle.`,
      );
      await context.sleep(500, "exact");
      currentNodes = (await replayIO.dump(context.serial)).nodes;
      currentRow = getFirstVisibleNamedRow(currentNodes);
      if (!currentRow) return true;
      continue;
    }
    currentRow = refreshedRow;
    recordForwardScrollRatio(
      context.serial,
      previousRowTop,
      currentRow.bounds[1],
      gesture.distance,
    );
  }

  const residual = currentRow.bounds[1] - expectedTop;
  context.onLog(
    `Add Friends: after ${actionLabel}, ${nextName} is at y=${currentRow.bounds[1]} ` +
    `(target y=${expectedTop}; residual ${residual}px) after three corrections.`,
  );
  return Math.abs(residual) <= alignmentTolerance;
}
