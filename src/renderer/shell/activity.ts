import type { StoredEventSummary } from "../../shared/contracts/project-bridge";
import type { StudioSnapshot } from "../../shared/contracts/studio";
import type { StudioActivityView } from "../../shared/contracts/follow-up";

/**
 * R08 — the current-activity strip, derived only from stored engine events.
 *
 * Nothing here narrates. There is no "thinking…" text, no inferred progress, no
 * timer that invents work: the strip reports which turn is open, when its first
 * and last stored frames arrived, and which tools those frames named. A turn
 * with no frames yet is reported as unknown rather than as busy.
 */
const TOOL_KINDS = new Set(["tool_call", "command_execution", "file_change", "web_search"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface ToolAccumulator {
  id: string;
  name: string;
  kind: string;
  startedAt: string | null;
  completedAt: string | null;
  status: string | null;
  sequence: number;
}

function toolIdentity(
  event: StoredEventSummary,
): { id: string; kind: string; name: string } | null {
  const payload = record(event.payload);
  const item = record(payload?.item);
  const kind = stringOf(item?.kind);
  if (!TOOL_KINDS.has(kind)) return null;
  const id = event.itemId ?? stringOf(item?.id) ?? null;
  if (!id) return null;
  const name = stringOf(item?.name) || stringOf(item?.tool_name) || kind;
  return { id, kind, name };
}

export interface ActivityInput {
  studio: StudioSnapshot | null;
  events: StoredEventSummary[];
  /** The conversation currently selected, for the scope label. */
  filterThreadId: string | null;
  /** Epoch milliseconds; injected so a test never depends on the wall clock. */
  now: number;
  /** Bound on tool rows, so a huge turn cannot make the strip long. */
  maxTools?: number;
}

export function projectActivity(input: ActivityInput): StudioActivityView {
  const { studio, events, filterThreadId, now } = input;
  const maxTools = input.maxTools ?? 8;
  const needsYou =
    studio?.pendingRequests.filter((request) => request.status === "pending").length ?? 0;
  const needsYouReason =
    needsYou > 0
      ? `${needsYou} engine request${needsYou === 1 ? "" : "s"} waiting for an answer`
      : null;
  const activeTurnId = studio?.activeTurnId ?? null;
  const activeThreadId = studio?.threadId ?? null;

  if (!studio || activeTurnId === null) {
    // Idle is not the same as disconnected, and neither is the same as "no
    // events". The newest stored frame is reported with its real age; a
    // connection that failed is reported as unknown rather than as idle work.
    const stamps = events
      .map((event) => Date.parse(event.timestamp))
      .filter((value) => Number.isFinite(value));
    const lastEventAt = stamps.length > 0 ? new Date(Math.max(...stamps)).toISOString() : null;
    const failed =
      studio !== null &&
      (studio.connection.state === "failed" || studio.connection.state === "stopped");
    return {
      turnId: null,
      mode: studio?.lastMode ?? null,
      status: failed ? "unknown" : needsYou > 0 ? "waiting" : "idle",
      startedAt: null,
      lastEventAt,
      durationMs: null,
      idleMs: lastEventAt === null ? null : Math.max(0, now - Date.parse(lastEventAt)),
      tools: [],
      toolsNotInWindow: 0,
      needsYou,
      needsYouReason,
      threadId: filterThreadId ?? activeThreadId,
    };
  }

  // Only this turn's frames describe this turn. A frame from an earlier turn in
  // the same window would otherwise inflate the elapsed span.
  const turnEvents = events.filter((event) => event.turnId === activeTurnId);
  const stamps = turnEvents
    .map((event) => Date.parse(event.timestamp))
    .filter((value) => Number.isFinite(value));
  const startedAt = stamps.length > 0 ? new Date(Math.min(...stamps)).toISOString() : null;
  const lastEventAt = stamps.length > 0 ? new Date(Math.max(...stamps)).toISOString() : null;
  const durationMs = stamps.length > 0 ? Math.max(...stamps) - Math.min(...stamps) : null;
  const idleMs = lastEventAt === null ? null : Math.max(0, now - Date.parse(lastEventAt));

  const tools = new Map<string, ToolAccumulator>();
  let orphanCompletions = 0;
  for (const event of turnEvents) {
    const identity = toolIdentity(event);
    if (!identity) continue;
    const existing = tools.get(identity.id);
    if (event.kind === "item.started") {
      if (!existing) {
        tools.set(identity.id, {
          id: identity.id,
          name: identity.name,
          kind: identity.kind,
          startedAt: event.timestamp,
          completedAt: null,
          status: null,
          sequence: event.seq,
        });
      }
      continue;
    }
    if (
      event.kind === "item.completed" ||
      event.kind === "item.failed" ||
      event.kind === "item.interrupted"
    ) {
      const status =
        event.kind === "item.completed"
          ? "completed"
          : event.kind === "item.failed"
            ? "failed"
            : "interrupted";
      if (existing) {
        existing.completedAt = event.timestamp;
        existing.status = status;
      } else {
        // The beginning is older than this window; say it began earlier rather
        // than inventing a start time.
        orphanCompletions += 1;
        tools.set(identity.id, {
          id: identity.id,
          name: identity.name,
          kind: identity.kind,
          startedAt: null,
          completedAt: event.timestamp,
          status,
          sequence: event.seq,
        });
      }
    }
  }

  const ordered = [...tools.values()].sort((a, b) => b.sequence - a.sequence);
  const shown = ordered.slice(0, maxTools);
  const hidden = ordered.length - shown.length;

  return {
    turnId: activeTurnId,
    mode: studio.lastMode,
    // A pending ask outranks "running": the engine is blocked on a person.
    status: needsYou > 0 ? "waiting" : "running",
    startedAt,
    lastEventAt,
    durationMs,
    idleMs,
    tools: shown.map((tool) => ({
      id: tool.id,
      name: tool.name,
      status: tool.status,
      startedAt: tool.startedAt,
      completedAt: tool.completedAt,
      durationMs:
        tool.startedAt !== null && tool.completedAt !== null
          ? Math.max(0, Date.parse(tool.completedAt) - Date.parse(tool.startedAt))
          : null,
      summary:
        tool.startedAt === null
          ? `${tool.name} began before the loaded events`
          : tool.completedAt === null
            ? `${tool.name} running`
            : `${tool.name} ${tool.status ?? "ended"}`,
    })),
    toolsNotInWindow: hidden + orphanCompletions,
    needsYou,
    needsYouReason,
    threadId: filterThreadId ?? activeThreadId,
  };
}
