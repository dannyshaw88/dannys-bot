---
name: Mobile Search tab detector
description: Reliable accessibility-only detection for Instagram's unlabeled bottom Search tab on MIUI devices
---

Instagram builds may expose bottom navigation buttons as unlabeled clickable UIAutomator nodes. The Search tab can be identified from a validated, full-width bottom-nav row after collapsing parent/child duplicates; its tap point must come from the selected node's own bounds.

**Why:** A screen-relative fallback tapped the wrong location when the accessibility tree changed, and XML dumps without root bounds could make percentage thresholds use an incorrect landscape default.

**How to apply:** Use the live device size only to establish detection thresholds when XML root bounds are missing. Never invent a tap coordinate from screen dimensions; return null and skip when no validated accessibility node exists. Keep Follow and View Explore on the same detector.