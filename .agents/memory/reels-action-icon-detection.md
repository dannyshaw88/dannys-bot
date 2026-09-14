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

Reels Save uses the same validated live accessibility action-node matcher as
Like, with `save_button` plus the `Add to Saved` / `Remove from Saved` labels.
It must be resolved from a fresh dump immediately before the Save tap, not from
the earlier all-actions scan. When the DM action is also present, Save must be
clearly below and spatially distinct from it. After the tap, a detected DM
share sheet means the Save failed: close it and do not count a save.

**Why:** The Reels visual bookmark reference was unavailable in the runtime,
while the live UI dump exposes the Save action node and state label directly.
Real-device evidence showed an earlier Save coordinate later opening the DM
sheet and being counted as success before the resulting surface was inspected.

**How to apply:** Keep Save independent from Like, Repost, and DM resolution;
resolve it immediately before tapping and fail closed when the node is absent,
ambiguous, too close to DM, out of vertical order, or opens the DM sheet.

For Reels Share-to-Feed, require a verified repost-specific resource ID. Do not
fall back to a generic `content-desc="Repost"` match: on a real device that
fallback resolved a tap that opened the comment/reply sheet instead of the
intended share-to-feed action.

**Why:** The observed dump exposed a Repost content description without a
verified repost resource ID, and the resulting tap produced the comment sheet.

**How to apply:** If no known repost resource ID is present, leave
`shareFeed` null and skip the action safely; never guess from vertical position
or the label alone.

Accessibility action matches must also be validated as clickable, icon-sized
nodes; count labels and row-sized containers are not safe tap targets.

**Why:** Reels can expose action labels on parent/container nodes while the
visible control is elsewhere, causing a share tap to open the likes/count sheet.

**How to apply:** Reject numeric count text, non-clickable nodes, and oversized
bounds before resolving any action coordinate. Missing validation means skip.

Action-bar scans do not prove that an action was selected for the current reel.
The action percentages are rolled before scanning, and an unavailable selected
action can be the only reason the scan produces no tap. Log the per-reel action
plan separately from the resolved icon inventory, await the complete action
transaction, and use only a short settle barrier before swiping.

**Why:** A real-device log showed Like/DM/Save icons resolved but no tap lines;
the selected action was Share-to-Feed, whose verified resource ID was absent.
The swipe began only after the awaited transaction, so blaming the watch dwell
would have led to the wrong fix.

**How to apply:** When diagnosing a silent scan, compare the action plan,
available icons, tap/verification lines, and swipe timestamp in that order.

Reels advance swipes must not inherit a low calibrated start point blindly:
ad CTAs can occupy the lower full-width band, and a slow drag beginning on
that button can be interpreted as a click before the swipe is recognized.

**Why:** A Redmi profile started a focused Reel swipe inside a visible
“Contact us” ad CTA, which opened the advertiser page instead of advancing.

**How to apply:** Keep the calibrated direction, endpoint, jitter, and pacing,
but cap only the Reels swipe start inside the video body; do not change the
shared calibration used by other tools.
