import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import type { IpcResult, ProjectDetail } from "../../shared/contracts/project-bridge";
import type {
  BlockedProblemCard,
  BoardSnapshot,
  ContextPreview,
  ProblemView,
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

const EMPTY_ATTEMPT = {
  requirement: "",
  symptom: "",
  hypothesis: "",
  action: "",
  observed: "",
  evidence: "",
  progress: false,
  reason: "",
};

function ProblemSection({
  task,
  problems,
  busy,
  onAction,
}: {
  task: TaskView;
  problems: ProblemView[];
  busy: boolean;
  onAction: (action: () => Promise<unknown>) => void;
}): JSX.Element {
  const [attempt, setAttempt] = useState({
    ...EMPTY_ATTEMPT,
    requirement: task.requirements[0] ?? "",
  });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [reopen, setReopen] = useState<Record<string, { reason: string; evidence: string }>>({});

  const record = () => {
    onAction(async () => {
      const result = await unwrap(() =>
        window.mona.recordProblemAttempt({
          projectId: task.projectId,
          taskId: task.id,
          requirement: attempt.requirement.trim(),
          symptom: attempt.symptom.trim(),
          hypothesis: attempt.hypothesis.trim(),
          action: attempt.action.trim(),
          observed: attempt.observed.trim(),
          materialProgress: attempt.progress,
          evidence: attempt.evidence.trim() ? [attempt.evidence.trim()] : [],
          reason: attempt.reason.trim() || null,
        }),
      );
      setAttempt({ ...EMPTY_ATTEMPT, requirement: attempt.requirement });
      if (result.blocked) {
        // The store has already blocked the problem and, when the task was
        // running, moved it to blocked. Reloading shows the Victor card.
      }
    });
  };

  const reopenField = (problemId: string) => reopen[problemId] ?? { reason: "", evidence: "" };

  return (
    <>
      <h3>Problems and attempts</h3>
      <p className="muted">
        One hypothesis-and-result cycle is one attempt. Three consecutive attempts without material
        progress block the problem; acknowledgement cannot reset that count.
      </p>
      {problems.length === 0 ? (
        <p className="muted">No recorded problem for this task.</p>
      ) : (
        <ul className="problem-list">
          {problems.map((problem) => {
            const latest = problem.attempts[problem.attempts.length - 1];
            return (
              <li
                key={problem.id}
                className={`problem-list__item problem-list__item--${problem.status}`}
              >
                <div className="problem-list__head">
                  <Badge
                    tone={
                      problem.status === "blocked"
                        ? "attention"
                        : problem.status === "resolved"
                          ? "neutral"
                          : "primary"
                    }
                  >
                    {problem.status}
                  </Badge>{" "}
                  <Badge tone="neutral">{problem.requirement}</Badge>{" "}
                  <span className="mono">{problem.id}</span>{" "}
                  <span className="muted">
                    {problem.totalAttempts} total · {problem.noProgressAttempts} without progress
                  </span>
                </div>
                <p>{problem.symptom}</p>
                {problem.status === "blocked" ? (
                  <Callout tone="attention" title="Blocked after three attempts">
                    {problem.helpNeeded ?? "New evidence or a decision is required."}
                  </Callout>
                ) : null}
                {problem.resolution ? (
                  <p className="muted">Resolved by decision: {problem.resolution}</p>
                ) : null}
                <ol className="attempt-list">
                  {problem.attempts.map((entry) => (
                    <li key={entry.id}>
                      <span className="muted">{relativeTime(entry.createdAt)}</span> ·{" "}
                      <strong>
                        {entry.materialProgress ? "material progress" : "no progress"}
                      </strong>
                      <div>Hypothesis: {entry.hypothesis}</div>
                      <div>Action: {entry.action}</div>
                      <div>Observed: {entry.observed}</div>
                      {entry.evidence.length > 0 ? (
                        <div className="mono">{entry.evidence.join(", ")}</div>
                      ) : null}
                    </li>
                  ))}
                </ol>
                {latest ? null : <p className="muted">No attempts recorded yet.</p>}
                <div className="button-row">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      onAction(() =>
                        unwrap(() =>
                          window.mona.acknowledgeProblem(
                            problem.id,
                            notes[problem.id]?.trim() || null,
                          ),
                        ),
                      )
                    }
                  >
                    Acknowledge (keeps count)
                  </Button>
                </div>
                {problem.status === "blocked" ? (
                  <div className="inline-form">
                    <TextField
                      label="New evidence path"
                      value={reopenField(problem.id).evidence}
                      onChange={(event) =>
                        setReopen((current) => ({
                          ...current,
                          [problem.id]: {
                            ...reopenField(problem.id),
                            evidence: event.target.value,
                          },
                        }))
                      }
                      placeholder="docs/evidence/new-proof.md"
                    />
                    <TextField
                      label="Why it is material"
                      value={reopenField(problem.id).reason}
                      onChange={(event) =>
                        setReopen((current) => ({
                          ...current,
                          [problem.id]: { ...reopenField(problem.id), reason: event.target.value },
                        }))
                      }
                      placeholder="a failing reproduction narrowed to the parser"
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy || !reopenField(problem.id).evidence.trim()}
                      onClick={() =>
                        onAction(() =>
                          unwrap(() =>
                            window.mona.reopenProblem(
                              problem.id,
                              reopenField(problem.id).reason.trim() || "material new evidence",
                              [reopenField(problem.id).evidence.trim()],
                            ),
                          ),
                        )
                      }
                    >
                      Reopen with evidence
                    </Button>
                  </div>
                ) : null}
                {problem.status !== "resolved" ? (
                  <div className="inline-form">
                    <TextField
                      label="Human resolution"
                      value={notes[problem.id] ?? ""}
                      onChange={(event) =>
                        setNotes((current) => ({ ...current, [problem.id]: event.target.value }))
                      }
                      placeholder="Victor decided to defer this requirement"
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || !(notes[problem.id] ?? "").trim()}
                      onClick={() =>
                        onAction(() =>
                          unwrap(() =>
                            window.mona.resolveProblem(
                              problem.id,
                              (notes[problem.id] ?? "").trim(),
                            ),
                          ),
                        )
                      }
                    >
                      Resolve with decision
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <div className="form-grid">
        <TextField
          label="Requirement"
          value={attempt.requirement}
          onChange={(event) =>
            setAttempt((current) => ({ ...current, requirement: event.target.value }))
          }
          placeholder="MONA-011"
        />
        <TextField
          label="Symptom"
          value={attempt.symptom}
          onChange={(event) =>
            setAttempt((current) => ({ ...current, symptom: event.target.value }))
          }
          placeholder="the test still fails with the same assertion"
        />
        <TextField
          label="Hypothesis"
          value={attempt.hypothesis}
          onChange={(event) =>
            setAttempt((current) => ({ ...current, hypothesis: event.target.value }))
          }
          placeholder="the cache key ignores the workspace"
        />
        <TextField
          label="Action"
          value={attempt.action}
          onChange={(event) =>
            setAttempt((current) => ({ ...current, action: event.target.value }))
          }
          placeholder="changed the key to include the canonical path"
        />
        <TextField
          label="Observed result"
          value={attempt.observed}
          onChange={(event) =>
            setAttempt((current) => ({ ...current, observed: event.target.value }))
          }
          placeholder="same failure; key is still stale"
        />
        <TextField
          label="Evidence path"
          value={attempt.evidence}
          onChange={(event) =>
            setAttempt((current) => ({ ...current, evidence: event.target.value }))
          }
          placeholder="docs/evidence/attempt-1.txt"
        />
        <TextField
          label="Progress reason (required if claiming progress)"
          value={attempt.reason}
          onChange={(event) =>
            setAttempt((current) => ({ ...current, reason: event.target.value }))
          }
          placeholder="reproduction narrowed to one function"
        />
        <label className="depends-field__option">
          <input
            type="checkbox"
            checked={attempt.progress}
            onChange={(event) =>
              setAttempt((current) => ({ ...current, progress: event.target.checked }))
            }
          />{" "}
          This attempt made material progress
        </label>
      </div>
      <div className="button-row">
        <Button
          variant="secondary"
          disabled={
            busy ||
            !attempt.requirement.trim() ||
            !attempt.symptom.trim() ||
            !attempt.hypothesis.trim() ||
            !attempt.action.trim() ||
            !attempt.observed.trim()
          }
          onClick={record}
        >
          Record attempt
        </Button>
      </div>
    </>
  );
}

function VictorHandoff({ cards }: { cards: BlockedProblemCard[] }): JSX.Element {
  return (
    <Card title="Victor handoff" eyebrow="Blocked problems from durable state">
      <p className="muted">
        These problems stopped after three consecutive attempts without material progress. They are
        not retried automatically and their requirements stay blocked.
      </p>
      <ul className="problem-list">
        {cards.map((card) => (
          <li key={card.problemId} className="problem-list__item problem-list__item--blocked">
            <div className="problem-list__head">
              <Badge tone="attention">blocked</Badge>{" "}
              <Badge tone="neutral">{card.requirement}</Badge>{" "}
              <span className="mono">{card.problemId}</span>
            </div>
            <p>
              <strong>{card.taskTitle ?? "No task"}</strong> — {card.symptom}
            </p>
            <p className="muted">
              {card.totalAttempts} attempts · {card.noProgressAttempts} consecutive without progress
              · blocked {relativeTime(card.blockedAt)}
            </p>
            <Callout tone="attention" title="Exact help needed">
              {card.helpNeeded}
            </Callout>
            {card.evidence.length > 0 ? (
              <p className="mono">{card.evidence.join(", ")}</p>
            ) : (
              <p className="muted">No evidence path was linked to the attempts.</p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TaskDetail({
  task,
  all,
  problems,
  busy,
  onAction,
}: {
  task: TaskView;
  all: TaskView[];
  problems: ProblemView[];
  busy: boolean;
  onAction: (action: () => Promise<unknown>) => void;
}): JSX.Element {
  const [checkPath, setCheckPath] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState({
    requirementId: task.requirements[0] ?? "",
    path: "",
  });
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [draftPrompt, setDraftPrompt] = useState(task.prompt);
  const unsatisfied = task.acceptance.filter((criterion) => !criterion.satisfied).length;
  const editable = ["pending", "blocked", "interrupted", "skipped"].includes(task.status);

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
            {task.evidence.length > 0 ? (
              <ul className="evidence-list">
                {task.evidence.map((entry) => (
                  <li key={`${entry.requirementId}:${entry.path}`}>
                    <Badge tone="neutral">{entry.requirementId}</Badge>{" "}
                    <span className="mono">{entry.path}</span>
                    {entry.note ? <span className="muted"> · {entry.note}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No requirement evidence linked yet.</p>
            )}
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

        {editing ? (
          <div className="edit-panel">
            <TextField
              label="Title"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
            />
            <TextArea
              label="Prompt"
              hint="Editing is refused while a run is active."
              value={draftPrompt}
              rows={5}
              onChange={(event) => setDraftPrompt(event.target.value)}
            />
            <div className="button-row">
              <Button
                variant="primary"
                disabled={busy || !draftTitle.trim() || !draftPrompt.trim()}
                onClick={() =>
                  onAction(async () => {
                    await unwrap(() =>
                      window.mona.updateBoardTask(task.id, task.revision, {
                        title: draftTitle.trim(),
                        prompt: draftPrompt.trim(),
                      }),
                    );
                    setEditing(false);
                  })
                }
              >
                Save changes
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setDraftTitle(task.title);
                  setDraftPrompt(task.prompt);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        <h3>Actions</h3>
        <div className="button-row">
          {editable ? (
            <Button variant="secondary" disabled={busy} onClick={() => setEditing((open) => !open)}>
              {editing ? "Close editor" : "Edit task"}
            </Button>
          ) : null}
          {task.status === "pending" ? (
            <Button
              variant="primary"
              disabled={busy || task.blockedProblemCount > 0}
              onClick={() =>
                onAction(() => unwrap(() => window.mona.startBoardTask(task.id, task.revision)))
              }
            >
              Start run
            </Button>
          ) : null}
          {task.status === "interrupted" || task.status === "blocked" ? (
            <Button
              variant="primary"
              disabled={busy || task.blockedProblemCount > 0}
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
        {task.blockedProblemCount > 0 ? (
          <p className="muted">
            A blocked problem must be resolved or reopened with new evidence before this task can
            start.
          </p>
        ) : null}
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
        <ProblemSection task={task} problems={problems} busy={busy} onAction={onAction} />

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

      {snapshot && snapshot.handoff.blockedProblems.length > 0 ? (
        <VictorHandoff cards={snapshot.handoff.blockedProblems} />
      ) : null}

      {selected ? (
        <TaskDetail
          key={`${selected.id}:${selected.revision}`}
          task={selected}
          all={tasks}
          problems={(snapshot?.problems ?? []).filter((problem) => problem.taskId === selected.id)}
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
            const laneTasks = tasks.filter((task) => {
              if (lane.id === "attention") {
                return lane.match.includes(task.status) || task.blockedProblemCount > 0;
              }
              if (lane.id === "ready") {
                return task.status === "pending" && task.blockedProblemCount === 0;
              }
              return lane.match.includes(task.status);
            });
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
                          {task.requirements.length > 0 || task.openProblemCount > 0 ? (
                            <div className="task-card__chips">
                              {task.requirements.map((requirement) => (
                                <Badge key={requirement} tone="neutral">
                                  {requirement}
                                </Badge>
                              ))}
                              {task.blockedProblemCount > 0 ? (
                                <Badge tone="attention">
                                  {task.blockedProblemCount} blocked problem
                                </Badge>
                              ) : task.openProblemCount > 0 ? (
                                <Badge tone="primary">{task.openProblemCount} open problem</Badge>
                              ) : null}
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
