---
name: HST context dependency closure
description: Shared mobile route context must retain every helper and state object consumed by extracted HST operations
---

When extracting HST implementations, build a complete dependency closure for the shared operation context before removing route-local declarations. Runtime bundling can succeed while context construction still throws `ReferenceError` for helpers or per-tool state maps.

**Why:** The refactor removed several route-local gesture, timing, posting-history, recipient-cache, and prompt-dismissal bindings that extracted operations still expected; the packaged API then exited during startup.

**How to apply:** Before packaging, search every property supplied to the HST context, verify its declaration appears earlier in the same scope, run the production build, and start the API workflow rather than relying on typecheck alone.