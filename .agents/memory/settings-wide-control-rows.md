---
name: Settings wide control rows
description: Layout rule for settings cards that pair long explanatory copy with a field or action
---

Long explanatory copy in Settings should use the full available content width, with its adjacent field or action in a top-aligned desktop column and a stacked narrow-screen fallback.

**Why:** A narrow Settings wrapper plus vertically centered controls makes the copy wrap into an unnecessarily narrow column and visually separates the control from the setting it describes.

**How to apply:** When adding or adjusting a Settings card with explanatory text and a control, avoid a page-local narrow max-width and avoid vertical centering when the text can wrap. Keep the control aligned with the first line of the explanation.