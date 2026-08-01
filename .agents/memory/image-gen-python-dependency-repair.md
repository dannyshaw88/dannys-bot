---
name: Image-generation Python dependency repair
description: Keeping the Windows AppData image-generation Python environment internally consistent
---

The desktop AI setup uses a writable AppData pip bootstrap directory plus a separate AI package directory. Repair must stop the running sidecar, replace the package directory, reinstall into it, verify the imported versions, and restart the sidecar; otherwise an older `huggingface_hub` can remain active beside a newer `diffusers`.

**Why:** The Qwen and LongCat pipelines both failed with `diffusers` requiring `huggingface-hub>=1.5.0,<2.0` while the AppData environment still exposed `huggingface-hub==0.36.2`. The shared failure was dependency drift, not model hardware or model files.

**How to apply:** Keep the Hub requirement compatible with the selected diffusers version and pass `--upgrade --upgrade-strategy eager` for each pip-target repair step. Preserve the separate model cache; repairing Python packages must not delete downloaded model weights. Verify imports from the same package path the sidecar will use.