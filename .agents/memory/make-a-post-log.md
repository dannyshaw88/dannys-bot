---
name: Make a Post API failure log
description: Chronological record of every attempt to get Make a Post working via the mobile API. Read before touching anything in that feature.
---

# Make a Post — Attempt Log

**Why this file exists:** The Make a Post feature has been attempted ~20 times via the mobile API and has never worked. Every new session the agent repeats the same fixes. This file and the in-UI README-REPLIT block are the stop-gap.

## MANDATORY before any Make a Post fix attempt

1. Read this file top-to-bottom.
2. Read the README-REPLIT amber log block in `HumanSessionPanel.tsx` — it is rendered in the UI directly below the "Delete from PC after upload" checkbox inside the Make a Post / Source 2 (Local Folder) section.
3. Do NOT attempt any approach already listed below without a fundamentally different root cause.
4. After your attempt (win or fail), add a new dated entry to BOTH this file AND the README-REPLIT block in the UI.

---

## Known failure pattern (as of 2026-06-25)

The agent repeatedly cycles through these steps without resolution:
1. Fix media upload endpoint / URL path
2. Fix configure_video or configure_photo step
3. Add retry / backoff logic
4. Change Content-Type or multipart headers
5. → Loop back to step 1

None of these have produced a working post.

---

## Root cause (suspected, never confirmed)

`instagram-private-api` publish() calls fail silently or return 200 without actually posting.
The EB auth cookies work for browsing/follow/unfollow but the mobile API client may lack
the permission scope required for media publishing.

Additionally: the mobile API client session may be expired by the time the post is triggered
(the session is bootstrapped at verify time, hours/days earlier).

---

## What has NOT been tried

1. Driving the post entirely through the EB (Puppeteer clicking the Instagram web upload flow) — bypassing the mobile API entirely. This is the most promising untried path.
2. Intercepting the actual network request Instagram makes when the user posts manually in the EB (via CDP Network.responseReceived) and replaying those exact headers/body.
3. Explicitly checking `isMobileLoggedIn()` at post execution time — not just at verify time. The session may be stale.
4. Checking whether `mobileBootstrapFromWebCookies()` succeeds immediately before attempting to publish (not just at session init).

---

## Chronological entries (newest first)

### 2026-07-13 — Mobile (ADB) path: expand/fit toggle's positional fallback tapped the camera shutter, not the fit icon — replaced fixed-percentage band with container-anchored search (v1.1.546)
- Same failure *shape* as the compose-icon and header-icon bugs above, on a DIFFERENT element: `findExpandPhotoButton`'s positional fallback used a fixed `y:30-58%, x<22%` screen band with no exclusion for camera/grid elements. The real preview container's bounds run to ~59.8% of screen height (past the 58% cutoff), so the real icon was excluded and the scan matched the unlabelled "open camera" grid tile instead — tapping it opened the phone's live camera. Confirmed via a user-provided real-device log + screenshot showing the automation stuck on the camera viewfinder right after "looking for the photo expand/fit toggle…".
- **Do not keep re-tuning fixed screen-percentage bands for icons on this app.** Every element that has no accessibility label needs THREE things to be reliably found: (1) an anchor to a *dump-confirmed sibling/container* element's own bounds (not a screen-wide percentage — percentages drift per build/device and this has now bitten three different icons), (2) a search scoped strictly inside that anchor's rectangle so nothing outside it can ever match, and (3) a label-based exclusion (camera/gallery/tab/story/reel/live) as a second independent safety net for when the anchor itself can't be found.
- Applied here: search now anchors to the preview container's own bounds (rid contains `preview_container`/`crop_image_view`/`draft_image_view`, all reliably present in real dumps of this screen) and only accepts candidates in that container's bottom-left quadrant — geometrically impossible to match the camera tab, tab strip, or grid below it.
- Status: UNCONFIRMED — pushed as v1.1.546, awaiting real-device confirmation.

### 2026-07-13 — Mobile (ADB) path: top-left header icon (v1.1.544) existed in the dump but was excluded by a too-tight y cutoff — widened + hardened (v1.1.545)
- The user's real-device test of v1.1.544 still reported "not found," which was surprising since the top-left position had just been confirmed correct visually. A `screen-layout-scan` (a debug tool in this codebase that dumps every accessibility node bucketed into TOP/MIDDLE/BOTTOM thirds with pixel + percentage coords — ask the user to run it whenever a selector "should" work but doesn't) showed the real icon's bounds are `[0,104][132,258]` on a 1080×2226 device — centre y ≈ 8.1%, just past the `y < 7%` cutoff the fallback used. It existed in the dump the whole time; the filter itself was silently too strict.
- Also found while investigating: the fallback computed screen w/h via an independent `adb shell wm size` call rather than the dump's own root bounds. This codebase has a known, already-fixed bug class (`rescaleForDevice` in routes/mobile.ts, for mirror-tap coordinate rescaling) where `wm size` reports a "Physical size" line and an "Override size" line that disagree when a display-size override is active. Any function that derives thresholds from a *second, independent* `wm size` call risks that same mismatch against the *live accessibility dump's* coordinate space. **Lesson: always derive screen dimensions from the same xml dump being scanned (its `bounds="[0,0][W,H]"` root node), never from a separate adb call, when the two need to agree.**
- Fix: widened the header band to `y < 12%`, and since that reopens the original v1.1.526 stories-tray "Add" circle risk, added a label exclusion (content-desc/text containing "add"/"story") and a "no similarly-sized siblings at a similar y" check (a tray is a row of same-sized icons; a lone header button never has that shape) as defenses that don't depend on the y band alone.
- Status: UNCONFIRMED — pushed as v1.1.545, awaiting real-device confirmation.
- Separately, the user reported a manual-mirror-click offset (~5px correction needed, "not everywhere") that matches the exact symptom this codebase's `rescaleForDevice` Physical-vs-Override fix already targets — not yet root-caused further since it needs the user to report what `adb shell wm size` actually prints on this device (Physical-only, or Physical+Override) rather than guessing again.

### 2026-07-13 — Mobile (ADB) path: bottom-nav fallback (v1.1.543) was ALSO wrong — moved to user-confirmed top-left header icon (v1.1.544)
- Context: v1.1.543 shipped the bottom-nav-centre fallback as "the last approach confirmed correct via screenshot." That confirmation was from a DIFFERENT earlier moment/account and did not hold on the next real-device run: the user's follow-up screenshot showed the "+" tap landing on **Direct/Messages**, not Notifications this time.
- Root cause: this device's bottom nav is `home / reels / shop / search / profile` — there is no create tab in it at all. `x≈50%,y≈94%` just hit whichever tab happened to sit at the horizontal centre of a 5-icon row.
- Ground truth this time came from the user directly inspecting the live phone mirror and confirming: the real "+" is a single icon at the **TOP-LEFT of the header bar**, left of the "Instagram" wordmark. This is a different element from the stories-tray "Add" circle that caused the ORIGINAL v1.1.526 top-left mistake (that one is lower on screen, y≈9–15%, inside the stories row, and carries content-desc="Add").
- Fix (v1.1.544): `findComposeTopLeftHeaderIcon()` scans only `y < 7%` of screen height so it can never reach the stories tray. `findComposeButton` and the post-tap Notifications/Direct recovery guard both now use this instead of any bottom-nav or top-right guess.
- **Lesson (do not repeat):** "confirmed via screenshot" is only valid for the exact account/build it was captured on — Instagram's nav layout is NOT a global constant in this codebase's real-device farm; it has now been observed in three different configurations (top-right cluster, no-create-tab bottom nav, top-left icon) across attempts on what may be different accounts/builds. When a compose-button fix regresses again, get a fresh Inspect-overlay identification (or fresh screenshot) for THAT specific account/device rather than trusting an older confirmation.
- Status: UNCONFIRMED — pushed as v1.1.544, awaiting real-device confirmation. Read this entry before touching `findComposeButton` again.

### 2026-07-13 — Mobile (ADB) path: top-header positional scan (v1.1.536–542) was WRONG — reverted to bottom-nav (v1.1.543)
- Context: after v1.1.537–542 shipped the "leftmost icon in top-right header band" positional fallback, the user's real-device log showed the exact opposite of progress — tapping "+" opened the full-screen **Notifications** page every single run, not the composer. User confirmed this was a regression from a previously-working state ("we were able to click the Create button 20 versions ago").
- Root cause (CONFIRMED from device log XML dump): on this real device/build there is **no compose icon in the top-header band at all**. The blind positional scan's "pick the leftmost node in the top-right cluster" logic matched the Notifications (heart) icon instead, because that's genuinely the leftmost icon-sized node in that band on this build. `isOnStoryCreator` didn't catch it because Notifications isn't the story picker — a different wrong-screen entirely.
- This whole detour was avoidable: v1.1.527 (earlier the same day) had ALREADY confirmed via screenshot that this device's real "+" is a **bottom-nav tab** (x≈50%, y≈94%), not a header icon. The subsequent switch to top-header scanning in v1.1.536+ was never re-confirmed against a screenshot before shipping — it silently regressed a working fix.
- Fix (v1.1.543): removed the blind top-header positional scan entirely. `findComposeButton` now tries label/resource-id matches (covering both header-icon and bottom-nav resource ids), then falls back straight to the bottom-nav position — the last approach with real screenshot confirmation. Also added `isOnNotificationsOrDirectScreen` as a second post-tap guard (alongside the existing story-picker guard): if the tap lands on Notifications/Direct, the flow backs out and retries once via the bottom-nav position before aborting.
- **Lesson (do not repeat):** this codebase has now regressed the SAME compose-button fix at least twice by replacing a screenshot/log-confirmed positional heuristic with a new blind guess "to be more general." Once a positional fallback has been confirmed correct via a real-device screenshot or log, do not replace it with a different blind heuristic without new evidence that the confirmed one has stopped working on that same device. If Instagram's layout truly varies by account/rollout (header icon vs bottom-nav tab), both should be tried and validated by checking the resulting screen, not swapped wholesale.
- Status: UNCONFIRMED — pushed as v1.1.543, awaiting real-device confirmation. Read this entry before touching `findComposeButton` again.

### 2026-07-13 — Mobile (ADB) path: positional fallback was picking DM icon not compose "+" (v1.1.537)
- v1.1.536 removed "Add" from label search (correct — it was hitting the story tray) and changed positional fallback to top-right y<8%, x>60%, picking the RIGHTMOST node.
- Result: findComposeButton returned null entirely — logged "compose '+' icon not found — skipping".
- Root cause: (1) y < 8% was too tight for the header on this Xiaomi/MIUI layout; (2) picking RIGHTMOST in the right cluster picks the DM icon — Instagram header order left→right is [compose+][notifications❤][DM✈], so the compose "+" is the LEFTMOST of the right-side icons.
- Fix in v1.1.537: threshold widened to y < 15%, minX reduced to 50%, scan picks LEFTMOST (not rightmost) node in the right cluster. Removed `clickable="true"` requirement (some MIUI icon nodes aren't marked clickable in the a11y tree). Story guard (isOnStoryCreator) remains intact.
- **Rule**: when picking a button from a cluster of similar icons by position, determine LEFT→RIGHT order first and pick accordingly. "Rightmost in top-right" almost always picks DM, not compose "+".
- Status: UNCONFIRMED — pushed as v1.1.537. Awaiting real-device confirmation.

### 2026-07-13 — Mobile (ADB) path: wrong compose button → "Add to Story" + unnecessary thumbnail tap (v1.1.527)
- Second round of screenshots confirmed the real root causes:
- Root cause 1 (CONFIRMED via screenshot): `findComposeButton` tapped the top-left "Add to story" camera icon, NOT the bottom-nav "New post" tab. The label "Add" matched "Add to story" and the positional fallback scanned y<8%/x<20% (top-left corner = story camera). Every automated attempt landed on the story composer.
- Fix 1: label search now only "New post". Resource-id list expanded for bottom-nav (creation_tab, creation_tab_icon, new_post_button, action_new_post). Positional fallback rewritten to bottom-centre (y>88%, x 35-65%). Runtime detection: if "Add to story" text found after compose tap → press Back → retry via postComposeCentreNavFallback (50%, 94%).
- Root cause 2 (CONFIRMED via screenshot): When entering via the correct bottom-nav "+", IG auto-selects the newest photo immediately (photo fills large preview instantly — same as manual tap). The previous code tapped a thumbnail anyway, hitting the camera tile or de-selecting the auto-selected photo.
- Fix 2: check for expand toggle after compose opens. If present → photo confirmed selected → skip thumbnail tap entirely. Only tap thumbnail as recovery if toggle absent after 1 s.
- Status: UNCONFIRMED — pushed as v1.1.527. Awaiting real-device confirmation.

### 2026-07-13 — Mobile (ADB) path: thumbnail scan always null + Share had no verification (v1.1.526)
- v1.1.526 fixes (non-clickable cells, Share polling loop, wait bumps) were correct but irrelevant — the real bug was the wrong compose button (see v1.1.527 above).
- Share polling loop and wait bumps from v1.1.526 remain in place as defensive improvements.

### 2026-07-05 — Pointer-events overlay bypass for Share (v1.1.362)
- Context: v1.1.361 used the same generic `spFindBtnPos("Share")` that works for Next buttons, but user confirmed in production (screenshots) that the EXACT SAME symptom persisted — the click still opened the "Tag: | Search" box instead of submitting the post.
- Root cause confirmed: Instagram's caption step renders a transparent `[role="button"]` "Click photo to tag people" hit-target that sits above the Share header button in the DOM stacking order (z-index / stacking context), intercepting coordinate-based CDP `Input.dispatchMouseEvent` clicks aimed at the header even though Share is visually above the overlay. This is specific to the caption step — crop and filter steps have no such overlay, which is why Next clicks have always worked.
- Fix: before firing the CDP click, use `document.elementsFromPoint(cx, cy)` to find every element stacked above the Share button at its click coordinates, temporarily set `pointer-events:none` on them, fire `spRealClick`, then immediately restore pointer events in a separate `executeJavaScript` call. The Share button is identified as the candidate with the minimum `getBoundingClientRect().top` (header = topmost Y).
- **Lesson**: when CDP coordinate-based clicks land on the wrong element (overlay intercepts instead of target), `document.elementsFromPoint` + temporary `pointer-events:none` is the correct fix. The overlay is not a bot-detection mechanism — it is a layout/stacking issue only. This pattern should be applied to any future coordinate click that is being intercepted by a transparent overlay.
- Status: UNCONFIRMED — pushed as v1.1.362, awaiting production confirmation from user.

### 2026-07-05 — Share-overlap-filter fix (v1.1.359) was itself the bug — reverted to generic Next-style click (v1.1.361)
- Context: v1.1.359 replaced the plain text-match Share click with a dedicated finder that rejected any "Share" candidate whose bounding rect overlapped an `<img>`/`<video>`/`<canvas>`, specifically to stop the click landing on the photo (opening the manual tag-people popup). User confirmed in production (screenshot) that the EXACT SAME symptom still happened on v1.1.360 — the click still landed on the photo and opened the "Tag: | Search" overlay, Share was never pressed.
- Root cause: unclear exactly why the overlap-rejection filter itself failed (the rect-overlap math looked correct on paper), but the pattern of "add a bespoke position-finding heuristic for one specific button" has now failed twice in a row for Share specifically, while the plain generic text-match button finder (`spFindBtnPos`, used unchanged for crop-Next and filter-Next since v1.1.355) has never had this problem. The user pointed out Share is literally the SAME header button element as Next, just relabelled after the last step — there is no reason to special-case its lookup at all.
- Fix: removed `spFindShareBtnPos` and `spClickPosOnce` entirely. Share is now clicked via `spClickBtnTextOnce("Share", 15000)` — the exact same generic-text single-click helper already used for "Done", built on the same `spFindBtnPos` used for both Next clicks.
- **Lesson**: when a generic, already-proven mechanism (spFindBtnPos/spClickBtnText, working reliably for 2 Next clicks in the same flow) exists, do NOT introduce a bespoke heuristic (media-overlap rejection) for a sibling button in the same screen "just to be safe" — the bespoke logic is a NEW surface for bugs and in this case failed twice while never actually proving safer than the generic approach it replaced. Prefer reusing the exact same tested mechanism across all buttons in one flow unless there's concrete proof the generic one is the actual fault.
- Status: UNCONFIRMED — pushed as v1.1.361, awaiting production confirmation from user.

### 2026-07-05 — Escape-after-caption was closing the post modal itself (v1.1.360)
- Context: user reported two remaining bugs after v1.1.359: (1) after typing the caption, the flow was clicking the white "X" close button and discarding the post instead of clicking blue "Share"; (2) after a failed post, the automation kept "recycling" — trying more images in the same run instead of stopping after 1 attempt.
- Root cause #1: the caption-typing step unconditionally sent an Escape keypress via CDP after every caption, intended only to dismiss a lingering @mention/#hashtag autocomplete dropdown. Since most captions never contain "@"/"#", no dropdown was ever open — Instagram's "Create new post" modal itself caught the Escape and closed/discarded the post, which looks identical to the user clicking the white X.
- Fix #1: query the DOM for an actual `[role="listbox"]`/`[role="option"]`/mention-dropdown element before sending Escape; skip Escape entirely when no such element is present.
- Root cause #2: `automationEngine.ts` builds a `picked` array of files (sized by `repostMin`/`repostMax`) and loops over it in two places (EB-only mode and API-mode local-folder posting) without stopping the loop after a failed attempt — it just moved on to the next file.
- Fix #2: added `break` on the failure branch (and inside the `catch`) in both loops so exactly one attempt is made per run, regardless of `targetCount`.
- **Lesson**: any "dismiss a possible popup" keypress sent unconditionally into a page that also treats that same key as "close the whole dialog" is a landmine — always gate cleanup keypresses (Escape especially) on positive detection of the specific popup being dismissed, never send them defensively as a blanket cleanup step.
- Status: UNCONFIRMED — pushed as v1.1.360 (pending user push instruction), awaiting production confirmation.

### 2026-07-05 — Share click landing on the photo instead of the Share button (v1.1.359)
- Context: user confirmed v1.1.358 was "100% better" (Create/upload-dialog-skip fix worked), but reported one remaining bug: after the caption is typed, instead of clicking Share (top-right of the popup), the click lands inside the photo as if starting a manual "tag a person" action, and the whole post attempt then fails/recycles.
- Root cause (best available evidence — logs did not show the exact DOM at fault, but the symptom is unambiguous: a click intended for a text-matched "Share" button visually landed on the photo preview instead): most likely typing `@`/`#` in the caption left Instagram's mention/hashtag autocomplete dropdown open, and/or the write-caption screen still had a lingering "tag people on this photo" hit-target layered over the image when Share's coordinates were computed and clicked.
- Fix: (1) after typing the caption, dispatch an Escape keypress via CDP before doing anything else, to close any mention/hashtag autocomplete popup without erasing caption text; (2) replaced the generic text-only Share button lookup with a dedicated finder that explicitly rejects any "Share"-labeled candidate whose bounding rect overlaps an `<img>`/`<video>`/`<canvas>` element on the page, so a click can never land on the photo even if a stray element matches the text.
- Also (separate user request, not a bug fix): simplified the dashboard activity "Detail" column for Make a Post entries from a raw file path/folder string to a plain "Make a Post Successful" / "Make a Post Failed" message, across both the EB-only and API-based local-folder repost code paths in `automationEngine.ts`.
- **Lesson**: when a click-based flow shares screen space with a photo/video preview, text-only element matching is not enough to guarantee the right thing gets clicked — always add a "does this candidate visually overlap the media preview" guard for any button intended to be pressed near an image, since Instagram overlays interactive photo-tagging affordances directly on top of the preview during the caption step.
- Status: UNCONFIRMED — pushed as v1.1.359, awaiting production confirmation from user.

### 2026-07-05 — Create click succeeds but "Post" submenu never appears on some accounts (v1.1.358)
- Context: v1.1.357 shipped the file-chooser interception fix for "Select from Computer", but the user's very next production log showed the flow never even got that far — it failed at an EARLIER step, repeatedly clicking the Create nav item at the exact same coordinates for the full 20s timeout, then erroring with "found the Create button and clicked it, but the Post dropdown never opened".
- Root cause: the click on Create WAS working (confirmed real trusted CDP click, same coordinates every time is expected/fine). The code's only way to confirm success was checking for a "Post" text menu item appearing afterward. But on this account, clicking Create does not show an intermediate dropdown with a "Post" option at all — it jumps straight to the "Create new post" upload dialog. The success check was looking for something that was never going to exist for this account, so it assumed every click failed and looped until timeout.
- Fix: the post-click check now also looks for signs the upload dialog opened directly (body text matching "select from computer", "create new post", or "drag photos and videos here"). If the dialog is already open, a flag skips the separate "click Post from submenu" step entirely and the flow proceeds straight to the file-selection step. The submenu-click step, when it does run, also re-checks for the dialog while waiting for "Post" as a fallback.
- **Lesson**: Instagram's UI does not behave identically across all accounts/rollouts — the same action (clicking Create) can either show an intermediate menu or skip straight to the destination screen depending on the account. Any "did this click work" check in this flow must treat "the menu never showed" and "we skipped straight past the menu" as two different, both-valid outcomes, not automatically assume failure when the expected intermediate state doesn't appear. Always check for the step's actual *end goal* being reached, not just the literal next UI element you expected.
- Status: UNCONFIRMED — pushed as v1.1.358, awaiting production confirmation from user.

### 2026-07-05 — Real click on "Select from Computer" was opening a real native OS file dialog (v1.1.357)
- Context: v1.1.356 made the click on "Select from Computer" a real trusted CDP click (fixing the "button never pressed" bug), but the user reported STILL zero progress — the flow now circles back to the homepage and "recycles" after ~5 refreshes, worse than before.
- Root cause confirmed from the real Instagram page source the user attached: the `<input type="file">` already exists in the DOM on the initial drag-and-drop screen, before the button is ever clicked — so the old "wait for a file input to exist" check always passed instantly regardless of whether anything worked, hiding the real problem. Once the click became a REAL trusted click (fixed in v1.1.356), clicking this specific button now does what it does for a real human: it asks Chromium to open the actual OS-native file-picker dialog. In a hidden/automated Electron window there is nothing that can interact with a native OS dialog, so it just sits open forever — the page underneath never receives a file, and whatever outer watchdog is driving the flow eventually times out and reloads the page. That reload-loop is exactly the "circles back to homepage, recycles" symptom.
- Fix: before clicking the button, arm CDP `Page.setInterceptFileChooserDialog({ enabled: true })` (after `Page.enable`) and listen for the `Page.fileChooserOpened` event on the debugger's `message` event. When Chromium tries to open the native dialog, CDP intercepts it and emits that event with a `backendNodeId` instead of ever showing the real dialog. We answer it directly with `DOM.setFileInputFiles({ files, backendNodeId })`. The native dialog is never shown, so there is nothing to hang on. Disabled interception again immediately after (success or failure) to avoid leaving the page in a weird state for later navigation.
- **Lesson**: fixing an "untrusted click is ignored" bug on a file-upload-triggering control can flip it into a NEW failure mode — a real trusted click on that specific kind of control can trigger a genuine OS-level dialog that automation cannot dismiss. Any control that opens `<input type="file">` picking must have file-chooser interception armed BEFORE the real click is dispatched, every time, not just "wait for the input to exist then inject."
- Status: UNCONFIRMED — pushed as v1.1.357, awaiting production confirmation from user.

### 2026-07-05 — Never actually clicked "Select from Computer" (v1.1.356)
- Context: v1.1.355 fixed Next/Share/Done clicks, but the very next report showed a regression to zero progress — the Create button still worked, but the blue "Select from Computer" button inside the "Create new post" dialog was never pressed at all, and the flow sat frozen on that screen every time.
- Root cause: the code never clicked that button in the first place. It only polled for `input[type='file']` to exist anywhere in the DOM and then injected the file directly into it via CDP `DOM.setFileInputFiles`, skipping the actual button click entirely. On a real Instagram feed page (lots of DOM behind the modal) this is fragile — the input may not be reliably locatable/wired without the click, and `DOM.getDocument({ depth: -1 })` (used to locate it) recursively pulls the ENTIRE DOM tree client-side, which is unnecessarily heavy on a big feed page.
- Fix: explicitly find and click the visible "Select from Computer" button with a real trusted CDP click (`spRealClick`) first — exactly what a human does — THEN wait for/inject into the file input. Also switched `DOM.getDocument` from `depth: -1` to `depth: 0` (root only) since `DOM.querySelector` resolves against Chrome's backend tree and doesn't need the whole tree pre-fetched.
- **Lesson reinforced again**: do not assume any UI transition happens "for free" via direct DOM/CDP manipulation without also performing the actual click a human would do. Every step in this flow must be audited for "did we actually click this, or did we assume it wasn't necessary?" — this is now the 3rd distinct click-related bug found in this single flow across 3 versions (Create, Next/Share/Done, Select from Computer).
- Status: UNCONFIRMED — pushed as v1.1.356, awaiting production confirmation from user.

### 2026-07-05 — Same untrusted-click bug also hit Next/Share/Done (v1.1.355)
- Context: v1.1.354 fixed the Create/Post click and was confirmed working in production — user reported the flow now gets past Create, the file picker appears, and the file injects successfully. But the flow then looped back to the homepage 5 times before giving up on that account.
- Root cause: the SAME untrusted-click bug (`.click()` + `PointerEvent`, always `isTrusted=false`) was still present in `spClickBtnText`, used for the crop "Next", filter "Next", "Share", and "Done" buttons. Only the Create/Post click had been migrated to the real CDP click (`spRealClick`) in v1.1.354 — these were missed.
- Fix: `spClickBtnText` now finds the button's on-screen coordinates and dispatches a real CDP click via `spRealClick`, then verifies the SAME button has disappeared from the DOM before declaring success (auto-retries if it's still there — safe for idempotent "Next" buttons, re-clicking twice has no side effect). Added a separate `spClickBtnTextOnce` (real click, no auto-retry) specifically for "Share" and "Done", since auto-retrying Share risks a duplicate post — success there is verified independently via the existing "Your post has been shared" text poll, not by re-clicking.
- **Lesson reinforced**: when the untrusted-click bug is found on one control, audit EVERY click in the same flow for the same pattern — do not assume fixing one button fixes the whole flow. Also: any auto-retry-on-click logic must consider whether the action is idempotent (Next = safe) or has real-world side effects (Share = never auto-retry the click itself, only the click's *coordinates lookup*, and verify success out-of-band).
- Status: UNCONFIRMED — pushed as v1.1.355, awaiting production confirmation from user.

### 2026-07-05 — EB-driven post flow: untrusted synthetic click root cause found (v1.1.354)
- Context: this is the EB (Puppeteer/embedded-browser) click-through path mentioned as "untried" above — NOT the mobile API path this file otherwise tracks. Posting is driven by clicking Instagram's own web UI (Create → Post → file picker → Next → Share) rather than calling the mobile API.
- Prior attempts (v1.1.351–353) fixed timing/wait issues (fixed sleeps → poll loops) but the Create button click kept silently failing — hover/highlight worked, nothing else happened.
- Root cause confirmed from production logs: the hover step used a real CDP-dispatched mousemove (isTrusted=true), but the actual click was a synthetic in-page `element.click()` / `PointerEvent`, which is always `isTrusted=false` per spec. Instagram's Create control silently ignores untrusted clicks on this specific control.
- Fix: dispatch the click via real CDP `Input.dispatchMouseEvent` (mousePressed + mouseReleased), the same trusted-click pattern already used elsewhere in `ebManager.ts` (ghost-signup nav, cookie banner dismissal). Also re-fetch the button's position after the hover/expand animation before clicking (sidebar shifts on hover), and verify success by checking the dropdown actually opened rather than trusting a JS boolean.
- **Lesson for any future "found the element but click does nothing" bug in the EB**: check whether the click is dispatched via synthetic JS (`.click()`/`PointerEvent`, always untrusted) vs real CDP `Input.dispatchMouseEvent` (trusted). Sites with bot-detection (Instagram in particular) can accept untrusted hover but silently ignore untrusted clicks on sensitive controls.

### 2026-06-25 — ATTEMPT 2: Switched PATH B to CycleTLS (v1.1.160)
- Changed `_mobileRupload` from `forceNodeTls=true` → `forceNodeTls=false` (CycleTLS)
- Changed `_configureViaIgClient` from `forceNodeTls: true` → `forceNodeTls: false` (CycleTLS)
- Theory: rupload and configure must share the same TLS stack. CycleTLS mimics Android TLS fingerprint; Node.js HTTPS never worked.
- Result: UNCONFIRMED — user must run Make a Post and report back.
- If this fails: The TLS stack is NOT the root cause. Next step must be reading the actual error string from the activity log detail column.

### 2026-06-25 — README-REPLIT log block added to UI
- Added amber scrollable log box in HumanSessionPanel.tsx below "Delete from PC after upload" so future agent sessions see the history inline.
- No fix attempt made. This entry establishes the baseline.

### Pre-2026-06-25 — ~20 failed attempts (all prior sessions)
- PATH A: `ig.publish.photo()` via rebuilt IgApiClient — NEVER worked
- PATH B: hand-rolled rupload + configure, `forceNodeTls=true` — NEVER worked  
- Cycle: fix endpoint URL → fix configure body → add retry → change headers → repeat
- Confirmed: follows/unfollows work on same session (igApiCookies valid). Upload-specific failure.
- Error in activity log: "Upload failed for @X will retry next session" = `uploadAttempted > 0` branch at automationEngine.ts line 3131

**How to apply:** Before every Make a Post fix, read this file. After every attempt, prepend a new entry here AND in the UI block.
