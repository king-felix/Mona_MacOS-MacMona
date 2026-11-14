#!/usr/bin/env node
// R07 live smoke: Mona's pending-request round trip against the pinned 0.10.2
// engine, with no model request.
//
// The one thing this run cannot manufacture is a real approval prompt: that
// requires a turn, a tool call, and therefore inference. What it does prove,
// against the real Runtime, is the contract Mona's reply path is built on:
//
//   - thread detail really carries `pending_approvals` / `pending_user_inputs`
//     (here: empty, which is a fact and not a failure);
//   - `POST /v1/approvals/{capability}` exists, is authenticated, and answers
//     `404` for a capability that is not pending — exactly the case Mona maps to
//     "expired: nothing was sent";
//   - `POST /v1/user-input/{thread}/{request}` behaves the same way;
//   - Mona's own rows survive a restart, settle on the engine's list, and never
//     claim delivery the Runtime did not acknowledge.
//
//   npm run build:main && node scripts/pending-smoke.mjs
//
// The report is written to
// docs/evidence/macos/review-studio/artifacts/r07-pending-smoke.json.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const { StateStore } = require(join(ROOT, "dist/main/main/state/store.js"));
const { WorkStudio } = require(join(ROOT, "dist/main/main/work/studio.js"));
const { WorkController } = require(join(ROOT, "dist/main/main/work/control.js"));
const { CodewhaleAdapter } = require(join(ROOT, "dist/main/main/engine/adapter.js"));
const { HttpRuntimeTransport } = require(join(ROOT, "dist/main/main/engine/transport.js"));
const { SqliteSubmissionStore } = require(join(ROOT, "dist/main/main/state/submission-store.js"));
const { CommandCatalogService } = require(join(ROOT, "dist/main/main/work/commands.js"));
const { CommandDispatchService } = require(join(ROOT, "dist/main/main/work/command-dispatch.js"));

const base = await mkdtemp(join(tmpdir(), "mona-r07-smoke-"));
const home = join(base, "home");
const codeHome = join(home, ".codewhale");
const workspace = join(base, "ws");
const product = join(base, "product");
await mkdir(codeHome, { recursive: true });
await mkdir(workspace, { recursive: true });
await mkdir(product, { recursive: true });

const port = 8340 + Math.floor(Math.random() * 40);
const token = randomBytes(24).toString("hex");
const binary = "/opt/homebrew/bin/codewhale";
const baseUrl = `http://127.0.0.1:${port}`;
const engine = { version: "0.10.2", commit: "ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e" };
const report = {
  task: "R07",
  captured_at: new Date().toISOString(),
  platform: "darwin-arm64",
  engine,
  isolated: "temporary HOME, CODEWHALE_HOME, workspace, product state",
  model_requests: 0,
  note: "No turn was submitted. A real approval prompt needs a turn and therefore inference; this run qualifies the reply contract instead.",
  steps: [],
  assertions: {},
  cleanup: null,
};

function step(name, detail) {
  report.steps.push({ name, ...detail });
}

function redact(value) {
  return JSON.parse(
    JSON.stringify(value)
      .split(base)
      .join("~r07-smoke")
      .split(home)
      .join("~r07-home")
      .split(token)
      .join("~r07-token"),
  );
}

const server = spawn(binary, ["app-server", "--http", "--port", String(port)], {
  cwd: workspace,
  env: {
    ...process.env,
    HOME: home,
    CODEWHALE_HOME: codeHome,
    CODEWHALE_RUNTIME_TOKEN: token,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => (serverLog += chunk.toString()));
server.stderr.on("data", (chunk) => (serverLog += chunk.toString()));

const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function waitForEngine() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/v1/runtime/info`, { headers });
      if (response.ok) return await response.json();
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`the isolated runtime did not become ready:\n${serverLog}`);
}

async function engineJson(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers, ...init });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: response.status, json };
}

const status = {
  state: "running",
  reason: "started",
  since: new Date().toISOString(),
  workspace,
  ownershipId: "own_r07smoke",
  port,
  engine,
  external: false,
  restarts: 0,
  lastFailure: null,
  pendingRestartInMs: null,
};
const endpoint = {
  baseUrl,
  port,
  token,
  engine,
  workspace,
  canonicalWorkspace: workspace,
  executable: binary,
  executableSha256: "0".repeat(64),
  ownershipId: "own_r07smoke",
};
const supervisor = {
  ensure: async () => status,
  endpoint: () => endpoint,
  status: () => status,
  stopOwned: async () => ({
    ok: true,
    state: "stopped",
    graceful: true,
    escalated: false,
    survivors: [],
    via: "control_socket",
    verified: true,
    note: "smoke",
  }),
  isOwned: () => true,
};
const stopReceipt = {
  ok: true,
  state: "stopped",
  graceful: true,
  escalated: false,
  survivors: [],
  via: "control_socket",
  verified: true,
  note: "smoke",
};

let store = null;
try {
  const info = await waitForEngine();
  step("engine_ready", {
    service: info.service,
    version: info.codewhale_version,
    commit: info.codewhale_commit,
  });

  store = await StateStore.open({
    dbPath: join(product, "state", "mona.sqlite"),
    artifactRoot: join(product, "artifacts"),
    backupDir: join(product, "backups"),
  });
  const opened = await store.openProject(workspace);
  const projectId = opened.project.id;
  const studio = new WorkStudio({
    store,
    supervisor,
    work: new WorkController({
      interrupt: async () => ({
        interrupted: false,
        turn: null,
        note: "the R07 smoke starts no turn",
      }),
      stopOwnedRuntime: async () => stopReceipt,
    }),
  });

  const started = await studio.start(projectId);
  step("studio_started", {
    connection: started.connection.state,
    engine: started.connection.engine,
    thread: started.threadId,
    engine_thread: started.engineThreadId,
  });
  // `/new` is the R04-verified way to bind a conversation to an engine thread
  // without submitting a turn: it creates the thread, records the generation,
  // and starts nothing.
  const dispatcher = new CommandDispatchService({
    catalog: new CommandCatalogService(),
    studio,
  });
  const bound = await dispatcher.execute({
    projectId,
    mode: "work",
    spelling: "new",
    arguments: "",
    operationKey: "r07-smoke-new-0001",
  });
  step("thread_bound", {
    status: bound.status,
    route: bound.route,
    generation: bound.thread?.generation ?? null,
    local_thread: bound.thread?.localThreadId ?? null,
    engine_thread: bound.thread?.engineThreadId ?? null,
  });
  const engineThreadId = bound.thread?.engineThreadId;
  if (!engineThreadId) throw new Error("the studio did not create an engine thread");

  // 1. The engine's own pending lists, as the real Runtime reports them.
  const detail = await engineJson(`/v1/threads/${engineThreadId}`);
  const detailKeys = detail.json !== null ? Object.keys(detail.json) : [];
  step("thread_detail", {
    status: detail.status,
    keys: detailKeys,
    pending_approvals: Array.isArray(detail.json?.pending_approvals)
      ? detail.json.pending_approvals.length
      : null,
    pending_user_inputs: Array.isArray(detail.json?.pending_user_inputs)
      ? detail.json.pending_user_inputs.length
      : null,
  });

  const transport = new HttpRuntimeTransport({ baseUrl, token });
  const adapter = new CodewhaleAdapter({
    transport,
    store: new SqliteSubmissionStore(store, projectId),
    workspace,
  });
  const pending = await adapter.readPendingRequests({ threadId: engineThreadId });
  step("adapter_read_pending", {
    available: pending.available,
    approvals: pending.approvals.length,
    inputs: pending.inputs.length,
  });

  // 2. The reply routes themselves: a capability that is not pending must be
  //    refused, and Mona must report that as "expired", not as delivered.
  const syntheticApproval = `approval_${"0".repeat(32)}`;
  const syntheticInput = `request_${"0".repeat(16)}`;
  const approvalReply = await adapter.answerApproval({
    threadId: engineThreadId,
    approvalId: syntheticApproval,
    decision: "allow",
    remember: false,
  });
  step("approval_reply_unknown_capability", approvalReply);
  const inputReply = await adapter.answerUserInput({
    threadId: engineThreadId,
    requestId: syntheticInput,
    answers: [{ questionId: "q1", label: "yes", value: "yes" }],
  });
  step("user_input_reply_unknown_request", inputReply);

  const rawApproval = await engineJson(`/v1/approvals/${syntheticApproval}`, {
    method: "POST",
    body: JSON.stringify({ decision: "allow", remember: false }),
  });
  step("raw_approval_route", { status: rawApproval.status, body: rawApproval.json });

  // 3. Mona's row lifecycle against the real engine's list. A row recorded from
  //    a request the engine does not list is marked expired on reconcile, with
  //    the reason stated; its record stays readable.
  const threadRow = await store.listModeThreads(projectId, "work");
  const localThreadId = threadRow[0]?.id;
  if (!localThreadId) throw new Error("the studio did not record a local thread");
  const recorded = await store.recordPendingRequest({
    projectId,
    threadId: localThreadId,
    engineThreadId,
    kind: "approval",
    requestKey: syntheticApproval,
    toolName: "bash",
    title: "Run `node verify.mjs` in the project root",
    summary: "Run `node verify.mjs` in the project root",
    detail: {
      kind: "approval",
      requestKey: syntheticApproval,
      turnId: null,
      toolName: "bash",
      title: "Run `node verify.mjs` in the project root",
      summary: "Run `node verify.mjs` in the project root",
      input: { command: "node verify.mjs" },
      toolCallId: null,
      decisions: ["allow", "deny"],
    },
  });
  step("row_recorded", { id: recorded.id, status: recorded.status, kind: recorded.kind });

  const beforeReconcile = await studio.snapshot(projectId);
  step("snapshot_before_reconcile", {
    pending: beforeReconcile.pendingRequests.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      can_answer: row.canAnswer,
    })),
  });

  await studio.start(projectId);
  const afterReconcile = await store.getPendingRequest(recorded.id);
  step("row_after_reconcile", {
    status: afterReconcile?.status ?? null,
    note: afterReconcile?.note ?? null,
  });

  // 4. A restart is a *new* studio over the same store. The stored row and the
  //    engine's list are the only state it has; a fresh instance is what proves
  //    a request survives losing the process that recorded it.
  const restarted = new WorkStudio({
    store,
    supervisor,
    work: new WorkController({
      interrupt: async () => ({
        interrupted: false,
        turn: null,
        note: "the R07 smoke starts no turn",
      }),
      stopOwnedRuntime: async () => stopReceipt,
    }),
  });
  const restartedSnapshot = await restarted.start(projectId);
  const afterRestart = await store.getPendingRequest(recorded.id);
  // The real engine cannot be asked to list a synthetic capability, so the
  // restart proves what only a restart can: the row is still there, still
  // readable, and the fresh studio rendered it from the store rather than from
  // the process that recorded it. The reopen-while-listed path is proven by the
  // unit tests, which can control the engine's answer.
  step("row_after_restart", {
    status: afterRestart?.status ?? null,
    note: afterRestart?.note ?? null,
    same_row: afterRestart?.id === recorded.id,
    rendered_by_fresh_studio: restartedSnapshot.pendingRequests.some(
      (row) => row.id === recorded.id,
    ),
  });
  await restarted.close();

  // 5. A reply for a row that is no longer pending is refused before it is
  //    sent, so no second decision can reach a single-use capability.
  let refused = null;
  try {
    await studio.answerPending(projectId, recorded.id, {
      kind: "approval",
      decision: "allow",
      remember: false,
    });
  } catch (error) {
    refused = { code: error?.code ?? null, message: error?.message ?? String(error) };
  }
  step("answer_refused_after_expiry", refused);

  // 6. No model request anywhere.
  const usage = await engineJson("/v1/usage");
  // A failed usage read is not "zero turns": the assertion below requires the
  // read to have succeeded and reported zero, so an unreachable endpoint cannot
  // pass as a clean run.
  const usageTurns = usage.json?.totals?.turns;
  report.model_requests = typeof usageTurns === "number" ? usageTurns : null;
  report.engine_usage = {
    status: usage.status,
    turns: typeof usageTurns === "number" ? usageTurns : null,
    cost_complete: usage.json?.totals?.cost_complete ?? null,
  };

  report.assertions = {
    engine_reports_pending_lists:
      Array.isArray(detail.json?.pending_approvals) &&
      Array.isArray(detail.json?.pending_user_inputs),
    adapter_reads_engine_lists: pending.available === true,
    approval_route_exists: rawApproval.status === 404,
    unknown_approval_is_not_an_acknowledgement: approvalReply.acknowledged === false,
    unknown_approval_maps_to_expired_note: /no longer pending/.test(approvalReply.note),
    unknown_input_is_not_an_acknowledgement: inputReply.acknowledged === false,
    row_recorded_pending: recorded.status === "pending" && recorded.kind === "approval",
    capability_kept_in_main: !JSON.stringify(beforeReconcile.pendingRequests).includes(
      syntheticApproval,
    ),
    row_expired_by_engine_list: afterReconcile?.status === "expired",
    row_survives_a_fresh_studio:
      afterRestart !== null &&
      afterRestart.id === recorded.id &&
      restartedSnapshot.pendingRequests.some((row) => row.id === recorded.id),
    expiry_has_a_reason: /no longer lists/.test(afterReconcile?.note ?? ""),
    expired_row_cannot_be_answered: refused !== null,
    no_model_request: usage.status === 200 && report.model_requests === 0,
  };

  await studio.close();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.server_log_tail = serverLog.split("\n").slice(-12).join("\n");
} finally {
  server.kill("SIGTERM");
  await new Promise((done) => setTimeout(done, 300));
  server.kill("SIGKILL");
  if (store) {
    try {
      await store.close();
    } catch {
      // the store is closed with the process
    }
  }
}

report.ok = Object.values(report.assertions ?? {}).every(Boolean) && !report.error;
report.cleanup = redact({ base, home, workspace, product });
const artifactDir = join(ROOT, "docs", "evidence", "macos", "review-studio", "artifacts");
await mkdir(artifactDir, { recursive: true });
const redacted = redact(report);
await writeFile(
  join(artifactDir, "r07-pending-smoke.json"),
  JSON.stringify(redacted, null, 2) + "\n",
);
console.log(JSON.stringify(redacted, null, 2));
process.exit(report.ok ? 0 : 1);
