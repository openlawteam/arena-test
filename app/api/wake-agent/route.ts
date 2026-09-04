import { randomUUID } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  ConnectionError,
  GROK_CONNECTION_COOKIE,
  WAKE_COOLDOWN_MS,
  assertPublicWebhookDestination,
  assertSameOrigin,
  openConnection,
  sealConnection,
  webhookHeaders,
} from "@/lib/grok-connection";
import {
  listConnectedPairings,
  updateConnectedPairing,
} from "@/lib/pairing-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function POST(request: Request) {
  const startedAt = Date.now();

  try {
    assertSameOrigin(request);

    const cookieStore = await cookies();
    const requester = openConnection(
      cookieStore.get(GROK_CONNECTION_COOKIE)?.value,
    );
    if (!requester) {
      return NextResponse.json(
        { error: "Connect your Grok Bot before waking an agent." },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }

    const body = (await request.json()) as Record<string, unknown>;
    const targetAgentId = String(body.targetAgentId || "").trim();
    if (!targetAgentId) {
      return NextResponse.json(
        { error: "Choose an Arena agent to wake." },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    if (targetAgentId === requester.connectionId) {
      return NextResponse.json(
        { error: "Use the wake test to wake your own bot." },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }

    const pairings = await listConnectedPairings();
    const connectedAgents = pairings.flatMap((stored) => {
      const connection = openConnection(
        stored.encryptedConnection,
        stored.lastSeenAt,
      );
      return connection ? [{ stored, connection }] : [];
    });
    const requesterIsConnected = connectedAgents.some(
      ({ connection }) => connection.connectionId === requester.connectionId,
    );
    if (!requesterIsConnected) {
      return NextResponse.json(
        { error: "Your Bot is no longer connected to Arena." },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }

    const target = connectedAgents.find(
      ({ connection }) => connection.connectionId === targetAgentId,
    );
    if (!target) {
      return NextResponse.json(
        { error: "That Arena agent is no longer connected." },
        { status: 404, headers: { "cache-control": "no-store" } },
      );
    }

    const lastWakeAt = target.connection.lastWakeAt
      ? Date.parse(target.connection.lastWakeAt)
      : 0;
    const retryAfterMs = WAKE_COOLDOWN_MS - (Date.now() - lastWakeAt);
    if (retryAfterMs > 0) {
      return NextResponse.json(
        {
          error: `${target.connection.botName} was just woken. Try again in ${Math.ceil(retryAfterMs / 1000)} seconds.`,
          retryAfterMs,
        },
        { status: 429, headers: { "cache-control": "no-store" } },
      );
    }

    await assertPublicWebhookDestination(target.connection.webhookUrl);

    const eventId = `wake_agent_${randomUUID()}`;
    const sentAt = new Date().toISOString();
    const upstream = await fetch(target.connection.webhookUrl, {
      method: "POST",
      headers: {
        ...webhookHeaders(
          target.connection.authMode,
          target.connection.webhookKey,
        ),
        "x-arena-event-id": eventId,
        "x-arena-event-type": "wake-up",
      },
      body: JSON.stringify({
        type: "arena.wake.agent",
        event_id: eventId,
        delivery_id: `delivery_${randomUUID()}`,
        source: "arena-mvp",
        sent_at: sentAt,
        requested_by: requester.connectionId,
        agent_id: target.connection.connectionId,
        bot_name: target.connection.botName,
        message: "WAKE UP",
      }),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });

    if (!upstream.ok) {
      target.connection.lastWakeFailedAt = sentAt;
      await updateConnectedPairing(
        target.stored.pairingId,
        sealConnection(target.connection),
      );
      return NextResponse.json(
        {
          error: `The webhook for ${target.connection.botName} declined the wake request (HTTP ${upstream.status}).`,
          eventId,
          upstreamStatus: upstream.status,
          latencyMs: Date.now() - startedAt,
        },
        { status: 502, headers: { "cache-control": "no-store" } },
      );
    }

    target.connection.lastWakeAt = sentAt;
    await updateConnectedPairing(
      target.stored.pairingId,
      sealConnection(target.connection),
    );

    return NextResponse.json(
      {
        ok: true,
        eventId,
        agentId: target.connection.connectionId,
        botName: target.connection.botName,
        acceptedAt: sentAt,
        upstreamStatus: upstream.status,
        latencyMs: Date.now() - startedAt,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    const message = timeout
      ? "The agent webhook did not respond within 6 seconds."
      : error instanceof ConnectionError
        ? error.message
        : "Arena could not wake that agent.";

    return NextResponse.json(
      { error: message, latencyMs: Date.now() - startedAt },
      {
        status: timeout ? 504 : error instanceof ConnectionError ? 400 : 502,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
