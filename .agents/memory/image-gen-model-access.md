---
name: Image-generation model access
description: Local image-model selection must verify download gating, license, account requirements, and hardware fit before adding a model option.
---

Verify all four constraints before presenting a local image model as usable: whether weights are gated, whether an account or license acceptance is required, whether generation is free of API credits, and whether the target GPU can run it. Also verify that the weight host is acceptable for the user's connection; a model can be public and free yet still be unusable when its source is throttled or too large.

**Why:** A gated model was briefly added without an in-app acceptance path, and the first replacement required substantially more VRAM than the target machine.

**How to apply:** Treat model access and hardware fit as product requirements, not download-time details; show the limitation in the model label and UI before the user downloads multi-gigabyte weights.

The current practical baseline is a pair of direct-Civitai SD 1.5 checkpoints: Realistic Vision V6 and epiCRealism Natural Sin. They are approximately 2 GB each, support local image-to-image generation through Diffusers' single-file loader, and require no paid inference credits. Their source-defined license/usage terms still need to be respected.

**Why:** The former 20–30 GB Hugging Face editors were too large and their download path was throttled. Smaller direct checkpoints make first-run setup feasible on the user's connection and hardware.

**How to apply:** Verify Civitai metadata, direct ranged download behavior, checkpoint format, local config requirements, and the installed Diffusers version before adding future registry entries. Do not register another large model merely because it is free.