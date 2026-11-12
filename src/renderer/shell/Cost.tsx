import type { JSX } from "react";
import type { ProjectDetail } from "../../shared/contracts/project-bridge";
import { Badge, Button, Callout, Card, EmptyState, ScreenHeader } from "../design/primitives";
import { CostIcon, FolderIcon, InfoIcon } from "../design/icons";
import { formatTokens } from "./visual";

export function CostScreen({
  detail,
  onOpenFolder,
}: {
  detail: ProjectDetail | null;
  onOpenFolder: () => void;
}): JSX.Element {
  if (!detail) {
    return (
      <div className="screen">
        <Card>
          <EmptyState
            icon={<FolderIcon size={30} />}
            title="Choose a project"
            description="Cost is shown per project from engine-reported usage. Mona adds no inference of its own."
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

  const usage = detail.usage;
  const unpriced = usage.byModel.filter((row) => !row.costComplete).length;
  return (
    <div className="screen screen--cost">
      <ScreenHeader
        eyebrow="Cost lens"
        title="Understand spending without invented precision"
        lede={`${detail.project.name} · provider-reported usage only. Unknown is not zero, and no balance is inferred.`}
      />

      {!usage.observed ? (
        <Card>
          <EmptyState
            icon={<CostIcon size={30} />}
            title="No usage recorded for this project"
            description="Browsing, navigation, status, and the shell make no model calls. Usage appears only after the engine reports a completed or interrupted turn."
          />
        </Card>
      ) : (
        <>
          {!usage.costComplete ? (
            <Callout tone="attention" title="Spend is incomplete — unknown is not zero">
              {unpriced === 1
                ? "One model row is unpriced."
                : `${unpriced} model rows are unpriced.`}{" "}
              The observed subtotal is ${usage.costUsd.toFixed(2)}; no exact total or balance claim
              is made.
            </Callout>
          ) : null}

          <section className="metric-grid" aria-label="Usage summary">
            <Card className="metric">
              <p className="metric__label">Observed spend</p>
              <p className="metric__value">
                ${usage.costUsd.toFixed(2)}
                {!usage.costComplete ? <span className="metric__qualifier"> at least</span> : null}
              </p>
              <p className="metric__detail">
                {usage.costComplete
                  ? "Every observed turn has price evidence."
                  : "Unpriced turns are excluded from the number."}
              </p>
            </Card>
            <Card className="metric">
              <p className="metric__label">Turns</p>
              <p className="metric__value">{usage.turns}</p>
              <p className="metric__detail">
                Completed or interrupted turns recorded for this project.
              </p>
            </Card>
            <Card className="metric">
              <p className="metric__label">Input tokens</p>
              <p className="metric__value">{formatTokens(usage.inputTokens)}</p>
              <p className="metric__detail">Provider-reported, not estimated from characters.</p>
            </Card>
            <Card className="metric">
              <p className="metric__label">Cached input</p>
              <p className="metric__value">{formatTokens(usage.cachedTokens)}</p>
              <p className="metric__detail">Cache evidence is best effort, not a guarantee.</p>
            </Card>
          </section>

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
              {usage.byModel.map((row) => (
                <div className="table__row" role="row" key={`${row.provider}-${row.model}`}>
                  <span role="cell" className="table__model">
                    {row.model}
                  </span>
                  <span role="cell">{row.turns}</span>
                  <span role="cell">{formatTokens(row.inputTokens)}</span>
                  <span role="cell">{formatTokens(row.cachedTokens)}</span>
                  <span role="cell">
                    {row.costComplete ? (
                      `$${row.costUsd.toFixed(2)}`
                    ) : (
                      <span className="unknown-value">Unknown</span>
                    )}
                  </span>
                  <span role="cell">
                    <Badge tone={row.costComplete ? "success" : "attention"}>
                      {row.costComplete ? "Complete" : "Incomplete"}
                    </Badge>
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card title="How this is calculated" eyebrow="Zero inference">
            <ul className="rule-list">
              <li>
                <InfoIcon size={15} /> Totals come from engine usage records. The shell never calls
                a model to summarize cost.
              </li>
              <li>
                <InfoIcon size={15} /> An unpriced turn keeps the honest label “unknown” and is
                excluded from a complete total.
              </li>
              <li>
                <InfoIcon size={15} /> Replayed events are deduplicated by thread, turn, and cursor;
                a reconnect cannot double-charge.
              </li>
              <li>
                <InfoIcon size={15} /> Budgets, attribution details, and export arrive in P12. No
                budget is configured here.
              </li>
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
