---
name: Ghost Browser UA handoff
description: Ghost Browser signup must pass the embedded Chromium UA, not Instagram's compact API device UA
---

The Ghost Browser's Electron window must receive `userAgentEmbedded` / the full Mozilla Android-or-desktop browser string. The compact Instagram API UA is only for API requests and must never be used to open Chromium.

**Why:** The normal Create Account path once passed the API UA while the standalone Open path passed the embedded UA, allowing the Electron window to fall back to or expose the Windows host identity.

**How to apply:** Keep both Ghost open paths on the same effective embedded UA value, retain a defensive mobile fallback in Electron for a missing Ghost UA, and reapply the UA when an existing negative Ghost slot is reused.