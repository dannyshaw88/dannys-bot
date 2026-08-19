---
name: Instagram Home tab icon detector
description: Home-tab detection uses the attached house-icon screenshot, not accessibility labels or resource IDs
---

The Instagram Home-tab action must locate the live house glyph from a screenshot using the same full-crop, scale-aware, polarity-invariant normalized-correlation matcher as the reliable View Feed heart detector, with its explicit confidence gates.

**Why:** Some Instagram builds visibly render the left Home button while exposing no usable Home node through UIAutomator, so semantic lookup silently fails. A separate Home matcher had drifted from the known-good heart implementation and rejected valid screens differently.

**How to apply:** Reuse the heart detector's full-crop template treatment, scales, sampling, normalized correlation, and 0.86/0.72 gates; only constrain the search to the left bottom-nav region. Never restore a fixed-coordinate or accessibility fallback. Package the reference with Electron.