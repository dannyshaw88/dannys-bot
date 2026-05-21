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

const httpServer = createServer(app);

registerMobileRoutes(app);

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
