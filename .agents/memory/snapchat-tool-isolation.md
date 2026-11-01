---
name: Snapchat module isolation
description: Keep each Snapchat tool, its settings, and its navigation flow isolated from other tools.
---

Each Snapchat tool, its settings, and each navigation flow belongs in its own dedicated module. Keep shared code limited to low-level utilities and explicit dispatch. For Upload a Snap, tap Memories directly when already on Camera; from another screen, tap the live `ngs_camera_icon_container` first, wait for Camera, then tap Memories.

**Why:** The user explicitly required isolation after edits to shared Snapchat logic caused unrelated tool behavior to change. A Stories-screen inspect dump confirmed the Camera tab is a clickable `ngs_camera_icon_container`; Upload a Snap can run after tools that leave Snapchat on Chat, Stories, Spotlight, or another non-Camera screen.

**How to apply:** Put action behavior only in that tool's module, settings schema and UI in that setting's own modules, and each navigation flow in its own module. Do not route an edit for one tool through another tool's flow. For Upload a Snap, check for the live Camera page; if absent, tap the clickable `ngs_camera_icon_container` and wait for the Camera shutter. Then tap the live `ngs_memories_icon`/“Memories” node left of and vertically aligned with the shutter. Do not search for a generic “Camera” label. The user's Tab exploration was only for the Camera Add Friends icon; friend-list Add actions remain direct live-button taps.
