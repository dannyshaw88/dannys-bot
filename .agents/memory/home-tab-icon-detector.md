---
name: Instagram Home tab icon detector
description: Home-tab detection uses the attached house-icon screenshot, not accessibility labels or resource IDs
---

The Instagram Home-tab action must locate the live house glyph from a screenshot using the same scale-aware, polarity-invariant normalized-correlation matcher as the reliable View Feed heart detector, traversing from the bottom-left and using the reference image as the identity check.

**Why:** Some Instagram builds visibly render the left Home button while exposing no usable Home node through UIAutomator, so semantic lookup silently fails. Device-specific percentage or coordinate bounds excluded the valid Home glyph on the Redmi A2, while an arbitrary screen-wide best match could select the wrong control.

**How to apply:** Reuse the reference-image treatment, scale search, sampling, polarity-invariant normalized correlation, bottom-left-first traversal, and explicit 0.72 confidence gate. Do not restore device-specific percentage bounds, fixed coordinates, accessibility fallbacks, or arbitrary best-match selection. Serialize Home scans per device and yield between scan rows. Package the reference with Electron. Treat a post-abort mirror frame as evidence of the UI state, not proof of the server-side screencap; surface capture failure, reference failure, and confidence rejection separately.