---
name: Mobile metrics account selector
description: Statistics metrics must remain selectable when device slots or normal profile rows are incomplete.
---

The Mobile Engine Metrics selector should treat configured slot usernames and normal profile records as separate account sources: group slot usernames by device when available, include unmatched slot-only accounts, and include all remaining non-template profiles.

**Why:** A disconnected or synthetic phone can have no current slot response even though profiles and persisted metrics exist, and a slot can exist without a matching profile row. Filtering only exact profile matches makes the selector appear empty and hides account metrics.

**How to apply:** Match usernames case-insensitively, use the selected account's username for mobile metric lookup, and render the mobile pie charts/cards from the username-keyed slot metrics even when no profile-specific stats endpoint is available.