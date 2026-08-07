---
name: TrustScore duration navigation save
description: TrustScore duration inputs must flush pending debounced writes when the settings view unmounts.
---

TrustScore duration changes are debounced for normal typing, but any pending value must be persisted during unmount/navigation as well.

**Why:** Leaving the TrustScore settings view before the debounce elapsed used to clear the timer and silently reset the duration on the next visit.

**How to apply:** Keep pending duration values in a ref, cancel the delayed timer during cleanup, and immediately send the latest value with a navigation-safe request.