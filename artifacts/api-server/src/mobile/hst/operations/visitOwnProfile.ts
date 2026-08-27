export interface VisitOwnProfileOperationContext {
  android: {
    tapCalibratedNavigationControl(serial: string, control: "profile" | "home", onLog?: (message: string) => void): Promise<{ x: number; y: number }>;
    tap(serial: string, x: number, y: number): Promise<void>;
    dismissInstagramInterstitials(serial: string): Promise<string | null>;
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
  const profileTab = await android.tapCalibratedNavigationControl(serial, "profile", onLog);
  await hstRandomDelay(serial, 1500, 10000);

  const dismissed = await android.dismissInstagramInterstitials(serial).catch(() => null);
  if (dismissed) {
    onLog?.(`Random Jitter: dismissed contacts popup ("${dismissed}")`);
    await hstRandomDelay(serial, 2500, 10000);
  }

  onLog?.("Random Actions: ✓ visited own profile");
  await android.tapCalibratedNavigationControl(serial, "home", onLog);
  await hstRandomDelay(serial, 250, 10000);
}