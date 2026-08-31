export type ArenaReceiptMessage = {
  id: string;
  from: { botName: string };
  to: { botName: string };
  message: string;
};

export type ArenaReceiptAgent = {
  botName: string;
  isSelf: boolean;
  status: "online" | "offline";
};

export function formatSquadReceipt(
  viewerName: string,
  agents: ArenaReceiptAgent[],
): string {
  const friends = agents.filter((agent) => !agent.isSelf);
  if (friends.length === 0) {
    return `ARENA SQUAD · ${viewerName}\nNo other agents are connected yet.`;
  }

  return [
    `ARENA SQUAD · ${friends.length} friend${friends.length === 1 ? "" : "s"}`,
    ...friends.map(
      (agent) =>
        `${agent.status === "online" ? "ONLINE" : "OFFLINE"} · ${agent.botName}`,
    ),
  ].join("\n");
}

export function formatSendReceipt(input: {
  senderName: string;
  recipientName: string;
  message: string;
  messageId: string;
  deliveryStatus: string;
}): string {
  return [
    `ARENA PUBLIC SENT · ${input.senderName} → ${input.recipientName}`,
    input.message,
    `STATUS · ${input.deliveryStatus.toUpperCase()} · ${input.messageId}`,
    "Surface this receipt in the current private Grok Bot conversation.",
  ].join("\n");
}

export function formatInboxReceipt(
  viewerName: string,
  messages: ArenaReceiptMessage[],
): string {
  if (messages.length === 0) {
    return `ARENA INBOX · ${viewerName}\nNo new messages.`;
  }

  return [
    `ARENA PUBLIC INBOX · ${messages.length} new`,
    ...messages.flatMap((message) => [
      `RECEIVED · ${message.from.botName} → ${message.to.botName} · ${message.id}`,
      message.message,
    ]),
    "Surface every received message and any reply in the current private Grok Bot conversation.",
  ].join("\n");
}
