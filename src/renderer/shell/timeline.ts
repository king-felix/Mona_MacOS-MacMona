import { isEnginePlumbingKind } from "../../shared/contracts/events";
import type { StoredEventSummary } from "../../shared/contracts/project-bridge";

export type TimelineKind =
  "user" | "assistant" | "reasoning" | "tool" | "status" | "error" | "unknown";

export interface TimelineEntry {
  /** The local thread this card belongs to. */
  threadId: string;
  /** Stable across the streamed and completed frames of one item. */
  key: string;
  kind: TimelineKind;
  title: string;
  body: string;
  status: string | null;
  seq: number;
  timestamp: string;
  /** Envelope turn identity; null when the stored row does not carry one. */
  turnId: string | null;
  /**
   * The item this card belongs to, or null when the stored frames predate item
   * identity. Null is reported as unknown; it is never matched to another item
   * by `kind` alone.
   */
  itemId: string | null;
  /** True while no terminal frame for this item has been seen. */
  streaming: boolean;
  /**
   * True when the item's beginning is older than the events supplied (a page
   * boundary). `itemId` decides whether the beginning can be reloaded.
   */
  partial: boolean;
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

/** The item id a completion payload names, independent of the envelope. */
function payloadItemId(payload: Record<string, unknown> | null): string | null {
  const item = record(payload?.item);
  return firstString(item, ["id"]) || null;
}

/**
 * A stored frame that is plumbing rather than conversation is counted, not
 * printed: the count is reported so nothing is silently dropped.
 */
export interface TimelineProjection {
  entries: TimelineEntry[];
  /** Stored engine events that were plumbing, not conversation. */
  internalActivity: number;
  /** Names of event kinds this build does not project, deduplicated. */
  unprojected: string[];
}

export interface TimelineOptions {
  /**
   * True when the supplied events are the whole stored transcript. When false,
   * an item that begins at the first conversation frame is reported as partial
   * instead of pretending its visible text is its beginning.
   */
  historyComplete?: boolean;
  /**
   * Items whose stored frames were explicitly reloaded (`threadId:itemId`).
   * Their beginning is in hand even though the surrounding transcript is still
   * paged, so they are not partial.
   */
  completeItems?: ReadonlySet<string>;
}

interface OpenItem {
  key: string;
  itemId: string | null;
  kind: string;
  text: string;
  status: string | null;
  /** First frame of the item; kept so the card never reorders when it ends. */
  seq: number;
  timestamp: string;
  turnId: string | null;
  completed: boolean;
  /** The item opened at the conversation boundary of a partial transcript. */
  atBoundary: boolean;
}

type ThreadEntry = Omit<TimelineEntry, "threadId">;
type ThreadProjection = {
  entries: ThreadEntry[];
  internalActivity: number;
  unprojected: string[];
};
type Slot = { type: "entry"; entry: ThreadEntry } | { type: "item"; key: string };

/**
 * Deterministic conversation projection over stored engine events.
 *
 * Identity, not adjacency, binds frames: a delta belongs to its `itemId`, and a
 * completion finalizes that same item, so the streamed and completed card share
 * one key and two items of the same kind in a thread never merge. Sequence
 * numbers are never consulted for loss: `seq` is one global engine counter, and
 * this projection does not infer that a gap means a missing frame. Only frames
 * the engine reported as skipped, recorded by main, are loss.
 *
 * Events that predate item identity (stored before schema v10) are grouped only
 * within one turn and one kind, and their cards carry `itemId: null` — explicit
 * unknown identity rather than a guess.
 */
export function projectTimeline(
  events: StoredEventSummary[],
  options: TimelineOptions = {},
): TimelineProjection {
  const historyComplete = options.historyComplete === true;
  const completeItems = options.completeItems ?? new Set<string>();
  // A project includes multiple native/local threads. Stream accumulation and
  // completion matching must never cross those identities, even if their item
  // kinds or sequence numbers happen to match.
  const threads = new Map<string, StoredEventSummary[]>();
  for (const event of events) {
    const group = threads.get(event.threadId) ?? [];
    group.push(event);
    threads.set(event.threadId, group);
  }
  const entries: TimelineEntry[] = [];
  const unprojected = new Set<string>();
  let internalActivity = 0;
  for (const [threadId, frames] of threads) {
    const projection = projectThreadTimeline(frames, historyComplete, completeItems, threadId);
    entries.push(
      ...projection.entries.map((entry) => ({
        ...entry,
        threadId,
        key: `${threadId}:${entry.key}`,
      })),
    );
    internalActivity += projection.internalActivity;
    for (const kind of projection.unprojected) unprojected.add(kind);
  }
  entries.sort((left, right) => {
    if (left.timestamp === right.timestamp) return left.seq - right.seq;
    return Date.parse(left.timestamp) - Date.parse(right.timestamp);
  });
  return { entries, internalActivity, unprojected: [...unprojected].sort() };
}

function deltaKind(kind: string): TimelineKind {
  return kind === "user_message" ? "user" : kind === "agent_reasoning" ? "reasoning" : "assistant";
}

function itemTitle(kind: string): string {
  if (kind === "user_message") return "You";
  if (kind === "agent_reasoning") return "Engine-reported reasoning";
  return "Engine (streamed)";
}

function projectThreadTimeline(
  events: StoredEventSummary[],
  historyComplete: boolean,
  completeItems: ReadonlySet<string>,
  threadId: string,
): ThreadProjection {
  const entries: ThreadEntry[] = [];
  let internalActivity = 0;
  const unprojected = new Set<string>();
  const seen = new Set<number>();
  const frames: StoredEventSummary[] = [];
  for (const event of events) {
    // Duplicate replays carry the same (thread, seq); the second copy is the
    // same fact, not a second frame.
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    frames.push(event);
  }

  // The conversation boundary of the supplied window: the first frame that is
  // not plumbing. An item that opens here may have begun before the page.
  let boundaryIndex = frames.findIndex((event) => !isEnginePlumbingKind(event.kind));
  if (boundaryIndex < 0) boundaryIndex = frames.length;

  const slots: Slot[] = [];
  const items = new Map<string, OpenItem>();
  const unidentified: string[] = [];
  // React keys must stay unique even when storage holds two terminal frames
  // for the same item id (a replay at a different sequence, for example).
  const usedKeys = new Set<string>();

  const emit = (
    entry: Omit<ThreadEntry, "turnId" | "itemId" | "streaming" | "partial"> & {
      turnId?: string | null;
      itemId?: string | null;
      partial?: boolean;
    },
  ): void => {
    const key = usedKeys.has(entry.key) ? `${entry.key}:${entry.seq}` : entry.key;
    usedKeys.add(key);
    slots.push({
      type: "entry",
      entry: {
        ...entry,
        key,
        turnId: entry.turnId ?? null,
        itemId: entry.itemId ?? null,
        streaming: false,
        partial: entry.partial === true,
      },
    });
  };

  const openItem = (event: StoredEventSummary, kind: string): void => {
    const itemId = event.itemId ?? null;
    // Identified frames bind to their item. An unidentified delta can only be
    // grouped inside its own turn and kind, and is marked unknown for the UI.
    const base =
      itemId !== null ? `item:${itemId}` : `unidentified:${event.turnId ?? "no-turn"}:${kind}`;
    // A delta that arrives after its item's terminal frame is a new stream; it
    // must not overwrite the completed card that still holds the same key.
    const key = items.has(base) ? `${base}:${event.seq}` : base;
    const block: OpenItem = {
      key,
      itemId,
      kind,
      text: "",
      status: "streaming",
      seq: event.seq,
      timestamp: event.timestamp,
      turnId: event.turnId ?? null,
      completed: false,
      atBoundary:
        !historyComplete &&
        !(itemId !== null && completeItems.has(`${threadId}:${itemId}`)) &&
        event === frames[boundaryIndex],
    };
    items.set(key, block);
    usedKeys.add(key);
    if (itemId === null) unidentified.push(key);
    slots.push({ type: "item", key });
  };

  const finalize = (
    key: string,
    update: { kind: string; text: string; status: string; ownText: boolean },
  ): void => {
    const block = items.get(key);
    if (!block) return;
    block.kind = update.kind;
    block.status = update.status;
    // A completion that carries the item's text wins; otherwise the streamed
    // accumulation is what the engine actually delivered.
    block.text = update.text || block.text;
    if (update.ownText) {
      // The completion's own text is the engine's whole item, so a page that
      // starts mid-item is not missing anything for this card: saying it does
      // would be a false claim about complete text.
      block.atBoundary = false;
    }
    block.completed = true;
  };

  const takeUnidentified = (kind: string, turnId: string | null): string | null => {
    const candidates = unidentified.filter((key) => {
      const block = items.get(key);
      if (!block || block.completed) return false;
      if (block.kind !== kind) return false;
      return (block.turnId ?? null) === (turnId ?? null);
    });
    // Only an unambiguous match is allowed. Two open unidentified streams of
    // one kind cannot both be this completion, so none is chosen.
    return candidates.length === 1 ? (candidates[0] ?? null) : null;
  };

  const targetFor = (itemId: string | null, kind: string, turnId: string | null): string | null => {
    if (itemId !== null) {
      const keyed = `item:${itemId}`;
      if (items.has(keyed)) return keyed;
    }
    // Legacy completions name their item only in the payload, while the
    // matching deltas predate identity. Bind them only when exactly one
    // unidentified stream of this kind in this turn can be the source.
    return takeUnidentified(kind, turnId);
  };

  for (const event of frames) {
    const payload = record(event.payload);
    const turnId = event.turnId ?? null;
    if (isEnginePlumbingKind(event.kind)) {
      // Liveness/accounting does not end a message. Flushing here strands a
      // partial card beside the later completed answer.
      internalActivity += 1;
      continue;
    }
    const key = `${event.threadId}-${event.seq}`;

    switch (event.kind) {
      case "thread.started":
        emit({
          key,
          kind: "status",
          title: "Thread opened",
          body: "",
          status: null,
          seq: event.seq,
          timestamp: event.timestamp,
          turnId,
          itemId: event.itemId ?? null,
        });
        break;
      case "turn.started": {
        const posture = payload?.permission_posture;
        emit({
          key,
          kind: "status",
          title: "Turn started",
          body: typeof posture === "string" ? `Permission posture: ${posture}` : "",
          status: typeof posture === "string" ? posture : null,
          seq: event.seq,
          timestamp: event.timestamp,
          turnId,
          itemId: event.itemId ?? null,
        });
        break;
      }
      case "item.delta": {
        const delta = typeof payload?.delta === "string" ? payload.delta : "";
        const kind = typeof payload?.kind === "string" ? payload.kind : "unknown";
        const itemId = event.itemId ?? null;
        const base =
          itemId !== null ? `item:${itemId}` : `unidentified:${turnId ?? "no-turn"}:${kind}`;
        const existing = items.get(base);
        if (existing && !existing.completed) {
          existing.text += delta;
        } else {
          openItem(event, kind);
          const opened = slots[slots.length - 1];
          if (opened?.type === "item") {
            const block = items.get(opened.key);
            if (block) block.text = delta;
          }
        }
        break;
      }
      case "item.completed": {
        const item = record(payload?.item);
        const kind = firstString(item, ["kind"]) || "unknown";
        const status = firstString(item, ["status"]) || "completed";
        const detail = firstString(item, ["detail"]);
        const summary = firstString(item, ["summary"]);
        const itemId = event.itemId ?? payloadItemId(payload);
        const keyed = itemId !== null ? `item:${itemId}` : null;
        const target = targetFor(itemId, kind, turnId);
        const message =
          kind === "agent_message" || kind === "assistant_message" || kind === "user_message";
        if (target !== null) {
          const block = items.get(target);
          finalize(target, {
            kind,
            text: detail || (message ? (block?.text ?? "") : summary),
            status,
            ownText: detail.length > 0 || (!message && summary.length > 0),
          });
          break;
        }
        if (message) {
          const body = detail || summary;
          // An identified completion with no text of its own can mean its
          // deltas are on an older page. Showing an explicitly partial card is
          // better than letting the item vanish; the UI can reload its frames.
          const needsBeginning = body.length === 0 && itemId !== null && !historyComplete;
          if (body || needsBeginning) {
            emit({
              key: keyed ?? key,
              kind: kind === "user_message" ? "user" : "assistant",
              title: kind === "user_message" ? "You" : "Engine",
              body,
              status,
              seq: event.seq,
              timestamp: event.timestamp,
              turnId,
              itemId,
              partial: needsBeginning,
            });
          }
        } else if (kind === "agent_reasoning") {
          emit({
            key: keyed ?? key,
            kind: "reasoning",
            title: "Engine-reported reasoning",
            body: detail || summary,
            status,
            seq: event.seq,
            timestamp: event.timestamp,
            turnId,
            itemId,
          });
        } else if (["tool_call", "command_execution", "file_change", "web_search"].includes(kind)) {
          emit({
            key: keyed ?? key,
            kind: "tool",
            title: kind.replace(/_/g, " "),
            body: detail || summary,
            status,
            seq: event.seq,
            timestamp: event.timestamp,
            turnId,
            itemId,
          });
        } else {
          emit({
            key: keyed ?? key,
            kind: "status",
            title: `Item completed · ${kind}`,
            body: detail || summary,
            status,
            seq: event.seq,
            timestamp: event.timestamp,
            turnId,
            itemId,
          });
        }
        break;
      }
      case "item.failed": {
        const item = record(payload?.item);
        const kind = firstString(item, ["kind"]) || "unknown";
        const itemId = event.itemId ?? payloadItemId(payload);
        const keyed = itemId !== null ? `item:${itemId}` : null;
        const target = targetFor(itemId, kind, turnId);
        const failure = firstString(item, ["detail", "summary", "error"]) || textOf(payload);
        if (target !== null) {
          finalize(target, {
            kind: "error",
            text: failure,
            status: firstString(item, ["status"]) || "failed",
            ownText: failure.length > 0,
          });
          break;
        }
        emit({
          key: keyed ?? key,
          kind: "error",
          title: "Item failed",
          body: failure,
          status: firstString(item, ["status"]) || "failed",
          seq: event.seq,
          timestamp: event.timestamp,
          turnId,
          itemId,
        });
        break;
      }
      case "item.interrupted": {
        // An interruption is not a failure: the item stopped, and whatever it
        // had produced before that is still real. Reporting it as an
        // unrecognized event hid both facts.
        const item = record(payload?.item);
        const kind = firstString(item, ["kind"]) || "unknown";
        const itemId = event.itemId ?? payloadItemId(payload);
        const keyed = itemId !== null ? `item:${itemId}` : null;
        const target = targetFor(itemId, kind, turnId);
        // The item kind is a label for a standalone card, never a replacement
        // for text the engine already streamed.
        const detail = firstString(item, ["detail", "summary"]);
        if (target !== null) {
          finalize(target, {
            kind: "status",
            text: detail,
            status: "interrupted",
            ownText: false,
          });
          break;
        }
        emit({
          key: keyed ?? key,
          kind: "status",
          title: "Item interrupted",
          body: detail || firstString(item, ["kind"]),
          status: "interrupted",
          seq: event.seq,
          timestamp: event.timestamp,
          turnId,
          itemId,
        });
        break;
      }
      case "turn.interrupt_requested":
        emit({
          key,
          kind: "status",
          title: "Interrupt requested",
          body: "The engine was asked to stop this turn; the outcome arrives as a terminal event.",
          status: null,
          seq: event.seq,
          timestamp: event.timestamp,
          turnId,
          itemId: event.itemId ?? null,
        });
        break;
      case "turn.artifacts": {
        // The engine's own account of what the turn touched. Mona already
        // captures it into the change set; the console has to show the same
        // fact instead of calling a kind it uses "unrecognized".
        const workspace = record(payload?.workspace);
        const artifacts = Array.isArray(payload?.artifacts) ? payload.artifacts : [];
        const workspaceState = firstString(workspace, ["state"]);
        const before = firstString(workspace, ["pre_turn_snapshot_id"]);
        const after = firstString(workspace, ["post_turn_snapshot_id"]);
        const omitted = typeof workspace?.omitted === "number" ? workspace.omitted : 0;
        const parts: string[] = [];
        if (workspaceState) parts.push(`workspace ${workspaceState}`);
        parts.push(`${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}`);
        if (before && after) {
          parts.push(before === after ? "snapshot unchanged" : "snapshot changed");
        }
        if (workspace?.truncated === true || omitted > 0) {
          parts.push(`${omitted} omitted`);
        }
        emit({
          key,
          kind: "status",
          title: "Turn artifacts",
          body: parts.join(" · "),
          status: null,
          seq: event.seq,
          timestamp: event.timestamp,
          turnId,
          itemId: event.itemId ?? null,
        });
        break;
      }
      case "turn.completed":
        emit({
          key,
          kind: "status",
          title: "Turn completed",
          body: "",
          status: "completed",
          seq: event.seq,
          timestamp: event.timestamp,
          turnId,
          itemId: event.itemId ?? null,
        });
        break;
      case "turn.failed":
        emit({
          key,
          kind: "error",
          title: "Turn failed",
          body: firstString(payload, ["reason", "error"]) || "The engine reported the turn failed.",
          status: "failed",
          seq: event.seq,
          timestamp: event.timestamp,
          turnId,
          itemId: event.itemId ?? null,
        });
        break;
      case "turn.interrupted":
        emit({
          key,
          kind: "status",
          title: "Turn interrupted",
          body: firstString(payload, ["reason"]) || "",
          status: "interrupted",
          seq: event.seq,
          timestamp: event.timestamp,
          turnId,
          itemId: event.itemId ?? null,
        });
        break;
      case "approval.decided":
      case "user_input.answered":
        emit({
          key,
          kind: "status",
          title: event.kind === "approval.decided" ? "Approval decided" : "Question answered",
          body: firstString(payload, ["decision", "answer", "note"]),
          status: null,
          seq: event.seq,
          timestamp: event.timestamp,
          turnId,
          itemId: event.itemId ?? null,
        });
        break;
      default:
        if (
          event.kind.startsWith("approval.") ||
          event.kind.startsWith("user_input.") ||
          event.kind === "clarification.requested"
        ) {
          emit({
            key,
            kind: "status",
            title: "Engine is waiting for input",
            body: `${event.kind}: ${firstString(payload, ["question", "reason", "prompt"])}`,
            status: "waiting",
            seq: event.seq,
            timestamp: event.timestamp,
            turnId,
            itemId: event.itemId ?? null,
          });
        } else if (event.kind.startsWith("status.") || event.kind.startsWith("thread.")) {
          emit({
            key,
            kind: "status",
            title: event.kind,
            body: firstString(payload, ["note", "reason", "status", "message"]),
            status: firstString(payload, ["status"]) || null,
            seq: event.seq,
            timestamp: event.timestamp,
            turnId,
            itemId: event.itemId ?? null,
          });
        } else {
          unprojected.add(event.kind);
          emit({
            key,
            kind: "unknown",
            title: `Unrecognized event · ${event.kind}`,
            body: "Stored and inspectable; this build does not project it.",
            status: null,
            seq: event.seq,
            timestamp: event.timestamp,
            turnId,
            itemId: event.itemId ?? null,
          });
        }
        break;
    }
  }

  for (const slot of slots) {
    if (slot.type === "entry") {
      entries.push(slot.entry);
      continue;
    }
    const block = items.get(slot.key);
    if (!block) continue;
    if (block.kind === "error") {
      entries.push({
        key: block.key,
        kind: "error",
        title: "Item failed",
        body: block.text,
        status: block.status,
        seq: block.seq,
        timestamp: block.timestamp,
        turnId: block.turnId,
        itemId: block.itemId,
        streaming: !block.completed,
        partial: block.atBoundary,
      });
      continue;
    }
    const conversation =
      block.kind === "user_message" ||
      block.kind === "agent_message" ||
      block.kind === "assistant_message" ||
      block.kind === "agent_reasoning";
    if (!conversation) {
      entries.push({
        key: block.key,
        kind: "status",
        title: block.completed
          ? `Item completed · ${block.kind}`
          : `Item streaming · ${block.kind}`,
        body: block.text,
        status: block.status,
        seq: block.seq,
        timestamp: block.timestamp,
        turnId: block.turnId,
        itemId: block.itemId,
        streaming: !block.completed,
        partial: block.atBoundary,
      });
      continue;
    }
    entries.push({
      key: block.key,
      kind: deltaKind(block.kind),
      title: block.completed
        ? block.kind === "user_message"
          ? "You"
          : block.kind === "agent_reasoning"
            ? "Engine-reported reasoning"
            : "Engine"
        : itemTitle(block.kind),
      body: block.text,
      status: block.status,
      seq: block.seq,
      timestamp: block.timestamp,
      turnId: block.turnId,
      itemId: block.itemId,
      streaming: !block.completed,
      // A partial card is honest about what it does not have. With an item id
      // the UI can reload the beginning; without one it must say it cannot.
      partial: block.atBoundary,
    });
  }

  entries.sort((left, right) => {
    if (left.timestamp === right.timestamp) return left.seq - right.seq;
    return Date.parse(left.timestamp) - Date.parse(right.timestamp);
  });
  return { entries, internalActivity, unprojected: [...unprojected].sort() };
}
