# Mona capability coverage

Generated 2026-11-16T02:16:11.729Z from ~/DS_Projects/Mona/docs/codewhale-capabilities-macos.json.

## Coverage

- Rows: 75
- Verified: 43
- Open (entry point named, operation not exercised): 28
- Blocked gaps: 2
- Unavailable on this build: 2
- Entry points exercised: 51
- Complete: no — Full parity is not claimed while rows remain open

## Drift

- Checked: 2026-11-16T02:16:11.729Z
- Installed: 0.10.2 (ff466b2ed0bf)
- Recorded: 0.10.2 (ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e)
- Additions: 0
- Removals: 0

## Rows

| id | capability | integration | entry | status |
| --- | --- | --- | --- | --- |
| MONA-CAP-001 | run | integrated_terminal | terminal:shell | unqualified |
| MONA-CAP-002 | doctor | native_view | settings_tab:route | verified |
| MONA-CAP-003 | session-diagnostics | integrated_terminal | terminal:shell | unqualified |
| MONA-CAP-004 | scorecard | integrated_terminal | terminal:shell | unqualified |
| MONA-CAP-005 | models | native_view | settings_tab:route | verified |
| MONA-CAP-006 | speech | advanced_action | terminal:shell | unqualified |
| MONA-CAP-007 | sessions | native_view | screen:studio | verified |
| MONA-CAP-008 | receipts | native_view | screen:changes | verified |
| MONA-CAP-009 | resume | native_view | screen:studio | verified |
| MONA-CAP-010 | rc | integrated_terminal | terminal:shell | unqualified |
| MONA-CAP-011 | fork | integrated_terminal | terminal:shell | unqualified |
| MONA-CAP-012 | init | advanced_action | terminal:shell | unqualified |
| MONA-CAP-013 | install | native_view | settings_tab:extensions | verified |
| MONA-CAP-014 | setup | advanced_action | terminal:shell | unqualified |
| MONA-CAP-015 | remote-setup | advanced_action | terminal:shell | unavailable |
| MONA-CAP-016 | exec | native_view | screen:studio | verified |
| MONA-CAP-017 | fleet | native_view | screen:agents | verified |
| MONA-CAP-018 | workflow | blocked_gap | none | blocked_gap |
| MONA-CAP-019 | lane | blocked_gap | none | blocked_gap |
| MONA-CAP-020 | review | advanced_action | terminal:shell | unqualified |
| MONA-CAP-021 | apply | advanced_action | terminal:shell | unqualified |
| MONA-CAP-022 | eval | integrated_terminal | terminal:shell | unqualified |
| MONA-CAP-023 | mcp | native_view | settings_tab:extensions | verified |
| MONA-CAP-024 | features | native_view | screen:capabilities | verified |
| MONA-CAP-025 | integrations | advanced_action | terminal:shell | unqualified |
| MONA-CAP-026 | serve | native_view | settings_tab:runtime | verified |
| MONA-CAP-027 | web | integrated_terminal | terminal:shell | unqualified |
| MONA-CAP-028 | login | advanced_action | terminal:shell | unqualified |
| MONA-CAP-029 | logout | advanced_action | terminal:shell | unqualified |
| MONA-CAP-030 | auth | advanced_action | terminal:shell | unqualified |
| MONA-CAP-031 | account | advanced_action | terminal:shell | unqualified |
| MONA-CAP-032 | dispatch | unavailable | none | unavailable |
| MONA-CAP-033 | mcp-server | advanced_action | terminal:shell | unqualified |
| MONA-CAP-034 | config | native_view | settings_tab:route | verified |
| MONA-CAP-035 | model | native_view | settings_tab:route | verified |
| MONA-CAP-036 | thread | native_view | screen:studio | unqualified |
| MONA-CAP-037 | sandbox | integrated_terminal | terminal:shell | unqualified |
| MONA-CAP-038 | app-server | native_view | settings_tab:runtime | verified |
| MONA-CAP-039 | completion | integrated_terminal | terminal:shell | verified |
| MONA-CAP-040 | metrics | integrated_terminal | terminal:shell | verified |
| MONA-CAP-041 | update | advanced_action | terminal:shell | unqualified |
| MONA-CAP-042 | providers | native_view | settings_tab:route | verified |
| MONA-CAP-043 | help | integrated_terminal | terminal:shell | verified |
| MONA-CAP-044 | HTTP Runtime API /v1/* | native_view | settings_tab:runtime | verified |
| MONA-CAP-045 | Versioned adapter contract | native_view | settings_tab:runtime | verified |
| MONA-CAP-046 | SSE event journal /v1/threads/{id}/events | native_view | screen:studio | verified |
| MONA-CAP-047 | Thread/turn lifecycle | native_view | screen:studio | verified |
| MONA-CAP-048 | Turn interrupt | native_view | screen:studio | verified |
| MONA-CAP-049 | Resume from saved session | native_view | screen:studio | verified |
| MONA-CAP-050 | Usage aggregation and cost | native_view | screen:cost | verified |
| MONA-CAP-051 | Turn history and receipts | native_view | screen:changes | verified |
| MONA-CAP-052 | Approvals bridge | native_view | screen:studio | unqualified |
| MONA-CAP-053 | Permission posture (Full Access) | native_view | screen:settings | verified |
| MONA-CAP-054 | Tools: shell and file write | native_view | screen:changes | verified |
| MONA-CAP-055 | Tool: apply_patch | native_view | screen:changes | unqualified |
| MONA-CAP-056 | Web search | native_view | screen:studio | unqualified |
| MONA-CAP-057 | Subagents | native_view | screen:agents | verified |
| MONA-CAP-058 | MCP server management | native_view | settings_tab:extensions | verified |
| MONA-CAP-059 | Skills and plugins | native_view | settings_tab:extensions | verified |
| MONA-CAP-060 | Fleet and workflows | native_view | screen:agents | verified |
| MONA-CAP-061 | Terminal stream/input | integrated_terminal | terminal:shell | unqualified |
| MONA-CAP-062 | Workspace files, search, artifacts | native_view | screen:changes | unqualified |
| MONA-CAP-063 | Workspace snapshots/restore | native_view | screen:changes | unqualified |
| MONA-CAP-064 | Provider/model catalog and route visibility | native_view | settings_tab:route | verified |
| MONA-CAP-065 | Session persistence | native_view | screen:studio | verified |
| MONA-CAP-066 | Operation idempotency (operation_key) | native_view | screen:studio | verified |
| MONA-CAP-067 | Zero-inference non-turn actions | native_view | screen:home | verified |
| MONA-CAP-068 | Packaged native execution (no Node in PATH) | native_view | settings_tab:runtime | verified |
| MONA-CAP-069 | Finder selected-folder Service (NSServices) | native_view | settings_tab:finder | verified |
| MONA-CAP-070 | Single Runtime owner per user store | native_view | settings_tab:runtime | verified |
| MONA-CAP-071 | Engine update path | advanced_action | terminal:shell | unqualified |
| MONA-CAP-072 | macOS minimum and signature state | advanced_action | screen:capabilities | verified |
| MONA-CAP-073 | /v1/agent-runs | native_view | screen:agents | verified |
| MONA-CAP-074 | Thread goals | native_view | screen:agents | verified |
| MONA-CAP-075 | Fleet receipts and evidence | native_view | screen:agents | verified |

## Gaps

- **MONA-CAP-001 run** (unqualified): The TUI runs in the integrated terminal; Mona's own turns use /v1. Opening the TUI is a deliberate user command, not an automatic fallback.
- **MONA-CAP-003 session-diagnostics** (unqualified): Route is `codewhale sessions` then `codewhale session-diagnostics <jsonl>`. Neither Mona nor its smoke runs it, so no success is claimed.
- **MONA-CAP-004 scorecard** (unqualified): Needs a metrics file to score. No native scorecard panel, and no sample input is invented; the cost lens shows recorded usage, not this quality score.
- **MONA-CAP-006 speech** (unqualified): Paid TTS is outside 1.0 scope. The command is reachable in the terminal; Mona never calls it and never claims a configured route.
- **MONA-CAP-010 rc** (unqualified): Upstream browser handoff; Mona does not depend on it. Reachable only as an explicit terminal command.
- **MONA-CAP-011 fork** (unqualified): Thread forking has no native control. The terminal entry runs the CLI command, and a fork creates a new thread without workspace rollback.
- **MONA-CAP-012 init** (unqualified): Writes a workspace file. The capability row prefills the exact command and never runs it automatically.
- **MONA-CAP-014 setup** (unqualified): Writes configuration. Mona adds MCP servers through the engine's own route instead; `setup` is terminal-only.
- **MONA-CAP-015 remote-setup** (unavailable): Cloud hosting is outside 1.0 scope. No remote is invented and no bundle is generated automatically.
- **MONA-CAP-018 workflow** (blocked_gap): Checked-in JS workflows run through a Lane Runtime with no HTTP route, so Mona cannot launch or inspect them. A terminal entry would not fulfill MONA-019; full parity stays blocked until the engine exposes a route or Victor narrows scope.
- **MONA-CAP-019 lane** (blocked_gap): Lane management is terminal-only on this build. Mona shows no lane control and does not simulate one.
- **MONA-CAP-020 review** (unqualified): The billable model review is terminal-only; Mona's source review reads recorded turn artifacts and Git state instead, so no hidden model call happens.
- **MONA-CAP-021 apply** (unqualified): Destructive and terminal-only. Mona's restore path is the engine's checked one-file file-revert (P13); no patch apply control is offered.
- **MONA-CAP-022 eval** (unqualified): Terminal-only. Cost depends on the suite, so the row states that before invocation.
- **MONA-CAP-025 integrations** (unqualified): Third-party harness integration is terminal-only; Mona makes no claim about a configured harness.
- **MONA-CAP-027 web** (unqualified): The upstream browser client overlaps Mona. Reachable only as an explicit terminal command; Mona never opens it automatically.
- **MONA-CAP-028 login** (unqualified): Credentials never cross the renderer. Provider keys use the dedicated P16 route; account login is terminal-only and user-initiated.
- **MONA-CAP-029 logout** (unqualified): Destructive and terminal-only, with the engine's own confirmation. Mona does not offer a one-click credential wipe.
- **MONA-CAP-030 auth** (unqualified): Provider keys are set through the engine's own route (P16); other auth modes are terminal-only.
- **MONA-CAP-031 account** (unqualified): Local key routes remain primary; account status is terminal-only.
- **MONA-CAP-032 dispatch** (unavailable): Cloud computers are unavailable. No control is shown and no remote is invented.
- **MONA-CAP-033 mcp-server** (unqualified): Terminal-only. Mona is an MCP host, not a server; the row states the reverse direction.
- **MONA-CAP-036 thread** (unqualified): Resume and fork flows are terminal-only beyond the studio's recorded resume.
- **MONA-CAP-037 sandbox** (unqualified): The effective permission posture is shown from the turn receipt (P08), not recomputed here; `sandbox` is terminal-only.
- **MONA-CAP-041 update** (unqualified): Mona never silently upgrades the engine. An engine change is an explicit, separately tested compatibility decision and stays terminal-only here.
- **MONA-CAP-052 Approvals bridge** (unqualified): Verified: pending rows persist with the Runtime capability, both reply routes are wired (POST /v1/approvals/{id}, POST /v1/user-input/{thread}/{request}), and the engine's own thread-detail lists settle or expire them. Not verified: a live approval decision end to end, remembered grants (passed through, not listed), and clarifications on the tool-free compatibility transport.
- **MONA-CAP-055 Tool: apply_patch** (unqualified): apply_patch is displayed as a tool-attributed change when the agent uses it. Mona offers no direct patch control.
- **MONA-CAP-056 Web search** (unqualified): Web search is provider-native and may add provider charges. Mona makes no claim that a route has it enabled.
- **MONA-CAP-061 Terminal stream/input** (unqualified): Engine terminal sessions can only be attached, never created (404 otherwise), so a client cannot open its own shell through them. Mona owns its PTY instead; an attach view for engine-owned shells is not built.
- **MONA-CAP-062 Workspace files, search, artifacts** (unqualified): Project text search is P19. Mona never copies repository contents into its database to fake it.
- **MONA-CAP-063 Workspace snapshots/restore** (unqualified): Whole-workspace restore (POST /v1/snapshots/{id}/restore) and forking patch-undo are not surfaced. A workspace-wide overwrite stays a separate, explicitly authorized action.
- **MONA-CAP-071 Engine update path** (unqualified): Mona never upgrades the engine silently. The pinned 0.10.2 build is a tested compatibility decision; an upgrade needs a new qualification pass.

