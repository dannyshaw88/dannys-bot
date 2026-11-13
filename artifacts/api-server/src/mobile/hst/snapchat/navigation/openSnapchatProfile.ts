import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode, UiState } from "../context";
import { center, dump, shortResourceId, tapNode } from "../runtime";
import { tapSnapchatStartupPopupIfPresent } from "./dismissNotificationPermission";

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

export function overlappingAvatarBanner(
  nodes: UiNode[],
  target: UiNode,
  screenWidth: number,
  screenHeight: number,
): UiNode | undefined {
  const point = center(target);
  const targetArea = (target.bounds[2] - target.bounds[0]) * (target.bounds[3] - target.bounds[1]);
  const treeLeft = Math.min(...nodes.map(node => node.bounds[0]));
  const treeTop = Math.min(...nodes.map(node => node.bounds[1]));
  const treeRight = Math.max(...nodes.map(node => node.bounds[2]));
  const treeBottom = Math.max(...nodes.map(node => node.bounds[3]));
  const treeWidth = Math.max(1, treeRight - treeLeft);
  const treeHeight = Math.max(1, treeBottom - treeTop);
  return nodes.find(node => {
    if (node === target) return false;
    const [left, top, right, bottom] = node.bounds;
    const width = right - left;
    const height = bottom - top;
    const area = width * height;
    const fullyInsideAvatar = left >= target.bounds[0] && top >= target.bounds[1] &&
      right <= target.bounds[2] && bottom <= target.bounds[3];
    if (fullyInsideAvatar || area <= targetArea * 0.3) return false;
    // Android exposes an unlabeled, clickable root for Snapchat's whole window
    // on some devices. Its bounds can look like an overlay when `wm size` and
    // accessibility coordinates use different resolutions; it is not a banner.
    const wholeScreenSurface = left <= treeLeft + treeWidth * 0.02 &&
      top <= treeTop + treeHeight * 0.02 &&
      right >= treeLeft + treeWidth * 0.9 &&
      bottom >= treeTop + treeHeight * 0.8;
    if (wholeScreenSurface) return false;
    const coversTap = point.x >= left && point.x <= right &&
      point.y >= top && point.y <= bottom;
    const hasLabel = Boolean(node.text.trim() || node.desc.trim());
    const hasBannerIdentity = /banner|toast|snackbar|notification|heads.?up/i.test(
      `${node.resourceId} ${node.text} ${node.desc}`,
    );
    const bannerGeometry = width >= Math.max(screenWidth * 0.45, treeWidth * 0.55) &&
      height <= treeHeight * 0.3 &&
      top <= treeTop + treeHeight * 0.35 &&
      area > targetArea * 2.5;
    const clickableBanner = node.clickable && bannerGeometry;
    return coversTap && (hasBannerIdentity || hasLabel || clickableBanner);
  });
}

async function handleStartupPopupBeforeBanner(
  context: SnapchatContext,
  initialState: UiState,
): Promise<{ state: UiState; tapped: boolean } | null> {
  let state = initialState;
  const deadline = Date.now() + 2_500;
  let waitingForDenyButtonLogged = false;

  while (!context.isAborted()) {
    const result = await tapSnapchatStartupPopupIfPresent(context, state);
    if (result === "aborted") return null;
    if (result === "not-present") return { state, tapped: false };
    if (result === "tapped") {
      // Refresh the surface for the next normal navigation step; this is not a
      // separate prompt-dismissal confirmation.
      await context.sleep(300, "exact");
      return { state: await dump(context.serial), tapped: true };
    }

    if (!waitingForDenyButtonLogged) {
      context.onLog(
        "Snapchat account check: notification prompt is visible; waiting briefly for its Deny/Dismiss/Don't allow button before the banner check.",
      );
      waitingForDenyButtonLogged = true;
    }
    if (Date.now() >= deadline) return null;
    await context.sleep(300, "exact");
    if (context.isAborted()) return null;
    state = await dump(context.serial);
  }

  return null;
}

export async function openSnapchatProfile(
  context: SnapchatContext,
  initialState?: UiState,
): Promise<UiState | null> {
  let state = initialState ?? await dump(context.serial);
  let startupPopupResult = await handleStartupPopupBeforeBanner(context, state);
  if (!startupPopupResult) return null;
  state = startupPopupResult.state;
  if (isSnapchatProfileSurface(state)) return state;
  if (!isSnapchatCameraSurface(state)) {
    context.onLog("Snapchat account check: Camera screen was not confirmed; not tapping the top-left control.");
    return null;
  }

  const screen = android.getScreenSize(context.serial);
  // The Camera state supplied by the caller can predate an incoming chat banner.
  // Refresh it immediately before deciding whether to tap the avatar.
  context.onLog("Snapchat account check: refreshing Camera and checking the avatar for an overlapping banner.");
  state = await dump(context.serial);
  if (!startupPopupResult.tapped) {
    startupPopupResult = await handleStartupPopupBeforeBanner(context, state);
    if (!startupPopupResult) return null;
    state = startupPopupResult.state;
  }
  if (isSnapchatProfileSurface(state)) return state;
  if (!isSnapchatCameraSurface(state)) {
    context.onLog("Snapchat account check: Camera screen changed before the banner check.");
    return null;
  }

  let target = avatarTapTarget(state, screen.w, screen.h);
  if (!target) {
    context.onLog("Snapchat account check: the top-left avatar tap target was not exposed.");
    return null;
  }
  let banner = overlappingAvatarBanner(state.nodes, target, screen.w, screen.h);
  if (banner) {
    const bannerDeadline = Date.now() + 8_000;
    context.onLog(
      `Snapchat account check: blocking the avatar tap; overlapping banner "${banner.text || banner.desc || banner.resourceId}" at ${banner.bounds.join(",")}.`,
    );
    while (!context.isAborted() && Date.now() < bannerDeadline) {
      await context.sleep(300, "exact");
      state = await dump(context.serial);
      if (isSnapchatProfileSurface(state)) return state;
      if (!isSnapchatCameraSurface(state)) {
        context.onLog("Snapchat account check: Camera screen changed while waiting for the banner to clear.");
        return null;
      }
      target = avatarTapTarget(state, screen.w, screen.h);
      if (!target) {
        context.onLog("Snapchat account check: the avatar target disappeared while a banner was present.");
        return null;
      }
      banner = overlappingAvatarBanner(state.nodes, target, screen.w, screen.h);
      if (!banner) break;
    }
    if (banner) {
      context.onLog("Snapchat account check: the overlapping banner did not clear; avatar was not tapped.");
      return null;
    }
    context.onLog("Snapchat account check: fresh Camera tree confirms the banner cleared before tapping.");
  } else {
    context.onLog("Snapchat account check: fresh Camera tree confirms no banner overlaps the avatar.");
  }

  if (context.isAborted()) return null;
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
