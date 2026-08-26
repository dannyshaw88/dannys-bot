export interface ViewFeedOperationContext {
  android: any;
  deviceProfileSwipe: (...args: any[]) => Promise<any>;
  getScreenSize: (...args: any[]) => any;
  isCycleAborted: (...args: any[]) => boolean;
  logger: any;
  sleepOrAbort: (...args: any[]) => Promise<void>;
  consumptionScrollWeights: any;
  rollFeedConsumptionGesture: (...args: any[]) => any;
  loadInstanceConfigs: () => any;
  _viewFeedLastDmRecipient: Map<string, { x: number; y: number }>;
  dismissSaveCollectionPrompt: (...args: any[]) => Promise<boolean>;
}

export async function runCheckFeedLoop(serial: string, params: {
    count: number; delayMinSec?: number; delayMaxSec?: number;
    likesMin?: number; likesMax?: number; rerunChanceMin?: number; rerunChanceMax?: number;
    /** Automation-cycle has already navigated here; standalone Check Feed has not. */
    homeAlreadyEstablished?: boolean;
    likePercentMin: number; likePercentMax: number;
    shareFeedPercentMin?: number; shareFeedPercentMax?: number;
    shareDmPercentMin?: number; shareDmPercentMax?: number;
    savePercentMin?: number; savePercentMax?: number;
    expandCaptionPercentMin?: number; expandCaptionPercentMax?: number;
    tapAudioPercentMin?: number; tapAudioPercentMax?: number;
    clickHashtagPercentMin?: number; clickHashtagPercentMax?: number;
    clickAuthorPercentMin?: number; clickAuthorPercentMax?: number;
    onLog?: (msg: string) => void;
  } , context: ViewFeedOperationContext): Promise<{
 count: number; likes: number; likeFailures: number; sharesFeed: number; sharesDm: number; saves: number; captionExpands: number; strayNavRecoveries: number; audioTaps: number; hashtagTaps: number; authorVisits: number }> {
    const { android, deviceProfileSwipe, getScreenSize, isCycleAborted, logger, sleepOrAbort, consumptionScrollWeights, rollFeedConsumptionGesture, loadInstanceConfigs, _viewFeedLastDmRecipient, dismissSaveCollectionPrompt } = context;
    params.onLog?.("[TRACE] feed: start");
    const {
      count, delayMinSec = 5, delayMaxSec = 10, likePercentMin: rawLikePercentMin = 0, likePercentMax: rawLikePercentMax = 0, likesMin, likesMax,
      shareFeedPercentMin = 0, shareFeedPercentMax = 0,
      shareDmPercentMin = 0, shareDmPercentMax = 0,
      savePercentMin = 0, savePercentMax = 0,
      expandCaptionPercentMin = 0, expandCaptionPercentMax = 0,
      tapAudioPercentMin = 0, tapAudioPercentMax = 0,
      clickHashtagPercentMin = 0, clickHashtagPercentMax = 0,
      clickAuthorPercentMin = 0, clickAuthorPercentMax = 0,
      homeAlreadyEstablished = false,
      onLog,
    } = params;
    const likePercentMin = likesMin ?? rawLikePercentMin;
    const likePercentMax = likesMax ?? rawLikePercentMax;

    // Always establish the Home/feed surface before taking the first live
    // post dump. View Feed can be launched while Instagram is on a profile,
    // search, Reels, or another nested screen; scanning that tree as if it
    // were the feed causes every downstream action to target the wrong UI.
    if (!homeAlreadyEstablished) {
      onLog?.("[TRACE] feed: find-home");
      const homeTab = await android.findHomeTab(serial).catch(() => null);
      if (!homeTab) {
        throw new Error("View Feed cannot start: Instagram Home tab was not found");
      }
      onLog?.(`View Feed: tapping Home tab before execution at (${homeTab.x}, ${homeTab.y})`);
      await android.tap(serial, homeTab.x, homeTab.y, "bot");
      onLog?.("[TRACE] feed: tap-home");
      await new Promise(resolve => setTimeout(resolve, 150 + Math.floor(Math.random() * 351)));
    } else {
      onLog?.("View Feed: Home feed already established — skipping duplicate Home tap");
    }

    const delayLoSec = Math.min(delayMinSec, delayMaxSec);
    const delayHiSec = Math.max(delayMinSec, delayMaxSec);
    const likeLoPct = Math.min(likePercentMin, likePercentMax);
    const likeHiPct = Math.max(likePercentMin, likePercentMax);
    const likeChance = (likeLoPct + Math.random() * (likeHiPct - likeLoPct)) / 100;
    const shareFeedLo = Math.min(shareFeedPercentMin, shareFeedPercentMax);
    const shareFeedHi = Math.max(shareFeedPercentMin, shareFeedPercentMax);
    const shareFeedChance = (shareFeedLo + Math.random() * (shareFeedHi - shareFeedLo)) / 100;
    const shareDmLo = Math.min(shareDmPercentMin, shareDmPercentMax);
    const shareDmHi = Math.max(shareDmPercentMin, shareDmPercentMax);
    const shareDmChance = (shareDmLo + Math.random() * (shareDmHi - shareDmLo)) / 100;
    const saveLo = Math.min(savePercentMin, savePercentMax);
    const saveHi = Math.max(savePercentMin, savePercentMax);
    const saveChance = (saveLo + Math.random() * (saveHi - saveLo)) / 100;
    const captionExpandLo = Math.min(expandCaptionPercentMin, expandCaptionPercentMax);
    const captionExpandHi = Math.max(expandCaptionPercentMin, expandCaptionPercentMax);
    const captionExpandChance = (captionExpandLo + Math.random() * (captionExpandHi - captionExpandLo)) / 100;
    const tapAudioLo = Math.min(tapAudioPercentMin, tapAudioPercentMax);
    const tapAudioHi = Math.max(tapAudioPercentMin, tapAudioPercentMax);
    const tapAudioChance = (tapAudioLo + Math.random() * (tapAudioHi - tapAudioLo)) / 100;
    const clickHashtagLo = Math.min(clickHashtagPercentMin, clickHashtagPercentMax);
    const clickHashtagHi = Math.max(clickHashtagPercentMin, clickHashtagPercentMax);
    const clickHashtagChance = (clickHashtagLo + Math.random() * (clickHashtagHi - clickHashtagLo)) / 100;
    const clickAuthorLo = Math.min(clickAuthorPercentMin, clickAuthorPercentMax);
    const clickAuthorHi = Math.max(clickAuthorPercentMin, clickAuthorPercentMax);
    const clickAuthorChance = (clickAuthorLo + Math.random() * (clickAuthorHi - clickAuthorLo)) / 100;
    onLog?.(`Feed settings — like:${Math.round(likeChance * 100)}% expandCaption:${Math.round(captionExpandChance * 100)}% tapAudio:${Math.round(tapAudioChance * 100)}% clickHashtag:${Math.round(clickHashtagChance * 100)}% clickAuthor:${Math.round(clickAuthorChance * 100)}% save:${Math.round(saveChance * 100)}% shareFeed:${Math.round(shareFeedChance * 100)}% shareDm:${Math.round(shareDmChance * 100)}%`);

    const { w, h } = getScreenSize(serial);
    const x  = Math.round(w / 2);
    // y1 must start LOW enough to be below the action bar (Like/Comment/Share
    // icons) of every Instagram post format, including the tallest allowed
    // (4:5 portrait). On a 720×1280 device a 4:5 image is 720×900px; adding
    // the ~60px header puts the action bar at y≈960–1008. The old y1=78%
    // (y=998) landed RIGHT on that bar — Android registered the touch-down
    // on the Comment icon and the upward drag was treated as opening comments
    // rather than scrolling the feed. Moving to 88% (y=1126) clears the
    // action bar of any format by ≥100px while still leaving a 600px+ drag
    // distance to y2.
    const y1 = Math.round(h * 0.88);
    const y2 = Math.round(h * 0.22);
    const cy = Math.round(h / 2);
    // Instagram feed post action-bar icon positions are NOT fixed —
    // page/profile owners can disable comments and/or shares per post,
    // which removes icons from the bar and shifts everything after the
    // gap left-ward. A fixed 48.1%/66.0% X guess (measured from one
    // screenshot where all icons happened to be present) landed on the
    // Comment button once a post had fewer icons than that, opening the
    // comment/reply compose box instead of sharing — confirmed from a
    // user-supplied screen-layout scan (Jul 2026). Every tap below is now
    // resolved per-post from `android.findFeedActionIcons()`, which reads
    // the real accessibility tree for whatever's on screen right now and
    // returns `null` for any icon whose identity is ambiguous (see its
    // doc comment) instead of guessing — see the action-bar gating below.

    // Share-to-DM used to just tap the paper-plane icon and press Back —
    // it never actually picked a recipient or sent anything, it only
    // *opened and closed* the DM picker. See tapRandomShareSheetRecipient /
    // sendShareSheet below for the real send flow.

    let likes = 0;
    let likeFailures = 0;
    let captionExpands = 0;
    let sharesFeed = 0;
    let sharesDm = 0;
    let saves = 0;
    let strayNavRecoveries = 0;
    let audioTaps = 0;
    let hashtagTaps = 0;
    let authorVisits = 0;
    // Sponsored posts ("Ads") render a full-width CTA button ("Shop Now",
    // "Install Now", "Learn More") overlaid near the bottom of the media —
    // right where our double-tap-to-like jitter can land after a scroll that
    // doesn't align to a post boundary. Tapping that button navigates out of
    // Instagram entirely (browser / Play Store), and every scripted tap for
    // the rest of the cycle then lands on the wrong app, which looks like
    // "the whole flow broke". We can't reliably detect an ad from pixels
    // alone via adb, so instead we verify we're still inside Instagram after
    // every gesture that could have hit a CTA, and recover with BACK if not.
    const INSTAGRAM_PKG = "com.instagram.android";
    const verifyStillInInstagram = async (): Promise<boolean> => {
      const fg = await android.getForegroundPackage(serial).catch(() => null);
      if (!fg || fg === INSTAGRAM_PKG) return true;
      if (fg !== INSTAGRAM_PKG) {
        strayNavRecoveries++;
        logger.warn({ serial, fg }, "[check-feed] tap navigated away from Instagram (likely hit an ad's CTA) — recovering with BACK");
        onLog?.(`⚠ Tapped outside Instagram — foreground app is "${fg}" (likely hit an ad CTA). Pressing Back to recover…`);
        try { await android.pressBack(serial); } catch { /* best effort */ }
        await sleepOrAbort(serial, 700);
        // If BACK didn't get us home (e.g. it opened a separate app like the
        // Play Store rather than an in-app browser), force Instagram back to
        // the foreground rather than continuing to tap blind.
        const fg2 = await android.getForegroundPackage(serial).catch(() => null);
        if (fg2 && fg2 !== INSTAGRAM_PKG) {
          await android.launchInstagram(serial).catch(() => { /* best effort */ });
          await sleepOrAbort(serial, 1500);
        }
      }
      return false;
    };

    // View Feed owns this scan deliberately.  Do not replace it with the
    // shared feed-icon helper: that helper is also used by other tools and its
    // row selection is allowed to use assumptions that are unsafe here.
    //
    // Every coordinate returned by this function is the centre of the exact
    // accessibility node that supplied it.  The current post is selected by
    // one coherent action-row identity (Like + any same-row controls), never
    // by screen percentages or by "first node in the dump".
    type ViewFeedA11yNode = {
      x: number; y: number; x1: number; y1: number; x2: number; y2: number;
      rid: string; desc: string; text: string; cls: string; clickable: boolean;
    };
    type ViewFeedScan = {
      like: { x: number; y: number };
      alreadyLiked: boolean;
      comment: { x: number; y: number } | null;
      shareFeed: { x: number; y: number } | null;
      shareDm: { x: number; y: number } | null;
      save: { x: number; y: number } | null;
      saveLabel: string;
      author: { x: number; y: number; name: string } | null;
      audio: { x: number; y: number } | null;
      mediaBounds?: { x1: number; y1: number; x2: number; y2: number };
      isVideoPost: boolean;
      xml: string;
    };
    const scanViewFeedA11y = async (): Promise<ViewFeedScan | null> => {
      const xml = await android.dumpUi(serial).catch(() => "");
      if (!xml) return null;
      if (
        xml.includes('text="Ad"') || xml.includes('content-desc="Ad"') ||
        xml.includes('text="Sponsored"') || xml.includes('content-desc="Sponsored"') ||
        xml.includes('text="Advert"') || xml.includes('content-desc="Advert"')
      ) {
        onLog?.("View Feed a11y scan: sponsored post marker found — skipping post actions");
        return null;
      }
      const nodes: ViewFeedA11yNode[] = [];
      for (const segment of xml.split("<node ")) {
        const bounds = segment.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!bounds) continue;
        const x1 = Number(bounds[1]), y1 = Number(bounds[2]);
        const x2 = Number(bounds[3]), y2 = Number(bounds[4]);
        const attr = (name: string) => (segment.match(new RegExp(`${name}="([^"]*)"`)) ?? [])[1] ?? "";
        const rid = attr("resource-id");
        const desc = attr("content-desc");
        const text = attr("text");
        const cls = attr("class");
        nodes.push({
          x: Math.floor((x1 + x2) / 2), y: Math.floor((y1 + y2) / 2),
          x1, y1, x2, y2, rid, desc, text, cls,
          clickable: segment.includes('clickable="true"'),
        });
      }

      // View Feed's Like anchor must come from the packaged visual heart
      // reference. Accessibility Like nodes and media bounds are not safe
      // anchors on every Instagram build: ads can expose Learn More buttons,
      // and recycled rows can expose a Like from a different post. The visual
      // matcher also performs the strict sponsored-card check.
      const visualIcons = await android.findFeedActionIcons(serial, onLog, {
        strictViewFeed: true,
        // Reuse this scan's complete XML. findFeedActionIcons still captures
        // a fresh screenshot for the visual Like reference, but must not pay
        // for a second UIAutomator dump of the same post.
        uiXml: xml,
      }).catch(() => null);
      if (!visualIcons) {
        onLog?.("View Feed visual scan: Like reference did not identify a safe Like target — skipping actions");
        // View Feed diagnostic only: preserve the raw node attributes that
        // explain a failed action-bar match. This is especially important for
        // carousels, whose media hierarchy differs from single-photo posts.
        // Do not dump the entire XML into the UI log; retain every node in the
        // action-bar band plus media-group nodes so the next exported log is
        // self-contained without changing automation behavior.
        const diagnosticNodes = nodes.filter(n =>
          (n.y1 >= 0.40 * getScreenSize(serial).h && n.y1 <= 0.82 * getScreenSize(serial).h) ||
          /(?:carousel_)?media_group/i.test(n.rid),
        );
        onLog?.(
          `View Feed a11y diagnostic: ${diagnosticNodes.length} raw node(s) in ` +
          `action/media region`,
        );
        for (const n of diagnosticNodes) {
          onLog?.(
            `[feed-raw-node] ${n.clickable ? "CLICKABLE" : "view"} ` +
            `rid="${n.rid}" desc="${n.desc}" text="${n.text}" ` +
            `class="${n.cls}" bounds="[${n.x1},${n.y1}][${n.x2},${n.y2}"]"`,
          );
        }
        return null;
      }
      const visualLike = {
        x: visualIcons.like.x,
        y: visualIcons.like.y,
        x1: visualIcons.like.x - 16,
        y1: visualIcons.like.y - 16,
        x2: visualIcons.like.x + 16,
        y2: visualIcons.like.y + 16,
        rid: "visual-like-reference",
        desc: "",
        text: "",
        cls: "android.widget.ImageView",
        clickable: true,
      } satisfies ViewFeedA11yNode;
      // Deliberately use only the visual anchor. The a11y tree remains useful
      // for finding the optional comment/share/save controls on this same row,
      // but it can never replace the verified Like coordinate.
      const likes = [visualLike];

      const sameRow = (a: ViewFeedA11yNode, b: ViewFeedA11yNode, tolerance = 36) =>
        Math.abs(a.y - b.y) <= tolerance;
      const isSave = (n: ViewFeedA11yNode) =>
        n.rid.includes("row_feed_button_save") ||
        /^(?:add to saved|remove from saved)$/i.test(n.desc);
      const isComment = (n: ViewFeedA11yNode) =>
        /^comment$/i.test(n.desc) && !/commentary|comments/i.test(n.text);
      const isRepost = (n: ViewFeedA11yNode) =>
        /^(?:repost|repost to your story|share to feed)$/i.test(n.desc);
      const isDm = (n: ViewFeedA11yNode) =>
        /^(?:send|direct|message|share via dm)$/i.test(n.desc);
      const isFeedSaveRibbon = (n: ViewFeedA11yNode) =>
        n.clickable &&
        isSave(n) &&
        n.x1 >= getScreenSize(serial).w * 0.78 &&
        n.x2 > n.x1 &&
        n.y2 > n.y1 &&
        n.x2 - n.x1 <= 180 &&
        n.y2 - n.y1 <= 180;

      // Pick the row with the strongest complete identity.  A recycled
      // off-screen post may expose another Like node, but it will not have the
      // same row's save/role controls.  Ties are ambiguous and fail closed.
      const rowChoices = likes.map(like => {
        const row = nodes.filter(n => sameRow(n, like));
        const controls = row.filter(n => n.clickable);
        const mediaAbove = nodes
          .filter(n => /(?:carousel_)?media_group/.test(n.rid) && n.y2 < like.y)
          .sort((a, b) => (like.y - a.y2) - (like.y - b.y2))[0];
        const mediaGap = mediaAbove ? like.y - mediaAbove.y2 : Number.POSITIVE_INFINITY;
        const score =
          100 +
          (row.some(isSave) ? 40 : 0) +
          (row.some(isComment) ? 20 : 0) +
          (row.some(isRepost) ? 20 : 0) +
          (row.some(isDm) ? 20 : 0) +
          Math.min(controls.length, 8) +
          (mediaAbove ? 60 : 0);
        return { like, row, score, mediaGap };
      });
      rowChoices.sort((a, b) => b.score - a.score || a.mediaGap - b.mediaGap);
      if (
        rowChoices.length > 1 &&
        rowChoices[0].score === rowChoices[1].score &&
        rowChoices[0].mediaGap === rowChoices[1].mediaGap
      ) {
        onLog?.("View Feed a11y scan: multiple equally-identified action rows — skipping");
        return null;
      }
      const chosen = rowChoices[0];
      const row = chosen.row;
      const like = chosen.like;
      const pos = (n: ViewFeedA11yNode) => ({ x: n.x, y: n.y });
      const clickableRow = row.filter(n => n.clickable);
      // A save resource-id can also appear on a large wrapper around an
      // embedded Reel/media surface. Only accept a compact, right-edge live
      // node as the feed ribbon; never tap a large wrapper's centre.
      const saveNode = clickableRow.find(isFeedSaveRibbon) ?? null;
      const commentNode = clickableRow.find(isComment) ?? null;
      const repostNode = clickableRow.find(isRepost) ?? null;
      const dmNode = clickableRow.find(isDm) ?? null;

      let comment = commentNode ? pos(commentNode) : null;
      let shareFeed = repostNode ? pos(repostNode) : null;
      let shareDm = dmNode ? pos(dmNode) : null;

      // Do not infer unlabeled action identity from horizontal position.
      // Instagram can expose the comment bubble (or a wrapper/count node)
      // without exposing the paper-plane node. In that case Share via DM
      // must remain null and be skipped rather than guessed.

      const mediaCandidates = nodes.filter(n =>
        /(?:carousel_)?media_group/.test(n.rid) &&
        n.y2 < like.y &&
        n.y2 > 0 &&
        n.x2 > n.x1 && n.y2 > n.y1,
      );
      mediaCandidates.sort((a, b) =>
        (b.x2 - b.x1) * (b.y2 - b.y1) - (a.x2 - a.x1) * (a.y2 - a.y1),
      );
      const media = mediaCandidates[0];
      const { h: actionScreenH } = getScreenSize(serial);
      const mediaToActionGap = media ? like.y - media.y2 : Number.POSITIVE_INFINITY;
      // The action row must belong to a currently visible post. A recycled
      // Like node from the previous post can remain at the top of the dump
      // while the current post's media/action row is below the viewport. If
      // there is no media immediately above this Like node, or the gap is
      // implausibly large, fail closed instead of tapping stale coordinates.
      if (!media || mediaToActionGap > actionScreenH * 0.12) {
        onLog?.(
          `View Feed a11y scan: Like node has no adjacent visible media ` +
          `(likeY=${like.y}, mediaBottom=${media?.y2 ?? "none"}, gap=${Number.isFinite(mediaToActionGap) ? mediaToActionGap : "n/a"}) — skipping`,
        );
        return null;
      }

      // The author must belong to the current post, not merely be any
      // clickable row_feed_photo_profile_name node above the action row.
      // Recycled feed/profile nodes can otherwise win this scan (including
      // the account profile control in the lower-right navigation area).
      const { w: authorScreenW } = getScreenSize(serial);
      const authorCandidates = nodes.filter(n => {
        if (!n.clickable || !n.rid.includes("row_feed_photo_profile_name") || n.y >= like.y) {
          return false;
        }
        if (media) {
          // A feed post's author header is immediately above its media and
          // occupies the same horizontal post bounds. Both values come from
          // the current accessibility dump.
          return n.y < media.y1 && n.x2 > media.x1 && n.x1 < media.x2;
        }
        // If this build omits media_group, retain only author candidates in
        // the dynamically derived central region of the device display.
        return n.x > authorScreenW * 0.15 && n.x < authorScreenW * 0.85;
      });
      // The current post's header is the author node immediately before the
      // current post media. If media is unavailable, the central-region
      // filter above prevents navigation/profile controls from being chosen.
      authorCandidates.sort((a, b) => {
        if (media) {
          const aGap = media.y1 - a.y;
          const bGap = media.y1 - b.y;
          return Math.abs(aGap) - Math.abs(bGap);
        }
        return b.y - a.y;
      });
      const authorNode = authorCandidates[0] ?? null;

      const audioCandidates = nodes.filter(n => {
        if (n.y >= like.y - 20) return false;
        if (/action_bar|like_button|comment_|share_|send_|save_/i.test(n.rid)) return false;
        return /audio|music|sound|song/i.test(n.rid) ||
          /\b(?:audio|music|song|original)\b/i.test(`${n.desc} ${n.text}`);
      });
      audioCandidates.sort((a, b) => {
        const aStrong = /audio|music|sound|song/i.test(a.rid) ? 1 : 0;
        const bStrong = /audio|music|sound|song/i.test(b.rid) ? 1 : 0;
        return bStrong - aStrong || b.y - a.y;
      });
      const audioNode = audioCandidates[0] ?? null;

      return {
        like: pos(like),
        alreadyLiked: /^unlike$/i.test(like.desc),
        comment, shareFeed, shareDm,
        save: saveNode ? pos(saveNode) : null,
        saveLabel: saveNode?.desc || saveNode?.text || "",
        author: authorNode ? { ...pos(authorNode), name: authorNode.desc || authorNode.text || "unknown" } : null,
        audio: audioNode ? pos(audioNode) : null,
        mediaBounds: media ? { x1: media.x1, y1: media.y1, x2: media.x2, y2: media.y2 } : undefined,
        isVideoPost: /SurfaceView|TextureView|VideoView|video_player|row_feed_video/.test(xml),
        xml,
      };
    };
    // Roll session scroll personality once — each run of the feed tool gets
    // its own mix so the distribution never converges to a fixed signature
    // over many sessions. Weights are relative (don't need to sum to 100).
    const feedScrollWeights = consumptionScrollWeights;
    onLog?.(`Feed consumption personality — deliberate drags:${feedScrollWeights.normal + feedScrollWeights.slow + feedScrollWeights.focused} quick corrections:${feedScrollWeights.quick + feedScrollWeights.tapDragRelease} rare flicks:${feedScrollWeights.skim + feedScrollWeights.fast + feedScrollWeights.superSkim}`);
    const feedPersonalityHistory: { lastMode?: string; streak: number } = { streak: 0 };

    for (let i = 0; i < count; i++) {
      if (isCycleAborted(serial)) throw new Error("cycle-aborted");
      const feedTimingStartedAt = Date.now();
      let feedTimingAfterScroll = feedTimingStartedAt;
      let feedTimingAfterMainActions = feedTimingStartedAt;
      let feedTimingAfterSecondaryActions = feedTimingStartedAt;
      // There is no previous content on the first scroll, so a backward
      // personality would have nothing meaningful to revisit. Keep the
      // session personality distribution for later scrolls.
      const sv = rollFeedConsumptionGesture(h, feedPersonalityHistory, serial);
      const feedOverride = serial ? loadInstanceConfigs()[serial]?.devicePrefs?.swipePersonalityOverrides?.[sv.mode] : undefined;
      onLog?.(`[Override] Feed swipe: mode=${sv.mode}, duration=${sv.duration}ms${feedOverride ? `, weight=${feedOverride.weightMin}-${feedOverride.weightMax}, durationRange=${feedOverride.durationMinMs}-${feedOverride.durationMaxMs}ms` : ", Mother Code default"}`);
      feedPersonalityHistory.streak = feedPersonalityHistory.lastMode === sv.mode ? feedPersonalityHistory.streak + 1 : 1;
      feedPersonalityHistory.lastMode = sv.mode;
      const feedModeLabel = sv.mode === "superSkim" ? "super skim" : sv.mode;
      onLog?.(`View Feed ${i + 1}/${count} [${feedModeLabel}]`);
      logger.info({ serial, target: "feed-scroll", mode: sv.mode, from: [x, sv.fromY], to: [x, sv.toY], durationMs: sv.duration }, "[check-feed] swipe");
      await deviceProfileSwipe(serial, { x1: x, y1: sv.fromY, x2: x, y2: sv.toY, durationMs: sv.duration }, "feed-scroll", sv.mode as any);
      await sleepOrAbort(serial, 180);

      // Roll action chances before any post-scroll inspection. A scroll-only
      // iteration must not pay for a UIAutomator dump or foreground check.
      const wantLike = likeChance > 0 && Math.random() < likeChance;
      const wantShareFeed = shareFeedChance > 0 && Math.random() < shareFeedChance;
      const wantShareDm = shareDmChance > 0 && Math.random() < shareDmChance;
      const wantSave = saveChance > 0 && Math.random() < saveChance;
      const wantExpandCaption = captionExpandChance > 0 && Math.random() < captionExpandChance;
      const wantTapAudio = tapAudioChance > 0 && Math.random() < tapAudioChance;
      const wantClickHashtag = clickHashtagChance > 0 && Math.random() < clickHashtagChance;
      const wantClickAuthor = clickAuthorChance > 0 && Math.random() < clickAuthorChance;

      // Single UI dump used for all mid-scroll sheet checks — avoids two
      // sequential dumps (comments check + interstitial scan) that together
      // could eat 5-9 s and leave an unexpected sheet open long enough to
      // auto-dismiss before we react.
      if (wantLike || wantShareFeed || wantShareDm || wantSave || wantExpandCaption) {
        const xml = await android.dumpUi(serial).catch(() => "");
        if (/Add a comment|add a comment|Comments/i.test(xml) && /EditText|class="android\.widget\.EditText"/.test(xml)) {
          // Comments sheet accidentally opened by the swipe — press Back.
          logger.warn({ serial }, "[check-feed] comments sheet opened by scroll — pressing Back to recover");
          onLog?.(`View Feed ${i + 1}/${count}: comments accidentally opened — recovering with Back`);
          await android.pressBack(serial);
          await sleepOrAbort(serial, 600);
        } else if (xml.includes("Hide")) {
          // Post options sheet (⋮ three-dot menu) accidentally opened — press Back.
          // Do NOT run dismissInstagramInterstitials here; it would see stale
          // dismiss-label nodes while the sheet is still open and tap something
          // unintended.
          logger.warn({ serial }, "[check-feed] post options sheet ('Hide') detected mid-scroll — pressing Back to recover");
          onLog?.(`View Feed ${i + 1}/${count}: post options sheet detected — recovering with Back`);
          await android.pressBack(serial);
          await sleepOrAbort(serial, 400);
        } else {
          // No unexpected sheet — run interstitial check with the already-taken
          // dump so we don't do a second round-trip to the device.
          const midPopup = await android.dismissInstagramInterstitials(serial, xml).catch(() => null);
          if (midPopup) {
            logger.info({ serial, dismissed: midPopup }, "[check-feed] dismissed mid-scroll popup");
            onLog?.(`View Feed ${i + 1}/${count}: dismissed mid-scroll popup (${midPopup})`);
            await sleepOrAbort(serial, 400);
          }
        }
      }
      feedTimingAfterScroll = Date.now();

      if (wantLike || wantShareFeed || wantShareDm || wantSave || wantExpandCaption) {
        // This can invoke a 5-second adb dumpsys timeout on a busy device.
        // No action can have navigated away during a scroll-only iteration,
        // so defer the safety check until an action is actually going to be
        // inspected/tapped. This removes the recurring post-scroll stall on
        // iterations where every action roll missed.
        await verifyStillInInstagram();
        const feedbackCard = await android.isFeedbackOrSurveyCard(serial).catch(() => null);
        if (feedbackCard) {
          // This card replaced the post entirely — there is nothing safe to
          // tap for like/share/share-DM. Skip all three and just scroll on.
          logger.info({ serial, marker: feedbackCard }, "[check-feed] skip card detected in place of a post — skipping like/share/share-DM, scrolling past");
          onLog?.(`View Feed ${i + 1}/${count}: skip card detected ("${feedbackCard}") — skipping like/share`);
          if (wantLike) likeFailures++;
        } else {
          // Settle briefly after the scroll animation before dumping the
          // action row. The dump itself is the authoritative readiness check;
          // a long fixed wait here made every rolled action expensive.
          await sleepOrAbort(serial, 350);
          // Look up the real action-bar icons for whatever's on screen right
          // now. The Like button's presence confirms this is a normal post
          // with a normal action bar; each icon's actual position (or
          // absence — a page/profile owner can disable comments and/or
          // shares per post) is resolved fresh per post instead of assuming
          // a fixed layout. See findFeedActionIcons()'s doc comment.
          onLog?.(`View Feed ${i + 1}/${count}: scanning action bar…`);
            // View Feed is intentionally strict and isolated from the other
            // tools: sponsored cards are skipped, and a double-tap may only
            // use a media rectangle confirmed by the live node tree.
            const icons = await scanViewFeedA11y().catch(() => null);
          if (!icons) {
            // No Like button found — this isn't a normal in-feed post right
            // now (Reel suggestion, ad, still animating in from the scroll,
            // or some other card we don't specifically recognize). Skip
            // like AND share AND share-DM rather than firing share taps at
            // coordinates that assume an action bar exists.
            logger.info({ serial, target: "action-bar", matched: false }, "[check-feed] skipped like/share/share-DM — no Like button visible on screen");
            onLog?.(`View Feed ${i + 1}/${count}: no Like button visible — skipping actions (Reel/ad/animating)`);
            if (wantLike) likeFailures++;
          } else {
            const likeBtn = icons.like;
            const iconSummary = `like=(${likeBtn.x},${likeBtn.y}) comment=${icons.comment ? `(${icons.comment.x},${icons.comment.y})` : "n/a"} shareFeed=${icons.shareFeed ? `(${icons.shareFeed.x},${icons.shareFeed.y})` : "n/a"} shareDM=${icons.shareDm ? `(${icons.shareDm.x},${icons.shareDm.y})` : "n/a"}`;
            logger.info({ serial, hasComment: !!icons.comment, hasShareFeed: !!icons.shareFeed, hasShareDm: !!icons.shareDm }, "[check-feed] action-bar icons detected for this post");
            onLog?.(`View Feed ${i + 1}/${count}: action bar found — ${iconSummary}`);

            if (wantLike) {
              // `icons` was just obtained from the live tree and its Like node
              // is already structurally validated. Reusing it avoids a second
              // full UIAutomator dump for the most common Feed action.
              const likeScan = icons;
              if (!likeScan) {
                likeFailures++;
                onLog?.(`View Feed ${i + 1}/${count}: like skipped — current Like node was not confirmed`);
              } else if (likeScan.alreadyLiked) {
                onLog?.(`View Feed ${i + 1}/${count}: already liked — skipping like`);
              } else {
                // ~93 % of likes use a double-tap on the post image — the
                // natural human gesture.  The remaining ~7 % tap the heart
                // icon so the mix of input methods looks organic to
                // Instagram's telemetry.  Stories are excluded from this
                // path (they use their own accessibility-tree like button).
                // A double-tap is allowed only for a normal photo post whose
                // media rectangle was confirmed by the live node tree. Video
                // posts must use the Like node because a media double-tap
                // opens the full-screen player.
                  const useDoubleTap = Math.random() < 0.93 &&
                   !likeScan.isVideoPost &&
                    !(likeScan as any).hasInteractiveMediaOverlay &&
                   !!likeScan.mediaBounds;
                  if ((likeScan as any).hasInteractiveMediaOverlay) {
                    onLog?.(`View Feed ${i + 1}/${count}: interactive media overlay detected — using Like node instead of double-tap`);
                  }
                 let _likeActionSucceeded = false;
                 try {
                  if (useDoubleTap) {
                    // Place the double-tap in the upper quarter of the post
                    // image to stay clear of sponsored-post CTA banners
                    // (e.g. "Shop Now", "Install Now") that Instagram overlays
                    // near the bottom of the media area.
                    //
                    // Primary path: use the media container's real bounding
                    // box (returned by findFeedActionIcons from the same a11y
                    // dump, so no extra dump cost) and tap at a random point
                    // between 25 % and 45 % down from the top of the media.
                    //
                    // No proportional screen-coordinate fallback is allowed in
                    // View Feed. When bounds are unavailable, the branch below
                    // uses the confirmed Like node instead.
                     const mb = likeScan.mediaBounds!;
                     const mediaW = mb.x2 - mb.x1;
                     // Use only the currently visible portion of the
                     // node-confirmed media, ending just above the live Like
                     // row. A recycled container may extend outside the
                     // viewport even though its node bounds look valid.
                     const visibleY1 = Math.max(mb.y1, 0);
                     const visibleY2 = Math.min(mb.y2, likeScan.like.y - 24);
                     const mediaH = visibleY2 - visibleY1;
                    // Keep the gesture inside the node-confirmed media
                    // rectangle. A small central band avoids captions/CTA
                    // overlays while retaining natural variation.
                     const xFraction = 0.45 + Math.random() * 0.10;
                     const yFraction = 0.35 + Math.random() * 0.10;
                    const dtX = Math.round(mb.x1 + mediaW * xFraction);
                    let dtY: number;
                     dtY = Math.round(visibleY1 + mediaH * yFraction);
                    onLog?.(`View Feed ${i + 1}/${count}: double-tap using media bounds (${Math.round(xFraction * 100)}% across, ${Math.round(yFraction * 100)}% down)`);
                     logger.info({ serial, target: "image-double-tap", x: dtX, y: dtY, mediaBoundsUsed: !!likeScan.mediaBounds }, "[check-feed] double-tap like");
                    onLog?.(`View Feed ${i + 1}/${count}: double-tapping image at (${dtX},${dtY})…`);
                     await android.doubleTap(serial, dtX, dtY, (msg: string) => onLog?.(`  ${msg}`));
                  } else {
                    // Safe node-targeted fallback when this is a video post,
                    // the random double-tap roll misses, or the media border
                    // is not exposed by this Instagram build.
                     if (!likeScan.mediaBounds && !likeScan.isVideoPost) {
                      onLog?.(`View Feed ${i + 1}/${count}: media border not confirmed — using Like node instead of guessing a double-tap`);
                    }
                     const jx = likeScan.like.x;
                     const jy = likeScan.like.y;
                    logger.info({ serial, target: "like-button", x: jx, y: jy }, "[check-feed] heart-icon like");
                    onLog?.(`View Feed ${i + 1}/${count}: tapping heart icon at (${jx},${jy})…`);
                    await android.tap(serial, jx, jy);
                   }
                   _likeActionSucceeded = true;
                } catch {
                  likeFailures++;
                  onLog?.(`View Feed ${i + 1}/${count}: ✗ like threw an error`);
                }
           await sleepOrAbort(serial, 300 + Math.floor(Math.random() * 4701));
                const _likeStayedInInstagram = await verifyStillInInstagram();
                 if (_likeActionSucceeded && _likeStayedInInstagram) {
                  likes++;
                  onLog?.(`View Feed ${i + 1}/${count}: ✓ liked`);
                 } else if (_likeActionSucceeded) {
                  likeFailures++;
                  onLog?.(`View Feed ${i + 1}/${count}: like not counted — action left Instagram and was recovered`);
                }
              }
            } else {
              onLog?.(`View Feed ${i + 1}/${count}: like roll missed (chance ${Math.round(likeChance * 100)}%) — scrolling without like`);
            }

            // Share to Feed (repost): tap the circular-arrows icon, find
            // "Repost" in the sheet via accessibility tree, tap it, then
            // dismiss the "You reposted…" confirmation popup by tapping its
            // "Close" button. Using pressBack to cancel (not a swipe) avoids
            // any chance of the gesture crossing the bottom nav bar and
            // triggering the Reels tab. `icons.shareFeed` is this post's
            // real, freshly-measured icon position — null means this post's
            // icon layout couldn't be told apart with confidence (see
            // findFeedActionIcons), so the action is skipped rather than
            // risking a tap on the wrong control (e.g. Comment).
            if (wantShareFeed) {
              if (isCycleAborted(serial)) throw new Error("cycle-aborted");
              await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300));
              const shareFeedScan = await scanViewFeedA11y().catch(() => null);
              const shareFeedNode = shareFeedScan?.shareFeed ?? null;
              if (!shareFeedNode) {
                logger.info({ serial }, "[check-feed] skipped share-to-feed — current repost node not confirmed");
                onLog?.(`View Feed ${i + 1}/${count}: skipped repost — current share-to-feed node not confirmed`);
              } else {
              const shareFeedIconX = shareFeedNode.x, rowY = shareFeedNode.y;
              if (isCycleAborted(serial)) throw new Error("cycle-aborted");
              try {
                // Capture the icon's own label before tapping — see the
                // same-name guard in runProfileBrowsingSequence for why:
                // some accounts' Instagram build reposts instantly on a
                // single tap with NO confirmation sheet, relabelling the
                // SAME icon in place (e.g. "Repost" -> "Remove
                // repost"/"Reposted") instead of showing a separate sheet
                // button. Without this check, findButtonByLabel("Repost")
                // matches that same relabelled icon via substring and this
                // code taps it AGAIN — undoing the repost it just made.
                const beforeCd = await android.getContentDescNear(serial, shareFeedIconX, rowY).catch(() => null);
                onLog?.(`View Feed ${i + 1}/${count}: tapping share-to-feed icon at (${shareFeedIconX},${rowY})…`);
                await android.tap(serial, shareFeedIconX, rowY);
                logger.info({ serial, x: shareFeedIconX, y: rowY, beforeCd }, "[check-feed] tapped share-to-feed icon");
                await sleepOrAbort(serial, 400); // wait for repost sheet

                const repostBtn = await android.findButtonByLabel(serial, "Repost").catch(() => null);
                // Use a 60 px tolerance (not 15). The action-bar icon's a11y
                // bounds-centre can shift by ~30 px between measurements due
                // to layout timing, so 15 px was too tight and caused a
                // second tap on the original icon (unsharing what was just
                // shared). A genuine sheet "Repost" button always appears at
                // screen centre (x ≈ 540+), well beyond 60 px from the icon.
                const _rDx = repostBtn ? Math.abs(repostBtn.x - shareFeedIconX) : 0;
                const _rDy = repostBtn ? Math.abs(repostBtn.y - rowY) : 0;
                const sameCoords = !!repostBtn && _rDx < 60 && _rDy < 60;
                if (sameCoords) logger.info({ serial, repostBtn, shareFeedIconX, rowY, dx: _rDx, dy: _rDy }, "[check-feed] 'Repost' node within 60 px of icon — treated as same icon (single-tap path)");
                if (repostBtn && !sameCoords) {
                  onLog?.(`View Feed ${i + 1}/${count}: Repost sheet opened — tapping Repost at (${repostBtn.x},${repostBtn.y})…`);
                  await android.tap(serial, repostBtn.x, repostBtn.y);
                  logger.info({ serial }, "[check-feed] tapped Repost in sheet");
           await sleepOrAbort(serial, 300 + Math.floor(Math.random() * 4701));
                  // "You reposted X's post" popup appears after the first
                  // repost — find its blue "Close" button via accessibility
                  // tree and tap it.
                  const closeBtn = await android.findButtonByLabel(serial, "Close").catch(() => null);
                  if (closeBtn) {
                    await android.tap(serial, closeBtn.x, closeBtn.y);
                    logger.info({ serial }, "[check-feed] dismissed repost confirmation popup (Close)");
                    onLog?.(`View Feed ${i + 1}/${count}: dismissed "You reposted" popup`);
                    await sleepOrAbort(serial, 150);
                  }
                  sharesFeed++;
                  onLog?.(`View Feed ${i + 1}/${count}: ✓ reposted to feed (total reposts: ${sharesFeed})`);
                } else if (sameCoords) {
                  // The a11y tree returned a "Repost"-labelled node at the same
                  // position as the icon we just tapped (single-tap repost path
                  // — no confirmation sheet). Don't re-check whether the label
                  // changed: the tree dump is unreliable (~90% false-negatives
                  // reported), so we accept the tap as-is regardless of what the
                  // dump says happened afterward. Do NOT press Back — that
                  // navigates away from the feed.
                  logger.info({ serial, beforeCd }, "[check-feed] sameCoords repost tap accepted without label re-check");
                  onLog?.(`View Feed ${i + 1}/${count}: repost tapped (single-tap path, no sheet check)`);
                  sharesFeed++;
                } else {
                  // No Repost button found in the dump after the tap. The dump is
                  // unreliable; the repost sheet may have opened and been dismissed
                  // before the dump ran, or the button may be outside the capture
                  // window. Accept the tap and continue — do NOT press Back.
                  logger.info({ serial }, "[check-feed] no Repost-labelled node found after tap — accepting tap, not pressing Back");
                  onLog?.(`View Feed ${i + 1}/${count}: repost tap sent (sheet not confirmed in dump — continuing)`);
                }
                await verifyStillInInstagram();
              } catch (e: any) { if (e?.message === "cycle-aborted") throw e; /* else non-fatal */ }
              }
            }

            // Share via DM: tap the paper-plane icon to open the DM picker,
            // then close it with Back (registers the share-intent tap in a
            // human-looking way without needing to know a recipient).
            // pressBack is intentional — a swipe-dismiss risks crossing the
            // bottom nav bar and accidentally triggering the Reels tab.
            // `icons.shareDm` is this post's real, freshly-measured icon
            // position — null means it couldn't be identified with
            // confidence (disabled by the poster, or ambiguous layout — see
            // findFeedActionIcons), so the action is skipped.
            if (wantShareDm) {
              // ── View Feed — Share via DM (isolated; not shared with any other tool) ──
              const _cfPfx = `View Feed ${i + 1}/${count}`;
              let _cfDmSent = false;
              try {
                if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300));
                const dmScan = await scanViewFeedA11y().catch(() => null);
                const dmNode = dmScan?.shareDm ?? null;
                if (!dmNode) {
                  onLog?.(`${_cfPfx}: share aborted — current paper-plane node not confirmed`);
                  await verifyStillInInstagram();
                } else {
                onLog?.(`${_cfPfx}: tapping share-via-DM icon at (${dmNode.x},${dmNode.y})…`);
                await android.tap(serial, dmNode.x, dmNode.y);
             await sleepOrAbort(serial, 1500 + Math.floor(Math.random() * 3501));
                onLog?.(`${_cfPfx}: confirming share sheet opened and picking DM recipient…`);
                let _cfScan = await android.confirmAndScanShareSheet(serial, onLog).catch(() => null);
                if (!_cfScan?.sheetOpen) {
                  onLog?.(`${_cfPfx}: share sheet not yet visible — waiting 1500ms and retrying…`);
                  await sleepOrAbort(serial, 1500);
                  _cfScan = await android.confirmAndScanShareSheet(serial, onLog).catch(() => null);
                }
                if (!_cfScan?.sheetOpen) {
                  logger.warn({ serial }, "[check-feed] share sheet not confirmed open after retry — closing and skipping DM");
                  onLog?.(`${_cfPfx}: share aborted — share sheet did not open`);
                  await android.pressBack(serial);
                  await sleepOrAbort(serial, 200);
                } else {
                  const _cfSendBtn0 = _cfScan.sendBtn ?? null;
                  if (_cfScan.preSelectedRecipients && _cfScan.preSelectedRecipients.length > 0) {
                    onLog?.(`${_cfPfx}: deselecting ${_cfScan.preSelectedRecipients.length} pre-selected recipient(s) from prior run…`);
                    for (const _r of _cfScan.preSelectedRecipients) {
                      onLog?.(`${_cfPfx}: deselecting${(_r as any).name ? ` (${(_r as any).name})` : ""} at (${_r.x},${_r.y})`);
                      await android.tap(serial, _r.x, _r.y);
                      await sleepOrAbort(serial, 400);
                    }
                  }
                  const _cfRecipients = _cfScan.recipients ?? [];
                  if (_cfRecipients.length === 0) {
                    await android.pressBack(serial);
                    logger.warn({ serial }, "[check-feed] no recipient found — closed share sheet without sending");
                    onLog?.(`${_cfPfx}: share skipped — no recipient avatars found (closed without sending)`);
                  } else {
                    const _cfLast = _viewFeedLastDmRecipient.get(serial);
                    const _cfPool = _cfLast ? _cfRecipients.filter((r: any) => !(r.x === _cfLast.x && r.y === _cfLast.y)) : _cfRecipients;
                    const _cfCands = _cfPool.length > 0 ? _cfPool : _cfRecipients;
                    const _cfPick = _cfCands[Math.floor(Math.random() * _cfCands.length)];
                    _viewFeedLastDmRecipient.set(serial, { x: _cfPick.x, y: _cfPick.y });
                    onLog?.(`${_cfPfx}: tapping recipient at (${_cfPick.x},${_cfPick.y})${(_cfPick as any).name ? ` (${(_cfPick as any).name})` : ""}`);
                    await android.tap(serial, _cfPick.x, _cfPick.y);
                    await sleepOrAbort(serial, 800);
                    const _cfIsOpen = async () => {
                      const _x = await android.dumpUi(serial).catch(() => "");
                      // "Add to story" removed — the home feed's story tray has
                      // desc="Add to story" on the reel badge, so it's present in the
                      // tree even after the share sheet closes, causing a false-positive
                      // that made the code think the sheet was still open and press Back.
                      return _x.includes("direct_private_share") || _x.includes("grid_view_pog_avatar_view") ||
                             _x.includes("android.widget.EditText") || _x.includes("Copy link");
                    };
                    // Always fresh lookup after recipient tap — direct_send_button_multi_select
                    // only appears once a recipient is selected, so _cfSendBtn0 (from the
                    // pre-selection scan) is stale and points to the wrong element.
                    const _cfSb = await android.findButtonByLabel(serial, "Send").catch(() => null);
                    if (_cfSb) {
                      await android.tap(serial, _cfSb.x, _cfSb.y);
                      // 1500ms — sheet animates closed after Send; 300ms was too
                      // short, sheet still visible at check time, code pressed Back
                      // and cancelled the DM (confirmed from dump 16 Jul 2026).
                      await sleepOrAbort(serial, 1500);
                      if (!(await _cfIsOpen())) {
                        _cfDmSent = true;
                        logger.info({ serial }, "[check-feed] shared post via DM — Send tapped");
                        onLog?.(`${_cfPfx}: ✓ shared via DM — Send tapped`);
                        await sleepOrAbort(serial, 300);
                      } else {
                        logger.info({ serial }, "[check-feed] Send tapped but sheet still open — pressing Back to close");
                        onLog?.(`${_cfPfx}: Send tapped but share sheet still open after wait — pressing Back`);
                        await android.pressBack(serial);
                        await sleepOrAbort(serial, 200);
                      }
                    } else if (!(await _cfIsOpen())) {
                      _cfDmSent = true;
                      logger.info({ serial }, "[check-feed] share sheet already closed — DM likely sent by recipient tap");
                      onLog?.(`${_cfPfx}: ✓ shared via DM — sheet auto-dismissed (sent by recipient tap)`);
                      await sleepOrAbort(serial, 200);
                    } else {
                      // Never guess the Send position in View Feed.  The
                      // sheet is still open, so close it and fail closed.
                      onLog?.(`${_cfPfx}: Send node not found via accessibility — closing without sending`);
                      await android.pressBack(serial);
                      await sleepOrAbort(serial, 200);
                    }
                  }
                }
                }
              } catch (e: any) {
                if (e?.message === "cycle-aborted") throw e;
                onLog?.(`${_cfPfx}: share-via-DM error — ${e?.message}`);
              }
                if (_cfDmSent) sharesDm++;
              await verifyStillInInstagram();
            }

            // ── Save Post (bookmark / ribbon icon) ────────────────────────
            // Taps the ribbon icon (row_feed_button_save / "Add to Saved")
            // identified by findFeedActionIcons. After the tap Instagram
            // shows a small "Save to collection?" bottom sheet. We dismiss
            // it with a tap in the top-25% of the screen — far above any
            // collection UI — which is safe on every layout because
            // Instagram never puts any interactive control in that region
            // while the sheet is open.
            if (wantSave) {
              if (isCycleAborted(serial)) throw new Error("cycle-aborted");
              await sleepOrAbort(serial, 200 + Math.round(Math.random() * 200));
              const saveScan = await scanViewFeedA11y().catch(() => null);
              const _saveBtn = saveScan?.save ?? null;
              if (!saveScan || !_saveBtn) {
                logger.info({ serial }, "[check-feed] save button not found on this post — skipping save");
                onLog?.(`View Feed ${i + 1}/${count}: save skipped — ribbon icon not found on this post`);
              } else if (/remove from saved/i.test(saveScan.saveLabel)) {
                onLog?.(`View Feed ${i + 1}/${count}: already saved — skipping save`);
              } else {
                try {
                  if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                  onLog?.(`View Feed ${i + 1}/${count}: tapping save (ribbon) icon at (${_saveBtn.x},${_saveBtn.y})…`);
                  await android.tap(serial, _saveBtn.x, _saveBtn.y);
                 await sleepOrAbort(serial, 600 + Math.floor(Math.random() * 4401));
                   // Instagram may show a first-save collection sheet on
                   // accounts with no existing collections. Detect it with a
                   // fresh dump and dismiss only through the shared,
                   // randomized top-scrim handler.
                  let _fsSaveXml = await android.dumpUi(serial).catch(() => "");
                   if (await dismissSaveCollectionPrompt(serial, _fsSaveXml, onLog, `View Feed ${i + 1}/${count}`)) {
                    _fsSaveXml = await android.dumpUi(serial).catch(() => "");
                  }
                  const _saveStayedInInstagram = await verifyStillInInstagram();
                  const _saveAfter = await scanViewFeedA11y().catch(() => null);
                  const _saveConfirmed = /remove from saved/i.test(_saveAfter?.saveLabel ?? "");
                  if (_saveStayedInInstagram && _saveConfirmed) {
                    saves++;
                    logger.info({ serial }, "[check-feed] saved post via ribbon icon");
                    onLog?.(`View Feed ${i + 1}/${count}: ✓ post saved`);
                  } else if (_saveStayedInInstagram) {
                    onLog?.(`View Feed ${i + 1}/${count}: save tap completed but saved state was not confirmed — not counted`);
                  } else {
                    onLog?.(`View Feed ${i + 1}/${count}: save not counted — action left Instagram and was recovered`);
                  }
                } catch (e: any) {
                  if (e?.message === "cycle-aborted") throw e;
                  onLog?.(`View Feed ${i + 1}/${count}: save error — ${e?.message}`);
                }
              }
            }

            // ── Expand Caption ──────────────────────────────────────────
            // Taps the truncated-caption "more" link to expand it in place.
            // Instagram renders this as a TextView; its text attribute is
            // "more" (exact, lowercase).  Some builds also set content-desc
            // to the same value.  We check both so either attribute works.
            // "More actions for this post" (the ⋮ button) won't match because
            // it's a longer phrase — the contains() check is safe.
            // Uses its own fresh dump so it works independently of the
            // action-bar scan above.
            //
            // IMPORTANT: must also require class="android.widget.TextView".
            // Sponsored posts render a full-width CTA button ("Visit Instagram
            // profile", "Learn More", etc.) that can carry content-desc="more"
            // in Instagram's a11y tree.  That button is class="android.widget.Button"
            // — not a TextView — and tapping it opens the advertiser's profile
            // within Instagram (same package, so verifyStillInInstagram() won't
            // catch it), breaking every subsequent action in the cycle.
            if (wantExpandCaption) {
              try {
                if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                const _ecXml = await android.dumpUi(serial).catch(() => "");
                // Split on '<node ' and check each segment for text="more"
                // OR content-desc="more" (exact, lowercase in both cases).
                // Using includes() instead of regex avoids backslash issues
                // and is immune to attribute ordering variations.
                // Also require class="android.widget.TextView" — caption "more"
                // links are always TextViews; sponsored-post CTA buttons are
                // android.widget.Button and must be excluded.
                let _ecTapped = false;
                for (const _ecSeg of _ecXml.split("<node ")) {
                  if (_ecTapped) break;
                  // Instagram renders the truncated-caption link as text="more"
                  // on most builds, but some versions capitalise it as "More".
                  // Lower-case the segment for the attribute check so both pass.
                  // The original segment is still used for bounds extraction.
                  const _ecLower = _ecSeg.toLowerCase();
                  const _hasMoreText = _ecLower.includes('text="more"');
                  const _hasMoreDesc = _ecLower.includes('content-desc="more"');
                  if (!_hasMoreText && !_hasMoreDesc) continue;
                  // Reject CTA buttons on sponsored posts — they are Buttons, not TextViews.
                  if (!_ecLower.includes('class="android.widget.textview"')) continue;
                  const _ecBb = _ecSeg.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
                  if (!_ecBb) continue;
                  const _ecX = Math.round((parseInt(_ecBb[1]) + parseInt(_ecBb[3])) / 2);
                  const _ecY = Math.round((parseInt(_ecBb[2]) + parseInt(_ecBb[4])) / 2);
                  onLog?.(`View Feed ${i + 1}/${count}: tapping caption "more" at (${_ecX},${_ecY}) [matched via ${_hasMoreText ? "text" : "content-desc"}]`);
                  await android.tap(serial, _ecX, _ecY);
                  await verifyStillInInstagram();
                  // Dwell after expanding — simulate reading the caption.
                  // 2–10 s, rolled fresh each time so the duration looks human.
                  const _ecDwellMs = 2000 + Math.round(Math.random() * 8000);
                  onLog?.(`View Feed ${i + 1}/${count}: ✓ caption expanded — dwelling ${(_ecDwellMs / 1000).toFixed(1)}s`);
                  await sleepOrAbort(serial, _ecDwellMs);
                  captionExpands++;
                  _ecTapped = true;
                }
                if (!_ecTapped) {
                  onLog?.(`View Feed ${i + 1}/${count}: caption "more" not visible — skipping expand`);
                }
              } catch (e: any) {
                if (e?.message === "cycle-aborted") throw e;
                onLog?.(`View Feed ${i + 1}/${count}: expand caption error — ${e?.message}`);
              }
            }
          }
        }
      } else {
        onLog?.(`View Feed ${i + 1}/${count}: no actions rolled this scroll`);
      }
      feedTimingAfterMainActions = Date.now();

      // ── Tap Audio (music/song page) — independent of action bar ──────
      // On posts that carry an audio affordance (rotating disc icon at the
      // bottom-left of the media), tapping it opens the song's page — a
      // grid of other posts using the same track.  We scroll that grid
      // briefly and return to the feed with Back.  The roll is skipped
      // silently when no audio affordance is detectable on the current post.
      // The Meta Edits promotional popup ("Level up your edits") is dismissed
      // with one Back press; if a second tap still triggers it the roll is
      // aborted cleanly.  No retry loops — per-project rules.
      if (wantTapAudio) {
        try {
          if (isCycleAborted(serial)) throw new Error("cycle-aborted");
          await sleepOrAbort(serial, 300);
          const _atScan = await scanViewFeedA11y().catch(() => null);
          const _atNode = _atScan?.audio ?? null;

          if (!_atNode) {
            onLog?.(`View Feed ${i + 1}/${count}: tap-audio rolled but no audio affordance on this post — skipping`);
          } else {
            onLog?.(`View Feed ${i + 1}/${count}: tapping audio affordance at (${_atNode.x},${_atNode.y})…`);
            await android.tap(serial, _atNode.x, _atNode.y);
             await sleepOrAbort(serial, 1000 + Math.floor(Math.random() * 4001));
            await verifyStillInInstagram();

            const _atXml2 = await android.dumpUi(serial).catch(() => "");
            let _atOnSongPage = false;

            if (_atXml2.toLowerCase().includes("level up")) {
              // Meta Edits promotional popup — dismiss and try once more.
              onLog?.(`View Feed ${i + 1}/${count}: Meta Edits popup detected — dismissing and retrying…`);
              await android.pressBack(serial);
               await sleepOrAbort(serial, 600 + Math.floor(Math.random() * 4401));
              await android.tap(serial, _atNode.x, _atNode.y);
               await sleepOrAbort(serial, 1000 + Math.floor(Math.random() * 4001));
              await verifyStillInInstagram();
              const _atXml3 = await android.dumpUi(serial).catch(() => "");
              if (_atXml3.toLowerCase().includes("level up")) {
                onLog?.(`View Feed ${i + 1}/${count}: Meta Edits popup still showing after retry — aborting audio tap`);
                await android.pressBack(serial);
                 await sleepOrAbort(serial, 400 + Math.floor(Math.random() * 4601));
              } else {
                _atOnSongPage = true;
              }
            } else if (_atXml2.toLowerCase().includes("view song details")) {
              // Bottom sheet — tap "View song details" to proceed to the page.
              onLog?.(`View Feed ${i + 1}/${count}: "View song details" sheet detected — tapping…`);
              let _atSheetTapped = false;
              for (const _atSeg2 of _atXml2.split("<node ")) {
                const _atT2 = (_atSeg2.match(/\btext="([^"]*)"/) ?? [])[1] ?? "";
                const _atD2 = (_atSeg2.match(/content-desc="([^"]*)"/) ?? [])[1] ?? "";
                if (!(_atT2.toLowerCase().includes("view song details") || _atD2.toLowerCase().includes("view song details"))) continue;
                const _atBb2 = _atSeg2.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
                if (!_atBb2) break;
                const _atX2 = Math.round((parseInt(_atBb2[1]) + parseInt(_atBb2[3])) / 2);
                const _atY2 = Math.round((parseInt(_atBb2[2]) + parseInt(_atBb2[4])) / 2);
                onLog?.(`View Feed ${i + 1}/${count}: tapping "View song details" at (${_atX2},${_atY2})…`);
                await android.tap(serial, _atX2, _atY2);
                 await sleepOrAbort(serial, 1200 + Math.floor(Math.random() * 3801));
                await verifyStillInInstagram();
                _atOnSongPage = true;
                _atSheetTapped = true;
                break;
              }
              if (!_atSheetTapped) {
                // Sheet visible but couldn't resolve the node — press Back.
                onLog?.(`View Feed ${i + 1}/${count}: "View song details" node not found in sheet — pressing Back`);
                await android.pressBack(serial);
                   await sleepOrAbort(serial, 400 + Math.floor(Math.random() * 4601));
              }
            } else {
              // Navigated directly to the song/audio page.
              _atOnSongPage =
                _atXml2.includes("audio_page") ||
                _atXml2.includes("music_page") ||
                _atXml2.includes("clips_audio") ||
                _atXml2.includes("audio_browser") ||
                /song|original audio|music/i.test(_atXml2);
              if (!_atOnSongPage) {
                onLog?.(`View Feed ${i + 1}/${count}: audio tap did not open a confirmed song page — pressing Back`);
                await android.pressBack(serial);
                await sleepOrAbort(serial, 400);
              }
            }

            if (_atOnSongPage) {
              // Scroll the song grid 1–20 times with a 1–10% per-scroll tap chance.
              const _atScrolls = 1 + Math.floor(Math.random() * 20);
              const _atTapChance = 0.01 + Math.random() * 0.09; // 1–10%
              onLog?.(`View Feed ${i + 1}/${count}: on song page — scrolling ${_atScrolls}x (tap chance ${Math.round(_atTapChance * 100)}%)…`);
              const { w: _atW, h: _atH } = getScreenSize(serial);
              let _atDidTap = false;
              for (let _atS = 0; _atS < _atScrolls; _atS++) {
                if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                const _atSY1 = Math.round(_atH * 0.75);
                const _atSY2 = Math.round(_atH * 0.30);
                const _atSX  = Math.round(_atW / 2);
                const _atDur = 300 + Math.round(Math.random() * 400);
                await deviceProfileSwipe(serial, { x1: _atSX, y1: _atSY1, x2: _atSX, y2: _atSY2, durationMs: _atDur }, "feed-audio-profile-scroll");
                 await sleepOrAbort(serial, 280 + Math.floor(Math.random() * 4721));
                if (!_atDidTap && Math.random() < _atTapChance) {
                  // Tap a random clickable item in the content area.
                  const _atGXml = await android.dumpUi(serial).catch(() => "");
                  const _atItems: { x: number; y: number }[] = [];
                  for (const _atGSeg of _atGXml.split("<node ")) {
                    const _atGBb = _atGSeg.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
                    if (!_atGBb) continue;
                    const _gX = Math.round((parseInt(_atGBb[1]) + parseInt(_atGBb[3])) / 2);
                    const _gY = Math.round((parseInt(_atGBb[2]) + parseInt(_atGBb[4])) / 2);
                    // Only items in the main content zone — skip top nav / bottom nav.
                    if (_gY > _atH * 0.12 && _gY < _atH * 0.92) _atItems.push({ x: _gX, y: _gY });
                  }
                  if (_atItems.length > 0) {
                    const _atPicked = _atItems[Math.floor(Math.random() * _atItems.length)];
                    onLog?.(`View Feed ${i + 1}/${count}: song-page tap at (${_atPicked.x},${_atPicked.y})…`);
                    await android.tap(serial, _atPicked.x, _atPicked.y);
                     await sleepOrAbort(serial, 1000 + Math.floor(Math.random() * 4001));
                    await verifyStillInInstagram();
                    // Press Back once to return from the post (or wherever the tap landed).
                    await android.pressBack(serial);
                     await sleepOrAbort(serial, 600 + Math.floor(Math.random() * 4401));
                    await verifyStillInInstagram();
                    _atDidTap = true;
                    break; // stop scrolling after a tap
                  }
                }
              }
              // Return to the feed — one Back press from the song/audio page.
              onLog?.(`View Feed ${i + 1}/${count}: returning from song page…`);
              await android.pressBack(serial);
               await sleepOrAbort(serial, 700 + Math.floor(Math.random() * 4301));
              await verifyStillInInstagram();
              audioTaps++;
              onLog?.(`View Feed ${i + 1}/${count}: ✓ audio page visited`);
            }
          }
        } catch (e: any) {
          if (e?.message === "cycle-aborted") throw e;
          onLog?.(`View Feed ${i + 1}/${count}: tap-audio error — ${e?.message}`);
        }
      }

      // ── Click Hashtag (browse hashtag grid page) ─────────────────────
      // Finds hashtag buttons in the visible caption, taps one at random
      // to open the hashtag grid page, scrolls 1–10 times, and has a
      // 1–10% per-scroll chance to tap a random post on the grid.
      // If a post was tapped, presses Back twice (post → grid → feed);
      // otherwise presses Back once (grid → feed).
      // The roll is skipped when no hashtag buttons are visible (only
      // the audio tap runs on posts that have hashtags, not all posts do).
      if (wantClickHashtag) {
        try {
          if (isCycleAborted(serial)) throw new Error("cycle-aborted");
          await sleepOrAbort(serial, 300);
          const _chXml = await android.dumpUi(serial).catch(() => "");
          // Collect hashtag button nodes from the caption area — they are
          // android.widget.Button elements whose content-desc starts with '#'.
          // Exclude the action bar (like/comment/share) and non-caption nodes
          // by checking the '#' prefix on the desc attribute.
          const _chHashtags: { x: number; y: number; tag: string }[] = [];
          for (const _chSeg of _chXml.split("<node ")) {
            const _chDesc = (_chSeg.match(/content-desc="([^"]*)"/) ?? [])[1] ?? "";
            if (!_chDesc.startsWith("#")) continue;
            const _chClass = (_chSeg.match(/class="([^"]*)"/) ?? [])[1] ?? "";
            // Only Button nodes — a11y assigns class Button to caption hashtag links.
            if (!_chClass.includes("Button")) continue;
            const _chBb = _chSeg.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
            if (!_chBb) continue;
            const _chX = Math.round((parseInt(_chBb[1]) + parseInt(_chBb[3])) / 2);
            const _chY = Math.round((parseInt(_chBb[2]) + parseInt(_chBb[4])) / 2);
            // Only nodes in the caption area — below the action bar (> 40% height).
            if (_chY < h * 0.40) continue;
            _chHashtags.push({ x: _chX, y: _chY, tag: _chDesc });
          }

          if (_chHashtags.length === 0) {
            onLog?.(`View Feed ${i + 1}/${count}: click-hashtag rolled but no hashtag buttons visible — skipping`);
          } else {
            const _chPick = _chHashtags[Math.floor(Math.random() * _chHashtags.length)];
            onLog?.(`View Feed ${i + 1}/${count}: tapping hashtag "${_chPick.tag}" at (${_chPick.x},${_chPick.y})…`);
            await android.tap(serial, _chPick.x, _chPick.y);
            await sleepOrAbort(serial, 1500, "accountSwitching");
            await verifyStillInInstagram();

            // Confirm we arrived at the hashtag grid — look for the grid card layout.
            const _chGridXml = await android.dumpUi(serial).catch(() => "");
            const _chOnGrid = _chGridXml.includes("grid_card_layout_container") ||
              _chGridXml.includes("tabbed_pager") ||
              _chGridXml.includes("swipeable_tab_view_pager");

            if (!_chOnGrid) {
              onLog?.(`View Feed ${i + 1}/${count}: hashtag grid not confirmed — pressing Back and continuing`);
              await android.pressBack(serial);
              await sleepOrAbort(serial, 600);
            } else {
              // Scroll the hashtag grid 1–10 times; 1–10% per-scroll tap chance.
              const _chScrolls = 1 + Math.floor(Math.random() * 10);
              const _chTapChance = 0.01 + Math.random() * 0.09; // 1–10%
              onLog?.(`View Feed ${i + 1}/${count}: on hashtag grid "${_chPick.tag}" — scrolling ${_chScrolls}x (tap chance ${Math.round(_chTapChance * 100)}%)…`);
              const { w: _chW, h: _chH } = getScreenSize(serial);
              let _chDidTapPost = false;
              for (let _chS = 0; _chS < _chScrolls; _chS++) {
                if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                const _chSY1 = Math.round(_chH * 0.75);
                const _chSY2 = Math.round(_chH * 0.30);
                const _chSX  = Math.round(_chW / 2);
                const _chDur = 300 + Math.round(Math.random() * 400);
                await deviceProfileSwipe(serial, { x1: _chSX, y1: _chSY1, x2: _chSX, y2: _chSY2, durationMs: _chDur }, "feed-hashtag-profile-scroll");
                 await sleepOrAbort(serial, 280 + Math.floor(Math.random() * 4721));
                if (!_chDidTapPost && Math.random() < _chTapChance) {
                  // Tap a random grid post using the grid_card_layout_container nodes.
                  const _chPXml = await android.dumpUi(serial).catch(() => "");
                  const _chPosts: { x: number; y: number }[] = [];
                  for (const _chPSeg of _chPXml.split("<node ")) {
                    const _chRid = (_chPSeg.match(/resource-id="([^"]*)"/) ?? [])[1] ?? "";
                    // Match grid card or image_button nodes inside the grid.
                    if (!_chRid.includes("grid_card_layout_container") && !_chRid.includes("image_button")) continue;
                    const _chPBb = _chPSeg.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
                    if (!_chPBb) continue;
                    const _chPX = Math.round((parseInt(_chPBb[1]) + parseInt(_chPBb[3])) / 2);
                    const _chPY = Math.round((parseInt(_chPBb[2]) + parseInt(_chPBb[4])) / 2);
                    // Stay within the main content zone — skip nav bars.
                    if (_chPY > _chH * 0.10 && _chPY < _chH * 0.92) _chPosts.push({ x: _chPX, y: _chPY });
                  }
                  if (_chPosts.length > 0) {
                    const _chPostPick = _chPosts[Math.floor(Math.random() * _chPosts.length)];
                    onLog?.(`View Feed ${i + 1}/${count}: tapping grid post at (${_chPostPick.x},${_chPostPick.y})…`);
                    await android.tap(serial, _chPostPick.x, _chPostPick.y);
                     await sleepOrAbort(serial, 1200 + Math.floor(Math.random() * 3801));
                    await verifyStillInInstagram();
                    // Press Back once to return from the post to the hashtag grid.
                    await android.pressBack(serial);
                     await sleepOrAbort(serial, 700 + Math.floor(Math.random() * 4301));
                    await verifyStillInInstagram();
                    _chDidTapPost = true;
                    break; // stop scrolling after a tap
                  }
                }
              }
              // Return to the feed — one Back press from the hashtag grid.
              onLog?.(`View Feed ${i + 1}/${count}: returning from hashtag grid…`);
              await android.pressBack(serial);
               await sleepOrAbort(serial, 700 + Math.floor(Math.random() * 4301));
              await verifyStillInInstagram();
              hashtagTaps++;
              onLog?.(`View Feed ${i + 1}/${count}: ✓ hashtag grid visited (${_chPick.tag}${_chDidTapPost ? ", tapped a post" : ""})`);
            }
          }
        } catch (e: any) {
          if (e?.message === "cycle-aborted") throw e;
          onLog?.(`View Feed ${i + 1}/${count}: click-hashtag error — ${e?.message}`);
        }
      }

      // ── Click Author (visit post author's profile) ───────────────────
      // Taps row_feed_photo_profile_name — the author name label that sits
      // immediately to the right of the avatar bubble in every feed post
      // header.  Present on single-author posts and collab posts alike
      // (collabs show both names combined; the tap opens the first-listed
      // author's profile, which is the one visually beside the avatar ring).
      // Once on the profile, scrolls 1–10 times then presses Back to return.
      if (wantClickAuthor) {
        try {
          if (isCycleAborted(serial)) throw new Error("cycle-aborted");
           await sleepOrAbort(serial, 300 + Math.floor(Math.random() * 4701));
          const _caScan = await scanViewFeedA11y().catch(() => null);
          const _caNode = _caScan?.author ?? null;
          if (!_caNode) {
            onLog?.(`View Feed ${i + 1}/${count}: click-author rolled but no profile name button visible — skipping`);
          } else {
            onLog?.(`View Feed ${i + 1}/${count}: tapping author "${_caNode.name}" at (${_caNode.x},${_caNode.y})…`);
            await android.tap(serial, _caNode.x, _caNode.y);
             await sleepOrAbort(serial, 1500 + Math.floor(Math.random() * 3501));
            await verifyStillInInstagram();
            // Post-tap verification — dump the UI and confirm we actually
            // landed on a profile page before doing anything else.
            // Without this the code stamps log entries as if everything is
            // working even when the tap missed (stale node coords, feed was
            // still animating, etc.).
            // A profile page always has at least one of: Follow / Following /
            // Unfollow / Message buttons, a profile_header node, or an
            // action_bar_title node.  If none are present the feed is still
            // on screen — the tap went astray.
            const _caChkXml = await android.dumpUi(serial).catch(() => "");
            const _caOnProfile =
              _caChkXml.includes('text="Follow"')    || _caChkXml.includes('content-desc="Follow"') ||
              _caChkXml.includes('text="Following"') || _caChkXml.includes('content-desc="Following"') ||
              _caChkXml.includes('text="Unfollow"')  || _caChkXml.includes('content-desc="Unfollow"') ||
              _caChkXml.includes('text="Message"')   || _caChkXml.includes('content-desc="Message"') ||
              _caChkXml.includes('profile_header')   ||
              _caChkXml.includes('action_bar_title');
            if (!_caOnProfile) {
              onLog?.(`View Feed ${i + 1}/${count}: click-author — tap did not open a profile (feed still visible) — skipping`);
            } else {
              // Confirmed on profile — scroll it.
              const _caScrolls = 1 + Math.floor(Math.random() * 3);
              onLog?.(`View Feed ${i + 1}/${count}: on author profile "${_caNode.name}" — scrolling ${_caScrolls}x…`);
              const { w: _caW, h: _caH } = getScreenSize(serial);
              for (let _caS = 0; _caS < _caScrolls; _caS++) {
                if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                const _caSY1 = Math.round(_caH * 0.75);
                const _caSY2 = Math.round(_caH * 0.30);
                const _caDur = 350 + Math.round(Math.random() * 350);
                await deviceProfileSwipe(serial, { x1: Math.round(_caW / 2), y1: _caSY1, x2: Math.round(_caW / 2), y2: _caSY2, durationMs: _caDur }, "feed-author-profile-scroll");
                const _caRenderWaitMs = 2500 + Math.round(Math.random() * 7500);
                await sleepOrAbort(serial, _caRenderWaitMs);
              }
              // Return to the feed — one Back press from the author's profile.
              onLog?.(`View Feed ${i + 1}/${count}: returning from author profile…`);
              await android.pressBack(serial);
                 await sleepOrAbort(serial, 700 + Math.floor(Math.random() * 4301));
              await verifyStillInInstagram();
              authorVisits++;
              onLog?.(`View Feed ${i + 1}/${count}: ✓ author profile visited (${_caNode.name})`);
            }
          }
        } catch (e: any) {
          if (e?.message === "cycle-aborted") throw e;
          onLog?.(`View Feed ${i + 1}/${count}: click-author error — ${e?.message}`);
        }
      }

      feedTimingAfterSecondaryActions = Date.now();

      if (i < count - 1) {
        const actionTaken = wantLike || wantShareFeed || wantShareDm || wantSave ||
          wantExpandCaption || wantTapAudio || wantClickHashtag || wantClickAuthor;
        const dwellBaseByMode: Record<string, [number, number]> = {
          superSkim: [900, 1800],
          skim: [1400, 2800],
          fast: [1800, 3400],
          quick: [2400, 4200],
          normal: [3200, 5600],
          slow: [4200, 7000],
          focused: [5600, 9000],
          tapDragRelease: [3000, 5200],
        };
        const [dwellMin, dwellMax] = dwellBaseByMode[sv.mode] ?? [3000, 5600];
        const actionBonus = actionTaken ? 900 + Math.round(Math.random() * 1800) : 0;
        const consumptionDwellMs = Math.round(
          dwellMin + Math.random() * (dwellMax - dwellMin) + actionBonus,
        );
        const dwellStartedAt = Date.now();
        onLog?.(
          `View Feed ${i + 1}/${count}: consumption dwell ${consumptionDwellMs}ms ` +
          `(mode=${sv.mode}, action=${actionTaken ? "yes" : "no"})`,
        );
        logger.info({
          serial,
          mode: sv.mode,
          dwellMs: consumptionDwellMs,
          actionTaken,
        }, "[check-feed] consumption dwell");
        await sleepOrAbort(serial, consumptionDwellMs, "globalDwell");
        const feedTimingBeforeConfiguredDelay = Date.now();
        const delaySec = delayLoSec + Math.random() * (delayHiSec - delayLoSec);
        await sleepOrAbort(serial, Math.round(delaySec * 1000));
        const feedTimingEndedAt = Date.now();
        onLog?.(
          `View Feed ${i + 1}/${count} timing — ` +
          `scroll+safety=${((feedTimingAfterScroll - feedTimingStartedAt) / 1000).toFixed(1)}s, ` +
          `main-actions=${((feedTimingAfterMainActions - feedTimingAfterScroll) / 1000).toFixed(1)}s, ` +
          `secondary-actions=${((feedTimingAfterSecondaryActions - feedTimingAfterMainActions) / 1000).toFixed(1)}s, ` +
          `consumption-dwell=${((feedTimingBeforeConfiguredDelay - dwellStartedAt) / 1000).toFixed(1)}s, ` +
          `configured-delay=${((feedTimingEndedAt - feedTimingBeforeConfiguredDelay) / 1000).toFixed(1)}s, ` +
          `total=${((feedTimingEndedAt - feedTimingStartedAt) / 1000).toFixed(1)}s`,
        );
      } else {
        const feedTimingEndedAt = Date.now();
        onLog?.(
          `View Feed ${i + 1}/${count} timing — ` +
          `scroll+safety=${((feedTimingAfterScroll - feedTimingStartedAt) / 1000).toFixed(1)}s, ` +
          `main-actions=${((feedTimingAfterMainActions - feedTimingAfterScroll) / 1000).toFixed(1)}s, ` +
          `secondary-actions=${((feedTimingAfterSecondaryActions - feedTimingAfterMainActions) / 1000).toFixed(1)}s, ` +
          `configured-delay=0.0s, ` +
          `total=${((feedTimingEndedAt - feedTimingStartedAt) / 1000).toFixed(1)}s`,
        );
      }
    }
    if (strayNavRecoveries > 0) {
      logger.warn({ serial, strayNavRecoveries }, "[check-feed] recovered from stray navigation (ad CTA) during this run");
      onLog?.(`⚠ Recovered from ${strayNavRecoveries} stray navigation(s) — likely tapped an ad CTA during scroll`);
    }
    return { count, likes, likeFailures, sharesFeed, sharesDm, saves, captionExpands, strayNavRecoveries, audioTaps, hashtagTaps, authorVisits };
  }