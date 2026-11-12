import { mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectId, TaskId } from "../src/shared/contracts";
import { identifyPath } from "../src/main/state/identity";
import { openTestStore, tempDir } from "./helpers/state";

function makeWorktree(dir: string, repo: string, name: string): string {
  const gitdir = join(repo, ".git", "worktrees", name);
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, "commondir"), "../..\n");
  const worktree = join(dir, name);
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
  return worktree;
}

describe("project catalog", () => {
  it("treats trailing slashes, .., and symlinks as one project", async () => {
    const { store, dir } = await openTestStore();
    const projectDir = join(dir, "project");
    mkdirSync(projectDir);
    const link = join(dir, "project-link");
    symlinkSync(projectDir, link);

    const first = await store.openProject(projectDir);
    expect(first.created).toBe(true);
    const sameSlash = await store.openProject(`${projectDir}/`);
    const sameDots = await store.openProject(join(dir, "other", "..", "project"));
    const sameLink = await store.openProject(link);
    expect(sameSlash.project.id).toBe(first.project.id);
    expect(sameDots.project.id).toBe(first.project.id);
    expect(sameLink.project.id).toBe(first.project.id);
    expect(sameSlash.created).toBe(false);
    expect(await store.listProjects()).toHaveLength(1);
    await store.close();
  });

  it("keeps nested repositories and linked worktrees distinct", async () => {
    const { store, dir } = await openTestStore();
    const repo = join(dir, "main-repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const worktreeA = makeWorktree(dir, repo, "alpha");
    const worktreeB = makeWorktree(dir, repo, "beta");
    const inner = join(repo, "nested");
    mkdirSync(join(inner, ".git"), { recursive: true });

    const a = await store.createProject({ name: "alpha", rootPath: worktreeA });
    const b = await store.createProject({ name: "beta", rootPath: worktreeB });
    expect(a.id).not.toBe(b.id);
    expect(a.repositoryKind).toBe("git_worktree");
    expect(b.repositoryKind).toBe("git_worktree");
    expect(a.repositoryRoot).toBe(realpathSync(repo));
    expect(b.repositoryRoot).toBe(realpathSync(repo));
    expect(a.worktreeName).toBe("alpha");
    expect(b.worktreeName).toBe("beta");

    const nested = await store.createProject({ name: "nested", rootPath: inner });
    expect(nested.repositoryKind).toBe("git");
    expect(nested.repositoryRoot).toBe(realpathSync(inner));

    const outerIdentity = identifyPath(repo);
    expect(outerIdentity.repository.root).toBe(realpathSync(repo));
    await store.close();
  });

  it("rebinds a moved folder deliberately without duplicating the project", async () => {
    const { store, dir } = await openTestStore();
    const original = join(dir, "moved-project");
    mkdirSync(original);
    const project = await store.createProject({ name: "Moved", rootPath: original });

    const moved = join(dir, "moved-project-renamed");
    renameSync(original, moved);
    const relocated = await store.relocateProject(project.id, moved, project.revision);
    expect(relocated.id).toBe(project.id);
    expect(relocated.rootPath).toBe(moved);
    expect(relocated.revision).toBe(project.revision + 1);
    expect(await store.listProjects()).toHaveLength(1);

    const paths = await store.listProjectPaths(project.id);
    expect(paths).toHaveLength(2);
    expect(paths.filter((path) => path.active)).toHaveLength(1);
    expect(paths.find((path) => path.active)?.canonicalPath).toBe(identifyPath(moved).canonical);

    const reopened = await store.openProject(moved);
    expect(reopened.project.id).toBe(project.id);
    expect(reopened.created).toBe(false);
    await expect(store.openProject(original)).rejects.toMatchObject({ code: "INVALID_PATH" });
    await store.close();
  });

  it("supports rename, pin, archive, catalog removal, and revival", async () => {
    const { store, dir } = await openTestStore();
    const folder = join(dir, "kept-folder");
    mkdirSync(folder);
    writeFileSync(join(folder, "source.txt"), "user work\n");
    let project = await store.createProject({ name: "Catalog entry", rootPath: folder });

    project = await store.renameProject(project.id, "Renamed", project.revision);
    project = await store.setProjectPinned(project.id, true, project.revision);
    project = await store.setProjectArchived(project.id, true, project.revision);
    expect(await store.listProjects()).toHaveLength(0);
    expect(await store.listProjects({ includeArchived: true })).toHaveLength(1);
    expect((await store.listProjects({ includeArchived: true }))[0]?.pinned).toBe(true);

    project = await store.removeProjectFromCatalog(project.id, project.revision);
    expect(project.removedAt).not.toBeNull();
    expect(await store.getProject(project.id)).toBeNull();
    expect(await store.getProject(project.id, { includeRemoved: true })).not.toBeNull();
    expect(await store.listProjects({ includeArchived: true })).toHaveLength(0);

    const revived = await store.openProject(folder);
    expect(revived.project.id).toBe(project.id);
    expect(revived.created).toBe(false);
    expect(revived.project.removedAt).toBeNull();
    await store.close();
  });
});

describe("tasks, evidence, and continuity records", () => {
  it("enforces dependencies, revision checks, and project isolation", async () => {
    const { store, dir } = await openTestStore();
    const project = await store.createProject({ name: "Tasks", rootPath: dir });
    const other = await store.createProject({ name: "Other", rootPath: tempDir() });

    const first = await store.createTask({ projectId: project.id, title: "First", prompt: "one" });
    const second = await store.createTask({
      projectId: project.id,
      title: "Second",
      prompt: "two",
      dependsOn: [first.id],
    });
    const third = await store.createTask({
      projectId: project.id,
      title: "Third",
      prompt: "three",
      dependsOn: [second.id],
    });
    await expect(store.addTaskDependency(first.id, third.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(store.addTaskDependency(first.id, first.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    const foreign = await store.createTask({ projectId: other.id, title: "Foreign", prompt: "x" });
    await expect(store.addTaskDependency(first.id, foreign.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    const ready = await store.updateTaskStatus(first.id, "running", first.revision);
    expect(ready.status).toBe("running");
    await expect(
      store.updateTaskStatus(first.id, "completed", first.revision),
    ).rejects.toMatchObject({
      code: "STALE_REVISION",
    });
    expect((await store.listTasks(project.id)).map((task) => task.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
    expect(await store.listDependencies(project.id)).toEqual([
      { taskId: second.id, dependsOnTaskId: first.id },
      { taskId: third.id, dependsOnTaskId: second.id },
    ]);
    await store.close();
  });

  it("records evidence, attempts, and decisions inside the project", async () => {
    const { store, dir } = await openTestStore();
    const project = await store.createProject({ name: "Records", rootPath: dir });
    const task = await store.createTask({ projectId: project.id, title: "Evidence", prompt: "x" });
    const evidence = await store.addRequirementEvidence({
      projectId: project.id,
      taskId: task.id,
      requirementId: "MONA-005",
      path: "docs/evidence/macos/P05-state.md",
      digest: "a".repeat(64),
      note: "schema and recovery",
    });
    expect(evidence.requirementId).toBe("MONA-005");

    const attempt = await store.recordAttempt({
      projectId: project.id,
      taskId: task.id,
      problemId: "P05-CRASH",
      requirement: "MONA-016",
      symptom: "wal not replayed",
      hypothesis: "crash during commit",
      action: "kill mid transaction",
      observed: "row absent, integrity ok",
      materialProgress: true,
      evidence: ["docs/evidence/macos/P05-state.md"],
    });
    expect(attempt.materialProgress).toBe(true);
    expect((await store.listAttempts(project.id, "P05-CRASH"))[0]?.evidence).toEqual([
      "docs/evidence/macos/P05-state.md",
    ]);

    const decision = await store.addDecision({
      projectId: project.id,
      title: "SQLite mechanism",
      body: "node:sqlite from Electron's embedded Node",
    });
    expect(decision.id.startsWith("dec_")).toBe(true);
    expect(await store.listRequirementEvidence(project.id)).toHaveLength(1);
    expect(await store.listDecisions(project.id)).toHaveLength(1);
    await store.close();
  });

  it("deduplicates replay and advances the cursor monotonically", async () => {
    const { store, dir } = await openTestStore();
    const project = await store.createProject({ name: "Events", rootPath: dir });
    const thread = await store.upsertThread({ id: "thr_abcdefgh", projectId: project.id });
    expect(thread.projectId).toBe(project.id);

    const first = await store.recordEvent({
      threadId: thread.id,
      seq: 1,
      kind: "item.delta",
      payload: { delta: "a" },
      timestamp: "2026-11-11T00:00:01.000Z",
    });
    expect(first).toEqual({ recorded: true, cursor: 1 });
    const second = await store.recordEvent({
      threadId: thread.id,
      seq: 2,
      kind: "item.delta",
      payload: { delta: "b" },
      timestamp: "2026-11-11T00:00:02.000Z",
    });
    expect(second).toEqual({ recorded: true, cursor: 2 });
    const duplicate = await store.recordEvent({
      threadId: thread.id,
      seq: 2,
      kind: "item.delta",
      payload: { delta: "b" },
      timestamp: "2026-11-11T00:00:02.000Z",
    });
    expect(duplicate).toEqual({ recorded: false, cursor: 2 });
    const replay = await store.recordEvent({
      threadId: thread.id,
      seq: 1,
      kind: "item.delta",
      payload: { delta: "a" },
      timestamp: "2026-11-11T00:00:01.000Z",
    });
    expect(replay).toEqual({ recorded: false, cursor: 2 });
    expect(await store.getCursor(thread.id)).toBe(2);
    expect((await store.readEvents(thread.id, 1)).map((event) => event.seq)).toEqual([2]);
    await store.close();
  });

  it("keeps drafts, settings, submissions, and bindings per project", async () => {
    const { store, dir } = await openTestStore();
    const project = await store.createProject({ name: "One", rootPath: dir });
    const other = await store.createProject({ name: "Two", rootPath: tempDir() });
    await store.putDraft(project.id, "thr_shared01", "draft one");
    await store.putDraft(other.id, "thr_shared01", "draft two");
    expect(await store.getDraft(project.id, "thr_shared01")).toBe("draft one");
    expect(await store.getDraft(other.id, "thr_shared01")).toBe("draft two");

    await store.putSettings(`view:${project.id}`, { scroll: 10 });
    await store.putSettings(`view:${project.id}`, { scroll: 20 });
    expect((await store.getSettings(`view:${project.id}`))?.version).toBe(2);
    expect(await store.listSettingsVersions(`view:${project.id}`)).toHaveLength(2);

    const submission = {
      operationKey: "op-key-0001",
      threadId: "thr_shared01" as never,
      turnId: null,
      status: "sending" as const,
      submittedAt: "2026-11-11T00:00:00.000Z",
      reconciled: false,
    };
    await store.putSubmission(submission, project.id);
    expect(await store.getSubmission("op-key-0001")).toMatchObject({ status: "sending" });
    await store.putSubmission({ ...submission, status: "accepted", reconciled: true }, project.id);
    expect(await store.getSubmission("op-key-0001")).toMatchObject({
      status: "accepted",
      reconciled: true,
    });

    await store.setRuntimeBinding({
      projectId: project.id,
      workspace: dir,
      canonicalWorkspace: dir,
      executable: "/usr/local/bin/codewhale",
      engineVersion: "0.10.2",
      engineCommit: "ff466b2ed0bf",
      port: 7001,
      state: "running",
      updatedAt: "2026-11-11T00:00:00.000Z",
    });
    expect((await store.getRuntimeBinding(project.id))?.port).toBe(7001);
    expect(await store.getRuntimeBinding(other.id)).toBeNull();
    await store.clearRuntimeBinding(project.id);
    expect(await store.getRuntimeBinding(project.id)).toBeNull();
    await store.close();
  });

  it("never invents a complete cost when usage is unpriced", async () => {
    const { store, dir } = await openTestStore();
    const project = await store.createProject({ name: "Cost", rootPath: dir });
    await store.recordUsage({
      projectId: project.id,
      threadId: null,
      turnId: null,
      provider: "deepseek",
      model: "deepseek-flash",
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: null,
      reasoningTokens: null,
      costUsd: null,
      capturedAt: "2026-11-11T00:00:00.000Z",
    });
    let summary = await store.summarizeUsage(project.id);
    expect(summary.observed).toBe(true);
    expect(summary.costUsd).toBe(0);
    expect(summary.costComplete).toBe(false);

    await store.recordUsage({
      projectId: project.id,
      threadId: null,
      turnId: null,
      provider: "deepseek",
      model: "deepseek-flash",
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
      costComplete: true,
      capturedAt: "2026-11-11T00:00:01.000Z",
    });
    summary = await store.summarizeUsage(project.id);
    expect(summary.turns).toBe(2);
    expect(summary.costComplete).toBe(false);
    expect(summary.inputTokens).toBe(110);
    await store.close();
  });
});

describe("shared branded ids", () => {
  it("accepts only matching prefixes at the contract boundary", async () => {
    const { store, dir } = await openTestStore();
    const project = await store.createProject({ name: "Ids", rootPath: dir });
    const task = await store.createTask({ projectId: project.id, title: "Id", prompt: "x" });
    expect(project.id.startsWith("prj_")).toBe(true);
    expect(task.id.startsWith("tsk_")).toBe(true);
    expect(() => task.id as unknown as ProjectId).not.toThrow();
    expect((task.id as unknown as TaskId).startsWith("tsk_")).toBe(true);
    await store.close();
  });
});
