---
name: Instagram Home tab icon detector
description: Home-tab detection uses the attached house-icon screenshot, not accessibility labels or resource IDs
---

The Instagram Home-tab action must locate the live house glyph from a screenshot using a glyph-trimmed, scale-aware, polarity-invariant template match with an explicit minimum confidence gate.

**Why:** Some Instagram builds visibly render the left Home button while exposing no usable Home node through UIAutomator, so semantic lookup silently fails. The original full-crop matcher over-weighted the reference background and silently discarded weak matches without diagnostics.

**How to apply:** Trim the reference to its non-background glyph, scan the left bottom-nav region across density scales, retain the real best score, log capture/reference/rejection details, and reject below the confidence threshold. Never restore a fixed-coordinate or accessibility fallback. Package the reference with Electron.