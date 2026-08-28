---
name: Feed action detector independence
description: Safety and packaging rules for Feed Like, Share, DM, and Save icon detection.
---

The visual Like detector is the only permitted source for a Like tap, but its failure must not suppress independently validated Share-to-Feed, Share-via-DM, or Save actions. A live accessibility Like node may establish the current action-row anchor for those optional controls only; it must never be treated as a confirmed Like target.

**Why:** A screenshot/detector failure was logged as “no Like” and skipped three unrelated action families together. Save also failed because its reference was missing from the development lookup path and was silently omitted by Windows packaging.

**How to apply:** Keep Like fail-closed and mark whether its visual match is confirmed. Resolve optional controls from their own live identity/visual checks. Store visual references in a source-controlled Electron asset root, search the workspace root during development, and make packaging fail loudly when a required reference is absent.