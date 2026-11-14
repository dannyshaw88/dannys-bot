---
name: Snapchat View Snaps exit
description: Advance with an exact right-edge tap and leave the viewer with one Android Back press.
---

Before opening a Friends bubble, inspect its overlapping accessibility nodes: skip `avatar_story_replay` / Watch Again markers and add-person markers, including a plus node paired with a person/user/friend node. Do not infer either state from screenshot pixels; when every bubble is marked, skip only View Snaps so the next tool can run. View Snaps advances to the next Snap with an exact (no-jitter) tap at `(screenWidth - 50, screenHeight / 2)`, never on the lower reaction controls. At completion, send Android Back exactly once; do not substitute a Camera-tab tap for this exit.

**Why:** Snapchat exposes already-viewed Story bubbles as accessibility nodes such as `avatar_story_replay`; screenshot guessing caused the tool to tap non-viewable bubbles. The user explicitly requires the right-edge midpoint to advance and Android Back once at the end; taps near the lower reply/reaction row can accidentally send a reaction.

**How to apply:** Pair replay/add-person nodes with their bubble by overlapping bounds; target only unmarked `friend_story_circle_thumbnail` nodes. Use the device's live screen dimensions and disable tap jitter for each next-Snap input. Do not use viewer-node confirmation checks as a reason to suppress the requested next tap. After the configured viewing loop, unless the cycle is aborted, send one KEYCODE_BACK. Later tool dispatch may navigate from Stories to Camera as a separate step.
