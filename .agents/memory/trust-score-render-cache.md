---
name: Trust Score render cache
description: Trust Score badges share cached label definitions and in-flight slot assignment requests
---

Trust Score UI must not issue one assignment request per badge instance or repeatedly parse the label configuration during ordinary renders.

**Why:** Device and Statistics pages render many copies of the same slot badges; independent hydration created visible navigation lag and unnecessary database requests.

**How to apply:** Keep slot assignment loads deduplicated with a short freshness window, invalidate on score changes, and cache trust-level definitions until their local settings change.