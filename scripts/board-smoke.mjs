#!/usr/bin/env node
// P10 sample-project run. This exercises the real StateStore and TaskBoard from
// compiled main-process code against a temporary workspace, runs an actual
// `node --test` command, records its evidence, then proves the state machine:
// dependency cycles, deterministic selection, one-prompt queue, resume at a
// recorded step, stale verification, and plan round-tripping.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const { StateStore } = require(join(ROOT, "dist/main/main/state/store.js"));
const { TaskBoard } = require(join(ROOT, "dist/main/main/work/board.js"));

const base = mkdtempSync(join(tmpdir(), "mona-p10-"));
const stateDir = join(base, "state");
const workspace = join(base, "workspace");
const otherWorkspace = join(base, "other-workspace");
const attemptWorkspace = join(base, "attempt-workspace");
mkdirSync(join(workspace, "src"), { recursive: true });
mkdirSync(join(workspace, "test"), { recursive: true });
mkdirSync(join(workspace, "evidence"), { recursive: true });
mkdirSync(join(otherWorkspace, "src"), { recursive: true });
mkdirSync(join(attemptWorkspace, "src"), { recursive: true });

writeFileSync(
  join(workspace, "test", "feature.test.mjs"),
  [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add } from "../src/feature.mjs";',
    'test("adds two numbers", () => assert.equal(add(2, 3), 5));',
    "",
  ].join("\n"),
);

let clock = Date.parse("2026-11-11T00:00:00.000Z");
let counter = 0;
const now = () => {
  clock += 1000;
  return new Date(clock);
};
const newId = (prefix) => {
  counter += 1;
  return `${prefix}_${counter.toString(16).padStart(8, "0")}`;
};

const store = await StateStore.open({
  dbPath: join(stateDir, "mona.sqlite"),
  backupDir: join(stateDir, "backups"),
  artifactRoot: join(stateDir, "artifacts"),
  now,
  newId,
});
const board = new TaskBoard({ store });
const project = await store.openProject(workspace);
const other = await store.openProject(otherWorkspace);
const projectId = project.project.id;

const checks = {};
const rejected = {};
const log = (line) => process.stderr.write(`${line}\n`);

const cyclic = {
  format: "mona-task-plan",
  format_version: 1,
  name: "Cycle",
  tasks: [
    { key: "a", title: "A", prompt: "do a", dependsOn: ["b"] },
    { key: "b", title: "B", prompt: "do b", dependsOn: ["a"] },
  ],
};
try {
  await board.importPlan(projectId, cyclic);
  rejected.cycle = "UNEXPECTED_ACCEPT";
} catch (error) {
  rejected.cycle = `${error.code ?? "ERROR"}: ${error.message}`;
}
checks.dependency_cycle_rejected = rejected.cycle.startsWith("CONFLICT");
checks.no_partial_import = (await store.listTasks(projectId)).length === 0;

const imported = await board.importPlan(projectId, {
  format: "mona-task-plan",
  format_version: 1,
  name: "P10 sample",
  tasks: [
    {
      key: "build",
      title: "Add the feature",
      prompt: "Implement add(a, b) in src/feature.mjs and make the focused test pass.",
      requirements: ["MONA-009"],
      acceptance: [{ text: "node --test test/feature.test.mjs passes", kind: "check" }],
      steps: ["write src/feature.mjs", "run the focused test"],
    },
    {
      key: "review",
      title: "Review the result",
      prompt: "Read the test output and record a decision.",
      acceptance: [{ text: "a human accepts the result", kind: "human" }],
      steps: ["read the output", "record the decision"],
      dependsOn: ["build"],
    },
    {
      key: "docs",
      title: "Document the helper",
      prompt: "Add one line to README.md describing add(a, b).",
    },
  ],
});
checks.import_is_inert = imported.inert === true && imported.taskCount === 3;
const importedTasks = await store.listTasks(projectId);
checks.imported_tasks_pending = importedTasks.every((task) => task.status === "pending");
checks.imported_owner_default = importedTasks.every((task) => task.executionOwner === "mona_queue");

const selection = await board.selectNext(projectId);
checks.deterministic_selection = selection.taskId === imported.created[0].taskId;

let executorCalls = 0;
const queue = await board.runOnce(projectId, async ({ preview }) => {
  executorCalls += 1;
  checks.preview_has_prompt = preview.text.includes("Implement add(a, b)");
  checks.preview_excludes_spec = !preview.text.includes("Mona_macOS_Project.md");
  writeFileSync(
    join(workspace, "src", "feature.mjs"),
    "export function add(a, b) {\n  return a + b;\n}\n",
    "utf8",
  );
  const output = execFileSync(process.execPath, ["--test", "test/feature.test.mjs"], {
    cwd: workspace,
    encoding: "utf8",
  });
  writeFileSync(join(workspace, "evidence", "test-output.txt"), output, "utf8");
  return { accepted: true, note: "submission accepted by the sample executor" };
});
checks.queue_ran_one = queue.ran.length === 1 && executorCalls === 1;
checks.queue_stopped =
  queue.stoppedBecause === "one_prompt_per_assignment" && queue.dispatches.length === 1;
const afterQueue = await store.listTasks(projectId);
checks.other_tasks_unstarted = afterQueue.filter((task) => task.status === "pending").length === 2;
checks.running_is_one = afterQueue.filter((task) => task.status === "running").length === 1;

const buildId = imported.created[0].taskId;
const buildSteps = await store.listTaskSteps(buildId);
for (const step of buildSteps) {
  await store.setTaskStepState(
    buildId,
    step.id,
    "completed",
    join(workspace, "evidence", "test-output.txt"),
  );
}
const build = await store.getTask(buildId);
const criteria = await store.listAcceptance(buildId);
if (!build || !criteria[0]) throw new Error("sample task lost its criterion");
await board.satisfy({
  taskId: buildId,
  criterionId: criteria[0].id,
  expectedRevision: build.revision,
  by: "check",
  evidencePath: join(workspace, "evidence", "test-output.txt"),
});
await board.addEvidence({
  projectId,
  taskId: buildId,
  requirementId: "MONA-009",
  path: join(workspace, "evidence", "test-output.txt"),
  note: "node --test output",
});
const beforeVerify = await store.getTask(buildId);
const verifying = await board.verify(buildId, beforeVerify.revision);
const completed = await board.complete(buildId, verifying.revision);
checks.evidence_gated_completion =
  completed.status === "completed" && completed.completedAt !== null;

const afterBuild = await board.selectNext(projectId);
checks.prerequisite_verified = afterBuild.taskId === imported.created[1].taskId;

// Interrupt the review task at its second step, then resume explicitly.
const reviewId = imported.created[1].taskId;
const reviewRun = await store.beginTaskRun({ taskId: reviewId, owner: "mona_queue" });
const reviewSteps = await store.listTaskSteps(reviewId);
if (!reviewSteps[0]) throw new Error("review step missing");
await store.setTaskStepState(reviewId, reviewSteps[0].id, "completed");
await store.finishTaskRun(reviewRun.run.id, "interrupted", "sample crash");
const interrupted = await store.getTask(reviewId);
checks.interrupted_next_step = interrupted.nextStep === "record the decision";
const reconcile = await board.reconcile(projectId, { resume: true });
checks.resume_at_recorded_step = reconcile.resumed.some(
  (entry) => entry.taskId === reviewId && entry.step === "record the decision",
);

// Change the workspace after completion: verification must become stale.
writeFileSync(
  join(workspace, "src", "feature.mjs"),
  "export function add(a, b) {\n  return a + b + 0;\n}\n",
  "utf8",
);
const stale = await board.reconcile(projectId);
const reopened = await board.taskView(buildId);
checks.stale_after_code_change =
  stale.stale.some((entry) => entry.taskId === buildId) &&
  reopened.status === "verifying" &&
  reopened.verificationStale === true;

const exported = await board.exportPlan(projectId);
const exportedBuild = exported.tasks.find((task) => task.title === "Add the feature");
checks.criteria_survive_export =
  exportedBuild?.acceptance?.[0]?.text === "node --test test/feature.test.mjs passes";
const reimport = await board.importPlan(other.project.id, exported);
const otherBoard = await board.snapshot(other.project.id);
checks.round_trip_criteria =
  reimport.taskCount === exported.tasks.length &&
  otherBoard.tasks.some(
    (task) =>
      task.title === "Add the feature" &&
      task.acceptance[0]?.text === "node --test test/feature.test.mjs passes",
  );
checks.workspaces_isolated =
  otherBoard.tasks.every((task) => task.projectId === other.project.id) &&
  otherBoard.selection.eligible.every((id) => !importedTasks.some((task) => task.id === id));

const handoff = await board.handoff(projectId);
checks.handoff_from_state =
  typeof handoff.nextExactAction === "string" &&
  handoff.nextExactAction.length > 0 &&
  handoff.currentTaskId !== null;
const transitions = await store.listTaskTransitions(projectId);
checks.transitions_audited = transitions.length >= 6;

// ---------------------------------------------------------------- P11 ledger
const attemptProject = await store.openProject(attemptWorkspace);
const attemptProjectId = attemptProject.project.id;
const loopTask = await store.createTask({
  projectId: attemptProjectId,
  title: "An unproductive loop",
  prompt: "Make the failing check pass without changing the requirement.",
  requirements: ["MONA-011"],
});
const dependentTask = await store.createTask({
  projectId: attemptProjectId,
  title: "Depends on the loop",
  prompt: "Continue after the loop is fixed.",
  dependsOn: [loopTask.id],
});
const independentTask = await store.createTask({
  projectId: attemptProjectId,
  title: "Independent work",
  prompt: "This task does not depend on the loop.",
});
await board.startTask(loopTask.id);
const attempt = (symptom, materialProgress = false, extra = {}) =>
  board.recordAttempt({
    projectId: attemptProjectId,
    taskId: loopTask.id,
    requirement: "MONA-011",
    symptom,
    hypothesis: "the cache key ignores the workspace",
    action: "include the canonical path in the key",
    observed: "the same assertion still fails",
    materialProgress,
    ...extra,
  });
const attemptOne = await attempt("the same assertion still fails");
const attemptTwo = await attempt("a differently worded error message");
checks.attempt_one_open =
  attemptOne.problem.status === "open" && attemptOne.problem.totalAttempts === 1;
checks.attempt_two_same_problem =
  attemptTwo.problem.id === attemptOne.problem.id && attemptTwo.problem.noProgressAttempts === 2;
const attemptThree = await attempt("the same assertion still fails");
const loopAfterBlock = await store.getTask(loopTask.id);
checks.attempt_three_blocks =
  attemptThree.blocked === true &&
  attemptThree.problem.status === "blocked" &&
  attemptThree.problem.noProgressAttempts === 3;
checks.attempt_task_blocked = loopAfterBlock?.status === "blocked";
let fourthHiddenRetry = "unexpected acceptance";
try {
  await attempt("one last try");
} catch (error) {
  fourthHiddenRetry = `${error.code ?? "ERROR"}: ${error.message}`;
}
checks.attempt_fourth_rejected = fourthHiddenRetry.startsWith("CONFLICT");
const acknowledged = await board.acknowledgeProblem(attemptThree.problem.id, "seen by the builder");
checks.attempt_ack_keeps_count =
  acknowledged.problem.status === "blocked" &&
  acknowledged.problem.totalAttempts === 3 &&
  acknowledged.problem.noProgressAttempts === 3;
const attemptSelection = await board.selectNext(attemptProjectId);
checks.independent_work_continues =
  attemptSelection.taskId === independentTask.id &&
  attemptSelection.waiting.some(
    (entry) => entry.taskId === dependentTask.id && entry.blocking.includes(loopTask.id),
  );
let pausedCalls = 0;
const pausedRun = await board.runOnce(
  attemptProjectId,
  async () => {
    pausedCalls += 1;
    return { accepted: true };
  },
  { shouldPause: () => true },
);
checks.pause_gate_blocks_dispatch =
  pausedRun.stoppedBecause === "paused" && pausedRun.ran.length === 0 && pausedCalls === 0;
const attemptHandoff = await board.handoff(attemptProjectId);
checks.victor_handoff_card =
  attemptHandoff.blockedProblems.length === 1 &&
  attemptHandoff.blockedProblems[0].helpNeeded.includes("MONA-011");
checks.handoff_names_unblock_not_start =
  attemptHandoff.nextExactAction.includes("Unblock MONA-011") &&
  !attemptHandoff.nextExactAction.includes("Start");

// Interrupt attribution is by turn identity, never "some running task".
await store.attachTaskTurn(loopTask.id, "turn_p11_sample");
const wrongTurn = await board.noteEngineInterrupt(attemptProjectId, {
  turnId: "turn_manual",
  confirmed: true,
  uncertain: false,
  note: "interrupt confirmed for an unrelated manual turn",
});
checks.interrupt_attribution_by_turn =
  wrongTurn.taskId === null && (await store.getTask(loopTask.id))?.status === "blocked";
await board.clearFinishedTurn(attemptProjectId, "turn_p11_sample");
const finishedTurn = await board.noteEngineInterrupt(attemptProjectId, {
  turnId: "turn_p11_sample",
  confirmed: true,
  uncertain: false,
  note: "interrupt confirmed after the turn already finished",
});
checks.finished_turn_releases_link =
  finishedTurn.taskId === null && (await store.getTask(loopTask.id))?.activeTurnId === null;
const reopenedProblem = await board.reopenProblem(attemptThree.problem.id, {
  reason: "the reproduction is narrowed to the cache key",
  evidence: [join(attemptWorkspace, "src", "repro.txt")],
});
checks.reopen_keeps_total =
  reopenedProblem.problem.status === "open" &&
  reopenedProblem.problem.totalAttempts === 3 &&
  reopenedProblem.problem.noProgressAttempts === 0;
const resumedLoop = await board.resumeTask(loopTask.id);
checks.reopen_allows_resume = resumedLoop.task.status === "running";
const attemptEvents = await store.listProblemEvents(attemptProjectId);
checks.attempt_audit =
  attemptEvents.some((event) => event.kind === "blocked") &&
  attemptEvents.some((event) => event.kind === "acknowledged") &&
  attemptEvents.some((event) => event.kind === "reopened");

const redact = (value) =>
  value
    .split(base)
    .join("<tmp>")
    .split(process.env.HOME ?? "")
    .join("~");

const ok = Object.values(checks).every(Boolean);
log(`P10/P11 sample run: ${ok ? "PASS" : "FAIL"}`);
for (const [name, value] of Object.entries(checks)) log(`  ${value ? "ok  " : "FAIL"} ${name}`);

console.log(
  JSON.stringify(
    {
      schema_version: 1,
      prompts: ["P10", "P11"],
      ok,
      checks,
      cycle_rejection: redact(rejected.cycle),
      imported_tasks: imported.created.map((entry) => ({ ...entry, key: entry.key })),
      attempts: {
        problem_id: attemptThree.problem.id,
        total: attemptThree.problem.totalAttempts,
        consecutive: attemptThree.problem.noProgressAttempts,
        blocked_status: attemptThree.problem.status,
        task_status: loopAfterBlock?.status ?? null,
        fourth_retry: redact(fourthHiddenRetry),
        handoff: attemptHandoff.blockedProblems.map((card) => ({
          problem: card.problemId,
          requirement: card.requirement,
          help: card.helpNeeded,
          evidence: card.evidence.map(redact),
        })),
        audit: attemptEvents.map((event) => ({ kind: event.kind, actor: event.actor })),
      },
      queue: {
        ran: queue.ran,
        stopped_because: queue.stoppedBecause,
        executor_calls: executorCalls,
      },
      handoff: {
        current_task: handoff.currentTitle,
        current_status: handoff.currentStatus,
        last_verified_step: handoff.lastVerifiedStep,
        next_exact_action: handoff.nextExactAction,
        open_attempts: handoff.openAttempts,
      },
      stale: stale.stale.map((entry) => ({ ...entry, reason: redact(entry.reason) })),
      transitions: transitions.map((entry) => ({
        task: entry.taskId,
        from: entry.fromStatus,
        to: entry.toStatus,
        actor: entry.actor,
        reason: entry.reason,
      })),
      workspace_files: {
        feature: redact(join(workspace, "src", "feature.mjs")),
        test_output: redact(join(workspace, "evidence", "test-output.txt")),
      },
    },
    null,
    2,
  ),
);

await store.close();
rmSync(base, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
