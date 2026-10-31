---
name: Snapchat Add Friends confirmation
description: Treat the Add tap as the completed action without waiting for Snapchat's button label to change.
---

Open Add Friends from Camera by locating the live `neon_add_friend_button_container` or the accessible “Add friends” label and its clickable parent. If a visible banner overlaps the icon's tap point, wait five seconds and inspect again until the point is clear; tap immediately after the clear check. Do not use deep links, internal activity launches, fixed coordinates, or a fixed device serial. Count a matched Find Friends row's Add action without requiring Snapchat to replace the label or show a confirmation. If an incoming banner redirects the flow to a chat/composer, back out without typing, restore Add Friends, and retry that same row; after repeated interruptions, skip only that row and continue the cycle.

**Why:** Snapchat rejected the suggested URI and the guessed native activity did not open the page on the user's device. The user requires a manual Add icon tap, with an active wait-and-retry when a banner covers it. No reply or other tool should run inside an unintended chat. Snapchat's Add confirmation can still be delayed or unchanged.

**How to apply:** Resolve the live icon from its resource ID or “Add friends” accessibility label, including its clickable parent. Run the banner-overlap check on the latest UI dump and do not add another device query between a clear result and the tap. While covered, wait five seconds and retry without aborting the cycle. Preserve the live row-to-button identity match and attempted-row history. Do not count a change of Add label as required confirmation. On an unexpected chat surface, use Back to dismiss the keyboard and leave the chat, then return to Add Friends before retrying.
