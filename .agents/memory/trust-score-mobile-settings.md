---
name: Trust Score mobile settings
description: The Trust Score editor's Human Session Tool is the mobile-engine configuration surface
---

Trust Score tiers intentionally use the mobile-engine Human Session Tool controls. They must not be implemented with the browser-engine `HumanSessionPanel` or its Follow/Unfollow/Contact tabs.

**Why:** The mobile farm automation schema and controls are the product surface the user configures for phone accounts; the browser-engine panel has a different data model and behavior.

**How to apply:** Reuse the mobile automation settings data/UI for tier editing, persist tier templates separately from physical device/slot settings, and keep template editing from starting a live phone automation cycle.