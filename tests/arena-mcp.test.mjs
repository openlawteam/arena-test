import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const source = await readFile(
  new URL("../lib/arena-mcp-format.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
const { formatInboxReceipt, formatSendReceipt, formatSquadReceipt } =
  await import(moduleUrl);

test("squad receipt lists friends without duplicating the viewer", () => {
  const receipt = formatSquadReceipt("PizzaFriday", [
    { botName: "PizzaFriday", isSelf: true, status: "online" },
    { botName: "Ram Prices", isSelf: false, status: "offline" },
  ]);

  assert.match(receipt, /1 friend/);
  assert.match(receipt, /OFFLINE · Ram Prices/);
  assert.doesNotMatch(receipt, /ONLINE · PizzaFriday/);
});

test("send receipt exposes the exact public message in the private chat", () => {
  const receipt = formatSendReceipt({
    senderName: "PizzaFriday",
    recipientLabel: "Ram Prices",
    message: "Want to compare notes?",
    messageId: "4d1943f1-e272-4ce9-8be9-c234ad39ba7a",
    deliveryStatus: "notified",
  });

  assert.match(receipt, /ARENA PUBLIC SENT · PizzaFriday → Ram Prices/);
  assert.match(receipt, /Want to compare notes\?/);
  assert.match(receipt, /current private Grok Bot conversation/);
});

test("send receipt supports a squad-wide audience", () => {
  const receipt = formatSendReceipt({
    senderName: "PizzaFriday",
    recipientLabel: "All",
    message: "Who can help with this?",
    messageId: "5bb74b20-e901-4d05-8025-b8efb2dfbc83",
    deliveryStatus: "queued",
  });

  assert.match(receipt, /PizzaFriday → All/);
  assert.match(receipt, /STATUS · QUEUED/);
});

test("inbox receipt asks the bot to surface public inbound messages", () => {
  const receipt = formatInboxReceipt("PizzaFriday", [
    {
      id: "0c1384eb-2cc2-477b-ab2f-a1a5205ac22c",
      from: { botName: "Ram Prices" },
      to: { botName: "PizzaFriday" },
      audience: { label: "Thread · PizzaFriday, Design Boi" },
      message: "Here are my notes.",
    },
  ]);

  assert.match(receipt, /ARENA PUBLIC INBOX · 1 new/);
  assert.match(receipt, /RECEIVED · Ram Prices → Thread · PizzaFriday, Design Boi/);
  assert.match(receipt, /Here are my notes\./);
});

test("inbox receipt keeps an owner note private and advisory", () => {
  const receipt = formatInboxReceipt("PizzaFriday", [], [
    {
      id: "f66cbda1-e8d5-4bd1-8968-6841d78fbdb9",
      owner: { botName: "PizzaFriday" },
      target: { botName: "Ram Prices" },
      note: "Ram might have useful pricing context.",
    },
  ]);

  assert.match(receipt, /ARENA PRIVATE OWNER NOTES · 1 new/);
  assert.match(receipt, /helpful advisory context|advisory context/i);
  assert.match(receipt, /Use your own judgment/);
  assert.match(receipt, /never expose it in Arena's public transcript/i);
});
