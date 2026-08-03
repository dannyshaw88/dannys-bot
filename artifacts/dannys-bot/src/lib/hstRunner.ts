/**
 * hstRunner — shared HST timer state + background loop
 *
 * Exports the three module-level maps that MobilePage uses to keep timers alive
 * across React cleanup cycles. Also exports startHstLoop / stopHstLoop so
 * App.tsx's always-mounted HstToggleListener can start/stop the automation
 * loop even when MobilePage is not in the route tree.
 */

// ── Shared maps (imported by MobilePage so they use the same instances) ──────
export const _hstTimers   = new Map<string, ReturnType<typeof setTimeout>>();
export const _hstStop     = new Set<string>();
export const _hstNextRunAt = new Map<string, number>();
const _hstStarting = new Set<string>();

// ── Background loop ───────────────────────────────────────────────────────────

/**
 * Start the automation loop for a given serial+slot from outside MobilePage.
 *
 * If a timer is already running for this key (MobilePage started it), this is
 * a no-op — MobilePage owns it and we don't want to double-schedule.
 *
 * Manual toggle-on starts immediately.  Startup recovery must pass
 * `{ immediate: false }`; timers do not survive a software restart, so it
 * first reloads the persisted interval and schedules a normal first turn.
 */
export function startHstLoop(
  serial: string,
  slotIdx: number,
  options: { immediate?: boolean } = {},
): void {
  const key = `${serial}:${slotIdx}`;
  if (_hstTimers.has(key) || _hstStarting.has(key)) return; // already owned/starting
  _hstStop.delete(key);
  if (options.immediate !== false) {
    scheduleNextBg(serial, slotIdx, key, 0); // manual toggle-on
    return;
  }

  // Never use a zero/one-second fallback for restart recovery.  If the
  // settings request fails, retry after a safe minute instead of accidentally
  // turning a software restart into an immediate automation burst.
  _hstStarting.add(key);
  void scheduleRestartRecovery(serial, slotIdx, key);
}

/**
 * Stop the automation loop for a given serial+slot.
 * Mirrors MobilePage's explicit-toggle-off path.
 */
export function stopHstLoop(serial: string, slotIdx: number): void {
  const key = `${serial}:${slotIdx}`;
  const t = _hstTimers.get(key);
  if (t !== undefined) { clearTimeout(t); _hstTimers.delete(key); }
  _hstStarting.delete(key);
  _hstStop.add(key);
  _hstNextRunAt.delete(key);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function scheduleNextBg(serial: string, slotIdx: number, key: string, delayMs: number): void {
  const t = setTimeout(() => runCycleBg(serial, slotIdx, key), Math.round(delayMs));
  _hstTimers.set(key, t);
  _hstNextRunAt.set(key, Date.now() + Math.round(delayMs));
}

async function scheduleRestartRecovery(serial: string, slotIdx: number, key: string): Promise<void> {
  let settings: Record<string, unknown> | null = null;
  try {
    const r = await fetch(
      `/api/mobile/devices/${encodeURIComponent(serial)}/slots/${slotIdx}/automation-settings`,
    );
    const body = await r.json().catch(() => null);
    if (r.ok && body && typeof body === "object") settings = body as Record<string, unknown>;
  } catch {
    // Keep the recovery alive through a transient API startup/network failure.
  }

  _hstStarting.delete(key);
  if (_hstTimers.has(key) || _hstStop.has(key)) return;
  if (!settings) {
    // Keep trying to hydrate the interval after an API startup race.  Do not
    // call runCycleBg here: that path is allowed to return on a network error,
    // while recovery must remain durable until settings are available.
    scheduleNextBg(serial, slotIdx, key, 60_000);
    return;
  }
  if (!settings.enabled) return;

  const safeMin = Math.max(1, Math.min(
    Number(settings.cycleIntervalMin ?? 20),
    Number(settings.cycleIntervalMax ?? 30),
  ));
  const safeMax = Math.max(safeMin, Number(settings.cycleIntervalMax ?? 30));
  const delayMs = (safeMin + Math.random() * (safeMax - safeMin)) * 60_000;
  scheduleNextBg(serial, slotIdx, key, delayMs);
}

async function runCycleBg(serial: string, slotIdx: number, key: string): Promise<void> {
  _hstTimers.delete(key);

  if (_hstStop.has(key)) { _hstStop.delete(key); _hstNextRunAt.delete(key); return; }

  // Fetch current settings from the server.
  let s: Record<string, unknown>;
  try {
    const r = await fetch(
      `/api/mobile/devices/${encodeURIComponent(serial)}/slots/${slotIdx}/automation-settings`,
    );
    const body = await r.json().catch(() => null);
    if (!r.ok || !body) {
      // The API may still be restarting. Keep recovery alive without ever
      // converting an unavailable settings response into an immediate cycle.
      scheduleNextBg(serial, slotIdx, key, 60_000);
      return;
    }
    s = body as Record<string, unknown>;
  } catch {
    // Keep the background loop alive even when the API briefly restarts.  A
    // retry is deliberately delayed so a network failure can never turn into
    // an immediate cycle after software restart.
    scheduleNextBg(serial, slotIdx, key, 60_000);
    return;
  }

  if (!s.enabled) return; // toggle was turned off in the DB
  if (_hstStop.has(key)) { _hstStop.delete(key); _hstNextRunAt.delete(key); return; }

  const feedMin = Math.max(1, Math.min(Number(s.feedScrollMin ?? 1), Number(s.feedScrollMax ?? 10)));
  const feedMax = Math.max(feedMin, Number(s.feedScrollMax ?? 10));
  const count   = Math.floor(Math.random() * (feedMax - feedMin + 1)) + feedMin;
  const cycleId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

  try {
    await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/automation-cycle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cycleId,
        count,
        slotIdx,
        slotUsername: s.slotUsername ?? "",
        feedEnabled: s.feedEnabled,
        storiesEnabled: s.storiesEnabled,
        delayMinSec: s.actionDelayMin,
        delayMaxSec: s.actionDelayMax,
        likePercentMin: s.likePercentMin,
        likePercentMax: s.likePercentMax,
        shareFeedPercentMin: s.shareFeedPercentMin,
        shareFeedPercentMax: s.shareFeedPercentMax,
        shareDmPercentMin: s.shareDmPercentMin,
        shareDmPercentMax: s.shareDmPercentMax,
        savePercentMin: s.savePercentMin,
        savePercentMax: s.savePercentMax,
        expandCaptionPercentMin: s.expandCaptionPercentMin,
        expandCaptionPercentMax: s.expandCaptionPercentMax,
        tapAudioPercentMin: s.tapAudioPercentMin,
        tapAudioPercentMax: s.tapAudioPercentMax,
        clickHashtagPercentMin: s.clickHashtagPercentMin,
        clickHashtagPercentMax: s.clickHashtagPercentMax,
        clickAuthorPercentMin: s.clickAuthorPercentMin,
        clickAuthorPercentMax: s.clickAuthorPercentMax,
        feedSuggestionsPercentMin: s.feedSuggestionsPercentMin,
        feedSuggestionsPercentMax: s.feedSuggestionsPercentMax,
        viewStoriesSlidesMin: s.viewStoriesSlidesMin,
        viewStoriesSlidesMax: s.viewStoriesSlidesMax,
        viewStoriesSlideWatchPctMin: s.viewStoriesSlideWatchPctMin,
        viewStoriesSlideWatchPctMax: s.viewStoriesSlideWatchPctMax,
        viewStoriesLikePercentMin: s.viewStoriesLikePercentMin,
        viewStoriesLikePercentMax: s.viewStoriesLikePercentMax,
        viewStoriesShareDmPercentMin: s.viewStoriesShareDmPercentMin,
        viewStoriesShareDmPercentMax: s.viewStoriesShareDmPercentMax,
        viewStoriesCommentPercentMin: s.viewStoriesCommentPercentMin,
        viewStoriesCommentPercentMax: s.viewStoriesCommentPercentMax,
        viewStoriesClickAuthorPercentMin: s.viewStoriesClickAuthorPercentMin,
        viewStoriesClickAuthorPercentMax: s.viewStoriesClickAuthorPercentMax,
        viewExploreEnabled: s.viewExploreEnabled,
        viewExploreActivatePctMin: s.viewExploreActivatePctMin,
        viewExploreActivatePctMax: s.viewExploreActivatePctMax,
        viewExploreScrollMin: s.viewExploreScrollMin,
        viewExploreScrollMax: s.viewExploreScrollMax,
        viewExploreActionDelayMin: s.viewExploreActionDelayMin,
        viewExploreActionDelayMax: s.viewExploreActionDelayMax,
        viewExploreClickPostPctMin: s.viewExploreClickPostPctMin,
        viewExploreClickPostPctMax: s.viewExploreClickPostPctMax,
        viewExploreLikePercentMin: s.viewExploreLikePercentMin,
        viewExploreLikePercentMax: s.viewExploreLikePercentMax,
        viewExploreShareFeedPercentMin: s.viewExploreShareFeedPercentMin,
        viewExploreShareFeedPercentMax: s.viewExploreShareFeedPercentMax,
        viewExploreShareDmPercentMin: s.viewExploreShareDmPercentMin,
        viewExploreShareDmPercentMax: s.viewExploreShareDmPercentMax,
        viewExploreSavePercentMin: s.viewExploreSavePercentMin,
        viewExploreSavePercentMax: s.viewExploreSavePercentMax,
        viewExploreClickAuthorPercentMin: s.viewExploreClickAuthorPercentMin,
        viewExploreClickAuthorPercentMax: s.viewExploreClickAuthorPercentMax,
        viewReelsEnabled: s.viewReelsEnabled,
        viewReelsScrollMin: s.viewReelsScrollMin,
        viewReelsScrollMax: s.viewReelsScrollMax,
        viewReelsLikePercentMin: s.viewReelsLikePercentMin,
        viewReelsLikePercentMax: s.viewReelsLikePercentMax,
        viewReelsShareFeedPercentMin: s.viewReelsShareFeedPercentMin,
        viewReelsShareFeedPercentMax: s.viewReelsShareFeedPercentMax,
        viewReelsShareDmPercentMin: s.viewReelsShareDmPercentMin,
        viewReelsShareDmPercentMax: s.viewReelsShareDmPercentMax,
        viewReelsSavePercentMin: s.viewReelsSavePercentMin,
        viewReelsSavePercentMax: s.viewReelsSavePercentMax,
        viewReelsClickAuthorPercentMin: s.viewReelsClickAuthorPercentMin,
        viewReelsClickAuthorPercentMax: s.viewReelsClickAuthorPercentMax,
        viewReelsActivatePctMin: s.viewReelsActivatePctMin,
        viewReelsActivatePctMax: s.viewReelsActivatePctMax,
        viewReelsWatchPctMin: s.viewReelsWatchPctMin,
        viewReelsWatchPctMax: s.viewReelsWatchPctMax,
        checkDmEnabled: s.checkDmEnabled,
        checkDmActivatePctMin: s.checkDmActivatePctMin,
        checkDmActivatePctMax: s.checkDmActivatePctMax,
        checkDmScrollMin: s.checkDmScrollMin,
        checkDmScrollMax: s.checkDmScrollMax,
        checkDmClickPctMin: s.checkDmClickPctMin,
        checkDmClickPctMax: s.checkDmClickPctMax,
        followEnabled: s.followEnabled,
        followUsersMin: s.followUsersMin,
        followUsersMax: s.followUsersMax,
        followSpreadFollows: s.followSpreadFollows,
        followSources: s.followSources,
        injectBrowsingEnabled: s.injectBrowsingEnabled,
        injectBrowsingActivatePctMin: s.injectBrowsingActivatePctMin,
        injectBrowsingActivatePctMax: s.injectBrowsingActivatePctMax,
        injectBrowsingBeforeFollowPctMin: s.injectBrowsingBeforeFollowPctMin,
        injectBrowsingBeforeFollowPctMax: s.injectBrowsingBeforeFollowPctMax,
        injectBrowsingFeedMin: s.injectBrowsingFeedMin,
        injectBrowsingFeedMax: s.injectBrowsingFeedMax,
        injectBrowsingClickPostPctMin: s.injectBrowsingClickPostPctMin,
        injectBrowsingClickPostPctMax: s.injectBrowsingClickPostPctMax,
        injectBrowsingLikePctMin: s.injectBrowsingLikePctMin,
        injectBrowsingLikePctMax: s.injectBrowsingLikePctMax,
        injectBrowsingShareFeedPctMin: s.injectBrowsingShareFeedPctMin,
        injectBrowsingShareFeedPctMax: s.injectBrowsingShareFeedPctMax,
        injectBrowsingShareDmPctMin: s.injectBrowsingShareDmPctMin,
        injectBrowsingShareDmPctMax: s.injectBrowsingShareDmPctMax,
        injectBrowsingSavePostPctMin: s.injectBrowsingSavePostPctMin,
        injectBrowsingSavePostPctMax: s.injectBrowsingSavePostPctMax,
        injectBrowsingAbandonFollowPctMin: s.injectBrowsingAbandonFollowPctMin,
        injectBrowsingAbandonFollowPctMax: s.injectBrowsingAbandonFollowPctMax,
        injectBrowsingTapHighlightsPctMin: s.injectBrowsingTapHighlightsPctMin,
        injectBrowsingTapHighlightsPctMax: s.injectBrowsingTapHighlightsPctMax,
        followFiltersEnabled: s.followFiltersEnabled,
        followFilterPrivateUsers: s.followFilterPrivateUsers,
        followFilterEnglishSpeaking: s.followFilterEnglishSpeaking,
        followFilterMinFollowers50: s.followFilterMinFollowers50,
        followFilterVerifiedUsers: s.followFilterVerifiedUsers,
        followFilterMaxFollowers25k: s.followFilterMaxFollowers25k,
        feedActivatePctMin: s.feedActivatePctMin,
        feedActivatePctMax: s.feedActivatePctMax,
        viewStoriesActivatePctMin: s.viewStoriesActivatePctMin,
        viewStoriesActivatePctMax: s.viewStoriesActivatePctMax,
        followActivatePctMin: s.followActivatePctMin,
        followActivatePctMax: s.followActivatePctMax,
        randomJitterEnabled: s.randomJitterEnabled,
        randomJitterActivatePctMin: s.randomJitterActivatePctMin,
        randomJitterActivatePctMax: s.randomJitterActivatePctMax,
        checkNotificationsPctMin: s.checkNotificationsPctMin,
        checkNotificationsPctMax: s.checkNotificationsPctMax,
        checkNotificationsScrollsMin: s.checkNotificationsScrollsMin,
        checkNotificationsScrollsMax: s.checkNotificationsScrollsMax,
        checkNotificationsClickPctMin: s.checkNotificationsClickPctMin,
        checkNotificationsClickPctMax: s.checkNotificationsClickPctMax,
        visitProfilePctMin: s.visitProfilePctMin,
        visitProfilePctMax: s.visitProfilePctMax,
        visitSavedPctMin: s.visitSavedPctMin,
        visitSavedPctMax: s.visitSavedPctMax,
        visitSettingsPctMin: s.visitSettingsPctMin,
        visitSettingsPctMax: s.visitSettingsPctMax,
        appSwitchPctMin: s.appSwitchPctMin,
        appSwitchPctMax: s.appSwitchPctMax,
        makePostEnabled: s.makePostEnabled,
        makePostActivatePctMin: s.makePostActivatePctMin,
        makePostActivatePctMax: s.makePostActivatePctMax,
        makePostPerSessionMin: s.makePostPerSessionMin,
        makePostPerSessionMax: s.makePostPerSessionMax,
        makePostAlterationEnabled: s.makePostAlterationEnabled,
        makePostAlterationLevel: s.makePostAlterationLevel,
        makePostImageSettingsEnabled: s.makePostImageSettingsEnabled,
        makePostDisableWhenExhausted: s.makePostDisableWhenExhausted,
        makePostLocalFolderEnabled: true,
        makePostLocalFolderPath: s.makePostLocalFolderPath,
        makePostLocalFolderNoRepeat: s.makePostLocalFolderNoRepeat,
        makePostLocalFolderRandom: s.makePostLocalFolderRandom,
        makePostLocalFolderDeleteAfterUpload: s.makePostLocalFolderDeleteAfterUpload,
        updateProfilePicActivatePctMin: s.updateProfilePicActivatePctMin,
        updateProfilePicActivatePctMax: s.updateProfilePicActivatePctMax,
        updateProfilePicFolderPath: s.updateProfilePicFolderPath,
        updateProfilePicDisableAfterUsed: s.updateProfilePicDisableAfterUsed,
        updateBioActivatePctMin: s.updateBioActivatePctMin,
        updateBioActivatePctMax: s.updateBioActivatePctMax,
        updateBioText: s.updateBioText,
        updateBioDisableAfterUsed: s.updateBioDisableAfterUsed,
        makePostUseChatGpt: s.makePostUseChatGpt,
        makePostFixAiSlop: s.makePostFixAiSlop,
        makePostMakeUnique: s.makePostMakeUnique,
        makePostCaptionText: s.makePostCaptionText,
        makePostImageSettings: s.makePostImageSettings,
        makePostPostToProfilePctMin: s.makePostPostToProfilePctMin,
        makePostPostToProfilePctMax: s.makePostPostToProfilePctMax,
        makePostPostToStoryPctMin: s.makePostPostToStoryPctMin,
        makePostPostToStoryPctMax: s.makePostPostToStoryPctMax,
        shuffleToolOrder: s.shuffleToolOrder,
        dismissDirection: s.dismissDirection,
      }),
    });
  } catch {
    // Keep the loop alive through a transient API/network failure. A delayed
    // retry is safer than relying on MobilePage to be mounted.
    scheduleNextBg(serial, slotIdx, key, 60_000);
    return;
  }

  if (_hstStop.has(key)) { _hstStop.delete(key); _hstNextRunAt.delete(key); return; }

  // Reschedule using the configured interval.
  const safeMin = Math.max(1, Math.min(Number(s.cycleIntervalMin ?? 25), Number(s.cycleIntervalMax ?? 99)));
  const safeMax = Math.max(safeMin, Number(s.cycleIntervalMax ?? 99));
  const gapMs   = (safeMin + Math.random() * (safeMax - safeMin)) * 60_000;
  scheduleNextBg(serial, slotIdx, key, gapMs);
}
