---
name: Per-device mother-code personality
description: The mobile automation keeps one shared implementation but derives stable, small timing and gesture differences from each device serial.
---

The mother code should remain shared. Per-device uniqueness belongs at the shared execution boundaries: cycle dwell waits, calibrated typing profiles, and calibrated swipe resolution. Derive a stable serial hash for bounded scale/bias values, then apply ordinary per-action randomness on top. Keep category-specific dwell overrides distinct from globalDwell.

**Why:** independent device personalities are more maintainable than copying automation code per phone, and stable serial-derived variation prevents every device from sharing the same distribution.

**How to apply:** preserve safety clamps and saved calibration settings; never let personality modifiers create unbounded coordinates, durations, or destructive retries. Verify the resolved personality by serial when diagnosing fleet-wide similarity.