---
name: Snapchat notification permission prompt
description: Required handling and verification boundary for Android's Snapchat notification prompt.
---

Detect Snapchat's Android notification prompt before account or banner navigation, then tap its live “Don't allow” control once and continue the normal flow. Do not add a separate check to confirm the prompt disappeared after the tap. If the prompt can appear after the first startup scan, catch it during the initial account-surface wait, before any account or banner action.

**Why:** The user explicitly requested direct dismissal without a separate post-tap confirmation; the prompt had intermittently appeared before the first banner check.

**How to apply:** Match the notification prompt across reasonable Android wording variants, prefer the actual clickable button area, and latch after one dispatched tap. Retry discovery only while the prompt is present but the button is not yet exposed.
