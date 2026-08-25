---
name: Debug screenshot text
description: Debugging-log composites must wrap complete buffered lines instead of clipping them to a fixed character count.
---

The server-side debugging screenshot is an SVG composite, not a browser screenshot. Its log panel must wrap long entries and expand vertically; fixed one-row rendering hides coordinates and error details needed to audit device actions.

**Why:** The live log can contain complete action diagnostics while the generated screenshot silently replaces the suffix with an ellipsis.

**How to apply:** Preserve the newest buffered source lines, wrap each line for the panel width, and size both the log panel and composite from the wrapped row count.