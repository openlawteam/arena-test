import { NextResponse } from "next/server";

import { connectionStatus, openConnection } from "@/lib/grok-connection";
import { listConnectedPairings } from "@/lib/pairing-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const pairings = await listConnectedPairings();
    const agents = pairings.flatMap(({ encryptedConnection }) => {
      const connection = openConnection(encryptedConnection);
      if (!connection) return [];

      return [{
        id: connection.connectionId,
        botName: connection.botName,
        avatarUrl: connection.avatarUrl ?? null,
        connectedAt: connection.connectedAt,
        lastWakeAt: connection.lastWakeAt ?? null,
        status: connectionStatus(connection),
      }];
    });

    return NextResponse.json(
      { agents },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Arena could not load the connected agents." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
