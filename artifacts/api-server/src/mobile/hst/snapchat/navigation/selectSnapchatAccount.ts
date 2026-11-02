import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode, UiState } from "../context";
import { center, dump, shortResourceId, tapNode } from "../runtime";
import { isSnapchatCameraSurface } from "./openSnapchatProfile";

function normalizedUsername(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, "")
    .replace(/^@/, "")
    .toLowerCase();
}

function exactLabel(node: UiNode, wanted: string): boolean {
  return [node.text, node.desc].some(value => value.trim().toLowerCase() === wanted.toLowerCase());
}

export function isSavedSnapchatAccountPicker(state: UiState): boolean {
  return state.nodes.some(node => shortResourceId(node) === "account_login_button") ||
    state.nodes.some(node => exactLabel(node, "Switch Account"));
}

export function centeredSavedSnapchatUsername(
  state: UiState,
  screen: { w: number; h: number },
): UiNode | undefined {
  const centerX = screen.w / 2;
  const usernamePattern = /^[a-z0-9._-]{2,32}$/i;
  return state.nodes
    .filter(node => {
      const label = [node.text, node.desc].find(value => usernamePattern.test(normalizedUsername(value)));
      if (!label) return false;
      const point = center(node);
      return Math.abs(point.x - centerX) <= screen.w * 0.32 &&
        point.y >= screen.h * 0.25 && point.y <= screen.h * 0.68;
    })
    .sort((a, b) => Math.abs(center(a).x - centerX) - Math.abs(center(b).x - centerX))[0];
}

function accountName(node: UiNode): string {
  return [node.text, node.desc]
    .map(normalizedUsername)
    .find(value => /^[a-z0-9._-]{2,32}$/i.test(value)) ?? "";
}

function exactSavedAccountUsername(state: UiState, username: string): UiNode | undefined {
  return state.nodes.find(node =>
    [node.text, node.desc].some(value => normalizedUsername(value) === username),
  );
}

async function waitForCameraAfterAccountTap(
  context: SnapchatContext,
  timeoutMs = 30_000,
): Promise<UiState | null> {
  const deadline = Date.now() + timeoutMs;
  let check = 0;
  while (!context.isAborted() && Date.now() < deadline) {
    const state = await dump(context.serial);
    if (isSnapchatCameraSurface(state)) return state;
    check += 1;
    const elapsedSeconds = Math.round((Date.now() - (deadline - timeoutMs)) / 1000);
    context.onLog(
      `Snapchat account switch: Camera is not ready ${elapsedSeconds}s after selecting the account; checking again in 5 seconds (${check}).`,
    );
    await context.sleep(Math.min(5_000, Math.max(0, deadline - Date.now())), "exact");
  }
  return null;
}

export async function selectSnapchatAccountFromCarousel(
  context: SnapchatContext,
  expectedUsername: string,
): Promise<boolean> {
  const target = normalizedUsername(expectedUsername);
  if (!target) return false;
  const screen = android.getScreenSize(context.serial);
  let state = await dump(context.serial);
  if (!isSavedSnapchatAccountPicker(state)) {
    context.onLog("Snapchat account switch: saved-account carousel was not confirmed.");
    return false;
  }
  const slotLabel = typeof context.slotIdx === "number"
    ? `Account Slot ${context.slotIdx + 1}`
    : "the configured account slot";
  context.onLog(`Snapchat account switch: searching for ${slotLabel} username @${expectedUsername}.`);

  const directions = [
    { label: "right", fromX: Math.round(screen.w * 0.25), toX: Math.round(screen.w * 0.75) },
    { label: "left", fromX: Math.round(screen.w * 0.75), toX: Math.round(screen.w * 0.25) },
  ] as const;
  let lastVerifiedCarouselY: number | undefined;

  const selectVisibleTarget = async (): Promise<"not-found" | "unreadable" | "selected" | "failed"> => {
    const exactUsername = exactSavedAccountUsername(state, target);
    if (exactUsername) {
      const point = center(exactUsername);
      context.onLog(
        `Snapchat account switch: exact target username @${expectedUsername} is visible; tapping its username text at (${point.x}, ${point.y}).`,
      );
      if (!await tapNode(context, exactUsername, "tap exact saved-account username", 500, true)) return "failed";
      context.onLog("Snapchat account switch: waiting for login to finish; checking the Camera screen every 5 seconds.");
      const camera = await waitForCameraAfterAccountTap(context);
      if (!camera) {
        context.onLog("Snapchat account switch: Camera did not appear within 30 seconds after selecting the saved profile.");
        return "failed";
      }
      context.onLog(`Snapchat account switch: Camera appeared for the selected profile @${expectedUsername}.`);
      return "selected";
    }

    const selected = centeredSavedSnapchatUsername(state, screen);
    if (!selected) {
      return "unreadable";
    }
    const selectedUsername = normalizedUsername(accountName(selected));
    if (!selectedUsername) return "unreadable";
    lastVerifiedCarouselY = center(selected).y;

    return "not-found";
  };

  for (const direction of directions) {
    for (let swipe = 0; swipe < 4 && !context.isAborted(); swipe++) {
      const selection = await selectVisibleTarget();
      if (selection === "selected") return true;
      if (selection === "failed") return false;

      const selected = centeredSavedSnapchatUsername(state, screen);
      if (selected) lastVerifiedCarouselY = center(selected).y;
      if (lastVerifiedCarouselY === undefined) {
        context.onLog("Snapchat account switch: no saved-account row position was confirmed; not sending a guessed swipe.");
        return false;
      }
      const selectedUsername = selected ? normalizedUsername(accountName(selected)) : "unknown";
      const y = lastVerifiedCarouselY;
      if (!selected) {
        context.onLog("Snapchat account switch: username is temporarily unreadable; continuing the directional search at the last verified row.");
      }
      context.onLog(
        `Snapchat account switch: visible username @${selectedUsername} does not match slot target @${expectedUsername}; swiping ${direction.label} (${swipe + 1}/4) to search saved profiles.`,
      );
      await android.swipe(context.serial, direction.fromX, y, direction.toX, y, 450, false);
      await context.sleep(600, "exact");
      state = await dump(context.serial);
      if (!isSavedSnapchatAccountPicker(state)) {
        context.onLog("Snapchat account switch: carousel left the saved-account screen before a matching profile was found.");
        return false;
      }
    }
  }

  const finalSelection = await selectVisibleTarget();
  if (finalSelection === "selected") return true;
  if (finalSelection === "failed") return false;

  context.onLog(
    `Snapchat account switch: checked four right swipes and four left swipes; @${expectedUsername} was not found in the saved-account carousel.`,
  );
  return false;
}
