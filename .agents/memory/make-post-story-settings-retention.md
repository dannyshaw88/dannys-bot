---
name: Make a Post story settings retention
description: Legacy Story destination settings remain persisted for a future standalone Story tool but are not part of the normal Make a Post flow
---

The normal Make a Post tool always uses Instagram's feed-post flow. Legacy Story destination values and the Story automation routine remain stored/server-available for a future separate Story tool, but must not appear in the shared Make a Post UI, Settings, Trust Scores, or Copy Settings.

**Why:** Story posting is being separated into its own tool; removing the persisted values now would lose existing configuration and make future migration harder.

**How to apply:** Keep the legacy fields at persistence/schema boundaries only. Do not include them in shared UI definitions, copyable UI sections, cycle request payloads, or Make a Post destination logic.