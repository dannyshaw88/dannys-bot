---
name: Snapchat startup popups
description: Required handling for mutually exclusive notification and verify-email popups at Snapchat startup.
---

Before account or banner navigation, detect either Snapchat's Android notification prompt or its “Verify email account” popup; the user reports these do not appear together. For notifications, tap the live “Don't allow” control once. For Verify email, tap the screen center and swipe down once. Continue without a separate post-action confirmation. If either popup appears after the first startup scan, catch it during the initial account-surface wait.

**Why:** Both popups can block Snapchat startup and the first banner check. Android may omit the notification dialog title from UIAutomator, leaving only its explanatory copy and the paired denial/allow buttons.

**How to apply:** Match the full title when exposed, or the standard notification explanation together with its paired “Don't allow” and “Allow” controls when the title is absent. Match denial labels including “Deny all”, “Deny”, and “Don't allow”; prefer the live clickable button area. Use one center-tap/down-swipe for Verify email. Latch after one popup action and retry discovery only while the notification prompt is present but its button is not yet exposed.
