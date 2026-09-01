import fs from "node:fs";

import { neon } from "@neondatabase/serverless";

const shouldRun =
  process.env.VERCEL_ENV === "production" ||
  process.env.ARENA_RUN_MIGRATIONS === "1";

if (!shouldRun) {
  console.log("Skipping the production Arena pairing-setup-prompt migration.");
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to migrate Arena production.");
}

const migration = fs.readFileSync(
  new URL("./migrations/0006_pairing_setup_prompt.sql", import.meta.url),
  "utf8",
);

const sql = neon(databaseUrl);
const statements = migration
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

await sql.transaction(statements.map((statement) => sql.query(statement)));

console.log("Arena pairing-setup-prompt migration is current.");
