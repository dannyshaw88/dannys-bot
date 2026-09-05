---
name: Story Like identity guard
description: Instagram story toolbar resource IDs can resolve to the adjacent comment control on some builds
---

Prefer a live semantic Like/Unlike label on the compact lower-toolbar node. If a build omits that label, `toolbar_like_button` may still be used only after checking that its coordinates do not overlap a live Comment node. When they overlap, a sole compact icon immediately to Comment's left may be used if its spacing is plausible; otherwise skip.

**Why:** A real device log recorded the supposed Like tap at the Comment bubble's coordinates even though the node resource ID was `toolbar_like_button`; trusting the ID caused the wrong control to open the comment composer.

**How to apply:** Parse the current UI tree and prefer exactly one enabled clickable-owner node labelled Like Story, Unlike Story, Like, or Unlike. For unlabeled builds, cross-check resource coordinates against Comment and use guarded row adjacency—not screen percentages.