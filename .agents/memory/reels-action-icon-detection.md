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

The standalone Repost tool must resolve its verified Repost resource ID
independently from the combined Reel action scanner. That scanner currently
requires a valid Like anchor and can return null before exposing Repost. A
missing Like must not suppress Repost; Like remains optional and is checked
from a fresh dump after Repost is confirmed.

**Why:** The standalone tool opened a Reel, then did nothing when the shared
action scanner rejected the action set because Like was missing. Repost was
independently identifiable, but the operation treated the whole scan as failed.

**How to apply:** Use the dedicated Repost resolver with verified resource IDs,
right-column bounds, and cross-action collision checks. Never use a generic
label or guessed coordinate; send no second Repost tap when the result is
ambiguous.

For Reels Share-to-Feed, prefer a verified Repost-specific resource ID. If
Instagram omits the ID, accept only one exact Repost state label on an enabled,
clickable, compact node in the right-side Reel action column, between unique
verified action anchors (Comment or Like above; Direct Share or Save below).
Check horizontal alignment and reject any collision with another action. Never
accept a screen-wide label, the generic Share button, the feed's bottom action
bar, count nodes, or guessed coordinates.

**Why:** An earlier unbounded `content-desc="Repost"` fallback tapped the
comment/reply surface. Newer real-device evidence shows the actual clickable
Repost icon in the right-side column can have no resource ID; the ID-only
resolver then skipped without sending a tap. The strict spatial and neighboring
action checks distinguish that icon from the unsafe generic label.

**How to apply:** Use the same anchored exact-label rule in the standalone
Repost resolver and View Reels. If the label is missing, duplicated, not
clickable, outside the right column, or lacks unambiguous action anchors, skip
Repost safely and never send a second tap after an uncertain result.

Standalone Repost link selection uses a Fisher–Yates shuffle after filtering
processed links, so the configured source-list order does not bias which links
are opened first. Each selected Reel independently rolls a hardcoded 1–100%
chance to Save; resolve Save with a fresh detector separate from Like/Repost,
and never tap when the live state is already saved.

**Why:** The user requested random source-link ordering and a separate hardcoded
Save chance for the Repost tool.

**How to apply:** Preserve the process count and processed-link filtering while
shuffling. Keep Save’s chance independent from Like and fail closed on missing,
ambiguous, DM-conflicting, or unverified Save controls.

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
