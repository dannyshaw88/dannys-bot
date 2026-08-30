/** Isolated mobile HST Make a Post operation. */
export interface MakePostOperationContext {
  android: any;
  path: any;
  fsPromises: any;
  sleepOrAbort: (
    serial: string,
    ms: number,
    category?: "globalDwell" | "accountSwitching" | "navigation" | "actionPacing" | "airplaneMode",
    timingMode?: "static" | "computed",
  ) => Promise<void>;
  logger?: any;
  pickLocalFolderImage: (serial: string, opts: any) => Promise<string | null>;
  prepareMakePostImage: (localPath: string, fileName: string, opts: any) => Promise<any>;
  recordPostedLocalFile: (...args: any[]) => void;
  recordPostedProfileMedia: (...args: any[]) => void;
  auditDeviceMediaCopy: (...args: any[]) => Promise<any>;
  effectiveTypingProfile: (...args: any[]) => any;
}

export async function runMakePostStep(serial: string, opts: {
  localFolderPath: string; localFolderRandom: boolean; localFolderNoRepeat: boolean;
  deleteAfterUpload: boolean; captionText: string; addLocation?: boolean;
  accountUsername?: string; slotIdx?: number; homeTapCount?: number;
  doFixAiSlop?: boolean; alterationEnabled?: boolean; alterationLevel?: any;
  imageSettingsEnabled?: boolean; imageSettings?: any; frequencyDisruption?: boolean;
  onLog?: (msg: string) => void;
}, context: MakePostOperationContext): Promise<{ posted: boolean; fileName?: string }> {
  const { android, path, fsPromises, sleepOrAbort, pickLocalFolderImage,
    prepareMakePostImage, recordPostedLocalFile, recordPostedProfileMedia,
    auditDeviceMediaCopy, effectiveTypingProfile,
    } = context;
  const {
    localFolderPath, localFolderRandom, localFolderNoRepeat, deleteAfterUpload,
    captionText, doFixAiSlop, alterationEnabled, alterationLevel,
    imageSettingsEnabled, imageSettings, frequencyDisruption, addLocation, accountUsername, slotIdx, onLog,
    homeTapCount = 1,
  } = opts;

// Establish Instagram Home before doing any local-file selection or image
// processing. This ordering is intentional: Home is the first Make a Post
// action, before Fix AI Slop, alteration, custom image settings, media
// preparation, or any other post feature.
//
// Home is a per-device calibrated fixed control. A missing, stale, or invalid
// map throws explicitly before any image preparation or upload begins.
const homeTab = await android.tapCalibratedNavigationControl(serial, "home", onLog);
const taps = Math.max(1, Math.round(homeTapCount));
for (let tapIndex = 0; tapIndex < taps; tapIndex++) {
  onLog?.(`Make a Post: tapping Instagram Home button (${tapIndex + 1}/${taps})…`);
  if (tapIndex > 0) await android.tap(serial, homeTab.x, homeTab.y);
  if (tapIndex + 1 < taps) await sleepOrAbort(serial, 500);
}
// Do not immediately continue after the tab tap. On slower phones the
// Home surface remains in its transition state for several seconds; use
// a natural randomized 3–5 second dwell before pushing/opening compose.
const homeDwellMs = 3000 + Math.round(Math.random() * 2000);
onLog?.(`Make a Post: waiting ${ (homeDwellMs / 1000).toFixed(1) }s for Instagram Home to finish loading…`);
  await sleepOrAbort(serial, homeDwellMs, "actionPacing", "computed");

const fileName = await pickLocalFolderImage(serial, {
  folderPath: localFolderPath, random: localFolderRandom, noRepeat: localFolderNoRepeat, slotIdx, onLog,
});
if (!fileName) return { posted: false };
const localFilePath = path.join(localFolderPath, fileName);

onLog?.(`Make a Post: preparing processed image "${fileName}"…`);
const prepared = await prepareMakePostImage(localFilePath, fileName, {
  doFixAiSlop,
  alterationEnabled,
  alterationLevel,
  imageSettingsEnabled,
  imageSettings,
  frequencyDisruption,
  onLog,
});
onLog?.(
  `Make a Post: image preparation complete — path=${path.basename(prepared.pushFilePath)} ` +
  `bytes=${prepared.audit.processedBytes} format=${prepared.audit.format} ` +
  `dimensions=${prepared.audit.width}x${prepared.audit.height}`,
);

onLog?.(`Make a Post: pushing "${fileName}" to device…`);
let devicePath: string;
try {
  devicePath = await android.pushFileToDevice(serial, prepared.pushFilePath, prepared.pushFileName);
} catch (e: any) {
  await prepared.cleanup();
  onLog?.(`Make a Post: adb push failed — ${e?.message ?? "unknown error"}`);
  return { posted: false };
}
onLog?.(`Make a Post: adb push complete — devicePath=${devicePath}`);
await prepared.cleanup();
onLog?.("Make a Post: local prepared image cleaned up after push");
  onLog?.(`Make a Post: ✓ pushed to ${devicePath} — waiting for Instagram to index the image`);
await sleepOrAbort(serial, 1200); // let the scanner index the file before we open the picker
onLog?.("Make a Post: media-scan settle complete; looking for compose icon");

onLog?.("Make a Post: using calibrated \"+\" compose icon…");
const composeBtn = await android.tapCalibratedNavigationControl(serial, "createPost", onLog);
onLog?.("Make a Post: tapping the \"+\" compose icon…");
// 3.5 s — Instagram's compose picker takes >1.8 s to finish its opening
// animation on this device; a shorter sleep means the layout dump (and
// every subsequent UIAutomator call) runs against a blank transitioning
// screen instead of the real picker UI.
await sleepOrAbort(serial, 3500);

// One-shot layout dump — fires immediately after the "+" tap sleep,
// before any other UIAutomator call, to capture exactly what opened.
// This is the only dump in this flow; additional dumps compound delays
// and can cause time-sensitive screens (the picker) to change state.
await android.logScreenLayout(serial, "Make a Post: after '+' tap", onLog);

// ── Wrong-header-icon guard ───────────────────────────────────────────────
// Confirmed real-device regressions (13 Jul 2026): two different blind
// positional fallbacks in the old compose selector have each mismatched a
// different wrong screen — a top-right header scan hit Notifications,
// and a bottom-nav-centre guess hit Direct/Messages (this device's
// bottom nav has no create tab at all). The calibrated control now uses the
// user-confirmed top-left header icon position, but this check stays as
// a safety net: if a label/resource-id match ever points at
// Notifications or Direct again, recover by backing out and retrying
// once via that same confirmed top-left position instead of silently
// continuing on the wrong screen.
if (await android.isOnNotificationsOrDirectScreenLive(serial).catch(() => false)) {
  onLog?.("Make a Post: \"+\" tap opened Notifications/Direct instead of the composer — wrong icon tapped. Aborting without a second tap.");
  await android.pressBack(serial);
  await sleepOrAbort(serial, 800);
  await android.removeDeviceFile(serial, devicePath).catch(() => {});
  return { posted: false };
}

// Auto-clear any interstitial ("Turn on notifications?", a stray "Not now"
// confirmation, etc.) that can appear right after opening the composer —
// left alone it silently sits on top of the picker and every later
// findButtonByLabel() call comes back empty.
// NOTE: "Cancel" is excluded from DISMISS_LABELS — it is too generic and
// would dismiss the compose/picker screen itself back to the home feed.
await android.dismissInstagramInterstitials(serial).catch(() => null);

  // getCalibratedNavigationControl is intentionally synchronous: it resolves
  // a saved point and throws when the map/control is unavailable. Keep retry
  // handling local without treating its returned point as a Promise.
  const resolveCalibratedControl = (control: string): { x: number; y: number } | null => {
    try {
      return android.getCalibratedNavigationControl(serial, control);
    } catch {
      return null;
    }
  };

// ── Story-picker guard ────────────────────────────────────────────────────
// The story "+" button in the stories tray carries content-desc="Add" and
// appears before the compose "+" in the accessibility tree, so
// the old compose selector could find it first and open the "Add to story" picker
// instead of the post compose sheet.  Detect this early — before any
// thumbnail tap or Next tap — and abort cleanly.
//
// Signals unique to the story picker / story editor:
//   • "Your story" / "Close Friends" share buttons (story editor bottom bar)
//   • overflow_button resource-id (story editor right toolbar)
//   • "Add to story" window title text
// If ANY of these are present we are on the wrong screen.
const onStoryScreen = await android.isOnStoryCreator(serial).catch(() => false);
if (onStoryScreen) {
  onLog?.("Make a Post: story picker/editor opened instead of post composer — the wrong \"+\" button was tapped. Pressing Back and aborting.");
  await android.pressBack(serial);
  await android.removeDeviceFile(serial, devicePath).catch(() => {});
  return { posted: false };
}

// Instagram always auto-selects the newest gallery photo the moment the
// New Post picker opens — the image appears in the preview area at the top.
// Never tap a thumbnail manually: tapping the already-selected tile
// DESELECTS it (turns it grey/white), and tapping any other tile risks
// hitting the camera icon at grid cell 0, which opens the camera app.
//
// Simply check for the expand/fit toggle as a confirmation signal.  If it
// is visible, image is confirmed selected — tap the toggle to switch from
// IG's default centre-crop to the full original photo.  If the toggle is
// not found in the accessibility tree (some IG builds don't expose it),
// the image is still selected — IG's auto-selection is unconditional.
onLog?.("Make a Post: IG auto-selects newest photo — checking for expand/fit toggle…");
let expandToggle: { x: number; y: number } | null = null;
for (let expandScan = 0; expandScan < 4 && !expandToggle; expandScan++) {
  expandToggle = resolveCalibratedControl("makePostCropToFit");
  if (!expandToggle && expandScan < 3) await sleepOrAbort(serial, 400);
}

// The picker is confirmed by the calibrated Crop to Fit control. Do not use
// the generic "Next"/"POST" detector here: Instagram's bottom POST tab can
// match that broad detector and is not part of this flow.
if (!expandToggle) {
  onLog?.("Make a Post: accessibility resize control not found after retries — aborting safely");
  await android.pressBack(serial);
  await android.removeDeviceFile(serial, devicePath).catch(() => {});
  return { posted: false };
}
  onLog?.(`Make a Post: tapping calibrated Crop to Fit control at (${expandToggle.x}, ${expandToggle.y})…`);
await android.tap(serial, expandToggle.x, expandToggle.y);
await sleepOrAbort(serial, 500);

await sleepOrAbort(serial, 700);
let nextBtn1: { x: number; y: number } | null = null;
for (let nextScan = 0; nextScan < 4 && !nextBtn1; nextScan++) {
  nextBtn1 = resolveCalibratedControl("makePostFirstNext");
  if (!nextBtn1 && nextScan < 3) await sleepOrAbort(serial, 500);
}
if (!nextBtn1) {
  onLog?.("Make a Post: accessibility Next control not found after retries — aborting safely");
  await android.pressBack(serial);
  await android.removeDeviceFile(serial, devicePath).catch(() => {});
  return { posted: false };
}

onLog?.(`Make a Post: found "Next" at (${nextBtn1.x}, ${nextBtn1.y}) — tapping…`);
await android.tap(serial, nextBtn1.x, nextBtn1.y);

// Instagram keeps the picker tree alive while the image-editor transition
// runs. A single 1.5 s expand-toggle check races that transition: it can
// report the old picker even though the tap succeeded, causing us to abort
// before ever looking for the editor's second Next button.
//
// Prefer the editor's live labelled Next node as the success signal. Only
// fail after a bounded settle window in which the picker signal remains and
// no editor Next appears. All candidates still come from fresh UI dumps.
let editorNext: { x: number; y: number } | null = null;
for (let advanceScan = 0; advanceScan < 10; advanceScan++) {
  await sleepOrAbort(serial, advanceScan === 0 ? 700 : 500);
  editorNext = resolveCalibratedControl("makePostSecondNext");
  if (editorNext) break;
}
if (!editorNext) {
  onLog?.("Make a Post: calibrated second Next is unavailable — aborting this attempt");
  await android.pressBack(serial);
  await android.removeDeviceFile(serial, devicePath).catch(() => {});
  return { posted: false };
}

onLog?.(`Make a Post: tapping calibrated second Next at (${editorNext.x}, ${editorNext.y})…`);
await android.tap(serial, editorNext.x, editorNext.y);
await sleepOrAbort(serial, 2000);

// Caption screen — verify we're actually there before typing/sharing.
const shareBtn = await android.findShareFooterButton(serial).catch(() => null);
if (!shareBtn) {
  onLog?.("Make a Post: caption/share screen not confirmed (no \"Share\" control found) — aborting this attempt");
  await android.removeDeviceFile(serial, devicePath).catch(() => {});
  return { posted: false };
}
const caption = captionText.trim();
if (caption) {
  const captionField = await android.findButtonByLabel(serial, "Write a caption").catch(() => null);
  if (captionField) {
    await android.tap(serial, captionField.x, captionField.y);
    await sleepOrAbort(serial, 500);
    await android.inputText(serial, caption);
    await sleepOrAbort(serial, 400);
    await android.pressBack(serial); // dismiss keyboard, don't navigate away from this screen
    await sleepOrAbort(serial, 400);
  } else {
    onLog?.("Make a Post: caption field not found — posting without a caption");
  }
}

// Dismiss any interstitial that appeared while the caption screen was
// loading — most importantly the "Sharing posts" bottom sheet that
// Instagram shows on first-time posting for an account. If this popup is
// present and not cleared before the Share tap, the tap lands on the sheet
// instead of the Share button and the post never submits.
const preTapPopup = await android.dismissInstagramInterstitials(serial).catch(() => null);
if (preTapPopup) {
  onLog?.(`Make a Post: dismissed caption-screen popup ("${preTapPopup}") before Share tap`);
  await sleepOrAbort(serial, 600);
}

// Location must only be handled on the final caption/share page. The
// earlier Share lookup may be stale after caption entry or an editor
// transition, so require a fresh live Share node immediately before
// opening the location picker. Never fall back to the older coordinate.
  let finalShareBtn = resolveCalibratedControl("makePostShare");
if (!finalShareBtn) {
  onLog?.("Make a Post: final caption/share page not confirmed immediately before location — aborting safely");
  await android.removeDeviceFile(serial, devicePath).catch(() => {});
  return { posted: false };
}

if (addLocation) {
  const addLocationBtn = await android.findButtonByLabel(serial, "Add location").catch(() => null);
  if (addLocationBtn) {
    onLog?.("Make a Post: tapping Add location…");
    await android.tap(serial, addLocationBtn.x, addLocationBtn.y);
    // Instagram's location picker can render its shell before the
    // row_search_edit_text field is actually attached. On slower devices
    // the old 1s wait caused us to miss the field and continue toward
    // Share while the picker was still loading.
    onLog?.("Make a Post: waiting 12s for location picker/search box to load…");
    await sleepOrAbort(serial, 12000);

    const locationSearch = await android.findLocationSearchField(serial).catch(() => null);
    if (!locationSearch) {
      onLog?.("Make a Post: location search field not found — continuing without location");
    } else {
      onLog?.("Make a Post: entering location search \"Manchester United Kingdom\"…");
      await android.tap(serial, locationSearch.x, locationSearch.y);
      // The picker can retain a previous query. Clear by moving to the end
      // and sending enough deletes to cover any existing query, then type
      // the exact requested search text.
      await android.keyevent(serial, "123"); // KEYCODE_MOVE_END
      for (let i = 0; i < 80; i++) {
        await android.keyevent(serial, "67"); // KEYCODE_DEL
      }
      const locationText = "Manchester United Kingdom";
      const typedLocation = await android.typeViaSavedCalibrationMap(
        serial,
        locationText,
        effectiveTypingProfile(serial),
        (message: string) => onLog?.(`Make a Post: ${message}`),
      );
      if (!typedLocation.ok) {
        onLog?.(
          `Make a Post: calibrated keyboard could not enter location` +
          `${typedLocation.missing.length ? ` — missing ${typedLocation.missing.join(", ")}` : ""}`,
        );
        await android.pressBack(serial).catch(() => {});
        await sleepOrAbort(serial, 800);
      }
      await sleepOrAbort(serial, 1200);

      const matchingLocation = typedLocation.ok
        ? await android.findButtonByLabel(serial, "Manchester, United Kingdom").catch(() => null)
        : null;
      if (matchingLocation) {
        onLog?.("Make a Post: selecting location \"Manchester, United Kingdom\"…");
        await android.tap(serial, matchingLocation.x, matchingLocation.y);
        await sleepOrAbort(serial, 800);

        // Some Instagram accounts/builds show a secondary "Map preview"
        // confirmation after the location result is selected. It is
        // conditional, so never guess a coordinate or tap an underlying
        // control: only tap a live accessibility node labelled "Add".
        const mapPreviewAdd = await android.findLocationMapPreviewAdd(serial).catch(() => null);
        if (mapPreviewAdd) {
          onLog?.("Make a Post: map preview confirmation shown — tapping Add…");
          await android.tap(serial, mapPreviewAdd.x, mapPreviewAdd.y);
          await sleepOrAbort(serial, 800);
        } else {
          onLog?.("Make a Post: no map preview confirmation shown — continuing");
        }
      } else {
        onLog?.("Make a Post: requested Manchester location result not found — continuing without location");
      }
    }
  } else {
    onLog?.("Make a Post: Add location control not found — continuing without location");
  }
}

// Re-find Share (screen may have re-rendered after the caption/advanced steps).
    finalShareBtn = resolveCalibratedControl("makePostShare");
if (!finalShareBtn) {
  onLog?.("Make a Post: Share control not found after returning from location — aborting safely");
  await android.removeDeviceFile(serial, devicePath).catch(() => {});
  return { posted: false };
}
onLog?.("Make a Post: tapping Share…");
await android.tap(serial, finalShareBtn.x, finalShareBtn.y);

// Poll for the caption screen to disappear — the definitive sign the post
// was submitted and Instagram is uploading. A failed action is logged and
// aborted; automation actions never retry a tap.
// Poll for the post to be accepted. Each iteration does ONE UIAutomator
// dump (checkMakeAPostUploadState) instead of two back-to-back calls
// (findMakeAPostSuccessSignal + findShareFooterButton = ~8-10 s/round).
// Three success states are detected from the single dump:
//   1. successSignal — explicit "Posted!" overlay visible.
//   2. shareGone     — share button disappeared entirely.
//   3. shareDisabled — button present but clickable="false" (upload in
//      progress, Instagram disables it the moment it accepts the upload —
//      this fires ~8 s before the success overlay).
// Retry tap ONLY fires when the button is still present AND still
// clickable after 6 s — i.e. genuinely stuck, not just uploading.
let shareConfirmed = false;
for (let attempt = 0; attempt < 10; attempt++) {
  await sleepOrAbort(serial, 1500);
  const uploadState = await android.checkMakeAPostUploadState(serial).catch(() => null);
  if (!uploadState) continue; // dump failed — wait and retry
  const { successSignal, shareGone, shareDisabled } = uploadState;
  if (successSignal) {
    onLog?.("Make a Post: detected Instagram success signal — post submitted ✓");
    shareConfirmed = true;
    break;
  }
  if (shareGone) {
    onLog?.("Make a Post: Share button gone — post submitted ✓");
    shareConfirmed = true;
    break;
  }
  if (shareDisabled) {
    onLog?.("Make a Post: Share button disabled — upload in progress, post submitted ✓");
    shareConfirmed = true;
    break;
  }
  // Share button remains visible and clickable. Do not tap again; continue
  // polling once per cycle and fail closed if Instagram never accepts it.
}

// Dismiss any post-share interstitial ("OK", notifications prompt, etc.)
// that can appear right after sharing and sit on top of the feed if left
// unhandled.
await android.dismissInstagramInterstitials(serial).catch(() => null);

if (!shareConfirmed) {
  onLog?.("Make a Post: Share button still present after ~15 s — post did not submit. Aborting.");
  await android.removeDeviceFile(serial, devicePath).catch(() => {});
  return { posted: false };
}

recordPostedLocalFile(serial, slotIdx, fileName);
recordPostedProfileMedia(serial, opts.slotIdx ?? 0, opts.accountUsername ?? "", fileName);
if (deleteAfterUpload) {
  try { await fsPromises.unlink(localFilePath); } catch { /* best effort */ }
}
// Always remove the temp copy pushed to the device — it is only needed
// for the picker/upload. Leaving it behind fills up the camera roll.
await android.removeDeviceFile(serial, devicePath).catch(() => {});
onLog?.(`Make a Post: ✓ posted "${fileName}"`);
return { posted: true, fileName };
  }
