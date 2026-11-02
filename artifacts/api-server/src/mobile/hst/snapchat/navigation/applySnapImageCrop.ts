import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode, UiState } from "../context";
import { center, dump, shortResourceId, tapNode } from "../runtime";
import { findCropIconByShape } from "./findCropIconByShape";

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function findControl(state: UiState, labels: string[]): UiNode | undefined {
  const wanted = new Set(labels.map(normalizeLabel));
  return state.nodes.find(node =>
    [node.text, node.desc].some(value => wanted.has(normalizeLabel(value))),
  );
}

function isNamedCropControl(node: UiNode, screenWidth: number, screenHeight: number): boolean {
  const label = `${node.text} ${node.desc} ${node.resourceId}`.toLowerCase();
  const point = center(node);
  return /crop|croptype/.test(label) &&
    point.x >= screenWidth * 0.72 &&
    point.y >= screenHeight * 0.08 &&
    point.y <= screenHeight * 0.86;
}

function cropIconCandidates(state: UiState, screenWidth: number, screenHeight: number): UiNode[] {
  const candidates = new Map<string, UiNode>();
  for (const node of state.nodes) {
    const [left, top, right, bottom] = node.bounds;
    const width = right - left;
    const height = bottom - top;
    const point = center(node);
    if (
      point.x < screenWidth * 0.78 ||
      point.y < screenHeight * 0.08 ||
      point.y > screenHeight * 0.86 ||
      width < 28 || height < 28 ||
      width > screenWidth * 0.22 || height > screenHeight * 0.12 ||
      !/(?:View|Image)/i.test(node.className)
    ) continue;
    candidates.set(`${point.x}:${point.y}`, node);
  }
  return [...candidates.values()];
}

async function waitForControl(
  context: SnapchatContext,
  labels: string[],
  attempts = 10,
): Promise<{ state: UiState; node: UiNode } | null> {
  let state = await dump(context.serial);
  for (let attempt = 0; attempt < attempts && !context.isAborted(); attempt++) {
    const node = findControl(state, labels);
    if (node) return { state, node };
    if (attempt + 1 < attempts) {
      await context.sleep(500, "exact");
      state = await dump(context.serial);
    }
  }
  return null;
}

export async function applySnapImageCrop(context: SnapchatContext): Promise<boolean> {
  const screen = android.getScreenSize(context.serial);
  let state = await dump(context.serial);

  let cropControl = state.nodes.find(node => isNamedCropControl(node, screen.w, screen.h));
  if (!cropControl) {
    const moreControl = state.nodes.find(node =>
      shortResourceId(node) === "more" ||
      ["more tools", "show more tools"].includes(normalizeLabel(node.text || node.desc)),
    );
    if (!moreControl) {
      context.onLog("Upload a Snap stopped: the editor's More chevron was not available before cropping.");
      return false;
    }
    context.onLog("Upload a Snap: expanding the editor tools with the right-side More chevron.");
    if (!await tapNode(context, moreControl, "expand the Snap editor tool list", 600, true)) return false;
    state = await dump(context.serial);
  }

  if (!cropControl) {
    cropControl = state.nodes.find(node => isNamedCropControl(node, screen.w, screen.h));
  }
  let cropMatchScore: number | null = null;
  if (!cropControl) {
    const pixels = await android.captureScreenPixels(context.serial);
    if (pixels) {
      const candidates = cropIconCandidates(state, screen.w, screen.h);
      const match = findCropIconByShape(
        pixels,
        candidates.map(center),
      );
      if (match) {
        cropControl = candidates.find(point => {
          const nodeCenter = center(point);
          return nodeCenter.x === match.x && nodeCenter.y === match.y;
        });
        cropMatchScore = match.score;
      }
    }
  }
  if (!cropControl) {
    context.onLog("Upload a Snap stopped: the crop-corners icon could not be identified in the expanded toolbar.");
    return false;
  }

  const cropPoint = center(cropControl);
  context.onLog(
    cropMatchScore === null
      ? `Upload a Snap: tapping the identified Crop tool at (${cropPoint.x},${cropPoint.y}).`
      : `Upload a Snap: crop-corners shape matched at (${cropPoint.x},${cropPoint.y}) score=${cropMatchScore.toFixed(3)}; tapping it.`,
  );
  if (!await tapNode(context, cropControl, "open the Crop editor", 600, true)) return false;

  const cropMode = await waitForControl(context, ["Zoom"]);
  if (!cropMode) {
    context.onLog("Upload a Snap stopped: the crop editor's bottom-left Zoom control did not appear.");
    return false;
  }
  context.onLog("Upload a Snap: tapping the bottom-left Zoom control to fill the frame.");
  if (!await tapNode(context, cropMode.node, "expand the crop to fill the frame", 600, true)) return false;

  const finish = await waitForControl(context, ["Finish", "Done"]);
  if (!finish) {
    context.onLog("Upload a Snap stopped: the crop editor's bottom-right confirm control did not appear.");
    return false;
  }
  context.onLog("Upload a Snap: confirming the expanded crop with the bottom-right checkmark.");
  if (!await tapNode(context, finish.node, "confirm the expanded crop", 700, true)) return false;
  return true;
}
