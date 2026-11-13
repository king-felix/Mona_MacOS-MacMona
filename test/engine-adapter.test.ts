import { describe, expect, it } from "vitest";
import { CodewhaleAdapter } from "../src/main/engine/adapter";
import { AdapterError, UnsupportedCapabilityError } from "../src/main/engine/errors";
import { MemorySubmissionStore } from "../src/main/engine/submission-store";
import type { OperationKey, ThreadId, TurnId } from "../src/shared/contracts";
import {
  chunkText,
  clone,
  fixture,
  FixtureTransport,
  jsonResponse,
  sseFrames,
} from "./helpers/fixture-transport";

const THREAD = "thr_0123456789abcdef" as ThreadId;
const TURN = "turn_0123456789abcdef" as TurnId;
const KEY = "cwc-op-0123456789" as OperationKey;

type Json = Record<string, any>;

async function makeAdapter(
  options: {
    info?: Json;
    thread?: Json;
    events?: unknown[];
    usage?: Json;
    handler?: (
      method: string,
      path: string,
      body: unknown,
    ) => Promise<ReturnType<typeof jsonResponse>> | ReturnType<typeof jsonResponse>;
    stream?: (path: string) => AsyncIterable<string>;
  } = {},
) {
  const info = options.info ?? (await fixture<Json>("runtime-info.json"));
  const thread = options.thread ?? (await fixture<Json>("thread.json"));
  const accepted = await fixture<Json>("turn-accepted.json");
  const events = options.events ?? (await fixture<unknown[]>("events.json"));
  const usage = options.usage ?? (await fixture<Json>("usage.json"));
  const store = new MemorySubmissionStore();
  const handler =
    options.handler ??
    ((method: string, path: string) => {
      if (method === "GET" && path === "/v1/runtime/info") return jsonResponse(200, info);
      if (method === "POST" && path === "/v1/threads") return jsonResponse(201, thread);
      if (method === "POST" && path.endsWith("/turns")) return jsonResponse(201, accepted);
      if (method === "POST" && path.includes("/interrupt"))
        return jsonResponse(200, { interrupted: true, thread_id: THREAD, id: TURN });
      if (method === "GET" && path.startsWith("/v1/threads/") && path.includes("turn-operations"))
        return jsonResponse(200, { ...accepted, status: "completed" });
      if (method === "GET" && path.startsWith("/v1/threads/")) return jsonResponse(200, thread);
      if (method === "GET" && path.startsWith("/v1/usage")) return jsonResponse(200, usage);
      if (method === "GET" && path === "/v1/providers") return jsonResponse(200, []);
      return jsonResponse(404, { error: "fixture route missing" });
    });
  const transport = new FixtureTransport(
    handler,
    options.stream ?? (() => chunkText(sseFrames(events, { end: true }), 5)),
  );
  const adapter = new CodewhaleAdapter({
    transport,
    store,
    now: () => new Date("2026-11-11T00:00:00.000Z"),
  });
  return { adapter, transport, store, info, thread, events, usage };
}

describe("discovery and compatibility", () => {
  it("returns the pinned identity and advertised capabilities", async () => {
    const { adapter } = await makeAdapter();
    const caps = await adapter.discover();
    expect(caps.identity.version).toBe("0.10.2");
    expect(caps.identity.commit).toBe("ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e");
    expect(caps.capabilities.turn_operation_lookup).toBe(true);
  });

  it("rejects an incompatible engine before any mutation", async () => {
    const info = await fixture<Json>("runtime-info.json");
    info.codewhale_version = "0.11.0";
    const { adapter, transport } = await makeAdapter({ info });
    await expect(adapter.discover()).rejects.toMatchObject({ code: "INCOMPATIBLE_ENGINE" });
    expect(transport.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });
});

describe("threads and submissions", () => {
  it("creates a thread with the workspace and explicit execution posture", async () => {
    const { adapter, transport } = await makeAdapter();
    const ref = await adapter.createOrOpenThread({
      workspace: "/Users/example/projects/demo",
      title: "Contract fixture",
      execute: { autoApprove: true, trustMode: true, allowShell: true },
    });
    expect(ref.threadId).toBe(THREAD);
    expect(ref.created).toBe(true);
    const body = transport.calls.find((call) => call.path === "/v1/threads")?.body as Json;
    expect(body.workspace).toBe("/Users/example/projects/demo");
    expect(body.auto_approve).toBe(true);
    expect(body.trust_mode).toBe(true);
    expect(body.allow_shell).toBe(true);
    expect(body.model).toBeUndefined();
  });

  it("persists submission intent before transmission and sends the prompt unchanged", async () => {
    let persistedAtPost = false;
    let sentPrompt: string | null = null;
    let bodyAtPost: Json | null = null;
    const store = new MemorySubmissionStore();
    const info = await fixture<Json>("runtime-info.json");
    const accepted = await fixture<Json>("turn-accepted.json");
    const transport = new FixtureTransport(async (method, path, body) => {
      if (method === "GET" && path === "/v1/runtime/info") return jsonResponse(200, info);
      if (method === "POST" && path.endsWith("/turns")) {
        bodyAtPost = body as Json;
        sentPrompt = (body as Json).prompt;
        persistedAtPost = (await store.get(KEY)) !== null;
        return jsonResponse(201, accepted);
      }
      return jsonResponse(404, {});
    });
    const adapter = new CodewhaleAdapter({ transport, store });
    const receipt = await adapter.submitTurn({
      threadId: THREAD,
      prompt: "Reply with exactly: pong",
      operationKey: KEY,
    });
    expect(persistedAtPost).toBe(true);
    expect(sentPrompt).toBe("Reply with exactly: pong");
    expect(bodyAtPost).not.toHaveProperty("metadata");
    expect(bodyAtPost).not.toHaveProperty("dashboard");
    expect(bodyAtPost).not.toHaveProperty("model");
    expect(receipt.accepted).toBe(true);
    expect(receipt.turnId).toBe(TURN);
  });

  it("marks a lost response outcome-unknown and never retries the write", async () => {
    let lookups = 0;
    const info = await fixture<Json>("runtime-info.json");
    const accepted = await fixture<Json>("turn-accepted.json");
    const transport = new FixtureTransport((method, path) => {
      if (path === "/v1/runtime/info") return jsonResponse(200, info);
      if (method === "POST" && path.endsWith("/turns")) throw new Error("connection reset");
      if (method === "GET" && path.includes("turn-operations")) {
        lookups += 1;
        return jsonResponse(200, { ...accepted, status: "completed" });
      }
      return jsonResponse(404, {});
    });
    const store = new MemorySubmissionStore();
    const adapter = new CodewhaleAdapter({ transport, store });
    const receipt = await adapter.submitTurn({
      threadId: THREAD,
      prompt: "Reply with exactly: pong",
      operationKey: KEY,
    });
    expect(receipt.accepted).toBe(false);
    expect(receipt.outcomeUnknown).toBe(true);
    expect(receipt.guidance).toContain("reconcileSubmission");
    expect(transport.count("POST", "/turns")).toBe(1);
    expect((await store.get(KEY))?.status).toBe("outcome_unknown");

    const reconciled = await adapter.reconcileSubmission({ submission: receipt.submission });
    expect(reconciled.status).toBe("completed");
    expect(reconciled.evidence).toBe("lookup");
    expect(lookups).toBe(1);
    expect(transport.count("POST", "/turns")).toBe(1);
    expect((await store.get(KEY))?.reconciled).toBe(true);
  });

  it("reports an absent operation without resubmitting", async () => {
    const info = await fixture<Json>("runtime-info.json");
    const transport = new FixtureTransport((method, path) => {
      if (path === "/v1/runtime/info") return jsonResponse(200, info);
      if (method === "POST" && path.endsWith("/turns")) throw new Error("socket closed");
      if (method === "GET" && path.includes("turn-operations"))
        return jsonResponse(404, { error: "absent" });
      return jsonResponse(404, {});
    });
    const adapter = new CodewhaleAdapter({ transport, store: new MemorySubmissionStore() });
    const receipt = await adapter.submitTurn({ threadId: THREAD, prompt: "x", operationKey: KEY });
    const result = await adapter.reconcileSubmission({ submission: receipt.submission });
    expect(result.status).toBe("outcome_unknown");
    expect(result.guidance).toContain("will not resubmit");
    expect(transport.count("POST", "/turns")).toBe(1);
  });

  it("rejects a turn response belonging to another thread", async () => {
    const info = await fixture<Json>("runtime-info.json");
    const wrong = {
      ...(await fixture<Json>("turn-accepted.json")),
      thread_id: "thr_fedcba9876543210",
    };
    const store = new MemorySubmissionStore();
    const transport = new FixtureTransport((method, path) => {
      if (path === "/v1/runtime/info") return jsonResponse(200, info);
      if (method === "POST" && path.endsWith("/turns")) return jsonResponse(201, wrong);
      return jsonResponse(404, {});
    });
    const adapter = new CodewhaleAdapter({ transport, store });
    await expect(
      adapter.submitTurn({ threadId: THREAD, prompt: "x", operationKey: KEY }),
    ).rejects.toMatchObject({ code: "WRONG_THREAD" });
    expect((await store.get(KEY))?.status).toBe("outcome_unknown");
  });

  it("rejects history that belongs to another thread", async () => {
    const info = await fixture<Json>("runtime-info.json");
    const thread = { ...(await fixture<Json>("thread.json")), id: "thr_fedcba9876543210" };
    const transport = new FixtureTransport((method, path) => {
      if (path === "/v1/runtime/info") return jsonResponse(200, info);
      if (method === "GET" && path.startsWith("/v1/threads/")) return jsonResponse(200, thread);
      return jsonResponse(404, {});
    });
    const adapter = new CodewhaleAdapter({ transport, store: new MemorySubmissionStore() });
    await expect(adapter.readHistory({ threadId: THREAD })).rejects.toMatchObject({
      code: "WRONG_THREAD",
    });
  });
});

describe("streaming, replay, and projection", () => {
  it("projects deterministic state and reconnecting does not duplicate it", async () => {
    const { adapter } = await makeAdapter();
    const first: unknown[] = [];
    for await (const item of adapter.subscribe({ threadId: THREAD })) first.push(item);
    expect(first.filter((item) => (item as { type: string }).type === "diagnostic")).toHaveLength(
      0,
    );
    const snapshot = adapter.getProjectedState(THREAD);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.lastSeq).toBe(8);
    expect(
      snapshot?.messages.find((message) => message.itemId === "item_aaaaaaaaaaaaaaaa")?.text,
    ).toBe("café pong");
    expect(snapshot?.tools).toHaveLength(1);
    expect(snapshot?.unknownEventKinds).toEqual(["future.event"]);
    expect(snapshot?.permissionPosture).toBe("full_access");

    for await (const _item of adapter.subscribe({ threadId: THREAD, sinceSeq: 0 })) {
      // Replay the same history; the projector must ignore accepted sequences.
    }
    expect(adapter.getProjectedState(THREAD)).toEqual(snapshot);
  });

  it("keeps malformed, drifted, and wrong-thread frames as diagnostics and continues", async () => {
    const good = await fixture<Json[]>("events.json");
    const wrongThread = { ...good[2], seq: 50, thread_id: "thr_fedcba9876543210" };
    const future = { ...good[7], seq: 51 };
    const raw =
      `event: item.delta\ndata: {nope\n\n` +
      `event: item.delta\ndata: {"seq":49}\n\n` +
      sseFrames([wrongThread, future], { end: true });
    const { adapter } = await makeAdapter({ stream: () => chunkText(raw, 9) });
    const diagnostics: string[] = [];
    for await (const item of adapter.subscribe({ threadId: THREAD })) {
      if (item.type === "diagnostic") diagnostics.push(item.reason);
    }
    expect(diagnostics).toContain("malformed_json");
    expect(diagnostics).toContain("schema_drift");
    expect(diagnostics).toContain("wrong_thread");
    expect(adapter.getProjectedState(THREAD)?.unknownEventKinds).toContain("future.event");
  });
});

describe("interrupt, profile, usage, capabilities", () => {
  it("confirms an interrupt only from terminal turn state", async () => {
    const info = await fixture<Json>("runtime-info.json");
    const thread = clone(await fixture<Json>("thread.json"));
    thread.turns[0].status = "interrupted";
    const transport = new FixtureTransport((method, path) => {
      if (path === "/v1/runtime/info") return jsonResponse(200, info);
      if (method === "POST" && path.includes("/interrupt"))
        return jsonResponse(200, { id: TURN, thread_id: THREAD, status: "in_progress" });
      if (method === "GET" && path.startsWith("/v1/threads/")) return jsonResponse(200, thread);
      return jsonResponse(404, {});
    });
    const adapter = new CodewhaleAdapter({ transport, store: new MemorySubmissionStore() });
    const receipt = await adapter.interrupt({ threadId: THREAD, turnId: TURN });
    expect(receipt.interrupted).toBe(true);
    expect(receipt.turn?.status).toBe("interrupted");
  });

  it("refuses interrupt with a typed reason when the runtime cannot interrupt", async () => {
    const info = await fixture<Json>("runtime-info.json");
    info.capabilities.turn_interrupt = false;
    const { adapter } = await makeAdapter({ info });
    await expect(adapter.interrupt({ threadId: THREAD, turnId: TURN })).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
  });

  it("reports requested versus effective route and can fail closed", async () => {
    const { adapter } = await makeAdapter();
    const profile = await adapter.getEffectiveProfile({
      threadId: THREAD,
      requested: {
        provider: "deepseek",
        model: "deepseek-flash",
        permissionPosture: "full_access",
      },
    });
    expect(profile.usedFallback).toBe(false);
    expect(profile.effective.permissionPosture).toBe("full_access");

    const fallbackThread = clone(await fixture<Json>("thread.json"));
    fallbackThread.turns[0].effective_model = "deepseek-v4-pro";
    const fallback = await makeAdapter({ thread: fallbackThread });
    const report = await fallback.adapter.getEffectiveProfile({
      threadId: THREAD,
      requested: {
        provider: "deepseek",
        model: "deepseek-flash",
        permissionPosture: "full_access",
      },
    });
    expect(report.usedFallback).toBe(true);
    await expect(
      fallback.adapter.getEffectiveProfile({
        threadId: THREAD,
        requested: {
          provider: "deepseek",
          model: "deepseek-flash",
          permissionPosture: "full_access",
        },
        strict: true,
      }),
    ).rejects.toMatchObject({ code: "PROFILE_MISMATCH" });
  });

  it("fails closed when Full Access was requested but not effective", async () => {
    const thread = clone(await fixture<Json>("thread.json"));
    thread.turns[0].permission_posture = "ask";
    const { adapter } = await makeAdapter({ thread });
    await expect(
      adapter.getEffectiveProfile({
        threadId: THREAD,
        requested: {
          provider: "deepseek",
          model: "deepseek-flash",
          permissionPosture: "full_access",
        },
        strict: true,
      }),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it("maps usage without inventing a complete cost", async () => {
    const usage = clone(await fixture<Json>("usage.json"));
    usage.totals.cost_complete = false;
    usage.totals.unpriced_turns = 1;
    const { adapter } = await makeAdapter({ usage });
    const report = await adapter.readUsage({ groupBy: "thread" });
    expect(report.totals.costComplete).toBe(false);
    expect(report.totals.inputTokens).toBe(1200);
    expect(report.buckets[0]?.key).toBe(THREAD);
  });

  it("returns a typed unsupported result for an unknown capability", async () => {
    const { adapter } = await makeAdapter();
    await expect(adapter.invokeCapability({ name: "not.real" as never })).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
  });
});

describe("route failure stays on the configured route", () => {
  it("makes one submission attempt and never switches provider or model", async () => {
    const info = await fixture<Json>("runtime-info.json");
    const { adapter, transport } = await makeAdapter({
      handler: (method, path) => {
        if (method === "GET" && path === "/v1/runtime/info") return jsonResponse(200, info);
        if (method === "POST" && path.endsWith("/turns"))
          return jsonResponse(429, { error: { message: "provider rate limited" } });
        if (method === "POST" && path.includes("/switch"))
          return jsonResponse(200, { provider: "deepseek", model: "deepseek-v4-pro" });
        return jsonResponse(200, {});
      },
    });
    const receipt = await adapter.submitTurn({
      threadId: THREAD,
      prompt: "Reply with pong",
      operationKey: KEY,
      requested: {
        provider: "deepseek",
        model: "deepseek-flash",
        reasoningEffort: "low",
      },
    });
    expect(receipt.accepted).toBe(false);
    expect(receipt.outcomeUnknown).toBe(false);
    expect(receipt.submission.note).toContain("429");
    const turnPosts = transport.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/turns"),
    );
    expect(turnPosts).toHaveLength(1);
    expect((turnPosts[0]?.body as Json).model_provider).toBe("deepseek");
    expect((turnPosts[0]?.body as Json).model).toBe("deepseek-flash");
    expect((turnPosts[0]?.body as Json).reasoning_effort).toBe("low");
    expect(transport.calls.filter((call) => call.path.includes("/switch"))).toHaveLength(0);
  });
});

describe("revoked credentials", () => {
  it("fails a submission closed on 401 without retrying or changing the request", async () => {
    const info = await fixture<Json>("runtime-info.json");
    const thread = await fixture<Json>("thread.json");
    const transport = new FixtureTransport((method, path) => {
      if (path === "/v1/runtime/info") return jsonResponse(200, info);
      if (method === "POST" && path === "/v1/threads") return jsonResponse(201, thread);
      if (method === "POST" && path.endsWith("/turns"))
        return jsonResponse(401, { error: "invalid bearer token" });
      return jsonResponse(404, {});
    });
    const store = new MemorySubmissionStore();
    const adapter = new CodewhaleAdapter({ transport, store });

    await expect(
      adapter.submitTurn({
        threadId: THREAD,
        prompt: "Reply with exactly: pong",
        operationKey: KEY,
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });

    // One attempt, no silent retry, and the durable intent records the refusal
    // rather than claiming an accepted turn.
    expect(transport.count("POST", "/turns")).toBe(1);
    expect(transport.count("GET", "/v1/runtime/info")).toBe(1);
    const stored = await store.get(KEY);
    expect(stored?.turnId).toBeNull();
    expect(stored?.status).not.toBe("completed");
  });

  it("treats an unauthenticated event stream as fatal, not as a reconnect loop", async () => {
    const info = await fixture<Json>("runtime-info.json");
    const transport = new FixtureTransport(
      (method, path) => {
        if (path === "/v1/runtime/info") return jsonResponse(200, info);
        return jsonResponse(404, {});
      },
      () => chunkText("", 5),
    );
    transport.streamStatus = 401;
    const adapter = new CodewhaleAdapter({ transport, store: new MemorySubmissionStore() });
    const frames: unknown[] = [];
    await expect(async () => {
      for await (const item of adapter.subscribe({ threadId: THREAD })) frames.push(item);
    }).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(frames).toEqual([]);
  });
});

describe("workspace scoping", () => {
  // The engine's store is shared per user home, so a thread id alone proves
  // nothing. A scoped adapter trusts only threads the engine places in its own
  // workspace.
  const DEMO = "/Users/example/projects/demo";

  it("refuses history for a thread the engine reports in another workspace", async () => {
    const { adapter } = await makeAdapter();
    adapter.scopeToWorkspace("/Users/example/projects/other");
    await expect(adapter.readHistory({ threadId: THREAD })).rejects.toMatchObject({
      code: "WRONG_THREAD",
      details: { expected_workspace: "/Users/example/projects/other", observed_workspace: DEMO },
    });
  });

  it("accepts history for its own workspace and while unscoped", async () => {
    const { adapter } = await makeAdapter();
    adapter.scopeToWorkspace(DEMO);
    const page = await adapter.readHistory({ threadId: THREAD });
    expect(page.workspace).toBe(DEMO);

    const { adapter: unscoped } = await makeAdapter();
    await expect(unscoped.readHistory({ threadId: THREAD })).resolves.toMatchObject({
      threadId: THREAD,
    });
  });

  it("accepts the workspace given to the constructor", async () => {
    const info = await fixture<Json>("runtime-info.json");
    const thread = await fixture<Json>("thread.json");
    const transport = new FixtureTransport(
      (method, path) => {
        if (method === "GET" && path === "/v1/runtime/info") return jsonResponse(200, info);
        if (method === "GET" && path.startsWith("/v1/threads/")) return jsonResponse(200, thread);
        return jsonResponse(404, {});
      },
      () => chunkText("", 5),
    );
    const adapter = new CodewhaleAdapter({
      transport,
      store: new MemorySubmissionStore(),
      workspace: DEMO,
    });
    await expect(adapter.readHistory({ threadId: THREAD })).resolves.toMatchObject({
      workspace: DEMO,
    });
  });

  it("refuses a saved-session resume while a project is attached", async () => {
    const { adapter } = await makeAdapter();
    adapter.scopeToWorkspace(DEMO);
    await expect(
      adapter.invokeCapability({ name: "session.resume", args: { sessionId: "sess-1" } }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it("still resumes when no workspace is attached", async () => {
    const { adapter } = await makeAdapter({
      handler: (method, path) => {
        if (path === "/v1/runtime/info") return jsonResponse(200, {});
        if (method === "POST" && path.includes("/resume-thread"))
          return jsonResponse(200, { thread_id: THREAD, message_count: 2 });
        return jsonResponse(404, {});
      },
    });
    const result = await adapter.invokeCapability({
      name: "session.resume",
      args: { sessionId: "sess-1" },
    });
    expect(result.status).toBe("ok");
  });
});

describe("workspace scoping tolerates equivalent paths", () => {
  it("accepts a symlinked spelling of the same workspace", async () => {
    const { mkdtempSync, symlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const real = mkdtempSync(join(tmpdir(), "mona-scope-real-"));
    const link = join(mkdtempSync(join(tmpdir(), "mona-scope-link-")), "alias");
    symlinkSync(real, link);
    const info = await fixture<Json>("runtime-info.json");
    const thread = await fixture<Json>("thread.json");
    thread.workspace = real;
    const transport = new FixtureTransport(
      (method, path) => {
        if (path === "/v1/runtime/info") return jsonResponse(200, info);
        if (path.startsWith("/v1/threads/")) return jsonResponse(200, thread);
        return jsonResponse(404, {});
      },
      () => chunkText("", 5),
    );
    const adapter = new CodewhaleAdapter({
      transport,
      store: new MemorySubmissionStore(),
      workspace: link,
    });
    await expect(adapter.readHistory({ threadId: THREAD })).resolves.toMatchObject({
      workspace: real,
    });
  });
});
