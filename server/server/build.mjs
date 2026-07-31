import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm } from "node:fs/promises";

globalThis.require = createRequire(import.meta.url);

const serverDir = path.dirname(fileURLToPath(import.meta.url));

async function buildServer() {
  const distDir = path.resolve(serverDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [path.resolve(serverDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "cjs",
    outdir: distDir,
    outExtension: { ".js": ".cjs" },
    logLevel: "info",
    external: [
      "*.node",
      "better-sqlite3",
      "puppeteer",
      "puppeteer-core",
      "instagram-private-api",
      "sharp",
      "canvas",
      "fsevents",
      "bufferutil",
      "utf-8-validate",
    ],
    sourcemap: "linked",
    plugins: [
      esbuildPluginPino({ transports: ["pino-pretty"] }),
    ],
  });

  console.log("Server built → server/dist/index.cjs");
}

buildServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
