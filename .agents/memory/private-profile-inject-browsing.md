---
name: Private profile Inject Browsing gate
description: Private Instagram profiles must not receive injected profile-grid browsing.
---

The live Instagram profile accessibility tree is authoritative for disabling Inject Browsing on private accounts. Match the visible “This account is private” notice, its follow-to-see subtitle, or the stable empty-profile notice resource ids before rolling browsing.

**Why:** Private profiles do not expose a public grid, so injected scrolling/actions are both ineffective and behaviorally wrong; HikerAPI privacy metadata may be stale or unavailable.

**How to apply:** Keep the private check independent from the optional “Skip Private” filter. A private candidate may still proceed through the normal Follow path when that filter is off, but pass no browsing params to either the before-follow or after-follow browsing branch.