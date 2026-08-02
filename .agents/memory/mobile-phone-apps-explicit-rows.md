---
name: Mobile Phone Apps explicit rows
description: The Phone Farm Google Chrome settings layout must use explicit full-width row wrappers
---

The `AppSlotRow` row props must render as explicit full-width rows; putting groups in one wrapping flex container creates accidental lines and column drift. Google Chrome’s first row mirrors YouTube’s primary columns; its second row uses the shared five-column grid in order: Searches Per Run, Search Result Scrolls, Internal Links Clicked %, Manual Searches Activation %, and Search Result Link %. Result Dwell Seconds and Tap Trending Storys remain below. Keep Row 2 Column A fixed while nudging later Row 2 children; Row 3 currently uses separate offsets for its first two children.

**Why:** A screenshot-based UI request exposed that natural flex wrapping can make a field appear on the right line at one width while still belonging to the wrong structural row.

**How to apply:** When moving controls between Phone Farm rows, change the row composition and preserve the existing field handlers; verify at the actual narrow device-panel width, not only at desktop width.