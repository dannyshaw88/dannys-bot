---
name: Instagram Stories exit confirmation
description: Do not let the next mobile tool inherit an open Story viewer.
---

An exit swipe is not proof that the Story viewer closed. Confirm the viewer is gone before the dispatcher begins another phone tool. If it remains open, press Android Back once and verify again; when dismissal is still unconfirmed, stop the remaining tool sequence.

**Why:** On 2026-10-03, the farm log reported Stories complete after a downward swipe, but the following UI dump still contained the Story viewer. Follow then repeated calibrated Search taps against that screen.

**How to apply:** Check the viewer after every final Stories exit gesture. Preserve the fail-closed behavior if verification fails; never let downstream tools act on an assumed Home/Search surface.