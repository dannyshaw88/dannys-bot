---
name: ADB device-loss race handling
description: Prevent mid-cycle phone disconnects from becoming raw gesture failures or guessed-coordinate input
---

When a phone can disappear between cycle readiness and a later gesture, cache a successful screen-size result for the active serial and share it with the gesture path. Classify ADB not-found, offline, unauthorized, and transport errors as device-unavailable so the cycle can stop explicitly.

**Why:** A calibrated gesture path previously probed `wm size` once to resolve its profile and then probed it again inside `swipe()`. A device disconnect between those calls surfaced a raw ADB error after a long cycle and could invite unsafe coordinate fallbacks.

**How to apply:** Keep device-loss errors distinct from normal automation failures in the API response, activity log, and screenshot endpoints. Preserve diagnostic context server-side, but expose only a concise reconnect instruction to the UI.