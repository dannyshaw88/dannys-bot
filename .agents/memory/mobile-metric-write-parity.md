---
name: Mobile metric write parity
description: Durable rule for adding and migrating Human Session Tool counters
---

When adding a mobile HST counter, update every persistence path: normal cycle completion, pre-switch attribution, and aborted-cycle recovery. If historical rows used a different key, provide a read-time compatibility alias so existing history is not silently lost.

**Why:** A metric can appear in the Dashboard activity summary while remaining zero in Tool Performance when one lifecycle path or the table-specific key is omitted.

**How to apply:** Trace the counter from operation result through each cycle-finalization branch into the storage read model, and await writes when the caller can immediately reload statistics.