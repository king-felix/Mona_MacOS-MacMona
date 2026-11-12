#!/usr/bin/env node
// Build docs/codewhale-capabilities-macos.json from the pinned engine surface.
// Curated routes are paired with measured evidence; no row claims support that
// was not observed or documented against Codewhale 0.10.2 (ff466b2ed0bf).

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const OUT = resolve(ROOT, "docs/codewhale-capabilities-macos.json");

const VERSION = "0.10.2";
const COMMIT = "ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e";
const SOURCE = "codewhale-hq/Codewhale@v0.10.2 (installed native binary)";

let seq = 0;
const rows = [];
function row(entry) {
  const id = entry.mona_id ?? `MONA-CAP-${String(++seq).padStart(3, "0")}`;
  rows.push({
    mona_id: id,
    upstream_name: entry.name,
    upstream_source: SOURCE,
    upstream_version: VERSION,
    platform: "macOS 26.5.1, arm64 (native)",
    classification: entry.classification,
    permission_implications: entry.permission,
    cost_implications: entry.cost ?? "No model inference by itself.",
    required_arguments: entry.args ?? "none",
    integration: entry.integration,
    ui_location: entry.ui,
    tests: entry.tests ?? "P03 contract test pending",
    status: entry.status,
    gap: entry.gap ?? null,
    ...(entry.evidence ? { evidence: entry.evidence } : {}),
  });
}

// --- CLI commands (all 43 discovered entries) ---
const cli = [
  ["run", "Run an interactive or non-interactive task", "write", "ask/full-access per profile; starts a turn", "May call the model once per turn.", "integrated_terminal", "Terminal launch (normal work uses the Runtime adapter, not the TUI)", "P03 Runtime turn contract", "unqualified", "Interactive TUI is not embedded; Mona drives normal turns through /v1/*."],
  ["doctor", "Run Codewhale diagnostics", "read", "read-only", "No inference.", "native_view", "Diagnostics panel", "p01: codewhale doctor --json", "verified", null, ["arn:p01-engine-surface.txt"]],
  ["session-diagnostics", "Summarize local session failure signals without raw content", "read", "read-only", "No inference.", "native_view", "Diagnostics / session detail", null, "unqualified", "Not exercised in P01; route is documented local-only."],
  ["scorecard", "Score recorded turn metrics against an optional baseline", "read", "read-only", "No inference.", "native_view", "Cost lens / quality panel", null, "unqualified", null],
  ["models", "List cached models; refresh configured catalogs with --update", "read", "read-only; --update performs network calls", "No inference; --update may incur no token cost.", "native_view", "Provider/model picker", "p01: codewhale models --provider deepseek --json; GET /v1/providers", "verified", null, ["arn:p01-engine-surface.txt"]],
  ["speech", "Generate speech audio with Xiaomi MiMo TTS models", "write", "uses configured TTS credentials", "Paid TTS; not a token-priced chat call.", "advanced_action", "Advanced actions", null, "unqualified", "TTS route not configured or needed for 1.0 core; no claim made."],
  ["sessions", "List saved sessions", "read", "read-only", "No inference.", "native_view", "Project/session browser", "p01: codewhale sessions; GET /v1/sessions", "verified", null, ["arn:p01-live.json"]],
  ["receipts", "Show what a session did (files, commands, web/MCP, agents, approvals, failures)", "read", "read-only; transcript may contain sensitive local content", "No inference.", "native_view", "Changes / evidence panel", "p01: codewhale receipts --last --format json; GET /v1/threads/{id}/receipt", "verified", null, ["arn:p01-economics.json"]],
  ["resume", "Resume a saved session", "write", "starts a new turn if prompted", "May call the model when resuming with a prompt.", "native_view", "Resume flow", "p01: POST /v1/sessions/{id}/resume-thread → 200", "verified", null, ["arn:p01-live.json"]],
  ["rc", "Launch an interactive session and hand it to the Codewhale web app", "write", "starts a runtime and browser session", "No inference until the user prompts.", "integrated_terminal", "Terminal launch", null, "unqualified", "Upstream browser handoff; Mona does not depend on it."],
  ["fork", "Fork a saved session", "write", "creates a new thread; no workspace rollback", "A fork itself makes no model call.", "native_view", "Session actions", "Documented POST /v1/threads/{id}/fork; P03 test", "unqualified", null],
  ["init", "Create a default AGENTS.md in the current directory", "write", "writes a workspace file", "No inference.", "advanced_action", "Workspace setup", null, "unqualified", null],
  ["install", "Install a plugin bundle without trusting or enabling it", "write", "writes plugin files; trust is separate", "No inference.", "advanced_action", "Extensions", null, "unqualified", "Trust review remains mandatory before enable."],
  ["setup", "Bootstrap MCP config and/or skills directories", "write", "writes config/skill directories", "No inference.", "advanced_action", "Extensions / setup", null, "unqualified", null],
  ["remote-setup", "Generate a remote Codewhale agent deploy bundle", "write", "produces a cloud/chat-bridge bundle", "External hosting may cost money.", "advanced_action", "Advanced actions", null, "unqualified", "Cloud hosting is outside 1.0 scope; no remote is invented."],
  ["exec", "Run a non-interactive prompt", "write", "tool-free by default; --auto grants Full Access", "One-shot model call; usage tokens recorded but no cost in agent mode.", "advanced_action", "Diagnostics and one-shot jobs only", "p01: paired baseline, --auto --json", "verified", "Explicitly separate from the persistent runtime; never a silent substitute.", ["arn:p01-economics.json"]],
  ["fleet", "Manage durable Agent fleet runs", "write", "spawns child agents with inherited posture", "Each child turn is billable.", "native_view", "Agent observatory", "Documented /v1/fleet/*; P18 contract test", "unqualified", null],
  ["workflow", "Run checked-in Workflows through a Lane Runtime backend", "write", "executes repository workflows", "Billable model turns.", "advanced_action", "Advanced actions", null, "unqualified", null],
  ["lane", "Manage running workflow instances (Lanes) and Runtime backends", "write", "process/backend control", "Billable model turns.", "advanced_action", "Advanced actions", null, "unqualified", null],
  ["review", "Run a Codewhale-powered code review over a git diff", "write", "reads the diff; may run tools", "Billable model call.", "native_view", "Review surface", null, "unqualified", null],
  ["apply", "Apply a patch file or stdin to the working tree", "destructive", "mutates workspace files", "No inference.", "advanced_action", "Advanced actions with effect preview", null, "unqualified", "Effect preview and explicit confirmation required."],
  ["eval", "Run the offline evaluation harness", "write", "writes eval artifacts", "May call the model depending on the suite.", "integrated_terminal", "Terminal launch", null, "unqualified", null],
  ["mcp", "Manage MCP servers", "write", "writes MCP config; server trust is separate", "Tool calls may reach external services.", "native_view", "Extensions / MCP", "Documented /v1/mcp/* (capabilities.mcp_server_management=true)", "unqualified", null],
  ["features", "Inspect feature flags", "read", "read-only", "No inference.", "native_view", "Capability explorer", "p01: codewhale features list", "verified", null, ["arn:p01-engine-surface.txt"]],
  ["integrations", "Connect third-party harnesses through Codewhale", "write", "writes integration config", "No inference.", "advanced_action", "Advanced actions", null, "unqualified", null],
  ["serve", "Run a local Codewhale server", "write", "binds loopback; bearer auth required", "No inference until a turn starts.", "native_view", "Owned runtime (Mona uses app-server --http)", "p01: app-server --http verified; serve is a documented alias", "unqualified", "Mona uses app-server --http; serve remains an alias."],
  ["web", "Open the first-class local browser client over the canonical Runtime API", "write", "starts a loopback runtime and browser session", "No inference until the user prompts.", "integrated_terminal", "External browser", null, "unqualified", "Upstream browser client overlaps Mona; assessed at G0, not a Mona surface."],
  ["login", "Sign in to an existing Codewhale account", "write", "writes account/session credentials", "No inference.", "advanced_action", "Account settings", null, "unqualified", "User-initiated only; never handle keys in the renderer."],
  ["logout", "Remove saved authentication state", "destructive", "deletes provider keys, OAuth login, and account session", "No inference.", "advanced_action", "Account settings", null, "unqualified", "Explicit confirmation required; destructive."],
  ["auth", "Manage authentication credentials and provider mode", "write", "credential store access", "No inference.", "advanced_action", "Account settings", null, "unqualified", "Use stdin/env; never expose secrets to the renderer or argv."],
  ["account", "Manage an existing Codewhale account", "write", "account session", "No inference.", "advanced_action", "Account settings", null, "unqualified", "New accounts are not open; local key routes remain primary."],
  ["dispatch", "Run a task on a Codewhale cloud computer", "write", "requires a cloud account and remote execution", "Cloud compute costs money.", "unavailable", "Unavailable on this build", null, "unavailable", "Cloud computers and accounts are paused for new users in this release."],
  ["mcp-server", "Run MCP server mode over stdio", "write", "exposes Codewhale tools to an MCP client", "Client-driven model calls.", "advanced_action", "Advanced actions", null, "unqualified", null],
  ["config", "Read/write/list config values", "write", "writes config; reads are redacted", "No inference.", "native_view", "Settings (read) / advanced action (write)", "p01: config dump/doctor redacted; GET /v1/providers", "verified", null, ["arn:p01-engine-surface.txt"]],
  ["model", "Resolve or list available models across providers", "write", "reads/changes the default model", "No inference.", "native_view", "Provider/model picker", "p01: model resolve deepseek-flash; P00 evidence", "verified", null, ["arn:p01-engine-surface.txt"]],
  ["thread", "Manage thread/session metadata and resume/fork flows", "write", "mutates thread metadata; resume/fork create threads", "No inference unless a resumed turn runs.", "native_view", "Session actions", "Documented /v1/threads/*; P03 contract test", "unqualified", null],
  ["sandbox", "Evaluate sandbox/approval policy decisions", "read", "read-only evaluation", "No inference.", "native_view", "Permission display", null, "unqualified", null],
  ["app-server", "Expose the full Engine API (--http) or compatibility controls", "write", "owns a loopback runtime and process tree", "No inference until a turn starts.", "native_view", "Owned runtime supervisor", "p01: /v1/* probe, G0 live task, ownership check", "verified", "npm wrapper spawns the native binary as a grandchild; the listener is a descendant, not the immediate child.", ["arn:p01-probe.json", "arn:p01-live.json"]],
  ["completion", "Generate shell completions", "read", "read-only", "No inference.", "integrated_terminal", "Terminal launch", null, "unqualified", null],
  ["metrics", "Print a usage rollup from the audit log and session store", "read", "reads local audit/session data", "No inference.", "native_view", "Cost lens", null, "unqualified", null],
  ["update", "Update the release binary from GitHub", "destructive", "replaces the engine binary", "No inference.", "advanced_action", "Explicit update flow", null, "unqualified", "Never silent; engine changes are explicit, tested compatibility decisions."],
  ["providers", "Export the route catalog", "read", "read-only catalog export", "No inference.", "native_view", "Provider route visibility", "p01: GET /v1/providers → 200", "verified", null, ["arn:p01-probe.json"]],
  ["help", "Print command help", "read", "read-only", "No inference.", "integrated_terminal", "Capability explorer", "p01: captured help surfaces", "verified", null, ["arn:p01-engine-surface.txt"]],
];
for (const [name, desc, classification, permission, cost, integration, ui, tests, status, gap, evidence] of cli) {
  row({ name, classification, permission, cost, integration, ui, tests, status, gap, evidence });
}

// --- Runtime/API and platform surfaces ---
const surfaces = [
  ["HTTP Runtime API /v1/*", "write", "bearer token over loopback; per-route effects", "No inference on reads; turns bill normally.", "GET/POST /v1/* with Authorization: Bearer", "native_view", "Engine adapter", "p01: 8 read endpoints, thread create 201", "verified", null, ["arn:p01-probe.json"]],
  ["Versioned adapter contract", "write", "adapter-mediated; strict validation at the boundary", "No extra inference; submission identity persisted before send.", "discover, thread, submit, reconcile, subscribe, interrupt, history, usage", "native_view", "Engine adapter", "p03: 70 tests + real pinned-runtime smoke (10 checks)", "verified", null, ["arn:p03-engine-smoke.json"]],
  ["SSE event journal /v1/threads/{id}/events", "read", "read-only replay + live stream", "No inference; never reexecutes tools.", "since_seq, replay_limit, progress", "native_view", "Conversation timeline", "p01: 52 events, replay from start, stream.end", "verified", null, ["arn:p01-live.json"]],
  ["Thread/turn lifecycle", "write", "creates durable thread/turn records", "A turn bills once.", "POST /v1/threads, POST /v1/threads/{id}/turns", "native_view", "Work studio", "p01: create + submit + completed + history", "verified", null, ["arn:p01-live.json"]],
  ["Turn interrupt", "write", "stops the owned turn only", "An in-flight request may still complete upstream.", "POST /v1/threads/{id}/turns/{turn_id}/interrupt", "native_view", "Stop control", "p01: receipt 200, final status interrupted, no stray sleep", "verified", null, ["arn:p01-live.json"]],
  ["Resume from saved session", "write", "seeds/returns an open thread from a session", "No inference by itself.", "POST /v1/sessions/{id}/resume-thread", "native_view", "Resume flow", "p01: 200 with thread_id + message_count", "verified", null, ["arn:p01-live.json"]],
  ["Usage aggregation and cost", "read", "read-only aggregation across threads", "Cost is engine-computed; provider billing remains authoritative.", "GET /v1/usage?since&until&group_by", "native_view", "Cost lens", "p01: per-thread buckets with cost_complete=true", "verified", null, ["arn:p01-economics.json"]],
  ["Turn history and receipts", "read", "read-only transcript/receipt", "No inference.", "GET /v1/threads/{id}, /receipt", "native_view", "Conversation and evidence panels", "p01: history turn_count=1, receipts json", "verified", null, ["arn:p01-live.json"]],
  ["Approvals bridge", "write", "resolves tool approvals", "No inference.", "POST /v1/approvals/{id}", "native_view", "Approval cards", "P03 contract test pending", "unqualified", "Not exercised; G0 used auto_approve on a dedicated thread."],
  ["Permission posture (Full Access)", "write", "trust_mode + auto_approve + shell", "Widens tool authority; never silent.", "thread fields auto_approve/trust_mode/allow_shell", "native_view", "Permission badge", "p01: TurnRecord.permission_posture=full_access", "verified", null, ["arn:p01-live.json"]],
  ["Tools: shell and file write", "write", "mutates workspace under the posture", "Tool turns bill normally.", "model-visible tool catalog", "native_view", "Tool cards / changes", "p01: file_change + 2 bash tool calls completed", "verified", null, ["arn:p01-live.json"]],
  ["Tool: apply_patch", "write", "mutates workspace files", "Tool turns bill normally.", "model-visible tool catalog", "native_view", "Changes", "P03 fixture test pending", "unqualified", null],
  ["Web search", "read", "network egress through the provider", "May add provider-side search charges.", "model-visible tool catalog", "native_view", "Tool cards", "Not exercised", "unqualified", "Provider-native search semantics differ by route; no claim made."],
  ["Subagents", "write", "spawns child turns with inherited posture", "Each child turn bills; parent and child totals must not double-count.", "feature subagents", "native_view", "Agent observatory", "Not exercised", "unqualified", null],
  ["MCP server management", "write", "server trust and tool exposure", "External service costs possible.", "feature mcp; /v1/mcp/*", "native_view", "Extensions", "Not exercised", "unqualified", null],
  ["Skills and plugins", "write", "installs and trusts local bundles", "No inference by itself.", "feature flags; /v1/skills, /v1/plugins", "native_view", "Extensions", "Not exercised", "unqualified", "Install never implies trust."],
  ["Fleet and workflows", "write", "durable child-agent scheduling", "Billable child turns.", "/v1/fleet/*, /v1/goals", "native_view", "Agent observatory", "Not exercised", "unqualified", "Mona must not run a competing scheduler."],
  ["Terminal stream/input", "write", "interactive shell in the workspace", "No inference.", "/v1/terminal/* (capabilities.terminal_stream=true)", "integrated_terminal", "Integrated terminal", "Not exercised", "unqualified", null],
  ["Workspace files, search, artifacts", "read", "reads only the configured workspace", "No inference.", "GET /v1/workspace/files/search, /v1/threads/{id}/turns/{turn_id}/artifacts", "native_view", "File references / artifacts", "Documented; not exercised", "unqualified", null],
  ["Workspace snapshots/restore", "destructive", "writes workspace files from side-git", "No inference.", "GET /v1/snapshots, POST restore", "native_view", "Restore controls with confirmation", "Not exercised", "unqualified", null],
  ["Provider/model catalog and route visibility", "read", "read-only; key writes are separate", "No inference.", "GET /v1/providers, /v1/providers/{id}/models", "native_view", "Provider/model picker", "p01: 200 for both routes; effective model observed", "verified", null, ["arn:p01-probe.json"]],
  ["Session persistence", "write", "durable local session store", "No inference.", "GET/POST /v1/sessions", "native_view", "Sessions", "p01: export 201, resume 200", "verified", null, ["arn:p01-live.json"]],
  ["Operation idempotency (operation_key)", "write", "durable operation fingerprint; exact replay returns the original", "Prevents duplicate billing on response loss.", "operation_key on thread/turn create", "native_view", "Submission reconciliation", "p03: lost-response simulation + real operation lookup", "verified", null, ["arn:p03-engine-smoke.json"]],
  ["Zero-inference non-turn actions", "read", "read-only", "Proven zero inference for discovery, idle, history, reconnect.", "all read routes; client idle", "native_view", "Whole shell", "p01: usage totals unchanged across all non-turn actions", "verified", null, ["arn:p01-probe.json"]],
  ["Packaged native execution (no Node in PATH)", "write", "launches the native arm64 binary directly", "No inference until a turn starts.", "native binary app-server --http", "native_view", "Packaging (P21)", "p01: env -i PATH=/usr/bin:/bin launch + health + info", "verified", "Engine links only system frameworks; no Node required to start.", ["arn:p01-native-binary.txt"]],
  ["Finder selected-folder Service (NSServices)", "read", "receives file URLs from Finder; no network by itself", "No inference.", "NSServices Info.plist + AppKit pasteboard read", "native_view", "Finder Service / folder open", "p01: CLT compile, plist lint, ad-hoc sign, LaunchServices registration", "verified", "Full app-bundle registration and Finder menu behavior remain P02/P21 work.", ["arn:p01-finder-service.txt"]],
  ["Single Runtime owner per user store", "write", "second app-server attaches to the first owner", "No extra inference.", "one app-server --http at a time", "native_view", "Process supervisor", "p01: second listener owned by first PID; first token authenticated second port", "verified", "Multiple independent owned runtimes are NOT supported; serialize project execution."],
  ["Engine update path", "destructive", "replaces the engine binary", "No inference.", "codewhale update", "advanced_action", "Explicit update flow", "Not exercised", "unqualified", "Do not silently upgrade; compatibility decision required."],
  ["macOS minimum and signature state", "read", "ad-hoc signed, no TeamIdentifier", "No inference.", "codesign inspection", "advanced_action", "Release pipeline (P21/P22)", "p01: VersionMin=11.0, adhoc linker-signed", "verified", "Notarized distribution requires Developer ID identities, which are absent (P22 prerequisite)."],
];
for (const [name, classification, permission, cost, args, integration, ui, tests, status, gap, evidence] of surfaces) {
  row({ name, classification, permission, cost, args, integration, ui, tests, status, gap, evidence });
}

const counts = {
  rows_total: rows.length,
  verified: rows.filter((r) => r.status === "verified").length,
  unqualified: rows.filter((r) => r.status === "unqualified").length,
  unavailable: rows.filter((r) => r.status === "unavailable").length,
  blocked_gaps: rows.filter((r) => r.status === "blocked_gap").length,
  assessed_utc: new Date().toISOString(),
  by_integration: rows.reduce((acc, r) => {
    acc[r.integration] = (acc[r.integration] ?? 0) + 1;
    return acc;
  }, {}),
  summary:
    "Every discovered command and documented runtime surface has a route. Verified rows were exercised against the pinned binary; unqualified rows are discovered with a proposed route and remain open until their named contract test passes. No row claims blanket terminal access.",
};

const doc = {
  schema_version: 2,
  status: "qualified",
  note:
    "Generated by tools/p01-spike/build-inventory.mjs from the pinned Codewhale 0.10.2 surface. " +
    "EC-1 Unsupported rows stay visible rather than hidden. Evidence paths use the arn: shorthand for docs/evidence/macos/artifacts/.",
  engine: {
    name: "Codewhale",
    version: VERSION,
    commit: COMMIT,
    install: "npm global under /opt/homebrew (wrapper) + native binary bin/downloads/codewhale",
    native_binary: {
      arch: "arm64",
      format: "Mach-O thin",
      bytes: 90300464,
      sha256: "da0229610647f1cc2dd14c4227b333a92ea276a49f5d4d79160fa19e515e590d",
      signature: "adhoc linker-signed; no TeamIdentifier",
      minimum_macos: "11.0 (VersionMin=720896)",
      linked_libraries: "system frameworks only (Vision, AppKit, CoreGraphics, Foundation, CoreFoundation, Security, libobjc, libiconv, libSystem)",
    },
    license: "MIT",
    source_reference: "https://github.com/codewhale-hq/Codewhale (tag v0.10.2 = ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e)",
  },
  transports_observed: [
    { name: "app-server --http", kind: "HTTP/SSE runtime API", default_port: 7878, auth: "bearer token via CODEWHALE_RUNTIME_TOKEN", status: "verified-primary" },
    { name: "app-server --stdio", kind: "JSON-RPC compatibility control", status: "documented-tool-free-only" },
    { name: "app-server --socket", kind: "JSON-RPC over private local socket (daemon/attach)", status: "documented-not-qualified" },
    { name: "serve --http / --web / --mobile", kind: "server aliases and browser clients", status: "documented-alias" },
    { name: "exec", kind: "one-shot non-interactive run", status: "verified-diagnostics-only" },
  ],
  capability_row_contract: {
    fields: ["mona_id", "upstream_name", "upstream_source", "upstream_version", "platform", "classification", "permission_implications", "cost_implications", "required_arguments", "integration", "ui_location", "tests", "status", "gap"],
    classification_enum: ["read", "write", "destructive"],
    integration_enum: ["native_view", "advanced_action", "integrated_terminal", "unavailable", "blocked_gap"],
    status_enum: ["unqualified", "verified", "unavailable", "blocked_gap"],
  },
  capabilities: rows,
  coverage: counts,
};

await writeFile(OUT, JSON.stringify(doc, null, 2) + "\n");
console.log(JSON.stringify({ out: OUT, ...counts, by_integration: counts.by_integration }, null, 1));
