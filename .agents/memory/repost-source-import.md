---
name: Repost source import
description: Cross-slot Reel imports must preserve each account's independent processed history.
---

Global Settings → Import Reel appends one canonical Instagram Reel URL to every persisted account slot's Repost sources. It must not replace or modify any slot's `shareReelProcessedLinks` or unrelated automation settings.

Canonical matching ignores Instagram host aliases, query tracking values, URL fragments, and trailing slashes. This ensures an account that already processed a Reel still treats another copied form of the same URL as completed, while other accounts can process it independently.

**Why:** The user requested an easy way to share a Reel source across account slots because different accounts have different processed-Reel histories.

**How to apply:** Resolve each slot using its persisted slot ID, deduplicate source lists canonically, patch only `shareReelSources`, and use the same normalization for import, active-source display, and execution.
