---
name: Mobile slot identity
description: Stable identity rules for device account slots and their persisted state.
---

Every device account slot has an opaque persisted `slotId`. Account-owned state must resolve through that ID rather than the visible array index, because deleting a slot renumbers all later accounts.

**Why:** Numeric slot keys caused Trust Score assignments, timers, and automation settings to transfer from a deleted account to the next account.

**How to apply:** Keep index-based URLs only as a lookup layer; resolve the current slot to `slotId`, persist generated IDs during legacy migration, use stable React keys for mounted per-account components, and include the ID in HST state/settings requests during deletion compaction races.