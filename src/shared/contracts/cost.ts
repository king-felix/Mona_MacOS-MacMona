/**
 * Cost-ledger contracts. These types cross the IPC boundary; the ledger itself
 * lives in the main process and is built only from stored usage, recorded rate
 * cards, and integer arithmetic. Nothing here starts inference.
 */

export type CostState =
  "reported" | "estimated" | "unknown_price" | "missing_usage" | "unallocated";

export const COST_STATES: readonly CostState[] = [
  "reported",
  "estimated",
  "unknown_price",
  "missing_usage",
  "unallocated",
];

/** Whether the known total is fully reported, partly estimated, or not definite. */
export type CostBasis = "reported" | "estimated" | "mixed" | "none";

export type CostAllocation = "turn" | "thread_delta" | "none";

export type TokenSemantics = "inclusive_input" | "exclusive_input" | "unknown";

export type BudgetScope = "session" | "project" | "day";

export const BUDGET_SCOPES: readonly BudgetScope[] = ["session", "project", "day"];

export type BudgetLevel = "ok" | "warn" | "stop";

export interface CostTotalsView {
  turns: number;
  inputTokens: number;
  cachedTokens: number;
  cacheMissTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Known spend: reported plus estimated. Never includes an unknown as zero. */
  costUsd: number;
  costPicoUsd: number;
  /** True only when every observed turn has a definite number and no residual remains. */
  costComplete: boolean;
  costBasis: CostBasis;
  reportedTurns: number;
  estimatedTurns: number;
  unknownTurns: number;
  missingTurns: number;
  unallocatedTurns: number;
  /** Known cost that belongs to earlier turns but cannot be attributed to one. */
  unallocatedUsd: number;
}

export interface CostTurnView {
  id: string;
  threadId: string | null;
  turnId: string | null;
  taskId: string | null;
  provider: string;
  model: string;
  inputTokens: number | null;
  cachedTokens: number | null;
  cacheMissTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  state: CostState;
  allocation: CostAllocation;
  tokenSemantics: TokenSemantics;
  rateCardId: string | null;
  pricingReadAt: string | null;
  capturedAt: string;
  note: string | null;
}

export interface CostRollupView {
  key: string;
  label: string;
  totals: CostTotalsView;
}

export interface CostRateCardView {
  id: string;
  provider: string;
  model: string;
  currency: "USD";
  unit: "per_million_tokens";
  cacheHitPerMillion: number | null;
  cacheMissPerMillion: number | null;
  outputPerMillion: number | null;
  toolCallPerMillion: number | null;
  reasoningInOutput: boolean;
  source: "user_supplied" | "provider_docs";
  sourceRef: string | null;
  revision: string;
  revisionNo: number;
  readAt: string;
}

export interface BudgetView {
  id: string;
  projectId: string;
  scope: BudgetScope;
  limitUsd: number;
  warnUsd: number | null;
  enabled: boolean;
  timeZone: string;
  revision: number;
  updatedAt: string;
}

export interface BudgetEvaluationView {
  budgetId: string;
  scope: BudgetScope;
  level: BudgetLevel;
  knownUsd: number;
  limitUsd: number;
  warnUsd: number | null;
  unknownTurns: number;
  complete: boolean;
  windowStart: string;
  windowEnd: string;
  message: string;
}

export interface DispatchGateView {
  allowed: boolean;
  level: BudgetLevel;
  reasons: string[];
  evaluations: BudgetEvaluationView[];
  /** Mutating work already in flight; it may complete after a stop request. */
  inFlight: { taskRuns: number; activeTurn: boolean };
  reservations: number;
  note: string;
}

export interface CostLedgerView {
  projectId: string;
  generatedAt: string;
  timeZone: string;
  since: string | null;
  until: string | null;
  totals: CostTotalsView;
  byModel: CostRollupView[];
  byTask: CostRollupView[];
  byThread: CostRollupView[];
  byDay: CostRollupView[];
  turns: CostTurnView[];
  rateCards: CostRateCardView[];
  /** One row per route seen in this project: how its cost is known. */
  routes: Array<{
    provider: string;
    model: string;
    state: CostState;
    rateCardId: string | null;
    pricingReadAt: string | null;
  }>;
  pricingFreshness: string | null;
  budgets: BudgetView[];
  evaluations: BudgetEvaluationView[];
  gate: DispatchGateView;
  /** There is no supported balance interface; this is always unavailable. */
  balance: { available: false; note: string };
  notes: string[];
}

export interface CostExport {
  filename: string;
  format: "json" | "csv";
  content: string;
}

export interface CostExportResult {
  saved: boolean;
  path: string | null;
}
