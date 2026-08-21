---
name: Native filter camera build environment
description: The CameraX companion APK requires an Android SDK to compile
---

The native filter-camera source is built with Gradle from the api-server package, but the
workspace runtime may not have Android SDK platforms installed. In that environment the
API/web builds can still be verified while APK validation must be performed on an Android
SDK-equipped workstation or CI runner.

**Why:** Gradle fails before Java compilation when `ANDROID_HOME`/`sdk.dir` is unavailable,
which can be mistaken for an APK source error.

**How to apply:** Check the SDK path before diagnosing Java or CameraX errors; do not add a
fake SDK path or commit generated build outputs.