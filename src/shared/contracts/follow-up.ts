import { z } from "zod";
import { ProjectId, ThreadId, Timestamp, TurnId } from "./ids";

/**
 * R08 — an explicitly queued follow-up for after the current turn.
 *
 * A follow-up is a *person's* statement: "run this next". It is stored before
 * anything is dispatched, keeps the conversation it was written for, and is
 * never inferred from a half-written draft. `queued` and `accepted` are
 * different facts: a row only leaves `queued` through a compare-and-set claim,
 * and only reaches `accepted` when the Runtime reported a turn id.
 */
export const FollowUpStatus = z.enum([
  "queued",
  "dispatching",
  "accepted",
  "rejected",
  "canceled",
  "unknown",
  "stale",
]);
export type FollowUpStatus = z.infer<typeof FollowUpStatus>;

export const FollowUpRecord = z.strictObject({
  id: z.string().regex(/^fup_[a-z0-9]{8,64}$/),
  projectId: ProjectId,
  /** Mona's local conversation row. */
  threadId: ThreadId,
  /**
   * The engine thread captured when the person queued it. Dispatch targets this
   * identity and never a thread that merely happens to be current later; if the
   * conversation has been replaced, the row goes `stale` instead.
   */
  engineThreadId: z.string().min(1).max(200),
  mode: z.enum(["plan", "work"]),
  prompt: z.string().min(1).max(100_000),
  status: FollowUpStatus,
  operationKey: z.string().min(8).max(128).nullable(),
  turnId: TurnId.nullable(),
  note: z.string().max(2_000).nullable(),
  queuedAt: Timestamp,
  updatedAt: Timestamp,
});
export type FollowUpRecord = z.infer<typeof FollowUpRecord>;

export interface FollowUpView {
  id: string;
  mode: "plan" | "work";
  prompt: string;
  status: FollowUpStatus;
  /** The conversation this item targets, as a label the screen can show. */
  threadId: string;
  engineThreadId: string;
  turnId: string | null;
  note: string | null;
  queuedAt: string;
  updatedAt: string;
  /** True only while the item is still waiting for a dispatch boundary. */
  editable: boolean;
  /** True when an explicit "send now" is possible in the current state. */
  canDispatchNow: boolean;
}

/**
 * Steering a live turn is a native capability, not a Mona one. This build
 * reports the discovered fact rather than offering a control it cannot honour.
 */
export interface SteerCapabilityView {
  available: boolean;
  /** Present when unavailable: what the person can do instead, named exactly. */
  reason: string;
  /** The route that would be needed, for the audit trail. */
  requiredRoute: string | null;
}

/**
 * The unobtrusive current-activity strip. Every field is derived from stored
 * engine events or from the live connection; nothing is narrated, simulated,
 * or fetched for it.
 */
export interface StudioActivityView {
  /** The turn the strip describes, or null when nothing is active. */
  turnId: string | null;
  mode: "plan" | "work" | null;
  status: "running" | "idle" | "waiting" | "unknown";
  /** First stored event of the described turn, or null when none exists yet. */
  startedAt: string | null;
  lastEventAt: string | null;
  /** The turn's first stored event to the last one, in milliseconds. */
  durationMs: number | null;
  /** Milliseconds since the newest stored event; null with no events at all. */
  idleMs: number | null;
  /** Bounded, ordered tool activity for the described turn. */
  tools: Array<{
    id: string;
    name: string;
    status: string | null;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    summary: string;
  }>;
  /** Tool cards the current window does not hold, so a count is never a lie. */
  toolsNotInWindow: number;
  /** Engine requests waiting on a person, from the Studio's own pending list. */
  needsYou: number;
  needsYouReason: string | null;
  /** Which conversation the strip describes, so a filter is visible. */
  threadId: string | null;
}
