---
name: View Feed ad-action safety
description: Safety boundary for View Feed actions when Instagram accessibility data is incomplete or a sponsored card is visible.
---

View Feed must treat sponsored/ad markers as a reason to skip the post's scripted actions, and it must never use a proportional or fixed-coordinate fallback for a media double-tap when the media rectangle is not confirmed by the live accessibility tree. A confirmed Like node is the safe fallback; Save and share actions may continue only when their own nodes are positively resolved.

**Why:** An Instagram Xero sponsored card omitted the expected media resource ID. The old proportional fallback landed on advertiser content, opened the browser, and then produced false “liked”/“saved” logs while the automation continued.

**How to apply:** Keep this strict behavior scoped to View Feed. If Instagram changes its accessibility tree, add a node-derived media candidate or skip the risky double-tap; do not restore a screen-proportional guess and do not broaden the shared helper's strict mode to other tools without validating their flows separately.