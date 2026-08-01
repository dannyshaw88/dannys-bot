---
name: Chrome manual search sequencing
description: Constraints for optional Google search-history actions in the on-device Chrome app flow
---

Optional Chrome homepage actions should run after the existing feed/story activity and manual searches/result dwell, then close Chrome through the normal verified recents path. Use an explicit Chrome VIEW intent to reach Google, scroll before looking for lower-page story cards, and tap only a currently observed accessibility candidate with an explicit story/news/trending signal; never infer toolbar or card coordinates from screen dimensions.

**Why:** Chrome’s toolbar can collapse after feed scrolling, and inserting a search before the existing feed loop changes the page state assumed by that loop. Accessibility labels and resource IDs also vary by Chrome build.

**How to apply:** Keep homepage actions optional and failure-safe. Select ordinary queries from a varied pool, submit through the existing keyboard/input helpers, return to the homepage when possible, and allow the normal Chrome close step to run even if Google, its field, or a story card cannot be found.