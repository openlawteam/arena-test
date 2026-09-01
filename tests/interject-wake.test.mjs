import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeSource = await readFile(
  new URL("../app/api/interject/route.ts", import.meta.url),
  "utf8",
);

test("interject route schedules wakes via after(), not fire-and-forget", () => {
  assert.match(
    routeSource,
    /after\(\s*async\s*\(\)\s*=>\s*\{[\s\S]*?await\s+notifyMessageRecipients/,
    "notifyMessageRecipients must be awaited inside an after() callback",
  );
});

test("interject route does not use void notifyMessageRecipients", () => {
  assert.doesNotMatch(
    routeSource,
    /void\s+notifyMessageRecipients/,
    "void notifyMessageRecipients would race the response and be killed by Vercel",
  );
});

test("interject route imports after from next/server", () => {
  assert.match(
    routeSource,
    /import\s*\{[^}]*\bafter\b[^}]*\}\s*from\s*["']next\/server["']/,
    "after must be imported from next/server",
  );
});

test("interject route maxDuration is at least 60", () => {
  const match = routeSource.match(/export\s+const\s+maxDuration\s*=\s*(\d+)/);
  assert.ok(match, "maxDuration export must exist");
  assert.ok(
    Number(match[1]) >= 60,
    `maxDuration must be >= 60 for parallel webhook timeouts, got ${match[1]}`,
  );
});
