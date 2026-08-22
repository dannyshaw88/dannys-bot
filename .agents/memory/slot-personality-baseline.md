---
name: Account-slot personality baseline
description: Account behaviour must vary per stable slot identity while inheriting device calibration and Trust Score limits.
---

The device's calibrated gestures, typing capability, Mother Code timing, and swipe modes are baselines, not shared final signatures. Each account slot receives a persistent randomised overlay keyed by stable `slotId`; its modifiers stay bounded and Trust Score remains the controlling activity baseline.

**Why:** Multiple accounts on one physical phone should not emit identical automation patterns, but arbitrary per-account physical settings would be difficult to configure and could violate device safety limits.

**How to apply:** Put the Randomise control in each account slot, persist the five traits with the account slot, and apply small slot-specific timing/action variations at runtime without changing device calibration or letting lower Trust Scores leapfrog higher ones.