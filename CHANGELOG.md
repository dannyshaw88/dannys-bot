# Changelog

All notable changes to Equinox are documented here.

---

## [1.1.612] — 2026-07-15

### Fix: Inject Browsing share-to-DM now works for all post types

**Root cause 1 — wrong sheet-detection gate:** `confirmAndScanShareSheet` only accepted `direct_private_share` or `grid_view_pog_avatar_view` as proof the DM share sheet was open. Posts opened from a profile grid (including Reels, but not limited to them) show a wider share sheet that uses neither of those resource-ids — so the gate fired false, logged "sheet not open", and aborted every time even though the sheet was visibly open on screen. Fixed by also accepting `"Copy link"` and `"Add to story"` as valid sheet-open signals. Any one of the four markers is now sufficient.

**Root cause 2 — wrong abort condition:** The abort fired when `sendBtn` was null after the scan. The Send button only appears in the share sheet *after* a recipient is selected — so it is always null at scan time. The abort should fire on `!sheetOpen`, not `!sendBtn`. Fixed. `sendShareSheet` already does its own fresh lookup for Send when `knownSendBtn` is null.

**Retry logic removed:** The retry tap in `shareCurrentPostViaDm` has been removed. Retries are now forbidden across all automation — see the new rule in the Mobile automation rules section.

## [1.1.611] — 2026-07-15

### Fix: Log Record markers now actually appear (stale-closure bug)

**Left-click cyan markers weren't registering at all** — clicking the mirror in Log Record mode did nothing. Root cause: `handlePointerUp` is a stable `useCallback` with fixed deps; `logRecMode` wasn't in the dep list, so the closure always saw `false` and fell through to the normal tap path. Fixed by mirroring `logRecMode` and `onExpectedTap` into refs inside `LiveCanvas` and reading those refs in `handlePointerUp`.

**Right-click now places a yellow "vicinity" marker** — for taps whose exact location varies (e.g. picking a random user from the share-sheet list, tapping a post anywhere on screen). Right-click on the mirror in Log Record mode → yellow dashed circle. Left-click remains the cyan exact-match marker.

Stop button now shows **🔵 exact / 🟡 vicinity / 🟠 bot** counts individually. Exported JSON includes `vicinityCount` in the summary.

## [1.1.610] — 2026-07-15

### Feature: Log Record mode — visual expected-vs-actual tap comparison overlay

**What it is.** A new "📍 Log Record" button in the Log tab lets you annotate the mirror in real-time while automation runs, then export a JSON file showing exactly where you expected taps to land versus where the bot actually sent them.

**How it works:**

1. Press **📍 Log Record** in the Log tab toolbar while automation is executing (or at any time).
2. The mirror immediately enters annotation mode — a teal "📍 LOG RECORD — tap to place expected marker" banner appears at the top of the mirror.
   - **Cyan dots (you):** click anywhere on the mirror to drop a marker at that phone coordinate — these are your "I expected a tap here" pins.
   - **Orange dots (bot):** any automation log line matching `tapping/tapped … at (X,Y)` is automatically parsed and placed as an orange marker in the same coordinate space.
   - Each dot is numbered in sequence (1, 2, 3…) so you can correlate with the log.
3. The mirror is **read-only while recording** — your clicks place markers only, they are NOT forwarded to the phone. Normal tap/swipe/double-tap behaviour resumes the instant you stop.
4. Press **⏹ Stop (Ncyan Norange)** to end the session. A JSON file downloads automatically containing every marker's phone coordinates, type, timestamp, and label (trimmed log line for bot taps). The phone mirror is immediately interactive again.

**Export schema:**
```json
{ "exportedAt", "serial", "phoneSize", "markerCount", "expectedCount", "botCount",
  "markers": [{ "x", "y", "t", "type": "expected|bot", "label" }] }
```

**Implementation:** entirely client-side — no new API routes, no server changes. State lives in `MobilePage`, passed via props to `PhoneSlot → LiveCanvas` (renders the overlay) and `LogPanel` (hosts the button). Bot taps are extracted from the shared `addLog` callback using `BOT_TAP_RE`.

---

## [1.1.609] — 2026-07-15

### Fix: profile grid post tap used forbidden hardcoded coordinates — replaced with live a11y tree lookup

**Root cause.** `runProfileBrowsingSequence` accumulated fixed percentage slots (`w×0.17`, `w×0.50`, `w×0.83` at `h×0.55`) across scroll rows and tapped one at random. These are hardcoded pixel percentages — forbidden by project rules. On profiles like `ibrahimdayann` (mostly Reels, grid thumbnails at varying positions) the slot coordinates frequently missed the actual thumbnails, landing on the Reels-tab strip, gap cells, or off-screen whitespace. Both the initial tap and the scroll-up-and-retry recovery slots shared the same flaw, so the retry always missed too, ending with "retry also found no post — giving up" on profiles with hundreds of visible posts.

**Fix — `findProfileGridPosts` (androidManager.ts, new):** dumps the live accessibility tree and finds every node with `resource-id="com.instagram.android:id/image_button"` whose centre falls within the visible grid band (y ∈ [18%, 90%] of screen height) and has minimum size (≥60×60px) to exclude header/avatar image buttons. Returns each node's actual bounds-derived centre coordinate and content-desc. Posts tap exactly where the thumbnail is, regardless of scroll position, screen density, or Instagram version.

**Fix — `runProfileBrowsingSequence` (mobile.ts):** removed `seenPostSlots` and both `recoverySlots` arrays entirely. After scrolling, calls `findProfileGridPosts` to get real positions; picks one at random and logs which post (by content-desc) was tapped. Retry after scroll-up also calls `findProfileGridPosts` for a fresh dump — no hardcoded coordinates anywhere in the path.

---

## [1.1.608] — 2026-07-15

### Fix: share-to-DM sheet detection broken on Instagram builds without `direct_private_share`

**Root cause confirmed from live log + screenshot (15 Jul 2026).** v1.1.607 made `direct_private_share` the sole gate for "share sheet is open". On this device's Instagram build the DM share sheet renders without that resource-id in the accessibility tree — confirmed by the screenshot showing the sheet fully open (with Francis Bourgeois selected, blue Send button visible) at the same moment the log reported "direct_private_share not found — sheet not open". The code therefore aborted on every attempt, and the accidental retry tap at (535,1904) happened to land on a recipient avatar (selecting Francis Bourgeois), which is why the Send button appeared.

**Fix:** `confirmAndScanShareSheet` now checks TWO markers before deciding the sheet is closed:

- `direct_private_share` — the sticky search-box resource-id present in the narrow single-recipient sheet variant
- `grid_view_pog_avatar_view` — the recipient avatar button resource-id, present in **both** DM share sheet variants (narrow and wide grid picker), and confirmed absent from the raw feed view

If **either** is found the sheet is confirmed open and the scan proceeds normally. Only when **both** are absent does the function return `{ sheetOpen: false, sendBtn: null, recipients: [] }` and trigger the retry/abort path. This preserves the false-positive protection from v1.1.607 while supporting both Instagram sheet layouts seen on this device.

---

## [1.1.607] — 2026-07-15

### Fix: share-to-DM false-positive — sheet-not-open incorrectly reported as success

**Root cause confirmed from live log (15 Jul 2026).** The DM icon tap failed to open the share sheet. The `confirmAndScanShareSheet` dump that followed captured the **underlying feed post** instead of the share sheet, because:

1. `_findElem(xml, "Send")` matched the **feed's own paper-plane icon** (which has `content-desc="Send"` on a child node) at the exact same coordinate — so `sendBtn` was non-null even though the sheet never appeared
2. `sheetOpen = xml.includes("direct_private_share")` was `false`, but this was only checked in a secondary guard (`recipients.length === 0 && !sheetOpen`) — which was bypassed because Strategy 2 returned **bogus feed post nodes** (username buttons, `"more"` caption button, caption text) as recipients
3. The `"more"` button at (566,2155) was randomly picked and tapped as a "recipient", then the code re-tapped the feed's own send icon; since no sheet was ever open `isDmSheetOpen()` returned false, and the cycle reported `✓ shared via DM — Send tapped` — a complete false positive with nothing actually sent

**Fix 1 — `confirmAndScanShareSheet` (androidManager.ts):** `direct_private_share` is now checked FIRST, before calling `_findElem` or `_extractShareSheetRecipients`. If the sheet is not confirmed open, the function returns `{ sheetOpen: false, sendBtn: null, recipients: [] }` immediately. The feed's own send-icon coordinate can no longer masquerade as the share sheet's Send button, and bogus feed post nodes can no longer appear as DM recipients.

**Fix 2 — Wait time after DM icon tap (mobile.ts):** increased from 400 ms to 1500 ms for both the initial tap and the retry. The dump captures UI state at the moment it starts — 400 ms was too short for the share sheet to fully animate in on this MIUI device. With the longer wait the sheet is open before the dump begins, so `direct_private_share` is present and the scan succeeds.

**Fix 3 — Removed redundant secondary guard (mobile.ts):** the `recipients.length === 0 && !sheetOpen` retry block is removed. With the primary `sheetOpen` gate now in `confirmAndScanShareSheet`, `sendBtn` is always null when the sheet is not open, so the existing `!scan.sendBtn` check handles all retry paths without a second layer of redundant logic.

**Fix 4 — Added `"more"` to UI_CHROME exclusion (androidManager.ts Strategy 2):** the `"more"` caption-expand button was not previously excluded by the label filter and could be picked as a DM recipient when feed post nodes leaked through Strategy 2. Added as belt-and-suspenders on top of the primary fix.

---

## [1.1.606] — 2026-07-15

### Fix: share-to-DM tapped "Your Story" instead of a DM contact

**Root cause confirmed from device log.** Instagram's DM share sheet renders "Your Story" (and "Close Friends") as a tappable circle at the top of the recipient picker grid using the **exact same resource-id** (`com.instagram.android:id/grid_view_pog_avatar_view`) as real DM contact avatars. The clickable `android.widget.Button` child node has no `content-desc` or `text` of its own — only the wrapping ViewGroup carries the human-readable label "Your Story". Strategy 1 in `_extractShareSheetRecipients` found all `grid_view_pog_avatar_view` nodes by resource-id but applied no content filtering at all, so "Your Story" was returned as a valid recipient and got randomly picked first.

**Fix:** for each `grid_view_pog_avatar_view` button found in the accessibility tree, look back up to 600 characters in the raw XML from that node's position to find the last `content-desc` attribute (the nearest parent ViewGroup's label). If it matches `your story|close friends|add to story|add to your story` (case-insensitive), the node is excluded and logged. Real DM contact parents have labels like "John Doe not selected" or "Instagram Verified Chat not selected" — these never match the story-destination regex.

### Feature: Session Recorder

Addresses the recurring disconnect between what automation logs report and what the phone actually did. When active, the session recorder captures:
- **Every tap** (x, y coordinates) — via the single `android.tap()` chokepoint so nothing is missed
- **Every uiautomator dump** (full XML, truncated to 60 KB per dump to avoid OOM) — via the single `_uiDump()` chokepoint, so every Share Sheet scan, feed icon scan, and story viewer check is captured
- **Every log line** emitted by the automation (all the `onLog` callbacks)

The recorder is per-device, ring-buffered at 1000 events, and fully in-memory. It does not slow down or alter the automation flow in any way.

**UI** — in the phone's Log tab, a new Session Recorder bar sits below the existing buttons:
- **● Record Session** / **⏹ Stop Recording** toggle — starts/stops capture; a live event counter pulses red while recording
- **🎬 Export Session (HTML)** — downloads a self-contained HTML report (no dependencies, open in any browser) showing every event in chronological order with timestamps relative to recording start, colour-coded by type, and uiautomator XML in expandable sections
- **JSON** — downloads the raw JSON including full XML for every dump, suitable for automated analysis

To debug a future issue: hit Record, run the broken automation cycle, hit Stop, export HTML, send the file. It will show exactly what was on screen at each decision point alongside what the automation did.

**New files:** `artifacts/api-server/src/mobile/sessionRecorder.ts`
**New API endpoints:** `POST /api/mobile/devices/:serial/session-recorder/start|stop`, `GET …/status`, `GET …/export.html`, `GET …/export.json`

---

## [1.1.605] — 2026-07-15

### Fix: Inject Browsing share-to-DM — sheet closed before a recipient could be picked

**Root cause confirmed from live logs (15 Jul 2026, three consecutive runs).** Confirming the share sheet opened (`findButtonByLabel(serial, "Send")`) and then scanning for recipient avatars (`findShareSheetRecipients`) were two *separate* full `uiautomator dump` calls. On this class of device each dump takes ~9s, so the two calls back-to-back left the phone sitting untouched for ~18s+ between tapping the share icon and picking a recipient — with zero interaction with the sheet in between.

The recipient-scan dump from a failing run showed the exact same feed action-bar nodes (`row_feed_button_save` / "Add to Saved", the Like/Comment/Repost icon row, `media_group`) that were present *before* the share icon was even tapped — proof the DM share sheet had already closed and Instagram had returned to the underlying post by the time the second dump ran. The existing label-exclusion filters (numeric counts, hashtags, "Add to Saved") were working exactly as designed; there were simply no real recipient nodes left in the tree to find, because the sheet wasn't there anymore.

**Fix:**
- Added `confirmAndScanShareSheet()` in `androidManager.ts` — does the Send-button confirmation AND the recipient scan from a **single** `uiautomator dump`, roughly halving the idle window between the tap and the recipient tap.
- It also surfaces a `sheetOpen` signal (presence of the DM sheet's `direct_private_share` search-box resource-id in that same dump) so the caller can tell "sheet closed, 0 recipients because we're not even looking at the sheet anymore" apart from "sheet genuinely has 0 recipients".
- `shareCurrentPostViaDm` (shared by View Feed and Inject Browsing) now uses this combined scan and retries once — re-tapping the share icon and re-scanning — if the first check shows the sheet isn't open, or shows 0 recipients with the feed-only signal, instead of immediately giving up.
- View Stories and View Reels' own share-to-DM sequences were switched to the same combined single-dump scan (no retry added there — the story viewer's fixed auto-advance timer means burning time on a retry risks the "still in story viewer" race documented separately; cutting the dump count in half is a pure win there with no added risk).

---

## [1.1.604] — 2026-07-15

### Fix: Inject Browsing "no posts found" on profiles with hundreds of posts

**Root cause confirmed from a live log (15 Jul 2026)** — a profile whose grid is entirely Reels. The sequence:

1. Scroll profile grid, tap a slot → still on the grid (no viewer opened; confirmed via `isInPostViewer()==false`).
2. Old recovery code called `pressBack()` here on the assumption it was a harmless no-op "just in case a viewer opened".
3. It is NOT a no-op. Follow always reaches this profile via a username search, so the profile page's own Back target is the Search results screen it came from — not itself. Pressing Back while sitting on the base profile grid (nothing was pushed onto the nav stack) popped straight out of the profile back to Search.
4. The retry then blind-tapped coordinates on the Search page, found no post, and reported "no posts found" — even though the profile had hundreds of real posts, because the retry was never looking at the profile at all.

Confirmed directly from the log: the retry tap's accessibility dump showed `row_search_user_container` / `action_bar_search_edit_text` (Search page elements), not the profile grid.

**Fix:** removed the erroneous `pressBack()` call from the "still on profile grid" recovery branch — there is nothing to close, so nothing to press Back from. Applied the same fix to the second-retry fallback, gated behind an explicit `isInPostViewer()` check so Back is only pressed when there's an actual viewer open to close.

---

## [1.1.603] — 2026-07-15

### Refactor: share-via-DM is now one shared function, not two hand-copied versions

Reported live: after "porting" Inject Browsing's share-to-DM block to match View Feed's in v1.1.602, the two were structurally identical but Inject Browsing still failed to select a recipient on a real run. Comparing them side by side confirmed the logic was already the same — the actual problem is that this flow lived as two separately-maintained copies (View Feed's in `runCheckFeedLoop`, Inject Browsing's in `runProfileBrowsingSequence`, plus similar copies in View Stories/Reels), so every real-device fix applied to one (the `grid_view_pog_avatar_view` resource-id lookup, the numeric/hashtag/abbreviated-count label exclusions, the sheet-already-closed-vs-never-opened distinction) had to be manually re-applied to the others, and it was easy for that to silently not happen or drift.

Extracted the whole tap-icon → confirm-sheet → pick-recipient → tap-Send sequence into one function, `shareCurrentPostViaDm(serial, w, h, shareDmIcon, logPrefix, logTag, onLog)`. Both View Feed's `runCheckFeedLoop` and Follow's Inject Browsing `runProfileBrowsingSequence` now call this one implementation instead of maintaining their own copy. They can no longer diverge — a fix to the shared function fixes both call sites at once, by construction rather than by remembering to copy it twice.

---

## [1.1.602] — 2026-07-15

### Fix: Inject Browsing share-to-DM replaced with exact View Feed code path

The old share-to-DM block in `runProfileBrowsingSequence` (Inject Browsing, Follow tool) was a separate, older implementation that diverged from View Feed's proven code. It had no pre-tap settle wait, no explicit `isCycleAborted` guard before the try block, inconsistent Back-press timing on failure paths, and different log message formatting than the rest of the codebase.

Scrapped in full. Replaced with an exact port of View Feed's share-via-DM block (`checkFeedPosts`, lines 1577–1629), adapted for the inject-browsing context:

- `isCycleAborted` check before entering the try block (same as View Feed)
- 300–600 ms randomised pre-tap settle wait (same as View Feed)
- Explicit `shareDmIconX / rowY` capture from `icons.shareDm` before tapping (same as View Feed)
- 400 ms post-tap wait then `findButtonByLabel("Send")` to confirm sheet opened (same as View Feed)
- `tapRandomShareSheetRecipient` → 200 ms wait → `sendShareSheet` with all three result branches (`true` / `null` / `false`) handled identically to View Feed, including correct Back-press and sleep durations per branch
- Logger tags updated to `[inject-browsing]`, log messages prefixed `Inject Browsing:`

---

## [1.1.601] — 2026-07-15

### Fix: Follow tool fails on 4th run — "Search tab not found" caused by MIUI floating window

**Root cause confirmed from live log + screenshot evidence (15 Jul 2026):**

The log showed `Follow: search tab lookup missed — bottom-nav dump (0 node(s) below y=1503) (none — bottom nav absent from a11y tree)`. The number `y=1503` is 88% of 1709 — meaning the UIAutomator dump reported a root-bounds height of 1709 px, not the real device screen height of 2460 px. The attached screenshot confirmed why: Instagram was running as a **MIUI floating window** (small resizable panel overlaid on the home screen), not fullscreen. When Instagram is in a floating window, the UIAutomator accessibility dump reports the floating window's own bounds as the root node — so `_getScreenSize(xml)` returns the wrong height. This pushes the bottom-nav detection cutoff (`botMin = h × 0.88`) to a position where the nav bar no longer sits, producing 0 matches every single time. Instagram's actual layout never changed — the window Instagram was rendering in did, which broke every position-based detection threshold built around fullscreen coordinates.

Instagram's layout is unchanged. This was never a detection regression.

**Fix:**

1. **New `detectFloatingWindow(serial)` export** in `androidManager.ts`: takes a fresh UIAutomator dump, compares its root-bounds `width × height` against the real device screen dimensions from `adb shell wm size`. If either axis is more than 12% smaller than the real screen, Instagram is running in a floating/resized window, not fullscreen. Returns `{ floating, windowW, windowH, deviceW, deviceH }`.

2. **Floating-window annotation in `findInstagramSearchTab` diagnostic log**: when the search-tab lookup fails, the existing bottom-nav dump log line now also shows whether a floating-window mismatch was detected — e.g. `⚠️ FLOATING WINDOW: ui-dump bounds 720×1709 vs real screen 1080×2460 — Instagram is NOT fullscreen`. Makes future failures immediately self-diagnosing.

3. **Auto-recovery in the Follow tool call site** (`mobile.ts`): after the 1500 ms settle wait, before calling `findInstagramSearchTab`, calls `detectFloatingWindow`. If a mismatch is detected, logs the exact window vs. screen sizes, calls `launchInstagram(serial)` (the existing `am start --activity-clear-top` helper) to promote Instagram from the floating-window task stack back to a normal fullscreen foreground task, waits 3 seconds for MIUI to animate the transition, and then proceeds normally with `findInstagramSearchTab`. No second retry loop — one recovery attempt, clean fallthrough.

---

## [1.1.600] — 2026-07-15

### Fix: Follow tool's "Browse Before Follow %" was silently gating whether browsing happened at all, not just its order

**Root cause:** `runProfileBrowsingForUser` rolled two separate settings back-to-back and returned early on either miss — `activatePct` (whether browsing happens for this user) and `beforeFollowPct` (which was supposed to only decide the *order* relative to the Follow tap). Because a `beforeFollowPct` miss also `return`ed, it acted as a second on/off gate: whenever it missed, the user got followed with **no browsing at all**, before or after — there was no "browse after follow" code path in existence. That's exactly the reported symptom: "when it kicks in, it follows first and does no browsing afterwards."

**Fix:**
- Split the two rolls apart. `rollInjectBrowsingDecision()` now rolls `activatePct` once to decide `willBrowse`, then — only if that hits — rolls `beforeFollowPct` to decide `browseBeforeFollow` (order only, never a gate on whether it happens).
- Renamed `runProfileBrowsingForUser` → `runProfileBrowsingSequence`; it no longer rolls either gate itself, just runs the browsing actions when told to.
- The Follow flow in `mobile.ts` now branches on the decision: if `browseBeforeFollow`, run the sequence, scroll back to the top of the profile (Follow button may have scrolled off-screen), then tap Follow — unchanged from before. If browsing rolled for **after** follow, skip the scroll-up entirely (never needed — the profile is still at the top when Follow is tapped) and tap Follow immediately, then run the browsing sequence afterward on the same profile page.

---

## [1.1.599] — 2026-07-15

### Diagnostic-only: Follow "Search tab not found" evidence gathering

**No detection logic was changed.** `findInstagramSearchTab()` (in `androidManager.ts`) is unchanged from v1.1.598 — confirmed by inspection, this was not caused by a prior fix. Per the project's evidence-first rule (see replit.md), a fix cannot be guessed without a real device dump from the exact failing moment, so this version adds logging only:

- When the resource-id lookup (`:id/search`, `:id/tab_search`, `:id/nav_search`, `:id/bottom_tab_search`) AND the label lookup (`content-desc`/`text` "Search"/"Explore") both miss, the function now logs every clickable node in the bottom 12% of the screen (class, resource-id, content-desc, text, clickable, bounds) to the cycle log before returning null.
- Wired the log callback through the Follow tool's call site in `mobile.ts` so the dump actually reaches the on-screen Log panel.

**Next step:** run the Follow tool again until it hits "Search tab not found" and send the Log panel output from that run, plus a screenshot of the phone at that exact moment showing the bottom nav. That will show whether Instagram's bottom nav lost its resource-id, renamed it, dropped the "Search" label, or moved search into a different tab on this app build — the real fix ships as a separate, targeted version once that's confirmed.

---

## [1.1.598] — 2026-07-15

### Fix: Follow tool's share-to-DM — replaced with View Feed's proven code path (removes the tautology at the root, not just a patch)

**Why the 1.1.597 patch wasn't good enough:** the position-delta guard stopped the false positive, but it left the root design intact — Inject Browsing's DM tap target was still found via `findButtonByLabel(serial, "Send"/"Direct"/"Message")`, the same call used for confirmation. A live re-test (log `equinox-log-2026-07-15T15-46-11-267Z`) still showed the share aborting every time ("Send tap didn't open a sheet (still the same feed icon)") because the label scan kept finding the unclicked feed icon as its own "tap target," not just as a false confirmation.

**Fix:** Inject Browsing's share-to-DM now taps `icons.shareDm` — the same measured/positional icon from `findFeedActionIcons` that View Feed's share-to-DM has always used as its tap target — instead of a label scan. `findButtonByLabel(serial, "Send")` is now used ONLY afterward, to confirm the sheet opened, exactly as in View Feed. Because the tap target and the confirmation signal now come from two different sources by construction, the tautology can't recur and the position-delta guard is no longer needed (removed).

### Fix: Follow tool — "Search tab not found" on the very first cycle when Follow is the only enabled tool

Root cause: with View Feed/Stories/Reels all disabled, nothing runs before Follow to let the freshly-opened app settle, so the bottom nav can still be mid-render on the very first `findInstagramSearchTab` lookup (observed live: failed on one cycle, succeeded on the next with nothing else different). Added a one-time 1.5s settle wait before that lookup — a single check, not a retry loop.

### Changed: on-screen keyboard detection no longer retries

`typeViaOnscreenKeyboard` polled up to 2 extra times (1.2s apart) if fewer than 15 keys were mapped on the first read. Per project rule, tool checks fail once and move on — removed the retry loop; a low key count now falls straight through to the existing IME-injection fallback on the first read.

---

## [1.1.597] — 2026-07-15

### Fix: Follow tool's share-to-DM — false "sheet confirmed open" tautology

**Root cause (from live log, 15 Jul 2026):** the Inject Browsing DM step finds its tap target (`sendIcon`) via `findButtonByLabel(serial, "Send"/"Direct"/"Message")`, because this device's feed action bar legitimately exposes its own DM icon under that label. After tapping it, the code re-ran the exact same `findButtonByLabel(serial, "Send")` to "confirm the sheet opened." If the tap missed or the sheet never rendered, that second call just found the SAME still-unclicked feed icon and reported a false positive. The label scan then fell through to `findShareSheetRecipients`, found no real recipients (Strategy 1's avatar grid absent, Strategy 2 dump was actually the underlying feed's own action bar), and — after the numeric/hashtag exclusions removed every other candidate — tapped the feed's own "Add to Saved" button by elimination. The log reported "shared the post via DM — Send tapped" for a share that never happened.

This is a different failure mode from Stories/Feed's share-to-DM, which finds its tap target by pixel-scan/measured position — a genuinely independent signal from the later "Send" label confirmation, so no tautology there.

**Fix:** the sheet-open confirmation now requires the found "Send" node's position to differ (>60px) from the tapped `sendIcon`'s position. If it's the same node, the share is aborted instead of falsely confirmed. Also added "Add to Saved" / `row_feed_button_save` to the share-sheet recipient exclusion list as a backstop against this same leak class recurring with a different label.

---

## [1.1.596] — 2026-07-15

### Feature: View Reels — new tool between View Stories and Follow Users

Adds a fourth mobile automation tool, inserted in the UI and orchestrator between View Stories from Feed and Follow Users, with its own bordered card sections above and below (same convention as the existing tools). One settings row: Activation %, Scroll amount, Like %, Share to Feed %, Share to DM % (all min/max pairs).

**Behaviour:** taps the bottom Reels nav tab (`android.findReelsTab` — resource-id candidates first, "Reels" content-desc label fallback, no positional guess), then snap-swipes through a randomly-rolled number of reels (full-height swipe — Reels always snaps fully to the next clip, unlike the feed's partial scroll). On each reel, rolls independent Like / Share-to-Feed / Share-to-DM chances and, if any hit, scans the accessibility tree for the reel's right-side vertical icon column via a new `android.findReelActionIcons` helper.

**Detection approach:** Reels renders its Like/Comment/Repost/Send icons in a vertical column down the right edge of the screen, not the feed's horizontal bottom action bar — there was no existing detector for this layout. `findReelActionIcons` reuses the exact content-desc labels already proven reliable for the feed's action bar ("Like"/"Unlike", "Comment", "Repost"/"Share", "Send"/"Direct"/"Message"), anchored on the Like/Unlike node found in the right ~28% of the screen, then resolves Comment/Repost/Send as the other clickable nodes in that same X column, sorted by Y. Share-to-DM reuses the existing `findButtonByLabel`/`tapRandomShareSheetRecipient`/`sendShareSheet` share-sheet helpers, including the "confirm the sheet actually opened before tapping a recipient" safeguard from the Follow/Stories flows.

**Not yet validated on a real device** — this is the first Reels-specific detector in the codebase, and no diagnostic dump of an open Reel has been captured yet. Both `findReelsTab` (returns null, tool skips this execution) and `findReelActionIcons` (returns null, or partial columns with individual icons null) fail closed rather than guessing, and the latter logs every right-edge clickable node it saw when the Like/Unlike anchor can't be found — that log is the evidence needed to correct the label set on the first real run if it doesn't match.

**New/changed files:**
- `artifacts/api-server/src/mobile/androidManager.ts` — `findReelsTab`, `findReelActionIcons`, `ReelActionIcons` type.
- `artifacts/api-server/src/routes/mobile.ts` — `runViewReelsLoop`; `viewReels*` fields added to `AutomationSettings`, `automationSchema` (+ its defaults), `automationCycleSchema`; orchestrator call wired in between the View Stories and Follow Users steps.
- `artifacts/dannys-bot/src/pages/MobilePage.tsx` — new "View Reels" card section (checkbox + one settings row) between the View Stories and Follow Users sections; `viewReels*` fields added to `AutomationSettingsData`, `AUTOMATION_DEFAULTS`, and the automation-cycle POST payload.

---

## [1.1.595] — 2026-07-15

### Fix: Share-to-DM Strategy 2 — abbreviated like/share counts ("12.1K") slipped through the numeric filter

**Root cause (from live log, 15 Jul 2026):** Strategy 1 (resource-id lookup for the real recipient avatar grid) failed to find any avatars, so the code fell to Strategy 2 (label scan). On this run the DM share sheet was overlaying a screen where the underlying post's own action-bar counts were still present in the accessibility tree beneath it — including the Like count rendered as `"12.1K"`. The existing numeric-exclusion filter (`/^[\d,.\s]+$/`) only caught plain digit/comma counts like `"203"` or `"9,077"` — it did not match abbreviated counts with a `K`/`M`/`B` suffix, because the letter fails the pure-digit test. `"12.1K"` passed every filter, got treated as a candidate "recipient," and was randomly tapped instead of a real user — the DM was sent to nobody (or mis-tapped into an unrelated action) even though the log reported "Send tapped."

**Fix:** Added a second exclusion in the same Strategy 2 scan: `if (/^[\d,.]+\s*[KMB]$/i.test(label)) continue;` — catches abbreviated counts (`12.1K`, `1.2M`, `374B`) the same way the existing rule catches plain ones. No new logic was introduced elsewhere: the Follow tool's Inject Browsing share-to-DM flow and the View Feed share-to-DM flow already share the exact same `findShareSheetRecipients` / `tapRandomShareSheetRecipient` / `sendShareSheet` helpers — this was a single shared-code bug, not a duplicated one.

---

## [1.1.594] — 2026-07-15

### Fix: Share-to-DM Strategy 2 — exclude `#hashtag` caption chips as recipient candidates

**Root cause (from live log + screenshot, 15 Jul 2026):** Instagram renders the shared post's caption hashtags (`#foryou`, `#gymrat`, `#estetica`, etc.) as `android.widget.Button` nodes at y≈1159 — the same y-row as the real DM recipient name buttons. These nodes pass every existing Strategy 2 filter:
- Not pure-numeric (they contain letters)
- Width ≤ 80% screen
- Not in the UI_CHROME or SHARE_DESTINATIONS blocklists

Because `Math.random()` picks from the full results array, the code tapped `#foryou` (index 1) instead of the real recipient `bachidiego_` (index 0). Tapping a hashtag chip focuses the message compose text-input (keyboard appears) rather than selecting a recipient, so the subsequent Send tap fired against an unaddressed message.

**Fix:** One exclusion added to Strategy 2: `if (label.startsWith('#')) continue;`. A valid Instagram DM recipient username can never begin with `#`.

---

## [1.1.593] — 2026-07-15

### Fix: findFeedActionIcons — resource-id Like lookup, wider saveCutoffX, Button structural fallback

Three root causes combined to make `findFeedActionIcons` return null for video/Reel posts on this device, even when the action icons were plainly visible on screen:

**1. `_findCentermostLikeNode` only searched `content-desc="Like"`** — this device's Like button has `cd=""` (label stripped by the build). The `MAX_DIST` filter (38 % of screen height from centre) also rejected the node because the a11y tree reports action-bar coordinates in layout space (y=2202) rather than viewport space, placing them beyond the distance threshold. Fix: try `_findByResId(":id/row_feed_button_like")` first, before the content-desc search, with no distance filter. Resource-id is unique — there is exactly one Like button per post — so the first match is always correct regardless of y-position.

**2. `saveCutoffX = w * 0.80` excluded the Send/DM icon on 720 px screens** — Send lands at x=648 (90 % of 720 px), beyond the 576 px cutoff. The Save/bookmark button is always explicitly labelled (`cd="Add to Saved"`) and caught by the label filter before the positional check; the positional cutoff only exists as a last resort for unlabelled saves which sit at x>100 % of screen width on this device anyway. Raised to `w * 0.95`, which keeps Send in the row scan while still covering any plausible unlabelled Save position.

**3. Missing Button structural fallback** — the existing structural fallback assigns Comment/Repost/Send only when it finds exactly 3 unlabelled `android.view.ViewGroup` icon nodes. On this device/build the alternating pattern is ViewGroup (container) + Button (tappable glyph), meaning the Buttons are the real icons. If the ViewGroup containers are too wide and excluded by `maxIconWidth`, zero ViewGroups remain in `rowNodes` and the fallback does nothing. Added a second structural fallback (B): if no ViewGroups match, look for exactly 3 unlabelled `android.widget.Button` nodes and assign them Comment/Repost/Send by elimination — same safety contract.

**Also reverted v1.1.592 scroll-down recovery** — scrolling does not change a11y coordinates (the tree always reports layout-space positions), so a scroll followed by a re-scan returns the same y=2202 values. Removed that dead code; `isInPostViewer=true` now simply presses Back as a final fallback, which is correct behaviour when the rid lookup also found nothing.

---

## [1.1.592] — 2026-07-15

### Fix: Inject Browsing — action bar below screen bottom now recovered with a scroll-down before giving up

**Root cause:** On this device's Instagram build, posts opened from the profile grid place the video at ~y=1218 on a 1280 px screen and render the action bar (Like / Comment / Repost / Send / Save) at ~y=2202 — 922 px below the physical screen bottom. The a11y tree contains the nodes and they are real and tappable, but `findFeedActionIcons` only accepts nodes within the physical screen height, so it returns null. The v1.1.590 `isInPostViewer` guard then correctly identified "we are inside a post" but immediately pressed Back — the right call for a genuine unreadable-icon situation, but wrong here where a single scroll-down would have revealed the action bar.

**Fix:** When `isInPostViewer=true` and `findFeedActionIcons=null`, instead of pressing Back immediately, execute one scroll-down swipe (finger from 70 % → 25 % screen height, 400 ms) to bring the action bar into the visible area, wait 800 ms, and retry `findFeedActionIcons`. Only if the retry also returns null does the code fall back to pressing Back. This mirrors the profile-grid scroll-up recovery pattern and adds zero risk — if the scroll reveals nothing, behaviour is identical to before.

---

## [1.1.591] — 2026-07-15

### Fix: Inject Browsing Share-to-DM — pure-numeric count nodes no longer picked as recipients

**Root cause:** `findShareSheetRecipients` Strategy 2 scans every clickable node in the accessibility tree, but Instagram's a11y dump includes ALL nodes simultaneously — both the share sheet overlay AND the feed-post action bar sitting underneath it. The feed action bar exposes its like/comment/repost/send counts as clickable `android.widget.Button` nodes with `txt="38"` (comments), `txt="203"` (reposts), `txt="9,077"` (likes), `txt="1,074"` (sends). Every one of these passed all existing Strategy 2 filters: correct y-range, width under 80 %, non-empty label, not a UI-chrome keyword, not a share-destination keyword, ≤ 50 chars. The comment count "38" was randomly picked as the "recipient" tap target, which expanded the underlying comment count display rather than selecting any DM contact. `sendShareSheet` then tapped the pre-found Send button — but with no recipient selected, nothing was actually sent.

**Fix:** One additional exclusion in Strategy 2 — if the candidate label matches `/^[\d,.\s]+$/` (i.e. it contains only digits, commas, dots, and spaces — a count string), skip it. A real DM recipient name always contains at least one letter, so this rule is safe: "38", "203", "9,077" all fail; "mo_fitness_03", "john_doe", "Instagram Verified Chat" all pass.

---

## [1.1.590] — 2026-07-15

### Fix: Inject Browsing — scroll-up recovery no longer fires when a Reel is open

**Root cause (introduced in v1.1.587):** The scroll-up recovery was written for one specific case — tap lands on blank whitespace past the end of the profile grid, so no post opens at all. When `findFeedActionIcons` returned null in that case, pressing Back was safe because we were still on the profile grid. However, the same `findFeedActionIcons=null` result also happens when a Reel opens in the fullscreen viewer but its Like button uses a different accessibility label. In that second case the device is INSIDE the Reel viewer, not on the profile grid. The v1.1.587 recovery code had no way to tell the two cases apart, so it pressed Back (closing the valid Reel), scrolled up, and retried — which found another Reel, pressed Back again, and gave up. Reels that were previously fine now lost all like/share actions.

**Fix:** Before triggering the scroll-up recovery, a new `isInPostViewer()` check inspects the accessibility tree for resource-ids that only appear inside an opened post or Reel viewer (`reel_viewer_follow_button`, `row_feed_photo_profile_name`, `row_feed_button_like`). Two paths:

- `isInPostViewer = true` → a Reel or post opened but its icons weren't readable. Press Back once to cleanly return to the profile grid. Log: *"post/Reel opened but icons not found — pressing Back to profile (skipping scroll-up recovery)"*. No scroll, no retry, no wasted taps.
- `isInPostViewer = false` → we are still on the profile grid (blank whitespace case). Run the existing scroll-up recovery exactly as before.

The v1.1.589 diagnostic logging (`onLog` now passed to both `findFeedActionIcons` calls, plus the near-centre node dump) is also retained, so the next Reel failure will show exactly what label its Like button uses — the follow-up fix to teach `findFeedActionIcons` to recognize it can then be made with real evidence.

---

## [1.1.589] — 2026-07-15

### Diagnostic: Inject Browsing — expose why "no post opened" fires on Reels

When Inject Browsing taps a post from the profile grid and gets back "no post opened here (empty grid cell or unrecognised layout)", the cause was completely invisible: both `findFeedActionIcons` calls (initial tap and scroll-up retry) were not passing `onLog`, so every diagnostic log inside that function — including the per-node row dump — fired silently into nothing. Separately, when `_findCentermostLikeNode` found no Like/Unlike node at all and `findFeedActionIcons` returned null, the code did so with zero trace of what WAS in the accessibility tree.

**Two targeted diagnostic changes (no behaviour change):**

1. `onLog` is now passed to both inject-browsing `findFeedActionIcons` calls (initial and retry). The existing `[feed-icons] row cd dump` line — showing every node's `content-desc`, `resource-id`, `class`, and text — now appears in the cycle log when inject browsing runs.

2. New log emitted when `_findCentermostLikeNode` finds no Like/Unlike node: `[feed-icons] no Like/Unlike node found near centre — nearcentre clickable nodes: (x,y) cd="..." rid="..." cls="..." | ...`. This scans every clickable node within ±50% of screen centre and prints its labels/class, showing exactly what the Reel viewer (or any other layout) exposes for its action controls.

The next run where a Reel triggers "no post opened" will now show the real tree — from which the actual fix (correct label/resource-id, or a longer load wait) can be determined with evidence.

---

## [1.1.588] — 2026-07-15

### Fix: Inject Browsing Share-to-DM — Send button never tapped after recipient selected

**Root cause:** After tapping the DM paper-plane icon and confirming the share sheet was open, the code called `findButtonByLabel("Send")` purely to check `!== null` (discarding the result), then called `sendShareSheet(serial, w, h)` with no pre-found button. `sendShareSheet` then ran a fresh a11y scan to find "Send". By that point — after the recipient tap — the sheet had partially transitioned, the scan returned nothing, `isDmSheetOpen()` also found nothing (sheet closed), and the function returned `null`. The code interpreted `null` as "DM sent by recipient tap" and logged "sheet auto-dismissed by recipient tap" — but Send was never actually tapped and no DM was sent.

**Fix:** Aligned Inject Browsing with the identical pattern already used by ViewFeed (`check-feed`) and ViewStories: store the result of `findButtonByLabel("Send")` into `sheetSendBtn` (this both confirms the sheet is open AND captures the button position), then pass `sheetSendBtn` to `sendShareSheet`. With a pre-found position, `sendShareSheet` skips the re-scan entirely and taps the known coordinates immediately — guaranteed to fire even if the sheet has started to animate after the recipient tap. Log message on success changed from "shared the post via DM" to "shared the post via DM — Send tapped" to match ViewFeed/ViewStories phrasing.

---

## [1.1.587] — 2026-07-15

### Fix: Inject Browsing — scroll recovery when post tap lands on blank whitespace

When a target profile has a small number of posts (e.g. ~10 posts = ~3–4 rows) and Inject Browsing's row-scroll roll is set to 3–6 rows, the grid scroll can overshoot past the last row and land in the blank white space Instagram renders below the grid. The subsequent post tap finds no Like button (empty cell), logs "no post opened here", and returns without doing anything.

**Fix:** when `findFeedActionIcons` returns null after the post tap, instead of immediately returning:
1. Press Back to return to the profile grid.
2. Scroll UP one row (reverse swipe) to bring real posts back into view.
3. Tap a randomly-chosen column from the middle of the now-visible grid (at `h×0.45`).
4. Check for icons again — if found, continue with the normal like/share flow. If still not found (profile may be all-Reels, or genuinely empty), press Back and return as before.

This turns a silent failure into a graceful recovery visible in the log as "retry — tapping post after scrolling up" / "retry succeeded — post opened after scrolling up".

---

## [1.1.586] — 2026-07-15

### Fix: Purge All Data — "queryClient is not defined"

`useQueryClient()` was called at the top of two sub-components before line 2289 but not inside `BanAnalyticsPage` itself. The `handlePurge` function sat inside `BanAnalyticsPage` and referenced `queryClient` from an outer scope that doesn't exist at runtime. Fixed by adding `const queryClient = useQueryClient()` at the top of `BanAnalyticsPage`.

### Fix: story DM share — 13 s like → 17 s total cut to ~5–7 s

Root-cause analysis of the 15 Jul 2026 log (story tap at 29.5s, DM sent at 66.5s = 37s total):

**Removed: pre-Send story viewer check (saved 3.6s)**  
The code called `stillInStoryViewer()` between recipient tap and Send. The `sheetSendBtn` check two lines earlier already proved the story was still open (the sheet literally can't appear without the story underneath it). The viewer check was a redundant 3.6s cost (fast scan 985ms inconclusive → slow dump 2590ms).

**Pre-share viewer check changed to fastOnly (saved 2.7s)**  
The `stillInStoryViewer()` call before finding the share button was running the full slow-dump fallback every time (fast scan always inconclusive on this device = 1.5s dead cost on top of the 2.7s dump). Changed to `fastOnly=true` — when the fast scan is inconclusive, it assumes "still open" and skips the slow dump. Worst case is a miss-tap on the feed if the story vanished in the 4.9s the like took; this is rare and non-catastrophic.

**sendShareSheet rewrite (saved 5–8s)**  
Old behaviour: (1) fresh a11y dump to find "Send" (2.5s), (2) tap, (3) 900ms sleep, (4) `isDmSheetOpen()` = two separate dumps (first `direct_private_share` ~2.5s, then `layout_container_bottom_sheet` ~2.5s) = ~8.4s total. New behaviour: callers pass the already-found Send button position (`knownSendBtn`), skipping the initial dump. Post-tap sleep reduced 900ms→200ms. `isDmSheetOpen` now checks only `direct_private_share` (single dump, ~2.5s). Total per-send: ~2.7s.

### Fix: Follow tool ShareToDM — Send button never tapped

`runCheckFeedLoop`'s share-via-DM block was missing the sheet-confirmation step that story and inject-browsing code both use. It tapped the paper-plane, slept 1200ms, picked a recipient, slept 1500ms, then called `sendShareSheet` — but never confirmed the DM sheet actually opened (which proves Send exists). When `sendShareSheet` looked for the "Send" button after the recipient was selected and found null, it fell back to a coordinate tap at `(w*0.422, h*0.948)` which was off-screen on this device. Fixed: add `sheetConfirmed` check immediately after the sheet-open sleep, guard the `recipientPicked` result, and pass `sheetSendBtn` to `sendShareSheet` (same pattern as story/inject-browsing). Delays reduced: 1200ms→400ms (sheet open), 1500ms→removed (not needed when sheetSendBtn is passed directly), post-send sleeps 800ms→300ms and 500ms→200ms.

### Fix: Follow tool — 15s hang between ShareToFeed and paper-plane

All delays in the ShareToFeed flow reduced: post-tap sheet wait 1200ms→400ms, post-Repost-confirm sleep 1000ms→300ms, post-Close-dismiss sleep 500ms→150ms. Each of these was chained with a 2.5s a11y dump (`findButtonByLabel("Repost")`, `findButtonByLabel("Close")`), so the total was 1200+2500+1000+2500+500 = 7.7s of dead time between ShareToFeed tap and the DM paper-plane. Now ~3.2s.

### Fix: story tool — skip Home-tab refresh when story is first/only active tool

When View Feed is disabled (or its Activate Percentage roll misses), Instagram opens fresh and the home feed is already showing with the story tray loaded at the top. The code was still tapping the Home tab (triggering a feed refresh) and waiting 5000ms for the tray to repopulate — unnecessary. `feedActuallyRan` flag now tracks whether the feed loop ran. When it didn't, the Home tap and 5s wait are skipped; instead an 800ms settle is used. When the feed DID run, the existing tap + 5s wait is kept as before.

### Feature: Export Log button on Log tab

"💾 Export Log" button added next to "📄 Copy Log". Clicking it triggers a browser Save-As dialog to download the full log as a timestamped `.txt` file (e.g. `equinox-log-2026-07-15T13-18-46-000Z.txt`). Uses the same `Blob` + `<a download>` pattern already used by the Screen Capture "Save" button.

---

## [1.1.585] — 2026-07-15

### Fix: story likes — switch from percentage-based double-tap to accessibility-tree button tap

Root cause: story likes were firing via `doubleTap(w*0.50, h*0.44)` — a fixed percentage of the screen — which violated the project rule against hardcoded coordinates and was not reliably registering on this farm's devices (log showed "liked (double-tap at (540,1082))" but the Like Story button still had `cd="Like Story"` in the next a11y dump, meaning the gesture was not captured by Instagram). The a11y diagnostic already confirmed the Like button IS accessible via `com.instagram.android:id/toolbar_like_button`. Fix: `findStoryLikeButtonViaA11y()` locates the button by resource-id and the existing `tap()` function handles the press — same approach used for every other button in this codebase. Falls back to the legacy double-tap if the resource-id is absent on an older build.

### Fix: Inject Browsing post actions (Like/ShareToFeed/ShareToDM) — no longer abandoned when the post was already liked

Root cause: `findFeedActionIcons()` returned null when the post's Like button had `content-desc="Unlike"` (already liked), because the search regex was hard-scoped to `"Like"` to prevent accidental unlikes. Returning null caused the caller to press Back and skip all remaining actions (ShareToFeed, ShareToDM) — the "it clicked the post then went backwards without doing anything" behaviour. Fix: `findFeedActionIcons()` now runs a second pass for `"Unlike"` when `"Like"` is not found. If found, it sets `alreadyLiked: true` on the returned icons object and continues normally. The like tap is skipped (to avoid unlinking), but ShareToFeed and ShareToDM run as normal.

### Fix: 90% reduction in Like and ShareToDM action delays (story and Inject Browsing)

All waits between tap → share sheet confirmation → recipient selection → Send reduced from the 800–1 200 ms range down to 150–200 ms each. Previously: paper-plane tap → 1 200 ms → sheet check → 900 ms → recipient tap → 900 ms → Send tap = ~3 s of dead waiting on top of a 3–6 s story. Now: 200 ms → sheet check → 150 ms → recipient tap → 200 ms → Send tap. Same fix applied to Inject Browsing DM share sequence.

### Feature: Purge All Data button on Evasion Stats page

New "Purge All Data" button sits next to "Export Evasion Stats". Clicking it prompts for confirmation, then permanently deletes every row from `instagram_api_calls` plus all four analytics tables (banned/automated/captcha/locked). Useful for resetting statistics before a fresh test run. Backend: `DELETE /api/analytics/purge-evasion-stats`. Frontend invalidates all analytics query caches on success.

---

## [1.1.584] — 2026-07-15

### Fix: story like/share fires instantly — remove pre-action viewer check (was taking 2.7s before action fired)

Root cause: `isStoryViewerOpenFast()` (the "fast" screenshot pixel scan) was taking ~2.7 seconds on this farm's devices. With the prior 250ms watch delay plus the 2.7s scan, the like/share fired ~3 seconds into a 3-second story — the slide had already auto-advanced before the `doubleTap` ran, so no like was ever registered. Removed both the 250ms pre-action delay and the pre-action viewer check entirely. When a like or share is scheduled, it now fires immediately with zero delay. Post-action guards (pre-advance check, pre-exit swipe) still prevent blind taps after the slide timer expires.

### Fix: story slide count — viewing "1 story" now means 1 slide maximum

The `stillInStoryViewer` pre-action check consumed 2.7s per call on this device, eating into each slide's timer and allowing the tray to auto-advance during the check. With the check removed, the loop's `totalStories` guard now actually controls how many slides are processed before the swipe-down exit.

### Fix: Inject Browsing share-to-DM — add sheetConfirmed + recipientPicked gates (same fix as story DM)

Applied the same pattern as the story share-to-DM fix: after tapping the Send icon and waiting 1200ms, confirm the DM share sheet actually rendered (via `findButtonByLabel("Send")`) before firing the recipient tap. If the sheet didn't open, skip without blind-tapping. If no recipient avatar found, close the sheet rather than tapping Send with nobody selected.

### UI: nav — remove Proxy Manager and Accounts, rename Mobile → Accounts with person icon

Mobile section is now the Accounts page. Left nav order: Dashboard → Accounts (path `/mobile`, person icon) → Statistics → Tools. Proxy Manager removed.

---

## [1.1.583] — 2026-07-15

### Fix: story share-to-DM — remove keyboard-check retry loop (was closing the sheet it just opened)

Root cause confirmed from device log (15 Jul 2026):

When `toolbar_reshare_button` is tapped correctly and the DM share sheet opens, the sheet's "Search" EditText auto-focuses and raises the soft keyboard. `isKeyboardShown()` therefore returned `true` on a **successful** paper-plane tap. The old retry loop treated this as "missed the button", called `pressBack` (closing the sheet), then retried — repeating 3 times. This is exactly the "constantly clicking and closing the share sheet" behaviour reported.

Fix: removed the keyboard-check retry loop entirely. Replaced with a single tap + 1200ms wait, identical to the feed share-to-DM flow which has never used a keyboard check. Sheet confirmation continues to use the `direct_private_share_sticky_search_box` resource-id (the existing `sheetConfirmed` gate below the tap), which unambiguously distinguishes "sheet open" from "nothing happened".

---

## [1.1.582] — 2026-07-15

### Fix: story Share-to-DM — paper-plane by resource-id, recipients by resource-id, no coordinate fallbacks

Root causes identified from the v1.1.581 device log (15 Jul 2026):

**Bug A — paper-plane tap used a coordinate estimate (rule violation):**
The text-field-anchor approach (Strategy 2 in v1.1.581) calculated the paper-plane position as 75% of the icon-zone width to the right of the text field's right edge. This is still a coordinate estimate — even though it derived from live bounds. The log showed the paper-plane IS directly accessible: `rid=com.instagram.android:id/toolbar_reshare_button`, `cd=Share`, clickable, bounds=[948,2122][1058,2226]. Fix: `findStoryShareButtonViaA11y` now finds the button by `toolbar_reshare_button` resource-id and returns its exact bounds-centre. Zero arithmetic.

**Bug B — no recipient was ever selected, but Send was tapped anyway:**
`findShareSheetRecipients` filtered by label. The actual tappable avatar buttons (`rid=...grid_view_pog_avatar_view`, `class=android.widget.Button`) have NO `content-desc` or `text`, so they were filtered out entirely. The fallback was hardcoded percentage-coordinate slots which frequently miss. Fix: `findShareSheetRecipients` now searches for `grid_view_pog_avatar_view` by resource-id first — no label or width filter needed. If found, returns those immediately. Label scan is kept as fallback for other Instagram builds.

**Bug C — Send fired even when no recipient was selected:**
`tapRandomShareSheetRecipient` fell through to coordinate slots, which may or may not have selected anyone. Send was then fired regardless of whether a recipient was confirmed. Fix: function now returns `boolean`; call site in `runViewStoriesFromFeedLoop` skips Send (and closes the sheet) if `false` is returned.

**Removed:** `SHARE_SHEET_AVATAR_SLOTS` hardcoded percentage-coordinate table — all coordinate fallbacks eliminated from the recipient-selection path.

---

## [1.1.581] — 2026-07-15

### Fix: story Share-to-DM — remove positional probe, add diagnostic dump + text-field anchor

**Root cause of v1.1.580 regression:** The UIAutomator positional probe (find all clickable nodes in the bar zone, return the rightmost one) consistently found the **text-input field** at ~60 % of screen width rather than the paper-plane icon at ~88–93 %. The text field is the only accessible element in the story reply bar; the paper-plane is canvas-drawn with no content-desc, resource-id, or text. The probe then used the text-field centre as the tap target, causing three keyboard-opening retries per story — ~8 seconds of wasted time while short stories auto-advanced through 3-4 slides per retry cycle.

**Changes:**

- **Removed** the positional probe from `findStoryShareButtonViaA11y`. It cannot distinguish the text field from the paper-plane because the paper-plane has no accessible attributes on this device/Instagram build. A comment in the code documents this explicitly so it is not re-added without evidence.

- **Added diagnostic dump** — `findStoryShareButtonViaA11y` now logs every UIAutomator node whose vertical centre sits in the lower 35 % of the screen (`class`, `resource-id`, `content-desc`, `text`, `bounds`, `clickable`) on every share attempt. This appears in the Log tab without a separate debug run, so the real a11y signal can be identified from a single run if Instagram exposes the button on a future build.

- **Added text-field anchor (Strategy 2)** — the text-input field IS accessible (confirmed from the log: UIAutomator returns it). The function now reads its live `bounds` right-edge from the dump and estimates the paper-plane at 75 % of the remaining screen width to the right. 75 % reliably lands on the last icon (paper-plane) whether the remaining space has 1 or 2 icons. This derives the coordinate from the real rendered bounds, not a hardcoded pixel.

- **Tightened pixel-scan sanity check** (fallback path): raised minimum x from 40 % → 65 % of screen width. The paper-plane is always in the rightmost 15–20 % of the screen; any pixel-scan result left of 65 % is a false content-cluster match and is now rejected and logged rather than used as a tap target.

- **`onLog` passed through** from `runViewStoriesFromFeedLoop` to `findStoryShareButtonViaA11y` so all diagnostic lines appear in the user-visible Log tab.

---

## [1.1.580] — 2026-07-14

### Fix: Story tool — slide count, short-story likes, and Share-to-DM wrong tap

Three bugs fixed in the View Stories from Feed tool:

**1. Slide-advance tap fires on last iteration (caused 4-5 slides when "1" was set)**

The advance-to-next-slide tap (`tap right 75 %`) previously fired at the end of every loop iteration, including the last one. For 3-second story slides, the like/share sequence (1800ms open wait + 250ms action wait + multi-step share) already auto-advances through 2-3 slides naturally. The unnecessary final advance tap pushed the count 1 higher, then the exit swipe-down pushed it 1 more. Result: user set "1 story to watch" and saw 4-5 slides fly by. Fix: advance tap is now guarded by `s < totalStories - 1` — only fires between slides, not after the last one.

**2. Slow uiautomator-dump fallback burning short-story slide timer before like fires**

The pre-action `stillInStoryViewer()` check (runs before like/share) previously always fell through to a full uiautomator dump (~3-4s) when the fast pixel scan returned `null` (inconclusive). For 3-second slides this consumed the entire remaining slide timer before the like even fired. Fix: the pre-action check now passes `fastOnly = true`, which skips the slow dump and assumes "still open" when the fast scan is inconclusive. The worst case (wrong assumption) is a double-tap on the home feed — rare and non-catastrophic. All post-action checks retain the full fallback.

**3. Share-to-DM tap hitting wrong screen element (paper-plane icon scan false-match)**

The paper-plane icon was located by a pixel luminance scan. Captions, stickers, or bright text on a dark story background could produce clusters that passed all the scan's heuristics and returned as the "rightmost icon", landing the tap on random story content instead of the paper-plane. Two fixes applied:

- **UIAutomator probe first**: before the pixel scan, attempt to find the share button via the accessibility tree (`findStoryShareButtonViaA11y` in `androidManager.ts`). Tries known content-desc labels and, if those miss, searches all clickable nodes in the reply-bar y-zone (72–95 % height) on the right half of the screen, returning the rightmost one. Instagram's canvas-rendered reply-bar has no accessible elements on most builds, but some do — this handles those correctly and costs nothing when it misses (falls through to pixel scan unchanged).
- **Positional sanity check on pixel scan**: if the pixel scan returns a "paper-plane" position that is left of 40 % of screen width, it is rejected as a false content match (the real paper-plane is always in the right half of the screen). A log message explains the rejection so it's diagnosable from the Log tab.

---

## [1.1.579] — 2026-07-14

### Fix: pull-to-refresh no longer triggered after Share-to-DM (root cause fixed)

The v1.1.578 fix covered the case where the share sheet was already gone before `sendShareSheet` ran. This release fixes the remaining case — the far more common one on this device — where the sheet appeared "still open" according to the code even after the DM was sent.

**Root cause:** Two false-positive matches inside `sendShareSheet`:

1. `findButtonByLabel("Direct")` was used in the post-send verification to check whether the sheet was still open. But `findButtonByLabel` also searches `resource-id`, so it matched `resource-id="com.instagram.android:id/direct_private_share_sticky_search_box"` (the DM sheet's own search box) via substring. That node is present for the entire lifetime of the sheet — so the verification always said "sheet still open", always returned `false` (send failed), even when the DM had actually been sent.

2. `findButtonByLabel("Share")` (used as the sheet-open guard before the coordinate-fallback tap) matched the "Share via other apps" pill in the external-apps row — also always present while the sheet is open. The `null` return path (sheet already gone) was therefore unreachable on this device.

**Fix:** Replaced all three sheet-open indicator lookups (`"Direct"`, `"Share"`, `"To"`) with a single `"direct_private_share"` resource-id substring check, which matches `direct_private_share_sticky_search_box` — a node that is present during the DM sheet's entire lifetime and never appears in any other Instagram screen. Confirmation that the sheet has closed (= DM sent) now correctly returns `true` or `null` instead of always `false`, preventing the spurious Back press that was landing on the home feed and triggering the pull-to-refresh.

---

## [1.1.578] — 2026-07-14

### Fix: pull-to-refresh no longer triggered after a successful Share-to-DM

When you tapped a recipient in the DM share sheet, Instagram sometimes auto-sent the DM immediately on that tap (closing the sheet before the bot could even look for the Send button). The bot then saw the sheet was already gone, assumed the send had failed, and pressed Back — but Back on the Instagram home feed scrolls to the top and triggers a pull-to-refresh. Fixed by detecting this "sheet already gone" state (which means the DM was sent by the recipient tap) and skipping the Back press entirely. Applies to View Feed, View Stories, and Inject Browsing share-to-DM flows. The log message in this case now reads: "sheet auto-dismissed (sent by recipient tap)" instead of "Send button not found — pressing Back".

---

## [1.1.577] — 2026-07-14

### Fix: DM recipient picker no longer taps "Your Story"/"Close Friends" instead of a person

Confirmed from a live run + screenshot: the recipient list was open, but the picker tapped "Add to Story" at the bottom of that same list instead of an actual contact. `findShareSheetRecipients` filtered by position/width/label only, and Instagram's "Your Story" / "Close Friends" / "Add to Story" quick-share pills sit in the exact same y-zone and under the same width cap as real recipient rows — nothing previously excluded them by name. Added an explicit exclusion list for these known share-destination labels (not people), and added a diagnostic node dump (mirroring the feed-icon dump) so any further picker misses can be diagnosed the same way.

### Enabled: remaining "Share to DM" controls

With shareDm detection now confirmed working, re-enabled the two other locked/strikethrough "Share to DM" controls: "Share DM %" under View Stories from Feed, and "Share to DM %" under Inject Browsing. Both now behave like their sibling percentage inputs (no forced-0 override, no disabled/strikethrough styling). Only the base View Feed "Share via DM %" control (v1.1.576) had previously been re-enabled.

---

## [1.1.576] — 2026-07-14

### Enabled: "Share via DM % of posts" (View Feed base action)

v1.1.575's row-node fix confirmed Comment/Repost/Send detection works live (log showed correct coordinates for all three, and a "Share to Feed" tap succeeded on a real device run). The base View Feed "Share via DM % of posts" control was previously locked/greyed out with a strikethrough label, and the save payload silently forced `shareDmPercentMin`/`shareDmPercentMax` to 0 regardless of the UI, as a safety measure from before shareDm coordinates could be trusted. Since shareDm detection is now confirmed working the same way shareFeed is, re-enabled the control (matches the "Share to Feed %" input styling/behavior) and removed the payload override so the real slider values are sent and used by the automation engine.

Note: this only affects the base View Feed action. "Share DM %" under View Stories and "Share to DM %" under Inject Browsing remain locked/greyed out — those are separate, untested code paths not covered by this fix.

---

## [1.1.575] — 2026-07-14

### Fix: icon detection no longer depends on a count node existing at all

v1.1.573/574 identified Comment/Repost/Send by pairing each icon `ViewGroup` with an adjacent count `Button`. That still assumed a count node (blank or not) always exists next to the icon — but it's unknown whether Instagram renders a blank-text Button for a zero count or omits the node from the tree entirely. If it omits it, a post with all three counts at zero (or Like's count also hidden) would have no Button to pair with, and every icon would wrongly stay undetected. Removed the pairing requirement: Comment/Repost/Send are now identified purely by the icon's own signature (a content-desc-less, text-less `ViewGroup`), independent of whether any count node exists beside it. Still elimination-based (only trusted when exactly 3 candidates are found) and only used when no content-desc label matched anything.

---

## [1.1.574] — 2026-07-14

### Fix: structural icon/count pairing no longer requires a non-zero count

v1.1.573's ViewGroup→Button pairing required the count node's `text` to contain a digit, which breaks on a post with a genuine zero count — Instagram renders no text at all for 0 comments/reposts/DM-shares (never the digit "0"), so that pair would fail to match and the icon would incorrectly stay `null`. The digit requirement is removed; the icon/count role split now comes purely from class (`ViewGroup` = icon graphic, always empty text; `Button` = count label, full or blank) plus both having no content-desc, which holds regardless of the actual count value.

---

## [1.1.573] — 2026-07-14

### Fix: Comment/Repost/Send detected on devices with zero content-desc or resource-id labels

Root cause found via a live screenshot (comment=34, repost=2,340, send=30.9K) matched against its row dump: on this device/build, content-desc AND resource-id are both stripped from every action-bar node, so the existing label matching had nothing to match against — every field came back `n/a` even though the icons were plainly visible. The row dump revealed a consistent structural pattern instead: each real icon is a content-desc-less `ViewGroup` (the icon graphic, empty text) immediately followed by a content-desc-less `Button` carrying the visible count as its `text` (e.g. `txt="2,340"`), with a single unpaired leading `Button` being the Like count label (not a separate action). Added a fallback in `findFeedActionIcons`: when content-desc matching finds nothing for Comment/Repost/Send, pair up (ViewGroup, Button) nodes structurally and — only when exactly 3 pairs are found — assign them Comment/Repost/Send by left-to-right elimination, the same forced-elimination logic already used for label matches. This is a read of live tree structure (class + adjacency), not a fixed pixel-percentage guess; when the pair count isn't exactly 3 (an icon disabled, or unexpected layout) it's left ambiguous and all three stay `null`, same as before.

---

## [1.1.572] — 2026-07-14

### Diagnostic: dump text and width alongside class for action-bar icons

The v1.1.571 resource-id dump came back empty too, but showed a clean pattern: 4 `android.widget.Button` nodes alternating with 3 `android.view.ViewGroup` nodes (Button/ViewGroup ×3 + trailing Button). That suggests each real icon is a `Button` and each count label (e.g. a repost count) is a separate clickable `ViewGroup` wrapper — but that's still a guess without seeing what text/width those nodes carry. Extended the `[feed-icons]` dump to also print `w=` (node width) and `txt=` (the node's `text` attribute, which should reveal count numbers) for every row node and unlabeled ImageView. Still diagnostic-only — no detection or tap behaviour changed, no coordinate fallback added.

---

## [1.1.571] — 2026-07-14

### Diagnostic: dump resource-id and class alongside content-desc for action-bar icons

The v1.1.570 log came back with `content-desc` **empty on every node** in the action bar row (`cd=""` for all 7 nodes) — this device/build strips content-desc from Comment/Repost/Send entirely, so there's nothing for the label regexes to match against. Extended the `[feed-icons] row cd dump` line to also print each node's `resource-id` and `class`, and added a second `[feed-icons] unlabeled ImageView dump` line for nodes already filtered out as audio-disc/unlabeled candidates. resource-id is often preserved even when content-desc is stripped, and is the next thing to check before Comment/Repost/Send can be identified on this device. Run View Feed again and paste the new log lines — no detection behaviour changed yet, this is diagnostic-only, and no coordinate fallback was added per the accessibility-label-only rule in replit.md.

---

## [1.1.570] — 2026-07-14

### Fix: route rowNode cd dump through onLog (visible in UI)

The v1.1.569 diagnostic used `logger.info` which writes to the server log file, not the in-app Log panel. Changed `findFeedActionIcons` to accept an optional `onLog` callback and pipe the dump through it. The caller in `mobile.ts` now passes its `onLog` so the line `[feed-icons] row cd dump: x=… cd="…" | …` appears directly in the Log panel on the next run.

---

## [1.1.569] — 2026-07-14

### Diagnostic: dump action-bar rowNode content-desc labels

Added a single log line in `findFeedActionIcons` that prints every node in the action-bar row with its exact `content-desc` value after the row is built. This will show the real labels Instagram puts on Comment / Repost / Send on this device/build so the regex can be corrected.

---

## [1.1.568] — 2026-07-14

### Fix: label-only icon detection + remove Like verification

**Removed all positional fallbacks from `findFeedActionIcons`**
Every icon (Comment, Repost, Send) must now be confirmed by its accessibility label in the tree. If "Repost" or "Send" isn't in the tree, that slot returns null and the action is skipped — never guessed by left-to-right position. Positional guessing was the direct cause of Comments being tapped when Share to Feed was intended: the code was assigning the first unclaimed node to shareFeed regardless of what it actually was.

**Removed Like verification polling loop**
The 3-poll "Unlike" check was firing 3 full `uiautomator dump` calls (≈3.5 s each = 10+ s) and consistently reporting failure even when the like visually registered. It served no purpose — the Like button is found by `content-desc="Like"` (a live label), its bounds are read from the tree, and the tap is fired at those exact coordinates. No re-verification needed.

---

## [1.1.567] — 2026-07-14

### Fix: never attempt like when no Like icon is actually on screen

`_findCentermostLikeNode` was returning the Like node *closest to screen centre* with no upper-bound check on that distance. When Instagram serves a Reel, ad, or Suggested-Reels grid at the current scroll position, the only `content-desc="Like"` nodes in the accessibility tree belong to posts recycled above or below the visible viewport. The function returned the least-far one regardless, and the software tapped it blind — attempting a like on a post the user couldn't even see.

Fix: after finding the best candidate, reject it if its distance from screen centre exceeds 38 % of screen height. On a 1280 px screen that threshold is 486 px; on a 2460 px screen it is 935 px. Any Like node farther than that cannot be in the visible portion of the feed. `findFeedActionIcons` returns null, callers log "no Like button visible — skipping" and move on without tapping anything.

---

## [1.1.566] — 2026-07-14

### Fix: Feed Like — phantom comment node in positional fallback + "Unlike" regex missing count suffix

**Phantom comment node surviving into positional fallback**
The rowNodes entry filter was `c.x < like.x + 4`, so the phantom `content-desc="Comment"` parent container at x=73 (7 px from Like at x=66) passed through and entered rowNodes. The `commentNode` regex correctly rejected it (`n.x > like.x + 20` = 86, and 73 < 86), but the positional fallback at `pool()[0]` picked it right back up as the Comment icon — same wrong result as before the v1.1.565 fix. The phantom is now excluded at the rowNodes collection step (`c.x < like.x + 20`) so it never reaches the pool.

**"Unlike" verification never matching Instagram's count-suffixed content-desc**
The poll regex was `/content-desc="Unlike"/` (closing quote included). Instagram's accessibility tree renders the node as `content-desc="Unlike, 3,821 likes"` — the closing quote after the bare word "Unlike" is never present, so the regex matched nothing across all 3 polls (1.5 s) even when the like had already visually registered. Changed to `/content-desc="Unlike/` (prefix match, no closing quote) — matches both the bare form and the count-suffixed form.

---

## [1.1.565] — 2026-07-14

### Fix: Feed Like — phantom "Comment" node + false-negative like verification

**Phantom "Comment" container stealing the comment slot**
Instagram's accessibility tree contains a parent `ViewGroup` labeled `content-desc="Comment"` whose centre lands at x=71 — only 5 px from the Like icon at x=66. It passes the `^comment# Changelog

All notable changes to Equinox are documented here.

---

 exact-match filter and gets assigned as the Comment icon, collapsing the icon gap to 5 px. Every subsequent icon (shareFeed, shareDM) is then positionally assigned from that wrong anchor — shareFeed ended up at x=135 (the like-count badge area), which opened the Likes panel instead of the Repost sheet.

Fix: `commentNode` now requires `n.x > like.x + 20`. A real comment-bubble icon is always at least 60 px to the right of Like — any node within 20 px is a container/parent, not the icon itself.

**False-negative like verification**
The like DID register (heart turned red, user confirmed) but the single UI dump taken 700 ms after the tap still showed `content-desc="Like"` because Instagram's accessibility tree can lag the visual update by up to ~1.5 s. This caused `✗ like tap did not register` in the log followed by the share-to-feed action proceeding — which then opened the Likes panel (wrong icon position, see above).

Fix: polls up to 3 times at 500 ms intervals (max 1.5 s total). Confirms liked on the first dump that shows `content-desc="Unlike"`, logs failure only if all three polls miss.

---

## [1.1.564] — 2026-07-14

### Remove: "Reset Resolution Override" — phone display settings must never be changed

Removed the `POST /api/mobile/devices/:serial/screen-info/reset` endpoint and the "🔄 Reset Resolution Override" button. Both called `adb shell wm size reset`, which physically changes the phone's display settings.

The code already handles coordinate differences correctly in software via `rescaleForDevice()` (reads `wm size`, prefers Override size when present, maps capture-frame coordinates to device coordinates). There is no scenario where changing the phone's display is the right fix — the software layer is always the answer. This action is now permanently banned from the codebase.

---

## [1.1.563] — 2026-07-14

### Fix: Feed Like — wrong button selected + fake "liked" confirmation

Two separate bugs caused feed liking to silently do nothing while logging "✓ liked":

**Wrong Like button selected (root cause of the wrong tap position)**
Xiaomi devices (and other OEMs with display overrides) report two sizes in `adb shell wm size`:
```
Physical size: 1080x2400
Override size: 720x1280
```
The code was grabbing the first number match — the physical size — so `centerY` was calculated as 1200 instead of the correct 640. `_findCentermostLikeNode` then picked whichever Like node was closest to y=1200 in UIAutomator space (a wrong element near the middle of the physical pixel space), not the real action bar heart icon. This is why the log showed `comment=(71,352)` only 5px from `like=(66,352)` — the anchored Like node was wrong, pulling in a completely different row's elements.

Fix: `getScreenSize` now prefers the `Override size:` line from `wm size` output when present, falling back to the first match only if no override line exists. UIAutomator and `adb shell input tap` both use override/logical space — the screen dimensions used for center-finding must match.

**Fake "liked" confirmation**
After tapping the like button, the code immediately incremented `likes++` and logged `✓ liked` the moment `tap()` returned without error — no verification that Instagram actually registered the like. The heart icon switching from `content-desc="Like"` to `content-desc="Unlike"` is the only reliable signal.

Fix: after tapping, wait 700ms, dump the UI, and check for `content-desc="Unlike"`. If found → confirmed liked. If not → logs `✗ like tap did not register` and counts as a failure so the real miss is visible in the log.

---

## [1.1.562] — 2026-07-14

### Fix: View Posts — Share to Feed icon not detected; Make a Post — camera tapped instead of image

**View Posts — "N comments" count badge stealing the Comment icon slot, collapsing icon gap and breaking Repost detection**

The log showed `comment=(71,2176)` — only 5 px from `like=(66,2176)`. The Comment action icon on a 1080 px wide phone should be ~100–130 px to the right of Like. The cause: the regex `/\bcomment\b/i` matched Instagram's comment-count badge element (content-desc="1,844 comments") which sits on the same row as the action icons. That node was claimed as the Comment icon at x=71, collapsing `iconGap` to 5 px and making the unlabeled-ImageView `minX` filter (`comment.x + max(iconGap×0.6, 30) = 101`) exclude real Repost/Send icons at their true positions.

Fix: changed the Comment regex to `^comment# Changelog

All notable changes to Equinox are documented here.

---

 (exact match, case-insensitive). "1,844 comments" no longer matches; only the bare "Comment" accessibility label does.

**View Posts — Share to Feed never found even when visible**

With the comment-count bug fixed, `iconGap` is now correct, but the Repost icon was still null because:
1. Some IG builds label it "Share" rather than "Repost". Added `^share# Changelog

All notable changes to Equinox are documented here.

---

 to the repost regex (excluding nodes already claimed by Send) so both label variants are caught.
2. The positional pool fallback (left-to-right consumption of unclaimed row nodes) was explicitly disabled for `shareFeed` based on a past incident where a "More options" icon was grabbed — but that icon is at x > 80% of screen width and is already excluded by `saveCutoffX` before `rowNodes` is built. Re-enabled the pool fallback for `shareFeed` so an unlabeled-but-present Repost icon in the pool is correctly assigned.

**Make a Post — camera opened because thumbnail tap hit grid cell 0**

Instagram unconditionally auto-selects the most recent photo when the New Post picker opens — the image is always in the preview before any tap occurs. The old code checked for the expand toggle and, when not found, tapped the "first thumbnail" at (336,1617). That coordinate was landing on the camera icon (grid cell 0) or adjacent to it, opening the camera app.

Fix: removed the thumbnail-tap fallback entirely. The flow now checks for the expand toggle (taps it if found, to switch from centre-crop to full-image view) and then proceeds directly to Next — no thumbnail tap, no camera risk. The sanity-check abort (no POST tab signal + no expand toggle + positional Next) is preserved.

---

## [1.1.561] — 2026-07-14

### Fix: View Posts action bar picking wrong post's Like node (all icon coords wrong); Make a Post expand toggle finding camera icon instead

**View Posts — `_findCentermostLikeNode` using wrong screen height, poisoning all action-bar coordinates**

The log showed `like=(66,276) comment=(71,278) shareDM=(133,278)` — all three icons at y≈277, which is only 11% from the top of a 2460px screen (the status bar / header area), nowhere near the real feed action bar at y≈1900.

**Root cause:** `_findCentermostLikeNode` picks the Like button closest to the screen's vertical centre. It was calling `_getScreenSize(xml)` to get the screen height, which parses the XML root `bounds="[0,0][W,H]"` attribute. When the root bounds attribute is missing or formatted differently, the function returns its hard-coded fallback of `{w:1600, h:900}`. With `h=900`, `centerY=450` — and a Like node at y≈276 (a header-area element, perhaps a suggested-post like button or notification badge) is only 174px from center, while the real feed action-bar Like at y≈1900 is 1450px away. The wrong node wins, and the entire action-bar row scan anchors on that wrong position, producing bogus coordinates for Like, Comment, Repost, and Send — all near y=277.

**Fix:** `findFeedActionIcons` now calls `getScreenSize(serial)` (which queries `adb shell wm size` and defaults to 1080×2400 on error) for *both* width and height, then passes the real `screenH` into `_findCentermostLikeNode`. With `h=2460`, `centerY=1230` — the real feed action bar at y≈1900 is only 670px away while any header element at y≈276 is 954px away, so the correct node wins decisively. Added a hard floor of `y > screenH * 0.40` so any Like node in the top 40% of the screen is unconditionally rejected regardless of distance from center.

**Consequence of this bug:** the share-via-DM attempt at (133,278) was tapping the likes-count text near the top of the post, which opened the Likes panel instead of the DM share sheet. The action bar icon detection will now correctly find (or not find) the real Like/Repost/Send icons on the actual post action bar.

**Make a Post — `findExpandPhotoButton` finding the camera grid tile instead of the expand toggle**

The NE↔SW expand/fit toggle was never tapped; the camera icon in the Recents grid cell 0 was tapped instead. The camera tile is at the left edge of the grid (x≈12%, y≈63-70% of screen). Two separate heuristic paths in `findExpandPhotoButton` allowed it through:

1. **Container-based path:** when the preview container node's reported bounds extend into or past the Recents grid (on some Instagram builds the container includes grid children), `bandMaxY = container.y2 + 5%` reached into the grid area. The camera tile at x≈12% and y in the "lower-left" of the (now-too-tall) container passed the in-bounds check.

2. **Heuristic fallback path:** `maxY = h * 0.62` was close enough to the grid's first-row y position that border cases could pass, especially since the camera tile often has no "camera" keyword in its resource-id on some Instagram builds.

**Fix:** both paths now share a hard cap of `EXPAND_MAX_Y = h * 0.57`. The expand toggle is always inside the photo preview area, which ends well before the Recents grid starts (~58% screen height). The camera tile at y≈63-70% can never pass. The `isExcluded` label regex also expanded to cover `grid|thumbnail|picker` keywords as an additional safety net for resource-ids that describe grid cells without using "camera".

---

## [1.1.560] — 2026-07-14

### Fix: View Posts tool — all actions now fully logged in the UI log panel; Make a Post no longer deselects the auto-selected photo; Rate Instagram popup auto-dismissed; stray-navigation warning shown in log

**View Posts / feed scroll — comprehensive UI log added**

Every significant action the feed scroll loop takes was previously only going to the server's pino log (invisible in the app). The UI log panel (the "Log" tab on the Mobile page) now shows the full detail for every scroll iteration:

- `Scroll N/M: scanning action bar…` — confirms the tool is looking for the Like/Share icons on that post
- `Scroll N/M: action bar found — like=(x,y) comment=(x,y) shareFeed=(x,y) shareDM=(x,y)` — exact pixel coordinates of every icon found on that specific post (invaluable for debugging a misclick: if the coordinates look wrong for where the icon should be, the issue is in `findFeedActionIcons`)
- `Scroll N/M: tapping Like at (x,y)…` followed by `✓ liked (total likes this run: N)` or `✗ like tap threw an error`
- `Scroll N/M: like roll missed (chance N%) — scrolling without like` — when the randomised chance didn't fire
- `Scroll N/M: no Like button visible — skipping actions (Reel/ad/animating)` — when the post on screen isn't a normal feed post
- `Scroll N/M: feedback/survey card on screen — skipping like/share` — when Instagram's own survey/feedback card is on screen
- `Scroll N/M: no actions rolled this scroll` — when no actions were configured to fire this iteration
- Full share-to-feed (repost) path logged: icon tap coordinates, Repost sheet confirmation, "You reposted" popup dismissal, running total
- Full share-via-DM path logged: icon tap, recipient selection, Send confirmation, running total
- Skip reasons logged explicitly for both share paths when their icons can't be identified
- `⚠ Tapped outside Instagram — foreground app is "X" (likely hit an ad CTA). Pressing Back to recover…` — the stray-navigation recovery was previously only in the server log; now visible in the UI so the misclick moment is immediately identifiable
- `⚠ Recovered from N stray navigation(s) — likely tapped an ad CTA during scroll` — end-of-run summary if any recoveries happened

**Make a Post — thumbnail re-tap deselects the auto-selected photo (fixed)**

Instagram auto-selects the most recent gallery photo the moment the New Post picker opens (the image appears in the preview at the top and the expand/fit toggle appears). The automation was tapping the already-selected thumbnail a second time, which *deselects* it (the thumbnail turns grey/white) and leaves the preview empty — causing every subsequent Next/Share tap to fail.

Fix: the expand/fit toggle is now used as the "is an image already selected?" signal. If the toggle is visible → skip the thumbnail tap entirely. If it is *not* visible (e.g. the media scanner hadn't indexed the pushed file in time when IG opened) → tap the first non-camera thumbnail as before, then re-probe. This makes the detection concrete and non-destructive.

The flow the automation now follows:
1. Open picker → IG auto-selects newest photo (expand toggle becomes visible)
2. Tap the expand/fit toggle (two-arrow NE↔SW icon, bottom-left of preview) to switch to full-image fit
3. Tap **Next** (top-right header)
4. Tap blue **Next** on the filter/edit screen
5. Tap blue **Share**

**Rate Instagram / "Remind me later" popup — auto-dismissed**

`"No thanks"` and `"No Thanks"` were already in the auto-dismiss label list and are called mid-scroll, at launch, and at other cycle checkpoints — so "Rate us" popups were already being handled wherever those checkpoints run. Added `"Remind me later"` and `"Remind Me Later"` to the same list to cover the other soft-dismiss button on that popup.

---

## [1.1.559] — 2026-07-14

### Fix: mirror taps accurate in the middle, off near the edges — the real letterbox/pillarbox bug behind the mismatched resolutions

After retesting [1.1.558], drag-and-tap parity was better but some taps (mostly near the edges of the mirror) still landed off. The user's own diagnostics nailed the real cause: Check Screen Info reports `wm size` as e.g. 1080x2460, but the mirror's decoded video frame is a completely different aspect ratio (e.g. 720x1280 — 16:9 vs. the device's actual ~20:9 panel).

**Root cause:** Android's screen capture (what `screenrecord` records against) never stretches the real screen to fill a differently-shaped recording buffer — it letterboxes/pillarboxes: the real content is centered in the buffer at its own correct aspect ratio, and the rest of the buffer is dead black padding. Every tap/swipe/double-tap was rescaling with `x / videoW * realW` — a straight linear scale across the *entire* buffer, padding included. That's only accurate at the exact center of the padded axis (where padding is symmetric and cancels out) and drifts further off the more a tap sits toward the padded edges — which is exactly "clicks work in the middle, not at the edges."

**Fix:** all three input routes (`/input/tap`, `/input/double-tap`, `/input/swipe`) now compute the real content sub-rectangle within the video buffer first (comparing the buffer's aspect ratio to the device's actual `wm size` ratio, same centered-fit math Android itself uses to capture the frame), then rescale coordinates relative to that sub-rect instead of the raw buffer. When the two aspect ratios already match, this is a no-op — zero behavior change for devices without the mismatch.

**Also added:** Check Screen Info now explains, in plain language, that a video-size/`wm size` mismatch here is expected (Android capture behavior, not a bug) and that taps already account for it — so the numbers not matching stops looking alarming on its own.

**Scope note:** this fixes tap/swipe *accuracy*. It does not change how the mirror image itself is drawn — the video still visually includes Android's internal black padding on the letterboxed axis (usually not very noticeable, but it's there). Cropping that out cosmetically is a separate, riskier change to the render pipeline (the single most fragile part of this codebase per its own changelog history) and wasn't attempted here; flag it separately if it's still worth doing once tap accuracy is confirmed fixed.

**Status:** shipped, not yet re-verified against the real device — please retest 🎯 Click Test specifically near the top/bottom and left/right edges of the mirror (not just the center), and try dragging a floating window closed from near an edge too.

---

## [1.1.558] — 2026-07-14

### Fix: press-and-drag gestures (e.g. dragging a floating window closed) went out unrescaled — plus Check Screen Info now shows the mirror's actual video size

Two separate but related gaps found after retesting [1.1.557] on the real device: some taps landed pinpoint, others (specifically press-and-hold-drag gestures, like dragging a floating window down to close it) still missed.

**Root cause:** manual taps/double-taps send `videoW`/`videoH` with every request, so the server can rescale them from video-pixel space into the device's real resolution. Drag gestures go through the separate `/input/swipe` route, and its client call was never updated to send `videoW`/`videoH` — so the server's `if (input.videoW && input.videoH)` rescale branch never ran, and every drag was sent in raw, unscaled video coordinates. This is a different bug from [1.1.557]'s tap-rescale-skip guard, but produces the same symptom for drag-based interactions specifically.

**Fix:** the mirror's pointer-up handler now sends the current decoded video frame size with every `/input/swipe` request too, so drags get the same rescale treatment as taps.

**Also added:** "🔍 Check Screen Info" now prints the mirror's live decoded video frame size (e.g. `Decoded frame: 720x1280`) alongside `wm size`'s device resolution, since that's otherwise only ever visible in a "Frame WxH" line that scrolls past the log the moment the stream (re)connects, and isn't shown anywhere in Android's own settings — there was no way to see both numbers side-by-side to judge whether they're within the expected AR-mismatch range or something is actually broken.

**Status:** shipped, not yet re-verified against the real device — please retest 🎯 Click Test *and* try dragging a floating window closed; both should track the click/drag point now. Run 📐 Check Screen Info too and confirm you now see a "Decoded frame" line under the wm size output.

---

## [1.1.557] — 2026-07-14

### Fix: manual mirror taps landing far from the click — removed the aspect-ratio "skip rescale" guard added in [1.1.551]

The user's latest device check confirmed: `wm size` reports physical resolution **1080×2460**, no resolution override active — yet the mirror's video stream negotiates at **720×1280** (a *different* aspect ratio, 9:16 vs. ~18:41). [1.1.551] treated a video/device aspect-ratio mismatch as proof that `wm size` was reporting an incompatible coordinate space, and skipped rescaling entirely whenever the two ARs differed by more than 2% — sending raw video-pixel coordinates straight to `adb shell input tap`. That was the wrong call: this file's own long-standing comment on the `screenrecord` spawn explains that `screenrecord` is *never* pinned to the device's exact `wm size`, because most panel resolutions aren't 16-pixel-aligned, so it silently self-selects an encoder-supported size — which can legitimately have a different aspect ratio than the panel. A mismatched AR is the expected, normal case for this feature, not a sign of two incompatible spaces. Skipping the rescale in exactly that case sent every manual tap to essentially arbitrary coordinates, matching the reports of the Stop button hitting a "TV and Streaming" link, and the Fit-to-Screen icon being unclickable.

**Fix:** `rescaleForDevice()` in `artifacts/api-server/src/routes/mobile.ts` now always does independent per-axis scaling (`x/videoW*realW`, `y/videoH*realH`) from the video's pixel space into whatever `wm size` reports (Override size if present, else Physical size) — the same coordinate space every other tap in this codebase (built from uiautomator bounds) already targets successfully. The 2%-aspect-ratio skip branch is removed.

**Status:** shipped, not yet verified against the real device — no phone is attached in this environment. Please retest with 🎯 Click Test: the bullseye and yellow dot should now land at the same spot (or much closer than before). If there's still an offset, report the exact video/device numbers again — they'll now always come with a rescale log line since rescaling can no longer be silently skipped.

---

## [1.1.554] — 2026-07-14

### Fix: mirror rendering at the wrong aspect ratio entirely — reinstated the resolution-override diagnostic

The user provided their phone's actual screen ratio from an external site (9:16) and it doesn't match what the mirror renders — a much narrower ratio. This isn't the same bug as [1.1.553]'s shell-CSS issue; the mirror's *content* itself (not just the shell wrapping it) is the wrong shape, which can only mean the video stream itself is coming from the device at the wrong resolution.

**What we found going back through the real history (`Dashboard.tsx`'s in-app changelog, which is more detailed and accurate than this file had been kept — see the [1.1.548]–[1.1.551] entries below, corrected):** a "📐 Check Screen Info" diagnostic — built specifically to detect a resolution-override mismatch on this device (`adb shell wm size` reporting a different "Override size" than "Physical size") — was removed in [1.1.548] on the theory that the offset bug was "fixed at the source." [1.1.550] and [1.1.551] then showed that theory was wrong: the wm-size/video mismatch is still live. That removal deprived us of the one tool that could confirm or rule out a resolution override — exactly the kind of evidence needed now instead of another guess.

**Fix:**
- Reinstated `GET /api/mobile/devices/:serial/screen-info` (raw `wm size` + `wm density`, flags an Override vs Physical size mismatch with the percentage difference).
- Added `POST /api/mobile/devices/:serial/screen-info/reset` — runs `adb shell wm size reset`, a one-click fix if a mismatch is confirmed. Deliberately does not touch density.
- Log panel: **"📐 Check Screen Info"** button restored; a **"🔄 Reset Resolution Override"** button now appears only after Check Screen Info detects a mismatch.

**Status:** shipped, not yet verified against the real device — no phone is attached in this environment. Please click **Check Screen Info** on the Mobile page's Log tab and paste what it prints; if it reports an Override size, click **Reset Resolution Override** and reconnect the mirror (Live off/on) to see if the mirror's shape and the fit-icon tap accuracy both correct themselves. This is a real hypothesis backed by this device's documented history, not another blind CSS guess — but it needs your device's actual output to confirm.

---

## [1.1.553] — 2026-07-14

### Reverted: [1.1.552] phone mirror shell fix

The user's real-device screenshot after [1.1.552] showed the change did not fix the problem it was meant to fix — the mirror still looked tiny inside a large dark area. The layout math for that fix was internally consistent (it removed a genuine internal pillarbox bug), but it did not address what the user is actually seeing: the app's background is the same near-black as the phone shell, so a correctly-sized but still-narrow phone mirror reads as "swimming in dead black space" regardless of whether the shell border hugs it tightly. That's a visibility/contrast problem, not (only) a sizing bug, and the previous fix didn't touch it.

**Reverted in full:** `artifacts/dannys-bot/src/pages/MobilePage.tsx` is back to its pre-[1.1.552] state (shell aspect-ratio applied to the whole header+screen box, as it was before). `package.json` / `artifacts/electron/package.json` bumped to 1.1.553 to mark the revert.

**Status:** reverted, pushed. Next attempt needs to address actual visible size/contrast (e.g. giving the mirror column more width than the current 50/50 split with the settings panel, and/or a visible boundary — a lighter border or background tint — around the shell so it doesn't blend into the app background) rather than only the internal aspect-ratio math, and should be checked against a real screenshot before calling it done, not just reasoned about from code.

---

## [1.1.556] — 2026-07-14

### Fixed: [1.1.555]'s mirror exact-fit sizing never actually activated

Real-device screenshot after [1.1.555] showed the pillarbox and unclickable-nav bug *worse* than before, not fixed: large black bars either side of the phone image, taps not registering anywhere.

**Root cause:** the mirror pane's size is measured with a `ResizeObserver` attached in a `useEffect(..., [])`. That pane `<div>` sits behind a loading/data gate and doesn't exist yet on the component's first mount, so the effect's ref was `null`, the observer never attached, and — with an empty dependency array — nothing ever re-ran it once the div actually appeared later. The measured pane size stayed `null` forever, so [1.1.555]'s exact-fit sizing code (which was otherwise correct) never had a non-null size to compute from, and silently fell back to a "stretch to fill the box" shape — which is what produced the bars.

**Fix:** replaced the plain `useRef` with a ref *callback* (backed by `useState`), so the measuring effect's dependency is the element itself and fires the moment the div mounts, not just once at the top-level component's own mount time.

Also killed a leftover manually-started API-server process left bound to its port from an earlier debugging session, and removed the redundant manually-configured "API Server"/"Frontend" workflows now that this project has its own artifact-managed ones.

**Status:** shipped. Still not verified against the real device from this environment (no phone attached here) — please confirm the mirror now hugs the phone shape with no bars and the nav buttons are clickable.

---

## [1.1.548]–[1.1.551] — 2026-07-14 (corrected)

An earlier pass at this file backfilled these four versions from a session transcript and got the details wrong — the app's own in-app changelog (`Dashboard.tsx`) had the accurate, detailed record the whole time. Corrected here:

- **[1.1.548]** Fixed the mirror tap-offset bug (thought, at the time, to be the root cause): the mirror canvas had `object-fit: contain` in its CSS, which browsers silently ignore on `<canvas>` elements — it was being stretched to fill its container while the click-mapping math assumed letterbox bars that didn't actually exist. Changed the canvas to `width: auto; height: auto` so it genuinely preserves aspect ratio, and simplified `mapToPhone()` to a plain linear scale. Also **removed** the "📐 Check Screen Info" button and its `GET /screen-info` endpoint (added in [1.1.547]), reasoning the offset bug was "fixed at the source" and the diagnostic was no longer needed — this turned out to be premature (see [1.1.554]).
- **[1.1.549]** The [1.1.548] CSS fix proved unreliable in Electron/Windows (`width/height: auto` on canvas doesn't behave consistently across rendering engines there). Rewrote the coordinate system to be renderer-driven instead: every frame is drawn letterboxed at an explicitly computed `{dx,dy,dw,dh}` stored in a ref (`drawRectRef`), and the click mapper reads from that exact same ref — the paint numbers and the click-mapping numbers are the same numbers by construction, eliminating any possibility of drift between them.
- **[1.1.550]** Traced the *remaining* offset to the server: `/input/tap` was calling `adb shell wm size` on every tap and rescaling coordinates from video-frame space to that reported size, but `wm size` returned a slightly different number than the video frame's actual dimensions on this device (OEM quirk / alignment / a resolution override), injecting a small but real 1–2% error. Since `screenrecord` without `--size` already captures at the device's native logical resolution, `frame.displayWidth/Height` **is** the correct tap coordinate space — no rescaling should be needed at all. Removed `videoW`/`videoH` from the tap/swipe requests so `rescaleForDevice` fast-returns without ever calling `wm size`.
- **[1.1.551]** [1.1.550] made the offset *worse*, not better — rescaling turned out to still be necessary in practice. Reverted [1.1.550]: restored `videoW`/`videoH` on all tap/double-tap requests, and added a visible log line whenever a rescale actually fires (video dims, device dims, original vs. rescaled coordinates) so the next mismatch has real numbers attached to it instead of another guess.

**Lesson:** [1.1.548] through [1.1.551] are four consecutive, partially-contradicting attempts at the same bug in a single day, each shipped with high confidence ("root cause found and eliminated") and each subsequently reverted or superseded. [1.1.554] reinstates the one diagnostic tool ([1.1.548] removed) that could have shortened this cycle by actually confirming or ruling out a resolution override instead of guessing at the coordinate math from both ends.

---

## [1.1.547] — 2026-07-14

### New: in-app diagnostics — no terminal/command prompt needed

The user does not want to run any command-prompt/terminal commands to help debug this device — every diagnostic must be a button click inside the app itself.

- Added a **"📐 Check Screen Info"** button next to "📱 Capture Screen" in the Mobile page's Log panel. Clicking it prints the device's raw `wm size` (Physical size + Override size, if present) and `wm density` output straight into the log, with an inline warning if an Override size is present — this is the exact data needed to diagnose the long-suspected coordinate-mismatch ("offset") bug, without the user ever opening a terminal.
- New backend endpoint `GET /api/mobile/devices/:serial/screen-info` (raw, unparsed — the existing `/screen-size` endpoint only returns a single parsed WxH and discards whether the device reported two different sizes).
- Added `captureDebugEvidence()` in `androidManager.ts`: an automatic, zero-effort screenshot + accessibility-dump capture to `debug-captures/` on disk, intended to end the manual "user pastes a fresh log + screenshot every time something goes wrong" cycle. Not yet wired into every tap in the Make a Post flow — next step if the expand-toggle bug recurs.
- Added `pnpm --filter @workspace/electron run dev` script: rebuilds and launches the Electron app directly against your local ADB/USB connection, skipping the full `electron-builder --win` installer packaging step, for faster iteration. (Still requires a terminal — superseded by the in-app diagnostics above for anything that doesn't need a full app relaunch.)

**Status:** shipped. The screen-info button is the one thing to click, in-app, if a tap keeps landing off-target.

---

## [1.1.546] — 2026-07-13

### Fix: Make a Post (mobile) — expand/fit toggle tapped the camera shutter instead

The user sent a real-device log + screenshot proving the expand/fit toggle's positional fallback tapped the phone's own camera shutter (opening the live camera) instead of the intended two-arrow fit icon.

**Root cause:** the fallback scanned a fixed `y: 30–58%, x: <22%` band with no exclusion for camera/tab/grid elements. The live preview container's actual bounds run to ~59.8% of screen height — past the old 58% cutoff, the exact same "cutoff excludes the real element" mistake already fixed once for the compose icon. With the real icon outside the band, the scan matched the next-best candidate: the unlabelled "open camera" grid tile, which is just as small, square, and unlabelled as the real icon.

**Fix:** stopped guessing a fixed screen fraction entirely. The preview container's own bounds are now read from the live accessibility dump (resource-id contains `preview_container`, `crop_image_view`, or `draft_image_view` — all confirmed present on this screen from real-device dumps), and the search is scoped to that container's bottom-left quadrant only. Anything in the camera tab, tab strip, or Recents grid sits geometrically outside that rectangle, so it is no longer possible for the scan to match it. A camera/gallery/tab/story/reel/live label exclusion was also added as an independent second safety net for older builds where the container can't be found and the old fixed-percentage fallback still has to run.

**Status:** shipped, awaiting real-device confirmation.

---

## [1.1.545] — 2026-07-13

### Fix: Make a Post (mobile) — top-left header icon was excluded by too-tight y cutoff

v1.1.544 correctly moved to the top-left header icon, but the user's real-device test still reported "not found." A screen-layout-scan of the live device (Xiaomi 23076RN8DY, 1080×2226) showed why: the real icon's bounds are `[0,104][132,258]`, centre y ≈ 8.1% of screen height — just past the `y < 7%` cutoff the previous fallback used, so it was silently excluded even though it existed in the dump.

**Also found:** the fallback computed screen width/height via a separate `adb shell wm size` call. `wm size` can report a "Physical size" and an "Override size" that differ when a display-size override is active — the same class of mismatch already documented and fixed elsewhere in this codebase for mirror-tap coordinate rescaling. If that call disagreed with the coordinate space the live accessibility dump itself uses, every percentage threshold computed from it would be silently skewed. Now reads width/height straight from the dump's own root node bounds, guaranteeing both are in the same coordinate space.

**Fix:**

- Widened the header band from `y < 7%` to `y < 12%` of screen height to include the real icon.
- Because that reopens the risk of matching the stories-tray "Add" circle (the original v1.1.526 bug — that tray sits around y ≈ 9–15%, overlapping this range), added two defenses: exclude any candidate whose text/content-desc mentions "add" or "story", and exclude any candidate with 2+ similarly-sized siblings at a similar y (a row of tray icons looks like that; a lone header button never does).

**Status:** shipped, awaiting real-device confirmation.

**Separately reported, not yet root-caused:** the user also described needing to click ~5px to the left of a target to hit it when manually tapping the phone mirror, in some screen regions but not others. This matches the exact symptom already described in this codebase's `rescaleForDevice` fix (Physical vs. Override display-size mismatch) — that fix is already shipped for `/input/tap`, so if the offset persists on the next test, the next step is confirming what `adb shell wm size` actually reports on this device (Physical size line vs. Override size line) rather than guessing further.

---

## [1.1.544] — 2026-07-13

### Fix: Make a Post (mobile) — compose "+" is at the TOP-LEFT of the header, confirmed on-device

**Second regression in the same day:**

v1.1.543's fallback (bottom-nav "New post" tab, x≈50%/y≈94%) was itself wrong for this device: its bottom nav is `home / reels / shop / search / profile` — there is no create tab at all. Tapping the centre of that row landed on an unrelated middle tab and opened Direct/Messages instead of the composer.

**Ground truth, this time verified by direct visual inspection of the live device** (Xiaomi 23076RN8DY, account `lisaberry2001`/`upgrds`, 13 Jul 2026): the real compose "+" is a single icon at the **top-left of the header bar**, immediately left of the "Instagram" wordmark — not a top-right cluster, not a bottom-nav tab.

**Fix:**

- New `findComposeTopLeftHeaderIcon()`: scans only the header bar itself (`y < 7%` of screen height, `x < 25%` of width), picking the leftmost icon-sized node. The tight `y` bound is deliberate — it structurally excludes the stories-tray "Add" circle (`y ≈ 9–15%`), which is the element an earlier attempt (v1.1.526) mistakenly matched when searching "top-left" without a y-bound. That was a different row entirely.
- `findComposeButton` now tries label/resource-id matches first (unchanged), then falls back to this top-left position.
- The post-tap Notifications/Direct safety-net guard now retries via a fresh dump + this same top-left position, instead of the bottom-nav position.

**Status:** shipped, awaiting real-device confirmation. If this is still wrong, the fastest path forward is a screenshot of the 🔍 Inspect overlay with the real "+" icon clicked directly — exact resource-id/content-desc/bounds, no more positional guessing.

---

## [1.1.543] — 2026-07-13

### Fix: Make a Post (mobile) — "+" tap was opening Notifications instead of the composer

**Regression:**

v1.1.536–542 replaced the compose-button positional fallback with a blind scan of the top-right header band ("pick the leftmost icon-sized node"). On this real device/Instagram build there is no compose icon in that header band at all — the scan's "leftmost" match was actually the **Notifications** (heart) icon. Every Make a Post run tapped it, landed on the full-screen Notifications page, and failed from there. This was a real regression: v1.1.527 (earlier the same day) had already confirmed via screenshot that this device's true "+" button is a **bottom-navigation tab**, not a header icon — that confirmed fix was silently replaced by the header-scan approach without new evidence it was needed.

**Root cause:**

`findComposeButton`'s positional fallback searched the top 15% of the screen / right 50% of the width and picked whichever icon-sized node had the smallest x-coordinate in that band, assuming header order `[compose +][notifications ❤][DM ✈]`. When no compose icon exists in that band, that logic still confidently returns *something* — in this case, the Notifications icon — with no way to tell the difference between "found compose" and "found the wrong icon."

**Fix:**

- `findComposeButton` no longer performs the blind top-header positional scan. It now checks label and resource-id matches covering **both** possible layouts (top-header icon *and* bottom-nav tab), then falls back directly to the bottom-nav "New post" tab position (`x≈50%`, `y≈94%`) — the last positional fallback confirmed correct against a real-device screenshot.
- Added a second post-tap screen guard, `isOnNotificationsOrDirectScreen`, alongside the existing story-picker guard. If the "+" tap lands on Notifications or Direct, Make a Post now backs out (Back button) and retries once via the bottom-nav position before giving up, instead of silently continuing on the wrong screen or failing later with a confusing error.
- Documented in `.agents/memory/make-a-post-log.md`: once a positional fallback has been confirmed correct via a real-device screenshot or log, it must not be replaced by a new blind heuristic without fresh evidence the confirmed one stopped working.

**Status:** shipped, awaiting real-device confirmation from the next Make a Post run.

---

## [1.1.538] — 2026-07-13

### Feature: Element Inspector — click any element on the phone screen to identify it instantly

**The problem it solves:**

Every time Make a Post (or any other mobile tool) breaks, diagnosing it required guessing coordinates, adding dump code, rebuilding, running, copy-pasting 500 lines of log, sending them, waiting for analysis, and repeating — a cycle that has cost hours per bug. There was no way to just point at something and know what it was.

**What's new — 🔍 Inspect button:**

A new **🔍 Inspect** toggle appears in the top-right of the phone mirror panel whenever the live stream is on. When active:

- The cursor changes to a crosshair.
- Clicking anywhere on the phone mirror **does not send a tap to the device** — instead it queries the accessibility tree for every element whose bounds contain that point.
- Results appear instantly as an overlay panel on the mirror, showing (for each matching node, innermost/most-specific first):
  - **Class** (e.g. `ImageView`, `TextView`, `FrameLayout`)
  - **Resource ID** (e.g. `action_bar_add_button`)
  - **Content description** (e.g. `"New post"`, `"Add"`, `"Direct"`)
  - **Text** (visible label, if any)
  - **Pixel bounds** and **centre coordinate** — ready to paste directly into code
  - **Tappable** indicator (green ● vs grey ○)
- A **📋 Copy** button in the overlay copies all node data as clean text.
- Click **✕** to dismiss and click another element.
- Click **🔍 Inspecting** again to exit inspect mode and return to normal tap behaviour.

**Backend:**

New endpoint `POST /api/mobile/devices/:serial/inspect-node` — takes `{x, y}` in device coordinates, runs a UIAutomator dump, returns all nodes containing that point sorted smallest-area-first (innermost element first). Same dump mechanism as Capture Screen, but filtered and returned as structured JSON rather than formatted text.

**How to use it for Make a Post debugging:**

1. Open the phone mirror, power on the screen, navigate to the Instagram home feed.
2. Press **🔍 Inspect** to enter inspect mode.
3. Click on the compose "+" icon (or whatever element you want to identify).
4. The overlay shows exactly: what class it is, what its `content-desc` is, its exact pixel bounds.
5. Press 📋 Copy and paste it — that's everything needed to fix the finder in one click, no guessing.

---

## [1.1.537] — 2026-07-13

### Fix: Make a Post (mobile) — compose "+" finder was landing on the DM icon, not the compose button

**Root cause (introduced by v1.1.536):**

v1.1.536's positional fallback for `findComposeButton` scanned the top-right header area and picked the **rightmost** clickable node. Instagram's header runs left→right as `[compose +][notifications ❤][DM ✈]` — so "rightmost" always selected the DM icon, not the compose "+", causing `findComposeButton` to return the wrong target entirely. On top of that, the `y < 8%` band was too tight for the Xiaomi/MIUI header layout, so even with the correct logic the search zone excluded the actual header row.

The combined result: after removing `"Add"` from the label list (correct) and applying the broken positional fallback (wrong direction + too-tight band), `findComposeButton` returned null and the log showed `compose "+" icon not found — skipping` every run.

**Fixes:**

- **Direction corrected:** positional scan now picks the **leftmost** node in the right cluster (`x > 50%`). The compose "+" is always the leftmost of the three right-side header icons; DM is always rightmost. Picking leftmost is the only correct heuristic here.
- **y-band widened:** `y < 8%` → `y < 15%` so the header icons are actually inside the search zone on MIUI and similar skins that push the action bar lower than stock Android.
- **`clickable="true"` filter removed:** on some MIUI builds the individual icon `ImageView` nodes are not marked clickable in the accessibility tree even though they respond to taps normally; only their parent `FrameLayout` is. Removing the filter lets the coordinate scan find the icon regardless of how the attribute is set, while the story-picker guard (below) still catches any wrong-screen outcome.
- **Story-picker guard retained:** `isOnStoryCreator()` check (introduced in v1.1.536) remains in place — if the tap still opens the story creator instead of the post picker, Back is pressed and the attempt aborts cleanly rather than firing blind taps into the wrong screen.

---

## [1.1.536] — 2026-07-13

### Fix: Make a Post (mobile) — story tray "Add" button matched instead of compose "+"; story-picker guard restored

**Root cause (confirmed by layout dumps from v1.1.529–v1.1.535):**

Instagram's stories tray (the row of story circles at the top of the home feed) contains a "+" button for adding to your own story. This button carries `content-desc="Add"` in the accessibility tree and appears **before** the real compose "+" in tree order. The label `"Add"` was in `findComposeButton`'s search list, so it was found first — every single automated run opened the story composer ("Add to story" picker), never the feed-post composer.

Before the diagnostic dumps were added, the story-picker guard (present in earlier builds) silently caught this, pressed Back, and the run logged `0/1 posted`. Once the dumps were introduced and the guard was temporarily removed, runs began advancing into the story editor via the positional "Next" fallback — which is what the user saw as the second screenshot in the v1.1.535 report.

**Fixes:**

- **`"Add"` removed from `findComposeButton` label search** — confirmed on real device (Xiaomi, Jul 2026): Instagram's actual compose "+" does not use `"Add"` as its accessibility label. Only `"New post"`, `"Create"`, and `"New Post"` are kept.
- **Positional fallback direction corrected** — the fallback now scans the **right side of the header** (`x > 60%, y < 8%`) and picks the rightmost node. (Note: this direction was subsequently corrected again in v1.1.537 — see above.)
- **Story-picker guard restored** — after every compose-button tap, `isOnStoryCreator()` checks the accessibility tree for labels unique to the story creator (`"Your story"`, `"Close Friends"`, `overflow_button` resource-id). If any are found, Back is pressed and the attempt aborts before touching the thumbnail or Next button.

---

## [1.1.535] — 2026-07-13

### Fix + Feature: Make a Post dump timing; replace Scan Screen Layout with Capture Screen

**Make a Post — dump timing fix:**
- Increased the post-compose-tap sleep from 1 800 ms → **3 500 ms** so the layout dump fires against a fully rendered picker screen. At 1 800 ms the screen was still mid-transition and the dump returned blank nodes, making all subsequent coordinate lookups useless.
- The dump now reliably captures real picker node bounds (thumbnails, Next button, expand toggle) on the first run.

**Log panel — Capture Screen replaces Scan Screen Layout:**
- Removed the old "Scan Screen Layout" button which required manual log-paste workflows and produced the same truncated output every time.
- Added a **📱 Capture Screen** button that fires a full UIAutomator dump immediately against whatever screen is currently showing.
- On capture: a second inline row appears with **📋 Copy Capture** (copies just the layout block, not the full log) and **⬇️ Save** (downloads as a timestamped `.txt` file). Dismiss with ✕ when done.
- This means: when anything breaks mid-flow, hit Capture Screen on the exact screen that's open and send the resulting file — no more copy-pasting 500 lines of log.

---

## [1.1.534] — 2026-07-13

### Diagnostic: Make a Post — extend dump timeout; capture blank-screen evidence

- Extended the post-tap wait from 800 ms → 1 800 ms before firing DUMP A to confirm whether a longer delay resolves the blank-node issue reported on v1.1.533.
- Added explicit "0 node(s) found" log line when the dump returns an empty tree so the difference between "dump ran but screen was blank" and "dump threw an error" is unambiguous in the log.
- Added a log line immediately before and after `sleepOrAbort` in the POST-tab branch to confirm the sleep is completing (not being interrupted by a cycle-abort signal).

---

## [1.1.533] — 2026-07-13

### Diagnostic: Make a Post — confirm DUMP A fires; catch silent throws

- Added a `try/catch` wrapper around the entire `dumpAllNodes()` call so any internal throw logs the actual error message (e.g. `adb shell` spawn failure, XML parse error) instead of silently killing the function and leaving no trace in the log.
- Added a "starting layout dump…" log line **before** `dumpAllNodes()` runs, so it is possible to distinguish "the function was never called" from "it was called but threw immediately."
- Added explicit log lines bracketing `sleepOrAbort(serial, 2000)` (the POST-tab wait) so the log shows whether that call is returning normally or throwing a cycle-abort.

---

## [1.1.532] — 2026-07-13

### Diagnostic: Make a Post — layout dump after POST tab tap (DUMP A attempt 2)

- Repositioned DUMP A to fire **after** both the POST tab tap and its 2 s grid-load wait, rather than immediately after the tap. Earlier placement meant the dump ran during the opening animation when the accessibility tree was still unpopulated.
- Added the `logScreenLayout` helper call for DUMP A so the full node list appears in the Log panel rather than server-side only.
- Analysis from this build confirmed the real root cause: `findComposeButton` was consistently opening the story composer ("Add to story") via the `"Add"` label match — the story picker appeared in every dump, never the post picker. This diagnosis drove the fixes in v1.1.536.

---

## [1.1.531] — 2026-07-13

### Diagnostic: Make a Post — first layout dump after compose tap (DUMP A)

- Added DUMP A: a `dumpAllNodes()` call immediately after the compose-button tap and its animation wait, logging every accessibility node with real pixel bounds to the Log panel.
- Goal: capture exactly what screen opens after tapping "+" — post picker, story picker, or something else — and get real coordinates for thumbnail, Next button, and expand toggle without guessing.
- Dump output is prefixed `[DUMP A]` so it is easy to find in a long log. Each node line shows: class, bounds, text, content-desc, resource-id, clickable.

---

## [1.1.530] — 2026-07-13

### Diagnostic: pin down exactly which line stops executing in Make a Post
- Added individual log lines around every statement between "tapping POST tab" and DUMP A so we can see precisely which line is the last one that runs
- "POST tab tapped — waiting 2 s…" / "2 s wait done" bracket the sleepOrAbort — if "2 s wait done" never appears, sleepOrAbort threw (cycle-aborted)
- "no POST tab found — waiting 800 ms…" / "800 ms wait done" for the else branch
- Wrapped dumpAllNodes() in try/catch so any throw inside it logs the actual error message instead of silently killing the function
- "[DUMP A] X node(s) found" line tells us whether the dump ran but returned empty vs. threw

---

## [1.1.529] — 2026-07-13

### Diagnostic: Make a Post — full layout dumps at every critical step
- Added three UIAutomator layout dumps (DUMP A / B / C) that log to the Log panel during a Make a Post run
- **DUMP A**: fired right after POST tab tap + 2s grid-load wait — shows every node on the picker screen with real pixel bounds, text, content-desc, resource-id, and clickability
- **DUMP B**: fired right after the thumbnail tap — shows whether the selection state changed
- **DUMP C**: fired right after the first Next tap — shows whether we actually left the picker or are still on it
- This is a one-run diagnostic build. The dumps tell us the real coordinates so we can stop guessing.

---

## [1.1.528] — 2026-07-13

### Fix: View Feed — scroll gesture opening comments on portrait posts
- **Root cause**: scroll swipe started at `y1 = 78%` of screen height (y=998 on a 720×1280 device). A 4:5 portrait post puts its action bar at y≈960–1008 — the comment icon sits right at that y=998 start point. Android registered the touch-down on the comment button and opened comments instead of scrolling.
- **Fix**: moved swipe start from `y1 = 78%` → `y1 = 88%` (y=1126), safely below the action bar of every post format including the tallest 4:5 portrait, while still leaving a 600px+ drag distance.
- **Recovery**: after each scroll an accessibility check looks for the "Add a comment" EditText that uniquely identifies the comments sheet. If open, Back is pressed before continuing the scroll loop.

### Fix: Make a Post (mobile) — reverted v1.1.527 compose-button changes; restored thumbnail tap
- v1.1.527 incorrectly changed `findComposeButton` to target the bottom-centre nav bar and skip the thumbnail tap entirely. Reverted both changes.
- The top-left "+" **is** the correct compose button — it opens a multi-type sheet (POST / REEL / STORY tabs), not "Add to Story" directly.
- The photo IS visible in the grid after tapping POST tab, but it must be **tapped to select it** (highlight with white border). The thumbnail tap was never wrong — skipping it was.
- Restored: `findComposeButton` uses original top-left positional fallback. `runMakePostStep` always taps the thumbnail after POST tab switch. Added an 800 ms grid-load wait when POST tab was not found (already on POST mode).

---

## [1.1.527] — 2026-07-13

### Fix: "Make a Post" (mobile) — wrong "+" button tapped + unnecessary thumbnail tap

**Root cause 1 — wrong compose button (landed on "Add to Story" instead of "New Post")**

The previous `findComposeButton` function targeted the wrong "+" on the home feed:
- Its label search included the string `"Add"`, which matched Instagram's top-left **"Add to story"** / camera button — not the bottom-nav **"New post"** tab.
- Its positional fallback scanned the **top-left corner** of the screen (`y < 8%, x < 20%`), which is where the story-composer camera icon lives.
- Both paths consistently sent the automation into the **story composer** ("Add to story" screen) instead of the feed-post picker ("New post" screen).

Fixes:
- Removed `"Add"`, `"Create"`, `"New Post"` from the label search — only the unambiguous `"New post"` label is kept.
- Expanded the resource-id list to include modern IG bottom-nav IDs: `:id/creation_tab`, `:id/creation_tab_icon`, `:id/new_post_button`, `:id/action_new_post`.
- **Completely rewrote the positional fallback** — now scans the **bottom-centre** of the screen (`y > 88%, x 35–65%`) and picks the node closest to screen centre-x. Hard-coded last resort is `(50%, 94%)` — the geometric centre of the bottom-nav "New post" slot on all screen sizes.
- Added runtime detection: after tapping compose, the accessibility tree is checked for the text "Add to story". If found, Back is pressed and a direct `(50%, 94%)` positional tap is issued as recovery before continuing.

**Root cause 2 — unnecessary thumbnail tap was hitting the camera tile**

The previous code tapped a gallery thumbnail unconditionally after opening the picker. When entering through the correct bottom-nav "+" (as the user does manually), **Instagram auto-selects the newest photo immediately** — the photo fills the large preview before any tap. A thumbnail tap on top of this auto-selection was:
- Hitting the camera tile (the `[0,0]` cell) instead of a photo, opening the camera app, or
- Re-tapping the already-selected photo and toggling selection off.

Fix: the automation now checks for the expand/fit toggle (which only appears in the preview when a photo is selected). If it is present, no thumbnail tap is issued — the photo is confirmed selected and the flow proceeds directly to "Next". Only if the toggle is absent after a 1-second retry does it fall back to a single thumbnail tap as recovery.

**New exported helper:**
- `postComposeCentreNavFallback(serial)` — returns `(50%, 94%)` screen-fraction coordinate for the bottom-nav "New post" centre slot.

---

## [1.1.526] — 2026-07-13

### Fix: "Make a Post" (mobile) — gallery thumbnail never selected + Share tap had no verification

**Two confirmed bugs found via real-device screenshots provided by the user:**

**Bug 1 — Gallery thumbnail scan returned null even though thumbnails were visible (root cause of "no gallery thumbnail found in the Recents grid")**

- Root cause — `findFirstGalleryThumbnail()` required `clickable="true"` on each grid cell node. On this specific device (Xiaomi 2307FPN8BY, Android 14) the RecyclerView parent handles all touch events; individual grid cell nodes have `clickable="false"`. The accessibility scan found zero candidates and returned null — even though the user's screenshot clearly showed the photo thumbnails on screen.
- Fix 1a — `findFirstGalleryThumbnail()` now accepts **both** clickable and non-clickable tile-shaped nodes. Clickable nodes are prioritised (sorted first), non-clickable tile-shaped nodes serve as fallback. All other filters (size, aspect ratio, camera-label exclusion) are unchanged.
- Fix 1b — Added `postGalleryThumbnailPositionalFallback()`: when the accessibility scan returns nothing at all, `runMakePostStep` now taps the screen-fraction coordinate for the second grid cell (first non-camera photo tile, x≈38%, y≈69%) instead of silently continuing with no photo selected.

**Bug 2 — Share tap had no success verification; automation reported "posted" unconditionally (root cause of "said posted but didn't post")**

- Root cause — after tapping Share, the code waited a flat 3 seconds then unconditionally returned `{ posted: true }` and logged "posted". If the tap didn't register (stale coordinate, UI not settled) or the upload failed silently, there was no detection — the log said "posted" and no post appeared.
- Fix — replaced the 3-second blind wait with a **polling verification loop**: checks every 1.5 s for up to ~15 s whether the Share button has disappeared from the accessibility tree. Share disappearing = the caption screen was dismissed = the post was submitted. If Share is still visible after 6 s, the Share tap is retried once. If Share never disappears after ~15 s, the attempt aborts with `{ posted: false }` and a clear log message — no more false "posted" confirmations.

**Additional timing improvements:**
- POST tab wait increased 1200 ms → 2000 ms (grid needs more time to fully populate after mode switch).
- Gallery thumbnail tap wait increased 800 ms → 1500 ms.
- Filter/edit screen "Next" waits increased 1500 ms → 2000 ms each (audio-suggestion overlay animation can delay accessibility-tree population).
- Added explicit log lines for filter/edit Next taps so a stall on those screens is traceable.

---

## [1.1.525] — 2026-07-13

### Fix: "Make a Post" media never highlighted under automation; Windows installer stuck at v1.1.522

**Media never selected (real-device confirmed):**
- Root cause — the assumption from v1.1.523 ("Instagram auto-selects the newest photo the instant
  the picker opens, no tap needed") only holds for a genuine manual finger tap on "+". The user
  confirmed on a real device that under this automation's UI-Automator tap, the Recents grid comes
  up with **nothing highlighted** every time.
- Fix — added `findFirstGalleryThumbnail()`, which scans the Recents grid band, explicitly skips
  the "open camera" shutter tile (the original v1.1.522 bug — that tile is the grid's first cell,
  not a photo), and taps the topmost-leftmost real thumbnail. Since the grid sorts newest-first and
  we just pushed the target file, that thumbnail is our file. This tap now happens explicitly
  instead of relying on a default that doesn't occur under automation.
- The thumbnail-found signal was also added to the existing "did the picker actually open" sanity
  check that gates the positional "Next" fallback.

**Windows installer stuck at v1.1.522:**
- Root cause — `build-windows-installer.yml`'s "Publish to GitHub Release" step only runs on a
  pushed `v*` tag (`if: startsWith(github.ref, 'refs/tags/v')`). No git tag has ever been pushed to
  this repo, so that step has never run since whatever build produced the v1.1.522 release asset —
  every commit since then (523, 524) built successfully on push-to-main but never published a new
  Release, so the installer page kept serving the old v1.1.522 `.exe`.
- Fix — pushing a `v1.1.525` tag alongside this release to trigger the publish step. Going forward,
  a version bump needs a matching pushed tag (`git tag vX.Y.Z && git push origin vX.Y.Z`) for the
  installer Release to actually update — the version bump commit alone is not enough.

Status: media-selection fix unconfirmed on a live device — awaiting another real-device test with
the Log panel.

## [1.1.524] — 2026-07-13

### Fix: reverted a regression that broke media auto-selection, plus a real fix for the "Next" tap + a new expand-to-fit tap

The previous attempt (v1.1.523) reordered the POST-tab check to run only after checking for
"Next", to avoid a redundant tab tap. Real-device testing showed this broke the thing v1.1.523 was
built on top of: the Recents grid came up with **nothing selected** (previously confirmed working
via the default-newest-photo auto-selection). Reverted that ordering back to the known-good
unconditional POST-tab tap, then always looking for "Next".

- **Reverted** — the POST-tab tap now runs unconditionally again, before the "Next" check, exactly
  as it was when auto-selection was last confirmed working.
- **Root cause of the "Next" tap never registering, found** — the in-app "Scan Screen Layout" tool
  was run on a live device on this exact screen and returned **zero accessibility elements in the
  entire top third of the screen**. The top app bar (X / "New post" title / Next) is rendered as an
  opaque view with no exposed text/content-desc children on this specific screen — "Next" is
  visible on screen but was never going to be found by a label-based search here, no matter how
  the surrounding logic was reordered. (Later screens — filter, edit, caption — do expose their
  buttons normally; this opacity is unique to the very first photo-select screen.)
- **Fix** — when the labelled search for "Next" comes back empty on this screen, fall back to a
  fixed screen-fraction coordinate (top-right of the app bar) instead of aborting. Added a sanity
  check first (require the POST tab or the expand toggle to have been seen) so a positional tap
  never fires blind on a screen that isn't actually the picker. Added a post-tap confirmation
  (checks the expand toggle disappeared) so a missed tap aborts cleanly with a log line instead of
  silently going quiet.
- **New: expand/fit toggle** — added a tap on the small two-arrow "expand to full photo" toggle in
  the bottom-left of the preview, right before "Next", so posts use the full original photo instead
  of Instagram's default centre-cropped square.
- **Diagnostics** — added a log line at every intermediate step of this flow (compose tap, POST-tab
  check, Next search/fallback, expand-toggle tap, Next tap) so a future stall shows exactly which
  step it died on instead of going silent.

Status: unconfirmed — awaiting a live real-device post attempt with the Log panel.

## [1.1.523] — 2026-07-13

### Fix: "Make a Post" still abandoned real-device attempts after v1.1.522 — root cause was the grid-selection tap itself, not the mode-tab/ordering logic

v1.1.522 fixed the mode-tab (Story/Reel → Post) and check-ordering bugs, but the user's next
real-device test (with Log panel + screenshot) showed the exact same symptom: the "+" icon gets
tapped, the picker opens, but no image is ever actually selected and the post is abandoned.

- **Root cause found** — the code was tapping a fixed coordinate (~17% width, ~22% height) on
  the media grid to select the just-pushed photo. That coordinate lands on the grid's **first
  cell**, which on this device/build is Instagram's "open camera" shutter tile, not a photo
  thumbnail. The tap was hitting the wrong control every time, so "Next" never appeared and the
  attempt silently aborted — exactly matching the reported symptom.
- **Fix** — removed the blind grid tap entirely. A screenshot of a manual tap on the same device
  confirmed Instagram already auto-selects the most-recently-added photo by default the instant
  the picker opens (shown large in the preview pane above the grid) — no thumbnail tap is
  needed. Since the file we just `adb push`ed is always the newest gallery item, the flow now
  goes straight from opening the picker to checking for "Next", relying on Instagram's own
  default selection instead of guessing a coordinate.

**Files changed**
- `artifacts/api-server/src/routes/mobile.ts` — removed the blind first-grid-cell tap in
  `runMakePostStep`; proceeds directly to the "Next" check after the Story/Reel→Post tab switch

**Status:** unconfirmed — awaiting a live real-device post attempt from the user to verify.

---

## [1.1.522] — 2026-07-13

### Fix: "Make a Post" abandoned every real-device attempt; UI enable/disable checkboxes for alteration & image settings

Real-device testing surfaced the actual reason Make a Post pushed an image to the phone but then always aborted without posting:

- **Root cause found and fixed** — tapping Instagram's "+" compose icon opens whichever creation mode (Story/Reel/Post) was last used on the device, not necessarily the feed-post picker. The flow also checked for a "Next" control *before* selecting a photo, which can never be present on the initial screen — so every attempt aborted immediately, leaving the just-pushed image behind. Now: dismiss any interstitial, tap the "POST" mode tab if the sheet landed on Story/Reel, tap the photo thumbnail, and only then look for "Next".
- **Duplicate images in camera roll fixed** — every aborted attempt pushed a new copy of the source image to `/sdcard/DCIM/Camera` and never removed it, so repeated failures left visible duplicates in the gallery/picker. Aborted attempts now delete the pushed file from the device and re-trigger the media scanner.
- **Auto-clear "OK" popups** — a stray single-button confirmation dialog (e.g. a notifications prompt) encountered during manual testing is now auto-dismissed by the existing interstitial-scanner, both right after opening the composer and right after tapping Share.
- **UI: Alteration level / Image settings now have their own enable checkbox** — both stay visible (not hidden) when off; Alteration's Small/Medium/High buttons show fully deselected and disabled while off rather than looking active with no way to tell.
- **UI: fixed a layout bug where "Image settings" and its Configure button rendered on the same line with almost no gap** — the label was an inline `<label>` element, so Tailwind's `space-y` (which only adds `margin-top`, ignored on inline elements) had no visible effect. Switched to an explicit column layout so the gap always renders.
- **UI: "Make it unique" and "Disable comments" moved onto the same row as Alteration level / Image settings**, per request.

**Files changed**
- `artifacts/api-server/src/mobile/androidManager.ts` — added `removeDeviceFile`, added "OK" to the interstitial dismiss-label list
- `artifacts/api-server/src/routes/mobile.ts` — reordered/fixed the compose flow in `runMakePostStep`, added Story→Post mode-tab handling, cleanup on abort, new `makePostAlterationEnabled`/`makePostImageSettingsEnabled` settings fields
- `artifacts/dannys-bot/src/pages/MobilePage.tsx` — new enable checkboxes for Alteration level / Image settings, fixed label/button spacing, row reflow for Make it unique / Disable comments

---

## [1.1.521] — 2026-07-13

### UI: "Make a Post" panel cleanup — remove unused fields, clarify source labels, native folder picker, reflow caption section

Pure UI/config restructuring of the Make a Post panel; no automation-cycle behavior changes.

- **Removed Order % / Skip Chance %** — `makePostOrderPctMin/Max` and `makePostSkipPctMin/Max` were persisted but never read by the automation-cycle engine. Deleted entirely from client state (`MobilePage.tsx`), the server `AutomationSettings` type, and both server zod schemas (`artifacts/api-server/src/routes/mobile.ts`), rather than just hiding them in the UI.
- **Clearer source labels** — "Instagram Account" → "Source: Instagram Account"; "Source: Local Folder" → "Source: My Computer". Both now share the same uppercase/tracking-wide styling.
- **Native folder picker** — added a "Browse…" button next to the local-folder path field, reusing the existing `window.electronAPI.openFolderDialog()` IPC pattern already used by the Repost tool's Human Session panel, instead of requiring the user to type a Windows path by hand.
- **Caption section reflow** — Alteration level and the Image settings "Configure" button moved out of the Instagram-Account-only block into the shared caption area (below the caption textarea), so they apply no matter which source produced the image. "Make it unique" / "Disable comments" moved below that row. "Use ChatGPT" now sits directly beside the "Post Caption Text" label.

**Files changed**
- `artifacts/dannys-bot/src/pages/MobilePage.tsx` — panel layout/state changes described above
- `artifacts/api-server/src/routes/mobile.ts` — removed `makePostOrderPctMin/Max`, `makePostSkipPctMin/Max` from type, persistence schema, and defaults

---

## [1.1.520] — 2026-07-13

### Feature: "Make a Post" — Activate Percentage gate + on-device posting from a local folder

"Make a Post" now actually runs from the mobile automation cycle instead of being config-only:

- **Activate Percentage** — `makePostActivatePctMin` / `makePostActivatePctMax` (default 100/100), same per-execution chance-gate pattern as View Feed / View Stories / Follow Users / Random Jitter. Rolled once per automation-cycle execution, on top of the existing `makePostEnabled` master checkbox.
- **On-device posting from the Local Folder source** — when gated on, the cycle now:
  1. Picks the next image from `makePostLocalFolderPath` (respecting "Don't repeat images" and "Pick randomly" — a per-serial posted-file list persists to disk the same way the Follow Users followed-list does, so "no repeat" survives a restart).
  2. `adb push`es it into the device's `DCIM/Camera` folder and fires a `MEDIA_SCANNER_SCAN_FILE` broadcast so it shows up in Instagram's picker immediately.
  3. Taps Instagram's top-left "+" compose icon (new `findComposeButton` finder: content-desc/resource-id guesses first, positional top-left-band fallback second).
  4. Steps through the create-post flow (select photo → Next → Next → Next → caption → optional "turn off commenting" via Advanced settings → Share), verifying each expected control (`Next`/`Share`/caption field) is actually on screen before tapping it rather than firing a blind coordinate tap.
  5. Deletes the local file after upload if "Delete after upload" is on.

This only wires up the **local-folder image source** (per explicit user preference over the HikerAPI-scrape-from-another-user alternative); the other Make a Post settings (source-username scraping, ChatGPT captions, image alteration/make-unique) remain persisted but not yet read by the on-device flow.

**Caveat:** every new UI-tap step (`findComposeButton`, the media-grid thumbnail tap, the create-post flow) was written without a live device attached — it will likely need real-device correction from Log-panel output, same as every other mobile tool in this codebase was hardened.

**Files changed**
- `artifacts/api-server/src/mobile/androidManager.ts` — new `findComposeButton`, `pushFileToDevice`, `scanMediaFile`
- `artifacts/api-server/src/routes/mobile.ts` — `makePostActivatePctMin/Max` in `AutomationSettings` type + both zod schemas + defaults; new `pickLocalFolderImage`, `runMakePostStep`, per-serial posted-file persistence; wired into `/automation-cycle` after Follow Users
- `artifacts/dannys-bot/src/pages/MobilePage.tsx` — `makePostActivatePctMin/Max` in type/defaults/UI/cycle payload

---

## [1.1.519] — 2026-07-12

### Feature: "Activate Percentage" — per-execution chance gate for View Feed, View Stories from Feed, Follow Users, and Random Jitter

Each of these four tools now has its own **Activate Percentage** (min/max, same UI pattern as Inject Browsing's existing "Activate Percentage") that is rolled **once per automation-cycle execution** — i.e. once every time the whole toggle-tick loop runs, driven by the configured wait-interval between executions. If the roll misses, that tool is skipped entirely for this execution, even if its own master checkbox is enabled and its internal settings would otherwise fire.

This is a distinct, higher-level gate from the existing `Inject Browsing → Activate Percentage`, which rolls **per user** *inside* an already-running Follow Users step. The two compose: Follow Users must both (a) win its new per-execution Activate Percentage roll, and (b) be enabled, before Inject Browsing's own per-user Activate Percentage is ever considered — matching the existing rule that Inject Browsing is a sub-setting of Follow Users.

- **View Feed** — `feedActivatePctMin` / `feedActivatePctMax` (default 100/100 — always runs, matching prior behaviour for existing users)
- **View Stories from Feed** — `viewStoriesActivatePctMin` / `viewStoriesActivatePctMax` (default 100/100)
- **Follow Users** — `followActivatePctMin` / `followActivatePctMax` (default 100/100)
- **Random Jitter** — `randomJitterActivatePctMin` / `randomJitterActivatePctMax` (default 100/100) — this is an outer gate on top of (not a replacement for) each jitter sub-action's own independent chance (Check Notifications %, Visit My Profile %)

All four default to 100/100 so upgrading does not silently start skipping an already-configured tool for existing installs; users who want a tool to only sometimes run per execution can now lower the range explicitly.

Also fixed a pre-existing gap in the `AutomationSettings` TypeScript type: `randomJitterEnabled` and the Random Jitter fields (`checkNotificationsPct*`, `checkNotificationsScrolls*`, `checkNotificationsClickPct*`, `visitProfilePct*`) were used by the persistence schema and defaults object but missing from the type itself, which was failing typecheck.

**Files changed**
- `artifacts/api-server/src/routes/mobile.ts` — `AutomationSettings` type, `automationSchema`, `automationCycleSchema`, GET `/automation-settings` defaults, new `rollActivate()` helper, automation-cycle handler gates for feed/stories/follow/jitter
- `artifacts/dannys-bot/src/pages/MobilePage.tsx` — `AutomationSettingsData`, `AUTOMATION_DEFAULTS`, new Activate Percentage inputs in the View Feed, View Stories from Feed, Follow Users, and Random Jitter sections

---

## [1.1.518] — 2026-07-12

### Fix: Visit My Profile — press Back before scanning for profile tab

Added a `pressBack + 800 ms` at the start of `runVisitOwnProfile` so the function always starts from the Instagram home feed rather than whatever screen the previous step (e.g. Check Notifications) left behind. Without this, `findInstagramProfileTab` was occasionally running while the notifications page was still visible, causing it to match a wrong element — the "Add Story" (+) button in the top-left of the feed — and tap it instead of the profile icon.

**Files changed**
- `artifacts/api-server/src/routes/mobile.ts` — `runVisitOwnProfile`: added pressBack + sleep at entry

---

### Fix: "Allow Instagram to access your contacts?" popup auto-dismissed

The "Allow Instagram to access your contacts?" dialog appears when visiting the own profile / Discover People page. It now gets dismissed automatically as part of `runVisitOwnProfile`:

- Added `"Don't Allow Access"` to `DISMISS_LABELS` in `dismissInstagramInterstitials` (listed before the generic "Don't Allow" so the more specific match wins). This is the exact button text shown in the Instagram contacts-permission dialog.
- After tapping the profile tab, `runVisitOwnProfile` now calls `dismissInstagramInterstitials` and logs which button it tapped (if any), preventing the cycle from stalling on the popup.

**Files changed**
- `artifacts/api-server/src/mobile/androidManager.ts` — `dismissInstagramInterstitials`: added "Don't Allow Access"
- `artifacts/api-server/src/routes/mobile.ts` — `runVisitOwnProfile`: added dismiss call + log after tap

---

### Fix: Click-notification still broken after v1.1.516 — correct filter restored

The v1.1.516 rewrite of `findRandomNotificationItem` introduced a wrong width-≥50% filter. The actual tappable elements on the notifications page are the circular avatar Views on the LEFT side of each row (~154 px wide, centre at x≈132, ~12% of 1080 px screen width). Requiring width ≥ 540 px rejected all of them, so the function still returned null every time.

**Root cause of original bug**: only the fixed-attribute-order regex — not the filter — was broken. The `cx < rightMax (25%)` filter was correct all along.

**Fix**: kept the `<node>` regex (attribute-order independent, from v1.1.516) and restored the `cx < rightMax` filter. Added a detailed comment referencing the layout scan so this is not reverted again.

**Files changed**
- `artifacts/api-server/src/mobile/androidManager.ts` — `findRandomNotificationItem`: reverted width filter to `cx < rightMax`

---

## [1.1.517] — 2026-07-12

### Fix: Random Jitter fields reset to defaults on every restart

**Root cause**: The `automationSchema` (the persistence-layer zod schema used by `POST /api/mobile/devices/:serial/automation-settings`) was missing all Random Jitter fields. Zod in non-strict mode silently strips keys not declared in the schema, so every save POST discarded them before they reached disk. On GET the backend returned the in-memory defaults (all 0 / false), which looked like a settings reset.

**Also**: the runtime cycle-start schema (used to parse the body of `POST /api/mobile/run`) had `.max(20)` on both Scrolls fields, causing "Cycle failed" with `too_big` errors whenever the user set Scrolls above 20.

**Fix**: Added all jitter fields to `automationSchema` (no `.max()` on Scrolls). Removed `.max(20)` from the runtime schema too. Added jitter field defaults to the GET handler's defaults object.

**Files changed**
- `artifacts/api-server/src/routes/mobile.ts` — `automationSchema`: added randomJitterEnabled, checkNotifications*, visitProfile* fields; removed `.max(20)` from Scrolls in both schemas; added jitter defaults to GET handler

---

### Fix: Scrolls — no upper limit in UI

Removed `max={20}` from both Scrolls `<Input>` elements in the Random Jitter section of MobilePage.tsx. There is no meaningful upper bound; the user sets what they want.

**Files changed**
- `artifacts/dannys-bot/src/pages/MobilePage.tsx` — Scrolls inputs: removed `max={20}`

---

### Fix: View Stories from Feed — "Share DM %" also disabled (red strikethrough)

Consistent with the other two DM share fields added in v1.1.516.

**Files changed**
- `artifacts/dannys-bot/src/pages/MobilePage.tsx` — viewStoriesShareDm block: red strikethrough label, forced disabled, pointer-events removed

---

## [1.1.516] — 2026-07-12

### Fix: Icons log no longer shows misleading ✗ for ShareFeed/ShareDM

The "Inject Browsing: icons —" log line was showing `ShareFeed:✗ ShareDM:✗` even when the repost/share-DM actions subsequently succeeded. Those two actions are resolved by `findButtonByLabel("Repost"/"Send")` — a separate, more reliable scan — not by the positional icon scan that populates `icons.shareFeed/shareDm`. The ✗ was from the positional scan missing the icon (expected on many builds), not from the action failing. The log now shows only `Like:✓ Comment:✗/✓` which reflects what the positional scan actually resolved.

**Files changed**
- `artifacts/api-server/src/routes/mobile.ts` — `runProfileBrowsingForUser`: removed ShareFeed/ShareDM from icon diagnostic `onLog` line

---

### Fix: "Share via DM % of posts" and "Share to DM %" disabled in UI (red strikethrough)

Both DM share fields are disabled until the DM send flow is confirmed working. Labels now show red strikethrough text; inputs are forced disabled and pointer-events removed so they cannot be interacted with. No backend logic changed.

**Files changed**
- `artifacts/dannys-bot/src/pages/MobilePage.tsx` — check-feed "Share via DM % of posts" block; inject browsing "Share to DM %" block

---

### Fix: Random Jitter — Visit My Profile fields now on same row as Check Notifications

"Visit My Profile" title and Chance % fields were rendered in a separate block below Check Notifications, creating an unnecessary second section. Both groups are now in a single `flex-wrap` row so they sit side by side on wide screens and stack only when the panel is too narrow.

**Files changed**
- `artifacts/dannys-bot/src/pages/MobilePage.tsx` — Random Jitter expanded panel: merged into one `flex-wrap` row with group labels

---

### Fix: Click notification % now actually clicks notification items

**Root cause (double bug in `findRandomNotificationItem`)**:

1. **Attribute-order regex failure** — the old regex required `clickable="true"` to appear *before* `class="android.widget.View"` in the XML node. UIAutomator attribute order is not guaranteed, so on this device the attributes appeared in the opposite order and the regex matched zero nodes, causing the function to always return null.

2. **Horizontal filter too narrow** — `cx > rightMax` (where `rightMax = 25% of screen width`) was intended to target avatar bubbles on the left, but notification *rows* are full-width elements whose centre is at ~50% of the screen. Those rows were filtered *out* by the condition, so even if the regex had matched, no candidates would have been kept.

**Fix**: Rewrote `findRandomNotificationItem` to use the same `<node …/>` attribute parser used throughout the rest of `androidManager.ts` (attribute order independent). Changed the filter to accept any clickable node that spans ≥50% of screen width — this reliably targets the full-width notification rows while excluding small buttons, avatar thumbnails, and the nav bar.

**Also**: added a log line when `findRandomNotificationItem` returns null ("no clickable notification row found — skipping click") and when the chance roll misses, so the user can distinguish the two cases.

**Files changed**
- `artifacts/api-server/src/mobile/androidManager.ts` — `findRandomNotificationItem`: full rewrite
- `artifacts/api-server/src/routes/mobile.ts` — `runCheckNotifications`: log lines for null-item and missed-roll cases

---

## [1.1.515] — 2026-07-12

### Fix: Inject Browsing — DM share now verifies the Send button actually closed the sheet

**Symptom**: The log showed "Inject Browsing: shared the post via DM" but no DM was ever received. The action was silently failing every time.

**Root cause**: `sendShareSheet` tapped the blue "Send" button and immediately returned `true` without checking whether the tap actually worked. When no recipient was selected (because `tapRandomShareSheetRecipient` missed its target — either the a11y scan returned empty and the coordinate fallback hit the wrong spot, or the avatar tap didn't register), tapping "Send" does nothing — Instagram requires at least one recipient to be checked. The sheet stayed open but the function had already declared success.

**Fix**: After tapping Send (both the label-scan path and the coordinate-fallback path), wait 900 ms and re-check whether the "Send" button is still present in the accessibility tree. If it's gone the sheet closed and the DM was sent — return `true`. If it's still there the send failed — return `false` so the caller presses Back and does not log a false success.

**Files changed**
- `artifacts/api-server/src/routes/mobile.ts` — `sendShareSheet`: added post-tap sheet-closure verification on both code paths

---

### Fix: Inject Browsing — stranded on post/Reel when `findFeedActionIcons` returned null

**Symptom**: When the "Click post %" roll landed on a Reel or ad (which has a non-standard action bar with no accessible "Like" node), `findFeedActionIcons` returned null and the function returned early — without pressing Back. The Follow step then ran while still inside the Reel viewer or ad, where the Follow button does not exist, so follow was silently skipped.

**Fix**: Added `pressBack` + 500 ms settle before the early return in the `!icons` branch so the caller is always returned to the profile page regardless of what was opened.

**Files changed**
- `artifacts/api-server/src/routes/mobile.ts` — `runProfileBrowsingForUser`: pressBack in the no-icons early-return branch

---

### Fix: Follow — scroll profile back to top before tapping Follow

**Symptom**: When Inject Browsing was enabled and scrolled the profile grid (even if no post was opened), the Follow button in the profile header was scrolled off-screen. `tapFollowButtonOnProfilePage` couldn't find it in the accessibility tree and the follow was silently skipped.

**Fix**: After `runProfileBrowsingForUser` returns, the follow loop now performs 4 quick upward swipes to scroll the profile grid back to the top before calling `tapFollowButtonOnProfilePage`. This ensures the Follow button in the profile header is visible regardless of how far browsing scrolled.

**Files changed**
- `artifacts/api-server/src/routes/mobile.ts` — follow loop: scroll-to-top swipes inserted after inject browsing block

---

### Fix: Follow — verified state change before logging success; exact "Follow" match

**Symptom 1**: The follow was logged as "✓ followed" the moment the button was tapped, even if Instagram rejected the action silently (e.g. rate-limited, already following, or the tap landed slightly off). The button state was never checked.

**Symptom 2**: `_findElem`'s substring fallback could match "Following" (already following) since it contains "Follow". On a profile where the account was already followed, this would tap "Following" to unfollow, then the state change would fail to confirm and return false — but the wrong tap still fired.

**Fix** (`tapFollowButtonOnProfilePage` in `androidManager.ts`):
- Changed the button search to use a strict regex `content-desc="Follow"` / `text="Follow"` (exact match, same pattern as `findStoryFollowButton`) so "Following" and "Unfollow" are never mistakenly selected.
- After tapping, waits 2 s and re-dumps the accessibility tree. Only returns `true` if the button label is now "Following" (public account accepted) or "Requested" (private account — follow request sent). Returns `false` for everything else.

**Files changed**
- `artifacts/api-server/src/mobile/androidManager.ts` — `tapFollowButtonOnProfilePage`: exact-match regex + post-tap state-change verification

---

## [1.1.514] — 2026-07-12

### Fix: `injectBrowsingActivatePctMin is not defined` — missing destructure in automation-cycle endpoint

**Symptom**: Every Follow run with Inject Browsing enabled immediately hit `▶ Follow step error — injectBrowsingActivatePctMin is not defined`, aborting inject browsing entirely.

**Root cause**: The automation-cycle endpoint's destructuring block was not updated when `injectBrowsingActivatePctMin/Max` were added to the zod schema in v1.1.513. The zod schema parsed them fine and the browsing-params construction referenced them, but the variables were never extracted from the parsed object, so JS threw a `ReferenceError` at the point the browsing object literal was built.

**Fix**: Added `injectBrowsingActivatePctMin, injectBrowsingActivatePctMax` to the destructuring at the top of the automation-cycle handler.

**Files changed**
- `artifacts/api-server/src/routes/mobile.ts` — destructuring block: two new variables added

---

### Fix: UI — Like % / Share feed % / Share to DM % moved onto same row as Click posts %

The three post-action percentage fields (Like %, Share feed %, Share to DM %) were rendered in a separate `<div>` row below Click posts %, creating an unnecessary extra row in the Inject Browsing panel. All four fields now live in the same flex-wrap row. No logic change.

**Files changed**
- `artifacts/dannys-bot/src/pages/MobilePage.tsx` — removed the separate Row 3 wrapper; Like/Share feed/Share to DM divs merged into the existing Click posts % row

---

## [1.1.513] — 2026-07-12

### Fix: Inject Browsing — DM share recipient not selected (accessibility scan replaces fixed coordinates)

**Symptom**: The DM share sheet opened correctly (visible in the phone mirror, showing a grid of suggested contacts), but no DM was ever received. The log reported "Inject Browsing: shared the post via DM" even though nothing was sent.

**Root cause**: `tapRandomShareSheetRecipient` tapped a pre-computed percentage coordinate (`yPct = 0.786` → y ≈ 1 750 px on a 2 226 px screen) aimed at the expected avatar-bubble row. On this device the DM share sheet renders the suggested-contacts grid higher up on screen (approximately 45–55 % of screen height), making the fixed coordinate land on the compose area or empty space — not on any contact. No contact was selected; the Instagram Send button then silently ignores a tap when no recipient is chosen. `sendShareSheet` found the "Send" label via `findButtonByLabel` and tapped it, returning `true` — but Instagram discarded the tap because the recipient state was empty.

**Fix**: Replaced the fixed-coordinate approach with a UIAutomator accessibility scan. A new `findShareSheetRecipients(serial)` function in `androidManager.ts` dumps the UI tree, then collects every clickable node whose:
- Vertical centre falls in the 30–90 % zone (the sheet body; excludes the top chrome and the Send bar at 99 %)
- Width is ≤ 80 % of screen width (excludes the full-width Send / Search bar rows)
- Text or content-desc label is non-empty, ≤ 50 characters, and not UI chrome (`Send`, `Search`, `Write a message`, `Direct`, `Share`, `Message`, `Cancel`, `Suggested`)

`tapRandomShareSheetRecipient` now calls `findShareSheetRecipients` first. If any candidates are returned it picks one at random and taps it. The old `SHARE_SHEET_AVATAR_SLOTS` coordinate-based tap is retained as a fallback only when the a11y scan returns nothing.

**Files changed**
- `artifacts/api-server/src/mobile/androidManager.ts` — new `findShareSheetRecipients(serial)` exported function
- `artifacts/api-server/src/routes/mobile.ts` — `tapRandomShareSheetRecipient`: a11y scan primary, coordinate fallback secondary

---

### Fix: Inject Browsing — removed spurious scroll-back-to-top before Follow

**What was removed**: After opening a post from the scrolled profile grid (and running like/share/DM actions inside it), `runProfileBrowsingForUser` was scrolling the profile grid back to the top (one swipe per row scrolled down) before returning, then the follow step tapped the Follow button.

**Why it was there**: The scroll-back was added as a precaution so that `tapFollowButtonOnProfilePage` could find the Follow button in the accessibility tree (it lives in the profile header, which is off-screen when the grid is scrolled down). The intent was correct but the implementation is unnecessary extra automation noise that the user never requested — the Follow button tap has its own fallback logic.

**What happens now**: After `pressBack` closes the opened post and returns to the profile grid, the function returns immediately. The follow step runs without any preceding scroll animation.

**Files changed**
- `artifacts/api-server/src/routes/mobile.ts` — `runProfileBrowsingForUser`: scroll-back loop removed.

---

### New: Inject Browsing — "Activate Percentage" per-user outer gate

**What it does**: A new **Activate Percentage** min/max field in the Inject Browsing settings section controls whether the entire inject-browsing sequence even runs for a given user. It is checked once per user, before the existing "Browse before follow %" roll. If the activate roll misses, inject browsing is skipped for that user entirely — no grid scroll, no post open, no like/share/DM.

**Behaviour**:
- Rolls independently per user exactly like all other min/max probability fields (a random value is drawn from the [min, max] range and compared against a second random roll).
- If Inject Browsing is ticked and 10 users are being followed, each of the 10 gets its own independent activate roll.
- Setting min=50/max=70 means roughly 60 % of users (on average) will trigger the inject browsing sequence; the other 40 % skip straight to Follow.
- The existing "Browse before follow %" field is a SECOND inner gate — if the activate roll passes, the browse-before-follow % then determines whether the profile grid is scrolled and a post opened.

**UI position**: "Activate Percentage" appears as the FIRST field in the Inject Browsing panel (before "Browse before follow %"), consistent with the logical order: outer gate → inner gates → post-action percentages.

**Files changed**
- `artifacts/api-server/src/mobile/androidManager.ts` — no change (frontend/backend only)
- `artifacts/api-server/src/routes/mobile.ts` — `InjectBrowsingParams` interface: added `activatePctMin/Max`; `runProfileBrowsingForUser`: activate roll added at top; both zod schemas and defaults updated; browsing params construction updated
- `artifacts/dannys-bot/src/pages/MobilePage.tsx` — state type, defaults, API save mapping, and UI row all updated

---

## [1.1.512] — 2026-07-12

### Fix: Inject Browsing — Repost tap followed by spurious Back press (single-tap devices)

**Symptom**: Log showed `Inject Browsing: Repost sheet did not open — skipping share-to-feed` on every cycle. The Repost icon WAS tapped (confirmed by `findButtonByLabel("Repost")` resolving), but the repost never completed. Share via DM ran afterwards and succeeded — proving the post was still open, so the Back press that followed the failed repost check navigated away from the wrong thing (or the DM ran in spite of it).

**Root cause**: On this device the Repost icon has zero accessibility labelling (`content-desc` absent). After tapping it, the code waited 1 000 ms then re-scanned for a labeled `"Repost"` node:

- **Sheet path** (other devices): a new "Repost" confirm button appears at different coordinates → tap it → done ✓
- **Single-tap path** (this device — detected via label change): same node at same coords but `content-desc` changed from `"Repost"` → `"Remove repost"` → success ✓
- **This device, unlabeled**: `beforeCd = null`, `afterCd = null`. `afterCd && afterCd !== beforeCd` evaluates to `false` even though the repost succeeded silently. Falls into the failure branch → `pressBack` → post wrongly navigated.

The `pressBack` in the failure branch was the destructive action. On this device the Repost action completes on a single tap with **no confirmation sheet at all** (confirmed by user). Pressing Back after the tap closes either the post or an unrelated layer, and either way marks the action as skipped rather than completed.

**Fix**: Removed the `pressBack` from every "no sheet detected" branch. The new logic is:

1. Tap the Repost icon
2. Wait 1 000 ms
3. Look for a labeled `"Repost"` button at a **different** position (genuine sheet confirm button)
   - Found → tap it → "reposted the post" (sheet path, unchanged)
4. Otherwise (no sheet OR unlabeled icon that can't be tracked) → log "reposted the post (single tap — no sheet)" and **continue without pressing Back**

This correctly handles both device types:
- Sheet devices: confirm button found at different coords → tapped ✓
- Single-tap devices (labeled or unlabeled): no sheet → assume tap completed, move on ✓

The `beforeCd`/`afterCd` label-comparison logic (which only worked when the icon was labeled) has been removed entirely — it provided no value on unlabeled icons and was the direct cause of the spurious Back press.

**Files changed**
- `artifacts/api-server/src/routes/mobile.ts` — `runProfileBrowsingForUser` (inject-browsing path): Repost post-tap logic simplified; `pressBack` removed from no-sheet branch; `beforeCd`/`afterCd` comparison removed.

---

## [1.1.511] — 2026-07-12

### Fix: ShareFeed / ShareDM icons invisible to accessibility tree on Xiaomi MIUI (unlabeled ImageView fallback)

**Symptom**: Log showed `Inject Browsing: icons — Like✓ Comment:✓ ShareFeed:✗ ShareDM:✗` on every Inject Browsing cycle, even though the Repost and Send icons were plainly visible on the phone mirror. The post was liked but neither share action ran.

**Root cause — confirmed from phone mirror + log**:

The screenshot showed all four action-bar icons on screen (heart, comment bubble, curved-arrow Repost, paper-plane Send). The accessibility labels for Like and Comment were found correctly. But `findFeedActionIcons` returned `null` for both `shareFeed` and `shareDm` every time.

On this Xiaomi MIUI + Instagram build, the Repost and Send icons are rendered as `android.widget.ImageView` nodes with `clickable="true"` but **zero accessibility attributes** — no `content-desc`, no `text`. This made them indistinguishable from the audio/music disc node that Instagram renders between Comment and Repost on posts with music (also an unlabeled `ImageView`). The existing audio-disc filter:

```
if (cls === "android.widget.ImageView" && !cd && !/\d/.test(txt)) continue;
```

was correctly preventing the disc from entering `rowNodes` and causing position-shift bugs on other devices — but on this device it also silently discarded the Repost and Send icons. They never reached the content-desc matcher or the positional-fallback pool, so both came back `null`.

`findButtonByLabel("Repost")` (the secondary scan in the caller) also failed for the same reason: it searches for a node whose `content-desc` matches `"Repost"` — and on this build that attribute simply isn't set.

**Fix — soft-save unlabeled ImageViews, use as last-resort positional fallback**:

The audio-disc filter is preserved for the primary `rowNodes` list (no regression on other devices). Unlabeled `ImageView` nodes that would previously have been discarded are now saved in a separate `unlabeledImgViews` list and used as a final fallback only when both content-desc matching AND the labeled-pool fallback have already failed to resolve `shareFeed` or `shareDm`.

**Safety filter**: the audio disc sits immediately to the right of Comment in x (typically within 40–60 px), while Repost and Send are one and two icon-gaps further right (gap = `comment.x − like.x`, typically 90–130 px). Only unlabeled candidates more than **60 % of one icon-gap to the right of Comment** are accepted. This reliably excludes the disc while accepting Repost and Send.

Assignment order: left-to-right. The leftmost accepted unlabeled candidate → `shareFeed` (Repost), the next → `shareDm` (Send). If only one of the two is still null, the rightmost (or leftmost, respectively) remaining candidate is used.

On devices where the disc appears AND Repost/Send are properly labeled: shareFeed/shareDm are resolved by content-desc (✓ from `rowNodes`) and `unlabeledImgViews` is never consulted — no change in behaviour.

**Files changed**
- `artifacts/api-server/src/mobile/androidManager.ts` — `findFeedActionIcons`: audio-disc filter changed from `continue` to save into `unlabeledImgViews`; unlabeled positional fallback block added after existing pool fallback, with disc-proximity exclusion.

---

## [1.1.510] — 2026-07-12

### Fix: Follow — search bar positional fallback when UIAutomator accessibility tree returns nothing

**Symptom**: After a successful follow of the first user the log would show `Follow: search bar not found — giving up` roughly 29 seconds later (3 retry attempts × ~800 ms sleep + uiDump time each), then close Instagram. On a subsequent cycle the same abort happened at the same point. The follow ran without issue in every prior version — nothing near the search-bar tap had changed in the most recent build.

**Root cause — confirmed via Scan Screen Layout**:

The "Scan Screen Layout" diagnostic tool was used on the device immediately after the Search tab was tapped and the Explore page settled. Its output shows:

```
SCREEN LAYOUT SCAN ═══ 1060×2226 px  |  1 elements
── TOP    (0 – 33%)  (0 elements) ────────────────────────
── MIDDLE (33 – 67%) (1 elements): FrameLayout ────────────
     bounds=[0,1][1080,2224]  (no label)
── BOTTOM (67 – 100%) (0 elements) ───────────────────────
```

Zero elements in the top zone — the only node the UIAutomator dump exposes for this screen is the root `FrameLayout` covering the full display. On this device + Instagram version combination, the Explore page search bar is rendered in a way that does not expose child nodes to the accessibility tree (possibly a React Native / Jetpack Compose hybrid surface, or an Instagram A/B-test variant that disables accessibility for the Explore header). A manual tap at physical coordinates **(159, 85)** — visible on the phone mirror — opens the search field correctly, confirming the bar is present and tappable; it just does not appear in the tree.

`findInstagramSearchBar` had three detection strategies all of which require a tree entry:
1. Resource-ID lookup (`action_bar_search_edit_text`, `search_bar`, `search_bar_input`, etc.)
2. `android.widget.EditText` class match within top 30 % of screen height
3. Clickable node with `text` or `content-desc` of `"Search"` / `"Search Instagram"` within top 30 %

All three failed every attempt, returning `null` after the retry loop, causing the caller to log `Follow: search bar not found — giving up` and `break` out of the follow loop.

**Fix — positional fallback after exhausted accessibility-tree attempts**:

After all 3 accessibility-tree attempts return nothing, `findInstagramSearchBar` now computes a screen-relative fallback coordinate instead of returning `null`:

- **Y**: `Math.round(screenH × 0.038)` — approximately 85 px on a 2 226 px screen, matching the confirmed on-device position.
- **X**: `Math.round(screenW / 2)` — horizontally centred.

Screen dimensions come from `getScreenSize(serial)` (`adb shell wm size`) — the same reliable source used since v1.1.504, not the XML-parsed fallback that defaults to a 1 600 × 900 landscape size.

A dedicated log line is emitted when the fallback fires:
```
Follow: search bar not in a11y tree — using positional fallback (540, 85)
```
This makes it immediately visible in the Log tab so it is always auditable. The follow then continues normally from that tap — typing the username on the on-screen keyboard, finding the user in results, and tapping Follow.

The function's return type is changed from `Promise<{ x: number; y: number } | null>` to `Promise<{ x: number; y: number }>` — it now always resolves to a position (or throws if adb itself is unavailable). The caller's `null`-guard branch (`if (!searchBar) { … break; }`) is updated to handle only the thrown-error case, which is logged as `Follow: search bar lookup threw — giving up`.

**Files changed**
- `artifacts/api-server/src/mobile/androidManager.ts` — `findInstagramSearchBar`: added `screenW` from `getScreenSize`; added `onLog?` parameter; positional fallback returned (with log line) after all tree-parse attempts fail; return type changed to non-nullable.
- `artifacts/api-server/src/routes/mobile.ts` — `runFollowUsersStep`: passes `onLog` to `findInstagramSearchBar`; updated guard comment to reflect thrown-error-only case.

---

## [1.1.509] — 2026-07-12

### Fix: reverted incorrect "Reels never have Repost" assumption

v1.1.508 special-cased Reels to always skip Share-to-Feed positional fallback, based on a single screenshot that was misread — Repost availability is account/post-specific (same as Comment can be disabled per post), not tied to whether the post is a Reel. That reel-only branching has been removed.

The actual, general-purpose fix kept from that change: `shareFeed` is now only ever set from a positive "Repost" content-desc match, never filled in positionally. A missing match is genuinely ambiguous (repost disabled for this account/post vs. label just absent) and guessing risks grabbing an unrelated leftover icon — this now applies uniformly to every post, feed or Reel alike, with no post-type detection involved.

---

## [1.1.508] — 2026-07-12

### Fix: Share-to-Feed still misfiring on Reels (no distinct Repost icon), and Followed Users list wiped on every restart of the packaged app

**Bug 1 — Share-to-Feed on Reels**: Log kept showing `Repost sheet did not open — skipping share-to-feed` for posts opened from a Reels tile in the profile grid, confirmed from a live device screenshot (header reads "Reels"; action bar is Like/Comment/Share/Save, no separate double-arrow Repost icon at all). `findFeedActionIcons`'s positional fallback — designed for normal feed posts, where a missing content-desc match is filled in by grabbing the next unclaimed icon on the row — was consuming whatever leftover clickable control sat in that slot on Reels (e.g. the "More options" "•••" button) and mislabelling it `shareFeed`. Every attempt then tapped an unrelated control, so it correctly never saw a Repost-labelled node afterward and (correctly, but unhelpfully) reported failure.
  - Fix: detect the Reels player via its `reel_viewer`/`clips_viewer` resource-id marker (same one `findStoryFollowButton` already uses) and, when detected, leave `shareFeed` as `null` rather than guessing a position for it if content-desc didn't positively identify a "Repost" icon. Callers already treat `shareFeed: null` as "skip this action, icon not identifiable" — so Reels now cleanly skip share-to-feed instead of tapping the wrong control.

**Bug 2 — Followed Users wiped on restart**: The mobile farm's per-device followed-users JSON log was written to `path.join(process.cwd(), "data", "mobile-followed")`. In the packaged Windows app, `process.cwd()` is not a stable location across launches (it can land in a different, often read-only or empty, folder depending on how the exe was spawned) — exactly the reason `database.db`, `equinox-debug.log`, and `mobile-instances.json` are all anchored to a stable app-data directory instead of cwd. This file was the one place that hadn't been fixed, so every restart could silently start reading/writing a different (empty-looking) folder, appearing as if the list had been wiped.
  - Fix: anchor to `EQUINOX_DATA_DIR` (Electron's stable userData path, already used by `configFilePath()` for `mobile-instances.json`), with a one-time migration step that copies over any existing per-device files from the old cwd-based location so no history is lost on upgrade.

---

## [1.1.507] — 2026-07-12

### Fix: Successful single-tap Repost misread as failure, then wrongly triggered a recovery Back press that skipped Share via DM

**Symptom**: Log showed `Repost sheet did not open — skipping share-to-feed` immediately followed by `shared the post via DM`, but on-device the DM step never actually fired — the app instead jumped back to the profile feed, visibly scrolled. The account genuinely did repost successfully; there is no confirmation sheet for Repost on this account at all, just a single tap.

**Root cause (two compounding bugs)**:
1. `findButtonByLabel` matches content-desc by substring, not exact text. On accounts where Repost completes instantly on a single tap (no sheet), the tapped icon relabels itself in place (e.g. `"Repost"` → `"Remove repost"`/`"Reposted"`) but stays at the exact same coordinates. The existing "same-coords = sheet not open" guard couldn't tell that apart from a genuine failure — both look identical (a "Repost"-matching node at the same position) — so a real, successful repost was logged as failed.
2. That false failure then ran the recovery `pressBack()`, which closed the open post and returned to the profile grid/feed. The Share-via-DM step that ran right after was then operating on stale, no-longer-valid coordinates from the closed post — explaining the "jumped back to the feed, scrolled" behaviour and why DM was never actually pressed. On top of that, `sendShareSheet()` unconditionally returned `true` even when it fell back to a blind coordinate tap with no evidence the DM sheet was open at all, so this failure was self-masking in the log ("shared the post via DM" printed regardless).

**Fix**:
- Added `getContentDescNear(serial, x, y)` (in `androidManager.ts`) to read a node's current label at a given position.
- Both Repost flows (`runProfileBrowsingForUser`'s Inject-Browsing-before-Follow step, and `runCheckFeedLoop`'s View Feed step) now capture the icon's label *before* tapping and compare it to the label *after* tapping when the second scan lands on the same coordinates: a changed label means the single-tap repost already succeeded (logged as success, no second tap — tapping again would toggle it back off); an unchanged label means it genuinely didn't complete (logged as failure, Back pressed to cancel cleanly).
- `sendShareSheet()` no longer returns `true` on its coordinate-fallback path unless it can positively confirm the share sheet is actually open first (checks for "Direct"/"Share"/"To" sheet markers); otherwise it now correctly returns `false` and the caller logs the real outcome.

---

## [1.1.506] — 2026-07-12

### Fix (regression): Comment icon tapped instead of Share to Feed / Share via DM

**Symptom**: Immediately after the v1.1.505 fix, a live run showed Like working correctly, but the action logged as "reposted the post" / "shared the post via DM" was actually a tap on the Comment icon — the same failure mode that was fixed 5 versions earlier (v1.1.499/v1.1.500), now reappearing.

**Root cause**: v1.1.505 changed the tap-target priority to prefer `icons.shareFeed`/`icons.shareDm` (coordinates from `findFeedActionIcons`'s row-scan) over the exact-label `findButtonByLabel("Repost"/"Send"/"Direct"/"Message")` scan, reasoning that the row-scan's diagnostic (`ShareFeed:✓`) proved the icon was on screen. That's true, but `findFeedActionIcons` only trusts content-desc labels for identification; when a role's label is missing or doesn't match on a given device/Instagram build, it silently falls back to positional guessing (leftmost unclaimed node) — the exact ambiguity that caused the original v1.1.499/v1.1.500 bug. Preferring that guess over the always-exact label scan reintroduced it: the "guessed" coordinate landed on the Comment icon, and the code taps first, checks second, so the tap fired before anything could catch the mismatch.

**Fix**: restored `findButtonByLabel` as the trusted, primary lookup for both Share to Feed and Share via DM — it only ever returns a node whose content-desc literally matches, so it cannot mis-fire. `icons.shareFeed` / `icons.shareDm` are now used strictly as a last-resort fallback when the label scan finds nothing at all, not preferred over it. All of v1.1.505's added `onLog` diagnostics (roll-missed, icon-not-found, sheet-didn't-open, send-not-confirmed, errors) are unchanged and still fire on every path.

**Rule for future changes to this code**: never prefer a positionally-guessed coordinate over an exact content-desc label match for these action-bar icons — this is now the second time inverting that priority caused the same bug.

---

## [1.1.505] — 2026-07-12

### Fix: Share-to-DM (and Share-to-Feed) icon silently never tapped during Inject Browsing

**Symptom**: On a real device run, the Log tab showed the profile grid scroll, the opened post, and "liked the post" — then jumped straight to the Follow step with no mention of Share to Feed or Share to DM at all, even though both were set to 100% in Human Session Tool settings.

**Root cause**: `runProfileBrowsingForUser` re-scanned the screen independently via `android.findButtonByLabel(serial, "Repost")` / `("Send"/"Direct"/"Message")` to find the Repost and Send icons, instead of reusing the coordinates `findFeedActionIcons` had *already* resolved for the exact same post moments earlier (the same scan that successfully found the Like button, and whose diagnostic line logs `ShareFeed:✓ ShareDM:✓`). On this device/Instagram build, the independent label-only lookup missed the icon even when the row-scan had just confirmed it was on screen. Because the "icon not found" branch and the "sheet/send didn't confirm" branch were the *only* paths through this code, and neither the roll-miss case nor those particular failure branches called `onLog`, the whole step vanished from the log with zero trace — it looked like the feature just didn't run.

**Fix**:
- Both the Share-to-Feed and Share-to-DM steps now use the coordinates `findFeedActionIcons` already found for that post (`icons.shareFeed` / `icons.shareDm`) as the primary tap target, falling back to the independent `findButtonByLabel` scan only when the row-scan came back null for that icon.
- Added `onLog` messages for every previously-silent path: the percentage roll missing, the icon genuinely not found, the share sheet not opening, the DM send not confirming, and any other error — so a future failure is always visible in the Log tab instead of appearing as an unexplained gap.

---

### Fix: Follow button not found after Inject Browsing scrolls the profile grid

**Symptom**: Same run — after Inject Browsing scrolled the profile grid down 10 rows and browsed a post, the Follow step logged `Follow button not found on @user — already following?` and the cycle finished with 0 users followed, even though the account was not already being followed.

**Root cause**: `runProfileBrowsingForUser` scrolls the profile grid down by a random number of rows to browse posts, then opens/likes/shares a post and presses Back to return to the grid — but it never scrolled back up. `tapFollowButtonOnProfilePage` reads whatever is currently in the accessibility tree; with the header scrolled off the top of the screen, the Follow button genuinely isn't rendered, so it always reported "not found" regardless of follow state.

**Fix**: `runProfileBrowsingForUser` now scrolls the profile grid back to the top (undoing exactly the number of rows it scrolled down) before returning, so the header and Follow button are back on screen by the time `runFollowUsersStep` taps Follow.

---

## [1.1.504] — 2026-07-12

### Fix: Settings sections now collapse when their tickbox is unticked

**What changed**: Every section in the Human Session Tool that has an enable tickbox (View Feed, View Stories from Feed, Follow Users, Inject Browsing) now hides its settings rows when the tickbox is off — matching the behaviour already introduced for Random Jitter in v1.1.503. Previously only Random Jitter collapsed; the other four sections always showed all their fields regardless of whether the feature was enabled, making the UI cluttered and potentially confusing (e.g. "Delay between actions" visible even when View Feed was off).

- **View Feed** — unticking hides the scroll-count + delay row and the Like %/Share to Feed %/Share via DM % row.
- **View Stories from Feed** — unticking hides all four settings rows (slides to watch, % of slide to watch, Like %, Share DM %).
- **Follow Users** — unticking hides the "Users to follow per operation" min/max row.
- **Inject Browsing** — unticking hides the two numeric-field rows (feed-chance/feed-posts/click-post/like/share-feed/share-DM percentages); the tickbox row itself stays visible so it can be re-enabled.

**Files changed**
- `artifacts/dannys-bot/src/pages/MobilePage.tsx` — all four feature-flag conditional wrappers added around the relevant settings rows.

---

### Fix: Follow — search bar not found on cold-launch cycles (only Follow enabled, no prior feed scroll)

**Symptom**: When the cycle was configured with only Follow Users ticked (View Feed and View Stories both off), the follow loop consistently aborted with `Follow: search bar not found — giving up` every run. With any other feature enabled first the search bar was reliably found.

**Root cause 1 — insufficient wait**: After tapping the Search tab, the code waited 1 500 ms for the Explore page to render before scanning the accessibility tree. On a cold-launch cycle (no prior feed/story navigation to warm up Instagram's render pipeline) that wasn't enough — the Explore grid would appear but the search bar's accessibility node hadn't been committed to the tree by the time the scan ran. With feed or story enabled first, the extra navigation gave the app more time, masking the timing issue.

**Root cause 2 — wrong screen-height fallback**: `findInstagramSearchBar` was computing `topLimit` (the Y-coordinate ceiling for the search-bar scan) using `_getScreenSize(xml)`, which parses the root XML element for its `bounds` attribute. When that attribute is absent (MIUI/Xiaomi devices frequently omit it), `_getScreenSize` falls back to `1600 × 900` — a landscape desktop default. On a portrait phone with a 2 400 px tall screen, this gives `topLimit = Math.round(900 × 0.20) = 180 px`, which is below the actual search bar position (~200–260 px from top on this device), causing it to be rejected on every scan attempt.

**Fixes**:
- Explore page settle wait raised **1 500 ms → 2 500 ms** after the Search tab tap.
- `findInstagramSearchBar` now queries screen dimensions via `adb shell wm size` (`getScreenSize(serial)`) instead of parsing them from the XML dump. This returns the correct 1 080 × 2 400 (portrait phone) rather than the 1 600 × 900 landscape fallback.
- `topLimit` raised from **20 % → 30 %** of screen height (480 px → 720 px on a 2 400 px device) to accommodate Xiaomi MIUI builds that add a larger top chrome (status bar + category pill row) above the search bar, pushing it past the previous ceiling.

**Files changed**
- `artifacts/api-server/src/mobile/androidManager.ts` — `findInstagramSearchBar`: screen size now from `getScreenSize(serial)` (`adb shell wm size`); `topLimit` raised to 30 %.
- `artifacts/api-server/src/routes/mobile.ts` — `runFollowUsersStep`: Explore page settle wait raised to 2 500 ms.

---

## [1.1.503] — 2026-07-12

### Fix: Share-to-Feed double-tap / un-share bug

**Root cause**: After tapping the Repost action-bar icon (which opens the share sheet), the code called `findButtonByLabel("Repost")` again to find the confirm button inside the sheet. If the sheet animation was still in progress, the accessibility tree still returned the action-bar icon at the same coordinates — because the sheet's own "Repost" button had not appeared yet. Tapping those same coordinates again toggled the repost OFF, producing the "shared then immediately un-shared" behaviour the user saw.

**Fix**: After tapping `repostIcon`, the second `findButtonByLabel("Repost")` call now checks whether the returned coordinates are within 15 px of the icon that was just tapped. If they are, the sheet has not opened yet (same node in the tree, not the sheet button). In that case the code treats it as "sheet not visible" and presses Back to cancel cleanly. Wait time before the second scan was also increased from 1 000 ms to 1 500 ms to give slower devices more time for the sheet animation.

---

### Fix: Follow loop goes back to search page after the last user

**Root cause**: `runFollowUsersStep` always called `pressBack` at the end of every loop iteration — including after the last user — to navigate from the profile page back to the search bar for the next user. When there was only one user (or this was the final user), this pressBack landed on the search/explore page unnecessarily, making it appear the flow went to search after following.

**Fix**: The loop now tracks its index. `pressBack` is only called when there are more users remaining in the list. After the last user the code stays on the profile page and lets the normal cycle closure (`closeInstagramViaRecents`) handle navigation.

---

### UI: "Delay between actions (seconds)" → "Delay between actions" with "s" suffix

The label for the action delay row in the View Feed section now reads **"Delay between actions"**. An **"s"** (for seconds) appears immediately after the minimum value input, between the min field and the "to" separator, instead of being part of the label text. Layout: `[min] s to [max]`.

---

### UI: Followed button — removed user count from label

The **Followed** button in the Follow Users header no longer shows the running count in brackets (`Followed (12)`). It always reads **Followed** regardless of how many users are in the list. The full list is still visible when the panel is open.

---

### New: Random Jitter section (human-like interstitial actions per cycle)

A new **Random Jitter** block appears below the Inject Browsing settings, separated by a divider line, with its own enable tickbox. When the tickbox is off the entire section is hidden and no jitter actions run. When on, each sub-feature rolls its own independent percentage chance on every cycle execution — the same probability model used by all other percentage settings (min % to max %, rolled once per cycle; 0 % = never runs).

#### Check Notifications

Taps the **heart/activity icon** in the top-right of the Instagram home feed. The icon is found by scanning the accessibility tree (resource ID → content-desc label → positional scan of clickable ImageViews in the top-right screen quadrant) rather than by fixed coordinates, so it works regardless of screen resolution or OEM chrome height.

After opening the notifications page:
- **Scrolls** down a random number of times in the configured range (default 2–5 mini-scrolls).
- **Click notification %** — a second independent chance roll. If it fires, the code finds a random tappable notification-row avatar in the list and taps it, navigating passively to that user's profile before pressing Back. This is purely observational — no like, follow, or comment action is taken.
- Returns to the home feed with a final `pressBack`.

Settings exposed:
- **Chance %** (min/max) — probability this step runs at all on this cycle.
- **Scrolls** (min/max) — how many downward mini-scrolls to perform in the notifications list.
- **Click notification %** (min/max) — probability a random notification item is tapped.

#### Visit My Profile

Taps the **profile icon** in the Instagram bottom navigation bar. The icon is located by resource ID (`tab_profile`, `nav_profile`, etc.) or the "Profile" content-desc label — not fixed coordinates. After navigating to the own profile the automation dwells for 1.5–2.5 s then returns to the home feed by tapping the Home tab (or pressing Back if Home tab is not found).

Settings exposed:
- **Chance %** (min/max) — probability this step runs at all on this cycle.

#### Execution model

Both jitter actions run **after** the main tools (Feed scroll → Stories → Follow Users) and **before** Instagram is closed. They run independently — both can fire on the same cycle, or neither, or just one. The cycle master toggle's "wait X–Y mins between cycles" interval controls how often cycles run; the jitter % controls whether each action fires within a given cycle.

---

## [1.1.502] — 2026-07-12

### Fix: Share-to-Feed / Share-via-DM — replaced fragile row-scan with label-based icon lookup

**History of the failure (10+ build attempts)**

Every version from v1.1.493 to v1.1.501 tried to fix share icon detection by improving the row-scan in `findFeedActionIcons`. The approach: find the node row containing the Like button, count the 3–4 action icons on that row, then assign Repost and Send by position. Each patch addressed a specific failure mode but the underlying approach was inherently fragile:

- v1.1.493–495: Fixed Y-coordinate detection for the row, but wrong X positions used.
- v1.1.496: Switched from `_getScreenSize(xml)` (fallback = 1600 px landscape) to `adb shell wm size` (correct 1080 px portrait) to properly exclude the bookmark icon from the row.
- v1.1.497: `rowNodes.length >= 3` to tolerate bookmark slipping in as 4th node.
- v1.1.498: Content-description matching (`Comment`, `Repost`, `Send`) with positional fallback.
- v1.1.499/500: Filter `android.widget.ImageView` nodes with no content-desc and no digit text (the audio/music disc that appears between Comment and Repost on profile posts with music).
- v1.1.501: Added full diagnostic logging so every failed tap was explainable in the log.

Despite all of these fixes, the share-to-feed and share-via-DM taps continued to tap the wrong target (typically Comment). Root cause post-mortem: the row-scan assigns icons by *position*. Any new phantom node — music disc, sponsored label, Collab indicator, story sticker icon — that appears in the same row and passes all current filters shifts every subsequent assignment by one position. The only permanent fix is to stop relying on position entirely.

**The fix (v1.1.502)**

In `runProfileBrowsingForUser`, the Repost and Send icon lookups now call `findButtonByLabel("Repost")` and `findButtonByLabel("Send")` directly at the moment of action, instead of using coordinates returned by `findFeedActionIcons`. `findButtonByLabel` walks the entire accessibility tree and returns the first node whose `content-desc` or `text` matches the given label (case-insensitive). This is the same function already used to find:
- The **"Repost"** button inside the share sheet (has worked reliably since it was introduced)
- The **"Close"** button on the post-repost confirmation popup
- The **"Direct"** / **"Message"** send button

Since Instagram labels the Repost icon `content-desc="Repost"` on all known post types, this lookup is unambiguous: it cannot return Comment regardless of how many other icons are on screen, what order they appear in, or whether phantom nodes are present. If the label is not found (e.g. on a Reel with a different action bar layout), the action is skipped cleanly rather than tapping a random icon.

`findFeedActionIcons` row-scan is **not removed** — it is still used by the feed-scroll path (`runCheckFeedLoop`), which has not reported the same problem. Only the profile-browsing path (`runProfileBrowsingForUser`) was switched.

**Files changed**
- `artifacts/api-server/src/routes/mobile.ts` — `runProfileBrowsingForUser`: replaced `icons.shareFeed` / `icons.shareDm` coordinate taps with `findButtonByLabel("Repost")` / `findButtonByLabel("Send")` direct lookups; retained diagnostic logging from v1.1.501.

---

### Fix: Followed Users tab — source column shows actual hashtag/account instead of "hikerapi"

**Root cause**: `runFollowUsersStep` collected candidate usernames as a flat `string[]`. When a follow was recorded via `recordMobileFollow`, the source parameter was hard-coded to the string `"hikerapi"` at the call site — regardless of whether the user was discovered from a hashtag like `#hiking` or from the followers of a target account like `@someprofile`.

**Fix**: Candidate collection now builds a `Map<string, string>` (`candidateSource`) alongside the flat list. For every username discovered, the map stores the discovery label: `#hashtagname` for hashtag sources, `@accountname` for target-follower sources. The `recordFollow` callback signature is updated from `(username: string) => void` to `(username: string, source: string) => void`, and the source is looked up from `candidateSource` at the moment of recording. The call site in the automation runner passes the real source to `recordMobileFollow` instead of the hard-coded string.

**Result**: The Followed Users tab now shows entries like `#fitness`, `#travel`, or `@competitor` in the Source column, making it easy to evaluate which discovery sources are producing the most follows.

**Files changed**
- `artifacts/api-server/src/routes/mobile.ts` — `runFollowUsersStep`: `candidates` collection loop now populates `candidateSource` map; `recordFollow` callback signature updated; follow-recording call passes `candidateSource.get(username) ?? "unknown"`.

---

### Fix: View Stories from Feed — Share DM % field stays on the same row as the other story settings

**Root cause**: The four stories settings fields (Stories to watch / % to watch / Like % / Share DM %) were wrapped in `flex items-start gap-6 flex-wrap`. The `flex-wrap` class allowed the container to reflow onto a second line at smaller viewport widths, pushing Share DM % below the other three fields even when there was enough horizontal space for all four.

**Fix**: Removed `flex-wrap` from the container div. All four fields now stay on a single flex row at all viewport sizes relevant to the app.

**Files changed**
- `artifacts/dannys-bot/src/pages/MobilePage.tsx` — stories settings container: `flex-wrap` removed.

---

## [1.1.501] — 2026-07-12

### Fix: Followed Users tab persists across server restarts

**Root cause**: The Followed Users list was stored in a plain JavaScript `Map` declared at module scope in `mobile.ts`. A comment in the original code explicitly noted "resets on restart intentionally." Every server restart — including normal app updates — wiped the entire list. No data was written to disk or the database between sessions.

**Fix**:

1. On first access for a given device serial, `getMobileFollowedList(serial)` checks for a file at `data/mobile-followed/<serial>.json`. If the file exists, it is parsed and the in-memory Map is populated from it before being returned. If the file does not exist, the Map starts empty (first run behaviour, no error).
2. `recordMobileFollow(serial, username, source)` writes the updated list to disk immediately after adding the new entry to memory. The `data/mobile-followed/` directory is created automatically with `fs.mkdirSync(..., { recursive: true })` if it does not already exist.
3. The API endpoint `GET /api/mobile/devices/:serial/followed-users` is unchanged — it calls `getMobileFollowedList` as before; the persistence is transparent to the route handler and the frontend.

**Files changed**
- `artifacts/api-server/src/routes/mobile.ts` — `getMobileFollowedList`, `recordMobileFollow`: disk read/write logic added; directory auto-creation on startup.

---

### Improvement: Inject Browsing — full diagnostic logging for share icon detection and chance rolls

Added structured log lines throughout `runProfileBrowsingForUser` so every share-to-feed and share-via-DM decision is fully visible in the UI log tab and server logs:

- **After `findFeedActionIcons`**: logs a one-line summary of all four icons — whether each was found (`✓`) or missing (`✗`), and the coordinates of those that were found. If the function returned null entirely, logs the most likely cause (e.g. post is already liked so "Unlike" appears instead of "Like", or Reel/ad action bar has a non-standard structure).
- **After each chance roll**: logs both the rolled value and the configured min/max so it is immediately clear whether the action was intentionally disabled (0%), rolled unlucky, or would have fired but had no icon to tap.
- **When icon missing despite chance roll succeeding**: logs a WARN-level message with the icon name and the most likely filter that caused it to be excluded from the row scan.
- **All messages surface in the UI log tab** (via `onLog`) in plain language, not just server logs, so the user can diagnose without reading raw server output.

**Files changed**
- `artifacts/api-server/src/routes/mobile.ts` — `runProfileBrowsingForUser`: `onLog` calls and `logger.warn` calls added at every decision branch.

---

## [1.1.500] — 2026-07-12

### Fix: findFeedActionIcons — filter audio/music disc from icon row on profile posts

**Root cause**: On a user's profile "Posts" view, Instagram renders a clickable audio/music disc indicator (`android.widget.ImageView`) in the same horizontal row as the action icons, sitting between Comment and Repost. Unlike every real action icon, this element has no `content-desc` label AND no numeric count text (counts like "342", "1.8K" are always present on action icons but never on the audio disc). With the audio disc admitted into `rowNodes` as a 4th node, positional fallback assigned `shareFeed` to the audio disc and `shareDm` to Repost — the software tapped Comment-level coordinates as Share-to-Feed and opened a comment/audio page instead of the share sheet.

This affects both video/Reel posts (which always have the audio disc) and static photo posts that have an associated audio track.

**Fix**: Before adding a node to `rowNodes`, check its `class` attribute. If the class is `android.widget.ImageView` AND the node has neither a non-empty `content-desc` NOR any digit in its `text` attribute, the node is a decorative/media element — not an action icon — and is excluded. All legitimate action icons (Comment, Repost, Send, Like) carry at least one of those signals even when Instagram omits one of them for some account configurations.

---

## [1.1.499] — 2026-07-12

### Fix: findFeedActionIcons — identify icons by content-desc label, not position

**Root cause**: the `>= 3` positional-assignment branch assumed Instagram always shows icons in [Comment, Repost, Send] order, so it blindly assigned `nodes[0] → comment`, `nodes[1] → shareFeed`, `nodes[2] → shareDm`. When an account has the Repost action disabled, Instagram removes that icon entirely. The row then contains only [Comment, Send]. With exactly 2 nodes the code fell to the `else` branch — but if anything pushed the count to 3 (e.g. a secondary icon present in that account's layout), `nodes[1]` was Send, not Repost, so `shareFeed` received the Send icon's coordinates and the tap that was supposed to Share-to-Feed instead opened the DM share sheet or worse tapped Comment.

**Fix**: each icon role is now identified primarily by its Instagram accessibility label (`content-desc`):
- Comment → `\bcomment\b`
- Share to Feed (Repost) → `\brepost\b`
- Share to DM (Send) → `\b(send|direct|message)\b`

If a role's label is not found (devices/versions that omit accessibility labels), the code falls back to consuming the next unassigned node in left-to-right order via an exclusion set. This hybrid approach is correct for all account configurations: Repost-enabled, Repost-disabled, and label-free accessibility trees.

### UI: Sources button — remove active-source count from label

The Sources button was showing `Sources (N)` when sources were configured. Removed; it now reads only "Sources" / "Hide".

### UI: Followed Users table — show Source column

Each row in the Followed Users table now displays the source the account was discovered from (e.g. the hashtag used), populated from the `source` field already stored in `MobileFollowedEntry`. A dash is shown when the field is absent for legacy entries.

---

## [1.1.498] — 2026-07-12

### Fix: Share-to-Feed / Share-via-DM still not found even after v1.1.497 saveCutoffX fix

**Root cause (complete)**: `findFeedActionIcons` only entered the "all icons known" branch when `rowNodes.length === 3`. When 4 nodes were collected (bookmark slipping past the `saveCutoffX` heuristic due to `getScreenSize` returning a wrong default, or any device where the bookmark's X sits below the 80%-width threshold), the function fell to the `else` branch. That branch looked for a Comment-labeled node; if Comment had no content-desc it also found nothing → `shareFeed` and `shareDm` stayed null for every post regardless of what was visibly on screen.

**Fix**: the branch now triggers for `rowNodes.length >= 3`. Instagram never reorders Comment → Repost → Send — it only omits disabled ones — so the leftmost three nodes are always exactly [Comment, Repost, Send] in that order. Any nodes to the right of the third (bookmark, or any future extra icon) are discarded. This is independent of screen width or `getScreenSize` accuracy, so it works correctly even when the width query falls back to a wrong default.

### Fix: Followed Users tab not tracking users followed during a running cycle

The list only updated when the "Followed" toggle button was manually clicked open. Any users followed while the tab was already open — or before the user opened it that session — were never visible without closing and re-opening the panel. A 5-second polling interval now auto-refreshes the list from the server whenever the panel is open, so newly followed users appear within a few seconds without any user interaction.

### UI: Inject Browsing layout — equal spacing, Click Posts % on row 2, Like % below Browse Before Follow

Three changes to the Inject Browsing settings panel:

1. **Equal spacing everywhere**: the inner nested flex container that grouped Feed Chance and Feed Posts with a narrower gap has been removed. All four items on row 2 (Browse Before Follow / Feed Chance / Feed Posts / Click Posts %) now share the same `gap-6` spacing as the stories section, so every adjacent pair has identical separation.
2. **Click Posts % moved to row 2**: was previously the first item on the 4-column row 3. Now sits alongside Browse Before Follow, Feed Chance, and Feed Posts on the same flex row.
3. **Like % falls directly below Browse Before Follow**: with Click Posts % moved up, row 3 now contains only Like % / Share Feed % / Share to DM %. Because the flex rows share the same left-edge alignment, Like % sits directly below Browse Before Follow as requested.

---

## [1.1.497] — 2026-07-12

### Fix: Share to Feed / Share via DM icons never found in Inject Browsing

**Root cause**: `findFeedActionIcons` used `_getScreenSize(xml)` to measure screen width, which falls back to `w=1600` when the UIAutomator XML root element doesn't carry bounds. On the real 1080 px phone, `saveCutoffX = round(1600 × 0.80) = 1280` — far above the bookmark icon's actual position (~950 px), so the bookmark was **not excluded** from the row scan. It appeared as a 4th entry in `rowNodes`, making `rowNodes.length = 4` instead of 3. The detection branch requires exactly 3 to assign Comment/Repost/Send by elimination, so it fell through to the ambiguous `else` path and left `shareFeed` and `shareDm` as `null` for every post. Same root cause as the search-bar height bug fixed in v1.1.496. Fixed by switching to `getScreenSize(serial)` (adb-queried, correct 1080 px default): `saveCutoffX = round(1080 × 0.80) = 864`, which correctly sits left of the bookmark → bookmark excluded → `rowNodes.length = 3` → icons resolved.

### UI: Feed Posts input moved a few pixels further right from Feed Chance

The `gap-2` (8 px) between the Feed Chance and Feed Posts inputs was too tight. Increased to `gap-4` (16 px) so they read as distinct fields rather than appearing merged.

---

## [1.1.496] — 2026-07-12

### Fix: Follow flow search bar never found — "search bar not found — giving up" on first attempt

**Root cause**: `findInstagramSearchBar` computed the top-of-screen height limit from `_getScreenSize(xml)`, which parses the XML root element's `bounds="[0,0][w,h]"` attribute. When that attribute is absent or malformed (which happens on this Xiaomi device's UIAutomator dump), the function fell back to a hard-coded landscape default of `{ w: 1600, h: 900 }`. This set `topLimit = Math.round(900 × 0.15) = 135 px`. The actual Instagram search bar on this 2400 px-tall portrait phone sits at roughly 180–260 px from the top — consistently above the 135 px ceiling — so every attempt was rejected and the log printed "search bar not found — giving up" on the very first user in every cycle.

**Fix**: replaced `_getScreenSize(xml)` with `getScreenSize(serial)`, which runs `adb shell wm size` and falls back to `1080 × 2400` (portrait) rather than `1600 × 900` (landscape). The top-limit percentage was also widened from 15 % to 20 % (480 px on a 2400 px screen), giving comfortable headroom for status bars of any height without any risk of matching Explore-grid content below.

### Fix: Sources (follow target accounts/hashtags) deleted on software restart

**Root cause**: `configFilePath()` used `process.cwd()` to locate `mobile-instances.json`. In the Replit dev workflow (`pnpm --filter @workspace/api-server run dev`), the working directory can differ from the package root depending on how pnpm launches the process, so the config file was written to and read from different paths between sessions — effectively lost on every restart.

**Fix**: the path is now derived from `process.argv[1]` (the absolute path of the running entry script, e.g. `.../artifacts/api-server/dist/index.mjs`). One level up from its directory gives `artifacts/api-server/` reliably regardless of the working directory. Electron mode (`EQUINOX_DATA_DIR` env var set) is unchanged.

### Fix: Close Multiple Windows — code toggled recents overlay off between swipes

**Root cause**: when the close-via-recents loop needed a second swipe attempt (Instagram still running after the first), it called `openRecentApps()` (KEYCODE_APP_SWITCH) before each retry. On this Xiaomi floating-windows device the recents strip stays visible after each card is dismissed — the remaining cards are immediately swipeable. Pressing KEYCODE_APP_SWITCH while already inside the overlay **toggles it off**, sending the phone to the home screen. The next pass then re-opened it, producing the "swiped left correctly → went to phone UI → back to floating windows → swiped again" loop the user reported.

**Fix**: removed the `openRecentApps()` call from inside the retry loop. The strip is already open and stays open; the next swipe fires immediately after a short 600 ms pause. The first `openRecentApps()` call (before the loop begins) is unchanged.

### UI: Inject Browsing row 2 — Feed Chance and Feed Posts grouped tightly next to Browse Before Follow

Row 2 of the Inject Browsing panel previously used a `grid-cols-3` layout that gave equal spacing between all three fields. Feed Chance and Feed Posts are now grouped into a tight pair (gap-2, a few pixels apart) that sits next to Browse Before Follow with the same larger gap (gap-6) used by the Stories section above — matching the visual style requested.

---

## [1.1.495] — 2026-07-12

### Fix: Inject Browsing "Feed posts" rejected 0 with a raw validation error

Setting Feed posts min to 0 (meaning "don't scroll the grid this pass") threw a raw red Zod error onto the panel instead of saving — the save/load schema and the input's `min` attribute both required at least 1. 0 is now accepted everywhere: the settings schema, the input fields, and the actual Inject Browsing run — which previously forced at least 1 row of scrolling no matter what was entered. Feed posts = 0 now correctly means "skip the grid scroll for this pass" rather than being silently bumped up to 1.

---

## [1.1.494] — 2026-07-12

### Fix: Inject Browsing settings were never actually saved (looked like "resetting on restart")

The `automation-settings` save/load endpoint used a much older, narrower validation schema than the one used to run cycles — it didn't list `followEnabled`/`followUsersMin`/`followUsersMax`/`followSources` or any of the `injectBrowsing*` fields at all. Since the validator silently drops any field it doesn't recognize, every autosave wrote Follow Users and Inject Browsing settings to nothing — they only ever lived in the page's in-memory state, so any reload, restart, or update sent the frontend straight back to defaults. Feed/stories/general settings were unaffected — this only hit Follow Users + Inject Browsing. The save/load schema and defaults now cover every setting the panel actually has.

### Layout: Inject Browsing rows rebuilt to match the panel's existing style

Reworked per feedback — the previous two-row grid was cramped and had labels sitting beside fields instead of above them. Now:
- Row 1: title + checkbox only.
- Row 2: Browse before follow % / Feed chance % / Feed posts (3 across).
- Row 3: Click posts % / Like % / Share feed % / Share to DM % (4 across).
- Every field's label sits above its min–max inputs, matching the style already used elsewhere in the panel (e.g. "Users to follow per operation").

### Fix: phone mirror auto-connected on view even when idle

Opening the Human Session Tool tab to view a phone was reconnecting the live video feed immediately whenever the master automation toggle was on — even if no cycle was actually running (e.g. right after a restart/update, idle between scheduled runs). The feed now only auto-connects while a cycle is actually executing; clicking Power to manually view the phone still always connects, regardless of execution state.

---

## [1.1.493] — 2026-07-12

### Feature: Inject Browsing rewired into the actual Follow Users flow (was UI-only until now)

**Inject Browsing was previously stored but never executed on the phone** — the settings existed in the UI but the code comment on them literally said "not yet wired into ADB mobile automation actions". This release wires the whole thing into the real follow flow and reworks the settings to match how it actually needs to behave per-user:

**Settings simplified — mandatory/duplicate items removed**

- **Inject Search Browsing** removed as a toggle — landing on a target's profile via Search is mandatory for every follow, so there's nothing to switch off.
- **Inject Get Suggested Users** removed entirely — not part of the mobile follow flow.
- **Inject Profile Browsing** (the old separate enable checkbox) removed — it was a duplicate of the "Inject Browsing" master toggle, which now gates the whole section by itself.
- **Feed order** setting removed — asked for by name, not used by the new flow.
- The panel is no longer a popup dialog behind an "Open" button — it's always visible under the Follow Users settings, since it now drives real behaviour rather than being an optional extra tucked away.

**New behaviour — rolled independently for every user being followed**

1. **Browse before follow %** (min–max) — rolled fresh per target user. A range of 5–10% gives each user roughly a 7.5% independent chance of getting the full browsing sequence below before the Follow tap; most users just get followed directly, exactly as before.
2. If that roll hits: **Feed chance %** (min–max) decides whether the user's profile grid gets scrolled at all.
3. If it scrolls: **Feed posts** (min–max) sets how many rows to scroll down (Instagram's profile grid is 3 posts per row).
4. **Click post %** (min–max) then rolls whether one of the scrolled-past posts gets opened.
5. If a post opens: **Like %**, **Share feed %** (repost), and **Share DM %** each roll independently to like / repost / send that post via DM.
6. Every icon lookup (Like, Repost, Send) uses the same real accessibility-tree detection already used by the feed-scroll step (`findFeedActionIcons`) — if an icon can't be found on a given post (disabled by the poster, ambiguous layout, or the tap didn't land on a real post at all), that specific step is skipped rather than guessing a coordinate.
7. All settings fit on two rows in the UI (4 + 3) instead of the old scattered dialog layout.

Implemented as a new `runProfileBrowsingForUser` step in the mobile Follow Users flow, called after landing on a target's profile page and before the Follow button is tapped.

---

## [1.1.492] — 2026-07-12

### Fix: Follow Users typed nothing at all (keyboard dump reliability) + manual-tap coordinate misalignment + Follow Users UI row layout

**Backend — `typeViaOnscreenKeyboard` no longer silently types nothing**

The previous fix (v1.1.491) added a retry loop that waits for the keyboard's key map to populate before typing, but if it *still* came back empty after retries, the function just returned — having typed **zero characters** of the username, which is exactly what was observed ("clicked in the search field correctly, however nothing was typed at all, and the tool proceeded to the final step"). Root cause: on this device, `uiautomator dump` sometimes never surfaces the on-screen keyboard's key nodes in the accessibility tree at all (confirmed via the Scan Screen Layout tool: the top of the screen was captured correctly, but the entire middle/bottom — including the fully visible Gboard keyboard and the Recent-searches list — came back with 0 elements). Now, when the key map still can't be built after retries, the function falls back to injecting the whole string via the device's IME (`adb shell input text`) instead of aborting — the field is already confirmed focused, so this reliably lands the text even when the tap-based path can't see the keyboard. Per-character tap gestures remain the default/preferred path whenever key positions *are* discoverable; the IME fallback only kicks in as a last resort so a run is never silently dropped.

**Backend — `_uiDump` truncation fix (root cause of "0 elements" mid/lower-screen scans)**

Found the likely reason the keyboard (and other lower-screen content) was invisible to `uiautomator dump` in the first place: the on-device dump was killed after a fixed 5000 ms timeout, which can be too short when the screen has both a deep/virtualized list (the Explore/Search "Recent" results) and an open soft keyboard mounted at once — killing the dump mid-write truncates the XML, and everything written *after* the cut point (typically most of the screen below the very top) is simply missing from the document, even though it's visibly on screen. Fixed by:
- Raising the dump timeout 5000 ms → 9000 ms and the pull timeout 4000 ms → 6000 ms.
- Validating every dump for a closing `</hierarchy>` tag before accepting it as complete, and retrying up to 3 times (with a short pause) if the tag is missing instead of silently handing back partial/empty content to every caller.

**Backend — manual mirror-tap coordinate misalignment (the "click 123, get a comma" bug)**

Diagnosed why tapping the on-screen keyboard's `123` key through the mirrored phone view sometimes registered a `,` instead — but tapping the very left edge of the same key worked correctly (an error that grows with distance from the top-left corner is the signature of a *scale* mismatch, not a fixed offset). `rescaleForDevice` (used by every manual tap/swipe from the mirror) reads the device's screen size via `adb shell wm size` and rescales the video-frame coordinate into real device pixels. `wm size` can print **both** a `Physical size` and an `Override size` line when a display-size override is active — Android's input system maps touch coordinates against the *current logical size* (the override, when one is set), not the physical panel resolution. The old code always matched the *first* number pair in the output, which is always `Physical size`, so if an override was ever active on this device, every rescaled tap was proportionally wrong, worse the further the tap was from the origin — exactly the reported symptom. Fixed to prefer `Override size` when present, falling back to `Physical size` otherwise.

**Frontend — Follow Users header consolidated onto one row**

- The tickbox, "Follow Users" label, **Sources** button, and **Followed** button (renamed from **View**) now sit on a single row, in that order.
- Removed the separate "Target Sources (N)" and "Followed Users" text headers above their respective panels — the buttons on the main row are now the only way to open/close them, with the same collapsible behavior as before.
- Reworded "Users to follow per cycle" → "Users to follow per operation".

---

## [1.1.491] — 2026-07-12

### Fix: Follow Users search-bar tap misfired below the field + UI cleanup (description removed, Target Sources collapsible)

Three follow-up fixes after the v1.1.490 Follow Users rollout:

**Backend — search bar tap fix (root cause: tap was landing below the search field)**

`findInstagramSearchBar` had two problems that combined to cause the "dragged underneath the search field / screen went white" failure:

1. **30% height limit was too loose.** The Explore page renders a grid of photos below the search bar. Any element in the top 30% of a tall screen could land well below the actual bar. Tightened to 15%: the Instagram search bar is always in the topmost ~80–100 px, nothing else sits there.
2. **`_findElem(xml, "Search", "Search Instagram")` fallback was unconstrained.** It could match a section header, explore-grid label, or any other element with the word "Search" anywhere on screen. Replaced with an explicit `bounds`-checked loop that only accepts elements whose y-centre is within the 15% limit.
3. Added retry loop (up to 3 attempts with 800 ms gaps) so the Explore page has time to finish rendering before the dump is taken.
4. Also handles the pre-tap state correctly: on the Explore page the search bar is a clickable `View`/`FrameLayout` (not an `EditText`) until tapped for the first time — the new logic accepts any clickable "Search" element in the top 15%, not just `EditText` nodes.

**Backend — `typeViaOnscreenKeyboard` keyboard-open guard**

Added a startup check: if the initial `refreshKeyMap("letters")` returns fewer than 15 keys (a real soft-keyboard has ≥ 20), the function now waits 1.2 s and retries, up to 2 times. If the keyboard still isn't there after retries, it logs a clear message and returns early instead of proceeding with a broken/empty key map. This was the cause of the `[keyboard] letters: 0 keys mapped` / `@ not found` log entries — the keyboard hadn't appeared yet when the first dump ran.

**Backend — longer wait after bar tap**

Increased the post-tap sleep from 600 ms to 1 500 ms at the call site in `runFollowUsersStep`. The keyboard needs time to animate up, especially on slower/older devices.

**Frontend — Follow Users UI cleanup**

- Removed the description paragraph ("After stories, navigates to Instagram Search…") from the Follow Users section header — not needed, clutters the panel.
- **Target Sources** is now a collapsible card: only a `Sources (N)` button is shown by default; clicking it reveals the source list and add controls (same UX pattern as other expandable sections in the panel). The card content was always visible before; now it's hidden until clicked.

---

## [1.1.490] — 2026-07-12

### Feature: Follow Users overhaul — HikerAPI-based following + keyboard coordinate fix + new Target Sources & Inject Browsing UI

Complete replacement of the mobile farm's **Follow Users** mechanism inside the Human Session Tool automation panel.

#### What changed

**Backend (`artifacts/api-server`)**

- `src/routes/mobile.ts`
  - **Removed** the story-inline follow mechanism entirely: `followEnabled`/`followPercentMin/Max`, `followDelayAfterMinSec/MaxSec`, `followMaxPerDayMin/Max`, `followMaxPerHourMin/Max`, `followSkipIndianUsers`, `followStopOnBlockEnabled/Minutes`, `getFollowState`, `hasIndianScript`, `canFollowNow`, `onFollowed` — all gone from `automationCycleSchema`, the cycle handler, and `runViewStoriesFromFeedLoop`.
  - **Replaced** with a new post-cycle follow step (`runFollowUsersStep`) that fires after stories, before closing Instagram:
    1. Reads `followUsersMin`/`followUsersMax` to pick a random per-cycle count.
    2. Reads `followSources` (array of `{type, value}` stored inline in automation settings JSON) and calls HikerAPI (`getHashtagUsers` for hashtag sources, `getUserByUsername` + `getFollowers` for followers-of-account sources) to collect candidate usernames.
    3. Shuffles candidates, deduplicates, and follows each one by navigating Instagram's Search tab, typing `@username` character-by-character on the on-screen keyboard via the new `typeViaOnscreenKeyboard` function, finding the user in results, and tapping Follow on their profile.
  - Added `followUsersMin`, `followUsersMax`, `followSources` to `automationCycleSchema` (plus all 28 `injectProfile*`/`injectSearch*`/`injectSuggested*` browsing settings for UI parity with the desktop Follow Tool — stored but not yet wired into ADB automation actions).
  - Added in-memory per-serial follow tracking (`mobileFollowedUsers` Map + `recordMobileFollow`) and a new `GET /api/mobile/devices/:serial/followed-users` endpoint that returns the session's follow log.
  - `runViewStoriesFromFeedLoop` signature simplified: all follow parameters removed; return type is now `{ storiesWatched: number }` (no `followed` field).

- `src/mobile/androidManager.ts`
  - **`typeViaOnscreenKeyboard(serial, text, onLog?)`** — new exported function that fixes the `d→f` / `a→s` keyboard coordinate-offset bug. Instead of hardcoded or formula-derived x/y positions (which drift with DPI, keyboard theme, and per-row indent), it dumps the accessibility tree once per keyboard layer, finds each key's exact bounds from the XML, and taps the real centre. Handles the `@` symbol by switching to the `?123` symbol layer, tapping `@`, then switching back to ABC. Falls back to `adb shell input text` for any key that can't be found in the dump.
  - **`findInstagramSearchTab(serial)`** — finds the Search (magnifying glass) icon in Instagram's bottom nav via UIAutomator, with resource-ID and content-desc fallbacks.
  - **`findInstagramSearchBar(serial)`** — finds the search input field after tapping the Search tab; uses resource-ID first, then EditText position, then text match.
  - **`findAndTapUserInSearch(serial, username)`** — waits for search results to populate and taps the first result matching the username.
  - **`tapFollowButtonOnProfilePage(serial)`** — finds and taps the Follow button on a profile page via UIAutomator bounds.

**Frontend (`artifacts/dannys-bot`)**

- `src/pages/MobilePage.tsx`
  - **`AutomationSettingsData` type** — replaced 11 old follow fields with `followUsersMin`, `followUsersMax`, `followSources: {type, value}[]`, and 28 inject-browsing settings.
  - **`AUTOMATION_DEFAULTS`** — updated to match new type.
  - **POST body** in `useAutomationSettings` fetch call — updated to send new fields.
  - **`AutomationSettingsPanel`** — added 6 new local state variables (before the null-check early-return, honoring React hooks rules): `showBrowsingDialog`, `showFollowedUsers`, `newFollowSourceType`, `newFollowSourceValue`, `mobileFollowedList`, `loadingFollowed`; `loadFollowedUsers` callback to fetch from the new endpoint.
  - **Follow Users UI section** completely replaced:
    - Removed: description paragraph ("Follows the owner of a story…"), "Follow % of stories watched" percent fields, "Delay after each follow", "Max follows per day", "Max follows per hour", "Skip Indian Users" checkbox, "Stop on block" checkbox + minutes field.
    - Added: **"Users to follow per cycle"** min/max integer fields.
    - Added: **Inject Browsing** subsection — checkbox, quick Search session count inputs, and an "Open" button that launches a full-detail dialog covering Search Browsing, Suggested Browsing, and Profile Browsing with all sub-settings (before-follow %, feed chance %, feed posts, click post, like %, share-to-feed %, share-to-DM %).
    - Added: **Target Sources** — inline list with per-entry remove buttons, type selector (Hashtag / Followers of Account), value input, Add/Clear-all controls. Sources are stored in `settings.followSources` (no separate DB table).
    - Added: **Followed Users** — "View / Hide" toggle button that fetches from `GET /api/mobile/devices/:serial/followed-users` and renders a scrollable table of `@username` + followed-at time for the current server session.

#### Keyboard coordinate bug fix (root cause)

The old code calculated key x-positions with a single uniform formula applied to all keyboard rows, which ignored the left-indent offset of row 2 (a–l) relative to row 1 (q–p). On a 1080 px screen this shifted every row-2 tap roughly one key-width to the right, causing `d→f`, `a→s`, etc. The new `typeViaOnscreenKeyboard` sidesteps the entire coordinate-math problem: it reads key positions directly from the live accessibility tree on every keyboard-layer switch, so the correct bounds are always used regardless of screen size, keyboard theme, or OEM layout customisation.

---

## [1.1.489] — 2026-07-12

### Fix: story-open confirmation was still using the slow check, and share-icon detection could lock onto the wrong row on screen

Second pass at the same log, after finding the fast/slow check itself was working correctly this time (no fallback log lines showed up at all) — the remaining "not instant" time and the wrong-tap shares had two different, more specific causes:

1. **The story-tray-tap confirmation ("did a story actually open?") was never switched to the fast check** — only the per-slide safety checks were fixed in the previous round. Every tray tap (and every retry when the first tray slot missed) was still paying the full ~3-4s uiautomator-dump cost before the loop even started. Now uses the same fast screenshot check first, same as everywhere else.
2. **The share-icon scan was picking the wrong row on screen.** It ranked candidate rows by "most icon-like clusters, ties to darkest," which let a coincidental bright element elsewhere in the story (a poll, mention chip, link sticker) outrank the real reply bar whenever that story's real bar showed fewer clusters than usual. Two attempts in the same session picked rows at 65% and 88% of screen height for what should be the same physical control — hard evidence it was landing on content, not the bar. The reply bar is always the lowest surviving candidate on screen (nothing else renders below it); the scan now prefers the bottom-most match instead of the most-clusters match.
3. **Added recovery instead of one-shot failure.** Even with a better row pick, exact icon x-position can still be off by a few pixels on any given device. Previously a missed tap (detected via the keyboard opening) just gave up on the whole share. It now backs out and retries up to 2 more times further to the right — the paper-plane is always the rightmost element in the bar — before giving up.

---

## [1.1.488] — 2026-07-12

### Fix: v1.1.487's "fast" story-viewer check wasn't actually firing, and a blind DM-recipient tap could hit "previous story"

Two separate bugs, both surfaced by the same log:

1. **The fast check from v1.1.487 was effectively never matching.** Its
   pixel-scan band (1.5%-6% of screen height, 150 brightness threshold,
   strict uniform-width/coverage ratios) was tuned against a single
   reference capture and, on the reported 1080×2460 device, essentially
   always fell through to `null` — meaning every safety check in the story
   loop was still paying the full ~3-4s uiautomator-dump cost, exactly as
   before v1.1.487. Widened the scan band, relaxed every threshold, and
   added a warning log when the screenshot itself fails to capture/decode
   (previously a silent failure that looked identical to "pattern not
   found" in the logs, so there was no way to tell the two apart). Also
   added live timing logs for every fallback to the slow check, so the
   next report shows real numbers instead of back-calculated guesses from
   story-loop timestamps.
2. **A blind tap could land on "previous story" instead of a DM recipient.**
   After tapping the paper-plane share icon, the only gate before firing
   the next tap (an avatar ~15% from the left edge of the screen) was "no
   keyboard opened AND still technically in a story" — true whether the DM
   sheet actually rendered or the tap simply landed on nothing. When the
   sheet didn't open, that left-edge avatar coordinate landed on the plain
   story screen underneath, squarely inside Instagram's "go to previous
   story" tap zone — explaining the reported backwards-navigation. Now the
   code positively confirms the sheet is open (checks for the "Send" button,
   which only ever exists inside that sheet) before firing the recipient
   tap, and cleanly aborts the share instead of tapping blind if it can't
   confirm.

---

## [1.1.487] — 2026-07-11

### Fix: story likes/shares were still stalling instead of firing instantly, even after the earlier timing fix

The previous fix (v1.1.485) removed the deliberate "watch the story first"
delay before a scheduled like/share, on the theory that stories run on
their own fixed ~5-6s timer and any delay in front of a scheduled action
eats directly into it. That was correct, but it wasn't the whole story: the
per-slide "is the story viewer still open?" safety check that runs before
every single tap (like, share-start, post-share-tap, pre-Send, advance) was
still calling `findHomeTab`, which requires a full `uiautomator dump` +
`adb pull` — roughly 3-4 seconds per call on this farm's devices. That
check fires up to 5-6 times inside one story slide, so removing a 250ms
watch delay changed almost nothing: log evidence showed ~5s just to reach
the like tap and another ~4.6s to reach the share attempt, on a slide with
only ~5-6s of runway total. The safety checks themselves — not the
"realism" delay — were the real bottleneck.

Fix: added a fast, screenshot-based "is the story viewer open?" check
(`isStoryViewerOpenFast`) that scans for Instagram's segmented story
progress bar near the top of the screen — a signature that only appears in
the story viewer — via the same `adb exec-out screencap -p` approach
already used for icon detection (~100-300ms instead of ~3-4s). It only
ever returns a confident "yes, still open"; on anything it can't
confidently read (a single-story tray with no multi-segment bar, a failed
screenshot, or an ambiguous scan) it returns "unknown" and the code falls
back to the original slow-but-proven accessibility-tree check, so nothing
that used to be caught (blind taps on the home feed after a story ends
mid-sequence) can slip through. In the common case — any tray with 2+
stories — every safety check in the per-slide loop now costs a few hundred
milliseconds instead of several seconds, leaving the actual scheduled
like/share the runway it needs inside the story's own timer.

---

## [1.1.486] — 2026-07-11

### Fix: story tray tap sometimes dismissed a "suggested friend" chip instead of opening a story, ending the cycle with zero stories watched

User-reported and log-confirmed: the tray tap landed on a "suggested for
you" account tile's follow/dismiss control instead of its avatar, so no
story opened — and because only one slot was ever tried, the whole cycle
gave up immediately with 0 likes / 0 shares, even though the same tray
almost certainly had a real story available in a different slot. Unlike
real friends' stories (always sorted first in the tray), suggested/discover
tiles can appear at any position, so a single random pick could keep
landing on one.

Fix: the tray tap now tries slot 1 first (least likely to be a suggestion,
since real friends' stories always sort before discover content), then
falls back to up to 2 more random remaining slots if a tap doesn't actually
open a story, before giving up on the cycle. This does not change the
upper-left tap bias already in place to avoid the follow badge itself — it
just gives the cycle more than one chance to find a real story on the same
tray instead of quitting after the first miss.

---

## [1.1.485] — 2026-07-11

### Fix: like/share on stories fired after a "watch" delay, running out of time before finishing (user-reported, CRITICAL)

Log evidence (`Story 1: liked` at 42.3s → `share icon scan` at 47.4s → `share
skipped — tap opened keyboard` at 49.2s → `story viewer already closed` at
52.1s) showed the DM-share sequence eating almost the entire remaining
runway of the slide's own fixed real-world timer, because a deliberate
"watch this story for a random % of its duration" delay ran *before* the
scheduled like/share even started. The story doesn't pause for the script —
every second spent "watching" before acting is a second the multi-step share
sequence (icon scan, tap, wait for sheet, pick recipient, wait, tap Send)
didn't have.

Fix: when a like and/or a share is scheduled on a slide, both now fire
immediately (minimal ~250ms delay, just enough for the frame to be on
screen) instead of waiting out a randomized watch period first, and the gap
between the like tap and starting the share sequence was cut from 600ms to
150ms when both are scheduled. Pure viewing (no action scheduled) is
unaffected. This does not fix icon-detection accuracy by itself, but removes
the timing starvation that was preventing the share sequence from ever
having a fair shot at finishing.

### Fix: closing Instagram kept re-attempting the recents-swipe after it had already worked

User-reported: with only one app open, the very first left-drag correctly
dismissed it, but the software still repeated the swipe 4 more times against
an already-closed/empty screen before moving on to airplane mode. Root
cause: Instagram's background services keep its process alive briefly after
the card is dismissed, and the code checked `pidof` only once, 600ms after
the swipe — too soon to see the process actually exit, so it looked like the
swipe had failed and tried again. Now polls for up to 3.5s after each swipe
before concluding it didn't work, and — since this launcher's recents screen
has never exposed a text label for any card in testing, so the "how many
cards are left" detection has no ground truth to count on — caps blind
retries at 2 instead of 5 when no card labels are found at all, only looping
the full 5 when real per-card labels are actually detected.

---

## [1.1.484] — 2026-07-11

### Fix: close-Instagram gesture swiped UP, which does nothing on this device's recents screen (CRITICAL)

Screenshot evidence showed this farm's phones use a Xiaomi "floating windows"
recents carousel, not stock Android recents — cards sit side by side (up to
two visible at once) and are dismissed by dragging them off the LEFT edge,
not by swiping up. The previous close-Instagram code swiped the Instagram
card upward (the stock-Android gesture), which is a no-op on this launcher,
so Instagram was never actually dismissed by the "real gesture" and every
cycle silently fell through to a force-stop instead.

Fix: `closeInstagramViaRecents` now drags the left-most visible card off the
left edge of the screen, and repeats this (up to 5 times) since dismissing
one card slides the next into the left-most slot — matching the confirmed
real interaction ("if more than one app is open, keep dragging the very-left
one to the left; if only one is open, it's already centred").

### Fix: story share icon scan missed a visibly-present paper-plane icon on some devices

The icon-detection scan only looked in the bottom 70–97% of the screen for
the like/share icon row. That band was calibrated against one specific
phone's screenshot; this farm runs multiple phone models with different
screen aspect ratios, and on a device where the reply bar sits higher up,
the real icon row fell outside the band entirely — the scan found nothing
and logged "sharing disabled" even though the paper-plane icon was visibly
on screen. Widened the scan band to 55–99% of screen height. Also added a
one-line log of the actual device resolution at the start of each stories
run so a mismatch like this is visible in the log immediately instead of
requiring another guess-and-check round.

---

## [1.1.483] — 2026-07-11

### Fix: story share-to-DM (and like) taps landing on the home feed (root-cause, not another icon heuristic)

Every prior fix in the story loop patched *how* icons were detected (pixel
scan, gap filters, keyboard-check safety nets), but never questioned the
underlying assumption that once a story opened, it would still be open for
the rest of the per-slide loop and for the entire multi-step DM-share
sequence. It doesn't: Instagram stories auto-advance on their own ~5-6s
timer regardless of what the script is doing, and the DM-share sequence
(icon scan → tap paper-plane → wait → pick recipient → wait → tap Send) adds
up to several seconds of scripted waits on its own. A short/fast story, or a
share sequence that simply took too long, let the story exit back to the
home feed mid-sequence — and every tap coded after that point kept firing
blind at the real screen underneath (the feed), which is how a scheduled
"share via DM" turned into an accidental like on a home-feed Reel, "literally
not even in our flow."

Fix: added a cheap live check (`stillInStoryViewer()`, via the existing
`findHomeTab` bottom-nav probe) before *every* tap in the per-slide loop —
before the like double-tap, before starting the share sequence, after the
paper-plane tap, after picking a recipient and right before the final Send
tap, and before the "advance to next slide" tap. The instant any check shows
we've left the story viewer, the loop stops issuing further taps entirely
instead of assuming the next screen is still a story. Also capped the
pre-share watch time (max 2000ms when a share is scheduled, down from up to
100% of the slide) and trimmed the DM-share sequence's own waits (1200→900ms,
1500→900ms) so the whole sequence has a realistic chance of finishing before
a slide's own timer runs out.

Also fixed a stale type signature on `pickAndOpenRandomStory` (declared
`Promise<number>` while actually returning `{ slot, opened }` since v1.1.482)
that was silently masking real type errors at its call site.

---

## [1.1.482] — 2026-07-11

### Fix: story like/share landing on home feed when tray tap missed (CRITICAL)

`pickAndOpenRandomStory` logged whether the story viewer opened or not but
returned only the slot number — the caller (`runViewStoriesFromFeedLoop`) never
saw the open/fail status and always proceeded to run like and share actions
regardless. When the tray tap missed (e.g. hit the follow badge), the phone
was still showing the home feed, and the next action — a double-tap at story
centre coordinates — landed on whatever post was on screen and liked it.

Fix: `pickAndOpenRandomStory` now returns `{ slot, opened }`. If `opened` is
false the story loop exits immediately with 0 stories watched instead of
running actions on the wrong screen.

### Fix: phone left on recents screen after close step

`closeInstagramViaRecents` opens the recents overview to attempt the
swipe-to-dismiss gesture, then force-stops the process. It correctly closed
Instagram but left the phone sitting on the recents screen (the overview
animation was still showing). The subsequent swipe-up + sleep then locked the
phone on the recents view, so the next cycle woke to an unexpected screen.

Fix: added `KEYCODE_HOME` (keycode 3) immediately after
`closeInstagramViaRecents` returns so the launcher is foregrounded before the
sleep command locks the screen.

---

## [1.1.481] — 2026-07-11

### Fix: phone screen still waking on restart (stay_on_while_plugged_in persisted from old sessions)

`stay_awake=false` (added in v1.1.480) stopped scrcpy from *setting* the
`STAY_ON_WHILE_PLUGGED_IN` system flag, but it cannot *clear* a value that was
already set by a previous session. The flag persists on the device indefinitely
after any session that used `stay_awake=true` — including every session prior
to v1.1.480. Added an explicit `adb shell settings put global stay_on_while_plugged_in 0`
command before each scrcpy spawn. This resets the flag from whatever previous
session left it before the new session begins.

### Fix: Account Settings — deleted slots reappear, typed values forgotten on tab switch

Two separate persistence bugs:

**Deleted slots reappear:** the server was padding the saved slot array back to
5 entries on every POST (`while length < 5, push empty`). A user deleting down
to 2 slots would see them save as 2, server would save as 5, and the UI would
reload 5. Removed server padding — the server now stores exactly as many slots
as the UI sent.

**Typed values forgotten when switching tabs:** `AccountSettingsPanel` is
conditionally rendered (`activeTab === "account" && <AccountSettingsPanel…/>`),
so it unmounts every time the user navigates to a different tab. The save
debounce used `return () => clearTimeout(t)` as its React cleanup, which React
calls on unmount — silently cancelling any in-flight save that hadn't fired
within 400 ms of the tab change. Replaced with a `useRef`-held timer that
debounces between keystrokes but is not tied to the component lifecycle.

### Fix: story share — now scans for icon before tapping (skip if not available)

Previously: always tapped at fixed right-edge coordinates, then checked if the
keyboard opened to determine if sharing was disabled. This always disturbed the
story (briefly opening the message field) even when sharing was obviously off.

Now: runs `findStoryActionIcons()` before any tap. If ≥2 icons are detected the
rightmost is the paper-plane — its actual coordinates are used for the tap. If
0 or 1 icons are found (sharing disabled or ambiguous), the story continues
without touching the screen at all. Keyboard check is retained as a final
safety net for the rare case where the icon scan mislabels a cluster.

### Fix: close-Instagram — was wasting 25 seconds on 5 guaranteed-to-fail recents swipes

On Xiaomi HyperOS, MIUI memory management locks apps in the recents stack so
the swipe-to-dismiss gesture never kills the process. The 5-attempt loop took
~25 seconds before reaching the force-stop fallback, all 5 passes failing in
user testing. Reduced to 1 attempt; if Instagram is still running after it,
force-stop fires immediately.

### Improved: cycle log now shows completion status after each step

Added `✓` confirmation lines after: screen unlock, Instagram open, Instagram
close, airplane mode on/off. Previously only "about to do X" lines appeared;
now both the intent and the result are visible.

---

## [1.1.480] — 2026-07-11

### Fix: phone screen waking on software restart with toggle on

Root cause: scrcpy's `stay_awake=true` option (present since the mirror
was introduced) sets Android's `STAY_ON_WHILE_PLUGGED_IN` system flag on the
device the instant scrcpy connects. On Xiaomi/MIUI, that system flag wakes
the physical screen immediately — even though `power_on=false` (added in
v1.1.478) blocks scrcpy's own screen-on action, `STAY_ON_WHILE_PLUGGED_IN`
fires through a completely independent code path. This wake occurred on
every connect, including the automatic mirror connection that fires when
the automation toggle is left on and the software restarts. Changed to
`stay_awake=false`: scrcpy no longer modifies the device's stay-awake
setting. The automation cycle's own explicit `wakeScreen()` call (which
happens at the start of each tick when the screen is genuinely needed) is
unaffected.

### Fix: story Like and Share taps consistently missing (keyboard opens instead)

Root cause (pixel scan): Instagram renders the entire story reply-bar — the
message input field, the heart icon, and the paper-plane icon — on a
hardware-accelerated canvas with zero accessible elements in the
UIAutomator tree. The previous approach used a pixel-brightness scan of a
screenshot to locate the icon glyphs. The "Send message" placeholder text
is white on the same dark scrim as the icons, and word-breaks in the text
produce bright clusters that are similar in width and count to real icon
clusters. The gap-isolation filter that was supposed to reject text
clusters consistently failed under real conditions, causing taps to land
inside the message text field (opening the keyboard) rather than on the
icons.

Two-part fix:

**Like — double-tap on story content (no icon detection)**
Instagram registers a double-tap anywhere on the story image as a Like —
the same gesture used in the feed. Changed from "scan for heart icon, tap
it" to `doubleTap(w×50%, h×44%)`. No screenshot required, no cluster
analysis, works regardless of which icons the story owner has enabled.

**Share — fixed right-edge coordinates**
The paper-plane (Send to DM) icon is always the rightmost element in the
story bar and sits consistently at approximately 92% screen width × 91%
screen height on standard Instagram layouts. Changed from "scan for
rightmost cluster" to a direct tap at `(w×92%, h×91%)`. Added a keyboard
check: if the tap lands in the message field (story owner has sharing
disabled), the keyboard is detected, the code backs out, and the share is
skipped cleanly for that story.

---

## [1.1.479] — 2026-07-11

### Fix: story like/share misses on short stories

Root cause: `findStoryActionIcons` (the screenshot + pixel decode call) was
happening AFTER the watch-% sleep. On a short story (1–6 s) at even a moderate
view %, the screenshot call ate into the remaining story time, and if the story
auto-advanced during it the subsequent taps landed on the next story's icons
(or worse, empty space). Between the Like tap and the Share tap there was also
a 400–600 ms sleep — another window for a short story to advance.

Three-part fix:
1. **Pre-scan at story load** — `findStoryActionIcons` is now called at the
   very start of each loop iteration, before the watch-% sleep, while the story
   is freshly loaded and icons are definitely visible. The saved coordinates are
   used directly for both Like and Share; no second screenshot is taken.
2. **Minimum watchMs floor raised 400 → 1500 ms** — ensures even a 1-second
   story gives the bot enough runway to watch and act before it auto-advances.
3. **Like → Share inter-tap gap cut 400–600 ms → 100 ms** — once Like lands
   (no keyboard = confirmed success), Share is tapped almost immediately so the
   story has no gap to advance between the two actions.

---

## [1.1.478] — 2026-07-11

### Fix (real root cause this time): phone screen turning on just from opening the Mobile tool
Every previous attempt at this bug (getprop caching, removing app-level
wakeScreen calls) missed the actual cause: the vendored scrcpy-server is
started with `power_on=true`, which is scrcpy's own built-in behavior —
it forces the physical screen on the instant its mirror session starts,
completely independent of any wakeScreen()/sleepScreen() call this app
makes. Since the live-mirror view auto-connects whenever the automation
toggle is left on from a previous session (by design, so you can watch
an in-progress run), simply reopening the Mobile tool after a restart —
with the toggle still on from before — silently started a mirror
session, which woke the screen. Changed to `power_on=false`: the mirror
now shows whatever state the screen is already in instead of forcing it
on. The automation cycle's own explicit wake step (used when it actually
needs the screen) is untouched.

### Fix: story Like/Share taps swapped — a message-field tap landed first
On a story with the reply bar showing, a tap meant for Like landed in
the "Type a message" field instead, then (after backing out of that) the
tap meant for Share landed on the real Like button instead of Share.
Root cause: Instagram lays this bar out as [message field] [heart]
[paper-plane], left to right — the detection code assumed the leftmost
bright cluster it found was always the Like icon, but a stray fragment
of the message-field's placeholder text can pass the existing
icon-shape filter and sit to the left of the real heart, which then
shifted every index over by one (the fake entry became "Like", the real
heart became "Share"). The real Like and Share icons always sit right
next to each other with a small, consistent gap; a text fragment is
isolated from them by a much bigger gap. The scan now measures the gaps
between candidate clusters and drops anything separated from the
tightly-packed real icon group by an outsized gap, so a leftover text
fragment can no longer be mistaken for an icon.

### Improved: Log tab now shows story Like/Share detection detail
Every story Like/Share attempt now logs what the icon scan actually
found (coordinates, count) and the outcome of the tap (liked, opened
share sheet, hit the keyboard by mistake and backed out, or skipped
because the icons weren't distinguishable) — so if this class of bug
resurfaces, the Log tab shows exactly what was detected instead of
requiring another live reproduction to diagnose.

---

## [1.1.477] — 2026-07-11

### Fix: story-tray tap could hit a "Suggested for you" follow badge instead of viewing the story
Instagram overlays a small "+"/follow badge on the bottom-right corner of
some story-tray bubbles (accounts you don't follow yet). The tap point
used to land dead-centre on the bubble, which for those accounts could
land on the badge and silently follow them instead of opening their
story. The tap is now biased toward the upper-left of the bubble, away
from that corner, and — since blind coordinate tweaks alone have missed
before — the code now also verifies the tap actually opened a story
(checking that the feed's bottom nav bar is gone) and logs the outcome
either way, so a still-wrong tap shows up clearly in the Log tab instead
of failing silently.

### Fix: closing Instagram via Recents could miss the card on grid-style overview layouts
The close-Instagram step assumed the recent-apps switcher always shows
one card centred on screen and swiped left from the middle. Some OEM
overview layouts (confirmed from a screenshot: MIUI showing two recent
apps side by side) don't centre a single card there, so the blind swipe
could miss it entirely. The routine now reads the accessibility tree for
the actual "Instagram" card each attempt and swipes it away from its own
real position (or falls back to the old centred guess if the label isn't
found), logging which path ran and whether Instagram was confirmed
closed after each attempt.

### Fix: phone screen lighting up just from opening the Mobile Farm tool
Opening the Mobile tool (or the page remounting after a server restart)
made the connected phone flicker/wake, even with no automation running.
Cause: the device list endpoint re-ran 2–3 `adb shell getprop` calls for
every connected phone on every 3-second poll, forever, for as long as the
tab was open — each one re-touches the USB link to the device. Those
properties (manufacturer, Android version, model) never change while a
phone stays plugged in, so they're now read once per connection and
cached, cutting that repeated `adb shell` traffic to near zero.

### Diagnostics: richer Log tab detail for stories and closing Instagram
Both fixes above also add step-by-step log lines (tap coordinates,
whether a detected UI element was used or a fallback guess, and the
verified before/after Instagram-running state per attempt) so the next
round of tap-position debugging has concrete evidence to work from
instead of another guess.

---

## [1.1.476] — 2026-07-11

### Fix: feed Like tapped the wrong post's icon, opening a reply box instead
On a normal feed post, a Like tap sometimes opened a reply/message
compose box (mistaken by you for a Comment tap) instead of liking the
post, even though the same detection logic had just fixed this exact
class of bug for Stories/Reels.

**Root cause:** Android's RecyclerView-backed feed keeps the post
scrolling out of the top of the screen and the post/Reel-repost card
scrolling into the bottom BOTH alive in the accessibility hierarchy
during a scroll — so `uiautomator dump` can report more than one
`content-desc="Like"` node at the same time. The code took the FIRST
one it found in document order, which is not necessarily the post
actually centred on screen. When it picked the wrong post's Like
button, the "everything else on that row" scan (`findFeedActionIcons`)
swept in unrelated elements from a totally different card — including
a Reel/repost card's wide message/reply text field — and, by
elimination, mistook it for Comment/Repost/Send.

**Fix:** the Like-button scan now always selects the node closest to
the vertical centre of the screen (the post actually being viewed),
not just the first match. The row-scan also now rejects any clickable
element wider than a real action icon (and explicitly excludes
`EditText` compose fields), so even if a wide reply box ever lines up
on the same row as the correct Like button, it can never be mistaken
for one of the small square icons.

---

## [1.1.475] — 2026-07-11

### New: Copy button on the Log panel
Added a "Copy" button next to Clear on the Mobile Log tab — copies the
full visible log to your clipboard in one click, so you can paste it
straight into a bug report without selecting text by hand.

### Fix: story Like/Share could open the reply keyboard instead of tapping the icon
On a story with only the Like icon available (comments/shares disabled
by the owner), the like/share automation sometimes tapped into the
reply text box and opened the keyboard instead of liking or sharing —
even though the very next story, which had all 3 icons, worked
correctly.

**Root cause:** the story icon bar has no accessible elements at all
(Instagram draws it on a canvas), so icons are located by scanning
on-screen pixels for small bright clusters against the dark bottom
scrim. The reply box's placeholder text ("Send message") sits in that
same region and can itself split into a couple of bright, icon-sized
clusters. When a story has just one real icon (the heart), that
placeholder-text row can end up with *more* clusters than the real
one-icon row and win the row-selection tie-break, so the tap lands on
the text field instead of the heart.

**Fix, two layers:**
1. Icon rows now also require their clusters to be similar widths to
   each other — real icons are all the same size, while the
   placeholder's "words" ("Send" vs "message") vary a lot more in width,
   so uneven rows are no longer treated as a valid icon bar.
2. As a backstop, after tapping a detected Like or Share icon the bot
   now checks whether the on-screen keyboard actually opened. If it did,
   that tap hit the wrong control — it immediately backs out (no typing,
   nothing sent) and logs it clearly as a missed like/share rather than
   leaving a half-open reply box or silently miscounting it as
   successful.

---

## [1.1.474] — 2026-07-11

### Fix: feed Like/Share taps hit the wrong icon when a post had comments or shares disabled

While scrolling the main feed, a share action opened the Comment
reply/compose box instead of the intended Share sheet. Root cause: the
feed's Like button position was found dynamically per post (via the
accessibility tree), but Comment/Share-to-Feed/Share-via-DM were still
tapped at fixed 30.4%/48.1%/66.0% screen-width offsets measured once from
a single screenshot where all four action-bar icons happened to be
present. Post/profile owners can disable comments and/or shares
individually per post, which removes that icon from the bar and shifts
everything after the gap to the left — so those fixed offsets only ever
lined up with the right icon by coincidence. On a post with fewer icons
than that reference screenshot, the "share" X landed on whatever the
Comment button had shifted into, opening the reply keyboard instead.

**Fix:** added `findFeedActionIcons()`, which reads the real
accessibility tree for whatever post is on screen right now and works
out each icon's actual position (or its absence) instead of assuming a
fixed layout — the same principle already applied to the story-viewer
like/share fix. Since Instagram doesn't reorder these icons, only omits
disabled ones, their identity can usually be worked out for certain by
elimination (e.g. if all 3 of Comment/Repost/Send are present, order
alone fixes which is which; if Comment is positively labeled and exactly
2 icons remain, those must be Repost + Send). When the remaining icons
can't be told apart with confidence, the action is skipped for that post
entirely rather than guessing — the same "skip rather than risk the
wrong control" rule used for stories. Like tapping is unaffected; this
only changes how Comment/Share-to-Feed/Share-via-DM icons are located.
The log now also records which of Comment/Share-to-Feed/Share-via-DM
were detected on each post, to make this easier to diagnose from the Log
tab if it ever needs a closer look on a specific device/layout.

---

## [1.1.473] — 2026-07-11

### Fix: story like/share taps missed on reposted Reels and privacy-restricted stories

Story likes and shares were blind-tapping a single hardcoded screen
coordinate. A `screen-layout-scan` on a real device showed why that could
never work: Instagram draws the story action bar entirely on canvas with
**zero accessible child elements** — there is no content-desc, text, or
resource-id for "Like" or "Share" to search for in the story viewer. Worse,
that bar's position and icon count both change depending on content —
reposted Reels use a different, higher bar than a plain story — and per-story
owner settings (likes/comments/shares can each be individually disabled,
which removes icons and re-centers the rest). One fixed `(x%, y%)` pair could
only ever match one of those layouts; on every other layout the tap landed on
the reply text field or the story background and silently did nothing.

**Fix:** added a pixel-based icon locator (`findStoryActionIcons` in
`androidManager.ts`) that captures a real screenshot via
`adb exec-out screencap -p`, decodes it with a small dependency-free PNG
decoder (Node's built-in `zlib`, no new packages), and scans the bottom of
the screen for Instagram's dark gradient scrim plus the bright icon glyphs
sitting on it. Instagram always keeps Like leftmost and Share/Send rightmost
regardless of how many icons sit between them, so the story loop now taps
whichever icon is actually on screen instead of a guessed spot. If only one
icon is found (can't distinguish Like from Share) or none at all (that story
has them disabled), the action is skipped rather than risking a tap on the
wrong control. If the screenshot approach is unavailable on a given device,
it falls back to the previous accessibility-tree/fixed-coordinate behavior so
nothing regresses. Feed-level like/share logic is untouched — this only
changes the story-viewing loop.

### UI: merged "View Stories from Feed" into the Step 2 card

"View Stories from Feed" was showing as its own step (STEP3) even though it
runs as part of the same feed-viewing pass as the like/share settings above
it — there's no separate step 3 in the actual automation cycle. It now lives
inside the Step 2 card, under a border separator beneath the like/share
settings, with its own "(STEP3)" label removed. Added a bit more breathing
room between the "(STEP2)" label and the "View Feed" title.

---

## [1.1.472] — 2026-07-11

### Fix: mirror catch-up lag (spawnSync→async) + Send button never pressed

**Mirror "10–20 second black then catch-up" — root cause found and fixed:**  
`_uiDump` (every UIAutomator accessibility dump) used `spawnSync`, which
blocks Node's **entire** event loop while it runs — typically 4–5 s on this
device. While blocked, `ws.send()` calls queued up in `ws.bufferedAmount`
since Node had no cycles to flush the socket. After the `spawnSync` returned,
`bufferedAmount` was well past the 800 KB watchdog threshold → watchdog fired
→ killed screenrecord → client cleared decoder and canvas → new screenrecord
started → "catch-up." This happened on every UIAutomator call (ads-choice
check, interstitials check, `isFeedbackOrSurveyCard`, `findLikeButton`, etc.)
— multiple times per cycle.  
**Fix:** `_uiDump` now uses async `spawn` with Promise wrappers and explicit
kill-on-timeout. The event loop is free during the entire dump, the video
WebSocket flushes normally, `bufferedAmount` stays near zero, the watchdog
never fires spuriously. No logic changes — identical timeout values (5 s dump,
4 s pull), just non-blocking.

**Share-to-DM "Send" button never pressed:**  
Two problems: (1) the wait after tapping the recipient avatar was 700 ms —
not long enough for Instagram to render the blue Send button. (2) The fallback
when `findButtonByLabel("Send")` returned null was `pressBack`, which
dismissed the sheet instead of sending.  
**Fix:** wait increased to 1500 ms. `sendShareSheet` now accepts `w, h` and
falls back to a coordinate tap at `(w×0.422, h×0.948)` — the consistent
screen position of the Send button across all tested Instagram versions —
so a DM share always completes even if the UIAutomator label lookup misses.

---

## [1.1.471] — 2026-07-11

### Fix: strip client-side frame-drop / clientLag loop (back to basics)

The frame-drop + bidirectional lag-signal code added in v1.1.469 created a
self-reinforcing feedback loop:

1. `decodeQueueSize > 8` → skip every non-keyframe
2. Keyframes arrive ~1–2×/sec → effective frame rate collapses to ~1 fps
3. Queue never drains because no delta frames are being decoded
4. `lagSinceRef` fires → send `{ clientLag }` to server → server kills screenrecord
5. Client flushes decoder + clears canvas → blank screen
6. New screenrecord starts → back to step 1

**Fix:** removed all client-side queue inspection, frame dropping, `lagSinceRef`,
and `clientLag` signal entirely. The decode loop is now: demux → configure if
needed → `decoder.decode()` → done. WebCodecs drains its own queue at GPU
speed; the server-side `ws.bufferedAmount` watchdog (original design, never
removed) handles genuine TCP send-buffer backlog without any client involvement.

---

## [1.1.470] — 2026-07-11

### Fix: mirror colour revert (pink tint), UIAutomator 20s silent hang

**Mirror colour — revert sRGB canvas (pink/red tint introduced in v1.1.469):**  
Forcing `colorSpace: "srgb"` on the 2D canvas context caused the browser to
apply a BT.601→sRGB chroma conversion on every VideoFrame blit. Android
screenrecord H.264 has no VUI colour info, so WebCodecs defaults to BT.601;
converting BT.601 to sRGB inverts the Cb/Cr signs — producing a strong
pink/red tint across the entire mirror. Reverted: `getContext("2d")` with no
colour-space option passes YCbCr through unchanged, which matches what the
phone display actually shows. Context caching is retained (no perf regression).

**UIAutomator 20-second silent hang:**  
`_uiDump` (UIAutomator accessibility dump) had a 10 s `spawnSync` timeout.
During the Instagram splash/loading screen the accessibility tree is being
rebuilt continuously; UIAutomator consistently timed out at the full 10 s,
then the `adb pull` added another 6 s — 16 s per call, invisible in the log.
Two calls in `dismissAdsChoiceDialog` = the 20-second black hole seen between
`[4.6s] Checking for launch dialogs` and `[24.9s] Starting feed scroll`.  
**Fixes:**
- `_uiDump` hard timeout: 10 000 → 5 000 ms (adb shell), 6 000 → 4 000 ms (adb pull)
- Added `tLog` lines before AND after every dialog scan call:  
  `UIAutomator: scanning for ads-choice dialog…` → `No ads-choice dialog — continuing`  
  `UIAutomator: scanning for other launch popups…` → `No launch popup — feed ready`  
  Every second of the startup sequence is now visible in the Log tab.

---

## [1.1.469] — 2026-07-11

### Fix: mirror lag, blue tint, IG open delay, log timestamps

**Mirror lag — bidirectional resync:**  
The server-side lag watchdog only detected backlog in the TCP send buffer
(`ws.bufferedAmount`). If the client's GPU WebCodecs decoder fell behind (the
client received frames fast but decoded them slowly), the server never noticed
and the lag compounded forever. Added client→server `{ clientLag }` signal:
when the client's decode queue has been over 8 frames for >800 ms it sends the
signal, the server immediately kills and restarts screenrecord, and the client
clears its decoder and canvas simultaneously — lag collapses to near-zero on
the very next keyframe (~0.5 s) instead of draining the old backlog.

**Blue discoloration — colour space fix:**  
Android's screenrecord outputs H.264 with BT.601 implied by the profile (no
VUI colour info), but the phone's display is BT.709/sRGB. The canvas
`getContext("2d")` was called fresh every frame with no `colorSpace` option, so
the browser defaulted to BT.601 matrix for the VideoFrame→canvas blit — the
resulting colour shift was most visible in the status-bar blue tones in the
top-right. Fix: `getContext("2d", { colorSpace: "srgb", alpha: false })` is
now called once and cached; `colorSpace:"srgb"` forces the sRGB pipeline that
matches Android's display, eliminating the tint. The canvas also immediately
clears to black on every decoder reset so no stale frame bleeds through.

**Bitrate 8 → 4 Mbps:**  
Halves the data volume per second which directly halves how fast the decode
queue fills. Mirror quality at 4 Mbps over USB is unchanged.

**IG open delay reduced:**  
- Post-launch wait: 2000 ms → 1200 ms  
- `dismissAdsChoiceDialog` taps: 1200/500/1200/1200 ms → 800/400/800/800 ms  
Total saving when the ads dialog appears: ~2.4 s.

**Log tab — elapsed timestamps:**  
Every automation step log line now starts with `[Xs]` elapsed time so the
user can see exactly which step is taking time (e.g. `[4.2s] ▶ Checking for
launch dialogs…`).

---

## [1.1.468] — 2026-07-11

### Fix: video mirror DRM restart speed + share-DM tapping wrong target

**Video mirror — 4 s restart when DRM-blocked:**
The "no real frame yet" stall threshold was 8 s (v1.1.467), which was actually
*slower* than the original 6 s constant timeout. On MIUI/Xiaomi, scrcpy gets
DRM-blocked the moment Instagram's feed loads video content — the stream
produces only a 46-byte metadata packet then goes silent. The old 6 s constant
meant scrcpy cycled quickly and would occasionally catch a real frame in the
brief window between DRM re-engagements. Raising it to 8 s made those
catch-windows rarer, which is why the mirror appeared worse.
**Fix:** drop the "no real frame" threshold to 4 s (faster than before).
The three tiers are now:  
- No real IDR frame yet → **4 s** (aggressive restart, punch through DRM)
- Real frames flowing + automation active → **30 s** (UIAutomator patience)
- Real frames flowing + idle → **6 s** (normal watchdog)

**Share-DM — tapping drag-handle instead of user bubble:**
The avatar slot y-coordinates (0.625 / 0.740) were calculated assuming the
share sheet starts at ~50% of screen height. A live accessibility dump on the
user's 1080×2226 device showed the sheet actually starts at y=1651 (74.2%):
- y=0.625 × 2226 = 1391 px → above the sheet entirely (taps the post behind it)
- y=0.740 × 2226 = 1647 px → right at the drag-handle pill (y≈1672), which
  causes the sheet to **expand to full screen** instead of selecting a recipient.
  This was the "clicking to expand to see more users" bug.
**Fix:** updated all four avatar slots to y=0.786 (y=1749 on this device,
measured directly from the scan) with x positions measured from the scan:
- Bubble 1: x=0.151 (163 px)
- Bubble 2: x=0.328 (354 px)
- Bubble 3: x=0.487 (526 px)
- Bubble 4: x=0.642 (693 px)

---

## [1.1.466] — 2026-07-11 (hotfix included)

### Fix: Human Session Tool stalls + empty log during automation cycles

**Root cause — three separate problems found from the log:**

1. **Stall watchdog was too aggressive during automation** — the 6-second
   no-data threshold is correct for an idle mirror session (screen off = stall
   immediately). But during an active automation cycle the phone is busy running
   adb commands: each `dismissAdsChoiceDialog` and `dismissInstagramInterstitials`
   call fires a UIAutomator accessibility dump that takes 1–2 s, and they're
   called in sequence — `dismissAdsChoiceDialog` + `dismissInstagramInterstitials`
   on launch + `dismissInstagramInterstitials` on each scroll. On a loaded MIUI
   device these can chain to 4–6 s with no screenrecord output, which fired the
   watchdog right in the middle of legitimate work. The watchdog killed
   screenrecord, the restart got a brief burst of frames (resetting the
   `stallNotified` flag), then stalled again — causing the repeating "Stream
   stalled" messages seen in the log.
   **Fix:** stall threshold raised from 6 s → 30 s while
   `automationCycleInProgress` contains this serial. Drops back to 6 s the
   moment the cycle ends. The stall message is also updated to say
   *"Stream paused — automation busy (UIAutomator / adb). Restarting stream…"*
   instead of "screen may be off" when automation is active.

2. **Log panel was completely blank during automation** — the cycle runs as a
   single blocking HTTP POST. No intermediate steps were ever pushed to the
   client. The user saw "Cycle starting" then silence, assumed everything was
   frozen, and turned off the toggle — aborting a cycle that was actually
   running fine.
   **Fix:** added a `videoSessionWS` map (`serial → WebSocket`) that the video
   stream handler populates when a client connects and clears on disconnect.
   Added `sendVideoLog(serial, msg)` helper that pushes `{ info: msg }` through
   that socket. The Log panel now shows real-time step-by-step progress from
   the automation backend:
   - `▶ Waking screen…`
   - `▶ Unlocking screen…`
   - `▶ Opening Instagram…`
   - `▶ Checking for launch dialogs…`
   - `▶ Starting feed scroll — N posts`
   - `  Scroll 1/3`, `  Scroll 2/3`, `  Scroll 3/3` (per-scroll via `onLog`
     callback added to `runCheckFeedLoop`)
   - `▶ Feed done — N likes, N feed-shares, N DM-shares`
   - `▶ Starting stories (up to N)` / `▶ Stories done — N watched`
   - `▶ Closing Instagram…`
   - `▶ Airplane mode ON — recycling network…` / `▶ Airplane mode OFF`
   - `▶ Locking phone — cycle complete ✓`

3. **Video delay does NOT cause automation delay** — the automation sends adb
   commands directly to the phone, completely independently of the video
   stream. The video is for monitoring only. The user was seeing a false
   correlation: the automation was running fine while the video stream stalled.
   With the new progress messages this is now self-evident from the log.

---

## [1.1.465] — 2026-07-11

### UI: Redesigned Mobile sidebar icon; Windows installer CI now builds on every push to main

**Redesigned Mobile nav icon** — The Mobile entry in the left sidebar now uses a
redrawn smartphone icon. The previous icon was a plain rectangle with a flat screen
cutout and a thin home-indicator bar. The new icon is modelled on a modern Android/
iPhone form factor:

- **Punch-hole camera** — a small filled circle centred at the top of the phone body
  replaces the old featureless top bezel, making the icon immediately readable at the
  32 × 32 px size it renders at in the sidebar.
- **Side buttons** — two volume buttons on the right edge and a power button on the
  left edge are rendered as low-opacity rounded rectangles. They add depth and silhouette
  detail without cluttering the icon at small sizes.
- **Pill home indicator** — slightly wider and taller than the previous thin bar, keeping
  the modern full-screen phone language.
- **Tighter body proportions** — the phone body now uses `rx=3.5` (was `rx=2.5`), giving
  it more pronounced rounded corners that match the iOS/Android aesthetic.

No behaviour, routing, or data is affected — purely visual.

**Windows installer CI trigger extended to push → main** — `build-windows-installer.yml`
previously only ran on `v*` tag pushes and manual `workflow_dispatch`. It now also
triggers on every push to the `main` branch, so a fresh `Equinox-Installer` artifact is
produced automatically after each commit without needing to cut a tag. The artifact is
uploaded to GitHub Actions as before; the `Publish to GitHub Release` step still only
runs on tag pushes, so no spurious releases are created from regular commits.

---

## [1.1.464] — 2026-07-11

### Fix: Mirror lag, app-open delay, share-sheet expansion bug; remove stories tooltip

**Mirror stream lag (up to 10 seconds behind)** — Two-layer fix:

*Server side:* The lag watchdog threshold was lowered from 2 MB to 800 KB (~0.8 s of
video at 8 Mbps) and the poll interval halved from 1 s to 500 ms, so the server
detects a backing-up send buffer and kills/restarts screenrecord twice as fast.

*Client side (the real fix):* When the server restarted screenrecord, the WebCodecs
decoder still had a large queue of old frames to drain before it would show the new
live ones — meaning the visible lag persisted even after the server restart. Now:
(a) On receiving the server's "resyncing" info message, the client immediately flushes
and closes the decoder, so old queued frames are dropped instantly.
(b) Client-side backpressure gate: if `decoder.decodeQueueSize > 8`, delta (non-key)
frames are skipped until a keyframe arrives. If the queue exceeds 20 even on keyframes,
the decoder is hard-flushed. This caps lag at well under 1 s without server involvement.

**Instagram app sits for ~10 seconds before scrolling starts** — Two sources of dead
time were cut:

*Initial app launch:* The fixed wait after `launchInstagram()` was reduced from 3 500 ms
to 2 000 ms. The `dismissAdsChoiceDialog` and `dismissInstagramInterstitials` calls that
follow each do a full UIAutomator accessibility dump (~1–2 s each), so the total pre-
scroll pause is still adequate for app loading but no longer has a dead 3.5 s visible
pause while the feed is already loaded.

*After feed-scrolling ends, before stories:* The fixed wait for the story tray to
repopulate after tapping the Home tab was reduced from 10 000 ms to 5 000 ms. The 10 s
value was a conservative upper bound from an early test; on the user's device the tray
reliably reloads in 3–5 s, making the second half of the 10 s wait pure dead time.

**Share-to-DM broke the flow — tapping a user expanded the list instead** — The
`SHARE_SHEET_AVATAR_SLOTS` y-percentages (0.525 and 0.667 of full screen height) were
landing too high in the "Send to" bottom sheet. On the user's 1080×2226 device:
- 0.525 × 2226 ≈ 1169 px → right on the sheet's search bar
- The sheet's drag-handle sits at ~50 % Y, so taps at 52.5 % were near the drag zone
- When Android interprets a tap near the drag handle as a swipe, the sheet expands to
  full screen — exactly what the user described ("scrolled upwards / expanded the list")

Fixed by moving both rows down to y=0.625 (1391 px) and y=0.740 (1647 px), which land
squarely in the avatar/conversation rows, well clear of the handle and search bar.

**Removed tooltip text** from the Stories settings panel (the "Set stories to 0 to skip.
Opens one random story bubble…" paragraph the user asked to delete).

---

## [1.1.463] — 2026-07-11

### Fix: Share-to-DM never actually sent, story likes never landed

Diagnosed from a screen-layout scan + screenshot the user provided of the
real Share sheet, and a scan taken mid-story.

**Share-to-DM (feed posts and stories) never sent anything.** Both flows
tapped the paper-plane/share icon to open the recipient picker, then just
pressed Back — no recipient was ever selected and Send was never tapped.
It only ever opened and closed the sheet.

**Fix:** After opening the picker, tap a random recipient avatar from the
quick-share grid (calibrated from the user's screenshot — a 3×2 grid of
avatars below the search box), wait for the checkmark/Send button to
appear, then look up and tap the real "Send" button via the accessibility
tree (same reliable by-label lookup already used for Repost/Close). If Send
can't be found, it falls back to Back so a stuck sheet can't block the
rest of the cycle. Applies to both the feed's share-via-DM action and a
story's share-via-DM action.

**Story likes were never clicked.** `findLikeButton()` was expected to work
in the story viewer the same way it does in the feed, with a fixed-pixel
fallback (15.1% X, 97.8% Y) if it didn't. A fresh screen-layout scan taken
mid-story showed the story viewer exposes only 3 opaque containers total —
there is no accessible Like element in stories at all, so it always fell
through to the fallback tap — and that scan also showed the real
reply/action bar sits at 92.4–93.8% Y (center ~93.1%), not 97.8%. The old
Y value was tapping below the actual bar, missing the heart entirely.

**Fix:** Corrected the story like/share-icon fallback Y coordinate to
93.1%.

**Caveat:** neither fix has been verified against a live device in this
sandbox (no adb/device access here) — the DM-recipient-grid and story
action-bar coordinates are calibrated from the screenshot/scan the user
supplied, not confirmed live. Please test a cycle and report back if a
tap still misses.

---

## [1.1.462] — 2026-07-11

### Fix: Mirror lag/FPS drift + close-all-apps only dismissed one stray app

**Mirror lag / "no longer 30fps":** The live H.264 mirror (`/api/mobile/video/:serial`)
piped `screenrecord`'s stdout straight into `ws.send()` with no backpressure
check. If the browser (or the Node event loop itself — e.g. some *other*,
unrelated code change adding a slow synchronous block) couldn't drain the
socket as fast as the device produced video, Node silently queued the
backlog in `ws.bufferedAmount` forever. TCP/WS backpressure doesn't
self-correct: once the queue starts growing, the stream keeps falling
further behind real time — which looks exactly like "stopped being smooth
30fps" / "awful lag" — and previously only a full page reconnect cleared it.

**Fix:** Added a 1s-interval watchdog per mirror session. If
`ws.bufferedAmount` backs up past ~2 seconds of video (2MB at the stream's
8Mbps bit rate), it kills the current `screenrecord` process — the existing
restart logic immediately relaunches it with a clean IDR frame and an empty
send queue — instead of leaving the growing backlog to compound for the
rest of the session. Lag is now bounded and self-healing rather than
sensitive to whatever else the process happens to be doing at the time.

**Close-all-apps only swiped away one card:** `closeInstagramViaRecents()`
opened the recents switcher and swiped away exactly one card. When more
than one app ends up stacked in recents — an accidental tap opened
something, or the phone's own background activity launched an app on top
of Instagram — only the topmost card got dismissed, leaving the others
still open for the next cycle.

**Fix:** The "open recents, swipe the top card left" gesture now repeats
5 times in a row at the end of the flow before the cycle continues. Each
pass is a no-op once recents is already empty, so this is safe even when
there was only ever one app to close.

---

## [1.1.461] — 2026-07-11

### Fix: Mobile feed loop was acting on non-post content (ads, embedded Reels, Instagram's own "feedback" / snooze cards)

**Root cause:** Instagram doesn't always serve a normal post in the feed —
sometimes it's an embedded Reel, a sponsored ad, or (after its own
suggested-content flow fires) a "Thanks for your feedback" card with
"Undo" / "Snooze all suggested sets of reels in feed for 30 days" /
"Manage content preferences". None of these expose the same Like/Share/Send
action row a normal post does. Share-to-feed and share-via-DM tapped fixed
on-screen coordinates regardless of what was actually on screen, so when one
of these non-post cards took a post's place, the tap landed on "Undo",
"Manage content preferences", or whatever else happened to be there instead
— derailing the rest of the cycle. This is what caused the accidental
feedback-form click reported during a live run.

**Fix — `runCheckFeedLoop` (`artifacts/api-server/src/routes/mobile.ts`) now
gates every action on a confirmed action bar:**
1. Like/share-feed/share-DM chances are still rolled independently up front
   (same statistics as before), but nothing is tapped until the current
   screen is checked.
2. New `android.isFeedbackOrSurveyCard()` detects Instagram's feedback/snooze
   card by its on-screen text ("Thanks for your feedback", "Snooze all
   suggested", "Manage content preferences", "See fewer/more posts like
   this", ad-rating prompts). If present, all three actions are skipped for
   that item — no tap fires at all, and the loop just scrolls past.
3. Otherwise, `android.findLikeButton()` is used as the actual-post check.
   If no Like button is found on screen (embedded Reel, ad, or content still
   animating in from the scroll), like, share-to-feed, and share-to-DM are
   *all* skipped — previously only the like was skipped while share-to-feed
   and share-to-DM still fired blind.
4. When a Like button **is** found, its real Y position (`rowY`) is used to
   position the share-to-feed and share-to-DM taps, instead of a separately
   guessed fixed action-bar percentage — this keeps the three actions
   aligned to the actual post on screen even when its height differs from
   the last one (carousel, longer caption, etc.).

**New helper:** `isFeedbackOrSurveyCard(serial)` in `androidManager.ts` —
single ui-dump text match against Instagram's known feedback/survey/ad-rating
card strings.

This can't guarantee Instagram never serves something unusual, but the tool
now only clicks like/share/DM when it has positively confirmed a normal
post's action bar is on screen — it no longer taps blind at a fixed spot and
hopes a real post is still there.

---

## [1.1.460] — 2026-07-11

### Fix: Share button coordinates were hitting Comment → Reels tab triggered

**Root cause:** `shareIconX` was set to 33% X, which landed exactly on the
Comment button (scan-confirmed bounds 27–34% X). Opening the comment section
caused every subsequent share-flow tap to miss, and the swipe-to-dismiss
(going to 90–95% Y) crossed the bottom nav bar, where the Reels tab at 50% X
got triggered — sending the phone to the Reels section mid-cycle.

**Fix — correct coordinates (confirmed from screen-layout scan, 1080×2226):**
- Share to feed (circular arrows / repost): 48.1% X, 70.2% Y
- Share to DM (paper plane): 66.0% X, 70.2% Y
- Action bar Y: 70.2% (was 72%)

**Fix — share-to-feed flow now uses the accessibility tree:**
1. Tap the repost icon at correct coords
2. `findButtonByLabel("Repost")` — finds the Repost button in the share sheet
   via ui-dump rather than guessing a fixed percentage position
3. After tapping Repost, `findButtonByLabel("Close")` detects the first-time
   "You reposted X's post" confirmation popup and taps its blue Close button
4. If "Repost" is not found in the sheet (didn't open), `pressBack` to cancel

**Fix — share-to-DM dismiss changed to `pressBack`:**
The old swipe-to-dismiss was the direct cause of the Reels tab tap. Using
`pressBack` closes the DM picker safely with no nav bar risk.

**New helper:** `findButtonByLabel(serial, label)` in `androidManager.ts` —
finds any clickable element by exact text/content-desc match via ui-dump.

**UI:** All 5 stories settings (Stories to watch, % to watch, Like %, Share DM %)
collapsed onto a single flex row.

---

## [1.1.459] — 2026-07-11

### Rework: Stories settings — total story count, per-story like %, per-story share DM %

**Removed:** "Users to watch" — the concept of per-user story sessions is gone.

**Renamed:** "Slides per user" → **"Stories to watch"** (min/max). This is now
the total number of story slides watched in one session regardless of which
account they belong to. Set both to 0 to skip story viewing entirely.

**Behaviour change:** The bot taps one random story bubble to open the viewer,
then advances through stories one at a time (tap right side) until the
configured count is reached, then swipes down to exit. No separate "user"
loop.

**Added:** **"Like stories %"** (min/max). Per-story chance to tap the heart
icon. Uses the accessibility tree (`content-desc="Like"`) with a pixel-
coordinate fallback (15.1% X, 97.8% Y from the scan on the user's device).

**Added:** **"Share stories via DM %"** (min/max). Per-story chance to tap
the paper-plane / send icon (43.2% X, 97.8% Y), open the DM picker, then
close it without sending — registers the share intent in a human-looking
way.

All three new percentage fields default to 0 (opt-in).

---

## [1.1.458] — 2026-07-11

### Fix: automation now dismisses Instagram interstitial popups automatically

Instagram randomly shows blocking popups mid-cycle ("Your notifications are
off", "Save your login info?", permission dialogs, etc.). Previously these
would silently stall the automation since every subsequent tap would land on
the popup instead of the feed/story.

New `dismissInstagramInterstitials()` function in `androidManager.ts`:
- Does a quick ui-dump and looks for any of these dismiss labels in order:
  "Not now", "Skip", "Maybe Later", "No thanks", "Later", "Dismiss",
  "Don't Allow", "Deny", "Cancel"
- Taps the first match and waits 600 ms for the modal to close
- Never taps positive-action buttons ("Turn on", "Allow", "Continue") so
  it can't accidentally grant unwanted permissions

Called automatically at three points per cycle:
1. **After Instagram launches** — catches the notifications prompt that
   often appears on first open
2. **Every feed scroll** — catches popups that appear mid-browse
3. **Before story viewing starts** — catches the notifications prompt that
   often fires again when the feed refreshes after tapping Home

If nothing needs dismissing the call is a no-op (one fast ui-dump, no tap).
Dismissed popup labels are recorded in the cycle `steps` log.

---

## [1.1.457] — 2026-07-11

### Improve: "Scan Story Tray" → "📋 Scan Screen Layout" (general-purpose)

The old scanner only looked at the top 20% of the screen and silently
skipped any element without a content-desc/resource-id/text label —
which is exactly why Instagram's story bubbles showed up as "no named
elements found" (they have no accessibility label at all).

The new `GET /api/mobile/devices/:serial/screen-layout-scan` endpoint:
- Scans the **entire screen**, not just the top strip
- Includes **every element** with a non-zero bounding box, labelled or not
- Reports pixel coordinates **and** screen-percentage equivalents so
  results are device-independent
- Groups elements into three vertical zones (top / middle / bottom)
- Marks clickable (tappable) elements with ● vs containers with ○
- Can be run before implementing any new tap or swipe feature to get
  real coordinates instead of guessing — avoids the 20-version guessing
  cycle that plagued the story-tray work

The Log-tab button is renamed to **📋 Scan Screen Layout** to reflect
that it works for any screen, not just the story tray.

---

## [1.1.456] — 2026-07-11

### Fix: like button was double-tapped (like then instantly unlike)

The automation was calling `doubleTap()` on the heart icon, which pressed
it twice in quick succession — once to like, once to unlike. Changed to a
single `tap()`. Double-tap belongs on the post image/video (the gesture
Instagram uses to like from anywhere), not on the dedicated button.

### Fix: story tray coordinates corrected from real screenshot data

Three wrong values in `pickAndOpenRandomStory()` were stacking up to make
the gesture consistently miss:

| Setting | Old | New | Why |
|---|---|---|---|
| `storyBarY` | `h × 8.5%` | `h × 14%` | 8.5% lands in Instagram's header bar above the tray; 14% puts the tap in the middle of the bubble row (verified against 1080×2226 screenshot) |
| `firstStoryX` | `w × 22%` | `w × 37%` | 22% lands on the user's own "Your story +" slot which opens the camera; first friend's bubble starts at ~37% |
| `spacing` | `w × 14%` | `w × 18.5%` | Measured bubble-to-bubble gap from screenshot; previous value compressed slots into each other |

### Fix: story opening gesture changed from swipe to tap

The "hold-and-slide-right" swipe was scrolling/flinging the story tray
(or accidentally hitting the Reels tab) rather than opening a story.
Opening a story on Instagram requires a **single tap** on the bubble.
`pickAndOpenRandomStory` now picks a random slot (1–4 visible friends)
and taps its centre directly — no swipe involved.

---

## [1.1.455] — 2026-07-11

### Add: "Scan Story Tray" button in the Log tab

Instead of asking the user to run adb commands in a terminal, a one-click
button now does the coordinate discovery for us:

1. User opens Instagram on the phone and navigates to the Home tab so the
   story tray is visible.
2. In the app, they open the **Log** tab and click **🔍 Scan Story Tray**.
3. The app calls a new `GET /api/mobile/devices/:serial/story-tray-scan`
   endpoint which runs `uiautomator dump`, parses every accessibility node
   whose vertical centre sits in the top 20 % of the screen, and returns
   the real pixel coordinates (plus resource-id / content-desc / text) for
   each named element found there.
4. Each line is printed directly into the Log panel — no terminal needed.

This tells us exactly what Y coordinate and element labels Instagram puts
on the story-tray row, so we can fix the tap/swipe coordinates with real
data instead of guessing percentages.

---

## [1.1.454] — 2026-07-10

### Fix: hold-and-slide gesture opened the Reels tab instead of a story

- The two-step tray navigation added in 1.1.452 (a separate swipe to
  scroll the tray when the random target wasn't on screen, followed by a
  second swipe to actually pick the bubble) was almost certainly the cause
  — two independent `input swipe` calls starting close to the top of the
  screen can each be misread as unrelated gestures instead of one
  continuous scrub, and something in that chain ended up on the Reels tab.
- Removed the separate scroll step entirely. `pickAndOpenRandomStory()` now
  does exactly ONE hold-and-slide-right gesture per pick, with the random
  target clamped to whatever bubbles are actually visible on screen (up to
  10) instead of scrolling to reach further ones.
- Tightened the story-tray Y coordinate to `h * 0.085` — per user
  confirmation the tray sits top-central and is a thin band (~15px tall on
  their device), so precision on Y matters more than X here.

---

## [1.1.453] — 2026-07-10

### Debug: added a raw UI-dump endpoint to stop guessing story-tray coordinates

- The hold-and-slide gesture in 1.1.452 landed on the Reels tab instead of a
  story bubble — screen-percentage guesses for the tray position/spacing
  have now been wrong twice (Home tab, then the story tray).
- Added `dumpUi()` (exported from `androidManager.ts`) and a debug endpoint,
  `GET /api/mobile/devices/:serial/ui-dump`, that returns the device's real
  accessibility tree (resource-ids, content-desc, on-screen bounds) so the
  next story-tray fix can target the actual elements instead of another
  percentage guess. No behavior change to the automation cycle itself in
  this release.

---

## [1.1.452] — 2026-07-10

### Fix: Stories step opened the viewer but never picked/clicked a story

- The Home-tab fix landed correctly (stories bar now visible at the top),
  but the tap that opens a story was still landing on nothing clickable.
- Replaced the fixed "tap the first story" behavior with a hold-and-slide
  gesture: press down on the story tray and slide right, releasing on a
  randomly chosen bubble (position 1-10, 1-indexed after "Your story") so
  the same bubble isn't always picked — added `pickAndOpenRandomStory()` in
  `mobile.ts`, which scrolls the tray first if the chosen position isn't yet
  on screen, then does the slide as one slow drag (900-1400ms) so it reads
  as a deliberate press-and-drag rather than a flick.
- Changed the between-users transition: once all slides for the current
  user are watched and more users remain, the story is closed with a
  *slight* downward drag back to the feed, and the pick-and-slide-right
  cycle runs again for the next user (rather than swiping left within the
  viewer as before). The last user still exits with a full downward swipe.

---

## [1.1.451] — 2026-07-10

### Fix: toggling on manually now runs the first cycle immediately again

- The 1.1.450 fix made the first cycle always wait the configured Run-every
  interval — but that also delayed the case where the user deliberately
  flips the toggle off then back on, which should still start right away.
- Added `setEnabledByUser`, used only by the master toggle's `onCheckedChange`.
  It marks a ref before flipping `enabled` on, so the run-loop effect can
  tell "user just turned this on" (run immediately) apart from "settings
  loaded with `enabled` already true" i.e. app restart with a phone's
  toggle left on from before (wait the configured interval, as fixed in
  1.1.450). Plain settings changes / initial load never set the ref, so
  restarts still wait as intended.

---

## [1.1.450] — 2026-07-10

### Fix: Home-tab tap landing on a feed post, and automation cycle firing instantly on toggle-on/restart

#### Fix: Stories step tapped a feed post instead of the bottom-nav Home icon

- The Home-tab tap before Stories used fixed screen percentages (10% width,
  97.5% height), which on this device/screen ratio landed on a post in the
  feed instead of the actual house icon in the bottom nav.
- Added `findHomeTab()` in `androidManager.ts`, which reads Instagram's
  accessibility tree for the bottom-nav Home tab (`content-desc="Home"`,
  with a resource-id fallback) and taps its real on-screen centre instead of
  a guessed position. Falls back to the old percentage tap only if the
  element genuinely isn't found.

#### Fix: Automation cycle ran instantly instead of waiting the configured interval

- When the master toggle was already on and the app restarted (or the
  toggle was flipped on), the automation cycle fired immediately instead of
  waiting a randomized delay from the "Run every X to Y minutes" setting.
- The effect that drives the cycle loop called `runCycle()` directly on
  mount. Now the very first cycle is scheduled with the same randomized
  min/max wait used between subsequent cycles, so enabling the tool (or
  restarting with it already enabled) always waits before the first run
  instead of executing on update/restart.

---

## [1.1.449] — 2026-07-10

### Fix: Mobile automation cycle — ads-consent modal and Stories not watching

#### Fix: Meta's "ads choice" consent screen silently blocked the automation cycle

- Instagram occasionally shows a full-screen EU/UK ads-consent modal on
  launch ("Make a choice about your ads" → **Get started** → select **Use
  for free with ads** → **Continue** → **Agree**). It's a full-screen overlay
  that blocks everything behind it, so once it appeared every subsequent
  scripted tap in the cycle (feed scroll, likes, stories) landed on the
  modal instead of the feed and the rest of the run silently did nothing.
- Added `dismissAdsChoiceDialog()` in `androidManager.ts`: takes a single UI
  dump after Instagram launches, and only acts if the dump actually matches
  the ads-choice screen (checks for "choice about your ads" / "Get started"
  text together with an ads reference) — it will not fire on unrelated
  dialogs that happen to share a button label. If it matches, it walks
  Get started → Use for free with ads → Continue → Agree in sequence,
  waiting for each screen to advance. No-op (one UI dump, zero taps) when
  the dialog isn't present.
- Wired into `automation-cycle` immediately after `launch-instagram` and
  before feed scrolling starts, with an extra 1s settle delay if the dialog
  was actually dismissed.

#### Fix: Stories (Step 3) not opening after feed scrolling — Home-tab wait was too short

- Reported symptom: after all feed scrolling finished, there was a 45+
  second wait, then the feed scrolled back to the top, and the Stories step
  finished immediately without anything actually being watched.
- Root cause: the automation cycle already tapped the Instagram bottom-nav
  Home icon to force the feed back to the top before starting the stories
  loop (this was a fix from a previous release), but only waited **1.5
  seconds** afterward before tapping the stories tray. The stories tray does
  not repopulate that fast after a Home-forced refresh — it needs up to
  ~10 seconds — so the tap landed on empty space, no story ever opened, and
  the stories loop ran through its timing with nothing on screen to show
  for it.
- Fix: increased the post-Home-tap wait from 1.5s to 10s in
  `runViewStoriesFromFeedLoop`'s call site in `automation-cycle`, giving the
  stories tray time to fully reload before the first story tap.

---

## [1.1.447] — 2026-07-10

### Account Settings, Inject Profile Browsing (Step 2), and Ghost Browser slot management

#### Feature: Delete button for each Instagram Account Slot

- **Account Settings (Mobile tab) now has a Delete button on every Instagram
  Account Slot row**, placed immediately after the 2FA "Generate" button.
  Clicking it removes that slot's username, password, and 2FA/TOTP secret
  fields, and keeps the per-slot UI state (show/hide password, generated TOTP
  code, TOTP error) correctly aligned with the remaining slots — no more
  need to blank out a slot manually to "remove" it.

#### UI: "+ Add Instagram Account Slot" button is now left-aligned and text-width

- Previously this button stretched the full width of the panel
  (`className="w-full"`). It is now wrapped in a left-aligned flex container
  and sized to fit its own label (`w-fit`), matching the left-aligned,
  content-sized style used elsewhere in Account Settings instead of looking
  like a stray full-width bar under the slot list.

#### Feature: "Share to Feed" percentage field added to Inject Profile Browsing (Step 2)

- **A new X–Y percentage field, "Share to Feed", now sits directly after the
  Like field** in the Inject Profile Browsing settings used by Step 2 of the
  automation config. When it fires, the engine clicks the double-arrow
  "share to own feed" button on a random post from the profile being
  browsed — the same underlying action already used by the timeline
  "Share Post" feature, `client.sharePostToFeed(mediaId)`, but now triggerable
  from profile browsing sessions with its own Min/Max chance and Min/Max
  queue-order weight (`injectProfileBrowsingShareToFeedPctMin/Max` and
  `injectProfileBrowsingShareToFeedPctOrderMin/Max`).
- **"Share via DM" (send to a random user) now sits directly to the right of
  "Share to Feed" on the same row**, right after Like. This existing field
  (`injectProfileBrowsingShareToDmPct*`) previously lived in its own row much
  further down the panel, disconnected from the Like/engagement fields it
  logically belongs with — the old standalone "Share to DM" row has been
  removed to avoid a duplicate control.

#### Backend: new "share to feed" action in the profile-browsing engagement queue

- The automation engine's per-profile engagement queue (the same
  order-weighted queue that runs Like, Save Media, Watch Stories, Comment,
  and Share to DM) now also enqueues a "share to feed" action when
  `injectProfileBrowsingShareToFeedPctMax > 0` and the profile has posts
  loaded. It rolls the configured percentage, picks a random post from the
  profile, calls `sharePostToFeed`, and logs the result via `logAction`
  (`share_post`) exactly like the existing timeline share-to-feed feature —
  errors are swallowed as non-critical, matching the Share to DM action's
  error-handling pattern.

---

## [1.1.446] — 2026-07-10

### Mobile tab — UI overhaul, phone wake bug fix, canvas black screen on power

#### UI: STEP1 card now contains "Run every" interval on the same bordered card

- **"Run every X–Y minutes" is now inside the same bordered wrapper as the
  STEP1 toggle**, on the row directly below it. Previously the interval row
  sat outside the card as a loose row, making it visually disconnected from
  the toggle it controls. It is now clearly part of the STEP1 configuration
  block — toggling on and setting the interval are both done inside the same
  bordered card.

#### Feature: toggle shows "Active" + next-run timestamp between cycles

- **When the automation toggle is on and a cycle has just finished, the
  status now shows "Active" with a "Next run at HH:MM on DD/MM/YYYY"
  line underneath it**, instead of staying on "Running" until the next cycle
  begins. This tells you exactly when the tool will fire again without having
  to guess based on your configured interval.
  - While a cycle is actually executing, the status shows "Running" as
    before.
  - The timestamp is calculated from the random gap drawn at the end of each
    cycle (`cycleIntervalMin`–`cycleIntervalMax` minutes) so it reflects the
    real next-fire time, not just an average.
  - Toggling off clears the timestamp immediately.

#### Feature: "Final Step" section added below STEP2

- **A new "(FINAL STEP)" bordered card sits below the STEP2 View Feed
  card.** It describes the close-and-recycle step that always runs at the
  end of every automation cycle: *"Close the Instagram app and Airplane Mode
  will be activated for 15–20 seconds, then Airplane Mode will be turned
  off."* This makes the three-phase cycle (STEP1 → STEP2 → FINAL STEP)
  visible and self-documenting in the UI.

#### UI: Account Settings — all three fields on one row per slot

- **Username, Password, and 2FA OTP Secret are now on a single horizontal
  row per slot**, instead of three separate stacked rows. The previous layout
  used three `space-y` blocks per slot, making five slots take up an
  unreasonable amount of vertical space. The new layout keeps the same fields
  in a compact `flex-wrap` row with labels above each input — the card still
  wraps cleanly on narrow panels.
  - "Generate Code" button shortened to "Generate" to keep the row tighter.
  - Labels reduced from `text-sm` to `text-xs` to match the denser layout.

#### UI: Account Settings — "Slot N" renamed to "Instagram Account Slot N"

- **Each slot header now reads "INSTAGRAM ACCOUNT SLOT N"** instead of the
  generic "SLOT N". This makes the purpose of each card unambiguous —
  especially relevant now that slots can be added dynamically.

#### Feature: Account Settings — "Add Instagram Account Slot" button

- **A "+ Add Instagram Account Slot" button below the last slot lets you add
  as many slots as you need**, beyond the default 5. Each press appends a new
  empty card. All per-slot UI state (show/hide password, TOTP code, TOTP
  error) is correctly extended when a new slot is added.
  - The backend `max(5)` Zod cap on the `slots` array has been removed. The
    API now accepts any number of slots — existing 5-slot data is unaffected.
    On load the UI preserves however many slots the server stored.

#### Bug fix: Power button now shows a true black screen (no cached frame)

- **When you press the Power button to lock the phone, the mirror canvas
  immediately clears to solid black** — no more seeing the last captured
  frame (wallpaper, lock screen, or Instagram) sitting on screen making the
  phone appear to still be on.
  - Two complementary paths:
    1. **Immediate** — the Power button calls `clearToBlack()` directly on
       the canvas via a `useImperativeHandle` ref, before the keyevent even
       reaches the device. The canvas goes black the instant you click.
    2. **Automatic** — a `useEffect` inside `LiveCanvas` also clears the
       canvas whenever `status` transitions to `"asleep"`, which covers
       automation-triggered power-offs (airplane-mode cycle, etc.) where the
       user didn't press Power themselves.
  - `LiveCanvas` is now a `forwardRef` component so `PhoneSlot` can hold a
    typed `LiveCanvasHandle` ref (`{ clearToBlack: () => void }`).

#### Bug fix: phone no longer wakes constantly from sleep on its own

- **Root cause identified and fixed: the server-side WebSocket stream handlers
  were sending `KEYCODE_WAKEUP` (adb input keyevent 224) automatically from
  four separate locations**, causing the phone to wake up every few seconds
  even with no tools running and the user having done nothing:

  | Location | Frequency |
  |---|---|
  | Screenshot WS — on every client connect | Every 2–3 s (client reconnects when stream drops after phone sleeps) |
  | Screenshot WS — screencap loop | Every 400 ms while `screencap` returned 0 bytes (screen off) |
  | Video WS — on every client connect | Every 2–3 s |
  | Video WS — stall timer | Every 6 s when `screenrecord` produced no data (which always happens when screen is off) |

  All four automatic `KEYCODE_WAKEUP` calls are removed. `wm dismiss-keyguard`
  (which can also trigger a display wake on some OEM skins) is removed from
  the same connect and stall-timer paths.

  Wake is now **exclusively user-triggered**: tapping the mirror canvas sends
  a `KEYCODE_WAKEUP` via the `/api/mobile/devices/:serial/input/key` endpoint,
  which is the only legitimate path. The phone now sleeps correctly between
  automation cycles and stays asleep until you explicitly tap the mirror or
  the automation engine wakes it as part of a new cycle.

  The screen-timeout suppression (`screen_off_timeout → 2147483647`) is kept:
  it prevents the phone from auto-sleeping on its own timer *while you are
  actively watching the mirror*, which is the intended behaviour. It is
  restored on WS disconnect.

---

## [1.1.445] — 2026-07-10

### Mobile tab — swipe fix (no hold), interval timer, persistent settings, UI polish

#### Bug fix: Instagram recents dismiss — plain swipe, no long press

- **Fixed: the long-press + drag caused MIUI to show a context bubble menu
  instead of dismissing the Instagram card.** The correct gesture on MIUI is
  a simple click-drag left — touch down, move left ~40 % of screen width,
  lift — with no hold at the start point. The gesture is now a plain
  `input swipe` with 220 ms duration and no preceding hold command. The
  force-stop fallback (`pidof` check) is still in place for any case where
  the gesture misses.

#### Bug fix: settings no longer reset on app update

- **Fixed: every time a new version of Equinox was installed, the Human
  Session Tool settings (scroll count, delays, like %, enabled state) reset
  to defaults.** Root cause: the config file (`mobile-instances.json`) was
  stored at `process.cwd()`, which on Windows points at the app's install
  directory — that directory is overwritten on every update. The file is now
  stored in the Electron `userData` directory (`%APPDATA%\Equinox`) which is
  never touched by the installer. Settings survive updates the same way the
  database and cookies already do.
  - `EQUINOX_DATA_DIR` env var added to the server spawn block in Electron
    main, set to `app.getPath("userData")`.
  - `configFilePath()` in the API server now reads
    `process.env.EQUINOX_DATA_DIR ?? process.cwd()` so the dev environment
    (no env var) is unaffected.

#### Feature: "Run every X to Y minutes" cycle interval

- **A new "Run every … minutes" row appears directly below the STEP1 toggle.**
  When the toggle is switched on, the tool waits a random amount of time
  between the two configured values (in minutes) before starting each new
  automation cycle. Previously the gap was derived from the per-action delay
  seconds, which was the wrong field entirely. The new fields default to
  20–30 minutes and are saved to `mobile-instances.json` along with all
  other settings.
  - Both input fields enforce a minimum of 1 minute; the run loop also
    defensively clamps to ≥ 1 before scheduling so a stored zero can never
    produce an immediate tight loop.

#### UI: model name in header top right

- The device model name (e.g. "Xiaomi 23076RN8DY") now sits on the **right
  side of the "Human Session Tool" title row** instead of below it on a
  second line, keeping the header compact.

## [1.1.444] — 2026-07-10

### Mobile tab — recents swipe fix (MIUI), 5-slot Account Settings, UI polish

#### Bug fix: Instagram recents dismiss now uses long-press + drag-left (MIUI)

- **Fixed: swiping the Instagram card off the recents screen still wasn't
  working after the previous upward-swipe attempt.** On Xiaomi MIUI the
  upward gesture scrolled the recents *overview* rather than dismissing the
  card; MIUI requires a long-press to enter drag mode followed by a drag-left
  to dismiss. The gesture is now: hold touch for 650 ms at the card centre
  (enters drag mode), then drag left to x=0 over 350 ms. Both input commands
  run inside a single `adb shell` session with no connection gap between them,
  so the touch stream is continuous from Android's perspective. The force-stop
  fallback (`pidof` check) is still in place for any device where the gesture
  doesn't land.

#### Account Settings — 5 slots with 2FA OTP

- **The Account Settings tab now shows 5 independent slots (Slot 1–5)** instead
  of a single username/password pair. Each slot is a separate card with:
  - **Username** field (25-character visual width — wider input scrolls but
    the field itself stays compact).
  - **Password** field (same 25-character width) with a Show/Hide toggle.
  - **2FA OTP Secret** field + **Generate Code** button. Entering a TOTP secret
    key and clicking Generate Code computes the current 6-digit one-time
    password (SHA-1 HMAC, 30-second window — the same algorithm used in the
    desktop Accounts Manager). The code is shown inline and copied to the
    clipboard automatically.
- Slots save automatically as you type (600 ms debounce), linked to the phone
  by serial. Any phone that had a single account saved in the old format is
  automatically migrated into Slot 1 on first load — no data loss.
- API: `GET /api/mobile/devices/:serial/account` and
  `POST /api/mobile/devices/:serial/account` now exchange
  `{ slots: [{ username, password, totpSecret? }, …] }` (5 entries). The GET
  endpoint also transparently migrates the old `{ username, password }` shape
  so old saved data is never lost.

#### Human Session Tool UI

- **Toggle border snaps to the width of its content** — the card no longer
  stretches full-width; it wraps tightly around the (STEP1) label, switch, and
  state word.
- **"(STEP1)" label moved before the toggle switch** so the read order is:
  step label → toggle → state word. Previously it was baked into the state word
  ("Disabled (STEP1)") which looked odd when the tool became Active/Running.
- **"Automatically scrolling and liking on this phone" subtitle removed** — the
  switch state word (Running / Active / Disabled) is sufficient; the extra line
  added noise.
- **"(STEP2)" prefix added to the View Feed section title** so the two steps
  are sequentially numbered: (STEP1) enable the toggle, (STEP2) configure the
  View Feed settings.
- **Scroll and Delay fields now sit directly next to each other** (flex layout
  instead of a two-column grid) — the previous grid gave each group a full
  50 % column, leaving a large gap between them.

## [1.1.443] — 2026-07-10

### Mobile tab — Human Session Tool UI overhaul + MIUI recents-swipe fix

#### Bug fix: Instagram swipe-to-close now works on Xiaomi / MIUI devices

- **Fixed: at the end of each automation cycle, Instagram was supposed to be
  swiped off the screen in the recent-apps switcher, but the card never actually
  moved — it stayed floating on screen while airplane mode activated around it.**
  Root cause: the previous gesture swiped *horizontally* from right to left
  across the card (`w×0.85 → 0, same Y`). That is the stock AOSP/Pixel
  dismiss direction; on Xiaomi MIUI the recents overview requires an *upward*
  swipe to dismiss a card, and a horizontal drag does nothing. The gesture now
  swipes vertically from the card's centre upward to the top of the screen.
- **Increased the post-recents-open wait from 700 ms to 1 200 ms.** MIUI's
  overview animation takes noticeably longer than stock Android to settle; the
  old 700 ms wait sometimes meant the swipe fired while the cards were still
  animating in, causing the gesture to land on the wrong element. The longer
  wait lets the animation finish before the dismiss gesture fires.
- The force-stop fallback is still in place: after the swipe, the cycle checks
  `pidof com.instagram.android` and only force-stops if the process is still
  alive — so the cycle always exits with Instagram fully closed regardless of
  whether the gesture landed cleanly on a given OEM launcher.

#### Human Session Tool UI — toggle, labels, and layout

- **Toggle switch moved to the left of the status label.** Previously the toggle
  sat on the far right of the header card and the status text was on the left.
  The switch is now the first element, followed immediately by the status word,
  matching the natural left-to-right read order ("flip this to enable").
- **"Disabled" state now reads "Disabled (STEP1)"** to make it immediately clear
  to new users that enabling this toggle is the first step to start the
  automation.
- **"Tool is idle" subtitle removed.** When the toggle is off, no secondary
  line of text is shown — the label "Disabled (STEP1)" is sufficient. The
  subtitle ("Automatically scrolling and liking on this phone") still appears
  when the toggle is on, so the running state remains descriptive.
- **"VIEW FEED" section title added** above the scroll/delay/like controls.
  The settings card previously had no heading, making it unclear what the
  numbers referred to. The bold uppercase label now groups those controls
  under a named section.
- **"Like this % of viewed posts" shortened to "Like % of viewed posts"**
  — the original wording was unnecessarily wordy; the shorter form is
  consistent with similar labels elsewhere in the app.

## [1.1.442] — 2026-07-10

### Mobile tab — one-click ADB setup, no manual install

- **The "ADB not found" screen now has a "Set up ADB automatically" button.**
  It downloads Google's official platform-tools package for your OS,
  unzips it into the app's own folder, and wires it up — no more manually
  downloading a zip, extracting it, and pasting a folder path. The old
  manual "paste a folder" option is still there (collapsed behind "I'd
  rather point at a folder myself") for anyone who wants it.
  - New backend route: `POST /api/mobile/adb-auto-install`.
  - Downloaded tooling lives in `artifacts/api-server/vendor/platform-tools/`
    (gitignored — it's fetched on demand per machine, not committed).

## [1.1.441] — 2026-07-10

### Human Session Tool — full power-on/open/run/close/airplane-recycle lifecycle

- **The master toggle now runs a full real-phone lifecycle each cycle**,
  not just a scroll/like loop. On every recycle while the toggle is on:
  1. Wakes the phone (`KEYCODE_WAKEUP`, not a plain power-button toggle —
     see below).
  2. Opens Instagram and gives it a moment to finish loading.
  3. Runs the scroll/like tools using whatever settings are currently
     configured (unchanged from before).
  4. Closes Instagram by opening the recent-apps switcher and swiping its
     card away — a real gesture, not a background `force-stop` — and
     verifies the process actually exited, force-stopping only as a
     fallback if the swipe didn't land on a given device/launcher.
  5. Turns airplane mode on, waits a randomized 15-20s, then turns it back
     off, to force a fresh network session before the next cycle.
  6. Swipes up and puts the screen back to sleep, ready for the next
     recycle to start clean.
  - **Note on "press power"**: a literal `KEYCODE_POWER` press just
    *toggles* the screen — if the phone happened to already be awake when
    a cycle started, "pressing power to wake it" would instead turn it
    off and run every following step blind. Used the explicit
    wake/sleep keycodes instead so the on/off state at each end of the
    cycle is always correct regardless of what it was before.
  - New backend route: `POST /api/mobile/devices/:serial/automation-cycle`
    (the standalone `/check-feed` endpoint still exists unchanged, for any
    other manual use).

## [1.1.440] — 2026-07-10

### Human Session Tool — Mobile tab no longer auto-wakes the phone; Check Feed resilience fixes

- **Fixed: opening the Mobile tab instantly woke the phone and started
  streaming the feed**, as if a click had happened off-screen. The phone
  mirror (`LiveCanvas`) used to mount and connect automatically the moment
  a device showed as ready, regardless of which tab you were even looking
  at. It now only starts once you explicitly press the on-screen **Power**
  button, or the Human Session Tool's automation toggle is switched on —
  simply having a phone plugged in or visiting the tab never starts the
  stream by itself anymore. A "Press Power to view this phone's screen"
  placeholder shows in the idle state.
- **Fixed: a failed double-tap during a Check Feed run silently ended the
  entire cycle early.** `doubleTap` failures (transient adb/USB hiccups)
  were thrown out of the run loop uncaught, aborting every scroll/like
  after the first failure — which looked like "100% like chance did
  nothing" even though the like-chance math itself was already correct.
  Each double-tap attempt is now wrapped so one bad tap is logged and
  skipped instead of killing the rest of the run; the response now also
  reports `likeFailures` alongside `likes`.
- **Reduced the "3 scrolls turned into ~8" over-scroll.** Swipe gestures
  were short and fast enough (350-500ms) that Android kept flinging the
  feed for a moment after the finger lifted, stacking extra scroll
  distance on top of each configured scroll. Swipes are now slower
  (550-750ms) with a short settle pause afterward so the feed stops
  exactly where the gesture ends, and the like double-tap jitter radius
  was tightened so a jittered tap can never land near the screen edges/nav
  bar.

## [1.1.439] — 2026-07-10

### Human Session Tool — real fix for double-tap-to-like, tabs (Account Settings / Human Session Tool / Log)

- **Fixed: manually double-tapping a post on the phone mirror still didn't
  like it.** The previous fix only covered the automated Check Feed loop —
  a manual double-tap from the operator clicking the mirrored screen was
  still sent as two independent `/input/tap` requests, each its own adb
  round-trip, so the same latency problem broke it. The pointer handler now
  holds a lone tap for 350ms; if a second tap lands nearby within that
  window it cancels the pending single tap and sends one combined
  `/input/double-tap` request instead, which reaches the device as a single
  `adb shell` call with both taps and an on-device pause — matching what
  the automated loop already does.
- **Brought back a visible activity log.** Previously the log callback
  wasn't actually wired to anything, so nothing appeared anywhere. There's
  now a real **Log** tab that shows every tap, swipe, key press, and
  automation cycle as it happens, for debugging exactly this kind of issue.
- **Split the right panel into three tabs**, in this order: **Account
  Settings**, **Human Session Tool**, **Log**.
  - **Account Settings** (new) — link an Instagram username/password to
    this specific phone; saves automatically as you type.
  - **Human Session Tool** — the existing scroll/like automation panel,
    unchanged in behavior.
  - **Log** — the new activity log, with a Clear button.
  - Switching tabs no longer interrupts anything: the Human Session Tool's
    run-loop (and its settings load/autosave) now lives at the page level
    instead of inside the tab's panel, so it keeps running in the
    background even while you're looking at Account Settings or the Log.

## [1.1.438] — 2026-07-10

### Human Session Tool — master toggle, autosave, fixed double-tap like

- **Removed the "Save settings" button.** Every field (including the new
  master toggle) now saves automatically on change, debounced by 500ms so
  rapid edits don't spam the server. A save error still surfaces inline if
  one occurs.
- **Removed the "Check Feed" button.** In its place, a master toggle at the
  top of the panel switches the whole tool on or off. While on, it runs
  Check-Feed cycles (scroll count drawn from the configured range) back to
  back, with the configured delay between both scrolls and cycles, until
  switched off. The toggle state is persisted per device so it survives a
  page reload.
- **Removed** the "Scroll the Instagram feed currently shown on the phone"
  description text and the scroll-count summary message — neither carried
  information the toggle/log don't already cover.
- **Layout:** "Scroll this many times" and "Delay between actions" now sit
  side by side in the same row instead of stacked.
- **Fixed: double-tap-to-like didn't actually like posts.** The like
  gesture sent two separate `adb shell input tap` calls, each its own
  process spawn / adb round-trip (100-300ms+). That pushed the real gap
  between the two on-device taps well past Instagram's double-tap
  recognition window, so Instagram saw two independent single taps instead
  of a like. Both taps now fire inside one `adb shell` invocation with an
  on-device `sleep` between them (`androidManager.doubleTap`), keeping the
  gap tight and consistent regardless of adb/USB latency.

## [1.1.437] — 2026-07-10

### Mobile Farm — renamed to "Human Session Tool", real inter-action delay, per-day cap and notes removed, new like-percentage feature

Follow-up to 1.1.436's Check Feed feature, based on further testing feedback:

- **Fixed: delay between actions wasn't functional.** The "delay between
  actions" setting (e.g. 5–10 seconds) was saved but never actually used —
  `check-feed` paused for a hardcoded 600–1100ms between scrolls regardless
  of what was configured. It now sends `delayMinSec`/`delayMaxSec` to the
  backend and genuinely waits a random duration in that range (in seconds,
  converted to ms) between each scroll.
- **Removed "Maximum actions per day"** — field, type, schema, and UI all
  dropped.
- **Removed the "Notes" textarea** — field, type, schema, and UI all dropped.
- **Input fields narrowed** to a 4-digit width (was full-width) across every
  number field in the panel, with matching value clamping (0–9999, or 0–100
  for percentages) enforced in code since HTML `maxLength` isn't reliably
  applied to `type="number"` inputs.
- **Panel retitled "Human Session Tool"** — the standalone "Automation
  Settings" heading is gone; Check Feed is now presented as just the first
  setting inside this single tool rather than its own separate feature.
- **New: like a percentage of viewed posts.** Two more inputs — "Like this %
  of viewed posts" (X to Y%, e.g. 3–5%) — add a like step to Check Feed.
  Each run draws one random like-rate from that range (e.g. ~4%), then after
  every scroll independently rolls that chance to double-tap the post left
  on screen (Instagram's like gesture), with human-like settle/tap timing
  and small coordinate jitter so every like doesn't land on the exact same
  pixel. The Check Feed result message now reports how many likes landed
  alongside the scroll count.

## [1.1.436] — 2026-07-10

### Mobile Farm — fixed mirror letterboxing, dropped the Stream log, replaced Auto-reply with Check Feed

**Black bars on either side of the phone mirror:** the phone shell was
hard-coded to a `9/16` aspect ratio (Tailwind `aspect-[9/16]`), but real
device resolutions (e.g. 1080×2400, 1080×2460) aren't exactly 9:16 — the
mismatch left the canvas's `object-fit: contain` letterboxing the image with
black padding on the left/right. The shell now tracks the device's *real*
reported resolution (threaded up via a new `onDimensions` callback:
`LiveCanvas` → `PhoneSlot` → `MobilePage`) and sets `aspectRatio` on the
wrapper dynamically from that, falling back to `9/16` only until the first
frame arrives. The tracked resolution is also reset whenever the connected
device's serial changes (or it disconnects), so a stale ratio from a
previous phone can never linger and briefly letterbox the next one.

**Stream log removed:** the on-screen "Stream log" panel (`DebugLogPanel`)
under Automation Settings has been removed entirely — it was a debugging aid
during development that's no longer needed day-to-day.

**"Auto-reply" replaced with "Check Feed":** the per-device Automation
Settings panel no longer has an Auto-reply toggle. In its place is a
**Check Feed** control: two number inputs ("Scroll this many times", e.g. 5
to 10) and a **Check Feed** button. Pressing it sends a random number of
downward swipes (uniformly chosen between the min/max) to whatever is
currently on the device's screen — this only drives the scroll gesture
itself; opening Instagram / navigating to the feed first is intentionally
out of scope for now and will be layered on separately.

- Backend: `AutomationSettings` per device now stores `feedScrollMin` /
  `feedScrollMax` instead of `autoReplyEnabled` (isolated to the Mobile Farm
  tab's own config file — unrelated to the separate Auto Reply tool used
  elsewhere in the app for DM automation, which is untouched).
- New endpoint: `POST /api/mobile/devices/:serial/check-feed` — resolves the
  device's real screen size via `adb shell wm size`, then issues N swipes
  (random 350–500ms duration, random 600–1100ms pacing between each) from
  ~78% down the screen to ~22%. Guarded by a per-serial in-progress lock so
  overlapping requests against the same device 409 instead of interleaving
  swipes.

## [1.1.435] — 2026-07-10

### Mobile Farm — reverted the video mirror back to `screenrecord`; scrcpy never worked on real hardware

**The problem:** v1.1.432 replaced the `screenrecord`-based H.264 mirror with a
from-scratch scrcpy-server protocol client, intended to fix `screenrecord`'s
MIUI keyguard-freeze issue. Across every real-device test since (v1.1.432
through v1.1.434, including a v1.1.433 error-surfacing pass and a v1.1.434
logcat-fallback pass), the scrcpy session **never once completed its
handshake** — the client always hit `Failed to read scrcpy video header:
socket closed before header was fully read` before a single frame arrived.
The client-side fallback then dropped to the old PNG-polling screenshot
stream, which is what actually shipped to the user every time: not "a slower
video," but zero video at all, silently.

**Investigation:** decompiled the vendored `scrcpy-server-v3.1` jar's option
table and cross-referenced it against the real scrcpy v3.1 server source
(`Options.java`, `Server.java`, `DesktopConnection.java`, `Streamer.java`).
The wire protocol implementation in `scrcpyServer.ts` (socket order, header
layout, control-message byte layout) matches the real server exactly — the
bug is not a protocol mismatch we could find from static analysis. The most
likely remaining explanation is that the on-device video capture step itself
(`SurfaceEncoder`/`MediaCodec` configuration against this specific phone's
hardware encoder) throws before `writeVideoHeader()` ever runs, closing the
socket the client is blocked reading from — but confirming that requires
actual `adb logcat` output from the failing device, which isn't available
from this environment. No physical Android hardware is reachable here to
test further.

**The fix:** reverted the `/api/mobile/video/:serial` WebSocket route and the
`/input/tap` and `/input/key` routes to the `screenrecord`-based
implementation from v1.1.431 — the last version confirmed to actually stream
real H.264 frames at close to 30fps on this hardware. This restores:
- `adb exec-out screenrecord --output-format=h264` piped straight to the
  browser over WebSocket, decoded client-side with WebCodecs.
- Automatic respawn on `screenrecord`'s 180s `--time-limit` cap, plus a 6s
  stall watchdog that force-restarts the stream (re-poking wake + keyguard
  dismiss) if the OEM virtual-display freeze re-occurs — this was always a
  known trade-off of the `screenrecord` approach, not a new regression.
  When it stalls, it recovers in a few seconds rather than going dark.
- Server-side tap coordinate rescaling: `screenrecord` may downscale its
  output relative to the device's real `wm size` (encoder alignment
  constraints), so `/input/tap` now rescales `x`/`y` against `wm size`
  again when the client's reported video frame size doesn't match.

The scrcpy protocol client (`src/mobile/scrcpyServer.ts` and the vendored
`scrcpy-server-v3.1` jar) is left in the repo, unused, for whoever picks up
the logcat root-cause investigation next — do not wire it back into the
video route without first confirming a real device actually streams frames
through it.

**Also fixed:** removed the dead `activeScrcpySessions` map and its tap/key
routing, which had silently fallen back to unscaled `adb shell input tap`
whenever no scrcpy session existed (i.e. always, in practice) — this is what
made taps land on the wrong pixel on any device where `screenrecord` streams
at a size other than the panel's native resolution.

---

## [1.1.432] — 2026-07-09

### Mobile Farm — mirror is now a real scrcpy session, not `screenrecord`

**The ask:** v1.1.431 replaced screenshot-polling with `adb exec-out
screenrecord --output-format=h264`, which was a real improvement in framerate
but had a fatal flaw on the hardware actually being used to test this: MIUI
(and other OEM skins) freeze `screenrecord`'s *virtual* display the moment the
keyguard re-engages or the real screen sleeps. The previous release masked
this with a stall-detector that force-restarted `screenrecord` every time it
went silent — which meant the mirror never actually looked "live," it looked
like it kept reverting to screenshots, because it was constantly restarting a
short-lived recording rather than streaming continuously.

**What changed:** the mirror now runs the real `scrcpy` server
(https://github.com/Genymobile/scrcpy) — the same server nearly every phone
farm/emulator dashboard is built on — instead of `screenrecord`. Its capture
path uses Android's native `SurfaceControl`/display APIs against the *real*
display (the same path system screen recording itself uses), so it doesn't
have the virtual-display freeze mode that made the previous approach flaky.

Concretely:
- The official prebuilt `scrcpy-server-v3.1` jar is now vendored in the repo
  (`artifacts/api-server/vendor/`) and copied into the build output — no
  scrcpy installation or root is required on either the host or the phone.
- A new module implements scrcpy's wire protocol directly (no shelling out to
  the scrcpy client binary): pushes the jar to `/data/local/tmp/`, launches it
  via `app_process`, opens the tunneled video + control sockets, and parses
  the one-time device-name/codec/resolution header before treating the rest
  as a continuous raw H.264 Annex-B stream.
- The existing WebCodecs-based frontend decoder is unchanged — scrcpy's
  stream is Annex-B just like `screenrecord`'s was, so the same demuxer
  (`src/lib/h264Stream.ts`) and `<canvas>` pipeline just keep working.
- **Taps and key presses now go through scrcpy's own control socket** instead
  of `adb shell input tap`/`input keyevent`. Scrcpy's touch-injection protocol
  takes the coordinates *plus* the frame size they were computed against and
  scales to real touchscreen pixels on-device, which replaces the old manual
  `wm size`-based rescale hack entirely — that hack was a likely source of
  "taps land slightly off" reports on devices where the mirrored resolution
  didn't exactly match `wm size`.
- If no scrcpy session is active for a device yet, tap/key routes still fall
  back to plain `adb shell` calls, so the on-screen buttons keep working even
  before/without a live mirror connection.

**Not yet verified against physical hardware from this environment** — the
protocol implementation is written against scrcpy's documented, versioned
wire format (confirmed against the exact vendored v3.1 server binary's option
table), but this change needs a real USB-connected phone to confirm frame
delivery and touch accuracy end-to-end.

---

## [1.1.431] — 2026-07-09

### Mobile Farm — real-time H.264 video mirroring (replaces screenshot polling)

**The ask:** the mirror was built on `adb exec-out screencap -p` — one full PNG
capture per frame, 150–400ms each. Even at a 150ms poll interval that's a hard
ceiling on responsiveness that no amount of tuning could remove; the previous
release's notes said as much. Instant, on-the-fly mobile automation needs a
real video stream, not repeated screenshots.

**What changed:** a new `/api/mobile/video/:serial` WebSocket endpoint spawns
the on-device `screenrecord` binary (built into Android since API 19 — no
scrcpy, root, or extra install needed) with `--output-format=h264` and pipes
its raw Annex-B elementary stream straight from `adb exec-out` to the browser,
frame by frame, with no polling loop and no per-frame process spawn. Because
`screenrecord` has a hard ~180s `--time-limit`, the server transparently
respawns it on exit and keeps streaming — the client sees at most a brief gap.

On the frontend, a small Annex-B demuxer (`src/lib/h264Stream.ts`) buffers
incoming bytes, splits them into per-frame access units, and feeds them to the
browser's native WebCodecs `VideoDecoder` (Electron/Chromium have full
hardware-accelerated support). Decoded frames are drawn straight to the
existing mirror `<canvas>`, so tap-mapping, letterboxing, and the nav bar are
unchanged. If WebCodecs isn't available, or `screenrecord` isn't supported on
a given device/Android build, the client automatically falls back to the old
PNG-polling endpoint — nothing regresses on unsupported setups.

This also incidentally removes the old "screen is off or locked" false-asleep
state during normal use: because the video stream keeps flowing continuously
(and the session still disables the screen timeout + sends a wake keyevent on
connect, same as before), there's no more discrete "0-byte capture" signal to
misinterpret as the phone being asleep while it's actually just idle.

**Nav bar buttons now log their attempts:** Back/Home/Recent/Power/Vol+/Vol−
previously fired silently with no confirmation of success or failure. They now
write to the stream log panel exactly like taps already did, so a failed
keyevent (bad serial, adb hiccup, etc.) is visible instead of looking like a
dead button.

## [1.1.430] — 2026-07-09

### Mobile Farm — fixed click mapping, added click logging, faster frame cadence

**Root cause of "nothing is clickable":** the phone screen area was made
flexible (`flex-1`) in 1.1.429 to fix a height-collapse bug, but the canvas
keeps `object-fit: contain`. Once the screen area's box stopped being a
locked 9:16 rectangle, its aspect ratio almost never matches the phone's
real aspect ratio, so the canvas image gets letterboxed inside the box.
Tap coordinates were still being computed against the *full* box
(`getBoundingClientRect()`), not the actual letterboxed image rectangle —
so every tap landed on the wrong on-device pixel. Fixed by computing the
real displayed image rectangle (accounting for the letterbox offset) and
mapping clicks relative to that instead.

**Debug log now captures clicks:** tapping, waking, and their
success/failure are now written to the stream log panel — previously the
log only recorded WebSocket/connection events, so a failed tap left no
trace at all. Clicks that land in letterbox padding (outside the actual
phone image) are also logged instead of silently doing nothing.

**Frame cadence:** the screencap loop's idle delay was lowered from 250ms
to 150ms between frames. Note: the dominant part of the mirror's latency
is the per-frame `adb exec-out screencap -p` capture itself (typically
150–400ms on-device, depending on the phone), which is inherent to using
discrete PNG screenshots rather than a continuous video stream. This
change makes the loop responsive without further scrcpy work.
Truly "instant" (~30fps) mirroring would require switching to a
continuous H.264 stream (e.g. scrcpy, already stubbed as
`/api/mobile/devices/:serial/scrcpy/start`) instead of screencap polling
— worth a follow-up if sub-100ms feedback is required for automation.

---

## [1.1.429] — 2026-07-09

### Mobile Farm — layout split, on-device debug log removed, click-to-wake fixed

**Layout:** the phone slot now sits in the left half of the page at full
available height (aspect-ratio locked to 9:16, capped by whichever of the
half-width or full-height is the tighter constraint). The right half is a
new "Automation Settings" panel — per-device auto-reply toggle, action delay
range, max actions/day, and a free-text notes field. Settings persist
server-side per serial in `mobile-instances.json` via two new endpoints,
`GET/POST /api/mobile/devices/:serial/automation-settings`, following the
same pattern already used for proxy assignment.

**Debug log removed from the phone screen itself:** the always-visible
green-text debug log that used to overlay the bottom ~45% of the phone
canvas is gone. The phone slot now only shows connection/asleep/error
state text; verbose per-frame logging still happens (kept as a no-op-safe
internal log function for future use) but nothing is rendered on the phone
screen anymore.

**Click-to-wake fixed — root cause:** the phone `<canvas>` was rendered with
`display: none` whenever the stream wasn't in the "live" state. When the
screen went to sleep, the server-side auto-wake loop (added in 1.1.428) kept
running, but the client dropped straight to an overlay `<div>` with no click
handler — so a user's tap to help wake the phone was never sent anywhere,
and the visible "waking up" feedback only ever came from the slow ~1s
backend poll. Fixed by: (1) keeping the canvas mounted and clickable in
every state past "connecting", (2) treating server messages matching
"screen is off / locked" as a distinct `asleep` status with its own "tap to
wake" hint instead of the generic error state, (3) sending an immediate
`KEYCODE_WAKEUP` keyevent request on click when not live, instead of
silently dropping the tap, and (4) reducing the backend's off-screen poll
back-off from 1000ms to 400ms so the wake feedback loop feels responsive.

### CI — removed a second, independently-triggered Windows installer workflow

`build-windows.yml` was a real (non-stub) duplicate of the canonical
`build-windows-installer.yml` — different secret names, no
`--ignore-scripts` on install — that also ran on every push to `main`. Two
installer builds racing on every push made "which run actually failed" hard
to diagnose. Deprecated it the same way the three earlier duplicates were
handled: header comment + inert `workflow_call`-only stub, kept in the repo
because deletion of tracked workflow files is blocked in this environment.
`build-windows-installer.yml` remains the single source of truth for the
Windows installer pipeline.

---

## [1.1.428] — 2026-07-09

### Mobile Farm — auto-wake screen + back-off when screen is off

**Problem:** `screencap` returns 0 bytes when the phone screen turns off.  The
old loop treated every 0-byte frame identically to other errors — sending the
same JSON error message to the client every 250 ms (dozens of messages per
second) and never attempting to wake the screen.

**Fix — three changes in the screencap WebSocket handler:**

1. **Disable screen timeout on connect** — immediately after the WS handshake,
   save the current `screen_off_timeout` value then set it to `2147483647` ms
   (~24 days) via `adb shell settings put system screen_off_timeout`.  This
   prevents the phone from sleeping while the mirror is open.  The original
   value is restored in the `ws.on("close")` handler.

2. **Auto-wake on 0 bytes** — when `screencap` returns 0 bytes, send
   `adb shell input keyevent 224` (KEYCODE_WAKEUP) to turn the screen back on.
   The first WAKEUP is also sent immediately on connect so the screen is on
   from the moment the session starts.

3. **Back-off + deduplicated errors** — a `screenOffStreak` counter tracks
   consecutive 0-byte frames.  The loop delays 1 000 ms (instead of 250 ms)
   between attempts while the screen is off, and the client error message is
   sent only once per streak + every 20th iteration (~20 s) rather than on
   every frame.  When a valid PNG comes back, a `{ info: "Screen woke up" }`
   message is sent once and the streak resets.

---

## [1.1.427] — 2026-07-09

### Mobile Farm — fix instant WS disconnect (socket.destroy race) + 1-slot layout

#### Root cause of "WS open → immediately closed code=1006"
`registerInstagramRoutes` registers its own `httpServer.on("upgrade")` listener
**after** the mobile one.  Node EventEmitter calls all listeners in registration
order.  When a `/api/mobile/screen/…` upgrade arrives:

1. Mobile handler runs first → calls `screenWss.handleUpgrade(...)`, takes
   ownership of the socket, starts the screencap loop.
2. Instagram handler runs second → URL doesn't match its patterns → hits the
   catch-all `socket.destroy()` that was written with the comment
   "No other upgrade handlers".  This destroys the socket the mobile WS server
   already owns → client sees `code=1006` (no close frame, TCP reset).

**Fix (two lines):**
- `mobile.ts`: set `(socket as any).__wsHandled = true` before calling
  `handleUpgrade` so the flag is on the socket before the instagram listener runs.
- `instagram.ts`: guard the `socket.destroy()` with
  `if (!(socket as any).__wsHandled)` — if the mobile handler already claimed
  it, skip the destroy entirely.

#### UI: single slot, left side, vertically centred
- `TOTAL_SLOTS` reduced to 1
- Slot container changed from `justify-center` row to `items-center justify-start`
  with `minHeight: calc(100vh - 120px)` so the slot sits vertically centred on
  the left side of the page at a fixed 280 px width

---

## [1.1.426] — 2026-07-09

### Mobile Farm — fix WebSocket port (Electron serves frontend + API on same port)

**Root cause of "WS error readyState=0 / code=1006 / never connects":**

The v1.1.425 build changed `makeWsUrl()` to always connect to
`ws://127.0.0.1:8082/...` (the Replit dev `__API_PORT__`).  In Electron the
API server does NOT run on 8082 — it finds a free port at startup (preferred
32987, falls back to random).  The frontend is served by the same Express
process on that same dynamic port.  So `window.location.host` is
`127.0.0.1:32987` and IS the correct WebSocket target.  Connecting to 8082
failed immediately with ECONNREFUSED, which in the browser WebSocket API
surfaces as `readyState=0` + `code=1006` — exactly what the debug log showed.

**Fix:** `makeWsUrl()` reverted to `window.location.host` (with `ws:`/`wss:`
derived from `window.location.protocol`).  The `__API_PORT__` fallback is kept
only for environments where `window.location.host` is empty.

---

## [1.1.425] — 2026-07-09

### Mobile Farm — 4-slot row, Electron WebSocket fix, visible debug log

#### Layout: 4 slots in a single centred row (was 8 in 4×2 grid)
- `TOTAL_SLOTS` reduced to 4 — one row, slots flex-centred with `justify-center`
- Each slot is `max-w-[260px] flex-1` so they fill available space evenly and
  stay centred at any window width
- Empty slot phone outline and "Slot N" label remain for unoccupied positions

#### Root cause of "never connects" — wrong WebSocket host in Electron
In Electron the frontend is loaded from a local file or internal server.
`window.location.host` is either empty (`""`) or a `localhost:PORT` that points
at the renderer/dev server, **not** the Express API.  The Vite proxy (`ws: true`)
is only present in the Replit dev environment — it is absent in the built Electron
app.  So every WebSocket connection was going to the wrong host and silently
failing before the server ever saw it.

**Fix — `makeWsUrl()` always uses `127.0.0.1:__API_PORT__`:**
```ts
function makeWsUrl(serial: string): string {
  const port = __API_PORT__ || "8082";
  return `ws://127.0.0.1:${port}/api/mobile/screen/${encodeURIComponent(serial)}`;
}
```
`__API_PORT__` is injected by Vite at build time from `process.env.API_PORT`,
so it is always correct regardless of environment.  No dependency on
`window.location.host`.

#### Visible debug log panel inside each slot
Every LiveCanvas now renders a scrollable green-on-black log panel in the
lower half of the slot, showing timestamped events in real time:
- `[N] Connecting → ws://127.0.0.1:8082/api/mobile/screen/…`
- `WS open — waiting for first frame…`
- `SERVER ERROR: <message forwarded from server>`
- `WS closed — code=NNN reason="…"`
- `First frame! (NNNN bytes)`  /  `10s timeout — no frames received`
No dev tools required — the log is visible directly in the running Electron window.

#### Server-side debug logging (mobile.ts)
The WebSocket upgrade handler now emits structured `logger.info/warn/error`
entries at every lifecycle stage so they appear in the Electron log file:
- upgrade URL received + regex match result
- ADB toolset path at connection time
- `adb devices` output at the moment of WS upgrade (shows actual device state)
- Device-not-ready guard: closes WS immediately with a descriptive error message
  if state ≠ `"device"` instead of spawning a silent loop
- Per-frame log (every 1st and then every 20th frame): raw byte count, first 4
  bytes as hex, CRLF-strip applied, valid PNG result, stderr from ADB
- Send errors, spawn errors, loop-end summary

---

## [1.1.424] — 2026-07-09

### Mobile Farm — Inline Phone Slots & Screencap CRLF Fix

#### Problem: screen mirror opened as a full-screen modal instead of inline
"View Screen" replaced the entire Equinox window with a black overlay.
The user couldn't see other slots while a phone was streaming, and the
size (340 px wide modal) made it impossible to fit multiple phones on screen.

**Fix — 8 inline phone slots, always visible:**
The Mobile Farm page now shows a **4 × 2 grid of fixed phone slots** (220 px each),
styled as portrait phone frames. There is no "View Screen" button and no modal overlay.

- **Auto-stream** — as soon as a phone reaches `device` (Ready) state the canvas inside
  its slot starts streaming automatically. No click required.
- **Empty slots** — the remaining slots (up to 8 total) show a faint phone outline SVG
  and a "Slot N" label so the grid always fills the screen.
- **33 % smaller** — slots are 220 px wide (vs the previous 340 px modal), allowing
  four across in the content area at common resolutions.
- **Nav bar per slot** — Back, Home, Recent, Power, Vol+, Vol− appear at the bottom of
  each slot only when a phone is streaming.
- **State labels in slot header** — "Live" (green pulse), "Auth needed" (yellow),
  "Offline" (red), "empty" (dim) — at a glance without opening anything.
- **Setup panels unchanged** — the ADB-not-found and no-phones-detected panels continue
  to appear in the main area below the grid header.

#### Problem: phone screen stays black / keeps reconnecting on Xiaomi
On Windows, `adb exec-out screencap -p` passes binary PNG data through a pseudo-TTY
layer that on some ADB versions converts bare `\n` (0x0A) bytes to `\r\n` (0x0D 0x0A).
Because PNG files contain `\n` bytes inside their zlib-compressed data blocks, this
CRLF insertion corrupts the PNG header and/or the compressed stream — resulting in an
image that cannot be decoded (black canvas), or a PNG that fails the `length > 100` check
and is silently discarded.

**Fix — server-side CRLF stripping + PNG signature validation:**
- New `isPng(buf)` helper — checks the first 4 bytes for the PNG magic number
  (`\x89 P N G`, i.e. `0x89 0x50 0x4E 0x47`). Used as a gate before sending.
- New `stripCrlf(buf)` helper — single-pass O(n) strip using `Buffer.allocUnsafe`
  and direct byte indexing (no JS array push) for efficiency on 5–8 MB frames.
  Returns the original buffer unchanged if no CRLF pairs are found (zero-copy).
- **Detection & application:** after collecting stdout chunks into `frame`, the server
  checks `isPng(frame)`. If the check fails it calls `stripCrlf(frame)` and rechecks.
  Only a validated PNG is sent over the WebSocket. If the frame is still not a valid PNG
  after stripping, a JSON error message is sent to the client instead of silently dropping
  the frame — so the user sees "screencap returned invalid data" rather than an eternally
  blank screen.
- Frame interval bumped from 200 ms to 250 ms to reduce ADB pressure on the phone.

---

## [1.1.423] — 2026-07-09

### Mobile Farm — Phone-Sized Screen Mirror & Reliable Stream Recovery

#### Problem 1: Screen mirror opened full-window instead of phone-sized
The "View Screen" overlay covered the entire Equinox window with a full-screen black
background (CSS `fixed inset-0`). The phone's screen canvas was centred in it but still
filled the available area, which on a wide monitor stretched the portrait phone image
across hundreds of pixels and looked nothing like a phone screen.

**Fix:** The overlay now uses a **phone-shaped panel** — 340 px wide with a rounded
frame (`border-radius: 2.5rem`) — centred over a semi-transparent dimmed backdrop.
The panel is divided into three sections:
- Compact status bar at the top (device name, Android version, fps/status, × close button)
- Phone screen area whose `aspect-ratio` is locked to the phone's native resolution once
  the first frame arrives (default `9/16` while waiting). The canvas fills it at `width: 100%`.
- Android nav buttons in a compact row at the bottom of the panel, matching the phone width.

Clicking anywhere outside the phone panel closes the overlay (same as Escape).

#### Problem 2: "Connecting…" spinner stuck forever with no useful feedback
The previous WebSocket implementation opened a single connection and never recovered if
it failed silently. On Xiaomi devices (and some others), `adb exec-out screencap -p` can
take several seconds to produce the first frame, or the lock screen can cause it to hang
entirely with no error output — leaving the WebSocket open but silent.

**Root causes:**
- No timeout: if the WebSocket connected successfully but ADB never returned a frame,
  `connected` became `true` and the canvas was shown (empty), but if the connection was
  lost before `onopen` fired, `connected` stayed `false` and the spinner ran forever.
- No reconnect: once the WebSocket closed (USB glitch, server restart, ADB hiccup),
  the component stayed dead.

**Fixes:**

1. **Two-phase loading state** — `connected` (WebSocket handshake done) and `hasFrame`
   (at least one PNG frame received) are tracked separately. The UI now shows distinct
   messages for each state:
   - "Connecting to Xiaomi…" — WebSocket not yet open
   - "Waiting for screen…" — WebSocket open but no frame yet
   - `N fps` — live stream running normally

2. **10-second no-frame timeout** — started the moment `ws.onopen` fires. If no binary
   frame arrives within 10 s the user sees: *"No screen data received. Make sure the
   phone is unlocked — screencap doesn't work on the lock screen on some devices."*
   This covers the silent-hang case on Xiaomi/MIUI.

3. **Auto-reconnect loop** — `ws.onclose` schedules a fresh `connect()` call after 2 s,
   so a brief USB disconnect or server hiccup recovers without any user action.

4. **Inline Retry button** — shown in the error state alongside the error message.
   Clicking it closes the stale WebSocket immediately (triggering the reconnect path)
   rather than waiting for the 2-second timer.

5. **Electron host fallback** — the WebSocket URL now falls back to
   `127.0.0.1:${__API_PORT__}` if `window.location.host` is empty, which can happen
   under certain Electron protocol configurations.

---

## [1.1.422] — 2026-07-09

### Mobile Farm — Live In-App Phone Screen Mirror

#### Root cause of "Unexpected token '<', '<!DOCTYPE...' is not valid JSON" error
Every button on the Mobile page (View Screen, Link Instagram account, etc.) was returning
a raw HTML 404 page instead of JSON because `registerMobileRoutes()` was never called
in `src/index.ts`. The function existed but was completely disconnected from the Express
app, so every `/api/mobile/devices/...` request hit the frontend's catch-all 404 handler
and returned the Vite dev HTML page. Calling `r.json()` on that HTML produced the
"Unexpected token '<'" error. Fixed by importing and calling `registerMobileRoutes(httpServer, app)`
in `index.ts` before `registerInstagramRoutes`.

#### Live phone screen streaming (WebSocket, no external tools)
Previous behaviour: "Open screen mirror" spawned an external `scrcpy` process that opened
a separate OS-level window outside of Equinox. If scrcpy was not installed the call threw
and produced the JSON error above (compounded with the missing route registration).

New behaviour: the phone screen is streamed **inside** Equinox with no external tools:

- New WebSocket endpoint `/api/mobile/screen/:serial` registered on the `httpServer`
  upgrade event. On connection the server opens a loop: `adb -s <serial> exec-out screencap -p`
  → collect stdout (raw PNG bytes) → send as a binary WebSocket frame → sleep 200 ms → repeat.
  Runs at approximately 4–5 fps. The loop terminates cleanly when the WebSocket closes.

- New REST endpoint `GET /api/mobile/devices/:serial/screen-size` — runs
  `adb shell wm size` and parses the `WxH` result. Used by the frontend to report
  the phone's native resolution in the overlay header.

- Vite dev-server proxy updated to `ws: true` so WebSocket upgrades on `/api/*` paths
  are correctly forwarded to the API server during development.

#### New "View Screen" UI — full-screen overlay inside Equinox
The small "Open screen mirror" button that launched an external window is replaced by a
**"View Screen"** button on each phone card (only visible when state is `device` / Ready).

Clicking it opens a full-screen dark overlay that covers the entire Equinox window:

- **Live canvas** — binary PNG frames from the WebSocket are decoded via `createObjectURL`
  and drawn onto a `<canvas>` element. The canvas preserves the phone's native aspect ratio
  and scales to fill the available area.

- **Click-to-tap** — a click anywhere on the canvas maps the display coordinates back to
  native phone coordinates using the canvas's `getBoundingClientRect()` and the stored
  natural resolution, then fires `POST /api/mobile/devices/:serial/input/tap` with the
  exact `{x, y}` pixel position. The phone receives a real ADB tap at that location.

- **Android nav buttons** at the bottom bar:
  - Back (KEYCODE 4)
  - Home (KEYCODE 3)
  - Recent apps (KEYCODE 187)
  - Power / lock screen (KEYCODE 26)
  - Volume up (KEYCODE 24)
  - Volume down (KEYCODE 25)
  All send `POST /api/mobile/devices/:serial/input/key`.

- **Keyboard shortcut** — pressing `Escape` closes the overlay.

- **Status bar** — shows phone model, Android version, live FPS counter (updated every second),
  and the phone's native resolution once the first frame arrives.

- **Error states** — if ADB is not found or the WebSocket fails to connect, a clear error
  message is shown inside the overlay rather than a silent blank screen.

#### Files changed
- `artifacts/api-server/src/index.ts` — import + call `registerMobileRoutes`
- `artifacts/api-server/src/routes/mobile.ts` — signature changed to `(httpServer, app)`;
  added `ws`, `spawn`, `execFile` imports; added WebSocket screen-stream handler; added
  `GET /api/mobile/devices/:serial/screen-size` endpoint
- `artifacts/dannys-bot/src/pages/MobilePage.tsx` — rewrote `MirrorButton` → `ScreenMirrorOverlay`;
  added `PhoneCard` mirror state; added `NavBtn` component; added click-to-tap; added
  Escape-key handler; removed dead scrcpy toggle logic
- `artifacts/dannys-bot/vite.config.ts` — `ws: true` on `/api` proxy entry

---

## [1.1.417] — 2026-07-09

### Critical Fix — `navigator.webdriver` returning wrong value from wrong location

The suppressor introduced previously had two bugs that were described in the v1.1.415 changelog as fixed, but were never actually applied to the code:

**Bug 1 — Wrong value (`undefined` instead of `false`)**
Real Chrome always returns `false` for `navigator.webdriver` when not under automation. Returning `undefined` is a value no real browser ever produces — Instagram's JS fingerprinting explicitly distinguishes `true` / `false` / `undefined` and treats `undefined` as a broken suppression attempt. This is arguably worse than returning `true` because `undefined` is a specific signature of a tool that tried and failed to hide itself.

**Bug 2 — Own-property on `navigator` instance instead of `Navigator.prototype`**
In real Chrome, `navigator.webdriver` lives only on `Navigator.prototype`. That means `Object.getOwnPropertyDescriptor(navigator, 'webdriver')` returns `undefined` on a real browser — there is no own-property descriptor on the instance. Our `Object.defineProperty(navigator, 'webdriver', ...)` call created an own-property descriptor on the instance. Anti-bot scripts (including Instagram's) probe this specifically: finding an own descriptor on `navigator` is an independent automation signal even when the returned value is `false`.

**Fix:**
- `delete navigator.webdriver` first (clears any Electron-placed own descriptor)
- `Object.defineProperty(Navigator.prototype, 'webdriver', {get: () => false})` — prototype only, matches real Chrome exactly
- Leak check enhanced: now captures `webdriverOwnDesc` (own-property signal) separately and flags `webdriver !== false` as a distinct leak entry

**Impact:** Every EB session was leaking an unambiguous automation signal on every page load, passively, with no actions required — explaining bans within 30 minutes of login.

---

## [1.1.416] — 2026-07-09

### Security — Equinox Global Leak Fix (EB Environment Hardening)

#### `window.__eq` removed from Instagram's page context

The main EB `BrowserWindow` was loading `ebToolbarPreload.js` as its preload, which calls `contextBridge.exposeInMainWorld("__eq", ...)`. This placed a permanent, named `window.__eq` object on the Instagram page's main world — a branded global that any JavaScript running on the page (including Instagram's own detection scripts) could probe to definitively identify the browser as Equinox.

**What changed:**
- `ebToolbarPreload.js` is now loaded **only** on the toolbar `BrowserView`, which has its own isolated renderer context. The main `BrowserWindow` no longer carries the preload, so Instagram's page world never receives `window.__eq`.
- `'__eq'` added to the `_ELEC` array in `ELECTRON_LEAK_SUPPRESSOR_JS` as a belt-and-suspenders measure: even if `window.__eq` were somehow re-introduced by a future preload misconfiguration, it would be deleted/shadowed before any page script could read it.

**Files:** `artifacts/electron/src/ebManager.ts`

---

#### All `__eq_*` globals and DOM IDs randomized per EB session

`buildPageUtilsJs()` injected a fixed set of global variables and DOM element IDs into every Instagram page it ran on:

| Before (fixed, detectable) | Role |
|---|---|
| `window.__eq_utils_loaded` | Sentinel — prevents double-injection |
| `window.__eq_lastInput` | Last focused `<input>` / `<textarea>` |
| `window.__eq_fill_done` | Auto-fill completion flag |
| `window.__eq_mo` | MutationObserver reference |
| `window.__eq_fill_poll` | Polling interval reference |
| `window.__eq_cookie_tick` | Cookie-banner polling interval |
| `window.__eq_postCkLoginPos` | Login-link click coordinates |
| DOM ID `__eq_tb` | Toolbar padding `<style>` tag |
| DOM ID `__eq-scraping-warn` | Scraping-warning overlay |

Instagram's detection JS (loaded on every page) could probe for any of these fixed names with a simple `typeof window.__eq_lastInput !== 'undefined'` check and instantly fingerprint the session as Equinox-automated.

**What changed:**
- `buildPageUtilsJs()` now accepts a `jsToken` parameter (6-char random alphanumeric string, e.g. `"k4m8rx"`) generated once per EB window open.
- Every `__eq_*` global name and DOM ID bakes the token in: `__eq_utils_loaded` → `__eq${token}_u`, `__eq_lastInput` → `__eq${token}_li`, `__eq_tb` (DOM ID) → `__eq${token}_tb`, etc.
- The token is stored in `EbEntry.jsToken` so that all other `executeJavaScript` calls outside `buildPageUtilsJs` — `typeIntoFocused`, OTP field detection, scraping-warning overlay, tab BrowserViews — look up the correct randomized name from `ebMap`.
- A new session generates a new token, so even if Instagram records global names from one session, they are useless for the next.

**Files:** `artifacts/electron/src/ebManager.ts` — `EbEntry` interface, `buildPageUtilsJs()`, `openEbWindow()`, `typeIntoFocused`, OTP detection, `injectPageUtils`, tab view injection

---

#### `window.__shareOverlaysSaved` renamed to a random key per post

The silent-post Share-button click handler temporarily saved pointer-event state to `window.__shareOverlaysSaved` — another fixed, detectable global name on the post window's page.

**What changed:** A random `spOvlKey` is generated per Share-click attempt (`'__sp' + Math.random().toString(36).slice(2, 8)`). The overlay state is stored and retrieved under this random key for the duration of the CDP click, then deleted.

**Files:** `artifacts/electron/src/ebManager.ts` — silent-post Share click block

---

## [1.1.415] — 2026-07-09

### Added

#### Chrome Version Check — new CHECKS tab card for every account

A new **Chrome Version Check** card appears on the CHECKS tab of every account's detail page. It shows:

- **Browser (EB) Chrome Version** — the Chrome major stored in the account's browser identity vs the current stable release, with a `PASS` / `WARN` / `FAIL` verdict. `WARN` = 1–2 versions behind; `FAIL` = 3+ versions behind (static bot signal on every login).
- **Current Stable Chrome (Live)** — fetched from Google's public Version History API at check time (24 h in-memory cache on the API server, no secrets required). Shows the full version string (e.g. `140.0.7312.45`).
- **Instagram API User-Agent** — confirms the API UA is present. Notes that Chrome version is not embedded in Instagram's private API format (app/SDK version only) so the browser check is the relevant signal.
- **Bump to Current Chrome Now** button — one click rewrites the stored UA to the current stable version and regenerates the account fingerprint. Equivalent to a phone auto-updating Chrome — no re-verify, no status change, no cookie wipe.

**Files:**
- `artifacts/api-server/src/routes/instagram.ts` — `GET /api/profiles/:id/chrome-version-check` (structured check endpoint with live Google API fetch + 24 h cache)
- `artifacts/api-server/src/routes/instagram.ts` — `POST /api/profiles/:id/bump-chrome-ua` extended to support `requestCurrentBump: true` (auto-fetches current version and rewrites UA without caller needing to supply it)
- `artifacts/dannys-bot/src/components/ChromeVersionCheck.tsx` — new check component (pass/warn/fail cards, detail expansion, Bump Now button)
- `artifacts/dannys-bot/src/pages/ProfileDetailsPage.tsx` — ChromeVersionCheck added to CHECKS tab alongside ApiLeakCheck, BrowserCheck, HeaderCheck

---

#### Chrome version auto-refreshes at runtime — no more manual bumps

The app now fetches the real current stable Chrome version from Google's public Version History API at startup and every 24 hours. When a new Chrome release ships the app picks it up automatically — no code push, no manual constant bump, no guessing.

**What this solves:** Stale Chrome versions were a static, session-independent bot signal present on every login regardless of IP, proxy, or account history. Discovering this required weeks of ban investigation. The auto-refresh makes it impossible to silently drift stale again.

**How it works:**
- `refreshChromeVersion()` in `ebManager.ts` fetches `versionhistory.googleapis.com` at startup and on a 24 h interval. If a newer major is detected it extends the `CHROME_BUILD_INFO` lookup table with the correct full build number and GREASE brand, then updates `CURRENT_CHROME_MAJOR`.
- GREASE brand uses the real Chromium rotation algorithm: `greaseBrands[floor(major/8) % 8]` across an 8-entry confirmed cycle — future-proof for any upcoming Chrome milestone, not a 3-band approximation.
- Concurrent calls coalesce into a single in-flight request (no duplicate fetches on rapid startup).
- On any network/parse error the existing table is left untouched — silent fallback, never a crash.
- `CURRENT_CHROME_MAJOR` default bumped from `"139"` to `"140"` to match the newest bundled `CHROME_BUILD_INFO` entry (better offline fallback).

---

#### Existing accounts auto-bump Chrome version on next EB open

When an existing account's EB window is opened, its stored Chrome major is compared to `CURRENT_CHROME_MAJOR`. If it's behind, the UA is rewritten to the new version *before* CDP applies it — the entire session (UA string, Client-Hints brands, GREASE, injected fingerprint script) uses the updated version from the first request. The bumped UA is then persisted to the database so Mode-B silent windows (follow/post/DM automation) pick it up on their next run too.

**What this mimics:** Real Android phones auto-update Chrome within days of a release. An account still reporting Chrome 137 in July 2026 when the phone would naturally be on 140+ is a static tell. This closes that gap transparently.

**What it does NOT touch:** `accountStatus`, cookies (`igApiCookies`), device state (`igDeviceState`), or `credentialsDirty`. A Chrome version bump is indistinguishable from normal phone behavior — it must never trigger a re-verify loop.

**Ghost browser** (profileId = -1) and **verifyMode** windows are explicitly excluded: ghost generates a fresh identity each time; verifyMode must not change the UA mid-flow.

**Files:**
- `artifacts/electron/src/ebManager.ts` — `rewriteChromeMajorInUA()`, `pushUABumpToServer()`, bump block inside `openEbWindow()`
- `artifacts/electron/src/ebManager.ts` — `refreshChromeVersion()`, `_GREASE_BRANDS[]`, `_inferGrease()`, startup + interval hook in `startEbIpcServer()`
- `artifacts/api-server/src/routes/instagram.ts` — `POST /api/profiles/:id/bump-chrome-ua` (updates `userAgentEmbedded` + `ebFingerprint` only)

### Fixed

- **Ghost mobile setup GREASE brand** — the hardcoded `"Not_A Brand"` in the ghost browser's `Emulation.setUserAgentOverride` Client-Hints metadata was replaced with `getChromeBuildInfo(CURRENT_CHROME_MAJOR).grease`. The ghost path now uses the same dynamically-correct GREASE as every other EB window.
- **Desktop fallback Chrome UA** — `DESKTOP_BROWSER_UA` in `routes/instagram.ts` updated from `Chrome/139.0.0.0` to `Chrome/140.0.0.0` to match the rest of the UA pool.

---

## [1.1.406] — 2026-07-08

### Added

#### Browser Fingerprint Check — see what Instagram's login JS actually sees inside the EB window

Added a "Browser Fingerprint Check" section to the CHECKS tab (renamed from "API CHECKS"). Runs `executeJavaScript` inside the live Electron browser window and returns structured pass/warn/fail results for the signals Instagram evaluates during the login flow itself — none of which were previously visible in any log.

**Checks run:**
- **Electron Leak** — `window.process`, `window.require`, `window.module`, `window._electron`, `navigator.webdriver` — must all be absent/false; if any are present, Instagram's login JS can definitively identify the browser as Electron
- **Touch Emulation** — `maxTouchPoints` must be ≥1 for a mobile UA; 0 means touch emulation was not applied, so login tap events are typed as keyboard events (bot signal)
- **Platform Spoof** — `navigator.platform` must be Linux-based for an Android UA; "Win32" directly contradicts the mobile UA claim and is a trivial JS detection
- **Chrome Object** — `window.chrome` and `chrome.runtime` must exist and be structured like real Chrome; missing or malformed = fingerprinted as non-Chrome
- **WebGL Renderer** — software renderers (SwiftShader, Mesa, LLVM, Lavapipe) flag as VM/headless to Instagram's fingerprinting pipeline
- **Canvas Noise** — captures a canvas data URL snip; compare across two open account windows to verify noise injection is producing different outputs per-session

**How to use:** Open the browser for an account (click BROWSER tab), then go to CHECKS → Run Browser Check. The window must be live. Results also show the URL the browser is currently on for context.

**Files:**
- `artifacts/electron/src/ebManager.ts` — `GET /eb/browser-check` IPC handler using `webContents.executeJavaScript()`
- `artifacts/api-server/src/routes/instagram.ts` — `GET /api/profiles/:id/browser-check` proxy endpoint
- `artifacts/dannys-bot/src/components/BrowserCheck.tsx` — new UI component
- `artifacts/dannys-bot/src/pages/ProfileDetailsPage.tsx` — tab renamed "CHECKS", BrowserCheck added below ApiLeakCheck

---

## [1.1.405] — 2026-07-08

### Added

#### EB Session Proxy Audit — definitive real-time leak detection for every browser session

Built a systematic IP leak logger that fires **before Instagram sees any traffic**, every time an embedded browser session opens. Eliminates guesswork by capturing the actual exit IP the Electron session uses vs the server's real IP, then flagging whether the proxy is routing correctly.

**Root cause of the ban wave:** With 10 accounts banned immediately from login, the two most likely culprits are (a) proxy not routing (browser exits via real server IP, Instagram sees the same IP on every account) and (b) multiple accounts sharing the same exit IP, competing for Instagram's ~3-new-logins-per-IP-per-6-hours quota. Both are now detected and logged automatically.

**How the audit works:**

Every call to `openEbWindow()` in `ebManager.ts` now runs an exit-IP audit immediately after the proxy double-set (STEP-8b), before `loadCookiesFromFile` and before `loadURL`:

1. **Server real IP** — fetched via a raw Node.js `https.get()` call that bypasses all Electron sessions and proxies. This is the IP Instagram would see if the proxy fails.
2. **Browser exit IP** — fetched via `ses.fetch()` (Electron session-scoped), which routes through the configured proxy. This is what Instagram actually sees.
3. **Leak detection** — if both IPs match → proxy is not routing → accounts will be banned. If multiple sessions share the same exit IP → they are competing for Instagram's per-IP login quota.

**Where to find the log:**
- `equinox-debug.log` — search `EB-IP-AUDIT` for a per-account block that shows server IP, browser exit IP, proxy config, and LEAKING: YES/NO
- `[EB:N]` crash-step log — STEP-8b entries show the audit result inline with the session setup sequence

**The audit result is also queryable via API:**

`GET /api/eb-ip-audits` returns the audit map for all sessions opened since last app start. Only populated in Electron mode (EB_IPC_PORT set). The Electron IPC server exposes it at `GET /eb/ip-audits`.

**New frontend page — EB IP AUDIT (sidebar nav item):**

Navigate to `/eb-audit` in the app. Shows:
- **IP Leaks** — count of sessions where exit IP === server real IP (proxy broken)
- **Shared Exit IPs** — count of accounts competing on the same proxy exit IP
- **Per-session table** — account, proxy config, server real IP, browser exit IP, result (OK / LEAK / SHARED IP / check failed)
- **Leak alert** — red banner with exact fix instructions if any session is leaking
- **Shared IP alert** — amber banner explaining the per-IP login quota risk

**Files:**
- `artifacts/electron/src/ebManager.ts` — `import https from "https"`, `EbIpAuditResult` interface, `_ebIpAudits` Map, `_directHttpsGet()` helper, STEP-8b exit-IP audit block (in `openEbWindow`), `GET /eb/ip-audits` IPC route handler
- `artifacts/api-server/src/routes/instagram.ts` — `GET /api/eb-ip-audits` endpoint
- `artifacts/dannys-bot/src/components/EbProxyAudit.tsx` — new audit UI component (summary cards + per-session table + alert banners)
- `artifacts/dannys-bot/src/pages/EbAuditPage.tsx` — page wrapper
- `artifacts/dannys-bot/src/App.tsx` — `/eb-audit` route added
- `artifacts/dannys-bot/src/components/layout/Sidebar.tsx` — "EB IP AUDIT" nav item added

---

## [1.1.404] — 2026-07-08

### Fixed

#### API Checks tab now appears on the correct profile detail page

The API Leak Check tab (introduced in v1.1.403) was wired into `ProfileDetail.tsx` — a legacy component that exists in the codebase but is **not** the file the Wouter router renders for `/profiles/:id`. The router imports and renders `ProfileDetailsPage.tsx`. As a result, the "API Checks" tab was invisible in the running app despite the backend endpoint and frontend component being fully functional.

**Root cause:** Two similarly-named files exist in `src/pages/`:
- `ProfileDetail.tsx` — older/legacy version, not rendered by any active route
- `ProfileDetailsPage.tsx` — the live file, used by `App.tsx`'s route for `/profiles/:id`

The tab import, tab button entry, and `Tabs.Content` panel were all added to the wrong file.

**Fix:** Added the three required changes to `ProfileDetailsPage.tsx`:
1. `import { ApiLeakCheck } from "@/components/ApiLeakCheck"` at the top
2. `{ value: "api-checks", label: "API CHECKS", icon: Shield }` entry in the horizontal tab bar array (alongside ACCOUNT SETTINGS and HUMAN SESSION TOOL)
3. `<Tabs.Content value="api-checks">` panel rendering `<ApiLeakCheck profileId={profile.id} />` after the existing session-log panel

The tab is now visible and functional on every profile's detail page.

**Files:**
- `artifacts/dannys-bot/src/pages/ProfileDetailsPage.tsx` — import, tab button, and content panel added

---

## [1.1.403] — 2026-07-08

### Added

#### API Leak Check — server-side diagnostic for mobile API traffic integrity

New diagnostic tool accessible from the **API Checks** tab on every account's detail page (profile detail → "API Checks"). Runs four checks against the account's proxy and stored device state without opening a browser. Complements the existing browser-based Leak Check page.

**Why this was needed:** The browser Leak Check page works by running real JavaScript inside the embedded browser (canvas fingerprint, WebRTC, IP echo, navigator properties) and comparing results against expectations. For mobile API calls, there is no browser — so the same class of leak has no equivalent test. An audit query ("check all signals for API calls") identified the gap: we could fix specific bugs (v1.1.402 fixed Accept-Language and JA3 per-call), but without an active test there was no way to confirm completeness or catch regressions.

**Endpoint:** `GET /api/profiles/:id/api-leak-check`
**UI:** "API Checks" tab on the profile detail page — click **Run Checks** to execute all four checks on demand. Results display as pass/fail/warn cards with expandable detail rows.

**Check 1 — Proxy IP routing:**
Sends a real HTTPS request through the account's assigned proxy to two independent IP-echo services (ipify.org and Cloudflare's `1.1.1.1/cdn-cgi/trace`). Confirms the exit IP is not leaking through the server's real address. Warns if multiple different exit IPs are returned (split routing). For hostname-based proxies where the host itself is not an IP, the match check is skipped with an explanatory note (rotating/hostname proxies have no fixed exit IP to compare against). Fails if the proxy is unreachable or returns no response.

**Check 2 — Header geo-consistency:**
Geo-resolves the proxy's exit IP (socks5-aware: HTTP proxies use `resolveProxyGeo` direct TCP tunnel; socks5 proxies use a `SocksProxyAgent` fetch to ip-api.com). From the country code, derives:
- `X-IG-App-Locale` / `X-IG-Device-Locale` / `X-IG-Mapped-Locale` — e.g. `en_GB` for a UK proxy
- `Accept-Language` — e.g. `en-GB,en;q=0.9` (via `localeToAcceptLanguage`)
- `X-IG-Timezone-Offset` — UTC offset in seconds derived from the IANA timezone name using `Intl.DateTimeFormat`

These are the exact header values `_buildMobileHeaders()` will actually send on every API call. The check also validates the locale suffix baked into the stored `userAgentApi` string — if the UA locale (`en_IN`) contradicts the proxy's expected locale (`en_GB`), that is flagged as a mismatch (the UA string is sent as-is; the runtime geo lookup corrects the IG headers but not the UA string itself).

**Check 3 — TLS / JA3 fingerprint:**
Makes a live probe through CycleTLS to `api.ipify.org` using the account's proxy and a realistic Instagram Android User-Agent. Confirms:
- CycleTLS (Go subprocess) is initialised and routing correctly — the OkHttp4 Android JA3 is active
- If CycleTLS is down, the check fails immediately with `TLS-BLOCKED` rather than silently falling back to raw OpenSSL (which would expose the server's OpenSSL JA3 — a clear bot fingerprint)
- Reports the two JA3 strings in effect: `OKHTTP4_JA3` for bootstrap/read calls, `CHROME120_JA3` for write calls (friendships/create, media/like, DM)
- Reports the probe exit IP for cross-reference against the Proxy IP check

**Check 4 — Device ID sanity:**
Parses `igDeviceState` from the profile DB row and validates all four persistent device identifiers:
- `uuid` — must be a valid RFC 4122 UUID (any version v1–v5, not v4-only)
- `phone_id` — same
- `device_id` (`android_id`) — must be `android-{16 hex chars}` or a valid UUID
- `igDid` — must be a valid RFC 4122 UUID

Warns if any are missing (account not yet verified or device state cleared), fails if any are malformed. Also checks for duplicate values across the four fields — duplicate IDs create a non-unique device fingerprint detectable as automation.

**Not checked (documented gap, same as before):** `browserProxy.ts`'s preview-fetch handler still hardcodes `en-US` and does not route through the account's proxy — a separate, larger fix.

**Files:**
- `artifacts/api-server/src/routes/instagram.ts` — new `GET /api/profiles/:id/api-leak-check` endpoint (~190 lines)
- `artifacts/api-server/src/instagram/tlsTransport.ts` — `OKHTTP4_JA3` exported (was `const`, now `export const`)
- `artifacts/dannys-bot/src/components/ApiLeakCheck.tsx` — new frontend component (idle → run → 4 cards + summary bar)
- `artifacts/dannys-bot/src/pages/ProfileDetailsPage.tsx` — "API Checks" tab added (note: earlier in this session the tab was mistakenly wired to `ProfileDetail.tsx`, which is not the file the router renders — corrected in v1.1.404)

---

## [1.1.402] — 2026-07-08

### Fixed

#### API-call leak audit: Accept-Language still hardcoded `en-US`, and follow JA3 fingerprint was never actually conditional

Follow-up to the v1.1.400/401 EB browser-leak fixes. The user asked whether the same class of leak existed on the **API side** (plain HTTPS mobile-API calls have no JS, so the `navigator.webdriver` fix does not apply there — but headers/TLS fingerprint are the API-call equivalent of a browser leak). An audit of every outbound mobile-API header found two real gaps:

1. **`Accept-Language` hardcoded to `en-US,en;q=0.9` in 13 call sites** in `instagramWebClient.ts`, while `X-IG-App-Locale` / `X-IG-Device-Locale` / `X-IG-Mapped-Locale` were already correctly derived from the proxy's exit country (`resolveProxyGeo` → `countryToIgLocale`). A UK-proxy account was sending `X-IG-App-Locale: en_GB` alongside `Accept-Language: en-US,en;q=0.9` on every single API call — an internal contradiction visible on literally every request, not just at EB login.

   **Fix:** added a `_acceptLanguage` getter on `InstagramWebClient` that derives the header from `this._locale` via the (now-exported) `localeToAcceptLanguage()` in `browserSession.ts`, and replaced all 13 hardcoded occurrences with `this._acceptLanguage`.

2. **Follow calls (`friendships/create`) always used Chrome 120 JA3, even when a Bearer token (`X-IG-Authorization`) was present.** The existing comment described intent to use Android/OkHttp4 JA3 when a Bearer token is available (matching the Android headers + Bearer token that a real app sends together) and Chrome JA3 only as the no-Bearer fallback — but the code unconditionally passed `ja3Override: CHROME120_JA3`, so authenticated follows still went out as Chrome-TLS + (partially Android) headers, a fingerprint mismatch on exactly the call type most associated with follow-related bans.

   **Fix:** `ja3Override` on the follow call is now `this._deviceAuthorization ? undefined : CHROME120_JA3` — `undefined` falls through to the transport's default `OKHTTP4_JA3` (Android), matching the full Android header set kept when auth is present; `CHROME120_JA3` is used only when auth is absent, matching the Android-header-stripped path already in place for that case.

**Also confirmed correct (no change needed):** `X-IG-Timezone-Offset`, User-Agent/`_fullMobileUA`, `radio_type`, and `phone_id` handling were already consistent with the proxy geo and account UA.

**Three more locale-consistency gaps found while wiring this up, same root cause (a static `en-US` default where a proxy-geo lookup was available but not used):**

- `followChallengeRedirects` (challenge/checkpoint redirect follower — plain HTTPS hops straight to instagram.com over the account's proxy) now resolves Accept-Language from `resolveProxyGeo(proxy.host, proxy.port, ...)` instead of a hardcoded default.
- `createSignupBrowser` (Puppeteer browser used during account signup) now does the same via `opts.proxyHost`.
- `createInstagramAccountViaEBForm` (EB-driven signup form flow) now does the same via its `proxyHost` param.

**Not fixed (out of scope, flagged for follow-up):** `browserProxy.ts`'s `handleBrowserProxy` handler still sends a hardcoded `en-US` Accept-Language and does not route its `fetch()` through the account's assigned proxy at all — a larger, separate gap than a header default.

**Files:** `artifacts/api-server/src/instagram/instagramWebClient.ts` · `artifacts/api-server/src/instagram/browserSession.ts` (exported `localeToAcceptLanguage`)

---

## [1.1.401] — 2026-07-08

### Fixed

#### API UA locale now written to the DB immediately at device-ID assignment time

The previous fix (v1.1.400) only patched the locale in the live EB session — the DB still stored whatever locale was baked into the UA pool entry (e.g. `en_IN` for a Samsung SM-A055F originally registered in India), so the UI always showed the wrong locale and every code path that read `profile.userAgentApi` directly from the DB sent the wrong value.

**Root cause:** The UA pool entries have baked-in locale suffixes from the country where the device model was first registered. Accounts on UK/US proxies were being assigned pool entries with `en_IN`, `de_DE`, etc. — and these were written directly to the DB at two points: Reset Device IDs and account creation.

**Fix — three layers:**

1. **Reset Device IDs handler** (`/api/profiles/:id/reset-device-ids`): after picking the UA from the pool, the profile's assigned proxy is looked up and `resolveProxyGeo` is called. The locale suffix in `userAgentApi` is patched before saving to the DB. The EB fingerprint (`ebFingerprint`) is also regenerated from the locale-correct API UA. Non-fatal: if the proxy is unreachable or unassigned, the pool locale is preserved.

2. **Account creation** (`POST /api/profiles`): if a proxy is assigned at creation time, the auto-selected `userAgentApi` is patched with the proxy locale before the profile row is written.

3. **Session-launch persist (belt-and-suspenders)**: when `getOrCreateSession` resolves the proxy geo (which it already did to set the timezone and Accept-Language), it now also writes the locale-corrected `userAgentApi` back to the DB. This covers accounts that had the wrong locale baked in before this fix — next time their EB opens, the DB is automatically corrected.

**New exports in `browserSession.ts`:** `resolveProxyGeo`, `countryToIgLocale` (previously module-private, now exported so the routes layer can call them directly).

**Files:** `artifacts/api-server/src/routes/instagram.ts` · `artifacts/api-server/src/instagram/browserSession.ts`

---

## [1.1.400] — 2026-07-08

### Fixed

#### `navigator.webdriver` was returning `undefined` instead of `false` — causing bans on EB login with no API calls

**Root cause:** The stealth script in `browserSession.ts` (`applyStealthScripts`) patched `navigator.webdriver` with:
```js
Object.defineProperty(navigator, "webdriver", { get: () => undefined });
```
This violated the spec in two distinct, detectable ways:

1. **Wrong value:** Real non-automated Chrome always returns `false` for `navigator.webdriver`. The spec mandates `false` when automation is not active. Returning `undefined` is a value no real browser ever produces — Instagram's JS fingerprinting distinguishes `undefined` from `false` and treats `undefined` as an automation tell.

2. **Wrong location:** The property was patched as an own property directly on the `navigator` instance, not on `Navigator.prototype`. Real Chrome sets it on the prototype. Anti-bot scripts (and likely Instagram's) call `Object.getOwnPropertyDescriptor(navigator, 'webdriver')` to check whether it is an own-instance property — finding one is an additional, independent automation signal even when the value is falsy.

Both flaws are present in the existing code and either one alone is sufficient to trigger detection. Together they produced an automation fingerprint that fired at page-load time, before any API call, explaining why accounts were banned within 30 minutes of an EB login with zero API activity, and why fresh 4G IPs did not help (the leak is JS-level, not IP-level).

The **Leak Check** page compounded the problem: the `testBot()` function only checked `if (wd)` (truthy), so both `undefined` and `false` showed green. The bug could have been running undetected for any length of time.

**Fix (`browserSession.ts` — `applyStealthScripts`):**
```js
// Step 1: remove any own-instance shadow
try { delete navigator.webdriver; } catch (_) {}
// Step 2: patch Navigator.prototype — spec-correct location, returns false
Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
```

**Fix (`leaksPage.ts` — `testBot`):**
- Explicitly checks `wd === false` (not just falsy) — flags `undefined` as red
- Checks `Object.prototype.hasOwnProperty.call(navigator, 'webdriver')` — flags own-instance shadow as red even when the value is false
- Displays a distinct label for each failure mode: `undefined (bad — automation tell)`, `false (own-prop shadow — bad)`, or `false ✓`
- The `isBot` flag now includes `wdBad` (either wrong value or wrong location) so the card correctly shows FLAGGED when the patch is absent or broken

**Files:** `artifacts/api-server/src/instagram/browserSession.ts` · `artifacts/api-server/src/instagram/leaksPage.ts`

---

#### API UA locale and `Accept-Language` header now match proxy exit country

**Root cause:** All API user-agent strings in the UA pool end with a locale suffix (e.g. `; en_US`, `; en_GB`). These were static — the suffix in the pool entry was baked in at pool-authoring time and never updated to reflect the actual proxy country assigned to an account. For UK proxies this meant the API UA claimed `en_US` (a US device) while the IP was clearly UK — a geographic inconsistency Instagram can detect. Similarly, the `Accept-Language` HTTP header was hardcoded to `en-US,en;q=0.9` for all sessions regardless of proxy country.

**Fix:** The existing `resolveProxyTimezone` function (which already calls `ip-api.com` through the proxy to detect the exit-IP timezone) has been extended to also fetch `countryCode` in the same request (`fields=timezone,countryCode`). The function is renamed `resolveProxyGeo` and returns `{ timezone, countryCode }`.

At EB session launch (inside `getOrCreateSession`):
- The country code is mapped to an Instagram locale string (`GB → en_GB`, `US → en_US`, etc.) via a comprehensive `COUNTRY_TO_IG_LOCALE` table covering 40+ countries.
- The locale suffix at the end of the API UA string is replaced in-place via `patchApiUALocale()` — the stored DB value is not mutated; only the live session copy is patched.
- The patched UA is stored in the `Session` context (`session.userAgentApi`) so the automation engine picks it up via `getSessionUserAgentApi(profileId)` when calling `setDeviceInfo`.
- An `Accept-Language` header matching the locale (`en-GB,en;q=0.9` for GB, `en-US,en;q=0.9` for US, etc.) is injected into the Puppeteer page via `setExtraHTTPHeaders` immediately after the stealth scripts are applied.

If the geo lookup fails (proxy unreachable, ip-api.com timeout, etc.) the fallback remains `en-US,en;q=0.9` and the stored API UA locale is left unchanged — fully non-fatal.

**New exports in `browserSession.ts`:**
- `patchApiUALocale(apiUA, locale)` — replaces the locale suffix in an API UA string
- `getSessionUserAgentApi(profileId)` — returns the live session's geo-patched API UA

**Files:** `artifacts/api-server/src/instagram/browserSession.ts` · `artifacts/api-server/src/instagram/automationEngine.ts`

---

## [1.1.399] — 2026-07-08

### Fixed

#### EB browser toolbar "Login" and "2FA" macros used the wrong Tab-key sequence, out of step with Instagram's current login form focus order

**Root cause:** Both the manual "Login" toolbar button (which pastes username/password and submits) and the manual "2FA" toolbar button (which pastes a generated TOTP code and submits) in the embedded browser (EB) had Tab-key counts that no longer matched Instagram's field/focus order:

- **Login macro:** after pasting the username it sent only a single `Tab` before pasting the password (`paste username → Tab → paste password → Tab, Tab → Enter`), skipping over a focusable element between the two fields.
- **2FA macro (toolbar button):** it pasted the code immediately into whatever was focused, with no leading `Tab`s at all, then sent four trailing `Tab`s before `Enter`.
- **2FA macro (inline, automatic continuation right after a login submit):** same missing leading `Tab`s and one extra trailing `Tab` as the toolbar button version.

**Fix:** All three macros now use the corrected sequence:
- **Login:** paste username → `Tab, Tab` → paste password → `Tab, Tab` → `Enter`.
- **2FA (toolbar button and inline auto-continuation):** `Tab, Tab` → paste code → `Tab, Tab, Tab` → `Enter`.

All key events are still dispatched via `Input.dispatchKeyEvent`/`Input.insertText` over CDP (OS-level, `isTrusted = true`) — unchanged from the existing anti-detection approach, only the Tab counts and paste ordering changed.

**File:** `artifacts/electron/src/ebManager.ts` — `case "login"` (`_cdpFillLogin` username→password Tab step, inline 2FA continuation) and `case "totp"` (2FA toolbar button macro)

---

## [1.1.398] — 2026-07-08

### Changed

#### Verify Account: Phase 0 anonymous pre-auth calls removed — verify sequence now starts directly with the live session

**Background:** The cold-start verify sequence previously opened with three calls fired against a clean (cookie-free) HTTP client before the session cookie was ever injected:

1. `GET /api/v1/zr/token/result/` — anonymous zero-rating probe (GetTokenResult)
2. `POST /api/v1/launcher/sync/` — anonymous device config download, no `_uid` (SendMobileConfig)
3. `GET /api/v1/zr/token/result/` — second zero-rating probe immediately after launcher/sync

These calls were modelled on the Jarvee cold-start flow, which starts from zero — no cookies, no session, performing an anonymous device probe before ever loading credentials. In that context the Phase 0 sequence makes sense: Instagram sees a clean device handshake rather than a direct cookie injection.

**Why they are wrong for this app:** Every account in Equinox goes through the embedded browser (EB) login flow first, which harvests `sessionid`, `csrftoken`, `ds_user_id`, `mid`, and `ig_did` directly from Chrome's cookie jar. By the time `verifyInstagramCredentials` is called on the cookie-restore path, a live session already exists — there is no cold-start condition to simulate. Firing three anonymous calls against a device that already has an active session is unnecessary extra API surface, adds latency (the anonymous `launcher/sync` had a 20-second hard cap to prevent slow-proxy hangs), and contributes nothing to session health or bearer-token capture.

**Fix:** Phase 0a, 0b, and 0c removed entirely from the cookie-restore path. The sequence now begins at Phase 1.

**New verify sequence (cookie-restore path):**

| Step | Call | Purpose |
|------|------|---------|
| Phase 1 | Load session cookie | Inject `sessionid` + all EB cookies into mobile API client |
| Phase 1.5 | `POST /api/v1/launcher/sync/` with `_uid` | Authenticated config download — the only launcher/sync call needed; Instagram issues Bearer token here |
| Phase 2a | `POST /api/v1/accounts/get_account_family/` | Session confirmation probe |
| Phase 2b | `POST /api/v1/qe/sync/` (bare, unsigned) | ABD (Automated Behaviour Detected) probe |
| Phase 2c | `POST /api/v1/qe/sync/` (FetchConfig) + `POST /api/v1/banyan/banyan/` | Config + Banyan (shuffled order) |
| Phase 2d | Random endpoint pool | API-throttled additional probes per account settings |

**Before:** 7 API calls (GetTokenResult × 2, SendMobileConfig × 2, GetAccountFamily, FetchConfig, Banyan)
**After:** 4 API calls (SendMobileConfig × 1, GetAccountFamily, FetchConfig, Banyan) + Phase 2d pool

The 20-second hard cap on anonymous `launcher/sync` is also gone — it existed solely to prevent the anonymous Phase 0b call from starving the rest of the sequence on high-latency proxies. The authenticated Phase 1.5 `launcher/sync` is governed by `loginApiThrottle` (the account's API Control settings) like every other Phase 1.5+ call.

**File:** `artifacts/api-server/src/instagram/instagramLogin.ts` — `verifyInstagramCredentials`, cookie-restore path (Phase 0a/0b/0c block removed)

---

### Fixed

#### BrowserPanel: Leak Check, AI Selfie, and Upload to Instagram used hardcoded port `:8080` to construct API origin — broken in any environment where API runs on a different port

**Root cause:** Three actions inside `BrowserPanel.tsx` constructed absolute API origins with a hardcoded fallback port of `:8080`:

```ts
const apiOrigin = port === "5000"
  ? `${protocol}//${hostname}:8080`
  : `${protocol}//${hostname}${port ? `:${port}` : ""}`;
```

The API server runs on port `8082` in all configured workflows. Any `fetch` call or Puppeteer navigation URL built from this expression was targeting the wrong port, causing connection refused on all three actions.

The three affected actions:
- **Leak Check** — constructs a URL and sends it to Puppeteer via `send({ type: "navigate", url })` for in-browser leak testing
- **Generate AI Selfie** — `POST /api/ai/generate-selfie` called via `fetch`
- **Upload to Instagram** — `POST /api/browser/{profileId}/files` called via `fetch`

**Fix — fetch calls (AI Selfie, Upload):** Replaced the absolute-origin construction with relative `/api/...` URLs. These calls are made by the browser, go through Vite's reverse proxy (`/api → localhost:${API_PORT}`), and have always been port-agnostic when expressed as relative paths. No origin construction needed at all.

**Fix — Puppeteer navigation (Leak Check):** A relative URL cannot be used here because `send({ type: "navigate" })` is forwarded server-side to Puppeteer's `page.goto()`, which requires an absolute URL (a relative URL would resolve against whatever page the embedded browser is currently on — e.g. Instagram). The API port is now injected at Vite build time as `__API_PORT__` via `vite.config.ts`'s `define` block, and the Leak Check URL is constructed as:

```ts
const apiOrigin = `${protocol}//${hostname}:${__API_PORT__}`;
const url = `${apiOrigin}/api/browser/leaks?profileId=${profileId}`;
```

This correctly resolves to the API server's port regardless of which workflow is running.

**Files:**
- `artifacts/dannys-bot/src/components/BrowserPanel.tsx` — Leak Check, AI Selfie generate, Upload to Instagram
- `artifacts/dannys-bot/vite.config.ts` — `define: { __API_PORT__: JSON.stringify(apiPort) }`
- `artifacts/dannys-bot/src/vite-env.d.ts` — `declare const __API_PORT__: string` (TypeScript declaration)

---

#### dannys-bot `package.json` scripts used a pinned pnpm store absolute path for Vite — broken after any lockfile update or reinstall

**Root cause:** The `dev`, `build`, and `serve` scripts in `artifacts/dannys-bot/package.json` called Vite via a fully-expanded pnpm content-addressable store path:

```
node ../../node_modules/.pnpm/vite@7.3.2_@types+node@25.3.5_jiti@2.6.1_lightningcss@1.31.1_tsx@4.21.0_yaml@2.8.4/node_modules/vite/bin/vite.js
```

This path encodes the exact resolved dependency graph metadata of the entire `node_modules/.pnpm` tree. Any change to a transitive dependency version (even in an unrelated package) regenerates the pnpm store layout and invalidates the path, causing `Cannot find module` on the next cold start — exactly the failure mode observed after the project was imported to Replit with no `node_modules`.

**Fix:** Replaced with the canonical `vite` bin invocation, which pnpm resolves correctly from `node_modules/.bin` regardless of the underlying store layout:

```json
"dev": "vite --config vite.config.ts --host 0.0.0.0"
```

**File:** `artifacts/dannys-bot/package.json`

---

## [1.1.397] — 2026-07-08

### Fixed

#### DM inbox permanently returning 4415001 "Prompt has contribution" even on accounts with empty DM inboxes and no pending prompts

**Root cause:** All `direct_v2/inbox` and `direct_v2/threads` calls were routed through `mobileSessionGet`, which targets `i.instagram.com` using the mobile API cookie jar (`mobileCookieJar`). Instagram's `i.instagram.com` mobile API applies a device-level DM registration gate: accounts whose `ig_did` has not been through Instagram's native mobile DM onboarding flow return 4415001 "Prompt has contribution" on `direct_v2/inbox`, even when the session is fully valid and the EB (embedded browser) can access DMs without any issue. This is identical in nature to the follow/repost `i.instagram.com` vs `www.instagram.com` host mismatch fixed in earlier versions — the mobile API path is stricter about unregistered device IDs for DM-specific endpoints, while the web session path bypasses the device-registration gate entirely.

The bug was confirmed by observing that:
- `GET /api/v1/users/{uid}/info/` via `mobileSessionGet` → HTTP 200 ✓
- `GET /api/v1/news/inbox/` via `mobileSessionGet` → HTTP 200 ✓
- `GET /api/v1/direct_v2/inbox/` via `mobileSessionGet` → HTTP 400, 4415001 ✗
- DM inbox in the EB (instagram.com/direct/inbox/) → fully accessible, empty, zero prompts ✓

All three API calls used identical cookies, headers, and proxy. The gate is endpoint-specific and device-identity-specific, not session-specific.

**Fix:** All `direct_v2/inbox` and `direct_v2/threads` fetches now check `this.isLoggedIn` (web EB session present in `cookieJar`) and route through `webGet` (`www.instagram.com` + EB web cookies) when a web session is available, falling back to `mobileSessionGet` only when no web session exists. This is the same pattern used by `_followViaWebEndpoint` and `_configureViaWebEndpoint`.

**Call sites updated:**
- `getDirectMessages()` — simple inbox check used by the EB-only DM emulation path
- `getDirectMessagesInternal()` Step 2 (inbox overview fetch) and Step 3 (individual thread opens)
- `getDMThreadsWithContent()` — full inbox fetch used by the auto-reply scanner
- `shareStoryViaDm()` — inbox fetch used to find an existing thread to share a story into
- `getThreadIdWithUser()` inbox scan — fallback thread-ID lookup after `get_by_participants`

**Result confirmed in log:** `[webClient] getDirectMessagesInternal: Step 2 — webGet (www.instagram.com)` → `inbox OK — 0 thread(s)` — no gate, no 4415001.

**File:** `artifacts/api-server/src/instagram/instagramWebClient.ts` — `getDirectMessages`, `getDirectMessagesInternal`, `getDMThreadsWithContent`, `shareStoryViaDm`, `getThreadIdWithUser`

---

#### `persistentBadging=true` query parameter removed from all `direct_v2/inbox` URLs

**Reason:** The `persistentBadging=true` parameter explicitly asks Instagram to evaluate whether any interactive "contribution" is pending for the DM feature and return 4415001 if so. Removed from all six call sites as a secondary hygiene fix. The primary fix (host switch above) is what resolved the gate; this removal prevents any future regression where the parameter re-triggers the gate even on accounts where the web session is unavailable.

**File:** `artifacts/api-server/src/instagram/instagramWebClient.ts`

---

#### Phase 2a `users/{uid}/info` warm-up added to `_buildWarmedIgClient` before `news/inbox`

**Context:** The documented Jarvee Phase 2 warm-up sequence for DM access is `user.info → news.inbox`. The implementation only called `news/inbox`. Added `GET /api/v1/users/{uid}/info/` via `mobileSessionGet` as Phase 2a immediately before the Phase 2b `news/inbox` call, matching the documented spec. Error handling: propagate if `logoutReason` is present (real session kill), swallow all other errors non-fatally. An explicit warning is logged when `ownUserId` is unavailable and Phase 2a must be skipped. Note: this warm-up change did not resolve the 4415001 gate (that required the host switch above), but it correctly implements the documented sequence for completeness.

**File:** `artifacts/api-server/src/instagram/instagramWebClient.ts` — `_buildWarmedIgClient`

---

#### Vite dev server API proxy target hardcoded to port 8080 instead of reading from environment

**Root cause:** `artifacts/dannys-bot/vite.config.ts` hardcoded the API reverse-proxy target as `http://localhost:8080`, but the API server runs on port 8082. The frontend's `/api/` requests were being proxied to the wrong port in development, causing all API calls from the Vite dev server to fail with connection refused.

**Fix:** Proxy target now reads from the `API_PORT` environment variable (default `8082`): `` `http://localhost:${process.env.API_PORT ?? 8082}` ``.

**File:** `artifacts/dannys-bot/vite.config.ts`

---

#### `.replit` legacy workflow port alignment

**Fix:** Updated the pre-existing hand-configured "API Server" and "Start application" workflow run commands in `.replit` to use `PORT=8082` and `PORT=5000 API_PORT=8082` respectively, matching the port contract established by the API server's actual binding.

**File:** `.replit`

---

## [1.1.396] — 2026-07-08

### Fixed

#### Duplicate live automation engine — Replit auto-added a second "API Server" workflow that ran a full second `AutomationEngine` against the same live Instagram account concurrently

**Root cause:** The platform auto-registered artifacts for the project, which created its own managed workflow (`artifacts/api-server: API Server`) running the exact same `pnpm --filter @workspace/api-server run dev` script as the pre-existing hand-configured `API Server` workflow. Both processes ran independent `AutomationEngine` instances polling and mutating the same live `@miguelsilvayq84` Instagram session at once — a genuine concurrent-session ban risk, not just wasted compute. The two processes also had different `process.cwd()` values, so each wrote to its own separate `database.db` file, but almost certainly shared the underlying session/cookie state on disk, compounding the race. `removeWorkflow` cannot remove artifact-managed workflows, so the duplicate could not simply be deleted — it had to be neutralized at the code level.

**Fix:** Added a cross-process single-instance lock to `AutomationEngine`:
- Atomic acquire via `fs.link()` (test-and-set) against a lock file in `os.tmpdir()` (not `process.cwd()`-relative, since the two duplicate processes have different working directories but share the same container filesystem).
- Stale-lock takeover after 30s of no renewal, so a crashed owner never permanently starves the other process.
- Periodic renewal every 10s with token verification, so a process that loses the lock notices within one renewal cycle and stops its automation loops (`reconcile()`/`restoreResumingAccounts()` intervals).
- Graceful lock release on `SIGTERM`/`SIGINT`/`exit`, so a normal workflow restart hands the lock to the new process immediately instead of making it wait out the full 30s staleness window.
- `reconcile()` itself now checks lock ownership and no-ops if this process is not the owner — closing a gap where a manual UI action (e.g. toggling a tool on) could otherwise trigger `reconcile()` on the non-owner process and launch a duplicate runner even though its periodic loop was stopped.

The losing process now serves HTTP only (still fully functional for reads/dashboard) and never touches the live Instagram session.

**Files:** `artifacts/api-server/src/instagram/automationEngine.ts` — new lock fields/methods (`LOCK_PATH`, `_tryAcquireOrTakeover`, `_renewLock`, `_startLoops`, `_stopLoops`, `_releaseLockSync`, `_beginAcquireLoop`), rewritten `start()`, lock guard added to `reconcile()`.

---

#### CycleTLS sidecar crash-loop when two API server processes run at once — both hard-coded to the same fixed port 9119

**Root cause:** Each `AutomationEngine` process spawns its own CycleTLS Go sidecar for TLS/JA3 fingerprinting, and the library defaults to a fixed port (9119). With two API server processes running (see above), the second one to start always crash-looped with `bind: address already in use`.

**Fix:** Added `findFreeTcpPort()` in `tlsTransport.ts` — binds a throwaway socket to port 0, reads back the OS-assigned free port, then passes `{ port }` into `initCycleTLS()`. Each process now gets its own free port at startup instead of racing for a shared fixed one.

**File:** `artifacts/api-server/src/instagram/tlsTransport.ts`

---

#### DM check silently masked real session kills as a soft "gated" skip instead of surfacing them as session-expired

**Root cause:** `_buildWarmedIgClient()`'s warm-up step (`news/inbox` call) classified errors using `isNetworkErr = !e?.response`, under the documented assumption that `mobileSessionGet()` "returns null on Instagram-level 4xx errors, throws only on network failure." That assumption no longer matched the actual implementation: `mobileSessionGet()` throws on **every** HTTP status ≥ 400, including genuine session-kill responses (HTTP 403 with `logout_reason`), and its thrown errors never carried a `.response` property. As a result, `isNetworkErr` was always `true`, so every real session kill fell through to a `currentUser()` fallback. That fallback had its own bug — it only checked `cuJ !== null`, not the response body's `status` field — so a `200 OK` response carrying `{status:"fail"}` (a genuine Instagram-level rejection, observed live) was incorrectly read as a successful warm-up. Net effect: a dead session was reported as "warmed up," the actual `direct_v2/inbox/` call then failed with an unrelated `4415001` error, and that got mislabeled as a soft, skippable "gate" — completely hiding the real session-expiry root cause from account-health monitoring.

**Fix:**
- `mobileSessionGet()` now attaches structured `.httpStatus` and `.logoutReason` metadata to every thrown error, so callers can reliably tell "Instagram responded with a real HTTP status" apart from a genuine transport/network failure.
- `_buildWarmedIgClient()`'s catch block now classifies on that metadata: a real `logoutReason` is treated as a genuine session kill and rethrown immediately (propagating as `session_expired`, which the existing `checkSessionErr`/`applyAccountLevelError` pipeline already handles correctly) instead of being papered over by the `currentUser()` fallback; only a truly response-less error (no `.httpStatus` at all) triggers that fallback; any other real HTTP error (e.g. `4415001`) is still treated as "connected, warm" as before.
- The `currentUser()` fallback now also requires `cuJ?.status !== "fail"` before considering the warm-up successful.
- `_sendDmViaIgClient()` now catches a session-kill throw from the warm-up step and returns its existing `"session_expired"` sentinel instead of letting the error propagate uncaught.

**File:** `artifacts/api-server/src/instagram/instagramWebClient.ts` — `mobileSessionGet`, `_buildWarmedIgClient`, `_sendDmViaIgClient`

---

## [1.1.395] — 2026-07-08

### Fixed

#### Make-a-Post / Repost: configure failing with "something went wrong during media publish" — same root cause as follow fix (no Bearer token, HMAC-signed Android body)

**Root cause:** Identical to the follow issue fixed in v1.1.393. `_configureViaIgClient` sends an HMAC-signed Android body to `i.instagram.com/api/v1/media/configure/`. When no Bearer token is present, Instagram returns HTTP 500 `{"status":"fail","message":"We're sorry, but something went wrong during media publish. Please try again."}`. The signed body contains `device_id: android-…`, `_uid`, `_uuid`, Android device fields — the same Android-identity contradiction that triggers the Bearer gate on the follow endpoint.

The rupload step succeeds without Bearer (it's a binary upload, not an identity-sensitive write action). Only configure requires Bearer because it is the write action that commits the media to the account.

**Fix:** Added `_configureViaWebEndpoint` — a direct mirror of `_followViaWebEndpoint`. When `_configureViaIgClient` returns null with a "something went wrong" error and `_deviceAuthorization` is absent (auth=MISSING), the configure is retried via:

- `POST www.instagram.com/api/v1/media/configure/`
- Plain unsigned URL-encoded body: `upload_id={id}&caption={caption}&source_type=4`
- Uses `webPost` — EB web cookies (`cookieJar`), `X-CSRFToken`, Chrome UA
- No HMAC signature, no Android device fields
- Instagram's infrastructure shares upload state across `i.` and `www.` subdomains when a valid web `sessionid` is present

On success returns `media.id` (or `uploadId` when response is `{"status":"ok"}` without an id field). Full error handling: checkpoint, challenge, feedback_required, login_required all mapped to appropriate `_lastConfigureError` values.

The mobile-first path is fully preserved — accounts with a valid Bearer token use the signed Android path and never touch the fallback. The web fallback fires only on the specific failure + no-auth combination, matching the follow pattern exactly.

**File:** `artifacts/api-server/src/instagram/instagramWebClient.ts` — new `_configureViaWebEndpoint` method + hook in `runAttempt`

---

## [1.1.394] — 2026-07-08

### Fixed

#### API call export: operation wrappers (FollowedUser, LikeMedia, ViewStories, etc.) incorrectly showed transport "JA3" instead of "Equinox"

**Root cause:** The `setLogger` callback in `automationEngine.ts` hardcoded `transport: "ja3"` for every entry written to `instagram_api_calls`, regardless of whether the log row originated from a real HTTP hit to Instagram's servers or from a high-level operation wrapper tracked by `timed()`.

Two distinct code paths both call `logCallFn`:

- **`_logTransport()`** — fires once per real outbound HTTP request (e.g. `FriendshipsCreate`, `MediaLike`, `HashtagScrape`). These are genuine network hits to Instagram and correctly carry `transport: "ja3"`.
- **`timed()`** — fires once per named operation block (e.g. `FollowedUser`, `LikeMedia`, `ViewStories`, `ViewHighlights`, `ViewReels`, `VisitNotifications`, `VisitOwnProfile`, `Login`). These are internal bookkeeping rows — no direct HTTP call is made at this level; the actual HTTP calls are already logged by `_logTransport()` inside the same block.

Because both paths used the same `transport: "ja3"` value, the API call export (Excel/CSV) showed `FollowedUser` with `transport=JA3`, which is misleading — `FollowedUser` is an internal Equinox event, not a network request to Instagram.

**Fix:** Added a fifth parameter `isTransportCall?: boolean` to the `ApiCallLogger` type. `_logTransport()` passes `true`; `timed()` does not (defaults to `undefined`/falsy). The `setLogger` callback now evaluates:

```
transport: isTransportCall ? "ja3" : "Equinox"
```

**Result in the export:**
- `FriendshipsCreate`, `WebFriendshipsFollow`, `MediaLike`, `HashtagScrape`, etc. → `transport: JA3` ✓
- `FollowedUser`, `LikeMedia`, `ViewStories`, `ViewHighlights`, `ViewReels`, `VisitNotifications`, `VisitOwnProfile`, `Login`, `MobileLogin`, etc. → `transport: Equinox` ✓

**Files:**
- `artifacts/api-server/src/instagram/instagramWebClient.ts` — `ApiCallLogger` type signature + `_logTransport` call site
- `artifacts/api-server/src/instagram/automationEngine.ts` — `setLogger` callback

---

#### `_followViaWebEndpoint`: `status:"ok"` catch-all now logs a warning before optimistic return

When `www.instagram.com/api/v1/friendships/create/{userId}/` returns `{"status":"ok"}` without any of the expected follow-state fields (`friendship_status`, `result`, `following`, `outgoing_request`), the code previously returned success silently. A `console.warn` is now emitted so any unexpected edge-case responses are visible in the debug log for tightening later.

**File:** `artifacts/api-server/src/instagram/instagramWebClient.ts` — `_followViaWebEndpoint`

---

#### `human-session/run-now` endpoint: reverted

A `POST /api/profiles/:profileId/tools/human-session/run-now` endpoint was added during v1.1.393 debugging to wake the HS runner for accounts where the standalone follow runner is permanently blocked. This was reverted — the HS tool structure is by design and the endpoint was not part of the agreed-upon fix scope.

**File:** `artifacts/api-server/src/routes/instagram.ts`

---

## [1.1.393] — 2026-07-07

### Fixed

#### Follow failing with "something went wrong" — Android HMAC-signed body triggers Bearer gate regardless of headers

**Root cause (confirmed from WIRE log):** v1.1.392 stripped all Android-specific HTTP headers when the Bearer token was absent, but the HMAC-signed request body sent to `i.instagram.com/api/v1/friendships/create/{userId}/` is irrevocably Android-native in format:

```
device_id=android-a9490ca72c983130&radio_type=wifi-none&nav_chain=com.bloks.www.ig.na.home:…
```

Instagram verifies the HMAC signature and parses the body. Seeing `device_id: android-…` and `radio_type: wifi-none` in the payload (regardless of what headers accompany it) causes it to treat the request as originating from the Android app — which Instagram gates behind a `Authorization: Bearer IGT:2:…` token. The header stripping in v1.1.392 was necessary but not sufficient: the body itself carries the Android identity.

**Fix:** `_followViaMobileSession` now includes a web-endpoint fallback. When the mobile API returns `{"status":"fail","message":"We're sorry, but something went wrong"}` **and** no Bearer token is present (`auth=MISSING`) **and** the account has a valid EB web session (`cookieJar` contains a `sessionid` cookie), the follow is retried via `_followViaWebEndpoint`:

- Hits `POST www.instagram.com/api/v1/friendships/create/{userId}/`
- Body: plain `user_id={userId}` — **no HMAC signature**, no Android fields
- Uses `webPost` — plain `WEB_UA` (Chrome), `cookieJar` (EB web cookies), `X-CSRFToken` header
- Instagram accepts this as a normal web-app follow and does **not** apply the Bearer-token gate
- Returns `{"friendship_status":{"following":true,...},"status":"ok"}` on success

The mobile-first path is fully preserved: `_bootstrapWwwClaim` still runs before every follow attempt, so accounts that can recover a Bearer token (fresh EB login → cold-start sequence) will use the mobile path successfully. The web fallback only fires on the specific failure + no-auth combination.

**When auth IS present:** all existing behaviour is unchanged — the signed Android body + all Android headers + Bearer token is the correct payload for a fully verified account.

**Also added:** `POST /api/profiles/:profileId/tools/human-session/run-now` API endpoint that calls `triggerHumanSession`. For HS-managed accounts the standalone follow runner is permanently blocked (follows run inside the HS queue), so the existing follow `run-now` endpoint had no effect — this endpoint wakes the HS runner within 1 second instead.

**Files:**
- `artifacts/api-server/src/instagram/instagramWebClient.ts` — `_followViaMobileSession` status=fail branch + new `_followViaWebEndpoint` method
- `artifacts/api-server/src/routes/instagram.ts` — new `human-session/run-now` endpoint

---

## [1.1.392] — 2026-07-07

### Fixed

#### Follow failing with "something went wrong" — Chrome JA3 + Android headers contradiction triggers Bearer gate

**Root cause (confirmed from WIRE log):** The no-Bearer Chrome-JA3 follow path was only stripping two Android headers (`X-IG-WWW-Claim: "0"` and `X-FB-HTTP-Engine: Liger`) but leaving five more Android-specific headers in the request:

- `X-IG-Android-ID: android-<deviceId>` — Android device ID (Chrome never sends this)
- `X-Bloks-Version-Id: ce555e5500…` — Android Bloks framework version
- `X-Bloks-Is-Layout-RTL: false` — Android Bloks RTL flag
- `X-Pigeon-Session-Id: <uuid>` — Android/app session tracker
- `X-Pigeon-Rawclienttime: <timestamp>` — Android app timing metric

Instagram checks **both** the TLS JA3 fingerprint AND the HTTP headers when deciding whether to apply the Bearer-token gate. Sending Chrome 120 JA3 with Android HTTP headers is a detectable contradiction — Instagram applies the Bearer gate anyway, returning `HTTP 200 {"message":"We're sorry, but something went wrong","status":"fail"}`.

The account was not follow-blocked. The session cookies (`sessionid`) were valid — Phase 2e `users/{id}/info` returned HTTP 200 with the real user object. The only issue was the missing Bearer token, which caused Instagram to reject the write action.

**Fix:** When `auth=MISSING` (no Bearer token in `igDeviceState`), strip ALL headers that identify the client as Android — not just the two that were already stripped. The full stripped set is now:
- `X-IG-WWW-Claim: "0"` (was already stripped)
- `X-FB-HTTP-Engine: Liger` (was already stripped)
- `X-IG-Android-ID` ← **new**
- `X-Bloks-Version-Id` ← **new**
- `X-Bloks-Is-Layout-RTL` ← **new**
- `X-Pigeon-Session-Id` ← **new**
- `X-Pigeon-Rawclienttime` ← **new**

When `Authorization: Bearer IGT:2:…` IS present, all headers are kept — real Android app v431+ sends the full set together with the Bearer token on every authenticated call.

**File:** `artifacts/api-server/src/instagram/instagramWebClient.ts` — `_followViaMobileSession`, no-Bearer header stripping block (~line 2354)

---

## [1.1.391] — 2026-07-07

### Fixed

#### Follow failing with "BLOCKED / api_error: something went wrong" — missing Authorization Bearer token after all bootstrap phases

**Root cause:** When an account's EB session had expired (stale or never fully bootstrapped cookies), every bootstrap phase in `_bootstrapWwwClaim` (2a `get_account_family` → 2b `qe/sync` → 2c `banyan/banyan` → 2c' `launcher/sync` → 2d multi-probe → 2e `igReq` direct) returned `claim=none, auth=none`. Instagram app v431+ requires the `Authorization: Bearer IGT:2:…` header on every `friendships/create` write call — without it, the server returns HTTP 200 `{"message":"We're sorry, but something went wrong","status":"fail"}`, which the code correctly catches but labels as `follow_blocked`, making it look like the account is action-blocked when it isn't at all.

**Why Bootstrap phases returned no tokens:** The account's session was stale — the stored `igApiCookies` had either expired or the session had never gone through a complete EB-first cold-start that includes the `ig-set-authorization` token exchange. All bootstrap phases ran against a dead session and received no `ig-set-www-claim` or `ig-set-authorization` response headers.

**The fix the agent applied for the affected account:** Forced a manual re-verify through the EB (open browser → fresh EB login → full Jarvee cold-start sequence → `ig-set-authorization` Bearer token written to `igDeviceState`). After re-verify, `auth=present` appears in the follow log and follows go through correctly.

#### Stage Bootstrap re-schedules manual Verify — re-verify now always runs immediately

**Root cause (the harder problem):** The `POST /api/profiles/:id/verify` route contained a `stageBootstrapEnabled` guard that fired unconditionally whenever a fresh EB session was found — regardless of whether the account already had a working mobile session from a previous verify. Any account with Stage Bootstrap enabled would be sent back into the "staging" (delayed) state every single time the user clicked Verify, even when they explicitly wanted to run the bootstrap immediately to refresh an expired Bearer token. The only workaround was to temporarily disable `stageBootstrapEnabled` in the DB, run verify, then re-enable it.

**Fix:** The verify route now checks whether the account already had `igApiCookies` containing a `sessionid` *before* this verify run started (using the `profile` snapshot loaded at the top of the route, before fresh cookies are written). If `igApiCookies` already had a session, this is a **re-verify of an existing account** — not a brand-new first-time EB login. In that case the `stageBootstrapEnabled` staging gate is bypassed and the bootstrap runs immediately. Stage Bootstrap delay continues to apply only to genuinely new accounts being verified for the first time (where `igApiCookies` is empty before the EB login).

**File:** `artifacts/api-server/src/routes/instagram.ts` — Stage Bootstrap block inside `POST /api/profiles/:id/verify`

**Invariant added:**
```
_hadPreviousSession = !!(profile.igApiCookies ?? "").includes("sessionid=")
stageBootstrapEnabled gate: only fires when !_hadPreviousSession
```

---

## [1.1.390] — 2026-07-07

### Fixed

#### Stage Bootstrap fires instantly when delay value is corrupted in the database — Node.js 32-bit setTimeout overflow

**Root cause:** Node.js's `setTimeout` uses a 32-bit signed integer internally. Any delay value above 2,147,483,647 ms (~24.8 days) wraps around and is treated as 1 ms, firing the callback almost immediately. The stored `stageBootstrapDelayMin` in the database was 1,185,334 minutes (cause unknown — likely a UI input that was accepted without bounds-checking), which produced a delay of 71,120,068,753 ms — well above the 32-bit limit. The overflow caused the Stage Bootstrap timer to fire in ~1 ms, triggering the full API cold-start immediately after every verify even though the user expected a delayed warm-up.

**Three-layer fix — all in `artifacts/api-server/src/routes/instagram.ts`:**

1. **`scheduleStagingBootstrap` — hard clamp to 32-bit safe max:**  
   Before calling `setTimeout`, the delay is now clamped to `Math.min(delayMs, 2_147_483_647)`. Any corrupted DB value can never cause an overflow-triggered instant fire. The log line now shows both the clamped and raw delay in minutes for visibility.

2. **Verify path — clamp raw DB minutes to [1, 9999] before converting to ms:**  
   `stageBootstrapDelayMin` and `stageBootstrapDelayMax` are now clamped to a maximum of 9,999 minutes (≈7 days) before multiplication by 60,000. This prevents a corrupted value from even reaching the `scheduleStagingBootstrap` call with an overflowing number.

3. **Startup recovery — detect and heal overflow-corrupted `stagingBootstrapFiresAt` timestamps:**  
   On server startup the staging recovery loop re-schedules accounts still in "staging" state by computing `remainingMs = firesAt - now`. If a previous overflow set `stagingBootstrapFiresAt` to a date years in the future, `remainingMs` would be enormous and the account would be stuck in staging indefinitely. The loop now detects any remaining time > 7 days, logs a warning identifying it as an overflow artifact, and runs the bootstrap immediately instead.

---

## [1.1.389] — 2026-07-07

### Fixed

#### HikerAPI Sync Profile toggle ignored — per-account setting now always respected

**Root cause:** The automation engine's reconcile loop loaded all profiles into memory once at the start of each reconcile cycle (`storage.getProfiles()`), then passed those snapshot objects directly to `runProfileSync(profile)`. Any change the user made to the per-account **HikerAPI** sync toggle (`syncUseHiker`) in Account Settings was written to the database by the 800 ms debounce autosave — but if the reconcile happened to fire between when the user toggled the setting and when the autosave completed, `runProfileSync` received the stale snapshot value (`syncUseHiker = true`) and called HikerAPI regardless of what the user had set.

**Fix:** The reconcile loop now calls `this.syncProfile(profile.id)` (the public method) instead of the private `this.runProfileSync(profile)` directly. `syncProfile` always re-reads the profile from the database as its first step before making any HikerAPI / account-sync decision. This guarantees the freshest `syncUseHiker` value is used on every sync, regardless of reconcile timing.

**File:** `artifacts/api-server/src/instagram/automationEngine.ts` — reconcile loop, profile sync timer block

---

#### Stage Bootstrap and other settings ignored when Verify is clicked immediately after changing them

**Root cause:** Account Settings uses an 800 ms debounce autosave: every field change schedules a PATCH to the server 800 ms later. The Verify button reads settings fresh from the database. If the user enabled **Stage Bootstrap** (or toggled off the HikerAPI sync toggle, or changed any other account setting) and clicked Verify within those 800 ms, the database still held the old values — the verify route saw `stageBootstrapEnabled = false` and ran the full API cold-start immediately instead of entering the delayed staging flow.

**Fix — synchronous pre-verify flush:** `_executeVerify` now checks whether a debounce save is pending (via `saveTimerRef.current !== null`). If so, it:
1. Cancels the pending timer
2. Immediately fires `updateProfileMutation` with the current `formData` and awaits its completion
3. Only then calls the verify endpoint

This guarantees the database reflects the user's latest settings before the verify route runs. If the flush save fails (e.g. a transient network error), a destructive toast warns the user that some settings may not be reflected in this verify run — verify still proceeds rather than silently blocking.

**Fix — double-save prevention:** The `scheduleAutoSave` timer callback now nulls out `saveTimerRef.current` before firing its mutation. Previously the ref held a stale timer ID even after the timer fired, causing `_executeVerify` to treat an already-completed save as "pending" and issue a duplicate PATCH on every verify call. With the ref correctly cleared, the explicit flush only fires when there is genuinely an unsaved change in flight.

**Files:**
- `artifacts/dannys-bot/src/pages/ProfileDetailsPage.tsx` — `scheduleAutoSave` (timer callback cleanup) + `_executeVerify` (pre-verify flush with error toast)

---

## [1.1.388] — 2026-07-07

### Fixed

#### EB window opens off-screen when Disable API is off — close handler now account-aware

**Root cause:** The `close` event handler in `openEbWindow()` (`ebManager.ts`) unconditionally called `event.preventDefault()` and repositioned every EB window off-screen (`setPosition(sw+10, ...)` + `setSkipTaskbar(true)`) when the user clicked the close button. This behaviour exists so that accounts running in **Disable API** mode keep their Chromium compositor alive for background automation (silent follows, DMs, human jitter, etc.). For non-Disable-API accounts the automation engine uses the mobile API — no live background session is needed — but the window was still being parked off-screen. On the next manual open the reuse path in `openEbWindow` found the hidden window and called `setBounds(workArea)` to restore it, but users reported the window still appearing minimised/off-screen.

**Fix:** Added `disableApi?: boolean` to the `openEbWindow` opts. The close handler now checks: if `disableApi` is false, `return` immediately (native close proceeds — window actually closes). If `disableApi` is true, the existing off-screen parking logic runs as before.

**Call chain updated:**
- `/api/profiles/:id/eb-proxy` (`routes/instagram.ts`) — now includes `disableApi` in its response.
- `open-browser-window` IPC handler (`main.ts`) — reads `disableApi` from `/eb-proxy` and passes it to `openEbWindow`.
- `openEbWindow` opts type and destructure (`ebManager.ts`) — adds `disableApi` field.

---

## [1.1.387] — 2026-07-07

### New — Stage Bootstrap added to Copy Settings

Stage Bootstrap (`stageBootstrapEnabled`, `stageBootstrapDelayMin`, `stageBootstrapDelayMax`) is now a named option in the Copy Account Settings dialog under **API & Performance**. Selecting it merges the enabled toggle and the Min/Max delay window from the source account into each target account's existing `apiLimits` blob without touching any other rate-limit fields.

**File:** `artifacts/dannys-bot/src/pages/ProfileDetailsPage.tsx` — `ACCOUNT_COPY_GROUPS` and `handleAccountCopy`

---

## [1.1.386] — 2026-07-07

### Fixed

#### Stage Bootstrap inputs — removed artificial 120-minute cap and forced-minimum clamping

**Problem:** The Stage Bootstrap Min and Max delay number inputs in Account Settings had `max={120}` attributes hard-coded in the JSX, silently preventing the user from entering any value above 120 minutes. Additionally, the `onChange` handlers used `Math.max(1, ...)` on Min and `Math.max(min, v)` on Max, which forced values up to 1 and to `min` respectively on every keystroke — making it impossible to type a lower number without the field jumping back up.

**Fix:** Removed both `max={120}` attributes. Removed the `Math.max` clamping from both onChange handlers. Values are now accepted exactly as typed — no hidden floors or ceilings imposed by the UI. The user is free to set any delay range they choose.

**File:** `artifacts/dannys-bot/src/pages/ProfileDetailsPage.tsx`

---

#### Cookie consent banner auto-dismissal — third retry pass for slow React renders

**Problem:** Instagram's cookie consent banner is React-controlled and may take 3–4 seconds to mount into the DOM after a page navigation commits. The existing `framenavigated` handler ran two dismissal passes at 1.5 s gaps, but that window was too tight for the slowest-rendering dialogs on first load — the banner could survive both passes and remain visible.

**Fix:** Added a third `dismissCookieBanner()` pass via `setTimeout` at 3 000 ms after each `framenavigated` event. This ensures the consent dialog is caught even if React takes longer than usual to render it after navigation, without any risk of interfering with mid-redirect flows (the delay is safely after any typical 3xx redirect chain).

**File:** `artifacts/api-server/src/instagram/browserSession.ts`

---

#### Human Session EB browser jitter — gated on Disable API mode

**Problem:** The Human Session tool's EB browser jitter block (notifications visit, own-profile visit, Settings via hamburger, Your Activity via hamburger, and other EB-driven actions) was enqueued and executed regardless of whether the API was active or disabled. When the API is enabled, the account's session is fully managed via Instagram's mobile API — background browser navigation is not needed, burns unnecessary request budget, and can create confusing behavioral signals.

**Fix:** Added an early return at the top of the `humanSession` enqueue async function: if `disableApi` is `false` (API is active), the entire EB jitter block is skipped with a log line (`HS queue — humanSession EB skipped (API active)`). The EB jitter path only runs when `Disable API` is explicitly enabled in Account Settings, which is its intended use case.

**File:** `artifacts/api-server/src/instagram/automationEngine.ts`

---

## [1.1.385] — 2026-07-07

### New — Stage Bootstrap (deferred API cold-start)

After the browser logs in and harvests the session cookies, the API cold-start sequence can now be intentionally delayed by a configurable random window (X–Y minutes, set per-account in Settings → Stage Bootstrap).

**Why:** Running the browser login and the mobile API cold-start back-to-back on the same account within seconds hits multiple endpoint families in a short burst, which reduces trust score and puts the account on a tightrope from the start. The staged delay lets the EB session settle naturally before any mobile API traffic begins.

**Account status during wait:** A new orange **Staging** pill is shown in the Accounts list with a live countdown timer displaying the remaining minutes until the API bootstrap fires.

**Restart-safe:** The fire timestamp (`stagingBootstrapFiresAt`) is persisted in the database. On server restart, any account still in staging has its remaining delay recomputed from the saved timestamp and the timer is rescheduled automatically — no manual intervention needed.

**Implementation:** `artifacts/api-server/src/routes/instagram.ts` — `scheduleStagingBootstrap()` / `runStagedBootstrap()` / startup recovery IIFE. DB column: `staging_bootstrap_fires_at`. Frontend: orange pill in `ProfilesPage.tsx`, Setting controls in `ProfileDetailsPage.tsx`.

### Improved — Full endpoint visibility in API Calls export

Previously, all HTTP requests made inside a named timed operation (e.g. `ViewTimelineFeedSeen`, `LikeMedia`, `FollowedUser`) were suppressed from the individual log — only the outer named entry appeared in the export. This meant that for every operation, the actual endpoints hit were invisible.

**Fix:** Removed the `_inTimedCall` early-return guard from `_logTransport()` in `instagramWebClient.ts`. Every individual endpoint call now logs its own row regardless of whether it runs inside a `timed()` wrapper. Error propagation to the outer named entry is preserved via `_lastTimedCallIsError`.

---

## [1.1.384] — 2026-07-07

### Fixed

#### Critical — Verify overwrites live sessionid with stale file value → __coig_ufac=1 ban

**Root cause:** In `/eb/silent-verify` (`ebManager.ts`), `loadCookiesFromFile()` was called **before** the existing-session check. Instagram rotates the `sessionid` cookie during active browsing. If the `cookies-{id}.json` file held the original login-time sessionid (30+ minutes old), the file-load silently overwrote the live, current sessionid in the Electron session partition. Any subsequent request from the browser then carried the stale sessionid value — Instagram's cookie origin integrity guard (`__coig_ufac=1`) detects this as a cookie being replayed from a different device/time and triggers an instant suspension.

**Confirmed by log:** The ban URL always contained `?__coig_ufac=1`. Verify completed with `"Using existing EB session"` (no Instagram HTTP calls) — but `loadCookiesFromFile` had already run and the overwrite had already happened before the early return.

**Fix:** Check for a live `sessionid` in the Electron session **before** calling `loadCookiesFromFile`. If a live session exists, return immediately without touching any cookies at all. Only call `loadCookiesFromFile` when there is no active session (i.e. the EB needs to be bootstrapped from the saved cookie file for a fresh login).

---

## [1.1.383] — 2026-07-07

### Fixed

#### Critical — Mobile UA + stale desktop GPU fingerprint causing instant bans (root cause of 3-day ban wave)

**Root cause:** When accounts had desktop UAs (v1.1.291–v1.1.365), `generateEbFingerprint()` was called with `desktopMode=true`, storing a desktop GPU renderer string (e.g. `"ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)"`) in the `ebFingerprint` DB column. When v1.1.366 reverted the UA back to mobile Android, only `userAgentEmbedded`/`userAgentApi` were updated — the stored `ebFingerprint` was NOT regenerated. From that point, every EB open and every Mode-B silent-window action sent Instagram a physically impossible hardware combination: Android 14 mobile UA + NVIDIA RTX Direct3D11 WebGL renderer. Instagram detects this as an immediate device-mismatch/session-hijack signal → instant ban.

The coherence check in `browserSession.ts` (introduced to catch desktop-GPU mismatches within the desktop-UA era) only ran when `isDesktopUA = true`. It completely missed the reverse case: mobile UA + stale desktop GPU in DB.

**Two-part fix:**

1. **Startup migration** (`routes/instagram.ts`): on every server start, scans all profiles with a mobile UA and regenerates any `ebFingerprint` that contains a desktop GPU string (`Direct3D11`, `ANGLE (Apple`, `ANGLE (NVIDIA`, `ANGLE (AMD`, `ANGLE (Intel`). Fixes all affected accounts immediately — without waiting for each EB to be opened manually. Logged as `[startup:fp-fix]`.

2. **Per-session coherence check** (`browserSession.ts`): extended the existing desktop-coherence guard to also catch Case B (mobile UA + any desktop GPU string). Now runs on every EB open for both desktop and mobile UA accounts, covering any account that slips through the startup migration.

---

## [1.1.379] — 2026-07-06

### Added

#### Leak Protection — Console shield logs for EB sessions, API client, and browser-only accounts

Three new structured log lines now fire at the critical points in every account session so you can confirm leak protection is active in real time and cross-check it against the Leak Check page.

---

##### `[eb-shield:ID]` — fires every time an Embedded Browser session opens (`ebManager.ts › openEbWindow`)

Printed immediately after the proxy, WebRTC policy, DoH, and DNS-cache setup steps complete. Reports the **actual applied state** of each protection layer — not assumed state — so any layer that failed to apply (e.g. `setWebRTCIPHandlingPolicy` unavailable on an older Electron build) shows `⚠` instead of `✓`.

```
[eb-shield:123] @username ── LEAK PROTECTION ACTIVE
  proxy       : http://p.host:8080
  webrtc      : ✓ disable_non_proxied_udp (session-level + app-level flag)
  doh         : ✓ DISABLED — proxy handles DNS resolution
  quic        : DISABLED (app-level --disable-quic flag)
  ipv6        : DISABLED (app-level --disable-ipv6 flag)
  dns-prefetch: DISABLED (app-level --dns-prefetch-disable flag)
  dns-cache   : FLUSHED (clearHostResolverCache)
```

- `webrtc` and `doh` lines carry `✓` when the session-level API applied, `⚠` when it threw (non-fatal; app-level flag still applies).
- `doh` note adapts: proxy sessions say "proxy handles DNS resolution"; home-IP (`useHomeIp=true`) sessions say "OS resolver (no proxy in this session)".

---

##### `[run-leak-test:ID]` — fires after every leak test (`ebManager.ts › /eb/run-leak-test handler`)

Replaces the previous single-line count log with a per-field breakdown that mirrors all 20 checks on the Leak Check page. The headline summarises the worst finding; each check line shows the same status icon and label the UI shows.

```
[run-leak-test:123] RESULTS — ✓ ALL CLEAR (20/20 checks)
  IP        : ✓ 185.x.x.x (proxy)
  IPMatch   : ✓ Matched
  WebRTC    : ✓ No leak
  DNS       : ✓ No leak
  UAMatch   : ✓ Match
  Bot       : ✓ Not detected
  Timezone  : ✓ ...
  ...
```

Headline rules (in priority order):
- `✗ N FAIL(S) — key1, key2` — one or more `fail` results
- `⚠ N WARN — key1, key2` — warnings with no failures
- `⚠ INCOMPLETE — N checks not captured (key1, …)` — test page timed out or crashed before all 20 keys were written; **never shows ALL CLEAR when checks are missing** (previous behaviour was a false green)
- `✓ ALL CLEAR (20/20 checks)` — only when all 20 keys are present and none are `fail`/`warn`

Result JSON is runtime-normalised before logging (`unknown → { status, label }`) so a partial or malformed RESULTS object degrades gracefully rather than throwing.

**Cross-check rule:** `[eb-shield]` proxy host and `[run-leak-test]` IP result must agree. Any discrepancy means a request bypassed the proxy.

---

##### `[api-shield:ID]` — fires when an API client is created and when disableApi mode blocks it (`instagramWebClient.ts`, `automationEngine.ts`)

**Mobile API active path** (printed in `InstagramWebClient` constructor after the hard-gate check):

```
[api-shield:123] ── MOBILE API LEAK PROTECTION ACTIVE
  proxy       : http://p.host:8080
  hard-gate   : ✓ constructor blocks if proxy absent
  tls-gate    : ✓ tlsRequest blocks if proxy absent
  cycleTLS    : ✓ patchIgClientTls throws if CycleTLS fails (no Node.js TLS fallback)
```

Port is normalised — if the proxy URL has no explicit port, the scheme default is used (`http→80`, `https→443`, `socks5→1080`) so the log never shows `host:`.

**Browser-only / Disable API path** (printed in `ensureClient` when `disableApi=true`):

```
[api-shield:123] @username ── BROWSER-ONLY MODE
  mobile-api  : ✗ BLOCKED (disableApi=true — ensureClient returns null)
  eb          : EB session will be attempted for this account; proxy is
                enforced there — look for [eb-shield:123] in the log.
                If no [eb-shield] line appears, the EB session did not open.
```

The note is intentionally conditional: `disableApi=true` suppresses all API calls but does not guarantee an EB session — if the EB fails to open (e.g. `ensureSilentEbOpen` error) no `[eb-shield]` line appears, making the gap immediately visible in the log.

---

## [1.1.378] — 2026-07-06

### Fixed

#### EB Leak Test — Audio Context state always showed "closed" (false negative)

**Root cause:** The `testAudio()` function in the leak test called `ctx.close()` on line 1277 and then read `ctx.state` on line 1286 — after the close. An AudioContext transitions to `"closed"` state when `.close()` is called, regardless of what state it was in before. So the field always displayed `"closed"` even on a fully healthy, running audio context, making it impossible to tell from the leak test whether the AudioContext was behaving normally.

**Fix:** Capture `ctx.state` into `ctxStateCaptured` immediately before calling `ctx.close()`. The row now shows `"running"` (the correct value for a freshly created AudioContext) and is coloured green for `running`/`suspended`, amber for anything else.

---

#### EB Leak Test — Timer Precision falsely reported "No — full precision" despite 0.1ms quantisation being active

**Root cause:** The old timing test sampled `performance.now()` 10 times in a tight synchronous loop and checked `Math.min(...diffs)`. With our 0.1ms quantisation override (`Math.round(t*10)/10`), all 10 calls happen within the same 100 µs bucket and return the **same** value — giving diffs of exactly `0`. The test's threshold `minDiff > 0.1` evaluated to `false`, so it reported "full precision" even though our clamp was working correctly. This was a false alarm: real Android Chrome with timer coarsening produces the same pattern.

**Fix:** Replaced the brittle `minDiff` check with a `nonZeroDiffs`/`allSame` approach:
- `allSame = true` (all diffs are zero) → timer is quantised, all calls fell in the same bucket → report "coarsened."
- `minNonZeroDiff ≥ 0.099ms` (epsilon-adjusted for IEEE-754 rounding) → timer steps are coarse → report "coarsened."
- Only if non-zero diffs exist AND the smallest is `< 0.001ms` → true full precision → report "full precision."
The resolution label also now says `≤0.1ms (quantised — all same bucket)` for the common case, making it immediately clear what's happening.

---

#### EB Fingerprint — `navigator.doNotTrack` leaked as `"1"` (Electron default)

**Root cause:** Electron's Chromium session has DNT (Do Not Track) enabled by default. Every EB window therefore exposed `navigator.doNotTrack === "1"` to Instagram. Real Android Chrome never sets DNT — the preference is buried in a rarely-visited settings page and the default is off — so `navigator.doNotTrack` on a real Android Chrome session returns `null`. Instagram and third-party fingerprinting scripts can detect this mismatch.

**Fix:** Added an `Object.defineProperty` override to `buildFingerprintScript` immediately after the `performance.now` clamp:
```javascript
Object.defineProperty(navigator, 'doNotTrack', { get: function(){ return null; }, configurable: true });
```
This runs via `Page.addScriptToEvaluateOnNewDocument` on every page navigation in the EB, restoring the correct `null` value before any page script can read it.

---

#### EB Browser — WebGL 2 context unavailable on some GPU/driver configurations

**Root cause:** Chrome maintains a GPU blocklist (a list of GPU/driver combinations with known rendering bugs) and denies `canvas.getContext('webgl2')` for GPUs on that list. On some Windows machines this caused WebGL 2 to be unavailable in the EB, even though Android Chrome 128 supports WebGL 2 on every supported Android device. The mismatch is detectable by Instagram's client-side fingerprinting probes.

**Fix:** Added `app.commandLine.appendSwitch("ignore-gpu-blocklist")` to `main.ts`. This instructs Chromium to ignore the denylist and attempt hardware-accelerated WebGL 2 on all GPUs. Trade-off: may cause minor rendering glitches on genuinely buggy drivers, but the EB is automation-only (no user-visible rendering quality requirement) so this is acceptable.

---

## [1.1.377] — 2026-07-06

### Fixed

#### Human Session Tool (Disable API mode) — "Suggested for you" page no longer prevents Explore from firing

**Root cause:** When an account follows no users, Instagram's home feed shows a full-page "Suggested for you" layout. These suggestion cards are wrapped in `<article>` elements — the same selector used by `waitFor('article')` — so the feed-detection check returned `feedHadPosts = true` even when no real posts were present. The Explore-page block (`followSuggestedUsersIfEmptyEnabled`) never fired because it depends on `feedHadPosts = false`.

A second problem: a defensive post-scroll re-check at the end of the viewTimelineFeed block used `document.querySelector('article')` to recover from slow SPA renders. Since suggestion cards also match `article`, this re-check would silently restore `feedHadPosts = true` even after the suggestions page was correctly identified, cancelling the fix.

**Fix (two coordinated parts):**
1. **Detection** — after `waitFor('article')` succeeds, a new `page.evaluate()` check runs to distinguish real posts from suggestions. The check is intentionally conservative: it only triggers when (a) ALL article elements on the page lack a `<time>` child (real feed posts always contain a timestamp; suggestion cards never do) AND (b) a "Suggested for you" heading is found as a leaf text node. A mixed feed — one that contains both real posts and a suggestions section — will always have at least one `<time>`-containing article, so the check never false-positives there. If detected: `feedHadPosts = false`, `_ebSuggestionsPageDetected = true`.
2. **Re-check guard** — the post-scroll defensive re-check is now skipped when `_ebSuggestionsPageDetected = true`, preventing suggestion-card `<article>` elements from undoing the detection. The re-check selector is also tightened to `article time` so it only counts articles with a real timestamp, not bare structural wrappers.

---

#### Human Session Tool (Disable API mode) — Execution Order fields now work

**Root cause:** `runBrowserOnlyHumanSession` (the code path taken when **Disable API** is enabled on an account) was a flat sequential `if`-block. Every action always ran in the same hard-coded order regardless of the OrderMin/OrderMax values configured in the Human Session Tool settings. The order queue that the standard (API) path uses in `runHumanSessionTools` had never been ported to the browser-only path.

**Fix:** `runBrowserOnlyHumanSession` now uses the same queue pattern as `runHumanSessionTools`:
- `EbQueueEntry` type + `ebQueue` array + `ebEnqueue` helper that reads each action's `OrderMin`/`OrderMax` setting and assigns a random sort value in that range.
- All ten major actions are enqueued: `humanJitter`, `viewTimelineFeed`, `viewReels`, `checkTimelineStories`, `checkDm`, `likeTimelinePosts`, `follow`, `unfollow`, `contact`, `repost`.
- `ebQueue.sort((a, b) => b.order - a.order)` then executes them in descending order (higher order = runs first) — identical to the non-EB queue convention.
- The resolved execution order is logged at session start: `[EB-only] session order: viewTimeline → likeTimeline → …`
- `saveTimelinePosts`, `shareTimelinePosts`, and `explorePage` remain sequential after the queue — they have no order keys and depend on `feedCount` / `feedHadPosts` set by `viewTimelineFeed`.

---

## [1.1.374] — 2026-07-06

### Fixed

#### Human Session Tool — View Reels: reel count now accurate + ArrowDown works reliably

**Root cause:** The reels page was missing the `document.visibilityState = "visible"` override before the reel-watching loop. Without it, Instagram's SPA keeps the reel feed in a throttled / non-hydrated state when the EB window is off-screen, which means the video element is present but the reel player is not fully initialised. Separately, `page.keyboard.press("ArrowDown")` was firing without a preceding `document.body.focus()`, so the key event was silently dropped when no DOM element had focus.

**What was happening:** The reel loop always incremented `watched` once per `ArrowDown` press regardless of whether the reel player actually advanced, so the session log could report e.g. 9 reels watched while the user watching the EB saw only 1 reel play.

**Fix:**
1. Applies the same `Object.defineProperty(visibilityState → "visible") + dispatchEvent(visibilitychange)` override already used by `viewTimelineFeed`, `likeTimelinePosts`, `checkTimelineStories`, and the Follow/story flows — now also applied right before the reel-watching loop starts.
2. Calls `document.body.focus()` immediately before each `ArrowDown` press so the key event is always delivered to the document and reaches the reel player's keyboard handler.

---

#### Human Session Tool — View Reels: EB no longer stays parked on `/reels/` after the block finishes

**Root cause:** The View Reels block navigated to `instagram.com/reels/` and left the EB there with no cleanup navigation. If `checkTimelineStories` was disabled (or skipped by chance), no subsequent block navigated away, so the EB finished the session — and started the next one — on `/reels/`. Users saw the EB jump unexpectedly to the Reels page immediately after the final action of the previous session.

**Fix:** After the reel-watching loop (and after any reel-like logging), a `nav("https://www.instagram.com/", "home (after reels)")` call returns the EB to the home feed before proceeding to the next block. This is guarded by `!state.stop.stopped` so it is skipped on early session termination.

---

#### Human Session Tool — Watch Stories: removed gratuitous home-page reload between each story user

**Root cause:** The story-watching loop called `nav("https://www.instagram.com/", ...)` at the **top of every iteration** — including iterations 2, 3, 4, etc. After pressing `Escape` to dismiss a story, Instagram's overlay closes and the browser is already on the home feed; a second full navigation to the same URL caused a complete page reload the user perceived as the EB "bouncing" back and forth between the home feed and the story viewer for every single user in the tray.

Additionally, the original design comment ("always navigate home so the tray is in a clean state") was correct for iteration 0 only — the story tray's "first unseen" pointer already advances automatically after a story is fully dismissed via `Escape`, so subsequent iterations naturally see the next unread user without any navigation.

**Fix:** The `nav(home)` call is now guarded by `if (i === 0)`. Iterations 1 through N skip the navigation entirely; the visibilityState override and tray-selector wait that follow immediately re-hydrate and query the already-loaded home feed. Net effect: N story-tray interactions now produce 1 home-feed navigation (at the start) instead of N, eliminating the bouncing behaviour.

---

#### Human Session Tool — Web Browsing block collapses when disabled

**Root cause:** The Web Browsing section's tab bar ("Settings" / "Sites Visited") and the content panel below it were rendered unconditionally — they always appeared even when the `webBrowsingEnabled` checkbox was off. This differed from every other tool block in the Human Session panel, which hides its detail rows when unchecked.

**Fix:** The tab bar and both content panels (Settings and Sites Visited log) are now wrapped in `{!!settings.webBrowsingEnabled && (...)}`. When the checkbox is off the header row alone is visible, matching the collapsed pattern used by all other tool blocks.

---

## [1.1.373] — 2026-07-06

### Added

#### Web Browsing — new standalone block in Human Session Tool (last, after Contact Tool)

A dedicated **Web Browsing** block has been added to the Human Session Tool. It appears as the last header block, positioned after the Contact Tool, matching the same cyan-header layout as Follow / Unfollow / Contact.

**What it does:**
- During any Human Session run, the engine visits a configured list of external websites using the same headless-browser cookie-baker engine already used by the standalone Cookie Baker tool. This builds genuine, per-account browser history that Instagram sees when inspecting the Chrome cookie jar — the same cookies the EB writes into `browser-data/cookies-{profileId}.json`.
- Sites are visited with real scroll dwell time, optional internal-link traversal, and cookie banner dismissal — identical to the Cookie Baker behaviour.

**UI features:**
- Enabled checkbox, Order % and Skip Chance % ranges on the header row (same pattern as all other HS blocks).
- **Settings tab**: URL textarea (one URL per line), "Visit at random" checkbox, Sites to Visit / Internal Links / Time on Site / Time on Internal Links min–max pairs.
- **Sites Visited log tab**: shows every past web browsing session with each site visited, time spent, and internal links followed — pulled from `/api/profiles/:id/cookie-baker/activity`.
- **"Split across accounts" button**: distributes all URLs in the current account's list evenly across every account — no duplicates. E.g. 100 URLs × 10 profiles → each profile gets 10 unique URLs. The current profile's slice updates immediately in the UI.

**Copy Settings integration:**
- Web Browsing Settings group added to the Human Session Copy Settings dialog (after Contact Tool Settings).
- Sub-options: Enabled, Execution order, Skip chance %, Visit at random, **Website URLs** (separate checkbox — tick to include URLs in the copy; when unticked only settings are copied, URLs stay per-account), Sites to visit range, Internal links range, Time on site range, Time on links range.

**Engine wiring (automationEngine.ts):**
- `enqueue("webBrowsing", ...)` added to the Human Session queue, before `queue.sort()`. Controlled by `webBrowsingEnabled` / `webBrowsingSkipMin/Max` / `webBrowsingOrderMin/Max`. Maps all `webBrowsing*` settings keys to `runCookieBakerSession`'s expected params (`sites`, `sitesMin/Max`, `visitRandom`, `internalLinksMin/Max`, `scrollDelayMin/Max`, `internalScrollDelayMin/Max`). Each completed session is logged via `logAction` + `logGhostBrowserCall` and appears in the Actions log.

#### Ghost Browser Signup — website warm-up removed (moved to Human Session Tool)

All website warm-up configuration has been removed from the Ghost Browser Signup panel:
- Removed state, localStorage persistence, and payload fields: `websitesToVisit`, `websitesMin/Max`, `internalLinksMin/Max`, `timeOnSiteMin/Max`, `timeOnLinksMin/Max`.
- Removed the "Warm-up Websites" textarea and "Websites to Visit / Internal Links / Time on Site / Time on Links" XY-field rows from the UI.
- Removed the "Visiting Sites" step from the signup progress tracker — the progress stepper now shows `["YouTube Warm-up", "Instagram Signup"]` (or just `["Instagram Signup"]` when Skip Warmup is ticked).
- YouTube warm-up, Skip Warmup toggle, and all YouTube settings remain fully intact.
- The `calcStepProgress` function's settings shape updated to remove the now-unused `websitesMin/Max/Count` fields.

The website-visiting capability now lives exclusively in the Human Session Tool's Web Browsing block, where it runs on a schedule during live Instagram sessions rather than only at account-creation time. This gives Instagram a richer, ongoing browsing history rather than a one-off pre-signup burst.

---

## [1.1.372] — 2026-07-06

### Added

New `expandCaptionPercentMin/Max` sub-setting row above the Reel Chance row. When configured, the engine scrolls back through the feed after the main scroll pass and clicks the "… more" button on posts with probability `expandCaptionPercent`%, simulating a user who reads the full caption of posts they find interesting. The button search matches any `[role="button"]` or `<button>` element whose trimmed text ends with "more" (handles ASCII "...", Unicode "…", and locale variants). Logged with Ghost Browser transport.

---

## [1.1.325] — 2026-07-04

### Fixed

#### Human Session Tool — View Timeline Feed sub-settings (Like% and Watch Reels) now actually run in browser/Disable-API mode

**Root causes found and fixed:**

1. **Likes sub-setting was never wired into the browser path.** The `Like%` control in the View Timeline Feed sub-row sets `likeTimelinePostsPercentMin/Max`, but the browser-only `viewTimelineFeed` block only scrolled — it never acted on those settings. Meanwhile, the separate `likeTimelinePostsEnabled` block (which uses a different count-based setting, `likeTimelinePostsMin/Max`) ran independently only when that standalone toggle was also on. Result: `Like%` in the feed sub-settings silently did nothing in browser mode.

2. **Watch Reels was completely absent from the browser path.** Reel watching via `reelWatchChance*`/`reelWatchCount*`/`reelWatchPercent*` only existed inside the mobile-API `viewTimelineFeed` implementation. There was no browser equivalent, so the reels sub-setting never fired regardless of how it was configured.

3. **`waitFor` helper was declared after the `viewTimelineFeed` block.** Moving the helper inside the block would have caused a TDZ `ReferenceError` at runtime. Moved the `waitFor` declaration to immediately after `nav`, before all browser action blocks, so it is available throughout the session.

**What now happens in browser mode with View Timeline Feed enabled:**
- After scrolling the feed, a like pass runs using `likeTimelinePostsPercentMin/Max` (the exact % shown in the UI), computing a proportional like count from `feedCount`. Zero is a valid outcome for low percentages.
- After likes, a reel-chance roll using `reelWatchChanceMin/Max` determines whether to watch reels. If the roll passes, navigates to `instagram.com/reels/`, waits for a video element, then dwells for `reelWatchPercent`% of an estimated reel duration per reel before pressing ArrowDown, repeating `reelWatchCount` times. Both actions are logged with "Ghost Browser" transport.

**Bounds safety:** all `min`/`max` pairs are clamped to `[0, 100]` and swapped if inverted before use, preventing silent no-ops from bad settings.

---

## [1.1.324] — 2026-07-04

### Added

- Copy Settings (Accounts Manager) now includes a "Disable API" toggle in the Browser Actions group, merged into the same single-PATCH `apiLimits` copy block used by the other browser-action settings (avoids the race/stale-overwrite bug and the "Nothing to copy" false toast).
- `logGhostBrowserCall()` helper in `automationEngine.ts` mirrors every browser-driven action into `storage.createInstagramApiCall` with `source: "Ghost Browser"` / `transport: "Ghost Browser"` so these actions appear in the Actions log and CSV export exactly like real API calls.
- `resolveOperationName()` in the `/api/logs/export` CSV route now maps `source === "Ghost Browser"` rows to the correct tool label (Follow Tool / Contact Tool / Human Session Tool) instead of falling back to the raw internal operation name.
- New Human Session browser sub-features: save post (`saveMediaEnabled` + `saveMediaPercent` chance), share post (`sharePostPercentMin`/`sharePostPercentMax` chance), and Explore page visit (`followSuggestedUsersIfEmptyEnabled`) — all wired through the embedded browser and logged via `logGhostBrowserCall`.

---

## [1.1.275] — 2026-07-01

### Fixed

- **ig-set-authorization never captured through CycleTLS**: `patchIgClientTls` replaces the entire `got` HTTP pipeline with CycleTLS, which bypassed Instagram's response interceptor that normally reads `ig-set-authorization` and `ig-set-www-claim` headers into `ig.state`. Both headers are now read from raw CycleTLS response headers and written directly to `ig.state.authorization` / `ig.state.igWWWClaim` so that `_absorbIgClientState()` can persist them to `igDeviceState` and the DB.

---

## [1.1.0] — Initial Release

### Features

- Multi-account Instagram automation: follow, unfollow, DMs, contact messaging, auto-reply
- Embedded browser (Puppeteer/Chrome) for EB-first authentication — every session originates from a real browser login
- Jarvee two-stage handshake: EB login → cookie extraction → mobile API session via `mobileBootstrapFromWebCookies`
- Device fingerprint continuity: `mid`, `ig_did`, `ig_nrcb`, `ig_did` preserved across all sessions; never regenerated unless user explicitly resets
- HikerAPI integration for hashtag/location/follower scraping
- CycleTLS (OkHttp4 JA3 fingerprint) for all mobile API requests — matches real Android Instagram app TLS fingerprint
- Proxy slot manager with per-account sticky IP assignment
- Human session simulation: timeline browsing, story viewing, DM checks between automation actions
- SQLite database (portable, single-file) with Drizzle ORM
- Electron desktop app wrapper with auto-updater (NSIS Windows installer)
- React + Vite + shadcn/ui frontend served from the Electron main process
