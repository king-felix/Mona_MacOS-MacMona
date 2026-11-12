import type {
  BudgetEvaluationView,
  BudgetScope,
  BudgetView,
  CostAllocation,
  CostBasis,
  CostExport,
  CostLedgerView,
  CostRateCardView,
  CostRollupView,
  CostState,
  CostTotalsView,
  CostTurnView,
  DispatchGateView,
} from "../../shared/contracts/cost";
import type { ProjectId } from "../../shared/contracts/ids";
import type { StateStore, StoredBudget, StoredRateCard, UsageRecord } from "../state/store";
import { StateError } from "../state/errors";
import {
  civilDateKey,
  civilDayRange,
  defaultTimeZone,
  estimateCostPico,
  isValidTimeZone,
  picoToUsd,
  ratePerMillionToPicoPerToken,
  usdToPico,
  type RateComponents,
  type UsageBuckets,
} from "./cost-math";

export interface TurnObservation {
  projectId: ProjectId;
  threadId: string;
  turnId: string;
  provider: string;
  model: string;
  /** `null` when the engine reported no usage for the turn at all. */
  usage: UsageBuckets | null;
  capturedAt: string;
  /** Stable start of the usage window for this thread: its first turn. */
  windowSince: string;
  aggregate: { costUsd: number; costComplete: boolean } | null;
  note?: string | null;
}

export interface LedgerOptions {
  since?: string | null;
  until?: string | null;
  timeZone?: string;
  /** The studio session being viewed, for a session-scoped budget. */
  threadId?: string | null;
  /** Whether an engine turn is currently in flight (never inferred here). */
  activeTurn?: boolean;
  generatedAt?: string;
}

function joinNote(...parts: Array<string | null | undefined>): string | null {
  const kept = parts.filter((part): part is string => typeof part === "string" && part.length > 0);
  return kept.length === 0 ? null : kept.join("; ");
}

function rateComponents(card: StoredRateCard): RateComponents {
  return {
    cacheHitPico: card.cacheHitPico,
    cacheMissPico: card.cacheMissPico,
    outputPico: card.outputPico,
    toolCallPico: card.toolCallPico,
    reasoningInOutput: card.reasoningInOutput,
  };
}

export function rateCardView(card: StoredRateCard): CostRateCardView {
  const perMillion = (pico: number | null): number | null => (pico === null ? null : pico / 1e6);
  return {
    id: card.id,
    provider: card.provider,
    model: card.model,
    currency: card.currency,
    unit: card.unit,
    cacheHitPerMillion: perMillion(card.cacheHitPico),
    cacheMissPerMillion: perMillion(card.cacheMissPico),
    outputPerMillion: perMillion(card.outputPico),
    toolCallPerMillion: perMillion(card.toolCallPico),
    reasoningInOutput: card.reasoningInOutput,
    source: card.source,
    sourceRef: card.sourceRef,
    revision: card.revision,
    revisionNo: card.revisionNo,
    readAt: card.readAt,
  };
}

export function budgetView(budget: StoredBudget): BudgetView {
  return {
    id: budget.id,
    projectId: budget.projectId,
    scope: budget.scope,
    limitUsd: picoToUsd(budget.limitPico),
    warnUsd: budget.warnPico === null ? null : picoToUsd(budget.warnPico),
    enabled: budget.enabled,
    timeZone: budget.timeZone,
    revision: budget.revision,
    updatedAt: budget.updatedAt,
  };
}

export function summarizeUsageRows(rows: UsageRecord[], residualPico = 0): CostTotalsView {
  let inputTokens = 0;
  let cachedTokens = 0;
  let cacheMissTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let costPico = 0;
  let reportedTurns = 0;
  let estimatedTurns = 0;
  let unknownTurns = 0;
  let missingTurns = 0;
  let unallocatedTurns = 0;
  for (const row of rows) {
    inputTokens += row.inputTokens ?? 0;
    cachedTokens += row.cachedTokens ?? 0;
    cacheMissTokens += row.cacheMissTokens ?? 0;
    outputTokens += row.outputTokens ?? 0;
    reasoningTokens += row.reasoningTokens ?? 0;
    costPico += row.costPicoUsd ?? 0;
    switch (row.costState) {
      case "reported":
        reportedTurns += 1;
        break;
      case "estimated":
        estimatedTurns += 1;
        break;
      case "missing_usage":
        missingTurns += 1;
        break;
      case "unallocated":
        unallocatedTurns += 1;
        break;
      default:
        unknownTurns += 1;
    }
  }
  const known = costPico + residualPico;
  const definite = reportedTurns + estimatedTurns;
  const basis: CostBasis =
    definite === 0
      ? "none"
      : estimatedTurns === 0
        ? "reported"
        : reportedTurns === 0
          ? "estimated"
          : "mixed";
  return {
    turns: rows.length,
    inputTokens,
    cachedTokens,
    cacheMissTokens,
    outputTokens,
    reasoningTokens,
    costUsd: picoToUsd(known),
    costPicoUsd: known,
    costComplete: rows.length > 0 && definite === rows.length && residualPico === 0,
    costBasis: basis,
    reportedTurns,
    estimatedTurns,
    unknownTurns,
    missingTurns,
    unallocatedTurns,
    unallocatedUsd: picoToUsd(residualPico),
  };
}

/**
 * The durable cost ledger. It owns ingestion semantics, rate provenance,
 * rollups, budgets, and the dispatch gate. It has no engine client: ingestion
 * receives an already-observed turn plus a thread aggregate from the studio.
 */
export class CostLedger {
  constructor(private readonly store: StateStore) {}

  // ------------------------------------------------------------- ingestion

  async recordTurn(input: TurnObservation): Promise<UsageRecord> {
    const existing = await this.store.getUsageForTurn(input.threadId, input.turnId);
    if (existing) return existing;

    const base = {
      projectId: input.projectId,
      threadId: input.threadId,
      turnId: input.turnId,
      provider: input.provider,
      model: input.model,
      capturedAt: input.capturedAt,
    };

    if (!input.usage) {
      const aggregate = input.aggregate;
      if (aggregate && aggregate.costComplete) {
        await this.store.putCostThreadMark({
          threadId: input.threadId,
          windowSince: input.windowSince,
          reportedTotalPico: usdToPico(aggregate.costUsd),
          costComplete: true,
        });
      }
      return this.store.recordUsage({
        ...base,
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        reasoningTokens: null,
        costUsd: null,
        costState: "missing_usage",
        costAllocation: "none",
        tokenSemantics: "unknown",
        note: joinNote(input.note, "the engine reported no usage for this turn"),
      });
    }

    const buckets = input.usage;
    const card = await this.store.currentRateCard(input.provider, input.model);
    const estimate = card
      ? estimateCostPico(buckets, rateComponents(card), "inclusive_input")
      : { ok: false as const, reason: "no_rate_card" };
    const mark = await this.store.getCostThreadMark(input.threadId);
    const sameWindow = mark !== null && mark.windowSince === input.windowSince;
    const trusted = sameWindow && mark.costComplete && mark.reportedTotalPico !== null;

    let state: CostState;
    let allocation: CostAllocation;
    let pico: number | null;
    let rateCardId: string | null = null;
    let pricingReadAt: string | null = null;
    let note = input.note ?? null;

    const aggregate = input.aggregate;
    if (aggregate && aggregate.costComplete) {
      const total = usdToPico(aggregate.costUsd);
      if (trusted) {
        const previous = mark.reportedTotalPico ?? 0;
        if (total >= previous) {
          pico = total - previous;
          state = "reported";
          allocation = "thread_delta";
        } else {
          pico = null;
          state = "unallocated";
          allocation = "none";
          note = joinNote(
            note,
            "the cumulative thread total moved backwards; no negative delta was recorded",
          );
        }
        await this.store.putCostThreadMark({
          threadId: input.threadId,
          windowSince: input.windowSince,
          reportedTotalPico: Math.max(total, previous),
          costComplete: true,
        });
      } else if (mark === null && (await this.store.countUsageForThread(input.threadId)) === 0) {
        // The first turn in a fresh thread and the first complete total: the
        // total is exactly this turn's cost.
        pico = total;
        state = "reported";
        allocation = "thread_delta";
        await this.store.putCostThreadMark({
          threadId: input.threadId,
          windowSince: input.windowSince,
          reportedTotalPico: total,
          costComplete: true,
        });
      } else {
        // A complete total cannot be split honestly across turns we did not
        // price. Keep the total on the thread mark; it surfaces as residual.
        pico = null;
        state = "unallocated";
        allocation = "none";
        note = joinNote(
          note,
          "a complete thread total arrived after earlier turns; it is kept as a thread residual rather than attributed to this turn",
        );
        await this.store.putCostThreadMark({
          threadId: input.threadId,
          windowSince: input.windowSince,
          reportedTotalPico: total,
          costComplete: true,
        });
      }
    } else {
      if (input.aggregate) {
        await this.store.putCostThreadMark({
          threadId: input.threadId,
          windowSince: input.windowSince,
          reportedTotalPico: sameWindow ? mark.reportedTotalPico : null,
          costComplete: false,
        });
      }
      if (estimate.ok) {
        pico = estimate.pico;
        state = "estimated";
        allocation = "turn";
        rateCardId = card?.id ?? null;
        pricingReadAt = card?.readAt ?? null;
        note = joinNote(note, estimate.note, "local estimate from a recorded rate card");
      } else {
        pico = null;
        state = "unknown_price";
        allocation = "turn";
        note = joinNote(
          note,
          aggregate
            ? "the engine did not report a complete price for this thread"
            : "no thread aggregate was available for this turn",
          `no local estimate: ${estimate.reason}`,
        );
      }
    }

    return this.store.recordUsage({
      ...base,
      inputTokens: buckets.inputTokens,
      outputTokens: buckets.outputTokens,
      cachedTokens: buckets.cachedTokens,
      cacheMissTokens: buckets.cacheMissTokens,
      reasoningTokens: buckets.reasoningTokens,
      costUsd: pico === null ? null : picoToUsd(pico),
      costPicoUsd: pico,
      costState: state,
      costAllocation: allocation,
      rateCardId,
      pricingReadAt,
      tokenSemantics: "inclusive_input",
      note,
    });
  }

  // ------------------------------------------------------------------ views

  async ledger(projectId: ProjectId, options: LedgerOptions = {}): Promise<CostLedgerView> {
    const project = await this.store.getProject(projectId);
    if (!project) {
      throw new StateError("NOT_FOUND", "project is not in the catalog", { projectId });
    }
    const timeZone =
      options.timeZone && isValidTimeZone(options.timeZone) ? options.timeZone : defaultTimeZone();
    const generatedAt = options.generatedAt ?? new Date().toISOString();
    const [rows, tasks, threads, rateCards, storedBudgets, summary, evaluations, gate] =
      await Promise.all([
        this.store.listUsageRecords(projectId, { since: options.since, until: options.until }),
        this.store.listTasks(projectId),
        this.store.listThreads(projectId),
        this.store.listRateCards(),
        this.store.listBudgets(projectId),
        this.store.summarizeUsage(projectId),
        this.evaluateBudgets(projectId, generatedAt, {
          threadId: options.threadId ?? null,
          timeZone,
        }),
        this.dispatchGate(projectId, generatedAt, {
          threadId: options.threadId ?? null,
          timeZone,
          activeTurn: options.activeTurn,
        }),
      ]);

    const fullRange = !options.since && !options.until;
    const residual = fullRange ? summary.residualPicoUsd : 0;
    const totals = summarizeUsageRows(rows, residual);
    const taskTitles = new Map(tasks.map((task) => [String(task.id), task.title]));
    const threadTitles = new Map(threads.map((thread) => [thread.id, thread.title ?? "Session"]));

    const byModel = rollup(
      rows,
      (row) => `${row.provider} · ${row.model}`,
      (key) => key,
    );
    const byTask = rollup(
      rows,
      (row) => row.taskId ?? "unassigned",
      (key) => (key === "unassigned" ? "No task attributed" : (taskTitles.get(key) ?? key)),
    );
    const byThread = rollup(
      rows,
      (row) => row.threadId ?? "unassigned",
      (key) => (key === "unassigned" ? "No session" : (threadTitles.get(key) ?? key)),
    );
    const byDay = rollup(
      rows,
      (row) => civilDateKey(row.capturedAt, timeZone),
      (key) => key,
    );

    const routes = new Map<
      string,
      {
        provider: string;
        model: string;
        states: CostState[];
        rateCardId: string | null;
        pricingReadAt: string | null;
      }
    >();
    for (const row of rows) {
      const key = `${row.provider}\u0000${row.model}`;
      const current = routes.get(key);
      if (current) {
        current.states.push(row.costState);
        if (row.pricingReadAt && row.pricingReadAt > (current.pricingReadAt ?? "")) {
          current.pricingReadAt = row.pricingReadAt;
          current.rateCardId = row.rateCardId;
        }
      } else {
        routes.set(key, {
          provider: row.provider,
          model: row.model,
          states: [row.costState],
          rateCardId: row.rateCardId,
          pricingReadAt: row.pricingReadAt,
        });
      }
    }
    const routeState = (states: CostState[]): CostState => {
      // A route never reads better than its weakest turn.
      if (states.some((state) => state === "unknown_price" || state === "unallocated")) {
        return "unknown_price";
      }
      if (states.every((state) => state === "missing_usage")) return "missing_usage";
      if (states.some((state) => state === "missing_usage")) return "unknown_price";
      if (states.some((state) => state === "estimated")) return "estimated";
      return "reported";
    };

    const pricingFreshness =
      rows
        .map((row) => row.pricingReadAt)
        .filter((value): value is string => typeof value === "string")
        .sort()
        .at(-1) ??
      rateCards
        .map((card) => card.readAt)
        .sort()
        .at(-1) ??
      null;

    const notes: string[] = [];
    if (rateCards.length === 0) {
      notes.push(
        "No local rate card is recorded, so Mona cannot produce a local estimate for an unpriced turn. The engine's reported cost is used when it is complete.",
      );
    }
    if (residual > 0) {
      notes.push(
        `An unallocated thread total of $${picoToUsd(residual).toFixed(4)} belongs to earlier unpriced turns. It is counted once in the project total and is not attributed to a single turn.`,
      );
    }
    if (!fullRange) {
      notes.push("This range excludes unallocated earlier cost; the project view includes it.");
    }
    notes.push(
      "Provider billing remains authoritative. Mona has no supported balance interface, so no remaining balance is shown.",
    );

    return {
      projectId,
      generatedAt,
      timeZone,
      since: options.since ?? null,
      until: options.until ?? null,
      totals,
      byModel,
      byTask,
      byThread,
      byDay,
      turns: rows
        .slice()
        .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
        .map(turnView),
      rateCards: rateCards.map(rateCardView),
      routes: [...routes.values()]
        .map((entry) => ({
          provider: entry.provider,
          model: entry.model,
          state: routeState(entry.states),
          rateCardId: entry.rateCardId,
          pricingReadAt: entry.pricingReadAt,
        }))
        .sort((a, b) => `${a.provider}${a.model}`.localeCompare(`${b.provider}${b.model}`)),
      pricingFreshness,
      budgets: storedBudgets.map(budgetView),
      evaluations,
      gate,
      balance: {
        available: false,
        note: "No provider balance endpoint is used. Mona never derives a remaining balance from local usage.",
      },
      notes,
    };
  }

  // ---------------------------------------------------------------- budgets

  async evaluateBudgets(
    projectId: ProjectId,
    atIso: string,
    options: { threadId?: string | null; timeZone?: string } = {},
  ): Promise<BudgetEvaluationView[]> {
    const budgets = (await this.store.listBudgets(projectId)).filter((budget) => budget.enabled);
    if (budgets.length === 0) return [];
    const project = await this.store.getProject(projectId);
    if (!project) return [];
    const threads = await this.store.listThreads(projectId);
    const sessionThread =
      (options.threadId ? threads.find((thread) => thread.id === options.threadId) : undefined) ??
      threads[0] ??
      null;
    const summary = await this.store.summarizeUsage(projectId);
    const results: BudgetEvaluationView[] = [];
    for (const budget of budgets) {
      const zone = isValidTimeZone(budget.timeZone)
        ? budget.timeZone
        : (options.timeZone ?? defaultTimeZone());
      const window =
        budget.scope === "day"
          ? civilDayRange(atIso, zone)
          : {
              startIso:
                budget.scope === "session"
                  ? (sessionThread?.createdAt ?? atIso)
                  : project.createdAt,
              endIso: atIso,
            };
      if (budget.scope === "session" && sessionThread === null) {
        results.push({
          budgetId: budget.id,
          scope: budget.scope,
          level: "ok",
          knownUsd: 0,
          limitUsd: picoToUsd(budget.limitPico),
          warnUsd: budget.warnPico === null ? null : picoToUsd(budget.warnPico),
          unknownTurns: 0,
          complete: false,
          windowStart: window.startIso,
          windowEnd: window.endIso,
          message: "No studio session exists yet, so this session budget has no spend to compare.",
        });
        continue;
      }
      const rows = await this.store.listUsageRecords(projectId, {
        since: window.startIso,
        until: window.endIso,
      });
      const residual =
        budget.scope === "project" && project.createdAt <= window.startIso
          ? summary.residualPicoUsd
          : 0;
      const totals = summarizeUsageRows(rows, residual);
      const unknownTurns = totals.unknownTurns + totals.missingTurns + totals.unallocatedTurns;
      const level =
        totals.costPicoUsd >= budget.limitPico
          ? "stop"
          : budget.warnPico !== null && totals.costPicoUsd >= budget.warnPico
            ? "warn"
            : "ok";
      const known = `$${picoToUsd(totals.costPicoUsd).toFixed(4)}`;
      const limit = `$${picoToUsd(budget.limitPico).toFixed(2)}`;
      const scopeLabel =
        budget.scope === "day"
          ? `today (${zone})`
          : budget.scope === "session"
            ? "this session"
            : "this project";
      const qualifier =
        unknownTurns > 0
          ? ` ${unknownTurns} turn${unknownTurns === 1 ? " has" : "s have"} no definite price, so this is a lower bound.`
          : "";
      const warnLabel =
        budget.warnPico === null ? "the warning" : `$${picoToUsd(budget.warnPico).toFixed(2)}`;
      const message =
        level === "stop"
          ? `Known spend ${known} reached the ${limit} limit for ${scopeLabel}. The next dispatch is blocked; an in-flight request may still complete and exceed the limit.${qualifier}`
          : level === "warn"
            ? `Known spend ${known} is at or above ${warnLabel} for ${scopeLabel}. The next dispatch is still allowed.${qualifier}`
            : `Known spend ${known} of ${limit} for ${scopeLabel}.${qualifier}`;
      results.push({
        budgetId: budget.id,
        scope: budget.scope,
        level,
        knownUsd: picoToUsd(totals.costPicoUsd),
        limitUsd: picoToUsd(budget.limitPico),
        warnUsd: budget.warnPico === null ? null : picoToUsd(budget.warnPico),
        unknownTurns,
        complete: totals.costComplete,
        windowStart: window.startIso,
        windowEnd: window.endIso,
        message,
      });
    }
    return results;
  }

  async dispatchGate(
    projectId: ProjectId,
    atIso: string,
    options: { threadId?: string | null; timeZone?: string; activeTurn?: boolean } = {},
  ): Promise<DispatchGateView> {
    const [evaluations, taskRuns] = await Promise.all([
      this.evaluateBudgets(projectId, atIso, options),
      this.store.countActiveTaskRuns(projectId),
    ]);
    const stopped = evaluations.filter((entry) => entry.level === "stop");
    const warned = evaluations.filter((entry) => entry.level === "warn");
    const activeTurn = options.activeTurn === true;
    const reservations = taskRuns + (activeTurn ? 1 : 0);
    return {
      allowed: stopped.length === 0,
      level: stopped.length > 0 ? "stop" : warned.length > 0 ? "warn" : "ok",
      reasons: stopped.map((entry) => entry.message),
      evaluations,
      inFlight: { taskRuns, activeTurn },
      reservations,
      note:
        reservations > 0
          ? "A mutating turn is already in flight. The gate is re-evaluated before the next dispatch; an in-flight provider request can complete after a stop and is not cancelled by a local limit."
          : "A local budget blocks the next dispatch only. It is not an invoice cap: an in-flight provider request may complete after a stop request.",
    };
  }

  async setBudget(input: {
    projectId: ProjectId;
    scope: BudgetScope;
    limitUsd: number;
    warnUsd?: number | null;
    enabled?: boolean;
    timeZone?: string;
    expectedRevision?: number;
  }): Promise<BudgetView> {
    const timeZone =
      input.timeZone && isValidTimeZone(input.timeZone) ? input.timeZone : defaultTimeZone();
    const stored = await this.store.putBudget({
      projectId: input.projectId,
      scope: input.scope,
      limitPico: usdToPico(input.limitUsd),
      warnPico:
        input.warnUsd === undefined || input.warnUsd === null ? null : usdToPico(input.warnUsd),
      enabled: input.enabled ?? true,
      timeZone,
      expectedRevision: input.expectedRevision,
    });
    return budgetView(stored);
  }

  async clearBudget(input: {
    projectId: ProjectId;
    budgetId: string;
    expectedRevision?: number;
  }): Promise<{ cleared: boolean }> {
    return this.store.clearBudget(input);
  }

  // ------------------------------------------------------------------ rates

  async listRateCards(): Promise<CostRateCardView[]> {
    const cards = await this.store.listRateCards();
    return cards.map(rateCardView);
  }

  async setRateCard(input: {
    provider: string;
    model: string;
    cacheHitPerMillion?: number | null;
    cacheMissPerMillion?: number | null;
    outputPerMillion?: number | null;
    toolCallPerMillion?: number | null;
    reasoningInOutput?: boolean;
    sourceRef?: string | null;
    readAt?: string;
  }): Promise<CostRateCardView> {
    const perMillion = (value: number | null | undefined): number | null =>
      value === undefined || value === null ? null : ratePerMillionToPicoPerToken(value);
    const card = await this.store.saveRateCard({
      provider: input.provider,
      model: input.model,
      cacheHitPico: perMillion(input.cacheHitPerMillion),
      cacheMissPico: perMillion(input.cacheMissPerMillion),
      outputPico: perMillion(input.outputPerMillion),
      toolCallPico: perMillion(input.toolCallPerMillion),
      reasoningInOutput: input.reasoningInOutput ?? true,
      source: "user_supplied",
      sourceRef: input.sourceRef ?? null,
      readAt: input.readAt ?? new Date().toISOString(),
    });
    return rateCardView(card);
  }

  /**
   * Re-price rows that were estimated or unpriced from a candidate rate card.
   * Read-only: stored history is never rewritten without an explicit decision.
   */
  async previewRecalculation(
    projectId: ProjectId,
    input: {
      provider: string;
      model: string;
      cacheHitPerMillion?: number | null;
      cacheMissPerMillion?: number | null;
      outputPerMillion?: number | null;
      reasoningInOutput?: boolean;
    },
  ): Promise<{
    turns: number;
    beforePico: number;
    afterPico: number;
    changes: Array<{ turnId: string | null; beforePico: number | null; afterPico: number | null }>;
  }> {
    const perMillion = (value: number | null | undefined): number | null =>
      value === undefined || value === null ? null : ratePerMillionToPicoPerToken(value);
    const rate: RateComponents = {
      cacheHitPico: perMillion(input.cacheHitPerMillion),
      cacheMissPico: perMillion(input.cacheMissPerMillion),
      outputPico: perMillion(input.outputPerMillion),
      toolCallPico: null,
      reasoningInOutput: input.reasoningInOutput ?? true,
    };
    const rows = (await this.store.listUsageRecords(projectId)).filter(
      (row) => row.provider === input.provider && row.model === input.model,
    );
    const changes = rows.map((row) => {
      if (row.costState === "reported") {
        return { turnId: row.turnId, beforePico: row.costPicoUsd, afterPico: row.costPicoUsd };
      }
      const estimate = estimateCostPico(
        {
          inputTokens: row.inputTokens,
          cachedTokens: row.cachedTokens,
          cacheMissTokens: row.cacheMissTokens,
          outputTokens: row.outputTokens,
          reasoningTokens: row.reasoningTokens,
        },
        rate,
        row.tokenSemantics,
      );
      return {
        turnId: row.turnId,
        beforePico: row.costPicoUsd,
        afterPico: estimate.ok ? estimate.pico : null,
      };
    });
    return {
      turns: changes.length,
      beforePico: changes.reduce((sum, change) => sum + (change.beforePico ?? 0), 0),
      afterPico: changes.reduce(
        (sum, change) => sum + (change.afterPico ?? change.beforePico ?? 0),
        0,
      ),
      changes,
    };
  }

  // ----------------------------------------------------------------- export

  async exportLedger(
    projectId: ProjectId,
    options: LedgerOptions & { format: "json" | "csv" },
  ): Promise<CostExport> {
    const ledger = await this.ledger(projectId, options);
    const project = await this.store.getProject(projectId);
    const stamp = (options.generatedAt ?? ledger.generatedAt).slice(0, 10);
    const slug = (project?.name ?? "project")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    const base = `mona-cost-${slug || "project"}-${stamp}`;
    if (options.format === "csv") {
      return { filename: `${base}.csv`, format: "csv", content: ledgerCsv(ledger) };
    }
    return {
      filename: `${base}.json`,
      format: "json",
      content: `${JSON.stringify(
        {
          format: "mona-cost-ledger",
          format_version: 1,
          exported_at: ledger.generatedAt,
          project: { id: projectId, name: project?.name ?? null },
          time_zone: ledger.timeZone,
          since: ledger.since,
          until: ledger.until,
          totals: ledger.totals,
          by_model: ledger.byModel,
          by_task: ledger.byTask,
          by_thread: ledger.byThread,
          by_day: ledger.byDay,
          turns: ledger.turns.map((turn) => ({
            captured_at: turn.capturedAt,
            thread_id: turn.threadId,
            turn_id: turn.turnId,
            task_id: turn.taskId,
            provider: turn.provider,
            model: turn.model,
            input_tokens: turn.inputTokens,
            cached_tokens: turn.cachedTokens,
            cache_miss_tokens: turn.cacheMissTokens,
            output_tokens: turn.outputTokens,
            reasoning_tokens: turn.reasoningTokens,
            cost_usd: turn.costUsd,
            cost_state: turn.state,
            cost_allocation: turn.allocation,
            pricing_read_at: turn.pricingReadAt,
            note: turn.note,
          })),
          rate_cards: ledger.rateCards,
          pricing_freshness: ledger.pricingFreshness,
          balance: null,
          balance_note: ledger.balance.note,
          notes: ledger.notes,
        },
        null,
        2,
      )}\n`,
    };
  }
}

// ------------------------------------------------------------------ helpers

function rollup(
  rows: UsageRecord[],
  keyOf: (row: UsageRecord) => string,
  labelOf: (key: string) => string,
): CostRollupView[] {
  const groups = new Map<string, UsageRecord[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, label: labelOf(key), totals: summarizeUsageRows(group) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function turnView(row: UsageRecord): CostTurnView {
  return {
    id: row.id,
    threadId: row.threadId,
    turnId: row.turnId,
    taskId: row.taskId,
    provider: row.provider,
    model: row.model,
    inputTokens: row.inputTokens,
    cachedTokens: row.cachedTokens,
    cacheMissTokens: row.cacheMissTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    costUsd: row.costUsd,
    state: row.costState,
    allocation: row.costAllocation,
    tokenSemantics: row.tokenSemantics,
    rateCardId: row.rateCardId,
    pricingReadAt: row.pricingReadAt,
    capturedAt: row.capturedAt,
    note: row.note,
  };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function ledgerCsv(ledger: CostLedgerView): string {
  const header = [
    "captured_at",
    "thread_id",
    "turn_id",
    "task_id",
    "provider",
    "model",
    "input_tokens",
    "cached_tokens",
    "cache_miss_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cost_usd",
    "cost_state",
    "cost_allocation",
    "pricing_read_at",
    "note",
  ];
  const lines = [header.join(",")];
  for (const turn of ledger.turns.slice().reverse()) {
    lines.push(
      [
        turn.capturedAt,
        turn.threadId,
        turn.turnId,
        turn.taskId,
        turn.provider,
        turn.model,
        turn.inputTokens,
        turn.cachedTokens,
        turn.cacheMissTokens,
        turn.outputTokens,
        turn.reasoningTokens,
        turn.costUsd === null ? "" : turn.costUsd.toFixed(12),
        turn.state,
        turn.allocation,
        turn.pricingReadAt,
        turn.note,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
