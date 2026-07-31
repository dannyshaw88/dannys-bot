---
name: Image generation GPU detection
description: GPU presence and PyTorch CUDA usability are separate checks for local image generation
---

The AI image generator must report GPU capability from the actual PyTorch CUDA runtime, while separately showing any NVIDIA adapter/driver discovered by Windows. Device Manager showing an up-to-date driver does not prove the bundled Python environment can use CUDA.

**Why:** The old UI inferred GPU availability by searching the sidecar status message for “CUDA,” which produced a misleading “no GPU” warning when a Windows NVIDIA adapter existed but Torch was CPU-only or CUDA initialization failed.

**How to apply:** Keep structured GPU fields in the sidecar status response (`available`, Torch CUDA version, system adapter, driver, and reason). Keep model unloading (RAM/VRAM) separate from deleting downloaded model cache (disk).