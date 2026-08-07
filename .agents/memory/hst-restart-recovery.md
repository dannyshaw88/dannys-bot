---
name: HST restart recovery
description: Durable rules for Human Session Tool startup recovery, manual toggle behavior, and account-slot attribution
---

Software restart loses browser-memory timers, so previously enabled HST slots need a dedicated recovery path. Recovery must reload the persisted interval and schedule the first turn inside that interval; it must never share the immediate-start path used by an explicit manual toggle-on.

**Why:** A shared immediate-start helper caused every enabled slot to launch as soon as the app restarted. The background runner also reloads settings outside the account panel, so omitting the persisted username loses Dashboard account attribution even when the slot index is correct.

**How to apply:** Keep startup recovery and manual toggle-on as distinct call modes. Recovery must treat unavailable settings or network failures as delayed retries, and the per-slot settings response must include the persisted account username so restart-triggered cycles send `slotIdx`, `slotUsername`, `sourceType: "phone"`, and `serial:slot` metadata together.