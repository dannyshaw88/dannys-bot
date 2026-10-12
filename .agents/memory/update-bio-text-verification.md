---
name: Update Bio typing verification
description: Bio changes must be verified from the live focused EditText before Instagram is asked to save
---

Do not treat successful calibrated keyboard tap dispatch as proof that Instagram accepted the Bio characters. Before typing, confirm the Bio EditText is focused, run select-all/delete even when the accessibility snapshot says it is empty, and verify it remains empty and focused. Read the field back before tapping Finished, and abort without saving if the exact resolved text is not present.

**Why:** A real-device run dispatched calibrated key taps and followed the normal save/exit path, yet no Bio characters appeared. ADB tap success is not proof that Gboard accepted the key. The prior working flow always reset the focused field; a later optimization skipped that reset when the UI snapshot appeared empty, so preserve the older sequence while diagnosing the regression.

**How to apply:** Keep the dedicated Bio-screen gate and verify the exact resolved text in the focused EditText before save. Keep failure logs concise and avoid dumping the full configured Bio string.
