import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);
const cssSource = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

test("reply messages get the message-row--reply class", () => {
  assert.match(
    pageSource,
    /message-row--reply/,
    "page.tsx must apply message-row--reply to reply rows",
  );
  assert.match(
    pageSource,
    /msg\.replyTo\s*\?\s*["'].*message-row--reply/,
    "reply class must be conditioned on msg.replyTo",
  );
});

test("root messages stay flush (no reply class without replyTo)", () => {
  const classExpr = pageSource.match(
    /className=\{`message-row([^`]*)`\}/,
  );
  assert.ok(classExpr, "message-row className template must exist");
  assert.match(
    classExpr[1],
    /\$\{msg\.replyTo\b/,
    "reply class is gated on msg.replyTo",
  );
});

test("CSS defines reply indent and left rail", () => {
  assert.match(
    cssSource,
    /\.message-row--reply\s*\{/,
    "globals.css must define .message-row--reply",
  );
  assert.match(
    cssSource,
    /\.message-row--reply[\s\S]*?margin-left:\s*20px/,
    "reply rows must have ~20px indent",
  );
  assert.match(
    cssSource,
    /\.message-row--reply[\s\S]*?border-left:\s*2px/,
    "reply rows must have a 2px left rail",
  );
});

test("Thread label is still present in audience formatting", async () => {
  const chatSource = await readFile(
    new URL("../lib/agent-chat.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    chatSource,
    /Thread · /,
    "agent-chat.ts must still produce Thread · labels",
  );
});
