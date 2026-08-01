---
name: Local image model downloader
description: Download transport and scope rules for the desktop local image-generation sidecar
---

Model weights must not depend on Hugging Face's throttled model transport. The image-generation registry uses smaller photorealistic Stable Diffusion checkpoints downloaded directly from Civitai, with resumable `.part` files and true local-file transfer progress.

**Why:** The large Qwen/LongCat Hugging Face downloads were unusable on the user's connection even after disabling Xet. Direct Civitai checkpoint downloads are substantially smaller and avoid the Hub model transport entirely.

**How to apply:** Keep model weights on direct Civitai URLs, resume only with a validated HTTP range response, and report progress from the checkpoint and `.part` files. Keep setup installation separate from model downloading; bundled config/tokenizer files are small offline runtime assets, not model downloads.