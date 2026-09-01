import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  ConnectionError,
  GROK_CONNECTION_COOKIE,
  assertSameOrigin,
  cookieOptions,
  openConnection,
  summarizeConnection,
} from "@/lib/grok-connection";
import { consumePairingByConnectionId } from "@/lib/pairing-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  const connection = openConnection(
    cookieStore.get(GROK_CONNECTION_COOKIE)?.value,
  );

  return NextResponse.json(
    connection
      ? { connected: true, connection: summarizeConnection(connection) }
      : { connected: false, connection: null },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const cookieStore = await cookies();
    const connection = openConnection(
      cookieStore.get(GROK_CONNECTION_COOKIE)?.value,
    );

    if (connection) {
      await consumePairingByConnectionId(connection.connectionId);
    }

    const response = NextResponse.json(
      { connected: false },
      { headers: { "cache-control": "no-store" } },
    );
    response.cookies.set(GROK_CONNECTION_COOKIE, "", cookieOptions(0));
    return response;
  } catch (error) {
    return connectionErrorResponse(error);
  }
}

function connectionErrorResponse(error: unknown) {
  const message =
    error instanceof ConnectionError
      ? error.message
      : "Arena could not save that connection.";
  const status = error instanceof ConnectionError ? 400 : 500;
  return NextResponse.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}
