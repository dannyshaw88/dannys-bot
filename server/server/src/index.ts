import { createServer } from "http";
import path from "path";
import fs from "fs";
import express from "express";
import app from "./app";
import { logger } from "./logger";
import { registerInstagramRoutes } from "./routes/instagram";

const port = Number(process.env["PORT"] ?? "3000");

const httpServer = createServer(app);

registerInstagramRoutes(httpServer, app).then(() => {
  const frontendDist = path.join(__dirname, "..", "..", "dist", "public");
  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.use((_req, res) => {
      res.sendFile(path.join(frontendDist, "index.html"));
    });
    logger.info({ frontendDist }, "Serving frontend static files");
  } else {
    logger.warn({ frontendDist }, "Frontend dist not found — run npm run build:client");
  }

  httpServer.listen(port, () => {
    logger.info({ port }, `Danny's Bot running at http://localhost:${port}`);
  });
}).catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
