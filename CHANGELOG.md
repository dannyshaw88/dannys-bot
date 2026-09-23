- The export includes every extracted field for each parsed profile, including
  credentials, proxy data, user agents, device identifiers, 2FA, cookies, and
  email-validation fields.

## [1.2.481] — 2026-08-12

### Fixed — Compact historical Dashboard cycle rows

- Dashboard Activity Log now also compacts older persisted cycle traces into
  non-zero outcome metrics, so historical rows no longer display lifecycle
  steps such as power-on, unlock, or launch.
- New cycle rows continue to use the server-side metrics-only detail format.

## [1.2.480] — 2026-08-12

### Fixed — Dashboard activity uses metrics only

- Dashboard cycle completion rows now show only non-zero outcome metrics, such
  as likes, follows, Explore scrolls, shares, saves, and posts uploaded.
- Internal lifecycle steps such as power-on, unlock, launch, and airplane-mode
  are no longer persisted into the Dashboard Activity Log detail.
- Detailed execution steps remain available in the live device log.

## [1.2.479] — 2026-08-12

### Added — Per-device Reel swipe evidence

- Reel advance swipes now record the device screen coordinate space, calibrated
  gesture profile values, final transformed path, foreground package, and live
  accessibility-tree presence immediately before and after the gesture.
- The evidence is captured from the device runtime rather than inferred from
  screenshot filenames or dashboard polling timestamps, so different device
  resolutions and mirror scaling can be diagnosed independently.

## [1.2.478] — 2026-08-12

### Added — Temporary Jarvee binary account viewer

- Added a dedicated **Jarvee Binary** button directly beneath Settings in the left navigation.
- Added a temporary, display-only Jarvee file reader. It does not import, create, update, or save accounts.
- The Windows file picker now defaults to **All files**, so Jarvee exports are not restricted to a short list of extensions.
- Binary Jarvee files are parsed through the existing server-side BinaryFormatter/XOR parser instead of being shown as unreadable raw characters.
- Account details are displayed in structured fields for username, Instagram password, email address, email password, description, proxy host/port, proxy username/password, 2FA secret, device information, browser user agent, account label, and other available metadata.
- Followed usernames are grouped into one collapsible field and displayed one username per line.
- Removed non-requested Follow Sources and DM Recipients from the viewer.
- Added copy-to-clipboard support for the extracted account details.
- The canonical `.github/workflows/build-windows-installer.yml` remains the single GitHub Actions workflow for building and publishing the Windows installer. Deprecated duplicate workflow stubs were intentionally left unchanged.

## [1.2.477] — 2026-08-12

### Fixed — Human typo correction deletion

- Human typo correction now uses a dedicated typing-only delete primitive.
- The general keyevent guard still blocks destructive keyevents for unrelated
  automation, while the correction path can delete exactly the injected typo
  and continue typing.
- Full ADB input errors remain surfaced if the device rejects the delete.

## [1.2.476] — 2026-08-12

### Fixed — Complete Dashboard cycle metric stamping

- Dashboard cycle completion entries now always include every configured cycle
  metric, including metrics that remained at zero or were not performed.
- Zero-value metrics are stamped in the completion detail instead of being
  omitted.
- Statistics persistence remains unchanged: zero values do not increment
  lifetime or daily totals.

## [1.2.475] — 2026-08-12

### Fixed — Random Actions notification navigation

- Check Notifications now requires a positively detected Home tab and taps it
  before scanning for the Notifications icon.
- Removed the unsafe Back-button fallback when Home cannot be identified;
  the action now skips safely instead.

## [1.2.474] — 2026-08-12

### Improved — Faster story tray startup

- Reduced the fixed story-tray settle delay from 5 seconds to 800 ms.
- Kept the live UIAutomator tray scan and confirmed-bubble tap safety intact.
- Reduced retry waits from 2 seconds to 500 ms when the first scan finds no
  bubbles.

## [1.2.473] — 2026-08-12

### Improved — Follow search cleanup speed

- Follow now carries forward a confirmed cleared and focused Search state
  between candidates and spread backups.
- Redundant UIAutomator dumps and 60-key deletion sweeps are skipped when the
  Search field is already known to be ready for the next username.
- Full cleanup remains enabled whenever the Search state is uncertain.
- This preserves exact username matching, filter gates, and fail-closed
  navigation while removing duplicate cleanup work.

## [1.2.472] — 2026-08-12

### Improved — Mobile cycle metrics and device isolation

- Dashboard cycle summaries now stamp every configured mobile metric in
  Statistics order, including zero values for metrics that did not run.
- Aborted cycles still receive a final Dashboard completion entry with the
  complete metric summary followed by the abort status.
- The persisted Shares statistic now combines Share to Feed/Repost and
  Share to DMs, while the separate DMs statistic remains available.
- Metrics pie charts now include every mobile statistic except Cycles,
  including newly added metrics even when their current value is zero.
- Phone Apps execution is blocked while an Instagram automation cycle owns the
  device, preventing concurrent wake/tap/lock operations during posting and
  account switching.
- Preserved the existing canonical Windows Installer GitHub Actions workflow;
  no duplicate installer workflow was added.

## [1.2.471] — 2026-08-11

### Added — Saves statistics and Dashboard ribbon

- Added a persisted Saves metric to the Statistics page with daily and
  lifetime totals.
- Aggregated saves from Feed, Explore, Reels, and Random Actions into the same
  account-level Saves total.
- Added Saves to the mobile statistics breakdown and chart data.
- Changed the Dashboard active tab indicator to an Instagram-style black
  ribbon, replacing the previous blue/cyan accent treatment.
- Confirmed the canonical Windows installer workflow remains the only active
  installer workflow.

## [1.2.470] — 2026-08-11

### Improved — Human-error typing diagnostics

- Added explicit per-character error-roll and threshold logging for calibrated
  typing.
- Logs now show the configured probability range, generated roll, selected
  threshold, keyboard layer, and whether a correction was selected.
- Correction logs identify the wrong key and explicitly mark the intended
  correction as one character.
- Backspace diagnostics now include the fixed 35 ms dwell and active keyboard
  layer, making rapid deletion events traceable in the installer debug log.

## [1.2.469] — 2026-08-11

### Fixed — Follow Users multi-candidate search flow

- Prevented failed search-result cleanup from pressing Back after a username
  was not found.
- The Follow tool now stays on Instagram's Search/Explore surface when moving
  from one candidate to the next.
- After a failed result lookup, the existing search field is cleared without
  navigating away from Search.
- Filter-rejected profiles continue to use the single Back needed to leave the
  profile, then return directly to the cleared search bar for the next target.
- Removed the extra navigation path that could return to the feed and cause a
  later username tap to land on the wrong visible profile node.
- Confirmed the canonical Windows installer workflow remains the only active
  installer workflow; no duplicate Actions workflow was created.

## [1.2.468] — 2026-08-10

### Added — Follow Users target management

- Added Import and Export controls to the Follow Users Surplus panel.
- Import accepts newline-, CSV-, or TSV-separated usernames, normalizes
  `@username` values, and skips duplicates already assigned to the slot.
- Export downloads the selected slot's current surplus targets as a text file.
- Added Split to evenly distribute the combined surplus target list across all
  account slots on the same isolated device.
- Split deduplicates targets and never reads or modifies slots on other devices.
- Confirmed the existing canonical Windows installer workflow remains the only
  Windows installer Actions workflow; no duplicate workflow was added.

## [1.2.467] — 2026-08-10

### Restored — Human-error typing across calibrated input

- Restored the configured human-error simulation for Follow username searches.
- Restored the same behavior for Bio Update, so calibrated typing consistently
  uses each device's configured error percentage wherever the shared typing
  engine is used.
- Kept the detailed typo, Backspace, timing, keyboard-layer, and pacing
  diagnostics in place for installer testing.
- Kept the controlled Backspace correction path and destructive-key safety
  guard unchanged.
- Confirmed the existing canonical Windows installer workflow remains the
  single installer workflow; no duplicate Actions workflow was added.

## [1.2.466] — 2026-08-10

### Improved — Typing gesture diagnostics and typo correction

- Preserved the configured human-error typing behavior used for realistic
  keyboard gestures.
- Fixed the internal typo-correction path so its calibrated Backspace tap is
  permitted only for that controlled correction and does not weaken the
  general destructive-key safety guard.
- The configured 35 ms Backspace correction timing is now applied instead of
  being ignored.
- Added installer-log diagnostics for human-error probability, typing-gap
  configuration, keyboard layer, Backspace-map availability, typo and
  Backspace tap results, elapsed gesture time, and actual pacing delays.
- Added profile-tab source, coordinates, and post-tap accessibility-state
  diagnostics to make initial account/profile navigation failures attributable
  to the selected node and resulting screen state.
- Confirmed the existing canonical Windows installer workflow remains the only
  installer Actions workflow; no duplicate workflow was added.

## [1.2.465] — 2026-08-10

### Added — Follow typing diagnostics and calibration export

- Follow Users now enables the shared per-character calibrated-keyboard
  diagnostics, including each intended key, saved tap coordinate, active
  keyboard layer, and typing-session result.
- Added an **Export calibration JSON** action to the calibrated keyboard panel.
- The exported file contains the selected device serial, export timestamp,
  mapped-key count, and every saved key coordinate so calibration can be
  independently reviewed against the keys physically pressed on the mirror.
- Confirmed the existing canonical Windows installer workflow remains the
  single installer workflow; no duplicate Actions workflow was added.

## [1.2.464] — 2026-08-10

### Added — Shared calibrated typing diagnostics

- Added session start/end records to the installer debug log for all calibrated
  typing flows.
- Logs the device serial, current display dimensions, active input method,
  keyboard layer, requested text length, and final success/missing-key result.
- Logs each planned calibrated key tap with its intended key description,
  saved coordinate, active layer, and display dimensions.
- Covers Follow Users, Bio Update, captions, manual calibrated typing, and other
  features using the shared calibration engine.
- Typing behavior itself is unchanged; the diagnostics expose stale
  calibration, wrong display scaling, and keyboard-layer drift.

## [1.2.463] — 2026-08-10

### Release — Windows installer delivery

- Verified that all current project files are included in the Git history before
  release.
- Confirmed the canonical `.github/workflows/build-windows-installer.yml`
  workflow builds the API and frontend bundles, packages the Windows Electron
  installer, uploads the `Aura-Farming-Windows-Installer` artifact, and
  publishes tagged installers to GitHub Releases.
- Kept the canonical workflow as the single Windows installer workflow rather
  than adding a duplicate Actions workflow.

## [1.2.462] — 2026-08-10

### Added — Account switch header-tap diagnostics

- Logs the exact profile-header tap coordinates and the matched node's
  resource ID, labels, clickability, and bounds.
- Captures the UI hierarchy immediately after the single header tap.
- Logs whether the username container, profile markers, target label, and
  sheet/dialog markers are present after the tap.
- Does not add retries or alter account-switch behavior.

## [1.2.461] — 2026-08-10

### Added — Update Bio typing diagnostics

- Update Bio now logs the raw Bio input received by the automation cycle.
- Logs the spin-resolved text and resulting length before navigation and typing.
- Logs select-all/delete start, focused-field detection, and remaining text after
  clear verification.
- Logs the exact text and length passed to calibrated typing, plus calibration
  success and missing-key results.
- These messages flow through the existing installer-folder
  `aura-farming-debug.log` logger.

## [1.2.460] — 2026-08-10

### Fixed — Account switch sheet dismissal

- A different account now relies on Instagram to close the account sheet and
  complete login naturally, with no Android Back action.
- Android Back is allowed only once when the tapped target row is positively
  marked selected and the sheet remains open, indicating the already-active
  account case.
- If the post-tap UI does not positively identify either Home or a selected
  target row, switching aborts without pressing Back.
- A second Back is never attempted.

## [1.2.459] — 2026-08-10

### Fixed — Instagram account switching safety

- Account selection is now determined from the open Instagram account sheet,
  not inferred from usernames found on the previous screen.
- Removed the unsafe Android Back fallback after an account-row tap leaves the
  sheet visible; that Back action could exit Instagram.
- Missing target accounts now abort without sending a blind Back action.
- The existing account-sheet tap and live-row detection flow remains in place;
  no new workflow was added.

## [1.2.458] — 2026-08-10

### Fixed — Update Bio clears existing text

- Update Bio now explicitly selects all existing Bio content and clears it
  before starting calibrated typing.
- The focused field is checked after clearing; if text remains, the operation
  aborts instead of appending the new Bio at an arbitrary cursor position.
- Included the latest account-switching diagnostic screenshots in the project
  assets for reproducible debugging.

## [1.2.457] — 2026-08-10

### Fixed — Random Actions Update Bio replacement

- Update Bio now explicitly selects all existing Bio text and deletes it
  before calibrated typing begins.
- The focused Bio field is re-checked after clearing, and the operation aborts
  without typing if existing text remains.
- This prevents new Bio content from being appended at an arbitrary cursor
  position.

## [1.2.456] — 2026-08-10

### Fixed — Fail-closed image processing safeguards

- Make a Post now aborts before device upload if Fix AI Slop or image
  alteration fails verification.
- Settings → Fix Images now rejects empty, byte-identical, or undecodable
  processed output instead of offering it for export.
- Processing success is based on validated output bytes and image metadata, not
  on diagnostic log messages.
- Preserved the existing canonical Windows Installer workflow without adding a
  duplicate GitHub Actions workflow.

## [1.2.455] — 2026-08-10

### Changed — Windows installer delivery

- Retained the existing canonical `.github/workflows/build-windows-installer.yml`
  workflow as the single Windows installer pipeline.
- Confirmed that pushes to `main` build the web bundles, package the Windows
  installer, and upload it to GitHub Actions artifacts.
- No duplicate or replacement GitHub Actions workflow was created.

## [1.2.454] — 2026-08-10

### Fixed — Calibrated keyboard duplicate characters

- Changed every shared calibrated text-typing character input from a
  zero-distance swipe to one native tap at the calibrated coordinate.
- Preserved the existing pacing, keyboard layers, capitalization, symbols, and
  typing behavior while preventing Xiaomi/MIUI long-press key repeats.

## [1.2.453] — 2026-08-10

### Fixed — Random Actions bio keyboard entry

- Restored Bio updates to the saved per-device keyboard calibration flow.
- Disabled simulated typing-error correction for Bio updates.
- Added a hard deny rule for Backspace, Delete, and Forward Delete key events
  so destructive key presses cannot be sent by calibrated automation.

## [1.2.452] — 2026-08-10

### Fixed — Native mirror clipboard paste

- Restored the `/input/clipboard-paste` endpoint used by the phone mirror's
  right-click Paste action.
- The endpoint uses the native Android clipboard-paste operation and returns a
  clear error instead of silently falling back to character-by-character text
  injection.
- Random Actions bio updates continue verifying the inserted text length before
  allowing the Bio screen to be saved.

### Changed — Dashboard saved activity wording

- Activity summaries now say `saved` instead of the ungrammatical `saves`.
- Added a ribbon icon beside saved activity counts.

## [1.2.451] — 2026-08-10

### Fixed — My Device brightness controls

- Kept the **Brightness Plus** button pressable whenever a device is selected,
  including when the current brightness is already at 100%.
- Pressing Plus at the maximum now safely remains capped at 100% through the
  existing server-side brightness limit instead of disabling the control.
- Preserved the disabled state when no device is selected, since there is no
  device target for the action.

## [1.2.450] — 2026-08-10

### Fixed — Random Actions bio entry

- Kept the bio replacement flow as one **Ctrl+A** selection followed by direct
  calibrated typing over the selected bio.
- Removed the extra explicit Delete step.
- Disabled simulated typing-error correction for bio updates to prevent
  accidental wrong-key and Backspace actions.
- Added bio-specific Shift+Enter handling so multi-line bios remain separate
  rows.
- Preserved normal typing-error behavior for other calibrated typing flows.

## [1.2.449] — 2026-08-10

### Changed — Mobile scroll personality tuning

- Reduced the Back personality weight to a randomized **0–5** across Feed,
  Explore, and Reels.
- Kept Back as a reversed calibrated swipe with a **5–10%** duration band.
- Updated the active mobile API behavior without changing the saved My Device
  swipe geometry or the 150 ms maximum duration cap.

## [1.2.448] — 2026-08-10

### Changed — Mobile scroll personalities

- Updated the scroll personality sequence to **Super skim**, **Skim**, **Fast**,
  **Normal**, and **Back**.
- Renamed the former Normal behavior to Fast and changed its randomized weight
  to 10–25.
- Added the new Normal personality with a randomized weight of 40–75 and an
  80–100% duration band.
- Kept Super skim at weight 1–5 with a 0–35% duration band.
- Kept Skim at weight 5–10 with a 25–75% duration band.
- Changed Back to a 5–20% reverse duration band.
- Applied the updated weights and labels consistently to Feed, Explore, and
  Reels logging and execution.
- The saved My Device swipe profile remains authoritative for swipe geometry;
  personalities only select duration bands and reverse the calibrated gesture
  for Back.

### Changed — Trust Score settings header

- Repositioned the Trust Score detail controls so **Back to TrustScores** aligns
  with the Human Session Tool panel and fingerprint icon.
- Kept Back to TrustScores as a text-only control.
- Ordered the right-side actions as **Copy Settings**, previous **SCORE**, and
  next **SCORE**, while preserving the rightmost SCORE button position.

### Changed — My Device swipe duration safety

- Hard-capped the persisted and executed `durationMaxMs` value at 150 ms.
- Applied the cap across the My Device UI, API validation, test swipes, and
  server-side Feed, Explore, Reels, Chrome, YouTube, and account-list swipes.

### Fixed — Instagram account-switch profile-tab targeting

- Fixed account switching incorrectly selecting the avatar in Instagram’s top
  story tray instead of the Profile tab in the bottom-right navigation.
- Resource-ID profile-tab matches are now accepted only when their node bounds
  place them in the bottom navigation band.
- Explicit `Profile`/`Profil` accessibility-label matches from preloaded launch
  dumps receive the same bottom-of-screen validation.
- Retained the existing bottom-right avatar and multi-tab positional fallbacks,
  so unlabeled Xiaomi/Instagram nodes remain supported without guessed
  coordinates.
- This prevents a generic story avatar from being mistaken for the active
  account profile-switching control.

### Improved — Mobile device quick controls

- Replaced the single brightness-cycle button with separate −50 and +50
  controls, clamped between 0% and 100%.
- Added an Airplane Mode button that enables airplane mode for a randomized
  10–15 seconds, then disables it automatically.
- The airplane control displays a live seconds countdown while the device is
  offline.

## [1.2.447] — 2026-08-09

### Fixed — Human Session Tool interval scheduling

- Manual toggle off/on still starts the requested account cycle immediately,
  but subsequent cycles now use that account's configured **Run every X–Y
  minutes** values.
- Removed the Collision Preventer rest-window override from normal HST
  scheduling, which could replace account intervals with a hardcoded-looking
  5–20 minute delay.
- Updated the always-mounted background HST runner so startup recovery and
  post-cycle scheduling also read the persisted account interval rather than
  stale 20–30 or 25–99 minute fallbacks.
- Collision Preventer continues to manage collision queueing and rest behavior
  without changing the account's normal HST schedule.

### Improved — Males Only allowlist matching

- Added a bounded in-memory cache for compiled Males Only allowlist matchers.
- A large allowlist, including lists of roughly 15,000 names, is now parsed
  and converted to regular expressions once per distinct configuration instead
  of being rebuilt for every candidate profile.
- Preserved the existing username, account-name, and bio boundary rules,
  numeric suffix behavior, field priority, and live accessibility-tree source.

### Changed — Follow filter order

- Moved the **Males Only** allowlist check to the final position in the live
  profile-filter sequence.
- Verified, Private, follower-count, and English Speaking checks now run
  before Males Only.
- Preserved the explicit username/display-name/bio allowlist behavior and
  live accessibility-tree source.

### Fixed — Spread Follow Surplus retention

- Spread Follow no longer deletes every loaded Surplus row immediately during
  prefetch.
- A Surplus candidate is removed only when its individual Follow slot is
  actually dispatched.
- Candidates loaded but never reached remain in Surplus for the next cycle,
  preventing unused users from being lost when the target is fulfilled or the
  cycle ends early.
- Added explicit logging for Surplus candidates that are loaded versus
  consumed after dispatch.

### Fixed — Follow filter skip navigation

- When a candidate is rejected by a Follow profile filter, the automation now
  returns once to the search results instead of repeatedly navigating through
  the Home UI.
- The rejected candidate's query is cleared, the live Instagram search bar is
  tapped, and focus is confirmed before the next candidate is attempted.
- Applied this behavior consistently to Males Only, Verified, Private,
  follower-count, English Speaking, and profile-check failure skips.
- Preserved the final Follow cleanup behavior so the tool still returns to the
  normal Home UI only after the Follow run is complete.

### Fixed — Scroll personality labels

- Renamed the user-facing per-scroll **Interested** label to **Normal** in
  Feed, Explore, and Reels debugging logs.
- Renamed the user-facing internal fast-flick `skim` label to **Super Skim**
  in individual swipe log entries, matching the personality roll stamp.
- Kept the internal mode identifiers unchanged so gesture selection,
  anti-repetition history, and duration bands retain their existing behavior.
- The visible personality names and weights are now consistently reported as
  **Super Skim (1–10%)**, **Skim (5–10%)**, **Normal (40–75%)**, and
  **Back (0–10%)**.

### Improved — Phone Farm Add Device popup

- Opening **Add Device** no longer shrinks the phone-card grid or replaces the
  Add Device slot with a placeholder.
- The existing Add New Device selection interface now appears as a floating,
  right-side popup above the unchanged device layout.
- The popup keeps its phone discovery, refresh, registration, cancellation,
  error handling, and scrolling behavior.
- The popup is constrained to the viewport with a responsive width and raised
  shadow so it remains usable without disturbing the underlying cards.

### Improved — Keyboard calibration map and mirror positioning

- Expanded the keyboard calibration dialog and made its title-bar dragging
  responsive by updating the panel directly during pointer movement.
- Added live search to the “View & fix individual keys” map editor.
- Added a per-key **Position** action for mapped keys. Selecting it displays a
  red marker on the live phone mirror at the saved tap coordinates, with the
  key name and coordinates available on hover. The marker clears when the
  calibration dialog closes or when another key is selected.
- Removed unnecessary introductory calibration copy and simplified the
  calibration button labels, including removing the 2FA missing-key count.

### Fixed — View Feed share-to-DM node safety

- Removed the unlabeled horizontal-position fallback that treated the first
  three clickable action nodes as Comment, Share to Feed, and Share via DM.
- View Feed now skips Share via DM when Instagram does not expose an
  explicitly identifiable paper-plane accessibility node, preventing a
  comment bubble or unrelated wrapper from receiving the DM tap.
- The existing fresh accessibility scan immediately before the DM action
  remains required, and the full log/export behavior is unchanged.

### Changed — Inject Browsing media-render wait

- Reduced the Follow Tool's Inject Browsing profile-grid media-render wait
  from a randomized 4–10 seconds to 4–7 seconds after each grid scroll.
- The change is isolated to Inject Browsing and does not alter the standalone
  View Feed, Explore, Stories, or Reels timing paths.

### Fixed — Reels debugging-log colour priority

- Reels/Reel messages now render red even when they appear inside another
  active tool block, instead of inheriting that parent tool's colour.
- Normalized the Reels colour to the same red treatment in both standalone
  Reels logs and embedded Reels diagnostics.

### Removed — View Feed suggestion side-swipes

- Removed the View Feed Suggestions % setting and all suggestion-carousel
  browsing logic.
- View Feed no longer performs horizontal/side swipes over “Suggested for
  you”, “People you may know”, or Suggested Reels shelves.
- Removed the obsolete suggestion counter from feed execution results and
  summaries.
- Normal vertical View Feed scrolling and all other automation tools remain
  unchanged.

### Fixed — Story tray Home retry and safe abort

- Stories now establishes the Home surface before checking for story bubbles.
- If no bubbles are found, Stories taps the live Home control once more and
  performs one fresh accessibility-tree check.
- If the second check still finds no bubbles, the Stories tool aborts cleanly
  without opening a guessed target or performing story actions.
- The retry is isolated to the Stories entry path and does not change View
  Feed, Explore, Reels, Follow, or other automation tools.

### Improved — View Feed carousel diagnostics

- A failed View Feed Like/Unlike scan now records the raw action/media-region
  accessibility nodes in the debugging log, including resource IDs,
  descriptions, text, classes, bounds, and clickable state.
- The diagnostic includes carousel media nodes so carousel-specific hierarchy
  differences can be identified from the exported log without requiring a
  mid-run manual dump.
- This is diagnostic-only and does not alter View Feed tap behavior.

## [1.2.446] — 2026-08-09

### Fixed — Debugging Log tool colours

- A tool stamp now owns the colour of every line in its block, including
  success, warning, error, and diagnostic messages.
- Removed the white colour fall-through that caused sections inside a tool
  log to lose the tool’s consistent colour.

## [1.2.445] — 2026-08-09

### Changed — Separate Trust Score copy settings

- Added independent Trust Score copy rows for Update Profile Picture —
  Disable After Used and Update Bio — Disable After Used.
- Removed both fields from the combined generic Phone Farm Update Avatar and
  Update Bio copy settings.
- Trust Score template copying now transfers each disable-after-use setting
  independently between tiers.

## [1.2.444] — 2026-08-09

### Fixed — Trust Score checkbox editability

- Removed Update Avatar and Update Bio Disable After Used from the frontend
  physical-slot ownership map.
- Trust Score settings can now enable or disable both checkboxes instead of
  treating them as locked template fields.
- Assigned Phone Farm slots continue to receive these values from Trust Score
  and cannot edit them locally.

## [1.2.443] — 2026-08-09

### Fixed — Trust Score disable-after-use controls

- Removed the unwanted “(Trust Score)” text from the Disable After Used
  labels.
- Trust Score template editors can now edit and persist both Update Avatar
  and Update Bio Disable After Used checkboxes.
- The live Phone Farm Human Session Tool keeps those controls disabled because
  the behavior is owned by the assigned Trust Score.

## [1.2.442] — 2026-08-09

### Changed — Trust Score owns Update Bio and Avatar disable-after-use

- Update Bio and Update Avatar “Disable After Used” are now controlled by
  Trust Score templates rather than individual Phone Farm device/account-slot
  settings.
- The controls remain available and editable in the Trust Score Human Session
  Tool, where they can be copied with the template’s account-specific settings.
- The same controls remain visible but greyed out in the live Phone Farm Human
  Session Tool, preventing device-level edits to Trust Score-owned behavior.
- Activation percentages, bio text, and avatar source/folder settings remain
  in the Phone Farm tool as physical-slot settings.
- Assigned Trust Scores now inherit the two disable-after-use values through
  the existing template resolution path.

## [1.2.441] — 2026-08-09

### Fixed — Update Bio Edit Profile verification

- Update Bio now recognizes the live Edit profile control through its
  accessibility text, description, content description, or supported resource
  ID instead of relying only on one description attribute.
- The automation no longer reports “tapped Edit profile” immediately after
  dispatching a tap.
- It now confirms that the Edit Profile page actually loaded before continuing
  to the bio field.
- If the page does not load, the log clearly reports the verified-node failure
  and stops the Update Bio path instead of proceeding as though navigation
  succeeded.

## [1.2.440] — 2026-08-09

### Improved — Reels swipe diagnostics

- Reels advance swipes now record the live UIAutomator state immediately
  before and after each gesture, including detected screen markers and visible
  accessibility labels.
- Each entry records the requested swipe mode and the calibrated gesture path
  actually used, making it possible to distinguish a screen transition from
  gesture injection when a device behaves unexpectedly.
- Swipe behavior itself was not changed by this diagnostic update.

## [1.2.439] — 2026-08-09

### Fixed — Reels player detection and Suggestions scrolling

- View Reels no longer depends exclusively on `reel_viewer_*` accessibility
  resource IDs to recognize the player. On Instagram/device builds that render
  the player visibly but omit those IDs from the UIAutomator tree, the focused
  Instagram window is now accepted as the screen-level readiness signal.
- Reels action detection and tapping behavior were not broadened or replaced;
  this change only prevents a false “player never appeared” state before the
  normal Reels flow begins.
- Added a screen-state check before every Reels advance swipe. If Instagram
  has reached the Reels Suggestions surface showing Friends, Popular profiles,
  suggested profiles, or multiple Follow cards, the loop stops before sending
  a Reels swipe through that page.
- Reels cleanup still runs normally after the Suggestions surface is detected,
  preventing the suggestion carousel from being mistaken for another Reel.

## [1.2.438] — 2026-08-09

### Fixed — Follow cleanup navigation

- Follow cleanup now sends a second Android Back press after clearing the
  search field so the first press can dismiss Gboard and the second can leave
  Instagram’s search surface.

## [1.2.437] — 2026-08-09

### Fixed — Installer closes hidden tray process

- Windows installers now stop an existing hidden or tray-running Aura Farming
  process before replacing files, preventing the misleading “Aura Farming
  cannot be closed” prompt when no application window is visible.

## [1.2.436] — 2026-08-09

### Fixed — Windows installer build and default path

- Fixed the installer packaging failure caused by an unsupported
  `defaultDirName` electron-builder option.
- The NSIS installer now opens with
  `C:\Program Files\Aura Farming` as the default while retaining the option
  to choose another directory.

## [1.2.435] — 2026-08-09

### Fixed — Windows installer packaging

- Corrected the NSIS Program Files default-directory macro so the Windows
  installer can package successfully and defaults to
  `C:\Program Files\Aura Farming`.

## [1.2.434] — 2026-08-09

### Fixed — Installer path and mobile automation timing

- Windows installers now default to `C:\Program Files\Aura Farming`, placing
  the application executable at `C:\Program Files\Aura Farming\Aura Farming.exe`.
  The installer still allows choosing a different directory.
- Make a Post now includes the corrected account-slot handling and randomized
  3–5 second Home dwell before continuing.
- View Feed no longer taps Home twice when running inside an automation cycle;
  the existing Home navigation is reused and the duplicate tap is logged as
  skipped.
- Reels action-column accessibility dumps are grouped behind the Debugging Log
  chevron, including timestamp-varying diagnostic rows.

## [1.2.433] — 2026-08-09

### Fixed — Make a Post Home transition timing

- Fixed Make a Post failing immediately after tapping Home because the
  account slot index was not available to the local-image selection step.
- Make a Post now waits a randomized 3–5 seconds after tapping Home before
  continuing, with the selected dwell recorded in the debugging log so the
  transition timing is visible.

## [1.2.432] — 2026-08-09

### Improved — Cleaner Reels action-column logs

- Reels accessibility scans now collapse the full action-column dump behind
  the existing chevron, keeping the Debugging Log readable while preserving
  the complete scan output for expansion, copying, and export.

## [1.2.431] — 2026-08-09

### Fixed — Complete account-slot state reset

- Account saves now purge automation settings belonging to removed slot IDs,
  including legacy numeric slot settings.
- Removed Trust Score assignments and timers are purged during account saves,
  preventing replacement accounts from inheriting badges or countdowns.
- Slot deletion now clears the local badge and timer checkpoints, while the
  server-side save boundary prevents delete/save races from restoring old state.

## [1.2.430] — 2026-08-08

### Fixed — Trust Score slot state isolation

- Fixed deleted account slots leaving their stable Trust Score assignment and
  timer keys behind in the local database.
- Trust Score countdown checkpoints now use the persisted slot identity rather
  than the visible slot index, preventing a replacement account from
  inheriting a deleted account's countdown.
- Deleted slots now clear both stable and legacy local countdown checkpoints.

## [1.2.429] — 2026-08-08

### Fixed — Instagram launch settling

- Added a three-second dwell after launch popup detection so Instagram has
  time to finish rendering the feed before account switching and automation
  actions begin.

## [1.2.428] — 2026-08-08

### Fixed — Follow navigation and Trust Score duration timers

- Fixed Follow Users navigation after opening and following a profile. The
  cleanup now presses Back exactly once to return to Instagram search results,
  instead of pressing Back a second time and landing on the Home feed.
- Removed the extra Back path used when abandoning a pre-follow browsing
  attempt, keeping the flow in the search/Explore context for the next target.
- Fixed Trust Score duration updates so an edited duration becomes authoritative
  for already-assigned accounts, including assignments using legacy numeric slot
  keys.
- Reconciled stale persisted timers with the current Trust Score duration so an
  old timer such as 75 hours cannot continue after the setting is changed to
  50 hours.

## [1.2.427] — 2026-08-08

### Fixed — Follow target validation and Males Only filtering

- Fixed the Human Session Tool Follow Users flow so it requires an exact
  username match in Instagram’s live search results before opening a profile.
  It no longer guesses by first-result order, avatar-ring presence, generic
  row containers, or DPAD navigation.
- When a requested username is not listed, the target is aborted safely, the
  search field is cleared, and the flow continues with the next target instead
  of risking a follow on the wrong account.
- Fixed the Males Only allowlist so configured names match normal Instagram
  display names with spaces, such as `Mario` matching `Mario Zone`.
- Kept username matching strict and boundary-aware, and kept biography matching
  case-insensitive with Unicode word boundaries to avoid unrelated substring
  matches.

## [1.2.426] — 2026-08-08

### Fixed — Account state isolation, Trust Score persistence, and account controls

- Moved the calibrated keyboard buttons for Username, Password, and 2FA OTP
  Secret onto the same row as each field title in the Devices → Accounts
  section, making the controls easier to find without changing their behavior.
- Fixed Trust Score countdowns resetting after application restarts by retaining
  compatibility with older numeric slot keys while migrating them to stable
  account-slot identities.
- Fixed Trust Score template inheritance for accounts whose assignments were
  still stored under the legacy numeric key format.
- Made the Accounts section interactive immediately instead of waiting for
  background profile-based Trust Score hydration to finish.
- Added a complete account-state purge when a farm device is removed. This
  clears its account slots, Human Session Tool settings and toggle state, Trust
  Score badges and timers, and account-scoped histories before the device can
  receive replacement accounts.
- Confirmed the canonical `.github/workflows/build-windows-installer.yml`
  remains the single active Windows Installer workflow. Every push to `main`
  builds the web bundles, packages the Electron application on Windows, and
  uploads the `Aura-Farming-Windows-Installer` artifact to GitHub Actions.

## [1.2.425] — 2026-08-08

### Fixed — Account-switcher profile settling

- Replaced the fixed 700 ms wait after tapping Instagram's Profile tab with
  a randomized 1000–2500 ms profile-header settling delay before locating and
  tapping the username control.

## [1.2.423] — 2026-08-08

### Fixed — Mirror tap-to-type uses calibrated typing

- Fixed the Username, Password, and 2FA OTP Secret keyboard buttons so they
  use the selected device's calibrated keyboard typing profile.
- Typing is sent to whichever Instagram field is currently focused in the
  mirror, including values such as `triciawelch50`.
- Added explicit calibrated-typing logging and success feedback instead of
  routing through the misleading clipboard-paste endpoint.

## [1.2.422] — 2026-08-08

### Fixed — View Feed starts from Home

- View Feed now resolves and taps Instagram's verified Home tab before
  scanning or acting on feed posts.
- If the Home tab cannot be found, View Feed stops explicitly instead of
  operating against a profile, search, Reels, or nested screen.
- Added a short settling delay after the Home tap so the first feed
  accessibility dump belongs to the feed surface.

## [1.2.421] — 2026-08-08

### Fixed — Swipe Profile coordinates sent exactly

- Profile-driven swipes now send the randomized coordinates generated by the
  saved Swipe Gesture Profile directly to Android.
- Removed the hidden legacy center-line jitter from profile-driven swipes so
  the device receives the same path shown in the test preview.
- The swipe test response now reports the exact path sent to the device for
  direct comparison with Android's Pointer location or Show taps overlay.

## [1.2.420] — 2026-08-08

### Fixed — Complete calibrated typing profile delivery

- Included the per-device dwell-time controls in the active calibrated
  keyboard typing path and Phone Farm settings UI.
- Preserved the configured typing-speed, dwell-time, error, and hesitation
  ranges when saving and loading device preferences.
- Included the keyboard-layer position fix so repeated text containing digits
  and symbols returns to the letters layer correctly.
- This release is built by the canonical Windows Installer workflow on every
  push to `main`, with the installer uploaded as
  `Aura-Farming-Windows-Installer`.

## [1.2.419] — 2026-08-08

### Fixed — Calibrated keyboard layer position tracking

- Remembered the selected keyboard layer separately for each device between
  typing calls instead of assuming every call starts on the letters page.
- Corrected the Gboard transition from extended symbols back to letters:
  `more symbols → ?123 → ABC` now uses the required two-step path.
- Added settling time after layer transitions so the next calibrated tap cannot
  land while the keyboard is still changing pages.
- Ensured digit and symbol typing returns the keyboard to the letters layer,
  allowing repeated text such as `Hello12345Hello12345` to type consistently.

## [1.2.418] — 2026-08-08

### Added — Per-scroll personality variation and device swipe timing

- Rolled Feed, Explore, and Reels scroll personalities independently for every
  scroll instead of batching a personality across a session.
- Allowed natural repeated personalities while limiting long identical runs and
  repeated Back-scrolls.
- Added per-device pre-swipe pause and post-swipe settling ranges to the saved
  Swipe Gesture Profile.
- Removed acceleration and deceleration controls because the active automation
  transport does not support them reliably.
- Updated the Windows installer version to 1.2.418.

## [1.2.417] — 2026-08-08

### Fixed — Swipe Gesture Profile enforcement

- Removed hardcoded fallback swipe paths and durations from profile-dependent
  Phone Farm content scrolling.
- Instagram Feed, Explore, Reels, profile grids, and account-list scrolling now
  require the connected device's saved Swipe Gesture Profile.
- Chrome search/article scrolling and YouTube feed/Shorts scrolling now use the
  saved per-device duration range instead of their own fixed timing.
- Invalid or missing swipe profiles now fail explicitly rather than silently
  using generated coordinates or default durations.
- Fixed-purpose system gestures such as recents dismissal and screen navigation
  remain intentionally independent of the content swipe profile.
- Updated the Windows installer version to 1.2.417.

## [1.2.416] — 2026-08-08

### Added — Account field keyboard typing

- Added type icons beside Username, Password, and 2FA OTP Secret in each
  Phone Farm account slot.
- Each icon sends the current field value to the connected phone's focused
  keyboard field through the calibrated real-tap typing path.
- The existing per-device typing speed and error-causality profile is applied,
  including per-character delays and corrected simulated typing errors.
- Empty fields and unavailable devices now report a clear failure instead of
  silently doing nothing.
- Updated the Windows installer version to 1.2.416 so the packaged desktop
  build includes this feature.

## [1.2.415] — 2026-08-07

### Added — Downloadable Windows installer workflow

- Added a canonical GitHub Actions workflow that builds the web app and packages
  the Windows Electron installer.
- Successful runs provide an `Aura-Farming-Windows-Installer` download in the
  Actions artifacts section.
- Version-tagged runs also publish the installer to GitHub Releases.

## [1.2.414] — 2026-08-07

### Fixed — Phone Farm keyboard calibration coordinate mapping

- Fixed the bottom row of the Phone Farm keyboard calibration being saved in
  the wrong vertical position on devices where the UIAutomator root does not
  include the full navigation area.
- Physical calibration taps now use the device's current logical `wm size`,
  matching the coordinate space used by `adb shell input tap` and live
  accessibility bounds.
- Calibration now accounts for both the minimum and maximum values advertised
  by the touchscreen's raw X/Y axes instead of assuming every axis starts at
  zero.
- Screen coordinates are clamped to the current logical display so noisy raw
  touch values cannot create out-of-bounds saved key positions.
- Added device-side calibration diagnostics showing the touchscreen device,
  raw axis ranges, logical display size, captured raw point, and mapped screen
  point in the API log.
- The display size is read fresh for every captured key, preventing a stale
  session cache from surviving a device display override change.

### Build — Windows installer Actions workflow

- `build-windows-installer.yml` remains the single active Windows installer
  workflow.
- The workflow still builds the API server and frontend, bundles Electron,
  creates the Windows installer, and uploads the complete
  `Aura-Farming-Windows-Installer` artifact.
- The other Windows-related workflow files remain inert `workflow_call` stubs
  so GitHub Actions cannot start duplicate installer builds.

## [1.2.413] — 2026-08-07

### Fixed — Windows installer dependency step

- Removed the redundant `npm install` from the Windows installer workflow.
- The repository is a pnpm workspace, so the preceding workspace install
  already installs and links the Electron package dependencies.
- Running npm install again inside `artifacts/electron` caused npm to execute
  the `cycletls` package build and fail on GitHub Actions because its optional
  `concurrently` command was not available in that nested npm context.
- The workflow now uses the dependencies from the workspace install and invokes
  Electron Builder through pnpm, allowing the Electron bundle and Windows
  installer steps to run with the same package-manager layout.

### Build — Windows installer Actions workflow

- `build-windows-installer.yml` remains the single canonical Windows installer
  workflow.
- It continues to build the API server and frontend, bundle Electron, create
  the Windows installer, and upload the generated `.exe` artifact.

## [1.2.412] — 2026-08-07

### Fixed — Inject Browsing now reverses the configured account swipe

- Fixed Phone Farm Human Session Tool → Follow Users → Inject Browsing returning
  through a profile grid in the same direction as the original browsing swipe.
- The account/device-specific swipe gesture configured in the Mobile device
  settings is now used for both directions: the return gesture swaps the saved
  start and end points instead of replaying the forward gesture.
- The correction applies when returning to the profile top before highlights,
  when recovering from a post-thumbnail that did not open, and when restoring
  the profile top before the Follow button is used.
- The number of return swipes remains exactly equal to the number of profile-grid
  rows that were scrolled, preventing an extra swipe from overshooting the
  profile and triggering pull-to-refresh.
- The existing fallback swipe remains available on devices without a saved
  gesture profile, while configured devices now consistently use their
  calibrated per-device path.

### Build — Windows installer Actions workflow

- The canonical `build-windows-installer.yml` workflow remains the single
  Windows installer workflow triggered by pushes to `main`, version tags, and
  manual dispatch.
- It builds the API server and frontend, bundles Electron, creates the Windows
  installer, and uploads the generated executable as
  `Aura-Farming-Windows-Installer`.
- The workspace and Electron versions are both bumped to `1.2.412` so the
  installer and updater use the same release version.

## [1.2.411] — 2026-08-07

### Fixed — Pause Human Session Tool when a phone is offline

- Human Session Tool automation now stops immediately when a Phone Farm device
  is still listed but ADB reports that it is `offline` or otherwise not ready.
- Every account slot on the affected device is paused together, so no slot can
  continue sending automation commands to a phone whose USB/ADB transport has
  dropped.
- Scheduled timers, queued Collision Preventer turns, and an in-progress
  automation cycle are cancelled when the device becomes unavailable.
- The saved Human Session Tool toggle is preserved. When the same phone
  reconnects and returns to the ready ADB `device` state, its saved automation
  schedule can resume without requiring the user to re-enable it.
- The slot list now clearly shows `Paused — Offline` instead of suggesting that
  an enabled slot is actively ready to run.
- The API performs its own live ADB readiness check immediately before starting
  every automation cycle. Stale browser state can therefore not start a cycle
  against a missing, unauthorized, or offline device.

### Build — Windows installer Actions workflow

- Confirmed the Windows installer build is handled by the canonical
  `build-windows-installer.yml` workflow.
- The workflow builds the API server and frontend, bundles the Electron
  application, creates the Windows installer, and uploads the `.exe` as the
  `Aura-Farming-Windows-Installer` Actions artifact.
- The application version is bumped to `1.2.411` in both the workspace package
  and Electron package so the generated installer and updater see the release
  correctly.

## [1.2.410] — 2026-08-07

### Added — Draggable Keyboard Calibration panel

- Added drag positioning to the Keyboard Calibration panel in the Phone Farm
  Mobile device view.
- The panel can now be repositioned by dragging its title bar, allowing it to
  be moved away from the phone mirror and placed wherever it is most useful
  during calibration.
- Dragging is limited to the visible application window so the panel cannot be
  lost off-screen.
- Calibration controls remain fully interactive because only the title bar
  starts a drag; buttons, key rows, and the close control keep their existing
  behavior.
- The panel returns to its default top-right position each time a new
  calibration session is opened.

## [1.2.410] — 2026-08-07

### Added — Keyboard calibration TEST TEXT

- Added a `TEST TEXT` field and `TEST` button to the Phone Farm keyboard
  calibration prompt.
- The test types each entered character through the saved per-device
  calibration coordinates, including the existing ABC, symbols, and extended
  symbol layer navigation.
- Calibration tests refuse fallback typing and report missing mapped keys in
  the prompt and device log so an incomplete calibration cannot appear valid.
- The Windows installer build remains the canonical GitHub Actions workflow and
  packages this update as version `1.2.410`.

## [1.2.409] — 2026-08-06

### Changed — Humanized ADB text input

- Added randomized 150–1500 ms delays between characters for the three
  designated ADB shell paste locations: Mirror Paste, Follow username entry,
  and Human Session Tool Update Bio.
- Kept Make a Post caption and location input on the existing bulk-input path.

## [1.2.408] — 2026-08-06

### Changed — Reels repost confirmation handling

- The Human Session Tool Reels flow now checks for Instagram’s Close dialog
  only after Share to Feed is tapped.
- The Close button is resolved from the live accessibility tree before it is
  tapped.
- Reels that are only viewed no longer incur an unnecessary dialog scan.

## [1.2.408] — 2026-08-06

### Changed — Make a Post location setting ownership

- Make a Post → Add location is now an account-slot setting owned by the
  Human Session Tool.
- It remains editable in the Human Session Tool and can be copied to other
  account slots through Human Session Tool Copy Settings.
- It is locked out of TrustScore editing and excluded from TrustScore-to-
  TrustScore Copy Settings.

## [1.2.406] — 2026-08-06

## [1.2.407] — 2026-08-06

### Changed — Use ADB text input for all mobile paste actions

- Mirror Paste now uses the ADB shell text-input path.
- Follow target usernames now use the same ADB text-input path.
- Random Actions → Update Bio now uses ADB text input instead of Android
  clipboard paste.
- This removes the Android clipboard dependency from all three mobile paste
  flows.

### Fixed — Restored the documented Windows installer workflow

- Restored the canonical `Windows Installer` workflow required by the project
  instructions.
- Restored the deprecated workflow files as inert `workflow_call` stubs so
  GitHub’s workflow configuration matches the documented repository layout.
- The canonical workflow can be started manually or by pushing to `main`, builds
  the Windows installer, and uploads `Aura-Farming-Windows-Installer`.

### Changed — GitHub Actions workflow cleanup

- Removed the four obsolete Windows installer workflow definitions that were
  still appearing as separate entries in the repository Actions sidebar.
- Kept `Windows Installer Download` as the single canonical Windows installer
  workflow.
- The canonical workflow remains manually triggerable with `workflow_dispatch`,
  runs for pushes to `main`, builds the Windows installer, and uploads the
  `Aura-Farming-Windows-Installer` artifact.

## [1.2.405] — 2026-08-06

### Changed — Update Bio and Update Avatar ownership

- Update Bio and Update Avatar activation values and one-time-use settings are
  now owned by each Human Session Tool account slot.
- These settings remain editable in the Human Session Tool Random Actions area
  and can be copied to other account slots through Copy Settings.
- TrustScore-assigned Human Session Tool slots now keep these settings locked,
  so they cannot be edited from TrustScore settings.
- Update Bio and Update Avatar settings are excluded from TrustScore-to-TrustScore
  Copy Settings, preventing activation values from being copied between tiers.

## [1.2.405] — 2026-08-06

### Fixed — Deleted Mobile account slots no longer leak state

- Deleting an account slot now immediately removes its saved slot automation
  settings instead of leaving them attached to the reusable slot index.
- Deleted slots also clear their TrustScore assignment and TrustScore timer from
  the server database.
- The browser-local TrustScore badge state is cleared at the same time.
- Adding a replacement account before restarting the app now starts with the
  normal defaults and no TrustScore badge or inherited settings from the
  deleted account.
- Existing slots and their settings are not changed.

## [1.2.405] — 2026-08-06

### Fixed — Mobile mirror Paste reads the Windows clipboard

- Fixed the Mobile mirror Paste action reporting that the desktop clipboard was
  empty or unavailable in the Windows Electron app even when the same content
  could be pasted into Notepad.
- Added a native Electron clipboard-read bridge and made the mirror Paste
  action use it before the browser clipboard API.
- Kept the Android clipboard-service write and native `KEYCODE_PASTE` path
  unchanged after the desktop text is successfully read.

## [1.2.405] — 2026-08-06

### Build — Dedicated Windows installer download workflow

- Added `.github/workflows/windows-installer-download.yml`, a separately named
  GitHub Actions workflow: **Windows Installer Download**.
- The workflow runs on pushes to `main` and can also be started manually with
  **Run workflow**.
- It builds the API server, frontend, Electron bundle, and Windows installer
  on `windows-latest`.
- It verifies that an `.exe` was actually produced before uploading it.
- It uploads the installer as the clearly named
  `Aura-Farming-Windows-Installer` artifact for download from the completed run.
- This is in addition to the existing canonical installer workflow and does not
  reactivate the deprecated duplicate workflow files.

## [1.2.405] — 2026-08-06

### Build — Windows installer workflow visibility

- Confirmed `.github/workflows/build-windows-installer.yml` is the active workflow on `main`.
- Renamed the active GitHub Actions workflow to **Windows Installer** so it is clearly visible in the Actions list.
- Preserved automatic runs for pushes to `main`, version tags, and manual `workflow_dispatch`.
- Kept the deprecated duplicate workflow files inert so only one installer build runs.

## [1.2.405] — 2026-08-06

### Fixed — Mobile Instagram right-click paste

- Keep right-clicks on the phone mirror out of the normal tap/drag pipeline so
  they cannot move Instagram away from the focused Bio field.
- Make the Mobile mirror Paste action write the desktop clipboard to Android's
  clipboard service and send native `KEYCODE_PASTE`, matching Update Bio and
  Follow username entry.
- Preserve multiline bios, punctuation, and other characters that
  `adb shell input text` can lose in Instagram editors.

### Build — Windows installer delivery

- Kept `.github/workflows/build-windows-installer.yml` as the single active
  Windows installer workflow.
- Confirmed pushes to `main` and manual workflow dispatch both run the API and
  frontend builds, package the Electron app on Windows, and upload the full
  `Aura-Farming-Windows-Installer` artifact.
- Preserved the workflow's version/changelog checks and its protection against
  duplicate installer workflows.

## [1.2.404] — 2026-08-06

### Fixed — Ghost Browser Instagram right-click paste

- Restored the native Chromium/Electron context menu inside the Ghost Browser
  while preserving the automation input protections used by the signup flow.
- Allowed real right-click mouse events to reach editable Instagram fields so
  users can right-click and choose Paste when entering Bio Spin text or other
  manually entered values.
- Kept automated touch-based taps working without exposing ordinary left-click
  and hover events to Instagram's page scripts.
- Verified the frontend production bundle and Electron bundle both build
  successfully.

### Build — Windows installer workflow

- Confirmed `.github/workflows/build-windows-installer.yml` remains the single
  canonical installer workflow.
- The workflow runs on pushes to `main`, validates that the root and Electron
  versions match the changelog, builds the API and frontend bundles, packages
  the Windows Electron installer, and uploads
  `Aura-Farming-Windows-Installer` to the Actions run.
- Kept deprecated duplicate workflow files inert so a push cannot start
  competing installer builds.

## [1.2.403] — 2026-08-06

### Build — Complete GitHub Windows installer push

- Included the uploaded Search-tab reference image in the repository so the latest investigation assets are preserved with the code.
- Verified that `.github/workflows/build-windows-installer.yml` is the single canonical GitHub Actions workflow for Windows installer builds.
- Confirmed that every push to `main` runs the web/API build, packages the Electron application on `windows-latest`, and uploads the `Aura-Farming-Windows-Installer` artifact.
- Kept the older Windows workflow files as inert compatibility stubs to avoid duplicate installer builds.

## [1.2.402] — 2026-08-06

### Fixed — Instagram Search node detection

- Make Search-tab and Search-bar lookups independent of UIAutomator attribute order.
- Prefer the live Instagram search node and reject unrelated top-screen text fields.
- Log the selected search node and bounds-derived tap location for diagnosis.

## [1.2.401] — 2026-08-06

### Added — Per-device mirror keyboard calibration

- Keep keyboard calibration open beside the live phone mirror instead of blocking mirror interaction.
- Capture real Android keyboard taps from each device's mirror and save their native coordinates per device.

## [1.2.400] — 2026-08-06

### Fixed — Clipboard text entry

- Keep Update Bio and Follow username entry as one backend clipboard write followed by one native paste.
- Remove the unsupported character-by-character clipboard loop.

## [1.2.399] — 2026-08-06

### Fixed — Update Bio navigation and Reels debugging-log grouping

- Press a second guarded Back after saving a bio so shuffled tools start outside the surrounding Edit Profile/Settings surface.
- Display Reels debugging-log rows in red and collapse consecutive Reels activity behind the chevron while preserving full Copy/Export content.

## [1.2.398] — 2026-08-06

### Added — Directional swipe start jitter

- Add per-device minimum and maximum Y offsets so forward swipes can begin at a randomized point below the configured blue start reference.
- Preserve exis