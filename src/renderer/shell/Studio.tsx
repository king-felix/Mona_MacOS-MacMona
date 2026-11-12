import type { JSX } from "react";
import type { ProjectDetail } from "../../shared/contracts/project-bridge";
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Inspector,
  StatusBadge,
  TabPanel,
  Tabs,
  TextArea,
  type WorkStatus,
} from "../design/primitives";
import {
  BranchIcon,
  CheckIcon,
  ClockIcon,
  CostIcon,
  FolderIcon,
  InfoIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  SparkIcon,
  StopIcon,
  TerminalIcon,
  WarningIcon,
} from "../design/icons";
import { engineBadge, formatTokens, projectAccent, projectMonogram, relativeTime } from "./visual";

export interface StudioProps {
  detail: ProjectDetail | null;
  draft: string;
  draftStatus: "idle" | "saving" | "saved" | "error";
  inspectorTab: string;
  onInspectorTab: (tab: string) => void;
  onDraft: (text: string) => void;
  onOpenFolder: () => void;
  onShowBoard: () => void;
}

function eventText(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["text", "message", "delta", "summary", "reason", "status"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

const EVENT_ICON = {
  user: <SparkIcon size={15} />,
  assistant: <SparkIcon size={15} />,
  tool: <TerminalIcon size={15} />,
  test: <CheckIcon size={15} />,
  status: <InfoIcon size={15} />,
  error: <WarningIcon size={15} />,
} as const;

function eventIcon(kind: string): JSX.Element {
  if (kind.includes("error") || kind.includes("fail")) return EVENT_ICON.error;
  if (kind.includes("tool")) return EVENT_ICON.tool;
  if (kind.includes("test")) return EVENT_ICON.test;
  if (kind.includes("status") || kind.includes("progress")) return EVENT_ICON.status;
  if (kind.includes("user")) return EVENT_ICON.user;
  return EVENT_ICON.assistant;
}

export function StudioScreen(props: StudioProps): JSX.Element {
  const { detail, draft, draftStatus, inspectorTab } = props;
  if (!detail) {
    return (
      <div className="screen">
        <Card>
          <EmptyState
            icon={<FolderIcon size={30} />}
            title="Choose a project"
            description="Open a folder or select a project from Home. Mona reads local state only; it does not start an engine or resume work automatically."
            action={
              <Button
                variant="primary"
                onClick={props.onOpenFolder}
                icon={<FolderIcon size={16} />}
              >
                Open folder
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const { project, engine, usage } = detail;
  const health = engineBadge(engine);
  const blockedTasks = detail.tasks.filter((task) => task.status === "blocked");
  const currentTask =
    detail.tasks.find((task) => task.status === "running") ??
    detail.tasks.find((task) => task.status === "blocked") ??
    detail.tasks[0] ??
    null;

  return (
    <div className="screen screen--studio">
      <div className="context-bar">
        <div className="context-bar__identity">
          <span className={`monogram monogram--${projectAccent(project)}`} aria-hidden="true">
            {projectMonogram(project)}
          </span>
          <div className="context-bar__text">
            <h1 className="context-bar__title">{project.name}</h1>
            <span className="context-bar__path mono" title={project.rootPath}>
              {project.rootPath}
            </span>
          </div>
        </div>
        <div className="context-bar__facts">
          <span className="fact">
            <BranchIcon size={14} />
            <span className="fact__label">Branch</span>
            <span className="fact__value">{detail.branch ?? "Not a Git repository"}</span>
          </span>
          <span className="fact">
            <span
              className={`status-dot ${engine.canExecute ? "status-dot--success" : "status-dot--attention"}`}
              aria-hidden="true"
            />
            <span className="fact__label">Engine</span>
            <Badge tone={health.tone}>{health.label}</Badge>
          </span>
          <span className="fact">
            <SparkIcon size={14} />
            <span className="fact__label">Model</span>
            <span className="fact__value">Not reported while disconnected</span>
          </span>
          <span className="fact">
            <LockIcon size={14} />
            <span className="fact__label">Permission</span>
            <span className="fact__value">Unknown until a turn reports it</span>
          </span>
          <span className="fact">
            <CostIcon size={14} />
            <span className="fact__label">Spend</span>
            <span className={`fact__value ${usage.costComplete ? "" : "fact__value--unknown"}`}>
              {usage.observed
                ? usage.costComplete
                  ? `$${usage.costUsd.toFixed(2)}`
                  : `At least $${usage.costUsd.toFixed(2)}`
                : "No usage recorded"}
            </span>
          </span>
        </div>
      </div>

      {engine.blockedReason ? (
        <Callout tone="attention" title="Execution is not available for this project">
          {engine.blockedReason} History and settings remain usable. Live execution and streaming
          arrive in P08.
        </Callout>
      ) : (
        <Callout tone="success" title="Runtime connected to this workspace">
          Mona will not start a turn until you explicitly submit one. Live submission arrives in
          P08.
        </Callout>
      )}

      <div className="studio">
        <section className="studio__main" aria-label="Work timeline">
          <div className="studio__timeline" tabIndex={0} aria-label="Work timeline, scrollable">
            {detail.events.length === 0 ? (
              <EmptyState
                icon={<ClockIcon size={26} />}
                title="No engine history stored yet"
                description="Mona stores thread, turn, and event projections only when the engine reports them. Nothing is simulated here."
              />
            ) : (
              <ol className="timeline">
                {detail.events.map((event) => {
                  const text = eventText(event.payload);
                  return (
                    <li
                      key={`${event.threadId}-${event.seq}`}
                      className={`timeline-event timeline-event--${event.kind.split(".")[0] ?? "status"}`}
                    >
                      <span className="timeline-event__rail" aria-hidden="true">
                        <span className="timeline-event__icon">{eventIcon(event.kind)}</span>
                      </span>
                      <div className="timeline-event__body">
                        <div className="timeline-event__head">
                          <span className="timeline-event__title">{event.kind}</span>
                          <span className="timeline-event__time">
                            {new Date(event.timestamp).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                        {text ? <p className="timeline-event__text">{text}</p> : null}
                        <p className="timeline-event__detail mono">
                          seq {event.seq} · {event.threadId}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>

          <div className="composer">
            <TextArea
              label="Draft prompt"
              hint="Saved locally for this project and thread. Sending is disabled until the live studio lands in P08 and a runtime is connected."
              placeholder="Describe one concrete outcome, its boundaries, and how to verify it…"
              rows={4}
              value={draft}
              onChange={(event) => props.onDraft(event.target.value)}
            />
            <div className="composer__actions">
              <div className="composer__left">
                <span className="hint-line" aria-live="polite">
                  {draftStatus === "saving"
                    ? "Saving draft…"
                    : draftStatus === "saved"
                      ? "Draft saved locally"
                      : draftStatus === "error"
                        ? "Draft could not be saved"
                        : "Draft is local to this project"}
                </span>
              </div>
              <div className="composer__right">
                <Button
                  variant="primary"
                  icon={<PlayIcon size={15} />}
                  disabled
                  title="Live submission is implemented in P08"
                >
                  Send to engine
                </Button>
              </div>
            </div>
          </div>
        </section>

        <aside className="studio__inspector" aria-label="Inspector">
          <Tabs
            label="Inspector sections"
            value={inspectorTab}
            onChange={props.onInspectorTab}
            tabs={[
              { id: "task", label: "Task" },
              { id: "requirements", label: "Requirements" },
              { id: "context", label: "Context" },
            ]}
          />
          <TabPanel id="task" active={inspectorTab === "task"}>
            {currentTask ? (
              <Inspector
                title="Current task"
                actions={<StatusBadge status={currentTask.status as WorkStatus} />}
                label="Current task"
              >
                <p className="inspector__task-title">{currentTask.title}</p>
                <dl className="detail-list">
                  <div className="detail-row">
                    <dt>Task</dt>
                    <dd className="mono">{currentTask.id}</dd>
                  </div>
                  <div className="detail-row">
                    <dt>Updated</dt>
                    <dd>{relativeTime(currentTask.updatedAt)}</dd>
                  </div>
                  <div className="detail-row">
                    <dt>Depends on</dt>
                    <dd>
                      {currentTask.dependsOn.length === 0
                        ? "Nothing"
                        : currentTask.dependsOn.join(", ")}
                    </dd>
                  </div>
                </dl>
                <div className="inspector__actions">
                  <Button size="sm" variant="secondary" onClick={props.onShowBoard}>
                    Open work board
                  </Button>
                </div>
              </Inspector>
            ) : (
              <EmptyState
                icon={<ClockIcon size={24} />}
                title="No tasks yet"
                description="Tasks are created explicitly. Mona does not infer a task or a percentage from project activity."
              />
            )}
          </TabPanel>
          <TabPanel id="requirements" active={inspectorTab === "requirements"}>
            {detail.evidence.length === 0 ? (
              <EmptyState
                icon={<InfoIcon size={24} />}
                title="No requirement evidence"
                description="Evidence appears here when a task records it. Completion is never inferred from a checked box."
              />
            ) : (
              <ul className="requirement-list">
                {detail.evidence.map((entry) => (
                  <li className="requirement-row" key={`${entry.requirementId}-${entry.path}`}>
                    <span className="requirement-row__id mono">{entry.requirementId}</span>
                    <span className="requirement-row__title mono">{entry.path}</span>
                  </li>
                ))}
              </ul>
            )}
          </TabPanel>
          <TabPanel id="context" active={inspectorTab === "context"}>
            <Card title="Context" eyebrow="Real local state">
              <dl className="detail-list">
                <div className="detail-row">
                  <dt>Repository</dt>
                  <dd>
                    {detail.project.repositoryKind === "none"
                      ? "Plain folder"
                      : detail.project.repositoryKind}
                  </dd>
                </div>
                <div className="detail-row">
                  <dt>Threads</dt>
                  <dd>{detail.threads.length}</dd>
                </div>
                <div className="detail-row">
                  <dt>Events</dt>
                  <dd>{detail.events.length} stored</dd>
                </div>
                <div className="detail-row">
                  <dt>Runtime</dt>
                  <dd>{engine.blockedReason ?? "Connected"}</dd>
                </div>
                <div className="detail-row">
                  <dt>Binding</dt>
                  <dd className="mono wrap">
                    {engine.binding
                      ? `${engine.binding.executable} · ${engine.binding.state}`
                      : "No runtime binding"}
                  </dd>
                </div>
                <div className="detail-row">
                  <dt>Tokens</dt>
                  <dd>
                    {formatTokens(usage.inputTokens)} input · {formatTokens(usage.outputTokens)}{" "}
                    output
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
            className={`status-dot ${engine.canExecute ? "status-dot--success" : "status-dot--attention"}`}
            aria-hidden="true"
          />
          <span>
            {engine.canExecute ? "Runtime connected · no active turn" : "No active run"}
            {blockedTasks.length > 0
              ? ` · ${blockedTasks.length} blocked task${blockedTasks.length === 1 ? "" : "s"}`
              : ""}
          </span>
        </div>
        <div className="control-strip__actions">
          <Button
            size="sm"
            variant="secondary"
            icon={<PauseIcon size={14} />}
            disabled
            title="Wired in P08"
          >
            Pause after task
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={<StopIcon size={14} />}
            disabled
            title="Wired in P08"
          >
            Interrupt now
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<WarningIcon size={14} />}
            onClick={props.onShowBoard}
          >
            Blockers
          </Button>
        </div>
      </div>
    </div>
  );
}
