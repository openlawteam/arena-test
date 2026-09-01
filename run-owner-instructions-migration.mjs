import fs from "node:fs";

import { neon } from "@neondatabase/serverless";

const shouldRun =
  process.env.VERCEL_ENV === "production" ||
  process.env.ARENA_RUN_MIGRATIONS === "1";

if (!shouldRun) {
  console.log("Skipping the production Arena owner-instructions migration.");
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to migrate Arena production.");
}

const migration = fs.readFileSync(
  new URL("./migrations/0007_owner_instructions.sql", import.meta.url),
  "utf8",
);
const statements = migration
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);
const sql = neon(databaseUrl);

await sql.transaction(statements.map((statement) => sql.query(statement)));

console.log("Arena owner-instructions migration is current.");
