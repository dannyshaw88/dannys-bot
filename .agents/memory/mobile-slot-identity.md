---
name: Mobile slot identity
description: Stable identity rules for device account slots and their persisted state.
---

Every device account slot has an opaque persisted `slotId`. Account-owned state must resolve through that ID rather than the visible array index, because deleting a slot renumbers all later accounts.

**Why:** Numeric slot keys caused Trust Score assignments, timers, and automation settings to transfer from a deleted account to the next account.

**How to apply:** Keep index-based URLs only as a lookup layer; resolve the current slot to `slotId`, persist generated IDs during legacy migration, use stable React keys for mounted per-account components, and include the ID in HST state/settings requests during deletion compaction races.

For automation cycles, resolve the submitted stable `slotId` to its unique current index before loading slot configuration. Treat the submitted index as advisory; reject missing or duplicate IDs rather than running against whichever account now occupies that index.

**Why:** A queued timer can outlive an account reorder. Strictly requiring its captured index and stable ID to still match made the device grant the collision lease, then reject the cycle as “account slot changed.”

**How to apply:** Use the same resolved current index throughout the cycle’s settings, active-slot state, and logs. Keep the rejection path fail-closed when the stable ID cannot be uniquely found.

On account reads and saves, normalize the full slot list so every persisted `slotId` is unique. If an incoming save repeats an ID, retain the prior slot identity at that position only when platform and username still match; otherwise repair the collision and preserve any state that was shared under the duplicate ID.

**Why:** Duplicate Snapchat slot IDs caused React to reuse one slot’s settings component and made both slots read and write the same execution window.

**How to apply:** Check uniqueness at account read and write boundaries, use stable IDs in copy-settings selections and requests, and migrate shared settings when repairing a pre-existing duplicate.