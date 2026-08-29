---
name: Zero-weight swipe modes
description: Explicit swipe personality weights control eligibility and zero means disabled.
---

An explicitly saved swipe mode weight range of 0–0 must override the default weight and make that mode ineligible for selection.

**Why:** Treating zero as “not configured” silently re-enables disabled gestures, making the UI contradict runtime behavior.

**How to apply:** Check whether an override exists, not whether its numeric values are positive; let the weighted picker receive the configured zero.