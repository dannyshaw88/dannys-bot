---
name: Electron debug log fresh session
description: Startup behavior for the Windows Aura Farming server debug log
---

The Windows server debug log must be truncated when the API server process starts, then appended to normally for the rest of that session. Do not rotate prior sessions into the active debug file.

**Why:** The debug file is used to diagnose one software launch at a time; carrying old sessions forward makes recent failures difficult to isolate.

**How to apply:** Keep the server log descriptor in write/truncate mode during initialization, while retaining append mode only when reopening the descriptor after the in-session size cap trims the file.

When exporting a diagnostic after a packaged restart, include the tails of the rotated main-process logs (`logs.1` through `logs.3`) and the native-operation breadcrumb alongside the current session.

**Why:** A hard termination can produce no final JavaScript or child-exit event; exporting only the fresh `logs.log` hides the evidence from the session that actually failed.

**How to apply:** Treat the current log as the active session and rotated logs as prior-session evidence. Preserve the existing `recentMainLog` field for compatibility, and add separate fields for rotated logs and native context.