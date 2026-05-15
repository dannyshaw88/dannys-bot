import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { profileUsernameCache } from "./lib/profileUsernameCache";

// Extract profile ID from URLs like /browser/1209/... or /profiles/1209/...
// Returns the username string (e.g. "@CeciliaCelineLumas") or "" if unknown.
function resolveAccountTag(url: string): string {
  const m = url.match(/\/(?:browser|profiles)\/(\d+)/);
  if (!m) return "";
  const username = profileUsernameCache.get(parseInt(m[1], 10));
  return username ? ` [@${username}]` : ` [#${m[1]}]`;
}

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    customSuccessMessage(req, res, responseTime) {
      const method = req.method ?? "?";
      const url = (req.url ?? "").split("?")[0];
      const status = res.statusCode;
      const ms = typeof responseTime === "number" ? ` ${Math.round(responseTime)}ms` : "";
      const acct = resolveAccountTag(url);
      return `${method} ${url}${acct} ${status}${ms}`;
    },
    customErrorMessage(req, res, err) {
      const method = req.method ?? "?";
      const url = (req.url ?? "").split("?")[0];
      const status = res.statusCode;
      const acct = resolveAccountTag(url);
      return `${method} ${url}${acct} ${status} — ${err?.message ?? "error"}`;
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
