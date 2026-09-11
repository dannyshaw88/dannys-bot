---
name: Check Inbox row targeting
description: Check Inbox taps a generic visible inbox row; calibrated Back is only for a clicked thread.
---

Check Inbox is intentionally geometry-only when choosing a row. It should scan the live UI hierarchy for a row-shaped rectangle in the inbox body and tap any one of those rows. A calibrated `settingsBack` mirror Back is only valid after the click-thread branch actually opens a conversation; do not press Back at the end of an inbox-only check.

**Why:** Instagram inbox accessibility hierarchies vary by build, and the requested behavior is to open any row rather than classify a specific conversation. Semantic filters caused valid visible rows to be rejected.

**How to apply:** Keep only geometric exclusions for fixed header and bottom-navigation areas, choose among visible row-shaped bounds, avoid adding thread-identity or post-tap validation gates, and dispatch the conditional thread Back through `tapCalibratedNavigationControl(serial, "settingsBack", onLog)` rather than Android `KEYCODE_BACK`.