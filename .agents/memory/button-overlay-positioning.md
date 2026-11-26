---
name: Button overlay positioning
description: Positioning toolbar buttons without conflicting with shared elevation styles.
---
Position overlay buttons through an absolutely positioned wrapper rather than relying on an absolute class on the shared Button itself.

**Why:** The shared elevation styles require relative positioning and can override the Button's absolute utility, putting an address-bar control into normal flow and changing the toolbar height.

**How to apply:** Keep the Button's elevation behavior inside a positioned wrapper and verify the toolbar visually. Avoid changing shared elevation styles to fix a single control.
