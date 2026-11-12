import type { TaskState } from "../../shared/contracts/board";

/**
 * The task state machine from spec §8.2, in one place so the store, the board,
 * and tests cannot drift. A transition absent here is refused by the store even
 * if a caller asks for it directly.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  pending: ["running", "skipped"],
  running: ["verifying", "blocked", "interrupted"],
  verifying: ["completed", "running", "blocked", "interrupted"],
  // completed → verifying is allowed only by the reconciliation path, never by
  // a generic status write, so a human decision cannot be quietly undone.
  completed: ["verifying"],
  blocked: ["running"],
  interrupted: ["running"],
  skipped: [],
};

export type TransitionActor = "human" | "mona_queue" | "native_workflow" | "reconciler";

export interface TransitionRequest {
  from: TaskState;
  to: TaskState;
  actor: TransitionActor;
  reason?: string | null;
}

export interface TransitionDecision {
  allowed: boolean;
  reason: string | null;
}

/**
 * Central policy beyond "is the edge in the graph". This is the mechanism that
 * keeps completion evidence-backed and stale verification visible.
 */
export function decideTransition(request: TransitionRequest): TransitionDecision {
  const { from, to, actor, reason } = request;
  if (from === to) return { allowed: false, reason: `task is already ${from}` };
  if (!TASK_TRANSITIONS[from].includes(to)) {
    return { allowed: false, reason: `${from} cannot become ${to}` };
  }
  if (to === "completed") {
    return {
      allowed: false,
      reason: "completion requires the evidence gate; use completeTask, not a status write",
    };
  }
  if (from === "completed" && actor !== "reconciler") {
    return {
      allowed: false,
      reason: "completed verification can only be reopened by reconciliation",
    };
  }
  if (to === "skipped" && actor !== "human") {
    return { allowed: false, reason: "skipping a task requires an explicit human scope decision" };
  }
  if (to === "skipped" && !reason?.trim()) {
    return { allowed: false, reason: "skipping a task requires a recorded reason" };
  }
  if (from === "blocked" && actor === "reconciler") {
    return {
      allowed: false,
      reason: "a blocked task resumes only on material new evidence or a human decision",
    };
  }
  return { allowed: true, reason: null };
}

export function isTerminal(state: TaskState): boolean {
  return state === "completed" || state === "skipped";
}

export function isRunning(state: TaskState): boolean {
  return state === "running";
}

/** States whose prompts may be edited without invalidating a run. */
export const EDITABLE_STATES: readonly TaskState[] = [
  "pending",
  "blocked",
  "interrupted",
  "skipped",
];
