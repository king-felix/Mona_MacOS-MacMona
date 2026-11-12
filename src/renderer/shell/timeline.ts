import type { StoredEventSummary } from "../../shared/contracts/project-bridge";

export type TimelineKind =
  "user" | "assistant" | "reasoning" | "tool" | "status" | "error" | "unknown";

export interface TimelineEntry {
  key: string;
  kind: TimelineKind;
  title: string;
  body: string;
  status: string | null;
  seq: number;
  timestamp: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function firstString(source: Record<string, unknown> | null, keys: string[]): string {
  if (!source) return "";
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

/**
 * Engine event kinds that carry plumbing rather than conversation. They stay
 * stored and inspectable, but a timeline flooded with them hides the work. The
 * count is reported so nothing is silently dropped.
 */
const INTERNAL_ACTIVITY = new Set([
  "item.started",
  "turn.lifecycle",
  "turn.workspace_snapshot",
  "model.tools.snapshot",
  "turn.provider_request",
  "turn.usage",
  "operation.activity_started",
  "operation.activity_completed",
]);

export interface TimelineProjection {
  entries: TimelineEntry[];
  /** Stored engine events that were plumbing, not conversation. */
  internalActivity: number;
  /** Names of event kinds this build does not project, deduplicated. */
  unprojected: string[];
}

/**
 * Deterministic conversation projection over stored engine events. Deltas are
 * merged into their completed item; duplicate sequences are ignored; unknown
 * kinds stay visible instead of vanishing. No text is invented here.
 */
export function projectTimeline(events: StoredEventSummary[]): TimelineProjection {
  const entries: TimelineEntry[] = [];
  let internalActivity = 0;
  const unprojected = new Set<string>();
  let openDelta: { kind: string; text: string; seq: number; timestamp: string } | null = null;
  const seen = new Set<string>();
  let emittedReasoning = 0;

  const deltaKind = (kind: string): TimelineKind =>
    kind === "user_message" ? "user" : kind === "agent_reasoning" ? "reasoning" : "assistant";

  const flushDelta = (): void => {
    if (!openDelta) return;
    entries.push({
      key: `delta-${openDelta.seq}`,
      kind: deltaKind(openDelta.kind),
      title:
        openDelta.kind === "user_message"
          ? "You"
          : openDelta.kind === "agent_reasoning"
            ? "Engine-reported reasoning"
            : "Engine (streamed)",
      body: openDelta.text,
      status: "streaming",
      seq: openDelta.seq,
      timestamp: openDelta.timestamp,
    });
    openDelta = null;
  };

  const takeDelta = (kinds: string[]): typeof openDelta => {
    if (openDelta && kinds.includes(openDelta.kind)) {
      const taken = openDelta;
      openDelta = null;
      return taken;
    }
    return null;
  };

  for (const event of events) {
    const dedupeKey = `${event.threadId}:${event.seq}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const payload = record(event.payload);
    const key = `${event.threadId}-${event.seq}`;
    if (INTERNAL_ACTIVITY.has(event.kind)) {
      if (event.kind !== "item.started") flushDelta();
      internalActivity += 1;
      continue;
    }
    if (event.kind !== "item.delta" && event.kind !== "item.completed") flushDelta();

    switch (event.kind) {
      case "thread.started":
        entries.push({
          key,
          kind: "status",
          title: "Thread opened",
          body: "",
          status: null,
          seq: event.seq,
          timestamp: event.timestamp,
        });
        break;
      case "turn.started": {
        const posture = payload?.permission_posture;
        entries.push({
          key,
          kind: "status",
          title: "Turn started",
          body: typeof posture === "string" ? `Permission posture: ${posture}` : "",
          status: typeof posture === "string" ? posture : null,
          seq: event.seq,
          timestamp: event.timestamp,
        });
        break;
      }
      case "item.delta": {
        const delta = typeof payload?.delta === "string" ? payload.delta : "";
        const kind = typeof payload?.kind === "string" ? payload.kind : "unknown";
        if (!openDelta) {
          openDelta = { kind, text: delta, seq: event.seq, timestamp: event.timestamp };
        } else if (openDelta.kind === kind) {
          openDelta.text += delta;
        } else {
          flushDelta();
          openDelta = { kind, text: delta, seq: event.seq, timestamp: event.timestamp };
        }
        break;
      }
      case "item.completed": {
        const item = record(payload?.item);
        const kind = firstString(item, ["kind"]) || "unknown";
        const status = firstString(item, ["status"]) || "completed";
        const detail = firstString(item, ["detail"]);
        const summary = firstString(item, ["summary"]);
        const messageKinds =
          kind === "user_message"
            ? ["user_message"]
            : kind === "agent_reasoning"
              ? ["agent_reasoning"]
              : ["agent_message", "assistant_message", "unknown"];
        const streamed = takeDelta(messageKinds);
        if (!streamed) flushDelta();
        if (kind === "agent_message" || kind === "assistant_message" || kind === "user_message") {
          const body = detail || streamed?.text || summary;
          if (body) {
            entries.push({
              key,
              kind: kind === "user_message" ? "user" : "assistant",
              title: kind === "user_message" ? "You" : "Engine",
              body,
              status,
              seq: streamed?.seq ?? event.seq,
              timestamp: streamed?.timestamp ?? event.timestamp,
            });
          }
        } else if (kind === "agent_reasoning") {
          emittedReasoning += 1;
          entries.push({
            key,
            kind: "reasoning",
            title: `Engine-reported reasoning ${emittedReasoning}`,
            body: detail || streamed?.text || summary,
            status,
            seq: streamed?.seq ?? event.seq,
            timestamp: streamed?.timestamp ?? event.timestamp,
          });
        } else if (["tool_call", "command_execution", "file_change", "web_search"].includes(kind)) {
          entries.push({
            key,
            kind: "tool",
            title: kind.replace(/_/g, " "),
            body: detail || summary,
            status,
            seq: event.seq,
            timestamp: event.timestamp,
          });
        } else {
          entries.push({
            key,
            kind: "status",
            title: `Item completed · ${kind}`,
            body: detail || summary,
            status,
            seq: event.seq,
            timestamp: event.timestamp,
          });
        }
        break;
      }
      case "item.failed": {
        const item = record(payload?.item);
        entries.push({
          key,
          kind: "error",
          title: "Item failed",
          body: firstString(item, ["detail", "summary", "error"]) || textOf(payload),
          status: firstString(item, ["status"]) || "failed",
          seq: event.seq,
          timestamp: event.timestamp,
        });
        break;
      }
      case "turn.completed":
        entries.push({
          key,
          kind: "status",
          title: "Turn completed",
          body: "",
          status: "completed",
          seq: event.seq,
          timestamp: event.timestamp,
        });
        break;
      case "turn.failed":
        entries.push({
          key,
          kind: "error",
          title: "Turn failed",
          body: firstString(payload, ["reason", "error"]) || "The engine reported the turn failed.",
          status: "failed",
          seq: event.seq,
          timestamp: event.timestamp,
        });
        break;
      case "turn.interrupted":
        entries.push({
          key,
          kind: "status",
          title: "Turn interrupted",
          body: firstString(payload, ["reason"]) || "",
          status: "interrupted",
          seq: event.seq,
          timestamp: event.timestamp,
        });
        break;
      case "approval.decided":
      case "user_input.answered":
        entries.push({
          key,
          kind: "status",
          title: event.kind === "approval.decided" ? "Approval decided" : "Question answered",
          body: firstString(payload, ["decision", "answer", "note"]),
          status: null,
          seq: event.seq,
          timestamp: event.timestamp,
        });
        break;
      default:
        if (
          event.kind.startsWith("approval.") ||
          event.kind.startsWith("user_input.") ||
          event.kind === "clarification.requested"
        ) {
          entries.push({
            key,
            kind: "status",
            title: "Engine is waiting for input",
            body: `${event.kind}: ${firstString(payload, ["question", "reason", "prompt"])}`,
            status: "waiting",
            seq: event.seq,
            timestamp: event.timestamp,
          });
        } else if (event.kind.startsWith("status.") || event.kind.startsWith("thread.")) {
          entries.push({
            key,
            kind: "status",
            title: event.kind,
            body: firstString(payload, ["note", "reason", "status", "message"]),
            status: firstString(payload, ["status"]) || null,
            seq: event.seq,
            timestamp: event.timestamp,
          });
        } else {
          unprojected.add(event.kind);
          entries.push({
            key,
            kind: "unknown",
            title: `Unrecognized event · ${event.kind}`,
            body: "Stored and inspectable; this build does not project it.",
            status: null,
            seq: event.seq,
            timestamp: event.timestamp,
          });
        }
    }
  }

  // A delta with no completion still happened; show it as an unfinished stream.
  flushDelta();

  entries.sort((left, right) => {
    if (left.timestamp === right.timestamp) return left.seq - right.seq;
    return Date.parse(left.timestamp) - Date.parse(right.timestamp);
  });
  return { entries, internalActivity, unprojected: [...unprojected].sort() };
}
