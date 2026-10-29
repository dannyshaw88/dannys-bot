---
name: Idle phone-mirror log volume
description: Keep repetitive live-mirror diagnostics out of logs when no phone automation is running.
---

Suppress routine mirror heartbeats, screenrecord starts/exits, and repeated idle restarts while automation is inactive. Keep active-cycle diagnostics and meaningful errors.

**Why:** The user said the post-tool Snapchat logging is unnecessary and overloads the log.

**How to apply:** When adjusting phone-mirror diagnostics, gate repetitive lifecycle events on active automation; do not remove actionable errors or diagnostics needed during a running tool.
