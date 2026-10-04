---
name: Automation image consumption
description: Cleanup policy for images selected by automated posting and avatar-update tools.
---

For Make a Post and Random Actions Update Avatar, delete the selected PC source and any processed or phone-staged copies on every attempt, whether the post or avatar update succeeds or fails. Do not rely on a separate no-repeat history to prevent reuse.

**Why:** The user wants a selected image to stop existing in the tool's PC and device storage so later automation cannot select it again.

**How to apply:** Put cleanup in unconditional finalization, include partial device transfers, and log when deletion cannot be confirmed.