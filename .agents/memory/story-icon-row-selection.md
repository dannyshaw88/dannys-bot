---
name: Pixel-scan row selection must prefer position, not match strength
description: A screenshot heuristic ranking candidate rows by "most matches" (cluster count) let coincidental story content (polls, mentions, link stickers) outrank the real UI bar; anchoring by known screen position is more reliable than match strength.
---

## The rule

When multiple regions of a screenshot could satisfy a pixel-pattern match
(e.g. "N compact bright clusters on a dark background"), and the target
control has a KNOWN, FIXED position on screen relative to something stable
(a screen edge, system inset, or another anchor), rank candidates by
proximity to that known position first — not by how strongly they matched
the pattern. Match strength alone lets accidental content (in this case,
Instagram story overlays: polls, mention chips, link stickers) win over the
real control whenever the content happens to produce a cleaner-looking
match than the real control does on that particular frame.

**Why:** `findStoryActionIcons`'s row selection ranked "most clusters, then
darkest" — reasonable-sounding, but on two consecutive stories in the same
session it picked rows at 65% and 88% of screen height for what should be
the exact same physical reply bar. The reply bar is system-anchored (always
the lowest qualifying element on screen, nothing renders below it) while
false matches from story content are essentially never that low. Ranking
by "closest to the known anchor" instead of "best pattern match" directly
targets this failure mode without needing per-device pixel calibration.

**How to apply:** before tuning brightness/width/gap thresholds further on
a screenshot heuristic that keeps misfiring, check whether the selection
*ranking* is the actual bug — i.e., whether a correct-but-weaker candidate
is losing to a stronger-but-wrong one. If the target has a known anchor
(screen edge, another confirmed element), sort by distance to that anchor
before considering match quality.
