---
name: Snapchat View Snaps exit
description: Advance with an exact right-edge tap and leave the viewer with one Android Back press.
---

View Snaps advances to the next Snap with an exact (no-jitter) tap at `(screenWidth - 50, screenHeight / 2)`, never on the lower reaction controls. At completion, send Android Back exactly once; do not substitute a Camera-tab tap for this exit.

**Why:** The user explicitly requires the right-edge midpoint to advance and Android Back once at the end; taps near the lower reply/reaction row can accidentally send a reaction.

**How to apply:** Use the device's live screen dimensions and disable tap jitter for each next-Snap input. Do not use viewer-node confirmation checks as a reason to suppress the requested next tap. After the configured viewing loop, unless the cycle is aborted, send one KEYCODE_BACK. Later tool dispatch may navigate from Stories to Camera as a separate step.
