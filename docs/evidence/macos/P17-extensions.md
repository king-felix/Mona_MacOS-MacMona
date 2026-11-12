# P17 — Tools and extensions: MCP, skills, plugins, hooks, instructions

Status: **completed** · Date: 2026-11-12 · Requirement: MONA-021

## What was built

- `src/shared/contracts/extensions.ts` — scope, provenance, health, action
  (with availability, reason, side effect, destructive flag, revision need),
  MCP/skill/plugin/hook/instruction/command views, capabilities, and stated
  gaps.
- `src/main/engine/wire.ts` + `adapter.ts` — typed reads and mutations over the
  pinned runtime:
  - `GET/POST /v1/apps/mcp/servers`, `If-Match`-guarded
    `POST /{name}/{enable,disable,reconnect}` and `DELETE /{name}`,
    `GET /v1/apps/mcp/tools?server=`;
  - `GET /v1/skills`, `GET /v1/skills/{name}`, `POST /v1/skills/{name}`;
  - `GET /v1/apps/plugins`, `POST /v1/apps/plugins/install`,
    `POST /v1/apps/plugins/{selector}/{enable,disable,trust,revoke}`,
    `DELETE /v1/apps/plugins/{selector}`;
  - `GET /v1/hooks`, `GET /v1/workspace/instructions`,
    `GET`/`POST /v1/workspace/trust`, `GET /v1/commands`.
- `src/main/work/extensions.ts` — `ExtensionWorkbench`:
  - deterministic snapshot with per-section live-or-stored fallback;
  - home-path, command, URL-authority, diagnostics, and problem redaction;
  - MCP revision preconditions and an absolute-executable rule for adds;
  - on-demand tool listing (never in a snapshot);
  - action gating with an explicit reason and side effect;
  - workspace trust, skill toggles, plugin install/enable/disable/remove;
  - known-gap rows for plugin trust, project MCP edits, hook edits, tool-level
    discovery, and command editing.
- `src/renderer/shell/ExtensionsSettings.tsx` — Settings → **Extensions** with
  MCP, Skills, Plugins, Hooks, Instructions, and Commands tabs, health and tool
  details, install forms, trust state, and known limits.
- IPC: `extensions:snapshot`, `extensions:mcp-tools`, `extensions:mcp-add`,
  `extensions:action`, `extensions:install` — strict objects, bounded target
  identifiers.
- Fixtures: `test/fixtures/mcp/echo-server.mjs` (minimal stdio MCP server),
  `test/fixtures/plugin/` (local bundle with one inert skill).

## Acceptance evidence

| Acceptance | Evidence |
|---|---|
| Configure a harmless local test server | live smoke adds `mona-fixture` with the absolute Node path and the fixture script |
| Observe health | `mcp.reconnect` returns `reconnected`; the fixture handshake succeeds and `tools/list` returns one `echo` tool |
| Disable it and verify the intended scope only | disable flips that row to `enabled: false`; the project entry stays enabled; the project `mcp.json` is byte-identical |
| Stale configuration edits conflict | a second add with the previous revision is refused by the engine's `If-Match` (412) and surfaces its message |
| Missing executable/failed handshake is actionable | `missing-fixture` with `/nonexistent/mona-fixture` reports `MCP stdio spawn failed … No such file or directory` |
| Secret-bearing configuration is redacted | a preseeded server with `env: { MONA_FIXTURE_TOKEN: <fixture secret> }` appears by name only; the entire snapshot and report contain no secret value; env/header names only |
| Remove preserves unrelated settings | after removing both fixtures, `mcp.json` still contains the unrelated server, the secret-bearing server, and the unknown `mona_unknown_key` table |
| No model-context load on page open | snapshots read `/v1/apps/mcp/servers` (metadata) only; `/v1/apps/mcp/tools` is a separate on-demand call |
| Extensions cannot reach the desktop bridge | no extension surface is exposed to the renderer; hooks are read-only and never executed |

## Verification

- Unit tests `test/extensions-workbench.test.ts`: **10/10** covering redaction,
  absolute commands, stale revisions, failed handshakes, skill scope, plugin
  review gating, hook problems, workspace trust, offline cache, and install.
- Full suite: **495 tests in 52 files**; local CI green including
  `smoke:extensions`: `docs/evidence/macos/artifacts/p16-p17-ci.txt`.
- Live smoke `npm run smoke:extensions`: **39/39 checks**, isolated
  `HOME`/`CODEWHALE_HOME`:
  `docs/evidence/macos/artifacts/p17-extensions-smoke.json`.
  - project MCP entry appears only after workspace trust and is read-only;
  - local test server added, handshake succeeded, `echo` tool listed;
  - stale revision refused; disable affects only that row;
  - missing executable is actionable;
  - remove preserves unrelated, secret-bearing, and unknown configuration;
  - skill disabled and re-enabled in engine state;
  - local plugin installed disabled/untrusted, inventory visible, enable
    refused before review, removed cleanly;
  - host-bound commands are labeled; gaps are present.
- Shell smoke: **101/101 checks** including `settings_extensions_categories`;
  `docs/evidence/macos/artifacts/p17-settings-extensions.png` captures the
  disconnected state with all six categories and the known-limits section.

## Known limits (recorded, not hidden)

1. **Plugin trust is a terminal action.** The HTTP plugin detail returns
   `review.token` as `[redacted]`, so a desktop client cannot complete
   capability review. Mona shows trust state and points at `/plugins trust`.
2. **Project-scope MCP is read-only through the runtime.** Edits belong in the
   project `mcp.json`; Mona shows origin and refuses to rewrite user files.
3. **Skill install requires a remote source and network approval.** A local
   directory is discovered, not installed. The plugin installer does accept a
   local bundle.
4. **Hooks are read-only.** Editing follows engine configuration semantics;
   project hooks also need separate digest approval.
5. **No tool-level discovery budget** is exposed. Server enable/disable and the
   configured tool lists are the available boundary; no token-savings
   percentage is claimed.
6. **User commands have no desktop editing route.** They are listed with their
   `host`/`prompt` binding.
7. **Health is per handshake.** A `connected` value from the list is shown as
   connected; anything else is `not_checked` until the user requests a
   handshake.
