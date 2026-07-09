import { createServer } from "http";
import path from "path";
import fs from "fs";
import express from "express";
import app from "./app";
import { logger } from "./lib/logger";
import { registerInstagramRoutes } from "./routes/instagram";
import { registerMobileRoutes } from "./routes/mobile";

const port = Number(process.env["PORT"] ?? "3000");

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env["PORT"]}"`);
}

// ── Rolling server log file ───────────────────────────────────────────────────
// Tees every console.log / console.error line to an on-disk log file so the
// user can inspect what happened in the Windows production app without needing
// DevTools or a command prompt.  The file is capped at 5 MB and rotates by
// discarding the oldest half when the limit is reached.
const SERVER_LOG_PATH = process.env.DATABASE_PATH
  ? path.join(path.dirname(process.env.DATABASE_PATH), "equinox-debug.log")
  : path.join(process.cwd(), "equinox-debug.log");

const MAX_LOG_BYTES = 5 * 1024 * 1024;

// Expose the resolved path globally so the /api/logs/server route can read it.
(global as any).__SERVER_LOG_PATH = SERVER_LOG_PATH;

let _logFd: number | null = null;
try {
  _logFd = fs.openSync(SERVER_LOG_PATH, "a");
} catch {}

function _writeLogLine(chunk: string | Buffer): void {
  if (_logFd === null) return;
  try {
    const line = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    fs.write(_logFd, line.endsWith("\n") ? line : line + "\n", () => {});

    // Rotate when over limit
    try {
      const stat = fs.fstatSync(_logFd);
      if (stat.size > MAX_LOG_BYTES) {
        fs.closeSync(_logFd);
        const content = fs.readFileSync(SERVER_LOG_PATH, "utf8");
        const half = content.slice(Math.floor(content.length / 2));
        const boundary = half.indexOf("\n");
        const trimmed = boundary >= 0 ? half.slice(boundary + 1) : half;
        fs.writeFileSync(SERVER_LOG_PATH, `[Log rotated at ${new Date().toISOString()}]\n` + trimmed, "utf8");
        _logFd = fs.openSync(SERVER_LOG_PATH, "a");
      }
    } catch {}
  } catch {}
}

// Tee stdout and stderr to the log file without breaking existing output
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
const _origStderrWrite = process.stderr.write.bind(process.stderr);

(process.stdout as any).write = function (chunk: any, encodingOrCb?: any, cb?: any) {
  _writeLogLine(chunk);
  return (_origStdoutWrite as any)(chunk, encodingOrCb, cb);
};
(process.stderr as any).write = function (chunk: any, encodingOrCb?: any, cb?: any) {
  _writeLogLine(chunk);
  return (_origStderrWrite as any)(chunk, encodingOrCb, cb);
};

console.log(`[server] Log file: ${SERVER_LOG_PATH}`);

// ─────────────────────────────────────────────────────────────────────────────

const httpServer = createServer(app);

registerMobileRoutes(httpServer, app);

registerInstagramRoutes(httpServer, app).then(() => {
  const frontendDist = process.env.FRONTEND_DIST_PATH ||
    path.join(process.cwd(), "artifacts", "dannys-bot", "dist", "public");
  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.use((_req, res) => {
      res.sendFile(path.join(frontendDist, "index.html"));
    });
    logger.info({ frontendDist }, "Serving frontend static files");
  }

  const host = process.env["HOST"] ?? "0.0.0.0";
  httpServer.listen(port, host, () => {
    logger.info({ port, host }, "Server listening");
  });
}).catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
