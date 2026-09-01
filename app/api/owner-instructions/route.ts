import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  AgentApiError,
  type AuthenticatedAgent,
} from "@/lib/agent-chat";
import {
  ConnectionError,
  GROK_CONNECTION_COOKIE,
  assertSameOrigin,
  openConnection,
} from "@/lib/grok-connection";
import {
  createOwnerInstruction,
  notifyOwnerInstruction,
} from "@/lib/owner-instructions";
import { listConnectedPairings } from "@/lib/pairing-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);

    const cookieStore = await cookies();
    const browserConnection = openConnection(
      cookieStore.get(GROK_CONNECTION_COOKIE)?.value,
    );
    if (!browserConnection) {
      return NextResponse.json(
        { error: "Connect your Grok Bot before starting a conversation." },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }

    const connectedAgents = await loadConnectedAgents();
    const owner = connectedAgents.find(
      (agent) =>
        agent.connection.connectionId === browserConnection.connectionId,
    );
    if (!owner) {
      return NextResponse.json(
        { error: "Your Bot is no longer connected to Arena." },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }

    const body = (await request.json()) as Record<string, unknown>;
    const targetAgentId = String(body.targetAgentId || "").trim();
    const target = connectedAgents.find(
      (agent) => agent.connection.connectionId === targetAgentId,
    );
    if (!target) {
      throw new AgentApiError(
        "That Arena agent is no longer connected.",
        404,
      );
    }

    const instruction = await createOwnerInstruction({
      owner,
      target,
      note: String(body.note || ""),
    });
    const delivery = await notifyOwnerInstruction(instruction.id, owner);

    return NextResponse.json(
      {
        instruction: {
          id: instruction.id,
          owner: instruction.owner,
          target: instruction.target,
          createdAt: instruction.createdAt,
        },
        delivery,
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message =
      error instanceof ConnectionError || error instanceof AgentApiError
        ? error.message
        : "Arena could not send that private note.";
    const status =
      error instanceof AgentApiError
        ? error.status
        : error instanceof ConnectionError
          ? 400
          : 500;
    return NextResponse.json(
      { error: message },
      { status, headers: { "cache-control": "no-store" } },
    );
  }
}

async function loadConnectedAgents(): Promise<AuthenticatedAgent[]> {
  const pairings = await listConnectedPairings();
  return pairings.flatMap((stored) => {
    const connection = openConnection(
      stored.encryptedConnection,
      stored.lastSeenAt,
    );
    return connection
      ? [{ pairingId: stored.pairingId, connection }]
      : [];
  });
}
