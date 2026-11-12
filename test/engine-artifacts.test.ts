import { describe, expect, it } from "vitest";
import { CodewhaleAdapter } from "../src/main/engine/adapter";
import { AdapterError } from "../src/main/engine/errors";
import { MemorySubmissionStore } from "../src/main/engine/submission-store";
import type { ThreadId, TurnId } from "../src/shared/contracts";
import { FixtureTransport, jsonResponse } from "./helpers/fixture-transport";

const THREAD = "thr_0123456789abcdef" as ThreadId;
const TURN = "turn_0123456789abcdef" as TurnId;

function adapter(handler: ConstructorParameters<typeof FixtureTransport>[0]) {
  const transport = new FixtureTransport(handler);
  return {
    transport,
    adapter: new CodewhaleAdapter({ transport, store: new MemorySubmissionStore() }),
  };
}

describe("turn artifact routes", () => {
  it("parses a settled workspace delta and typed artifact references", async () => {
    const { adapter: engine, transport } = adapter((method, path) => {
      if (method === "GET" && path.includes("/turns/") && path.endsWith("/artifacts")) {
        return jsonResponse(200, {
          thread_id: THREAD,
          turn_id: TURN,
          workspace: {
            state: "settled",
            pre_turn_snapshot_id: "tree_pre",
            post_turn_snapshot_id: "tree_post",
            truncated: true,
            omitted: 3,
          },
          artifacts: [
            {
              id: "file_0123",
              kind: "file",
              path: "src/app.ts",
              change: "updated",
              size: 42,
              revision: "a".repeat(64),
              source: "tool_mutation",
              tool_name: "edit_file",
              tool_call_id: "call_1",
              item_id: "item_1",
              restore_snapshot_id: "tree_pre",
            },
            {
              id: "art_spill",
              kind: "tool_output",
              path: "artifacts/out.txt",
              source: "tool_output_spill",
            },
          ],
        });
      }
      return jsonResponse(404, {});
    });
    const result = await engine.readTurnArtifacts({ threadId: THREAD, turnId: TURN });
    expect(result.workspace).toEqual({
      state: "settled",
      reason: null,
      preSnapshotId: "tree_pre",
      postSnapshotId: "tree_post",
      truncated: true,
      omitted: 3,
    });
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts[0]).toMatchObject({
      id: "file_0123",
      kind: "file",
      path: "src/app.ts",
      change: "updated",
      sizeBytes: 42,
      source: "tool_mutation",
      toolName: "edit_file",
      restoreSnapshotId: "tree_pre",
    });
    expect(transport.calls[0]?.path).toBe(`/v1/threads/${THREAD}/turns/${TURN}/artifacts`);
  });

  it("returns an unavailable delta with its reason rather than inventing files", async () => {
    const { adapter: engine } = adapter(() =>
      jsonResponse(200, {
        thread_id: THREAD,
        turn_id: TURN,
        workspace: { state: "unavailable", reason: "snapshots_disabled" },
        artifacts: [],
      }),
    );
    const result = await engine.readTurnArtifacts({ threadId: THREAD, turnId: TURN });
    expect(result.workspace?.state).toBe("unavailable");
    expect(result.workspace?.reason).toBe("snapshots_disabled");
    expect(result.artifacts).toEqual([]);
  });

  it("marks a binary artifact as binary and never returns its bytes as text", async () => {
    const { adapter: engine } = adapter(() =>
      jsonResponse(200, {
        encoding: "base64",
        content: "AAECAw==",
        offset: 0,
        revision: "b".repeat(64),
        source: "session_artifact",
        current: null,
      }),
    );
    const result = await engine.readTurnArtifact({
      threadId: THREAD,
      turnId: TURN,
      artifactId: "art_1",
    });
    expect(result.availability).toBe("binary");
    expect(result.content).toBeNull();
    expect(result.encoding).toBe("base64");
  });

  it("keeps a deleted or pruned artifact distinct from an empty one", async () => {
    const { adapter: engine } = adapter(() => jsonResponse(410, { message: "pruned" }));
    const result = await engine.readTurnArtifact({
      threadId: THREAD,
      turnId: TURN,
      artifactId: "art_gone",
    });
    expect(result.availability).toBe("missing");
    expect(result.content).toBeNull();
    expect(result.note).toMatch(/deleted|pruned/i);
  });

  it("refuses to serve more than 16 MiB and says so", async () => {
    const { adapter: engine } = adapter(() => jsonResponse(413, {}));
    const result = await engine.readTurnArtifact({
      threadId: THREAD,
      turnId: TURN,
      artifactId: "art_big",
    });
    expect(result.availability).toBe("oversized");
  });

  it("parses a captured call diff and a pending span differently", async () => {
    const captured = adapter(() =>
      jsonResponse(200, {
        state: "captured",
        files: [
          {
            path: "src/app.ts",
            change: "updated",
            added: 2,
            removed: 1,
            size: 12,
            revision: "c".repeat(64),
            restore_snapshot_id: "tree_pre",
            diff: "@@ -1 +1 @@\n-old\n+new\n",
            diff_truncated: false,
          },
        ],
        truncated: false,
      }),
    ).adapter;
    const result = await captured.readCallChanges({
      threadId: THREAD,
      turnId: TURN,
      toolCallId: "call_1",
    });
    expect(result.state).toBe("captured");
    expect(result.files[0]?.diff).toContain("+new");
    expect(result.files[0]?.restoreSnapshotId).toBe("tree_pre");

    const pending = adapter(() => jsonResponse(200, { state: "pending", files: [] })).adapter;
    const stillRunning = await pending.readCallChanges({
      threadId: THREAD,
      turnId: TURN,
      toolCallId: "call_2",
    });
    expect(stillRunning.state).toBe("pending");
    expect(stillRunning.files).toEqual([]);
  });

  it("treats an unknown call as unavailable rather than empty", async () => {
    const { adapter: engine } = adapter(() => jsonResponse(404, {}));
    const result = await engine.readCallChanges({
      threadId: THREAD,
      turnId: TURN,
      toolCallId: "call_missing",
    });
    expect(result.state).toBe("unavailable");
    expect(result.reason).toBe("call_not_found");
  });
});

describe("restore routes", () => {
  it("reverts one file and returns the engine's action", async () => {
    const { adapter: engine, transport } = adapter(() =>
      jsonResponse(200, {
        path: "src/app.ts",
        action: "recreated",
        snapshot_id: "tree_pre",
        snapshot_label: "pre-turn:1",
      }),
    );
    const receipt = await engine.revertFile({
      threadId: THREAD,
      path: "src/app.ts",
      snapshotId: "tree_pre",
      expectedHash: `sha256:${"d".repeat(64)}`,
    });
    expect(receipt.action).toBe("recreated");
    expect(receipt.snapshotId).toBe("tree_pre");
    expect(transport.calls[0]?.body).toMatchObject({
      path: "src/app.ts",
      snapshot_id: "tree_pre",
      expected_hash: `sha256:${"d".repeat(64)}`,
    });
  });

  it("maps a 409 refusal to a restore conflict", async () => {
    const { adapter: engine } = adapter(() =>
      jsonResponse(409, { message: "file changed after the reviewed expected_hash" }),
    );
    await expect(
      engine.revertFile({
        threadId: THREAD,
        path: "src/app.ts",
        snapshotId: "tree_pre",
        expectedHash: "absent",
      }),
    ).rejects.toMatchObject({ code: "RESTORE_CONFLICT" });
  });

  it("maps a missing route to an explicit unavailable error", async () => {
    const { adapter: engine } = adapter(() => jsonResponse(405, {}));
    await expect(
      engine.revertFile({
        threadId: THREAD,
        path: "src/app.ts",
        snapshotId: "tree_pre",
        expectedHash: "absent",
      }),
    ).rejects.toMatchObject({ code: "RESTORE_UNAVAILABLE" });
  });

  it("probes file-revert as available on a non-404 answer and lists snapshots", async () => {
    const { adapter: engine } = adapter((method, path) => {
      if (path.includes("/file-revert")) return jsonResponse(405, {});
      if (path.startsWith("/v1/snapshots")) {
        return jsonResponse(200, [{ id: "snap_1", label: "pre-turn:1", timestamp: 1780730580 }]);
      }
      return jsonResponse(404, {});
    });
    const probe = await engine.probeRestore(THREAD);
    expect(probe.fileRevert).toBe(true);
    expect(probe.snapshots).toBe(true);
    expect(probe.reason).toBeNull();
    const snapshots = await engine.listSnapshots(5);
    expect(snapshots).toEqual([{ id: "snap_1", label: "pre-turn:1", timestamp: 1780730580 }]);
  });

  it("reports an older engine without file-revert", async () => {
    const { adapter: engine } = adapter(() => jsonResponse(404, {}));
    const probe = await engine.probeRestore(THREAD);
    expect(probe.fileRevert).toBe(false);
    expect(probe.reason).toMatch(/newer runtime/i);
  });
});

describe("workspace file routes", () => {
  it("reads a text window with its revision", async () => {
    const { adapter: engine } = adapter(() =>
      jsonResponse(200, {
        path: "src/app.ts",
        size: 12,
        revision: "e".repeat(64),
        offset: 0,
        bytes: 12,
        truncated: false,
        encoding: "utf-8",
        content: "hello world\n",
      }),
    );
    const window = await engine.readWorkspaceFile({ path: "src/app.ts" });
    expect(window.availability).toBe("available");
    expect(window.content).toBe("hello world\n");
    expect(window.revision).toBe("e".repeat(64));
  });

  it("distinguishes missing, forbidden and oversized reads", async () => {
    const missing = adapter(() => jsonResponse(404, {})).adapter;
    expect((await missing.readWorkspaceFile({ path: "nope" })).availability).toBe("missing");
    const forbidden = adapter(() => jsonResponse(403, { message: "symlink" })).adapter;
    expect((await forbidden.readWorkspaceFile({ path: "link" })).availability).toBe("forbidden");
    const big = adapter(() => jsonResponse(413, {})).adapter;
    expect((await big.readWorkspaceFile({ path: "big" })).availability).toBe("oversized");
  });

  it("writes with the expected revision and extracts a 409 conflict revision", async () => {
    const ok = adapter(() =>
      jsonResponse(200, {
        path: "src/app.ts",
        size: 5,
        revision: "f".repeat(64),
        created: false,
        written_at: "2026-11-11T00:00:00.000Z",
      }),
    ).adapter;
    const receipt = await ok.writeWorkspaceFile({
      path: "src/app.ts",
      content: "hello",
      expectedRevision: "e".repeat(64),
    });
    expect(receipt.revision).toBe("f".repeat(64));
    expect(receipt.created).toBe(false);

    const conflict = adapter(() =>
      jsonResponse(409, {
        message: `stale revision; current is ${"9".repeat(64)}`,
      }),
    ).adapter;
    await expect(
      conflict.writeWorkspaceFile({
        path: "src/app.ts",
        content: "hello",
        expectedRevision: "e".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "WRITE_CONFLICT",
      details: { currentRevision: "9".repeat(64) },
    });

    const refused = adapter(() => jsonResponse(403, { message: "into .git" })).adapter;
    await expect(
      refused.writeWorkspaceFile({
        path: ".git/config",
        content: "x",
        expectedRevision: "e".repeat(64),
      }),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});
