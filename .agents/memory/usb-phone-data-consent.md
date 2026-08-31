---
name: USB phone-data consent
description: Android USB/MTP phone-data consent is required for mobile image uploads.
---

Android's “Allow access to phone data?” dialog must be accepted for Make a Post and Random Actions avatar uploads; it is not equivalent to USB debugging consent.

**Why:** Those upload flows transfer images into phone storage before Instagram selects them. Denying or ignoring the dialog blocks the upload path.

**How to apply:** Detect the exact live system-dialog title and tap its live Allow node. If it reappears repeatedly, investigate USB hub/cable re-enumeration separately; do not replace the required access with a deny action.