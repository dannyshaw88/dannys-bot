import { app, BrowserWindow } from "electron";
import { spawn, ChildProcess } from "child_process";
import http from "http";
import net from "net";
import fs from "fs";
import path from "path";

let serverPort = 0;
let serverProc: ChildProcess | null = null;
let win: BrowserWindow | null = null;

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

function startServer(port: number, logPath: string): void {
  const entry = getServerEntry();
  const dbPath = path.join(getUserDataPath(), "database.db");
  const frontendPath = getFrontendPath();

  // ELECTRON_RUN_AS_NODE=1 tells Electron to behave as plain Node.js —
  // no sandbox, no renderer, full network access. Required because
  // utilityProcess blocks listen() on Windows.
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
    },
  });

  const logStream = fs.createWriteStream(logPath, { flags: "w" });
  serverProc.stdout?.on("data", (d: Buffer) => logStream.write(d));
  serverProc.stderr?.on("data", (d: Buffer) => logStream.write(d));
  serverProc.on("exit", () => logStream.end());
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

  const logPath = path.join(getUserDataPath(), "server.log");

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
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  serverProc?.kill();
  serverProc = null;
  app.quit();
});

app.on("activate", () => {
  if (win === null) createWindow();
});
