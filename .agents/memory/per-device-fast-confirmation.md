---
name: Per-device fast confirmation
description: Keep per-device actions responsive by checking every slow confirmation callsite.
---

Replace each per-device slow confirmation with the appropriate fast check individually; changing a shared helper does not update sibling callsites that inline their own confirmation.

**Why:** an unchanged slow confirmation can still consume the action window and make a fix appear ineffective even after one call path is optimized.

**How to apply:** search all callsites for the operation being changed, including inline checks, and verify each one uses the intended fast confirmation.