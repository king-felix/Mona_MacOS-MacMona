import { createHash } from "node:crypto";
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
}

function fakeSupervisor(): FakeSupervisor {
  let current = status();
  let workspace: string | null = null;
  const ensureCalls: string[] = [];
  const fake: FakeSupervisor = {
    ensureCalls,
    setStatus: (next) => {
      current = next;
      workspace = next.workspace;
    },
    status: () => current,
    isOwned: () => current.state === "running" && !current.external,
    ensure: async (requested) => {
      ensureCalls.push(requested);
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
  return fake;
}

interface Harness {
  studio: WorkStudio;
  store: Awaited<ReturnType<typeof openTestStore>>["store"];
  project: StoredProject;
  transport: FixtureTransport;
  supervisor: FakeSupervisor;
  pushes: StudioPush[];
  dir: string;
  threadCreates: Array<{ operation_key?: string; title?: string }>;
}

interface SetupOptions {
  handler?: (
    method: string,
    path: string,
    body: unknown,
  ) => ReturnType<typeof jsonResponse> | Promise<ReturnType<typeof jsonResponse>>;
  stream?: (path: string) => AsyncIterable<string>;
  adapter?: (transport: FixtureTransport, projectId: ProjectId, workspace: string) => EngineAdapter;
  dir?: string;
  failThreadCreate?: (attempt: number) => boolean;
}

async function setup(options: SetupOptions = {}): Promise<Harness> {
  const handle = await openTestStore(options.dir ? { dir: options.dir } : {});
  const folder = join(tempDir("mona-new-thread-"), "Studio project");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "README.md"), "# studio\n");
  const opened = await handle.store.openProject(folder);
  const canonical = opened.project.canonicalPath;

  const info = await fixture<Record<string, unknown>>("runtime-info.json");
  const accepted = await fixture<Record<string, unknown>>("turn-accepted.json");
  const events = await fixture<unknown[]>("events.json");
  const usage = await fixture<Record<string, unknown>>("usage.json");
  const threadCreates: Harness["threadCreates"] = [];
  let threadSeq = 0;
  let createAttempts = 0;
  const nextThread = () => {
    threadSeq += 1;
    return `thr_${String(threadSeq).padStart(16, "0")}`;
  };
  const handler =
    options.handler ??
    ((method: string, path: string, body: unknown) => {
      if (method === "GET" && path === "/v1/runtime/info") return jsonResponse(200, info);
      if (method === "POST" && path === "/v1/threads") {
        createAttempts += 1;
        if (options.failThreadCreate?.(createAttempts)) {
          return jsonResponse(500, { error: `thread store unavailable attempt ${createAttempts}` });
        }
        threadCreates.push((body ?? {}) as { operation_key?: string; title?: string });
        return jsonResponse(201, {
          id: nextThread(),
          workspace: canonical,
          created_at: "2026-11-11T00:00:00.000Z",
        });
      }
      if (method === "POST" && path.endsWith("/turns")) {
        const threadId = path.split("/")[3];
        return jsonResponse(201, { ...accepted, thread_id: threadId });
      }
      if (method === "POST" && path.endsWith("/fork")) {
        const id = nextThread();
        return jsonResponse(201, {
          thread: { id, workspace: canonical },
          original_user_text: "the first prompt",
        });
      }
      if (method === "POST" && path.endsWith("/retry")) {
        const id = nextThread();
        return jsonResponse(201, {
          thread: { id, workspace: canonical },
          turn: { id: TURN, thread_id: id, status: "accepted" },
        });
      }
      if (method === "POST" && path.endsWith("/compact"))
        return jsonResponse(200, { message: "compacted 12 turns" });
      if (method === "PATCH" && path.startsWith("/v1/threads/"))
        return jsonResponse(200, { thread: { id: path.split("/")[3] } });
      if (method === "POST" && path.includes("/interrupt"))
        return jsonResponse(200, {
          interrupted: true,
          thread_id: "thr_0000000000000001",
          id: TURN,
        });
      if (method === "GET" && path.startsWith("/v1/threads/")) {
        const threadId = path.split("/")[3];
        return jsonResponse(200, { id: threadId, workspace: canonical, turns: [] });
      }
      if (method === "GET" && path.startsWith("/v1/usage")) return jsonResponse(200, usage);
      return jsonResponse(404, { error: "fixture route missing" });
    });

  const streamFor = (path: string) => {
    const threadId = /^\/v1\/threads\/([^/]+)\/events/.exec(path)?.[1] ?? "thr_0123456789abcdef";
    const mapped = events.map((event) => {
      const record = event as Record<string, unknown>;
      return typeof record.thread_id === "string" ? { ...record, thread_id: threadId } : record;
    });
    return chunkText(sseFrames(mapped, { end: true }), 5);
  };
  const transport = new FixtureTransport(handler, options.stream ?? streamFor);
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
          store: new MemorySubmissionStore(),
          now: () => new Date("2026-11-11T00:00:00.000Z"),
        })),
    notify: (push) => pushes.push(push),
    now: () => new Date("2026-11-11T00:00:00.000Z"),
    reconnect: {
      attempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 2,
      sleep: async () => undefined,
      idleTimeoutMs: 5_000,
    },
  });
  return {
    studio,
    store: handle.store,
    project: opened.project,
    transport,
    supervisor,
    pushes,
    dir: handle.dir,
    threadCreates,
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition did not become true");
}

describe("R04 /new: a real conversation lifecycle", () => {
  it("creates a fresh engine conversation while the earlier one keeps its rows and events", async () => {
    const harness = await setup();
    const projectId = harness.project.id as ProjectId;
    await harness.studio.start(projectId);
    // First conversation through the ordinary submit path.
    await harness.studio.submit(projectId, { prompt: "Reply with exactly: pong", mode: "work" });
    await waitFor(async () =>
      (await harness.store.readProjectEvents(projectId)).some(
        (event) => event.kind === "turn.completed",
      ),
    );
    const first = await harness.store.listModeThreads(projectId, "work");
    expect(first).toHaveLength(1);
    const firstThread = first[0]!;
    const firstEvents = (await harness.store.readProjectEvents(projectId)).length;
    expect(firstThread.generation).toBe(0);

    const result = await harness.studio.newThread(projectId, {
      mode: "work",
      operationKey: "cmd-new-idle-0001",
    });
    expect(result.status, result.note).toBe("completed");
    expect(result.thread?.generation).toBe(1);
    expect(result.thread?.previousLocalThreadId).toBe(firstThread.id);
    expect(result.thread?.engineThreadId).not.toBe(firstThread.engineThreadId);
    expect(result.note).toContain("earlier conversation");

    // The studio reports the new conversation as current, in both modes' terms.
    expect((await harness.studio.snapshot(projectId)).threadId).toBe(result.thread?.localThreadId);
    expect((await harness.studio.snapshot(projectId)).engineThreadId).toBe(
      result.thread?.engineThreadId,
    );

    const threads = await harness.store.listModeThreads(projectId, "work");
    expect(threads.map((thread) => thread.generation).sort()).toEqual([0, 1]);
    // The earlier conversation is intact: its row, its events and its cursor.
    expect(await harness.store.getThread(firstThread.id)).not.toBeNull();
    expect((await harness.store.readProjectEvents(projectId)).length).toBeGreaterThanOrEqual(
      firstEvents,
    );
    expect(await harness.store.getCursor(firstThread.id)).toBeGreaterThan(0);
    // Two engine creates: the first conversation and the new one.
    expect(harness.threadCreates).toHaveLength(2);
    expect(harness.threadCreates[1]?.operation_key).toContain("work-1");
  });

  it("keeps the conversation a pre-R04 project already has instead of starting a second one", async () => {
    const harness = await setup();
    const projectId = harness.project.id as ProjectId;
    // The id the first conversation used before schema v11. An upgrade must
    // adopt it, not treat it as an unknown row and create a new generation.
    const legacyId = `thr_${createHash("sha256")
      .update(`${projectId}:engine:work`)
      .digest("hex")
      .slice(0, 16)}`;
    await harness.store.upsertThread({
      id: legacyId,
      projectId,
      engineThreadId: "thr_0000000000000009",
      title: "Legacy conversation",
    });
    await harness.studio.start(projectId);
    await harness.studio.submit(projectId, {
      prompt: "continue the old conversation",
      mode: "work",
    });

    const threads = await harness.store.listModeThreads(projectId, "work");
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      id: legacyId,
      generation: 0,
      mode: "work",
      engineThreadId: "thr_0000000000000009",
    });
    expect(harness.threadCreates).toHaveLength(0);
    const turnCall = harness.transport.calls.find(
      (call) => call.method === "POST" && call.path.endsWith("/turns"),
    );
    expect(turnCall?.path).toContain("thr_0000000000000009");
  });

  it("refuses while a turn is running and creates nothing", async () => {
    const harness = await setup();
    const projectId = harness.project.id as ProjectId;
    await harness.studio.start(projectId);

    // Hold a turn open: the fake adapter accepts but its stream never starts
    // the conversation, so the studio's own active-turn state is what /new sees.
    const busyAdapter: EngineAdapter = {
      discover: async () => ({
        identity: { version: "0.10.2", commit: COMMIT },
        capabilities: {},
      }),
      createOrOpenThread: async (input) => ({
        threadId: "thr_aaaaaaaaaaaaaaaa" as never,
        workspace: input.workspace,
        created: true,
      }),
      submitTurn: async (input) => ({
        accepted: true,
        turnId: TURN as never,
        submission: {
          operationKey: input.operationKey,
          threadId: input.threadId,
          turnId: TURN as never,
          status: "accepted",
          submittedAt: "2026-11-11T00:00:00.000Z",
          reconciled: false,
        },
        outcomeUnknown: false,
        guidance: null,
      }),
      subscribe: async function* (input: { signal: AbortSignal }) {
        // Hold the stream open so the studio's connection stays live while the
        // turn is active — the real reason `/new` sees a busy session.
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      interrupt: async () => ({
        interrupted: true,
        turn: null,
        note: "interrupted",
      }),
      readHistory: async () => ({
        threadId: "thr_aaaaaaaaaaaaaaaa" as never,
        turns: [],
        workspace: harness.project.canonicalPath,
      }),
      readUsage: async () => ({ observed: false, buckets: [], totals: null }),
      getEffectiveProfile: async () => {
        throw new Error("not needed");
      },
      invokeCapability: async () => {
        throw new Error("not needed");
      },
    } as unknown as EngineAdapter;
    const busy = new WorkStudio({
      store: harness.store,
      supervisor: harness.supervisor,
      work: new WorkController({
        interrupt: async (input) => busy.interruptTurn(input.task.workspace, input.turnId),
        stopOwnedRuntime: async () => stopReceipt(),
      }),
      newAdapter: () => busyAdapter,
      now: () => new Date("2026-11-11T00:00:00.000Z"),
      reconnect: { attempts: 1, baseDelayMs: 1, maxDelayMs: 2, sleep: async () => undefined },
    });
    await busy.start(projectId);
    await busy.submit(projectId, { prompt: "long task", mode: "work" });
    expect((await busy.snapshot(projectId)).activeTurnId).toBe(TURN);

    const refused = await busy.newThread(projectId, {
      mode: "work",
      operationKey: "cmd-new-busy-0001",
    });
    expect(refused.status).toBe("busy");
    expect(refused.thread).toBeNull();
    expect(refused.note).toContain("will not detach a running turn");
    // Nothing new was allocated.
    expect(await harness.store.listModeThreads(projectId, "work")).toHaveLength(1);
    await busy.close();
  });

  it("interrupts only on the explicit choice, then starts the new conversation", async () => {
    const harness = await setup();
    const projectId = harness.project.id as ProjectId;
    let interrupts = 0;
    const adapter: EngineAdapter = {
      discover: async () => ({
        identity: { version: "0.10.2", commit: COMMIT },
        capabilities: {},
      }),
      createOrOpenThread: async (input) => {
        harness.threadCreates.push({ operation_key: undefined, title: input.title });
        return {
          threadId: "thr_bbbbbbbbbbbbbbbb" as never,
          workspace: input.workspace,
          created: true,
        };
      },
      submitTurn: async (input) => ({
        accepted: true,
        turnId: TURN as never,
        submission: {
          operationKey: input.operationKey,
          threadId: input.threadId,
          turnId: TURN as never,
          status: "accepted",
          submittedAt: "2026-11-11T00:00:00.000Z",
          reconciled: false,
        },
        outcomeUnknown: false,
        guidance: null,
      }),
      subscribe: async function* (input: { signal: AbortSignal }) {
        // Hold the stream open so the studio's connection stays live while the
        // turn is active — the real reason `/new` sees a busy session.
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      interrupt: async () => {
        interrupts += 1;
        return { interrupted: true, turn: null, note: "interrupt confirmed" };
      },
      readHistory: async () => ({
        threadId: "thr_bbbbbbbbbbbbbbbb" as never,
        turns: [],
        workspace: harness.project.canonicalPath,
      }),
      readUsage: async () => ({ observed: false, buckets: [], totals: null }),
      getEffectiveProfile: async () => {
        throw new Error("not needed");
      },
      invokeCapability: async () => {
        throw new Error("not needed");
      },
    } as unknown as EngineAdapter;
    const studio = new WorkStudio({
      store: harness.store,
      supervisor: harness.supervisor,
      work: new WorkController({
        interrupt: async (input) => studio.interruptTurn(input.task.workspace, input.turnId),
        stopOwnedRuntime: async () => stopReceipt(),
      }),
      newAdapter: () => adapter,
      now: () => new Date("2026-11-11T00:00:00.000Z"),
      reconnect: { attempts: 1, baseDelayMs: 1, maxDelayMs: 2, sleep: async () => undefined },
    });
    await studio.start(projectId);
    await studio.submit(projectId, { prompt: "long task", mode: "work" });
    expect((await studio.snapshot(projectId)).activeTurnId).toBe(TURN);

    const result = await studio.newThread(projectId, {
      mode: "work",
      operationKey: "cmd-new-interrupt-0001",
      resolveBusy: "interrupt",
    });
    expect(interrupts).toBe(1);
    expect(result.status).toBe("completed");
    expect(result.thread?.generation).toBe(1);
  });

  it("works offline: the local generation is real and the engine thread is deferred", async () => {
    const harness = await setup();
    const projectId = harness.project.id as ProjectId;
    const result = await harness.studio.newThread(projectId, {
      mode: "work",
      operationKey: "cmd-new-offline-0001",
    });
    expect(result.status).toBe("deferred");
    expect(result.thread?.engineThreadId).toBeNull();
    expect(result.note).toContain("when the studio connects");
    expect(harness.transport.count("POST", "/v1/threads")).toBe(0);
    const threads = await harness.store.listModeThreads(projectId, "work");
    expect(threads).toHaveLength(1);

    // Connecting and submitting creates the engine thread for that generation,
    // with the deterministic operation key.
    await harness.studio.start(projectId);
    await harness.studio.submit(projectId, { prompt: "first task here", mode: "work" });
    const [row] = await harness.store.listModeThreads(projectId, "work");
    expect(row?.engineThreadId).toBe("thr_0000000000000001");
    expect(harness.threadCreates[0]?.operation_key).toContain("work-0");
  });

  it("resumes the same operation after a lost engine response instead of creating a second conversation", async () => {
    const harness = await setup({ failThreadCreate: (attempt) => attempt === 1 });
    const projectId = harness.project.id as ProjectId;
    await harness.studio.start(projectId);
    const first = await harness.studio.newThread(projectId, {
      mode: "work",
      operationKey: "cmd-new-lost-0001",
    });
    expect(first.status).toBe("deferred");
    expect(first.thread?.engineThreadId).toBeNull();
    expect(first.note).toContain("not created yet");

    const retried = await harness.studio.newThread(projectId, {
      mode: "work",
      operationKey: "cmd-new-lost-0001",
    });
    expect(retried.status, retried.note).toBe("completed");
    expect(retried.duplicate).toBe(true);
    expect(retried.thread?.localThreadId).toBe(first.thread?.localThreadId);
    expect(retried.thread?.generation).toBe(0);
    // One local generation, and the engine saw the same operation key twice.
    expect(await harness.store.listModeThreads(projectId, "work")).toHaveLength(1);
    expect(harness.threadCreates).toHaveLength(1);
    expect(harness.threadCreates[0]?.operation_key).toBe(`thread-${projectId}-work-0`);
  });

  it("resumes a key whose thread row was lost without reusing the first conversation's engine key", async () => {
    const harness = await setup();
    const projectId = harness.project.id as ProjectId;
    await harness.studio.start(projectId);
    // The first conversation exists at generation 0.
    await harness.studio.newThread(projectId, { mode: "work", operationKey: "cmd-crash-a" });
    expect(harness.threadCreates[0]?.operation_key).toBe(`thread-${projectId}-work-0`);

    // Simulate the crash window: the key recorded its target generation, then
    // the process died before the thread row was written.
    const lostTarget = "thr_lostrow0000000";
    await harness.store.putCommandOperation({
      operationKey: "cmd-crash-b",
      projectId,
      command: "new",
      targetId: lostTarget,
      status: "pending",
      result: { generation: 1, mode: "work" },
    });
    expect(await harness.store.getThread(lostTarget)).toBeNull();

    const resumed = await harness.studio.newThread(projectId, {
      mode: "work",
      operationKey: "cmd-crash-b",
    });
    expect(resumed.thread?.localThreadId).toBe(lostTarget);
    expect(resumed.thread?.generation).toBe(1);
    // The engine key is generation 1's, never generation 0's a second time.
    expect(harness.threadCreates.at(-1)?.operation_key).toBe(`thread-${projectId}-work-1`);
    const keys = harness.threadCreates.map((create) => create.operation_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps the recorded generation through a deferred write", async () => {
    const harness = await setup({ failThreadCreate: () => true });
    const projectId = harness.project.id as ProjectId;
    await harness.studio.start(projectId);
    // Generation 0 exists first, so a fall-back to 0 would collide with it.
    await harness.store.upsertThread({
      id: "thr_seed000000000000",
      projectId,
      engineThreadId: "thr_seedengine000000",
      title: "Seed",
      mode: "work",
      generation: 0,
    });

    const deferred = await harness.studio.newThread(projectId, {
      mode: "work",
      operationKey: "cmd-deferred-generation",
    });
    expect(deferred.status).toBe("deferred");
    expect(deferred.thread?.generation).toBe(1);
    // The pending write must carry the generation: this is the key a later
    // resume reads when the thread row is the part that was lost.
    const pending = await harness.store.getCommandOperation("cmd-deferred-generation");
    expect(pending?.status).toBe("pending");
    expect((pending?.result as { generation?: number } | null)?.generation).toBe(1);

    // Resuming the deferred intent reuses its conversation and allocates
    // nothing new, even though the engine create keeps failing.
    const resumed = await harness.studio.newThread(projectId, {
      mode: "work",
      operationKey: "cmd-deferred-generation",
    });
    expect(resumed.thread?.localThreadId).toBe(deferred.thread?.localThreadId);
    expect(resumed.thread?.generation).toBe(1);
    expect(
      (await harness.store.listModeThreads(projectId, "work"))
        .map((thread) => thread.generation)
        .sort(),
    ).toEqual([0, 1]);
  });

  it("records a durable receipt for rename, compact and fork", async () => {
    const harness = await setup();
    const projectId = harness.project.id as ProjectId;
    await harness.studio.start(projectId);
    await harness.studio.submit(projectId, { prompt: "seed", mode: "work" });
    await waitFor(async () =>
      (await harness.store.readProjectEvents(projectId)).some(
        (event) => event.kind === "turn.completed",
      ),
    );
    for (const [command, run] of [
      [
        "rename",
        () =>
          harness.studio.renameConversation(projectId, {
            mode: "work",
            title: "Named",
            operationKey: "cmd-receipt-rename",
          }),
      ],
      [
        "compact",
        () =>
          harness.studio.compactConversation(projectId, {
            mode: "work",
            operationKey: "cmd-receipt-compact",
          }),
      ],
      [
        "fork",
        () =>
          harness.studio.forkConversation(projectId, {
            mode: "work",
            operationKey: "cmd-receipt-fork",
          }),
      ],
    ] as const) {
      await run();
      const record = await harness.store.getCommandOperation(`cmd-receipt-${command}`);
      expect(record?.status, command).toBe("completed");
      expect(record?.command, command).toBe(command);
      expect(record?.result?.note, command).toBeTruthy();
    }
  });

  it("returns the recorded receipt for a completed key and does not allocate again", async () => {
    const harness = await setup();
    const projectId = harness.project.id as ProjectId;
    await harness.studio.start(projectId);
    const first = await harness.studio.newThread(projectId, {
      mode: "work",
      operationKey: "cmd-new-repeat-0001",
    });
    const createsAfterFirst = harness.threadCreates.length;
    const again = await harness.studio.newThread(projectId, {
      mode: "work",
      operationKey: "cmd-new-repeat-0001",
    });
    expect(again.duplicate).toBe(true);
    expect(again.thread?.localThreadId).toBe(first.thread?.localThreadId);
    expect(harness.threadCreates).toHaveLength(createsAfterFirst);
    expect(await harness.store.listModeThreads(projectId, "work")).toHaveLength(1);
  });

  it("after a restart the newest generation is the one a new /new builds on", async () => {
    const harness = await setup();
    const projectId = harness.project.id as ProjectId;
    await harness.studio.start(projectId);
    await harness.studio.newThread(projectId, { mode: "work", operationKey: "cmd-restart-a" });
    await harness.studio.newThread(projectId, { mode: "work", operationKey: "cmd-restart-b" });
    expect(
      (await harness.store.listModeThreads(projectId, "work")).map((t) => t.generation),
    ).toEqual([1, 0]);

    // A new process over the same store: the same generations exist, and the
    // next /new continues from the newest rather than reusing generation 0.
    const restarted = new WorkStudio({
      store: harness.store,
      supervisor: harness.supervisor,
      work: new WorkController({
        interrupt: async () => ({ interrupted: false, turn: null, note: "none" }),
        stopOwnedRuntime: async () => stopReceipt(),
      }),
      newAdapter: () =>
        new CodewhaleAdapter({
          transport: harness.transport,
          store: new MemorySubmissionStore(),
          now: () => new Date("2026-11-11T00:00:00.000Z"),
        }),
      now: () => new Date("2026-11-11T00:00:00.000Z"),
      reconnect: { attempts: 1, baseDelayMs: 1, maxDelayMs: 2, sleep: async () => undefined },
    });
    await restarted.start(projectId);
    const next = await restarted.newThread(projectId, {
      mode: "work",
      operationKey: "cmd-restart-c",
    });
    expect(next.thread?.generation).toBe(2);
    expect(
      (await harness.store.listModeThreads(projectId, "work")).map((t) => t.generation).sort(),
    ).toEqual([0, 1, 2]);
  });

  it("does not reset another project's conversation when /new runs on a project without a session", async () => {
    const harness = await setup();
    const projectId = harness.project.id as ProjectId;
    await harness.studio.start(projectId);
    await harness.studio.submit(projectId, { prompt: "keep me", mode: "work" });
    await waitFor(async () =>
      (await harness.store.readProjectEvents(projectId)).some(
        (event) => event.kind === "turn.completed",
      ),
    );
    const bound = await harness.studio.snapshot(projectId);
    const before = bound.threadId;

    const otherFolder = join(harness.dir, "other-project");
    mkdirSync(otherFolder, { recursive: true });
    const other = await harness.store.openProject(otherFolder);
    const result = await harness.studio.newThread(other.project.id as ProjectId, {
      mode: "work",
      operationKey: "cmd-other-project-1",
    });
    expect(result.status).toBe("deferred");
    expect(await harness.store.listModeThreads(other.project.id as ProjectId, "work")).toHaveLength(
      1,
    );
    // The bound project's conversation is untouched.
    expect((await harness.studio.snapshot(projectId)).threadId).toBe(before);
    expect((await harness.studio.snapshot(projectId)).engineThreadId).toBe(bound.engineThreadId);
  });
});

describe("R04 native command operations", () => {
  async function connected(): Promise<{ harness: Harness; projectId: ProjectId }> {
    const harness = await setup();
    const projectId = harness.project.id as ProjectId;
    await harness.studio.start(projectId);
    await harness.studio.submit(projectId, { prompt: "seed the thread", mode: "work" });
    await waitFor(async () =>
      (await harness.store.readProjectEvents(projectId)).some(
        (event) => event.kind === "turn.completed",
      ),
    );
    return { harness, projectId };
  }

  it("renames through the engine and stores the same title locally", async () => {
    const { harness, projectId } = await connected();
    const thread = (await harness.store.listModeThreads(projectId, "work"))[0]!;
    const result = await harness.studio.renameConversation(projectId, {
      mode: "work",
      title: "Payment retry",
      operationKey: "cmd-rename-real-1",
    });
    expect(result.status).toBe("completed");
    expect(harness.transport.count("PATCH", `/v1/threads/${thread.engineThreadId}`)).toBe(1);
    expect(harness.transport.calls.at(-1)?.body).toEqual({ title: "Payment retry" });
    expect((await harness.store.getThread(thread.id))?.title).toBe("Payment retry");
  });

  it("compacts the current conversation and reports the engine's own message", async () => {
    const { harness, projectId } = await connected();
    const thread = (await harness.store.listModeThreads(projectId, "work"))[0]!;
    const result = await harness.studio.compactConversation(projectId, {
      mode: "work",
      operationKey: "cmd-compact-real-1",
    });
    expect(result.note).toContain("compacted 12 turns");
    expect(harness.transport.count("POST", `/v1/threads/${thread.engineThreadId}/compact`)).toBe(1);
  });

  it("forks into a sibling conversation and leaves the source readable", async () => {
    const { harness, projectId } = await connected();
    const source = (await harness.store.listModeThreads(projectId, "work"))[0]!;
    const result = await harness.studio.forkConversation(projectId, {
      mode: "work",
      operationKey: "cmd-fork-real-1",
    });
    expect(result.thread?.generation).toBe(1);
    expect(result.thread?.engineThreadId).toBe("thr_0000000000000002");
    expect(result.note).toContain("the first prompt");
    expect(result.note).toContain("source thread");
    expect(await harness.store.getThread(source.id)).not.toBeNull();
  });

  it("retries in a forked conversation and attaches the new turn", async () => {
    const { harness, projectId } = await connected();
    const result = await harness.studio.retryConversation(projectId, {
      mode: "work",
      operationKey: "cmd-retry-real-1",
    });
    expect(result.thread?.generation).toBe(1);
    expect(result.turnId).toBe(TURN);
    expect((await harness.studio.snapshot(projectId)).activeTurnId).toBe(TURN);
  });

  it("refuses to fork or compact while a turn is active, keeping the turn attached", async () => {
    const harness = await setup();
    const projectId = harness.project.id as ProjectId;
    const adapter: EngineAdapter = {
      discover: async () => ({ identity: { version: "0.10.2", commit: COMMIT }, capabilities: {} }),
      createOrOpenThread: async (input) => ({
        threadId: "thr_cccccccccccccccc" as never,
        workspace: input.workspace,
        created: true,
      }),
      submitTurn: async (input) => ({
        accepted: true,
        turnId: TURN as never,
        submission: {
          operationKey: input.operationKey,
          threadId: input.threadId,
          turnId: TURN as never,
          status: "accepted",
          submittedAt: "2026-11-11T00:00:00.000Z",
          reconciled: false,
        },
        outcomeUnknown: false,
        guidance: null,
      }),
      subscribe: async function* (input: { signal: AbortSignal }) {
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      interrupt: async () => ({ interrupted: false, turn: null, note: "not asked" }),
      readHistory: async () => ({
        threadId: "thr_cccccccccccccccc" as never,
        turns: [],
        workspace: harness.project.canonicalPath,
      }),
      readUsage: async () => ({ observed: false, buckets: [], totals: null }),
      getEffectiveProfile: async () => {
        throw new Error("not needed");
      },
      invokeCapability: async () => {
        throw new Error("not needed");
      },
      forkThread: async () => {
        throw new Error("fork must not be called while a turn is active");
      },
      compactThread: async () => {
        throw new Error("compact must not be called while a turn is active");
      },
    } as unknown as EngineAdapter;
    const studio = new WorkStudio({
      store: harness.store,
      supervisor: harness.supervisor,
      work: new WorkController({
        interrupt: async (input) => studio.interruptTurn(input.task.workspace, input.turnId),
        stopOwnedRuntime: async () => stopReceipt(),
      }),
      newAdapter: () => adapter,
      now: () => new Date("2026-11-11T00:00:00.000Z"),
      reconnect: { attempts: 1, baseDelayMs: 1, maxDelayMs: 2, sleep: async () => undefined },
    });
    await studio.start(projectId);
    await studio.submit(projectId, { prompt: "long task", mode: "work" });
    expect((await studio.snapshot(projectId)).activeTurnId).toBe(TURN);

    await expect(
      studio.forkConversation(projectId, { mode: "work", operationKey: "cmd-fork-busy-1" }),
    ).rejects.toMatchObject({ code: "TURN_ACTIVE" });
    await expect(
      studio.compactConversation(projectId, { mode: "work", operationKey: "cmd-compact-busy-1" }),
    ).rejects.toMatchObject({ code: "TURN_ACTIVE" });
    // The turn is still attached, and the conversation did not move.
    expect((await studio.snapshot(projectId)).activeTurnId).toBe(TURN);
    await studio.close();
  });

  it("refuses native operations without a live conversation instead of faking one", async () => {
    const harness = await setup();
    const projectId = harness.project.id as ProjectId;
    await expect(
      harness.studio.compactConversation(projectId, {
        mode: "work",
        operationKey: "cmd-compact-offline",
      }),
    ).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    expect(harness.transport.count("POST", "/compact")).toBe(0);
  });
});
