---
name: Local image model downloader
description: Download transport and scope rules for the desktop local image-generation sidecar
---

Model downloads must use Hugging Face's conservative regular HTTP/LFS transport. Keep the image-generation registry limited to the two supported reference-image editors: Qwen Image Edit 2511 and LongCat Image Edit. The UI should expose true cache-backed transfer progress and speed while preserving that conservative transport.

**Why:** The accelerated Xet/range-request path saturated the user's entire connection and made the modem unusable. The user still needs honest visibility into the conservative transfer, so progress must observe the live Hugging Face cache rather than re-enabling aggressive transport.

**How to apply:** Do not install or enable `hf-xet`, `HF_XET_HIGH_PERFORMANCE`, or concurrent range settings. It is safe to scan the model cache for `.incomplete` and completed blob sizes to report bytes, speed, percentage, and ETA; do not use that monitor to alter download concurrency or transport. Keep setup installation separate from model downloading.