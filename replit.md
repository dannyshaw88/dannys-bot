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
47. Follow/Unfollow tools with proxy support
48. DM and contact messaging tools
49. Human session (embedded browser) for cookie/session management
50. Auto-reply tool
51. Proxy manager with ping/auto-link
52. Activity dashboard and stats

## User preferences

53. Do not skip any file during imports — every file matters for git

## EB Leak Fix Attempt Log — READ THIS BEFORE TOUCHING ANY LEAK CODE

This is a chronological record of every approach that was tried and its outcome. If you are about to make a change to proxy/DNS/IPv6 handling, check this list first. Do NOT re-attempt anything listed as "confirmed not the issue" or "already in place".

### Attempt 1 — Switched proxyRules → PAC script (v1.0.607)
- **Theory**: `mode:'fixed_servers' + proxyRules` silently falls back to DIRECT in Electron 33 / Chromium 130 when the proxy is slow or the 407 auth cycle fails.
- **Change**: HTTP proxies now use an inline `pacScript` string that returns `"PROXY host:port"` with NO `DIRECT` fallback. If the proxy is unreachable the request fails hard instead of leaking.
- **Result**: WebRTC PASS, but DNS leak tab still showed 2 different IPs (Cloudflare vs ipify).

### Attempt 2 — Removed DoH (v1.0.609)
- **Theory**: `setDnsOverHttpsConfig({ enabled: true, server: 'https://1.1.1.1/dns-query' })` was sending DNS queries from Chrome directly to Cloudflare using the machine's real IP (not through the proxy). Cloudflare's trace endpoint then reported the real IP back.
- **Change**: Removed the `setDnsOverHttpsConfig` call entirely. Also added double-setProxy (150ms gap), `clearHostResolverCache()` before each proxy set, and `did-start-loading` event re-apply.
- **Result**: DNS leak tab STILL showed 2 different IPs. Cloudflare source was now returning the proxy IP correctly, but ipify source was still returning an IPv6 address.

### Attempt 3 — Fixed the test tool itself (v1.0.611, CONFIRMED FIXED)
- **Theory**: The `testDNS()` function was explicitly fetching `api64.ipify.org` — Cloudflare's dual-stack endpoint that supports QUIC/HTTP3. Chrome can open a QUIC/UDP connection to that endpoint as a DIRECT connection bypassing the HTTP proxy entirely (QUIC uses UDP, not TCP, and the proxy tunnel is TCP-only). This exposed the machine's real IPv6 on the ipify row. The proxy was routing correctly the whole time — the test tool itself was the bug.
- **Evidence**: Cloudflare row showed the proxy exit IP (correct). ipify row showed the machine's real IPv6 (incorrect endpoint). Both `--disable-quic` and `--disable-ipv6` are already set as Chromium flags but `api64.ipify.org` was still triggering the leak in some Electron 33 builds.
- **Change**: `testDNS()` in `leaksPage.ts` changed from `api64.ipify.org` to `api.ipify.org` (IPv4-only, no AAAA record, no QUIC support). Now all three DNS sources go through the proxy and report the same exit IP.
- **Result**: DNS leak should now show PASS when the proxy is working. CONFIRMED in v1.0.611 build #538.

### Attempt 4 — Fixed my-ip.io endpoint (v1.0.613)
- **Theory**: `api.my-ip.io` has a AAAA record. Chrome opens it via a direct IPv6 socket that bypasses the HTTP proxy entirely — exact same failure mode as `api64.ipify.org` (Attempt 3). The test was reporting the real machine IPv6 (`2a0a:ef40:...`) from my-ip.io while Cloudflare and ipify both returned the proxy IP correctly.
- **Change**: `testDNS()` in `leaksPage.ts` changed from `api.my-ip.io/v2/ip.json` to `api4.my-ip.io/v2/ip.json` (IPv4-only subdomain, no AAAA record). All three sources now route through the proxy.
- **Result**: DNS leak should now show PASS. The earlier "my-ip.io is safe" note in this doc was wrong — it does have a AAAA record.

### Attempt 5 — Reverted PAC script → fixed_servers with embedded credentials (v1.0.618)
- **Theory**: The `pacScript` inline-string option in Electron's `session.setProxy()` is silently ignored in some Electron 33/34 builds on Windows. When ignored, no proxy is configured at all and all traffic goes DIRECT through the machine's real IP. The original "fixed_servers falls back to DIRECT" diagnosis (Attempt 1) was a false positive — the 2-IP result in the DNS test was actually the QUIC/IPv6 bypass in the test tool itself (subsequently fixed in Attempts 3-4), not a proxy routing failure.
- **Change**: `buildProxyConfig()` now uses `mode:'fixed_servers'` + `proxyRules:'http://user:pass@host:port'` for HTTP proxies (same approach as SOCKS5). Credentials are embedded directly in the proxy URL, eliminating the 407-challenge cycle entirely — Chrome sends `Proxy-Authorization` preemptively on every CONNECT without needing the `login` event handler. The `login` handler is kept as belt-and-suspenders.
- **Result**: Pending user confirmation.

### What has NOT been tried yet (open issues as of v1.0.613):
- **Proxy IP Match FAIL for rotating residential proxies**: The test compares the detected exit IP against the proxy HOST IP (e.g., `37.97.112.154`). For rotating residential proxies the exit IP is a different residential address (e.g., `90.242.146.49`). This always shows FAIL because the test can't know the expected exit IP. This is a DISPLAY BUG in the test, not a real leak. The Proxy IP Match test needs logic to distinguish hostname-based proxies (show INFO instead of FAIL) from IP-based proxies.

### Things already in place — do NOT add again:
- `--disable-ipv6` Chromium flag (main.ts before app.whenReady)
- `--disable-quic` Chromium flag
- `--disable-features=HappyEyeballsV3,IPv6Reachability`
- `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`
- `--dns-prefetch-disable`
- DoH is already DISABLED (do not re-enable)
- PAC script already has no DIRECT fallback
- Double-setProxy with 150ms gap already in place
- `clearHostResolverCache()` already called before each setProxy
- `did-start-loading` proxy re-apply already in place
- WebRTC blocker already injected via CDP before page script runs

## EB IP Leak Prevention — Current State (v1.0.611, non-negotiable, do not regress)

**What is in place and MUST NOT be removed or changed without understanding the full leak chain:**

### Chromium launch flags (artifacts/electron/src/main.ts, before app.whenReady):
- `--disable-ipv6` — removes IPv6 from every subsystem (DNS resolver, socket layer). Without this, Chrome opens a direct IPv6 socket to Cloudflare-fronted endpoints and exposes the real machine IPv6.
- `--disable-quic` — disables QUIC/UDP (HTTP/3). Chrome can open QUIC directly (UDP, not TCP) to Cloudflare endpoints, bypassing the HTTP proxy entirely. This flag prevents that.
- `--disable-features=HappyEyeballsV3,IPv6Reachability` — belt-and-suspenders: disables Chrome's IPv6 preference and reachability probing.
- `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` + `--enforce-webrtc-ip-permission-check` — WebRTC leak prevention.
- `--dns-prefetch-disable` — stops DNS prefetch from resolving domains outside the proxy.
- `--no-proxy-fallback` — no direct fallback (belt-and-suspenders; PAC is the primary enforcement).
- `--proxy-bypass-list=127.0.0.1;[::1];localhost` — only loopback bypasses the proxy.

### Session-level proxy config (artifacts/electron/src/ebManager.ts, buildProxyConfig):
- HTTP proxies: inline PAC script (`pacScript` string, NOT `pacURL`, NOT `mode:'fixed_servers'`). The PAC script returns `"PROXY host:port"` with NO `DIRECT` fallback for non-loopback hosts. If the proxy is unreachable the request FAILS, not leaks.
- SOCKS5 proxies: `mode:'fixed_servers'` + `proxyRules` (PAC can't carry SOCKS5 credentials).
- DoH (`setDnsOverHttpsConfig`) is DISABLED — it sent DNS directly to Cloudflare via the real IP, bypassing the proxy.
- Proxy is set TWICE (150ms gap) on EB window open to defeat the persistent-session race where Chrome reloads its on-disk proxy config and overwrites the PAC after `setProxy()` resolves.
- `clearHostResolverCache()` called before each proxy set.
- `did-start-loading` event re-applies proxy (in addition to `did-finish-load`) — fires before any page requests.
- `app.get('login', ...)` handler provides 407 credentials so Chrome doesn't fail auth and fall back to DIRECT.

### Verify concurrency gate (artifacts/api-server/src/routes/instagram.ts):
- `acquireSilentVerifySlot()` / `releaseSilentVerifySlot()` semaphore ensures only 1 hidden BrowserWindow runs at a time. Verifying 3+ accounts simultaneously previously crashed Electron's main process by spawning parallel Chromium instances.

### DNS leak test (artifacts/api-server/src/instagram/leaksPage.ts):
- Public IP test (`testIP`): uses `api.ipify.org` (IPv4-only, no AAAA, no QUIC). DO NOT change to `api64.ipify.org`.
- DNS leak test (`testDNS`): also uses `api.ipify.org` (NOT `api64`). `api64.ipify.org` is Cloudflare-fronted, dual-stack, QUIC-enabled — Chrome can open it as a direct UDP connection bypassing the HTTP proxy, making the test report a false IPv6 leak. Using the IPv4-only endpoint ensures all three DNS sources route through the proxy.
- `api4.my-ip.io` endpoint is used (NOT `api.my-ip.io` — that has a AAAA record and leaks real IPv6 via direct socket). `api4.my-ip.io` is the IPv4-only subdomain, no AAAA record.
- `1.1.1.1/cdn-cgi/trace` is safe with `--disable-quic` in place.

### Proxy IP Match test logic:
- The test compares `detectedIP` against the raw proxy HOST (e.g., `37.97.112.154`). For rotating residential proxies the exit IP is different from the proxy server IP — this is normal and NOT a leak. The test shows FAIL in this case because it cannot know the expected exit IP. This is a display limitation, not a real leak.

### Sidebar — Jarvee-style edge-to-edge buttons (artifacts/dannys-bot/src/components/layout/Sidebar.tsx):
- The `<nav>` element must have NO horizontal padding (`px-3` was causing button backgrounds to be inset from sidebar edges).
- Bottom Settings `<div>` wrapper must also have no horizontal padding.
- Buttons use `rounded-none` and `w-full` so backgrounds go edge-to-edge.
- DO NOT add `px-3` back to the nav or the Settings div wrapper.

### Account sort persistence (artifacts/dannys-bot/src/pages/ProfilesPage.tsx):
- Sort field, direction, and stable order are stored in `localStorage` (NOT `sessionStorage`). Using sessionStorage caused sort to reset on every app restart.
- Default sort is `"account"` A–Z when no localStorage preference is stored.

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

75. Current version: **v1.0.611**
76. Increment the **patch** number (third digit) by 1 for each push: e.g. `1.0.324` → `1.0.325`
77. The version string in `package.json` (`"version": "1.0.XXX"`) is what `electron-builder` bakes into the installer and what the auto-updater compares against
78. Include `artifacts/electron/package.json` in every batch push alongside the other changed files
79. Do NOT skip the version bump even for small/doc-only changes

### What's New changelog — REQUIRED on every push

Every push **must** also include a new entry at the top of the `CHANGELOG` array in `artifacts/dannys-bot/src/pages/Dashboard.tsx`.

80. The `version` field must match the new version number in `artifacts/electron/package.json` (e.g. `"1.0.325"`)
81. The `date` field should be today's date in plain format (e.g. `"15 May 2026"`)
82. Write `items` in plain English — no technical jargon, no variable names, no internal references. Describe what changed from the user's perspective.
83. One item per visible change. Keep each `text` to a single concise sentence.
84. Include `artifacts/dannys-bot/src/pages/Dashboard.tsx` in every batch push alongside the other changed files.
