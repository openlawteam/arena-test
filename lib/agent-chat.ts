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
  recipient_token_hash: string;
  recipient_connection_id: string;
  recipient_bot_name: string;
  body: string;
  reply_to_id: string | null;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
  wake_status: "pending" | "notified" | "failed";
  wake_upstream_status: number | null;
};

type ParentMessageRow = Pick<
  MessageRow,
  | "id"
  | "sender_token_hash"
  | "recipient_token_hash"
>;

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
  message: string;
  replyTo: string | null;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  deliveryStatus: "pending" | "notified" | "delivered" | "read" | "wake_failed";
};

export type InboxMessage = PublicMessage & {
  // Retained in the wire format so already-paired agents remain compatible.
  canReply: boolean;
};

export type MessageWakeResult = {
  status: "notified" | "failed";
  upstreamStatus?: number;
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
    throw new AgentApiError("Use the Arena pairing token as a Bearer token.", 401);
  }
  return match[1];
}

export async function listPublicMessages(): Promise<PublicMessage[]> {
  const sql = getSql();
  const rows = (await sql`
    WITH latest AS (
      SELECT *
      FROM arena_messages
      ORDER BY created_at DESC, id DESC
      LIMIT 50
    )
    SELECT *
    FROM latest
    ORDER BY created_at ASC, id ASC
  `) as MessageRow[];

  return rows.map(toPublicMessage);
}

export async function claimInbox(
  agent: AuthenticatedAgent,
): Promise<InboxMessage[]> {
  const sql = getSql();
  const rows = (await sql`
    WITH available AS (
      SELECT id
      FROM arena_messages
      WHERE recipient_token_hash = ${agent.pairingId}
        AND delivered_at IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT 50
      FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE arena_messages AS message
      SET delivered_at = now()
      FROM available
      WHERE message.id = available.id
      RETURNING message.*
    )
    SELECT *
    FROM claimed
    ORDER BY created_at ASC, id ASC
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
    UPDATE arena_messages
    SET
      delivered_at = COALESCE(delivered_at, now()),
      read_at = COALESCE(read_at, now())
    WHERE id = ${id}
      AND recipient_token_hash = ${agent.pairingId}
    RETURNING *
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
  to?: string;
  message: string;
  replyTo?: string;
}): Promise<{
  message: PublicMessage;
  recipient: AuthenticatedAgent;
}> {
  const messageBody = cleanMessage(input.message);
  const replyTo = cleanReplyId(input.replyTo);

  let recipient: AuthenticatedAgent;
  if (replyTo) {
    const parent = await getParentMessage(replyTo);
    if (!parent) {
      throw new AgentApiError("The message being replied to does not exist.", 404);
    }
    if (parent.recipient_token_hash !== input.sender.pairingId) {
      throw new AgentApiError("Only that message's recipient may reply.", 403);
    }
    const parentSender = await getConnectedAgent(parent.sender_token_hash);
    if (!parentSender) {
      throw new AgentApiError("The parent sender is no longer connected.", 410);
    }
    recipient = parentSender;
  } else {
    recipient = resolveRecipient(
      await listConnectedAgents(),
      cleanRecipient(input.to ?? ""),
    );
  }

  if (recipient.pairingId === input.sender.pairingId) {
    throw new AgentApiError("Choose another connected Arena agent.", 400);
  }

  const id = randomUUID();
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
      ), parent_read AS (
        UPDATE arena_messages
        SET
          delivered_at = COALESCE(delivered_at, now()),
          read_at = COALESCE(read_at, now())
        WHERE id = ${replyTo}
          AND recipient_token_hash = ${input.sender.pairingId}
          AND EXISTS (SELECT 1 FROM send_slot)
        RETURNING id
      )
      INSERT INTO arena_messages (
        id,
        sender_token_hash,
        sender_connection_id,
        sender_bot_name,
        recipient_token_hash,
        recipient_connection_id,
        recipient_bot_name,
        body,
        reply_to_id
      )
      SELECT
        ${id},
        ${input.sender.pairingId},
        ${input.sender.connection.connectionId},
        ${input.sender.connection.botName},
        ${recipient.pairingId},
        ${recipient.connection.connectionId},
        ${recipient.connection.botName},
        ${messageBody},
        ${replyTo}
      FROM send_slot
      RETURNING *
    `) as MessageRow[];

    if (!rows[0]) {
      throw new AgentApiError(
        "Wait two seconds before sending another message.",
        429,
        { retryAfterMs: 2_000 },
      );
    }

    return { message: toPublicMessage(rows[0]), recipient };
  } catch (error) {
    if (error instanceof AgentApiError) throw error;
    if (isUniqueViolation(error)) {
      throw new AgentApiError("That message has already been replied to.", 409);
    }
    throw error;
  }
}

export async function notifyMessageRecipient(
  messageId: string,
  recipient: AuthenticatedAgent,
): Promise<MessageWakeResult> {
  const eventId = `message_${messageId}`;
  const sentAt = new Date().toISOString();
  let result: MessageWakeResult;

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
      UPDATE arena_messages
      SET
        wake_status = ${result.status},
        wake_attempted_at = now(),
        wake_upstream_status = ${result.upstreamStatus ?? null}
      WHERE id = ${messageId}
    `;
  } catch {
    // The message remains durable even if delivery telemetry cannot be updated.
  }

  return result;
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

async function getConnectedAgent(
  pairingId: string,
): Promise<AuthenticatedAgent | null> {
  const sql = getSql();
  const rows = (await sql`
    SELECT token_hash, encrypted_connection, last_seen_at
    FROM arena_pairings
    WHERE token_hash = ${pairingId}
      AND status = 'connected'
      AND encrypted_connection IS NOT NULL
    LIMIT 1
  `) as ConnectedPairingRow[];
  const row = rows[0];
  if (!row) return null;

  const connection = openConnection(
    row.encrypted_connection,
    row.last_seen_at,
  );
  if (connection && row.last_seen_at) {
    connection.lastSeenAt = toIsoString(row.last_seen_at);
  }
  return connection ? { pairingId: row.token_hash, connection } : null;
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
    SELECT id, sender_token_hash, recipient_token_hash
    FROM arena_messages
    WHERE id = ${id}
    LIMIT 1
  `) as ParentMessageRow[];
  return rows[0] ?? null;
}

function toPublicMessage(row: MessageRow): PublicMessage {
  const deliveryStatus = row.read_at
    ? "read"
    : row.delivered_at
      ? "delivered"
      : row.wake_status === "failed"
        ? "wake_failed"
        : row.wake_status === "notified"
          ? "notified"
          : "pending";

  return {
    id: row.id,
    from: {
      id: row.sender_connection_id,
      botName: row.sender_bot_name,
    },
    to: {
      id: row.recipient_connection_id,
      botName: row.recipient_bot_name,
    },
    message: row.body,
    replyTo: row.reply_to_id,
    createdAt: toIsoString(row.created_at),
    deliveredAt: row.delivered_at ? toIsoString(row.delivered_at) : null,
    readAt: row.read_at ? toIsoString(row.read_at) : null,
    deliveryStatus,
  };
}

function cleanRecipient(value: string): string {
  const to = value.trim();
  if (!to || to.length > 100 || to.includes("\0")) {
    throw new AgentApiError("Provide a valid recipient name or connection id.", 400);
  }
  return to;
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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
