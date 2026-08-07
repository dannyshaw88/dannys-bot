---
name: Random settings single-action flow
description: Safety rule for Phone Farm Human Session Tool random settings visits
---

The Phone Farm “Visit Random Settings” action must be limited to one validated top-level settings-row tap, optionally one scroll, and one Back. It must never tap a subsetting or use a blind screen-coordinate tap.

**Why:** Instagram can render nested settings differently across builds, and a second setting/subsetting tap can leave the phone in an unexpected screen and break the automation flow.

**How to apply:** Keep the sequence as `open Settings → tap one validated row → optional scroll → Back`. If no validated row is available, skip the setting action safely rather than guessing a coordinate.