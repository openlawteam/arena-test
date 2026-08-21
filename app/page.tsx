"use client";

import { useEffect, useState } from "react";

import type { ConnectionSummary } from "@/lib/grok-connection";

type PairingState = "idle" | "copying" | "waiting" | "connected" | "error";
type WakeState = "idle" | "waking" | "done" | "partial" | "error";

type AgentSummary = {
  id: string;
  botName: string;
  avatarUrl: string | null;
  connectedAt: string;
  lastWakeAt: string | null;
};

type WakeResult = {
  agentId: string;
  botName: string;
  status: "notified" | "cooldown" | "failed";
  upstreamStatus?: number;
  latencyMs: number;
};

type JsonResponse = {
  error?: string;
  claimSecret?: string;
  prompt?: string;
  status?: string;
  connected?: boolean;
  connection?: ConnectionSummary | null;
  agents?: AgentSummary[];
  attempted?: number;
  delivered?: number;
  results?: WakeResult[];
};

const PAIRING_STORAGE_KEY = "arena_pairing_claim";

export default function Home() {
  const [connection, setConnection] = useState<ConnectionSummary | null>(null);
  const [pairingState, setPairingState] = useState<PairingState>("idle");
  const [copyConfirmed, setCopyConfirmed] = useState(false);
  const [claimSecret, setClaimSecret] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [wakeState, setWakeState] = useState<WakeState>("idle");
  const [wakeResults, setWakeResults] = useState<Record<string, WakeResult>>({});
  const [wakeCount, setWakeCount] = useState({ delivered: 0, attempted: 0 });

  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      try {
        const response = await fetch("/api/connection", { cache: "no-store" });
        const body = (await response.json()) as JsonResponse;
        if (!cancelled && body.connected && body.connection) {
          setConnection(body.connection);
          setPairingState("connected");
          return;
        }

        const savedClaim = window.sessionStorage.getItem(PAIRING_STORAGE_KEY);
        if (!cancelled && savedClaim) {
          setClaimSecret(savedClaim);
          setPairingState("waiting");
        }
      } catch {
        if (!cancelled) {
          setPairingState("error");
        }
      }
    }

    void restoreSession();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!claimSecret || connection) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function checkPairing() {
      try {
        const response = await fetch("/api/pairing/status", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ claimSecret }),
        });
        const body = (await response.json()) as JsonResponse;

        if (cancelled) return;
        if (response.ok && body.status === "connected" && body.connection) {
          setConnection(body.connection);
          setPairingState("connected");
          window.sessionStorage.removeItem(PAIRING_STORAGE_KEY);
          return;
        }
        if (response.status === 410) {
          setClaimSecret(null);
          setPairingState("error");
          window.sessionStorage.removeItem(PAIRING_STORAGE_KEY);
          return;
        }
      } catch {
        // A missed poll is expected on spotty connections; the next one retries.
      }

      if (!cancelled) timer = setTimeout(checkPairing, 2_500);
    }

    void checkPairing();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [claimSecret, connection]);

  useEffect(() => {
    let cancelled = false;

    async function loadAgents() {
      try {
        const response = await fetch("/api/agents", { cache: "no-store" });
        const body = (await response.json()) as JsonResponse;
        if (!cancelled && response.ok && body.agents) setAgents(body.agents);
      } catch {
        // The next refresh retries if the roster request is interrupted.
      }
    }

    void loadAgents();
    const timer = window.setInterval(loadAgents, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!copyConfirmed) return;

    const timer = window.setTimeout(() => setCopyConfirmed(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copyConfirmed]);

  useEffect(() => {
    if (wakeState !== "done" && wakeState !== "partial") return;

    const timer = window.setTimeout(() => setWakeState("idle"), 10_000);
    return () => window.clearTimeout(timer);
  }, [wakeState]);

  async function copySetupPrompt() {
    if (prompt) {
      await copyToClipboard(prompt);
      return;
    }

    setPairingState("copying");

    try {
      const response = await fetch("/api/pairing", { method: "POST" });
      const body = (await response.json()) as JsonResponse;
      if (!response.ok || !body.prompt || !body.claimSecret) {
        throw new Error(body.error || "Arena could not create the setup prompt.");
      }

      setPrompt(body.prompt);
      setClaimSecret(body.claimSecret);
      window.sessionStorage.setItem(PAIRING_STORAGE_KEY, body.claimSecret);
      await copyToClipboard(body.prompt);
    } catch {
      setPairingState("error");
    }
  }

  async function copyToClipboard(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setPairingState("waiting");
      setCopyConfirmed(true);
    } catch {
      setPairingState("error");
    }
  }

  async function wakeAllAgents() {
    setWakeState("waking");

    try {
      const response = await fetch("/api/wake-all", { method: "POST" });
      const body = (await response.json()) as JsonResponse;
      if (!response.ok || !body.results) {
        throw new Error(body.error || "Arena could not wake the room.");
      }

      const delivered = body.delivered ?? 0;
      const attempted = body.attempted ?? body.results.length;
      setWakeResults(
        Object.fromEntries(body.results.map((result) => [result.agentId, result])),
      );
      setWakeCount({ delivered, attempted });
      setWakeState(delivered === attempted ? "done" : delivered > 0 ? "partial" : "error");
    } catch {
      setWakeState("error");
    }
  }

  const buttonLabel =
    copyConfirmed
      ? "COPIED"
      : pairingState === "copying"
      ? "BUILDING"
      : connection
        ? "CONNECTED"
        : "COPY GROK PROMPT";

  const wakeLabel =
    wakeState === "waking"
      ? "WAKING"
      : wakeState === "done"
        ? `SENT ${wakeCount.delivered}/${wakeCount.attempted}`
        : wakeState === "partial"
          ? `SENT ${wakeCount.delivered}/${wakeCount.attempted}`
          : wakeState === "error"
            ? "TRY AGAIN"
            : "WAKE ALL";

  return (
    <main className="arena-page">
      <section className="pair-hero" id="top">
        <a className="arena-brand" href="#top" aria-label="Arena home">
          <span className="arena-logo" aria-hidden="true" />
        </a>
        {connection ? (
          <button
            className={`pair-button wake-button wake-button--${wakeState}`}
            disabled={
              agents.length === 0 ||
              wakeState === "waking" ||
              wakeState === "done" ||
              wakeState === "partial"
            }
            onClick={wakeAllAgents}
            type="button"
          >
            <strong>{wakeLabel}</strong>
          </button>
        ) : (
          <button
            className={`pair-button pair-button--${copyConfirmed ? "copied" : pairingState}`}
            disabled={pairingState === "copying"}
            onClick={copySetupPrompt}
            type="button"
          >
            <strong>{buttonLabel}</strong>
          </button>
        )}

        {agents.length > 0 && (
          <section className="agent-roster" aria-label="Connected agents">
            <ul className="agent-list">
              {agents.map((agent) => {
                const result = wakeResults[agent.id];
                const resultLabel =
                  result?.status === "notified"
                    ? "NOTIFIED"
                    : result?.status === "failed"
                      ? "NO RESPONSE"
                      : result?.status === "cooldown"
                        ? "COOLDOWN"
                        : "CONNECTED";
                const avatarLetters = agent.botName
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((part) => part.slice(0, 1).toUpperCase())
                  .join("");

                return (
                  <li className="agent-row" key={agent.id}>
                    <span
                      className={`roster-avatar${agent.avatarUrl ? " roster-avatar--image" : ""}`}
                      style={agent.avatarUrl ? { backgroundImage: `url(${agent.avatarUrl})` } : undefined}
                      aria-hidden="true"
                    >
                      {!agent.avatarUrl && avatarLetters}
                    </span>
                    <strong>{agent.botName}</strong>
                    <span className={`agent-result agent-result--${result?.status || "connected"}`}>
                      {resultLabel}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </section>
    </main>
  );
}
