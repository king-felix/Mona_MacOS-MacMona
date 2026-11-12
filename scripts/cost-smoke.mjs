#!/usr/bin/env node
// P12 cost-ledger sample run. It exercises the real StateStore and CostLedger
// from compiled main-process code against a temporary database: exact integer
// arithmetic, inclusive and exclusive token buckets, replay deduplication,
// cumulative thread deltas, unknown prices, rate-card revisions, civil-day
// boundaries, the dispatch gate, and export. No engine and no provider call is
// made anywhere in this script.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const { StateStore } = require(join(ROOT, "dist/main/main/state/store.js"));
const { CostLedger } = require(join(ROOT, "dist/main/main/work/costs.js"));
const { civilDayRange, estimateCostPico, ratePerMillionToPicoPerToken } = require(
  join(ROOT, "dist/main/main/work/cost-math.js"),
);

const base = mkdtempSync(join(tmpdir(), "mona-p12-"));
const stateDir = join(base, "state");
const workspace = join(base, "workspace");
mkdirSync(workspace, { recursive: true });

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
const ledger = new CostLedger(store);
const project = await store.openProject(workspace);
const projectId = project.project.id;
const thread = await store.upsertThread({
  id: "thr_p12sample0000001",
  projectId,
  engineThreadId: "thr_engine_p12_0001",
  title: "Cost sample",
});

const RATE = {
  cacheHitPico: ratePerMillionToPicoPerToken(0.28),
  cacheMissPico: ratePerMillionToPicoPerToken(2.8),
  outputPico: ratePerMillionToPicoPerToken(0.42),
  toolCallPico: null,
  reasoningInOutput: true,
};

const checks = {};
const detail = {};
const log = (line) => process.stderr.write(`${line}\n`);

// 1. Exact integer arithmetic for both bucket shapes.
const inclusive = estimateCostPico(
  {
    inputTokens: 1200,
    cachedTokens: 800,
    cacheMissTokens: null,
    outputTokens: 40,
    reasoningTokens: 12,
  },
  RATE,
  "inclusive_input",
);
const exclusive = estimateCostPico(
  {
    inputTokens: 12659,
    cachedTokens: 40448,
    cacheMissTokens: null,
    outputTokens: 313,
    reasoningTokens: 8,
  },
  RATE,
  "exclusive_input",
);
checks.inclusive_bucket_exact =
  inclusive.ok && inclusive.pico === 400 * 2_800_000 + 800 * 280_000 + 40 * 420_000;
checks.exclusive_bucket_exact =
  exclusive.ok && exclusive.pico === 12_659 * 2_800_000 + 40_448 * 280_000 + 313 * 420_000;
detail.arithmetic = {
  inclusive: inclusive.ok ? inclusive.pico : null,
  exclusive: exclusive.ok ? exclusive.pico : null,
};

// 2. A complete thread total is stored as an exact per-turn delta, and a replay
//    of the same turn does not add a second charge.
const firstTurn = {
  projectId,
  threadId: thread.id,
  turnId: "turn_p12_000000000001",
  provider: "deepseek",
  model: "deepseek-flash",
  usage: {
    inputTokens: 1200,
    cachedTokens: 800,
    cacheMissTokens: null,
    outputTokens: 40,
    reasoningTokens: 12,
  },
  capturedAt: "2026-11-11T00:00:10.000Z",
  windowSince: thread.createdAt,
  aggregate: { costUsd: 0.001, costComplete: true },
};
const recorded = await ledger.recordTurn(firstTurn);
const replayed = await ledger.recordTurn(firstTurn);
checks.replay_single_row = recorded.id === replayed.id;
checks.reported_cost_exact =
  recorded.costState === "reported" && recorded.costPicoUsd === 1_000_000_000;

const second = await ledger.recordTurn({
  ...firstTurn,
  turnId: "turn_p12_000000000002",
  capturedAt: "2026-11-11T00:01:10.000Z",
  aggregate: { costUsd: 0.0035, costComplete: true },
});
checks.thread_delta_exact =
  second.costPicoUsd === 2_500_000_000 && second.costAllocation === "thread_delta";

// 3. A turn with tokens but no complete price is unknown, not zero.
const unpriced = await ledger.recordTurn({
  ...firstTurn,
  turnId: "turn_p12_000000000003",
  capturedAt: "2026-11-11T00:02:10.000Z",
  aggregate: { costUsd: 0, costComplete: false },
});
checks.unpriced_stays_unknown = unpriced.costState === "unknown_price" && unpriced.costUsd === null;

// 4. A recorded rate card produces an explicit estimate, and a later card
//    revision does not rewrite the priced turn.
const cardOne = await ledger.setRateCard({
  provider: "deepseek",
  model: "deepseek-flash",
  cacheHitPerMillion: 0.28,
  cacheMissPerMillion: 2.8,
  outputPerMillion: 0.42,
  readAt: "2026-11-11T00:00:00.000Z",
  sourceRef: "sample fixture card",
});
const estimated = await ledger.recordTurn({
  ...firstTurn,
  threadId: thread.id,
  turnId: "turn_p12_000000000004",
  capturedAt: "2026-11-11T00:03:10.000Z",
  aggregate: null,
});
checks.estimate_from_card_exact =
  estimated.costState === "estimated" && estimated.costPicoUsd === inclusive.pico;
checks.estimate_names_its_card = estimated.rateCardId === cardOne.id;

const cardTwo = await ledger.setRateCard({
  provider: "deepseek",
  model: "deepseek-flash",
  cacheHitPerMillion: 1,
  cacheMissPerMillion: 1,
  outputPerMillion: 1,
});
const preserved = await store.getUsageForTurn(thread.id, "turn_p12_000000000004");
checks.rate_revision_preserves_history =
  cardTwo.revisionNo === 2 && preserved.costPicoUsd === inclusive.pico;

const preview = await ledger.previewRecalculation(projectId, {
  provider: "deepseek",
  model: "deepseek-flash",
  cacheHitPerMillion: 0.28,
  cacheMissPerMillion: 2.8,
  outputPerMillion: 0.42,
});
checks.recalc_preview_is_read_only =
  preview.turns === 4 &&
  (await store.getUsageForTurn(thread.id, "turn_p12_000000000004")).costPicoUsd === inclusive.pico;

// 5. Civil-day boundaries, including a DST transition.
const dst = civilDayRange("2026-03-08T15:00:00.000Z", "America/New_York");
checks.civil_day_dst =
  dst.day === "2026-03-08" &&
  dst.startIso === "2026-03-08T05:00:00.000Z" &&
  dst.endIso === "2026-03-09T04:00:00.000Z" &&
  (Date.parse(dst.endIso) - Date.parse(dst.startIso)) / 3_600_000 === 23;
detail.civil_day = dst;

// 6. Budgets: warn before the next dispatch, then stop it; a day budget uses
//    the user's civil day.
await ledger.setBudget({ projectId, scope: "project", limitUsd: 0.01, warnUsd: 0.002 });
const warnGate = await ledger.dispatchGate(projectId, "2026-11-11T00:10:00.000Z");
checks.budget_warns = warnGate.allowed && warnGate.level === "warn";
checks.budget_reports_lower_bound = warnGate.evaluations[0]?.unknownTurns === 1;

await ledger.setBudget({ projectId, scope: "project", limitUsd: 0.002 });
const stopGate = await ledger.dispatchGate(projectId, "2026-11-11T00:11:00.000Z");
checks.budget_stops_next_dispatch = !stopGate.allowed && stopGate.level === "stop";

await ledger.clearBudget({
  projectId,
  budgetId: stopGate.evaluations[0].budgetId,
  expectedRevision: 2,
});
checks.budget_clear_restores_dispatch = (
  await ledger.dispatchGate(projectId, "2026-11-11T00:12:00.000Z")
).allowed;

await ledger.setBudget({
  projectId,
  scope: "day",
  limitUsd: 0.001,
  timeZone: "America/Los_Angeles",
});
const previousDay = await ledger.dispatchGate(projectId, "2026-11-11T05:00:00.000Z", {
  timeZone: "America/Los_Angeles",
});
const sameDay = await ledger.dispatchGate(projectId, "2026-11-11T22:00:00.000Z", {
  timeZone: "America/Los_Angeles",
});
checks.day_budget_uses_civil_day = previousDay.allowed === false && sameDay.allowed === true;
detail.day_gate = {
  previous_day_allowed: previousDay.allowed,
  same_day_allowed: sameDay.allowed,
};

// 7. The view and the export are honest about what is unknown.
const view = await ledger.ledger(projectId, {
  timeZone: "UTC",
  generatedAt: "2026-11-11T00:20:00.000Z",
});
checks.view_incomplete_when_unknown =
  view.totals.costComplete === false && view.totals.unknownTurns === 1;
checks.balance_unavailable = view.balance.available === false;
const csv = await ledger.exportLedger(projectId, { format: "csv", timeZone: "UTC" });
checks.export_csv_has_states =
  csv.content.includes("unknown_price") &&
  csv.content.includes("estimated") &&
  csv.content.includes("reported");
const json = await ledger.exportLedger(projectId, { format: "json", timeZone: "UTC" });
checks.export_json_has_no_balance = JSON.parse(json.content).balance === null;

const ok = Object.values(checks).every(Boolean);
log(`P12 cost sample: ${ok ? "PASS" : "FAIL"}`);
for (const [name, value] of Object.entries(checks)) log(`  ${value ? "ok  " : "FAIL"} ${name}`);

const redact = (value) =>
  value
    .split(base)
    .join("<tmp>")
    .split(process.env.HOME ?? "")
    .join("~");

console.log(
  JSON.stringify(
    {
      schema_version: 1,
      prompt: "P12",
      ok,
      checks,
      detail,
      totals: view.totals,
      routes: view.routes,
      days: view.byDay.map((row) => ({
        day: row.key,
        turns: row.totals.turns,
        cost_usd: row.totals.costUsd,
      })),
      notes: view.notes.map(redact),
      database: redact(join(stateDir, "mona.sqlite")),
    },
    null,
    2,
  ),
);

await store.close();
rmSync(base, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
