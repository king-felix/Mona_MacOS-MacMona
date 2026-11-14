import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pendingSignalFor, pendingSettlementFor } from "../src/shared/contracts/pending";
import type { PendingRequestView } from "../src/shared/contracts/studio";
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
const THREAD = "thr_0123456789abcdef";
const TURN = "turn_0123456789abcdef";
const APPROVAL = `approval_${"a".repeat(32)}`;
const APPROVAL_TWO = `approval_${"b".repeat(32)}`;
const INPUT = "request_0123456789abcdef";

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

function fakeSupervisor(): StudioSupervisor & { setStatus(next: RuntimeStatus): void } {
  let current = status();
  let workspace: string | null = null;
  return {
    setStatus: (next) => {
      current = next;
      workspace = next.workspace;
    },
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

interface Harness {
  studio: WorkStudio;
  store: Awaited<ReturnType<typeof openTestStore>>["store"];
  project: StoredProject;
  transport: FixtureTransport;
  pushes: StudioPush[];
  thread: Record<string, unknown>;
  setPending(approvals: unknown[], inputs: unknown[]): void;
}

/**
 * A real studio over a real SQLite store and a fixture transport. The engine's
 * thread detail is the authority for what is still pending, so this harness
 * keeps one mutable thread document that a test can rewrite between calls.
 */
async function setup(
  options: {
    events?: unknown[];
    /** Frames inserted inside the turn, before its completion. */
    pending?: unknown[];
    /** Extra routes, tried before the defaults. */
    routes?: (
      method: string,
      path: string,
      body: unknown,
    ) => ReturnType<typeof jsonResponse> | null;
    /** Replace the thread document's pending lists entirely. */
    omitPendingLists?: boolean;
    adapter?: (transport: FixtureTransport) => EngineAdapter;
  } = {},
): Promise<Harness> {
  const handle = await openTestStore();
  const folder = join(tempDir("mona-pending-project-"), "Pending project");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "README.md"), "# pending\n");
  const opened = await handle.store.openProject(folder);

  const info = await fixture<Record<string, unknown>>("runtime-info.json");
  const thread = await fixture<Record<string, unknown>>("thread.json");
  thread.workspace = opened.project.canonicalPath;
  const accepted = await fixture<Record<string, unknown>>("turn-accepted.json");
  const usage = await fixture<Record<string, unknown>>("usage.json");
  const base = await fixture<unknown[]>("events.json");
  const events = options.events ??
    // A clean sequence: one turn that asks, then ends. The engine's pending
    // list is separate state, so the ask outliving its turn is realistic.
    [
      ...base.filter((event) => (event as { seq: number }).seq <= 3),
      ...(options.pending ?? []),
      {
        schema_version: 2,
        seq: 100,
        previous_seq: 99,
        event: "turn.completed",
        kind: "turn.completed",
        thread_id: THREAD,
        turn_id: TURN,
        timestamp: "2026-11-11T00:00:09.000Z",
        payload: {},
      },
    ];
  // The engine's own list starts as whatever the delivered frames announced:
  // thread detail and the event stream describe one world in the real runtime.
  const announced = (options.pending ?? [])
    .map((frame) =>
      pendingSignalFor({
        kind: (frame as { kind: string }).kind,
        turnId: (frame as { turn_id?: string }).turn_id ?? null,
        payload: (frame as { payload: unknown }).payload,
      }),
    )
    .filter((signal): signal is NonNullable<typeof signal> => signal !== null);
  let approvals: unknown[] = announced
    .filter((signal) => signal.kind === "approval")
    .map((signal) => ({
      id: signal.requestKey,
      turn_id: signal.turnId,
      tool_name: signal.kind === "approval" ? signal.toolName : null,
      summary: signal.kind === "approval" ? signal.summary : null,
      input: signal.kind === "approval" ? signal.input : null,
      tool_call_id: signal.kind === "approval" ? signal.toolCallId : null,
    }));
  let inputs: unknown[] = announced
    .filter((signal) => signal.kind === "user_input")
    .map((signal) => ({
      request_id: signal.requestKey,
      turn_id: signal.turnId,
      questions: signal.kind === "user_input" ? signal.questions : [],
    }));
  const defaults = (method: string, path: string) => {
    if (method === "GET" && path === "/v1/runtime/info") return jsonResponse(200, info);
    if (method === "POST" && path === "/v1/threads") return jsonResponse(201, thread);
    if (method === "POST" && path.endsWith("/turns")) return jsonResponse(201, accepted);
    if (method === "POST" && path.includes("/interrupt"))
      return jsonResponse(200, { interrupted: true, thread_id: THREAD, id: TURN });
    if (method === "GET" && path.includes("turn-operations"))
      return jsonResponse(200, { ...accepted, status: "completed" });
    if (method === "GET" && path.startsWith(`/v1/threads/${THREAD}`))
      return jsonResponse(200, {
        thread: { ...thread, pending_approvals: approvals, pending_user_inputs: inputs },
      });
    if (method === "GET" && path.startsWith("/v1/usage")) return jsonResponse(200, usage);
    return jsonResponse(404, { error: "fixture route missing" });
  };
  const handler = (method: string, path: string, body: unknown) => {
    const extra = options.routes?.(method, path, body) ?? null;
    if (extra) return extra;
    if (options.omitPendingLists && method === "GET" && path.startsWith(`/v1/threads/${THREAD}`)) {
      return jsonResponse(200, { thread: { ...thread } });
    }
    return defaults(method, path);
  };
  const transport = new FixtureTransport(handler, () =>
    chunkText(sseFrames(events, { end: true }), 5),
  );
  const pushes: StudioPush[] = [];
  const studio = new WorkStudio({
    store: handle.store,
    supervisor: fakeSupervisor(),
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
    },
  });
  return {
    studio,
    store: handle.store,
    project: opened.project,
    transport,
    pushes,
    thread,
    setPending: (nextApprovals, nextInputs) => {
      approvals = nextApprovals;
      inputs = nextInputs;
    },
  };
}

function approvalEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 2,
    seq: 4,
    previous_seq: 3,
    event: "approval.required",
    kind: "approval.required",
    thread_id: THREAD,
    turn_id: TURN,
    timestamp: "2026-11-11T00:00:05.000Z",
    payload: {
      approval_id: APPROVAL,
      id: APPROVAL,
      tool_name: "bash",
      summary: "Run `npm test` in the project root",
      input: { command: "npm test" },
      tool_call_id: "call_1",
      available_decisions: ["allow", "deny"],
      ...overrides,
    },
  };
}

async function submitOnce(harness: Harness): Promise<void> {
  await harness.studio.start(harness.project.id as ProjectId);
  await harness.studio.submit(harness.project.id as ProjectId, {
    prompt: "Run the tests",
    mode: "work",
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition did not become true");
}

describe("pending request signals", () => {
  it("reads the engine's approval capability, never the tool-call id", () => {
    const signal = pendingSignalFor({
      kind: "approval.required",
      turnId: TURN,
      payload: {
        approval_id: APPROVAL,
        id: "not-the-capability",
        tool_call_id: "call_1",
        tool_name: "bash",
        summary: "Run `npm test`",
        input: { command: "npm test" },
      },
    });
    expect(signal).toMatchObject({
      kind: "approval",
      requestKey: APPROVAL,
      toolName: "bash",
      title: "Run `npm test`",
      toolCallId: "call_1",
    });
  });

  it("refuses a capability that would leave the path segment", () => {
    const signal = pendingSignalFor({
      kind: "approval.required",
      payload: { approval_id: "../../etc/passwd" },
    });
    expect(signal).toBeNull();
  });

  it("reads structured questions and their options", () => {
    const signal = pendingSignalFor({
      kind: "user_input.required",
      turnId: TURN,
      payload: {
        request_id: INPUT,
        questions: [
          {
            id: "q1",
            header: "Package manager",
            question: "Which one?",
            options: [{ label: "npm", description: "lockfile" }, { label: "pnpm" }],
            multi_select: false,
          },
        ],
      },
    });
    expect(signal).toMatchObject({ kind: "user_input", requestKey: INPUT });
    if (signal?.kind !== "user_input") throw new Error("expected a question");
    expect(signal.questions).toHaveLength(1);
    expect(signal.questions[0]?.options.map((option) => option.label)).toEqual(["npm", "pnpm"]);
  });

  it("distinguishes a timeout from a person's denial", () => {
    expect(
      pendingSettlementFor({
        kind: "approval.timeout",
        payload: { approval_id: APPROVAL },
      }),
    ).toMatchObject({ status: "expired", decision: null });
    expect(
      pendingSettlementFor({
        kind: "approval.decided",
        payload: { approval_id: APPROVAL, decision: "deny", decided_by: "user" },
      }),
    ).toMatchObject({ status: "answered", decision: "deny", decidedBy: "user" });
    expect(
      pendingSettlementFor({
        kind: "approval.decided",
        payload: { approval_id: APPROVAL, decision: "allow", cancelled: true },
      }),
    ).toMatchObject({ status: "cancelled" });
  });
});

describe("live studio: pending requests are durable and answerable", () => {
  it("stores an approval under the engine's capability and offers it to the screen", async () => {
    const harness = await setup({ pending: [approvalEvent()] });
    await submitOnce(harness);
    await waitFor(async () => harness.pushes.some((push) => push.state === "pending_input"));

    const rows = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "approval",
      requestKey: APPROVAL,
      toolName: "bash",
      title: "Run `npm test` in the project root",
      status: "pending",
    });
    const snapshot = await harness.studio.snapshot(harness.project.id as ProjectId);
    const view = snapshot.pendingRequests[0] as PendingRequestView;
    expect(view.kind).toBe("approval");
    expect(view.decisions).toEqual(["allow", "deny"]);
    expect(view.input).toEqual({ command: "npm test" });
    // The capability must not reach the renderer; answering names Mona's row.
    expect(JSON.stringify(view)).not.toContain(APPROVAL);
  });

  it("reports the runtime's own 2xx as an acknowledgement", async () => {
    const answers: unknown[] = [];
    const harness = await setup({
      pending: [approvalEvent()],
      routes: (method, path, body) => {
        if (method === "POST" && path === `/v1/approvals/${APPROVAL}`) {
          answers.push(body);
          return jsonResponse(200, { approval_id: APPROVAL, outcome: "allowed_once" });
        }
        return null;
      },
    });
    await submitOnce(harness);
    await waitFor(
      async () =>
        (await harness.store.listPendingRequests(harness.project.id as ProjectId)).length === 1,
    );
    const [row] = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    const result = await harness.studio.answerPending(harness.project.id as ProjectId, row!.id, {
      kind: "approval",
      decision: "allow",
      remember: true,
    });
    expect(result.acknowledged).toBe(true);
    expect(result.outcome).toBe("answered");
    // The capability was echoed verbatim; the decision and grant flag went with
    // it in the shape the Runtime documents.
    expect(answers).toEqual([{ decision: "allow", remember: true }]);
    const after = await harness.store.getPendingRequest(row!.id);
    expect(after).toMatchObject({ status: "answered", decision: "allow", decidedBy: "user" });
    expect(after?.acknowledgement).toContain("200");
  });

  it("reports a 404 as expired and claims no delivery", async () => {
    const harness = await setup({
      pending: [approvalEvent()],
      routes: (method, path) =>
        method === "POST" && path === `/v1/approvals/${APPROVAL}`
          ? jsonResponse(404, { error: "not pending" })
          : null,
    });
    await submitOnce(harness);
    await waitFor(
      async () =>
        (await harness.store.listPendingRequests(harness.project.id as ProjectId)).length === 1,
    );
    const [row] = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    const result = await harness.studio.answerPending(harness.project.id as ProjectId, row!.id, {
      kind: "approval",
      decision: "deny",
      remember: false,
    });
    expect(result.acknowledged).toBe(false);
    expect(result.outcome).toBe("expired");
    const after = await harness.store.getPendingRequest(row!.id);
    expect(after?.status).toBe("expired");
    expect(after?.decision).toBeNull();
  });

  it("sends one answer for one capability, even under a double click", async () => {
    let sent = 0;
    const harness = await setup({
      pending: [approvalEvent()],
      routes: (method, path) =>
        method === "POST" && path === `/v1/approvals/${APPROVAL}`
          ? (sent += 1) > 0
            ? jsonResponse(200, { approval_id: APPROVAL })
            : jsonResponse(500, {})
          : null,
    });
    await submitOnce(harness);
    await waitFor(
      async () =>
        (await harness.store.listPendingRequests(harness.project.id as ProjectId)).length === 1,
    );
    const [row] = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    const [first, second] = await Promise.allSettled([
      harness.studio.answerPending(harness.project.id as ProjectId, row!.id, {
        kind: "approval",
        decision: "allow",
        remember: false,
      }),
      harness.studio.answerPending(harness.project.id as ProjectId, row!.id, {
        kind: "approval",
        decision: "allow",
        remember: false,
      }),
    ]);
    expect(sent).toBe(1);
    const fulfilled = [first, second].filter((entry) => entry.status === "fulfilled");
    const rejected = [first, second].filter((entry) => entry.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it("answers structured questions with values the engine offered", async () => {
    const inputEvent = {
      schema_version: 2,
      seq: 4,
      previous_seq: 3,
      event: "user_input.required",
      kind: "user_input.required",
      thread_id: THREAD,
      turn_id: TURN,
      timestamp: "2026-11-11T00:00:05.000Z",
      payload: {
        request_id: INPUT,
        questions: [
          {
            id: "q1",
            header: "Package manager",
            question: "Which one?",
            options: [{ label: "npm" }, { label: "pnpm" }],
            multi_select: false,
          },
        ],
      },
    };
    const bodies: unknown[] = [];
    const harness = await setup({
      pending: [inputEvent],
      routes: (method, path, body) => {
        if (method === "POST" && path === `/v1/user-input/${THREAD}/${INPUT}`) {
          bodies.push(body);
          return jsonResponse(200, { ok: true });
        }
        return null;
      },
    });
    await submitOnce(harness);
    await waitFor(
      async () =>
        (await harness.store.listPendingRequests(harness.project.id as ProjectId)).length === 1,
    );
    const [row] = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    // A value the engine never offered is refused before the capability is spent.
    await expect(
      harness.studio.answerPending(harness.project.id as ProjectId, row!.id, {
        kind: "user_input",
        answers: [{ questionId: "q1", label: "yarn", value: "yarn" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const stored = await harness.store.getPendingRequest(row!.id);
    expect(stored?.status).toBe("pending");

    const result = await harness.studio.answerPending(harness.project.id as ProjectId, row!.id, {
      kind: "user_input",
      answers: [{ questionId: "q1", label: "pnpm", value: "pnpm" }],
    });
    expect(result.acknowledged).toBe(true);
    expect(bodies).toEqual([{ answers: [{ id: "q1", label: "pnpm", value: "pnpm" }] }]);
  });

  it("refuses a single-select question answered twice", async () => {
    const inputEvent = {
      schema_version: 2,
      seq: 4,
      previous_seq: 3,
      event: "user_input.required",
      kind: "user_input.required",
      thread_id: THREAD,
      turn_id: TURN,
      timestamp: "2026-11-11T00:00:05.000Z",
      payload: {
        request_id: INPUT,
        questions: [
          {
            id: "q1",
            question: "Which one?",
            options: [{ label: "a" }, { label: "b" }],
            multi_select: false,
          },
        ],
      },
    };
    const harness = await setup({ pending: [inputEvent] });
    await submitOnce(harness);
    await waitFor(
      async () =>
        (await harness.store.listPendingRequests(harness.project.id as ProjectId)).length === 1,
    );
    const [row] = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    await expect(
      harness.studio.answerPending(harness.project.id as ProjectId, row!.id, {
        kind: "user_input",
        answers: [
          { questionId: "q1", label: "a", value: "a" },
          { questionId: "q1", label: "b", value: "b" },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("marks a duplicate capability once, not twice", async () => {
    const harness = await setup({ pending: [approvalEvent(), approvalEvent()] });
    await submitOnce(harness);
    await waitFor(
      async () =>
        (await harness.store.listPendingRequests(harness.project.id as ProjectId)).length === 1,
    );
    const rows = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    expect(rows).toHaveLength(1);
  });

  it("keeps two live capabilities apart", async () => {
    const second = approvalEvent({
      approval_id: APPROVAL_TWO,
      id: APPROVAL_TWO,
      summary: "Write notes/espresso.md",
      tool_name: "write_file",
    });
    (second as { seq: number }).seq = 5;
    (second as { previous_seq: number }).previous_seq = 4;
    const harness = await setup({ pending: [approvalEvent(), second] });
    await submitOnce(harness);
    await waitFor(
      async () =>
        (await harness.store.listPendingRequests(harness.project.id as ProjectId)).length === 2,
    );
    const rows = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    expect(rows.map((row) => row.requestKey).sort()).toEqual([APPROVAL, APPROVAL_TWO].sort());
  });

  it("settles the row on the engine's own decision event", async () => {
    const decided = {
      schema_version: 2,
      seq: 5,
      previous_seq: 4,
      event: "approval.decided",
      kind: "approval.decided",
      thread_id: THREAD,
      turn_id: TURN,
      timestamp: "2026-11-11T00:00:06.000Z",
      payload: { approval_id: APPROVAL, decision: "deny", decided_by: "user" },
    };
    const harness = await setup({ pending: [approvalEvent(), decided] });
    await submitOnce(harness);
    await waitFor(async () => harness.pushes.some((push) => push.state === "input_answered"));
    const rows = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    expect(rows[0]?.status).toBe("answered");
    expect(rows[0]?.decision).toBe("deny");
    expect(rows[0]?.decidedBy).toBe("user");
  });

  it("survives a restart beside an unsent draft and still reconciles", async () => {
    const harness = await setup({ pending: [approvalEvent()] });
    await submitOnce(harness);
    await waitFor(
      async () =>
        (await harness.store.listPendingRequests(harness.project.id as ProjectId)).length === 1,
    );
    const before = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    // A restart is a fresh studio over the same store; the engine still lists
    // the ask, so the row must remain answerable.
    harness.setPending(
      [
        {
          id: APPROVAL,
          turn_id: TURN,
          tool_name: "bash",
          summary: "Run `npm test` in the project root",
          input: { command: "npm test" },
          tool_call_id: "call_1",
        },
      ],
      [],
    );
    await harness.store.putDraft(harness.project.id as ProjectId, "thr_local", "unsent text");
    await harness.studio.start(harness.project.id as ProjectId);
    const after = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.status).toBe("pending");
    expect(await harness.store.getDraft(harness.project.id as ProjectId, "thr_local")).toBe(
      "unsent text",
    );
  });

  it("expires a row the engine no longer lists, with the reason stated", async () => {
    const harness = await setup({ pending: [approvalEvent()] });
    await submitOnce(harness);
    await waitFor(
      async () =>
        (await harness.store.listPendingRequests(harness.project.id as ProjectId)).length === 1,
    );
    harness.setPending([], []);
    await harness.studio.start(harness.project.id as ProjectId);
    const rows = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    expect(rows[0]?.status).toBe("expired");
    expect(rows[0]?.note).toContain("no longer lists");
  });

  it("leaves rows alone when the engine reports no pending list at all", async () => {
    const harness = await setup({ pending: [approvalEvent()], omitPendingLists: true });
    await submitOnce(harness);
    await waitFor(
      async () =>
        (await harness.store.listPendingRequests(harness.project.id as ProjectId)).length === 1,
    );
    await harness.studio.start(harness.project.id as ProjectId);
    const rows = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    expect(rows[0]?.status).toBe("pending");
  });

  it("marks a request whose answer could not be delivered as unknown, never answered", async () => {
    const harness = await setup({
      pending: [approvalEvent()],
      routes: (method, path) => {
        if (method === "POST" && path === `/v1/approvals/${APPROVAL}`) {
          // The transport failing is the interesting case: the write may have
          // landed, so the row must not be reopened for a second attempt.
          throw new Error("socket hang up");
        }
        return null;
      },
    });
    await submitOnce(harness);
    await waitFor(
      async () =>
        (await harness.store.listPendingRequests(harness.project.id as ProjectId)).length === 1,
    );
    const [row] = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    const result = await harness.studio.answerPending(harness.project.id as ProjectId, row!.id, {
      kind: "approval",
      decision: "allow",
      remember: false,
    });
    expect(result.acknowledged).toBe(false);
    expect(result.outcome).toBe("unknown");
    const stored = await harness.store.getPendingRequest(row!.id);
    expect(stored?.status).toBe("unknown");
    expect(stored?.decision).toBe("allow");
    expect(stored?.note).toContain("may not have reached");
    // A second press is refused while the delivery is unknown: the capability
    // is single-use, and a retry could answer twice.
    await expect(
      harness.studio.answerPending(harness.project.id as ProjectId, row!.id, {
        kind: "approval",
        decision: "allow",
        remember: false,
      }),
    ).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });

  it("reopens an unknown row only because the engine still lists it", async () => {
    const harness = await setup({
      pending: [approvalEvent()],
      routes: (method, path) => {
        if (method === "POST" && path === `/v1/approvals/${APPROVAL}`) {
          throw new Error("connection reset");
        }
        return null;
      },
    });
    await submitOnce(harness);
    await waitFor(
      async () =>
        (await harness.store.listPendingRequests(harness.project.id as ProjectId)).length === 1,
    );
    const [row] = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    const first = await harness.studio.answerPending(harness.project.id as ProjectId, row!.id, {
      kind: "approval",
      decision: "allow",
      remember: false,
    });
    expect(first.outcome).toBe("unknown");

    // The harness's engine list still contains the ask, which is exactly the
    // evidence that the reply did not land. Re-reading it reopens the row.
    await harness.studio.start(harness.project.id as ProjectId);
    const reopened = await harness.store.getPendingRequest(row!.id);
    expect(reopened?.status).toBe("pending");
    expect(reopened?.note).toContain("did not land");

    // And once the engine no longer lists it, the same row expires instead.
    harness.setPending([], []);
    await harness.studio.start(harness.project.id as ProjectId);
    const expired = await harness.store.getPendingRequest(row!.id);
    expect(expired?.status).toBe("expired");
  });

  it("reopens a request left mid-answer by a dead process, but never one being sent now", async () => {
    const harness = await setup({ pending: [approvalEvent()] });
    await submitOnce(harness);
    await waitFor(
      async () =>
        (await harness.store.listPendingRequests(harness.project.id as ProjectId)).length === 1,
    );
    const [row] = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    // Simulate a process that died after claiming the capability but before the
    // Runtime acknowledged: the row is stuck in `sending`.
    expect(await harness.store.claimPendingRequest(row!.id)).toBe(true);
    expect((await harness.store.getPendingRequest(row!.id))?.status).toBe("sending");

    // A second studio over the same store is a restart: nothing is in flight in
    // this process, so the engine's listing reopens the row.
    const restarted = new WorkStudio({
      store: harness.store,
      supervisor: fakeSupervisor(),
      work: new WorkController({
        interrupt: async () => ({ confirmed: false, note: "", receipt: null, uncertain: true }),
        stopOwnedRuntime: async () => stopReceipt(),
      }),
      newAdapter: () =>
        new CodewhaleAdapter({
          transport: harness.transport,
          store: new MemorySubmissionStore(),
          workspace: harness.project.canonicalPath,
        }),
      now: () => new Date("2026-11-11T00:00:00.000Z"),
    });
    await restarted.start(harness.project.id as ProjectId);
    const reopened = await harness.store.getPendingRequest(row!.id);
    expect(reopened?.status).toBe("pending");
    expect(reopened?.note).toContain("interrupted before it was acknowledged");
  });

  it("does not reopen a request this process is answering right now", async () => {
    let release: (() => void) | null = null;
    const harness = await setup({
      pending: [approvalEvent()],
      routes: (method, path) => {
        if (method === "POST" && path === `/v1/approvals/${APPROVAL}`) {
          // A promise the test resolves by hand, so the answer is genuinely in
          // flight while the studio re-reads the engine's list.
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          return gate.then(() => jsonResponse(200, { approval_id: APPROVAL }));
        }
        return null;
      },
    });
    await submitOnce(harness);
    await waitFor(
      async () =>
        (await harness.store.listPendingRequests(harness.project.id as ProjectId)).length === 1,
    );
    const [row] = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    const pending = harness.studio.answerPending(harness.project.id as ProjectId, row!.id, {
      kind: "approval",
      decision: "allow",
      remember: false,
    });
    // Let the claim land and the POST start.
    await waitFor(
      async () => (await harness.store.getPendingRequest(row!.id))?.status === "sending",
    );
    await harness.studio.start(harness.project.id as ProjectId);
    // The engine still lists it, but this process holds the claim: reopening it
    // would allow a second delivery for a single-use capability.
    expect((await harness.store.getPendingRequest(row!.id))?.status).toBe("sending");
    expect(release).not.toBeNull();
    release!();
    const result = await pending;
    expect(result.acknowledged).toBe(true);
  });

  it("will not answer a row whose delivery is still in flight", async () => {
    const harness = await setup({ pending: [approvalEvent()] });
    await submitOnce(harness);
    await waitFor(
      async () =>
        (await harness.store.listPendingRequests(harness.project.id as ProjectId)).length === 1,
    );
    const [row] = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    await harness.store.claimPendingRequest(row!.id);
    await expect(
      harness.studio.answerPending(harness.project.id as ProjectId, row!.id, {
        kind: "approval",
        decision: "allow",
        remember: false,
      }),
    ).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    // Nothing was recorded against the user for it.
    const stored = await harness.store.getPendingRequest(row!.id);
    expect(stored?.decision).toBeNull();
  });

  it("expires only the kind the engine actually reported", async () => {
    const inputEvent = {
      schema_version: 2,
      // A distinct per-thread sequence: two frames at the same seq are one row.
      seq: 5,
      previous_seq: 4,
      event: "user_input.required",
      kind: "user_input.required",
      thread_id: THREAD,
      turn_id: TURN,
      timestamp: "2026-11-11T00:00:05.000Z",
      payload: {
        request_id: INPUT,
        questions: [
          { id: "q1", question: "Which one?", options: [{ label: "a" }], multi_select: false },
        ],
      },
    };
    const harness = await setup({
      pending: [approvalEvent(), inputEvent],
      routes: (method, path) => {
        // An engine that reports the approval list and says nothing at all about
        // user input: silence is not an empty list.
        if (
          method === "GET" &&
          path.startsWith(`/v1/threads/${THREAD}`) &&
          !path.includes("turn-operations")
        ) {
          return jsonResponse(200, {
            thread: { id: THREAD, workspace: harness.project.canonicalPath },
            pending_approvals: [],
          });
        }
        return null;
      },
    });
    await submitOnce(harness);
    await waitFor(
      async () =>
        (await harness.store.listPendingRequests(harness.project.id as ProjectId)).length === 2,
    );
    await harness.studio.start(harness.project.id as ProjectId);
    const rows = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    const byKind = Object.fromEntries(rows.map((row) => [row.kind, row.status]));
    expect(byKind.approval).toBe("expired");
    expect(byKind.user_input).toBe("pending");
  });

  it("refuses an answer for a row that is not in this project", async () => {
    const harness = await setup();
    await expect(
      harness.studio.answerPending(harness.project.id as ProjectId, "prq_missing", {
        kind: "approval",
        decision: "allow",
        remember: false,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("never sends a deny when the request was cancelled", async () => {
    const harness = await setup({
      pending: [
        approvalEvent(),
        {
          schema_version: 2,
          seq: 5,
          previous_seq: 4,
          event: "approval.decided",
          kind: "approval.decided",
          thread_id: THREAD,
          turn_id: TURN,
          timestamp: "2026-11-11T00:00:07.000Z",
          payload: { approval_id: APPROVAL, decision: "deny", cancelled: true },
        },
      ],
    });
    await submitOnce(harness);
    await waitFor(async () => harness.pushes.some((push) => push.state === "input_answered"));
    const rows = await harness.store.listPendingRequests(harness.project.id as ProjectId);
    expect(rows[0]?.status).toBe("cancelled");
    expect(rows[0]?.decidedBy).toBeNull();
    expect(rows[0]?.decision).toBeNull();
    expect(rows[0]?.note).toContain("turn ended");
  });
});
