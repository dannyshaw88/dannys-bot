---
name: Manual Instagram launch diagnostics
description: Physical Instagram opens bypass the API launch function and require an armed foreground-transition watcher
---

Manual Instagram opens from the phone or mirror do not call the server's `launchInstagram()`/`am start` path. A launch diagnostic placed only around that function will produce no evidence for this user-visible failure.

**Why:** The mirror and device logs can show normal startup and screenrecord activity even when the user manually taps Instagram, but there is no API launch request to instrument.

**How to apply:** For manual-open investigations, arm a short-lived watcher before the user leaves Home and opens Instagram; capture the foreground transition, screencap classification, surfaces, and logcat after the transition.