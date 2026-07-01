# Changelog

All notable changes to Danny's Bot (Equinox) are documented here.

---

## [1.1.277] — 2026-07-01

### Fixed

#### Bootstrap deadlock: Phase 2d and Phase 2e overhaul

**Symptom**: Even after v1.1.276, follows continued returning "something went wrong" on live accounts. Logs showed `launcher/sync` returning HTTP 200 (Phase 2c' OK) but no `ig-set-www-claim` or `ig-set-authorization` in the response headers. The Phase 2d `accounts/current_user` probe then failed immediately with "something went wrong" (it enforces a valid claim on the request, creating a deadlock), leaving both tokens missing.

**Root cause**: `accounts/current_user` requires a valid `X-IG-WWW-Claim` in the **request**. When Phase 2d sends it with claim=0 (because claim bootstrap failed), Instagram returns the same generic rejection — the probe itself contributes to the failure it is trying to fix. Additionally, IgApiClient-based probes send a reduced header set (no `X-Bloks-Version-Id`, `X-Pigeon-*`, locale, or bandwidth headers) which may prevent Instagram from treating them as real Android app calls.

**Fix (instagramWebClient.ts — `_bootstrapWwwClaim`)**:

**Phase 2d** — replaced `accounts/current_user` probe with `news/inbox` GET:
- `accounts/current_user` always fails with "something went wrong" when `X-IG-WWW-Claim: 0`; excluded.
- `news/inbox` is a social-read endpoint that Instagram allows with claim=0 and that `_buildWarmedIgClient` (DM bootstrap) specifically relies on to trigger token issuance.
- New probe order: `launcher/sync` → `news/inbox` → `users/{id}/info`

**Phase 2e** (new) — direct `igReq` probes with **full** `_buildMobileHeaders` after Phase 2d:
- Sends the complete Android app header set: `X-Bloks-Version-Id`, `X-Pigeon-Session-Id`, `X-Pigeon-Rawclienttime`, `X-IG-App-Locale`, `X-IG-Device-Locale`, `X-IG-Mapped-Locale`, `X-IG-Timezone-Offset`, and realistic bandwidth metrics — identical to the actual follow request headers.
- Uses `this.mobileCookieJar` directly (same as `mobileSessionGet` / `mobileSessionPost`), bypassing the IgApiClient pipeline entirely.
- `_absorbResponseHeaders` captures any returned `ig-set-www-claim` / `ig-set-authorization` directly into `igDeviceState`.
- Probes: `news/inbox` GET → `users/{uid}/info` GET. Stops as soon as both tokens are obtained.
- Only runs when at least one token is still missing after Phase 2d.

**Actionable error surfacing**:
- When all phases complete with tokens still absent, a `⚠ ACTION REQUIRED` warning is logged recommending the operator re-verify the account via the Embedded Browser.
- When the follow itself fails with "something went wrong" and the Bearer token is absent, the error reason now appends: _"Session tokens (www-claim / Bearer) are absent — re-verify this account via the Embedded Browser to restore follow capability."_

---

## [1.1.276] — 2026-07-01

### Fixed

#### Follow "We're sorry, something went wrong" — root cause & fix

**Symptom**: Every follow attempt returned `{"message":"We're sorry, but something went wrong. Please try again.","status":"fail"}` (HTTP 200) from Instagram's `POST /api/v1/friendships/create/{userId}/`. Accounts were not getting blocked or rate-limited; the rejection was happening on every single follow for affected sessions.

**Root cause**: Instagram's mobile API requires two session tokens on every write operation (follow, unfollow, like, DM) for app v431+:
1. **`X-IG-WWW-Claim`** header — a session lease token issued by Instagram after authenticated API calls.
2. **`Authorization: IGT:2:...`** Bearer header — the real session credential for the mobile API.

Without both tokens, Instagram returns the generic "something went wrong" rejection regardless of whether the session (sessionid cookie) is valid.

`_bootstrapWwwClaim()` is called before every follow to acquire these tokens via a Jarvee-style cold-start sequence (Phase 0a/0b/0c → Phase 1 → Phase 2a/2b/2c → Phase 2d). All four Phase 2 endpoints were failing to return either token:

- **Phase 2a** `accounts/get_account_family/` → HTTP 404 (only works for Meta Family / linked accounts, not personal accounts)
- **Phase 2b** `qe/sync/` → HTTP 400 "Invalid experiment" (endpoint changed server-side)
- **Phase 2c** `banyan/banyan/` → HTTP 400 "Bad request" (endpoint changed server-side)
- **Phase 2d** `users/{id}/info/` → HTTP 200 but no `ig-set-authorization` header (Instagram stopped returning the Bearer token on this GET endpoint for established/non-fresh sessions)

Result: `X-IG-WWW-Claim: 0` and no `Authorization` header on every follow → Instagram rejects with "something went wrong".

**Fix (instagramWebClient.ts — `_bootstrapWwwClaim`)**:

Added **Phase 2c'** — an authenticated `POST /api/v1/launcher/sync/` call using the same `ig` IgApiClient instance that already has the session cookies loaded from Phase 1. Real Android apps call `launcher/sync` with `server_config_retrieval: 1` after every session restore.

Updated **Phase 2d** to probe multiple endpoints in sequence (stopping as soon as `ig-set-authorization` is obtained):
1. `POST /api/v1/launcher/sync/` — primary (most reliable)
2. `GET /api/v1/accounts/current_user/?edit=false` — does not trigger checkpoint unlike `?edit=true`
3. `GET /api/v1/users/{id}/info/` — original fallback

---

## [1.1.275] — 2026-07-01

### Fixed

- **ig-set-authorization never captured through CycleTLS**: `patchIgClientTls` replaces the entire `got` HTTP pipeline with CycleTLS, which bypassed Instagram's response interceptor that normally reads `ig-set-authorization` and `ig-set-www-claim` headers into `ig.state`. Both headers are now read from raw CycleTLS response headers and written directly to `ig.state.authorization` / `ig.state.igWWWClaim` so that `_absorbIgClientState()` can persist them to `igDeviceState` and the DB.

---

## [1.1.0] — Initial Release

### Features

- Multi-account Instagram automation: follow, unfollow, DMs, contact messaging, auto-reply
- Embedded browser (Puppeteer/Chrome) for EB-first authentication — every session originates from a real browser login
- Jarvee two-stage handshake: EB login → cookie extraction → mobile API session via `mobileBootstrapFromWebCookies`
- Device fingerprint continuity: `mid`, `ig_did`, `ig_nrcb`, `ig_did` preserved across all sessions; never regenerated unless user explicitly resets
- HikerAPI integration for hashtag/location/follower scraping
- CycleTLS (OkHttp4 JA3 fingerprint) for all mobile API requests — matches real Android Instagram app TLS fingerprint
- Proxy slot manager with per-account sticky IP assignment
- Human session simulation: timeline browsing, story viewing, DM checks between automation actions
- SQLite database (portable, single-file) with Drizzle ORM
- Electron desktop app wrapper with auto-updater (NSIS Windows installer)
- React + Vite + shadcn/ui frontend served from the Electron main process
