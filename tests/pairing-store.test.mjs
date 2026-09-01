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

test("roster generates a stable unique blockie from each agent id", () => {
  assert.match(pageSource, /function createBlockie/);
  assert.match(pageSource, /agent\.id.*agent\.botName/s);
  assert.match(pageSource, /shapeRendering="crispEdges"/);
  assert.match(pageSource, /const mirrorX = 7 - x/);
});

test("agent flyout sends private context to the owner's Bot", () => {
  assert.match(pageSource, /\/api\/owner-instructions/);
  assert.match(pageSource, /Private note to/);
  assert.match(pageSource, /helpful context/);
  assert.match(pageSource, /It decides whether/);
  assert.doesNotMatch(pageSource, /COPY ID/);
  assert.doesNotMatch(pageSource, /document\.execCommand\("copy"\)/);
});

test("agent messages open the same private kickoff flow", () => {
  assert.match(pageSource, /function openMessageAgent/);
  assert.match(pageSource, /onClick=\{\(\) => openMessageAgent\(msg\)\}/);
  assert.match(pageSource, /flyout-pair__avatars/);
});

test("page restores waiting state from sessionStorage on refresh", () => {
  assert.match(pageSource, /sessionStorage\.getItem\(PAIRING_STORAGE_KEY\)/);
  assert.match(pageSource, /phase: "waiting"/);
});

test("named error messages for common failures", () => {
  assert.match(pageSource, /Connect expired\./);
  assert.match(pageSource, /Open Grok Bot to finish\./);
  assert.match(pageSource, /This bot is already connected\./);
  assert.match(pageSource, /TRY AGAIN/);
});

test("pairing overlays can be dismissed without retrying", () => {
  assert.match(pageSource, /dismissConnectOverlay/);
  assert.match(pageSource, /Dismiss connection dialog/);
  assert.match(pageSource, /overlay-sheet__close/);
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

test("already-connected webhook returns named error from complete route", () => {
  assert.match(completeRouteSource, /already_connected/);
  assert.match(completeRouteSource, /This bot is already connected\./);
});

test("completePairing marks row consumed with fail_reason on duplicate", () => {
  assert.match(source, /already_connected/);
  assert.match(source, /fail_reason = 'already_connected'/);
  assert.match(source, /export type CompletePairingResult/);
});

test("claimPairing returns already_connected when fail_reason is set", () => {
  assert.match(source, /fail_reason === "already_connected"/);
  assert.match(source, /status: "already_connected"/);
});

test("status endpoint returns 409 for already-connected claims", () => {
  assert.match(statusRouteSource, /already_connected/);
  assert.match(statusRouteSource, /409/);
  assert.match(statusRouteSource, /This bot is already connected\./);
});

test("browser poll detects 409 and shows already-connected error", () => {
  assert.match(pageSource, /res\.status === 409/);
  assert.match(pageSource, /This bot is already connected\./);
});

test("remove drops roster row optimistically (no 5s ghost)", () => {
  assert.match(pageSource, /setAgents\(\(?prev\)?\s*=>\s*prev\.filter/);
});

test("missed deep link does not auto-open fallback docs URL", () => {
  assert.doesNotMatch(pageSource, /window\.open\(/);
  assert.doesNotMatch(pageSource, /docs\.x\.ai/);
});

test("CONNECT/REMOVE in roster on desktop, bottom chrome on mobile", () => {
  assert.match(pageSource, /roster-action/);
  assert.match(pageSource, /room-chrome/);
  assert.match(pageSource, /room-action--connect/);
  assert.match(pageSource, /room-action--remove/);
});

const cssSource = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

test("generated roster avatars render as clipped pixel blockies", () => {
  assert.match(cssSource, /\.roster-avatar--blockie/);
  assert.match(cssSource, /\.roster-avatar--blockie svg/);
});

test("desktop layout is side-by-side with a resizable roster action rail", () => {
  assert.match(cssSource, /grid-template-columns:\s*var\(--roster-width/);
  assert.doesNotMatch(cssSource, /width:\s*min\(100%,\s*640px\)/);
  assert.match(cssSource, /\.roster-action\s*\{[^}]*display:\s*flex/s);
  assert.match(cssSource, /\.roster-resize-handle\s*\{/);
  assert.match(cssSource, /\.room-chrome\s*\{[^}]*display:\s*none/s);
});

test("clickable transcript messages retain compact left-aligned typography", () => {
  assert.match(cssSource, /\.message-body\s*\{[^}]*font-size:\s*13px/s);
  assert.match(cssSource, /\.message-body\s*\{[^}]*text-align:\s*left/s);
});
