import type { EventEnvelope } from "../../shared/contracts";
import { AdapterError } from "./errors";
import { isKnownEventKind } from "../../shared/contracts/events";

export interface ProjectedMessage {
  itemId: string;
  kind: string;
  text: string;
  status: string;
}

export interface ProjectedTool {
  itemId: string;
  kind: string;
  summary: string;
  status: string;
}

export interface ProjectedState {
  threadId: string;
  lastSeq: number;
  status: "new" | "connected" | "running" | "completed" | "failed" | "interrupted";
  messages: ProjectedMessage[];
  tools: ProjectedTool[];
  unknownEventKinds: string[];
  permissionPosture: string | null;
}

function payloadOf(event: EventEnvelope): Record<string, unknown> {
  return event.payload !== null && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)
    : {};
}

function itemOf(event: EventEnvelope): Record<string, unknown> | null {
  const item = payloadOf(event).item;
  return item !== null && typeof item === "object" ? (item as Record<string, unknown>) : null;
}

/**
 * Deterministic projection of durable events. Replay is idempotent: an event at
 * or below the accepted cursor is ignored, so reconnecting never duplicates
 * display state or re-executes tool work.
 */
export class EventProjector {
  private lastSeq = -1;
  private status: ProjectedState["status"] = "new";
  private readonly messages = new Map<string, ProjectedMessage>();
  private readonly tools = new Map<string, ProjectedTool>();
  private readonly unknownKinds = new Set<string>();
  private permissionPosture: string | null = null;

  constructor(private readonly threadId: string) {}

  apply(event: EventEnvelope): boolean {
    if (event.thread_id !== this.threadId) {
      throw new AdapterError(
        "WRONG_THREAD",
        `event for ${event.thread_id} cannot mutate ${this.threadId}`,
      );
    }
    if (event.kind === "stream.progress") return false;
    if (event.seq <= this.lastSeq) return false;
    this.lastSeq = event.seq;

    const payload = payloadOf(event);
    const itemId = event.item_id ?? null;
    switch (event.kind) {
      case "thread.started":
        this.status = "connected";
        break;
      case "turn.started": {
        this.status = "running";
        const turn = payload.turn as Record<string, unknown> | undefined;
        const posture = payload.permission_posture ?? turn?.permission_posture;
        if (typeof posture === "string" && posture.length > 0) this.permissionPosture = posture;
        break;
      }
      case "item.delta": {
        if (!itemId) break;
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        const existing = this.messages.get(itemId);
        if (existing) existing.text += delta;
        else {
          this.messages.set(itemId, {
            itemId,
            kind: typeof payload.kind === "string" ? payload.kind : "unknown",
            text: delta,
            status: "streaming",
          });
        }
        break;
      }
      case "item.completed": {
        const item = itemOf(event);
        if (!item) break;
        const id = typeof item.id === "string" ? item.id : (itemId ?? `item_${event.seq}`);
        const kind = typeof item.kind === "string" ? item.kind : "unknown";
        const text =
          typeof item.detail === "string"
            ? item.detail
            : typeof item.summary === "string"
              ? item.summary
              : "";
        if (kind === "agent_message" || kind === "user_message" || kind === "agent_reasoning") {
          const existing = this.messages.get(id);
          this.messages.set(id, {
            itemId: id,
            kind,
            text: text || existing?.text || "",
            status: typeof item.status === "string" ? item.status : "completed",
          });
        } else if (["tool_call", "command_execution", "file_change"].includes(kind)) {
          this.tools.set(id, {
            itemId: id,
            kind,
            summary: typeof item.summary === "string" ? item.summary : "",
            status: typeof item.status === "string" ? item.status : "completed",
          });
        }
        break;
      }
      case "turn.completed":
        this.status = "completed";
        break;
      case "turn.failed":
        this.status = "failed";
        break;
      case "turn.interrupted":
        this.status = "interrupted";
        break;
      case "thread.permissions_changed":
        if (typeof payload.to === "string") this.permissionPosture = payload.to;
        break;
      default:
        if (!isKnownEventKind(event.kind)) this.unknownKinds.add(event.kind);
        break;
    }
    return true;
  }

  get cursor(): number {
    return this.lastSeq;
  }

  snapshot(): ProjectedState {
    return {
      threadId: this.threadId,
      lastSeq: this.lastSeq,
      status: this.status,
      messages: [...this.messages.values()].map((message) => ({ ...message })),
      tools: [...this.tools.values()].map((tool) => ({ ...tool })),
      unknownEventKinds: [...this.unknownKinds].sort(),
      permissionPosture: this.permissionPosture,
    };
  }
}
