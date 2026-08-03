---
name: Scroll personality first-turn guard
description: First-scroll behavior for randomized mobile Feed and Explore scrolling.
---

The backward scroll personality must be unavailable on the first Feed scroll and the first Explore advance. Later scrolls may use the randomized backward weight normally.

**Why:** A backward swipe before any forward movement has no prior content to revisit and can produce a meaningless or misleading first action.

**How to apply:** Pass the scroll iteration state into the personality roller and disable only the backward mode for iteration zero; do not remove backward scrolling from the entire session distribution.