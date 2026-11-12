import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectId, TaskId } from "../src/shared/contracts";
import { digestOfPayload, type ProjectBundle } from "../src/main/state/portable";
import { openTestStore } from "./helpers/state";

async function seededStore() {
  const { store, dir } = await openTestStore();
  const folder = join(dir, "portable-project");
  mkdirSync(folder);
  const project = await store.createProject({
    name: "Portable",
    rootPath: folder,
    accent: "#6346DF",
    monogram: "PO",
  });
  const thread = await store.upsertThread({
    id: "thr_abcdefgh",
    projectId: project.id,
    engineThreadId: "engine-thread-1",
    title: "Primary",
  });
  const task = await store.createTask({ projectId: project.id, title: "Task", prompt: "Do work" });
  await store.addRequirementEvidence({
    projectId: project.id,
    taskId: task.id,
    requirementId: "MONA-005",
    path: "docs/evidence/macos/P05-state.md",
    digest: "b".repeat(64),
  });
  await store.recordAttempt({
    projectId: project.id,
    taskId: task.id,
    problemId: "P05-1",
    requirement: "MONA-016",
    hypothesis: "h",
    action: "a",
    observed: "o",
    materialProgress: false,
  });
  await store.addDecision({ projectId: project.id, title: "Decision", body: "Body" });
  await store.putDraft(project.id, thread.id, "unsent draft");
  await store.putSettings(`view:${project.id}`, { selectedTask: task.id });
  await store.recordUsage({
    projectId: project.id,
    threadId: thread.id,
    turnId: null,
    provider: "deepseek",
    model: "deepseek-flash",
    inputTokens: 100,
    outputTokens: 10,
    cachedTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.001,
    capturedAt: "2026-11-11T00:00:00.000Z",
  });
  await store.putSubmission(
    {
      operationKey: "op-portable-01",
      threadId: thread.id as never,
      turnId: null,
      status: "accepted",
      submittedAt: "2026-11-11T00:00:00.000Z",
      reconciled: true,
    },
    project.id,
  );
  await store.setRuntimeBinding({
    projectId: project.id,
    workspace: folder,
    canonicalWorkspace: folder,
    executable: "/opt/secret/bin/codewhale",
    engineVersion: "0.10.2",
    engineCommit: "ff466b2ed0bf",
    port: 7002,
    state: "running",
    updatedAt: "2026-11-11T00:00:00.000Z",
  });
  const artifact = await store.putArtifact({
    projectId: project.id,
    taskId: task.id,
    data: Buffer.from("artifact bytes"),
    mediaType: "text/plain",
    source: "test",
    retentionClass: "evidence",
  });
  return { store, dir, project, task, thread, artifact, folder };
}

describe("portable project export", () => {
  it("produces a digest-stable bundle without bindings, secrets, or artifact bytes", async () => {
    const { store, project, task, folder } = await seededStore();
    const bundle = await store.exportProject(project.id);
    expect(bundle.format).toBe("mona-project-export");
    expect(bundle.redacted).toBe(true);
    expect(bundle.project_revision).toBe(project.revision);
    expect(bundle.digest).toBe(digestOfPayload(bundle.payload));
    expect(bundle.payload.tasks.map((entry) => entry.id)).toEqual([task.id]);
    expect(bundle.payload.drafts[0]?.text).toBe("unsent draft");

    const text = JSON.stringify(bundle);
    expect(text).not.toContain("/opt/secret/bin/codewhale");
    expect(text).not.toContain("runtime_bindings");
    expect(text).not.toContain("artifact bytes");
    expect(text).toContain(folder);

    // Stable across calls: same payload, same digest regardless of export time.
    const second = await store.exportProject(project.id);
    expect(second.digest).toBe(bundle.digest);
    await store.close();
  });

  it("imports atomically into a fresh store and preserves counts", async () => {
    const source = await seededStore();
    const bundle = await source.store.exportProject(source.project.id);
    await source.store.close();

    const target = await openTestStore();
    const result = await target.store.importProject(bundle, { rootPath: source.folder });
    expect(result.mode).toBe("create");
    expect(result.project.id).toBe(source.project.id);
    expect(result.project.name).toBe("Portable");
    expect(result.project.accent).toBe("#6346DF");
    expect(result.imported.tasks).toBe(1);
    expect(result.imported.threads).toBe(1);
    expect(result.imported.drafts).toBe(1);
    expect(result.imported.submissions).toBe(1);
    expect(result.missingArtifacts).toEqual([source.artifact.digest]);

    expect((await target.store.listTasks(source.project.id)).map((task) => task.title)).toEqual([
      "Task",
    ]);
    expect(await target.store.getDraft(source.project.id, "thr_abcdefgh")).toBe("unsent draft");
    expect((await target.store.getSettings(`view:${source.project.id}`))?.value).toEqual({
      selectedTask: source.task.id,
    });
    expect((await target.store.getSubmission("op-portable-01"))?.status).toBe("accepted");
    expect(await target.store.getRuntimeBinding(source.project.id)).toBeNull();
    expect(await target.store.listArtifacts(source.project.id)).toHaveLength(0);
    await target.store.close();
  });

  it("rejects a tampered bundle and leaves valid state untouched", async () => {
    const source = await seededStore();
    const bundle = await source.store.exportProject(source.project.id);

    const tampered = structuredClone(bundle) as ProjectBundle;
    tampered.payload.tasks[0]!.title = "Tampered";
    await expect(
      source.store.importProject(tampered, { rootPath: source.folder }),
    ).rejects.toMatchObject({
      code: "IMPORT_DIGEST_MISMATCH",
    });

    const duplicated = structuredClone(bundle) as ProjectBundle;
    duplicated.payload.tasks.push({ ...duplicated.payload.tasks[0]! });
    duplicated.digest = digestOfPayload(duplicated.payload);
    duplicated.project_revision = duplicated.payload.project.revision;
    await expect(
      source.store.importProject(duplicated, { rootPath: source.folder }),
    ).rejects.toMatchObject({ code: "IMPORT_INVALID" });
    expect(await source.store.listTasks(source.project.id)).toHaveLength(1);
    await source.store.close();
  });

  it("requires replace mode and refuses a stale or unexpected revision", async () => {
    const source = await seededStore();
    const bundle = await source.store.exportProject(source.project.id);

    const target = await openTestStore();
    const created = await target.store.importProject(bundle, { rootPath: source.folder });
    const imported = created.project;

    await expect(
      target.store.importProject(bundle, { rootPath: source.folder }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      target.store.importProject(bundle, {
        rootPath: source.folder,
        mode: "replace",
        expectedRevision: imported.revision + 5,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_REVISION_CONFLICT" });

    const replaced = await target.store.importProject(bundle, {
      rootPath: source.folder,
      mode: "replace",
      expectedRevision: imported.revision,
    });
    expect(replaced.mode).toBe("replace");
    expect(replaced.project.revision).toBe(imported.revision + 1);

    // A local edit moves the project past the bundle: importing the old
    // snapshot would roll state back, so it is refused.
    const current = await target.store.getProject(imported.id);
    if (!current) throw new Error("missing project");
    const moved = await target.store.renameProject(imported.id, "Local edit", current.revision);
    await expect(
      target.store.importProject(bundle, {
        rootPath: source.folder,
        mode: "replace",
        expectedRevision: moved.revision,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_REVISION_CONFLICT" });
    expect((await target.store.getProject(imported.id))?.name).toBe("Local edit");
    await target.store.close();
    await source.store.close();
  });

  it("fails closed when the target folder is missing", async () => {
    const source = await seededStore();
    const bundle = await source.store.exportProject(source.project.id);
    const target = await openTestStore();
    await expect(
      target.store.importProject(bundle, { rootPath: "/definitely/not/here" }),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(await target.store.listProjects()).toHaveLength(0);
    await target.store.close();
    await source.store.close();
  });

  it("keeps ids branded and typed through the bundle boundary", async () => {
    const source = await seededStore();
    const bundle = await source.store.exportProject(source.project.id);
    expect(ProjectId.safeParse(bundle.payload.project.id).success).toBe(true);
    expect(TaskId.safeParse(bundle.payload.tasks[0]?.id).success).toBe(true);
    expect(
      ProjectId.safeParse(bundle.payload.tasks[0]?.id).success,
      "a task id must not parse as a project id",
    ).toBe(false);
    await source.store.close();
  });
});
