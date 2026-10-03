---
name: Collision Preventer turn priority
description: Per-device FIFO scheduling, preserved HST due timestamps, post-cycle rest, and the manual override lane.
---

Scheduled Collision Preventer entries run in per-device collision-request arrival order (FIFO), not by their original Human Session due timestamp. Let the active cycle finish, apply the configured device rest, then run the oldest queued request. Keep each slot's original HST due timestamp for its timer lifecycle; after its queued cycle completes, it receives a new HST interval.

**Why:** The user expects the first account that collided to receive the next turn after the active account and rest period; due-time sorting can let a later-arriving account overtake it.

**How to apply:** Capture collision arrival order before asynchronous configuration loads, sort scheduled queue entries FIFO per device, and retain the original HST due timestamp only for timer bookkeeping. Do not release queued turns by creating a second HST timer. Any background/recovery runner that can own an HST timer must pass through the same device-level collision gate; direct cycle POSTs bypass the UI hook.

While a slot owns or awaits a collision lease, a React/runtime remount must not create a replacement normal HST interval. The collision coordinator's pending state is authoritative until the queued cycle releases its lease.

**Why:** The consumed HST timer is intentionally absent while the slot waits for the device cooldown. Treating that absence as startup recovery schedules the account another full HST interval later instead of at the next configured collision turn.

**How to apply:** Preserve a durable pending marker keyed by device and slot across UI remounts; clear it only on queued cancellation or lease release, then let the completed queued cycle schedule the next normal interval.

Explicit manual HST off→on requests are a separate priority lane: they may not overlap an active device cycle, but they bypass the scheduled collision rest window, run before queued scheduled turns, and must not start a new rest window after completion.

**Why:** Users expect an explicit toggle to run immediately; treating it like a scheduled timer made the first manual request appear inert until a later toggle happened to land outside the rest window.

**How to apply:** Mark only the next cycle initiated by an Accounts or Statistics toggle as manual, prioritize it in the shared coordinator, and carry that marker through lease release so scheduled timers retain normal collision behavior.