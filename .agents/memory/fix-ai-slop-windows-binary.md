---
name: Fix AI Slop Windows binary packaging
description: Windows installer requirement for the FFmpeg executable used by Fix AI Slop
---

The Windows installer workflow uses dependency installation with lifecycle scripts disabled, so `ffmpeg-static` does not download `ffmpeg.exe` automatically. The workflow must run its installer explicitly, verify the executable, and the Electron build must copy it into the server bundle.

**Why:** The JavaScript loader can be present while the platform binary is absent, causing Fix AI Slop to fail at runtime with `ENOENT`.

**How to apply:** Preserve the explicit Windows binary-install and verification step whenever changing Electron packaging or the Fix AI Slop processing pipeline.