---
name: Local model download progress
description: Durable rules for speed and progress reporting during local Hugging Face model downloads
---

The Hugging Face cache directory is not a monotonic transfer counter. Resumed or retried `.incomplete` files can be replaced while `from_pretrained()` is running, making a live sum of blob sizes move backwards. Track a per-load high-water mark for the user-facing counter, while keeping completion tied to finalized blobs and the loader's actual return.

**Why:** A 30 GB model's visible progress dropped several gigabytes during a real download because the observer counted a changing cache layout as if it were a stable transfer stream.

**How to apply:** Enable `hf-xet` high-performance mode for large Hub downloads where available, keep the regular downloader as a fallback, and never let a filesystem snapshot overwrite a higher progress value from the same load.