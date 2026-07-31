---
name: Local image model loading phases
description: Progress reporting rule for the Electron local image-generation sidecar
---

The local image-generation loader has separate phases: downloading, assembling the diffusers pipeline, and moving it into CPU/GPU memory. A cache-size estimate can reach 100% before the model is usable, so the UI must not equate 100% with ready.

**Why:** The Qwen Image Edit download showed 100% for an extended period while the background pipeline load continued, making the desktop app appear frozen and leaving no way to distinguish downloading from model initialization.

**How to apply:** Keep `status`, `loading_phase`, elapsed loading time, and download progress separate. Exclude Hugging Face `.incomplete` blobs from completed bytes, show an explicit post-download loading message, and only switch to the generation UI after the sidecar reports `ready`.

During `from_pretrained()`, Hugging Face downloads into `.incomplete` blobs before returning the assembled pipeline. Count those active bytes for visible progress, but keep completion false until the files are finalized; leave the phase as `downloading` until `from_pretrained()` returns.

**Why:** Switching to `loading_pipeline` before `from_pretrained()` made the desktop UI show a static 0% bar while the actual multi-gigabyte download was still underway.

**How to apply:** Set the phase to `downloading` immediately before `from_pretrained()` for uncached models, then switch to `loading_pipeline` only after that call returns.

The current full-GPU Qwen Image Edit loader also needs a hardware preflight. CUDA availability alone is not enough: a roughly 4 GB GTX 1050 Ti cannot hold this approximately 20 GB pipeline on the GPU. Reject clearly undersized GPUs before importing and materializing the pipeline, and expose the requirement beside the model picker.

**Why:** Without the check, a supported CUDA runtime was mistaken for sufficient VRAM and the desktop app could appear to hang for minutes while attempting an allocation that could not succeed.

**How to apply:** Preserve the existing loading phases, add a `hardware_check` phase and status detail, and fail with a clear recommendation to select a smaller model or use a GPU with substantially more VRAM. Do not claim that Qwen can use CPU/disk offload unless the loader is actually changed to implement it.

The React preview and the installed Windows desktop app are separate artifacts. A sidecar/UI fix in the workspace does not change an already-installed version; the Electron bundle and Windows installer must be rebuilt and installed before users can see it.

**Why:** The v1.2.308 screenshot still showed the old generic loading card even though the source had newer phase fields; the screenshot came from the previously packaged installer, not the current workspace build.

**How to apply:** When validating an installer-only feature, identify the app version shown by the user and compare it with the packaged build version. Do not treat a successful Vite/API preview as proof that the installed Windows app contains the change.