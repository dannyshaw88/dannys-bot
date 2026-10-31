---
name: Snapchat Add Friends confirmation
description: Treat the Add tap as the completed action without waiting for Snapchat's button label to change.
---

For a matched Find Friends row, prefer Android Tab focus and Enter only after the exact Add control is confirmed focused. If the control is not keyboard-focusable, take a fresh UI snapshot and use an exact tap only when no overlay covers it. Count the action without requiring Snapchat to replace the Add label or show a confirmation. If the list changes to a chat/composer unexpectedly, stop the remaining Snapchat tools.

**Why:** An incoming-message banner can intercept a coordinate tap and open a conversation. Keyboard activation avoids touch hit-testing when Snapchat exposes focus; stopping on an unexpected chat prevents later tools from acting on the wrong person. Snapchat's Add confirmation can still be delayed or unchanged.

**How to apply:** Preserve the live row-to-button identity match and attempted-row history. Do not count a change of Add label as required confirmation; do treat an unexpected chat surface as a tool-sequence stop.
