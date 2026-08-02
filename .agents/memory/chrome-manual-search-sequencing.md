---
name: Chrome manual search sequencing
description: Constraints for optional Google search-history actions in the on-device Chrome app flow
---

Optional Chrome homepage actions should run after the existing feed/story activity and manual searches/result dwell, then close Chrome through the normal verified recents path. Use an explicit Chrome VIEW intent to reach Google. When Google Trending content is inside a WebView that UIAutomator cannot expose, detect the live repeated row separators from a current screenshot and confirm navigation after each tap; never infer toolbar or card coordinates from screen dimensions.

**Why:** Chrome’s toolbar can collapse after feed scrolling, inserting a search before the existing feed loop changes the page state assumed by that loop, and WebView-rendered Trending rows can appear as one opaque accessibility node. Raw `adb shell input text` also treats an unescaped phrase as multiple shell arguments, dropping everything after the first word.

**How to apply:** Keep homepage actions optional and failure-safe. Select ordinary queries from a varied pool, submit through the existing keyboard/input helpers with `%s` space escaping on the raw-input fallback, use screenshot evidence for opaque WebView rows, confirm the post-tap URL before counting success, return to the homepage between taps, and allow the normal Chrome close step to run if any stage cannot be verified.