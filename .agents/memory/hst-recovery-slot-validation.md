---
name: HST recovery slot validation
description: Startup recovery must ignore stable slot IDs and stale or out-of-range numeric keys, while busy-device cycles need a short retry.
---

Startup HST recovery must emit only valid numeric account-slot indexes; stable slot IDs and legacy/out-of-range persisted keys are not runnable slot indexes. A device-wide 409 should preserve the enabled turn with a short retry rather than waiting for the normal interval.

**Why:** Slot settings are keyed by both persisted stable identities and legacy numeric entries, while only one cycle can run on a device at a time. Emitting stale keys creates invalid API requests, and dropping busy turns makes enabled tools appear inert.

**How to apply:** Validate and bound recovery records at the API boundary, and make background schedulers retry device-busy responses without changing the normal interval after a successful cycle.