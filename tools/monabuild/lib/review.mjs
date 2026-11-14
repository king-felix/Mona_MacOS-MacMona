// Subordinate review ledger for the MacMona Studio review (studio-v2).
//
// The original P00–P27 ledger stays the authority for product requirements.
// This registry records review tasks R00–R15 and findings RV-01…RV-13 plus the
// user feature IDs, with the same discipline: schema validation, revision
// checks, atomic writes, evidence hashes, and attempt counts that continue in
// the shared `.mona/build-macos/attempts.jsonl` ledger (never reset here).
//
// A review task is complete only when it has no remaining acceptance items and
// none of its named attempt problems is blocked. Facts, not prose, decide.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { acquireLock, atomicWriteJson, readJsonStrict, sha256File } from "./atomic.mjs";
import { validate } from "./schema.mjs";
import { ledgerSummary, readAttempts } from "./attempts.mjs";

export const REVIEW_VERSION = 1;
export const REVIEW_ID = "studio-v2";
export const REVIEW_IDS = Array.from({ length: 16 }, (_, index) => `R${String(index).padStart(2, "0")}`);
export const ISSUE_IDS = [
  "RV-01",
  "RV-02",
  "RV-03",
  "RV-04",
  "RV-05",
  "RV-06",
  "RV-07",
  "RV-08",
  "RV-09",
  "RV-10",
  "RV-11",
  "RV-12",
  "RV-13",
  "UX-FULLSCREEN",
  "UX-COMMANDS",
  "UX-COMPOSER",
  "UX-AURORA",
  "UX-AGENT-COMMS",
];

const SCHEMA_PATH = new URL("../schemas/review.schema.json", import.meta.url);

export function reviewSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
}

export function reviewPaths(root, id = REVIEW_ID) {
  const dir = join(root, ".mona", "build-macos", "reviews", id);
  return {
    dir,
    statePath: join(dir, "state.json"),
    handoffPath: join(dir, "HANDOFF.md"),
    decisionsPath: join(dir, "DECISIONS.md"),
    blockersPath: join(dir, "BLOCKERS.md"),
    attemptsPath: join(root, ".mona", "build-macos", "attempts.jsonl"),
  };
}

function fail(message, code = "EINVALID", extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function schemaCheck(value) {
  return validate(value, reviewSchema());
}

// Structural invariants the JSON schema cannot express.
export function reviewInvariants(state) {
  const errors = [];
  const warnings = [];
  const taskIds = Object.keys(state.tasks ?? {});
  const expected = [...REVIEW_IDS].sort();
  if (JSON.stringify([...taskIds].sort()) !== JSON.stringify(expected)) {
    errors.push(`tasks must be exactly R00–R15 (found ${taskIds.length})`);
  }
  const issueIds = Object.keys(state.issues ?? {});
  if (JSON.stringify([...issueIds].sort()) !== JSON.stringify([...ISSUE_IDS].sort())) {
    errors.push(`issues must be exactly the RV/UX set (found ${issueIds.length})`);
  }
  if (!state.tasks?.[state.current_task]) {
    errors.push(`current_task ${state.current_task} is not a task in this registry`);
  } else if (state.tasks[state.current_task].status !== state.current_task_status) {
    errors.push(
      `current_task_status ${state.current_task_status} does not match ${state.current_task}.status ${state.tasks[state.current_task].status}`,
    );
  }
  for (const [id, task] of Object.entries(state.tasks ?? {})) {
    for (const prerequisite of task.prerequisites) {
      if (!state.tasks[prerequisite]) errors.push(`${id} lists unknown prerequisite ${prerequisite}`);
      if (prerequisite >= id) warnings.push(`${id} depends on ${prerequisite}, which is not earlier in the sequence`);
    }
    if (task.status === "completed" && task.acceptance_remaining.length > 0) {
      errors.push(`${id} is completed but still lists remaining acceptance items`);
    }
    if (
      (task.status === "running" || task.status === "verifying") &&
      task.acceptance_completed.length === 0
    ) {
      warnings.push(`${id} is ${task.status} with no completed acceptance recorded`);
    }
  }
  // Dependency cycles.
  const visiting = new Set();
  const done = new Set();
  const walk = (id, trail) => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`prerequisite cycle: ${[...trail, id].join(" → ")}`);
      return;
    }
    visiting.add(id);
    for (const prerequisite of state.tasks?.[id]?.prerequisites ?? []) {
      if (state.tasks?.[prerequisite]) walk(prerequisite, [...trail, id]);
    }
    visiting.delete(id);
    done.add(id);
  };
  for (const id of taskIds) walk(id, []);
  return { errors, warnings };
}

// Evidence and provenance: recorded hashes must describe the bytes on disk,
// except entries deliberately marked invalidated/historical by this review.
export function reviewEvidenceCheck(root, state) {
  const errors = [];
  const warnings = [];
  const check = (path, sha256, label, { strict = true } = {}) => {
    const absolute = join(root, path);
    if (!existsSync(absolute)) {
      (strict ? errors : warnings).push(`${label}: evidence file is missing: ${path}`);
      return;
    }
    if (sha256 && sha256File(absolute) !== sha256) {
      (strict ? errors : warnings).push(`${label}: evidence hash is stale for ${path}`);
    }
  };
  const document = state.review_document;
  if (document?.path) check(document.path, document.sha256, "review document");
  const hotfix = state.hotfix;
  if (hotfix?.path) {
    check(hotfix.path, hotfix.sha256, "hotfix");
    if (hotfix.declared_sha256 && hotfix.sha256 !== hotfix.declared_sha256) {
      warnings.push(
        `hotfix bytes do not match the sha256 declared in the review (declared ${hotfix.declared_sha256}, actual ${hotfix.sha256})`,
      );
    }
  }
  for (const [id, task] of Object.entries(state.tasks ?? {})) {
    for (const entry of task.evidence) check(entry.path, entry.sha256, id);
    for (const entry of task.source_hashes) {
      if (entry.state === "current") {
        check(entry.path, entry.sha256, `${id} source`);
      } else if (existsSync(join(root, entry.path)) && sha256File(join(root, entry.path)) === entry.sha256) {
        warnings.push(`${id} marks ${entry.path} ${entry.state} but the recorded hash still matches its bytes`);
      }
    }
  }
  return { errors, warnings };
}

export function eligibleTasks(state) {
  return REVIEW_IDS.filter((id) => {
    const task = state.tasks[id];
    if (!task || task.status !== "pending") return false;
    // Same rule as the product ledger: a prerequisite settled by decision
    // (`skipped`) satisfies a dependent task; one that is blocked does not.
    return task.prerequisites.every((prerequisite) => {
      const status = state.tasks[prerequisite]?.status;
      return status === "completed" || status === "skipped";
    });
  });
}

export function validateReview(root, id = REVIEW_ID) {
  const p = reviewPaths(root, id);
  if (!existsSync(p.statePath)) {
    return { ok: false, errors: [`review ledger is absent: ${p.statePath}`], warnings: [], state: null };
  }
  let state;
  try {
    state = readJsonStrict(p.statePath);
  } catch (error) {
    return { ok: false, errors: [error.message], warnings: [], state: null };
  }
  const errors = [];
  const warnings = [];
  const result = schemaCheck(state);
  if (!result.valid) {
    for (const item of result.errors) errors.push(`review state${item.path}: ${item.message}`);
  } else {
    const invariants = reviewInvariants(state);
    errors.push(...invariants.errors);
    warnings.push(...invariants.warnings);
    const evidence = reviewEvidenceCheck(root, state);
    errors.push(...evidence.errors);
    warnings.push(...evidence.warnings);
  }
  // Attempts continue in the shared ledger; blocked problems outrank a
  // "completed" claim.
  let attempts = { records: [], warnings: [] };
  if (existsSync(p.attemptsPath)) {
    attempts = readAttempts(p.attemptsPath);
    warnings.push(...attempts.warnings);
  }
  const summary = ledgerSummary(attempts.records);
  const blocked = summary.filter((item) => item.blocked);
  const byProblem = new Map(summary.map((item) => [item.problem_id, item]));
  for (const [taskId, task] of Object.entries(state?.tasks ?? {})) {
    for (const problemId of task.attempt_problem_ids ?? []) {
      const problem = byProblem.get(problemId);
      if (!problem) {
        warnings.push(`${taskId} names attempt problem ${problemId}, which has no ledger record`);
      } else if (problem.blocked) {
        const line = `${taskId} names blocked problem ${problemId} (${problem.consecutive_no_progress} no-progress attempts)`;
        if (task.status === "completed") errors.push(line);
        else warnings.push(line);
      }
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    state: state
      ? {
          review: state.review,
          revision: state.revision,
          current_task: state.current_task,
          current_task_status: state.current_task_status,
          tasks: Object.keys(state.tasks).length,
          by_status: countBy(Object.values(state.tasks).map((task) => task.status)),
          issues: countBy(Object.values(state.issues).map((issue) => issue.status)),
        }
      : null,
    next_eligible: state ? eligibleTasks(state) : [],
    attempts: summary,
    blocked_attempts: blocked,
  };
}

function countBy(values) {
  const out = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function assertValidState(state) {
  const result = schemaCheck(state);
  if (!result.valid) {
    throw fail(`refusing to write: ${result.errors[0].path} ${result.errors[0].message}`, "EINVALIDSTATE", {
      validation: result,
    });
  }
  const invariants = reviewInvariants(state);
  if (invariants.errors.length > 0) {
    throw fail(`refusing to write: ${invariants.errors[0]}`, "EINVALIDSTATE", { validation: invariants });
  }
}

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

export function reviewCheckpoint(root, id, { expectRevision, patch, now = new Date().toISOString() }) {
  const p = reviewPaths(root, id);
  if (typeof expectRevision !== "number") {
    throw fail("review checkpoint requires the revision you read (--expect-revision)", "ECONFLICT");
  }
  mkdirSync(dirname(p.statePath), { recursive: true });
  const release = acquireLock(p.statePath);
  try {
    const creating = !existsSync(p.statePath);
    let next;
    if (creating) {
      if (expectRevision !== 0) {
        throw fail("review ledger is absent; create it with --expect-revision 0", "ECONFLICT");
      }
      next = structuredClone(patch ?? {});
      if (next.revision === undefined) next.revision = 1;
    } else {
      const state = readJsonStrict(p.statePath);
      if (state.revision !== expectRevision) {
        throw fail(
          `review revision is ${state.revision}, not the ${expectRevision} you read; re-read before writing`,
          "ECONFLICT",
          { actualRevision: state.revision },
        );
      }
      next = structuredClone(state);
      mergePatch(next, patch ?? {});
      next.revision = state.revision + 1;
    }
    next.last_checkpoint_utc = now;
    assertValidState(next);
    atomicWriteJson(p.statePath, next);
    return { revision: next.revision, created: creating, state: next };
  } finally {
    release();
  }
}

export function reviewEvidence(root, id, { task, paths, note, now = new Date().toISOString() }) {
  const p = reviewPaths(root, id);
  if (!existsSync(p.statePath)) throw fail(`review ledger is absent: ${p.statePath}`, "EINVALID");
  if (!paths || paths.length === 0) throw fail("no evidence paths given", "EUSAGE");
  mkdirSync(dirname(p.statePath), { recursive: true });
  const release = acquireLock(p.statePath);
  try {
    const state = readJsonStrict(p.statePath);
    const target = state.tasks?.[task];
    if (!target) throw fail(`unknown review task ${task}`, "EUSAGE");
    const next = structuredClone(state);
    for (const path of paths) {
      const absolute = resolve(root, path);
      if (!absolute.startsWith(resolve(root) + "/")) throw fail(`evidence path escapes the repository: ${path}`, "EUSAGE");
      if (!existsSync(absolute)) throw fail(`evidence path does not exist: ${path}`, "EUSAGE");
      const entry = { path, sha256: sha256File(absolute) };
      if (note) entry.note = note;
      const existing = next.tasks[task].evidence.findIndex((item) => item.path === path);
      if (existing >= 0) {
        const previous = next.tasks[task].evidence[existing];
        next.tasks[task].evidence[existing] = {
          ...previous,
          ...entry,
          ...(note ? { note } : previous.note ? { note: previous.note } : {}),
        };
      } else next.tasks[task].evidence.push(entry);
    }
    next.revision = state.revision + 1;
    next.last_checkpoint_utc = now;
    assertValidState(next);
    atomicWriteJson(p.statePath, next);
    return { revision: next.revision, evidence: next.tasks[task].evidence };
  } finally {
    release();
  }
}

export function reviewStatus(root, id = REVIEW_ID) {
  const report = validateReview(root, id);
  if (!report.state) return report;
  return {
    ok: report.ok,
    review: report.state.review,
    revision: report.state.revision,
    current_task: report.state.current_task,
    current_task_status: report.state.current_task_status,
    tasks: { total: report.state.tasks, by_status: report.state.by_status },
    issues: report.state.issues,
    next_eligible: report.next_eligible,
    blocked_attempts: report.blocked_attempts,
    errors: report.errors,
    warnings: report.warnings,
  };
}

export function reviewNext(root, id = REVIEW_ID) {
  const report = validateReview(root, id);
  if (!report.state || !report.ok) return { ok: false, errors: report.errors, warnings: report.warnings };
  return {
    ok: true,
    current_task: report.state.current_task,
    current_task_status: report.state.current_task_status,
    next_eligible: report.next_eligible,
    warnings: report.warnings,
  };
}

export function reviewDirFor(root) {
  return dirname(reviewPaths(root).statePath);
}
