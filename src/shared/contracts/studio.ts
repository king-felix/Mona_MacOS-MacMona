/**
 * Live-studio contracts. These types cross the narrow IPC boundary; the bearer
 * token, base URL, and runtime executable never do.
 */

import type { PendingQuestion, PendingRequestKind, PendingRequestStatus } from "./pending";
import type { FollowUpView, SteerCapabilityView } from "./follow-up";

export type StudioMode = "plan" | "work";

export type StudioConnectionState =
  "not_started" | "connecting" | "connected" | "running" | "reconnecting" | "stopped" | "failed";

export interface StudioConnection {
  state: StudioConnectionState;
  reason: string;
  since: string;
  port: number | null;
  engine: { version: string; commit: string } | null;
  owned: boolean;
  external: boolean;
  /**
   * When the last engine event arrived, and how long the stream has been
   * silent. A quiet stream is not a failure; a *silent* one is, and the screen
   * has to be able to say which it is instead of showing a frozen turn.
   */
  lastEventAt: string | null;
  silentForMs: number | null;
  /** Stored sequences this thread never received, as inclusive ranges. */
  missing: Array<{ from: number; to: number }>;
}

export interface StudioProfileView {
  provider: string;
  exactId: string | null;
  model: string;
  reasoningEffort: string | null;
  permissionPosture: "full_access" | "ask";
  autoApprove: boolean;
  trustMode: boolean;
  allowShell: boolean;
  source: "configured" | "default";
  /** Only present after a real turn reported what actually ran. */
  effective: {
    provider: string;
    model: string;
    permissionPosture: string;
    usedFallback: boolean;
  } | null;
  effectiveTurnId: string | null;
}

export interface StudioCostView {
  observed: boolean;
  costUsd: number;
  costComplete: boolean;
  turns: number;
  /** Plain-language label; never invents a price. */
  label: string;
}

/** R10 file mention: a verified workspace read, never an attachment. */
export interface StudioFilePreview {
  path: string;
  availability: "available" | "binary" | "oversized" | "missing" | "forbidden" | "error";
  content: string | null;
  sizeBytes: number | null;
  truncated: boolean;
  /** bytes/4, explicitly an estimate of this provider's tokenizer. */
  estimatedTokens: number | null;
  note: string;
}

export interface StudioSubmissionView {
  operationKey: string;
  status: string;
  turnId: string | null;
  reconciled: boolean;
  note: string | null;
  submittedAt: string;
}

export interface StudioControls {
  canInterrupt: boolean;
  canPause: boolean;
  canCancelQueued: boolean;
  canStop: boolean;
}

/**
 * One engine ask as the screen sees it. `id` is Mona's own row id; the engine's
 * single-use capability stays in main, so a renderer cannot answer an approval
 * it did not receive from this application.
 */
export interface PendingRequestView {
  id: string;
  kind: PendingRequestKind;
  projectId: string;
  threadId: string;
  turnId: string | null;
  toolName: string | null;
  title: string;
  summary: string | null;
  /** Captured tool input for an approval; null when the engine captured none. */
  input: unknown;
  questions: PendingQuestion[];
  /** Decisions the engine's own payload named. */
  decisions: Array<"allow" | "deny">;
  status: PendingRequestStatus;
  decision: "allow" | "deny" | null;
  decidedBy: string | null;
  /** What the runtime answered when Mona sent the reply, verbatim enough to audit. */
  acknowledgement: string | null;
  note: string | null;
  createdAt: string;
  settledAt: string | null;
  /** True when Mona can send an answer for this row right now. */
  canAnswer: boolean;
  /** Why it cannot be answered, when it cannot. */
  cannotAnswerReason: string | null;
}

/** One answer to one question, in the shape the Runtime accepts. */
export interface PendingAnswerInput {
  questionId: string;
  label: string;
  value: string;
}

export type PendingResponseInput =
  | { kind: "approval"; decision: "allow" | "deny"; remember: boolean }
  | { kind: "user_input"; answers: PendingAnswerInput[] };

export interface StudioPendingResult {
  request: PendingRequestView;
  /** True only when the Runtime accepted the reply (2xx), not when it was sent. */
  acknowledged: boolean;
  /**
   * `answered` means the Runtime accepted the decision; `expired` means the
   * capability was no longer pending (already answered, timed out, or settled
   * by another client) and nothing was sent; `unknown` means the reply may or
   * may not have arrived.
   */
  outcome: "answered" | "expired" | "unknown" | "refused";
  note: string;
  snapshot: StudioSnapshot;
}

export interface StudioSnapshot {
  projectId: string;
  connection: StudioConnection;
  threadId: string | null;
  engineThreadId: string | null;
  activeTurnId: string | null;
  lastMode: StudioMode | null;
  pauseAfterTask: boolean;
  queued: number;
  profile: StudioProfileView;
  cost: StudioCostView;
  submission: StudioSubmissionView | null;
  /** Bounded, user-facing diagnostics (unsupported input, schema drift). */
  diagnostics: string[];
  /**
   * Engine requests waiting on a person, newest first. Empty is a fact; the
   * screen renders nothing rather than a placeholder prompt.
   */
  pendingRequests: PendingRequestView[];
  /**
   * R08. Follow-ups a person explicitly queued. Only `queued` rows can still
   * change; every later status is a delivered or refused fact.
   */
  followUps: FollowUpView[];
  /**
   * R08. Whether a live turn can be steered, as discovered from the pinned
   * engine. When unavailable the reason names the supported after-turn option.
   */
  steering: SteerCapabilityView;
  canSubmit: boolean;
  cannotSubmitReason: string | null;
  controls: StudioControls;
}

export type StudioSubmitOutcome = "accepted" | "outcome_unknown" | "rejected";

export interface StudioSubmitResult {
  outcome: StudioSubmitOutcome;
  operationKey: string;
  turnId: string | null;
  note: string | null;
  guidance: string | null;
  reconciliation: {
    status: string;
    turnId: string | null;
    evidence: string;
    guidance: string | null;
  } | null;
  snapshot: StudioSnapshot;
}

export interface StudioActionResult {
  action: "interrupt_now" | "pause_after_task" | "resume_queue" | "cancel_queued" | "stop_runtime";
  /** The engine turn this action targeted, so a caller never guesses. */
  turnId: string | null;
  note: string;
  confirmed: boolean | null;
  uncertain: boolean;
  stopped: boolean | null;
  survivors: number[];
  rollback: "not_promised";
  snapshot: StudioSnapshot;
}

export interface StudioFollowUpResult {
  /** The row this call touched, or null when no row changed. */
  item: FollowUpView | null;
  /** What happened, in plain words; never a claim the store cannot support. */
  note: string;
  snapshot: StudioSnapshot;
}

export interface StudioReconcileResult {
  status: string;
  turnId: string | null;
  evidence: string;
  guidance: string | null;
  snapshot: StudioSnapshot;
}

export interface StudioPush {
  projectId: string;
  kind: "connection" | "event" | "submission" | "control";
  state: string;
  seq?: number;
  eventKind?: string;
  turnId?: string | null;
}
