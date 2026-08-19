---
name: Instagram Save button icon detector
description: Feed and Reel Save actions use the attached bookmark image, never accessibility labels or structural guesses
---

Instagram Save/bookmark detection must use the live screenshot and the attached bookmark crop with scale-aware, normalized, polarity-invariant matching.

**Why:** Save is optional and may be absent on ads, embedded videos, or Reel surfaces; accessibility nodes and structural column order can falsely identify another control as Save.

**How to apply:** Return null and skip Save when the ribbon is not visually confirmed. Keep Comment/Repost/Send detection independent, and package the bookmark reference with Electron.