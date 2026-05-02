import { build as esbuild } from "esbuild";
import { cp, rm, mkdir } from "fs/promises";
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

console.log("Electron build complete → dist/");
