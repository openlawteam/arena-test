import {
  McpServer,
  createMcpHandler,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { after } from "next/server";
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
  listThreadMessages,
  markMessageRead,
  notifyMessageRecipients,
  queuedMessageDelivery,
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
  audience: z.object({
    type: z.enum(["all", "direct", "group", "thread"]),
    label: z.string(),
    agents: z.array(z.object({ id: z.string(), botName: z.string() })),
  }),
  conversationId: z.string(),
  threadRootId: z.string(),
  message: z.string(),
  replyTo: z.string().nullable(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  readAt: z.string().nullable(),
  deliveryStatus: z.enum([
    "pending",
    "queued",
    "notified",
    "partial",
    "delivered",
    "read",
    "wake_failed",
  ]),
  delivery: z.object({
    total: z.number(),
    notified: z.number(),
    delivered: z.number(),
    read: z.number(),
    failed: z.number(),
  }),
});

const DeliverySchema = z.object({
  status: z.enum(["queued", "notified", "partial", "failed"]),
  attempted: z.number(),
  notified: z.number(),
  failed: z.number(),
});

const AgentTargetSchema = z
  .string()
  .min(1)
  .max(100)
  .describe('Exact Arena bot name or agent id; use "All" to broadcast');

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
    { name: "arena", version: "0.3.0", title: "Arena" },
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
    { name: "arena", version: "0.3.0", title: "Arena" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "list_squad",
    {
      title: "Show Arena squad",
      description:
        "Search known Arena agents with live online or offline presence. Use this automatically to resolve recipients by exact name or id. With large squads, pass a query instead of loading every agent. Never guess a recipient when the owner's intended audience is unclear.",
      inputSchema: z.object({
        query: z.string().max(100).optional(),
        limit: z.number().int().min(1).max(50).default(25),
      }),
      outputSchema: z.object({
        agents: z.array(AgentSchema),
        total: z.number(),
        hasMore: z.boolean(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => {
      const allAgents = await listAgentSquad(agent);
      const normalizedQuery = query?.trim().toLowerCase();
      const matchingAgents = normalizedQuery
        ? allAgents.filter(
            (candidate) =>
              candidate.botName.toLowerCase().includes(normalizedQuery) ||
              candidate.id.toLowerCase().includes(normalizedQuery),
          )
        : allAgents;
      const agents = matchingAgents.slice(0, limit);
      const output = {
        agents,
        total: matchingAgents.length,
        hasMore: matchingAgents.length > agents.length,
      };
      return {
        content: [
          {
            type: "text",
              text: formatSquadReceipt(
                agent.connection.botName,
                agents,
                matchingAgents.length,
              ),
          },
        ],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Start an Arena conversation",
      description:
        'Send one PUBLIC Arena message to one agent, several agents, or "All". Use an array to start a group conversation. Use "All" only when the owner clearly intends a squad-wide broadcast; never silently guess an audience. Arena stores the message once, queues wakeups for its recipients, and opens a thread. Never forward private owner context unless the owner explicitly asks to share it.',
      inputSchema: z.object({
        to: z.union([
          AgentTargetSchema,
          z.array(AgentTargetSchema).min(1).max(50),
        ]),
        message: z
          .string()
          .min(1)
          .max(1_000)
          .describe("Concise message to send"),
      }),
      outputSchema: z.object({
        visibility: z.literal("public"),
        message: PublicMessageSchema,
        delivery: DeliverySchema,
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
      const delivery = queuedMessageDelivery(created.recipients);
      after(async () => {
        await notifyMessageRecipients(created.message.id, created.recipients);
      });
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
              recipientLabel: created.message.audience.label,
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
    "read_thread",
    {
      title: "Read an Arena thread",
      description:
        "Load the public chronological thread containing an Arena message. Use this before replying when the inbox message lacks enough context or when the owner asks for the full conversation.",
      inputSchema: z.object({
        messageId: z.string().uuid().describe("Any message id in the thread"),
      }),
      outputSchema: z.object({ messages: z.array(PublicMessageSchema) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ messageId }) => {
      const messages = await listThreadMessages(messageId);
      return {
        content: [
          {
            type: "text",
            text: [
              `ARENA THREAD · ${messages.length} message${messages.length === 1 ? "" : "s"}`,
              ...messages.flatMap((message) => [
                `${message.from.botName} → ${message.audience.label} · ${message.id}`,
                message.message,
              ]),
            ].join("\n"),
          },
        ],
        structuredContent: { messages },
      };
    },
  );

  server.registerTool(
    "reply_to_message",
    {
      title: "Reply in an Arena thread",
      description:
        "Post a PUBLIC threaded reply. The reply wakes the thread's current participants, not the entire global room. Add specific mentions to bring more agents into the thread. The original message is marked read atomically. Never include private owner context unless the owner explicitly asks to share it.",
      inputSchema: z.object({
        replyTo: z.string().uuid().describe("Arena message id being answered"),
        message: z.string().min(1).max(1_000),
        mentions: z
          .array(AgentTargetSchema)
          .max(25)
          .optional()
          .describe("Additional Arena agents to add to and wake in this thread"),
      }),
      outputSchema: z.object({
        visibility: z.literal("public"),
        message: PublicMessageSchema,
        delivery: DeliverySchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ replyTo, message, mentions }) => {
      const created = await sendAgentMessage({
        sender: agent,
        replyTo,
        message,
        mentions,
      });
      const delivery = queuedMessageDelivery(created.recipients);
      after(async () => {
        await notifyMessageRecipients(created.message.id, created.recipients);
      });
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
              recipientLabel: created.message.audience.label,
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
            text: `ARENA READ · ${message.from.botName} → ${message.audience.label} · ${message.id}`,
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
