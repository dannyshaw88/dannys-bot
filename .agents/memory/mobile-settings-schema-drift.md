---
name: Mobile automation settings save/load schema drift
description: Why Follow Users / Inject Browsing settings looked like they were "resetting on restart" — the persistence-layer zod schema silently dropped fields the execution-layer schema had.
---

The mobile Follow Users flow (`artifacts/api-server/src/routes/mobile.ts`) has TWO separate zod schemas that must be kept in sync manually:

1. `automationCycleSchema` — used only when actually RUNNING a cycle (execution-time validation).
2. `automationSchema` — used to SAVE/LOAD settings to/from `mobile-instances.json` via the `/api/mobile/devices/:serial/automation-settings` GET/POST endpoints (persistence-time validation).

**Why this breaks silently:** zod's `z.object({...}).parse()` strips any key not declared in the schema, with no error. If a new setting field is added to the frontend (`AutomationSettingsData`) and to `automationCycleSchema`, but NOT added to `automationSchema`, autosave POSTs that field, zod silently drops it before it's written to disk, and the next page load/restart falls back to the frontend default — looking exactly like "the tool keeps forgetting entries."

**How to apply:** Any time a new persisted mobile automation setting is added, add it to ALL THREE places: the frontend `AutomationSettingsData` type + `AUTOMATION_DEFAULTS`, `automationCycleSchema` (execution), and `automationSchema` + its GET-handler `defaults` object (persistence). Missing the third one is the easy mistake — it doesn't error, it just quietly never persists.

When clearing a persisted nested setting, send explicit `null` through JSON and allow it in the save schema. `undefined` is omitted by `JSON.stringify`, so a backend merge can retain the old value and restore it after restart.

**Why:** Removing a previously uploaded WhatsApp attachment only changed the in-memory UI; the omitted field left the stored attachment untouched.

**How to apply:** Use `null` as the explicit clear value for persisted optional objects, preserve it through the frontend type and validation schema, then confirm reload still returns the cleared state.

Never treat a failed or incomplete per-slot settings read as a valid defaults snapshot. Keep the last known values, keep autosave gated, and retry until the server returns a complete response.

**Why:** The HST hydration failure path previously substituted frontend defaults and marked them loaded. A later edit could then autosave disabled tools and default execution windows over the slot's saved configuration.

**How to apply:** Only mark the settings as hydrated after validating the server response. Recheck the save gate inside pending debounce callbacks, because a request may fail after an autosave timer was already scheduled.

## Tab-scoped autosave

Any debounced save owned by a panel that unmounts when the user changes tabs must not cancel its pending timer during unmount. Gate the save on a per-device hydration marker instead, so initial values do not overwrite another device while still allowing the final user edit to flush after navigation.

**Why:** The Phone Settings panel is tab-scoped. Its cleanup used to cancel a pending collision-preventer save, making edits disappear specifically when the user clicked to another tab.

**How to apply:** Keep the timer in a ref, clear it only when a newer edit for the same device arrives, and track the hydrated serial separately from the panel lifecycle.

When a dedicated endpoint saves only the HST enabled flag, update only that field in the autosave snapshot. Marking the whole current settings object saved can suppress pending nested Snapchat tool changes.

**Why:** A Step 1 toggle can race a Step 2 edit; the enabled-only endpoint does not persist the nested tool settings.

**How to apply:** Preserve dirty fields when reconciling dedicated toggle writes, and autosave Snapchat tool changes promptly with keepalive for navigation.

## New nested tool settings

When adding a new tool under a nested per-slot settings object, deep-merge that tool's defaults during frontend hydration and before applying partial edits. Existing saved slots may predate the tool, so a shallow merge at the top level can leave its settings `undefined` and crash the whole settings panel.

**Why:** A newly added Snapchat tool was absent from older slot records, and the UI dereferenced the missing nested object.

**How to apply:** Merge tool-level defaults with each persisted tool object on load; keep a local component fallback so incomplete legacy payloads cannot break page rendering.

Account-slot hydration follows the same fail-closed rule: reject failed or malformed GET responses, do not mark the slot list hydrated, and never autosave defaults as if they were a real empty list. Preserve a valid `slots: []` exactly.

**Why:** The account panel previously swallowed GET errors, then marked itself hydrated; a later autosave could overwrite saved accounts with blank slots. It also treated a valid empty array as missing data and displayed padded defaults.

**How to apply:** Check the HTTP status and slot payload before updating state; only enable autosave after a valid response, including an explicitly empty list.

For a hidden, disabled HST slot, hydrate only the master `enabled` flag. Preserve its current nested settings and serialize autosaves per slot; an older save response must not mark a newer snapshot as saved.

Snapchat tool switches need an immediate per-tool save and dirty-state protection during hydration. A refresh that starts after a local edit must preserve that unsaved Snapchat-tools snapshot, not only edits made after the refresh started. Before dispatching each Snapchat tool in a cycle, re-read that slot's persisted switch and skip if it is off or cannot be verified.

**Why:** Defaulting a hidden slot can overwrite all nested settings. Separately, autosave is debounced, so a hydration request started in that interval could replace a just-toggled tool with the older server value; the dispatcher also used to snapshot enabled tools only once per cycle.

**How to apply:** Keep background hidden-slot hydration lightweight without mutating nested settings; save individual Snapchat switches immediately, preserve dirty values across overlapping reads, serialize writes by slot identity, and verify the current saved switch immediately before dispatch. A tool already running is not interrupted.

The on-disk device-settings file must also fail closed: only a genuinely missing file on first run means “empty settings.” Parse/read failures must preserve the last known-good snapshot and block writes; persist new snapshots through a same-directory temporary file and atomic rename.

**Why:** Treating every read error as `{}` makes all devices appear reset and lets the next save overwrite the entire settings file. Directly truncating the live file also risks leaving invalid JSON if the process is interrupted during an update or shutdown.

**How to apply:** Keep this safeguard at the shared file-store boundary so all device/account settings get the same protection, and log the resolved path plus read/write failures without logging setting values.
