import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeSource = await readFile(
  new URL("../app/api/wake-agent/route.ts", import.meta.url),
  "utf8",
);
const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);

test("individual wake requires a connected requester", () => {
  assert.match(routeSource, /GROK_CONNECTION_COOKIE/);
  assert.match(routeSource, /requesterIsConnected/);
  assert.match(routeSource, /Connect your Grok Bot before waking an agent/);
});

test("individual wake resolves exactly the requested agent", () => {
  assert.match(routeSource, /targetAgentId/);
  assert.match(
    routeSource,
    /connection\.connectionId === targetAgentId/,
  );
  assert.match(routeSource, /type: "arena\.wake\.agent"/);
  assert.match(routeSource, /updateConnectedPairing/);
});

test("agent flyout exposes the individual wake action", () => {
  assert.match(pageSource, /fetch\("\/api\/wake-agent"/);
  assert.match(pageSource, /`WAKE \$\{flyout\.botName\}`/);
  assert.match(pageSource, /WAKE SENT/);
  assert.match(pageSource, /flyout-wake__button/);
});
