#!/usr/bin/env node
// P20 failure smoke: real stores, real filesystem faults, real child processes.
//
// Every check below injects a fault the product will actually meet (a killed
// writer, a full disk, a stale revision, a corrupted database, an interrupted
// restore, a hostile archive, a repository hook, a missing artifact) and then
// reads the durable result back. Nothing is mocked except the clock and the
// filesystem free-space probe, and both are labelled.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const { StateStore } = require(join(ROOT, "dist/main/main/state/store.js"));
const { readArchive, writeArchive, extractArchive } = require(
  join(ROOT, "dist/main/main/state/safe-archive.js"),
);
const { redactDiagnostics } = require(join(ROOT, "dist/main/main/work/settings.js"));
const { buildGitEnvironment } = require(join(ROOT, "dist/main/main/work/git.js"));

const base = mkdtempSync(join(tmpdir(), "mona-p20-smoke-"));
const report = {
  schema_version: 1,
  label: "P20 — failure injection across durable boundaries",
  captured_at: new Date().toISOString(),
  ok: false,
  checks: {},
  observations: {},
  error: null,
  first_failure: null,
};

const check = (name, value, detail = null) => {
  report.checks[name] = { ok: value === true, ...(detail === null ? {} : { detail }) };
  if (value !== true && report.first_failure === null) report.first_failure = name;
};

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
let clockMs = Date.parse("2026-11-12T10:00:00.000Z");
const now = () => new Date((clockMs += 1_000));
let idCounter = 0;
const newId = (prefix) => `${prefix}_${(idCounter += 1).toString(16).padStart(8, "0")}`;

function openStore(name, extra = {}) {
  const dir = join(base, name);
  mkdirSync(join(dir, "state"), { recursive: true });
  return StateStore.open({
    dbPath: join(dir, "state", "mona.sqlite"),
    backupDir: join(dir, "backups"),
    artifactRoot: join(dir, "artifacts"),
    now,
    newId,
    ...extra,
  }).then((store) => ({ store, dir }));
}

function workspace(name) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# workspace\n");
  return dir;
}

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string" ? error.code : null;
}

try {
  // 1. Stale revision: a second writer holding the old revision must lose.
  {
    const { store, dir } = await openStore("revisions");
    const project = await store.createProject({ name: "Kept", rootPath: dir });
    const first = await store.renameProject(project.id, "First", project.revision);
    let code = null;
    try {
      await store.renameProject(project.id, "Second", project.revision);
    } catch (error) {
      code = errorCode(error);
    }
    const reread = await store.getProject(project.id);
    check("stale_revision_refused", code === "STALE_REVISION", { code });
    check(
      "stale_revision_left_row_untouched",
      reread.name === "First" && reread.revision === first.revision,
      { name: reread.name, revision: reread.revision },
    );
    await store.close();
  }

  // 2. Disk full: the write is refused and no partial row exists.
  {
    let free = 8 * 1024 * 1024 * 1024;
    const { store, dir } = await openStore("disk-full", {
      diskProbe: { freeBytes: () => free },
    });
    const project = await store.createProject({ name: "Full", rootPath: dir });
    const task = await store.createTask({
      projectId: project.id,
      title: "Work",
      prompt: "do it",
      acceptance: [{ text: "the check passes", kind: "check" }],
    });
    free = 0;
    let code = null;
    try {
      await store.updateTaskStatus(task.id, "running", task.revision);
    } catch (error) {
      code = errorCode(error);
    }
    const reread = await store.getTask(task.id);
    check("disk_full_refused", code === "DISK_FULL", { code });
    check(
      "disk_full_left_task_pending",
      reread.status === "pending" && reread.revision === task.revision,
      { status: reread.status, revision: reread.revision },
    );
    await store.close();
  }

  // 3. Maintenance barrier: writers queued behind a restore cannot slip in.
  {
    const { store, dir } = await openStore("barrier");
    const project = await store.createProject({ name: "Gated", rootPath: dir });
    const task = await store.createTask({
      projectId: project.id,
      title: "Queued",
      prompt: "queue it",
      acceptance: [{ text: "checked", kind: "check" }],
    });
    let writesDuringMaintenance = 0;
    const maintenance = store.barrier.runMaintenance(async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
      writesDuringMaintenance = store.barrier.snapshot().active;
    });
    const queued = store.updateTaskStatus(task.id, "running", task.revision);
    await maintenance;
    const started = await queued;
    check("maintenance_barrier_quiesces_writers", writesDuringMaintenance === 0, {
      active_writers: writesDuringMaintenance,
    });
    check("queued_write_runs_after_maintenance", started.status === "running");
    await store.close();
  }

  // 4. Corrupted database: open refuses cleanly instead of serving damage.
  {
    const dir = join(base, "corrupt");
    mkdirSync(join(dir, "state"), { recursive: true });
    const dbPath = join(dir, "state", "mona.sqlite");
    writeFileSync(dbPath, "this is not a sqlite database at all");
    let code = null;
    try {
      await StateStore.open({ dbPath, backupDir: join(dir, "backups"), now, newId });
    } catch (error) {
      code = errorCode(error);
    }
    check("corrupt_database_named", code === "CORRUPT_DATABASE", { code });
    check("corrupt_database_preserved_for_diagnosis", existsSync(dbPath));
  }

  // 5. Interrupted restore: a corrupt snapshot changes nothing durable.
  {
    const { store, dir } = await openStore("restore");
    const project = await store.createProject({ name: "Before restore", rootPath: dir });
    const snapshot = join(dir, "snapshot.sqlite");
    await store.backupTo(snapshot);
    check("backup_written", existsSync(snapshot));
    const corrupt = join(dir, "corrupt-snapshot.sqlite");
    writeFileSync(corrupt, "not a database");
    let code = null;
    let journal = null;
    try {
      await store.restoreFrom(corrupt);
    } catch (error) {
      code = errorCode(error);
      journal = error?.details?.journal_path ?? null;
    }
    const reread = await store.getProject(project.id);
    check("interrupted_restore_refused", code === "MAINTENANCE_FAILED", { code });
    check("interrupted_restore_kept_state", reread?.name === "Before restore", {
      name: reread?.name ?? null,
    });
    check("interrupted_restore_kept_journal", typeof journal === "string" && existsSync(journal), {
      journal: journal === null ? null : "recorded",
    });
    await store.close();
  }

  // 6. Missing artifact: the file vanishes after the metadata row exists.
  {
    const { store, dir } = await openStore("artifacts");
    const project = await store.createProject({ name: "Evidence", rootPath: dir });
    const artifact = await store.putArtifact({
      projectId: project.id,
      data: Buffer.from("passing evidence"),
      mediaType: "text/plain",
      source: "smoke",
      retentionClass: "evidence",
    });
    const relPath = `${project.id}/${sha256(Buffer.from("passing evidence"))}.txt`;
    rmSync(join(dir, "artifacts", relPath));
    let code = null;
    try {
      await store.readArtifact(artifact.id);
    } catch (error) {
      code = errorCode(error);
    }
    check("missing_artifact_named", code === "ARTIFACT_MISSING", { code });
    await store.close();
  }

  // 7. Hostile archive: a symlinked directory inside the root cannot redirect a write.
  {
    const root = join(base, "extract-root");
    const outside = join(base, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, "nested"));
    const archive = writeArchive([{ path: "nested/pwned.txt", data: Buffer.from("pwn") }]);
    const result = extractArchive(archive, root);
    check("archive_escape_write_refused", result.written.length === 0, {
      written: result.written,
    });
    check("archive_escape_left_outside_clean", !existsSync(join(outside, "pwned.txt")));
    const bomb = readArchive(
      writeArchive([
        { path: "a.txt", data: Buffer.alloc(64, 0x61) },
        { path: "b.txt", data: Buffer.alloc(64, 0x62) },
      ]),
      { maxTotalBytes: 96 },
    );
    check(
      "archive_over_budget_returns_no_entries",
      bomb.safe === false && bomb.entries.length === 0,
      { problems: bomb.problems.map((problem) => problem.code) },
    );
  }

  // 8. A repository hook cannot see Mona's provider secrets.
  {
    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    const git = (args) =>
      execFileSync("/usr/bin/git", args, {
        cwd: repo,
        encoding: "utf8",
        env: buildGitEnvironment(),
      });
    git(["init", "-b", "main"]);
    git(["config", "user.email", "p20@example.test"]);
    git(["config", "user.name", "P20 Smoke"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(["add", "a.txt"]);
    git(["commit", "-m", "base"]);
    const seen = join(base, "hook-env.txt");
    const hook = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, `#!/bin/sh\nenv > ${JSON.stringify(seen)}\n`, { mode: 0o755 });
    chmodSync(hook, 0o755);
    writeFileSync(join(repo, "b.txt"), "b\n");
    const { GitService } = require(join(ROOT, "dist/main/main/work/git.js"));
    const providerKey = ["sk", "p20", "smoke-fixture-value"].join("-");
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = providerKey;
    try {
      const service = new GitService();
      await service.stage(repo, ["b.txt"]);
      await service.commit(repo, "hooked", ["b.txt"]);
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
    const environment = readFileSync(seen, "utf8");
    check("git_hook_ran", environment.includes("GIT_TERMINAL_PROMPT=0"));
    check("git_hook_saw_no_provider_key", !environment.includes(providerKey));
  }

  // 9. Redaction: a home prefix that is not the home directory survives.
  {
    const { redactHomePath } = require(join(ROOT, "dist/main/main/work/settings.js"));
    check(
      "redaction_respects_path_separator",
      redactHomePath("/Users/victor2/x", "/Users/victor") === "/Users/victor2/x" &&
        redactHomePath("/Users/victor/x", "/Users/victor") === "~/x",
    );
    const secret = ["sk", "p20", "smoke-fixture-value"].join("-");
    const redacted = redactDiagnostics(`key=${secret} home=/Users/victor/x`, "/Users/victor");
    check("redactor_hides_secret", !redacted.text.includes(secret) && redacted.redactions > 0, {
      redactions: redacted.redactions,
    });
  }

  // 10. A killed writer subprocess leaves a readable database.
  {
    const dir = join(base, "killed-writer");
    mkdirSync(join(dir, "state"), { recursive: true });
    const dbPath = join(dir, "state", "mona.sqlite");
    const store = await StateStore.open({
      dbPath,
      backupDir: join(dir, "backups"),
      now,
      newId,
    });
    const crashProject = await store.createProject({
      name: "Crash",
      rootPath: workspace("crash-workspace"),
    });
    await store.close();
    const helper = join(ROOT, "test", "helpers", "crash-writer.mjs");
    await new Promise((resolveChild, rejectChild) => {
      const child = spawn(process.execPath, [helper, dbPath, "during", crashProject.id], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectChild(new Error("crash helper did not reach the kill point"));
      }, 10_000);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (/ready|committed/.test(output)) {
          child.kill("SIGKILL");
          clearTimeout(timer);
          resolveChild();
        }
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (signal === "SIGKILL" || code === 0) resolveChild();
        else rejectChild(new Error(`crash helper failed: ${code}/${signal}`));
      });
    });
    const reopened = await StateStore.open({
      dbPath,
      backupDir: join(dir, "backups"),
      now,
      newId,
    });
    const facts = await reopened.stats();
    check("crash_during_transaction_left_readable_db", facts.integrity.length === 0, {
      integrity: facts.integrity,
    });
    check("crash_left_no_uncommitted_task", facts.tasks === 0, { tasks: facts.tasks });
    await reopened.close();
  }

  report.ok = Object.values(report.checks).every((entry) => entry.ok === true);
} catch (error) {
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  report.ok = false;
}

const outDir = join(ROOT, "docs", "evidence", "macos", "artifacts");
mkdirSync(outDir, { recursive: true });
const redacted = JSON.parse(
  JSON.stringify(report).split(base).join("~smoke").split(tmpdir()).join("~tmp"),
);
writeFileSync(join(outDir, "p20-failure-smoke.json"), `${JSON.stringify(redacted, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      ok: report.ok,
      checks: Object.keys(report.checks).length,
      failed: Object.entries(report.checks)
        .filter(([, value]) => value.ok !== true)
        .map(([name]) => name),
      first_failure: report.first_failure,
      error: report.error,
    },
    null,
    2,
  ),
);
process.exit(report.ok === true ? 0 : 1);
