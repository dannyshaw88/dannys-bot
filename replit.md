# Danny's Bot (Equinox)

This is an Instagram automation tool using real mobile phone devices connected via USB on Windows Electron — **not Replit's Linux environment**. Replit is used for code changes only. The built app runs entirely on the user's Windows PC, controlling physical Android phones over ADB.

**This tool cannot rely on coordinate pin-pointing for clicking and tapping anywhere. Instagram's UI constantly changes — layout shifts based on post type, account settings, and app version. All detection must rely on visual/accessibility elements (accessibility tree labels, `content-desc`, `resource-id`, `text` attributes) read live from the device at the time of action. Hardcoded pixel percentages or fixed coordinates are forbidden.**

---

## Run & Operate (Replit only — for code editing)

```
pnpm --filter @workspace/api-server run dev     # API server (port 8082)
pnpm --filter @workspace/dannys-bot run dev     # Frontend (Vite dev server)
pnpm run typecheck                               # Full typecheck across all packages
pnpm run build                                  # Server + client build
```

Workflows are managed as Replit artifacts (`artifacts/api-server: API Server`, `artifacts/dannys-bot: web`). Restart those exact workflows — do not create duplicate hand-configured ones.

---

## Stack

- pnpm workspaces, Node.js 20, TypeScript 5.9
- API: Express 5
- DB: SQLite + better-sqlite3 + Drizzle ORM (`database.db` at workspace root)
- Frontend: React + Vite + Tailwind CSS + shadcn/ui + Wouter
- Validation: Zod (`zod/v4`)
- Build: esbuild (ESM `.mjs` bundle)
- Electron: desktop app wrapper in `artifacts/electron/`
- Android automation: ADB + UIAutomator accessibility tree dumps + scrcpy mirror

---

## Where things live

- `artifacts/dannys-bot/` — React frontend (Vite, Wouter, shadcn/ui)
- `artifacts/api-server/src/` — Express API server
- `artifacts/api-server/src/mobile/androidManager.ts` — All Android/ADB automation logic (UI detection, tapping, scrolling, action-bar scanning)
- `artifacts/api-server/src/routes/mobile.ts` — Mobile API routes + automation cycle/feed loop
- `artifacts/api-server/src/storage.ts` — DB access layer
- `artifacts/electron/` — Electron desktop app wrapper
- `lib/db/src/` — Drizzle schema + SQLite DB client
- `database.db` — SQLite database (workspace root)

---

## Phone display settings — PERMANENTLY BANNED

**Never call `adb shell wm size reset`, `adb shell wm size WxH`, `adb shell wm density reset`, or any other command that changes the phone's display settings.**

The code handles all coordinate differences in software — `rescaleForDevice()` reads `wm size` (preferring Override size when present) and maps capture-frame coordinates to device coordinates. No display-setting change is ever needed. This ban is non-negotiable and must never be reversed.

---

## Mobile automation rules (non-negotiable)

### Retries are forbidden

**Never add a retry loop or a second-attempt tap to any automation action.** If something fails — a sheet doesn't open, a button isn't found, a tap doesn't register — the action is skipped and the cycle moves on. A retry masks the real failure, burns time in the middle of a timed sequence (story slides, share-sheet auto-dismiss), and has caused multiple bugs. If a detection function returns null or an action produces no result: log it, move on, do not tap again.

This applies everywhere: share-to-DM, recipient selection, Send button, icon taps, sheet confirmation, follow taps — all of it. No exceptions.

### Detection must use accessibility tree labels — never hardcoded coordinates

All UI element detection reads the live UIAutomator accessibility tree (`uiautomator dump`) and finds elements by their attributes:
- `content-desc="Like"`, `content-desc="Comment"`, `content-desc="Repost"`, `content-desc="Send"` etc.
- `resource-id` matching (e.g. `:id/expand_photo_button`)
- `text` attribute matching

Once an element is found via its label, its center coordinates are read from its `bounds` attribute in the tree and used for the tap. This is fundamentally different from hardcoding a pixel position — the coordinate comes from what Instagram actually rendered, not a pre-calculated guess.

**Forbidden:** any fixed pixel percentage (e.g. "tap at 48% of screen width") used to locate a UI element whose position can change between posts, accounts, or app versions.

### How to diagnose "detection can't find this element" — the required approach

When automation fails to find or correctly pick an element (a button, icon, or list item), do NOT guess at a fix from memory or general UI conventions. Every real fix so far has come from this exact loop — follow it in order:

1. **Add a diagnostic dump, ship it alone, gather real data first.** Extend the relevant scan function to log every candidate node it sees in that screen region — at minimum `class`, `resource-id`, `content-desc`, `text`, `bounds`/position, and width. Ship this as its own version bump with nothing else changed. Do not touch the actual tap/detection logic yet — you don't know what's true on this device/build until you've seen it.
2. **Get a screenshot AND the matching log from the same run, at the moment of failure.** The dump alone isn't enough — you need to see what's actually on screen (which icon/button is which, what's visible/highlighted) lined up against the raw attribute dump from that identical moment, not a different run. Ask for both together if the user only supplies one.
3. **Cross-reference visible UI against the raw attributes to find the real distinguishing signal.** Match on-screen elements (by their visible position, count, or label) to specific dumped nodes to figure out what actually tells them apart in the tree — this might be `class` alternating in a pattern, a label that exists but wasn't in an exclusion list, adjacency between two nodes, or something else entirely. There have been two distinct failure shapes so far, and both required this same evidence-gathering step even though the fixes looked different:
   - *No label exists at all* (content-desc/resource-id both empty on every candidate) → identify by structural signature instead (element type/class, position relative to siblings) — see the feed action-bar icon fix below.
   - *A label exists but an unwanted element also matches* (e.g. a same-zone, similarly-sized button that isn't a real candidate) → the label-reading approach was already correct, it just didn't know that specific label needed excluding — add it explicitly once confirmed from the screenshot, don't broaden the filter blindly.
4. **Only trust the new rule when it resolves unambiguously.** Whatever structural or label rule you land on, only act on it when it uniquely identifies the right element (e.g. "exactly N candidates found") — if the count or match is off, leave the result null/skip the action rather than guessing, exactly like the existing label-matching rule already does.
5. **Ship the real fix as a separate version bump from the diagnostic-only one**, with a changelog entry describing the evidence that led to it (what the screenshot showed, what the dump showed, why this rule follows from that) — not just what the code now does.

### Mirror tap rescaling — pinpoint-clicking fix

Android's screen-capture buffer (e.g. 720×1280) often has a different aspect ratio than the real display (e.g. 1080×2460) and pads the real content with black bars inside the buffer. Taps from the mirror panel were previously scaled against the full buffer including the black padding, which caused accurate centre taps but drifted noticeably toward edges. The fix scales through the actual content sub-rect inside the buffer so every tap lands correctly regardless of where on screen it is. This is implemented in `rescaleForDevice()` in `artifacts/api-server/src/routes/mobile.ts`. **Do not alter this logic.**

### Feed action-bar icons with no content-desc/resource-id — structural fallback

Some device/IG builds strip both `content-desc` and `resource-id` from every action-bar node, so label matching (the rule above) has nothing to match against and Comment/Repost/Send would stay unfound. The fix, confirmed working live: identify each icon by its structural signature instead of a label — a content-desc-less, text-less `ViewGroup` — and only trust the match when exactly 3 such candidates are found in the row (same elimination-based safety as label matching; anything else is left `null`, never guessed). Implemented in `findFeedActionIcons()` in `artifacts/api-server/src/mobile/androidManager.ts`. This only activates when label matching finds nothing — it never overrides a real content-desc match.

---

## CI / GitHub Actions

### How the build pipeline works

Every push to `main` triggers `.github/workflows/build.yml` which runs two jobs:

1. **`build-web`** (ubuntu-latest) — installs workspace deps, builds the API server and React frontend, uploads them as an intermediate Actions artifact called `web-builds` (4MB). This is NOT the installer.
2. **`package-windows`** (windows-latest) — downloads `web-builds`, installs Electron deps, runs `build.mjs` to bundle the app, then runs `electron-builder` to produce the Windows installer. Publishes to GitHub Releases AND uploads the installer as an Actions artifact called `Equinox-Windows-Installer` (88MB).

### How the user gets the installer

1. Go to `github.com/dannyshaw88/dannys-bot/actions`
2. Click the latest successful run
3. Scroll to the Artifacts section at the bottom
4. Download **`Equinox-Windows-Installer`** (88MB) — this is the real installer

**Do NOT tell the user to go to the Releases tab.** They always use the Actions tab. The `web-builds` artifact (4MB) in the same run is just an intermediate build output — not the installer.

### If the user says "the download is only 4MB"

They are downloading `web-builds` instead of `Equinox-Windows-Installer`. Both appear in the Actions artifacts list. Point them to the correct one.

### If the Equinox-Windows-Installer artifact is missing from the Actions tab

The upload step at the end of `package-windows` in `build.yml` is missing or broken. It should look like:

```yaml
- name: Upload installer to Actions artifacts
  uses: actions/upload-artifact@v4
  with:
    name: Equinox-Windows-Installer
    path: artifacts/electron/release/*.exe
    if-no-files-found: error
```

### Auto-updater

The installed app uses `electron-updater` with `setFeedURL` pointing to the private GitHub repo. Requires a GitHub token (`UPDATER_TOKEN` secret) baked in at build time via `DANNY_BOT_UPDATER_TOKEN` env var → `build.mjs` esbuild define → `__UPDATER_TOKEN__` in `main.ts`. Without this token the updater gets 404 on private repo release assets. The `package-windows` job also sets `GH_TOKEN: ${{ secrets.UPDATER_TOKEN }}` so `electron-builder --publish always` can create/update GitHub Releases.

### Key secrets required

- `UPDATER_TOKEN` — GitHub personal access token with `repo` scope. Used for publishing releases and auto-update auth.

### pnpm install quirks in CI

- Ubuntu CI: `pnpm install --no-frozen-lockfile --ignore-scripts`
- Windows CI: plain `npm install` inside `artifacts/electron/`
- Vite frontend build requires `REPL_ID: ci` env var to output to `artifacts/dannys-bot/dist/public`

### Never push without being told to

**NEVER push to GitHub unless the user explicitly instructs it.** Make all code changes locally first. Only push when the user says to push / ship / release.

### Version bumping — required on every push

Every push to GitHub must include a version bump in both `package.json` (root) and `artifacts/electron/package.json`. Increment the patch number (third digit) by 1. The version string is what `electron-builder` bakes into the installer and what the auto-updater compares against.

### CHANGELOG — required on every push

Every push must include a new entry at the top of `CHANGELOG.md` describing what changed in plain English from the user's perspective.

---

## User preferences

- Do not skip any file during imports — every file matters for git
- Never push to GitHub unless the user explicitly says to
