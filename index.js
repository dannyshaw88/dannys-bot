// Danny's Bot — Windows standalone launcher
// Sets required environment variables then starts the pre-built server.
const path = require("path");

process.env.PORT = process.env.PORT || "3000";
process.env.DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, "database.db");

(async () => {
  await import("./artifacts/api-server/dist/index.mjs");
})();
