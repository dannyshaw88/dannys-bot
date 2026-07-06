# Changelog

All notable changes to Danny's Bot (Equinox) are documented here.

---

## [1.1.372] — 2026-07-06

### Fixed — Desktop (non-mobile) accounts leaked the real host machine's Client Hints, identical across every account and mismatched with the declared UA

**Symptom:** found via a side-by-side leak-test comparison of two accounts with completely different declared browser UAs (one Mac, one Linux) — both reported byte-for-byte identical `Sec-CH-UA-Platform` ("Windows"), `Architecture` ("arm"), `Platform-Version` ("15.0.0"), and `Bitness` values, despite neither account's UA string claiming to be Windows at all.

**Root cause:** every desktop (non-mobile) `Emulation.setUserAgentOverride` CDP call in `ebManager.ts` (main EB window open, Mode-B silent-window arming, and the login-flow override) only built a full `userAgentMetadata` object for the **mobile** branch. For desktop UAs, no `userAgentMetadata` was ever passed, so Chromium fell back to computing `navigator.userAgentData` / `Sec-CH-UA-*` from the **real host machine** it's running on — not from the account's assigned browser identity. Two consequences:
1. Every desktop-UA account running on the same physical machine reported identical Client Hints regardless of proxy/canvas/audio/UA uniqueness — a hard cross-account correlation signal.
2. Those leaked values didn't even match the account's own declared UA (UA said Macintosh/Linux, Client Hints said Windows) — a classic automation tell, since real browsers always keep Client Hints in sync with the UA string.

**Fix:** added `buildDesktopUAMetadata()`, which derives `platform`/`navigatorPlatform`/`architecture`/`platformVersion`/`bitness` from the account's declared `browserUA` string (macOS UA → `platform: "macOS"`, realistic macOS version + arm/x86 architecture; Linux UA → `platform: "Linux"`; Windows UA → `platform: "Windows"` with a Win10/Win11-realistic platform version), varied deterministically per-account via a hash of the UA string itself so different accounts don't collide either. Applied at all three desktop CDP override call sites.

**Note for existing accounts:** this only affects the Client Hints computed at EB-open time going forward — it does not retroactively change canvas/audio noise already stored for existing profiles from before the v1.1.370 entropy fix. If a leak test still shows two older accounts sharing an identical canvas/audio hash, use **Reset Device IDs** on those specific accounts to regenerate a fresh, full-entropy fingerprint.

---

## [1.1.371] — 2026-07-06

### Fixed — Leak-test "Canvas Protection" / added "Audio Protection" always showed a hardcoded label, never reflected real state

**Symptom:** a user comparing leak-test screenshots noticed the Canvas Fingerprint card always read "Canvas Protection: No noise detected", even on accounts where the v1.1.370 full-entropy canvas noise fix was confirmed active in code. This looked like a regression, but was actually a pre-existing display bug: `testCanvas()` in `leaksPage.ts` had `row('Canvas Protection', 'No noise detected')` — a **hardcoded string literal**, not a real check. It never queried whether the canvas noise hook was actually installed; it always printed the same negative label regardless of the true state.

**Fix:** `testCanvas()` now detects whether `HTMLCanvasElement.prototype.toDataURL`/`toBlob` have actually been patched by the fingerprint hook, by checking whether they still stringify to `"[native code]"` (an un-hooked native method always does; our hook replaces it with a real function body, so the absence of `"[native code]"` is a reliable positive signal). The card now correctly shows "Noise active (hooked)" in green when protection is genuinely running, and "No noise detected" in red only if it truly isn't. Added the same real check as a new "Audio Protection" row on the Audio Fingerprint card (previously had no protection-status row at all), checking `AnalyserNode.prototype.getFloatFrequencyData`.

**Why this matters:** this was purely a reporting bug, not a protection bug — the canvas/audio noise from v1.1.370 was already active and working correctly on every account (confirmed via `toDataURL`/`toBlob` hook inspection). But a leak-test page that shows "No noise detected" unconditionally is worse than showing nothing, since it actively tells the operator their protection is off when it is not — undermining trust in every other (accurate) card on the same page.

---

## [1.1.370] — 2026-07-06

### Fixed — Canvas/audio fingerprint noise collapsed to ~253 / ~9 distinct values at scale (thousands-of-accounts blocker)

**Symptom:** at low account counts the per-account browser fingerprint (canvas noise pixel-flip index, audio-context LCG noise seed) looked randomized enough to pass manual review. At the scale the platform is meant to run at — thousands of Instagram accounts — the noise generators were revealed to have far less entropy than they appeared to:

- `canvasNoise` was generated as `(randomBytes(1)[0] % 253) + 2` — a **single byte** reduced mod 253, so only **253 distinct values** existed across the entire account base. Past ~253 accounts, canvas fingerprints necessarily started repeating.
- `audioNoise` was generated as a tiny float in the range `1e-7`–`9e-7`, then downstream code did `Math.round(_AN * 1e7)` to turn it into an integer LCG seed before iterating the audio buffer. `Math.round` on values in that narrow a float range collapses to only **~9 distinct integer seeds** (1 through 9) — a catastrophic entropy loss on top of an already-narrow range. Every account fell into one of 9 audio-fingerprint buckets, independent of how many accounts existed.

Both are the deep-fingerprint-surface signals Instagram's device-clustering can use to link accounts even when the sessionid, proxy, and user-agent are all otherwise correct and unique per account — a 253-value canvas index and a 9-value audio seed are a much stronger multi-account correlation signal than a shared desktop Chrome User-Agent string ever is.

**Fix — full 32-bit entropy for both noise values, used directly (no lossy multiplier):**

- `canvasNoise` and `audioNoise` are now both generated as full unsigned 32-bit integers (`randomBytes(4).readUInt32BE(0) >>> 0 || 1`, or the `Math.random() * 4294967295` equivalent in browser-context injected scripts where Node's `crypto` isn't available) — ~4.29 billion possible values each, applied identically across every fingerprint generation site.
- The downstream `Math.round(_AN * 1e7)` multiplier step — the actual source of the 9-value collapse — was removed entirely. The stored 32-bit integer is now used directly as the audio LCG seed (`var _as = _AN|1`), matching how the canvas noise index (`_CN`) was already being used directly without a lossy transform.
- Fixed in all four places this fingerprint is generated, so there is no remaining code path that can silently regress to the old low-entropy generator:
  1. `artifacts/api-server/src/instagram/browserFingerprint.ts` — `generateEbFingerprint()`, the real per-account generator used for every profile's stored `ebFingerprint`.
  2. `artifacts/electron/src/ebManager.ts` — the injected-script fallback fingerprint generator (used when a profile has no stored `ebFingerprint` yet) and all 3 call sites in the audio-fingerprint hook that previously did `Math.round(_AN*1e7)|1`.
  3. `artifacts/electron/src/ebManager.ts` — the "ghost browser" per-signup fingerprint block (`_gpCN`/`_gpAN`), which re-randomizes canvas/audio noise fresh for every signup session inside the ghost-browser flow.
  4. `artifacts/dannys-bot/src/pages/GhostBrowserPanel.tsx` — `generateGhostFingerprint()`, the frontend preview/generator used by the Ghost Browser panel UI.

### Changed — Desktop Chrome User-Agent pool expanded from 26 to ~114 realistic combinations, generated programmatically

The desktop UA pool (used for accounts with "Disable API" browser-only mode) previously hard-coded 26 entries: 13 Chrome major versions x 2 OSes (Windows, macOS). Expanded to a programmatically generated pool covering Chrome major versions 100–137 (~38 versions) x 3 OS platform strings (Windows, macOS, Linux) = ~114 combinations, built from a small generator function in `artifacts/api-server/src/shared/userAgents.ts` instead of a hand-maintained literal array.

**Why this isn't pushed further, and why that's by design, not a limitation:** since Chrome's User-Agent freeze (Chrome 100+), the desktop UA string itself carries almost no real entropy — every genuine Windows Chrome install on a given major version sends the exact same string (`Chrome/136.0.0.0`, never a real build/patch number), and the same is true for macOS and Linux. The only way to list more "unique" desktop UAs than (Chrome major versions) x (OS platform strings) would be to fabricate UA strings that no real Chrome browser has ever actually sent — which is a *stronger* fingerprinting tell than reusing a real, common one, since it's a string that doesn't exist in the wild.

For genuine uniqueness at thousand-and-up account scale, the UA string was never meant to be the differentiator — the fix above (32-bit canvas/audio entropy, applied per-account) plus the existing WebGL vendor/renderer rotation, per-account font seed, and per-account media-device IDs are what actually carry enough entropy (32–128 bits each) to keep accounts from colliding, independent of how many other real Chrome users share the same UA string.

---

## [1.1.368] — 2026-07-06

### Fixed — Font fingerprint WARN: "Illegal invocation" root cause + javaEnabled override

**Font Fingerprint card still showing WARN after v1.1.367:**

The v1.1.367 fix added a `document.createElement('canvas')` fallback for when `OffscreenCanvas.getContext('2d')` returns `null`. That fixed one failure mode, but the real-world failure was different: `OffscreenCanvas.getContext('2d')` was **succeeding** — returning a valid `OffscreenCanvasRenderingContext2D` — which is a **completely separate class** from `CanvasRenderingContext2D` in Blink's implementation. They share no prototype inheritance. The hook stored `_oMT = CanvasRenderingContext2D.prototype.measureText` and then called `_oMT.call(_fpX, text)` with an `OffscreenCanvasRenderingContext2D` as `this`. Chrome throws "Illegal invocation" because the native method's internal [[Call]] validates that `this` belongs to `CanvasRenderingContext2D`.

The null-guard `if(!_fpX)return r` was irrelevant — `_fpX` was **not null**, it was the wrong type.

**Root-cause fix — `_fpMT = _fpX.measureText.bind(_fpX)` pattern:**

Rather than calling the hooked prototype method on `_fpX`, we now capture the native `measureText` bound directly to `_fpX` **before** the hook replaces the prototype method:

```js
var _fpX = null;
try { var _fpC = new OffscreenCanvas(400,40); _fpX = _fpC.getContext('2d'); } catch(_fe) {}
if (!_fpX) { try { var _fpD = document.createElement('canvas'); ... _fpX = _fpD.getContext('2d'); } catch(_fe2) {} }

// Capture BEFORE hook install — works for any context type
var _fpMT = _fpX ? _fpX.measureText.bind(_fpX) : null;
var _oMT = CanvasRenderingContext2D.prototype.measureText; // ← hook installs next
CanvasRenderingContext2D.prototype.measureText = function(text) {
  ...
  if (!_fpX || !_fpMT) return r;
  _fpX.font = _sz + ' monospace';
  var _bw = _fpMT(text).width;  // ← _fpMT, not _oMT.call(_fpX, text)
  ...
};
```

`_fpMT(text)` dispatches through `_fpX`'s own prototype chain regardless of type — `OffscreenCanvasRenderingContext2D.prototype.measureText` for OffscreenCanvas contexts, `CanvasRenderingContext2D.prototype.measureText` (pre-hook, bound) for document canvas contexts. No cross-prototype call, no "Illegal invocation".

**`navigator.javaEnabled()` still returning `true` after v1.1.367:**

The previous fix used direct property assignment:
```js
navigator.javaEnabled = function() { return false; };
```
This silently fails — the Navigator instance is sealed/frozen in Chromium and `javaEnabled` is non-writable on the instance. The assignment has no effect.

Fix: patch the prototype directly:
```js
Object.defineProperty(Navigator.prototype, 'javaEnabled', {
  value: function() { return false; }, writable: true, configurable: true
});
```
This correctly overrides the method for all `navigator.javaEnabled()` calls.

---

## [1.1.367] — 2026-07-06

### Fixed — Leak-test page: async cards frozen in "Fetching…" / "Running…" forever

**Symptom (visible):** Opening the leak-test page left five cards permanently stuck:
- **Public IP** — "Fetching…" spinner, never resolves
- **WebRTC Leak** — "ICE Gathering: Running…", never resolves
- **DNS Leak** — "Status: Running…", never resolves
- **Battery API / Media Devices / Permissions / Client Hints** — never even start; badge stays on the initial "Pending" spinner from the static HTML

Three other dependent cards (Proxy IP Match, also shown waiting) were similarly stuck because they feed from the IP result.

Cards that always worked correctly (User Agent Match, Bot Detection, Timezone, Navigator, Screen & Hardware, Canvas Fingerprint, Audio Fingerprint, WebGL / GPU, Network Info, Speech Synthesis, Timing Precision) were unaffected — these are the synchronous tests that run before the async section.

**Root cause — two-part:**

**Part 1 (ebManager.ts — stealth font hook):**
The font-fingerprint spoof installed by `applyStealthScripts()` hooks `CanvasRenderingContext2D.prototype.measureText` and, when it sees a call with a controlled font string, uses a private `OffscreenCanvas` context (`_fpX`) to measure the monospace baseline width so it can decide whether to pass the real width through or spoof it.

`_fpX` is created once at hook-install time with:
```js
var _fpC = new OffscreenCanvas(400, 40), _fpX = _fpC.getContext('2d');
```
In some Chromium sandbox configurations (e.g. certain Electron session contexts), `getContext('2d')` returns `null`. The hook stored that `null` in `_fpX` but never checked for it. On the first call with a controlled font, the hook tried:
```js
var _bw = _oMT.call(_fpX, text).width;  // _fpX is null → TypeError: Illegal invocation
```
This `TypeError` propagated out of `measureText`, up through `testFonts()` (which had no try/catch), and — because `testFonts()` is called inside `runAll()`, an `async` function — the uncaught synchronous throw converted into a rejected promise. The async function stopped executing at that point.

**Part 2 (leaksPage.ts — runAll() crash kills entire async tail):**
`runAll()` runs all synchronous tests first (lines 1–11), then starts the async section with `await withTimeout(() => testIP(), …)`. `testFonts()` was the 12th and last synchronous test called. Its throw at step 12 killed `runAll()` before it ever reached `testIP()`, `testWebRTC()`, or the `Promise.all([testDNS, testAudio, testBattery, testMedia, testPermissions, testClientHints])` block. Every card in those groups stayed frozen in its initial static-HTML state — exactly what was seen.

The font card itself showed: badge reset to "PENDING" text (the reset block ran successfully at the top of `runAll()`), but body left blank (the throw happened inside `testFonts()` before `body.innerHTML` was set), and no completion badge.

**Fixes applied — three layers:**

**1. ebManager.ts — null guard on `_fpX` in the `measureText` hook:**
```js
// Before (crashes if OffscreenCanvas context unavailable):
_fpX.font = _sz + ' monospace';
var _bw = _oMT.call(_fpX, text).width;

// After (falls back gracefully):
if (!_fpX) return r;   // ← new guard
_fpX.font = _sz + ' monospace';
var _bw = _oMT.call(_fpX, text).width;
```
When `_fpX` is null, the hook now returns the real (unmodified) measurement result instead of crashing. The font fingerprint spoof is effectively disabled for that account session, which is the safest possible degradation — the alternative was breaking the entire leak test.

**2. leaksPage.ts — try/catch inside `testFonts()`:**
Wrapped the entire canvas-creation + font-measurement block in a try/catch. If the canvas API throws for any reason, the font card now shows a "Canvas API error — \<message\>" row with a WARN badge and calls `setResult('Fonts', 'warn', 'Error')` so the overall score still finalises. No exception escapes the function.

**3. leaksPage.ts — per-test try/catch in `runAll()` sync block:**
Changed the bare list of sync test calls into a guarded loop:
```js
// Before — one uncaught throw kills everything after it:
testFonts();

// After — each test isolated; one failure logs to console, suite continues:
var _syncTests = [['Fonts', testFonts], …];
for (var _si = 0; _si < _syncTests.length; _si++) {
  try { _syncTests[_si][1](); }
  catch (e) { console.error('[leak-test] sync test "' + _syncTests[_si][0] + '" threw:', e); }
}
```
This ensures that even if a future sync test regresses, the async tests (IP, WebRTC, DNS, Battery, Media, Permissions, Client Hints) always run.

---

## [1.1.366] — 2026-07-06

### Security — Critical: regular EB window forced a fake desktop device on top of the account's real mobile identity

**This was a live, ongoing ban cause confirmed via the in-app leak test.**

#### Root cause
`openEbWindow()` in `artifacts/electron/src/ebManager.ts` — the function behind the main, regular account EB window used for every human session and manual browsing action — contained a blanket rule: whenever an account's assigned identity was a mobile user agent, the window silently swapped it for a generic Windows desktop Chrome user agent instead, so Instagram would render its full desktop web UI (sidebar, Make-a-Post "Next" button, etc).

This ran on every regular window open — the majority of an account's live session time — while three other surfaces continued using the account's REAL assigned mobile identity (e.g. an Android 13 OnePlus CPH2449 device) for the exact same session cookies:
- `verifyInstagramCredentials()` — the mobile API verification call
- The mobile API client used for automated follow/unfollow/DM actions
- The Mode-B silent background windows (`/eb/silent-follow`, `/eb/silent-post`, `/eb/silent-search`)

Instagram therefore saw ONE session token being presented from two completely different devices depending on which part of the app touched it in a given moment — a strong automated-abuse / session-hijack signal that Instagram's systems are specifically built to detect and act on with bans, independent of whether the proxy and IP were correct.

#### Fix
Removed the desktop-UA override entirely. Regular EB windows now always present the account's real assigned device identity, matching every other surface that uses that account's session. The window itself is unchanged in size — only the identity it reports to Instagram no longer gets swapped.

**Trade-off, accepted deliberately:** the regular EB window will now show Instagram's mobile web layout (not desktop) for accounts assigned a mobile identity. The automated Make-a-Post flow's primary path (the off-screen background window) was never affected by this bug and is unchanged; its click-detection already tolerates different Instagram UI layouts.

### Fixed — Leak-test page could hang indefinitely on some cards

**Symptom:** on the leak-test screen, Public IP / Proxy IP Match / WebRTC Leak / DNS Leak could get stuck on "Fetching…/Running…" forever, and Battery API / Media Devices / Permissions / Client Hints would never even start (stuck on the initial "Pending" badge).

**Root cause:** the test runner checks Public IP first, then runs the rest of the tests together afterward. The Public IP check already had its own 8-second timeout, but if the assigned proxy accepted a connection and then never finished authenticating, that timeout could fail to actually cancel the request in some cases — leaving the whole test run stuck waiting on it forever, so none of the later tests ever ran.

**Fix:** added a second, independent 12-second safety timer around every test in the run sequence. Even if a test's own internal timeout fails to fire, the safety timer now forces the suite to move on so every card always finishes with a real result instead of hanging forever.

### Maintenance — Consolidated duplicate GitHub Actions workflows

Four nearly-identical Windows-installer build workflows (`build.yml`, `build-windows-installer.yml`, `release.yml`, `windows-installer.yml`) had accumulated over time, with `build.yml` triggering on every push to `main` — meaning every push kicked off duplicate, redundant installer builds. Consolidated into a single canonical workflow, `build-windows-installer.yml` (triggers on push to `main` and manual dispatch). The other three are kept as inert, trigger-less stubs (this environment could not delete tracked files) pointing back to the canonical workflow — do not add triggers back to them.

---

## [1.1.365] — 2026-07-05

### Security — Hard abort if no proxy configured on mode-B automation windows

**Rule:** Every account MUST route through its assigned proxy. If no proxy is present or proxy setup fails, the action is aborted immediately. There is no fallback to the real IP — ever.

Three mode-B temp windows previously had soft `if (bodyProxy?.host && bodyProxy?.port)` guards that silently skipped `session.setProxy()` and allowed the window to open on the machine's real home IP when:
- No proxy was provided in the request body
- The `eb-proxy` fetch failed (network error to localhost)
- `setProxy()` threw an exception

Additionally, `spTempWin` had a `useHomeIp` bypass (`if (pd.proxy && !pd.useHomeIp)`) that could intentionally skip proxy setup entirely.

**All three windows now have hard aborts:**

| Window | Condition | Response |
|---|---|---|
| `sfTempWin` (`/eb/silent-follow`) | No `bodyProxy.host`/`port` | HTTP 400 — action dead |
| `sfTempWin` | `setProxy()` throws | HTTP 500 — action dead |
| `spTempWin` (`/eb/silent-post`) | `eb-proxy` fetch fails or returns no proxy | HTTP 500 — action dead |
| `spTempWin` | `setProxy()` throws | HTTP 500 — action dead |
| `ssTempWin` (`/eb/silent-search`) | No `bodyProxy.host`/`port` | HTTP 400 — action dead |
| `ssTempWin` | `setProxy()` throws | HTTP 500 — action dead |

The `useHomeIp` bypass in `spTempWin` was also removed.

---

## [1.1.364] — 2026-07-05

### Security — Critical: Real IP Leak on All Background Automation Actions (Mode B)

#### Root cause

`buildProxyConfig()` for HTTP proxies never embeds credentials in the proxy URL
(`ERR_NO_SUPPORTED_PROXIES` prevents it). Credentials must be supplied at the
Electron level via a `webContents 'login'` event when the proxy responds with a
407 challenge. Without a handler, Electron's own comment states: *"either shows a
dialog or cancels the request, causing a silent fall-through to the home IP."*

Three automation windows that run in the background (Mode B — when the account's
embedded browser is not already open) were created without any `login` event
handler. The proxy's 407 auth challenge was silently cancelled and every request
fell through to the machine's real home broadband IP. Instagram saw hundreds of
actions from the same real IP across all accounts simultaneously — a trivial
account-farm signal — which triggered the mass ban wave.

#### Affected windows and actions

| Window | IPC route | Actions affected |
|---|---|---|
| `sfTempWin` | `/eb/silent-follow` | All background follows and unfollows |
| `spTempWin` | `/eb/silent-post` | All background Make-a-Post / Repost |
| `ssTempWin` | `/eb/silent-search` | All background user-search lookups |
| `leakWin` | `/eb/run-leak-test` | Leak test results reflected real IP, not proxy |

Mode B runs whenever the account's EB is not already open — which is the normal
state during scheduled automation. This meant **every single background action**
for every account leaked the home IP.

#### Fix

Added `webContents.on('login', ...)` handlers to all four windows immediately
after `showInactive()` / `new BrowserWindow()`. Each handler calls
`event.preventDefault()` and supplies the account's proxy credentials from the
request context (`bodyProxy` for silent-follow and silent-search; a hoisted
`_spProxyCreds` variable for silent-post; `ebMap.get(pid)?.proxy` for leakWin).

This matches the pattern already used correctly on the main EB window
(`win.webContents.on('login', ...)` at line ~2766), tab BrowserViews
(`tabView.webContents.on('login', ...)`), and the silent-verify hidden window
(`_hiddenWin.webContents.on('login', ...)`).

#### Previously unaffected (no action needed)

- Main EB window — had `login` handler, correct
- Tab BrowserViews — had `login` handler, correct
- Silent-verify `_hiddenWin` — had `login` handler, correct
- SOCKS5 proxies — credentials embedded directly in `proxyRules` URL, no 407 cycle

---

### Fixed — Ghost/verify browser UA used hardcoded `Chrome/131` regardless of Electron build

`apiUAToBrowserUA()` converted Instagram API-format user agents
(`34/14; 420dpi; 1080x2340; ...`) to browser UAs for ghost browser and verify
windows. It always emitted `Chrome/131.0.0.0` regardless of which Chromium version
was actually bundled with the running Electron build.

**Effect:** Every ghost browser window and every verify window advertised the same
Chrome major version string. If the running Electron ships Chromium 130 or 132,
the advertised version was wrong. Instagram's fingerprinting compares the UA string
against the CDP `Emulation.setUserAgentOverride` `userAgentMetadata` — a mismatch
is an immediate bot signal.

**Fix:** `apiUAToBrowserUA()` now derives the Chrome major from
`process.versions.chrome` (the actual Chromium version bundled in this Electron
build) instead of a hardcoded literal. The fallback remains `"131"` when
`process.versions.chrome` is unavailable (e.g. unit test environments).

---

### Fixed — ip-api.com timezone lookup exhausted 1,000 req/day free quota, causing all-accounts timezone fallback to machine's real timezone

Every `openEbWindow` call made one HTTP request to `ip-api.com` to resolve the
proxy's timezone. With 50+ accounts, each EB-open event consumed one request.
Opening all accounts in a session exhausted the 1,000 req/day free tier; every
subsequent account silently fell back to the machine's real system timezone instead
of the proxy's timezone.

**Effect:** All accounts opened after the quota was hit presented the machine's
actual timezone (e.g. `America/New_York`) regardless of proxy location. Instagram
cross-references the declared timezone (from `Intl.DateTimeFormat` / CDP
`Emulation.setTimezoneOverride`) against the account's proxy geolocation. A
mismatch between the proxy's region and the timezone is a clustering signal linking
all accounts on that machine to the same operator.

**Fix:** Added a process-lifetime `Map<string, string>` cache (`_tzCache`) keyed
by proxy host. The timezone is fetched once per proxy host per app launch and
reused for all subsequent `openEbWindow` calls with the same proxy. Accounts
sharing a proxy host (or the same proxy re-opened) consume zero additional ip-api
requests. Cache is cleared on app restart so a rotated proxy gets a fresh lookup.

---

## [1.1.346] — 2026-07-05

### Fixed

#### Browser human sessions: DOM: undefined / waitFor always times out (silentMode)

Four compounding bugs were causing every silentMode browser action (follow, stories, reels, DMs) to silently fail with `feed waitFor timed out — DOM: undefined`:

1. **useHomeIp never passed to openEbWindow** — Accounts with no proxy but `browserDirectConnection=true` caused `openEbWindow` to throw `[IP-LEAK BLOCKED]` silently (the `/eb/open` endpoint is fire-and-forget and returns 200 regardless). The window was never created; every subsequent `/eb/evaluate` returned 404 → `DOM: undefined` for 20 s. Fixed: `ensureSilentEbOpen` now reads `profile.browserDirectConnection` and passes `useHomeIp: true` when no proxy is configured.

2. **Blind 3 s sleep instead of confirmed window open** — After posting to `/eb/open`, the code slept 3 s and assumed the window existed. Chromium partition init + cookie loading can take longer. Fixed: `ensureSilentEbOpen` now polls `/eb/state` every 500 ms (up to 15 s) and only proceeds once `open: true` is confirmed. Returns `ok: false` if the window never appears.

3. **Double-navigation race in silentMode** — `openEbWindow` fired an initial `loadURL` (STEP-29) as soon as the window opened, then the automation caller immediately fired `goto()` → a second `loadURL`. During the abort/reload transition between the two navigations, `executeJavaScript` resolves `undefined` (no JS context) instead of throwing, so `waitFor()`'s `.catch(()=>false)` never fired — it received `undefined` (falsy) and spun for 20 s before timing out. Fixed: STEP-29 `loadURL` is skipped entirely for `silentMode` windows. The automation's first `goto()` is the only navigation.

4. **EbIpcPage.evaluate() silently swallowed 404** — When the window wasn't open, `/eb/evaluate` returned HTTP 404 `{"error":"no window"}`. The code called `r.json()` without checking `r.ok`, got `{}` (no `result` field), and returned `undefined`. Fixed: throws immediately on non-OK HTTP status so `waitFor`'s `.catch(()=>false)` fires correctly and the session fails fast instead of spinning.

#### goto() navigation wait increased 2500 ms → 4500 ms

Instagram's SPA takes 3–4 s to mount virtualised list nodes (`<article>`, story tray, follow button) after a navigation. The previous 2500 ms sleep caused frequent `waitFor` timeouts on slow proxies or first-load cold pages.

---

## [1.1.326] — 2026-07-04

### Fixed

#### "If 0 Posts → Visit Explore Page" fired on every session regardless of feed content (browser mode)

The browser-only explore block was gated only on `followSuggestedUsersIfEmptyEnabled === true` with no check on whether the feed actually had posts. Now the `viewTimelineFeed` block uses `waitFor('article', 8000)` (polling, not a one-shot query) to detect whether post cards rendered. The result is stored in `feedHadPosts` and the explore block is gated on `!feedHadPosts`. If `viewTimelineFeed` is disabled, `feedHadPosts` defaults to `true` so the explore visit is suppressed.

#### Timeline post likes were logged but nothing was actually clicked (browser mode)

`h.closest("button")?.click()` silently did nothing because Instagram wraps the heart SVG in a `span[role="button"]`, not a real `<button>`. The function still returned `true`, so `liked` was incremented for every attempt even with zero actual clicks. Fixed to use `closest('[role="button"], button')` and only return `true` when that button is actually found. Also dispatches a full `pointerdown → pointerup → click` sequence so React's synthetic event system picks it up.

#### Reel log entry showed no view percentage or duration

"EB watched 1 reel(s) via feed sub-setting" now includes the average view percentage and total watch time, e.g. "EB watched 3 reel(s) · avg 74% view · 31s total", matching the detail level of API-path reel log entries.

### Added

#### "Expand Caption%" sub-setting for View Timeline Feed (browser mode)

New `expandCaptionPercentMin/Max` sub-setting row above the Reel Chance row. When configured, the engine scrolls back through the feed after the main scroll pass and clicks the "… more" button on posts with probability `expandCaptionPercent`%, simulating a user who reads the full caption of posts they find interesting. The button search matches any `[role="button"]` or `<button>` element whose trimmed text ends with "more" (handles ASCII "...", Unicode "…", and locale variants). Logged with Ghost Browser transport.

---

## [1.1.325] — 2026-07-04

### Fixed

#### Human Session Tool — View Timeline Feed sub-settings (Like% and Watch Reels) now actually run in browser/Disable-API mode

**Root causes found and fixed:**

1. **Likes sub-setting was never wired into the browser path.** The `Like%` control in the View Timeline Feed sub-row sets `likeTimelinePostsPercentMin/Max`, but the browser-only `viewTimelineFeed` block only scrolled — it never acted on those settings. Meanwhile, the separate `likeTimelinePostsEnabled` block (which uses a different count-based setting, `likeTimelinePostsMin/Max`) ran independently only when that standalone toggle was also on. Result: `Like%` in the feed sub-settings silently did nothing in browser mode.

2. **Watch Reels was completely absent from the browser path.** Reel watching via `reelWatchChance*`/`reelWatchCount*`/`reelWatchPercent*` only existed inside the mobile-API `viewTimelineFeed` implementation. There was no browser equivalent, so the reels sub-setting never fired regardless of how it was configured.

3. **`waitFor` helper was declared after the `viewTimelineFeed` block.** Moving the helper inside the block would have caused a TDZ `ReferenceError` at runtime. Moved the `waitFor` declaration to immediately after `nav`, before all browser action blocks, so it is available throughout the session.

**What now happens in browser mode with View Timeline Feed enabled:**
- After scrolling the feed, a like pass runs using `likeTimelinePostsPercentMin/Max` (the exact % shown in the UI), computing a proportional like count from `feedCount`. Zero is a valid outcome for low percentages.
- After likes, a reel-chance roll using `reelWatchChanceMin/Max` determines whether to watch reels. If the roll passes, navigates to `instagram.com/reels/`, waits for a video element, then dwells for `reelWatchPercent`% of an estimated reel duration per reel before pressing ArrowDown, repeating `reelWatchCount` times. Both actions are logged with "Ghost Browser" transport.

**Bounds safety:** all `min`/`max` pairs are clamped to `[0, 100]` and swapped if inverted before use, preventing silent no-ops from bad settings.

---

## [1.1.324] — 2026-07-04

### Added

- Copy Settings (Accounts Manager) now includes a "Disable API" toggle in the Browser Actions group, merged into the same single-PATCH `apiLimits` copy block used by the other browser-action settings (avoids the race/stale-overwrite bug and the "Nothing to copy" false toast).
- `logGhostBrowserCall()` helper in `automationEngine.ts` mirrors every browser-driven action into `storage.createInstagramApiCall` with `source: "Ghost Browser"` / `transport: "Ghost Browser"` so these actions appear in the Actions log and CSV export exactly like real API calls.
- `resolveOperationName()` in the `/api/logs/export` CSV route now maps `source === "Ghost Browser"` rows to the correct tool label (Follow Tool / Contact Tool / Human Session Tool) instead of falling back to the raw internal operation name.
- New Human Session browser sub-features: save post (`saveMediaEnabled` + `saveMediaPercent` chance), share post (`sharePostPercentMin`/`sharePostPercentMax` chance), and Explore page visit (`followSuggestedUsersIfEmptyEnabled`) — all wired through the embedded browser and logged via `logGhostBrowserCall`.
- New `runBrowserContactSession()` method wired into the Contact tool's browser-mode delegation path — drives DMs via the embedded browser (navigate to thread or open new DM search, type message, send) instead of skipping accounts with Disable API on.

### Fixed

- Save/Share browser actions previously referenced non-existent setting keys (`vtf_save_media`, `vtf_share_post` and their `_min`/`_max` variants) and used a fixed-count model. Corrected to use the real percent-chance settings (`saveMediaEnabled`/`saveMediaPercent`, `sharePostPercentMin`/`sharePostPercentMax`) matching the mobile-API code path's semantics.
- Story checking, DM checking, and post liking in browser mode previously clicked before the SPA content had hydrated, silently doing nothing. Added `waitForSelector()`-style waits before each interaction.

---

## [1.1.321] — 2026-07-04

### Reverted

- Reverted v1.1.320 sessionGated session-abort on 4415001. The warm-up (NotificationsBadge) from v1.1.319 is retained.

---

## [1.1.320] — 2026-07-04

### Fixed

#### DM inbox 4415001 "Prompt has contribution" — abort session instead of continuing to viewTimelineFeed (`instagramWebClient.ts`, `automationEngine.ts`)

**The real root cause — confirmed from logs:**

The previous fix (adding a `news/inbox` NotificationsBadge warm-up before `direct_v2/inbox`) was based on a wrong hypothesis. Logs show:

```
13:36:13  _buildWarmedIgClient: Phase 2 — news/inbox OK  ← warm-up fires and SUCCEEDS
13:38:34  direct_v2/inbox → HTTP 400 (prompt_required_4415001)  ← STILL fails despite warm-up
13:38:34  @nicks_jackqueline: 💬 checked DMs — opened 0/4 threads (read failed)  ← session CONTINUES
13:41:07  viewTimelineFeed fires
13:41:10  POST /api/v1/feed/timeline/ → HTTP 403 logout_reason:3  ← account force-killed
```

The warm-up (`news/inbox`) does not lift the 4415001 gate. **4415001 "Prompt has contribution" is an account-level state** set by Instagram when there is an in-app prompt (feature intro, birthday info, notification permission request, etc.) waiting for real user interaction. No API call sequence fixes this — the prompt must be dismissed by a human in the actual Instagram app.

**The exact kill sequence:**

Instagram's rule: when a session receives 4415001 from any endpoint, it marks that session as having an unacknowledged prompt. If the app then fires **any further API call** in that session without responding to the prompt, Instagram escalates to `logout_reason:3` (forced server-side session revocation) on the very next request — every time, with no exceptions.

The code was catching 4415001, treating it as a non-fatal soft gate, logging "DM check failed", and then continuing the session queue. The next tool in the queue (`viewTimelineFeed`) fired immediately and received `logout_reason:3`.

**Fix:** When `direct_v2/inbox` returns 4415001, `getDirectMessagesInternal` now returns `sessionGated: true`. The engine checks this flag immediately after the DM check and sets `sessionError` to abort all remaining session tools — `viewTimelineFeed`, stories, reels, and any other queued tools are cancelled. The account is **not** marked as `logged_out` because the session cookies are still valid; only the session run is stopped early.

**How to resolve for the affected account:**

Open the embedded browser for the account, navigate to Instagram, and dismiss whatever prompt Instagram is showing. After that, `direct_v2/inbox` will succeed normally and DM checks will work again.

**Note:** The `news/inbox` warm-up added in v1.1.319 is kept because it matches what the real Instagram app does (check notification badge before opening DMs). It does not cause the 4415001 — that's a separate account-level condition — but it is correct behaviour to include.

---

## [1.1.319] — 2026-07-04

### Fixed

#### DM inbox check — sessions no longer logged out after checking DMs (`instagramWebClient.ts`, `automationEngine.ts`)

**Root cause: missing NotificationsBadge warm-up before the inbox fetch**

When a human session runs and the Check DMs tool fires, the code calls `POST /api/v1/feed/timeline/` (ViewTimelineFeed) immediately after reading the inbox. Instagram was returning `HTTP 403 login_required` with `logout_reason: 3` (server-side forced session revocation) on that timeline call, logging accounts out.

The chain of events:

1. `getDirectMessagesInternal()` calls `mobileSessionGet("/api/v1/direct_v2/inbox/")` — Instagram returns `HTTP 400 error_code 4415001` ("Prompt has contribution" gate).
2. The 4415001 is a soft gate Instagram places on sessions that contact the inbox endpoint without first sending a `news/inbox` (NotificationsBadge) warm-up call. The app was swallowing the 4415001 as non-fatal and continuing to the next tool.
3. `viewTimelineFeed()` fires — Instagram sees an unacknowledged prompt followed by another API call and escalates: `logout_reason: 3`, session force-killed.

The primary `getDirectMessagesInternal()` had an explicit comment — *"no NotificationsBadge warm-up"* — confirming the warm-up was knowingly omitted. The warm-up is the same `news/inbox` call that the real Instagram app makes immediately before opening the DM inbox, which is why skipping it triggers the 4415001 gate.

**What the warm-up does:**  
`_buildWarmedIgClient()` fires `GET /api/v1/news/inbox/` via `mobileSessionGet`. This tells Instagram's backend that the device has checked its notification badge — identical to what the real app does before any inbox access. With the warm-up in place, `direct_v2/inbox` succeeds and 4415001 is never returned.

**Fix:** `getDirectMessagesInternal()` now calls `await this._buildWarmedIgClient()` as Step 1 before the inbox fetch (Step 2). The warm-up result is cached per-session — if `sendDM` or any other call already bootstrapped the client this session, the cache is returned immediately at zero cost with no extra API call.

**Throttle and logging:**  
The warm-up calls `mobileSessionGet`, which always runs `apiThrottle()` first — it counts as a real API call and respects the account's configured throttle (125–250 s). It is logged in the API calls export as `NotificationsBadge / Cold-start warm-up`. This matches how the real Instagram app behaves: it always checks notifications before entering the DM inbox.

**Also reverted:** A previous interim band-aid (`sessionGated` flag on the `getDirectMessagesInternal` return type, plus a `sessionError` abort block in the engine's `checkDm` handler) had been added to prevent further tools running after 4415001. Since the root cause is now fixed and 4415001 will no longer occur, those changes have been fully removed from both `instagramWebClient.ts` and `automationEngine.ts` (primary `src/instagram/` and legacy mirror `src/src/instagram/`).

---

## [1.1.318] — 2026-07-04

### Fixed

#### Browser post (Make-a-Post via browser) — three independent bugs fixed (`ebManager.ts`, `automationEngine.ts`)

**Bug 1 — CDP `DOM.enable` hang causes 120-second timeout on every Mode B attempt**

When `postViaBrowser` is enabled and the embedded browser is not currently open for the account, the handler creates a temporary off-screen window (Mode B). Immediately after creation, before any navigation, the handler attaches a Chrome DevTools Protocol (CDP) debugger and sends a `DOM.enable` command:

```typescript
await dbg.sendCommand("DOM.enable").catch(() => {});
```

The `.catch(() => {})` guard only suppresses promise rejections — it does not handle a *hang*. On a freshly-created Electron `BrowserWindow`, the underlying Chromium renderer is not yet ready to process CDP commands. The promise neither resolves nor rejects; it hangs indefinitely. This consumed the entire 120-second watchdog budget before even attempting to navigate to Instagram.

**Fix:** The `DOM.enable` call is now wrapped in a `Promise.race` with an 8-second timeout. If the renderer is not ready within 8 seconds, the race resolves and execution continues to the navigation step:

```typescript
await Promise.race([
  dbg.sendCommand("DOM.enable").catch(() => {}),
  new Promise(r => setTimeout(r, 8000)),
]);
```

---

**Bug 2 — "Could not find Create button" with collapsed sidebar (Mode A)**

When the embedded browser *is* open (Mode A — reusing the existing EB window), the handler navigates to the Instagram homepage and then searches for the Create (`+`) button using these selectors:

```javascript
// Previous selectors
document.querySelector('[aria-label="New post"], [aria-label="Create"]')
document.querySelector('a[href="/create/"]')
// text span search with offsetHeight > 0 requirement
spans.find(s => s.textContent.trim() === 'Create' && s.offsetHeight > 0)
```

When the left sidebar is in its **collapsed (icon-only) state**, the text spans inside the nav links have `offsetHeight === 0` (they are visually hidden by CSS). The aria-label and href selectors also fail because Instagram's current DOM uses a different structure in this state. The result: `spClickedCreate = false` → error thrown → post fails.

**Fix:** Both the hover step and the click step now use a broader, layered selector chain that works regardless of sidebar state:

1. `[aria-label="New post"], [aria-label="Create"], [aria-label="create"]` — exact label matches
2. `[aria-label*="reate"]` — substring match (catches variants like "Create new post")
3. `a[href="/create/"], a[href*="/create"]` — href-based (partial match)
4. Any `a / [role="link"] / [role="button"] / button` whose `aria-label` or `title` attribute equals `"create"`, `"new post"`, or contains `"create post"`
5. SVG `<title>` child matching `"create"` or `"new post"` (collapsed-icon fallback)

The `offsetHeight > 0` guard is removed from fallback passes since collapsed icon elements are intentionally zero-height in text but still fully interactive.

---

**Bug 3 — Activity log shows generic "Upload failed" instead of the real browser error**

When a browser post fails, the code path reads:

```typescript
// in the local-folder repost failure block
const uploadErr = client.lastUploadError || "Upload failed";
this.logAction(..., `Upload failed for: ${fileName} (${uploadErr})`);
```

`client.lastUploadError` is a field on the Instagram private-API client — it is only populated when an *API-based* upload fails. For browser-post failures, it is always `undefined`, so the fallback `"Upload failed"` is logged every time, hiding the real reason (e.g. `"Browser-post error: The operation was aborted due to timeout"` or `"Could not find Create button in the Instagram left nav — is the account logged in?"`).

**Fix:** A `browserPostErr` variable is captured from `bpResult.message` when the browser post fails, and it is placed first in the fallback chain:

```typescript
let browserPostErr: string | undefined;
// ...
if (!bpResult.ok) {
  browserPostErr = bpResult.message;  // captured here
  console.warn(...);
}
// ...
const uploadErr = browserPostErr || client.lastUploadError || "Upload failed";
```

The activity log now shows the actual error text from the browser automation, making failures immediately diagnosable.

---

## [1.1.311] — 2026-07-03

### Fixed (Critical)

#### Browser-follow completely rewritten to use the existing EB window (`ebManager.ts`)

**The entire two-browser approach was wrong.** The previous implementation created a second hidden `BrowserWindow` with a temp partition for every follow. This was never the intended design — one account, one browser. The existing EB window (`ebMap.get(pid).win`) is already logged in, already has the right proxy and cookies, and is the only browser that should ever act on that account.

**What was broken:** A hidden second window was created, its temp partition was seeded by copying cookies from the live partition, and the proxy was re-configured from scratch. This produced two concurrent browser sessions for the same Instagram account on every follow attempt — an instant automation signal. The `watchdog_timeout` failures followed naturally because Instagram was terminating or rate-limiting the second session.

**Fix:** The `/eb/silent-follow` handler now:
1. Calls `ebMap.get(pid)` — gets the existing open EB window
2. Returns `follow_blocked: "EB not open"` immediately if no window is open for that account (the engine must open the EB first)
3. Remembers `prevUrl` (where the browser was before the follow)
4. Navigates the existing window to `https://www.instagram.com/<targetUsername>/`
5. Checks for login wall / checkpoint
6. Polls for Follow button, clicks via CDP tap (falls back to JS click)
7. Confirms the state changed to Following/Requested
8. Calls `sfWin.webContents.loadURL(prevUrl)` to restore the browser to where it was
9. Returns the result

No new `BrowserWindow`, no temp partition, no cookie seeding, no proxy setup. All of that is already done by the EB open flow.

The watchdog now restores the URL instead of destroying the window. The per-account mutex (`_sfInProgress`) prevents two simultaneous follows on the same window.

---

## [1.1.310] — 2026-07-03

### Fixed

#### `watchdog_timeout` root cause: `capturePage()` with no timeout hanging after dead renderer (`ebManager.ts`)

**This was the actual cause of every `watchdog_timeout — forced cleanup after 80s` follow failure.**

Log evidence (profile 3914, @franc_fitness_journey):
```
20:09:27  START, loadURL ok in 822ms, landed on correct profile page
20:09:28  polling for Follow button
20:09:53  btnInfo outer 25 s timeout fires — "page context likely destroyed"
           [54 seconds of silence]
20:10:47  WATCHDOG fires, error: Object has been destroyed
```

After the btnInfo 25 s outer-race fired (meaning the renderer context was already destroyed), the code fell through to `sfWin.webContents.capturePage()` — a screenshot call with **zero timeout**. Calling `capturePage()` on a destroyed renderer context never resolves or rejects. It simply blocks forever. The 80 s watchdog was the only exit, and the 54 seconds between the outer-timeout warning and the watchdog is exactly the gap between "25 s elapsed" and "80 s total" — confirming capturePage() consumed that entire window.

**Fix**: The `btnInfo` outer-timeout now resolves with `{ found: false, timedOut: true, contextDestroyed: true }`. When that flag is set, the code immediately destroys the window and returns the error — skipping both the `diagInfo` JS eval AND the `capturePage()` screenshot call entirely, since both would hang on a dead renderer. `capturePage()` also now has a 5 s `Promise.race` guard as a belt-and-suspenders fallback for any future code paths where the context state is uncertain.

---

## [1.1.309] — 2026-07-03

### Fixed

#### Electron/EB logs now appear in the API server log file (`ebManager.ts`)

**Problem**: The Electron main process runs in a separate OS process from the API server. Every `console.log` call in `ebManager.ts` — including session death alerts, silent-follow diagnostics, WATCHDOG fires, and login detection results — went to the Electron terminal only. The API server log file (`equinox-debug.log`) that is used for debugging showed nothing from the browser layer, making follow failures completely opaque from the log alone.

**Fix**: Added a module-level `_ipcLog(msg)` function. It writes to `console.log` AND fire-and-forgets a POST to the existing `/api/ipc-log` endpoint on the API server, which then emits the line through pino into the normal log stream. All session-critical log lines now call `_ipcLog` instead of `console.log/warn/error`:

- `[eb-session-dead:ID]` — session death detected by the 30 s DOM poll
- `[eb:silent-follow:ID]` — every phase of every follow attempt: slot acquired/released, cookie seeding, START, loadURL result, landed URL + login/checkpoint flags, Follow button poll result, tap confirmation, page-state diagnostic, Screenshot saved path, WATCHDOG, error

This means every follow failure and session death will now be **fully visible in the log** without needing Electron DevTools access.

---

#### `executeJavaScript` hang fixed — watchdog_timeout eliminated (`ebManager.ts`)

**Problem**: The silent-follow handler loads a profile page, then calls `executeJavaScript` to poll for the Follow button (a JS Promise that runs for up to 20 s inside the renderer). If `loadURL` hits the 30 s race cap and we proceed with a partially loaded page, the real `loadURL` promise keeps running in the background. When it eventually completes or triggers a navigation, Electron destroys the old renderer context — but any pending `executeJavaScript` Promise **never resolves or rejects**. It hangs silently until the 80 s server-side watchdog fires and force-kills the window. This produced the `watchdog_timeout — forced cleanup after 80s, likely a stuck page` errors seen throughout the logs.

**Fix**: Every `executeJavaScript` call inside the silent-follow handler is now wrapped with `Promise.race` against a hard timeout:

| Call | Timeout |
|---|---|
| `isLoginDom` login-wall DOM probe | 5 s |
| `isCheckpointPage` suspicious-activity probe | 5 s |
| `btnInfo` Follow button poll (20 s internal loop) | 25 s outer cap |
| `freshRect` post-dwell button rect re-query | 5 s |
| Fallback JS `.click()` | 3 s |
| Confirmation loop `state` check (per iteration) | 2 s |
| `diagInfo` page-state diagnostic capture | 5 s |

Worst-case timeline is now ≈78 s (well inside the 80 s watchdog), making the watchdog a last-resort emergency exit rather than the normal code path.

---

#### "Follow button not found" masking "session_expired" — login-wall re-check added (`ebManager.ts`)

**Problem**: When `loadURL` hit the 30 s cap and we proceeded with a partially-loaded page, the initial `isLoginDom` check ran on an incomplete DOM. If the login wall hadn't finished rendering yet, `isLoginDom` returned `false` and the code fell through to the Follow button poll. By the time the 20 s poll timed out, the login page WAS fully rendered — but we'd already moved past the login-wall detection. The result was `follow_blocked` with reason `"Follow button not found on page"` instead of `"session_expired"`, which is exactly what was observed for `@rojin.abegum602` → `@tijax_tz`.

**Fix**: After the Follow button poll times out, a second login-wall check runs before returning the error:
1. Re-reads the current URL (catches hard redirects that completed during the poll)
2. Re-runs the DOM probe (password input / "Log in" / "Continue as" button) with a 3 s timeout
3. If a login wall is now detected, returns `session_expired — browser session logged out` so the engine and the user know the real cause

---

#### Session-death alert forwarded to API server log (`ebManager.ts`)

The `_sessionAlivePoll` (30 s interval that detects "Continue as" overlays) previously only called `console.warn`, so its `[eb-session-dead:ID]` alert was invisible in the API server log. Now calls `_ipcLog` so session deaths appear immediately in the log.

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
