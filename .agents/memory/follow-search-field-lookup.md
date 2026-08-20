---
name: Follow search field lookup
description: Follow must resolve Instagram's top search field from live accessibility nodes before visual matching
---

Follow search lookup is visual-only: reuse the Feed Like detector's screenshot correlation against the packaged search-field references and tap the best center in the top search band.

**Why:** UIAutomator nodes are intermittent on this surface, so node lookup can fail even when the field is visible. The search page has one distinctive field in the top band, making best visual similarity the reliable selector.

**How to apply:** Never let accessibility selection override the visual path; scan the top 20% only, retain the closest correlation, and return the matched rectangle center without a confidence rejection gate.