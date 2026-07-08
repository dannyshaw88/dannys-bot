---
name: DM warm-up sequence for direct_v2/inbox
description: The complete Phase 2 warm-up required before direct_v2/inbox will not return 4415001, and why news/inbox alone is insufficient.
---

The documented Jarvee Phase 2 sequence to prevent 4415001 on `direct_v2/inbox` is:

```
user.info → news.inbox → (qe.syncLoginExperiments — intentionally omitted, belongs to verify only)
```

The `users/{uid}/info` call MUST come before `news/inbox`. Without it, Instagram hasn't seen the "active user" signal and returns 4415001 "Prompt has contribution" on `direct_v2/inbox` even for accounts with no real pending in-app prompt.

**Why:** Instagram requires the client to prove it knows the account's profile before granting DM inbox access. `news/inbox` alone establishes notification badge state but not the active-user context. The symptom (4415001 on `direct_v2/inbox` after a successful `news/inbox` warmup) is the exact tell that `user.info` was missing.

**How to apply:**
- In `_buildWarmedIgClient`, Phase 2a must call `mobileSessionGet(/api/v1/users/${ownUserId}/info/)` before Phase 2b (`news/inbox`).
- If `ownUserId` is unavailable (cannot be parsed from `igApiCookies`), log a warning — the warm-up will still proceed but `direct_v2/inbox` may gate. Verified accounts always have `ds_user_id` in `igApiCookies`.
- Use `mobileSessionGet` (not IgApiClient) for both calls — IgApiClient via CycleTLS returns status 0 for authenticated calls through certain proxies.
- `qe/sync` (Phase 2c) belongs exclusively to verify bootstrap — do NOT add it to `_buildWarmedIgClient` or it creates a redundant double qe/sync.
- Phase 2a errors: propagate if `logoutReason` is set (real session kill); swallow all other errors (non-fatal, continue to Phase 2b).
