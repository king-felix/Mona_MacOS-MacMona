import type { UsageSummary } from "../state/store";
import type { StudioUsageScopeView, UsageScopeState } from "../../shared/contracts/usage-hud";

/**
 * R09 — turn a stored usage summary into one honest scope row.
 *
 * The rules this encodes, in order of importance:
 *
 *  - Zero is a number. "No usage recorded", "waiting for usage", "unpriced" and
 *    "at least $X" are four different facts and none of them is `$0.00`.
 *  - Cached input is never counted twice. When the engine reports an inclusive
 *    input count, the displayed input is `input - cached`; when it reports
 *    exclusive counts, both stand alone. When rows disagree, no subtraction is
 *    invented.
 *  - A partial total says how many turns it cannot price.
 */
export interface UsageScopeInput {
  scope: "turn" | "thread" | "project";
  summary: UsageSummary & { semantics: string[] };
  /** True while the turn this scope describes is still running. */
  active?: boolean;
}

function thousands(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function dollars(value: number): string {
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

export function usageScopeState(input: UsageScopeInput): UsageScopeState {
  const { summary } = input;
  if (summary.turns === 0)
    return input.active === true && input.scope === "turn" ? "waiting" : "empty";
  const priced = summary.reportedTurns + summary.estimatedTurns;
  if (summary.costComplete) return "complete";
  if (priced > 0) return "partial";
  return "unpriced";
}

export function projectUsageScope(input: UsageScopeInput): StudioUsageScopeView {
  const { summary } = input;
  const state = usageScopeState(input);
  const semantics = summary.semantics.length === 0 ? "unknown" : summary.semantics[0];
  const tokenSemantics =
    semantics === "inclusive_input" || semantics === "exclusive_input"
      ? semantics
      : semantics === "mixed"
        ? "mixed"
        : "unknown";

  if (summary.turns === 0) {
    return {
      scope: input.scope,
      turns: 0,
      state,
      costUsd: null,
      costComplete: false,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      tokenSemantics,
      label: state === "waiting" ? "Waiting for usage" : "No usage recorded",
      note:
        state === "waiting"
          ? "This turn has not reported usage yet. Tokens appear when the engine receipts them."
          : "No usage receipt exists for this scope.",
    };
  }

  const priced = summary.reportedTurns + summary.estimatedTurns;
  const unpriced = summary.unknownTurns + summary.missingTurns + summary.unallocatedTurns;
  const costUsd = priced > 0 ? summary.costUsd : null;
  const cached = summary.cachedTokens > 0 ? summary.cachedTokens : null;
  // Inclusive input already contains the cached prefix; subtracting is what
  // keeps "input" and "cached input" from adding up to more than the provider
  // actually charged for.
  const uncachedInput =
    tokenSemantics === "inclusive_input"
      ? Math.max(0, summary.inputTokens - summary.cachedTokens)
      : summary.inputTokens;
  const inputTokens = summary.turns > 0 && summary.inputTokens > 0 ? uncachedInput : null;
  const outputTokens = summary.outputTokens > 0 ? summary.outputTokens : null;
  const reasoningTokens = summary.reasoningTokens > 0 ? summary.reasoningTokens : null;

  const parts: string[] = [];
  if (costUsd !== null) parts.push(dollars(costUsd));
  if (inputTokens !== null) {
    parts.push(
      `${thousands(inputTokens)} in${cached !== null ? ` (${thousands(cached)} cached)` : ""}`,
    );
  }
  if (outputTokens !== null) parts.push(`${thousands(outputTokens)} out`);

  const note =
    state === "complete"
      ? null
      : state === "partial"
        ? `${unpriced} of ${summary.turns} turn${summary.turns === 1 ? "" : "s"} cannot be priced; the total is a lower bound.`
        : "Usage was recorded but no price is known for this route.";

  const label =
    state === "unpriced"
      ? `${parts.length > 0 ? `${parts.join(" · ")} · ` : ""}unpriced`
      : `${parts.join(" · ")}${state === "partial" ? " · partial" : ""}`;

  return {
    scope: input.scope,
    turns: summary.turns,
    state,
    costUsd,
    costComplete: summary.costComplete,
    inputTokens,
    cachedInputTokens: cached,
    outputTokens,
    reasoningTokens,
    tokenSemantics,
    label,
    note,
  };
}
