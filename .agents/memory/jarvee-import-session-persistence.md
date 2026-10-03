---
name: Jarvee import session persistence
description: Jarvee account details remain available across Settings tab changes without storing sensitive source files in browser storage
---

The Settings Jarvee reader should retain parsed details for the lifetime of the mounted Settings session, but must not persist raw Jarvee files or extracted credentials/cookies to browser storage.

**Why:** Jarvee exports can contain passwords, cookies, proxy credentials, and 2FA data; session continuity solves tab-navigation loss without creating a second sensitive-data store.

**How to apply:** Keep the reader mounted and hide it when another Settings tab is active. If durable persistence is ever requested, design explicit encryption and deletion semantics first.

Jarvee imports must preserve the source embedded-browser UA on the imported profile. Restore it in the Jarvee import path after profile creation; do not weaken the shared server-selected UA policy for ordinary profile creation.

**Why:** Imported browser identity should match the export while standard profile creation continues to use its server-assigned UA.

**How to apply:** Keep source `userAgentWeb` separate from the Instagram API UA and restore only the embedded UA for Jarvee-imported profiles.