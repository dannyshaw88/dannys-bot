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

## EB-FIRST AUTHENTICATION RULE (non-negotiable, do not break)

**Every account session must originate from the embedded browser (EB). No Instagram API call may ever be made without a browser-originated cookie. This is the Jarvee model and must never be bypassed.**

### The only valid session establishment flow (Jarvee two-stage handshake — v1.0.307+):
27. Embedded browser (Chrome/Puppeteer) logs in via `instagram.com/accounts/login/`
28. App extracts `sessionid`, `csrftoken`, `ds_user_id`, `mid` from Chrome's cookie jar
29. Those cookies are **immediately saved** to `igApiCookies` in the DB (status stays `verifying`) and to `browser-data/cookies-{profileId}.json`
30. `verifyInstagramCredentials(profileWithCookies)` is called with the fresh cookies — it takes **Path 2 (cookie restore)** because `igApiCookies` now has a sessionid. It runs the Jarvee cold-start sequence: `tokens/keyed → launcher/sync → users/{id}/info`
31. The result of the mobile API call sets the final `accountStatus` — `valid` only if the API confirms the session. The EB alone is never sufficient to mark an account valid.

### What is FORBIDDEN:
32. Calling `client.mobileLogin(username, password)` directly from the automation engine — this is a cold mobile API login that bypasses the EB entirely. Instagram treats it as a new-device takeover and risks account locks.
33. Calling `verifyInstagramCredentials()` with a profile that has **no** `igApiCookies` from an EB login — this causes Path 1 (direct mobile password login) which bypasses the EB. The function is safe to call ONLY AFTER the EB has logged in and `igApiCookies` has been saved to the profile, which forces Path 2 (cookie restore).
34. Returning a usable API client from `ensureClient()` that has no session from an EB login (either `browserOk=true` via fresh EB cookies, or `isMobileLoggedIn()=true` from previously-verified igApiCookies that originated from an EB login).

### Where this is enforced:
35. `/api/profiles/:id/verify` → `getOrCreateSession` → `browserAutoLogin` → `getSessionPageCookies` → save `igApiCookies` to DB → `verifyInstagramCredentials(profileWithCookies)` [Path 2 only] → set final status
36. `/api/profiles/verify-all` → same two-stage flow, sequential with delay
37. `ensureClient()` in `automationEngine.ts`: if no EB session AND no stored igApiCookies → returns null, skips run
38. If EB session exists but `mobileBootstrapFromWebCookies()` fails → logs warning, skips mobile-API tools, does NOT fall back to `mobileLogin()`

### Legacy dead code — do not use:
39. `artifacts/api-server/src/src/` — duplicate directory, NOT imported by any active code, NOT bundled. It still references older patterns. Ignore it; it is dead. Active code lives exclusively in `artifacts/api-server/src/` (without the nested `src/src`).
40. Path 1 inside `verifyInstagramCredentials()` (direct mobile password login) — never triggered by the verify routes because they always supply `igApiCookies` before calling the function. If `igApiCookies` is absent from the profile passed in, Path 1 would fire — that is a bug, not the intended path.

## Product

41. Multi-account Instagram manager
42. Follow/Unfollow tools with proxy support
43. DM and contact messaging tools
44. Human session (embedded browser) for cookie/session management
45. Auto-reply tool
46. Proxy manager with ping/auto-link
47. Activity dashboard and stats

## User preferences

48. Do not skip any file during imports — every file matters for git

## Gotchas

49. The DB path resolves from `process.cwd()` — when running via pnpm filter from `artifacts/api-server/`, the DB will be at `artifacts/api-server/database.db`; when run from workspace root it'll be at `database.db`
50. `pnpm approve-builds` needed for puppeteer/sharp/esbuild after fresh installs
51. The `server/` directory at the root is an older standalone server iteration — the active server is in `artifacts/api-server/`
52. Always run `pnpm install --no-frozen-lockfile` when package.json changes don't match lockfile

## Pointers

53. See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

## CI / GitHub Actions — Critical Knowledge

### How the build pipeline works

Every push to `main` triggers `.github/workflows/build.yml` which runs two jobs:

53. **`build-web`** (ubuntu-latest) — installs workspace deps, builds the API server and React frontend, uploads them as an intermediate Actions artifact called `web-builds` (4MB). This is NOT the installer.
54. **`package-windows`** (windows-latest) — downloads `web-builds`, installs Electron deps, runs `build.mjs` to bundle the app, then runs `electron-builder` to produce the Windows installer. It publishes to GitHub Releases AND uploads the installer as an Actions artifact called `Equinox-Windows-Installer` (88MB).

### How the user gets the installer

55. Go to `github.com/dannyshaw88/dannys-bot/actions`
56. Click the latest successful run
57. Scroll to the Artifacts section at the bottom
58. Download **`Equinox-Windows-Installer`** (88MB) — this is the real installer

**Do NOT tell the user to go to the Releases tab.** They have always used the Actions tab. The `web-builds` artifact (4MB) in the same run is just an intermediate build output — not the installer.

### If the user says "the download is only 4MB"

59. They are downloading `web-builds` instead of `Equinox-Windows-Installer`. Both appear in the Actions artifacts list. Point them to the correct one. Do NOT suggest the Releases page.

### If the Equinox-Windows-Installer artifact is missing from the Actions tab

60. The upload step at the end of `package-windows` in `build.yml` is missing or broken. It should look like:

```yaml
- name: Upload installer to Actions artifacts
  uses: actions/upload-artifact@v4
  with:
    name: Equinox-Windows-Installer
    path: artifacts/electron/release/*.exe
    if-no-files-found: error
```

### Auto-updater (for the installed app checking for updates)

61. The installed app uses `electron-updater` with `setFeedURL` pointing to this private GitHub repo. It requires a GitHub token (`UPDATER_TOKEN` secret) baked in at build time via `DANNY_BOT_UPDATER_TOKEN` env var → `build.mjs` esbuild define → `__UPDATER_TOKEN__` in `main.ts`. Without this token the updater gets 404 on private repo release assets.
62. The `package-windows` job also sets `GH_TOKEN: ${{ secrets.UPDATER_TOKEN }}` so `electron-builder --publish always` can create/update GitHub Releases (which the auto-updater reads from).

### Key secrets required

63. `UPDATER_TOKEN` — GitHub personal access token with `repo` scope. Used for: publishing releases (`GH_TOKEN`) and baking into the app for auto-update auth (`DANNY_BOT_UPDATER_TOKEN`).

### pnpm install quirks in CI

64. Ubuntu CI must use `pnpm install --no-frozen-lockfile --ignore-scripts` (pnpm v11 requires `--ignore-scripts` to avoid build script failures in CI)
65. Windows CI uses plain `npm install` inside `artifacts/electron/` (not pnpm)
66. Vite frontend build requires `REPL_ID: ci` env var to output to `artifacts/dannys-bot/dist/public` (the path electron-builder expects)

### Always push workflow changes as a single commit

66. **NEVER push to GitHub unless the user explicitly instructs it.** Make all code changes locally first. Only run the Git push script when the user says to push / ship / release.

67. Multiple file pushes to GitHub trigger multiple CI runs. Use the GitHub Contents API (or Git Trees API) to batch all file changes into one commit. The user explicitly cares about this.

### Version bumping — REQUIRED on every push

Every push to GitHub **must** include a version bump in `artifacts/electron/package.json`.

68. Current version: **v1.0.318**
69. Increment the **patch** number (third digit) by 1 for each push: e.g. `1.0.291` → `1.0.292`
70. The version string in `package.json` (`"version": "1.0.XXX"`) is what `electron-builder` bakes into the installer and what the auto-updater compares against
71. Include `artifacts/electron/package.json` in every batch push alongside the other changed files
72. Do NOT skip the version bump even for small/doc-only changes

### What's New changelog — REQUIRED on every push

Every push **must** also include a new entry at the top of the `CHANGELOG` array in `artifacts/dannys-bot/src/pages/Dashboard.tsx`.

73. The `version` field must match the new version number in `artifacts/electron/package.json` (e.g. `"1.0.236"`)
74. The `date` field should be today's date in plain format (e.g. `"12 May 2026"`)
75. Write `items` in plain English — no technical jargon, no variable names, no internal references. Describe what changed from the user's perspective.
76. One item per visible change. Keep each `text` to a single concise sentence.
77. Include `artifacts/dannys-bot/src/pages/Dashboard.tsx` in every batch push alongside the other changed files.
