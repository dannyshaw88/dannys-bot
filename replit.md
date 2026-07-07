# Danny's Bot

An Instagram automation platform for managing multiple accounts with tools for following, unfollowing, DMs, contact messaging, auto-reply, and session activity tracking.

## Run & Operate

1. `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
2. `pnpm --filter @workspace/dannys-bot run dev` — run the frontend (port 22393)
3. `pnpm run typecheck` — full typecheck across all packages
4. `pnpm run build` — typecheck + build all packages
5. `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec

## Stack

6. pnpm workspaces, Node.js 24, TypeScript 5.9
7. API: Express 5
8. DB: SQLite + better-sqlite3 + Drizzle ORM (file: `database.db` at workspace root)
9. Frontend: React + Vite + Tailwind CSS + shadcn/ui + Wouter
10. Validation: Zod (`zod/v4`), `drizzle-zod`
11. Build: esbuild (CJS bundle)
12. Electron: desktop app wrapper in `artifacts/electron/`

## Where things live

13. `artifacts/dannys-bot/` — React frontend (Vite, Wouter, shadcn/ui)
14. `artifacts/api-server/src/` — Express API server
15. `artifacts/api-server/src/instagram/` — Instagram automation engine (Puppeteer, instagram-private-api)
16. `artifacts/api-server/src/routes/instagram.ts` — All API route definitions
17. `artifacts/api-server/src/storage.ts` — DB access layer
18. `artifacts/api-server/src/shared/` — Shared schema and route definitions
19. `artifacts/electron/` — Electron desktop app wrapper
20. `lib/db/src/` — Drizzle schema + SQLite DB client (shared across server)
21. `database.db` — SQLite database (workspace root)

## Architecture decisions

22. SQLite (not PostgreSQL) — single-file database for portability, lives at `process.cwd()/database.db`
23. `lib/db/src/index.ts` creates tables with `CREATE TABLE IF NOT EXISTS` on startup — no migration runner needed
24. Instagram routes are registered directly on the Express app (not via the router), via `registerInstagramRoutes(httpServer, app)`
25. Puppeteer-based embedded browser for session management and cookie creation
26. The server also statically serves the built frontend from `artifacts/dannys-bot/dist/public` when it exists
27. Browser frame streaming uses WebSocket (not SSE) so the frame stream does not consume one of Chromium's 6 HTTP connections per origin — keeps all connections free for clicks and API calls regardless of how many embedded browsers are open

## EB-FIRST AUTHENTICATION RULE (non-negotiable, do not break)

**Every account session must originate from the embedded browser (EB). No Instagram API call may ever be made without a browser-originated cookie. This is the Jarvee model and must never be bypassed.**

### The only valid session establishment flow (Jarvee two-stage handshake — v1.0.307+):
28. Embedded browser (Chrome/Puppeteer) logs in via `instagram.com/accounts/login/`
29. App extracts `sessionid`, `csrftoken`, `ds_user_id`, `mid` from Chrome's cookie jar
30. Those cookies are **immediately saved** to `igApiCookies` in the DB (status stays `verifying`) and to `browser-data/cookies-{profileId}.json`
31. `verifyInstagramCredentials(profileWithCookies)` is called with the fresh cookies — it takes **Path 2 (cookie restore)** because `igApiCookies` now has a sessionid. It runs the Jarvee cold-start sequence: `tokens/keyed → launcher/sync → users/{id}/info`
32. The result of the mobile API call sets the final `accountStatus` — `valid` only if the API confirms the session. The EB alone is never sufficient to mark an account valid.

### What is FORBIDDEN:
33. Calling `client.mobileLogin(username, password)` directly from the automation engine — this is a cold mobile API login that bypasses the EB entirely. Instagram treats it as a new-device takeover and risks account locks.
34. Calling `verifyInstagramCredentials()` with a profile that has **no** `igApiCookies` from an EB login — this causes Path 1 (direct mobile password login) which bypasses the EB. The function is safe to call ONLY AFTER the EB has logged in and `igApiCookies` has been saved to the profile, which forces Path 2 (cookie restore).
35. Returning a usable API client from `ensureClient()` that has no session from an EB login (either `browserOk=true` via fresh EB cookies, or `isMobileLoggedIn()=true` from previously-verified igApiCookies that originated from an EB login).

### Where this is enforced:
36. `/api/profiles/:id/verify` → `getOrCreateSession` → `browserAutoLogin` → `getSessionPageCookies` → save `igApiCookies` to DB → `verifyInstagramCredentials(profileWithCookies)` [Path 2 only] → set final status
37. `/api/profiles/verify-all` → same two-stage flow, sequential with delay
38. `ensureClient()` in `automationEngine.ts`: if no EB session AND no stored igApiCookies → returns null, skips run
39. If EB session exists but `mobileBootstrapFromWebCookies()` fails → logs warning, skips mobile-API tools, does NOT fall back to `mobileLogin()`

### Legacy dead code — do not use:
40. `artifacts/api-server/src/src/` — duplicate directory, NOT imported by any active code, NOT bundled. It still references older patterns. Ignore it; it is dead. Active code lives exclusively in `artifacts/api-server/src/` (without the nested `src/src`).
41. Path 1 inside `verifyInstagramCredentials()` (direct mobile password login) — never triggered by the verify routes because they always supply `igApiCookies` before calling the function. If `igApiCookies` is absent from the profile passed in, Path 1 would fire — that is a bug, not the intended path.

## DEVICE FINGERPRINT CONTINUITY RULE (non-negotiable, do not break)

**Every account has a permanent device identity. These identifiers must never be changed, regenerated, or cleared by any code path — for any reason — unless the user explicitly presses "Reset Device IDs". Violating this causes Instagram to fire "Unrecognized device" security alerts and flags the account.**

### What the device identity consists of:

**Browser-level (Chrome cookies, preserved across all EB sessions):**
- `mid` — Machine ID. Instagram's primary persistent device token. Set once when a device first contacts Instagram and never changes for that device.
- `ig_did` — Instagram Device ID. Paired with `mid` to uniquely identify the device.
- `ig_nrcb` — Non-removable cookie backup. A secondary device persistence token.

**Mobile API level (stored in `igDeviceState` JSON in the DB):**
- `uuid` — Device session UUID
- `deviceId` — Android device ID
- `phoneId` — Phone identifier
- `adid` — Advertising ID
- `igDid` — ig_did value used by the mobile API client

### Where these are stored:
- `igDeviceState` (DB column) — JSON containing `uuid`, `deviceId`, `phoneId`, `adid`, `igDid`, and optionally `authorization` / `igWWWClaim`
- `igApiCookies` (DB column) — semicolon-separated string: `sessionid=X;csrftoken=Y;ds_user_id=Z;mid=W;ig_did=V`
- `browser-data/cookies-{profileId}.json` — full Chrome cookie export including `mid`, `ig_did`, `ig_nrcb`
- `browser-data/userdata-{profileId}/` — Chrome's persistent user data directory (survives app restarts, never stored in temp)

### The priority order for restoring device IDs (always follow this, never skip to random):
1. `igDeviceState.igDid` / stored UUIDs — written by Verify Credentials, most authoritative
2. `igApiCookies` mid — extracted from the mobile API cookie jar during verify
3. `_mobileIgDid` / `_mobileMid` class fields — once generated for a session, reused for its lifetime
4. Generate new random value — **ONLY** if absolutely nothing is stored anywhere (brand-new account, never verified)

### The only legitimate way to reset device IDs:
The user explicitly presses **Reset Device IDs** in the UI → calls `wipeEbSession()` → deletes `cookies-{profileId}.json` and `userdata-{profileId}/` directory → clears `igDeviceState` and `igApiCookies` from the DB. This is the only intentional reset path.

### What is FORBIDDEN:
42. Calling `randomUUID()` to generate `ig_did`, `mid`, `device_id`, `phone_id`, `uuid`, or `adid` when a stored value exists anywhere in `igDeviceState` or `igApiCookies`.
43. Deleting `mid`, `ig_did`, or `ig_nrcb` from Chrome's cookie jar for any reason other than a user-initiated reset. When clearing stale session cookies before login, always split cookies into device tokens (preserve) and session cookies (clear).
44. Storing Chrome's `userDataDir` in `os.tmpdir()` or any path that can be purged by the OS. It must live in `COOKIES_DIR` (next to the database) so Chrome's full profile persists across app restarts.
45. Allowing `loadBrowserCookies()` in `instagramWebClient.ts` to read from any path other than the one derived from `DATABASE_PATH` (Electron production) or `process.cwd()/server/browser-data/` (dev). A hardcoded path will silently read nothing in production and the engine will fall back to stale or missing API cookies.

### How this is enforced in code (as of v1.0.324+):
- `setDeviceInfo()` in `instagramWebClient.ts` eagerly seeds `_mobileIgDid` from `igDeviceState.igDid` and `_mobileMid` from `igApiCookies` mid the moment device info is loaded from the DB — before any code path can generate a random fallback.
- `_restoreMobileFromApiCookies()`, `_restoreMobileFromAuthorization()`, `mobileBootstrapFromWebCookies()`, and the post-login cookie extraction all check `_mobileIgDid` / `_mobileMid` before calling `randomUUID()`.
- Both cookie purge sites in `browserSession.ts` (session startup and `browserAutoLogin`) split cookies into device tokens and session cookies and only wipe the session cookies, restoring device tokens immediately.
- Chrome's `userDataDir` lives in `COOKIES_DIR` (persistent, next to the database file), not in `os.tmpdir()`.
- `loadBrowserCookies()` uses the `DATABASE_PATH`-aware path so Electron production and dev both read from the same location the EB wrote to.

## Product

46. Multi-account Instagram manager
47. Follow/Unfollow tools with proxy support — actions use the mobile API by default, unless stated otherwise in per-account settings (e.g. "Do Actions Via Browser → Follows" uses the embedded browser instead)
48. DM and contact messaging tools
49. Human session (embedded browser) for cookie/session management
50. Auto-reply tool
51. Proxy manager with ping/auto-link
52. Activity dashboard and stats

## User preferences

53. Do not skip any file during imports — every file matters for git

## Hard Proxy Gate — current rules (non-negotiable, do not regress)

**Every account MUST route through its assigned proxy. No automation window may ever open, navigate, or perform any action on the machine's real IP. This is an absolute rule with no exceptions and no `useHomeIp` bypass.**

### Where this is enforced (mode-B temp windows in `ebManager.ts`):

- `sfTempWin` (`/eb/silent-follow`): hard abort (HTTP 400) if `bodyProxy.host`/`port` absent; hard abort (HTTP 500) if `setProxy()` throws
- `spTempWin` (`/eb/silent-post`): hard abort (HTTP 400/500) if `eb-proxy` fetch fails, returns no proxy, or `setProxy()` throws; `useHomeIp` bypass removed
- `ssTempWin` (`/eb/silent-search`): same as `sfTempWin`

### What is FORBIDDEN:

- Any `if (proxy?.host)` soft guard on proxy setup — these silently skip proxy config and open the window on the real home IP
- `useHomeIp` bypass or any other path that allows an action to proceed without the assigned proxy
- `catch { /* proceed without */ }` around `setProxy()` — proxy failure must be a hard abort, not a silent skip

---

## EB IP Leak Prevention — current rules (non-negotiable, do not regress)

Do not re-attempt anything in the attempt history below as confirmed-not-the-issue.

### Attempt history / diagnosis chain (chronological)

#### Attempt 1 — Switched proxyRules → PAC script (v1.0.607)
- **Theory**: `mode:'fixed_servers' + proxyRules` silently falls back to DIRECT in Electron 33 / Chromium 130 when the proxy is slow or the 407 auth cycle fails.
- **Change**: HTTP proxies now use an inline `pacScript` string that returns `"PROXY host:port"` with NO `DIRECT` fallback.
- **Result**: WebRTC PASS, but DNS leak tab still showed 2 different IPs (Cloudflare vs ipify).

#### Attempt 2 — Removed DoH (v1.0.609)
- **Theory**: `setDnsOverHttpsConfig` was sending DNS queries from Chrome directly to Cloudflare using the machine's real IP, bypassing the proxy.
- **Change**: Removed `setDnsOverHttpsConfig` entirely. Added double-setProxy (150ms gap), `clearHostResolverCache()` before each proxy set, `did-start-loading` event re-apply.
- **Result**: DNS leak tab STILL showed 2 different IPs. Cloudflare now correct; ipify still leaked real IPv6.

#### Attempt 3 — Fixed the test tool itself (v1.0.611, CONFIRMED FIXED)
- **Theory**: `testDNS()` fetched `api64.ipify.org` — dual-stack, QUIC-enabled. Chrome can open a QUIC/UDP connection directly, bypassing the TCP-only HTTP proxy tunnel, exposing real IPv6. The proxy was routing correctly the whole time — the test tool was the bug.
- **Change**: `testDNS()` in `leaksPage.ts` changed to `api.ipify.org` (IPv4-only, no AAAA, no QUIC).
- **Result**: CONFIRMED fixed in v1.0.611 build #538.

#### Attempt 4 — Fixed my-ip.io endpoint (v1.0.613)
- **Theory**: `api.my-ip.io` has a AAAA record — same direct-IPv6-socket leak as Attempt 3.
- **Change**: Switched to `api4.my-ip.io/v2/ip.json` (IPv4-only subdomain).
- **Result**: Fixed. Note: an earlier note claiming "my-ip.io is safe" was wrong — it does have a AAAA record.

#### Attempt 5 — Reverted PAC script → fixed_servers with embedded credentials (v1.0.618)
- **Theory**: `pacScript` inline-string is silently ignored in some Electron 33/34 builds on Windows; when ignored, all traffic goes DIRECT. The original "fixed_servers falls back to DIRECT" diagnosis (Attempt 1) was a false positive — the real cause was the QUIC/IPv6 test-tool bug (Attempts 3-4).
- **Change**: `buildProxyConfig()` uses `mode:'fixed_servers'` + `proxyRules:'http://user:pass@host:port'` for HTTP proxies, credentials embedded in the URL (Chrome sends `Proxy-Authorization` preemptively, no 407 cycle needed).
- **Result**: Pending confirmation at time of writing.

#### Attempt 6 — Residential auto-detection in Proxy IP Match (v1.0.619, REVERTED — WRONG)
- **Theory (WRONG)**: Assumed a residential-looking exit IP was a residential-proxy exit address.
- **Reality**: It was the user's real home broadband. There is no reliable way to distinguish "residential proxy exit" from "real leak" from geo data alone.
- **Result**: REVERTED in v1.0.620. Proxy IP Match must always FAIL on mismatch; the user decides.

#### Open issue (unresolved as of v1.0.613)
- Proxy IP Match always shows FAIL for rotating residential proxies since the exit IP legitimately differs from the proxy host IP on every rotation. This is a known display-limitation, not a real leak — no fix has been applied (seemed correct-by-design after Attempt 6 was reverted).

### Chromium launch flags (artifacts/electron/src/main.ts, before app.whenReady):
- `--disable-ipv6`, `--disable-quic` — prevent Chrome from opening a direct IPv6/QUIC(UDP) socket to Cloudflare-fronted endpoints, which bypasses the HTTP proxy (TCP-only) entirely.
- `--disable-features=HappyEyeballsV3,IPv6Reachability` — disables IPv6 preference/reachability probing.
- `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` + `--enforce-webrtc-ip-permission-check` — WebRTC leak prevention.
- `--dns-prefetch-disable`, `--no-proxy-fallback`, `--proxy-bypass-list=127.0.0.1;[::1];localhost`.

### Session-level proxy config (artifacts/electron/src/ebManager.ts, buildProxyConfig):
- HTTP proxies: inline PAC script (`pacScript` string, NOT `pacURL`, NOT `mode:'fixed_servers'`) with NO `DIRECT` fallback for non-loopback hosts — an unreachable proxy must fail hard, never leak.
- SOCKS5 proxies: `mode:'fixed_servers'` + `proxyRules` (PAC can't carry SOCKS5 credentials).
- DoH (`setDnsOverHttpsConfig`) is DISABLED — it sent DNS directly to Cloudflare via the real IP, bypassing the proxy.
- Proxy is set TWICE (150ms gap) on EB window open to defeat a persistent-session race where Chrome reloads its on-disk proxy config and overwrites the PAC. `clearHostResolverCache()` before each set. `did-start-loading` also re-applies proxy (fires before page requests). `app.get('login', ...)` supplies 407 credentials.

### Verify concurrency gate (artifacts/api-server/src/routes/instagram.ts):
- `acquireSilentVerifySlot()` / `releaseSilentVerifySlot()` semaphore ensures only 1 hidden BrowserWindow runs at a time — parallel Chromium instances previously crashed Electron's main process.

### DNS leak test endpoints (artifacts/api-server/src/instagram/leaksPage.ts):
- Uses `api.ipify.org` (NOT `api64.ipify.org` — dual-stack/QUIC, bypasses proxy via direct UDP) and `api4.my-ip.io` (NOT `api.my-ip.io` — has a AAAA record, leaks real IPv6 via direct socket). `1.1.1.1/cdn-cgi/trace` is safe with `--disable-quic` in place.

### Proxy IP Match test logic (v1.0.620+):
- Always shows **FAIL** when exit IP ≠ proxy host IP. There is no reliable way to distinguish "residential proxy exit IP" from "real home broadband IP" from geo data alone — the user must manually judge a mismatch.

## EB Hidden-Window Throttling — current rules (non-negotiable, do not regress)

Root cause confirmed v1.1.344, 5 Jul 2026 — do not re-investigate.

### Root cause chain (in the order actually discovered)

1. **`backgroundThrottling: false` missing on some BrowserViews (v1.1.342)** — the main EB window had it, but the per-tab `BrowserView` (created in the `new-tab` IPC handler) and several short-lived windows (`sfTempWin`, `spTempWin`, `ssTempWin`, `leakWin`, `_hiddenWin`, toolbar BrowserView) did not. Chromium throttles timers/rAF/lazy-loading per-WebContents when hidden/occluded, so the tab actually holding the Instagram page never finished rendering while the parent window was hidden. Fixed by adding the flag everywhere a BrowserWindow/BrowserView holds real page content.
2. **CONFIRMED INSUFFICIENT** — user reported the exact same symptoms after the throttling fix. `backgroundThrottling` only stops Chromium's own scheduler from throttling timers on a hidden WebContents — it does NOT stop Instagram's own page script from checking `document.visibilityState`/`document.hidden` and deliberately skipping hydration of UI it thinks isn't visible. That's page-level app behavior, not a Chromium-scheduler behavior.
3. **Real fix (v1.1.343)** — `viewTimelineFeed` and `likeTimelinePosts` already had a working pattern: force `document.visibilityState`/`document.hidden` to report visible via `Object.defineProperty` + dispatch a `visibilitychange` event, plus use `scrollIntoView` + full pointerdown/pointerup/click event sequence instead of a plain `.click()` (a plain click on a hidden window can be silently swallowed, and `getBoundingClientRect()` returns zeros). This pattern had never been applied to the Follow button click or story tray detection/click — once added there too, both started working.
4. **`/eb/silent-post` (Make a Post) — same bug class (v1.1.352)** — "Could not find Create button" was NOT a click-mechanism bug (a first fix adding pointerdown/pointerup to Create/Post/Next/Share/Done did not help). Real cause: the flow never applied the visibilityState override before querying the left nav, so Instagram's SPA never hydrated the Create button into the DOM at all — no selector could ever find it. Fixed by applying the same visibilityState/hidden override right after login-confirmation and before querying for Create.
5. **Deepest root cause (v1.1.344, CONFIRMED, do not re-investigate)** — `win.hide()` in the window's `close` handler suspends Chromium's compositor entirely at the OS level, which is deeper than anything `backgroundThrottling`/`visibilityState` overrides can address: `IntersectionObserver` reports zero intersections (0×0 viewport), so React's virtualized lists (`<article>`, story tray, Follow button, Reels video) are never mounted into the DOM at all — not hidden, literally never created. `waitForSelector('article')` timeouts were not a loading problem, they were a "node was never created" problem.
   - **Fix**: never call `win.hide()` on automation windows. Move off-screen via `win.setPosition(sw + 10, y)` + `win.setSkipTaskbar(true)` instead — Windows/Chromium treat the window as still "visible" (full compositor speed, real IntersectionObserver firing, full DOM mount) even though the user can't see it (not on screen, not in taskbar, not in alt-tab). Opening the EB from the UI calls `setSkipTaskbar(false)` + `setBounds(workArea)` to bring it back.
   - Also added `CalculateNativeWinOcclusion` to `disable-features` (prevents compositor suspension when occluded by another app) and `--disable-renderer-backgrounding`.

### Current enforced rules (do not regress)
- **Never call `win.hide()`** on any EB automation window. `win.hide()` suspends Chromium's compositor entirely at the OS level — `IntersectionObserver` reports zero intersections, so React's virtualized lists (feed `<article>`, story tray, Follow button, Reels video) are never mounted into the DOM at all. Use off-screen positioning instead: `win.setPosition(sw + 10, y)` + `win.setSkipTaskbar(true)`. Restoring for the user: `setSkipTaskbar(false)` + `setBounds(workArea)`.
- Every `BrowserWindow`/`BrowserView` in `ebManager.ts` that holds real page content must set `backgroundThrottling: false` in `webPreferences` — this applies even to windows that start `show: true`, since they can be hidden/occluded later.
- Every EB flow that queries or clicks Instagram DOM elements must first override `document.visibilityState`/`document.hidden` to report visible (`Object.defineProperty` + dispatch `visibilitychange`) — Instagram's SPA skips hydrating UI it thinks isn't visible, independent of Chromium's own throttling. Use `scrollIntoView` + pointerdown/pointerup/click instead of a bare `.click()` (a plain click on a hidden window can be silently swallowed).
- Chromium flags: `CalculateNativeWinOcclusion` in `disable-features`, `--disable-renderer-backgrounding`.

## EB Multi-Tab IPC — current rule (non-negotiable)

### Diagnosis (separate but related failure mode to the throttling issue above)
- **Symptom**: ALL background page checks (Reels, Stories, Follow, Feed) silently returned empty/undefined even though the EB visibly loaded real pages and network succeeded. Side-effect-only scripts (e.g. `scrollBy()`) appeared to "work" since they don't throw on an empty frame, which masked the bug.
- **Root cause**: `POST /eb/navigate` and `POST /eb/evaluate` in `ebManager.ts` called `e.win.webContents` directly. Once an EB window has tabs open, `e.win.webContents` is the native toolbar/shell frame (a separate `BrowserView` holds the real Instagram page) — every `executeJavaScript` query ran against the shell frame, which has no Instagram DOM. This was the same bug class already fixed for the silent-verify login path's `getActiveWc()` usage, but `/eb/navigate`/`/eb/evaluate` were never updated to match.
- **Fix (v1.1.341)**: both handlers resolve `getActiveWc(pid) ?? e.win.webContents` before `loadURL`/`executeJavaScript`. Added a debug log per `/eb/evaluate` call showing which target was used (shell vs. active-tab BrowserView).

### Current enforced rule
- Any `/eb/*` IPC handler in `ebManager.ts` that interacts with page content must resolve `getActiveWc(pid) ?? e.win.webContents` first. Never call `e.win.webContents` directly to read/write page content — once tabs are open, that's the shell/toolbar frame, not the active tab's `BrowserView` holding the real Instagram page.

## EB Mode-B Silent-Window Fingerprint Gap — current rule (non-negotiable, fixed 6 Jul 2026)

### Diagnosis
- **Symptom**: accounts getting banned during bulk automated follow/unfollow/DM/post actions, even though the main EB window and proxy gate were both fully compliant with every other documented rule.
- **Root cause**: the Mode-B "silent" temp windows — `sfTempWin` (`/eb/silent-follow`), `spTempWin` (`/eb/silent-post`), `ssTempWin` (`/eb/silent-search`) — are created on demand when the EB isn't already open for that profile, to run one bulk action headless/off-screen. Unlike the main EB window, these never received `WEBRTC_BLOCKER_JS` + `buildFingerprintScript()` injection or the account's real browser/API user-agent. They launched with Electron's raw default Chromium fingerprint and UA. To Instagram, this looks like "same sessionid, suddenly a completely different device" — a strong automated-abuse signal — which is very likely what triggered bans during bulk actions specifically (not manual EB sessions, which were always fully spoofed).
- **Compounding gap**: `automationEngine.ts`'s `followUserViaBrowser()`/`searchUserViaBrowser()` never even had a parameter to pass the profile's `userAgentEmbedded`/`userAgentApi`/`ebFingerprint` down to `/eb/silent-follow` and `/eb/silent-search` — only `/eb/silent-post` (via the `/api/profiles/:id/eb-proxy` route) had access to fingerprint data at all.

### Fix (v1.1.365+ era)
- New helper `armSilentWindowAntiDetection(win, {browserUA, apiUA, ebFingerprint})` in `ebManager.ts` (defined right after `WEBRTC_BLOCKER_JS`) attaches the CDP debugger, injects `WEBRTC_BLOCKER_JS` + `buildFingerprintScript()` via `Page.addScriptToEvaluateOnNewDocument`, and sets UA via both `webContents.setUserAgent()` and `Emulation.setUserAgentOverride` — called on `sfTempWin`, `spTempWin`, and `ssTempWin` BEFORE their first `loadURL`.
- `automationEngine.ts`: `followUserViaBrowser()` and `searchUserViaBrowser()` now accept an `fp` param (`{userAgent, apiUA, ebFingerprint}`) forwarded in the POST body to `/eb/silent-follow`/`/eb/silent-search`; all call sites pass `profile.userAgentEmbedded`/`profile.userAgentApi`/`(profile as any).ebFingerprint`.

### Current enforced rule
- Any NEW Mode-B (on-demand, off-screen) temp window created in `ebManager.ts` for a silent/background action MUST call `armSilentWindowAntiDetection()` with the profile's real `browserUA`/`apiUA`/`ebFingerprint` before its first navigation. A temp window that runs with Electron's default fingerprint while reusing an account's real `igApiCookies`/sessionid is a device-mismatch signal to Instagram, independent of whether the proxy/IP is correct.
- Any caller in `automationEngine.ts` that invokes a `/eb/silent-*` IPC route for an existing profile must forward that profile's `userAgentEmbedded`/`userAgentApi`/`ebFingerprint` in the request body — never call a silent-action route with only `proxy`/`igApiCookies` and no fingerprint data.

## Regular EB Window Desktop-UA Override — REMOVED (non-negotiable, fixed 6 Jul 2026)

### Diagnosis
- **Symptom**: the leak-test page reported a device/user-agent mismatch, and accounts continued getting banned even after the Mode-B silent-window fingerprint gap (above) was fixed — meaning the leak was happening somewhere outside the Mode-B bulk-action path, i.e. during ordinary manual/human-session browsing.
- **Root cause**: `openEbWindow()` in `ebManager.ts` (the function behind the main, regular account EB window used for human sessions and manual browsing) contained a blanket override: whenever an account's assigned identity was a mobile UA, the function silently swapped it for a generic Windows desktop Chrome UA, reasoning that Instagram's desktop web UI has more features (e.g. the full sidebar and Make-a-Post "Next" button). This ran on every regular window open — the majority of an account's live session time — while `verifyInstagramCredentials()`, the mobile API client, and the Mode-B silent windows all continued to use the account's REAL assigned mobile identity (e.g. Android 13, OnePlus CPH2449) for the exact same sessionid/cookies. Instagram therefore saw one session token presented from two completely different devices depending on which code path touched it — a strong automated-abuse / session-hijack signal, and a direct violation of the DEVICE FINGERPRINT CONTINUITY RULE (an account's assigned identity must never be swapped for an unrelated one on any code path).

### Fix (v1.1.366)
- Removed the desktop-UA override entirely from `openEbWindow()`. Regular EB windows now always render with the account's real assigned identity (mobile UA when the account is assigned a mobile UA), matching what the mobile API client and Mode-B silent windows already use. The window's physical size (1280×820) is unchanged — only the reported identity (`_browserUA`/`_fpIsMobile`) is no longer swapped.
- Trade-off accepted: Instagram will now serve its mobile web layout (not the desktop sidebar UI) inside the regular EB window for mobile-assigned accounts. The EB-driven Make a Post click flow (`.agents/memory/make-a-post-log.md`) already has UI-variation-tolerant selectors, and the primary automated posting path (`/eb/silent-post` Mode B, fresh temp window) was never affected by this override in the first place — it already used the account's real identity via `armSilentWindowAntiDetection()`. Stopping an active, ongoing account-ban cause takes priority over a cosmetic desktop-layout convenience.

### Current enforced rule
- Do NOT reintroduce a desktop-UA (or any other identity-swapping) override for regular EB windows. An account's assigned browser/API user-agent and fingerprint must be presented identically everywhere that account's session cookies are used — human session, Mode-B silent windows, mobile API — with no exceptions for UI convenience.

## Desktop Client-Hints Leak — FIXED (6 Jul 2026)

### Diagnosis
- **Symptom**: comparing two accounts' leak-test screenshots side by side — one with a Mac UA, one with a Linux UA — showed byte-for-byte identical `Sec-CH-UA-Platform` ("Windows"), `Architecture` ("arm"), and `Platform-Version` ("15.0.0") values on BOTH, despite neither account's UA string claiming to be Windows.
- **Root cause**: every desktop (non-mobile) `Emulation.setUserAgentOverride` CDP call in `ebManager.ts` (main `openEbWindow()`, `armSilentWindowAntiDetection()` for Mode-B temp windows, and `doAutoLogin()`'s login-flow override) only built a full `userAgentMetadata` object on the mobile branch. Desktop UAs got no metadata override at all, so Chromium computed `navigator.userAgentData`/`Sec-CH-UA-*` from the real host machine instead of the account's assigned identity — identical across every desktop-UA account on the same machine, and inconsistent with each account's own declared UA string (a real browser always keeps Client Hints in sync with its UA).

### Fix
- Added `buildDesktopUAMetadata(browserUA)` in `ebManager.ts`: derives `platform`/`navigatorPlatform`/`architecture`/`platformVersion`/`bitness` from the declared UA string (Mac → `macOS` + realistic macOS version; Linux → `Linux`; Windows → `Windows` + a Win10/Win11-realistic platform version), varied per-account via a hash of the UA string so different accounts don't collide with each other either. Applied at all three desktop CDP override call sites.

### Current enforced rule
- Any CDP `Emulation.setUserAgentOverride` call for a **desktop** (non-mobile) UA must pass a full `userAgentMetadata` object derived from that account's own declared `browserUA` via `buildDesktopUAMetadata()` — never omit it and let Chromium fall back to the real host machine's Client Hints. Only the mobile branch is exempt because it already builds full metadata from the Android UA.
- This does not retroactively fix canvas/audio noise already stored on profiles created before the v1.1.370 entropy fix — those need **Reset Device IDs** to get a fresh full-entropy fingerprint if a leak test shows a collision on those specific signals.

## Leak-Test Page Hang — FIXED (6 Jul 2026)

### Diagnosis
- **Symptom**: on the leak-test page, Public IP / Proxy IP Match / WebRTC Leak / DNS Leak cards stayed on "Fetching…/Running…" indefinitely, and Battery API / Media Devices / Permissions / Client Hints never left their initial "PENDING" badge at all.
- **Root cause**: `runAll()` in `leaksPage.ts` runs `await testIP()` BEFORE the `Promise.all([testDNS, testAudio, testBattery, testMediaDevices, testPermissions, testClientHints])` block. `testIP()` has an internal 8s `AbortController` timeout on its `fetch()` call, but when the assigned proxy accepts a TCP connection and then never completes the 407 auth handshake, the underlying fetch promise can remain unsettled past that point in some Electron/Chromium builds — so `await testIP()` never resolved, and every test after it (including the entire `Promise.all` block) never even got called.

### Fix
- Added a `withTimeout()` belt-and-suspenders wrapper (12s) around `testIP()` and each test in the `Promise.all` block in `leaksPage.ts`. Even if a test's own internal timeout/abort mechanism fails to settle the promise, `withTimeout()` forces `runAll()` to move on so every card always reaches a definite state instead of hanging forever.

### Current enforced rule
- Any new async test added to the leak-test page's `runAll()` sequence must be wrapped in `withTimeout()` (or otherwise guaranteed to settle) before being awaited or added to the `Promise.all` block — a single stalled fetch must never be able to block the rest of the suite.

## Image Upload (Make-a-Post / Repost) — current rules

See `.agents/memory/make-a-post-log.md` for the EB-click-driven posting flow's bug history (clicks, visibility, Escape-key, recycling) — that log is separate from the image-upload API path below.

**Share button click (v1.1.361, current rule, do not regress):** Share is clicked via the exact same generic text-match button finder (`spClickBtnTextOnce`/`spFindBtnPos`) already used for "Done" and (as `spClickBtnText`) for both crop/filter "Next" clicks — because Share is literally the SAME header button element as Next, just relabelled. Do NOT reintroduce a bespoke "reject candidates overlapping the photo" heuristic for Share — that exact approach (v1.1.359) was tried and confirmed to still click the photo/tag-people overlay in production. Prefer the proven generic mechanism over a one-off heuristic for a sibling button in the same flow.

### Diagnosis chain

#### ProcessingFailedError — Image upload transcode non-retryable failure (25 Jun 2026)
- **Symptom**: Both PATH A (`ig.publish.photo` via IgApiClient) and PATH B (hand-rolled rupload+configure) failed with HTTP 400 `ProcessingFailedError: Image upload transcode non-retryable failure` (`retriable: false`).
- **Root cause**: When the aspect ratio was within Instagram's allowed bounds (0.8–1.91), the code skipped re-encoding and passed the raw downloaded buffer straight to rupload. Instagram's server-side transcoder rejected it — likely a progressive JPEG, non-sRGB color space, or corrupt/exotic EXIF. The crop paths already re-encoded via `sharp().jpeg()` so they were safe; only the no-crop path wasn't.
- **Fix (v1.0.751+)**: the no-crop branch in `uploadPhoto()` now always re-encodes through sharp: flatten alpha (white background) → force sRGB colorspace → baseline (non-progressive) JPEG at quality 92. Crop paths updated to use the same sanitization flags for consistency.

#### "upload id is missing, please send a valid upload id" — configure fails after rupload succeeds (25 Jun 2026)
- **Symptom**: PATH B rupload succeeded (`status=ok`, `upload_id` confirmed, but no `rur` cookie in the Set-Cookie response), then configure immediately returned "upload id is missing".
- **Root cause 1 — separate proxy tunnels**: rupload (`tlsMultipartPost`) created its own `HttpsProxyAgent`, used it, then destroyed it; configure (`igReq`) created a DIFFERENT one. Two separate TCP connections could get routed to different backend shards by Instagram's load balancer — the upload slot lived on shard A, configure hit shard B.
- **Root cause 2 — stale `rur` cookie**: `_mobileRupload` only wrote a new `rur` cookie to `mobileCookieJar` if none already existed, so a stale wrong-shard `rur` could survive even when rupload did return a fresh one.
- **Fix (v1.1.165)**: `tlsRequest`/`igReq` and `_mobileRupload`/`_configureViaIgClient` now accept a shared `agentOverride`/`sharedAgent`. `uploadPhoto`/`uploadVideo` create ONE `HttpsProxyAgent` (`keepAlive: true, maxSockets: 1`) before rupload, pass it to both rupload and configure, and destroy it in a `finally` block. `_mobileRupload`'s `rur` logic now always overwrites the cookie when the rupload response returns one.

### Current enforced rules (do not regress)
- Always normalize images through sharp before rupload: flatten alpha (white background) → force sRGB colorspace → baseline (non-progressive) JPEG. Never send a raw downloaded buffer straight to rupload — Instagram's server-side transcoder can reject progressive JPEGs / non-sRGB / exotic EXIF with a non-retryable `ProcessingFailedError`.
- PATH B (rupload + configure) must use the SAME shared `HttpsProxyAgent` (`keepAlive: true, maxSockets: 1`) for both calls — different agents can land on different Instagram backend shards, causing "upload id is missing". The `rur` cookie from the rupload response must always overwrite any stale value, never be skipped.

## UI conventions

### Sidebar — Jarvee-style edge-to-edge buttons (artifacts/dannys-bot/src/components/layout/Sidebar.tsx):
- The `<nav>` element and the bottom Settings `<div>` wrapper must have NO horizontal padding (`px-3` insets button backgrounds from the sidebar edges). Buttons use `rounded-none` + `w-full` for edge-to-edge backgrounds. Do not add `px-3` back.

### Account sort persistence (artifacts/dannys-bot/src/pages/ProfilesPage.tsx):
- Sort field, direction, and stable order are stored in `localStorage` (NOT `sessionStorage` — that reset sort on every app restart). Default sort is `"account"` A–Z when nothing is stored.

## Gotchas

54. The DB path resolves from `process.cwd()` — when running via pnpm filter from `artifacts/api-server/`, the DB will be at `artifacts/api-server/database.db`; when run from workspace root it'll be at `database.db`
55. `pnpm approve-builds` needed for puppeteer/sharp/esbuild after fresh installs
56. The `server/` directory at the root is an older standalone server iteration — the active server is in `artifacts/api-server/`
57. Always run `pnpm install --no-frozen-lockfile` when package.json changes don't match lockfile

## Pointers

58. See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

## CI / GitHub Actions — Critical Knowledge

### How the build pipeline works

Every push to `main` triggers `.github/workflows/build.yml` which runs two jobs:

59. **`build-web`** (ubuntu-latest) — installs workspace deps, builds the API server and React frontend, uploads them as an intermediate Actions artifact called `web-builds` (4MB). This is NOT the installer.
60. **`package-windows`** (windows-latest) — downloads `web-builds`, installs Electron deps, runs `build.mjs` to bundle the app, then runs `electron-builder` to produce the Windows installer. It publishes to GitHub Releases AND uploads the installer as an Actions artifact called `Equinox-Windows-Installer` (88MB).

### How the user gets the installer

61. Go to `github.com/dannyshaw88/dannys-bot/actions`
62. Click the latest successful run
63. Scroll to the Artifacts section at the bottom
64. Download **`Equinox-Windows-Installer`** (88MB) — this is the real installer

**Do NOT tell the user to go to the Releases tab.** They have always used the Actions tab. The `web-builds` artifact (4MB) in the same run is just an intermediate build output — not the installer.

### If the user says "the download is only 4MB"

65. They are downloading `web-builds` instead of `Equinox-Windows-Installer`. Both appear in the Actions artifacts list. Point them to the correct one. Do NOT suggest the Releases page.

### If the Equinox-Windows-Installer artifact is missing from the Actions tab

66. The upload step at the end of `package-windows` in `build.yml` is missing or broken. It should look like:

```yaml
- name: Upload installer to Actions artifacts
  uses: actions/upload-artifact@v4
  with:
    name: Equinox-Windows-Installer
    path: artifacts/electron/release/*.exe
    if-no-files-found: error
```

### Auto-updater (for the installed app checking for updates)

67. The installed app uses `electron-updater` with `setFeedURL` pointing to this private GitHub repo. It requires a GitHub token (`UPDATER_TOKEN` secret) baked in at build time via `DANNY_BOT_UPDATER_TOKEN` env var → `build.mjs` esbuild define → `__UPDATER_TOKEN__` in `main.ts`. Without this token the updater gets 404 on private repo release assets.
68. The `package-windows` job also sets `GH_TOKEN: ${{ secrets.UPDATER_TOKEN }}` so `electron-builder --publish always` can create/update GitHub Releases (which the auto-updater reads from).

### Key secrets required

69. `UPDATER_TOKEN` — GitHub personal access token with `repo` scope. Used for: publishing releases (`GH_TOKEN`) and baking into the app for auto-update auth (`DANNY_BOT_UPDATER_TOKEN`).

### pnpm install quirks in CI

70. Ubuntu CI must use `pnpm install --no-frozen-lockfile --ignore-scripts` (pnpm v11 requires `--ignore-scripts` to avoid build script failures in CI)
71. Windows CI uses plain `npm install` inside `artifacts/electron/` (not pnpm)
72. Vite frontend build requires `REPL_ID: ci` env var to output to `artifacts/dannys-bot/dist/public` (the path electron-builder expects)

### Always push workflow changes as a single commit

73. **NEVER push to GitHub unless the user explicitly instructs it.** Make all code changes locally first. Only run the Git push script when the user says to push / ship / release.

74. Multiple file pushes to GitHub trigger multiple CI runs. Use the GitHub Contents API (or Git Trees API) to batch all file changes into one commit. The user explicitly cares about this.

### Version bumping — REQUIRED on every push

Every push to GitHub **must** include a version bump in `artifacts/electron/package.json`.

75. Current version: **v1.1.380**
76. Increment the **patch** number (third digit) by 1 for each push: e.g. `1.1.360` → `1.1.361`
77. The version string in `package.json` (`"version": "1.0.XXX"`) is what `electron-builder` bakes into the installer and what the auto-updater compares against
78. Include `artifacts/electron/package.json` in every batch push alongside the other changed files
79. Do NOT skip the version bump even for small/doc-only changes

### What's New changelog — REQUIRED on every push

Every push **must** also include a new entry at the top of the `CHANGELOG` array in `artifacts/dannys-bot/src/pages/Dashboard.tsx`.

80. The `version` field must match the new version number in `artifacts/electron/package.json` (e.g. `"1.1.361"`)
81. The `date` field should be today's date in plain format (e.g. `"15 May 2026"`)
82. Write `items` in plain English — no technical jargon, no variable names, no internal references. Describe what changed from the user's perspective.
83. One item per visible change. Keep each `text` to a single concise sentence.
84. Include `artifacts/dannys-bot/src/pages/Dashboard.tsx` in every batch push alongside the other changed files.

## Fingerprint Noise Entropy Rule (non-negotiable, fixed 6 Jul 2026)

**Every per-account fingerprint noise value (canvas pixel-flip index, audio LCG seed, or any future noise/salt value used to differentiate accounts) must be generated with full 32-bit entropy and used directly, with no lossy modulo/multiplier transform in between.**

- Confirmed bug: `canvasNoise` was `(randomBytes(1)[0] % 253) + 2` (1 byte → 253 values total) and `audioNoise` was a tiny float (`1e-7`–`9e-7`) that a downstream `Math.round(_AN*1e7)` collapsed to ~9 distinct integer seeds. At low account counts this was invisible; at thousands of accounts it meant many accounts shared an identical canvas/audio fingerprint — a stronger cross-account correlation signal than a shared desktop UA string.
- Fix: generate as a full unsigned 32-bit integer (`randomBytes(4).readUInt32BE(0) >>> 0 || 1` in Node, `Math.floor(Math.random()*4294967295) || 1` in injected browser-context scripts) and use it directly as the index/seed — never re-derive it through `% smallNumber` or `Math.round(tinyFloat * multiplier)`.
- This must be applied consistently everywhere the fingerprint is generated: `browserFingerprint.ts` (`generateEbFingerprint()`), `ebManager.ts`'s injected-script fallback generator AND its "ghost browser" per-signup block, and `GhostBrowserPanel.tsx`'s `generateGhostFingerprint()`. All four must stay in sync — fixing only one silently reintroduces the collision at scale via the other three.
- Desktop Chrome UA strings are frozen post-Chrome-100 (major version + OS is the only real variation) — do not try to manufacture "more unique" UA strings than realistic (Chrome version) x (OS) combinations allow; that itself is a stronger fingerprinting tell. True per-account uniqueness at scale must come from the deep fingerprint surface (canvas/audio/WebGL/font/media-device IDs), not the UA string.
