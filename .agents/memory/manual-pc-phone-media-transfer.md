---
name: Manual PC-to-phone media transfer
description: Manual Instagram posting uses a native PC picker, temporary DCIM copy, and explicit user-controlled phone cleanup.
---

The manual mirror media flow must remain separate from automated Make a Post. In the packaged Windows app, the native picker returns PC file paths for images or videos without reading the file into Electron IPC memory; the API pushes each selected file into the phone's DCIM/Camera folder and media-scans it. Users can load multiple files and delete each phone copy individually; the PC originals remain untouched. Native-path uploads support files up to 1 GB; browser/base64 fallback is capped at 70 MB.

**Why:** Users manually choose media for the phone gallery and must retain the PC source while controlling cleanup of each staged phone copy.

**How to apply:** Keep every loaded device path persistent per serial. Generate `IMG_` names for images and `VID_` names for videos, then keep the picker extensions, upload allowlist, size limits, media-scanner behavior, and delete validator in sync. The browser limit must leave room for base64 overhead under the API JSON-body limit. Never auto-delete a manual phone copy after use.

The delete endpoint must accept known-safe paths from older app versions as well as current generated image/video names. Keep all patterns restricted to `/sdcard/DCIM/Camera/` and supported media extensions, and use `rm -f` so an already-missing device file can still be cleared from the saved list.

**Why:** Manual-media entries persist in desktop localStorage per device and can outlive the app version that generated their paths; a newer exact-name validator can otherwise prevent deletion before ADB is called.

**How to apply:** When generated phone filenames or supported formats change, preserve exact safe legacy patterns in the delete validator and test old/new names plus arbitrary paths and traversal rejection.