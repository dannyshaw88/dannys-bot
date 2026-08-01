---
name: Local image model downloader
description: Download transport and scope rules for the desktop local image-generation sidecar
---

Model downloads must use Hugging Face's conservative regular HTTP/LFS transport. Keep the image-generation registry limited to the two supported reference-image editors: Qwen Image Edit 2511 and LongCat Image Edit.

**Why:** The accelerated Xet/range-request path saturated the user's entire connection and made the modem unusable. Custom cache-byte progress and speed reporting added complexity without fixing the underlying transfer behavior.

**How to apply:** Do not install or enable `hf-xet`, `HF_XET_HIGH_PERFORMANCE`, or concurrent range settings. Do not reintroduce a filesystem-scanning download monitor; show an indeterminate loading state while `from_pretrained()` performs the download. Keep setup installation separate from model downloading.