/**
 * Image Generation proxy routes.
 *
 * Forwards /api/image-gen/* requests to the Python sidecar (FastAPI server)
 * that runs on IMAGE_GEN_PORT.  If IMAGE_GEN_PORT is not set (web mode / no
 * sidecar), routes return a structured "unavailable" response so the UI can
 * show an appropriate message without an unhandled error.
 */
import { Router, type Request, type Response } from "express";
import http from "http";

// Read once at startup — Electron passes this env var before spawning us.
const IMAGE_GEN_PORT = Number(process.env.IMAGE_GEN_PORT ?? "0");

function proxyToSidecar(
  req: Request,
  res: Response,
  method: "GET" | "POST",
  sidePath: string,
  bodyStr?: string,
): void {
  if (!IMAGE_GEN_PORT) {
    res
      .status(503)
      .json({ error: "Image generation is only available in the desktop app.", available: false });
    return;
  }

  const options: http.RequestOptions = {
    hostname: "127.0.0.1",
    port: IMAGE_GEN_PORT,
    path: sidePath,
    method,
    headers: {
      "Content-Type": "application/json",
      ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
    },
    // Long timeout for model loading / generation
    timeout: 300_000,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.status(proxyRes.statusCode ?? 200);
    // Forward content-type so images and JSON both stream correctly
    const ct = proxyRes.headers["content-type"];
    if (ct) res.setHeader("Content-Type", ct);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err: NodeJS.ErrnoException) => {
    const refused = err.code === "ECONNREFUSED" || err.code === "ECONNRESET";
    const msg = refused
      ? "Image generation server is not running. Please set it up from the AI Images page."
      : err.message;
    res.status(503).json({ error: msg, available: false });
  });

  proxyReq.on("timeout", () => {
    proxyReq.destroy();
    res.status(504).json({ error: "Generation timed out.", available: true });
  });

  if (bodyStr) proxyReq.write(bodyStr);
  proxyReq.end();
}

const router = Router();

// ── Status ────────────────────────────────────────────────────────────────────
router.get("/api/image-gen/status", (req, res) => {
  if (!IMAGE_GEN_PORT) {
    // Structured unavailable — UI reads this to show "desktop only" message
    res.json({
      status: "unavailable",
      message: "Image generation is only available in the Aura Farming desktop app.",
      available: false,
      loaded_model: null,
      available_models: {},
    });
    return;
  }
  proxyToSidecar(req, res, "GET", "/status");
});

// ── Load model ────────────────────────────────────────────────────────────────
router.post("/api/image-gen/load", (req, res) => {
  proxyToSidecar(req, res, "POST", "/load", JSON.stringify(req.body));
});

// ── Generate image ────────────────────────────────────────────────────────────
router.post("/api/image-gen/generate", (req, res) => {
  proxyToSidecar(req, res, "POST", "/generate", JSON.stringify(req.body));
});

// ── Output history ────────────────────────────────────────────────────────────
router.get("/api/image-gen/output", (req, res) => {
  proxyToSidecar(req, res, "GET", "/output");
});

router.get("/api/image-gen/output/:filename", (req, res) => {
  const { filename } = req.params;
  // Basic path-traversal guard before forwarding
  if (!filename || filename.includes("..") || filename.includes("/")) {
    res.status(400).json({ error: "Invalid filename" });
    return;
  }
  proxyToSidecar(req, res, "GET", `/output/${encodeURIComponent(filename)}`);
});

export function registerImageGenRoutes(app: import("express").Express): void {
  app.use(router);
}
