#!/usr/bin/env node
// Real Electron lifecycle proof for P04:
//  - the app owns a supervised process tree;
//  - a renderer crash does not kill main or the tree;
//  - closing the last window keeps the work alive;
//  - Dock reopen shows the same runtime;
//  - a second launcher hands its folder to the existing owner and exits;
//  - Quit interrupts/stops the owned tree, and every child is gone afterwards.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const electron = require("electron");
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const dir = mkdtempSync(join(tmpdir(), "mona-lifecycle-"));
const outFile = join(dir, "lifecycle.json");
const readyFile = join(dir, "ready");
const openPath = mkdtempSync(join(tmpdir(), "mona-open-request-"));
const supervisor = join(ROOT, "native/macos-supervisor/build/mona-supervisor");

if (!existsSync(supervisor)) {
  console.log(JSON.stringify({ ok: false, error: "build the native supervisor first" }, null, 2));
  process.exit(1);
}

function launch(extraArgs, extraEnv) {
  const child = spawn(electron, [".", ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, PATH: "/usr/bin:/bin", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => (log.stdout += chunk));
  child.stderr.on("data", (chunk) => (log.stderr += chunk));
  const exit = new Promise((resolveExit) =>
    child.on("exit", (code, signal) => resolveExit({ code, signal })),
  );
  return { child, log, exit };
}

function waitForFile(path, timeoutMs) {
  return new Promise((resolveWait, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (existsSync(path)) {
        clearInterval(timer);
        resolveWait(true);
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${path}`));
      }
    }, 100);
  });
}

function isLive(pid) {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  const stat = (result.stdout ?? "").trim();
  return stat.length > 0 && !stat.startsWith("Z");
}

const owner = launch(["--lifecycle-smoke"], {
  MONA_LIFECYCLE_SMOKE_OUT: outFile,
  MONA_LIFECYCLE_SMOKE_READY: readyFile,
  MONA_LIFECYCLE_SMOKE_OPEN_PATH: openPath,
});

let secondExit = null;
let ownerExit = null;
let error = null;
let evidence = null;

try {
  await waitForFile(readyFile, 45_000);
  // A second launch with a folder must dispatch to the owner, not own anything.
  const second = launch([openPath], {});
  secondExit = await Promise.race([
    second.exit,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout({ timeout: true }), 20_000)),
  ]);
  if (secondExit.timeout) {
    second.child.kill("SIGKILL");
    await second.exit;
  }
  ownerExit = await Promise.race([
    owner.exit,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout({ timeout: true }), 60_000)),
  ]);
  if (ownerExit.timeout) {
    owner.child.kill("SIGKILL");
    await owner.exit;
  }
  evidence = JSON.parse(readFileSync(outFile, "utf8"));
} catch (caught) {
  error = String(caught);
  owner.child.kill("SIGKILL");
  await owner.exit;
}

const phases = Object.fromEntries((evidence?.phases ?? []).map((phase) => [phase.phase, phase]));
const pids = evidence?.pids?.tree ?? [];
const shutdown = evidence?.shutdown?.shutdownReceipt ?? null;
const aliveAfterQuit = pids.filter(isLive);

const checks = {
  owner_exit_zero: ownerExit?.code === 0,
  second_instance_exit_zero: secondExit?.code === 0,
  evidence_written: evidence !== null,
  runtime_started: phases.started?.state === "running",
  tree_alive_before_crash: (phases.started?.alive ?? []).length >= 2,
  sleep_became_reconnecting: phases.sleep?.runtime_state === "reconnecting",
  sleep_kept_process: phases.sleep?.child_alive === true,
  wake_resumed: phases.wake?.resumed === true,
  wake_kept_same_work: phases.wake?.same_work === true,
  renderer_crash_kept_main: phases.renderer_crash?.main_alive === true,
  renderer_crash_counted: (phases.renderer_crash?.renderer_crashes ?? 0) >= 1,
  renderer_crash_kept_work: phases.renderer_crash?.child_alive === true,
  window_closed_app_alive: phases.window_closed?.windows === 0,
  window_closed_kept_work: phases.window_closed?.child_alive === true,
  dock_reopen_created_window: phases.dock_reopen?.windows === 1,
  dock_reopen_same_work: phases.dock_reopen?.same_work === true,
  second_instance_dispatched: phases.second_instance?.received?.path === openPath,
  quit_stopped_tree: shutdown?.stopped === true,
  quit_reported_no_rollback: shutdown?.rollback === "not_promised",
  quit_receipt_names_interrupt: typeof shutdown?.interrupted === "boolean",
  all_children_dead_after_quit: aliveAfterQuit.length === 0,
};

const ok = error === null && Object.values(checks).every(Boolean);
const report = {
  ok,
  checks,
  error,
  pids,
  alive_after_quit: aliveAfterQuit,
  shutdown,
  evidence,
  owner_log: {
    stdout: owner.log.stdout.slice(0, 2000),
    stderr: owner.log.stderr.slice(0, 2000),
  },
  second_exit: secondExit,
};
console.log(JSON.stringify(report, null, 2));
rmSync(dir, { recursive: true, force: true });
rmSync(openPath, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
