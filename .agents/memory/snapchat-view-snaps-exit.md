---
name: Snapchat View Snaps exit
description: Advance with an exact right-edge tap and leave the viewer with one Android Back press.
---

Before opening a Friends bubble, inspect its overlapping accessibility nodes and skip `avatar_story_replay` / Watch Again markers. Exclude add-person markers from accessibility when present; Snapchat can also draw the purple add-person badge without exposing it in the tree, so verify candidate circles against one live screenshot and skip the filled purple pill with its white person-add glyph. A purple Story ring by itself is not proof of a viewable Story. If the screenshot is unavailable, skip View Snaps safely; when every bubble is marked, return normally so the next tool can run. View Snaps advances to the next Snap with an exact (no-jitter) tap at `(screenWidth - 50, screenHeight / 2)`, never on the lower reaction controls. At completion, send Android Back exactly once; do not substitute a Camera-tab tap for this exit.

**Why:** Snapchat exposes already-viewed Story bubbles as accessibility nodes such as `avatar_story_replay`, but its suggested-friend add badge may be visible only in the screenshot. The user explicitly requires the right-edge midpoint to advance and Android Back once at the end; taps near the lower reply/reaction row can accidentally send a reaction.

**How to apply:** Pair replay/add-person nodes with their bubble by overlapping bounds; target only unmarked `friend_story_circle_thumbnail` nodes. Use the device's live screen dimensions and disable tap jitter for each next-Snap input. Do not use viewer-node confirmation checks as a reason to suppress the requested next tap. After the configured viewing loop, unless the cycle is aborted, send one KEYCODE_BACK. Later tool dispatch may navigate from Stories to Camera as a separate step.
