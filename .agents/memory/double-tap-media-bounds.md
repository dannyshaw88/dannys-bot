---
name: Double-tap media bounds
description: Safety rule for automated double-tap likes across feed-like viewers
---

Automated double-taps may only target a randomized central point inside confirmed media bounds. If bounds are unavailable, use the confirmed Like control instead; never derive a Y position from the Like/action row.

**Why:** A missing media target previously fell back to a lower action-row position, where a double-tap could open a contact/message control instead of liking the media.

**How to apply:** Pass confirmed media bounds through every automated double-tap path and keep the low-level tap jitter inside those bounds. Manual operator double-taps without media metadata remain separate.