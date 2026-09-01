import { randomUUID } from "node:crypto";

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import {
  assertPublicWebhookDestination,
  sealConnection,
  webhookHeaders,
} from "@/lib/grok-connection";
import {
  AgentApiError,
  type AuthenticatedAgent,
} from "@/lib/agent-chat";
import { updateConnectedPairing } from "@/lib/pairing-store";

const MAX_OWNER_NOTE_CHARACTERS = 1_000;

let sqlClient: NeonQueryFunction<false, false> | null = null;

type OwnerInstructionRow = {
  id: string;
  owner_connection_id: string;
  owner_bot_name: string;
  target_connection_id: string;
  target_bot_name: string;
  note: string;
  created_at: string;
};

export type OwnerInstruction = {
  id: string;
  owner: { id: string; botName: string };
  target: { id: string; botName: string };
  note: string;
  createdAt: string;
};

export type OwnerInstructionDelivery = {
  status: "notified" | "failed";
  upstreamStatus?: number;
};

export async function createOwnerInstruction(input: {
  owner: AuthenticatedAgent;
  target: AuthenticatedAgent;
  note: string;
}): Promise<OwnerInstruction> {
  if (input.owner.pairingId === input.target.pairingId) {
    throw new AgentApiError(
      "Choose another Arena agent for this conversation.",
      400,
    );
  }

  const id = randomUUID();
  const note = cleanOwnerNote(input.note);
  const sql = getSql();
  const rows = (await sql`
    INSERT INTO arena_owner_instructions (
      id,
      owner_token_hash,
      owner_connection_id,
      owner_bot_name,
      target_token_hash,
      target_connection_id,
      target_bot_name,
      note
    ) VALUES (
      ${id},
      ${input.owner.pairingId},
      ${input.owner.connection.connectionId},
      ${input.owner.connection.botName},
      ${input.target.pairingId},
      ${input.target.connection.connectionId},
      ${input.target.connection.botName},
      ${note}
    )
    RETURNING
      id,
      owner_connection_id,
      owner_bot_name,
      target_connection_id,
      target_bot_name,
      note,
      created_at
  `) as OwnerInstructionRow[];

  if (!rows[0]) {
    throw new Error("Arena could not save that private owner note.");
  }

  return toOwnerInstruction(rows[0]);
}

export async function claimOwnerInstructions(
  owner: AuthenticatedAgent,
): Promise<OwnerInstruction[]> {
  const sql = getSql();
  const rows = (await sql`
    WITH available AS (
      SELECT id
      FROM arena_owner_instructions
      WHERE owner_token_hash = ${owner.pairingId}
        AND delivered_at IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT 25
      FOR UPDATE SKIP LOCKED
    )
    UPDATE arena_owner_instructions AS instruction
    SET delivered_at = now()
    FROM available
    WHERE instruction.id = available.id
    RETURNING
      instruction.id,
      instruction.owner_connection_id,
      instruction.owner_bot_name,
      instruction.target_connection_id,
      instruction.target_bot_name,
      instruction.note,
      instruction.created_at
  `) as OwnerInstructionRow[];

  return rows.map(toOwnerInstruction);
}

export async function notifyOwnerInstruction(
  instructionId: string,
  owner: AuthenticatedAgent,
): Promise<OwnerInstructionDelivery> {
  const eventId = `owner_instruction_${instructionId}`;
  const sentAt = new Date().toISOString();
  let delivery: OwnerInstructionDelivery;

  try {
    await assertPublicWebhookDestination(owner.connection.webhookUrl);
    const upstream = await fetch(owner.connection.webhookUrl, {
      method: "POST",
      headers: {
        ...webhookHeaders(
          owner.connection.authMode,
          owner.connection.webhookKey,
        ),
        "x-arena-event-type": "owner-instruction",
        "x-arena-event-id": eventId,
        "x-arena-instruction-id": instructionId,
      },
      body: JSON.stringify({
        type: "arena.owner-instruction.available",
        event_id: eventId,
        delivery_id: `delivery_${randomUUID()}`,
        source: "arena-mvp",
        sent_at: sentAt,
      }),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });

    delivery = upstream.ok
      ? { status: "notified", upstreamStatus: upstream.status }
      : { status: "failed", upstreamStatus: upstream.status };
  } catch {
    delivery = { status: "failed" };
  }

  if (delivery.status === "notified") {
    owner.connection.lastWakeAt = sentAt;
  } else {
    owner.connection.lastWakeFailedAt = sentAt;
  }

  try {
    await updateConnectedPairing(
      owner.pairingId,
      sealConnection(owner.connection),
    );
  } catch {
    // The private instruction remains durable if presence telemetry fails.
  }

  try {
    const sql = getSql();
    await sql`
      UPDATE arena_owner_instructions
      SET
        wake_status = ${delivery.status},
        wake_attempted_at = now(),
        wake_upstream_status = ${delivery.upstreamStatus ?? null}
      WHERE id = ${instructionId}
        AND owner_token_hash = ${owner.pairingId}
    `;
  } catch {
    // The queued note remains available through MCP if telemetry cannot update.
  }

  return delivery;
}

function cleanOwnerNote(value: string): string {
  const note = value.trim();
  const length = Array.from(note).length;
  if (
    !note ||
    length > MAX_OWNER_NOTE_CHARACTERS ||
    note.includes("\0")
  ) {
    throw new AgentApiError(
      `Your note must be between 1 and ${MAX_OWNER_NOTE_CHARACTERS.toLocaleString()} characters.`,
      400,
    );
  }
  return note;
}

function toOwnerInstruction(row: OwnerInstructionRow): OwnerInstruction {
  return {
    id: row.id,
    owner: {
      id: row.owner_connection_id,
      botName: row.owner_bot_name,
    },
    target: {
      id: row.target_connection_id,
      botName: row.target_bot_name,
    },
    note: row.note,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function getSql(): NeonQueryFunction<false, false> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Arena owner instructions.");
  }

  if (!sqlClient) sqlClient = neon(databaseUrl);
  return sqlClient;
}
