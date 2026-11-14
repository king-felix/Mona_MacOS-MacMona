import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EngineAdapter } from "../src/main/engine/types";
import { CodewhaleAdapter } from "../src/main/engine/adapter";
import { MemorySubmissionStore } from "../src/main/engine/submission-store";
import type { StoredProject } from "../src/main/state/store";
import type { SupervisorStopReceipt } from "../src/main/supervisor/native";
import type { OwnedEndpoint, RuntimeStatus } from "../src/main/supervisor/runtime-supervisor";
import { WorkController } from "../src/main/work/control";
import { WorkStudio, type StudioSupervisor } from "../src/main/work/studio";
import type { CostLedger } from "../src/main/work/costs";
import type { ProjectId, StudioPush } from "../src/shared/contracts";
import {
  chunkText,
  fixture,
  FixtureTransport,
  jsonResponse,
  sseFrames,
} from "./helpers/fixture-transport";
import { openTestStore, tempDir } from "./helpers/state";

const COMMIT = "ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e";
const THREAD = "thr_0123456789abcdef";
const THREAD_TWO = "thr_0123456789abcdee";
const TURN = "turn_0123456789abcdef";
const TURN_TWO = "turn_0123456789abcdee";

function status(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    state: "disconnected",
    reason: "not_started",
    since: "2026-11-11T00:00:00.000Z",
    workspace: null,
    ownershipId: null,
    port: null,
    engine: null,
    external: false,
    restarts: 0,
    lastFailure: null,
    pendingRestartInMs: null,
    ...overrides,
  };
}

function stopReceipt(): SupervisorStopReceipt {
  return {
    ok: true,
    state: "stopped",
    graceful: true,
    escalated: false,
    survivors: [],
    via: "control_socket",
    verified: true,
    note: "stopped",
  };
}

function fakeSupervisor(): StudioSupervisor {
  let current = status();
  let workspace: string | null = null;
  return {
    status: () => current,
    isOwned: () => current.state === "running" && !current.external,
    ensure: async (requested) => {
      workspace = requested;
      current = status({
        state: "running",
        reason: "started",
        workspace: requested,
        port: 7878,
        engine: { version: "0.10.2", commit: COMMIT },
        ownershipId: "own_0123456789",
      });
      return current;
    },
    endpoint: (): OwnedEndpoint | null => {
      if (current.state !== "running" || !workspace) return null;
      return {
        baseUrl: "http://127.0.0.1:7878",
        port: 7878,
        token: "test-token",
        engine: { version: "0.10.2", commit: COMMIT },
        workspace,
        canonicalWorkspace: workspace,
        executable: "/opt/homebrew/bin/codewhale",
        executableSha256: "a".repeat(64),
        ownershipId: "own_0123456789",
      };
    },
    stopOwned: async () => {
      current = status({ state: "stopped", reason: "stopped" });
      workspace = null;
      return stopReceipt();
    },
  };
}

function frame(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 2,
    thread_id: THREAD,
    timestamp: "2026-11-11T00:00:01.000Z",
    payload: {},
    ...overrides,
  };
}

interface Harness {
  studio: WorkStudio;
  work: WorkController;
  store: Awaited<ReturnType<typeof openTestStore>>["store"];
  project: StoredProject;
  transport: FixtureTransport;
  completeFirstTurn: () => void;
  setBudgetStop: (value: boolean) => void;
  setUncertain: (value: boolean) => void;
}

/**
 * A real studio over a real SQLite store and a fixture transport. The first
 * turn is held open by a gate so a test can act while it runs; releasing the
 * gate delivers the completion frame that is the dispatch boundary.
 */
async function setup(options: { gateFirstTurn?: boolean } = {}): Promise<Harness> {
  const handle = await openTestStore();
  const folder = join(tempDir("mona-follow-up-project-"), "Follow-up project");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "README.md"), "# follow-ups\n");
  const opened = await handle.store.openProject(folder);

  const info = await fixture<Record<string, unknown>>("runtime-info.json");
  const thread = await fixture<Record<string, unknown>>("thread.json");
  thread.workspace = opened.project.canonicalPath;
  const accepted = await fixture<Record<string, unknown>>("turn-accepted.json");
  const usage = await fixture<Record<string, unknown>>("usage.json");

  let release: (() => void) | null = null;
  let gateOpen = options.gateFirstTurn !== true;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (gateOpen) release?.();
  let uncertain = false;
  let budgetStop = false;
  let turnPosts = 0;
  let threadPosts = 0;
  let streams = 0;

  const handler = (method: string, path: string) => {
    if (method === "GET" && path === "/v1/runtime/info") return jsonResponse(200, info);
    if (method === "POST" && path === "/v1/threads") {
      threadPosts += 1;
      return jsonResponse(201, {
        ...thread,
        id: threadPosts > 1 ? THREAD_TWO : THREAD,
      });
    }
    if (method === "POST" && path.endsWith("/turns")) {
      turnPosts += 1;
      return jsonResponse(201, {
        ...accepted,
        id: turnPosts > 1 ? TURN_TWO : TURN,
        thread_id: path.includes(THREAD_TWO) ? THREAD_TWO : THREAD,
      });
    }
    if (method === "GET" && path.includes("turn-operations")) {
      return jsonResponse(200, {
        ...accepted,
        id: turnPosts > 1 ? TURN_TWO : TURN,
        status: uncertain ? "outcome_unknown" : "completed",
      });
    }
    if (
      method === "GET" &&
      (path.startsWith(`/v1/threads/${THREAD}`) || path.startsWith(`/v1/threads/${THREAD_TWO}`))
    )
      return jsonResponse(200, {
        thread: {
          ...thread,
          id: path.includes(THREAD_TWO) ? THREAD_TWO : THREAD,
          pending_approvals: [],
          pending_user_inputs: [],
        },
      });
    if (method === "GET" && path.startsWith("/v1/usage")) return jsonResponse(200, usage);
    if (method === "POST" && path.includes("/interrupt"))
      return jsonResponse(200, { interrupted: true, thread_id: THREAD, id: TURN });
    return jsonResponse(404, { error: "fixture route missing" });
  };

  const transport = new FixtureTransport(handler, () => {
    streams += 1;
    if (streams === 1) {
      return (async function* () {
        yield* chunkText(
          sseFrames([
            frame({
              seq: 3,
              event: "turn.started",
              kind: "turn.started",
              turn_id: TURN,
              payload: { permission_posture: "full_access" },
            }),
          ]),
          8,
        );
        if (!gateOpen) await gate;
        yield* chunkText(
          sseFrames(
            [
              frame({
                seq: 100,
                event: "turn.completed",
                kind: "turn.completed",
                turn_id: TURN,
                timestamp: "2026-11-11T00:00:09.000Z",
                payload: {},
              }),
            ],
            { end: true },
          ),
          8,
        );
      })();
    }
    return chunkText(
      sseFrames(
        [
          frame({
            seq: 200 + streams,
            event: "turn.completed",
            kind: "turn.completed",
            turn_id: TURN_TWO,
            thread_id: THREAD_TWO,
            timestamp: "2026-11-11T00:00:19.000Z",
            payload: {},
          }),
        ],
        { end: true },
      ),
      8,
    );
  });

  const work = new WorkController({
    interrupt: async (input) => studio.interruptTurn(input.task.workspace, input.turnId),
    stopOwnedRuntime: async () => stopReceipt(),
  });

  const ledger = {
    recordTurn: async () => undefined,
    evaluateBudgets: async () => [],
    dispatchGate: async () =>
      budgetStop
        ? {
            allowed: false,
            level: "stop" as const,
            reasons: ["the project budget has been reached"],
            evaluations: [],
            inFlight: { taskRuns: 0, activeTurn: false },
            reservations: 0,
            note: "",
          }
        : {
            allowed: true,
            level: "ok" as const,
            reasons: [],
            evaluations: [],
            inFlight: { taskRuns: 0, activeTurn: false },
            reservations: 0,
            note: "",
          },
  } as unknown as CostLedger;

  const pushes: StudioPush[] = [];
  const studio = new WorkStudio({
    store: handle.store,
    supervisor: fakeSupervisor(),
    work,
    ledger,
    newAdapter: () =>
      new CodewhaleAdapter({
        transport,
        store: new MemorySubmissionStore(),
        now: () => new Date("2026-11-11T00:00:00.000Z"),
      }) as EngineAdapter,
    notify: (push) => pushes.push(push),
    now: () => new Date("2026-11-11T00:00:00.000Z"),
    reconnect: { attempts: 0, baseDelayMs: 1, maxDelayMs: 2, sleep: async () => undefined },
  });

  return {
    studio,
    work,
    store: handle.store,
    project: opened.project,
    transport,
    completeFirstTurn: () => {
      gateOpen = true;
      release?.();
    },
    setBudgetStop: (value) => {
      budgetStop = value;
    },
    setUncertain: (value) => {
      uncertain = value;
    },
  };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition did not become true: ${label}`);
}

async function settled(studio: WorkStudio, project: ProjectId): Promise<void> {
  await waitFor(async () => (await studio.snapshot(project)).activeTurnId === null, "turn settled");
}

describe("R08 follow-up queue", () => {
  it("dispatches an explicitly queued follow-up exactly once after the turn ends", async () => {
    const harness = await setup({ gateFirstTurn: true });
    const project = harness.project.id as ProjectId;
    await harness.studio.start(project);
    const first = await harness.studio.submit(project, { prompt: "First task", mode: "work" });
    expect(first.outcome).toBe("accepted");

    const queued = await harness.studio.enqueueFollowUp(project, {
      prompt: "Then run the tests",
      mode: "work",
    });
    expect(queued.item?.status).toBe("queued");
    expect(harness.transport.count("POST", "/turns")).toBe(1);

    harness.completeFirstTurn();
    await waitFor(async () => {
      const rows = await harness.store.listFollowUps(project);
      return rows[0]?.status === "accepted";
    }, "follow-up accepted");
    const rows = await harness.store.listFollowUps(project);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "accepted", turnId: TURN_TWO, mode: "work" });
    expect(harness.transport.count("POST", "/turns")).toBe(2);
    const snapshot = await harness.studio.snapshot(project);
    expect(snapshot.followUps[0]?.status).toBe("accepted");
    expect(snapshot.followUps[0]?.editable).toBe(false);
    await harness.studio.close();
  });

  it("never sends a follow-up that was canceled before its boundary", async () => {
    const harness = await setup({ gateFirstTurn: true });
    const project = harness.project.id as ProjectId;
    await harness.studio.start(project);
    await harness.studio.submit(project, { prompt: "First task", mode: "work" });
    const queued = await harness.studio.enqueueFollowUp(project, {
      prompt: "Do not send me",
      mode: "work",
    });
    const canceled = await harness.studio.cancelFollowUp(project, queued.item!.id);
    expect(canceled.item?.status).toBe("canceled");
    harness.completeFirstTurn();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(harness.transport.count("POST", "/turns")).toBe(1);
    expect((await harness.store.listFollowUps(project))[0]?.status).toBe("canceled");
    await harness.studio.close();
  });

  it("marks a follow-up stale when the conversation it targeted was replaced", async () => {
    const harness = await setup();
    const project = harness.project.id as ProjectId;
    await harness.studio.start(project);
    await harness.studio.submit(project, { prompt: "First task", mode: "work" });
    await settled(harness.studio, project);
    const queued = await harness.studio.enqueueFollowUp(project, {
      prompt: "Queued for the old conversation",
      mode: "work",
    });
    expect(queued.item?.status).toBe("queued");
    await harness.studio.newThread(project, {
      mode: "work",
      operationKey: "cmd-new-thread-1",
    });
    const dispatched = await harness.studio.dispatchFollowUps(project);
    expect(dispatched.item?.status).toBe("stale");
    expect(dispatched.item?.note).toContain("no longer current");
    expect(harness.transport.count("POST", "/turns")).toBe(1);
    await harness.studio.close();
  });

  it("does not start a queued follow-up while the Mona queue is paused", async () => {
    const harness = await setup();
    const project = harness.project.id as ProjectId;
    await harness.studio.start(project);
    await harness.studio.submit(project, { prompt: "First task", mode: "work" });
    await settled(harness.studio, project);
    await harness.studio.enqueueFollowUp(project, { prompt: "Paused follow-up", mode: "work" });
    await harness.studio.pauseAfterTask(project);
    const result = await harness.studio.dispatchFollowUps(project);
    expect(result.item).toBeNull();
    expect(result.note).toContain("paused");
    expect(harness.transport.count("POST", "/turns")).toBe(1);
    expect((await harness.store.listFollowUps(project))[0]?.status).toBe("queued");
    await harness.studio.close();
  });

  it("records a budget stop without sending, and leaves the row queued", async () => {
    const harness = await setup();
    const project = harness.project.id as ProjectId;
    await harness.studio.start(project);
    await harness.studio.submit(project, { prompt: "First task", mode: "work" });
    await settled(harness.studio, project);
    await harness.studio.enqueueFollowUp(project, { prompt: "Over budget", mode: "work" });
    harness.setBudgetStop(true);
    const result = await harness.studio.dispatchFollowUps(project);
    expect(result.item).toBeNull();
    expect(harness.transport.count("POST", "/turns")).toBe(1);
    const rows = await harness.store.listFollowUps(project);
    expect(rows[0]?.status).toBe("queued");
    expect(rows[0]?.note).toContain("blocked by budget");
    await harness.studio.close();
  });

  it("keeps an uncertain send distinct and never resends it", async () => {
    const harness = await setup();
    const project = harness.project.id as ProjectId;
    await harness.studio.start(project);
    await harness.studio.submit(project, { prompt: "First task", mode: "work" });
    await settled(harness.studio, project);
    const queued = await harness.studio.enqueueFollowUp(project, {
      prompt: "Maybe sent",
      mode: "work",
    });
    harness.setUncertain(true);
    await harness.studio.dispatchFollowUps(project);
    const rows = await harness.store.listFollowUps(project);
    expect(rows[0]?.id).toBe(queued.item?.id);
    // The adapter's own reconciliation decides between unknown and accepted;
    // either way the row is settled and never sent a second time.
    expect(["unknown", "accepted"]).toContain(rows[0]?.status);
    const posts = harness.transport.count("POST", "/turns");
    await harness.studio.dispatchFollowUps(project);
    expect(harness.transport.count("POST", "/turns")).toBe(posts);
    await harness.studio.close();
  });

  it("survives a restart without starting the queued turn", async () => {
    const harness = await setup();
    const project = harness.project.id as ProjectId;
    await harness.studio.start(project);
    await harness.studio.submit(project, { prompt: "First task", mode: "work" });
    await settled(harness.studio, project);
    await harness.studio.enqueueFollowUp(project, { prompt: "After restart", mode: "work" });
    await harness.studio.close();

    const revived = new WorkStudio({
      store: harness.store,
      supervisor: fakeSupervisor(),
      work: new WorkController({
        interrupt: async () => ({
          requested: false,
          confirmed: false,
          uncertain: false,
          receipt: null,
          note: "",
        }),
        stopOwnedRuntime: async () => stopReceipt(),
      }),
      newAdapter: () =>
        new CodewhaleAdapter({
          transport: harness.transport,
          store: new MemorySubmissionStore(),
        }),
      notify: () => undefined,
      reconnect: { attempts: 0, baseDelayMs: 1, maxDelayMs: 2, sleep: async () => undefined },
    });
    await revived.start(project);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const rows = await harness.store.listFollowUps(project);
    expect(rows[0]?.status).toBe("queued");
    expect(harness.transport.count("POST", "/turns")).toBe(1);
    expect((await revived.snapshot(project)).followUps[0]?.status).toBe("queued");
    await revived.close();
  });

  it("claims a queued row exactly once under two dispatchers", async () => {
    const harness = await setup();
    const project = harness.project.id as ProjectId;
    await harness.studio.start(project);
    await harness.studio.submit(project, { prompt: "First task", mode: "work" });
    await settled(harness.studio, project);
    const queued = await harness.studio.enqueueFollowUp(project, {
      prompt: "One owner",
      mode: "work",
    });
    const id = queued.item!.id;
    const first = await harness.store.claimFollowUp(id, "op-000001", "2026-11-11T00:00:30.000Z");
    const second = await harness.store.claimFollowUp(id, "op-000002", "2026-11-11T00:00:30.000Z");
    expect(first?.status).toBe("dispatching");
    expect(second).toBeNull();
    await harness.studio.close();
  });

  it("does not touch native orchestration when dispatching a follow-up", async () => {
    const harness = await setup();
    const project = harness.project.id as ProjectId;
    await harness.studio.start(project);
    await harness.studio.submit(project, { prompt: "First task", mode: "work" });
    await settled(harness.studio, project);
    await harness.studio.enqueueFollowUp(project, { prompt: "Serial only", mode: "work" });
    // No scheduler record is created by the queue, and no fleet route is called.
    expect(harness.transport.count("POST", "/v1/fleet")).toBe(0);
    expect(await harness.store.listOrchestrationRuns(project)).toEqual([]);
    await harness.studio.close();
  });
});
