---
name: HST operation extraction
description: Safe boundaries for decomposing the Human Session Tool without changing mobile automation behavior
---

Independent HST operations can be extracted behind explicit dependency contexts first; the cycle dispatcher and tightly coupled Feed, Stories, Reels, Follow, Post, DM, and lifecycle flows should remain thinly migrated only after their shared device and timing dependencies are isolated.

**Why:** The mobile automation code has safety-sensitive detector, timing, slot-identity, and lifecycle interactions; a broad mechanical split risks changing behavior while appearing structurally cleaner.

**How to apply:** Prefer one operation module per independent tool, inject Android/timing/logging services, build the API package after each group, and verify the web preview after frontend section moves.