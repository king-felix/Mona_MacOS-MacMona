import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkpoint, computeNextEligible, recover, summarize } from "../lib/store.mjs";
import { stateFile, makeState, tempDir } from "./helpers.mjs";

test("checkpoint increments the revision and keeps a backup", () => {
  const { path } = stateFile();
  const result = checkpoint(path, {
    expectRevision: 1,
    patch: { current_prompt_status: "verifying", tasks: { P00: { status: "verifying" } } },
    now: "2026-11-11T01:00:00.000Z",
  });
  assert.equal(result.state.revision, 2);
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(onDisk.revision, 2);
  assert.equal(onDisk.tasks.P00.status, "verifying");
  assert.equal(onDisk.current_prompt_status, "verifying");
  assert.equal(onDisk.last_checkpoint_utc, "2026-11-11T01:00:00.000Z");
  const backup = JSON.parse(readFileSync(`${path}.bak`, "utf8"));
  assert.equal(backup.revision, 1);
  assert.equal(result.abandonedTempFiles, 0);
});

test("a stale revision is refused and the file is untouched", () => {
  const { path } = stateFile();
  assert.throws(
    () => checkpoint(path, { expectRevision: 7, patch: { current_prompt_status: "completed" } }),
    (error) => error.code === "ECONFLICT" && error.actualRevision === 1,
  );
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(onDisk.revision, 1);
  assert.equal(onDisk.current_prompt_status, "running");
});

test("an invalid patch is refused before writing", () => {
  const { path } = stateFile();
  assert.throws(
    () => checkpoint(path, { expectRevision: 1, patch: { current_prompt_status: "invented" } }),
    /failed schema validation/,
  );
  assert.equal(JSON.parse(readFileSync(path, "utf8")).revision, 1);
});

test("checkpoint removes temp files left by an interrupted writer", () => {
  const { path } = stateFile();
  const leftover = join(path, "..", ".state.json.tmp-999-deadbeef");
  writeFileSync(leftover, "{ this never committed");
  const result = checkpoint(path, { expectRevision: 1, patch: { notes: ["ok"] } });
  assert.equal(result.abandonedTempFiles, 1);
  assert.equal(existsSync(leftover), false);
});

test("recover restores a truncated state from the committed backup", () => {
  const { path } = stateFile();
  checkpoint(path, { expectRevision: 1, patch: { current_prompt_status: "verifying" } });
  writeFileSync(path, '{ "schema_version": 1, "revision": 2, "trunc');
  const report = recover(path);
  assert.equal(report.ok, true);
  assert.equal(report.restored_from_backup, true);
  assert.ok(report.preserved_corrupt_copy && existsSync(report.preserved_corrupt_copy));
  const restored = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(restored.revision, 1);
  assert.equal(restored.current_prompt_status, "running");
});

test("recover leaves a valid committed state alone and discards uncommitted temp files", () => {
  const { path } = stateFile();
  const before = readFileSync(path, "utf8");
  const leftover = join(path, "..", ".state.json.tmp-123-cafe");
  writeFileSync(leftover, JSON.stringify({ revision: 99 }));
  const report = recover(path);
  assert.equal(report.ok, true);
  assert.equal(report.restored_from_backup, false);
  assert.deepEqual(report.removed_temp_files, [leftover]);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(readdirSync(join(path, "..")).includes(".state.json.tmp-123-cafe"), false);
});

test("eligibility follows registry prerequisites, not a guessed percentage", () => {
  const state = makeState();
  state.tasks.P00.status = "completed";
  const prompts = [
    { id: "P00", prerequisites: [] },
    { id: "P01", prerequisites: ["P00"] },
    { id: "P02", prerequisites: ["P01"] },
    { id: "P27", prerequisites: ["P26"] },
  ];
  const scoped = { ...state, tasks: { P00: state.tasks.P00, P01: state.tasks.P01, P02: state.tasks.P02 } };
  const eligible = computeNextEligible(scoped, prompts);
  assert.deepEqual(eligible, ["P01"]);

  const summary = summarize({ ...state, tasks: { ...state.tasks, P01: { ...state.tasks.P01, status: "running" } } }, prompts);
  assert.equal(summary.prompts.by_status.completed, 1);
  assert.equal(summary.prompts.by_status.running, 1);
});

test("a recorded evidence hash that no longer matches its file is reported", async () => {
  const { validateEverything } = await import("../lib/validate.mjs");
  const { addEvidence } = await import("../lib/store.mjs");
  const { copyFileSync, mkdirSync, writeFileSync: write } = await import("node:fs");
  const { dirname: dirOf, join: joinPath, resolve: resolvePath } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const root = tempDir();
  const realRoot = resolvePath(dirOf(fileURLToPath(import.meta.url)), "..", "..", "..");
  mkdirSync(joinPath(root, "docs", "evidence", "macos"), { recursive: true });
  mkdirSync(joinPath(root, ".mona", "build-macos"), { recursive: true });
  for (const name of ["Mona_macOS_Project.md", "Mona_macOS_PROMPTS.md"]) {
    copyFileSync(joinPath(realRoot, name), joinPath(root, name));
  }
  copyFileSync(joinPath(realRoot, "docs", "requirements-macos.json"), joinPath(root, "docs", "requirements-macos.json"));
  const state = { ...makeState(), spec_sha256: "a".repeat(64), prompt_file_sha256: "b".repeat(64) };
  const statePath = joinPath(root, ".mona", "build-macos", "state.json");
  write(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const evidencePath = joinPath(root, "docs", "evidence", "macos", "note.md");
  write(evidencePath, "original\n");
  addEvidence(statePath, { prompt: "P00", paths: ["docs/evidence/macos/note.md"] });
  write(evidencePath, "edited after acceptance\n");

  const report = validateEverything({
    root,
    statePath,
    requirementsPath: joinPath(root, "docs", "requirements-macos.json"),
    indexPath: joinPath(root, ".mona", "build-macos", "index.json"),
    attemptsPath: joinPath(root, ".mona", "build-macos", "attempts.jsonl"),
    evidenceDir: joinPath(root, "docs", "evidence", "macos"),
  });
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /evidence hash is stale/);
});
