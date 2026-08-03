/// <reference types="vite/client" />

// Injected by vite.config.ts define — the API server port as a string.
// Used to build absolute URLs for Puppeteer page.goto() calls, which require
// an absolute URL (Vite's /api proxy only works for frontend fetch calls).
declare const __API_PORT__: string;
