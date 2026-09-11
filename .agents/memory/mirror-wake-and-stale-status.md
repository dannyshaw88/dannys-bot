---
name: Mirror wake and stale status
description: Boundary between the Farm-page initial wake grace period and automation-controlled phone sleep, plus decoder-gap status handling
---

The mirror's 10-second wake behavior is an initial Farm-page recovery grace period, not a recurring keepalive. Automation owns the phone lifecycle and may intentionally lock or sleep the device between turns, so periodic WAKEUP keyevents can interfere with that lifecycle and create misleading mirror states.

**Why:** The H.264 stream can have multi-second gaps during UIAutomator and chained ADB work while the phone remains awake and tools continue successfully. A client asleep threshold shorter than the server's automation stall tolerance turns those normal gaps into a false “Screen is asleep” overlay.

**How to apply:** Keep one delayed wake retry only when the connection started with the screen not confirmed on, re-check the live screen state immediately before sending it, and skip it once automation is active. A physical Power press or `ensureScreenOn` can make the original state stale while the timer is pending. Make client stale-frame thresholds match the server's automation-aware stall policy rather than treating every short decode gap as a sleeping phone.