import { useState, type JSX } from "react";
import {
  fixtureEvents,
  fixtureProjects,
  fixtureRequirements,
  fixtureRoute,
  fixtureTasks,
  type EventKind,
  type FixtureEvent,
} from "../fixtures";
import {
  Badge,
  Button,
  Callout,
  Card,
  IconButton,
  Inspector,
  SegmentedControl,
  StatusBadge,
  TabPanel,
  Tabs,
  TextArea,
  KeyCap,
} from "../primitives";
import {
  BranchIcon,
  CheckIcon,
  CommandIcon,
  CostIcon,
  FolderIcon,
  InfoIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  ShieldIcon,
  SparkIcon,
  StopIcon,
  TerminalIcon,
  WarningIcon,
} from "../icons";
import type { Scenario } from "./types";

const EVENT_ICON: Record<EventKind, JSX.Element> = {
  user: <SparkIcon size={15} />,
  assistant: <SparkIcon size={15} />,
  tool: <TerminalIcon size={15} />,
  test: <CheckIcon size={15} />,
  status: <InfoIcon size={15} />,
  error: <WarningIcon size={15} />,
};

function TimelineEvent({ event }: { event: FixtureEvent }): JSX.Element {
  return (
    <li className={`timeline-event timeline-event--${event.kind}`}>
      <span className="timeline-event__rail" aria-hidden="true">
        <span className="timeline-event__icon">{EVENT_ICON[event.kind]}</span>
      </span>
      <div className="timeline-event__body">
        <div className="timeline-event__head">
          <span className="timeline-event__title">{event.title}</span>
          <span className="timeline-event__time">{event.at}</span>
        </div>
        {event.body ? <p className="timeline-event__text">{event.body}</p> : null}
        {event.detail ? <p className="timeline-event__detail mono">{event.detail}</p> : null}
      </div>
    </li>
  );
}

export function StudioScreen({ scenario }: { scenario: Scenario }): JSX.Element {
  const project = fixtureProjects[0];
  const task = fixtureTasks[1];
  const [inspectorTab, setInspectorTab] = useState("task");
  const [mode, setMode] = useState("work");
  const disconnected = scenario === "disconnected";
  const unknownCost = scenario === "unknown-cost";
  const blocked = scenario === "blocked";

  if (!project || !task) return <div className="screen" />;

  return (
    <div className="screen screen--studio">
      <div className="context-bar">
        <div className="context-bar__identity">
          <span className="monogram monogram--violet" aria-hidden="true">
            {project.monogram}
          </span>
          <div className="context-bar__text">
            <h1 className="context-bar__title">{project.name}</h1>
            <span className="context-bar__path mono" title={project.path}>
              {project.path}
            </span>
          </div>
        </div>
        <div className="context-bar__facts">
          <span className="fact">
            <BranchIcon size={14} />
            <span className="fact__label">Branch</span>
            <span className="fact__value">{project.branch}</span>
          </span>
          <span className="fact">
            <span
              className={`status-dot ${disconnected ? "status-dot--attention" : "status-dot--success"}`}
              aria-hidden="true"
            />
            <span className="fact__label">Engine</span>
            <span className="fact__value">{disconnected ? "Disconnected" : "Running"}</span>
          </span>
          <span className="fact">
            <SparkIcon size={14} />
            <span className="fact__label">Model</span>
            <span className="fact__value">{fixtureRoute.model}</span>
          </span>
          <span className="fact">
            <ShieldIcon size={14} />
            <span className="fact__label">Permission</span>
            <Badge tone="attention" icon={<LockIcon size={13} />}>
              {fixtureRoute.permission}
            </Badge>
          </span>
          <span className="fact">
            <CostIcon size={14} />
            <span className="fact__label">Spend</span>
            <span className={unknownCost ? "fact__value fact__value--unknown" : "fact__value"}>
              {unknownCost ? "Unknown" : "$0.42 observed"}
            </span>
          </span>
          <Button variant="ghost" size="sm" icon={<CommandIcon size={15} />}>
            Command <KeyCap>K</KeyCap>
          </Button>
        </div>
      </div>

      {disconnected ? (
        <Callout
          tone="attention"
          title="Disconnected — history is readable, execution is paused"
          action={
            <Button size="sm" variant="secondary">
              Reconnect
            </Button>
          }
        >
          The runtime is not owned right now. Your draft and the last verified record are preserved.
          Mona will reconcile before it continues.
        </Callout>
      ) : null}

      {blocked ? (
        <Callout
          tone="danger"
          title="One task is blocked after three attempts"
          action={
            <Button size="sm" variant="secondary">
              Open blocker
            </Button>
          }
        >
          The dependency chain pauses here; independent work can continue.
        </Callout>
      ) : null}

      <div className="studio">
        <section className="studio__main" aria-label="Work timeline">
          <div className="studio__timeline" tabIndex={0} aria-label="Work timeline, scrollable">
            <ol className="timeline">
              {fixtureEvents.map((event) => (
                <TimelineEvent key={event.id} event={event} />
              ))}
            </ol>
          </div>

          <div className="composer">
            <TextArea
              label="Assign a bounded prompt"
              hint={
                disconnected
                  ? "Execution is disabled while the runtime is disconnected. The draft stays with this project."
                  : `Effective route: ${fixtureRoute.provider} / ${fixtureRoute.model} · profile ${fixtureRoute.profile}. No prompt suffix is added for UI metadata.`
              }
              placeholder="Describe one concrete outcome, its boundaries, and how to verify it…"
              rows={4}
              defaultValue={
                disconnected
                  ? "Resume the work from the checkpoint. Reconcile first; do not replay a possibly executed turn."
                  : ""
              }
              disabled={disconnected}
            />
            <div className="composer__actions">
              <div className="composer__left">
                <Button variant="ghost" size="sm" icon={<FolderIcon size={15} />}>
                  Attach file
                </Button>
                <SegmentedControl
                  label="Execution mode"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: "plan", label: "Plan" },
                    { value: "work", label: "Work" },
                  ]}
                />
              </div>
              <div className="composer__right">
                <Button
                  variant="primary"
                  icon={<PlayIcon size={15} />}
                  disabled={disconnected}
                  aria-describedby={disconnected ? "composer-disabled-note" : undefined}
                >
                  Send to engine
                </Button>
              </div>
            </div>
            {disconnected ? (
              <p className="visually-hidden" id="composer-disabled-note">
                Sending is disabled because the engine is disconnected.
              </p>
            ) : null}
          </div>
        </section>

        <aside className="studio__inspector" aria-label="Inspector">
          <Tabs
            label="Inspector sections"
            value={inspectorTab}
            onChange={setInspectorTab}
            tabs={[
              { id: "task", label: "Task" },
              { id: "requirements", label: "Requirements" },
              { id: "context", label: "Context" },
            ]}
          />
          <TabPanel id="task" active={inspectorTab === "task"}>
            <Inspector
              title="Current task"
              actions={<StatusBadge status={task.status} />}
              label="Current task"
            >
              <p className="inspector__task-title">{task.title}</p>
              <dl className="detail-list">
                <div className="detail-row">
                  <dt>Task</dt>
                  <dd className="mono">{task.id}</dd>
                </div>
                <div className="detail-row">
                  <dt>Updated</dt>
                  <dd>{task.updatedAt}</dd>
                </div>
                <div className="detail-row">
                  <dt>Requirements</dt>
                  <dd>{task.requirements.join(", ")}</dd>
                </div>
                <div className="detail-row">
                  <dt>Depends on</dt>
                  <dd>{task.dependsOn.length === 0 ? "Nothing" : task.dependsOn.join(", ")}</dd>
                </div>
              </dl>
              {task.note ? <p className="inspector__note">{task.note}</p> : null}
              <div className="inspector__actions">
                <Button size="sm" variant="secondary">
                  Open evidence
                </Button>
                <Button size="sm" variant="ghost">
                  View attempts
                </Button>
              </div>
            </Inspector>
          </TabPanel>
          <TabPanel id="requirements" active={inspectorTab === "requirements"}>
            <ul className="requirement-list">
              {fixtureRequirements.map((requirement) => (
                <li key={requirement.id} className="requirement-row">
                  <span className="requirement-row__id mono">{requirement.id}</span>
                  <span className="requirement-row__title">{requirement.title}</span>
                  <Badge tone={requirement.status === "partial" ? "attention" : "neutral"}>
                    {requirement.status === "partial" ? "Partial" : "Pending"}
                  </Badge>
                </li>
              ))}
            </ul>
            <p className="hint-line">
              Completion is never inferred from a checked box; each requirement keeps its evidence.
            </p>
          </TabPanel>
          <TabPanel id="context" active={inspectorTab === "context"}>
            <Card title="Context" eyebrow="Fixture values">
              <dl className="detail-list">
                <div className="detail-row">
                  <dt>Provider</dt>
                  <dd>{fixtureRoute.provider}</dd>
                </div>
                <div className="detail-row">
                  <dt>Endpoint</dt>
                  <dd className="mono truncate">{fixtureRoute.endpoint}</dd>
                </div>
                <div className="detail-row">
                  <dt>Reasoning</dt>
                  <dd>{fixtureRoute.reasoning}</dd>
                </div>
                <div className="detail-row">
                  <dt>Key source</dt>
                  <dd>{fixtureRoute.keySource}</dd>
                </div>
                <div className="detail-row">
                  <dt>Cost</dt>
                  <dd className={unknownCost ? "unknown-value" : ""}>
                    {unknownCost ? "Unknown — one or more turns are unpriced" : "$0.42 observed"}
                  </dd>
                </div>
              </dl>
            </Card>
          </TabPanel>
        </aside>
      </div>

      <div className="control-strip" role="region" aria-label="Execution controls">
        <div className="control-strip__status">
          <span
            className={`status-dot ${disconnected ? "status-dot--attention" : "status-dot--success"}`}
            aria-hidden="true"
          />
          <span>{disconnected ? "Runtime disconnected" : "Running · one mutating turn"}</span>
        </div>
        <div className="control-strip__actions">
          <Button size="sm" variant="secondary" icon={<PauseIcon size={14} />}>
            Pause after task
          </Button>
          <Button size="sm" variant="danger" icon={<StopIcon size={14} />}>
            Interrupt now
          </Button>
          <IconButton label="Open blockers">
            <WarningIcon size={16} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
