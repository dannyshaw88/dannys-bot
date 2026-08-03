---
name: Mobile Phone Apps toggle parity
description: Keep the Accounts-page Mobile Phone Apps switch synchronized with the tool panel scheduler
---

The Mobile Phone Apps switch on the main Accounts page must invoke the mounted tool panel’s Step 1 enable handler, not post only `{ enabled }` directly.

**Why:** The Step 1 handler updates the full settings state, starts an enabled cycle immediately, cancels timers and queued work when disabled, and preserves scheduler state. A card-only API update changes persistence but leaves the already-mounted scheduler running with stale state.

**How to apply:** Keep the panel mounted while the Accounts page is visible, expose its enable handler through a scoped imperative ref, and route both switches through that handler. If the panel is still loading, queue the requested state and apply it after the settings load completes.