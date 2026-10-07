export interface ShareReelSource {
  type: string;
  value: string;
}

export interface ShareReelOperationContext {
  android: {
    openInstagramUrl(serial: string, url: string): Promise<void>;
    dumpUi(serial: string): Promise<string>;
    findReelRepostAction(
      serial: string,
      onLog?: (message: string) => void,
      options?: { uiXml?: string },
    ): Promise<{ x: number; y: number; label: string; alreadyReposted: boolean } | null>;
    findReelActionIcons(
      serial: string,
      onLog?: (message: string) => void,
      options?: { uiXml?: string },
    ): Promise<{ like: { x: number; y: number }; alreadyLiked?: boolean } | null>;
    findButtonByLabel(serial: string, label: string): Promise<{ x: number; y: number } | null>;
    tap(serial: string, x: number, y: number): Promise<void>;
    pressBack(serial: string): Promise<void>;
    tapCalibratedNavigationControl(
      serial: string,
      control: "settingsBack",
      onLog?: (message: string) => void,
    ): Promise<{ x: number; y: number }>;
  };
  sleepOrAbort: (serial: string, milliseconds: number) => Promise<void>;
  rollRange: (minimum: number, maximum: number) => number;
  isCycleAborted?: (serial: string) => boolean;
  logger: { warn(payload: unknown, message: string): void };
  onProcessed: (serial: string, slotIdx: number, url: string) => void | Promise<void>;
  slotIdx: number;
}

function normalizeSourceUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
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
 * Standalone Repost tool for configured Reel URLs.
 *
 * It opens each configured Instagram Reel URL directly and resolves the
 * verified Repost control independently from Like. It deliberately does not
 * enter the Reels tab or reuse the View Reels scrolling/action loop.
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
  const processed = new Set(processedLinks.map(normalizeSourceUrl).filter((url): url is string => Boolean(url)));
  const available = [...new Set(
    sources
      .map(source => normalizeSourceUrl(source.value))
      .filter((url): url is string => Boolean(url)),
  )].filter(url => !processed.has(url));

  if (!available.length) {
    onLog?.("Repost: no unvisited Reel links are available for this account slot");
    return { processed: 0, skipped: sources.length };
  }

  const requested = Math.max(0, Math.floor(rollRange(processMin, processMax)));
  const selected = available
    .sort(() => Math.random() - 0.5)
    .slice(0, requested);
  onLog?.(`Repost: selected ${selected.length}/${available.length} unvisited Reel link(s)`);

  let completed = 0;
  try {
    for (const url of selected) {
      if (isCycleAborted?.(serial)) throw new Error("cycle-aborted");
      onLog?.(`Repost: opening ${url}`);
      try {
        await android.openInstagramUrl(serial, url);

        let reelXml = "";
        for (let attempt = 0; attempt < 6; attempt++) {
          await sleepOrAbort(serial, attempt === 0 ? 2500 : 1500);
          reelXml = await android.dumpUi(serial).catch(() => "");
          // Instagram can show the "shared this reel with you" social-context
          // popup before the Reel action column becomes usable. Dismiss the
          // live negative button first; never scan the action column on the
          // popup surface.
          if (
            /dialog_container|negative_button_row|text="Not now"/i.test(reelXml) &&
            /text="Not now"/i.test(reelXml)
          ) {
            const notNow = await android.findButtonByLabel(serial, "Not now").catch(() => null);
            if (notNow) {
              onLog?.(`Repost: Instagram's "shared this Reel with you" popup detected — tapping Not now at (${notNow.x},${notNow.y})`);
              await android.tap(serial, notNow.x, notNow.y);
              await sleepOrAbort(serial, 500);
              reelXml = await android.dumpUi(serial).catch(() => "");
            } else {
              onLog?.("Repost: popup detected but its live Not now button was unavailable — skipping link");
              continue;
            }
          }
          if (isReelViewerXml(reelXml)) break;
        }
        if (!isReelViewerXml(reelXml)) {
          onLog?.(`Repost: Instagram opened the URL but the Reel viewer was not confirmed after 6 polls — skipping`);
          logger.warn({ serial, url }, "[repost] Reel viewer was not confirmed");
          continue;
        }

        const repostAction = await android.findReelRepostAction(
          serial,
          message => onLog?.(`  ${message}`),
          { uiXml: reelXml },
        ).catch(() => null);
        if (!repostAction) {
          onLog?.("Repost: no unique, clickable Repost control with a verified Repost resource ID — skipping link");
          logger.warn({ serial, url }, "[repost] verified Repost control was not found");
          continue;
        }

        let repostConfirmed = repostAction.alreadyReposted;
        let repostConfirmationDialog = false;
        if (repostAction.alreadyReposted) {
          onLog?.(`Repost: this Reel is already reposted (live button label "${repostAction.label}") — not toggling it off`);
        } else {
          onLog?.(`Repost: tapping the verified Repost control once at (${repostAction.x},${repostAction.y})`);
          await android.tap(serial, repostAction.x, repostAction.y);

          // Confirm either the same live action changing to its reposted state,
          // or Instagram's explicit "You reposted" confirmation. Never tap
          // Repost a second time to recover an ambiguous result.
          for (let poll = 0; poll < 4; poll++) {
            await sleepOrAbort(serial, poll === 0 ? 500 : 350);
            const afterTapXml = await android.dumpUi(serial).catch(() => "");
            if (!afterTapXml) continue;
            const afterAction = await android.findReelRepostAction(
              serial,
              message => onLog?.(`  ${message}`),
              { uiXml: afterTapXml },
            ).catch(() => null);
            const explicitConfirmation =
              /(?:text|content-desc)="[^"]*\bYou reposted\b[^"]*"/i.test(afterTapXml);
            if (afterAction?.alreadyReposted || explicitConfirmation) {
              repostConfirmed = true;
              repostConfirmationDialog = explicitConfirmation;
              break;
            }
          }
          if (!repostConfirmed) {
            onLog?.("Repost: tap result could not be verified — link left unprocessed and no second Repost tap was sent");
            logger.warn({ serial, url }, "[repost] tap result was not confirmed");
            continue;
          }
          if (repostConfirmationDialog) {
            const close = await android.findButtonByLabel(serial, "Close").catch(() => null);
            if (close) {
              await android.tap(serial, close.x, close.y);
              onLog?.("Repost: dismissed the verified repost confirmation");
            } else {
              onLog?.("Repost: confirmation appeared but its live Close button was unavailable");
            }
          }
        }

        // Persist the completed Repost before the optional Like. A Like scan
        // failure must never cause this URL to be reposted again next cycle.
        await onProcessed(serial, slotIdx, url);
        processed.add(url);
        completed++;
        onLog?.(`Repost: ✓ ${repostAction.alreadyReposted ? "already reposted" : "reposted"} ${url}`);

        // Choose a fresh hardcoded chance from 1–100% for each selected Reel.
        // The standalone Repost tool has no separate Like setting.
        const likeChancePct = 1 + Math.floor(Math.random() * 100);
        const likeRoll = Math.random() * 100;
        const wantLike = likeRoll < likeChancePct;
        onLog?.(
          `Repost: Like roll — ${likeChancePct}% chance, result=${wantLike ? "like" : "skip"}`,
        );
        if (wantLike) {
          try {
            const likeIcons = await android.findReelActionIcons(
              serial,
              message => onLog?.(`  ${message}`),
            ).catch(() => null);
            if (!likeIcons) {
              onLog?.("Repost: Like control was not independently confirmed — skipping Like");
            } else if (likeIcons.alreadyLiked) {
              onLog?.("Repost: Reel is already liked — not toggling Like off");
            } else {
              onLog?.(`Repost: tapping the live Like control at (${likeIcons.like.x},${likeIcons.like.y})`);
              await android.tap(serial, likeIcons.like.x, likeIcons.like.y);
              await sleepOrAbort(serial, 400);
              const afterLikeXml = await android.dumpUi(serial).catch(() => "");
              const afterLikeIcons = afterLikeXml
                ? await android.findReelActionIcons(
                    serial,
                    message => onLog?.(`  ${message}`),
                    { uiXml: afterLikeXml },
                  ).catch(() => null)
                : null;
              if (afterLikeIcons?.alreadyLiked) {
                onLog?.("Repost: ✓ Like confirmed");
              } else {
                onLog?.("Repost: Like tap sent but the liked state was not confirmed");
              }
            }
          } catch (likeError: any) {
            if (likeError?.message === "cycle-aborted") throw likeError;
            logger.warn({ serial, url, error: likeError?.message ?? String(likeError) }, "[repost] optional Like failed");
            onLog?.(`Repost: optional Like failed — ${likeError?.message ?? "unknown error"}`);
          }
        }
      } catch (error: any) {
        if (error?.message === "cycle-aborted") throw error;
        logger.warn({ serial, url, error: error?.message ?? String(error) }, "[repost] link failed");
        onLog?.(`Repost: link failed — ${error?.message ?? "unknown error"}`);
      }
    }
  } finally {
    if (!isCycleAborted?.(serial)) {
      try {
        const back = await android.tapCalibratedNavigationControl(serial, "settingsBack", onLog);
        onLog?.(`Repost: exited Reel with calibrated Back at (${back.x},${back.y})`);
      } catch (error: any) {
        logger.warn({ serial, error: error?.message ?? String(error) }, "[repost] calibrated Back exit failed");
        onLog?.(`Repost: calibrated Back exit failed — ${error?.message ?? "unknown error"}`);
      }
    }
  }

  return { processed: completed, skipped: selected.length - completed };
}