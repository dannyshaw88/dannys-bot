---
name: Instagram ChallengeActivity white surface
description: A white Instagram screen can be a real full-screen ChallengeActivity, not a mirror decoder freeze.
---

When ADB and H.264 both become predominantly white and Android foreground changes to `com.instagram.challenge.activity.ChallengeActivity`, treat the surface as an Instagram account/security challenge or its blank challenge page. Do not keep debugging the mirror first.

**Why:** A real-device capture showed the challenge activity being started by Instagram, with the phone screenshot at 100% white while the H.264 stream continued decoding the same white surface.

**How to apply:** Detect and log ChallengeActivity before normal tool actions, fail closed rather than tapping guessed coordinates, and preserve the launch/logcat evidence for account-level investigation.

The manual challenge probe performs a UIAutomator dump plus several ADB diagnostics after the +3s sample, so an exported log can end before the final probe record appears. Treat the probe's explicit start/completion markers as the capture boundary.