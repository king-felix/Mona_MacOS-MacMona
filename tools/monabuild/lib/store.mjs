// State loading, validation, checkpointing, recovery, and eligibility.
// One writer at a time; readers only ever see a complete revision.

import { copyFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative as relativeTo } from "node:path";
import { execFileSync } from "node:child_process";
import { validate, assertValid } from "./schema.mjs";
import {
  acquireLock,
  atomicWriteJson,
  findTempArtifacts,
  readJsonStrict,
  sha256File,
} from "./atomic.mjs";

const STATE_SCHEMA_PATH = new URL("../schemas/state.schema.json", import.meta.url);
const REQUIREMENTS_SCHEMA_PATH = new URL("../schemas/requirements.schema.json", import.meta.url);
const ATTEMPT_SCHEMA_PATH = new URL("../schemas/attempt.schema.json", import.meta.url);

export function loadSchema(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

export function stateSchema() {
  return loadSchema(STATE_SCHEMA_PATH);
}

export function requirementsSchema() {
  return loadSchema(REQUIREMENTS_SCHEMA_PATH);
}

export function attemptSchema() {
  return loadSchema(ATTEMPT_SCHEMA_PATH);
}

export function readValidated(path, schema) {
  const value = readJsonStrict(path);
  const result = validate(value, schema);
  return { value, result };
}

export function conflict(message, actualRevision) {
  const error = new Error(message);
  error.code = "ECONFLICT";
  error.actualRevision = actualRevision;
  return error;
}

// Deep merge for state patches: objects merge key-by-key, arrays replace.
export function mergePatch(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      mergePatch(target[key], value);
    } else {
      target[key] = structuredClone(value);
    }
  }
  return target;
}

export function checkpoint(statePath, { expectRevision, patch, now = new Date().toISOString() }) {
  const release = acquireLock(statePath);
  try {
    const schema = stateSchema();
    const { value: state, result } = readValidated(statePath, schema);
    if (!result.valid) {
      const error = new Error(`refusing to checkpoint: current state is invalid (${result.errors[0].path})`);
      error.code = "EINVALIDSTATE";
      error.validation = result;
      throw error;
    }
    if (typeof expectRevision !== "number") {
      throw conflict("checkpoint requires the revision you read (--expect-revision)", state.revision);
    }
    if (state.revision !== expectRevision) {
      throw conflict(
        `state revision conflict: expected ${expectRevision}, file is at ${state.revision}`,
        state.revision,
      );
    }
    const next = structuredClone(state);
    mergePatch(next, patch ?? {});
    next.revision = state.revision + 1;
    next.last_checkpoint_utc = now;
    assertValid(next, schema, "state.json");
    atomicWriteJson(statePath, next);
    const leftovers = findTempArtifacts(statePath);
    for (const leftover of leftovers) rmSync(leftover, { force: true });
    return { state: next, abandonedTempFiles: leftovers.length };
  } finally {
    release();
  }
}

/**
 * A prerequisite is satisfied when it is `completed`, or when it was deliberately
 * `skipped` — a scope decision is a decision, and leaving a dependent prompt
 * permanently ineligible would read as "still blocked" long after the owner
 * settled it. A `blocked` or unfinished prerequisite still holds.
 */
function prerequisiteSatisfied(task) {
  return task?.status === "completed" || task?.status === "skipped";
}

export function computeNextEligible(state, prompts) {
  const tasks = state.tasks ?? {};
  const prereqsById = new Map((prompts ?? []).map((prompt) => [prompt.id, prompt.prerequisites]));
  const eligible = [];
  for (const [id, task] of Object.entries(tasks)) {
    if (task.status !== "pending") continue;
    const prereqs = prereqsById.get(id) ?? [];
    const ready = prereqs.every((dep) => prerequisiteSatisfied(tasks[dep]));
    if (ready) eligible.push(id);
  }
  return eligible.sort();
}

export function summarize(state, prompts) {
  const tasks = Object.entries(state.tasks ?? {});
  const byStatus = {};
  for (const [, task] of tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
  const blocked = tasks.filter(([, task]) => task.status === "blocked").map(([id]) => id);
  return {
    revision: state.revision,
    current_prompt: state.current_prompt,
    current_prompt_status: state.current_prompt_status,
    prompts: { total: tasks.length, by_status: byStatus },
    blocked_prompts: blocked,
    next_eligible_prompts: computeNextEligible(state, prompts),
    last_checkpoint_utc: state.last_checkpoint_utc,
    last_verified_commit: state.last_verified_commit,
  };
}

// Recovery: an interrupted checkpoint can leave a temp file, a stale lock, or
// (in the worst case) a truncated state file. The committed .bak is the
// recovery source. Corrupt evidence is preserved, never deleted.
export function recover(statePath, { now = new Date(), gitRef = null, root = null } = {}) {
  const report = {
    state_path: statePath,
    restored_from_backup: false,
    restored_from_git: false,
    preserved_corrupt_copy: null,
    removed_temp_files: [],
    removed_stale_lock: false,
    ok: false,
    notes: [],
  };
  const schema = stateSchema();

  let currentValid = false;
  if (existsSync(statePath)) {
    try {
      const { result } = readValidated(statePath, schema);
      currentValid = result.valid;
      if (!result.valid) report.notes.push(`state invalid: ${result.errors[0].path} ${result.errors[0].message}`);
    } catch (error) {
      report.notes.push(`state unreadable: ${error.message}`);
    }
  } else {
    report.notes.push("state file missing");
  }

  const backupPath = `${statePath}.bak`;
  let restoredFrom = null;
  if (!currentValid && existsSync(backupPath)) {
    const { result } = readValidated(backupPath, schema);
    if (result.valid) {
      if (existsSync(statePath)) {
        const stamp = now.toISOString().replace(/[:.]/g, "-");
        const corruptPath = `${statePath}.corrupt-${stamp}`;
        copyFileSync(statePath, corruptPath);
        report.preserved_corrupt_copy = corruptPath;
      }
      const recovered = readJsonStrict(backupPath);
      atomicWriteJson(statePath, recovered, { backup: false });
      report.restored_from_backup = true;
      report.notes.push(`restored committed revision ${recovered.revision} from backup`);
      currentValid = true;
      restoredFrom = "backup";
    } else {
      report.notes.push("backup is also invalid");
    }
  }

  // A fresh clone has no .bak (it is a local artifact), so version control is
  // the recovery source there. Only a blob that validates is accepted.
  if (!currentValid && gitRef && root) {
    try {
      const relative = relativeTo(root, statePath);
      const blob = execFileSync("git", ["show", `${gitRef}:${relative}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const candidate = JSON.parse(blob);
      const result = validate(candidate, schema);
      if (result.valid) {
        if (existsSync(statePath)) {
          const stamp = now.toISOString().replace(/[:.]/g, "-");
          const corruptPath = `${statePath}.corrupt-${stamp}`;
          copyFileSync(statePath, corruptPath);
          report.preserved_corrupt_copy = corruptPath;
        }
        atomicWriteJson(statePath, candidate, { backup: false });
        report.restored_from_git = true;
        report.notes.push(`restored revision ${candidate.revision} from ${gitRef}`);
        currentValid = true;
        restoredFrom = "git";
      } else {
        report.notes.push(`${gitRef} state blob is invalid`);
      }
    } catch (error) {
      report.notes.push(`no usable state blob at ${gitRef}: ${error.message.split("\n")[0]}`);
    }
  }
  report.restored_from = restoredFrom;

  // A leftover lock is only removed when its owner is gone or it is old.
  const lockPath = `${statePath}.lock`;
  if (existsSync(lockPath)) {
    try {
      const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
      const ageMs = Date.now() - statSync(lockPath).mtimeMs;
      let alive = false;
      try {
        process.kill(owner.pid, 0);
        alive = true;
      } catch (error) {
        alive = error.code === "EPERM";
      }
      if (!alive || ageMs > 120_000) {
        rmSync(lockPath, { recursive: true, force: true });
        report.removed_stale_lock = true;
      } else {
        report.notes.push(`active lock held by pid ${owner.pid}; left in place`);
      }
    } catch {
      rmSync(lockPath, { recursive: true, force: true });
      report.removed_stale_lock = true;
    }
  }

  for (const leftover of findTempArtifacts(statePath)) {
    rmSync(leftover, { force: true });
    report.removed_temp_files.push(leftover);
  }
  if (report.removed_temp_files.length > 0) {
    report.notes.push("discarded uncommitted temp files; their checkpoint never committed");
  }

  report.ok = currentValid;
  return report;
}

export function evidenceEntries(root, paths) {
  return paths.map((relative) => {
    const absolute = join(root, relative);
    if (!existsSync(absolute)) throw new Error(`evidence path does not exist: ${relative}`);
    return { path: relative, sha256: sha256File(absolute) };
  });
}

// Add or refresh evidence entries for a prompt, hashing each file now.
export function addEvidence(statePath, { prompt, paths: evidencePaths, note }, now = new Date().toISOString()) {
  const root = dirname(dirname(dirname(statePath)));
  const release = acquireLock(statePath);
  try {
    const schema = stateSchema();
    const { value: state, result } = readValidated(statePath, schema);
    if (!result.valid) {
      throw new Error(`state is invalid; run recover before adding evidence (${result.errors[0].path})`);
    }
    const task = state.tasks[prompt];
    if (!task) throw new Error(`unknown prompt ${prompt}`);
    const next = structuredClone(state);
    const entries = evidenceEntries(root, evidencePaths).map((entry) => (note ? { ...entry, note } : entry));
    for (const entry of entries) {
      const existing = next.tasks[prompt].evidence.findIndex((item) => item.path === entry.path);
      if (existing >= 0) {
        // A hash refresh keeps the human note that explained why this evidence
        // exists; only pass --note to replace it deliberately.
        const previous = next.tasks[prompt].evidence[existing];
        next.tasks[prompt].evidence[existing] = {
          ...previous,
          ...entry,
          ...(note ? { note } : previous.note ? { note: previous.note } : {}),
        };
      } else next.tasks[prompt].evidence.push(entry);
    }
    next.revision = state.revision + 1;
    next.last_checkpoint_utc = now;
    assertValid(next, schema, "state.json");
    atomicWriteJson(statePath, next);
    return { revision: next.revision, evidence: next.tasks[prompt].evidence };
  } finally {
    release();
  }
}
