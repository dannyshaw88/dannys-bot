export interface FollowOperationContext {
  [key: string]: any;
  android: any;
  storage: any;
  logger: any;
}

export interface InjectBrowsingParams {
  activatePctMin: number; activatePctMax: number;
  beforeFollowPctMin: number; beforeFollowPctMax: number;
  feedMin: number; feedMax: number;
  clickPostPctMin: number; clickPostPctMax: number;
  likePctMin: number; likePctMax: number;
  shareFeedPctMin: number; shareFeedPctMax: number;
  shareDmPctMin: number; shareDmPctMax: number;
  /** Chance (%) to save the viewed post — taps the ribbon/bookmark icon. */
  savePostPctMin: number; savePostPctMax: number;
  /** Chance (%) to skip the follow entirely after browsing — adds variation
   *  so not every browsing session ends in a follow. The user can still be
   *  scraped and followed again later by any account. */
  abandonFollowPctMin: number; abandonFollowPctMax: number;
  /** Chance (%) to tap one of the profile's story highlight circles and
   *  dwell in it briefly before swiping down to dismiss. Fires before OR
   *  after the profile-grid scroll (50/50 coin flip per user). */
  tapHighlightsPctMin: number; tapHighlightsPctMax: number;
}

/** Picks a value uniformly from [lo, hi], tolerating either order. */
function rollRange(min: number, max: number): number {
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return lo + Math.random() * (hi - lo);
}

/** Finish one Spread Follow assignment without leaking search cleanup policy. */
export async function finishSpreadFollowSearch(
  serial: string,
  context: {
    android: any;
    sleepOrAbort: (...args: any[]) => Promise<void>;
    onLog?: (message: string) => void;
  },
): Promise<void> {
  const { android, sleepOrAbort, onLog } = context;
  try {
    await android.clearInstagramSearchBar(serial, (message: string) =>
      onLog?.(`Spread Follow: final cleanup — ${message}`),
    );
    await android.pressBack(serial);
    await sleepOrAbort(serial, 500, "accountSwitching");
    await android.pressBack(serial);
    await sleepOrAbort(serial, 500);
    onLog?.("Spread Follow: final cleanup — pressed Back twice to restore normal UI");
  } catch (error: any) {
    if (error?.message === "cycle-aborted") throw error;
    onLog?.(`Spread Follow: final cleanup failed — ${error?.message ?? "unknown error"}`);
  }
}

/**
 * Activate Percentage gate — rolls once per tool per automation-cycle
 * execution ("execution" = one full run of the whole toggle-tick loop,
 * i.e. once every wait-interval). A min/max of 100/100 always passes
 * (back-compat default); e.g. 5/10 gives this execution roughly a 5-10%
 * (~7.5% avg) chance of the tool being active at all this time around.
 */
function rollActivate(min: number, max: number): boolean {
  const chance = rollRange(min, max) / 100;
  return chance > 0 && Math.random() < chance;
}

/**
 * Decides, for ONE user, whether Inject Browsing runs at all this user
 * and — independently — whether it should run before or after the Follow
 * tap. These are two separate rolls, not one combined gate:
 *
 *   - `activatePct` — whether browsing happens for this user at all.
 *   - `beforeFollowPct` — GIVEN that it happens, the odds it happens
 *     before the follow (vs. after). This does NOT gate whether browsing
 *     happens — it only orders it.
 *
 * Fix (15 Jul 2026): previously `beforeFollowPct` was (incorrectly) used
 * as a second on/off gate stacked on top of `activatePct` — if that roll
 * missed, browsing was skipped entirely for the user, with no "after
 * follow" branch ever implemented. That made "before follow" look like it
 * meant "follow first, never browse" whenever the roll missed. Now a miss
 * only changes the order to after-follow; browsing still runs whenever
 * `activatePct` says it should.
 */
function rollInjectBrowsingDecision(browsing: InjectBrowsingParams): { willBrowse: boolean; browseBeforeFollow: boolean } {
  const activateChance = rollRange(browsing.activatePctMin, browsing.activatePctMax) / 100;
  const willBrowse = activateChance > 0 && Math.random() < activateChance;
  if (!willBrowse) return { willBrowse: false, browseBeforeFollow: false };
  const beforeFollowChance = rollRange(browsing.beforeFollowPctMin, browsing.beforeFollowPctMax) / 100;
  const browseBeforeFollow = beforeFollowChance > 0 && Math.random() < beforeFollowChance;
  return { willBrowse, browseBeforeFollow };
}

/**
 * Taps one randomly chosen story highlight on the profile page, dwells
 * inside the story viewer for 2–20 s, then swipes down to close if still
 * in the viewer (auto-close means only one story existed).
 *
 * Detection: Instagram renders highlight circles as tappable nodes in the
 * profile header area. They appear with content-desc patterns like
 * "meh Highlight" or "gym Highlight", or with resource-ids that contain
 * "highlight". We scan the live a11y dump and pick one at random.
 * If none are found (profile has no highlights) the call is a silent no-op.
 */
async function tapOneProfileHighlight(
  serial: string,
  onLog?: (msg: string) => void,
  context?: FollowOperationContext,
): Promise<void> {
  const { android, isCycleAborted, getScreenSize, deviceProfileSwipe, sleepOrAbort } = context!;
  try {
    if (isCycleAborted(serial)) throw new Error("cycle-aborted");
    const { h: _hlH } = getScreenSize(serial);
    const xml = await android.dumpUi(serial).catch(() => "");

    // ── Structural highlight-circle detection ────────────────────────────
    //
    // Highlight circles are identified purely by their position in the
    // accessibility tree — NOT by content-desc or any user-visible text.
    // The user can name a highlight anything (or leave it blank, which
    // makes Instagram default the title to "Highlight"), so text matching
    // is fundamentally unreliable.
    //
    // Strategy order (first non-empty result wins):
    //
    //   1. resource-id contains "reel_header" AND clickable=true
    //      Instagram uses com.instagram.android:id/reel_header_content (and
    //      similar) for the clickable wrapper around each highlight circle.
    //      This is a code identifier, completely independent of locale or
    //      user-defined title.
    //
    //   2. Tray-bounds structural: find the scrollable/non-clickable
    //      container whose resource-id contains "highlight" (a code id, e.g.
    //      "profile_header_highlights_tray"), extract its Y bounds, then
    //      collect every small square-ish clickable node whose centre falls
    //      inside that band.  The circles are always roughly 100-220px wide
    //      with a near-1:1 aspect ratio.
    //
    //   3. Diagnostic fallback: log every clickable node's resource-id,
    //      content-desc, size, and position so the exact pattern can be
    //      identified from the Debugging Log without a separate inspect run.

    const segments = xml.split("<node ");

    interface HLCandidate { x: number; y: number; name: string }
    let candidates: HLCandidate[] = [];

    function parseHLNode(seg: string): {
      cx: number; cy: number; cd: string; rid: string; w: number; h: number;
    } | null {
      const bb = seg.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!bb) return null;
      const x1 = parseInt(bb[1]); const y1 = parseInt(bb[2]);
      const x2 = parseInt(bb[3]); const y2 = parseInt(bb[4]);
      return {
        cx: Math.round((x1 + x2) / 2),
        cy: Math.round((y1 + y2) / 2),
        w:  x2 - x1,
        h:  y2 - y1,
        cd:  seg.match(/content-desc="([^"]*)"/)?.[1] ?? "",
        rid: seg.match(/resource-id="([^"]*)"/)?.[1] ?? "",
      };
    }

    // Strategy 1: resource-id contains "reel_header" (structural code id,
    // not text — works regardless of locale or user-defined title).
    for (const seg of segments) {
      const n = parseHLNode(seg); if (!n) continue;
      if (!n.rid.toLowerCase().includes("reel_header")) continue;
      candidates.push({ x: n.cx, y: n.cy, name: n.cd || n.rid });
    }

    // Strategy 2: find the highlights tray container by resource-id
    // (contains "highlight" as a code identifier — e.g.
    // "profile_header_highlights_tray"), extract its Y bounds, then
    // collect every small square-ish clickable node inside that band.
    if (candidates.length === 0) {
      let trayY1 = -1, trayY2 = -1;
      for (const seg of segments) {
        const rid = seg.match(/resource-id="([^"]*)"/)?.[1]?.toLowerCase() ?? "";
        // Must contain "highlight" as a code id but not itself be a
        // clickable circle (those are handled above / below).
        if (!rid.includes("highlight")) continue;
        const bb = seg.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!bb) continue;
        trayY1 = parseInt(bb[2]); trayY2 = parseInt(bb[4]);
        break;
      }
      if (trayY1 >= 0) {
        const bandY1 = trayY1 - 20;
        const bandY2 = trayY2 + 20;
        for (const seg of segments) {
          const n = parseHLNode(seg); if (!n) continue;
          if (n.cy < bandY1 || n.cy > bandY2) continue;
          // Circle icons are roughly square: AR 0.4-2.5, min 60 px wide.
          const ar = n.w > 0 ? n.h / n.w : 0;
          if (ar < 0.4 || ar > 2.5 || n.w < 60) continue;
          candidates.push({ x: n.cx, y: n.cy, name: n.cd || n.rid });
        }
      }
    }

    // Strategy 3: diagnostic — log every clickable node so the Debugging
    // Log reveals the exact resource-ids used on this device/build.
    if (candidates.length === 0) {
      onLog?.("Inject Browsing: no highlights found on this profile — skipping tap");
      const diagLines: string[] = [];
      for (const seg of segments) {
        const n = parseHLNode(seg); if (!n) continue;
        diagLines.push(
          `  rid="${n.rid.slice(0, 70)}" cd="${n.cd.slice(0, 40)}" pos=(${n.cx},${n.cy}) size=${n.w}x${n.h}`,
        );
        if (diagLines.length >= 35) { diagLines.push("  … (truncated)"); break; }
      }
      if (diagLines.length > 0) {
        onLog?.(`Inject Browsing: [diag] clickable nodes:\n${diagLines.join("\n")}`);
      }
      return;
    }

    // Pick one at random and tap it.
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    onLog?.(`Inject Browsing: tapping highlight "${pick.name}" at (${pick.x},${pick.y})…`);
    await android.tap(serial, pick.x, pick.y);
    await sleepOrAbort(serial, 1500); // wait for story viewer to open

    // Dwell 2–20 s inside the highlight story.
    const dwellMs = 2000 + Math.round(Math.random() * 18000);
    onLog?.(`Inject Browsing: dwelling in highlight for ${(dwellMs / 1000).toFixed(1)}s…`);
    await sleepOrAbort(serial, dwellMs);

    // Instagram's story viewer dismisses with the inverse of the normal
    // feed scroll gesture. Do not spend another UIAutomator dump deciding
    // whether it is open, and never use Android Back here: a Back event can
    // leave the viewer on an intermediate Instagram screen.
    onLog?.("Inject Browsing: swiping down to close highlight viewer…");
    // Close the Story using this device's calibrated Swipe Gesture Profile,
    // reversed from its normal direction.  This keeps the exact physical
    // start/end geometry and timing learned from the device instead of
    // falling back to the old shared center-line 300 ms gesture.
    await deviceProfileSwipe(
      serial,
      {
        x1: Math.round(getScreenSize(serial).w / 2),
        y1: Math.round(getScreenSize(serial).h * 0.35),
        x2: Math.round(getScreenSize(serial).w / 2),
        y2: Math.round(getScreenSize(serial).h * 0.92),
        durationMs: 300,
      },
      "story-close",
      "back",
    );
    await sleepOrAbort(serial, 700);
    onLog?.("Inject Browsing: ✓ highlight viewed and dismissed");
  } catch (e: any) {
    if (e?.message === "cycle-aborted") throw e;
    onLog?.(`Inject Browsing: tap highlights error — ${e?.message}`);
  }
}

/**
 * Runs the "Inject Browsing" sequence for ONE user's profile page. Caller
 * decides (via rollInjectBrowsingDecision) whether and when this runs —
 * this function no longer rolls the activate/before-follow gates itself.
 * Every roll below (whether the feed gets scrolled, whether a post gets
 * opened, liked, reposted, or shared via DM) is drawn fresh per user — a
 * min/max pair is a range the actual chance for THIS user is drawn from,
 * not a fixed percentage, so e.g. min=5/max=10 gives each user its own
 * roll somewhere in that band (~7.5% on average) rather than exactly 7.5%
 * every time.
 *
 * Must be called while already sitting on the target user's profile page.
 * When called before the follow tap: after findAndTapUserInSearch, before
 * tapFollowButtonOnProfilePage. When called after: right after the follow
 * tap succeeds/fails, still on the same profile page. Every step degrades
 * to a no-op (never throws, never leaves the profile page) if the
 * expected icon/button can't be located — per spec, a missing icon just
 * means that step is skipped for this user.
 */
// Returns the number of profile-grid rows that were actually scrolled down,
// so the caller can scroll EXACTLY that many rows back to the top before
// tapping Follow.  Returns 0 when the feed-scroll roll was missed or rolled
// 0 rows (profile is still at the top — doing a scroll-back there would
// pull-to-refresh instead of returning to the top).
async function runProfileBrowsingSequence(
  serial: string,
  browsing: InjectBrowsingParams,
  onLog?: (msg: string) => void,
  onLike?: () => void,
  context?: FollowOperationContext,
): Promise<number> {
  const { android, isCycleAborted, getScreenSize, deviceProfileSwipe, sleepOrAbort, logger,
    dismissSaveCollectionPrompt } = context!;
  const _injectBrowsingLastDmRecipient = context!._injectBrowsingLastDmRecipient as Map<string, { x: number; y: number }>;
  const { w, h } = getScreenSize(serial);

  // ── Tap Highlights — roll once at the start; coin-flip decides timing ──
  // 50 % chance it fires BEFORE the profile-grid scroll (highlighting feels
  // more natural when the page is still at the top), 50 % chance AFTER.
  const tapHighlightsChance = rollRange(browsing.tapHighlightsPctMin, browsing.tapHighlightsPctMax) / 100;
  const willTapHighlights   = tapHighlightsChance > 0 && Math.random() < tapHighlightsChance;
  const tapHighlightsBefore = willTapHighlights && Math.random() < 0.5;
  if (willTapHighlights) {
    onLog?.(`Inject Browsing: tap highlights — chance:${Math.round(tapHighlightsChance * 100)}% timing:${tapHighlightsBefore ? 'before' : 'after'} feed scroll`);
  }

  // ── Highlights — BEFORE feed scroll ──────────────────────────────────
  if (tapHighlightsBefore) {
    await tapOneProfileHighlight(serial, onLog, context);
  }

  // Activation already decided by rollInjectBrowsingDecision — no second
  // gate here. If we were called, the grid scroll is guaranteed to run;
  // only the number of rows is random.

  // Read the profile's post count so we never scroll past content that
  // doesn't exist.  12 posts fit on screen without scrolling (4 rows × 3
  // per row); every additional 12 posts allows one more scroll row.
  // If the count can't be parsed, fall back to the configured max.
  const profilePostCount = await android.getProfilePostCount(serial).catch(() => null);
  let maxScrollsByPostCount = Infinity;
  if (profilePostCount !== null) {
    maxScrollsByPostCount = Math.max(0, Math.floor((profilePostCount - 12) / 12));
    onLog?.(`Inject Browsing: profile has ${profilePostCount} post(s) — max useful scroll: ${maxScrollsByPostCount} row(s)`);
  }

  const rolledRows = Math.max(0, Math.round(rollRange(browsing.feedMin, browsing.feedMax)));
  const rows = Math.min(rolledRows, maxScrollsByPostCount);
  if (rows === 0) {
    onLog?.("Inject Browsing: feed posts rolled to 0 (or post count too low to need scrolling) — skipping grid scroll");
    return 0;
  }
  onLog?.(`Inject Browsing: scrolling profile grid — ${rows} row(s)`);
  const x = Math.round(w / 2);
  const y1 = Math.round(h * 0.78);
  const y2 = Math.round(h * 0.30);
  for (let i = 0; i < rows; i++) {
    if (isCycleAborted(serial)) throw new Error("cycle-aborted");
    logger.info({ serial, source: "inject-profile-grid-scroll-down", from: [x, y1], to: [x, y2] }, "[mobile-input] swipe");
    await deviceProfileSwipe(serial, { x1: x, y1: y1, x2: x, y2: y2, durationMs: 500 + Math.round(Math.random() * 200) }, "inject-profile-grid-scroll-down");
    // Wait 4–7 seconds so images fully render before the next scroll.
    const renderWait = 4000 + Math.round(Math.random() * 3000);
    onLog?.(`Inject Browsing: waiting ${(renderWait / 1000).toFixed(1)}s for media to render…`);
    await sleepOrAbort(serial, renderWait);
  }

  // ── Highlights — AFTER feed scroll ───────────────────────────────────
  // Must run here — before click-post — so it fires even when the
  // click-post roll misses.  The original placement (after the post-open
  // block) was unreachable whenever click-post didn't fire, which meant
  // "after" timing silently never executed.
  if (willTapHighlights && !tapHighlightsBefore) {
    if (rows > 0) {
      onLog?.(`Inject Browsing: scrolling back to top for highlights — ${rows} row(s)`);
      for (let _hsi = 0; _hsi < rows; _hsi++) {
        logger.info({ serial, source: "inject-profile-grid-scroll-back-for-highlights", from: [Math.round(w / 2), Math.round(h * 0.35)], to: [Math.round(w / 2), Math.round(h * 0.80)], durationMs: 400 }, "[mobile-input] swipe");
        // This is the exact inverse of the configured account/device gesture.
        // Passing the back personality is required: deviceProfileSwipe uses
        // the saved x1/y1 → x2/y2 path whenever a profile exists, so merely
        // reversing this fallback would otherwise still send the normal
        // configured direction.
        await deviceProfileSwipe(
          serial,
          { x1: Math.round(w / 2), y1: Math.round(h * 0.35), x2: Math.round(w / 2), y2: Math.round(h * 0.80), durationMs: 400 },
          "inject-profile-grid-scroll-back",
          "back",
        );
        await sleepOrAbort(serial, 350);
        // The profile header stats (post count / followers / following)
        // disappear while the grid is scrolled and reappear at the top.
        // Check after every recovery swipe so an unpredictable gesture
        // cannot cause redundant swipes and repeated profile re-rendering.
        const topStats = await android.getProfilePostCount(serial).catch(() => null);
        if (topStats !== null) {
          onLog?.(`Inject Browsing: profile header detected after ${_hsi + 1}/${rows} upward swipe(s) — stopping top recovery early`);
          break;
        }
      }
      await sleepOrAbort(serial, 500);
    }
    await tapOneProfileHighlight(serial, onLog, context);
    return 0; // already at top — caller must not scroll back further
  }

  const clickChance = rollRange(browsing.clickPostPctMin, browsing.clickPostPctMax) / 100;
  if (!(clickChance > 0 && Math.random() < clickChance)) {
    onLog?.("Inject Browsing: click-post roll missed — not opening a post");
    return rows;
  }

  // Find real post thumbnail positions from the live accessibility tree.
  // Instagram's profile grid renders each thumbnail as a Button with
  // resource-id com.instagram.android:id/image_button — those are the
  // only safe tap targets.  Hardcoded percentage slots (w*0.17 etc.) are
  // forbidden: they can land on tab strips, gaps, or off-screen areas and
  // produce "no post opened" failures even on profiles with hundreds of posts.
  const gridPosts = await android.findProfileGridPosts(serial, onLog).catch(() => [] as { x: number; y: number; cd: string }[]);
  if (gridPosts.length === 0) {
    onLog?.("Inject Browsing: no image_button nodes found in grid — skipping post open");
    return rows;
  }
  const slot = gridPosts[Math.floor(Math.random() * gridPosts.length)];
  const slotCd = slot.cd ? ` (${slot.cd})` : "";
  onLog?.(`Inject Browsing: opening a scrolled post at (${slot.x},${slot.y})${slotCd}`);
  await android.tap(serial, slot.x, slot.y);
  await sleepOrAbort(serial, 1200);

  // Confirm a post actually opened (has a Like button).
  let icons = await android.findFeedActionIcons(serial, onLog).catch(() => null);
  if (!icons) {
    // Distinguish two cases that both produce icons=null:
    //
    //   A) Tap didn't open a post (e.g. thumbnail was partially off-screen,
    //      or this is a pinned Reel/video that opens a different viewer) —
    //      still on the profile grid. Safe to retry with a fresh a11y dump.
    //
    //   B) A Reel/post opened but findFeedActionIcons returned null because
    //      the viewer uses a different label. We are INSIDE the viewer.
    //      Pressing Back + retrying is wrong — it closes a valid post.
    //
    // Detection: isInPostViewer checks for resource-ids that only appear
    // inside a post/Reel viewer, never on the profile grid.
    const insideViewer = await android.isInPostViewer(serial).catch(() => false);
    if (insideViewer) {
      onLog?.("Inject Browsing: post/Reel opened but icons not found — pressing Back to profile");
      logger.info({ serial }, "[inject-browsing] findFeedActionIcons=null, isInPostViewer=true — no identifiable Like button; pressing Back without retry");
      await android.pressBack(serial);
      await sleepOrAbort(serial, 500);
      return rows;
    }
    // Case A: still on profile grid — scroll up once and retry using a
    // fresh a11y dump (same rule: no hardcoded coordinates).
    //
    // Do NOT press Back here. Follow reaches this profile via a search, so
    // the profile's own Back target is the Search page. Pressing Back while
    // on the base profile grid (no viewer open) exits the profile entirely.
    onLog?.("Inject Browsing: no post opened here — scrolling up and retrying via a11y");
    logger.info({ serial }, "[inject-browsing] findFeedActionIcons=null, isInPostViewer=false — still on profile grid; scrolling up and re-scanning a11y tree for image_button nodes");
    await deviceProfileSwipe(
      serial,
      { x1: x, y1: y2, x2: x, y2: y1, durationMs: 500 },
      "inject-profile-grid-retry-scroll",
      "back",
    );
    await sleepOrAbort(serial, 800);
    const retryPosts = await android.findProfileGridPosts(serial, onLog).catch(() => [] as { x: number; y: number; cd: string }[]);
    if (retryPosts.length === 0) {
      onLog?.("Inject Browsing: retry — no image_button nodes found after scroll-up, giving up");
      return rows;
    }
    const retrySlot = retryPosts[Math.floor(Math.random() * retryPosts.length)];
    const retryCd = retrySlot.cd ? ` (${retrySlot.cd})` : "";
    onLog?.(`Inject Browsing: retry — tapping post at (${retrySlot.x},${retrySlot.y})${retryCd}`);
    await android.tap(serial, retrySlot.x, retrySlot.y);
    await sleepOrAbort(serial, 1200);
    icons = await android.findFeedActionIcons(serial, onLog).catch(() => null);
    if (!icons) {
      const stillInViewer = await android.isInPostViewer(serial).catch(() => false);
      onLog?.("Inject Browsing: retry also found no post — giving up on this profile's posts");
      logger.info({ serial, stillInViewer }, "[inject-browsing] retry tap also found no Like button — profile may be Reels-only or viewer label not recognised");
      if (stillInViewer) {
        await android.pressBack(serial);
        await sleepOrAbort(serial, 500);
      }
      return rows;
    }
    onLog?.("Inject Browsing: retry succeeded — post opened after scrolling up");
  }

  // Diagnostic: show exactly which icons were resolved so we can see
  // what the accessibility tree contained for this specific post.
  logger.info(
    { serial, like: !!icons.like, comment: !!icons.comment, shareFeed: !!icons.shareFeed, shareDm: !!icons.shareDm,
      shareFeedCoords: icons.shareFeed ?? null, shareDmCoords: icons.shareDm ?? null },
    "[inject-browsing] action-bar icons found for this profile post"
  );
  // Only report Like/Comment from the icon scan — ShareFeed and ShareDM are
  // resolved by findButtonByLabel("Repost"/"Send") which runs later and is
  // more reliable than the positional icon scan. Showing them here as ✗
  // was misleading users into thinking the repost/share hadn't worked even
  // when it had (the label-scan found the button even when the icon scan
  // failed to detect it by position).
  onLog?.(`Inject Browsing: icons — Like:${icons.alreadyLiked ? '(already liked)' : '✓'} Comment:${icons.comment?'✓':'✗'}`);

  return await android.withInputTransaction(serial, async () => {
  const likeChance = rollRange(browsing.likePctMin, browsing.likePctMax) / 100;
  logger.info({ serial, likeChance: Math.round(likeChance * 100), alreadyLiked: !!icons.alreadyLiked }, "[inject-browsing] like chance rolled");
  if (likeChance > 0 && Math.random() < likeChance) {
    if (icons.alreadyLiked) {
      onLog?.("Inject Browsing: post already liked — skipping like tap, continuing with share actions");
      logger.info({ serial }, "[inject-browsing] post already liked (Unlike button found) — skipped like tap, share/DM actions will still run");
    } else {
      try {
         onLog?.(`Inject Browsing: tapping live Like node at (${icons.like.x},${icons.like.y})…`);
         await android.tap(serial, icons.like.x, icons.like.y);
        onLike?.();
        onLog?.("Inject Browsing: ✓ liked the post");
        await sleepOrAbort(serial, 300);
      } catch { /* best effort */ }
    }
  }

  const shareFeedChance = rollRange(browsing.shareFeedPctMin, browsing.shareFeedPctMax) / 100;
  logger.info(
    { serial, shareFeedChance: Math.round(shareFeedChance * 100),
      settingsMin: browsing.shareFeedPctMin, settingsMax: browsing.shareFeedPctMax },
    "[inject-browsing] share-feed chance rolled"
  );
  if (!(shareFeedChance > 0 && Math.random() < shareFeedChance)) {
    onLog?.("Inject Browsing: share-to-feed roll missed — skipping");
  } else {
    try {
      const repostIcon = icons.shareFeed;
      if (!repostIcon) {
        onLog?.("Inject Browsing: Repost icon not found on this post — skipping share-to-feed");
        logger.warn({ serial }, "[inject-browsing] neither findFeedActionIcons row-scan nor findButtonByLabel('Repost') found the icon — likely absent on this post (sharing disabled by poster)");
      } else {
        // Capture the icon's own label BEFORE tapping. Some accounts'
        // Instagram build reposts instantly on a single tap with NO
        // confirmation sheet at all — the icon just relabels itself in
        // place (e.g. "Repost" -> "Remove repost"/"Reposted"). Comparing
        // before/after lets us tell that apart from "sheet genuinely
        // never opened", which both look identical (a "Repost"-matching
        // node at the same coordinates) to a same-coords-only check —
        // confirmed via a live run where a real, successful single-tap
        // repost was misread as failure and triggered a wrong pressBack.
        await android.tap(serial, repostIcon.x, repostIcon.y);
        logger.info({ serial, x: repostIcon.x, y: repostIcon.y }, "[inject-browsing] tapped Repost icon");
        // Wait briefly for a confirmation sheet to appear (some devices/builds
        // show a "Repost" confirm button inside a bottom sheet; others do the
        // repost instantly on a single tap with no sheet at all).
        await sleepOrAbort(serial, 1000);
        const repostBtn = await android.findButtonByLabel(serial, "Repost").catch(() => null);
        const sameCoords = !!repostBtn &&
          Math.abs(repostBtn.x - repostIcon.x) < 15 && Math.abs(repostBtn.y - repostIcon.y) < 15;
        if (repostBtn && !sameCoords) {
          // A separate "Repost" confirm button appeared at a different
          // position — a real sheet is open. Tap it to confirm.
          await android.tap(serial, repostBtn.x, repostBtn.y);
          onLog?.("Inject Browsing: reposted the post");
          await sleepOrAbort(serial, 800);
          const closeBtn = await android.findButtonByLabel(serial, "Close").catch(() => null);
          if (closeBtn) { await android.tap(serial, closeBtn.x, closeBtn.y); await sleepOrAbort(serial, 400); }
        } else {
          // No sheet appeared — either the repost completed on a single tap
          // (no confirmation sheet on this device/build), or the post does
          // not support resharing. In both cases: do NOT press Back.
          // Pressing Back navigates away from the post and breaks the
          // remaining actions (ShareDM etc.) that still need to run.
          // The tap already fired; assume it worked.
          onLog?.("Inject Browsing: reposted the post (single tap — no sheet)");
          logger.info({ serial, repostBtn, sameCoords }, "[inject-browsing] no sheet appeared after Repost tap — assuming single-tap repost completed");
        }
      }
    } catch (e: any) {
      if (e?.message === "cycle-aborted") throw e;
      onLog?.(`Inject Browsing: share-to-feed error — ${e?.message}`);
    }
  }

  const shareDmChance = rollRange(browsing.shareDmPctMin, browsing.shareDmPctMax) / 100;
  logger.info(
    { serial, shareDmChance: Math.round(shareDmChance * 100),
      settingsMin: browsing.shareDmPctMin, settingsMax: browsing.shareDmPctMax },
    "[inject-browsing] share-DM chance rolled"
  );
  if (!(shareDmChance > 0 && Math.random() < shareDmChance)) {
    onLog?.("Inject Browsing: share-via-DM roll missed — skipping");
  } else if (!icons.shareDm) {
    logger.info({ serial }, "[inject-browsing] skipped share-via-DM — icon not identifiable on this post (disabled or ambiguous layout)");
    onLog?.("Inject Browsing: skipped share-via-DM — paper-plane icon not found on this post");
  } else {
    // ── Inject Browsing — Share via DM (isolated; not shared with any other tool) ──
    try {
      if (isCycleAborted(serial)) throw new Error("cycle-aborted");
      await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300));
      onLog?.(`Inject Browsing: tapping share-via-DM icon at (${icons.shareDm.x},${icons.shareDm.y})…`);
      await android.tap(serial, icons.shareDm.x, icons.shareDm.y);
      await sleepOrAbort(serial, 1500);
      onLog?.("Inject Browsing: confirming share sheet opened and picking DM recipient…");
      let _ibScan = await android.confirmAndScanShareSheet(serial, onLog).catch(() => null);
      if (!_ibScan?.sheetOpen) {
        onLog?.("Inject Browsing: share sheet not yet visible — waiting 1500ms and retrying…");
        await sleepOrAbort(serial, 1500);
        _ibScan = await android.confirmAndScanShareSheet(serial, onLog).catch(() => null);
      }
      if (!_ibScan?.sheetOpen) {
        logger.warn({ serial }, "[inject-browsing] share sheet not confirmed open after retry — closing and skipping DM");
        onLog?.("Inject Browsing: share aborted — share sheet did not open");
        await android.pressBack(serial);
        await sleepOrAbort(serial, 200);
      } else {
        const _ibSendBtn0 = _ibScan.sendBtn ?? null;
        if (_ibScan.preSelectedRecipients && _ibScan.preSelectedRecipients.length > 0) {
          onLog?.(`Inject Browsing: deselecting ${_ibScan.preSelectedRecipients.length} pre-selected recipient(s) from prior run…`);
          for (const _r of _ibScan.preSelectedRecipients) {
            onLog?.(`Inject Browsing: deselecting${(_r as any).name ? ` (${(_r as any).name})` : ""} at (${_r.x},${_r.y})`);
            await android.tap(serial, _r.x, _r.y);
            await sleepOrAbort(serial, 400);
          }
        }
        const _ibRecipients = _ibScan.recipients ?? [];
        if (_ibRecipients.length === 0) {
          await android.pressBack(serial);
          logger.warn({ serial }, "[inject-browsing] no recipient found — closed share sheet without sending");
          onLog?.("Inject Browsing: share skipped — no recipient avatars found (closed without sending)");
        } else {
          const _ibLast = _injectBrowsingLastDmRecipient.get(serial);
          const _ibPool = _ibLast ? _ibRecipients.filter((r: { x: number; y: number }) => !(r.x === _ibLast.x && r.y === _ibLast.y)) : _ibRecipients;
          const _ibCands = _ibPool.length > 0 ? _ibPool : _ibRecipients;
          const _ibPick = _ibCands[Math.floor(Math.random() * _ibCands.length)];
          _injectBrowsingLastDmRecipient.set(serial, { x: _ibPick.x, y: _ibPick.y });
          onLog?.(`Inject Browsing: tapping recipient at (${_ibPick.x},${_ibPick.y})${(_ibPick as any).name ? ` (${(_ibPick as any).name})` : ""}`);
          await android.tap(serial, _ibPick.x, _ibPick.y);
          await sleepOrAbort(serial, 800);
          const _ibIsOpen = async () => {
            const _x = await android.dumpUi(serial).catch(() => "");
            // "Add to story" removed — home-feed story tray has this label
            // and causes a false-positive after the sheet closes.
            return _x.includes("direct_private_share") || _x.includes("grid_view_pog_avatar_view") ||
                   _x.includes("android.widget.EditText") || _x.includes("Copy link");
          };
          const _ibSb = _ibScan.sendBtn ?? await android.findButtonByLabel(serial, "Send").catch(() => null);
          if (_ibSb) {
            await android.tap(serial, _ibSb.x, _ibSb.y);
            await sleepOrAbort(serial, 300);
            if (!(await _ibIsOpen())) {
              logger.info({ serial }, "[inject-browsing] shared post via DM — Send tapped");
              onLog?.("Inject Browsing: ✓ shared via DM — Send tapped");
              await sleepOrAbort(serial, 300);
            } else {
              logger.info({ serial }, "[inject-browsing] Send button not found after picking recipient — pressing Back");
              onLog?.("Inject Browsing: Send button not found after picking DM recipient — pressing Back");
              await android.pressBack(serial);
              await sleepOrAbort(serial, 200);
            }
          } else if (!(await _ibIsOpen())) {
            logger.info({ serial }, "[inject-browsing] share sheet already closed — DM likely sent by recipient tap");
            onLog?.("Inject Browsing: ✓ shared via DM — sheet auto-dismissed (sent by recipient tap)");
            await sleepOrAbort(serial, 200);
          } else {
            onLog?.("Inject Browsing: Send node not found via accessibility — closing without sending");
            await android.pressBack(serial);
            await sleepOrAbort(serial, 200);
          }
        }
      }
    } catch (e: any) {
      if (e?.message === "cycle-aborted") throw e;
      onLog?.(`Inject Browsing: share-via-DM error — ${e?.message}`);
    }
  }

  // ── Save Post ────────────────────────────────────────────────────────────
  const savePostChance = rollRange(browsing.savePostPctMin, browsing.savePostPctMax) / 100;
  if (!(savePostChance > 0 && Math.random() < savePostChance)) {
    onLog?.("Inject Browsing: save-post roll missed — skipping");
  } else if (!icons.save) {
    logger.info({ serial }, "[inject-browsing] skipped save-post — row_feed_button_save not found on this post");
    onLog?.("Inject Browsing: skipped save-post — bookmark icon not found on this post");
  } else {
    try {
      if (isCycleAborted(serial)) throw new Error("cycle-aborted");
      await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300));
      onLog?.(`Inject Browsing: tapping save icon at (${icons.save.x},${icons.save.y})…`);
      await android.tap(serial, icons.save.x, icons.save.y);
      await sleepOrAbort(serial, 600);
      const _ibSaveXml = await android.dumpUi(serial).catch(() => "");
      await dismissSaveCollectionPrompt(serial, _ibSaveXml, onLog, "Inject Browsing");
      onLog?.("Inject Browsing: ✓ post saved");
    } catch (e: any) {
      if (e?.message === "cycle-aborted") throw e;
      onLog?.(`Inject Browsing: save-post error — ${e?.message}`);
    }
  }

  // Back out of the opened post to the profile grid before continuing.
  await android.pressBack(serial);
  await sleepOrAbort(serial, 500);

  return rows;
  });
}

export async function runFollowUsersStep(
  serial: string,
  params: {
    usersMin: number;
    usersMax: number;
    sources: { type: string; value: string }[];
    onLog?: (msg: string) => void;
    recordFollow?: (username: string, source: string) => void;
    onLike?: () => void;
    browsing?: InjectBrowsingParams;
    /** Pre-built set of lowercase usernames already followed — candidates
     *  matching any entry are dropped before the follow loop begins, so no
     *  browsing time is wasted on a target that has already been followed. */
    skipFollowedUsernames?: Set<string>;
    /** Usernames in the global skipped list — candidates matching any entry
     *  are dropped before the follow loop so they are never re-scraped. */
    skipSkippedUsernames?: Set<string>;
    /** Profile-quality gates to apply after navigating to the target's
     *  profile but before the Follow tap. */
    filters?: { skipVerified?: boolean; maxFollowers?: number; skipPrivate?: boolean; minFollowers?: number; requireEnglish?: boolean; malesOnly?: boolean; maleNames?: string };
    /** Jarvee-style "abort after X scrapes" limit. 0 = unlimited.
     *  Counts the initial HikerAPI fetch as scrape #1; re-scrapes count
     *  from #2 onward.  When the total reaches this number the session
     *  ends even if targetCount hasn't been reached. */
    maxScrapeSessions?: number;
    /** DB profile ID for this Instagram account. When provided, Surplus
     *  candidates saved from previous cycles are consumed first before
     *  HikerAPI is called. Leftover candidates at the end of the session
     *  are written back to Surplus for the next cycle. */
    profileId?: number;
    /** Phone-farm slot key (Instagram username, no @) used when the slot
     *  has no matching EB profile. Surplus is keyed by this when profileId
     *  is absent. */
    phoneSlotKey?: string;
    /** When true, any candidate rejected by a filter (HikerAPI metadata pre-
     *  filter or profile-visit quality gate) is written to the global
     *  skipped_users table so every account skips that user on future cycles.
     *  Tied to the "Skip Already Skipped Users" toggle in Settings → Automation.
     *  When false/absent no writes are made to skipped_users. */
    writeSkippedUsers?: boolean;
    /** Spread-Follows mode: pre-fetched candidates from the automation cycle.
     *  When provided the entire HikerAPI/surplus fetch phase is skipped and
     *  these candidates are used directly. Surplus save is also skipped (the
     *  caller manages it). */
    preloadedCandidates?: {
      targets: string[];
      candidateSource: Map<string, string>;
      candidateMeta: Map<string, { isVerified?: boolean; isPrivate?: boolean; followerCount?: number }>;
    };
     /** The caller has already left Instagram on a confirmed, focused,
      * cleared Search field (used for spread backup candidates). */
     searchAlreadyReady?: boolean;
     /** Keep the Search surface only when another spread slot follows
      *  immediately. The final slot must restore the normal Instagram UI. */
     keepSearchOpenAfterStep?: boolean;
  },
    context: FollowOperationContext,
  ): Promise<number> {
  const { android, storage, logger, HikerApiClient, isCycleAborted, sleepOrAbort,
    getScreenSize, deviceProfileSwipe, dismissSaveCollectionPrompt,
    findButtonByLabel, findFeedActionIcons, findReelActionIcons,
    getCompiledMalesOnlyNames, findLiveMalesOnlyMatch, rollRange,
  } = context;
  const _injectBrowsingLastDmRecipient = context._injectBrowsingLastDmRecipient as Map<string, { x: number; y: number }>;
  const { usersMin, usersMax, sources, onLog, onLike, recordFollow, browsing, skipFollowedUsernames, skipSkippedUsernames, filters } = params;
  let searchReadyForReuse = !!params.searchAlreadyReady;
  // The Search field stays in the same top-bar position while returning from
  // a rejected profile to Search results. Keep the last live visual match so
  // recovery does not repeat the expensive multi-template scan immediately.
  let lastKnownSearchBar: { x: number; y: number } | null = null;

  // The mirror's calibrated Back point is the same visible Instagram back
  // arrow used by the other settings/navigation flows. Use it for leaving a
  // profile; Android Back is reserved for dismissing a post viewer, sheet, or
  // other transient surface opened while still inside the profile.
  const tapCalibratedProfileBack = async (reason: string) => {
    const point = await android.tapCalibratedNavigationControl(serial, "settingsBack", onLog);
    await sleepOrAbort(serial, 500);
    onLog?.(`Follow: ${reason} — tapped calibrated Back at (${point.x},${point.y})`);
  };

  // A profile can be visibly open even when the helper's immediate verifier
  // sees stale search nodes or misses the exact button label. The profile
  // header is a stronger signal than those stale search markers, so accept a
  // fresh dump when it contains both a profile-surface marker and a Follow
  // control. Search rows alone do not contain the profile header marker.
  const isConfirmedProfileSurface = (xml: string): boolean => {
    if (!xml) return false;
    const hasProfileHeader =
      /action_bar_username_container|row_profile_header|profile_header|profile_grid/i.test(xml);
    const hasFollowControl =
      /(?:text|content-desc)="(?:Follow|Following|Requested)"/i.test(xml) ||
      /(?:resource-id|class)="[^"]*(?:follow_button|follow_btn|inline_follow_button)[^"]*"/i.test(xml);
    return hasProfileHeader && hasFollowControl;
  };

  // A multi-target run must not repeatedly submit searches from the stale
  // results surface. After returning from a profile, two calibrated Back taps
  // return to Explore with a clean search field; the next target then focuses
  // that field directly. Single-target runs retain the existing one-Back
  // cleanup behavior.
  const finishFollowNavigation = async () => {
    try {
      await android.clearInstagramSearchBar(serial, (msg: string) => onLog?.(`Follow: cleanup — ${msg}`));
    } catch (e: any) {
      onLog?.(`Follow: cleanup clear failed — ${e?.message ?? "unknown error"}`);
    }
    try {
      await tapCalibratedProfileBack("cleanup — cleared search");
      onLog?.("Follow: cleanup — returned to normal UI");
    } catch (e: any) {
      if (e?.message === "cycle-aborted") throw e;
      onLog?.(`Follow: cleanup Back failed — ${e?.message ?? "unknown error"}`);
    }
  };

  const shouldResetToExploreForNextTarget = () =>
    targetCount > 1 || Boolean(params.keepSearchOpenAfterStep);

  const prepareNextTargetSearch = async (reason: string): Promise<boolean> => {
    if (!shouldResetToExploreForNextTarget()) return false;
    await tapCalibratedProfileBack(`${reason} — returned to search results`);
    await tapCalibratedProfileBack(`${reason} — returned to Explore`);
    const searchBar = await android.tapCalibratedNavigationControl(serial, "userSearch", onLog);
    lastKnownSearchBar = searchBar;
    await sleepOrAbort(serial, 500);
    const focused = await android.isInstagramSearchBarFocused(serial).catch(() => false);
    if (!focused) {
      onLog?.(`Follow: ${reason} — clean Explore search field was not confirmed focused`);
      searchReadyForReuse = false;
      return false;
    }
    searchReadyForReuse = true;
    onLog?.(`Follow: ${reason} — two calibrated Backs complete; clean Explore search field focused`);
    return true;
  };

  // A rejected profile must stay inside the Explore/search flow. Returning
  // to the normal UI here makes the next candidate trigger the expensive
  // Home → Search navigation again and can cause the cleanup Back sequence
  // to land on Home. Return one level to results, clear the query, and leave
  // the live search field focused for the next candidate.
  const returnToClearedFollowSearch = async () => {
    // This state is only valid after every confirmation below succeeds.
    // Invalidate it before touching navigation so a failed Back/search
    // recovery can never leak a stale "reuse" claim into the next user.
    searchReadyForReuse = false;
    if (shouldResetToExploreForNextTarget()) {
      await prepareNextTargetSearch("skipped-user cleanup");
      return searchReadyForReuse;
    }
    await tapCalibratedProfileBack("skipped-user cleanup — returned to search results");
    // The field was just used to launch this profile, so it is still the
    // focused field after returning to results. Avoid another UIAutomator
    // dump and clear it with the fast key-event path.
    await android.clearInstagramSearchBar(
      serial,
      (msg: string) => onLog?.(`Follow: skipped-user cleanup — ${msg}`),
      { skipNodeLookup: true },
    );
    const recoverySearchBar = lastKnownSearchBar
      ?? await android.tapCalibratedNavigationControl(serial, "userSearch", onLog);
    if (lastKnownSearchBar) {
      onLog?.(`Follow: skipped-user cleanup — reusing calibrated user-search field at (${lastKnownSearchBar.x}, ${lastKnownSearchBar.y})`);
    }
    if (lastKnownSearchBar) {
      await android.tap(serial, recoverySearchBar.x, recoverySearchBar.y);
    }
    await sleepOrAbort(serial, 500);
    const focused = await android.isInstagramSearchBarFocused(serial).catch(() => false);
    if (!focused) {
      onLog?.("Follow: skipped-user cleanup — search bar focus not confirmed");
      return false;
    }
    onLog?.("Follow: skipped-user cleanup — search bar cleared and focused for next user");
    searchReadyForReuse = true;
    return true;
  };

  // ── Shared state — populated by either the normal fetch path or the
  //    spread-mode preloaded path, then consumed by the shared follow loop. ──
  const _usePreloaded = !!params.preloadedCandidates;
  let candidateSource = new Map<string, string>();
  let candidateMeta   = new Map<string, { isVerified?: boolean; isPrivate?: boolean; followerCount?: number }>();
  let targets: string[] = [];
  let targetCount = 0;
  let hiker: any;
  let attemptedSet = new Set<string>();
  let MAX_SCRAPE_ROUNDS = 0;
  const profileId = params.profileId;
  const phoneSlotKey = params.phoneSlotKey?.replace(/^@/, "").toLowerCase() || "";

  if (!_usePreloaded) {
    if (!sources.length) {
      onLog?.("Follow: no target sources configured — skipping");
      return 0;
    }

    const globalSettings = await storage.getGlobalSettings();
    const hikerApiToken: string = globalSettings?.hikerApiToken ?? "";
    if (!hikerApiToken) {
      onLog?.("Follow: HikerAPI token not configured (Settings → Global → HikerAPI) — skipping");
      return 0;
    }

    const lo = Math.min(usersMin, usersMax);
    const hi = Math.max(usersMin, usersMax);
    targetCount = lo === hi ? lo : Math.round(lo + Math.random() * (hi - lo));
    if (targetCount === 0) { onLog?.("Follow: target count is 0 — skipping"); return 0; }

    onLog?.(`Follow: targeting ${targetCount} users from ${sources.length} source(s)`);

    hiker = new HikerApiClient(hikerApiToken);
    // Track source per username so the Followed Users tab shows the hashtag
    // or target account the user was discovered from, not "hikerapi".
    const candidates: string[] = [];

  // ── Surplus / Overspill candidates ──────────────────────────────────────
  // Before calling HikerAPI, check the Surplus table for candidates saved
  // from previous cycles for this account. Consuming these first avoids
  // burning HikerAPI quota on sources that were already scraped.
  const overspillIdsToDelete: number[] = [];
  if (profileId && profileId > 0) {
    try {
      const overspillRows = await storage.getOverspillUsersByProfile(profileId);
      if (overspillRows.length > 0) {
        onLog?.(`Follow: ${overspillRows.length} candidate${overspillRows.length !== 1 ? "s" : ""} in Surplus — using before HikerAPI`);
        for (const row of overspillRows) {
          const u = row.instagramUsername;
          if (skipFollowedUsernames?.has(u.toLowerCase())) continue;
          if (skipSkippedUsernames?.has(u.toLowerCase())) continue;
          if (!candidateSource.has(u)) candidateSource.set(u, row.sourceValue || "surplus");
          candidates.push(u);
          overspillIdsToDelete.push(row.id);
        }
      }
    } catch (e: any) {
      onLog?.(`Follow: could not load Surplus — ${e?.message}`);
    }
  } else if (phoneSlotKey) {
    try {
      const overspillRows = await storage.getOverspillUsersByPhoneSlot(phoneSlotKey);
      if (overspillRows.length > 0) {
        onLog?.(`Follow: ${overspillRows.length} candidate${overspillRows.length !== 1 ? "s" : ""} in Surplus — using before HikerAPI`);
        for (const row of overspillRows) {
          const u = row.instagramUsername;
          if (skipFollowedUsernames?.has(u.toLowerCase())) continue;
          if (skipSkippedUsernames?.has(u.toLowerCase())) continue;
          if (!candidateSource.has(u)) candidateSource.set(u, row.sourceValue || "surplus");
          candidates.push(u);
          overspillIdsToDelete.push(row.id);
        }
      }
    } catch (e: any) {
      onLog?.(`Follow: could not load Surplus — ${e?.message}`);
    }
  }
  // Delete the Surplus records we loaded so they aren't re-used if the cycle
  // is interrupted before the new surplus is saved at the end.
  if (overspillIdsToDelete.length > 0) {
    storage.deleteOverspillUsers(overspillIdsToDelete).catch(() => {});
  }

  // Only call HikerAPI if Surplus didn't already fill the candidate pool.
  if (candidates.length < targetCount * 3) {
    // Shuffle sources before iterating so the loop (which breaks as soon as
    // enough candidates are collected) starts from a different random source
    // each cycle rather than always position 0 (#bodybuilding in this case).
    // Without the shuffle, targetCount×3 candidates are found immediately from
    // the first source, the break fires, and the rest of the list is never
    // reached.
    const shuffledSources = [...sources].sort(() => Math.random() - 0.5);

    for (const src of shuffledSources) {
      if (candidates.length >= targetCount * 3) break;
      const sourceLabel = src.type === "hashtag"
        ? `#${src.value.replace(/^#/, "")}`
        : `@${src.value.replace(/^@/, "")}`;
      try {
        if (src.type === "hashtag") {
          const res = await hiker.getHashtagUsers(src.value.replace(/^#/, ""), 50);
          for (const u of res.users) {
            if (!candidateSource.has(u.username)) candidateSource.set(u.username, sourceLabel);
            if (u.isVerified !== undefined || u.isPrivate !== undefined || u.followerCount !== undefined)
              candidateMeta.set(u.username, { isVerified: u.isVerified, isPrivate: u.isPrivate, followerCount: u.followerCount });
            candidates.push(u.username);
          }
          onLog?.(`Follow: ${sourceLabel} → ${res.users.length} users`);
        } else if (src.type === "target_followers") {
          const userInfo = await hiker.getUserByUsername(src.value.replace(/^@/, "")).catch(() => null);
          if (!userInfo?.pk) { onLog?.(`Follow: could not resolve @${src.value} — skipping source`); continue; }
          const followers = await hiker.getFollowers(userInfo.pk, 50);
          for (const u of followers) {
            if (!candidateSource.has(u.username)) candidateSource.set(u.username, sourceLabel);
            if (u.isVerified !== undefined || u.isPrivate !== undefined || u.followerCount !== undefined)
              candidateMeta.set(u.username, { isVerified: u.isVerified, isPrivate: u.isPrivate, followerCount: u.followerCount });
            candidates.push(u.username);
          }
          onLog?.(`Follow: ${sourceLabel} followers → ${followers.length} users`);
        }
      } catch (e: any) {
        onLog?.(`Follow: HikerAPI error for source "${src.value}": ${e?.message}`);
      }
    }
  } else {
    onLog?.("Follow: Surplus pool is sufficient — skipping HikerAPI scrape this cycle");
  }

  if (!candidates.length) { onLog?.("Follow: no candidates collected — skipping"); return 0; }

  // Deduplicate and shuffle first, then filter out already-followed users
  // (checked before any browsing/follow attempt so no time is wasted).
  const unique = [...new Set(candidates)].sort(() => Math.random() - 0.5);
  let filtered = unique;
  if (skipFollowedUsernames?.size) {
    filtered = unique.filter(u => !skipFollowedUsernames.has(u.toLowerCase()));
    const skipped = unique.length - filtered.length;
    if (skipped > 0) onLog?.(`Follow: skipped ${skipped} already-followed user${skipped !== 1 ? 's' : ''}`);
  }
  if (skipSkippedUsernames?.size) {
    const before = filtered.length;
    filtered = filtered.filter(u => !skipSkippedUsernames.has(u.toLowerCase()));
    const skipped = before - filtered.length;
    if (skipped > 0) onLog?.(`Follow: skipped ${skipped} user${skipped !== 1 ? 's' : ''} already in the global skip list`);
  }
  // HikerAPI metadata is retained for source context only. Account-quality
  // filters are evaluated against Instagram's live profile UI below.

  // Mutable candidate pool. Extended automatically by re-scraping HikerAPI
  // whenever the current batch is exhausted before `targetCount` is reached —
  // the Follow tool never abandons mid-run just because a batch ran dry.
  targets = [...filtered];
  // Track every username ever placed in the pool across all scrape rounds so
  // re-scrapes never inject duplicates.
  attemptedSet = new Set<string>(targets.map(u => u.toLowerCase()));
    onLog?.(`Follow: ${targets.length} candidate${targets.length !== 1 ? "s" : ""} in pool, targeting ${targetCount} follow${targetCount !== 1 ? "s" : ""}`);
    MAX_SCRAPE_ROUNDS = (params.maxScrapeSessions ?? 0) > 0
      ? (params.maxScrapeSessions as number) - 1   // -1: initial scrape already done before loop
      : 50;  // effectively unlimited
  } else {
    // ── Spread mode: use pre-fetched candidates provided by the automation cycle ─
    const _pre = params.preloadedCandidates!;
    for (const [k, v] of _pre.candidateSource) candidateSource.set(k, v);
    for (const [k, v] of _pre.candidateMeta)   candidateMeta.set(k, v);
    targets = [..._pre.targets];
    targetCount = targets.length;
    if (targetCount === 0) { onLog?.("Follow: spread slot — no pre-fetched candidates"); return 0; }
    onLog?.(`Follow: spread mode — ${targetCount} Surplus candidate(s)`);
    attemptedSet = new Set<string>(targets.map(u => u.toLowerCase()));
    // MAX_SCRAPE_ROUNDS stays 0 — no re-scraping in spread mode
  }

  let followed = 0;
  let _fi = 0;              // manual index into `targets` (grows as re-scrapes inject new entries)
  let scrapeRound = 0;

  // Navigate to Search only for the first candidate in a spread. Backup
  // candidates reuse the confirmed cleared/focused Search field left by the
  // previous rejected candidate.
  if (!params.searchAlreadyReady) {
    onLog?.("[TRACE] follow: prepare-search");
    // Returning from Explore can leave the Search surface visually present
    // before its accessibility nodes are republished.
    await sleepOrAbort(serial, 2500);

  // Floating-window guard (MIUI "Floating windows" feature, confirmed 15 Jul
  // 2026 from live log + screenshot evidence). When Instagram is running in a
  // MIUI floating / resized window instead of fullscreen, the UIAutomator
  // accessibility dump reports the window's own bounds as the root — e.g.
  // 720×1709 instead of the real 1080×2460 screen. This shifts the
  // bottom-nav detection cutoff to a position where the nav bar no longer
  // sits, causing the old live Search-tab selector to miss every time even
  // though Instagram's layout is unchanged. Detection: compare the
  // ui-dump-derived root-bounds height against the real device height from
  // `adb shell wm size`. If mismatched by more than 12%, Instagram is in a
  // floating window. Recovery: relaunch Instagram fullscreen via `am start`
  // with CLEAR_TOP / NEW_TASK, which pulls the existing task out of floating
  // mode and into the foreground at full screen size on all tested MIUI
  // versions.
  const floatCheck = await android.detectFloatingWindow(serial).catch(() => null);
  if (floatCheck?.floating) {
    onLog?.(
      `Follow: ⚠️ Instagram is in a floating window (window ${floatCheck.windowW}×${floatCheck.windowH}, ` +
      `real screen ${floatCheck.deviceW}×${floatCheck.deviceH}) — relaunching fullscreen before proceeding`,
    );
    // Force-launch the main activity via the existing launchInstagram helper
    // (am start --activity-clear-top). Android/MIUI promotes the task from
    // the floating-window stack to a normal fullscreen foreground task.
    await android.launchInstagram(serial);
    // Give MIUI time to animate the window transition back to fullscreen.
    await sleepOrAbort(serial, 3000);
  }

    const searchTab = await android.tapCalibratedNavigationControl(serial, "search", onLog);
    onLog?.("[TRACE] follow: tap-search-tab");
    await sleepOrAbort(serial, 2500);
  } else {
    onLog?.("Follow: reusing confirmed cleared Search field for next spread candidate");
  }

  while (followed < targetCount) {
    // Pool exhausted — fetch a fresh batch from HikerAPI rather than giving up
    if (_fi >= targets.length) {
      if (scrapeRound >= MAX_SCRAPE_ROUNDS) {
        onLog?.(`Follow: pool exhausted after ${MAX_SCRAPE_ROUNDS} re-scrape rounds — stopping at ${followed}/${targetCount} follows`);
        break;
      }
      scrapeRound++;
      onLog?.(`Follow: pool exhausted (${followed}/${targetCount} followed) — re-scraping from HikerAPI (round ${scrapeRound}/${MAX_SCRAPE_ROUNDS})…`);
      // Abort check before any network calls — if the toggle was switched off
      // while the previous candidates were running, stop immediately instead
      // of firing a whole new batch of HikerAPI requests.
      await sleepOrAbort(serial, 0);
      const newRaw: string[] = [];
      const shuffledSrcs = [...sources].sort(() => Math.random() - 0.5);
      for (const src of shuffledSrcs) {
        // Check abort between every source so a long scrape round doesn't
        // ignore a stop-signal for minutes.
        await sleepOrAbort(serial, 0);
        if (newRaw.length >= targetCount * 3) break;
        const srcLabel = src.type === "hashtag"
          ? `#${src.value.replace(/^#/, "")}`
          : `@${src.value.replace(/^@/, "")}`;
        try {
          if (src.type === "hashtag") {
            const res = await hiker!.getHashtagUsers(src.value.replace(/^#/, ""), 50);
            for (const u of res.users) {
              if (attemptedSet.has(u.username.toLowerCase())) continue;
              if (!candidateSource.has(u.username)) candidateSource.set(u.username, srcLabel);
              if (u.isVerified !== undefined || u.isPrivate !== undefined || u.followerCount !== undefined)
                candidateMeta.set(u.username, { isVerified: u.isVerified, isPrivate: u.isPrivate, followerCount: u.followerCount });
              newRaw.push(u.username);
              attemptedSet.add(u.username.toLowerCase());
            }
            onLog?.(`Follow: re-scrape ${srcLabel} → ${res.users.length} users`);
          } else if (src.type === "target_followers") {
            const userInfo = await hiker!.getUserByUsername(src.value.replace(/^@/, "")).catch(() => null);
            if (userInfo?.pk) {
              const followers = await hiker!.getFollowers(userInfo.pk, 50);
              for (const u of followers) {
                if (attemptedSet.has(u.username.toLowerCase())) continue;
                if (!candidateSource.has(u.username)) candidateSource.set(u.username, srcLabel);
                if (u.isVerified !== undefined || u.isPrivate !== undefined || u.followerCount !== undefined)
                  candidateMeta.set(u.username, { isVerified: u.isVerified, isPrivate: u.isPrivate, followerCount: u.followerCount });
                newRaw.push(u.username);
                attemptedSet.add(u.username.toLowerCase());
              }
              onLog?.(`Follow: re-scrape ${srcLabel} followers → ${followers.length} users`);
            }
          }
        } catch (e: any) {
          // Must re-throw cycle-aborted — the generic catch here would
          // otherwise swallow it and keep looping through more sources.
          if (e?.message === "cycle-aborted") throw e;
          onLog?.(`Follow: HikerAPI re-scrape error for "${src.value}": ${e?.message}`);
        }
      }
      // Apply only global skip rules; account-quality filters are checked
      // against Instagram's live profile UI below.
      const newFiltered = newRaw.filter(u => {
        if (skipFollowedUsernames?.has(u.toLowerCase())) return false;
        if (skipSkippedUsernames?.has(u.toLowerCase())) return false;
        return true;
      });
      if (!newFiltered.length) {
        onLog?.(`Follow: re-scrape round ${scrapeRound} returned no new viable candidates — stopping`);
        break;
      }
      onLog?.(`Follow: re-scrape injected ${newFiltered.length} new candidate${newFiltered.length !== 1 ? "s" : ""} — continuing`);
      targets.push(...newFiltered);
      continue;
    }

    const username = targets[_fi++];
    try {
      onLog?.(`Follow: → @${username} (candidate ${_fi}/${targets.length})`);
      // A result tap opens a profile. The previous candidate's confirmed
      // Search state must never survive that navigation.
      searchReadyForReuse = false;

      // Tap the search bar and allow only a short keyboard/focus settle.
      // The live focus check below is authoritative; a multi-second random
      // delay here made every already-cleared search unnecessarily slow.
      // After a profile navigation, never assume the previous Search
      // surface survived. Re-enter Search from the live semantic tab node
      // before looking for the input bar.
      if (_fi > 1 && !searchReadyForReuse) {
        onLog?.("[TRACE] follow: re-enter-search-after-profile");
        await android.tapCalibratedNavigationControl(serial, "search", onLog);
        await sleepOrAbort(serial, 2500);
      }
      const searchBar = searchReadyForReuse
        ? (lastKnownSearchBar ?? await android.tapCalibratedNavigationControl(serial, "userSearch", onLog))
        : await android.tapCalibratedNavigationControl(serial, "userSearch", onLog);
      lastKnownSearchBar = searchBar;
      onLog?.(searchReadyForReuse ? "[TRACE] follow: reuse-focused-search-field" : "[TRACE] follow: tap-search-field");
      if (!searchReadyForReuse) await sleepOrAbort(serial, 500 + Math.floor(Math.random() * 500));
      const searchFocused = await android.isInstagramSearchBarFocused(serial).catch(() => false);
      if (!searchFocused) {
        onLog?.("Follow: search bar tap was not confirmed focused — stopping without pressing Back");
        break;
      }

      // Clear any leftover text from the previous search, then type the
      // new username.  KEYCODE_CTRL_A cannot send modifier+key chords via
      // adb shell input keyevent on Android — it is silently ignored so old
      // search text accumulates.  clearInstagramSearchBar() finds and taps
      // the × clear button by resource-id, or falls back to backspace-over-
      // text using the EditText node's text attribute (no coordinates used).
      if (searchReadyForReuse) {
        onLog?.("Follow: reusing confirmed clear/focus state — skipping redundant search cleanup");
      } else {
        // The Search node was just found and tapped above. Do not perform a
        // second UIAutomator dump here: on slower devices it can consume
        // the full dump timeout even when the field is already empty.
        await android.clearInstagramSearchBar(
          serial,
          (msg: string) => onLog?.(`  ${msg}`),
          { skipNodeLookup: true },
        );
      }
      searchReadyForReuse = false;
      onLog?.("[TRACE] follow: type-username");
      // Use only real taps on the saved Android keyboard calibration map.
      const typed = await android.typeViaSavedCalibrationMap(serial, username.replace(/^@+/, ""), context.effectiveTypingProfile(serial), (message: string) => {
        onLog?.(`  ${message}`);
      }, { debugLabel: "Follow" });
      if (!typed.ok) {
        onLog?.(
          `Follow: calibrated keyboard could not enter ${username}` +
          `${typed.missing.length ? ` — missing ${typed.missing.join(", ")}` : ""} — skipping`,
        );
        onLog?.("Follow: leaving failed search state without Back because field entry was not confirmed");
        continue;
      }
      // Tap the matched user in results
      onLog?.("[TRACE] follow: open-search-result");
      let searchResult = await android.findAndTapUserInSearch(serial, username, onLog).catch(() => ({ found: false }));
      if (!searchResult.found) {
        // The helper can report a miss after tapping the correct row when its
        // post-tap dump still contains stale search nodes or the profile
        // button is exposed with a different label. Re-check the live screen
        // here before treating the target as unopened.
        const recoveryProfileXml = await android.dumpUi(serial).catch(() => "");
        if (isConfirmedProfileSurface(recoveryProfileXml)) {
          searchResult = { found: true, profileXml: recoveryProfileXml };
          onLog?.(`Follow: @${username} profile is open — recovered from a stale/strict result verifier`);
        }
      }
      if (!searchResult.found) {
        onLog?.(`Follow: @${username} not found in results — skipping`);
        // Even on a failed result lookup, use the calibrated mirror Back
        // control. This keeps recovery aligned with the same visible control
        // used when a confirmed profile is opened and avoids Android Back's
        // context-dependent navigation.
        await tapCalibratedProfileBack("result lookup failed — leaving current search surface");
        await android.clearInstagramSearchBar(serial, (msg: string) => onLog?.(`  ${msg}`)).catch(() => {});
        searchReadyForReuse = false;
        onLog?.("Follow: failed result cleaned — next candidate will re-enter Search");
        continue;
      }

      let profileXml = searchResult.profileXml ?? "";
      // The post-tap verifier already dumped a confirmed profile tree. Reuse
      // it when it contains the profile header; only wait/dump again when
      // the verifier's tree is too sparse for the configured live filters.
      const profileEvidencePresent =
        profileXml.includes(":id/follow_button") ||
        profileXml.includes(":id/follow_btn") ||
        profileXml.includes(":id/inline_follow_button") ||
        /(?:text|content-desc)="(?:Follow|Following|Requested)"/.test(profileXml);
      if (!profileEvidencePresent) {
        await sleepOrAbort(serial, 1500);
        profileXml = await android.dumpUi(serial).catch(() => "");
      }

      // ── Profile-quality filter gate ────────────────────────────────────
      // ONE shared XML dump covers ALL active profile-quality filters:
      // Verified badge, Private account, Follower count (min & max), English
      // Speaking. Extra 1 s settle lets the profile header fully render
      // (badge + follower count) before the dump fires.
      if (filters && (filters.skipVerified || filters.skipPrivate || filters.maxFollowers !== undefined || filters.minFollowers !== undefined || filters.requireEnglish || filters.malesOnly)) {
        try {
          const filterGateStartedAt = Date.now();
          if (!profileXml || !profileXml.includes("</hierarchy>")) {
            await sleepOrAbort(serial, 1000);
            profileXml = await android.dumpUi(serial).catch(() => "");
          }

          // ── Verified badge ──────────────────────────────────────────────
          if (filters.skipVerified) {
            const isVerified =
              /content-desc="[^"]*[Vv]erified[^"]*"/.test(profileXml) ||
              profileXml.includes(":id/is_verified") ||
              profileXml.includes(":id/verified_badge") ||
              profileXml.includes(":id/verified_checkmark");
            if (isVerified) {
              onLog?.(`Follow: @${username} is verified — skipping (Skip Verified filter)`);
              if (params.writeSkippedUsers) storage.addSkippedUser(username, "verified-badge").catch(() => {});
              await returnToClearedFollowSearch();
              continue;
            }
          }

          // ── Private account ─────────────────────────────────────────────
          if (filters.skipPrivate) {
            // Instagram's private-profile UI is exposed as a notice block,
            // not consistently as a `private_profile` resource.  Current
            // builds expose:
            //   row_profile_header_empty_profile_notice_title
            //   text="This account is private"
            // and a subtitle telling the user to follow to see photos.
            // Match the live accessibility dump case-insensitively because
            // Android/Instagram builds vary the capitalization.
            const normalizedPrivateXml = profileXml
              .replace(/&amp;/g, "&")
              .replace(/\s+/g, " ");
            const isPrivate =
              /(?:text|content-desc)="[^"]*this\s+account\s+is\s+private[^"]*"/i.test(normalizedPrivateXml) ||
              /(?:text|content-desc)="[^"]*follow\s+this\s+profile\s+to\s+see\s+their\s+photos\s+and\s+videos[^"]*"/i.test(normalizedPrivateXml) ||
              normalizedPrivateXml.includes("row_profile_header_empty_profile_notice_title") ||
              normalizedPrivateXml.includes("row_profile_header_empty_profile_notice_subtitle") ||
              /private_profile/i.test(normalizedPrivateXml);
            if (isPrivate) {
              onLog?.(`Follow: @${username} is private — skipping (Private Users filter)`);
              if (params.writeSkippedUsers) storage.addSkippedUser(username, "private-account").catch(() => {});
              await returnToClearedFollowSearch();
              continue;
            }
          }

          // ── Follower count (shared parse for max & min checks) ──────────
          if (filters.maxFollowers !== undefined || filters.minFollowers !== undefined) {
            const followerMatch = profileXml.match(
              /content-desc="([0-9][0-9,.]*)([KkMm]?)\s*[Ff]ollowers/
            );
            if (followerMatch) {
              const digits = parseFloat(followerMatch[1].replace(/,/g, ""));
              const suffix = followerMatch[2].toLowerCase();
              const count = suffix === "k" ? digits * 1_000
                          : suffix === "m" ? digits * 1_000_000
                          : digits;
              if (!isNaN(count)) {
                if (filters.maxFollowers !== undefined && count >= filters.maxFollowers) {
                  onLog?.(`Follow: @${username} has ${count.toLocaleString()} followers (≥25K) — skipping (-25K filter)`);
                  if (params.writeSkippedUsers) storage.addSkippedUser(username, "too-many-followers").catch(() => {});
                  await returnToClearedFollowSearch();
                  continue;
                }
                if (filters.minFollowers !== undefined && count < filters.minFollowers) {
                  onLog?.(`Follow: @${username} has ${count.toLocaleString()} followers (<${filters.minFollowers}) — skipping (50 Followers+ filter)`);
                  if (params.writeSkippedUsers) storage.addSkippedUser(username, "too-few-followers").catch(() => {});
                  await returnToClearedFollowSearch();
                  continue;
                }
              }
            }
          }

          // ── English Speaking ────────────────────────────────────────────
          // Detect non-allowed scripts by Unicode range rather than a
          // non-ASCII ratio. Ratio checks fail on mixed bios (some Hindi,
          // some Latin + emojis) because the Latin portion dilutes the
          // ratio below any threshold.
          //
          // SAFE scripts (pass through):
          //   Latin / Latin Extended (English, all EU languages)
          //   CJK Unified Ideographs (Chinese, Japanese)
          //   Hiragana / Katakana (Japanese)
          //   Hangul (Korean)
          //   Cyrillic (Bulgarian, Serbian — EU members)
          //   Greek (EU member)
          //   Common: ASCII, digits, punctuation, emoji
          //
          // BLOCKED scripts (trigger skip):
          //   Arabic / Urdu / Persian  U+0600–06FF, U+0750–077F,
          //                            U+08A0–08FF, U+FB50–FDFF, U+FE70–FEFF
          //   Devanagari (Hindi etc.)  U+0900–097F
          //   Bengali                  U+0980–09FF
          //   Gurmukhi (Punjabi)       U+0A00–0A7F
          //   Gujarati                 U+0A80–0AFF
          //   Oriya                    U+0B00–0B7F
          //   Tamil                    U+0B80–0BFF
          //   Telugu                   U+0C00–0C7F
          //   Kannada                  U+0C80–0CFF
          //   Malayalam                U+0D00–0D7F
          //   Sinhala                  U+0D80–0DFF
          //   Thai                     U+0E00–0E7F
          //   Lao                      U+0E80–0EFF
          //   Tibetan                  U+0F00–0FFF
          //   Myanmar                  U+1000–109F
          //
          // Even 3 characters from a blocked script in any node is enough
          // to skip — a single Hindi word easily exceeds that.
          if (filters.requireEnglish) {
            // eslint-disable-next-line no-misleading-character-class
            const BLOCKED_SCRIPT_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F\u0D80-\u0DFF\u0E00-\u0E7F\u0E80-\u0EFF\u0F00-\u0FFF\u1000-\u109F]/g;
            // UIAutomator XML dumps encode non-Latin characters as XML
            // character references (e.g. Hindi "स" → "&#x938;" or "&#2360;")
            // rather than raw Unicode.  The regex above tests raw codepoints,
            // so it would silently miss every encoded char.  Decode both hex
            // (&#xNNNN;) and decimal (&#NNNN;) entity references before testing.
            const decodeXmlEntities = (s: string) =>
              s.replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
               .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
            let skipForEnglish = false;
            const contentDescNodes = profileXml.match(/content-desc="([^"]{3,300})"/g) ?? [];
            const textNodes        = profileXml.match(/\btext="([^"]{3,300})"/g) ?? [];
            const allNodes = [...contentDescNodes, ...textNodes];
            for (const m of allNodes) {
              const rawVal = m.replace(/^(?:content-desc|text)="/, "").replace(/"$/, "");
              const val = decodeXmlEntities(rawVal);
              if (val.length < 3) continue;
              const blockedChars = (val.match(BLOCKED_SCRIPT_RE) ?? []).length;
              if (blockedChars >= 3) { skipForEnglish = true; break; }
            }
            if (skipForEnglish) {
              onLog?.(`Follow: @${username} bio contains non-allowed script — skipping (English Speaking filter)`);
              if (params.writeSkippedUsers) storage.addSkippedUser(username, "non-english").catch(() => {});
              await returnToClearedFollowSearch();
              continue;
            }
          }

          // ── Males Only (last profile filter) ────────────────────────────
          // This remains an explicit allowlist, never gender inference. The
          // live Instagram accessibility tree is authoritative; HikerAPI
          // candidate metadata is never used for this decision.
          if (filters.malesOnly) {
            const allowedNames = getCompiledMalesOnlyNames(filters.maleNames ?? "");
            let matchesAllowedName = false;
            if (allowedNames.length) {
              const malesMatchStartedAt = Date.now();
              const matchedEntry = findLiveMalesOnlyMatch(username, profileXml, allowedNames);
              onLog?.(`Follow: Males Only checked ${allowedNames.length.toLocaleString()} configured name(s) in ${Date.now() - malesMatchStartedAt} ms`);
              matchesAllowedName = Boolean(matchedEntry);
              if (matchedEntry) {
                onLog?.(`Follow: Males Only allowed @${username} — matched "${matchedEntry.name}" in live profile ${matchedEntry.field}`);
              }
            }
            if (!matchesAllowedName) {
              onLog?.(`Follow: @${username} has no allowed Males Only name in username, name, or bio — skipping`);
              if (params.writeSkippedUsers) storage.addSkippedUser(username, "males-only-name").catch(() => {});
              await returnToClearedFollowSearch();
              continue;
            }
          }
          onLog?.(`Follow: profile filters completed in ${Date.now() - filterGateStartedAt} ms`);

        } catch (filterErr: any) {
          if (filters.skipPrivate) {
            onLog?.(`Follow: private-account check failed for @${username} — skipping`);
            if (params.writeSkippedUsers) storage.addSkippedUser(username, "private-check-failed").catch(() => {});
            await returnToClearedFollowSearch();
            continue;
          }
          if (filters.malesOnly) {
            onLog?.(`Follow: Males Only profile check failed for @${username} (${filterErr?.message}) — skipping`);
            if (params.writeSkippedUsers) storage.addSkippedUser(username, "males-only-check-failed").catch(() => {});
            await returnToClearedFollowSearch();
            continue;
          }
          onLog?.(`Follow: profile-filter check failed for @${username} (${filterErr?.message}) — proceeding`);
        }
      }

      // Inject Browsing — rolled fresh for this user. `willBrowse` decides
      // whether browsing happens at all; `browseBeforeFollow` (an
      // independent roll, only consulted when willBrowse is true) decides
      // whether it happens before or after the Follow tap. A before-follow
      // miss no longer skips browsing — it just moves it to run after the
      // follow instead.
      const { willBrowse, browseBeforeFollow } = browsing
        ? rollInjectBrowsingDecision(browsing)
        : { willBrowse: false, browseBeforeFollow: false };

      if (browsing && willBrowse && browseBeforeFollow) {
        onLog?.("Inject Browsing: rolled to browse this profile before following");
        const didScroll = await runProfileBrowsingSequence(serial, browsing, onLog, onLike, context).catch((e: any) => {
          if (e?.message === "cycle-aborted") throw e;
          onLog?.(`Inject Browsing: error — ${e?.message}`);
          return 0;
        });
        // Scroll EXACTLY as many rows back up as we scrolled down, so we
        // stop at the top of the grid where the Follow button is visible.
        // Doing MORE swipes than we scrolled overshoots the top and triggers
        // a pull-to-refresh (a downward finger-drag from the very top of the
        // content), which is both wrong and bot-like.  Using a start-y that
        // is safely below the top of the content area (0.55 rather than
        // 0.30) also avoids accidentally hitting the profile header zone.
        if (didScroll > 0) {
          const { w: bw, h: bh } = getScreenSize(serial);
          onLog?.(`Inject Browsing: scrolling back to top — ${didScroll} row(s)`);
          // Swipe geometry must mirror the scroll-down exactly so N scrolls
          // back up covers the same content distance as N scrolls down.
          // Scroll-down: finger 0.78→0.30 = 48% of screen height per swipe.
          // Scroll-up:   finger 0.35→0.80 = 45% of screen height per swipe.
          // (0.35 start avoids the profile header tap zone; 0.80 end matches
          //  the same lower-screen anchor as the down-swipe start.)
          // Pull-to-refresh is triggered by content position, not finger
          // start-y, so a longer swipe here does NOT risk pull-to-refresh
          // as long as we don't scroll MORE rows than we scrolled down.
          for (let _si = 0; _si < didScroll; _si++) {
            logger.info({ serial, source: "inject-follow-profile-grid-scroll-back", from: [Math.round(bw / 2), Math.round(bh * 0.35)], to: [Math.round(bw / 2), Math.round(bh * 0.80)], durationMs: 400 }, "[mobile-input] swipe");
            // Reverse the calibrated gesture, rather than sending the
            // configured forward path again. This keeps the profile grid at
            // the same top position after exactly `didScroll` rows.
            await deviceProfileSwipe(
              serial,
              { x1: Math.round(bw / 2), y1: Math.round(bh * 0.35), x2: Math.round(bw / 2), y2: Math.round(bh * 0.80), durationMs: 400 },
              "inject-follow-profile-grid-scroll-back",
              "back",
            );
            await sleepOrAbort(serial, 350);
            // A visible post-count stat means the profile header is back in
            // view, so the grid has reached the top. Do not perform the
            // remaining planned swipes; each extra swipe can refresh the
            // profile and look like repeated browsing to Instagram.
            const topStats = await android.getProfilePostCount(serial).catch(() => null);
            if (topStats !== null) {
              onLog?.(`Inject Browsing: profile header detected after ${_si + 1}/${didScroll} upward swipe(s) — stopping top recovery early`);
              break;
            }
          }
          await sleepOrAbort(serial, 500);
        }
      } else if (browsing && willBrowse && !browseBeforeFollow) {
        onLog?.("Inject Browsing: rolled to browse this profile after following");
      }

      // Abandon Follow — fires only when pre-follow browsing ran. Rolls a
      // per-user chance to skip the follow entirely so not every browsing
      // session ends identically. The user is NOT added to any skip list and
      // CAN be scraped and followed again in a future cycle or by another
      // account — the goal is purely to add variation to the follow pattern.
      if (browsing && willBrowse && browseBeforeFollow && browsing.abandonFollowPctMin > 0) {
        const abandonChance = rollRange(browsing.abandonFollowPctMin, browsing.abandonFollowPctMax) / 100;
        if (Math.random() < abandonChance) {
          onLog?.(`Follow: ↩ abandoned follow @${username} after inject-browsing (variation — user can be re-scraped)`);
          await tapCalibratedProfileBack("abandoned follow — returned to search results");
          const interPopup = await android.dismissInstagramInterstitials(serial).catch(() => null);
          if (interPopup) await sleepOrAbort(serial, 400);
          continue;
        }
      }

      // Dismiss any interstitial/upsell popup that appeared during navigation
      // to this profile or during pre-follow browsing (e.g. "Instagram Plus
      // — Choose custom fonts for your profile bio" with "Not now" dismiss).
      // Must run before the Follow tap so the popup isn't blocking the button.
      const preFollowPopup = await android.dismissInstagramInterstitials(serial).catch(() => null);
      if (preFollowPopup) {
        onLog?.(`Follow: dismissed popup before follow tap ("${preFollowPopup}")`);
        await sleepOrAbort(serial, 400);
      }

      // Tap Follow on the profile page. Only logs success when the button
      // is confirmed to have changed to "Following" or "Requested".
      const didFollow = await android.tapFollowButtonOnProfilePage(serial).catch(() => false);
      onLog?.(`[TRACE] follow: follow-result=${didFollow ? "confirmed" : "not-confirmed"}`);
      if (didFollow) {
        followed++;
        recordFollow?.(username, candidateSource.get(username) ?? "unknown");
        onLog?.(`Follow: ✓ followed @${username} (${followed}/${targets.length})`);
        await sleepOrAbort(serial, 1000 + Math.round(Math.random() * 1500));
      } else {
        onLog?.(`Follow: Follow button not found or state did not change on @${username} — already following?`);
      }

      // Browsing rolled to run AFTER the follow — do it now, still on the
      // same profile page, regardless of whether the follow tap itself
      // succeeded (a missed/duplicate Follow tap shouldn't also skip the
      // browsing that was already decided for this user).
      if (browsing && willBrowse && !browseBeforeFollow) {
        await runProfileBrowsingSequence(serial, browsing, onLog, onLike, context).catch((e: any) => {
          if (e?.message === "cycle-aborted") throw e;
          onLog?.(`Inject Browsing: error — ${e?.message}`);
        });
      }

      // For another target, leave the profile with two calibrated Back taps:
      // profile → search results → Explore. Then focus the clean Explore search
      // field so the next username is typed into a fresh search context.
      if (followed < targetCount) {
        await prepareNextTargetSearch("next target");
      } else {
        await tapCalibratedProfileBack("returned to search results");
        await sleepOrAbort(serial, 800);
      }
      // Dismiss any popup that appeared after pressing back (e.g. IG Plus
      // upsell, notification prompts) before the next operation.
      const interUserPopup = await android.dismissInstagramInterstitials(serial).catch(() => null);
      if (interUserPopup) {
        onLog?.(`Follow: dismissed popup between users ("${interUserPopup}")`);
        await sleepOrAbort(serial, 400);
      }
    } catch (e: any) {
      if (e?.message === "cycle-aborted") throw e;
      onLog?.(`Follow: error on @${username}: ${e?.message}`);
    }
  }

  // ── Save unused candidates to Surplus ────────────────────────────────────
  // Any candidate that was in the pool but never attempted (because
  // targetCount was reached first) is written to the Surplus table so the
  // NEXT cycle can consume them before calling HikerAPI again — saving
  // API quota.  Only candidates from index _fi onward were never attempted.
  if (!_usePreloaded && _fi < targets.length && (profileId && profileId > 0 || phoneSlotKey)) {
    const surplus = targets.slice(_fi);
    const now = new Date().toISOString();
    const surplusEntries = surplus.map(u => ({
      profileId: (profileId && profileId > 0) ? profileId : 0,
      phoneSlotKey: (profileId && profileId > 0) ? "" : phoneSlotKey,
      instagramUsername: u,
      instagramUserId: "",
      sourceValue: candidateSource.get(u) ?? "surplus",
      sourceType: "phone",
      scrapedAt: now,
    }));
    storage.addOverspillUsers(surplusEntries).catch(() => {});
    onLog?.(`Follow: saved ${surplusEntries.length} unused candidate${surplusEntries.length !== 1 ? "s" : ""} to Surplus for next cycle`);
  }

  if (_usePreloaded && params.keepSearchOpenAfterStep) {
    // Spread Follows invokes this step once per assigned candidate/backup.
    // Do not leave Search with the normal two-Back final cleanup between
    // segments: the next Spread Follow segment is about to reuse the same
    // Search surface. Filter-rejected candidates already use
    // returnToClearedFollowSearch(), which returns here with one Back and a
    // cleared/focused search field.
    try {
      if (searchReadyForReuse) {
        onLog?.("Spread Follow: cleanup — search already confirmed clear/focused; skipping redundant cleanup");
      } else {
        await android.clearInstagramSearchBar(serial, (msg: string) => onLog?.(`Spread Follow: cleanup — ${msg}`));
      }
      onLog?.("Spread Follow: cleanup — cleared search; keeping Search open for next assignment");
    } catch (e: any) {
      if (e?.message === "cycle-aborted") throw e;
      onLog?.(`Spread Follow: cleanup clear failed — ${e?.message ?? "unknown error"}`);
    }
  } else {
    await finishFollowNavigation();
  }
  return followed;
}
