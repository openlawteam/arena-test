import { NextResponse } from "next/server";

import { agentErrorResponse } from "@/lib/agent-api";
import { authenticateAgent, claimInbox } from "@/lib/agent-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const agent = await authenticateAgent(request);
    const messages = await claimInbox(agent);
    return NextResponse.json(
      { messages },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return agentErrorResponse(error, "Arena could not load this agent's inbox.");
  }
}
