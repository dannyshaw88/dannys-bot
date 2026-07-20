# Agent Briefing — Paste this at the start of a new conversation

This is Danny's Bot (Equinox) — an Instagram automation tool. It has just been imported from GitHub. Here is everything you need to know to get it running without wasting time re-discovering it.

---

## What this project is

- Instagram automation tool for real Android phones connected via USB on Windows
- Replit is used for **code editing only** — the built app runs on the user's Windows PC
- It is a pnpm monorepo (Node.js 20, TypeScript 5.9)

---

## How to set it up on a fresh Replit import (do this first, no need to ask)

1. Run in the Shell:
   ```
   pnpm install
   ```
2. Start the two workflows:
   - **API Server**: `pnpm --filter @workspace/api-server run dev` (port 3000)
   - **web**: `PORT=5000 API_PORT=3000 pnpm --filter @workspace/dannys-bot run dev` (port 5000)
3. Both should come up cleanly. The frontend is visible in the Replit preview pane.

That is the entire setup. No secrets are needed to run in dev mode on Replit.

---

## Key files

- `artifacts/dannys-bot/` — React frontend (Vite, Wouter, shadcn/ui)
- `artifacts/api-server/src/` — Express 5 API server
- `artifacts/api-server/src/mobile/androidManager.ts` — All Android/ADB automation
- `artifacts/api-server/src/routes/mobile.ts` — Mobile API routes + automation cycle
- `artifacts/api-server/src/storage.ts` — DB access layer
- `artifacts/electron/` — Electron desktop app wrapper
- `lib/db/src/` — Drizzle schema + SQLite client
- `database.db` — SQLite database (workspace root)

---

## Known open issue (Task #2)

Build warning: `Import "getTools" will always be undefined` in `src/routes/mobile.ts` line ~6468. The function is called but not exported from `androidManager.ts`. Has not been fixed yet.

---

## Rules that must never be broken

- **Never push to GitHub unless the user explicitly says to**
- **Never call `adb shell wm size` or `adb shell wm density`** — display settings are handled in software
- **Never add retry loops to automation actions** — if something fails, log it and move on
- **Never hardcode pixel coordinates** — always use the UIAutomator accessibility dump to find real element positions
- Every GitHub push needs a version bump in both `package.json` (root) and `artifacts/electron/package.json`, plus a new entry at the top of `CHANGELOG.md`

---

## How the user gets the Windows installer

1. Go to `github.com/dannyshaw88/dannys-bot/actions`
2. Click the latest successful run
3. Download **`Equinox-Windows-Installer`** (88MB) — NOT the 4MB `web-builds` artifact

---

## Full project detail

See `replit.md` in the project root — it has the complete rules, stack details, and history of non-obvious decisions.
