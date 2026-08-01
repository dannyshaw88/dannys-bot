---
name: Large model CPU fallback
description: Preventing impossible local model loads from appearing frozen
---

A large diffusion model may fall back to CPU `float32` loading when CUDA is unavailable. This can be extremely slow and use substantial system RAM, but it must not be rejected before the user has a chance to try it.

**Why:** The user explicitly wants the downloaded Qwen/LongCat models to attempt generation on their laptop rather than being blocked by a new hardware gate. A slower attempt is preferable to incorrectly reporting that the model cannot be used.

**How to apply:** Use CUDA when PyTorch can access it, otherwise load on CPU and show a clear slow-performance warning. Do not expose minimum-VRAM values as hard requirements or throw a pre-load CUDA/VRAM rejection for these two supported models.