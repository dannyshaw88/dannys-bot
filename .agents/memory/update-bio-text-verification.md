---
name: Update Bio typing verification
description: Bio changes must be verified from the live focused EditText before Instagram is asked to save
---

Do not treat successful calibrated keyboard tap dispatch as proof that Instagram accepted the Bio characters. Read the focused Bio EditText back and compare it with the resolved text before tapping Finished; abort without saving on mismatch.

**Why:** A real-device run dispatched calibrated key taps and followed the normal save/exit path, yet the Bio remained empty. The operation had no read-back check, so it could report success even when Android did not apply the taps to the field.

**How to apply:** Keep the dedicated Bio-screen gate, then verify the exact resolved text in the focused EditText before save. Keep failure logs concise and avoid dumping the full configured Bio string.
