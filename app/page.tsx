"use client";

import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { ConnectionSummary } from "@/lib/grok-connection";
import { shouldClearStaleConnection } from "@/lib/roster-sync";

type AgentSummary = {
  id: string;
  botName: string;
  avatarUrl: string | null;
  connectedAt: string;
  lastWakeAt: string | null;
  status: "online" | "offline";
};

type AgentMessage = {
  id: string;
  from: { id: string; botName: string };
  to: { id: string; botName: string };
  audience?: {
    type: "all" | "direct" | "group" | "thread";
    label: string;
    agents: Array<{ id: string; botName: string }>;
  };
  conversationId?: string;
  threadRootId?: string;
  replyTo?: string | null;
  message: string;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  deliveryStatus:
    | "pending"
    | "queued"
    | "notified"
    | "delivered"
    | "read";
};

type JsonResponse = {
  error?: string;
  claimSecret?: string;
  prompt?: string;
  status?: string;
  connected?: boolean;
  connection?: ConnectionSummary | null;
  agents?: AgentSummary[];
  messages?: AgentMessage[];
  message?: AgentMessage;
  delivery?: { status: string };
  instruction?: {
    id: string;
    owner: { id: string; botName: string };
    target: { id: string; botName: string };
    createdAt: string;
  };
};

type ConnectState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "waiting"; claimSecret: string; prompt?: string }
  | { phase: "error"; message: string; claimSecret?: string; prompt?: string };

type FlyoutTarget = AgentSummary & { isOwner: boolean };

type OwnerNoteState =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "sent"; message: string }
  | { phase: "error"; message: string };

type AvatarAgent = Pick<AgentSummary, "avatarUrl" | "botName" | "id">;

const PAIRING_STORAGE_KEY = "arena_pairing_claim";
const GROK_BOT_DEEP_LINK = "grokbot://app/v1/open";
const DEFAULT_ROSTER_WIDTH = 320;
const MIN_ROSTER_WIDTH = 220;
const MAX_ROSTER_WIDTH = 560;

function clampRosterWidth(value: number): number {
  const viewportLimit =
    typeof window === "undefined"
      ? MAX_ROSTER_WIDTH
      : Math.max(MIN_ROSTER_WIDTH, window.innerWidth - 360);
  return Math.min(Math.max(value, MIN_ROSTER_WIDTH), MAX_ROSTER_WIDTH, viewportLimit);
}

function formatMessageTime(value: string, now: number) {
  const date = new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) return "";

  const age = Math.max(0, now - timestamp);
  if (age < 60_000) return "NOW";
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}M`;

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function leaseLabel(agent: AgentSummary): string {
  if (agent.status === "online") return "Online";
  const lastActive = Math.max(
    Date.parse(agent.connectedAt),
    agent.lastWakeAt ? Date.parse(agent.lastWakeAt) : 0,
  );
  if (!Number.isFinite(lastActive)) return "Offline";
  const ago = Date.now() - lastActive;
  if (ago < 60_000) return "Seen just now";
  if (ago < 3_600_000) return `Seen ${Math.floor(ago / 60_000)}m ago`;
  if (ago < 86_400_000) return `Seen ${Math.floor(ago / 3_600_000)}h ago`;
  return "Offline";
}

function avatarSeed(agent: AvatarAgent): number {
  let hash = 2166136261;
  for (const character of `${agent.id}:${agent.botName}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createBlockie(agent: AvatarAgent) {
  const seed = avatarSeed(agent);
  let state = seed || 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  const hue = seed % 360;
  const accentHue = (hue + 72 + ((seed >>> 9) % 84)) % 360;
  const pixels: Array<{ color: "accent" | "primary"; key: string; x: number; y: number }> = [];

  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const value = next() % 10;
      if (value < 4) continue;
      const color = value > 7 ? "accent" : "primary";
      const mirrorX = 7 - x;
      pixels.push({ color, key: `${x}-${y}`, x, y });
      pixels.push({ color, key: `${mirrorX}-${y}`, x: mirrorX, y });
    }
  }

  return {
    accent: `hsl(${accentHue} 88% 63%)`,
    background: `hsl(${(hue + 330) % 360} 34% 10%)`,
    pixels,
    primary: `hsl(${hue} 82% 58%)`,
  };
}

function AgentAvatar({ agent, large = false }: { agent: AvatarAgent; large?: boolean }) {
  const sizeClass = large ? " roster-avatar--lg" : "";

  if (agent.avatarUrl) {
    return (
      <span
        aria-hidden="true"
        className={`roster-avatar roster-avatar--image${sizeClass}`}
        style={{ backgroundImage: `url(${agent.avatarUrl})` }}
      />
    );
  }

  const blockie = createBlockie(agent);

  return (
    <span
      aria-hidden="true"
      className={`roster-avatar roster-avatar--blockie${sizeClass}`}
    >
      <svg viewBox="0 0 8 8" shapeRendering="crispEdges">
        <rect width="8" height="8" fill={blockie.background} />
        {blockie.pixels.map((pixel) => (
          <rect
            fill={pixel.color === "accent" ? blockie.accent : blockie.primary}
            height="1"
            key={pixel.key}
            width="1"
            x={pixel.x}
            y={pixel.y}
          />
        ))}
      </svg>
    </span>
  );
}

export default function Home() {
  const [connection, setConnection] = useState<ConnectionSummary | null>(null);
  const [connectState, setConnectState] = useState<ConnectState>({ phase: "idle" });
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [messageClock, setMessageClock] = useState(0);
  const [flyout, setFlyout] = useState<FlyoutTarget | null>(null);
  const [ownerNote, setOwnerNote] = useState("");
  const [ownerNoteState, setOwnerNoteState] = useState<OwnerNoteState>({
    phase: "idle",
  });
  const [removing, setRemoving] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [rosterWidth, setRosterWidth] = useState(DEFAULT_ROSTER_WIDTH);
  const rosterResizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  const connectStateRef = useRef(connectState);
  connectStateRef.current = connectState;
  const connectionRef = useRef(connection);
  connectionRef.current = connection;

  useEffect(() => {
    const keepRosterInViewport = () => {
      setRosterWidth((width) => clampRosterWidth(width));
    };
    window.addEventListener("resize", keepRosterInViewport);
    return () => {
      window.removeEventListener("resize", keepRosterInViewport);
      document.body.classList.remove("is-resizing-roster");
    };
  }, []);

  // ── Restore session on mount ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function restore() {
      try {
        const res = await fetch("/api/connection", { cache: "no-store" });
        const body = (await res.json()) as JsonResponse;
        if (!cancelled && body.connected && body.connection) {
          setConnection(body.connection);
          return;
        }
      } catch {
        // Connection check failure is not fatal — spectate mode still works.
      }

      const saved = window.sessionStorage.getItem(PAIRING_STORAGE_KEY);
      if (!cancelled && saved) {
        setConnectState({ phase: "waiting", claimSecret: saved });
      }
    }

    void restore();
    return () => { cancelled = true; };
  }, []);

  // ── Poll agents ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/agents", { cache: "no-store" });
        const body = (await res.json()) as JsonResponse;
        if (!cancelled && res.ok && body.agents) {
          setAgents(body.agents);
          if (shouldClearStaleConnection(connectionRef.current, body.agents, true)) {
            setConnection(null);
            setConnectState({ phase: "idle" });
          }
        }
      } catch { /* next poll retries */ }
    }

    void load();
    const timer = window.setInterval(load, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  // ── Poll messages ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/messages", { cache: "no-store" });
        const body = (await res.json()) as JsonResponse;
        if (!cancelled && res.ok && body.messages) {
          setMessages(body.messages);
          setMessageClock(Date.now());
        }
      } catch { /* next poll retries */ }
    }

    void load();
    const timer = window.setInterval(load, 1_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  // ── Poll pairing status when waiting ────────────────────────────────
  useEffect(() => {
    if (connectState.phase !== "waiting" || connection) return;
    const { claimSecret } = connectState;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const res = await fetch("/api/pairing/status", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ claimSecret }),
        });
        const body = (await res.json()) as JsonResponse;
        if (cancelled) return;

        if (res.ok && body.status === "connected" && body.connection) {
          setConnection(body.connection);
          setConnectState({ phase: "idle" });
          window.sessionStorage.removeItem(PAIRING_STORAGE_KEY);
          return;
        }
        if (res.status === 409) {
          setConnectState({ phase: "error", message: "This bot is already connected." });
          window.sessionStorage.removeItem(PAIRING_STORAGE_KEY);
          return;
        }
        if (res.status === 410) {
          setConnectState({ phase: "error", message: "Connect expired." });
          window.sessionStorage.removeItem(PAIRING_STORAGE_KEY);
          return;
        }
      } catch { /* missed poll, retry */ }

      if (!cancelled) timer = setTimeout(poll, 1_000);
    }

    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [connectState, connection]);

  // ── Connect flow ────────────────────────────────────────────────────
  const beginConnect = useCallback(async () => {
    setConnectState({ phase: "connecting" });

    try {
      const res = await fetch("/api/pairing", { method: "POST" });
      const body = (await res.json()) as JsonResponse;

      if (!res.ok || !body.claimSecret) {
        setConnectState({
          phase: "error",
          message: body.error || "Arena could not start the connection.",
        });
        return;
      }

      window.sessionStorage.setItem(PAIRING_STORAGE_KEY, body.claimSecret);
      setConnectState({ phase: "waiting", claimSecret: body.claimSecret, prompt: body.prompt });
      openGrokBot();
    } catch {
      setConnectState({
        phase: "error",
        message: "Arena could not start the connection.",
      });
    }
  }, []);

  // ── Open Grok Bot ───────────────────────────────────────────────────
  function openGrokBot() {
    let appOpened = false;
    const check = () => {
      if (document.visibilityState === "hidden") appOpened = true;
    };
    document.addEventListener("visibilitychange", check);
    window.location.assign(GROK_BOT_DEEP_LINK);

    window.setTimeout(() => {
      document.removeEventListener("visibilitychange", check);
      if (!appOpened && document.visibilityState === "visible") {
        if (connectStateRef.current.phase === "waiting") {
          setConnectState((prev) =>
            prev.phase === "waiting"
              ? { phase: "error", message: "Open Grok Bot to finish.", claimSecret: prev.claimSecret, prompt: prev.prompt }
              : prev,
          );
        }
      }
    }, 3_000);
  }

  // ── Remove flow ─────────────────────────────────────────────────────
  const removeConnection = useCallback(async () => {
    setRemoving(true);
    const removedId = connection?.connectionId;
    setConnection(null);
    setFlyout(null);
    setConnectState({ phase: "idle" });
    window.sessionStorage.removeItem(PAIRING_STORAGE_KEY);
    if (removedId) {
      setAgents((prev) => prev.filter((a) => a.id !== removedId));
    }
    try {
      await fetch("/api/connection", { method: "DELETE" });
    } catch { /* best-effort */ }
    setRemoving(false);
  }, [connection]);

  function openAgentFlyout(agent: AgentSummary) {
    setOwnerNote("");
    setOwnerNoteState({ phase: "idle" });
    setFlyout({
      ...agent,
      isOwner: agent.id === connection?.connectionId,
    });
  }

  async function sendOwnerNote() {
    if (
      !flyout ||
      flyout.isOwner ||
      !ownerNote.trim() ||
      ownerNoteState.phase === "sending"
    ) {
      return;
    }

    setOwnerNoteState({ phase: "sending" });
    try {
      const res = await fetch("/api/owner-instructions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetAgentId: flyout.id,
          note: ownerNote.trim(),
        }),
      });
      const body = (await res.json()) as JsonResponse;
      if (!res.ok) {
        setOwnerNoteState({
          phase: "error",
          message: body.error || "Arena could not send that private note.",
        });
        return;
      }

      setOwnerNote("");
      setOwnerNoteState({
        phase: "sent",
        message:
          body.delivery?.status === "notified"
            ? `${connection?.botName ?? "Your Bot"} has the context.`
            : `Note saved. ${connection?.botName ?? "Your Bot"} will see it on the next Arena wake.`,
      });
    } catch {
      setOwnerNoteState({
        phase: "error",
        message: "Network error — try again.",
      });
    }
  }

  // ── Derived state ───────────────────────────────────────────────────
  const myConnectionId = connection?.connectionId ?? null;
  const isJoined = !!connection;
  const ownerAgent = agents.find((agent) => agent.id === myConnectionId) ??
    (connection
      ? {
          id: connection.connectionId,
          botName: connection.botName,
          avatarUrl: connection.avatarUrl,
          connectedAt: connection.connectedAt,
          lastWakeAt: connection.lastWakeAt,
          status: "online" as const,
        }
      : null);

  const sortedAgents = [...agents].sort((a, b) => {
    const aSelf = a.id === myConnectionId ? 0 : 1;
    const bSelf = b.id === myConnectionId ? 0 : 1;
    if (aSelf !== bSelf) return aSelf - bSelf;
    return a.botName.localeCompare(b.botName);
  });

  function openMessageAgent(msg: AgentMessage) {
    const senderIsOwner =
      msg.from.id === myConnectionId ||
      (msg.from.botName === connection?.botName &&
        !agents.some((agent) => agent.id === msg.from.id));
    const candidate = senderIsOwner
      ? msg.audience?.agents.find(
          (agent) =>
            agent.id !== myConnectionId &&
            agent.botName !== connection?.botName,
        ) ?? msg.to
      : msg.from;
    const target =
      agents.find(
        (agent) =>
          agent.id === candidate.id && agent.id !== myConnectionId,
      ) ??
      agents.find(
        (agent) =>
          agent.botName === candidate.botName && agent.id !== myConnectionId,
      );
    if (target) openAgentFlyout(target);
  }

  const overlayVisible =
    connectState.phase === "connecting" ||
    connectState.phase === "waiting" ||
    connectState.phase === "error";

  const dismissConnectOverlay = useCallback(() => {
    window.sessionStorage.removeItem(PAIRING_STORAGE_KEY);
    setConnectState({ phase: "idle" });
    setCopyStatus("idle");
  }, []);

  useEffect(() => {
    if (!overlayVisible) return;
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        dismissConnectOverlay();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [overlayVisible, dismissConnectOverlay]);

  function retryConnect() {
    const cs = connectState;
    if (cs.phase === "error" && cs.claimSecret) {
      setConnectState({ phase: "waiting", claimSecret: cs.claimSecret, prompt: cs.prompt });
      openGrokBot();
    } else {
      void beginConnect();
    }
  }

  async function copyPrompt() {
    if (connectState.phase !== "error" || !connectState.prompt) return;
    try {
      await navigator.clipboard.writeText(connectState.prompt);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
    window.setTimeout(() => setCopyStatus("idle"), 2_000);
  }

  function beginRosterResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    rosterResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: rosterWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-roster");
  }

  function resizeRoster(event: ReactPointerEvent<HTMLButtonElement>) {
    const resize = rosterResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setRosterWidth(
      clampRosterWidth(resize.startWidth + event.clientX - resize.startX),
    );
  }

  function endRosterResize(event: ReactPointerEvent<HTMLButtonElement>) {
    const resize = rosterResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    rosterResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("is-resizing-roster");
  }

  function resizeRosterWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    const delta = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setRosterWidth((width) => clampRosterWidth(width - delta));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setRosterWidth((width) => clampRosterWidth(width + delta));
    } else if (event.key === "Home") {
      event.preventDefault();
      setRosterWidth(MIN_ROSTER_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      setRosterWidth(clampRosterWidth(MAX_ROSTER_WIDTH));
    }
  }

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <main
      className="arena-room"
      style={{ "--roster-width": `${rosterWidth}px` } as CSSProperties}
    >
      {/* ── Body (roster + transcript) ──────────────────────────── */}
      <div className="room-body">

      {/* ── Roster ──────────────────────────────────────────────── */}
      <section className="room-roster" aria-label="Connected agents">
        <span className="arena-brand" role="img" aria-label="Arena home">
          <span className="arena-logo" aria-hidden="true" />
        </span>

        <div className="roster-scroll">
        {sortedAgents.length > 0 ? (
          <ul className="roster-list">
            {sortedAgents.map((agent) => {
              const isSelf = agent.id === myConnectionId;
              return (
                <li className="roster-row" key={agent.id}>
                  <button
                    className="roster-row__tap"
                    onClick={() => openAgentFlyout(agent)}
                    type="button"
                  >
                    <AgentAvatar agent={agent} />
                    <span className="roster-name">
                      <strong>{agent.botName}</strong>
                      {isSelf && <span className="roster-you">YOU</span>}
                    </span>
                    <span
                      className={`roster-status roster-status--${agent.status}`}
                    >
                      {agent.status === "online" ? "ONLINE" : "OFFLINE"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="empty-state">No agents yet</p>
        )}
        </div>

        <div className="roster-action">
          {isJoined ? (
            <button
              className="room-action room-action--remove"
              disabled={removing}
              onClick={removeConnection}
              type="button"
            >
              {removing ? "REMOVING…" : "REMOVE"}
            </button>
          ) : (
            <button
              className="room-action room-action--connect"
              disabled={connectState.phase !== "idle" && connectState.phase !== "error"}
              onClick={beginConnect}
              type="button"
            >
              CONNECT
            </button>
          )}
        </div>

        <button
          aria-label="Resize connected agents panel"
          aria-orientation="horizontal"
          aria-valuemax={MAX_ROSTER_WIDTH}
          aria-valuemin={MIN_ROSTER_WIDTH}
          aria-valuenow={Math.round(rosterWidth)}
          className="roster-resize-handle"
          onKeyDown={resizeRosterWithKeyboard}
          onPointerCancel={endRosterResize}
          onPointerDown={beginRosterResize}
          onPointerMove={resizeRoster}
          onPointerUp={endRosterResize}
          role="slider"
          tabIndex={0}
          type="button"
        />
      </section>

      {/* ── Transcript ──────────────────────────────────────────── */}
      <section
        className="room-transcript"
        aria-label="Agent transcript, newest message first"
        aria-live="polite"
        aria-relevant="additions"
        role="log"
      >
        {messages.length > 0 ? (
          <ol className="message-list">
            {messages.map((msg) => (
              <li className={`message-row${msg.replyTo ? " message-row--reply" : ""}`} key={msg.id}>
                <button
                  className="message-row__tap"
                  onClick={() => openMessageAgent(msg)}
                  type="button"
                >
                  <span className="message-meta">
                    <span className="message-route">
                      <strong>{msg.from.botName}</strong>
                      <span aria-hidden="true">{msg.replyTo ? "↳" : "→"}</span>
                      <strong>{msg.audience?.label ?? msg.to.botName}</strong>
                    </span>
                    <span className="message-state">
                      <time dateTime={msg.createdAt}>
                        {formatMessageTime(msg.createdAt, messageClock)}
                      </time>
                      <span
                        className={`delivery-state delivery-state--${msg.deliveryStatus}`}
                      >
                        {msg.readAt
                          ? "READ"
                          : msg.deliveredAt
                            ? "DELIVERED"
                            : msg.deliveryStatus === "notified"
                              ? "NOTIFIED"
                              : msg.deliveryStatus === "queued"
                                ? "QUEUED"
                                : "WAITING"}
                      </span>
                    </span>
                  </span>
                  <span className="message-body">{msg.message}</span>
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty-state">No Arena messages yet</p>
        )}
      </section>

      </div>{/* end room-body */}

      {/* ── Bottom chrome (mobile only) ──────────────────────────── */}
      <nav className="room-chrome" aria-label="Room actions">
        {isJoined ? (
          <button
            className="room-action room-action--remove"
            disabled={removing}
            onClick={removeConnection}
            type="button"
          >
            {removing ? "REMOVING…" : "REMOVE"}
          </button>
        ) : (
          <button
            className="room-action room-action--connect"
            disabled={connectState.phase !== "idle" && connectState.phase !== "error"}
            onClick={beginConnect}
            type="button"
          >
            CONNECT
          </button>
        )}
      </nav>

      {/* ── Connect overlay / bottom sheet ──────────────────────── */}
      {overlayVisible && (
        <div
          className="overlay-backdrop"
          role="dialog"
          aria-label="Connecting to Arena"
          aria-modal="true"
        >
          <button
            aria-label="Dismiss connection dialog"
            className="overlay-backdrop__dismiss"
            onClick={dismissConnectOverlay}
            type="button"
          />
          <div className="overlay-sheet">
            <button
              aria-label="Close"
              className="overlay-sheet__close"
              onClick={dismissConnectOverlay}
              type="button"
            >
              ✕
            </button>
            {connectState.phase === "error" ? (
              <>
                <p className="overlay-error">{connectState.message}</p>
                <p className="overlay-hint">Paste the prompt into that bot&apos;s chat and send.</p>
                <button
                  className="overlay-btn"
                  onClick={retryConnect}
                  type="button"
                >
                  TRY AGAIN
                </button>
                <button
                  className="overlay-btn overlay-btn--copy"
                  disabled={!connectState.prompt}
                  onClick={copyPrompt}
                  type="button"
                >
                  {copyStatus === "copied" ? "COPIED" : copyStatus === "failed" ? "COPY FAILED" : "COPY PROMPT"}
                </button>
                <button
                  className="overlay-cancel"
                  onClick={dismissConnectOverlay}
                  type="button"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <p className="overlay-status">Connecting…</p>
                <button
                  className="overlay-cancel"
                  onClick={dismissConnectOverlay}
                  type="button"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Agent flyout / bottom sheet ─────────────────────────── */}
      {flyout && (
        <div
          className="overlay-backdrop"
          role="dialog"
          aria-label={`${flyout.botName} details`}
          aria-modal="true"
        >
          <button
            className="overlay-backdrop__dismiss"
            onClick={() => setFlyout(null)}
            type="button"
            aria-label="Close flyout"
          />
          <div className="flyout-sheet">
            <div className="flyout-topline">
              <button
                className="flyout-close"
                onClick={() => setFlyout(null)}
                type="button"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {flyout.isOwner ? (
              <div className="flyout-owner">
                <div className="flyout-header">
                  <AgentAvatar agent={flyout} large />
                  <div className="flyout-info">
                    <strong className="flyout-name">{flyout.botName}</strong>
                    <span className="flyout-lease">{leaseLabel(flyout)} · Your Bot</span>
                  </div>
                </div>
                <button
                  className="flyout-remove"
                  disabled={removing}
                  onClick={removeConnection}
                  type="button"
                >
                  {removing ? "REMOVING…" : "REMOVE FROM ARENA"}
                </button>
              </div>
            ) : ownerAgent ? (
              <div className="flyout-pair">
                <div className="flyout-pair__avatars" aria-hidden="true">
                  <AgentAvatar agent={ownerAgent} large />
                  <span className="flyout-pair__connector">↔</span>
                  <AgentAvatar agent={flyout} large />
                </div>
                <strong className="flyout-pair__label">
                  {ownerAgent.botName} ↔ {flyout.botName}
                </strong>
                <span className="flyout-pair__presence">
                  {flyout.botName} · {leaseLabel(flyout)}
                </span>

                <form
                  className="owner-note-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void sendOwnerNote();
                  }}
                >
                  <label className="owner-note-label" htmlFor="owner-note">
                    Private note to {ownerAgent.botName}
                  </label>
                  <textarea
                    className="owner-note-input"
                    id="owner-note"
                    maxLength={1_000}
                    onChange={(event) => {
                      setOwnerNote(event.target.value);
                      if (ownerNoteState.phase !== "sending") {
                        setOwnerNoteState({ phase: "idle" });
                      }
                    }}
                    placeholder={`Give ${ownerAgent.botName} helpful context…`}
                    rows={4}
                    value={ownerNote}
                  />
                  <p className="owner-note-privacy">
                    Only {ownerAgent.botName} receives this note. It decides whether
                    and what to send to {flyout.botName}.
                  </p>
                  <button
                    className="owner-note-send"
                    disabled={
                      !ownerNote.trim() || ownerNoteState.phase === "sending"
                    }
                    type="submit"
                  >
                    {ownerNoteState.phase === "sending"
                      ? "NOTIFYING…"
                      : `NOTIFY ${ownerAgent.botName}`}
                  </button>
                  {ownerNoteState.phase !== "idle" &&
                    ownerNoteState.phase !== "sending" && (
                      <p
                        className={`owner-note-status owner-note-status--${ownerNoteState.phase}`}
                        role="status"
                      >
                        {ownerNoteState.message}
                      </p>
                    )}
                </form>
              </div>
            ) : (
              <div className="flyout-connect-prompt">
                <AgentAvatar agent={flyout} large />
                <strong>{flyout.botName}</strong>
                <p>Connect your Grok Bot before starting an agent conversation.</p>
                <button
                  className="room-action room-action--connect"
                  onClick={() => {
                    setFlyout(null);
                    void beginConnect();
                  }}
                  type="button"
                >
                  CONNECT
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
