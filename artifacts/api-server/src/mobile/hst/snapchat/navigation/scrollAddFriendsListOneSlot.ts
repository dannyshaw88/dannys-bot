import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode, UiState } from "../context";
import { center, dump, shortResourceId } from "../runtime";

export type AddFriendsScrollReplayIO = {
  captureScreenPixels: (serial: string) => Promise<{
    width: number;
    height: number;
    channels: number;
    pixels: Buffer;
  } | null>;
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
  captureScreenPixels: android.captureScreenPixels,
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
  if (!knownDurationPerPixel) return 300;
  return Math.max(300, Math.min(2500, Math.round(fingerTravel * knownDurationPerPixel)));
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
  const tolerance = Math.max(18, Math.round(screenHeight * 0.012));
  const minimumTravel = Math.max(36, Math.round(screenHeight * 0.025));
  const minimumGestureY = Math.max(Math.ceil(screenHeight * 0.12), suggestions.bounds[3] + 6);
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
      : Math.max(minimumTravel, Math.round(alignmentError * 0.25));
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
      observedForwardSwipeMsPerPixelBySerial.set(
        context.serial,
        Math.max(0.1, Math.min(20, durationMs / gesture.distance)),
      );
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
  previousCenterY?: number,
  previousRowHeight?: number,
  replayIO: AddFriendsScrollReplayIO = realReplayIO,
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
    const rowHeight = Number.isFinite(previousRowHeight) && previousRowHeight! > 0
      ? Math.round(previousRowHeight!)
      : minimumCorrectionTravel;
    const anchorY = previousCenterY ?? Math.round((safeTop + safeBottom) / 2);
    const gesture = fitVerticalGesture(
      anchorY,
      -Math.max(rowHeight, minimumCorrectionTravel),
      safeTop,
      safeBottom,
    );
    const fallbackX = Math.max(2, Math.min(screenWidth - 2, Math.round(screenWidth * 0.02)));
    context.onLog(
      `Add Friends: list rows stayed unavailable after three refreshes following ${actionLabel} ${friendName}; ` +
      `sending a per-contact fallback scroll of ${gesture.distance}px at x=${fallbackX}.`,
    );
    if (context.isAborted()) return false;
    await replayIO.swipe(context.serial, fallbackX, gesture.startY, fallbackX, gesture.endY, 300, false);
    await context.sleep(750, "exact");
    return true;
  }
  const normalizedFriendName = normalizeContactName(friendName);
  const matchingRows = visibleRows.filter(row =>
    normalizeContactName(contactNameInRow(activeNodes, row)) === normalizedFriendName,
  );
  const targetRow = (matchingRows.length > 0
    ? [...matchingRows].sort((a, b) =>
      Math.abs(center(a).y - (previousCenterY ?? center(a).y)) -
      Math.abs(center(b).y - (previousCenterY ?? center(b).y)),
    )[0]
    : previousCenterY === undefined
      ? visibleRows[0]
      : [...visibleRows].sort((a, b) =>
        Math.abs(center(a).y - previousCenterY) - Math.abs(center(b).y - previousCenterY),
      )[0]) ?? visibleRows[0];
  const targetNameStillVisible = matchingRows.includes(targetRow);
  const targetRowIndex = initialRows.indexOf(targetRow);
  const expectedNextRow = initialRows[targetRowIndex + 1];
  const expectedNextName = expectedNextRow ? contactNameInRow(activeNodes, expectedNextRow) : "";
  const expectedNextTop = visibleRows[0].bounds[1];
  if (!targetNameStillVisible) {
    context.onLog(
      `Add Friends: ${friendName}'s card changed or disappeared after ${actionLabel}; ` +
      `measuring the live card now occupying its previous position.`,
    );
  }
  const screenshot = await replayIO.captureScreenPixels(context.serial);
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
  const swipeDistance = calibratedForwardDistance(context.serial, targetDistance);
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
  const rowForAnchor = measurement?.row ?? targetRow;
  const minimumLaneWidth = Math.max(8, Math.round(screenWidth * 0.01));
  const swipeLane = blankRowLane(
    activeNodes,
    rowForAnchor,
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
  const anchorY = center(rowForAnchor).y;
  const gesture = fitVerticalGesture(
    anchorY,
    -swipeDistance,
    Math.max(listTop + 6, safeTop),
    safeBottom,
  );
  const { startY, endY } = gesture;
  if (context.isAborted()) return false;
  const measuredName = targetNameStillVisible ? friendName : contactNameInRow(activeNodes, targetRow) || "the replacement contact";
  context.onLog(distanceBasis === "grey-divider"
    ? `Add Friends: after ${actionLabel} ${friendName}, measured ${measuredName}'s card at ` +
      `${measurement!.distance.toFixed(1)}px between grey dividers y=${measurement!.upperY} and ` +
      `y=${measurement!.lowerY}; sending a ${gesture.distance}px swipe.`
    : `Add Friends: after ${actionLabel} ${friendName}, using this contact's live row height ` +
      `(${Math.max(0, liveRowHeight)}px) as the per-contact scroll distance; sending a ${gesture.distance}px swipe.`,
  );
  await replayIO.swipe(context.serial, swipeX, startY, swipeX, endY, 300, false);
  await context.sleep(750, "exact");
  if (context.isAborted()) return false;

  let afterSwipeNodes = (await replayIO.dump(context.serial)).nodes;
  let afterSwipeRows = findFriendsRows(afterSwipeNodes);
  let nextRowAfterSwipe = (expectedNextName ? closestNamedRow(
    afterSwipeNodes,
    afterSwipeRows,
    expectedNextName,
    expectedNextRow?.bounds[1] ?? expectedNextTop,
  ) : undefined) ?? closestVisibleRow(
    afterSwipeRows,
    expectedNextTop,
    listTop,
    safeTop,
    safeBottom,
  );
  if (!nextRowAfterSwipe) {
    context.onLog(
      `Add Friends: the swipe was sent; waiting for the next contact row to settle before alignment.`,
    );
    await context.sleep(500, "exact");
    afterSwipeNodes = (await replayIO.dump(context.serial)).nodes;
    afterSwipeRows = findFriendsRows(afterSwipeNodes);
    nextRowAfterSwipe = (expectedNextName ? closestNamedRow(
      afterSwipeNodes,
      afterSwipeRows,
      expectedNextName,
      expectedNextRow?.bounds[1] ?? expectedNextTop,
    ) : undefined) ?? closestVisibleRow(
      afterSwipeRows,
      expectedNextTop,
      listTop,
      safeTop,
      safeBottom,
    );
  }

  let currentNodes = afterSwipeNodes;
  let currentNextRow = nextRowAfterSwipe ?? closestVisibleRow(
    afterSwipeRows,
    expectedNextTop,
    listTop,
    safeTop,
    safeBottom,
  );
  if (!currentNextRow) return true;
  let currentNextName = expectedNextName || contactNameInRow(currentNodes, currentNextRow) || "next visible contact";
  let previousNextTop = expectedNextRow?.bounds[1] ?? expectedNextTop;
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
    if (expectedNextName && contactNameInRow(currentNodes, currentNextRow) === expectedNextName) {
      recordForwardScrollRatio(
        context.serial,
        previousNextTop,
        currentNextRow.bounds[1],
        gesture.distance,
      );
    }
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

    context.onLog(
      `Add Friends: the previous ${previousGestureDistance}px swipe moved content ${measuredContentMovement}px; ` +
      `sending correction ${attempt} of 3 for ${correctionGesture.distance}px to move ${currentNextName} to the top.`,
    );
    await replayIO.swipe(
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
    const afterCorrectionState = await replayIO.dump(context.serial);
    const afterCorrectionNodes = afterCorrectionState.nodes;
    const correctedRows = findFriendsRows(afterCorrectionNodes);
    const alignedNextRow = (expectedNextName ? closestNamedRow(
      afterCorrectionNodes,
      correctedRows,
      expectedNextName,
      expectedNextTop,
    ) : undefined) ?? closestVisibleRow(
      correctedRows,
      expectedNextTop,
      listTop,
      safeTop,
      safeBottom,
    );
    if (!alignedNextRow) break;
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
    currentNextName = expectedNextName || contactNameInRow(currentNodes, currentNextRow) || currentNextName;
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
    context.onLog(
      `Add Friends: positioning ${friendName} at the first contact position before its action ` +
      `(row y=${target.bounds[1]}, target y=${targetTop}, swipe ${gesture.distance}px at x=${lane.x}, ` +
      `y=${gesture.startY}→${gesture.endY}).`,
    );
    if (context.isAborted()) return false;
    await replayIO.swipe(
      context.serial,
      lane.x,
      gesture.startY,
      lane.x,
      gesture.endY,
      300,
      false,
    );
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
    const { startY, endY } = gesture;
    if (context.isAborted()) return false;

    const gestureLabel = swipeNumber === 0
      ? "initial alignment swipe"
      : `movement-scaled correction ${swipeNumber} of 3`;
    context.onLog(
      `Add Friends: after ${actionLabel}, ${gestureLabel} for ${nextName}: ` +
      `${gesture.distance}px in blank lane x=${swipeX}, y=${startY}→${endY}; ` +
      `row top=${currentRow.bounds[1]}, target=${expectedTop}.`,
    );
    await replayIO.swipe(context.serial, swipeX, startY, swipeX, endY, 300, false);
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
