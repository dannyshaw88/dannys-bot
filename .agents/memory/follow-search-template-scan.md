---
name: Follow search template scan
description: Follow's search-field visual matcher is a large multi-template scan that must not run concurrently or monopolize the API event loop
---

The Follow search-field matcher compares several large templates across many scales and positions. It must be single-flight per device and yield during scan rows and scale bands, just like other native screenshot consumers.

**Why:** The matcher was substantially larger than the Home/heart glyph scans and had no event-loop yields, creating a plausible Windows native screenshot/Sharp crash amplifier when repeated or overlapped.

**How to apply:** Preserve template matching, but serialize requests by device, yield between scan rows, and ship a new packaged Electron version after changes.