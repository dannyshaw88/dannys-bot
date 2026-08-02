import { defineConfig } from "drizzle-kit";
import path from "path";

const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), "database.db");

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "sqlite",
  dbCredentials: {
    url: dbPath,
  },
});
