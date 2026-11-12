#!/usr/bin/env node
// P18 capability coverage smoke.
//
// Three independent checks, all deterministic and read-only:
//   1. the checked-in inventory matches the P18 reconciliation (no drift in the file)
//   2. every discovered CLI capability answers `--help` on the installed binary
//   3. the coverage report is computed from the rows, and the engine probe matches
//      the recorded version/commit with no unexplained additions or removals
//
// Evidence: docs/evidence/macos/artifacts/p18-capability-coverage.{json,md}
// and p18-capability-smoke.json.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const OUT = join(ROOT, "docs/evidence/macos/artifacts");
mkdirSync(OUT, { recursive: true });

const { CapabilityExplorer, computeCoverage, loadInventory, probeDrift, toRowView } = require(
  join(ROOT, "dist/main/main/work/capability.js"),
);
const { entryTargetIsKnown } = require(join(ROOT, "dist/main/shared/contracts/capability.js"));

const INVENTORY = join(ROOT, "docs/codewhale-capabilities-macos.json");
const checks = {};
const facts = {};

const reconcile = spawnSync("node", [join(ROOT, "tools/p18-coverage/reconcile.mjs")], {
  encoding: "utf8",
  cwd: ROOT,
});
let reconcileResult = null;
try {
  reconcileResult = JSON.parse(reconcile.stdout);
} catch {
  reconcileResult = null;
}
checks.reconcile_in_sync = reconcile.status === 0 && reconcileResult?.ok === true;

const inventory = loadInventory(INVENTORY);
const rows = inventory.capabilities.map(toRowView);
const coverage = computeCoverage(rows);
facts.coverage = coverage;
checks.inventory_valid = rows.length === inventory.capabilities.length && rows.length >= 40;
checks.coverage_math =
  coverage.verified + coverage.unqualified + coverage.unavailable + coverage.blockedGaps ===
  coverage.rowsTotal;
checks.every_row_has_route = rows.every(
  (row) => row.invocation.length > 0 && row.helpSource.length > 0 && row.tests.length > 0,
);
const deadTargets = rows
  .filter((row) => !entryTargetIsKnown(row.entryPoint))
  .map((row) => `${row.id}:${row.entryPoint.kind}/${row.entryPoint.target}`);
facts.dead_targets = deadTargets;
checks.entry_targets_exist_in_this_build = deadTargets.length === 0;
checks.parity_not_claimed = coverage.complete === false;

// --- live engine: drift and per-command help -------------------------------
const { drift } = await probeDrift(rows, inventory);
facts.drift = drift;
checks.drift_checked = drift.checked === true;
checks.drift_version_matches = drift.versionMatch === true;
checks.drift_commit_matches = drift.commitMatch === true;
checks.drift_no_additions = drift.additions.length === 0;
checks.drift_no_removals = drift.removals.length === 0;

const engineBinary =
  rows.find((row) => row.scope === "cli") && process.env.PATH
    ? spawnSync("sh", ["-c", "command -v codewhale"], { encoding: "utf8" }).stdout.trim()
    : "";
facts.engine_binary = engineBinary || null;

const helpResults = [];
for (const row of rows.filter((entry) => entry.scope === "cli")) {
  if (!engineBinary) {
    helpResults.push({ name: row.name, exit: null, ok: false, note: "engine binary not found" });
    continue;
  }
  // The help source is the row's own recorded probe, so a command that answers to
  // a bare invocation is checked exactly as recorded.
  const args = row.helpSource
    .replace(/^codewhale\s*/, "")
    .split(/\s+/)
    .filter(Boolean);
  const result = spawnSync(engineBinary, args, {
    encoding: "utf8",
    timeout: 8_000,
    maxBuffer: 256 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const ok =
    result.status === 0 &&
    (/Usage:/i.test(output) || /Options:/i.test(output) || /Commands:/i.test(output));
  helpResults.push({ name: row.name, exit: result.status, ok, bytes: output.length });
}
facts.cli_help = helpResults;
checks.cli_help_all_answer = helpResults.every((entry) => entry.ok);
checks.cli_rows_covered = helpResults.length === rows.filter((row) => row.scope === "cli").length;

// --- verified terminal rows: run the exact route, not only `--help` ---------
// A row may only say "verified" while something actually ran its route. The
// optional-argument form (`help [COMMAND]`) is stripped so the probe is the
// real bare command.
const executed = [];
for (const row of rows) {
  if (row.status !== "verified" || row.entryPoint.kind !== "terminal") continue;
  if (!engineBinary) {
    executed.push({ id: row.id, name: row.name, ok: false, note: "engine binary not found" });
    continue;
  }
  const argv = row.invocation
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .replace(/^codewhale\s*/, "")
    .split(/\s+/)
    .filter(Boolean);
  const result = spawnSync(engineBinary, argv, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 512 * 1024,
  });
  const stdout = result.stdout ?? "";
  executed.push({
    id: row.id,
    name: row.name,
    argv,
    exit: result.status,
    bytes: stdout.length,
    ok: result.status === 0 && stdout.trim().length > 0,
  });
}
facts.executed_terminal_rows = executed;
checks.verified_terminal_rows_executed = executed.length > 0 && executed.every((entry) => entry.ok);

// --- the report the Capability screen exports ------------------------------
const stubStore = {
  getSettings: async () => null,
  putSettings: async (scope, value) => ({
    scope,
    version: 1,
    value,
    updatedAt: new Date().toISOString(),
  }),
};
const explorer = new CapabilityExplorer({ store: stubStore, inventoryPath: INVENTORY });
const report = await explorer.report();
const snapshot = await explorer.snapshot();
facts.features = snapshot.features;
checks.features_read = snapshot.features.length > 0;
checks.report_names_gaps =
  report.markdown.includes("## Gaps") && report.markdown.includes("MONA-CAP-018");
checks.report_states_no_parity = /Full parity is not claimed/.test(report.markdown);

writeFileSync(join(OUT, "p18-capability-coverage.md"), report.markdown, "utf8");
writeFileSync(
  join(OUT, "p18-capability-coverage.json"),
  `${JSON.stringify(JSON.parse(report.json), null, 2)}\n`,
  "utf8",
);

const summary = {
  schema_version: 1,
  label: "P18 capability coverage — pinned 0.10.2",
  captured_at: new Date().toISOString(),
  ok: Object.values(checks).every(Boolean),
  checks,
  facts,
};
writeFileSync(
  join(OUT, "p18-capability-smoke.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
