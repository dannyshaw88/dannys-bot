---
name: Follow search field lookup
description: Follow must resolve Instagram's top search field from live accessibility nodes before visual matching
---

Follow search lookup is not the same as the Feed Like matcher: use live `action_bar_search_edit_text`/search resource nodes first with fresh retries, then visual matching as fallback.

**Why:** The active search-bar implementation performed a visual scan first and only one live UI dump; its advertised retry logic was inside dead code, so Explore transition timing could make a visible search box unclickable.

**How to apply:** Keep the live-node-first order, three fresh dumps, top-region bound, and diagnostic log of the selected resource node/attempt.