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

function logoutConfirmationButton(state: UiState): UiNode | undefined {
  return state.nodes.find(node => node.clickable && exactLabel(node, "Log Out"));
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
  if (!await tapNode(context, gear, "open Snapchat profile settings", 500, true)) return false;

  state = await waitFor(context, isSettingsPage, 10_000) ?? await dump(context.serial);
  if (!isSettingsPage(state)) {
    context.onLog("Snapchat account switch: Settings page was not confirmed.");
    return false;
  }

  const screen = android.getScreenSize(context.serial);
  let logoutRow: UiNode | undefined;
  let bottomConfirmed = false;
  const seenScrollStates = new Set<string>();
  for (let swipe = 0; swipe < 14 && !context.isAborted(); swipe++) {
    state = await dump(context.serial);
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
    context.onLog(`Snapchat account switch: scrolling Settings toward the bottom (${swipe + 1}/14).`);
    await android.swipe(context.serial, startX, startY, startX, endY, 650, false);
    await context.sleep(400, "exact");
    const after = await dump(context.serial);
    if (!isSettingsPage(after)) {
      context.onLog("Snapchat account switch: Settings changed during the scroll; stopping before Logout.");
      return false;
    }
    const afterSignature = scrollSignature(after);
    logoutRow = visibleLogoutRow(after, screen.h);
    if (afterSignature === beforeSignature) {
      const bounds = container.bounds;
      const nearBottom = Boolean(logoutRow) &&
        center(logoutRow!).y >= bounds[3] - (bounds[3] - bounds[1]) * 0.14;
      if (logoutRow && (nearBottom || hasSettingsBottomMarker(after, screen.h))) {
        context.onLog("Snapchat account switch: Log Out is visible and the Settings scroll is at its bottom.");
        bottomConfirmed = true;
        state = after;
        break;
      }
      context.onLog("Snapchat account switch: Settings did not move and the bottom was not confirmed.");
      return false;
    }
    if (seenScrollStates.has(afterSignature)) {
      context.onLog("Snapchat account switch: Settings scroll repeated an earlier position before reaching the bottom.");
      return false;
    }
    seenScrollStates.add(beforeSignature);
    if (logoutRow && hasSettingsBottomMarker(after, screen.h)) {
      // The footer is only exposed once the list reaches its end. Make one
      // additional upward swipe; an unchanged tree then confirms the bottom.
      state = after;
      continue;
    }
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
    const notNow = dialog.nodes.find(node => node.clickable && exactLabel(node, "Not Now"));
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

  const confirm = logoutConfirmationButton(dialog);
  if (!confirm || !isLogoutConfirmation(dialog)) {
    context.onLog("Snapchat account switch: the explicit logout confirmation button was not found.");
    return false;
  }
  context.onLog("Snapchat account switch: confirming Log Out.");
  if (!await tapNode(context, confirm, "confirm Snapchat logout", 500, true)) return false;

  const accountPicker = await waitFor(context, isSavedAccountPicker, 20_000);
  if (!accountPicker) {
    context.onLog("Snapchat account switch: Snapchat did not show its saved-account selector after logout.");
    return false;
  }
  context.onLog("Snapchat account switch: logout completed; saved-account carousel is open.");
  return true;
}
