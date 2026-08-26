export interface ViewStoriesOperationContext {
  android: any;
  deviceProfileSwipe: (...args: any[]) => Promise<any>;
  getScreenSize: (serial: string) => { w: number; h: number };
  isCycleAborted: (serial: string) => boolean;
  logger: any;
  sleepOrAbort: (serial: string, milliseconds: number) => Promise<void>;
  _viewStoriesLastDmRecipient: Map<string, { x: number; y: number }>;
}

export async function pickAndOpenRandomStory(serial: string, w: number, h: number, onLog?: (msg: string) => void, context?: ViewStoriesOperationContext): Promise<{ slot: number; opened: boolean }> {
    const { android, getScreenSize } = context!;
  
    // ── Find story bubbles directly from UIAutomator dump ──
    //
    // Every story bubble in the home-feed tray carries a content-desc of the
    // form "<username>'s story" (Instagram sets this on the avatar ImageView or
    // its parent FrameLayout). We parse the dump, collect ALL such nodes, and
    // tap their exact centre coordinates — no hardcoded percentages, no spacing
    // math, no device-specific calibration. This works identically on every
    // phone in the farm regardless of screen size, resolution, or DPI.
    //
    // Tap strategy:
    //   • Try slot 1 (first friend) first — real friends are always sorted
    //     before "Suggested" tiles, so slot 1 is the least likely to be a
    //     suggested-account chip that would dismiss rather than open.
    //   • If slot 1 fails, try up to 2 more randomly-ordered slots.
    //   • X and Y use the exact centre from the live accessibility node.
    //     Do not offset the tap toward a guessed "safe" area: that can land
    //     on an adjacent control or the bottom navigation.

    // Parse a UIAutomator XML dump and extract story-tray bubble nodes.
    // Returns every node whose content-desc or resource-id indicates a story
    // tray item, using multiple patterns to cover all known Instagram builds.
    //
    // Instagram's first tray item is always the signed-in user's own upload
    // bubble ("Your story"). On some builds that bubble exposes only the same
    // generic story-tray resource-id as real stories, or its label is attached
    // to a wrapper node rather than the node carrying the bounds. Therefore
    // label filtering alone is not sufficient: after collecting the live
    // bounds, we sort left-to-right and explicitly remove the first physical
    // bubble before returning candidates.
    const extractStoryBubbles = (xml: string): Array<{ cx: number; cy: number; desc: string }> => {
      const bubbles: Array<{ cx: number; cy: number; desc: string }> = [];
      if (!xml) return bubbles;
      const nodeRe = /<node\b([^>]*\/?>) */g;
      let nm: RegExpExecArray | null;
      while ((nm = nodeRe.exec(xml)) !== null) {
        const attrs = nm[1];
        const desc  = (attrs.match(/content-desc="([^"]*)"/)  ?? [])[1] ?? "";
        const rid   = (attrs.match(/resource-id="([^"]*)"/)   ?? [])[1] ?? "";
        const bm    = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!bm) continue;
        const cx = Math.round((Number(bm[1]) + Number(bm[3])) / 2);
        const cy = Math.round((Number(bm[2]) + Number(bm[4])) / 2);

        // Story-tray bubbles live in Instagram's upper feed header. A feed
        // post can expose an accessibility label such as
        // "<username>'s story, 1 of 0, Seen." on its author avatar, which
        // matches the broad story-label patterns below but is not a tray item.
        // Keep candidates in the generous upper 45% band; this still covers
        // the tray on tall/compact devices while excluding lower-feed avatars.
        if (cy > Math.round(h * 0.45)) continue;

        // ── EXCLUSION: upload / own-story controls ────────────────────────────
        // "Add to story", "Add to your story", "Your story", etc. all end with
        // "story" and would match the broad patterns below. Reject them HERE,
        // before any inclusion check, so they can never enter the candidate list
        // regardless of their screen position.
        const UPLOAD_EXCLUDE_RE = /^(add(\s+to)?(\s+your)?\s+story|your\s+story|create(\s+a)?\s+story|new\s+story)$/i;
        if (UPLOAD_EXCLUDE_RE.test(desc.trim())) continue;

        // ── Pattern 1: content-desc ending in "'s story" (ASCII or Unicode) ──
        // e.g. "fruitthchaz's story"  "lyrics_mood_0_'s story"
        const isStoryDesc =
          /'s story\b/i.test(desc) ||
          /\u2019s story\b/i.test(desc) ||
          // Pattern 2: "View <username>'s story" (some builds prefix with "View ")
          /^view .+'s story$/i.test(desc) ||
          /^view .+\u2019s story$/i.test(desc) ||
          // Pattern 3: content-desc is exactly "<username>, story" or
          // "<username> story" or "<username> - story" (less common variants)
          /[,\-–]?\s*story$/i.test(desc) ||
          // Pattern 4: resource-id contains "reel_tray_item" or "story_tray"
          // (covers builds where the avatar ViewGroup has no useful content-desc)
          /reel_tray_item/i.test(rid) ||
          /story_tray/i.test(rid);

        if (!isStoryDesc) continue;

        bubbles.push({ cx, cy, desc: desc || rid });
      }

      // A tray bubble commonly has both a labelled parent and an avatar child
      // in the dump. Collapse those nested/overlapping nodes so "first bubble"
      // means the first physical tray item, not whichever XML node appeared
      // first.
      bubbles.sort((a, b) => a.cx - b.cx || a.cy - b.cy);
      const deduped: typeof bubbles = [];
      for (const bubble of bubbles) {
        const duplicate = deduped.some(existing =>
          Math.abs(existing.cx - bubble.cx) <= 24 &&
          Math.abs(existing.cy - bubble.cy) <= 24,
        );
        if (!duplicate) deduped.push(bubble);
      }

      if (deduped.length > 0) {
        const ownStory = deduped.shift()!;
        onLog?.(`Story tray: ignoring first bubble "${ownStory.desc}" at (${ownStory.cx},${ownStory.cy}) — upload-your-own-story control`);
      }
      return deduped;
    };

    // First attempt.
    let trayXml = await android.dumpUi(serial).catch(() => "");
    let storyBubbles = extractStoryBubbles(trayXml);

    // If the first dump finds nothing, wait briefly and retry once — the story
    // tray sometimes finishes populating slightly after the feed renders.
    if (storyBubbles.length === 0) {
      onLog?.(`Story tray: first dump found no story bubbles — waiting 500 ms and retrying…`);
      await new Promise(r => setTimeout(r, 500));
      trayXml = await android.dumpUi(serial).catch(() => "");
      storyBubbles = extractStoryBubbles(trayXml);
    }

    if (storyBubbles.length === 0) {
      onLog?.(`Story tray: no bubbles after initial Home check — tapping Home once more and re-checking…`);
      const retryHome = await android.findHomeTab(serial).catch(() => null);
      if (retryHome) {
        await android.tap(serial, retryHome.x, retryHome.y);
      } else {
        const { w: retryW, h: retryH } = getScreenSize(serial);
        await android.tap(serial, Math.round(retryW * 0.10), Math.round(retryH * 0.975));
      }
      await new Promise(r => setTimeout(r, 500));
      trayXml = await android.dumpUi(serial).catch(() => "");
      storyBubbles = extractStoryBubbles(trayXml);
    }

    if (storyBubbles.length === 0) {
      // Diagnostic: log every content-desc and resource-id in the dump so we
      // can see exactly what Instagram is outputting on this build.  Limited
      // to 40 entries so the log stays readable.
      const diagEntries: string[] = [];
      const diagRe = /<node\b([^>]*\/?>) */g;
      let dm: RegExpExecArray | null;
      while ((dm = diagRe.exec(trayXml)) !== null && diagEntries.length < 40) {
        const a = dm[1];
        const d = (a.match(/content-desc="([^"]*)"/) ?? [])[1] ?? "";
        const r = (a.match(/resource-id="([^"]*)"/)  ?? [])[1] ?? "";
        if (d || r) diagEntries.push(`desc="${d}" rid="${r}"`);
      }
      onLog?.(`Story tray: still no bubbles after retry — dump node sample: ${diagEntries.slice(0, 20).join(" | ") || "(dump was empty)"}`);
      onLog?.(`Story tray: no story bubbles found — no stories to open this cycle`);
      return { slot: 0, opened: false };
    }

    onLog?.(`Story tray: found ${storyBubbles.length} story bubble(s) in dump: ${storyBubbles.map(b => b.desc).join(", ")}`);

    // Try slot 1 first, then the rest in random order, up to 3 attempts total.
    const [first, ...rest] = storyBubbles;
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const ordered = [first, ...rest];
    const maxAttempts = Math.min(3, ordered.length);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const bubble = ordered[attempt];
      // Tap the exact centre of the node identified in the live dump. Never
      // apply a guessed offset after resolving a node.
      const tapX = bubble.cx;
      const tapY = bubble.cy;

      onLog?.(`Story tray: tapping "${bubble.desc}" at (${tapX},${tapY}) — attempt ${attempt + 1}/${maxAttempts}`);

      await android.tap(serial, tapX, tapY);
      await new Promise(r => setTimeout(r, 600));

      const stillOnFeedFast = await android.isStoryViewerOpenFast(serial).catch(() => null);
      const storyOpen = stillOnFeedFast === true
        ? true
        : await android.isInStoryViewerSlow(serial).catch(() => false);
      if (storyOpen) {
        onLog?.(`Story tray: "${bubble.desc}" opened successfully`);
        return { slot: attempt + 1, opened: true };
      }
      onLog?.(`Story tray: tap on "${bubble.desc}" did NOT open a story — story viewer not detected (likely hit a follow/suggestion badge)`);
    }

    onLog?.(`Story tray: exhausted ${maxAttempts} attempt(s) — no story opened this cycle`);
    return { slot: maxAttempts, opened: false };
  }
export async function runViewStoriesFromFeedLoop(serial: string, params: {
    slidesMin: number; slidesMax: number;
    slideWatchPctMin: number; slideWatchPctMax: number;
    likePercentMin: number; likePercentMax: number;
    shareDmPercentMin: number; shareDmPercentMax: number;
    commentPercentMin: number; commentPercentMax: number;
    clickAuthorPercentMin: number; clickAuthorPercentMax: number;
    alreadyInStoryViewer?: boolean;
    onLog?: (msg: string) => void;
  }, context: ViewStoriesOperationContext): Promise<{ storiesWatched: number; storyLikes: number }> {
    const { android, deviceProfileSwipe, getScreenSize, isCycleAborted, logger, sleepOrAbort, _viewStoriesLastDmRecipient } = context;
    params.onLog?.("[TRACE] stories: start");
    const {
      slidesMin, slidesMax,
      slideWatchPctMin, slideWatchPctMax,
      likePercentMin, likePercentMax,
      shareDmPercentMin, shareDmPercentMax,
      commentPercentMin, commentPercentMax,
      clickAuthorPercentMin, clickAuthorPercentMax,
      onLog,
    } = params;

    const totalStories = Math.floor(
      Math.min(slidesMin, slidesMax) +
      Math.random() * (Math.max(slidesMin, slidesMax) - Math.min(slidesMin, slidesMax) + 1)
    );
    if (totalStories <= 0) return { storiesWatched: 0, storyLikes: 0 };

    const { w, h } = getScreenSize(serial);
    // Logged once per run so a bad like/share tap or a false "sharing
    // disabled" can be cross-checked against the actual device resolution —
    // this farm runs multiple phone models with different aspect ratios,
    // and every tap coordinate and icon-scan band in this loop is a
    // percentage of w/h calibrated against one reference device.
    onLog?.(`Story loop: device resolution ${w}×${h}`);

    // Per-story action chances — sampled once for the whole session so
    // the overall distribution stays consistent.
    const likeChance  = (Math.min(likePercentMin, likePercentMax) +
      Math.random() * Math.abs(likePercentMax - likePercentMin)) / 100;
    const shareChance = (Math.min(shareDmPercentMin, shareDmPercentMax) +
      Math.random() * Math.abs(shareDmPercentMax - shareDmPercentMin)) / 100;
    const commentChance = (Math.min(commentPercentMin, commentPercentMax) +
      Math.random() * Math.abs(commentPercentMax - commentPercentMin)) / 100;
    const clickAuthorChance = (Math.min(clickAuthorPercentMin, clickAuthorPercentMax) +
      Math.random() * Math.abs(clickAuthorPercentMax - clickAuthorPercentMin)) / 100;
    const commentsConfigured = Number(commentPercentMin) > 0 && Number(commentPercentMax) > 0;
    onLog?.(
      `Story actions configured: like=${likePercentMin}-${likePercentMax}% ` +
      `share=${shareDmPercentMin}-${shareDmPercentMax}% ` +
      `comment=${commentPercentMin}-${commentPercentMax}% ` +
      `commentGate=${commentsConfigured ? "enabled" : "disabled"}`,
    );

    // Returns true only while the story viewer is genuinely still on screen.
    // Root-cause fix (Jul 2026): every prior fix in this loop assumed that
    // once a story opened, it stayed open for the rest of the per-slide
    // loop and for the whole multi-step DM-share sequence (icon scan → tap
    // → wait → pick recipient → wait → tap Send). Stories auto-advance (and
    // the LAST story in a user's tray auto-EXITS back to the home feed) on
    // their own ~5-6s timer regardless of what our script is doing — a
    // short/fast story, or a DM-share sequence whose waits alone add up to
    // several seconds, can run out that timer mid-sequence. When that
    // happens every remaining scripted tap in this function was firing
    // blind at whatever is now actually on screen — the home feed — which
    // is exactly how a "share to DM" tap turned into an accidental like on
    // a home-feed Reel (feed and story share-sheet coordinates overlap).
    // This check must run before every single tap below, not just once at
    // story-open time.
    //
    // Root-cause fix (Jul 2026, follow-up): this used to call findHomeTab
    // directly on every check, which requires a full uiautomator dump +
    // adb pull (~3-4s per call). Called up to 5-6 times inside one ~5-6s
    // story slide, THAT was consuming the slide's entire timer on safety
    // checks alone — the real reason likes/shares still stalled and
    // weren't "instant" even after the earlier fix removed the deliberate
    // pre-action watch delay. isStoryViewerOpenFast() does the same check
    // via a screenshot pixel scan (~100-300ms) and only ever returns a
    // confident `true`; it returns `null` whenever it can't tell for sure
    // (e.g. a single-story tray with no multi-segment progress bar), and
    // only THEN do we pay for the slow-but-proven accessibility-tree check.
    // `fastOnly = true` skips the slow uiautomator-dump fallback and requires
    // the fast pixel scan to POSITIVELY confirm the story viewer is open.
    // If the fast scan is inconclusive (returns null), we now FAIL CLOSED and
    // return false — the caller skips the action entirely.
    //
    // Root cause of the audio/music mis-tap bug: when fastOnly was inconclusive
    // the old code assumed the story was still open and allowed the share icon
    // scan to proceed. After a story auto-closes to the home feed, the lower-
    // screen pixel scan mistook the feed post’s audio/music icon for the story
    // share control and tapped it. Failing closed skips a rare like/share but
    // eliminates the mis-tap on unrelated feed controls entirely.
    const stillInStoryViewer = async (fastOnly = false) => {
      const fastStart = Date.now();
      const fast = await android.isStoryViewerOpenFast(serial).catch(() => null);
      if (fast === true) return true;
      if (fastOnly) {
        // Can't positively confirm viewer from pixels alone — fail CLOSED.
        // Skip the action rather than risk tapping a feed control (e.g.
        // audio/music icon) after the story auto-closes to the home feed.
        onLog?.(`  (story-viewer check: fast scan ${Date.now() - fastStart}ms inconclusive — fastOnly, failing closed)`);
        return false;
      }
      // Instrumented (12 Jul 2026): the previous version of this fix
      // assumed the fast pixel-scan check would hit most of the time and
      // never verified it in the field. Log every fallback with real
      // timings so the next report shows hard numbers (how often the fast
      // check misses, how long the slow dump actually costs on this
      // device) instead of guessing from story-loop timestamps.
      const slowStart = Date.now();
      // isInStoryViewerSlow checks for POSITIVE story-viewer markers first
      // (reel_viewer/toolbar_like_button resource IDs), then for the home tab
      // via content-desc/resource-id only — no positional fallback.  The old
      // findHomeTab-based check used strategy-3 positional fallback which
      // matched the story viewer's own bottom-bar clickables ("Send message"
      // input + heart/share icons all sit at y > 88%), making it return
      // non-null and falsely concluding the viewer was closed.
      const result = await android.isInStoryViewerSlow(serial).catch(() => false);
      onLog?.(`  (story-viewer check: fast scan ${slowStart - fastStart}ms inconclusive → slow dump ${Date.now() - slowStart}ms)`);
      return result;
    };

    // If the caller already confirmed the Story viewer, do not scan or tap
    // Home-feed story bubbles inside the viewer.
    const { slot: picked, opened: storyOpened } = params.alreadyInStoryViewer
      ? (onLog?.("Story viewer already active — skipping story-bubble picker"), { slot: 0, opened: true })
      : await pickAndOpenRandomStory(serial, w, h, onLog, context);
    logger.info({ serial, picked, totalStories, storyOpened }, "[view-stories] story open attempt");

    // If the tray tap didn't actually open a story (bottom nav was still
    // visible after the tap — meaning we hit a follow badge or missed the
    // bubble entirely) there is nothing to like or share.  Acting on whatever
    // is currently visible would mean double-tapping a home-feed post (which
    // likes it) or tapping dead air. Return zero watched rather than
    // accidentally interacting with the wrong screen.
    if (!storyOpened) {
      onLog?.("Story tray: no story opened — skipping story actions for this cycle");
      return { storiesWatched: 0, storyLikes: 0 };
    }

    await sleepOrAbort(serial, 1800 + Math.floor(Math.random() * 3201)); // let viewer animate open

    let storiesWatched = 0;
    let storyLikes = 0;

    for (let s = 0; s < totalStories; s++) {
      if (isCycleAborted(serial)) break;
      const storyTimingStartedAt = Date.now();
      let storyTimingAfterChecks = storyTimingStartedAt;
      let storyTimingAfterWatch = storyTimingStartedAt;
      let storyTimingAfterActions = storyTimingStartedAt;

      // Mid-story interstitial guard — runs at the start of every slide.
      // The "Interacting with content shared from Facebook" dialog (and
      // similar full-screen popups) block all further interaction and cannot
      // be dismissed by tapping outside — only their primary OK button works.
      // dismissInstagramInterstitials handles this and other known dialogs,
      // so we check once per slide before doing anything else.  Most slides
      // produce no dump cost because dismissInstagramInterstitials reuses any
      // preloaded XML passed to it; here we let it do its own dump since we
      // have none yet at the top of the iteration.
      const _storySlidePopup = await android.dismissInstagramInterstitials(serial).catch(() => null);
      if (_storySlidePopup) {
        onLog?.(`View Stories ${s + 1}: mid-story popup dismissed (${_storySlidePopup})`);
        logger.info({ serial, story: s + 1, dismissed: _storySlidePopup }, "[view-stories] mid-story interstitial dismissed");
        await sleepOrAbort(serial, 400 + Math.floor(Math.random() * 4601));
      }

      // Like, share, and/or comment on this story?
      const willLike        = likeChance        > 0 && Math.random() < likeChance;
      const willShare       = shareChance       > 0 && Math.random() < shareChance;
      const willComment     = commentsConfigured && commentChance > 0 && Math.random() < commentChance;
      onLog?.(
        `View Stories ${s + 1}: action roll like=${willLike ? "yes" : "no"} ` +
        `share=${willShare ? "yes" : "no"} comment=${willComment ? "yes" : "no"} ` +
        `commentGate=${commentsConfigured ? "enabled" : "disabled"}`,
      );
      const willClickAuthor = clickAuthorChance > 0 && Math.random() < clickAuthorChance;
      storyTimingAfterChecks = Date.now();

      // Watch this story for a random percentage of its ~6s duration — but
      // ONLY when no action is scheduled on this slide. When a like and/or
      // share is scheduled, fire immediately — no delay, no pre-action
      // viewer check. Root-cause fix (Jul 2026): the "fast" pixel-scan
      // viewer check was taking ~2.7s on this farm's devices (screenshot
      // round-trip), so 250ms delay + 2.7s check = ~3s before the like
      // fired — longer than a 3-second story slide. The story auto-advanced
      // before the doubleTap ever ran. Pre-action check removed entirely;
      // we are guaranteed to be in the viewer at this point (opened 1800ms
      // ago, nothing has navigated away). Post-action checks (pre-advance
      // at line ~2076, pre-exit at ~2106) still guard against blind taps
      // after the slide timer expires.
      if (!(willLike || willShare || willComment || willClickAuthor)) {
        const watchPct = Math.min(slideWatchPctMin, slideWatchPctMax) +
          Math.random() * Math.abs(slideWatchPctMax - slideWatchPctMin);
        const watchTarget = watchPct / 100;
        const watchStarted = Date.now();
        let reachedTarget = false;
        let previousProgress: number | null = null;
        while (Date.now() - watchStarted < 60000) {
          const progress = await android.readStoryProgress(serial).catch(() => null);
          if (progress == null) {
            await sleepOrAbort(serial, 180);
            continue;
          }
          if (previousProgress != null && progress + 0.15 < previousProgress) {
            onLog?.(`View Stories ${s + 1}: story segment advanced before target (${(progress * 100).toFixed(0)}%)`);
            break;
          }
          previousProgress = progress;
          if (progress >= watchTarget) {
            reachedTarget = true;
            break;
          }
          await sleepOrAbort(serial, 180);
        }
        onLog?.(
          `View Stories ${s + 1}: progress target=${(watchTarget * 100).toFixed(0)}% ` +
          `reached=${reachedTarget ? "yes" : "no"} elapsed=${((Date.now() - watchStarted) / 1000).toFixed(1)}s`,
        );
      }
      storyTimingAfterWatch = Date.now();

      if (willLike) {
        // Tap the story Like button via the accessibility tree.
        //
        // Previous approach: double-tap at fixed screen-centre percentages
        // (w*0.50, h*0.44). Violated the project rule against hardcoded
        // coordinates and was not reliably registering on this farm's devices
        // (confirmed from log: "liked (double-tap at (540,1082))" fired but
        // the Like Story button still showed cd="Like Story" afterwards).
        //
        // Fix: find toolbar_like_button by resource-id via findStoryLikeButtonViaA11y
        // and tap it once — same as every other button in this codebase.
        // Falls back to the legacy double-tap if the a11y lookup fails.
        const likeBtn = await android.findStoryLikeButtonViaA11y(serial).catch(() => null);
        if (likeBtn) {
          await android.tap(serial, likeBtn.x, likeBtn.y);
          storyLikes++;
          logger.info({ serial, story: s + 1, x: likeBtn.x, y: likeBtn.y }, "[view-stories] liked story via a11y toolbar_like_button");
          onLog?.(`View Stories ${s + 1}: liked via a11y at (${likeBtn.x},${likeBtn.y})`);
        } else {
          // Like button not found in accessibility tree — skip the like entirely.
          //
          // The previous fallback (double-tap at w*0.50, h*0.44) is PERMANENTLY
          // REMOVED. Tapping at the centre of the story screen is not safe:
          // story authors commonly place link stickers, mention stickers, and
          // hashtag stickers anywhere in the 30–60% height band. A tap on any
          // of these navigates away from the story viewer — to an external URL,
          // a profile page, or a hashtag feed — exactly the "random shit clicked
          // mid-story" bug that has recurred repeatedly.
          //
          // Skipping the like on this slide is always safer than a blind
          // centre-screen tap that can and does cause unintended navigation.
          logger.info({ serial, story: s + 1 }, "[view-stories] like button not found via a11y — skipping like (no fallback tap)");
          onLog?.(`View Stories ${s + 1}: like skipped — toolbar_like_button not found in a11y tree (no centre-screen tap; fallback removed)`);
        }
        // When a share is also scheduled on this slide, don't linger here —
        // every extra ms is runway the DM-share sequence won't have.
        await sleepOrAbort(serial, willShare
          ? 100 + Math.floor(Math.random() * 4901)
          : 200 + Math.floor(Math.random() * 4801));
      }

      if (willShare && !(await stillInStoryViewer(/* fastOnly= */ true))) {
        onLog?.(`View Stories ${s + 1}: story viewer closed before share could start — skipping share`);
        logger.info({ serial, story: s + 1 }, "[view-stories] story viewer gone before share attempt");
      } else if (willShare) {
        // Scan for icons BEFORE tapping — skip share entirely if the
        // paper-plane isn't present (story owner has sharing disabled).
        //
        // Previous approach: blind tap at fixed right-edge coordinates, then
        // check if the keyboard opened. Problem: that tap always lands inside
        // the message field when sharing is disabled (the field expands to
        // fill the full bar width), briefly opening the keyboard and
        // disrupting the story before we back out.
        //
        // Fix: run findStoryActionIcons() first.  When sharing is disabled
        // only the heart icon is visible — the scan returns 0 or 1 cluster.
        // When sharing is enabled the heart AND paper-plane both appear — the
        // scan returns ≥2 clusters, and the rightmost cluster IS the
        // paper-plane.  We only tap if ≥2 icons were found, and we tap the
        // actual detected coordinates rather than a guessed percentage.
        // The keyboard check is kept as a final safety net.
        // Strategy 1: UIAutomator accessibility probe.
        // Instagram draws the story reply-bar on a canvas with no accessible
        // child elements on most device/version combinations, but some builds
        // DO label the paper-plane. Try the a11y tree first (fast, zero tap
        // risk on wrong coordinates) and fall back to the pixel scan only if
        // Strategy 1 (v1.1.580): UIAutomator a11y probe — tries known labels and
        // the text-field-anchor approach.  Now also passes onLog so the full
        // diagnostic dump of every node in the lower 35 % of the screen appears
        // in the Log tab on every share attempt.  If it returns null, fall
        // through to the pixel scan unchanged.
        //
        // NOTE: the positional probe (find rightmost clickable in the bar zone)
        // was REMOVED in v1.1.581 — it reliably returned the text-input field
        // centre (~60 % of screen width) rather than the paper-plane (~88–93 %),
        // burning the slide timer with three keyboard-opening retries.
        let shareIconPos: { x: number; y: number } | null = null;
        const a11yPos = await android.findStoryShareButtonViaA11y(serial, (msg) => onLog?.(msg)).catch(() => null);
        if (a11yPos) {
          shareIconPos = a11yPos;
          onLog?.(`View Stories ${s + 1}: share button located via a11y at (${a11yPos.x},${a11yPos.y})`);
        } else {
          // Strategy 2: pixel scan.
          const iconScan = await android.findStoryActionIcons(serial).catch(() => null);
          const rawPos = (iconScan && iconScan.length >= 2) ? iconScan[iconScan.length - 1] : null;
          onLog?.(`View Stories ${s + 1}: pixel scan — ${iconScan == null ? "screenshot unavailable" : `${iconScan.length} cluster(s) found`}${rawPos ? ` — rightmost at (${rawPos.x},${rawPos.y})` : " — <2 clusters (sharing disabled or scan miss)"}`);
          // Sanity check: the paper-plane is always in the rightmost ~15–20 %
          // of the screen.  The v1.1.580 threshold of 40 % was too permissive
          // and would accept false content-cluster matches in the centre of the
          // frame.  Raised to 65 % — anything left of that is not the paper-
          // plane regardless of device resolution.
          if (rawPos && rawPos.x > w * 0.65) {
            shareIconPos = rawPos;
          } else if (rawPos) {
            onLog?.(`View Stories ${s + 1}: pixel scan result rejected — x=${rawPos.x} < 65% of w=${w}; false content match — skipping share`);
            logger.warn({ serial, story: s + 1, rawX: rawPos.x, w }, "[view-stories] share pixel-scan rejected — x too far left");
          }
        }

        let opened = false;
        if (!shareIconPos) {
          // no usable position — skip without touching the screen
          logger.info({ serial, story: s + 1 }, "[view-stories] share skipped — paper-plane not found");
          onLog?.(`View Stories ${s + 1}: share skipped — owner has sharing disabled (no paper-plane detected)`);
        } else {
          // Tap the paper-plane once and wait for the share sheet — identical
          // to the feed share-to-DM flow which does not use a keyboard check.
          //
          // DO NOT use isKeyboardShown() here.  When the paper-plane tap
          // correctly opens the DM share sheet, the sheet's search box
          // ("Search" EditText) auto-focuses and raises the soft keyboard —
          // so isKeyboardShown() returns true even on a SUCCESSFUL tap.
          // The old keyboard-check-and-retry loop therefore pressed Back every
          // time the sheet opened correctly, closing it immediately, then
          // repeated 3 times — which is exactly the "clicking and closing the
          // share sheet" behaviour reported (15 Jul 2026).
          //
          // Sheet confirmation is handled below via direct_private_share
          // resource-id (the same signal sendShareSheet uses), which
          // unambiguously distinguishes "sheet open" from "nothing happened".
          await android.tap(serial, shareIconPos.x, shareIconPos.y);
          onLog?.(`View Stories ${s + 1}: tapped paper-plane at (${shareIconPos.x},${shareIconPos.y}) — waiting for share sheet`);
          await sleepOrAbort(serial, 200 + Math.floor(Math.random() * 4801)); // let the sheet render
          opened = true;
        }
        if (opened) {
          await sleepOrAbort(serial, 150 + Math.floor(Math.random() * 4851)); // wait for recipient picker
          // Confirm the sheet actually rendered BEFORE firing the recipient
          // tap. Root-cause fix (12 Jul 2026, user-reported): the only gate
          // that used to exist here was "no keyboard AND still in story
          // viewer" — but that's true both when the sheet genuinely opened
          // AND when the paper-plane tap landed on something that did
          // neither (e.g. a slightly mis-scanned icon position that missed
          // every real element). In that second case `opened` was still set
          // true, and the very next line blind-tapped recipient slot 1 at
          // x≈15% of screen width — which, on the plain story screen
          // underneath (no sheet actually covering it), is squarely inside
          // Instagram's "go to previous story" tap zone. That's the
          // "clicked backwards" bug: the bot wasn't confused about DM UI,
          // it just never verified the DM sheet was really there before
          // tapping into it blind.
          //
          // The Send button only ever exists inside this DM share sheet, so
          // finding it is a reliable positive signal the sheet is open —
          // unlike the absence checks used above, which can't tell "sheet
          // open" apart from "nothing happened at all".
          // Capture the Send button position — proves the sheet is open AND
          // passes it to sendShareSheet so it can skip its own 2–3s a11y dump.
          // Uses confirmAndScanShareSheet (one dump for both confirm + recipient
          // scan) instead of two sequential dumps — every second here eats into
          // the story's fixed auto-advance timer (see story-action-timing-
          // starvation), so the single-dump path matters even more here than on
          // the feed/reels flows.
          const storyShareScan = await android.confirmAndScanShareSheet(serial, onLog).catch(() => null);
          const sheetSendBtn = storyShareScan?.sendBtn ?? null;
          if (!sheetSendBtn) {
            logger.warn({ serial, story: s + 1 }, "[view-stories] share sheet not confirmed open (no Send button found) — skipping recipient tap to avoid a blind tap on the story underneath");
            onLog?.(`View Stories ${s + 1}: share aborted — could not confirm the share sheet actually opened (no Send button found) — skipped recipient tap rather than risk tapping the story underneath`);
          } else {
          // ── View Stories — Share via DM: recipient pick + send (isolated; not shared with any other tool) ──
          const _stRecipients = storyShareScan?.recipients ?? [];
          if (_stRecipients.length === 0) {
            await android.pressBack(serial);
            logger.warn({ serial, story: s + 1 }, "[view-stories] no recipient found — closed share sheet without sending");
            onLog?.(`View Stories ${s + 1}: share skipped — no recipient avatars found in sheet (closed without sending)`);
          } else {
            const _stLast = _viewStoriesLastDmRecipient.get(serial);
            const _stPool = _stLast ? _stRecipients.filter(r => !(r.x === _stLast.x && r.y === _stLast.y)) : _stRecipients;
            const _stCands = _stPool.length > 0 ? _stPool : _stRecipients;
            const _stPick = _stCands[Math.floor(Math.random() * _stCands.length)];
            _viewStoriesLastDmRecipient.set(serial, { x: _stPick.x, y: _stPick.y });
            onLog?.(`View Stories ${s + 1}: tapping recipient at (${_stPick.x},${_stPick.y})${(_stPick as any).name ? ` (${(_stPick as any).name})` : ""}`);
            await android.tap(serial, _stPick.x, _stPick.y);
            await sleepOrAbort(serial, 200 + Math.floor(Math.random() * 4801)); // brief pause for selection to register
            // No "still in story viewer?" check here — sheetSendBtn already confirms
            // the story was showing when the sheet opened. Adding an a11y dump
            // (fast 1–1.5s + slow 2.7s = 4.2s) burns the remaining slide budget
            // without providing meaningful protection.
            const _stIsOpen = async () => {
              const _x = await android.dumpUi(serial).catch(() => "");
              return _x.includes("direct_private_share") || _x.includes("grid_view_pog_avatar_view") ||
                     _x.includes("android.widget.EditText") || _x.includes("Copy link") || _x.includes("Add to story");
            };
            const _stSb = sheetSendBtn ?? await android.findButtonByLabel(serial, "Send").catch(() => null);
            if (_stSb) {
              await android.tap(serial, _stSb.x, _stSb.y);
              await sleepOrAbort(serial, 300 + Math.floor(Math.random() * 4701));
              if (!(await _stIsOpen())) {
                logger.info({ serial, story: s + 1 }, "[view-stories] shared story via DM — Send tapped");
                onLog?.(`View Stories ${s + 1}: shared via DM — Send tapped`);
                await sleepOrAbort(serial, 200 + Math.floor(Math.random() * 4801));
              } else {
                await android.pressBack(serial);
                logger.info({ serial, story: s + 1 }, "[view-stories] Send button not found — closed DM picker");
                onLog?.(`View Stories ${s + 1}: Send button not found — closed DM picker`);
                await sleepOrAbort(serial, 200);
              }
            } else if (!(await _stIsOpen())) {
              logger.info({ serial, story: s + 1 }, "[view-stories] share sheet already closed — DM likely sent by recipient tap");
              onLog?.(`View Stories ${s + 1}: shared via DM — sheet auto-dismissed (sent by recipient tap)`);
              await sleepOrAbort(serial, 150 + Math.floor(Math.random() * 4851));
            } else {
              const _stFbX = Math.round(w * 0.50), _stFbY = Math.round(h * 0.982);
              onLog?.(`View Stories ${s + 1}: Send button not found via a11y — tapping coordinate fallback (${_stFbX},${_stFbY})`);
              await android.tap(serial, _stFbX, _stFbY);
              await sleepOrAbort(serial, 300 + Math.floor(Math.random() * 4701));
              if (!(await _stIsOpen())) {
                onLog?.(`View Stories ${s + 1}: ✓ shared via DM — sent via coordinate fallback`);
                await sleepOrAbort(serial, 200 + Math.floor(Math.random() * 4801));
              } else {
                await android.pressBack(serial);
                await sleepOrAbort(serial, 200 + Math.floor(Math.random() * 4801));
              }
            }
          }
          } // closes sheetSendBtn else
        }
      }

      // ── View Stories — Emoji comment reply ─────────────────────────────
      // Selects an emoji through the live keyboard accessibility tree as a
      // reply to the current story slide.
      // Only fires when the author allows message replies — confirmed by
      // the presence of id="message_composer_container" with
      // desc="Send Message or Reaction" in the accessibility tree.
      //
      // Flow:
      //   SEND-MESSAGE-BAR  → message_composer_container present → tap to open keyboard
      //   ENTER-MESSAGE     → keyboard open; resolve the Emoji control and picker
      //                       cell from the live IME accessibility tree
      //   TAP-SEND-PAPER-AIRPLANE → emoji in field, send button visible:
      //                       id="row_thread_composer_send_button_background" desc="Send"
      if (commentsConfigured && willComment && (await stillInStoryViewer(/* fastOnly= */ true))) {
        try {
          const _cXml = await android.dumpUi(serial).catch(() => "");
          const _hasComposerContainer =
            /(?:id|resource-id)="[^"]*message_composer_container"/.test(_cXml);
          const _hasLegacyComposerLabel =
            /(?:content-desc|desc)="Send Message or Reaction"/i.test(_cXml);
          const _hasVisibleComposerLabel =
            /(?:id|resource-id)="[^"]*composer_text"/.test(_cXml) &&
            /(?:text|content-desc)="Send message"/i.test(_cXml);
          onLog?.(
            `View Stories ${s + 1}: message composer probe — ` +
            `container=${_hasComposerContainer ? "yes" : "no"}, ` +
            `legacy-label=${_hasLegacyComposerLabel ? "yes" : "no"}, ` +
            `visible-label=${_hasVisibleComposerLabel ? "yes" : "no"}`,
          );

          // Do not require one Instagram resource-id. Xiaomi/Instagram builds
          // can render the visible reply bar while exposing only a generic
          // lower-screen node (or composer_text) in UIAutomator.
          const _composer = await android.findStoryReplyComposerViaA11y(
            serial,
            msg => onLog?.(`View Stories ${s + 1}: ${msg}`),
          );
          if (!_composer) {
            onLog?.(`View Stories ${s + 1}: emoji comment skipped — author has message replies disabled`);
            logger.info({ serial, story: s + 1 }, "[view-stories] emoji comment skipped — reply composer not found");
          } else {
            onLog?.(`View Stories ${s + 1}: tapping message composer at (${_composer.x},${_composer.y})…`);
            await android.tap(serial, _composer.x, _composer.y);
            await sleepOrAbort(serial, 800); // keyboard animates up

            // ── Open the Emoji picker through a verified layered tap ──
            //
            // Gboard may render its controls without exposing usable
            // accessibility nodes. The shared helper tries the live IME node,
            // then the same-device calibrated physical tap, then visual
            // keyboard geometry, verifying the Emoji picker after each tap.
            let _emojiKeyPressed = false;
            try {
              _emojiKeyPressed = await android.tapCalibratedKeyboardKey(
                serial,
                "emoji",
                msg => onLog?.(`View Stories ${s + 1}: ${msg}`),
              );
            } catch (e: any) {
              onLog?.(`View Stories ${s + 1}: calibrated Emoji bind failed — ${e?.message}`);
              logger.warn(
                { serial, story: s + 1, err: e?.message },
                "[view-stories] calibrated emoji bind failed",
              );
            }
            if (!_emojiKeyPressed) {
              onLog?.(
                `View Stories ${s + 1}: Emoji picker could not be opened by ` +
                `live-node, calibrated-tap, or visual fallback`,
              );
              await android.pressBack(serial).catch(() => {});
              continue;
            }

            await sleepOrAbort(serial, 350);
            try {
              const _emojiSelected = await android.tapKeyboardEmojiNode(
                serial,
                msg => onLog?.(`View Stories ${s + 1}: ${msg}`),
              );
              if (!_emojiSelected) {
                await android.pressBack(serial).catch(() => {});
                continue;
              }
            } catch (e: any) {
              onLog?.(`View Stories ${s + 1}: live Emoji picker node lookup failed — ${e?.message}`);
              logger.warn({ serial, story: s + 1, err: e?.message }, "[view-stories] live emoji node lookup failed");
              await android.pressBack(serial).catch(() => {});
              continue;
            }
            await sleepOrAbort(serial, 400); // selected emoji settles; send button appears

            // Find the send button that appears after the emoji is entered.
            // From TAP-SEND-PAPER-AIRPLANE dump:
            //   id="row_thread_composer_send_button_background" desc="Send"
            //   bounds=[898,1150][1041,1249] center=(970,1200)
            const _sendXml = await android.dumpUi(serial).catch(() => "");
            const _sendMatch = _sendXml.match(
              /id="row_thread_composer_send_button[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/
            );
            if (_sendMatch) {
              const _sbX = Math.round((+_sendMatch[1] + +_sendMatch[3]) / 2);
              const _sbY = Math.round((+_sendMatch[2] + +_sendMatch[4]) / 2);
              onLog?.(`View Stories ${s + 1}: tapping send at (${_sbX},${_sbY})…`);
              await android.tap(serial, _sbX, _sbY);
              await sleepOrAbort(serial, 300);
              onLog?.(`View Stories ${s + 1}: ✓ emoji reply sent`);
              logger.info({ serial, story: s + 1 }, "[view-stories] emoji comment sent");
            } else {
              // Send button not found — emoji may not have been entered or
              // keyboard is still showing. Press BACK to dismiss cleanly.
              await android.pressBack(serial).catch(() => {});
              await sleepOrAbort(serial, 300);
              onLog?.(`View Stories ${s + 1}: emoji comment — send button not found, dismissed keyboard`);
              logger.warn({ serial, story: s + 1 }, "[view-stories] emoji comment — send button not found after emoji tap");
            }
          }
        } catch (e: any) {
          if (e?.message === "cycle-aborted") throw e;
          onLog?.(`View Stories ${s + 1}: emoji comment error — ${e?.message}`);
          await android.pressBack(serial).catch(() => {}); // safety dismiss
        }
      }

      // ── Click author — visit the story author's profile ──────────────────────
      if (willClickAuthor) {
        try {
          if (isCycleAborted(serial)) throw new Error("cycle-aborted");
          const _saStillIn = await stillInStoryViewer(true);
          if (!_saStillIn) {
            onLog?.(`View Stories ${s + 1}: click-author — story viewer already closed, skipping`);
          } else {
            // Dump the story viewer to locate the author's avatar ring.
            // Do not tap reel_viewer_text_container: on current Instagram
            // builds it spans both the username header and the attribution/
            // song row, so its center can land on "Original audio" instead of
            // opening the author profile. The dedicated avatar node is the
            // unambiguous author target.
            const _saXml = await android.dumpUi(serial).catch(() => "");
            const _saNodeMatch =
              _saXml.match(/resource-id="[^"]*reel_viewer_profile_picture"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ??
              _saXml.match(/resource-id="[^"]*profile_picture_container"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
            if (!_saNodeMatch) {
              onLog?.(`View Stories ${s + 1}: click-author — author avatar ring not found in dump, skipping`);
            } else {
              const _saX = Math.round((+_saNodeMatch[1] + +_saNodeMatch[3]) / 2);
              const _saY = Math.round((+_saNodeMatch[2] + +_saNodeMatch[4]) / 2);
              onLog?.(`View Stories ${s + 1}: click-author — tapping author avatar ring at (${_saX},${_saY})…`);
              await android.tap(serial, _saX, _saY);
              await sleepOrAbort(serial, 1800); // profile page animates in
              // Scroll the profile 1–10 times; 2.5–8 s dwell after each scroll.
              const _saScrolls = 1 + Math.floor(Math.random() * 10);
              onLog?.(`View Stories ${s + 1}: click-author — scrolling author profile ${_saScrolls}x…`);
              const { w: _saW, h: _saH } = getScreenSize(serial);
              for (let _saI = 0; _saI < _saScrolls; _saI++) {
                if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                await deviceProfileSwipe(
                  serial,
                  {
                    x1: Math.round(_saW / 2), y1: Math.round(_saH * 0.75),
                    x2: Math.round(_saW / 2), y2: Math.round(_saH * 0.30),
                    durationMs: 350 + Math.round(Math.random() * 350),
                  },
                  "stories-author-profile-scroll",
                  "normal",
                );
                await sleepOrAbort(serial, 2500 + Math.round(Math.random() * 5500)); // 2.5–8 s
              }
              // Back once → returns to the story viewer.
              onLog?.(`View Stories ${s + 1}: click-author — returning from author profile…`);
              await android.pressBack(serial);
              await sleepOrAbort(serial, 700);
              onLog?.(`View Stories ${s + 1}: click-author — ✓ author profile visited`);
            }
          }
        } catch (e: any) {
          if (e?.message === "cycle-aborted") throw e;
          onLog?.(`View Stories ${s + 1}: click-author error — ${e?.message}`);
          await android.pressBack(serial).catch(() => {}); // safety return to story
        }
      }
      storyTimingAfterActions = Date.now();

      // Don't tap "advance to next slide" if we've already left the story
      // viewer — that tap would land on the feed and register as a like/
      // navigation there instead of harmlessly advancing a story slide.
      // Normal slide completion only needs a positive fast confirmation. If
      // the fast scan is inconclusive, fail closed and stop rather than paying
      // a 3–5s UIAutomator dump on every ordinary slide. The slow fallback is
      // still used for risky action paths and final recovery below.
      if (!(await stillInStoryViewer(true))) {
        onLog?.(`View Stories ${s + 1}: story viewer already closed — stopping story loop`);
        logger.info({ serial, story: s + 1 }, "[view-stories] story viewer gone at end of slide — stopping loop");
        storiesWatched++;
        break;
      }

      storiesWatched++;
      onLog?.(
        `View Stories ${s + 1}/${totalStories} timing — ` +
        `pre-watch/checks=${((storyTimingAfterChecks - storyTimingStartedAt) / 1000).toFixed(1)}s, ` +
        `watch-wait=${((storyTimingAfterWatch - storyTimingAfterChecks) / 1000).toFixed(1)}s, ` +
        `actions/author=${((storyTimingAfterActions - storyTimingAfterWatch) / 1000).toFixed(1)}s, ` +
        `total=${((storyTimingAfterActions - storyTimingStartedAt) / 1000).toFixed(1)}s`,
      );

      // Advance to the next story by tapping the far-right edge (~97%) of the
      // screen at ~45% height — but ONLY when there are more slides left to
      // watch.
      //
      // History of x-position changes and why:
      //   w*0.75  (original) — dead centre; hit collaboration/hashtag/mention
      //                        stickers constantly (all of which navigate away).
      //   w*0.92  (v1.2.30)  — far right, 8% inset from edge; still hit
      //                        mention stickers that the author placed in the
      //                        right portion of the frame (confirmed Jul 2026).
      //   w*0.97  (current)  — extreme right edge (3% inset, ~22 px on a
      //                        720-px-wide screen).  Story creators virtually
      //                        never place interactive stickers this close to
      //                        the physical edge (IG's editor snaps/clips them
      //                        away from that strip), so collision risk is
      //                        near-zero while the tap still lands in the
      //                        "right half = advance" zone Instagram recognises.
      //
      // History of y-position changes and why:
      //   h*0.15  (previous) — intended to clear the author header (~10%),
      //                        but the actual author bar (progress strip +
      //                        avatar + name + mute button) runs to ~12–15%
      //                        on most story layouts, so the tap landed on the
      //                        author's name/avatar and opened their profile
      //                        every time the advance fired (confirmed Jul 2026).
      //   h*0.45  (current)  — mid-screen; well below the author header
      //                        (~12–15%) and above the reply bar (~88%).
      //                        Interactive stickers (mentions, hashtags, links)
      //                        most commonly appear in the 20–60% band, but at
      //                        x=97% (the extreme physical edge) Instagram's
      //                        editor clips them away so sticker collision risk
      //                        remains near-zero at this x even at mid-screen y.
      //
      // Skipping the advance on the last iteration: on 3-second stories the
      // unnecessary last-tap would push to slide totalStories+1, causing the
      // tray to auto-advance to the next user's stories instead of staying on
      // the final slide until we swipe down.
      if (s < totalStories - 1) {
        await android.tap(serial, Math.round(w * 0.97), Math.round(h * 0.45));
        await sleepOrAbort(serial, 500 + Math.round(Math.random() * 400));
      }
    }

    // End the story tool with one downward swipe. Do not inspect foreground
    // package, validate the viewer, press Back, or perform Home-tab recovery.
    // If the story viewer is open, this exits it; otherwise Instagram simply
    // refreshes/scrolls the feed, which is acceptable.
    const { w: _storyExitW, h: _storyExitH } = getScreenSize(serial);
    onLog?.("Story exit: swiping down to leave the story viewer");
    await deviceProfileSwipe(
      serial,
      {
        x1: Math.round(_storyExitW / 2),
        y1: Math.round(_storyExitH * 0.30),
        x2: Math.round(_storyExitW / 2),
        y2: Math.round(_storyExitH * 0.85),
        durationMs: 500,
      },
      "story-exit",
      "back",
    );
    await sleepOrAbort(serial, 800);
    return { storiesWatched, storyLikes };

    // ── Ad / deviation recovery ───────────────────────────────────────────
    // A "next story" advance tap that lands on a sponsored post's CTA button
    // (or a swipe Instagram intercepts for a full-screen ad) can open Chrome
    // or Instagram's in-app WebView, taking us completely out of the story
    // viewer — and possibly out of the Instagram app entirely.  Every
    // subsequent scripted tap would land on the wrong app.  Check the
    // foreground package and press Back until we are back in Instagram before
    // doing anything else (including the exit-swipe below).
    const _stPkg = await android.getForegroundPackage(serial).catch(() => null);
    if (_stPkg && _stPkg !== "com.instagram.android") {
      onLog?.(`Story loop: deviated — foreground app is "${_stPkg}" (expected Instagram) — pressing Back to recover`);
      logger.info({ serial, pkg: _stPkg }, "[view-stories] deviated to external app — pressing Back to recover");
      for (let _stRi = 0; _stRi < 5; _stRi++) {
        await android.pressBack(serial);
        await sleepOrAbort(serial, 700);
        const _stNowPkg = await android.getForegroundPackage(serial).catch(() => null);
        if (!_stNowPkg || _stNowPkg === "com.instagram.android") {
          onLog?.(`Story loop: recovered — back in Instagram after ${_stRi + 1} Back press(es)`);
          logger.info({ serial, attempts: _stRi + 1 }, "[view-stories] recovered to Instagram after ad deviation");
          break;
        }
      }
    }

    // Exit the story viewer with Android Back — only if we're actually still
    // in it. Do not use a swipe here: the established Story exit contract is
    // Back, and a swipe can leave Instagram in the viewer or advance content.
    if (await stillInStoryViewer()) {
      onLog?.("Story exit: pressing Android Back");
      logger.info({ serial }, "[view-stories] exiting story viewer with Android Back");
      await android.pressBack(serial);
    }
    await sleepOrAbort(serial, 800);

    // ── Home-feed recovery ─────────────────────────────────────────────────
    // Even at x=97%, an advance tap can occasionally land on a mention/collab
    // sticker placed near the right edge, navigating to the story author's
    // profile page.  The ad-deviation block above only catches non-Instagram
    // apps; this block catches the intra-Instagram case where we're left on a
    // non-feed surface.
    //
    // Detection: findHomeTab looks for content-desc="Home" or the feed_tab
    // resource-id in the accessibility tree.
    //
    // Recovery: ALWAYS tap the Home tab when it is visible rather than just
    // checking for its presence.  The Reels full-screen player still shows the
    // bottom nav (Home tab visible), so the old null-only guard passed through
    // it without navigating back to the feed.  Tapping Home is safe on the
    // feed (stays/refreshes) AND correctly exits the Reels player back to the
    // home feed.  When the Home tab is absent entirely (Chrome, deep link,
    // etc.) fall back to pressing Back once.
    //
    // Root cause (observed Jul 2026): after all story slides ended naturally,
    // Instagram auto-navigated to the Reels full-screen player.  findHomeTab
    // returned non-null (bottom nav still visible in Reels), so the old
    // null-only guard did nothing and the automation cycle continued inside
    // the Reels player instead of the home feed.
    {
      const _stFeedTab = await android.findHomeTab(serial).catch(() => null);
      if (_stFeedTab) {
        onLog?.("Story exit: tapping Home tab to return to home feed (guards against Reels/profile auto-navigation after story end)");
        logger.info({ serial }, "[view-stories] tapping Home tab post-exit to ensure home feed");
        await android.tap(serial, _stFeedTab.x, _stFeedTab.y);
        await sleepOrAbort(serial, 700);
      } else {
        // When the reply composer/keyboard is focused, Back dismisses only the
        // keyboard. Returning immediately here leaves Instagram inside the
        // story viewer and the next dispatcher tool starts on that screen.
        // Recover in bounded steps, re-dumping after every Back, until Home is
        // positively visible or the viewer is positively gone.
        for (let _stRecovery = 0; _stRecovery < 3; _stRecovery++) {
          onLog?.(
            `Story exit: home tab absent after story loop — pressing Back ` +
            `(${_stRecovery + 1}/3) and rechecking`,
          );
          logger.info({ serial, attempt: _stRecovery + 1 }, "[view-stories] home tab absent post-exit — pressing Back and rechecking");
          await android.pressBack(serial);
          await sleepOrAbort(serial, 600);
          const _stRecoveredHome = await android.findHomeTab(serial).catch(() => null);
          if (_stRecoveredHome) {
            onLog?.("Story exit: Home tab confirmed after Back recovery — returning to home feed");
            await android.tap(serial, _stRecoveredHome.x, _stRecoveredHome.y);
            await sleepOrAbort(serial, 700);
            break;
          }
          if (!(await android.isInStoryViewerSlow(serial).catch(() => false))) {
            onLog?.("Story exit: Story viewer no longer detected after Back recovery");
            break;
          }
        }
      }
    }

    return { storiesWatched, storyLikes };
  }