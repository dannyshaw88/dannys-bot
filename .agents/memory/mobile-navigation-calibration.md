---
name: Fixed navigation calibration
description: Durable rule for fixed Instagram navigation controls on physical Android devices
---

Fixed Instagram controls must use a device-specific calibration map separate from the keyboard map. The map is bound to the device serial and logical display dimensions; malformed, missing, stale, or out-of-bounds points must fail closed. Dynamic content targets and Android system Back remain separate.

**Why:** Fixed-control detectors and guessed screen percentages vary across Instagram builds and phone resolutions, while a keyboard calibration map has different lifecycle and partial-merge semantics.

**How to apply:** Add fixed controls to the navigation calibration workflow and strict named-control executor. Long-press flows should resolve a calibrated point without dispatching an initial tap.