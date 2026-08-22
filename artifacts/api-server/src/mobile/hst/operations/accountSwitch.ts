import type * as androidManager from "../../androidManager";

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
    const profileTab = await android.findInstagramProfileTab(serial).catch(() => null);
    if (profileTab) {
      log(`▶ Pre-switch complete: tapping Profile tab again at (${profileTab.x}, ${profileTab.y}) before account switch…`);
      await android.tap(serial, profileTab.x, profileTab.y);
      await sleepOrAbort(serial, 800);
    } else {
      log("⚠ Pre-switch complete: Profile tab was not found for the required return tap; account switch will perform its own lookup");
    }
  }

  log("[TRACE] step-1 account-switch: begin");
  if (!username) {
    log("[TRACE] step-1 account-switch: skipped-no-slot-username");
    lastActiveUsername.set(serial, lastActiveUsername.get(serial) || "");
    return false;
  }

  currentTool.set(serial, "ACCOUNT SWITCHING");
  log(`[TRACE] step-1 account-switch: target=@${username}`);
  log(`▶ Switching to Instagram account: @${username}…`);

  // Intentionally not configurable: retain the established 50/50 method mix.
  const useProfileTabLongPress = Math.random() < 0.5;
  const holdDurationMs = useProfileTabLongPress
    ? 3000 + Math.floor(Math.random() * 7001)
    : undefined;
  log(
    useProfileTabLongPress
      ? `▶ Account switch method: Profile-tab long-press (${holdDurationMs}ms hold)`
      : "▶ Account switch method: Home/top-profile",
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
    steps.push(`account-switch(@${username})`);
    lastActiveUsername.set(serial, username);
    await sleepOrAbort(serial, 1500);
    const postSwitchPopup = await android.dismissInstagramInterstitials(serial).catch(() => null);
    if (postSwitchPopup) {
      log(`▶ Dismissed post-switch popup (${postSwitchPopup})`);
      await sleepOrAbort(serial, 500);
    }
  } else {
    log("[TRACE] step-1 account-switch: failed");
    log(`✗ Account switch to @${username} failed — continuing with tools`);
    steps.push("account-switch(attempted — continuing)");
  }

  // Preserve the slot's stable identity even if the device-side switch failed.
  lastActiveUsername.set(serial, username || lastActiveUsername.get(serial) || "");
  return switched;
}