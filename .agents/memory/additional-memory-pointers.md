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
- [DM share sheet blind-tap risk](dm-share-sheet-blind-tap.md) — confirm a modal sheet before coordinate-tapping; absence of a side effect does not prove it opened
- [Share-sheet label-scan exclusions](share-sheet-label-scan-exclusions.md) — exclude feed hashtags and counts so underlying nodes cannot pass as recipients
- [Reel share-sheet resource-id alias](share-sheet-resource-id-alias.md) — require ancestor Chat evidence; the avatar ID is reused by WhatsApp/Share shortcuts
- [Share-sheet confirm and scan timing](share-sheet-dump-timing.md) — combine confirmation and recipient scan so the sheet stays open
- [Your Story vs DM contact resource ID](share-sheet-your-story-rid.md) — filter the parent description because story and DM avatars share an ID
- [Windows installer CI assertions](windows-installer-ci-assertions.md) — keep text-based workflow checks aligned with the current UI, especially after copy changes
- [Uploaded attachment auto-commit](uploaded-attachment-auto-commit.md) — an uploaded asset may be committed automatically during a later push even when it was not manually staged
- [GitHub API commits and LFS objects](github-api-lfs-pointers.md) — Git-data API pointer blobs do not upload LFS payloads; Windows smudge then fails with a 404
- [Windows LFS pointer line endings](windows-lfs-pointer-line-endings.md) — GitHub-written CRLF LFS pointers make Windows checkouts appear dirty; normalize pointers to LF before installer builds
- [Phone Farm local wallpapers](phone-farm-local-wallpapers.md) — native Electron/browser picker stores a resized image data URL in shared slot customizations
