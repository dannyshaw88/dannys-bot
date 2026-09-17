---
name: Collision Preventer turn priority
description: How device-level collision scheduling must preserve Human Session due times while enforcing a post-cycle rest window.
---

Collision Preventer queue priority must be based on each slot's original Human Session scheduled turn, not on the time its collision request executes or the time the previous slot finishes. A queued slot runs immediately after the configured collision rest; only after that cycle completes does it receive a new Human Session interval.

**Why:** Resetting the interval when a collision is prevented makes overdue accounts wait another full Human Session window and lets scheduling drift away from account priority.

**How to apply:** Capture the HST due timestamp before clearing timer UI state, keep it immutable in the queue, sort by due time with a stable slot tie-breaker, and never release queued turns by creating a second HST timer. Any background/recovery runner that can own an HST timer must pass through the same device-level collision gate; direct cycle POSTs bypass the UI hook.

While a slot owns or awaits a collision lease, a React/runtime remount must not create a replacement normal HST interval. The collision coordinator's pending state is authoritative until the queued cycle releases its lease.

**Why:** The consumed HST timer is intentionally absent while the slot waits for the device cooldown. Treating that absence as startup recovery schedules the account 175–250 minutes later instead of at the 15–20 minute collision turn.

**How to apply:** Preserve a durable pending marker keyed by device and slot across UI remounts; clear it only on queued cancellation or lease release, then let the completed queued cycle schedule the next normal interval.

Explicit manual HST off→on requests are a separate priority lane: they may not overlap an active device cycle, but they bypass the scheduled collision rest window, run before queued scheduled turns, and must not start a new rest window after completion.

**Why:** Users expect an explicit toggle to run immediately; treating it like a scheduled timer made the first manual request appear inert until a later toggle happened to land outside the rest window.

**How to apply:** Mark only the next cycle initiated by an Accounts or Statistics toggle as manual, prioritize it in the shared coordinator, and carry that marker through lease release so scheduled timers retain normal collision behavior.