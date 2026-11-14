import type { JSX } from "react";
import type { StudioUsageScopeView, StudioUsageView } from "../../shared/contracts/usage-hud";
import type { StudioProfileView, StudioConnection } from "../../shared/contracts/studio";
import { Badge } from "../design/primitives";

/**
 * R09 — the usage HUD.
 *
 * Three scopes, always labelled, always read from stored receipts. The strip
 * carries only the numbers; provenance, budget state, model and permission live
 * one disclosure away so the console stays readable while the facts stay
 * reachable. Nothing here fetches: opening the detail is a render, not a call.
 */

const STATE_LABEL: Record<StudioUsageScopeView["state"], string> = {
  waiting: "Waiting for usage",
  complete: "Complete",
  partial: "Partial",
  unpriced: "Unpriced",
  empty: "None recorded",
};

const STATE_TONE: Record<
  StudioUsageScopeView["state"],
  "neutral" | "attention" | "success" | "danger"
> = {
  waiting: "neutral",
  complete: "success",
  partial: "attention",
  unpriced: "attention",
  empty: "neutral",
};

function scopeName(view: StudioUsageScopeView): string {
  return view.scope === "turn" ? "Turn" : view.scope === "thread" ? "Thread" : "Project";
}

function semanticsText(view: StudioUsageScopeView): string {
  switch (view.tokenSemantics) {
    case "inclusive_input":
      return "Input excludes the cached prefix (the engine reports an inclusive input count).";
    case "exclusive_input":
      return "Input and cached input are separate native counts.";
    case "mixed":
      return "Stored rows disagree about token semantics, so no subtraction was applied; cached input is shown separately and may overlap input.";
    default:
      return "The engine did not state how its token counts relate; nothing was inferred.";
  }
}

export function UsageHud({
  usage,
  profile,
  connection,
  readAtLabel,
}: {
  usage: StudioUsageView | null | undefined;
  profile: StudioProfileView | null;
  connection: StudioConnection | null;
  /** The screen's own clock label for the read, so tests can pin it. */
  readAtLabel?: string;
}): JSX.Element | null {
  if (!usage) return null;
  const scopes = [usage.turn, usage.thread, usage.project];
  return (
    <section className="usage-hud" aria-label="Usage and cost" data-testid="usage-hud">
      <span className="usage-hud__title">Usage</span>
      {scopes.map((view) => (
        <span
          key={view.scope}
          className={`usage-scope usage-scope--${view.state}`}
          data-testid={`usage-${view.scope}`}
          data-state={view.state}
        >
          <span className="usage-scope__name">{scopeName(view)}</span>
          <span className="usage-scope__value" title={view.note ?? undefined}>
            {view.label}
          </span>
          {view.state === "partial" || view.state === "unpriced" || view.state === "waiting" ? (
            <Badge tone={STATE_TONE[view.state]}>{STATE_LABEL[view.state]}</Badge>
          ) : null}
        </span>
      ))}
      <details className="usage-hud__detail" data-testid="usage-detail">
        <summary>Detail</summary>
        <div className="usage-hud__panel">
          <dl className="detail-list">
            {scopes.map((view) => (
              <div className="detail-row" key={view.scope}>
                <dt>{scopeName(view)}</dt>
                <dd data-testid={`usage-${view.scope}-note`}>
                  {view.turns} turn{view.turns === 1 ? "" : "s"} · {STATE_LABEL[view.state]}
                  {view.note ? ` — ${view.note}` : ""}
                </dd>
              </div>
            ))}
            <div className="detail-row">
              <dt>Tokens</dt>
              <dd>
                {semanticsText(usage.thread.state === "empty" ? usage.project : usage.thread)}
              </dd>
            </div>
            <div className="detail-row">
              <dt>Source</dt>
              <dd data-testid="usage-provenance">
                Stored usage receipts, read {readAtLabel ?? "just now"}. Nothing is polled or
                estimated live.
              </dd>
            </div>
            <div className="detail-row">
              <dt>Model</dt>
              <dd>
                {profile
                  ? `${profile.provider} / ${profile.model} (${profile.effective ? "observed" : "configured"})`
                  : "Not reported"}
                {profile?.effective?.usedFallback ? " · a fallback model ran" : ""}
              </dd>
            </div>
            <div className="detail-row">
              <dt>Permission</dt>
              <dd>
                {profile?.effective?.permissionPosture ?? profile?.permissionPosture ?? "Unknown"}
              </dd>
            </div>
            <div className="detail-row">
              <dt>Engine</dt>
              <dd data-testid="usage-connection">{connection?.state ?? "not_started"}</dd>
            </div>
            <div className="detail-row">
              <dt>Budgets</dt>
              <dd data-testid="usage-budgets">
                {usage.budgets.length === 0
                  ? "No budget is set for this project."
                  : usage.budgets
                      .map(
                        (budget) =>
                          `${budget.scope}: ${budget.complete ? "" : "at least "}$${budget.knownUsd.toFixed(4)} of $${budget.limitUsd.toFixed(2)} · ${budget.level}`,
                      )
                      .join("; ")}
              </dd>
            </div>
          </dl>
        </div>
      </details>
    </section>
  );
}
