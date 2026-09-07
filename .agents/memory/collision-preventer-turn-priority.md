---
name: Collision Preventer turn priority
description: How device-level collision scheduling must preserve Human Session due times while enforcing a post-cycle rest window.
---

Collision Preventer queue priority must be based on each slot's original Human Session scheduled turn, not on the time its collision request executes or the time the previous slot finishes. A queued slot runs immediately after the configured collision rest; only after that cycle completes does it receive a new Human Session interval.

**Why:** Resetting the interval when a collision is prevented makes overdue accounts wait another full Human Session window and lets scheduling drift away from account priority.

**How to apply:** Capture the HST due timestamp before clearing timer UI state, keep it immutable in the queue, sort by due time with a stable slot tie-breaker, and never release queued turns by creating a second HST timer. Any background/recovery runner that can own an HST timer must pass through the same device-level collision gate; direct cycle POSTs bypass the UI hook.

Explicit manual HST off→on requests are a separate priority lane: they may not overlap an active device cycle, but they bypass the scheduled collision rest window, run before queued scheduled turns, and must not start a new rest window after completion.

**Why:** Users expect an explicit toggle to run immediately; treating it like a scheduled timer made the first manual request appear inert until a later toggle happened to land outside the rest window.

**How to apply:** Mark only the next cycle initiated by an Accounts or Statistics toggle as manual, prioritize it in the shared coordinator, and carry that marker through lease release so scheduled timers retain normal collision behavior.