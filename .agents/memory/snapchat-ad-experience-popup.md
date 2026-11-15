---
name: Snapchat ad-experience popup
description: Dismiss Snapchat's ad-choice dialog by selecting Smaller In-Feed Ads.
---

When Snapchat shows “Choose Your Ad Experience,” select the live “Smaller In-Feed Ads” option. Detect it during existing Snapchat accessibility-tree reads rather than adding periodic screen checks; tap the exact labeled node or its smallest clickable parent.

**Why:** The popup blocks Snapchat flows, especially Reply to Unread Chats, and the user explicitly chose Smaller In-Feed Ads to clear it.

**How to apply:** Require the dialog title and both ad-choice labels before acting. Re-read under the per-device input transaction, select only Smaller In-Feed Ads, and return the refreshed state to the active flow.
