---
name: Mobile automation settings save/load schema drift
description: Why Follow Users / Inject Browsing settings looked like they were "resetting on restart" — the persistence-layer zod schema silently dropped fields the execution-layer schema had.
---

The mobile Follow Users flow (`artifacts/api-server/src/routes/mobile.ts`) has TWO separate zod schemas that must be kept in sync manually:

1. `automationCycleSchema` — used only when actually RUNNING a cycle (execution-time validation).
2. `automationSchema` — used to SAVE/LOAD settings to/from `mobile-instances.json` via the `/api/mobile/devices/:serial/automation-settings` GET/POST endpoints (persistence-time validation).

**Why this breaks silently:** zod's `z.object({...}).parse()` strips any key not declared in the schema, with no error. If a new setting field is added to the frontend (`AutomationSettingsData`) and to `automationCycleSchema`, but NOT added to `automationSchema`, autosave POSTs that field, zod silently drops it before it's written to disk, and the next page load/restart falls back to the frontend default — looking exactly like "the tool keeps forgetting entries."

**How to apply:** Any time a new persisted mobile automation setting is added, add it to ALL THREE places: the frontend `AutomationSettingsData` type + `AUTOMATION_DEFAULTS`, `automationCycleSchema` (execution), and `automationSchema` + its GET-handler `defaults` object (persistence). Missing the third one is the easy mistake — it doesn't error, it just quietly never persists.
