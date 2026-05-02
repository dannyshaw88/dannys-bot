import { app, BrowserWindow, utilityProcess, UtilityProcess } from "electron";
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

function startServer(): Promise<void> {
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

  return new Promise<void>((resolve) => {
    serverProc!.once("spawn", () => setTimeout(resolve, 2000));
    setTimeout(resolve, 4000);
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

  await startServer();

  win.loadURL(`http://localhost:${PORT}`);

  win.once("ready-to-show", () => {
    win?.show();
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
