---
name: Account-switch durable boundaries
description: Account-switch failures need persistent boundary markers because the per-device trace is volatile and short-lived
---

Account-switch diagnostics must record durable begin, method/dispatch, confirmed, and returned-false boundaries in the API log, not only the live device stream.

**Why:** A cycle can start and then stop during a device interaction or process restart; the rolling per-device buffer may be gone before a diagnostic is exported, leaving no way to distinguish pre-dispatch, low-level, and post-switch failures.

**How to apply:** Keep boundary markers immediately before and after low-level account-switch calls, and inspect the API log plus rotated logs when diagnosing a missing device trace.