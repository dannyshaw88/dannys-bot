---
name: Snapchat Add Friends confirmation
description: Treat the Add tap as the completed action without waiting for Snapchat's button label to change.
---

Open Add Friends from Camera through the `snapchat://add_friends` ADB intent; do not Tab to or coordinate-tap the person-plus icon. For a matched Find Friends row, prefer Android Tab focus and Enter only after the exact Add control is confirmed focused. If the row control is not keyboard-focusable, take a fresh UI snapshot and use an exact tap only when no overlay covers it. Count the action without requiring Snapchat to replace the Add label or show a confirmation. If an incoming banner redirects the flow to a chat/composer, back out without typing, restore Add Friends through the deep link, and retry that same row; after repeated interruptions, skip only that row and continue the cycle.

**Why:** The user wants the direct route because an incoming banner can intercept person-plus touch input, and wants identifiable wrong-screen states recovered instead of aborting the whole cycle. No reply or other tool should run inside the unintended chat. Snapchat's Add confirmation can still be delayed or unchanged.

**How to apply:** Use only the Snapchat URI intent for entering Add Friends; if it cannot open the page, skip that tool rather than tapping the person-plus icon. Preserve the live row-to-button identity match and attempted-row history. Do not count a change of Add label as required confirmation. On an unexpected chat surface, use Back to dismiss the keyboard and leave the chat, then return to Add Friends before retrying.
