---
name: Windows installer CI assertions
description: The Windows installer workflow contains source-text verification checks that must track current UI copy.
---

The canonical Windows installer workflow's verification steps must assert current implementation structure and behavior, not historical UI wording.

**Why:** A removed Posted Media phrase caused the web-build job to fail after the API and frontend builds had already passed, preventing the Windows installer job from starting.

**How to apply:** When UI copy changes, update the matching workflow grep checks in the same change; prefer stable rendered fields or behavior markers over incidental prose.