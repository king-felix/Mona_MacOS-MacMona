# P19 — Project memory, portable handoff, and diagnostics

**Status:** complete · **Date:** 2026-11-12 · **Prompt:** P19 · **Requirements:**
MONA-024, MONA-025 · **Decision record:** `docs/decisions/ADR-013-memory-and-handoff.md`,
D-054…D-059

## What this prompt had to prove

Make a project understandable across sessions and machines without a cloud
service: local deterministic search over explicitly indexed records, a prompt
shelf with variables and inert import, an explicit context-selection preview and
a concise resume packet, a portable handoff with redaction and digest checks,
settings backup/restore, and a diagnostics preview. No repository copy, no
embeddings, and no claim to show the exact provider request.

## What shipped

- **`src/shared/contracts/memory.ts`** — every view and request type, with the
  limits expressed as types: `persisted: false`, `exactProviderRequest: false`,
  `engineInspection: "unavailable"`, `startedWork: false`, `inert: true`.
- **`src/main/state/safe-archive.ts`** — a store-only ZIP writer with sorted
  names and fixed timestamps (byte-identical exports), and a fail-closed reader
  that refuses absolute names, `..`, backslashes, control characters,
  duplicates, encryption, symlinks, device nodes, zip64, CRC mismatches, and
  anything over its caps. `safeJoin` is the only path function extraction may
  use, and `extractArchive` never overwrites.
- **`src/main/work/memory.ts`** — `ProjectMemory`: search over a fixed source
  list (tasks, decisions, evidence, attempts, problems, threads, artifact
  metadata, prompt text), a documented deterministic scorer, a digest over the
  indexed set, a bounded on-demand workspace search, the resume packet, and the
  context-slot/selection preview.
- **`src/main/work/shelf.ts`** — `PromptShelf`: one settings scope, append-only
  versions on real change, literal one-pass variable substitution,
  secret-shaped text refused on save and import and re-refused on export.
- **`src/main/work/handoff.ts`** — `ProjectHandoff`: the handoff bundle,
  in-memory import, settings backup/restore, and the diagnostics preview.
- **`src/main/state/store.ts`** — `listSettingsScopes` and `restoreSettings`,
  which holds the exclusive maintenance barrier, snapshots first, journals, and
  reads every scope back.
- **`src/renderer/shell/Memory.tsx`** — the Memory screen (Command-9): Search,
  Prompt shelf, Resume & context, Handoff & diagnostics.
- **`src/main/work/board.ts`** — `TaskPlan` now carries `status`; import reports
  it as deferred (closes carried-forward item 27).

## Verification

### Tests — 627 in 66 files

```
npx vitest run
 Test Files  66 passed (66)
      Tests  627 passed (627)
```

New files: `test/safe-archive.test.ts` (9), `test/memory-search.test.ts` (12),
`test/memory-shelf.test.ts` (14), `test/memory-handoff.test.ts` (9),
`test/memory-screen.test.tsx` (10), `test/settings-restore.test.ts` (5),
`test/board-plan-status.test.ts` (2).

### `npm run smoke:memory` — 90/90 on real stores

Runs against three real SQLite stores in isolated temporary directories, with
the engine binary replaced by a **tripwire**: a script named `codewhale`, first
on `PATH`, that appends to a marker file and exits 97 if anything executes it.
The smoke first proves the tripwire is what `discoverTools` resolves, so its
silence is meaningful rather than accidental.

Covered, with the observed values in `artifacts/p19-memory-smoke.json`:

- **Search** — 4 hits across 7 considered records (task, decision, attempt,
  evidence), identical on a second run; `stateRevision` unchanged before and
  after; 1 redaction; the fixture secret absent from the serialized result.
- **Index** — 8 sources reported with per-source counts and redactions, a stable
  digest, `credentialsIndexed: false`, `embeddings: false`,
  `repositoryContents: "on_demand"`, and the exclusion list.
- **Workspace search** — finds `src/resume.ts`, skips `node_modules`, skips a
  symlink pointing outside the root, skips a binary `.ts` file and an
  unsupported extension, reports its scope verbatim, and leaves the state
  revision untouched.
- **Prompt shelf** — substitutes supplied variables, reports a missing one,
  keeps the unfilled `{{token}}` visible, appends a version only on a real
  change, and refuses a secret with `INVALID_INPUT`.
- **Handoff** — 6 entries (`manifest.json`, `project.json`, `pointers.json`,
  `decisions.md`, `README.md`, `prompts.json`) at mode `0600`; each entry hashes
  to the digest its manifest declares; no fixture secret and no home path in any
  entry; the missing evidence pointer is named; requalification reports the
  recorded engine identity with its source and capture time; a tampered entry
  and an escaping `../` entry are both refused; nothing is written outside the
  temp root; import into a clean store creates 2 tasks with no active turn and
  `startedWork: false`.
- **Settings** — a credential-named scope and a secret-shaped project scope are
  both excluded by name, and neither value appears in the written document; a
  `replace` without confirmation is refused; a stale revision is refused
  *inside* the filter and changes nothing; the restore applies 3 scopes, writes
  a journal and a snapshot, releases the barrier, and the restored values read
  back identically.
- **Diagnostics** — parses as JSON, 1,285 bytes, 1 redaction, digest equal to
  sha256 of its own text, no home path, no fixture secret, `environmentIncluded:
  false`, `credentialsIncluded: false`, and 7 named exclusions.
- **Zero inference** — the tripwire was never invoked; no P19 module references
  a network API, the engine adapter, or `child_process`.

### Electron shell smoke — 120/120, 24 screenshots

`node scripts/shell-smoke.mjs` runs the real app: Command-9 reaches Memory; the
index card renders all eight sources with the three literal disclaimers; a
typed search returns the seeded decision and prompt with the secret rendered as
`sk-[redacted]` and a stated redaction count; the resume packet names the
project and states the engine limit; the context tab loads 7 slots, toggles one,
and previews with a stated byte count and the provider-request note; the shelf
lists the seeded prompt, previews it, and keeps the unfilled variable visible;
the handoff tab renders real counts, entries with kinds and sizes, and 3
redactions. Captures: `p19-memory-search.png`, `p19-memory-handoff.png`.

### Local CI — 18/18 steps

`npm run ci` → `artifacts/p19-ci.txt`: format, lint, typecheck, three native
builds, 627 tests, the renderer bundle and secret scan, and every smoke
including the new `smoke:memory`.

### Redaction fixtures

Secrets in tests and smokes are always built at runtime
(`"sk-" + "a".repeat(24)`), never a literal key-shaped string. `monabuild
secrets` reports 10 findings, all pre-existing (P16/P18 captured artifacts and
two known false positives); no P19 file is among them.

## Review — what the independent review found, and what changed

An independent reviewer audited the change against false claims, redaction
bypasses, archive safety, the barrier, and the IPC surface. It returned **1
major, 13 minor**. Every finding was verified, and the real ones are fixed with
a test or a smoke check. Nothing is documented as "accepted risk".

**Major — a false "no engine call" claim.** The P19 surface spawned
`codewhale --version` synchronously on the main thread to report engine identity,
while the contract, an IPC comment, and the diagnostics note all said it never
reached the engine. Fixed by removing the exec entirely: presence is now a PATH
stat, and version/commit come from the last **stored capability snapshot**, with
its capture time reported. `RequalificationView` now carries `source:
"capability_snapshot" | "none"` and `localEngine.observedAt`, so "requalified"
can never be read as "a probe just ran". A machine with no recorded snapshot
reports `unavailable` and says to run the capability explorer. The tripwire in
`smoke:memory` now proves itself.

**Minor, fixed:**

1. `truncated` in the context preview was reported but never applied — a
   >100 KB preview said it was cut while shipping everything. Blocks are now
   fitted to the budget before the text and the slot byte counts are derived, so
   the "slot bytes sum to the total" invariant holds under truncation. Found and
   fixed a real bug in the new guard: the truncation marker was sized in
   characters while the budget is in bytes (`…` is 1 UTF-16 unit, 3 UTF-8
   bytes).
2. The shelf's save hint promised secret-shaped text would be *redacted*; save
   actually *refuses* it. The hint now says so.
3. The replace-restore confirmation said every absent scope is reset; it now
   names the preserved credential scopes and the prompt shelf.
4. `restoreSettings` accepted `expectedRevision` and ignored it. It is now
   enforced **inside** the exclusive barrier, where the guarantee actually
   holds; a caller-side check races a writer.
5. The restore failure message claimed the journal held the previous values. It
   holds the attempt; the snapshot holds the values. Corrected.
6. The settings-backup note claimed credentials "are never read". They are read
   to be excluded; the claim is now about what leaves the machine.
7. The shelf projection redacted `description` and `acceptance` but not `body`,
   `label`, or older version bodies — reachable through a settings restore. All
   strings are now projected through the redactor, and `redacted` is computed
   instead of hard-coded `false`.
8. A shelf save that changed only `description`, `tags`, or `note` returned the
   stored prompt unchanged, silently dropping the edit. Every editable field now
   counts, and tags are compared order-insensitively.
9. Two smoke checks could not fail: `redactions >= 0` (now `> 0`, guaranteed by
   the fixture) and a "no engine was invoked" check whose engine lookup did not
   resolve to the tripwire (now asserted explicitly).

**Minor, recorded as limits rather than fixed:** `extractArchive` is currently
unused and would follow a symlinked parent directory if a future caller used it;
because import parses in memory, it is not reachable from P19. It is named in
"Not verified / limits" below rather than left implicit.

## What portable handoff intentionally cannot transfer

Stated in the bundle's `manifest.json`, its `README.md`, and the
`cannotTransfer` view field:

- engine conversation history and sessions — the engine owns them on this
  machine, and a session on another machine is simply inaccessible;
- runtime bindings, ports, and executable paths — machine-local by definition;
- provider credentials and the environment — the receiving machine
  authenticates for itself;
- artifact **bytes** — only metadata and digests travel, so import reports which
  artifacts are missing locally;
- source files — the bundle carries pointers, never a copy of the repository;
- machine-local prompt favorites and rate cards.

## Requirements

- **MONA-024 satisfied.** Local search (12 tests, 4 hits across 4 sources in the
  smoke), context-selection preview (7 slots, explicit exclusions, literal
  `exactProviderRequest: false`), prompt library with variables, acceptance
  checklists, preview, versioning and inert import/export (14 tests), and a
  concise resume packet — all with zero inference.
- **MONA-025 advanced from `partial` to satisfied for the P19 scope.** Settings
  backup/restore under the maintenance barrier (5 store tests + smoke), portable
  project handoff with SHA-256 digests and requalified bindings (9 tests), a
  redacted diagnostics bundle with an explicit preview, and offline browsing of
  the same records. P20 owns failure injection, P23 the final matrix.
- **Carried-forward item 27 closed:** plan export carries task status, and
  import reports a non-pending status as deferred instead of applying it.
- **Carried-forward item 16 revisited:** the attempt ledger *is* in the portable
  project bundle (`project.json`), so it travels; it is not in the settings
  backup, which is scopes only.

## Not verified / limits

- **No provider-request inspection.** 0.10.2 exposes no route that shows the
  assembled request. The preview is Mona's composition, and every type and
  screen says so. This is not a gap Mona can close from its side.
- **Engine identity is only as fresh as the last capability snapshot.** Without
  one, requalification reports `unavailable` and names the next step. The P19
  surface deliberately starts no process to refresh it.
- **`extractArchive` is not exercised by P19.** Import parses in memory. The
  reader refuses unsafe names and `safeJoin` re-validates every path, but a
  symlinked *parent* directory inside an extraction root is not currently
  rejected; a future caller that extracts must resolve real paths first
  (P20's hostile-input pass is the right place).
- **Search is a substring match, not a query language.** No fuzzy matching, no
  ranking by recency, no per-field weights. Deterministic and inspectable was
  the goal; a richer scorer would need its own evidence.
- **Workspace search caps are unit-tested at their skip paths, not at the
  2,000-file boundary.** The boundary is enforced in code and reported, but no
  fixture reaches it.
- **The resume packet's 8,000-character cap** is implemented and its truncation
  branch is covered indirectly (the same clipping helper is tested through the
  context guard), not by a fixture that produces an 8,000-character packet.
- **A handoff preview and a later export are not byte-identical**: the store
  stamps `exported_at`, and the README embeds it. The durable guarantee is
  self-consistency, which the test asserts by recomputing the manifest digest.
- **Notification banner in the P19 captures.** The headless smoke host refuses
  notifications (P14, item 43), so the shell shows "Notification was not
  delivered". It is the host's real state, not a P19 regression.

## Artifacts

- `docs/evidence/macos/artifacts/p19-memory-smoke.json` — 90 checks, with the
  observed search, index, workspace, shelf, handoff, settings, and diagnostics
  values.
- `docs/evidence/macos/artifacts/p19-ci.txt` — the full local CI log.
- `docs/evidence/macos/artifacts/p19-memory-search.png`,
  `p19-memory-handoff.png` — the real screen in both themes' default capture.
