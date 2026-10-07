---
name: Retired standalone Story publisher settings
description: Compatibility rules after removal of the unused Human Session Tool Story publisher.
---

The standalone Post a Story tool is retired from the HST panel, Copy Settings, activation, cycle dispatch, and operation module. Keep existing `postStory*` schema/default values and per-slot folder paths only for compatibility; they must not reactivate Story posting. Normal Make a Post remains feed-only.

**Why:** The user no longer uses the tool and explicitly asked to remove it. Retaining old settings avoids rewriting existing configuration, while removing every dispatch path prevents a saved enabled flag from triggering automation.

**How to apply:** Keep legacy fields at persistence boundaries but exclude the tool from visible UI, Copy Settings, activation, and normal/pre-switch dispatch. Remove or migrate those fields only with an explicit user-approved data migration.