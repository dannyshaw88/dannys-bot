---
name: Follow search field lookup
description: Follow must resolve Instagram's top search field from live accessibility nodes before visual matching
---

Follow search lookup is live-node-first: use the current UIAutomator resource/semantic node and tap its bounds; use the packaged screenshot correlation only as a bounded fallback when live nodes are unavailable.

**Why:** UIAutomator nodes can be intermittent on this surface, but the multi-template visual scan can take minutes when repeated for every candidate. The live node is both faster and more precise; visual matching preserves compatibility for builds that omit the node.

**How to apply:** Retry live resource IDs/semantic top-region nodes briefly before invoking the visual matcher. Keep the visual scan top-region bounded and single-flight per device.