import { describe, expect, it } from "vitest";
import type { ProjectId } from "../src/shared/contracts";
import type { TaskPlan } from "../src/shared/contracts/board";
import { TaskBoard } from "../src/main/work/board";
import { openTestStore, tempDir } from "./helpers/state";

/**
 * P19 closes the P13 gap "plan export does not carry task status". The status
 * travels for a human reader, and import still starts nothing: a recorded
 * `completed` or `interrupted` state is reported as deferred rather than
 * replayed onto a task that has no evidence on this machine.
 */
async function bench(): Promise<{
  board: TaskBoard;
  store: Awaited<ReturnType<typeof openTestStore>>["store"];
  projectId: ProjectId;
}> {
  const { store } = await openTestStore();
  const root = tempDir("mona-plan-status-");
  const project = await store.createProject({ name: "Plan status", rootPath: root });
  return { board: new TaskBoard({ store }), store, projectId: project.id as ProjectId };
}

function plan(tasks: TaskPlan["tasks"]): TaskPlan {
  return { format: "mona-task-plan", format_version: 1, name: "Carried", tasks };
}

describe("plan status transfer", () => {
  it("exports the real status and imports every task unstarted", async () => {
    const { board, store, projectId } = await bench();
    const first = await store.createTask({
      projectId,
      title: "Finished work",
      prompt: "Do the thing that is already done.",
    });
    // A real recorded state: running, then interrupted, through the state
    // machine rather than a direct write.
    const running = await store.updateTaskStatus(first.id, "running", 1, {
      actor: "mona_queue",
    });
    await store.updateTaskStatus(first.id, "interrupted", running.revision, {
      actor: "mona_queue",
    });

    const exported = await board.exportPlan(projectId);
    expect(exported.tasks.map((task) => task.status)).toEqual(["interrupted"]);

    const imported = await board.importPlan(
      projectId,
      plan([
        { key: "a", title: "Carried as interrupted", prompt: "Do it.", status: "interrupted" },
        { key: "b", title: "Carried as completed", prompt: "It is done.", status: "completed" },
        { key: "c", title: "Plain", prompt: "No status recorded." },
      ]),
    );

    expect(imported.inert).toBe(true);
    // Every imported task starts unstarted: no status was replayed.
    for (const created of imported.created) {
      const task = await store.getTask(created.taskId);
      expect(task?.status).toBe("pending");
      expect(task?.activeTurnId ?? null).toBeNull();
    }
    expect(imported.deferredStatuses.map((entry) => entry.key).sort()).toEqual(["a", "b"]);
    for (const deferred of imported.deferredStatuses) {
      expect(deferred.to).toBe("pending");
      expect(deferred.reason).toContain("evidence");
    }
  });

  it("accepts a bundle that names a status this build does not have as a plain task", async () => {
    const { board, store, projectId } = await bench();
    await expect(
      board.importPlan(
        projectId,
        plan([{ key: "x", title: "Bad status", prompt: "Do it.", status: "nonsense" as never }]),
      ),
    ).rejects.toMatchObject({ code: "IMPORT_INVALID" });
    expect(await store.listTasks(projectId)).toEqual([]);
  });
});
