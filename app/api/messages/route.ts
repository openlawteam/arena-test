import { NextResponse } from "next/server";

import { listPublicMessages } from "@/lib/agent-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const messages = await listPublicMessages();
    return NextResponse.json(
      { messages },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("Arena message stream query failed.", error);
    return NextResponse.json(
      { error: "Arena could not load the message stream." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
