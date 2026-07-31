---
name: Large model CPU fallback
description: Preventing impossible local model loads from appearing frozen
---

A large diffusion model with a full-pipeline VRAM requirement must not silently fall through to CPU `float32` loading when CUDA is unavailable. The download may finish successfully, but assembling a 20B+ parameter pipeline in system RAM can page indefinitely and look like a frozen app.

**Why:** The model loader previously checked minimum VRAM only inside the CUDA branch, so CPU-only machines attempted an impractical load instead of reporting the hardware mismatch.

**How to apply:** Mark full-GPU models as CUDA-required, validate CUDA before importing/assembling the pipeline, and report the detected GPU/runtime reason. Keep CPU-compatible models available separately.