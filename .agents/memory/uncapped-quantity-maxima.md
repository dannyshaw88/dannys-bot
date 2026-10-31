---
name: Uncapped quantity maxima
description: Product rule for upper bounds on configurable count and amount fields.
---

Count and amount settings with Min/Max values must not have arbitrary upper bounds. Keep intrinsic limits such as percentage ranges, physical measurements, text lengths, and genuine platform constraints.

**Why:** the user asked that there be no limit to any Max field after finding an arbitrary cap on Snapchat Accept Friends.

**How to apply:** when changing a quantity range, check the input's `max`, any onChange clamp, API validation, persistence, and runtime count normalization together. Do not mistake an unbounded configured maximum for permission to remove meaningful domain constraints.
