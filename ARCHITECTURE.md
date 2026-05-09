# Equinox — Architecture & Rules

---

## CRITICAL: Replit ≠ Windows — Logs and Errors Are NOT Comparable

**The Replit dev environment and the Windows installed app are fundamentally different
runtime environments. Errors or behaviour observed on Replit CANNOT be assumed to apply
to the Windows app, and vice versa.**

| | Replit (Linux dev) | Windows (packaged app) |
|---|---|---|
| **Who runs it** | Agent, for live editing | User, after rebuilding |
| **Chrome** | Nix-managed Chromium (hardcoded path) | User's Chrome/Edge/Brave found via `findChromiumPath()` |
| **API server startup** | `pnpm dev` directly | Electron main spawns it as a child process |
| **CHROMIUM_PATH** | Hardcoded Nix store path | Set via env var from Electron → child process |
| **Logs** | Replit workflow console | `%APPDATA%\Equinox\logs\<timestamp>.log` on disk |
| **Node.js** | Replit's system Node | Electron's bundled Node (v20) |
| **node_modules** | `artifacts/api-server/node_modules/` | Packaged into `resources/app/node_modules/` |
| **Dynamic imports** | Standard module resolution | Resolved via `NODE_PATH=resources/app/node_modules` |

**Do NOT debug Windows EB issues using Replit logs.** The only reliable way to diagnose
Windows failures is the Windows log file (see "Log File Location" below) or the
`/api/browser/debug` endpoint.

---

## Platform

- **User OS**: Windows 10/11, x64, packaged Electron app
- **Dev environment**: Replit (Linux, NixOS) — source editing only

---

## Core Architecture

API-based Instagram automation bot that emulates mobile sessions:
- **Instagram Private Mobile API** (`i.instagram.com`) — all bot actions (follow, DM, like, etc.)
- **HikerAPI** — follower/following data with v2→v1 fallback on cache miss

---

## Embedded Browser (EB) — Rules

- The EB is **ONLY** for human browsing and CAPTCHA/checkpoint challenges
- **NEVER** use the EB or any browser automation for bot actions
- **NEVER** use web scraping or browser automation to perform Instagram actions
- All Instagram actions go through the Mobile Private API or HikerAPI

---

## EB Browser Engine

- **Windows (packaged)**: `findChromiumPath()` in `electron/src/main.ts` scans known
  install paths for Chrome, Edge, or Brave. The found path is passed as `CHROMIUM_PATH`
  env var to the API server child process. `puppeteer-core` launches it with
  `headless: true` + isolated `--user-data-dir` in `os.tmpdir()` — completely invisible,
  never touches the user's personal browser profile.
- **Linux/dev (Replit)**: Falls back to the hardcoded Nix store Chromium path
- `--no-zygote` is intentionally **excluded** — it crashes Chrome silently on Windows
  when combined with `--no-sandbox`
- **NO downloading** of Chrome — uses whatever browser is already installed
- If no browser is found: error "Please install Google Chrome or Microsoft Edge, then restart Equinox"

### EB Diagnostics

- Hit `http://127.0.0.1:32987/api/browser/debug` from any browser on the machine to see
  a JSON snapshot: CHROMIUM_PATH, whether it exists, puppeteer-core availability, etc.
- All `[EB-DEBUG]` lines appear in the Windows log file — search for them when diagnosing

---

## Full Build Pipeline (Replit → Windows)

Source code lives on Replit. Changes only reach the Windows machine via a full rebuild.

```
Replit (edit) → push-to-git → GitHub main branch
                                      ↓
                          git pull on Windows machine
                                      ↓
          pnpm --filter @workspace/api-server run build
            → artifacts/api-server/dist/index.mjs  (esbuild bundle, ESM)
                                      ↓
          pnpm --filter @workspace/dannys-bot run build
            → artifacts/dannys-bot/dist/public/    (Vite bundle)
                                      ↓
          cd artifacts/electron && pnpm run build   (node build.mjs)
            → dist/main.js            (Electron main, CJS)
            → dist/preload.js         (Electron preload, CJS)
            → dist/server/            (copied from api-server/dist/)
            → dist/server/start.mjs   (generated crash-logging wrapper)
            → dist/frontend/public/   (copied from dannys-bot/dist/public/)
                                      ↓
          cd artifacts/electron && pnpm run package
            → electron-builder --win --publish always
            → release/equinox-setup-<version>.exe  (NSIS installer)
            → auto-published to GitHub Releases
                                      ↓
                      User installs equinox-setup-*.exe
```

### What the Electron package contains

`asar: false` — everything is plain files inside `resources/app/`:
- `dist/main.js` — Electron main process (compiled from `electron/src/main.ts`)
- `dist/server/` — API server bundle (copied from `api-server/dist/`)
- `dist/server/start.mjs` — crash-logging wrapper that is the actual entry point
- `dist/frontend/public/` — React UI (copied from `dannys-bot/dist/public/`)
- `node_modules/` — all npm deps including `puppeteer-core`, `better-sqlite3`, etc.

### How the packaged app starts

1. Electron loads `dist/main.js`
2. `main.js` calls `findChromiumPath()` → scans for Chrome/Edge/Brave → logs all paths checked
3. `main.js` calls `startServer(port, logPath)` → spawns `node dist/server/start.mjs` with env:
   - `CHROMIUM_PATH` = found browser path (or empty if none found)
   - `NODE_PATH` = `resources/app/node_modules`
   - `LOG_FILE` = path to the log file on disk
   - `PORT`, `DATABASE_PATH`, `FRONTEND_DIST_PATH`, etc.
4. `start.mjs` patches `console.*` and stdout/stderr to write timestamped lines to `LOG_FILE`
5. `start.mjs` imports `index.mjs` (the API server)
6. Electron loads the frontend from `dist/frontend/public/` via the API server's static file serving

### Log File Location (Windows)

```
%APPDATA%\Equinox\logs\<timestamp>.log
```

Typically: `C:\Users\<name>\AppData\Roaming\Equinox\logs\`

All `console.log`, `console.error`, pino JSON, and `[EB-DEBUG]` lines go here.

---

## Key Files

| File | Purpose |
|---|---|
| `artifacts/electron/src/main.ts` | Electron main: `findChromiumPath()`, `startServer()`, auto-updater |
| `artifacts/electron/build.mjs` | Assembles all three components into `dist/` |
| `artifacts/electron/electron-builder.json` | NSIS installer config, GitHub publish |
| `artifacts/api-server/src/instagram/browserSession.ts` | EB session: puppeteer launch, frame streaming |
| `artifacts/api-server/src/routes/instagram.ts` | All routes incl. `/api/browser/debug`, SSE stream |
| `artifacts/dannys-bot/src/components/BrowserPanel.tsx` | EB React UI panel, SSE consumer, error display |

---

## Git Push Rule

- **NEVER push to GitHub** unless the user types exactly `push-to-git`
- Push method: GET ref → GET commit → POST blobs → POST tree → POST commit → PATCH ref
- Repo: `dannyshaw88/dannys-bot`, branch `main`
- After pushing: user must do a full rebuild for changes to reach their Windows machine

---

## Icons

- Source: `artifacts/dannys-bot/public/bot-logo.png` (260×260)
- `artifacts/electron/assets/icon.ico` — multi-size ICO (256/128/64/48/32/16px)
- `artifacts/electron/assets/icon.png` — 256×256 PNG
- After reinstalling: run `ie4uinit.exe -show` or log out/in to clear Windows icon cache

---

## API Limits

- `everySecondsMin/Max` values in the DB are in **milliseconds**
- UI values of 1000–30000 = 1–30 second intervals between API calls
