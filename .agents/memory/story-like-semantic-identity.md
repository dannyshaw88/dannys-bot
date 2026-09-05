---
name: Story Like semantic identity
description: Instagram story toolbar resource IDs can resolve to the adjacent comment control on some builds
---

The Story Like action must require a live semantic Like/Unlike label on the same compact lower-toolbar node. A resource ID such as `toolbar_like_button` is supporting evidence only, never sufficient by itself.

**Why:** A real device log recorded the supposed Like tap at the Comment bubble's coordinates even though the node resource ID was `toolbar_like_button`; trusting the ID caused the wrong control to open the comment composer.

**How to apply:** Parse the current UI tree, require exactly one enabled clickable-owner node labelled Like Story, Unlike Story, Like, or Unlike, and tap that node's centre. If no positive semantic match exists, skip Like rather than use a coordinate or ID-only fallback.