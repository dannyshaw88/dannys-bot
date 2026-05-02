import { app, BrowserWindow, utilityProcess, UtilityProcess } from "electron";
import http from "http";
import fs from "fs";
import path from "path";

const PORT = 8765;
let serverProc: UtilityProcess | null = null;
let win: BrowserWindow | null = null;
let serverLog = "";

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
  const logPath = path.join(app.getPath("userData"), "server.log");

  serverLog = "";

  serverProc = utilityProcess.fork(entry, [], {
    stdio: "pipe",
    env: {
      PORT: String(PORT),
      DATABASE_PATH: dbPath,
      FRONTEND_DIST_PATH: frontendPath,
      NODE_ENV: "production",
      LOG_LEVEL: "warn",
    },
    serviceName: "Danny's Bot Server",
  });

  const logStream = fs.createWriteStream(logPath, { flags: "w" });

  serverProc.stdout?.on("data", (d: Buffer) => {
    const text = d.toString();
    serverLog += text;
    logStream.write(text);
  });
  serverProc.stderr?.on("data", (d: Buffer) => {
    const text = d.toString();
    serverLog += text;
    logStream.write(text);
  });

  serverProc.on("exit", (code) => {
    logStream.end();
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
    const logPath = path.join(app.getPath("userData"), "server.log");
    const logSnippet = serverLog.slice(-800).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    win.loadURL(
      `data:text/html,<html><body style="font-family:monospace;padding:24px;background:%231a1a2e;color:%23fff">` +
      `<h2 style="color:%23ff6b6b">Server failed to start</h2>` +
      `<p style="color:%23aaa">Log file: ${logPath}</p>` +
      `<pre style="background:%23111;padding:12px;border-radius:6px;font-size:12px;overflow:auto;max-height:400px;white-space:pre-wrap">${logSnippet || "(no output captured)"}</pre>` +
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
