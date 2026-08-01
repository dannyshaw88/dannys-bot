---
name: Account switcher already-active dismissal
description: The Instagram account switcher can leave its sheet open after tapping the already-active row.
---

After tapping a matching account row, verify that Instagram has returned to the feed using positive Home/feed navigation markers (`content-desc="Home..."` or the known feed-tab resource IDs). If the accessibility dump is valid and those markers are absent, press `KEYCODE_BACK` to dismiss the still-open switcher. Never use the username alone as the “still open” signal because the home feed profile-tab description also contains it, and never press Back after a failed/empty dump.

**Why:** The active account may appear in the switcher XML without a tappable text/content-desc row, and behavior differs across Instagram builds. A blind Back after the sheet already closed exits toward the home screen and can show Android’s “Tap again to exit” toast.

**How to apply:** Keep this logic in the live mobile `switchToInstagramAccount` path. Prefer accessibility-tree state over coordinates, and use a bounded retry for transient post-tap dump failures.