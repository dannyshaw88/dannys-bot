/**
 * hstRunner — shared HST timer state + background loop
 *
 * Exports the three module-level maps that MobilePage uses to keep timers alive
 * across React cleanup cycles. Also exports startHstLoop / stopHstLoop so
 * App.tsx's always-mounted HstToggleListener can start/stop the automation
 * loop even when MobilePage is not in the route tree.
 */
import type { HstToggleEvent } from "./hstToggleCoordinator";

// ── Shared maps (imported by MobilePage so they use the same instances) ──────
export const _hstTimers   = new Map<string, ReturnType<typeof setTimeout>>();
export const _hstStop     = new Set<string>();
export const _hstNextRunAt = new Map<string, number>();
// Slot runtimes mounted by MobilePage own their timers. The app-level listener
// must not start a second background owner for the same broadcast while one of
// these runtimes is present; all owners share collisionCoordinator.ts.
export const _hstUiMounted = new Set<string>();
type HstToggleHandler = (event: {
  serial: string;
  slotIdx: number;
  slotId?: string;
  enabled: boolean;
  revision: number;
  requestId: string;
  source: string;
}) => void;
// Direct same-window bridge for manual toggles. DOM events/BroadcastChannel
// remain useful across app contexts, but a mounted runtime must not depend on
// React listener timing to receive an immediate wake command.
export const _hstToggleHandlers = new Map<string, HstToggleHandler>();
// An accepted manual ON can arrive a moment before MobilePage finishes
// registering the mounted slot handler. Keep that command long enough for the
// handler to attach instead of allowing hydration to reinterpret it as startup
// recovery.
const _hstPendingImmediate = new Map<string, HstToggleEvent>();
const _hstStarting = new Set<string>();

type HstDebugFields = Record<string, string | number | boolean | null | undefined>;

/**
 * Background HST work runs outside MobilePage, so its console output is not
 * forwarded through the UI's onLog callback. Send every ownership/timer
 * boundary to the API-backed debug log as well as the browser console.
 */
function logBackgroundHst(
  event: string,
  serial: string,
  slotIdx: number,
  fields: HstDebugFields = {},
): void {
  const detail = JSON.stringify({ serial, slotIdx, ...fields });
  const msg = `background event=${event} ${detail}`;
  console.info(`[HST-RECOVERY] ${msg}`);
  void fetch("/api/hst-dbg", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg }),
    keepalive: true,
  }).catch(() => {
    // Diagnostics must never affect the HST loop.
  });
}

export function registerHstToggleHandler(
  serial: string,
  slotIdx: number,
  handler: HstToggleHandler,
): () => void {
  const key = `${serial}:${slotIdx}`;
  _hstToggleHandlers.set(key, handler);
  const pending = _hstPendingImmediate.get(key);
  if (pending) {
    queueMicrotask(() => {
      if (
        _hstToggleHandlers.get(key) === handler &&
        _hstPendingImmediate.get(key)?.requestId === pending.requestId
      ) {
        _hstPendingImmediate.delete(key);
        handler(pending);
      }
    });
  }
  return () => {
    if (_hstToggleHandlers.get(key) === handler) _hstToggleHandlers.delete(key);
  };
}

/**
 * Route an accepted toggle event to the mounted slot runtime when available.
 * If the runtime is between mount phases, retain an immediate ON until its
 * handler registers. Without this handoff, an enabled slot can be mistaken
 * for a restart-recovered slot and receive a full interval delay.
 */
export function routeHstToggle(event: HstToggleEvent): void {
  const key = `${event.serial}:${event.slotIdx}`;
  const handler = _hstToggleHandlers.get(key);
  if (handler) {
    _hstPendingImmediate.delete(key);
    handler(event);
    return;
  }
  if (event.enabled) {
    _hstPendingImmediate.set(key, event);
    startHstLoop(event.serial, event.slotIdx, {
      immediate: true,
      force: true,
      requestId: event.requestId,
      source: event.source,
    });
  } else {
    _hstPendingImmediate.delete(key);
    stopHstLoop(event.serial, event.slotIdx);
  }
}

import {
  requestCollisionSlot,
  releaseCollisionSlot,
  cancelCollisionSlot,
} from "./collisionCoordinator";

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
  options: { immediate?: boolean; force?: boolean; requestId?: string; source?: string } = {},
): void {
  const key = `${serial}:${slotIdx}`;
  // A mounted MobilePage runtime owns this slot's timer and should also own
  // its settings lifecycle. Recovery must not create a second timer while the
  // UI instance is present; both paths still share the collision coordinator.
  if (_hstUiMounted.has(key)) {
    logBackgroundHst("start-skipped-ui-owner", serial, slotIdx, { key });
    return;
  }
  if (options.force) {
    const existingTimer = _hstTimers.get(key);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
      _hstTimers.delete(key);
      logBackgroundHst("forced-timer-replaced", serial, slotIdx, { key });
    }
    _hstStarting.delete(key);
  } else if (_hstTimers.has(key) || _hstStarting.has(key)) {
    logBackgroundHst("start-skipped-existing-owner", serial, slotIdx, {
      key,
      hasTimer: _hstTimers.has(key),
      starting: _hstStarting.has(key),
    });
    return; // already owned/starting
  }
  logBackgroundHst("start", serial, slotIdx, {
    key,
    immediate: options.immediate !== false,
    force: Boolean(options.force),
    requestId: options.requestId ?? "none",
    source: options.source ?? "unknown",
  });
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
  cancelCollisionSlot(serial, slotIdx);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function scheduleNextBg(serial: string, slotIdx: number, key: string, delayMs: number): void {
  const roundedDelayMs = Math.round(delayMs);
  const fireAt = Date.now() + roundedDelayMs;
  const t = setTimeout(() => {
    logBackgroundHst("timer-callback-entered", serial, slotIdx, {
      key,
      scheduledFireAt: _hstNextRunAt.get(key) ?? fireAt,
      timerPresentAtCallback: _hstTimers.has(key),
      stopFlag: _hstStop.has(key),
      uiOwner: _hstUiMounted.has(key),
    });
    void runCycleBg(serial, slotIdx, key).catch((error: any) => {
      logBackgroundHst("unexpected-run-rejection", serial, slotIdx, {
        key,
        name: error?.name ?? "Error",
        message: error?.message ?? String(error),
        stopFlag: _hstStop.has(key),
        uiOwner: _hstUiMounted.has(key),
      });
      // A rejected promise otherwise kills this background slot permanently.
      // Keep it observable and alive unless ownership has changed explicitly.
      if (!_hstStop.has(key) && !_hstUiMounted.has(key)) {
        scheduleNextBg(serial, slotIdx, key, 60_000);
        logBackgroundHst("unexpected-run-retry-scheduled", serial, slotIdx, {
          key,
          retryDelayMs: 60_000,
        });
      }
    });
  }, roundedDelayMs);
  _hstTimers.set(key, t);
  _hstNextRunAt.set(key, fireAt);
  logBackgroundHst("timer-scheduled", serial, slotIdx, {
    key,
    delayMs: roundedDelayMs,
    fireAt,
  });
}

async function scheduleRestartRecovery(serial: string, slotIdx: number, key: string): Promise<void> {
  let settings: Record<string, unknown> | null = null;
  logBackgroundHst("recovery-settings-fetch-start", serial, slotIdx, { key });
  try {
    const r = await fetch(
      `/api/mobile/devices/${encodeURIComponent(serial)}/slots/${slotIdx}/automation-settings`,
    );
    const body = await r.json().catch(() => null);
    if (r.ok && body && typeof body === "object") settings = body as Record<string, unknown>;
    logBackgroundHst("recovery-settings-fetch-response", serial, slotIdx, {
      key,
      status: r.status,
      ok: r.ok,
      bodyObject: Boolean(body && typeof body === "object"),
      enabled: typeof body?.enabled === "boolean" ? body.enabled : null,
    });
  } catch (error: any) {
    logBackgroundHst("recovery-settings-fetch-error", serial, slotIdx, {
      key,
      name: error?.name ?? "Error",
      message: error?.message ?? String(error),
    });
    // Keep the recovery alive through a transient API startup/network failure.
  }

  _hstStarting.delete(key);
  if (_hstTimers.has(key) || _hstStop.has(key) || _hstUiMounted.has(key)) {
    logBackgroundHst("recovery-exit-after-settings", serial, slotIdx, {
      key,
      reason: _hstTimers.has(key) ? "timer-already-owned" : _hstStop.has(key) ? "stop-flag" : "ui-owner",
    });
    return;
  }
  if (!settings) {
    // Keep trying to hydrate the interval after an API startup race.  Do not
    // call runCycleBg here: that path is allowed to return on a network error,
    // while recovery must remain durable until settings are available.
    scheduleNextBg(serial, slotIdx, key, 60_000);
    return;
  }
  if (!settings.enabled) {
    logBackgroundHst("recovery-stopped-disabled", serial, slotIdx, { key });
    return;
  }

  const safeMin = Math.max(1, Math.min(
    Number(settings.cycleIntervalMin ?? 20),
    Number(settings.cycleIntervalMax ?? 20),
  ));
  const safeMax = Math.max(safeMin, Number(settings.cycleIntervalMax ?? 20));
  const delayMs = (safeMin + Math.random() * (safeMax - safeMin)) * 60_000;
  scheduleNextBg(serial, slotIdx, key, delayMs);
}

async function runCycleBg(serial: string, slotIdx: number, key: string): Promise<void> {
  _hstTimers.delete(key);
  const hstTurnAt = _hstNextRunAt.get(key) ?? Date.now();
  _hstNextRunAt.delete(key);

  logBackgroundHst("run-entered", serial, slotIdx, {
    key,
    hstTurnAt,
    stopFlag: _hstStop.has(key),
    uiOwner: _hstUiMounted.has(key),
  });
  if (_hstStop.has(key) || _hstUiMounted.has(key)) {
    logBackgroundHst("run-skipped-owner", serial, slotIdx, {
      key,
      reason: _hstStop.has(key) ? "stop-flag" : "ui-owner",
    });
    _hstStop.delete(key);
    _hstNextRunAt.delete(key);
    return;
  }
  _hstPendingImmediate.delete(key);

  // Fetch current settings from the server.
  let s: Record<string, unknown>;
  logBackgroundHst("cycle-settings-fetch-start", serial, slotIdx, { key });
  try {
    const r = await fetch(
      `/api/mobile/devices/${encodeURIComponent(serial)}/slots/${slotIdx}/automation-settings`,
    );
    const body = await r.json().catch(() => null);
    if (!r.ok || !body) {
      logBackgroundHst("cycle-settings-fetch-response-invalid", serial, slotIdx, {
        key,
        status: r.status,
        ok: r.ok,
        bodyPresent: Boolean(body),
        retryDelayMs: 60_000,
      });
      // The API may still be restarting. Keep recovery alive without ever
      // converting an unavailable settings response into an immediate cycle.
      scheduleNextBg(serial, slotIdx, key, 60_000);
      return;
    }
    s = body as Record<string, unknown>;
  } catch (error: any) {
    logBackgroundHst("cycle-settings-fetch-error", serial, slotIdx, {
      key,
      name: error?.name ?? "Error",
      message: error?.message ?? String(error),
      retryDelayMs: 60_000,
    });
    // Keep the background loop alive even when the API briefly restarts.  A
    // retry is deliberately delayed so a network failure can never turn into
    // an immediate cycle after software restart.
    scheduleNextBg(serial, slotIdx, key, 60_000);
    return;
  }

  if (!s.enabled) {
    logBackgroundHst("cycle-stopped-disabled", serial, slotIdx, { key });
    return; // toggle was turned off in the DB
  }
  if (_hstStop.has(key) || _hstUiMounted.has(key)) {
    logBackgroundHst("cycle-skipped-after-settings", serial, slotIdx, {
      key,
      reason: _hstStop.has(key) ? "stop-flag" : "ui-owner",
    });
    _hstStop.delete(key);
    _hstNextRunAt.delete(key);
    return;
  }

  const feedMin = Math.max(1, Math.min(Number(s.feedScrollMin ?? 1), Number(s.feedScrollMax ?? 10)));
  const feedMax = Math.max(feedMin, Number(s.feedScrollMax ?? 10));
  const count   = Math.floor(Math.random() * (feedMax - feedMin + 1)) + feedMin;
  const cycleId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  logBackgroundHst("collision-request-start", serial, slotIdx, { key, hstTurnAt });
  let collisionLease: Awaited<ReturnType<typeof requestCollisionSlot>>;
  try {
    collisionLease = await requestCollisionSlot(serial, slotIdx, hstTurnAt, {
      source: "hst-background",
      owner: key,
    });
    logBackgroundHst("collision-request-resolved", serial, slotIdx, {
      key,
      collisionPrevented: collisionLease.collisionPrevented,
    });
  } catch (error: any) {
    logBackgroundHst("collision-request-error", serial, slotIdx, {
      key,
      name: error?.name ?? "Error",
      message: error?.message ?? String(error),
    });
    throw error;
  }
  if (_hstStop.has(key) || _hstUiMounted.has(key)) {
    logBackgroundHst("cycle-skipped-after-collision", serial, slotIdx, {
      key,
      reason: _hstStop.has(key) ? "stop-flag" : "ui-owner",
    });
    _hstStop.delete(key);
    releaseCollisionSlot(serial, collisionLease, true);
    return;
  }

  try {
    logBackgroundHst("cycle-post-start", serial, slotIdx, {
      key,
      cycleId,
      count,
    });
    const cycleResponse = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/automation-cycle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cycleId,
        count,
        slotIdx,
          // Startup recovery runs outside MobilePage, so carry the persisted
          // stable slot identity through to the cycle route. Without this,
          // the server correctly rejects every recovered cycle as stale.
          slotId: s.slotId ?? "",
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
         feedRerunChanceMin: s.feedRerunChanceMin,
         feedRerunChanceMax: s.feedRerunChanceMax,
         storiesRerunChanceMin: s.storiesRerunChanceMin,
         storiesRerunChanceMax: s.storiesRerunChanceMax,
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
         viewExploreRerunChanceMin: s.viewExploreRerunChanceMin,
         viewExploreRerunChanceMax: s.viewExploreRerunChanceMax,
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
         viewReelsRerunChanceMin: s.viewReelsRerunChanceMin,
         viewReelsRerunChanceMax: s.viewReelsRerunChanceMax,
        checkDmEnabled: s.checkDmEnabled,
        checkDmActivatePctMin: s.checkDmActivatePctMin,
        checkDmActivatePctMax: s.checkDmActivatePctMax,
        checkDmScrollMin: s.checkDmScrollMin,
        checkDmScrollMax: s.checkDmScrollMax,
        checkDmClickPctMin: s.checkDmClickPctMin,
        checkDmClickPctMax: s.checkDmClickPctMax,
         checkDmRerunChanceMin: s.checkDmRerunChanceMin,
         checkDmRerunChanceMax: s.checkDmRerunChanceMax,
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
        makePostFilterChanceMin: s.makePostFilterChanceMin,
        makePostFilterChanceMax: s.makePostFilterChanceMax,
         makePostRerunChanceMin: s.makePostRerunChanceMin,
         makePostRerunChanceMax: s.makePostRerunChanceMax,
        makePostAlterationEnabled: s.makePostAlterationEnabled,
        makePostAlterationLevel: s.makePostAlterationLevel,
        makePostImageSettingsEnabled: s.makePostImageSettingsEnabled,
        makePostDisableWhenExhausted: s.makePostDisableWhenExhausted,
        makePostLocalFolderEnabled: true,
        makePostLocalFolderPath: s.makePostLocalFolderPath,
        makePostLocalFolderNoRepeat: s.makePostLocalFolderNoRepeat,
        makePostLocalFolderRandom: s.makePostLocalFolderRandom,
        makePostAddLocation: s.makePostAddLocation,
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
        makePostCaptionText: s.makePostCaptionText,
        makePostImageSettings: s.makePostImageSettings,
        postStoryEnabled: s.postStoryEnabled,
        postStoryActivatePctMin: s.postStoryActivatePctMin,
        postStoryActivatePctMax: s.postStoryActivatePctMax,
        postStoryLocalFolderPath: s.postStoryLocalFolderPath,
        postStoryLocalFolderNoRepeat: s.postStoryLocalFolderNoRepeat,
        postStoryLocalFolderRandom: s.postStoryLocalFolderRandom,
        postStoryAlterationEnabled: s.postStoryAlterationEnabled,
        postStoryAlterationLevel: s.postStoryAlterationLevel,
        postStoryImageSettingsEnabled: s.postStoryImageSettingsEnabled,
        postStoryImageSettings: s.postStoryImageSettings,
        postStoryFixAiSlop: s.postStoryFixAiSlop,
        postStoryAddLink: s.postStoryAddLink,
        postStoryLinkUrl: s.postStoryLinkUrl,
        shuffleToolOrder: s.shuffleToolOrder,
        dismissDirection: s.dismissDirection,
      }),
    });
    logBackgroundHst("cycle-post-response", serial, slotIdx, {
      key,
      cycleId,
      status: cycleResponse.status,
      ok: cycleResponse.ok,
    });
    if (cycleResponse.status === 409) {
      // Another slot on this device is currently running. Keep this slot's
      // turn alive and retry shortly rather than waiting for the full interval
      // and making an enabled HST appear inert.
      scheduleNextBg(serial, slotIdx, key, 10_000 + Math.random() * 10_000);
      return;
    }
    if (!cycleResponse.ok) {
      logBackgroundHst("cycle-post-non-ok", serial, slotIdx, {
        key,
        cycleId,
        status: cycleResponse.status,
        retryDelayMs: "configured-interval",
      });
    }
  } catch (error: any) {
    logBackgroundHst("cycle-post-error", serial, slotIdx, {
      key,
      name: error?.name ?? "Error",
      message: error?.message ?? String(error),
      retryDelayMs: 60_000,
    });
    // Keep the loop alive through a transient API/network failure. A delayed
    // retry is safer than relying on MobilePage to be mounted.
    scheduleNextBg(serial, slotIdx, key, 60_000);
    return;
  } finally {
    releaseCollisionSlot(serial, collisionLease);
  }

  if (_hstStop.has(key) || _hstUiMounted.has(key)) {
    _hstStop.delete(key);
    _hstNextRunAt.delete(key);
    return;
  }

  // Reschedule using the configured interval.
  const safeMin = Math.max(1, Math.min(Number(s.cycleIntervalMin ?? 20), Number(s.cycleIntervalMax ?? 20)));
  const safeMax = Math.max(safeMin, Number(s.cycleIntervalMax ?? 20));
  const gapMs   = (safeMin + Math.random() * (safeMax - safeMin)) * 60_000;
  scheduleNextBg(serial, slotIdx, key, gapMs);
}
