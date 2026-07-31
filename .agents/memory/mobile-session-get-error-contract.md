---
name: mobileSessionGet error contract drift
description: A classifier written against an old throw/return contract of a helper silently breaks when the helper's contract changes and nobody re-verifies the classifier.
---

`mobileSessionGet()` in the Instagram web client throws an `Error` on any HTTP status >= 400 (embedding messages like `session_expired — ... | logout_reason:N` or `prompt_required_4415001`), and returns `null` only when there is no mobile session available at all. It does **not** return `null` on 4xx bodies.

**Why:** A downstream classifier (`_buildWarmedIgClient`'s warm-up error handling) was written under the assumption that `mobileSessionGet` returned `null` on Instagram-level 4xx errors and only threw on true network failures. That assumption was true at some point in history but drifted — the function now always throws on 4xx. The classifier's `isNetworkErr = !e?.response` check consequently treated *every* error (including a genuine server-side session kill, e.g. HTTP 403 with `logout_reason:8`) as a transient network error, triggering an unnecessary fallback call that itself could be misread as "OK" (a 200 response with `{status:"fail"}` body still passed a `!== null` check). The real session kill was silently masked, and the automation continued using a dead session until an unrelated downstream call (e.g. 4415001 on the DM inbox) surfaced a *different*, misleading symptom that then got soft-labeled as "gated" — completely hiding the actual root cause from account-health monitoring.

**How to apply:**
- When you find a comment describing a helper's return/throw contract ("returns null only on X, throws only on Y"), verify it against the *current* implementation before trusting a classifier built on it — comments and classification logic rot independently of the function they describe.
- Prefer classifying on explicit, function-attached structured metadata (e.g. `error.httpStatus`, `error.logoutReason`) rather than the mere presence/absence of ad-hoc fields like `error.response`, which differs across libraries (hand-rolled fetch vs `instagram-private-api`) and silently returns `undefined` for the "wrong" library's errors.
- A response with HTTP 200 but a `{status:"fail"}` body is a real application-level failure — never treat "non-null response" as "success" for any Instagram API response envelope.
