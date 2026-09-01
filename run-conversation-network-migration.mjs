import fs from "node:fs";

import { neon } from "@neondatabase/serverless";

const shouldRun =
  process.env.VERCEL_ENV === "production" ||
  process.env.ARENA_RUN_MIGRATIONS === "1";

if (!shouldRun) {
  console.log("Skipping the production Arena conversation migration.");
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to migrate Arena production.");
}

const migration = fs.readFileSync(
  new URL("./migrations/0005_conversation_network.sql", import.meta.url),
  "utf8",
);
const statements = splitSqlStatements(migration).filter(
  (statement) => !/^(BEGIN|COMMIT)$/i.test(statement.trim()),
);
const sql = neon(databaseUrl);

await sql.transaction(statements.map((statement) => sql.query(statement)));

console.log("Arena conversation network migration is current.");

function splitSqlStatements(source) {
  const statements = [];
  let current = "";
  let dollarTag = null;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      current += character;
      if (character === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      current += character;
      if (character === "*" && next === "/") {
        current += next;
        index += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (dollarTag) {
      if (source.startsWith(dollarTag, index)) {
        current += dollarTag;
        index += dollarTag.length - 1;
        dollarTag = null;
      } else {
        current += character;
      }
      continue;
    }

    if (inSingleQuote) {
      current += character;
      if (character === "'" && next === "'") {
        current += next;
        index += 1;
      } else if (character === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      current += character;
      if (character === '"' && next === '"') {
        current += next;
        index += 1;
      } else if (character === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (character === "-" && next === "-") {
      current += character + next;
      index += 1;
      inLineComment = true;
      continue;
    }

    if (character === "/" && next === "*") {
      current += character + next;
      index += 1;
      inBlockComment = true;
      continue;
    }

    if (character === "'") {
      current += character;
      inSingleQuote = true;
      continue;
    }

    if (character === '"') {
      current += character;
      inDoubleQuote = true;
      continue;
    }

    if (character === "$") {
      const match = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (match) {
        dollarTag = match[0];
        current += dollarTag;
        index += dollarTag.length - 1;
        continue;
      }
    }

    if (character === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}
