export interface ViewReelsOperationContext {
  android: typeof import("../../androidManager");
  deviceProfileSwipe: (...args: any[]) => Promise<any>;
  dismissSaveCollectionPrompt: (...args: any[]) => Promise<any>;
  findButtonByLabel: (...args: any[]) => Promise<any>;
  getScreenSize: (serial: string) => { w: number; h: number };
  isCycleAborted: (serial: string) => boolean;
  loadInstanceConfigs: () => any;
  logger: any;
  rollRange: (min: number, max: number) => number;
  rollScrollVelocity: (...args: any[]) => any;
  sleepOrAbort: (serial: string, milliseconds: number) => Promise<void>;
  _viewReelsLastDmRecipient: Map<string, { x: number; y: number }>;
}

export async function runViewReelsLoop(serial: string, params: {
  scrollMin: number; scrollMax: number;
  watchPctMin: number; watchPctMax: number;
  likePercentMin: number; likePercentMax: number;
  shareFeedPercentMin: number; shareFeedPercentMax: number;
  shareDmPercentMin: number; shareDmPercentMax: number;
  savePercentMin: number; savePercentMax: number;
  clickAuthorPctMin: number; clickAuthorPctMax: number;
  onLog?: (msg: string) => void;
  onProgress?: (progress: { reelsViewed: number; likes: number; sharesFeed: number; sharesDm: number; saves: number }) => void;
}, context: ViewReelsOperationContext): Promise<{ reelsViewed: number; likes: number; sharesFeed: number; sharesDm: number; saves: number }> {
  const {
    scrollMin, scrollMax,
    watchPctMin, watchPctMax,
    likePercentMin, likePercentMax,
    shareFeedPercentMin, shareFeedPercentMax,
    shareDmPercentMin, shareDmPercentMax,
    savePercentMin, savePercentMax,
    clickAuthorPctMin, clickAuthorPctMax,
    onLog, onProgress,
  } = params;

  const {
    android, deviceProfileSwipe, dismissSaveCollectionPrompt, findButtonByLabel,
    getScreenSize, isCycleAborted, loadInstanceConfigs, logger, rollRange,
    rollScrollVelocity, sleepOrAbort, _viewReelsLastDmRecipient,
  } = context;

  const totalReels = Math.floor(rollRange(scrollMin, scrollMax));
  if (totalReels <= 0) return { reelsViewed: 0, likes: 0, sharesFeed: 0, sharesDm: 0, saves: 0 };

  const { w, h } = getScreenSize(serial);
  onLog?.(`Reels loop: device resolution ${w}×${h}`);

  const reelsTab = await android.findReelsTab(serial, onLog).catch(() => null);
  if (!reelsTab) {
    onLog?.("Reels tab not found — a11y miss and positional fallback found < 2 bottom-nav nodes; skipping View Reels");
    logger.warn({ serial }, "[view-reels] Reels tab not found");
    return { reelsViewed: 0, likes: 0, sharesFeed: 0, sharesDm: 0, saves: 0 };
  }
  await android.tap(serial, reelsTab.x, reelsTab.y);
  onLog?.(`Tapped Reels tab at (${reelsTab.x},${reelsTab.y}) — waiting for Reels to load`);
  await sleepOrAbort(serial, 1500);

  let likes = 0, sharesFeed = 0, sharesDm = 0, saves = 0, reelsViewed = 0;

  // Session scroll personality for Reels — same dynamic-weight approach as
  // feed/explore. Back-scroll snaps fully to the previous clip (Reels snaps
  // per clip, unlike the feed's partial nudge), which just means occasionally
  // rewatching a reel — a normal human behaviour kept at a low weight.
  const reelsScrollWeights = {
    superSkim: 1 + Math.floor(Math.random() * 5), skim: 10 + Math.floor(Math.random() * 16),
    fast: 40 + Math.floor(Math.random() * 36), quick: 50 + Math.floor(Math.random() * 46),
    normal: 60 + Math.floor(Math.random() * 36), slow: 75 + Math.floor(Math.random() * 21),
    focused: 75 + Math.floor(Math.random() * 26),
    tapDragRelease: 1 + Math.floor(Math.random() * 5),
    back:       Math.floor(Math.random() * 6),       // 0–5
  };
  onLog?.(`Reels scroll personality — super skim:${reelsScrollWeights.superSkim} skim:${reelsScrollWeights.skim} fast:${reelsScrollWeights.fast} quick:${reelsScrollWeights.quick} normal:${reelsScrollWeights.normal} slow:${reelsScrollWeights.slow} focused:${reelsScrollWeights.focused} tap-drag-release:${reelsScrollWeights.tapDragRelease} back:${reelsScrollWeights.back}`);
  const reelsPersonalityHistory: { lastMode?: string; streak: number } = { streak: 0 };

  // Reels snap fully to the next clip on a swipe — unlike the feed's
  // partial scroll (runCheckFeedLoop), a single full-height swipe here
  // always lands on exactly the next reel.
  const summarizeReelsSwipeScreen = (xml: string): string => {
    if (!xml) return "empty-ui-dump";
    const markers = [
      "reel_viewer", "reels_feed_media_view", "clips_tab", "clips_author_username",
      "Friends", "Popular profiles", "Suggested profiles", "People you may know",
      "Follow", "Edit profile", "Share profile", "Discover people",
      "task_view_thumbnail", "recents_container", "com.instagram.android",
    ];
    const found = markers.filter(marker => xml.includes(marker));
    const texts = [...xml.matchAll(/(?:text|content-desc)="([^"]+)"/g)]
      .map(match => match[1])
      .filter(value => value.length > 1)
      .slice(0, 16);
    return `bytes=${xml.length} markers=[${found.join(",") || "none"}] labels=[${texts.join(" | ")}]`;
  };

  const swipeToNextReel = async (reelLabel: string) => {
    const rx = Math.round(w / 2);
    // The lower 20% of the Instagram viewer contains the "Send message"
    // composer. Starting a swipe at 80% can press/focus that field before
    // Android recognizes the movement, opening the keyboard instead of
    // advancing the reel. Keep the touch-down clearly above the composer.
    const rsv = rollScrollVelocity(h, reelsScrollWeights, /*allowBack=*/false, /*safeStartFrac=*/0.68, reelsPersonalityHistory, serial);
    const reelsOverride = serial ? loadInstanceConfigs()[serial]?.devicePrefs?.swipePersonalityOverrides?.[rsv.mode] : undefined;
    onLog?.(`[Override] Reels swipe: mode=${rsv.mode}, duration=${rsv.duration}ms${reelsOverride ? `, weight=${reelsOverride.weightMin}-${reelsOverride.weightMax}, durationRange=${reelsOverride.durationMinMs}-${reelsOverride.durationMaxMs}ms` : ", Mother Code default"}, backAllowed=false`);
    reelsPersonalityHistory.streak = reelsPersonalityHistory.lastMode === rsv.mode ? reelsPersonalityHistory.streak + 1 : 1;
    reelsPersonalityHistory.lastMode = rsv.mode;
    const beforeXml = await android.dumpUi(serial).catch(() => "");
    onLog?.(`${reelLabel}: swipe screen BEFORE — ${summarizeReelsSwipeScreen(beforeXml)}`);
    const reelsModeLabel = rsv.mode === "superSkim" ? "super skim" : rsv.mode;
    onLog?.(`${reelLabel}: advance swipe [${reelsModeLabel}]`);
    logger.info({ serial, source: "reels-advance", mode: rsv.mode, from: [rx, rsv.fromY], to: [rx, rsv.toY], durationMs: rsv.duration }, "[mobile-input] swipe");
    const actualPath = await deviceProfileSwipe(serial, { x1: rx, y1: rsv.fromY, x2: rx, y2: rsv.toY, durationMs: rsv.duration }, "reels-advance", rsv.mode as any);
    const afterXml = await android.dumpUi(serial).catch(() => "");
    onLog?.(
      `${reelLabel}: swipe screen AFTER — ${summarizeReelsSwipeScreen(afterXml)}` +
      `; completed=${actualPath.x1},${actualPath.y1}->${actualPath.x2},${actualPath.y2}`,
    );
  };

  for (let i = 0; i < totalReels; i++) {
    if (isCycleAborted(serial)) throw new Error("cycle-aborted");
    const reelTimingStartedAt = Date.now();
    let reelTimingAfterWatch = reelTimingStartedAt;
    let reelTimingAfterActions = reelTimingStartedAt;
    onLog?.(`Reel ${i + 1}/${totalReels}`);

    // Watch a configurable % of the reel before acting. Keeps the reel
    // visible long enough for Instagram to render the action-icon column,
    // and gives the reel a natural watch time. Assumed max reel duration
    // is 30 s; watchPct is rolled fresh each reel.
    const watchPct = rollRange(watchPctMin, watchPctMax);
    const watchMs  = Math.max(1500, Math.round((watchPct / 100) * 30000));
    onLog?.(`Reel ${i + 1}/${totalReels}: watching ${watchPct.toFixed(0)}% (~${(watchMs / 1000).toFixed(1)}s)`);
    await sleepOrAbort(serial, watchMs);
    reelTimingAfterWatch = Date.now();

    // Roll like/share decisions fresh per reel so each reel is independent.
    const wantLike      = likePercentMax > 0 && Math.random() * 100 < rollRange(likePercentMin, likePercentMax);
    const wantShareFeed = shareFeedPercentMax > 0 && Math.random() * 100 < rollRange(shareFeedPercentMin, shareFeedPercentMax);
    const wantSave      = savePercentMax > 0 && Math.random() * 100 < rollRange(savePercentMin, savePercentMax);
    const wantShareDm     = shareDmPercentMax > 0 && Math.random() * 100 < rollRange(shareDmPercentMin, shareDmPercentMax);
    const wantClickAuthor = clickAuthorPctMax > 0 && Math.random() * 100 < rollRange(clickAuthorPctMin, clickAuthorPctMax);

    // Holds the last UIAutomator dump from the reel-player poll below.
    // Declared here (outside the poll block) so the ad-detection check at
    // the bottom of this reel iteration can reference it regardless of
    // whether the poll block ran (i.e. even when wantLike/Share/Save are all
    // false but wantClickAuthor or another action is active).
    let lastPollXml = "";

    if (wantLike || wantShareFeed || wantSave || wantShareDm) {
      // ── View Reels: wait for reel player nodes to appear ────────────────
      // Problem: the reel viewer sometimes opens in a separate accessibility
      // window layer (observed on Xiaomi MIUI). UIAutomator's dump captures
      // only the focused window — during the opening animation or before the
      // view attaches, the dump still returns the underlying Reels tab UI
      // rather than the player. findReelActionIcons running against that dump
      // finds nothing and returns null, so the like/share is silently skipped.
      //
      // Fix: cheap raw-dump poll for ANY known reel-player node before the
      // expensive column scan. The moment one appears the tree is ready.
      // If no node appears within the budget, fall through — the existing
      // null path handles it as before, but now logs every poll attempt.
      // This block is isolated to the View Reels loop and has no effect on
      // any other tool.
      {
        // Match what findReelActionIcons actually anchors on: content-desc
        // "Like" / "Unlike" in the right-side column. The old resource-id
        // list (like_count, comment_button, direct_share_button) does not
        // exist on all devices/IG builds, causing the poll to burn its full
        // 6 × 2 s budget even when the reel is visibly playing.
        // Signals that the reel player's view hierarchy has attached to the
        // a11y tree.  Ordered from most-specific to least-specific so the
        // poll exits as early as possible.
        //
        // Why not content-desc="Like"/"Unlike" only?
        //   On some device/IG-build combinations (observed: Redmi 12 5G) the
        //   Reels action icons do NOT carry those exact content-desc values —
        //   the poll burned its full 12 s budget every reel, then proceeded
        //   to findReelActionIcons which also failed to find the Like anchor
        //   and returned null, silently skipping every action.
        //
        // The resource-id markers below appear in the reel player view
        // hierarchy even when content-desc is absent:
        //   • reel_viewer_*       — reel_viewer_root / reel_viewer_video_player / …
        //   • reels_feed_media_view_root — Reels-tab feed container
        //   • :id/outer_container — action-icon column container on builds
        //                           where individual icons lack labels
        const REEL_NODES = [
          'content-desc="Like"',
          'content-desc="Unlike"',
          "reel_viewer",                  // reel_viewer_root, _video_player, _toolbar, …
          "reels_feed_media_view",        // Reels-tab feed root (some builds)
          ":id/outer_container",          // action-icon column container (no-cd builds)
          // Ad reels use a completely different view hierarchy — no reel_viewer
          // IDs and no Like/Unlike nodes — so the poll was burning its full 12 s
          // on every ad. Including the ad markers here lets the poll exit on the
          // first attempt. The isReelAd check below still fires and skips actions.
          'text="Ad"',
          'content-desc="Ad"',
          'text="Sponsored"',
          'content-desc="Sponsored"',
        ];
        const POLL_MS   = 2000;
        const MAX_POLLS = 6; // up to 12 s extra wait
        let reelReady = false;
        for (let p = 0; p < MAX_POLLS && !reelReady; p++) {
          const pollXml = await android.dumpUi(serial).catch(() => "");
          lastPollXml = pollXml;
          // This poll is entered only after findReelsTab() succeeded and the
          // Reels tab was tapped.  Some Xiaomi/Instagram builds render the
          // full-screen Reels player without exposing any reel_viewer_* or
          // reels_feed_media_view_* nodes to UIAutomator.  In that case the
          // focused Instagram window is the reliable screen-level signal;
          // requiring a player resource-id produces a false "never
          // appeared" diagnosis even though Reels is visibly on screen.
          const instagramWindowFocused =
            pollXml.includes("com.instagram.android") &&
            !pollXml.includes("task_view_thumbnail") &&
            !pollXml.includes("recents_container") &&
            !pollXml.includes("recents_view");
          if (REEL_NODES.some(n => pollXml.includes(n)) || instagramWindowFocused) {
            reelReady = true;
            if (p > 0) {
              onLog?.(
                `Reel ${i + 1}/${totalReels}: Instagram window ready after ${p * POLL_MS / 1000}s extra wait` +
                (REEL_NODES.some(n => pollXml.includes(n)) ? "" : " (screen-level fallback; player nodes unavailable on this build)"),
              );
            }
          } else {
            // Diagnose what the dump DID contain so future logs make it
            // immediately obvious why the player nodes are missing.
            // Two known causes:
            //   A) Floating window — Android's UIAutomator dumps the focused
            //      accessibility window. If Instagram is running inside a
            //      floating/pop-up window (common on Xiaomi MIUI "Free-form"
            //      or Samsung "Multi-window"), the recents/task-switcher layer
            //      is focused instead of Instagram. The dump returns the
            //      recents XML (task_view_thumbnail, txtSmallWindow, etc.)
            //      rather than any Instagram node — a dead giveaway.
            //   B) Regular window, player still loading — Instagram IS the
            //      focused window but the reel video frame hasn't attached to
            //      the a11y tree yet (brief animation / first-launch lag).
            let windowCtx: string;
            if (pollXml.includes("task_view_thumbnail") || pollXml.includes("recents_container") || pollXml.includes("recents_view")) {
              windowCtx = "⚠ floating/multi-window — dump returned Android recents layer (task_view_thumbnail detected); UIAutomator is not focused on the Instagram window";
            } else if (pollXml.includes("txtSmallWindow") || pollXml.includes("Floating windows")) {
              windowCtx = "⚠ floating-window bar detected (txtSmallWindow / 'Floating windows' present) — Instagram may be in a pop-up window";
            } else if (pollXml.includes("com.instagram.android")) {
              windowCtx = "regular window — Instagram a11y tree visible but reel player not yet attached (still loading)";
            } else {
              windowCtx = `unrecognised context — dump is ${pollXml.length} chars, no Instagram or recents nodes found`;
            }
            onLog?.(`Reel ${i + 1}/${totalReels}: player not in tree yet [${windowCtx}] — retrying in ${POLL_MS / 1000}s (poll ${p + 1}/${MAX_POLLS})`);
            await sleepOrAbort(serial, POLL_MS);
          }
        }
        if (!reelReady) onLog?.(`Reel ${i + 1}/${totalReels}: player never appeared in tree — proceeding anyway`);
      }

      // ── Ad detection — skip all actions for sponsored reels ──────────────
      // Instagram labels sponsored reels with text="Ad" or content-desc="Ad"
      // (sometimes "Sponsored"/"Advert"). Some builds expose only the
      // sponsored CTA controls ("Get offer", "Not interested", and
      // "Interested") while omitting the standalone Ad label. Reuse the last
      // dump from the player-ready poll above — no extra dump cost. Quoted
      // attribute matching prevents false positives on words like "Add".
      const isReelAd =
        lastPollXml.includes('text="Ad"')        || lastPollXml.includes('content-desc="Ad"') ||
        lastPollXml.includes('text="Sponsored"') || lastPollXml.includes('content-desc="Sponsored"') ||
        lastPollXml.includes('text="Advert"')    || lastPollXml.includes('content-desc="Advert"') ||
        lastPollXml.includes('text="Get offer"') || lastPollXml.includes('content-desc="Get offer"') ||
        lastPollXml.includes('text="Not interested"') || lastPollXml.includes('content-desc="Not interested"') ||
        lastPollXml.includes('text="Interested"') || lastPollXml.includes('content-desc="Interested"');
      if (isReelAd) {
        onLog?.(`Reel ${i + 1}/${totalReels}: ad post detected — skipping all actions`);
      } else {

      onLog?.(`Reel ${i + 1}/${totalReels}: scanning right-side action column…`);
      const icons = await android.findReelActionIcons(
        serial,
        (msg) => onLog?.(`  ${msg}`),
        { uiXml: lastPollXml || undefined },
      ).catch(() => null);
      // ── Like — require validated live action-node evidence ─────────────
      // Never guess a video coordinate when the action-column scan found no
      // Like/Unlike node. A double-tap fallback is unsafe here: the current
      // screen may be a profile, suggested-user card, ad, or another
      // non-player surface, and a guessed tap can navigate away from Reels.
      if (wantLike) {
        if (!icons) {
          onLog?.(`Reel ${i + 1}/${totalReels}: Like/Unlike node not found — skipping like safely`);
        } else if (icons.alreadyLiked) {
          onLog?.(`Reel ${i + 1}/${totalReels}: already liked — skipping like`);
        } else {
          if (!icons.like) {
            onLog?.(`Reel ${i + 1}/${totalReels}: Like node not found — skipping like safely`);
            continue;
          }
          onLog?.(`Reel ${i + 1}/${totalReels}: tapping validated Like node at (${icons.like.x},${icons.like.y})…`);
          await android.tap(serial, icons.like.x, icons.like.y);
          likes++;
          onLog?.(`Reel ${i + 1}/${totalReels}: ✓ liked`);
          await sleepOrAbort(serial, 250);
        }
      }

      // ── Share / Save — require icon coordinates ─────────────────────────
      if (!icons) {
        if (wantShareFeed || wantSave || wantShareDm) {
          onLog?.(`Reel ${i + 1}/${totalReels}: action icons not found — skipping share/save for this reel`);
        }
      } else {
        if (wantShareFeed) {
          if (!icons.shareFeed) {
            onLog?.(`Reel ${i + 1}/${totalReels}: Share to Feed icon not found — skipping`);
          } else {
            await android.tap(serial, icons.shareFeed.x, icons.shareFeed.y);
            sharesFeed++;
            onLog?.(`Reel ${i + 1}/${totalReels}: shared to feed at (${icons.shareFeed.x},${icons.shareFeed.y})`);
            await sleepOrAbort(serial, 400);
            // Instagram can show a "You reposted …'s reel" dialog after
            // Share to Feed. Check only after this repost action; do not
            // spend a dump/check on every viewed reel.
            const _vrRepostXml = await android.dumpUi(serial).catch(() => "");
            if (_vrRepostXml.includes('content-desc="Close"') || _vrRepostXml.includes('text="Close"')) {
              const _vrRepostClose = await android.findButtonByLabel(serial, "Close").catch(() => null);
              if (_vrRepostClose) {
                await android.tap(serial, _vrRepostClose.x, _vrRepostClose.y);
                onLog?.(`View Reels ${i + 1}/${totalReels}: dismissed repost confirmation dialog (Close)`);
                await sleepOrAbort(serial, 250);
              } else {
                onLog?.(`View Reels ${i + 1}/${totalReels}: repost dialog detected but Close button was not resolved`);
              }
            }
          }
        }
        if (wantSave) {
          // ── View Reels — Save (isolated; not shared with any other tool) ──
          if (icons.alreadySaved) {
            onLog?.(`Reel ${i + 1}/${totalReels}: already saved — skipping save`);
          } else if (!icons.save) {
            onLog?.(`Reel ${i + 1}/${totalReels}: Save icon not found — skipping`);
          } else {
            await android.tap(serial, icons.save.x, icons.save.y);
            saves++;
            onLog?.(`Reel ${i + 1}/${totalReels}: saved at (${icons.save.x},${icons.save.y})`);
             // Wait long enough for Instagram to show the first-save
             // collection sheet if it's going to (common on new accounts).
            await sleepOrAbort(serial, 600);
            const _vrSaveXml = await android.dumpUi(serial).catch(() => "");
             await dismissSaveCollectionPrompt(serial, _vrSaveXml, onLog, `Reel ${i + 1}/${totalReels}`);
          }
        }
        if (wantShareDm) {
          if (!icons.shareDm) {
            onLog?.(`Reel ${i + 1}/${totalReels}: Share via DM icon not found — skipping`);
          } else {
            // ── View Reels — Share via DM (isolated; not shared with any other tool) ──
            const _vrPfx = `Reel ${i + 1}/${totalReels}`;
            let _vrDmSent = false;
            try {
              if (isCycleAborted(serial)) throw new Error("cycle-aborted");
              await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300));
              onLog?.(`${_vrPfx}: tapping share-via-DM icon at (${icons.shareDm.x},${icons.shareDm.y})…`);
              await android.tap(serial, icons.shareDm.x, icons.shareDm.y);
              await sleepOrAbort(serial, 1500);
              onLog?.(`${_vrPfx}: confirming share sheet opened and picking DM recipient…`);
              const _vrShareScanOptions = { strictContactParents: true };
              let _vrScan = await android.confirmAndScanShareSheet(serial, onLog, _vrShareScanOptions).catch(() => null);
              if (!_vrScan?.sheetOpen) {
                onLog?.(`${_vrPfx}: share sheet not yet visible — waiting 1500ms and retrying…`);
                await sleepOrAbort(serial, 1500);
                _vrScan = await android.confirmAndScanShareSheet(serial, onLog, _vrShareScanOptions).catch(() => null);
              }
              if (!_vrScan?.sheetOpen) {
                logger.warn({ serial }, "[view-reels] share sheet not confirmed open after retry — closing and skipping DM");
                onLog?.(`${_vrPfx}: share aborted — share sheet did not open`);
                await android.pressBack(serial);
                await sleepOrAbort(serial, 200);
              } else {
                let _vrShareAborted = false;
                if (_vrScan.preSelectedRecipients && _vrScan.preSelectedRecipients.length > 0) {
                  onLog?.(`${_vrPfx}: deselecting ${_vrScan.preSelectedRecipients.length} pre-selected recipient(s) from prior run…`);
                  for (const _r of _vrScan.preSelectedRecipients) {
                    onLog?.(`${_vrPfx}: deselecting${(_r as any).name ? ` (${(_r as any).name})` : ""} at (${_r.x},${_r.y})`);
                    await android.tap(serial, _r.x, _r.y);
                    await sleepOrAbort(serial, 400);
                  }
                  // Deselecting a prior contact can reflow the grid. Never
                  // reuse coordinates from the pre-deselection dump.
                  const _vrRefresh = await android.confirmAndScanShareSheet(serial, onLog, _vrShareScanOptions).catch(() => null);
                  if (!_vrRefresh?.sheetOpen) {
                    await android.pressBack(serial);
                    onLog?.(`${_vrPfx}: share skipped — sheet disappeared while clearing prior recipient`);
                    _vrShareAborted = true;
                  }
                  if (_vrRefresh?.sheetOpen) _vrScan = _vrRefresh;
                }
                const _vrRecipients = _vrShareAborted ? [] : (_vrScan.recipients ?? []);
                if (_vrRecipients.length === 0) {
                  await android.pressBack(serial);
                  logger.warn({ serial }, "[view-reels] no recipient found — closed share sheet without sending");
                  onLog?.(`${_vrPfx}: share skipped — no recipient avatars found (closed without sending)`);
                } else {
                  const _vrLast = _viewReelsLastDmRecipient.get(serial);
                  const _vrPool = _vrLast ? _vrRecipients.filter(r => !(r.x === _vrLast.x && r.y === _vrLast.y)) : _vrRecipients;
                  const _vrCands = _vrPool.length > 0 ? _vrPool : _vrRecipients;
                  const _vrPick = _vrCands[Math.floor(Math.random() * _vrCands.length)];
                  _viewReelsLastDmRecipient.set(serial, { x: _vrPick.x, y: _vrPick.y });
                  onLog?.(
                    `${_vrPfx}: validated recipient candidate — ` +
                    `bounds="${String((_vrPick as any).bounds ?? `[${_vrPick.x},${_vrPick.y}]`) }" ` +
                    `rid="${String((_vrPick as any).resourceId ?? "")}" ` +
                    `class="${String((_vrPick as any).className ?? "")}" ` +
                    `text="${String((_vrPick as any).text ?? "")}" ` +
                    `content-desc="${String((_vrPick as any).contentDesc ?? "")}" ` +
                    `parent-desc="${String((_vrPick as any).name ?? "")}"`,
                  );
                  onLog?.(`${_vrPfx}: tapping recipient at (${_vrPick.x},${_vrPick.y})${(_vrPick as any).name ? ` (${(_vrPick as any).name})` : ""}`);
                  await android.tap(serial, _vrPick.x, _vrPick.y);
                  await sleepOrAbort(serial, 800);
                  // A disappeared sheet is NOT proof that a DM was sent:
                  // tapping the reused avatar resource can launch WhatsApp
                  // or another external shortcut. Confirm the selected
                  // contact itself before looking for Send.
                  const _vrPostTapScan = await android.confirmAndScanShareSheet(serial, onLog, _vrShareScanOptions).catch(() => null);
                  const _vrPickName = String((_vrPick as any).name ?? "").replace(/\bnot selected\b|\bselected\b/gi, "").trim();
                  const _vrSelected = _vrPostTapScan?.sheetOpen === true &&
                    (_vrPostTapScan.preSelectedRecipients ?? []).some(r => {
                      const samePoint = Math.abs(r.x - _vrPick.x) <= 35 && Math.abs(r.y - _vrPick.y) <= 35;
                      const rName = String((r as any).name ?? "").replace(/\bnot selected\b|\bselected\b/gi, "").trim();
                      return samePoint || Boolean(_vrPickName && rName && rName === _vrPickName);
                    });
                  if (!_vrSelected) {
                    onLog?.(`${_vrPfx}: share skipped — recipient selection was not positively confirmed; refusing to treat a dismissed sheet as a sent DM`);
                    await android.pressBack(serial).catch(() => {});
                    await sleepOrAbort(serial, 200);
                  } else {
                    // Always do a fresh lookup after recipient tap — the Send
                    // button only appears once a recipient is selected.
                    // findDmSendButton tries resource-ids first before the
                    // label fallback.
                    const _vrSb = await android.findDmSendButton(serial).catch(() => null);
                    if (_vrSb) {
                      await android.tap(serial, _vrSb.x, _vrSb.y);
                      await sleepOrAbort(serial, 1000);
                      const _vrAfterSend = await android.confirmAndScanShareSheet(serial, onLog, _vrShareScanOptions).catch(() => null);
                      if (!_vrAfterSend?.sheetOpen) {
                        _vrDmSent = true;
                        logger.info({ serial }, "[view-reels] shared post via DM — Send tapped");
                        onLog?.(`${_vrPfx}: ✓ shared via DM — Send tapped`);
                        await sleepOrAbort(serial, 300);
                      } else {
                        logger.info({ serial }, "[view-reels] Send tapped but sheet still open — pressing Back");
                        onLog?.(`${_vrPfx}: Send tapped but sheet did not close — pressing Back`);
                        await android.pressBack(serial);
                        await sleepOrAbort(serial, 200);
                      }
                    } else {
                      // Send button not found after a confirmed contact
                      // selection — press Back and skip rather than guessing.
                      // No coordinate fallback: tapping a blind Y-fraction risks hitting
                      // the Android nav bar (Home button) and dismissing Instagram.
                      logger.info({ serial }, "[view-reels] Send button not found — pressing Back and skipping DM share");
                      onLog?.(`${_vrPfx}: Send button not found via a11y — pressing Back and skipping`);
                      await android.pressBack(serial);
                      await sleepOrAbort(serial, 200);
                    }
                  }
                }
              }
            } catch (e: any) {
              if (e?.message === "cycle-aborted") throw e;
              onLog?.(`${_vrPfx}: share-via-DM error — ${e?.message}`);
            }
            if (_vrDmSent) sharesDm++;
          }
        }
      }
      } // end !isReelAd
    }

    // ── Click Author — navigate to creator profile, scroll, then Back ──────
    // Independent of the icon scan: uses the XML dump to locate
    // clips_author_username (bottom-left of the Reels viewer) directly.
    if (wantClickAuthor) {
      const _vrCaPfx = `View Reels ${i + 1}/${totalReels}`;
      try {
        if (isCycleAborted(serial)) throw new Error("cycle-aborted");
        onLog?.(`${_vrCaPfx}: clicking author profile…`);
        // Author visiting is optional. Do not let a slow UIAutomator dump
        // stall the whole Reels run when the author node is unavailable.
        const _vrCaXml = await Promise.race([
          android.dumpUi(serial).catch(() => ""),
          new Promise<string>(resolve => setTimeout(() => resolve(""), 2500)),
        ]);
        // Skip author click if Instagram labels this as a sponsored post.
        // Quoted attribute matching prevents false positives on words like
        // "Add", "Adidas", etc. whose text values differ from the bare "Ad".
        const _vrCaIsAd =
          _vrCaXml.includes('text="Ad"')         || _vrCaXml.includes('content-desc="Ad"') ||
          _vrCaXml.includes('text="Sponsored"')  || _vrCaXml.includes('content-desc="Sponsored"') ||
          _vrCaXml.includes('text="Advert"')     || _vrCaXml.includes('content-desc="Advert"');
        if (_vrCaIsAd) {
          onLog?.(`${_vrCaPfx}: ad post detected — skipping click author`);
        } else {
        // Try clips_author_username first, then clips_author_info_component.
        // Raw UIAutomator XML uses resource-id="com.instagram.android:id/<name>"
        // so we match the plain name fragment (same approach as all polling code)
        // then grab the first bounds="[x1,y1][x2,y2]" that follows it.
        const _findNode = (rid: string): { x: number; y: number } | null => {
          const _idx = _vrCaXml.indexOf(rid);
          if (_idx === -1) return null;
          const _seg = _vrCaXml.slice(_idx);
          const _bm = _seg.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
          if (!_bm) return null;
          return {
            x: Math.round((parseInt(_bm[1]) + parseInt(_bm[3])) / 2),
            y: Math.round((parseInt(_bm[2]) + parseInt(_bm[4])) / 2),
          };
        };
        const _vrCaNode = _findNode("clips_author_username") ?? _findNode("clips_author_info_component");
        if (!_vrCaNode) {
          onLog?.(`${_vrCaPfx}: author node not found in dump — skipping click author`);
        } else {
          onLog?.(`${_vrCaPfx}: tapping author at (${_vrCaNode.x},${_vrCaNode.y})…`);
          await android.tap(serial, _vrCaNode.x, _vrCaNode.y);
          await sleepOrAbort(serial, 1800);
          const _vrCaScrolls = Math.floor(rollRange(1, 10));
          onLog?.(`${_vrCaPfx}: on author profile — scrolling ${_vrCaScrolls} time(s)…`);
          const _cx = Math.round(w / 2);
          for (let _s = 0; _s < _vrCaScrolls; _s++) {
            if (isCycleAborted(serial)) throw new Error("cycle-aborted");
            const _cfY = Math.round(h * 0.75);
            const _ctY = Math.round(h * 0.30);
            await deviceProfileSwipe(serial, { x1: _cx, y1: _cfY, x2: _cx, y2: _ctY, durationMs: 400 + Math.round(Math.random() * 200) }, "reels-author-profile-scroll");
            const _dwell = 2500 + Math.round(Math.random() * 7500);
            onLog?.(`${_vrCaPfx}: author scroll ${_s + 1}/${_vrCaScrolls} — dwell ${(_dwell / 1000).toFixed(1)}s`);
            await sleepOrAbort(serial, _dwell);
          }
          await android.pressBack(serial);
          onLog?.(`${_vrCaPfx}: ✓ visited author profile (${_vrCaScrolls} scroll(s)) — pressed Back`);
          await sleepOrAbort(serial, 800);
        }
        } // end ad-skip else
      } catch (e: any) {
        if (e?.message === "cycle-aborted") throw e;
        onLog?.(`Reel ${i + 1}/${totalReels}: click-author error — ${e?.message}`);
      }
    }
    reelTimingAfterActions = Date.now();

    reelsViewed++;
    onProgress?.({ reelsViewed, likes, sharesFeed, sharesDm, saves });
    onLog?.(
      `Reel ${i + 1}/${totalReels} timing — ` +
      `watch-wait=${((reelTimingAfterWatch - reelTimingStartedAt) / 1000).toFixed(1)}s, ` +
      `actions/author=${((reelTimingAfterActions - reelTimingAfterWatch) / 1000).toFixed(1)}s, ` +
      `total=${((reelTimingAfterActions - reelTimingStartedAt) / 1000).toFixed(1)}s`,
    );

    if (i < totalReels - 1) {
      await swipeToNextReel(`Reel ${i + 1}/${totalReels}`);
      await sleepOrAbort(serial, 400 + Math.round(Math.random() * 300));
    }
  }

  return { reelsViewed, likes, sharesFeed, sharesDm, saves };
}

