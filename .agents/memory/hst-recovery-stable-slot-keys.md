---
name: HST recovery and stable slot keys
description: Startup HST recovery must enumerate account slots and resolve persistent slot IDs before legacy numeric settings keys.
---

HST settings are persisted under each account slot's persistent `slotId`, while the automation route still needs the current numeric slot index. Recovery must enumerate the account slot array, resolve the stable key first, and retain numeric-key fallback for legacy records.

**Why:** Scanning only numeric `slotAutomation` keys silently omitted enabled accounts after the slot-identity migration, making scheduled HST timers appear swallowed on devices that were not currently mounted in the UI.

**How to apply:** Any startup/reconnect enabled-slot discovery must use the account array as the source of numeric indices, ignore stable IDs as route indices, deduplicate legacy and stable matches, and emit per-device recovery diagnostics.