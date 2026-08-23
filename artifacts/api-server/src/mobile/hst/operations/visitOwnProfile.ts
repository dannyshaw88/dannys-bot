export interface VisitOwnProfileOperationContext {
  android: {
    findInstagramProfileTab(serial: string): Promise<{ x: number; y: number } | null>;
    tap(serial: string, x: number, y: number, source?: "manual" | "bot" | "fixed"): Promise<void>;
    dismissInstagramInterstitials(serial: string): Promise<string | null>;
    findHomeTab(serial: string): Promise<{ x: number; y: number } | null>;
    pressBack(serial: string): Promise<void>;
  };
  hstRandomDelay(serial: string, minimumMs: number, maximumMs: number): Promise<void>;
  logger: { warn(payload: unknown, message: string): void };
  onLog?: (message: string) => void;
}

/** Random Actions operation: visit the active account's profile and return home. */
export async function runVisitOwnProfile(
  serial: string,
  context: VisitOwnProfileOperationContext,
): Promise<void> {
  const { android, hstRandomDelay, logger, onLog } = context;
  const profileTab = await android.findInstagramProfileTab(serial).catch(() => null);
  if (!profileTab) {
    onLog?.("Random Actions: profile tab not found — skipping visit profile");
    logger.warn({ serial }, "[jitter-visit-profile] profile tab not found by scan");
    return;
  }
  await android.tap(serial, profileTab.x, profileTab.y, "fixed");
  await hstRandomDelay(serial, 1500, 10000);

  const dismissed = await android.dismissInstagramInterstitials(serial).catch(() => null);
  if (dismissed) {
    onLog?.(`Random Jitter: dismissed contacts popup ("${dismissed}")`);
    await hstRandomDelay(serial, 2500, 10000);
  }

  onLog?.("Random Actions: ✓ visited own profile");
  const homeTab = await android.findHomeTab(serial).catch(() => null);
  if (homeTab) {
    await android.tap(serial, homeTab.x, homeTab.y);
  } else {
    await android.pressBack(serial);
  }
  await hstRandomDelay(serial, 250, 10000);
}