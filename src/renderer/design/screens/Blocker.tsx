import type { JSX } from "react";
import { fixtureAttempts, fixtureBlocker } from "../fixtures";
import { Badge, Button, Callout, Card, ScreenHeader } from "../primitives";
import { ArrowUpRightIcon, CheckIcon, CloseIcon, InfoIcon, WarningIcon } from "../icons";
import type { Scenario } from "./types";

export function BlockerScreen({ scenario }: { scenario: Scenario }): JSX.Element {
  const attempts = scenario === "empty" ? [] : fixtureAttempts;
  return (
    <div className="screen screen--blocker">
      <ScreenHeader
        eyebrow="Blocker"
        title="One problem, three attempts, one honest stop"
        lede="A blocker card records what failed, what was tried, and the exact input that would unblock it. Acknowledging the card does not clear it or reset the counter."
        actions={
          <>
            <Button variant="secondary" icon={<InfoIcon size={15} />}>
              Copy details
            </Button>
            <Button variant="primary" icon={<WarningIcon size={15} />}>
              Open evidence
            </Button>
          </>
        }
      />

      <div className="blocker-layout">
        <div className="blocker-main">
          <Card tone="danger" className="blocker-card">
            <div className="blocker-card__top">
              <Badge tone="danger" icon={<WarningIcon size={14} />}>
                Blocked
              </Badge>
              <span className="mono blocker-card__id">{fixtureBlocker.problemId}</span>
              <span className="blocker-card__requirement">
                Affects {fixtureBlocker.requirement}
              </span>
            </div>
            <h2 className="blocker-card__title">{fixtureBlocker.title}</h2>
            <p className="blocker-card__impact">{fixtureBlocker.impact}</p>

            <section className="attempts" aria-labelledby="attempts-heading">
              <h3 className="attempts__heading" id="attempts-heading">
                Three attempts
              </h3>
              <ol className="attempt-list">
                {attempts.map((attempt) => (
                  <li className="attempt" key={attempt.number}>
                    <span
                      className={`attempt__marker ${attempt.progress ? "attempt__marker--progress" : ""}`}
                    >
                      {attempt.progress ? <CheckIcon size={14} /> : <CloseIcon size={14} />}
                    </span>
                    <div className="attempt__body">
                      <p className="attempt__title">
                        Attempt {attempt.number}
                        <Badge tone={attempt.progress ? "success" : "neutral"}>
                          {attempt.progress ? "Material progress" : "No progress"}
                        </Badge>
                      </p>
                      <dl className="detail-list detail-list--tight">
                        <div className="detail-row">
                          <dt>Hypothesis</dt>
                          <dd>{attempt.hypothesis}</dd>
                        </div>
                        <div className="detail-row">
                          <dt>Action</dt>
                          <dd>{attempt.action}</dd>
                        </div>
                        <div className="detail-row">
                          <dt>Observed</dt>
                          <dd>{attempt.observed}</dd>
                        </div>
                      </dl>
                      <Button size="sm" variant="ghost" icon={<ArrowUpRightIcon size={14} />}>
                        Evidence
                      </Button>
                    </div>
                  </li>
                ))}
                {attempts.length === 0 ? (
                  <li className="attempt attempt--empty">No attempts recorded for this problem.</li>
                ) : null}
              </ol>
            </section>

            <Callout tone="attention" title="Help needed from Victor">
              {fixtureBlocker.helpNeeded}
            </Callout>

            <div className="blocker-card__actions">
              <Button variant="secondary">Acknowledge (does not clear)</Button>
              <Button variant="primary">Mark unblocked with new evidence</Button>
            </div>
          </Card>

          <Card title="Nonblocking issue" eyebrow="Visible while independent work continues">
            <div className="issue-row">
              <Badge tone="attention">Nonblocking</Badge>
              <p>
                A second macOS account has not been used to verify cross-user isolation. Path modes
                and the absence of stored tokens are verified; the literal multi-account test is
                scheduled for P24.
              </p>
            </div>
            <p className="hint-line">
              This issue does not pause the dependency chain. It is carried in the handoff until it
              is resolved or explicitly accepted.
            </p>
          </Card>
        </div>

        <aside className="blocker-side" aria-label="Blocker details">
          <Card title="Affected requirements" eyebrow="Traceability">
            <ul className="requirement-list">
              {fixtureBlocker.affected.map((requirement) => (
                <li key={requirement} className="requirement-row">
                  <span className="requirement-row__id mono">{requirement}</span>
                  <Badge tone="attention">Blocked</Badge>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Attempt rule" eyebrow="Enforced in code">
            <p>
              Three consecutive attempts without material progress stop that problem. A new session,
              a different model, or a rewritten error message does not reset the count.
            </p>
            <p className="hint-line">
              Total attempts and consecutive no-progress attempts are stored separately.
            </p>
          </Card>
          <Card title="Evidence" eyebrow="Linked, not summarized">
            <ul className="evidence-list">
              {attempts.map((attempt) => (
                <li key={attempt.number}>
                  <span className="mono">{attempt.evidence}</span>
                </li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}
