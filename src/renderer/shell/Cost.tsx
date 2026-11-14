import { useCallback, useEffect, useState, type JSX } from "react";
import type { IpcResult, ProjectDetail } from "../../shared/contracts/project-bridge";
import type {
  BudgetScope,
  CostLedgerView,
  CostRollupView,
  CostState,
  CostTotalsView,
} from "../../shared/contracts/cost";
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ScreenHeader,
  SelectField,
  TextField,
  type Tone,
} from "../design/primitives";
import { CostIcon, FolderIcon, InfoIcon, RefreshIcon } from "../design/icons";
import { formatTokens } from "./visual";

const STATE_LABEL: Record<CostState, string> = {
  reported: "Reported",
  estimated: "Estimated",
  unknown_price: "Unknown price",
  missing_usage: "No usage",
  unallocated: "Unallocated",
};

const STATE_TONE: Record<CostState, Tone> = {
  reported: "success",
  estimated: "primary",
  unknown_price: "attention",
  missing_usage: "neutral",
  unallocated: "attention",
};

/**
 * Money is never rounded into a misleading zero: a sub-cent total keeps enough
 * decimals to stay nonzero and visible.
 */
function money(value: number | null, decimals?: number): string {
  if (value === null) return "Unknown";
  if (decimals !== undefined) return `$${value.toFixed(decimals)}`;
  if (value === 0) return "$0.00";
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

async function unwrap<T>(run: () => Promise<IpcResult<T>>): Promise<T> {
  const result = await run();
  if (!result.ok) {
    throw new Error(
      result.error.code ? `${result.error.message} (${result.error.code})` : result.error.message,
    );
  }
  return result.value;
}

function basisSentence(totals: CostTotalsView): string {
  if (totals.turns === 0) return "No turns observed yet.";
  const definite = totals.reportedTurns + totals.estimatedTurns;
  if (definite === 0) return "No observed turn has a definite price.";
  if (!totals.costComplete) {
    return `${definite} of ${totals.turns} observed turns have a definite price; the rest are unknown, so this is a lower bound.`;
  }
  if (totals.costBasis === "reported") return "Every observed turn has an engine-reported price.";
  if (totals.costBasis === "estimated")
    return "Every observed turn is priced from a local rate card; these are estimates, not provider reports.";
  return "Some turns are engine-reported and some locally estimated. Provider billing remains authoritative.";
}

function RollupTable({ rows, empty }: { rows: CostRollupView[]; empty: string }): JSX.Element {
  if (rows.length === 0) {
    return <p className="muted">{empty}</p>;
  }
  return (
    <div className="table table--4" role="table">
      <div className="table__row table__row--head" role="row">
        <span role="columnheader">Group</span>
        <span role="columnheader">Turns</span>
        <span role="columnheader">Cost</span>
        <span role="columnheader">Basis</span>
      </div>
      {rows.map((row) => {
        const definite = row.totals.reportedTurns + row.totals.estimatedTurns;
        return (
          <div className="table__row" role="row" key={row.key}>
            <span role="cell" className="table__model">
              {row.label}
            </span>
            <span role="cell">{row.totals.turns}</span>
            <span role="cell">
              {definite === 0 ? (
                <span className="unknown-value">Unknown</span>
              ) : (
                <>
                  {money(row.totals.costUsd)}
                  {!row.totals.costComplete ? (
                    <span className="metric__qualifier"> at least</span>
                  ) : null}
                </>
              )}
            </span>
            <span role="cell">
              <Badge
                tone={
                  definite === 0
                    ? "attention"
                    : !row.totals.costComplete
                      ? "attention"
                      : row.totals.costBasis === "reported"
                        ? "success"
                        : "primary"
                }
              >
                {definite === 0
                  ? "No price"
                  : !row.totals.costComplete
                    ? `partial · ${row.totals.costBasis}`
                    : row.totals.costBasis}
              </Badge>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function CostScreen({
  detail,
  onOpenFolder,
}: {
  detail: ProjectDetail | null;
  onOpenFolder: () => void;
}): JSX.Element {
  const projectId = detail?.project.id ?? null;
  const [ledger, setLedger] = useState<CostLedgerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [budgetScope, setBudgetScope] = useState<BudgetScope>("project");
  const [budgetLimit, setBudgetLimit] = useState("5.00");
  const [budgetWarn, setBudgetWarn] = useState("");
  const [rateProvider, setRateProvider] = useState("");
  const [rateModel, setRateModel] = useState("");
  const [rateHit, setRateHit] = useState("");
  const [rateMiss, setRateMiss] = useState("");
  const [rateOutput, setRateOutput] = useState("");

  const load = useCallback(async (): Promise<void> => {
    if (!projectId) {
      setLedger(null);
      return;
    }
    try {
      const next = await unwrap(() => window.mona.costLedger(projectId));
      setLedger(next);
      setError(null);
      const route = next.routes[0];
      if (route) {
        setRateProvider((current) => current || route.provider);
        setRateModel((current) => current || route.model);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      setBusy(true);
      setNotice(null);
      try {
        await action();
        await load();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (!detail || !projectId) {
    return (
      <div className="screen">
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<FolderIcon size={30} />}
            title="Choose a project"
            description="The cost ledger is stored per project from engine usage. Mona adds no inference of its own."
            action={
              <Button variant="primary" onClick={onOpenFolder} icon={<FolderIcon size={16} />}>
                Open folder
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const exportAs = (format: "json" | "csv") =>
    void run(async () => {
      const result = await unwrap(() => window.mona.exportCostLedgerFile(projectId, format));
      setNotice(
        result.saved ? `Ledger written to ${result.path}` : "Export canceled; nothing was written.",
      );
    });

  const saveBudget = () =>
    void run(async () => {
      const limit = Number(budgetLimit);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error("Enter a limit greater than zero.");
      }
      const warn = budgetWarn.trim() === "" ? null : Number(budgetWarn);
      if (warn !== null && (!Number.isFinite(warn) || warn <= 0 || warn > limit)) {
        throw new Error("The warning must be above zero and at or below the limit.");
      }
      await unwrap(() =>
        window.mona.setCostBudget({
          projectId,
          scope: budgetScope,
          limitUsd: limit,
          warnUsd: warn,
        }),
      );
      setNotice("Budget saved. It applies to the next dispatch, not to work already running.");
    });

  const saveRate = () =>
    void run(async () => {
      const parse = (value: string, label: string): number | null => {
        if (value.trim() === "") return null;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`${label} must be a nonnegative number or blank.`);
        }
        return parsed;
      };
      if (rateProvider.trim() === "" || rateModel.trim() === "") {
        throw new Error("A rate card needs a provider and a model id.");
      }
      await unwrap(() =>
        window.mona.setRateCard({
          provider: rateProvider.trim(),
          model: rateModel.trim(),
          cacheHitPerMillion: parse(rateHit, "Cache-hit rate"),
          cacheMissPerMillion: parse(rateMiss, "Cache-miss rate"),
          outputPerMillion: parse(rateOutput, "Output rate"),
        }),
      );
      setNotice(
        "Rate card saved as a new revision. Turns already priced keep the rate they were priced with.",
      );
    });

  const route = ledger?.routes[0] ?? null;

  return (
    <div className="screen screen--cost">
      <ScreenHeader
        eyebrow="Cost lens"
        title="Understand spending without invented precision"
        lede={`${detail.project.name} · engine usage plus local arithmetic. Provider billing remains authoritative.`}
      />

      {error ? (
        <Callout tone="danger" title="The ledger could not be read">
          {error}
        </Callout>
      ) : null}
      {notice ? (
        <Callout tone="primary" title="Done">
          {notice}
        </Callout>
      ) : null}

      {!ledger ? (
        <Card>
          <p className="muted">Reading the stored usage ledger…</p>
        </Card>
      ) : ledger.totals.turns === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<CostIcon size={30} />}
            title="No usage recorded for this project"
            description="Browsing, navigation, status, and the shell make no model calls. A row appears only after the engine reports a completed or interrupted turn."
          />
        </Card>
      ) : (
        <>
          {!ledger.totals.costComplete ? (
            <Callout tone="attention" title="Spend is incomplete — unknown is not zero">
              {basisSentence(ledger.totals)}{" "}
              {ledger.totals.unknownTurns > 0
                ? `${ledger.totals.unknownTurns} turn${
                    ledger.totals.unknownTurns === 1 ? " has" : "s have"
                  } no price. `
                : ""}
              {ledger.totals.missingTurns > 0
                ? `${ledger.totals.missingTurns} turn${
                    ledger.totals.missingTurns === 1 ? " reported" : "s reported"
                  } no usage. `
                : ""}
              {ledger.totals.unallocatedUsd > 0
                ? `$${ledger.totals.unallocatedUsd.toFixed(
                    4,
                  )} is a thread total that cannot be attributed to one turn. `
                : ""}
              {ledger.totals.costBasis === "none"
                ? "No dollar subtotal is shown, because a known total of zero would misrepresent an unknown price. "
                : `The known subtotal is ${money(ledger.totals.costUsd)}; no exact total or balance claim is made. `}
            </Callout>
          ) : null}

          <section className="metric-grid" aria-label="Usage summary">
            <Card className="metric">
              <p className="metric__label">Known spend</p>
              <p className="metric__value">
                {ledger.totals.costBasis === "none" ? (
                  <span className="unknown-value">Unknown</span>
                ) : (
                  <>
                    {money(ledger.totals.costUsd)}
                    {!ledger.totals.costComplete ? (
                      <span className="metric__qualifier"> at least</span>
                    ) : null}
                  </>
                )}
              </p>
              <p className="metric__detail">{basisSentence(ledger.totals)}</p>
            </Card>
            <Card className="metric">
              <p className="metric__label">Turns</p>
              <p className="metric__value">{ledger.totals.turns}</p>
              <p className="metric__detail">
                {ledger.totals.reportedTurns} reported · {ledger.totals.estimatedTurns} estimated ·{" "}
                {ledger.totals.unknownTurns +
                  ledger.totals.missingTurns +
                  ledger.totals.unallocatedTurns}{" "}
                without a definite price
              </p>
            </Card>
            <Card className="metric">
              <p className="metric__label">Input tokens</p>
              <p className="metric__value">{formatTokens(ledger.totals.inputTokens)}</p>
              <p className="metric__detail">
                Inclusive prompt total; {formatTokens(ledger.totals.cachedTokens)} were cache hits.
              </p>
            </Card>
            <Card className="metric">
              <p className="metric__label">Output tokens</p>
              <p className="metric__value">{formatTokens(ledger.totals.outputTokens)}</p>
              <p className="metric__detail">
                {formatTokens(ledger.totals.reasoningTokens)} reasoning tokens reported separately.
              </p>
            </Card>
          </section>

          <Card
            title="Budgets"
            eyebrow="Optional · user-set"
            actions={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void load()}
                icon={<RefreshIcon size={14} />}
              >
                Refresh
              </Button>
            }
          >
            <p className="muted">
              A budget is a local threshold, not an invoice cap. It blocks the next dispatch and
              never interrupts a prompt that is already running. The known spend is a lower bound
              when any turn in scope is unpriced.
            </p>
            {ledger.budgets.length === 0 ? (
              <p className="muted">No budget is configured.</p>
            ) : (
              <div className="table table--5" role="table" aria-label="Budgets">
                <div className="table__row table__row--head" role="row">
                  <span role="columnheader">Scope</span>
                  <span role="columnheader">Known / limit</span>
                  <span role="columnheader">State</span>
                  <span role="columnheader">Window</span>
                  <span role="columnheader"> </span>
                </div>
                {ledger.budgets.map((budget) => {
                  const evaluation = ledger.evaluations.find(
                    (entry) => entry.budgetId === budget.id,
                  );
                  return (
                    <div className="table__row" role="row" key={budget.id}>
                      <span role="cell">{budget.scope}</span>
                      <span role="cell">
                        {money(evaluation?.knownUsd ?? 0)} / ${budget.limitUsd.toFixed(2)}
                      </span>
                      <span role="cell">
                        <Badge
                          tone={
                            evaluation?.level === "stop"
                              ? "danger"
                              : evaluation?.level === "warn"
                                ? "attention"
                                : "success"
                          }
                        >
                          {evaluation?.level === "stop"
                            ? "Stops next dispatch"
                            : evaluation?.level === "warn"
                              ? "Warning"
                              : "Within budget"}
                        </Badge>
                      </span>
                      <span role="cell">
                        {evaluation
                          ? `${new Date(evaluation.windowStart).toLocaleDateString()} → ${new Date(
                              evaluation.windowEnd,
                            ).toLocaleDateString()}`
                          : "—"}
                      </span>
                      <span role="cell">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await unwrap(() =>
                                window.mona.clearCostBudget({
                                  projectId,
                                  budgetId: budget.id,
                                  expectedRevision: budget.revision,
                                }),
                              );
                              setNotice("Budget cleared. No limit remains for that scope.");
                            })
                          }
                        >
                          Clear
                        </Button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {ledger.evaluations.map((evaluation) =>
              evaluation.unknownTurns > 0 ? (
                <p className="muted" key={`note-${evaluation.budgetId}`}>
                  {evaluation.message}
                </p>
              ) : null,
            )}
            <div className="form-grid">
              <SelectField
                label="Scope"
                value={budgetScope}
                onChange={(event) => setBudgetScope(event.target.value as BudgetScope)}
                options={[
                  { value: "project", label: "This project" },
                  { value: "session", label: "This session" },
                  { value: "day", label: `Today (${ledger.timeZone})` },
                ]}
              />
              <TextField
                label="Limit (USD)"
                inputMode="decimal"
                value={budgetLimit}
                onChange={(event) => setBudgetLimit(event.target.value)}
                hint="Saving replaces the budget for the same scope."
              />
              <TextField
                label="Warn at (USD, optional)"
                inputMode="decimal"
                value={budgetWarn}
                onChange={(event) => setBudgetWarn(event.target.value)}
                hint="A warning never blocks a dispatch."
              />
            </div>
            <div className="row-actions">
              <Button variant="secondary" disabled={busy} onClick={saveBudget}>
                Save budget
              </Button>
            </div>
            <p className="muted">
              {ledger.gate.allowed ? "Dispatch gate: allowed." : "Dispatch gate: blocked."}{" "}
              {ledger.gate.note}
            </p>
          </Card>

          <Card title="By model" eyebrow="Engine-reported usage">
            <RollupTable rows={ledger.byModel} empty="No model has usage in this range." />
          </Card>

          <Card title="By task" eyebrow="Attribution from the dispatch link">
            <RollupTable rows={ledger.byTask} empty="No task-attributed usage yet." />
            <p className="muted">
              A turn is attributed to a task only when Mona dispatched that prompt. Untasked
              composer turns stay under “No task attributed”.
            </p>
          </Card>

          <div className="cost-columns">
            <Card title="By session" eyebrow="One engine thread">
              <RollupTable rows={ledger.byThread} empty="No session usage yet." />
            </Card>
            <Card title={`By day · ${ledger.timeZone}`} eyebrow="Civil dates, not UTC">
              <RollupTable rows={ledger.byDay} empty="No daily buckets yet." />
            </Card>
          </div>

          <Card title="Price evidence" eyebrow="Routes and rate cards">
            <div className="table table--4" role="table" aria-label="Price evidence by route">
              <div className="table__row table__row--head" role="row">
                <span role="columnheader">Provider</span>
                <span role="columnheader">Model</span>
                <span role="columnheader">Price state</span>
                <span role="columnheader">Rate read</span>
              </div>
              {ledger.routes.map((entry) => (
                <div className="table__row" role="row" key={`${entry.provider}-${entry.model}`}>
                  <span role="cell">{entry.provider}</span>
                  <span role="cell" className="table__model">
                    {entry.model}
                  </span>
                  <span role="cell">
                    <Badge tone={STATE_TONE[entry.state]}>{STATE_LABEL[entry.state]}</Badge>
                  </span>
                  <span role="cell">
                    {entry.pricingReadAt
                      ? new Date(entry.pricingReadAt).toLocaleString()
                      : "No rate recorded"}
                  </span>
                </div>
              ))}
            </div>
            <p className="muted">
              Pricing freshness:{" "}
              {ledger.pricingFreshness
                ? new Date(ledger.pricingFreshness).toLocaleString()
                : "no rate source has been recorded."}{" "}
              Mona ships no price table. A local estimate exists only for a route with a recorded
              rate card.
            </p>
            {ledger.rateCards.length > 0 ? (
              <ul className="rule-list">
                {ledger.rateCards.map((card) => (
                  <li key={card.id}>
                    <strong>{card.provider}</strong> · {card.model}: hit{" "}
                    {card.cacheHitPerMillion === null ? "unknown" : `$${card.cacheHitPerMillion}`} ·
                    miss{" "}
                    {card.cacheMissPerMillion === null ? "unknown" : `$${card.cacheMissPerMillion}`}{" "}
                    · output{" "}
                    {card.outputPerMillion === null ? "unknown" : `$${card.outputPerMillion}`} per
                    million tokens · revision {card.revisionNo} · read{" "}
                    {new Date(card.readAt).toLocaleString()}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="form-grid">
              <TextField
                label="Provider"
                value={rateProvider}
                onChange={(event) => setRateProvider(event.target.value)}
                hint={route ? `Seen route: ${route.provider}` : undefined}
              />
              <TextField
                label="Model"
                value={rateModel}
                onChange={(event) => setRateModel(event.target.value)}
                hint={route ? `Seen route: ${route.model}` : undefined}
              />
              <TextField
                label="Cache hit $/M"
                inputMode="decimal"
                value={rateHit}
                onChange={(event) => setRateHit(event.target.value)}
              />
              <TextField
                label="Cache miss $/M"
                inputMode="decimal"
                value={rateMiss}
                onChange={(event) => setRateMiss(event.target.value)}
              />
              <TextField
                label="Output $/M"
                inputMode="decimal"
                value={rateOutput}
                onChange={(event) => setRateOutput(event.target.value)}
              />
            </div>
            <div className="row-actions">
              <Button variant="secondary" disabled={busy} onClick={saveRate}>
                Record rate card
              </Button>
            </div>
            <p className="muted">
              A new rate card affects future turns only. Changing a rate never rewrites a turn that
              was already priced.
            </p>
          </Card>

          <Card title="Recent turns" eyebrow={`${ledger.turns.length} recorded`}>
            <div className="table table--5" role="table" aria-label="Recent turns">
              <div className="table__row table__row--head" role="row">
                <span role="columnheader">When</span>
                <span role="columnheader">Model</span>
                <span role="columnheader">Tokens in / out</span>
                <span role="columnheader">Cost</span>
                <span role="columnheader">State</span>
              </div>
              {ledger.turns.slice(0, 25).map((turn) => (
                <div className="table__row" role="row" key={turn.id}>
                  <span role="cell">{new Date(turn.capturedAt).toLocaleString()}</span>
                  <span role="cell" className="table__model">
                    {turn.model}
                  </span>
                  <span role="cell">
                    {formatTokens(turn.inputTokens ?? 0)} / {formatTokens(turn.outputTokens ?? 0)}
                  </span>
                  <span role="cell">
                    {turn.costUsd === null ? (
                      <span className="unknown-value">Unknown</span>
                    ) : (
                      money(turn.costUsd)
                    )}
                  </span>
                  <span role="cell" title={turn.note ?? undefined}>
                    <Badge tone={STATE_TONE[turn.state]}>{STATE_LABEL[turn.state]}</Badge>
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card
            title="Export"
            eyebrow="Local file"
            actions={
              <div className="row-actions">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => exportAs("json")}
                >
                  Export JSON
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => exportAs("csv")}
                >
                  Export CSV
                </Button>
              </div>
            }
          >
            <p className="muted">
              The export carries every turn, its cost state, the rate-card provenance, and the
              unallocated residual note. No balance is exported because none is available.
            </p>
          </Card>

          <Card title="How this is calculated" eyebrow="Zero inference">
            <ul className="rule-list">
              <li>
                <InfoIcon size={15} /> Totals come from engine usage records and local integer
                arithmetic. The shell never calls a model to summarize cost.
              </li>
              <li>
                <InfoIcon size={15} /> A turn is recorded once. A reconnect, a replay, or a
                restarted process cannot add a second charge.
              </li>
              <li>
                <InfoIcon size={15} /> The engine&apos;s cumulative thread total is converted into
                an exact per-turn delta. A total that cannot be split stays unallocated and is
                counted once.
              </li>
              <li>
                <InfoIcon size={15} /> Cache and reasoning tokens are subsets of their parent
                buckets; they are never added twice.
              </li>
              <li>
                <InfoIcon size={15} /> {ledger.balance.note}
              </li>
            </ul>
            {ledger.notes.map((note) => (
              <p className="muted" key={note}>
                {note}
              </p>
            ))}
          </Card>
        </>
      )}
    </div>
  );
}
