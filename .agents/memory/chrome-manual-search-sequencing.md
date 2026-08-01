---
name: Chrome manual search sequencing
description: Constraints for optional Google search-history actions in the on-device Chrome app flow
---

The optional Chrome search-history action should run after the existing feed/story activity, then close Chrome through the normal verified recents path. Use an explicit Chrome VIEW intent to reach Google and only type into a currently observed Android `EditText` accessibility node; never infer toolbar or search coordinates from screen dimensions.

**Why:** Chrome’s toolbar can collapse after feed scrolling, and inserting a search before the existing feed loop changes the page state assumed by that loop. Accessibility labels and resource IDs also vary by Chrome build.

**How to apply:** Keep the search optional and failure-safe. Select ordinary queries from a varied pool, submit through the existing keyboard/input helpers, return to the homepage when possible, and allow the normal Chrome close step to run even if Google or its field cannot be found.