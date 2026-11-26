---
name: Snapchat Add Friends contact positioning
description: Import Inspect dumps into a simple phone preview that exercises Add Friends positioning and scrolling.
---

## Add Friends screen test

Replay examples imported into the frontend are required source assets, not disposable uploads. Keep explicit tracking exceptions when repository-wide upload ignore rules would exclude them.

**Why:** Replit built successfully with local examples while the Windows checkout failed because those imported text files were ignored.

**How to apply:** Check that every build-time example dependency is included in a clean checkout; a successful build with ignored local files does not prove portability.

### Daily Max Follows

Max Follows is an optional Min/Max daily cap per account slot. Draw once for the PC-local date, persist the draw across cycles/restarts, count Add Friends actions, and skip the tool before navigation once reached until the next date. Include the checkbox and both bounds in Copy Settings. Keep replacement account usernames isolated when a slot is reused.

**Why:** The user requested a daily randomized maximum that stops every later Add Friends run for that account slot until the following day.

**How to apply:** Use persisted action counts, including actions before metrics flush, and seed available same-day statistics. Never redraw per cycle or copy a slot's consumed count/random draw through Copy Settings.

The Settings replay must execute the actual current Add Friends tool, not a separate simulation of its decisions or a helper-only preview. Load or paste an Inspect dump, render a basic Snapchat screen, and run one real tool action plus its post-action handling. Recompile the current source on each run so code changes can be tested immediately.

**Why:** The user wants to test code changes inside Replit against imported device examples instead of waiting for repeated Windows Electron builds.

**How to apply:** Replace only device input/output and storage boundaries; keep the tool entrypoint, filters, taps, reads, measurement, and scrolling code real. Stream the resulting device inputs and screen states automatically. Do not precompute a successful result, force the next contact's position, or require a second preview-only button to apply a completed scroll. Keep replay history isolated from the farm-wide list. Preserve contact names and each row's reported height, and allow another real step or reset.

The replay UI must not expose a user-selected scroll amount or movement scale. Production gestures are calculated from the imported device's live screen dimensions and row positions, then adjusted from observed movement; replay scaling belongs only in regression tests.

**Why:** The user requires per-device, on-the-fly positioning and rejected a replay control that implied scroll travel was a configurable setting.

**How to apply:** Keep the Settings replay focused on importing an Inspect dump and running the current tool. Do not infer real touch response from a static dump; only a live device swipe and fresh UI read can measure that device's movement.

### Preserve real card states in replay

The configured Min/Max delay in seconds applies only between Add attempts, not Skip or Dismiss actions. Keep it distinct from the fixed post-action settle before measuring and scrolling.

**Why:** The user explicitly clarified that the allocated wait time is for Adds only, never skips or dismissals.

**How to apply:** Consume the configured delay inside the completed Add sequence, after its scroll and before considering another contact (unless the requested Add count is complete). Never defer an Add's pending delay until the next eligible Add: intervening dismissals would then appear to trigger that wait. Skip and Dismiss retain only their fixed pre-scroll settle.

After each Add, Dismiss, or Skip action, wait about three seconds before reading the resulting card and scrolling. Preserve this delay in the visible replay too.

**Why:** The user explicitly requires action → three-second settle → scroll so the action result is visible before movement.

**How to apply:** Keep the post-action delay in the real tool; the replay must not shorten it.

Do not invent a subtitle for a missing `result-reason`. Blank, mutual-friends, recently-joined, contact-book, and wrapped-name cards must retain their own imported heights. Keep the imported visible position; RecyclerView's cached y=0 cards belong off-screen, not ahead of the visible cards. Every recommendation in the test screen needs a Dismiss control.

Dismiss must replace the recommendation with Snapchat's feedback card (including its changed height, feedback choices, and Undo), reflow subsequent cards, and expose that intermediate state before scrolling. Do not model dismissal as deleting the row or merely changing the Add label.

**Why:** The user supplied paired before/after Inspect examples and wants a faithful screen test, not a simplified success animation. Snapchat reuses the same row-container identifier for contacts and dismissal feedback; assuming every row is a named contact falsely reports that scrolling is already complete.

**How to apply:** Distinguish named contacts from feedback when choosing the next target. Test the real Dismiss alignment helper against the feedback state, not the normal Add/Skip helper against a relabeled row. Preserve the feedback row in the scrollable content until it moves above the viewport.

## Position the selected contact before acting

Incoming “Added Me” requests must never be processed by Add Friends. Restrict recommendation candidates to the Find friends section. If Added Me is above it, position the first named recommendation using its live row bounds; do not trust the section heading alone because it can stick while rows continue moving.

**Why:** Incoming requests can push recommendations down the page, but a heading can remain pinned while rows move. Heading-only success checks allowed large scrolls to pass multiple contacts.

**How to apply:** Use the live heading and first recommendation row as an anchor, preserve the row's offset below its heading, and verify that same named row reaches its target after each forward swipe. Calibrate finger travel from observed row movement; refuse the action if the anchor disappears or overshoots. Keep Accept Friends separate.

For every Add, Skip, or Dismiss decision, first move that exact contact to the first visible contact position. Re-dump the UI and reselect the same contact and its live action control before tapping. After the action, measure that contact's live card and move the next contact to the same first position.

**Why:** A run acted on a card at y=1340 while the first contact started at y=588. The post-action logic then tried to correct a 752px gap, overshot, and reversed direction. Per-card scroll measurement does not fix acting on a lower row.

**How to apply:** Decide the action first; align the matched named row to the first visible row before tapping; refresh and verify the same row/action; then take the post-action measurement and advance one card. If the selected row or its live action cannot be re-identified after positioning, do not tap a different row.

## Avoid Users Containing dismissals

Never long-press a suggestion. Tiny vertical swipes can be interpreted as contact holds; treat near-aligned rows as aligned, require meaningful travel and a sufficiently wide verified blank lane for scrolling, and log the dispatched coordinates.

When a suggestion matches the farm-wide Skip Added list, dismiss it with its live Hide/X control instead of skipping or scrolling past it. If Hide is unavailable or the row remains afterward, stop rather than Add or bypass that contact.

When Add Friends' “Avoid Users Containing” filter matches a suggestion, tap the `friend-cell-dismiss` Hide control inside that exact friend row. Before any Add, Skip, or Dismiss, align that exact contact to the first visible row, then refresh and reselect it. After Add or Skip, use a fresh UI dump and screenshot to measure the live target card's grey-divider-to-grey-divider height, swipe that distance, then verify and correct the next contact's position using observed movement. Dismiss is different: Snapchat removes the named row and can replace it with a feedback notice, so do not try to measure dividers around the vanished contact or mistake the next named row for that card. Record the dismissed row's top before tapping Hide; after the action, align the first remaining named contact to that top using its fresh UI row position, then verify actual travel and use up to three bounded movement-scaled corrections if needed.

**Why:** The user clarified the supplied UI trees are structural examples, not evidence from a run. The real failure is insufficient content travel: Android can move the list fewer pixels than the finger swipe. Per-contact measurement must be followed by checking actual row movement and scaling any correction to that movement, not treating extra wait time as the fix.

**How to apply:** Decide Add, Skip, or Dismiss before scrolling. Position the selected contact at the first visible row, refresh, and verify its live action control before tapping. Find Hide by `friend-cell-dismiss` inside the matched row. Before Add or Skip, save the exact next contact's name and the target top. After the action, refresh and locate that same next contact; if its live top already matches the saved target, do not swipe. Otherwise calculate travel from the live top difference, preserve the measured swipe speed, and verify that exact name after each movement. Do not use the action-row container height as the distance to the next contact. After Dismiss, save the dismissed row's top and align the first remaining named contact to it. Never use median card height, guessed row bounds, or wait time as a substitute for measurement.

### Forward-only contact settling

After moving past incoming “Added Me” requests, the first Find friends contact belongs at the top contact position. After each Add or Skip, the exact next contact must move to that same position; after Dismiss, align the first remaining contact to the dismissed row's saved top. All list movement must advance forward; never swipe backward to correct an overshoot. Calibrate finger travel from observed row movement and preserve its duration-per-pixel when applying the ratio to another distance. If the expected contact is missing, above target, or overshoots, do not select a later visible row or continue the tool on an unverified contact.

**Why:** A real v1.2.684 run sent a 184px/300ms post-Add swipe after calibrating at about 2.8ms per pixel; it moved past Stitch. Snapchat can reflow the list after Add, and row-container height is not necessarily the pitch to the next contact.

**How to apply:** Capture the next contact's name and the selected row's top before Add/Skip. Afterward, resolve that name exactly; skip scrolling if it already occupies the saved top, otherwise calculate from its live top delta and use the calibrated duration. If the name is absent or movement cannot be verified, stop before another contact action. Add Friends uses direct ADB `input swipe` with legacy coordinate jitter disabled; it does not apply Snapchat's Swipe Personality, though native Android/Snapchat scroll physics still depend on gesture timing.

Open Add Friends from Camera by locating the live `neon_add_friend_button_container` or the accessible “Add friends” label and its clickable parent. A banner obstruction must be a top overlay identified by Snapchat's incoming-event copy (such as “is typing” or “sent you a Snap”), a banner/toast/notification resource or class, or Android System UI. Its bounds must cover the icon's tap point. Never infer a banner from generic clickability, text, or overlap geometry alone: a normal “Flip Camera” accessibility group can span across the Add icon. If a real banner overlaps the icon's tap point, wait five seconds and recheck up to ten times. Tap immediately after a clear check; if still covered at check ten, skip only Add Friends rather than aborting the cycle. Do not use deep links, internal activity launches, fixed coordinates, or a fixed device serial. On the Find Friends list, use the current UI dump's matched row and tap its live Add button directly; do not traverse keyboard Tab focus between friends. The user's Tab exploration applied only to the Camera-screen icon. For each Add Friends target, decide Add, Skip, or Dismiss first; after Add/Skip, carry forward the exact next row's name and target top captured before the action, then use live row-top delta and calibrated swipe duration. Never substitute the `scu_search_friend_cell` container height for the gap to the next contact. If Snapchat already reflows the next contact into the target, do not swipe. Verify the exact next name after movement; if missing or overshot, stop before another contact is selected. After Dismiss, save the dismissed row's top before tapping Hide and align the first remaining named contact to that saved position. Exclude Add buttons below 85% of screen height, and keep scroll endpoints above 82%, so the next tap stays clear of Android's bottom navigation. Count a matched Find Friends row's Add action without requiring Snapchat to replace the label or show a confirmation. Accept Friends independently measures Added Me row movement in its own helper; when Snapchat still shows Accept, skip that row and continue with other requests. If an incoming banner redirects the flow to a chat/composer, back out without typing, restore Add Friends, and retry that same row; after repeated interruptions, skip only that row and continue the cycle.

**Why:** The inspect dump showed the broad geometric test matching the normal “Flip Camera” group because its bounds crossed the Add icon. The user means Snapchat's brief incoming-Snap/typing banner, not arbitrary camera controls. The user also requires at most ten checks, no global 60-second Snapchat idle abort, and no Tab navigation through friend rows; Tab was only explored for opening Add Friends from Camera. A live Add Friends screen showed lower-row Add controls near Android navigation, where an ad can obscure them. A real run demonstrated that the accessibility container's 182px height and the actual next-contact position are not interchangeable; the post-Add swipe skipped Stitch. The user requires live, device-specific positioning, not a fixed amount. Use the named next-row top delta and measured movement speed; waiting or row-height fallback is not the fix. Never swipe down the row center: the name/avatar can receive it as a tap instead of scrolling. Use a node-verified blank side margin or refuse to swipe. The per-contact rule applies after Add, Skip, and Dismiss, even when Hide refreshes the list.

**How to apply:** Resolve the live icon from its resource ID or “Add friends” accessibility label, including its clickable parent. In the latest UI dump, require incoming-event text or a banner/notification identifier on a top overlay that covers the tap point; generic camera accessibility groups must never qualify. Do not add another device query between a clear result and the tap. Log each numbered banner check. After ten blocked checks, skip only this tool. For each friend row, identify the name, live row bounds, and Add button from one fresh dump; decide its action, align that named contact to the first visible row, then refresh and re-identify the same contact and action button before tapping directly without Tab traversal. Before Add/Skip, save the immediate next contact's exact name and the selected row's top. Afterward, re-dump and locate that name; if already at the saved top, do not scroll. Otherwise use the current next-row top minus saved target top as the requested content travel, scale by measured per-device movement, and keep duration-per-pixel consistent. Verify actual movement of the same name after each correction. If the next name is missing, above target, or overshot, stop before selecting another contact. After Dismiss, save the dismissed row's top before tapping; once Hide changes/removes it, use the first remaining named contact's fresh row top as the live position and align it to the saved top. Never fall back to the full accessibility container height or guess from a screenshot when the exact next row is not exposed. Wait only as needed to read the settled position; don't treat delay as the fix or infer measurements from structural example attachments. Swipe along a node-verified blank side margin rather than across any contact content; if no safe lane is exposed, refuse the swipe. Keep Add Friends and Accept Friends implementations in their separate tool-owned files. Preserve the live row-to-button identity match and attempted-row history. Do not count a change of Add label as required confirmation. On an unexpected chat surface, use Back to dismiss the keyboard and leave the chat, then return to Add Friends before retrying. In the isolated Accept Friends flow, keep the confirmation for accepted metrics; if the same row still shows Accept or cannot be confirmed, mark it attempted and continue through other requests. When enabling Friend Suggestions opens Snapchat's "Think carefully before adding and accepting friends" warning, locate the live clickable parent for the exact “OK” or “Okay” text before continuing; Snapchat may report “OK” rather than the longer spelling in the UI tree.
