---
name: Automation cycle HTTP connections
description: Keep simultaneous phone executions from occupying browser HTTP connections for their full duration.
---

Start cycles with promptly acknowledged background jobs and retrieve completion through short requests. Never solve connection starvation by staggering device schedules.

**Why:** During simultaneous Windows farm starts, normal HTTP completions disappeared for over a minute while API timers and phone actions continued. Long-lived cycle requests can occupy the browser's per-origin connection pool without high CPU/RAM usage.

**How to apply:** Preserve cycle IDs, per-device exclusion, targeted aborts, original result/status data and scheduling after completion. Publish completion only after cleanup releases device ownership. An acknowledgement is not a finished cycle. Keep legacy synchronous callers compatible. Physical Windows verification is still required before claiming that observed farm freezes are resolved.
