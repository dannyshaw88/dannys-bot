---
name: View Feed fresh-node action validation
description: Accessibility-node freshness and post-action confirmation rules for View Feed.
---

View Feed action coordinates are valid only for the live accessibility dump immediately preceding that action. Reusing an earlier row scan can target a recycled post or a node that moved during settling. Each action must resolve its own node from the current post association and fail closed when identity is ambiguous. Semantic action IDs may be non-clickable children; validate their clickable parent from XML ancestry or the smallest containing clickable bounds. Hashtag links additionally need a visible, compact caption node (text or content-desc) and a confirmed hashtag surface after the tap; retry only while that same live link remains.

**Why:** A Redmi feed dump could expose multiple/recycled Like and action nodes; the old flow logged Save as successful merely because Instagram stayed open, and audio/author scans selected the first matching node rather than the current post. The device inspector also showed action IDs such as `row_feed_button_like` on non-clickable children while sibling/parent ViewGroups owned the tap. Hashtag dumps can likewise retain off-screen caption nodes, while the page transition may take longer than one accessibility dump.

**How to apply:** Keep the strict scan local to View Feed. Use node bounds for taps, re-scan before Like/share/DM/Save/audio/author actions, and require a meaningful post-action accessibility state (for example, “Remove from saved” or a confirmed destination page) before incrementing counters. Do not count a hashtag visit from an input dispatch alone.