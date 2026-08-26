---
name: View Feed visual scan timing
description: Non-obvious performance and data-reuse constraints for the View Feed visual action-bar scan.
---

View Feed must not dump the same UI hierarchy twice for one action-bar decision. Its Like anchor remains screenshot-based, while the complete live XML is reused only to constrain optional row/media validation.

**Why:** UIAutomator dumps can take several seconds and may retry on truncation; the prior duplicate dump compounded that delay. Full-screen multi-scale pixel correlation also monopolized the API process.

**How to apply:** Pass a complete existing dump into the feed-icon helper when available, and keep visual matching coarse-to-fine with explicit timing diagnostics. If the visual reference is absent, undecodable, weak, or outside a confirmed region, skip the action.