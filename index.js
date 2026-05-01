// Danny's Bot — Windows standalone launcher
const path = require("path");

process.env.PORT = process.env.PORT || "3000";
process.env.DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, "database.db");
process.env.NODE_ENV = process.env.NODE_ENV || "production";

require("./server/dist/index.cjs");
