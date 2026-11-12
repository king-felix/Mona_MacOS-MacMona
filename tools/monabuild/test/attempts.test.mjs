import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  problemState,
  readAttempts,
  recordAttempt,
  reopenProblem,
  resolveProblem,
} from "../lib/attempts.mjs";
import { tempDir } from "./helpers.mjs";

function ledgerPath() {
  return join(tempDir(), "attempts.jsonl");
}

const base = {
  problemId: "AUTH-BREAK-1",
  requirement: "MONA-001",
  hypothesis: "token file is unreadable",
  action: "run minimal request",
  observed: "401 from provider",
};

test("three consecutive no-progress attempts block the problem", () => {
  const path = ledgerPath();
  for (let i = 1; i <= 3; i += 1) {
    const { state } = recordAttempt(path, base);
    assert.equal(state.total_attempts, i);
    assert.equal(state.consecutive_no_progress, i);
  }
  const state = problemState(readAttempts(path).records, "AUTH-BREAK-1");
  assert.equal(state.blocked, true);

  assert.throws(
    () => recordAttempt(path, { ...base, observed: "different 401 text" }),
    (error) => error.code === "EBLOCKED" && /monabuild reopen/.test(error.message),
  );
  assert.equal(readAttempts(path).records.filter((record) => record.kind === "attempt").length, 3);
});

test("the blocked state survives a fresh read, so it survives a new session", () => {
  const path = ledgerPath();
  for (let i = 0; i < 3; i += 1) recordAttempt(path, base);
  const reread = problemState(readAttempts(path).records, "AUTH-BREAK-1");
  assert.equal(reread.blocked, true);
  assert.equal(reread.consecutive_no_progress, 3);
});

test("material progress resets the consecutive counter but keeps the history", () => {
  const path = ledgerPath();
  recordAttempt(path, base);
  recordAttempt(path, base);
  const { state } = recordAttempt(path, { ...base, observed: "reproduced with a 40-line script", materialProgress: true });
  assert.equal(state.total_attempts, 3);
  assert.equal(state.consecutive_no_progress, 0);
  assert.equal(state.blocked, false);
});

test("reopen requires a human decision reference", () => {
  const path = ledgerPath();
  for (let i = 0; i < 3; i += 1) recordAttempt(path, base);
  assert.throws(() => reopenProblem(path, { problemId: "AUTH-BREAK-1", requirement: "MONA-001" }), /decision-ref/);
  const { state } = reopenProblem(path, {
    problemId: "AUTH-BREAK-1",
    requirement: "MONA-001",
    decisionRef: "Victor: use the workspace profile",
  });
  assert.equal(state.blocked, false);
  const next = recordAttempt(path, base);
  assert.equal(next.state.total_attempts, 4);
  assert.equal(next.state.consecutive_no_progress, 1);
});

test("a resolved problem cannot be silently retried under the same ID", () => {
  const path = ledgerPath();
  recordAttempt(path, base);
  resolveProblem(path, { problemId: "AUTH-BREAK-1", requirement: "MONA-001", note: "fixed by profile" });
  assert.throws(() => recordAttempt(path, base), /already resolved/);
});

test("a partial trailing line from an interrupted append is discarded, not fatal", () => {
  const path = ledgerPath();
  recordAttempt(path, base);
  writeFileSync(path, `{"schema_version":1,"kind":"attempt","ts_utc":"2026`, { flag: "a" });
  const { records, warnings } = readAttempts(path);
  assert.equal(records.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /partial trailing/);
});

test("counter also blocks when the previous record already said 3", () => {
  const path = ledgerPath();
  for (let i = 0; i < 3; i += 1) recordAttempt(path, base);
  const snapshot = problemState(readAttempts(path).records, "AUTH-BREAK-1");
  assert.equal(snapshot.blocked, true);
  assert.throws(() => recordAttempt(path, base), (error) => error.code === "EBLOCKED");
});
