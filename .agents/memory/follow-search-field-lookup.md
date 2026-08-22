---
name: Follow search field lookup
description: Follow must locate the Instagram search bar from normal reference imagery
---

Follow search lookup is visual-only: compare the live screenshot with the normal, un-tapped search-bar reference imagery in the top 15% of the screen, then tap the centre of the matched reference rectangle. Do not add UIAutomator lookups, semantic fallbacks, guessed coordinates, or tapped/target reference states.

**Why:** The bar has a stable visual position and shape, while accessibility exposure is intermittent on this Instagram surface. The user explicitly requires the existing visual method to be made more reliable, not replaced with alternate target-selection paths.

**How to apply:** Keep the scan top-region bounded and single-flight per device. Use only normal reference images and tap their matched centre.