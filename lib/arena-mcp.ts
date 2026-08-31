import {
  McpServer,
  createMcpHandler,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  AUTH_MODES,
  newConnection,
  sealConnection,
  type AuthMode,
} from "@/lib/grok-connection";
import {
  claimInbox,
  listAgentSquad,
  markMessageRead,
  notifyMessageRecipient,
  sendAgentMessage,
  type AuthenticatedAgent,
} from "@/lib/agent-chat";
import {
  formatInboxReceipt,
  formatSendReceipt,
  formatSquadReceipt,
} from "@/lib/arena-mcp-format";
import { completePairing } from "@/lib/pairing-store";

const AgentSchema = z.object({
  id: z.string(),
  botName: z.string(),
  avatarUrl: z.string().nullable(),
  isSelf: z.boolean(),
  status: z.enum(["online", "offline"]),
});

const PublicMessageSchema = z.object({
  id: z.string(),
  from: z.object({ id: z.string(), botName: z.string() }),
  to: z.object({ id: z.string(), botName: z.string() }),
  message: z.string(),
  replyTo: z.string().nullable(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  readAt: z.string().nullable(),
  deliveryStatus: z.enum([
    "pending",
    "notified",
    "delivered",
    "read",
    "wake_failed",
  ]),
});

const InboxMessageSchema = PublicMessageSchema.extend({
  canReply: z.boolean(),
});

export function createArenaMcpHandler(
  agent: AuthenticatedAgent,
): McpHttpHandler {
  return createMcpHandler(() => createArenaMcpServer(agent), {
    legacy: "stateless",
  });
}

export function createArenaSetupMcpHandler(
  agentToken: string,
): McpHttpHandler {
  return createMcpHandler(() => createArenaSetupMcpServer(agentToken), {
    legacy: "stateless",
  });
}

function createArenaSetupMcpServer(agentToken: string): McpServer {
  const server = new McpServer(
    { name: "arena", version: "0.1.0", title: "Arena" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "connect_agent",
    {
      title: "Connect this Grok Bot to Arena",
      description:
        "Exchange a short-lived Arena pairing code after creating this Bot's active Arena message-listener webhook Routine. Submit the Routine's generated webhook URL and sender key. The MCP's privately generated bearer credential becomes this agent's credential after setup succeeds.",
      inputSchema: z.object({
        pairingCode: z.string().regex(/^[A-Fa-f0-9]{12}$/),
        botName: z.string().min(1).max(48),
        avatarUrl: z.string().url().optional(),
        webhookUrl: z.string().url(),
        webhookKey: z.string().min(8).max(1_024),
        authMode: z.enum(AUTH_MODES).default("bearer"),
      }),
      outputSchema: z.object({
        connected: z.literal(true),
        botName: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ pairingCode, botName, avatarUrl, webhookUrl, webhookKey, authMode }) => {
      const connection = newConnection({
        botName,
        avatarUrl,
        webhookUrl,
        webhookKey,
        authMode: authMode as AuthMode,
      });
      const paired = await completePairing(
        pairingCode.toUpperCase(),
        agentToken,
        sealConnection(connection),
      );
      if (!paired) {
        throw new Error(
          "That Arena pairing code expired or was already used. Start a new Connect a Grok Bot flow in Arena.",
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `CONNECTED TO ARENA · ${connection.botName}\nThe squad, inbox, messaging, and heartbeat tools are now available on the next Arena call. Keep all connector credentials private.`,
          },
        ],
        structuredContent: {
          connected: true as const,
          botName: connection.botName,
        },
      };
    },
  );

  return server;
}

export function createArenaMcpServer(agent: AuthenticatedAgent): McpServer {
  const server = new McpServer(
    { name: "arena", version: "0.1.0", title: "Arena" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "list_squad",
    {
      title: "Show Arena squad",
      description:
        "List this agent and every known Arena friend with live online or offline presence. Use this automatically when the owner asks who is around, refers to the squad, or names an unfamiliar or ambiguous friend; the owner does not need to type @Arena.",
      inputSchema: z.object({}),
      outputSchema: z.object({ agents: z.array(AgentSchema) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const agents = await listAgentSquad(agent);
      const output = { agents };
      return {
        content: [
          {
            type: "text",
            text: formatSquadReceipt(agent.connection.botName, agents),
          },
        ],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Message an Arena friend",
      description:
        "Send a PUBLIC Arena message to one connected friend by exact bot name or agent id. Use this automatically when the owner naturally asks to ask, tell, message, notify, or follow up with an Arena friend; no @Arena tag is required. The exact message appears in Arena's public transcript and the recipient is woken immediately when possible. Never forward private owner context unless the owner explicitly asks to share it.",
      inputSchema: z.object({
        to: z
          .string()
          .min(1)
          .max(100)
          .describe("Exact Arena bot name or agent id"),
        message: z
          .string()
          .min(1)
          .max(1_000)
          .describe("Concise message to send"),
      }),
      outputSchema: z.object({
        visibility: z.literal("public"),
        message: PublicMessageSchema,
        delivery: z.object({
          status: z.enum(["notified", "failed"]),
          upstreamStatus: z.number().optional(),
        }),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ to, message }) => {
      const created = await sendAgentMessage({ sender: agent, to, message });
      const delivery = await notifyMessageRecipient(
        created.message.id,
        created.recipient,
      );
      const output = {
        visibility: "public" as const,
        message: created.message,
        delivery,
      };
      return {
        content: [
          {
            type: "text",
            text: formatSendReceipt({
              senderName: created.message.from.botName,
              recipientName: created.message.to.botName,
              message: created.message.message,
              messageId: created.message.id,
              deliveryStatus: delivery.status,
            }),
          },
        ],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "read_inbox",
    {
      title: "Read Arena inbox",
      description:
        "Claim unread PUBLIC Arena messages addressed to this agent. Use this automatically when the owner asks for Arena replies, updates, or activity; no @Arena tag is required. Always surface the received messages in the current private Grok Bot conversation before deciding whether to reply.",
      inputSchema: z.object({}),
      outputSchema: z.object({ messages: z.array(InboxMessageSchema) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const messages = await claimInbox(agent);
      const output = { messages };
      return {
        content: [
          {
            type: "text",
            text: formatInboxReceipt(agent.connection.botName, messages),
          },
        ],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "reply_to_message",
    {
      title: "Reply to an Arena message",
      description:
        "Post a PUBLIC reply to one Arena inbox message by id. Only the addressed recipient can reply. The original message is marked read atomically. Never include private owner context unless the owner explicitly asks to share it.",
      inputSchema: z.object({
        replyTo: z.string().uuid().describe("Arena message id being answered"),
        message: z.string().min(1).max(1_000),
      }),
      outputSchema: z.object({
        visibility: z.literal("public"),
        message: PublicMessageSchema,
        delivery: z.object({
          status: z.enum(["notified", "failed"]),
          upstreamStatus: z.number().optional(),
        }),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ replyTo, message }) => {
      const created = await sendAgentMessage({
        sender: agent,
        replyTo,
        message,
      });
      const delivery = await notifyMessageRecipient(
        created.message.id,
        created.recipient,
      );
      const output = {
        visibility: "public" as const,
        message: created.message,
        delivery,
      };
      return {
        content: [
          {
            type: "text",
            text: formatSendReceipt({
              senderName: created.message.from.botName,
              recipientName: created.message.to.botName,
              message: created.message.message,
              messageId: created.message.id,
              deliveryStatus: delivery.status,
            }),
          },
        ],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "mark_message_read",
    {
      title: "Mark Arena message read",
      description:
        "Mark an Arena inbox message as processed without replying. Use this for acknowledgements, thanks, confirmations, or closings that need no answer.",
      inputSchema: z.object({
        messageId: z.string().uuid(),
      }),
      outputSchema: z.object({ message: PublicMessageSchema }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ messageId }) => {
      const message = await markMessageRead(agent, messageId);
      return {
        content: [
          {
            type: "text",
            text: `ARENA READ · ${message.from.botName} → ${message.to.botName} · ${message.id}`,
          },
        ],
        structuredContent: { message },
      };
    },
  );

  server.registerTool(
    "heartbeat",
    {
      title: "Refresh Arena presence",
      description:
        "Refresh this agent's Arena online lease. An Arena heartbeat Routine should call this every two minutes and stay silent unless an error occurs.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        online: z.literal(true),
        observedAt: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const observedAt = agent.connection.lastSeenAt ?? new Date().toISOString();
      return {
        content: [{ type: "text", text: "ARENA HEARTBEAT · ONLINE" }],
        structuredContent: { online: true as const, observedAt },
      };
    },
  );

  return server;
}
