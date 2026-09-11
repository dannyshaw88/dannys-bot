---
name: Account-switch handoff safety
description: The post-row surface must be verified before any remaining automation tool runs.
---

Verify a live rendered Instagram navigation/profile surface before any calibrated account-switch gesture, and treat an account-row tap as an unknown handoff unless a fresh accessibility dump verifies Home, or verifies the already-active account sheet closed to Home after the single Back. Clear one detected post-switch popup for recovery and diagnostics, but never retry the account-row tap or dispatch tools from the ambiguous surface.

**Why:** Instagram can rebuild the feed asynchronously before or after account switching, briefly exposing a blank white activity. It can also show a “Why you’re seeing this post” sheet during the transition. Calibrated taps during either state can land outside the intended UI and hide the real switch failure.

**How to apply:** Gate the Profile-tab/header/sheet gestures with live accessibility markers and reject target coordinates outside a detected sheet. Keep the low-level switch result false for empty, non-Home, or otherwise unverifiable post-tap states. Propagate that boolean to the cycle route and skip only the remaining shuffled dispatcher; preserve normal popup cleanup for verified switches.