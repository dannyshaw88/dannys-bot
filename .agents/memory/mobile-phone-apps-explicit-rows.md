---
name: Mobile Phone Apps explicit rows
description: The Phone Farm Google Chrome settings layout must use explicit full-width row wrappers
---

The `AppSlotRow` row props must render as explicit full-width flex rows; putting groups in one wrapping flex container only creates accidental visual lines that change with panel width. For the Google Chrome card, the first row contains activation/scroll/story controls and the second row contains Searches Per Run and Search Result Scrolls.

**Why:** A screenshot-based UI request exposed that natural flex wrapping can make a field appear on the right line at one width while still belonging to the wrong structural row.

**How to apply:** When moving controls between Phone Farm rows, change the row composition and preserve the existing field handlers; verify at the actual narrow device-panel width, not only at desktop width.