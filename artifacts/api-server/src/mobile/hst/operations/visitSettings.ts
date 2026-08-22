export interface VisitSettingsOperationContext {
  android: {
    findInstagramProfileTab(serial: string): Promise<{ x: number; y: number } | null>;
    tap(serial: string, x: number, y: number): Promise<void>;
    dismissInstagramInterstitials(serial: string): Promise<string | null>;
    findInstagramProfileOptionsButton(serial: string): Promise<{ x: number; y: number } | null>;
    findInstagramSettingsRow(serial: string): Promise<{ x: number; y: number; label: string } | null>;
    dismissInstagramTabletAppPopup(serial: string, onLog?: (message: string) => void): Promise<boolean>;
    pressBack(serial: string): Promise<void>;
  };
  getScreenSize(serial: string): { w: number; h: number };
  getDeviceDensity(serial: string): Promise<number>;
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
): Promise<void> {
  const { android, getScreenSize, getDeviceDensity, deviceProfileSwipe,
    sleepOrAbort, logger, onLog } = context;

  const profileTab = await android.findInstagramProfileTab(serial).catch(() => null);
  if (!profileTab) {
    onLog?.("Visit Settings: profile tab not found — skipping");
    logger.warn({ serial }, "[jitter-visit-settings] profile tab not found");
    return;
  }
  await android.tap(serial, profileTab.x, profileTab.y);
  await sleepOrAbort(serial, 2000 + Math.round(Math.random() * 800));

  const dismissed = await android.dismissInstagramInterstitials(serial).catch(() => null);
  if (dismissed) await sleepOrAbort(serial, 500);

  const optionsButton = await android.findInstagramProfileOptionsButton(serial).catch(() => null);
  if (!optionsButton) {
    onLog?.("Visit Settings: Options button not found — skipping");
    logger.warn({ serial }, "[jitter-visit-settings] Options/hamburger button not found");
    return;
  }
  await android.tap(serial, optionsButton.x, optionsButton.y);
  await sleepOrAbort(serial, 2000 + Math.round(Math.random() * 600));
  onLog?.("Visit Settings: ✓ opened Settings and activity");

  const settingsRow = await android.findInstagramSettingsRow(serial).catch(() => null);
  if (!settingsRow) {
    onLog?.("Visit Settings: no validated settings row found — skipping");
    logger.warn({ serial }, "[jitter-visit-settings] no validated settings row");
    await android.pressBack(serial);
    return;
  }
  await android.tap(serial, settingsRow.x, settingsRow.y);
  await sleepOrAbort(serial, 1200 + Math.round(Math.random() * 600));
  onLog?.(`Visit Settings: ✓ tapped one setting row (${settingsRow.label})`);

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

  const density = await getDeviceDensity(serial).catch(() => 160);
  const dp = density / 160;
  const topLeftBackX = Math.max(1, Math.round(24 * dp));
  const topLeftBackY = Math.max(1, Math.round(48 * dp));
  await android.tap(serial, topLeftBackX, topLeftBackY);
  await sleepOrAbort(serial, 800);
  onLog?.(`Visit Settings: ✓ tapped upper-left Back button at (${topLeftBackX},${topLeftBackY})`);
  onLog?.("Visit Settings: ✓ done after one visual Back");
}