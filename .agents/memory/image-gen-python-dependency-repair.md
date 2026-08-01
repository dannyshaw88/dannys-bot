---
name: Image-generation Python dependency repair
description: Keeping the Windows AppData image-generation Python environment internally consistent
---

The desktop AI setup installs packages into a writable AppData directory with `pip --target`. Repair/install must upgrade the existing package layer as a whole; otherwise an older `huggingface_hub` can remain beside a newer `diffusers` and make every supported pipeline fail during import.

**Why:** The Qwen and LongCat pipelines both failed with `diffusers` requiring `huggingface-hub>=1.5.0,<2.0` while the AppData environment still exposed `huggingface-hub==0.36.2`. The shared failure was dependency drift, not model hardware or model files.

**How to apply:** Keep the Hub requirement compatible with the selected diffusers version and pass `--upgrade --upgrade-strategy eager` for each pip-target repair step. Preserve the separate model cache; repairing Python packages must not delete downloaded model weights.