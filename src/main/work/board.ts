import { z } from "zod";
import type {
  AcceptanceCriterion,
  BlockedTask,
  BoardSnapshot,
  ContextPreview,
  DispatchResult,
  HandoffView,
  ImportPlanResult,
  QueueRunResult,
  ReconcileResult,
  TaskOwner,
  TaskPlan,
  TaskSelection,
  TaskStep,
  TaskView,
} from "../../shared/contracts/board";
import type { ProjectId, TaskId } from "../../shared/contracts/ids";
import { StateError } from "../state/errors";
import type {
  StoredProject,
  StoredTask,
  StoredTaskStep,
  StateStore,
  TaskTransitionRecord,
} from "../state/store";
import { workspaceFingerprint, type WorkspaceFingerprint } from "./fingerprint";

/**
 * The work board. It owns task selection, the one-prompt-per-assignment queue,
 * evidence-gated completion, resume points, and handoff text. It never calls a
 * model and never starts an engine turn itself: dispatch hands a prompt to an
 * injected executor, which is the only place that can spend inference.
 */

export interface TaskExecutorInput {
  task: StoredTask;
  preview: ContextPreview;
}

export interface TaskExecutorOutcome {
  accepted: boolean;
  /** True when the request may have reached the engine but no receipt proved it. */
  outcomeUnknown?: boolean;
  note?: string | null;
}

export type TaskExecutor = (input: TaskExecutorInput) => Promise<TaskExecutorOutcome>;

export interface BoardCreateInput {
  projectId: ProjectId;
  title: string;
  prompt: string;
  owner?: TaskOwner;
  requirements?: string[];
  acceptance?: Array<{ text: string; kind: "check" | "human" }>;
  steps?: string[];
  dependsOn?: TaskId[];
}

export interface BoardUpdateInput {
  title?: string;
  prompt?: string;
  owner?: TaskOwner;
  requirements?: string[];
  acceptance?: Array<{ text: string; kind: "check" | "human" }>;
  steps?: string[];
}

export interface TaskBoardOptions {
  store: StateStore;
  fingerprint?: (rootPath: string, evidencePaths: readonly string[]) => WorkspaceFingerprint;
  now?: () => Date;
}

const PlanTask = z.strictObject({
  key: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  title: z.string().min(1).max(200),
  prompt: z.string().min(1).max(100_000),
  owner: z.enum(["mona_queue", "native_workflow"]).optional(),
  requirements: z
    .array(z.string().regex(/^(MONA|MAC)-\d{3}$/))
    .max(50)
    .optional(),
  acceptance: z
    .array(z.strictObject({ text: z.string().min(1).max(1000), kind: z.enum(["check", "human"]) }))
    .max(50)
    .optional(),
  steps: z.array(z.string().min(1).max(500)).max(50).optional(),
  dependsOn: z
    .array(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/))
    .max(50)
    .optional(),
});

export const TaskPlanInput = z.strictObject({
  format: z.literal("mona-task-plan"),
  format_version: z.literal(1),
  name: z.string().min(1).max(200),
  tasks: z.array(PlanTask).min(1).max(200),
});

interface LoadedBoard {
  project: StoredProject;
  tasks: StoredTask[];
  criteria: Map<string, AcceptanceCriterion[]>;
  steps: Map<string, TaskStep[]>;
  dependencies: Array<{ taskId: TaskId; dependsOnTaskId: TaskId }>;
  runs: Awaited<ReturnType<StateStore["listTaskRuns"]>>;
  attempts: number;
  evidence: Array<{ taskId: TaskId | null; requirementId: string; path: string }>;
  transitions: TaskTransitionRecord[];
}

function compareTasks(a: StoredTask, b: StoredTask): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function orderedRunning(tasks: readonly StoredTask[]): TaskId | null {
  const running = tasks.find((task) => task.status === "running");
  return running ? running.id : null;
}

function criterionPaths(criteria: readonly AcceptanceCriterion[]): string[] {
  return criteria
    .map((criterion) => criterion.evidencePath)
    .filter((path): path is string => typeof path === "string" && path.trim().length > 0);
}

function stepLabelAt(steps: readonly TaskStep[], state: TaskStep["state"]): string | null {
  const matches = steps.filter((step) => step.state === state);
  const last = matches[matches.length - 1];
  return last ? last.label : null;
}

export class TaskBoard {
  private readonly store: StateStore;
  private readonly fingerprint: (
    rootPath: string,
    evidencePaths: readonly string[],
  ) => WorkspaceFingerprint;

  constructor(options: TaskBoardOptions) {
    this.store = options.store;
    this.fingerprint = options.fingerprint ?? workspaceFingerprint;
  }

  async snapshot(projectId: ProjectId): Promise<BoardSnapshot> {
    const loaded = await this.load(projectId);
    const views = this.toViews(loaded);
    const selection = this.selectFrom(loaded.tasks, loaded.dependencies, "mona_queue");
    return {
      projectId,
      tasks: views,
      selection,
      handoff: this.handoffFrom(loaded, views),
    };
  }

  async taskView(taskId: TaskId): Promise<TaskView> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new StateError("NOT_FOUND", `task ${taskId} does not exist`);
    const loaded = await this.load(task.projectId);
    const view = this.toViews(loaded).find((entry) => entry.id === taskId);
    if (!view) throw new StateError("NOT_FOUND", `task ${taskId} does not exist`);
    return view;
  }

  async create(input: BoardCreateInput): Promise<TaskView> {
    const task = await this.store.createTask(input);
    return this.taskView(task.id);
  }

  async update(
    taskId: TaskId,
    expectedRevision: number,
    input: BoardUpdateInput,
  ): Promise<TaskView> {
    await this.store.updateTask(taskId, expectedRevision, input);
    return this.taskView(taskId);
  }

  async addEvidence(input: {
    projectId: ProjectId;
    taskId: TaskId;
    requirementId: string;
    path: string;
    note?: string | null;
  }): Promise<TaskView> {
    const task = await this.store.getTask(input.taskId);
    if (!task || task.projectId !== input.projectId) {
      throw new StateError("NOT_FOUND", "task is not in this project", {
        task_id: input.taskId,
      });
    }
    if (!task.requirements.includes(input.requirementId)) {
      throw new StateError("CONFLICT", "task does not declare that requirement", {
        task_id: input.taskId,
        requirement: input.requirementId,
      });
    }
    await this.store.addRequirementEvidence(input);
    return this.taskView(input.taskId);
  }

  async satisfy(input: {
    taskId: TaskId;
    criterionId: string;
    expectedRevision: number;
    by: "check" | "human";
    evidencePath?: string | null;
  }): Promise<TaskView> {
    await this.store.satisfyAcceptance(input.taskId, input.criterionId, input.expectedRevision, {
      by: input.by,
      evidencePath: input.evidencePath ?? null,
    });
    return this.taskView(input.taskId);
  }

  async startTask(
    taskId: TaskId,
    expectedRevision?: number,
  ): Promise<{ task: StoredTask; runId: string }> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new StateError("NOT_FOUND", `task ${taskId} does not exist`);
    const started = await this.store.beginTaskRun({
      taskId,
      owner: task.executionOwner,
      expectedRevision,
    });
    return { task: started.task, runId: started.run.id };
  }

  /** Resume an interrupted task at the recorded step. */
  async resumeTask(taskId: TaskId): Promise<{
    task: StoredTask;
    runId: string;
    step: string | null;
  }> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new StateError("NOT_FOUND", `task ${taskId} does not exist`);
    if (task.status !== "interrupted") {
      throw new StateError("CONFLICT", "only an interrupted task can resume", {
        task_id: taskId,
        status: task.status,
      });
    }
    const started = await this.store.beginTaskRun({ taskId, owner: task.executionOwner });
    return { task: started.task, runId: started.run.id, step: started.task.nextStep };
  }

  async verify(
    taskId: TaskId,
    expectedRevision: number,
    actor: "human" | "mona_queue" = "human",
  ): Promise<TaskView> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new StateError("NOT_FOUND", `task ${taskId} does not exist`);
    const loaded = await this.load(task.projectId);
    const current = await this.fingerprintFor(loaded, task);
    await this.store.markTaskVerifying(taskId, expectedRevision, current.digest, actor);
    return this.taskView(taskId);
  }

  async complete(
    taskId: TaskId,
    expectedRevision: number,
    actor: "human" | "mona_queue" = "human",
  ): Promise<TaskView> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new StateError("NOT_FOUND", `task ${taskId} does not exist`);
    const loaded = await this.load(task.projectId);
    const current = await this.fingerprintFor(loaded, task);
    await this.store.completeTask(taskId, expectedRevision, {
      fingerprint: current.digest,
      actor,
    });
    return this.taskView(taskId);
  }

  previewContext(taskId: TaskId): Promise<ContextPreview> {
    return this.preview(taskId);
  }

  async preview(taskId: TaskId): Promise<ContextPreview> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new StateError("NOT_FOUND", `task ${taskId} does not exist`);
    const criteria = await this.store.listAcceptance(taskId);
    return this.buildPreview(task, criteria);
  }

  async importPlan(projectId: ProjectId, value: unknown): Promise<ImportPlanResult> {
    const parsed = TaskPlanInput.safeParse(value);
    if (!parsed.success) {
      throw new StateError("IMPORT_INVALID", "task plan is invalid", {
        problems: parsed.error.issues.slice(0, 20).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const plan = parsed.data;
    const created = await this.store.createTasks({
      projectId,
      importedFrom: `plan:${plan.name}`,
      tasks: plan.tasks.map((task) => ({
        key: task.key,
        title: task.title,
        prompt: task.prompt,
        owner: task.owner,
        requirements: task.requirements,
        acceptance: task.acceptance,
        steps: task.steps,
        dependsOnKeys: task.dependsOn,
      })),
    });
    return {
      planName: plan.name,
      created: created.map((entry) => ({ key: entry.key, taskId: entry.task.id })),
      taskCount: created.length,
      inert: true,
    };
  }

  /** Export the board as an inert plan. Status is deliberately not exported:
   * importing a plan always creates unstarted tasks. */
  async exportPlan(projectId: ProjectId): Promise<TaskPlan> {
    const loaded = await this.load(projectId);
    const byId = new Map(loaded.tasks.map((task) => [task.id as string, task]));
    return {
      format: "mona-task-plan",
      format_version: 1,
      name: loaded.project.name,
      tasks: loaded.tasks.map((task) => ({
        key: task.id,
        title: task.title,
        prompt: task.prompt,
        owner: task.executionOwner,
        requirements: task.requirements,
        acceptance: (loaded.criteria.get(task.id) ?? []).map((criterion) => ({
          text: criterion.text,
          kind: criterion.kind,
        })),
        steps: (loaded.steps.get(task.id) ?? []).map((step) => step.label),
        dependsOn: loaded.dependencies
          .filter((dependency) => dependency.taskId === task.id)
          .map((dependency) => dependency.dependsOnTaskId)
          .filter((id) => byId.has(id as string)),
      })),
    };
  }

  async selectNext(projectId: ProjectId, owner: TaskOwner = "mona_queue"): Promise<TaskSelection> {
    const loaded = await this.load(projectId);
    return this.selectFrom(loaded.tasks, loaded.dependencies, owner);
  }

  /**
   * Run exactly one selected prompt and stop. There is no loop here: one
   * assignment starts one mutating run, which is the spec's default.
   */
  async runOnce(
    projectId: ProjectId,
    executor: TaskExecutor,
    options: {
      owner?: TaskOwner;
      shouldPause?: () => boolean;
      preflight?: () => Promise<string | null> | string | null;
    } = {},
  ): Promise<QueueRunResult> {
    if (options.shouldPause?.()) {
      return { ran: [], stoppedBecause: "paused", dispatches: [] };
    }
    const dispatch = await this.dispatchNext(projectId, executor, {
      owner: options.owner,
      preflight: options.preflight,
    });
    if (!dispatch.dispatched) {
      return { ran: [], stoppedBecause: "no_eligible_task", dispatches: [dispatch] };
    }
    return {
      ran: dispatch.taskId ? [dispatch.taskId] : [],
      stoppedBecause: dispatch.accepted ? "one_prompt_per_assignment" : "executor_failed",
      dispatches: [dispatch],
    };
  }

  async dispatchNext(
    projectId: ProjectId,
    executor: TaskExecutor,
    options: {
      owner?: TaskOwner;
      preflight?: () => Promise<string | null> | string | null;
    } = {},
  ): Promise<DispatchResult> {
    const owner = options.owner ?? "mona_queue";
    const loaded = await this.load(projectId);
    const selection = this.selectFrom(loaded.tasks, loaded.dependencies, owner);
    if (!selection.taskId) {
      return {
        dispatched: false,
        taskId: null,
        owner,
        runId: null,
        reason: selection.reason,
        accepted: false,
        outcomeUnknown: false,
        preview: null,
      };
    }
    const blocked = options.preflight ? await options.preflight() : null;
    if (blocked) {
      return {
        dispatched: false,
        taskId: selection.taskId,
        owner,
        runId: null,
        reason: blocked,
        accepted: false,
        outcomeUnknown: false,
        preview: null,
      };
    }
    const active = await this.store.activeTaskRun(projectId);
    if (active) {
      return {
        dispatched: false,
        taskId: selection.taskId,
        owner,
        runId: active.id,
        reason: `workspace already has a mutating run for task ${active.taskId}`,
        accepted: false,
        outcomeUnknown: false,
        preview: null,
      };
    }
    const task = loaded.tasks.find((entry) => entry.id === selection.taskId);
    if (!task) {
      throw new StateError("NOT_FOUND", "selected task disappeared");
    }
    const criteria = loaded.criteria.get(task.id) ?? [];
    const preview = this.buildPreview(task, criteria);
    let started;
    try {
      started = await this.store.beginTaskRun({
        taskId: task.id,
        owner,
        expectedRevision: task.revision,
      });
    } catch (error) {
      if (error instanceof StateError) {
        return {
          dispatched: false,
          taskId: task.id,
          owner,
          runId: null,
          reason: error.message,
          accepted: false,
          outcomeUnknown: false,
          preview,
        };
      }
      throw error;
    }
    try {
      const outcome = await executor({ task: started.task, preview });
      if (outcome.accepted) {
        await this.store.finishTaskRun(started.run.id, "completed", outcome.note ?? null);
        return {
          dispatched: true,
          taskId: task.id,
          owner,
          runId: started.run.id,
          reason: "prompt handed to the engine",
          accepted: true,
          outcomeUnknown: false,
          preview,
        };
      }
      await this.store.finishTaskRun(
        started.run.id,
        "failed",
        outcome.note ?? "submission rejected",
      );
      return {
        dispatched: true,
        taskId: task.id,
        owner,
        runId: started.run.id,
        reason: outcome.note ?? "the engine did not accept the prompt",
        accepted: false,
        outcomeUnknown: outcome.outcomeUnknown === true,
        preview,
      };
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      try {
        await this.store.finishTaskRun(started.run.id, "failed", note);
      } catch {
        // The run receipt is already on disk as running; reconciliation owns it.
      }
      return {
        dispatched: true,
        taskId: task.id,
        owner,
        runId: started.run.id,
        reason: note,
        accepted: false,
        outcomeUnknown: true,
        preview,
      };
    }
  }

  /**
   * Reconcile durable state with the disk. Completed verification whose
   * fingerprint changed becomes stale; interrupted tasks report their recorded
   * step. `resume` is explicit because starting work is never a side effect of
   * opening a board.
   */
  async reconcile(
    projectId: ProjectId,
    options: { resume?: boolean } = {},
  ): Promise<ReconcileResult> {
    const loaded = await this.load(projectId);
    const stale: ReconcileResult["stale"] = [];
    const notes: string[] = [];
    const unchanged: TaskId[] = [];
    for (const task of loaded.tasks) {
      if (task.status !== "completed" && task.status !== "verifying") continue;
      if (!task.verificationFingerprint) continue;
      const current = this.fingerprint(
        loaded.project.rootPath,
        this.evidencePathsFor(loaded, task),
      );
      if (current.digest === task.verificationFingerprint) {
        unchanged.push(task.id);
        continue;
      }
      const reason = `workspace changed after verification (${task.verificationFingerprint.slice(0, 8)} → ${current.digest.slice(0, 8)})`;
      await this.store.markVerificationStale(task.id, reason);
      stale.push({ taskId: task.id, reason });
    }

    const interrupted = loaded.tasks.filter((task) => task.status === "interrupted");
    for (const task of interrupted) {
      const step = this.recordedStep(task.id, loaded.steps.get(task.id) ?? []);
      notes.push(
        step
          ? `Task ${task.title} is interrupted at step "${step}"; resume is explicit.`
          : `Task ${task.title} is interrupted with no recorded step; resume starts from the beginning.`,
      );
    }

    const resumed: ReconcileResult["resumed"] = [];
    if (options.resume === true && interrupted.length > 0) {
      const active = await this.store.activeTaskRun(projectId);
      const candidate = interrupted.find((task) => task.executionOwner === "mona_queue");
      if (!active && candidate) {
        try {
          const started = await this.resumeTask(candidate.id);
          resumed.push({ taskId: candidate.id, step: started.step });
        } catch (error) {
          notes.push(
            `Could not resume ${candidate.title}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else if (active) {
        notes.push(`Resume skipped: task ${active.taskId} already holds the workspace run.`);
      }
    }

    return { projectId, resumed, stale, unchanged, notes };
  }

  async handoff(projectId: ProjectId): Promise<HandoffView> {
    const loaded = await this.load(projectId);
    return this.handoffFrom(loaded, this.toViews(loaded));
  }

  private async load(projectId: ProjectId): Promise<LoadedBoard> {
    const project = await this.store.getProject(projectId);
    if (!project) {
      throw new StateError("NOT_FOUND", "project is not in the catalog", { projectId });
    }
    const [tasks, dependencies, runs, attempts, evidence, transitions] = await Promise.all([
      this.store.listTasks(projectId),
      this.store.listDependencies(projectId),
      this.store.listTaskRuns(projectId),
      this.store.listAttempts(projectId),
      this.store.listRequirementEvidence(projectId),
      this.store.listTaskTransitions(projectId),
    ]);
    const criteria = new Map<string, AcceptanceCriterion[]>();
    const steps = new Map<string, StoredTaskStep[]>();
    for (const task of tasks) {
      criteria.set(task.id, await this.store.listAcceptance(task.id));
      steps.set(task.id, await this.store.listTaskSteps(task.id));
    }
    return {
      project,
      tasks: [...tasks].sort(compareTasks),
      criteria,
      steps,
      dependencies,
      runs,
      attempts: attempts.length,
      evidence: evidence.map((entry) => ({
        taskId: entry.taskId,
        requirementId: entry.requirementId,
        path: entry.path,
      })),
      transitions,
    };
  }

  private toViews(loaded: LoadedBoard): TaskView[] {
    return loaded.tasks.map((task) => {
      const activeRun = loaded.runs.find(
        (run) => run.taskId === task.id && run.state === "running",
      );
      return {
        id: task.id,
        projectId: task.projectId,
        title: task.title,
        prompt: task.prompt,
        status: task.status,
        owner: task.executionOwner,
        requirements: task.requirements,
        dependsOn: loaded.dependencies
          .filter((dependency) => dependency.taskId === task.id)
          .map((dependency) => dependency.dependsOnTaskId),
        acceptance: loaded.criteria.get(task.id) ?? [],
        steps: (loaded.steps.get(task.id) ?? []) as TaskStep[],
        nextStep: task.nextStep,
        verificationFingerprint: task.verificationFingerprint,
        verificationStale: task.verificationStale,
        staleReason: task.staleReason,
        completedAt: task.completedAt,
        importedFrom: task.importedFrom,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        revision: task.revision,
        activeRun: activeRun ?? null,
      };
    });
  }

  private selectFrom(
    tasks: readonly StoredTask[],
    dependencies: ReadonlyArray<{ taskId: TaskId; dependsOnTaskId: TaskId }>,
    owner: TaskOwner,
  ): TaskSelection {
    const byId = new Map(tasks.map((task) => [task.id as string, task]));
    const running = orderedRunning(tasks);
    if (running) {
      return {
        owner,
        taskId: null,
        eligible: [],
        waiting: [],
        reason: `workspace already has a mutating run for task ${running}`,
      };
    }
    const eligible: TaskId[] = [];
    const waiting: BlockedTask[] = [];
    const ordered = [...tasks].sort(compareTasks);
    for (const task of ordered) {
      if (task.status !== "pending") continue;
      if (task.executionOwner !== owner) {
        waiting.push({
          taskId: task.id,
          reason: `owned by ${task.executionOwner}`,
          unmet: [],
          blocking: [],
        });
        continue;
      }
      const prerequisites = dependencies
        .filter((dependency) => dependency.taskId === task.id)
        .map((dependency) => dependency.dependsOnTaskId);
      const unmet = prerequisites.filter((id) => byId.get(id)?.status !== "completed");
      if (unmet.length > 0) {
        const blocking = prerequisites.filter((id) => {
          const status = byId.get(id)?.status;
          return status === "blocked" || status === "interrupted";
        });
        waiting.push({
          taskId: task.id,
          reason:
            blocking.length > 0
              ? "a prerequisite is blocked or interrupted"
              : "prerequisites are not completed yet",
          unmet,
          blocking,
        });
        continue;
      }
      eligible.push(task.id);
    }
    return {
      owner,
      taskId: eligible[0] ?? null,
      eligible,
      waiting,
      reason:
        eligible.length > 0
          ? `first of ${eligible.length} eligible task(s) in creation order`
          : waiting.length > 0
            ? "no eligible task; every unstarted task has an unmet prerequisite or another owner"
            : "no unstarted task",
    };
  }

  private buildPreview(task: StoredTask, criteria: readonly AcceptanceCriterion[]): ContextPreview {
    const sections: string[] = [task.title, "", task.prompt];
    if (criteria.length > 0) {
      sections.push("", "Acceptance criteria:");
      for (const criterion of criteria) {
        sections.push(`- [${criterion.kind}] ${criterion.text}`);
      }
    }
    if (task.requirements.length > 0) {
      sections.push("", `Requirements: ${task.requirements.join(", ")}`);
    }
    const text = sections.join("\n").trim();
    return {
      taskId: task.id,
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      criteriaCount: criteria.length,
      requirements: task.requirements,
      excluded: [
        "Mona_macOS_Project.md — the full product specification",
        "Mona_macOS_PROMPTS.md — the full prompt sequence",
        "task state from other workspaces",
      ],
      truncated: Buffer.byteLength(text, "utf8") > 100_000,
    };
  }

  private evidencePathsFor(loaded: LoadedBoard, task: StoredTask): string[] {
    const fromCriteria = criterionPaths(loaded.criteria.get(task.id) ?? []);
    const fromRequirements = loaded.evidence
      .filter((entry) => entry.taskId === task.id)
      .map((entry) => entry.path);
    return [...new Set([...fromCriteria, ...fromRequirements])];
  }

  private async fingerprintFor(
    loaded: LoadedBoard,
    task: StoredTask,
  ): Promise<WorkspaceFingerprint> {
    return this.fingerprint(loaded.project.rootPath, this.evidencePathsFor(loaded, task));
  }

  private recordedStep(taskId: TaskId, steps: readonly TaskStep[]): string | null {
    const next =
      steps.find((step) => step.state === "running") ??
      steps.find((step) => step.state === "pending");
    return next ? next.label : null;
  }

  private handoffFrom(loaded: LoadedBoard, views: readonly TaskView[]): HandoffView {
    const evidencePaths = [...new Set(loaded.evidence.map((entry) => entry.path))].slice(-20);
    const focus =
      views.find((task) => task.status === "running") ??
      views.find((task) => task.status === "verifying") ??
      views.find((task) => task.status === "blocked") ??
      views.find((task) => task.status === "interrupted") ??
      views.find((task) => task.status === "pending" && this.isEligible(task, views));
    const blockers = views
      .filter((task) => task.status === "blocked")
      .map((task) => ({
        taskId: task.id,
        title: task.title,
        reason: task.staleReason ?? "blocked; new evidence or a human decision is required",
      }));
    if (!focus) {
      return {
        projectId: loaded.project.id,
        currentTaskId: null,
        currentTitle: null,
        currentStatus: null,
        lastVerifiedStep: null,
        nextExactAction:
          views.length === 0
            ? "Add a bounded task with acceptance criteria, or import an inert plan."
            : "No eligible task. Resolve a blocked prerequisite or unblock an interrupted task.",
        blockers,
        openAttempts: loaded.attempts,
        evidencePaths,
        generatedAt: new Date().toISOString(),
      };
    }
    const steps = focus.steps;
    const lastVerified =
      stepLabelAt(steps, "completed") ??
      (focus.status === "completed" ? "all acceptance criteria recorded" : null);
    const unsatisfied = focus.acceptance.filter((criterion) => !criterion.satisfied).length;
    let nextExactAction: string;
    switch (focus.status) {
      case "running":
        nextExactAction = `Continue "${focus.title}"; the engine owns the active turn, and the recorded step is "${focus.nextStep ?? "unrecorded"}".`;
        break;
      case "verifying":
        nextExactAction = `Verify "${focus.title}": ${unsatisfied} of ${focus.acceptance.length} criteria remain, then complete with a fresh fingerprint.`;
        break;
      case "blocked":
        nextExactAction = `Resolve the blocker on "${focus.title}": ${focus.staleReason ?? "record material new evidence or a decision"}.`;
        break;
      case "interrupted":
        nextExactAction = `Resume "${focus.title}" at step "${focus.nextStep ?? "the beginning"}".`;
        break;
      case "completed":
        nextExactAction = `"${focus.title}" is verified. Start the next eligible task.`;
        break;
      case "skipped":
        nextExactAction = `"${focus.title}" was skipped by an explicit scope decision.`;
        break;
      default:
        nextExactAction = `Start "${focus.title}"; all prerequisites are completed.`;
    }
    return {
      projectId: loaded.project.id,
      currentTaskId: focus.id,
      currentTitle: focus.title,
      currentStatus: focus.status,
      lastVerifiedStep: lastVerified,
      nextExactAction,
      blockers,
      openAttempts: loaded.attempts,
      evidencePaths,
      generatedAt: new Date().toISOString(),
    };
  }

  private isEligible(task: TaskView, views: readonly TaskView[]): boolean {
    const byId = new Map(views.map((entry) => [entry.id as string, entry]));
    return task.dependsOn.every((id) => byId.get(id)?.status === "completed");
  }
}
