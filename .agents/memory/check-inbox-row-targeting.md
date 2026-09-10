---
name: Check Inbox row targeting
description: The Check Inbox tool should tap a generic visible inbox row without semantic identity filtering, then use its existing Back flow.
---

Check Inbox is intentionally geometry-only when choosing a row. It should scan the live UI hierarchy for a row-shaped rectangle in the inbox body, tap any one of those rows, and use the calibrated `settingsBack` mirror control for every Back step. Do not require sender names, message previews, timestamps, content descriptions, resource IDs, or clickable flags.

**Why:** Instagram inbox accessibility hierarchies vary by build, and the requested behavior is to open any row rather than classify a specific conversation. Semantic filters caused valid visible rows to be rejected.

**How to apply:** Keep only geometric exclusions for fixed header and bottom-navigation areas, choose among visible row-shaped bounds, avoid adding thread-identity or post-tap validation gates, and dispatch Back through `tapCalibratedNavigationControl(serial, "settingsBack", onLog)` rather than Android `KEYCODE_BACK`.