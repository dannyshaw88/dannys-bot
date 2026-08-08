---
name: TrustScore persistence and loading
description: TrustScore assignments and countdowns must migrate legacy numeric keys, while account panels must not wait on profile hydration.
---

TrustScore storage must read stable slot-ID keys first and fall back to legacy serial-plus-index keys, migrating them on read. Account-slot loading must render saved slots before profile-based TrustScore hydration completes.

**Why:** Stable slot IDs changed the key space and made older timers appear missing after restart; profile hydration also added one profile request plus one request per slot to the account panel's critical path.

**How to apply:** Preserve legacy assignment/timer fallbacks whenever slot identity changes, and run compatibility hydration asynchronously after the account list is interactive.