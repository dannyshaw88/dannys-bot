---
name: Account switch method rollout
description: The alternate Profile-tab long-press account switch is an internal hardcoded experiment, not a Human Session Tool setting.
---

Account switching must randomly choose between the existing default flow and the Profile-tab long-press flow using a hardcoded internal probability. Do not expose, persist, or send that probability as automation settings.

**Why:** The requested behavior is implementation-level variation between two switch methods, not user-configurable Human Session Tool behavior.

**How to apply:** Keep the probability constant next to the account-switch dispatch and leave both switch implementations available; remove any UI, schema, defaults, or payload field for it.