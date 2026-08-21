---
name: Native filter APK packaging
description: The phone filter APK must ship inside the packaged API server, not be resolved from the Windows process working directory
---

The native filter APK is copied into the API distribution beside the bundled server and resolved relative to the running server module, with the workspace path retained only for development.

**Why:** Packaged Electron launches can have a user/workspace working directory that contains no native Android project, so process.cwd()-only lookup produces a false “APK not built” error.

**How to apply:** Any packaged Windows build must include and verify the APK under the API server distribution before creating the installer.