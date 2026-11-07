---
name: Snapchat per-slot run windows
description: Product rule for independently scheduling Snapchat account slots by PC-local time.
---

Each Snapchat Human Session Tool slot may have its own 24-hour PC-local start/end window. Do not start outside it; recheck after collision waits; stop an active cycle at the end boundary. Overnight windows are valid. Both fields blank means unrestricted for compatibility, while partial, malformed, or identical times fail closed. Persist the PC's IANA timezone so the API server and UI use the same clock even when they run on different hosts.

**Why:** The user wants separate work batches per Snapchat account slot and explicitly requires no automation outside each slot's window.

**How to apply:** Keep the UI timer, background recovery timer, persisted settings schema, and API cycle gate aligned. Treat the window as slot-owned in both TrustScore ownership maps and copy it only through Snapchat Step 1 settings.
