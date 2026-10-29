---
name: Manual Android diagnostics across USB disconnects
description: How to gather a comparison when the Android device must be unplugged during the event being investigated.
---

For a manual test performed while the phone is disconnected from USB, keep the diagnostic sampler and its output on the phone itself, then collect it after reconnecting. A host-side ADB stream stops at disconnect and cannot represent the unplugged interval.

**Why:** A reproducible plugged/unplugged difference can depend on transient phone state; the host cannot inspect that state while the device is physically disconnected.

**How to apply:** Prefer a bounded, on-device capture of only relevant system state. Avoid collecting message contents, credentials, or decrypted app traffic unless the user explicitly asks and the capture is necessary.
