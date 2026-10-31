---
name: Snapchat Add Friends confirmation
description: Treat the Add tap as the completed action without waiting for Snapchat's button label to change.
---

Open Add Friends from Camera by trying the supplied native `AddFriendsActivity` component once, then locate Snapchat's live `neon_add_friend_button_container` node. Prefer Tab/Enter only when that exact node is confirmed focused; otherwise tap its current accessibility bounds, never a hard-coded coordinate or device serial. Count a matched Find Friends row's Add action without requiring Snapchat to replace the label or show a confirmation. If an incoming banner redirects the flow to a chat/composer, back out without typing, restore Add Friends, and retry that same row; after repeated interruptions, skip only that row and continue the cycle.

**Why:** The suggested `snapchat://add_friends` link produced Snapchat's own “Oops! This link doesn't seem to be working” banner on the user's device. The user asked to try alternate routes; a live control bounds tap adapts to each phone's screen and avoids stale fixed coordinates. No reply or other tool should run inside an unintended chat. Snapchat's Add confirmation can still be delayed or unchanged.

**How to apply:** Never repeat the rejected URI or bake in a phone serial/pixel coordinate. Validate a native activity result against the Add Friends page; if it fails, use the exact live Camera node and verify the resulting surface. Preserve the live row-to-button identity match and attempted-row history. Do not count a change of Add label as required confirmation. On an unexpected chat surface, use Back to dismiss the keyboard and leave the chat, then return to Add Friends before retrying.
