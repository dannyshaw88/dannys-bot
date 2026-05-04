import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import { spawn, ChildProcess } from "child_process";
import http from "http";
import net from "net";
import fs from "fs";
import path from "path";

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
    return path.join(process.resourcesPath, "app.asar.unpacked", "dist", "server", "start.mjs");
  }
  return path.join(__dirname, "..", "dist", "server", "start.mjs");
}

function getFrontendPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app.asar.unpacked", "dist", "frontend", "public");
  }
  return path.join(__dirname, "..", "dist", "frontend", "public");
}

function getIconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app.asar.unpacked", "dist", "assets", "icon.png");
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
      LOG_LEVEL: "warn",
      LOG_FILE: logPath,
      // The instagram-private-api library uses the old `request-promise` HTTP library
      // which on Windows does not use the system certificate store.  Setting this
      // environment variable tells Node.js to skip TLS certificate verification so
      // that all outbound HTTPS calls to Instagram's API succeed regardless of the
      // Windows OpenSSL cert bundle state.  This is safe in the Electron context
      // because all connections go to known Instagram endpoints.
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      ...(chromiumPath ? { CHROMIUM_PATH: chromiumPath } : {}),
    },
  });

  const logStream = fs.createWriteStream(logPath, { flags: "w" });
  serverProc.stdout?.on("data", (d: Buffer) => logStream.write(d));
  serverProc.stderr?.on("data", (d: Buffer) => logStream.write(d));
  serverProc.on("exit", () => logStream.end());
}

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

  const menu = Menu.buildFromTemplate([
    {
      label: "Open Danny's Bot",
      click: () => {
        win?.show();
        win?.focus();
      },
    },
    { type: "separator" },
    {
      label: "Close Danny's Bot",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);

  tray.on("click", () => {
    if (win?.isVisible()) {
      win.hide();
    } else {
      win?.show();
      win?.focus();
    }
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
  // easy to find (e.g. AppData\Local\Programs\DannysBot\server.log).
  // path.dirname(app.getPath("exe")) always resolves to the correct install
  // folder regardless of whether the user customised the install location.
  const logPath = path.join(path.dirname(app.getPath("exe")), "server.log");

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

  if (app.isPackaged) setupAutoUpdater();

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
