export interface CheckNotificationsOperationContext {
  android: {
    tapCalibratedNavigationControl(serial: string, control: "home" | "notifications" | "settingsBack", onLog?: (message: string) => void): Promise<{ x: number; y: number }>;
    tap(serial: string, x: number, y: number): Promise<void>;
    findRandomNotificationItem(serial: string): Promise<{ x: number; y: number } | null>;
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
  hstRandomDelay(serial: string, minimumMs: number, maximumMs: number): Promise<void>;
  rollRange(minimum: number, maximum: number): number;
  logger: { warn(payload: unknown, message: string): void };
  onLog?: (message: string) => void;
}

/** Random Actions operation: inspect notifications and optionally open one item. */
export async function runCheckNotifications(
  serial: string,
  options: {
    scrollsMin: number;
    scrollsMax: number;
    clickPctMin: number;
    clickPctMax: number;
  },
  context: CheckNotificationsOperationContext,
): Promise<void> {
  const { android, getScreenSize, deviceProfileSwipe, sleepOrAbort,
    hstRandomDelay, rollRange, logger, onLog } = context;
  const { scrollsMin, scrollsMax, clickPctMin, clickPctMax } = options;

  const homeTab = await android.tapCalibratedNavigationControl(serial, "home", onLog);
  onLog?.(`Random Actions: tapping Home before notifications at (${homeTab.x},${homeTab.y})`);
  await sleepOrAbort(serial, 1000);

  const icon = await android.tapCalibratedNavigationControl(serial, "notifications", onLog);
  await hstRandomDelay(serial, 1500, 10000);
  onLog?.("Random Actions: ✓ opened notifications");

  const scrollCount = rollRange(scrollsMin, scrollsMax);
  const { w, h } = getScreenSize(serial);
  for (let i = 0; i < scrollCount; i++) {
    await deviceProfileSwipe(serial, {
      x1: Math.round(w * 0.5), y1: Math.round(h * 0.65),
      x2: Math.round(w * 0.5), y2: Math.round(h * 0.30),
      durationMs: 380 + Math.round(Math.random() * 120),
    }, "check-notifications-scroll", "normal");
    await sleepOrAbort(serial, 500 + Math.round(Math.random() * 500));
  }

  const clickChance = rollRange(clickPctMin, clickPctMax) / 100;
  if (clickChance > 0 && Math.random() < clickChance) {
    const item = await android.findRandomNotificationItem(serial).catch(() => null);
    if (item) {
      await android.tap(serial, item.x, item.y);
      onLog?.("Random Actions: ✓ tapped notification item");
      await sleepOrAbort(serial, 2000 + Math.round(Math.random() * 1500));
      await android.tapCalibratedNavigationControl(serial, "settingsBack", onLog);
      await hstRandomDelay(serial, 2500, 10000);
    } else {
      onLog?.("Random Actions: no clickable notification row found — skipping click");
    }
  } else {
    onLog?.("Random Actions: click-notification roll missed — skipping click");
  }

  await android.tapCalibratedNavigationControl(serial, "settingsBack", onLog);
  await hstRandomDelay(serial, 2500, 10000);
  onLog?.("Random Actions: ✓ notifications check done");
}