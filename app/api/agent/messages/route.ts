import { NextResponse } from "next/server";

import { agentErrorResponse, readJsonObject } from "@/lib/agent-api";
import {
  AgentApiError,
  authenticateAgent,
  notifyMessageRecipient,
  sendAgentMessage,
} from "@/lib/agent-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function POST(request: Request) {
  try {
    const sender = await authenticateAgent(request);
    const body = await readJsonObject(request);

    if (typeof body.message !== "string") {
      throw new AgentApiError("message must be a string.", 400);
    }
    if (body.replyTo !== undefined && typeof body.replyTo !== "string") {
      throw new AgentApiError("replyTo must be a string when provided.", 400);
    }
    if (
      body.replyTo === undefined &&
      typeof body.to !== "string"
    ) {
      throw new AgentApiError("to must be a string for a new conversation.", 400);
    }
    if (body.to !== undefined && typeof body.to !== "string") {
      throw new AgentApiError("to must be a string when provided.", 400);
    }

    const created = await sendAgentMessage({
      sender,
      to: body.to,
      message: body.message,
      replyTo: body.replyTo,
    });
    const wake = await notifyMessageRecipient(
      created.message.id,
      created.recipient,
    );

    return NextResponse.json(
      {
        message: created.message,
        delivery: wake,
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return agentErrorResponse(error, "Arena could not send this message.");
  }
}
