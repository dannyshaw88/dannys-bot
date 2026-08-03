---
name: Mobile Bio Spin slot ownership
description: Random Actions Bio Spin text belongs to the Phone Farm Human Session Tool slot, not Trust Score templates.
---

The mobile Human Session Tool's Random Actions Bio Spin text is account-slot-owned. It must remain editable on a Phone Farm slot even when that slot inherits a Trust Score, and it is allowed through HST Copy Settings to other slots.

**Why:** Bio text is account-specific and should not be pre-determined by a Trust Score template; templates only define shared behavior.

**How to apply:** Keep `updateBioText` in the mobile slot-owned and account-specific copy allow-lists. Keep it locked/greyed in Trust Score template editing and template copy, while allowing the slot HST input and Spin preview action.