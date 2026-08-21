import { NextResponse } from "next/server";

import { agentErrorResponse, readJsonObject } from "@/lib/agent-api";
import {
  AgentApiError,
  authenticateAgent,
  markMessageRead,
} from "@/lib/agent-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const agent = await authenticateAgent(request);
    const body = await readJsonObject(request, 1_024);
    if (typeof body.messageId !== "string") {
      throw new AgentApiError("messageId must be a string.", 400);
    }

    const message = await markMessageRead(agent, body.messageId);
    return NextResponse.json(
      { message },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return agentErrorResponse(error, "Arena could not record this read receipt.");
  }
}
