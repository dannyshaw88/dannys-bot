---
name: SMS contact selection only
description: The Phone Apps SMS action selects a requested number of unselected Google Messages contacts and never sends.
---

The SMS function in Mobile Phone Apps is intentionally selection-only. It must tap only unselected contacts in the live Google Messages Add people picker, stop after the configured count, and never compose or send a message.

**Why:** The user requested contact selection only and asked to speed the process up without changing its flow.

**How to apply:** Operate only on the already-open New group MMS/Add people picker. Do not launch, wake, unlock, close, or lock the phone. Read row names from child text, skip selected rows, tap first, then advance 80 pixels between selections; stop at the exact count. Keep live confirmation after every tap and scroll, using short adaptive settle/recheck delays rather than removing checks.
