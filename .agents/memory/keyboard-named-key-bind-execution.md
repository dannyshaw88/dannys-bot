---
name: Keyboard named-key bind execution
description: Rule for making per-device keyboard calibration binds affect named automation actions
---

Character typing and named keyboard controls are separate execution paths. Saving a coordinate for Emoji/Emoticon does not make a flow press it unless that flow explicitly resolves the saved key name and sends the coordinate to Android.

**Why:** The story-reply flow bypassed the calibration map with direct text injection, so the UI showed a saved bind while automation never used it.

**How to apply:** Route every named keyboard action through a shared per-device lookup with aliases such as `emoji`/`emoticon`, send saved coordinates directly in phone-screen space (not mirror video coordinates), and keep visual detection only as the uncalibrated fallback.