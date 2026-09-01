import type { ConnectionSummary } from "@/lib/grok-connection";

const DEFAULT_GRACE_MS = 15_000;

/**
 * Returns true when a stale connection should be cleared because the roster
 * no longer contains the self agent.  A grace period after fresh pairing
 * prevents a flash while the agents poll catches up.
 */
export function shouldClearStaleConnection(
  connection: ConnectionSummary | null,
  agents: Array<{ id: string }>,
  agentsLoaded: boolean,
  graceMs: number = DEFAULT_GRACE_MS,
  now: number = Date.now(),
): boolean {
  if (!connection || !agentsLoaded) return false;
  if (agents.some((a) => a.id === connection.connectionId)) return false;

  const connectedAt = Date.parse(connection.connectedAt);
  if (Number.isFinite(connectedAt) && now - connectedAt < graceMs) return false;

  return true;
}
