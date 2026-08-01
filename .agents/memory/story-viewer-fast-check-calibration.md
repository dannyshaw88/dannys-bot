---
name: Screenshot-based UI heuristics need field verification, not just a plausible-looking threshold
description: A pixel-scan "fast check" (isStoryViewerOpenFast) tuned against one reference capture silently never matched on a real device, making the fast-path fix from the prior round a no-op with zero visibility.
---

## The rule

A screenshot-pixel heuristic (brightness threshold, band position, cluster
shape ratios) tuned against a single reference image/device is a guess, not
a verified fact, until it's seen matching in a real log from the field. If
the code path that consumes it silently falls back to a slower alternative
on `null`/inconclusive, a heuristic that never matches produces NO error —
it just quietly reverts to the old slow behavior, indistinguishable from
"working but rare" without added instrumentation.

**Why:** `isStoryViewerOpenFast` (see `story-viewer-check-cost.md`) was
introduced specifically to eliminate multi-second `uiautomator dump` calls
in story per-slide safety checks. Its thresholds (1.5%-6% height band, 150
brightness, 1.8 max/min width ratio, 55% width coverage) were reasoned
about but never confirmed against a live capture. In the field it appears
to have matched effectively never — every check still fell through to the
slow path, so the "instant like/share" fix was a no-op end to end, and
nothing in the logs distinguished "fast check ran and failed to match" from
"fast check couldn't even capture/decode a screenshot" (`_captureScreenPixels`
swallows capture/decode errors and returns `null` silently).

**How to apply:** whenever adding a screenshot/pixel heuristic as a
fast-path replacement for a slow-but-proven check:
1. Widen bands and relax thresholds generously on the first pass — a
   heuristic that's slightly too permissive but still requires a
   distinctive multi-part pattern (e.g. several near-uniform bright
   segments spanning most of the width) is far safer than one tuned so
   tight it never fires.
2. Log (at least at debug/warn level) BOTH failure modes separately:
   capture/decode failure vs. "ran but pattern not found" — they need
   different fixes.
3. Add timing instrumentation at the call site so the next real-world log
   shows hard numbers (fast-check duration, hit/miss, slow-fallback
   duration) instead of requiring back-calculation from unrelated
   timestamps to guess whether the fast path ever engaged.
