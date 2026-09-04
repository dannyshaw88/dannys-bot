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