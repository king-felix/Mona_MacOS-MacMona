# ADR-013 — Project memory, portable handoff, and what a bundle may carry

**Status:** accepted · **Date:** 2026-11-12 · **Prompt:** P19

## Context

P19 has to make a project understandable across sessions and machines without a
cloud service, and without pretending Mona can inspect the engine's side of the
conversation. Four facts constrain the design.

1. **Engine history is authoritative elsewhere.** Codewhale owns threads, turns,
   and transcripts. Mona stores ids and projections (ADR-004). A portable
   bundle can carry Mona's records, but it can never carry a session that lives
   in another machine's engine store.
2. **A repository is not memory.** Indexing file contents into SQLite would
   duplicate the user's source, grow without bound, and stale instantly. The
   prompt is explicit: repository contents are searched on demand or under a
   documented scope, never copied wholesale into a new DB.
3. **The provider request is assembled by the engine.** 0.10.2 exposes no
   request-inspection route. A "preview the exact prompt" claim would therefore
   be a lie in every case where the engine adds a system prompt, tool schema, or
   history projection.
4. **Redaction that runs after persistence is not redaction.** A secret that
   reaches the store, a bundle, or a diagnostics file has already leaked. The
   check has to be on the way in, and the export has to refuse rather than
   rewrite where it can.

## Decision

### 1. Search is a read over stored records, with a fixed source list

`ProjectMemory` reads tasks, decisions, requirement evidence, attempts,
problems, threads, artifact **metadata**, and prompt-shelf text. It never reads
the `settings` table, engine transcripts, environment variables, artifact bytes,
or file contents. Ranking is a documented, inspectable term score; there are no
embeddings and no model call. `indexStatus` states the exclusions, the digest,
and the state revision, so two runs can be compared without trusting prose.

Workspace search is a separate, explicitly bounded call: an extension allowlist,
a directory skip list, symlinks refused, `realpath` containment against the
project root, and hard caps (2,000 files / 8 MiB / 200 hits / 400 chars per
line). It writes nothing and says so in every result.

### 2. Context selection is Mona's composition, never "the provider request"

`contextSelection` renders exactly the text Mona would hand the engine for one
explicit slot set. The type carries `exactProviderRequest: false` as a literal,
and both the API and the screen state the limit. Slots are opt-in: acceptance,
requirements, decisions, evidence pointers, prior attempts, and a resume packet
are added only when the user selects them.

### 3. The prompt shelf refuses secrets instead of storing them

Shelf text is screened with `scanForSecrets` on save, on import, and again on
export (so a prompt that predates screening cannot leak). A finding refuses the
save with the _class_ named, never the value. Variables are `{{name}}` with a
lowercase grammar; substitution is one pass, literal, and never rescanned.
Versions are append-only on real content change, capped at 20 with version 1
retained. Imported packs are stored text: importing runs nothing and inserts
nothing.

### 4. A handoff bundle is Mona's records, digests, and pointers — in a zip that cannot escape

`ProjectHandoff` writes a deterministic store-only zip through
`safe-archive.ts`: sorted names, fixed timestamps, `0600`, no overwrite. Entries
are `manifest.json`, `project.json` (the existing `ProjectBundle`), `pointers.json`,
`decisions.md`, `README.md`, and an optional `prompts.json`. The manifest digest
covers every entry except itself, and inspection recomputes it.

Import **never extracts to disk**. The archive is parsed in memory, every entry
is verified against the manifest, and the parsed `project.json` object is passed
straight to `store.importProject`. That removes the path-traversal class of bug
from the import path entirely: there is no extraction root to escape. The reader
still refuses absolute names, `..` segments, backslashes, control characters,
duplicates, encryption, symlinks, zip64, and entries over its caps — because a
future feature may extract, and the reader must not depend on having written the
file.

An imported machine binding is requalified: sessions are not portable, runtime
bindings and absolute paths are machine-local, and the local engine identity is
read once (a bounded `--version`) and reported. Missing local files and stale
digests are named, never silently repaired. Import starts no work.

### 5. Settings restore is a barrier operation, not a loop of writes

`StateStore.restoreSettings` holds the exclusive maintenance barrier for the
whole restore, writes a pre-restore snapshot and a durable journal first, mutates
in one transaction, and reads every scope back before marking the journal
complete. It cannot call `putSettings`: the barrier is not re-entrant, and a
nested `write` would queue behind the exclusive run forever. Credential-bearing
scopes and the prompt shelf are preserved by a `replace` restore; a `replace`
requires explicit confirmation.

### 6. Diagnostics are a preview first

`diagnosticsPreview` builds a JSON document from local facts only — counts,
revisions, integrity, scope names and versions, retention — and returns the exact
redacted text with its digest and a real redaction count. Settings _values_,
environment, credentials, artifact bytes, repository contents, and transcripts
are excluded by construction and named in the document. Export writes the
previewed bytes, so what the user reviewed is what is written.

## Consequences

- **Portable handoff intentionally cannot transfer:** engine conversation
  history and sessions; runtime bindings, ports, and executable paths; provider
  credentials and the environment; artifact bytes; source files; machine-local
  prompt favorites and rate cards. On the receiving machine an engine session is
  simply inaccessible, and the bundle says so in `README.md` and `cannotTransfer`.
- Search and every export require zero inference. `smoke:memory` runs with a
  tripwire engine binary and fails if anything invokes it.
- `settings_backup` covers the `settings` table only. It is not a configuration
  backup for `config.toml`; P16's switch backup remains the route for engine
  config, and a config backup can still hold a literal key (D-074).
- A handoff preview and a later export are not byte-identical, because the
  store stamps `exported_at` and the README embeds `created_at`. The durable
  guarantee is self-consistency: each entry hashes to the digest the manifest
  declares, and the manifest digest reproduces from those entries.
