# Workspace

> ## 🚫 ABSOLUTE RULE — NO EXCEPTIONS
>
> **DO NOT push to GitHub at any time, for any reason, unless the user's message contains the exact words "push-to-git".**
>
> - Completing a task → do NOT push
> - Fixing a bug → do NOT push
> - User says "done", "looks good", "great" → do NOT push
> - Finishing a feature → do NOT push
> - End of session → do NOT push
>
> **Only trigger a push when the user literally types: push-to-git**
>
> When that trigger IS given, use the GitHub Git Data API (never `git push` or the per-file Contents API).
> Single-commit method: GET ref → GET commit (treeSha) → POST blobs → POST tree → POST commit → PATCH ref.
> Token: `listConnections('github')[0].settings.access_token`. Repo: `dannyshaw88/dannys-bot`.
> See `.local/github_push_instruction.md` for the full step-by-step.

> ## ⚠️ AGENT STANDING RULES — READ BEFORE TOUCHING ANY INSTAGRAM CODE
>
> ### RULE 1 — EVERYTHING IS API. NO EXCEPTIONS. NO WEB. NO BROWSER AUTOMATION.
>
> **All Instagram actions AND all data scraping go through:**
> 1. **Instagram Private Mobile API** (`i.instagram.com`) — actions (follow, unfollow, like, DM, story view, profile read, comment) AND data retrieval (followers, followings, hashtag posts, user info)
> 2. **HikerAPI** (`hikerApiClient.ts`) — alternative data retrieval source
>
> **The Embedded Browser (EB) is used ONLY for:**
> - Human manual web browsing (the user is in control of the keyboard/mouse)
> - Completing login challenges / CAPTCHAs so the API session recovers
> - NOTHING ELSE — the EB never performs automated actions or data collection
>
> **NEVER — not for actions, not for scraping, not for anything automated:**
> - Use `webPost()` or `webGet()` for any bot-driven operation
> - Use `www.instagram.com` endpoints for any automated purpose (returns 302)
> - Use Puppeteer / browser automation for any bot action or data fetch
> - Fall back to the EB browser when an API call fails
>
> **Confirmed dead ends — do not retry:**
> - `www.instagram.com` DM broadcast → returns 302 (blocked for API use)
> - `i.instagram.com` DM broadcast with web-origin cookies → error 4415001
> - `i.instagram.com` create_group_thread with web cookies → login_required
> - `fetch_headers` as a bootstrap step → returns zero cookies, useless
>
> **Correct method for EVERYTHING the bot does:**
> - Actions → `mobilePost()` in `instagramWebClient.ts` → `i.instagram.com`
> - Data retrieval → `mobileGet()` in `instagramWebClient.ts` → `i.instagram.com`, OR `hikerApiClient.ts`
> - DMs → `_mobileDmPost()` / `_sendDmViaIgClient()` in `instagramWebClient.ts`
>
> **Before writing or modifying ANY method in `instagramWebClient.ts` or `automationEngine.ts`:**
> Ask: does this use `mobilePost`, `mobileGet`, `_mobileDmPost`, or HikerAPI? If the answer involves `webPost`, `webGet`, Puppeteer, or `www.instagram.com` — stop and find the correct mobile API endpoint.

## Overview

Danny's Bot — an Instagram automation dashboard. pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm (dev) / npm (Windows standalone)
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: SQLite + Drizzle ORM (`better-sqlite3` v12, auto-creates `database.db`)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **Frontend**: React + Vite + Tailwind CSS v4 + shadcn/ui components
- **Build**: esbuild (ESM bundle at `artifacts/api-server/dist/index.mjs`)
- **Browser automation**: Puppeteer
- **Instagram API**: instagram-private-api

## IMPORTANT — API-First Architecture

This is an **API-based Instagram bot**, not a web-scraping or session-cookie bot.

- All Instagram data retrieval (user lookups, followings, followers, feed) must go through **HikerAPI** (`hikerApiClient.ts`) or the **instagram-private-api** mobile client (`instagramWebClient.ts` / `instagramLogin.ts`).
- **Never** use `profile.sessionCookies` to extract user IDs or session data for API calls. Session cookies exist only for the Puppeteer embedded browser (human browsing sessions).
- **Never** call `InstagramWebClient` or any web-client method just to resolve a username to a user ID — always use `hikerClient.getUserByUsername()` for that.
- The embedded browser (Puppeteer) is used **only** for human-like browsing actions (notifications, explore, stories) and manual account verification. It is **not** the primary data source.
- When in doubt: HikerAPI first, instagram-private-api second, browser never for data.

## Architecture

### Frontend (`artifacts/dannys-bot`)
- React + Vite web app served at `/`
- Pages: Dashboard, Profiles, ProfileDetails, Stats, ProxiesPage, Settings
- Uses custom hooks (`use-profiles`, `use-tools`, `use-sources`, `use-proxies`) for API calls
- Browser panel with real-time Puppeteer streaming via WebSocket
- Shared types in `src/shared/schema.ts` and routes in `src/shared/routes.ts`
- Vite aliases: `@/` → `src/`, `@shared/` → `src/shared/`
- Production build output: `artifacts/dannys-bot/dist/public/` (built with `BASE_PATH=/`)

### Backend (`artifacts/api-server`)
- Express 5 API server served at `/api`
- Default port: 3000 (overridable via `PORT` env var; Replit sets its own port via workflow env)
- In production/Windows mode: also serves the built frontend from `artifacts/dannys-bot/dist/public/`
- Instagram automation engine (`src/instagram/automationEngine.ts`)
- Browser session management with Puppeteer (`src/instagram/browserSession.ts`)
- Instagram login and credential verification (`src/instagram/instagramLogin.ts`)
- Instagram web client for API interactions (`src/instagram/instagramWebClient.ts`)
- Proxy management and routing (`src/instagram/browserProxy.ts`)
- Hiker API integration (`src/instagram/hikerApiClient.ts`)
- WebSocket endpoint for real-time browser streaming at `/api/browser/:profileId/stream`

### Database Schema (`lib/db/src/schema/instagram.ts`)
- Uses `sqliteTable` from `drizzle-orm/sqlite-core`
- All tables auto-created on startup via `CREATE TABLE IF NOT EXISTS` in `lib/db/src/index.ts`
- DB path: `DATABASE_PATH` env var, or `database.db` in the process working directory
- `proxies` — proxy server configurations
- `profiles` — Instagram account profiles with credentials, settings, timers
- `tools` — automation tools (follow, dm, unfollow) per profile
- `sources` — hashtag/target sources for tools
- `followed_users` — users followed by automation
- `session_actions` — detailed action logs per session
- `instagram_api_calls` — API call tracking
- `stats` — daily/lifetime statistics
- `global_settings` — key-value settings
- `skipped_users` — globally skipped users
- `logs` — general logs
- `reposted_posts` — posts reposted by automation
- `contact_dm_sent` — DMs sent to new followers
- `contact_pending_messages` — DM send queue

## Windows Standalone Deployment

The app can be run on a Windows PC with no extra tooling:

1. Copy the entire project folder to the Windows PC
2. Double-click `start.bat` (or run it from Command Prompt)
   - `start.bat` runs: `npm install && node index.js`
   - `npm install` installs `better-sqlite3` (SQLite driver) and `puppeteer` (browser)
   - `node index.js` starts the server
3. Open `http://localhost:3000` in a browser

### How it works
- `index.js` (root) sets `PORT=3000` and `DATABASE_PATH=<project-dir>/database.db`, then imports the pre-built server bundle
- Pre-built bundle: `artifacts/api-server/dist/index.mjs` (esbuild, self-contained except native modules)
- Pre-built frontend: `artifacts/dannys-bot/dist/public/` (Vite build with `BASE_PATH=/`)
- SQLite database is auto-created on first run at `database.db` in the project root
- No PostgreSQL, no environment variables needed

### Rebuilding after code changes
- API server: `pnpm --filter @workspace/api-server run build`
- Frontend: `cd artifacts/dannys-bot && BASE_PATH=/ PORT=3000 pnpm run build`

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/dannys-bot run dev` — run frontend locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
