---
name: Mobile Phone Apps explicit rows
description: The Phone Farm Google Chrome settings layout must use explicit full-width row wrappers
---

The `AppSlotRow` must use one shared six-column template for the first row and every following row: app label, activation, then five field columns. Secondary rows need a leading spacer for the label column so controls line up exactly with Row 1; never use an independent equal-width grid or flex wrap.

**Why:** A screenshot-based UI request exposed that natural flex wrapping can make a field appear on the right line at one width while still belonging to the wrong structural row.

**How to apply:** When moving controls between Phone Farm rows, change the row composition and preserve the existing field handlers; verify at the actual narrow device-panel width, not only at desktop width.