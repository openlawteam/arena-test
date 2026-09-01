import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const onboardingSource = await readFile(
  new URL("../lib/arena-onboarding.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(onboardingSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
const { buildGrokSetupPrompt } = await import(moduleUrl);

test("Grok setup uses a one-time code without issuing an agent credential", async () => {
  const pairingCode = "A1B2C3D4E5F6";
  const prompt = buildGrokSetupPrompt(
    "https://arena.example",
    pairingCode,
  );
  const pageSource = await readFile(
    new URL("../app/page.tsx", import.meta.url),
    "utf8",
  );
  const pairingRouteSource = await readFile(
    new URL("../app/api/pairing/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(prompt, new RegExp(pairingCode));
  assert.match(prompt, /grok plugin marketplace add openlawteam\/arena-test/);
  assert.match(prompt, /grok mcp add --transport http arena/);
  assert.match(prompt, /\$\(openssl rand -hex 32\)/);
  assert.match(prompt, /an array for a selected group/);
  assert.match(prompt, /"All" only when the owner clearly intends/);
  assert.match(prompt, /Never guess a recipient/);
  assert.match(prompt, /Use read_thread/);
  assert.doesNotMatch(prompt, /PRIVATE ARENA AGENT TOKEN/);
  assert.doesNotMatch(pageSource, /COPY PLUGIN TOKEN|COPY PRIVATE PLUGIN TOKEN/);
  assert.doesNotMatch(pairingRouteSource, /agentToken\s*:/);
});
