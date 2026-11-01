---
name: Snapchat module isolation
description: Keep each Snapchat tool, its settings, and its navigation flow isolated from other tools.
---

Each Snapchat tool, its settings, and each navigation flow belongs in its own dedicated module. Keep shared code limited to low-level utilities and explicit dispatch. Upload a Snap must tap the live Memories icon left of the Camera shutter as its first phone-screen action; never use the bottom navigation control labelled “Camera,” which can display as Explore.

**Why:** The user explicitly required isolation after edits to shared Snapchat logic caused unrelated tool behavior to change. An inspect dump showed Snapchat's bottom navigation control has accessibility description “Camera” while its visible label is “Explore”; using that label as a fallback can tap the wrong item instead of Memories.

**How to apply:** Put action behavior only in that tool's module, settings schema and UI in that setting's own modules, and each navigation flow in its own module. Do not route an edit for one tool through another tool's flow. For Upload a Snap, target the live `ngs_memories_icon`/“Memories” node only when it is left of and vertically aligned with the live shutter; do not fall back to a “Camera” tab tap. The user's Tab exploration was only for the Camera Add Friends icon; friend-list Add actions remain direct live-button taps.
