---
name: Snapchat idle recovery ordering
description: Ensure the idle watchdog's Snapchat reopen survives normal cycle cleanup.
---

When the Snapchat idle watchdog fires, abort the stalled tool and perform the wake/unlock/reopen from cycle finalization after the tool worker unwinds, but before releasing the device lease. Do not rely on a short independent timeout: cycle teardown can cancel it before it runs.

**Why:** A 1.5-second recovery timer was canceled by finalization when the aborted tool unwound quickly, so the watchdog logged that it was preparing a reopen but Snapchat never reopened.

**How to apply:** Preserve this ordering whenever the Snapchat watchdog or cycle cleanup is refactored; verify recovery with a stalled-tool device test.
