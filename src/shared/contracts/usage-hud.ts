import type { BudgetEvaluationView } from "./cost";

/**
 * R09 — the compact usage HUD.
 *
 * Three scopes, each labelled: the current turn, the conversation it belongs
 * to, and the project total. Every number here was read from a stored usage
 * receipt; nothing is polled, estimated live, or refreshed on a timer. Tokens
 * appear only when the engine receipts them, which is why "waiting" is a state
 * of its own rather than a zero.
 */
export type UsageScopeState = "waiting" | "complete" | "partial" | "unpriced" | "empty";

export interface StudioUsageScopeView {
  scope: "turn" | "thread" | "project";
  turns: number;
  state: UsageScopeState;
  /** Known spend. Null when nothing was priced — never 0 for "unknown". */
  costUsd: number | null;
  costComplete: boolean;
  /**
   * Input tokens *excluding* the cached prefix when the engine reports an
   * inclusive input count, so cached input is never counted twice.
   */
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  /** How the native numbers relate; "mixed" means rows disagreed. */
  tokenSemantics: "inclusive_input" | "exclusive_input" | "unknown" | "mixed";
  label: string;
  note: string | null;
}

export interface StudioUsageView {
  turn: StudioUsageScopeView;
  thread: StudioUsageScopeView;
  project: StudioUsageScopeView;
  /** Enabled budgets and their evaluation, for the popover. */
  budgets: BudgetEvaluationView[];
  provenance: {
    readAt: string;
    source: "stored_usage";
    note: string;
  };
}

/** The shape a screen shows before any usage was read (and in embedders). */
export function emptyStudioUsageView(): StudioUsageView {
  const scope = (name: StudioUsageScopeView["scope"]): StudioUsageScopeView => ({
    scope: name,
    turns: 0,
    state: "empty",
    costUsd: null,
    costComplete: false,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    tokenSemantics: "unknown",
    label: "No usage recorded",
    note: "No usage receipt exists for this scope.",
  });
  return {
    turn: scope("turn"),
    thread: scope("thread"),
    project: scope("project"),
    budgets: [],
    provenance: {
      readAt: "",
      source: "stored_usage",
      note: "No usage was read for this view.",
    },
  };
}
