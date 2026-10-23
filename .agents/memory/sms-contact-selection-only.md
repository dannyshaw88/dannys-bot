---
name: SMS contact selection only
description: The Phone Apps SMS action selects a requested number of unselected Google Messages contacts and never sends.
---

The SMS function in Mobile Phone Apps is intentionally selection-only. It must tap only unselected contacts in the live Google Messages Add people picker, stop after the configured count, and never compose or send a message.

**Why:** The user requested a contact-selection operation, not SMS messaging.

**How to apply:** Preserve the strict Add people surface gate, read each row name from its child text, distinguish already-selected rows, tap first, then advance by about 50 pixels between selections. Stop at the exact count; never start with a large swipe.
