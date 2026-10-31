---
name: Uncapped quantity maxima
description: Product rule for upper bounds on configurable count and amount fields.
---

Count and amount settings with Min/Max values must not have arbitrary upper bounds. Keep intrinsic limits such as percentage ranges, physical measurements, text lengths, and genuine platform constraints.

Numeric settings fields in the mobile automation UI must comfortably show three digits, even when the configured maximum is larger. Use a 3ch content width with horizontal padding outside it, not a 3ch border-box.

**Why:** the user asked that maxima remain uncapped while the fields stay compact, and objected when their width was increased without permission. A 3ch border-box left too little room for three digits, and an exact 3ch content area still looked cramped.

**How to apply:** when changing a quantity range, check the input's `max`, any onChange clamp, API validation, persistence, and runtime count normalization together. Use content-box sizing so three digits fit, with small horizontal padding outside the 3ch content area; do not widen it further to fit larger values. Do not mistake an unbounded configured maximum for permission to remove meaningful domain constraints.
