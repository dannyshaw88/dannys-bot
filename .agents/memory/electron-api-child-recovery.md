---
name: Electron API child recovery
description: Packaged desktop behavior when the embedded API process exits unexpectedly
---

An unexpected nonzero API-child exit must be recovered by Electron with an identity-safe, bounded restart; normal quit and backup restore must not trigger recovery.

**Why:** The packaged app previously stayed open while its API child died, leaving the desktop UI unusable and reporting a software crash.

**How to apply:** Guard restart scheduling by the exact child instance, log the exit code and attempt, and keep a finite retry limit to avoid restart loops.