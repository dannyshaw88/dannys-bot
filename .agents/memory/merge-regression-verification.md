---
name: Merge regression verification
description: How to detect features that return after a conflict-recovery merge
---

When a feature is added on top of a merge or conflict-recovery branch, compare both merge parents for the affected behavior before assuming the merged tree preserves earlier cleanup. Verify the active UI, the request payload, and the server dispatcher separately; a removed control can survive in one or more of those layers.

**Why:** A merge that successfully added the standalone Story tool also retained older Make a Post destination and delete-after-posting paths that had already been intentionally removed.

**How to apply:** Before pushing a merge-derived feature, search for the old labels and field names in render code, client payload builders, shared copy sections, schemas/defaults, and runtime dispatch branches. Remove only active regressions and preserve intentionally retained legacy routines.