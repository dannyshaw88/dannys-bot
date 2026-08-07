---
name: Mobile Phone Apps debugging log parity
description: Keep Mobile Phone Apps activity visible in the same Debugging Log and Action Log as regular tools
---

Every Mobile Phone Apps cycle must send its lifecycle and app activity through the existing device log callback. Include enable/disable, scheduling, cycle start, collision/abort, each app’s activation decision and result, lock, and failure messages.

**Why:** The Debugging Log is the user’s single source of truth for device automation. Logging only server-returned app steps made Mobile Phone Apps appear unlike regular tools and hid scheduling, skipped apps, and cycle outcomes.

**How to apply:** Prefix ordinary lines with `Phone Apps` and use the established `Cycle complete`, `Cycle failed`, and `Cycle aborted` markers so the existing Action Log classifier includes Mobile Phone Apps cycles automatically.