# Workspace

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
