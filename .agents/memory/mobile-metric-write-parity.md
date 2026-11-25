---
name: Mobile metric write parity
description: Durable rule for adding and migrating Human Session Tool counters
---

When adding a mobile HST counter, update every persistence path: normal cycle completion, pre-switch attribution, and aborted-cycle recovery. If historical rows used a different key, provide a read-time compatibility alias so existing history is not silently lost.

**Why:** A metric can appear in the Dashboard activity summary while remaining zero in Tool Performance when one lifecycle path or the table-specific key is omitted.

**How to apply:** Trace the counter from operation result through each cycle-finalization branch into the storage read model, and await writes when the caller can immediately reload statistics.

Popup-imposed Snapchat cooldowns are event statistics, not successful actions: count each newly imposed three-hour cooldown immediately for the current account username, not every cycle skipped while cooling down. Keep this direct write out of finalization aggregates to avoid double counting.

**Why:** The user requested a Cooldown column after Accept Friends, counting each Slow Down popup that imposes the three-hour pause. Immediate persistence keeps a later aborted cycle from losing the event.

**How to apply:** Use the same mobile daily/lifetime statistics namespace as the Snapchat account and preserve ordinary date-range reads.