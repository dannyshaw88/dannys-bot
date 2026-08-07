---
name: Story-viewer safety checks must be fast, not just infrequent
description: Removing the pre-action "watch" delay (v1.1.485) didn't fix story like/share stalling because the "still in story viewer?" gate itself cost 3-4s per call via a full uiautomator dump, called 5-6x per slide.
---

## The rule

A per-slide safety check that runs multiple times inside a fixed-length
real-world timer (Instagram stories, ~5-6s) must itself be cheap. Fixing the
*deliberate* delay in front of a scheduled action is not enough if the
*mandatory* safety check right after it is slow — the check becomes the
bottleneck instead.

**Why:** `stillInStoryViewer()` (guards every tap in the story per-slide
loop against blind-tapping the home feed after a story auto-advances/exits)
called `findHomeTab`, which requires a full `uiautomator dump` + `adb pull`
— measured at ~3-4s per call on this farm's devices. It's called up to 5-6
times per slide. Removing a 250ms pre-action watch delay (see
`story-action-timing-starvation.md`) changed almost nothing when the very
next line still blocked for 3-4s: log evidence showed ~5s just to reach the
like tap and ~4.6s more to reach the share attempt, on a slide with only
~5-6s of total runway.

**How to apply:** when a safety/state check must run many times inside a
tight real-world timer, check whether a cheaper signal exists (e.g. a
screenshot-based pixel scan, ~100-300ms via `adb exec-out screencap -p`,
vs. an accessibility-tree dump) before optimizing the delays around it.
`isStoryViewerOpenFast` in `androidManager.ts` scans for Instagram's
segmented story progress bar near the top of the screen and only ever
returns a confident `true`; on anything ambiguous (e.g. single-story trays
with no multi-segment bar) it returns `null` and the caller must fall back
to the slow-but-proven check — never let a fast heuristic assert "closed"
on its own, since a wrong "still open" causes the exact blind-tap bug these
checks exist to prevent, while a false "unknown" is merely conservative.
