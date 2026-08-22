---
name: Reels right-side action-icon column detection
description: How View Reels finds Like/Comment/Share/Send icons on the Reels viewer.
---

Instagram's Reels viewer renders Like/Comment/Repost/Send as a VERTICAL column
down the right edge of the screen — a completely different layout from a
normal feed post's horizontal bottom action bar (`findFeedActionIcons`).
There was no prior detector for this layout anywhere in the codebase.

The Reels Like target now uses the same visual feed-heart matcher as
`findFeedActionIcons`, restricted to the right-side Reel action column. The
transparent white outline is handled by the matcher’s contrast-normalized
comparison; accessibility labels, resource IDs, and icon-order fallbacks are
not used to locate Like. The existing column scan remains available for the
other Reel actions.

**Why:** The accessibility-based Reel Like detector was not tapping the real
button on the user's device. The feed visual matcher is the established
working path, and its normalized contrast comparison is appropriate for the
white outlined Reel heart.

**How to apply:** If View Reels reports that the Like visual reference was not
matched, inspect the saved screenshot-matcher log and verify the search region
before changing the target strategy. Do not restore accessibility or fixed-
coordinate fallbacks.
