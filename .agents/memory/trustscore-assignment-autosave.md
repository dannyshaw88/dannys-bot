---
name: TrustScore assignment autosave isolation
description: HST settings saves racing TrustScore label changes must not create mismatched tool overrides.
---

For an assigned Phone Farm slot, the TrustScore template is the sole source of truth for every tool's enabled state. Ignore legacy slot-level tool overrides, keep those switches read-only in the HST, and do not persist HST tool-toggle changes as slot overrides. Reject full settings autosaves whose `trustScoreId` no longer matches the current assignment. Clear legacy overrides when the assignment changes.

**Why:** Slot-level overrides caused tools to disagree with TrustScore settings and could make switches appear to turn off later. Debounced HST saves can also race assignment changes.

**How to apply:** Resolve tool booleans directly from the assigned template in both settings reads and cycle execution. Keep slot-level tool values only for manual mode; preserve unrelated slot-owned settings and ensure post-count behavior does not rewrite an assigned template's tool switch.
