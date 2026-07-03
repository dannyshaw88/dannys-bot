# Changelog

All notable changes to Danny's Bot (Equinox) are documented here.

---

## [1.1.305] — 2026-07-03

### Added

#### Periodic DOM session-alive poll on every open EB window (`ebManager.ts`)

**Problem**: The "Continue as…" logout screen is a React SPA overlay — the URL stays at `https://www.instagram.com/` so `did-navigate` never fires. Every URL-based detection method (including `_detectSessionDeath`) was completely blind to it. Logouts caused by mobile API calls, Instagram server-side revocation, or anything other than a hard page redirect produced zero log output.

**Fix**: A 30-second `setInterval` now runs on every open embedded-browser window. Each tick executes a lightweight DOM probe that checks for:
- Hard login-page URL (`/accounts/login/`, `/accounts/onetap/`, `/accounts/suspended/`)
- SPA overlay: a visible "Log in" or "Continue as…" button
- Login form: a visible `<input type="password">`

On first detection it emits a `[eb-session-dead:ID]` log line containing: `reason` (which trigger matched), `trigger` (the exact button text), current URL, page title, the last non-login URL the EB was on before the death, exact timestamp, and partition name. A 60-second debounce prevents log spam if the poll keeps firing into a dead session. The interval is cleared when the window closes.

This means the next session death — regardless of cause (API call, navigation, Instagram server action) — will appear in the log within 30 seconds.

---

## [1.1.304] — 2026-07-03

### Fixed

#### Login-wall detection: DOM check added alongside URL check (`ebManager.ts`)

Instagram shows the "Continue as…" session-expired screen two ways: a hard redirect (URL changes to `/accounts/login/`) and a soft overlay (URL stays on the profile page but a login modal renders on top). The previous URL-only check missed the soft overlay entirely and still timed out as "Follow button not found". The DOM probe now checks for a visible password input, a "Log in" button, or a "Continue as…" button — catching the overlay case immediately.

#### `loadURL` failures now returned as explicit errors (`ebManager.ts`)

Navigation failures (proxy error, network timeout, ERR_NAME_NOT_RESOLVED, etc.) were silently swallowed via `.catch(() => {})`, leaving the URL at `about:blank`. The login-wall check then passed (not a login page) and the follow timed out 20 seconds later as "Follow button not found". Failures are now caught, logged, and immediately returned as `Browser navigation failed: <reason>`.

---

## [1.1.303] — 2026-07-03

### Added

#### Heavy diagnostic logging for browser session logout (`ebManager.ts`)

- **`[eb-session-dead:ID]`** — the session-death handler now tracks the last URL the EB was on *before* the login redirect and logs it alongside the login URL, exact timestamp, and partition name. Makes it possible to see what page triggered the logout.
- **CookieCheck login-page guard** — if the EB is already on the login page when a CookieCheck cycle fires, it now logs `detect=LOGIN-PAGE` with a loud warning instead of silently breaking on the banner check.
- **Silent-follow navigation chain** — `did-navigate` and `did-redirect-navigation` listeners on the hidden follow window log every URL hop so the full redirect chain from profile → wherever Instagram sends it is visible in the log.
- **Silent-follow START line** — logs partition name, target username, and profile URL before `loadURL` fires so the exact moment a follow attempt begins is unambiguous.
- **Silent-follow landed URL** — always logs the final URL after `loadURL` with `loginPage=true/false`, even on success.
- **Main-EB URL after follow** — immediately after the temp window lands, logs the *main* EB window's current URL (`main-EB url=…`) so isolation can be confirmed: if the fix is working the main EB must NOT be on the login page even when the temp partition is.

---

## [1.1.302] — 2026-07-03

### Fixed

#### Browser follow logs out the visible EB — isolated temp session for silent-follow (`ebManager.ts`)

**Symptom**: After a browser-follow attempt (accounts with "Do Actions Via Browser → Follows" enabled), the account's visible embedded browser would show Instagram's "Continue as…" screen — the session was alive before the follow, dead after it. The follow itself always failed with "Follow button not found on page" even though the target profile exists.

**Root cause**: `silent-follow` was using `persist:eb-${profileId}` — the exact same Electron session partition as the live EB window. Because all windows on a `persist:` partition share one cookie jar, the cookie-seeding step inside `silent-follow` (which reads from the on-disk cookie file) was overwriting the live, valid session cookies in the shared jar with potentially stale file cookies. Both the hidden follow window and the visible EB window read from the same jar, so the moment the follow window corrupted the cookies, the main EB was also logged out. Instagram then showed the "Continue as…" screen when the user looked at the main EB.

**Fix**: `silent-follow` now creates a throw-away in-memory partition (`eb-follow-${pid}-${Date.now()}`, no `persist:` prefix) for each follow attempt. It seeds this temp partition by reading the **live** cookies directly from the main `persist:eb-${pid}` session via `mainSes.cookies.get()` (the freshest available cookies, not the stale file), falls back to the file only if the live partition has no sessionid, and applies the proxy only to the temp session. When the follow window is destroyed the temp session disappears entirely — the main EB partition is never read from, written to, or had its proxy config touched.

#### Browser follow: instant login-wall detection instead of 20-second poll timeout (`ebManager.ts`)

**Symptom**: When the browser session was already expired (for any reason), `silent-follow` would navigate to the target profile, get redirected to the Instagram login page, and then poll for 20 seconds looking for a Follow button that could never appear. The account was reported as `follow_blocked: Follow button not found on page` instead of `follow_blocked: session_expired`.

**Fix**: After `loadURL` resolves, the final URL is immediately checked against the login-page pattern (`/accounts/login/`, `/accounts/onetap/`, `/accounts/suspended/`). On match the window is destroyed and `session_expired — browser session logged out` is returned immediately — the engine's existing `logged_out` path then marks the account correctly and stops the session, rather than waiting 20 seconds and reporting the wrong error.

---

## [1.1.301] — 2026-07-03

### Fixed

#### Browser follow: "Follow button not found on page" — `div[role="button"]` with `aria-label` now detected (`ebManager.ts`)

**Symptom**: Accounts with "Do Actions Via Browser → Follows" enabled consistently failed every follow attempt with `follow_blocked: Follow button not found on page`. The automation engine reported 0/1 follows and re-queued the session. The failure was 100% reproducible regardless of target account or source hashtag.

**Root cause**: The silent-follow hidden BrowserWindow navigates to the target's Instagram profile at a 390×844 viewport (mobile). Instagram's current mobile web profile page renders the Follow button as a `div[role="button"]` element with `aria-label="Follow"` — not a `<button>` element. The poll script queried only `document.querySelectorAll('button')` and compared `textContent` with an exact case-sensitive match against `'Follow'` or `'Follow Back'`. Because the element is a `div`, not a `button`, it was never found. The poll ran its 40 iterations (500ms each = 20 seconds) and returned `timedOut: true` every single time.

**Fix — four sites updated in the `silent-follow` handler:**

1. **Initial 20-second poll** (`btnInfo`): Selector changed to `button, [role="button"]`. A new `norm()` helper prefers `aria-label` (trimmed) when present; otherwise uses `innerText || textContent` with all internal whitespace collapsed via `/\s+/g` and lowercased. Matching is now case-insensitive (`'follow'`, `'follow back'`, `'following'`, `'requested'`). A zero-size rect guard (`r.width > 0 && r.height > 0`) was added so invisible/hidden elements that match are skipped.

2. **Pre-tap freshRect re-query**: Same broadened selector and `norm()` logic. Size guard tightened to `r.width <= 0 || r.height <= 0` (either dimension non-positive rejects) to prevent miss-taps from partially offscreen buttons.

3. **JS-click fallback** (used when CDP tap is unavailable): Same broadened selector and `norm()` logic.

4. **Post-tap confirmation poll**: Same broadened selector and `norm()` logic for both the "done" (`following`/`requested`) and "stillFollow" checks.

5. **Timeout diagnostic dump**: Also updated from `querySelectorAll('button')` to `querySelectorAll('button, [role="button"]')` and uses `aria-label || innerText` so the log accurately reflects what elements were visible on the page when the timeout fires — making future debugging possible.

**What this handles going forward**: Any Instagram A/B test that toggles between `<button>` and `div[role="button"]` rendering, any Follow button with nested SVG/icon elements adding whitespace to `textContent`, and any capitalisation variation in button text.

---

## [1.1.298] — 2026-07-03

### Fixed

#### Browser logout after `viewReels` — `logout_reason:3` forced revocation now detected and acted on (`instagramWebClient.ts`, `automationEngine.ts`)

**Symptom**: Accounts running the Human Session runner would be found logged out of the embedded browser repeatedly, even with DM checks disabled. The EB would navigate to `instagram.com/accounts/login/` while the account's status was still shown as active.

**Root cause**: When `/api/v1/clips/user/` (the reels endpoint) returns HTTP 403 with `{"message":"login_required","logout_reason":3}`, Instagram has server-side force-revoked the session — both the mobile API session AND the browser session are invalidated simultaneously. Previously, `viewReels` detected the empty `items` array in the error response and silently returned `false`. The automation engine's `catch { /* non-critical */ }` then swallowed the result. The account was never marked `logged_out`, so the EB kept running with an invalidated session and any subsequent navigation hit the login page.

**Fix**:
- `viewReels` now checks for `j.message === "login_required"` before reading `items`. If present, it throws `Error("session_expired — <error_title> | logout_reason:<N>")` instead of returning false.
- The automation engine's `viewReels` catch block now inspects the error message. On a `session_expired` / `login_required` match it calls `applyAccountLevelError` to immediately mark the account as `logged_out` and stop the current run — the same path used by `viewTimelineFeed` and `likeTimelinePosts` when they detect session expiry.

### Improved

#### `X-IG-Nav-Chain` header on every mobile call (`instagramWebClient.ts`)

The `X-IG-Nav-Chain` header was only sent during the login sequence. All other mobile API calls sent nothing, which is a detectable inconsistency — the real Android app sends a nav-chain on every authenticated request. Added `_navChainTs` / `_navChainScreen` fields and a `_buildNavChainHeader()` helper. The header is now injected in `_buildMobileHeaders()` on every mobile call, with the screen set to `"profile"` before follow/unfollow, `"reels"` before viewReels, `"explore"` before explore, and `"home"` otherwise.

#### Per-account connection-type personality (`instagramWebClient.ts`)

`"WIFI"` was hardcoded at all mobile call sites. Every account in the fleet reporting WIFI is a fleet-wide detection signal. Added `_getConnectionType()`, which derives `WIFI` (~81% of accounts) or `LTE-Advanced` (~19%) deterministically from the first hex digit of `igDid`. The type is permanent once set and applies to `_buildMobileHeaders()`, `mobilePostMultipart`, and the rupload path. Accounts with LTE-Advanced also report a matching lower connection speed.

#### Pigeon analytics events (`instagramLogin.ts`)

The `analytics/log` launcher step was sending `analytics_events: "[]"` — an empty array that is a known automation fingerprint. Added `buildPigeonAnalyticsEvents()` which generates four realistic back-dated events: `app_lifecycle_change_state`, `navigation`, `instagram_organic_viewed_impression_v2`, and `session_heartbeat`. These match the timing and structure of events the real Instagram Android app sends on startup.

---

## [1.1.296] — 2026-07-03

### Fixed

#### Browser-follow stat counting — `already_following` ghost-increment and silent DB abort (`automationEngine.ts`)

**Symptom 1**: Daily and lifetime follow counts incremented even when a profile was already being followed. Session logs showed "Followed [x/y]" correctly, but the stats dashboard reported more follows than were actually performed.

**Root cause**: Both the main follow loop (∼line 4370) and the rescrape loop (∼line 4559) called `storage.incrementStat(profile.id, "follow")` inside the generic `ok: true` success branch. `followViaBrowser` (and the API follow path) can return `{ ok: true, status: "already_following" }` — an already-followed account was reaching `incrementStat` and being counted as a fresh new follow.

**Fix**: Added an `already_following` guard in both loops. `incrementStat` is now only called when `result.status !== "already_following"`.

---

**Symptom 2**: In the same loops, any SQLite lock or write failure thrown by `storage.incrementStat()` would propagate out of the loop body uncaught, aborting all remaining post-follow processing (activity-log writes, sleep delay, etc.) for the rest of the session.

**Root cause**: `storage.incrementStat` was invoked with no surrounding try/catch in both loops. A transient DB lock (common with SQLite under concurrent reads) caused a hard throw that killed the iteration.

**Fix**: Each `incrementStat` call is now wrapped in its own `try/catch` with an explicit `console.error` log. A DB write failure is surfaced in logs but no longer aborts the session.

---

#### "Follow button not found" — silent timeout with no diagnostics (`ebManager.ts`)

**Symptom**: The embedded-browser silent-follow flow would poll for 20 seconds for the follow button, then silently time out. No information was available about why the button was not found — wrong page, DOM structure change, broken navigation, or rate-limit interstitial were all indistinguishable.

**Fix**: Added a diagnostic block that fires on poll timeout:
- Logs the current URL, page title, all visible button texts (`innerText`), and a 200-character body snippet to the console — enough to identify the wrong-page or wrong-DOM-structure root cause without a screenshot in most cases.
- Captures a full-page screenshot via `capturePage()` and writes it to `<cookiesDir>/screenshot-errors/follow-fail-<profileId>-<username>-<timestamp>.png`. The directory is created automatically on first use. The username component is sanitised for filesystem safety (non-word characters stripped).

### Changed

#### Login toolbar button macro — full rewrite for new Instagram homepage layout (`ebManager.ts`, `case "login"`)

**Motivation**: Instagram updated its homepage layout. The previous macro broke because:
- Tab × 2 (username → "Save info?" checkbox → password) no longer navigated to the password field correctly in the new layout.
- The character-by-character `typeTextCDP` approach (human-speed per-keystroke timing) could not compete with the faster paste-style expected by the new form.
- The post-submit button-polling loop (20 × 250ms attempts) was unnecessary complexity that sometimes missed the button after layout re-renders.

**Old sequence**:
1. Tap + JS-focus username field
2. Ctrl+A → Delete → `typeTextCDP` (character-by-character, human timing)
3. Tab × 2 (skip "Save info?" intermediate element to reach password)
4. Ctrl+A → Delete → `typeTextCDP` for password
5. Tab → Tab → Enter to submit
6. Poll 20 × 250ms for `button[type="submit"]` / Log-in text match → `cdpTapGesture`

**New sequence**:
1. Tap + JS-focus username field → Ctrl+A → Delete → `Input.insertText` (paste entire username instantly)
2. **1 × Tab** (username → password directly in the new layout)
3. Ctrl+A → Delete → `Input.insertText` (paste password)
4. Tab → Tab → Enter (submit login form)
5. Wait 10 seconds (Instagram navigates to 2FA page)
6. Fetch profile → `generateTotp(twoFASecretKey)` — equivalent of "Generate Code" in Equinox account-settings 2FA section
7. Retry up to 10 × 500ms to locate the OTP input via CSS selectors (same set used by the standalone 2FA button); tap to focus
8. `Input.insertText` — paste the 6-digit code
9. Tab × 4 → Enter (submit 2FA form)

**Notes**:
- Steps 6-9 are skipped entirely when the profile has no `twoFASecretKey`.
- When the browser is not on the Instagram login page at the time the button is clicked, the page navigates to `instagram.com/accounts/login/` and fills credentials after `did-finish-load`. The 2FA step is not attempted in this fallback path (navigate-then-fill case).

#### 2FA toolbar button macro — simplified for pre-focused input (`ebManager.ts`, `case "totp"`)

**Motivation**: On the Instagram 2FA page the verification code input is already focused by default, making the previous field-search and manual tap sequence unnecessary overhead that sometimes misfired.

**Old sequence**:
1. Tab × 2 (attempt to move focus into the 2FA input region from wherever focus last was)
2. Fetch profile → `generateTotp`
3. Retry loop (10 × 500ms) to locate the OTP input via JS selectors
4. `cdpTapGesture` to focus the OTP field
5. `typeTextCDP` character-by-character (200–600ms per digit, uneven human-like timing)
6. Tab × 2 → polling loop (16 × 200ms) to find a submit/confirm/verify button → `cdpTapGesture`

**New sequence**:
1. Fetch profile → `generateTotp(twoFASecretKey)` — "account settings → Generate Code"
2. `Input.insertText` — paste the 6-digit code into the already-focused field
3. Tab × 4 → Enter (submit 2FA form)

Skipped entirely when the profile has no `twoFASecretKey`.

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
