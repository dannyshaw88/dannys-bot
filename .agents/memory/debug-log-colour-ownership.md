---
name: Debug log colour ownership
description: Persistent colour rules for the live Debugging Log and generated screenshot composites
---

The active tool owns the colour of its entire log block. A nested action or status word must not recolour a line: for example, a Reel opened from View Explore remains Explore green. System text is white. Account-switch blocks are gold, with only the destination handle highlighted pink.

**Why:** Content-based one-line classifiers made the same automation flow change colour mid-run and caused the live log and debug screenshot to disagree, making device debugging harder to follow.

**How to apply:** Update the frontend Debugging Log and server-side screenshot renderer together whenever tool headers or tool colours change. Preserve context until the next tool header or cycle boundary.