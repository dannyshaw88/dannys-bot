---
name: TrustScore ownership parity
description: Frontend and API TrustScore slot-owned field sets must stay synchronized for every physical-slot setting.
---

The frontend and API each maintain TrustScore ownership rules. Any new physical account-slot setting must be added to both sets, or the UI can expose a different editability/locking state than the server actually enforces.

**Why:** A Post a Story link setting was correctly protected by the API but initially omitted from the frontend ownership set, creating a silent TrustScore editor mismatch.

**How to apply:** When adding or changing a slot-owned field, update and audit both the shared frontend ownership constants and the server ownership constants, then verify template locking, assigned-slot editing, and Copy Settings filtering together.