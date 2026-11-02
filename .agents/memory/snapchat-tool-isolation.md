---
name: Snapchat module isolation
description: Keep each Snapchat tool, its settings, and its navigation flow isolated from other tools.
---

Each Snapchat tool, its settings, and each navigation flow belongs in its own dedicated module. Keep shared code limited to low-level utilities and explicit dispatch. For Upload a Snap, tap Memories directly when already on Camera; from another screen, tap the live `ngs_camera_icon_container` first, wait for Camera, then tap Memories.

For Upload a Snap, do not abort solely because a resource-ID check fails when the user reports a control is visibly present. Use the requested screen-relative tap and keep the flow moving. On Send To, dismiss the optional Public Story notice with its Okay button when shown, then tap the bottom-right Send chevron whether the notice appeared or not; press Android Back twice only after that tap.

Successful Upload a Snap is normal tool completion, not a request to leave Snapchat open or stop the dispatcher. Continue remaining enabled tools and run normal app-close cleanup at cycle end.

Before dispatching Snapchat tools, reconcile the app session with the configured Snapchat slot username. Open the top-left profile, verify its Username, and only log out when it differs. After logout, traverse the saved-account carousel to the exact slot username, tap it once, and check for Camera every five seconds for up to 30 seconds; do not tap again while login is in progress. Verify identity again, then press Android Back once to Camera. If identity cannot be confirmed, skip all Snapchat tools for that cycle.

For Snapchat switching, always refresh the Camera UI immediately before tapping the avatar; a cached Camera tree can miss a newly arrived chat banner. Block the tap when a labeled or clickable overlay overlaps the avatar, and wait only while a live banner is present. Scroll Settings with four fast upward swipes per check, and tap the exact visible Log Out label nearest the confirmation title even if its node is not marked clickable.

**Why:** A real-device switch showed redundant UI dumps delaying the avatar tap, one short Settings swipe per expensive read, a visible gray logout-confirmation button exposed as non-clickable text, and a stale Camera tree missing a chat banner that then received the tap.

**How to apply:** Keep each of these optimizations inside Snapchat navigation. Do not add shared Android gesture changes; preserve the explicit account identity check and live popup text targeting.

**Why:** The user explicitly required isolation after edits to shared Snapchat logic caused unrelated tool behavior to change. False-negative resource-ID checks have stopped Upload a Snap even when the requested control was visible. A Stories-screen inspect dump confirmed the Camera tab is a clickable `ngs_camera_icon_container`; Upload a Snap can run after tools that leave Snapchat on Chat, Stories, Spotlight, or another non-Camera screen. The Camera page marker may be absent even when the live shutter and Memories controls are visible, so use those controls as the surface evidence.

**Why:** A stale test-only success flag previously stopped later tools and skipped configured app-close cleanup even though the image had been sent and the two Back presses completed.

**How to apply:** Put action behavior only in that tool's module, settings schema and UI in that setting's own modules, and each navigation flow in its own module. Do not route an edit for one tool through another tool's flow. Keep Snapchat account reconciliation before tool dispatch; never log out a matching account, and never use credentials or an unverified carousel row. Treat Upload a Snap success as normal tool completion; reserve early exits for failure or abort, and always run cycle cleanup when not aborted. For Upload a Snap, if the live Camera shutter and Memories icon are both present, tap Memories directly without touching the bottom Camera tab. Otherwise tap the clickable `ngs_camera_icon_container`, wait for both controls, then tap the live `ngs_memories_icon`/“Memories” node left of and vertically aligned with the shutter. Do not search for a generic “Camera” label. At the final Send To step, use the visual screen-relative Okay and Send tap locations when accessibility nodes are missing, allow time for each transition, and never press Back before the Send chevron. The user's Tab exploration was only for the Camera Add Friends icon; friend-list Add actions remain direct live-button taps.
