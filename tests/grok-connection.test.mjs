import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const source = await readFile(
  new URL("../lib/grok-connection.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
const {
  CONNECTION_TTL_SECONDS,
  newConnection,
  openConnection,
  sealConnection,
} = await import(moduleUrl);

process.env.ARENA_COOKIE_SECRET = "arena-test-secret";

function connection() {
  return newConnection({
    botName: "Test Agent",
    webhookUrl: "https://example.com/arena-hook",
    webhookKey: "test-webhook-key",
    authMode: "bearer",
  });
}

test("a recent heartbeat renews an older connection", () => {
  const active = connection();
  active.connectedAt = new Date(
    Date.now() - (CONNECTION_TTL_SECONDS + 60) * 1_000,
  ).toISOString();
  const heartbeatAt = new Date(Date.now() - 1_000).toISOString();

  assert.ok(openConnection(sealConnection(active), heartbeatAt));
});

test("an inactive connection still expires", () => {
  const inactive = connection();
  inactive.connectedAt = new Date(
    Date.now() - (CONNECTION_TTL_SECONDS + 60) * 1_000,
  ).toISOString();

  assert.equal(openConnection(sealConnection(inactive)), null);
});
