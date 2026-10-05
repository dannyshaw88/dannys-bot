---
name: Follow exact-target gate
description: Safety rule for Human Session Tool Instagram follow searches
---

The Human Session Tool follow flow must positively match the requested username
exactly in the current Instagram accessibility tree before tapping any result.
Avatar rings, first-result ordering, generic row containers, and DPAD navigation
are not sufficient identity evidence.

When a visible exact username is rejected, compare the same-time accessibility
dump with the screenshot and inspect recent Follow search-state/timing changes
before changing the matcher. A screenshot alone does not establish what
UIAutomator exposed or which node attributes caused rejection.

**Why:** Search screenshots and accessibility dumps can represent different
render times. Changing the exact-match gate based only on the screenshot risks
loosening the safety rule without identifying the regression.

**How to apply:** Preserve exact username matching and safe recovery. Capture
the accessibility tree at the rejection before changing the matcher; never
guess by row order or avatar.