---
name: Repost source import
description: Cross-slot Reel imports must preserve each account's independent processed history.
---

Global Settings → Import Reel accepts any valid HTTP(S) source URL, without a host or path whitelist, and appends it to every persisted account slot's Repost sources. It must not replace or modify any slot's `shareReelProcessedLinks` or unrelated automation settings.

For Instagram URLs, canonical matching ignores host aliases, query tracking values, URL fragments, and trailing slashes. Other hosts retain their query string and have URL fragments removed.

**Why:** The user explicitly asked that imports accept any link they enter; Instagram profile-scoped Reel paths such as `/username/reel/<shortcode>/` are valid and must not be rejected by a fixed path whitelist.

**How to apply:** Resolve each slot using its persisted slot ID, deduplicate source lists canonically, patch only `shareReelSources`, and use the same normalization for import, active-source display, and execution. Repost execution still needs to verify the live Instagram Reel viewer before acting.
