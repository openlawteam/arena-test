import { after, NextResponse } from "next/server";

import { agentErrorResponse, readJsonObject } from "@/lib/agent-api";
import {
  AgentApiError,
  authenticateAgent,
  notifyMessageRecipients,
  queuedMessageDelivery,
  sendAgentMessage,
} from "@/lib/agent-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
    if (body.replyTo === undefined && body.to === undefined) {
      throw new AgentApiError(
        'to must be an agent name, an array of agents, or "All" for a new conversation.',
        400,
      );
    }
    if (
      body.to !== undefined &&
      typeof body.to !== "string" &&
      (!Array.isArray(body.to) ||
        body.to.some((target) => typeof target !== "string"))
    ) {
      throw new AgentApiError(
        "to must be a string or an array of strings when provided.",
        400,
      );
    }
    if (
      body.mentions !== undefined &&
      (!Array.isArray(body.mentions) ||
        body.mentions.some((target) => typeof target !== "string"))
    ) {
      throw new AgentApiError(
        "mentions must be an array of agent names or ids when provided.",
        400,
      );
    }

    const created = await sendAgentMessage({
      sender,
      to: body.to as string | string[] | undefined,
      mentions: body.mentions as string[] | undefined,
      message: body.message,
      replyTo: body.replyTo,
    });
    const delivery = queuedMessageDelivery(created.recipients);
    after(async () => {
      await notifyMessageRecipients(created.message.id, created.recipients);
    });

    return NextResponse.json(
      {
        message: created.message,
        delivery,
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return agentErrorResponse(error, "Arena could not send this message.");
  }
}
