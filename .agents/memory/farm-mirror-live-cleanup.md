---
name: Farm mirror-live cleanup
description: Lifecycle rule for the Phone Farm SVG thumbnail mirror state.
---

The Farm page's SVG thumbnail uses a server-side per-serial mirror-live flag to decide whether to poll screencaps. That flag must be cleared when the detail-page mirror unmounts, not only when the user explicitly presses a stop control.

**Why:** The detail mirror can be unmounted while the phone is asleep, disconnected, or otherwise producing no usable frame. Leaving the flag set makes the Farm card keep replacing its configured wallpaper/text with a black or stale screencap.

**How to apply:** Treat a mounted, active detail mirror as the source of truth. Signal `on: false` in the mirror-live effect cleanup when the current instance was live; use request keepalive for the cleanup POST so navigation can still deliver it. Automation-cycle cleanup should also clear the flag.