---
name: Make a Post UI — image alteration scope
description: Where the Alteration level / Image settings controls live in the mobile Make a Post panel and why, relevant to future edits of that panel.
---

In `artifacts/dannys-bot/src/pages/MobilePage.tsx`'s "Make a Post" automation panel, the **Alteration level** button group and the **Image settings** "Configure" button (opens `ImageSettingsDialog`) live in the shared caption section — directly below the caption textarea — rather than nested inside the "Source: Instagram Account" block.

**Why:** they were originally scoped only to the Instagram-account scrape source, but the user's actual workflow is mostly posting from a local computer folder ("Source: My Computer"), not scraped Instagram images. Image alteration should apply no matter which source produced the image, so the controls were moved out of the per-source block into the shared caption area (13 Jul 2026 change).

**How to apply:** if you add a new post-image source to this panel, don't gate alteration/image-settings behind that source's enabled flag — they're global to whichever image gets picked. `makePostAlterationLevel` and `makePostImageSettings` remain top-level `AutomationSettingsData` fields either way.
