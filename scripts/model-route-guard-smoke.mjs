#!/usr/bin/env node
// Real-engine check for the D-113 dispatch guard.
//
// Reads the engine's live model roster with the same adapter call the studio
// makes, applies the same predicate the studio applies (`unsupportedSavedModel`),
// then runs one tiny real turn on the repaired route to prove the owner's next
// turn is accepted. It never touches the owner's state store: the runtime lives
// in a temp workspace and a temp state dir.
//
// This costs one short provider call on the repaired route. It refuses to run
// unless the roster check proves the stale model is gone, so it can never be
// used to spend a turn on a route the engine no longer offers.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const { CodewhaleAdapter } = require(join(ROOT, "dist/main/main/engine/adapter.js"));
const { MemorySubmissionStore } = require(join(ROOT, "dist/main/main/engine/submission-store.js"));
const { unsupportedSavedModel } = require(join(ROOT, "dist/main/main/work/settings.js"));

const STALE = "deepseek-v4-flash-0731";
const REPAIRED = "deepseek-flash";
const workspace = await mkdtemp(join(tmpdir(), "mona-route-guard-"));
const stateDir = await mkdtemp(join(tmpdir(), "mona-route-guard-state-"));
await mkdir(join(workspace, "src"), { recursive: true });

const report = {
  schema_version: 1,
  ok: false,
  engine: null,
  roster: [],
  checks: {},
  turn: null,
  usage: null,
  error: null,
};

const adapter = new CodewhaleAdapter({ store: new MemorySubmissionStore() });
let handle = null;
try {
  handle = await adapter.startOwnedRuntime({
    workspace,
    stateDir,
    logDir: join(stateDir, "logs"),
    startupTimeoutMs: 30_000,
  });
  const info = await adapter.discover();
  report.engine = { version: info.identity.version, commit: info.identity.commit };

  // 1. The roster the studio reads, and the exact predicate it applies.
  const catalog = await adapter.listModels("deepseek", null);
  report.roster = catalog.models.map((model) => model.id);
  const staleRefusal = unsupportedSavedModel({ provider: "deepseek", model: STALE }, catalog);
  const repairedRefusal = unsupportedSavedModel({ provider: "deepseek", model: REPAIRED }, catalog);
  report.checks.roster_read = report.roster.length > 0;
  report.checks.stale_model_refused = typeof staleRefusal === "string";
  report.checks.repaired_model_accepted = repairedRefusal === null;
  report.refusal = staleRefusal;
  if (!report.checks.roster_read || !report.checks.stale_model_refused) {
    throw new Error("the live roster still lists the stale model; this check proves nothing");
  }
  if (!report.checks.repaired_model_accepted) throw new Error(String(repairedRefusal));

  // 2. One real turn on the repaired route, exactly as a dispatch would send it.
  const stamp = Date.now();
  const thread = await adapter.createOrOpenThread({
    workspace,
    title: "Route guard check",
    operationKey: `route-guard-thread-${stamp}`,
    execute: { autoApprove: false, trustMode: false, allowShell: false },
    reasoningEffort: "auto",
  });
  const receipt = await adapter.submitTurn({
    threadId: thread.threadId,
    prompt: "Reply with exactly: pong",
    operationKey: `route-guard-turn-${stamp}`,
    requested: {
      provider: "deepseek",
      exactId: null,
      model: REPAIRED,
      reasoningEffort: "auto",
      permissionPosture: "ask",
    },
    autoApprove: false,
    allowShell: false,
    trustMode: false,
  });
  report.checks.turn_accepted = receipt.accepted;
  if (!receipt.accepted)
    throw new Error(`the repaired route was not accepted: ${receipt.submission.status}`);

  // Follow the stream to the terminal event, bounded.
  let terminal = null;
  const deadline = Date.now() + 180_000;
  for await (const item of adapter.subscribe({ threadId: thread.threadId, idleMs: 60_000 })) {
    if (item.type === "event") {
      const { kind, payload } = item.event;
      if (kind === "turn.completed" || kind === "turn.failed") terminal = payload;
    }
    if (terminal || item.type === "end" || Date.now() > deadline) break;
  }
  const turn = terminal?.turn ?? {};
  report.turn = {
    id: turn.id ?? receipt.turnId,
    status: turn.status ?? null,
    effective_provider: turn.effective_provider ?? null,
    effective_model: turn.effective_model ?? null,
    usage: turn.usage ?? null,
  };
  report.checks.turn_completed = report.turn.status === "completed";
  report.checks.effective_model_is_repaired =
    report.turn.effective_model === null || report.turn.effective_model === REPAIRED;
  report.ok =
    report.checks.roster_read &&
    report.checks.stale_model_refused &&
    report.checks.repaired_model_accepted &&
    report.checks.turn_accepted &&
    report.checks.turn_completed &&
    report.checks.effective_model_is_repaired;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  try {
    if (handle) await adapter.shutdownOwnedRuntime(handle);
  } catch (error) {
    report.checks.shutdown_error = String(error);
    report.ok = false;
  }
  await writeFile(
    process.env.MONA_ROUTE_GUARD_OUT ??
      join(ROOT, "docs/evidence/macos/artifacts/model-route-guard.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
}

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
