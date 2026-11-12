import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectId, TaskId } from "../src/shared/contracts";
import type { TaskPlan } from "../src/shared/contracts/board";
import { TaskBoard, type TaskExecutor } from "../src/main/work/board";
import type { StateStore } from "../src/main/state/store";
import { openTestStore, tempDir } from "./helpers/state";

interface Bench {
  store: StateStore;
  board: TaskBoard;
  projectId: ProjectId;
  root: string;
}

async function bench(): Promise<Bench> {
  const { store } = await openTestStore();
  const root = tempDir("mona-board-project-");
  writeFileSync(join(root, "app.ts"), "export const value = 1;\n", "utf8");
  const project = await store.createProject({ name: "Board project", rootPath: root });
  return {
    store,
    board: new TaskBoard({ store }),
    projectId: project.id as ProjectId,
    root,
  };
}

function plan(tasks: TaskPlan["tasks"]): TaskPlan {
  return { format: "mona-task-plan", format_version: 1, name: "Imported", tasks };
}

async function satisfyAll(
  b: Bench,
  taskId: TaskId,
  options: { file?: string } = {},
): Promise<void> {
  const view = await b.board.taskView(taskId);
  for (const criterion of view.acceptance) {
    const evidence = options.file ?? join(b.root, `evidence-${criterion.id}.txt`);
    writeFileSync(evidence, `check ${criterion.id}\n`, "utf8");
    const current = await b.store.getTask(taskId);
    if (!current) throw new Error("task vanished");
    await b.board.satisfy({
      taskId,
      criterionId: criterion.id,
      expectedRevision: current.revision,
      by: criterion.kind,
      evidencePath: evidence,
    });
  }
}

async function finishTask(b: Bench, taskId: TaskId): Promise<void> {
  await satisfyAll(b, taskId);
  const current = await b.store.getTask(taskId);
  if (!current) throw new Error("task vanished");
  const verifying = await b.board.verify(taskId, current.revision);
  await b.board.complete(taskId, verifying.revision);
}

describe("work board: dependency and ownership rules", () => {
  it("rejects dependency cycles at import and when adding an edge", async () => {
    const b = await bench();
    await expect(
      b.board.importPlan(
        b.projectId,
        plan([
          { key: "a", title: "A", prompt: "do a", dependsOn: ["b"] },
          { key: "b", title: "B", prompt: "do b", dependsOn: ["a"] },
        ]),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await b.store.listTasks(b.projectId)).toHaveLength(0);

    await expect(
      b.board.importPlan(
        b.projectId,
        plan([{ key: "self", title: "Self", prompt: "loop", dependsOn: ["self"] }]),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const first = await b.store.createTask({ projectId: b.projectId, title: "First", prompt: "1" });
    const second = await b.store.createTask({
      projectId: b.projectId,
      title: "Second",
      prompt: "2",
      dependsOn: [first.id],
    });
    await expect(b.store.addTaskDependency(first.id, second.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await b.store.close();
  });

  it("starts only after completed prerequisites, and keeps independent work accurate", async () => {
    const b = await bench();
    const base = await b.store.createTask({
      projectId: b.projectId,
      title: "Base",
      prompt: "base work",
      acceptance: [{ text: "base check passes", kind: "check" }],
    });
    const baseRunning = await b.store.updateTaskStatus(base.id, "running", base.revision);
    expect(baseRunning.status).toBe("running");
    await finishTask(b, base.id);
    expect((await b.store.getTask(base.id))?.status).toBe("completed");

    const blockedDep = await b.store.createTask({
      projectId: b.projectId,
      title: "Interrupted prerequisite",
      prompt: "interrupted work",
      acceptance: [{ text: "done", kind: "check" }],
    });
    const dependent = await b.store.createTask({
      projectId: b.projectId,
      title: "Dependent",
      prompt: "dependent work",
      dependsOn: [blockedDep.id],
    });
    const independent = await b.store.createTask({
      projectId: b.projectId,
      title: "Independent",
      prompt: "independent work",
    });

    // Start and interrupt the prerequisite without completing it.
    const started = await b.store.beginTaskRun({
      taskId: blockedDep.id,
      owner: "mona_queue",
    });
    await b.store.finishTaskRun(started.run.id, "interrupted", "window closed");

    const after = await b.board.selectNext(b.projectId);
    expect(after.taskId).toBe(independent.id);
    expect(after.waiting.map((entry) => entry.taskId)).toContain(dependent.id);
    expect(after.waiting.find((entry) => entry.taskId === dependent.id)?.blocking).toEqual([
      blockedDep.id,
    ]);
    expect((await b.store.getTask(dependent.id))?.status).toBe("pending");
    expect((await b.store.getTask(independent.id))?.status).toBe("pending");
    await b.store.close();
  });

  it("keeps one execution owner per task and one mutating run per workspace", async () => {
    const b = await bench();
    const native = await b.store.createTask({
      projectId: b.projectId,
      title: "Native workflow task",
      prompt: "native work",
      owner: "native_workflow",
    });
    const queued = await b.store.createTask({
      projectId: b.projectId,
      title: "Queued task",
      prompt: "queued work",
    });

    const selection = await b.board.selectNext(b.projectId, "mona_queue");
    expect(selection.taskId).toBe(queued.id);
    expect(selection.waiting.map((entry) => entry.taskId)).toContain(native.id);

    await expect(
      b.store.beginTaskRun({ taskId: native.id, owner: "mona_queue" }),
    ).rejects.toMatchObject({ code: "OWNER_MISMATCH" });

    const started = await b.store.beginTaskRun({ taskId: queued.id, owner: "mona_queue" });
    expect(started.task.status).toBe("running");
    await expect(
      b.store.beginTaskRun({ taskId: native.id, owner: "native_workflow" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await b.store.close();
  });

  it("does not let two workspaces share task ownership", async () => {
    const b = await bench();
    const otherRoot = tempDir("mona-board-other-");
    writeFileSync(join(otherRoot, "index.js"), "module.exports = 1;\n", "utf8");
    const other = await b.store.createProject({ name: "Other project", rootPath: otherRoot });
    const here = await b.store.createTask({
      projectId: b.projectId,
      title: "Here",
      prompt: "here",
    });
    const there = await b.store.createTask({
      projectId: other.id,
      title: "There",
      prompt: "there",
    });
    const hereSelection = await b.board.selectNext(b.projectId);
    const thereSelection = await b.board.selectNext(other.id);
    expect(hereSelection.taskId).toBe(here.id);
    expect(thereSelection.taskId).toBe(there.id);
    expect(hereSelection.eligible).not.toContain(there.id);
    await expect(
      b.store.beginTaskRun({ taskId: here.id, owner: "mona_queue" }),
    ).resolves.toMatchObject({ task: { projectId: b.projectId } });
    await b.store.close();
  });
});

describe("work board: state machine and evidence", () => {
  it("refuses completion without the evidence gate and never completes from a status write", async () => {
    const b = await bench();
    const noCriteria = await b.store.createTask({
      projectId: b.projectId,
      title: "No criteria",
      prompt: "work",
    });
    const running = await b.store.updateTaskStatus(noCriteria.id, "running", noCriteria.revision);
    const verifying = await b.board.verify(noCriteria.id, running.revision);
    await expect(b.board.complete(noCriteria.id, verifying.revision)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    const task = await b.store.createTask({
      projectId: b.projectId,
      title: "Gated",
      prompt: "work",
      requirements: ["MONA-009"],
      acceptance: [
        { text: "tests pass", kind: "check" },
        { text: "a human accepts the wording", kind: "human" },
      ],
    });
    await expect(
      b.store.updateTaskStatus(task.id, "completed", task.revision),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const started = await b.store.updateTaskStatus(task.id, "running", task.revision);
    const criteria = await b.store.listAcceptance(task.id);
    const [checkCriterion, humanCriterion] = criteria;
    if (!checkCriterion || !humanCriterion) throw new Error("criteria missing");

    await expect(
      b.board.satisfy({
        taskId: task.id,
        criterionId: humanCriterion.id,
        expectedRevision: started.revision,
        by: "check",
        evidencePath: join(b.root, "human.txt"),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const ready = await b.board.verify(task.id, started.revision);
    await expect(b.board.complete(task.id, ready.revision)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    await satisfyAll(b, task.id);
    const verified = await b.store.getTask(task.id);
    if (!verified) throw new Error("task vanished");
    // All criteria are satisfied, but MONA-009 has no linked evidence yet.
    await expect(b.board.complete(task.id, verified.revision)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    await b.board.addEvidence({
      projectId: b.projectId,
      taskId: task.id,
      requirementId: "MONA-009",
      path: join(b.root, "tests.txt"),
      note: "acceptance run",
    });
    const final = await b.store.getTask(task.id);
    if (!final) throw new Error("task vanished");
    const completed = await b.board.complete(task.id, final.revision);
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).not.toBeNull();
    const transitions = await b.store.listTaskTransitions(b.projectId);
    expect(transitions.some((entry) => entry.toStatus === "completed")).toBe(true);
    await b.store.close();
  });

  it("reopens completed verification when the workspace changes", async () => {
    const b = await bench();
    const task = await b.store.createTask({
      projectId: b.projectId,
      title: "Verified once",
      prompt: "work",
      acceptance: [{ text: "tests pass", kind: "check" }],
    });
    const running = await b.store.updateTaskStatus(task.id, "running", task.revision);
    await satisfyAll(b, task.id);
    const afterCriteria = await b.store.getTask(task.id);
    if (!afterCriteria) throw new Error("task vanished");
    const verifying = await b.board.verify(task.id, afterCriteria.revision);
    const completed = await b.board.complete(task.id, verifying.revision);
    expect(completed.status).toBe("completed");
    expect(running.status).toBe("running");

    const clean = await b.board.reconcile(b.projectId);
    expect(clean.stale).toHaveLength(0);
    expect(clean.unchanged).toContain(task.id);

    writeFileSync(join(b.root, "app.ts"), "export const value = 2;\n", "utf8");
    const changed = await b.board.reconcile(b.projectId);
    expect(changed.stale.map((entry) => entry.taskId)).toContain(task.id);
    const reopened = await b.board.taskView(task.id);
    expect(reopened.status).toBe("verifying");
    expect(reopened.verificationStale).toBe(true);
    expect(reopened.staleReason).toContain("workspace changed");
    expect(reopened.completedAt).toBeNull();
    await b.store.close();
  });

  it("resumes an interrupted task at its recorded step", async () => {
    const b = await bench();
    const task = await b.store.createTask({
      projectId: b.projectId,
      title: "Multi-step",
      prompt: "work",
      steps: ["edit the parser", "run the focused tests", "record evidence"],
    });
    const started = await b.store.beginTaskRun({ taskId: task.id, owner: "mona_queue" });
    const steps = await b.store.listTaskSteps(task.id);
    const [first, second, third] = steps;
    if (!first || !second || !third) throw new Error("steps missing");
    await b.store.setTaskStepState(task.id, first.id, "completed", join(b.root, "step1.txt"));
    await b.store.setTaskStepState(task.id, second.id, "running");
    await b.store.finishTaskRun(started.run.id, "interrupted", "session ended");

    const interrupted = await b.store.getTask(task.id);
    expect(interrupted?.status).toBe("interrupted");
    expect(interrupted?.nextStep).toBe("run the focused tests");

    const reconcile = await b.board.reconcile(b.projectId, { resume: true });
    expect(reconcile.resumed.map((entry) => entry.taskId)).toContain(task.id);
    expect(reconcile.resumed[0]?.step).toBe("run the focused tests");

    const resumed = await b.store.getTask(task.id);
    expect(resumed?.status).toBe("running");
    expect(resumed?.nextStep).toBe("run the focused tests");
    const audit = await b.store.listTaskTransitions(b.projectId);
    expect(
      audit.some((entry) => entry.fromStatus === "interrupted" && entry.toStatus === "running"),
    ).toBe(true);
    await b.store.close();
  });
});

describe("work board: plans, queue, preview, handoff", () => {
  it("imports inert plans and preserves user-authored criteria across export", async () => {
    const b = await bench();
    const imported = await b.board.importPlan(
      b.projectId,
      plan([
        {
          key: "schema",
          title: "Write the schema",
          prompt: "Create the table",
          requirements: ["MONA-009"],
          acceptance: [
            { text: "migration applies", kind: "check" },
            { text: "Victor accepts the column names", kind: "human" },
          ],
          steps: ["draft", "apply"],
        },
        {
          key: "service",
          title: "Write the service",
          prompt: "Use the schema",
          dependsOn: ["schema"],
        },
      ]),
    );
    expect(imported.inert).toBe(true);
    expect(imported.taskCount).toBe(2);
    const tasks = await b.store.listTasks(b.projectId);
    expect(tasks.every((task) => task.status === "pending")).toBe(true);

    const exported = await b.board.exportPlan(b.projectId);
    const first = exported.tasks.find((entry) => entry.title === "Write the schema");
    expect(first?.acceptance).toEqual([
      { text: "migration applies", kind: "check" },
      { text: "Victor accepts the column names", kind: "human" },
    ]);
    expect(first?.requirements).toEqual(["MONA-009"]);

    const otherRoot = tempDir("mona-board-roundtrip-");
    mkdirSync(otherRoot, { recursive: true });
    const other = await b.store.createProject({ name: "Round trip", rootPath: otherRoot });
    const reimported = await b.board.importPlan(other.id, exported);
    expect(reimported.taskCount).toBe(2);
    const otherBoard = await b.board.snapshot(other.id);
    const schemaTask = otherBoard.tasks.find((entry) => entry.title === "Write the schema");
    expect(schemaTask?.acceptance.map((criterion) => criterion.text)).toEqual([
      "migration applies",
      "Victor accepts the column names",
    ]);
    await b.store.close();
  });

  it("runs exactly one selected prompt and then stops", async () => {
    const b = await bench();
    const first = await b.store.createTask({
      projectId: b.projectId,
      title: "First",
      prompt: "first prompt",
      acceptance: [{ text: "first accepted", kind: "check" }],
    });
    const second = await b.store.createTask({
      projectId: b.projectId,
      title: "Second",
      prompt: "second prompt",
    });
    const calls: string[] = [];
    const executor: TaskExecutor = async (input) => {
      calls.push(input.task.id);
      return { accepted: true, note: "accepted" };
    };
    const run = await b.board.runOnce(b.projectId, executor);
    expect(run.stoppedBecause).toBe("one_prompt_per_assignment");
    expect(run.ran).toEqual([first.id]);
    expect(calls).toEqual([first.id]);
    expect((await b.store.getTask(first.id))?.status).toBe("running");
    expect((await b.store.getTask(second.id))?.status).toBe("pending");

    const again = await b.board.runOnce(b.projectId, executor);
    expect(again.ran).toHaveLength(0);
    expect(again.stoppedBecause).toBe("no_eligible_task");
    expect(calls).toHaveLength(1);
    await b.store.close();
  });

  it("shows exactly what context would be submitted and excludes the design documents", async () => {
    const b = await bench();
    const task = await b.store.createTask({
      projectId: b.projectId,
      title: "Bounded prompt",
      prompt: "Implement the bounded prompt path.",
      requirements: ["MONA-009"],
      acceptance: [{ text: "the preview matches what is sent", kind: "check" }],
    });
    const preview = await b.board.previewContext(task.id);
    expect(preview.text).toContain("Implement the bounded prompt path.");
    expect(preview.text).toContain("Acceptance criteria:");
    expect(preview.text).toContain("Requirements: MONA-009");
    expect(preview.text).not.toContain("Mona_macOS_Project.md");
    expect(preview.text).not.toContain("Mona_macOS_PROMPTS.md");
    expect(preview.bytes).toBe(Buffer.byteLength(preview.text, "utf8"));
    expect(preview.excluded.join(" ")).toContain("Mona_macOS_Project.md");
    await b.store.close();
  });

  it("generates a concise handoff from real state", async () => {
    const b = await bench();
    const task = await b.store.createTask({
      projectId: b.projectId,
      title: "Resume point",
      prompt: "work",
      acceptance: [{ text: "done", kind: "check" }],
      steps: ["step one", "step two"],
    });
    const started = await b.store.beginTaskRun({ taskId: task.id, owner: "mona_queue" });
    const steps = await b.store.listTaskSteps(task.id);
    const firstStep = steps[0];
    if (!firstStep) throw new Error("step missing");
    await b.store.setTaskStepState(task.id, firstStep.id, "completed");
    await b.store.finishTaskRun(started.run.id, "interrupted", "closed");

    const handoff = await b.board.handoff(b.projectId);
    expect(handoff.currentTaskId).toBe(task.id);
    expect(handoff.currentStatus).toBe("interrupted");
    expect(handoff.lastVerifiedStep).toBe("step one");
    expect(handoff.nextExactAction).toContain("Resume");
    expect(handoff.nextExactAction).toContain("step two");
    expect(handoff.openAttempts).toBe(0);
    await b.store.close();
  });
});
