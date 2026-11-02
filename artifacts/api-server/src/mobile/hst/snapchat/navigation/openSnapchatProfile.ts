import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode, UiState } from "../context";
import { center, dump, findOccludingBanner, shortResourceId, tapNode } from "../runtime";

export function isSnapchatCameraSurface(state: UiState): boolean {
  return state.nodes.some(node => [
    "camera_page",
    "camera_capture_button",
  ].includes(shortResourceId(node)));
}

export function isSnapchatProfileSurface(state: UiState): boolean {
  return state.nodes.some(node => [
    "profile-username",
    "profile_identity_section",
    "profile_scroll_view",
  ].includes(shortResourceId(node)));
}

function avatarTapTarget(state: UiState, width: number, height: number): UiNode | undefined {
  const avatar = state.nodes.find(node => shortResourceId(node) === "neon_header_avatar");
  const avatarPoint = avatar
    ? center(avatar)
    : { x: Math.round(width * 0.075), y: Math.round(height * 0.074) };

  const containingTapTarget = state.nodes
    .filter(node => {
      if (!node.clickable) return false;
      const [left, top, right, bottom] = node.bounds;
      const area = (right - left) * (bottom - top);
      return avatarPoint.x >= left && avatarPoint.x <= right &&
        avatarPoint.y >= top && avatarPoint.y <= bottom &&
        center(node).x < width * 0.2 &&
        center(node).y < height * 0.18 &&
        area > 0 && area < width * height * 0.04;
    })
    .sort((a, b) =>
      (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) -
      (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]),
    )[0];

  return containingTapTarget;
}

export async function openSnapchatProfile(context: SnapchatContext): Promise<UiState | null> {
  let state = await dump(context.serial);
  if (isSnapchatProfileSurface(state)) return state;
  if (!isSnapchatCameraSurface(state)) {
    context.onLog("Snapchat account check: Camera screen was not confirmed; not tapping the top-left control.");
    return null;
  }

  const screen = android.getScreenSize(context.serial);
  const deadline = Date.now() + 10_000;
  let target: UiNode | undefined;
  while (!context.isAborted()) {
    state = await dump(context.serial);
    if (isSnapchatProfileSurface(state)) return state;
    if (!isSnapchatCameraSurface(state)) {
      context.onLog("Snapchat account check: Camera screen changed before the profile tap.");
      return null;
    }

    target = avatarTapTarget(state, screen.w, screen.h);
    if (!target) {
      context.onLog("Snapchat account check: the top-left avatar tap target was not exposed.");
      return null;
    }
    const banner = findOccludingBanner(state.nodes, target, screen.w, screen.h);
    if (!banner) break;
    if (Date.now() >= deadline) {
      context.onLog("Snapchat account check: a banner kept covering the avatar ring; stopping before tapping it.");
      return null;
    }
    context.onLog("Snapchat account check: a banner covers the avatar ring; waiting for it to clear.");
    await context.sleep(350, "exact");
  }
  if (context.isAborted() || !target) return null;

  // Take one final fresh dump immediately before input so a banner that appeared
  // during the wait cannot turn the avatar tap into a tap on the overlay.
  state = await dump(context.serial);
  if (!isSnapchatCameraSurface(state)) return null;
  target = avatarTapTarget(state, screen.w, screen.h);
  if (!target || findOccludingBanner(state.nodes, target, screen.w, screen.h)) {
    context.onLog("Snapchat account check: avatar ring was not clear on the final check; no tap sent.");
    return null;
  }

  context.onLog(`Snapchat account check: tapping the clear top-left avatar ring at (${center(target).x}, ${center(target).y}).`);
  if (!await tapNode(context, target, "open Snapchat profile for account verification", 500, true)) return null;

  const profileDeadline = Date.now() + 10_000;
  while (!context.isAborted() && Date.now() < profileDeadline) {
    state = await dump(context.serial);
    if (isSnapchatProfileSurface(state)) return state;
    await context.sleep(500, "exact");
  }

  context.onLog("Snapchat account check: profile page did not appear after tapping the avatar ring.");
  return null;
}
