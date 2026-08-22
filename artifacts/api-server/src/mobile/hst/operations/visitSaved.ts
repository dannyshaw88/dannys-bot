export interface VisitSavedOperationContext {
  android: {
    findInstagramProfileTab(serial: string): Promise<{ x: number; y: number } | null>;
    tap(serial: string, x: number, y: number): Promise<void>;
    dismissInstagramInterstitials(serial: string): Promise<string | null>;
    findInstagramProfileOptionsButton(serial: string): Promise<{ x: number; y: number } | null>;
    findInstagramSavedRow(serial: string): Promise<{ x: number; y: number } | null>;
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
  returnToHomeSafely(serial: string): Promise<boolean>;
  rollRange(minimum: number, maximum: number): number;
  logger: { warn(payload: unknown, message: string): void };
  onLog?: (message: string) => void;
}

/** Random Actions operation: browse the active account's Saved media. */
export async function runVisitSaved(
  serial: string,
  context: VisitSavedOperationContext,
): Promise<void> {
  const { android, getScreenSize, deviceProfileSwipe, sleepOrAbort,
    returnToHomeSafely, rollRange, logger, onLog } = context;

  const profileTab = await android.findInstagramProfileTab(serial).catch(() => null);
  if (!profileTab) {
    onLog?.("Visit Saved: profile tab not found — skipping");
    logger.warn({ serial }, "[jitter-visit-saved] profile tab not found");
    return;
  }
  await android.tap(serial, profileTab.x, profileTab.y);
  await sleepOrAbort(serial, 2000 + Math.round(Math.random() * 800));

  const dismissed = await android.dismissInstagramInterstitials(serial).catch(() => null);
  if (dismissed) await sleepOrAbort(serial, 500);

  const optionsButton = await android.findInstagramProfileOptionsButton(serial).catch(() => null);
  if (!optionsButton) {
    onLog?.("Visit Saved: Options button not found — skipping");
    logger.warn({ serial }, "[jitter-visit-saved] Options/hamburger button not found");
    await returnToHomeSafely(serial);
    await sleepOrAbort(serial, 600);
    return;
  }
  await android.tap(serial, optionsButton.x, optionsButton.y);
  await sleepOrAbort(serial, 2000 + Math.round(Math.random() * 600));
  onLog?.("Visit Saved: ✓ opened Settings and activity");

  const savedRow = await android.findInstagramSavedRow(serial).catch(() => null);
  if (!savedRow) {
    onLog?.("Visit Saved: Saved row not found — skipping");
    logger.warn({ serial }, "[jitter-visit-saved] Saved row not found");
    await android.pressBack(serial);
    await sleepOrAbort(serial, 600);
    await returnToHomeSafely(serial);
    await sleepOrAbort(serial, 600);
    return;
  }
  await android.tap(serial, savedRow.x, savedRow.y);
  await sleepOrAbort(serial, 2000 + Math.round(Math.random() * 800));
  onLog?.("Visit Saved: ✓ opened Saved media page");

  const scrollCount = rollRange(1, 10);
  const { w, h } = getScreenSize(serial);
  for (let i = 0; i < scrollCount; i++) {
    await deviceProfileSwipe(serial, {
      x1: Math.round(w * 0.5), y1: Math.round(h * 0.65),
      x2: Math.round(w * 0.5), y2: Math.round(h * 0.30),
      durationMs: 380 + Math.round(Math.random() * 120),
    }, "visit-saved-scroll", "normal");
    await sleepOrAbort(serial, 500 + Math.round(Math.random() * 600));
  }
  onLog?.(`Visit Saved: ✓ scrolled ${scrollCount}×`);

  await android.pressBack(serial);
  await sleepOrAbort(serial, 600);
  await android.pressBack(serial);
  await sleepOrAbort(serial, 600);
  await returnToHomeSafely(serial);
  await sleepOrAbort(serial, 600);
  onLog?.("Visit Saved: ✓ done, returned to home feed");
}