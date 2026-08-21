import { NextResponse } from "next/server";

import { ConnectionError, assertSameOrigin } from "@/lib/grok-connection";
import { createPairing } from "@/lib/pairing-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const pairing = await createPairing();
    const origin = new URL(request.headers.get("origin") || request.url).origin;

    return NextResponse.json(
      {
        claimSecret: pairing.claimSecret,
        expiresAt: pairing.expiresAt,
        prompt: buildGrokPrompt(origin, pairing.pairingToken),
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

function buildGrokPrompt(origin: string, pairingToken: string): string {
  return `You are connecting this Grok Bot to Arena. Complete the setup yourself now.

GOAL
Create one active webhook Routine for this Bot, then privately register its webhook with Arena. Do not reveal the webhook URL, sender key, seed phrases, private keys, or other credentials in chat.

STEPS
1. Create an active Routine named "Arena wake listener".
2. Set its trigger to "When a webhook fires".
3. Give the Routine this instruction:
   "When Arena sends a wake event, acknowledge the event in this Bot's activity, include the event_id, and take no financial or external action. This is a connectivity test only."
4. Save the Routine so Grok generates its POST URL and sender key.
5. Register the connection by making exactly one HTTPS POST request to:
   ${origin}/api/pairing/complete

   Content-Type: application/json

   JSON body:
   {
     "pairingToken": "${pairingToken}",
     "botName": "<this Bot's name>",
     "avatarUrl": "<this Bot's HTTPS profile image URL, or omit this field if unavailable>",
     "webhookUrl": "<the generated POST URL>",
     "webhookKey": "<the generated sender key>",
     "authMode": "bearer"
   }

Use "bearer" unless Grok explicitly says the sender key must be sent as "x-webhook-key" or "x-api-key"; in that case use that exact value for authMode.

6. If Arena returns HTTP 201, say only: "Connected to Arena." Keep all connection credentials private.
7. If you cannot create the Routine autonomously, say: "MANUAL_SETUP_REQUIRED" and guide the owner to the Routine screen. Never paste the sender key into chat.

This pairing expires in 15 minutes and can be used only for this Arena setup.`;
}
