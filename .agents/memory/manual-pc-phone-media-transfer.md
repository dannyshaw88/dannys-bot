---
name: Manual PC-to-phone media transfer
description: Manual Instagram posting uses a native PC picker, temporary DCIM copy, and explicit user-controlled phone cleanup.
---

The manual posting flow must remain separate from automated Make a Post. In the packaged Windows app, the native file picker selects one PC image; the API pushes it into the phone's DCIM/Camera folder and media-scans it; the user posts manually in Instagram; and a separate Delete from phone action removes the exact pushed path.

**Why:** Users sometimes need to manually review or edit a post and do not want the source image to remain on the phone after use.

**How to apply:** Keep the loaded device path persistent per serial, block loading a second manual image until the first is deleted, and never auto-delete the manual copy after Instagram use.

The delete endpoint must accept known-safe paths from older app versions as well as the current generated name. Keep both patterns restricted to `/sdcard/DCIM/Camera/` and supported image extensions, and use `rm -f` so an already-missing device file can still be cleared from the saved list.

**Why:** Manual-media entries persist in desktop localStorage per device and can outlive the app version that generated their paths; a newer exact-name validator can otherwise prevent deletion before ADB is called.

**How to apply:** When generated phone filenames change, preserve exact safe legacy patterns in the delete validator and test old/new names plus arbitrary paths and traversal rejection.