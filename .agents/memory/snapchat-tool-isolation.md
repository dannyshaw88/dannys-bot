---
name: Snapchat module isolation
description: Keep each Snapchat tool, its settings, and its navigation flow isolated from other tools.
---

Each Snapchat tool, its settings, and each navigation flow belongs in its own dedicated module. Keep shared code limited to low-level utilities and explicit dispatch. For Upload a Snap, tap Memories directly when already on Camera; from another screen, tap the live `ngs_camera_icon_container` first, wait for Camera, then tap Memories.

For Upload a Snap, do not abort solely because a resource-ID check fails when the user reports a control is visibly present. Use the requested screen-relative tap and keep the flow moving. On Send To, dismiss the optional Public Story notice with its Okay button when shown, then tap the bottom-right Send chevron whether the notice appeared or not; press Android Back three times only after that tap.

After selecting a Camera Roll image, expand the editor's More tools, identify the Crop control by its crop-corners shape when it has no useful label, tap Zoom to fill, and confirm with Finish before opening Send To. Prefer My Story - Public; if it is unavailable, select My Story - Friends Only.

For Add Friends and Accept Friends, do not gate the operation on exact Add Friends page/resource markers. Use live friend-row action controls directly; preserve row-to-button targeting so unrelated controls are never tapped.

Successful Upload a Snap is normal tool completion, not a request to leave Snapchat open or stop the dispatcher. Continue remaining enabled tools and run normal app-close cleanup at cycle end.

Before dispatching Snapchat tools, reconcile the app session with the configured Snapchat slot username. If already signed in, open the top-left profile, verify its Username, and only log out when it differs. Pass the confirmed profile tree directly to logout navigation to avoid a redundant dump before the Settings gear tap. After confirming logout, wait up to 60 seconds for the saved-account carousel. Before swiping, match the exact target username from live nodes and tap that username text directly, even when Android marks it non-clickable; use the visible centered account name only to choose the swipe row. Search right up to five times, then left up to five times; a repeated username after one swipe is not grounds to abort. Tap a match once, then check for Camera every five seconds for the full 60-second login window; do not tap again while login is in progress. Once the exact target row has been tapped and Camera appears, proceed directly to that slot's tools without reopening the profile or pressing Back. If identity cannot be confirmed from an already-signed-in profile or the target row cannot be selected, skip all Snapchat tools for that cycle.

For Snapchat switching, always refresh the Camera UI immediately before tapping the avatar; a cached Camera tree can miss a newly arrived chat banner. Block the tap for labeled overlays and banner-shaped clickable nodes, but exclude unlabeled full-screen root surfaces because device/display coordinate spaces can differ. Scroll Settings with four fast upward swipes per check. In the logout modal, prefer the explicit `logout_button` inside `dialog_content`; never select the background Settings "Log out" row by text alone.

**Why:** The user has observed Snapchat login taking longer than 30 seconds after selecting a saved account, a roughly seven-second delay from avatar tap to the Settings gear, and logout taking longer than the prior 20-second timeout. Real-device switches also showed one short Settings swipe per expensive read, the modal's text-only fallback matching the background Settings logout row, carousel search aborting on a repeated account after its first swipe, and banner checks both missing a newly arrived banner and misclassifying an unlabeled full-screen root as a persistent banner.

**Why:** The saved-account inspect dump exposed the target username as a non-clickable TextView between the account placeholder and “Remove account”; the centered-row heuristic missed a visible target and continued swiping. Exact target text should take priority over geometry.

**How to apply:** Keep each of these optimizations inside Snapchat navigation. Do not add shared Android gesture changes; preserve the explicit account identity check and live popup text targeting.

**Why:** The user explicitly required isolation after edits to shared Snapchat logic caused unrelated tool behavior to change. False-negative resource-ID checks have stopped Upload a Snap even when the requested control was visible. A Stories-screen inspect dump confirmed the Camera tab is a clickable `ngs_camera_icon_container`; Upload a Snap can run after tools that leave Snapchat on Chat, Stories, Spotlight, or another non-Camera screen. The Camera page marker may be absent even when the live shutter and Memories controls are visible, so use those controls as the surface evidence.

**Why:** A stale test-only success flag previously stopped later tools and skipped configured app-close cleanup even though the image had been sent and the two Back presses completed.

**How to apply:** Put action behavior only in that tool's module, settings schema and UI in that setting's own modules, and each navigation flow in its own module. Do not route an edit for one tool through another tool's flow. Keep Snapchat account reconciliation before tool dispatch; never log out a matching account, and never use credentials or an unverified carousel row. Treat Upload a Snap success as normal tool completion; reserve early exits for failure or abort, and always run cycle cleanup when not aborted. For Upload a Snap, if the live Camera shutter and Memories icon are both present, tap Memories directly without touching the bottom Camera tab. Otherwise tap the clickable `ngs_camera_icon_container`, wait for both controls, then tap the live `ngs_memories_icon`/“Memories” node left of and vertically aligned with the shutter. Do not search for a generic “Camera” label. At the final Send To step, use the visual screen-relative Okay and Send tap locations when accessibility nodes are missing, allow time for each transition, and never press Back before the Send chevron. The user's Tab exploration was only for the Camera Add Friends icon; friend-list Add actions remain direct live-button taps.

**Why:** A device log showed that two post-send Android Back presses still left Snapchat on a surface where the next tool could not find Chat or restore Camera.

**How to apply:** After Send, allow the transition to settle, pause between all three Back presses, and allow the final navigation to settle before cleaning up the staged phone image or dispatching the next tool.

**Why:** The user specified a required crop-to-fill sequence after gallery selection and a Friends Only fallback when Public is not offered.

**How to apply:** Keep this behavior inside Upload a Snap. Resolve the crop action semantically when possible, otherwise match the live crop-corners icon rather than its toolbar order or a fixed screen coordinate.

**Why:** A device log showed Snapchat visibly on its Add Friends screen while the exact XML page check failed, preventing the tool from examining visible friend rows; the same brittle page gate existed in Accept Friends.

**How to apply:** Keep page-marker confirmation out of both friend-list flows. Use each live Add or Accept action and its enclosing friend row as the actionable evidence.

## Upload a Video link toolbar

On the video Snap editor, Snapchat initially hides the paperclip under the right-side downward chevron. Upload a Video must expand that toolbar before tapping the paperclip to open the link editor.

**Why:** The link tap missed because it targeted the paperclip position while the toolbar was still collapsed.

**How to apply:** In Upload a Video only, tap the More/down-chevron control first, wait for the toolbar to expand, then tap the paperclip and continue with URL entry.

The Snapchat URL editor may show a “Show links I’ve recently copied?” clipboard-access dialog. When that exact prompt is present, tap **Not now**, verify it is gone, and only then type the configured URL.

**Why:** The dialog overlays the URL editor and must be cleared before calibrated typing can safely proceed.

**How to apply:** Check the settled URL-editor screen for both the prompt title and its clipboard-access explanation; dismiss only that dialog and fail closed if it remains.

Snapchat may expose the empty URL field’s “Type a URL” hint through both accessibility text and description. Treat that exact hint as empty; otherwise the replacement check can abort before saved-keyboard typing begins.

**Why:** An inspect dump showed the placeholder in both fields, and the previous non-empty check interpreted it as existing link content.

**How to apply:** Ignore the placeholder when deciding whether to clear the field, then proceed to the device’s saved keyboard calibration for URL entry.

After typing an Upload a Video URL, press the device-calibrated Enter/Search key to load Snapchat’s link preview. Wait for the preview’s Attach to Snap button, tap it, then continue to the optional caption. After typing the caption, press the same saved Enter/tick key to commit it and verify the keyboard closes and Send To returns; Android Back only hides the keyboard and does not commit the caption.

**Why:** Typing alone leaves the editor on the URL-entry screen; Snapchat only exposes the attach action after the keyboard’s search/enter action loads the link preview. Caption text also remains in edit mode until the keyboard’s tick/Enter action is pressed.

**How to apply:** Use the per-device named Enter keyboard bind to load the URL preview and commit the caption. Wait for the live Attach to Snap control before tapping it, and do not continue to Send To until the committed caption has returned to the Snap editor.

After a confirmed Attach to Snap tap, do not require the accessibility tree to expose “Send To” before starting caption entry. Snapchat can omit that label while the Snap editor is visibly available. Start the caption by tapping open video canvas around the horizontal center, above the link sticker when clear; use a clear point below it only if the upper point overlaps a control or sticker. Never use the top-right T toolbar coordinate for this caption flow.

**Why:** Real-device logs showed the URL attached successfully, but the caption routine first stopped at its Send To accessibility check. A later tap in the top toolbar hit the wrong control; the user clarified that the caption prompt opens by tapping open canvas away from the link sticker.

**How to apply:** For the immediate link-to-caption handoff only, trust the confirmed Attach to Snap transition, choose an open canvas point away from the link and toolbar controls, and still require the caption keyboard to open before typing. Do not send Android Back if the keyboard unexpectedly remains open after attaching the link.
