import type { JSX } from "react";
import { fixtureUsage } from "../fixtures";
import { Badge, Button, Callout, Card, EmptyState, ScreenHeader } from "../primitives";
import { ArrowUpRightIcon, CostIcon, InfoIcon, SparkIcon } from "../icons";
import type { Scenario } from "./types";

function formatTokens(value: number | null): string {
  if (value === null) return "Unknown";
  return value.toLocaleString("en-US");
}

export function CostLensScreen({ scenario }: { scenario: Scenario }): JSX.Element {
  const rows = scenario === "empty" ? [] : fixtureUsage;
  const unpriced = rows.filter((row) => !row.costComplete).length;
  const observed = rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  const turns = rows.reduce((sum, row) => sum + row.turns, 0);
  const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  const cachedTokens = rows.reduce((sum, row) => sum + (row.cachedTokens ?? 0), 0);
  const cacheShare = inputTokens > 0 ? Math.round((cachedTokens / inputTokens) * 100) : null;

  return (
    <div className="screen screen--cost">
      <ScreenHeader
        eyebrow="Cost lens"
        title="Understand spending without invented precision"
        lede="Mona shows what the engine reported, labels what it could not price, and adds no inference of its own."
        actions={
          <Button
            variant="secondary"
            icon={<ArrowUpRightIcon size={15} />}
            disabled={unpriced > 0}
            title={
              unpriced > 0
                ? "Resolve or acknowledge unpriced turns before exporting a total"
                : undefined
            }
          >
            Export ledger
          </Button>
        }
      />

      {unpriced > 0 ? (
        <Callout tone="attention" title="Spend is incomplete — unknown is not zero">
          {unpriced === 1
            ? "One model row has no price evidence."
            : `${unpriced} model rows have no price evidence.`}{" "}
          The observed subtotal is ${observed.toFixed(2)}; no exact total or balance claim is made.
        </Callout>
      ) : null}

      <section className="metric-grid" aria-label="Usage summary">
        <Card className="metric">
          <p className="metric__label">Observed spend</p>
          <p className="metric__value">
            ${observed.toFixed(2)}
            {unpriced > 0 ? <span className="metric__qualifier"> at least</span> : null}
          </p>
          <p className="metric__detail">
            {unpriced > 0
              ? "Incomplete: unpriced turns are excluded from the number."
              : "All observed turns are priced."}
          </p>
        </Card>
        <Card className="metric">
          <p className="metric__label">Turns</p>
          <p className="metric__value">{turns}</p>
          <p className="metric__detail">Completed or interrupted turns observed in this project.</p>
        </Card>
        <Card className="metric">
          <p className="metric__label">Input tokens</p>
          <p className="metric__value">{formatTokens(inputTokens)}</p>
          <p className="metric__detail">Provider-reported usage, not estimated from characters.</p>
        </Card>
        <Card className="metric">
          <p className="metric__label">Cache share</p>
          <p className="metric__value">{cacheShare === null ? "Unknown" : `${cacheShare}%`}</p>
          <p className="metric__detail">
            {cacheShare === null
              ? "No cache evidence for this range."
              : `${formatTokens(cachedTokens)} cached input tokens.`}
          </p>
        </Card>
      </section>

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CostIcon size={30} />}
            title="No usage recorded yet"
            description="Browsing, navigation, and status checks make no model calls. Usage appears only after the engine reports a completed or interrupted turn."
          />
        </Card>
      ) : (
        <Card title="By model" eyebrow="Provider-reported usage">
          <div className="table" role="table" aria-label="Usage by model">
            <div className="table__row table__row--head" role="row">
              <span role="columnheader">Model</span>
              <span role="columnheader">Turns</span>
              <span role="columnheader">Input</span>
              <span role="columnheader">Cached</span>
              <span role="columnheader">Cost</span>
              <span role="columnheader">Price evidence</span>
            </div>
            {rows.map((row) => (
              <div className="table__row" role="row" key={row.model}>
                <span role="cell" className="table__model">
                  {row.model}
                </span>
                <span role="cell">{row.turns}</span>
                <span role="cell">{formatTokens(row.inputTokens)}</span>
                <span role="cell">{formatTokens(row.cachedTokens)}</span>
                <span role="cell">
                  {row.costUsd === null ? (
                    <span className="unknown-value">Unknown</span>
                  ) : (
                    `$${row.costUsd.toFixed(2)}`
                  )}
                </span>
                <span role="cell">
                  <Badge tone={row.costComplete ? "success" : "attention"}>
                    {row.costComplete ? "Complete" : "Unpriced"}
                  </Badge>
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="cost-columns">
        <Card title="Budget" eyebrow="Optional">
          <EmptyState
            icon={<InfoIcon size={26} />}
            title="No budget configured"
            description="A budget is a local threshold with a visible warning. It never blocks the engine silently or invents a remaining balance."
            action={
              <Button size="sm" variant="secondary">
                Set a budget
              </Button>
            }
          />
        </Card>
        <Card title="How this is calculated" eyebrow="Zero inference">
          <ul className="rule-list">
            <li>
              <SparkIcon size={15} /> Totals come from engine usage records; Mona does not call a
              model to summarize cost.
            </li>
            <li>
              Cache evidence is shown separately. A provider cache hit is best effort, not a
              guarantee.
            </li>
            <li>
              An unpriced turn keeps the honest label “unknown” and excludes itself from a complete
              total.
            </li>
            <li>
              Replayed events are deduplicated by thread, turn, and cursor; a reconnect cannot
              double-charge.
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
