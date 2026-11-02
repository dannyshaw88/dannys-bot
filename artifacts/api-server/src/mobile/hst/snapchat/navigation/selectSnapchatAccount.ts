import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode, UiState } from "../context";
import { center, dump, shortResourceId, tapNode } from "../runtime";
import { isSnapchatCameraSurface } from "./openSnapchatProfile";

function normalizedUsername(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
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
      const label = [node.text, node.desc].find(value => usernamePattern.test(value.trim()));
      if (!label) return false;
      const point = center(node);
      return Math.abs(point.x - centerX) <= screen.w * 0.32 &&
        point.y >= screen.h * 0.25 && point.y <= screen.h * 0.68;
    })
    .sort((a, b) => Math.abs(center(a).x - centerX) - Math.abs(center(b).x - centerX))[0];
}

function accountName(node: UiNode): string {
  return [node.text, node.desc].find(value => /^[a-z0-9._-]{2,32}$/i.test(value.trim()))?.trim() ?? "";
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

  const seen = new Set<string>();
  for (let swipeCount = 0; swipeCount <= 32 && !context.isAborted(); swipeCount++) {
    const selected = centeredSavedSnapchatUsername(state, screen);
    if (!selected) {
      context.onLog("Snapchat account switch: no centered saved-account username was exposed; not selecting a profile.");
      return false;
    }
    const selectedUsername = normalizedUsername(accountName(selected));
    if (!selectedUsername) return false;

    if (selectedUsername === target) {
      context.onLog(`Snapchat account switch: exact target @${expectedUsername} is centered in the saved-account carousel.`);
      if (!await tapNode(context, selected, "select matching saved Snapchat account", 500, true)) return false;
      context.onLog("Snapchat account switch: waiting for login to finish; checking the Camera screen every 5 seconds.");
      const camera = await waitForCameraAfterAccountTap(context);
      if (!camera) {
        context.onLog("Snapchat account switch: Camera did not appear within 30 seconds after selecting the saved profile.");
        return false;
      }
      context.onLog(`Snapchat account switch: Camera appeared for the selected profile @${expectedUsername}.`);
      return true;
    }

    if (seen.has(selectedUsername)) {
      context.onLog(`Snapchat account switch: carousel returned to @${selectedUsername}; @${expectedUsername} is not in its saved profiles.`);
      return false;
    }
    seen.add(selectedUsername);
    if (swipeCount === 32) break;

    const y = center(selected).y;
    const fromX = Math.round(screen.w * 0.25);
    const toX = Math.round(screen.w * 0.75);
    context.onLog(`Snapchat account switch: @${selectedUsername} is not the target; swiping right to the next saved profile.`);
    await android.swipe(context.serial, fromX, y, toX, y, 450, false);
    await context.sleep(600, "exact");
    state = await dump(context.serial);
    if (!isSavedSnapchatAccountPicker(state)) {
      context.onLog("Snapchat account switch: carousel left the saved-account screen before a matching profile was found.");
      return false;
    }
  }

  context.onLog(`Snapchat account switch: stopped after the carousel limit; @${expectedUsername} was not found.`);
  return false;
}
