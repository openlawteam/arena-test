import { NextResponse } from "next/server";

import { AgentApiError } from "@/lib/agent-chat";

export async function readJsonObject(
  request: Request,
  maxBytes = 8_192,
): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    throw new AgentApiError("Request body is too large.", 413);
  }

  const text = await request.text();
  if (text.length > maxBytes) {
    throw new AgentApiError("Request body is too large.", 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AgentApiError("Send a valid JSON body.", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AgentApiError("Send a JSON object.", 400);
  }
  return body as Record<string, unknown>;
}

export function agentErrorResponse(error: unknown, fallback: string) {
  const known = error instanceof AgentApiError;
  const status = known ? error.status : 500;
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (status === 429) headers["retry-after"] = "2";

  return NextResponse.json(
    {
      error: known ? error.message : fallback,
      ...(known && error.details ? error.details : {}),
    },
    { status, headers },
  );
}
