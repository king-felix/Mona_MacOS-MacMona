import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import type { IpcResult, ProjectDetail } from "../../shared/contracts/project-bridge";
import type { ProjectId } from "../../shared/contracts/ids";
import type {
  AgentRunView,
  BranchView,
  FleetEvidenceView,
  FleetRunView,
  FleetWorkerView,
  GoalView,
  ObservatoryView,
  ParallelQualification,
  RunEventView,
  SpendView,
  ToolUsageView,
  TestEvidenceView,
} from "../../shared/contracts/agents";
import type { BoardSnapshot, TaskView } from "../../shared/contracts/board";
import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  EmptyState,
  Inspector,
  SelectField,
  TextArea,
  TextField,
  VisuallyHidden,
  type WorkStatus,
} from "../design/primitives";
import {
  BranchIcon,
  CheckIcon,
  CloseIcon,
  FolderIcon,
  RefreshIcon,
  SparkIcon,
  StopIcon,
} from "../design/icons";
import { relativeTime } from "./visual";

const ROLES = [
  "worker",
  "scout",
  "builder",
  "reviewer",
  "verifier",
  "planner",
  "consultant",
  "synthesizer",
  "manager",
  "operator",
  "custom",
] as const;

type Selection =
  | { kind: "agent"; id: string }
  | { kind: "fleet"; id: string }
  | { kind: "worker"; id: string; parentId: string }
  | null;

type Confirm =
  | { kind: "agent"; run: AgentRunView }
  | { kind: "fleet"; run: FleetRunView }
  | { kind: "worker"; worker: FleetWorkerView }
  | null;

export interface AgentsScreenProps {
  detail: ProjectDetail;
  engineThreadId: string | null;
  onOpenFolder: () => void;
  onShowStudio: () => void;
}

function errorText(error: { message: string; code?: string }): string {
  return error.code ? `${error.message} (${error.code})` : error.message;
}

async function unwrap<T>(run: () => Promise<IpcResult<T>>): Promise<T> {
  const result = await run();
  if (!result.ok) throw new Error(errorText(result.error));
  return result.value;
}

const STATUS_TONE: Record<string, WorkStatus> = {
  running: "running",
  starting: "running",
  online: "running",
  leased: "running",
  queued: "pending",
  enqueued: "pending",
  completed: "completed",
  partial: "verifying",
  failed: "failed",
  interrupted: "interrupted",
  interrupted_continuable: "interrupted",
  cancelled: "skipped",
  canceled: "skipped",
  stale: "blocked",
  unknown: "unknown",
};

function statusWord(status: string): string {
  switch (status) {
    case "online":
      return "Online";
    case "partial":
      return "Partial";
    case "interrupted_continuable":
      return "Interrupted (continuable)";
    case "enqueued":
      return "Enqueued";
    default:
      return status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ");
  }
}

function SpendLine({ spend }: { spend: SpendView }): JSX.Element {
  const label =
    spend.confidence === "priced" && spend.usd !== null
      ? `$${spend.usd.toFixed(4)}`
      : spend.confidence === "unpriced"
        ? "Tokens reported, price unknown"
        : spend.confidence === "not_reported"
          ? "Not reported"
          : "Unknown";
  const tone =
    spend.confidence === "priced"
      ? "success"
      : spend.confidence === "unknown"
        ? "neutral"
        : "attention";
  return (
    <div className="agent-spend">
      <Badge tone={tone}>{`Spend: ${label}`}</Badge>
      <span className="muted">{spend.note}</span>
    </div>
  );
}

function BranchLine({ branch }: { branch: BranchView | null }): JSX.Element {
  if (!branch) return <span className="muted">Branch not reported</span>;
  return (
    <span className="mono agent-branch">
      <BranchIcon size={14} />
      {branch.name ?? "detached"}
      {branch.head ? ` @ ${branch.head}` : ""}
    </span>
  );
}

function EventLine({ event }: { event: RunEventView | null }): JSX.Element {
  if (!event) return <p className="muted">No meaningful event recorded.</p>;
  return (
    <p className="agent-event">
      <Badge tone="neutral">{statusWord(event.status)}</Badge>{" "}
      {event.at ? <span className="muted">{relativeTime(event.at)}</span> : null}
      {event.message ? <span> · {event.message}</span> : null}
    </p>
  );
}

function ToolsLine({ tools }: { tools: ToolUsageView }): JSX.Element {
  if (tools.names.length === 0) return <p className="muted">{tools.note}</p>;
  return (
    <div className="agent-tools">
      {tools.names.map((name) => (
        <Badge key={name} tone="neutral">
          {name}
        </Badge>
      ))}
      <span className="muted">{tools.note}</span>
    </div>
  );
}

function TestsLine({ tests }: { tests: TestEvidenceView }): JSX.Element {
  const tone =
    tests.state === "verified"
      ? "success"
      : tests.state === "self_reported"
        ? "attention"
        : "neutral";
  const label =
    tests.state === "verified"
      ? "Verified"
      : tests.state === "self_reported"
        ? "Self-reported only"
        : "No test evidence";
  return (
    <div className="agent-tests">
      <Badge tone={tone}>{label}</Badge>
      <span className="muted">{tests.note}</span>
    </div>
  );
}

function Artifacts({
  artifacts,
}: {
  artifacts: Array<{
    kind: string;
    path: string;
    checksum: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
  }>;
}): JSX.Element {
  if (artifacts.length === 0) return <p className="muted">No artifacts were reported.</p>;
  return (
    <ul className="agent-artifacts">
      {artifacts.map((artifact) => (
        <li key={`${artifact.kind}:${artifact.path}`}>
          <Badge tone="neutral">{artifact.kind}</Badge>
          <span className="mono">{artifact.path}</span>
          <span className="muted">
            {artifact.sizeBytes === null ? "size unknown" : `${artifact.sizeBytes} bytes`}
            {artifact.checksum ? ` · ${artifact.checksum.slice(0, 19)}…` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ParallelCard({ parallel }: { parallel: ParallelQualification }): JSX.Element {
  return (
    <Card title="Parallel qualification" eyebrow="Serial by default">
      <p className="muted">{parallel.note}</p>
      <ul className="agent-checks">
        {parallel.checks.map((check) => (
          <li
            key={check.id}
            className={check.passed ? "agent-check agent-check--pass" : "agent-check"}
          >
            <span className="agent-check__icon" aria-hidden="true">
              {check.passed ? <CheckIcon size={14} /> : <CloseIcon size={14} />}
            </span>
            <div>
              <strong>{check.label}</strong>
              <p className="muted">{check.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function GoalCard({
  projectId,
  goals,
  engineThreadId,
  busy,
  onAction,
  onShowStudio,
}: {
  projectId: ProjectId;
  goals: GoalView[];
  engineThreadId: string | null;
  busy: boolean;
  onAction: (work: () => Promise<void>) => void;
  onShowStudio: () => void;
}): JSX.Element {
  const current = engineThreadId
    ? (goals.find((goal) => goal.threadId === engineThreadId) ?? null)
    : (goals[0] ?? null);
  // A stored goal is readable without a live thread, but every control needs
  // the engine. `stale` and a missing thread both disable the buttons.
  const controlsDisabled = busy || current === null || current.stale || engineThreadId === null;
  const [objective, setObjective] = useState("");
  const [reason, setReason] = useState("");

  return (
    <Card title="Native goals" eyebrow="Engine-owned continuation">
      {engineThreadId === null && current === null ? (
        <EmptyState
          icon={<SparkIcon size={28} />}
          title="No active studio thread"
          description="Start the studio to bind a thread. Goal controls act on that thread's engine goal and can start engine work."
          action={
            <Button variant="secondary" onClick={onShowStudio}>
              Open studio
            </Button>
          }
        />
      ) : current ? (
        <div className="agent-goal">
          <div className="agent-goal__head">
            <Badge
              tone={
                current.status === "active"
                  ? "primary"
                  : current.status === "blocked"
                    ? "danger"
                    : "neutral"
              }
            >
              {current.status}
            </Badge>
            {current.stale ? <Badge tone="attention">Stored observation</Badge> : null}
            <span className="mono">{current.goalId ?? current.threadId}</span>
          </div>
          <p className="agent-goal__objective">{current.objective}</p>
          <dl className="agent-facts">
            <div>
              <dt>Tokens used</dt>
              <dd>{current.tokensUsed === null ? "unknown" : current.tokensUsed}</dd>
            </div>
            <div>
              <dt>Time used</dt>
              <dd>
                {current.timeUsedSeconds === null ? "unknown" : `${current.timeUsedSeconds}s`}
              </dd>
            </div>
            <div>
              <dt>Continuations</dt>
              <dd>{current.continuationCount === null ? "unknown" : current.continuationCount}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{current.updatedAt ? relativeTime(current.updatedAt) : "unknown"}</dd>
            </div>
          </dl>
          <div className="button-row">
            <Button
              size="sm"
              variant="secondary"
              disabled={controlsDisabled}
              onClick={() =>
                onAction(async () => {
                  await unwrap(() =>
                    window.mona.completeThreadGoal(projectId, current.threadId as never),
                  );
                })
              }
            >
              Complete
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={controlsDisabled}
              onClick={() =>
                onAction(async () => {
                  await unwrap(() =>
                    window.mona.blockThreadGoal(
                      projectId,
                      current.threadId as never,
                      reason.trim() || null,
                    ),
                  );
                  setReason("");
                })
              }
            >
              Block
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={controlsDisabled}
              onClick={() =>
                onAction(async () => {
                  await unwrap(() =>
                    window.mona.clearThreadGoal(projectId, current.threadId as never),
                  );
                })
              }
            >
              Clear goal
            </Button>
          </div>
          <TextField
            label="Block note"
            hint="Stored in Mona's local event log; the engine block route carries no reason field."
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={2000}
          />
          <p className="muted">
            Pause is not exposed by this runtime over HTTP. Block and clear are the honest controls;
            Mona does not fake a pause.
          </p>
          {engineThreadId === null || current.stale ? (
            <p className="muted">
              This goal comes from a stored observation. Start the studio to change it.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="agent-goal">
          <p className="muted">
            No engine goal is set for this thread. Setting one makes the engine start goal
            continuation work.
          </p>
          <TextArea
            label="Objective"
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            rows={3}
            maxLength={4000}
            hint="The engine owns continuation. Mona sets the objective and reads its state."
          />
          <div className="button-row">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || objective.trim().length === 0 || engineThreadId === null}
              onClick={() =>
                onAction(async () => {
                  await unwrap(() =>
                    window.mona.setThreadGoal(projectId, engineThreadId as never, objective.trim()),
                  );
                  setObjective("");
                })
              }
            >
              Set goal
            </Button>
          </div>
          <TextField
            label="Block note"
            hint="Used only when you block an existing goal; stored locally."
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={2000}
          />
        </div>
      )}
    </Card>
  );
}

function LaunchCard({
  tasks,
  busy,
  onAction,
  onShowStudio,
}: {
  tasks: TaskView[];
  busy: boolean;
  onAction: (work: () => Promise<void>) => void;
  onShowStudio: () => void;
}): JSX.Element {
  const eligible = tasks.filter(
    (task) =>
      task.owner === "native_workflow" &&
      ["pending", "interrupted", "blocked"].includes(task.status),
  );
  const [taskId, setTaskId] = useState("");
  const [name, setName] = useState("Native fleet task");
  const [role, setRole] = useState<(typeof ROLES)[number]>("worker");
  const [instructions, setInstructions] = useState("");

  const chosen = eligible.find((task) => task.id === taskId) ?? null;
  return (
    <Card title="Launch a native fleet task" eyebrow="One task, serial">
      {eligible.length === 0 ? (
        <EmptyState
          icon={<SparkIcon size={28} />}
          title="No eligible native task"
          description="A fleet run may start only a board task whose execution owner is native_workflow. Change the owner on the work board; Mona never lets its queue and a fleet start the same task."
          action={
            <Button variant="secondary" onClick={onShowStudio}>
              Open studio
            </Button>
          }
        />
      ) : (
        <div className="agent-launch">
          <SelectField
            label="Board task"
            value={taskId}
            options={[
              { value: "", label: "Choose a native_workflow task…" },
              ...eligible.map((task) => ({
                value: task.id,
                label: `${task.title} (${task.status})`,
              })),
            ]}
            onChange={(event) => {
              setTaskId(event.target.value);
              const task = eligible.find((candidate) => candidate.id === event.target.value);
              if (task) setName(task.title);
            }}
          />
          <TextField
            label="Run name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
          />
          <SelectField
            label="Role"
            hint="Built-in engine roles. A reviewer is read-only; a builder can write."
            value={role}
            options={ROLES.map((candidate) => ({ value: candidate, label: candidate }))}
            onChange={(event) => setRole(event.target.value as (typeof ROLES)[number])}
          />
          <TextArea
            label="Instructions"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={4}
            maxLength={100000}
            hint="Shown to the worker and billable. The task prompt is not automatically copied."
          />
          <p className="muted">
            {chosen
              ? `The task enters running, the fleet owns its dispatch, and a terminal run moves it to verification — never straight to complete.`
              : "The engine owns execution. Mona records the run link and monitors it."}
          </p>
          <Button
            size="sm"
            variant="primary"
            disabled={
              busy || !chosen || name.trim().length === 0 || instructions.trim().length === 0
            }
            onClick={() =>
              onAction(async () => {
                if (!chosen) return;
                await unwrap(() =>
                  window.mona.launchNativeFleet({
                    projectId: chosen.projectId,
                    taskId: chosen.id,
                    expectedRevision: chosen.revision,
                    name: name.trim(),
                    role,
                    instructions: instructions.trim(),
                  }),
                );
                setInstructions("");
              })
            }
          >
            Launch serial run
          </Button>
        </div>
      )}
    </Card>
  );
}

export function AgentsScreen({
  detail,
  engineThreadId,
  onOpenFolder,
  onShowStudio,
}: AgentsScreenProps): JSX.Element {
  const [view, setView] = useState<ObservatoryView | null>(null);
  const [board, setBoard] = useState<BoardSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const projectId = detail.project.id;
      const [nextView, nextBoard] = await Promise.all([
        unwrap(() => window.mona.agentObservatory(projectId)),
        window.mona.boardSnapshot(projectId).catch(() => null),
      ]);
      setView(nextView);
      if (nextBoard?.ok) setBoard(nextBoard.value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [detail.project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = useCallback(
    (work: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      void (async () => {
        try {
          await work();
          setNotice("Action completed. Refreshing engine state…");
          await load();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(false);
          setConfirm(null);
        }
      })();
    },
    [load],
  );

  const selected = useMemo(() => {
    if (!view || !selection) return null;
    if (selection.kind === "agent") {
      const run = view.runs.find((candidate) => candidate.runId === selection.id);
      return run ? { kind: "agent" as const, run } : null;
    }
    if (selection.kind === "fleet") {
      const run = view.fleets.find((candidate) => candidate.runId === selection.id);
      return run ? { kind: "fleet" as const, run } : null;
    }
    const fleet = view.fleets.find((candidate) => candidate.runId === selection.parentId);
    const worker = fleet?.workers.find((candidate) => candidate.workerId === selection.id);
    return worker ? { kind: "worker" as const, worker, fleet: fleet ?? null } : null;
  }, [selection, view]);

  if (!view && loading) {
    return (
      <div className="screen screen--agents">
        <Card>
          <p className="muted">Reading native agent state from the engine…</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="screen screen--agents">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Agents</p>
          <h1 className="screen-title">{detail.project.name}</h1>
          <p className="screen-lede">
            Real engine identities, lifecycles, and receipts. Mona monitors and requests supported
            controls; the engine's own scheduler owns every fleet workflow.
          </p>
        </div>
        <div className="screen-header__actions">
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshIcon size={15} />}
            disabled={loading}
            onClick={() => void load()}
          >
            Refresh
          </Button>
          <Button size="sm" variant="primary" icon={<SparkIcon size={15} />} onClick={onShowStudio}>
            Open studio
          </Button>
        </div>
      </header>

      {error ? (
        <Callout tone="danger" title="The observatory could not complete that action">
          {error}
        </Callout>
      ) : null}
      {notice ? (
        <Callout tone="neutral" title="Last action">
          {notice}
        </Callout>
      ) : null}

      {view ? (
        <>
          <div className="agent-summary" role="region" aria-label="Orchestration summary">
            <div className="agent-summary__item">
              <span className="agent-summary__value">{view.summary.runs}</span>
              <span className="muted">agent rows</span>
            </div>
            <div className="agent-summary__item">
              <span className="agent-summary__value">{view.summary.running}</span>
              <span className="muted">running</span>
            </div>
            <div className="agent-summary__item">
              <span className="agent-summary__value">{view.summary.terminal}</span>
              <span className="muted">settled</span>
            </div>
            <div className="agent-summary__item">
              <span className="agent-summary__value">{view.summary.failed}</span>
              <span className="muted">failed</span>
            </div>
            <div className="agent-summary__item">
              <span className="agent-summary__value">{view.summary.unknownSpend}</span>
              <span className="muted">unknown spend</span>
            </div>
            <div className="agent-summary__item">
              <span className="agent-summary__value">{view.summary.goalsActive}</span>
              <span className="muted">active goals</span>
            </div>
            <div className="agent-summary__item">
              <span className="agent-summary__value">{view.summary.fleetRuns}</span>
              <span className="muted">fleet runs</span>
            </div>
            <div className="agent-summary__item">
              <span className="agent-summary__value">{view.summary.fleetWorkers}</span>
              <span className="muted">workers</span>
            </div>
          </div>

          {view.reason ? (
            <Callout tone={view.connected ? "neutral" : "attention"} title="Engine connection">
              {view.reason}
            </Callout>
          ) : null}

          <div className="agent-layout">
            <div className="agent-column">
              <Card
                title="Native runs"
                eyebrow={
                  view.source === "engine"
                    ? `Live engine · observed ${relativeTime(view.observedAt)}`
                    : `Stored observation${view.lastObservedAt ? ` · ${relativeTime(view.lastObservedAt)}` : ""}`
                }
                actions={
                  <Badge tone={view.connected ? "success" : "attention"}>
                    {view.connected ? "Connected" : "Not connected"}
                  </Badge>
                }
              >
                {view.fleets.length === 0 && view.runs.length === 0 ? (
                  <EmptyState
                    icon={<SparkIcon size={30} />}
                    title="No native agent runs"
                    description="The engine reports no fleet runs or sub-agent receipts for this project. Mona shows an empty list rather than a simulated swarm."
                  />
                ) : (
                  <div className="agent-tree">
                    {view.fleets.map((fleet) => (
                      <FleetNode
                        key={fleet.runId}
                        fleet={fleet}
                        selection={selection}
                        onSelect={setSelection}
                      />
                    ))}
                    {agentRoots(view.runs).map((run) => (
                      <AgentNode
                        key={run.runId}
                        run={run}
                        all={view.runs}
                        depth={0}
                        selection={selection}
                        onSelect={setSelection}
                      />
                    ))}
                  </div>
                )}
              </Card>

              <GoalCard
                projectId={detail.project.id}
                goals={view.goals}
                engineThreadId={engineThreadId}
                busy={busy}
                onAction={runAction}
                onShowStudio={onShowStudio}
              />
              <LaunchCard
                tasks={board?.tasks ?? []}
                busy={busy}
                onAction={runAction}
                onShowStudio={onShowStudio}
              />
              <ParallelCard parallel={view.parallel} />
              <Card title="Capability gaps" eyebrow="What this build does not claim">
                {view.gaps.length === 0 ? (
                  <p className="muted">No known gaps in the advertised surface.</p>
                ) : (
                  <ul className="agent-gaps">
                    {view.gaps.map((gap) => (
                      <li key={gap.id}>
                        <Badge tone={gap.status === "gap" ? "attention" : "neutral"}>
                          {gap.status}
                        </Badge>
                        <strong>{gap.title}</strong>
                        <p className="muted">{gap.detail}</p>
                      </li>
                    ))}
                  </ul>
                )}
                {view.notes.length > 0 ? (
                  <ul className="agent-notes">
                    {view.notes.map((note) => (
                      <li key={note} className="muted">
                        {note}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Card>
            </div>

            <div className="agent-column agent-column--inspector">
              {selected?.kind === "agent" ? (
                <AgentInspector
                  run={selected.run}
                  onCancel={() => setConfirm({ kind: "agent", run: selected.run })}
                />
              ) : selected?.kind === "fleet" ? (
                <FleetInspector
                  projectId={detail.project.id}
                  fleet={selected.run}
                  onStop={() => setConfirm({ kind: "fleet", run: selected.run })}
                  onOpenDetail={async (fleet) => {
                    try {
                      const full = await unwrap(() =>
                        window.mona.agentFleetDetail(detail.project.id, fleet.runId),
                      );
                      setView((current) =>
                        current
                          ? {
                              ...current,
                              fleets: current.fleets.map((candidate) =>
                                candidate.runId === full.runId ? full : candidate,
                              ),
                            }
                          : current,
                      );
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : String(cause));
                    }
                  }}
                />
              ) : selected?.kind === "worker" ? (
                <WorkerInspector
                  worker={selected.worker}
                  onStop={() => setConfirm({ kind: "worker", worker: selected.worker })}
                  onRestart={() =>
                    runAction(async () => {
                      await unwrap(() =>
                        window.mona.controlFleetWorker(
                          detail.project.id,
                          selected.worker.workerId,
                          "restart",
                        ),
                      );
                    })
                  }
                />
              ) : (
                <Card title="Select a run" eyebrow="Inspector">
                  <p className="muted">
                    Choose a fleet run, worker, or sub-agent to see its real identity, lifecycle,
                    last event, tools, tests, artifacts, and spend confidence.
                  </p>
                  <p className="muted">Ownership: {view.ownership.note}</p>
                </Card>
              )}
            </div>
          </div>

          <VisuallyHidden>
            <p aria-live="polite">
              {view.summary.runs} agent rows, {view.summary.running} running,{" "}
              {view.summary.unknownSpend} with unknown spend.
            </p>
          </VisuallyHidden>
        </>
      ) : (
        <Card>
          <EmptyState
            icon={<FolderIcon size={30} />}
            title="Open a project"
            description="The observatory reads the agent and fleet state of the project whose runtime Mona owns."
            action={
              <Button variant="primary" onClick={onOpenFolder}>
                Open folder
              </Button>
            }
          />
        </Card>
      )}

      <Dialog
        open={confirm !== null}
        title={
          confirm?.kind === "agent"
            ? "Cancel this sub-agent?"
            : confirm?.kind === "fleet"
              ? "Stop this fleet run?"
              : "Stop this worker?"
        }
        description={
          confirm?.kind === "agent"
            ? "The engine stops the run and its descendants. Changed files are named in its result rather than dropped."
            : confirm?.kind === "fleet"
              ? "Every queued or active task in the run is cancelled. Branches and files are not deleted."
              : "This worker's active task is cancelled; the rest of the fleet keeps running."
        }
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Keep running
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              icon={<StopIcon size={15} />}
              onClick={() => {
                if (!confirm) return;
                if (confirm.kind === "agent") {
                  const runId = confirm.run.runId;
                  runAction(async () => {
                    await unwrap(() => window.mona.cancelAgentRun(detail.project.id, runId));
                  });
                } else if (confirm.kind === "fleet") {
                  const runId = confirm.run.runId;
                  runAction(async () => {
                    await unwrap(() =>
                      window.mona.controlFleetRun(detail.project.id, runId, "stop"),
                    );
                  });
                } else {
                  const workerId = confirm.worker.workerId;
                  runAction(async () => {
                    await unwrap(() =>
                      window.mona.controlFleetWorker(detail.project.id, workerId, "stop"),
                    );
                  });
                }
              }}
            >
              Confirm stop
            </Button>
          </>
        }
      >
        <p className="muted">
          Stopping cannot roll back external side effects or a request already sent. The engine's
          receipt is the record of what actually happened.
        </p>
      </Dialog>
    </div>
  );
}

function agentRoots(runs: AgentRunView[]): AgentRunView[] {
  const ids = new Set(runs.map((run) => run.runId));
  return runs.filter((run) => !run.parentRunId || !ids.has(run.parentRunId));
}

function childrenOf(runs: AgentRunView[], parentId: string): AgentRunView[] {
  return runs.filter((run) => run.parentRunId === parentId);
}

function AgentNode({
  run,
  all,
  depth,
  selection,
  onSelect,
}: {
  run: AgentRunView;
  all: AgentRunView[];
  depth: number;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}): JSX.Element {
  const children = childrenOf(all, run.runId);
  return (
    <div className="agent-node" style={{ paddingLeft: depth * 12 }}>
      <details open={depth === 0}>
        <summary
          className={`agent-node__summary${
            selection?.kind === "agent" && selection.id === run.runId
              ? " agent-node__summary--selected"
              : ""
          }`}
          onClick={() => onSelect({ kind: "agent", id: run.runId })}
        >
          <Badge tone={statusTone(run.status)}>{statusWord(run.status)}</Badge>
          <span className="agent-node__label">{run.label}</span>
          <span className="mono muted">{run.runId}</span>
          <span className="agent-node__spend">
            {run.spend.confidence === "priced" && run.spend.usd !== null
              ? `$${run.spend.usd.toFixed(2)}`
              : "spend unknown"}
          </span>
        </summary>
        <div className="agent-node__body">
          {run.lastEvent ? (
            <EventLine event={run.lastEvent} />
          ) : (
            <p className="muted">No event yet.</p>
          )}
          <SpendLine spend={run.spend} />
          <TestsLine tests={run.tests} />
          <div className="agent-node__meta">
            <span>
              <strong>Task:</strong> {run.taskId ?? "not linked"}
            </span>
            <span>
              <strong>Workspace:</strong>{" "}
              <span className="mono">{run.workspace ?? "not reported"}</span>
            </span>
            <BranchLine branch={run.branch} />
          </div>
          {children.map((child) => (
            <AgentNode
              key={child.runId}
              run={child}
              all={all}
              depth={depth + 1}
              selection={selection}
              onSelect={onSelect}
            />
          ))}
        </div>
      </details>
    </div>
  );
}

function FleetNode({
  fleet,
  selection,
  onSelect,
}: {
  fleet: FleetRunView;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}): JSX.Element {
  return (
    <div className="agent-node agent-node--fleet">
      <details open>
        <summary
          className={`agent-node__summary${
            selection?.kind === "fleet" && selection.id === fleet.runId
              ? " agent-node__summary--selected"
              : ""
          }`}
          onClick={() => onSelect({ kind: "fleet", id: fleet.runId })}
        >
          <Badge tone={statusTone(fleet.lifecycle)}>{statusWord(fleet.lifecycle)}</Badge>
          <span className="agent-node__label">{fleet.name ?? fleet.runId}</span>
          <span className="mono muted">{fleet.runId}</span>
          <span className="agent-node__spend">
            {fleet.workerCount} worker{fleet.workerCount === 1 ? "" : "s"}
          </span>
        </summary>
        <div className="agent-node__body">
          <div className="agent-node__meta">
            <span>
              <strong>Workflow:</strong> {fleet.workflow.id ?? "unknown"} (
              {fleet.workflow.kind ?? "?"})
            </span>
            <span>
              <strong>Task:</strong> {fleet.taskId ?? "not linked"}
            </span>
            <span>
              <strong>Target:</strong> {fleet.target ?? "not reported"}
            </span>
          </div>
          {fleet.lastEvent ? <EventLine event={fleet.lastEvent} /> : null}
          <ul className="agent-task-list">
            {fleet.tasks.map((task) => (
              <li key={task.taskId}>
                <Badge tone={statusTone(task.status)}>{statusWord(task.status)}</Badge>
                <span className="mono">{task.taskId}</span>
                <span>{task.name ?? "unnamed task"}</span>
                <span className="muted">
                  {task.receiptResult ? `receipt: ${task.receiptResult}` : "no receipt yet"}
                </span>
              </li>
            ))}
          </ul>
          {fleet.workers.length === 0 ? (
            <p className="muted">Workers and receipts were not loaded for this run yet.</p>
          ) : (
            <ul className="agent-worker-list">
              {fleet.workers.map((worker) => (
                <li key={worker.workerId}>
                  <button
                    type="button"
                    className={`agent-worker${
                      selection?.kind === "worker" && selection.id === worker.workerId
                        ? " agent-worker--selected"
                        : ""
                    }`}
                    onClick={() =>
                      onSelect({ kind: "worker", id: worker.workerId, parentId: fleet.runId })
                    }
                  >
                    <Badge tone={statusTone(worker.status)}>{statusWord(worker.status)}</Badge>
                    <span className="mono">{worker.workerId}</span>
                    <span className="muted">{worker.role ?? "role unknown"}</span>
                    <span className="muted">{worker.lastEvent?.message ?? "no event"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </div>
  );
}

function AgentInspector({
  run,
  onCancel,
}: {
  run: AgentRunView;
  onCancel: () => void;
}): JSX.Element {
  return (
    <Inspector
      title={run.label}
      label="Sub-agent inspector"
      actions={<Badge tone={statusTone(run.status)}>{statusWord(run.status)}</Badge>}
    >
      <div className="agent-inspector">
        <dl className="agent-facts">
          <div>
            <dt>Upstream run</dt>
            <dd className="mono">{run.runId}</dd>
          </div>
          <div>
            <dt>Worker</dt>
            <dd className="mono">{run.workerId ?? "not reported"}</dd>
          </div>
          <div>
            <dt>Parent run</dt>
            <dd className="mono">{run.parentRunId ?? "root (no parent reported)"}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{run.role ?? "not reported"}</dd>
          </div>
          <div>
            <dt>Actor kind</dt>
            <dd>{run.actorKind ?? "not reported"}</dd>
          </div>
          <div>
            <dt>Board task</dt>
            <dd>{run.taskId ?? "not linked to a board task"}</dd>
          </div>
          <div>
            <dt>Parent thread</dt>
            <dd className="mono">{run.threadId ?? "not reported"}</dd>
          </div>
          <div>
            <dt>Workspace</dt>
            <dd className="mono">{run.workspace ?? "not reported"}</dd>
          </div>
          <div>
            <dt>Branch</dt>
            <dd>
              <BranchLine branch={run.branch} />
            </dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>{run.startedAt ? relativeTime(run.startedAt) : "unknown"}</dd>
          </div>
          <div>
            <dt>Completed</dt>
            <dd>{run.completedAt ? relativeTime(run.completedAt) : "not completed"}</dd>
          </div>
        </dl>
        {run.objectiveSummary ? <p className="agent-objective">{run.objectiveSummary}</p> : null}
        <h3 className="agent-section-title">Last meaningful event</h3>
        <EventLine event={run.lastEvent} />
        <h3 className="agent-section-title">Tools</h3>
        <ToolsLine tools={run.tools} />
        <h3 className="agent-section-title">Tests</h3>
        <TestsLine tests={run.tests} />
        <h3 className="agent-section-title">Spend</h3>
        <SpendLine spend={run.spend} />
        <h3 className="agent-section-title">Artifacts</h3>
        <Artifacts artifacts={run.artifacts} />
        <div className="button-row">
          <Button
            size="sm"
            variant="danger"
            icon={<StopIcon size={15} />}
            disabled={run.terminal}
            onClick={onCancel}
          >
            Cancel run
          </Button>
        </div>
        <p className="muted">
          Aggregate totals are not additive: {run.spend.source}. Mona never adds a parent and child
          total together.
        </p>
      </div>
    </Inspector>
  );
}

function FleetInspector({
  projectId,
  fleet,
  onStop,
  onOpenDetail,
}: {
  projectId: ProjectId;
  fleet: FleetRunView;
  onStop: () => void;
  onOpenDetail: (fleet: FleetRunView) => Promise<void>;
}): JSX.Element {
  const [evidence, setEvidence] = useState<FleetEvidenceView | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const loadEvidence = async (taskId: string): Promise<void> => {
    setEvidenceBusy(true);
    setEvidenceError(null);
    try {
      const loaded = await unwrap(() =>
        window.mona.agentFleetEvidence(projectId, fleet.runId, taskId),
      );
      setEvidence(loaded);
    } catch (cause) {
      setEvidenceError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setEvidenceBusy(false);
    }
  };
  return (
    <Inspector
      title={fleet.name ?? fleet.runId}
      label="Fleet run inspector"
      actions={<Badge tone={statusTone(fleet.lifecycle)}>{statusWord(fleet.lifecycle)}</Badge>}
    >
      <div className="agent-inspector">
        <dl className="agent-facts">
          <div>
            <dt>Run</dt>
            <dd className="mono">{fleet.runId}</dd>
          </div>
          <div>
            <dt>Workflow</dt>
            <dd>
              {fleet.workflow.id ?? "unknown"} ({fleet.workflow.kind ?? "?"})
            </dd>
          </div>
          <div>
            <dt>Target</dt>
            <dd>{fleet.target ?? "not reported"}</dd>
          </div>
          <div>
            <dt>Board task</dt>
            <dd>{fleet.taskId ?? "not linked to a board task"}</dd>
          </div>
          <div>
            <dt>Tasks</dt>
            <dd>{fleet.taskCount}</dd>
          </div>
          <div>
            <dt>Workers</dt>
            <dd>{fleet.workerCount}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{fleet.createdAt ? relativeTime(fleet.createdAt) : "unknown"}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{fleet.updatedAt ? relativeTime(fleet.updatedAt) : "unknown"}</dd>
          </div>
        </dl>
        <SpendLine spend={fleet.spend} />
        <h3 className="agent-section-title">Tasks and receipts</h3>
        {fleet.tasks.length === 0 ? (
          <p className="muted">No task rows were reported.</p>
        ) : (
          <ul className="agent-task-list">
            {fleet.tasks.map((task) => (
              <li key={task.taskId}>
                <Badge tone={statusTone(task.status)}>{statusWord(task.status)}</Badge>
                <span className="mono">{task.taskId}</span>
                <span>{task.name ?? "unnamed task"}</span>
                <span className="muted">{task.role ?? "role unknown"}</span>
                <span className="muted">
                  {task.receiptResult ? `receipt: ${task.receiptResult}` : "no receipt yet"}
                </span>
              </li>
            ))}
          </ul>
        )}
        {fleet.receipts.length > 0 ? (
          <ul className="agent-receipt-list">
            {fleet.receipts.map((receipt) => (
              <li key={`${receipt.taskId}:${receipt.attempt ?? 0}`}>
                <strong>{receipt.taskId}</strong>{" "}
                <span className="muted">
                  {receipt.result ?? "unknown result"}
                  {receipt.score
                    ? ` · score ${receipt.score.value ?? "?"}/${receipt.score.max ?? "?"}`
                    : ""}
                  {receipt.score?.notes ? ` · ${receipt.score.notes}` : ""}
                </span>
                <span className="muted">
                  {receipt.evidenceAvailable ? "Evidence available" : "No evidence route"}
                </span>
                {receipt.evidenceAvailable ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={evidenceBusy}
                    onClick={() => void loadEvidence(receipt.taskId)}
                  >
                    View evidence
                  </Button>
                ) : null}
                <Artifacts artifacts={receipt.artifacts} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">
            No receipt yet. A running workflow has not produced a terminal task receipt.
          </p>
        )}
        {evidenceError ? (
          <Callout tone="danger" title="Evidence could not be read">
            {evidenceError}
          </Callout>
        ) : null}
        {evidence ? (
          <div className="agent-evidence">
            <p className="muted">
              <span className="mono">{evidence.path ?? "evidence"}</span>
              {evidence.checksum ? ` · ${evidence.checksum}` : ""}
              {evidence.truncated ? " · truncated by the engine" : ""}
            </p>
            <pre>{JSON.stringify(evidence.content, null, 2).slice(0, 4000)}</pre>
          </div>
        ) : null}
        <h3 className="agent-section-title">Run history</h3>
        {fleet.events.length === 0 ? (
          <p className="muted">No bounded event history was returned.</p>
        ) : (
          <ol className="agent-events">
            {fleet.events.slice(-12).map((event, index) => (
              <li key={`${event.status}:${event.at ?? index}`}>
                <Badge tone="neutral">{event.status}</Badge>
                {event.at ? <span className="muted">{relativeTime(event.at)}</span> : null}
                {event.message ? <span>{event.message}</span> : null}
              </li>
            ))}
          </ol>
        )}
        <div className="button-row">
          <Button size="sm" variant="secondary" onClick={() => void onOpenDetail(fleet)}>
            Load workers and receipts
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={<StopIcon size={15} />}
            disabled={
              fleet.lifecycle === "completed" ||
              fleet.lifecycle === "cancelled" ||
              fleet.lifecycle === "failed"
            }
            onClick={onStop}
          >
            Stop run
          </Button>
        </div>
      </div>
    </Inspector>
  );
}

function WorkerInspector({
  worker,
  onStop,
  onRestart,
}: {
  worker: FleetWorkerView;
  onStop: () => void;
  onRestart: () => void;
}): JSX.Element {
  return (
    <Inspector
      title={worker.workerId}
      label="Fleet worker inspector"
      actions={<Badge tone={statusTone(worker.status)}>{statusWord(worker.status)}</Badge>}
    >
      <div className="agent-inspector">
        <dl className="agent-facts">
          <div>
            <dt>Worker</dt>
            <dd className="mono">{worker.workerId}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{worker.role ?? "not reported"}</dd>
          </div>
          <div>
            <dt>Host</dt>
            <dd>{worker.host ?? "not reported"}</dd>
          </div>
          <div>
            <dt>Task</dt>
            <dd className="mono">{worker.taskId ?? "no active task"}</dd>
          </div>
          <div>
            <dt>Heartbeat</dt>
            <dd>{worker.heartbeatAt ? relativeTime(worker.heartbeatAt) : "unknown"}</dd>
          </div>
          <div>
            <dt>Last error</dt>
            <dd>{worker.lastError ?? "none recorded"}</dd>
          </div>
        </dl>
        {worker.objective ? <p className="agent-objective">{worker.objective}</p> : null}
        <h3 className="agent-section-title">Last event</h3>
        <EventLine event={worker.lastEvent} />
        <h3 className="agent-section-title">Spend</h3>
        <SpendLine spend={worker.spend} />
        <h3 className="agent-section-title">Tools</h3>
        <ToolsLine tools={worker.tools} />
        <h3 className="agent-section-title">Tests</h3>
        <TestsLine tests={worker.tests} />
        <h3 className="agent-section-title">Artifacts</h3>
        <Artifacts artifacts={worker.artifacts} />
        <div className="button-row">
          <Button
            size="sm"
            variant="secondary"
            disabled={worker.status === "offline"}
            onClick={onRestart}
          >
            Restart worker
          </Button>
          <Button size="sm" variant="danger" icon={<StopIcon size={15} />} onClick={onStop}>
            Stop worker
          </Button>
        </div>
        <p className="muted">
          Stopping a worker cancels its active task and leaves the rest of the fleet running.
        </p>
      </div>
    </Inspector>
  );
}

function statusTone(
  status: string,
): "neutral" | "primary" | "success" | "attention" | "danger" | "accent" {
  const mapped = STATUS_TONE[status] ?? "unknown";
  switch (mapped) {
    case "running":
      return "primary";
    case "completed":
      return "success";
    case "verifying":
    case "interrupted":
      return "attention";
    case "failed":
    case "blocked":
      return "danger";
    case "skipped":
      return "neutral";
    default:
      return "neutral";
  }
}
