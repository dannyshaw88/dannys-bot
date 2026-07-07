# Changelog

All notable changes to Equinox are documented here.

---

## [1.1.384] — 2026-07-07

### Fixed

#### Critical — Verify overwrites live sessionid with stale file value → __coig_ufac=1 ban

**Root cause:** In `/eb/silent-verify` (`ebManager.ts`), `loadCookiesFromFile()` was called **before** the existing-session check. Instagram rotates the `sessionid` cookie during active browsing. If the `cookies-{id}.json` file held the original login-time sessionid (30+ minutes old), the file-load silently overwrote the live, current sessionid in the Electron session partition. Any subsequent request from the browser then carried the stale sessionid value — Instagram's cookie origin integrity guard (`__coig_ufac=1`) detects this as a cookie being replayed from a different device/time and triggers an instant suspension.

**Confirmed by log:** The ban URL always contained `?__coig_ufac=1`. Verify completed with `"Using existing EB session"` (no Instagram HTTP calls) — but `loadCookiesFromFile` had already run and the overwrite had already happened before the early return.

**Fix:** Check for a live `sessionid` in the Electron session **before** calling `loadCookiesFromFile`. If a live session exists, return immediately without touching any cookies at all. Only call `loadCookiesFromFile` when there is no active session (i.e. the EB needs to be bootstrapped from the saved cookie file for a fresh login).

---

## [1.1.383] — 2026-07-07

### Fixed

#### Critical — Mobile UA + stale desktop GPU fingerprint causing instant bans (root cause of 3-day ban wave)

**Root cause:** When accounts had desktop UAs (v1.1.291–v1.1.365), `generateEbFingerprint()` was called with `desktopMode=true`, storing a desktop GPU renderer string (e.g. `"ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)"`) in the `ebFingerprint` DB column. When v1.1.366 reverted the UA back to mobile Android, only `userAgentEmbedded`/`userAgentApi` were updated — the stored `ebFingerprint` was NOT regenerated. From that point, every EB open and every Mode-B silent-window action sent Instagram a physically impossible hardware combination: Android 14 mobile UA + NVIDIA RTX Direct3D11 WebGL renderer. Instagram detects this as an immediate device-mismatch/session-hijack signal → instant ban.

The coherence check in `browserSession.ts` (introduced to catch desktop-GPU mismatches within the desktop-UA era) only ran when `isDesktopUA = true`. It completely missed the reverse case: mobile UA + stale desktop GPU in DB.

**Two-part fix:**

1. **Startup migration** (`routes/instagram.ts`): on every server start, scans all profiles with a mobile UA and regenerates any `ebFingerprint` that contains a desktop GPU string (`Direct3D11`, `ANGLE (Apple`, `ANGLE (NVIDIA`, `ANGLE (AMD`, `ANGLE (Intel`). Fixes all affected accounts immediately — without waiting for each EB to be opened manually. Logged as `[startup:fp-fix]`.

2. **Per-session coherence check** (`browserSession.ts`): extended the existing desktop-coherence guard to also catch Case B (mobile UA + any desktop GPU string). Now runs on every EB open for both desktop and mobile UA accounts, covering any account that slips through the startup migration.

---

## [1.1.379] — 2026-07-06

### Added

#### Leak Protection — Console shield logs for EB sessions, API client, and browser-only accounts

Three new structured log lines now fire at the critical points in every account session so you can confirm leak protection is active in real time and cross-check it against the Leak Check page.

---

##### `[eb-shield:ID]` — fires every time an Embedded Browser session opens (`ebManager.ts › openEbWindow`)

Printed immediately after the proxy, WebRTC policy, DoH, and DNS-cache setup steps complete. Reports the **actual applied state** of each protection layer — not assumed state — so any layer that failed to apply (e.g. `setWebRTCIPHandlingPolicy` unavailable on an older Electron build) shows `⚠` instead of `✓`.

```
[eb-shield:123] @username ── LEAK PROTECTION ACTIVE
  proxy       : http://p.host:8080
  webrtc      : ✓ disable_non_proxied_udp (session-level + app-level flag)
  doh         : ✓ DISABLED — proxy handles DNS resolution
  quic        : DISABLED (app-level --disable-quic flag)
  ipv6        : DISABLED (app-level --disable-ipv6 flag)
  dns-prefetch: DISABLED (app-level --dns-prefetch-disable flag)
  dns-cache   : FLUSHED (clearHostResolverCache)
```

- `webrtc` and `doh` lines carry `✓` when the session-level API applied, `⚠` when it threw (non-fatal; app-level flag still applies).
- `doh` note adapts: proxy sessions say "proxy handles DNS resolution"; home-IP (`useHomeIp=true`) sessions say "OS resolver (no proxy in this session)".

---

##### `[run-leak-test:ID]` — fires after every leak test (`ebManager.ts › /eb/run-leak-test handler`)

Replaces the previous single-line count log with a per-field breakdown that mirrors all 20 checks on the Leak Check page. The headline summarises the worst finding; each check line shows the same status icon and label the UI shows.

```
[run-leak-test:123] RESULTS — ✓ ALL CLEAR (20/20 checks)
  IP        : ✓ 185.x.x.x (proxy)
  IPMatch   : ✓ Matched
  WebRTC    : ✓ No leak
  DNS       : ✓ No leak
  UAMatch   : ✓ Match
  Bot       : ✓ Not detected
  Timezone  : ✓ ...
  ...
```

Headline rules (in priority order):
- `✗ N FAIL(S) — key1, key2` — one or more `fail` results
- `⚠ N WARN — key1, key2` — warnings with no failures
- `⚠ INCOMPLETE — N checks not captured (key1, …)` — test page timed out or crashed before all 20 keys were written; **never shows ALL CLEAR when checks are missing** (previous behaviour was a false green)
- `✓ ALL CLEAR (20/20 checks)` — only when all 20 keys are present and none are `fail`/`warn`

Result JSON is runtime-normalised before logging (`unknown → { status, label }`) so a partial or malformed RESULTS object degrades gracefully rather than throwing.

**Cross-check rule:** `[eb-shield]` proxy host and `[run-leak-test]` IP result must agree. Any discrepancy means a request bypassed the proxy.

---

##### `[api-shield:ID]` — fires when an API client is created and when disableApi mode blocks it (`instagramWebClient.ts`, `automationEngine.ts`)

**Mobile API active path** (printed in `InstagramWebClient` constructor after the hard-gate check):

```
[api-shield:123] ── MOBILE API LEAK PROTECTION ACTIVE
  proxy       : http://p.host:8080
  hard-gate   : ✓ constructor blocks if proxy absent
  tls-gate    : ✓ tlsRequest blocks if proxy absent
  cycleTLS    : ✓ patchIgClientTls throws if CycleTLS fails (no Node.js TLS fallback)
```

Port is normalised — if the proxy URL has no explicit port, the scheme default is used (`http→80`, `https→443`, `socks5→1080`) so the log never shows `host:`.

**Browser-only / Disable API path** (printed in `ensureClient` when `disableApi=true`):

```
[api-shield:123] @username ── BROWSER-ONLY MODE
  mobile-api  : ✗ BLOCKED (disableApi=true — ensureClient returns null)
  eb          : EB session will be attempted for this account; proxy is
                enforced there — look for [eb-shield:123] in the log.
                If no [eb-shield] line appears, the EB session did not open.
```

The note is intentionally conditional: `disableApi=true` suppresses all API calls but does not guarantee an EB session — if the EB fails to open (e.g. `ensureSilentEbOpen` error) no `[eb-shield]` line appears, making the gap immediately visible in the log.

---

## [1.1.378] — 2026-07-06

### Fixed

#### EB Leak Test — Audio Context state always showed "closed" (false negative)

**Root cause:** The `testAudio()` function in the leak test called `ctx.close()` on line 1277 and then read `ctx.state` on line 1286 — after the close. An AudioContext transitions to `"closed"` state when `.close()` is called, regardless of what state it was in before. So the field always displayed `"closed"` even on a fully healthy, running audio context, making it impossible to tell from the leak test whether the AudioContext was behaving normally.

**Fix:** Capture `ctx.state` into `ctxStateCaptured` immediately before calling `ctx.close()`. The row now shows `"running"` (the correct value for a freshly created AudioContext) and is coloured green for `running`/`suspended`, amber for anything else.

---

#### EB Leak Test — Timer Precision falsely reported "No — full precision" despite 0.1ms quantisation being active

**Root cause:** The old timing test sampled `performance.now()` 10 times in a tight synchronous loop and checked `Math.min(...diffs)`. With our 0.1ms quantisation override (`Math.round(t*10)/10`), all 10 calls happen within the same 100 µs bucket and return the **same** value — giving diffs of exactly `0`. The test's threshold `minDiff > 0.1` evaluated to `false`, so it reported "full precision" even though our clamp was working correctly. This was a false alarm: real Android Chrome with timer coarsening produces the same pattern.

**Fix:** Replaced the brittle `minDiff` check with a `nonZeroDiffs`/`allSame` approach:
- `allSame = true` (all diffs are zero) → timer is quantised, all calls fell in the same bucket → report "coarsened."
- `minNonZeroDiff ≥ 0.099ms` (epsilon-adjusted for IEEE-754 rounding) → timer steps are coarse → report "coarsened."
- Only if non-zero diffs exist AND the smallest is `< 0.001ms` → true full precision → report "full precision."
The resolution label also now says `≤0.1ms (quantised — all same bucket)` for the common case, making it immediately clear what's happening.

---

#### EB Fingerprint — `navigator.doNotTrack` leaked as `"1"` (Electron default)

**Root cause:** Electron's Chromium session has DNT (Do Not Track) enabled by default. Every EB window therefore exposed `navigator.doNotTrack === "1"` to Instagram. Real Android Chrome never sets DNT — the preference is buried in a rarely-visited settings page and the default is off — so `navigator.doNotTrack` on a real Android Chrome session returns `null`. Instagram and third-party fingerprinting scripts can detect this mismatch.

**Fix:** Added an `Object.defineProperty` override to `buildFingerprintScript` immediately after the `performance.now` clamp:
```javascript
Object.defineProperty(navigator, 'doNotTrack', { get: function(){ return null; }, configurable: true });
```
This runs via `Page.addScriptToEvaluateOnNewDocument` on every page navigation in the EB, restoring the correct `null` value before any page script can read it.

---

#### EB Browser — WebGL 2 context unavailable on some GPU/driver configurations

**Root cause:** Chrome maintains a GPU blocklist (a list of GPU/driver combinations with known rendering bugs) and denies `canvas.getContext('webgl2')` for GPUs on that list. On some Windows machines this caused WebGL 2 to be unavailable in the EB, even though Android Chrome 128 supports WebGL 2 on every supported Android device. The mismatch is detectable by Instagram's client-side fingerprinting probes.

**Fix:** Added `app.commandLine.appendSwitch("ignore-gpu-blocklist")` to `main.ts`. This instructs Chromium to ignore the denylist and attempt hardware-accelerated WebGL 2 on all GPUs. Trade-off: may cause minor rendering glitches on genuinely buggy drivers, but the EB is automation-only (no user-visible rendering quality requirement) so this is acceptable.

---

## [1.1.377] — 2026-07-06

### Fixed

#### Human Session Tool (Disable API mode) — "Suggested for you" page no longer prevents Explore from firing

**Root cause:** When an account follows no users, Instagram's home feed shows a full-page "Suggested for you" layout. These suggestion cards are wrapped in `<article>` elements — the same selector used by `waitFor('article')` — so the feed-detection check returned `feedHadPosts = true` even when no real posts were present. The Explore-page block (`followSuggestedUsersIfEmptyEnabled`) never fired because it depends on `feedHadPosts = false`.

A second problem: a defensive post-scroll re-check at the end of the viewTimelineFeed block used `document.querySelector('article')` to recover from slow SPA renders. Since suggestion cards also match `article`, this re-check would silently restore `feedHadPosts = true` even after the suggestions page was correctly identified, cancelling the fix.

**Fix (two coordinated parts):**
1. **Detection** — after `waitFor('article')` succeeds, a new `page.evaluate()` check runs to distinguish real posts from suggestions. The check is intentionally conservative: it only triggers when (a) ALL article elements on the page lack a `<time>` child (real feed posts always contain a timestamp; suggestion cards never do) AND (b) a "Suggested for you" heading is found as a leaf text node. A mixed feed — one that contains both real posts and a suggestions section — will always have at least one `<time>`-containing article, so the check never false-positives there. If detected: `feedHadPosts = false`, `_ebSuggestionsPageDetected = true`.
2. **Re-check guard** — the post-scroll defensive re-check is now skipped when `_ebSuggestionsPageDetected = true`, preventing suggestion-card `<article>` elements from undoing the detection. The re-check selector is also tightened to `article time` so it only counts articles with a real timestamp, not bare structural wrappers.

---

#### Human Session Tool (Disable API mode) — Execution Order fields now work

**Root cause:** `runBrowserOnlyHumanSession` (the code path taken when **Disable API** is enabled on an account) was a flat sequential `if`-block. Every action always ran in the same hard-coded order regardless of the OrderMin/OrderMax values configured in the Human Session Tool settings. The order queue that the standard (API) path uses in `runHumanSessionTools` had never been ported to the browser-only path.

**Fix:** `runBrowserOnlyHumanSession` now uses the same queue pattern as `runHumanSessionTools`:
- `EbQueueEntry` type + `ebQueue` array + `ebEnqueue` helper that reads each action's `OrderMin`/`OrderMax` setting and assigns a random sort value in that range.
- All ten major actions are enqueued: `humanJitter`, `viewTimelineFeed`, `viewReels`, `checkTimelineStories`, `checkDm`, `likeTimelinePosts`, `follow`, `unfollow`, `contact`, `repost`.
- `ebQueue.sort((a, b) => b.order - a.order)` then executes them in descending order (higher order = runs first) — identical to the non-EB queue convention.
- The resolved execution order is logged at session start: `[EB-only] session order: viewTimeline → likeTimeline → …`
- `saveTimelinePosts`, `shareTimelinePosts`, and `explorePage` remain sequential after the queue — they have no order keys and depend on `feedCount` / `feedHadPosts` set by `viewTimelineFeed`.

---

## [1.1.374] — 2026-07-06

### Fixed

#### Human Session Tool — View Reels: reel count now accurate + ArrowDown works reliably

**Root cause:** The reels page was missing the `document.visibilityState = "visible"` override before the reel-watching loop. Without it, Instagram's SPA keeps the reel feed in a throttled / non-hydrated state when the EB window is off-screen, which means the video element is present but the reel player is not fully initialised. Separately, `page.keyboard.press("ArrowDown")` was firing without a preceding `document.body.focus()`, so the key event was silently dropped when no DOM element had focus.

**What was happening:** The reel loop always incremented `watched` once per `ArrowDown` press regardless of whether the reel player actually advanced, so the session log could report e.g. 9 reels watched while the user watching the EB saw only 1 reel play.

**Fix:**
1. Applies the same `Object.defineProperty(visibilityState → "visible") + dispatchEvent(visibilitychange)` override already used by `viewTimelineFeed`, `likeTimelinePosts`, `checkTimelineStories`, and the Follow/story flows — now also applied right before the reel-watching loop starts.
2. Calls `document.body.focus()` immediately before each `ArrowDown` press so the key event is always delivered to the document and reaches the reel player's keyboard handler.

---

#### Human Session Tool — View Reels: EB no longer stays parked on `/reels/` after the block finishes

**Root cause:** The View Reels block navigated to `instagram.com/reels/` and left the EB there with no cleanup navigation. If `checkTimelineStories` was disabled (or skipped by chance), no subsequent block navigated away, so the EB finished the session — and started the next one — on `/reels/`. Users saw the EB jump unexpectedly to the Reels page immediately after the final action of the previous session.

**Fix:** After the reel-watching loop (and after any reel-like logging), a `nav("https://www.instagram.com/", "home (after reels)")` call returns the EB to the home feed before proceeding to the next block. This is guarded by `!state.stop.stopped` so it is skipped on early session termination.

---

#### Human Session Tool — Watch Stories: removed gratuitous home-page reload between each story user

**Root cause:** The story-watching loop called `nav("https://www.instagram.com/", ...)` at the **top of every iteration** — including iterations 2, 3, 4, etc. After pressing `Escape` to dismiss a story, Instagram's overlay closes and the browser is already on the home feed; a second full navigation to the same URL caused a complete page reload the user perceived as the EB "bouncing" back and forth between the home feed and the story viewer for every single user in the tray.

Additionally, the original design comment ("always navigate home so the tray is in a clean state") was correct for iteration 0 only — the story tray's "first unseen" pointer already advances automatically after a story is fully dismissed via `Escape`, so subsequent iterations naturally see the next unread user without any navigation.

**Fix:** The `nav(home)` call is now guarded by `if (i === 0)`. Iterations 1 through N skip the navigation entirely; the visibilityState override and tray-selector wait that follow immediately re-hydrate and query the already-loaded home feed. Net effect: N story-tray interactions now produce 1 home-feed navigation (at the start) instead of N, eliminating the bouncing behaviour.

---

#### Human Session Tool — Web Browsing block collapses when disabled

**Root cause:** The Web Browsing section's tab bar ("Settings" / "Sites Visited") and the content panel below it were rendered unconditionally — they always appeared even when the `webBrowsingEnabled` checkbox was off. This differed from every other tool block in the Human Session panel, which hides its detail rows when unchecked.

**Fix:** The tab bar and both content panels (Settings and Sites Visited log) are now wrapped in `{!!settings.webBrowsingEnabled && (...)}`. When the checkbox is off the header row alone is visible, matching the collapsed pattern used by all other tool blocks.

---

## [1.1.373] — 2026-07-06

### Added

#### Web Browsing — new standalone block in Human Session Tool (last, after Contact Tool)

A dedicated **Web Browsing** block has been added to the Human Session Tool. It appears as the last header block, positioned after the Contact Tool, matching the same cyan-header layout as Follow / Unfollow / Contact.

**What it does:**
- During any Human Session run, the engine visits a configured list of external websites using the same headless-browser cookie-baker engine already used by the standalone Cookie Baker tool. This builds genuine, per-account browser history that Instagram sees when inspecting the Chrome cookie jar — the same cookies the EB writes into `browser-data/cookies-{profileId}.json`.
- Sites are visited with real scroll dwell time, optional internal-link traversal, and cookie banner dismissal — identical to the Cookie Baker behaviour.

**UI features:**
- Enabled checkbox, Order % and Skip Chance % ranges on the header row (same pattern as all other HS blocks).
- **Settings tab**: URL textarea (one URL per line), "Visit at random" checkbox, Sites to Visit / Internal Links / Time on Site / Time on Internal Links min–max pairs.
- **Sites Visited log tab**: shows every past web browsing session with each site visited, time spent, and internal links followed — pulled from `/api/profiles/:id/cookie-baker/activity`.
- **"Split across accounts" button**: distributes all URLs in the current account's list evenly across every account — no duplicates. E.g. 100 URLs × 10 profiles → each profile gets 10 unique URLs. The current profile's slice updates immediately in the UI.

**Copy Settings integration:**
- Web Browsing Settings group added to the Human Session Copy Settings dialog (after Contact Tool Settings).
- Sub-options: Enabled, Execution order, Skip chance %, Visit at random, **Website URLs** (separate checkbox — tick to include URLs in the copy; when unticked only settings are copied, URLs stay per-account), Sites to visit range, Internal links range, Time on site range, Time on links range.

**Engine wiring (automationEngine.ts):**
- `enqueue("webBrowsing", ...)` added to the Human Session queue, before `queue.sort()`. Controlled by `webBrowsingEnabled` / `webBrowsingSkipMin/Max` / `webBrowsingOrderMin/Max`. Maps all `webBrowsing*` settings keys to `runCookieBakerSession`'s expected params (`sites`, `sitesMin/Max`, `visitRandom`, `internalLinksMin/Max`, `scrollDelayMin/Max`, `internalScrollDelayMin/Max`). Each completed session is logged via `logAction` + `logGhostBrowserCall` and appears in the Actions log.

#### Ghost Browser Signup — website warm-up removed (moved to Human Session Tool)

All website warm-up configuration has been removed from the Ghost Browser Signup panel:
- Removed state, localStorage persistence, and payload fields: `websitesToVisit`, `websitesMin/Max`, `internalLinksMin/Max`, `timeOnSiteMin/Max`, `timeOnLinksMin/Max`.
- Removed the "Warm-up Websites" textarea and "Websites to Visit / Internal Links / Time on Site / Time on Links" XY-field rows from the UI.
- Removed the "Visiting Sites" step from the signup progress tracker — the progress stepper now shows `["YouTube Warm-up", "Instagram Signup"]` (or just `["Instagram Signup"]` when Skip Warmup is ticked).
- YouTube warm-up, Skip Warmup toggle, and all YouTube settings remain fully intact.
- The `calcStepProgress` function's settings shape updated to remove the now-unused `websitesMin/Max/Count` fields.

The website-visiting capability now lives exclusively in the Human Session Tool's Web Browsing block, where it runs on a schedule during live Instagram sessions rather than only at account-creation time. This gives Instagram a richer, ongoing browsing history rather than a one-off pre-signup burst.

---

## [1.1.372] — 2026-07-06

### Added

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
