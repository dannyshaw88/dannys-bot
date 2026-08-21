---
name: Phone filter camera runtime
description: Native CameraX is required for phone-side face filters
---

The phone-side filter camera must run as a native CameraX activity on the phone. The mirror Filter control should install or launch the native APK directly and must not open a browser.

**Why:** Browser camera pages are not the same as an integrated camera pipeline, are blocked by device/network routing, and cannot reliably compose tracked effects into captured media.

**How to apply:** Keep camera frames local to CameraX, use on-device face landmarks, and verify the APK is built before attempting ADB installation. Keep still/video capture behavior explicit rather than claiming raw video is filtered.