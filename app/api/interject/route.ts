import { cookies } from "next/headers";
import { after, NextResponse } from "next/server";

import {
  sendAgentMessage,
  queuedMessageDelivery,
  notifyMessageRecipients,
} from "@/lib/agent-chat";
import {
  ConnectionError,
  GROK_CONNECTION_COOKIE,
  assertSameOrigin,
  openConnection,
} from "@/lib/grok-connection";
import { listConnectedPairings } from "@/lib/pairing-store";

import type { AuthenticatedAgent } from "@/lib/agent-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);

    const cookieStore = await cookies();
    const cookieValue = cookieStore.get(GROK_CONNECTION_COOKIE)?.value;
    const connection = openConnection(cookieValue);
    if (!connection) {
      return NextResponse.json(
        { error: "Connect a bot before interjecting." },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }

    const pairings = await listConnectedPairings();
    let agent: AuthenticatedAgent | null = null;
    for (const stored of pairings) {
      const storedConn = openConnection(stored.encryptedConnection, stored.lastSeenAt);
      if (storedConn?.connectionId === connection.connectionId) {
        agent = { pairingId: stored.pairingId, connection: storedConn };
        break;
      }
    }
    if (!agent) {
      return NextResponse.json(
        { error: "Your bot is no longer connected." },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }

    const body = (await request.json()) as Record<string, unknown>;
    const to = body.to as string | string[] | undefined;
    const message = String(body.message || "");
    const replyTo = body.replyTo ? String(body.replyTo) : undefined;

    if (!message.trim()) {
      return NextResponse.json(
        { error: "Message cannot be empty." },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }

    const result = await sendAgentMessage({
      sender: agent,
      to: to ?? "all",
      message,
      replyTo,
    });

    const delivery =
      result.recipients.length > 0
        ? queuedMessageDelivery(result.recipients)
        : { status: "queued" as const, attempted: 0, notified: 0, failed: 0 };

    if (result.recipients.length > 0) {
      after(async () => {
        await notifyMessageRecipients(result.message.id, result.recipients);
      });
    }

    return NextResponse.json(
      { message: result.message, delivery },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message =
      error instanceof ConnectionError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Arena could not send that message.";
    const status =
      error instanceof ConnectionError
        ? 400
        : (error as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: message },
      { status, headers: { "cache-control": "no-store" } },
    );
  }
}
