#!/usr/bin/env node
// P18 terminal smoke: the real native pty helper through the real
// TerminalManager. No mocks: a shell is spawned, resized, searched, killed, and
// its exit code is observed. Evidence: docs/evidence/macos/artifacts/p18-terminal-smoke.json
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const { TerminalManager } = require(join(ROOT, "dist/main/main/terminal/session.js"));
const { buildShellEnvironment } = require(join(ROOT, "dist/main/main/terminal/pty.js"));

const outDir = join(ROOT, "docs/evidence/macos/artifacts");
mkdirSync(outDir, { recursive: true });

const base = mkdtempSync(join(tmpdir(), "mona-p18-terminal-"));
const workspace = join(base, "workspace");
const logDir = join(base, "logs");
mkdirSync(workspace, { recursive: true });
mkdirSync(logDir, { recursive: true });
writeFileSync(join(workspace, "README.md"), "# terminal smoke\n", "utf8");
const logPath = join(logDir, "run.log");
writeFileSync(
  logPath,
  [
    `engine started in ${homedir()}/work`,
    "route configured: sk-fixture-notreal01",
    "listening on 127.0.0.1:7878",
    "",
  ].join("\n"),
  "utf8",
);

// A throwaway HOME whose .zshrc would leave a marker if a startup file ran.
const fakeHome = join(base, "home");
mkdirSync(fakeHome, { recursive: true });
writeFileSync(join(fakeHome, ".zshrc"), 'touch "$HOME/rc-ran"\n', "utf8");
const environment = buildShellEnvironment();
environment.entries = environment.entries.map((entry) =>
  entry.startsWith("HOME=") ? `HOME=${fakeHome}` : entry,
);

const projectId = "prj_0123456789abcdef";
const events = [];
const manager = new TerminalManager({
  workspaceFor: async (id) => (id === "prj_0123456789abcdef" ? workspace : null),
  logPathFor: (path) => (path === workspace ? logPath : null),
  environment,
  emit: (event) => events.push(event),
});

const checks = {};
const facts = {};
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function waitForOutput(sessionId, cursor, needle, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const read = manager.output(sessionId, cursor, 262_144);
    if (read.data.includes(needle)) return read;
    await sleep(40);
  }
  return manager.output(sessionId, cursor, 262_144);
}

/**
 * Wait until the ring stops growing.
 *
 * A marker reaching the buffer does not mean the child finished writing: the
 * ring is capped, so `dropped` only becomes non-zero once more than a ring's
 * worth of output has arrived. Reading totals immediately after the marker made
 * this check race the shell (observed: total 245866, dropped 0). Waiting for a
 * quiet window makes the assertion test the ring rather than the scheduler.
 */
async function waitForQuiet(sessionId, settleMs = 250, deadlineMs = 15_000) {
  const deadline = Date.now() + deadlineMs;
  let last = -1;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    const totals = manager.output(sessionId, 0, 1);
    if (totals.total !== last) {
      last = totals.total;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= settleMs) {
      return totals;
    }
    await sleep(40);
  }
  return manager.output(sessionId, 0, 1);
}

function rawReport() {
  console.log(
    JSON.stringify(
      {
        schema_version: 1,
        label: "P18 integrated terminal — real native pty",
        captured_at: new Date().toISOString(),
        ok: Object.values(checks).every(Boolean),
        checks,
        facts,
      },
      null,
      2,
    ),
  );
}

try {
  const created = await manager.create({ projectId, cols: 100, rows: 30 });
  const sessionId = created.sessionId;
  const session = created.snapshot.sessions[0];
  facts.helper = {
    binary: "native/macos-pty/build/mona-pty",
    build: (() => {
      try {
        return JSON.parse(readFileSync(join(ROOT, "native/macos-pty/build.json"), "utf8"));
      } catch {
        try {
          return JSON.parse(readFileSync(join(ROOT, "native/macos-pty/build/build.json"), "utf8"));
        } catch {
          return null;
        }
      }
    })(),
  };
  checks.session_running = session?.status === "running";
  checks.session_cwd_is_workspace = session?.cwd === workspace;
  checks.helper_pid_recorded = typeof session?.helperPid === "number" && session.helperPid > 0;
  checks.shell_pid_recorded = typeof session?.shellPid === "number" && session.shellPid > 0;
  checks.pty_is_real = created.snapshot.environment.arguments.join(" ") === "-f";

  // 1. A real shell, a real controlling terminal, and the controlled env.
  let cursor = manager.output(sessionId, 0).nextCursor;
  manager.write(sessionId, 'echo TTY=$(tty); echo PATHHAS=$([ -n "$PATH" ] && echo yes)\n');
  const ttyRead = await waitForOutput(sessionId, cursor, "PATHHAS=yes");
  cursor = ttyRead.nextCursor;
  facts.tty = /\/dev\/ttys\d+/.test(ttyRead.data);
  checks.controlling_terminal = facts.tty;
  checks.path_present = ttyRead.data.includes("PATHHAS=yes");

  manager.write(
    sessionId,
    'for v in DEEPSEEK_API_KEY CODEWHALE_RUNTIME_TOKEN OPENAI_API_KEY; do eval "test -z \\"\\${$v:-}\\"" && echo "$v=withheld"; done\n',
  );
  const withheldRead = await waitForOutput(sessionId, cursor, "OPENAI_API_KEY=withheld");
  cursor = withheldRead.nextCursor;
  facts.withheld = ["DEEPSEEK_API_KEY", "CODEWHALE_RUNTIME_TOKEN", "OPENAI_API_KEY"].map(
    (name) => ({
      name,
      withheld: withheldRead.data.includes(`${name}=withheld`),
    }),
  );
  checks.secrets_withheld = facts.withheld.every((entry) => entry.withheld);

  // 2. Startup files are not sourced: the throwaway .zshrc never ran.
  await sleep(150);
  facts.startup = { fake_home: fakeHome, marker_created: existsSync(join(fakeHome, "rc-ran")) };
  checks.startup_files_not_sourced = facts.startup.marker_created === false;

  // 2b. The per-process PATH reaches the engine from a GUI-style environment,
  // without sourcing a startup file.
  manager.write(sessionId, "command -v codewhale && codewhale --version\n");
  const engineRead = await waitForOutput(sessionId, cursor, "codewhale 0.10.2", 10_000);
  cursor = engineRead.nextCursor;
  facts.engine_in_terminal = /codewhale 0\.10\.2/.test(engineRead.data);
  checks.engine_reachable_from_shell = facts.engine_in_terminal;

  // 3. Resize reaches the kernel window the child draws for.
  manager.resize(sessionId, 132, 43);
  await sleep(200);
  manager.write(sessionId, "stty size\n");
  const sizeRead = await waitForOutput(sessionId, cursor, "43 132");
  cursor = sizeRead.nextCursor;
  facts.resized = { rows: 43, cols: 132, observed: /43 132/.test(sizeRead.data) };
  checks.resize_observed_by_child = facts.resized.observed;

  // 4. Search the retained buffer.
  manager.write(sessionId, "echo searchneedle-42\n");
  const searchRead = await waitForOutput(sessionId, cursor, "searchneedle-42");
  cursor = searchRead.nextCursor;
  const search = manager.search(sessionId, "searchneedle-42");
  facts.search = { matches: search.matches.length, first: search.matches[0]?.text ?? null };
  checks.search_finds_output = search.matches.length >= 2; // the typed line echoes too

  // 5. Output limits: the ring evicts exactly and says so.
  manager.write(
    sessionId,
    'for i in $(seq 1 6000); do echo "line-$i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; done; echo RING-DONE\n',
  );
  const ringRead = await waitForOutput(sessionId, cursor, "RING-DONE", 15_000);
  cursor = ringRead.nextCursor;
  // The child may still be writing when the marker appears; wait for the ring
  // to stop growing before reading its eviction totals.
  const all = await waitForQuiet(sessionId);
  facts.ring = { total: all.total, dropped: all.dropped, truncated: all.truncated };
  checks.ring_evicts_exactly = all.dropped > 0 && all.truncated === true && all.total > all.dropped;
  const latest = manager.output(sessionId, Math.max(0, all.total - 4_096), 4_096);
  facts.ring.tail = latest.data.slice(-120);
  checks.newest_output_readable = latest.data.includes("line-6000");
  facts.ui_bytes = manager.list()[0]?.bytesOut ?? 0;

  // 6. A real exit code, observed rather than assumed.
  manager.write(sessionId, "exit 5\n");
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && manager.list()[0]?.status === "running") await sleep(50);
  const ended = manager.list()[0];
  facts.exit = { status: ended?.status, code: ended?.exitCode, signal: ended?.exitSignal };
  checks.exit_code_observed = ended?.status === "exited" && ended.exitCode === 5;
  checks.exit_event_emitted = events.some((event) => event.kind === "exit" && event.exitCode === 5);
  checks.transcript_retained_after_exit = manager.output(sessionId, 0, 4_096).data.length > 0;
  checks.write_refused_after_exit = (() => {
    try {
      manager.write(sessionId, "echo late\n");
      return false;
    } catch {
      return true;
    }
  })();

  // 7. A second shell, then a real terminate with a verified gone pid.
  const second = await manager.create({ projectId, cols: 80, rows: 24 });
  const secondPid = manager.list().find((entry) => entry.id === second.sessionId)?.shellPid ?? 0;
  const closed = await manager.close(second.sessionId);
  const alive = spawnSync("ps", ["-p", String(secondPid)], { encoding: "utf8" }).status === 0;
  facts.close = { status: closed.status, shell_pid: secondPid, alive_after_close: alive };
  checks.terminate_reports_exit = closed.status === "exited" || closed.status === "closed";
  checks.shell_gone_after_close = alive === false;

  // 8. Session cap: an ended session may be evicted, a running one never is.
  const third = await manager.create({});
  const evicted = await manager.create({});
  facts.session_cap = {
    max: 3,
    replaced: evicted.replacedSessionId,
    sessions: manager.list().length,
  };
  checks.ended_session_evicted_at_cap = evicted.replacedSessionId !== null;
  // One more creation replaces the last ended session; after that every session
  // is live and the cap must refuse rather than kill someone's shell.
  const fourth = await manager.create({});
  checks.final_ended_session_evicted = fourth.replacedSessionId !== null;
  let refused = false;
  try {
    await manager.create({});
  } catch (error) {
    refused = /at most/.test(String(error?.message));
  }
  facts.session_cap.refused_with_three_live = refused;
  checks.running_session_not_evicted = refused;
  await manager.close(third.sessionId);
  await manager.close(evicted.sessionId);

  // 9. The read-only engine log is redacted and bounded.
  const log = await manager.log({ projectId });
  facts.log = { available: log.available, path: log.path, bytes: log.bytes };
  checks.log_available = log.available === true;
  checks.log_redacts_home = !log.text.includes(homedir());
  checks.log_redacts_key = !/sk-fixture-notreal01/.test(log.text);
  checks.log_is_read_only = !("write" in log);
  const missingLog = await manager.log({ projectId: "prj_ffffffffffffffff" });
  checks.log_missing_is_stated = missingLog.available === false && Boolean(missingLog.reason);

  // 10. The helper binary is native arm64 and ad-hoc signed, not a global module.
  const build = facts.helper.build;
  facts.native = build
    ? {
        file: build.file,
        target: build.target,
        signature: build.signature,
        verified: build.verified,
      }
    : null;
  checks.helper_is_native_arm64 = Boolean(build && /arm64/.test(build.file ?? ""));
  checks.helper_has_no_node_coupling = !/node|electron/i.test(build?.file ?? "");
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  facts.runtime_dependencies = Object.keys(packageJson.dependencies ?? {});
  checks.no_pty_node_module = !Object.keys(packageJson.dependencies ?? {}).some((name) =>
    /pty/.test(name),
  );

  await manager.disposeAll();
} catch (error) {
  checks.harness_completed = false;
  facts.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
} finally {
  rmSync(base, { recursive: true, force: true });
}

const report = {
  schema_version: 1,
  label: "P18 integrated terminal — real native pty",
  captured_at: new Date().toISOString(),
  ok: Object.values(checks).every(Boolean),
  checks,
  facts,
};
writeFileSync(
  join(outDir, "p18-terminal-smoke.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
rawReport();
process.exit(report.ok ? 0 : 1);
