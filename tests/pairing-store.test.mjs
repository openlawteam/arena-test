import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../lib/pairing-store.ts", import.meta.url),
  "utf8",
);

test("createPairing accepts a setup prompt parameter", () => {
  assert.match(source, /async function createPairing\(\s*setupPrompt\s*:\s*string/);
});

test("createPairing inserts setup_prompt into the database", () => {
  assert.match(source, /setup_prompt/);
  assert.match(source, /\$\{setupPrompt\}/);
});

test("updatePairingPrompt updates setup_prompt for a waiting pairing", () => {
  assert.match(source, /async function updatePairingPrompt/);
  assert.match(source, /SET setup_prompt/);
  assert.match(source, /AND status = 'waiting'/);
});

test("claimPairing returns setupPrompt when status is waiting", () => {
  assert.match(source, /SELECT.*setup_prompt/s);
  assert.match(source, /setupPrompt:\s*row\.setup_prompt/);
});

test("PairingClaim waiting variant includes setupPrompt", () => {
  assert.match(source, /status:\s*"waiting";\s*setupPrompt:\s*string\s*\|\s*null/);
});

test("consumePairingByConnectionId marks the pairing as consumed", () => {
  assert.match(source, /async function consumePairingByConnectionId/);
  assert.match(source, /SET status = 'consumed'/);
});

const statusRouteSource = await readFile(
  new URL("../app/api/pairing/status/route.ts", import.meta.url),
  "utf8",
);

test("pairing status endpoint returns prompt when waiting", () => {
  assert.match(statusRouteSource, /prompt:\s*claim\.setupPrompt/);
});

const pairingRouteSource = await readFile(
  new URL("../app/api/pairing/route.ts", import.meta.url),
  "utf8",
);

test("pairing route persists prompt via updatePairingPrompt", () => {
  assert.match(pairingRouteSource, /updatePairingPrompt/);
});

const migrationSource = await readFile(
  new URL("../migrations/0006_pairing_setup_prompt.sql", import.meta.url),
  "utf8",
);

test("migration 0006 adds setup_prompt column to arena_pairings", () => {
  assert.match(migrationSource, /ALTER TABLE arena_pairings/i);
  assert.match(migrationSource, /ADD COLUMN.*setup_prompt/i);
});

const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);

test("page has no connect hero (no 100vh hero section)", () => {
  assert.doesNotMatch(pageSource, /pair-hero/);
  assert.doesNotMatch(pageSource, /PizzaFriday/);
});

test("page shows empty states for roster and transcript", () => {
  assert.match(pageSource, /No agents yet/);
  assert.match(pageSource, /No Arena messages yet/);
});

test("page uses CONNECT / REMOVE in the same slot", () => {
  assert.match(pageSource, /CONNECT/);
  assert.match(pageSource, /REMOVE/);
  assert.match(pageSource, /room-action--connect/);
  assert.match(pageSource, /room-action--remove/);
});

test("roster marks the owner's agent as YOU", () => {
  assert.match(pageSource, /roster-you/);
  assert.match(pageSource, /YOU<\/span>/);
});

test("page restores waiting state from sessionStorage on refresh", () => {
  assert.match(pageSource, /sessionStorage\.getItem\(PAIRING_STORAGE_KEY\)/);
  assert.match(pageSource, /phase: "waiting"/);
});

test("named error messages for common failures", () => {
  assert.match(pageSource, /Connect expired\./);
  assert.match(pageSource, /Open Grok Bot to finish\./);
  assert.match(pageSource, /TRY AGAIN/);
});

const connectionRouteSource = await readFile(
  new URL("../app/api/connection/route.ts", import.meta.url),
  "utf8",
);

test("DELETE /api/connection consumes pairing in the database", () => {
  assert.match(connectionRouteSource, /consumePairingByConnectionId/);
});

const completeRouteSource = await readFile(
  new URL("../app/api/pairing/complete/route.ts", import.meta.url),
  "utf8",
);

test("already-connected webhook returns named error", () => {
  assert.match(completeRouteSource, /already_connected/);
  assert.match(completeRouteSource, /This bot is already connected\./);
});

test("completePairing returns already_connected for duplicate webhook", () => {
  assert.match(source, /already_connected/);
  assert.match(source, /export type CompletePairingResult/);
});

test("remove drops roster row optimistically (no 5s ghost)", () => {
  assert.match(pageSource, /setAgents\(\(?prev\)?\s*=>\s*prev\.filter/);
});

test("missed deep link does not auto-open fallback docs URL", () => {
  assert.doesNotMatch(pageSource, /window\.open\(/);
  assert.doesNotMatch(pageSource, /docs\.x\.ai/);
});

test("CONNECT/REMOVE is in bottom chrome, not header", () => {
  assert.match(pageSource, /room-chrome/);
  assert.match(pageSource, /room-action--connect/);
  assert.match(pageSource, /room-action--remove/);
});

const cssSource = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

test("desktop layout is side-by-side (not single column)", () => {
  assert.match(cssSource, /grid-template-columns:\s*minmax/);
  assert.doesNotMatch(cssSource, /width:\s*min\(100%,\s*640px\)/);
});
