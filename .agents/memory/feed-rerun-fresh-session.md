---
name: View Feed re-run freshness
description: A View Feed re-run must be a new randomized Feed pass, not a replay of the first pass.
---

Each View Feed pass, including a re-run, must independently roll scroll count, feature percentages, per-post action decisions, delays, and device-personality swipe paths.

**Why:** The user wants the re-run to represent a genuinely different browsing session rather than duplicate the first pass.

**How to apply:** Keep pass-specific rolls inside the Feed dispatcher or run function invocation; never calculate them once for the whole automation cycle and reuse them for an appended Feed entry.