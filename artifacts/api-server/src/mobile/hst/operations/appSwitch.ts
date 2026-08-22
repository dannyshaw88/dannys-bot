import { spawnSync } from "node:child_process";

export interface AppSwitchOperationContext {
  android: {
    openRecentApps(serial: string): Promise<void>;
    detectToolset(): { adb: { path?: string | null } };
    launchInstagram(serial: string): Promise<void>;
    swipeUpFromBottom(serial: string): Promise<void>;
  };
  sleepOrAbort(
    serial: string,
    milliseconds: number,
    category?: "globalDwell" | "accountSwitching" | "navigation" | "actionPacing" | "airplaneMode",
  ): Promise<void>;
  onLog?: (message: string) => void;
}

/**
 * Random Actions operation: briefly open the default SMS app from recents,
 * then dismiss it and return to Instagram.
 *
 * This module owns only the app-switch operation. It deliberately receives
 * device and timing services from the HST cycle instead of importing cycle
 * state or another operation's helpers.
 */
export async function runAppSwitch(
  serial: string,
  context: AppSwitchOperationContext,
): Promise<void> {
  const { android, sleepOrAbort, onLog } = context;

  await android.openRecentApps(serial);
  await sleepOrAbort(serial, 800 + Math.round(Math.random() * 400));

  const adb = android.detectToolset().adb.path ?? "";
  if (adb) {
    spawnSync(adb, [
      "-s", serial, "shell", "am", "start",
      "-a", "android.intent.action.SENDTO",
      "-d", "smsto:",
    ], { encoding: "utf8", timeout: 8000 });
  }
  onLog?.("Random Actions: ✓ opened SMS app");

  const dwellMs = 10_000 + Math.round(Math.random() * 20_000);
  onLog?.(`Random Jitter: staying in SMS for ${Math.round(dwellMs / 1000)}s…`);
  await sleepOrAbort(serial, dwellMs);

  await android.openRecentApps(serial);
  await sleepOrAbort(serial, 700 + Math.round(Math.random() * 300));
  await android.swipeUpFromBottom(serial);
  await sleepOrAbort(serial, 600 + Math.round(Math.random() * 400));
  await android.launchInstagram(serial);
  await sleepOrAbort(serial, 1500 + Math.round(Math.random() * 500));

  onLog?.("Random Actions: ✓ returned to Instagram after app switch");
}