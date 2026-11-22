import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { center, shortResourceId } from "../runtime";

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

function findHorizontalDividerYs(
  screen: { width: number; height: number; channels: number; pixels: Buffer },
  rows: UiNode[],
): number[] {
  if (rows.length < 2 || screen.channels < 3) return [];
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

function measureMiddleContactDivider(
  rows: UiNode[],
  screen: { width: number; height: number; channels: number; pixels: Buffer },
): { distance: number; upperY: number; lowerY: number; row: UiNode } | null {
  if (rows.length < 3) return null;
  const dividerYs = findHorizontalDividerYs(screen, rows);
  if (dividerYs.length < 2) return null;
  const middleRows = rows.slice(1, -1);

  for (const row of [...middleRows].sort((a, b) =>
    Math.abs((a.bounds[1] + a.bounds[3]) / 2 - screen.height / 2) -
    Math.abs((b.bounds[1] + b.bounds[3]) / 2 - screen.height / 2),
  )) {
    const centerY = (row.bounds[1] + row.bounds[3]) / 2;
    const upperY = dividerYs.filter(y => y <= centerY).at(-1);
    const lowerY = dividerYs.find(y => y > centerY);
    if (upperY === undefined || lowerY === undefined) continue;
    const distance = lowerY - upperY;
    const lineMargin = Math.max(12, Math.round((row.bounds[3] - row.bounds[1]) * 0.15));
    if (
      distance < 20 ||
      distance > screen.height * 0.2 ||
      upperY < row.bounds[1] - lineMargin ||
      lowerY > row.bounds[3] + lineMargin
    ) continue;
    return { distance, upperY, lowerY, row };
  }
  return null;
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
  if (!title || middleRows.length < 3 || !Number.isFinite(screenWidth) || screenWidth <= 0 ||
      !Number.isFinite(screenHeight) || screenHeight <= 0) {
    context.onLog(`Add Friends: cannot identify a fully visible middle contact after ${actionLabel} ${friendName}; no guessed swipe was sent.`);
    return false;
  }
  const screenshot = await android.captureScreenPixels(context.serial);
  if (!screenshot || screenshot.width !== screenWidth || screenshot.height !== screenHeight) {
    context.onLog(
      `Add Friends: live screenshot pixels are unavailable or do not match ${screenWidth}×${screenHeight}; ` +
      `cannot measure the grey dividers after ${actionLabel} ${friendName}.`,
    );
    return false;
  }
  const measurement = measureMiddleContactDivider(middleRows, screenshot);
  if (!measurement || measurement.distance <= 0) {
    context.onLog(
      `Add Friends: could not detect the upper and lower grey divider pixels around a middle contact ` +
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
  context.onLog(
    `Add Friends: one screenshot measured ${measurement.distance.toFixed(1)}px from grey line y=${measurement.upperY} ` +
    `to y=${measurement.lowerY}; using exactly ${targetDistance}px for one swipe.`,
  );
  await android.swipe(context.serial, swipeX, startY, swipeX, endY, 650, false);
  await context.sleep(220, "exact");
  return true;
}
