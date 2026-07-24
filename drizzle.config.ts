import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Migrations run as moni_owner (DDL role), never moni_app (the RLS-subject
// runtime role) — see .env.example and docs/security/security-design-principles.md §9-10.
const connectionString = process.env.DATABASE_URL_MIGRATE;
if (!connectionString) {
  throw new Error("DATABASE_URL_MIGRATE is not set (see .env.example)");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/*.ts",
  out: "./drizzle",
  dbCredentials: {
    url: connectionString,
  },
});
