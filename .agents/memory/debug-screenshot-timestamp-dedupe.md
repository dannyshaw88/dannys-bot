---
name: Debug screenshot timestamp dedupe
description: Debug composites should capture one frame per elapsed log timestamp, not one frame per emitted log line
---

The debug composite trigger is keyed by the elapsed timestamp generated at the start of each automation log line. Additional detail lines sharing that timestamp update the rolling log buffer but must not queue more ADB or image-processing work.

**Why:** A single automation timestamp can emit many status lines, and capturing each one created unnecessary screenshot load and contributed to native processing pressure.

**How to apply:** Clear the per-device timestamp set at the start of each new account cycle, then admit only the first log line for each elapsed timestamp into the screenshot queue.