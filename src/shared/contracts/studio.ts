/**
 * Live-studio contracts. These types cross the narrow IPC boundary; the bearer
 * token, base URL, and runtime executable never do.
 */

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
}

export interface StudioProfileView {
  provider: string;
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
  /** A real engine wait Mona cannot answer, described honestly. */
  pendingInput: string | null;
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
  note: string;
  confirmed: boolean | null;
  uncertain: boolean;
  stopped: boolean | null;
  survivors: number[];
  rollback: "not_promised";
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
