import { app, BrowserWindow, Tray, nativeImage, dialog, ipcMain, screen } from "electron";
import { autoUpdater } from "electron-updater";
import { spawn, ChildProcess, exec } from "child_process";
import { promisify } from "util";
import http from "http";
import net from "net";
import fs from "fs";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

let serverPort = 0;
let serverProc: ChildProcess | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

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
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || "";
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
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
      try { if (fs.existsSync(p)) return p; } catch {}
    }
    return "";
  }
  // Linux / macOS (dev environment — Nix-managed Chromium)
  return process.env.CHROMIUM_PATH
    || "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium";
}

function startServer(port: number, logPath: string): void {
  const entry = getServerEntry();
  const dbPath = path.join(getUserDataPath(), "database.db");
  const frontendPath = getFrontendPath();
  const chromiumPath = findChromiumPath();

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
      // Windows OpenSSL cert bundle state.  This is safe in the Electron context
      // because all connections go to known Instagram endpoints.
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      ...(nodeModulesPath ? { NODE_PATH: nodeModulesPath } : {}),
      ...(chromiumPath ? { CHROMIUM_PATH: chromiumPath } : {}),
    },
  });

  const logStream = fs.createWriteStream(logPath, { flags: "w" });
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
<div class="item" onclick="window.trayMenuAPI.openApp()">Open Danny&#39;s Bot</div>
<div class="sep"></div>
<div class="item" onclick="window.trayMenuAPI.restartApp()">Restart Danny&#39;s Bot</div>
<div class="sep"></div>
<div class="item" onclick="window.trayMenuAPI.closeApp()">Close Danny&#39;s Bot</div>
</body></html>`;

// Dimensions must match the HTML content exactly
const POPUP_W = 220;
const POPUP_H = 3 * 33 + 2 * 7; // 3 items + 2 separators (with margins)

let trayPopup: BrowserWindow | null = null;

function createTray(): void {
  const iconPath = getIconPath();
  let icon: Electron.NativeImage;

  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip("Danny's Bot");

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

  // Left-click: toggle main window
  tray.on("click", () => {
    trayPopup?.hide();
    if (win?.isVisible()) {
      win.hide();
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

function setupAutoUpdater(): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-downloaded", () => {
    if (!win) return;
    dialog.showMessageBox(win, {
      type: "info",
      title: "Update Ready",
      message: "Danny's Bot has been updated. Restart now to apply?",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall(false, true);
    });
  });

  autoUpdater.on("update-not-available", () => {
    if (!win) return;
    dialog.showMessageBox(win, {
      type: "info",
      title: "Up to Date",
      message: "You are up to date — Danny's Bot is running the latest version.",
      buttons: ["OK"],
    });
  });

  autoUpdater.on("error", (err) => {
    if (!win) return;
    dialog.showMessageBox(win, {
      type: "error",
      title: "Update Check Failed",
      message: String(err?.message || err),
      buttons: ["OK"],
    });
  });

  setTimeout(() => autoUpdater.checkForUpdates(), 5000);
}

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
  const zipPath = path.join(backupFolder, "backup.zip");

  try {
    fs.mkdirSync(backupFolder, { recursive: true });

    if (process.platform === "win32") {
      await runPsScript([
        `$src = '${userData.replace(/'/g, "''")}'`,
        `$dst = '${zipPath.replace(/'/g, "''")}'`,
        `$items = Get-ChildItem -Path $src | Where-Object { $_.Name -ne 'backups' } | ForEach-Object { $_.FullName }`,
        `if ($items) { Compress-Archive -Path $items -DestinationPath $dst -Force }`,
      ].join("`n"));
    } else {
      const items = fs.readdirSync(userData)
        .filter((n) => n !== "backups")
        .map((n) => `'${path.join(userData, n).replace(/'/g, "'\\''")}'`)
        .join(" ");
      if (items) await execAsync(`zip -r '${zipPath.replace(/'/g, "'\\''")}' ${items}`);
    }

    const size = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
    const meta = { date: new Date().toISOString(), size };
    fs.writeFileSync(path.join(backupFolder, "meta.json"), JSON.stringify(meta));
    return { ok: true, entry: { id, date: meta.date, size } };
  } catch (err: any) {
    try { fs.rmSync(backupFolder, { recursive: true, force: true }); } catch {}
    return { ok: false, error: String(err?.message ?? err) };
  }
}

function listBackupsNow(): BackupEntry[] {
  const dir = getBackupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => {
      const d = path.join(dir, name);
      return fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, "backup.zip"));
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
        try { size = fs.statSync(path.join(dir, name, "backup.zip")).size; } catch {}
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
  const zipPath = path.join(getBackupsDir(), id, "backup.zip");
  if (!fs.existsSync(zipPath)) return { ok: false, error: "Backup file not found" };

  const userData = getUserDataPath();
  try {
    if (serverProc) { serverProc.kill(); serverProc = null; }
    await new Promise((r) => setTimeout(r, 1200));

    if (process.platform === "win32") {
      await runPsScript([
        `$zip = '${zipPath.replace(/'/g, "''")}'`,
        `$dst = '${userData.replace(/'/g, "''")}'`,
        `Expand-Archive -Path $zip -DestinationPath $dst -Force`,
      ].join("`n"));
    } else {
      await execAsync(`unzip -o '${zipPath.replace(/'/g, "'\\''")}' -d '${userData.replace(/'/g, "'\\''")}'`);
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
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Danny's Bot",
    icon: getIconPath(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Minimise to tray on close instead of quitting
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

  try {
    serverPort = await findFreePort();
  } catch {
    serverPort = 19876;
  }

  startServer(serverPort, logPath);

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

  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => { win = null; });

  createTray();
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
      await autoUpdater.checkForUpdates();
    } catch (err) {
      dialog.showMessageBox(win!, {
        type: "error",
        title: "Update Check Failed",
        message: String((err as Error)?.message || err),
        buttons: ["OK"],
      });
    }
  });
}

app.whenReady().then(createWindow);

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  // Do NOT quit on window close — the app lives in the tray
  // Only quit when isQuitting is true (from tray menu)
});

app.on("activate", () => {
  if (win === null) {
    createWindow();
  } else {
    win.show();
  }
});
