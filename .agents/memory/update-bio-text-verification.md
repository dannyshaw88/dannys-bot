---
name: Update Bio typing verification
description: Bio changes must be verified from the live focused EditText before Instagram is asked to save
---

Do not treat successful calibrated keyboard tap dispatch as proof that Instagram accepted the Bio characters. Read the focused Bio field back before tapping Finished, and abort without saving if the exact resolved text is not present.

**Why:** A real-device run dispatched calibrated key taps and followed the normal save/exit path, yet no Bio characters appeared. ADB tap success is not proof that Gboard accepted the key.

**How to apply:** Keep the dedicated Bio-screen gate and verify the exact resolved text in the focused EditText before save. Keep failure logs concise and avoid dumping the full configured Bio string.
