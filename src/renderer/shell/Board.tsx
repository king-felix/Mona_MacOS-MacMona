import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import type { IpcResult, ProjectDetail } from "../../shared/contracts/project-bridge";
import type {
  BoardSnapshot,
  ContextPreview,
  TaskOwner,
  TaskView,
} from "../../shared/contracts/board";
import type { TaskId } from "../../shared/contracts/ids";
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  SelectField,
  StatusBadge,
  TextArea,
  TextField,
  type WorkStatus,
} from "../design/primitives";
import {
  BoardIcon,
  BranchIcon,
  CheckIcon,
  ClockIcon,
  FolderIcon,
  InfoIcon,
  PlusIcon,
  RefreshIcon,
} from "../design/icons";
import { relativeTime } from "./visual";

const LANES: Array<{ id: string; title: string; caption: string; match: string[] }> = [
  {
    id: "running",
    title: "Running",
    caption: "One mutating run per workspace",
    match: ["running"],
  },
  {
    id: "verifying",
    title: "Verifying",
    caption: "Evidence is checked, never assumed",
    match: ["verifying"],
  },
  {
    id: "ready",
    title: "Unstarted",
    caption: "Prerequisites verified before starting",
    match: ["pending"],
  },
  {
    id: "attention",
    title: "Needs attention",
    caption: "Blocked and interrupted work stays visible",
    match: ["blocked", "interrupted"],
  },
  {
    id: "done",
    title: "Verified",
    caption: "Completion requires evidence",
    match: ["completed"],
  },
  { id: "skipped", title: "Skipped", caption: "Explicit scope decisions only", match: ["skipped"] },
];

function errorText(error: { message: string; code?: string }): string {
  return error.code ? `${error.message} (${error.code})` : error.message;
}

async function unwrap<T>(run: () => Promise<IpcResult<T>>): Promise<T> {
  const result = await run();
  if (!result.ok) throw new Error(errorText(result.error));
  return result.value;
}

const EMPTY_FORM = {
  title: "",
  prompt: "",
  checks: "",
  human: "",
  requirements: "",
  steps: "",
  owner: "mona_queue" as TaskOwner,
  dependsOn: [] as string[],
};

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function requirementList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function TaskDetail({
  task,
  all,
  busy,
  onAction,
}: {
  task: TaskView;
  all: TaskView[];
  busy: boolean;
  onAction: (action: () => Promise<unknown>) => void;
}): JSX.Element {
  const [checkPath, setCheckPath] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState({
    requirementId: task.requirements[0] ?? "",
    path: "",
  });
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const unsatisfied = task.acceptance.filter((criterion) => !criterion.satisfied).length;

  return (
    <Card title={task.title} eyebrow={`${task.owner} · ${task.status}`}>
      <div className="stack">
        <p className="muted">
          {task.id} · revision {task.revision} · updated {relativeTime(task.updatedAt)}
        </p>
        <p className="task-card__prompt">{task.prompt}</p>
        {task.dependsOn.length > 0 ? (
          <p className="task-card__deps">
            <BranchIcon size={14} /> Depends on{" "}
            {task.dependsOn
              .map((id) => all.find((entry) => entry.id === id)?.title ?? id)
              .join(", ")}
          </p>
        ) : (
          <p className="task-card__deps task-card__deps--none">No prerequisites</p>
        )}
        {task.nextStep ? <p>Recorded step: {task.nextStep}</p> : null}
        {task.verificationStale ? (
          <Callout tone="attention" title="Verification is stale">
            {task.staleReason ?? "Code changed after verification."} The task returned to verifying
            instead of keeping a stale completion.
          </Callout>
        ) : null}

        <h3>Acceptance criteria</h3>
        {task.acceptance.length === 0 ? (
          <p className="muted">No criteria. Completion is refused until at least one is added.</p>
        ) : (
          <ul className="check-list">
            {task.acceptance.map((criterion) => (
              <li key={criterion.id} className="check-list__item">
                <div>
                  <Badge tone={criterion.kind === "check" ? "primary" : "attention"}>
                    {criterion.kind === "check" ? "check" : "human"}
                  </Badge>{" "}
                  {criterion.text}
                  {criterion.satisfied ? (
                    <span className="check-list__done">
                      <CheckIcon size={14} /> accepted by {criterion.satisfiedBy}
                    </span>
                  ) : null}
                  {criterion.evidencePath ? (
                    <span className="mono check-list__path">{criterion.evidencePath}</span>
                  ) : null}
                </div>
                {!criterion.satisfied ? (
                  <div className="check-list__action">
                    <TextField
                      label="Evidence path"
                      value={checkPath[criterion.id] ?? ""}
                      onChange={(event) =>
                        setCheckPath((current) => ({
                          ...current,
                          [criterion.id]: event.target.value,
                        }))
                      }
                      placeholder="docs/evidence/check.txt"
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        onAction(() =>
                          unwrap(() =>
                            window.mona.satisfyTaskCriterion({
                              taskId: task.id,
                              criterionId: criterion.id,
                              expectedRevision: task.revision,
                              by: criterion.kind,
                              evidencePath: (checkPath[criterion.id] ?? "").trim() || null,
                            }),
                          ),
                        )
                      }
                    >
                      {criterion.kind === "check" ? "Record check" : "Accept"}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {task.requirements.length > 0 ? (
          <>
            <h3>Requirements and evidence</h3>
            <p className="muted">
              Completion requires at least one linked evidence path for each requirement.
            </p>
            <div className="inline-form">
              <SelectField
                label="Requirement"
                value={evidence.requirementId}
                options={task.requirements.map((requirement) => ({
                  value: requirement,
                  label: requirement,
                }))}
                onChange={(event) =>
                  setEvidence((current) => ({ ...current, requirementId: event.target.value }))
                }
              />
              <TextField
                label="Evidence path"
                value={evidence.path}
                onChange={(event) =>
                  setEvidence((current) => ({ ...current, path: event.target.value }))
                }
                placeholder="docs/evidence/proof.md"
              />
              <Button
                variant="secondary"
                disabled={busy || !evidence.path.trim()}
                onClick={() =>
                  onAction(() =>
                    unwrap(() =>
                      window.mona.addTaskEvidence({
                        projectId: task.projectId,
                        taskId: task.id,
                        requirementId: evidence.requirementId,
                        path: evidence.path.trim(),
                      }),
                    ),
                  )
                }
              >
                Link evidence
              </Button>
            </div>
          </>
        ) : null}

        <h3>Actions</h3>
        <div className="button-row">
          {task.status === "pending" ? (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                onAction(() => unwrap(() => window.mona.startBoardTask(task.id, task.revision)))
              }
            >
              Start run
            </Button>
          ) : null}
          {task.status === "interrupted" ? (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => onAction(() => unwrap(() => window.mona.resumeBoardTask(task.id)))}
            >
              Resume at recorded step
            </Button>
          ) : null}
          {task.status === "running" ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                onAction(() => unwrap(() => window.mona.verifyBoardTask(task.id, task.revision)))
              }
            >
              Mark implementation ready
            </Button>
          ) : null}
          {task.status === "verifying" ? (
            <Button
              variant="primary"
              disabled={busy || unsatisfied > 0}
              onClick={() =>
                onAction(() => unwrap(() => window.mona.completeBoardTask(task.id, task.revision)))
              }
            >
              Complete with evidence
            </Button>
          ) : null}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              onAction(async () => {
                const value = await unwrap(() => window.mona.previewTaskContext(task.id));
                setPreview(value);
              })
            }
          >
            Preview submitted context
          </Button>
        </div>
        {unsatisfied > 0 ? (
          <p className="muted">{unsatisfied} acceptance criteria must be satisfied first.</p>
        ) : null}
        {preview ? (
          <div className="preview-panel">
            <p className="eyebrow">Exact context to submit · {preview.bytes} bytes</p>
            <pre className="preview-panel__text">{preview.text}</pre>
            <p className="muted">Excluded: {preview.excluded.join("; ")}</p>
          </div>
        ) : null}
        {task.steps.length > 0 ? (
          <>
            <h3>Recorded steps</h3>
            <ol className="step-list">
              {task.steps.map((step) => (
                <li key={step.id} className={`step-list__item step-list__item--${step.state}`}>
                  {step.label} <span className="muted">· {step.state}</span>
                  {step.evidencePath ? (
                    <span className="mono step-list__path">{step.evidencePath}</span>
                  ) : null}
                </li>
              ))}
            </ol>
          </>
        ) : null}
      </div>
    </Card>
  );
}

export function BoardScreen({
  detail,
  onOpenFolder,
  onShowStudio,
}: {
  detail: ProjectDetail | null;
  onOpenFolder: () => void;
  onShowStudio: () => void;
}): JSX.Element {
  const projectId = detail?.project.id ?? null;
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<TaskId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const load = useCallback(async () => {
    if (!projectId) {
      setSnapshot(null);
      return;
    }
    try {
      const value = await unwrap(() => window.mona.boardSnapshot(projectId));
      setSnapshot(value);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [projectId]);

  useEffect(() => {
    setSelectedId(null);
    setCreating(false);
    setNotice(null);
    setSnapshot(null);
    void load();
  }, [load]);

  const runAction = useCallback(
    (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      void action()
        .catch((actionError: unknown) =>
          setError(actionError instanceof Error ? actionError.message : String(actionError)),
        )
        .finally(() => {
          setBusy(false);
          void load();
        });
    },
    [load],
  );

  const selected = useMemo(
    () => snapshot?.tasks.find((task) => task.id === selectedId) ?? null,
    [snapshot, selectedId],
  );

  const createTask = () => {
    if (!projectId) return;
    const acceptance = [
      ...lines(form.checks).map((text) => ({ text, kind: "check" as const })),
      ...lines(form.human).map((text) => ({ text, kind: "human" as const })),
    ];
    runAction(async () => {
      const value = await unwrap(() =>
        window.mona.createBoardTask({
          projectId,
          title: form.title.trim(),
          prompt: form.prompt.trim(),
          owner: form.owner,
          requirements: requirementList(form.requirements),
          acceptance,
          steps: lines(form.steps),
          dependsOn: form.dependsOn as TaskId[],
        }),
      );
      setForm(EMPTY_FORM);
      setCreating(false);
      setSelectedId(value.id);
      setNotice(`Created "${value.title}". It is unstarted until an explicit run.`);
    });
  };

  if (!detail) {
    return (
      <div className="screen">
        <Card>
          <EmptyState
            icon={<FolderIcon size={30} />}
            title="Choose a project"
            description="The work board shows real tasks from the selected project. Nothing is scheduled until you add a task."
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

  const tasks = snapshot?.tasks ?? [];

  return (
    <div className="screen screen--board">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Work board</p>
          <h1 className="screen-title">{detail.project.name}</h1>
          <p className="screen-lede">
            Unstarted tasks remain unstarted. Dependencies, execution owners, and acceptance
            evidence are explicit; no percentage is guessed from elapsed time or effort.
          </p>
        </div>
        <div className="screen-header__actions">
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshIcon size={15} />}
            onClick={() => void load()}
          >
            Refresh
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<PlusIcon size={15} />}
            onClick={() => setCreating((open) => !open)}
          >
            New task
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              runAction(async () => {
                const result = await unwrap(() =>
                  window.mona.importTaskPlanFile(detail.project.id),
                );
                setNotice(
                  result
                    ? `Imported ${result.taskCount} task(s) from "${result.planName}". They are inert until started.`
                    : "Import cancelled.",
                );
              })
            }
          >
            Import plan
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              runAction(async () => {
                const result = await unwrap(() =>
                  window.mona.exportTaskPlanFile(detail.project.id),
                );
                setNotice(result.saved ? `Plan saved to ${result.path}` : "Export cancelled.");
              })
            }
          >
            Export plan
          </Button>
          <Button size="sm" variant="primary" icon={<BoardIcon size={15} />} onClick={onShowStudio}>
            Open studio
          </Button>
        </div>
      </header>

      {error ? (
        <Callout tone="danger" title="The board could not complete that action">
          {error}
        </Callout>
      ) : null}
      {notice ? (
        <Callout tone="neutral" title="Last action">
          {notice}
        </Callout>
      ) : null}

      {snapshot ? (
        <Card title="Next exact action" eyebrow="From durable state">
          <p>{snapshot.handoff.nextExactAction}</p>
          <p className="muted">
            {snapshot.handoff.currentTitle
              ? `Focus: ${snapshot.handoff.currentTitle} · ${snapshot.handoff.currentStatus}`
              : "No focused task"}
            {snapshot.handoff.lastVerifiedStep
              ? ` · last verified step: ${snapshot.handoff.lastVerifiedStep}`
              : ""}
            {` · open attempts: ${snapshot.handoff.openAttempts}`}
          </p>
          {snapshot.selection.reason ? <p className="muted">{snapshot.selection.reason}</p> : null}
          <div className="button-row">
            <Button
              variant="primary"
              disabled={busy || snapshot.selection.taskId === null}
              onClick={() =>
                runAction(async () => {
                  const result = await unwrap(() =>
                    window.mona.dispatchNextTask(detail.project.id),
                  );
                  const reason = result.dispatches[0]?.reason ?? result.stoppedBecause;
                  setNotice(
                    result.ran.length > 0
                      ? `Ran ${result.ran.length} selected prompt; the queue stopped (${reason}).`
                      : `Nothing started: ${reason}`,
                  );
                })
              }
            >
              Run next selected prompt
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                runAction(async () => {
                  const result = await unwrap(() => window.mona.reconcileBoard(detail.project.id));
                  setNotice(
                    result.stale.length > 0
                      ? `${result.stale.length} task(s) returned to verifying because the workspace changed.`
                      : (result.notes[0] ?? "Reconciliation found no stale verification."),
                  );
                })
              }
            >
              Reconcile
            </Button>
          </div>
        </Card>
      ) : null}

      {creating ? (
        <Card title="New task" eyebrow="One bounded prompt">
          <div className="form-grid">
            <TextField
              label="Title"
              value={form.title}
              onChange={(event) =>
                setForm((current) => ({ ...current, title: event.target.value }))
              }
              placeholder="Describe the outcome"
            />
            <SelectField
              label="Execution owner"
              value={form.owner}
              options={[
                { value: "mona_queue", label: "Mona queue" },
                { value: "native_workflow", label: "Native workflow" },
              ]}
              onChange={(event) =>
                setForm((current) => ({ ...current, owner: event.target.value as TaskOwner }))
              }
            />
            <TextArea
              label="Prompt"
              hint="This is exactly what will be submitted, plus the criteria below."
              value={form.prompt}
              rows={5}
              onChange={(event) =>
                setForm((current) => ({ ...current, prompt: event.target.value }))
              }
              placeholder="Bound the work and the files involved."
            />
            <TextField
              label="Machine checks (one per line)"
              value={form.checks}
              onChange={(event) =>
                setForm((current) => ({ ...current, checks: event.target.value }))
              }
              placeholder="tests pass"
            />
            <TextField
              label="Human acceptance (one per line)"
              value={form.human}
              onChange={(event) =>
                setForm((current) => ({ ...current, human: event.target.value }))
              }
              placeholder="Victor approves the wording"
            />
            <TextField
              label="Requirements"
              value={form.requirements}
              onChange={(event) =>
                setForm((current) => ({ ...current, requirements: event.target.value }))
              }
              placeholder="MONA-009, MONA-010"
            />
            <TextField
              label="Recorded steps (one per line)"
              value={form.steps}
              onChange={(event) =>
                setForm((current) => ({ ...current, steps: event.target.value }))
              }
              placeholder="edit the parser"
            />
            {tasks.length > 0 ? (
              <fieldset className="depends-field">
                <legend>Depends on</legend>
                {tasks.map((task) => (
                  <label key={task.id} className="depends-field__option">
                    <input
                      type="checkbox"
                      checked={form.dependsOn.includes(task.id)}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          dependsOn: event.target.checked
                            ? [...current.dependsOn, task.id]
                            : current.dependsOn.filter((id) => id !== task.id),
                        }))
                      }
                    />{" "}
                    {task.title}
                  </label>
                ))}
              </fieldset>
            ) : null}
          </div>
          <div className="button-row">
            <Button
              variant="primary"
              disabled={busy || !form.title.trim() || !form.prompt.trim()}
              onClick={createTask}
            >
              Create task
            </Button>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}

      {selected ? (
        <TaskDetail
          key={`${selected.id}:${selected.revision}`}
          task={selected}
          all={tasks}
          busy={busy}
          onAction={runAction}
        />
      ) : null}

      {tasks.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BoardIcon size={30} />}
            title="No tasks yet"
            description="Tasks are created explicitly with a bounded prompt, an execution owner, and acceptance criteria. Imported plans stay inert until you start one."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                Add the first task
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="board" role="region" aria-label="Task lanes">
          {LANES.map((lane) => {
            const laneTasks = tasks.filter((task) => lane.match.includes(task.status));
            return (
              <section
                className="board__lane"
                key={lane.id}
                aria-labelledby={`shell-lane-${lane.id}`}
              >
                <header className="board__lane-header">
                  <div>
                    <h2 className="board__lane-title" id={`shell-lane-${lane.id}`}>
                      {lane.title}
                    </h2>
                    <p className="board__lane-caption">{lane.caption}</p>
                  </div>
                  <span className="board__count" aria-label={`${laneTasks.length} tasks`}>
                    {laneTasks.length}
                  </span>
                </header>
                <div className="board__lane-body">
                  {laneTasks.length === 0 ? (
                    <p className="board__empty">
                      <ClockIcon size={15} /> Nothing here
                    </p>
                  ) : (
                    laneTasks.map((task) => {
                      const dependencies = task.dependsOn
                        .map((id) => tasks.find((entry) => entry.id === id))
                        .filter((entry): entry is TaskView => Boolean(entry));
                      return (
                        <article
                          className={`task-card task-card--${task.status}${
                            selectedId === task.id ? " task-card--selected" : ""
                          }`}
                          key={task.id}
                          tabIndex={0}
                          role="button"
                          aria-pressed={selectedId === task.id}
                          aria-labelledby={`${task.id}-title`}
                          onClick={() => setSelectedId(task.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setSelectedId(task.id);
                            }
                          }}
                        >
                          <header className="task-card__header">
                            <StatusBadge status={task.status as WorkStatus} />
                            <span className="task-card__time">{relativeTime(task.updatedAt)}</span>
                          </header>
                          <h3 className="task-card__title" id={`${task.id}-title`}>
                            {task.title}
                          </h3>
                          <p className="task-card__owner">
                            <InfoIcon size={13} /> {task.owner}
                            {task.importedFrom ? ` · imported ${task.importedFrom}` : ""}
                          </p>
                          {task.requirements.length > 0 ? (
                            <div className="task-card__chips">
                              {task.requirements.map((requirement) => (
                                <Badge key={requirement} tone="neutral">
                                  {requirement}
                                </Badge>
                              ))}
                            </div>
                          ) : null}
                          {dependencies.length > 0 ? (
                            <p className="task-card__deps">
                              <BranchIcon size={14} /> Depends on{" "}
                              {dependencies.map((dependency) => (
                                <span
                                  key={dependency.id}
                                  className="task-card__dep"
                                  title={dependency.title}
                                >
                                  {dependency.title}
                                </span>
                              ))}
                            </p>
                          ) : (
                            <p className="task-card__deps task-card__deps--none">
                              No prerequisites
                            </p>
                          )}
                          <footer className="task-card__footer">
                            <span className="mono task-card__id">{task.id}</span>
                            <span className="muted">
                              {task.acceptance.filter((criterion) => criterion.satisfied).length}/
                              {task.acceptance.length} accepted
                            </span>
                            <Badge tone="neutral">Rev {task.revision}</Badge>
                          </footer>
                        </article>
                      );
                    })
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <Card title="How status is decided" eyebrow="Local state only">
        <ul className="rule-list">
          <li>
            <StatusBadge status="pending" /> A pending task is not partly done; no start time is
            implied.
          </li>
          <li>
            <StatusBadge status="running" /> One mutating run per workspace, with exactly one
            declared execution owner.
          </li>
          <li>
            <StatusBadge status="verifying" /> Code changes after verification reopen the task
            instead of keeping a stale completion.
          </li>
          <li>
            <StatusBadge status="blocked" /> Three attempts without material progress stop that
            problem and keep the requirement visible.
          </li>
          <li>
            <StatusBadge status="completed" /> Requires recorded acceptance evidence, not a model
            claim.
          </li>
        </ul>
      </Card>
    </div>
  );
}
