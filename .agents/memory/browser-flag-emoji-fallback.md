---
name: Browser flag emoji fallback
description: Chromium environments without a color emoji font can render regional flag emoji as country-letter abbreviations
---

Use explicit inline flag artwork for user-visible country selectors instead of relying on regional-indicator emoji.

**Why:** The Phone Farm preview rendered a stored flag emoji as “NL” in Chromium, which looked like a country acronym rather than a flag.

**How to apply:** For compact country controls, render deterministic SVG/CSS flag graphics while keeping ISO codes only in data and accessibility metadata.