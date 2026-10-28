---
name: Additional focused project pointers
description: Index for less frequently used mobile, UI, and tooling notes.
---

Less frequently used project notes:

- [Edit tool regex safety](edit-tool-regex-corruption.md) — avoid regex backslash corruption in templates; use xml.includes() instead of new RegExp()
- [Floating-windows recents close gesture](floating-windows-recents-close.md) — use a left-drag on the left-most card; repeat per app and poll pidof
- [GitHub PAT push fallback](github-pat-push-fallback.md) — project GITHUB_TOKEN secrets work with GIT_ASKPASS HTTPS pushes, but not the gitPush source-control helper
- [Chrome manual search sequencing](chrome-manual-search-sequencing.md) — run optional Google history searches after normal Chrome feed work and target live EditText nodes, not toolbar coordinates
- [Phone filter camera runtime](phone-filter-camera-chrome-launch.md) — use the native CameraX APK; browser camera pages are not an acceptable phone-filter runtime
- [Native filter camera build environment](native-filter-camera-build.md) — Gradle APK validation needs an Android SDK; API/web builds remain independently verifiable
- [Google manual search variety](google-manual-search-variety.md) — manual Chrome searches should be mostly natural multi-word queries, with isolated one-word terms limited to an occasional 5% path
- [Images workspace local processing](images-workspace-local-processing.md) — reuse Make a Post processing and export copies; Electron should process native-selected paths locally
- [Dashboard cycle summary icons](dashboard-cycle-summary-icons.md) — use Statistics action icons in cycle activity details, but keep eye-based metrics text-only
