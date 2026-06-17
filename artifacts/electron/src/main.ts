import { app, BrowserWindow, Menu, Tray, nativeImage, dialog, ipcMain, screen, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { spawn, ChildProcess, exec } from "child_process";
import { promisify } from "util";
import http from "http";
import net from "net";
import fs from "fs";
import path from "path";
import os from "os";
import { startEbIpcServer, openEbWindow, focusEbWindow, ebMap, cookieFilePath, setEbLogPath } from "./ebManager";
import { session as electronSession } from "electron";

// ── Main-process crash capture ────────────────────────────────────────────────
// The Electron main process discards console.log in production (no DevTools).
// These handlers write directly to the log file so crashes in openEbWindow and
// other main-process code appear in logs.log alongside the server output.
let _mainLogPath = "";
let _serverDebugLogPath = "";

function appendToMainLog(msg: string): void {
  const line = `[${new Date().toISOString()}] [MAIN] ${msg}\n`;
  try { process.stderr.write(line); } catch {}
  if (_mainLogPath) {
    try { fs.appendFileSync(_mainLogPath, line); } catch {}
  }
  // Also tee to equinox-debug.log so IPC logs appear in the same file the user shares
  if (_serverDebugLogPath) {
    try { fs.appendFileSync(_serverDebugLogPath, line); } catch {}
  }
}

process.on("uncaughtException", (err: Error) => {
  const msg = `UNCAUGHT EXCEPTION: ${err?.stack || err?.message || String(err)}`;
  appendToMainLog(msg);
});

process.on("unhandledRejection", (reason: unknown) => {
  const msg = `UNHANDLED REJECTION: ${(reason as any)?.stack || (reason as any)?.message || String(reason)}`;
  appendToMainLog(msg);
});

const execAsync = promisify(exec);

let serverPort = 0;
let serverProc: ChildProcess | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let splashWin: BrowserWindow | null = null;
let splashIconDataUrl = "";

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

// Try a fixed preferred port first so that localStorage persists across restarts
// (Electron loads from http://127.0.0.1:<port> and localStorage is origin-scoped).
// Falls back to a random free port if the preferred one is already taken.
const PREFERRED_PORT = 32987;
function getServerPort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(PREFERRED_PORT, "127.0.0.1", () => {
      probe.close(() => resolve(PREFERRED_PORT));
    });
    probe.on("error", () => {
      findFreePort().then(resolve).catch(() => resolve(19876));
    });
  });
}

function getUserDataPath(): string {
  const p = app.getPath("userData");
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function getServerEntry(): string {
  if (app.isPackaged) {
    // asar:false → files live under resources/app/ (not app.asar.unpacked/)
    return path.join(process.resourcesPath, "app", "dist", "server", "start.mjs");
  }
  return path.join(__dirname, "..", "dist", "server", "start.mjs");
}

function getFrontendPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app", "dist", "frontend", "public");
  }
  return path.join(__dirname, "..", "dist", "frontend", "public");
}

function getIconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app", "dist", "assets", "icon.png");
  }
  return path.join(__dirname, "..", "assets", "icon.png");
}

function getTrayIconPath(): string {
  // Use the same icon.ico as the .exe so the tray icon matches the app icon.
  if (process.platform === "win32") {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, "app", "dist", "assets", "icon.ico");
    }
    return path.join(__dirname, "..", "assets", "icon.ico");
  }
  return getIconPath();
}

function buildSplashHtml(label: string, iconDataUrl: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{
  width:100%;height:100%;
  background:#ffffff;
  display:flex;flex-direction:column;
  align-items:center;justify-content:center;
  font-family:'Segoe UI',system-ui,sans-serif;
  overflow:hidden;user-select:none;
}
img{width:88px;height:88px;margin-bottom:28px;border-radius:16px;}
.title{font-size:22px;font-weight:700;color:#0f172a;letter-spacing:0.02em;margin-bottom:6px;}
.label{font-size:11px;color:rgba(0,0,0,0.38);letter-spacing:0.12em;text-transform:uppercase;margin-bottom:28px;}
.bar-track{width:220px;height:3px;background:rgba(0,0,0,0.10);border-radius:999px;overflow:hidden;}
.bar-fill{
  height:100%;width:45%;
  background:linear-gradient(90deg,transparent,#334155,transparent);
  border-radius:999px;
  animation:sweep 1.6s ease-in-out infinite;
}
@keyframes sweep{
  0%{transform:translateX(-200%);}
  100%{transform:translateX(620%);}
}
</style></head>
<body>
  <img src="${iconDataUrl}" />
  <div class="title">Equinox</div>
  <div class="label">${label}</div>
  <div class="bar-track"><div class="bar-fill"></div></div>
</body></html>`;
}

function createSplash(label = "Loading…"): void {
  if (splashWin && !splashWin.isDestroyed()) {
    splashWin.close();
    splashWin = null;
  }
  try {
    if (!splashIconDataUrl) {
      splashIconDataUrl = nativeImage.createFromPath(getIconPath()).toDataURL();
    }
  } catch {}

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const W = 420, H = 300;

  splashWin = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round((width - W) / 2),
    y: Math.round((height - H) / 2),
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  splashWin.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(buildSplashHtml(label, splashIconDataUrl))}`
  );
  splashWin.once("ready-to-show", () => splashWin?.show());
}

function closeSplash(): void {
  if (splashWin && !splashWin.isDestroyed()) {
    splashWin.close();
    splashWin = null;
  }
}

function waitForServer(port: number, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  return new Promise<void>((resolve, reject) => {
    function attempt() {
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume();
        resolve();
      });
      req.setTimeout(1500, () => req.destroy());
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error("timeout waiting for server"));
        } else {
          setTimeout(attempt, 600);
        }
      });
    }
    attempt();
  });
}

function findChromiumPath(): string {
  console.log("[EB-DEBUG][findChromiumPath] platform=" + process.platform);
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || "";
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    console.log("[EB-DEBUG][findChromiumPath] LOCALAPPDATA=" + localAppData);
    console.log("[EB-DEBUG][findChromiumPath] ProgramFiles=" + programFiles);
    console.log("[EB-DEBUG][findChromiumPath] ProgramFiles(x86)=" + programFilesX86);
    const candidates = [
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ];
    for (const p of candidates) {
      let exists = false;
      try { exists = fs.existsSync(p); } catch {}
      console.log(`[EB-DEBUG][findChromiumPath] CHECK: ${p} → ${exists ? "FOUND ✓" : "not found"}`);
      if (exists) {
        console.log("[EB-DEBUG][findChromiumPath] RESULT: " + p);
        return p;
      }
    }
    console.log("[EB-DEBUG][findChromiumPath] RESULT: NOT FOUND — no browser detected on this machine");
    return "";
  }
  // Linux / macOS (dev environment — Nix-managed Chromium)
  const nixPath = process.env.CHROMIUM_PATH
    || "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium";
  console.log("[EB-DEBUG][findChromiumPath] RESULT (Linux/Mac): " + nixPath);
  return nixPath;
}

function rotateLogs(logPath: string): void {
  // Keep up to 3 previous sessions: logs → logs.1 → logs.2 → logs.3 (oldest dropped)
  try {
    for (let i = 3; i >= 1; i--) {
      const older = logPath.replace(/(\.[^.]+)?$/, `.${i}$1`);
      const newer = i === 1 ? logPath : logPath.replace(/(\.[^.]+)?$/, `.${i - 1}$1`);
      if (fs.existsSync(newer)) {
        try { fs.renameSync(newer, older); } catch {}
      }
    }
  } catch {}
}

function startServer(port: number, logPath: string, ebIpcPort = 0): void {
  // Rotate previous log so it survives the next restart (logs → logs.1 → logs.2 → logs.3)
  rotateLogs(logPath);

  const entry = getServerEntry();
  const dbPath = path.join(getUserDataPath(), "database.db");
  const frontendPath = getFrontendPath();
  const chromiumPath = findChromiumPath();
  console.log("[EB-DEBUG][startServer] log file: " + logPath);
  console.log("[EB-DEBUG][startServer] CHROMIUM_PATH being passed to server: " + (chromiumPath || "(empty — browser not found)"));

  // With asar:false all files live under resources/app/, so node_modules is a real directory
  // that plain Node.js (ELECTRON_RUN_AS_NODE=1) can resolve packages from.
  // NODE_PATH makes it an explicit search root so dynamic imports (puppeteer-core etc.) work
  // regardless of where in dist/ the entry file lives.
  const nodeModulesPath = app.isPackaged
    ? path.join(process.resourcesPath, "app", "node_modules")
    : "";

  serverProc = spawn(process.execPath, [entry], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(port),
      HOST: "127.0.0.1",
      DATABASE_PATH: dbPath,
      FRONTEND_DIST_PATH: frontendPath,
      NODE_ENV: "production",
      LOG_LEVEL: "trace",
      LOG_FILE: logPath,
      // The instagram-private-api library uses the old `request-promise` HTTP library
      // which on Windows does not use the system certificate store.  Setting this
      // environment variable tells Node.js to skip TLS certificate verification so
      // that all outbound HTTPS calls to Instagram's API succeed regardless of the
      // Windows OpenSSL cert dashboard state.  This is safe in the Electron context
      // because all connections go to known Instagram endpoints.
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      ...(nodeModulesPath ? { NODE_PATH: nodeModulesPath } : {}),
      ...(chromiumPath ? { CHROMIUM_PATH: chromiumPath } : {}),
      ...(ebIpcPort   ? { EB_IPC_PORT: String(ebIpcPort) } : {}),
      IDEVICE_BIN_DIR: app.isPackaged
        ? path.join(process.resourcesPath, "bin", "win32")
        : path.join(__dirname, "..", "..", "resources", "bin", "win32"),
    },
  });

  // Open fresh log file (flags:"w") and write a session-start marker so sessions
  // are clearly separated even when multiple log files are present.
  const logStream = fs.createWriteStream(logPath, { flags: "w" });
  const sessionStart = `[${new Date().toISOString()}] server-start: session started (v${app.getVersion()})\n`;
  logStream.write(sessionStart);
  serverProc.stdout?.on("data", (d: Buffer) => logStream.write(d));
  serverProc.stderr?.on("data", (d: Buffer) => logStream.write(d));
  serverProc.on("exit", () => logStream.end());
}

function restartApp(): void {
  app.relaunch();
  isQuitting = true;
  app.quit();
}

// Inline HTML for the tray popup — sharp corners, no native chrome
const TRAY_MENU_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden}
body{
  font-family:'Segoe UI',system-ui,sans-serif;
  font-size:13px;
  background:#ffffff;
  border:1px solid #b0b0b0;
  color:#1a1a1a;
  user-select:none;
  cursor:default;
}
.item{
  padding:7px 18px;
  white-space:nowrap;
}
.item:hover{background:#0078d4;color:#ffffff}
.sep{height:1px;background:#e0e0e0;margin:3px 0}
</style></head>
<body>
<div class="item" onclick="window.trayMenuAPI.openApp()">Open Equinox</div>
<div class="sep"></div>
<div class="item" onclick="window.trayMenuAPI.restartApp()">Restart Equinox</div>
<div class="sep"></div>
<div class="item" onclick="window.trayMenuAPI.closeApp()">Close Equinox</div>
</body></html>`;

// Dimensions must match the HTML content exactly
const POPUP_W = 220;
const POPUP_H = 3 * 33 + 2 * 7; // 3 items + 2 separators (with margins)

let trayPopup: BrowserWindow | null = null;

function createTray(): void {
  const trayIconPath = getTrayIconPath();
  let icon: Electron.NativeImage;

  try {
    icon = nativeImage.createFromPath(trayIconPath);
    // Only resize PNG paths — ICO files already embed multiple sizes
    if (!trayIconPath.endsWith(".ico")) {
      icon = icon.resize({ width: 16, height: 16 });
    }
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip(`Equinox v${app.getVersion()}`);

  // Create the custom square popup window (hidden until right-click)
  trayPopup = new BrowserWindow({
    width: POPUP_W,
    height: POPUP_H,
    frame: false,
    transparent: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    roundedCorners: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "trayMenuPreload.js"),
    },
  });

  trayPopup.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(TRAY_MENU_HTML)}`
  );

  // Hide popup when it loses focus
  trayPopup.on("blur", () => trayPopup?.hide());

  // IPC handlers for tray menu actions
  ipcMain.on("tray-open", () => {
    trayPopup?.hide();
    if (win?.isMinimized()) win?.restore();
    win?.show();
    win?.focus();
  });

  ipcMain.on("tray-restart", () => {
    trayPopup?.hide();
    restartApp();
  });

  ipcMain.on("tray-close", () => {
    trayPopup?.hide();
    isQuitting = true;
    app.quit();
  });

  // Left-click: toggle main window (minimize/restore — never hide, to keep
  // the taskbar button anchored in its original leftmost position)
  tray.on("click", () => {
    trayPopup?.hide();
    if (win?.isMinimized()) {
      win.restore();
      win.focus();
    } else if (win?.isVisible()) {
      win.minimize();
    } else {
      win?.show();
      win?.focus();
    }
  });

  // Right-click: position and show the custom popup above the tray icon
  tray.on("right-click", () => {
    if (trayPopup?.isVisible()) {
      trayPopup.hide();
      return;
    }
    const bounds = tray!.getBounds();
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
    const workArea = display.workArea;

    // Position: above the tray icon, horizontally centred on it
    let x = Math.round(bounds.x + bounds.width / 2 - POPUP_W / 2);
    let y = Math.round(bounds.y - POPUP_H - 4);

    // Keep within screen work area
    x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - POPUP_W));
    y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - POPUP_H));

    trayPopup!.setPosition(x, y);
    trayPopup!.show();
    trayPopup!.focus();
  });
}

declare const __UPDATER_TOKEN__: string;

// true while a user-initiated check is in progress — background checks are silent
let _updaterManualCheck = false;

function setupAutoUpdater(): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Private repo — token is baked in at build time from the UPDATER_TOKEN
  // GitHub Actions secret via DANNY_BOT_UPDATER_TOKEN env var in build.mjs.
  autoUpdater.setFeedURL({
    provider: "github",
    owner: "dannyshaw88",
    repo: "dannys-bot",
    token: __UPDATER_TOKEN__,
  } as any);

  // Always show the "restart to apply" dialog — an update being ready is
  // important regardless of whether the check was automatic or manual.
  autoUpdater.on("update-downloaded", () => {
    if (!win) return;
    dialog.showMessageBox(win, {
      type: "info",
      title: "Update Ready",
      message: "Equinox has been updated. Restart now to apply?",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall(false, true);
    });
  });

  // Only tell the user they are up-to-date when they explicitly asked.
  autoUpdater.on("update-not-available", () => {
    if (!_updaterManualCheck || !win) return;
    _updaterManualCheck = false;
    dialog.showMessageBox(win, {
      type: "info",
      title: "Up to Date",
      message: "You are up to date — Equinox is running the latest version.",
      buttons: ["OK"],
    });
  });

  // Background check errors (e.g. expired token, no internet) are logged
  // silently.  Only surface a dialog when the user manually triggered the check.
  autoUpdater.on("error", (err) => {
    const raw = String(err?.message || err);
    console.warn("[updater] error:", raw);
    if (!_updaterManualCheck || !win) return;
    _updaterManualCheck = false;

    // Translate common API errors into plain-English messages instead of
    // dumping the raw GitHub API response at the user.
    let message: string;
    if (/401|bad credentials|unauthorized/i.test(raw)) {
      message = "The update token has expired. To fix this:\n\n1. Generate a new GitHub personal access token with \"repo\" scope at github.com/settings/tokens\n2. Set it as the UPDATER_TOKEN secret in your GitHub repository (Settings → Secrets → Actions)\n3. Rebuild and install the new version\n\nUpdates will work normally in the new build.";
    } else if (/404|not found|no releases/i.test(raw)) {
      message = "No release has been published yet on GitHub. The update feed will become available after the first successful build publishes a release.";
    } else if (/ENOTFOUND|ECONNREFUSED|network|timeout|socket/i.test(raw)) {
      message = "Could not reach GitHub — check your internet connection and try again.";
    } else {
      // Trim the raw message to the first sentence/line so it stays readable
      message = raw.split(/\n/)[0].slice(0, 200);
    }

    dialog.showMessageBox(win, {
      type: "error",
      title: "Update Check Failed",
      message,
      buttons: ["OK"],
    });
  });

  // Background check — silent, runs once shortly after startup.
  setTimeout(() => {
    _updaterManualCheck = false;
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn("[updater] background check failed:", err?.message ?? err);
    });
  }, 5000);
}

// ── Backup helpers ────────────────────────────────────────────────────────────

const MAX_BACKUPS = 3;

// ── Backup & Restore ──────────────────────────────────────────────────────────

type BackupEntry = { id: string; date: string; size: number };

let autoBackupTimer: NodeJS.Timeout | null = null;

function getBackupsDir(): string {
  return path.join(getUserDataPath(), "backups");
}

function formatBackupId(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function runPsScript(script: string): Promise<void> {
  const tmp = path.join(os.tmpdir(), `db-bak-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, script, "utf8");
  try {
    await execAsync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function createBackupNow(): Promise<{ ok: boolean; entry?: BackupEntry; error?: string }> {
  const userData = getUserDataPath();
  const backupsDir = getBackupsDir();
  const id = formatBackupId(new Date());
  const backupFolder = path.join(backupsDir, id);
  const dbSrc = path.join(userData, "database.db");
  const dbDst = path.join(backupFolder, "backup.db");

  try {
    if (!fs.existsSync(dbSrc)) {
      return { ok: false, error: "database.db not found" };
    }
    fs.mkdirSync(backupFolder, { recursive: true });

    // Copy only the SQLite database file — no PowerShell, no zip, no browser cache.
    // Node.js fs.copyFileSync works at the OS level and can read the file even
    // while the database server has it open (SQLite WAL mode allows concurrent reads).
    fs.copyFileSync(dbSrc, dbDst);

    // Copy WAL/SHM if present for a more consistent point-in-time snapshot.
    for (const ext of ["-wal", "-shm"]) {
      const src = dbSrc + ext;
      if (fs.existsSync(src)) {
        try { fs.copyFileSync(src, dbDst + ext); } catch {}
      }
    }

    const size = fs.statSync(dbDst).size;
    const meta = { date: new Date().toISOString(), size };
    fs.writeFileSync(path.join(backupFolder, "meta.json"), JSON.stringify(meta));

    pruneOldBackups(MAX_BACKUPS);

    return { ok: true, entry: { id, date: meta.date, size } };
  } catch (err: any) {
    try { fs.rmSync(backupFolder, { recursive: true, force: true }); } catch {}
    return { ok: false, error: String(err?.message ?? err) };
  }
}

function pruneOldBackups(keep: number): void {
  const entries = listBackupsNow();
  for (const e of entries.slice(keep)) {
    try { fs.rmSync(path.join(getBackupsDir(), e.id), { recursive: true, force: true }); } catch {}
  }
}

function listBackupsNow(): BackupEntry[] {
  const dir = getBackupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => {
      const d = path.join(dir, name);
      if (!fs.statSync(d).isDirectory()) return false;
      return fs.existsSync(path.join(d, "backup.db")) || fs.existsSync(path.join(d, "backup.zip"));
    })
    .sort((a, b) => b.localeCompare(a))
    .map((name) => {
      const metaPath = path.join(dir, name, "meta.json");
      let date = name;
      let size = 0;
      try {
        const m = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        date = m.date;
        size = m.size;
      } catch {
        const dbFile = path.join(dir, name, "backup.db");
        const zipFile = path.join(dir, name, "backup.zip");
        try { size = fs.statSync(fs.existsSync(dbFile) ? dbFile : zipFile).size; } catch {}
      }
      return { id: name, date, size };
    });
}

function getLastBackupDate(): Date | null {
  const entries = listBackupsNow();
  if (!entries.length) return null;
  try { return new Date(entries[0].date); } catch { return null; }
}

async function restoreBackupNow(id: string): Promise<{ ok: boolean; error?: string }> {
  const backupFolder = path.join(getBackupsDir(), id);
  const dbBackup = path.join(backupFolder, "backup.db");
  const zipBackup = path.join(backupFolder, "backup.zip");
  const userData = getUserDataPath();
  const dbDst = path.join(userData, "database.db");

  const hasDb = fs.existsSync(dbBackup);
  const hasZip = fs.existsSync(zipBackup);
  if (!hasDb && !hasZip) return { ok: false, error: "Backup file not found" };

  try {
    if (serverProc) { serverProc.kill(); serverProc = null; }
    await new Promise((r) => setTimeout(r, 1200));

    if (hasDb) {
      // New format: copy database.db back directly — no PowerShell needed.
      fs.copyFileSync(dbBackup, dbDst);
      // Remove stale WAL/SHM so SQLite starts clean from the restored snapshot.
      for (const ext of ["-wal", "-shm"]) {
        try { fs.rmSync(dbDst + ext, { force: true }); } catch {}
      }
    } else {
      // Legacy zip format fallback.
      if (process.platform === "win32") {
        await runPsScript([
          `$zip = '${zipBackup.replace(/'/g, "''")}'`,
          `$dst = '${userData.replace(/'/g, "''")}'`,
          `Expand-Archive -Path $zip -DestinationPath $dst -Force`,
        ].join("\n"));
      } else {
        await execAsync(`unzip -o '${zipBackup.replace(/'/g, "'\\''")}' -d '${userData.replace(/'/g, "'\\''")}'`);
      }
    }

    app.relaunch();
    isQuitting = true;
    app.quit();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

function deleteBackupNow(id: string): { ok: boolean; error?: string } {
  const backupFolder = path.join(getBackupsDir(), id);
  if (!fs.existsSync(backupFolder)) return { ok: false, error: "Backup not found" };
  try {
    fs.rmSync(backupFolder, { recursive: true, force: true });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

function scheduleAutoBackup(enabled: boolean, intervalDays: number) {
  if (autoBackupTimer) { clearTimeout(autoBackupTimer); autoBackupTimer = null; }
  if (!enabled || intervalDays <= 0) return;

  const intervalMs = intervalDays * 24 * 60 * 60 * 1000;
  const last = getLastBackupDate();
  const msSinceLast = last ? Date.now() - last.getTime() : Infinity;

  const runAndReschedule = () => {
    createBackupNow().finally(() => scheduleAutoBackup(enabled, intervalDays));
  };

  if (msSinceLast >= intervalMs) {
    setTimeout(runAndReschedule, 5000);
  } else {
    autoBackupTimer = setTimeout(runAndReschedule, intervalMs - msSinceLast);
  }
}

async function initAutoBackup(port: number) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`);
    const s = await res.json();
    scheduleAutoBackup(s.backupEnabled ?? false, s.backupIntervalDays ?? 7);
  } catch {}
}

// ── UI Settings (column order/widths/visibility) ─────────────────────────────
// Persists to a JSON file in userData so column arrangements survive even if
// the server port changes between restarts (which would otherwise wipe the
// localStorage origin that holds these settings).

const uiSettingsPath = () => path.join(getUserDataPath(), "ui-settings.json");

function readUiSettings(): Record<string, unknown> {
  try {
    const p = uiSettingsPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  return {};
}

function writeUiSettings(data: Record<string, unknown>): void {
  try { fs.writeFileSync(uiSettingsPath(), JSON.stringify(data), "utf8"); } catch {}
}

function setupSettingsHandlers() {
  ipcMain.handle("settings-get", (_e, key: string) => readUiSettings()[key] ?? null);
  ipcMain.handle("settings-set", (_e, key: string, value: unknown) => {
    const data = readUiSettings();
    data[key] = value;
    writeUiSettings(data);
  });
  ipcMain.handle("settings-get-all", () => readUiSettings());
}

function setupBackupHandlers() {
  ipcMain.handle("backup-create", async () => createBackupNow());
  ipcMain.handle("backup-list", () => listBackupsNow());
  ipcMain.handle("backup-restore", async (_e, id: string) => restoreBackupNow(id));
  ipcMain.handle("backup-delete", (_e, id: string) => deleteBackupNow(id));
  ipcMain.handle("backup-open-dir", async () => {
    const dir = getBackupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const { shell } = await import("electron");
    await shell.openPath(dir);
  });
  ipcMain.on("backup-schedule-update", (_e, { enabled, intervalDays }) => {
    scheduleAutoBackup(enabled, intervalDays);
  });

  // Tracks profileIds whose EB window is currently being opened.
  // Guards against double-click / rapid IPC duplicates that race past the ebMap check
  // in openEbWindow (the map is only written near the END of that async function, so a
  // second call arriving while the first is mid-flight sees an empty map and spawns a
  // second window).
  const pendingEbOpens = new Set<number>();

  // open-browser-window: opens a NATIVE Electron BrowserWindow that loads
  // Instagram directly — no Puppeteer, no screencasting, no canvas.
  // This is the Jarvee-style CEF embedded browser approach.
  ipcMain.handle("open-browser-window", (_event, { profileId, username }: any) => {
    if (!profileId) return;
    if (pendingEbOpens.has(profileId)) return; // second click arrived before first window opened
    pendingEbOpens.add(profileId);
    // Fire-and-forget — do NOT await openEbWindow here.  ipcRenderer.invoke
    // waits for the handle() callback to return before resolving, so awaiting
    // the entire window setup (proxy fetch + cookie load + Chromium launch)
    // keeps the UI frozen for up to 10 s before the browser icon reacts.
    // Returning immediately unblocks the caller; the window appears shortly after.
    void (async () => {
      try {
        let proxy: { host: string; port: number; user?: string; pass?: string; type?: string } | undefined;
        let userAgent: string | undefined;
        let apiUA: string | undefined;
        let ebFingerprint: any | undefined;
        try {
          // Single call to /eb-proxy — the API server resolves proxyId → proxy
          // fields using resolveProxyConfig(), the same path used by eb-auto-login.
          // Also returns apiUA + ebFingerprint so the fingerprint script uses the
          // account's stored device profile instead of random values each session.
          const r = await fetch(`http://127.0.0.1:${serverPort}/api/profiles/${profileId}/eb-proxy`);
          if (r.ok) {
            const data = await r.json();
            proxy         = data.proxy         || undefined;
            userAgent     = data.userAgent     || undefined;
            apiUA         = data.apiUA         || undefined;
            ebFingerprint = data.ebFingerprint
              ? (typeof data.ebFingerprint === "string" ? JSON.parse(data.ebFingerprint) : data.ebFingerprint)
              : undefined;
            if (proxy) {
              console.log(`[EB] Profile ${profileId}: proxy resolved → ${proxy.host}:${proxy.port}`);
            }
            if (!userAgent) {
              console.warn(`[EB] Profile ${profileId}: userAgentEmbedded is missing — EB will open with Electron default UA. Instagram may challenge the session.`);
            }
          } else {
            console.warn(`[EB] Profile ${profileId}: /eb-proxy fetch returned ${r.status} — EB will open with no UA override. Instagram may challenge the session.`);
          }
        } catch (fetchErr: any) {
          console.warn(`[EB] Profile ${profileId}: /eb-proxy fetch failed (${fetchErr?.message}) — EB will open with no UA override. Instagram may challenge the session.`);
        }

        await openEbWindow({
          profileId,
          username: username || String(profileId),
          proxy,
          userAgent,
          apiUA,
          ebFingerprint,
        });
      } catch (err: any) {
        console.error(`[EB] open-browser-window error for profile ${profileId}:`, err?.message);
      } finally {
        pendingEbOpens.delete(profileId);
      }
    })();
  });

  // clear-signup-browser-cache: wipe the Electron session + cookie file for the signup EB.
  ipcMain.handle("clear-signup-browser-cache", async () => {
    try {
      const pid = -1;
      // Destroy the window if it is open
      const existing = ebMap.get(pid);
      if (existing && !existing.win.isDestroyed()) {
        existing.win.destroy();
        await new Promise(r => setTimeout(r, 200));
        ebMap.delete(pid);
      }
      // Wipe session storage
      const ses = electronSession.fromPartition(`persist:eb-${pid}`);
      await ses.clearStorageData({
        storages: ["cookies", "localstorage", "cachestorage", "shadercache", "websql", "serviceworkers", "indexdb"],
      }).catch(() => {});
      await ses.clearCache().catch(() => {});
      // Delete cookie file
      const fp = cookieFilePath(pid);
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
      console.log("[EB] Signup browser cache cleared.");
    } catch (err: any) {
      console.error("[EB] clear-signup-browser-cache error:", err?.message);
    }
  });

  // open-signup-browser-window: open a native EB window for account creation.
  // Proxy and UA are passed directly — no profile lookup needed.
  ipcMain.handle("open-signup-browser-window", async (_event, { username, userAgent, proxyHost, proxyPort, proxyUsername, proxyPassword, proxyType }: any) => {
    try {
      const proxy = proxyHost && proxyPort ? {
        host: proxyHost,
        port: Number(proxyPort),
        user: proxyUsername || undefined,
        pass: proxyPassword || undefined,
        type: proxyType || undefined,
      } : undefined;
      await openEbWindow({
        profileId: -1,
        username: username || "Signup",
        proxy,
        userAgent,
      });
    } catch (err: any) {
      console.error("[EB] open-signup-browser-window error:", err?.message);
    }
  });

  // focus-browser-window: bring an already-open native EB window to the front.
  ipcMain.handle("focus-browser-window", (_event, profileId: number) => {
    focusEbWindow(profileId);
  });
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: `Equinox v${app.getVersion()}`,
    icon: getIconPath(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      devTools: !app.isPackaged,
    },
  });

  // Hide to system tray on close — the app keeps running with no taskbar button;
  // only the tray icon (created by createTray below) lets the user restore or quit.
  // We use hide() not minimize() — minimize() only collapses to the taskbar, which
  // is NOT system-tray behaviour. event.preventDefault() stops Electron from
  // destroying the window; hide() then removes it from both screen and taskbar.
  win.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win?.hide();
    }
  });

  // Place the log file next to the exe in the installation directory so it is
  // easy to find (e.g. AppData\Local\Programs\DannysBot\logs.log).
  // path.dirname(app.getPath("exe")) always resolves to the correct install
  // folder regardless of whether the user customised the install location.
  const logPath = path.join(path.dirname(app.getPath("exe")), "logs.log");

  // Wire crash capture to the log file so main-process errors appear in logs.log
  _mainLogPath = logPath;
  _serverDebugLogPath = path.join(getUserDataPath(), "equinox-debug.log");
  setEbLogPath(logPath);
  appendToMainLog(`app ready — v${app.getVersion()} pid=${process.pid}`);

  app.on("render-process-gone", (_e, contents, details) => {
    appendToMainLog(`RENDER PROCESS GONE: url=${contents.getURL()} reason=${details.reason} exitCode=${details.exitCode}`);
  });
  app.on("child-process-gone", (_e, details) => {
    appendToMainLog(`CHILD PROCESS GONE: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
  });

  serverPort = await getServerPort();

  // Start the native EB IPC server BEFORE the API server so EB_IPC_PORT is
  // available as an env var when the Node.js server process launches.
  const cookiesDir = path.join(getUserDataPath(), "browser-data");
  let ebIpcPort = 0;
  try {
    ebIpcPort = await startEbIpcServer(serverPort, cookiesDir, getIconPath());
    console.log(`[EB] Native IPC server started on port ${ebIpcPort}`);
  } catch (err) {
    console.error("[EB] Failed to start IPC server:", err);
  }

  startServer(serverPort, logPath, ebIpcPort);

  try {
    await waitForServer(serverPort);
    win.loadURL(`http://127.0.0.1:${serverPort}`);
  } catch {
    let logContent = "(no output captured)";
    try { logContent = fs.readFileSync(logPath, "utf8").slice(-1200); } catch {}

    const escaped = logContent.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    win.loadURL(
      `data:text/html,<html><body style="font-family:monospace;padding:20px;background:%231a1a2e;color:%23fff">` +
      `<h2 style="color:%23ff6b6b">Server failed to start</h2>` +
      `<p style="color:%23aaa;font-size:12px">Log: ${logPath}</p>` +
      `<pre style="background:%23111;padding:12px;border-radius:6px;font-size:11px;overflow:auto;white-space:pre-wrap">${escaped}</pre>` +
      `</body></html>`
    );
  }

  // Set document.title after load — index.html's static <title>Equinox</title>
  // would otherwise override the BrowserWindow title property.
  win.webContents.on("did-finish-load", () => {
    win?.webContents.executeJavaScript(
      `document.title = "Equinox v${app.getVersion()}";`
    ).catch(() => {});
  });

  win.once("ready-to-show", () => { closeSplash(); win?.show(); win?.maximize(); });
  win.on("closed", () => { win = null; });

  // Native cut/copy/paste/select-all context menu for all text inputs
  win.webContents.on("context-menu", (_event, params) => {
    const menu = Menu.buildFromTemplate([
      { role: "cut",       enabled: params.editFlags.canCut },
      { role: "copy",      enabled: params.editFlags.canCopy },
      { role: "paste",     enabled: params.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    ]);
    menu.popup({ window: win! });
  });

  createTray();
  setupSettingsHandlers();
  setupBackupHandlers();
  initAutoBackup(serverPort).catch(() => {});

  if (app.isPackaged) setupAutoUpdater();

  ipcMain.handle("open-log", async () => {
    const { shell } = await import("electron");
    const logFile = path.join(path.dirname(app.getPath("exe")), "logs.log");
    const err = await shell.openPath(logFile);
    if (err) {
      // Fall back to userData location used by older builds
      await shell.openPath(path.join(app.getPath("userData"), "logs.log"));
    }
  });

  ipcMain.handle("open-csv-temp", async (_e, { content, filename }: { content: string; filename: string }) => {
    const fsSync = await import("fs");
    const { shell } = await import("electron");
    // Write to Downloads so the file is in a known, permanent location
    const downloadsDir = app.getPath("downloads");
    const destPath = path.join(downloadsDir, filename);
    appendToMainLog(`[export-api-calls] open-csv-temp IPC received — filename=${filename} contentLength=${content?.length ?? 0} destPath=${destPath}`);
    try {
      fsSync.writeFileSync(destPath, content, "utf8");
      appendToMainLog(`[export-api-calls] CSV written to Downloads — revealing in Explorer`);
      // showItemInFolder opens File Explorer with the file highlighted — always appears
      // in front on Windows regardless of which app has focus, so the user can't miss it.
      shell.showItemInFolder(destPath);
      appendToMainLog(`[export-api-calls] shell.showItemInFolder called`);
      return { filePath: destPath };
    } catch (e: any) {
      appendToMainLog(`[export-api-calls] open-csv-temp THREW: ${e?.stack ?? e?.message ?? String(e)}`);
      throw e;
    }
  });

  ipcMain.handle("write-eqx-downloads", async (_e, files: Array<{ filename: string; data: string }>) => {
    const downloadsDir = app.getPath("downloads");
    appendToMainLog(`[export-eqx] write-eqx-downloads IPC received — fileCount=${files?.length ?? 0} downloadsDir=${downloadsDir}`);
    try {
      for (const { filename, data } of files) {
        const destPath = path.join(downloadsDir, filename);
        const buffer = Buffer.from(data, "base64");
        fs.writeFileSync(destPath, buffer);
        appendToMainLog(`[export-eqx] wrote ${filename} (${buffer.length} bytes) → ${destPath}`);
      }
      appendToMainLog(`[export-eqx] write-eqx-downloads complete — ${files.length} file(s) written to ${downloadsDir}`);
      return { count: files.length, folder: downloadsDir };
    } catch (e: any) {
      appendToMainLog(`[export-eqx] write-eqx-downloads THREW: ${e?.stack ?? e?.message ?? String(e)}`);
      throw e;
    }
  });

  ipcMain.handle("save-csv-dialog", async (_e, { content, filename }: { content: string; filename: string }) => {
    appendToMainLog(`[export-api-calls] save-csv-dialog IPC received — filename=${filename} contentLength=${content?.length ?? 0}`);
    try {
      const fsSync = await import("fs");
      const defaultPath = path.join(app.getPath("downloads"), filename);
      appendToMainLog(`[export-api-calls] showing save dialog — defaultPath=${defaultPath}`);
      const result = await dialog.showSaveDialog(win!, {
        title: "Save CSV",
        defaultPath,
        filters: [
          { name: "CSV Files", extensions: ["csv"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      appendToMainLog(`[export-api-calls] save dialog result — canceled=${result.canceled} filePath=${result.filePath ?? "none"}`);
      if (result.canceled || !result.filePath) return { saved: false };
      fsSync.writeFileSync(result.filePath, content, "utf8");
      appendToMainLog(`[export-api-calls] CSV written to disk — path=${result.filePath}`);
      return { saved: true, filePath: result.filePath };
    } catch (err: any) {
      appendToMainLog(`[export-api-calls] save-csv-dialog THREW: ${err?.stack ?? err?.message ?? String(err)}`);
      throw err;
    }
  });

  // Step 1 of the new two-phase EQX export flow: ask where to save BEFORE fetching data.
  ipcMain.handle("pick-eqx-folder", async () => {
    appendToMainLog(`[export-eqx] pick-eqx-folder IPC received`);
    try {
      // Focus + show the main window first so the folder picker opens on the same
      // monitor as the app (Windows places parentless dialogs on the primary monitor,
      // which may not be the monitor the user is looking at).
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
        await new Promise<void>(r => setTimeout(r, 80));
      }
      const result = await dialog.showOpenDialog(win!, {
        title: "Choose folder to save EQX files",
        properties: ["openDirectory", "createDirectory"],
      });
      appendToMainLog(`[export-eqx] pick-eqx-folder dialog result — canceled=${result.canceled} folder=${result.filePaths[0] ?? "none"}`);
      if (result.canceled || !result.filePaths.length) return { canceled: true };
      return { canceled: false, folder: result.filePaths[0] };
    } catch (err: any) {
      appendToMainLog(`[export-eqx] pick-eqx-folder THREW: ${err?.stack ?? err?.message ?? String(err)}`);
      throw err;
    }
  });

  // Step 2: write the already-fetched files into the chosen folder.
  ipcMain.handle("write-eqx-files", async (_e, { folder, files }: { folder: string; files: Array<{ filename: string; data: string }> }) => {
    appendToMainLog(`[export-eqx] write-eqx-files IPC received — folder=${folder} fileCount=${files?.length ?? 0}`);
    try {
      for (const { filename, data } of files) {
        const destPath = path.join(folder, filename);
        const buffer = Buffer.from(data, "base64");
        fs.writeFileSync(destPath, buffer);
        appendToMainLog(`[export-eqx] wrote ${filename} (${buffer.length} bytes) → ${destPath}`);
      }
      appendToMainLog(`[export-eqx] write-eqx-files complete — ${files.length} file(s) written`);
      return { count: files.length };
    } catch (err: any) {
      appendToMainLog(`[export-eqx] write-eqx-files THREW: ${err?.stack ?? err?.message ?? String(err)}`);
      throw err;
    }
  });

  // Legacy handler kept for backward compatibility (single call, shows dialog internally).
  ipcMain.handle("export-eqx-folder", async (_e, files: Array<{ filename: string; data: string }>) => {
    const result = await dialog.showOpenDialog(win!, {
      title: "Choose folder to save EQX files",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    const folder = result.filePaths[0];
    for (const { filename, data } of files) {
      const buffer = Buffer.from(data, "base64");
      fs.writeFileSync(path.join(folder, filename), buffer);
    }
    return { canceled: false, folder, count: files.length };
  });

  ipcMain.handle("get-autostart", () => {
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle("set-autostart", (_e, enable: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enable });
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle("check-for-updates", async () => {
    if (!app.isPackaged) {
      dialog.showMessageBox(win!, {
        type: "info",
        title: "Dev Mode",
        message: "Update checks only run in the packaged app.",
        buttons: ["OK"],
      });
      return;
    }
    try {
      _updaterManualCheck = true;
      await autoUpdater.checkForUpdates();
    } catch (err) {
      // Only show dialog here if the error event hasn't already reset the flag.
      // (The autoUpdater 'error' event fires for async failures and resets the
      // flag itself with a friendly message.  This catch handles synchronous
      // rejections — e.g. the GitHub API returning 401 before the stream opens.)
      if (!_updaterManualCheck) return; // error event already handled it
      _updaterManualCheck = false;
      const raw = String((err as Error)?.message || err);
      let message: string;
      if (/401|bad credentials|unauthorized/i.test(raw)) {
        message = "The update token has expired. To fix this:\n\n1. Generate a new GitHub personal access token with \"repo\" scope at github.com/settings/tokens\n2. Set it as the UPDATER_TOKEN secret in your GitHub repository (Settings → Secrets → Actions)\n3. Rebuild and install the new version\n\nUpdates will work normally in the new build.";
      } else if (/404|not found|no releases/i.test(raw)) {
        message = "No release has been published yet on GitHub. The update feed will become available after the first successful build publishes a release.";
      } else if (/ENOTFOUND|ECONNREFUSED|network|timeout|socket/i.test(raw)) {
        message = "Could not reach GitHub — check your internet connection and try again.";
      } else {
        message = raw.split(/\n/)[0].slice(0, 300);
      }
      dialog.showMessageBox(win!, {
        type: "error",
        title: "Update Check Failed",
        message,
        buttons: ["OK"],
      });
    }
  });
}

// Pin a stable App User Model ID so all Electron windows (main + EB) are
// grouped under the same Equinox taskbar entry and the main window — created
// first — always appears to the LEFT of any EB windows on the Windows taskbar.
if (process.platform === "win32") {
  app.setAppUserModelId("Equinox");
}

// ── Single-instance lock ──────────────────────────────────────────────────────
// Only one copy of Equinox may run per user account at a time. If a second
// launch is attempted, the existing window is focused and the new process exits.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// ── WebRTC IP-leak prevention (Electron global) ───────────────────────────────
// These Chrome command-line switches apply to every Chromium renderer in this
// Electron process — including all EB BrowserWindows and BrowserViews.
//
// ── IP Leak Prevention (MUST be before app.whenReady) ────────────────────────
//
// Problem: Chromium's WebRTC and network stacks can leak the machine's real IP
// even when a proxy is configured, via two independent paths:
//
//   Path A — WebRTC / ICE candidates:
//     RTCPeerConnection gathers ICE candidates by querying all local network
//     interfaces directly (bypasses the HTTP/SOCKS proxy). With a SOCKS5 proxy
//     configured, Chrome still generates ICE candidates for the IPv6 interface
//     because it considers them "proxied" (SOCKS5 supports UDP ASSOCIATE). The
//     IPv6 address then leaks to every page that calls new RTCPeerConnection().
//
//   Path B — IPv6 bypass:
//     Most proxies are IPv4-only. When the host machine has IPv6 connectivity,
//     Chrome prefers IPv6 for direct connections (e.g. ipify.org, my-ip.io).
//     Those requests bypass the IPv4 proxy entirely, exposing the real IPv6.
//
// Fix A — disable IPv6 in Chrome's network stack:
//   "disable-ipv6" removes IPv6 from every subsystem: DNS resolver, socket
//   pool, WebRTC ICE gatherer. Chrome can no longer see or use IPv6 interfaces,
//   so only IPv4 remains and all traffic routes through the configured proxy.
//
// Fix B — lock WebRTC to proxy-only UDP:
//   "force-webrtc-ip-handling-policy=disable_non_proxied_udp" prevents WebRTC
//   from generating UDP ICE candidates that bypass the proxy. Note: this flag
//   does NOT block TCP ICE candidates ("SPDY PUBLIC" type), which can still
//   expose real IPv6 addresses. TCP candidates are blocked by a CDP
//   Page.addScriptToEvaluateOnNewDocument injection in ebManager.ts that
//   overrides RTCPeerConnection.createOffer() to immediately reject, causing
//   the ICE gatherer to produce zero candidates of any type.
//
// IMPORTANT: appendSwitch() must be called BEFORE app.whenReady() — Chrome
// command-line args are consumed at process startup and cannot be changed later.
app.commandLine.appendSwitch("disable-ipv6");
app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
app.commandLine.appendSwitch("enforce-webrtc-ip-permission-check");
// Prevent DNS prefetch from resolving hostnames outside the proxy tunnel.
app.commandLine.appendSwitch("dns-prefetch-disable");
// When a proxy fails, show ERR_PROXY_CONNECTION_FAILED instead of silently
// falling back to a direct connection that would leak the real machine IP.
app.commandLine.appendSwitch("no-proxy-fallback");
// ── QUIC/HTTP3 bypass prevention ─────────────────────────────────────────────
// HTTP proxies only handle TCP.  Chrome's QUIC (HTTP/3) implementation uses UDP
// and has no proxy-aware path — when a site advertises alt-svc "h3" (e.g. any
// Cloudflare-hosted endpoint such as api64.ipify.org) Chrome can open a direct
// UDP connection to it, bypassing the HTTP proxy entirely.  This is the primary
// cause of IPv6 leaks: the UDP socket is dual-stack so it picks up the real
// IPv6 address even when --disable-ipv6 suppresses TCP IPv6.
// Disabling QUIC forces all connections to TCP (HTTP/1.1 or HTTP/2 via CONNECT)
// which the configured HTTP/SOCKS5 proxy handles correctly.
app.commandLine.appendSwitch("disable-quic");
// ── Disable IPv6 preference in Chrome's connection algorithms ─────────────────
// Belt-and-suspenders on top of --disable-ipv6.  In Electron 33 / Chromium 130
// the --disable-ipv6 flag may not fully suppress TCP IPv6 connections due to
// changes in the Network Service process.  These feature flags target the
// upper-layer algorithms that PREFER IPv6:
//   HappyEyeballsV3  — the Happy Eyeballs v3 algorithm aggressively races IPv6
//     vs IPv4 and picks whichever connects first (usually IPv6 on a dual-stack
//     host).  Disabling it reverts to the older IPv4-first behaviour.
//   IPv6Reachability — Chrome's IPv6 reachability probe.  Without a confirmed
//     reachable IPv6 path Chrome avoids IPv6 for new connections.
// Note: the PAC-script proxy approach in ebManager.ts is the primary IPv6 leak
// fix (Chrome sends hostname to proxy via CONNECT; proxy resolves DNS, so IPv6
// never appears on the client side).  These flags are an additional layer.
app.commandLine.appendSwitch("disable-features", "HappyEyeballsV3,IPv6Reachability");
// ── Anti-bot: suppress Chromium's automation flag ─────────────────────────────
// Electron sets navigator.webdriver = true at the Blink native level before any
// page script runs. JS Object.defineProperty overrides cannot fully mask this
// because the property's configurable descriptor is set to false by Blink first.
// --disable-blink-features=AutomationControlled prevents Blink from setting the
// flag in the first place, making the browser indistinguishable from a normal
// Chrome instance at the native level. This is a critical stealth requirement —
// Instagram checks navigator.webdriver (and its isTrusted event signals) to
// detect automation and flag accounts on first login.
app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");
// ── Global proxy bypass list ──────────────────────────────────────────────────
// Set a strict global bypass list so only loopback addresses bypass the proxy.
// Individual sessions also set proxyBypassList explicitly in setProxy() calls,
// but this global switch acts as a backstop for any session created before the
// per-session setProxy() takes effect.
app.commandLine.appendSwitch("proxy-bypass-list", "127.0.0.1;[::1];localhost");

app.whenReady().then(() => {
  createSplash("Starting…");
  createWindow();
});

app.on("before-quit", (event) => {
  isQuitting = true;
  // Destroy the tray icon immediately so it disappears from the Windows system
  // tray right away. Without this explicit destroy() the icon lingers after the
  // process exits and produces an error when the user right-clicks the ghost icon.
  trayPopup?.destroy();
  trayPopup = null;
  tray?.destroy();
  tray = null;
  if (!serverProc) return;
  // Give the server process a moment to flush and close the SQLite database
  // cleanly before Electron exits. better-sqlite3 is synchronous so the
  // database is always in a consistent state, but sending SIGTERM first gives
  // Node.js a chance to run its 'exit' handlers and release file locks.
  event.preventDefault();
  win?.hide();
  createSplash("Closing…");
  const proc = serverProc;
  serverProc = null;
  proc.kill("SIGTERM");
  setTimeout(() => {
    try { proc.kill("SIGKILL"); } catch {}
    // Destroy all open BrowserWindows before exit so nothing holds the process
    // open (the splash window would keep Electron alive if we used app.quit()).
    // process.exit(0) is unconditional — the updater's process scan won't see
    // a lingering Equinox.exe after this point.
    try { BrowserWindow.getAllWindows().forEach(w => { try { w.destroy(); } catch {} }); } catch {}
    process.exit(0);
  }, 2500);
});

app.on("window-all-closed", () => {
  // Do NOT quit on window close — the app lives in the tray
  // Only quit when isQuitting is true (from tray menu)
});

app.on("activate", () => {
  if (win === null) {
    createWindow();
  } else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
