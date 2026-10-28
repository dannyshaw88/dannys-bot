---
name: Account-slot personality baseline
description: Account behaviour must vary per stable slot identity while inheriting device calibration and Trust Score limits.
---

The device's calibrated gestures, typing capability, Mother Code timing, and swipe modes are baselines, not shared final signatures. Instagram account slots receive a persistent randomised overlay keyed by stable `slotId`; Snapchat slots must not expose, persist, or apply account-slot personality or the account-slot Gestures panel. Modifiers stay bounded and Trust Score remains the controlling activity baseline.

**Why:** Multiple Instagram accounts on one physical phone should not emit identical automation patterns, but arbitrary per-account physical settings would be difficult to configure and could violate device safety limits. The user explicitly excluded Snapchat account slots from personality and Gestures functionality.

**How to apply:** Keep the Randomise control, five persisted traits, and account-slot Gestures panel for Instagram slots only. Gate slot UI, storage hydration/persistence, API mutations, event dispatch, and runtime adjustments by platform; preserve device calibration and Trust Score behavior.