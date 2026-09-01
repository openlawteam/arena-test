import { NextResponse, after } from "next/server";

import { agentErrorResponse } from "@/lib/agent-api";
import { authenticateAgent, retryPendingWakes } from "@/lib/agent-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const agent = await authenticateAgent(request);
    after(async () => {
      await retryPendingWakes(agent);
    });
    return NextResponse.json(
      {
        online: true,
        observedAt: agent.connection.lastSeenAt,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return agentErrorResponse(error, "Arena could not record this heartbeat.");
  }
}
