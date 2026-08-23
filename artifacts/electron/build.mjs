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

// Ship the visual Search-bar references with the API server. The runtime
// cannot depend on Replit's workspace-level attached_assets directory once
// packaged on Windows.
const searchReferenceSource = path.join(__dirname, "../../attached_assets");
const searchReferenceNames = [
  "V1_1787004021661.jpg",
  "V2_1787004021661.jpg",
  "V1_1787004422194.jpg",
  "V1-TAPPED-FIELD_1787004428397.jpg",
  "V1-WITH-TARGET_1787004431727.jpg",
  "V2_1787004435387.jpg",
  "V2-TAPPED-FIELD_1787004440073.jpg",
  "V2-WITH-TARGET_1787004444586.jpg",
];
const searchReferenceTarget = path.join(dist, "server", "search-field-refs");
await mkdir(searchReferenceTarget, { recursive: true });
for (const name of searchReferenceNames) {
  const source = path.join(searchReferenceSource, name);
  if (existsSync(source)) await cp(source, path.join(searchReferenceTarget, name));
}

// Ship the visual Instagram Home-tab icon reference with the packaged API.
const homeIconReferenceName = "home_1787131461428.jpg";
const homeIconReferenceTarget = path.join(dist, "server", "home-icon-refs");
await mkdir(homeIconReferenceTarget, { recursive: true });
const homeIconSource = path.join(searchReferenceSource, homeIconReferenceName);
const bundledHomeIconSource = path.join(__dirname, "assets", "home-icon-reference.svg");
if (existsSync(homeIconSource)) {
  await cp(homeIconSource, path.join(homeIconReferenceTarget, homeIconReferenceName));
} else if (existsSync(bundledHomeIconSource)) {
  await cp(bundledHomeIconSource, path.join(homeIconReferenceTarget, "home-icon-reference.svg"));
} else {
  throw new Error(`Required Home icon reference is missing: ${homeIconSource}`);
}
if (
  !existsSync(path.join(homeIconReferenceTarget, homeIconReferenceName)) &&
  !existsSync(path.join(homeIconReferenceTarget, "home-icon-reference.svg"))
) {
  throw new Error(`Home icon reference was not copied to: ${homeIconReferenceTarget}`);
}

// Ship the visual Reels Like-heart reference with the packaged API.
// The Reels detector intentionally refuses an unverified coordinate, so this
// asset must be present in the Windows bundle rather than workspace-only.
const likeIconReferenceName = "like-reference-reels.png";
const likeIconReferenceTarget = path.join(dist, "server", "like-icon-refs");
await mkdir(likeIconReferenceTarget, { recursive: true });
const embeddedLikeIconBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAAAAABWESUoAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAACYktHRAD/h4/MvwAAABhREFUOMtjlGfAD5gYRhWMKhhVMEIVAAAH8ABfObtYzAAAAABJRU5ErkJggg==";
await writeFile(
  path.join(likeIconReferenceTarget, likeIconReferenceName),
  Buffer.from(embeddedLikeIconBase64, "base64"),
);
await cp(likeIconSource, path.join(likeIconReferenceTarget, likeIconReferenceName));

// Ship the visual Instagram Save/bookmark reference with the packaged API.
const saveIconReferenceName = "save_1787133131184.jpg";
const saveIconReferenceTarget = path.join(dist, "server", "save-icon-refs");
await mkdir(saveIconReferenceTarget, { recursive: true });
const saveIconSource = path.join(searchReferenceSource, saveIconReferenceName);
if (existsSync(saveIconSource)) {
  await cp(saveIconSource, path.join(saveIconReferenceTarget, saveIconReferenceName));
}

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

// 4b. cycletls — the OkHttp4 JA3 TLS fingerprint library.
// cycletls is listed in this package's own dependencies so `npm install` on the
// Windows CI runner installs the correct Windows Go binary automatically.
// electron-builder's "node_modules/**" files glob then includes it in the
// installer alongside the other deps, and index.mjs resolves it via normal
// Node.js module resolution walking up from dist/server/ to node_modules/.
// No manual copy needed — putting it in package.json is the correct approach.
console.log("cycletls will be bundled via node_modules (listed in package.json dependencies)");

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
