export interface ViewExploreOperationContext {
  android: typeof import("../../androidManager");
  deviceProfileSwipe: (...args: any[]) => Promise<any>;
  dismissSaveCollectionPrompt: (...args: any[]) => Promise<any>;
  getScreenSize: (serial: string) => { w: number; h: number };
  isCycleAborted: (serial: string) => boolean;
  loadInstanceConfigs: () => any;
  logger: any;
  rollFeedConsumptionGesture: (...args: any[]) => any;
  sleepOrAbort: (serial: string, milliseconds: number) => Promise<void>;
  _viewExploreLastDmRecipient: Map<string, { x: number; y: number }>;
}

export async function runViewExplorePage(serial: string, params: {
  scrollCount: number;
  delayMinSec: number; delayMaxSec: number;
  clickPostPctMin: number; clickPostPctMax: number;
  likePercentMin: number; likePercentMax: number;
  shareFeedPercentMin: number; shareFeedPercentMax: number;
  shareDmPercentMin: number; shareDmPercentMax: number;
  savePercentMin: number; savePercentMax: number;
  clickAuthorPctMin: number; clickAuthorPctMax: number;
  onLog?: (msg: string) => void;
  onProgress?: (progress: { postsScrolled: number; postsClicked: number; likes: number; sharesFeed: number; sharesDm: number; saves: number; authorVisits: number }) => void;
}, context: ViewExploreOperationContext): Promise<{ postsScrolled: number; postsClicked: number; likes: number; sharesFeed: number; sharesDm: number; saves: number; authorVisits: number }> {
  const {
    scrollCount, delayMinSec, delayMaxSec,
    clickPostPctMin, clickPostPctMax,
    likePercentMin, likePercentMax,
    shareFeedPercentMin, shareFeedPercentMax,
    shareDmPercentMin, shareDmPercentMax,
    savePercentMin, savePercentMax,
    clickAuthorPctMin, clickAuthorPctMax,
    onLog, onProgress,
  } = params;

  const {
    android, deviceProfileSwipe, dismissSaveCollectionPrompt,
    getScreenSize, isCycleAborted, loadInstanceConfigs, logger,
    rollFeedConsumptionGesture, sleepOrAbort, _viewExploreLastDmRecipient,
  } = context;

  onLog?.("[TRACE] explore: start");
  const { w, h } = getScreenSize(serial);
  onLog?.(`Explore loop: device resolution ${w}×${h}`);

  // Navigate to the Search/Explore tab — identical to the Follow tool.
  const searchTab = await android.tapCalibratedNavigationControl(serial, "search", onLog);
  onLog?.("[TRACE] explore: tap-search-tab");
  // Same 2500ms settle used by Follow — enough for the Explore grid to render.
  await sleepOrAbort(serial, 2500);

  // Pre-roll session-level chance values once so every scroll sees consistent rates.
  const clickChance     = (Math.min(clickPostPctMin, clickPostPctMax) + Math.random() * Math.abs(clickPostPctMax - clickPostPctMin)) / 100;
  const likeChance      = (Math.min(likePercentMin, likePercentMax) + Math.random() * Math.abs(likePercentMax - likePercentMin)) / 100;
  const shareFeedChance = (Math.min(shareFeedPercentMin, shareFeedPercentMax) + Math.random() * Math.abs(shareFeedPercentMax - shareFeedPercentMin)) / 100;
  const shareDmChance   = (Math.min(shareDmPercentMin, shareDmPercentMax) + Math.random() * Math.abs(shareDmPercentMax - shareDmPercentMin)) / 100;
  const saveChance        = (Math.min(savePercentMin, savePercentMax) + Math.random() * Math.abs(savePercentMax - savePercentMin)) / 100;
  const clickAuthorChance = (Math.min(clickAuthorPctMin, clickAuthorPctMax) + Math.random() * Math.abs(clickAuthorPctMax - clickAuthorPctMin)) / 100;

  const delayLoSec = Math.min(delayMinSec, delayMaxSec);
  const delayHiSec = Math.max(delayMinSec, delayMaxSec);

  let postsScrolled = 0, postsClicked = 0, likes = 0, sharesFeed = 0, sharesDm = 0, saves = 0, authorVisits = 0;

  // Explore grid media can open either a photo viewer or a Reel viewer.
  // Those viewers have different accessibility trees, so a UI "Back"
  // node is not a reliable exit control. Android BACK is intentionally the
  // single exit path for both viewer types.
  const exitExploreMediaViewer = async (iteration: number) => {
    onLog?.(`View Explore ${iteration}/${scrollCount}: exiting media viewer with Android Back`);
    await android.pressBack(serial);
    await sleepOrAbort(serial, 800);
  };

  // Scroll geometry: same safe band as runCheckFeedLoop.
  const x  = Math.round(w / 2);

  // Explore uses the same feed-like consumption behavior, while retaining
  // its separate grid safety guard below.
  onLog?.("Explore consumption personality — deliberate drags are primary; corrections and flicks are rare");
  const explorePersonalityHistory: { lastMode?: string; streak: number } = { streak: 0 };

  for (let i = 0; i < scrollCount; i++) {
    if (isCycleAborted(serial)) throw new Error("cycle-aborted");
    onLog?.(`View Explore ${i + 1}/${scrollCount}`);
    const exploreActionsBefore = { postsClicked, likes, sharesFeed, sharesDm, saves, authorVisits };

    // Optionally click a post from the currently visible grid.
    if (clickChance > 0 && Math.random() < clickChance) {
      // Parse explore grid cells from the accessibility tree.
      // The explore grid has two cell types:
      //   • Photo/carousel cells  → container id="grid_card_layout_container"
      //                             child    id="image_button"
      //   • Reel cells            → container id="layout_container"
      //                             child    id="image_preview"
      // Matching the tappable image children directly (image_button +
      // image_preview) catches both types, and the ≥150px size filter
      // excludes tiny UI images (profile pics, icons, etc.).
      const xml = await android.dumpUi(serial).catch(() => "");
      const gridCells: Array<{ x: number; y: number; resourceId: string; clickable: boolean; enabled: boolean }> = [];
      const nodeRe2 = /<node\s([^>]*?)\s*\/?>/g;
      let cm: RegExpExecArray | null;
      while ((cm = nodeRe2.exec(xml)) !== null) {
        const attrs = cm[1];
        const resourceMatch = attrs.match(/resource-id="([^"]*)"/);
        const resourceId = resourceMatch?.[1] ?? "";
        // Tap the grid's owning container, not merely an image child. The
        // image child can have valid-looking bounds while the surrounding
        // container owns Instagram's click handler.
        const isGridContainer =
          resourceId.endsWith("grid_card_layout_container") ||
          resourceId.endsWith("layout_container");
        const isImageChild =
          resourceId.endsWith("image_button") ||
          resourceId.endsWith("image_preview");
        if (!isGridContainer && !isImageChild) continue;
        const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!bm) continue;
        const x1 = parseInt(bm[1]), y1 = parseInt(bm[2]);
        const x2 = parseInt(bm[3]), y2 = parseInt(bm[4]);
        // Must be a real grid cell — at least 150×150px.
        if ((x2 - x1) < 150 || (y2 - y1) < 150) continue;
        const cx = Math.round((x1 + x2) / 2);
        const cy = Math.round((y1 + y2) / 2);
        // Exclude cells clipped into the search/action bar (top ~155px)
        // or the bottom nav (bottom ~30px from screen edge).
        const clickable = /clickable="true"/.test(attrs);
        const enabled = !/enabled="false"/.test(attrs);
        if (cy > 155 && cy < h - 30 && enabled && (isGridContainer ? clickable : clickable)) {
          gridCells.push({ x: cx, y: cy, resourceId, clickable, enabled });
        }
      }
      // Prefer the clickable grid containers. Image children are retained
      // only as a compatibility fallback for builds where Instagram exposes
      // no clickable container but marks the image node itself clickable.
      const clickableContainers = gridCells.filter((cell) =>
        cell.resourceId.endsWith("grid_card_layout_container") ||
        cell.resourceId.endsWith("layout_container"),
      );
      const clickableCells = clickableContainers.length > 0
        ? clickableContainers
        : gridCells.filter((cell) => cell.clickable);

      if (clickableCells.length > 0) {
        const cell = clickableCells[Math.floor(Math.random() * clickableCells.length)];
        onLog?.(`View Explore ${i + 1}/${scrollCount}: selected ${cell.resourceId} clickable=${cell.clickable} enabled=${cell.enabled} candidates=${clickableCells.length}`);
        onLog?.(`View Explore ${i + 1}/${scrollCount}: clicking grid post at (${cell.x},${cell.y})`);
        await android.tap(serial, cell.x, cell.y);
        // Explore click-post dwell: remain on the selected grid post long
        // enough for its media/viewer to render before continuing with any
        // actions. This is intentionally isolated to View Explore.
        const explorePostDwellMs = 1000 + Math.floor(Math.random() * 9001);
        onLog?.(`View Explore ${i + 1}/${scrollCount}: dwelling ${explorePostDwellMs}ms on clicked post`);
        await sleepOrAbort(serial, explorePostDwellMs);
        postsClicked++;

        const wantLike        = likeChance        > 0 && Math.random() < likeChance;
        const wantShareFeed   = shareFeedChance   > 0 && Math.random() < shareFeedChance;
        const wantShareDm     = shareDmChance     > 0 && Math.random() < shareDmChance;
        const wantSave        = saveChance        > 0 && Math.random() < saveChance;
        const wantClickAuthor = clickAuthorChance > 0 && Math.random() < clickAuthorChance;

        if (wantLike || wantShareFeed || wantShareDm || wantSave) {
          await sleepOrAbort(serial, 600); // settle before scanning action bar

          onLog?.(`View Explore ${i + 1}/${scrollCount}: scanning action bar…`);
          let icons = await android.findFeedActionIcons(serial, onLog).catch(() => null);

          // ── Explore-only: Reels column fallback (null path) ─────────────
          // findFeedActionIcons looks for Like/Unlike near screen centre-x
          // (≈540 px). In the Reels viewer that Explore posts open into,
          // every icon sits at x≈998 (right edge) — the feed scanner misses
          // them entirely and returns null. When that happens, fall straight
          // through to findReelActionIcons which scans the right-edge column
          // directly. Save is not in the Reels column; it stays null here
          // and the broader save scan below picks it up if present.
          // This block is intentionally isolated to runViewExplorePage and
          // has no effect on any other tool.
          if (!icons) {
            onLog?.(`View Explore ${i + 1}/${scrollCount}: feed scan found nothing — trying Reels column scan`);
            const _veReelIcons = await android.findReelActionIcons(serial, onLog).catch(() => null);
            if (_veReelIcons) {
              icons = {
                like:       _veReelIcons.like,
                comment:    _veReelIcons.comment,
                shareFeed:  _veReelIcons.shareFeed,
                shareDm:    _veReelIcons.shareDm,
                save:       null,
                alreadyLiked: _veReelIcons.alreadyLiked,
              };
              onLog?.(`View Explore ${i + 1}/${scrollCount}: Reels column found — like=(${_veReelIcons.like.x},${_veReelIcons.like.y}) shareFeed=${_veReelIcons.shareFeed ? `(${_veReelIcons.shareFeed.x},${_veReelIcons.shareFeed.y})` : "null"} shareDm=${_veReelIcons.shareDm ? `(${_veReelIcons.shareDm.x},${_veReelIcons.shareDm.y})` : "null"}`);
            }
          }

          // ── Explore-only: vertical column overlay (non-null path) ────────
          // If findFeedActionIcons DID return icons but Like is in the right
          // column (x > 80%), the horizontal row scan will have returned null
          // for shareFeed/shareDm. Overlay those from findReelActionIcons.
          if (icons && icons.like.x > Math.round(w * 0.80)) {
            onLog?.(`View Explore ${i + 1}/${scrollCount}: vertical column layout detected (like.x=${icons.like.x}) — re-scanning shareFeed/shareDm via column scan`);
            const _veColIcons = await android.findReelActionIcons(serial, onLog).catch(() => null);
            if (_veColIcons) {
              icons = { ...icons, shareFeed: _veColIcons.shareFeed, shareDm: _veColIcons.shareDm };
            }
            // Save remains null unless the shared screenshot matcher found
            // the attached ribbon icon. Never restore an accessibility or
            // positional Save fallback for the vertical Reel layout.
          }

          if (!icons) {
            onLog?.(`View Explore ${i + 1}/${scrollCount}: no action bar found — skipping actions`);
            logger.info({ serial }, "[view-explore] opened post has no action bar");
          } else {
            // ── Like ──────────────────────────────────────────────────────
            if (wantLike) {
              if (icons.alreadyLiked) {
                onLog?.(`View Explore ${i + 1}/${scrollCount}: already liked — skipping like`);
              } else {
                // ~93 % double-tap on image; ~7 % heart-icon tap for variety.
                 const useDoubleTap = Math.random() < 0.93 && Boolean(icons.mediaBounds);
                 if (useDoubleTap && icons.mediaBounds) {
                   const mb = icons.mediaBounds;
                   const xFraction = 0.35 + Math.random() * 0.30;
                   const yFraction = 0.35 + Math.random() * 0.30;
                   const dtX = Math.round(mb.x1 + (mb.x2 - mb.x1) * xFraction);
                   const dtY = Math.round(mb.y1 + (mb.y2 - mb.y1) * yFraction);
                   onLog?.(`View Explore ${i + 1}/${scrollCount}: double-tap using central media bounds (${Math.round(xFraction * 100)}%,${Math.round(yFraction * 100)}%)`);
                   onLog?.(`View Explore ${i + 1}/${scrollCount}: double-tapping image at (${dtX},${dtY})…`);
                   await android.doubleTap(serial, dtX, dtY, undefined, mb);
                 } else {
                   if (!icons.mediaBounds) {
                     onLog?.(`View Explore ${i + 1}/${scrollCount}: media bounds unavailable — using confirmed Like icon instead of double-tap`);
                   }
                  const jx = icons.like.x + Math.round((Math.random() - 0.5) * 6);
                  const jy = icons.like.y + Math.round((Math.random() - 0.5) * 6);
                  onLog?.(`View Explore ${i + 1}/${scrollCount}: tapping heart icon at (${jx},${jy})…`);
                  await android.tap(serial, jx, jy);
                }
                likes++;
                onLog?.(`View Explore ${i + 1}/${scrollCount}: ✓ liked`);
                await sleepOrAbort(serial, 300);
              }
            }

            // ── Share to Feed (repost) ─────────────────────────────────────
            if (wantShareFeed && !icons.shareFeed) {
              onLog?.(`View Explore ${i + 1}/${scrollCount}: skipped repost — share-to-feed icon not found`);
            }
            if (wantShareFeed && icons.shareFeed) {
              try {
                if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300));
                const _eSfX = icons.shareFeed.x, _eSfY = icons.shareFeed.y;
                onLog?.(`View Explore ${i + 1}/${scrollCount}: tapping share-to-feed at (${_eSfX},${_eSfY})…`);
                await android.tap(serial, _eSfX, _eSfY);
                await sleepOrAbort(serial, 400);
                const _eRpBtn = await android.findButtonByLabel(serial, "Repost").catch(() => null);
                const _eRpDx = _eRpBtn ? Math.abs(_eRpBtn.x - _eSfX) : 0;
                const _eRpDy = _eRpBtn ? Math.abs(_eRpBtn.y - _eSfY) : 0;
                const _eRpSame = !!_eRpBtn && _eRpDx < 60 && _eRpDy < 60;
                if (_eRpBtn && !_eRpSame) {
                  await android.tap(serial, _eRpBtn.x, _eRpBtn.y);
                  await sleepOrAbort(serial, 300);
                  const _eClose = await android.findButtonByLabel(serial, "Close").catch(() => null);
                  if (_eClose) { await android.tap(serial, _eClose.x, _eClose.y); await sleepOrAbort(serial, 150); }
                  sharesFeed++;
                  onLog?.(`View Explore ${i + 1}/${scrollCount}: ✓ reposted to feed`);
                } else if (_eRpSame) {
                  sharesFeed++;
                  onLog?.(`View Explore ${i + 1}/${scrollCount}: ✓ reposted to feed (single-tap)`);
                } else {
                  await android.pressBack(serial).catch(() => {});
                  onLog?.(`View Explore ${i + 1}/${scrollCount}: repost — Repost button not found after tap`);
                }
              } catch (e: any) {
                if (e?.message === "cycle-aborted") throw e;
                onLog?.(`View Explore ${i + 1}/${scrollCount}: share-to-feed error — ${e?.message}`);
              }
            }

            // ── Share via DM (isolated; not shared with any other tool) ───
            const _veOverlap = !!icons.shareDm && !!icons.shareFeed &&
              Math.abs(icons.shareDm.x - icons.shareFeed.x) < 15 &&
              Math.abs(icons.shareDm.y - icons.shareFeed.y) < 15;
            if (wantShareDm && !icons.shareDm) {
              onLog?.(`View Explore ${i + 1}/${scrollCount}: skipped share-via-DM — paper-plane icon not found`);
            }
            if (wantShareDm && icons.shareDm && _veOverlap) {
              onLog?.(`View Explore ${i + 1}/${scrollCount}: share-via-DM skipped — icon overlaps share-to-feed (ambiguous layout)`);
            }
            if (wantShareDm && icons.shareDm && !_veOverlap) {
              const _vePfx = `View Explore ${i + 1}/${scrollCount}`;
              let _veDmSent = false;
              try {
                if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300));
                onLog?.(`${_vePfx}: tapping share-via-DM icon at (${icons.shareDm.x},${icons.shareDm.y})…`);
                await android.tap(serial, icons.shareDm.x, icons.shareDm.y);
                await sleepOrAbort(serial, 1500);
                onLog?.(`${_vePfx}: confirming share sheet opened and picking DM recipient…`);
                let _veScan = await android.confirmAndScanShareSheet(serial, onLog).catch(() => null);
                if (!_veScan?.sheetOpen) {
                  onLog?.(`${_vePfx}: share sheet not yet visible — waiting 1500ms and retrying…`);
                  await sleepOrAbort(serial, 1500);
                  _veScan = await android.confirmAndScanShareSheet(serial, onLog).catch(() => null);
                }
                if (!_veScan?.sheetOpen) {
                  logger.warn({ serial }, "[view-explore] share sheet not confirmed open after retry — skipping DM");
                  onLog?.(`${_vePfx}: share aborted — share sheet did not open`);
                  await android.pressBack(serial);
                  await sleepOrAbort(serial, 200);
                } else {
                  if (_veScan.preSelectedRecipients && _veScan.preSelectedRecipients.length > 0) {
                    onLog?.(`${_vePfx}: deselecting ${_veScan.preSelectedRecipients.length} pre-selected recipient(s)…`);
                    for (const _r of _veScan.preSelectedRecipients) {
                      onLog?.(`${_vePfx}: deselecting${(_r as any).name ? ` (${(_r as any).name})` : ""} at (${_r.x},${_r.y})`);
                      await android.tap(serial, _r.x, _r.y);
                      await sleepOrAbort(serial, 400);
                    }
                  }
                  const _veRecipients = _veScan.recipients ?? [];
                  if (_veRecipients.length === 0) {
                    await android.pressBack(serial);
                    logger.warn({ serial }, "[view-explore] no recipient found — closed without sending");
                    onLog?.(`${_vePfx}: share skipped — no recipient avatars found`);
                  } else {
                    const _veLast = _viewExploreLastDmRecipient.get(serial);
                    const _vePool = _veLast ? _veRecipients.filter(r => !(r.x === _veLast.x && r.y === _veLast.y)) : _veRecipients;
                    const _veCands = _vePool.length > 0 ? _vePool : _veRecipients;
                    const _vePick = _veCands[Math.floor(Math.random() * _veCands.length)];
                    _viewExploreLastDmRecipient.set(serial, { x: _vePick.x, y: _vePick.y });
                    onLog?.(`${_vePfx}: tapping recipient at (${_vePick.x},${_vePick.y})${(_vePick as any).name ? ` (${(_vePick as any).name})` : ""}`);
                    await android.tap(serial, _vePick.x, _vePick.y);
                    await sleepOrAbort(serial, 800);
                    const _veIsOpen = async () => {
                      const _x = await android.dumpUi(serial).catch(() => "");
                      return _x.includes("direct_private_share") || _x.includes("grid_view_pog_avatar_view") ||
                             _x.includes("android.widget.EditText") || _x.includes("Copy link");
                    };
                    const _veSb = await android.findButtonByLabel(serial, "Send").catch(() => null);
                    if (_veSb) {
                      await android.tap(serial, _veSb.x, _veSb.y);
                      await sleepOrAbort(serial, 1500);
                      if (!(await _veIsOpen())) {
                        _veDmSent = true;
                        logger.info({ serial }, "[view-explore] shared post via DM — Send tapped");
                        onLog?.(`${_vePfx}: ✓ shared via DM — Send tapped`);
                        await sleepOrAbort(serial, 300);
                      } else {
                        onLog?.(`${_vePfx}: Send tapped but sheet still open — pressing Back`);
                        await android.pressBack(serial);
                        await sleepOrAbort(serial, 200);
                      }
                    } else if (!(await _veIsOpen())) {
                      _veDmSent = true;
                      logger.info({ serial }, "[view-explore] share sheet auto-dismissed — DM likely sent");
                      onLog?.(`${_vePfx}: ✓ shared via DM — sheet auto-dismissed`);
                      await sleepOrAbort(serial, 200);
                    } else {
                      const _veFbX = Math.round(w * 0.50), _veFbY = Math.round(h * 0.982);
                      onLog?.(`${_vePfx}: Send not found via a11y — tapping coordinate fallback (${_veFbX},${_veFbY})`);
                      await android.tap(serial, _veFbX, _veFbY);
                      await sleepOrAbort(serial, 1500);
                      if (!(await _veIsOpen())) {
                        _veDmSent = true;
                        onLog?.(`${_vePfx}: ✓ shared via DM — sent via coordinate fallback`);
                        await sleepOrAbort(serial, 300);
                      } else {
                        await android.pressBack(serial);
                        await sleepOrAbort(serial, 200);
                      }
                    }
                  }
                }
              } catch (e: any) {
                if (e?.message === "cycle-aborted") throw e;
                onLog?.(`${_vePfx}: share-via-DM error — ${e?.message}`);
              }
              if (_veDmSent) sharesDm++;
            }

            // ── Save Post ──────────────────────────────────────────────────
            if (wantSave) {
              const _eSaveBtn = icons.save;
              if (!_eSaveBtn) {
                onLog?.(`View Explore ${i + 1}/${scrollCount}: save skipped — ribbon icon not found`);
              } else {
                try {
                  if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                  await sleepOrAbort(serial, 200 + Math.round(Math.random() * 200));
                  onLog?.(`View Explore ${i + 1}/${scrollCount}: tapping save (ribbon) at (${_eSaveBtn.x},${_eSaveBtn.y})…`);
                  await android.tap(serial, _eSaveBtn.x, _eSaveBtn.y);
                  await sleepOrAbort(serial, 600);
                  const _eSaveXml = await android.dumpUi(serial).catch(() => "");
                   await dismissSaveCollectionPrompt(serial, _eSaveXml, onLog, `View Explore ${i + 1}/${scrollCount}`);
                  saves++;
                  logger.info({ serial }, "[view-explore] saved post via ribbon icon");
                  onLog?.(`View Explore ${i + 1}/${scrollCount}: ✓ saved`);
                } catch (e: any) {
                  if (e?.message === "cycle-aborted") throw e;
                  onLog?.(`View Explore ${i + 1}/${scrollCount}: save error — ${e?.message}`);
                }
              }
            }
          }
        }

        // ── Click Author (visit post author's profile) ─────────────────
        // Taps clips_author_username (Reels viewer) or
        // row_feed_photo_profile_name (photo-post viewer) — whichever is
        // present — to open the author's profile. Scrolls 1–10 times with
        // a normal swipe followed by a 2.5–10 s render wait, then presses
        // Back once after the profile visit to return to the post viewer;
        // the existing Back press below then returns to Explore.
        // This block is intentionally isolated to runViewExplorePage.
        if (wantClickAuthor) {
          try {
            if (isCycleAborted(serial)) throw new Error("cycle-aborted");
            await sleepOrAbort(serial, 300);
            const _aeXml = await android.dumpUi(serial).catch(() => "");
            // Skip author click if Instagram labels this as a sponsored post.
            // Quoted attribute matching prevents false positives on words like
            // "Add", "Adidas", etc. whose text values differ from the bare "Ad".
            const _aeIsAd =
              _aeXml.includes('text="Ad"')         || _aeXml.includes('content-desc="Ad"') ||
              _aeXml.includes('text="Sponsored"')  || _aeXml.includes('content-desc="Sponsored"') ||
              _aeXml.includes('text="Advert"')     || _aeXml.includes('content-desc="Advert"');
            if (_aeIsAd) {
              onLog?.(`View Explore ${i + 1}/${scrollCount}: ad post detected — skipping click author`);
            } else {
            // Find author button — covers Reels viewer (clips_author_username)
            // and photo-post viewer (row_feed_photo_profile_name).
            //
            // clips_author_info_component is deliberately excluded: it is a
            // container node that appears before its children in the XML dump.
            // It has no text/content-desc, so the name would be "unknown", and
            // tapping it on a collab post opens a Collaborators sheet instead
            // of navigating to the author's profile.
            //
            // Require a non-empty name: collab posts expose multiple
            // clips_author_username nodes (one per collaborator). Taking the
            // first one with a non-empty text/content-desc gives us the
            // original (topmost) author — later nodes are collaborators.
            // An empty name means we hit a container; skip it.
            let _aeNode: { x: number; y: number; name: string } | null = null;
            const _aeNodeRe = /<node\s([^>]*?)(?:\/?>)/g;
            let _aeMatch: RegExpExecArray | null;
            while ((_aeMatch = _aeNodeRe.exec(_aeXml)) !== null) {
              const _aeSeg = _aeMatch[1];
              const _aeRid = (_aeSeg.match(/resource-id="([^"]*)"/) ?? [])[1] ?? "";
              const _isAuthor =
                /(?:^|:)clips_author_username$/.test(_aeRid) ||
                /(?:^|:)row_feed_photo_profile_name$/.test(_aeRid);
              if (!_isAuthor) continue;
              const _aeDesc =
                (_aeSeg.match(/text="([^"]*)"/) ?? [])[1] ??
                (_aeSeg.match(/content-desc="([^"]*)"/) ?? [])[1] ??
                "";
              // Skip nodes with no name — containers and collab groupings.
              if (!_aeDesc) continue;
              const _aeBb = _aeSeg.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
              if (!_aeBb) continue;
              const _aeX = Math.round((parseInt(_aeBb[1]) + parseInt(_aeBb[3])) / 2);
              const _aeY = Math.round((parseInt(_aeBb[2]) + parseInt(_aeBb[4])) / 2);
              _aeNode = { x: _aeX, y: _aeY, name: _aeDesc };
              break;
            }
            if (!_aeNode) {
              onLog?.(`View Explore ${i + 1}/${scrollCount}: click-author rolled but no named author button visible — skipping`);
            } else {
              onLog?.(`View Explore ${i + 1}/${scrollCount}: tapping author "${_aeNode.name}" at (${_aeNode.x},${_aeNode.y})…`);
              await android.tap(serial, _aeNode.x, _aeNode.y);
              await sleepOrAbort(serial, 1500);
              // Guard: collab posts can open a Collaborators sheet instead of
              // a profile. Check the post-tap dump and bail if the sheet appeared.
              const _aeChkXml = await android.dumpUi(serial).catch(() => "");
              const _aeIsCollab =
                _aeChkXml.includes('text="Collaborators"') ||
                _aeChkXml.includes('clips_collab');
              if (_aeIsCollab) {
                onLog?.(`View Explore ${i + 1}/${scrollCount}: click-author — Collaborators sheet appeared (collab post) — pressing Back, skipping`);
                await android.pressBack(serial);
                await sleepOrAbort(serial, 500);
              } else {
                // Normal single-author profile — scroll it. Keep the gesture
                // short and natural, then wait for the profile posts to render
                // before starting another scroll.
                const _aeScrolls = 1 + Math.floor(Math.random() * 10);
                onLog?.(`View Explore ${i + 1}/${scrollCount}: on author profile "${_aeNode.name}" — scrolling ${_aeScrolls}x…`);
                const { w: _aeW, h: _aeH } = getScreenSize(serial);
                for (let _aeS = 0; _aeS < _aeScrolls; _aeS++) {
                  if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                  const _aeSY1 = Math.round(_aeH * 0.75);
                  const _aeSY2 = Math.round(_aeH * 0.30);
                  const _aeDur = 350 + Math.round(Math.random() * 350);
                  await deviceProfileSwipe(serial, { x1: Math.round(_aeW / 2), y1: _aeSY1, x2: Math.round(_aeW / 2), y2: _aeSY2, durationMs: _aeDur }, "explore-author-scroll");
                  const _aeRenderWaitMs = 2500 + Math.round(Math.random() * 7500);
                  await sleepOrAbort(serial, _aeRenderWaitMs);
                }
                // Back once — returns to the post/reel viewer. The outer
                // Back below then returns from the post/reel to Explore.
                onLog?.(`View Explore ${i + 1}/${scrollCount}: returning from author profile…`);
                await android.pressBack(serial);
                await sleepOrAbort(serial, 700);
                authorVisits++;
                onLog?.(`View Explore ${i + 1}/${scrollCount}: ✓ author profile visited (${_aeNode.name})`);
              }
            }
            } // end ad-skip else
          } catch (e: any) {
            if (e?.message === "cycle-aborted") throw e;
            onLog?.(`View Explore ${i + 1}/${scrollCount}: click-author error — ${e?.message}`);
          }
        }

        // Always leave clicked media through Android BACK. Do not search for
        // or tap an accessibility Back node: Reels and photo viewers expose
        // different trees, and media clicks can replace the entire UI.
        await exitExploreMediaViewer(i + 1);
      } else {
        onLog?.(`View Explore ${i + 1}/${scrollCount}: no grid posts visible — skipping click`);
      }
    }

    postsScrolled++;
    onProgress?.({ postsScrolled, postsClicked, likes, sharesFeed, sharesDm, saves, authorVisits });

    if (i < scrollCount - 1) {
      const exploreActionTaken =
        postsClicked > exploreActionsBefore.postsClicked ||
        likes > exploreActionsBefore.likes ||
        sharesFeed > exploreActionsBefore.sharesFeed ||
        sharesDm > exploreActionsBefore.sharesDm ||
        saves > exploreActionsBefore.saves ||
        authorVisits > exploreActionsBefore.authorVisits;
      const exploreDwellMs = Math.round(2800 + Math.random() * 4200 + (exploreActionTaken ? 1200 : 0));
      onLog?.(`View Explore ${i + 1}/${scrollCount}: consumption dwell ${exploreDwellMs}ms (action=${exploreActionTaken ? "yes" : "no"})`);
      logger.info({ serial, dwellMs: exploreDwellMs, actionTaken: exploreActionTaken }, "[view-explore] consumption dwell");
      await sleepOrAbort(serial, exploreDwellMs);
      // Preserve the user-configured delay in addition to consumption time.
      const delaySec = delayLoSec + Math.random() * (delayHiSec - delayLoSec);
      if (delaySec > 0) await sleepOrAbort(serial, Math.round(delaySec * 1000));
      // Swipe up to reveal more Explore posts.
      // The first Explore advance is the first opportunity to reveal more
      // content; there is no prior grid position to revisit yet.
      const esv = rollFeedConsumptionGesture(h, explorePersonalityHistory, serial);
      const exploreOverride = serial ? loadInstanceConfigs()[serial]?.devicePrefs?.swipePersonalityOverrides?.[esv.mode] : undefined;
      onLog?.(`[Override] Explore swipe: mode=${esv.mode}, duration=${esv.duration}ms${exploreOverride ? `, weight=${exploreOverride.weightMin}-${exploreOverride.weightMax}, durationRange=${exploreOverride.durationMinMs}-${exploreOverride.durationMaxMs}ms` : ", Mother Code default"}`);
      explorePersonalityHistory.streak = explorePersonalityHistory.lastMode === esv.mode ? explorePersonalityHistory.streak + 1 : 1;
      explorePersonalityHistory.lastMode = esv.mode;
      const exploreModeLabel = esv.mode === "superSkim" ? "super skim" : esv.mode;
      onLog?.(`View Explore ${i + 1}/${scrollCount}: next swipe [${exploreModeLabel}]`);
      logger.info({ serial, source: "explore-scroll", mode: esv.mode, from: [x, esv.fromY], to: [x, esv.toY], durationMs: esv.duration }, "[mobile-input] swipe");
      // Cap the swipe start at 68% of screen height so startJitter can never
      // push the finger onto the bottom row of clickable Reel thumbnail cells,
      // which have touch consumers that claim the DOWN event as a tap even
      // when the gesture travels 600+ px upward (root cause: jitter-pushed
      // y1 onto a Reel cell → cell's touch consumer fired before the grid's
      // scroll interceptor could claim the drag).
      const exploreMaxFromY = Math.round(h * 0.68);
      await deviceProfileSwipe(serial, { x1: x, y1: esv.fromY, x2: x, y2: esv.toY, durationMs: esv.duration }, "explore-scroll", esv.mode as any, { maxFromY: exploreMaxFromY });
      // Explore-only render dwell: the grid often needs a few seconds after
      // the gesture before its media cells are actually populated. Keep this
      // hardcoded and isolated here; it must not alter Feed, Reels, Stories,
      // or any other tool's swipe timing.
      const exploreMediaDwellMs = 1000 + Math.floor(Math.random() * 4001);
      onLog?.(`View Explore ${i + 1}/${scrollCount}: waiting ${exploreMediaDwellMs}ms for media to render after swipe`);
      await sleepOrAbort(serial, exploreMediaDwellMs);
    }
  }

  // Navigate back to the home feed — Explore has its own distinct UI so
  // tapping Home is the cleanest exit (same pattern as after View Reels).
  onLog?.("View Explore Page: navigating back to home feed…");
  // Use the live accessibility tree for the exit tap. The screenshot-based
  // brightness scan is unsafe here: Home and Reels are adjacent, and the
  // brightest tile in the bottom-nav region is not necessarily Home.
  const homeTab = await android.tapCalibratedNavigationControl(serial, "home", onLog);
  onLog?.(`View Explore Page: tapping semantic Home tab at (${homeTab.x}, ${homeTab.y})`);
    await sleepOrAbort(serial, 1000);

  return { postsScrolled, postsClicked, likes, sharesFeed, sharesDm, saves, authorVisits };
}
