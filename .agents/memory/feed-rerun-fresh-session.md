---
name: View Feed re-run freshness
description: A View Feed re-run must be a new randomized Feed pass, not a replay of the first pass.
---

Each mobile tool pass, including a re-run, must independently roll its configured count, feature percentages, per-item action decisions, delays, and device-personality paths. This applies to Feed, Stories, Explore, Reels, Check Inbox, and Make a Post.

**Why:** The user wants the re-run to represent a genuinely different browsing session rather than duplicate the first pass.

**How to apply:** Keep pass-specific rolls inside each tool dispatcher or run function invocation; never calculate them once for the whole automation cycle and reuse them for an appended tool entry.