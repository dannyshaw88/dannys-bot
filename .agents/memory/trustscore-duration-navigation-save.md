---
name: TrustScore duration navigation save
description: TrustScore duration inputs must flush pending debounced writes when the settings view unmounts.
---

TrustScore duration changes are debounced for normal typing, but any pending value must be persisted during unmount/navigation as well.

**Why:** Leaving the TrustScore settings view before the debounce elapsed used to clear the timer and silently reset the duration on the next visit.

**How to apply:** Keep pending duration values in a ref, cancel the delayed timer during cleanup, and immediately send the latest value with a navigation-safe request.

An edited duration is also authoritative for already-assigned slots. The timer
endpoint must reconcile a persisted timer's `durationHours` with the currently
configured badge duration before calculating or returning remaining time, and
duration updates must resolve both stable slot-ID and legacy numeric assignment
keys.

**Why:** A stale timer could continue counting down with an older value (for
example 75 hours) after the settings field was changed to 50 hours.

**How to apply:** On timer reads, restart the slot timer with the configured
duration when the persisted duration differs; on duration writes, initialize or
replace timers for every matching assignment, including legacy assignments.