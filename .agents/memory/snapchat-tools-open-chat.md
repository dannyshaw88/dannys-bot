---
name: Snapchat tools from an open chat
description: Restore a verified Snapchat chat surface before tools that require Camera.
---

Snapchat's launcher intent with `--activity-clear-top` can leave an existing direct conversation in front. Before Add Friends or Accept Friends requires the Camera tab, dismiss a visible chat keyboard, exit the verified chat, and confirm the composer closed before continuing. For Reply to Unread Chats, send Back one press at a time and re-scan after each; never send a second Back from an unconfirmed surface.

**Why:** Two devices started those tools with the chat composer and keyboard still open; the hidden Camera tab caused each cycle to idle until the watchdog aborted it. A later unread row had no composer, and the fixed two-Back sequence left Snapchat's Chat tab.

**How to apply:** Keep navigation bounded and state-verified; do not repeatedly send Back or tap an assumed Camera coordinate. Before dispatching another tool after Reply, confirm or restore Camera.
