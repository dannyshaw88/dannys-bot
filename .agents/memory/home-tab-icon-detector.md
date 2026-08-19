---
name: Instagram Home tab icon detector
description: Home-tab detection uses the attached house-icon screenshot, not accessibility labels or resource IDs
---

The Instagram Home-tab action must locate the live house glyph from a screenshot using the same normalized, scale-aware, polarity-invariant template matching as the View Feed Like icon.

**Why:** Some Instagram builds visibly render the left Home button while exposing no usable Home node through UIAutomator, so semantic lookup silently fails.

**How to apply:** Keep the scan restricted to the left side of the bottom navigation and above Android's system navigation strip. Return null on missing/weak visual evidence; never restore a fixed-coordinate or accessibility fallback. Package the reference with Electron.