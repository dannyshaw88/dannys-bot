---
name: Device removal state boundary
description: Removing a farm device must clear all account-owned state before that serial can receive replacement accounts.
---

Farm-device removal is an account-boundary operation: clear account slots, HST automation, TrustScore assignments/timers, and account-scoped histories before allowing the serial to be reused.

**Why:** Stable slot IDs correctly preserve state across ordinary slot edits, but a full device removal followed by replacement accounts must not preserve the old device's account state.

**How to apply:** Keep cleanup at the server-facing removal boundary, not only in the UI, so every removal path has identical behavior.