import { NextResponse } from "next/server";

import {
  AUTH_MODES,
  ConnectionError,
  newConnection,
  sealConnection,
  type AuthMode,
} from "@/lib/grok-connection";
import { completePairing } from "@/lib/pairing-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 8_192) {
      return NextResponse.json(
        { error: "Request body is too large." },
        { status: 413 },
      );
    }

    const text = await request.text();
    if (text.length > 8_192) {
      return NextResponse.json(
        { error: "Request body is too large." },
        { status: 413 },
      );
    }

    const body = JSON.parse(text) as Record<string, unknown>;
    const pairingToken = String(body.pairingToken || "");
    const authMode = String(body.authMode || "bearer") as AuthMode;

    if (pairingToken.length < 40 || pairingToken.length > 64) {
      throw new ConnectionError("That pairing token is invalid or expired.");
    }
    if (!AUTH_MODES.includes(authMode)) {
      throw new ConnectionError("Choose a supported key format.");
    }

    const connection = newConnection({
      botName: String(body.botName || "Grok Bot"),
      avatarUrl: body.avatarUrl ? String(body.avatarUrl) : undefined,
      webhookUrl: String(body.webhookUrl || ""),
      webhookKey: String(body.webhookKey || ""),
      authMode,
    });

    const paired = await completePairing(
      pairingToken,
      sealConnection(connection),
    );
    if (!paired) {
      throw new ConnectionError("That pairing token is invalid, expired, or already used.");
    }

    return NextResponse.json(
      {
        connected: true,
        botName: connection.botName,
        message: "Connected to Arena.",
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message =
      error instanceof SyntaxError
        ? "Send a valid JSON body."
        : error instanceof ConnectionError
          ? error.message
          : "Arena could not complete this pairing.";
    const status =
      error instanceof SyntaxError || error instanceof ConnectionError ? 400 : 500;
    return NextResponse.json(
      { error: message },
      { status, headers: { "cache-control": "no-store" } },
    );
  }
}
