---
name: Chrome manual search sequencing
description: Constraints for optional Google search-history actions in the on-device Chrome app flow
---

Optional Chrome homepage actions should run after the existing feed/story activity and manual searches/result dwell, then close Chrome through the normal verified recents path. Use an explicit Chrome VIEW intent to reach Google. When Chrome's UIAutomator dump exposes only the outer Web View, use a current screenshot's visual structure to locate the requested rows and verify navigation after tapping; never infer toolbar or card coordinates from screen dimensions.

**Why:** Chrome’s toolbar can collapse after feed scrolling, and inserting a search before the existing feed loop changes the page state assumed by that loop. Accessibility labels and resource IDs vary by Chrome build, and WebView-rendered Google homepage content may not appear as individual UIAutomator nodes at all.

**How to apply:** Keep homepage actions optional and failure-safe. Select ordinary queries from a varied pool, submit through the existing keyboard/input helpers, return to the homepage when possible, and allow the normal Chrome close step to run even if Google, its field, or a requested row cannot be found. Count a tap only after the Chrome URL changes away from the homepage.