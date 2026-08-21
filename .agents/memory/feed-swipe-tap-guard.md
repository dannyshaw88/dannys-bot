---
name: Feed swipe tap guard
description: Prevent calibrated feed scrolling from becoming an accidental tap
---

Feed scrolling must validate the final dispatched path after profile coordinates, jitter, and Android safe-zone clamping. If the upward travel is too short, recover to a lower-screen upward path with a meaningful minimum distance.

**Why:** A slow or focused gesture with endpoints that collapse near the bottom edge can be interpreted by Instagram as a tap, opening the username under the finger instead of scrolling.

**How to apply:** Keep this guard specific to feed scrolling; other surfaces may intentionally use short gestures or reverse swipes. Log whenever recovery changes the calibrated path so device profiles can be corrected later.