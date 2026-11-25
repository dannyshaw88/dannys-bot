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

For every Add, Skip, or Dismiss decision, first move that exact contact to the first visible contact position. Re-dump the UI and reselect the same contact and its live action control before tapping. After the action, measure that contact's live card and move the next contact to the same first position.

**Why:** A run acted on a card at y=1340 while the first contact started at y=588. The post-action logic then tried to correct a 752px gap, overshot, and reversed direction. Per-card scroll measurement does not fix acting on a lower row.

**How to apply:** Decide the action first; align the matched named row to the first visible row before tapping; refresh and verify the same row/action; then take the post-action measurement and advance one card. If the selected row or its live action cannot be re-identified after positioning, do not tap a different row.

## Avoid Users Containing dismissals

Never long-press a suggestion. Tiny vertical swipes can be interpreted as contact holds; treat near-aligned rows as aligned, require meaningful travel and a sufficiently wide verified blank lane for scrolling, and log the dispatched coordinates.

When a suggestion matches the farm-wide Skip Added list, dismiss it with its live Hide/X control instead of skipping or scrolling past it. If Hide is unavailable or the row remains afterward, stop rather than Add or bypass that contact.

When Add Friends' “Avoid Users Containing” filter matches a suggestion, tap the `friend-cell-dismiss` Hide control inside that exact friend row. Before any Add, Skip, or Dismiss, align that exact contact to the first visible row, then refresh and reselect it. After Add or Skip, use a fresh UI dump and screenshot to measure the live target card's grey-divider-to-grey-divider height, swipe that distance, then verify and correct the next contact's position using observed movement. Dismiss is different: Snapchat removes the named row and can replace it with a feedback notice, so do not try to measure dividers around the vanished contact or mistake the next named row for that card. Record the dismissed row's top before tapping Hide; after the action, align the first remaining named contact to that top using its fresh UI row position, then verify actual travel and use up to three bounded movement-scaled corrections if needed.

**Why:** The user clarified the supplied UI trees are structural examples, not evidence from a run. The real failure is insufficient content travel: Android can move the list fewer pixels than the finger swipe. Per-contact measurement must be followed by checking actual row movement and scaling any correction to that movement, not treating extra wait time as the fix.

**How to apply:** Decide Add, Skip, or Dismiss before scrolling. Position the selected contact at the first visible row, refresh, and verify its live action control before tapping. Find Hide by `friend-cell-dismiss` inside the matched row. After an action, refresh the UI tree, find the same named row (or the row at its prior vertical position if Dismiss removed it), capture one screenshot, and measure the two grey divider pixels bracketing that row. Use exactly that gap for the first swipe in a node-verified blank margin. Compare the next contact's row top with the first visible contact's top. If the list moved short, scale each correction distance by the observed content movement per finger pixel, up to three safe correction attempts; verify the final position. Do not use median card height, guessed row bounds, or treat wait time as the fix.

Open Add Friends from Camera by locating the live `neon_add_friend_button_container` or the accessible “Add friends” label and its clickable parent. A banner obstruction must be a top overlay identified by Snapchat's incoming-event copy (such as “is typing” or “sent you a Snap”), a banner/toast/notification resource or class, or Android System UI. Its bounds must cover the icon's tap point. Never infer a banner from generic clickability, text, or overlap geometry alone: a normal “Flip Camera” accessibility group can span across the Add icon. If a real banner overlaps the icon's tap point, wait five seconds and recheck up to ten times. Tap immediately after a clear check; if still covered at check ten, skip only Add Friends rather than aborting the cycle. Do not use deep links, internal activity launches, fixed coordinates, or a fixed device serial. On the Find Friends list, use the current UI dump's matched row and tap its live Add button directly; do not traverse keyboard Tab focus between friends. The user's Tab exploration applied only to the Camera-screen icon. For each Add Friends target, decide Add, Skip, or Dismiss first; after the action, re-dump and measure that contact card's own grey-divider distance from one screenshot. If Dismiss removes the row, measure the live row now occupying its former vertical position. Do not substitute a median or another contact's height. Use that exact distance for one swipe in a node-verified blank margin. Exclude Add buttons below 85% of screen height, and keep scroll endpoints above 82%, so the next tap stays clear of Android's bottom navigation. Count a matched Find Friends row's Add action without requiring Snapchat to replace the label or show a confirmation. If a measured scroll cannot be placed or verified, continue with other currently visible unattempted rows. Accept Friends independently measures middle Added Me row boundary distance and actual content movement in its own helper; when Snapchat still shows Accept, skip that row and continue with other requests instead of aborting the tool. If an incoming banner redirects the flow to a chat/composer, back out without typing, restore Add Friends, and retry that same row; after repeated interruptions, skip only that row and continue the cycle.

**Why:** The inspect dump showed the broad geometric test matching the normal “Flip Camera” group because its bounds crossed the Add icon. The user means Snapchat's brief incoming-Snap/typing banner, not arbitrary camera controls. The user also requires at most ten checks, no global 60-second Snapchat idle abort, and no Tab navigation through friend rows; Tab was only explored for opening Add Friends from Camera. A live Add Friends screen showed lower-row Add controls near Android navigation, where an ad can obscure them. The user clarified the supplied UI trees are structural examples, not run evidence, and the actual issue is insufficient scroll travel; don't infer the run's pixel heights or settling from those attachments. UIAutomator does not expose the grey separators as nodes; using a contact's node bounds as the requested line-to-line pixel measurement is not equivalent and must not be claimed as such. The user requires one screenshot and one line-to-line measurement per contact, with the first swipe using exactly that measured distance. Verify actual content movement from live row positions and scale up to three bounded corrections to that movement; waiting alone is not the fix. Never swipe down the row center: the name/avatar can receive it as a tap instead of scrolling. Use a node-verified blank side margin or refuse to swipe. The per-contact rule applies after Add, Skip, and Dismiss, even when Hide refreshes the list.

**How to apply:** Resolve the live icon from its resource ID or “Add friends” accessibility label, including its clickable parent. In the latest UI dump, require incoming-event text or a banner/notification identifier on a top overlay that covers the tap point; generic camera accessibility groups must never qualify. Do not add another device query between a clear result and the tap. Log each numbered banner check. After ten blocked checks, skip only this tool. For each friend row, identify the name, live row bounds, and Add button from one fresh dump; decide its action, align that named contact to the first visible row, then refresh and re-identify the same contact and action button before tapping directly without Tab traversal. After Add or Skip, take a fresh UI dump and one screenshot, measure that exact current card's grey-divider gap, swipe exactly that distance in a node-verified blank margin, then correct up to three times based on actual list movement. After Dismiss, save the dismissed row's top before tapping; once Hide changes/removes it, use the first remaining named contact's fresh row top as the live position and align it to the saved top. Verify movement and, if short, apply up to three bounded corrections scaled to observed movement. Never require grey-divider detection for a row Snapchat has already removed or replaced with a feedback notice. Wait only as needed to read the settled position; don't treat delay as the fix or infer measurements from structural example attachments. Swipe along a node-verified blank side margin rather than across any contact content; if no safe lane is exposed, refuse the swipe. Keep Add Friends and Accept Friends implementations in their separate tool-owned files. Preserve the live row-to-button identity match and attempted-row history. Do not count a change of Add label as required confirmation. On an unexpected chat surface, use Back to dismiss the keyboard and leave the chat, then return to Add Friends before retrying. In the isolated Accept Friends flow, keep the confirmation for accepted metrics; if the same row still shows Accept or cannot be confirmed, mark it attempted and continue through other requests. Apply the same one-screenshot, one-measurement, exact-distance swipe independently in Added Me. When enabling Friend Suggestions opens Snapchat's "Think carefully before adding and accepting friends" warning, locate the live clickable parent for the exact “OK” or “Okay” text before continuing; Snapchat may report “OK” rather than the longer spelling in the UI tree.
