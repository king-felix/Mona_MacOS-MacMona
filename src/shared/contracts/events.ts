import { z } from "zod";
import { ThreadId, Timestamp, TurnId } from "./ids";

/**
 * The durable event envelope. Known fields are validated; extra upstream fields
 * are preserved rather than stripped. Unknown event names are legal: the
 * adapter keeps them inspectable instead of crashing the client.
 */
export const EventEnvelope = z.looseObject({
  schema_version: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
  previous_seq: z.number().int().nonnegative().nullable().optional(),
  event: z.string().min(1),
  kind: z.string().min(1),
  thread_id: ThreadId,
  turn_id: TurnId.nullable().optional(),
  item_id: z.string().min(1).nullable().optional(),
  timestamp: Timestamp,
  payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** Events Mona projects today. Anything absent stays available for diagnostics. */
export const KNOWN_EVENT_KINDS = [
  "stream.progress",
  "stream.end",
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  /** The engine asked the turn to stop; the outcome arrives as a terminal event. */
  "turn.interrupt_requested",
  "turn.artifacts",
  "turn.workspace_snapshot",
  "item.started",
  "item.delta",
  "item.completed",
  "item.failed",
  /** A streamed item stopped mid-flight; it is not the same as a failure. */
  "item.interrupted",
  "tool_call.resolved",
  "approval.decided",
  "user_input.answered",
] as const;
export type KnownEventKind = (typeof KNOWN_EVENT_KINDS)[number];

export function isKnownEventKind(kind: string): kind is KnownEventKind {
  return (KNOWN_EVENT_KINDS as readonly string[]).includes(kind);
}

/**
 * Engine frames that carry plumbing rather than conversation: liveness pings,
 * state snapshots, usage accounting, and per-operation activity marks.
 *
 * They stay stored and inspectable, but a console flooded with them hides the
 * work, so the Studio counts them instead of printing a card for each. The list
 * is shared because both ends need the same answer: the timeline must not show
 * them, and the session diagnostics must not report a frame this build knows as
 * "not projected" — that is what made `operation.heartbeat` look like drift and
 * let it evict real diagnostics from the bounded ring.
 *
 * A kind absent from BOTH lists is genuinely unseen by this build and stays
 * visible, which is the honesty rule this list must not erode.
 */
export const ENGINE_PLUMBING_KINDS = [
  "item.started",
  "turn.lifecycle",
  "turn.workspace_snapshot",
  "model.tools.snapshot",
  "turn.provider_request",
  "turn.usage",
  "operation.activity_started",
  "operation.activity_completed",
  /** Liveness only: `{ observed_at }` and nothing else, sent during long work. */
  "operation.heartbeat",
] as const;

export function isEnginePlumbingKind(kind: string): boolean {
  return (ENGINE_PLUMBING_KINDS as readonly string[]).includes(kind);
}

/**
 * The item identity a frame belongs to, using the envelope's field first and
 * the payload's own `item.id` second. An engine that omits `item_id` on a
 * completion still names the item inside the payload; a frame that names
 * neither stays unknown rather than being matched to an item by kind.
 */
export function eventItemId(event: { item_id?: string | null; payload: unknown }): string | null {
  if (typeof event.item_id === "string" && event.item_id.length > 0) return event.item_id;
  const payload = event.payload;
  if (payload === null || typeof payload !== "object") return null;
  const item = (payload as Record<string, unknown>).item;
  if (item === null || typeof item !== "object") return null;
  const id = (item as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
