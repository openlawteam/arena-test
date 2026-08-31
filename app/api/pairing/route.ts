import { NextResponse } from "next/server";

import { buildGrokSetupPrompt } from "@/lib/arena-onboarding";
import { ConnectionError, assertSameOrigin } from "@/lib/grok-connection";
import { createPairing } from "@/lib/pairing-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const pairing = await createPairing();
    const origin = process.env.ARENA_PUBLIC_URL
      ? new URL(process.env.ARENA_PUBLIC_URL).origin
      : new URL(request.headers.get("origin") || request.url).origin;

    return NextResponse.json(
      {
        claimSecret: pairing.claimSecret,
        expiresAt: pairing.expiresAt,
        prompt: buildGrokSetupPrompt(origin, pairing.pairingCode),
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message =
      error instanceof ConnectionError
        ? error.message
        : "Arena could not create a pairing session.";
    return NextResponse.json(
      { error: message },
      {
        status: error instanceof ConnectionError ? 400 : 500,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
