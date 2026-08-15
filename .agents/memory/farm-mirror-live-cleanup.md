---
name: Farm mirror-live cleanup
description: Lifecycle rule for the Phone Farm SVG thumbnail mirror state.
---

The Farm page's SVG thumbnail uses a server-side per-serial mirror-live flag to decide whether to poll screencaps. That flag must remain set when an active detail mirror unmounts so the Farm card can continue showing the active device across navigation; it must be cleared when the mirror is explicitly turned off or an automation cycle finishes.

**Why:** Clearing the marker on detail-page unmount made the Farm page lose a mirror that was still active. Keeping the marker alone is unsafe because an asleep/off device can return a black PNG, so the Farm client validates captures before displaying them.

**How to apply:** Signal the serial-level marker from the detail mirror's `live` transitions, without an unmount cleanup. On the Farm card, only replace wallpaper/text after a screenshot loads and has visible pixels; failed or fully black captures must leave the wallpaper visible. Automation-cycle cleanup should also clear the marker.