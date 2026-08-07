---
name: Mobile local post source retention
description: Phone Farm local posting never deletes the original PC source file after upload.
---

Phone Farm and Human Session Tool local-folder posting must retain the original PC media file after a successful upload. Only the temporary copy pushed onto the device is removed.

**Why:** The PC folder is the user's reusable source library; deletion is no longer an available setting or an intended runtime behavior.

**How to apply:** Do not reintroduce a delete-after-upload field in mobile settings, copy allow-lists, schemas, runners, or posting flows. Keep device-temp cleanup separate.