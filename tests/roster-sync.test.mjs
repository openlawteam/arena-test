import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const source = await readFile(
  new URL("../lib/roster-sync.ts", import.meta.url),
  "utf8",
);

const stripped = source.replace(
  /import\s+type\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?/g,
  "",
);

const { outputText } = ts.transpileModule(stripped, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
const { shouldClearStaleConnection } = await import(moduleUrl);

function makeConnection(overrides = {}) {
  return {
    connectionId: "conn-1",
    botName: "Ash",
    avatarUrl: null,
    host: "example.com",
    authMode: "bearer",
    connectedAt: new Date(Date.now() - 60_000).toISOString(),
    lastWakeAt: null,
    ...overrides,
  };
}

// ── Core scenario: header should clear when self is gone from roster ──

test("clears when agents loaded and self is not in roster", () => {
  const conn = makeConnection();
  const agents = [{ id: "other-agent" }];
  assert.equal(shouldClearStaleConnection(conn, agents, true), true);
});

test("does NOT clear when self IS in roster", () => {
  const conn = makeConnection();
  const agents = [{ id: "conn-1" }, { id: "other-agent" }];
  assert.equal(shouldClearStaleConnection(conn, agents, true), false);
});

// ── Guards ────────────────────────────────────────────────────────────

test("does NOT clear when connection is null", () => {
  assert.equal(shouldClearStaleConnection(null, [{ id: "a" }], true), false);
});

test("does NOT clear when agents have not loaded yet", () => {
  const conn = makeConnection();
  assert.equal(shouldClearStaleConnection(conn, [], false), false);
});

// ── Grace period after fresh pairing ─────────────────────────────────

test("does NOT clear a fresh connection within the grace period", () => {
  const conn = makeConnection({ connectedAt: new Date().toISOString() });
  const agents = [];
  const now = Date.now();
  assert.equal(
    shouldClearStaleConnection(conn, agents, true, 15_000, now),
    false,
  );
});

test("clears a connection that is older than the grace period", () => {
  const conn = makeConnection({
    connectedAt: new Date(Date.now() - 30_000).toISOString(),
  });
  const agents = [{ id: "someone-else" }];
  const now = Date.now();
  assert.equal(
    shouldClearStaleConnection(conn, agents, true, 15_000, now),
    true,
  );
});

// ── Stale-cookie-after-REMOVE scenario (the reported QA fail) ────────

test("stale cookie + consumed pairing → clears connection", () => {
  const conn = makeConnection({
    connectedAt: new Date(Date.now() - 3_600_000).toISOString(),
  });
  const rosterWithoutSelf = [
    { id: "PizzaFriday" },
    { id: "RamPrices" },
  ];
  assert.equal(
    shouldClearStaleConnection(conn, rosterWithoutSelf, true),
    true,
    "header chrome should switch to CONNECT when self is gone from roster",
  );
});

// ── Empty roster after agents loaded ─────────────────────────────────

test("clears when roster is empty and connection is old", () => {
  const conn = makeConnection({
    connectedAt: new Date(Date.now() - 120_000).toISOString(),
  });
  assert.equal(shouldClearStaleConnection(conn, [], true), true);
});

test("does NOT clear empty roster for a fresh connection", () => {
  const conn = makeConnection({
    connectedAt: new Date(Date.now() - 5_000).toISOString(),
  });
  const now = Date.now();
  assert.equal(
    shouldClearStaleConnection(conn, [], true, 15_000, now),
    false,
  );
});
