import { app, BrowserWindow, utilityProcess, UtilityProcess } from "electron";
import http from "http";
import path from "path";

const PORT = 8765;
let serverProc: UtilityProcess | null = null;
let win: BrowserWindow | null = null;

function getServerEntry(): string {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "dist",
      "server",
      "index.mjs"
    );
  }
  return path.join(__dirname, "..", "dist", "server", "index.mjs");
}

function getFrontendPath(): string {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "dist",
      "frontend",
      "public"
    );
  }
  return path.join(__dirname, "..", "dist", "frontend", "public");
}

function waitForServer(timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  return new Promise<void>((resolve, reject) => {
    function attempt() {
      const req = http.get(`http://localhost:${PORT}/`, (res) => {
        res.resume();
        resolve();
      });
      req.setTimeout(1000, () => req.destroy());
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Server did not respond within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 500);
        }
      });
    }
    attempt();
  });
}

function startServer(): void {
  const entry = getServerEntry();
  const dbPath = path.join(app.getPath("userData"), "database.db");
  const frontendPath = getFrontendPath();

  serverProc = utilityProcess.fork(entry, [], {
    env: {
      PORT: String(PORT),
      DATABASE_PATH: dbPath,
      FRONTEND_DIST_PATH: frontendPath,
      NODE_ENV: "production",
      LOG_LEVEL: "silent",
    },
    serviceName: "Danny's Bot Server",
  });

  serverProc.on("exit", (code) => {
    if (code !== 0) {
      console.error("Server process exited with code", code);
    }
  });
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Danny's Bot",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  startServer();

  try {
    await waitForServer();
    win.loadURL(`http://localhost:${PORT}`);
  } catch (err) {
    win.loadURL(
      `data:text/html,<html><body style="font-family:sans-serif;padding:40px;background:%231a1a2e;color:%23fff">` +
      `<h2 style="color:%23ff6b6b">Danny's Bot failed to start</h2>` +
      `<p>The local server did not respond on port ${PORT}.</p>` +
      `<p>Please restart the app. If this keeps happening, try reinstalling.</p>` +
      `</body></html>`
    );
  }

  win.webContents.on("did-fail-load", (_e, code, desc) => {
    console.error("Page failed to load:", code, desc);
  });

  win.once("ready-to-show", () => {
    win?.show();
    win?.webContents.openDevTools();
  });

  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (serverProc) {
    serverProc.kill();
    serverProc = null;
  }
  app.quit();
});

app.on("activate", () => {
  if (win === null) createWindow();
});
