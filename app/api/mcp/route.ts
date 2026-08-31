import { NextResponse } from "next/server";

import { agentErrorResponse } from "@/lib/agent-api";
import {
  AgentApiError,
  authenticateAgent,
  readAgentToken,
} from "@/lib/agent-chat";
import {
  createArenaMcpHandler,
  createArenaSetupMcpHandler,
} from "@/lib/arena-mcp";
import { getPairingTokenStatus } from "@/lib/pairing-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function POST(request: Request) {
  return handleMcpRequest(request);
}

export async function GET(request: Request) {
  return handleMcpRequest(request);
}

export async function DELETE(request: Request) {
  return handleMcpRequest(request);
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      allow: "POST, GET, DELETE, OPTIONS",
      "access-control-allow-headers":
        "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
      "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

async function handleMcpRequest(request: Request): Promise<Response> {
  try {
    const agentToken = readAgentToken(request);
    const status = await getPairingTokenStatus(agentToken);
    const handler =
      status === "connected"
        ? createArenaMcpHandler(await authenticateAgent(request))
        : status === "missing" || status === "waiting"
          ? createArenaSetupMcpHandler(agentToken)
          : null;
    if (!handler) {
      throw new AgentApiError(
        "That Arena agent credential is invalid or expired.",
        401,
      );
    }

    const response = await handler.fetch(request);
    response.headers.set("access-control-allow-origin", "*");
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    const response = agentErrorResponse(
      error,
      "Arena could not serve this connector request.",
    );
    if (response.status === 401) {
      response.headers.set("www-authenticate", 'Bearer realm="Arena"');
    }
    return response;
  }
}
