---
name: Random Actions notification detector
description: Notification navigation must use the live heart screenshot matcher in the top-right header
---

Random Actions must locate Instagram's Notifications heart with the same polarity-invariant visual matcher used for View Feed Like, constrained to the top-right header. Do not use accessibility labels, resource IDs, or broad clickable-node fallbacks.

**Why:** On some Instagram builds the notification hierarchy is stale or misleading; the old fallback could miss the visible button and later Back handling could leave Instagram or switch to the launcher.

**How to apply:** Refuse the notification action when the visual match is absent or below the confidence gate, and log the match coordinates and confidence.

For the optional notification-item tap, target a text-bearing node in the notification body area (right of the avatar column and left of Follow/remove controls). Group nearby text nodes by row and choose the strongest action/body text node; never select the avatar column.

**Why:** The avatar opens the notifying user's profile or Story. A Story opened from a notification can leave the Random Actions flow on the wrong surface and break its cleanup sequence.

**How to apply:** Keep the click inside the notification text bounds, log the exact text-target coordinate, and verify the notification surface before the existing Back cleanup.

Notification-item success must only be logged after the post-tap dump proves that
Notifications was replaced by a detail surface with a usable Back/Close control.

**Why:** A text node can accept an ADB tap without opening its row, leaving the
Notifications page visible; logging success first hides that miss and can make
the following cleanup look like a successful navigation.

**How to apply:** Treat a still-visible Notifications header as a miss, skip
detail cleanup for that branch, and keep the normal verified Notifications exit.

Rows containing the standalone word `Thread` or `Threads` must be excluded
before random notification selection. These are Instagram cross-promotion rows
and can launch the separate Threads app.

**Why:** A real device showed the notification-row click opening Threads
instead of an Instagram notification detail.

**How to apply:** Apply the exclusion to the grouped row, not just the text
node that wins scoring, because the marker may be exposed by a sibling node.

Comment-related notification rows are a separate navigation case. If the
selected row contains comment/reply semantics, the resulting Comments surface
may have no Instagram Back/Close node, so return with Android BACK only for
that classified row. If the keyboard consumes the first BACK, send one more
Android BACK; keep the calibrated Back/Close path for all other rows.

**Why:** The Comments surface shown by the affected Instagram build has no
visible Instagram back control, while ordinary notification details do. Using
the calibrated control there can miss the intended exit or hit an unrelated
Home control.

**How to apply:** Preserve the row-level `isComment` classification through
the tap, verify Notifications after the Android BACK sequence, and never use
this exception for non-comment notifications.