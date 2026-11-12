import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OpenCoordinator, type OpenedProject } from "../src/main/open/coordinator";
import { ProjectService } from "../src/main/projects/service";
import { openTestStore, tempDir } from "./helpers/state";
import type { RuntimeStatus } from "../src/main/supervisor/runtime-supervisor";

function folder(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return realpathSync.native(path);
}

function fakeProjects(options: { delayMs?: number } = {}) {
  let counter = 0;
  const calls: string[] = [];
  const open = vi.fn(async (rootPath: string): Promise<OpenedProject | null> => {
    calls.push(rootPath);
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    counter += 1;
    return {
      project: {
        id: `prj_${counter}`,
        name: rootPath.split("/").at(-1) ?? "project",
        canonicalPath: rootPath,
        rootPath,
      },
      created: counter === 1,
    };
  });
  return { port: { open }, calls, callsCount: () => open.mock.calls.length };
}

describe("open coordinator", () => {
  it("validates, registers, journals, and never claims to start work", async () => {
    const root = mkdtempSync(join(tmpdir(), "mona-coord-"));
    const target = folder(root, "project");
    const journal = join(root, "journal", "last-open.json");
    const seen: string[] = [];
    const projects = fakeProjects();
    const coordinator = new OpenCoordinator({
      projects: projects.port,
      journalPath: journal,
      onResult: (result) => seen.push(result.code ?? "ok"),
    });

    const result = await coordinator.open(target, "service");
    expect(result.ok).toBe(true);
    expect(result.projectId).toBe("prj_1");
    expect(result.created).toBe(true);
    expect(result.runtimeStarted).toBe(false);
    expect(result.taskCreated).toBe(false);
    expect(projects.calls).toEqual([target]);
    expect(seen).toEqual(["ok"]);

    const written = JSON.parse(readFileSync(journal, "utf8")) as { path: string; ok: boolean };
    expect(written.path).toBe(target);
    expect(written.ok).toBe(true);
    expect(statSync(journal).mode & 0o777).toBe(0o600);
  });

  it("refuses an invalid folder without touching the catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "mona-coord-"));
    const projects = fakeProjects();
    const coordinator = new OpenCoordinator({
      projects: projects.port,
      journalPath: join(root, "journal.json"),
    });

    const result = await coordinator.open(join(root, "missing"), "open_file");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MISSING");
    expect(result.projectId).toBeNull();
    expect(projects.callsCount()).toBe(0);
  });

  it("collapses concurrent opens of the same folder into one registration", async () => {
    const root = mkdtempSync(join(tmpdir(), "mona-coord-"));
    const target = folder(root, "double");
    const projects = fakeProjects({ delayMs: 30 });
    const coordinator = new OpenCoordinator({
      projects: projects.port,
      journalPath: join(root, "journal.json"),
    });

    const [first, second] = await Promise.all([
      coordinator.open(target, "service"),
      coordinator.open(target, "open_file"),
    ]);

    expect(projects.callsCount()).toBe(1);
    expect(first.projectId).toBe(second.projectId);
    expect(second.notes.some((note) => note.includes("deduplicated"))).toBe(true);
  });

  it("survives an unwritable journal and still opens the project", async () => {
    const root = mkdtempSync(join(tmpdir(), "mona-coord-"));
    const target = folder(root, "project");
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory");
    const projects = fakeProjects();
    const coordinator = new OpenCoordinator({
      projects: projects.port,
      journalPath: join(blocker, "nested", "last-open.json"),
    });

    const result = await coordinator.open(target, "drop");
    expect(result.ok).toBe(true);
    expect(result.notes.some((note) => note.startsWith("journal:"))).toBe(true);
  });
});

describe("open coordinator over the real catalog", () => {
  const status: RuntimeStatus = {
    state: "disconnected",
    reason: "no_supervisor",
    since: new Date(0).toISOString(),
    workspace: null,
    ownershipId: null,
    port: null,
    engine: null,
    external: false,
    restarts: 0,
    lastFailure: null,
    pendingRestartInMs: null,
  };

  it("registers once, reuses on the second handoff, and creates no task or thread work", async () => {
    const handle = await openTestStore({ dir: tempDir("mona-open-store-") });
    const projects = new ProjectService({
      store: handle.store,
      status: () => status,
      chooseFolder: async () => null,
      reveal: () => undefined,
      branch: () => null,
    });
    const root = mkdtempSync(join(tmpdir(), "mona-open-project-"));
    const target = folder(root, "Finder project");
    const coordinator = new OpenCoordinator({
      projects: { open: (path) => projects.open(path) },
      journalPath: join(root, "last-open.json"),
    });

    const first = await coordinator.open(target, "open_file");
    const second = await coordinator.open(target, "service");
    const stats = await handle.store.stats();

    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.projectId).toBe(first.projectId);
    expect(stats.projects).toBe(1);
    expect(stats.tasks).toBe(0);

    const tasks = await handle.store.listTasks(first.projectId as never);
    expect(tasks).toEqual([]);
    // Opening creates at most one local thread projection and no engine work.
    const threads = await handle.store.listThreads(first.projectId as never);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.engineThreadId ?? null).toBeNull();

    await handle.store.close();
  });
});
