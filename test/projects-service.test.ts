import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectId } from "../src/shared/contracts";
import { ProjectService, engineSnapshot, readGitBranch } from "../src/main/projects/service";
import type { RuntimeStatus } from "../src/main/supervisor/runtime-supervisor";
import { openTestStore } from "./helpers/state";

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

async function setup(options: { chooseFolder?: () => Promise<string | null> } = {}) {
  const handle = await openTestStore();
  let current = status();
  let chosen: string | null = null;
  const revealed: string[] = [];
  const service = new ProjectService({
    store: handle.store,
    status: () => current,
    chooseFolder: options.chooseFolder ?? (async () => chosen),
    reveal: (path) => revealed.push(path),
  });
  return {
    ...handle,
    service,
    revealed,
    setChosen: (path: string | null) => {
      chosen = path;
    },
    setStatus: (next: RuntimeStatus) => {
      current = next;
    },
  };
}

function makeProjectFolder(dir: string, name = "project"): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "README.md"), "# project\n");
  return path;
}

describe("project catalog service", () => {
  it("registers a folder, survives restart, and keeps source files", async () => {
    const { service, store, dir } = await setup();
    const folder = makeProjectFolder(dir);
    const opened = await service.open(folder);
    expect(opened?.created).toBe(true);
    expect(opened?.project.rootPath).toBe(folder);
    expect(await service.list()).toHaveLength(1);

    await store.close();
    const reopened = await openTestStore({ dbPath: join(dir, "state", "mona.sqlite"), dir });
    const restartedService = new ProjectService({
      store: reopened.store,
      status: () => status(),
      chooseFolder: async () => null,
      reveal: () => undefined,
    });
    const catalog = await restartedService.list();
    expect(catalog.map((project) => project.id)).toEqual([opened?.project.id]);
    await reopened.store.close();
    expect(existsSync(join(folder, "README.md"))).toBe(true);
  });

  it("deduplicates path aliases and reuses the stable project id", async () => {
    const { service, dir } = await setup();
    const folder = makeProjectFolder(dir);
    const link = join(dir, "project-link");
    symlinkSync(folder, link);
    const first = await service.open(folder);
    const alias = await service.open(`${folder}/`);
    const symlink = await service.open(link);
    expect(alias?.created).toBe(false);
    expect(symlink?.created).toBe(false);
    expect(symlink?.project.id).toBe(first?.project.id);
    expect(await service.list()).toHaveLength(1);
  });

  it("archives, restores, removes, and revives without deleting the folder", async () => {
    const { service, dir, store } = await setup();
    const folder = makeProjectFolder(dir);
    const opened = await service.open(folder);
    if (!opened) throw new Error("project did not open");
    const archived = await service.setArchived(
      opened.project.id as ProjectId,
      true,
      opened.project.revision,
    );
    expect(archived.archived).toBe(true);
    expect(await service.list()).toHaveLength(0);
    expect(await service.list({ includeArchived: true })).toHaveLength(1);

    const restored = await service.setArchived(archived.id as ProjectId, false, archived.revision);
    expect(restored.archived).toBe(false);

    const removed = await service.remove(restored.id as ProjectId, restored.revision);
    expect(removed.removedAt).not.toBeNull();
    expect(existsSync(folder)).toBe(true);
    expect(await service.list()).toHaveLength(0);

    const revived = await service.open(folder);
    expect(revived?.project.id).toBe(opened.project.id);
    expect(revived?.created).toBe(false);
    expect(await store.listProjects()).toHaveLength(1);
  });

  it("rebinds a moved folder deliberately", async () => {
    const { service, dir, setChosen } = await setup();
    const folder = makeProjectFolder(dir, "before");
    const opened = await service.open(folder);
    if (!opened) throw new Error("project did not open");
    const moved = join(dir, "after");
    renameSync(folder, moved);
    setChosen(moved);
    const rebound = await service.relocate(opened.project.id as ProjectId, opened.project.revision);
    expect(rebound?.id).toBe(opened.project.id);
    expect(rebound?.rootPath).toBe(moved);
    expect((await service.list()).map((project) => project.id)).toEqual([opened.project.id]);
    const detail = await service.detail(opened.project.id as ProjectId);
    expect(detail.project.rootPath).toBe(moved);
  });

  it("detects Git branches and tolerates non-Git folders", async () => {
    const { service, dir } = await setup();
    const plain = makeProjectFolder(dir, "plain");
    const plainDetail = await (async () => {
      const opened = await service.open(plain);
      if (!opened) throw new Error("project did not open");
      return service.detail(opened.project.id as ProjectId);
    })();
    expect(plainDetail.branch).toBeNull();

    const repo = makeProjectFolder(dir, "repo");
    execFileSync("/usr/bin/git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "file.txt"), "content\n");
    execFileSync("/usr/bin/git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "/usr/bin/git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "initial"],
      { cwd: repo, stdio: "ignore" },
    );
    expect(readGitBranch(repo)).toBe("main");
    const opened = await service.open(repo);
    if (!opened) throw new Error("repo did not open");
    const detail = await service.detail(opened.project.id as ProjectId);
    expect(detail.branch).toBe("main");
  });

  it("keeps drafts, tasks, usage, bindings, and engine state isolated per project", async () => {
    const { service, store, dir, setStatus } = await setup();
    const first = await service.open(makeProjectFolder(dir, "first"));
    const second = await service.open(makeProjectFolder(dir, "second"));
    if (!first || !second) throw new Error("projects did not open");

    const firstDetail = await service.detail(first.project.id as ProjectId);
    const secondDetail = await service.detail(second.project.id as ProjectId);
    expect(firstDetail.threads).toHaveLength(1);
    expect(secondDetail.threads).toHaveLength(1);
    expect(firstDetail.threads[0]?.id).not.toBe(secondDetail.threads[0]?.id);

    await service.saveDraft(
      first.project.id as ProjectId,
      firstDetail.threads[0]!.id,
      "first draft",
    );
    await service.saveDraft(
      second.project.id as ProjectId,
      secondDetail.threads[0]!.id,
      "second draft",
    );
    const reloadedFirst = await service.detail(first.project.id as ProjectId);
    const reloadedSecond = await service.detail(second.project.id as ProjectId);
    expect(reloadedFirst.draft?.text).toBe("first draft");
    expect(reloadedSecond.draft?.text).toBe("second draft");

    await store.createTask({
      projectId: first.project.id as ProjectId,
      title: "First task",
      prompt: "one",
    });
    await store.createTask({
      projectId: second.project.id as ProjectId,
      title: "Second task",
      prompt: "two",
    });
    await store.recordUsage({
      projectId: first.project.id as ProjectId,
      threadId: null,
      turnId: null,
      provider: "deepseek",
      model: "deepseek-flash",
      inputTokens: 10,
      outputTokens: 2,
      cachedTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.01,
      capturedAt: "2026-11-11T00:00:00.000Z",
    });

    const withData = await service.detail(first.project.id as ProjectId);
    expect(withData.tasks.map((task) => task.title)).toEqual(["First task"]);
    expect(withData.usage.turns).toBe(1);
    const secondData = await service.detail(second.project.id as ProjectId);
    expect(secondData.tasks.map((task) => task.title)).toEqual(["Second task"]);
    expect(secondData.usage.turns).toBe(0);

    await store.setRuntimeBinding({
      projectId: first.project.id as ProjectId,
      workspace: first.project.rootPath,
      canonicalWorkspace: first.project.canonicalPath,
      executable: "/opt/homebrew/bin/codewhale",
      engineVersion: "0.10.2",
      engineCommit: "ff466b2ed0bf",
      port: 7001,
      state: "running",
      updatedAt: "2026-11-11T00:00:00.000Z",
    });
    setStatus(
      status({
        state: "running",
        workspace: first.project.canonicalPath,
        port: 7001,
        engine: { version: "0.10.2", commit: "ff466b2ed0bf" },
      }),
    );
    const connected = await service.detail(first.project.id as ProjectId);
    expect(connected.engine.canExecute).toBe(true);
    expect(connected.engine.binding?.port).toBe(7001);
    const other = await service.detail(second.project.id as ProjectId);
    expect(other.engine.canExecute).toBe(false);
    expect(other.engine.blockedReason).toContain("different workspace");
    expect(other.engine.binding).toBeNull();
  });

  it("returns stored offline history without duplicating threads", async () => {
    const { service, store, dir } = await setup();
    const opened = await service.open(makeProjectFolder(dir));
    if (!opened) throw new Error("project did not open");
    const first = await service.detail(opened.project.id as ProjectId);
    const threadId = first.threads[0]!.id;
    await store.recordEvent({
      threadId,
      seq: 1,
      kind: "item.completed",
      payload: { text: "stored offline event" },
      timestamp: "2026-11-11T00:00:00.000Z",
    });
    const second = await service.detail(opened.project.id as ProjectId);
    expect(second.threads).toHaveLength(1);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.payload).toEqual({ text: "stored offline event" });
    const third = await service.detail(opened.project.id as ProjectId);
    expect(third.threads).toHaveLength(1);
  });

  it("does not resume or duplicate work when an existing project is reopened", async () => {
    const { service, store, dir } = await setup();
    const folder = makeProjectFolder(dir);
    const opened = await service.open(folder);
    if (!opened) throw new Error("project did not open");
    const before = await service.detail(opened.project.id as ProjectId);
    const threadId = before.threads[0]!.id;
    const task = await store.createTask({
      projectId: opened.project.id as ProjectId,
      title: "Interrupted task",
      prompt: "do not restart me",
    });
    await store.updateTaskStatus(task.id, "running", task.revision);
    const reopened = await service.open(folder);
    expect(reopened?.created).toBe(false);
    const after = await service.detail(opened.project.id as ProjectId);
    expect(after.threads.map((thread) => thread.id)).toEqual([threadId]);
    expect(after.tasks.map((entry) => entry.status)).toEqual(["running"]);
    expect(after.events).toHaveLength(0);
  });

  it("persists view state per project", async () => {
    const { service, dir } = await setup();
    const opened = await service.open(makeProjectFolder(dir));
    if (!opened) throw new Error("project did not open");
    await service.saveView(opened.project.id as ProjectId, {
      screen: "cost",
      inspectorTab: "context",
    });
    const detail = await service.detail(opened.project.id as ProjectId);
    expect(detail.view).toEqual({ screen: "cost", inspectorTab: "context" });
  });

  it("reports the exact blocked reason and never claims execution", () => {
    const project = {
      id: "prj_aaaaaaaaaaaaaaaa" as ProjectId,
      name: "Mona",
      rootPath: "/tmp/mona",
      canonicalPath: "/private/tmp/mona",
      fsDev: 1,
      fsIno: 2,
      repositoryKind: "none" as const,
      repositoryRoot: null,
      worktreeName: null,
      accent: null,
      monogram: null,
      archived: false,
      pinned: false,
      removedAt: null,
      createdAt: "2026-11-11T00:00:00.000Z",
      updatedAt: "2026-11-11T00:00:00.000Z",
      revision: 1,
    };
    expect(engineSnapshot(status(), null, project).canExecute).toBe(false);
    expect(engineSnapshot(status(), null, project).blockedReason).toContain("No runtime");
    expect(
      engineSnapshot(status({ state: "running", workspace: "/private/tmp/other" }), null, project)
        .blockedReason,
    ).toContain("different workspace");
  });
});
