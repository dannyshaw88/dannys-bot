# Changelog

All notable changes to Equinox are documented here.

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
