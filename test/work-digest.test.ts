import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectId, TaskId } from "../src/shared/contracts";
import { TaskBoard } from "../src/main/work/board";
import { CostLedger } from "../src/main/work/costs";
import { ChangeLedger } from "../src/main/work/changes";
import { PolishDigest } from "../src/main/work/digest";
import type { StateStore } from "../src/main/state/store";
import { makeClock, openTestStore, tempDir } from "./helpers/state";

interface Bench {
  store: StateStore;
  board: TaskBoard;
  digest: PolishDigest;
  projectId: ProjectId;
  root: string;
  clock: ReturnType<typeof makeClock>;
}

async function bench(): Promise<Bench> {
  const clock = makeClock("2026-11-12T09:00:00.000Z", 1_000);
  const { store } = await openTestStore({ now: clock.now });
  const root = tempDir("mona-polish-project-");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const value = 1;\n", "utf8");
  const project = await store.createProject({ name: "Polish project", rootPath: root });
  const board = new TaskBoard({ store });
  const digest = new PolishDigest({
    store,
    board,
    changes: new ChangeLedger({ store }),
    cost: new CostLedger(store),
    now: clock.now,
  });
  return { store, board, digest, projectId: project.id as ProjectId, root, clock };
}

async function finishTask(b: Bench, taskId: TaskId, evidenceName = "check.txt"): Promise<void> {
  const view = await b.board.taskView(taskId);
  const evidence = join(b.root, evidenceName);
  writeFileSync(evidence, "the check passed\n", "utf8");
  let revision = (await b.store.getTask(taskId))?.revision ?? 1;
  const current = await b.store.getTask(taskId);
  if (current && current.status === "pending") {
    const running = await b.store.updateTaskStatus(taskId, "running", current.revision);
    revision = running.revision;
  }
  for (const criterion of view.acceptance) {
    const updated = await b.board.satisfy({
      taskId,
      criterionId: criterion.id,
      expectedRevision: revision,
      by: criterion.kind,
      evidencePath: criterion.kind === "check" ? evidence : null,
    });
    revision = updated.revision;
  }
  const verifying = await b.board.verify(taskId, revision);
  await b.board.complete(taskId, verifying.revision);
}

describe("Resume Brief", () => {
  it("matches source records and never invents a completion percentage", async () => {
    const b = await bench();
    const task = await b.board.create({
      projectId: b.projectId,
      title: "Make the catalog real",
      prompt: "Keep drafts local and record acceptance evidence.",
      requirements: ["MONA-005"],
      acceptance: [{ text: "the catalog test passes", kind: "check" }],
      steps: ["write the test", "run it"],
    });
    const thread = await b.store.upsertThread({
      id: "thr_polish00000001",
      projectId: b.projectId,
      engineThreadId: "thr_engine_polish_1",
      title: "Polish",
    });
    await b.store.upsertChangeSet({
      projectId: b.projectId,
      threadId: thread.id,
      engineThreadId: "thr_engine_polish_1",
      turnId: "turn_polish_0001",
      state: "settled",
      reason: null,
      preSnapshotId: "tree_pre_1",
      postSnapshotId: "tree_post_1",
      origin: "engine",
      evidenceRank: 3,
      note: null,
      files: [
        {
          artifactId: "file_app",
          path: "src/app.ts",
          previousPath: null,
          kind: "file",
          change: "updated",
          source: "tool_mutation",
          toolName: "edit_file",
          toolCallId: "call_1",
          itemId: "item_1",
          sizeBytes: 24,
          revision: "a".repeat(64),
          restoreSnapshotId: "tree_pre_1",
        },
      ],
    });
    await b.store.recordUsage({
      projectId: b.projectId,
      threadId: thread.id,
      turnId: "turn_polish_0001",
      provider: "deepseek",
      model: "deepseek-flash",
      inputTokens: 1200,
      outputTokens: 40,
      cachedTokens: 800,
      cacheMissTokens: 400,
      reasoningTokens: 12,
      costUsd: 0.0042,
      costState: "reported",
      capturedAt: new Date().toISOString(),
    });
    await b.store.recordUsage({
      projectId: b.projectId,
      threadId: thread.id,
      turnId: "turn_polish_0002",
      provider: "deepseek",
      model: "deepseek-flash",
      inputTokens: 900,
      outputTokens: 20,
      cachedTokens: 0,
      cacheMissTokens: 900,
      reasoningTokens: 0,
      costUsd: null,
      costState: "unknown_price",
      capturedAt: new Date().toISOString(),
    });

    const brief = await b.digest.resume(b.projectId);
    const snapshot = await b.board.snapshot(b.projectId);

    expect(brief.currentTask?.id).toBe(task.id);
    expect(brief.currentTask?.status).toBe("pending");
    expect(brief.nextStep).toBe(snapshot.handoff.nextExactAction);
    expect(brief.changes.available).toBe(true);
    expect(brief.changes.countedFiles).toBe(1);
    expect(brief.changes.turns).toBe(1);
    expect(brief.spend.observed).toBe(true);
    expect(brief.spend.complete).toBe(false);
    expect(brief.spend.label).toMatch(/^At least \$/);
    expect(brief.testResult.totalChecks).toBe(1);
    expect(brief.testResult.satisfiedChecks).toBe(0);
    expect(brief.testResult.label).toContain("not verified");
    expect(brief.noCompletionPercentage).toBe(true);
    expect(JSON.stringify(brief)).not.toMatch(/\d+%/);
  });

  it("reports an unresolved blocker with its counters", async () => {
    const b = await bench();
    const task = await b.board.create({
      projectId: b.projectId,
      title: "Unproductive loop",
      prompt: "Make the failing check pass without lowering the requirement.",
      requirements: ["MONA-011"],
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await b.board.recordAttempt({
        projectId: b.projectId,
        taskId: task.id,
        requirement: "MONA-011",
        symptom: "the same assertion still fails",
        hypothesis: `hypothesis ${attempt}`,
        action: `attempt ${attempt}`,
        observed: "the same assertion still fails",
        materialProgress: false,
        evidence: ["docs/evidence/attempt.txt"],
      });
    }
    const brief = await b.digest.resume(b.projectId);
    expect(brief.unresolvedBlocker?.requirement).toBe("MONA-011");
    expect(brief.unresolvedBlocker?.totalAttempts).toBe(3);
    expect(brief.unresolvedBlocker?.noProgressAttempts).toBe(3);
    expect(brief.facts[0]?.label).toBe("Unresolved blocker");
    expect(brief.facts[0]?.tone).toBe("danger");
    expect(JSON.stringify(brief)).not.toMatch(/\d+%/);
  });

  it("says changes are unavailable instead of reporting an empty diff", async () => {
    const { store } = await openTestStore();
    const root = tempDir("mona-polish-nochanges-");
    const project = await store.createProject({ name: "No ledger", rootPath: root });
    const board = new TaskBoard({ store });
    const digest = new PolishDigest({ store, board, changes: null, cost: null });
    const brief = await digest.resume(project.id as ProjectId);
    expect(brief.changes.available).toBe(false);
    expect(brief.changes.label).toBe("Changes unavailable");
    expect(brief.spend.label).toBe("Spend unavailable");
    expect(brief.noCompletionPercentage).toBe(true);
  });
});

describe("Since you left", () => {
  it("is empty on a first visit and groups only records after the watermark", async () => {
    const b = await bench();
    const thread = await b.store.upsertThread({
      id: "thr_polish00000002",
      projectId: b.projectId,
      engineThreadId: "thr_engine_polish_2",
      title: "Digest",
    });
    const first = await b.digest.sinceYouLeft(b.projectId);
    expect(first.since).toBeNull();
    expect(first.groups).toHaveLength(0);
    expect(first.note).toContain("No earlier visit");

    const marked = await b.digest.markSeen(b.projectId);
    b.clock.advance(5_000);
    await b.store.recordEvent({
      threadId: thread.id,
      seq: 1,
      kind: "turn.completed",
      payload: { turn_id: "turn_polish_0003" },
      timestamp: new Date(Date.parse(marked.seenAt) + 1_000).toISOString(),
      turnId: "turn_polish_0003",
    });
    await b.store.recordEvent({
      threadId: thread.id,
      seq: 2,
      kind: "item.completed",
      payload: {
        item: {
          id: "item_test",
          kind: "tool_call",
          status: "completed",
          tool_name: "shell",
          summary: "npm test",
          detail: "npm test\n42 tests passed",
        },
      },
      timestamp: new Date(Date.parse(marked.seenAt) + 2_000).toISOString(),
      turnId: "turn_polish_0003",
    });

    const after = await b.digest.sinceYouLeft(b.projectId);
    expect(after.since).toBe(marked.seenAt);
    expect(after.entryCount).toBe(2);
    const ids = after.groups.map((group) => group.id);
    expect(ids).toContain("completion");
    expect(ids).toContain("test");
    const testEntry = after.groups.find((group) => group.id === "test")?.entries.at(0);
    expect(testEntry?.title).toContain("Test command completed");
    expect(testEntry?.detail).toContain("npm test");

    const again = await b.digest.sinceYouLeft(b.projectId);
    expect(again.entryCount).toBe(after.entryCount);
    expect(again.groups.map((group) => group.id)).toEqual(ids);
  });

  it("includes a task verified since the watermark and its evidence", async () => {
    const b = await bench();
    const task = await b.board.create({
      projectId: b.projectId,
      title: "Verified task",
      prompt: "Record evidence and complete.",
      acceptance: [{ text: "the check passes", kind: "check" }],
    });
    await b.digest.markSeen(b.projectId);
    b.clock.advance(5_000);
    await finishTask(b, task.id, "evidence.txt");
    const since = await b.digest.sinceYouLeft(b.projectId);
    const completion = since.groups.find((group) => group.id === "completion");
    expect(completion?.entries.some((entry) => entry.title === "Verified: Verified task")).toBe(
      true,
    );
    const entry = completion?.entries.find((item) => item.title === "Verified: Verified task");
    expect(entry?.evidencePath).toContain("evidence.txt");
  });
});

describe("honest change and test accounting", () => {
  it("names a turn with no recorded delta instead of reporting zero changes", async () => {
    const b = await bench();
    const thread = await b.store.upsertThread({
      id: "thr_polish00000009",
      projectId: b.projectId,
      engineThreadId: "thr_engine_polish_9",
      title: "No delta",
    });
    await b.store.upsertChangeSet({
      projectId: b.projectId,
      threadId: thread.id,
      engineThreadId: "thr_engine_polish_9",
      turnId: "turn_polish_gap",
      state: "unavailable",
      reason: "workspace_snapshots_disabled",
      preSnapshotId: null,
      postSnapshotId: null,
      origin: "engine",
      evidenceRank: 1,
      note: null,
      files: [],
    });
    const brief = await b.digest.resume(b.projectId);
    expect(brief.changes.countedFiles).toBe(0);
    expect(brief.changes.turns).toBe(0);
    expect(brief.changes.label).toContain("no recorded delta");
    expect(brief.changes.label).not.toMatch(/^0 files in 0 recorded turns/);
    expect(brief.changes.note).toContain("missing receipt, not an empty diff");
    expect(brief.changes.note).toContain("workspace_snapshots_disabled");
  });

  it("renders a failed observed test command as a problem, not a success", async () => {
    const b = await bench();
    const task = await b.board.create({
      projectId: b.projectId,
      title: "No acceptance check",
      prompt: "Run the suite.",
    });
    const thread = await b.store.upsertThread({
      id: "thr_polish00000010",
      projectId: b.projectId,
      engineThreadId: "thr_engine_polish_10",
      title: "Tests",
    });
    await b.store.recordEvent({
      threadId: thread.id,
      seq: 1,
      kind: "item.failed",
      payload: {
        item: {
          id: "item_fail",
          kind: "tool_call",
          status: "failed",
          tool_name: "shell",
          summary: "npm test",
          detail: "npm test\n2 failing",
        },
      },
      timestamp: new Date().toISOString(),
      turnId: "turn_polish_tests",
    });
    const brief = await b.digest.resume(b.projectId);
    expect(brief.currentTask?.id).toBe(task.id);
    expect(brief.testResult.totalChecks).toBe(0);
    expect(brief.testResult.observedCommand?.status).toBe("failed");
    const fact = brief.facts.find((entry) => entry.label === "Test result");
    expect(fact?.tone).toBe("danger");
  });
});
