export interface VisitSettingsOperationContext {
  android: {
    tapCalibratedNavigationControl(serial: string, control: "profile" | "settingsBack", onLog?: (message: string) => void): Promise<{ x: number; y: number }>;
    tap(serial: string, x: number, y: number): Promise<void>;
    dismissInstagramInterstitials(serial: string): Promise<string | null>;
    findInstagramProfileOptionsButton(serial: string): Promise<{ x: number; y: number } | null>;
    findInstagramSettingsRow(serial: string): Promise<{ x: number; y: number; label: string } | null>;
    confirmInstagramSettingsRowOpened(serial: string, selectedLabel: string): Promise<boolean>;
    dismissInstagramTabletAppPopup(serial: string, onLog?: (message: string) => void): Promise<boolean>;
    pressBack(serial: string): Promise<void>;
  };
  getScreenSize(serial: string): { w: number; h: number };
  deviceProfileSwipe(
    serial: string,
    gesture: { x1: number; y1: number; x2: number; y2: number; durationMs: number },
    label: string,
    mode: "normal",
  ): Promise<void>;
  sleepOrAbort(serial: string, milliseconds: number): Promise<void>;
  logger: { warn(payload: unknown, message: string): void };
  onLog?: (message: string) => void;
}

/** Random Actions operation: open one validated top-level Settings row. */
export async function runVisitSettings(
  serial: string,
  context: VisitSettingsOperationContext,
): Promise<boolean> {
  const { android, getScreenSize, deviceProfileSwipe,
    sleepOrAbort, logger, onLog } = context;

  const profileTab = await android.tapCalibratedNavigationControl(serial, "profile", onLog);
  onLog?.(`Visit Settings: tapping Profile tab first at (${profileTab.x},${profileTab.y})`);
  await sleepOrAbort(serial, 2000 + Math.round(Math.random() * 800));

  const dismissed = await android.dismissInstagramInterstitials(serial).catch(() => null);
  if (dismissed) await sleepOrAbort(serial, 500);

  const optionsButton = await android.findInstagramProfileOptionsButton(serial).catch(() => null);
  if (!optionsButton) {
    onLog?.("Visit Settings: Options button not found — skipping");
    logger.warn({ serial }, "[jitter-visit-settings] Options/hamburger button not found");
    return false;
  }
  await android.tap(serial, optionsButton.x, optionsButton.y);
  await sleepOrAbort(serial, 2500);
  onLog?.("Visit Settings: ✓ opened Settings and activity");

  const settingsRow = await android.findInstagramSettingsRow(serial).catch(() => null);
  if (!settingsRow) {
    onLog?.("Visit Settings: no validated settings row found — skipping");
    logger.warn({ serial }, "[jitter-visit-settings] no validated settings row");
    await android.pressBack(serial);
    return false;
  }
  onLog?.(`Visit Settings: selected interactive row "${settingsRow.label}" at (${settingsRow.x},${settingsRow.y})`);
  await android.tap(serial, settingsRow.x, settingsRow.y);
  await sleepOrAbort(serial, 1200 + Math.round(Math.random() * 600));
  // One fresh dump is required to prove that the tap navigated. Do not retry
  // it: repeated UIAutomator dumps add unnecessary dwell to every cycle.
  const rowOpened = await android.confirmInstagramSettingsRowOpened(serial, settingsRow.label).catch(() => false);
  if (!rowOpened) {
    onLog?.(`Visit Settings: row tap not confirmed (${settingsRow.label}) — stopping without two-Back cleanup`);
    logger.warn({ serial, label: settingsRow.label }, "[jitter-visit-settings] row tap not confirmed");
    // We know we are still on the top-level Settings screen (or the tap was
    // ambiguous), so one semantic Back is the maximum safe cleanup. Never
    // issue the two visual Backs reserved for a confirmed detail page.
    await android.pressBack(serial);
    await sleepOrAbort(serial, 800);
    return false;
  }
  onLog?.(`Visit Settings: ✓ opened selected setting row (${settingsRow.label})`);

  if (/^Instagram for tablets$/i.test(settingsRow.label.trim())) {
    const popupDismissed = await android.dismissInstagramTabletAppPopup(
      serial,
      message => onLog?.(message),
    ).catch(() => false);
    if (popupDismissed) onLog?.("Visit Settings: ✓ tablet-app popup dismissed");
  }

  const { w, h } = getScreenSize(serial);
  if (Math.random() < 0.5) {
    await deviceProfileSwipe(serial, {
      x1: Math.round(w * 0.5), y1: Math.round(h * 0.68),
      x2: Math.round(w * 0.5), y2: Math.round(h * 0.34),
      durationMs: 420 + Math.round(Math.random() * 120),
    }, "visit-settings-scroll", "normal");
    await sleepOrAbort(serial, 500 + Math.round(Math.random() * 400));
    onLog?.("Visit Settings: ✓ scrolled once");
  }

  const settingsBack = await android.tapCalibratedNavigationControl(serial, "settingsBack", onLog);
  await sleepOrAbort(serial, 800);
   onLog?.(`Visit Settings: ✓ tapped calibrated Instagram Settings Back button at (${settingsBack.x},${settingsBack.y}) — returning from selected setting`);

   // A random top-level row opens a second Instagram surface. The first Back
   // exits that selected setting to "Settings and activity"; the second Back
   // exits "Settings and activity" back to the profile/home flow.
   const settingsListBack = await android.tapCalibratedNavigationControl(serial, "settingsBack", onLog);
   await sleepOrAbort(serial, 800);
   onLog?.(`Visit Settings: ✓ tapped calibrated Instagram Settings Back button at (${settingsListBack.x},${settingsListBack.y}) — leaving Settings and activity`);
   onLog?.("Visit Settings: ✓ done after two visual Backs");
    return true;
}