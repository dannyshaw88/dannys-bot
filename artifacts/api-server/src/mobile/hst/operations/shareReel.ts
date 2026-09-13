export interface ShareReelSource {
  type: "link";
  value: string;
}

export interface ShareReelOperationContext {
  android: {
    openInstagramUrl(serial: string, url: string): Promise<void>;
    dumpUi(serial: string): Promise<string>;
    findReelActionIcons(
      serial: string,
      onLog?: (message: string) => void,
      options?: { uiXml?: string },
    ): Promise<{ shareFeed: { x: number; y: number } | null } | null>;
    findButtonByLabel(serial: string, label: string): Promise<{ x: number; y: number } | null>;
    tap(serial: string, x: number, y: number): Promise<void>;
    pressBack(serial: string): Promise<void>;
  };
  sleepOrAbort: (serial: string, milliseconds: number) => Promise<void>;
  rollRange: (minimum: number, maximum: number) => number;
  isCycleAborted?: (serial: string) => boolean;
  logger: { warn(payload: unknown, message: string): void };
  onProcessed: (serial: string, slotIdx: number, url: string) => void | Promise<void>;
  slotIdx: number;
}

function normalizeReelUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return null;
    if (!/^(?:www\.)?instagram\.com$/i.test(parsed.hostname)) return null;
    if (!/^\/reel\/[^/]+\/?$/i.test(parsed.pathname)) return null;
    parsed.hostname = "www.instagram.com";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") + "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function isReelViewerXml(xml: string): boolean {
  return xml.includes("com.instagram.android") &&
    !xml.includes("task_view_thumbnail") &&
    !xml.includes("recents_container") &&
    (
      /reel_viewer|reels_feed_media_view|clips_author_username|repost_button|reposts_ufi_icon/.test(xml)
    );
}

/**
 * Standalone Share Reel tool.
 *
 * It opens each configured Instagram Reel URL directly, resolves the live
 * repost/share-to-feed action from that Reel's accessibility tree, and taps
 * only that action. It deliberately does not enter the Reels tab or reuse the
 * View Reels scrolling/action loop.
 */
export async function runShareReel(
  serial: string,
  params: {
    sources: ShareReelSource[];
    processedLinks?: string[];
    processMin: number;
    processMax: number;
    onLog?: (message: string) => void;
  },
  context: ShareReelOperationContext,
): Promise<{ processed: number; skipped: number }> {
  const { android, sleepOrAbort, rollRange, isCycleAborted, logger, onProcessed, slotIdx } = context;
  const { sources, processedLinks = [], processMin, processMax, onLog } = params;
  const processed = new Set(processedLinks.map(normalizeReelUrl).filter((url): url is string => Boolean(url)));
  const available = [...new Set(
    sources
      .map(source => normalizeReelUrl(source.value))
      .filter((url): url is string => Boolean(url)),
  )].filter(url => !processed.has(url));

  if (!available.length) {
    onLog?.("Share Reel: no unvisited Reel links are available for this account slot");
    return { processed: 0, skipped: sources.length };
  }

  const requested = Math.max(0, Math.floor(rollRange(processMin, processMax)));
  const selected = available
    .sort(() => Math.random() - 0.5)
    .slice(0, requested);
  onLog?.(`Share Reel: selected ${selected.length}/${available.length} unvisited Reel link(s)`);

  let completed = 0;
  for (const url of selected) {
    if (isCycleAborted?.(serial)) throw new Error("cycle-aborted");
    onLog?.(`Share Reel: opening ${url}`);
    try {
      await android.openInstagramUrl(serial, url);

      let reelXml = "";
      for (let attempt = 0; attempt < 6; attempt++) {
        await sleepOrAbort(serial, attempt === 0 ? 2500 : 1500);
        reelXml = await android.dumpUi(serial).catch(() => "");
        if (isReelViewerXml(reelXml)) break;
      }
      if (!isReelViewerXml(reelXml)) {
        onLog?.("Share Reel: Reel viewer was not confirmed after opening the link — skipping");
        logger.warn({ serial, url }, "[share-reel] Reel viewer was not confirmed");
        continue;
      }

      const icons = await android.findReelActionIcons(
        serial,
        message => onLog?.(`  ${message}`),
        { uiXml: reelXml },
      ).catch(() => null);
      if (!icons?.shareFeed) {
        onLog?.("Share Reel: Share to Feed icon was not found — skipping link");
        logger.warn({ serial, url }, "[share-reel] Share to Feed icon was not found");
        continue;
      }

      onLog?.(`Share Reel: tapping Share to Feed at (${icons.shareFeed.x},${icons.shareFeed.y})`);
      await android.tap(serial, icons.shareFeed.x, icons.shareFeed.y);
      await sleepOrAbort(serial, 700);

      const afterTapXml = await android.dumpUi(serial).catch(() => "");
      if (afterTapXml.includes('text="Close"') || afterTapXml.includes('content-desc="Close"')) {
        const close = await android.findButtonByLabel(serial, "Close").catch(() => null);
        if (close) {
          await android.tap(serial, close.x, close.y);
          onLog?.("Share Reel: dismissed Share to Feed confirmation");
        }
      }

      await onProcessed(serial, slotIdx, url);
      processed.add(url);
      completed++;
      onLog?.(`Share Reel: ✓ shared ${url}`);
    } catch (error: any) {
      if (error?.message === "cycle-aborted") throw error;
      logger.warn({ serial, url, error: error?.message ?? String(error) }, "[share-reel] link failed");
      onLog?.(`Share Reel: link failed — ${error?.message ?? "unknown error"}`);
    }
  }

  return { processed: completed, skipped: selected.length - completed };
}