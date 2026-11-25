---
name: Windows packaged diagnostic parity
description: Windows Electron tests run bundled API/frontend assets, so source-only diagnostics are absent until the Electron bundle is rebuilt.
---

Diagnostics added to the Replit API or web source do not appear in the user's Windows Electron log until the API bundle, frontend bundle, and Electron dist are rebuilt together.

Treat the user's Windows Electron installation as a separate runtime from the Replit preview. Preview device settings and API state do not establish the values or behavior of the Windows app.

**Why:** A packaged Windows log can look like the new instrumentation is broken when it is actually running an older embedded frontend/server bundle.

**How to apply:** Use the supplied Windows logs for observed behavior. Before attributing that behavior to current source, verify the relevant implementation exists in `artifacts/electron/dist` and the installed app was built from it.

Startup freeze diagnosis must distinguish API event-loop stalls, Electron main-process stalls, and delayed renderer responses. Keep probes single-flight and log slow responses rather than producing continuous heartbeat output. Preserve recent completed startup phases: a synchronous launch can finish before a delayed stall timer finally runs.

**Why:** The user reports simultaneous cycle starts freeze the software despite no CPU/RAM overload; ordinary HTTP timings alone cannot identify which process stopped responding.

**How to apply:** Correlate device-specific phase start/end durations with desktop and API stall markers in the Windows session logs. Diagnostics must not stagger starts or change automation behaviour merely to hide the issue.