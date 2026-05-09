# Equinox — Architecture & Rules

## Platform
- **User OS**: Windows (packaged Electron app)
- **Dev environment**: Replit (Linux) — Nix-managed Chromium for EB sessions in dev

## Core Architecture
This is an **API-based Instagram automation bot** that emulates mobile sessions via:
- **Instagram Private Mobile API** (`i.instagram.com`) — all bot actions (follow, DM, like, etc.)
- **HikerAPI** — follower/following data with v2→v1 fallback on cache miss

## Embedded Browser (EB) — Rules
- The EB is **ONLY** for human browsing and CAPTCHA/checkpoint challenges
- **NEVER** use the EB or any browser automation for bot actions
- **NEVER** use web scraping or browser automation to perform Instagram actions
- All Instagram actions go through the Mobile Private API or HikerAPI

## EB Browser Engine
- **Windows (packaged)**: Uses puppeteer's own **Chrome for Testing** — completely self-contained, never touches the user's personal Chrome/Edge/Brave
  - `PUPPETEER_CACHE_DIR` = `{userData}/puppeteer-cache` (set by Electron main.ts)
  - On first EB launch: auto-downloads Chrome for Testing (~180 MB) via `puppeteer/install.mjs`
  - Subsequent launches: instant (Chrome already cached)
- **Linux/dev (Replit)**: Uses Nix-managed Chromium at `/nix/store/...`
- Each session gets an isolated `--user-data-dir` in `os.tmpdir()/equinox-eb-<profileId>`

## Key Files
- `artifacts/electron/src/main.ts` — Electron main process, server spawn, `PUPPETEER_CACHE_DIR` env
- `artifacts/api-server/src/instagram/browserSession.ts` — EB session management, Puppeteer launch
- `artifacts/api-server/src/instagram/hikerApiClient.ts` — HikerAPI v2/v1 follower fallback
- `artifacts/api-server/src/routes/instagram.ts` — all Instagram API routes
- `artifacts/dannys-bot/src/components/BrowserPanel.tsx` — EB UI panel (SSE canvas stream)
- `artifacts/electron/electron-builder.json` — Windows build config, icon paths

## Git Push Rule
- **NEVER push to GitHub** unless the user types exactly `push-to-git`
- Push method: GET ref → GET commit → POST blobs → POST tree → POST commit → PATCH ref
- Repo: `dannyshaw88/dannys-bot`, branch `main`

## Icons
- Source: `artifacts/dannys-bot/public/bot-logo.png` (the actual UI logo, 260×260)
- `artifacts/electron/assets/icon.ico` — multi-size (256/128/64/48/32/16px) from bot-logo.png
- `artifacts/electron/assets/icon.png` — 256×256 from bot-logo.png
- After reinstalling on Windows: run `ie4uinit.exe -show` or log out/in to clear icon cache

## API Limits
- `everySecondsMin/Max` values in the DB are in **milliseconds**
- UI values of 1000–30000 = 1–30 second intervals between API calls
