---
name: Snapchat View Snaps exit
description: Leave the Snap viewer with one Android Back press after the tool's final viewed Snap.
---

When View Snaps completes while the story viewer is active, send Android Back exactly once to exit that viewer. Do not substitute a Camera-tab tap for this exit.

**Why:** The user explicitly requires Android Back once at the end of View Snaps; a right-side tap only advances to another Snap.

**How to apply:** After the configured viewing loop, if the Snap viewer is still active and the cycle is not aborted, send one KEYCODE_BACK. Later tool dispatch may navigate from Stories to Camera as a separate step.
