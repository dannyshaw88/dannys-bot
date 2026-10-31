---
name: Mirror wake and stale status
description: Boundary between the Farm-page initial wake grace period and automation-controlled phone sleep, plus decoder-gap status handling
---

The mirror's 10-second wake behavior is a single Farm-page recovery attempt, not a recurring keepalive. On explicit Farm selection, start the conditional screen-on request in parallel with navigation; once the mirror connects, run display readiness alongside stale-stream cleanup. If startup is still in progress and the display has gone off, allow that one delayed wake even if the screen was initially on. Automation owns the phone lifecycle and may intentionally lock or sleep the device between turns, so skip the retry during automation. A screen-off device may also keep producing decoded all-black frames, so frame freshness by itself is not proof that the display is still on.

**Why:** The user expects a Farm-selected mirror to be ready immediately; intermittent stream startup has allowed a short-timeout device to fall back to standby before the first frame. The H.264 stream can also have multi-second gaps during UIAutomator and chained ADB work while the phone remains awake and tools continue successfully.

**How to apply:** Keep display readiness early and allow only one delayed wake retry for a Farm mirror, never a periodic wake during automation. Make client stale-frame thresholds match the server's automation-aware stall policy rather than treating every short decode gap as a sleeping phone. Separately detect sustained near-black pixels inside the phone image (not letterbox bars) so the mirror and Power button can report asleep when black frames continue.