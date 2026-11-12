import { describe, expect, it } from "vitest";
import { CodewhaleAdapter } from "../src/main/engine/adapter";
import { AdapterError } from "../src/main/engine/errors";
import { MemorySubmissionStore } from "../src/main/engine/submission-store";
import type { ThreadId } from "../src/shared/contracts";
import { fixture, FixtureTransport, jsonResponse } from "./helpers/fixture-transport";

type Json = Record<string, any>;

const THREAD = "thr_0123456789abcdef" as ThreadId;
const RUN = "agent_8f9c0296";
const FLEET = "fleet-efb4a405";
const WORKER = "fleet-efb4a405-local-1";

const agentRecord = (overrides: Json = {}): Json => ({
  spec: {
    worker_id: RUN,
    run_id: RUN,
    objective: "Count the files and report the count",
    role: "explore",
    model: "deepseek-flash",
    workspace: "/tmp/mona-ws",
  },
  owner_session_id: THREAD,
  runtime_origin_turn_id: "turn_da0603c4ac9c48b180288b485e60ff16",
  actor_kind: "subagent",
  status: "running",
  latest_message: "running",
  steps_taken: 0,
  events: [
    { seq: 1, status: "starting", timestamp_ms: 1794469530686, message: "starting" },
    {
      seq: 2,
      status: "running",
      timestamp_ms: 1794469530699,
      message: "running",
      tool_name: "read_file",
    },
  ],
  artifacts: [
    { kind: "receipt", name: "result_summary", target: RUN, description: "child summary" },
  ],
  usage: {
    status: "unknown",
    note: "Token usage is not yet reported by the sub-agent worker ledger.",
  },
  verification: { status: "self_report_only", summary: "No verified command or test receipt." },
  created_at_ms: 1794469530686,
  updated_at_ms: 1794469530699,
  started_at_ms: 1794469530699,
  ...overrides,
});

const goalRecord = (overrides: Json = {}): Json => ({
  thread_id: THREAD,
  goal_id: "goal-1",
  objective: "Finish the migration",
  status: "active",
  tokens_used: 12,
  time_used_seconds: 3,
  continuation_count: 1,
  repeated_gap_count: 0,
  created_at: 1794469396,
  updated_at: 1794469396,
  ...overrides,
});

const fleetRecord = (overrides: Json = {}): Json => ({
  id: FLEET,
  name: "p15-live-smoke",
  lifecycle_status: "completed",
  target: "this_computer",
  workflow: { id: "p15-live-smoke", kind: "parallel" },
  roles: ["reviewer"],
  task_count: 1,
  worker_count: 1,
  tasks: [{ task_id: "answer", status: "completed", leased_to: WORKER, attempts: 1 }],
  task_specs: [{ id: "answer", name: "Answer", worker: { role: "reviewer" } }],
  worker_specs: [{ id: WORKER }],
  created_at: "2026-11-12T07:46:06Z",
  updated_at: "2026-11-12T07:46:08Z",
  completed_at: null,
  ...overrides,
});

const workerRecord = (overrides: Json = {}): Json => ({
  worker_id: WORKER,
  status: "online",
  run_id: FLEET,
  task_id: "answer",
  objective: null,
  role: "reviewer",
  host: "local",
  latest_heartbeat_at: "2026-11-12T07:46:08Z",
  latest_event: {
    seq: 12,
    run_id: FLEET,
    worker_id: WORKER,
    task_id: "answer",
    timestamp: "2026-11-12T07:46:08Z",
    label: "completed exit_code=0 P15-OK",
    payload: { state: "completed", exit_code: 0, summary: "P15-OK" },
  },
  artifacts: [{ kind: "log", path: ".codewhale/fleet/answer.log", size_bytes: 102 }],
  last_error: null,
  ...overrides,
});

const receiptRecord = (overrides: Json = {}): Json => ({
  run_id: FLEET,
  task_id: "answer",
  worker_id: WORKER,
  attempt: 1,
  terminal_seq: 12,
  completed_at: "2026-11-12T07:46:08Z",
  result: "partial",
  failure_kind: null,
  failure_class: null,
  retry_eligible: false,
  score: { value: 0.5, max: 1.0, notes: "no scorer configured" },
  artifacts: [{ kind: "log", path: ".codewhale/fleet/answer.log", size_bytes: 102 }],
  saved_session_id: "session-1",
  evidence_available: true,
  ...overrides,
});

async function makeAdapter(
  handler?: (
    method: string,
    path: string,
    body: unknown,
  ) => ReturnType<typeof jsonResponse> | Promise<ReturnType<typeof jsonResponse>>,
) {
  const info = await fixture<Json>("runtime-info.json");
  const transport = new FixtureTransport(
    async (method, path, body) => {
      if (method === "GET" && path === "/v1/runtime/info") return jsonResponse(200, info);
      if (handler) return handler(method, path, body);
      return jsonResponse(404, { error: "fixture route missing" });
    },
    () => (async function* () {})(),
  );
  const adapter = new CodewhaleAdapter({
    transport,
    store: new MemorySubmissionStore(),
    now: () => new Date("2026-11-12T00:00:00.000Z"),
  });
  return { adapter, transport };
}

describe("P15 agent-run routes", () => {
  it("lists real identities and keeps unknown sub-agent usage unknown", async () => {
    const { adapter } = await makeAdapter((method, path) => {
      if (method === "GET" && path === "/v1/agent-runs") {
        return jsonResponse(200, {
          runs: [agentRecord()],
          governor: { launch_slots: 2, max_launch_slots: 2, paused: false, recent_rate_limits: 0 },
        });
      }
      return jsonResponse(404, { error: "missing" });
    });
    const list = await adapter.listAgentRuns();
    expect(list.runs).toHaveLength(1);
    const run = list.runs[0]!;
    expect(run.runId).toBe(RUN);
    expect(run.workerId).toBe(RUN);
    expect(run.parentRunId).toBeNull();
    expect(run.actorKind).toBe("subagent");
    expect(run.usage.status).toBe("unknown");
    expect(run.usage.inputTokens).toBeNull();
    expect(run.events[1]?.tool).toBe("read_file");
    expect(list.governor?.launchSlots).toBe(2);
  });

  it("reads one run and maps a missing id to OPERATION_ABSENT", async () => {
    const { adapter } = await makeAdapter((method, path) => {
      if (method === "GET" && path === `/v1/agent-runs/${RUN}`)
        return jsonResponse(200, agentRecord());
      return jsonResponse(404, { error: "missing" });
    });
    const run = await adapter.readAgentRun(RUN);
    expect(run.status).toBe("running");
    await expect(adapter.readAgentRun("agent_missing")).rejects.toMatchObject({
      code: "OPERATION_ABSENT",
    });
  });

  it("accepts a 202 cancellation without claiming a terminal receipt", async () => {
    const { adapter, transport } = await makeAdapter((method, path) => {
      if (method === "POST" && path === `/v1/agent-runs/${RUN}/cancel`) {
        return jsonResponse(202, { status: "stopping" });
      }
      return jsonResponse(404, { error: "missing" });
    });
    const receipt = await adapter.cancelAgentRun(RUN);
    expect(receipt.accepted).toBe(true);
    expect(receipt.status).toBe(202);
    expect(receipt.message).toContain("terminal receipt");
    expect(transport.calls[0]?.method).toBe("POST");
  });

  it("refuses an unknown cancellation target", async () => {
    const { adapter } = await makeAdapter(() => jsonResponse(404, { error: "no such run" }));
    await expect(adapter.cancelAgentRun("agent_missing")).rejects.toBeInstanceOf(AdapterError);
  });
});

describe("P15 goal routes", () => {
  it("reads, sets, blocks, completes, and clears a goal without inventing a pause", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const { adapter } = await makeAdapter((method, path, body) => {
      calls.push({ method, path, body });
      if (method === "GET" && path === `/v1/threads/${THREAD}/goal`)
        return jsonResponse(200, goalRecord());
      if (method === "PUT" && path === `/v1/threads/${THREAD}/goal`)
        return jsonResponse(201, goalRecord({ status: "active" }));
      if (method === "POST" && path.endsWith("/goal/block"))
        return jsonResponse(200, goalRecord({ status: "blocked" }));
      if (method === "POST" && path.endsWith("/goal/complete"))
        return jsonResponse(200, goalRecord({ status: "complete" }));
      if (method === "DELETE" && path === `/v1/threads/${THREAD}/goal`)
        return jsonResponse(204, null);
      if (method === "GET" && path.startsWith("/v1/goals"))
        return jsonResponse(200, { goals: [goalRecord()] });
      return jsonResponse(404, { error: "missing" });
    });
    expect((await adapter.listGoals()).map((goal) => goal.goalId)).toEqual(["goal-1"]);
    expect((await adapter.readThreadGoal(THREAD))?.objective).toBe("Finish the migration");
    const set = await adapter.setThreadGoal(THREAD, "  New objective  ");
    expect(set.goal.status).toBe("active");
    // The adapter reports the status the route answered (201), not a guess.
    expect(set.status).toBe(201);
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      objective: "New objective",
    });
    expect((await adapter.blockThreadGoal(THREAD)).goal.status).toBe("blocked");
    expect((await adapter.completeThreadGoal(THREAD)).goal.status).toBe("complete");
    expect(await adapter.clearThreadGoal(THREAD)).toEqual({ cleared: true, status: 204 });
  });

  it("returns null for a thread with no goal", async () => {
    const { adapter } = await makeAdapter(() => jsonResponse(404, { error: "no goal" }));
    await expect(adapter.readThreadGoal(THREAD)).resolves.toBeNull();
  });
});

describe("P15 fleet routes", () => {
  function fleetHandler(overrides: Json = {}): Parameters<typeof makeAdapter>[0] {
    return (method, path, body) => {
      if (method === "GET" && path === "/v1/fleet/runs") {
        return jsonResponse(200, {
          status: { runs: 1, completed: 1 },
          runs: [fleetRecord(overrides.run)],
        });
      }
      if (method === "POST" && path === "/v1/fleet/runs") {
        return jsonResponse(201, {
          execution: "awaiting_start",
          run: fleetRecord({ lifecycle_status: "queued", ...overrides.run }),
          warnings: [],
        });
      }
      if (method === "GET" && path === `/v1/fleet/runs/${FLEET}`)
        return jsonResponse(200, fleetRecord(overrides.run));
      if (method === "GET" && path.endsWith("/workers"))
        return jsonResponse(200, { run_id: FLEET, workers: [workerRecord()] });
      if (method === "GET" && path.endsWith("/receipts"))
        return jsonResponse(200, { run_id: FLEET, receipts: [receiptRecord()] });
      if (method === "GET" && path.endsWith("/events/replay"))
        return jsonResponse(200, {
          run_id: FLEET,
          events: [
            {
              cursor: "fev1_x",
              event: "fleet.run.status_changed",
              run_id: FLEET,
              timestamp: "2026-11-12T07:46:06Z",
              payload: { status: "running" },
            },
          ],
        });
      if (method === "POST" && path.endsWith("/start"))
        return jsonResponse(202, { action: "start", execution: "scheduled", run_id: FLEET });
      if (method === "POST" && path.endsWith("/stop"))
        return jsonResponse(200, { action: "stop", run_id: FLEET, stopped: 1 });
      if (method === "POST" && path.includes("/workers/") && path.endsWith("/restart"))
        return jsonResponse(200, workerRecord());
      if (method === "POST" && path.includes("/workers/") && path.endsWith("/stop"))
        return jsonResponse(200, workerRecord({ status: "offline" }));
      if (method === "GET" && path.endsWith("/evidence"))
        return jsonResponse(200, {
          path: ".codewhale/fleet/verification.json",
          checksum: "sha256:abc",
          size_bytes: 12,
          truncated: false,
          content: { result: "partial" },
        });
      if (method === "GET" && path.endsWith("/receipts/answer"))
        return jsonResponse(200, receiptRecord());
      return jsonResponse(404, { error: "missing", body });
    };
  }

  it("reads a run with workers, receipts, and bounded event history", async () => {
    const { adapter } = await makeAdapter(fleetHandler());
    const list = await adapter.listFleetRuns();
    expect(list.runs[0]?.runId).toBe(FLEET);
    expect(list.runs[0]?.tasks[0]?.role).toBe("reviewer");
    const detail = await adapter.readFleetRun(FLEET);
    expect(detail.workers[0]?.lastEvent?.message ?? "").toContain("P15-OK");
    expect(detail.receipts[0]?.result).toBe("partial");
    expect(detail.events[0]?.event).toBe("fleet.run.status_changed");
  });

  it("creates, starts, stops, and controls a worker with engine receipts", async () => {
    const { adapter, transport } = await makeAdapter(fleetHandler());
    const created = await adapter.createFleetRun({
      target: "this_computer",
      name: "Serial task",
      roles: [{ name: "worker" }],
      workflow: {
        id: "mona-serial",
        kind: "parallel",
        tasks: [
          {
            id: "task",
            name: "Do it",
            instructions: "Do the bounded thing.",
            worker: { role: "worker" },
          },
        ],
      },
    });
    expect(created.run.runId).toBe(FLEET);
    const start = await adapter.startFleetRun(FLEET);
    expect(start.status).toBe(202);
    expect(start.accepted).toBe(true);
    expect((await adapter.stopFleetRun(FLEET)).accepted).toBe(true);
    expect((await adapter.stopFleetWorker(WORKER)).accepted).toBe(true);
    expect((await adapter.restartFleetWorker(WORKER)).accepted).toBe(true);
    expect(transport.calls.some((call) => call.path.endsWith("/start"))).toBe(true);
  });

  it("surfaces a refused fleet creation instead of pretending it ran", async () => {
    const { adapter } = await makeAdapter(() =>
      jsonResponse(422, "workflow.tasks[0].workspace: invalid type"),
    );
    await expect(
      adapter.createFleetRun({
        target: "this_computer",
        name: "Bad",
        roles: [{ name: "worker" }],
        workflow: {
          id: "bad",
          kind: "parallel",
          tasks: [{ id: "t", name: "T", instructions: "x", worker: { role: "worker" } }],
        },
      }),
    ).rejects.toMatchObject({ code: "CONTROL_REFUSED" });
  });

  it("reads a receipt and its bounded evidence", async () => {
    const { adapter } = await makeAdapter(fleetHandler());
    expect((await adapter.readFleetReceipt(FLEET, "answer")).result).toBe("partial");
    const evidence = await adapter.readFleetReceiptEvidence(FLEET, "answer");
    expect(evidence.truncated).toBe(false);
    expect(evidence.content).toEqual({ result: "partial" });
  });
});
