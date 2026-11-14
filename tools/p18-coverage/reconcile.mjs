#!/usr/bin/env node
// P18 capability reconciliation.
//
// The P01 generator discovered the pinned engine's surface and proposed a route
// for every row. This step records what Mona can actually reach in P18: the
// entry point, whether that entry point was exercised, and — where it was not —
// the exact verified advance or terminal route. Nothing here upgrades a status
// to `verified` without a named test; the coverage report is computed from the
// rows, so a hidden or awkward feature still counts.
//
//   node tools/p18-coverage/reconcile.mjs            # check (no write)
//   node tools/p18-coverage/reconcile.mjs --write    # apply the overlay
//   node tools/p18-coverage/reconcile.mjs --json     # machine-readable report

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const INVENTORY = resolve(ROOT, "docs/codewhale-capabilities-macos.json");
const HELP = resolve(ROOT, "docs/evidence/macos/artifacts/codewhale-help.txt");

const TERM = { kind: "terminal", target: "shell", label: "Terminal · shell" };
const term = (tested = false) => ({ ...TERM, tested });
const screen = (target, label, tested = true) => ({ kind: "screen", target, label, tested });
const tab = (target, label, tested = true) => ({
  kind: "settings_tab",
  target,
  label: `Settings › ${label}`,
  tested,
});
const none = (label) => ({ kind: "none", target: null, label, tested: false });

// The row's own verification text is the only place a status is justified.
const P18 = {
  // --- CLI commands ---------------------------------------------------------
  "MONA-CAP-001": {
    scope: "cli",
    invocation: "codewhale run",
    help_source: "codewhale run --help",
    integration: "integrated_terminal",
    entry: term(true),
    status: "unqualified",
    tests:
      "P18: the terminal smoke launches a real shell in the workspace and runs `codewhale --version`. The interactive TUI itself is not exercised to avoid an unrequested paid session.",
    gap: "The TUI runs in the integrated terminal; Mona's own turns use /v1. Opening the TUI is a deliberate user command, not an automatic fallback.",
  },
  "MONA-CAP-002": {
    scope: "cli",
    invocation: "codewhale doctor --json",
    help_source: "codewhale doctor --help",
    integration: "native_view",
    entry: tab("route", "Providers & route"),
    status: "verified",
    tests:
      "P16: Connection diagnostics runs the engine's doctor in structural mode and redacts paths and secrets.",
    gap: null,
  },
  "MONA-CAP-003": {
    scope: "cli",
    invocation: "codewhale session-diagnostics <jsonl>",
    help_source: "codewhale session-diagnostics --help",
    integration: "integrated_terminal",
    entry: term(false),
    status: "unqualified",
    tests:
      "Not exercised: the command needs a session log path and would read personal session data.",
    gap: "Route is `codewhale sessions` then `codewhale session-diagnostics <jsonl>`. Neither Mona nor its smoke runs it, so no success is claimed.",
  },
  "MONA-CAP-004": {
    scope: "cli",
    invocation: "codewhale scorecard --input <file>",
    help_source: "codewhale scorecard --help",
    integration: "integrated_terminal",
    entry: term(false),
    status: "unqualified",
    tests:
      "P18: `smoke:capability` ran the bare command and it refused with exit 2 (`--input <FILE>` is required), so no success is claimed.",
    gap: "Needs a metrics file to score. No native scorecard panel, and no sample input is invented; the cost lens shows recorded usage, not this quality score.",
  },
  "MONA-CAP-005": {
    scope: "cli",
    invocation: "codewhale models --provider <id> --json",
    help_source: "codewhale models --help",
    integration: "native_view",
    entry: tab("route", "Providers & route"),
    status: "verified",
    tests: "P16: live provider/model catalog and refresh.",
    gap: null,
  },
  "MONA-CAP-006": {
    scope: "cli",
    invocation: "codewhale speech",
    help_source: "codewhale speech --help",
    integration: "advanced_action",
    entry: term(false),
    status: "unqualified",
    tests: "Not exercised: a paid TTS route is not configured for this build.",
    gap: "Paid TTS is outside 1.0 scope. The command is reachable in the terminal; Mona never calls it and never claims a configured route.",
  },
  "MONA-CAP-007": {
    scope: "cli",
    invocation: "codewhale sessions",
    help_source: "codewhale sessions --help",
    integration: "native_view",
    entry: screen("studio", "Studio · session"),
    status: "verified",
    tests: "P08: session listing, resume, and history through the Runtime adapter.",
    gap: null,
  },
  "MONA-CAP-008": {
    scope: "cli",
    invocation: "codewhale receipts [ID|--last] [--format json]",
    help_source: "codewhale receipts --help",
    integration: "native_view",
    entry: screen("changes", "Changes · receipts"),
    status: "verified",
    tests: "P13: change sets, files, artifacts, and attribution from engine receipts.",
    gap: null,
  },
  "MONA-CAP-009": {
    scope: "cli",
    invocation: "codewhale resume <id>",
    help_source: "codewhale resume --help",
    integration: "native_view",
    entry: screen("studio", "Studio · resume"),
    status: "verified",
    tests: "P08: explicit resume of a recorded session through /v1.",
    gap: null,
  },
  "MONA-CAP-010": {
    scope: "cli",
    invocation: "codewhale rc",
    help_source: "codewhale rc --help",
    integration: "integrated_terminal",
    entry: term(false),
    status: "unqualified",
    tests: "Not exercised: requires an interactive browser handoff.",
    gap: "Upstream browser handoff; Mona does not depend on it. Reachable only as an explicit terminal command.",
  },
  "MONA-CAP-011": {
    scope: "cli",
    invocation: "codewhale fork <id>",
    help_source: "codewhale fork --help",
    integration: "integrated_terminal",
    entry: term(false),
    status: "unqualified",
    tests: "Documented POST /v1/threads/{id}/fork; no native control or P18 exercise.",
    gap: "Thread forking has no native control. The terminal entry runs the CLI command, and a fork creates a new thread without workspace rollback.",
  },
  "MONA-CAP-012": {
    scope: "cli",
    invocation: "codewhale init",
    help_source: "codewhale init --help",
    integration: "advanced_action",
    entry: term(false),
    status: "unqualified",
    tests: "Not exercised: writes AGENTS.md into the working tree.",
    gap: "Writes a workspace file. The capability row prefills the exact command and never runs it automatically.",
  },
  "MONA-CAP-013": {
    scope: "cli",
    invocation: "codewhale install <bundle>",
    help_source: "codewhale install --help",
    integration: "native_view",
    entry: tab("extensions", "Extensions"),
    status: "verified",
    tests: "P17: plugin bundle install from a local fixture, installed disabled and untrusted.",
    gap: "Trust review stays with the engine (`/plugins trust`); install never implies trust.",
  },
  "MONA-CAP-014": {
    scope: "cli",
    invocation: "codewhale setup",
    help_source: "codewhale setup --help",
    integration: "advanced_action",
    entry: term(false),
    status: "unqualified",
    tests: "Not exercised: bootstraps MCP config and skills directories.",
    gap: "Writes configuration. Mona adds MCP servers through the engine's own route instead; `setup` is terminal-only.",
  },
  "MONA-CAP-015": {
    scope: "cli",
    invocation: "codewhale remote-setup",
    help_source: "codewhale remote-setup --help",
    integration: "advanced_action",
    entry: term(false),
    status: "unavailable",
    tests: "Not exercised: produces a cloud/chat-bridge deploy bundle.",
    gap: "Cloud hosting is outside 1.0 scope. No remote is invented and no bundle is generated automatically.",
  },
  "MONA-CAP-016": {
    scope: "cli",
    invocation: "codewhale exec --prompt <text> --json",
    help_source: "codewhale exec --help",
    integration: "native_view",
    entry: screen("studio", "Studio · turn"),
    status: "verified",
    tests: "P01/P03: paired baseline and one-shot exec; the normal path is the Runtime adapter.",
    gap: "One-shot exec is a diagnostic path, never a silent substitute for the persistent runtime.",
  },
  "MONA-CAP-017": {
    scope: "cli",
    invocation: "codewhale fleet <subcommand>",
    help_source: "codewhale fleet --help",
    integration: "native_view",
    entry: screen("agents", "Agents · fleets"),
    status: "verified",
    tests: "P15: managed fleet runs, worker controls, receipts, replay, and a real serial run.",
    gap: "Only `this_computer` targets; parallel launch refused.",
  },
  "MONA-CAP-018": {
    scope: "cli",
    invocation: "codewhale workflow <name>",
    help_source: "codewhale workflow --help",
    integration: "blocked_gap",
    entry: none("No in-app route"),
    status: "blocked_gap",
    tests: "Probed: no /v1/workflow* route exists on the pinned build (P15).",
    gap: "Checked-in JS workflows run through a Lane Runtime with no HTTP route, so Mona cannot launch or inspect them. A terminal entry would not fulfill MONA-019; full parity stays blocked until the engine exposes a route or Victor narrows scope.",
    evidence: ["docs/evidence/macos/P15-agents.md"],
  },
  "MONA-CAP-019": {
    scope: "cli",
    invocation: "codewhale lane <subcommand>",
    help_source: "codewhale lane --help",
    integration: "blocked_gap",
    entry: none("No in-app route"),
    status: "blocked_gap",
    tests: "Probed: no /v1/lane* route exists on the pinned build (P15).",
    gap: "Lane management is terminal-only on this build. Mona shows no lane control and does not simulate one.",
    evidence: ["docs/evidence/macos/P15-agents.md"],
  },
  "MONA-CAP-020": {
    scope: "cli",
    invocation: "codewhale review",
    help_source: "codewhale review --help",
    integration: "advanced_action",
    entry: term(false),
    status: "unqualified",
    tests:
      "P13: the Changes lens reviews engine-recorded diffs with no inference. The billable `review` command is not exercised.",
    gap: "The billable model review is terminal-only; Mona's source review reads recorded turn artifacts and Git state instead, so no hidden model call happens.",
  },
  "MONA-CAP-021": {
    scope: "cli",
    invocation: "codewhale apply <patch>",
    help_source: "codewhale apply --help",
    integration: "advanced_action",
    entry: term(false),
    status: "unqualified",
    tests: "Not exercised: mutates the working tree.",
    gap: "Destructive and terminal-only. Mona's restore path is the engine's checked one-file file-revert (P13); no patch apply control is offered.",
  },
  "MONA-CAP-022": {
    scope: "cli",
    invocation: "codewhale eval",
    help_source: "codewhale eval --help",
    integration: "integrated_terminal",
    entry: term(false),
    status: "unqualified",
    tests: "Not exercised: writes eval artifacts and may call the model.",
    gap: "Terminal-only. Cost depends on the suite, so the row states that before invocation.",
  },
  "MONA-CAP-023": {
    scope: "cli",
    invocation: "codewhale mcp <subcommand>",
    help_source: "codewhale mcp --help",
    integration: "native_view",
    entry: tab("extensions", "Extensions"),
    status: "verified",
    tests: "P17: /v1/mcp/* list, add, enable/disable, reconnect, remove with If-Match revisions.",
    gap: "Project-scope MCP entries are read-only through the runtime.",
  },
  "MONA-CAP-024": {
    scope: "cli",
    invocation: "codewhale features list",
    help_source: "codewhale features --help",
    integration: "native_view",
    entry: screen("capabilities", "Capabilities · feature flags"),
    status: "verified",
    tests:
      "P18: `features list` is probed read-only and the flags render on the Capabilities screen.",
    gap: null,
  },
  "MONA-CAP-025": {
    scope: "cli",
    invocation: "codewhale integrations",
    help_source: "codewhale integrations --help",
    integration: "advanced_action",
    entry: term(false),
    status: "unqualified",
    tests: "Not exercised: writes integration config.",
    gap: "Third-party harness integration is terminal-only; Mona makes no claim about a configured harness.",
  },
  "MONA-CAP-026": {
    scope: "cli",
    invocation: "codewhale serve --http",
    help_source: "codewhale serve --help",
    integration: "native_view",
    entry: tab("runtime", "Runtime"),
    status: "verified",
    tests:
      "P01/P04: app-server --http under the native supervisor; `serve` is the documented alias.",
    gap: "Mona runs `codewhale app-server --http`, never `serve`; the alias is not offered as a second runtime.",
  },
  "MONA-CAP-027": {
    scope: "cli",
    invocation: "codewhale web",
    help_source: "codewhale web --help",
    integration: "integrated_terminal",
    entry: term(false),
    status: "unqualified",
    tests: "Not exercised: starts a loopback runtime and opens a browser client.",
    gap: "The upstream browser client overlaps Mona. Reachable only as an explicit terminal command; Mona never opens it automatically.",
  },
  "MONA-CAP-028": {
    scope: "cli",
    invocation: "codewhale login",
    help_source: "codewhale login --help",
    integration: "advanced_action",
    entry: term(false),
    status: "unqualified",
    tests: "Not exercised: writes account/session credentials.",
    gap: "Credentials never cross the renderer. Provider keys use the dedicated P16 route; account login is terminal-only and user-initiated.",
  },
  "MONA-CAP-029": {
    scope: "cli",
    invocation: "codewhale logout",
    help_source: "codewhale logout --help",
    integration: "advanced_action",
    entry: term(false),
    status: "unqualified",
    tests: "Not exercised: deletes provider keys, OAuth login, and the account session.",
    gap: "Destructive and terminal-only, with the engine's own confirmation. Mona does not offer a one-click credential wipe.",
  },
  "MONA-CAP-030": {
    scope: "cli",
    invocation: "codewhale auth",
    help_source: "codewhale auth --help",
    integration: "advanced_action",
    entry: term(false),
    status: "unqualified",
    tests: "Not exercised: credential store access.",
    gap: "Provider keys are set through the engine's own route (P16); other auth modes are terminal-only.",
  },
  "MONA-CAP-031": {
    scope: "cli",
    invocation: "codewhale account",
    help_source: "codewhale account --help",
    integration: "advanced_action",
    entry: term(false),
    status: "unqualified",
    tests: "Not exercised: new accounts are not open.",
    gap: "Local key routes remain primary; account status is terminal-only.",
  },
  "MONA-CAP-032": {
    scope: "cli",
    invocation: "codewhale dispatch",
    help_source: "codewhale dispatch --help",
    integration: "unavailable",
    entry: none("Unavailable on this build"),
    status: "unavailable",
    tests: "The pinned binary reports cloud computers and accounts as paused for new users.",
    gap: "Cloud computers are unavailable. No control is shown and no remote is invented.",
  },
  "MONA-CAP-033": {
    scope: "cli",
    invocation: "codewhale mcp-server",
    help_source: "codewhale mcp-server --help",
    integration: "advanced_action",
    entry: term(false),
    status: "unqualified",
    tests: "Not exercised: exposes Codewhale tools to an external MCP client.",
    gap: "Terminal-only. Mona is an MCP host, not a server; the row states the reverse direction.",
  },
  "MONA-CAP-034": {
    scope: "cli",
    invocation: "codewhale config dump | doctor",
    help_source: "codewhale config --help",
    integration: "native_view",
    entry: tab("route", "Providers & route"),
    status: "verified",
    tests: "P16: redacted config dump/doctor, engine switch with a backup and stale-read refusal.",
    gap: "Only engine-mediated edits; unknown TOML tables are preserved by the engine's writer.",
  },
  "MONA-CAP-035": {
    scope: "cli",
    invocation: "codewhale model resolve <name>",
    help_source: "codewhale model --help",
    integration: "native_view",
    entry: tab("route", "Providers & route"),
    status: "verified",
    tests: "P16: requested vs effective route and model-published reasoning levels.",
    gap: null,
  },
  "MONA-CAP-036": {
    scope: "cli",
    invocation: "codewhale thread <subcommand>",
    help_source: "codewhale thread --help",
    integration: "native_view",
    entry: screen("studio", "Studio · thread"),
    status: "unqualified",
    tests:
      "P08/P13: resume, history, interrupt, and receipts. Thread metadata editing and fork are not surfaced.",
    gap: "Resume and fork flows are terminal-only beyond the studio's recorded resume.",
  },
  "MONA-CAP-037": {
    scope: "cli",
    invocation: "codewhale sandbox <decision>",
    help_source: "codewhale sandbox --help",
    integration: "integrated_terminal",
    entry: term(false),
    status: "unqualified",
    tests: "Not exercised: evaluates a policy decision read-only.",
    gap: "The effective permission posture is shown from the turn receipt (P08), not recomputed here; `sandbox` is terminal-only.",
  },
  "MONA-CAP-038": {
    scope: "cli",
    invocation: "codewhale app-server --http",
    help_source: "codewhale app-server --help",
    integration: "native_view",
    entry: tab("runtime", "Runtime"),
    status: "verified",
    tests:
      "P01/P04/P08: authenticated loopback runtime under the native supervisor with verified ownership.",
    gap: null,
  },
  "MONA-CAP-039": {
    scope: "cli",
    invocation: "codewhale completion zsh",
    help_source: "codewhale completion --help",
    integration: "integrated_terminal",
    entry: term(true),
    status: "verified",
    tests:
      "P18: `smoke:capability` runs `codewhale completion zsh` read-only and records its exit status and output size.",
    gap: "Shell completions are not installed by Mona; the terminal can print them.",
  },
  "MONA-CAP-040": {
    scope: "cli",
    invocation: "codewhale metrics",
    help_source: "codewhale metrics --help",
    integration: "integrated_terminal",
    entry: term(true),
    status: "verified",
    tests:
      "P18: `smoke:capability` runs `codewhale metrics` read-only and records its exit status and output shape. Mona's own lens reads /v1/usage instead.",
    gap: "Two usage sources can disagree; Mona's cost lens uses the engine's /v1/usage ledger.",
  },
  "MONA-CAP-041": {
    scope: "cli",
    invocation: "codewhale update",
    help_source: "codewhale update --help",
    integration: "advanced_action",
    entry: term(false),
    status: "unqualified",
    tests: "Not exercised: replaces the engine binary.",
    gap: "Mona never silently upgrades the engine. An engine change is an explicit, separately tested compatibility decision and stays terminal-only here.",
  },
  "MONA-CAP-042": {
    scope: "cli",
    invocation: "codewhale providers export --json",
    help_source: "codewhale providers --help",
    integration: "native_view",
    entry: tab("route", "Providers & route"),
    status: "verified",
    tests: "P01/P16: route catalog export and live provider catalog.",
    gap: null,
  },
  "MONA-CAP-043": {
    scope: "cli",
    invocation: "codewhale help [COMMAND]",
    help_source: "codewhale help",
    integration: "integrated_terminal",
    entry: term(true),
    status: "verified",
    tests:
      "P18: `smoke:capability` runs `codewhale help` read-only and parses the command set; the Capabilities screen carries each row's help source.",
    gap: null,
  },

  // --- Runtime API and product surfaces --------------------------------------
  "MONA-CAP-044": {
    scope: "runtime_api",
    invocation: "app-server --http; typed adapter over /v1/*",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: tab("runtime", "Runtime"),
    status: "verified",
    tests: "P03: versioned adapter contract, wire validation, submission safety.",
    gap: null,
  },
  "MONA-CAP-045": {
    scope: "runtime_api",
    invocation: "src/main/engine/adapter.ts",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: tab("runtime", "Runtime"),
    status: "verified",
    tests: "P03: adapter contract tests; version/commit pin refuses anything else.",
    gap: "A new engine version is an explicit re-qualification, not a setting.",
  },
  "MONA-CAP-046": {
    scope: "runtime_api",
    invocation: "GET /v1/threads/{id}/events (SSE)",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("studio", "Studio · timeline"),
    status: "verified",
    tests:
      "P08: durable event insert with replay dedupe; transport frames are not treated as events.",
    gap: null,
  },
  "MONA-CAP-047": {
    scope: "runtime_api",
    invocation: "POST /v1/threads, /v1/threads/{id}/turns",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("studio", "Studio · composer"),
    status: "verified",
    tests: "P08: submit, interrupt, resume, receipts.",
    gap: null,
  },
  "MONA-CAP-048": {
    scope: "runtime_api",
    invocation: "POST /v1/threads/{id}/interrupt",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("studio", "Studio · control strip"),
    status: "verified",
    tests: "P08/P11: interrupt receipt, uncertain outcome stays visible.",
    gap: null,
  },
  "MONA-CAP-049": {
    scope: "runtime_api",
    invocation: "POST /v1/sessions/{id}/resume-thread",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("studio", "Studio · resume"),
    status: "verified",
    tests: "P01/P08: resume into a live thread with the recorded posture.",
    gap: null,
  },
  "MONA-CAP-050": {
    scope: "runtime_api",
    invocation: "GET /v1/usage",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("cost", "Cost lens"),
    status: "verified",
    tests:
      "P12: cumulative thread total converted to exact per-turn deltas; unknown never becomes zero.",
    gap: null,
  },
  "MONA-CAP-051": {
    scope: "runtime_api",
    invocation: "GET /v1/threads/{id}/receipts",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("changes", "Changes · receipts"),
    status: "verified",
    tests: "P13: receipts with evidence ranks, artifacts, and attribution.",
    gap: null,
  },
  "MONA-CAP-052": {
    scope: "runtime_api",
    invocation: "POST /v1/approvals/{id}",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("studio", "Studio · approval and question cards"),
    status: "unqualified",
    tests:
      "P08 surfaced a wait as text. R07 adds a typed reply path: scripts/pending-smoke.mjs proves both routes exist and reject an unknown capability (404) against the pinned 0.10.2 engine with 0 model requests; test/studio-pending.test.ts covers the durable row, the acknowledged 2xx, the expired 404, duplicate answers and restart. No live approval prompt has been round-tripped (that needs inference).",
    gap: "Verified: pending rows persist with the Runtime capability, both reply routes are wired (POST /v1/approvals/{id}, POST /v1/user-input/{thread}/{request}), and the engine's own thread-detail lists settle or expire them. Not verified: a live approval decision end to end, remembered grants (passed through, not listed), and clarifications on the tool-free compatibility transport.",
  },
  "MONA-CAP-053": {
    scope: "runtime_api",
    invocation: "thread posture at creation; /v1/config",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("settings", "Settings · Providers & route"),
    status: "verified",
    tests: "P08/P16: posture bound at thread creation; requested vs effective shown.",
    gap: null,
  },
  "MONA-CAP-054": {
    scope: "runtime_api",
    invocation: "model-visible tool catalog",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("changes", "Changes · tool attribution"),
    status: "verified",
    tests: "P08/P13: tool calls and their files are displayed and attributed.",
    gap: null,
  },
  "MONA-CAP-055": {
    scope: "runtime_api",
    invocation: "model-visible tool catalog",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("changes", "Changes · tool attribution"),
    status: "unqualified",
    tests: "Not exercised as a distinct tool; P13 attributes any tool-written file.",
    gap: "apply_patch is displayed as a tool-attributed change when the agent uses it. Mona offers no direct patch control.",
  },
  "MONA-CAP-056": {
    scope: "runtime_api",
    invocation: "provider-native web search tool",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("studio", "Studio · tool cards"),
    status: "unqualified",
    tests: "Not exercised: search semantics differ per provider.",
    gap: "Web search is provider-native and may add provider charges. Mona makes no claim that a route has it enabled.",
  },
  "MONA-CAP-057": {
    scope: "runtime_api",
    invocation: "POST /v1/agent-runs, GET /v1/agent-runs",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("agents", "Agents · sub-agents"),
    status: "verified",
    tests: "P15: sub-agent ledger, deduplicated identities, unknown spend preserved.",
    gap: null,
  },
  "MONA-CAP-058": {
    scope: "runtime_api",
    invocation: "GET/POST /v1/mcp/*",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: tab("extensions", "Extensions"),
    status: "verified",
    tests: "P17: 39-check live smoke with a local MCP fixture.",
    gap: null,
  },
  "MONA-CAP-059": {
    scope: "runtime_api",
    invocation: "GET/POST /v1/skills, /v1/plugins",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: tab("extensions", "Extensions"),
    status: "verified",
    tests: "P17: skill toggle and plugin install/remove.",
    gap: "Plugin trust stays with the engine; install never implies trust.",
  },
  "MONA-CAP-060": {
    scope: "runtime_api",
    invocation: "POST /v1/fleet/runs, /v1/fleet/runs/{id}/start",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("agents", "Agents · fleets"),
    status: "verified",
    tests: "P15: one real serial fleet run with a partial receipt.",
    gap: "Parallel launch refused; only this_computer targets.",
  },
  "MONA-CAP-061": {
    scope: "runtime_api",
    invocation: "GET /v1/terminal/{name}/output; POST input|resize|kill",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: term(true),
    status: "unqualified",
    tests:
      "P18: Mona's pane is a native PTY (mona-pty) with resize, exit, and reconnect tests. The engine's attach-only routes are not exercised.",
    gap: "Engine terminal sessions can only be attached, never created (404 otherwise), so a client cannot open its own shell through them. Mona owns its PTY instead; an attach view for engine-owned shells is not built.",
  },
  "MONA-CAP-062": {
    scope: "runtime_api",
    invocation: "GET /v1/workspace/files/search; GET .../artifacts",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("changes", "Changes · artifacts"),
    status: "unqualified",
    tests: "P13: artifact windows and file references. Workspace file search is not surfaced.",
    gap: "Project text search is P19. Mona never copies repository contents into its database to fake it.",
  },
  "MONA-CAP-063": {
    scope: "runtime_api",
    invocation: "GET /v1/snapshots; POST /v1/threads/{id}/file-revert",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("changes", "Changes · restore"),
    status: "unqualified",
    tests: "P13: snapshot listing and one-file file-revert, with stale-preview refusal.",
    gap: "Whole-workspace restore (POST /v1/snapshots/{id}/restore) and forking patch-undo are not surfaced. A workspace-wide overwrite stays a separate, explicitly authorized action.",
  },
  "MONA-CAP-064": {
    scope: "runtime_api",
    invocation: "GET /v1/providers, /v1/providers/{id}/models",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: tab("route", "Providers & route"),
    status: "verified",
    tests: "P16: live catalogs, requested vs effective, reasoning levels.",
    gap: null,
  },
  "MONA-CAP-065": {
    scope: "runtime_api",
    invocation: "GET /v1/sessions, /v1/threads/{id}",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("studio", "Studio · resume"),
    status: "verified",
    tests: "P01/P08: session persistence and explicit resume.",
    gap: null,
  },
  "MONA-CAP-066": {
    scope: "runtime_api",
    invocation: "operation_key on submissions",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("studio", "Studio · submit"),
    status: "verified",
    tests:
      "P03/P08: intent persisted before the POST; a lost response is reconciled read-only, never resent.",
    gap: null,
  },
  "MONA-CAP-067": {
    scope: "product",
    invocation: "Mona local projections",
    help_source: "docs/decisions/ADR-007-usage-semantics-and-rates.md",
    entry: screen("home", "Home · Resume Brief"),
    status: "verified",
    tests: "P14: digest, attention, and notifications make zero inference calls.",
    gap: null,
  },
  "MONA-CAP-068": {
    scope: "product",
    invocation: "native arm64 runtime under mona-supervisor",
    help_source: "docs/decisions/ADR-003-runtime-supervisor.md",
    entry: tab("runtime", "Runtime"),
    status: "verified",
    tests: "P01/P04: native binary starts with no Node on PATH; no runtime compilation.",
    gap: "Packaging ships the supervisor and pty helpers (P21).",
  },
  "MONA-CAP-069": {
    scope: "product",
    invocation: "Finder Service → com.mona.workbench open event",
    help_source: "docs/evidence/macos/P09-finder.md",
    entry: tab("finder", "Finder"),
    status: "verified",
    tests: "P09: 21/21 Service smoke with exact-folder delivery; 16/16 app handoff.",
    gap: null,
  },
  "MONA-CAP-070": {
    scope: "product",
    invocation: "mona-supervisor ownership record",
    help_source: "docs/decisions/ADR-003-runtime-supervisor.md",
    entry: tab("runtime", "Runtime"),
    status: "verified",
    tests:
      "P04: verified identity, one owner per user store, ALREADY_OWNED for a second workspace.",
    gap: "Parallel ownership needs an engine decision.",
  },
  "MONA-CAP-071": {
    scope: "product",
    invocation: "codewhale update",
    help_source: "codewhale update --help",
    integration: "advanced_action",
    entry: term(false),
    status: "unqualified",
    tests: "Not exercised: replaces the engine binary.",
    gap: "Mona never upgrades the engine silently. The pinned 0.10.2 build is a tested compatibility decision; an upgrade needs a new qualification pass.",
  },
  "MONA-CAP-072": {
    scope: "product",
    invocation: "Mach-O minimum, signature, and host inventory",
    help_source: "docs/discovery-macos.md",
    entry: screen("capabilities", "Capabilities · platform"),
    status: "verified",
    tests: "P00/P01: minimum macOS 11.0, arm64 thin binary, ad-hoc linker signature recorded.",
    gap: "Developer ID signing and notarization are P22.",
  },
  "MONA-CAP-073": {
    scope: "runtime_api",
    invocation: "GET /v1/agent-runs",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("agents", "Agents · runs"),
    status: "verified",
    tests: "P15: run ledger with real identities and per-identity spend.",
    gap: null,
  },
  "MONA-CAP-074": {
    scope: "runtime_api",
    invocation: "POST/DELETE /v1/threads/{id}/goal",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("agents", "Agents · goals"),
    status: "verified",
    tests: "P15: goal set/complete/block/clear; pause returns 404 and is not offered.",
    gap: null,
  },
  "MONA-CAP-075": {
    scope: "runtime_api",
    invocation: "GET /v1/fleet/runs/{id}/receipts",
    help_source: "docs/evidence/macos/artifacts/upstream-RUNTIME_API.md",
    entry: screen("agents", "Agents · receipt evidence"),
    status: "verified",
    tests: "P15: receipt evidence, replay, and partial receipts.",
    gap: "Fleet totals are not reported by the engine; Mona shows no aggregate cost.",
  },
};

const HELP_NAMES = (() => {
  const text = readFileSync(HELP, "utf8");
  const section = text.split("Commands:")[1]?.split("\nArguments:")[0] ?? "";
  const names = [];
  for (const line of section.split("\n")) {
    const match = /^ {2}([a-z][a-z0-9-]*)\s{2,}(.+)$/.exec(line);
    if (match) names.push({ name: match[1], summary: match[2].trim() });
  }
  return names;
})();

const inventory = JSON.parse(readFileSync(INVENTORY, "utf8"));
const byName = new Map(HELP_NAMES.map((entry) => [entry.name, entry.summary]));
const errors = [];

function apply() {
  const rows = inventory.capabilities.map((row) => {
    const overlay = P18[row.mona_id];
    if (!overlay) {
      errors.push(`no P18 reconciliation for ${row.mona_id} (${row.upstream_name})`);
      return row;
    }
    const isCli = overlay.scope === "cli";
    const description = isCli
      ? (byName.get(row.upstream_name) ?? row.upstream_name)
      : (overlay.description ?? row.upstream_name);
    if (isCli && !byName.has(row.upstream_name)) {
      errors.push(`help no longer lists the command for ${row.mona_id}: ${row.upstream_name}`);
    }
    const integration = overlay.integration ?? row.integration;
    if (
      overlay.entry.kind === "none" &&
      integration !== "blocked_gap" &&
      integration !== "unavailable"
    ) {
      errors.push(`${row.mona_id}: no entry point but integration is ${integration}`);
    }
    if (overlay.entry.kind === "none" && overlay.status === "verified") {
      errors.push(`${row.mona_id}: verified with no entry point`);
    }
    if (overlay.status === "verified" && overlay.entry.tested !== true) {
      errors.push(`${row.mona_id}: verified but its entry point was never exercised`);
    }
    if (overlay.status === "verified" && /^not exercised/i.test(overlay.tests ?? "")) {
      errors.push(`${row.mona_id}: verified but its test note says it was not exercised`);
    }
    // A described probe is only a claim while a run backs it: an
    // integrated-terminal row marked verified must be executed by the smoke.
    if (
      overlay.status === "verified" &&
      integration === "integrated_terminal" &&
      !/smoke:capability/.test(overlay.tests ?? "")
    ) {
      errors.push(
        `${row.mona_id}: verified terminal row has no recorded execution (name the smoke it runs in)`,
      );
    }
    return {
      mona_id: row.mona_id,
      upstream_name: row.upstream_name,
      upstream_source: row.upstream_source,
      upstream_version: row.upstream_version,
      platform: row.platform,
      classification: row.classification,
      permission_implications: row.permission_implications,
      cost_implications: row.cost_implications,
      required_arguments: row.required_arguments,
      integration,
      entry_point: {
        kind: overlay.entry.kind,
        target: overlay.entry.target,
        label: overlay.entry.label,
        tested: overlay.entry.tested === true,
      },
      ui_location: overlay.entry.label,
      tests: overlay.tests ?? row.tests,
      status: overlay.status ?? row.status,
      gap: overlay.gap === undefined ? row.gap : overlay.gap,
      description,
      scope: overlay.scope ?? "cli",
      invocation: overlay.invocation ?? `codewhale ${row.upstream_name}`,
      help_source: overlay.help_source ?? `codewhale ${row.upstream_name} --help`,
      ...(overlay.evidence
        ? { evidence: overlay.evidence }
        : row.evidence
          ? { evidence: row.evidence }
          : {}),
    };
  });

  rows.sort((a, b) => a.mona_id.localeCompare(b.mona_id));

  const count = (predicate) => rows.filter(predicate).length;
  const byIntegration = {};
  for (const row of rows)
    byIntegration[row.integration] = (byIntegration[row.integration] ?? 0) + 1;
  const gaps = rows
    .filter(
      (row) =>
        row.status === "unqualified" ||
        row.status === "blocked_gap" ||
        row.status === "unavailable",
    )
    .map((row) => ({
      mona_id: row.mona_id,
      upstream_name: row.upstream_name,
      status: row.status,
      reason: row.gap ?? "no reason recorded",
    }));

  const coverage = {
    rows_total: rows.length,
    verified: count((row) => row.status === "verified"),
    unqualified: count((row) => row.status === "unqualified"),
    unavailable: count((row) => row.status === "unavailable"),
    blocked_gaps: count((row) => row.status === "blocked_gap"),
    with_entry_point: count((row) => row.entry_point.kind !== "none"),
    tested_entry_point: count((row) => row.entry_point.tested),
    by_integration: byIntegration,
    by_entry_kind: rows.reduce((acc, row) => {
      acc[row.entry_point.kind] = (acc[row.entry_point.kind] ?? 0) + 1;
      return acc;
    }, {}),
    complete: count((row) => row.status !== "verified") === 0,
    gaps,
    summary:
      `${rows.length} discovered rows: ${count((row) => row.status === "verified")} verified, ` +
      `${count((row) => row.status === "unqualified")} open (entry point named and tested where marked), ` +
      `${count((row) => row.status === "blocked_gap")} blocked gaps, ` +
      `${count((row) => row.status === "unavailable")} unavailable. ` +
      `Every row carries an entry point or an explicit no-route state; ${count((row) => row.entry_point.kind === "none")} rows have no in-app route. ` +
      "Full parity is not claimed while any row is open or blocked.",
    assessed_utc: new Date().toISOString(),
  };

  if (inventory.capabilities.length !== rows.length) {
    errors.push("row count changed during reconciliation");
  }

  return {
    ...inventory,
    note:
      "Generated by tools/p01-spike/build-inventory.mjs from the pinned Codewhale 0.10.2 surface. " +
      "P18 reconciled every row through tools/p18-coverage/reconcile.mjs: description, scope, exact invocation, help source, " +
      "an explicit entry point (kind/target/label/tested), current status, and a named gap where no faithful route exists. " +
      "Coverage is computed from the rows, never asserted: a feature Mona cannot reach stays visible and blocks parity. " +
      "P13 added change receipts, Git review, and one-file native restore; P15 qualified orchestration; P17 qualified extensions; " +
      "P18 added the integrated terminal, command palette, and capability explorer, and recorded checked-in workflows and lane " +
      "management as blocked gaps because 0.10.2 exposes no /v1 route for them.",
    capabilities: rows,
    coverage,
  };
}

const next = apply();
const coverageOutput = { coverage: next.coverage, drift: { help_commands: HELP_NAMES.length } };

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(coverageOutput, null, 2));
}
if (process.argv.includes("--write")) {
  writeFileSync(INVENTORY, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.error(`wrote ${INVENTORY.replace(ROOT + "/", "")}`);
} else if (!process.argv.includes("--json")) {
  // The assessment timestamp moves on every run, so compare everything else.
  const current = JSON.parse(readFileSync(INVENTORY, "utf8"));
  const normalize = (value) => {
    const clone = JSON.parse(JSON.stringify(value));
    if (clone.coverage) clone.coverage.assessed_utc = "normalized";
    return JSON.stringify(clone);
  };
  if (normalize(current) !== normalize(next)) {
    errors.push("inventory differs from the reconciled form; run with --write");
  }
  console.log(
    JSON.stringify(
      {
        ok: errors.length === 0,
        errors,
        ...coverageOutput,
      },
      null,
      2,
    ),
  );
} else if (errors.length > 0) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2));
}
process.exit(errors.length === 0 ? 0 : 1);
