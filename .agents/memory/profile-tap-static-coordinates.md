---
name: Profile tap static coordinates
description: Profile-tab navigation must bypass generic automated tap jitter after live accessibility resolution.
---

Once Instagram's Profile tab is resolved from live bounds, dispatch that navigation tap with fixed coordinates; generic bot taps may add small random offsets for humanization.

**Why:** The generic tap helper's intentional pixel jitter caused the Profile control to appear or be hit slightly to the right after selection.

**How to apply:** Use the explicit fixed tap source only for Profile-tab navigation; leave ordinary content taps on the normal bot jitter path.