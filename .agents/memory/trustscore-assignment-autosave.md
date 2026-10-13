---
name: TrustScore assignment autosave isolation
description: HST settings saves racing TrustScore label changes must not create mismatched tool overrides.
---

Tool enable overrides are specific to the slot's current TrustScore assignment. Clear them when the assignment changes, and reject full settings autosaves whose `trustScoreId` no longer matches the slot's current assignment. This includes a transition to manual mode; a stale response must not seed overrides for a later assignment.

**Why:** HST settings autosave is debounced while TrustScore changes trigger a re-hydration. An old effective-settings response can arrive after the new assignment and persist old template booleans as new per-slot overrides.

**How to apply:** Preserve overrides when the assignment is unchanged. On an actual transition, clear old per-slot tool overrides and verify the server ignores any mismatched autosave payload before recording tool values.
