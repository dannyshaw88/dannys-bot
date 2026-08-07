---
name: Google manual search variety
description: Distribution rule for the built-in Chrome Google search history generator
---

Manual Google searches must use natural phrases or questions containing exactly 2–5 words. One-word searches are not allowed.

**Why:** A history containing isolated single keywords is visibly artificial and does not resemble ordinary Google search behavior.

**How to apply:** Bucket candidates by exact word count from 2 through 5, choose among those buckets randomly, fall back only to another non-empty 2–5-word bucket, preserve unique-query selection within each cycle, and log the selected count.