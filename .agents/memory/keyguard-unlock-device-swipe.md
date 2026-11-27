---
name: Keyguard unlock uses device swipe
description: Keep keyguard unlock gestures tied to the saved My Device swipe profile for all automation platforms.
---

Every automated phone unlock must use the saved My Device `swipeGesture` profile, before platform-specific work begins. Preserve its device-specific path and duration for both Instagram and Snapchat; do not use hard-coded unlock coordinates or silently fall back when the profile is missing.

**Why:** the prior hard-coded unlock swipe did not unlock one device, and the user explicitly requires the configured device swipe for all platform cycles.

**How to apply:** route every keyguard-unlock caller through the shared device-profile gesture resolver, keep keyguard state diagnostics, and fail explicitly if the device has no saved swipe profile.
