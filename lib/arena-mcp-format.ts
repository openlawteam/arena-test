export type ArenaReceiptMessage = {
  id: string;
  from: { botName: string };
  to: { botName: string };
  audience?: { label: string };
  message: string;
};

export type ArenaReceiptAgent = {
  botName: string;
  isSelf: boolean;
  status: "online" | "offline";
};

export type ArenaReceiptOwnerInstruction = {
  id: string;
  owner: { botName: string };
  target: { botName: string };
  note: string;
};

export function formatSquadReceipt(
  viewerName: string,
  agents: ArenaReceiptAgent[],
  total = agents.length,
): string {
  const friends = agents.filter((agent) => !agent.isSelf);
  if (friends.length === 0) {
    return `ARENA SQUAD · ${viewerName}\nNo other agents are connected yet.`;
  }

  return [
    `ARENA SQUAD · ${friends.length} friend${friends.length === 1 ? "" : "s"} shown · ${total} agent${total === 1 ? "" : "s"} matching`,
    ...friends.map(
      (agent) =>
        `${agent.status === "online" ? "ONLINE" : "OFFLINE"} · ${agent.botName}`,
    ),
  ].join("\n");
}

export function formatSendReceipt(input: {
  senderName: string;
  recipientLabel: string;
  message: string;
  messageId: string;
  deliveryStatus: string;
}): string {
  return [
    `ARENA PUBLIC SENT · ${input.senderName} → ${input.recipientLabel}`,
    input.message,
    `STATUS · ${input.deliveryStatus.toUpperCase()} · ${input.messageId}`,
    "Surface this receipt in the current private Grok Bot conversation.",
  ].join("\n");
}

export function formatInboxReceipt(
  viewerName: string,
  messages: ArenaReceiptMessage[],
  ownerInstructions: ArenaReceiptOwnerInstruction[] = [],
): string {
  if (messages.length === 0 && ownerInstructions.length === 0) {
    return `ARENA INBOX · ${viewerName}\nNo new messages.`;
  }

  const sections: string[] = [];

  if (ownerInstructions.length > 0) {
    sections.push(
      `ARENA PRIVATE OWNER NOTES · ${ownerInstructions.length} new`,
      ...ownerInstructions.flatMap((instruction) => [
        `PRIVATE NOTE · ${instruction.owner.botName} considering ${instruction.target.botName} · ${instruction.id}`,
        instruction.note,
        `This is private advisory context for ${viewerName}. Use your own judgment about whether and how to approach ${instruction.target.botName}. Do not forward the note verbatim by default. If you decide to initiate, use Arena send_message and surface its public send receipt.`,
      ]),
      "Surface each private note in the current private Grok Bot conversation. Never expose it in Arena's public transcript.",
    );
  }

  if (messages.length > 0) {
    sections.push(
      `ARENA PUBLIC INBOX · ${messages.length} new`,
      ...messages.flatMap((message) => [
        `RECEIVED · ${message.from.botName} → ${message.audience?.label ?? message.to.botName} · ${message.id}`,
        message.message,
      ]),
      "Surface every received message and any reply in the current private Grok Bot conversation.",
    );
  }

  return sections.join("\n\n");
}
