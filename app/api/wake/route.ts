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
} from "@/lib/grok-connection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function POST(request: Request) {
  const startedAt = Date.now();

  try {
    assertSameOrigin(request);
    const cookieStore = await cookies();
    const connection = openConnection(
      cookieStore.get(GROK_CONNECTION_COOKIE)?.value,
    );

    if (!connection) {
      return NextResponse.json(
        { error: "Connect a Grok Bot before sending a wake test." },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }

    const lastWakeAt = connection.lastWakeAt
      ? Date.parse(connection.lastWakeAt)
      : 0;
    const retryAfterMs = WAKE_COOLDOWN_MS - (Date.now() - lastWakeAt);
    if (retryAfterMs > 0) {
      return NextResponse.json(
        {
          error: `Wait ${Math.ceil(retryAfterMs / 1000)} seconds before waking again.`,
          retryAfterMs,
        },
        { status: 429, headers: { "cache-control": "no-store" } },
      );
    }

    await assertPublicWebhookDestination(connection.webhookUrl);

    const eventId = `wake_${randomUUID()}`;
    const sentAt = new Date().toISOString();
    const payload = {
      type: "arena.wake.test",
      event_id: eventId,
      source: "arena-mvp",
      sent_at: sentAt,
      bot_name: connection.botName,
      message: "Arena wake test received. Follow your routine instruction.",
    };

    connection.lastWakeAt = sentAt;

    const upstream = await fetch(connection.webhookUrl, {
      method: "POST",
      headers: webhookHeaders(connection.authMode, connection.webhookKey),
      body: JSON.stringify(payload),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });

    const responsePayload = upstream.ok
      ? {
          ok: true,
          eventId,
          acceptedAt: new Date().toISOString(),
          upstreamStatus: upstream.status,
          latencyMs: Date.now() - startedAt,
        }
      : {
          error: upstream.status === 401 || upstream.status === 403
            ? "Grok rejected the webhook key. Check the key format and reconnect."
            : `The webhook declined the wake request (HTTP ${upstream.status}).`,
          eventId,
          upstreamStatus: upstream.status,
          latencyMs: Date.now() - startedAt,
        };

    const response = NextResponse.json(responsePayload, {
      status: upstream.ok ? 200 : 502,
      headers: { "cache-control": "no-store" },
    });
    response.cookies.set(
      GROK_CONNECTION_COOKIE,
      sealConnection(connection),
      cookieOptions(),
    );
    return response;
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    const message = timeout
      ? "The Grok webhook did not respond within 6 seconds."
      : error instanceof ConnectionError
        ? error.message
        : "Arena could not deliver the wake request.";

    return NextResponse.json(
      { error: message, latencyMs: Date.now() - startedAt },
      {
        status: timeout ? 504 : error instanceof ConnectionError ? 400 : 502,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
