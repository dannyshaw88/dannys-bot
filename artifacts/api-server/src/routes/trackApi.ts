import type { Express } from "express";
import type { Server as HttpServer } from "http";
import * as net from "net";
import * as http from "http";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { WebSocketServer, WebSocket } from "ws";

const execAsync = promisify(exec);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TrackLogEntry {
  id: number;
  ts: string;
  method: string;
  host: string;
  path: string;
  status: number | null;
  durationMs: number | null;
  type: "http" | "connect";
  size: number | null;
}

// ─── In-memory log store ──────────────────────────────────────────────────────

const MAX_ENTRIES = 1000;
let _nextId = 1;
const _log: TrackLogEntry[] = [];
const _clients = new Set<WebSocket>();

function pushEntry(entry: Omit<TrackLogEntry, "id" | "ts">) {
  const full: TrackLogEntry = { id: _nextId++, ts: new Date().toISOString(), ...entry };
  _log.push(full);
  if (_log.length > MAX_ENTRIES) _log.splice(0, _log.length - MAX_ENTRIES);
  const msg = JSON.stringify({ type: "entry", entry: full });
  for (const ws of _clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ─── Proxy server ─────────────────────────────────────────────────────────────

let _proxyServer: net.Server | null = null;
let _proxyPort = 8899;

function getLocalIps(): string[] {
  const ips: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const info of iface ?? []) {
      if (info.family === "IPv4" && !info.internal) ips.push(info.address);
    }
  }
  return ips;
}

function startProxy(port: number): Promise<void> {
  if (_proxyServer) return Promise.resolve();
  _proxyPort = port;

  return new Promise((resolve, reject) => {
    const server = net.createServer((clientSocket) => {
      let headerBuf = Buffer.alloc(0);
      let headerDone = false;

      clientSocket.on("data", (chunk) => {
        if (headerDone) return;
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const headerEnd = headerBuf.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        headerDone = true;

        const headerStr = headerBuf.slice(0, headerEnd).toString("utf8");
        const lines = headerStr.split("\r\n");
        const requestLine = lines[0] ?? "";
        const parts = requestLine.split(" ");
        const method = parts[0]?.toUpperCase() ?? "";
        const target = parts[1] ?? "";

        if (method === "CONNECT") {
          // HTTPS tunnel — log the destination host:port and pass through
          const [host, portStr] = target.split(":");
          const destPort = parseInt(portStr ?? "443", 10);
          pushEntry({ method: "CONNECT", host: host ?? target, path: "", status: null, durationMs: null, type: "connect", size: null });

          const destSocket = net.connect(destPort, host, () => {
            clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            destSocket.pipe(clientSocket);
            clientSocket.pipe(destSocket);
          });
          destSocket.on("error", () => { try { clientSocket.destroy(); } catch {} });
          clientSocket.on("error", () => { try { destSocket.destroy(); } catch {} });
        } else if (method === "GET" || method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE" || method === "HEAD") {
          // Plain HTTP request — proxy and log
          let parsedUrl: URL;
          try {
            parsedUrl = new URL(target.startsWith("http") ? target : `http://${target}`);
          } catch {
            clientSocket.destroy();
            return;
          }

          const destHost = parsedUrl.hostname;
          const destPort = parsedUrl.port ? parseInt(parsedUrl.port) : 80;
          const path = parsedUrl.pathname + parsedUrl.search;
          const start = Date.now();

          const headers: Record<string, string> = {};
          for (let i = 1; i < lines.length; i++) {
            const idx = lines[i].indexOf(":");
            if (idx > 0) {
              const key = lines[i].slice(0, idx).trim().toLowerCase();
              const val = lines[i].slice(idx + 1).trim();
              headers[key] = val;
            }
          }

          const body = headerBuf.slice(headerEnd + 4);
          const bodyLen = parseInt(headers["content-length"] ?? "0", 10);

          function doRequest(reqBody: Buffer) {
            const proxyHeaders: Record<string, string> = { ...headers };
            delete proxyHeaders["proxy-connection"];
            proxyHeaders["connection"] = "close";

            const options: http.RequestOptions = {
              hostname: destHost,
              port: destPort,
              path,
              method,
              headers: proxyHeaders,
            };

            const proxyReq = http.request(options, (proxyRes) => {
              const status = proxyRes.statusCode ?? 0;
              const chunks: Buffer[] = [];
              proxyRes.on("data", (c: Buffer) => chunks.push(c));
              proxyRes.on("end", () => {
                const responseBody = Buffer.concat(chunks);
                const duration = Date.now() - start;
                pushEntry({ method, host: destHost, path, status, durationMs: duration, type: "http", size: responseBody.length });

                const statusLine = `HTTP/1.1 ${status} ${proxyRes.statusMessage}\r\n`;
                const resHeaders = Object.entries(proxyRes.headers)
                  .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
                  .join("\r\n");
                try {
                  clientSocket.write(statusLine + resHeaders + "\r\n\r\n");
                  clientSocket.write(responseBody);
                  clientSocket.end();
                } catch {}
              });
            });
            proxyReq.on("error", () => { try { clientSocket.destroy(); } catch {} });
            if (reqBody.length) proxyReq.write(reqBody);
            proxyReq.end();
          }

          if (bodyLen > 0 && body.length < bodyLen) {
            const remaining: Buffer[] = [body];
            let got = body.length;
            clientSocket.on("data", (c: Buffer) => {
              remaining.push(c);
              got += c.length;
              if (got >= bodyLen) doRequest(Buffer.concat(remaining));
            });
          } else {
            doRequest(body);
          }
        } else {
          clientSocket.destroy();
        }
      });

      clientSocket.on("error", () => {});
    });

    server.on("error", reject);
    server.listen(port, "0.0.0.0", () => {
      _proxyServer = server;
      console.log(`[track-api] Proxy started on port ${port}`);
      resolve();
    });
  });
}

function stopProxy(): Promise<void> {
  return new Promise((resolve) => {
    if (!_proxyServer) { resolve(); return; }
    _proxyServer.close(() => { _proxyServer = null; resolve(); });
  });
}

// ─── ADB helpers ──────────────────────────────────────────────────────────────

async function adbDevices(): Promise<{ serial: string; state: string }[]> {
  try {
    const { stdout } = await execAsync("adb devices");
    return stdout
      .split("\n")
      .slice(1)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("*"))
      .map(l => {
        const [serial, ...rest] = l.split(/\s+/);
        return { serial: serial ?? "", state: rest.join(" ") };
      })
      .filter(d => d.serial);
  } catch {
    return [];
  }
}

async function adbSetProxy(serial: string, host: string, port: number): Promise<void> {
  await execAsync(`adb -s ${serial} shell settings put global http_proxy ${host}:${port}`);
  await execAsync(`adb -s ${serial} shell settings put global https_proxy ${host}:${port}`);
}

async function adbClearProxy(serial: string): Promise<void> {
  await execAsync(`adb -s ${serial} shell settings put global http_proxy :0`);
  await execAsync(`adb -s ${serial} shell settings delete global https_proxy`);
}

async function adbAvailable(): Promise<boolean> {
  try { await execAsync("adb version"); return true; } catch { return false; }
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerTrackApiRoutes(httpServer: HttpServer, app: Express) {
  // WebSocket for live log streaming
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url === "/api/track-api/ws") {
      wss.handleUpgrade(req, socket as any, head, (ws) => {
        _clients.add(ws);
        ws.on("close", () => _clients.delete(ws));
      });
    }
  });

  app.get("/api/track-api/status", async (_req, res) => {
    const [devices, hasAdb] = await Promise.all([adbDevices(), adbAvailable()]);
    res.json({
      running: !!_proxyServer,
      port: _proxyPort,
      localIps: getLocalIps(),
      adbAvailable: hasAdb,
      devices,
      entryCount: _log.length,
    });
  });

  app.post("/api/track-api/start", async (req, res) => {
    const port = Number(req.body?.port ?? 8899);
    if (_proxyServer) { res.json({ ok: true, port: _proxyPort }); return; }
    try {
      await startProxy(port);
      res.json({ ok: true, port });
    } catch (err: any) {
      res.status(500).json({ message: err.message ?? "Failed to start proxy" });
    }
  });

  app.post("/api/track-api/stop", async (_req, res) => {
    await stopProxy();
    res.json({ ok: true });
  });

  app.get("/api/track-api/logs", (_req, res) => {
    res.json({ entries: _log });
  });

  app.post("/api/track-api/clear", (_req, res) => {
    _log.length = 0;
    for (const ws of _clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "clear" }));
    }
    res.json({ ok: true });
  });

  app.post("/api/track-api/adb/set-proxy", async (req, res) => {
    const { serial, host, port } = req.body ?? {};
    if (!serial || !host || !port) {
      res.status(400).json({ message: "serial, host, and port are required" });
      return;
    }
    try {
      await adbSetProxy(serial, host, Number(port));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message ?? "ADB command failed" });
    }
  });

  app.post("/api/track-api/adb/clear-proxy", async (req, res) => {
    const { serial } = req.body ?? {};
    if (!serial) { res.status(400).json({ message: "serial is required" }); return; }
    try {
      await adbClearProxy(serial);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message ?? "ADB command failed" });
    }
  });
}
