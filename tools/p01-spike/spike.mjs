#!/usr/bin/env node
// P01 feasibility spike: prove G0/G1/G2 against the installed pinned engine.
// Disposable test client, not product code. Node stdlib only.

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_BIN,
  RuntimeClient,
  sleep,
  startRuntime,
  stopRuntime,
  verifyOwnership,
  waitFor,
} from "./lib/runtime.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith("--")) ?? "all";
const outPath = readFlag("--out");
const result = {
  schema_version: 1,
  mode,
  started_utc: new Date().toISOString(),
  engine: null,
  steps: {},
  findings: [],
};

function readFlag(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function note(step, value) {
  result.steps[step] = value;
  console.error(`[${step}] ${JSON.stringify(value).slice(0, 400)}`);
}

function finding(text) {
  result.findings.push(text);
  console.error(`[finding] ${text}`);
}

function findTurnId(body) {
  return body?.id ?? body?.turn?.id ?? body?.turn_id ?? body?.turnId ?? null;
}

function collectTurns(threadBody) {
  const candidates = [threadBody?.turns, threadBody?.thread?.turns, threadBody?.items];
  for (const list of candidates) if (Array.isArray(list)) return list;
  return [];
}

function latestTurn(threadBody) {
  const turns = collectTurns(threadBody);
  return turns.length ? turns[turns.length - 1] : threadBody?.thread?.latest_turn ?? null;
}

async function seedWorkspace(root) {
  const workspace = await mkdtemp(join(root, "ws-"));
  await writeFile(
    join(workspace, "verify.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'try {',
      '  const text = readFileSync("hello.txt", "utf8");',
      '  if (text.trim() === "hello mona") { console.log("PASS"); process.exit(0); }',
      '  console.log("FAIL: unexpected content " + JSON.stringify(text)); process.exit(1);',
      '} catch (error) {',
      '  console.log("FAIL: " + error.message); process.exit(2);',
      '}',
      "",
    ].join("\n"),
  );
  await writeFile(
    join(workspace, "verify2.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'const a = readFileSync("a.txt", "utf8").trim();',
      'const b = readFileSync("b.txt", "utf8").trim();',
      'if (a === "one" && b === "two") { console.log("PASS"); process.exit(0); }',
      'console.log(`FAIL a=${a} b=${b}`); process.exit(1);',
      "",
    ].join("\n"),
  );
  return workspace;
}

async function usageSnapshot(client, since) {
  const response = await client.request(
    "GET",
    `/v1/usage?since=${encodeURIComponent(since)}&group_by=thread`,
    undefined,
    { timeoutMs: 10_000 },
  );
  return { status: response.status, body: response.body };
}

async function runProbe() {
  const root = await mkdtemp(join(tmpdir(), "mona-p01-probe-"));
  const workspace = await seedWorkspace(root);
  const since = new Date(Date.now() - 60_000).toISOString();
  const handle = await startRuntime({ workspace });
  const { client } = handle;
  note("runtime_start", {
    pid: handle.identity.pid,
    port: handle.port,
    commit: handle.identity.codewhale_commit,
    version: handle.identity.codewhale_version,
    identity: { listener_pid: handle.identity.listener_pid, descendants: handle.identity.descendants },
    capabilities: handle.identity.capabilities,
  });
  result.engine = {
    version: handle.identity.codewhale_version,
    commit: handle.identity.codewhale_commit,
    binary: DEFAULT_BIN,
    sha256: spawnSync("shasum", ["-a", "256", DEFAULT_BIN.replace(/\/codewhale$/, "/bin/downloads/codewhale")], {
      encoding: "utf8",
    }).stdout?.split(/\s+/)[0] ?? null,
  };

  const before = await usageSnapshot(client, since);
  const endpoints = {};
  for (const path of [
    "/health",
    "/v1/runtime/info",
    "/v1/providers",
    "/v1/providers/deepseek/models",
    "/v1/threads",
    "/v1/threads/summary",
    "/v1/sessions",
    "/v1/usage?group_by=thread",
  ]) {
    const response = await client.request("GET", path, undefined, { timeoutMs: 10_000 });
    endpoints[path] = {
      status: response.status,
      bytes: response.text.length,
      sample: response.text.slice(0, 300),
    };
  }
  note("read_endpoints", endpoints);

  // Zero-inference surface: discovery + idle + history read + reconnect.
  await sleep(2000);
  const thread = await client.request("POST", "/v1/threads", {
    workspace,
    title: "P01 zero-inference probe",
  });
  note("probe_thread_create", { status: thread.status, id: thread.body?.id ?? null });
  const threadId = thread.body?.id;
  if (threadId) {
    await client.request("GET", `/v1/threads/${threadId}`, undefined, { timeoutMs: 10_000 });
    const controller = new AbortController();
    const streamTimer = setTimeout(() => controller.abort(), 2500);
    const streamed = await client.streamThread(threadId, {
      signal: controller.signal,
      onEvent: (frame) => {
        if (frame.event === "stream.end") controller.abort();
      },
    }).catch((error) => ({ aborted: error.name === "AbortError", message: error.message }));
    clearTimeout(streamTimer);
    note("empty_stream_reconnect", streamed);
  }
  const after = await usageSnapshot(client, since);
  const zero = {
    before_turns: before.body?.totals?.turns ?? null,
    after_turns: after.body?.totals?.turns ?? null,
    before_tokens:
      (before.body?.totals?.input_tokens ?? 0) + (before.body?.totals?.output_tokens ?? 0),
    after_tokens:
      (after.body?.totals?.input_tokens ?? 0) + (after.body?.totals?.output_tokens ?? 0),
  };
  zero.zero_inference = zero.before_turns === zero.after_turns && zero.before_tokens === zero.after_tokens;
  note("zero_inference", zero);
  if (!zero.zero_inference) finding("Discovery/idle/history/reconnect changed usage totals.");

  // Concurrency: a second owned runtime against the same installed store. The
  // engine has a single Runtime owner per user store, so a second app-server
  // may attach to the first instead of owning its listener. That is recorded
  // honestly as serialized execution, not manufactured as isolation.
  const workspace2 = await seedWorkspace(root);
  let second = null;
  try {
    second = await startRuntime({ workspace: workspace2, allowSharedOwner: true });
    const shared = second.identity.owned_socket === false;
    const t2 = await second.client.request("POST", "/v1/threads", {
      workspace: workspace2,
      title: "concurrency B",
    });
    // Does the first runtime's token authenticate the second port?
    const crossAuth = await client.request("GET", "/v1/runtime/info", undefined, { timeoutMs: 5000 });
    const r2 = await submitSimpleTurn(second.client, t2.body.id, "Reply with exactly: bravo");
    note("concurrency_result", {
      second_listener_pid: second.identity.listener_pid,
      first_listener_pid: handle.identity.listener_pid,
      second_owned_socket: second.identity.owned_socket,
      shared_owner: shared,
      thread_create_status: t2.status,
      second_turn: summarizeTurn(r2.turn),
      first_runtime_healthy: crossAuth.status,
      independent_coexistence: !shared,
      serialized_mode_required: shared,
    });
    if (shared) {
      finding(
        "A second app-server attached to the first Runtime owner instead of owning its listener; " +
          "Mona must serialize owned runtimes against one store rather than claim parallel isolation.",
      );
    }
  } catch (error) {
    note("concurrency_result", { independent_coexistence: false, error: error.message });
    finding(`Second owned runtime failed: ${error.message}`);
  } finally {
    if (second) await stopRuntime(second);
  }

  await stopRuntime(handle);
  await rm(root, { recursive: true, force: true });
  return result;
}

async function submitSimpleTurn(client, threadId, prompt) {
  const submitted = await client.request("POST", `/v1/threads/${threadId}/turns`, {
    prompt,
    allowed_tools: [],
  }, { timeoutMs: 60_000 });
  const turnId = findTurnId(submitted.body);
  const deadline = Date.now() + 120_000;
  let state = null;
  while (Date.now() < deadline) {
    const detail = await client.request("GET", `/v1/threads/${threadId}`, undefined, { timeoutMs: 10_000 });
    const turn = latestTurn(detail.body);
    state = turn;
    if (turn && ["completed", "failed", "interrupted", "canceled"].includes(turn.status)) break;
    await sleep(400);
  }
  return { submit: submitted.status, turn: state };
}

function summarizeTurn(turn) {
  return {
    id: turn?.id ?? null,
    status: turn?.status ?? null,
    provider: turn?.effective_provider ?? turn?.provider ?? null,
    model: turn?.effective_model ?? turn?.model ?? null,
    usage: turn?.usage ?? null,
    error: turn?.error ?? null,
    permission_posture: turn?.permission_posture ?? null,
    mode: turn?.mode ?? null,
  };
}

async function runLive() {
  const root = await mkdtemp(join(tmpdir(), "mona-p01-live-"));
  const workspace = await seedWorkspace(root);
  const handle = await startRuntime({ workspace });
  const { client } = handle;
  result.engine = {
    version: handle.identity.codewhale_version,
    commit: handle.identity.codewhale_commit,
    binary: DEFAULT_BIN,
  };

  // --- G0: real tool-enabled Full Access turn ---
  const created = await client.request("POST", "/v1/threads", {
    workspace,
    title: "P01 G0 tool task",
    auto_approve: true,
    trust_mode: true,
    allow_shell: true,
    mode: "agent",
  });
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`thread_create_failed status=${created.status} body=${created.text.slice(0, 500)}`);
  }
  const threadId = created.body?.id ?? created.body?.thread?.id;
  note("g0_thread", { status: created.status, id: threadId, body: created.body });

  const prompt =
    "Create the file hello.txt in this workspace containing exactly the text: hello mona\n" +
    "Then run the shell command `node verify.mjs` and report its output. Change nothing else.";
  const submitted = await client.request("POST", `/v1/threads/${threadId}/turns`, {
    prompt,
    operation_key: `p01-g0-${Date.now()}`,
  }, { timeoutMs: 120_000 });
  const turnId = findTurnId(submitted.body);
  note("g0_submit", { status: submitted.status, turn_id: turnId, body: submitted.body });

  const events = [];
  const controller = new AbortController();
  const streamPromise = client
    .streamThread(threadId, {
      signal: controller.signal,
      onEvent: (frame) => {
        events.push({ event: frame.event, id: frame.id, json: frame.json });
        if (["turn.completed", "turn.failed", "turn.interrupted", "stream.end"].includes(frame.event)) {
          controller.abort();
        }
      },
    })
    .catch((error) => ({ aborted: error.name === "AbortError", message: error.message }));

  const turn = await waitForTurn(client, threadId, turnId, 240_000);
  controller.abort();
  await streamPromise;
  const fileText = existsSync(join(workspace, "hello.txt"))
    ? await readFile(join(workspace, "hello.txt"), "utf8")
    : null;
  const items = events
    .filter((e) => e.event === "item.completed" && e.json?.payload?.item)
    .map((e) => e.json.payload.item);
  const itemKinds = items.reduce((counts, item) => {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    return counts;
  }, {});
  note("g0_result", {
    turn: summarizeTurn(turn),
    hello_txt: fileText,
    item_kinds: itemKinds,
    tool_items: items
      .filter((item) => ["tool_call", "command_execution", "file_change"].includes(item.kind))
      .map((item) => ({
        kind: item.kind,
        status: item.status,
        summary: item.summary,
        detail: typeof item.detail === "string" ? item.detail.slice(0, 400) : undefined,
      })),
    event_names: [...new Set(events.map((e) => e.event))],
    event_count: events.length,
  });
  if (turn?.status !== "completed") finding(`G0 turn did not complete: ${turn?.status}`);
  if (fileText?.trim() !== "hello mona") finding("G0 tool turn did not produce hello.txt.");

  // --- History ---
  const history = await client.request("GET", `/v1/threads/${threadId}`, undefined, { timeoutMs: 15_000 });
  note("g0_history", {
    status: history.status,
    turn_count: collectTurns(history.body).length,
    latest: summarizeTurn(latestTurn(history.body)),
    body_keys: Object.keys(history.body ?? {}),
  });

  // --- Resume: export to a session, then resume a thread from it ---
  const exported = await client.request("POST", "/v1/sessions", { thread_id: threadId }, { timeoutMs: 15_000 });
  note("g0_session_export", { status: exported.status, body: exported.body });
  if (exported.status === 200 || exported.status === 201) {
    const sessionId = exported.body?.session_id ?? exported.body?.id ?? exported.body?.session?.id;
    const resumed = await client.request(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/resume-thread`,
      { mode: "agent" },
      { timeoutMs: 20_000 },
    );
    note("g0_resume", {
      session_id: sessionId,
      status: resumed.status,
      thread_id: resumed.body?.thread_id ?? resumed.body?.id ?? resumed.body?.thread?.id ?? null,
      keys: Object.keys(resumed.body ?? {}),
    });
    if (![200, 201].includes(resumed.status)) finding("Resume from saved session failed.");
  } else {
    finding("Session export failed; resume not proven through the session store.");
  }

  // --- Interrupt a controlled long-running command ---
  const created2 = await client.request("POST", "/v1/threads", {
    workspace,
    title: "P01 interrupt",
    auto_approve: true,
    trust_mode: true,
    allow_shell: true,
    mode: "agent",
  });
  const thread2 = created2.body?.id ?? created2.body?.thread?.id;
  const submitted2 = await client.request("POST", `/v1/threads/${thread2}/turns`, {
    prompt: "Run the shell command `sleep 30` and wait for it to finish, then report done. Use the shell tool.",
    operation_key: `p01-int-${Date.now()}`,
  }, { timeoutMs: 60_000 });
  const turn2 = findTurnId(submitted2.body);
  // Give the turn time to start streaming before interrupting.
  await waitFor(async () => {
    const detail = await client.request("GET", `/v1/threads/${thread2}`, undefined, { timeoutMs: 10_000 });
    const t = collectTurns(detail.body).find((x) => x.id === turn2) ?? latestTurn(detail.body);
    return t && t.status === "in_progress" ? t : null;
  }, { timeoutMs: 60_000, label: "turn_in_progress" }).catch(() => null);
  await sleep(1500);
  const interrupted = await client.request(
    "POST",
    `/v1/threads/${thread2}/turns/${turn2}/interrupt`,
    {},
    { timeoutMs: 20_000 },
  );
  const turn2Final = await waitForTurn(client, thread2, turn2, 60_000);
  const leftover = spawnSync("pgrep", ["-f", `^sleep 30$`], { encoding: "utf8" });
  note("g0_interrupt", {
    request_status: interrupted.status,
    receipt: interrupted.body,
    final_turn: summarizeTurn(turn2Final),
    stray_sleep_processes: leftover.stdout.trim() ? leftover.stdout.trim().split("\n") : [],
  });
  const interruptConfirmed =
    interrupted.status === 200 && ["interrupted", "canceled"].includes(turn2Final?.status);
  if (!interruptConfirmed) {
    finding("Interrupt was not confirmed by the runtime receipt plus final turn status.");
  }

  await stopRuntime(handle);
  await rm(root, { recursive: true, force: true });
  return result;
}

async function waitForTurn(client, threadId, turnId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const detail = await client.request("GET", `/v1/threads/${threadId}`, undefined, { timeoutMs: 15_000 });
    const turns = collectTurns(detail.body);
    last = turns.find((t) => t.id === turnId) ?? latestTurn(detail.body);
    if (last && ["completed", "failed", "interrupted", "canceled"].includes(last.status)) return last;
    await sleep(500);
  }
  return last;
}

async function runEconomics() {
  const root = await mkdtemp(join(tmpdir(), "mona-p01-econ-"));
  const ceiling = 2.0;
  const tasks = [
    {
      id: "file-change",
      prompt:
        "Create hello.txt in this workspace containing exactly the text: hello mona\n" +
        "Then run `node verify.mjs` and report its output.",
    },
    {
      id: "diagnostic",
      prompt:
        "Read verify.mjs and answer in one sentence: which file does it read, and what does it print on success? Do not modify any file.",
    },
    {
      id: "multi-step",
      prompt:
        "Create a.txt containing exactly: one\nThen create b.txt containing exactly: two\nThen run `node verify2.mjs` and report its output.",
    },
  ];
  const rows = [];
  let estimatedTotal = 0;

  for (const task of tasks) {
    // Direct engine: codewhale exec --auto --json in its own clean workspace.
    const directWs = await seedWorkspace(root);
    const direct = runDirectExec(directWs, task.prompt);
    // Adapter: HTTP thread/turn on the owned runtime in its own clean workspace.
    const adapterWs = await seedWorkspace(root);
    const handle = await startRuntime({ workspace: adapterWs });
    const adapter = await runAdapterTurn(handle.client, adapterWs, task.prompt);
    await stopRuntime(handle);
    const directDone = await direct;

    const directCost = directDone.cost_usd ?? null;
    const adapterCost = adapter.cost_usd ?? null;
    if (adapterCost !== null) estimatedTotal += adapterCost;
    rows.push({
      task: task.id,
      direct: directDone,
      adapter,
      input_token_delta: ratioDelta(directDone.total_tokens, adapter.total_tokens),
      output_token_delta: ratioDelta(directDone.output_tokens, adapter.output_tokens),
      cost_delta_usd: directCost !== null && adapterCost !== null ? adapterCost - directCost : null,
      direct_cost_state: directDone.cost_state,
      adapter_cost_state: adapter.cost_state,
      accepted: (await acceptance(directWs, task.id)) && (await acceptance(adapterWs, task.id)),
    });
    note(`economics_${task.id}`, rows[rows.length - 1]);
    if (estimatedTotal > ceiling) {
      finding(`Pilot cost ${estimatedTotal.toFixed(4)} exceeded the $${ceiling} ceiling.`);
      break;
    }
  }

  const paired = rows.filter((r) => r.direct.total_tokens !== null && r.adapter.total_tokens !== null);
  const deltas = paired.map((r) => r.input_token_delta).filter((x) => x !== null);
  note("economics_summary", {
    ceiling_usd: ceiling,
    adapter_reported_total_usd: Number(estimatedTotal.toFixed(6)),
    pairs: rows.length,
    input_token_deltas: deltas,
    median_input_token_delta: deltas.length ? deltas.sort((a, b) => a - b)[Math.floor(deltas.length / 2)] : null,
    direct_cost_state: "unknown",
    direct_cost_reason:
      "`codewhale exec` in agent mode reports total_tokens in session metadata but no token split and no cost; " +
      "coverage_recorded=false means its 0.0 must not be read as zero cost.",
    provisional: true,
    note:
      "One pair per task under a $2 ceiling is provisional, not a statistical parity claim. " +
      "Token parity is measured; direct cost is unverified and adapter cost is engine-reported.",
  });
  await rm(root, { recursive: true, force: true });
  return result;
}

function ratioDelta(base, value) {
  if (typeof base !== "number" || typeof value !== "number" || base === 0) return null;
  return (value - base) / base;
}

async function acceptance(workspace, taskId) {
  if (taskId === "file-change") {
    if (!existsSync(join(workspace, "hello.txt"))) return false;
    return (await readFile(join(workspace, "hello.txt"), "utf8")).trim() === "hello mona";
  }
  if (taskId === "multi-step") {
    if (!existsSync(join(workspace, "a.txt")) || !existsSync(join(workspace, "b.txt"))) return false;
    const a = (await readFile(join(workspace, "a.txt"), "utf8")).trim();
    const b = (await readFile(join(workspace, "b.txt"), "utf8")).trim();
    return a === "one" && b === "two";
  }
  return true;
}

function runDirectExec(workspace, prompt) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      DEFAULT_BIN,
      ["exec", "--auto", "--json", "--model", "deepseek-flash", prompt],
      { cwd: workspace, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", async (code) => {
      let summary = null;
      try {
        summary = JSON.parse(stdout.trim());
      } catch {
        for (const line of stdout.split(/\r?\n/).reverse()) {
          try {
            summary = JSON.parse(line);
            break;
          } catch {}
        }
      }
      const usage = summary?.usage ?? {};
      // Agent-mode `exec --json` omits usage, so fall back to the saved
      // session's metadata, which records total_tokens. Cost coverage is
      // recorded there too; an unpriced 0.0 is unknown, never free.
      const session = await readSessionTotals(workspace);
      const inputTokens = pickNumber(usage, ["input_tokens", "inputTokens"]);
      const outputTokens = pickNumber(usage, ["output_tokens", "outputTokens"]);
      resolve({
        mode: "direct-exec",
        exit_code: code,
        elapsed_ms: Date.now() - started,
        session_id: summary?.session_id ?? summary?.sessionId ?? session?.id ?? null,
        provider: summary?.provider ?? summary?.effective_provider ?? session?.model_provider ?? null,
        model: summary?.model ?? summary?.effective_model ?? session?.model ?? null,
        status: summary?.status ?? null,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cached_tokens: pickNumber(usage, ["prompt_cache_hit_tokens"]),
        cache_miss_tokens: pickNumber(usage, ["prompt_cache_miss_tokens"]),
        reasoning_tokens: pickNumber(usage, ["reasoning_tokens"]),
        total_tokens:
          inputTokens !== null && outputTokens !== null
            ? inputTokens + outputTokens
            : (session?.total_tokens ?? null),
        token_source: inputTokens !== null ? "exec-summary" : session ? "session-metadata" : "unavailable",
        cost_usd: pickNumber(summary, ["cost_usd", "costUsd", "usage.cost_usd", "usage.costUsd"]),
        cost_state: session?.cost_coverage ? "reported" : "unknown",
        cost_detail: session?.cost ?? null,
        summary_keys: summary ? Object.keys(summary) : [],
        stderr_tail: stderr.slice(-500),
      });
    });
  });
}

async function readSessionTotals(workspace) {
  const home = process.env.CODEWHALE_HOME || join(process.env.HOME, ".codewhale");
  const dir = join(home, "sessions");
  const target = await realpath(workspace).catch(() => workspace);
  let newest = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      return null;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith("session_boot")) continue;
      try {
        const doc = JSON.parse(await readFile(join(dir, name), "utf8"));
        const meta = doc.metadata;
        if (!meta?.workspace) continue;
        const ws = await realpath(meta.workspace).catch(() => meta.workspace);
        if (ws !== target) continue;
        if (!newest || String(meta.updated_at) > String(newest.updated_at)) {
          newest = {
            id: meta.id,
            updated_at: meta.updated_at,
            total_tokens: meta.total_tokens,
            model: meta.model,
            model_provider: meta.model_provider,
            cost_coverage: meta.cost?.coverage_recorded === true,
            cost: meta.cost,
          };
        }
      } catch {}
    }
    if (newest?.total_tokens) return newest;
    await sleep(200);
  }
  return newest;
}

function pickNumber(object, paths) {
  for (const path of paths) {
    let value = object;
    for (const part of path.split(".")) value = value?.[part];
    if (typeof value === "number") return value;
  }
  return null;
}

async function runAdapterTurn(client, workspace, prompt) {
  const since = new Date(Date.now() - 5_000).toISOString();
  const created = await client.request("POST", "/v1/threads", {
    workspace,
    title: "P01 economics",
    auto_approve: true,
    trust_mode: true,
    allow_shell: true,
    mode: "agent",
  });
  const threadId = created.body?.id ?? created.body?.thread?.id;
  const started = Date.now();
  const submitted = await client.request("POST", `/v1/threads/${threadId}/turns`, {
    prompt,
    operation_key: `p01-econ-${threadId}-${Date.now()}`,
  }, { timeoutMs: 120_000 });
  const turnId = findTurnId(submitted.body);
  const turn = await waitForTurn(client, threadId, turnId, 240_000);
  const usage = await client.request(
    "GET",
    `/v1/usage?since=${encodeURIComponent(since)}&group_by=thread`,
    undefined,
    { timeoutMs: 10_000 },
  );
  const bucket = (usage.body?.buckets ?? []).find((b) => b.key === threadId) ?? null;
  return {
    mode: "adapter-http",
    submit_status: submitted.status,
    elapsed_ms: Date.now() - started,
    status: turn?.status ?? null,
    provider: turn?.effective_provider ?? null,
    model: turn?.effective_model ?? null,
    input_tokens: turn?.usage?.input_tokens ?? bucket?.input_tokens ?? null,
    output_tokens: turn?.usage?.output_tokens ?? bucket?.output_tokens ?? null,
    cached_tokens: turn?.usage?.prompt_cache_hit_tokens ?? null,
    cache_miss_tokens: turn?.usage?.prompt_cache_miss_tokens ?? null,
    reasoning_tokens: turn?.usage?.reasoning_tokens ?? null,
    total_tokens:
      turn?.usage ? (turn.usage.input_tokens ?? 0) + (turn.usage.output_tokens ?? 0) : null,
    cost_usd: bucket?.cost_usd ?? null,
    cost_state: bucket?.cost_complete ? "reported" : "unknown",
    usage_bucket: bucket,
    permission_posture: turn?.permission_posture ?? null,
  };
}

async function main() {
  await mkdir(join(ROOT, ".p01"), { recursive: true });
  if (mode === "probe" || mode === "all") await runProbe();
  if (mode === "live" || mode === "all") await runLive();
  if (mode === "economics" || mode === "all") await runEconomics();
  result.finished_utc = new Date().toISOString();
  const text = JSON.stringify(result, null, 1);
  if (outPath) {
    await writeFile(outPath, text + "\n");
    console.error(`wrote ${outPath}`);
  } else {
    process.stdout.write(text + "\n");
  }
}

main().catch(async (error) => {
  result.error = { message: error.message, stack: error.stack };
  result.finished_utc = new Date().toISOString();
  const text = JSON.stringify(result, null, 1);
  if (outPath) await writeFile(outPath, text + "\n").catch(() => {});
  console.error("SPIKE FAILED:", error.message);
  console.error(error.stack);
  process.exitCode = 1;
});
