---
name: Feed swipe tap guard
description: Prevent calibrated feed scrolling from becoming an accidental tap
---

Feed scrolling must preserve the configured device-profile endpoints after the profile's own jitter and the shared Android safe-zone clamp. Do not rewrite the path to a generated lower-screen recovery gesture.

**Why:** The device gesture profile is the calibrated physical baseline. Replacing it at runtime makes the logged/saved gesture differ from the gesture actually intended by the operator and can hide the real source of a bad interaction.

**How to apply:** Keep the final resolved path fully observable in `[mobile-input] device-profile swipe resolved` and `[mobile-input] swipe dispatched` logs. Fix invalid coordinates or durations in the saved device profile, not with a hidden Feed-only fallback.