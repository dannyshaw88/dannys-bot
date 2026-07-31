---
name: Image-generation model access
description: Local image-model selection must verify download gating, license, account requirements, and hardware fit before adding a model option.
---

Verify all four constraints before presenting a local image model as usable: whether weights are gated, whether an account or license acceptance is required, whether generation is free of API credits, and whether the target GPU can run it. A model can be public and free yet still be unusable on the target hardware.

**Why:** A gated model was briefly added without an in-app acceptance path, and the first replacement required substantially more VRAM than the target machine.

**How to apply:** Treat model access and hardware fit as product requirements, not download-time details; show the limitation in the model label and UI before the user downloads multi-gigabyte weights.

Z-Image-Turbo is a suitable baseline for this project: its official Hugging Face repository is ungated and Apache-2.0 licensed, uses Diffusers' `ZImagePipeline`/`ZImageImg2ImgPipeline`, and the model card targets 16 GB consumer GPUs. The current full-device loader should keep the 16 GB minimum and 24 GB recommended thresholds visible.

**Why:** This provides a realistic, local, no-API-credit option with strong photorealism and text rendering while avoiding the gated/non-commercial access caveat of FLUX.1-dev.

**How to apply:** Verify the live Hugging Face model metadata and the installed Diffusers version before adding future registry entries; do not download multi-gigabyte weights merely to register a model.