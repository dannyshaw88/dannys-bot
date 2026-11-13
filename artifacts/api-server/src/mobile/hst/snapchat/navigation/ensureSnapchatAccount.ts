import * as android from "../../../androidManager";
import type { SnapchatContext, UiState } from "../context";
import { dump, shortResourceId, tapNode } from "../runtime";
import { tapSnapchatStartupPopupIfPresent } from "./dismissNotificationPermission";
import { logoutSnapchatAccount } from "./logoutSnapchatAccount";
import {
  isSnapchatCameraSurface,
  isSnapchatProfileSurface,
  openSnapchatProfile,
} from "./openSnapchatProfile";
import {
  isSavedSnapchatAccountPicker,
  selectSnapchatAccountFromCarousel,
} from "./selectSnapchatAccount";

function normalizeUsername(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function profileUsername(state: UiState): string | null {
  const explicit = state.nodes.find(node => shortResourceId(node) === "profile-username");
  const value = explicit?.text.trim() || explicit?.desc.trim();
  return value ? value.replace(/^@/, "").trim() : null;
}

async function waitForKnownSurface(
  context: SnapchatContext,
  timeoutMs: number,
  timeoutLabel?: string,
  recoverToCameraFromOtherTab = false,
  startupPopupTapSentBeforeWait = false,
): Promise<UiState | null> {
  const deadline = Date.now() + timeoutMs;
  let lastState: UiState | null = null;
  let cameraTabRecoveryAttempted = false;
  let startupPopupButtonMissingLogged = false;
  let startupPopupTapSent = startupPopupTapSentBeforeWait;
  while (!context.isAborted() && Date.now() < deadline) {
    const state = await dump(context.serial);
    lastState = state;
    const popupResult = startupPopupTapSent
      ? "not-present"
      : await tapSnapchatStartupPopupIfPresent(context, state);
    if (popupResult === "tapped") {
      startupPopupTapSent = true;
      await context.sleep(300, "exact");
      continue;
    }
    if (popupResult === "aborted") return null;
    if (popupResult === "button-missing") {
      if (!startupPopupButtonMissingLogged) {
        context.onLog(
          "Snapchat account check: notification permission dialog is present; waiting for its Deny/Don't allow button before account and banner checks.",
        );
        startupPopupButtonMissingLogged = true;
      }
      await context.sleep(300, "exact");
      continue;
    }
    if (
      isSnapchatCameraSurface(state) ||
      isSnapchatProfileSurface(state) ||
      isSavedSnapchatAccountPicker(state)
    ) return state;
    if (recoverToCameraFromOtherTab && !cameraTabRecoveryAttempted) {
      const cameraTab = state.nodes.find(node =>
        node.clickable && shortResourceId(node) === "ngs_camera_icon_container",
      );
      if (cameraTab) {
        cameraTabRecoveryAttempted = true;
        context.onLog("Snapchat account check: another Snapchat tab is open; tapping its live Camera tab before verifying this slot.");
        if (!await tapNode(context, cameraTab, "return to Camera before Snapchat account verification", 500, true)) {
          context.onLog("Snapchat account check: the Camera tab tap did not complete.");
        }
      }
    }
    await context.sleep(500, "exact");
  }
  if (timeoutLabel && !context.isAborted()) {
    const packages = [...new Set(
      (lastState?.nodes ?? []).map(node => node.packageName.trim()).filter(Boolean),
    )].slice(0, 3);
    const resourceIds = [...new Set(
      (lastState?.nodes ?? []).map(shortResourceId).filter(Boolean),
    )].slice(0, 8);
    context.onLog(
      `Snapchat account check: timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${timeoutLabel}; ` +
      `last package(s)=${packages.join(", ") || "none"}, ` +
      `resource IDs=${resourceIds.join(", ") || "none"}, nodes=${lastState?.nodes.length ?? 0}.`,
    );
  }
  return null;
}

export async function ensureSnapchatAccount(
  context: SnapchatContext,
  startupPopupTapSent = false,
): Promise<boolean> {
  const expectedUsername = context.targetUsername?.trim() ?? "";
  if (!expectedUsername) {
    context.onLog("Snapchat tools not started: this slot has no configured Snapchat username to verify.");
    return false;
  }

  try {
    let state = await waitForKnownSurface(
      context,
      20_000,
      "the launched app's account screen",
      true,
      startupPopupTapSent,
    );
    if (!state) {
      context.onLog("Snapchat tools not started: the launched app did not reach a known account screen.");
      return false;
    }

    if (isSavedSnapchatAccountPicker(state)) {
      context.onLog(`Snapchat account check: signed-out account screen found; looking for @${expectedUsername}.`);
      if (!await selectSnapchatAccountFromCarousel(context, expectedUsername)) return false;
      context.onLog(`Snapchat account check: @${expectedUsername} was selected and Camera is ready; starting this slot's tools without reopening the profile.`);
      return true;
    }

    const profile = isSnapchatProfileSurface(state) ? state : await openSnapchatProfile(context, state);
    if (!profile) {
      context.onLog("Snapchat tools not started: could not confirm the active Snapchat profile.");
      return false;
    }
    const actualUsername = profileUsername(profile);
    if (!actualUsername) {
      context.onLog("Snapchat tools not started: Snapchat's profile Username field was not exposed.");
      return false;
    }

    if (normalizeUsername(actualUsername) === normalizeUsername(expectedUsername)) {
      context.onLog(`Snapchat account check: @${actualUsername} already matches this slot; no logout needed.`);
      await android.pressBack(context.serial);
      const camera = await waitForKnownSurface(context, 10_000, undefined, false, true);
      if (camera && isSnapchatCameraSurface(camera)) {
        context.onLog("Snapchat account check: Camera is ready for this slot's tools.");
        return true;
      }
      context.onLog("Snapchat tools not started: Android Back did not return to Camera.");
      return false;
    }

    context.onLog(`Snapchat account check: slot expects @${expectedUsername}; current profile is @${actualUsername}.`);
    if (!await logoutSnapchatAccount(context, profile)) return false;
    if (!await selectSnapchatAccountFromCarousel(context, expectedUsername)) return false;
    context.onLog(`Snapchat account check: @${expectedUsername} was selected and Camera is ready; starting this slot's tools without reopening the profile.`);
    return true;
  } catch (error) {
    context.onLog(`Snapchat tools not started: account verification/switch failed (${error instanceof Error ? error.message : String(error)}).`);
    return false;
  }
}
