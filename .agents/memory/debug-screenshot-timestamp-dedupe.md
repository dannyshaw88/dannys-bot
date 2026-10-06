---
name: Debug screenshot throttle
description: Bound debug screenshot work while preserving full logs and cycle-boundary evidence
---

Keep every automation log row, but capture no more than one debug screenshot per device every two seconds. Never queue a backlog of routine screenshots while a capture is in flight; coalesce only a pending cycle-complete/failed/aborted frame. Apply the same rate limit to optional Session Recorder screenshots.

**Why:** Automation timestamps have 0.1-second precision, so frequent log rows can otherwise launch up to ten ADB screencaps per second per device. Each composite also resizes and rasterizes images through native Sharp/libvips, creating avoidable CPU and native-library pressure.

**How to apply:** Keep the two-second per-device minimum interval and one-in-flight rule. Reset throttle state at each new account cycle, retain full text logs, and allow one deferred final-cycle screenshot so the rate limit does not erase completion evidence.