---
name: Snapchat startup popups
description: Required handling for mutually exclusive notification and verify-email popups at Snapchat startup.
---

Before account or banner navigation, detect either Snapchat's Android notification prompt or its “Verify email account” popup; the user reports these do not appear together. For notifications, tap the live “Don't allow” control once. For Verify email, tap the screen center and swipe down once. Continue without a separate post-action confirmation. If either popup appears after the first startup scan, catch it during the initial account-surface wait.

**Why:** Both popups can block Snapchat startup and the first banner check. The Android permission title is “Snapchat is requesting permission to send you notifications,” while the denial label can vary by device.

**How to apply:** Match the notification prompt across reasonable Android wording variants and denial labels including “Deny all”, “Deny”, and “Don't allow”; prefer the live clickable button area. Use one center-tap/down-swipe for Verify email. Latch after one popup action and retry discovery only while the notification prompt is present but its button is not yet exposed.
