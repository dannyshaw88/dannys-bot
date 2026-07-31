---
name: Local image model loading phases
description: Progress reporting rule for the Electron local image-generation sidecar
---

The local image-generation loader has separate phases: downloading, assembling the diffusers pipeline, and moving it into CPU/GPU memory. A cache-size estimate can reach 100% before the model is usable, so the UI must not equate 100% with ready.

**Why:** The Qwen Image Edit download showed 100% for an extended period while the background pipeline load continued, making the desktop app appear frozen and leaving no way to distinguish downloading from model initialization.

**How to apply:** Keep `status`, `loading_phase`, elapsed loading time, and download progress separate. Exclude Hugging Face `.incomplete` blobs from completed bytes, show an explicit post-download loading message, and only switch to the generation UI after the sidecar reports `ready`.