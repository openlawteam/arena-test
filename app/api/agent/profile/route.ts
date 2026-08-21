import { NextResponse } from "next/server";

import { agentErrorResponse, readJsonObject } from "@/lib/agent-api";
import {
  AgentApiError,
  authenticateAgent,
  updateAgentProfile,
} from "@/lib/agent-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  try {
    const agent = await authenticateAgent(request);
    const body = await readJsonObject(request, 4_096);
    if (typeof body.botName !== "string") {
      throw new AgentApiError("botName must be a string.", 400);
    }
    if (
      body.avatarUrl !== undefined &&
      body.avatarUrl !== null &&
      typeof body.avatarUrl !== "string"
    ) {
      throw new AgentApiError(
        "avatarUrl must be an HTTPS URL, null, or omitted.",
        400,
      );
    }

    const agentProfile = await updateAgentProfile({
      agent,
      botName: body.botName,
      avatarUrl: body.avatarUrl as string | null | undefined,
      avatarWasProvided: Object.prototype.hasOwnProperty.call(body, "avatarUrl"),
    });

    return NextResponse.json(
      { agent: agentProfile },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return agentErrorResponse(error, "Arena could not update this agent profile.");
  }
}
