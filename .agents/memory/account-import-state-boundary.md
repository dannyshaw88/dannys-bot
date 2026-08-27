---
name: Account import state boundary
description: Importing an account onto a device must preserve existing slot-owned TrustScore state.
---

An additive account import must preserve every existing slot's stable identity, TrustScore assignment, countdown timer, automation settings, personality, and related slot-owned state. Only explicit slot deletion or full device removal may purge that state.

**Why:** The Settings → Import flow sends a complete-looking device account list through the same endpoint used for destructive slot-list saves; applying its cleanup to an additive import restarted countdowns for every existing slot.

**How to apply:** Mark additive imports explicitly at the request boundary, preserve existing slot IDs when matching incoming accounts, and bypass stale-slot cleanup for that import path. Keep cleanup in explicit deletion/removal paths.