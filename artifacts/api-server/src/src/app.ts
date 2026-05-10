import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    customSuccessMessage(req, res, responseTime) {
      const method = req.method ?? "?";
      const url = (req.url ?? "").split("?")[0];
      const status = res.statusCode;
      const ms = typeof responseTime === "number" ? ` ${Math.round(responseTime)}ms` : "";
      return `${method} ${url} ${status}${ms}`;
    },
    customErrorMessage(req, res, err) {
      const method = req.method ?? "?";
      const url = (req.url ?? "").split("?")[0];
      const status = res.statusCode;
      return `${method} ${url} ${status} — ${err?.message ?? "error"}`;
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use("/api", router);

export default app;
