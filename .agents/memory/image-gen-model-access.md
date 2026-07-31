---
name: Image-generation model access
description: Local image-model selection must verify download gating, license, account requirements, and hardware fit before adding a model option.
---

Verify all four constraints before presenting a local image model as usable: whether weights are gated, whether an account or license acceptance is required, whether generation is free of API credits, and whether the target GPU can run it. A model can be public and free yet still be unusable on the target hardware.

**Why:** A gated model was briefly added without an in-app acceptance path, and the first replacement required substantially more VRAM than the target machine.

**How to apply:** Treat model access and hardware fit as product requirements, not download-time details; show the limitation in the model label and UI before the user downloads multi-gigabyte weights.