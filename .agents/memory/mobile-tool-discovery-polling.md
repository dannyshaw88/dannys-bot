---
name: Mobile tool discovery polling
description: Preventing Windows event-loop freezes from repeated Android tool detection during mobile screenshot polling
---

Tool discovery must be cached or performed asynchronously before high-frequency mobile polling. `detectToolset()` includes synchronous process version probes; calling it for each thumbnail or screencap request can serialize multiple ADB/tool checks on Windows and freeze the API event loop for tens of seconds.

**Why:** The packaged desktop app showed simultaneous screenshot failures and a 30+ second event-loop stall while the API process itself remained alive.

**How to apply:** Keep screenshot/status endpoints on cached tool paths. If tool detection needs to refresh, do it outside request handling or behind an explicit refresh path, never once per poll.