---
name: Manual Instagram launch diagnostics
description: Physical Instagram opens bypass the API launch function and require an armed foreground-transition watcher
---

Manual Instagram opens from the phone or mirror do not call the server's `launchInstagram()`/`am start` path. A launch diagnostic placed only around that function will produce no evidence for this user-visible failure.

**Why:** The mirror and device logs can show normal startup and screenrecord activity even when the user manually taps Instagram, but there is no API launch request to instrument.

**How to apply:** For manual-open investigations, arm a short-lived watcher before the user leaves Home and opens Instagram; capture the foreground transition, screencap classification, surfaces, and logcat after the transition.

## Interpretation

Do not classify the first post-transition frame as a persistent render failure. A high near-white percentage together with Android `Splash Screen` or `starting_reveal` surfaces can be a normal launch transition; compare follow-up frames before escalating. A persistent failure requires the activity to remain foreground while later frames stay blank or white, ideally with supporting SurfaceFlinger or logcat evidence.

**Why:** A real-device trace showed Instagram foregrounded successfully, with a 59.98% near-white first sample and splash/reveal surfaces, followed roughly 1.5 seconds later by stable frames at about 22% near-white and mean luma near 134. The process stayed alive and no crash was recorded.

**How to apply:** Capture at least the initial transition plus delayed follow-ups around 250 ms, 1 second, and 3 seconds; interpret the surface list and frame statistics together rather than using the first frame alone.