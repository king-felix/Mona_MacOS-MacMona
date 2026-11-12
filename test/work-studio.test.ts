import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EngineAdapter } from "../src/main/engine/types";
import { CodewhaleAdapter } from "../src/main/engine/adapter";
import { SqliteSubmissionStore } from "../src/main/state/submission-store";
import type { StoredProject } from "../src/main/state/store";
import type { SupervisorStopReceipt } from "../src/main/supervisor/native";
import type { OwnedEndpoint, RuntimeStatus } from "../src/main/supervisor/runtime-supervisor";
import { WorkController } from "../src/main/work/control";
import { WorkStudio, StudioError, type StudioSupervisor } from "../src/main/work/studio";
import { CostLedger } from "../src/main/work/costs";
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
const TURN = "turn_0123456789abcdef";

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

interface FakeSupervisor extends StudioSupervisor {
  setStatus(next: RuntimeStatus): void;
  ensureCalls: string[];
  stopCalls: number;
}

function fakeSupervisor(startState: Partial<RuntimeStatus> = {}): FakeSupervisor {
  let current = status(startState);
  let workspace: string | null = current.workspace ?? null;
  const ensureCalls: string[] = [];
  const fake: FakeSupervisor = {
    ensureCalls,
    stopCalls: 0,
    setStatus: (next) => {
      current = next;
      workspace = next.workspace;
    },
    status: () => current,
    isOwned: () => current.state === "running" && !current.external,
    ensure: async (requested) => {
      ensureCalls.push(requested);
      if (current.state === "running" && !current.external && workspace !== requested) {
        throw Object.assign(new Error(`an owned runtime is already running for ${workspace}`), {
          code: "ALREADY_OWNED",
        });
      }
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
      if (current.state !== "running" || current.external || !workspace) return null;
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
      fake.stopCalls += 1;
      current = status({ state: "stopped", reason: "stopped" });
      workspace = null;
      return stopReceipt();
    },
  };
  return fake;
}

interface Harness {
  studio: WorkStudio;
  store: Awaited<ReturnType<typeof openTestStore>>["store"];
  project: StoredProject;
  transport: FixtureTransport;
  supervisor: FakeSupervisor;
  pushes: StudioPush[];
}

async function setup(
  options: {
    events?: unknown[];
    handler?: (
      method: string,
      path: string,
      body: unknown,
    ) => ReturnType<typeof jsonResponse> | Promise<ReturnType<typeof jsonResponse>>;
    stream?: (path: string) => AsyncIterable<string>;
    adapter?: (transport: FixtureTransport) => EngineAdapter;
    now?: () => Date;
  } = {},
): Promise<Harness> {
  const handle = await openTestStore();
  const folder = join(tempDir("mona-studio-project-"), "Studio project");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "README.md"), "# studio\n");
  const opened = await handle.store.openProject(folder);

  const info = await fixture<Record<string, unknown>>("runtime-info.json");
  const thread = await fixture<Record<string, unknown>>("thread.json");
  const accepted = await fixture<Record<string, unknown>>("turn-accepted.json");
  const usage = await fixture<Record<string, unknown>>("usage.json");
  const events = options.events ?? (await fixture<unknown[]>("events.json"));
  const handler =
    options.handler ??
    ((method: string, path: string) => {
      if (method === "GET" && path === "/v1/runtime/info") return jsonResponse(200, info);
      if (method === "POST" && path === "/v1/threads") return jsonResponse(201, thread);
      if (method === "POST" && path.endsWith("/turns")) return jsonResponse(201, accepted);
      if (method === "POST" && path.includes("/interrupt"))
        return jsonResponse(200, { interrupted: true, thread_id: THREAD, id: TURN });
      if (method === "GET" && path.includes("turn-operations"))
        return jsonResponse(200, { ...accepted, status: "completed" });
      if (method === "GET" && path.startsWith("/v1/threads/")) return jsonResponse(200, thread);
      if (method === "GET" && path.startsWith("/v1/usage")) return jsonResponse(200, usage);
      return jsonResponse(404, { error: "fixture route missing" });
    });
  const transport = new FixtureTransport(
    handler,
    options.stream ?? (() => chunkText(sseFrames(events, { end: true }), 5)),
  );
  const supervisor = fakeSupervisor();
  const pushes: StudioPush[] = [];
  const studio = new WorkStudio({
    store: handle.store,
    supervisor,
    work: new WorkController({
      interrupt: async (input) => studio.interruptTurn(input.task.workspace, input.turnId),
      stopOwnedRuntime: async () => stopReceipt(),
    }),
    newAdapter:
      options.adapter ??
      (() =>
        new CodewhaleAdapter({
          transport,
          store: new SqliteSubmissionStore(handle.store, opened.project.id),
          now: () => new Date("2026-11-11T00:00:00.000Z"),
        })),
    notify: (push) => pushes.push(push),
    now: options.now ?? (() => new Date("2026-11-11T00:00:00.000Z")),
    reconnect: { attempts: 2, baseDelayMs: 5, maxDelayMs: 10, sleep: async () => undefined },
  });
  return {
    studio,
    store: handle.store,
    project: opened.project,
    transport,
    supervisor,
    pushes,
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition did not become true");
}

describe("live studio: start and submission", () => {
  it("starts the owned runtime, binds the project, and makes no model call", async () => {
    const harness = await setup();
    const snapshot = await harness.studio.start(harness.project.id as ProjectId);
    expect(snapshot.connection.state).toBe("connected");
    expect(snapshot.connection.engine).toEqual({ version: "0.10.2", commit: COMMIT });
    expect(snapshot.profile.provider).toBe("deepseek");
    expect(snapshot.profile.model).toBe("deepseek-flash");
    expect(snapshot.profile.permissionPosture).toBe("full_access");
    expect(snapshot.canSubmit).toBe(true);
    expect(harness.supervisor.ensureCalls).toEqual([harness.project.canonicalPath]);
    const binding = await harness.store.getRuntimeBinding(harness.project.id as ProjectId);
    expect(binding?.state).toBe("running");
    expect(harness.transport.count("POST", "/v1/threads")).toBe(0);
    expect(harness.transport.count("POST", "/turns")).toBe(0);
  });

  it("persists intent, streams events, records usage, and reaches a real terminal state", async () => {
    const harness = await setup();
    await harness.studio.start(harness.project.id as ProjectId);
    const result = await harness.studio.submit(harness.project.id as ProjectId, {
      prompt: "Reply with exactly: pong",
      mode: "work",
    });
    expect(result.outcome).toBe("accepted");
    expect(result.turnId).toBe(TURN);
    expect(harness.transport.count("POST", "/turns")).toBe(1);

    await waitFor(async () =>
      (await harness.store.readProjectEvents(harness.project.id as ProjectId)).some(
        (event) => event.kind === "turn.completed",
      ),
    );
    const events = await harness.store.readProjectEvents(harness.project.id as ProjectId);
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("thread.started");
    expect(kinds).toContain("turn.started");
    expect(kinds).toContain("item.completed");
    expect(kinds).toContain("turn.completed");
    expect(new Set(events.map((event) => `${event.threadId}:${event.seq}`)).size).toBe(
      events.length,
    );

    const submission = await harness.store.getSubmission(result.operationKey);
    expect(submission?.status).toBe("completed");
    expect(submission?.reconciled).toBe(true);

    const usage = await harness.store.summarizeUsage(harness.project.id as ProjectId);
    expect(usage.turns).toBe(1);
    expect(usage.costComplete).toBe(true);
    expect(usage.costUsd).toBeCloseTo(0.00042);

    const snapshot = await harness.studio.snapshot(harness.project.id as ProjectId);
    expect(snapshot.connection.state).toBe("connected");
    expect(snapshot.activeTurnId).toBeNull();
    expect(snapshot.profile.effective?.model).toBe("deepseek-flash");
    expect(snapshot.profile.effective?.permissionPosture).toBe("full_access");
    expect(snapshot.cost.label).toContain("$0.0004");
  });

  it("deduplicates a full replay without duplicating events or advancing past the truth", async () => {
    const harness = await setup();
    await harness.studio.start(harness.project.id as ProjectId);
    await harness.studio.submit(harness.project.id as ProjectId, {
      prompt: "Reply with exactly: pong",
      mode: "work",
    });
    await waitFor(async () =>
      (await harness.store.readProjectEvents(harness.project.id as ProjectId)).some(
        (event) => event.kind === "turn.completed",
      ),
    );
    const before = await harness.store.readProjectEvents(harness.project.id as ProjectId);
    const first = await harness.studio.replay(harness.project.id as ProjectId);
    const afterFirst = await harness.store.readProjectEvents(harness.project.id as ProjectId);
    expect(first.duplicates).toBeGreaterThan(0);
    expect(afterFirst.length).toBeGreaterThanOrEqual(before.length);
    const second = await harness.studio.replay(harness.project.id as ProjectId);
    const afterSecond = await harness.store.readProjectEvents(harness.project.id as ProjectId);
    expect(second.ingested).toBe(0);
    expect(afterSecond.length).toBe(afterFirst.length);
    expect(second.cursor).toBe(first.cursor);
  });

  it("reconciles a lost response with one read-only lookup and never resubmits", async () => {
    const harness = await setup({
      handler: (method, path) => {
        if (method === "GET" && path === "/v1/runtime/info")
          return jsonResponse(200, {
            service: "codewhale-runtime-api",
            runtime_api_version: "1.0",
            codewhale_version: "0.10.2",
            codewhale_commit: COMMIT,
            bind_host: "127.0.0.1",
            port: 7878,
            auth_required: true,
            transports: ["http", "sse"],
            capabilities: {
              threads: true,
              turns: true,
              turn_operation_idempotency: true,
              turn_operation_lookup: true,
              thread_create_idempotency: true,
              event_replay: true,
              turn_interrupt: true,
            },
          });
        if (method === "POST" && path === "/v1/threads")
          return jsonResponse(201, {
            id: THREAD,
            thread_id: THREAD,
            workspace: harnessPlaceholder,
            created_at: "2026-11-11T00:00:00.000Z",
          });
        if (method === "POST" && path.endsWith("/turns"))
          throw new Error("socket reset after the write");
        if (method === "GET" && path.includes("turn-operations"))
          return jsonResponse(200, {
            id: TURN,
            thread_id: THREAD,
            status: "completed",
            effective_provider: "deepseek",
            effective_model: "deepseek-flash",
            permission_posture: "full_access",
          });
        if (method === "GET" && path.startsWith("/v1/threads/"))
          return jsonResponse(200, {
            id: THREAD,
            workspace: harnessPlaceholder,
            turns: [
              {
                id: TURN,
                thread_id: THREAD,
                status: "completed",
                effective_provider: "deepseek",
                effective_model: "deepseek-flash",
                permission_posture: "full_access",
                usage: {
                  input_tokens: 5,
                  output_tokens: 1,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 5,
                },
              },
            ],
          });
        if (method === "GET" && path.startsWith("/v1/usage"))
          return jsonResponse(200, {
            totals: { cost_complete: true, turns: 1, cost_usd: 0.0001 },
            buckets: [{ key: THREAD, cost_usd: 0.0001, cost_complete: true }],
          });
        return jsonResponse(404, {});
      },
    });
    // The fixture thread create handler is declared before the workspace is known;
    // the adapter only checks the thread id and workspace fallback.
    await harness.studio.start(harness.project.id as ProjectId);
    const result = await harness.studio.submit(harness.project.id as ProjectId, {
      prompt: "Run the test",
      mode: "work",
    });
    expect(result.outcome).toBe("accepted");
    expect(result.reconciliation?.evidence).toBe("lookup");
    expect(
      harness.transport.calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("/turns"),
      ),
    ).toHaveLength(1);
    expect(harness.transport.count("GET", "turn-operations")).toBe(1);
  });

  it("refuses a second mutating turn in the same workspace", async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events = await fixture<unknown[]>("events.json");
    const harness = await setup({
      stream: () =>
        (async function* () {
          yield sseFrames(
            events.filter((event) => (event as { kind?: string }).kind === "turn.started"),
          );
          await held;
        })(),
    });
    await harness.studio.start(harness.project.id as ProjectId);
    const first = await harness.studio.submit(harness.project.id as ProjectId, {
      prompt: "Hold the turn",
      mode: "work",
    });
    expect(first.outcome).toBe("accepted");
    await expect(
      harness.studio.submit(harness.project.id as ProjectId, {
        prompt: "Second turn",
        mode: "work",
      }),
    ).rejects.toMatchObject({ code: "TURN_ACTIVE" });
    expect(harness.transport.count("POST", "/turns")).toBe(1);
    release();
    await harness.studio.stop(harness.project.id as ProjectId);
  });

  it("keeps a second project from claiming the single owned runtime", async () => {
    const harness = await setup();
    await harness.studio.start(harness.project.id as ProjectId);
    const otherFolder = join(tempDir("mona-studio-other-"), "Other project");
    mkdirSync(otherFolder, { recursive: true });
    const other = await harness.store.openProject(otherFolder);
    await expect(harness.studio.start(other.project.id as ProjectId)).rejects.toMatchObject({
      code: "STUDIO_BUSY",
    });
    expect(harness.studio.activeProjectId()).toBe(harness.project.id);
    expect(harness.supervisor.ensureCalls).toHaveLength(1);
    expect(harness.transport.count("POST", "/turns")).toBe(0);
  });
});

describe("live studio: honest failure and offline states", () => {
  it("reports an unreachable runtime as failed instead of connected", async () => {
    const harness = await setup();
    harness.supervisor.ensure = async () => {
      throw Object.assign(new Error("spawn refused"), { code: "RUNTIME_UNAVAILABLE" });
    };
    const snapshot = await harness.studio.start(harness.project.id as ProjectId);
    expect(snapshot.connection.state).toBe("failed");
    expect(snapshot.connection.reason).toContain("spawn refused");
    expect(snapshot.canSubmit).toBe(false);
    await expect(
      harness.studio.submit(harness.project.id as ProjectId, { prompt: "x", mode: "work" }),
    ).rejects.toBeInstanceOf(StudioError);
    expect(harness.transport.count("POST", "/turns")).toBe(0);
  });

  it("marks an unreported price as unknown, never zero", async () => {
    const harness = await setup({
      handler: (method, path) => {
        if (method === "GET" && path === "/v1/runtime/info")
          return jsonResponse(200, {
            service: "codewhale-runtime-api",
            runtime_api_version: "1.0",
            codewhale_version: "0.10.2",
            codewhale_commit: COMMIT,
            bind_host: "127.0.0.1",
            port: 7878,
            auth_required: true,
            transports: ["http", "sse"],
            capabilities: {
              threads: true,
              turns: true,
              turn_operation_idempotency: true,
              turn_operation_lookup: true,
              thread_create_idempotency: true,
              event_replay: true,
              turn_interrupt: true,
            },
          });
        if (method === "POST" && path === "/v1/threads")
          return jsonResponse(201, { id: THREAD, thread_id: THREAD });
        if (method === "POST" && path.endsWith("/turns"))
          return jsonResponse(201, {
            id: TURN,
            thread_id: THREAD,
            status: "in_progress",
            effective_provider: "deepseek",
            effective_model: "deepseek-flash",
            permission_posture: "full_access",
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              prompt_cache_hit_tokens: 0,
              prompt_cache_miss_tokens: 10,
            },
          });
        if (method === "GET" && path.startsWith("/v1/threads/"))
          return jsonResponse(200, {
            id: THREAD,
            turns: [
              {
                id: TURN,
                thread_id: THREAD,
                status: "completed",
                effective_provider: "deepseek",
                effective_model: "deepseek-flash",
                permission_posture: "full_access",
                usage: {
                  input_tokens: 10,
                  output_tokens: 2,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 10,
                },
              },
            ],
          });
        if (method === "GET" && path.startsWith("/v1/usage"))
          return jsonResponse(200, {
            totals: { cost_complete: false, turns: 1, cost_usd: 0 },
            buckets: [{ key: THREAD, cost_usd: 0, cost_complete: false }],
          });
        return jsonResponse(404, {});
      },
    });
    await harness.studio.start(harness.project.id as ProjectId);
    await harness.studio.submit(harness.project.id as ProjectId, {
      prompt: "Do a thing",
      mode: "work",
    });
    await waitFor(async () =>
      (await harness.store.readProjectEvents(harness.project.id as ProjectId)).some(
        (event) => event.kind === "turn.completed",
      ),
    );
    const snapshot = await harness.studio.snapshot(harness.project.id as ProjectId);
    expect(snapshot.cost.observed).toBe(true);
    expect(snapshot.cost.costComplete).toBe(false);
    expect(snapshot.cost.label).toContain("At least");
  });

  it("keeps stored history readable after the runtime stops", async () => {
    const harness = await setup();
    await harness.studio.start(harness.project.id as ProjectId);
    await harness.studio.submit(harness.project.id as ProjectId, {
      prompt: "Reply with exactly: pong",
      mode: "work",
    });
    await waitFor(async () =>
      (await harness.store.readProjectEvents(harness.project.id as ProjectId)).some(
        (event) => event.kind === "turn.completed",
      ),
    );
    const stopped = await harness.studio.stop(harness.project.id as ProjectId);
    expect(stopped.stopped).toBe(true);
    expect(stopped.rollback).toBe("not_promised");

    const offline = new WorkStudio({
      store: harness.store,
      supervisor: fakeSupervisor(),
      work: new WorkController({
        interrupt: async () => ({ interrupted: false, turn: null, note: "no active turn" }),
        stopOwnedRuntime: async () => stopReceipt(),
      }),
      now: () => new Date("2026-11-11T00:10:00.000Z"),
    });
    const snapshot = await offline.snapshot(harness.project.id as ProjectId);
    expect(snapshot.connection.state).toBe("not_started");
    expect(snapshot.cost.turns).toBe(1);
    const events = await harness.store.readProjectEvents(harness.project.id as ProjectId);
    expect(events.some((event) => event.kind === "turn.completed")).toBe(true);
  });
});

describe("cost budget gate at the studio", () => {
  it("blocks the next dispatch when a user budget is reached, without calling the engine", async () => {
    const harness = await setup({ now: () => new Date("2026-11-11T01:00:00.000Z") });
    await harness.store.recordUsage({
      projectId: harness.project.id,
      threadId: null,
      turnId: null,
      provider: "deepseek",
      model: "deepseek-flash",
      inputTokens: 1000,
      outputTokens: 10,
      cachedTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.05,
      costState: "reported",
      capturedAt: "2026-11-11T00:30:00.000Z",
    });
    await harness.store.putBudget({
      projectId: harness.project.id,
      scope: "project",
      limitPico: 10_000_000_000, // $0.01
      warnPico: null,
      enabled: true,
      timeZone: "UTC",
    });
    await harness.studio.start(harness.project.id as ProjectId);
    const before = harness.transport.calls.length;
    await expect(
      harness.studio.submit(harness.project.id as ProjectId, {
        prompt: "This dispatch must be refused by the local budget",
        mode: "work",
      }),
    ).rejects.toMatchObject({ code: "BUDGET_STOP" });
    // The gate is local state: no thread creation, no turn, no inference.
    expect(harness.transport.count("POST", "/v1/threads")).toBe(0);
    expect(harness.transport.count("POST", "/turns")).toBe(0);
    expect(harness.transport.calls.length).toBe(before);
    // A warning-level budget still allows the dispatch.
    await harness.store.putBudget({
      projectId: harness.project.id,
      scope: "project",
      limitPico: 10_000_000_000,
      warnPico: 1_000_000_000,
      enabled: false,
      timeZone: "UTC",
    });
  });

  it("answers ledger reads and edits with zero HTTP calls", async () => {
    const harness = await setup();
    const ledger = new CostLedger(harness.store);
    const projectId = harness.project.id as ProjectId;
    await ledger.ledger(projectId);
    await ledger.setBudget({ projectId, scope: "day", limitUsd: 2, timeZone: "UTC" });
    await ledger.setRateCard({
      provider: "deepseek",
      model: "deepseek-flash",
      cacheHitPerMillion: 0.28,
      cacheMissPerMillion: 2.8,
      outputPerMillion: 0.42,
    });
    await ledger.dispatchGate(projectId, "2026-11-11T00:00:00.000Z");
    await ledger.previewRecalculation(projectId, {
      provider: "deepseek",
      model: "deepseek-flash",
      cacheHitPerMillion: 1,
      cacheMissPerMillion: 1,
      outputPerMillion: 1,
    });
    await ledger.exportLedger(projectId, { format: "json" });
    expect(harness.transport.calls).toEqual([]);
  });
});

const harnessPlaceholder = "/tmp/placeholder";
