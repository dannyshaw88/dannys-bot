---
name: Instagram Save button icon detector
description: Feed and Reel Save actions use the attached bookmark image, never accessibility labels or structural guesses
---

Instagram Save/bookmark detection must use the live screenshot and the attached bookmark crop with scale-aware, normalized, polarity-invariant matching.

**Why:** Save is optional and may be absent on ads, embedded videos, or Reel surfaces; accessibility nodes and structural column order can falsely identify another control as Save.

**How to apply:** Return null and skip Save when the ribbon is not visually confirmed. Keep Comment/Repost/Send detection independent, and package the bookmark reference with Electron.

When a first-save collection sheet appears, dismiss it by deriving the live sheet top from the current accessibility bounds and tapping the scrim above it with a device-relative safety gap. Never reuse a fixed top-of-screen percentage.

**Why:** The collection sheet's height and the amount of scrim above it vary by device; a fixed tap can land inside the sheet and leave the ribbon visible.

**How to apply:** Require a collection marker plus bounded node geometry, choose a random point above the measured top, and use Back as the fail-closed fallback when no safe scrim can be proven.