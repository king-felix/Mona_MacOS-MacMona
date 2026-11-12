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
  "item.started",
  "item.delta",
  "item.completed",
  "item.failed",
  "tool_call.resolved",
  "approval.decided",
  "user_input.answered",
] as const;
export type KnownEventKind = (typeof KNOWN_EVENT_KINDS)[number];

export function isKnownEventKind(kind: string): kind is KnownEventKind {
  return (KNOWN_EVENT_KINDS as readonly string[]).includes(kind);
}
