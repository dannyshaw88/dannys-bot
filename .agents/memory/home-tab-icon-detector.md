---
name: Instagram Home tab icon detector
description: Home-tab detection uses the attached house-icon screenshot, not accessibility labels or resource IDs
---

The Instagram Home-tab action must locate the live house glyph from a screenshot using the same full-crop, scale-aware, polarity-invariant normalized-correlation matcher as the reliable View Feed heart detector, with a logged best candidate and an explicit final confidence gate.

**Why:** Some Instagram builds visibly render the left Home button while exposing no usable Home node through UIAutomator, so semantic lookup silently fails. A separate Home matcher had drifted from the known-good heart implementation and rejected valid screens differently.

**How to apply:** Reuse the heart detector's full-crop template treatment, scales, sampling, and normalized correlation; retain the best candidate for diagnostics and reject below the final 0.72 gate. Only constrain the search to the left bottom-nav region. Serialize Home scans per device and yield between scan rows so repeated safety gates cannot stack native screenshot work or starve the API. Never restore a fixed-coordinate or accessibility fallback. Package the reference with Electron.