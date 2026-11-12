#!/usr/bin/env node
// P15 orchestration smoke. Default mode is deterministic and offline: it drives
// the observatory through child failure, disconnect, unknown usage, blocked
// dependency, cancel, and partial completion using a scripted adapter. `--live`
// starts the pinned engine, launches one real serial fleet task on this machine,
// records its real run/worker/receipt identities, and stops the owned runtime.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const { StateStore } = require(join(ROOT, "dist/main/main/state/store.js"));
const { AgentObservatory } = require(join(ROOT, "dist/main/main/work/agents.js"));
const { CodewhaleAdapter } = require(join(ROOT, "dist/main/main/engine/adapter.js"));
const { MemorySubmissionStore } = require(join(ROOT, "dist/main/main/engine/submission-store.js"));

const LIVE = process.argv.includes("--live");
const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;

const result = {
  schema_version: 1,
  mode: LIVE ? "live" : "fixture",
  ok: false,
  started_utc: new Date().toISOString(),
  project: null,
  checks: {},
  observations: [],
  live: null,
  error: null,
};

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function check(name, condition, detail) {
  result.checks[name] = { ok: Boolean(condition), detail: detail ?? null };
  if (!condition) result.ok = false;
}

async function createBench(label) {
  const base = await mkdtemp(join(tmpdir(), `mona-p15-${label}-`));
  const root = join(base, "workspace");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "README.md"), "# P15 agents smoke\n", "utf8");
  const store = await StateStore.open({
    dbPath: join(base, "state", "mona.sqlite"),
    artifactRoot: join(base, "artifacts"),
    backupDir: join(base, "backups"),
  });
  const project = await store.createProject({ name: "P15 agents", rootPath: root });
  await store.upsertThread({
    id: "thr_local_p15",
    projectId: project.id,
    engineThreadId: "thr_0123456789abcdef",
    title: "P15 goal thread",
  });
  return { base, root, store, project };
}

function agent(overrides = {}) {
  return {
    runId: "agent_fixture",
    workerId: "agent_fixture",
    parentRunId: null,
    actorKind: "subagent",
    role: "explore",
    objective: "Count the files and report the count",
    status: "running",
    model: "deepseek-flash",
    provider: "deepseek",
    workspace: null,
    ownerSessionId: "thr_0123456789abcdef",
    originTurnId: "turn_fixture",
    latestMessage: "running",
    stepsTaken: 0,
    events: [
      {
        seq: 2,
        at: "2026-11-12T07:45:30.000Z",
        status: "running",
        message: "running",
        kind: "lifecycle",
        tool: "read_file",
      },
    ],
    artifacts: [],
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

function fleet(overrides = {}) {
  return {
    runId: "fleet_fixture",
    name: "fixture workflow",
    lifecycle: "completed",
    target: "this_computer",
    workflow: { id: "fixture", kind: "parallel" },
    roles: ["reviewer"],
    taskCount: 1,
    workerCount: 1,
    tasks: [
      {
        taskId: "answer",
        name: "Answer",
        status: "completed",
        workerId: "fleet_fixture-local-1",
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

function detail(overrides = {}) {
  return {
    run: fleet(overrides.run),
    workers: [
      {
        workerId: "fleet_fixture-local-1",
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
        artifacts: [],
        lastError: null,
        raw: {},
      },
    ],
    receipts: [
      {
        taskId: "answer",
        workerId: "fleet_fixture-local-1",
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
        cursor: "fev1_fixture",
        event: "fleet.task.completed",
        taskId: "answer",
        workerId: "fleet_fixture-local-1",
        at: "2026-11-12T07:46:08Z",
        summary: "fleet.task.completed (completed)",
      },
    ],
    historyTruncated: false,
    ...overrides,
  };
}

function fixtureAdapter() {
  return {
    discover: async () => ({
      identity: { version: "0.10.2", commit: "ff466b2ed0bf" },
      transports: ["http", "sse"],
      capabilities: {
        worker_runtime: true,
        thread_goals: true,
        fleet_run_create: true,
        fleet_run_start: true,
        fleet_event_replay: true,
      },
    }),
    listAgentRuns: async () => ({ runs: [agent()], governor: null }),
    readAgentRun: async () => agent(),
    cancelAgentRun: async () => ({
      status: 202,
      accepted: true,
      message: "accepted",
      record: { status: "stopping" },
    }),
    listGoals: async () => [],
    readThreadGoal: async () => null,
    setThreadGoal: async () => {
      throw new Error("fixture does not set goals");
    },
    completeThreadGoal: async () => {
      throw new Error("fixture does not complete goals");
    },
    blockThreadGoal: async () => {
      throw new Error("fixture does not block goals");
    },
    clearThreadGoal: async () => ({ cleared: false, status: 404 }),
    listFleetRuns: async () => ({ runs: [fleet()], status: {} }),
    readFleetRun: async () => detail(),
    createFleetRun: async () => {
      throw new Error("fixture does not create fleet runs");
    },
    startFleetRun: async () => {
      throw new Error("fixture does not start fleet runs");
    },
    stopFleetRun: async () => ({
      status: 200,
      accepted: true,
      message: "stopped",
      record: {},
    }),
    stopFleetWorker: async () => ({
      status: 200,
      accepted: true,
      message: "stopped",
      record: {},
    }),
    restartFleetWorker: async () => ({
      status: 200,
      accepted: true,
      message: "restarted",
      record: {},
    }),
    readFleetReceipt: async () => detail().receipts[0],
    readFleetReceiptEvidence: async () => ({
      path: ".codewhale/fleet/verification.json",
      checksum: "sha256:fixture",
      sizeBytes: 12,
      truncated: false,
      content: { result: "partial" },
    }),
  };
}

function observatoryFor(store, engine) {
  return new AgentObservatory({
    store,
    engine,
    now: () => new Date("2026-11-12T08:00:00.000Z"),
    branchReader: async () => ({
      name: "main",
      head: "abc1234",
      dirty: null,
      source: "local_git",
    }),
  });
}

async function fixtureMode() {
  const bench = await createBench("fixture");
  const engine = fixtureAdapter();
  const observatory = observatoryFor(bench.store, () => ({
    adapter: engine,
    workspace: bench.root,
  }));
  result.project = { id: bench.project.id, root: bench.root };

  const live = await observatory.snapshot(bench.project.id);
  result.observations.push({
    step: "live",
    source: live.source,
    runs: live.runs.map((run) => ({
      runId: run.runId,
      status: run.status,
      spend: run.spend.confidence,
      tests: run.tests.state,
      tools: run.tools.names,
    })),
    fleets: live.fleets.map((entry) => ({
      runId: entry.runId,
      lifecycle: entry.lifecycle,
      receipts: entry.receipts.map((receipt) => receipt.result),
      worker: entry.workers[0]?.workerId ?? null,
    })),
    summary: live.summary,
  });
  check("real-subagent-identity", live.runs[0]?.runId === "agent_fixture");
  check("unknown-subagent-spend", live.runs[0]?.spend.confidence === "unknown");
  check("self-report-tests", live.runs[0]?.tests.state === "self_reported");
  check("partial-fleet-receipt", live.fleets[0]?.receipts[0]?.result === "partial");
  check("parent-child-not-additive", live.fleets[0]?.aggregateNote.includes("not additive"));
  check("serial-only", live.parallel.qualified === false);

  // Child failure is shown as a failed lifecycle, not a green success.
  const failedEngine = {
    ...engine,
    listAgentRuns: async () => ({
      runs: [
        agent({
          runId: "agent_failed",
          status: "failed",
          events: [
            {
              seq: 3,
              at: "2026-11-12T07:46:00.000Z",
              status: "failed",
              message: "tool failed",
              kind: "lifecycle",
              tool: null,
            },
          ],
          verification: { status: "failed", summary: "The child failed." },
          completedAt: "2026-11-12T07:46:00.000Z",
        }),
      ],
      governor: null,
    }),
  };
  const failedView = await observatoryFor(bench.store, () => ({
    adapter: failedEngine,
    workspace: bench.root,
  })).snapshot(bench.project.id);
  check(
    "child-failure-visible",
    failedView.runs[0]?.status === "failed" && failedView.runs[0]?.terminal === true,
    failedView.runs[0]?.status,
  );

  // Cancellation is an accepted 202, never a terminal claim.
  const cancel = await observatory.cancelAgentRun(bench.project.id, "agent_fixture");
  check("cancel-accepted-not-terminal", cancel.accepted && cancel.status === 202);
  const history = await observatory.history(bench.project.id);
  check(
    "cancel-receipt-recorded",
    history.some((event) => event.action === "agent_run_cancel"),
  );

  // Disconnect falls back to stored observations, with unknown spend preserved.
  const offline = await observatoryFor(bench.store, () => null).snapshot(bench.project.id);
  check(
    "disconnect-stored",
    offline.source === "stored" && offline.connected === false && offline.lastObservedAt !== null,
  );
  check(
    "disconnect-unknown-spend",
    offline.runs.every((run) => run.spend.confidence === "unknown"),
  );

  // A blocked dependency prevents a native launch before any engine call.
  const first = await bench.store.createTask({
    projectId: bench.project.id,
    title: "First",
    prompt: "Do first",
    owner: "native_workflow",
  });
  const second = await bench.store.createTask({
    projectId: bench.project.id,
    title: "Second",
    prompt: "Do second",
    owner: "native_workflow",
    dependsOn: [first.id],
  });
  let blocked = false;
  try {
    await observatory.launchFleet(bench.project.id, {
      projectId: bench.project.id,
      taskId: second.id,
      name: "Blocked",
      role: "worker",
      instructions: "Should not start",
      parallelism: "serial",
    });
  } catch (error) {
    blocked = /prerequisite/i.test(String(error?.message ?? error));
  }
  check("blocked-dependency-refused", blocked);

  check("fixture-suite", true);
  await rm(bench.base, { recursive: true, force: true });
}

async function liveMode() {
  const bench = await createBench("live");
  result.project = { id: bench.project.id, root: bench.root };
  const stateDir = join(bench.base, "engine-state");
  const adapter = new CodewhaleAdapter({ store: new MemorySubmissionStore() });
  const observatory = observatoryFor(bench.store, () => ({
    adapter,
    workspace: bench.project.canonicalPath,
  }));
  let handle = null;
  try {
    handle = await adapter.startOwnedRuntime({
      workspace: bench.project.canonicalPath,
      stateDir,
      logDir: join(stateDir, "logs"),
      startupTimeoutMs: 30_000,
    });
    result.live = {
      port: handle.port,
      listener_pid: handle.listenerPid,
      engine: handle.engine,
    };
    const task = await bench.store.createTask({
      projectId: bench.project.id,
      title: "P15 live workflow",
      prompt: "Reply with exactly P15-OK. Do not edit files.",
      owner: "native_workflow",
      acceptance: [{ text: "The engine recorded a terminal receipt", kind: "check" }],
    });
    result.live.task_id = task.id;
    const launched = await observatory.launchFleet(bench.project.id, {
      projectId: bench.project.id,
      taskId: task.id,
      expectedRevision: task.revision,
      name: "p15 live smoke",
      role: "reviewer",
      instructions: "Reply with exactly: P15-OK. Do not read, create, edit, or delete any file.",
      parallelism: "serial",
    });
    result.live.run_id = launched.runId;
    result.live.launch = {
      accepted: launched.receipt.accepted,
      status: launched.receipt.status,
      message: launched.receipt.message,
    };
    check("live-launch-accepted", launched.receipt.accepted === true);
    if (!launched.runId) throw new Error("the engine did not return a fleet run id");

    let last = null;
    for (let attempt = 0; attempt < 45; attempt += 1) {
      last = await adapter.readFleetRun(launched.runId);
      if (["completed", "partial", "failed", "cancelled", "stale"].includes(last.run.lifecycle)) {
        break;
      }
      await sleep(2_000);
    }
    const settled = last !== null;
    check(
      "live-run-settled",
      settled &&
        ["completed", "partial", "failed", "cancelled", "stale"].includes(last.run.lifecycle),
      last?.run.lifecycle ?? "no detail",
    );
    result.live.run = last
      ? {
          lifecycle: last.run.lifecycle,
          tasks: last.run.tasks,
          workers: last.workers.map((worker) => ({
            workerId: worker.workerId,
            role: worker.role,
            status: worker.status,
            lastEvent: worker.lastEvent?.message ?? null,
          })),
          receipts: last.receipts.map((receipt) => ({
            taskId: receipt.taskId,
            result: receipt.result,
            score: receipt.score,
            evidenceAvailable: receipt.evidenceAvailable,
          })),
          events: last.events.slice(-5),
        }
      : null;
    check("live-worker-recorded", (last?.workers.length ?? 0) > 0);
    check("live-receipt-recorded", (last?.receipts.length ?? 0) > 0);

    // The receipt's verification evidence is a real read route; record what it
    // returns so the observatory's evidence panel is proven, not assumed.
    const firstReceipt = last?.receipts[0];
    if (firstReceipt?.evidenceAvailable) {
      try {
        const evidence = await adapter.readFleetReceiptEvidence(
          launched.runId,
          firstReceipt.taskId,
        );
        result.live.evidence = {
          path: evidence.path,
          checksum: evidence.checksum,
          size_bytes: evidence.sizeBytes,
          truncated: evidence.truncated,
          content_keys:
            evidence.content && typeof evidence.content === "object"
              ? Object.keys(evidence.content).slice(0, 12)
              : null,
        };
        check("live-evidence-readable", evidence.path !== null);
      } catch (error) {
        result.live.evidence = { error: String(error) };
        check("live-evidence-readable", false, String(error));
      }
    } else {
      check("live-evidence-readable", false, "the receipt reported no evidence route");
    }

    const view = await observatory.snapshot(bench.project.id);
    result.live.observatory = {
      source: view.source,
      connected: view.connected,
      fleets: view.fleets.map((entry) => ({
        runId: entry.runId,
        lifecycle: entry.lifecycle,
        taskId: entry.taskId,
        workerCount: entry.workerCount,
        spend: entry.spend.confidence,
        workers: entry.workers.map((worker) => ({
          workerId: worker.workerId,
          status: worker.status,
          spend: worker.spend.confidence,
          spendNote: worker.spend.note,
          tests: worker.tests.state,
          tools: worker.tools.names,
        })),
      })),
      ownership: view.ownership,
      summary: view.summary,
    };
    const linked = view.fleets.find((entry) => entry.runId === launched.runId);
    check("live-fleet-visible", Boolean(linked));
    // The fleet worker's ledger row carries unknown usage and a self-reported
    // verification; the worker row must inherit both rather than invent either.
    const liveWorker = linked?.workers[0];
    check(
      "live-worker-inherits-ledger",
      liveWorker !== undefined &&
        liveWorker.spend.confidence === "unknown" &&
        liveWorker.tests.state === "self_reported" &&
        (liveWorker.spend.note ?? "").length > 0,
      liveWorker ? `${liveWorker.spend.confidence}/${liveWorker.tests.state}` : "no worker",
    );
    check("live-task-linked", linked?.taskId === task.id);
    const after = await bench.store.getTask(task.id);
    check(
      "live-task-not-auto-completed",
      after?.status === "verifying" || after?.status === "interrupted",
      after?.status,
    );
    check("live-one-mutating-owner-cleared", view.ownership.activeTaskId === null);

    // Leave no queued run behind on this machine.
    if (last && !["completed", "failed", "cancelled"].includes(last.run.lifecycle)) {
      await adapter.stopFleetRun(launched.runId).catch(() => undefined);
    }
  } finally {
    if (handle) await adapter.shutdownOwnedRuntime(handle).catch(() => undefined);
    await rm(bench.base, { recursive: true, force: true });
  }
}

try {
  if (LIVE) await liveMode();
  else await fixtureMode();
  result.ok = Object.values(result.checks).every((entry) => entry.ok);
} catch (error) {
  result.ok = false;
  result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
result.finished_utc = new Date().toISOString();
if (OUT) await writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
