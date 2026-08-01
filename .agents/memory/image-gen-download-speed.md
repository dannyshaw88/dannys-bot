---
name: Local model download progress
description: Durable rules for speed and progress reporting during local Hugging Face model downloads
---

The Hugging Face cache directory is not a monotonic transfer counter. Resumed or retried `.incomplete` files can be replaced while `from_pretrained()` is running, making a live sum of blob sizes move backwards. Track a per-load high-water mark for the user-facing counter, while keeping completion tied to finalized blobs and the loader's actual return. For large repositories, keep `hf_xet` installed and enable high-performance range downloads; disabling Xet forces a slow single-stream fallback.

**Why:** A 30 GB model's visible progress dropped several gigabytes during a real download because the observer counted a changing cache layout as if it were a stable transfer stream. A later desktop build also forced `HF_HUB_DISABLE_XET=1`, reducing model throughput to roughly 1 MB/s.

**How to apply:** Pin/upgrade the Hub client and install `hf-xet` during desktop setup, set `HF_XET_HIGH_PERFORMANCE=1` and a bounded concurrency value before importing Diffusers, log the active backend, and never let a filesystem snapshot overwrite a higher progress value from the same load.