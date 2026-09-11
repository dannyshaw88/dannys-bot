---
name: Windows packaged diagnostic parity
description: Windows Electron tests run bundled API/frontend assets, so source-only diagnostics are absent until the Electron bundle is rebuilt.
---

Diagnostics added to the Replit API or web source do not appear in the user's Windows Electron log until the API bundle, frontend bundle, and Electron dist are rebuilt together.

**Why:** A packaged Windows log can look like the new instrumentation is broken when it is actually running an older embedded frontend/server bundle.

**How to apply:** When investigating a real-device issue through Windows Electron, verify the relevant marker exists in `artifacts/electron/dist` before interpreting the resulting log.