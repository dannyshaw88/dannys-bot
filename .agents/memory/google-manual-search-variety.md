---
name: Google manual search variety
description: Distribution rule for the built-in Chrome Google search history generator
---

Manual Google searches should use a random 1–5 word length: one-word terms are an occasional roughly 5% exception, while normal searches are distributed across 2–5 word natural phrases or questions.

**Why:** A history made entirely from single keywords is visibly artificial and does not resemble ordinary Google search behavior.

**How to apply:** Bucket candidates by exact word count, select 1 word only occasionally and otherwise choose 2–5 words, with fallback to another non-empty bucket. Preserve unique-query selection within each manual-search cycle and log the selected count.