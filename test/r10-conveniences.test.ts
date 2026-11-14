import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { insertPromptText } from "../src/renderer/shell/composer-text";
import type { ProjectId } from "../src/shared/contracts";
import { CodewhaleAdapter } from "../src/main/engine/adapter";
import { MemorySubmissionStore } from "../src/main/engine/submission-store";
import type { StoredProject } from "../src/main/state/store";
import type { SupervisorStopReceipt } from "../src/main/supervisor/native";
import type { OwnedEndpoint, RuntimeStatus } from "../src/main/supervisor/runtime-supervisor";
import { WorkController } from "../src/main/work/control";
import { WorkStudio, type StudioSupervisor } from "../src/main/work/studio";
import { FixtureTransport, fixture, jsonResponse } from "./helpers/fixture-transport";
import { openTestStore, tempDir } from "./helpers/state";

const COMMIT = "ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e";

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

describe("R10 prompt insertion", () => {
  it("keeps every byte of unsent text, including trailing whitespace", () => {
    const result = insertPromptText("Fix the parser\n  ", "Summarize the diff.");
    expect(result.text).toBe("Fix the parser\n  \n\nSummarize the diff.");
    expect(result.kept).toBe(true);
    expect(result.replacedUnsent).toBe(false);
  });

  it("inserts into an empty composer and reports a whitespace-only draft", () => {
    expect(insertPromptText("", "hello")).toEqual({
      text: "hello",
      kept: false,
      replacedUnsent: false,
    });
    expect(insertPromptText("  \n", "hello")).toEqual({
      text: "hello",
      kept: false,
      replacedUnsent: true,
    });
  });

  it("does not add a blank line when the draft already ends its own", () => {
    expect(insertPromptText("Line one\n", "Line two").text).toBe("Line one\nLine two");
  });
});

describe("R10 conversation search over stored events", () => {
  async function seeded(): Promise<{
    store: Awaited<ReturnType<typeof openTestStore>>["store"];
    projectId: ProjectId;
    threadId: string;
  }> {
    const handle = await openTestStore();
    const folder = join(tempDir("mona-r10-search-"), "Search project");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "README.md"), "# search\n");
    const opened = await handle.store.openProject(folder);
    const thread = await handle.store.upsertThread({
      id: "thr_search",
      projectId: opened.project.id as ProjectId,
      engineThreadId: "thr_engine_search",
      mode: "work",
    });
    const frames: Array<[string, unknown]> = [
      [
        "item.completed",
        { item: { id: "i1", detail: "The parser drops unicode — naïve input 100%" } },
      ],
      ["item.completed", { item: { id: "i2", detail: "Nothing to see in this frame" } }],
      ["item.delta", { kind: "agent_message", delta: "a naive parser again" }],
    ];
    for (const [index, [kind, payload]] of frames.entries()) {
      await handle.store.recordEvent({
        threadId: thread.id,
        seq: index + 1,
        kind,
        payload,
        timestamp: `2026-11-11T00:00:0${index}.000Z`,
        itemId: (payload as { item?: { id?: string } }).item?.id ?? null,
      });
    }
    return { store: handle.store, projectId: opened.project.id as ProjectId, threadId: thread.id };
  }

  it("matches inside stored text and returns an anchor per hit", async () => {
    const { store, projectId } = await seeded();
    const hits = await store.searchProjectEvents({ projectId, query: "naïve" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ seq: 1, itemId: "i1" });
    expect(hits[0]?.snippet).toContain("naïve");
  });

  it("treats % and _ as text, not as wildcards", async () => {
    const { store, projectId } = await seeded();
    const percent = await store.searchProjectEvents({ projectId, query: "100%" });
    expect(percent).toHaveLength(1);
    const wildcardOnly = await store.searchProjectEvents({ projectId, query: "%%%" });
    expect(wildcardOnly).toHaveLength(0);
  });

  it("is bounded and excludes other threads when one is named", async () => {
    const { store, projectId, threadId } = await seeded();
    const bounded = await store.searchProjectEvents({ projectId, query: "parser", limit: 1 });
    expect(bounded).toHaveLength(1);
    const elsewhere = await store.searchProjectEvents({
      projectId,
      query: "parser",
      threadId: "thr_not_here",
    });
    expect(elsewhere).toHaveLength(0);
    const scoped = await store.searchProjectEvents({ projectId, query: "parser", threadId });
    expect(scoped.length).toBeGreaterThan(0);
  });
});

describe("R10 file mention is a verified read, not an upload", () => {
  async function harness(): Promise<{
    studio: WorkStudio;
    project: StoredProject;
    transport: FixtureTransport;
  }> {
    const handle = await openTestStore();
    const folder = join(tempDir("mona-r10-file-"), "File project");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "README.md"), "# file\n");
    const opened = await handle.store.openProject(folder);
    const info = await fixture<Record<string, unknown>>("runtime-info.json");
    const transport = new FixtureTransport((method, path) => {
      if (method === "GET" && path === "/v1/runtime/info") return jsonResponse(200, info);
      if (method === "POST" && path === "/v1/threads")
        return jsonResponse(201, {
          id: "thr_0123456789abcdef",
          workspace: opened.project.canonicalPath,
        });
      if (method === "GET" && path.startsWith("/v1/workspace/files/read")) {
        const query = path.slice(path.indexOf("?"));
        if (query.includes("binary")) {
          // The engine reports binary content as base64; Mona shows that it is
          // binary and refuses to invent text for it.
          return jsonResponse(200, {
            encoding: "base64",
            content: "iVBORw0KGgo=",
            offset: 0,
            size: 2048,
            truncated: false,
          });
        }
        return jsonResponse(200, {
          encoding: "utf-8",
          content: "export const answer = 42;\n",
          offset: 0,
          size: 26,
          revision: "rev-1",
          truncated: false,
        });
      }
      return jsonResponse(404, { error: "fixture route missing" });
    });
    const studio = new WorkStudio({
      store: handle.store,
      supervisor: fakeSupervisor(),
      work: new WorkController({
        interrupt: async () => ({ interrupted: false, turn: null, note: "" }),
        stopOwnedRuntime: async () => stopReceipt(),
      }),
      newAdapter: () =>
        new CodewhaleAdapter({
          transport,
          store: new MemorySubmissionStore(),
          workspace: opened.project.canonicalPath,
        }),
      now: () => new Date("2026-11-11T00:00:00.000Z"),
    });
    return { studio, project: opened.project, transport };
  }

  it("refuses before the engine is started, and says why", async () => {
    const { studio, project } = await harness();
    await expect(studio.previewFile(project.id as ProjectId, "README.md")).rejects.toMatchObject({
      code: "NOT_CONNECTED",
    });
  });

  it("refuses absolute paths and traversal without asking the engine", async () => {
    const { studio, project, transport } = await harness();
    await studio.start(project.id as ProjectId);
    const callsBefore = transport.calls.filter((call) =>
      call.path.includes("workspace/files"),
    ).length;
    await expect(studio.previewFile(project.id as ProjectId, "/etc/passwd")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      studio.previewFile(project.id as ProjectId, "src/../../secret"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(transport.calls.filter((call) => call.path.includes("workspace/files")).length).toBe(
      callsBefore,
    );
  });

  it("reports a text file with its size and a labelled estimate", async () => {
    const { studio, project } = await harness();
    await studio.start(project.id as ProjectId);
    const preview = await studio.previewFile(project.id as ProjectId, "src/answer.ts");
    expect(preview.availability).toBe("available");
    expect(preview.content).toContain("answer = 42");
    expect(preview.sizeBytes).toBe(26);
    expect(preview.estimatedTokens).toBe(Math.ceil(preview.content!.length / 4));
  });

  it("keeps a binary file unavailable instead of inventing text", async () => {
    const { studio, project } = await harness();
    await studio.start(project.id as ProjectId);
    const preview = await studio.previewFile(project.id as ProjectId, "assets/logo.binary");
    expect(preview.availability).toBe("binary");
    expect(preview.content).toBeNull();
    expect(preview.estimatedTokens).toBeNull();
  });
});
