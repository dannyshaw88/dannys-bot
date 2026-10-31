---
name: Snapchat tools from an open chat
description: Restore a verified Snapchat chat surface before tools that require Camera.
---

Snapchat's launcher intent with `--activity-clear-top` can leave an existing direct conversation in front. Before Add Friends or Accept Friends requires the Camera tab, dismiss a visible chat keyboard, exit the verified chat, and confirm the composer closed before continuing.

**Why:** Two devices started those tools with the chat composer and keyboard still open; the hidden Camera tab caused each cycle to idle until the watchdog aborted it.

**How to apply:** Keep navigation bounded and state-verified; do not repeatedly send Back or tap an assumed Camera coordinate.
