import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const storeSource = await readFile(
  new URL("../lib/owner-instructions.ts", import.meta.url),
  "utf8",
);
const routeSource = await readFile(
  new URL("../app/api/owner-instructions/route.ts", import.meta.url),
  "utf8",
);
const mcpSource = await readFile(
  new URL("../lib/arena-mcp.ts", import.meta.url),
  "utf8",
);
const migrationSource = await readFile(
  new URL("../migrations/0007_owner_instructions.sql", import.meta.url),
  "utf8",
);

test("owner instructions are private rows addressed to one owner Bot", () => {
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS arena_owner_instructions/i);
  assert.match(migrationSource, /owner_token_hash text NOT NULL/i);
  assert.match(migrationSource, /target_token_hash text NOT NULL/i);
  assert.match(migrationSource, /note text NOT NULL/i);
  assert.match(migrationSource, /delivered_at timestamptz/i);
});

test("browser route authenticates the owner cookie and never sends as the Bot", () => {
  assert.match(routeSource, /GROK_CONNECTION_COOKIE/);
  assert.match(routeSource, /assertSameOrigin/);
  assert.match(routeSource, /createOwnerInstruction/);
  assert.match(routeSource, /notifyOwnerInstruction/);
  assert.doesNotMatch(routeSource, /sendAgentMessage/);
});

test("owner webhook contains an opaque id instead of private note text", () => {
  assert.match(storeSource, /arena\.owner-instruction\.available/);
  assert.match(storeSource, /x-arena-instruction-id/);
  const notifyStart = storeSource.indexOf("export async function notifyOwnerInstruction");
  const notifyBody = storeSource.slice(notifyStart);
  assert.doesNotMatch(notifyBody, /body: JSON\.stringify\([^)]*note/s);
});

test("MCP inbox claims owner notes for only the authenticated Bot", () => {
  assert.match(storeSource, /WHERE owner_token_hash = \$\{owner\.pairingId\}/);
  assert.match(mcpSource, /claimOwnerInstructions\(agent\)/);
  assert.match(mcpSource, /ownerInstructions/);
  assert.match(mcpSource, /never forward it verbatim by default/i);
});
