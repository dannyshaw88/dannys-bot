import type * as androidManager from "../../androidManager";
import { logger } from "../../../lib/logger";

export interface ManualProfileTabLongPressOperationContext {
  android: typeof androidManager;
  serial: string;
}

export type ManualProfileTabLongPressResult =
  | { ok: true; dispatched: true; target: "profile-tab"; node: { x: number; y: number } }
  | { ok: false; status: 404; error: string };

/**
 * Resolve the calibrated Instagram Profile control and open the account switcher.
 *
 * This is kept separate from the generic manual long-press operation because
 * the account-switch gesture must target the device calibration map, rather
 * than a coordinate supplied by the mirrored screen.
 */
export async function runManualProfileTabLongPress(
  context: ManualProfileTabLongPressOperationContext,
): Promise<ManualProfileTabLongPressResult> {
  const { android, serial } = context;
  logger.info({ serial }, "[manual-account-switch] resolving profile tab before long-press");
  const profileTab = android.getCalibratedNavigationControl(serial, "profile");

  logger.info({ serial, profileTab }, "[manual-account-switch] calibrated profile target resolved; dispatching long-press");
  const holdDurationMs = 2000 + Math.floor(Math.random() * 3001);
  await android.swipe(serial, profileTab.x, profileTab.y, profileTab.x, profileTab.y, holdDurationMs);
  logger.info({ serial, profileTab, holdDurationMs }, "[manual-account-switch] long-press dispatched");
  return { ok: true, dispatched: true, target: "profile-tab", node: profileTab };
}

export interface AccountSwitchOperationContext {
  android: typeof androidManager;
  serial: string;
  username: string;
  launchXml?: string;
  adsChoiceDismissed: boolean;
  launchPopup: string | null;
  preSwitchActionsRan: boolean;
  steps: string[];
  log: (message: string) => void;
  sleepOrAbort: (serial: string, ms: number) => Promise<void>;
  lastActiveUsername: Map<string, string>;
  currentTool: Map<string, string>;
  swipeGesture?: Parameters<typeof androidManager.switchToInstagramAccount>[4];
}

/**
 * Selects and activates the account assigned to one automation slot.
 *
 * This is deliberately an orchestration operation: androidManager owns the
 * low-level account-switcher gestures and accessibility polling, while this
 * operation owns cycle state, method selection, memory, and settling.
 */
export async function runAccountSwitch(context: AccountSwitchOperationContext): Promise<boolean> {
  const {
    android, serial, username, launchXml, adsChoiceDismissed, launchPopup,
    preSwitchActionsRan, steps, log,
    sleepOrAbort, lastActiveUsername, currentTool, swipeGesture,
  } = context;

  // Pre-switch tools may leave Instagram on Stories, Reels, Inbox, or another
  // nested surface. Return to the live Profile tab before opening the switcher.
  if (preSwitchActionsRan) {
    const profileTab = await android.tapCalibratedNavigationControl(serial, "profile", log);
    log(`▶ Pre-switch complete: tapped calibrated Profile tab at (${profileTab.x}, ${profileTab.y}) before account switch…`);
    await sleepOrAbort(serial, 800);
  }

  log("[TRACE] step-1 account-switch: begin");
  logger.info({ serial, username: username || null }, "[account-switch] begin");
  if (!username) {
    log("[TRACE] step-1 account-switch: skipped-no-slot-username");
    logger.warn({ serial }, "[account-switch] skipped: slot has no username");
    lastActiveUsername.set(serial, lastActiveUsername.get(serial) || "");
    return false;
  }

  currentTool.set(serial, "ACCOUNT SWITCHING");
  log(`[TRACE] step-1 account-switch: target=@${username}`);
  log(`▶ Switching to Instagram account: @${username}…`);

  // Intentionally not configurable: retain the established 50/50 method mix.
  const useProfileTabLongPress = Math.random() < 0.5;
  const holdDurationMs = useProfileTabLongPress
    ? 2000 + Math.floor(Math.random() * 3001)
    : undefined;
  log(
    useProfileTabLongPress
      ? `▶ Account switch method: Profile-tab long-press (${holdDurationMs}ms hold)`
      : "▶ Account switch method: Home/top-profile",
  );
  logger.info(
    {
      serial,
      username,
      method: useProfileTabLongPress ? "profile-tab-long-press" : "home-top-profile",
      holdDurationMs: holdDurationMs ?? null,
    },
    "[account-switch] dispatching low-level switch",
  );

  const switched = await android.switchToInstagramAccount(
    serial,
    username,
    log,
    (!adsChoiceDismissed && !launchPopup) ? launchXml : undefined,
    swipeGesture,
    useProfileTabLongPress
      ? { useProfileTabLongPress: true, holdDurationMs: holdDurationMs! }
      : undefined,
  );
  if (switched) {
    log("[TRACE] step-1 account-switch: confirmed");
    logger.info({ serial, username }, "[account-switch] confirmed");
    steps.push(`account-switch(@${username})`);
    lastActiveUsername.set(serial, username);
    const postSwitchPopup = await android.dismissInstagramInterstitials(serial).catch(() => null);
    if (postSwitchPopup) {
      log(`▶ Dismissed post-switch popup (${postSwitchPopup})`);
      await sleepOrAbort(serial, 500);
    }
  } else {
    log("[TRACE] step-1 account-switch: failed");
    logger.warn({ serial, username }, "[account-switch] returned false");
    log(`✗ Account switch to @${username} failed — continuing with tools`);
    steps.push("account-switch(attempted — continuing)");
  }

  // Preserve the slot's stable identity even if the device-side switch failed.
  lastActiveUsername.set(serial, username || lastActiveUsername.get(serial) || "");
  return switched;
}