import * as android from "../../../androidManager";
import type { SnapchatContext, UiState } from "../context";
import { dump, shortResourceId } from "../runtime";
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

async function waitForKnownSurface(context: SnapchatContext, timeoutMs: number): Promise<UiState | null> {
  const deadline = Date.now() + timeoutMs;
  while (!context.isAborted() && Date.now() < deadline) {
    const state = await dump(context.serial);
    if (
      isSnapchatCameraSurface(state) ||
      isSnapchatProfileSurface(state) ||
      isSavedSnapchatAccountPicker(state)
    ) return state;
    await context.sleep(500, "exact");
  }
  return null;
}

export async function ensureSnapchatAccount(context: SnapchatContext): Promise<boolean> {
  const expectedUsername = context.targetUsername?.trim() ?? "";
  if (!expectedUsername) {
    context.onLog("Snapchat tools not started: this slot has no configured Snapchat username to verify.");
    return false;
  }

  try {
    let state = await waitForKnownSurface(context, 20_000);
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
      const camera = await waitForKnownSurface(context, 10_000);
      if (camera && isSnapchatCameraSurface(camera)) {
        context.onLog("Snapchat account check: Camera is ready for this slot's tools.");
        return true;
      }
      context.onLog("Snapchat tools not started: Android Back did not return to Camera.");
      return false;
    }

    context.onLog(`Snapchat account check: slot expects @${expectedUsername}; current profile is @${actualUsername}.`);
    if (!await logoutSnapchatAccount(context)) return false;
    if (!await selectSnapchatAccountFromCarousel(context, expectedUsername)) return false;
    context.onLog(`Snapchat account check: @${expectedUsername} was selected and Camera is ready; starting this slot's tools without reopening the profile.`);
    return true;
  } catch (error) {
    context.onLog(`Snapchat tools not started: account verification/switch failed (${error instanceof Error ? error.message : String(error)}).`);
    return false;
  }
}
