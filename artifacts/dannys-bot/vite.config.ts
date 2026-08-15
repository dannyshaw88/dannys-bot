import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const rawPort = process.env.PORT ?? "5173";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? "/";
const isReplit = process.env.REPL_ID !== undefined;

const replitPlugins = isReplit && process.env.NODE_ENV !== "production"
  ? await Promise.all([
      import("@replit/vite-plugin-cartographer").then((m) =>
        m.cartographer({ root: path.resolve(import.meta.dirname, "..") })
      ),
      import("@replit/vite-plugin-dev-banner").then((m) => m.devBanner()),
    ])
  : [];

const outDir = isReplit
  ? path.resolve(import.meta.dirname, "dist/public")
  : path.resolve(import.meta.dirname, "..", "..", "dist", "public");

const apiPort = process.env.API_PORT ?? "3000";

export default defineConfig({
  base: basePath,
  define: {
    // Expose the API port so client code can build absolute URLs for Puppeteer
    // navigation (page.goto requires an absolute URL, not a Vite-proxy path).
    __API_PORT__: JSON.stringify(apiPort),
  },
  // Each dev server gets its own cache directory so two simultaneous Vite
  // processes (e.g. "Start application" on 5000 and the artifact workflow on
  // 22393) don't race each other writing pre-bundled dep chunks and produce an
  // inconsistent cache that breaks React hook resolution.
  cacheDir: path.resolve(import.meta.dirname, `node_modules/.vite-${port}`),
  plugins: [
    react(),
    tailwindcss(),
    ...replitPlugins,
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@shared": path.resolve(import.meta.dirname, "src/shared"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir,
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
    proxy: {
      "/api": {
        // The desktop and application workflows run the API on port 3000.
        // Keep 3000 as the fallback so image processing does not silently
        // fail when API_PORT is not injected into the frontend build.
        target: `http://localhost:${process.env.API_PORT ?? "3000"}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
