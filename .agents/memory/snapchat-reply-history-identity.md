---
name: Snapchat reply-history identity and retention
description: Preserve correct contact identity and user-controlled retention for local Snapchat reply logs.
---

Snapchat reply history must be associated with the persisted account-slot ID and the verified username shown on the contact profile; display names are not unique identifiers. Keep logs until the user clears them, clear only the selected Snapchat slot, and never send another reply after that slot's Boundlus link has been sent to the contact. Detect the Boundlus domain generically, not one fixed profile handle, because slots may use different links.

**Why:** the user said display names can collide, chose to retain conversation logs until manually cleared, specified stopping replies after the link, and wants each slot to be able to use its own Boundlus link.

**How to apply:** when changing Snapchat reply automation or its history UI, capture the username from the profile screen, never merge contacts by display name alone, and use stored link-sent state as a code-level gate (not a prompt-only instruction).
