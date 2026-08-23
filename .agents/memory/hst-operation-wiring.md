---
name: HST operation wiring
description: Extracted Human Session Tool operations must expose both the operation import and its shared context at every direct route call site.
---

When an HST operation is extracted from the mobile route, audit direct route branches separately from wrapper functions: import every directly called helper and pass the operation context explicitly.

**Why:** The shared Stories loop was wired correctly, but the direct story-picker branch retained an old unbound call and only failed on a real cycle after several minutes of successful work.

**How to apply:** Search for every exported operation symbol across `routes/mobile.ts`; distinguish wrapper calls that inject context from direct calls that must receive `hstOperationContext` themselves.