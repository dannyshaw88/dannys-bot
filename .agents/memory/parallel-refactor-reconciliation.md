---
name: Parallel refactor reconciliation
description: A process rule for large delegated refactors where workers may edit from stale snapshots
---

After delegated refactor work, inspect the current workspace and reconcile imports, call sites, duplicate implementations, and build output before accepting the worker’s completion summary.

**Why:** Large route files and sequential workers can leave valid new modules beside stale inline copies or overwrite earlier wiring while each individual worker reports success.

**How to apply:** Run current-state searches for both module definitions and dispatch calls, then build the affected packages and remove unreachable duplicates before the final runtime check.