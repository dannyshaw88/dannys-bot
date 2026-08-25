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

The mounted MobilePage slot runtime is the authoritative owner when present; the
always-mounted app listener must not start a second background loop for the same
serial/slot broadcast.

**Why:** A Stats-page ON broadcast was consumed by both starters, so the first
toggle could persist `enabled=true` without reliably starting the visible slot
runtime.

**How to apply:** Track mounted runtime keys in shared HST state and let the
app-level listener start only slots that have no mounted runtime.

Reels watch duration is personality-adjusted at the shared effective-settings
layer, so the visible editor and automation payload receive the same slot-specific range.

**Why:** Reels previously varied watch percentage per clip but ignored the account's
Attention and Consumption traits, making those personalities incomplete.

**How to apply:** Keep the saved watch range as baseline; apply bounded Attention
scaling primarily and a smaller inverse Consumption scaling, then clamp min/max.