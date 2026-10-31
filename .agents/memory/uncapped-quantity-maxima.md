---
name: Uncapped quantity maxima
description: Product rule for upper bounds on configurable count and amount fields.
---

Count and amount settings with Min/Max values must not have arbitrary upper bounds. Keep intrinsic limits such as percentage ranges, physical measurements, text lengths, and genuine platform constraints.

Numeric settings fields in the mobile automation UI stay fixed at 3 characters wide, even when the configured maximum is larger.

**Why:** the user asked that maxima remain uncapped while the fields stay compact, and objected when their width was increased without permission.

**How to apply:** when changing a quantity range, check the input's `max`, any onChange clamp, API validation, persistence, and runtime count normalization together. Keep the input width at 3 characters; do not widen it to fit a larger value. Do not mistake an unbounded configured maximum for permission to remove meaningful domain constraints.
