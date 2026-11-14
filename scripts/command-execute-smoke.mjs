#!/usr/bin/env node
// R04 live smoke: the command-to-native route matrix and a real `/new` lifecycle
// against the pinned 0.10.2 engine, with no model request.
//
// Every step is local. `/new` creates engine threads through `POST /v1/threads`;
// no turn is ever submitted, so the run costs nothing and the provider is never
// called. The engine runs in an isolated HOME over a temporary workspace, so no
// user store or conversation is touched.
//
//   npm run build:main && node scripts/command-execute-smoke.mjs
//
// The report is written to
// docs/evidence/macos/review-studio/artifacts/r04-command-execute-smoke.json.

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
const { CommandCatalogService } = require(join(ROOT, "dist/main/main/work/commands.js"));
const { CommandDispatchService } = require(join(ROOT, "dist/main/main/work/command-dispatch.js"));

const base = await mkdtemp(join(tmpdir(), "mona-r04-smoke-"));
const home = join(base, "home");
const codeHome = join(home, ".codewhale");
const workspace = join(base, "ws");
const product = join(base, "product");
await mkdir(codeHome, { recursive: true });
await mkdir(workspace, { recursive: true });
await mkdir(product, { recursive: true });

const port = 7940 + Math.floor(Math.random() * 40);
const token = randomBytes(24).toString("hex");
const binary = "/opt/homebrew/bin/codewhale";
const baseUrl = `http://127.0.0.1:${port}`;
const engine = { version: "0.10.2", commit: "ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e" };
const report = {
  task: "R04",
  captured_at: new Date().toISOString(),
  platform: "darwin-arm64",
  engine,
  isolated: "temporary HOME, CODEWHALE_HOME, workspace, product state",
  model_requests: 0,
  note: "No turn was submitted. /new creates engine threads; it never calls a provider.",
  steps: [],
  threads: null,
  cost: null,
  cleanup: null,
};

function step(name, detail) {
  report.steps.push({ name, ...detail });
}

function redact(value) {
  return JSON.parse(
    JSON.stringify(value).split(base).join("~r04-smoke").split(home).join("~r04-home"),
  );
}

const server = spawn(
  binary,
  // The token travels in the environment: the CLI warns that --auth-token is
  // visible in the process list, and this smoke does not need to expose it.
  ["app-server", "--http", "--port", String(port)],
  {
    cwd: workspace,
    env: {
      ...process.env,
      HOME: home,
      CODEWHALE_HOME: codeHome,
      CODEWHALE_RUNTIME_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let serverLog = "";
server.stdout.on("data", (chunk) => {
  serverLog += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  serverLog += chunk.toString();
});

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
  ownershipId: "own_r04smoke",
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
  ownershipId: "own_r04smoke",
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
    capabilities: {
      thread_create_idempotency: info.capabilities?.thread_create_idempotency === true,
      turns: info.capabilities?.turns === true,
    },
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
        note: "the R04 smoke starts no turn",
      }),
      stopOwnedRuntime: async () => stopReceipt,
    }),
  });
  const dispatcher = new CommandDispatchService({
    catalog: new CommandCatalogService(),
    studio,
  });

  const started = await studio.start(projectId);
  step("studio_started", {
    connection: started.connection.state,
    engine: started.connection.engine,
  });

  async function dispatch(spelling, args, operationKey, extra = {}) {
    const receipt = await dispatcher.execute({
      projectId,
      mode: "work",
      spelling,
      arguments: args,
      operationKey,
      ...extra,
    });
    step(`dispatch_${spelling.replace(/[^a-z0-9]+/gi, "_")}`, {
      spelling,
      arguments: args,
      route: receipt.route,
      status: receipt.status,
      cost: receipt.cost,
      side_effects: receipt.sideEffects,
      note: receipt.note,
      target: receipt.target,
      thread: receipt.thread,
      duplicate: receipt.duplicate,
      detail: receipt.detail,
      active_turn: receipt.snapshot?.activeTurnId ?? null,
      cost_label: receipt.snapshot?.cost.label ?? null,
    });
    return receipt;
  }

  const first = await dispatch("new", "", "r04-smoke-new-0001");
  const second = await dispatch("new", "", "r04-smoke-new-0002");
  const forced = await dispatch("new", "--force", "r04-smoke-new-0003");

  const duplicate = await dispatch("new", "", "r04-smoke-new-0002");

  const renamed = await dispatch("rename", "Live smoke title", "r04-smoke-rename-1");
  const engineRename = await engineJson(`/v1/threads/${renamed.thread.engineThreadId}`);

  const view = await dispatch("cost", "", "r04-smoke-view-1");
  const terminal = await dispatch("theme", "", "r04-smoke-terminal-1");
  const unavailable = await dispatch("workflow", "", "r04-smoke-unavailable-1");
  const confirm = await dispatch("compact", "", "r04-smoke-compact-1");
  const injection = await dispatch("new", "; rm -rf /", "r04-smoke-inject-1");

  const localThreads = await store.listModeThreads(projectId, "work");
  const engineThreads = await engineJson("/v1/threads?limit=50");
  const usage = await engineJson("/v1/usage");
  const snapshot = await studio.snapshot(projectId);
  report.model_requests = usage.json?.totals?.turns ?? 0;
  report.engine_usage = {
    status: usage.status,
    turns: usage.json?.totals?.turns ?? null,
    cost_complete: usage.json?.totals?.cost_complete ?? null,
  };

  report.threads = {
    local: localThreads.map((thread) => ({
      local_thread_id: thread.id,
      engine_thread_id: thread.engineThreadId,
      title: thread.title,
      mode: thread.mode,
      generation: thread.generation,
    })),
    engine: (Array.isArray(engineThreads.json) ? engineThreads.json : []).map((thread) => ({
      id: thread.id,
      workspace: thread.workspace,
      title: thread.title ?? null,
      archived: thread.archived ?? null,
    })),
    distinct_engine_ids: new Set(
      localThreads.map((thread) => thread.engineThreadId).filter(Boolean),
    ).size,
    earlier_rows_present: localThreads.length >= 3,
    rename_confirmed_by_engine:
      engineRename.status === 200 &&
      (engineRename.json?.thread?.title ?? engineRename.json?.title ?? "") === "Live smoke title",
    engine_threads_found: Array.isArray(engineThreads.json) ? engineThreads.json.length : 0,
  };
  const renameThread = engineRename.json?.thread ?? engineRename.json;
  report.rename_engine_response = {
    status: engineRename.status,
    keys: engineRename.json !== null ? Object.keys(engineRename.json).slice(0, 8) : [],
    id: renameThread?.id ?? null,
    title: renameThread?.title ?? null,
    local_engine_thread_id: renamed.thread?.engineThreadId ?? null,
  };
  report.engine_list_status = engineThreads.status;
  report.cost = {
    label: snapshot.cost.label,
    observed: snapshot.cost.observed,
    turns: snapshot.cost.turns,
  };
  report.assertions = {
    three_generations:
      first.thread?.generation === 0 &&
      second.thread?.generation === 1 &&
      forced.thread?.generation === 2,
    distinct_engine_threads: report.threads.distinct_engine_ids === 3,
    duplicate_returns_same_thread:
      duplicate.duplicate === true &&
      duplicate.thread?.localThreadId === second.thread?.localThreadId,
    rename_route_completed: renamed.status === "completed",
    rename_confirmed_by_engine: report.threads.rename_confirmed_by_engine === true,
    view_route: view.route === "view" && view.target.screen === "cost",
    terminal_route:
      terminal.route === "terminal" &&
      terminal.status === "deferred" &&
      terminal.target.invocation === "codewhale",
    unavailable_route: unavailable.status === "not-executable",
    spend_needs_confirmation: confirm.status === "confirmation-required",
    injection_refused: injection.status === "invalid-argument" && injection.thread === null,
    no_provider_usage: snapshot.cost.observed === false && snapshot.cost.turns === 0,
    no_model_request: report.model_requests === 0,
  };

  await studio.close();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.server_log_tail = serverLog.split("\n").slice(-12).join("\n");
} finally {
  try {
    if (store) await store.close();
  } catch {
    // closing is cleanup, not evidence
  }
  server.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((done) =>
      server.once("exit", (code, signal) => done({ code, signal, within_ms: 5_000 })),
    ),
    new Promise((done) =>
      setTimeout(() => done({ code: null, signal: null, killed: true }), 5_000),
    ),
  ]);
  report.cleanup = {
    server: exited,
    note: "the isolated runtime was stopped; no user store was touched",
  };
  const lines = serverLog
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-12);
  report.server_log_tail = redact(lines);

  const target = join(
    ROOT,
    "docs/evidence/macos/review-studio/artifacts/r04-command-execute-smoke.json",
  );
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, `${JSON.stringify(redact(report), null, 2)}\n`);
  console.log(JSON.stringify({ ok: report.error === undefined, report: target }, null, 2));
}
