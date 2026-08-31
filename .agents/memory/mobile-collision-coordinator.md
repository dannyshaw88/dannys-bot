---
name: Mobile collision coordinator
description: The invariant that all mobile device automation owners share one lease-based collision gate.
---

Every mobile device automation owner must use the shared per-device collision coordinator and release the exact lease token it acquired; slot indexes are not sufficient ownership identifiers.

**Why:** Mounted HST runtimes, background recovery, and Mobile Phone Apps can run in separate lifecycle paths. Independent queues allow overlapping device work, while stale completions can otherwise release a newer cycle.

**How to apply:** Route new device-level automation callers through the coordinator, preserve the original scheduled due time for queue ordering, and keep server busy checks as a defensive backstop rather than a replacement for the client-side gate.