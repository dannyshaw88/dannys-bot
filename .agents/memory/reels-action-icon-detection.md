---
name: Reels right-side action-icon column detection
description: How View Reels finds Like/Comment/Share/Send icons on the Reels viewer.
---

Instagram's Reels viewer renders Like/Comment/Repost/Send as a VERTICAL column
down the right edge of the screen — a completely different layout from a
normal feed post's horizontal bottom action bar (`findFeedActionIcons`).
There was no prior detector for this layout anywhere in the codebase.

The Reels Like target uses the packaged heart reference only as a contour
shape. The matcher extracts edge samples from the reference, then searches
the right-side Reel action column for a white, orientation-matching outline.
Pixels inside the heart are intentionally ignored because they contain live
video. Accessibility labels, resource IDs, and icon-order fallbacks are not
used to locate Like. The existing column scan remains available for the other
Reel actions.

**Why:** The accessibility-based Reel Like detector was not tapping the real
button on the user's device, and whole-patch correlation fails when a
transparent white outline contains arbitrary video content. A white contour
plus edge-orientation score preserves the visual-only safety rule without
matching the moving interior.

**How to apply:** If View Reels reports that the Like visual reference was not
matched, inspect the saved screenshot-matcher log and verify the search region
before changing the target strategy. Do not restore accessibility or fixed-
coordinate fallbacks.
