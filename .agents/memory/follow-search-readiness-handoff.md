---
name: Follow Search readiness handoff
description: Keep Spread Follow backup candidates from inheriting an unverified Search state
---

Only mark a Spread Follow backup's Search field ready when the preceding operation explicitly reports that the field is confirmed focused and cleared. A zero-follow result alone does not prove readiness: focus failure deliberately skips cleanup, and stale readiness can skip Search navigation while still tapping the calibrated field coordinate on a modal or profile.

**Why:** A backup candidate was marked ready unconditionally after a failed-focus attempt. Follow then skipped Search-tab navigation, discarded the readiness flag, tapped the fixed Search-field point anyway, and repeated the same false-negative cycle.

**How to apply:** Propagate per-attempt readiness through backup and re-scrape loops. When readiness is false, dismiss safe Instagram interstitials, re-enter Search, tap the calibrated field, and confirm focus before typing.