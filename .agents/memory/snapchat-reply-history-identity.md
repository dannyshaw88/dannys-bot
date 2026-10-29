---
name: Snapchat reply-history identity and retention
description: Preserve correct contact identity and user-controlled retention for local Snapchat reply logs.
---

Snapchat reply history must be associated with the persisted account-slot ID and the verified username shown on the contact profile; display names are not unique identifiers. Keep logs until the user clears them, and clear only the selected Snapchat slot.

**Why:** the user said display names can collide and chose to retain conversation logs until manually cleared.

**How to apply:** when changing Snapchat reply automation or its history UI, capture the username from the profile screen and never merge contacts by display name alone.
