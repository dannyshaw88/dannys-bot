---
name: Split HST toggle ownership
description: HST settings controls and extracted scheduler listeners must not turn transient duplicate toggle events into separate writes or cycles
---

When HST UI ownership is split across pages/components, coordinate toggle events outside React and commit only the final settled state for each device/slot key.

**Why:** The refactor allowed reconciliation to emit an off event followed immediately by an on event, causing duplicate persistence and a device-busy cycle race.

**How to apply:** Keep one shared toggle coordinator per serial plus stable slot identity; debounce same-tick opposite events before persistence and scheduler broadcast.

Startup recovery is a separate scheduler path and must forward the persisted stable `slotId` returned by settings; sending only a numeric slot index is rejected as a moved/stale account slot.

**Why:** The background recovery runner does not have MobilePage's account-slot props, so omitting the identity caused every recovered cycle to receive a 409 even when no device cycle was active.

**How to apply:** Include `slotId` in the per-slot settings response and in every background cycle request; keep numeric slot indexes only for locating the current slot record.