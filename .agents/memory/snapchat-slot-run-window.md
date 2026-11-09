---
name: Snapchat per-slot run windows
description: Product rule for independently scheduling Snapchat account slots by PC-local time.
---

Each Snapchat Human Session Tool slot may have its own 24-hour PC-local start/end window. Never hardcode or assume clock values; use that slot's saved window and timezone. Do not start outside it; recheck after collision waits. If a cycle starts inside the window, let its current tools finish and run normal cleanup even if it crosses the end boundary; defer the next cycle until the next opening. Overnight windows are valid. Both fields blank means unrestricted for compatibility, while partial, malformed, or identical times fail closed. Persist the PC's IANA timezone so the API server and UI use the same clock even when they run on different hosts.

**Why:** The user wants separate work batches per Snapchat account slot and no new cycle outside its window, but clarified on 2026-11-09 that an already-running cycle should finish and clean up after the window closes rather than abort mid-cycle.

**How to apply:** Keep the UI timer, background recovery timer, persisted settings schema, and API start gate aligned. Never abort an in-flight cycle solely because the window closes; allow its cleanup path to run, then schedule the next cycle for the next opening. Treat the window as slot-owned in both TrustScore ownership maps and copy it only through Snapchat Step 1 settings.
