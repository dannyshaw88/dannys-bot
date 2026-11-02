import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode, UiState } from "../context";
import { center, dump, shortResourceId, tapNode } from "../runtime";

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

function avatarTapTarget(state: UiState): UiNode | undefined {
  return state.nodes.find(node => shortResourceId(node) === "neon_header_avatar");
}

function isAvatarTapWrapper(node: UiNode, avatar: UiNode): boolean {
  if (!node.clickable) return false;
  const [left, top, right, bottom] = node.bounds;
  const [avatarLeft, avatarTop, avatarRight, avatarBottom] = avatar.bounds;
  const width = right - left;
  const height = bottom - top;
  const avatarWidth = avatarRight - avatarLeft;
  const avatarHeight = avatarBottom - avatarTop;
  const nodeCenter = center(node);
  const avatarCenter = center(avatar);

  return left <= avatarLeft && top <= avatarTop &&
    right >= avatarRight && bottom >= avatarBottom &&
    width <= avatarWidth * 1.6 && height <= avatarHeight * 1.6 &&
    Math.abs(nodeCenter.x - avatarCenter.x) <= 16 &&
    Math.abs(nodeCenter.y - avatarCenter.y) <= 16;
}

function findAvatarOverlay(
  nodes: UiNode[],
  avatar: UiNode,
  screenWidth: number,
  screenHeight: number,
): UiNode | undefined {
  const point = center(avatar);
  const screenArea = screenWidth * screenHeight;

  return nodes.find(node => {
    if (node === avatar) return false;
    const [left, top, right, bottom] = node.bounds;
    const coversAvatarPoint =
      point.x >= left && point.x <= right &&
      point.y >= top && point.y <= bottom;
    const area = (right - left) * (bottom - top);
    if (!coversAvatarPoint || area <= 0 || area >= screenArea * 0.5) return false;

    const identity = `${node.resourceId} ${node.text} ${node.desc}`;
    if (/banner|toast|snackbar|notification|chat|message|incoming/i.test(identity)) return true;

    // The tight clickable parent around the avatar is expected. Any other
    // clickable or labeled target at its center may intercept the tap.
    if (isAvatarTapWrapper(node, avatar)) return false;
    return node.clickable || Boolean(node.text.trim() || node.desc.trim());
  });
}

export async function openSnapchatProfile(
  context: SnapchatContext,
  initialState?: UiState,
): Promise<UiState | null> {
  let state = initialState ?? await dump(context.serial);
  if (isSnapchatProfileSurface(state)) return state;
  if (!isSnapchatCameraSurface(state)) {
    context.onLog("Snapchat account check: Camera screen was not confirmed; not tapping the top-left control.");
    return null;
  }

  const screen = android.getScreenSize(context.serial);
  let target: UiNode | undefined;
  const findClearAvatar = (current: UiState): {
    profile: UiState | null;
    target?: UiNode;
    avatarFound: boolean;
    obstruction?: UiNode;
  } => {
    if (isSnapchatProfileSurface(current)) return { profile: current, avatarFound: false };
    if (!isSnapchatCameraSurface(current)) return { profile: null, avatarFound: false };
    const avatar = avatarTapTarget(current);
    if (!avatar) return { profile: null, avatarFound: false };
    const obstruction = findAvatarOverlay(current.nodes, avatar, screen.w, screen.h);
    return {
      profile: null,
      target: obstruction ? undefined : avatar,
      avatarFound: true,
      obstruction,
    };
  };

  let result = findClearAvatar(state);
  if (result.profile) return result.profile;
  target = result.target;
  if (!target) {
    if (!result.avatarFound) {
      context.onLog("Snapchat account check: the top-left avatar icon was not exposed; not tapping a guessed coordinate.");
      return null;
    }
    const blocker = result.obstruction;
    const blockerLabel = blocker
      ? [shortResourceId(blocker), blocker.text, blocker.desc].filter(Boolean).join(" ")
      : "unknown overlay";
    context.onLog(`Snapchat account check: ${blockerLabel} overlaps the avatar tap point; waiting for it to clear.`);
    const bannerDeadline = Date.now() + 5_000;
    while (!context.isAborted() && Date.now() < bannerDeadline) {
      await context.sleep(250, "exact");
      state = await dump(context.serial);
      result = findClearAvatar(state);
      if (result.profile) return result.profile;
      if (!isSnapchatCameraSurface(state)) {
        context.onLog("Snapchat account check: Camera screen changed before the profile tap.");
        return null;
      }
      target = result.target;
      if (target) break;
    }
    if (!target) {
      context.onLog("Snapchat account check: the avatar remained covered; stopping before tapping to avoid opening the banner.");
      return null;
    }
  }

  if (context.isAborted()) return null;
  context.onLog(`Snapchat account check: tapping the center of the clear top-left avatar icon at (${center(target).x}, ${center(target).y}).`);
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
