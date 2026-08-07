---
name: Mobile offline HST gate
description: Human Session Tool must pause on any non-ready ADB state and resume after the same device returns ready.
---

The mobile Human Session Tool treats an attached phone whose ADB state is not
`device` (especially `offline`) as unavailable: every account-slot timer,
queued turn, and in-flight cycle is stopped, while the saved enabled setting
remains enabled so the same serial can resume after reconnection. The API also
revalidates the live ADB state immediately before starting a cycle.

**Why:** A phone can remain in the farm list while its ADB transport is offline;
starting automation in that window sends taps and lifecycle commands to a
device that is not actually controllable.

**How to apply:** Keep the client gate and server-side live-device check
together whenever the mobile automation scheduler or cycle endpoint changes.