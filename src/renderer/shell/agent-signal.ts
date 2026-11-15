import type { StoredEventSummary } from "../../shared/contracts/project-bridge";
import type { StudioSnapshot } from "../../shared/contracts/studio";

export type AgentPhase =
  "reasoning" | "tool" | "writing" | "waiting" | "human" | "quiet" | "offline" | "idle";
export interface AgentWork {
  phase: AgentPhase;
  label: string;
  detail: string;
}
export interface AgentSignal extends AgentWork {
  animate: boolean;
  contact: string;
}
const TOOL_KINDS = new Set(["tool_call", "command_execution", "file_change", "web_search"]);
export const QUIET_AFTER_MS = 45_000;
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Loaded history is evidence, not a heartbeat. Match both current identities;
 * browsing another conversation must never animate its old work as live work. */
export function projectAgentWork(
  studio: StudioSnapshot | null,
  events: StoredEventSummary[],
): AgentWork {
  const waiting: AgentWork = {
    phase: "waiting",
    label: "Waiting on agent",
    detail: "Turn is open; no current activity has been reported.",
  };
  if (!studio?.activeTurnId) return waiting;
  const open = new Map<string, { kind: string; name: string; seq: number }>();
  const frames = events
    .filter((event) => event.turnId === studio.activeTurnId && event.threadId === studio.threadId)
    .sort((a, b) => a.seq - b.seq);
  for (const event of frames) {
    if (
      event.kind === "turn.completed" ||
      event.kind === "turn.failed" ||
      event.kind === "turn.interrupted"
    ) {
      open.clear();
      continue;
    }
    const payload = record(event.payload);
    const item = record(payload.item);
    const kind = text(item.kind) || text(payload.kind);
    const id = event.itemId || text(item.id) || `unidentified:${kind}`;
    if (["item.completed", "item.failed", "item.interrupted"].includes(event.kind)) {
      open.delete(id);
      // Legacy deltas sometimes omit an item identity. Only join a unique
      // unidentified stream of the same kind, never two independent tools.
      if (kind) open.delete(`unidentified:${kind}`);
    } else if (event.kind === "item.started" || event.kind === "item.delta") {
      const previous = open.get(id);
      open.set(id, {
        kind: kind || previous?.kind || "",
        name: text(item.name) || text(item.tool_name) || previous?.name || "",
        seq: event.seq,
      });
    }
  }
  const latest = [...open.values()].sort((a, b) => b.seq - a.seq)[0];
  if (!latest) return waiting;
  if (latest.kind === "agent_reasoning")
    return {
      phase: "reasoning",
      label: "Reasoning",
      detail: "The engine reports an open reasoning item.",
    };
  if (TOOL_KINDS.has(latest.kind))
    return {
      phase: "tool",
      label:
        latest.kind === "file_change"
          ? "Editing files"
          : latest.kind === "web_search"
            ? "Searching"
            : "Running a tool",
      detail: latest.name
        ? `${latest.name} · awaiting its result`
        : "Tool started; awaiting its result.",
    };
  if (latest.kind === "agent_message" || latest.kind === "assistant_message")
    return {
      phase: "writing",
      label: "Writing a response",
      detail: "The engine reports an open response item.",
    };
  return waiting;
}

/** Local age ticks do not poll the engine or provider. A live animation never
 * claims model progress merely because a turn ID or an old reasoning item exists. */
export function agentSignalAt(
  studio: StudioSnapshot | null,
  work: AgentWork,
  now: number,
): AgentSignal {
  const state = studio?.connection.state ?? "not_started";
  const lastAt = Date.parse(studio?.connection.lastEventAt ?? "");
  const age = Number.isFinite(lastAt) ? Math.max(0, now - lastAt) : null;
  const seconds = age === null ? null : Math.floor(age / 1000);
  const contact =
    seconds === null
      ? "No engine event recorded"
      : `Last engine event ${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`} ago`;
  const asks =
    studio?.pendingRequests.filter((request) =>
      ["pending", "sending", "unknown"].includes(request.status),
    ).length ?? 0;
  if (asks)
    return {
      phase: "human",
      label: "Needs the Human",
      detail: `${asks} engine request${asks === 1 ? "" : "s"} awaiting resolution${state === "reconnecting" ? " · reconnecting" : ""}.`,
      contact,
      animate: false,
    };
  if (!["running", "connected"].includes(state))
    return {
      phase: "offline",
      label:
        state === "connecting"
          ? "Connecting"
          : state === "reconnecting"
            ? "Reconnecting"
            : state === "failed"
              ? "Connection failed"
              : state === "stopped"
                ? "Engine stopped"
                : "Ready to connect",
      detail: studio?.connection.reason ?? "Submit a prompt to start the engine.",
      contact,
      animate: false,
    };
  if (!studio?.activeTurnId)
    return {
      phase: "idle",
      label: studio?.pauseAfterTask ? "Queue paused" : "Ready for your next idea",
      detail: "Engine connected · no active turn",
      contact,
      animate: false,
    };
  const since = Date.parse(studio.connection.since);
  // A newly accepted turn gets a grace period even when the previous thread
  // event is old. No timestamp means progress is unknown, never verified alive.
  const ageAnchor = Math.max(
    Number.isFinite(lastAt) ? lastAt : 0,
    Number.isFinite(since) ? since : 0,
  );
  if (!ageAnchor || now - ageAnchor >= QUIET_AFTER_MS)
    return {
      phase: "quiet",
      label: "Waiting · no recent activity",
      detail:
        "The turn is still open. Progress cannot be confirmed; it may be waiting on the provider or a tool.",
      contact,
      animate: false,
    };
  return { ...work, contact, animate: true };
}
