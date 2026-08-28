---
name: Feed action input transactions
description: Keep live Feed action validation and the resulting ADB action ordered on each device.
---

Live Feed accessibility validation, action taps, navigation recovery, and post-action verification must execute inside one per-device input transaction; unrelated device input must queue behind it.

**Why:** A resource-id can be unique in a recycled Instagram accessibility tree while still belonging to the wrong visible post. Even a correctly validated node can become unsafe if another ADB gesture lands between the final scan and tap.

**How to apply:** Use the shared per-device transaction wrapper around the final Feed scan/action/verification sequence. Keep direct ADB input helpers on the same gate, while preserving the manual double-tap gesture’s single-shell timing.