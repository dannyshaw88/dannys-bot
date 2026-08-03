---
name: Reels right-side action-icon column detection
description: How View Reels finds Like/Comment/Share/Send icons on the Reels viewer, and why it's unvalidated.
---

Instagram's Reels viewer renders Like/Comment/Repost/Send as a VERTICAL column
down the right edge of the screen — a completely different layout from a
normal feed post's horizontal bottom action bar (`findFeedActionIcons`).
There was no prior detector for this layout anywhere in the codebase.

`findReelActionIcons` (androidManager.ts) reuses the same content-desc labels
already proven reliable for the feed's action bar ("Like"/"Unlike",
"Comment", "Repost"/"Share", "Send"/"Direct"/"Message"). It anchors on the
Like/Unlike node in the right ~28% of the screen, then treats every other
clickable node in that same X column (below Like) as Comment/Repost/Send,
resolved by the same label regexes as the feed.

**Why:** No real-device diagnostic dump of an open Reel exists yet (as of 15
Jul 2026). Per the project's evidence-gathering rule, "element not found"
detection should start from a real dump — but the feed's labels were the best
available starting point rather than guessing blind, since Instagram is known
to reuse them across contexts.

**How to apply:** If View Reels reports "action icons not found" or mis-taps
on a real device, the fix is NOT to guess new labels — `findReelActionIcons`
already logs every right-edge clickable node (content-desc/resource-id/class)
when the Like/Unlike anchor can't be found, and a full column dump when it
can. Read that log first; it's the same "diagnostic before fix" discipline
used throughout this codebase's other detectors.
