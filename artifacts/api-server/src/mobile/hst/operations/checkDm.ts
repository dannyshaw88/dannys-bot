export interface CheckDmOperationContext {
  android: {
    findInstagramDmTab(serial: string): Promise<{ x: number; y: number } | null>;
    tap(serial: string, x: number, y: number): Promise<void>;
    dismissInstagramInterstitials(serial: string): Promise<string | null>;
    findDmConversationItem(serial: string): Promise<{ x: number; y: number } | null>;
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
  rollRange(minimum: number, maximum: number): number;
  logger: { warn(payload: unknown, message: string): void };
  onLog?: (message: string) => void;
}

/** Check Inbox operation: browse the DM inbox and optionally open one thread. */
export async function runCheckDmLoop(
  serial: string,
  options: {
    scrollsMin: number;
    scrollsMax: number;
    clickPctMin: number;
    clickPctMax: number;
  },
  context: CheckDmOperationContext,
): Promise<void> {
  const { android, getScreenSize, deviceProfileSwipe, sleepOrAbort,
    rollRange, logger, onLog } = context;
  const { scrollsMin, scrollsMax, clickPctMin, clickPctMax } = options;

  const dmTab = await android.findInstagramDmTab(serial).catch(() => null);
  if (!dmTab) {
    onLog?.("Check Inbox: DM icon not found — skipping");
    logger.warn({ serial }, "[check-dm] DM icon not found by scan");
    return;
  }
  await android.tap(serial, dmTab.x, dmTab.y);
  await sleepOrAbort(serial, 2000);
  const dismissed = await android.dismissInstagramInterstitials(serial).catch(() => null);
  if (dismissed) {
    onLog?.(`Check Inbox: dismissed popup ("${dismissed}")`);
    await sleepOrAbort(serial, 600);
  }
  onLog?.("Check Inbox: ✓ opened DM inbox");

  const scrollCount = rollRange(scrollsMin, scrollsMax);
  const { w, h } = getScreenSize(serial);
  for (let i = 0; i < scrollCount; i++) {
    await deviceProfileSwipe(serial, {
      x1: Math.round(w * 0.5), y1: Math.round(h * 0.65),
      x2: Math.round(w * 0.5), y2: Math.round(h * 0.30),
      durationMs: 380 + Math.round(Math.random() * 120),
    }, "check-dm-scroll", "normal");
    await sleepOrAbort(serial, 500 + Math.round(Math.random() * 500));
  }

  const clickChance = rollRange(clickPctMin, clickPctMax) / 100;
  if (clickChance > 0 && Math.random() < clickChance) {
    const item = await android.findDmConversationItem(serial).catch(() => null);
    if (item) {
      await android.tap(serial, item.x, item.y);
      onLog?.("Check Inbox: ✓ opened conversation thread");
      await sleepOrAbort(serial, 2000 + Math.round(Math.random() * 1500));
      await android.pressBack(serial);
      await sleepOrAbort(serial, 600);
    } else {
      onLog?.("Check Inbox: no conversation thread found — skipping tap");
    }
  } else {
    onLog?.("Check Inbox: click-thread roll missed — skipping");
  }

  await android.pressBack(serial);
  await sleepOrAbort(serial, 800);
  onLog?.("Check Inbox: ✓ DM inbox check done");
}