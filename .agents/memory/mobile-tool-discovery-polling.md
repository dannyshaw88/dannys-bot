---
name: Mobile tool discovery polling
description: Preventing Windows event-loop freezes from repeated Android tool detection during mobile screenshot polling
---

Tool discovery and display-size probes must be cached or performed asynchronously before high-frequency mobile polling and gesture paths. `detectToolset()` includes synchronous process version probes, and `wm size` can also block while ADB is busy on Windows.

**Why:** The packaged desktop app showed simultaneous screenshot failures and a 30+ second event-loop stall while the API process itself remained alive.

**How to apply:** Keep screenshot/status endpoints on cached tool paths, coalesce per-device display-size reads, and refresh stale tool paths in the background. Never run either probe once per poll or once per gesture.