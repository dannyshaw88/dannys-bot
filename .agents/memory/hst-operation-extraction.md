---
name: HST operation extraction
description: Safe boundaries for decomposing the Human Session Tool without changing mobile automation behavior
---

Each tool, setting, and navigation should live in its own isolated code file, with shared dispatchers kept thin and connected through explicit interfaces. Independent HST operations can be extracted first; tightly coupled Feed, Stories, Reels, Follow, Post, DM, and lifecycle flows need their shared device and timing dependencies isolated before migration.

**Why:** The user requires file-level isolation so changes to one tool, setting, or navigation do not affect sibling behavior.

**How to apply:** Put each new or revised tool, setting, and navigation in a focused module; inject Android/timing/logging services at boundaries, keep shared dispatchers thin, build the API package, and verify the web preview after frontend moves.