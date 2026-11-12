import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectId } from "../src/shared/contracts/ids";
import { AdapterError } from "../src/main/engine/errors";
import type { EngineAdapter, TurnArtifactRef } from "../src/main/engine/types";
import { ChangeLedger, ChangesError, readLocalWindow } from "../src/main/work/changes";
import { GitService } from "../src/main/work/git";
import { openTestStore, tempDir } from "./helpers/state";

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function ref(overrides: Partial<TurnArtifactRef> & { path: string }): TurnArtifactRef {
  return {
    id: `file_${hash(overrides.path).slice(0, 32)}`,
    kind: "file",
    change: "updated",
    previousPath: null,
    sizeBytes: 10,
    revision: hash("recorded content"),
    contentType: null,
    sessionId: null,
    itemId: "item_1",
    toolCallId: "call_1",
    toolName: "edit_file",
    source: "tool_mutation",
    restoreSnapshotId: "tree_pre_turn",
    recordedAt: "2026-11-11T00:00:00.000Z",
    ...overrides,
  };
}

function fakeEngine(overrides: Record<string, unknown>): EngineAdapter {
  return overrides as unknown as EngineAdapter;
}

async function setup(options: { git?: boolean } = {}) {
  const { store, dir } = await openTestStore();
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  if (options.git) {
    execFileSync("/usr/bin/git", ["init", "-q", "-b", "main"], { cwd: workspace });
    execFileSync("/usr/bin/git", ["config", "user.email", "mona@example.test"], { cwd: workspace });
    execFileSync("/usr/bin/git", ["config", "user.name", "Mona Test"], { cwd: workspace });
    writeFileSync(join(workspace, "README.md"), "base\n", "utf8");
    execFileSync("/usr/bin/git", ["add", "README.md"], { cwd: workspace });
    execFileSync("/usr/bin/git", ["commit", "-qm", "base"], { cwd: workspace });
  }
  const project = await store.createProject({ name: "Changes", rootPath: workspace });
  await store.upsertThread({
    id: "thr_changestest001",
    projectId: project.id,
    engineThreadId: "thr_engine_changes_1",
    title: "Work",
  });
  return { store, dir, workspace, project, projectId: project.id as ProjectId };
}

const ARTIFACTS: TurnArtifactRef[] = [
  ref({ path: "src/app.ts", revision: hash("after turn"), sizeBytes: 10 }),
  ref({
    id: "file_notes",
    path: "notes.txt",
    change: "created",
    source: "workspace_changed_during_turn",
    toolName: null,
    toolCallId: null,
    itemId: null,
    revision: hash("notes"),
  }),
  ref({
    id: "art_spill",
    kind: "tool_output",
    path: "artifacts/out.txt",
    change: "unknown",
    source: "tool_output_spill",
    revision: null,
    restoreSnapshotId: null,
  }),
  ref({
    id: "file_image",
    path: "image.png",
    change: "created",
    source: "tool_mutation",
    toolName: "write_file",
    sizeBytes: 20 * 1024 * 1024,
  }),
];

describe("change capture and attribution", () => {
  it("projects a settled turn with tool, workspace-delta and artifact sources", async () => {
    const { store, project, projectId } = await setup();
    const ledger = new ChangeLedger({ store });
    const adapter = fakeEngine({
      readTurnArtifacts: async () => ({
        turnId: "turn_1",
        workspace: {
          state: "settled",
          reason: null,
          preSnapshotId: "tree_pre_turn",
          postSnapshotId: "tree_post_turn",
          truncated: false,
          omitted: null,
        },
        artifacts: ARTIFACTS,
      }),
    });
    await ledger.captureTurn({
      projectId,
      threadId: "thr_changestest001",
      engineThreadId: "thr_engine_changes_1",
      turnId: "turn_1",
      adapter,
      payload: {},
    });
    const snapshot = await ledger.snapshot(projectId);
    expect(snapshot.sets).toHaveLength(1);
    const set = snapshot.sets[0]!;
    expect(set.state).toBe("settled");
    expect(set.preSnapshotId).toBe("tree_pre_turn");
    expect(set.files.map((file) => file.path)).toEqual([
      "src/app.ts",
      "notes.txt",
      "artifacts/out.txt",
      "image.png",
    ]);
    expect(set.files.find((file) => file.path === "src/app.ts")?.attribution).toBe("tool");
    expect(set.files.find((file) => file.path === "notes.txt")?.attribution).toBe(
      "workspace_delta",
    );
    expect(set.files.find((file) => file.path === "artifacts/out.txt")?.attribution).toBe(
      "artifact",
    );
    expect(set.files.find((file) => file.path === "image.png")?.binaryHint).toBe(true);
    expect(set.files.find((file) => file.path === "image.png")?.oversized).toBe(true);
    expect(project.rootPath).toBeTruthy();
  });

  it("stores a missing delta as unavailable instead of an empty diff", async () => {
    const { store, projectId } = await setup();
    const ledger = new ChangeLedger({ store });
    const adapter = fakeEngine({
      readTurnArtifacts: async () => {
        throw new AdapterError("MALFORMED_RESPONSE", "route missing");
      },
    });
    await ledger.captureTurn({
      projectId,
      threadId: "thr_changestest001",
      engineThreadId: "thr_engine_changes_1",
      turnId: "turn_2",
      adapter,
      payload: {
        workspace: { state: "unavailable", reason: "snapshots_disabled" },
        artifacts: [ref({ path: "src/app.ts", id: "file_app" })],
      },
    });
    const snapshot = await ledger.snapshot(projectId);
    const set = snapshot.sets[0]!;
    expect(set.state).toBe("unavailable");
    expect(set.reason).toBe("snapshots_disabled");
    expect(set.files).toHaveLength(1);
    expect(set.note).toMatch(/snapshots are disabled/i);
    expect(snapshot.notes.join(" ")).toMatch(/not an empty diff/i);
  });

  it("never lets a worse receipt overwrite a settled one", async () => {
    const { store, projectId } = await setup();
    const ledger = new ChangeLedger({ store });
    const adapter = fakeEngine({
      readTurnArtifacts: async () => ({
        turnId: "turn_3",
        workspace: {
          state: "settled",
          reason: null,
          preSnapshotId: "pre",
          postSnapshotId: "post",
          truncated: false,
          omitted: null,
        },
        artifacts: [ref({ path: "src/app.ts" })],
      }),
    });
    await ledger.captureTurn({
      projectId,
      threadId: "thr_changestest001",
      engineThreadId: "thr_engine_changes_1",
      turnId: "turn_3",
      adapter,
      payload: {},
    });
    await ledger.captureTurn({
      projectId,
      threadId: "thr_changestest001",
      engineThreadId: "thr_engine_changes_1",
      turnId: "turn_3",
      adapter: fakeEngine({
        readTurnArtifacts: async () => {
          throw new AdapterError("RUNTIME_UNAVAILABLE", "gone");
        },
      }),
      payload: {},
    });
    const snapshot = await ledger.snapshot(projectId);
    expect(snapshot.sets[0]?.files).toHaveLength(1);
    expect(snapshot.sets[0]?.state).toBe("settled");
  });

  it("never erases a settled receipt's files with an empty captured read", async () => {
    const { store, projectId } = await setup();
    const ledger = new ChangeLedger({ store });
    const adapter = fakeEngine({
      readTurnArtifacts: async () => ({
        turnId: "turn_rank",
        workspace: {
          state: "settled",
          reason: null,
          preSnapshotId: "pre",
          postSnapshotId: "post",
          truncated: false,
          omitted: null,
        },
        artifacts: [ref({ path: "src/app.ts" }), ref({ path: "src/other.ts", id: "file_other" })],
      }),
    });
    await ledger.captureTurn({
      projectId,
      threadId: "thr_changestest001",
      engineThreadId: "thr_engine_changes_1",
      turnId: "turn_rank",
      adapter,
      payload: {},
    });
    // A later read that answers with no workspace and no artifacts is weaker
    // evidence and must not turn the settled delta into "no delta".
    await ledger.captureTurn({
      projectId,
      threadId: "thr_changestest001",
      engineThreadId: "thr_engine_changes_1",
      turnId: "turn_rank",
      adapter: fakeEngine({
        readTurnArtifacts: async () => ({
          turnId: "turn_rank",
          workspace: null,
          artifacts: [],
        }),
      }),
      payload: {},
    });
    const set = (await ledger.snapshot(projectId)).sets[0]!;
    expect(set.state).toBe("settled");
    expect(set.files).toHaveLength(2);
  });

  it("attributes dirty Git paths from receipts and leaves unreceipted work unclaimed", async () => {
    const { store, workspace, projectId } = await setup({ git: true });
    const ledger = new ChangeLedger({ store });
    const adapter = fakeEngine({
      readTurnArtifacts: async () => ({
        turnId: "turn_4",
        workspace: {
          state: "settled",
          reason: null,
          preSnapshotId: "pre",
          postSnapshotId: "post",
          truncated: false,
          omitted: null,
        },
        artifacts: [ref({ path: "README.md" })],
      }),
    });
    await ledger.captureTurn({
      projectId,
      threadId: "thr_changestest001",
      engineThreadId: "thr_engine_changes_1",
      turnId: "turn_4",
      adapter,
      payload: {},
    });
    writeFileSync(join(workspace, "README.md"), "changed by a tool\n", "utf8");
    writeFileSync(join(workspace, "user-edit.txt"), "user\n", "utf8");
    const snapshot = await ledger.snapshot(projectId);
    const entries = new Map(snapshot.git.entries.map((entry) => [entry.path, entry]));
    expect(entries.get("README.md")?.attribution).toBe("tool");
    expect(entries.get("user-edit.txt")?.attribution).toBe("unreceipted");
    expect(snapshot.notes.join(" ")).toMatch(/may be pre-existing/i);
  });
});

describe("restore preview and execution", () => {
  async function restoreSetup() {
    const context = await setup();
    const { store, workspace, projectId } = context;
    const before = "before turn\n";
    const after = "after turn\n";
    writeFileSync(join(workspace, "src-app.ts"), after, "utf8");
    const adapter = fakeEngine({
      probeRestore: async () => ({ fileRevert: true, snapshots: true, reason: null }),
      listSnapshots: async () => [],
      readTurnArtifacts: async () => ({
        turnId: "turn_restore",
        workspace: {
          state: "settled",
          reason: null,
          preSnapshotId: "tree_pre",
          postSnapshotId: "tree_post",
          truncated: false,
          omitted: null,
        },
        artifacts: [
          ref({
            id: "file_app",
            path: "src-app.ts",
            revision: hash(after),
            sizeBytes: after.length,
            restoreSnapshotId: "tree_pre",
          }),
        ],
      }),
    });
    const ledger = new ChangeLedger({
      store,
      engine: () => ({ adapter, workspace }),
    });
    await ledger.captureTurn({
      projectId,
      threadId: "thr_changestest001",
      engineThreadId: "thr_engine_changes_1",
      turnId: "turn_restore",
      adapter,
      payload: {},
    });
    const snapshot = await ledger.snapshot(projectId);
    return { ...context, ledger, adapter, snapshot, before, after, set: snapshot.sets[0]! };
  }

  it("reports a later edit as a conflict and requires acknowledgement", async () => {
    const { workspace, ledger, projectId, set } = await restoreSetup();
    writeFileSync(join(workspace, "src-app.ts"), "later user edit\n", "utf8");
    const preview = await ledger.restorePreview({
      projectId,
      changeSetId: set.id,
      paths: ["src-app.ts"],
    });
    expect(preview.scope).toHaveLength(1);
    expect(preview.conflicts.map((entry) => entry.kind)).toContain("changed_after_turn");
    expect(preview.requiresAcknowledgement).toEqual(["src-app.ts"]);
    await expect(
      ledger.restore({
        projectId,
        changeSetId: set.id,
        paths: ["src-app.ts"],
        expected: preview.scope.map((entry) => ({
          path: entry.path,
          expectedHash: entry.expectedHash,
        })),
        acknowledge: [],
      }),
    ).rejects.toMatchObject({ code: "RESTORE_CONFLICT" });
  });

  it("restores through the engine and records the receipt", async () => {
    const { store, workspace, adapter, projectId, set } = await restoreSetup();
    let reverted = 0;
    const reverting = fakeEngine({
      ...(adapter as unknown as Record<string, unknown>),
      listSnapshots: async () => [{ id: "snap_1", label: "pre-turn:1", timestamp: 1 }],
      revertFile: async () => {
        reverted += 1;
        writeFileSync(join(workspace, "src-app.ts"), "before turn\n", "utf8");
        return {
          path: "src-app.ts",
          action: "modified",
          snapshotId: "tree_pre",
          snapshotLabel: "pre-turn:1",
        };
      },
    });
    const engineLedger = new ChangeLedger({
      store,
      engine: () => ({ adapter: reverting, workspace }),
    });
    const preview = await engineLedger.restorePreview({
      projectId,
      changeSetId: set.id,
      paths: ["src-app.ts"],
    });
    expect(preview.canRestore).toBe(true);
    const result = await engineLedger.restore({
      projectId,
      changeSetId: set.id,
      paths: ["src-app.ts"],
      expected: preview.scope.map((entry) => ({
        path: entry.path,
        expectedHash: entry.expectedHash,
      })),
      acknowledge: [],
    });
    expect(result.ok).toBe(true);
    expect(result.restored[0]?.path).toBe("src-app.ts");
    expect(reverted).toBe(1);
    const stored = await engineLedger.snapshot(projectId);
    expect(stored.restore.available).toBe(true);
  });

  it("refuses a stale preview when a file changes between preview and restore", async () => {
    const { workspace, ledger, projectId, set } = await restoreSetup();
    const preview = await ledger.restorePreview({
      projectId,
      changeSetId: set.id,
      paths: ["src-app.ts"],
    });
    writeFileSync(join(workspace, "src-app.ts"), "changed again\n", "utf8");
    await expect(
      ledger.restore({
        projectId,
        changeSetId: set.id,
        paths: ["src-app.ts"],
        expected: preview.scope.map((entry) => ({
          path: entry.path,
          expectedHash: entry.expectedHash,
        })),
        acknowledge: [],
      }),
    ).rejects.toMatchObject({ code: "STALE_PREVIEW" });
  });

  it("stops on the first refusal and reports only genuinely unattempted files", async () => {
    const { store, workspace, projectId } = await setup();
    const content = "after turn\n";
    writeFileSync(join(workspace, "a.txt"), content, "utf8");
    writeFileSync(join(workspace, "b.txt"), content, "utf8");
    const adapter = fakeEngine({
      probeRestore: async () => ({ fileRevert: true, snapshots: true, reason: null }),
      listSnapshots: async () => [],
      readTurnArtifacts: async () => ({
        turnId: "turn_partial",
        workspace: {
          state: "settled",
          reason: null,
          preSnapshotId: "tree_pre",
          postSnapshotId: "tree_post",
          truncated: false,
          omitted: null,
        },
        artifacts: [
          ref({
            id: "file_a",
            path: "a.txt",
            revision: hash(content),
            sizeBytes: content.length,
            restoreSnapshotId: "tree_pre",
          }),
          ref({
            id: "file_b",
            path: "b.txt",
            revision: hash(content),
            sizeBytes: content.length,
            restoreSnapshotId: "tree_pre",
          }),
        ],
      }),
      revertFile: async ({ path }) => {
        if (path === "a.txt") {
          writeFileSync(join(workspace, path), "before turn\n", "utf8");
          return {
            path,
            action: "modified",
            snapshotId: "tree_pre",
            snapshotLabel: "pre-turn:1",
          };
        }
        throw new AdapterError("RESTORE_REFUSED", "the engine refused b.txt");
      },
    });
    const ledger = new ChangeLedger({
      store,
      engine: () => ({ adapter, workspace }),
    });
    await ledger.captureTurn({
      projectId,
      threadId: "thr_changestest001",
      engineThreadId: "thr_engine_changes_1",
      turnId: "turn_partial",
      adapter,
      payload: {},
    });
    const set = (await ledger.snapshot(projectId)).sets[0]!;
    const preview = await ledger.restorePreview({
      projectId,
      changeSetId: set.id,
      paths: ["a.txt", "b.txt"],
    });
    const result = await ledger.restore({
      projectId,
      changeSetId: set.id,
      paths: ["a.txt", "b.txt"],
      expected: preview.scope.map((entry) => ({
        path: entry.path,
        expectedHash: entry.expectedHash,
      })),
      acknowledge: [],
    });
    expect(result.ok).toBe(false);
    expect(result.restored.map((entry) => entry.path)).toEqual(["a.txt"]);
    expect(result.refused.map((entry) => entry.path)).toEqual(["b.txt"]);
    expect(result.notAttempted).toEqual([]);
  });

  it("explains paths with no restore point and artifacts that are not files", async () => {
    const { store, workspace, projectId } = await setup();
    const ledger = new ChangeLedger({ store });
    const adapter = fakeEngine({
      readTurnArtifacts: async () => ({
        turnId: "turn_mixed",
        workspace: {
          state: "settled",
          reason: null,
          preSnapshotId: null,
          postSnapshotId: null,
          truncated: false,
          omitted: null,
        },
        artifacts: [
          ref({
            path: "no-point.txt",
            restoreSnapshotId: null,
            source: "workspace_changed_during_turn",
          }),
          ref({
            id: "art_only",
            kind: "tool_output",
            path: "artifacts/out.txt",
            source: "tool_output_spill",
            restoreSnapshotId: null,
          }),
        ],
      }),
    });
    await ledger.captureTurn({
      projectId,
      threadId: "thr_changestest001",
      engineThreadId: "thr_engine_changes_1",
      turnId: "turn_mixed",
      adapter,
      payload: {},
    });
    writeFileSync(join(workspace, "no-point.txt"), "x\n", "utf8");
    const set = (await ledger.snapshot(projectId)).sets[0]!;
    const preview = await ledger.restorePreview({
      projectId,
      changeSetId: set.id,
      paths: ["no-point.txt", "artifacts/out.txt"],
    });
    expect(preview.scope).toHaveLength(0);
    expect(preview.exclusions.map((entry) => entry.reason).sort()).toEqual([
      "no_restore_point",
      "not_a_workspace_file",
    ]);
    expect(preview.canRestore).toBe(false);
    const live = new ChangeLedger({
      store,
      engine: () => ({
        adapter: fakeEngine({
          probeRestore: async () => ({ fileRevert: true, snapshots: true, reason: null }),
          listSnapshots: async () => [],
        }),
        workspace,
      }),
    });
    await expect(
      live.restore({
        projectId,
        changeSetId: set.id,
        paths: ["no-point.txt", "artifacts/out.txt"],
        expected: [],
        acknowledge: [],
      }),
    ).rejects.toMatchObject({ code: "RESTORE_UNAVAILABLE" });
  });

  it("requires acknowledgement when the engine recorded no revision for a path", async () => {
    const { store, workspace, projectId } = await setup();
    writeFileSync(join(workspace, "big-blob.bin"), "current bytes\n", "utf8");
    const adapter = fakeEngine({
      probeRestore: async () => ({ fileRevert: true, snapshots: true, reason: null }),
      listSnapshots: async () => [],
      readTurnArtifacts: async () => ({
        turnId: "turn_no_revision",
        workspace: {
          state: "settled",
          reason: null,
          preSnapshotId: "tree_pre",
          postSnapshotId: "tree_post",
          truncated: false,
          omitted: null,
        },
        artifacts: [
          ref({
            id: "file_blob",
            path: "big-blob.bin",
            revision: null,
            sizeBytes: 20 * 1024 * 1024,
            restoreSnapshotId: "tree_pre",
          }),
        ],
      }),
    });
    const ledger = new ChangeLedger({ store, engine: () => ({ adapter, workspace }) });
    await ledger.captureTurn({
      projectId,
      threadId: "thr_changestest001",
      engineThreadId: "thr_engine_changes_1",
      turnId: "turn_no_revision",
      adapter,
      payload: {},
    });
    const set = (await ledger.snapshot(projectId)).sets[0]!;
    const preview = await ledger.restorePreview({
      projectId,
      changeSetId: set.id,
      paths: ["big-blob.bin"],
    });
    expect(preview.scope).toHaveLength(1);
    expect(preview.scope[0]?.recordedRevision).toBeNull();
    expect(preview.conflicts.map((entry) => entry.kind)).toContain("unverifiable_revision");
    expect(preview.requiresAcknowledgement).toEqual(["big-blob.bin"]);
    await expect(
      ledger.restore({
        projectId,
        changeSetId: set.id,
        paths: ["big-blob.bin"],
        expected: preview.scope.map((entry) => ({
          path: entry.path,
          expectedHash: entry.expectedHash,
        })),
        acknowledge: [],
      }),
    ).rejects.toMatchObject({ code: "RESTORE_CONFLICT" });
  });

  it("keeps a deleted path out of the acknowledgement gate when it is still missing", async () => {
    const { store, workspace, projectId } = await setup();
    const adapter = fakeEngine({
      probeRestore: async () => ({ fileRevert: true, snapshots: true, reason: null }),
      listSnapshots: async () => [],
      readTurnArtifacts: async () => ({
        turnId: "turn_deleted",
        workspace: {
          state: "settled",
          reason: null,
          preSnapshotId: "tree_pre",
          postSnapshotId: "tree_post",
          truncated: false,
          omitted: null,
        },
        artifacts: [
          ref({
            id: "file_gone",
            path: "removed.txt",
            change: "deleted",
            revision: null,
            sizeBytes: null,
            restoreSnapshotId: "tree_pre",
          }),
        ],
      }),
    });
    const ledger = new ChangeLedger({ store, engine: () => ({ adapter, workspace }) });
    await ledger.captureTurn({
      projectId,
      threadId: "thr_changestest001",
      engineThreadId: "thr_engine_changes_1",
      turnId: "turn_deleted",
      adapter,
      payload: {},
    });
    const set = (await ledger.snapshot(projectId)).sets[0]!;
    const preview = await ledger.restorePreview({
      projectId,
      changeSetId: set.id,
      paths: ["removed.txt"],
    });
    expect(preview.scope[0]?.action).toBe("recreated");
    expect(preview.conflicts).toEqual([]);
    expect(preview.requiresAcknowledgement).toEqual([]);
  });

  it("is unavailable without a live engine and does not invent a snapshot store", async () => {
    const { store, project, projectId } = await setup();
    const ledger = new ChangeLedger({ store });
    const adapter = fakeEngine({
      readTurnArtifacts: async () => ({
        turnId: "turn_no_engine",
        workspace: {
          state: "settled",
          reason: null,
          preSnapshotId: null,
          postSnapshotId: null,
          truncated: false,
          omitted: null,
        },
        artifacts: [ref({ path: "README.md" })],
      }),
    });
    await ledger.captureTurn({
      projectId,
      threadId: "thr_changestest001",
      engineThreadId: "thr_engine_changes_1",
      turnId: "turn_no_engine",
      adapter,
      payload: {},
    });
    const set = (await ledger.snapshot(projectId)).sets[0]!;
    const preview = await ledger.restorePreview({
      projectId,
      changeSetId: set.id,
      paths: ["README.md"],
    });
    expect(preview.engine.available).toBe(false);
    expect(preview.engine.reason).toMatch(/Start the studio/i);
    expect(preview.recovery.durable).toBe(false);
    expect(project.rootPath).toBeTruthy();
  });
});

describe("file windows and editor writes", () => {
  it("reads a recorded text revision and a captured per-call diff", async () => {
    const { store, workspace, projectId } = await setup();
    const adapter = fakeEngine({
      readTurnArtifacts: async () => ({
        turnId: "turn_window",
        workspace: {
          state: "settled",
          reason: null,
          preSnapshotId: null,
          postSnapshotId: null,
          truncated: false,
          omitted: null,
        },
        artifacts: [ref({ path: "src/app.ts", id: "file_app", toolCallId: "call_1" })],
      }),
      readTurnArtifact: async () => ({
        artifactId: "file_app",
        availability: "available",
        content: "recorded content\n",
        encoding: "utf-8",
        offset: 0,
        totalBytes: 17,
        revision: hash("recorded content"),
        source: "workspace",
        current: true,
        truncated: false,
        note: null,
      }),
      readCallChanges: async () => ({
        state: "captured",
        reason: null,
        files: [
          {
            path: "src/app.ts",
            change: "updated",
            added: 1,
            removed: 1,
            sizeBytes: 17,
            revision: hash("recorded content"),
            restoreSnapshotId: "tree_pre",
            diff: "@@ -1 +1 @@\n-old\n+recorded content\n",
            diffTruncated: false,
          },
        ],
        truncated: false,
        note: null,
      }),
    });
    writeFileSync(join(workspace, "src-app.ts"), "current\n", "utf8");
    const ledger = new ChangeLedger({
      store,
      engine: () => ({ adapter, workspace }),
    });
    await ledger.captureTurn({
      projectId,
      threadId: "thr_changestest001",
      engineThreadId: "thr_engine_changes_1",
      turnId: "turn_window",
      adapter,
      payload: {},
    });
    const set = (await ledger.snapshot(projectId)).sets[0]!;
    const text = await ledger.fileWindow({
      projectId,
      changeSetId: set.id,
      path: "src/app.ts",
      mode: "text",
    });
    expect(text.availability).toBe("available");
    expect(text.content).toContain("recorded content");
    expect(text.canEdit).toBe(true);
    const diff = await ledger.fileWindow({
      projectId,
      changeSetId: set.id,
      path: "src/app.ts",
      mode: "diff",
    });
    expect(diff.availability).toBe("available");
    expect(diff.diff).toContain("+recorded content");
  });

  it("shows a missing snapshot as missing, not as an empty diff", async () => {
    const { store, workspace, projectId } = await setup();
    const adapter = fakeEngine({
      readTurnArtifacts: async () => ({
        turnId: "turn_pending",
        workspace: {
          state: "pending",
          reason: null,
          preSnapshotId: null,
          postSnapshotId: null,
          truncated: false,
          omitted: null,
        },
        artifacts: [ref({ path: "src/app.ts", toolCallId: "call_1" })],
      }),
      readCallChanges: async () => ({
        state: "pending",
        reason: null,
        files: [],
        truncated: false,
        note: null,
      }),
    });
    const ledger = new ChangeLedger({
      store,
      engine: () => ({ adapter, workspace }),
    });
    await ledger.captureTurn({
      projectId,
      threadId: "thr_changestest001",
      engineThreadId: "thr_engine_changes_1",
      turnId: "turn_pending",
      adapter,
      payload: {},
    });
    const set = (await ledger.snapshot(projectId)).sets[0]!;
    const diff = await ledger.fileWindow({
      projectId,
      changeSetId: set.id,
      path: "src/app.ts",
      mode: "diff",
    });
    expect(diff.availability).toBe("unsupported");
    expect(diff.diff).toBeNull();
    expect(diff.note).toMatch(/still computing/i);
  });

  it("refuses editing without a live engine", async () => {
    const { store, projectId } = await setup();
    const ledger = new ChangeLedger({ store });
    await expect(
      ledger.writeFile({
        projectId,
        path: "README.md",
        content: "new",
        expectedRevision: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE" });
  });

  it("maps an engine revision conflict without overwriting", async () => {
    const { store, workspace, projectId } = await setup();
    const adapter = fakeEngine({
      writeWorkspaceFile: async () => {
        throw new AdapterError("WRITE_CONFLICT", "file changed", false, {
          currentRevision: "b".repeat(64),
        });
      },
    });
    const ledger = new ChangeLedger({
      store,
      engine: () => ({ adapter, workspace }),
    });
    await expect(
      ledger.writeFile({
        projectId,
        path: "README.md",
        content: "new",
        expectedRevision: "a".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "WRITE_CONFLICT",
      details: { currentRevision: "b".repeat(64) },
    });
  });

  it("detects NUL bytes in a local preview", () => {
    const root = tempDir("mona-binary-");
    writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    const window = readLocalWindow(root, "blob.bin");
    expect(window.availability).toBe("binary");
    expect(window.content).toBeNull();
  });
});

describe("stage and commit through the ledger", () => {
  it("keeps unrelated staged work and refuses mixed staging without an explicit choice", async () => {
    const { store, workspace, projectId } = await setup({ git: true });
    const git = new GitService();
    const ledger = new ChangeLedger({ store, git });
    writeFileSync(join(workspace, "unrelated.txt"), "staged\n", "utf8");
    execFileSync("/usr/bin/git", ["add", "unrelated.txt"], { cwd: workspace });
    writeFileSync(join(workspace, "selected.txt"), "selected\n", "utf8");
    const result = await ledger.commitPaths({
      projectId,
      message: "selected only",
      paths: ["selected.txt"],
    });
    expect(result.ok).toBe(true);
    expect(result.status.entries.find((entry) => entry.path === "unrelated.txt")?.staged).toBe(
      true,
    );
    const committed = execFileSync("/usr/bin/git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: workspace,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    expect(committed).toEqual(["selected.txt"]);

    // A file with both staged and unstaged content is refused until explicit.
    writeFileSync(join(workspace, "mixed.txt"), "v1\n", "utf8");
    await ledger.stagePaths({ projectId, paths: ["mixed.txt"] });
    writeFileSync(join(workspace, "mixed.txt"), "v2\n", "utf8");
    await expect(
      ledger.commitPaths({ projectId, message: "mixed", paths: ["mixed.txt"] }),
    ).rejects.toBeInstanceOf(ChangesError);
    const forced = await ledger.commitPaths({
      projectId,
      message: "mixed",
      paths: ["mixed.txt"],
      includeUnstaged: true,
    });
    expect(forced.ok).toBe(true);
  });

  it("reports a non-Git folder honestly", async () => {
    const { store, projectId } = await setup();
    const ledger = new ChangeLedger({ store, git: new GitService() });
    const snapshot = await ledger.snapshot(projectId);
    expect(snapshot.git.available).toBe(false);
    await expect(ledger.stagePaths({ projectId, paths: ["README.md"] })).rejects.toMatchObject({
      code: "GIT_UNAVAILABLE",
    });
  });
});
