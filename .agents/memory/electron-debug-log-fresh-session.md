---
name: Electron debug log fresh session
description: Startup behavior for the Windows Aura Farming server debug log
---

The Windows server debug log must be truncated when the API server process starts, then appended to normally for the rest of that session. Do not rotate prior sessions into the active debug file.

**Why:** The debug file is used to diagnose one software launch at a time; carrying old sessions forward makes recent failures difficult to isolate.

**How to apply:** Keep the server log descriptor in write/truncate mode during initialization, while retaining append mode only when reopening the descriptor after the in-session size cap trims the file.