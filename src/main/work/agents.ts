import { randomUUID } from "node:crypto";
import type { ProjectId, TaskId } from "../../shared/contracts/ids";
import type {
  AgentRunView,
  BranchView,
  FleetLaunchInput,
  FleetEvidenceView,
  FleetLaunchResult,
  FleetReceiptView,
  FleetRunView,
  FleetTaskView,
  FleetWorkerView,
  GoalView,
  ObservatoryView,
  OrchestrationActionReceipt,
  OrchestrationCapabilities,
  OrchestrationEvent,
  OrchestrationRunRecord,
  ParallelQualification,
  RunEventView,
  SpendView,
  TestEvidenceView,
  TokenUsageView,
  ToolUsageView,
} from "../../shared/contracts";
import {
  defaultOrchestrationGaps,
  emptyCapabilities,
  isTerminalRunStatus,
} from "../../shared/contracts";
import type {
  EngineAgentRun,
  EngineFleetReceipt,
  EngineFleetRun,
  EngineFleetRunDetail,
  EngineFleetWorker,
  EngineGoal,
  EngineRunEvent,
} from "../engine/types";
import type { EngineAdapter } from "../engine/types";
import { AdapterError } from "../engine/errors";
import { resolveGitBinary, runGit } from "./git";
import { workspaceFingerprint } from "./fingerprint";
import type { StoredProject, StateStore } from "../state/store";

export interface ObservatoryEngineAccess {
  adapter: EngineAdapter;
  /** Canonical workspace this runtime was started for. */
  workspace: string;
}

export interface AgentObservatoryOptions {
  store: StateStore;
  /** The live studio's adapter for this project, or null when not connected. */
  engine: (projectId: ProjectId) => ObservatoryEngineAccess | null;
  now?: () => Date;
  /** Number of fleet runs whose workers and receipts are loaded per refresh. */
  detailLimit?: number;
  branchReader?: (workspace: string) => Promise<BranchView | null>;
}

export type ObservatoryErrorCode =
  | "NOT_FOUND"
  | "NOT_CONNECTED"
  | "NOT_A_NATIVE_TASK"
  | "CONFLICT"
  | "INVALID_INPUT"
  | "CONTROL_REFUSED";

export class ObservatoryError extends Error {
  constructor(
    readonly code: ObservatoryErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ObservatoryError";
  }
}

const AGGREGATE_NOTE =
  "Parent and child spend are never added. A sub-agent's own usage is unknown unless its ledger reports it, and the parent thread total may already include it.";
const NO_DOUBLE_COUNT = "not additive across parent and child";

/**
 * Reads native orchestration state and performs only the controls the pinned
 * runtime documents. It never schedules a turn, never creates a second agent
 * engine, and never upgrades an unknown lifecycle or cost into a known one.
 */
export class AgentObservatory {
  private readonly store: StateStore;
  private readonly engine: (projectId: ProjectId) => ObservatoryEngineAccess | null;
  private readonly now: () => Date;
  private readonly detailLimit: number;
  private readonly branchReader: (workspace: string) => Promise<BranchView | null>;

  constructor(options: AgentObservatoryOptions) {
    this.store = options.store;
    this.engine = options.engine;
    this.now = options.now ?? (() => new Date());
    this.detailLimit = Math.min(Math.max(options.detailLimit ?? 5, 1), 20);
    this.branchReader = options.branchReader ?? readGitBranch;
  }

  async snapshot(projectId: ProjectId): Promise<ObservatoryView> {
    const project = await this.requireProject(projectId);
    const at = this.now().toISOString();
    const access = this.engine(projectId);
    const notes: string[] = [];
    let capabilities = emptyCapabilities();
    let agentRuns: AgentRunView[] = [];
    let fleets: FleetRunView[] = [];
    let goals: GoalView[] = [];
    let connected = false;
    let source: "engine" | "stored" = "stored";
    let reason: string | null = null;
    let agentRead = false;
    let fleetRead = false;
    let fleetDetailsComplete = false;
    let goalRead = false;
    /** Every normalized sub-agent record this refresh, keyed by run and worker id. */
    const ledgerById = new Map<string, AgentRunView>();

    if (access) {
      const adapter = access.adapter;
      let advertised = false;
      try {
        const info = await adapter.discover();
        capabilities = capabilitiesFromEngine(info.capabilities);
        advertised = true;
        connected = true;
      } catch (error) {
        reason = `Runtime discovery failed: ${messageOf(error)}`;
        notes.push(reason);
      }
      if (advertised) {
        const engineThreadIds = await this.projectThreadIds(projectId);
        const engagement = await this.engagement(projectId);
        const branchCache = new Map<string, Promise<BranchView | null>>();

        if (capabilities.agentRuns) {
          try {
            const list = await adapter.listAgentRuns({ limit: 100 });
            // Every record is normalized once. A fleet worker may carry a
            // runtime workspace rather than the project root, so the display
            // filter must not also strip the row that a fleet worker inherits
            // its tools, tests, and usage from.
            for (const run of list.runs) {
              ledgerById.set(run.runId, await this.agentView(run, engagement, branchCache));
              if (run.workerId) ledgerById.set(run.workerId, ledgerById.get(run.runId)!);
            }
            for (const run of list.runs) {
              if (!runBelongsToProject(run, project, engineThreadIds)) continue;
              agentRuns.push(ledgerById.get(run.runId)!);
            }
            agentRead = true;
          } catch (error) {
            notes.push(`Sub-agent receipts unavailable: ${messageOf(error)}`);
          }
        }

        if (capabilities.fleetCreate) {
          try {
            const list = await adapter.listFleetRuns();
            const detailed = list.runs.slice(0, this.detailLimit);
            const details = new Map<string, EngineFleetRunDetail>();
            for (const run of detailed) {
              try {
                details.set(run.runId, await adapter.readFleetRun(run.runId));
              } catch (error) {
                notes.push(`Fleet run ${run.runId} detail unavailable: ${messageOf(error)}`);
              }
            }
            for (const run of list.runs) {
              fleets.push(
                await this.fleetView(
                  run,
                  details.get(run.runId) ?? null,
                  project,
                  branchCache,
                  ledgerById,
                ),
              );
            }
            // The engine lists fleet workers in the same sub-agent ledger. Keep
            // one row per real identity: the fleet row owns the worker and its
            // spend/tools/tests, not a duplicate agent row.
            const fleetIdentities = new Set<string>();
            for (const entry of fleets) {
              fleetIdentities.add(entry.runId);
              for (const worker of entry.workers) fleetIdentities.add(worker.workerId);
            }
            agentRuns = agentRuns.filter(
              (run) => !fleetIdentities.has(run.runId) && !fleetIdentities.has(run.workerId ?? ""),
            );
            fleetRead = true;
            fleetDetailsComplete = details.size === list.runs.length;
            if (list.runs.length > detailed.length) {
              notes.push(
                `Workers and receipts were loaded for the newest ${detailed.length} fleet run(s); open an older run to load its detail.`,
              );
            }
            notes.push(
              "Fleet runs are read from the engine runtime store. A run's explicit board-task link is the only workspace ownership Mona claims.",
            );
          } catch (error) {
            notes.push(`Fleet runs unavailable: ${messageOf(error)}`);
          }
        }

        if (capabilities.goals) {
          try {
            const list = await adapter.listGoals({ limit: 200 });
            const visible = list.filter((goal) => engineThreadIds.has(goal.threadId));
            for (const goal of visible) {
              goals.push(toGoalView(goal, false));
              await this.persistGoal(projectId, goal, at);
            }
            goalRead = true;
          } catch (error) {
            notes.push(`Native goals unavailable: ${messageOf(error)}`);
          }
        }

        if (
          capabilities.agentRuns &&
          capabilities.fleetCreate &&
          capabilities.goals &&
          agentRuns.length === 0 &&
          fleets.length === 0 &&
          goals.length === 0
        ) {
          notes.push(
            "The runtime reports no agent runs, fleet runs, or goals for this project yet.",
          );
        }

        // A terminal fleet run settles the local task run it started, but the
        // task still needs verification; Mona never marks it complete here.
        await this.syncNativeTasks(project, fleets);
      }
      // Discovery success means the transport works. It does not mean every list
      // read worked: a failed route leaves that section unknown, so it falls
      // back to the stored projection below rather than reading as empty. Only
      // a section that was actually read is labelled live.
      if (advertised && (agentRead || fleetRead || goalRead)) {
        source = "engine";
        connected = true;
      } else if (advertised) {
        source = "stored";
        connected = true;
        reason =
          notes.length > 0
            ? `The runtime is connected but returned no orchestration data; showing the last stored observation. ${notes[0]}`
            : "The runtime is connected but returned no orchestration data; showing the last stored observation.";
      }
    } else {
      reason =
        "The live studio is not attached. Showing the last stored observation; controls are unavailable.";
    }

    let lastObservedAt: string | null = null;
    if (source === "stored") {
      const stored = await this.storedView(projectId);
      agentRuns = stored.agentRuns;
      fleets = stored.fleets;
      goals = stored.goals;
      lastObservedAt = stored.lastObservedAt;
      if (stored.lastObservedAt) notes.push(`Last engine observation: ${stored.lastObservedAt}`);
    } else {
      await this.persistViews(projectId, agentRead ? agentRuns : [], fleetRead ? fleets : [], at);
      if (agentRead) {
        await this.store.pruneOrchestrationRuns(
          projectId,
          "agent_run",
          agentRuns.flatMap((run) => [run.runId, ...(run.workerId ? [run.workerId] : [])]),
        );
      }
      // Prune only what was truly read. A run whose detail load failed keeps its
      // previous workers; pruning them would silently empty the offline view
      // because an empty `workers` array also means "not loaded".
      if (fleetRead && fleetDetailsComplete) {
        await this.store.pruneOrchestrationRuns(
          projectId,
          "fleet_run",
          fleets.map((fleet) => fleet.runId),
        );
        await this.store.pruneOrchestrationRuns(
          projectId,
          "fleet_worker",
          fleets.flatMap((fleet) => fleet.workers.map((worker) => worker.workerId)),
        );
      }
      if (!agentRead || !fleetRead || !goalRead) {
        // A section this refresh could not read keeps its last observation, so a
        // transient route failure cannot erase a real run from the screen.
        const stored = await this.storedView(projectId);
        if (!agentRead) agentRuns = stored.agentRuns;
        if (!fleetRead) fleets = stored.fleets;
        if (!goalRead) goals = stored.goals;
        lastObservedAt = stored.lastObservedAt;
      }
    }
    if (!lastObservedAt) lastObservedAt = await this.lastObservedAt(projectId);

    const activeRun = await this.store.activeTaskRun(projectId);
    const ownership = {
      oneMutatingRunPerWorkspace: true as const,
      activeTaskRunId: activeRun?.id ?? null,
      activeTaskId: activeRun?.taskId ?? null,
      activeOwner: activeRun?.owner ?? null,
      note: "One mutating run per workspace. A native fleet run owns only the task it started; Mona's queue never starts a task owned by native_workflow.",
    };

    const gaps = defaultOrchestrationGaps(capabilities);
    if (gaps.length > 0 && source === "engine") {
      notes.push("Some native surfaces are absent or unverified; see Gaps.");
    }

    return {
      projectId,
      observedAt: at,
      source,
      connected: access !== null && connected,
      reason,
      runs: sortAgents(agentRuns),
      fleets: sortFleets(fleets),
      goals,
      summary: summarize(agentRuns, fleets, goals),
      ownership,
      parallel: serialOnlyQualification(),
      capabilities,
      gaps,
      lastObservedAt,
      notes,
    };
  }

  async fleetDetail(projectId: ProjectId, runId: string): Promise<FleetRunView> {
    const project = await this.requireProject(projectId);
    const access = this.requireAccess(projectId);
    const detail = await access.adapter.readFleetRun(runId);
    const view = await this.fleetView(detail.run, detail, project, new Map(), new Map());
    await this.persistFleet(projectId, view, this.now().toISOString());
    return view;
  }

  async fleetEvidence(
    projectId: ProjectId,
    runId: string,
    taskId: string,
  ): Promise<FleetEvidenceView> {
    await this.requireProject(projectId);
    const access = this.requireAccess(projectId);
    const evidence = await access.adapter.readFleetReceiptEvidence(runId, taskId);
    return {
      taskId,
      path: evidence.path,
      checksum: evidence.checksum,
      sizeBytes: evidence.sizeBytes,
      truncated: evidence.truncated,
      content: evidence.content,
    };
  }

  async history(projectId: ProjectId, limit = 50): Promise<OrchestrationEvent[]> {
    await this.requireProject(projectId);
    return this.store.listOrchestrationEvents(projectId, limit);
  }

  // ------------------------------------------------------------------ controls

  async cancelAgentRun(projectId: ProjectId, runId: string): Promise<OrchestrationActionReceipt> {
    const access = this.requireAccess(projectId);
    try {
      const result = await access.adapter.cancelAgentRun(runId);
      await this.record(
        projectId,
        "agent_run_cancel",
        runId,
        result.accepted,
        result.status,
        result.message,
      );
      return {
        action: "agent_run_cancel",
        accepted: result.accepted,
        status: result.status,
        runId,
        message:
          result.status === 202
            ? "Stop accepted; the engine has not recorded the terminal receipt yet. Refresh to poll."
            : result.message,
        at: this.now().toISOString(),
        record: result.record,
      };
    } catch (error) {
      return this.refused(projectId, "agent_run_cancel", runId, error);
    }
  }

  async controlFleetRun(
    projectId: ProjectId,
    runId: string,
    _action: "stop",
  ): Promise<OrchestrationActionReceipt> {
    const access = this.requireAccess(projectId);
    try {
      const result = await access.adapter.stopFleetRun(runId);
      await this.record(
        projectId,
        "fleet_stop",
        runId,
        result.accepted,
        result.status,
        result.message,
      );
      return {
        action: "fleet_stop",
        accepted: result.accepted,
        status: result.status,
        runId,
        message: "Stop requested. The engine cancels every queued or active task in the run.",
        at: this.now().toISOString(),
        record: result.record,
      };
    } catch (error) {
      return this.refused(projectId, "fleet_stop", runId, error);
    }
  }

  async controlWorker(
    projectId: ProjectId,
    workerId: string,
    action: "stop" | "restart",
  ): Promise<OrchestrationActionReceipt> {
    const access = this.requireAccess(projectId);
    const label = action === "stop" ? "worker_stop" : "worker_restart";
    try {
      const result =
        action === "stop"
          ? await access.adapter.stopFleetWorker(workerId)
          : await access.adapter.restartFleetWorker(workerId);
      await this.record(projectId, label, workerId, result.accepted, result.status, result.message);
      return {
        action: label,
        accepted: result.accepted,
        status: result.status,
        runId: workerId,
        message:
          action === "stop"
            ? "Worker stop requested; the rest of the fleet keeps running."
            : "Restart requested for this worker.",
        at: this.now().toISOString(),
        record: result.record,
      };
    } catch (error) {
      return this.refused(projectId, label, workerId, error);
    }
  }

  async setGoal(
    projectId: ProjectId,
    engineThreadId: string,
    objective: string,
  ): Promise<OrchestrationActionReceipt> {
    const access = this.requireAccess(projectId);
    await this.requireProjectThread(projectId, engineThreadId);
    try {
      const { goal, status } = await access.adapter.setThreadGoal(
        engineThreadId as never,
        objective,
      );
      await this.persistGoal(projectId, goal, this.now().toISOString());
      const message =
        goal.status === "active"
          ? "Goal set. The engine now owns goal continuation and may start work."
          : `Goal set with engine status ${goal.status}.`;
      await this.record(
        projectId,
        "goal_set",
        goal.goalId ?? engineThreadId,
        true,
        status,
        message,
      );
      return {
        action: "goal_set",
        accepted: true,
        status,
        runId: goal.goalId,
        message,
        at: this.now().toISOString(),
        record: null,
      };
    } catch (error) {
      return this.refused(projectId, "goal_set", engineThreadId, error);
    }
  }

  async completeGoal(
    projectId: ProjectId,
    engineThreadId: string,
  ): Promise<OrchestrationActionReceipt> {
    return this.goalAction(projectId, engineThreadId, "goal_complete");
  }

  async blockGoal(
    projectId: ProjectId,
    engineThreadId: string,
    reason: string | null = null,
  ): Promise<OrchestrationActionReceipt> {
    return this.goalAction(projectId, engineThreadId, "goal_block", reason);
  }

  async clearGoal(
    projectId: ProjectId,
    engineThreadId: string,
  ): Promise<OrchestrationActionReceipt> {
    const access = this.requireAccess(projectId);
    await this.requireProjectThread(projectId, engineThreadId);
    try {
      const cleared = await access.adapter.clearThreadGoal(engineThreadId as never);
      await this.record(
        projectId,
        "goal_clear",
        engineThreadId,
        cleared.cleared,
        cleared.status,
        cleared.cleared ? "Goal cleared; no continuation remains." : "There was no goal to clear.",
      );
      return {
        action: "goal_clear",
        accepted: cleared.cleared,
        status: cleared.status,
        runId: null,
        message: cleared.cleared ? "Goal cleared." : "There was no goal to clear.",
        at: this.now().toISOString(),
        record: null,
      };
    } catch (error) {
      return this.refused(projectId, "goal_clear", engineThreadId, error);
    }
  }

  /**
   * Launch one serial native fleet task for a board task that is explicitly
   * owned by `native_workflow`. Mona never launches a free-floating fleet while
   * its own queue could also dispatch the same work.
   */
  async launchFleet(projectId: ProjectId, input: FleetLaunchInput): Promise<FleetLaunchResult> {
    const project = await this.requireProject(projectId);
    const access = this.requireAccess(projectId);
    const task = await this.store.getTask(input.taskId);
    if (!task || task.projectId !== projectId) {
      throw new ObservatoryError("NOT_FOUND", "task is not in this project", {
        taskId: input.taskId,
      });
    }
    if (task.executionOwner !== "native_workflow") {
      throw new ObservatoryError(
        "NOT_A_NATIVE_TASK",
        "this task is owned by the Mona queue; change its owner to native_workflow before launching a fleet",
        { taskId: task.id, owner: task.executionOwner },
      );
    }
    const running = await this.store.activeTaskRun(projectId);
    if (running) {
      throw new ObservatoryError(
        "CONFLICT",
        "this workspace already has a mutating run; finish or interrupt it before starting a native fleet",
        { runId: running.id, owner: running.owner },
      );
    }

    const started = await this.store.beginTaskRun({
      taskId: task.id,
      owner: "native_workflow",
      expectedRevision: input.expectedRevision,
      note: `native fleet launch (${input.role})`,
    });

    const workflowId = `mona-${task.id}-${randomUUID().slice(0, 8)}`;
    let created;
    try {
      created = await access.adapter.createFleetRun({
        target: "this_computer",
        name: input.name,
        roles: [{ name: input.role }],
        workflow: {
          id: workflowId,
          kind: "parallel",
          tasks: [
            {
              id: "task",
              name: task.title,
              instructions: input.instructions,
              worker: { role: input.role },
            },
          ],
        },
      });
    } catch (error) {
      const message = `Native fleet creation failed: ${messageOf(error)}`;
      await this.store.finishTaskRun(started.run.id, "failed", message);
      return this.refused(projectId, "fleet_create", task.id, error, message);
    }

    try {
      await this.store.linkTaskRunUpstream(started.run.id, "fleet_run", created.run.runId);
    } catch (error) {
      // The local link is the ownership record. Without it the run must not
      // proceed, or two records could claim the same work.
      await this.store.finishTaskRun(started.run.id, "failed", messageOf(error));
      await access.adapter.stopFleetRun(created.run.runId).catch(() => undefined);
      return this.refused(projectId, "fleet_create", created.run.runId, error);
    }

    try {
      const control = await access.adapter.startFleetRun(created.run.runId);
      await this.record(
        projectId,
        "fleet_start",
        created.run.runId,
        control.accepted,
        control.status,
        `Started for task ${task.id}: ${control.message}`,
      );
      await this.persistFleet(
        projectId,
        await this.fleetView(created.run, null, project, new Map(), new Map()),
        this.now().toISOString(),
      );
      return {
        receipt: {
          action: "fleet_start",
          accepted: control.accepted,
          status: control.status,
          runId: created.run.runId,
          message: `Fleet ${created.run.runId} scheduled for task ${task.id}. The engine owns execution; Mona monitors it.`,
          at: this.now().toISOString(),
          record: control.record,
        },
        runId: created.run.runId,
        taskId: task.id,
      };
    } catch (error) {
      const message = `Native fleet start failed: ${messageOf(error)}`;
      await access.adapter.stopFleetRun(created.run.runId).catch(() => undefined);
      await this.store.finishTaskRun(started.run.id, "failed", message);
      return this.refused(projectId, "fleet_start", created.run.runId, error, message);
    }
  }

  // ------------------------------------------------------------------- views

  private async goalAction(
    projectId: ProjectId,
    engineThreadId: string,
    action: "goal_complete" | "goal_block",
    reason: string | null = null,
  ): Promise<OrchestrationActionReceipt> {
    const access = this.requireAccess(projectId);
    await this.requireProjectThread(projectId, engineThreadId);
    try {
      const { goal, status } =
        action === "goal_complete"
          ? await access.adapter.completeThreadGoal(engineThreadId as never)
          : await access.adapter.blockThreadGoal(engineThreadId as never);
      await this.persistGoal(projectId, goal, this.now().toISOString());
      const message = `Goal is now ${goal.status}.`;
      await this.record(projectId, action, goal.goalId ?? engineThreadId, true, status, message);
      if (action === "goal_block" && reason) {
        // The engine block route carries no documented reason. Record the note
        // in Mona's own event log rather than inventing a request field.
        await this.record(
          projectId,
          "goal_block_note",
          goal.goalId ?? engineThreadId,
          true,
          null,
          reason,
        );
      }
      return {
        action,
        accepted: true,
        status,
        runId: goal.goalId,
        message,
        at: this.now().toISOString(),
        record: null,
      };
    } catch (error) {
      return this.refused(projectId, action, engineThreadId, error);
    }
  }

  private async agentView(
    run: EngineAgentRun,
    engagement: Engagement,
    branchCache: Map<string, Promise<BranchView | null>>,
  ): Promise<AgentRunView> {
    const taskId = engagement.taskByTurn.get(run.originTurnId ?? "") ?? null;
    const branch = await this.branchFor(run.workspace, branchCache);
    return {
      kind: "agent_run",
      runId: run.runId,
      workerId: run.workerId,
      parentRunId: run.parentRunId,
      actorKind: run.actorKind,
      role: run.role,
      label: labelFor(
        run.role,
        taskId ? (engagement.titles.get(taskId) ?? null) : null,
        run.objective,
      ),
      objectiveSummary: run.objective.slice(0, 500),
      status: run.status,
      rawStatus: run.status,
      taskId,
      threadId: run.ownerSessionId,
      originTurnId: run.originTurnId,
      workspace: run.workspace,
      branch,
      lastEvent: lastMeaningfulEvent(run.events),
      tools: toolsFor(run.events),
      tests: testsFor(run.verification.status, run.verification.summary),
      spend: spendForAgent(run),
      artifacts: run.artifacts.map(toArtifactView),
      children: [],
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
      terminal: isTerminalRunStatus(run.status),
    };
  }

  private async fleetView(
    run: EngineFleetRun,
    detail: EngineFleetRunDetail | null,
    project: StoredProject,
    branchCache: Map<string, Promise<BranchView | null>>,
    agentById: Map<string, AgentRunView> = new Map(),
  ): Promise<FleetRunView> {
    const linked = await this.store.findTaskRunByUpstream(project.id, "fleet_run", run.runId);
    const branch = await this.branchFor(project.canonicalPath, branchCache);
    const receipts = detail?.receipts ?? [];
    const receiptByTask = new Map(receipts.map((receipt) => [receipt.taskId, receipt]));
    const tasks: FleetTaskView[] = run.tasks.map((task) => {
      const receipt = receiptByTask.get(task.taskId) ?? null;
      return {
        taskId: task.taskId,
        name: task.name,
        status: task.status,
        workerId: task.workerId,
        attempts: task.attempts,
        role: task.role,
        receiptResult: receipt?.result ?? null,
        score: receipt?.score ?? null,
      };
    });
    const workers: FleetWorkerView[] = (detail?.workers ?? []).map((worker) =>
      workerView(worker, branch, agentById.get(worker.workerId) ?? null),
    );
    const runEvents: RunEventView[] = (detail?.events ?? []).map((event) => ({
      seq: null,
      at: event.at,
      status: event.event,
      message: event.summary,
      kind: "event",
    }));
    const lastEvent: RunEventView | null = runEvents.length
      ? (runEvents[runEvents.length - 1] ?? null)
      : null;
    return {
      kind: "fleet_run",
      runId: run.runId,
      name: run.name,
      lifecycle: run.lifecycle,
      target: run.target,
      workflow: run.workflow,
      roles: run.roles,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
      taskCount: run.taskCount,
      workerCount: run.workerCount,
      taskId: linked?.taskId ?? null,
      linkedTaskRunId: linked?.id ?? null,
      lastEvent,
      events: runEvents,
      tasks,
      workers,
      receipts: receipts.map(toReceiptView),
      spend: {
        confidence: "not_reported",
        usd: null,
        tokens: null,
        source: "fleet receipts",
        note: "Fleet receipts and worker records carry no token or cost totals. Mona shows unknown rather than deriving a balance.",
      },
      aggregateNote: `${AGGREGATE_NOTE} ${NO_DOUBLE_COUNT}.`,
      children: workers,
    };
  }

  private async syncNativeTasks(project: StoredProject, fleets: FleetRunView[]): Promise<void> {
    for (const fleet of fleets) {
      if (!fleet.taskId || !fleet.linkedTaskRunId) continue;
      if (!isTerminalRunStatus(fleet.lifecycle)) continue;
      const run = await this.store.findTaskRunByUpstream(project.id, "fleet_run", fleet.runId);
      if (!run || run.state !== "running") continue;
      const state =
        fleet.lifecycle === "completed" || fleet.lifecycle === "partial"
          ? ("completed" as const)
          : fleet.lifecycle === "failed"
            ? ("failed" as const)
            : ("interrupted" as const);
      await this.store.finishTaskRun(
        run.id,
        state,
        `native fleet ${fleet.runId} settled ${fleet.lifecycle}`,
      );
      if (state === "completed") {
        // Completed engine dispatch is not completed work: the task enters
        // verification with a fresh workspace fingerprint.
        try {
          const fingerprint = workspaceFingerprint(project.canonicalPath);
          const task = await this.store.getTask(run.taskId);
          if (task && task.status === "running") {
            await this.store.markTaskVerifying(
              task.id,
              task.revision,
              fingerprint.digest,
              "mona_queue",
            );
          }
        } catch {
          // A fingerprint that cannot be taken leaves the task in `running`;
          // the settled run is still visible and the operator can reconcile.
        }
      }
    }
  }

  private async storedView(projectId: ProjectId): Promise<{
    agentRuns: AgentRunView[];
    fleets: FleetRunView[];
    goals: GoalView[];
    lastObservedAt: string | null;
  }> {
    const records = await this.store.listOrchestrationRuns(projectId);
    const agentRuns: AgentRunView[] = [];
    const fleets: FleetRunView[] = [];
    const workerRows = records.filter((record) => record.kind === "fleet_worker");
    for (const record of records) {
      if (record.kind === "agent_run") {
        agentRuns.push(storedAgentView(record));
      } else if (record.kind === "fleet_run") {
        const workers = workerRows
          .filter((worker) => worker.parentUpstreamId === record.upstreamId)
          .map(storedWorkerView);
        fleets.push(storedFleetView(record, workers));
      }
    }
    const goals = (await this.store.listGoalObservations(projectId)).map(
      (observation): GoalView => ({
        threadId: observation.threadId,
        goalId: observation.goalId,
        objective: observation.objective,
        status: observation.status,
        tokensUsed: observation.tokensUsed,
        timeUsedSeconds: observation.timeUsedSeconds,
        continuationCount: observation.continuationCount,
        repeatedGapCount: observation.repeatedGapCount,
        createdAt: observation.engineCreatedAt,
        updatedAt: observation.engineUpdatedAt,
        source: "stored",
        stale: true,
      }),
    );
    const lastObservedAt = records.reduce<string | null>(
      (current, record) =>
        current === null || record.lastSeenAt > current ? record.lastSeenAt : current,
      null,
    );
    return { agentRuns, fleets, goals, lastObservedAt };
  }

  private async persistViews(
    projectId: ProjectId,
    agentRuns: AgentRunView[],
    fleets: FleetRunView[],
    at: string,
  ): Promise<void> {
    for (const run of agentRuns) {
      await this.store.upsertOrchestrationRun({
        projectId,
        kind: "agent_run",
        upstreamId: run.runId,
        parentUpstreamId: run.parentRunId,
        label: run.label.slice(0, 300),
        status: run.status,
        workspace: run.workspace,
        branch: run.branch?.name ?? null,
        taskId: run.taskId,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        lastSeenAt: at,
        terminal: run.terminal,
        detail: {
          role: run.role,
          usageStatus: run.spend.confidence,
          artifactCount: run.artifacts.length,
          latestMessage: run.lastEvent?.message ?? null,
        },
      });
    }
    for (const fleet of fleets) {
      await this.persistFleet(projectId, fleet, at);
    }
  }

  private async persistFleet(projectId: ProjectId, fleet: FleetRunView, at: string): Promise<void> {
    await this.store.upsertOrchestrationRun({
      projectId,
      kind: "fleet_run",
      upstreamId: fleet.runId,
      parentUpstreamId: null,
      label: (fleet.name ?? fleet.workflow.id ?? fleet.runId).slice(0, 300),
      status: fleet.lifecycle,
      workspace: null,
      branch: null,
      taskId: fleet.taskId,
      startedAt: fleet.createdAt,
      updatedAt: fleet.updatedAt,
      lastSeenAt: at,
      terminal: isTerminalRunStatus(fleet.lifecycle),
      detail: {
        target: fleet.target,
        workflowKind: fleet.workflow.kind,
        taskCount: fleet.taskCount,
        workerCount: fleet.workerCount,
        receiptResults: fleet.receipts.map((receipt) => receipt.result).filter(Boolean),
      },
    });
    for (const worker of fleet.workers) {
      await this.store.upsertOrchestrationRun({
        projectId,
        kind: "fleet_worker",
        upstreamId: worker.workerId,
        parentUpstreamId: fleet.runId,
        label: `${worker.role ?? "worker"} ${worker.workerId}`.slice(0, 300),
        status: worker.status,
        workspace: null,
        branch: null,
        taskId: fleet.taskId,
        startedAt: null,
        updatedAt: worker.heartbeatAt,
        lastSeenAt: at,
        terminal: worker.status === "offline" || worker.status === "stopped",
        detail: {
          taskId: worker.taskId,
          host: worker.host,
          lastError: worker.lastError,
        },
      });
    }
  }

  private async persistGoal(projectId: ProjectId, goal: EngineGoal, at: string): Promise<void> {
    await this.store.upsertGoalObservation({
      projectId,
      threadId: goal.threadId,
      goalId: goal.goalId,
      objective: goal.objective,
      status: goal.status,
      tokensUsed: goal.tokensUsed,
      timeUsedSeconds: goal.timeUsedSeconds,
      continuationCount: goal.continuationCount,
      repeatedGapCount: goal.repeatedGapCount,
      engineCreatedAt: goal.createdAt,
      engineUpdatedAt: goal.updatedAt,
      observedAt: at,
    });
  }

  private async engagement(projectId: ProjectId): Promise<Engagement> {
    const tasks = await this.store.listTasks(projectId);
    const taskByTurn = new Map<string, TaskId>();
    const titles = new Map<TaskId, string>();
    for (const task of tasks) {
      titles.set(task.id, task.title);
      if (task.activeTurnId) taskByTurn.set(task.activeTurnId, task.id);
    }
    return { taskByTurn, titles };
  }

  private async branchFor(
    workspace: string | null,
    cache: Map<string, Promise<BranchView | null>>,
  ): Promise<BranchView | null> {
    if (!workspace) return null;
    const existing = cache.get(workspace);
    if (existing) return existing;
    const pending = this.branchReader(workspace).catch(() => null);
    cache.set(workspace, pending);
    return pending;
  }

  private async projectThreadIds(projectId: ProjectId): Promise<Set<string>> {
    const threads = await this.store.listThreads(projectId);
    return new Set(
      threads
        .map((thread) => thread.engineThreadId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );
  }

  private async requireProjectThread(projectId: ProjectId, engineThreadId: string): Promise<void> {
    const ids = await this.projectThreadIds(projectId);
    if (!ids.has(engineThreadId)) {
      throw new ObservatoryError(
        "INVALID_INPUT",
        "goal controls are scoped to a thread bound to this project",
        { threadId: engineThreadId },
      );
    }
  }

  private async requireProject(projectId: ProjectId): Promise<StoredProject> {
    const project = await this.store.getProject(projectId, { includeRemoved: true });
    if (!project) throw new ObservatoryError("NOT_FOUND", "project is not in the catalog");
    return project;
  }

  private requireAccess(projectId: ProjectId): ObservatoryEngineAccess {
    const access = this.engine(projectId);
    if (!access) {
      throw new ObservatoryError(
        "NOT_CONNECTED",
        "the live studio is not attached; start it to control native agents",
      );
    }
    return access;
  }

  private async record(
    projectId: ProjectId,
    action: string,
    upstreamId: string | null,
    accepted: boolean,
    status: number | null,
    message: string,
  ): Promise<void> {
    await this.store.recordOrchestrationEvent({
      id: `orc_${randomUUID().replaceAll("-", "")}`,
      projectId,
      action,
      upstreamId,
      accepted,
      status,
      message,
      createdAt: this.now().toISOString(),
    });
  }

  private async refused(
    projectId: ProjectId,
    action: string,
    upstreamId: string | null,
    error: unknown,
    message?: string,
  ): Promise<never> {
    const text = message ?? messageOf(error);
    const rawStatus = error instanceof AdapterError ? error.details?.status : null;
    const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) ? rawStatus : null;
    await this.record(projectId, action, upstreamId, false, status, text);
    throw error instanceof ObservatoryError || error instanceof AdapterError
      ? error
      : new ObservatoryError("CONTROL_REFUSED", text);
  }

  private async lastObservedAt(projectId: ProjectId): Promise<string | null> {
    const records = await this.store.listOrchestrationRuns(projectId);
    return records.reduce<string | null>(
      (current, record) =>
        current === null || record.lastSeenAt > current ? record.lastSeenAt : current,
      null,
    );
  }
}

interface Engagement {
  taskByTurn: Map<string, TaskId>;
  titles: Map<TaskId, string>;
}

function capabilitiesFromEngine(capabilities: Record<string, boolean>): OrchestrationCapabilities {
  const fleet =
    capabilities["fleet_run_create"] === true && capabilities["fleet_run_start"] === true;
  return {
    agentRuns: capabilities["worker_runtime"] === true,
    agentRunCancel: capabilities["worker_runtime"] === true,
    goals: capabilities["thread_goals"] === true,
    goalControls: capabilities["thread_goals"] === true,
    fleetCreate: fleet,
    fleetStart: fleet,
    fleetStop: fleet,
    workerStop: fleet,
    workerRestart: fleet,
    fleetReceipts: fleet,
    fleetReplay: capabilities["fleet_event_replay"] === true,
  };
}

function runBelongsToProject(
  run: EngineAgentRun,
  project: StoredProject,
  engineThreadIds: Set<string>,
): boolean {
  if (run.workspace) {
    return run.workspace === project.canonicalPath || run.workspace === project.rootPath;
  }
  return run.ownerSessionId !== null && engineThreadIds.has(run.ownerSessionId);
}

function labelFor(role: string | null, taskTitle: string | null, objective: string): string {
  if (taskTitle) return `${role ?? "agent"} · ${taskTitle}`.slice(0, 200);
  const firstLine = objective.split("\n")[0]?.trim() ?? "";
  const base = role ?? "Sub-agent";
  return (firstLine ? `${base} · ${firstLine}` : base).slice(0, 200);
}

function lastMeaningfulEvent(events: EngineRunEvent[]): RunEventView | null {
  const noise = new Set(["starting", "running", "leased", "enqueued", "queued"]);
  const meaningful = events.filter((event) => !noise.has(event.status));
  const chosen = meaningful[meaningful.length - 1] ?? events[events.length - 1] ?? null;
  if (!chosen) return null;
  return {
    seq: chosen.seq,
    at: chosen.at,
    status: chosen.status,
    message: chosen.message,
    kind: chosen.kind,
  };
}

function toolsFor(events: EngineRunEvent[]): ToolUsageView {
  const names = [
    ...new Set(events.map((event) => event.tool).filter((name): name is string => !!name)),
  ];
  if (names.length === 0) {
    return {
      names,
      source: "not_exposed",
      note: "This receipt names no tool calls. Mona does not parse prose to guess them.",
    };
  }
  return { names, source: "events", note: "Tool names come from lifecycle events." };
}

function testsFor(status: string | null, summary: string | null): TestEvidenceView {
  if (status === "verified" || status === "passed") {
    return {
      state: "verified",
      total: null,
      passed: null,
      failed: null,
      note: summary ?? "Engine verified.",
    };
  }
  if (status === "self_report_only") {
    return {
      state: "self_reported",
      total: null,
      passed: null,
      failed: null,
      note: summary ?? "The child reported its own result; no command or test receipt is attached.",
    };
  }
  return {
    state: "unknown",
    total: null,
    passed: null,
    failed: null,
    note: summary ?? "The engine record carries no test evidence.",
  };
}

function spendForAgent(run: EngineAgentRun): SpendView {
  const tokens: TokenUsageView | null =
    run.usage.inputTokens !== null ||
    run.usage.outputTokens !== null ||
    run.usage.cachedTokens !== null ||
    run.usage.reasoningTokens !== null
      ? {
          inputTokens: run.usage.inputTokens,
          outputTokens: run.usage.outputTokens,
          cachedTokens: run.usage.cachedTokens,
          reasoningTokens: run.usage.reasoningTokens,
        }
      : null;
  if (run.usage.status === "reported" && run.usage.costUsd !== null) {
    return {
      confidence: "priced",
      usd: run.usage.costUsd,
      tokens,
      source: "sub-agent worker ledger",
      note: "Reported by the engine for this sub-agent run.",
    };
  }
  if (run.usage.status === "reported" && tokens) {
    return {
      confidence: "unpriced",
      usd: null,
      tokens,
      source: "sub-agent worker ledger",
      note: "The engine reported tokens but no price for this run; no rate card is applied automatically.",
    };
  }
  return {
    confidence: "unknown",
    usd: null,
    tokens,
    source: "sub-agent worker ledger",
    note:
      run.usage.note ??
      "The engine has not reported usage for this sub-agent. Mona leaves it unknown.",
  };
}

function toArtifactView(artifact: {
  kind: string;
  path: string;
  checksum: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}) {
  return {
    kind: artifact.kind,
    path: artifact.path,
    checksum: artifact.checksum,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
  };
}

function workerView(
  worker: EngineFleetWorker,
  branch: BranchView | null,
  agent: AgentRunView | null,
): FleetWorkerView {
  void branch;
  return {
    kind: "fleet_worker",
    workerId: worker.workerId,
    role: worker.role,
    host: worker.host,
    status: worker.status,
    taskId: worker.taskId,
    objective: worker.objective,
    lastEvent:
      agent?.lastEvent ??
      (worker.lastEvent
        ? {
            seq: worker.lastEvent.seq,
            at: worker.lastEvent.at,
            status: worker.lastEvent.status,
            message: worker.lastEvent.message,
            kind: worker.lastEvent.kind,
          }
        : null),
    heartbeatAt: worker.heartbeatAt,
    artifacts: worker.artifacts.map(toArtifactView),
    lastError: worker.lastError,
    spend: agent?.spend ?? {
      confidence: "unknown",
      usd: null,
      tokens: null,
      source: "fleet worker record",
      note: "This worker record carries no usage. Mona leaves spend unknown.",
    },
    tools: agent?.tools ?? {
      names: [],
      source: "not_exposed",
      note: "This worker record names no tool calls.",
    },
    tests: agent?.tests ?? {
      state: "unknown",
      total: null,
      passed: null,
      failed: null,
      note: "This worker record carries no test evidence.",
    },
    children: [],
  };
}

function toReceiptView(receipt: EngineFleetReceipt): FleetReceiptView {
  return {
    taskId: receipt.taskId,
    workerId: receipt.workerId,
    attempt: receipt.attempt,
    completedAt: receipt.completedAt,
    result: receipt.result,
    failureKind: receipt.failureKind,
    failureClass: receipt.failureClass,
    retryEligible: receipt.retryEligible,
    score: receipt.score,
    artifacts: receipt.artifacts.map(toArtifactView),
    evidenceAvailable: receipt.evidenceAvailable,
  };
}

function toGoalView(goal: EngineGoal, stale: boolean): GoalView {
  return {
    threadId: goal.threadId,
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    continuationCount: goal.continuationCount,
    repeatedGapCount: goal.repeatedGapCount,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    source: stale ? "stored" : "engine",
    stale,
  };
}

function storedAgentView(record: OrchestrationRunRecord): AgentRunView {
  return {
    kind: "agent_run",
    runId: record.upstreamId,
    workerId: null,
    parentRunId: record.parentUpstreamId,
    actorKind: null,
    role: typeof record.detail.role === "string" ? record.detail.role : null,
    label: record.label,
    objectiveSummary: null,
    status: record.status,
    rawStatus: record.status,
    taskId: record.taskId,
    threadId: null,
    originTurnId: null,
    workspace: record.workspace,
    branch: record.branch
      ? { name: record.branch, head: null, dirty: null, source: "engine" }
      : null,
    lastEvent: null,
    tools: {
      names: [],
      source: "not_exposed",
      note: "Stored projection only; the live engine was not read.",
    },
    tests: {
      state: "unknown",
      total: null,
      passed: null,
      failed: null,
      note: "Stored projection only; no test result is retained.",
    },
    spend: {
      confidence: "unknown",
      usd: null,
      tokens: null,
      source: "stored projection",
      note: "No spend value is retained locally; reconnect to read the engine ledger.",
    },
    artifacts: [],
    children: [],
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.terminal ? record.updatedAt : null,
    terminal: record.terminal,
  };
}

function storedWorkerView(record: OrchestrationRunRecord): FleetWorkerView {
  return {
    kind: "fleet_worker",
    workerId: record.upstreamId,
    role: null,
    host: typeof record.detail.host === "string" ? record.detail.host : null,
    status: record.status,
    taskId: typeof record.detail.taskId === "string" ? record.detail.taskId : null,
    objective: null,
    lastEvent: null,
    heartbeatAt: record.updatedAt,
    artifacts: [],
    lastError: typeof record.detail.lastError === "string" ? record.detail.lastError : null,
    spend: {
      confidence: "unknown",
      usd: null,
      tokens: null,
      source: "stored projection",
      note: "No worker spend is retained locally.",
    },
    tools: {
      names: [],
      source: "not_exposed",
      note: "Stored projection only; no tool calls are retained.",
    },
    tests: {
      state: "unknown",
      total: null,
      passed: null,
      failed: null,
      note: "Stored projection only; no test result is retained.",
    },
    children: [],
  };
}

function storedFleetView(record: OrchestrationRunRecord, workers: FleetWorkerView[]): FleetRunView {
  return {
    kind: "fleet_run",
    runId: record.upstreamId,
    name: record.label,
    lifecycle: record.status,
    target: null,
    workflow: { id: null, kind: null },
    roles: [],
    createdAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.terminal ? record.updatedAt : null,
    taskCount: typeof record.detail.taskCount === "number" ? record.detail.taskCount : 0,
    workerCount:
      typeof record.detail.workerCount === "number" ? record.detail.workerCount : workers.length,
    taskId: record.taskId,
    linkedTaskRunId: null,
    lastEvent: null,
    events: [],
    tasks: [],
    workers,
    receipts: [],
    spend: {
      confidence: "not_reported",
      usd: null,
      tokens: null,
      source: "stored projection",
      note: "Stored projection only; reconnect to read fleet receipts.",
    },
    aggregateNote: `${AGGREGATE_NOTE} ${NO_DOUBLE_COUNT}.`,
    children: workers,
  };
}

function serialOnlyQualification(): ParallelQualification {
  return {
    requested: false,
    qualified: false,
    checks: [
      {
        id: "isolated_worktrees",
        label: "Isolated worktrees",
        passed: false,
        detail:
          "Fleet task workspaces are repo-relative inside the runtime workspace. True per-task Git worktree isolation is not verified, so Mona refuses parallel builders.",
      },
      {
        id: "branch_ownership",
        label: "Distinct branch ownership",
        passed: false,
        detail: "No parallel launch declares one branch per task; a serial run needs none.",
      },
      {
        id: "aggregate_limits",
        label: "Aggregate limits",
        passed: false,
        detail: "A parallel run needs one aggregate cost and concurrency limit; none is attached.",
      },
      {
        id: "merge_boundary",
        label: "Merge and review boundary",
        passed: false,
        detail:
          "A parallel run needs a designated merge/review task and base branch; none is declared.",
      },
    ],
    note: "Serial one-task launch is the only qualified mode. Parallel execution stays gated until every check passes.",
  };
}

function summarize(runs: AgentRunView[], fleets: FleetRunView[], goals: GoalView[]) {
  const workers = fleets.flatMap((fleet) => fleet.workers);
  const statuses = [...runs.map((run) => run.status), ...workers.map((worker) => worker.status)];
  const lifecycle = fleets.map((fleet) => fleet.lifecycle);
  return {
    runs: runs.length + workers.length,
    running:
      runs.filter((run) => run.status === "running" || run.status === "starting").length +
      fleets.filter((fleet) => ["running", "queued", "starting"].includes(fleet.lifecycle)).length +
      workers.filter((worker) => ["running", "leased"].includes(worker.status)).length,
    terminal:
      lifecycle.filter(isTerminalRunStatus).length + runs.filter((run) => run.terminal).length,
    failed: statuses.filter((status) => status === "failed").length,
    interrupted: statuses.filter((status) => status.startsWith("interrupted")).length,
    unknownSpend:
      runs.filter((run) => run.spend.confidence !== "priced").length +
      fleets.filter((fleet) => fleet.spend.confidence !== "priced").length,
    goalsActive: goals.filter((goal) => goal.status === "active").length,
    fleetRuns: fleets.length,
    fleetWorkers: workers.length,
  };
}

function sortAgents(runs: AgentRunView[]): AgentRunView[] {
  const priority = (run: AgentRunView): number =>
    run.status === "running" || run.status === "starting" ? 0 : run.terminal ? 2 : 1;
  return [...runs].sort((left, right) => {
    const byStatus = priority(left) - priority(right);
    if (byStatus !== 0) return byStatus;
    return (right.updatedAt ?? right.startedAt ?? "").localeCompare(
      left.updatedAt ?? left.startedAt ?? "",
    );
  });
}

function sortFleets(fleets: FleetRunView[]): FleetRunView[] {
  const priority = (fleet: FleetRunView): number =>
    fleet.lifecycle === "running" || fleet.lifecycle === "queued"
      ? 0
      : isTerminalRunStatus(fleet.lifecycle)
        ? 2
        : 1;
  return [...fleets].sort((left, right) => {
    const byStatus = priority(left) - priority(right);
    if (byStatus !== 0) return byStatus;
    return (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readGitBranch(workspace: string): Promise<BranchView | null> {
  const binary = resolveGitBinary();
  if (!binary) return null;
  try {
    const [name, head] = await Promise.all([
      runGit(binary, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspace }),
      runGit(binary, ["rev-parse", "--short", "HEAD"], { cwd: workspace }),
    ]);
    if (name.exitCode !== 0) return null;
    return {
      name: name.stdout.trim() || null,
      head: head.exitCode === 0 ? head.stdout.trim() || null : null,
      dirty: null,
      source: "local_git",
    };
  } catch {
    return null;
  }
}
