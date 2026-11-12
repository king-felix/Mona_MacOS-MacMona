import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProjectId, TaskId, ThreadId } from "../src/shared/contracts";
import type {
  EngineAgentRun,
  EngineFleetRunDetail,
  EngineFleetRun,
  EngineGoal,
} from "../src/main/engine/types";
import type { EngineAdapter } from "../src/main/engine/types";
import { AgentObservatory, ObservatoryError } from "../src/main/work/agents";
import type { StateStore } from "../src/main/state/store";
import { openTestStore, tempDir } from "./helpers/state";

const ENGINE_THREAD = "thr_0123456789abcdef";
const ORIGIN_TURN = "turn_0123456789abcdef";

interface Bench {
  store: StateStore;
  projectId: ProjectId;
  root: string;
}

async function bench(): Promise<Bench> {
  const { store } = await openTestStore();
  const root = tempDir("mona-agents-project-");
  writeFileSync(join(root, "README.md"), "# Agents\n", "utf8");
  const project = await store.createProject({ name: "Agents project", rootPath: root });
  await store.upsertThread({
    id: "thr_local_0001",
    projectId: project.id as ProjectId,
    engineThreadId: ENGINE_THREAD,
    title: "Studio thread",
  });
  return { store, projectId: project.id as ProjectId, root };
}

function agentRun(overrides: Partial<EngineAgentRun> = {}): EngineAgentRun {
  return {
    runId: "agent_1",
    workerId: "agent_1",
    parentRunId: null,
    actorKind: "subagent",
    role: "explore",
    objective: "Count the files and report the count",
    status: "running",
    model: "deepseek-flash",
    provider: "deepseek",
    workspace: null,
    ownerSessionId: ENGINE_THREAD,
    originTurnId: ORIGIN_TURN,
    latestMessage: "running",
    stepsTaken: 0,
    events: [
      {
        seq: 1,
        at: "2026-11-12T07:45:30.000Z",
        status: "starting",
        message: "starting",
        kind: "lifecycle",
        tool: null,
      },
      {
        seq: 2,
        at: "2026-11-12T07:45:30.100Z",
        status: "running",
        message: "running",
        kind: "lifecycle",
        tool: "read_file",
      },
    ],
    artifacts: [
      { kind: "receipt", path: "agent_1", checksum: null, mimeType: null, sizeBytes: null },
    ],
    usage: {
      status: "unknown",
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
      costUsd: null,
      note: "Token usage is not yet reported by the sub-agent worker ledger.",
    },
    verification: {
      status: "self_report_only",
      summary: "No verified command or test receipt is attached.",
    },
    createdAt: "2026-11-12T07:45:30.000Z",
    updatedAt: "2026-11-12T07:45:30.100Z",
    startedAt: "2026-11-12T07:45:30.100Z",
    completedAt: null,
    raw: {},
    ...overrides,
  };
}

function fleetRun(overrides: Partial<EngineFleetRun> = {}): EngineFleetRun {
  return {
    runId: "fleet-abc",
    name: "p15-live-smoke",
    lifecycle: "completed",
    target: "this_computer",
    workflow: { id: "p15-live-smoke", kind: "parallel" },
    roles: ["reviewer"],
    taskCount: 1,
    workerCount: 1,
    tasks: [
      {
        taskId: "answer",
        name: "Answer",
        status: "completed",
        workerId: "fleet-abc-local-1",
        attempts: 1,
        role: "reviewer",
      },
    ],
    createdAt: "2026-11-12T07:46:06Z",
    updatedAt: "2026-11-12T07:46:08Z",
    completedAt: null,
    raw: {},
    ...overrides,
  };
}

function fleetDetail(overrides: Partial<EngineFleetRun> = {}): EngineFleetRunDetail {
  return {
    run: fleetRun(overrides),
    workers: [
      {
        workerId: "fleet-abc-local-1",
        status: "online",
        taskId: "answer",
        objective: null,
        role: "reviewer",
        host: "local",
        lastEvent: {
          seq: 12,
          at: "2026-11-12T07:46:08Z",
          status: "completed",
          message: "completed exit_code=0 P15-OK",
          kind: "lifecycle",
          tool: null,
        },
        heartbeatAt: "2026-11-12T07:46:08Z",
        artifacts: [
          {
            kind: "log",
            path: ".codewhale/fleet/answer.log",
            checksum: null,
            mimeType: "text/plain",
            sizeBytes: 102,
          },
        ],
        lastError: null,
        raw: {},
      },
    ],
    receipts: [
      {
        taskId: "answer",
        workerId: "fleet-abc-local-1",
        attempt: 1,
        completedAt: "2026-11-12T07:46:08Z",
        result: "partial",
        failureKind: null,
        failureClass: null,
        retryEligible: false,
        score: { value: 0.5, max: 1, notes: "no scorer configured" },
        artifacts: [],
        evidenceAvailable: true,
      },
    ],
    events: [
      {
        cursor: "fev1_x",
        event: "fleet.run.status_changed",
        taskId: null,
        workerId: null,
        at: "2026-11-12T07:46:06Z",
        summary: "fleet.run.status_changed (running)",
      },
    ],
    historyTruncated: false,
  };
}

function goal(overrides: Partial<EngineGoal> = {}): EngineGoal {
  return {
    threadId: ENGINE_THREAD,
    goalId: "goal-1",
    objective: "Finish the migration",
    status: "active",
    tokensUsed: 12,
    timeUsedSeconds: 3,
    continuationCount: 1,
    repeatedGapCount: 0,
    createdAt: "2026-11-12T07:45:00.000Z",
    updatedAt: "2026-11-12T07:45:10.000Z",
    ...overrides,
  };
}

function adapter(overrides: Record<string, unknown> = {}): EngineAdapter {
  const base = {
    discover: vi.fn(async () => ({
      identity: { version: "0.10.2", commit: "ff466b2ed0bf" },
      transports: ["http", "sse"],
      capabilities: {
        worker_runtime: true,
        thread_goals: true,
        fleet_run_create: true,
        fleet_run_start: true,
        fleet_event_replay: true,
      },
    })),
    listAgentRuns: vi.fn(async () => ({ runs: [agentRun()], governor: null })),
    readAgentRun: vi.fn(async () => agentRun()),
    cancelAgentRun: vi.fn(async () => ({
      status: 202,
      accepted: true,
      message: "accepted",
      record: { status: "stopping" },
    })),
    listGoals: vi.fn(async () => [goal()]),
    readThreadGoal: vi.fn(async () => goal()),
    setThreadGoal: vi.fn(async (_thread: ThreadId, objective: string) =>
      goal({ objective, status: "active" }),
    ),
    completeThreadGoal: vi.fn(async () => goal({ status: "complete" })),
    blockThreadGoal: vi.fn(async () => goal({ status: "blocked" })),
    clearThreadGoal: vi.fn(async () => true),
    listFleetRuns: vi.fn(async () => ({ runs: [fleetRun()], status: {} })),
    readFleetRun: vi.fn(async () => fleetDetail()),
    createFleetRun: vi.fn(async (spec: any) => ({
      run: fleetRun({
        runId: "fleet-new",
        name: spec.name,
        lifecycle: "queued",
        tasks: [
          {
            taskId: "task",
            name: "Task",
            status: "enqueued",
            workerId: null,
            attempts: 0,
            role: spec.workflow.tasks[0].worker.role,
          },
        ],
      }),
      execution: "awaiting_start",
      warnings: [],
    })),
    startFleetRun: vi.fn(async () => ({
      status: 202,
      accepted: true,
      message: "scheduled",
      record: { action: "start", run_id: "fleet-new" },
    })),
    stopFleetRun: vi.fn(async () => ({
      status: 200,
      accepted: true,
      message: "stopped",
      record: { action: "stop" },
    })),
    stopFleetWorker: vi.fn(async () => ({
      status: 200,
      accepted: true,
      message: "stopped",
      record: {},
    })),
    restartFleetWorker: vi.fn(async () => ({
      status: 200,
      accepted: true,
      message: "restarted",
      record: {},
    })),
    readFleetReceipt: vi.fn(),
    readFleetReceiptEvidence: vi.fn(),
    ...overrides,
  };
  return base as unknown as EngineAdapter;
}

function observatory(
  store: StateStore,
  engine: () => { adapter: EngineAdapter; workspace: string } | null,
): AgentObservatory {
  return new AgentObservatory({
    store,
    engine,
    now: () => new Date("2026-11-12T08:00:00.000Z"),
    detailLimit: 5,
    branchReader: async () => ({
      name: "main",
      head: "abc1234",
      dirty: null,
      source: "local_git",
    }),
  });
}

describe("agent observatory", () => {
  it("shows real identities, unknown spend, and a partial fleet receipt", async () => {
    const b = await bench();
    const engine = adapter();
    const view = await observatory(b.store, () => ({
      adapter: engine,
      workspace: b.root,
    })).snapshot(b.projectId);
    expect(view.source).toBe("engine");
    expect(view.connected).toBe(true);
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]?.runId).toBe("agent_1");
    expect(view.runs[0]?.spend.confidence).toBe("unknown");
    expect(view.runs[0]?.spend.note).toContain("not yet reported");
    expect(view.runs[0]?.lastEvent?.status).toBe("running");
    expect(view.runs[0]?.tools.names).toEqual(["read_file"]);
    expect(view.runs[0]?.tests.state).toBe("self_reported");
    expect(view.fleets[0]?.lifecycle).toBe("completed");
    expect(view.fleets[0]?.receipts[0]?.result).toBe("partial");
    expect(view.fleets[0]?.spend.confidence).toBe("not_reported");
    expect(view.fleets[0]?.aggregateNote).toContain("not additive");
    expect(view.goals[0]?.goalId).toBe("goal-1");
    expect(view.summary.unknownSpend).toBe(2);
    expect(view.parallel.qualified).toBe(false);
    expect(view.parallel.checks.every((check) => check.passed)).toBe(false);
    expect(view.capabilities.fleetCreate).toBe(true);
  });

  it("attributes a sub-agent to its active board task without inventing a parent", async () => {
    const b = await bench();
    await b.store.createTask({
      projectId: b.projectId,
      title: "Count files",
      prompt: "Count them",
      owner: "mona_queue",
    });
    const view = await observatory(b.store, () => ({
      adapter: adapter(),
      workspace: b.root,
    })).snapshot(b.projectId);
    // The store may not claim a turn outside a real dispatch; the run still
    // names its origin turn and never invents a task id.
    expect(view.runs[0]?.originTurnId).toBe(ORIGIN_TURN);
    expect(view.runs[0]?.parentRunId).toBeNull();
  });

  it("keeps parent and child spend separate and never adds them", async () => {
    const b = await bench();
    const parent = agentRun({
      runId: "agent_parent",
      workerId: "agent_parent",
      usage: {
        status: "reported",
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 0,
        reasoningTokens: 0,
        costUsd: 0.01,
        note: null,
      },
    });
    const child = agentRun({
      runId: "agent_child",
      workerId: "agent_child",
      parentRunId: "agent_parent",
      usage: {
        status: "unknown",
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        reasoningTokens: null,
        costUsd: null,
        note: "Child usage is not reported.",
      },
    });
    const engine = adapter({
      listAgentRuns: vi.fn(async () => ({ runs: [parent, child], governor: null })),
    });
    const view = await observatory(b.store, () => ({
      adapter: engine,
      workspace: b.root,
    })).snapshot(b.projectId);
    expect(view.runs).toHaveLength(2);
    const parentView = view.runs.find((run) => run.runId === "agent_parent");
    const childView = view.runs.find((run) => run.runId === "agent_child");
    expect(parentView?.spend.confidence).toBe("priced");
    expect(parentView?.spend.usd).toBe(0.01);
    expect(childView?.spend.confidence).toBe("unknown");
    expect(childView?.parentRunId).toBe("agent_parent");
    // The view has no aggregate amount to add: each run reports its own spend.
    expect(Object.keys(view).some((key) => /total/i.test(key))).toBe(false);
    expect(view.fleets[0]?.aggregateNote).toContain("never added");
  });

  it("falls back to a stored projection when the studio is detached", async () => {
    const b = await bench();
    const engine = adapter();
    const live = observatory(b.store, () => ({ adapter: engine, workspace: b.root }));
    await live.snapshot(b.projectId);
    const offline = await observatory(b.store, () => null).snapshot(b.projectId);
    expect(offline.source).toBe("stored");
    expect(offline.connected).toBe(false);
    expect(offline.reason).toContain("not attached");
    expect(offline.runs[0]?.runId).toBe("agent_1");
    expect(offline.runs[0]?.spend.confidence).toBe("unknown");
    expect(offline.fleets[0]?.runId).toBe("fleet-abc");
    expect(offline.lastObservedAt).not.toBeNull();
    expect(offline.goals[0]?.stale).toBe(true);
  });

  it("keeps a section's last observation when its live read fails", async () => {
    const b = await bench();
    const good = adapter();
    const live = observatory(b.store, () => ({ adapter: good, workspace: b.root }));
    await live.snapshot(b.projectId);

    // The fleet route now fails while the transport and the other routes work.
    const flaky = adapter({
      listFleetRuns: vi.fn(async () => {
        throw new Error("fleet route returned 503");
      }),
    });
    const view = await observatory(b.store, () => ({
      adapter: flaky,
      workspace: b.root,
    })).snapshot(b.projectId);
    expect(view.source).toBe("engine");
    expect(view.connected).toBe(true);
    // The stored fleet row survives; an empty list would be a false negative.
    expect(view.fleets[0]?.runId).toBe("fleet-abc");
    expect(view.notes.some((note) => note.includes("Fleet runs unavailable"))).toBe(true);
    // The sub-agent read succeeded, so that section is live.
    expect(view.runs[0]?.runId).toBe("agent_1");
  });

  it("falls back to stored data with a stated reason when every list read fails", async () => {
    const b = await bench();
    await observatory(b.store, () => ({ adapter: adapter(), workspace: b.root })).snapshot(
      b.projectId,
    );
    const broken = adapter({
      listAgentRuns: vi.fn(async () => {
        throw new Error("agent route down");
      }),
      listFleetRuns: vi.fn(async () => {
        throw new Error("fleet route down");
      }),
      listGoals: vi.fn(async () => {
        throw new Error("goal route down");
      }),
    });
    const view = await observatory(b.store, () => ({
      adapter: broken,
      workspace: b.root,
    })).snapshot(b.projectId);
    expect(view.source).toBe("stored");
    expect(view.connected).toBe(true);
    expect(view.reason).toContain("returned no orchestration data");
    expect(view.runs.length).toBeGreaterThan(0);
    expect(view.fleets.length).toBeGreaterThan(0);
  });

  it("records a 202 cancellation and does not claim a terminal receipt", async () => {
    const b = await bench();
    const engine = adapter();
    const live = observatory(b.store, () => ({ adapter: engine, workspace: b.root }));
    const receipt = await live.cancelAgentRun(b.projectId, "agent_1");
    expect(receipt.accepted).toBe(true);
    expect(receipt.status).toBe(202);
    expect(receipt.message).toContain("poll");
    const history = await live.history(b.projectId);
    expect(history[0]?.action).toBe("agent_run_cancel");
  });

  it("refuses control without a live studio", async () => {
    const b = await bench();
    const live = observatory(b.store, () => null);
    await expect(live.cancelAgentRun(b.projectId, "agent_1")).rejects.toBeInstanceOf(
      ObservatoryError,
    );
  });
});

describe("fleet evidence", () => {
  it("names the task it belongs to and refuses without a live studio", async () => {
    const b = await bench();
    const engine = adapter({
      readFleetReceiptEvidence: vi.fn(async () => ({
        path: ".codewhale/fleet/answer/verification.json",
        checksum: "sha256:abc",
        sizeBytes: 12,
        truncated: false,
        content: { result: "partial" },
      })),
    });
    const live = observatory(b.store, () => ({ adapter: engine, workspace: b.root }));
    const evidence = await live.fleetEvidence(b.projectId, "fleet-abc", "answer");
    expect(evidence.taskId).toBe("answer");
    expect(evidence.path).toContain("verification.json");
    expect(evidence.content).toEqual({ result: "partial" });
    // The adapter is asked for exactly this run and task, never a remembered one.
    const calls = (engine.readFleetReceiptEvidence as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    expect(calls[0]).toEqual(["fleet-abc", "answer"]);

    await expect(
      observatory(b.store, () => null).fleetEvidence(b.projectId, "fleet-abc", "answer"),
    ).rejects.toBeInstanceOf(ObservatoryError);
  });
});

describe("native task ownership and launch", () => {
  it("refuses a fleet launch for a Mona-queue task", async () => {
    const b = await bench();
    const task = await b.store.createTask({
      projectId: b.projectId,
      title: "Queue task",
      prompt: "Do it",
      owner: "mona_queue",
    });
    const live = observatory(b.store, () => ({
      adapter: adapter(),
      workspace: b.root,
    }));
    await expect(
      live.launchFleet(b.projectId, {
        projectId: b.projectId,
        taskId: task.id,
        name: "Nope",
        role: "worker",
        instructions: "Do it",
        parallelism: "serial",
      }),
    ).rejects.toMatchObject({ code: "NOT_A_NATIVE_TASK" });
  });

  it("launches one serial run, links it, and moves the task to verification when it settles", async () => {
    const b = await bench();
    const task = await b.store.createTask({
      projectId: b.projectId,
      title: "Native task",
      prompt: "Do the bounded thing",
      owner: "native_workflow",
      acceptance: [{ text: "The thing exists", kind: "check" }],
    });
    const engine = adapter({
      listFleetRuns: vi.fn(async () => ({
        runs: [fleetRun({ runId: "fleet-new", lifecycle: "completed" })],
        status: {},
      })),
      readFleetRun: vi.fn(async () => fleetDetail({ runId: "fleet-new" })),
    });
    const live = observatory(b.store, () => ({ adapter: engine, workspace: b.root }));
    const launched = await live.launchFleet(b.projectId, {
      projectId: b.projectId,
      taskId: task.id as TaskId,
      expectedRevision: task.revision,
      name: "Serial native task",
      role: "worker",
      instructions: "Do the bounded thing",
      parallelism: "serial",
    });
    expect(launched.runId).toBe("fleet-new");
    expect(launched.receipt.accepted).toBe(true);
    const running = await b.store.activeTaskRun(b.projectId);
    expect(running?.taskId).toBe(task.id);
    expect(running?.owner).toBe("native_workflow");
    expect(
      await b.store.findTaskRunByUpstream(b.projectId, "fleet_run", "fleet-new"),
    ).not.toBeNull();

    const view = await live.snapshot(b.projectId);
    expect(view.fleets[0]?.taskId).toBe(task.id);
    expect(view.ownership.activeTaskId).toBeNull();
    const settled = await b.store.getTask(task.id as TaskId);
    expect(settled?.status).toBe("verifying");
    expect(settled?.verificationFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("launch failure paths", () => {
  it("fails the local run and records a receipt when fleet creation is refused", async () => {
    const b = await bench();
    const task = await b.store.createTask({
      projectId: b.projectId,
      title: "Native task",
      prompt: "Do it",
      owner: "native_workflow",
    });
    const engine = adapter({
      createFleetRun: vi.fn(async () => {
        throw new Error("fleet create returned 422: invalid workspace");
      }),
    });
    const live = observatory(b.store, () => ({ adapter: engine, workspace: b.root }));
    await expect(
      live.launchFleet(b.projectId, {
        projectId: b.projectId,
        taskId: task.id as TaskId,
        name: "Doomed run",
        role: "worker",
        instructions: "Do it",
        parallelism: "serial",
      }),
    ).rejects.toThrow(/422/);
    // No local run may stay running, and the refusal is on the record.
    expect(await b.store.activeTaskRun(b.projectId)).toBeNull();
    const history = await live.history(b.projectId);
    expect(history.some((event) => event.action === "fleet_create" && !event.accepted)).toBe(true);
  });

  it("stops a created run that could not be linked, instead of leaving it unowned", async () => {
    const b = await bench();
    const first = await b.store.createTask({
      projectId: b.projectId,
      title: "First",
      prompt: "One",
      owner: "native_workflow",
    });
    const second = await b.store.createTask({
      projectId: b.projectId,
      title: "Second",
      prompt: "Two",
      owner: "native_workflow",
    });
    // Occupy the upstream id with an unrelated local run.
    const occupied = await b.store.beginTaskRun({ taskId: first.id, owner: "native_workflow" });
    await b.store.linkTaskRunUpstream(occupied.run.id, "fleet_run", "fleet-new");
    await b.store.finishTaskRun(occupied.run.id, "interrupted", "held for the collision test");

    const engine = adapter();
    const live = observatory(b.store, () => ({ adapter: engine, workspace: b.root }));
    await expect(
      live.launchFleet(b.projectId, {
        projectId: b.projectId,
        taskId: second.id as TaskId,
        name: "Collision",
        role: "worker",
        instructions: "Two",
        parallelism: "serial",
      }),
    ).rejects.toThrow();
    // The engine run was created and then stopped; it is never left unowned.
    expect(
      (engine.startFleetRun as unknown as { mock: { calls: unknown[] } }).mock.calls,
    ).toHaveLength(0);
    expect(
      (engine.stopFleetRun as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
    ).toBeGreaterThan(0);
    expect(await b.store.activeTaskRun(b.projectId)).toBeNull();
  });
});

describe("goal controls", () => {
  it("scopes goal writes to a thread bound to the project", async () => {
    const b = await bench();
    const engine = adapter();
    const live = observatory(b.store, () => ({ adapter: engine, workspace: b.root }));
    const receipt = await live.setGoal(b.projectId, ENGINE_THREAD, "Ship it");
    expect(receipt.accepted).toBe(true);
    expect(receipt.message).toContain("engine now owns");
    await expect(
      live.setGoal(b.projectId, "thr_ffffffffffffffff", "Not this project"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("completes, blocks, and clears through the adapter and records each receipt", async () => {
    const b = await bench();
    const engine = adapter();
    const live = observatory(b.store, () => ({ adapter: engine, workspace: b.root }));
    expect((await live.completeGoal(b.projectId, ENGINE_THREAD)).accepted).toBe(true);
    expect((await live.blockGoal(b.projectId, ENGINE_THREAD, "Needs a decision")).accepted).toBe(
      true,
    );
    expect((await live.clearGoal(b.projectId, ENGINE_THREAD)).accepted).toBe(true);
    const actions = (await live.history(b.projectId)).map((event) => event.action);
    expect(actions).toContain("goal_complete");
    expect(actions).toContain("goal_block");
    expect(actions).toContain("goal_block_note");
    expect(actions).toContain("goal_clear");
  });
});
