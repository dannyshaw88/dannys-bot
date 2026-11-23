---
name: Large automation-settings requests
description: Keep large per-slot automation saves reliable when user-uploaded text lists and prompts are included.
---

Full per-slot automation settings can carry large uploaded text lists and user prompts. The browser's `keepalive` request quota is limited, so settings saves should use a regular fetch and log only the serialized payload byte count, never the settings contents.

**Why:** A Windows Electron diagnostic showed settings-save fetches fail before reaching the API while later reads returned the old saved values. The uploaded avoid-list file alone was about 49 KB; request-size telemetry was added to verify the full payload on a later run.

**How to apply:** Keep `keepalive` off for full settings writes. If a later failure persists, use the logged payload byte count and request/network error to distinguish size/quota from transport or lifecycle failures before changing persistence behavior.
