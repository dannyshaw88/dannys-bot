---
name: Uncapped quantity maxima
description: Product rule for upper bounds on configurable count and amount fields.
---

Count and amount settings with Min/Max values must not have arbitrary upper bounds. Keep intrinsic limits such as percentage ranges, physical measurements, text lengths, and genuine platform constraints.

Numeric settings fields in the mobile automation UI must fit three digits in the input area, even when the configured maximum is larger. Treat 3ch as the content width, not the border-box width.

**Why:** the user asked that maxima remain uncapped while the fields stay compact, and objected when their width was increased without permission. A 3ch border-box left too little room for three digits.

**How to apply:** when changing a quantity range, check the input's `max`, any onChange clamp, API validation, persistence, and runtime count normalization together. Keep the input content area 3ch wide and add border/padding outside that area; do not widen the editable area to fit larger values. Do not mistake an unbounded configured maximum for permission to remove meaningful domain constraints.
