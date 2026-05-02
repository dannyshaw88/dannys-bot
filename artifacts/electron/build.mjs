import { build as esbuild } from "esbuild";
import { cp, rm, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// 1. Compile Electron main process → dist/main.js (CJS)
await esbuild({
  entryPoints: [path.join(__dirname, "src/main.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  external: ["electron"],
  outfile: path.join(dist, "main.js"),
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

// 4. Generate a crash-logging wrapper that is the real entry point
const wrapper = `
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const LOG_FILE = process.env.LOG_FILE;

function writeLog(msg) {
  process.stderr.write(msg + '\\n');
  if (LOG_FILE) {
    try {
      mkdirSync(dirname(LOG_FILE), { recursive: true });
      writeFileSync(LOG_FILE, msg + '\\n', { flag: 'a' });
    } catch {}
  }
}

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
