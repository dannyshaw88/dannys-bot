---
name: Follow Search readiness handoff
description: Keep Spread Follow backup candidates from inheriting an unverified Search state
---

Only attempt a Spread Follow backup or re-scrape when the preceding operation explicitly reports that Search is confirmed focused and cleared. A zero-follow result alone does not prove readiness. If readiness is false, stop retries and skip Search cleanup/navigation taps; do not let the next tool inherit an unknown screen.

**Why:** A backup candidate was marked ready unconditionally after a failed-focus attempt. Later field logs showed the same class of failure from an open Story viewer: keyboard-visible/foreground-unknown focus checks failed, but backups kept tapping calibrated Search coordinates on the wrong surface.

**How to apply:** Propagate per-attempt readiness through backup and re-scrape loops. Retry only after explicit focus-and-clear confirmation; otherwise abort the remaining phone-input sequence without clearing or pressing Back on an unknown screen.