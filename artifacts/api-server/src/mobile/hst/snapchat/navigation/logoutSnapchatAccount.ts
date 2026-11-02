import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode, UiState } from "../context";
import { center, dump, shortResourceId, tapNode } from "../runtime";

function exactLabel(node: UiNode, wanted: string): boolean {
  return [node.text, node.desc].some(value => value.trim().toLowerCase() === wanted.toLowerCase());
}

function isSettingsPage(state: UiState): boolean {
  return state.nodes.some(node => exactLabel(node, "Settings")) &&
    state.nodes.some(node => shortResourceId(node) === "scroll-view");
}

function scrollContainer(state: UiState): UiNode | undefined {
  return state.nodes.find(node => shortResourceId(node) === "scroll-view");
}

function visibleLogoutRow(state: UiState, screenHeight: number): UiNode | undefined {
  const container = scrollContainer(state);
  if (!container) return undefined;
  const [left, top, right, bottom] = container.bounds;
  return state.nodes
    .filter(node => {
      const id = shortResourceId(node).toLowerCase();
      const isLogout = id === "logout" || exactLabel(node, "Log Out");
      if (!isLogout) return false;
      const [x1, y1, x2, y2] = node.bounds;
      const tap = center(node);
      return x1 >= left && x2 <= right && y1 >= top && y2 <= bottom &&
        y2 > y1 && tap.y >= top + (bottom - top) * 0.55 &&
        tap.y < Math.min(bottom, screenHeight * 0.92);
    })
    .sort((a, b) => {
      const aText = exactLabel(a, "Log Out") ? 0 : 1;
      const bText = exactLabel(b, "Log Out") ? 0 : 1;
      return aText - bText;
    })[0];
}

function isNearSettingsBottom(node: UiNode, container: UiNode): boolean {
  const [, top, , bottom] = container.bounds;
  return center(node).y >= bottom - (bottom - top) * 0.14;
}

function hasSettingsBottomMarker(state: UiState, screenHeight: number): boolean {
  return state.nodes.some(node =>
    /snapchat v\d|made in los angeles/i.test(`${node.text} ${node.desc}`) &&
    center(node).y >= screenHeight * 0.84,
  );
}

function scrollSignature(state: UiState): string {
  const container = scrollContainer(state);
  if (!container) return "";
  const [left, top, right, bottom] = container.bounds;
  return state.nodes
    .filter(node => {
      const [x1, y1, x2, y2] = node.bounds;
      return x1 >= left && x2 <= right && y1 >= top && y2 <= bottom &&
        Boolean(node.text.trim() || node.desc.trim());
    })
    .map(node => `${node.text}|${node.desc}|${node.bounds.join(",")}`)
    .join("\n");
}

async function waitFor(
  context: SnapchatContext,
  predicate: (state: UiState) => boolean,
  timeoutMs: number,
): Promise<UiState | null> {
  const deadline = Date.now() + timeoutMs;
  while (!context.isAborted() && Date.now() < deadline) {
    const state = await dump(context.serial);
    if (predicate(state)) return state;
    await context.sleep(400, "exact");
  }
  return null;
}

function hasNumberVerificationNotice(state: UiState): boolean {
  return /verify a number/i.test(state.xml);
}

function isLogoutConfirmation(state: UiState): boolean {
  return /are you sure[\s\S]{0,100}log out/i.test(state.xml);
}

function isSavedAccountPicker(state: UiState): boolean {
  return state.nodes.some(node => shortResourceId(node) === "account_login_button") ||
    state.nodes.some(node => exactLabel(node, "Switch Account"));
}

function logoutConfirmationPoint(
  state: UiState,
  screenHeight: number,
): { x: number; y: number; uiHeight: number; offsetY: number; label: UiNode; cancel: UiNode } | undefined {
  const title = state.nodes.find(node =>
    /are you sure[\s\S]{0,100}log out/i.test(`${node.text} ${node.desc}`),
  );
  const cancel = state.nodes.find(node => exactLabel(node, "Cancel"));
  if (!cancel) return undefined;

  const cancelCenter = center(cancel);
  const labels = state.nodes
    .filter(node => exactLabel(node, "Log Out"))
    .sort((a, b) => {
      const distance = (node: UiNode) =>
        Math.abs(center(node).x - cancelCenter.x) + Math.abs(center(node).y - cancelCenter.y);
      return distance(a) - distance(b);
    });
  const label = labels[0];
  if (!label) return undefined;

  // The accessibility label's bounds have repeatedly landed outside the
  // visible grey button on this Snapchat dialog. The button is centered above
  // Cancel; derive its center from that live dialog anchor and the UI dump's
  // root height, which is in the same coordinate space as adb input tap.
  const root = state.nodes.find(node =>
    node.bounds[0] === 0 &&
    node.bounds[1] === 0 &&
    node.bounds[2] > 0 &&
    node.bounds[3] > 0,
  );
  const uiHeight = root ? root.bounds[3] - root.bounds[1] : screenHeight;
  if (uiHeight <= 0) return undefined;

  const x = cancelCenter.x;
  const offsetY = Math.round(uiHeight * 0.065);
  const y = cancelCenter.y - offsetY;
  if (title && y <= center(title).y) return undefined;
  if (y >= cancelCenter.y || y < 0 || y >= uiHeight) return undefined;
  return { x, y, uiHeight, offsetY, label, cancel };
}

export async function logoutSnapchatAccount(context: SnapchatContext): Promise<boolean> {
  let state = await dump(context.serial);
  if (!state.nodes.some(node => shortResourceId(node) === "profile-username")) {
    context.onLog("Snapchat account switch: profile identity screen was not confirmed; not opening Settings.");
    return false;
  }

  const gear = state.nodes.find(node =>
    shortResourceId(node) === "unified_profile_icon_button_settings",
  );
  if (!gear) {
    context.onLog("Snapchat account switch: Settings gear was not found on the confirmed profile.");
    return false;
  }
  context.onLog(`Snapchat account switch: opening profile Settings at (${center(gear).x}, ${center(gear).y}).`);
  if (!await tapNode(context, gear, "open Snapchat profile settings", 0, true)) return false;
  await context.sleep(1_000, "exact");
  state = await dump(context.serial);
  if (!isSettingsPage(state)) {
    context.onLog("Snapchat account switch: Settings page was not confirmed.");
    return false;
  }

  const screen = android.getScreenSize(context.serial);
  let logoutRow: UiNode | undefined;
  let bottomConfirmed = false;
  const seenScrollStates = new Set<string>();
  for (let swipe = 0; swipe < 8 && !context.isAborted(); swipe++) {
    if (!isSettingsPage(state)) {
      context.onLog("Snapchat account switch: Settings closed while locating Log Out.");
      return false;
    }
    logoutRow = visibleLogoutRow(state, screen.h);
    const container = scrollContainer(state);
    if (!container) {
      context.onLog("Snapchat account switch: Settings scroll area was not found; no guessed swipe sent.");
      return false;
    }
    const [left, top, right, bottom] = container.bounds;
    const startX = Math.round((left + right) / 2);
    const startY = Math.round(top + (bottom - top) * 0.82);
    const endY = Math.round(top + (bottom - top) * 0.18);
    const beforeSignature = scrollSignature(state);
    context.onLog(`Snapchat account switch: sending four fast upward Settings swipes (${swipe + 1}/8 batches).`);
    for (let stroke = 0; stroke < 4 && !context.isAborted(); stroke++) {
      await android.swipe(context.serial, startX, startY, startX, endY, 180, false);
    }
    if (context.isAborted()) return false;
    const after = await dump(context.serial);
    if (!isSettingsPage(after)) {
      context.onLog("Snapchat account switch: Settings changed during the scroll; stopping before Logout.");
      return false;
    }
    const afterSignature = scrollSignature(after);
    logoutRow = visibleLogoutRow(after, screen.h);
    const afterContainer = scrollContainer(after);
    if (
      logoutRow &&
      afterContainer &&
      (hasSettingsBottomMarker(after, screen.h) || isNearSettingsBottom(logoutRow, afterContainer))
    ) {
      context.onLog("Snapchat account switch: Log Out is visible at the bottom of Settings.");
      bottomConfirmed = true;
      state = after;
      break;
    }
    if (afterSignature === beforeSignature) {
      context.onLog("Snapchat account switch: Settings did not move and the bottom was not confirmed.");
      return false;
    }
    if (seenScrollStates.has(afterSignature)) {
      context.onLog("Snapchat account switch: Settings scroll repeated an earlier position before reaching the bottom.");
      return false;
    }
    seenScrollStates.add(beforeSignature);
    state = after;
  }

  if (!bottomConfirmed) {
    state = await dump(context.serial);
    logoutRow = visibleLogoutRow(state, screen.h);
  }
  if (!logoutRow || !bottomConfirmed) {
    context.onLog("Snapchat account switch: the bottom of Settings was not confirmed with Log Out visible.");
    return false;
  }

  context.onLog(`Snapchat account switch: tapping the visible Settings Log Out row at (${center(logoutRow).x}, ${center(logoutRow).y}).`);
  if (!await tapNode(context, logoutRow, "open Snapchat logout confirmation", 500, true)) return false;

  let dialog = await waitFor(
    context,
    candidate => hasNumberVerificationNotice(candidate) || isLogoutConfirmation(candidate),
    10_000,
  );
  if (!dialog) {
    context.onLog("Snapchat account switch: neither the optional number notice nor logout confirmation appeared.");
    return false;
  }

  if (hasNumberVerificationNotice(dialog)) {
    const notNow = dialog.nodes.find(node => exactLabel(node, "Not Now"));
    if (!notNow) {
      context.onLog("Snapchat account switch: number-verification notice appeared without its Not Now button.");
      return false;
    }
    context.onLog("Snapchat account switch: dismissing the optional number-verification notice with Not Now.");
    if (!await tapNode(context, notNow, "dismiss optional Snapchat number notice", 500, true)) return false;
    dialog = await waitFor(context, isLogoutConfirmation, 8_000);
    if (!dialog) {
      context.onLog("Snapchat account switch: logout confirmation did not appear after Not Now.");
      return false;
    }
  }

  const confirm = logoutConfirmationPoint(dialog, screen.h);
  if (!confirm || !isLogoutConfirmation(dialog)) {
    context.onLog("Snapchat account switch: the explicit logout confirmation button was not found.");
    return false;
  }
  const labelCenter = center(confirm.label);
  context.onLog(
    `Snapchat account switch: tapping the grey Log Out button at (${confirm.x}, ${confirm.y}); UI height=${confirm.uiHeight}, offset=${confirm.offsetY}, Cancel center=(${center(confirm.cancel).x}, ${center(confirm.cancel).y}), label node=(${labelCenter.x}, ${labelCenter.y}).`,
  );
  if (context.isAborted()) return false;
  await android.tap(
    context.serial,
    confirm.x,
    confirm.y,
    "bot",
    "Snapchat: confirm logout by tapping the grey Log Out button",
    "automation",
    { exact: true },
  );
  await context.sleep(500, "exact");
  if (context.isAborted()) return false;

  const accountPicker = await waitFor(context, isSavedAccountPicker, 20_000);
  if (!accountPicker) {
    context.onLog("Snapchat account switch: Snapchat did not show its saved-account selector after logout.");
    return false;
  }
  context.onLog("Snapchat account switch: logout completed; saved-account carousel is open.");
  return true;
}
