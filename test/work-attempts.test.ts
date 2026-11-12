import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectId, TaskId } from "../src/shared/contracts";
import { StateStore } from "../src/main/state/store";
import { TaskBoard, type TaskExecutor } from "../src/main/work/board";
import { openTestStore, tempDir } from "./helpers/state";

interface Bench {
  store: StateStore;
  board: TaskBoard;
  projectId: ProjectId;
}

async function bench(): Promise<Bench> {
  const { store } = await openTestStore();
  const root = tempDir("mona-attempt-project-");
  const project = await store.createProject({ name: "Attempt project", rootPath: root });
  return {
    store,
    board: new TaskBoard({ store }),
    projectId: project.id as ProjectId,
  };
}

async function runningTask(b: Bench, title = "Attempted task"): Promise<TaskId> {
  const task = await b.store.createTask({
    projectId: b.projectId,
    title,
    prompt: "work",
    requirements: ["MONA-011"],
    acceptance: [{ text: "the check passes", kind: "check" }],
  });
  await b.board.startTask(task.id);
  return task.id;
}

const noProgress = (taskId: TaskId, symptom = "the same assertion still fails") => ({
  taskId,
  requirement: "MONA-011",
  symptom,
  hypothesis: "the cache key ignores the workspace",
  action: "changed the key to include the canonical path",
  observed: "same failure; the key is still stale",
  materialProgress: false,
});

describe("attempt ledger: counters and the third-attempt block", () => {
  it("counts 1/2/3, blocks at three, and refuses a fourth hidden retry", async () => {
    const b = await bench();
    const taskId = await runningTask(b);

    const first = await b.board.recordAttempt({
      projectId: b.projectId,
      ...noProgress(taskId),
    });
    expect(first.blocked).toBe(false);
    expect(first.problem.status).toBe("open");
    expect(first.problem.totalAttempts).toBe(1);
    expect(first.problem.noProgressAttempts).toBe(1);
    expect(first.task?.status).toBe("running");

    // A changed error string does not create a second problem.
    const second = await b.board.recordAttempt({
      projectId: b.projectId,
      ...noProgress(taskId, "a differently worded error message"),
    });
    expect(second.problem.id).toBe(first.problem.id);
    expect(second.problem.totalAttempts).toBe(2);
    expect(second.problem.noProgressAttempts).toBe(2);

    // Attempt 3 is the consecutive third without material progress.
    const third = await b.board.recordAttempt({
      projectId: b.projectId,
      ...noProgress(taskId),
    });
    expect(third.blocked).toBe(true);
    expect(third.problem.status).toBe("blocked");
    expect(third.problem.totalAttempts).toBe(3);
    expect(third.problem.noProgressAttempts).toBe(3);
    expect(third.problem.helpNeeded).toContain("MONA-011");
    expect(third.task?.status).toBe("blocked");

    const handoff = await b.board.handoff(b.projectId);
    expect(handoff.blockedProblems).toHaveLength(1);
    expect(handoff.blockedProblems[0]?.helpNeeded).toContain("MONA-011");
    expect(handoff.openAttempts).toBe(3);

    // The fourth attempt is refused by the ledger, not by a UI convention.
    await expect(
      b.board.recordAttempt({ projectId: b.projectId, ...noProgress(taskId) }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // And the task cannot be started while the problem is blocked.
    await expect(b.store.beginTaskRun({ taskId, owner: "mona_queue" })).rejects.toMatchObject({
      code: "CONFLICT",
    });

    const problems = await b.store.listProblems(b.projectId);
    expect(problems).toHaveLength(1);
    const events = await b.store.listProblemEvents(b.projectId, problems[0]?.id);
    expect(events.some((event) => event.kind === "blocked")).toBe(true);
    await b.store.close();
  });

  it("resets only the consecutive counter on evidenced material progress", async () => {
    const b = await bench();
    const taskId = await runningTask(b);

    const first = await b.board.recordAttempt({ projectId: b.projectId, ...noProgress(taskId) });
    expect(first.problem.noProgressAttempts).toBe(1);

    await expect(
      b.board.recordAttempt({
        projectId: b.projectId,
        ...noProgress(taskId),
        materialProgress: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const progress = await b.board.recordAttempt({
      projectId: b.projectId,
      ...noProgress(taskId),
      materialProgress: true,
      evidence: ["docs/evidence/attempt-2.txt"],
      reason: "the failing reproduction is narrowed to the cache key",
    });
    expect(progress.blocked).toBe(false);
    expect(progress.problem.totalAttempts).toBe(2);
    expect(progress.problem.noProgressAttempts).toBe(0);

    // Three more consecutive failures are now required to block.
    await b.board.recordAttempt({ projectId: b.projectId, ...noProgress(taskId) });
    await b.board.recordAttempt({ projectId: b.projectId, ...noProgress(taskId) });
    const third = await b.board.recordAttempt({ projectId: b.projectId, ...noProgress(taskId) });
    expect(third.blocked).toBe(true);
    expect(third.problem.totalAttempts).toBe(5);
    expect(third.problem.noProgressAttempts).toBe(3);

    const events = await b.store.listProblemEvents(b.projectId, third.problem.id);
    const reset = events.find((event) => event.kind === "progress_reset");
    expect(reset?.evidence).toEqual(["docs/evidence/attempt-2.txt"]);
    await b.store.close();
  });

  it("retains the count across a new session and refuses the retry there too", async () => {
    const { store, dir } = await openTestStore();
    const root = tempDir("mona-attempt-restart-");
    const project = await store.createProject({ name: "Restart", rootPath: root });
    const board = new TaskBoard({ store });
    const task = await store.createTask({
      projectId: project.id,
      title: "Restart task",
      prompt: "work",
      requirements: ["MONA-011"],
    });
    await board.startTask(task.id);
    for (let index = 0; index < 3; index += 1) {
      await board.recordAttempt({ projectId: project.id, ...noProgress(task.id) });
    }
    await store.close();

    const reopened = await StateStore.open({
      dbPath: join(dir, "state", "mona.sqlite"),
      artifactRoot: join(dir, "artifacts"),
      backupDir: join(dir, "backups"),
    });
    try {
      const problems = await reopened.listProblems(project.id);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({
        status: "blocked",
        totalAttempts: 3,
        noProgressAttempts: 3,
      });
      const next = new TaskBoard({ store: reopened });
      await expect(
        next.recordAttempt({ projectId: project.id, ...noProgress(task.id) }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const handoff = await next.handoff(project.id);
      expect(handoff.blockedProblems).toHaveLength(1);
      const events = await reopened.listProblemEvents(project.id);
      expect(events.filter((event) => event.kind === "blocked")).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  });

  it("does not treat acknowledgement as progress", async () => {
    const b = await bench();
    const taskId = await runningTask(b);
    for (let index = 0; index < 3; index += 1) {
      await b.board.recordAttempt({ projectId: b.projectId, ...noProgress(taskId) });
    }
    const [problem] = await b.store.listProblems(b.projectId);
    if (!problem) throw new Error("problem missing");

    const acknowledged = await b.board.acknowledgeProblem(problem.id, "Victor has seen this");
    expect(acknowledged.problem.status).toBe("blocked");
    expect(acknowledged.problem.totalAttempts).toBe(3);
    expect(acknowledged.problem.noProgressAttempts).toBe(3);
    const events = await b.store.listProblemEvents(b.projectId, problem.id);
    expect(events.some((event) => event.kind === "acknowledged")).toBe(true);
    await expect(
      b.board.recordAttempt({ projectId: b.projectId, ...noProgress(taskId) }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await b.store.close();
  });
});

describe("attempt ledger: blocked propagation and independent work", () => {
  it("keeps dependents waiting while an independent task remains eligible", async () => {
    const b = await bench();
    const blockedId = await runningTask(b, "Blocked prerequisite");
    const dependent = await b.store.createTask({
      projectId: b.projectId,
      title: "Dependent",
      prompt: "depends",
      dependsOn: [blockedId],
    });
    const independent = await b.store.createTask({
      projectId: b.projectId,
      title: "Independent",
      prompt: "independent",
    });
    for (let index = 0; index < 3; index += 1) {
      await b.board.recordAttempt({ projectId: b.projectId, ...noProgress(blockedId) });
    }

    const selection = await b.board.selectNext(b.projectId);
    expect(selection.taskId).toBe(independent.id);
    expect(selection.eligible).not.toContain(blockedId);
    expect(selection.eligible).not.toContain(dependent.id);
    expect(selection.waiting.find((entry) => entry.taskId === dependent.id)?.blocking).toEqual([
      blockedId,
    ]);

    const calls: TaskId[] = [];
    const executor: TaskExecutor = async ({ task }) => {
      calls.push(task.id);
      return { accepted: true, note: "accepted" };
    };
    const run = await b.board.runOnce(b.projectId, executor);
    expect(run.ran).toEqual([independent.id]);
    expect(calls).toEqual([independent.id]);

    await expect(b.board.dispatchNext(b.projectId, executor)).resolves.toMatchObject({
      dispatched: false,
      reason: expect.stringContaining("mutating run"),
    });
    await b.store.close();
  });

  it("blocks a pending task's dispatch without inventing a task transition", async () => {
    const b = await bench();
    const task = await b.store.createTask({
      projectId: b.projectId,
      title: "Pending blocked",
      prompt: "work",
      requirements: ["MONA-011"],
    });
    for (let index = 0; index < 3; index += 1) {
      await b.board.recordAttempt({
        projectId: b.projectId,
        ...noProgress(task.id),
      });
    }
    expect((await b.store.getTask(task.id))?.status).toBe("pending");
    const selection = await b.board.selectNext(b.projectId);
    expect(selection.taskId).toBeNull();
    expect(selection.waiting[0]?.reason).toContain("blocked after three attempts");
    let called = 0;
    const run = await b.board.runOnce(b.projectId, async () => {
      called += 1;
      return { accepted: true };
    });
    expect(run.ran).toEqual([]);
    expect(called).toBe(0);
    await b.store.close();
  });
});

describe("attempt ledger: human resolution and new evidence", () => {
  it("reopens only with evidence and audits the reset, then resumes the task", async () => {
    const b = await bench();
    const taskId = await runningTask(b);
    for (let index = 0; index < 3; index += 1) {
      await b.board.recordAttempt({ projectId: b.projectId, ...noProgress(taskId) });
    }
    const [problem] = await b.store.listProblems(b.projectId);
    if (!problem) throw new Error("problem missing");

    await expect(
      b.board.reopenProblem(problem.id, { reason: "new test", evidence: [] }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const reopened = await b.board.reopenProblem(problem.id, {
      reason: "the failing reproduction is narrowed to one function",
      evidence: ["docs/evidence/new-proof.md"],
    });
    expect(reopened.problem.status).toBe("open");
    expect(reopened.problem.totalAttempts).toBe(3);
    expect(reopened.problem.noProgressAttempts).toBe(0);

    const resumed = await b.board.resumeTask(taskId);
    expect(resumed.task.status).toBe("running");
    const events = await b.store.listProblemEvents(b.projectId, problem.id);
    expect(events.some((event) => event.kind === "reopened")).toBe(true);

    // Block again, then end the problem with a human decision.
    for (let index = 0; index < 3; index += 1) {
      await b.board.recordAttempt({ projectId: b.projectId, ...noProgress(taskId) });
    }
    const resolved = await b.board.resolveProblem(problem.id, {
      resolution: "Victor decided to defer this requirement to a later prompt",
    });
    expect(resolved.problem.status).toBe("resolved");
    expect(resolved.problem.totalAttempts).toBe(6);
    const after = await b.board.resumeTask(taskId);
    expect(after.task.status).toBe("running");

    const audit = await b.store.listProblemEvents(b.projectId, problem.id);
    expect(audit.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["created", "attempt", "blocked", "reopened", "resolved"]),
    );
    await b.store.close();
  });

  it("refuses a fourth attempt after a resolution unless the problem reopens", async () => {
    const b = await bench();
    const taskId = await runningTask(b);
    for (let index = 0; index < 3; index += 1) {
      await b.board.recordAttempt({ projectId: b.projectId, ...noProgress(taskId) });
    }
    const [problem] = await b.store.listProblems(b.projectId);
    if (!problem) throw new Error("problem missing");
    await b.board.resolveProblem(problem.id, { resolution: "closed by a human decision" });

    const next = await b.board.recordAttempt({
      projectId: b.projectId,
      ...noProgress(taskId, "a new recurrence of the same symptom"),
    });
    expect(next.problem.id).not.toBe(problem.id);
    expect(next.problem.status).toBe("open");
    expect(next.problem.totalAttempts).toBe(1);
    await b.store.close();
  });
});

describe("attempt ledger: control boundaries", () => {
  it("never dispatches while the Mona queue is paused", async () => {
    const b = await bench();
    await b.store.createTask({ projectId: b.projectId, title: "Ready", prompt: "work" });
    let called = 0;
    const executor: TaskExecutor = async () => {
      called += 1;
      return { accepted: true };
    };
    const run = await b.board.runOnce(b.projectId, executor, { shouldPause: () => true });
    expect(run).toEqual({ ran: [], stoppedBecause: "paused", dispatches: [] });
    const dispatch = await b.board.dispatchNext(b.projectId, executor, {
      shouldPause: () => true,
    });
    expect(dispatch.dispatched).toBe(false);
    expect(dispatch.reason).toContain("paused");
    expect(called).toBe(0);
    await b.store.close();
  });

  it("links a confirmed interrupt to the task and leaves an uncertain one running", async () => {
    const b = await bench();
    const taskId = await runningTask(b);
    await b.store.attachTaskTurn(taskId, "turn_0001");

    const uncertain = await b.board.noteEngineInterrupt(b.projectId, {
      turnId: "turn_0001",
      confirmed: false,
      uncertain: true,
      note: "the socket closed before the interrupt was acknowledged",
    });
    expect(uncertain.status).toBe("running");
    expect((await b.store.getTask(taskId))?.status).toBe("running");
    const transitions = await b.store.listTaskTransitions(b.projectId);
    expect(
      transitions.some(
        (entry) =>
          entry.taskId === taskId &&
          entry.fromStatus === "running" &&
          entry.toStatus === "running" &&
          entry.reason?.includes("uncertain"),
      ),
    ).toBe(true);

    const confirmed = await b.board.noteEngineInterrupt(b.projectId, {
      turnId: "turn_0001",
      confirmed: true,
      uncertain: false,
      note: "interrupt confirmed",
    });
    expect(confirmed.status).toBe("interrupted");
    const stopped = await b.store.getTask(taskId);
    expect(stopped?.status).toBe("interrupted");
    expect(stopped?.activeTurnId).toBeNull();
    await b.store.close();
  });
});

describe("attempt ledger: integrity across imports and attribution", () => {
  it("clears the problem ledger on a replace import instead of orphaning a block", async () => {
    const b = await bench();
    const taskId = await runningTask(b);
    for (let index = 0; index < 3; index += 1) {
      await b.board.recordAttempt({ projectId: b.projectId, ...noProgress(taskId) });
    }
    expect((await b.store.getTask(taskId))?.status).toBe("blocked");

    const bundle = await b.store.exportProject(b.projectId);
    const current = await b.store.getProject(b.projectId);
    if (!current) throw new Error("project missing");
    const result = await b.store.importProject(bundle, {
      mode: "replace",
      expectedRevision: current.revision,
    });
    expect(result.mode).toBe("replace");

    // The ledger is replaceable data: no active problem survives to block a
    // task that the bundle itself does not carry.
    expect(await b.store.listProblems(b.projectId)).toHaveLength(0);
    expect(await b.store.listProblemEvents(b.projectId)).toHaveLength(0);
    const reimported = await b.store.getTask(taskId);
    if (!reimported) throw new Error("task missing after import");
    // The task's own status is bundle data; the point is that no ledger row
    // survives to justify it, so an explicit start is possible and audited.
    expect(reimported.status).toBe("blocked");
    const restarted = await b.board.startTask(taskId, reimported.revision);
    expect(restarted.task.status).toBe("running");
    const transitions = await b.store.listTaskTransitions(b.projectId);
    expect(
      transitions.some(
        (entry) =>
          entry.taskId === taskId &&
          entry.toStatus === "running" &&
          entry.reason?.includes("no active blocked problem remains"),
      ),
    ).toBe(true);

    const fresh = await b.board.recordAttempt({ projectId: b.projectId, ...noProgress(taskId) });
    expect(fresh.problem.totalAttempts).toBe(1);
    expect(fresh.problem.status).toBe("open");
    await b.store.close();
  });

  it("attributes an interrupt only to the task linked to that exact turn", async () => {
    const b = await bench();
    const linked = await runningTask(b, "Linked task");
    await b.store.attachTaskTurn(linked, "turn_alpha");

    const wrongTurn = await b.board.noteEngineInterrupt(b.projectId, {
      turnId: "turn_manual",
      confirmed: true,
      uncertain: false,
      note: "interrupt confirmed",
    });
    expect(wrongTurn.taskId).toBeNull();
    expect((await b.store.getTask(linked))?.status).toBe("running");

    const noTurn = await b.board.noteEngineInterrupt(b.projectId, {
      turnId: null,
      confirmed: true,
      uncertain: false,
      note: "interrupt confirmed",
    });
    expect(noTurn.taskId).toBeNull();
    expect((await b.store.getTask(linked))?.status).toBe("running");

    // A finished turn releases the link, so a later interrupt cannot inherit it.
    expect(await b.board.clearFinishedTurn(b.projectId, "turn_alpha")).toEqual([linked]);
    const afterFinish = await b.board.noteEngineInterrupt(b.projectId, {
      turnId: "turn_alpha",
      confirmed: true,
      uncertain: false,
      note: "interrupt confirmed",
    });
    expect(afterFinish.taskId).toBeNull();
    expect((await b.store.getTask(linked))?.status).toBe("running");
    expect((await b.store.getTask(linked))?.activeTurnId).toBeNull();
    await b.store.close();
  });

  it("tells the human to unblock, never to start, a pending task with a blocked problem", async () => {
    const b = await bench();
    const task = await b.store.createTask({
      projectId: b.projectId,
      title: "Pending blocked",
      prompt: "work",
      requirements: ["MONA-011"],
    });
    for (let index = 0; index < 3; index += 1) {
      await b.board.recordAttempt({ projectId: b.projectId, ...noProgress(task.id) });
    }
    const handoff = await b.board.handoff(b.projectId);
    expect(handoff.currentTaskId).toBe(task.id);
    expect(handoff.nextExactAction).toContain("Unblock MONA-011");
    expect(handoff.nextExactAction).not.toContain("Start");
    expect(handoff.blockedProblems).toHaveLength(1);
    await b.store.close();
  });

  it("never adopts a taskless problem for a task-bound attempt", async () => {
    const b = await bench();
    const task = await b.store.createTask({
      projectId: b.projectId,
      title: "Task-bound",
      prompt: "work",
      requirements: ["MONA-011"],
    });
    const taskless = await b.store.recordProblemAttempt({
      projectId: b.projectId,
      requirement: "MONA-011",
      symptom: noProgress(task.id).symptom,
      hypothesis: "shared hypothesis",
      action: "shared action",
      observed: "shared result",
      materialProgress: false,
    });
    expect(taskless.problem.taskId).toBeNull();

    const bound = await b.board.recordAttempt({ projectId: b.projectId, ...noProgress(task.id) });
    expect(bound.problem.id).not.toBe(taskless.problem.id);
    expect(bound.problem.taskId).toBe(task.id);
    await b.store.close();
  });
});
