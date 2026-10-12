---
name: Update Bio typing verification
description: Bio changes must be verified from the live focused EditText before Instagram is asked to save
---

Do not treat successful calibrated keyboard tap dispatch as proof that Instagram accepted the Bio characters. If the confirmed Bio field does not match, clear any partial entry, use Android's native clipboard paste, and read the focused field back before tapping Finished. Abort without saving if the field or exact text cannot be confirmed.

**Why:** A real-device run dispatched calibrated key taps and followed the normal save/exit path, yet no Bio characters appeared. ADB tap success is not proof that Gboard accepted the key, so the flow needs both a native paste recovery path and final field verification.

**How to apply:** Keep the dedicated Bio-screen gate, only use clipboard paste while the focused Bio field and dedicated editor marker are confirmed, then verify exact text before save. Keep failure logs concise and avoid dumping the full configured Bio string.
