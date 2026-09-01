import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// ── Source files ──────────────────────────────────────────────────────
const mcpSource = await readFile(
  new URL("../lib/arena-mcp.ts", import.meta.url),
  "utf8",
);
const agentChatSource = await readFile(
  new URL("../lib/agent-chat.ts", import.meta.url),
  "utf8",
);
const heartbeatRouteSource = await readFile(
  new URL("../app/api/agent/heartbeat/route.ts", import.meta.url),
  "utf8",
);
const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);

// ═══════════════════════════════════════════════════════════════════════
// 1 — MCP already-connected named error
// ═══════════════════════════════════════════════════════════════════════

test("connect_agent switches on CompletePairingResult, not truthiness", () => {
  assert.doesNotMatch(
    mcpSource,
    /if\s*\(\s*!paired\s*\)/,
    "connect_agent must not use truthiness check on completePairing result",
  );
  assert.match(
    mcpSource,
    /switch\s*\(\s*paired\s*\)/,
    "connect_agent must switch on the completePairing result",
  );
});

test("connect_agent throws named error for already_connected", () => {
  assert.match(
    mcpSource,
    /case\s+"already_connected"\s*:\s*\n?\s*throw new Error\("This bot is already connected\."\)/,
    "connect_agent must throw named error for already_connected",
  );
});

test("connect_agent does not return connected:true for already_connected", () => {
  const alreadyConnectedBlock = mcpSource.slice(
    mcpSource.indexOf('case "already_connected"'),
    mcpSource.indexOf('case "invalid"'),
  );
  assert.doesNotMatch(
    alreadyConnectedBlock,
    /connected:\s*true/,
    "already_connected case must not return connected:true",
  );
});

test("connect_agent handles invalid case", () => {
  assert.match(
    mcpSource,
    /case\s+"invalid"/,
    "connect_agent must handle the invalid case",
  );
});

test("connect_agent has exhaustive default with never check", () => {
  assert.match(
    mcpSource,
    /default:\s*\{[\s\S]*?never[\s\S]*?\}/,
    "connect_agent switch must have a never-check default for exhaustiveness",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// 2 — Offline wake stays waiting until back
// ═══════════════════════════════════════════════════════════════════════

test("notifyMessageRecipient does not write failed to DB on webhook failure", () => {
  assert.doesNotMatch(
    agentChatSource,
    /status:\s*"failed"/,
    "agent-chat must not set wake status to 'failed' anywhere",
  );
});

test("notifyMessageRecipient returns pending (not failed) on webhook failure", () => {
  assert.match(
    agentChatSource,
    /\{\s*status:\s*"pending"\s*\}/,
    "catch block must return { status: 'pending' } on webhook failure",
  );
});

test("MessageWakeResult status is notified or pending, not failed", () => {
  assert.match(
    agentChatSource,
    /status:\s*"notified"\s*\|\s*"pending"/,
    "MessageWakeResult status must be 'notified' | 'pending'",
  );
});

test("MessageDeliverySummary uses pending instead of failed", () => {
  assert.match(
    agentChatSource,
    /pending:\s*number/,
    "MessageDeliverySummary must have a pending field instead of failed",
  );
  const summaryType = agentChatSource.slice(
    agentChatSource.indexOf("export type MessageDeliverySummary"),
    agentChatSource.indexOf("};", agentChatSource.indexOf("export type MessageDeliverySummary")) + 2,
  );
  assert.doesNotMatch(
    summaryType,
    /failed:\s*number/,
    "MessageDeliverySummary must not have a failed field",
  );
});

test("toPublicMessage never produces wake_failed or partial deliveryStatus", () => {
  assert.doesNotMatch(
    agentChatSource,
    /["']wake_failed["']/,
    "toPublicMessage must not reference wake_failed",
  );
  const deliveryStatusBlock = agentChatSource.slice(
    agentChatSource.indexOf("const deliveryStatus: PublicMessage"),
    agentChatSource.indexOf("const audienceAgents"),
  );
  assert.doesNotMatch(
    deliveryStatusBlock,
    /["']partial["']/,
    "deliveryStatus derivation must not produce partial",
  );
});

test("retryPendingWakes is exported from agent-chat", () => {
  assert.match(
    agentChatSource,
    /export async function retryPendingWakes/,
    "retryPendingWakes must be an exported function",
  );
});

test("retryPendingWakes queries pending and failed rows with a cap", () => {
  assert.match(
    agentChatSource,
    /wake_status IN \('pending', 'failed'\)/,
    "retryPendingWakes must query both pending and legacy failed rows",
  );
  assert.match(
    agentChatSource,
    /LIMIT/,
    "retryPendingWakes must cap the number of retries",
  );
});

test("heartbeat route retries pending wakes via after()", () => {
  assert.match(
    heartbeatRouteSource,
    /after\(\s*async\s*\(\)\s*=>\s*\{[\s\S]*?retryPendingWakes/,
    "heartbeat route must call retryPendingWakes inside after()",
  );
});

test("MCP heartbeat tool retries pending wakes via after()", () => {
  const heartbeatToolBlock = mcpSource.slice(
    mcpSource.indexOf('"heartbeat"'),
  );
  assert.match(
    heartbeatToolBlock,
    /after\(\s*async\s*\(\)\s*=>\s*\{[\s\S]*?retryPendingWakes/,
    "MCP heartbeat tool must call retryPendingWakes inside after()",
  );
});

test("page never shows OFFLINE as delivery chip text", () => {
  const deliveryChipBlock = pageSource.slice(
    pageSource.indexOf("delivery-state delivery-state--"),
    pageSource.indexOf("</span>", pageSource.indexOf("delivery-state delivery-state--")) + 7,
  );
  assert.doesNotMatch(
    deliveryChipBlock,
    /"OFFLINE"/,
    "delivery chip must not show OFFLINE",
  );
});

test("page never shows PARTIAL as delivery chip text", () => {
  const deliveryChipBlock = pageSource.slice(
    pageSource.indexOf("delivery-state delivery-state--"),
    pageSource.indexOf("</span>", pageSource.indexOf("delivery-state delivery-state--")) + 7,
  );
  assert.doesNotMatch(
    deliveryChipBlock,
    /"PARTIAL"/,
    "delivery chip must not show PARTIAL",
  );
});

test("page shows WAITING for non-delivered non-read messages", () => {
  assert.match(
    pageSource,
    /:\s*"WAITING"/,
    "page must display WAITING for pending messages",
  );
});
