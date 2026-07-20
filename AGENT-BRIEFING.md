# Agent Briefing

Please do the following steps in order. Do not ask questions — just do it.

---

## Step 1 — Clone the private GitHub repo

Run this in the Shell (ask me for my GitHub PAT first):

```
git clone https://<PAT>@github.com/dannyshaw88/dannys-bot.git .
```

Replace `<PAT>` with the token I give you.

---

## Step 2 — Install dependencies

```
pnpm install
```

Wait for it to finish (~1 minute).

---

## Step 3 — Configure and start the two workflows

- **API Server**: `pnpm --filter @workspace/api-server run dev` — waits on port 3000
- **web**: `PORT=5000 API_PORT=3000 pnpm --filter @workspace/dannys-bot run dev` — waits on port 5000

Start both. The frontend will be visible in the Replit preview pane.

---

## What this project is (read before touching any code)

Danny's Bot (Equinox) — Instagram automation tool for real Android phones connected via USB on Windows. Replit is for **code editing only**. The built app runs on the user's Windows PC.

**Stack:** pnpm monorepo, Node.js 20, TypeScript 5.9, Express 5, SQLite + Drizzle ORM, React + Vite + Tailwind + shadcn/ui, Electron desktop wrapper.

---

## Key files

- `artifacts/dannys-bot/` — React frontend
- `artifacts/api-server/src/` — Express API server
- `artifacts/api-server/src/mobile/androidManager.ts` — Android/ADB automation
- `artifacts/api-server/src/routes/mobile.ts` — Mobile API routes + automation cycle
- `artifacts/electron/` — Electron desktop wrapper
- `lib/db/src/` — Drizzle schema + SQLite client
- `database.db` — SQLite database

---

## Rules that must never be broken

- **Never push to GitHub unless the user explicitly says to**
- **Never run `adb shell wm size` or `adb shell wm density`** — display is handled in software
- **Never add retry loops to automation actions** — if it fails, log it and move on
- **Never hardcode pixel coordinates** — always use the UIAutomator accessibility dump
- Every GitHub push needs a version bump in `package.json` (root) AND `artifacts/electron/package.json`, plus a new entry at the top of `CHANGELOG.md`

---

## How the user gets the Windows installer

1. Go to `github.com/dannyshaw88/dannys-bot/actions`
2. Click the latest successful run
3. Download **`Equinox-Windows-Installer`** (88MB) — NOT the 4MB `web-builds` artifact

---

## Known open issue

Build warning: `Import "getTools" will always be undefined` — in `artifacts/api-server/src/routes/mobile.ts` line ~6468. The function is called but not exported from `androidManager.ts`. Not yet fixed.

---

## Full detail

Once the repo is cloned, read `replit.md` in the project root for the complete rules, history, and non-obvious decisions.
