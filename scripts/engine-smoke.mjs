#!/usr/bin/env node
// Real pinned-runtime smoke test for the P03 adapter.
// Starts the installed native Codewhale binary, runs one tiny tool-free turn,
// verifies discovery, submission, replay projection, route identity, operation
// lookup, usage, interrupt routing, and clean shutdown.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const { CodewhaleAdapter } = require(join(ROOT, "dist/main/main/engine/adapter.js"));
const { MemorySubmissionStore } = require(join(ROOT, "dist/main/main/engine/submission-store.js"));
const { OwnershipStore } = require(join(ROOT, "dist/main/main/supervisor/records.js"));
const { listeningPids } = require(join(ROOT, "dist/main/main/supervisor/identity.js"));

const workspace = await mkdtemp(join(tmpdir(), "mona-engine-smoke-"));
const stateDir = await mkdtemp(join(tmpdir(), "mona-engine-state-"));
await mkdir(join(workspace, "src"), { recursive: true });
const stamp = Date.now();
const threadKey = `cwc-smoke-thread-${stamp}`;
const turnKey = `cwc-smoke-turn-${stamp}`;
const result = {
  schema_version: 1,
  ok: false,
  engine: null,
  thread_id: null,
  turn_id: null,
  turn_status: null,
  effective: null,
  usage: null,
  projection: null,
  checks: {},
  error: null,
};

const adapter = new CodewhaleAdapter({ store: new MemorySubmissionStore() });
const ownership = new OwnershipStore(join(stateDir, "runtime-ownership.json"));
let handle = null;
try {
  handle = await adapter.startOwnedRuntime({
    workspace,
    stateDir,
    logDir: join(stateDir, "logs"),
    startupTimeoutMs: 30_000,
  });
  const liveRecords = ownership.live();
  result.supervision = {
    supervisor_pid: handle.pid,
    child_pid: handle.childPid,
    child_started_at: handle.childStartedAt,
    pgid: handle.pgid,
    listener_pid: handle.listenerPid,
    ownership_id: handle.ownershipId,
    executable_sha256: handle.executableSha256,
    records: liveRecords.map((record) => ({
      id: record.id,
      state: record.state,
      port: record.port,
      executable: record.executable,
      has_token: Object.hasOwn(record, "token"),
    })),
  };
  const caps = await adapter.discover();
  result.engine = caps.identity;

  const thread = await adapter.createOrOpenThread({
    workspace,
    title: "P03 adapter smoke",
    operationKey: threadKey,
    execute: { autoApprove: true, trustMode: true, allowShell: true },
    allowedTools: [],
  });
  result.thread_id = thread.threadId;

  const receipt = await adapter.submitTurn({
    threadId: thread.threadId,
    prompt: "Reply with exactly: pong",
    operationKey: turnKey,
  });
  result.turn_id = receipt.turnId;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let events = 0;
  let diagnostics = 0;
  const diagnosticReasons = [];
  const streamItems = [];
  try {
    for await (const item of adapter.subscribe({
      threadId: thread.threadId,
      signal: controller.signal,
    })) {
      streamItems.push(
        item.type === "event"
          ? `event:${item.event.kind}`
          : item.type === "end"
            ? `end:${item.reason}`
            : item.type === "progress"
              ? `progress:${item.state}`
              : `diagnostic:${item.reason}`,
      );
      if (item.type === "event") {
        events += 1;
        if (item.event.kind === "turn.completed") controller.abort();
      } else if (item.type === "diagnostic") {
        diagnostics += 1;
        diagnosticReasons.push({ reason: item.reason, raw: item.raw ?? null });
      } else if (item.type === "progress") {
        continue;
      } else break;
    }
  } finally {
    clearTimeout(timer);
  }

  const history = await adapter.readHistory({ threadId: thread.threadId });
  const turn = history.turns.find((candidate) => candidate.id === receipt.turnId) ?? null;
  result.turn_status = turn?.status ?? null;
  result.effective = turn
    ? {
        provider: turn.effectiveProvider,
        model: turn.effectiveModel,
        permission_posture: turn.permissionPosture,
      }
    : null;

  const profile = turn
    ? await adapter.getEffectiveProfile({
        threadId: thread.threadId,
        turnId: turn.id,
        requested: {
          provider: "deepseek",
          model: "deepseek-flash",
          permissionPosture: "full_access",
        },
        strict: true,
      })
    : null;

  const lookup = await adapter.reconcileSubmission({ submission: receipt.submission });
  const usage = await adapter.readUsage({
    since: new Date(Date.now() - 10 * 60_000).toISOString(),
  });
  result.projection = adapter.getProjectedState(thread.threadId);
  result.usage = { totals: usage.totals };
  let interrupt = null;
  try {
    interrupt = turn
      ? await adapter.interrupt({ threadId: thread.threadId, turnId: turn.id })
      : null;
  } catch (error) {
    interrupt = { interrupted: false, note: `interrupt route error: ${error.message}` };
  }

  result.checks = {
    discovered: caps.identity.version === "0.10.2",
    thread_created: Boolean(thread.threadId),
    turn_completed: turn?.status === "completed",
    effective_route_verified: Boolean(
      profile && profile.effective.permissionPosture === "full_access",
    ),
    projection_completed: result.projection?.status === "completed",
    projection_permission_full_access: result.projection?.permissionPosture === "full_access",
    no_stream_diagnostics: diagnostics === 0,
    operation_lookup_same_turn: lookup.turnId === receipt.turnId && lookup.evidence === "lookup",
    usage_reported: usage.totals.turns >= 1,
    interrupt_route_reachable: interrupt !== null,
    supervised_runtime: handle.pid > 0 && handle.childPid > 0 && handle.pgid === handle.childPid,
    ownership_record_running: liveRecords.length === 1 && liveRecords[0].state === "running",
    record_has_no_token: liveRecords.every((record) => !Object.hasOwn(record, "token")),
  };
  result.events = events;
  result.diagnostic_reasons = diagnosticReasons;
  result.stream_items = streamItems.slice(0, 40);
  result.lookup = { status: lookup.status, evidence: lookup.evidence };
  result.interrupt = { confirmed: interrupt?.interrupted ?? null, note: interrupt?.note ?? null };
  result.ok = Object.values(result.checks).every(Boolean);
} catch (error) {
  result.error = { message: error.message, code: error.code ?? null, stack: error.stack };
} finally {
  if (handle) {
    const shutdown = await adapter.shutdownOwnedRuntime(handle);
    const port = handle.port;
    let supervisorGone = false;
    for (let attempt = 0; attempt < 40 && !supervisorGone; attempt += 1) {
      try {
        process.kill(handle.pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        supervisorGone = true;
      }
    }
    const childGone = (() => {
      try {
        process.kill(handle.childPid, 0);
        return false;
      } catch {
        return true;
      }
    })();
    const record = ownership.get(handle.ownershipId);
    result.shutdown = {
      stopped: shutdown.stopped,
      supervisor_gone: supervisorGone,
      child_gone: childGone,
      listeners_after_stop: listeningPids(port),
      record_state: record?.state ?? null,
    };
    result.checks.supervisor_stopped = shutdown.stopped === true;
    result.checks.supervisor_process_gone = supervisorGone;
    result.checks.no_listener_after_stop = listeningPids(port).length === 0;
    result.checks.ownership_record_stopped = record?.state === "stopped";
    result.ok = result.ok && Object.values(result.checks).every(Boolean);
  }
  await rm(workspace, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
