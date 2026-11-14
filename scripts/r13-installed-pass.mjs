#!/usr/bin/env node
// R13 — exercise the *installed* app, not the developer tree.
//
// The repository's real-window smokes spawn `electron .`, so they prove the
// source tree. This driver spawns the binary LaunchServices would run
// (`<app>/Contents/MacOS/Mona`) with the same smoke modes, an isolated
// user-data directory and a temporary capture directory, then reports what the
// installed bundle actually did: exit status, the smoke's own checks, leftover
// helper processes, and where the captures are.
//
//   node scripts/r13-installed-pass.mjs
//   node scripts/r13-installed-pass.mjs --app /Applications/Mona.app --modes shell,command
//
// It starts no engine and makes no model request: the modes it drives are the
// repository's own fixture-driven UI smokes.

import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const appPath = resolve(option("--app", "/Applications/Mona.app"));
const binary = join(appPath, "Contents/MacOS/Mona");
const outPath = resolve(
  option(
    "--out",
    join(ROOT, "docs/evidence/macos/review-studio/artifacts/r13-installed-pass.json"),
  ),
);
const capturesOutDir = join(outPath, "..");
const modes = option("--modes", "shell,command,immersive,history")
  .split(",")
  .map((mode) => mode.trim());

const MODES = {
  shell: {
    flag: "--shell-smoke",
    env: (dir) => ({
      MONA_SHELL_SMOKE_OUT: join(dir, "report.json"),
      MONA_SHELL_SMOKE_OUT_DIR: join(dir, "captures"),
    }),
    timeoutMs: 120_000,
    covers:
      "catalog, studio, drafts, activity strip, follow-up queue, usage HUD, board, changes, cost, settings, palette, layout, zoom",
  },
  command: {
    flag: "--command-smoke",
    env: (dir) => ({
      MONA_COMMAND_SMOKE_OUT: join(dir, "report.json"),
      MONA_COMMAND_SMOKE_OUT_DIR: join(dir, "captures"),
    }),
    timeoutMs: 120_000,
    covers: "slash-command autocomplete, keyboard selection, dispatch interception, 200 % scale",
  },
  immersive: {
    flag: "--immersive-smoke",
    env: (dir) => ({
      MONA_IMMERSIVE_SMOKE_OUT: join(dir, "report.json"),
      MONA_IMMERSIVE_SMOKE_OUT_DIR: join(dir, "captures"),
    }),
    timeoutMs: 150_000,
    covers: "Focus Studio, native fullscreen transitions, composer and draft survival",
  },
  history: {
    flag: "--history-smoke",
    env: (dir) => ({
      MONA_HISTORY_SMOKE_OUT: join(dir, "report.json"),
      MONA_HISTORY_SMOKE_OUT_DIR: join(dir, "captures"),
    }),
    timeoutMs: 180_000,
    covers: "keyset history paging, item identity, archived/current thread selection, anchoring",
  },
};

function pidsMatching(pattern) {
  try {
    const stdout = execFileSync("/usr/bin/pgrep", ["-f", pattern], { encoding: "utf8" });
    return stdout
      .split("\n")
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function readdirRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readdirRecursive(path));
    else out.push(path);
  }
  return out;
}

async function runMode(name, config) {
  const dir = mkdtempSync(join(tmpdir(), `mona-r13-${name}-`));
  const userDataDir = join(dir, "userdata");
  mkdirSync(userDataDir, { recursive: true });
  const started = Date.now();
  const child = spawn(binary, [config.flag, `--user-data-dir=${userDataDir}`], {
    cwd: appPath,
    env: { ...process.env, ...config.env(dir) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const pid = child.pid;
  const timedOut = await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveExit(true);
    }, config.timeoutMs);
    child.on("exit", () => {
      clearTimeout(timer);
      resolveExit(false);
    });
  });

  let report = null;
  const reportPath = join(dir, "report.json");
  if (existsSync(reportPath)) {
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      report = null;
    }
  }
  const checks = report?.checks ?? {};
  const failed = Object.entries(checks)
    .filter(([, value]) => value === false)
    .map(([key]) => key);
  const capturesDir = join(dir, "captures");
  const captureFiles = existsSync(capturesDir) ? readdirRecursive(capturesDir) : [];
  // A screenshot is a run record of the installed artifact, so the ones that
  // show the review's surfaces are kept beside the report. The rest of the
  // temporary tree is removed: a smoke that leaves its fixtures behind is its
  // own problem (RD-010).
  const kept = [];
  for (const file of captureFiles) {
    const name = file.slice(capturesDir.length + 1);
    if (keepCapture(name)) {
      const target = join(capturesOutDir, `r13-${name}`);
      copyFileSync(file, target);
      kept.push({ name: target.split("/").pop(), bytes: statSync(file).size });
    }
  }
  const captures = kept;

  const result = {
    mode: name,
    covers: config.covers,
    flag: config.flag,
    exit: child.exitCode,
    signal: child.signalCode,
    timed_out: timedOut,
    elapsed_ms: Date.now() - started,
    report_present: report !== null,
    report_ok: report?.ok === true,
    checks_total: Object.keys(checks).length,
    checks_failed: failed,
    captures,
    capture_dir: captures.length > 0 ? capturesDir : null,
    stderr: stderr.trim().slice(0, 600),
    stdout: stdout.trim().slice(0, 600),
    process_gone: !pidsMatching(`${appPath}/Contents/MacOS/Mona`).includes(pid),
    helpers_left: pidsMatching(`${appPath}/Contents/MacOS/Mona Helper`).length,
  };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

function keepCapture(name) {
  return /^(r05-focus|r05-studio-normal|r03-command-menu|r02-history|p-r09-usage|p-r08-activity)/.test(
    name,
  );
}

const results = [];
for (const name of modes) {
  const config = MODES[name];
  if (!config) {
    results.push({ mode: name, error: "unknown mode" });
    continue;
  }
  if (!existsSync(binary)) {
    results.push({ mode: name, error: `no binary at ${binary}` });
    continue;
  }
  results.push(await runMode(name, config));
}

const manifestPath = join(appPath, "Contents/Resources/component-manifest.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;

const ok = results.every(
  (result) =>
    result.error === undefined &&
    result.exit === 0 &&
    result.report_ok === true &&
    result.checks_failed.length === 0 &&
    result.process_gone === true &&
    result.helpers_left === 0,
);

const report = {
  schema_version: 1,
  label: "R13 installed-artifact pass",
  captured_at: new Date().toISOString(),
  app: appPath,
  build: manifest?.build ?? null,
  channel: manifest?.channel ?? null,
  host: {
    macos: execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
    architecture: execFileSync("/usr/bin/uname", ["-m"], { encoding: "utf8" }).trim(),
  },
  ok,
  modes: results,
  note:
    "Each mode spawns the installed binary (the one LaunchServices runs) with its own isolated " +
    "user-data directory and a temporary capture directory. The checks are the repository's own " +
    "fixture-driven UI smokes; no engine is started and no model request is made.",
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(ok ? 0 : 1);
