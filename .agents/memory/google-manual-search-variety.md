---
name: Google manual search variety
description: Distribution rule for the built-in Chrome Google search history generator
---

Manual Google searches should normally be multi-word phrases or natural questions/sentences. Isolated one-word terms are an occasional exception, targeted at roughly 5% of selected searches.

**Why:** A history made entirely from single keywords is visibly artificial and does not resemble ordinary Google search behavior.

**How to apply:** Keep one-word candidates in a separate small pool and make the runtime selector prefer the multi-word/natural pool. Preserve unique-query selection within each manual-search cycle.