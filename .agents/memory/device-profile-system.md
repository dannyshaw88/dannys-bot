---
name: Device profile system — OEM dismiss gesture direction
description: How per-device behavioral flags (dismiss direction for recents/floating-windows) are stored, looked up, and applied at automation cycle close time.
---

## The rule

`DEVICE_PROFILES` in `androidManager.ts` maps `ro.product.model` → `{ dismissDirection: 'left' | 'up' }`.  
`getModelDismissDirection(model)` looks up the table; returns `'left'` for unknown models (safe default — matches Redmi 12 / MIUI floating-window carousel behaviour).  
`getDeviceModel(serial)` does a single synchronous `getprop ro.product.model` call.

Known entries as of Jul 2026:
- `Redmi 12` → `left` (MIUI/HyperOS floating-window card carousel, drag card off left edge)
- `Redmi A5` → `up` (stock Android recents, standard swipe-up dismiss)

## Where the field lives

`dismissDirection: 'auto' | 'left' | 'up'` is stored in `mobile-instances.json` per device/slot via:
1. `AutomationSettings` type in `mobile.ts`
2. `automationSchema` (persistence schema) in `mobile.ts`
3. `automationCycleSchema` (execution schema) in `mobile.ts`
4. `AutomationSettingsData` interface + `AUTOMATION_DEFAULTS` in `MobilePage.tsx`
5. Both GET-handler `defaults` objects in `mobile.ts` (line ~1147 and ~1226)

**Why:** follows the schema-drift rule in `mobile-settings-schema-drift.md` — a field missing from any one of the three layers silently never persists.

## Resolution at call site

At the `closeInstagramViaRecents` call in the automation cycle handler:
```ts
const resolvedDismissDir: "left" | "up" = dismissDirection !== "auto"
  ? dismissDirection
  : android.getModelDismissDirection(android.getDeviceModel(serial));
```

## UI

A `<select>` in the STEP1 card of `AutomationSettingsPanel` (MobilePage.tsx) exposes:
- Auto (detect by model)
- Swipe left (Redmi 12 / MIUI floating windows)
- Swipe up (Redmi A5 / stock Android recents)

Also included in the Copy Settings map under the Run Interval section.

## Adding a new model

Add one entry to `DEVICE_PROFILES` in `androidManager.ts`. No other code changes needed for the existing left/up behaviours.

**Why:** branch on the behaviour (dismiss direction), not device identity — two devices with the same direction share the same code path.
