#!/usr/bin/env node
// P14 polish sample run. Exercises the compiled digest, notification planner,
// attention controller, keep-awake scope, preferences, favorites, and identity
// against a real temporary SQLite store and a real Git repository. No engine is
// started and no provider call is made anywhere in this script.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const { StateStore } = require(join(ROOT, "dist/main/main/state/store.js"));
const { TaskBoard } = require(join(ROOT, "dist/main/main/work/board.js"));
const { CostLedger } = require(join(ROOT, "dist/main/main/work/costs.js"));
const { ChangeLedger } = require(join(ROOT, "dist/main/main/work/changes.js"));
const { PolishDigest } = require(join(ROOT, "dist/main/main/work/digest.js"));
const { PolishPreferencesStore, normalizeIdentity } = require(
  join(ROOT, "dist/main/main/work/preferences.js"),
);
const { ProjectService } = require(join(ROOT, "dist/main/main/projects/service.js"));
const { PolishService } = require(join(ROOT, "dist/main/main/work/polish.js"));
const { PolishNotifier, inQuietHours, planNotification } = require(
  join(ROOT, "dist/main/main/work/notifications.js"),
);
const { AttentionController, KeepAwake } = require(join(ROOT, "dist/main/main/work/attention.js"));

const base = mkdtempSync(join(tmpdir(), "mona-p14-"));
const stateDir = join(base, "state");
const workspace = join(base, "workspace");
mkdirSync(workspace, { recursive: true });

let clock = Date.parse("2026-11-12T09:00:00.000Z");
const advance = (ms) => {
  clock += ms;
};
const now = () => {
  clock += 1000;
  return new Date(clock);
};
let counter = 0;
const newId = (prefix) => {
  counter += 1;
  return `${prefix}_${counter.toString(16).padStart(8, "0")}`;
};

execFileSync("/usr/bin/git", ["init", "-q", "-b", "main"], { cwd: workspace });
execFileSync("/usr/bin/git", ["config", "user.email", "mona@example.test"], { cwd: workspace });
execFileSync("/usr/bin/git", ["config", "user.name", "Mona Smoke"], { cwd: workspace });
writeFileSync(join(workspace, "app.ts"), "export const value = 1;\n", "utf8");
execFileSync("/usr/bin/git", ["add", "app.ts"], { cwd: workspace });
execFileSync("/usr/bin/git", ["commit", "-qm", "base"], { cwd: workspace });

const store = await StateStore.open({
  dbPath: join(stateDir, "mona.sqlite"),
  backupDir: join(stateDir, "backups"),
  artifactRoot: join(stateDir, "artifacts"),
  now,
  newId,
});
const board = new TaskBoard({ store });
const cost = new CostLedger(store);
const changes = new ChangeLedger({ store });
const project = await store.createProject({ name: "P14 sample", rootPath: workspace });
const projectId = project.id;
const thread = await store.upsertThread({
  id: "thr_p14sample0000001",
  projectId,
  engineThreadId: "thr_engine_p14_0001",
  title: "Polish",
});

const completed = await board.create({
  projectId,
  title: "Make the catalog real",
  prompt: "Record acceptance evidence and finish.",
  acceptance: [{ text: "the catalog check passes", kind: "check" }],
});
const evidencePath = join(base, "catalog-check.txt");
writeFileSync(evidencePath, "ok\n", "utf8");
const running = await store.updateTaskStatus(completed.id, "running", completed.revision);
const view = await board.taskView(completed.id);
let revision = running.revision;
for (const criterion of view.acceptance) {
  const updated = await board.satisfy({
    taskId: completed.id,
    criterionId: criterion.id,
    expectedRevision: revision,
    by: "check",
    evidencePath,
  });
  revision = updated.revision;
}
const verifying = await board.verify(completed.id, revision);
await board.complete(completed.id, verifying.revision);

const blocked = await board.create({
  projectId,
  title: "An unproductive loop",
  prompt: "Make the failing check pass without lowering the requirement.",
  requirements: ["MONA-011"],
});
for (let attempt = 1; attempt <= 3; attempt += 1) {
  await board.recordAttempt({
    projectId,
    taskId: blocked.id,
    requirement: "MONA-011",
    symptom: "the same assertion still fails",
    hypothesis: `hypothesis ${attempt}`,
    action: `attempt ${attempt}`,
    observed: "the same assertion still fails",
    materialProgress: false,
    evidence: ["docs/evidence/attempt.txt"],
  });
}

const turnId = "turn_p14sample0001";
await store.upsertChangeSet({
  projectId,
  threadId: thread.id,
  engineThreadId: "thr_engine_p14_0001",
  turnId,
  state: "settled",
  reason: null,
  preSnapshotId: "tree_pre_p14",
  postSnapshotId: "tree_post_p14",
  origin: "engine",
  evidenceRank: 3,
  note: null,
  files: [
    {
      artifactId: "file_app",
      path: "app.ts",
      previousPath: null,
      kind: "file",
      change: "updated",
      source: "tool_mutation",
      toolName: "edit_file",
      toolCallId: "call_p14",
      itemId: "item_p14",
      sizeBytes: 24,
      revision: "a".repeat(64),
      restoreSnapshotId: "tree_pre_p14",
    },
  ],
});
await store.recordEvent({
  threadId: thread.id,
  seq: 1,
  kind: "turn.completed",
  payload: { turn_id: turnId },
  timestamp: new Date(clock).toISOString(),
  turnId,
});
await store.recordEvent({
  threadId: thread.id,
  seq: 2,
  kind: "item.completed",
  payload: {
    item: {
      id: "item_p14_test",
      kind: "tool_call",
      status: "completed",
      tool_name: "shell",
      summary: "npm test",
      detail: "npm test\n12 tests passed",
    },
  },
  timestamp: new Date(clock).toISOString(),
  turnId,
});
await store.recordUsage({
  projectId,
  threadId: thread.id,
  turnId,
  provider: "deepseek",
  model: "deepseek-flash",
  inputTokens: 1200,
  outputTokens: 40,
  cachedTokens: 800,
  cacheMissTokens: 400,
  reasoningTokens: 12,
  costUsd: 0.0042,
  costState: "reported",
  capturedAt: new Date(clock).toISOString(),
});
await store.recordUsage({
  projectId,
  threadId: thread.id,
  turnId: "turn_p14sample0002",
  provider: "deepseek",
  model: "deepseek-flash",
  inputTokens: 900,
  outputTokens: 20,
  cachedTokens: 0,
  cacheMissTokens: 900,
  reasoningTokens: 0,
  costUsd: null,
  costState: "unknown_price",
  capturedAt: new Date(clock).toISOString(),
});

// A previous visit one hour ago, so the catch-up view has real material.
const seenAt = new Date(clock - 3_600_000).toISOString();
await store.putSettings(`polish:seen:${projectId}`, { seenAt });

const digest = new PolishDigest({
  store,
  board,
  changes,
  cost,
  now: () => new Date(clock),
});
const resume = await digest.resume(projectId);
const since = await digest.sinceYouLeft(projectId);

const marked = await digest.markSeen(projectId);
advance(60_000);
await store.recordEvent({
  threadId: thread.id,
  seq: 3,
  kind: "turn.failed",
  payload: { reason: "the provider returned an error" },
  timestamp: new Date(clock).toISOString(),
  turnId: "turn_p14sample0003",
});
advance(60_000);
const sinceAfterMark = await digest.sinceYouLeft(projectId);

// ---------------------------------------------------------------- notifications
const delivered = [];
const host = {
  available: () => true,
  note: () => "sample host",
  deliver: async (input) => {
    delivered.push({ title: input.title, body: input.body });
    return "shown";
  },
};
const sources = {
  tasks: async () =>
    (await board.snapshot(projectId)).tasks.map((task) => ({
      id: task.id,
      title: task.title,
      completedAt: task.completedAt,
    })),
  problems: async () =>
    (await board.snapshot(projectId)).problems
      .filter((problem) => problem.status === "blocked")
      .map((problem) => ({
        id: problem.id,
        taskId: problem.taskId,
        title: problem.symptom,
        requirement: problem.requirement,
        helpNeeded: problem.helpNeeded ?? "a decision",
        blockedAt: problem.blockedAt,
      })),
  budgets: async () => [],
};
const preferences = new PolishPreferencesStore({ store, timeZone: () => "UTC" });
const notifier = new PolishNotifier({
  store,
  sources,
  host,
  preferences: () => preferences.get(),
  now: () => new Date(clock),
});
const seeded = await notifier.refresh(projectId);
advance(10_000);
const nextTask = await board.create({
  projectId,
  title: "Second verified task",
  prompt: "Finish after the notification cursor.",
  acceptance: [{ text: "check two passes", kind: "check" }],
});
const nextRunning = await store.updateTaskStatus(nextTask.id, "running", nextTask.revision);
const nextView = await board.taskView(nextTask.id);
let nextRevision = nextRunning.revision;
for (const criterion of nextView.acceptance) {
  const updated = await board.satisfy({
    taskId: nextTask.id,
    criterionId: criterion.id,
    expectedRevision: nextRevision,
    by: "check",
    evidencePath,
  });
  nextRevision = updated.revision;
}
const nextVerified = await board.verify(nextTask.id, nextRevision);
await board.complete(nextTask.id, nextVerified.revision);
const firstDelivery = await notifier.refresh(projectId);
const reconnectDelivered = [];
const reconnect = new PolishNotifier({
  store,
  sources,
  host: {
    available: () => true,
    note: () => "sample host",
    deliver: (input) => reconnectDelivered.push(input.title),
  },
  preferences: () => preferences.get(),
  now: () => new Date(clock),
});
const reconnectResult = await reconnect.refresh(projectId);

const quiet = { enabled: true, start: "22:00", end: "07:00", timeZone: "UTC" };
const quietPlan = planNotification(
  {
    key: "sample",
    kind: "completion",
    projectId,
    projectName: "P14 sample",
    at: new Date(clock).toISOString(),
    taskId: completed.id,
    problemId: null,
    changeSetId: null,
    title: "sensitive title",
    body: "sensitive body",
    focus: {
      projectId,
      screen: "changes",
      taskId: completed.id,
      problemId: null,
      changeSetId: null,
      fromNotification: true,
    },
  },
  {
    ...(await preferences.get()),
    notifications: { ...(await preferences.get()).notifications, quietHours: quiet },
  },
  new Date("2026-11-12T23:30:00.000Z"),
);
const tzWindow = { ...quiet, timeZone: "America/Los_Angeles" };
const quietChecks = {
  overnight_inside: inQuietHours(new Date("2026-11-12T23:30:00Z"), quiet),
  no_quiet_at_noon: inQuietHours(new Date("2026-11-12T12:00:00Z"), quiet) === false,
  end_is_exclusive: inQuietHours(new Date("2026-11-12T07:00:00Z"), quiet) === false,
  other_zone_not_quiet: inQuietHours(new Date("2026-11-12T23:30:00Z"), tzWindow) === false,
};

// ------------------------------------------------------------------- attention
const badges = [];
const menus = [];
const loginCalls = [];
const attentionHost = {
  installed: () => true,
  note: () => "sample host",
  setBadge: (badge) => badges.push(badge),
  setMenu: (title, tooltip) => menus.push({ title, tooltip }),
  setLoginItem: (value) => loginCalls.push(value),
  loginItem: () => loginCalls.at(-1) === true,
};
const attention = new AttentionController(attentionHost);
const prefs = await preferences.get();
const attentionActive = attention.sync(
  { running: true, blocked: 1, unseenCompletions: 1, limits: 0 },
  prefs,
);
const attentionQuiet = attention.sync(
  { running: false, blocked: 1, unseenCompletions: 1, limits: 0 },
  { ...prefs, dockBadge: false, menuBarStatus: false },
);
const clearedBadge = badges.at(-1);
const clearedMenu = menus.at(-1)?.title;
// Keep-awake is driven through the real service, so this proves the wiring —
// not merely that the class can start and stop a scalar.
const started = [];
const stopped = [];
const keepAwake = new KeepAwake({
  start: () => {
    started.push(1);
    return 11;
  },
  stop: (id) => stopped.push(id),
});
const projects = new ProjectService({
  store,
  status: () => ({
    state: "disconnected",
    reason: "sample",
    since: new Date(clock).toISOString(),
    workspace: null,
    ownershipId: null,
    port: null,
    engine: null,
    external: false,
    restarts: 0,
    lastFailure: null,
    pendingRestartInMs: null,
  }),
  chooseFolder: async () => null,
  reveal: () => undefined,
});
const service = new PolishService({
  store,
  board,
  projects,
  changes,
  cost,
  notifier,
  attention,
  keepAwake,
  preferences,
  isTurnActive: async () => true,
  now: () => new Date(clock),
});
await preferences.update({ keepAwakeDuringWork: true });
const serviceActive = await service.refresh(projectId);
const assertionHeld = keepAwake.status().active;
const keepAwakeOff = await preferences.update({ keepAwakeDuringWork: false });
const serviceReleased = await service.refresh(projectId);
keepAwake.release();

// -------------------------------------------------------------- preferences
const favorite = await preferences.saveFavorite({
  label: "Review the diff",
  text: "Review the diff and record what changed.",
});
const favoritesAfterSave = await preferences.favorites();
const removed = await preferences.removeFavorite(favorite.id);
const identity = normalizeIdentity({ accent: "mint", monogram: " p1 " });

const checks = {
  brief_matches_focus_task: resume.currentTask?.id === blocked.id,
  brief_reports_blocker: resume.unresolvedBlocker?.noProgressAttempts === 3,
  brief_changed_files: resume.changes.countedFiles === 1,
  brief_spend_incomplete: resume.spend.complete === false && resume.spend.unknownTurns >= 1,
  brief_has_no_percentage: !/\d+%/.test(JSON.stringify(resume)),
  since_groups_present:
    since.groups.some((group) => group.id === "completion") &&
    since.groups.some((group) => group.id === "blocker") &&
    since.groups.some((group) => group.id === "test"),
  mark_seen_advances: Date.parse(marked.seenAt) > Date.parse(seenAt),
  catch_up_after_mark: sinceAfterMark.groups.some((group) =>
    group.entries.some((entry) => entry.title === "Turn failed"),
  ),
  notification_seed_silent: seeded.length === 0,
  notification_delivers_once: firstDelivery.length === 1 && delivered.length === 1,
  notification_reconnect_silent: reconnectResult.length === 0 && reconnectDelivered.length === 0,
  notification_default_is_redacted:
    delivered[0]?.title === "Mona · work finished" && !/sensitive/.test(delivered[0]?.body ?? ""),
  notification_receipt_states_delivery: firstDelivery[0]?.delivery === "shown",
  quiet_hours_suppresses: quietPlan.deliver === false && /quiet hours/.test(quietPlan.reason ?? ""),
  quiet_timezones_correct: Object.values(quietChecks).every(Boolean),
  attention_badge: attentionActive.view.badge === "2",
  attention_menu: attentionActive.view.menuTitle.includes("Working"),
  attention_surfaces_clear: clearedBadge === "" && clearedMenu === "",
  launch_at_login_off: attentionActive.launchAtLogin.enabled === false && loginCalls.length === 0,
  keep_awake_scoped:
    assertionHeld === true &&
    serviceActive.keepAwake.active === true &&
    serviceActive.keepAwake.scopedToActiveWork === true &&
    serviceReleased.keepAwake.active === false &&
    started.length >= 1 &&
    stopped.length >= 1,
  keep_awake_preference_off: keepAwakeOff.keepAwakeDuringWork === false,
  favorite_saved: favoritesAfterSave.length === 1 && removed.removed === true,
  identity_normalized: identity.accent === "mint" && identity.monogram === "P1",
};

const report = {
  schema_version: 1,
  label: "P14 DETERMINISTIC POLISH SAMPLE — no engine, no provider call",
  captured_at: new Date().toISOString(),
  ok: Object.values(checks).every(Boolean),
  checks,
  facts: {
    resume,
    since: {
      since: since.since,
      entryCount: since.entryCount,
      groups: since.groups.map((group) => ({
        id: group.id,
        entries: group.entries.map((entry) => entry.title),
      })),
    },
    sinceAfterMark: sinceAfterMark.entryCount,
    notifications: {
      seeded: seeded.length,
      delivered,
      reconnect: reconnectResult.length,
    },
    quiet: quietChecks,
    attention: {
      active: attentionActive.view,
      clearedBadge: attentionQuiet.view.badge,
      lastBadge: badges.at(-1),
      lastMenu: menus.at(-1),
    },
    keepAwake: {
      started: started.length,
      stopped: stopped.length,
      activeWhileWorking: serviceActive.keepAwake,
      afterPreferenceOff: serviceReleased.keepAwake,
    },
    favorite,
    identity,
  },
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
