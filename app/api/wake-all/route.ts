import { randomUUID } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  ConnectionError,
  GROK_CONNECTION_COOKIE,
  WAKE_COOLDOWN_MS,
  assertPublicWebhookDestination,
  assertSameOrigin,
  cookieOptions,
  openConnection,
  sealConnection,
  webhookHeaders,
  type GrokConnection,
} from "@/lib/grok-connection";
import {
  listConnectedPairings,
  updateConnectedPairing,
  type StoredConnection,
} from "@/lib/pairing-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

type WakeResult = {
  agentId: string;
  botName: string;
  status: "notified" | "cooldown" | "failed";
  upstreamStatus?: number;
  latencyMs: number;
};

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);

    const cookieStore = await cookies();
    const requester = openConnection(
      cookieStore.get(GROK_CONNECTION_COOKIE)?.value,
    );
    if (!requester) {
      return NextResponse.json(
        { error: "Connect your Grok Bot before waking the room." },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }

    const requesterLastWake = requester.lastWakeAt
      ? Date.parse(requester.lastWakeAt)
      : 0;
    const retryAfterMs = WAKE_COOLDOWN_MS - (Date.now() - requesterLastWake);
    if (retryAfterMs > 0) {
      return NextResponse.json(
        {
          error: `Wait ${Math.ceil(retryAfterMs / 1000)} seconds before waking again.`,
          retryAfterMs,
        },
        { status: 429, headers: { "cache-control": "no-store" } },
      );
    }

    const storedConnections = await listConnectedPairings();
    const activeConnections = storedConnections.flatMap((stored) => {
      const connection = openConnection(stored.encryptedConnection);
      return connection ? [{ stored, connection }] : [];
    });

    if (activeConnections.length === 0) {
      return NextResponse.json(
        { error: "No connected Grok Bots are available to wake." },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }

    const eventId = `wake_all_${randomUUID()}`;
    const sentAt = new Date().toISOString();
    const results = await Promise.all(
      activeConnections.map(({ stored, connection }) =>
        notifyAgent(stored, connection, eventId, sentAt),
      ),
    );
    const delivered = results.filter((result) => result.status === "notified").length;

    requester.lastWakeAt = sentAt;
    const response = NextResponse.json(
      {
        ok: delivered > 0,
        eventId,
        attempted: results.length,
        delivered,
        results,
      },
      { headers: { "cache-control": "no-store" } },
    );
    response.cookies.set(
      GROK_CONNECTION_COOKIE,
      sealConnection(requester),
      cookieOptions(),
    );
    return response;
  } catch (error) {
    const message =
      error instanceof ConnectionError
        ? error.message
        : "Arena could not wake the connected agents.";
    return NextResponse.json(
      { error: message },
      {
        status: error instanceof ConnectionError ? 400 : 500,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}

async function notifyAgent(
  stored: StoredConnection,
  connection: GrokConnection,
  eventId: string,
  sentAt: string,
): Promise<WakeResult> {
  const startedAt = Date.now();
  const lastWakeAt = connection.lastWakeAt
    ? Date.parse(connection.lastWakeAt)
    : 0;
  if (WAKE_COOLDOWN_MS - (Date.now() - lastWakeAt) > 0) {
    return {
      agentId: connection.connectionId,
      botName: connection.botName,
      status: "cooldown",
      latencyMs: Date.now() - startedAt,
    };
  }

  try {
    await assertPublicWebhookDestination(connection.webhookUrl);
    const upstream = await fetch(connection.webhookUrl, {
      method: "POST",
      headers: {
        ...webhookHeaders(connection.authMode, connection.webhookKey),
        "x-arena-event-id": eventId,
        "x-arena-event-type": "wake-up",
      },
      body: JSON.stringify({
        type: "arena.wake.all",
        event_id: eventId,
        delivery_id: `delivery_${randomUUID()}`,
        source: "arena-mvp",
        sent_at: sentAt,
        agent_id: connection.connectionId,
        bot_name: connection.botName,
        message: "WAKE UP",
      }),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });

    if (!upstream.ok) {
      connection.lastWakeFailedAt = sentAt;
      await updateConnectedPairing(stored.pairingId, sealConnection(connection));
      return {
        agentId: connection.connectionId,
        botName: connection.botName,
        status: "failed",
        upstreamStatus: upstream.status,
        latencyMs: Date.now() - startedAt,
      };
    }

    connection.lastWakeAt = sentAt;
    await updateConnectedPairing(stored.pairingId, sealConnection(connection));
    return {
      agentId: connection.connectionId,
      botName: connection.botName,
      status: "notified",
      upstreamStatus: upstream.status,
      latencyMs: Date.now() - startedAt,
    };
  } catch {
    connection.lastWakeFailedAt = sentAt;
    try {
      await updateConnectedPairing(stored.pairingId, sealConnection(connection));
    } catch {
      // Preserve the delivery result even if liveness telemetry cannot be saved.
    }
    return {
      agentId: connection.connectionId,
      botName: connection.botName,
      status: "failed",
      latencyMs: Date.now() - startedAt,
    };
  }
}
