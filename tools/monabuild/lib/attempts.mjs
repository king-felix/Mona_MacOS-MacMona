// Append-only attempt ledger with the three-attempt rule enforced in code.
// Counters are recomputed from the ledger, so they survive sessions, crashes,
// and handoffs. A fourth no-progress attempt is refused unless a human decision
// reference reopens the problem.

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { validate } from "./schema.mjs";
import { acquireLock } from "./atomic.mjs";
import { attemptSchema } from "./store.mjs";

export function readAttempts(path) {
  if (!existsSync(path)) return { records: [], warnings: [] };
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  const records = [];
  const warnings = [];
  const schema = attemptSchema();
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      const isLast = index === lines.length - 1 || lines.slice(index + 1).every((l) => l.trim() === "");
      if (isLast) warnings.push(`discarded partial trailing attempt record (line ${index + 1})`);
      else warnings.push(`malformed attempt record at line ${index + 1}`);
      return;
    }
    const result = validate(record, schema);
    if (!result.valid) {
      warnings.push(`invalid attempt record at line ${index + 1}: ${result.errors[0].path} ${result.errors[0].message}`);
      return;
    }
    records.push(record);
  });
  return { records, warnings };
}

export function appendRecord(path, record) {
  const schema = attemptSchema();
  const result = validate(record, schema);
  if (!result.valid) {
    const error = new Error(`attempt record failed schema validation: ${result.errors[0].path} ${result.errors[0].message}`);
    error.validation = result;
    throw error;
  }
  const line = `${JSON.stringify(record)}\n`;
  const fd = openSync(path, "a", 0o644);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function problemState(records, problemId) {
  const scoped = records.filter((record) => record.problem_id === problemId);
  const attempts = scoped.filter((record) => record.kind === "attempt");
  const last = attempts.at(-1) ?? null;
  const lastRecord = scoped.at(-1) ?? null;
  const resolved = lastRecord?.kind === "resolve";
  const reopened = lastRecord?.kind === "reopen";
  const lastReopen = scoped.filter((record) => record.kind === "reopen").at(-1) ?? null;
  const consecutive = reopened || resolved ? 0 : (lastRecord?.kind === "attempt" ? lastRecord.consecutive_no_progress : 0);
  return {
    problem_id: problemId,
    total_attempts: attempts.length,
    consecutive_no_progress: consecutive,
    blocked: !resolved && !reopened && consecutive >= 3,
    resolved,
    last_observed: last?.observed ?? null,
    last_reopen: lastReopen?.decision_ref ?? null,
    requirement: scoped.at(-1)?.requirement ?? null,
  };
}

export function ledgerSummary(records) {
  const ids = [...new Set(records.map((record) => record.problem_id))];
  return ids.map((id) => problemState(records, id));
}

export function recordAttempt(
  attemptsPath,
  { problemId, requirement, hypothesis, action, observed, materialProgress = false, evidence = [], note, now },
) {
  const release = acquireLock(attemptsPath);
  try {
    const { records } = readAttempts(attemptsPath);
    const state = problemState(records, problemId);
    if (state.resolved) {
      const error = new Error(`problem ${problemId} is already resolved; open a new problem ID instead of reusing it`);
      error.code = "ERESOLVED";
      throw error;
    }
    if (state.blocked) {
      const error = new Error(
        [
          `problem ${problemId} has ${state.consecutive_no_progress} consecutive no-progress attempts and is blocked.`,
          "Do not make another attempt. Record the blocker, the exact help needed, and continue independent eligible work.",
          "To reopen after a human decision, run: monabuild reopen --problem " + problemId + " --decision-ref <reference>",
        ].join("\n"),
      );
      error.code = "EBLOCKED";
      error.problemState = state;
      throw error;
    }
    const consecutive = materialProgress ? 0 : state.consecutive_no_progress + 1;
    const record = {
      schema_version: 1,
      kind: "attempt",
      ts_utc: now ?? new Date().toISOString(),
      problem_id: problemId,
      requirement,
      symptom: note ?? state.last_observed ?? problemId,
      hypothesis,
      action,
      observed,
      material_progress: materialProgress,
      evidence,
      attempt: state.total_attempts + 1,
      consecutive_no_progress: consecutive,
    };
    appendRecord(attemptsPath, record);
    return { record, state: problemState([...records, record], problemId) };
  } finally {
    release();
  }
}

export function reopenProblem(attemptsPath, { problemId, requirement, decisionRef, note, now }) {
  if (!decisionRef) {
    const error = new Error("reopen requires --decision-ref naming the human decision or new evidence");
    error.code = "EDECISION";
    throw error;
  }
  const release = acquireLock(attemptsPath);
  try {
    const { records } = readAttempts(attemptsPath);
    const state = problemState(records, problemId);
    if (!state.blocked) {
      const error = new Error(`problem ${problemId} is not blocked; no reopen needed`);
      error.code = "ENOTBLOCKED";
      throw error;
    }
    const record = {
      schema_version: 1,
      kind: "reopen",
      ts_utc: now ?? new Date().toISOString(),
      problem_id: problemId,
      requirement,
      decision_ref: decisionRef,
      note: note ?? "",
      attempt: state.total_attempts,
      consecutive_no_progress: 0,
    };
    appendRecord(attemptsPath, record);
    return { record, state: problemState([...records, record], problemId) };
  } finally {
    release();
  }
}

export function resolveProblem(attemptsPath, { problemId, requirement, note, evidence = [], now }) {
  const release = acquireLock(attemptsPath);
  try {
    const { records } = readAttempts(attemptsPath);
    const state = problemState(records, problemId);
    const record = {
      schema_version: 1,
      kind: "resolve",
      ts_utc: now ?? new Date().toISOString(),
      problem_id: problemId,
      requirement,
      note: note ?? "",
      evidence,
      attempt: Math.max(1, state.total_attempts),
      consecutive_no_progress: 0,
    };
    appendRecord(attemptsPath, record);
    return { record, state: problemState([...records, record], problemId) };
  } finally {
    release();
  }
}
