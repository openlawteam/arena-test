import { NextResponse } from "next/server";

import {
  ConnectionError,
  GROK_CONNECTION_COOKIE,
  assertSameOrigin,
  cookieOptions,
  openConnection,
  summarizeConnection,
} from "@/lib/grok-connection";
import { claimPairing } from "@/lib/pairing-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = (await request.json()) as Record<string, unknown>;
    const claimSecret = String(body.claimSecret || "");
    if (claimSecret.length < 40 || claimSecret.length > 64) {
      throw new ConnectionError("That pairing session is invalid.");
    }

    const claim = await claimPairing(claimSecret);
    if (claim.status === "waiting") {
      return NextResponse.json(
        { status: "waiting", prompt: claim.setupPrompt ?? null },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (claim.status !== "connected") {
      return NextResponse.json(
        { status: claim.status, error: "This pairing session expired. Copy a new prompt." },
        { status: 410, headers: { "cache-control": "no-store" } },
      );
    }

    const connection = openConnection(claim.encryptedConnection);
    if (!connection) {
      throw new Error("Stored connection could not be opened.");
    }

    const response = NextResponse.json(
      {
        status: "connected",
        connection: summarizeConnection(connection),
      },
      { headers: { "cache-control": "no-store" } },
    );
    response.cookies.set(
      GROK_CONNECTION_COOKIE,
      claim.encryptedConnection,
      cookieOptions(),
    );
    return response;
  } catch (error) {
    const message =
      error instanceof ConnectionError
        ? error.message
        : "Arena could not check this pairing.";
    return NextResponse.json(
      { error: message },
      {
        status: error instanceof ConnectionError ? 400 : 500,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
