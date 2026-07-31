---
name: Local model download progress
description: Durable rules for speed and progress reporting during local Hugging Face model downloads
---

The Hugging Face cache directory is not a monotonic transfer counter. Resumed or retried `.incomplete` files can be replaced while `from_pretrained()` is running, making a live sum of blob sizes move backwards. Track a per-load high-water mark for the user-facing counter, while keeping completion tied to finalized blobs and the loader's actual return. Keep `huggingface_hub` below 1.0 and disable Xet by default for this desktop's faster legacy HTTP/LFS path.

**Why:** A 30 GB model's visible progress dropped several gigabytes during a real download because the observer counted a changing cache layout as if it were a stable transfer stream.

**How to apply:** Pin/upgrade the Hub client during desktop setup, set `HF_HUB_DISABLE_XET=1` before importing Diffusers, log the active backend, and never let a filesystem snapshot overwrite a higher progress value from the same load.