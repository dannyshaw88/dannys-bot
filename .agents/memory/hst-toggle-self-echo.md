---
name: HST toggle self-echo
description: Prevent a local Human Session Tool toggle from being replayed by its own same-window broadcast.
---

The runtime that applies a Phone Farm master-toggle change locally must mark the accepted request before the coordinator dispatches the same-window event. The mounted-runtime event handler should consume that request ID without applying it again.

**Why:** The local React state transition can schedule the immediate timer before the API persistence round-trip completes. Replaying the accepted broadcast afterward can schedule a second zero-delay timer after the first cycle has already entered collision handling.

**How to apply:** Keep Statistics and other remote toggle events on the coordinator handoff path. Only suppress request IDs explicitly accepted by the local Phone Farm caller, and preserve the separate delayed startup/recovery path.