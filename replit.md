# Workspace

## Overview

Danny's Bot — an Instagram automation dashboard. pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **Frontend**: React + Vite + Tailwind CSS v4 + shadcn/ui components
- **Build**: esbuild (CJS bundle)
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

### Backend (`artifacts/api-server`)
- Express 5 API server served at `/api`
- Instagram automation engine (`src/instagram/automationEngine.ts`)
- Browser session management with Puppeteer (`src/instagram/browserSession.ts`)
- Instagram login and credential verification (`src/instagram/instagramLogin.ts`)
- Instagram web client for API interactions (`src/instagram/instagramWebClient.ts`)
- Proxy management and routing (`src/instagram/browserProxy.ts`)
- Hiker API integration (`src/instagram/hikerApiClient.ts`)
- WebSocket endpoint for real-time browser streaming at `/api/browser/:profileId/stream`

### Database Schema (`lib/db/src/schema/instagram.ts`)
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

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/dannys-bot run dev` — run frontend locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
