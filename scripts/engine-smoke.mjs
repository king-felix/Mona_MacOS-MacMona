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

const workspace = await mkdtemp(join(tmpdir(), "mona-engine-smoke-"));
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
let handle = null;
try {
  handle = await adapter.startOwnedRuntime({ workspace });
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
  if (handle) await adapter.shutdownOwnedRuntime(handle);
  await rm(workspace, { recursive: true, force: true });
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
