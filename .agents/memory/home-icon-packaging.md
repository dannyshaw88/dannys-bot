---
name: Home icon packaging
description: The Home visual reference must be available in packaged Windows builds without relying on workspace attached_assets
---

The packaged Home detector must have a self-contained reference asset. Workspace-level attached_assets may exist in Replit but not in a Windows checkout, so packaging must use the original reference when available and a bundled fallback otherwise.

**Why:** A Windows Make a Post run aborted before tapping Home because the installed package had neither the workspace asset folder nor a packaged Home reference.

**How to apply:** Make the installer build rebuild the API and Electron bundle, fail when no reference source exists, and verify the packaged reference directory contains a supported image before release.