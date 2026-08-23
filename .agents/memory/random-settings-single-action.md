---
name: Random settings single-action flow
description: Safety rule for Phone Farm Human Session Tool random settings visits
---

The Phone Farm “Visit Random Settings” action must be limited to one validated top-level settings-row tap, optionally one scroll, and two Back presses: one from the selected page and one from “Settings and activity.” It must never tap a subsetting.

**Why:** The first Back exits the selected setting to “Settings and activity”; a second Back is required to leave that surface and return to Instagram.

**How to apply:** Keep the sequence as `open Settings → tap one validated row → optional scroll → Back → Back`. If no validated row is available, skip the setting action safely rather than guessing a coordinate.