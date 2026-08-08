---
name: Keyboard calibration layer navigation
description: Calibrated keyboard maps must capture layer controls and switch through adjacent Android keyboard layers in order.
---

The calibrated typing path must treat ABC, `?123`, and extended-symbol screens as separate layers. It must use the saved real-tap coordinates for the transition keys and never jump directly from ABC to extended symbols.

**Why:** Android keyboards render punctuation and controls on different screens; a coordinate saved for one layer is not valid after a layer transition, and opening emoji is a terminal UI state for the calibration walk.

**How to apply:** When changing the calibration key list or calibrated typing engine, keep the layer buttons in the map, return to ABC before capturing the emoji opener, and verify uppercase, punctuation, digits, and extended symbols each select the correct layer. On Gboard, returning from extended symbols requires two ABC taps: extended symbols → ?123 → letters.