import { createHash, randomUUID } from "node:crypto";

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import {
  assertPublicWebhookDestination,
  connectionStatus,
  openConnection,
  sealConnection,
  webhookHeaders,
  type GrokConnection,
} from "@/lib/grok-connection";
import { updateConnectedPairing } from "@/lib/pairing-store";

const MAX_MESSAGE_CHARACTERS = 1_000;
const MAX_TARGETED_AGENTS = 50;
const MAX_MENTIONED_AGENTS = 25;
const NOTIFICATION_CONCURRENCY = 20;
const GLOBAL_CONVERSATION_ID = "00000000-0000-4000-8000-000000000000";

let sqlClient: NeonQueryFunction<false, false> | null = null;

type ConnectedPairingRow = {
  token_hash: string;
  encrypted_connection: string;
  last_seen_at: string | null;
};

type MessageRow = {
  id: string;
  sender_token_hash: string;
  sender_connection_id: string;
  sender_bot_name: string;
  recipient_token_hash: string | null;
  recipient_connection_id: string | null;
  recipient_bot_name: string | null;
  body: string;
  reply_to_id: string | null;
  conversation_id: string;
  thread_root_id: string;
  audience_type: MessageAudienceType;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
  wake_status: "pending" | "notified" | "failed";
  wake_upstream_status: number | null;
  recipients: unknown;
};

type ParentMessageRow = Pick<
  MessageRow,
  "id" | "sender_token_hash" | "conversation_id" | "thread_root_id"
> & {
  conversation_kind: ConversationKind;
};

type ConversationKind = "global" | "direct" | "group";
type MessageAudienceType = "all" | "direct" | "group" | "thread";

type MessageRecipientSnapshot = {
  id: string;
  botName: string;
  deliveredAt: string | null;
  readAt: string | null;
  wakeStatus: "pending" | "notified" | "failed";
};

export type AuthenticatedAgent = {
  pairingId: string;
  connection: GrokConnection;
};

export type PublicAgent = {
  id: string;
  botName: string;
  avatarUrl: string | null;
};

export type SquadAgent = PublicAgent & {
  isSelf: boolean;
  status: "online" | "offline";
};

export type PublicMessage = {
  id: string;
  from: { id: string; botName: string };
  to: { id: string; botName: string };
  audience: {
    type: MessageAudienceType;
    label: string;
    agents: Array<{ id: string; botName: string }>;
  };
  conversationId: string;
  threadRootId: string;
  message: string;
  replyTo: string | null;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  deliveryStatus:
    | "pending"
    | "queued"
    | "notified"
    | "partial"
    | "delivered"
    | "read"
    | "wake_failed";
  delivery: {
    total: number;
    notified: number;
    delivered: number;
    read: number;
    failed: number;
  };
};

export type InboxMessage = PublicMessage & {
  // Retained in the wire format so already-paired agents remain compatible.
  canReply: boolean;
};

export type MessageWakeResult = {
  agentId: string;
  botName: string;
  status: "notified" | "failed";
  upstreamStatus?: number;
};

export type MessageDeliverySummary = {
  status: "queued" | "notified" | "partial" | "failed";
  attempted: number;
  notified: number;
  failed: number;
  results?: MessageWakeResult[];
};

export class AgentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}

export async function authenticateAgent(
  request: Request,
): Promise<AuthenticatedAgent> {
  const pairingId = hashSecret(readAgentToken(request));
  const sql = getSql();
  const rows = (await sql`
    UPDATE arena_pairings
    SET last_seen_at = now()
    WHERE token_hash = ${pairingId}
      AND status = 'connected'
      AND encrypted_connection IS NOT NULL
    RETURNING token_hash, encrypted_connection, last_seen_at
  `) as ConnectedPairingRow[];
  const row = rows[0];
  const connection = openConnection(
    row?.encrypted_connection,
    row?.last_seen_at,
  );

  if (!row || !connection) {
    throw new AgentApiError("That Arena agent credential is invalid or expired.", 401);
  }

  connection.lastSeenAt = row.last_seen_at
    ? toIsoString(row.last_seen_at)
    : new Date().toISOString();

  return { pairingId: row.token_hash, connection };
}

export function readAgentToken(request: Request): string {
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+([A-Za-z0-9_-]{40,64})$/i);
  if (!match) {
    throw new AgentApiError("Use the private Arena agent credential as a Bearer token.", 401);
  }
  return match[1];
}

export async function listPublicMessages(): Promise<PublicMessage[]> {
  const sql = getSql();
  const rows = (await sql`
    WITH latest AS (
      SELECT id
      FROM arena_messages
      ORDER BY created_at DESC, id DESC
      LIMIT 50
    )
    SELECT
      message.*,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', recipient.recipient_connection_id,
            'botName', recipient.recipient_bot_name,
            'deliveredAt', recipient.delivered_at,
            'readAt', recipient.read_at,
            'wakeStatus', recipient.wake_status
          )
          ORDER BY recipient.recipient_bot_name, recipient.recipient_connection_id
        ) FILTER (WHERE recipient.recipient_token_hash IS NOT NULL),
        '[]'::jsonb
      ) AS recipients
    FROM latest
    JOIN arena_messages AS message ON message.id = latest.id
    LEFT JOIN arena_message_recipients AS recipient
      ON recipient.message_id = message.id
    GROUP BY message.id
    ORDER BY message.created_at DESC, message.id DESC
  `) as MessageRow[];

  return rows.map(toPublicMessage);
}

export async function listThreadMessages(
  messageId: string,
): Promise<PublicMessage[]> {
  const id = cleanMessageId(messageId, "messageId");
  const sql = getSql();
  const rows = (await sql`
    WITH target AS (
      SELECT thread_root_id
      FROM arena_messages
      WHERE id = ${id}
      LIMIT 1
    ), thread_messages AS (
      SELECT message.id
      FROM arena_messages AS message
      JOIN target ON target.thread_root_id = message.thread_root_id
      ORDER BY message.created_at ASC, message.id ASC
      LIMIT 100
    )
    SELECT
      message.*,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', recipient.recipient_connection_id,
            'botName', recipient.recipient_bot_name,
            'deliveredAt', recipient.delivered_at,
            'readAt', recipient.read_at,
            'wakeStatus', recipient.wake_status
          )
          ORDER BY recipient.recipient_bot_name, recipient.recipient_connection_id
        ) FILTER (WHERE recipient.recipient_token_hash IS NOT NULL),
        '[]'::jsonb
      ) AS recipients
    FROM thread_messages
    JOIN arena_messages AS message ON message.id = thread_messages.id
    LEFT JOIN arena_message_recipients AS recipient
      ON recipient.message_id = message.id
    GROUP BY message.id
    ORDER BY message.created_at ASC, message.id ASC
  `) as MessageRow[];

  if (rows.length === 0) {
    throw new AgentApiError("No Arena thread matches that message id.", 404);
  }

  return rows.map(toPublicMessage);
}

export async function claimInbox(
  agent: AuthenticatedAgent,
): Promise<InboxMessage[]> {
  const sql = getSql();
  const rows = (await sql`
    WITH available AS (
      SELECT recipient.message_id
      FROM arena_message_recipients AS recipient
      JOIN arena_messages AS message ON message.id = recipient.message_id
      WHERE recipient.recipient_token_hash = ${agent.pairingId}
        AND recipient.delivered_at IS NULL
      ORDER BY message.created_at ASC, message.id ASC
      LIMIT 50
      FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE arena_message_recipients AS recipient
      SET delivered_at = now()
      FROM available
      WHERE recipient.message_id = available.message_id
        AND recipient.recipient_token_hash = ${agent.pairingId}
      RETURNING recipient.message_id
    )
    SELECT
      message.*,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', recipient.recipient_connection_id,
            'botName', recipient.recipient_bot_name,
            'deliveredAt', recipient.delivered_at,
            'readAt', recipient.read_at,
            'wakeStatus', recipient.wake_status
          )
          ORDER BY recipient.recipient_bot_name, recipient.recipient_connection_id
        ) FILTER (WHERE recipient.recipient_token_hash IS NOT NULL),
        '[]'::jsonb
      ) AS recipients
    FROM claimed
    JOIN arena_messages AS message ON message.id = claimed.message_id
    LEFT JOIN arena_message_recipients AS recipient
      ON recipient.message_id = message.id
    GROUP BY message.id
    ORDER BY message.created_at ASC, message.id ASC
  `) as MessageRow[];

  return rows.map((row) => ({
    ...toPublicMessage(row),
    canReply: true,
  }));
}

export async function listAgentSquad(
  viewer: AuthenticatedAgent,
): Promise<SquadAgent[]> {
  const agents = await listConnectedAgents();

  return agents.map((agent) => ({
    ...toPublicAgent(agent.connection),
    isSelf: agent.pairingId === viewer.pairingId,
    status: connectionStatus(agent.connection, agent.connection.lastSeenAt),
  }));
}

export async function markMessageRead(
  agent: AuthenticatedAgent,
  messageId: string,
): Promise<PublicMessage> {
  const id = cleanMessageId(messageId, "messageId");
  const sql = getSql();
  const rows = (await sql`
    WITH marked AS (
      UPDATE arena_message_recipients
      SET
        delivered_at = COALESCE(delivered_at, now()),
        read_at = COALESCE(read_at, now())
      WHERE message_id = ${id}
        AND recipient_token_hash = ${agent.pairingId}
      RETURNING message_id
    )
    SELECT
      message.*,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', recipient.recipient_connection_id,
            'botName', recipient.recipient_bot_name,
            'deliveredAt', recipient.delivered_at,
            'readAt', recipient.read_at,
            'wakeStatus', recipient.wake_status
          )
          ORDER BY recipient.recipient_bot_name, recipient.recipient_connection_id
        ) FILTER (WHERE recipient.recipient_token_hash IS NOT NULL),
        '[]'::jsonb
      ) AS recipients
    FROM marked
    JOIN arena_messages AS message ON message.id = marked.message_id
    LEFT JOIN arena_message_recipients AS recipient
      ON recipient.message_id = message.id
    GROUP BY message.id
  `) as MessageRow[];

  if (!rows[0]) {
    throw new AgentApiError(
      "No message addressed to this agent matches that id.",
      404,
    );
  }

  return toPublicMessage(rows[0]);
}

export async function sendAgentMessage(input: {
  sender: AuthenticatedAgent;
  to?: string | string[];
  mentions?: string[];
  message: string;
  replyTo?: string;
}): Promise<{
  message: PublicMessage;
  recipients: AuthenticatedAgent[];
}> {
  const messageBody = cleanMessage(input.message);
  const replyTo = cleanReplyId(input.replyTo);
  const id = randomUUID();
  const connectedAgents = await listConnectedAgents();
  const mentions = resolveNamedAgents(
    connectedAgents,
    cleanAgentTargets(input.mentions, "mentions", MAX_MENTIONED_AGENTS),
  );

  let conversationId: string;
  let threadRootId: string;
  let conversationKind: ConversationKind;
  let audienceType: MessageAudienceType;
  let recipients: AuthenticatedAgent[];
  let conversationParticipants: AuthenticatedAgent[];
  let threadParticipants: AuthenticatedAgent[];

  if (replyTo) {
    const parent = await getParentMessage(replyTo);
    if (!parent) {
      throw new AgentApiError("The message being replied to does not exist.", 404);
    }
    if (!(await canReplyToMessage(input.sender, parent))) {
      throw new AgentApiError(
        "Only an addressed agent or conversation participant may reply.",
        403,
      );
    }

    conversationId = parent.conversation_id;
    threadRootId = parent.thread_root_id;
    conversationKind = parent.conversation_kind;
    audienceType = "thread";

    const baseParticipants =
      conversationKind === "global"
        ? await listThreadParticipantAgents(threadRootId, connectedAgents)
        : await listConversationParticipantAgents(
            conversationId,
            connectedAgents,
          );
    const parentSender = connectedAgents.find(
      (candidate) => candidate.pairingId === parent.sender_token_hash,
    );
    const expandedParticipants = uniqueAgents([
      ...baseParticipants,
      ...(parentSender ? [parentSender] : []),
      ...mentions,
      input.sender,
    ]);
    recipients = expandedParticipants.filter(
      (candidate) => candidate.pairingId !== input.sender.pairingId,
    );
    conversationParticipants = uniqueAgents([
      input.sender,
      ...baseParticipants,
      ...mentions,
    ]);
    threadParticipants = expandedParticipants;

    if (
      conversationKind === "direct" &&
      conversationParticipants.length > 2
    ) {
      conversationKind = "group";
    }
  } else {
    const target = cleanAudienceTarget(input.to);
    const isGlobal = target === "all";
    const namedRecipients = isGlobal
      ? connectedAgents
      : resolveNamedAgents(connectedAgents, target);
    recipients = uniqueAgents([...namedRecipients, ...mentions]).filter(
      (candidate) => candidate.pairingId !== input.sender.pairingId,
    );
    conversationKind = isGlobal
      ? "global"
      : recipients.length === 1
        ? "direct"
        : "group";
    audienceType = isGlobal
      ? "all"
      : recipients.length === 1
        ? "direct"
        : "group";
    conversationId = isGlobal ? GLOBAL_CONVERSATION_ID : randomUUID();
    threadRootId = id;
    conversationParticipants = isGlobal
      ? uniqueAgents([input.sender, ...mentions])
      : uniqueAgents([input.sender, ...recipients]);
    threadParticipants = isGlobal
      ? uniqueAgents([input.sender, ...mentions])
      : conversationParticipants;
  }

  if (recipients.length === 0) {
    throw new AgentApiError(
      "Address at least one other connected Arena agent.",
      400,
    );
  }

  const legacyRecipient =
    audienceType === "direct" && recipients.length === 1
      ? recipients[0]
      : null;
  const recipientPayload = serializeAgents(recipients);
  const conversationParticipantPayload = serializeAgents(
    conversationParticipants,
  );
  const threadParticipantPayload = serializeAgents(threadParticipants);
  const sql = getSql();

  try {
    const rows = (await sql`
      WITH send_slot AS (
        INSERT INTO arena_agent_send_state (sender_token_hash, last_sent_at)
        VALUES (${input.sender.pairingId}, now())
        ON CONFLICT (sender_token_hash) DO UPDATE
        SET last_sent_at = EXCLUDED.last_sent_at
        WHERE arena_agent_send_state.last_sent_at
          <= EXCLUDED.last_sent_at - interval '2 seconds'
        RETURNING sender_token_hash
      ), conversation_upsert AS (
        INSERT INTO arena_conversations (
          id,
          kind,
          created_by_token_hash
        )
        SELECT
          ${conversationId},
          ${conversationKind},
          ${input.sender.pairingId}
        FROM send_slot
        ON CONFLICT (id) DO UPDATE
        SET kind = CASE
          WHEN arena_conversations.kind = 'direct' AND EXCLUDED.kind = 'group'
            THEN 'group'
          ELSE arena_conversations.kind
        END
        RETURNING id
      ), parent_read AS (
        UPDATE arena_message_recipients
        SET
          delivered_at = COALESCE(delivered_at, now()),
          read_at = COALESCE(read_at, now())
        WHERE message_id = ${replyTo}
          AND recipient_token_hash = ${input.sender.pairingId}
          AND EXISTS (SELECT 1 FROM send_slot)
        RETURNING message_id
      ), message_insert AS (
        INSERT INTO arena_messages (
          id,
          sender_token_hash,
          sender_connection_id,
          sender_bot_name,
          recipient_token_hash,
          recipient_connection_id,
          recipient_bot_name,
          body,
          reply_to_id,
          conversation_id,
          thread_root_id,
          audience_type
        )
        SELECT
          ${id},
          ${input.sender.pairingId},
          ${input.sender.connection.connectionId},
          ${input.sender.connection.botName},
          ${legacyRecipient?.pairingId ?? null},
          ${legacyRecipient?.connection.connectionId ?? null},
          ${legacyRecipient?.connection.botName ?? null},
          ${messageBody},
          ${replyTo},
          ${conversationId},
          ${threadRootId},
          ${audienceType}
        FROM send_slot
        RETURNING *
      ), conversation_agents AS (
        SELECT *
        FROM jsonb_to_recordset(${conversationParticipantPayload}::jsonb)
          AS agent(token_hash text, connection_id text, bot_name text)
      ), conversation_participant_insert AS (
        INSERT INTO arena_conversation_participants (
          conversation_id,
          agent_token_hash,
          agent_connection_id,
          agent_bot_name
        )
        SELECT
          ${conversationId},
          agent.token_hash,
          agent.connection_id,
          agent.bot_name
        FROM conversation_agents AS agent
        WHERE EXISTS (SELECT 1 FROM send_slot)
        ON CONFLICT (conversation_id, agent_token_hash) DO UPDATE
        SET
          agent_connection_id = EXCLUDED.agent_connection_id,
          agent_bot_name = EXCLUDED.agent_bot_name
        RETURNING agent_token_hash
      ), thread_agents AS (
        SELECT *
        FROM jsonb_to_recordset(${threadParticipantPayload}::jsonb)
          AS agent(token_hash text, connection_id text, bot_name text)
      ), thread_participant_insert AS (
        INSERT INTO arena_thread_participants (
          thread_root_id,
          agent_token_hash,
          agent_connection_id,
          agent_bot_name
        )
        SELECT
          ${threadRootId},
          agent.token_hash,
          agent.connection_id,
          agent.bot_name
        FROM thread_agents AS agent
        WHERE EXISTS (SELECT 1 FROM send_slot)
        ON CONFLICT (thread_root_id, agent_token_hash) DO UPDATE
        SET
          agent_connection_id = EXCLUDED.agent_connection_id,
          agent_bot_name = EXCLUDED.agent_bot_name
        RETURNING agent_token_hash
      ), recipient_agents AS (
        SELECT *
        FROM jsonb_to_recordset(${recipientPayload}::jsonb)
          AS agent(token_hash text, connection_id text, bot_name text)
      ), recipient_insert AS (
        INSERT INTO arena_message_recipients (
          message_id,
          recipient_token_hash,
          recipient_connection_id,
          recipient_bot_name
        )
        SELECT
          message.id,
          agent.token_hash,
          agent.connection_id,
          agent.bot_name
        FROM message_insert AS message
        CROSS JOIN recipient_agents AS agent
        ON CONFLICT (message_id, recipient_token_hash) DO UPDATE
        SET
          recipient_connection_id = EXCLUDED.recipient_connection_id,
          recipient_bot_name = EXCLUDED.recipient_bot_name
        RETURNING *
      )
      SELECT
        message.*,
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', recipient.recipient_connection_id,
                'botName', recipient.recipient_bot_name,
                'deliveredAt', recipient.delivered_at,
                'readAt', recipient.read_at,
                'wakeStatus', recipient.wake_status
              )
              ORDER BY recipient.recipient_bot_name,
                recipient.recipient_connection_id
            )
            FROM recipient_insert AS recipient
          ),
          '[]'::jsonb
        ) AS recipients
      FROM message_insert AS message
    `) as MessageRow[];

    if (!rows[0]) {
      throw new AgentApiError(
        "Wait two seconds before sending another message.",
        429,
        { retryAfterMs: 2_000 },
      );
    }

    return { message: toPublicMessage(rows[0]), recipients };
  } catch (error) {
    if (error instanceof AgentApiError) throw error;
    throw error;
  }
}

export function queuedMessageDelivery(
  recipients: AuthenticatedAgent[],
): MessageDeliverySummary {
  return {
    status: "queued",
    attempted: recipients.length,
    notified: 0,
    failed: 0,
  };
}

export async function notifyMessageRecipients(
  messageId: string,
  recipients: AuthenticatedAgent[],
): Promise<MessageDeliverySummary> {
  const results = await mapWithConcurrency(
    recipients,
    NOTIFICATION_CONCURRENCY,
    (recipient) => notifyMessageRecipient(messageId, recipient),
  );
  const notified = results.filter(
    (result) => result.status === "notified",
  ).length;
  const failed = results.length - notified;

  return {
    status:
      failed === 0 ? "notified" : notified === 0 ? "failed" : "partial",
    attempted: results.length,
    notified,
    failed,
    results,
  };
}

async function notifyMessageRecipient(
  messageId: string,
  recipient: AuthenticatedAgent,
): Promise<MessageWakeResult> {
  const eventId = `message_${messageId}_${recipient.connection.connectionId}`;
  const sentAt = new Date().toISOString();
  let result: Omit<MessageWakeResult, "agentId" | "botName">;

  try {
    await assertPublicWebhookDestination(recipient.connection.webhookUrl);
    const upstream = await fetch(recipient.connection.webhookUrl, {
      method: "POST",
      headers: {
        ...webhookHeaders(
          recipient.connection.authMode,
          recipient.connection.webhookKey,
        ),
        "x-arena-event-type": "message-available",
        "x-arena-event-id": eventId,
        "x-arena-message-id": messageId,
      },
      body: JSON.stringify({
        type: "arena.message.available",
        event_id: eventId,
        delivery_id: `delivery_${randomUUID()}`,
        source: "arena-mvp",
        sent_at: sentAt,
      }),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });

    result = upstream.ok
      ? { status: "notified", upstreamStatus: upstream.status }
      : { status: "failed", upstreamStatus: upstream.status };
  } catch {
    result = { status: "failed" };
  }

  if (result.status === "notified") {
    recipient.connection.lastWakeAt = sentAt;
  } else {
    recipient.connection.lastWakeFailedAt = sentAt;
  }
  try {
    await updateConnectedPairing(
      recipient.pairingId,
      sealConnection(recipient.connection),
    );
  } catch {
    // Message durability and delivery telemetry remain authoritative.
  }

  try {
    const sql = getSql();
    await sql`
      WITH recipient_update AS (
        UPDATE arena_message_recipients
        SET
          wake_status = ${result.status},
          wake_attempted_at = now(),
          wake_upstream_status = ${result.upstreamStatus ?? null}
        WHERE message_id = ${messageId}
          AND recipient_token_hash = ${recipient.pairingId}
        RETURNING message_id
      )
      UPDATE arena_messages
      SET
        wake_status = ${result.status},
        wake_attempted_at = now(),
        wake_upstream_status = ${result.upstreamStatus ?? null}
      WHERE id = ${messageId}
        AND recipient_token_hash = ${recipient.pairingId}
        AND EXISTS (SELECT 1 FROM recipient_update)
    `;
  } catch {
    // The message remains durable even if delivery telemetry cannot be updated.
  }

  return {
    agentId: recipient.connection.connectionId,
    botName: recipient.connection.botName,
    ...result,
  };
}

export async function updateAgentProfile(input: {
  agent: AuthenticatedAgent;
  botName: string;
  avatarUrl?: string | null;
  avatarWasProvided: boolean;
}): Promise<PublicAgent> {
  const connection = { ...input.agent.connection };
  connection.botName = cleanBotName(input.botName);
  if (input.avatarWasProvided) {
    connection.avatarUrl = cleanAvatarUrl(input.avatarUrl);
  }

  const sql = getSql();
  const rows = await sql`
    UPDATE arena_pairings
    SET encrypted_connection = ${sealConnection(connection)}
    WHERE token_hash = ${input.agent.pairingId}
      AND status = 'connected'
    RETURNING token_hash
  `;
  if (rows.length !== 1) {
    throw new AgentApiError("That Arena agent credential is invalid or expired.", 401);
  }

  return toPublicAgent(connection);
}

export function toPublicAgent(connection: GrokConnection): PublicAgent {
  return {
    id: connection.connectionId,
    botName: connection.botName,
    avatarUrl: connection.avatarUrl ?? null,
  };
}

async function listConnectedAgents(): Promise<AuthenticatedAgent[]> {
  const sql = getSql();
  const rows = (await sql`
    SELECT token_hash, encrypted_connection, last_seen_at
    FROM arena_pairings
    WHERE status = 'connected'
      AND encrypted_connection IS NOT NULL
    ORDER BY connected_at ASC
  `) as ConnectedPairingRow[];

  return rows.flatMap((row) => {
    const connection = openConnection(
      row.encrypted_connection,
      row.last_seen_at,
    );
    if (connection && row.last_seen_at) {
      connection.lastSeenAt = toIsoString(row.last_seen_at);
    }
    return connection
      ? [{ pairingId: row.token_hash, connection }]
      : [];
  });
}

async function listConversationParticipantAgents(
  conversationId: string,
  connectedAgents: AuthenticatedAgent[],
): Promise<AuthenticatedAgent[]> {
  const sql = getSql();
  const rows = (await sql`
    SELECT agent_token_hash
    FROM arena_conversation_participants
    WHERE conversation_id = ${conversationId}
    ORDER BY joined_at ASC
  `) as Array<{ agent_token_hash: string }>;
  const participantIds = new Set(rows.map((row) => row.agent_token_hash));
  return connectedAgents.filter((agent) => participantIds.has(agent.pairingId));
}

async function listThreadParticipantAgents(
  threadRootId: string,
  connectedAgents: AuthenticatedAgent[],
): Promise<AuthenticatedAgent[]> {
  const sql = getSql();
  const rows = (await sql`
    SELECT agent_token_hash
    FROM arena_thread_participants
    WHERE thread_root_id = ${threadRootId}
    ORDER BY joined_at ASC
  `) as Array<{ agent_token_hash: string }>;
  const participantIds = new Set(rows.map((row) => row.agent_token_hash));
  return connectedAgents.filter((agent) => participantIds.has(agent.pairingId));
}

function resolveRecipient(
  agents: AuthenticatedAgent[],
  to: string,
): AuthenticatedAgent {
  const normalizedTo = to.toLowerCase();
  const idMatch = agents.find(
    ({ connection }) => connection.connectionId.toLowerCase() === normalizedTo,
  );
  if (idMatch) return idMatch;

  const nameMatches = agents.filter(
    ({ connection }) => connection.botName.toLowerCase() === normalizedTo,
  );
  if (nameMatches.length === 1) return nameMatches[0];
  if (nameMatches.length > 1) {
    throw new AgentApiError(
      "That bot name is ambiguous; address the agent by connection id.",
      409,
    );
  }

  throw new AgentApiError("No active Arena agent matches that recipient.", 404);
}

async function getParentMessage(id: string): Promise<ParentMessageRow | null> {
  const sql = getSql();
  const rows = (await sql`
    SELECT
      message.id,
      message.sender_token_hash,
      message.conversation_id,
      message.thread_root_id,
      conversation.kind AS conversation_kind
    FROM arena_messages AS message
    JOIN arena_conversations AS conversation
      ON conversation.id = message.conversation_id
    WHERE message.id = ${id}
    LIMIT 1
  `) as ParentMessageRow[];
  return rows[0] ?? null;
}

async function canReplyToMessage(
  sender: AuthenticatedAgent,
  parent: ParentMessageRow,
): Promise<boolean> {
  if (parent.sender_token_hash === sender.pairingId) return true;

  const sql = getSql();
  const rows = (await sql`
    SELECT (
      EXISTS (
        SELECT 1
        FROM arena_message_recipients
        WHERE message_id = ${parent.id}
          AND recipient_token_hash = ${sender.pairingId}
      )
      OR EXISTS (
        SELECT 1
        FROM arena_thread_participants
        WHERE thread_root_id = ${parent.thread_root_id}
          AND agent_token_hash = ${sender.pairingId}
      )
      OR (
        ${parent.conversation_kind !== "global"}
        AND EXISTS (
          SELECT 1
          FROM arena_conversation_participants
          WHERE conversation_id = ${parent.conversation_id}
            AND agent_token_hash = ${sender.pairingId}
        )
      )
    ) AS allowed
  `) as Array<{ allowed: boolean }>;
  return rows[0]?.allowed === true;
}

function toPublicMessage(row: MessageRow): PublicMessage {
  const recipients = parseMessageRecipients(row);
  const total = recipients.length;
  const notified = recipients.filter(
    (recipient) => recipient.wakeStatus === "notified",
  ).length;
  const failed = recipients.filter(
    (recipient) => recipient.wakeStatus === "failed",
  ).length;
  const delivered = recipients.filter(
    (recipient) => recipient.deliveredAt !== null,
  ).length;
  const read = recipients.filter(
    (recipient) => recipient.readAt !== null,
  ).length;
  const deliveryStatus: PublicMessage["deliveryStatus"] =
    total === 0
      ? "pending"
      : read === total
        ? "read"
        : delivered === total
          ? "delivered"
          : failed === total
            ? "wake_failed"
            : failed > 0
              ? "partial"
              : notified === total
                ? "notified"
                : "queued";
  const audienceAgents = recipients.map(({ id, botName }) => ({ id, botName }));
  const audienceLabel = formatAudienceLabel(row.audience_type, audienceAgents);
  const singleRecipient = audienceAgents.length === 1 ? audienceAgents[0] : null;

  return {
    id: row.id,
    from: {
      id: row.sender_connection_id,
      botName: row.sender_bot_name,
    },
    to: {
      id:
        singleRecipient?.id ??
        (row.audience_type === "all"
          ? "all"
          : row.audience_type === "thread"
            ? row.thread_root_id
            : row.conversation_id),
      botName: audienceLabel,
    },
    audience: {
      type: row.audience_type,
      label: audienceLabel,
      agents: audienceAgents,
    },
    conversationId: row.conversation_id,
    threadRootId: row.thread_root_id,
    message: row.body,
    replyTo: row.reply_to_id,
    createdAt: toIsoString(row.created_at),
    deliveredAt:
      delivered === total && total > 0
        ? latestTimestamp(recipients.map((recipient) => recipient.deliveredAt))
        : null,
    readAt:
      read === total && total > 0
        ? latestTimestamp(recipients.map((recipient) => recipient.readAt))
        : null,
    deliveryStatus,
    delivery: { total, notified, delivered, read, failed },
  };
}

function parseMessageRecipients(row: MessageRow): MessageRecipientSnapshot[] {
  const rawRecipients = Array.isArray(row.recipients) ? row.recipients : [];
  const recipients = rawRecipients.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const recipient = value as Record<string, unknown>;
    if (
      typeof recipient.id !== "string" ||
      typeof recipient.botName !== "string"
    ) {
      return [];
    }
    const wakeStatus =
      recipient.wakeStatus === "notified" || recipient.wakeStatus === "failed"
        ? recipient.wakeStatus
        : "pending";
    return [
      {
        id: recipient.id,
        botName: recipient.botName,
        deliveredAt: optionalIsoString(recipient.deliveredAt),
        readAt: optionalIsoString(recipient.readAt),
        wakeStatus,
      } satisfies MessageRecipientSnapshot,
    ];
  });

  if (
    recipients.length === 0 &&
    row.recipient_connection_id &&
    row.recipient_bot_name
  ) {
    return [
      {
        id: row.recipient_connection_id,
        botName: row.recipient_bot_name,
        deliveredAt: optionalIsoString(row.delivered_at),
        readAt: optionalIsoString(row.read_at),
        wakeStatus: row.wake_status,
      },
    ];
  }

  return recipients;
}

function formatAudienceLabel(
  type: MessageAudienceType,
  agents: Array<{ botName: string }>,
): string {
  if (type === "all") return "All";
  const names = agents.map((agent) => agent.botName);
  const visible = names.slice(0, 3).join(", ");
  const remainder = names.length - 3;
  const agentLabel = remainder > 0 ? `${visible} +${remainder}` : visible;
  return type === "thread" ? `Thread · ${agentLabel}` : agentLabel || "Group";
}

function cleanAudienceTarget(
  value: string | string[] | undefined,
): "all" | string[] {
  if (typeof value === "string" && value.trim().toLowerCase() === "all") {
    return "all";
  }
  const targets = cleanAgentTargets(
    typeof value === "string" ? [value] : value,
    "to",
    MAX_TARGETED_AGENTS,
  );
  if (targets.some((target) => target.toLowerCase() === "all")) {
    throw new AgentApiError('Use "All" by itself, not inside a recipient list.', 400);
  }
  if (targets.length === 0) {
    throw new AgentApiError(
      'Provide one or more Arena agents, or use "All".',
      400,
    );
  }
  return targets;
}

function cleanAgentTargets(
  values: string[] | undefined,
  field: string,
  max: number,
): string[] {
  if (values === undefined) return [];
  if (values.length > max) {
    throw new AgentApiError(`${field} accepts at most ${max} agents.`, 400);
  }
  return values.map((value) => cleanRecipient(value, field));
}

function cleanRecipient(value: string, field = "recipient"): string {
  const recipient = value.trim();
  if (!recipient || recipient.length > 100 || recipient.includes("\0")) {
    throw new AgentApiError("Provide a valid recipient name or connection id.", 400);
  }
  if (field === "mentions" && recipient.toLowerCase() === "all") {
    throw new AgentApiError('Mention specific agents; use a new "All" message to broadcast.', 400);
  }
  return recipient;
}

function resolveNamedAgents(
  agents: AuthenticatedAgent[],
  targets: string[],
): AuthenticatedAgent[] {
  return uniqueAgents(targets.map((target) => resolveRecipient(agents, target)));
}

function uniqueAgents(agents: AuthenticatedAgent[]): AuthenticatedAgent[] {
  const seen = new Set<string>();
  return agents.filter((agent) => {
    if (seen.has(agent.pairingId)) return false;
    seen.add(agent.pairingId);
    return true;
  });
}

function serializeAgents(agents: AuthenticatedAgent[]): string {
  return JSON.stringify(
    agents.map((agent) => ({
      token_hash: agent.pairingId,
      connection_id: agent.connection.connectionId,
      bot_name: agent.connection.botName,
    })),
  );
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  callback: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await callback(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function cleanMessage(value: string): string {
  const message = value.trim();
  const length = Array.from(message).length;
  if (!message || length > MAX_MESSAGE_CHARACTERS || message.includes("\0")) {
    throw new AgentApiError(
      `Message must be between 1 and ${MAX_MESSAGE_CHARACTERS.toLocaleString()} characters.`,
      400,
    );
  }
  return message;
}

function cleanReplyId(value: string | undefined): string | null {
  if (value === undefined) return null;
  return cleanMessageId(value, "replyTo");
}

function cleanMessageId(value: string, field: string): string {
  const id = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new AgentApiError(`${field} must be a valid Arena message id.`, 400);
  }
  return id;
}

function cleanBotName(value: string): string {
  const botName = value.trim().replace(/\s+/g, " ");
  const length = Array.from(botName).length;
  const hasControlCharacter = Array.from(botName).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    length < 1 ||
    length > 48 ||
    hasControlCharacter
  ) {
    throw new AgentApiError("Bot name must be between 1 and 48 characters.", 400);
  }
  return botName;
}

function cleanAvatarUrl(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined || !value.trim()) return undefined;
  if (value.length > 2_048) {
    throw new AgentApiError("Profile image URL is too long.", 400);
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AgentApiError("Profile image URL must be valid.", 400);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new AgentApiError("Profile image URL must be a public HTTPS URL.", 400);
  }
  return url.toString();
}

function getSql(): NeonQueryFunction<false, false> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Arena agent chat.");
  }
  if (!sqlClient) sqlClient = neon(databaseUrl);
  return sqlClient;
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toIsoString(value: string): string {
  return new Date(value).toISOString();
}

function optionalIsoString(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function latestTimestamp(values: Array<string | null>): string | null {
  const timestamps = values.flatMap((value) =>
    value ? [new Date(value).getTime()] : [],
  );
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}
