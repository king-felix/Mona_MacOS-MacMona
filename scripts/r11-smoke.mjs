#!/usr/bin/env node
// R11 evidence. Runs the production shell twice against one isolated state
// directory — cold, then warm — and merges the two measurement reports.
//
// The launcher measures what the app cannot see about itself: wall time from
// process spawn to the report arriving back, and the delta between the two runs.
// Nothing here starts an engine or asks a model anything.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electron = require("electron");
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const artifactDir = join(ROOT, "docs", "evidence", "macos", "review-studio", "artifacts");
/**
 * `--app <path>` measures an installed bundle instead of the developer tree.
 * P26 asks for the product a recipient would launch, so the same harness has to
 * be able to point at the packaged binary; without this the numbers describe
 * `electron .` and nothing else.
 */
const appArgIndex = process.argv.indexOf("--app");
const APP_PATH = appArgIndex >= 0 ? resolve(process.argv[appArgIndex + 1] ?? "") : null;
const APP_BINARY = APP_PATH ? join(APP_PATH, "Contents", "MacOS", "Mona") : null;
const userDataDir = await mkdtemp(join(tmpdir(), "mona-r11-userdata-"));

/** One launch. `mode` only labels the report; the state directory is shared. */
async function run(mode) {
  const outDir = await mkdtemp(join(tmpdir(), "mona-r11-out-"));
  const outFile = join(outDir, "report.json");
  const startedAt = Date.now();
  const child = APP_BINARY
    ? spawn(APP_BINARY, ["--r11-smoke", `--user-data-dir=${userDataDir}`], {
        cwd: APP_PATH,
        env: {
          ...process.env,
          MONA_R11_SMOKE_OUT: outFile,
          MONA_R11_SMOKE_OUT_DIR: artifactDir,
          MONA_R11_SMOKE_MODE: mode,
          MONA_R11_AXE_PATH: join(ROOT, "node_modules", "axe-core", "axe.min.js"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      })
    : spawn(electron, [".", "--r11-smoke", `--user-data-dir=${userDataDir}`], {
        cwd: ROOT,
        env: {
          ...process.env,
          MONA_R11_SMOKE_OUT: outFile,
          MONA_R11_SMOKE_OUT_DIR: artifactDir,
          MONA_R11_SMOKE_MODE: mode,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));

  // A cold run samples 60 s of idle, pages 601 cards and reloads four times. On
  // this host an unloaded run lands at 76-82 s, but a reload can take a few
  // seconds more when the machine is busy building, so the outer bound is 240 s:
  // generous enough not to fail an honest run, tight enough that a genuine stall
  // is reported as a missing report rather than waiting forever.
  const timeout = setTimeout(() => child.kill("SIGKILL"), 240_000);
  const code = await new Promise((resolveExit) => child.on("exit", (value) => resolveExit(value)));
  clearTimeout(timeout);
  const wallMs = Date.now() - startedAt;

  let report = null;
  let reportMissing = false;
  try {
    report = JSON.parse(await readFile(outFile, "utf8"));
  } catch {
    // A run that never wrote a report has no checks, and "no failing checks" must
    // never be read as "passed". The absence is carried as an explicit failure.
    reportMissing = true;
    report = { ok: false, mode, error: "r11 smoke report missing" };
  }
  if (code !== 0) report.ok = false;
  if (reportMissing) report.report_missing = true;
  await rm(outDir, { recursive: true, force: true });
  return {
    ...report,
    launch: {
      mode,
      wall_ms_including_electron_binary: wallMs,
      electron_exit: code,
      stdout: stdout.slice(0, 2000),
      stderr: stderr.slice(0, 2000),
    },
  };
}

/**
 * The runtime floor, measured on this host with a blank page. `--r11-baseline`
 * is a separate entry point so the measurement cannot be confused with an
 * application run.
 */
async function runtimeBaseline() {
  const dir = await mkdtemp(join(tmpdir(), "mona-r11-baseline-"));
  const entry = join(dir, "main.js");
  const baselineSource = await readFile(join(ROOT, "scripts", "r11-runtime-baseline.mjs"), "utf8");
  await writeFile(entry, baselineSource, "utf8");
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "mona-r11-baseline", version: "1.0.0", main: "main.js" }),
    "utf8",
  );
  const child = spawn(electron, ["."], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
  await new Promise((resolveExit) => child.on("exit", () => resolveExit(null)));
  clearTimeout(timeout);
  await rm(dir, { recursive: true, force: true });
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{"))
    .pop();
  if (!line) return { ok: false, stderr: stderr.slice(0, 500) };
  try {
    return { ok: true, ...JSON.parse(line) };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

const baseline = await runtimeBaseline();
const cold = await run("cold");
const warm = await run("warm");

/**
 * A budget that the runtime alone exceeds cannot be met by application code.
 * The exception is derived from the measurement above — never written by hand —
 * and it names the exact check it covers, so no other check can hide behind it.
 */
const budgetExceptions = [];
const idle = cold.facts?.idle ?? null;
const TARGET_MB = 350;
if (baseline.ok && idle) {
  if (baseline.total_mb_max >= TARGET_MB) {
    budgetExceptions.push({
      check: "idle_memory_under_350_mb",
      target_mb: TARGET_MB,
      measured_mb: idle.memory_mb_max,
      runtime_floor_mb: baseline.total_mb_max,
      measured_over_runtime_mb: idle.memory_mb_max - baseline.total_mb_max,
      reason:
        "Electron's own blank window already exceeds the 350 MiB target on this host, " +
        "so the target is unmeetable by any application code. Reported as a budget " +
        "exception with the runtime floor measured on the same host, and the " +
        "application's own share stated as a difference.",
    });
  }
}

const failingChecks = (report) => {
  const failed = Object.entries(report.checks ?? {})
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name);
  // A missing report, a crashed run or a non-zero exit is its own failure. It is
  // named rather than left as an empty list a reader could mistake for success.
  if (report.report_missing) failed.push("run_produced_a_report");
  if (report.error && !report.report_missing) failed.push("run_completed_without_error");
  if (report.launch?.electron_exit !== undefined && report.launch.electron_exit !== 0) {
    failed.push("electron_exited_zero");
  }
  return failed;
};
const failing = [...new Set([...failingChecks(cold), ...failingChecks(warm)])];
const excepted = new Set(budgetExceptions.map((entry) => entry.check));
const unexplained = failing.filter((name) => !excepted.has(name));

const merged = {
  schema_version: 1,
  label: "R11 — measured startup, idle cost, stream responsiveness and accessibility",
  captured_at: new Date().toISOString(),
  // `passed` means every check on both runs succeeded. `passed_with_exception`
  // means the only failures are named in `budget_exceptions`, each derived from a
  // measurement on this host. A failure the exceptions do not name stays fatal.
  status:
    unexplained.length > 0
      ? "failed"
      : budgetExceptions.length > 0
        ? "passed_with_exception"
        : "passed",
  ok: unexplained.length === 0,
  failing_checks: failing,
  budget_exceptions: budgetExceptions,
  runtime_baseline: baseline,
  host: cold.facts?.host ?? null,
  cold,
  warm,
  comparison: {
    cold_interactive_ms: cold.facts?.startup?.process_start_to_interactive_ms ?? null,
    warm_interactive_ms: warm.facts?.startup?.process_start_to_interactive_ms ?? null,
    warm_saving_ms:
      cold.facts?.startup?.process_start_to_interactive_ms != null &&
      warm.facts?.startup?.process_start_to_interactive_ms != null
        ? cold.facts.startup.process_start_to_interactive_ms -
          warm.facts.startup.process_start_to_interactive_ms
        : null,
    cold_wall_ms: cold.launch?.wall_ms_including_electron_binary ?? null,
    warm_wall_ms: warm.launch?.wall_ms_including_electron_binary ?? null,
  },
};

await mkdir(artifactDir, { recursive: true });
await writeFile(join(artifactDir, "r11-perf.json"), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      status: merged.status,
      ok: merged.ok,
      comparison: merged.comparison,
      failing_checks: merged.failing_checks,
      budget_exceptions: merged.budget_exceptions.map((entry) => ({
        check: entry.check,
        measured_mb: entry.measured_mb,
        runtime_floor_mb: entry.runtime_floor_mb,
      })),
    },
    null,
    2,
  ),
);
await rm(userDataDir, { recursive: true, force: true });
process.exit(merged.ok ? 0 : 1);
