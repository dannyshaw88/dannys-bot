---
name: Account-switch handoff safety
description: The post-row surface must be verified before any remaining automation tool runs.
---

Treat an account-row tap as an unknown handoff unless a fresh accessibility dump verifies Home, or verifies the already-active account sheet closed to Home after the single Back. Clear one detected post-switch popup for recovery and diagnostics, but never retry the account-row tap or dispatch tools from the ambiguous surface.

**Why:** Instagram can rebuild the feed asynchronously after a row tap and show a “Why you’re seeing this post” sheet during that transition. Continuing into Stories or another tool can act on the wrong surface and hide the real switch failure.

**How to apply:** Keep the low-level switch result false for empty, non-Home, or otherwise unverifiable post-tap states. Propagate that boolean to the cycle route and skip only the remaining shuffled dispatcher; preserve normal popup cleanup for verified switches.