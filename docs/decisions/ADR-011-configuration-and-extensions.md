# ADR-011 — Configuration is engine-owned, scope is explicit, and extension trust stays with the engine

**Status:** accepted · **Date:** 2026-11-12 · **Prompt:** P16–P17

## Context

Mona has to expose provider/model selection, effective routes, credentials,
reasoning controls, and the extension inventory without becoming a second
configuration authority or leaking secrets. The pinned runtime (0.10.2) exposes
a richer surface than the discovery notes covered:

- `GET /v1/providers`, `GET /v1/providers/{id}/models`, and
  `POST /v1/providers/{id}/switch` for the live catalog and an explicit switch.
- `GET /v1/config` (effective live config) and `POST /v1/config`
  (`{key, value, persist}`) for the runtime's own settings store.
- `PUT`/`DELETE /v1/providers/{id}/key` with `scope: "session" | "durable"`,
  plus `credentialState`, `credentialSource`, `credentialWritable`, and
  `credentialWritableReason` on the provider rows.
- `GET /v1/apps/mcp/servers` with an opaque revision, `If-Match`-guarded
  `POST`/`DELETE`, `/enable`, `/disable`, `/reconnect`, and `GET
/v1/apps/mcp/tools?server=`.
- `GET /v1/skills`, `GET /v1/skills/{name}`, `POST /v1/skills/{name}`
  (`{enabled}`), `/trust`, `/audit`, `/update`, `/install`.
- `GET /v1/apps/plugins`, `POST /v1/apps/plugins/install`, and the selector
  routes `/{id}`, `/{id}/enable`, `/disable`, `/trust`, `/revoke`, `/update`.
- `GET /v1/hooks`, `GET /v1/workspace/instructions`,
  `GET`/`POST /v1/workspace/trust`, and `GET /v1/commands`.

Five forces shaped the design:

1. **Two route layers.** The engine has a configured route
   (`config.toml`/switch), and each turn carries a requested route. Mona also
   has a saved new-thread default. Editing one must not silently rewrite the
   others.
2. **Requested is not effective.** A switch can be accepted and still not be
   what a turn reports. The receipt is the authority.
3. **Credential writers.** A provider's credential can be owned by the secret
   store, an account session, a literal config value, or external consent.
   Writing around the owner would be a security defect.
4. **Config is shared.** The document contains unknown user tables. Rewriting
   it from the UI would delete them; concurrent edits must be a refusal, not an
   overwrite.
5. **Extensions execute code.** A plugin can add MCP servers, skills, commands,
   and hooks. Its review token is redacted on the HTTP detail route, so a
   desktop client cannot complete capability trust — pretending otherwise would
   be a false security control.

## Decision

### The engine owns every value; Mona owns the presentation and the gate

- Provider and model catalogs are read through the adapter and validated with
  zod wire schemas. Unknown fields are preserved; unknown credential classes
  become `unknown`, never `configured`.
- **Saved default scope:** `engine:profile` in Mona's versioned settings,
  written with `putSettingsIfVersion` (compare-and-swap). A stale revision is a
  conflict. The route is validated **before** the write: provider must exist,
  the model must be in the live catalog, and a reasoning level must be one the
  exact model publishes. A failed check leaves the stored value untouched.
- **Active session scope:** the studio snapshots the profile at session start
  and sends `model_provider` / `model_provider_id` / `model` /
  `reasoning_effort` on each turn. Saving a new default therefore cannot alter a
  running turn; the observed route is read from the turn receipt.
- **Engine scope:** `POST /v1/providers/{id}/switch` is a separate, explicit,
  confirmed action. Mona reads the config document's SHA-256 first, refuses a
  stale hash, copies the document plus a manifest to the product backup
  directory, performs the switch, re-reads the live config, and reports
  `applied` only when the observed provider/model match. Unknown TOML tables are
  preserved by the engine's own writer.
- **Routing policy is fixed:** no auto-router, no fallback, one attempt on the
  configured route. A failed submission returns `accepted: false`; the adapter
  never switches provider or model in response. `usedFallback` from a receipt is
  surfaced as a warning, not hidden.

### Credentials pass through; secrets are never represented

- `setProviderCredential` first checks `credentialWritable`. A non-writable
  route is refused with the engine's reason (`account_session`, `config`,
  `external_auth`), never bypassed.
- The key crosses the narrow IPC channel only on the dedicated call, goes
  straight to `PUT /v1/providers/{id}/key`, and is dropped from renderer state.
  Receipts contain state/scope/backend only — never the key or its length.
- The runtime's structural credential projection is the only status shown.

### Diagnostics are redacted before they leave the machine

`codewhale doctor --json` and `codewhale config doctor` run read-only. The
report is bounded and passed through a redactor (home directory, `sk-` keys,
bearer tokens, `key=value` secrets, URL userinfo, private-key blocks) before it
is displayed or exported. The exported JSON records the redaction count. The
smoke asserts that neither the home path nor a fixture secret survives.

### Extension inventory is a projection; actions carry their scope and effect

- MCP rows carry origin (`global`/`project`), writable, enabled, credential and
  auth classes, env/header **key names**, and health only after a handshake.
  Project entries are read-only through the runtime and say so.
- Every mutation uses the engine's revision (`If-Match`); a stale revision is
  the engine's 412, surfaced as a refusal. Add/remove preserve unrelated servers
  and unknown top-level keys because Mona never rewrites `mcp.json`.
- Tool listing is on demand (`/v1/apps/mcp/tools?server=`), never part of a
  snapshot — opening the settings page does not load every tool description into
  model context. The pinned engine has no tool-level discovery budget, so the
  UI states `selectiveDiscovery: "server"` and makes no token-savings claim.
- Skills are listed with source/scope/enabled and toggled through the engine.
  Plugin bundles show their inventory, hashes, trust state, and diagnostics;
  install is disabled-and-untrusted by default. The HTTP review token is
  redacted, so **trust is a documented terminal action** (`/plugins trust`).
- Hooks are read from engine semantics and never executed by Mona. Instructions
  are shown with existence/bytes; project scope is gated by workspace trust.
  User commands are labeled `host` or `prompt`, so a host command is never
  offered as a model prompt.

## Consequences

- No renderer-settable policy field was added; every widening (route, posture,
  credential, extension activation) is a named IPC call with a stated scope.
- A saved default requires a live engine to validate. Offline, Mona shows the
  last catalog with its read time and refuses a save rather than persisting an
  unverified route.
- The engine's config document may be normalized by the engine on first route
  resolution. Mona therefore reads the revision after catalog reads in a
  snapshot and re-checks it before a write.
- Plugin trust, project-scope MCP editing, hook editing, and tool-level
  discovery are **known gaps with a verified route**, not hidden failures.
- The provider smoke uses isolated `HOME`/`CODEWHALE_HOME` and never starts a
  turn, so it cannot incur provider charges.
