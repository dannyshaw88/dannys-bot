---
name: Keyboard calibration UX
description: CalibrationDialog architecture — 3 modes, server-side caching, merge-not-replace save strategy.
---

The CalibrationDialog in MobilePage.tsx has three `mode` values: `"intro"`, `"wizard"`, `"editMap"`.

- **intro**: shows existing key count; "View & fix individual keys" opens editMap; "Re-run full calibration" opens wizard.
- **wizard**: full step-through, now initialises `map` state from the existing saved map so finishing a partial run merges rather than wipes.
- **editMap**: scrollable list of all CALIB_KEYS grouped by layer; each row shows ✓/✗ + coordinates; "Re-tap" button fires a single capture and auto-saves immediately (so surrounding keys are never lost).

**Why the save-immediately rule:** if the user fixes a wrong key and then closes without a final save, the fix would be lost. Auto-saving per re-tap in editMap prevents that.

**How to apply:** any future change to the capture flow must keep the merge-not-replace behaviour — never overwrite the full map with only the newly captured subset.

**5-second delay fix:** `captureOneTap` now checks `_calDeviceInfoCache` and `_calScreenSizeCache` (module-level Maps) before running `getevent -lp` or `_uiDump`. A `prefetchCalibrationData(serial)` export (+ `POST /keyboard-calibration/prefetch` endpoint) warms both caches when the dialog opens, so the first actual capture is fast. Caches are in-process only; they reset on server restart, which is fine.
