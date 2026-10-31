---
name: Snapchat module isolation
description: Keep each Snapchat tool, its settings, and its navigation flow isolated from other tools.
---

Each Snapchat tool, its settings, and each navigation flow belongs in its own dedicated module. Keep shared code limited to low-level utilities and explicit dispatch.

**Why:** The user explicitly required isolation after edits to shared Snapchat logic caused unrelated tool behavior to change.

**How to apply:** Put action behavior only in that tool's module, settings schema and UI in that setting's own modules, and each navigation flow in its own module. Do not route an edit for one tool through another tool's flow. The user's Tab exploration was only for the Camera Add Friends icon; friend-list Add actions remain direct live-button taps.
