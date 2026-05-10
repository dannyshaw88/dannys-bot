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
