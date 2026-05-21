import { build as esbuild } from "esbuild";
import { cp, rm, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// 1a. Compile Electron main process → dist/main.js (CJS)
await esbuild({
  entryPoints: [path.join(__dirname, "src/main.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  external: ["electron", "electron-updater"],
  outfile: path.join(dist, "main.js"),
  format: "cjs",
  define: {
    // Baked in at build time from CI secret — lets electron-updater
    // authenticate against the private GitHub repo without a config file.
    __UPDATER_TOKEN__: JSON.stringify(process.env.DANNY_BOT_UPDATER_TOKEN || ""),
  },
});

// 1b. Compile preload → dist/preload.js (CJS)
await esbuild({
  entryPoints: [path.join(__dirname, "src/preload.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  external: ["electron"],
  outfile: path.join(dist, "preload.js"),
  format: "cjs",
});

// 1c. Compile tray menu preload → dist/trayMenuPreload.js (CJS)
await esbuild({
  entryPoints: [path.join(__dirname, "src/trayMenuPreload.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  external: ["electron"],
  outfile: path.join(dist, "trayMenuPreload.js"),
  format: "cjs",
});

// 1d. Compile EB toolbar preload → dist/ebToolbarPreload.js (CJS)
await esbuild({
  entryPoints: [path.join(__dirname, "src/ebToolbarPreload.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  external: ["electron"],
  outfile: path.join(dist, "ebToolbarPreload.js"),
  format: "cjs",
});

// 2. Copy bundled API server
const serverSrc = path.join(__dirname, "../api-server/dist");
if (!existsSync(serverSrc)) {
  throw new Error(`API server dist not found at ${serverSrc}. Run 'pnpm --filter @workspace/api-server run build' first.`);
}
await cp(serverSrc, path.join(dist, "server"), { recursive: true });

// 3. Copy built frontend
const frontendSrc = path.join(__dirname, "../dannys-bot/dist/public");
if (!existsSync(frontendSrc)) {
  throw new Error(`Frontend dist not found at ${frontendSrc}. Run 'pnpm --filter @workspace/dannys-bot run build' first.`);
}
await cp(frontendSrc, path.join(dist, "frontend", "public"), { recursive: true });

// 4. Copy app assets (icons etc.)
const assetsSrc = path.join(__dirname, "assets");
if (existsSync(assetsSrc)) {
  await cp(assetsSrc, path.join(dist, "assets"), { recursive: true });
}

// 5. Generate a crash-logging wrapper that is the real entry point
const wrapper = `
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const LOG_FILE = process.env.LOG_FILE;

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function writeLog(msg) {
  const line = '[' + ts() + '] ' + msg;
  _origStderr(line + '\\n');
  if (LOG_FILE) {
    try {
      mkdirSync(dirname(LOG_FILE), { recursive: true });
      writeFileSync(LOG_FILE, line + '\\n', { flag: 'a' });
    } catch {}
  }
}

// Pino (production) writes one JSON object per stdout.write call.
// Intercept stdout so every pino line is reformatted as a human-readable
// timestamped string — no worker threads, no pino-pretty needed.
const PINO_LEVELS = { 10:'TRACE', 20:'DEBUG', 30:'INFO', 40:'WARN', 50:'ERROR', 60:'FATAL' };

function formatPinoChunk(chunk) {
  const str = typeof chunk === 'string' ? chunk : (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
  return str.split('\\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.level === 'number') {
        const level = PINO_LEVELS[obj.level] || String(obj.level);
        const msg   = obj.msg ?? '';
        const extra = obj.err
          ? ' ' + (obj.err.stack || obj.err.message || JSON.stringify(obj.err))
          : '';
        return '[' + ts() + '] ' + level + ' ' + msg + extra;
      }
    } catch {}
    return '[' + ts() + '] ' + trimmed;
  }).join('\\n');
}

const _origStdout = process.stdout.write.bind(process.stdout);
const _origStderr = process.stderr.write.bind(process.stderr);

// Stamp pino JSON on stdout; use raw stderr for writeLog (already stamped above)
process.stdout.write = function(chunk, enc, cb) {
  return _origStdout(formatPinoChunk(chunk), enc, cb);
};

// Patch console.* (engine/webClient etc.) so they also get timestamps
const _writeConsole = (stream, args) => stream('[' + ts() + '] ' + args.map(String).join(' ') + '\\n');
console.log   = (...a) => _writeConsole(_origStdout, a);
console.info  = (...a) => _writeConsole(_origStdout, a);
console.warn  = (...a) => _writeConsole(_origStderr, a);
console.error = (...a) => _writeConsole(_origStderr, a);

process.on('uncaughtException', (err) => {
  writeLog('UNCAUGHT: ' + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  writeLog('UNHANDLED: ' + (reason && reason.stack ? reason.stack : String(reason)));
  process.exit(1);
});

writeLog('server-start: loading index.mjs');

try {
  await import('./index.mjs');
} catch (err) {
  writeLog('IMPORT ERROR: ' + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
}
`.trimStart();

await writeFile(path.join(dist, "server", "start.mjs"), wrapper, "utf8");

console.log("Electron build complete → dist/");
