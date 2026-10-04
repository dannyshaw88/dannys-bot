---
name: Windows mirror diagnostics
description: Where to gather trustworthy evidence for Android mirror stalls in Danny's Electron app.
---

For mirror freezes, standby, or missing frames, the affected runtime is the packaged Windows Electron app and its connected Android device. Replit-hosted API workflow output may come from a separate environment and is not evidence about that phone.

**Why:** The user explicitly corrected the target runtime; diagnosing from Replit workflow logs risks attributing another environment's state to the affected Windows device.

**How to apply:** Instrument and inspect the per-device Debugging Log and the Windows `aura-farming-debug.log`, correlating ADB/screenrecord, WebSocket, renderer receive, WebCodecs, and canvas events by serial. Do not claim a physical-device result without testing or logs from that Windows app.