# Danny's Bot

An Instagram automation platform for managing multiple accounts with tools for following, unfollowing, DMs, contact messaging, auto-reply, and session activity tracking.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/dannys-bot run dev` — run the frontend (port 22393)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: SQLite + better-sqlite3 + Drizzle ORM (file: `database.db` at workspace root)
- Frontend: React + Vite + Tailwind CSS + shadcn/ui + Wouter
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Build: esbuild (CJS bundle)
- Electron: desktop app wrapper in `artifacts/electron/`

## Where things live

- `artifacts/dannys-bot/` — React frontend (Vite, Wouter, shadcn/ui)
- `artifacts/api-server/src/` — Express API server
- `artifacts/api-server/src/instagram/` — Instagram automation engine (Puppeteer, instagram-private-api)
- `artifacts/api-server/src/routes/instagram.ts` — All API route definitions
- `artifacts/api-server/src/storage.ts` — DB access layer
- `artifacts/api-server/src/shared/` — Shared schema and route definitions
- `artifacts/electron/` — Electron desktop app wrapper
- `lib/db/src/` — Drizzle schema + SQLite DB client (shared across server)
- `database.db` — SQLite database (workspace root)

## Architecture decisions

- SQLite (not PostgreSQL) — single-file database for portability, lives at `process.cwd()/database.db`
- `lib/db/src/index.ts` creates tables with `CREATE TABLE IF NOT EXISTS` on startup — no migration runner needed
- Instagram routes are registered directly on the Express app (not via the router), via `registerInstagramRoutes(httpServer, app)`
- Puppeteer-based embedded browser for session management and cookie creation
- The server also statically serves the built frontend from `artifacts/dannys-bot/dist/public` when it exists

## EB-FIRST AUTHENTICATION RULE (non-negotiable, do not break)

**Every account session must originate from the embedded browser (EB). No Instagram API call may ever be made without a browser-originated cookie. This is the Jarvee model and must never be bypassed.**

### The only valid session establishment flow:
1. Embedded browser (Chrome/Puppeteer) logs in via `instagram.com/accounts/login/`
2. App extracts `sessionid`, `csrftoken`, `ds_user_id`, `mid` from Chrome's cookie jar
3. Those cookies are saved to `igApiCookies` in the DB and to `browser-data/cookies-{profileId}.json`
4. The mobile API (`i.instagram.com`) is bootstrapped from those EB cookies via `mobileBootstrapFromWebCookies()`

### What is FORBIDDEN:
- Calling `client.mobileLogin(username, password)` directly from the automation engine — this is a cold mobile API login that bypasses the EB entirely. Instagram treats it as a new-device takeover and risks account locks.
- Calling `verifyInstagramCredentials()` (in `instagramLogin.ts`) from any verify route — this function does a direct mobile API password login. It must NOT be called from `/api/profiles/:id/verify` or `/api/profiles/verify-all`. Those routes use the EB-first flow exclusively.
- Returning a usable API client from `ensureClient()` that has no session from an EB login (either `browserOk=true` via fresh EB cookies, or `isMobileLoggedIn()=true` from previously-verified igApiCookies that originated from an EB login).

### Where this is enforced:
- `/api/profiles/:id/verify` → `getOrCreateSession` → `browserAutoLogin` → `getSessionPageCookies` → save to DB
- `/api/profiles/verify-all` → same EB-first flow, sequential with delay
- `ensureClient()` in `automationEngine.ts`: if no EB session AND no stored igApiCookies → returns null, skips run
- If EB session exists but `mobileBootstrapFromWebCookies()` fails → logs warning, skips mobile-API tools, does NOT fall back to `mobileLogin()`

### Legacy dead code — do not use:
- `artifacts/api-server/src/src/` — duplicate directory, NOT imported by any active code, NOT bundled. It still references the old `verifyInstagramCredentials` mobile-API path. Ignore it; it is dead. Active code lives exclusively in `artifacts/api-server/src/` (without the nested `src/src`).
- `verifyInstagramCredentials()` in `artifacts/api-server/src/instagram/instagramLogin.ts` — the mobile-API direct login function. Still present for historical reference but must not be called from any verify or automation path.

## Product

- Multi-account Instagram manager
- Follow/Unfollow tools with proxy support
- DM and contact messaging tools
- Human session (embedded browser) for cookie/session management
- Auto-reply tool
- Proxy manager with ping/auto-link
- Activity dashboard and stats

## User preferences

- Do not skip any file during imports — every file matters for git

## Gotchas

- The DB path resolves from `process.cwd()` — when running via pnpm filter from `artifacts/api-server/`, the DB will be at `artifacts/api-server/database.db`; when run from workspace root it'll be at `database.db`
- `pnpm approve-builds` needed for puppeteer/sharp/esbuild after fresh installs
- The `server/` directory at the root is an older standalone server iteration — the active server is in `artifacts/api-server/`
- Always run `pnpm install --no-frozen-lockfile` when package.json changes don't match lockfile

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

## CI / GitHub Actions — Critical Knowledge

### How the build pipeline works

Every push to `main` triggers `.github/workflows/build.yml` which runs two jobs:

1. **`build-web`** (ubuntu-latest) — installs workspace deps, builds the API server and React frontend, uploads them as an intermediate Actions artifact called `web-builds` (4MB). This is NOT the installer.
2. **`package-windows`** (windows-latest) — downloads `web-builds`, installs Electron deps, runs `build.mjs` to bundle the app, then runs `electron-builder` to produce the Windows installer. It publishes to GitHub Releases AND uploads the installer as an Actions artifact called `Equinox-Windows-Installer` (88MB).

### How the user gets the installer

The user downloads the installer from the **Actions tab** on GitHub:
- Go to `github.com/dannyshaw88/dannys-bot/actions`
- Click the latest successful run
- Scroll to the Artifacts section at the bottom
- Download **`Equinox-Windows-Installer`** (88MB) — this is the real installer

**Do NOT tell the user to go to the Releases tab.** They have always used the Actions tab. The `web-builds` artifact (4MB) in the same run is just an intermediate build output — not the installer.

### If the user says "the download is only 4MB"

They are downloading `web-builds` instead of `Equinox-Windows-Installer`. Both appear in the Actions artifacts list. Point them to the correct one. Do NOT suggest the Releases page.

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

### Auto-updater (for the installed app checking for updates)

The installed app uses `electron-updater` with `setFeedURL` pointing to this private GitHub repo. It requires a GitHub token (`UPDATER_TOKEN` secret) baked in at build time via `DANNY_BOT_UPDATER_TOKEN` env var → `build.mjs` esbuild define → `__UPDATER_TOKEN__` in `main.ts`. Without this token the updater gets 404 on private repo release assets.

The `package-windows` job also sets `GH_TOKEN: ${{ secrets.UPDATER_TOKEN }}` so `electron-builder --publish always` can create/update GitHub Releases (which the auto-updater reads from).

### Key secrets required

- `UPDATER_TOKEN` — GitHub personal access token with `repo` scope. Used for: publishing releases (`GH_TOKEN`) and baking into the app for auto-update auth (`DANNY_BOT_UPDATER_TOKEN`).

### pnpm install quirks in CI

- Ubuntu CI must use `pnpm install --no-frozen-lockfile --ignore-scripts` (pnpm v11 requires `--ignore-scripts` to avoid build script failures in CI)
- Windows CI uses plain `npm install` inside `artifacts/electron/` (not pnpm)
- Vite frontend build requires `REPL_ID: ci` env var to output to `artifacts/dannys-bot/dist/public` (the path electron-builder expects)

### Always push workflow changes as a single commit

Multiple file pushes to GitHub trigger multiple CI runs. Use the GitHub Contents API (or Git Trees API) to batch all file changes into one commit. The user explicitly cares about this.

### Version bumping — REQUIRED on every push

Every push to GitHub **must** include a version bump in `artifacts/electron/package.json`.

- Current version: **v1.0.300**
- Increment the **patch** number (third digit) by 1 for each push: e.g. `1.0.291` → `1.0.292`
- The version string in `package.json` (`"version": "1.0.XXX"`) is what `electron-builder` bakes into the installer and what the auto-updater compares against
- Include `artifacts/electron/package.json` in every batch push alongside the other changed files
- Do NOT skip the version bump even for small/doc-only changes

### What's New changelog — REQUIRED on every push

Every push **must** also include a new entry at the top of the `CHANGELOG` array in `artifacts/dannys-bot/src/pages/Dashboard.tsx`.

- The `version` field must match the new version number in `artifacts/electron/package.json` (e.g. `"1.0.236"`)
- The `date` field should be today's date in plain format (e.g. `"12 May 2026"`)
- Write `items` in plain English — no technical jargon, no variable names, no internal references. Describe what changed from the user's perspective.
- One item per visible change. Keep each `text` to a single concise sentence.
- Include `artifacts/dannys-bot/src/pages/Dashboard.tsx` in every batch push alongside the other changed files.
